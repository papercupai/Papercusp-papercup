import { describe, it, expect, vi } from 'vitest';

import gradeIdeaTool, {
  bareIdBehindAgentReviewKey,
  candidateWorkItemId,
  deriveGradedBy,
  gradeIdeaArgs,
  runGradeIdea,
  toToolResult,
  revisionNoticeMode,
  REVISION_WAKE_MAX_GRADE,
  GRADE_IDEA_FEEDBACK_MAX_CHARS,
  type GradeIdeaDeps,
  type GradeIdeaDiagnostics,
  type GradedIdeaSummary,
  type WorkItemExistenceProbeResult,
} from '../grade-idea';

/**
 * scout-idea-grading-2026-06-12 B-03 / P-003 — the C-3 tool over the C-2 seam,
 * exercised with FAKE PG deps (gym-tools pattern: no database). Pins the three
 * contract behaviors: role-derived attribution, arg validation (incl. the D-007
 * exactly-one key rule), and C-2 result pass-through (owner-grade-sovereign).
 *
 * su-ideate-learning-substrate-2026-07-10 P-005 adds the grade→revise notice
 * suite (fake send port): a grade ≤ REVISION_WAKE_MAX_GRADE with feedback on an
 * origin='su-ideate' row wakes created_by to revise or defend; a higher grade
 * with feedback is an unwoken FYI (D-008); a wake reaching nobody degrades to
 * the unwoken pot-inbox note (fallback); a send failure never fails the grade.
 */

const summary = (over: Partial<GradedIdeaSummary> = {}): GradedIdeaSummary => ({
  ideaId: 'idea-1',
  lens: 'inversion',
  rail: 'plan',
  routedRef: 'plan:some-plan-2026-06-12',
  title: 'Some idea',
  routedAt: '2026-06-12T00:00:00.000Z',
  humanGrade: 4,
  humanFeedback: 'sharp',
  gradedBy: 'owner',
  gradedAt: '2026-06-12T01:00:00.000Z',
  origin: 'scout',
  createdBy: null,
  workspaceId: 'ws-grade-test',
  ...over,
});

function fakeDeps(over: Partial<GradeIdeaDeps> = {}): GradeIdeaDeps {
  return {
    gradeRoutedIdea: vi.fn(async () => ({ applied: true })),
    resolveIdeaIdFromRef: vi.fn(async () => 'idea-1'),
    // EI-15389: default resolves an ideaId-keyed call to itself (identity) — a
    // real ledger idea_id. Per-test overrides model the bare-work-item-id
    // resolution (a bare `EI-…` → the cycle-prefixed idea_id, or null on a miss).
    resolveIdeaIdFromKey: vi.fn(async (id: string) => id),
    findAgentReviewLedgerCollision: vi.fn(async () => null),
    getWorkItem: vi.fn(async () => null),
    readIdeaSummary: vi.fn(async () => summary()),
    // D-012: default row is UNattributed (created_by null) — no self-grade path.
    readCreatedBy: vi.fn(async () => null),
    sendRevisionNotice: vi.fn(async () => ({ woken: 0 })),
    preflightAgentReviewGrade: vi.fn(async () => ({ applicable: false })),
    reconcileAgentReviewGrade: vi.fn(async () => null),
    ...over,
  };
}

describe('deriveGradedBy (C-3: attribution from caller, never args)', () => {
  it("maps the Mug's spawn ctx to 'auto-grader'", () => {
    expect(deriveGradedBy({ role: 'mug' })).toBe('auto-grader');
  });

  it('preserves an identified agent caller ownerId for attribution', () => {
    expect(deriveGradedBy({ role: 'operator', ownerId: 'su-steward-1' })).toBe('su-steward-1');
    expect(deriveGradedBy({ role: 'worker', ownerId: 'su-worker-2' })).toBe('su-worker-2');
  });

  it("maps an unidentifiable human surface (no role or ownerId) to 'owner'", () => {
    expect(deriveGradedBy(undefined)).toBe('owner');
    expect(deriveGradedBy({})).toBe('owner');
    expect(deriveGradedBy({ role: 'operator' })).toBe('owner');
    expect(deriveGradedBy({ role: 'worker' })).toBe('owner');
    expect(deriveGradedBy({ role: 'operator', ownerId: '   ' })).toBe('owner');
  });
});

describe('gradeIdeaArgs validation', () => {
  it('accepts ideaId-keyed and routedRef-keyed calls', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 4 }).success).toBe(true);
    expect(gradeIdeaArgs.safeParse({ routedRef: 'wi:42', grade: 1, feedback: 'meh' }).success).toBe(true);
  });

  it('rejects both keys and neither key (D-007 exactly-one rule)', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', routedRef: 'wi:42', grade: 3 }).success).toBe(false);
    expect(gradeIdeaArgs.safeParse({ grade: 3 }).success).toBe(false);
  });

  it('rejects out-of-range and non-integer grades', () => {
    for (const grade of [0, 6, 3.5, -1]) {
      expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade }).success).toBe(false);
    }
  });

  it('rejects empty ideaId and feedback above its hard cap while accepting the cap boundary', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: '', grade: 3 }).success).toBe(false);
    expect(
      gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, feedback: 'x'.repeat(GRADE_IDEA_FEEDBACK_MAX_CHARS) }).success,
    ).toBe(true);
    expect(
      gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, feedback: 'x'.repeat(GRADE_IDEA_FEEDBACK_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });
});

