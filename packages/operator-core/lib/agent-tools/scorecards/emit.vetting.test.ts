/**
 * emit.vetting.test.ts — the vetting stamp on scorecards:emit
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-004).
 *
 * Unit-level, mirroring emit.provisional.test.ts: collaborators are mocked; the
 * subject is emitScorecard's vetting validation + stamping — a `vettingConsult`
 * arg must name a REAL consult and a REAL subject rubric before anything is
 * stamped (the acceptance gate trusts the stamp rather than re-querying, so a
 * dangling link refused here is a booby trap avoided there), and a re-emit that
 * only moves the vetting stamp is the re-vetting step, never an
 * 'unchanged-evidence' decline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const readRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
// WI-1393208: criteriaHash is read via a SEPARATE exported function
// (getRubricCriteriaHash) whose own internal call to getRubric is NOT routed
// through this file's `getRubric` mock (a same-module function-to-function call
// is a direct lexical reference, unaffected by how the module's external exports
// are wrapped) — so it must be mocked directly here, exactly like
// getRubricPlanRevision above. Defaults to null (the field's default-omitted
// behavior) so every PRE-EXISTING `.toEqual` assertion in this file — which does
// not expect a `criteriaHash` key — keeps passing unchanged; tests below that
// exercise the new pinning behavior override it explicitly.
const getRubricCriteriaHash = vi.fn();
// EI-21828643965337454 moved the sole-vetting-critic guard onto the FAIL-CLOSED
// revision read: `readRubricPlanRevision` reports a failed read as `ok:false`
// instead of flattening it into the same `null` an unversioned rubric returns.
// This fixture stubbed only the fail-OPEN `getRubricPlanRevision`, so the new call
// fell through to the real PG-backed read, returned `ok:false`, and every case here
// refused with `..._revision_unreadable` before reaching the guard under test.
// Default it to the SAME value the fail-open mock is set to, so the existing
// per-test overrides (notably the unversioned-rubric case, which sets null) keep
// meaning what they say; a test that wants the unreadable leg overrides it directly.
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const readVettingConsultCritique = vi.fn();
const readVettingWorkItemCritique = vi.fn();
const sameAcceptanceAuthor = vi.fn();
const lineageRelated = vi.fn();
const reserveAuthorHandoff = vi.fn();
const advanceAuthorHandoff = vi.fn();

/** The critique verdict shape readVettingConsultCritique returns. */
const critique = (over: Record<string, unknown> = {}) => ({
  exists: true,
  state: 'active',
  critiquePosts: 2,
  declinePosts: 0,
  critics: ['su-reviewer'],
  relevance: { matched: true, matchedRefs: ['ar-some-plan'], via: ['question'] },
  ...over,
});

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    readRubric: (...a: unknown[]) => readRubric(...a),
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
    getRubricEvidenceIdentity: (...a: unknown[]) => getRubricEvidenceIdentity(...a),
    getRubricCriteriaHash: (...a: unknown[]) => getRubricCriteriaHash(...a),
    readRubricPlanRevision: (...a: unknown[]) => readRubricPlanRevision(...a),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
// The independent grading path asks for a live critique before falling back to
// historical meta-scorecards. This unit file owns the historical fallback
// behavior; keep the live critique reader deterministic and database-free.
vi.mock('../../acceptance-rubric-critique', () => ({
  readCurrentAcceptanceRubricCritique: async () => null,
}));
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: async () => null };
});
vi.mock('../../consult/get-feedback-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../consult/get-feedback-core')>();
  return { ...real, readVettingConsultCritique: (...a: unknown[]) => readVettingConsultCritique(...a) };
});
vi.mock('../../work-items', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../work-items')>();
  return {
    ...real,
    readVettingWorkItemCritique: (...a: unknown[]) => readVettingWorkItemCritique(...a),
  };
});
vi.mock('../../workspace-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...real, activeWorkspaceId: () => 'ws-test' };
});
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: (...a: unknown[]) => sameAcceptanceAuthor(...a),
  areAcceptanceLineageRelated: (...a: unknown[]) => lineageRelated(...a),
  resolvePlanImplementerIdentities: async () => [],
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});
// emit's push-on-write dynamic-imports sync-sse after a created card; the stub sql
// above cannot carry a real NOTIFY, so neutralize the bus rather than half-mock it.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
// Vetting tests own stamp/refusal behavior, not the post-write wake bridge. Keep a
// created scorecard from reaching the real PG-backed await latch through stub sql.
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));
vi.mock('../../coord/condition-upsert', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../coord/condition-upsert')>();
  return { ...real, reserveAuthorVettingHandoff: (...args: unknown[]) => reserveAuthorHandoff(...args),
    advanceAuthorVettingHandoff: (...args: unknown[]) => advanceAuthorHandoff(...args) };
});

