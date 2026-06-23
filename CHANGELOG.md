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
