# Architecture

This extension is a **consumer** of the [openscad-web](https://github.com/CameronBrooks11/openscad-web)
standalone viewer. It contains no OpenSCAD compiler, no WASM, and no editor — it
hosts a vendored copy of the viewer in a VS Code webview and talks to it over a
small message protocol. Today it renders **read-only OFF geometry**.

## The consumer relationship to openscad-web

openscad-web builds a self-contained viewer artifact (`dist-viewer/`). This repo
vendors a **pinned, committed** copy of that artifact into `media/viewer/`:

```
openscad-web ──(npm run build:viewer)──▶ dist-viewer/ ──(npm run sync-viewer)──▶ media/viewer/
   viewer.html + assets/ + protocol/ + viewer-manifest.json (per-file SHA-256, protocolVersion)
```

- `media/viewer/` is **never hand-edited**. It is re-vendored via
  `npm run sync-viewer` and verified against its own manifest by
  `npm run verify-viewer` (run in `npm run check` and CI).
- The runtime protocol version is read **from the manifest**, never hard-coded —
  the host asserts the viewer's reported `protocolVersion` matches the pin.

## Host / viewer separation (the L0 protocol)

The webview is the "viewer host". The extension host and the embedded viewer
communicate over openscad-web's **Layer-0 (L0)** message protocol:

1. The extension loads `media/viewer/viewer.html` into a webview, rewriting the
   artifact's relative `./assets/` URLs to the webview resource root and applying
   a strict CSP (no `wasm-unsafe-eval` — there is no WASM).
2. Handshake: wait for the viewer's `ready`, assert its `protocolVersion`, then
   push settings + geometry and await `geometry-loaded` (or `error`).
3. The viewer auto-selects its VS Code webview transport when `acquireVsCodeApi`
   is present.

Code map:

- `src/extension.ts` — activation, commands, test-facing API.
- `src/viewerPanel.ts` — the webview host + L0 handshake.
- `src/protocol.ts` — host-side mirror of the L0 message shapes (mirror, don't
  fork, openscad-web's shapes).
- `src/viewerArtifact.ts` — access to `media/viewer/` + its manifest.

The authoritative integration contract is openscad-web
[`docs/EMBEDDING-VSCODE.md`](https://github.com/CameronBrooks11/openscad-web/blob/main/docs/EMBEDDING-VSCODE.md)
(plus ADR 0005, the host transport protocol).

## Where `.scad` preview is headed

Live `.scad` preview — compiling OpenSCAD to geometry **inside** the webview —
is planned in epic
[#8](https://github.com/CameronBrooks11/openscad-web-vscode/issues/8). It is a
separate, heavier artifact (WASM + a worker) and is intentionally **not** coupled
to the read-only viewer above. Early host-side groundwork (resolving a `.scad`
file's `include`/`use` closure) lives in `src/scad/` (e.g. `importGraph.ts`).
Until #8 lands, this extension stays a read-only OFF viewer.