describe('runGradeIdea', () => {
  it('refuses a bare work-item key that collides with a historical row and returns the canonical review key', async () => {
    const deps = fakeDeps({
      findAgentReviewLedgerCollision: vi.fn(async (workItemId: string) => ({
        workItemId,
        ledgerIdeaId: `agent-review:${workItemId}`,
      })),
    });

    const out = await runGradeIdea({ ideaId: 'EI-42', grade: 4 }, { ownerId: 'su-reviewer' }, deps);

    expect(out).toMatchObject({
      applied: false,
      reason: 'agent-review-ledger-id-required',
      ledgerIdeaId: 'agent-review:EI-42',
      gradeWith: { ideaId: 'agent-review:EI-42' },
    });
    expect(deps.findAgentReviewLedgerCollision).toHaveBeenCalledWith('EI-42');
    expect(deps.resolveIdeaIdFromKey).not.toHaveBeenCalled();
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
    expect(deps.preflightAgentReviewGrade).not.toHaveBeenCalled();
  });

  it("writes through C-2 with gradedBy 'auto-grader' for a mug ctx and returns the read-back summary", async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => summary({ humanGrade: 5, gradedBy: 'auto-grader', humanFeedback: 'love it' })),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5, feedback: 'love it' }, { role: 'mug' }, deps);

    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      grade: 5,
      feedback: 'love it',
      gradedBy: 'auto-grader',
    });
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('auto-grader');
    expect(out.ideaId).toBe('idea-1');
    expect(out.idea?.humanGrade).toBe(5);
    // the resolver is never consulted on the ideaId path
    expect(deps.resolveIdeaIdFromRef).not.toHaveBeenCalled();
  });

  it("writes gradedBy 'owner' for the UI/superuser surface (no agent role)", async () => {
    const deps = fakeDeps();
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 2 }, undefined, deps);
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({ ideaId: 'idea-1', grade: 2, gradedBy: 'owner' });
    expect(out.gradedBy).toBe('owner');
  });

  it('emits phase entry and settle diagnostics for the grade path without changing its result', async () => {
    const deps = fakeDeps();
    const snapshots: Array<{ phases: GradeIdeaDiagnostics['phases'] }> = [];

    const out = await runGradeIdea(
      { ideaId: 'idea-1', grade: 4 },
      { role: 'operator', ownerId: 'su-reviewer' },
      deps,
      { onDiagnostics: (diagnostics) => snapshots.push({ phases: { ...diagnostics.phases } }) },
    );

    expect(out).toMatchObject({ applied: true, ideaId: 'idea-1', gradedBy: 'su-reviewer' });
    const gradeStart = snapshots.find((snapshot) => snapshot.phases.gradeRoutedIdea?.status === 'in-progress');
    expect(gradeStart?.phases.gradeRoutedIdea?.startedAt).toEqual(expect.any(String));
    expect(snapshots.at(-1)?.phases).toMatchObject({
      readCreatedBy: { status: 'ok' },
      preflightAgentReviewGrade: { status: 'ok' },
      gradeRoutedIdea: { status: 'ok' },
      readIdeaSummary: { status: 'ok' },
    });
    expect(snapshots.at(-1)?.phases.gradeRoutedIdea?.elapsedMs).toEqual(expect.any(Number));
  });

  it('writes the resolved su caller ownerId for an identified agent grade', async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => summary({ gradedBy: 'su-steward-1' })),
    });
    const out = await runGradeIdea(
      { ideaId: 'idea-1', grade: 3, feedback: 'measured critique' },
      { role: 'operator', ownerId: 'su-steward-1' },
      deps,
    );

    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      grade: 3,
      feedback: 'measured critique',
      gradedBy: 'su-steward-1',
    });
    expect(out.gradedBy).toBe('su-steward-1');
    expect(out.idea?.gradedBy).toBe('su-steward-1');
  });

  it('omits the feedback key entirely when not supplied (a regrade without feedback clears it in C-2)', async () => {
    const deps = fakeDeps();
    await runGradeIdea({ ideaId: 'idea-1', grade: 3 }, undefined, deps);
    const input = vi.mocked(deps.gradeRoutedIdea).mock.calls[0][0];
    expect('feedback' in input).toBe(false);
  });

  it('preserves 2,185-character feedback in both the ledger write and revision notice', async () => {
    const feedback = 'x'.repeat(2185);
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => summary({ origin: 'su-ideate', createdBy: 'su-originator-1' })),
    });
    const args = gradeIdeaArgs.parse({ ideaId: 'idea-1', grade: 2, feedback });
    await runGradeIdea(args, undefined, deps);
    const input = vi.mocked(deps.gradeRoutedIdea).mock.calls[0][0] as { feedback?: string };
    expect(input.feedback).toBe(feedback);
    const notice = vi.mocked(deps.sendRevisionNotice).mock.calls[0][0];
    expect(notice.body).toContain('Critique: ' + feedback);
  });

  it('rejects over-cap feedback before the ledger write or revision notice', async () => {
    const deps = fakeDeps();
    const feedback = 'x'.repeat(GRADE_IDEA_FEEDBACK_MAX_CHARS + 1);
    await expect(runGradeIdea({ ideaId: 'idea-1', grade: 3, feedback }, undefined, deps)).rejects.toThrow();
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();
  });

  it('resolves routedRef → ideaId before the write (D-007)', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromRef: vi.fn(async () => 'idea-9') });
    const out = await runGradeIdea({ routedRef: 'plan:x-2026-06-12', grade: 4 }, { role: 'mug' }, deps);
    expect(deps.resolveIdeaIdFromRef).toHaveBeenCalledWith('plan:x-2026-06-12');
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ ideaId: 'idea-9' }));
    expect(out.ideaId).toBe('idea-9');
  });

  it('returns not-found without touching the seam when a routedRef resolves to nothing', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromRef: vi.fn(async () => null) });
    const out = await runGradeIdea({ routedRef: 'wi:nope', grade: 4 }, undefined, deps);
    expect(out).toMatchObject({
      applied: false,
      reason: 'not-found',
      gradedBy: 'owner',
      ideaId: null,
      idea: null,
      diagnostic: {
        code: 'ledger-resolution-miss',
        attempted: {
          ideaId: ['wi:nope'],
          routedRef: ['wi:nope', 'wi:wi:nope', 'gym:wi:nope'],
        },
        workItem: { candidateId: null, status: 'not-attempted', family: null, kind: null },
      },
    });
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('passes the owner-grade-sovereign no-op through untouched, with the standing owner grade in the summary (D-004)', async () => {
    const deps = fakeDeps({
      gradeRoutedIdea: vi.fn(async () => ({ applied: false as const, reason: 'owner-grade-sovereign' as const })),
      readIdeaSummary: vi.fn(async () => summary({ humanGrade: 2, gradedBy: 'owner', humanFeedback: 'not this' })),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5 }, { role: 'mug' }, deps);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('owner-grade-sovereign');
    expect(out.gradedBy).toBe('auto-grader'); // what THIS call graded as
    expect(out.idea?.gradedBy).toBe('owner'); // ...and the grade that stood
    expect(out.idea?.humanGrade).toBe(2);
  });

  it("passes the seam's not-found through (ideaId-keyed miss)", async () => {
    const deps = fakeDeps({
      gradeRoutedIdea: vi.fn(async () => ({ applied: false as const, reason: 'not-found' as const })),
      readIdeaSummary: vi.fn(async () => null),
    });
    const out = await runGradeIdea({ ideaId: 'ghost', grade: 1 }, undefined, deps);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-found');
    expect(out.idea).toBeNull();
    expect(out.diagnostic).toBeUndefined();
  });

  it('synthesizes the summary from the write inputs when the read-back throws after an applied write', async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 4, feedback: 'good' }, undefined, deps);
    expect(out.applied).toBe(true);
    expect(out.idea).toMatchObject({ ideaId: 'idea-1', humanGrade: 4, humanFeedback: 'good', gradedBy: 'owner' });
  });
});

