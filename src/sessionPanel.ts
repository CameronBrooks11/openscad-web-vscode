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
  type SessionLibrary,
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
const RENDER_TIMEOUT_MS = 300_000; // a full ($preview=false) render can be slow.
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

interface RenderWaiter {
  resolve: (o: { ok: boolean; error?: string; superseded?: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
  requestId: string;
}

interface ExportWaiter {
  resolve: (o: ExportOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Correlates this export with its terminal result: the session echoes it on
   *  every terminal of the operation (upstream #223), so a superseded export's
   *  late result can never be attributed to this waiter. */
  requestId: string;
}

interface CompileWaiter {
  resolve: (o: CompileOutcome) => void;
  /** Mutated as results stream in (diagnostics accumulate; set on the terminal). */
  outcome: CompileOutcome;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** The id sent with this waiter's LATEST setProject push (a redrive after a
   *  webview reload mints a fresh one) — matched against `project-ack`. */
  requestId: string;
  /** The engine's ASSIGNED revision for this push, from the ack (upstream
   *  #227). Unset until the ack arrives; results are accepted ONLY at exactly
   *  this revision — no heuristics, no reload special-cases. */
  expectedRevision?: number;
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
  /** The runtime user-library set (upstream #195) — session-lifetime state,
   *  re-pushed BEFORE the project on every `ready` (a reload wipes the
   *  engine). Static so it survives panel teardown/reopen. */
  private static currentLibraries: SessionLibrary[] = [];
  /** Whether the live session advertised `setLibraries` (feature detection —
   *  an older vendored artifact rejects the command as unknown-type). */
  private librariesSupported = false;
  private librariesWarnedUnsupported = false;
  /** The in-flight compile awaiting its terminal result, if any. */
  private compileWaiter?: CompileWaiter;
  /** The in-flight export awaiting its terminal result + bytes, if any. */
  private exportWaiter?: ExportWaiter;
  /** The in-flight full render awaiting its kind:'render' terminal, if any. */
  private renderWaiter?: RenderWaiter;
  /** Pending getArtifact replies, keyed by requestId. */
  private readonly artifactWaiters = new Map<
    string,
    (r: SessionArtifactReply | undefined) => void
  >();
  private requestSeq = 0;
  /** The revision the engine acked for the PREVIOUS push (undefined after a
   *  reload — the fresh engine restarts its counter). An ack that does NOT
   *  advance past this means the engine REJECTED the push (upstream #227). */
  private lastAckedRevision?: number;

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

  /** Replace the runtime user-library set (upstream #195). Session-lifetime:
   *  applies to the live session now (if any) and re-pushes on every future
   *  `ready`/boot. The already-previewed project recompiles session-side. */
  static setLibraries(libraries: SessionLibrary[]): void {
    SessionPanel.currentLibraries = libraries;
    const panel = SessionPanel.current;
    if (panel && panel.live) panel.sendLibraries();
  }

  private sendLibraries(): void {
    if (SessionPanel.currentLibraries.length === 0) return;
    if (!this.librariesSupported) {
      if (!this.librariesWarnedUnsupported) {
        this.librariesWarnedUnsupported = true;
        void vscode.window.showWarningMessage(
          'openscadWeb.libraryPaths is set, but the bundled session artifact predates ' +
            'library support — user libraries are unavailable until the artifact is updated.',
        );
      }
      return;
    }
    this.send({
      type: 'setLibraries',
      libraries: SessionPanel.currentLibraries,
      requestId: `libs-${++this.requestSeq}`,
    });
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
  static exportArtifact(
    format: SessionExportFormat,
    quality: 'preview' | 'render' = 'preview',
    cancelRef?: { cancel?: () => void },
  ): Promise<ExportOutcome> {
    const panel = SessionPanel.current;
    if (!panel || !panel.live) {
      return Promise.resolve({
        ok: false,
        error: 'No live OpenSCAD preview — run "Preview .scad File" first.',
      });
    }
    return panel.runQualityExport(format, quality, cancelRef);
  }

  /** Optionally run a FULL render first (#219 — `$preview = false`, so the
   *  export converts render-quality geometry), then the export. `cancelRef`
   *  (if given) is populated with a canceller scoped to THIS invocation's
   *  operations — a TARGETED wire cancel (upstream #226), so neither a
   *  concurrent save's compile nor another export command's operations are
   *  touched (late cancels of finished ops are engine-side no-ops). */
  private async runQualityExport(
    format: SessionExportFormat,
    quality: 'preview' | 'render',
    cancelRef?: { cancel?: () => void },
  ): Promise<ExportOutcome> {
    const myIds: string[] = [];
    if (cancelRef) {
      cancelRef.cancel = () => {
        for (const requestId of myIds) this.send({ type: 'cancel', requestId });
      };
    }
    if (quality === 'render') {
      const rendered = await this.runRender(myIds);
      if (!rendered.ok) {
        return {
          ok: false,
          superseded: rendered.superseded,
          error: rendered.error ? `full render failed: ${rendered.error}` : undefined,
        };
      }
      if (!this.live) return { ok: false, error: 'the session went away during the render' };
    }
    return this.runExport(format, myIds);
  }

  /** Trigger a full render and await its kind:'render' terminal (correlated by
   *  the echoed requestId). The render-quality output then becomes what the
   *  export converts — and what the embedded viewer shows. */
  private runRender(
    myIds?: string[],
  ): Promise<{ ok: boolean; error?: string; superseded?: boolean }> {
    this.settleRender({ ok: false, superseded: true });
    return new Promise((resolve) => {
      const requestId = `render-cmd-${++this.requestSeq}`;
      myIds?.push(requestId);
      const waiter: RenderWaiter = {
        resolve,
        requestId,
        timer: setTimeout(
          () =>
            this.settleRenderIf(waiter, {
              ok: false,
              error: `render timed out after ${RENDER_TIMEOUT_MS}ms`,
            }),
          RENDER_TIMEOUT_MS,
        ),
      };
      this.renderWaiter = waiter;
      this.send({ type: 'render', requestId: waiter.requestId });
    });
  }

  private settleRender(outcome: { ok: boolean; error?: string; superseded?: boolean }): void {
    const w = this.renderWaiter;
    if (!w) return;
    this.renderWaiter = undefined;
    clearTimeout(w.timer);
    w.resolve(outcome);
  }

  private settleRenderIf(
    waiter: RenderWaiter,
    outcome: { ok: boolean; error?: string; superseded?: boolean },
  ): void {
    if (this.renderWaiter !== waiter) return;
    this.settleRender(outcome);
  }

  private runExport(format: SessionExportFormat, myIds?: string[]): Promise<ExportOutcome> {
    // One export at a time: a newer request supersedes the in-flight one
    // (silently — a re-trigger is not a failure).
    this.settleExport({ ok: false, superseded: true });
    return new Promise<ExportOutcome>((resolve) => {
      const requestId = `exp-cmd-${++this.requestSeq}`;
      myIds?.push(requestId);
      const waiter: ExportWaiter = {
        resolve,
        requestId,
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
      this.send({ type: 'export', format, requestId: waiter.requestId });
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
        requestId: '', // assigned by redrive(), which mints one per push
      };
      this.redrive();
    });
  }

  /** (Re)push the current project to a live session — also the reload recovery path. */
  private redrive(): void {
    if (!this.live || !this.currentProject) return;
    // A fresh id per push: the coming `project-ack` re-binds the in-flight
    // waiter to THIS push's assigned revision (a reload restarts the engine's
    // counter, so the previous expectation is meaningless).
    const requestId = `push-${++this.requestSeq}`;
    if (this.compileWaiter && !this.compileWaiter.settled) {
      this.compileWaiter.requestId = requestId;
      this.compileWaiter.expectedRevision = undefined;
    }
    this.send({
      type: 'setProject',
      files: this.currentProject.files,
      entryPoint: this.currentProject.entryPoint,
      requestId,
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
        this.librariesSupported = msg.capabilities.includes('setLibraries');
        this.settleBoot({ ready: true, protocolVersion: msg.protocolVersion });
        // A webview reload re-fires `ready` with a fresh, empty engine; re-push the
        // current project so it recompiles (first `ready` has no project yet → no-op).
        // The fresh engine restarts its revision counter, so the previous push's
        // ack expectation is void — redrive() below mints a fresh requestId and
        // the new ack re-binds the waiter to the new engine's revision.
        this.lastAckedRevision = undefined;
        // A reload also drops any in-flight render/export on the floor
        // engine-side — settle them now instead of pinning a progress toast.
        this.settleRender({
          ok: false,
          error: 'the session reloaded during the render — try again',
        });
        this.settleExport({
          ok: false,
          error: 'the session reloaded during the export — try again',
        });
        // Libraries BEFORE the project (ADR 0010 order): a fresh engine has
        // neither; the project push then compiles with them already in place.
        this.sendLibraries();
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
        // compiled preview) nor feed the diagnostics accumulator. Compile
        // results are accepted ONLY at the ack-assigned revision (#227).
        // A wire-triggered full render (#219): settle the waiter matching our
        // requestId, then FALL THROUGH — unlike export terminals, this is a
        // genuine compile-stream result at its true sourceRevision, and it can
        // be the ONLY success terminal an in-flight compile can settle on (the
        // engine's shared delayable lets the full render kill the auto
        // preview). Swallowing it here would starve that waiter into a
        // spurious 60s "compile timed out" toast.
        if (
          r.kind === 'render' &&
          this.renderWaiter &&
          r.requestId === this.renderWaiter.requestId
        ) {
          const rw = this.renderWaiter;
          if (r.status === 'success') {
            this.settleRenderIf(rw, { ok: true });
          } else if (r.status === 'error') {
            const logTail = r.logText ? `\n${r.logText.slice(-600)}` : '';
            this.settleRenderIf(rw, { ok: false, error: `${r.code}: ${r.reason}${logTail}` });
          } else {
            this.settleRenderIf(rw, { ok: false, error: 'render was cancelled' });
          }
        }
        if (r.kind === 'export') {
          const ew = this.exportWaiter;
          if (!ew) break;
          // Correlate by the echoed requestId (#223): a superseded export's
          // terminal — success OR failure — can never settle this waiter.
          if (r.requestId !== ew.requestId) break;
          if (r.status === 'success' && r.artifact) {
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
        const w = this.compileWaiter;
        if (!w || w.settled) break;
        // Exact correlation (#227): the ack (which precedes any of this push's
        // results — the session sends it synchronously on dispatch) bound this
        // waiter to its assigned revision. Anything else is another push's
        // late/stale result; without an ack yet, nothing is ours.
        if (w.expectedRevision === undefined || r.sourceRevision !== w.expectedRevision) break;
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
      case 'project-ack': {
        // Classify + track BEFORE the waiter match: a superseded push's ack
        // (no matching waiter) must still advance the baseline, or a following
        // REJECTED push would evade detection AND bind the waiter to the
        // superseded push's revision — accepting its results as this push's.
        // Safe across reloads: the webview pipe is FIFO, so old-engine acks
        // precede the new `ready`, which resets the baseline.
        const rejected =
          this.lastAckedRevision !== undefined && msg.sourceRevision <= this.lastAckedRevision;
        if (!rejected) this.lastAckedRevision = msg.sourceRevision;
        const w = this.compileWaiter;
        if (!w || w.settled || msg.requestId !== w.requestId) break;
        if (rejected) {
          // The engine did not advance its revision: it REJECTED the push
          // (path/size validation — previously invisible on the wire, a silent
          // 60s timeout). NOTE: undetectable for the FIRST push after a
          // boot/reload (no baseline) — that case still times out; a full fix
          // needs an accepted flag on the upstream ack.
          this.settleCompile({
            error: 'the session rejected the project push (path or size validation failed)',
          });
          break;
        }
        w.expectedRevision = msg.sourceRevision;
        w.outcome.diagnostics = []; // markers from any earlier push are void
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
    this.settleRender({ ok: false, error: 'the session panel was closed' });
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
