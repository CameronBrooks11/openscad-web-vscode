// Refresh the vendored session artifact from an openscad-web checkout.
//
//   npm run sync-session                        # uses ../openscad-web/dist-session
//   npm run sync-session -- /path/dist-session  # explicit source
//   OPENSCAD_WEB_SESSION=/path/dist-session npm run sync-session
//
// Build the source first in openscad-web:  npm run build:session
// After copying, the manifest is re-verified (sha256 + allowlist).
//
// The session artifact is the compile-capable sibling of dist-viewer: it carries
// the OpenSCAD WASM + worker + library zips, so it is large (~14 MB). It is loaded
// by sessionPanel.ts for live .scad compilation (epic #8). Never hand-edit
// media/session/ — re-vendor here.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const src = path.resolve(
  process.env.OPENSCAD_WEB_SESSION ?? process.argv[2] ?? '../openscad-web/dist-session',
);

if (!existsSync(path.join(src, 'session-manifest.json'))) {
  console.error(`[sync-session] no built session artifact at: ${src}`);
  console.error('  Build it first:  (cd ../openscad-web && npm run build:session)');
  console.error(
    '  Or point at one: OPENSCAD_WEB_SESSION=/abs/path/dist-session npm run sync-session',
  );
  process.exit(1);
}

const dest = path.resolve('media/session');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-session] copied ${src} -> ${dest}`);

execFileSync(process.execPath, ['scripts/verify-session-manifest.mjs'], { stdio: 'inherit' });
