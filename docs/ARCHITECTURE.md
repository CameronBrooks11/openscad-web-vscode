# Architecture

This extension is a **consumer** of the
[openscad-web](https://github.com/CameronBrooks11/openscad-web) artifacts. It
contains no OpenSCAD compiler of its own and no editor — it hosts vendored,
hash-verified copies of two openscad-web distributables in VS Code webviews and
talks to them over versioned message protocols:

- **`media/viewer/`** — the read-only **OFF viewer** (~0.6 MB; Layer-0/L0
  protocol). Renders existing `.off` meshes. No WASM.
- **`media/session/`** — the compile-capable **session** (~20 MB; Layer-1/L1
  protocol). Runs the OpenSCAD WASM engine + an embedded viewer in ONE webview:
  live multi-file `.scad` preview, inline diagnostics, exports, and runtime
  user libraries — with **no native OpenSCAD install**.

## The consumer relationship to openscad-web

openscad-web builds both artifacts; this repo vendors **pinned, committed**
copies:

```
openscad-web ──(build:viewer)──▶ dist-viewer/  ──(sync-viewer)──▶  media/viewer/
openscad-web ──(build:session)─▶ dist-session/ ──(sync-session)─▶ media/session/
```

- Vendored artifacts are **never hand-edited**; they are re-vendored via the
  sync scripts and verified against their own manifests (per-file SHA-256,
  `protocolVersion`, source commit) by `npm run check` and CI.
- Runtime protocol versions are read **from the manifests**, never hard-coded;
  the host asserts the artifact's reported version on `ready`. Additive
  protocol features are feature-detected via `ready.capabilities`.

## The session tier (L1) — how live preview works

1. `sessionPanel.ts` loads `media/session/session.html` under a compile-capable
   CSP (`wasm-unsafe-eval` + `worker-src blob:`); `retainContextWhenHidden`
   keeps the WASM engine alive when the panel is hidden.
2. The WASM filesystem is **synchronous**, so the engine can never ask the host
   for a missing file: the host walks the entry's `use`/`include` closure and
   relative `import()`/`surface()` assets (`src/scad/importGraph.ts`, pure and
   unit-tested) and PUSHES the whole project via `setProject` — text as
   content, assets as bytes.
3. Every push carries a `requestId`; the session's `project-ack` binds the
   compile waiter to that push's assigned `sourceRevision`, and results are
   accepted only at exactly that revision (no correlation heuristics).
4. Geometry renders **in-process** in the session's embedded viewer — it never
   crosses the wire for display. Bytes cross in exactly three places: project
   asset bytes in (`setProject`), library file bytes in (`setLibraries`), and
   artifact bytes out (`getArtifact`, for export-to-disk).
5. Compiler markers stream back on the results and are reverse-mapped from the
   engine's `/home` paths to workspace URIs (`src/scad/diagnosticMap.ts` →
   `src/diagnostics.ts`) as squiggles/Problems entries.
6. On-save + file-watcher triggers (`src/compileTrigger.ts`) re-run the shared
   walk-then-compile flow (`src/scadPreview.ts`), debounced and quiet.
7. Exports (`Export Model` command) optionally run a full `$preview = false`
   render, then convert and fetch the exact bytes over the wire for a save
   dialog.
8. User libraries (`openscadWeb.libraryPaths`): `src/scad/libraryWalker.ts`
   walks each configured directory (top-level dir = one library) into the
   session's `setLibraries` payload; the panel re-pushes the set before the
   project on every `ready`, and a user library fully shadows a bundled one of
   the same name.

## Code map

- `src/extension.ts` — activation, commands, settings sync, test-facing API.
- `src/viewerPanel.ts` / `src/protocol.ts` / `src/viewerArtifact.ts` — the L0
  read-only viewer host, protocol mirror, artifact access.
- `src/sessionPanel.ts` / `src/sessionProtocol.ts` / `src/sessionArtifact.ts` —
  the L1 session host (boot/compile/render/export/library waiters), protocol
  mirror, artifact access.
- `src/scad/` — pure, `vscode`-free logic: `importGraph.ts` (closure walker),
  `diagnosticMap.ts` (marker mapping); plus the thin adapters `vscodeFs.ts`
  and `libraryWalker.ts`.
- `src/scadPreview.ts` / `src/compileTrigger.ts` / `src/diagnostics.ts` — the
  live-preview flow, triggers, and published diagnostics.
- `src/test/` — Extension Development Host tests (real webview + real WASM:
  compile, diagnostics loop, both export qualities, user libraries);
  `test-fixtures/` is copied to a temp workspace per run.

The authoritative integration contract is openscad-web
[`docs/EMBEDDING-VSCODE.md`](https://github.com/CameronBrooks11/openscad-web/blob/main/docs/EMBEDDING-VSCODE.md)
(plus ADRs 0005/0009/0010). Mirror, don't fork, its message shapes.
