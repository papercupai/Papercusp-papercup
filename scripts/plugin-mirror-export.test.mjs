import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  buildMirror,
  importSpecifiers,
  internalReferenceProblems,
  publishMirror,
  readCommittedPackage,
  selfContainmentProblems,
  writeMirror,
} from './plugin-mirror-export.mjs';

const file = (path, text) => ({ path, content: Buffer.from(text) });
const manifest = (extra = {}) =>
  file('papercusp.json', JSON.stringify({ name: 'demo', version: '0.1.0', kind: 'plugin', license: 'MIT', ...extra }));

test('importSpecifiers finds static, re-export, dynamic and require forms', () => {
  const src = [
    "import a from './a.mjs';",
    "import { b } from 'node:fs';",
    "import './side-effect.mjs';",
    "export { c } from '../escape.mjs';",
    "const d = await import('ws');",
    "const e = require('@scope/pkg/sub');",
  ].join('\n');
  assert.deepEqual(
    importSpecifiers(src).sort(),
    ['../escape.mjs', './a.mjs', './side-effect.mjs', '@scope/pkg/sub', 'node:fs', 'ws'].sort(),
  );
});

test('self-containment: in-package relative and builtin imports pass; escapes and undeclared bare imports fail', () => {
  const ok = [file('provider.mjs', "import './lib/x.mjs'; import 'node:crypto'; import 'fs';"), file('lib/x.mjs', "import '../provider.mjs';")];
  assert.deepEqual(selfContainmentProblems(ok), []);

  const escaping = [file('lib/x.mjs', "import '../../outside.mjs';")];
  assert.match(selfContainmentProblems(escaping)[0], /escapes the package directory/);

  const absolute = [file('x.mjs', "import '/etc/thing.mjs';")];
  assert.match(selfContainmentProblems(absolute)[0], /escapes the package directory/);

  const undeclared = [file('x.mjs', "import WebSocket from 'ws';")];
  assert.match(selfContainmentProblems(undeclared)[0], /not declared in package\.json/);

  const declared = [
    file('x.mjs', "import WebSocket from 'ws'; const s = require('@scope/pkg/sub');"),
    file('package.json', JSON.stringify({ dependencies: { ws: '^8' }, peerDependencies: { '@scope/pkg': '*' } })),
  ];
  assert.deepEqual(selfContainmentProblems(declared), []);

  // Non-code files are not scanned, so prose that mentions an import cannot refuse a package.
  assert.deepEqual(selfContainmentProblems([file('README.md', "import x from '../../nope';")]), []);
});

test('buildMirror generates an MIT LICENSE only when the package has none', () => {
  const built = buildMirror([manifest(), file('provider.mjs', "import 'node:fs';")], { year: 2026 });
  assert.equal(built.ok, true);
  const license = built.files.find((f) => f.path === 'LICENSE');
  assert.ok(license, 'LICENSE generated');
  assert.match(license.content.toString(), /^MIT License\n\nCopyright \(c\) 2026 Papercusp/);

  const own = buildMirror([manifest(), file('LICENSE', 'custom terms')]);
  assert.equal(own.ok, true);
  assert.equal(own.files.filter((f) => f.path === 'LICENSE').length, 1);
  assert.equal(own.files.find((f) => f.path === 'LICENSE').content.toString(), 'custom terms');
});

test('buildMirror refuses what the Cupboard or a standalone checkout could not use', () => {
  assert.match(buildMirror([manifest({ license: 'Apache-2.0' })]).problems.join('\n'), /MIT only/);
  assert.match(buildMirror([manifest({ version: '' })]).problems.join('\n'), /non-empty name and version/);
  assert.match(buildMirror([file('provider.mjs', '')]).problems.join('\n'), /papercusp\.json is missing/);
  assert.match(buildMirror([file('papercusp.json', '{not json')]).problems.join('\n'), /does not parse/);
  assert.match(buildMirror([manifest(), file('x.mjs', "import '../../a.mjs';")]).problems.join('\n'), /escapes/);
});

