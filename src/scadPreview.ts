// The shared walk-then-compile flow behind the `.scad` preview: used by the
// manual `previewScad` command AND the P4 save/watcher triggers, so both paths
// stay behaviorally identical (same root selection, same closure walk, same
// diagnostics publication). Split out of extension.ts when P4 grew a second
// caller.

import * as vscode from 'vscode';
import { SessionPanel, type CompileOutcome } from './sessionPanel';
import { walkImportGraph } from './scad/importGraph';
import { vscodeScadFs } from './scad/vscodeFs';
import { markersFromDiagnostics, markersFromIssues } from './scad/diagnosticMap';
import type { ScadDiagnostics } from './diagnostics';

/** The preview the trigger controller keeps live: what to recompile, and the
 *  project root whose `.scad` saves/changes should trigger it. */
export interface ActivePreview {
  entry: vscode.Uri;
  root: vscode.Uri;
}

/** The `previewScad` entry guard: a saved `.scad` on a real filesystem — the
 *  walker needs a workspace root + readable paths, and `setProject` an entry it
 *  can find. (Guards a palette invocation over a non-.scad/untitled editor.) */
export function isPreviewableScad(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined && uri.scheme === 'file' && uri.path.toLowerCase().endsWith('.scad');
}

/**
 * Walk `entry`'s import closure, compile it in the session webview, and publish
 * the resulting markers (engine diagnostics + the walker's unpreviewable-import
 * issues) as squiggles. `quiet` is the trigger mode: no outcome toasts — the
 * rendered geometry and the diagnostics ARE the feedback — except boot failures,
 * which squiggles cannot convey.
 *
 * Returns the preview handle for trigger tracking ONLY when this compile ran to
 * a real termination — `undefined` for a failed walk, a superseded/abandoned
 * compile, or a dead/failed panel, none of which may (re-)claim tracking.
 */
export async function runScadPreview(
  context: vscode.ExtensionContext,
  diagnostics: ScadDiagnostics,
  entry: vscode.Uri,
  opts: { quiet: boolean },
): Promise<ActivePreview | undefined> {
  // Closure root: the entry's workspace folder, else its own directory. The
  // walker maps everything under root into the engine's `/home` VFS.
  const root = vscode.workspace.getWorkspaceFolder(entry)?.uri ?? vscode.Uri.joinPath(entry, '..');
  let closure;
  try {
    closure = await walkImportGraph(vscodeScadFs(root), root.path, entry.path);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not resolve .scad imports: ${asMessage(e)}`);
    return undefined;
  }

  // A triggered compile must never RE-CREATE the panel — closing it is how the
  // user opts out of the loop, and the panel could have been closed during the
  // (async) walk above. This check runs synchronously before compile()'s own
  // panel lookup, so there is no further window.
  if (opts.quiet && !SessionPanel.hasPanel()) return undefined;

  const outcome = await SessionPanel.compile(
    context,
    closure.files,
    closure.entryPoint,
    /* reveal */ !opts.quiet,
  );
  if (outcome.superseded || outcome.closedByUser) {
    // Superseded: a newer compile owns the squiggles and the tracking. Closed:
    // the dispose listener cleared both. Either way this preview must NOT be
    // (re-)tracked — that would undo clear() or steal tracking back from the
    // preview that superseded it.
    return undefined;
  }
  if (!outcome.ready) {
    // Boot failure: the panel already tore itself down (and the dispose
    // listener cleaned up), so don't publish markers nothing will ever clear.
    reportCompile(outcome, opts.quiet);
    return undefined;
  }
  // A failure that produced no markers (timeout, engine-level error) must not
  // wipe the previous compile's squiggles with an empty publish — and it needs
  // a toast even in quiet mode, since there is no other feedback that the
  // preview is now stale.
  const markerlessFailure = !outcome.compiled && outcome.diagnostics.length === 0;
  if (!markerlessFailure) {
    diagnostics.publish(root, closure.entryPoint, [
      ...markersFromDiagnostics(outcome.diagnostics),
      ...markersFromIssues(closure.issues),
    ]);
  }
  reportCompile(outcome, opts.quiet && !markerlessFailure);
  return { entry, root };
}

function reportCompile(outcome: CompileOutcome, quiet: boolean): void {
  if (!outcome.ready) {
    // A failed/skewed boot carries its reason (incl. protocol-version mismatch).
    // Always toast: a broken session means saves silently stop previewing.
    void vscode.window.showErrorMessage(outcome.error ?? 'OpenSCAD session did not initialize.');
    return;
  }
  if (quiet) return;
  if (outcome.compiled) {
    void vscode.window.showInformationMessage('OpenSCAD model compiled.');
  } else if (outcome.error) {
    void vscode.window.showErrorMessage(`OpenSCAD compile failed: ${outcome.error}`);
  } else {
    void vscode.window.showWarningMessage('OpenSCAD: no compile result.');
  }
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
