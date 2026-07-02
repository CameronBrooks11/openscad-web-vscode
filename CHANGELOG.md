# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-02

First Marketplace release.

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
