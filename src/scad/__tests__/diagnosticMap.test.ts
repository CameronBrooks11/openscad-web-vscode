import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromVfs, markersFromDiagnostics, markersFromIssues } from '../diagnosticMap';
import type { Diagnostic } from '../../sessionProtocol';
import type { ImportIssue } from '../importGraph';

const diag = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'error',
  message: 'boom',
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 9,
  ...overrides,
});

test('fromVfs inverts the walker mapping', () => {
  assert.equal(fromVfs('/home/main.scad'), 'main.scad');
  assert.equal(fromVfs('/home/lib/util.scad'), 'lib/util.scad');
  assert.equal(fromVfs('/home/a/../b.scad'), 'b.scad'); // normalized first
});

test('fromVfs rejects paths not strictly under /home', () => {
  assert.equal(fromVfs('/home'), null);
  assert.equal(fromVfs('/home/'), null);
  assert.equal(fromVfs('/etc/passwd'), null);
  assert.equal(fromVfs('/home/../etc/passwd'), null);
  assert.equal(fromVfs('/homely/x.scad'), null);
  assert.equal(fromVfs('relative.scad'), null);
});

test('markersFromDiagnostics converts 1-based to 0-based and routes by path', () => {
  const [m] = markersFromDiagnostics([diag({ path: '/home/lib/util.scad' })]);
  assert.equal(m.relPath, 'lib/util.scad');
  assert.equal(m.severity, 'error');
  assert.equal(m.message, 'boom');
  assert.deepEqual(
    { sl: m.startLine, sc: m.startCol, el: m.endLine, ec: m.endCol },
    { sl: 2, sc: 4, el: 2, ec: 8 },
  );
  assert.equal(m.source, 'openscad');
});

test('a pathless diagnostic maps to relPath null (attach to entry)', () => {
  const [m] = markersFromDiagnostics([diag()]);
  assert.equal(m.relPath, null);
});

test('an explicit source is preserved', () => {
  const [m] = markersFromDiagnostics([diag({ source: 'checker' })]);
  assert.equal(m.source, 'checker');
});

test('out-of-range positions clamp to 0', () => {
  const [m] = markersFromDiagnostics([
    diag({ startLineNumber: 0, startColumn: -3, endLineNumber: NaN, endColumn: 0 }),
  ]);
  assert.deepEqual(
    { sl: m.startLine, sc: m.startCol, el: m.endLine, ec: m.endCol },
    { sl: 0, sc: 0, el: 0, ec: 0 },
  );
});

test('an end before the start collapses onto the start', () => {
  const [m] = markersFromDiagnostics([
    diag({ startLineNumber: 7, startColumn: 10, endLineNumber: 7, endColumn: 2 }),
  ]);
  assert.deepEqual(
    { sl: m.startLine, sc: m.startCol, el: m.endLine, ec: m.endCol },
    { sl: 6, sc: 9, el: 6, ec: 9 },
  );
  const [n] = markersFromDiagnostics([
    diag({ startLineNumber: 7, startColumn: 1, endLineNumber: 4, endColumn: 5 }),
  ]);
  assert.deepEqual({ el: n.endLine, ec: n.endCol }, { el: 6, ec: 0 });
});

test('walker issues become whole-line warnings on the referencing file', () => {
  const issue: ImportIssue = {
    fromPath: '/home/sub/part.scad',
    spec: '../outside.scad',
    line: 12,
    kind: 'escapes-root',
    message: "'../outside.scad' resolves outside the project root and can't be previewed.",
  };
  const [m] = markersFromIssues([issue]);
  assert.equal(m.relPath, 'sub/part.scad');
  assert.equal(m.severity, 'warning');
  assert.equal(m.startLine, 11);
  assert.equal(m.endLine, 11);
  assert.equal(m.startCol, 0);
  assert.ok(m.endCol > 1_000_000); // whole-line span; the host clamps it
  assert.equal(m.source, 'openscad-web preview');
  assert.match(m.message, /outside the project root/);
});
