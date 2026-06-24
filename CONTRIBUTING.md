# Contributing

Thanks for helping out. This is an early prototype VS Code extension that embeds
the [openscad-web](https://github.com/CameronBrooks11/openscad-web) viewer to
preview OFF geometry. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how
the pieces fit together, and [`AGENTS.md`](AGENTS.md) for the project boundaries.

## Prerequisites

- Node.js 24 (see `.nvmrc`) and npm.

## Dev loop

```bash
npm install
# open this folder in VS Code, press F5 → "Run Extension"
# in the new window: Command Palette → "OpenSCAD Viewer: Show Fixture Geometry"
```

## Checks

```bash
npm run check        # format-check + lint + compile + unit tests + verify vendored viewer
npm test             # Extension Development Host smoke test (xvfb-run -a npm test on headless Linux)
npm run test:unit    # fast Node unit tests only
```

A `justfile` mirrors these (`just setup`, `just check`, `just test`, …). Run
`npm run check` (and the smoke test) before opening a PR — CI runs the same.

## The vendored viewer

`media/viewer/` is a **pinned, committed** copy of openscad-web's `dist-viewer/`.
**Never hand-edit it.** To update it, build the artifact in a sibling
openscad-web checkout, then re-vendor:

```bash
(cd ../openscad-web && npm run build:viewer)
npm run sync-viewer   # copies dist-viewer/ -> media/viewer/ and re-verifies the manifest
```

## Commits & PRs

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`,
  imperative, ≤ 72 chars. One logical change per commit.
- Branch before editing; never bypass hooks or CI.
- `.scad` compile support is tracked separately by epic
  [#8](https://github.com/CameronBrooks11/openscad-web-vscode/issues/8).
