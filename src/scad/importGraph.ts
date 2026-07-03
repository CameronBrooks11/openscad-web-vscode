// Import-graph closure walker for OpenSCAD `.scad` projects.
//
// Given an entry file and a project root, it discovers the transitive set of
// *relative* `use`/`include` dependencies and maps them to the engine's `/home`
// virtual filesystem, so a host can PUSH the whole closure before compiling. The
// WASM filesystem is synchronous, so "the engine asks the host for a missing
// file" is impossible (see openscad-web#179) — the host must compute the closure
// up front. Library imports (BOSL2, MCAD, …) are left to the session, which
// mounts the bundled library zips.
//
// Pure and dependency-free (no `vscode`): it works in plain absolute POSIX path
// space over a minimal `ScadFs`, so it is unit-testable with an in-memory map.
// A VS Code adapter (backing `ScadFs` with `workspace.fs`) lands with the
// compile orchestration phase.
//
// Asset dependencies (#9): relative `import("x.stl")` / `surface("d.dat")`
// references are discovered too and pushed as binary `{path, bytes}` files
// (upstream #172); a referenced-but-missing asset surfaces as a diagnostic
// instead of a bare engine failure. Assets are found by scanning string
// literals with comments blanked — an `import("…")`-shaped string nested
// inside another string can produce a false missing-asset warning (harmless).
//
// Casing: paths map under the directive's LITERAL casing, which is
// self-consistent — the engine resolves exactly the string the directive
// contains, so on a case-insensitive host two casings of one file are pushed
// twice and BOTH spellings resolve in the case-sensitive `/home` VFS. (On a
// case-sensitive host different casings are genuinely different files.)

import * as path from 'node:path';

/** The engine's project root in its virtual filesystem. */
const VFS_ROOT = '/home';

// Mirrors OpenSCAD's directive grammar but captures the FULL bracket path (the
// engine's own regex keeps only the top segment for library detection). `\b`
// avoids matching identifiers like `reuse`.
const DIRECTIVE_RE = /\b(?:use|include)\s*<([^>]+)>/g;

