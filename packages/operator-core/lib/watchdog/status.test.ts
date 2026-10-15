import { describe, expect, it, vi } from 'vitest';
import { classifyScheduledWatchdogStatus, readScheduledWatchdogStatus, type ScheduledWatchdogStatus } from './status';

function base(patch: Partial<Pick<ScheduledWatchdogStatus, 'config' | 'scheduler' | 'eligibility' | 'fire'>> = {}) {
  return {
    id: 'su-ideate-ungraded' as const,
    scope: { workspaceId: 'ws', harnessSlug: 'pot' },
    config: {
      enabled: true,
      effectiveThresholdSec: 604_800,
      overrideSource: 'default' as const,
      overrideEnv: 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC' as const,
      rawOverride: null,
      // P-001: the whole per-origin floor policy, not one origin's epochMs.
      policy: { byOrigin: { 'su-ideate': 1 }, fallbackMs: 1 },
      batchCap: 10,
      ...patch.config,
    },
    scheduler: {
      kind: 'dbos-operation' as const,
      parentWorkflow: 'routinesSweepTick' as const,
      operation: 'su-ideate-ungraded-sweep' as const,
      lastExecutionAt: '2026-07-19T00:01:00.000Z',
      lastWorkflowStatus: 'SUCCESS',
      lastError: null,
      internalErrorCount: 0,
      lastResultCount: null,
      lastNudgedCount: null,
      ...patch.scheduler,
    },
    eligibility: {
      byOrigin: {},
      total: { pendingCount: 0, eligibleCount: 0, oldestRoutedAt: null, firstEligibleAt: null },
      ...patch.eligibility,
    },
    fire: {
      source: 'su-ideate-ungraded' as const,
      count: 0,
      lastFireAt: null,
      lastReason: null,
      ...patch.fire,
    },
  };
}

