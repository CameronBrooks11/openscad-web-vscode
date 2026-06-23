# OpenSCAD Web Viewer (VS Code extension)

Preview OpenSCAD geometry (`.off` meshes) inside a VS Code webview, powered by the
standalone viewer built in [**openscad-web**](https://github.com/CameronBrooks11/openscad-web).

This is the **read-only viewer** extension — Phase 1 of the
[read-only VS Code viewer epic](https://github.com/CameronBrooks11/openscad-web/issues/143).
It renders existing OFF geometry; it does **not** compile `.scad` (that is a later,
separate milestone). It contains no OpenSCAD WASM, no editor, and no compiler — it
embeds the openscad-web viewer artifact and speaks its Layer-0 (L0) message
protocol.

> Status: **scaffold**. Commands work; the geometry round-trip + version pin are
> wired and covered by an Extension Development Host smoke test.

## Commands

| Command                                  | What it does                                      |
| ---------------------------------------- | ------------------------------------------------- |
| `OpenSCAD Viewer: Show Fixture Geometry` | Opens the viewer on a bundled fixture cube.       |
| `OpenSCAD Viewer: Preview .off File`     | Opens the viewer on the active / selected `.off`. |

## How it works

```
openscad-web  ──(npm run build:viewer)──▶  dist-viewer/   ──(npm run sync-viewer)──▶  media/viewer/
   viewer.html + assets + protocol/ + viewer-manifest.json (hashed, version-pinned)
```

- The extension host loads `media/viewer/viewer.html` into a webview, rewriting the
  artifact's relative `./assets/` URLs to the webview resource root via a
  `<base href>` and applying a strict CSP (no `wasm-unsafe-eval` — the viewer has
  no WASM). See [`src/viewerPanel.ts`](src/viewerPanel.ts).
- The viewer auto-selects its **VS Code webview transport** when `acquireVsCodeApi`
  is present (nothing to configure here).
- The L0 handshake: wait for the viewer's `ready`, assert its `protocolVersion`
  equals the version **pinned in the vendored `viewer-manifest.json`**, then push
  settings + geometry and await `geometry-loaded` (or `error`).

The full integration contract lives in openscad-web:
[`docs/EMBEDDING-VSCODE.md`](https://github.com/CameronBrooks11/openscad-web/blob/main/docs/EMBEDDING-VSCODE.md).

## The vendored viewer artifact

`media/viewer/` is a **pinned, committed** copy of openscad-web's `dist-viewer/`,
verified against its own `viewer-manifest.json` (per-file SHA-256 + allowlist +
`protocolVersion`). Never edit it by hand. To update it:

```bash
# in a sibling openscad-web checkout
(cd ../openscad-web && npm run build:viewer)

# back here
npm run sync-viewer          # copies dist-viewer/ -> media/viewer/ and verifies
# or: OPENSCAD_WEB_DIST=/abs/path/openscad-web/dist-viewer npm run sync-viewer
```

`npm run verify-viewer` (part of `npm run check` and CI) re-checks the vendored
copy against its manifest.

## Develop

```bash
npm install
npm run compile
# then press F5 in VS Code → "Run Extension", run a command from the palette
```

- `npm run check` — format-check + lint + compile + verify the vendored viewer.
- `npm test` — the EDH smoke test (use `xvfb-run -a npm test` on a headless Linux
  box). It asserts the message round-trip and tolerates GL-unavailable runners.
- A `justfile` mirrors these (`just setup`, `just check`, `just test`, …).

## License

[GPL-3.0-or-later](LICENSE). The bundled viewer artifact under `media/viewer/`
originates from openscad-web (GPLv2-or-later source, distributed under GPLv3); see
that repo's `LICENSE.md`.
