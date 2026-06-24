import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../extension';

// Extension Development Host smoke test. Asserts the L0 message round-trip AND
// that the bundled fixture actually renders (`geometry-loaded`) — headless CI has
// WebGL via SwiftShader (xvfb + --enable-unsafe-swiftshader). Requiring a real
// load is deliberate: tolerating any `error` previously masked a malformed fixture
// (a `render-error` looked the same as a GL failure).
describe('OpenSCAD Web Viewer — EDH smoke', () => {
  it('activates and round-trips the fixture OFF through the webview', async function () {
    this.timeout(60_000);

    const ext = vscode.extensions.getExtension<ExtensionApi>('cameronbrooks11.openscad-web-vscode');
    assert.ok(ext, 'extension not found by id');

    const api = await ext.activate();
    assert.ok(typeof api.showFixture === 'function', 'extension API missing showFixture');

    const outcome = await api.showFixture();

    assert.strictEqual(outcome.ready, true, 'viewer never signalled ready');
    assert.strictEqual(
      outcome.protocolVersion,
      outcome.expectedProtocolVersion,
      'viewer/extension protocol version skew',
    );
    assert.ok(
      outcome.loaded,
      `fixture did not render: ${outcome.error ?? '(no terminal outcome)'}`,
    );

    // Reuse path: a second open with *different* geometry must reveal + re-drive
    // the same panel and render, not hang on the already-live webview. This
    // tetrahedron uses the canonical multi-line OFF header, so it also exercises
    // the parser fix end-to-end through the re-vendored viewer.
    const tetrahedron = [
      'OFF',
      '4 4 6',
      '0 0 0',
      '1 0 0',
      '0 1 0',
      '0 0 1',
      '3 0 1 2',
      '3 0 1 3',
      '3 0 2 3',
      '3 1 2 3',
      '',
    ].join('\n');
    const reuse = await api.showOff(tetrahedron, 'tetrahedron');
    assert.strictEqual(reuse.ready, true, 'reused panel never signalled ready');
    assert.ok(
      reuse.loaded,
      `reused panel did not render: ${reuse.error ?? '(no terminal outcome)'}`,
    );

    // Camera preset: a fit-aware named view round-trips through the L0
    // `setNamedView` message and is acked (no WebGL needed — it's a camera op).
    const applied = await api.setView('Top');
    assert.strictEqual(applied, true, 'setNamedView was not acked by the viewer');
  });
});
