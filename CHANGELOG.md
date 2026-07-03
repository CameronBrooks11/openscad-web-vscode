# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Render-quality exports** (openscad-web#219, vendored v0.3.3): the Export
  Model command now asks for quality — _Full render_ triggers a
  `$preview = false` render in the session first (the viewer shows it too),
  so models gating detail on `$preview` export their real geometry; _Preview
  mesh_ stays the fast path.

## [0.2.1] - 2026-07-03

### Changed

- Exports are now correlated with their results by a `requestId` the session
  echoes on every terminal of the operation (openscad-web#223) — replacing the
  artifact-format heuristic, so a superseded export's late terminal (success
  or failure) can never be attributed to the current request. Vendored session
  artifact bumped to openscad-web v0.3.2.

## [0.2.0] - 2026-07-03

The live-preview release: the `.scad` preview now recompiles on save with
inline compiler diagnostics, exports to STL/3MF/GLB/OFF (SVG/DXF for 2D), and
pushes relative `import()`/`surface()` assets with the project — on
openscad-web v0.3.1 (L1 protocol v2).

### Added

- **Export to disk** (epic #8 P6): _Export Model_ command — converts the
  current preview in the session (STL/3MF/GLB/OFF; SVG/DXF for 2D models via
  openscad-web's `export` wire command) and saves the exact bytes through a
  save dialog. Failures are explicit (`no-output` before a first compile,
  dimensionality mismatches); exports derive from preview-quality geometry
  (`$preview = true`) until openscad-web#219 lands.
- **Relative `import()`/`surface()` assets** (#9): the walker now discovers
  relative asset references and pushes their exact bytes with the project
  (openscad-web#172), so previews using STL/DXF/DAT/… assets work; a
  referenced-but-missing asset gets a squiggle on the referencing line instead
  of a bare engine failure.
- Vendored session artifact bumped to openscad-web v0.3.1 (L1 protocol **v2**:
  `export`, `getArtifact`, binary project files).

- **Live preview loop** (epic #8 P4): the `.scad` preview recompiles
  automatically when any `.scad` under the project root is saved or changes on
  disk (debounced; also catches external changes via a file watcher, e.g. a git
  checkout or creating a previously-missing dependency). Controlled by the new
  `openscadWeb.compileTrigger` setting (`onSave` default, `manual` to opt out).
  Closing the session panel stops the loop until the next manual preview.
- **Inline compiler diagnostics**: compile errors/warnings from the WASM engine
  land as squiggles + Problems-panel entries on the right files (engine `/home`
  paths are reverse-mapped to workspace URIs), replacing the coarse toast as the
  error surface. The walker's "import can't be previewed" issues are now
  per-line warnings on the offending directive instead of one aggregate toast.

### Changed

- Compile results are now correlated by the engine's `sourceRevision`, closing
  the common stale-settle races under rapid re-triggers (a small window remains
  when a compile is superseded before any of its results arrived; a full fix
  needs an upstream protocol ack).
- Save-triggered recompiles no longer reveal the session panel or touch focus;
  the manual command still reveals it, now without stealing editor focus.

## [0.1.0] - 2026-07-02

First public release — packaged `.vsix` distributed via GitHub Releases (not on
the VS Code Marketplace yet).

### Added

- **`.scad` compile-preview** (_Preview .scad File_ command + `.scad`
  editor/explorer menu): compiles a multi-file `.scad` project — the entry plus
  its transitive relative `use`/`include` closure — **in the webview** via the
  openscad-web WASM engine and renders it in-process, with **no native OpenSCAD
  install**. Covered end-to-end by an Extension Development Host test that
  compiles a real cube to an OFF artifact inside the webview.
- Compile session host (`sessionPanel.ts`) loading the vendored `session.html`
  under a compile-capable CSP, with the L1 session-protocol mirror
  (`sessionProtocol.ts`) read from the pinned `media/session/` manifest, a
  `ready` and version-skew guard, and supersession handling.
- Vendored, hash-verified session artifact under `media/session/`, with
  `sync-session` / `verify-session` scripts (analogs of the viewer scripts).
- Import-graph closure walker (`src/scad/importGraph.ts`): given an entry
  `.scad` + project root, it discovers the transitive set of relative
  `use`/`include` deps (ignoring comments/strings, libraries, and circular
  includes) and maps them to the engine's `/home` VFS, so the whole project can
  be pushed before a synchronous WASM compile. Pure + dependency-free, with
  `node:test` unit tests (`test:unit`). File reads prefer open editor buffers so
  the preview reflects unsaved edits.
- Initial scaffold: VS Code extension that embeds the openscad-web standalone
  viewer to preview OFF geometry.
- Commands: _Show Fixture Geometry_ and _Preview .off File_.
- Webview host with relative-base rewriting + strict CSP, and the L0 `ready`
  handshake with a manifest-pinned protocol-version check.
- Vendored, hash-verified viewer artifact under `media/viewer/`, with
  `sync-viewer` / `verify-viewer` scripts.
- Extension Development Host smoke test (message round-trip) and CI workflow.
- `vsce` packaging (`npm run package`) producing a verified VSIX.
- Extension icon + Marketplace metadata (keywords, gallery banner), a generated
  `icon.png` (`npm run make-icon`), and `just install-local` to build + install
  the VSIX into a local VS Code. "Try it locally" docs in the README.

### Fixed

- The bundled fixture (`Show Fixture Geometry`) failed to render — it used a
  canonical multi-line OFF header the viewer's parser then rejected. The fixture
  now uses the same-line header form, and the vendored viewer is re-synced to
  include the upstream OFF parser fix (so _Preview .off File_ also handles
  multi-line OFF files). The smoke test now requires the fixture to actually
  render rather than tolerating any error (which had masked this).

### Changed

- The viewer panel is now a single reusable instance: repeat opens reveal and
  re-drive the same panel instead of spawning new ones, re-feeding geometry,
  theme, and the last camera on every `ready` (incl. reveal-after-hidden).
- The scene background tracks the active VS Code theme (light / dark / high
  contrast) and updates live on theme change.
- Command _Set Camera View_ — a quick-pick of fit-aware named camera presets
  (Diagonal / Front / Right / Back / Left / Top / Bottom) via the L0
  `setNamedView` message, gated on the viewer advertising the capability.
