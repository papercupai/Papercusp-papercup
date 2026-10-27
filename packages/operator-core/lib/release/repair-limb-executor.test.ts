/**
 * gate-repair-plane-on-current-build-2026-10-15 R-1: the executor stamp every repair-limb record
 * carries. The build comes from the writing process's resolved build info — the three injected
 * resolutions (baked, env, unresolved) plus the boot-time git rung — never a checkout read.
 */
import { describe, expect, it } from 'vitest';
import { resolveBuild as resolveBuildInfo } from '../build-info';
import {
  executingBuildFrom,
  parseRepairLimbExecutor,
  repairLimbExecutorFrom,
  sameRepairLimbExecutor,
} from './repair-limb-executor';

const host = { host: 'port-3271', processId: 'boot-a:4242' };
const noEnv = {} as NodeJS.ProcessEnv;

describe('executingBuildFrom', () => {
  it('baked: a bundle names the sha baked into it, not the checkout HEAD', () => {
    const info = resolveBuildInfo({ env: noEnv, bakedSha: 'bundle1', bundled: true, gitSha: () => 'checkout' });
    expect(executingBuildFrom(info)).toEqual({ sha: 'bundle1', source: 'baked' });
  });

  it('env: a deploy-time PAPERCUSP_BUILD_SHA is named as such', () => {
    const info = resolveBuildInfo({ env: { PAPERCUSP_BUILD_SHA: 'env1234' } as NodeJS.ProcessEnv, bakedSha: null });
    expect(executingBuildFrom(info)).toEqual({ sha: 'env1234', source: 'env' });
  });

  it('unresolved: an identity-less bundle records a null sha, never the checkout HEAD', () => {
    const info = resolveBuildInfo({ env: noEnv, bakedSha: null, bundled: true, gitSha: () => 'checkout' });
    expect(executingBuildFrom(info)).toEqual({ sha: null, source: 'unresolved' });
  });

  it('git: a non-bundled host names its one boot-time rev-parse', () => {
    const info = resolveBuildInfo({ env: noEnv, bakedSha: null, bundled: false, gitSha: () => 'boot123' });
    expect(executingBuildFrom(info)).toEqual({ sha: 'boot123', source: 'git' });
  });

  it('never pairs a sha with `unresolved`, nor `unresolved`-less with a null sha', () => {
    expect(executingBuildFrom({ sha: 'abc', shaSource: 'unresolved' })).toEqual({ sha: null, source: 'unresolved' });
    expect(executingBuildFrom({ sha: null, shaSource: 'env' })).toEqual({ sha: null, source: 'unresolved' });
    expect(executingBuildFrom({ sha: '   ', shaSource: 'baked' })).toEqual({ sha: null, source: 'unresolved' });
  });
});

describe('repairLimbExecutorFrom / parseRepairLimbExecutor', () => {
  it('round-trips a stamp through JSON', () => {
    const stamp = repairLimbExecutorFrom(host, { sha: 'bundle1', shaSource: 'baked' });
    expect(stamp).toEqual({ hostId: 'port-3271', processId: 'boot-a:4242', executingBuild: { sha: 'bundle1', source: 'baked' } });
    expect(parseRepairLimbExecutor(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
  });

  it('reads a malformed or self-contradicting stamp as absent', () => {
    expect(parseRepairLimbExecutor(null)).toBeUndefined();
    expect(parseRepairLimbExecutor({ hostId: '', executingBuild: { sha: 'a', source: 'env' } })).toBeUndefined();
    expect(parseRepairLimbExecutor({ hostId: 'h', executingBuild: { sha: 'a', source: 'unresolved' } })).toBeUndefined();
    expect(parseRepairLimbExecutor({ hostId: 'h', executingBuild: { sha: null, source: 'env' } })).toBeUndefined();
    expect(parseRepairLimbExecutor({ hostId: 'h', executingBuild: { sha: 'a', source: 'checkout' } })).toBeUndefined();
  });

  it('distinguishes two generations of one service by process id', () => {
    const a = repairLimbExecutorFrom(host, { sha: 'x', shaSource: 'env' });
    const b = repairLimbExecutorFrom({ ...host, processId: 'boot-b:5151' }, { sha: 'x', shaSource: 'env' });
    expect(sameRepairLimbExecutor(a, a)).toBe(true);
    expect(sameRepairLimbExecutor(a, b)).toBe(false);
  });
});
