import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../extension';

// Extension Development Host smoke test. Asserts the L0 message *round-trip*, not
// pixels: ready handshake + version pin + a terminal geometry outcome. WebGL may
// be unavailable on a headless runner, so a clean `error` is an acceptable
// terminal outcome alongside `geometry-loaded`.
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
      outcome.loaded || Boolean(outcome.error),
      'no terminal geometry outcome (neither geometry-loaded nor error)',
    );
  });
});
