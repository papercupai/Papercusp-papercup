import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveApplicationRuntimeLaunch, type ApplicationRuntimeCandidate,
  type ApplicationRuntimeAcceptance } from './bundled-node';

const exec = promisify(execFile);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
let root: string;
let candidate: ApplicationRuntimeCandidate;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinned-application-runtime-'));
  const executable = await realpath(process.execPath);
  const entrypoint = join(root, 'entry with spaces.mjs');
  const source = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';
  await writeFile(entrypoint, source);
  candidate = { candidateSha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40), roles: ['request', 'background'], entrypoint,
    entrypointSha256: digest(source), node: { name: 'node', executable,
      binarySha256: digest(await readFile(executable)), version: process.versions.node,
      platform: process.platform, arch: process.arch } };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const pretendBun = () => { candidate.bun = { ...candidate.node, name: 'bun' }; };
const acceptance = (): ApplicationRuntimeAcceptance => ({ verdict: 'accepted', evidenceRef: 'accepted:fixture',
  candidateSha256: candidate.candidateSha256, sourceSha: candidate.sourceSha, role: 'request',
  binarySha256: candidate.bun!.binarySha256, nodeBinarySha256: candidate.node.binarySha256,
  entrypointSha256: candidate.entrypointSha256, validUntil: Date.now() + 60_000 });

