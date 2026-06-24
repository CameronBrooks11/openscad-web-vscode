// Access to the vendored session artifact (media/session/) and its manifest.
//
// The artifact is produced by openscad-web's `npm run build:session` and copied in
// by `scripts/sync-session.mjs`. Its `session-manifest.json` is the single source
// of truth for the pinned `protocolVersion` the extension must agree with. Unlike
// the read-only viewer artifact, this one is compile-capable: it carries the
// OpenSCAD WASM + worker + library zips, and is loaded by sessionPanel.ts to run
// live `.scad` compilation in the webview (epic #8).

import * as fs from 'fs';
import * as vscode from 'vscode';

export interface SessionManifest {
  schemaVersion: number;
  sessionVersion: string;
  protocolVersion: number;
  sourceCommit: string;
  builtAt: string;
  files: Record<string, { bytes: number; sha256: string }>;
  allowlist: string[];
}

/** The folder the session artifact lives in (also the webview's resource root). */
export function sessionDir(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'session');
}

export function readSessionManifest(extensionUri: vscode.Uri): SessionManifest {
  const path = vscode.Uri.joinPath(sessionDir(extensionUri), 'session-manifest.json').fsPath;
  return JSON.parse(fs.readFileSync(path, 'utf8')) as SessionManifest;
}
