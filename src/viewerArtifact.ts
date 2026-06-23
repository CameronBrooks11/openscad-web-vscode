// Access to the vendored viewer artifact (media/viewer/) and its manifest.
//
// The artifact is produced by openscad-web's `npm run build:viewer` and copied in
// by `scripts/sync-viewer.mjs`. Its `viewer-manifest.json` is the single source
// of truth for the pinned `protocolVersion` the extension must agree with.

import * as fs from 'fs';
import * as vscode from 'vscode';

export interface ViewerManifest {
  schemaVersion: number;
  viewerVersion: string;
  protocolVersion: number;
  sourceCommit: string;
  builtAt: string;
  files: Record<string, { bytes: number; sha256: string }>;
  allowlist: string[];
}

/** The folder the viewer artifact lives in (also the webview's resource root). */
export function viewerDir(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'viewer');
}

export function readManifest(extensionUri: vscode.Uri): ViewerManifest {
  const path = vscode.Uri.joinPath(viewerDir(extensionUri), 'viewer-manifest.json').fsPath;
  return JSON.parse(fs.readFileSync(path, 'utf8')) as ViewerManifest;
}

/** The bundled fixture cube, used by the "Show Fixture Geometry" command + tests. */
export function readFixtureOff(extensionUri: vscode.Uri): string {
  const path = vscode.Uri.joinPath(extensionUri, 'media', 'fixtures', 'cube.off').fsPath;
  return fs.readFileSync(path, 'utf8');
}
