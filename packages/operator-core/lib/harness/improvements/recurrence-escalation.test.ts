/**
 * recurrence-escalation tests
 * (learning-system-audit-improvements-2026-06-09 P-053 + P-052 lite).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CANDIDATE_DRAFT_MAX_CHARS,
  INSTANCE_EVIDENCE_MARKER,
  INSTANCE_EVIDENCE_MAX_PROPOSALS,
  RECURRENCE_ESCALATION_THRESHOLD,
  RECURRING_SIGNATURE_SCAN_CAP,
  RECURRING_MEMBER_HYDRATION_CAP,
  planInstanceEvidenceProposals,
  planRecurrenceEscalation,
  renderSeverityProposalComment,
  runRecurrenceEscalation,
  selectRecurringSignatures,
  type EscalationDeps,
} from './recurrence-escalation';
import type { StageCandidateInput } from '../../knowledge-packs/candidates';
import type { ImprovementCandidate } from './policy';

const daysAgo = (d: number): string => new Date(Date.now() - d * 86400000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'memory search keeps timing out badly',
    state: 'open',
    severity: 'minor',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...p,
  };
}

/** Three same-signature members (the ≥3 threshold). */
const trio = (over: Partial<ImprovementCandidate> = {}) => [
  cand({ id: 'a', createdAt: daysAgo(5), state: 'resolved', ...over }),
  cand({ id: 'b', createdAt: daysAgo(3), ...over }),
  cand({ id: 'c', createdAt: daysAgo(1), ...over }),
];

