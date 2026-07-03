// The webview panel that hosts the compile-capable session (`session.html`) and
// drives the L1 protocol. The compile counterpart to `viewerPanel.ts`.
//
// Unlike the read-only viewer, this boots the OpenSCAD WASM engine in the webview,
// so its CSP grants `wasm-unsafe-eval` + `worker-src blob:` (the worker runs from a
// same-origin blob URL — see openscad-web docs/EMBEDDING-VSCODE.md §6), and it uses
// `retainContextWhenHidden: true` so hiding the panel does not tear down and
// re-initialise the WASM engine.
//
// Boot + handshake (P2): load the artifact, wait for `ready`, assert its
// protocolVersion == the manifest pin. Compile (P3): push a walked project closure
// via `setProject` and settle on the terminal compile result. The session compiles
// and renders the geometry IN-PROCESS — geometry never crosses the wire; the host
// only observes the `OperationResult` push stream for a coarse compile outcome.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readSessionManifest, sessionDir } from './sessionArtifact';
import {
  stampSessionInbound,
  type ArtifactRef,
  type Diagnostic,
  type ProjectFile,
  type SessionArtifactReply,
  type SessionExportFormat,
  type SessionInbound,
  type SessionOutbound,
} from './sessionProtocol';

/** The result of booting the session webview — tolerant for headless CI. */
export interface BootOutcome {
  /** The session signalled `ready` (engine + FS initialised). */
  ready: boolean;
  /** protocolVersion the session reported on `ready` (-1 if never ready). */
  protocolVersion: number;
  /** protocolVersion pinned in the vendored artifact's manifest. */
  expectedProtocolVersion: number;
  /** Set if the session reported a protocol `error`, or boot timed out. */
  error?: string;
  /** The user closed the panel before any terminal outcome — not a failure. */
  closedByUser: boolean;
}

/** The result of compiling a project — the boot fields plus the compile terminal. */
export interface CompileOutcome {
  ready: boolean;
  protocolVersion: number;
  expectedProtocolVersion: number;
  /** A preview/render success carrying an OFF artifact arrived (geometry produced). */
  compiled: boolean;
  /** The winning OFF artifact handle (UX/logging; the bytes stay in-session). */
  artifact?: ArtifactRef;
  /** Compile/protocol error reason, or a timeout. */
  error?: string;
  /** Markers accumulated across the result stream (P4 maps these to vscode.Diagnostic). */
  diagnostics: Diagnostic[];
  /** The user closed the panel before any terminal outcome — not a failure. */
  closedByUser: boolean;
  /** A newer compile superseded this one before it settled — not a failure. */
  superseded: boolean;
}

const BOOT_TIMEOUT_MS = 60_000; // cold WASM + FS init is slower than the L0 viewer.
const COMPILE_TIMEOUT_MS = 60_000; // a single compile (syntaxCheck + preview) backstop.
const EXPORT_TIMEOUT_MS = 120_000; // format conversion re-renders in the worker.
const ARTIFACT_FETCH_TIMEOUT_MS = 15_000; // bytes round-trip after the export result.

/** The result of a wire export (P6): the artifact identity + its exact bytes. */
export interface ExportOutcome {
  ok: boolean;
  artifact?: ArtifactRef;
  bytes?: Uint8Array;
  error?: string;
  /** A newer export superseded this one — a normal re-trigger, not a failure. */
  superseded?: boolean;
}

