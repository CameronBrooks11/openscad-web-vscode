// P4 trigger controller: keeps the active `.scad` preview live by recompiling
// when project files change — on editor save (the primary path) and via a
// `FileSystemWatcher` for changes that arrive outside the editor (git checkout,
// codegen, creating a previously-missing dep). Both funnel into one trailing
// debounce, so a save that also fires the watcher compiles once.
//
// Trigger condition: any `.scad` under the active preview's root. Deliberately
// broader than "in the walked closure": a file that is referenced but missing
// (or newly referenced by an unsaved edit) is not IN the closure yet, and those
// are exactly the saves that should un-break the preview. The cost — a spurious
// debounced recompile when an unrelated `.scad` in the same root is saved — is
// bounded by supersession in the session panel.

import * as vscode from 'vscode';
import { SessionPanel } from './sessionPanel';
import type { ActivePreview } from './scadPreview';

const DEBOUNCE_MS = 300;

export type CompileTriggerMode = 'onSave' | 'manual';

function triggerMode(): CompileTriggerMode {
  return vscode.workspace
    .getConfiguration('openscadWeb')
    .get<CompileTriggerMode>('compileTrigger', 'onSave');
}

export class CompileTriggerController implements vscode.Disposable {
  private active?: ActivePreview;
  private watcher?: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly saveListener: vscode.Disposable;

  constructor(private readonly recompile: (entry: vscode.Uri) => Promise<unknown>) {
    this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => this.onFsEvent(doc.uri));
  }

  /** The preview currently being kept live, if any (used by export's save
   *  dialog to default to the project directory). */
  get activePreview(): ActivePreview | undefined {
    return this.active;
  }

  /** Adopt `preview` as the live one (called after every successful preview,
   *  manual or triggered), re-arming the watcher when the root changed. */
  track(preview: ActivePreview): void {
    const rootChanged = this.active?.root.toString() !== preview.root.toString();
    this.active = preview;
    if (!rootChanged) return;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(preview.root, '**/*.scad'),
    );
    this.watcher.onDidChange((uri) => this.onFsEvent(uri));
    this.watcher.onDidCreate((uri) => this.onFsEvent(uri));
    this.watcher.onDidDelete((uri) => this.onFsEvent(uri));
  }

  /** Stop triggering (the session panel is gone). The next manual preview
   *  re-tracks — closing the panel is how the user opts out of auto-preview. */
  clear(): void {
    this.active = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onFsEvent(uri: vscode.Uri): void {
    const active = this.active;
    if (!active || !SessionPanel.hasPanel()) return;
    if (triggerMode() !== 'onSave') return;
    if (!uri.path.toLowerCase().endsWith('.scad')) return;
    if (!isUnder(active.root, uri)) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Re-check at fire time — the panel may have been closed (or the trigger
      // switched to manual) mid-debounce, and recompiling would be unwanted.
      if (!this.active || !SessionPanel.hasPanel()) return;
      if (triggerMode() !== 'onSave') return;
      void this.recompile(this.active.entry);
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    this.saveListener.dispose();
    this.clear();
  }
}

function isUnder(root: vscode.Uri, uri: vscode.Uri): boolean {
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) return false;
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
  return uri.path.startsWith(prefix);
}
