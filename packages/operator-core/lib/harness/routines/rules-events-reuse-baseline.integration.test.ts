import { describe, expect, it } from 'vitest';
import { measureRoutineCost } from '../../../test/_rules-events-reuse-cost';

describe.each(['fleet-headcount-governor', 'external-trigger-dispatch', 'personal-vault-import'])('%s actual baseline', routine => {
  it('records isolated action CPU and SQL samples with real maintenance controls and refuses an unsupported scheduling verdict', async () => {
    const proof = await measureRoutineCost(routine);
    expect(proof.routine).toBe(routine);
    expect(proof.samples).toHaveLength(60);
    expect(proof.samples.filter((sample: { kind: string }) => sample.kind === 'idle')).toHaveLength(30);
    expect(proof.samples.filter((sample: { stateChanged: boolean }) => sample.stateChanged)).toHaveLength(30);
    for (const sample of proof.samples) {
      expect(sample.statements).toBeGreaterThan(0);
      expect(sample.cpuMicros).toBeGreaterThan(0);
      expect(sample.elapsedMs).toBeGreaterThan(0);
    }
    expect(proof.productionNoOpShare.status).toBe('unknown');
    expect(proof.latencyComparison.status).toBe('not-measured');
    expect(proof.r4Decision).toMatch(/^non-passing:/);
    expect(proof.cleanup.postgresConnectionRefused).toBe(true);
    expect(proof.buildSha).toMatch(/^[a-f0-9]{40}$/);
    for (const hash of Object.values(proof.sourceHashes)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
    console.log('RULES_EVENTS_BASELINE_SUMMARY=' + JSON.stringify({ routine, processId: proof.processId,
      cpu: proof.idleCpuMicrosPerFire, queries: proof.idleStatementsPerFire, cleanup: proof.cleanup,
      r4Decision: proof.r4Decision }));
  }, 330_000);
});