interface BootWaiter {
  resolve: (o: BootOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ExportWaiter {
  resolve: (o: ExportOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The requested format — a belt against cross-export result routing: the
   *  wire has no export↔result correlation id (upstream follow-up), so a stale
   *  export's terminal must at least not settle a different-format waiter. */
  format: SessionExportFormat;
}

interface CompileWaiter {
  resolve: (o: CompileOutcome) => void;
  /** Mutated as results stream in (diagnostics accumulate; set on the terminal). */
  outcome: CompileOutcome;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** Ignore results below this `sourceRevision` — they belong to a superseded
   *  push (see the correlation note in `onMessage`). Reset on webview reload. */
  minRevision: number;
  /** Highest `sourceRevision` this waiter has accepted results from (-1 = none);
   *  diagnostics reset when a fresher revision starts streaming. */
  acceptedRevision: number;
}

export class SessionPanel {
  private static current: SessionPanel | undefined;
  private static readonly disposedEmitter = new vscode.EventEmitter<void>();
  /** Fires when the session panel is disposed (user close or failed-boot
   *  teardown) — lets the owner clear diagnostics / deactivate triggers. */
  static readonly onDidDispose = SessionPanel.disposedEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  /** `ready` received AND version matched — safe to drive the session. */
  private live = false;
  /** Cached terminal boot outcome, set once `ready`/`error`/timeout settles. */
  private bootOutcome?: BootOutcome;
  private bootWaiters: BootWaiter[] = [];
  /** The project to (re)push on every `ready` — re-driven after a webview reload. */
  private currentProject?: { files: ProjectFile[]; entryPoint?: string };
  /** The in-flight compile awaiting its terminal result, if any. */
  private compileWaiter?: CompileWaiter;
  /** The in-flight export awaiting its terminal result + bytes, if any. */
  private exportWaiter?: ExportWaiter;
  /** Pending getArtifact replies, keyed by requestId. */
  private readonly artifactWaiters = new Map<
    string,
    (r: SessionArtifactReply | undefined) => void
  >();
  private requestSeq = 0;
  /** Highest `sourceRevision` observed on any result from THIS engine boot.
   *  Each `setProject` bumps the engine's revision exactly once, so a new
   *  compile only accepts results above everything seen before it. Reset on
   *  `ready` — a webview reload restarts the engine's revision counter at 0. */
  private maxRevisionSeen = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly expectedProtocolVersion: number,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: SessionOutbound) => this.onMessage(m)),
      panel.onDidDispose(() => this.onDispose()),
    );
  }

  /** Whether a session panel currently exists. */
  static hasPanel(): boolean {
    return SessionPanel.current !== undefined;
  }

  /**
   * Open the session panel (creating it once) and resolve when it has booted: the
   * webview loaded, signalled `ready`, and its protocolVersion matched the pinned
   * one. A second call on an already-booted panel reveals it and resolves with the
   * cached outcome. Re-uses one panel — the WASM engine is expensive to spin up.
   */
  static boot(context: vscode.ExtensionContext, reveal = true): Promise<BootOutcome> {
    if (!SessionPanel.current) {
      const dir = sessionDir(context.extensionUri);
      const expected = readSessionManifest(context.extensionUri).protocolVersion;
      const panel = vscode.window.createWebviewPanel(
        'openscadWebSession',
        'OpenSCAD: Live Session',
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [dir], retainContextWhenHidden: true },
      );
      panel.webview.html = buildSessionHtml(panel.webview, dir);
      SessionPanel.current = new SessionPanel(panel, expected);
    }
    return SessionPanel.current.awaitBoot(reveal);
  }

  /**
   * Boot the session (if needed) then compile a project closure: push `setProject`
   * and resolve on the first terminal result that produced geometry (a success with
   * an OFF artifact) or failed (an error). A failed/skewed boot resolves with those
   * boot fields and `compiled:false`.
   */
  static async compile(
    context: vscode.ExtensionContext,
    files: ProjectFile[],
    entryPoint?: string,
    reveal = true,
  ): Promise<CompileOutcome> {
    const boot = await SessionPanel.boot(context, reveal);
    const panel = SessionPanel.current;
    if (!panel) return fromBoot(boot); // disposed during boot
    return panel.runCompile(boot, files, entryPoint);
  }

  /**
   * Export the current preview as `format` and fetch the exact bytes (P6):
   * `export` → the `kind:'export'` terminal on the push stream → `getArtifact`
   * → the correlated `artifact` reply. Requires a LIVE session (never boots one
   * — an export without a previewed model would only fail with `no-output`).
   */
  static exportArtifact(format: SessionExportFormat): Promise<ExportOutcome> {
    const panel = SessionPanel.current;
    if (!panel || !panel.live) {
      return Promise.resolve({
        ok: false,
        error: 'No live OpenSCAD preview — run "Preview .scad File" first.',
      });
    }
    return panel.runExport(format);
  }

  private runExport(format: SessionExportFormat): Promise<ExportOutcome> {
    // One export at a time: a newer request supersedes the in-flight one
    // (silently — a re-trigger is not a failure).
    this.settleExport({ ok: false, superseded: true });
    return new Promise<ExportOutcome>((resolve) => {
      const waiter: ExportWaiter = {
        resolve,
        format,
        timer: setTimeout(
          () =>
            this.settleExportIf(waiter, {
              ok: false,
              error: `export timed out after ${EXPORT_TIMEOUT_MS}ms`,
            }),
          EXPORT_TIMEOUT_MS,
        ),
      };
      this.exportWaiter = waiter;
      this.send({ type: 'export', format });
    });
  }

  private settleExport(outcome: ExportOutcome): void {
    const w = this.exportWaiter;
    if (!w) return;
    this.exportWaiter = undefined;
    clearTimeout(w.timer);
    w.resolve(outcome);
  }

  /** Settle ONLY IF `waiter` is still the current one — every async settle path
   *  must identity-check, or a superseded export's late result/fetch would
   *  settle the NEWER waiter with the OLDER artifact's bytes. */
  private settleExportIf(waiter: ExportWaiter, outcome: ExportOutcome): void {
    if (this.exportWaiter !== waiter) return;
    this.settleExport(outcome);
  }

  /** Second half of the export flow: fetch the produced artifact's bytes by id.
   *  `waiter` pins the export this fetch belongs to. */
  private async fetchExportedArtifact(waiter: ExportWaiter, ref: ArtifactRef): Promise<void> {
    const requestId = `exp-${++this.requestSeq}`;
    const reply = await new Promise<SessionArtifactReply | undefined>((resolve) => {
      this.artifactWaiters.set(requestId, resolve);
      this.send({ type: 'getArtifact', artifactId: ref.artifactId, requestId });
      setTimeout(() => {
        if (this.artifactWaiters.delete(requestId)) resolve(undefined);
      }, ARTIFACT_FETCH_TIMEOUT_MS);
    });
    if (!reply) {
      this.settleExportIf(waiter, { ok: false, error: 'artifact fetch timed out' });
    } else if (!reply.available) {
      this.settleExportIf(waiter, {
        ok: false,
        error: 'the exported artifact is no longer available — try exporting again',
      });
    } else {
      this.settleExportIf(waiter, { ok: true, artifact: reply.artifact, bytes: reply.bytes });
    }
  }

  private awaitBoot(reveal: boolean): Promise<BootOutcome> {
    // Manual previews reveal the panel in its own column, PRESERVING focus so
    // the editor keeps the caret. Save-triggered compiles don't reveal at all —
    // flipping the panel's tab group back to it on every save would defeat the
    // quiet-trigger design (the panel may be deliberately behind another tab).
    if (reveal) this.panel.reveal(undefined, true);
    // The boot promise settles once; a later caller resolves from the cached
    // outcome rather than waiting for a `ready` that won't fire again.
    if (this.bootOutcome) return Promise.resolve(this.bootOutcome);
    return new Promise<BootOutcome>((resolve) => {
      this.bootWaiters.push({
        resolve,
        timer: setTimeout(
          () => this.settleBoot({ error: `boot timed out after ${BOOT_TIMEOUT_MS}ms` }),
          BOOT_TIMEOUT_MS,
        ),
      });
    });
  }

  private runCompile(
    boot: BootOutcome,
    files: ProjectFile[],
    entryPoint?: string,
  ): Promise<CompileOutcome> {
    if (!boot.ready) return Promise.resolve(fromBoot(boot));
    this.currentProject = { files, entryPoint };
    // Supersede any still-in-flight compile so its caller doesn't hang — silently
    // (supersession is a normal re-trigger, not a compile failure).
    this.settleCompile({ superseded: true });
    return new Promise<CompileOutcome>((resolve) => {
      this.compileWaiter = {
        resolve,
        outcome: {
          ready: true,
          protocolVersion: this.expectedProtocolVersion,
          expectedProtocolVersion: this.expectedProtocolVersion,
          compiled: false,
          diagnostics: [],
          closedByUser: false,
          superseded: false,
        },
        timer: setTimeout(
          () => this.settleCompile({ error: `compile timed out after ${COMPILE_TIMEOUT_MS}ms` }),
          COMPILE_TIMEOUT_MS,
        ),
        settled: false,
        // Our `setProject` below bumps the engine's revision past everything
        // observed so far, so anything at or below `maxRevisionSeen` is a late
        // result from a superseded push and must not settle this waiter.
        minRevision: this.maxRevisionSeen + 1,
        acceptedRevision: -1,
      };
      this.redrive();
    });
  }

  /** (Re)push the current project to a live session — also the reload recovery path. */
  private redrive(): void {
    if (!this.live || !this.currentProject) return;
    this.send({
      type: 'setProject',
      files: this.currentProject.files,
      entryPoint: this.currentProject.entryPoint,
    });
  }

  private onMessage(msg: SessionOutbound): void {
    switch (msg.type) {
      case 'ready':
        if (msg.protocolVersion !== this.expectedProtocolVersion) {
          this.settleBoot({
            protocolVersion: msg.protocolVersion,
            error: `protocol version mismatch: session reports v${msg.protocolVersion}, expected v${this.expectedProtocolVersion}`,
          });
          return; // version skew — do not drive the session.
        }
        this.live = true;
        this.settleBoot({ ready: true, protocolVersion: msg.protocolVersion });
        // A webview reload re-fires `ready` with a fresh, empty engine; re-push the
        // current project so it recompiles (first `ready` has no project yet → no-op).
        // The fresh engine's revision counter restarts at 0, so the revision gate
        // must restart with it — otherwise the redriven compile's results would all
        // be dropped as "stale" and the waiter would hang to its timeout. The
        // accepted high-water mark must restart too: post-reload revisions are
        // numerically BELOW the pre-reload ones, and the fresh results must still
        // reset the accumulated diagnostics.
        this.maxRevisionSeen = 0;
        if (this.compileWaiter) {
          this.compileWaiter.minRevision = 0;
          this.compileWaiter.acceptedRevision = -1;
        }
        // A reload also drops any in-flight export on the floor engine-side —
        // settle it now instead of pinning a progress toast for 120s.
        this.settleExport({
          ok: false,
          error: 'the session reloaded during the export — try again',
        });
        this.redrive();
        break;
      case 'operation-result': {
        // The push stream: `setProject`'s auto-compile fans out to a syntaxCheck +
        // a preview (NOT a full render). Settle on the first terminal that produced
        // geometry (success + OFF artifact) or failed (error); a syntax error
        // settles via the preview error. Diagnostics accumulate across the stream.
        //
        // Correlation: results carry the engine's monotonic `sourceRevision`, and
        // each `setProject` bumps it exactly once, so a waiter ignores anything
        // below the revision floor captured at its creation (`minRevision`) — a
        // late result from a superseded push can no longer settle it. Residual
        // window: if a push is superseded before ANY of its results arrived
        // (rapid re-trigger, or a reload-redriven push followed by an immediate
        // new preview), the floor predates it and one of its late results could
        // still slip through; the debounce on save-triggers makes that window
        // small, and the session renders the latest geometry in-process
        // regardless. Closing it fully needs host↔engine correlation (an ack
        // carrying the assigned revision) — an upstream protocol change.
        const r = msg.result;
        // Export results branch off first: they are P6's flow, carry the
        // CONSUMED output's (older) revision by design, and must neither settle
        // the compile waiter (an off pass-through export looks exactly like a
        // compiled preview) nor feed the diagnostics accumulator.
        if (r.kind === 'export') {
          const ew = this.exportWaiter;
          if (!ew) break;
          if (r.status === 'success' && r.artifact) {
            // Format belt: the wire has no export↔result correlation id yet, so
            // a SUPERSEDED export's late success must not feed the newer waiter
            // — its artifact format differs whenever the formats differ. (Same-
            // format supersession remains ambiguous until the upstream id.)
            if (r.artifact.format !== ew.format) break;
            void this.fetchExportedArtifact(ew, r.artifact);
          } else if (r.status === 'error') {
            // Append the engine log tail: "Render failed" alone is undiagnosable.
            const logTail = r.logText ? `\n${r.logText.slice(-600)}` : '';
            this.settleExportIf(ew, { ok: false, error: `${r.code}: ${r.reason}${logTail}` });
          } else if (r.status === 'cancelled') {
            this.settleExportIf(ew, { ok: false, error: 'export was cancelled' });
          }
          break;
        }
        this.maxRevisionSeen = Math.max(this.maxRevisionSeen, r.sourceRevision);
        const w = this.compileWaiter;
        if (!w || w.settled) break;
        if (r.sourceRevision < w.minRevision) break; // stale: a superseded push
        if (r.sourceRevision > w.acceptedRevision) {
          // A fresher revision started streaming (e.g. the redrive after a webview
          // reload): markers from the older one no longer describe these sources.
          w.acceptedRevision = r.sourceRevision;
          w.outcome.diagnostics = [];
        }
        if (r.diagnostics.length) w.outcome.diagnostics.push(...r.diagnostics);
        if (r.status === 'success' && r.artifact?.format === 'off') {
          w.outcome.compiled = true;
          w.outcome.artifact = r.artifact;
          this.settleCompile();
        } else if (r.status === 'error') {
          w.outcome.error = `${r.code}: ${r.reason}`;
          this.settleCompile();
        }
        // syntaxCheck success (no artifact) / cancelled → keep waiting.
        break;
      }
      case 'artifact': {
        const waiter = this.artifactWaiters.get(msg.requestId);
        if (waiter) {
          this.artifactWaiters.delete(msg.requestId);
          waiter(msg);
        }
        break;
      }
      case 'error':
        // A protocol-level error during boot (e.g. malformed handshake). Per-project
        // compile errors arrive as `operation-result`, not here. `settleBoot` is
        // once-only, so a post-boot protocol error is harmlessly ignored.
        this.settleBoot({ error: `${msg.code}: ${msg.reason}` });
        break;
    }
  }

  /** Resolve all boot waiters with the terminal boot outcome, once. */
  private settleBoot(partial: Partial<BootOutcome>): void {
    if (this.bootOutcome) return;
    this.bootOutcome = {
      ready: partial.ready ?? false,
      protocolVersion: partial.protocolVersion ?? -1,
      expectedProtocolVersion: this.expectedProtocolVersion,
      error: partial.error,
      closedByUser: partial.closedByUser ?? false,
    };
    const waiters = this.bootWaiters;
    this.bootWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(this.bootOutcome);
    }
    // A failed boot (timeout / version skew / protocol error) caches a not-ready
    // outcome that every later compile would reuse forever. Tear the panel down so
    // the next command rebuilds a fresh one instead of being permanently bricked.
    // (A user-closed panel is already disposing — don't re-enter.)
    if (!this.bootOutcome.ready && !this.bootOutcome.closedByUser) {
      this.panel.dispose();
    }
  }

  /** Resolve the in-flight compile (if any) with its accumulated outcome, once. */
  private settleCompile(partial?: Partial<CompileOutcome>): void {
    const w = this.compileWaiter;
    if (!w || w.settled) return;
    w.settled = true;
    clearTimeout(w.timer);
    this.compileWaiter = undefined;
    if (partial) Object.assign(w.outcome, partial);
    w.resolve(w.outcome);
  }

  private send(message: SessionInbound): void {
    void this.panel.webview.postMessage(stampSessionInbound(message, this.expectedProtocolVersion));
  }

  private onDispose(): void {
    // If the user closed the panel before an outcome settled, report it as a close,
    // not a failure (mirrors the viewer's closedByUser handling).
    if (!this.bootOutcome) this.settleBoot({ closedByUser: true });
    this.settleCompile({ closedByUser: true });
    this.settleExport({ ok: false, error: 'the session panel was closed' });
    this.disposables.forEach((d) => d.dispose());
    SessionPanel.current = undefined;
    SessionPanel.disposedEmitter.fire();
  }
}

