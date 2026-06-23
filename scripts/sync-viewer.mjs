// Refresh the vendored viewer artifact from an openscad-web checkout.
//
//   npm run sync-viewer                       # uses ../openscad-web/dist-viewer
//   npm run sync-viewer -- /path/dist-viewer  # explicit source
//   OPENSCAD_WEB_DIST=/path/dist-viewer npm run sync-viewer
//
// Build the source first in openscad-web:  npm run build:viewer
// After copying, the manifest is re-verified (sha256 + allowlist).

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const src = path.resolve(
  process.env.OPENSCAD_WEB_DIST ?? process.argv[2] ?? '../openscad-web/dist-viewer',
);

if (!existsSync(path.join(src, 'viewer-manifest.json'))) {
  console.error(`[sync-viewer] no built viewer artifact at: ${src}`);
  console.error('  Build it first:  (cd ../openscad-web && npm run build:viewer)');
  console.error('  Or point at one: OPENSCAD_WEB_DIST=/abs/path/dist-viewer npm run sync-viewer');
  process.exit(1);
}

const dest = path.resolve('media/viewer');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-viewer] copied ${src} -> ${dest}`);

execFileSync(process.execPath, ['scripts/verify-viewer-manifest.mjs'], { stdio: 'inherit' });
