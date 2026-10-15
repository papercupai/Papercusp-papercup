/**
 * _create-core.goal-dedup-gate.test — the P-004 GOAL rail on createOneWorkItem
 * (goal-mode-design-intent-hardening-2026-08-16): with `goalDedupGate` set (derived
 * SERVER-SIDE by the tool handler from the creator's resolved goal context — never a
 * tool argument; the wrapper derivation + strict-schema rejection are pinned in
 * create.goal-dedup-gate.test.ts), a create whose SEMANTIC dedup leg is down fails
 * CLOSED with 'dedup_unavailable' instead of failing open with a degraded marker
 * stamped where nobody looks — the exact WI-39373 relapse shape. force:true remains
 * the explicit escape (unlike DRAIN's requireCompleteDedupCoverage, which overrides
 * force), but the probes still RUN under force so the caller always gets the
 * coverage verdict + candidates. Feature-family creates are gated too: their
 * full-text lexical leg is legitimately 'skipped' (engineer_issues has no feature
 * rows) and must NOT count as degraded — only the semantic leg carries that verdict.
 * The guards themselves are mocked — their internals are covered by
 * semantic-dupe-guard.test.ts / fulltext-lexical-dupe-guard tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P-002 item d: candidates leave a SUCCESSFUL create through this writer, not
 *  through `similarOpen`. Mocked so the gate's own contract stays the subject. */
const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
const coverageAlarm = vi.hoisted(() => ({ report: vi.fn(async (_detail: unknown) => {}) }));
vi.mock('./semantic-dedup-probe-alarm', () => ({ reportSemanticDedupProbeUnavailable: coverageAlarm.report }));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));

const occurrenceMocks = vi.hoisted(() => ({
  record: vi.fn(async () => null),
  readPressure: vi.fn(async (): Promise<
    import('../../issue-occurrence-ledger').IssueAdmissionPressure | null
  > => null),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../work-items', () => ({
  createWorkItem: vi.fn(async (input: { kind: string; title: string }) => ({
    id: 'WI-NEW',
    kind: input.kind,
    title: input.title,
  })),
  getWorkItem: vi.fn(async () => null),
  linkWorkItem: vi.fn(async () => {}),
  isWorkItemKind: (k: string) => ['feature', 'chunk', 'bug', 'change', 'task'].includes(k),
  isDeprecatedWorkItemKind: (k: string) => k === 'chunk',
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_pot-scope', () => ({
  resolvePotScope: vi.fn(async () => ({ kind: 'pot', slug: 'papercusp' })),
  POT_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../datatype-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datatype-registry-store')>()),
  getGenericKindDatatype: vi.fn(async () => null),
  getDatatype: vi.fn(async () => null),
}));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));
vi.mock('../../coord/condition-upsert', () => ({
  adoptConditionIncumbent: vi.fn(async () => null),
  settleConditionClaim: vi.fn(async () => ({ won: true })),
  CONDITION_UPSERT_MARKER: '_conditionUpsert',
}));
vi.mock('../../issue-occurrence-ledger', async () => {
  const actual = await vi.importActual<typeof import('../../issue-occurrence-ledger')>(
    '../../issue-occurrence-ledger',
  );
  return {
    ...actual,
    recordIssueOccurrence: occurrenceMocks.record,
    readIssueAdmissionPressure: occurrenceMocks.readPressure,
  };
});

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes, type SemanticDupeResult } from './semantic-dupe-guard';
import { findRecentLexicalDupes } from './recent-lexical-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import { createWorkItem } from '../../work-items';

const guardM = vi.mocked(findSemanticDupes);
const recentM = vi.mocked(findRecentLexicalDupes);
const fulltextM = vi.mocked(findFulltextLexicalDupes);
const createM = vi.mocked(createWorkItem);
// EI-21872682653374832 — createOneWorkItem stamps goal provenance (_create-core.ts:1198).
// Unmocked, resolveGoalContext reaches the real authority read, which fails CLOSED with
// `goal_holder_authority_unreadable` for ownerId 'me' (goal-context.ts:54). The stamp's catch
// console.warns by design (EI-20075667133396690) and vitest-fail-on-console turns that warn
// into a failure on every test whose create actually REACHES the stamp — which is why the
// refusal cases here passed and the create-succeeds cases did not.
//
// Returning null is safe for THIS file specifically, and the reason matters: the dedup gate
// under test is driven by the getFlag mock above, NOT by goal context. So neutralising the
// goal makes no test take a different gate branch — it only stops the stamp from throwing.
// If a future test here needs a real goal, give it the configurable mock that
// create.goal-dedup-gate.test.ts uses rather than widening this one.
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
}));

