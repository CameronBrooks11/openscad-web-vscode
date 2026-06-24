// The reusable webview panel that hosts the standalone viewer and drives the L0
// handshake.
//
// One panel is kept alive and reused: repeated opens reveal it and re-feed the
// geometry rather than spawning new panels. The viewer is (re)fed its geometry,
// theme, and last camera on every `ready` — which re-fires whenever VS Code
// reloads the webview after it was hidden (retainContextWhenHidden is off).
//
// Handshake (see openscad-web docs/EMBEDDING-VSCODE.md): wait for `ready`, assert
// its protocolVersion == the pin, then push settings + geometry; resolve the
// per-load outcome on `geometry-loaded` or `error`.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readManifest, viewerDir } from './viewerArtifact';
import {
  stampInbound,
  type CameraPose,
  type NamedView,
  type ViewerInbound,
  type ViewerOutbound,
} from './protocol';

/** The terminal result of a single load — deliberately tolerant for headless CI. */
export interface LoadOutcome {
  /** The viewer signalled `ready`. */
  ready: boolean;
  /** protocolVersion the viewer reported on `ready` (-1 if never ready). */
  protocolVersion: number;
  /** protocolVersion pinned in the vendored artifact's manifest. */
  expectedProtocolVersion: number;
  /** A `geometry-loaded` was received. */
  loaded: boolean;
  /** Set if the viewer reported an `error` (e.g. headless WebGL unavailable). */
  error?: string;
  /** The user closed the panel before any terminal outcome — not a failure. */
  closedByUser: boolean;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;

interface Pending {
  outcome: LoadOutcome;
  resolve: (o: LoadOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class ViewerPanel {
  private static current: ViewerPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** The viewer has signalled `ready` since the last (re)load of the webview. */
  private live = false;
  private loadCounter = 0;
  private geometry?: { offText: string; opId: string };
  /** offText the live viewer has actually rendered (`geometry-loaded`). */
  private loadedOffText?: string;
  /** offText last sent to the live viewer (it won't re-render an identical one). */
  private pushedOffText?: string;
  /** Last user camera, restored on a reveal-reload of the same geometry. */
  private camera?: CameraPose;
  private pending?: Pending;
  /** Capabilities advertised by the viewer on `ready`. */
  private capabilities: string[] = [];
  /** In-flight named-view request awaiting its `named-view-set` ack. */
  private namedViewWaiter?: {
    opId: string;
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private namedViewSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly expectedProtocolVersion: number,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ViewerOutbound) => this.onMessage(m)),
      panel.onDidChangeViewState(() => {
        // With retainContextWhenHidden:false, a hidden webview is torn down and
        // VS Code reloads it (re-firing `ready`) on the next reveal. Mark not-live
        // while hidden so a load() defers its push to that `ready`. If a reveal
        // ever failed to reload, the per-load HANDSHAKE_TIMEOUT_MS is the backstop.
        if (!panel.visible) this.live = false;
      }),
      panel.onDidDispose(() => this.onDispose()),
    );
  }

