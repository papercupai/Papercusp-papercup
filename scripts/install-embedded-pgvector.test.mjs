import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMBEDDED_EXTENSIONS,
  embeddedPgMajor,
  embeddedPgPackageDirs,
  hostPgTextsearchCandidates,
  hostPgvectorCandidates,
  hostServerMinor,
  installEmbeddedExtensions,
  missingWarning,
  runtimeDirs,
} from './install-embedded-pgvector.mjs';

const PGVECTOR = EMBEDDED_EXTENSIONS.filter((e) => e.name === 'pgvector');
const PG_TEXTSEARCH = EMBEDDED_EXTENSIONS.filter((e) => e.name === 'pg_textsearch');

function fakeCheckout({ version = '18.3.0-beta.17', flat = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'emb-pgv-'));
  const pkgDir = join(root, 'node_modules', '@embedded-postgres', 'linux-x64');
  const nativeDir = join(pkgDir, 'native');
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@embedded-postgres/linux-x64', version }));
  if (flat) {
    mkdirSync(join(nativeDir, 'lib'), { recursive: true });
    mkdirSync(join(nativeDir, 'share', 'extension'), { recursive: true });
    writeFileSync(join(nativeDir, 'lib', 'pgcrypto.so'), '');
  }
  return { root, nativeDir };
}

function fakeHostPgvector() {
  const dir = mkdtempSync(join(tmpdir(), 'host-pgv-'));
  const extDir = join(dir, 'extension');
  mkdirSync(extDir);
  writeFileSync(join(dir, 'vector.so'), 'ELF');
  writeFileSync(join(extDir, 'vector.control'), "default_version = '0.8.1'");
  writeFileSync(join(extDir, 'vector--0.8.1.sql'), '-- sql');
  writeFileSync(join(extDir, 'unrelated.sql'), '-- not ours');
  return { PAPERCUSP_PGVECTOR_LIB: join(dir, 'vector.so'), PAPERCUSP_PGVECTOR_EXT_DIR: extDir };
}

function fakeHostPgTextsearch({ licence = true, builtFor = '18.3' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-pgts-'));
  const extDir = join(dir, 'extension');
  mkdirSync(extDir);
  writeFileSync(join(dir, 'pg_textsearch.so'), 'ELF-BM25');
  writeFileSync(join(extDir, 'pg_textsearch.control'), "default_version = '1.5.1'");
  writeFileSync(join(extDir, 'pg_textsearch--1.5.1.sql'), '-- install');
  writeFileSync(join(extDir, 'pg_textsearch--1.5.0--1.5.1.sql'), '-- upgrade');
  // Same directory as the host's other extensions: only pg_textsearch files may be copied.
  writeFileSync(join(extDir, 'vector--0.8.1.sql'), '-- not ours');
  const env = {
    PAPERCUSP_PG_TEXTSEARCH_LIB: join(dir, 'pg_textsearch.so'),
    PAPERCUSP_PG_TEXTSEARCH_EXT_DIR: extDir,
    // fakeCheckout() trees are 18.3; a build for 18.3 is loadable there.
    PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR: builtFor,
  };
  if (licence) {
    writeFileSync(join(dir, 'copyright'), 'PostgreSQL License notice');
    env.PAPERCUSP_PG_TEXTSEARCH_LICENSE = join(dir, 'copyright');
  }
  return env;
}

const quiet = () => {};

test('embeddedPgMajor reads the Postgres major from the package version', () => {
  assert.equal(embeddedPgMajor('18.3.0-beta.17'), 18);
  assert.equal(embeddedPgMajor('17.6.0'), 17);
  assert.equal(embeddedPgMajor(undefined), null);
});

test('linux candidates target the embedded major, never another', () => {
  const [candidate] = hostPgvectorCandidates({ platform: 'linux', major: 18, env: {} });
  assert.equal(candidate.lib, '/usr/lib/postgresql/18/lib/vector.so');
  assert.equal(candidate.extDir, '/usr/share/postgresql/18/extension');
  const [bm25] = hostPgTextsearchCandidates({ platform: 'linux', major: 18, env: {} });
  assert.equal(bm25.lib, '/usr/lib/postgresql/18/lib/pg_textsearch.so');
  assert.equal(bm25.extDir, '/usr/share/postgresql/18/extension');
  assert.equal(bm25.licence, '/usr/share/doc/postgresql-18-pg-textsearch/copyright');
});

test('pg_textsearch has no host source on darwin or windows (WI-6554700010008388)', () => {
  assert.deepEqual(hostPgTextsearchCandidates({ platform: 'darwin', major: 18, env: {} }), []);
  assert.deepEqual(hostPgTextsearchCandidates({ platform: 'win32', major: 18, env: {} }), []);
});

test('the extension table: pgvector is required, pg_textsearch is optional', () => {
  assert.deepEqual(
    EMBEDDED_EXTENSIONS.map((e) => [e.name, e.stem, e.required]),
    [
      ['pgvector', 'vector', true],
      ['pg_textsearch', 'pg_textsearch', false],
    ],
  );
});

test('a fresh npm ci tree gets pgvector copied into the Debian-style layout', () => {
  const { root, nativeDir } = fakeCheckout();
  const report = installEmbeddedExtensions({ root, platform: 'linux', env: fakeHostPgvector(), log: quiet, extensions: PGVECTOR });
  assert.equal(report.trees[0].extension, 'pgvector');
  assert.equal(report.trees[0].status, 'installed');
  assert.equal(report.trees[0].sqlFiles, 1);
  assert.ok(existsSync(join(nativeDir, 'lib', 'postgresql', 'vector.so')));
  assert.ok(existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'vector.control')));
  assert.ok(existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'vector--0.8.1.sql')));
  assert.ok(!existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'unrelated.sql')));
});

