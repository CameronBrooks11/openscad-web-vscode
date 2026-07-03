import * as vscode from 'vscode';
import { ViewerPanel, type LoadOutcome } from './viewerPanel';
import {
  SessionPanel,
  type BootOutcome,
  type CompileOutcome,
  type ExportOutcome,
} from './sessionPanel';
import { readFixtureOff } from './viewerArtifact';
import { NAMED_VIEWS, type NamedView } from './protocol';
import type { ProjectFile, SessionExportFormat } from './sessionProtocol';
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
  /** Export the current preview and fetch the exact bytes (P6). `quality:
   *  'render'` runs a full ($preview=false) render first (#219). */
  exportSession(
    format: SessionExportFormat,
    quality?: 'preview' | 'render',
  ): Promise<ExportOutcome>;
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
    vscode.commands.registerCommand('openscadWebViewer.exportScad', async () => {
      if (!SessionPanel.hasPanel()) {
        void vscode.window.showWarningMessage(
          'Preview a .scad file first — the export converts the current preview.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'STL', description: 'triangle mesh (3D)', format: 'stl' as const },
          { label: '3MF', description: '3D manufacturing format', format: '3mf' as const },
          { label: 'GLB', description: 'binary glTF (3D)', format: 'glb' as const },
          { label: 'OFF', description: 'the preview mesh as-is (3D)', format: 'off' as const },
          { label: 'SVG', description: '2D models only', format: 'svg' as const },
          { label: 'DXF', description: '2D models only', format: 'dxf' as const },
        ],
        { placeHolder: 'Export the current preview as…' },
      );
      if (!pick) return;
      const qualityPick = await vscode.window.showQuickPick(
        [
          {
            label: 'Full render',
            description: 'accurate ($preview = false) — can take a while',
            quality: 'render' as const,
          },
          {
            label: 'Preview mesh',
            description: 'fast — exactly what the viewer currently shows',
            quality: 'preview' as const,
          },
        ],
        { placeHolder: 'Export quality' },
      );
      if (!qualityPick) return;
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Exporting ${pick.label}${qualityPick.quality === 'render' ? ' (full render)' : ''}…`,
          cancellable: true,
        },
        (_progress, token) =>
          Promise.race([
            SessionPanel.exportArtifact(pick.format, qualityPick.quality),
            // The wire op can't be aborted, but the user can walk away; a late
            // settle finds no consumer and is dropped harmlessly.
            new Promise<ExportOutcome>((resolve) =>
              token.onCancellationRequested(() => resolve({ ok: false, superseded: true })),
            ),
          ]),
      );
      if (!outcome.ok || !outcome.bytes) {
        // Superseded/user-cancelled exports end silently — only real failures toast.
        if (!outcome.superseded) {
          void vscode.window.showErrorMessage(`OpenSCAD export failed: ${outcome.error}`);
        }
        return;
      }
      const dir =
        triggers.activePreview?.root ??
        vscode.workspace.workspaceFolders?.[0]?.uri ??
        vscode.Uri.file('.');
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(dir, outcome.artifact?.name ?? `model.${pick.format}`),
        filters: { [pick.label]: [pick.format] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, outcome.bytes);
      void vscode.window.showInformationMessage(
        `Exported ${target.path.split('/').pop()} (${outcome.bytes.byteLength.toLocaleString()} bytes).`,
      );
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
    exportSession: (format, quality) => SessionPanel.exportArtifact(format, quality),
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
