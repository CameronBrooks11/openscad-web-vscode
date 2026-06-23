# Project conventions — openscad-web-vscode

VS Code extension that embeds the **openscad-web** standalone viewer to preview
OFF geometry. Read-only viewer (Phase 1 of openscad-web epic #143). No `.scad`
compile, no WASM, no editor.

## Boundaries

- The viewer + its L0 protocol come from openscad-web. This repo is a **consumer**:
  it vendors a pinned `dist-viewer/` into `media/viewer/` and speaks the protocol.
- **Never hand-edit `media/viewer/`** — it is a verified artifact. Update it only
  via `npm run sync-viewer` (which re-verifies the manifest).
- The authoritative protocol contract is openscad-web
  `docs/EMBEDDING-VSCODE.md` + ADR 0005. Mirror, don't fork, its message shapes
  (`src/protocol.ts`); pin the runtime version from the artifact manifest, never a
  hard-coded constant.
- Keep zero coupling to `.scad` compilation — that belongs to the future
  live-session work (openscad-web #179), a different artifact.

## Workflow

- Conventional Commits (`type(scope): description`), imperative, ≤ 72 chars.
- Run `npm run check` (or `just check`) before every commit; `npm test` /
  `just test` for the EDH smoke test.
- Branch before editing; one logical change per commit.
- Minimal-first: no bundler / extra deps until publishing actually needs them.

## Layout

- `src/extension.ts` — activation, commands, the test-facing API.
- `src/viewerPanel.ts` — the webview host + L0 handshake.
- `src/protocol.ts` — host-side mirror of the L0 message shapes.
- `src/viewerArtifact.ts` — access to `media/viewer/` + its manifest.
- `src/test/` — `@vscode/test-electron` smoke test (round-trip, not pixels).
- `scripts/` — `sync-viewer.mjs`, `verify-viewer-manifest.mjs`.
- `media/viewer/` — the vendored, pinned viewer artifact (do not edit).
- `media/fixtures/` — sample OFF geometry.