test('buildMirror refuses text that cites internal context, and keeps a pack plan\'s own item ids', () => {
  // Built at run time so this source never carries a literal home-directory path.
  const homePath = ['', 'home', 'someone', 'papercupai-workspace'].join('/');
  const leaky = buildMirror([
    manifest(),
    file('provider.mjs', '// see example-plan-2026-10-10 D-023 and WI-6554700010008315\nexport const x = 1;\n'),
    file('README.md', `Started by su-0dd6b9aa against http://127.0.0.1:3070 from ${homePath}\n`),
    file('notes.md', 'rows land in harness_shared.trigger_runs via packages/operator-core/lib/x.ts\n'),
  ]);
  assert.equal(leaky.ok, false);
  const problems = leaky.problems.join('\n');
  assert.match(problems, /provider\.mjs:1: an internal plan slug \('example-plan-2026-10-10'\)/);
  assert.match(problems, /provider\.mjs:1: an internal work-item id/);
  assert.match(problems, /README\.md:1: an internal agent session id/);
  assert.match(problems, /README\.md:1: an internal operator port/);
  assert.match(problems, /README\.md:1: an absolute home-directory path/);
  assert.match(problems, /README\.md:1: the monorepo checkout name/);
  assert.match(problems, /notes\.md:1: an internal database schema/);
  assert.match(problems, /notes\.md:1: a monorepo source path/);

  const own = [manifest(), file('plan.md', 'Do P-001, then P-002 (D-003). Released 2026-10-10 on port 3070.\n')];
  assert.deepEqual(internalReferenceProblems(own), []);
  assert.equal(buildMirror(own, { year: 2026 }).ok, true);
  assert.deepEqual(internalReferenceProblems([{ path: 'logo.png', content: Buffer.from([0x89, 0, 0x2f, 0x68, 0x6f, 0x6d, 0x65]) }]), []);
});

