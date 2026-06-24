// Verify the vendored session artifact (media/session/) against its own manifest:
// every shipped file is present, on the allowlist, and matches its size + SHA-256;
// the manifest declares a numeric protocolVersion. Run in `npm run check` and CI
// so a corrupt / partial / tampered vendor copy fails loudly, not at runtime.
// Mirror of verify-viewer-manifest.mjs (the session artifact just carries more —
// the WASM + library zips — so the integrity check matters more).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('media/session');
const manifestPath = path.join(dir, 'session-manifest.json');

if (!existsSync(manifestPath)) {
  console.error(
    '[verify-session] no media/session/session-manifest.json — run `npm run sync-session`.',
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const onAllowlist = (rel) =>
  manifest.allowlist.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

let errors = 0;
const fail = (m) => {
  console.error(`[verify-session] ${m}`);
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
  console.error(`[verify-session] FAILED with ${errors} error(s).`);
  process.exit(1);
}

console.log(
  `[verify-session] OK — session v${manifest.sessionVersion}, protocol v${manifest.protocolVersion}, ` +
    `${Object.keys(manifest.files).length} files verified (source ${manifest.sourceCommit}).`,
);