describe('EI-15389: bare work-item id keyed as ideaId resolves to the ledger PK', () => {
  it('resolves a bare work-item id (EI-*) to its cycle-prefixed idea_id before the write, so the grade LANDS (does not silently no-op)', async () => {
    // A Scout-dispatched row is keyed by the full idea_id and found only via
    // routed_ref 'wi:EI-15375' — the resolver maps the bare id to it.
    const deps = fakeDeps({
      resolveIdeaIdFromKey: vi.fn(async () => 'scout-1784334639774:scout-idea-reframing-1-1'),
      readIdeaSummary: vi.fn(async () =>
        summary({ ideaId: 'scout-1784334639774:scout-idea-reframing-1-1', routedRef: 'wi:EI-15375', humanGrade: 4 }),
      ),
    });
    const out = await runGradeIdea({ ideaId: 'EI-15375', grade: 4, feedback: 'sharp' }, { role: 'mug' }, deps);

    expect(deps.resolveIdeaIdFromKey).toHaveBeenCalledWith('EI-15375');
    // The write and read-back use the RESOLVED full idea_id, not the bare key.
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'scout-1784334639774:scout-idea-reframing-1-1',
      grade: 4,
      feedback: 'sharp',
      gradedBy: 'auto-grader',
    });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-reframing-1-1');
    expect(out.idea?.humanGrade).toBe(4);
    // The routedRef resolver is for the routedRef path only — never the ideaId path.
    expect(deps.resolveIdeaIdFromRef).not.toHaveBeenCalled();
  });

  it('LOUD not-found (isError) when the ideaId key resolves to nothing — never a success-shaped no-op, and no write is attempted', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromKey: vi.fn(async () => null) });
    const out = await runGradeIdea({ ideaId: 'EI-does-not-exist', grade: 3, feedback: 'x' }, { role: 'mug' }, deps);

    expect(out).toMatchObject({
      applied: false,
      reason: 'not-found',
      gradedBy: 'auto-grader',
      ideaId: null,
      idea: null,
      diagnostic: {
        code: 'ledger-resolution-miss',
        workItem: { candidateId: 'EI-does-not-exist', status: 'absent' },
      },
    });
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
    expect(toToolResult(out).isError).toBe(true); // surfaced loudly to the grader
  });

  it('returns not-routed with the attempted forms when an issue work-item exists without a ledger row', async () => {
    const candidate: WorkItemExistenceProbeResult = { id: 'EI-unrouted', family: 'issue', kind: 'bug' };
    const getWorkItem = vi.fn(async () => candidate);
    const deps = fakeDeps({
      resolveIdeaIdFromKey: vi.fn(async () => null),
      getWorkItem,
    });

    const out = await runGradeIdea({ ideaId: 'EI-unrouted', grade: 3 }, undefined, deps);

    expect(getWorkItem).toHaveBeenCalledWith('EI-unrouted');
    expect(out).toMatchObject({
      applied: false,
      reason: 'not-routed',
      ideaId: null,
      idea: null,
      diagnostic: {
        code: 'ledger-resolution-miss',
        attempted: { ideaId: ['EI-unrouted'], routedRef: ['EI-unrouted', 'wi:EI-unrouted', 'gym:EI-unrouted'] },
        workItem: { candidateId: 'EI-unrouted', status: 'found', family: 'issue', kind: 'bug' },
        remedy: 'blender:route-idea',
      },
    });
    expect(toToolResult(out).isError).toBe(true);
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('probes the work-item candidate derived from a bare routedRef', async () => {
    const candidate: WorkItemExistenceProbeResult = { id: 'WI-42', family: 'issue', kind: 'change' };
    const getWorkItem = vi.fn(async () => candidate);
    const deps = fakeDeps({
      resolveIdeaIdFromRef: vi.fn(async () => null),
      getWorkItem,
    });

    const out = await runGradeIdea({ routedRef: 'wi:WI-42', grade: 4 }, undefined, deps);

    expect(getWorkItem).toHaveBeenCalledWith('WI-42');
    expect(out.reason).toBe('not-routed');
    expect(out.diagnostic).toMatchObject({
      attempted: { ideaId: ['wi:WI-42'], routedRef: ['wi:WI-42', 'wi:wi:WI-42', 'gym:wi:WI-42'] },
      workItem: { candidateId: 'WI-42', status: 'found', family: 'issue' },
      remedy: 'blender:route-idea',
    });
  });

  it('keeps not-found diagnostic when the candidate is absent or the probe is unavailable', async () => {
    const absent = fakeDeps({
      resolveIdeaIdFromKey: vi.fn(async () => null),
      getWorkItem: vi.fn(async () => null),
    });
    const absentOut = await runGradeIdea({ ideaId: 'EI-absent', grade: 2 }, undefined, absent);
    expect(absentOut).toMatchObject({
      reason: 'not-found',
      diagnostic: { workItem: { candidateId: 'EI-absent', status: 'absent' } },
    });

    const unavailable = fakeDeps({
      resolveIdeaIdFromKey: vi.fn(async () => null),
      getWorkItem: vi.fn(async () => {
        throw new Error('work-item store unavailable');
      }),
    });
    const unavailableOut = await runGradeIdea({ ideaId: 'EI-unknown', grade: 2 }, undefined, unavailable);
    expect(unavailableOut).toMatchObject({
      reason: 'not-found',
      diagnostic: { workItem: { candidateId: 'EI-unknown', status: 'unavailable' } },
    });
  });

  it('does not probe plan or gym artifact refs on a ledger miss', async () => {
    const getWorkItem = vi.fn(async () => {
      throw new Error('must not probe artifact refs');
    });
    const deps = fakeDeps({ resolveIdeaIdFromRef: vi.fn(async () => null), getWorkItem });

    for (const routedRef of ['plan:missing-plan', 'gym:SP-404']) {
      const out = await runGradeIdea({ routedRef, grade: 2 }, undefined, deps);
      expect(out.reason).toBe('not-found');
      expect(out.diagnostic?.workItem).toMatchObject({
        candidateId: null,
        status: 'not-attempted',
      });
    }
    expect(getWorkItem).not.toHaveBeenCalled();
  });
});

