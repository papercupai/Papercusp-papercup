/**
 * emit.author-rebind-hint.test.ts — EI-21917534129987791.
 *
 * `isAcceptanceAuthorIdentity` already has a recovery path for a dead
 * acceptance-rubric author: it walks the audited `coord:rebind-identity`
 * trail (acceptance-author-identity.ts's own header names rebind as "the
 * canonical recovery operation" for exactly this case). The reported defect
 * was not that recovery is impossible — it is that the bare "acceptance must
 * be recorded by the acceptance-rubric author" refusal never told a caller
 * that path exists, so a genuinely recoverable situation read as a permanent
 * dead-end.
 *
 * These tests exercise the hint in isolation via the `resolveAuthorSessionState`
 * DI seam (an injectable deps field on `emitScorecard`, not a mocked module) —
 * unit-level, mirroring emit.vetting.test.ts's collaborator-mocking style for
 * the surfaces that aren't deps-injectable (getRubric, getRubricPlanRevision,
 * readRubricPlanRevision, listScorecards).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    readRubric: async (rubricId: string) => {
      const rubric = await getRubric(rubricId);
      return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
    },
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
    readRubricPlanRevision: (...a: unknown[]) => readRubricPlanRevision(...a),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../workspace-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...real, activeWorkspaceId: () => 'ws-test' };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../acceptance-author-identity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../acceptance-author-identity')>();
  // grader-eligibility now resolves the plan's principal implementers over the
  // org PG before the author rails; the getOrgPg stub above has no `sql`, and
  // the seat question is not what these hint tests exercise.
  return { ...real, resolvePlanImplementerIdentities: async () => [] };
});

import { emitScorecard } from './emit';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const ACCEPTANCE_RUBRIC = {
  rubricId: 'ar-some-plan',
  workspaceId: 'ws-test',
  kind: 'acceptance',
  characteristic: 'plan-acceptance',
  title: 'Acceptance: some plan',
  description: '',
  criteria: [{ key: 'outcome-1', title: 'Outcome', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'weak', 'fail', 'not-applicable'],
  methodRef: null,
  subjectPlan: 'some-plan-2026-08-30',
  status: 'active',
  createdBy: 'su-dead-author',
  proposedBy: 'su-dead-author',
  ratifiedBy: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

const RATINGS: ObservationRatings = {
  'outcome-1': { rating: 'pass', evidence: 'independent grading evidence' },
};

const EMIT_INPUT = { createdBy: 'su-grader', ctxHarness: 'papercusp' };

const acceptanceArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'ar-some-plan',
  ratings: RATINGS,
  acceptance: { verdict: 'accept' as const, reasoning: 'looks complete' },
  ...over,
});

beforeEach(() => {
  getRubric.mockReset().mockResolvedValue(ACCEPTANCE_RUBRIC);
  getRubricPlanRevision.mockReset().mockResolvedValue(3);
  readRubricPlanRevision.mockReset().mockResolvedValue({ ok: true, revision: 3 });
  listScorecards.mockReset().mockResolvedValue([]);
});

/** Deps shared by every case: the grader is neither the author nor in its
 *  lineage, so the flow reaches the author-mismatch refusal under test. */
const notAuthorDeps = (resolveAuthorSessionState: (...a: unknown[]) => Promise<unknown>) => ({
  sameAcceptanceAuthor: async () => false,
  lineageRelated: async () => false,
  resolveAuthorSessionState: resolveAuthorSessionState as never,
});

describe('scorecards:emit acceptance-author refusal — rebind-identity recovery hint (EI-21917534129987791)', () => {
  it('appends the coord:rebind-identity hint when the recorded author is confirmed non-live', async () => {
    const resolveAuthorSessionState = vi.fn().mockResolvedValue('ended');
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
    expect(result.ok).toBe(false);
    expect(resolveAuthorSessionState).toHaveBeenCalledWith('su-dead-author', { workspaceId: 'ws-test' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain("acceptance must be recorded by the acceptance-rubric author ('su-dead-author')");
    expect(result.error).toContain('coord:rebind-identity');
    expect(result.error).toContain("from: 'su-dead-author'");
    expect(result.error).toContain(
      "payload.acceptanceDrainPlan = 'ws-test/papercusp/some-plan-2026-08-30'",
    );
  });

  it('also hints for a "suspect" verdict — REBIND_BLOCKING_SESSION_STATES deliberately excludes it too', async () => {
    const resolveAuthorSessionState = vi.fn().mockResolvedValue('suspect');
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain('coord:rebind-identity');
  });

  it('WI-2141007: a caller IN the author lineage offering a verdict is not told to recruit a grader', async () => {
    // The reported secondary bug: because the eligibility resolver answered the
    // GRADING question for an AUTHOR-side request, this caller got
    // grader_in_implementer_lineage ("recruit an unrelated live session") —
    // advice for a problem the plan did not have, and returned before seat
    // succession could ever be considered.
    const resolveAuthorSessionState = vi.fn().mockResolvedValue('ended');
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, {
      sameAcceptanceAuthor: async () => false,
      lineageRelated: async () => true, // caller IS in the dead author's lineage
      resolveAuthorSessionState: resolveAuthorSessionState as never,
    });
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).not.toContain('cannot supply the independent grading');
    expect(result.error).toContain("acceptance must be recorded by the acceptance-rubric author ('su-dead-author')");
  });

  it('CONTROL (falsifiability): a LIVE author yields no recovery route at all — the seat is not takeable', async () => {
    const resolveAuthorSessionState = vi.fn().mockResolvedValue('live');
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain(
      "acceptance must be recorded by the acceptance-rubric author ('su-dead-author'), " +
        "not grader 'su-grader' — independent graders emit ratings without acceptance",
    );
    // WI-2141007: the base refusal is unchanged; what follows it must offer NO
    // route while the author is reachable — neither rebind nor seat succession.
    expect(result.error).toContain('still reachable');
    expect(result.error).not.toContain('coord:rebind-identity');
    expect(result.error).not.toContain('work_items:claim');
  });

  it.each(['parked', 'draining', 'recorded'] as const)(
    'omits the hint for a %s author — advising rebind there would be actively wrong',
    async (state) => {
      const resolveAuthorSessionState = vi.fn().mockResolvedValue(state);
      const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
      if (result.ok) throw new Error('expected refusal');
      expect(result.error).not.toContain('coord:rebind-identity');
    },
  );

  it('omits the hint when the liveness probe returns no signal (null) — silence over a confident guess', async () => {
    const resolveAuthorSessionState = vi.fn().mockResolvedValue(null);
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).not.toContain('coord:rebind-identity');
  });

  it('never lets a liveness-probe fault block or alter the refusal itself', async () => {
    const resolveAuthorSessionState = vi.fn().mockRejectedValue(new Error('liveness oracle unavailable'));
    const result = await emitScorecard(acceptanceArgs(), EMIT_INPUT, notAuthorDeps(resolveAuthorSessionState));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain(
      "acceptance must be recorded by the acceptance-rubric author ('su-dead-author'), " +
        "not grader 'su-grader' — independent graders emit ratings without acceptance",
    );
    // WI-2141007: an unreadable verdict must say so — and must NOT offer a route,
    // because "the probe faulted" is not evidence that the author is dead.
    expect(result.error).toContain('could not be read');
    expect(result.error).not.toContain('coord:rebind-identity');
    expect(result.error).not.toContain('work_items:claim');
  });
});