test('publishMirror updates an existing mirror with one fast-forward commit, and makes none when nothing changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-mirror-publish-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const id = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
  try {
    const remote = join(root, 'remote.git');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
    const seed = join(root, 'seed');
    git(root, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), 'first publish\n');
    git(seed, 'add', '-A');
    git(seed, ...id, 'commit', '--quiet', '-m', 'first');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    const first = git(seed, 'rev-parse', 'HEAD');

    const built = buildMirror([manifest(), file('provider.mjs', 'export const v = 1;\n')], { year: 2026 });
    assert.equal(built.ok, true);
    const one = publishMirror({ outDir: join(root, 'out-1'), remote, files: built.files, message: 'export 1' });
    assert.equal(one.status, 'published');
    assert.equal(git(remote, 'rev-parse', 'main'), one.head);
    assert.equal(git(remote, 'rev-parse', 'main^'), first, 'committed on top of the remote history, not as a new root');
    assert.deepEqual(git(remote, 'ls-tree', '--name-only', 'main').split('\n').sort(), ['LICENSE', 'papercusp.json', 'provider.mjs']);

    const again = publishMirror({ outDir: join(root, 'out-2'), remote, files: built.files, message: 'export 2' });
    assert.deepEqual(again, { status: 'unchanged', head: one.head });

    const empty = join(root, 'empty.git');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', empty);
    const fresh = publishMirror({ outDir: join(root, 'out-3'), remote: empty, files: built.files, message: 'first export' });
    assert.equal(fresh.status, 'published');
    assert.equal(git(empty, 'rev-parse', 'main'), fresh.head);

    assert.throws(
      () => publishMirror({ outDir: join(root, 'out-1'), remote, files: built.files, message: 'x' }),
      /must not exist or be empty/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCommittedPackage exports committed content only: uncommitted edits and untracked files never reach the mirror', () => {
  const repo = mkdtempSync(join(tmpdir(), 'plugin-mirror-export-'));
  const out = mkdtempSync(join(tmpdir(), 'plugin-mirror-out-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(repo, 'plugins', 'demo', 'lib'), { recursive: true });
    mkdirSync(join(repo, 'plugins', 'other'), { recursive: true });
    writeFileSync(join(repo, 'plugins', 'demo', 'papercusp.json'), manifest().content);
    writeFileSync(join(repo, 'plugins', 'demo', 'lib', 'x.mjs'), 'export const committed = true;\n');
    writeFileSync(join(repo, 'plugins', 'other', 'papercusp.json'), '{}');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'fixture');

    // Working-tree drift after the commit must not leak into the export.
    writeFileSync(join(repo, 'plugins', 'demo', 'lib', 'x.mjs'), 'export const committed = false;\n');
    writeFileSync(join(repo, 'plugins', 'demo', 'untracked.mjs'), 'secret\n');

    const files = readCommittedPackage({ pluginsRepo: repo, name: 'demo' });
    assert.deepEqual(files.map((f) => f.path).sort(), ['lib/x.mjs', 'papercusp.json']);
    assert.equal(files.find((f) => f.path === 'lib/x.mjs').content.toString(), 'export const committed = true;\n');

    const built = buildMirror(files, { year: 2026 });
    assert.equal(built.ok, true);
    mkdirSync(join(out, '.git'));
    writeFileSync(join(out, '.git', 'HEAD'), 'keep');
    writeFileSync(join(out, 'stale.txt'), 'removed by re-export');
    writeMirror(out, built.files);
    assert.deepEqual(readdirSync(out).sort(), ['.git', 'LICENSE', 'lib', 'papercusp.json']);
    assert.equal(readFileSync(join(out, '.git', 'HEAD'), 'utf8'), 'keep');

    assert.throws(() => readCommittedPackage({ pluginsRepo: repo, name: 'missing' }), /no committed files/);
    assert.throws(() => readCommittedPackage({ pluginsRepo: repo, name: '../escape' }), /invalid package name/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('SDK-generated provider mirrors contain the executable bundle without private build inputs', () => {
  const header = '// Generated from adapter.ts by @papercusp/plugin-sdk/scripts/build-provider-daemons.mjs. Do not edit.\n';
  const built = buildMirror([
    manifest({ main: './index.cjs', provider: {} }),
    file('adapter.ts', "import { helper } from '../../../../packages/operator-core/lib/helper';"),
    file('index.cjs', header + '// packages/operator-core/lib/helper.ts\n/*! Example library notice */\nmodule.exports = { answer: 42, text: `one\n// literal text\ntwo` };'),
  ]);
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  assert.ok(!built.files.some((f) => f.path === 'adapter.ts'));
  const output = built.files.find((f) => f.path === 'index.cjs').content.toString();
  assert.ok(!output.includes('packages/operator-core'));
  assert.ok(output.includes('Example library notice'));
  const context = { module: { exports: {} } };
  runInNewContext(output, context);
  assert.equal(context.module.exports.answer, 42);
  assert.equal(context.module.exports.text, 'one\n// literal text\ntwo');
});

test('compiled provider export still refuses private runtime strings, escaped imports and source dependencies', () => {
  const header = '// Generated from adapter.ts by @papercusp/plugin-sdk/scripts/build-provider-daemons.mjs. Do not edit.\n';
  const input = (code) => [manifest({ main: './index.cjs', provider: {} }),
    file('adapter.ts', 'export const x = 1;'), file('index.cjs', header + code)];
  assert.match(buildMirror(input("module.exports = 'packages/operator-core/lib/private.ts';")).problems.join('\n'), /monorepo source path/);
  assert.match(buildMirror(input("require('../outside.cjs');")).problems.join('\n'), /escapes the package directory/);
  assert.match(buildMirror(input("require('./adapter.ts');")).problems.join('\n'), /still imports its authoring source/);
  assert.match(buildMirror(input('module.exports = {')).problems.join('\n'), /invalid generated JavaScript/);
  const daemonSource = input('module.exports = {};');
  daemonSource[0] = manifest({ main: './index.cjs', provider: {}, runtime: { daemonCommand: ['node', './adapter.ts'] } });
  assert.match(buildMirror(daemonSource).problems.join('\n'), /still executes its authoring source/);
});

test('the first-party provider and trigger packages export as standalone mirrors', () => {
  for (const name of [
    'slack', 'bug-triage', 'facebook', 'google-contacts', 'facebook-pages', 'instagram',
    'x', 'threads', 'tiktok', 'linkedin', 'linkedin-company', 'youtube', 'mastodon',
    'reddit', 'bluesky', 'devto', 'hashnode', 'discord',
  ]) {
    const files = readCommittedPackage({ name });
    assert.ok(files.some((f) => f.path === 'papercusp.json'), `${name}: manifest at the package root`);
    const built = buildMirror(files);
    assert.deepEqual(built.problems ?? [], [], `${name}: exportable`);
    assert.ok(built.files.some((f) => f.path === 'LICENSE'), `${name}: carries a LICENSE`);
  }
});