test('a fresh tree gets pg_textsearch where embedded-postgres-server looks for preload libraries', () => {
  const { root, nativeDir } = fakeCheckout();
  const report = installEmbeddedExtensions({ root, platform: 'linux', env: fakeHostPgTextsearch(), log: quiet, extensions: PG_TEXTSEARCH });
  assert.deepEqual(
    { extension: report.trees[0].extension, status: report.trees[0].status, sqlFiles: report.trees[0].sqlFiles, licence: report.trees[0].licence },
    { extension: 'pg_textsearch', status: 'installed', sqlFiles: 2, licence: true },
  );
  // presentPreloadLibraries checks <root>/lib/postgresql/<lib>.so — the Debian layout.
  assert.equal(readFileSync(join(nativeDir, 'lib', 'postgresql', 'pg_textsearch.so'), 'utf8'), 'ELF-BM25');
  const extDir = join(nativeDir, 'share', 'postgresql', 'extension');
  for (const file of ['pg_textsearch.control', 'pg_textsearch--1.5.1.sql', 'pg_textsearch--1.5.0--1.5.1.sql']) {
    assert.ok(existsSync(join(extDir, file)), file);
  }
  assert.equal(readFileSync(join(extDir, 'pg_textsearch.LICENSE'), 'utf8'), 'PostgreSQL License notice');
  assert.ok(!existsSync(join(extDir, 'vector--0.8.1.sql')), 'another extension’s script must not be copied');
});

test('a missing licence notice is reported, not invented', () => {
  const { root, nativeDir } = fakeCheckout();
  const report = installEmbeddedExtensions({
    root,
    platform: 'linux',
    env: fakeHostPgTextsearch({ licence: false }),
    log: quiet,
    extensions: PG_TEXTSEARCH,
  });
  assert.equal(report.trees[0].licence, false);
  assert.ok(!existsSync(join(nativeDir, 'share', 'postgresql', 'extension', 'pg_textsearch.LICENSE')));
});

test('both extensions install in one run, one report row each', () => {
  const { root } = fakeCheckout();
  const env = { ...fakeHostPgvector(), ...fakeHostPgTextsearch() };
  const report = installEmbeddedExtensions({ root, platform: 'linux', env, log: quiet });
  assert.deepEqual(
    report.trees.map((row) => [row.extension, row.status]),
    [
      ['pgvector', 'installed'],
      ['pg_textsearch', 'installed'],
    ],
  );
});

