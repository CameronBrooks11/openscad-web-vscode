// The VS Code half of P4 diagnostics: materializes the pure `FileMarker`s
// (src/scad/diagnosticMap.ts) into a `DiagnosticCollection`, resolving
// root-relative paths back to workspace URIs the same way the walker's FS
// adapter builds them (`root.with({ path })` — scheme/authority preserving, so
// remote and virtual workspaces route correctly too).

import * as path from 'node:path';
import * as vscode from 'vscode';
import { fromVfs, type FileMarker } from './scad/diagnosticMap';

const SEVERITY: Record<FileMarker['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class ScadDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('openscad-web');

  /**
   * Replace all published diagnostics with `markers` from one compile of the
   * project rooted at `root` with entry `entryVfsPath` (markers with no file —
   * `relPath === null` — attach to the entry). Replacing wholesale is right
   * here: the extension previews one project at a time, and a re-compile must
   * clear squiggles in files that are now clean.
   */
  publish(root: vscode.Uri, entryVfsPath: string, markers: readonly FileMarker[]): void {
    const byUri = new Map<string, { uri: vscode.Uri; diags: vscode.Diagnostic[] }>();
    const entryRel = fromVfs(entryVfsPath);
    // One compile fans out to a syntaxCheck AND a preview upstream, and both
    // parse markers from the same stderr — identical markers arrive twice at
    // the same revision, so dedup on the full identity before materializing.
    const seen = new Set<string>();
    for (const m of markers) {
      const rel = m.relPath ?? entryRel;
      if (rel === null) continue; // unroutable and no entry to pin it on
      const identity = JSON.stringify([
        rel,
        m.startLine,
        m.startCol,
        m.endLine,
        m.endCol,
        m.severity,
        m.message,
        m.source,
      ]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const uri = root.with({ path: path.posix.join(root.path, rel) });
      const key = uri.toString();
      let bucket = byUri.get(key);
      if (!bucket) {
        bucket = { uri, diags: [] };
        byUri.set(key, bucket);
      }
      const d = new vscode.Diagnostic(
        new vscode.Range(m.startLine, m.startCol, m.endLine, m.endCol),
        m.message,
        SEVERITY[m.severity],
      );
      d.source = m.source;
      bucket.diags.push(d);
    }
    this.collection.clear();
    for (const { uri, diags } of byUri.values()) this.collection.set(uri, diags);
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
