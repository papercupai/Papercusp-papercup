/**
 * rubric-rescore-schedule.test.ts — plan test-rubric-unification-2026-10-12 P-008 (R-8), as
 * bound by D-008: a recurring rubric re-score is a PLAN SCHEDULE that fires the plan-schedulable
 * system action `system:rubric-rescore`, and a criterion that moves from meets (pass) to below
 * meets (fail) fires `rubric:criterion-regressed:<rubricRef>` — the exact key the standing
 * `watch:create { pattern, targetKind:'event', wake:false }` alert subscribes to.
 *
 * Pins the R-8 falsifiers at the unit layer:
 *   (1) a pass → fail crossing fires the alert event;
 *   (2) a re-score that stays at meets (or never met, or could not measure) fires nothing;
 *   (3) the re-score is driven by an armed plan schedule — authored through the
 *       plans:set-schedule handler and armed through the plans:arm-schedule handler, which
 *       materializes the `plan-schedule-<slug>` routine targeting `system:rubric-rescore`.
 * The deployed half of falsifier (4) is the bound probe check, not this file.
 *
 * Mocked: the PG seams only (plan source writes, the routines upsert, the flag read, the
 * start gate). rescoreRubric takes its ledger / runner / emitter through injected deps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-tools/plans/source', async (orig) => ({
  ...(await orig<typeof import('./agent-tools/plans/source')>()),
  setPlanSchedule: vi.fn(),
  getPlanRow: vi.fn(),
}));
vi.mock('./agent-tools/plans/_ctx-opts', () => ({
  ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'ws-test', harnessSlug: 'papercusp' })),
}));
vi.mock('./agent-tools/_harness-scope', async (orig) => ({
  ...(await orig<typeof import('./agent-tools/_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./agent-tools/plans/plan-start-gate', () => ({ checkPlanStartable: vi.fn(async () => ({ ok: true })) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
const fakeSql = vi.fn(async () => []);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
  upsertRoutine: vi.fn(async (_sql: unknown, row: { nextFireAt?: Date | null }) => ({
    id: 'routine-1',
    nextFireAt: row.nextFireAt ?? null,
  })),
}));

import { upsertRoutine } from '@papercusp/db-org';
import { getPlanRow, setPlanSchedule, type PlanRow } from './agent-tools/plans/source';
import { mockResolvedTyped } from './testing/typed-mock';
import { catalogEntry, buildKey, keyMatchesCatalog } from './events/await/catalog';
import { getSystemActionEntry } from './harness/routines/system-actions';
import { planScheduleRoutineName } from './harness/routines/materialize-plan-schedule';
import { checkPlanStartable } from './agent-tools/plans/plan-start-gate';
import { probeCheckId } from './check-results-ledger';
import { parseRequirementBars } from './acceptance-bar-seed';
import type { CheckedCriterion } from './rubrics-criterion-checks';
import type { LatestRubricCheckResult, RubricCheckResult } from './check-results-ledger';
import {
  RUBRIC_RESCORE_ACTION,
  rescoreRubric,
  rubricCriterionRegressedKey,
  runRubricRescoreAction,
  type RubricRescoreDeps,
} from './harness/routines/rubric-rescore-action';

const setSchedTool = (await import('./agent-tools/plans/set-schedule')).default;
const armSchedTool = (await import('./agent-tools/plans/arm-schedule')).default;

const RUBRIC = 'papercusp-app-performance';
/** The standing alert D-008 authors: watch:create { pattern: <this>, targetKind:'event', wake:false }. */
const WATCH_PATTERN = 'rubric:criterion-regressed:papercusp-app-performance';

/** A probe criterion whose single child passes when the observed scalar is >= 1. */
function probeCriterion(key: string): CheckedCriterion {
  return {
    key,
    check: {
      kind: 'probe',
      all: [{
        kind: 'tool',
        tool: 'routines:list',
        args: {},
        schemaRevision: 'projected-tool-registry-v1:test',
        expect: { path: '$.n', op: 'gte', value: 1 },
      }],
    },
  };
}