describe('classifyScheduledWatchdogStatus', () => {
  it('makes zero fires healthy before any scoped row is eligible', () => {
    expect(classifyScheduledWatchdogStatus(base())).toMatchObject({
      ok: true,
      effectiveState: 'healthy-idle',
      nextVerb: null,
    });
  });

  it('reports a deliberate <=0 kill switch as disabled, not broken', () => {
    expect(
      classifyScheduledWatchdogStatus(base({ config: { enabled: false, effectiveThresholdSec: 0 } as never })),
    ).toMatchObject({ ok: true, effectiveState: 'disabled' });
  });

  it('treats a fail-soft internal sweep error as a scheduler error', () => {
    expect(classifyScheduledWatchdogStatus(base({ scheduler: { internalErrorCount: 1 } as never }))).toMatchObject({
      ok: false,
      effectiveState: 'scheduler-error',
      nextVerb: { name: 'notifications:recent' },
    });
  });

  it('distinguishes eligible-awaiting-sweep from eligible-no-fire', () => {
    const eligibility = {
      byOrigin: { 'su-ideate': { pendingCount: 1, eligibleCount: 1, oldestRoutedAt: '2026-07-11T00:00:00.000Z' } },
      total: { pendingCount: 1, eligibleCount: 1, oldestRoutedAt: '2026-07-11T00:00:00.000Z', firstEligibleAt: '2026-07-18T00:00:00.000Z' },
    } as const;
    expect(
      classifyScheduledWatchdogStatus(
        base({ eligibility, scheduler: { lastExecutionAt: '2026-07-17T23:59:00.000Z' } as never }),
      ).effectiveState,
    ).toBe('eligible-awaiting-sweep');
    expect(
      classifyScheduledWatchdogStatus(
        base({ eligibility, scheduler: { lastExecutionAt: '2026-07-18T00:01:00.000Z' } as never }),
      ),
    ).toMatchObject({
      ok: false,
      effectiveState: 'eligible-no-fire',
      nextVerb: {
        name: 'mode:set',
        args: { mode: 'grade', enabled: true },
      },
    });
  });

  it('does not label an eligible backlog as awaiting sweep after a post-eligibility fire', () => {
    const result = classifyScheduledWatchdogStatus(base({
      scheduler: {
        lastExecutionAt: '2026-07-18T00:02:00.000Z',
        lastResultCount: 1,
        lastNudgedCount: 0,
      } as never,
      eligibility: {
        byOrigin: { 'su-ideate': { pendingCount: 2, eligibleCount: 2, oldestRoutedAt: '2026-07-11T00:00:00.000Z' } },
        total: { pendingCount: 2, eligibleCount: 2, oldestRoutedAt: '2026-07-11T00:00:00.000Z', firstEligibleAt: '2026-07-18T00:00:00.000Z' },
      } as never,
      fire: {
        count: 1,
        lastFireAt: '2026-07-18T00:01:00.000Z',
        lastReason: '[origin=su-ideate] 1 filing(s) nudged',
      } as never,
    }));

    expect(result).toMatchObject({
      ok: false,
      effectiveState: 'eligible-after-fire',
      summary: expect.stringContaining('eligible filing(s) (su-ideate: 2) remain; a watchdog fire was recorded'),
      nextVerb: {
        name: 'mode:set',
        args: { mode: 'grade', enabled: true },
      },
    });
  });

  it('reports unknown when eligible rows cannot be compared to the sweep time', () => {
    expect(classifyScheduledWatchdogStatus(base({
      eligibility: {
        byOrigin: { scout: { pendingCount: 1, eligibleCount: 1, oldestRoutedAt: null } },
        total: { pendingCount: 1, eligibleCount: 1, oldestRoutedAt: null, firstEligibleAt: null },
      } as never,
    }))).toMatchObject({
      ok: false,
      effectiveState: 'eligibility-window-unknown',
      summary: expect.stringContaining('timestamps cannot be compared'),
    });
  });

  it('reports a successful zero-evaluation sweep as degraded and routes to SU GRADE', () => {
    const result = classifyScheduledWatchdogStatus(
      base({
        scheduler: {
          lastExecutionAt: '2026-07-18T00:01:00.000Z',
          lastResultCount: 0,
          lastNudgedCount: 0,
        } as never,
        eligibility: {
          byOrigin: { scout: { pendingCount: 13, eligibleCount: 13, oldestRoutedAt: '2026-07-11T00:00:00.000Z' } },
          total: { pendingCount: 13, eligibleCount: 13, oldestRoutedAt: '2026-07-11T00:00:00.000Z', firstEligibleAt: '2026-07-18T00:00:00.000Z' },
        } as never,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      effectiveState: 'eligible-sweep-empty',
      nextVerb: {
        name: 'mode:set',
        args: { mode: 'grade', enabled: true },
      },
    });
    expect(result.summary).toContain('zero scopes');
    expect(result.nextVerb?.reason).toContain('blender:grade-idea');
  });

  it('is healthy-fired when no eligible rows remain after a recorded fire', () => {
    expect(
      classifyScheduledWatchdogStatus(
        base({ fire: { count: 1, lastFireAt: '2026-07-18T00:01:00.000Z', lastReason: 'nudged' } as never }),
      ).effectiveState,
    ).toBe('healthy-fired');
  });

  it('uses the scheduler-persisted config when the API process environment differs', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC', '604800');
    const nowMs = Date.parse('2026-07-15T03:30:00.000Z');
    const oldestMs = Date.parse('2026-07-13T03:18:10.000Z');
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM dbos.operation_outputs')) {
        return Promise.resolve([
          {
            output: JSON.stringify({
              json: {
                ranAtMs: nowMs - 1_000,
                errorCount: 0,
                resultCount: 0,
                nudgedCount: 0,
                results: [],
                config: {
                  enabled: true,
                  effectiveThresholdSec: 172_800,
                  overrideSource: 'environment',
                  overrideEnv: 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC',
                  rawOverride: '172800',
                  policy: {
                    byOrigin: { 'su-ideate': 1_783_728_000_000 },
                    fallbackMs: 1_783_728_000_000,
                  },
                  batchCap: 10,
                },
              },
              __dbos_serializer: 'superjson',
            }),
            operation_error: null,
            completed_at_epoch_ms: nowMs - 1_000,
            workflow_status: 'SUCCESS',
            workflow_error: null,
          },
        ]);
      }
      if (text.includes('FROM harness_shared.scout_routed_ideas')) {
        return Promise.resolve([
          { origin: 'su-ideate', pending_count: 1, eligible_count: 1, oldest_routed_at: oldestMs },
          { origin: 'scout', pending_count: 3, eligible_count: 3, oldest_routed_at: oldestMs + 1000 },
        ]);
      }
      if (text.includes('FROM harness_shared.pot_watchdog_fires')) {
        return Promise.resolve([{ fire_count: 0, last_fire_at: null, last_reason: null }]);
      }
      throw new Error(`unexpected SQL: ${text}`);
    }) as never;

    try {
      const status = await readScheduledWatchdogStatus({
        id: 'su-ideate-ungraded',
        workspaceId: 'ws',
        harnessSlug: 'papercusp',
        nowMs,
        sql,
      });

      expect(status.config).toMatchObject({
        effectiveThresholdSec: 172_800,
        overrideSource: 'environment',
        rawOverride: '172800',
      });
      expect(status.eligibility.total.firstEligibleAt).toBe(new Date(oldestMs + 172_800_000).toISOString());
      expect(status.eligibility.total.pendingCount).toBe(4);
      expect(status.eligibility.byOrigin).toMatchObject({
        'su-ideate': { pendingCount: 1 },
        scout: { pendingCount: 3 },
      });
      // A human-facing status must expose the producer axis. A bare count was
      // repeatedly mistaken for the su-ideate population when it included others.
      expect(Object.keys(status.eligibility).sort()).toEqual(['byOrigin', 'total']);
      expect(status.eligibility.byOrigin['su-ideate']?.pendingCount).toBe(1);
      expect(status.eligibility.byOrigin.scout?.pendingCount).toBe(3);
      expect(status.eligibility.total.pendingCount).toBe(
        Object.values(status.eligibility.byOrigin).reduce((sum, origin) => sum + origin.pendingCount, 0),
      );
      expect(status.scheduler).toMatchObject({ lastResultCount: 0, lastNudgedCount: 0 });
      expect(status).toMatchObject({ ok: false, effectiveState: 'eligible-sweep-empty' });
      const eligibilityCall = calls.find((call) => call.text.includes('FROM harness_shared.scout_routed_ideas'));
      // P-001: the eligibility read now goes through readUngradedEligibility, whose
      // leading binds are the per-origin floor policy — so assert the threshold is
      // BOUND, not that it sits at a fixed position that the contract does not promise.
      expect(eligibilityCall?.values).toContain(nowMs - 172_800_000);
      expect(eligibilityCall?.text).toContain('GROUP BY origin');
      expect(eligibilityCall?.values).toContain(true);
      expect(eligibilityCall?.values).toContain('ws');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
