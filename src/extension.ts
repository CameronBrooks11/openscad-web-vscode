import * as vscode from 'vscode';
import { ViewerPanel, type LoadOutcome } from './viewerPanel';
import { SessionPanel, type BootOutcome, type CompileOutcome } from './sessionPanel';
import { readFixtureOff } from './viewerArtifact';
import { NAMED_VIEWS, type NamedView } from './protocol';
import type { ProjectFile } from './sessionProtocol';
import { ScadDiagnostics } from './diagnostics';
import { CompileTriggerController } from './compileTrigger';
import { isPreviewableScad, runScadPreview } from './scadPreview';

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

  // P4: compiler markers as squiggles + the save/watcher re-compile loop. The
  // triggers re-run the same quiet preview flow and re-track, so the watched
  // closure follows the project as imports are added/removed.
  const diagnostics = new ScadDiagnostics();
  const triggers = new CompileTriggerController(async (entry) => {
    const preview = await runScadPreview(context, diagnostics, entry, { quiet: true });
    if (preview) triggers.track(preview);
  });

  context.subscriptions.push(
    diagnostics,
    triggers,
    // Closing the session panel ends the live preview: stale squiggles would
    // otherwise outlive the geometry they describe.
    SessionPanel.onDidDispose(() => {
      diagnostics.clear();
      triggers.clear();
    }),
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
      if (!isPreviewableScad(entry)) {
        void vscode.window.showWarningMessage('Open or select a saved .scad file to preview.');
        return;
      }
      const preview = await runScadPreview(context, diagnostics, entry, { quiet: false });
      if (preview) triggers.track(preview);
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