import { emitScorecard } from './emit';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const META_RUBRIC = {
  rubricId: 'meta-acceptance-rubric',
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'acceptance-rubric-quality',
  title: 'Meta: acceptance rubric quality',
  description: '',
  criteria: [
    { key: 'outcomes-not-diff-restatements', title: 'Outcomes', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'falsifiable-with-evidence', title: 'Falsifiable', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['pass', 'weak', 'fail', 'not-applicable'],
  methodRef: null,
  // Deliberately 'proposed': the vetting flow must work BEFORE the owner ratifies
  // the meta-rubric's content (ratification governs content authority, not
  // mechanics) — a status filter sneaking in here would deadlock every ship on
  // the owner.
  status: 'proposed',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  ratifiedBy: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const ACCEPTANCE_RUBRIC = {
  ...META_RUBRIC,
  rubricId: 'ar-some-plan',
  kind: 'acceptance',
  subjectPlan: 'some-plan-2026-08-17',
  barContract: { meaningRevision: 4 },
  title: 'Acceptance: some plan',
  status: 'active',
};

const META_RATINGS: ObservationRatings = {
  'outcomes-not-diff-restatements': { rating: 'pass', evidence: 'every criterion names an outcome' },
  'falsifiable-with-evidence': { rating: 'pass', evidence: 'each check has a concrete probe' },
};

const EMIT_INPUT = { createdBy: 'su-author', ctxHarness: 'papercusp' };

/** The canonical vetting emit args — subject = the acceptance rubric. */
const vettingArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'meta-acceptance-rubric',
  ratings: META_RATINGS,
  subject: { kind: 'rubric' as const, ref: 'ar-some-plan' },
  vettingConsult: 'conv-vet-1',
  ...over,
});

const workItemVettingArgs = (over: Record<string, unknown> = {}) =>
  vettingArgs({ vettingConsult: undefined, vettingWorkItem: 'WI-review-1', ...over });

beforeEach(() => {
  getRubric.mockReset().mockImplementation(async (id: unknown) => {
    if (id === 'meta-acceptance-rubric') return META_RUBRIC;
    if (id === 'ar-some-plan') return ACCEPTANCE_RUBRIC;
    return null;
  });
  // emit uses the fail-closed reader for vetting subjects. Keep that path on the
  // same deterministic rubric fixtures instead of reaching the real PG-backed read.
  readRubric.mockReset().mockImplementation(async (id: unknown) => {
    if (id === 'meta-acceptance-rubric') return { kind: 'found', rubric: META_RUBRIC };
    if (id === 'ar-some-plan') return { kind: 'found', rubric: ACCEPTANCE_RUBRIC };
    return { kind: 'missing' };
  });
  getRubricPlanRevision.mockReset().mockResolvedValue(7);
  getRubricEvidenceIdentity.mockReset().mockImplementation(async (...a: unknown[]) => ({
    revision: await getRubricPlanRevision(...a),
    criteriaHash: await getRubricCriteriaHash(...a),
    meaningRevision: null,
  }));
  // WI-1393208: default null so every pre-existing assertion in this file (which
  // predates criteriaHash and does not expect the key) is unaffected; tests below
  // override this explicitly to exercise the pinning behavior.
  getRubricCriteriaHash.mockReset().mockResolvedValue(null);
  // Derived, not hardcoded: a test that overrides the revision via the fail-open
  // mock gets the same revision through the fail-closed read, so the two can never
  // silently disagree about what this rubric's current revision is.
  readRubricPlanRevision
    .mockReset()
    .mockImplementation(async (...a: unknown[]) => ({ ok: true, revision: await getRubricPlanRevision(...a) }));
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  readVettingConsultCritique.mockReset().mockResolvedValue(critique());
  readVettingWorkItemCritique.mockReset().mockResolvedValue({
    exists: true,
    critiquePosts: 2,
    critics: ['su-reviewer'],
  });
  sameAcceptanceAuthor.mockReset().mockImplementation(async (author: unknown, candidate: unknown) => author === candidate);
  lineageRelated.mockReset().mockImplementation(async (author: unknown, candidate: unknown) => author === candidate);
  reserveAuthorHandoff.mockReset().mockResolvedValue({ id: 'WI-author-obligation', state: 'queued', created: true });
  advanceAuthorHandoff.mockReset().mockImplementation(async ({ phase, authorize }: {
    phase: string; authorize: () => Promise<boolean>;
  }) => ({ ok: phase !== 'blocked' && await authorize(), state: phase === 'pickup' ? 'picked-up' : phase === 'settle' ? 'completed' : 'blocked' }));
});

describe('author-only refusal handoff uses ordinary vetting policy', () => {
  const exactSubject = () => {
    const subject = { ...ACCEPTANCE_RUBRIC, revision: 7, criteriaHash: 'criteria-seven', barSetHash: 'bars-seven' };
    readRubric.mockImplementation(async (id: string) => ({ kind: 'found',
      rubric: id === subject.rubricId ? subject : META_RUBRIC }));
    getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: 'criteria-seven', meaningRevision: null });
    return subject;
  };

  it('attaches one exact-identity canonical obligation to an ordinary author-only refusal', async () => {
    exactSubject();
    const res = await emitScorecard(vettingArgs() as never, { ...EMIT_INPUT, createdBy: 'su-non-author' }, {
      resolveAcceptanceSeatSuccession: async () => ({ eligible: false, reason: 'author_still_reachable', authorSessionState: 'live' }),
    });
    expect(res).toMatchObject({ ok: false, authorHandoff: { id: 'WI-author-obligation', state: 'queued' },
      responsibleRole: 'rubric-author' });
    expect(reserveAuthorHandoff).toHaveBeenCalledWith(expect.objectContaining({ rubricId: 'ar-some-plan',
      revision: 7, criteriaHash: 'criteria-seven', barSetHash: 'bars-seven', action: 'record-vetting' }),
    expect.objectContaining({ authorId: 'su-author', requestedBy: 'su-non-author' }));
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('records authorized pickup and leaves an unaudited verdict unresolved without replacing critique', async () => {
    exactSubject();
    captureImprovement.mockImplementation(async (opts: { beforeIssueCreate: () => Promise<void> }) => {
      await opts.beforeIssueCreate();
      return { created: true, issue: { id: 'EI-author-final' } };
    });
    const res = await emitScorecard(vettingArgs({ authorHandoffId: 'WI-author-obligation' }) as never, EMIT_INPUT);
    expect(res).toMatchObject({ ok: true, issueId: 'EI-author-final', authorHandoff: { state: 'blocked' } });
    expect(advanceAuthorHandoff.mock.calls.map(([arg]) => arg.phase)).toEqual(['pickup', 'blocked']);
    expect(advanceAuthorHandoff.mock.calls[1][0]).toMatchObject({ verdictRef: 'EI-author-final', actorId: 'su-author',
      reason: 'awaiting-independent-audit' });
    expect(readVettingConsultCritique).toHaveBeenCalled();
  });

  it('refuses a changed author seat at the persistence boundary and leaves a blocked receipt', async () => {
    exactSubject();
    sameAcceptanceAuthor.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    let persisted = false;
    captureImprovement.mockImplementation(async (opts: { beforeIssueCreate: () => Promise<void> }) => {
      await opts.beforeIssueCreate();
      persisted = true;
      return { created: true, issue: { id: 'EI-must-not-exist' } };
    });
    const res = await emitScorecard(vettingArgs({ authorHandoffId: 'WI-author-obligation' }) as never, EMIT_INPUT, {
      resolveAcceptanceSeatSuccession: async () => ({ eligible: false, reason: 'author_still_reachable', authorSessionState: 'live' }),
    });
    expect(res.ok).toBe(false);
    expect(persisted).toBe(false);
    expect(advanceAuthorHandoff.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'blocked' });
  });

  it('keeps preview read-only when it encounters an author-only refusal', async () => {
    exactSubject();
    await emitScorecard(vettingArgs() as never, { ...EMIT_INPUT, createdBy: 'su-non-author', previewOnly: true }, {
      resolveAcceptanceSeatSuccession: async () => ({ eligible: false, reason: 'author_still_reachable', authorSessionState: 'live' }),
    });
    expect(reserveAuthorHandoff).not.toHaveBeenCalled();
    expect(advanceAuthorHandoff).not.toHaveBeenCalled();
  });
});

