// Verify the vendored viewer artifact (media/viewer/) against its own manifest:
// every shipped file is present, on the allowlist, and matches its size + SHA-256;
// the manifest declares a numeric protocolVersion. Run in `npm run check` and CI
// so a corrupt / partial / tampered vendor copy fails loudly, not at runtime.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('media/viewer');
const manifestPath = path.join(dir, 'viewer-manifest.json');

if (!existsSync(manifestPath)) {
  console.error(
    '[verify-viewer] no media/viewer/viewer-manifest.json — run `npm run sync-viewer`.',
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const onAllowlist = (rel) =>
  manifest.allowlist.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

let errors = 0;
const fail = (m) => {
  console.error(`[verify-viewer] ${m}`);
  errors++;
};

for (const [rel, meta] of Object.entries(manifest.files)) {
  const file = path.join(dir, rel);
  if (!existsSync(file)) {
    fail(`missing file: ${rel}`);
    continue;
  }
  const buf = readFileSync(file);
  if (buf.length !== meta.bytes) fail(`size mismatch: ${rel} (${buf.length} != ${meta.bytes})`);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== meta.sha256) fail(`sha256 mismatch: ${rel}`);
  if (!onAllowlist(rel)) fail(`not on allowlist: ${rel}`);
}

if (typeof manifest.protocolVersion !== 'number') fail('manifest.protocolVersion is not a number');

if (errors > 0) {
  console.error(`[verify-viewer] FAILED with ${errors} error(s).`);
  process.exit(1);
}

console.log(
  `[verify-viewer] OK — viewer v${manifest.viewerVersion}, protocol v${manifest.protocolVersion}, ` +
    `${Object.keys(manifest.files).length} files verified (source ${manifest.sourceCommit}).`,
);
