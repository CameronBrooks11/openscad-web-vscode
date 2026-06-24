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
// Known limitations (tracked for follow-up):
//   - Only `use`/`include` directives are followed. Relative `import("x.stl")` /
//     `surface("d.dat")` asset dependencies are NOT discovered, so a project
//     that imports such assets compiles in the openscad-web app but not here.
//     Binary assets also need the text-only project contract to gain binary
//     support upstream (openscad-web#172).
//   - Path mapping uses the directive's literal casing. On a case-insensitive
//     host (Windows/macOS) this can push two casings of one file into the
//     case-sensitive `/home` VFS; canonicalize against disk before shipping there.

import * as path from 'node:path';

/** The engine's project root in its virtual filesystem. */
const VFS_ROOT = '/home';

// Mirrors OpenSCAD's directive grammar but captures the FULL bracket path (the
// engine's own regex keeps only the top segment for library detection). `\b`
// avoids matching identifiers like `reuse`.
const DIRECTIVE_RE = /\b(?:use|include)\s*<([^>]+)>/g;

/** The minimal filesystem the walker needs. `readFile` is `undefined` if absent. */
export interface ScadFs {
  /** Read a UTF-8 file by absolute POSIX path; `undefined` if it does not exist. */
  readFile(absPath: string): Promise<string | undefined>;
}

/** A file to push into the engine VFS. */
export interface ProjectFile {
  /** Engine VFS path, e.g. `/home/src/main.scad`. */
  path: string;
  content: string;
}

/** A non-fatal problem found while walking (surfaced as a diagnostic later). */
export interface ImportIssue {
  /** VFS path of the file containing the directive. */
  fromPath: string;
  /** The raw text inside the angle brackets. */
  spec: string;
  /** 1-based line of the directive within `fromPath`. */
  line: number;
  kind: 'escapes-root';
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
  const code = blankCommentsAndStrings(content);
  const out: { spec: string; line: number }[] = [];
  DIRECTIVE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIRECTIVE_RE.exec(code)) !== null) {
    const spec = m[1].trim();
    if (spec) out.push({ spec, line: lineAt(code, m.index) });
  }
  return out;
}

/**
 * Replace the contents of `//` / `/* *\/` comments and `"…"` strings with spaces,
 * preserving newlines and total length so directive offsets/line numbers stay
 * valid. Avoids matching a `use`/`include` that appears inside a comment/string.
 */
function blankCommentsAndStrings(src: string): string {
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
        out += ' ';
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
        out += '  ';
        i++;
      } else if (c === '"') {
        mode = 'code';
        out += ' ';
      } else {
        out += c === '\n' ? '\n' : ' ';
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