const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const verdict = (hard: number[], soft: number[]): SemanticDupeResult => ({
  hard: hard.map((s, i) => ({ id: `EI-${i + 1}`, title: `open dupe ${i + 1}`, state: 'open', harness: 'papercusp', similarity: s })),
  soft: soft.map((s, i) => ({ id: `WI-${i + 10}`, title: `near ${i}`, state: 'todo', harness: 'papercusp', similarity: s })),
  thresholds: { hard: 0.93, soft: 0.85 },
});

beforeEach(() => {
  coverageAlarm.report.mockClear();
  guardM.mockReset();
  guardM.mockResolvedValue(null);
  recentM.mockReset();
  recentM.mockResolvedValue(null);
  fulltextM.mockReset();
  fulltextM.mockResolvedValue([]);
  createM.mockClear();
  dedupEdgeMocks.persist.mockClear();
  occurrenceMocks.record.mockClear();
  occurrenceMocks.readPressure.mockReset();
  occurrenceMocks.readPressure.mockResolvedValue(null);
});

describe('createOneWorkItem × goal dedup gate (P-004)', () => {
  it('preserves the condition when semantic hits exist but the recent index census has no verdict', async () => {
    guardM.mockResolvedValue(verdict([], []));
    recentM.mockResolvedValue(null);
    const result = await createOneWorkItem({ kind: 'bug', title: 'measured query, unreadable census' }, ctx);
    expect(result.ok).toBe(true);
    expect(coverageAlarm.report).toHaveBeenCalledWith({ harnessSlug: 'papercusp',
      coverage: { lexical: 'ok', semantic: 'unknown', degraded: false } });
  });
  it('gate + semantic leg down + no force → fails CLOSED with dedup_unavailable (the WI-39373 shape)', async () => {
    // findSemanticDupes → null = the guard could not run (fail-open elsewhere).
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'a goal-mode filing', goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('dedup_unavailable');
    expect(r.message).toContain('goal-mode');
    expect(r.message).toContain('force:true');
    // EI-23799808825983763: the refusal names its OWN next action — a bare hard refusal
    // at the end of a unit of work reads as "filing is unavailable" and the finding dies
    // with the session. Retry (transient) first, then the explicit audited escape.
    expect(r.message).toMatch(/not lost/i);
    expect(r.message).toMatch(/retry the\s+identical call/i);
    expect(r.disposition).toEqual({
      retryable: true,
      retryAfterSec: 10,
      ifPersistent: { retryWith: { force: true }, effect: expect.stringContaining('degraded coverage') },
      structuralSignal: 'semantic-dedup-probe-alarm',
    });
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).not.toHaveBeenCalled();
  });

  it('partial recent coverage fails the goal gate but ordinary and forced creates still stamp it', async () => {
    guardM.mockResolvedValue(verdict([], []));
    recentM.mockResolvedValue({
      candidates: [],
      coverage: { scanned: 1, unembedded: 1, truncated: false, complete: false },
    });

    const refused = await createOneWorkItem(
      { kind: 'bug', title: 'fresh row without an embedding', goalDedupGate: true },
      ctx,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: 'dedup_unavailable',
      dedupCoverage: { lexical: 'ok', semantic: 'partial', degraded: true },
    });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('semantic coverage is partial');
    expect(coverageAlarm.report).toHaveBeenCalledWith({ harnessSlug: 'papercusp',
      coverage: { lexical: 'ok', semantic: 'partial', degraded: true } });
    expect(createM).not.toHaveBeenCalled();

    const ordinary = await createOneWorkItem(
      { kind: 'bug', title: 'fresh row without an embedding' },
      ctx,
    );
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) throw new Error('unreachable');
    expect(ordinary.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'partial', degraded: true });

    const forced = await createOneWorkItem(
      { kind: 'bug', title: 'fresh row without an embedding', force: true, goalDedupGate: true },
      ctx,
    );
    expect(forced.ok).toBe(true);
    if (!forced.ok) throw new Error('unreachable');
    expect(forced.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'partial', degraded: true });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCoverage: { lexical: 'ok', semantic: 'partial', degraded: true },
        }),
      }),
    );
  });

  it('EI-23799808825983763: the retry disposition is ABSENT on a forced filing (nothing was refused)', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'must land now (disposition)', force: true, goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect((r as { disposition?: unknown }).disposition).toBeUndefined();
  });

  it('urgent condition-key filing + semantic leg down → creates with degraded coverage (the EI-21827949941920236 escape)', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'urgent condition filing',
        urgent: true,
        conditionKey: 'detector:urgent-condition',
        goalDedupGate: true,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        urgent: true,
        payload: expect.objectContaining({
          dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
        }),
      }),
    );
  });

  it('condition key without urgency remains fail-closed when the goal semantic leg is down', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'non-urgent condition filing', conditionKey: 'detector:non-urgent', goalDedupGate: true },
      ctx,
    );
    expect(r).toMatchObject({
      ok: false,
      error: 'dedup_unavailable',
      dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
    });
    expect(createM).not.toHaveBeenCalled();
  });

  it('no gate (flag off / non-goal creator) + semantic leg down → proceeds fail-open, unchanged', async () => {
    // The wrapper only ever sets goalDedupGate under flag ∧ resolved-goal, so BOTH
    // "flag off" and "creator not under a goal" reach the core as an unset rail.
    const r = await createOneWorkItem({ kind: 'bug', title: 'an ordinary filing' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // The degradation is still RECORDED (issue-family coverage always was) — it
    // just does not refuse: that is exactly the pre-P-004 behavior.
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).toHaveBeenCalledOnce();
  });

  it('task (non-code) with the wrapper exemption + semantic leg down → proceeds with ordinary issue coverage', async () => {
    // The wrapper deliberately passes goalDedupGate:false for `task`: plan-audit and
    // other non-code filings must remain recordable when the semantic probe is down.
    // As an issue-family kind, task still reports the ordinary degraded coverage marker;
    // it must not be converted into the GOAL fail-closed refusal.
    const r = await createOneWorkItem(
      { kind: 'task', title: 'record the activation audit', goalDedupGate: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).toHaveBeenCalledOnce();
  });

  it('gate + force + semantic leg down → proceeds, with the degraded coverage recorded on result AND row', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'must land now', force: true, goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // Unlike plain force (which skips the prescreen entirely), the gate keeps the
    // probes RUNNING under force — the pass is informed, not blind.
    expect(guardM).toHaveBeenCalled();
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
        }),
      }),
    );
  });

  it('gate + force + healthy probe with soft siblings → proceeds, PERSISTING the candidates, coverage in the result', async () => {
    guardM.mockResolvedValue(verdict([], [0.88, 0.86]));
    recentM.mockResolvedValue({ candidates: [],
      coverage: { scanned: 0, unembedded: 0, truncated: false, complete: true } });
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'genuinely distinct', force: true, goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(coverageAlarm.report).toHaveBeenCalledWith({ harnessSlug: 'papercusp',
      coverage: { lexical: 'ok', semantic: 'ok', degraded: false } });
    // P-002 item d: the informed pass is still informed — but the candidates go to
    // the promoter's substrate, not back to the forcing caller.
    expect(dedupEdgeMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ id: 'WI-10' }), expect.objectContaining({ id: 'WI-11' })],
      }),
    );
    expect(r.dedupEdges).toBe(2);
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });

  it('P-002: gate + healthy probe + hard match + no force → FILES with the semantic-hard stamp (match veto retired)', async () => {
    guardM.mockResolvedValue(verdict([0.96], []));
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'a reworded duplicate', goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCandidates: expect.arrayContaining([
            expect.objectContaining({ id: 'EI-1', method: 'semantic-hard' }),
          ]),
        }),
      }),
    );
  });

  it('FEATURE-family gate + semantic leg down → fails CLOSED too (lexical skipped, not counted degraded)', async () => {
    const r = await createOneWorkItem(
      { kind: 'feature', title: 'a goal-mode feature', harness: 'papercusp', goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('dedup_unavailable');
    expect(r.dedupCoverage).toEqual({ lexical: 'skipped', semantic: 'unavailable', degraded: true });
    // admissionIdentity keys the ISSUE occurrence ledger — feature-family must not carry it.
    expect('admissionIdentity' in r).toBe(false);
    expect(createM).not.toHaveBeenCalled();
    // The full-text lexical leg queries engineer_issues only — never consulted here.
    expect(fulltextM).not.toHaveBeenCalled();
  });

  it('FEATURE-family gate + healthy semantic leg → creates, coverage NOT degraded despite lexical=skipped', async () => {
    guardM.mockResolvedValue(verdict([], []));
    const r = await createOneWorkItem(
      { kind: 'feature', title: 'a goal-mode feature', harness: 'papercusp', goalDedupGate: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dedupCoverage).toEqual({ lexical: 'skipped', semantic: 'ok', degraded: false });
    const persisted = createM.mock.calls[0][0] as { payload?: Record<string, unknown> };
    expect(persisted.payload?.dedupCoverage).toEqual({ lexical: 'skipped', semantic: 'ok', degraded: false });
    expect(persisted.payload?.admissionIdentity).toBeUndefined();
  });

  it('FEATURE-family without the gate → no coverage computed at all (unchanged)', async () => {
    guardM.mockResolvedValue(verdict([], []));
    const r = await createOneWorkItem(
      { kind: 'feature', title: 'an ordinary feature', harness: 'papercusp' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('dedupCoverage' in r).toBe(false);
  });

  it('P-002: DRAIN + gate both degraded + force → FILES with the degradation stamped (DRAIN veto retired; goal gate honors force)', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'drain filing',
        force: true,
        goalDedupGate: true,
        requireCompleteDedupCoverage: true,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dedupCoverage?.degraded).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCoverage: expect.objectContaining({ degraded: true }),
        }),
      }),
    );
  });
});
