import * as vscode from 'vscode';
import { ViewerPanel, type LoadOutcome } from './viewerPanel';
import { readFixtureOff } from './viewerArtifact';

/** The API the extension returns from `activate`, used by the EDH smoke test. */
export interface ExtensionApi {
  showFixture(): Promise<LoadOutcome>;
  /** Drive the viewer with arbitrary OFF text (used to exercise panel reuse). */
  showOff(offText: string, title: string): Promise<LoadOutcome>;
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
    // Live-sync the viewer background to the active VS Code theme.
    vscode.window.onDidChangeActiveColorTheme(() => ViewerPanel.applyTheme()),
  );

  return { showFixture, showOff };
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
