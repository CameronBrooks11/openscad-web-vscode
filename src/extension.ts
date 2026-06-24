import * as vscode from 'vscode';
import { ViewerPanel, type LoadOutcome } from './viewerPanel';
import { SessionPanel, type BootOutcome, type CompileOutcome } from './sessionPanel';
import { readFixtureOff } from './viewerArtifact';
import { NAMED_VIEWS, type NamedView } from './protocol';
import type { ProjectFile } from './sessionProtocol';
import { walkImportGraph } from './scad/importGraph';
import { vscodeScadFs } from './scad/vscodeFs';

/** The API the extension returns from `activate`, used by the EDH smoke test. */
export interface ExtensionApi {
  showFixture(): Promise<LoadOutcome>;
  /** Drive the viewer with arbitrary OFF text (used to exercise panel reuse). */
  showOff(offText: string, title: string): Promise<LoadOutcome>;
  /** Apply a fit-aware named camera view; resolves true once acked. */
  setView(view: NamedView): Promise<boolean>;
  /** Boot the compile-capable session webview and await its L1 `ready` handshake. */
  bootSession(): Promise<BootOutcome>;
  /** Push a project to the session and await the terminal compile outcome (P3). */
  compileSession(files: ProjectFile[], entryPoint?: string): Promise<CompileOutcome>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const showFixture = () =>
    ViewerPanel.show(context, readFixtureOff(context.extensionUri), 'fixture cube');
  const showOff = (offText: string, title: string) => ViewerPanel.show(context, offText, title);

  context.subscriptions.push(
    vscode.commands.registerCommand('openscadWebViewer.showFixture', async () => {
      report(await showFixture());
    }),
    vscode.commands.registerCommand('openscadWebViewer.openOffFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage('Open or select a .off file to preview.');
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(target);
      const name = target.path.split('/').pop() ?? 'geometry';
      report(await ViewerPanel.show(context, new TextDecoder().decode(bytes), name));
    }),
    vscode.commands.registerCommand('openscadWebViewer.previewScad', async (uri?: vscode.Uri) => {
      const entry = uri ?? vscode.window.activeTextEditor?.document.uri;
      // Require a saved `.scad` on a real filesystem: the walker needs a workspace
      // root + readable paths, and `setProject` an entry it can find. (Guards a
      // palette invocation over a non-.scad or untitled editor — which would
      // otherwise walk arbitrary text and stall on a missing entry.)
      if (!entry || entry.scheme !== 'file' || !entry.path.toLowerCase().endsWith('.scad')) {
        void vscode.window.showWarningMessage('Open or select a saved .scad file to preview.');
        return;
      }
      // Closure root: the entry's workspace folder, else its own directory. The
      // walker maps everything under root into the engine's `/home` VFS.
      const root =
        vscode.workspace.getWorkspaceFolder(entry)?.uri ?? vscode.Uri.joinPath(entry, '..');
      let closure;
      try {
        closure = await walkImportGraph(vscodeScadFs(root), root.path, entry.path);
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not resolve .scad imports: ${asMessage(e)}`);
        return;
      }
      // Surface unpreviewable deps (escapes-root) as a single warning; details P4.
      if (closure.issues.length > 0) {
        const specs = [...new Set(closure.issues.map((i) => i.spec))].join(', ');
        void vscode.window.showWarningMessage(
          `OpenSCAD: ${closure.issues.length} import(s) can't be previewed (outside the project root): ${specs}`,
        );
      }
      reportCompile(await SessionPanel.compile(context, closure.files, closure.entryPoint));
    }),
    vscode.commands.registerCommand('openscadWebViewer.setView', async () => {
      if (!ViewerPanel.hasPanel()) {
        void vscode.window.showWarningMessage('Open a model in the OpenSCAD viewer first.');
        return;
      }
      const view = (await vscode.window.showQuickPick([...NAMED_VIEWS], {
        placeHolder: 'Set camera view',
      })) as NamedView | undefined;
      if (view) void ViewerPanel.applyNamedView(view);
    }),
    // Live-sync the viewer background to the active VS Code theme.
    vscode.window.onDidChangeActiveColorTheme(() => ViewerPanel.applyTheme()),
  );

  return {
    showFixture,
    showOff,
    setView: (view) => ViewerPanel.applyNamedView(view),
    bootSession: () => SessionPanel.boot(context),
    compileSession: (files, entryPoint) => SessionPanel.compile(context, files, entryPoint),
  };
}

export function deactivate(): void {
  // Nothing to tear down: VS Code disposes extension-owned webview panels
  // automatically when the window closes or the user dismisses them.
}

function report(outcome: LoadOutcome): void {
  if (outcome.closedByUser) {
    return; // user dismissed the panel before it loaded — not an error.
  }
  if (!outcome.ready) {
    void vscode.window.showErrorMessage('OpenSCAD viewer did not initialize.');
  } else if (outcome.protocolVersion !== outcome.expectedProtocolVersion) {
    void vscode.window.showErrorMessage(
      `OpenSCAD viewer protocol mismatch: artifact expects v${outcome.expectedProtocolVersion}, ` +
        `viewer reported v${outcome.protocolVersion}. Re-sync the vendored viewer.`,
    );
  } else if (outcome.error) {
    void vscode.window.showWarningMessage(`Geometry not rendered (${outcome.error}).`);
  } else if (outcome.loaded) {
    void vscode.window.showInformationMessage('OpenSCAD geometry rendered.');
  }
}

function reportCompile(outcome: CompileOutcome): void {
  if (outcome.closedByUser || outcome.superseded) {
    return; // dismissed, or replaced by a newer preview — neither is a failure.
  }
  if (!outcome.ready) {
    // A failed/skewed boot carries its reason (incl. protocol-version mismatch).
    void vscode.window.showErrorMessage(outcome.error ?? 'OpenSCAD session did not initialize.');
  } else if (outcome.compiled) {
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