// Relative asset references: `import("part.stl")` / `surface("map.dat")`, with
// the optional named form `import(file = "part.stl")`. Scanned with comments
// blanked but STRINGS KEPT (the path is the string).
const ASSET_RE = /\b(?:import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"]+)"/g;

/** The minimal filesystem the walker needs. `readFile` is `undefined` if absent. */
export interface ScadFs {
  /** Read a UTF-8 file by absolute POSIX path; `undefined` if it does not exist. */
  readFile(absPath: string): Promise<string | undefined>;
  /** Read a file's raw bytes by absolute POSIX path; `undefined` if absent. */
  readBytes(absPath: string): Promise<Uint8Array | undefined>;
}

/** A file to push into the engine VFS: editable text (`.scad` sources) or a
 *  binary asset's exact bytes (`import()`/`surface()` targets — #9/#172). */
export type ProjectFile =
  | { path: string; content: string; bytes?: never }
  | { path: string; bytes: Uint8Array; content?: never };

/** A non-fatal problem found while walking (surfaced as a diagnostic later). */
export interface ImportIssue {
  /** VFS path of the file containing the directive. */
  fromPath: string;
  /** The raw text inside the angle brackets / the asset path string. */
  spec: string;
  /** 1-based line of the directive within `fromPath`. */
  line: number;
  kind: 'escapes-root' | 'missing-asset';
  message: string;
}

export interface ImportClosure {
  /** The entry plus all transitive relative deps, mapped to `/home/…`, deduped. */
  files: ProjectFile[];
  /** The entry's VFS path, for `setProject`'s entryPoint. */
  entryPoint: string;
  /** Non-fatal issues (e.g. a dependency that escapes the project root). */
  issues: ImportIssue[];
}

/**
 * Walk the relative-import closure of `entryAbs` (an absolute POSIX path under
 * `rootAbs`). Both paths are real-filesystem paths; the returned `files` use the
 * engine VFS (`/home/<path-relative-to-root>`), preserving directory structure
 * so the engine's own relative `use`/`include` resolution works after the push.
 */
export async function walkImportGraph(
  fs: ScadFs,
  rootAbs: string,
  entryAbs: string,
): Promise<ImportClosure> {
  const root = stripTrailingSlash(path.posix.normalize(rootAbs));
  const entry = path.posix.normalize(entryAbs);

  const entryPoint = toVfs(root, entry);
  if (entryPoint === null) {
    throw new Error(`Entry file ${entry} is not under the project root ${root}`);
  }

  const files: ProjectFile[] = [];
  const issues: ImportIssue[] = [];
  const visited = new Set<string>();

  async function visit(abs: string): Promise<void> {
    const canonical = path.posix.normalize(abs);
    if (visited.has(canonical)) return;
    visited.add(canonical);

    const vfs = toVfs(root, canonical);
    if (vfs === null) return; // escapes root; callers already filter, defensive.

    const content = await fs.readFile(canonical);
    if (content === undefined) return; // missing under root → library or typo; the engine reports it.

    files.push({ path: vfs, content });

    const dir = path.posix.dirname(canonical);
    for (const { spec, line } of extractDirectives(content)) {
      const candidate = path.posix.resolve(dir, spec);
      if (toVfs(root, candidate) === null) {
        // Resolves outside the project root → can't be mapped under /home, so it
        // can't be previewed. Library specs like `BOSL2/std.scad` resolve UNDER
        // root and fall through to visit() below; only `..`-escaping or absolute
        // specs land here, and both deserve a diagnostic.
        issues.push({
          fromPath: vfs,
          spec,
          line,
          kind: 'escapes-root',
          message:
            `'${spec}' resolves outside the project root and can't be previewed` +
            (spec.includes('..') ? ' — open its top-level folder as the workspace root.' : '.'),
        });
        continue;
      }
      await visit(candidate); // recurses if it exists; no-ops if it's a library/missing.
    }

    // Asset references (#9): push each relative import()/surface() target's
    // bytes so the engine's synchronous FS finds it at compile time. Assets do
    // not recurse.
    for (const { spec, line } of extractAssetRefs(content)) {
      const candidate = path.posix.normalize(path.posix.resolve(dir, spec));
      const assetVfs = toVfs(root, candidate);
      if (assetVfs === null) {
        issues.push({
          fromPath: vfs,
          spec,
          line,
          kind: 'escapes-root',
          message:
            `'${spec}' resolves outside the project root and can't be previewed` +
            (spec.includes('..') ? ' — open its top-level folder as the workspace root.' : '.'),
        });
        continue;
      }
      if (visited.has(candidate)) continue; // already pushed (or is a walked source)
      visited.add(candidate);
      const bytes = await fs.readBytes(candidate);
      if (bytes === undefined) {
        issues.push({
          fromPath: vfs,
          spec,
          line,
          kind: 'missing-asset',
          message: `'${spec}' is referenced here but was not found — the preview's import will fail.`,
        });
        continue;
      }
      files.push({ path: assetVfs, bytes });
    }
  }

  await visit(entry);
  return { files, entryPoint, issues };
}

/** Map a real absolute path to the engine VFS, or `null` if it escapes `root`. */
function toVfs(root: string, abs: string): string | null {
  const rel = path.posix.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return path.posix.join(VFS_ROOT, rel);
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Extract `use`/`include` specs with 1-based line numbers, ignoring comments/strings. */
function extractDirectives(content: string): { spec: string; line: number }[] {
  return extract(blankNonCode(content, true), DIRECTIVE_RE);
}

/** Extract relative `import()`/`surface()` asset paths (#9), ignoring comments
 *  (strings are kept — the path IS the string). */
function extractAssetRefs(content: string): { spec: string; line: number }[] {
  return extract(blankNonCode(content, false), ASSET_RE);
}

function extract(code: string, re: RegExp): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1].trim();
    if (spec) out.push({ spec, line: lineAt(code, m.index) });
  }
  return out;
}

/**
 * Replace the contents of `//` / `/* *\/` comments — and, when `blankStrings`,
 * `"…"` strings — with spaces, preserving newlines and total length so offsets
 * and line numbers stay valid. Strings are always TRACKED (so `//` inside one
 * is not a comment) even when their content is kept.
 */
function blankNonCode(src: string, blankStrings: boolean): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        mode = 'line';
        out += '  ';
        i++;
      } else if (c === '/' && c2 === '*') {
        mode = 'block';
        out += '  ';
        i++;
      } else if (c === '"') {
        mode = 'string';
        out += blankStrings ? ' ' : '"';
      } else {
        out += c;
      }
    } else if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
    } else if (mode === 'block') {
      if (c === '*' && c2 === '/') {
        mode = 'code';
        out += '  ';
        i++;
      } else {
        out += c === '\n' ? '\n' : ' ';
      }
    } else {
      // string
      if (c === '\\' && c2) {
        out += blankStrings ? '  ' : c + c2;
        i++;
      } else if (c === '"') {
        mode = 'code';
        out += blankStrings ? ' ' : '"';
      } else if (blankStrings) {
        out += c === '\n' ? '\n' : ' ';
      } else {
        out += c;
      }
    }
  }
  return out;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
