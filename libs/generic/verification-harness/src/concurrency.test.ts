import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessContract } from './contract.js';
import { runHarness } from './runner.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-conc-'));
let canonical: string;
beforeEach(() => {
  canonical = tmp();
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', canonical);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(canonical, { recursive: true, force: true });
});

/** A battery: independent scenarios plus one phase that needs the first scenario to pass. */
const contract: HarnessContract = {
  name: 'battery',
  phases: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 'report', dependsOn: ['s1'] }],
};

describe('runHarness concurrency', () => {
  it('runs independent phases side by side within the bound, keeps declaration order and never-abort', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: tmp(),
      concurrency: 2,
      runPhase: async (ctx) => {
        started.push(ctx.phase);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ctx.phase === 's1' ? 60 : 20));
        inFlight--;
        return ctx.phase === 's2' ? { ok: false, reasonCode: 'judge-error' } : { ok: true };
      },
    });
    expect(peak).toBe(2);
    // The first two ADMITTED are s1 and s2 (FIFO slots, declaration order). Their fn-call order is
    // not guaranteed: each awaits its phase-dir mkdir first, so they race there (flaked under load).
    expect([...started.slice(0, 2)].sort()).toEqual(['s1', 's2']);
    expect(result.phases.map((p) => [p.phase, p.status])).toEqual([
      ['s1', 'passed'],
      ['s2', 'failed'],
      ['s3', 'passed'],
      ['s4', 'passed'],
      ['report', 'passed'],
    ]);
    expect(result.firstFailure).toEqual({ phase: 's2', step: null, reasonCode: 'judge-error' });
  });

  it('a dependent phase waits for its dependency and is blocked when it fails', async () => {
    const result = await runHarness({
      contract,
      evidenceRoot: tmp(),
      concurrency: 4,
      runPhase: async (ctx) => (ctx.phase === 's1' ? { ok: false, reasonCode: 'boom' } : { ok: true }),
    });
    expect(result.phases.find((p) => p.phase === 'report')).toMatchObject({ status: 'blocked', reasonCode: 'dependency:s1:failed' });
  });

  it('concurrency 1 keeps the strict declaration-order execution', async () => {
    const started: string[] = [];
    await runHarness({
      contract,
      evidenceRoot: tmp(),
      runPhase: async (ctx) => {
        started.push(ctx.phase);
        return { ok: true };
      },
    });
    expect(started).toEqual(['s1', 's2', 's3', 's4', 'report']);
  });
});
