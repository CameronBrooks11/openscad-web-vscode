import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkImportGraph, type ScadFs } from '../importGraph';

/** In-memory ScadFs keyed by absolute POSIX path. */
function fakeFs(files: Record<string, string>): ScadFs {
  return {
    async readFile(p) {
      return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined;
    },
  };
}

const vfsPaths = (c: { files: { path: string }[] }) => c.files.map((f) => f.path).sort();

test('single file with no imports → just the entry', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/proj/main.scad': 'cube(1);' }),
    '/proj',
    '/proj/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/main.scad']);
  assert.equal(c.entryPoint, '/home/main.scad');
  assert.deepEqual(c.issues, []);
});

test('relative use/include deps are pushed and recursed, structure preserved', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/proj/main.scad': 'use <lib/a.scad>\ninclude <sub/b.scad>',
      '/proj/lib/a.scad': '// a',
      '/proj/sub/b.scad': 'use <../lib/a.scad>', // shared, under root
    }),
    '/proj',
    '/proj/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/lib/a.scad', '/home/main.scad', '/home/sub/b.scad']);
  assert.deepEqual(c.issues, []);
});

test('transitive chain a → b → c', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/p/main.scad': 'include <a.scad>',
      '/p/a.scad': 'include <b.scad>',
      '/p/b.scad': 'cube(1);',
    }),
    '/p',
    '/p/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/a.scad', '/home/b.scad', '/home/main.scad']);
});

test('circular includes terminate and dedupe', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/p/a.scad': 'include <b.scad>',
      '/p/b.scad': 'include <a.scad>', // back-edge
    }),
    '/p',
    '/p/a.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/a.scad', '/home/b.scad']);
});

test('the same dep included twice is pushed once', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/p/m.scad': 'include <a.scad>\ninclude <a.scad>', '/p/a.scad': '// a' }),
    '/p',
    '/p/m.scad',
  );
  assert.equal(c.files.filter((f) => f.path === '/home/a.scad').length, 1);
});

test('library refs not in the workspace are not pushed and raise no issue', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/p/m.scad': 'use <BOSL2/std.scad>\ninclude <MCAD/gears.scad>\ncube(1);' }),
    '/p',
    '/p/m.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/m.scad']);
  assert.deepEqual(c.issues, []);
});

test('a local folder shadowing a library name IS pushed (matches OpenSCAD relative-first)', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/p/m.scad': 'use <MCAD/gears.scad>', '/p/MCAD/gears.scad': '// local override' }),
    '/p',
    '/p/m.scad',
  );
  assert.ok(c.files.some((f) => f.path === '/home/MCAD/gears.scad'));
});

test('../ escaping the root → escapes-root issue, not pushed', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/proj/models/main.scad': 'include <../../common/x.scad>' }),
    '/proj/models',
    '/proj/models/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/main.scad']);
  assert.equal(c.issues.length, 1);
  assert.equal(c.issues[0].kind, 'escapes-root');
  assert.equal(c.issues[0].spec, '../../common/x.scad');
  assert.equal(c.issues[0].fromPath, '/home/main.scad');
  assert.equal(c.issues[0].line, 1);
});

test('an absolute spec escaping the root is diagnosed too (not only ..)', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/p/m.scad': 'include </usr/share/x.scad>' }),
    '/p',
    '/p/m.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/m.scad']);
  assert.equal(c.issues.length, 1);
  assert.equal(c.issues[0].kind, 'escapes-root');
  assert.equal(c.issues[0].spec, '/usr/share/x.scad');
});

test('../ staying under a wider root is fine', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/proj/models/main.scad': 'include <../shared/x.scad>',
      '/proj/shared/x.scad': 'cube(1);',
    }),
    '/proj', // wider root makes the ../ legal
    '/proj/models/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/models/main.scad', '/home/shared/x.scad']);
  assert.deepEqual(c.issues, []);
});

test('directives inside comments and strings are ignored', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/p/m.scad': [
        '// include <commented.scad>',
        '/* include <blockcommented.scad> */',
        'echo("include <stringy.scad>");',
        'include <real.scad>',
      ].join('\n'),
      '/p/real.scad': 'cube(1);',
      '/p/commented.scad': '//',
      '/p/blockcommented.scad': '//',
      '/p/stringy.scad': '//',
    }),
    '/p',
    '/p/m.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/m.scad', '/home/real.scad']);
});

test('line numbers for issues are reported correctly', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/p/sub/m.scad': '\n\ncube(1);\ninclude <../../outside.scad>' }),
    '/p/sub',
    '/p/sub/m.scad',
  );
  assert.equal(c.issues.length, 1);
  assert.equal(c.issues[0].line, 4);
});

test('throws when the entry is not under the root', async () => {
  await assert.rejects(
    () => walkImportGraph(fakeFs({ '/other/m.scad': '//' }), '/proj', '/other/m.scad'),
    /not under the project root/,
  );
});

test('use with no space and spaces inside the bracket parse', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/p/m.scad': 'use<a.scad>\ninclude < b.scad >',
      '/p/a.scad': '//',
      '/p/b.scad': '//',
    }),
    '/p',
    '/p/m.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/a.scad', '/home/b.scad', '/home/m.scad']);
});
