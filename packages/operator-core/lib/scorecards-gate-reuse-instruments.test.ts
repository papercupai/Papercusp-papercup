import { describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import { GATE_REUSE_AUDIT_INSTRUMENT_KEY } from './release/gate-fire-ledger';
import type { Rubric } from './rubrics';

const key = GATE_REUSE_AUDIT_INSTRUMENT_KEY;
const rubric = { workspaceId: 'ws', subjectHarnessSlug: 'install', subjectPlan: 'reuse-plan',
  criteria: [{ key: 'audit', check: { kind: 'instrument', instrumentKey: key } }] } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: 'reuse-plan',
  windowStart: '2026-10-05T10:00:00Z', windowEnd: '2026-10-05T11:00:00Z' };
const now = () => Date.parse('2026-10-05T12:00:00Z');
const measurement = (verdict: 'pass' | 'fail' | 'unknown') => ({ verdict, reason: 'measured', fireIds: ['fire'],
  excludedFireIds: [], runIds: ['run'], audited: 5, alarms: verdict === 'fail' ? 1 : 0,
  evidenceRefs: ['pipeline-event:1'], populationStatus: 'complete' as const, totalEvents: 2 });

describe('canonical gate reuse audit instrument', () => {
  it.each(['pass', 'fail', 'unknown'] as const)('uses independently measured %s over a supplied pass', async (verdict) => {
    const gateReuseAudit = vi.fn(async () => measurement(verdict));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject,
      supplied: { [key]: { verdict: 'pass', measuredAt: new Date(now()).toISOString(), provenance: 'platform-computed' } } },
    { now, gateReuseAudit });
    expect(gateReuseAudit).toHaveBeenCalledWith({ workspaceId: 'ws', installSlug: 'install',
      windowStartMs: Date.parse(subject.windowStart), windowEndMs: Date.parse(subject.windowEnd) });
    expect(snapshots?.[key]).toMatchObject({ verdict, provenance: 'platform-computed',
      evidenceRef: 'harness_shared.pipeline_events:gate-reuse-audit-window', value: measurement(verdict) });
  });

  it.each([
    { ...subject, ref: 'foreign-plan' }, { ...subject, windowEnd: '2026-10-05T13:00:00Z' },
    { ...subject, windowEnd: subject.windowStart },
  ])('refuses an invalid/foreign/unfinished observation window', async (badSubject) => {
    const gateReuseAudit = vi.fn(async () => measurement('pass'));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject: badSubject }, { now, gateReuseAudit });
    expect(snapshots?.[key]?.verdict).toBe('unknown');
    expect(gateReuseAudit).not.toHaveBeenCalled();
  });

  it('keeps a failed archive read unknown', async () => {
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject },
      { now, gateReuseAudit: async () => { throw new Error('archive unreadable'); } });
    expect(snapshots?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
  });
});