describe('pinned application runtime selection', () => {
  it('checks pinned bytes before running even an identity probe', async () => {
    const untrusted = join(root, 'changed-node');
    await writeFile(untrusted, '#!/bin/sh\n: > "$0.executed"\nexit 5\n', { mode: 0o755 });
    candidate.node = { ...candidate.node, executable: untrusted };
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request' }))
      .rejects.toThrow('Runtime binary digest mismatch');
    await expect(readFile(`${untrusted}.executed`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaults to pinned Node and passes arguments literally through a real process', async () => {
    const args = ['--eval', '$(do-not-run)', 'one two', 'quote"and\\slash'];
    const launch = await resolveApplicationRuntimeLaunch({ candidate, role: 'request', args,
      env: { NODE_OPTIONS: '--import=bad.mjs', NODE_PATH: '/bad', BUN_OPTIONS: '--preload=bad.mjs', KEEP: 'yes' } });
    expect(launch.runtime.name).toBe('node');
    expect(launch.executable).toBe(candidate.node.executable);
    expect(launch.env).toEqual({ KEEP: 'yes' });
    const child = await exec(launch.executable, launch.args, { env: launch.env });
    expect(JSON.parse(child.stdout)).toEqual(args);
    expect(launch.nodeRollback).toEqual(candidate.node);
  });

  it('resolves the retained Node artifact for rollback', async () => {
    const launch = await resolveApplicationRuntimeLaunch({ candidate, role: 'background', purpose: 'rollback' });
    expect(launch.runtime.name).toBe('node');
    expect(launch.args[0]).toBe(candidate.entrypoint);
    pretendBun();
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'background', purpose: 'rollback', runtime: 'bun' }))
      .rejects.toThrow(/Rollback selects retained Node/);
  });

  it('refuses an absent or relative Node rollback pin instead of guessing PATH', async () => {
    candidate.node.executable = 'node';
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request' })).rejects.toThrow(/explicit node/);
    candidate.node.executable = join(root, 'missing-node');
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request' })).rejects.toThrow();
  });

  it.each(['binarySha256', 'version', 'platform', 'arch'] as const)('rejects a changed Node %s pin', async field => {
    candidate.node[field] = field === 'binarySha256' ? 'c'.repeat(64) : 'wrong';
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request' })).rejects.toThrow(/mismatch|identity/);
  });

  it('rejects changed application bytes', async () => {
    await writeFile(candidate.entrypoint, 'process.exit(0)');
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request' })).rejects.toThrow(/entrypoint digest/);
  });

  it('refuses eval and preload flags as runtime arguments', async () => {
    for (const runtimeArgs of [['--eval', 'process.exit(0)'], ['--import=bad.mjs'], ['--']]) {
      await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtimeArgs }))
        .rejects.toThrow(/Unsupported/);
    }
  });

  it('rejects a well-formed role outside the explicit candidate population', async () => {
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'not-in-this-candidate' }))
      .rejects.toThrow(/role census/);
  });

  it('rejects malformed argument and role populations instead of spreading strings', async () => {
    for (const patch of [{ args: 'text' }, { runtimeArgs: '--expose-gc' },
      { candidate: { ...candidate, roles: 'request' } }]) {
      await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', ...patch } as never))
        .rejects.toThrow(/Malformed/);
    }
  });

  it('requires the canonical acceptance reader before operational Bun selection', async () => {
    pretendBun();
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtime: 'bun' }))
      .rejects.toThrow(/Canonical Bun acceptance/);
  });

  it.each(['verdict', 'candidateSha256', 'sourceSha', 'role', 'binarySha256', 'nodeBinarySha256',
    'entrypointSha256', 'evidenceRef', 'validUntil'] as const)
    ('rejects wrong or stale acceptance %s', async field => {
      pretendBun();
      const receipt = { ...acceptance(), [field]: field === 'validUntil' ? Date.now() - 1 : 'wrong' };
      await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtime: 'bun',
        acceptanceRef: 'accepted:fixture', verifyAcceptance: vi.fn().mockResolvedValue(receipt) }))
        .rejects.toThrow(/Matching current candidate acceptance/);
    });

  it('does not call a Node executable Bun even with matching acceptance metadata', async () => {
    pretendBun();
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtime: 'bun',
      acceptanceRef: 'accepted:fixture', verifyAcceptance: vi.fn().mockResolvedValue(acceptance()) }))
      .rejects.toThrow(/Runtime identity/);
  });

  it('measures the actual interpreter for isolated candidates as well', async () => {
    pretendBun();
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtime: 'bun', purpose: 'isolated-candidate' }))
      .rejects.toThrow(/Runtime identity/);
  });

  it('snapshots input so an acceptance reader cannot change the selection under validation', async () => {
    pretendBun();
    const receipt = acceptance();
    await expect(resolveApplicationRuntimeLaunch({ candidate, role: 'request', runtime: 'bun',
      acceptanceRef: 'accepted:fixture', verifyAcceptance: async () => {
        candidate.bun!.name = 'node';
        candidate.entrypoint = join(root, 'not-the-original.mjs');
        return receipt;
      } })).rejects.toThrow(/Runtime identity/);
  });

  // An explicit Bun path runs the SAME real-process roundtrip with Bun. An ordinary
  // Node-only suite makes no claim about Bun availability or compatibility.
  const configuredBun = process.env.PAPERCUSP_RUNTIME_TEST_BUN;
  it.each(['isolated-candidate', 'operational'] as const)
    (`launches a real ${configuredBun ? 'Bun' : 'Node'} process for %s with the configured pin`, async purpose => {
      if (configuredBun) {
        const executable = await realpath(configuredBun);
        const measured = await exec(executable, ['-e', 'process.stdout.write(JSON.stringify({version:process.versions.bun,platform:process.platform,arch:process.arch}))'],
          { env: {}, timeout: 5000 });
        const identity = JSON.parse(measured.stdout);
        candidate.bun = { name: 'bun', executable, binarySha256: digest(await readFile(executable)), ...identity };
      }
      const launch = await resolveApplicationRuntimeLaunch({ candidate, role: 'request', purpose,
        runtime: configuredBun ? 'bun' : 'node', args: ['literal argument', '--eval', '$(never-a-shell)'],
        acceptanceRef: 'accepted:fixture', verifyAcceptance: async () => acceptance(), env: {} });
      expect(launch.runtime.name).toBe(configuredBun ? 'bun' : 'node');
      expect(launch.nodeRollback.name).toBe('node');
      const result = await exec(launch.executable, launch.args, { env: launch.env, timeout: 5000 });
      expect(JSON.parse(result.stdout)).toEqual(['literal argument', '--eval', '$(never-a-shell)']);
    });
});
