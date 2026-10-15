import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireAcceptanceDependencies } from './release-acceptance-cache';
import type { HolderScan } from '../release-cut-reclaim';

const idle = async (): Promise<HolderScan> => ({ verified: true, holders: new Map() });
describe('PUI acceptance dependency retirement', () => {
  let cache: string;
  let checkout: string;
  let sha: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), 'pui-cache-retirement-'));
    checkout = join(cache, 'slot-1');
    await mkdir(checkout);
    execFileSync('git', ['init', '-q', checkout]);
    await writeFile(join(checkout, 'source.txt'), 'source evidence');
    // Fixture commits are private test repositories, not the shared tree.
    execFileSync('git', ['-C', checkout, 'add', 'source.txt']);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    sha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    for (const tree of ['node_modules', 'apps/operator/node_modules']) {
      await mkdir(join(checkout, tree), { recursive: true });
      await writeFile(join(checkout, tree, 'package.txt'), 'rebuildable');
    }
    await mkdir(join(checkout, '.papercusp-artifacts'));
    await writeFile(join(checkout, '.papercusp-artifacts', 'receipt.json'), 'retained');
  });
  afterEach(async () => { await rm(cache, { recursive: true, force: true }); });

  it('previews and retires only named dependencies while retaining source and receipts', async () => {
    const input = { checkout, expectedSha: sha, trees: ['node_modules'], scan: idle };
    expect((await retireAcceptanceDependencies(input)).removed).toEqual([]);
    expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    expect((await retireAcceptanceDependencies({ ...input, execute: true })).removed).toEqual([join(checkout, 'node_modules')]);
    await expect(readFile(join(checkout, 'node_modules/package.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('source evidence');
    expect(await readFile(join(checkout, '.papercusp-artifacts/receipt.json'), 'utf8')).toBe('retained');
    expect(await readFile(join(checkout, 'apps/operator/node_modules/package.txt'), 'utf8')).toBe('rebuildable');
  });

  it.each(['../node_modules', 'source.txt', 'node_modules/nested', '/node_modules'])('rejects out-of-scope target %s', async (tree) => {
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: [tree], execute: true, scan: idle })).rejects.toThrow('not a dependency tree');
  });
  it('refuses stale source commits and symlinked dependency paths', async () => {
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: '0'.repeat(40), trees: ['node_modules'], scan: idle })).rejects.toThrow('source commit changed');
    await mkdir(join(cache, 'outside'));
    await symlink(join(cache, 'outside'), join(checkout, 'packages'));
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['packages/other/node_modules'], scan: idle })).resolves.toMatchObject({ candidates: [] });
    await mkdir(join(cache, 'outside/other/node_modules'), { recursive: true });
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['packages/other/node_modules'], execute: true, scan: idle })).rejects.toThrow('physical directory');
  });
  it('refuses live or unverified process use before deleting anything', async () => {
    for (const result of [{ verified: false, holders: new Map() }, { verified: true, holders: new Map([[checkout, ['live']]]) }]) {
      await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, trees: ['node_modules'], execute: true, scan: async () => result })).rejects.toThrow();
      expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    }
  });
  it('discovers completed-slot copies while preserving archives, source and receipts', async () => {
    await mkdir(join(checkout, 'packages/example/node_modules'), { recursive: true });
    await writeFile(join(checkout, 'packages/example/node_modules/package.txt'), 'rebuildable');
    await writeFile(join(checkout, 'candidate.tar.gz'), 'archive evidence');
    const result = await retireAcceptanceDependencies({ checkout, expectedSha: sha, execute: true, scan: idle });
    expect(result.removed).toEqual([
      join(checkout, 'node_modules'), join(checkout, 'apps/operator/node_modules'), join(checkout, 'packages/example/node_modules'),
    ]);
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('source evidence');
    expect(await readFile(join(checkout, '.papercusp-artifacts/receipt.json'), 'utf8')).toBe('retained');
    expect(await readFile(join(checkout, 'candidate.tar.gz'), 'utf8')).toBe('archive evidence');
    expect((await retireAcceptanceDependencies({ checkout, expectedSha: sha, execute: true, scan: idle })).removed).toEqual([]);
  });
  it('automatic discovery refuses symlinked scopes without removing any copies', async () => {
    await mkdir(join(cache, 'outside'));
    await symlink(join(cache, 'outside'), join(checkout, 'packages'));
    await expect(retireAcceptanceDependencies({ checkout, expectedSha: sha, execute: true, scan: idle })).rejects.toThrow('scope is not a physical directory');
    expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
  });
  it.each([
    { status: 0, cleanupRefused: false, symlinkedSlotOne: false },
    { status: 1, cleanupRefused: false, symlinkedSlotOne: false },
    { status: 2, cleanupRefused: false, symlinkedSlotOne: false },
    { status: 0, cleanupRefused: true, symlinkedSlotOne: false },
    { status: 0, cleanupRefused: false, symlinkedSlotOne: true },
  ])('runs the actual wrapper lifecycle: $status, cleanup refused=$cleanupRefused, symlinked slot=$symlinkedSlotOne', async ({ status, cleanupRefused, symlinkedSlotOne = false }) => {
    if (symlinkedSlotOne) {
      const secondSlot = join(cache, 'slot-2');
      await rename(checkout, secondSlot);
      await symlink(secondSlot, checkout);
      checkout = secondSlot;
    }
    const repo = resolve(__dirname, '../../../..');
    const fixture = join(cache, 'runner');
    const wrapper = join(fixture, 'apps/tui/scripts/release-acceptance.sh');
    await mkdir(join(fixture, 'apps/tui/scripts'), { recursive: true });
    await writeFile(wrapper, await readFile(join(repo, 'apps/tui/scripts/release-acceptance.sh')));
    await mkdir(join(fixture, 'scripts'));
    // Emulate materialization after the real wrapper has retired crash residue.
    await writeFile(join(fixture, 'scripts/npm-install-safe.mjs'), `import fs from 'node:fs';
const checkout=${JSON.stringify(checkout)};
if (fs.existsSync(checkout+'/node_modules/package.txt') || fs.existsSync(checkout+'/apps/operator/node_modules/package.txt')) process.exit(44);
fs.mkdirSync(checkout+'/node_modules/.bin', {recursive:true});
fs.copyFileSync(${JSON.stringify(join(fixture, 'runner.sh'))}, checkout+'/node_modules/.bin/tsx');
fs.chmodSync(checkout+'/node_modules/.bin/tsx', 0o755);
fs.writeFileSync(checkout+'/node_modules/package.txt', 'rebuildable');
fs.mkdirSync(checkout+'/apps/operator/node_modules', {recursive:true});
fs.writeFileSync(checkout+'/apps/operator/node_modules/package.txt', 'rebuildable');
fs.writeFileSync(checkout+'/.papercusp-artifacts/prepared.json', 'old copies retired');
`);
    const shim = join(fixture, 'node_modules/.bin/tsx');
    await mkdir(join(fixture, 'node_modules/.bin'), { recursive: true });
    await writeFile(shim, `#!/usr/bin/env node
const fs=require('node:fs');
const calls=${JSON.stringify(join(fixture, 'calls'))};
const n=fs.existsSync(calls)?Number(fs.readFileSync(calls,'utf8')):0;
fs.writeFileSync(calls,String(n+1));
${cleanupRefused ? 'if(n>0) process.exit(2);' : ''}
const {spawnSync} = require('node:child_process');
const r=spawnSync(${JSON.stringify(join(repo, 'node_modules/.bin/tsx'))}, [${JSON.stringify(join(repo, 'packages/operator-core/lib/pui-e2e/release-acceptance-cache.ts'))}, ...process.argv.slice(3)], {stdio:'inherit'});
process.exit(r.status ?? 2);
`);
    await chmod(shim, 0o755);
    const runner = join(checkout, 'node_modules/.bin/tsx');
    await mkdir(join(checkout, 'node_modules/.bin'));
    await writeFile(runner, `#!/bin/sh\nprintf 'completed' > '${join(checkout, '.papercusp-artifacts/run.json')}'\nexit ${status}\n`);
    await chmod(runner, 0o755);
    await writeFile(join(fixture, 'runner.sh'), await readFile(runner));
    const archiveSource = join(cache, 'archive-source');
    await mkdir(join(archiveSource, 'pui'), { recursive: true });
    await writeFile(join(archiveSource, 'pui/PROVENANCE.json'), JSON.stringify({ source: { commit: sha } }));
    const archive = join(cache, 'candidate.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', archiveSource, 'pui']);
    const child = spawn('bash', [wrapper, '--archive', archive], {
      cwd: repo, env: { ...process.env, PUI_ACCEPTANCE_ISOLATED: '', PUI_ACCEPTANCE_ALLOW_LIVE_TREE: '', PUI_ACCEPTANCE_CHECKOUT_ROOT: cache },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    expect(code, stderr).toBe(cleanupRefused ? 2 : status);
    if (symlinkedSlotOne) expect(stderr).toContain('skipping symlinked checkout slot 1');
    if (cleanupRefused) {
      expect(stderr).toContain('dependency retirement refused');
      expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    } else {
      await expect(readFile(join(checkout, 'node_modules/package.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(checkout, 'apps/operator/node_modules/package.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(checkout, '.papercusp-artifacts/run.json'), 'utf8')).toBe('completed');
    expect(await readFile(join(checkout, '.papercusp-artifacts/prepared.json'), 'utf8')).toBe('old copies retired');
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('source evidence');
    expect(await readFile(archive)).not.toHaveLength(0);
  }, 45_000);
  it('the existing wrapper refuses retirement while a slot lock is held', async () => {
    const child = spawn('flock', [join(cache, 'slot-1.lock'), 'sh', '-c', 'echo READY; cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const result = spawnSync('bash', [resolve(__dirname, '../../../../apps/tui/scripts/release-acceptance.sh'), '--retire-dependencies', '1', sha, 'node_modules', '--execute'], {
        env: { ...process.env, PUI_ACCEPTANCE_CHECKOUT_ROOT: cache }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('slot 1 is held');
      expect(await readFile(join(checkout, 'node_modules/package.txt'), 'utf8')).toBe('rebuildable');
    } finally {
      child.stdin.end();
      if (child.exitCode === null) await once(child, 'close');
    }
  });
});