test('the flat layout is honoured when the tree uses it', () => {
  const { root, nativeDir } = fakeCheckout({ flat: true });
  assert.deepEqual(runtimeDirs(nativeDir), { libDir: join(nativeDir, 'lib'), extDir: join(nativeDir, 'share', 'extension') });
  installEmbeddedExtensions({ root, platform: 'linux', env: { ...fakeHostPgvector(), ...fakeHostPgTextsearch() }, log: quiet });
  assert.ok(existsSync(join(nativeDir, 'lib', 'vector.so')));
  assert.ok(existsSync(join(nativeDir, 'share', 'extension', 'vector.control')));
  assert.ok(existsSync(join(nativeDir, 'lib', 'pg_textsearch.so')));
  assert.ok(existsSync(join(nativeDir, 'share', 'extension', 'pg_textsearch.control')));
});

test('a second run is a no-op while the tree matches the host build', () => {
  const { root, nativeDir } = fakeCheckout();
  const env = fakeHostPgvector();
  installEmbeddedExtensions({ root, platform: 'linux', env, log: quiet, extensions: PGVECTOR });
  const lib = join(nativeDir, 'lib', 'postgresql', 'vector.so');
  const before = statSync(lib).mtimeMs;
  const report = installEmbeddedExtensions({ root, platform: 'linux', env, log: quiet, extensions: PGVECTOR });
  assert.equal(report.trees[0].status, 'present');
  assert.equal(statSync(lib).mtimeMs, before);
});

test('a tree whose library differs from the host build is refreshed (host package upgrade)', () => {
  const { root, nativeDir } = fakeCheckout();
  const env = fakeHostPgTextsearch();
  installEmbeddedExtensions({ root, platform: 'linux', env, log: quiet, extensions: PG_TEXTSEARCH });
  const lib = join(nativeDir, 'lib', 'postgresql', 'pg_textsearch.so');
  writeFileSync(lib, 'STALE-BUILD');
  // A hard link stands in for a running postgres that has the old library mapped.
  const mapped = join(root, 'mapped-by-running-postgres.so');
  linkSync(lib, mapped);
  const report = installEmbeddedExtensions({ root, platform: 'linux', env, log: quiet, extensions: PG_TEXTSEARCH });
  assert.equal(report.trees[0].status, 'updated');
  assert.equal(readFileSync(lib, 'utf8'), 'ELF-BM25');
  // Replaced by rename, not rewritten in place: the old inode keeps its bytes, so a
  // process that mapped it cannot fault (SIGBUS) mid-refresh.
  assert.equal(readFileSync(mapped, 'utf8'), 'STALE-BUILD');
  assert.notEqual(statSync(lib).ino, statSync(mapped).ino);
  assert.deepEqual(readdirSync(join(nativeDir, 'lib', 'postgresql')).filter((f) => f.includes('.tmp-')), []);
});

test('a present extension with no host source is left alone', () => {
  const { root, nativeDir } = fakeCheckout();
  installEmbeddedExtensions({ root, platform: 'linux', env: fakeHostPgvector(), log: quiet, extensions: PGVECTOR });
  const lib = join(nativeDir, 'lib', 'postgresql', 'vector.so');
  writeFileSync(lib, 'SENTINEL');
  // A non-linux platform with no env override has no pgvector... except darwin's
  // Homebrew paths, which do not exist here; win32 has no candidates at all.
  const report = installEmbeddedExtensions({ root, platform: 'win32', env: {}, log: quiet, extensions: PGVECTOR });
  assert.equal(report.trees[0].status, 'present');
  assert.equal(readFileSync(lib, 'utf8'), 'SENTINEL');
});

test('a host without either extension is reported with install hints, not silently skipped', () => {
  const { root } = fakeCheckout({ version: '99.0.0' });
  const report = installEmbeddedExtensions({ root, platform: 'linux', env: {}, log: quiet });
  assert.deepEqual(
    report.trees.map((row) => [row.extension, row.status]),
    [
      ['pgvector', 'missing-source'],
      ['pg_textsearch', 'missing-source'],
    ],
  );
  const [vector, bm25] = report.missingSource;
  assert.equal(vector.required, true);
  assert.match(vector.hint, /postgresql-99-pgvector/);
  assert.equal(bm25.required, false);
  assert.match(bm25.hint, /postgresql-99-pg-textsearch/);
  assert.match(bm25.hint, /legacy ts_rank_cd/);
});

