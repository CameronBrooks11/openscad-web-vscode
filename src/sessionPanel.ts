// The webview panel that hosts the compile-capable session (`session.html`) and
// drives the L1 handshake. The compile counterpart to `viewerPanel.ts`.
//
// Unlike the read-only viewer, this boots the OpenSCAD WASM engine in the webview,
// so its CSP grants `wasm-unsafe-eval` + `worker-src blob:` (the worker runs from a
// same-origin blob URL — see openscad-web docs/EMBEDDING-VSCODE.md §6), and it uses
// `retainContextWhenHidden: true` so hiding the panel does not tear down and
// re-initialise the WASM engine. Consequently `ready` fires exactly once per panel.
//
// P2 (this file) covers boot + handshake: load the artifact, wait for `ready`,
// assert its protocolVersion == the manifest pin. Driving a project (`setProject`)
// and consuming the OperationResult push stream is P3.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readSessionManifest, sessionDir } from './sessionArtifact';
import { type SessionOutbound } from './sessionProtocol';

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

const BOOT_TIMEOUT_MS = 60_000; // cold WASM + FS init is slower than the L0 viewer.

interface Pending {
  resolve: (o: BootOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionPanel {
  private static current: SessionPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** Cached terminal boot outcome, set once `ready`/`error`/timeout settles. */
  private bootOutcome?: BootOutcome;
  private pending: Pending[] = [];

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
  static boot(context: vscode.ExtensionContext): Promise<BootOutcome> {
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
    return SessionPanel.current.awaitBoot();
  }

  private awaitBoot(): Promise<BootOutcome> {
    this.panel.reveal(vscode.ViewColumn.Active, false);
    // `ready` fires once (retainContextWhenHidden), so a later caller resolves from
    // the cached outcome rather than waiting for an event that won't come again.
    if (this.bootOutcome) return Promise.resolve(this.bootOutcome);
    return new Promise<BootOutcome>((resolve) => {
      this.pending.push({ resolve, timer: setTimeout(() => this.settleBoot({}), BOOT_TIMEOUT_MS) });
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
        this.settleBoot({ ready: true, protocolVersion: msg.protocolVersion });
        break;
      case 'error':
        // A protocol-level error during boot (e.g. malformed handshake). Per-project
        // compile errors (P3) arrive as `operation-result`, not here.
        if (!this.bootOutcome) this.settleBoot({ error: `${msg.code}: ${msg.reason}` });
        break;
      // operation-result: handled in P3 (the compile push stream).
    }
  }

  /** Resolve all waiters with the terminal boot outcome, once. */
  private settleBoot(partial: Partial<BootOutcome>): void {
    if (this.bootOutcome) return;
    this.bootOutcome = {
      ready: partial.ready ?? false,
      protocolVersion: partial.protocolVersion ?? -1,
      expectedProtocolVersion: this.expectedProtocolVersion,
      error: partial.error,
      closedByUser: partial.closedByUser ?? false,
    };
    const waiters = this.pending;
    this.pending = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(this.bootOutcome);
    }
  }

  private onDispose(): void {
    // If the user closed the panel before boot settled, report it as a close, not
    // a failure (mirrors the viewer's closedByUser handling).
    if (!this.bootOutcome) this.settleBoot({ closedByUser: true });
    this.disposables.forEach((d) => d.dispose());
    SessionPanel.current = undefined;
  }
}

function buildSessionHtml(webview: vscode.Webview, dir: vscode.Uri): string {
  const baseHref = `${webview.asWebviewUri(dir).toString()}/`;
  // The compile CSP (openscad-web docs/EMBEDDING-VSCODE.md §6): WASM needs
  // `wasm-unsafe-eval`; the engine runs in a same-origin blob worker
  // (`worker-src blob:`); `connect-src` covers the runtime fetches of the worker
  // script, the .wasm, and the library zips (all same-origin webview resources).
  // No COOP/COEP — the engine is single-threaded (no SharedArrayBuffer).
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
    `worker-src blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');

  const raw = fs.readFileSync(vscode.Uri.joinPath(dir, 'session.html').fsPath, 'utf8');
  return raw
    .replace(
      '<head>',
      `<head>\n    <base href="${baseHref}">\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )
    .replace(/\s+crossorigin/g, '');
}