describe('EI-24742538368325488: an `agent-review:<id>` ideaId falls back to the bare work-item id', () => {
  const WI = 'EI-22451127204495357';
  const PREFIXED = `agent-review:${WI}`;
  /** A ledger that only knows the BARE id — the common case: enrollment prefixes the PK only on a collision. */
  const bareOnlyLedger = () => vi.fn(async (key: string) => (key === WI ? WI : null));

  it('grades the bare-keyed ledger row after the exact prefixed lookup misses (the reported repro)', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromKey: bareOnlyLedger() });

    const out = await runGradeIdea({ ideaId: PREFIXED, grade: 3, feedback: 'needs work' }, { ownerId: 'su-reviewer' }, deps);

    expect(out).toMatchObject({ applied: true, ideaId: WI });
    expect(deps.resolveIdeaIdFromKey).toHaveBeenNthCalledWith(1, PREFIXED); // exact form first
    expect(deps.resolveIdeaIdFromKey).toHaveBeenNthCalledWith(2, WI);
    expect(deps.findAgentReviewLedgerCollision).toHaveBeenCalledWith(WI); // same guard a bare id gets
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ ideaId: WI, grade: 3 }));
  });

  it('an exact prefixed ledger row WINS — no fallback, no collision probe, the prefixed row is the one graded', async () => {
    const deps = fakeDeps(); // default resolver is identity: the prefixed key IS a ledger PK

    const out = await runGradeIdea({ ideaId: PREFIXED, grade: 4 }, { ownerId: 'su-reviewer' }, deps);

    expect(out).toMatchObject({ applied: true, ideaId: PREFIXED });
    expect(deps.resolveIdeaIdFromKey).toHaveBeenCalledTimes(1);
    expect(deps.findAgentReviewLedgerCollision).not.toHaveBeenCalled();
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ ideaId: PREFIXED }));
  });

  it('refuses with the canonical ledger id when the bare id collides with a historical row, never grading it by accident', async () => {
    const deps = fakeDeps({
      resolveIdeaIdFromKey: vi.fn(async () => null),
      findAgentReviewLedgerCollision: vi.fn(async (workItemId: string) => ({
        workItemId,
        ledgerIdeaId: 'scout-1:scout-idea-x',
      })),
    });

    const out = await runGradeIdea({ ideaId: PREFIXED, grade: 4 }, { ownerId: 'su-reviewer' }, deps);

    expect(out).toMatchObject({
      applied: false,
      reason: 'agent-review-ledger-id-required',
      gradeWith: { ideaId: 'scout-1:scout-idea-x' },
    });
    expect(deps.resolveIdeaIdFromKey).toHaveBeenCalledTimes(1); // the bare lookup is never reached
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('a total miss reports BOTH key forms and probes the work item behind the prefix (was status:not-attempted)', async () => {
    const candidate: WorkItemExistenceProbeResult = { id: WI, family: 'issue', kind: 'bug' };
    const getWorkItem = vi.fn(async () => candidate);
    const deps = fakeDeps({ resolveIdeaIdFromKey: vi.fn(async () => null), getWorkItem });

    const out = await runGradeIdea({ ideaId: PREFIXED, grade: 3 }, undefined, deps);

    expect(getWorkItem).toHaveBeenCalledWith(WI);
    expect(out).toMatchObject({
      applied: false,
      reason: 'not-routed',
      ideaId: null,
      diagnostic: {
        code: 'ledger-resolution-miss',
        attempted: { ideaId: [PREFIXED, WI] },
        workItem: { candidateId: WI, status: 'found', family: 'issue' },
        remedy: 'blender:route-idea',
      },
    });
    expect(out.diagnostic?.attempted.routedRef).toEqual(
      expect.arrayContaining([PREFIXED, `wi:${PREFIXED}`, `gym:${PREFIXED}`, WI, `wi:${WI}`, `gym:${WI}`]),
    );
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('a prefix whose remainder is not work-item-shaped gets no fallback (single lookup, single attempted form)', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromKey: vi.fn(async () => null) });

    const out = await runGradeIdea({ ideaId: 'agent-review:not-a-work-item', grade: 2 }, undefined, deps);

    expect(out).toMatchObject({
      reason: 'not-found',
      diagnostic: { attempted: { ideaId: ['agent-review:not-a-work-item'] }, workItem: { status: 'not-attempted' } },
    });
    expect(deps.resolveIdeaIdFromKey).toHaveBeenCalledTimes(1);
    expect(deps.findAgentReviewLedgerCollision).not.toHaveBeenCalled();
  });

  it('bareIdBehindAgentReviewKey / candidateWorkItemId strip only a work-item-shaped agent-review: prefix', () => {
    expect(bareIdBehindAgentReviewKey(PREFIXED)).toBe(WI);
    expect(bareIdBehindAgentReviewKey('AGENT-REVIEW:WI-7')).toBe('WI-7');
    expect(bareIdBehindAgentReviewKey(WI)).toBeNull(); // a bare id has nothing to strip
    expect(bareIdBehindAgentReviewKey('agent-review:')).toBeNull();
    expect(bareIdBehindAgentReviewKey('agent-review:plan-x')).toBeNull();
    expect(candidateWorkItemId({ ideaId: PREFIXED, grade: 3 } as never)).toBe(WI);
    expect(candidateWorkItemId({ ideaId: 'agent-review:plan-x', grade: 3 } as never)).toBeNull();
  });
});

