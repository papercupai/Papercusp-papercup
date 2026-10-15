/**
 * EI-25692848225486055 / verification-system-improvements-2026-10-10 D-049 — the live bars
 * R-4, R-5, R-12 and R-13 probe the `verification.health` cell PER METRIC:
 *
 *   state:read { cell:'verification.health' }  →  expect.path '$.value.<metric>'
 *
 * The cell used to declare `changeSignal.path: 'health.breaches'`, and a read's `value` IS
 * that path (cell-read.ts), so `value` was a bare integer and every per-metric probe resolved
 * ABSENT while the resolver held the readings. Nothing caught it before independent grading,
 * because the implementer's live e2e read `plans:verification-health` directly and never
 * exercised the declared probe path.
 *
 * This suite closes that gap end to end with real code everywhere except the dispatch:
 *   - the resolver payload comes from the REAL `runVerificationHealth` over fake rows,
 *   - the read goes through the REAL `state:read` handler and `readCell` against the REAL
 *     registered `VERIFICATION_HEALTH_CELL`,
 *   - each bar's probe is evaluated by the REAL `evaluateContinuityPredicate`.
 *
 * Every metric gets a DISTINCT fixture value, so a probe that resolved the wrong field
 * cannot match by coincidence.
 *
 * Falsifiability is kept in-file (the repo's tier for imported logic): the control below
 * re-registers the cell with the old scalar path and asserts the same probes resolve
 * absent — so this suite fails if the cell is ever narrowed back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  // Only the DISPATCH is faked; the path walk, assessment and rendering are real.
  return { ...actual, dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args) };
});

vi.mock('./agent-tools/coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-tools/coordination/identity')>();
  return {
    ...actual,
    resolveAgentIdentity: () => ({
      ownerId: 'judge-test',
      ownerLabel: 'judge · test',
      source: 'test',
      workspaceId: 'papercusp-workspace',
      userId: null,
    }),
  };
});

import readTool from './agent-tools/state/read';
import { VERIFICATION_HEALTH_CELL } from './cell-registrations';
import { registerCell, validateCellSpec, __resetCellRegistryForTests } from './cell-registry';
import { evaluateContinuityPredicate, type ContinuityPredicate } from './continuity-probes';
import {
  runVerificationHealth,
  type ContractTriageMeasure,
  type StaleAcceptanceMeasure,
  type VerificationHealthPlanRow,
  type VerificationHealthReport,
} from './verification-health';

/** The probe each live bar declares on rubric acceptance-verification-system-improvements-2026-10-10 rev 11. */
const BAR_PROBES: Array<{ bar: string; metric: keyof VerificationHealthReport['health']; expect: ContinuityPredicate }> = [
  { bar: 'R-4', metric: 'triageGaps', expect: { path: '$.value.triageGaps', op: 'eq', value: 0 } },
  {
    bar: 'R-5',
    metric: 'staleAcceptanceUndispositioned',
    expect: { path: '$.value.staleAcceptanceUndispositioned', op: 'eq', value: 0 },
  },
  { bar: 'R-12', metric: 'unreachablePlans', expect: { path: '$.value.unreachablePlans', op: 'eq', value: 0 } },
  {
    bar: 'R-13',
    metric: 'staleAcceptanceScopeExcluded',
    expect: { path: '$.value.staleAcceptanceScopeExcluded', op: 'gte', value: 0 },
  },
];