  /** Open the viewer (creating the panel once) or reveal+re-drive the existing one. */
  static show(
    context: vscode.ExtensionContext,
    offText: string,
    title: string,
  ): Promise<LoadOutcome> {
    if (!ViewerPanel.current) {
      const dir = viewerDir(context.extensionUri);
      const expected = readManifest(context.extensionUri).protocolVersion;
      const panel = vscode.window.createWebviewPanel(
        'openscadWebViewer',
        `OpenSCAD: ${title}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [dir], retainContextWhenHidden: false },
      );
      panel.webview.html = buildHtml(panel.webview, dir);
      ViewerPanel.current = new ViewerPanel(panel, expected);
    }
    return ViewerPanel.current.load(offText, title);
  }

  /** Push the active VS Code theme to the live panel, if any. */
  static applyTheme(): void {
    ViewerPanel.current?.pushSettings();
  }

  /** Whether a viewer panel currently exists. */
  static hasPanel(): boolean {
    return ViewerPanel.current !== undefined;
  }

  /**
   * Apply a fit-aware named camera view to the live panel. Resolves false when
   * unavailable (no live panel, or the viewer lacks the `setNamedView` capability)
   * or if the ack doesn't arrive.
   */
  static applyNamedView(view: NamedView): Promise<boolean> {
    return ViewerPanel.current?.sendNamedView(view) ?? Promise.resolve(false);
  }

  private load(offText: string, title: string): Promise<LoadOutcome> {
    // A new load supersedes any still-pending one.
    this.settle();

    this.panel.title = `OpenSCAD: ${title}`;
    // Preserve the camera only when the model is unchanged; a different model
    // should auto-frame. Keyed on model identity, not panel visibility.
    const sameModel = this.geometry?.offText === offText;
    this.geometry = { offText, opId: `load-${++this.loadCounter}` };
    if (!sameModel) this.camera = undefined;

    const promise = new Promise<LoadOutcome>((resolve) => {
      this.pending = {
        outcome: {
          ready: false,
          protocolVersion: -1,
          expectedProtocolVersion: this.expectedProtocolVersion,
          loaded: false,
          closedByUser: false,
        },
        resolve,
        timer: setTimeout(() => this.settle(), HANDSHAKE_TIMEOUT_MS),
        settled: false,
      };
    });

    this.panel.reveal(vscode.ViewColumn.Active, false);
    // A live viewer (panel was visible) won't re-emit `ready`, so reflect the
    // established handshake here. When not live, the imminent `ready` (initial
    // load or reveal-reload) sets the outcome and pushes instead.
    if (this.live && this.pending) {
      this.pending.outcome.ready = true;
      this.pending.outcome.protocolVersion = this.expectedProtocolVersion;
      if (this.pushedOffText === offText) {
        // The live viewer already holds this exact geometry and won't re-render
        // it (no `geometry-loaded` will arrive) — resolve from what we know
        // instead of waiting out the timeout.
        this.pending.outcome.loaded = this.loadedOffText === offText;
        this.settle();
      } else {
        this.pushAll();
      }
    }
    return promise;
  }

  private onMessage(msg: ViewerOutbound): void {
    switch (msg.type) {
      case 'ready':
        this.capabilities = msg.capabilities;
        if (this.pending) {
          this.pending.outcome.ready = true;
          this.pending.outcome.protocolVersion = msg.protocolVersion;
        }
        if (msg.protocolVersion !== this.expectedProtocolVersion) {
          this.settle(); // version skew — stop before pushing anything.
          return;
        }
        this.live = true; // ready AND version OK → safe to (re)drive.
        this.pushAll();
        break;
      case 'camera-change':
        this.camera = msg.camera; // remember the user's view for reveal-reload.
        break;
      case 'named-view-set':
        if (this.namedViewWaiter && msg.opId === this.namedViewWaiter.opId) {
          clearTimeout(this.namedViewWaiter.timer);
          this.namedViewWaiter.resolve(true);
          this.namedViewWaiter = undefined;
        }
        break;
      case 'geometry-loaded':
        // Strict opId correlation (the viewer always echoes the setGeometry opId),
        // so a superseded load's ack is ignored. Runs even with no pending load,
        // so a reveal-reload restores the camera too.
        if (msg.opId !== this.geometry?.opId) break;
        this.loadedOffText = this.geometry?.offText;
        // Restore the user's camera *after* the geometry mounts, so it overrides
        // the viewer's auto-frame instead of racing it.
        if (this.camera) this.send({ type: 'setCamera', camera: this.camera });
        if (this.pending) {
          this.pending.outcome.loaded = true;
          this.settle();
        }
        break;
      case 'error':
        // Ignore a stale render-error from a superseded load; general errors
        // (version/payload) carry no opId and still settle.
        if (msg.opId !== undefined && msg.opId !== this.geometry?.opId) break;
        if (this.pending) {
          this.pending.outcome.error = `${msg.code}: ${msg.reason}`;
          this.settle();
        }
        break;
      // geometry-set / *-set acks: not terminal — ignore.
    }
  }

  private pushAll(): void {
    this.pushSettings();
    if (this.geometry) {
      this.pushedOffText = this.geometry.offText;
      this.send({ type: 'setGeometry', offText: this.geometry.offText }, this.geometry.opId);
    }
    // The camera is restored after `geometry-loaded` (see onMessage), not here,
    // so the viewer's auto-frame on mount doesn't clobber it.
  }

  private sendNamedView(view: NamedView): Promise<boolean> {
    if (!this.live || !this.capabilities.includes('setNamedView')) {
      return Promise.resolve(false);
    }
    // Supersede any prior in-flight request.
    const prev = this.namedViewWaiter;
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve(false);
    }
    const opId = `view-${++this.namedViewSeq}`;
    this.send({ type: 'setNamedView', view }, opId);
    return new Promise<boolean>((resolve) => {
      this.namedViewWaiter = {
        opId,
        resolve,
        timer: setTimeout(() => {
          this.namedViewWaiter = undefined;
          resolve(false);
        }, 5_000),
      };
    });
  }

  private pushSettings(): void {
    if (!this.live) return;
    this.send({
      type: 'setViewerSettings',
      showAxes: true,
      showControls: true,
      background: themeBackground(),
    });
  }

  private send(message: ViewerInbound, opId?: string): void {
    void this.panel.webview.postMessage(stampInbound(message, this.expectedProtocolVersion, opId));
  }

  private settle(): void {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve(p.outcome);
  }

  private onDispose(): void {
    if (this.pending && !this.pending.settled) this.pending.outcome.closedByUser = true;
    this.settle();
    if (this.namedViewWaiter) {
      clearTimeout(this.namedViewWaiter.timer);
      this.namedViewWaiter.resolve(false);
      this.namedViewWaiter = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    ViewerPanel.current = undefined;
  }
}

/** Map the active VS Code theme to a scene background the viewer can apply. */
function themeBackground(): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
    case vscode.ColorThemeKind.HighContrastLight:
      return '#ffffff';
    case vscode.ColorThemeKind.HighContrast:
      return '#000000';
    case vscode.ColorThemeKind.Dark:
    default:
      return '#1e1e1e';
  }
}

function buildHtml(webview: vscode.Webview, dir: vscode.Uri): string {
  const baseHref = `${webview.asWebviewUri(dir).toString()}/`;
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');

  const raw = fs.readFileSync(vscode.Uri.joinPath(dir, 'viewer.html').fsPath, 'utf8');
  return (
    raw
      // Resolve the artifact's relative ./assets/ URLs against the webview root,
      // and apply a strict CSP. `crossorigin` only affects the script's credentials
      // mode and is unnecessary for these same-origin webview resources — drop it.
      .replace(
        '<head>',
        `<head>\n    <base href="${baseHref}">\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
      )
      .replace(/\s+crossorigin/g, '')
  );
}
