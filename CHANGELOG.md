# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial scaffold: VS Code extension that embeds the openscad-web standalone
  viewer to preview OFF geometry.
- Commands: _Show Fixture Geometry_ and _Preview .off File_.
- Webview host with relative-base rewriting + strict CSP, and the L0 `ready`
  handshake with a manifest-pinned protocol-version check.
- Vendored, hash-verified viewer artifact under `media/viewer/`, with
  `sync-viewer` / `verify-viewer` scripts.
- Extension Development Host smoke test (message round-trip) and CI workflow.
- `vsce` packaging (`npm run package`) producing a verified VSIX.

### Changed

- The viewer panel is now a single reusable instance: repeat opens reveal and
  re-drive the same panel instead of spawning new ones, re-feeding geometry,
  theme, and the last camera on every `ready` (incl. reveal-after-hidden).
- The scene background tracks the active VS Code theme (light / dark / high
  contrast) and updates live on theme change.
- Command _Set Camera View_ — a quick-pick of fit-aware named camera presets
  (Diagonal / Front / Right / Back / Left / Top / Bottom) via the L0
  `setNamedView` message, gated on the viewer advertising the capability.