test('a pg_textsearch build for a NEWER server minor is refused, not installed (palloc_mul, 2026-10-11)', () => {
  const { root, nativeDir } = fakeCheckout({ version: '18.3.0-beta.17' });
  const report = installEmbeddedExtensions({
    root,
    platform: 'linux',
    env: fakeHostPgTextsearch({ builtFor: '18.4' }),
    log: quiet,
    extensions: PG_TEXTSEARCH,
  });
  assert.deepEqual(
    { status: report.trees[0].status, treeMinor: report.trees[0].treeMinor, builtFor: report.trees[0].builtFor },
    { status: 'incompatible', treeMinor: 3, builtFor: 4 },
  );
  assert.equal(report.missingSource[0].required, false);
  assert.match(report.missingSource[0].hint, /Bump embedded-postgres to >= 18\.4/);
  // Nothing copied: embedded-postgres-server preloads on file presence alone.
  assert.ok(!existsSync(join(nativeDir, 'lib', 'postgresql', 'pg_textsearch.so')));
});

test('the same build installs into a tree at or above its server minor', () => {
  const { root, nativeDir } = fakeCheckout({ version: '18.4.0-beta.17' });
  const report = installEmbeddedExtensions({
    root,
    platform: 'linux',
    env: fakeHostPgTextsearch({ builtFor: '18.4' }),
    log: quiet,
    extensions: PG_TEXTSEARCH,
  });
  assert.equal(report.trees[0].status, 'installed');
  assert.ok(existsSync(join(nativeDir, 'lib', 'postgresql', 'pg_textsearch.so')));
});

test('hostServerMinor reads the installed postgresql-<major> server from dpkg, unknown means null', () => {
  const dpkg = [
    'Package: postgresql-17\nStatus: install ok installed\nVersion: 17.9-1.pgdg24.04+1',
    'Package: postgresql-18\nStatus: deinstall ok config-files\nVersion: 18.1-1',
    'Package: postgresql-18\nStatus: install ok installed\nVersion: 18.4-1.pgdg24.04+1',
  ].join('\n\n');
  assert.equal(hostServerMinor({ platform: 'linux', major: 18, env: {}, readText: () => dpkg }), 4);
  assert.equal(hostServerMinor({ platform: 'linux', major: 16, env: {}, readText: () => dpkg }), null);
  assert.equal(hostServerMinor({ platform: 'linux', major: 18, env: {}, readText: () => { throw new Error('no dpkg'); } }), null);
  assert.equal(hostServerMinor({ platform: 'darwin', major: 18, env: {} }), null);
  assert.equal(hostServerMinor({ platform: 'linux', major: 18, env: { PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR: '18.6' } }), 6);
  assert.equal(hostServerMinor({ platform: 'linux', major: 18, env: { PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR: '17.6' } }), null);
});

test('an unknown build target is refused (a bad preload library stops the postmaster)', () => {
  const { root, nativeDir } = fakeCheckout();
  const env = fakeHostPgTextsearch();
  delete env.PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR;
  const report = installEmbeddedExtensions({ root, platform: 'darwin', env, log: quiet, extensions: PG_TEXTSEARCH });
  assert.equal(report.trees[0].status, 'incompatible');
  assert.ok(!existsSync(join(nativeDir, 'lib', 'postgresql', 'pg_textsearch.dylib')));
});

test('npm reify staging directories (.linux-x64-XXXX) are never provisioned', () => {
  const { root } = fakeCheckout();
  const staging = join(root, 'node_modules', '@embedded-postgres', '.linux-x64-DMXkNnwv');
  mkdirSync(join(staging, 'native'), { recursive: true });
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ version: '18.3.0-beta.17' }));
  const report = installEmbeddedExtensions({ root, platform: 'linux', env: { ...fakeHostPgvector(), ...fakeHostPgTextsearch() }, log: quiet });
  assert.deepEqual([...new Set(report.trees.map((row) => row.tree))], ['linux-x64']);
  assert.ok(!existsSync(join(staging, 'native', 'lib', 'postgresql', 'pg_textsearch.so')));
});

