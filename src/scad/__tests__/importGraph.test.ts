import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkImportGraph, type ScadFs } from '../importGraph';

/** In-memory ScadFs keyed by absolute POSIX path. String values are text files;
 *  Uint8Array values are binary assets (readable only via readBytes). */
function fakeFs(files: Record<string, string | Uint8Array>): ScadFs {
  return {
    async readFile(p) {
      const v = Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined;
      return typeof v === 'string' ? v : undefined;
    },
    async readBytes(p) {
      const v = Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined;
      if (v instanceof Uint8Array) return v;
      return typeof v === 'string' ? Uint8Array.from(v, (c) => c.charCodeAt(0)) : undefined;
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

test('relative import()/surface() assets are pushed as bytes (#9)', async () => {
  const stl = Uint8Array.from([1, 2, 3, 4]);
  const dat = Uint8Array.from([53, 54]);
  const c = await walkImportGraph(
    fakeFs({
      '/proj/main.scad': 'import("assets/part.stl");\nsurface(file = "map.dat");',
      '/proj/assets/part.stl': stl,
      '/proj/map.dat': dat,
    }),
    '/proj',
    '/proj/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/assets/part.stl', '/home/main.scad', '/home/map.dat']);
  const asset = c.files.find((f) => f.path === '/home/assets/part.stl');
  assert.ok(asset && 'bytes' in asset && asset.bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(asset.bytes!), [1, 2, 3, 4]);
  assert.deepEqual(c.issues, []);
});

test('a missing asset surfaces a missing-asset issue with its line (#9)', async () => {
  const c = await walkImportGraph(
    fakeFs({ '/proj/main.scad': 'cube(1);\nimport("nope.stl");' }),
    '/proj',
    '/proj/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/main.scad']);
  assert.equal(c.issues.length, 1);
  assert.equal(c.issues[0].kind, 'missing-asset');
  assert.equal(c.issues[0].line, 2);
  assert.equal(c.issues[0].spec, 'nope.stl');
});

test('asset refs inside comments are ignored; ..-escaping assets are diagnosed', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/proj/sub/main.scad':
        '// import("ghost.stl")\n/* surface("g.dat") */\nimport("../../out.stl");',
    }),
    '/proj/sub',
    '/proj/sub/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/main.scad']);
  assert.equal(c.issues.length, 1);
  assert.equal(c.issues[0].kind, 'escapes-root');
  assert.equal(c.issues[0].spec, '../../out.stl');
});

test('an asset referenced from two files is pushed once', async () => {
  const c = await walkImportGraph(
    fakeFs({
      '/proj/main.scad': 'use <lib.scad>\nimport("p.stl");',
      '/proj/lib.scad': 'import("p.stl");',
      '/proj/p.stl': Uint8Array.from([9]),
    }),
    '/proj',
    '/proj/main.scad',
  );
  assert.deepEqual(vfsPaths(c), ['/home/lib.scad', '/home/main.scad', '/home/p.stl']);
});