describe('D-012 no-self-grade guard (su-ideate-learning-substrate-2026-07-10 WI-4108)', () => {
  const SELF = 'su-ideator-self';

  it('REFUSES when the caller authored the row (created_by === caller ownerId): no write, no notice, reason no-self-grade', async () => {
    const deps = fakeDeps({ readCreatedBy: vi.fn(async () => SELF) });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5, feedback: 'love my own idea' }, { ownerId: SELF }, deps);

    expect(out).toEqual({ applied: false, reason: 'no-self-grade', gradedBy: SELF, ideaId: 'idea-1', idea: null });
    // The pollution the guard exists to prevent never happens: no ledger write,
    // no read-back, no revision wake fed by a self-authored grade.
    expect(deps.readCreatedBy).toHaveBeenCalledWith('idea-1');
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
    expect(deps.readIdeaSummary).not.toHaveBeenCalled();
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();
    expect(deps.preflightAgentReviewGrade).not.toHaveBeenCalled();
    expect(deps.reconcileAgentReviewGrade).not.toHaveBeenCalled();
  });

  it('catches a self-grade keyed by routedRef too (guard runs AFTER ref→ideaId resolution)', async () => {
    const deps = fakeDeps({
      resolveIdeaIdFromRef: vi.fn(async () => 'idea-9'),
      readCreatedBy: vi.fn(async () => SELF),
    });
    const out = await runGradeIdea({ routedRef: 'wi:F-9', grade: 4, feedback: 'mine' }, { ownerId: SELF }, deps);
    expect(deps.resolveIdeaIdFromRef).toHaveBeenCalledWith('wi:F-9');
    expect(deps.readCreatedBy).toHaveBeenCalledWith('idea-9');
    expect(out).toMatchObject({ applied: false, reason: 'no-self-grade', ideaId: 'idea-9' });
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('a CROSS-author grade is unaffected — the write proceeds and role-derived attribution is preserved', async () => {
    const deps = fakeDeps({
      readCreatedBy: vi.fn(async () => 'someone-else'),
      readIdeaSummary: vi.fn(async () => summary({ gradedBy: 'auto-grader' })),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 4, feedback: 'sharp' }, { role: 'mug', ownerId: SELF }, deps);
    expect(deps.readCreatedBy).toHaveBeenCalledWith('idea-1');
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({ ideaId: 'idea-1', grade: 4, feedback: 'sharp', gradedBy: 'auto-grader' });
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('auto-grader'); // C-3 attribution intact for a non-author
  });

  it('fails OPEN on an unattributable ctx (no ownerId): the guard never fires and never even reads created_by', async () => {
    const deps = fakeDeps({ readCreatedBy: vi.fn(async () => SELF) }); // would match IF we could attribute
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5, feedback: 'x' }, undefined, deps);
    expect(deps.readCreatedBy).not.toHaveBeenCalled(); // short-circuit on null callerOwnerId
    expect(deps.gradeRoutedIdea).toHaveBeenCalledTimes(1);
    expect(out.applied).toBe(true);
  });
});