// The D-014 layout, measured 2026-10-11: apps/slack-asana-bug-drill pins embedded-postgres
// 18.3 exactly, so 18.3 stays hoisted and embedded-postgres-server (^18.4) gets its own
// copy nested under its workspace. Every embedded-postgres-server boot loads the nested one.
function fakeNestedCheckout() {
  const { root, nativeDir: hoistedNative } = fakeCheckout({ version: '18.3.0-beta.17' });
  const nestedRel = 'libs/papercusp/packages/embedded-postgres-server/node_modules/@embedded-postgres';
  const nestedPkg = join(root, nestedRel, 'linux-x64');
  mkdirSync(join(nestedPkg, 'native'), { recursive: true });
  writeFileSync(join(nestedPkg, 'package.json'), JSON.stringify({ name: '@embedded-postgres/linux-x64', version: '18.4.0-beta.17' }));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'node_modules/@embedded-postgres/linux-x64': { version: '18.3.0-beta.17', optional: true },
        'node_modules/@embedded-postgres/darwin-arm64': { version: '18.4.0-beta.17', optional: true },
        [`${nestedRel}/linux-x64`]: { version: '18.4.0-beta.17', optional: true },
        // Recorded in the lock but not on disk (an optional package for another platform).
        'node_modules/embedded-postgres/node_modules/@embedded-postgres/windows-x64': { version: '18.3.0-beta.17', optional: true },
        // Not an @embedded-postgres placement at all.
        'node_modules/embedded-postgres': { version: '18.3.0-beta.17' },
        'node_modules/@embedded-postgres-like/linux-x64': { version: '1.0.0' },
      },
    }),
  );
  return { root, hoistedNative, nestedNative: join(nestedPkg, 'native'), nestedRel };
}

test('embeddedPgPackageDirs reads every @embedded-postgres placement from the lock, hoisted always included', () => {
  const { root, nestedRel } = fakeNestedCheckout();
  assert.deepEqual(embeddedPgPackageDirs(root), [
    nestedRel,
    'node_modules/@embedded-postgres',
    'node_modules/embedded-postgres/node_modules/@embedded-postgres',
  ]);
  const noLock = mkdtempSync(join(tmpdir(), 'emb-pgv-nolock-'));
  assert.deepEqual(embeddedPgPackageDirs(noLock), ['node_modules/@embedded-postgres']);
});

test('a tree npm nested under a workspace is provisioned too, each against its own server minor', () => {
  const { root, hoistedNative, nestedNative, nestedRel } = fakeNestedCheckout();
  const report = installEmbeddedExtensions({
    root,
    platform: 'linux',
    env: { ...fakeHostPgvector(), ...fakeHostPgTextsearch({ builtFor: '18.4' }) },
    log: quiet,
  });
  const byWhere = Object.fromEntries(report.trees.map((row) => [`${row.location} ${row.extension}`, row.status]));
  assert.deepEqual(byWhere, {
    [`${nestedRel}/linux-x64 pgvector`]: 'installed',
    [`${nestedRel}/linux-x64 pg_textsearch`]: 'installed',
    'node_modules/@embedded-postgres/linux-x64 pgvector': 'installed',
    // The 18.4 build would stop an 18.3 postmaster from starting.
    'node_modules/@embedded-postgres/linux-x64 pg_textsearch': 'incompatible',
  });
  assert.ok(existsSync(join(nestedNative, 'lib', 'postgresql', 'pg_textsearch.so')));
  assert.ok(existsSync(join(nestedNative, 'lib', 'postgresql', 'vector.so')));
  assert.ok(!existsSync(join(hoistedNative, 'lib', 'postgresql', 'pg_textsearch.so')));
  // The refusal names the tree it is about, so two linux-x64 trees are distinguishable.
  assert.equal(report.missingSource.length, 1);
  assert.equal(report.missingSource[0].location, 'node_modules/@embedded-postgres/linux-x64');
});

test('a refused build is not reported as missing from the host', () => {
  const { root } = fakeNestedCheckout();
  const report = installEmbeddedExtensions({
    root,
    platform: 'linux',
    env: fakeHostPgTextsearch({ builtFor: '18.4' }),
    log: quiet,
    extensions: PG_TEXTSEARCH,
  });
  const text = missingWarning(report.missingSource[0]);
  assert.doesNotMatch(text, /not found on this machine/);
  assert.match(text, /node_modules\/@embedded-postgres\/linux-x64 boots without pg_textsearch/);
  assert.match(text, /Bump embedded-postgres to >= 18\.4/);
});

test('no embedded-postgres install means nothing to do', () => {
  const root = mkdtempSync(join(tmpdir(), 'emb-pgv-empty-'));
  assert.deepEqual(installEmbeddedExtensions({ root, platform: 'linux', env: {}, log: quiet }), { trees: [], missingSource: [] });
});
