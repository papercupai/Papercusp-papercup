import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkInstalledPatchPostimages,
  parsePatchPostimages,
} from './check-installed-patch-postimages.mjs';

function makeFixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'papercusp-patch-postimage-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repoRoot]);
  execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Patch test']);
  execFileSync('git', [
    '-C',
    repoRoot,
    'config',
    'user.email',
    'patch-test@example.invalid',
  ]);

  const patchPath = 'patches/example+1.0.0.patch';
  const customPatchPath =
    'vendor-patches/gitnexus-vendor+1.6.9-embedding-upsert.patch';
  const targetPath = 'node_modules/example/index.js';
  const patchFile = join(repoRoot, patchPath);
  const customPatchFile = join(repoRoot, customPatchPath);
  const targetFile = join(repoRoot, targetPath);
  mkdirSync(join(repoRoot, 'patches'), { recursive: true });
  mkdirSync(join(repoRoot, 'vendor-patches'), { recursive: true });
  mkdirSync(join(targetFile, '..'), { recursive: true });
  writeFileSync(targetFile, 'before\n');
  const oldHash = execFileSync('git', [
    '-C',
    repoRoot,
    'hash-object',
    targetFile,
  ], { encoding: 'utf8' }).trim();
  writeFileSync(targetFile, 'after\n');
  const postHash = execFileSync('git', [
    '-C',
    repoRoot,
    'hash-object',
    targetFile,
  ], { encoding: 'utf8' }).trim();
  const patchSource = [
    'diff --git a/node_modules/example/index.js b/node_modules/example/index.js',
    'index ' + oldHash + '..' + postHash + ' 100644',
    '--- a/node_modules/example/index.js',
    '+++ b/node_modules/example/index.js',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
  ].join('\n');
  writeFileSync(patchFile, patchSource);
  writeFileSync(
    customPatchFile,
    [
      '--- a/dist/core/embeddings/embedding-pipeline.js',
      '+++ b/dist/core/embeddings/embedding-pipeline.js',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n'),
  );
  execFileSync('git', [
    '-C',
    repoRoot,
    'add',
    '--',
    patchPath,
    customPatchPath,
    targetPath,
  ]);
  execFileSync('git', [
    '-C',
    repoRoot,
    '-c',
    'user.name=Patch test',
    '-c',
    'user.email=patch-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'patch fixture',
  ]);

  return { repoRoot, patchFile, patchPath, patchSource, targetFile, targetPath };
}

test('parses one committed postimage per diff block', () => {
  const parsed = parsePatchPostimages([
    'diff --git a/node_modules/example/a.js b/node_modules/example/a.js',
    'index 1234567..abcdef0 100644',
    '--- a/node_modules/example/a.js',
    '+++ b/node_modules/example/a.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
    'diff --git a/node_modules/example/b.js b/node_modules/example/b.js',
    'index 1234567..fedcba0 100644',
    '--- a/node_modules/example/b.js',
    '+++ b/node_modules/example/b.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [
    { path: 'node_modules/example/a.js', hash: 'abcdef0' },
    { path: 'node_modules/example/b.js', hash: 'fedcba0' },
  ]);
});

test('requires an index postimage hash for every patched file', () => {
  assert.throws(
    () =>
      parsePatchPostimages([
        'diff --git a/node_modules/example/index.js b/node_modules/example/index.js',
        '--- a/node_modules/example/index.js',
        '+++ b/node_modules/example/index.js',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'), 'patches/no-index.patch'),
    /missing Git index postimage hash/,
  );
});

test('runs the postimage check immediately after patch-package in root postinstall', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.match(
    packageJson.scripts.postinstall,
    /patch-package && node scripts\/check-installed-patch-postimages\.mjs$/,
  );
});

test('accepts installed blobs matching tracked HEAD postimages', (t) => {
  const fixture = makeFixture(t);
  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.checked, 1);
  assert.deepEqual(result.errors, []);
});

test('rejects an installed blob that differs from the committed postimage', (t) => {
  const fixture = makeFixture(t);
  writeFileSync(fixture.targetFile, 'locally patched\n');

  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /node_modules\/example\/index\.js/);
  assert.match(result.errors.join('\n'), /does not match committed postimage/);
});

test('rejects dirty patch sources that package install could have applied', (t) => {
  const fixture = makeFixture(t);
  writeFileSync(fixture.patchFile, fixture.patchSource + '# local patch edit\n');

  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /patch sources differ from HEAD/);
  assert.match(result.errors.join('\n'), /patches\/example\+1\.0\.0\.patch/);
});

test('rejects untracked patch-package inputs', (t) => {
  const fixture = makeFixture(t);
  writeFileSync(
    join(fixture.repoRoot, 'patches', 'local+1.0.0.patch'),
    [
      'diff --git a/node_modules/local/index.js b/node_modules/local/index.js',
      '--- a/node_modules/local/index.js',
      '+++ b/node_modules/local/index.js',
      '',
    ].join('\n'),
  );

  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /untracked patch-package inputs/);
  assert.match(result.errors.join('\n'), /local\+1\.0\.0\.patch/);
});

const VENDOR_STYLE_PATCH = [
  '--- a/dist/core/index.js',
  '+++ b/dist/core/index.js',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n');

// WI-10006890: patch-package refuses (fatally under CI=true) a patches/ entry whose package is
// absent from node_modules, so an out-of-repo vendor patch there breaks every CI `npm ci`.
test('rejects a tracked patch under patches/ with no node_modules target', (t) => {
  const fixture = makeFixture(t);
  const vendorPath = 'patches/vendored+1.0.0.patch';
  writeFileSync(join(fixture.repoRoot, vendorPath), VENDOR_STYLE_PATCH);
  execFileSync('git', ['-C', fixture.repoRoot, 'add', '--', vendorPath]);
  execFileSync('git', [
    '-C',
    fixture.repoRoot,
    '-c',
    'user.name=Patch test',
    '-c',
    'user.email=patch-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'vendor patch in patches/',
  ]);

  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /no node_modules\/ target/);
  assert.match(result.errors.join('\n'), /vendored\+1\.0\.0\.patch/);
});

test('rejects an untracked patch under patches/ with no node_modules target', (t) => {
  const fixture = makeFixture(t);
  writeFileSync(join(fixture.repoRoot, 'patches', 'stray+1.0.0.patch'), VENDOR_STYLE_PATCH);

  const result = checkInstalledPatchPostimages({ repoRoot: fixture.repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /no node_modules\/ target/);
  assert.match(result.errors.join('\n'), /stray\+1\.0\.0\.patch/);
});