describe('scorecards:emit vetting stamp (P-004)', () => {
  it('refuses a meta-rubric card for an active acceptance rubric when vetting linkage is omitted', async () => {
    const res = await emitScorecard(
      {
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        subject: { kind: 'rubric', ref: 'ar-some-plan' },
      } as never,
      EMIT_INPUT,
    );
    expect(res).toMatchObject({
      ok: false,
      code: 'acceptance_rubric_vetting_required',
      error: expect.stringContaining('requires vetting linkage'),
    });
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('vettingConsult');
    expect(res.error).toContain('vettingWorkItem');
    expect(res.error).toContain('vettingUnanswered');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a subject-less meta-rubric scorecard before it can file an unbound attestation', async () => {
    const res = await emitScorecard(
      { rubricRef: 'meta-acceptance-rubric', ratings: META_RATINGS } as never,
      EMIT_INPUT,
    );
    expect(res).toMatchObject({
      ok: false,
      code: 'meta_acceptance_subject_required',
      error: expect.stringContaining("subject:{ kind:'rubric'"),
    });
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('cannot attest a rubric');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('accepts a subject-backed meta-rubric attestation when the critique linkage is valid', async () => {
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res).toMatchObject({ ok: true, created: true });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('records the vetted acceptance rubric meaning revision on the attestation', async () => {
    getRubricEvidenceIdentity.mockImplementation(async (id: unknown) => ({
      revision: id === 'ar-some-plan' ? 9 : 7,
      criteriaHash: id === 'ar-some-plan' ? 'acceptance-hash' : null,
      meaningRevision: id === 'ar-some-plan' ? 4 : null,
    }));

    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);

    expect(res).toMatchObject({ ok: true, created: true });
    const payload = captureImprovement.mock.calls[0]?.[0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting?.rubricMeaningRevision).toBe(4);
  });

  it('records the acceptance-BAR meaning revision on an independent grading scorecard', async () => {
    getRubricEvidenceIdentity.mockResolvedValue({
      revision: 7,
      criteriaHash: 'acceptance-hash',
      meaningRevision: 4,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-09-23T00:00:00.000Z',
        createdBy: 'su-reviewer',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'ar-some-plan' },
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          rubricMeaningRevision: 4,
          critiquePosts: 1,
          critics: ['su-reviewer'],
        },
      } as never,
    ]);

    const res = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: true, created: true });
    const payload = captureImprovement.mock.calls[0]?.[0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.rubricMeaningRevision).toBe(4);
  });

  it('refuses vetting from a live non-author instead of taking the author seat', async () => {
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({
      eligible: false,
      reason: 'author_still_reachable',
      authorSessionState: 'live',
    });
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT, {
      sameAcceptanceAuthor: async () => false,
      resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain("vetted rubric's author ('su-author')");
    expect(res.error).toContain('session is still reachable');
    expect(resolveAcceptanceSeatSuccession).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('lets the stamped rubric-vetting answerer author the attestation for their own critique', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ critics: ['su-routed-reviewer'], routedVettingCritic: 'su-routed-reviewer' }),
    );
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({
      eligible: false,
      reason: 'caller_not_accountable_for_plan',
      authorSessionState: 'live',
    });
    const res = await emitScorecard(
      vettingArgs() as never,
      { createdBy: 'su-routed-reviewer', ctxHarness: 'papercusp' },
      {
        sameAcceptanceAuthor: async () => false,
        resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
      },
    );
    expect(res).toMatchObject({ ok: true, created: true });
    expect(readRubric).toHaveBeenCalledWith('ar-some-plan');
    expect(resolveAcceptanceSeatSuccession).not.toHaveBeenCalled();
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toMatchObject({
      consultId: 'conv-vet-1',
      critics: ['su-routed-reviewer'],
    });
  });

  it('does not let an unselected consult poster bypass the author-or-plan-seat boundary', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ critics: ['su-unselected-reviewer'] }),
    );
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({
      eligible: false,
      reason: 'caller_not_accountable_for_plan',
      authorSessionState: 'live',
    });
    const res = await emitScorecard(
      vettingArgs() as never,
      { createdBy: 'su-unselected-reviewer', ctxHarness: 'papercusp' },
      {
        sameAcceptanceAuthor: async () => false,
        resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
      },
    );
    expect(res.ok).toBe(false);
    expect(resolveAcceptanceSeatSuccession).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('allows an accountable successor for a dead author and stamps the vetting seat', async () => {
    const succession = {
      succeededFrom: 'su-author',
      authorSessionState: 'ended',
      basisWorkItemId: 'WI-review-1',
      basisPlanSlug: 'some-plan-2026-08-17',
      succeededAt: '2026-09-19T12:00:00.000Z',
    };
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({ eligible: true, succession });
    const res = await emitScorecard(
      vettingArgs() as never,
      { createdBy: 'su-successor', ctxHarness: 'papercusp' },
      {
        sameAcceptanceAuthor: async () => false,
        resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
      },
    );
    expect(res).toMatchObject({ ok: true, created: true });
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toMatchObject({
      consultId: 'conv-vet-1',
      seat: succession,
    });
  });

  it('refuses a dead-author successor who is not accountable for the subject plan', async () => {
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({
      eligible: false,
      reason: 'caller_not_accountable_for_plan',
      authorSessionState: 'ended',
    });
    const res = await emitScorecard(
      vettingArgs() as never,
      { createdBy: 'su-unaccountable', ctxHarness: 'papercusp' },
      {
        sameAcceptanceAuthor: async () => false,
        resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('accountable for the plan');
    expect(resolveAcceptanceSeatSuccession).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  // WI-10002535: a harness-less caller (an operator/su session) has no
  // ctxHarness. Passing null made the acceptance-drain leg of the succession
  // query FALSE, so the drain item the refusal told the caller to claim could
  // never match. The rubric's own subjectHarnessSlug must fill the gap.
  it('resolves seat succession in the rubric subject harness when the caller has no ctxHarness', async () => {
    readRubric.mockImplementation(async (id: unknown) => {
      if (id === 'meta-acceptance-rubric') return { kind: 'found', rubric: META_RUBRIC };
      if (id === 'ar-some-plan') {
        return { kind: 'found', rubric: { ...ACCEPTANCE_RUBRIC, subjectHarnessSlug: 'papercusp' } };
      }
      return { kind: 'missing' };
    });
    const resolveAcceptanceSeatSuccession = vi.fn().mockResolvedValue({
      eligible: false,
      reason: 'caller_not_accountable_for_plan',
      authorSessionState: 'ended',
    });
    const deps = {
      sameAcceptanceAuthor: async () => false,
      resolveAcceptanceSeatSuccession: resolveAcceptanceSeatSuccession as never,
    };
    await emitScorecard(vettingArgs() as never, { createdBy: 'su-harnessless' }, deps);
    expect(resolveAcceptanceSeatSuccession).toHaveBeenLastCalledWith(
      expect.objectContaining({ callerId: 'su-harnessless', harness: 'papercusp' }),
    );

    // A bound caller harness still wins over the rubric's.
    await emitScorecard(vettingArgs() as never, { createdBy: 'su-bound', ctxHarness: 'other-hive' }, deps);
    expect(resolveAcceptanceSeatSuccession).toHaveBeenLastCalledWith(
      expect.objectContaining({ callerId: 'su-bound', harness: 'other-hive' }),
    );
  });

  it('stamps observation.vetting { consultId, rubricRevision, critiquePosts, critics } + subject when the consult carries critique', async () => {
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    // The emitter is passed through so the core can exclude the emitter's OWN posts.
    expect(readVettingConsultCritique).toHaveBeenCalledWith(
      {},
      'ws-test',
      'conv-vet-1',
      'su-author',
      ['ar-some-plan', 'some-plan-2026-08-17'],
    );
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      rubricRevision: 7,
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
    expect(payload.payloadExtra.observation.subject).toEqual({ kind: 'rubric', ref: 'ar-some-plan' });
  });

  it('stamps observation.vetting { workItemId, rubricRevision, critiquePosts, critics } when a work-item carries critique', async () => {
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(readVettingWorkItemCritique).toHaveBeenCalledWith('WI-review-1', ['su-author', 'su-author', 'su-author']);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      workItemId: 'WI-review-1',
      rubricRevision: 7,
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  it('refuses a work-item link that does not resolve', async () => {
    readVettingWorkItemCritique.mockResolvedValue({ exists: false, critiquePosts: 0, critics: [] });
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('WI-review-1');
    expect(res.error).toContain('not found');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a work-item with no third-party critique rather than accepting an empty review', async () => {
    readVettingWorkItemCritique.mockResolvedValue({ exists: true, critiquePosts: 0, critics: [] });
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('NO third-party critique');
    expect(res.error).toContain('vettingConsult + vettingUnanswered');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses passing both alternate vetting channels and refuses a work-item waiver', async () => {
    const both = await emitScorecard(workItemVettingArgs({ vettingConsult: 'conv-vet-1' }) as never, EMIT_INPUT);
    expect(both.ok).toBe(false);
    if (both.ok) throw new Error('expected refusal');
    expect(both.error).toContain('EXACTLY ONE');

    const waiver = await emitScorecard(workItemVettingArgs({ vettingUnanswered: true }) as never, EMIT_INPUT);
    expect(waiver.ok).toBe(false);
    if (waiver.ok) throw new Error('expected refusal');
    expect(waiver.error).toContain('consult-only');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses vettingConsult without a subject naming the vetted rubric', async () => {
    const res = await emitScorecard(vettingArgs({ subject: undefined }) as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('subject');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('teaches plan-subject acceptance authors to omit vetting linkage and cite the meta-scorecard', async () => {
    const res = await emitScorecard(
      vettingArgs({ subject: { kind: 'plan', ref: 'some-plan-2026-08-17' } }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('only valid on the META-RUBRIC scorecard');
    expect(res.error).toContain("subject:{ kind:'rubric'");
    expect(res.error).toContain('omit vettingConsult/vettingWorkItem');
    expect(res.error).toContain('cite the separately emitted meta-rubric scorecard');
    expect(getRubric).not.toHaveBeenCalledWith('some-plan-2026-08-17');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a subject that does not resolve to a rubric (dangling link)', async () => {
    const res = await emitScorecard(
      vettingArgs({ subject: { kind: 'rubric', ref: 'no-such-rubric' } }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('no-such-rubric');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a consult that has no consult_state row (dangling link)', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ exists: false, state: null, critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('conv-vet-1');
    expect(res.error).toContain('not found in consult_state');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('omits rubricRevision (never fabricates one) when the version read fails', async () => {
    getRubricPlanRevision.mockResolvedValue(null);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  // ── WI-1393208: pin the rubric's criteriaHash alongside rubricRevision, both on
  //    the top-level card and on the vetting stamp — mirroring rubricRevision's
  //    own pin/omit-on-failure contract exactly.

  it('pins observation.criteriaHash on the top-level card when the hash read succeeds', async () => {
    getRubricCriteriaHash.mockResolvedValue('hash-abc123');
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(getRubricCriteriaHash).toHaveBeenCalledWith('meta-acceptance-rubric');
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation.criteriaHash).toBe('hash-abc123');
  });

  it('omits observation.criteriaHash (never fabricates one) when the hash read fails', async () => {
    getRubricCriteriaHash.mockResolvedValue(null);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: Record<string, unknown> };
    };
    expect(payload.payloadExtra.observation).not.toHaveProperty('criteriaHash');
  });

  it('pins vetting.criteriaHash alongside vetting.rubricRevision on a consult-channel stamp', async () => {
    getRubricCriteriaHash.mockResolvedValue('hash-vetted-rubric');
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    // The vetting stamp hashes the VETTED subject rubric ('ar-some-plan'), not the
    // meta-rubric being used to grade it — same subjectRef readRubricPlanRevision
    // pins rubricRevision from.
    expect(getRubricCriteriaHash).toHaveBeenCalledWith('ar-some-plan');
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      rubricRevision: 7,
      criteriaHash: 'hash-vetted-rubric',
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  it('pins vetting.criteriaHash alongside vetting.rubricRevision on a work-item-channel stamp', async () => {
    getRubricCriteriaHash.mockResolvedValue('hash-vetted-rubric');
    const res = await emitScorecard(workItemVettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(getRubricCriteriaHash).toHaveBeenCalledWith('ar-some-plan');
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      workItemId: 'WI-review-1',
      rubricRevision: 7,
      criteriaHash: 'hash-vetted-rubric',
      critiquePosts: 2,
      critics: ['su-reviewer'],
    });
  });

  // ── EI-20821478338037350: the gate must require CRITIQUE, not a consult ROW ──

  it('REFUSES an existing consult that nobody has replied to — the vacuous-green hole', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'awaiting_responder', critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('NO critique');
    expect(res.error).toContain('nobody has replied yet');
    expect(res.error).toContain('awaiting_responder');
    // The refusal must name the waiver, or an author with no reviewer has no legal move.
    expect(res.error).toContain('vettingUnanswered');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('distinguishes "everyone declined" from "nobody replied" — the remedies differ', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'declined', critiquePosts: 0, declinePosts: 3, critics: [] }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('DECLINED');
    expect(res.error).toContain('re-route');
    expect(res.error).not.toContain('nobody has replied yet');
  });

  it('accepts an EXPLICIT waiver and stamps it visibly (unanswered + reason) rather than passing silently', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ state: 'expired', critiquePosts: 0, critics: [] }),
    );
    const res = await emitScorecard(
      vettingArgs({
        vettingUnanswered: true,
        vettingUnansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
      }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(true);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { vetting?: Record<string, unknown> } };
    };
    expect(payload.payloadExtra.observation.vetting).toEqual({
      consultId: 'conv-vet-1',
      rubricRevision: 7,
      critiquePosts: 0,
      unanswered: true,
      unansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
    });
  });

  it('refuses a waiver with no reason — an unexplained waiver is the silent pass again', async () => {
    readVettingConsultCritique.mockResolvedValue(critique({ critiquePosts: 0, critics: [] }));
    const res = await emitScorecard(vettingArgs({ vettingUnanswered: true }) as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('vettingUnansweredReason');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a waiver without the consult id the acceptance gate requires', async () => {
    const res = await emitScorecard(
      vettingArgs({
        vettingConsult: undefined,
        vettingUnanswered: true,
        vettingUnansweredReason: 'all routed reviewers ended before replying',
      }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('vettingUnanswered requires vettingConsult');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a waiver when the consult DID receive critique — it cannot be passed reflexively', async () => {
    const res = await emitScorecard(
      vettingArgs({
        vettingUnanswered: true,
        vettingUnansweredReason: 'claiming nobody replied even though two reviewers did',
      }) as never,
      EMIT_INPUT,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('DID receive critique');
    expect(res.error).toContain('su-reviewer');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('CONTROL (falsifiability): a consult with critique is NOT refused — the guard rejects absence, not everything', async () => {
    // Pins that the four refusals above fire on the no-critique condition itself.
    // Without this, a predicate hard-wired to `false` would pass every one of them.
    readVettingConsultCritique.mockResolvedValue(critique({ critiquePosts: 1, critics: ['su-x'] }));
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('warns when SEVERAL recorded critics all resolve to one party — the advisory matches the widened refusal', async () => {
    // EI-21974075442192005 / WI-905074. The refusal was widened from
    // `critics.length === 1` to "no recorded critic is independent of the grader",
    // and this advisory — the only thing that tells the author about that refusal
    // BEFORE a reviewer burns a full grading pass — was left on the old narrow
    // test. So a vetting record naming two critics of one lineage was refused at
    // grading time having never been warned about at attestation time. An advisory
    // narrower than its rail is worse than none: its silence reads as clearance.
    lineageRelated.mockImplementation(
      async (author: unknown, candidate: unknown) =>
        author === candidate || (author === 'su-reviewer-rebound' && candidate === 'su-reviewer'),
    );
    readVettingConsultCritique.mockResolvedValue(
      critique({ critiquePosts: 2, critics: ['su-reviewer', 'su-reviewer-rebound'] }),
    );

    const vetting = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(vetting).toMatchObject({ ok: true, created: true });
    const warning = (vetting as { warning?: string }).warning;
    expect(warning).toContain('2 vetting critics who all resolve to one party');
    expect(warning).toContain("'su-reviewer'");
    expect(warning).toContain('cannot later emit the independent acceptance grade');
  });

  it('CONTROL: two INDEPENDENT critics produce no advisory — it fires on collapse, not on critic count', async () => {
    // Without this the widened predicate could be hard-wired true and every test
    // above would still pass while the advisory became noise on valid vetting.
    readVettingConsultCritique.mockResolvedValue(
      critique({ critiquePosts: 2, critics: ['su-reviewer', 'su-other-reviewer'] }),
    );
    const vetting = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(vetting).toMatchObject({ ok: true, created: true });
    expect((vetting as { warning?: string }).warning).toBeUndefined();
  });

  it('warns the author when D-031 leaves one critic unable to grade, while preserving the later refusal', async () => {
    const vetting = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(vetting).toMatchObject({
      ok: true,
      created: true,
      warning: expect.stringContaining("sole critic 'su-reviewer'"),
    });
    expect((vetting as { warning?: string }).warning).toContain('cannot later emit the independent acceptance grade');

    listScorecards.mockImplementation(async (query: { rubricRef?: string; subjectRef?: string }) => {
      if (query.rubricRef === 'meta-acceptance-rubric' && query.subjectRef === 'ar-some-plan') {
        return [
          {
            issueId: 'EI-vetting',
            createdAt: '2026-08-29T01:00:00Z',
            createdBy: 'su-author',
            rubricRef: 'meta-acceptance-rubric',
            ratings: META_RATINGS,
            nKeys: 2,
            missingKeys: [],
            extraKeys: [],
            rubricResolved: true,
            synthesized: false,
            score10: 10,
            linkedItems: [],
            vetting: {
              consultId: 'conv-vet-1',
              rubricRevision: 7,
              critiquePosts: 2,
              critics: ['su-reviewer'],
            },
          },
        ] as never;
      }
      return [];
    });

    const grade = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-reviewer', ctxHarness: 'papercusp' },
    );
    expect(grade).toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic',
      error: expect.stringContaining('sole recorded vetting critic'),
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('does not bar an independent critic from grading when a second critic vetted through the OTHER channel (EI-22182364716054326)', async () => {
    // Two SEPARATE attestations for the same rubric revision, one per channel —
    // the shape a rubric vetted twice actually produces, since scorecards:emit
    // refuses vettingConsult + vettingWorkItem together (WI-41477). Before this
    // fix, resolveAcceptanceGraderEligibility read only the first matching card
    // via `.find()` and would have barred su-reviewer here as a false "sole critic".
    listScorecards.mockImplementation(async (query: { rubricRef?: string; subjectRef?: string }) => {
      if (query.rubricRef === 'meta-acceptance-rubric' && query.subjectRef === 'ar-some-plan') {
        return [
          {
            issueId: 'EI-vetting-consult',
            createdAt: '2026-08-29T01:00:00Z',
            createdBy: 'su-author',
            rubricRef: 'meta-acceptance-rubric',
            ratings: META_RATINGS,
            nKeys: 2,
            missingKeys: [],
            extraKeys: [],
            rubricResolved: true,
            synthesized: false,
            score10: 10,
            linkedItems: [],
            vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-reviewer'] },
          },
          {
            issueId: 'EI-vetting-workitem',
            createdAt: '2026-08-29T02:00:00Z',
            createdBy: 'su-author',
            rubricRef: 'meta-acceptance-rubric',
            ratings: META_RATINGS,
            nKeys: 2,
            missingKeys: [],
            extraKeys: [],
            rubricResolved: true,
            synthesized: false,
            score10: 10,
            linkedItems: [],
            vetting: { workItemId: 'WI-review-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-other-reviewer'] },
          },
        ] as never;
      }
      return [];
    });

    const gradeByConsultCritic = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-reviewer', ctxHarness: 'papercusp' },
    );
    expect(gradeByConsultCritic).not.toMatchObject({ code: 'grader_is_sole_vetting_critic' });

    const gradeByWorkItemCritic = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-other-reviewer', ctxHarness: 'papercusp' },
    );
    expect(gradeByWorkItemCritic).not.toMatchObject({ code: 'grader_is_sole_vetting_critic' });
  });

  it('refuses third-party critique from a consult unrelated to the vetted rubric', async () => {
    readVettingConsultCritique.mockResolvedValue(
      critique({ relevance: { matched: false, matchedRefs: [], via: [] } }),
    );
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.error).toContain('vetting_consult_unrelated');
    expect(res.error).toContain('ar-some-plan');
    expect(res.error).toContain('some-plan-2026-08-17');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a re-emit that upgrades a WAIVED stamp to a real critiqued one is a vetting change, not unchanged-evidence', async () => {
    // Identical rubricRef + ratings + consult + revision: only `unanswered` moves.
    // Without unanswered in vettingChanged, the recorded waiver would be stuck forever.
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 0, unanswered: true },
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect((res as { reason?: string }).reason).not.toBe('unchanged-evidence');
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('a re-emit that only moves the vetting stamp to a NEW revision is the re-vetting step, not unchanged-evidence', async () => {
    // Same rubricRef + ratings ⇒ identical fingerprint; the ONLY difference is the
    // stamped revision (the author improved the rubric after the prior vetting).
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: { consultId: 'conv-vet-1', rubricRevision: 6 },
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT); // revision now 7
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect('reason' in res && (res as { reason?: string }).reason).not.toBe('unchanged-evidence');
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('CONTROL (falsifiability): the identical re-emit WITHOUT a vetting delta is still declined by fingerprint', async () => {
    // The inverse of the case above — proving the vettingChanged escape hatch did not
    // silently disable the unchanged-evidence dedupe for ordinary re-emits.
    const fingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'meta-acceptance-rubric',
      ratings: META_RATINGS,
    });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior',
        createdAt: '2026-08-17T01:00:00Z',
        createdBy: 'su-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: META_RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        rubricRevision: 7,
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7 }, // SAME consult + revision
        // The subject rubric's identity is part of the dedupe binding (emit.ts
        // `subjectRubricIdentityChanged`). A prior card WITHOUT it is unrecorded, and
        // unrecorded correctly escapes dedupe, so the control must pin the SAME
        // subject identity the live emit computes (beforeEach: revision 7, null hash).
        subjectRubricIdentity: { rubricRef: 'ar-some-plan', revision: 7, criteriaHash: null, meaningRevision: null },
      },
    ]);
    const res = await emitScorecard(vettingArgs() as never, EMIT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect((res as { reason?: string }).reason).toBe('unchanged-evidence');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('scorecards:emit refuses an out-of-order independent grading (EI-22177729599840121)', () => {
  // Previously this ordering was enforced ONLY at ship time
  // (plan-acceptance-gate.ts's acceptance_rubric_vetted_after_grading /
  // acceptance_rubric_unvetted) — an independent grader could spend a whole
  // (often unrepeatable) grading pass before anyone discovered the rubric was
  // never vetted. These are the recurrence guard: the ship gate must never be the
  // FIRST place this ordering is enforced.
  it('refuses a plain independent grading card when the rubric has NO vetting attestation on file', async () => {
    // beforeEach default: listScorecards resolves []  →  no attestation at all.
    const res = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-reviewer', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect((res as { code?: string }).code).toBe('acceptance_rubric_unvetted');
    expect(res.error).toContain('ar-some-plan');
    expect(res.error).toMatch(/not been VETTED/i);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a plain independent grading card when the vetting attestation is STALE (older revision)', async () => {
    getRubricPlanRevision.mockResolvedValue(9); // current revision moved past the vetted one
    listScorecards.mockImplementation(async (query: { rubricRef?: string; subjectRef?: string }) => {
      if (query.rubricRef === 'meta-acceptance-rubric' && query.subjectRef === 'ar-some-plan') {
        return [
          {
            issueId: 'EI-vetting-old',
            createdAt: '2026-08-29T01:00:00Z',
            createdBy: 'su-author',
            rubricRef: 'meta-acceptance-rubric',
            ratings: META_RATINGS,
            nKeys: 2,
            missingKeys: [],
            extraKeys: [],
            rubricResolved: true,
            synthesized: false,
            score10: 10,
            linkedItems: [],
            vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-reviewer2'] },
          },
        ] as never;
      }
      return [];
    });
    const res = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-reviewer', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect((res as { code?: string }).code).toBe('acceptance_rubric_unvetted');
    expect(res.error).toContain('revision');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('CONTROL (falsifiability): a valid current-revision attestation does NOT block the grading emit', async () => {
    listScorecards.mockImplementation(async (query: { rubricRef?: string; subjectRef?: string }) => {
      if (query.rubricRef === 'meta-acceptance-rubric' && query.subjectRef === 'ar-some-plan') {
        return [
          {
            issueId: 'EI-vetting-current',
            createdAt: '2026-08-29T01:00:00Z',
            createdBy: 'su-author',
            rubricRef: 'meta-acceptance-rubric',
            ratings: META_RATINGS,
            nKeys: 2,
            missingKeys: [],
            extraKeys: [],
            rubricResolved: true,
            synthesized: false,
            score10: 10,
            linkedItems: [],
            vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-reviewer2'] },
          },
        ] as never;
      }
      return [];
    });
    const res = await emitScorecard(
      { rubricRef: 'ar-some-plan', ratings: META_RATINGS } as never,
      { createdBy: 'su-reviewer', ctxHarness: 'papercusp' },
    );
    expect((res as { code?: string }).code).not.toBe('acceptance_rubric_unvetted');
  });
});
