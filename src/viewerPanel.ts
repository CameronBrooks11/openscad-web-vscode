// The webview panel that hosts the standalone viewer and drives the L0 handshake.
//
// Lifecycle (see openscad-web docs/EMBEDDING-VSCODE.md):
//   1. load viewer.html (relative base rewritten to the webview resource root)
//   2. wait for the viewer's `ready` — assert its protocolVersion == the pin
//   3. push settings + geometry; resolve on `geometry-loaded` or `error`.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readManifest, viewerDir } from './viewerArtifact';
import { stampInbound, type ViewerInbound, type ViewerOutbound } from './protocol';

/** The terminal result of pushing geometry — deliberately tolerant for headless CI. */
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

export class ViewerPanel {
  /**
   * Open a panel, push the given OFF geometry, and resolve once the viewer
   * reports a terminal outcome (loaded / error / timeout / panel closed).
   */
  static async showOff(
    context: vscode.ExtensionContext,
    offText: string,
    title: string,
  ): Promise<LoadOutcome> {
    const dir = viewerDir(context.extensionUri);
    const expectedProtocolVersion = readManifest(context.extensionUri).protocolVersion;

    const panel = vscode.window.createWebviewPanel(
      'openscadWebViewer',
      `OpenSCAD: ${title}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [dir],
        // Geometry lives extension-side and is cheap to re-push, so we don't pay
        // to keep the GL context alive while hidden. Re-push on reveal if needed.
        retainContextWhenHidden: false,
      },
    );

    panel.webview.html = buildHtml(panel.webview, dir);

    return await new Promise<LoadOutcome>((resolve) => {
      const outcome: LoadOutcome = {
        ready: false,
        protocolVersion: -1,
        expectedProtocolVersion,
        loaded: false,
        closedByUser: false,
      };
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        disposeSub.dispose();
        resolve(outcome);
      };
      const timer = setTimeout(settle, HANDSHAKE_TIMEOUT_MS);

      const opId = 'host-load-1';
      const sub = panel.webview.onDidReceiveMessage((msg: ViewerOutbound) => {
        switch (msg.type) {
          case 'ready':
            outcome.ready = true;
            outcome.protocolVersion = msg.protocolVersion;
            if (msg.protocolVersion !== expectedProtocolVersion) {
              settle(); // version skew — stop before pushing anything.
              return;
            }
            void send(panel.webview, {
              type: 'setViewerSettings',
              showAxes: true,
              showControls: true,
            });
            void send(panel.webview, { type: 'setGeometry', offText }, opId);
            break;
          case 'geometry-loaded':
            outcome.loaded = true;
            settle();
            break;
          case 'error':
            outcome.error = `${msg.code}: ${msg.reason}`;
            settle();
            break;
          // geometry-set / camera-change / acks: not terminal — ignore here.
        }

        function send(webview: vscode.Webview, message: ViewerInbound, id?: string) {
          return webview.postMessage(stampInbound(message, expectedProtocolVersion, id));
        }
      });

      const disposeSub = panel.onDidDispose(() => {
        // Disposed before a terminal outcome == the user closed the panel.
        outcome.closedByUser = !settled;
        settle();
      });
    });
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
