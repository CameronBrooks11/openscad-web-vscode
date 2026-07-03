# OpenSCAD Web Viewer (VS Code extension)

[![CI](https://github.com/CameronBrooks11/openscad-web-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/CameronBrooks11/openscad-web-vscode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CameronBrooks11/openscad-web-vscode?include_prereleases&label=release)](https://github.com/CameronBrooks11/openscad-web-vscode/releases)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

Preview OpenSCAD models inside a VS Code webview — render existing `.off` meshes,
and **compile multi-file `.scad` projects in the webview** via the openscad-web
WASM engine (**no native OpenSCAD install**). Powered by the standalone viewer +
session engine built in [**openscad-web**](https://github.com/CameronBrooks11/openscad-web).

> **Status.** The read-only OFF viewer and live `.scad` preview both work and are
> covered by Extension Development Host tests (message round-trip, protocol
> version pin, a real WASM cube→OFF compile inside the webview, the fix-on-save
> diagnostics loop, and an STL export byte round-trip). The preview **recompiles
> automatically on save** (`openscadWeb.compileTrigger`, set to `manual` to opt
> out), **compiler errors show as squiggles** in the Problems panel, the model
> **exports to STL/3MF/GLB/OFF** (2D: SVG/DXF) from the preview, and relative
> `import()`/`surface()` **assets are pushed with the project** (missing ones get
> a diagnostic). User library paths (OPENSCADPATH) remain — tracked by epic
> [#8](https://github.com/CameronBrooks11/openscad-web-vscode/issues/8).

## Install

Download the latest `openscad-web-vscode-*.vsix` from the
[**Releases**](https://github.com/CameronBrooks11/openscad-web-vscode/releases) page,
then either:

- **Extensions** view → **⋯** menu → **Install from VSIX…** → pick the file, or
- from the command line:

  ```bash
  code --install-extension openscad-web-vscode-<version>.vsix
  ```

Works in VS Code, VSCodium, and Cursor. Or [run it from source](#try-it-locally).

> **Not on the VS Code Marketplace yet** — distribution is via GitHub Releases for
> now. Marketplace / Open VSX publishing is planned once the project has a stable
> home.

## Commands

| Command                                            | What it does                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `OpenSCAD Viewer: Show Fixture Geometry`           | Opens the viewer on a bundled fixture cube.                                                                    |
| `OpenSCAD Viewer: Preview .off File`               | Opens the viewer on the active / selected `.off`.                                                              |
| `OpenSCAD Viewer: Preview .scad File`              | Compiles the active / selected `.scad` (+ its relative `use`/`include` closure) in the webview and renders it. |
| `OpenSCAD Viewer: Export Model (STL, 3MF, GLB, …)` | Exports the model (STL/3MF/GLB/OFF; SVG/DXF for 2D) at preview or full-render quality, via a save dialog.      |
| `OpenSCAD Viewer: Set Camera View`                 | Sets the camera (Front / Top / Diagonal / …).                                                                  |

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

## Try it locally

No Marketplace needed — two ways to run it from a clone (`media/viewer/` is
vendored, so there are no extra build steps):

**A — Extension Development Host (fastest):**

```bash
npm install
# open this folder in VS Code, press F5 → "Run Extension"
# in the new window: Command Palette → "OpenSCAD Viewer: Show Fixture Geometry"
```

**B — install the VSIX into your real VS Code:**

```bash
npm install
npm run package        # → openscad-web-vscode.vsix
code --install-extension openscad-web-vscode.vsix
# (just install-local does both)
```

Commands (Command Palette): _Show Fixture Geometry_, _Preview .off File_ (also on
the `.off` editor/explorer menu), and _Set Camera View_ (Front/Top/Diagonal/…).

## Develop

```bash
npm install
npm run compile
# then press F5 in VS Code → "Run Extension", run a command from the palette
```

- `npm run check` — format-check + lint + compile + unit tests + verify the
  vendored viewer.
- `npm test` — the EDH smoke test (use `xvfb-run -a npm test` on a headless Linux
  box). It asserts the message round-trip and tolerates GL-unavailable runners.
- A `justfile` mirrors these (`just setup`, `just check`, `just test`, …).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the host-neutral design
and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full dev loop.

## License

[GPL-3.0-or-later](LICENSE). The bundled viewer artifact under `media/viewer/`
originates from openscad-web (GPLv2-or-later source, distributed under GPLv3); see
that repo's `LICENSE.md`.