/** Project a (failed/skewed) boot outcome onto a non-compiled CompileOutcome. */
function fromBoot(boot: BootOutcome): CompileOutcome {
  return {
    ready: boot.ready,
    protocolVersion: boot.protocolVersion,
    expectedProtocolVersion: boot.expectedProtocolVersion,
    compiled: false,
    error: boot.error,
    diagnostics: [],
    closedByUser: boot.closedByUser,
    superseded: false,
  };
}

function buildSessionHtml(webview: vscode.Webview, dir: vscode.Uri): string {
  const baseHref = `${webview.asWebviewUri(dir).toString()}/`;
  // The compile CSP (openscad-web docs/EMBEDDING-VSCODE.md §6): WASM needs
  // `wasm-unsafe-eval`; the engine runs in a same-origin blob worker
  // (`worker-src blob:`). `connect-src` covers the main thread's fetches of the
  // worker script / .wasm / zips (cspSource) AND the worker's fetches of those
  // assets from same-origin `blob:` URLs — a blob worker's vscode-resource fetches
  // bypass the resource service worker (HTTP 408), so the session hands it blob:
  // URLs instead (openscad-web #203). No COOP/COEP — single-threaded engine.
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
    `worker-src blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `connect-src ${webview.cspSource} blob:`,
  ].join('; ');

  const raw = fs.readFileSync(vscode.Uri.joinPath(dir, 'session.html').fsPath, 'utf8');
  return raw
    .replace(
      '<head>',
      `<head>\n    <base href="${baseHref}">\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )
    .replace(/\s+crossorigin/g, '');
}
