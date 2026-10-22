/**
 * WI-10004674 / WI-10003465 — receipt-attribution WIRING guard.
 *
 * `sidecarReceiptMetadata` (unit-tested in sidecar-exec-lazy-receipt.test.ts)
 * was DEFINED and green while the production begin path still built its own
 * inline `{ processKind, command }` literal — so the function was dead code and
 * every live receipt lacked `gitSubcommand` / `readOnlyGit`. Testing the helper
 * can never catch that; only observing what `execProcess` actually hands the
 * governor can. This file does exactly that: the default begin path
 * (`beginSidecarProcessExecution`) runs for real, with `beginGovernedExecution`
 * captured instead of reaching Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The production governor begin path is the subject. Keep process creation
// local so this unit suite never opens the forkserver's task ledger.
vi.mock('./forkserver/forkserver-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./forkserver/forkserver-client')>()),
  spawnSidecarChild: async (req: import('./forkserver/forkserver-client').SidecarSpawnRequest) => {
    const { spawn } = await import('node:child_process');
    return spawn(req.command, req.args, { cwd: req.cwd, env: req.env, detached: req.detached,
      stdio: [req.stdin?.fd ?? 'ignore', req.stdout?.fd ?? 'pipe', 'pipe'] });
  },
}));

import type { AdmissionContext } from '../resource-governor/admission';

const governed = vi.hoisted(() => ({ begin: vi.fn() }));

vi.mock('../resource-governor/execution', async (importActual) => {
  const actual = await importActual<typeof import('../resource-governor/execution')>();
  return {
    ...actual,
    beginGovernedExecution: governed.begin,
    governedExecutionRuntime: vi.fn(() => ({})),
  };
});

import { execProcess } from './sidecar-exec-process';

function context(id: string): AdmissionContext {
  return {
    contractVersion: 1,
    requestId: id,
    rootRequestId: id,
    parentRequestId: null,
    idempotencyKey: id,
    admissionClass: 'process',
    priority: 0,
    demand: { cpuWeight: 1 },
    depth: 0,
    createdAtMs: 1,
    decisionGeneration: 1,
  };
}

beforeEach(() => {
  governed.begin.mockReset();
  governed.begin.mockImplementation(async () => ({
    receiptId: 'wiring-test',
    context: context('wiring-test'),
    lease: { leaseId: 'l', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
  }));
});

async function admittedMetadata(
  params: { command: string; args: string[] },
  lazyReceiptMs?: number,
): Promise<Record<string, unknown>> {
  const cwd = await mkdtemp(join(tmpdir(), 'sidecar-wiring-'));
  try {
    await execProcess({ ...params, cwd, workspaceId: 'ws-wiring' }, { lazyReceiptMs });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  expect(governed.begin).toHaveBeenCalledTimes(1);
  const request = governed.begin.mock.calls[0]![0] as { metadata: Record<string, unknown>; payloadRef: string };
  expect(request.payloadRef).toBe(`process:${params.command}`);
  return request.metadata;
}

describe('execProcess → governor receipt metadata (the production begin path)', () => {
  it('a read-only git exec that is admitted names its subcommand and readOnlyGit:true', async () => {
    // lazyReceiptMs:0 forces the eager branch so the begin path is observable
    // for a qualifying command without waiting out the lazy delay.
    const metadata = await admittedMetadata({ command: 'git', args: ['rev-parse', '--git-dir'] }, 0);
    expect(metadata).toEqual({
      processKind: 'sidecar-exec',
      command: 'git',
      gitSubcommand: 'rev-parse',
      readOnlyGit: true,
    });
  });

  it('a non-read-only git exec is admitted eagerly and says readOnlyGit:false', async () => {
    const metadata = await admittedMetadata({ command: 'git', args: ['status', '--porcelain'] });
    expect(metadata).toMatchObject({ command: 'git', gitSubcommand: 'status', readOnlyGit: false });
  });

  it('a non-git command carries only the base metadata (no git attribution keys)', async () => {
    const metadata = await admittedMetadata({ command: 'node', args: ['-e', '0'] });
    expect(metadata).toEqual({ processKind: 'sidecar-exec', command: 'node' });
  });
});
