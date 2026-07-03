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

// Compile-capable session (epic #8 P2): boots `session.html` under the compile CSP
// (`wasm-unsafe-eval` + `worker-src blob:`) and completes the L1 handshake. This
// exercises the riskiest integration — the WASM engine + BrowserFS actually
// initialise in the webview — without needing WebGL (`ready` fires before any
// render). Compiling a project over the session is P3.
describe('OpenSCAD Web Session — EDH boot', () => {
  it('boots the compile-capable session webview and completes the L1 handshake', async function () {
    this.timeout(90_000); // cold WASM + BrowserFS init is slower than the L0 viewer.

    const ext = vscode.extensions.getExtension<ExtensionApi>('cameronbrooks11.openscad-web-vscode');
    assert.ok(ext, 'extension not found by id');

    const api = await ext.activate();
    assert.ok(typeof api.bootSession === 'function', 'extension API missing bootSession');

    const outcome = await api.bootSession();

    assert.strictEqual(
      outcome.ready,
      true,
      `session never signalled ready: ${outcome.error ?? '(no terminal outcome)'}`,
    );
    assert.strictEqual(
      outcome.protocolVersion,
      outcome.expectedProtocolVersion,
      'session/extension protocol version skew',
    );
  });

  // Compile orchestration (epic #8 P3): push a project and assert a real WASM
  // compile produces an OFF artifact — the direct analog of openscad-web's
  // session.spec.ts acceptance test, end-to-end through the extension's L1 plumbing.
  // GL-independent: the OFF artifact arrives from the WASM compile, before/regardless
  // of the embedded viewer's GL render. Exercises the openscad-web #203 fix: the
  // worker fetches its wasm/fonts/zip assets from main-thread-created blob: URLs,
  // since a blob worker can't fetch vscode-resource URLs in a webview.
  it('compiles a pushed .scad project to an OFF artifact', async function () {
    this.timeout(90_000); // boot (cold WASM) + compile.

    const ext = vscode.extensions.getExtension<ExtensionApi>('cameronbrooks11.openscad-web-vscode');
    assert.ok(ext, 'extension not found by id');

    const api = await ext.activate();
    assert.ok(typeof api.compileSession === 'function', 'extension API missing compileSession');

    const outcome = await api.compileSession(
      [{ path: '/home/main.scad', content: 'cube([10, 10, 10]);' }],
      '/home/main.scad',
    );

    assert.strictEqual(
      outcome.ready,
      true,
      `session never booted: ${outcome.error ?? '(no terminal outcome)'}`,
    );
    assert.strictEqual(
      outcome.compiled,
      true,
      `project did not compile: ${outcome.error ?? '(no terminal outcome)'}`,
    );
    assert.strictEqual(outcome.artifact?.format, 'off', 'compile produced no OFF artifact');
  });

  // Export over the wire (epic #8 P6): trigger a real STL conversion in the
  // session and fetch the exact bytes back through the REAL VS Code webview
  // channel — the end-to-end proof that typed arrays survive `postMessage`
  // in both directions (upstream #216 + #197).
  it('exports the compiled model as STL and receives the bytes', async function () {
    this.timeout(120_000); // conversion re-renders in the WASM worker.

    const ext = vscode.extensions.getExtension<ExtensionApi>('cameronbrooks11.openscad-web-vscode');
    assert.ok(ext, 'extension not found by id');
    const api = await ext.activate();
    assert.ok(typeof api.exportSession === 'function', 'extension API missing exportSession');

    // Ensure a compiled model exists (reuses the session panel from the P3 test).
    const compiled = await api.compileSession(
      [{ path: '/home/main.scad', content: 'cube([4, 4, 4]);' }],
      '/home/main.scad',
    );
    assert.strictEqual(compiled.compiled, true, `compile failed: ${compiled.error}`);

    const exported = await api.exportSession('stl');
    assert.strictEqual(exported.ok, true, `export failed: ${exported.error}`);
    assert.strictEqual(exported.artifact?.format, 'stl', 'export did not produce an STL');
    assert.ok(exported.bytes instanceof Uint8Array, 'bytes did not arrive as a Uint8Array');
    assert.ok(exported.bytes.byteLength > 0, 'exported STL is empty');

    // Render-quality export (#219 / openscad-web v0.3.3): a full $preview=false
    // render runs in the session first, then the conversion — end to end over
    // the real webview channel.
    const rendered = await api.exportSession('stl', 'render');
    assert.strictEqual(rendered.ok, true, `render-quality export failed: ${rendered.error}`);
    assert.strictEqual(rendered.artifact?.format, 'stl', 'no STL from the render-quality export');
    assert.ok(rendered.bytes!.byteLength > 0, 'render-quality STL is empty');
  });
});
