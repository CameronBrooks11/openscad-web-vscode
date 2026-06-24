// A `ScadFs` backed by `vscode.workspace.fs`, so the pure import-graph walker
// (src/scad/importGraph.ts) can read project files without depending on `vscode`.
//
// The walker works in POSIX path space (it drives off `Uri.path`, which is
// forward-slashed on every platform). `root.with({ path })` rebuilds a child URI
// from an absolute POSIX path while preserving the root's scheme + authority, so
// this also works in remote / virtual workspaces (not just `file:`).

import * as vscode from 'vscode';
import type { ScadFs } from './importGraph';

export function vscodeScadFs(root: vscode.Uri): ScadFs {
  const decoder = new TextDecoder();
  return {
    async readFile(absPath: string): Promise<string | undefined> {
      try {
        return decoder.decode(await vscode.workspace.fs.readFile(root.with({ path: absPath })));
      } catch {
        return undefined; // not found / unreadable → treat as absent (library or typo)
      }
    },
  };
}