function row(criterionKey: string, value: number | null, testRunId: number, status: 'pass' | 'fail' | 'error' = 'pass'): LatestRubricCheckResult {
  return {
    testRunId,
    status: value === null ? 'error' : status,
    finishedAt: '2026-10-13T00:00:00.000Z',
    check: { id: probeCheckId(criterionKey, 0), rubricRef: RUBRIC, criterionKey, kind: 'probe', value, unit: null },
  };
}

function ledger(entries: LatestRubricCheckResult[]): Map<string, LatestRubricCheckResult> {
  return new Map(entries.map((e) => [e.check.id, e]));
}

/** Deps with a before/after ledger pair; the runner writes one row so the record path runs. */
function depsFor(
  criteria: ReturnType<typeof probeCriterion>[],
  before: LatestRubricCheckResult[],
  after: LatestRubricCheckResult[],
) {
  const emit = vi.fn(async () => undefined);
  const record = vi.fn(async () => [9001]);
  const readLatest = vi.fn()
    .mockResolvedValueOnce(ledger(before))
    .mockResolvedValueOnce(ledger(after));
  const ran: RubricCheckResult = {
    check: after[0]?.check ?? { id: 'x:0', rubricRef: RUBRIC, criterionKey: 'x', kind: 'probe', value: 1, unit: null },
    verdict: 'pass',
    measuredAt: '2026-10-13T00:00:00.000Z',
    durationMs: 3,
  };
  const deps: RubricRescoreDeps = {
    getRubric: async () => ({ rubricId: RUBRIC, workspaceId: 'ws-test', subjectHarnessSlug: 'papercusp', criteria }),
    readLatest: readLatest as never,
    runInstruments: vi.fn(async () => []) as never,
    evaluateProbes: vi.fn(async () => ({ ok: true, checkRuns: [] })) as never,
    dispatchTool: vi.fn(async () => ({})),
    record: record as never,
    emit: emit as never,
  };
  return { deps, emit, record, readLatest, ran };
}

beforeEach(() => {
  vi.mocked(setPlanSchedule).mockReset().mockResolvedValue(true);
  vi.mocked(upsertRoutine).mockClear();
  fakeSql.mockClear();
});

