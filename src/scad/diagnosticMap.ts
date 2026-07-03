// Pure diagnostic-mapping layer for P4 (epic #8): turns the L1 result stream's
// 1-based, VFS-pathed `Diagnostic`s and the walker's `ImportIssue`s into
// host-neutral, 0-based, root-relative markers a VS Code adapter can materialize
// as `vscode.Diagnostic`s. Like the walker, this is `vscode`-free on purpose so
// the line/column/path arithmetic is unit-testable with plain fixtures.

import * as path from 'node:path';
import type { Diagnostic } from '../sessionProtocol';
import type { ImportIssue } from './importGraph';

/** The engine's project root in its virtual filesystem (mirror of importGraph). */
const VFS_ROOT = '/home';

/** A 0-based marker addressed relative to the project root.
 *  `relPath === null` means "the file is unknown — attach to the entry file". */
export interface FileMarker {
  relPath: string | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 0-based, end-exclusive (vscode.Range semantics). */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  source: string;
}

/** Map an engine VFS path back to a root-relative path — the inverse of the
 *  walker's `toVfs`. `/home/lib/a.scad` → `lib/a.scad`; anything not strictly
 *  under `/home` → `null` (unroutable). */
export function fromVfs(vfsPath: string): string | null {
  // posix.relative resolves a non-absolute argument against the process cwd —
  // never meaningful for a VFS path, so reject those outright.
  if (!path.posix.isAbsolute(vfsPath)) return null;
  const rel = path.posix.relative(VFS_ROOT, path.posix.normalize(vfsPath));
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/** Convert the L1 compile diagnostics (1-based lines/columns, ADR 0001) into
 *  0-based markers. Out-of-range positions clamp to 0; an end before the start
 *  collapses onto the start (VS Code renders it as a caret-width squiggle). */
export function markersFromDiagnostics(diagnostics: readonly Diagnostic[]): FileMarker[] {
  return diagnostics.map((d) => {
    const startLine = clamp0(d.startLineNumber);
    const startCol = clamp0(d.startColumn);
    let endLine = clamp0(d.endLineNumber);
    let endCol = clamp0(d.endColumn);
    if (endLine < startLine || (endLine === startLine && endCol < startCol)) {
      endLine = startLine;
      endCol = startCol;
    }
    return {
      relPath: d.path === undefined ? null : fromVfs(d.path),
      severity: d.severity,
      message: d.message,
      startLine,
      startCol,
      endLine,
      endCol,
      source: d.source ?? 'openscad',
    };
  });
}

/** Render the walker's non-fatal issues (deps that can't be previewed) as
 *  warnings on the directive's line. Column span is "whole line": 0 to a huge
 *  end column, which VS Code clamps to the actual line length. */
export function markersFromIssues(issues: readonly ImportIssue[]): FileMarker[] {
  return issues.map((i) => ({
    relPath: fromVfs(i.fromPath),
    severity: 'warning' as const,
    message: i.message,
    startLine: clamp0(i.line),
    startCol: 0,
    endLine: clamp0(i.line),
    endCol: Number.MAX_SAFE_INTEGER,
    source: 'openscad-web preview',
  }));
}

/** 1-based (possibly absent/garbage) → 0-based, never negative. */
function clamp0(oneBased: number): number {
  return Number.isFinite(oneBased) && oneBased > 1 ? Math.floor(oneBased) - 1 : 0;
}
