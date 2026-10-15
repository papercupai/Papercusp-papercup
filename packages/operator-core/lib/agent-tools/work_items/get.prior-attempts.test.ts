/**
 * work_items:get — the prior-attempt brief READ seam (P-017, plan
 * first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20, lane D-015).
 *
 * The defect these guard: P-009 compiles a prior-attempt brief and P-010 hands it
 * to the four CLAIM paths — and to nothing else. `priorAttemptBrief` appeared
 * ONLY in claim.ts / claim_next.ts / plan-items/claim.ts / scheduler/get_next.ts,
 * so the only way to learn what had already been tried on an item was to CLAIM
 * it: a write, with side effects, that a reviewer or a compacted successor has no
 * business performing just to read history. The brief was computed and discarded.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/get.prior-attempts.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
  getWorkItemThreadWindow: (...a: unknown[]) => getWorkItemThreadWindow(...a),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const getWorkItemCheckpointWithMeta = vi.fn();
const getWorkItemCheckpointFreshness = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
  getWorkItemCheckpointFreshness: (...a: unknown[]) => getWorkItemCheckpointFreshness(...a),
}));

const getPresence = vi.fn();
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));

const getClaimTimePriorWorkHint = vi.fn();
vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-prior-work')>()),
  getClaimTimePriorWorkHint: (...a: unknown[]) => getClaimTimePriorWorkHint(...a),
}));

// The subject port, reached through a DYNAMIC import in the handler.
//
// Deliberately NOT `...(await importOriginal())`: the real module pulls in the
// collector's DB seams, and if loading it throws under the test runner the mock
// factory throws with it — which the handler's fail-soft `.catch(() => null)`
// then swallows into an absent field. Every assertion here would read as "the
// feature is not wired" while the failure was the fixture's. A literal factory
// keeps the fixture's own failure modes out of the subject's.
const getClaimTimePriorAttemptBrief = vi.fn();
const resolvePriorAttemptRefs = vi.fn();
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: (...a: unknown[]) => getClaimTimePriorAttemptBrief(...a),
  resolvePriorAttemptRefs: (...a: unknown[]) => resolvePriorAttemptRefs(...a),
}));

// The lifecycle read is the other `detail:true` leg; stub it so these suites
// measure the prior-attempt leg alone.
vi.mock('../../work-item-lifecycle-history', () => ({
  getWorkItemLifecycleHistory: vi.fn().mockResolvedValue(null),
}));

import get from './get';

const ctx = { uiClientId: 'su-tester', workspaceId: 'default' } as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: { results: Array<Record<string, any>> } };
const one = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data.results[0];
};

const ITEM = {
  id: 'WI-1',
  harness: 'papercusp',
  kind: 'task',
  family: 'issue',
  title: 't',
  state: 'open',
  payload: { plan_slug: 'a-plan', item_id: 'P-003' },
};

const BRIEF = {
  schemaVersion: 'prior-attempt-brief-v1' as const,
  fingerprint: 'fp-1',
  authority: [],
  residue: [],
  attempts: [{ authority: 'attempt', scope: 'same-plan-item', rawRef: 'WI-2#checkpoint', text: 'tried X; X was wrong' }],
  rawRefs: ['WI-2#checkpoint'],
  protectedRefs: { authority: [], residue: [] },
  omission: {
    omittedRecords: 2,
    omittedByAuthority: { attempt: 2 },
    omittedRefs: [{ authority: 'attempt', scope: 'plan-wide', rawRef: 'WI-3#checkpoint' }],
    omittedRefsTruncated: false,
    sourceCount: 3,
    deduplicatedCount: 3,
    truncated: true,
  },
  estimatedTokens: 40,
  serializedChars: 160,
};

beforeEach(() => {
  getWorkItem.mockReset().mockResolvedValue(ITEM);
  getWorkItemDetail.mockReset().mockResolvedValue(ITEM);
  getWorkItemThreadWindow.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  getWorkItemCheckpointFreshness.mockReset().mockResolvedValue(undefined);
  getPresence.mockReset().mockResolvedValue(null);
  getClaimTimePriorWorkHint.mockReset().mockResolvedValue(null);
  getClaimTimePriorAttemptBrief.mockReset().mockResolvedValue(BRIEF);
  resolvePriorAttemptRefs.mockReset().mockResolvedValue(null);
});

describe('work_items:get — priorAttempts (the read that used to require a claim)', () => {
  it('folds the brief into detail:true, so history is readable WITHOUT claiming the item', async () => {
    const r = await one({ id: 'WI-1', detail: true });
    expect(r.priorAttempts).toMatchObject({ fingerprint: 'fp-1' });
    // The whole point of the field: the caller learns "tried X, X was wrong"
    // from a READ. Before this, only work_items:claim carried that sentence.
    expect(r.priorAttempts.attempts[0].text).toBe('tried X; X was wrong');
  });

  it('names WHICH history was omitted, not just how much — the omission stays auditable', async () => {
    const r = await one({ id: 'WI-1', detail: true });
    expect(r.priorAttempts.omission.omittedRecords).toBe(2);
    // A count alone tells the reader that history was dropped but not what to
    // ask for next; the refs are what make the bounded brief a starting point
    // rather than a dead end.
    expect(r.priorAttempts.omission.omittedRefs[0].rawRef).toBe('WI-3#checkpoint');
  });

  it('is ABSENT on a plain read — the hot path pays nothing', async () => {
    const r = await one({ id: 'WI-1' });
    expect(r.priorAttempts).toBeUndefined();
    expect(getClaimTimePriorAttemptBrief).not.toHaveBeenCalled();
  });

  it('passes the resolved work-item — the brief must key on the ITEM’s harness, not the request arg', async () => {
    await one({ id: 'WI-1', detail: true, harness: 'some-other-harness' });
    expect(getClaimTimePriorAttemptBrief).toHaveBeenCalledWith(
      expect.objectContaining({ workItem: ITEM, harness: 'papercusp' }),
    );
  });

  it('degrades to an absent field (never a failed read) when the compiler throws', async () => {
    getClaimTimePriorAttemptBrief.mockRejectedValue(new Error('collector timeout'));
    const r = await one({ id: 'WI-1', detail: true });
    expect(r.ok).toBe(true);
    expect(r.priorAttempts).toBeUndefined();
  });

  it('omits the field for an item with no plan pointer instead of asserting an empty history', async () => {
    // The compiler returns null for "no plan lane to compile" and for "the read
    // failed" alike, which is why absence must never be read as "nothing was
    // tried" — pinned here so a later change cannot start emitting an empty
    // brief that WOULD say exactly that.
    getClaimTimePriorAttemptBrief.mockResolvedValue(null);
    const r = await one({ id: 'WI-1', detail: true });
    expect(r.priorAttempts).toBeUndefined();
  });
});

describe('work_items:get — priorAttemptRefs (raw drill-down)', () => {
  it('requires a target id or ids because refs resolve against requested work-item records', () => {
    expect(() => parse({ priorAttemptRefs: ['WI-3#checkpoint'] })).toThrow(/pass `id` \(one\) or `ids` \(many\)/);
    expect(() => parse({ id: 'WI-1', priorAttemptRefs: ['WI-3#checkpoint'] })).not.toThrow();
    expect(() => parse({ ids: ['WI-1'], priorAttemptRefs: ['WI-3#checkpoint'] })).not.toThrow();
  });

  it('resolves named refs back to full records, INCLUDING ones the brief only counted', async () => {
    resolvePriorAttemptRefs.mockResolvedValue({
      schemaVersion: 'prior-attempt-refs-v1',
      records: [{ authority: 'attempt', scope: 'plan-wide', rawRef: 'WI-3#checkpoint', text: 'the full untruncated body' }],
      unresolved: [],
      fingerprint: 'fp-1',
    });
    const r = await one({ id: 'WI-1', priorAttemptRefs: ['WI-3#checkpoint'] });
    expect(resolvePriorAttemptRefs).toHaveBeenCalledWith(
      expect.objectContaining({ rawRefs: ['WI-3#checkpoint'], harness: 'papercusp' }),
    );
    expect(r.priorAttemptRefResolution.records[0].text).toBe('the full untruncated body');
  });

  it('uses raw refs instead of duplicating the bounded brief when detail is also requested', async () => {
    resolvePriorAttemptRefs.mockResolvedValue({
      schemaVersion: 'prior-attempt-refs-v1',
      records: [{ authority: 'attempt', scope: 'plan-wide', rawRef: 'WI-3#checkpoint', text: 'the full untruncated body' }],
      unresolved: [],
      fingerprint: 'fp-1',
    });

    const r = await one({ id: 'WI-1', detail: true, priorAttemptRefs: ['WI-3#checkpoint'] });

    expect(getClaimTimePriorAttemptBrief).not.toHaveBeenCalled();
    expect(r.priorAttempts).toBeUndefined();
    expect(r.priorAttemptRefResolution.records[0].text).toBe('the full untruncated body');
  });

  it('works WITHOUT detail:true — a ref read from a claim reply must not cost the full render', async () => {
    resolvePriorAttemptRefs.mockResolvedValue({
      schemaVersion: 'prior-attempt-refs-v1',
      records: [],
      unresolved: ['WI-9#gone'],
      fingerprint: 'fp-1',
    });
    const r = await one({ id: 'WI-1', priorAttemptRefs: ['WI-9#gone'] });
    expect(getWorkItemDetail).not.toHaveBeenCalled();
    // An unresolved ref is a real answer about the history (the source moved on),
    // not an error — it must survive to the caller rather than reading as an
    // empty result.
    expect(r.priorAttemptRefResolution.unresolved).toEqual(['WI-9#gone']);
  });

  it('does not call the resolver at all when no refs were asked for', async () => {
    await one({ id: 'WI-1', detail: true });
    expect(resolvePriorAttemptRefs).not.toHaveBeenCalled();
  });

  it('degrades to an absent field when the resolver throws', async () => {
    resolvePriorAttemptRefs.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-1', priorAttemptRefs: ['WI-3#checkpoint'] });
    expect(r.ok).toBe(true);
    expect(r.priorAttemptRefResolution).toBeUndefined();
  });
});