describe('agent-review grade lifecycle (abolish-human-review D-003/P-004)', () => {
  const pending = {
    status: 'pending' as const,
    submittedBy: 'su-filer',
    ledgerIdeaId: 'idea-1',
    round: 1,
  };

  it('refuses a low review grade without feedback before either store is mutated', async () => {
    const deps = fakeDeps({
      preflightAgentReviewGrade: vi.fn(async () => ({
        applicable: true,
        workItemId: 'WI-42',
        state: pending,
        refusal: 'agent-review-feedback-required' as const,
      })),
    });

    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 3 }, { ownerId: 'su-reviewer' }, deps);

    expect(out).toEqual({
      applied: false,
      reason: 'agent-review-feedback-required',
      gradedBy: 'su-reviewer',
      ideaId: 'idea-1',
      idea: null,
    });
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
    expect(deps.reconcileAgentReviewGrade).not.toHaveBeenCalled();
  });

  it('writes an accepted grade, reconciles the work item, and returns the lifecycle transition', async () => {
    const reconciled = {
      workItemId: 'WI-42',
      status: 'approved' as const,
      round: 1,
      changed: true,
    };
    const deps = fakeDeps({
      preflightAgentReviewGrade: vi.fn(async () => ({ applicable: true, workItemId: 'WI-42', state: pending })),
      reconcileAgentReviewGrade: vi.fn(async () => reconciled),
    });

    const out = await runGradeIdea(
      { routedRef: 'wi:WI-42', grade: 5, feedback: 'ready' },
      { ownerId: 'su-reviewer' },
      deps,
    );

    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      grade: 5,
      feedback: 'ready',
      gradedBy: 'su-reviewer',
    });
    expect(deps.reconcileAgentReviewGrade).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      gradedBy: 'su-reviewer',
    });
    expect(out.agentReview).toEqual(reconciled);
  });

  it('uses the agent-review revision delivery only, even when enrollment preserved su-ideate provenance', async () => {
    const deps = fakeDeps({
      preflightAgentReviewGrade: vi.fn(async () => ({ applicable: true, workItemId: 'WI-42', state: pending })),
      reconcileAgentReviewGrade: vi.fn(async () => ({
        workItemId: 'WI-42',
        status: 'revision-requested' as const,
        round: 1,
        changed: true,
        woken: 1,
      })),
      readIdeaSummary: vi.fn(async () => summary({ origin: 'su-ideate', createdBy: 'su-filer' })),
    });

    const out = await runGradeIdea(
      { ideaId: 'idea-1', grade: 2, feedback: 'tighten the evidence' },
      { ownerId: 'su-reviewer' },
      deps,
    );

    expect(out.agentReview).toMatchObject({ status: 'revision-requested', woken: 1 });
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();
    expect('revisionWake' in out).toBe(false);
  });

  it('retries through an owner-sovereign ledger no-op and still converges routing from the standing grade', async () => {
    const preflight = vi.fn(async () => ({ applicable: true, workItemId: 'WI-42', state: pending }));
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('payload write interrupted'))
      .mockResolvedValueOnce({ workItemId: 'WI-42', status: 'approved', round: 1, changed: true });
    const grade = vi
      .fn()
      .mockResolvedValueOnce({ applied: true })
      .mockResolvedValueOnce({ applied: false, reason: 'owner-grade-sovereign' });
    const deps = fakeDeps({
      preflightAgentReviewGrade: preflight,
      reconcileAgentReviewGrade: reconcile,
      gradeRoutedIdea: grade,
    });

    await expect(
      runGradeIdea({ ideaId: 'idea-1', grade: 5, feedback: 'approved' }, { ownerId: 'su-reviewer' }, deps),
    ).rejects.toThrow('payload write interrupted');
    const retry = await runGradeIdea(
      { ideaId: 'idea-1', grade: 5, feedback: 'approved' },
      { ownerId: 'su-reviewer' },
      deps,
    );

    expect(retry.applied).toBe(false);
    expect(retry.reason).toBe('owner-grade-sovereign');
    expect(retry.agentReview).toMatchObject({ status: 'approved', changed: true });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('revision notice (su-ideate-learning-substrate-2026-07-10 P-005 / D-008) — fake send port', () => {
  const suRow = (over: Partial<GradedIdeaSummary> = {}): GradedIdeaSummary =>
    summary({ origin: 'su-ideate', createdBy: 'su-originator-1', routedRef: 'wi:F-101', ...over });

  it('grade ≤ REVISION_WAKE_MAX_GRADE + feedback on a su-ideate row WAKES created_by, carrying critique + routedRef + the revise-or-defend ask', async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => suRow()),
      sendRevisionNotice: vi.fn(async () => ({ woken: 1 })),
    });
    const out = await runGradeIdea(
      { ideaId: 'idea-1', grade: REVISION_WAKE_MAX_GRADE, feedback: 'too vague — quantify the win' },
      undefined,
      deps,
    );

    expect(out.applied).toBe(true);
    expect(deps.sendRevisionNotice).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(deps.sendRevisionNotice).mock.calls[0][0];
    expect(notice.to).toEqual(['su-originator-1']);
    expect(notice.wake).toBe(true);
    // Coord delivery runs under the ROW's workspace, not the ALS default (EI-346).
    expect(notice.workspaceId).toBe('ws-grade-test');
    expect(notice.body).toContain('too vague — quantify the win');
    expect(notice.body).toContain('wi:F-101');
    expect(notice.body).toContain("observation.linkTo: [{ targetId: 'F-101', rel: 'revises' }]");
    expect(notice.body).toContain('otherwise coord:send a reply defending this one');
    expect(out.revisionWake).toEqual({ sent: true, woken: 1, fallback: false });
  });

  it('a wake that reaches nobody (woken 0 / dead originator) degrades to the unwoken pot-inbox note: fallback:true, the grade stands', async () => {
    const deps = fakeDeps({ readIdeaSummary: vi.fn(async () => suRow()) }); // default port: woken 0
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 2, feedback: 'derivative' }, undefined, deps);
    expect(out.applied).toBe(true);
    expect(out.revisionWake).toEqual({ sent: true, woken: 0, fallback: true });
  });

  it('grade above the threshold + feedback delivers the UNWOKEN FYI (D-008): wake:false and never a fallback', async () => {
    const deps = fakeDeps({ readIdeaSummary: vi.fn(async () => suRow()) });
    const out = await runGradeIdea(
      { ideaId: 'idea-1', grade: REVISION_WAKE_MAX_GRADE + 1, feedback: 'good — ship it' },
      undefined,
      deps,
    );
    const notice = vi.mocked(deps.sendRevisionNotice).mock.calls[0][0];
    expect(notice.wake).toBe(false);
    expect(notice.to).toEqual(['su-originator-1']);
    expect(notice.summary).toContain('FYI');
    expect(notice.body).toContain('good — ship it');
    expect(out.revisionWake).toEqual({ sent: true, woken: 0, fallback: false });
  });

  it('stays silent (no notice, no revisionWake key) without feedback, off-origin, without created_by, and on a sovereign no-op', async () => {
    // No feedback: a bare low grade nudges nobody.
    let deps = fakeDeps({ readIdeaSummary: vi.fn(async () => suRow()) });
    let out = await runGradeIdea({ ideaId: 'idea-1', grade: 1 }, undefined, deps);
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();
    expect('revisionWake' in out).toBe(false);

    // Scout origin: the su revision loop never touches Scout's own ideas (D-002).
    deps = fakeDeps({ readIdeaSummary: vi.fn(async () => summary({ createdBy: 'su-originator-1' })) });
    await runGradeIdea({ ideaId: 'idea-1', grade: 1, feedback: 'meh' }, undefined, deps);
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();

    // su-ideate but no created_by (pre-P-001 legacy row): nobody to address.
    deps = fakeDeps({ readIdeaSummary: vi.fn(async () => suRow({ createdBy: null })) });
    await runGradeIdea({ ideaId: 'idea-1', grade: 1, feedback: 'meh' }, undefined, deps);
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();

    // Owner-grade-sovereign no-op: nothing was written — never re-notify.
    deps = fakeDeps({
      gradeRoutedIdea: vi.fn(async () => ({ applied: false as const, reason: 'owner-grade-sovereign' as const })),
      readIdeaSummary: vi.fn(async () => suRow()),
    });
    out = await runGradeIdea({ ideaId: 'idea-1', grade: 1, feedback: 'meh' }, { role: 'mug' }, deps);
    expect(deps.sendRevisionNotice).not.toHaveBeenCalled();
    expect('revisionWake' in out).toBe(false);
  });

  it('best-effort by contract: a THROWING send port never fails the grade — applied stands, revisionWake reports sent:false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = fakeDeps({
        readIdeaSummary: vi.fn(async () => suRow()),
        sendRevisionNotice: vi.fn(async () => {
          throw new Error('coord down');
        }),
      });
      const out = await runGradeIdea({ ideaId: 'idea-1', grade: 1, feedback: 'unsound premise' }, undefined, deps);
      expect(out.applied).toBe(true);
      expect(out.revisionWake).toEqual({ sent: false, woken: 0, fallback: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('revision notice failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('revisionNoticeMode is the D-008 truth table around the NAMED threshold', () => {
    const base = { applied: true, origin: 'su-ideate', createdBy: 'su-x', feedback: 'critique' };
    expect(REVISION_WAKE_MAX_GRADE).toBe(3);
    expect(revisionNoticeMode({ ...base, grade: REVISION_WAKE_MAX_GRADE })).toBe('wake');
    expect(revisionNoticeMode({ ...base, grade: 1 })).toBe('wake');
    expect(revisionNoticeMode({ ...base, grade: REVISION_WAKE_MAX_GRADE + 1 })).toBe('fyi');
    expect(revisionNoticeMode({ ...base, grade: 5 })).toBe('fyi');
    expect(revisionNoticeMode({ ...base, grade: 2, feedback: '   ' })).toBe('none');
    expect(revisionNoticeMode({ ...base, grade: 2, applied: false })).toBe('none');
    expect(revisionNoticeMode({ ...base, grade: 2, origin: 'scout' })).toBe('none');
    expect(revisionNoticeMode({ ...base, grade: 2, createdBy: null })).toBe('none');
  });
});

