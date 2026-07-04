// Walks the user's configured library directories (`openscadWeb.libraryPaths`)
// into the session's `SessionLibrary[]` payload (upstream #195 / ADR 0010).
// Each TOP-LEVEL directory under a configured path becomes one library whose
// name is the directory name — exactly the `use <Name/…>` token. Text-suffix
// files ship as content (the walker validates UTF-8 so one bad file can't
// reject the whole wire push), everything else as bytes. Oversized or invalid
// entries are skipped with a warning, never poison.
//
// Forward-compatibility note (ADR 0010): when the OpenSCAD project's library
// manager materializes, its resolved installs become ANOTHER producer of the
// same payload — this walker stays for plain directories; a manager
// integration would only add a second source.

import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  SESSION_LIBRARY_NAME_RE,
  SESSION_RESERVED_LIBRARY_NAMES,
  type SessionLibrary,
  type SessionLibraryFile,
} from '../sessionProtocol';

/** Mirrors of the wire budgets (upstream SESSION_MAX_*): skip-and-warn here
 *  beats an atomic wire rejection there. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_FILES = 2048; // wire cap across ALL libraries — skip-and-warn here

const TEXT_EXTENSIONS = new Set([
  'scad',
  'txt',
  'text',
  'csv',
  'json',
  'svg',
  'md',
  'xml',
  'yaml',
  'yml',
  'ini',
  'cfg',
  'log',
]);

export interface LibraryWalkResult {
  libraries: SessionLibrary[];
  /** Human-readable skip/validation warnings (surfaced once per walk). */
  warnings: string[];
}

/** Resolve a configured path against the workspace (absolute paths pass
 *  through; relative ones resolve against the first workspace folder). */
export function resolveLibraryRoot(configured: string): vscode.Uri | undefined {
  if (configured === '~' || configured.startsWith('~/')) {
    return vscode.Uri.file(`${os.homedir()}${configured.slice(1)}`);
  }
  if (configured.startsWith('/') || /^[A-Za-z]:[/\\]/.test(configured)) {
    return vscode.Uri.file(configured);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, configured) : undefined;
}

/** Walk every configured root: each top-level directory = one library. */
export async function walkLibraryPaths(configured: string[]): Promise<LibraryWalkResult> {
  const libraries = new Map<string, SessionLibrary>();
  const warnings: string[] = [];
  let total = 0;
  const fileBudget = { remaining: MAX_TOTAL_FILES, warned: false };

  for (const entry of configured) {
    const root = resolveLibraryRoot(entry);
    if (!root) {
      warnings.push(`library path '${entry}' could not be resolved (no workspace folder)`);
      continue;
    }
    let children: [string, vscode.FileType][];
    try {
      children = await vscode.workspace.fs.readDirectory(root);
    } catch {
      warnings.push(`library path '${entry}' is not readable`);
      continue;
    }
    for (const [name, type] of children) {
      if ((type & vscode.FileType.Directory) === 0) continue; // libraries are dirs
      if ((type & vscode.FileType.SymbolicLink) !== 0) {
        // Not followed: a symlink cycle would recurse forever, and vscode.fs
        // gives no realpath to guard with. Warn — a symlinked library layout
        // is common enough that silence would read as a broken feature.
        warnings.push(`library '${name}' skipped: symbolic link (not followed)`);
        continue;
      }
      if (name.startsWith('.')) continue; // .git at a repo root is not a library
      if (!SESSION_LIBRARY_NAME_RE.test(name) || SESSION_RESERVED_LIBRARY_NAMES.has(name)) {
        warnings.push(`library '${name}' skipped: not a safe library name`);
        continue;
      }
      if (libraries.has(name)) {
        warnings.push(`library '${name}' skipped: an earlier path already provides it`);
        continue;
      }
      const files: SessionLibraryFile[] = [];
      const collected = await collectFiles(
        vscode.Uri.joinPath(root, name),
        '',
        files,
        total + name.length, // the wire counts names toward the budget too
        warnings,
        name,
        fileBudget,
      );
      total = collected;
      if (files.length > 0) libraries.set(name, { name, files });
    }
  }
  return { libraries: [...libraries.values()], warnings };
}

async function collectFiles(
  dir: vscode.Uri,
  rel: string,
  out: SessionLibraryFile[],
  total: number,
  warnings: string[],
  libName: string,
  fileBudget: { remaining: number; warned: boolean },
): Promise<number> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return total;
  }
  for (const [name, type] of entries) {
    if (name.startsWith('.')) continue; // .git and friends
    const childRel = rel ? `${rel}/${name}` : name;
    const child = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.Directory) {
      total = await collectFiles(child, childRel, out, total, warnings, libName, fileBudget);
      continue;
    }
    if (type !== vscode.FileType.File) continue; // symlinks etc. are skipped
    if (fileBudget.remaining <= 0) {
      if (!fileBudget.warned) {
        fileBudget.warned = true;
        warnings.push(
          `library file limit reached (${MAX_TOTAL_FILES} across all libraries) — remaining files skipped`,
        );
      }
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(child);
    } catch {
      warnings.push(`${libName}/${childRel} skipped: unreadable`);
      continue;
    }
    // The wire budget counts payload + path lengths; UTF-8 byteLength for text
    // over-counts vs the wire's UTF-16 units — conservative by design.
    const cost = bytes.byteLength + childRel.length;
    if (bytes.byteLength > MAX_FILE_BYTES || total + cost > MAX_TOTAL_BYTES) {
      warnings.push(`${libName}/${childRel} skipped: over the size budget`);
      continue;
    }
    const dot = childRel.lastIndexOf('.');
    const ext = dot >= 0 ? childRel.slice(dot + 1).toLowerCase() : '';
    if (TEXT_EXTENSIONS.has(ext)) {
      // Ship text as content, validated here — one invalid-UTF-8 file must
      // warn-and-skip, not atomically reject the whole wire push.
      try {
        out.push({
          path: childRel,
          content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        });
      } catch {
        warnings.push(`${libName}/${childRel} skipped: text extension but not valid UTF-8`);
        continue;
      }
    } else {
      out.push({ path: childRel, bytes });
    }
    fileBudget.remaining -= 1;
    total += cost;
  }
  return total;
}
