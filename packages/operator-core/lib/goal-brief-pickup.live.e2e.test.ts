/**
 * Runner-backed R-2 pickup evidence. Reuses the read-only live ledger probe;
 * the maintained e2e config supplies the measured layer, never the probe JSON.
 * Enable with PAPERCUSP_GOAL_BRIEF_LIVE=1 npm run test:file -- <this file>.
 * A skipped default run is not acceptance evidence. No ledger writes or launches.
 */
import { describe, expect, it } from 'vitest';
import { observe } from './goal-brief-live-probe.test-helper';

describe.skipIf(process.env.PAPERCUSP_GOAL_BRIEF_LIVE !== '1')('goal brief live pickup', () => {
  it('R-2 observes valid delegated pickup or a current typed blocker', async () => {
    const { status, evidence } = await observe(false);
    expect(status, JSON.stringify(evidence)).toBe(0);
    // The probe's residualUnknowns also carries methodology disclosures. Judge
    // the measured lineage verdicts, rather than treating that prose as a count.
    for (const lineage of evidence.observations.lineages) {
      expect(['pass', 'no-goal-stamped-plan-work'], JSON.stringify(lineage)).toContain(lineage.verdict);
    }
    for (const id of ['auto-bar-r-2-p-003', 'auto-bar-r-2-p-007']) {
      expect(evidence.assertions.find((assertion) => assertion.id === id)?.passed, id).toBe(true);
    }
    expect(evidence.assertions.every((assertion) => assertion.passed)).toBe(true);
  }, 70_000);

  it('R-2 rejects a fleet scope mismatch against the same live ledger', async () => {
    const { status, evidence } = await observe(true);
    expect(status).toBe(1);
    for (const id of ['r2-clean-lineage-exists', 'auto-bar-r-2-p-003', 'auto-bar-r-2-p-007']) {
      const assertion = evidence.assertions.find((entry) => entry.id === id);
      expect(assertion, id).toBeDefined();
      expect(assertion?.passed, id).toBe(false);
    }
  }, 70_000);

  it('R-4 detects a duplicate launch in an observed refusal window', async () => {
    const { status, evidence } = await observe(true, 'R4');
    expect(status).toBe(1);
    const assertion = evidence.assertions.find((entry) => entry.id === 'r4-no-duplicate-launch');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(false);
    expect(assertion?.status).toBe('fail');
  }, 70_000);
});