describe('toToolResult envelope', () => {
  const base = { applied: true, gradedBy: 'owner' as const, ideaId: 'i1', idea: null };

  it('is not an error for applied writes, the sovereign no-op, nor the D-012 self-grade refusal', () => {
    expect(toToolResult(base).isError).toBeUndefined();
    expect(
      toToolResult({ ...base, applied: false, reason: 'owner-grade-sovereign' }).isError,
    ).toBeUndefined();
    // no-self-grade is designed behavior (a refusal), not a not-found error.
    expect(
      toToolResult({ ...base, applied: false, reason: 'no-self-grade' }).isError,
    ).toBeUndefined();
  });

  it('flags not-found as an error', () => {
    const res = toToolResult({ ...base, applied: false, ideaId: null, reason: 'not-found' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).reason).toBe('not-found');
  });

  it('flags not-routed as an error', () => {
    const res = toToolResult({ ...base, applied: false, ideaId: null, reason: 'not-routed' });
    expect(res.isError).toBe(true);
  });
});

describe('tool registration (C-3 surface)', () => {
  it('is reachable through the unified projection registry (the admin route/tool proxy dispatch path)', async () => {
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('blender:grade-idea');
    expect(projected, 'blender:grade-idea registered').toBeTruthy();
  });

  it('registers as blender:grade-idea with the SU+Mug allowlist and derived-attribution args', () => {
    const tool = gradeIdeaTool as unknown as {
      name: string;
      timeoutSec?: number;
      agentRoles?: string[];
      guidance?: { when?: string };
    };
    expect(tool.name).toBe('blender:grade-idea');
    // tools:invoke applies a 55s fallback when a target omits its declared budget.
    // Keep this write-capable grade tool at 60s so its nested transport deadline
    // includes the shared 5s buffer and does not time out before a slow grade settles.
    expect(tool.timeoutSec).toBe(60);
    expect(tool.agentRoles).toContain('mug');
    expect(tool.agentRoles).toContain('operator');
    // gradedBy is derived, never an arg (C-3)
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, gradedBy: 'owner' }).success).toBe(true);
    const parsed = gradeIdeaArgs.parse({ ideaId: 'i1', grade: 3, gradedBy: 'owner' });
    expect('gradedBy' in parsed).toBe(false); // stripped, not honored
  });
});