const CTX = { role: 'judge', harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' };
const NOW = new Date('2026-10-11T14:30:00Z');

function planRow(over: Partial<VerificationHealthPlanRow>): VerificationHealthPlanRow {
  return {
    harness_slug: 'papercusp',
    plan_slug: 'p',
    status: 'active',
    template: null,
    acceptance_bar_cohort: 'post-epoch',
    has_contract: true,
    forced: false,
    has_val_block: false,
    updated_at: NOW.toISOString(),
    active_clauses: 4,
    bound_clauses: 3,
    ...over,
  };
}

/** A real resolver report: `runVerificationHealth` over fake rows and injected measures. */
async function report(triage: ContractTriageMeasure, stale: StaleAcceptanceMeasure): Promise<VerificationHealthReport> {
  const rows = [planRow({ plan_slug: 'a' }), planRow({ plan_slug: 'b', status: 'awaiting-acceptance' })];
  return runVerificationHealth(
    { unsafe: async <T,>() => rows as unknown as T },
    { workspaceId: 'papercusp-workspace', now: NOW },
    { measureContractTriage: async () => triage, measureStaleAcceptance: async () => stale },
  );
}

/** Distinct non-zero readings per metric, so each probe can only match its own field. */
const DISTINCT = {
  triage: {
    uncoveredActivePlans: 11,
    uncoveredActivePlansRaw: 12,
    closureReasonMissing: 13,
    triageGaps: 3,
    unreachablePlans: 5,
    activePlansConsidered: 40,
  },
  stale: {
    staleAcceptanceSurfaced: 21,
    staleAcceptanceNeverSurfaced: 22,
    staleAcceptanceUndispositioned: 7,
    staleAcceptanceScopeExcluded: 9,
    acceptancePlansConsidered: 60,
  },
};

const HEALTHY = {
  triage: { ...DISTINCT.triage, triageGaps: 0, unreachablePlans: 0 },
  stale: { ...DISTINCT.stale, staleAcceptanceUndispositioned: 0, staleAcceptanceScopeExcluded: 1 },
};

async function stateRead(): Promise<Record<string, unknown>> {
  const res = (await readTool.handler({ cell: 'verification.health' } as never, CTX as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
});

describe('verification.health — the bars’ declared probes resolve against a real state:read', () => {
  it('registers cleanly', () => {
    expect(validateCellSpec(VERIFICATION_HEALTH_CELL)).toEqual([]);
  });

  it('each $.value.<metric> probe reads exactly the resolver’s reading for that metric', async () => {
    registerCell(VERIFICATION_HEALTH_CELL);
    const payload = await report(DISTINCT.triage, DISTINCT.stale);
    dispatchReadOnlyTool.mockResolvedValue(payload);

    const body = await stateRead();
    expect(body.status).toBe('value');
    for (const probe of BAR_PROBES) {
      const { actual } = evaluateContinuityPredicate(probe.expect, body);
      expect(actual, `${probe.bar} ${probe.expect.path}`).toBe(payload.health[probe.metric]);
      expect(typeof actual, `${probe.bar} resolved a number`).toBe('number');
    }
    // The breach count stays reachable on the same read.
    expect(evaluateContinuityPredicate({ path: '$.value.breaches', op: 'exists' }, body).actual).toBe(
      payload.health.breaches,
    );
  });

  it('a healthy measurement passes every bar predicate, and a breached one fails the right ones', async () => {
    registerCell(VERIFICATION_HEALTH_CELL);
    dispatchReadOnlyTool.mockResolvedValue(await report(HEALTHY.triage, HEALTHY.stale));
    const healthy = await stateRead();
    for (const probe of BAR_PROBES) {
      expect(evaluateContinuityPredicate(probe.expect, healthy).matches, probe.bar).toBe(true);
    }

    dispatchReadOnlyTool.mockResolvedValue(await report(DISTINCT.triage, DISTINCT.stale));
    const breached = await stateRead();
    const verdicts = Object.fromEntries(
      BAR_PROBES.map((p) => [p.bar, evaluateContinuityPredicate(p.expect, breached).matches]),
    );
    expect(verdicts).toEqual({ 'R-4': false, 'R-5': false, 'R-12': false, 'R-13': true });
  });

  it('keeps breaches as the material change', () => {
    expect(VERIFICATION_HEALTH_CELL.materiality?.path).toBe('health.breaches');
    expect(VERIFICATION_HEALTH_CELL.changeSignal).toMatchObject({ kind: 'poll', path: 'health' });
  });
});

describe('control — the old scalar path makes every probe resolve absent', () => {
  it('a cell valued at health.breaches cannot answer the per-metric probes', async () => {
    registerCell({
      ...VERIFICATION_HEALTH_CELL,
      headline: 'health.breaches',
      changeSignal: { kind: 'poll', tool: 'plans:verification-health', path: 'health.breaches' },
      materiality: undefined,
    });
    dispatchReadOnlyTool.mockResolvedValue(await report(HEALTHY.triage, HEALTHY.stale));
    const body = await stateRead();
    expect(body.status).toBe('value');
    expect(typeof body.value).toBe('number');
    for (const probe of BAR_PROBES) {
      const verdict = evaluateContinuityPredicate(probe.expect, body);
      expect(verdict.actual, probe.bar).toBeUndefined();
      expect(verdict.matches, probe.bar).toBe(false);
    }
  });
});