describe('rubric re-score: crossing alert (R-8 falsifiers 1 and 2)', () => {
  it('executes the live plan instruments when the stored acceptance seed still says none', async () => {
    const checks = ['agents:acceptance-machinery-share', 'agents:native-session-minutes'];
    const content = '## Requirements\n\n' + checks.map((instrumentKey, i) =>
      `**R-${15 + i} — Outcome.**\n\n\`\`\`requirement\n` + JSON.stringify({
        intent: { request: 'Measure real plan outcomes.', sourceRefs: ['owner-directive:1909'] },
        acceptance: { condition: 'The outcome meets its bar.', falsifier: 'The outcome misses its bar.',
          evidencePlane: 'live', requiredScope: ['P-015'] },
        verification: { method: 'Run the registered measurement.', check: { kind: 'instrument', instrumentKey } },
      }) + '\n```\n').join('\n');
    // The stored seed carries the same promise a real seed of this Requirements section does;
    // only its check is still the unbound instrument:none (WI-6554700010018740).
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error('fixture Requirements must parse');
    const stored = parsed.bars.map((bar) => ({ ...bar.criterion!,
      check: { kind: 'instrument' as const, instrumentKey: 'none' } }));
    // This read seam consumes only the plan content and revision.
    mockResolvedTyped(vi.mocked(getPlanRow), { content, version: 35 } as PlanRow);
    const { deps, record } = depsFor([], [], []);
    deps.getRubric = async () => ({ rubricId: RUBRIC, kind: 'acceptance', subjectPlan: 'subject-plan',
      workspaceId: 'ws-test', subjectHarnessSlug: 'papercusp', criteria: stored });
    deps.runInstruments = vi.fn(async ({ criteria }: Parameters<NonNullable<RubricRescoreDeps['runInstruments']>>[0]) => criteria.map((criterion, i) => ({
      check: { id: `${criterion.key}:instrument`, rubricRef: RUBRIC, criterionKey: criterion.key,
        kind: 'instrument' as const, value: i, unit: 'count' },
      verdict: 'pass' as const, measuredAt: '2026-10-16T00:00:00Z', durationMs: 1,
    })));
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'wrong-workspace', harnessSlug: 'wrong-harness' }, deps);
    expect(getPlanRow).toHaveBeenCalledWith('subject-plan', { workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    expect(deps.runInstruments).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-test', harnessSlug: 'papercusp', criteria: checks.map((instrumentKey, i) =>
        expect.objectContaining({ key: `r-${15 + i}`, check: { kind: 'instrument', instrumentKey } })),
    }));
    expect(out.executed).toBe(2);
    expect(record).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ check: expect.objectContaining({ criterionKey: 'r-15' }) }),
      expect.objectContaining({ check: expect.objectContaining({ criterionKey: 'r-16' }) }),
    ]), { workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    expect(stored.map(c => c.check.instrumentKey)).toEqual(['none', 'none']);
  });

  it.each([
    ['unreadable', null, 'subject-plan-unreadable'],
    ['malformed', { content: '## Requirements\n```requirement\n{invalid}\n```', version: 1 }, 'requirements-unparseable'],
  ] as const)('refuses %s live requirements before running or recording stale checks', async (_label, plan, reason) => {
    mockResolvedTyped(vi.mocked(getPlanRow), plan as PlanRow | null);
    const { deps, record, readLatest } = depsFor([probeCriterion('stale')], [], []);
    deps.getRubric = async () => ({ rubricId: RUBRIC, kind: 'acceptance', subjectPlan: 'subject-plan',
      workspaceId: 'ws-test', subjectHarnessSlug: 'papercusp', criteria: [probeCriterion('stale')] });
    await expect(rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: 'papercusp' }, deps))
      .rejects.toThrow(`rubric_rescore_live_requirements_unavailable: ${RUBRIC}: ${reason}`);
    expect(deps.runInstruments).not.toHaveBeenCalled();
    expect(readLatest).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('includes scheduled platform checks, passes canonical workspace scope, and emits their regression', async () => {
    const criterion: CheckedCriterion = { key: 'r-31', check: { kind: 'instrument', instrumentKey: 'code-intel:native-adoption-good-use' } };
    const prior = { ...row('r-31', 1, 1), check: { id: 'r-31:instrument', rubricRef: RUBRIC,
      criterionKey: 'r-31', kind: 'instrument' as const, value: 1, unit: 'count' } };
    const failed = { ...prior, testRunId: 2, status: 'fail' as const, check: { ...prior.check, value: 0 } };
    const { deps, emit } = depsFor([criterion], [prior], [failed]);
    await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'untrusted-fallback', harnessSlug: 'papercusp' }, deps);
    expect(deps.runInstruments).toHaveBeenCalledWith({ rubricRef: RUBRIC, criteria: [criterion], workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ payload: {
      rubricRef: RUBRIC, criterionKey: 'r-31', before: 'pass', after: 'fail', testRunId: 2,
    } }));
  });
  it('the alert key is the catalogued family the standing watch subscribes to', () => {
    expect(rubricCriterionRegressedKey(RUBRIC)).toBe(WATCH_PATTERN);
    const entry = catalogEntry('rubric-criterion-regressed');
    expect(entry?.exists).toBe(true);
    expect(buildKey('rubric-criterion-regressed', { rubricRef: RUBRIC })).toBe(WATCH_PATTERN);
    expect(keyMatchesCatalog(WATCH_PATTERN)).toBe(true);
  });

  it('a criterion that moves from meets to below meets fires the watched event once', async () => {
    const { deps, emit } = depsFor(
      [probeCriterion('p95-latency'), probeCriterion('error-rate')],
      [row('p95-latency', 5, 100), row('error-rate', 5, 101)],
      [row('p95-latency', 0, 200, 'fail'), row('error-rate', 7, 201)],
    );
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: 'papercusp' }, deps);
    expect(out.crossings).toEqual([
      { rubricRef: RUBRIC, criterionKey: 'p95-latency', before: 'pass', after: 'fail', testRunId: 200 },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: WATCH_PATTERN,
      payload: { rubricRef: RUBRIC, criterionKey: 'p95-latency', before: 'pass', after: 'fail', testRunId: 200 },
      source: `system:${RUBRIC_RESCORE_ACTION}`,
      workspaceId: 'ws-test',
    }));
  });

  it('judges the stored value against the CURRENT threshold, not the recorded status', async () => {
    // The after row was recorded as 'pass' under an older, looser bar; value 0 misses gte 1 now.
    const { deps, emit } = depsFor([probeCriterion('k')], [row('k', 3, 1)], [row('k', 0, 2, 'pass')]);
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: null }, deps);
    expect(out.crossings.map((c) => c.criterionKey)).toEqual(['k']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stays at meets (pass → pass)', [row('k', 5, 1)], [row('k', 6, 2)]],
    ['never met (fail → fail)', [row('k', 0, 1, 'fail')], [row('k', 0, 2, 'fail')]],
    ['no prior rating (unknown → fail)', [], [row('k', 0, 2, 'fail')]],
    ['could not measure (pass → error)', [row('k', 5, 1)], [row('k', null, 2)]],
    ['recovers (fail → pass)', [row('k', 0, 1, 'fail')], [row('k', 4, 2)]],
  ])('a re-score that %s fires no alert', async (_label, before, after) => {
    const { deps, emit } = depsFor([probeCriterion('k')], before, after);
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: 'papercusp' }, deps);
    expect(out.crossings).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('records every executed check result to the ledger before judging the after state', async () => {
    const { deps, record, readLatest, ran } = depsFor([probeCriterion('k')], [row('k', 5, 1)], [row('k', 5, 2)]);
    deps.runInstruments = vi.fn(async () => [ran]) as never;
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: 'papercusp' }, deps);
    expect(record).toHaveBeenCalledWith([ran], { workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    expect(out).toMatchObject({ executed: 1, testRunIds: [9001] });
    // before-read, then after-read — the second read is what decides a crossing.
    expect(readLatest).toHaveBeenCalledTimes(2);
    expect(record.mock.invocationCallOrder[0]!).toBeLessThan(readLatest.mock.invocationCallOrder[1]!);
  });

  it('a probe batch that cannot run surfaces as a soft error and fires nothing', async () => {
    const { deps, emit } = depsFor([probeCriterion('k')], [row('k', 5, 1)], [row('k', 5, 1)]);
    deps.evaluateProbes = vi.fn(async () => ({ ok: false, error: 'probe_unavailable', detail: 'no tool' })) as never;
    const res = await runRubricRescoreAction(
      { workspaceId: 'ws-test', installSlug: 'papercusp', payloadTemplate: { harnessSlug: 'papercusp', input: { rubricRef: RUBRIC } } } as never,
      deps,
    );
    expect(res.softError).toContain('probe_unavailable');
    expect(emit).not.toHaveBeenCalled();
  });

  it('one unjudgeable probe criterion does not drop the others; it keeps its prior rows', async () => {
    const { deps, record } = depsFor([probeCriterion('slow'), probeCriterion('steady')], [], []);
    const evaluateProbes = vi.fn(async (input: { criteria: ReadonlyArray<{ key: string }> }) => {
      const key = input.criteria[0]!.key;
      if (key === 'slow') return { ok: false, error: 'probe_run_failed', criterionKey: key, detail: 'call_timeout after 30000ms' };
      return { ok: true, checkRuns: { [key]: { kind: 'probe', verdict: 'pass', observed: 3, measuredAt: '2026-10-13T00:00:00.000Z' } } };
    });
    deps.evaluateProbes = evaluateProbes as never;
    const out = await rescoreRubric({ rubricRef: RUBRIC, workspaceId: 'ws-test', harnessSlug: 'papercusp' }, deps);
    // One evaluation per criterion, so the timeout is isolated to its own criterion.
    expect(evaluateProbes.mock.calls.map(([input]) => input.criteria.map((c) => c.key))).toEqual([['slow'], ['steady']]);
    const recorded = (record.mock.calls[0] as unknown as [RubricCheckResult[]])[0];
    expect(recorded.map((r) => [r.check.criterionKey, r.verdict])).toEqual([['steady', 'pass']]);
    expect(out.probeError).toBe('1 of 2 probe criteria unjudged; slow: probe_run_failed: call_timeout after 30000ms');
  });

  it('the routine handler refuses a payload with no rubricRef', async () => {
    await expect(
      runRubricRescoreAction({ workspaceId: 'ws-test', installSlug: 'papercusp', payloadTemplate: { input: {} } } as never),
    ).rejects.toThrow('rubric_rescore_rubric_ref_required');
  });
});

