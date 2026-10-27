import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as taskProvenance from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import * as gitBatch from '../git-batch';
import * as gitSidecar from '../fleet/git-via-sidecar';
import { createTestContentEquivalence } from './conformance-test-content';

describe('conformance immutable dependency content', () => {
  let root: string;
  let recordedSha: string;
  const file = 'packages/unit/guard.test.ts';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conformance-content-'));
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    write('package.json', JSON.stringify({ workspaces: ['packages/*', 'libs/*'] }));
    write('package-lock.json', '{}');
    write('packages/unit/package.json', JSON.stringify({ name: '@fixture/unit', dependencies: { '@fixture/dependency': '*' } }));
    write(file, 'export const passing = true;');
    write('packages/unit/source.ts', 'export const answer = 1;');
    write('libs/dependency/package.json', JSON.stringify({ name: '@fixture/dependency' }));
    write('libs/dependency/source.ts', 'export const input = 1;');
    write('libs/test-config/package.json', JSON.stringify({ name: '@fixture/test-config' }));
    write('libs/test-config/src/vitest-config.ts', "import './setup';");
    write('libs/test-config/src/setup.ts', 'export const setup = 1;');
    write('libs/test-config/src/lane-split.ts', 'export const lane = 1;');
    write('scripts/affected-tests.mjs', "import './runner.mjs';");
    write('scripts/runner.mjs', 'export const runner = 1;');
    write('scripts/pc-heavy.sh', '#!/bin/sh\ntrue\n');
    recordedSha = commit();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts unchanged semantic inputs across an unrelated commit, using immutable bytes despite dirty disk', async () => {
    write('docs/note.md', 'unrelated');
    const currentSha = commit();
    write('packages/unit/source.ts', 'dirty disk must never become committed proof');
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
      .toEqual({ equivalent: true, reason: 'canonical semantic dependency closure matches' });
  });

  it('batches immutable reads and shares them across concurrent test proofs', async () => {
    for (let index = 0; index < 40; index++) {
      write(`packages/extra-${index}/package.json`, JSON.stringify({ name: `@fixture/extra-${index}` }));
    }
    const secondFile = 'packages/unit/second.test.ts';
    write(secondFile, 'export const second = true;');
    recordedSha = commit();
    write('docs/note.md', 'unrelated');
    const currentSha = commit();
    const batch = vi.spyOn(gitBatch, 'runGitBatch');
    const compare = createTestContentEquivalence(root);
    const results = await Promise.all([file, secondFile].map(file => compare({ file, recordedSha, currentSha })));
    expect(results).toEqual([
      { equivalent: true, reason: 'canonical semantic dependency closure matches' },
      { equivalent: true, reason: 'canonical semantic dependency closure matches' },
    ]);
    const calls = batch.mock.calls;
    expect(calls.some(([commands]) => commands.length >= 40)).toBe(true);
    expect(calls.length).toBeLessThan(12);
    const objects = calls.flatMap(([commands]) => commands.map(command => JSON.stringify(command)));
    // Immutable blobs shared by snapshots and concurrent proofs are read once.
    expect(objects.length).toBe(new Set(objects).size);
  });

  it('shares pinned submodule trees and blobs through 32 non-equivalent historical closures', async () => {
    const dependency = mkdtempSync(join(tmpdir(), 'conformance-history-dependency-'));
    try {
      for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) {
        execFileSync('git', args, { cwd: dependency });
      }
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/dependency' }));
      writeFileSync(join(dependency, 'source.ts'), 'export const dependency = 1;');
      execFileSync('git', ['add', '.'], { cwd: dependency });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dependency });
      git('rm', '-qr', 'libs/dependency');
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'libs/dependency');
      write('libs/versioned-input/package.json', JSON.stringify({ name: '@fixture/versioned-input' }));
      write('packages/unit/package.json', JSON.stringify({ name: '@fixture/unit',
        dependencies: { '@fixture/dependency': '*', '@fixture/versioned-input': '*' } }));
      const history: string[] = [];
      for (let index = 0; index < 33; index++) {
        write('libs/versioned-input/source.ts', `export const answer = ${index};`);
        history.push(commit());
      }
      const currentSha = history.pop()!;
      const routed = vi.spyOn(gitSidecar, 'execFileViaSidecar');
      const batch = vi.spyOn(gitBatch, 'runGitBatch');
      const compare = createTestContentEquivalence(root);
      for (const recordedSha of history) {
        expect(await compare({ file, recordedSha, currentSha })).toEqual({
          equivalent: false, reason: 'semantic dependency closure changed',
        });
      }
      const childTrees = routed.mock.calls.filter(([, args]) => args.includes('ls-tree') && args.includes('--git-dir'));
      expect(childTrees).toHaveLength(1);
      const commands = batch.mock.calls.flatMap(([commands]) => commands.map(command => JSON.stringify(command)));
      expect(commands.length).toBe(new Set(commands).size);
      expect(batch.mock.calls.length).toBeLessThan(10);
    } finally {
      rmSync(dependency, { recursive: true, force: true });
    }
  });

  it('coalesces complete proofs by immutable snapshot and owning workspace across test files', async () => {
    write('package.json', JSON.stringify({ workspaces: ['packages/*', 'packages/unit/*', 'libs/*'] }));
    const files = [file, 'packages/unit/second.test.ts',
      'packages/other/first.test.ts', 'packages/other/second.test.ts',
      'packages/unit/nested/guard.test.ts'];
    write('packages/other/package.json', JSON.stringify({ name: '@fixture/other' }));
    write('packages/unit/nested/package.json', JSON.stringify({ name: '@fixture/nested' }));
    for (const path of files.slice(1)) write(path, 'export const passing = true;');
    recordedSha = commit();
    write('docs/note.md', 'unrelated');
    const currentSha = commit();
    const canonical = vi.spyOn(taskProvenance, 'passingTaskVerdictDependencyProvenance');
    const shared = vi.spyOn(taskProvenance, 'passingTaskVerdictSharedInputProvenance');
    const compare = createTestContentEquivalence(root);
    expect(await Promise.all(files.slice(0, 2).map(file => compare({ file, recordedSha, currentSha }))))
      .toEqual(Array(2).fill({ equivalent: true, reason: 'canonical semantic dependency closure matches' }));
    const sharedCalls = shared.mock.calls.length;
    for (const file of files.slice(2)) {
      expect(await compare({ file, recordedSha, currentSha })).toMatchObject({ equivalent: true });
    }
    // A cached workspace proof cannot establish that an untracked file existed.
    expect(await compare({ file: 'packages/unit/missing.test.ts', recordedSha, currentSha }))
      .toEqual({ equivalent: false, reason: 'test workspace unavailable: packages/unit/missing.test.ts' });
    const owners = canonical.mock.calls.map(([input]) => input.workspaceName).sort();
    expect(owners).toEqual(['@fixture/nested', '@fixture/nested', '@fixture/other', '@fixture/other', '@fixture/unit', '@fixture/unit']);
    expect(shared.mock.calls.length).toBe(sharedCalls);
  });

  it('keeps different workspace closures distinct after warming the same snapshot pair', async () => {
    const otherFile = 'packages/other/guard.test.ts';
    write('packages/other/package.json', JSON.stringify({ name: '@fixture/other' }));
    write(otherFile, 'export const passing = true;');
    write('packages/other/source.ts', 'export const answer = 1;');
    recordedSha = commit();
    write('packages/other/source.ts', 'export const answer = 2;');
    const currentSha = commit();
    const compare = createTestContentEquivalence(root);
    expect(await compare({ file, recordedSha, currentSha })).toMatchObject({ equivalent: true });
    expect(await compare({ file: otherFile, recordedSha, currentSha }))
      .toEqual({ equivalent: false, reason: 'semantic dependency closure changed' });
    expect(await compare({ file, recordedSha, currentSha })).toMatchObject({ equivalent: true });
  });

  it('routes immutable tree reads through the shared spawn offload seam', async () => {
    write('docs/note.md', 'unrelated');
    const currentSha = commit();
    const routed = vi.spyOn(gitSidecar, 'execFileViaSidecar');
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
      .toEqual({ equivalent: true, reason: 'canonical semantic dependency closure matches' });
    const treeReads = routed.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'ls-tree' && args.includes('-rz'));
    expect(treeReads.map(([, args]) => args.at(-1)).sort()).toEqual([recordedSha, currentSha].sort());
    expect(treeReads.every(([, , options]) => options.subsystem === 'conformance-test-content'
      && options.cwd === root && options.timeoutMs === 15_000)).toBe(true);
  });

  it('rejects a changed test before traversing its dependency closure and caches exact entry reads', async () => {
    write(file, 'export const changedTest = true;');
    const currentSha = commit();
    const routed = vi.spyOn(gitSidecar, 'execFileViaSidecar');
    const batch = vi.spyOn(gitBatch, 'runGitBatch');
    const canonical = vi.spyOn(taskProvenance, 'passingTaskVerdictDependencyProvenance');
    const compare = createTestContentEquivalence(root);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await compare({ file, recordedSha, currentSha }))
        .toEqual({ equivalent: false, reason: 'semantic dependency closure changed' });
    }
    expect(routed.mock.calls).toHaveLength(2);
    expect(routed.mock.calls.every(([, args]) => args.includes(file) && !args.includes('-rz'))).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it.each([null, { code: 128, stdout: '', stderr: 'missing object' }])(
    'refuses missing or failed immutable batch reads instead of accepting an empty graph: %j', async failure => {
      vi.spyOn(gitBatch, 'runGitBatch').mockImplementationOnce(async commands => commands.map(() => failure));
      expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha: recordedSha }))
        .toEqual({ equivalent: false, reason: 'unreadable input: package.json' });
    },
  );

  it('rejects changed owning-workspace inputs without traversing dependencies, sharing the diff across tests', async () => {
    const secondFile = 'packages/unit/second.test.ts';
    write(secondFile, 'export const second = true;');
    recordedSha = commit();
    write('packages/unit/source.ts', 'export const answer = 2;');
    const currentSha = commit();
    const routed = vi.spyOn(gitSidecar, 'execFileViaSidecar');
    const batch = vi.spyOn(gitBatch, 'runGitBatch');
    const canonical = vi.spyOn(taskProvenance, 'passingTaskVerdictDependencyProvenance');
    const compare = createTestContentEquivalence(root);
    for (const path of [file, secondFile]) {
      expect(await compare({ file: path, recordedSha, currentSha }))
        .toEqual({ equivalent: false, reason: 'semantic dependency closure changed' });
    }
    expect(routed.mock.calls.filter(([, args]) => args.includes('diff-tree'))).toHaveLength(1);
    expect(routed.mock.calls.some(([, args]) => args.includes('-rz'))).toBe(false);
    expect(batch).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it('uses the deepest registered workspace and honors excluded nested workspace patterns', async () => {
    const nestedFile = 'packages/unit/nested/guard.test.ts';
    write('package.json', JSON.stringify({ workspaces: ['packages/*', 'packages/unit/*', 'libs/*'] }));
    write('packages/unit/nested/package.json', JSON.stringify({ name: '@fixture/nested' }));
    write(nestedFile, 'export const nested = true;');
    recordedSha = commit();
    write('packages/unit/source.ts', 'export const answer = 2;');
    const currentSha = commit();
    expect(await createTestContentEquivalence(root)({ file: nestedFile, recordedSha, currentSha }))
      .toMatchObject({ equivalent: true });
    write('package.json', JSON.stringify({ workspaces: ['packages/*', 'packages/unit/*', '!packages/unit/nested', 'libs/*'] }));
    const excludedSha = commit();
    write('packages/unit/source.ts', 'export const answer = 3;');
    const changedSha = commit();
    const batch = vi.spyOn(gitBatch, 'runGitBatch');
    expect(await createTestContentEquivalence(root)({ file: nestedFile, recordedSha: excludedSha, currentSha: changedSha }))
      .toMatchObject({ equivalent: false });
    expect(batch).not.toHaveBeenCalled();
  });

  it('requires the full proof for a changed workspace gitlink whose expanded content still matches', async () => {
    const dependency = mkdtempSync(join(tmpdir(), 'conformance-same-content-pin-'));
    try {
      const childGit = (...args: string[]) => execFileSync('git', args, { cwd: dependency, encoding: 'utf8' }).trim();
      childGit('init', '-q');
      childGit('config', 'user.name', 'Test');
      childGit('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(dependency, 'input.ts'), 'export const input = 1;');
      childGit('add', '.');
      childGit('commit', '-qm', 'first pin');
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'packages/unit/input');
      recordedSha = commit();
      childGit('commit', '--allow-empty', '-qm', 'same content at another pin');
      const checkout = join(root, 'packages/unit/input');
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'fetch', '-q'], { cwd: checkout });
      execFileSync('git', ['checkout', '-q', childGit('rev-parse', 'HEAD')], { cwd: checkout });
      const currentSha = commit();
      const canonical = vi.spyOn(taskProvenance, 'passingTaskVerdictDependencyProvenance');
      expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
        .toEqual({ equivalent: true, reason: 'canonical semantic dependency closure matches' });
      expect(canonical).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dependency, { recursive: true, force: true });
    }
  });

  it.each([
    'packages/unit/source.ts', file, 'libs/dependency/source.ts',
    'package-lock.json', 'scripts/runner.mjs', 'libs/test-config/src/setup.ts',
    'packages/unit/new-input.ts',
  ])('invalidates changed source, membership, dependencies, or shared oracle: %s', async path => {
    write(path, 'export const changed = 2;');
    const currentSha = commit();
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha }))
      .toMatchObject({ equivalent: false, reason: 'semantic dependency closure changed' });
  });

  it('invalidates removal of a dependency instead of narrowing the old proof to the new graph', async () => {
    write('packages/unit/package.json', JSON.stringify({ name: '@fixture/unit' }));
    const currentSha = commit();
    expect(await createTestContentEquivalence(root)({ file, recordedSha, currentSha })).toMatchObject({ equivalent: false });
  });

  it('refuses an unresolved shared import graph, absent commits and unknown test identity', async () => {
    write('scripts/runner.mjs', "import './missing.mjs';");
    const currentSha = commit();
    const compare = createTestContentEquivalence(root);
    expect(await compare({ file, recordedSha, currentSha })).toMatchObject({ equivalent: false,
      reason: expect.stringContaining('shared-input-module-graph') });
    expect(await compare({ file, recordedSha: 'f'.repeat(40), currentSha })).toMatchObject({ equivalent: false });
    expect(await compare({ file: '../unknown.test.ts', recordedSha, currentSha })).toMatchObject({ equivalent: false });
  });

  it.each(['absorbed', 'named-absorbed', 'standalone', 'nested-absorbed', 'nested-standalone'])(
    'reads immutable submodule pins in %s layout and rejects changed or missing pins', async layout => {
    const dependency = mkdtempSync(join(tmpdir(), 'conformance-dependency-'));
    const nested = mkdtempSync(join(tmpdir(), 'conformance-nested-'));
    try {
      for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) {
        execFileSync('git', args, { cwd: dependency });
      }
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@fixture/dependency' }));
      writeFileSync(join(dependency, 'source.ts'), 'export const dependency = 1;');
      execFileSync('git', ['add', '.'], { cwd: dependency });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dependency });
      if (layout.startsWith('nested-')) {
        for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) {
          execFileSync('git', args, { cwd: nested });
        }
        writeFileSync(join(nested, 'leaf.ts'), 'export const leaf = 1;');
        execFileSync('git', ['add', '.'], { cwd: nested });
        execFileSync('git', ['commit', '-qm', 'nested fixture'], { cwd: nested });
        execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', nested, 'nested'], { cwd: dependency });
        execFileSync('git', ['commit', '-qam', 'nested dependency'], { cwd: dependency });
      }
      git('rm', '-qr', 'libs/dependency');
      const name = layout === 'named-absorbed' ? ['--name', 'upstream-source'] : [];
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', ...name, dependency, 'libs/dependency');
      const checkout = join(root, 'libs/dependency');
      if (layout.endsWith('standalone')) {
        const metadata = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: checkout, encoding: 'utf8' }).trim();
        rmSync(checkout, { recursive: true, force: true });
        rmSync(metadata, { recursive: true, force: true });
        execFileSync('git', ['clone', '-q', '--no-hardlinks', dependency, checkout], { cwd: root });
      }
      git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
      const first = commit();
      write('docs/note.md', 'unrelated');
      const second = commit();
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: second }))
        .toEqual({ equivalent: true, reason: 'canonical semantic dependency closure matches' });
      write('libs/dependency/source.ts', 'dirty checkout is not the pinned source');
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: second }))
        .toMatchObject({ equivalent: true });
      execFileSync('git', ['checkout', '--', 'source.ts'], { cwd: checkout });
      writeFileSync(join(dependency, 'source.ts'), 'export const dependency = 2;');
      execFileSync('git', ['commit', '-qam', 'changed'], { cwd: dependency });
      const next = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dependency, encoding: 'utf8' }).trim();
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'fetch', '-q'], { cwd: join(root, 'libs/dependency') });
      execFileSync('git', ['checkout', '-q', next], { cwd: join(root, 'libs/dependency') });
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: commit() }))
        .toMatchObject({ equivalent: false });
      if (layout.endsWith('absorbed')) {
        rmSync(checkout, { recursive: true, force: true });
        expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: second }))
          .toMatchObject({ equivalent: true });
      }
      git('update-index', '--cacheinfo', '160000,' + 'f'.repeat(40) + ',libs/dependency');
      git('commit', '-qm', 'unavailable dependency pin');
      expect(await createTestContentEquivalence(root)({ file, recordedSha: first, currentSha: git('rev-parse', 'HEAD') }))
        .toMatchObject({ equivalent: false, reason: expect.stringContaining('Git dependency enumeration incomplete') });
    } finally {
      rmSync(dependency, { recursive: true, force: true });
      rmSync(nested, { recursive: true, force: true });
    }
  });
});
