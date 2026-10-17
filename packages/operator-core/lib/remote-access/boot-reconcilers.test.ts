/**
 * WI-10004423 regression guard: every operator process shape that is the host singleton arms the
 * portal relay reconciler, not only the forked cluster's primary.
 *
 * Before the fix, hono-host armed the relay reconciler only inside its `clusterWorkers > 1`
 * primary block. A single-process host (every desktop install) never entered that block, so an
 * approved relay link was polled once, when Connect was pressed, and never finished.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClusterHandle } from '../cluster-fork';
import {
  httpServingProcessRole,
  remoteAccessReconcilersFor,
  startRemoteAccessReconcilers,
  type RemoteAccessReconciler,
} from './boot-reconcilers';

describe('remote-access reconcilers per process role', () => {
  it('a single-process host and a cluster primary arm both reconcilers', () => {
    expect(remoteAccessReconcilersFor('single-process')).toEqual(['own-tunnel', 'portal-relay']);
    expect(remoteAccessReconcilersFor('cluster-primary')).toEqual(['own-tunnel', 'portal-relay']);
  });

  it('a forked request worker arms only its own-tunnel listener, never the relay', () => {
    expect(remoteAccessReconcilersFor('cluster-worker')).toEqual(['own-tunnel']);
  });

  it('an HTTP-serving process with a standalone or primary handle is a single-process host; a worker handle is a worker', () => {
    expect(httpServingProcessRole({ role: 'single' })).toBe('single-process');
    expect(httpServingProcessRole({ role: 'primary' })).toBe('single-process');
    expect(httpServingProcessRole({ role: 'worker' })).toBe('cluster-worker');
    expect(httpServingProcessRole(null)).toBe('single-process');
  });

  it.each(['primary', 'single'] as const)('a %s handle starts both singleton reconcilers while a worker starts only its listener', (role) => {
    const calls: RemoteAccessReconciler[] = [];
    const starters = {
      'own-tunnel': () => { calls.push('own-tunnel'); },
      'portal-relay': () => { calls.push('portal-relay'); },
    };
    const clusterHandle: ClusterHandle = { role, workerCount: 0 };
    expect(startRemoteAccessReconcilers(httpServingProcessRole(clusterHandle), starters))
      .toEqual(['own-tunnel', 'portal-relay']);
    expect(calls).toEqual(['own-tunnel', 'portal-relay']);
    calls.length = 0;
    startRemoteAccessReconcilers('cluster-worker', starters);
    expect(calls).toEqual(['own-tunnel']);
  });
});

describe('boot wiring: hono-host.ts arms the remote-access reconcilers on BOTH boot paths (WI-10004423)', () => {
  // BOOT_RECONCILERS_HONO_HOST points the check at a copy, so a mutation probe never edits the real file.
  const honoHostPath = process.env.BOOT_RECONCILERS_HONO_HOST
    ?? path.join(__dirname, '../../../../apps/operator/bin/hono-host.ts');
  const source = readFileSync(honoHostPath, 'utf8');
  // Line and block comments are removed so a call named only in a comment cannot satisfy a check.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The text of the block that opens at `marker`, up to its matching close brace. */
  function blockAfter(marker: string): string {
    const at = code.indexOf(marker);
    expect(at, `hono-host.ts no longer contains ${JSON.stringify(marker)}`).toBeGreaterThanOrEqual(0);
    const open = code.indexOf('{', at + marker.length - 1);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}' && (depth -= 1) === 0) return code.slice(open, i + 1);
    }
    throw new Error(`unbalanced block after ${marker}`);
  }

  it('the HTTP-serving (onWorker) path arms them for its own role — the path a single-process host takes', () => {
    const onWorker = blockAfter('onWorker: () => {');
    expect(onWorker).toContain('startRequestServers()'); // positive control: the right block
    expect(onWorker).toMatch(/startRemoteAccessReconcilers\(\s*httpServingProcessRole\(\s*clusterHandle\s*\)\s*\)/);
  });

  it('the cluster-primary path arms them as the cluster primary', () => {
    const primary = blockAfter("clusterHandle.role === 'primary' && clusterWorkers > 1) {");
    expect(primary).toMatch(/startRemoteAccessReconcilers\(\s*'cluster-primary'\s*\)/);
  });

  it('never calls either starter directly, so the two cannot be armed on different paths again', () => {
    expect(code).toContain('startRemoteAccessReconcilers('); // positive control: source was read
    expect(code).not.toMatch(/\bstartPortalRelayReconciler\s*\(/);
    expect(code).not.toMatch(/\bstartOwnTunnelReconciler\s*\(/);
  });
});