type Out = { data?: any; content?: { text: string }[]; isError?: boolean };
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

describe('rubric re-score: driven by an armed plan schedule (R-8 falsifier 3)', () => {
  const action = { system: RUBRIC_RESCORE_ACTION, input: { rubricRef: RUBRIC } };

  it('system:rubric-rescore is registered and opted in as plan-schedulable', () => {
    expect(getSystemActionEntry(RUBRIC_RESCORE_ACTION)).toMatchObject({ planSchedulable: true, scheduling: 'on-demand' });
  });

  it('plans:set-schedule stores an action-backed recurrence', async () => {
    const out = (await setSchedTool.handler(
      { harness: 'papercusp', slug: 'rubric-rescore-papercusp-app-performance', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', action } } as never,
      {} as never,
    )) as Out;
    expect(out.isError).toBeFalsy();
    expect(vi.mocked(setPlanSchedule)).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(setPlanSchedule).mock.calls[0]![0];
    expect(persisted.slug).toBe('rubric-rescore-papercusp-app-performance');
    expect(persisted.schedule?.action).toEqual(action);
  });

  it('plans:set-schedule refuses an action that is not a plan-schedulable system action', async () => {
    const out = (await setSchedTool.handler(
      { harness: 'papercusp', slug: 's', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', action: { system: 'no-such-action' } } } as never,
      {} as never,
    )) as Out;
    expect(out.isError).toBe(true);
    expect(body(out).error).toBe('action_not_plan_schedulable');
    expect(String(body(out).detail)).toContain(RUBRIC_RESCORE_ACTION);
    expect(vi.mocked(setPlanSchedule)).not.toHaveBeenCalled();
  });

  it('plans:set-schedule refuses action and operation together', async () => {
    const out = (await setSchedTool.handler(
      {
        harness: 'papercusp',
        slug: 's',
        schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', action, operation: { harnessSlug: 'papercusp', operationId: 'op' } },
      } as never,
      {} as never,
    )) as Out;
    expect(body(out).error).toBe('schedule_target_ambiguous');
    expect(vi.mocked(setPlanSchedule)).not.toHaveBeenCalled();
  });

  it('plans:arm-schedule materializes the plan-schedule routine targeting system:rubric-rescore', async () => {
    // Every item done: a plain schedule would be refused nothing_to_run; an action-backed one clones nothing.
    // A partial row: the handler and armPlanSchedule read only these fields.
    const templateFields: Pick<PlanRow, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'schedule' | 'scheduledAt' | 'content'> = {
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      planSlug: 'rubric-rescore-papercusp-app-performance',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', action },
      scheduledAt: null,
      content: '# Re-score\n\n## Phase 1\n\n- **P-001** `done` re-score papercusp-app-performance daily\n',
    };
    mockResolvedTyped(vi.mocked(getPlanRow), templateFields as PlanRow);
    const out = body((await armSchedTool.handler(
      { harness: 'papercusp', slug: 'rubric-rescore-papercusp-app-performance' } as never,
      {} as never,
    )) as Out);
    expect(out.results[0]).toMatchObject({ ok: true, routineId: 'routine-1' });
    expect(vi.mocked(upsertRoutine)).toHaveBeenCalledTimes(1);
    const routine = vi.mocked(upsertRoutine).mock.calls[0]![1] as Record<string, any>;
    expect(routine).toMatchObject({
      installSlug: 'papercusp',
      name: planScheduleRoutineName('rubric-rescore-papercusp-app-performance'),
      targetRole: `system:${RUBRIC_RESCORE_ACTION}`,
      payloadTemplate: {
        templateSlug: 'rubric-rescore-papercusp-app-performance',
        harnessSlug: 'papercusp',
        input: { rubricRef: RUBRIC },
      },
      active: true,
    });
    expect(routine.name).toBe('plan-schedule-rubric-rescore-papercusp-app-performance');
    // The action rides in the payload, never in the cadence config the parser reads.
    expect(routine.triggerConfig.action).toBeUndefined();
    expect(routine.triggerConfig.rrule).toBe('FREQ=DAILY');
    expect(routine.nextFireAt).toBeInstanceOf(Date);
  });

  // The start gate would refuse this template: it carries only a cadence and an action, so it has
  // no acceptance BAR contract. An action-backed fire never starts or clones the plan, so arming
  // must not consult the gate (found live 2026-10-13: arm refused acceptance_bar_contract_not_ready).
  const gateRefusal = (slug: string) =>
    ({
      ok: false,
      kind: 'inputs',
      refusal: { slug, error: 'plan_inputs_not_ready', code: 'acceptance_bar_contract_not_ready' },
    }) as never;

  it('plans:arm-schedule does not consult the plan-start gate for an action-backed schedule', async () => {
    const slug = 'rubric-rescore-papercusp-app-performance-2026-10-13';
    vi.mocked(checkPlanStartable).mockClear().mockResolvedValueOnce(gateRefusal(slug));
    const fields: Pick<PlanRow, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'schedule' | 'scheduledAt' | 'content'> = {
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      planSlug: slug,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', action },
      scheduledAt: null,
      content: '# Re-score\n',
    };
    mockResolvedTyped(vi.mocked(getPlanRow), fields as PlanRow);
    const out = body((await armSchedTool.handler({ harness: 'papercusp', slug } as never, {} as never)) as Out);
    expect(out.results[0]).toMatchObject({ ok: true, routineId: 'routine-1' });
    expect(vi.mocked(checkPlanStartable)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertRoutine)).toHaveBeenCalledTimes(1);
  });

  it('plans:arm-schedule still applies the plan-start gate to an item-cloning schedule', async () => {
    const slug = 'clone-template-2026-10-13';
    vi.mocked(checkPlanStartable).mockClear().mockResolvedValueOnce(gateRefusal(slug));
    const fields: Pick<PlanRow, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'schedule' | 'scheduledAt' | 'items' | 'content'> = {
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      planSlug: slug,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' },
      scheduledAt: null,
      items: [],
      content: '# Clone\n\n## Phase 1\n\n- **P-001** `todo` do the thing\n',
    };
    mockResolvedTyped(vi.mocked(getPlanRow), fields as PlanRow);
    const out = body((await armSchedTool.handler({ harness: 'papercusp', slug } as never, {} as never)) as Out);
    const actual = JSON.stringify(out.results[0]);
    expect(vi.mocked(checkPlanStartable), actual).toHaveBeenCalledTimes(1);
    expect(out.results[0], actual).toMatchObject({ ok: false, code: 'acceptance_bar_contract_not_ready' });
    expect(vi.mocked(upsertRoutine)).not.toHaveBeenCalled();
  });
});
