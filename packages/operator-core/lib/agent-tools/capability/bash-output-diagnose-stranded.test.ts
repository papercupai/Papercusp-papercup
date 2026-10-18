import { describe, it, expect } from 'vitest';
import { diagnoseStrandedCause } from './bash_output';

describe('registry-miss diagnosis (EI-26318318890682382)', () => {
  it('does not infer a restart or task death from a newer reader worker', () => {
    expect(diagnoseStrandedCause({
      now: 1_000_000, jobBirthtimeMs: 400_000, processUptimeMs: 120_000,
    })).toBe('job_liveness_unknown');
  });

  it('keeps liveness unknown for every relative worker/log age, including absent clock inputs', () => {
    const now = 1_000_000;
    for (const offset of [-3_600_000, -60_000, -1, 0, 1, 60_000, 3_600_000]) {
      for (const uptime of [0, 1, 60_000, 3_600_000, 24 * 3_600_000]) {
        expect(diagnoseStrandedCause({ now, jobBirthtimeMs: now + offset, processUptimeMs: uptime }))
          .toBe('job_liveness_unknown');
      }
    }
    expect(diagnoseStrandedCause({ jobBirthtimeMs: Date.now() - 1_000_000 }))
      .toBe('job_liveness_unknown');
  });
});
