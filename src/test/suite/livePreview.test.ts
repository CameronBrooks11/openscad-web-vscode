import * as assert from 'assert';
import * as vscode from 'vscode';

// P4 (epic #8): inline compiler diagnostics + the on-save re-compile trigger,
// end-to-end through the REAL command path — workspace fixture → import-graph
// walker → session compile → published `DiagnosticCollection` — and then the
// save-triggered recompile clearing the squiggles once the source is fixed.
// The runner opens a fresh temp copy of test-fixtures/scad-project, whose
// main.scad ships with a syntax error (an unclosed `cube(` call).
describe('OpenSCAD live preview — P4 diagnostics + on-save trigger', () => {
  it('publishes compile diagnostics, then clears them via the on-save recompile', async function () {
    this.timeout(180_000); // cold WASM boot + two compiles.

    const ws = vscode.workspace.workspaceFolders?.[0];
    assert.ok(ws, 'fixture workspace not opened (runTest.ts should pass it in launchArgs)');
    const mainUri = vscode.Uri.joinPath(ws.uri, 'main.scad');

    // Manual preview of the broken entry. The command resolves only after the
    // compile settled and its markers were published.
    await vscode.commands.executeCommand('openscadWebViewer.previewScad', mainUri);

    const before = vscode.languages.getDiagnostics(mainUri);
    assert.ok(
      before.length > 0,
      'expected diagnostics on the broken main.scad after the manual preview',
    );
    assert.ok(
      before.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      `expected at least one error, got: ${before.map((d) => `${d.severity}:${d.message}`).join('; ')}`,
    );

    // Fix the file and save. The default `openscadWeb.compileTrigger: onSave`
    // must recompile (debounced) and replace the published diagnostics with
    // none — polling because the trigger pipeline is asynchronous end-to-end.
    const doc = await vscode.workspace.openTextDocument(mainUri);
    const editor = await vscode.window.showTextDocument(doc);
    const fixed = 'include <lib/box.scad>\ncube(box_size());\n';
    const all = new vscode.Range(0, 0, doc.lineCount, 0);
    const applied = await editor.edit((eb) => eb.replace(all, fixed));
    assert.ok(applied, 'workspace edit was not applied');
    assert.ok(await doc.save(), 'document did not save');

    const deadline = Date.now() + 120_000;
    while (vscode.languages.getDiagnostics(mainUri).length > 0) {
      if (Date.now() > deadline) {
        const left = vscode.languages
          .getDiagnostics(mainUri)
          .map((d) => d.message)
          .join('; ');
        assert.fail(`diagnostics were not cleared by the on-save recompile: ${left}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});
