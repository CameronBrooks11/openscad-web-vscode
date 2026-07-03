# Project conventions — openscad-web-vscode

VS Code extension that embeds **openscad-web** artifacts in webviews: the
read-only viewer for OFF geometry (openscad-web epic #143) and the
compile-capable session for live `.scad` preview via the WASM engine (epic #8 /
openscad-web #179). No editor of its own.

## Boundaries

- The artifacts + their protocols come from openscad-web. This repo is a
  **consumer**: it vendors pinned copies of `dist-viewer/` → `media/viewer/`
  (L0) and `dist-session/` → `media/session/` (L1) and speaks their protocols.
- **Never hand-edit `media/viewer/` or `media/session/`** — they are verified
  artifacts. Update them only via `npm run sync-viewer` / `npm run sync-session`
  (which re-verify the manifests).
- The authoritative protocol contract is openscad-web
  `docs/EMBEDDING-VSCODE.md` + ADRs 0005/0009. Mirror, don't fork, the message
  shapes (`src/protocol.ts`, `src/sessionProtocol.ts`); pin the runtime version
  from the artifact manifest, never a hard-coded constant.
- `.scad` compilation happens ONLY inside the vendored session webview (WASM) —
  never by shelling out to a native OpenSCAD install (openscad-web #179).

## Workflow

- Conventional Commits (`type(scope): description`), imperative, ≤ 72 chars.
- Run `npm run check` (or `just check`) before every commit; `npm test` /
  `just test` for the EDH smoke test.
- Branch before editing; one logical change per commit.
- Minimal-first: no bundler / extra deps until publishing actually needs them.

## Layout

- `src/extension.ts` — activation, commands, the test-facing API.
- `src/viewerPanel.ts` / `src/sessionPanel.ts` — the webview hosts (L0 / L1).
- `src/protocol.ts` / `src/sessionProtocol.ts` — host-side protocol mirrors.
- `src/viewerArtifact.ts` / `src/sessionArtifact.ts` — vendored-artifact access.
- `src/scad/` — the pure import-graph walker + diagnostic mapping (no `vscode`).
- `src/scadPreview.ts` / `src/compileTrigger.ts` / `src/diagnostics.ts` — the
  live-preview flow, save/watcher triggers, and published diagnostics (P4).
- `src/test/` — `@vscode/test-electron` EDH tests; `test-fixtures/` — the
  workspace fixture they open (copied to a temp dir per run).
- `scripts/` — sync/verify scripts for both artifacts.
- `media/viewer/`, `media/session/` — vendored, pinned artifacts (do not edit).
- `media/fixtures/` — sample OFF geometry.