describe('planRecurrenceEscalation', () => {
  it('≥3 recurrence: escalates the newest open minor to major AND routes the prompt class to gym', () => {
    const actions = planRecurrenceEscalation(trio());
    const esc = actions.find((a) => a.kind === 'escalate-severity');
    expect(esc).toMatchObject({ id: 'c', from: 'minor', to: 'major', count: 3 });
    // D-005: a chronic code-bug (operator scope, no prompt markers) gets severity
    // pressure but NOT the gym — the gym A/Bs prompt variants, not code fixes.
    expect(actions.find((a) => a.kind === 'route-gym')).toBeUndefined();

    // The gym route fires for the process-prompt class.
    const promptActions = planRecurrenceEscalation(trio({ title: 'queen persona wording keeps over-instructing' }));
    expect(promptActions.find((a) => a.kind === 'route-gym')).toMatchObject({ id: 'c' });
  });

  it('below threshold, already-major, claimed, or already-gym-routed → no duplicate pressure', () => {
    const below = planRecurrenceEscalation([cand({ id: 'x' }), cand({ id: 'y', createdAt: daysAgo(2) })]);
    expect(below).toHaveLength(0);

    const major = planRecurrenceEscalation(trio({ severity: 'major' }));
    expect(major.find((a) => a.kind === 'escalate-severity')).toBeUndefined();

    const claimed = planRecurrenceEscalation(trio({ assignee: 'runner' }));
    expect(claimed.filter((a) => a.kind !== 'suggest-promotion')).toHaveLength(0);

    const routed = planRecurrenceEscalation(
      trio({
        title: 'queen persona wording keeps over-instructing',
        ideaLifecycle: { state: 'triaged', stateUpdatedAt: daysAgo(1), triageDecision: 'gym' },
      }),
    );
    expect(routed.find((a) => a.kind === 'route-gym')).toBeUndefined();
  });

  it('product-class (harness:*) recurrence escalates severity but does NOT route to gym', () => {
    const actions = planRecurrenceEscalation(trio({ scope: 'harness:sheets' }));
    expect(actions.find((a) => a.kind === 'escalate-severity')).toBeDefined();
    expect(actions.find((a) => a.kind === 'route-gym')).toBeUndefined();
  });

  it('cross-scope recurrence proposes ONE shared-lesson promotion (P-052 lite)', () => {
    const actions = planRecurrenceEscalation([
      cand({ id: 'op', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'h1', scope: 'harness:sheets', createdAt: daysAgo(3) }),
      cand({ id: 'h2', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]);
    const promos = actions.filter((a) => a.kind === 'suggest-promotion');
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ count: 3 });
    expect(promos[0].kind === 'suggest-promotion' && promos[0].scopes.length).toBe(3);
  });

  it('suggest-promotion carries candidate provenance: member ids + a capped draft body (P-032)', () => {
    const longBody = 'lesson '.repeat(200); // > CANDIDATE_DRAFT_MAX_CHARS
    const actions = planRecurrenceEscalation([
      cand({ id: 'op', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'h1', scope: 'harness:sheets', createdAt: daysAgo(3), body: longBody }),
      cand({ id: 'h2', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]);
    const promo = actions.find((a) => a.kind === 'suggest-promotion');
    if (promo?.kind !== 'suggest-promotion') throw new Error('expected a suggest-promotion');
    expect([...promo.sourceItemIds].sort()).toEqual(['h1', 'h2', 'op']);
    expect(promo.draftText.length).toBeLessThanOrEqual(CANDIDATE_DRAFT_MAX_CHARS);
    expect(promo.draftText.startsWith('lesson ')).toBe(true); // newest member WITH a body wins

    // No member body anywhere → the title is the draft.
    const bare = planRecurrenceEscalation([
      cand({ id: 'a1', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'a2', scope: 'harness:sheets', createdAt: daysAgo(3) }),
      cand({ id: 'a3', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]).find((a) => a.kind === 'suggest-promotion');
    if (bare?.kind !== 'suggest-promotion') throw new Error('expected a suggest-promotion');
    expect(bare.draftText).toBe(bare.sampleTitle);
  });

  it('respects maxActions', () => {
    const many = Array.from({ length: 4 }, (_, g) =>
      [0, 1, 2].map((i) =>
        cand({
          id: `g${g}-${i}`,
          title: `distinct recurring friction group number ${g} token${g}`,
          createdAt: daysAgo(3 - i),
        }),
      ),
    ).flat();
    expect(planRecurrenceEscalation(many, { maxActions: 3 })).toHaveLength(3);
  });
});

describe('runRecurrenceEscalation — glue', () => {
  const glueItems = () => [
    // Prompt-class trio so the gym edge of the glue stays exercised (D-005:
    // only process-prompt routes to gym).
    ...trio({ title: 'queen persona wording keeps over-instructing' }),
    cand({ id: 'x1', title: 'cross scope pain everywhere always', scope: 'operator', createdAt: daysAgo(4) }),
    cand({ id: 'x2', title: 'cross scope pain everywhere always', scope: 'harness:sheets', createdAt: daysAgo(3) }),
    cand({ id: 'x3', title: 'cross scope pain everywhere always', scope: 'harness:papercup', createdAt: daysAgo(2) }),
  ];

  const baseDeps = (over: Partial<EscalationDeps> = {}): EscalationDeps => ({
    readItems: vi.fn<EscalationDeps['readItems']>(async () => glueItems()),
    // Mirrors projectImprovementItemsForBoundedRead: the phase-1 census runs the
    // caller's projector over the whole corpus. The double reads from `over.readItems`
    // when supplied so a test that stubs the corpus still drives both phases.
    scanCorpus: vi.fn<EscalationDeps['scanCorpus']>(async (_opts, projection) =>
      projection.project(await (over.readItems ?? (async () => glueItems()))()),
    ),
    updateIssue: vi.fn(async () => null),
    commentIssue: vi.fn(async () => null),
    applyTriage: vi.fn(async (input) => ({ ok: true, id: input.id })),
    capture: vi.fn(async () => ({ ok: true as const, created: true, possibleDuplicates: [] })),
    stageCandidate: vi.fn(async () => ({ staged: true as const, id: 'cand-1' })),
    readInstanceEvidence: vi.fn<EscalationDeps['readInstanceEvidence']>(async () => []),
    ...over,
  });

  it('WI-1216687: censuses the WHOLE corpus on cheap columns — never a per-scope newest-N window', async () => {
    const scanCorpus = vi.fn<EscalationDeps['scanCorpus']>(async () => []);
    await runRecurrenceEscalation({}, baseDeps({ scanCorpus }));

    // The old read was `{ windowPerScope: true }` with no `limit`, which read-items
    // defaults to 500 PER SCOPE — measured at just 14.1h of history for the scope
    // holding 96.9% of the corpus. WI-9454's per-scope fairness concern is subsumed:
    // there is no window left for a busy scope to crowd a small one out of.
    const [opts, projection] = scanCorpus.mock.calls[0]!;
    expect(opts).toEqual({ includeBody: false, includePayload: false, includeWatchdogKey: true });
    expect(opts).not.toHaveProperty('windowPerScope');
    expect(opts).not.toHaveProperty('limit');
    expect(projection.maxRows).toBe(RECURRING_SIGNATURE_SCAN_CAP);
  });

  it('censuses WITH the watchdog key — dropping payload wholesale makes the whole census title-only in silence', async () => {
    const scanCorpus = vi.fn<EscalationDeps['scanCorpus']>(async () => []);
    await runRecurrenceEscalation({}, baseDeps({ scanCorpus }));

    // `recurrenceGroupKey` prefers `candidate.watchdogKey` and falls back to the
    // title signature. `watchdogKey` is optional, so a census that drops payload
    // gets `undefined` for EVERY row and silently falls back for the whole corpus —
    // no type error, no failing assertion, just recurrence detection quietly
    // reverting to free-prose titles (155 groups reaching the threshold where the
    // key finds 538, measured 2026-09-06 over the 21,338 keyed observation rows).
    //
    // This is a projection/behaviour coupling nothing else can catch: the cost
    // pressure that produced the payload-less read is real and recurring, so the
    // next optimisation pass must fail HERE rather than silently re-inert the lane.
    const [opts] = scanCorpus.mock.calls[0]!;
    expect(
      opts.includeWatchdogKey,
      'the recurrence census must ask for watchdogKey back, or it groups on titles alone',
    ).toBe(true);
  });

  it('WI-1216687: hydrates phase 2 by explicit member ids, so counting is a SET read and not a recency window', async () => {
    const readItems = vi.fn<EscalationDeps['readItems']>(async () => glueItems());
    await runRecurrenceEscalation({}, baseDeps({ readItems }));

    // Both glue groups clear the threshold, so every member id is hydrated by id.
    const call = readItems.mock.calls.find((c) => c[0]?.issueIds);
    expect(call, 'phase 2 must re-read by issueIds').toBeTruthy();
    expect([...(call![0]!.issueIds ?? [])].sort()).toEqual(['a', 'b', 'c', 'x1', 'x2', 'x3']);
    // The limit must not silently re-cap the very read that exists to be exact.
    expect(call![0]!.limit).toBe(6);
  });

  it('WI-1216687: a group larger than the hydration budget is skipped WHOLE, never truncated', async () => {
    // A truncated group would under-report `sig.count` — the number that both clears
    // the ≥3 threshold and is quoted to the owner as "recurred N×".
    const huge = Array.from({ length: RECURRING_MEMBER_HYDRATION_CAP + 1 }, (_, i) =>
      cand({ id: `h${i}`, title: 'huge recurring signature group here' }),
    );
    const readItems = vi.fn<EscalationDeps['readItems']>(async () => huge);
    await runRecurrenceEscalation({}, baseDeps({ readItems }));

    const hydration = readItems.mock.calls.find((c) => c[0]?.issueIds);
    expect(hydration, 'an over-budget group must not be hydrated at all').toBeFalsy();
  });

  it('applies each action through the right edge', async () => {
    const updated: string[] = [];
    const captured: string[] = [];
    const stagedInputs: StageCandidateInput[] = [];
    const deps = baseDeps({
      updateIssue: vi.fn(async (id) => {
        updated.push(id);
        return null;
      }),
      capture: vi.fn(async (input) => {
        captured.push(input.title);
        return { ok: true as const, created: true, possibleDuplicates: [] };
      }),
      stageCandidate: vi.fn(async (input) => {
        stagedInputs.push(input);
        return { staged: true as const, id: 'cand-1' };
      }),
    });
    const res = await runRecurrenceEscalation({}, deps);
    expect(res.escalated).toBe(2); // both signature groups have a minor newest-open
    expect(res.gymRouted).toBe(1); // only the prompt-class trio routes to gym (the cross-scope group is code-bug, D-005)
    expect(res.promotionsSuggested).toBe(1);
    expect(captured[0]).toContain('promote a shared lesson');

    // P-032: the cross-scope promotion ALSO staged one candidate, with provenance.
    expect(res.candidatesStaged).toBe(1);
    expect(stagedInputs).toHaveLength(1);
    expect(stagedInputs[0]).toMatchObject({
      title: 'cross scope pain everywhere always',
      recurrenceCount: 3,
    });
    expect([...(stagedInputs[0]!.sourceItemIds ?? [])].sort()).toEqual(['x1', 'x2', 'x3']);
    expect(stagedInputs[0]!.scopes.sort()).toEqual(['harness:papercup', 'harness:sheets', 'operator']);
    expect(stagedInputs[0]!.signature).toBeTruthy();
  });

  it('EI-9170: the suggest-promotion capture must NOT use dedupScope:"open" — a resolved prior promotion has to keep blocking re-file, or the same proposal re-files every tick forever', async () => {
    const captureInputs: Array<{ dedupScope?: 'all' | 'open' }> = [];
    const deps = baseDeps({
      capture: vi.fn(async (input) => {
        captureInputs.push({ dedupScope: input.dedupScope });
        return { ok: true as const, created: true, possibleDuplicates: [] };
      }),
    });
    await runRecurrenceEscalation({}, deps);
    expect(captureInputs).toHaveLength(1);
    // Resolving this capture means the lesson was promoted, not that the friction
    // stopped recurring — a resolved duplicate must still decline the re-create.
    // dedupScope:'open' is the watchdog regression-reopen semantic and is wrong here.
    expect(captureInputs[0]!.dedupScope).not.toBe('open');
  });

  it('a deduped/capped stage does not count; a throwing stage never aborts the pass', async () => {
    const dup = await runRecurrenceEscalation(
      {},
      baseDeps({ stageCandidate: vi.fn(async () => ({ staged: false as const, reason: 'duplicate-signature' as const })) }),
    );
    expect(dup.candidatesStaged).toBe(0);
    expect(dup.promotionsSuggested).toBe(1); // the capture leg is independent

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boom = await runRecurrenceEscalation(
        {},
        baseDeps({
          stageCandidate: vi.fn(async () => {
            throw new Error('pg down');
          }),
        }),
      );
      expect(boom.candidatesStaged).toBe(0);
      expect(boom.escalated).toBe(2); // best-effort: the rest of the pass completed
      expect(warn).toHaveBeenCalledWith(
        '[recurrence-escalation] candidate staging failed:',
        'pg down',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('selectRecurringSignatures — actionable-first slicing (EI-21889809467644493)', () => {
  /** N same-signature members under one distinct title; `open` of them still open. */
  const group = (key: string, size: number, open: number): ImprovementCandidate[] =>
    Array.from({ length: size }, (_, i) =>
      cand({
        id: `${key}-${i}`,
        title: `${key} friction recurring repeatedly here`,
        state: i < open ? 'open' : 'resolved',
      }),
    );

  it('a small ACTIONABLE signature outranks a huge fully-resolved one', () => {
    // The regression this guards: `count desc` alone put the 200-member exhausted
    // signature first, so with a cap of 1 the actionable trio was never hydrated.
    const all = [...group('zzz', 200, 0), ...group('aaa', 3, 1)];
    const slate = selectRecurringSignatures(all);
    expect(slate[0].count).toBe(3);
    expect(slate[0].memberIds).toContain('aaa-0');
  });

  it('does not DROP exhausted signatures — they follow the actionable ones', () => {
    const all = [...group('zzz', 200, 0), ...group('aaa', 3, 1)];
    const slate = selectRecurringSignatures(all);
    expect(slate).toHaveLength(2);
    expect(slate[1].count).toBe(200);
  });

  it('preserves count-desc ordering WITHIN the actionable group (stable partition)', () => {
    const all = [...group('small', 3, 1), ...group('big', 9, 2), ...group('mid', 5, 1)];
    expect(selectRecurringSignatures(all).map((s) => s.count)).toEqual([9, 5, 3]);
  });

  it('still applies the ≥threshold filter and the scan cap', () => {
    const all = [...group('below', 2, 2), ...group('at', 3, 1)];
    expect(selectRecurringSignatures(all).map((s) => s.count)).toEqual([3]);
    expect(
      selectRecurringSignatures(
        Array.from({ length: RECURRING_SIGNATURE_SCAN_CAP + 10 }, (_, i) => group(`s${i}`, 3, 1)).flat(),
      ),
    ).toHaveLength(RECURRING_SIGNATURE_SCAN_CAP);
  });

  it('derives the scan cap from the member budget, so it can never bind first (EI-20587312505064997)', () => {
    // RECURRING_MEMBER_HYDRATION_CAP is the real cost bound and truncates by
    // ACCUMULATED members; a second fixed cap on SIGNATURES is redundant with it and,
    // because the slate is count-desc, excludes permanently. The slate must therefore
    // be able to hold enough minimum-size groups to exhaust the member budget — if it
    // cannot, the signature cap cuts first and low-count groups are never hydrated.
    // Re-hardcoding this to a constant (it was 50) fails here.
    expect(RECURRING_SIGNATURE_SCAN_CAP * RECURRENCE_ESCALATION_THRESHOLD).toBeGreaterThanOrEqual(
      RECURRING_MEMBER_HYDRATION_CAP,
    );
  });

  it('admits the whole measured actionable population, not just the first 50 (EI-20587312505064997)', () => {
    // Measured 2026-09-06 on harness:papercusp's observation lane: 243 actionable
    // signatures (≥3 members, ≥1 open) holding 1,408 members, inside the 2,000-member
    // budget. The old fixed cap of 50 discarded 193 of them (79.4%) and raised the
    // effective threshold from the documented 3 to 7, while the budget it duplicated
    // sat 70% idle. Under that cap this returns 50.
    const MEASURED_ACTIONABLE_GROUPS = 243;
    const all = Array.from({ length: MEASURED_ACTIONABLE_GROUPS }, (_, i) =>
      group(`sig${i}`, RECURRENCE_ESCALATION_THRESHOLD, 1),
    ).flat();
    expect(selectRecurringSignatures(all)).toHaveLength(MEASURED_ACTIONABLE_GROUPS);
  });

  it('fills the cap with exhausted signatures when actionable ones do not fill it', () => {
    const actionable = Array.from({ length: 2 }, (_, i) => group(`open${i}`, 4, 1)).flat();
    const exhausted = Array.from({ length: RECURRING_SIGNATURE_SCAN_CAP }, (_, i) =>
      group(`done${i}`, 3, 0),
    ).flat();
    const slate = selectRecurringSignatures([...exhausted, ...actionable]);
    expect(slate).toHaveLength(RECURRING_SIGNATURE_SCAN_CAP);
    // the two actionable ones lead, the remainder of the cap is exhausted ones
    expect(slate.slice(0, 2).every((s) => s.count === 4)).toBe(true);
  });
});

describe('instance-evidence severity proposals (EI-23768242440859949)', () => {
  const row = (id: string, rows: number, reporters: number, severity: 'minor' | 'nit' = 'minor') => ({
    id,
    harness: 'papercusp',
    severity,
    rows,
    reporters,
    firstAt: '2026-09-28T00:00:00.000Z',
    lastAt: '2026-10-01T00:00:00.000Z',
  });

  it('ranks by distinct reporters first (one chatty reporter cannot outrank corroboration), then rows, then id', () => {
    const out = planInstanceEvidenceProposals([row('noisy', 90, 2), row('b', 4, 3), row('a', 4, 3), row('c', 6, 3)]);
    expect(out.map((p) => p.id)).toEqual(['c', 'a', 'b', 'noisy']);
  });

  it('re-applies the gate itself — a slate row below ≥3 rows or ≥2 reporters is never proposed', () => {
    const out = planInstanceEvidenceProposals([row('few-rows', 2, 2), row('one-reporter', 50, 1), row('ok', 3, 2)]);
    expect(out.map((p) => p.id)).toEqual(['ok']);
  });

  it('caps the slate and never emits a proposal that mutates severity', () => {
    const slate = Array.from({ length: 40 }, (_, i) => row(`i${String(i).padStart(2, '0')}`, 5, 3));
    const out = planInstanceEvidenceProposals(slate);
    expect(out).toHaveLength(INSTANCE_EVIDENCE_MAX_PROPOSALS);
    expect(out.every((p) => p.kind === 'propose-severity' && p.to === 'major')).toBe(true);
    expect(planInstanceEvidenceProposals(slate, { maxProposals: 0 })).toEqual([]);
  });

  it('de-duplicates a repeated id and carries the evidence window on each proposal', () => {
    const out = planInstanceEvidenceProposals([row('x', 5, 3), row('x', 5, 3)], { windowDays: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'x', from: 'minor', rows: 5, reporters: 3, windowDays: 3 });
  });

  it('the comment starts with the marker the reader keys idempotence on, and says NOT applied', () => {
    const [p] = planInstanceEvidenceProposals([row('x', 5, 3, 'nit')]);
    const body = renderSeverityProposalComment(p!);
    expect(body.startsWith(INSTANCE_EVIDENCE_MARKER)).toBe(true);
    expect(body).toContain('nit→major');
    expect(body).toContain('NOT applied');
    expect(body).toContain('5 reports from 3 distinct reporters');
  });

  // The runner only tests the post for truthiness; this is the one stand-in for a landed ThreadPostRow.
  const POSTED = { id: 'post-1' } as unknown as Awaited<ReturnType<EscalationDeps['commentIssue']>>;

  const run = async (over: Partial<EscalationDeps>) => {
    const deps: EscalationDeps = {
      readItems: vi.fn(async () => []),
      scanCorpus: vi.fn(async () => []),
      updateIssue: vi.fn(async () => null),
      commentIssue: vi.fn(async () => POSTED),
      applyTriage: vi.fn(async (input) => ({ ok: true, id: input.id })),
      capture: vi.fn(async () => ({ ok: true as const, created: true, possibleDuplicates: [] })),
      stageCandidate: vi.fn(async () => ({ staged: true as const, id: 'cand-1' })),
      readInstanceEvidence: vi.fn(async () => []),
      ...over,
    };
    return { deps, result: await runRecurrenceEscalation({}, deps) };
  };

  it('posts ONE marker comment per proposal and NEVER calls updateIssue', async () => {
    const { deps, result } = await run({ readInstanceEvidence: vi.fn(async () => [row('a', 5, 3), row('b', 4, 2)]) });
    expect(result.severityProposed).toBe(2);
    expect(deps.updateIssue).not.toHaveBeenCalled();
    const calls = vi.mocked(deps.commentIssue).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(calls.every((c) => c[1].startsWith(INSTANCE_EVIDENCE_MARKER) && c[2] === 'recurrence-escalation')).toBe(true);
  });

  it('asks the reader for the marker it excludes on, so a landed proposal never re-posts', async () => {
    const readInstanceEvidence = vi.fn<EscalationDeps['readInstanceEvidence']>(async () => []);
    await run({ readInstanceEvidence });
    expect(readInstanceEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ proposedMarker: INSTANCE_EVIDENCE_MARKER, minRows: 3, minReporters: 2, windowDays: 7 }),
    );
  });

  it('a throwing reader never aborts the pass; a throwing comment skips only that item; a null comment is not counted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingRead = await run({
      readInstanceEvidence: vi.fn(async () => {
        throw new Error('pg blip');
      }),
    });
    expect(failingRead.result.severityProposed).toBe(0);
    const commentIssue = vi
      .fn<EscalationDeps['commentIssue']>()
      .mockRejectedValueOnce(new Error('thread write failed'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(POSTED);
    const mixed = await run({
      commentIssue,
      readInstanceEvidence: vi.fn(async () => [row('a', 9, 4), row('b', 8, 4), row('c', 7, 4)]),
    });
    expect(commentIssue).toHaveBeenCalledTimes(3);
    expect(mixed.result.severityProposed).toBe(1);
    // both failures are surfaced (read failure + the one throwing comment), not swallowed silently
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
