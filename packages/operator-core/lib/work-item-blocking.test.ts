import { describe, expect, it, vi } from 'vitest';
import type { LinkRow } from '@papercusp/coordination/capabilities';
import { ISSUE_STATES } from './issues-engineer';
import {
  ALL_TERMINAL_STATUSES,
  createBlockingEdgeReader,
  ISSUE_ABANDONED_STATUSES,
  ISSUE_SHIPPED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  isReady,
  partitionReady,
  planDependencyBlockedClear,
  readSettleEdges,
  toReadinessNodes,
  type BlockingNode,
  type BlockingEdgeReader,
} from './work-item-blocking';

const DISPATCHABLE = new Set(['todo']);

describe('cleared dependency status reconciliation', () => {
  const clear = { hasLiveDependency: false, hasActiveExternalBlocker: false };
  const row = (payload: Record<string, unknown> = {}) => ({
    state: 'blocked', takenBy: null, updatedTs: 100, payload, origin: 'local',
  });

  it('clears only the generated blocked lease and preserves review/readiness evidence', () => {
    const held = row({ _claimHold: true, held_open_by: 'su-1', held_open_at: 'then', held_open_reason: 'blocked',
      agentReview: { status: 'pending' }, implementationReadiness: { status: 'unknown' } });
    expect(planDependencyBlockedClear(held, held, clear)).toEqual({ outcome: 'cleared', nextPayload: {
      agentReview: { status: 'pending' }, implementationReadiness: { status: 'unknown' },
    } });
  });

  it('preserves a durable park coexisting with the generated lease', () => {
    const held = row({ _claimHold: true, held_open_by: 'su-1', held_open_reason: 'blocked',
      claim_hold_by: 'su-parker', claim_hold_reason: 'credential', claim_hold_release: { condition: 'key supplied' } });
    expect(planDependencyBlockedClear(held, held, clear).nextPayload).toEqual({
      _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'credential',
      claim_hold_release: { condition: 'key supplied' },
    });
  });

  it.each([
    { payload: { _claimHold: true, claim_hold_by: 'su-parker' }, outcome: 'reserved' },
    { payload: { _claimHold: true, held_open_reason: 'deliberate hold' }, outcome: 'reserved' },
    { payload: { needsOwnerAction: true }, outcome: 'reserved' },
    { payload: { externalBlockers: [{ kind: 'human', ref: 'key', status: 'active', capability: 'credential' }] }, outcome: 'external-blocker' },
  ])('retains independent hold $outcome', ({ payload, outcome }) => {
    const held = row(payload);
    expect(planDependencyBlockedClear(held, held, { ...clear, hasActiveExternalBlocker: outcome === 'external-blocker' }).outcome).toBe(outcome);
  });

  // WI-10007634: `origin` records how a row ARRIVED, not who wrote it (WI-10003565).
  it('reserves a true peer row but clears our own row stranded at origin=remote', () => {
    const remote = { ...row({ _claimHold: true, held_open_reason: 'blocked' }), origin: 'remote' };
    expect(planDependencyBlockedClear(remote, remote, clear).outcome).toBe('reserved');
    expect(planDependencyBlockedClear(remote, remote, { ...clear, ownNodeAuthored: false }).outcome).toBe('reserved');
    expect(planDependencyBlockedClear(remote, remote, { ...clear, ownNodeAuthored: true }).outcome).toBe('cleared');
  });

  it('retains live dependencies and refuses assignment, payload or time drift', () => {
    const held = row();
    expect(planDependencyBlockedClear(held, held, { ...clear, hasLiveDependency: true }).outcome).toBe('live-dependency');
    for (const changed of [{ ...held, takenBy: 'new-peer' }, { ...held, updatedTs: 101 },
      { ...held, payload: { needsOwnerAction: true } }]) {
      expect(planDependencyBlockedClear(held, changed, clear).outcome).toBe('stale-control');
    }
  });
});

// One scenario exercising every satisfaction case. Blockers themselves are present (so their
// status is known) but not 'todo', so they aren't candidates — only the F* items are.
const ITEMS: BlockingNode[] = [
  { id: 'F1', status: 'todo' }, // blocked by a PASSED feature -> ready
  { id: 'F-PASS', status: 'passed' },
  { id: 'F2', status: 'todo' }, // blocked by a FAILING feature -> blocked
  { id: 'F-FAIL', status: 'failing' },
  { id: 'F3', status: 'todo' }, // blocked by a RESOLVED issue (F2 cross-family) -> ready
  { id: 'I-RES', status: 'resolved' },
  { id: 'F4', status: 'todo' }, // blocked by an OPEN issue -> blocked
  { id: 'I-OPEN', status: 'open' },
  { id: 'F5', status: 'todo' }, // blocked by an ABSENT id -> satisfied (ready)
  { id: 'F6', status: 'todo' }, // blocked by a CLOSED issue -> ready
  { id: 'I-CLOSED', status: 'closed' },
];
const BLOCKERS = new Map<string, string[]>([
  ['F1', ['F-PASS']],
  ['F2', ['F-FAIL']],
  ['F3', ['I-RES']],
  ['F4', ['I-OPEN']],
  ['F5', ['ABSENT-X']],
  ['F6', ['I-CLOSED']],
]);

describe('cross-family terminal sets (F2)', () => {
  it('treats both feature and issue terminal statuses as satisfied', () => {
    expect(ISSUE_TERMINAL_STATUSES.has('resolved')).toBe(true);
    expect(ISSUE_TERMINAL_STATUSES.has('closed')).toBe(true);
    for (const s of ['passed', 'deprecated', 'resolved', 'closed']) {
      expect(ALL_TERMINAL_STATUSES.has(s)).toBe(true);
    }
    expect(ALL_TERMINAL_STATUSES.has('open')).toBe(false);
    expect(ALL_TERMINAL_STATUSES.has('failing')).toBe(false);
  });
});

describe('partitionReady', () => {
  it('partitions ready/blocked using cross-family terminal + absent-is-satisfied', () => {
    const { ready, blocked } = partitionReady(ITEMS, BLOCKERS, DISPATCHABLE);
    expect(new Set(ready.map((n) => n.id))).toEqual(new Set(['F1', 'F3', 'F5', 'F6']));
    expect(new Set(blocked.map((n) => n.id))).toEqual(new Set(['F2', 'F4']));
  });

  it('an issue blocker satisfies a feature when resolved/closed but blocks when open (F2)', () => {
    expect(isReady('F3', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true); // I-RES resolved
    expect(isReady('F6', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true); // I-CLOSED closed
    expect(isReady('F4', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(false); // I-OPEN open
  });

  it('a non-terminal feature blocker keeps its dependent blocked', () => {
    expect(isReady('F1', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true);
    expect(isReady('F2', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(false);
  });

  it('an absent blocker never deadlocks (satisfied)', () => {
    expect(isReady('F5', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true);
  });

  it('an owned item is excluded from ready', () => {
    expect(isReady('F1', ITEMS, BLOCKERS, DISPATCHABLE, new Set(['F1']))).toBe(false);
  });

  it('all blockers terminal -> ready; any one non-terminal -> blocked', () => {
    const items: BlockingNode[] = [
      { id: 'X', status: 'todo' },
      { id: 'A', status: 'passed' },
      { id: 'B', status: 'resolved' },
      { id: 'C', status: 'failing' },
    ];
    expect(isReady('X', items, new Map([['X', ['A', 'B']]]), DISPATCHABLE)).toBe(true);
    expect(isReady('X', items, new Map([['X', ['A', 'C']]]), DISPATCHABLE)).toBe(false);
  });
});

describe('P-003 independent preparation', () => {
  it.each(['credential', 'owner pause', 'destructive permission'])('keeps preparation ready while %s blocks dependent execution', (prerequisite) => {
    const nodes: BlockingNode[] = [
      { id: prerequisite, status: 'needs-human' },
      { id: 'execution', status: 'todo' },
      { id: 'preparation', status: 'todo' },
    ];
    const before = structuredClone(nodes);
    const dependencies = new Map([['execution', [prerequisite]]]);
    const result = partitionReady(nodes, dependencies, DISPATCHABLE);
    expect(result.ready.map((node) => node.id)).toEqual(['preparation']);
    expect(result.blocked.map((node) => node.id)).toEqual(['execution']);
    expect(isReady('execution', nodes, dependencies, DISPATCHABLE)).toBe(false);
    expect(isReady('preparation', nodes, dependencies, DISPATCHABLE, new Set(['preparation']))).toBe(false);
    expect(nodes).toEqual(before);
  });
});

describe('toReadinessNodes', () => {
  it('maps items to nodes with their blocker lists (empty when none)', () => {
    const nodes = toReadinessNodes([{ id: 'A', status: 'todo' }], new Map([['A', ['B']]]));
    expect(nodes).toEqual([{ id: 'A', status: 'todo', blockedBy: ['B'] }]);
    const none = toReadinessNodes([{ id: 'Z', status: 'todo' }], new Map());
    expect(none[0]!.blockedBy).toEqual([]);
  });

  it('preserves external blockers when present', () => {
    const items = [{ id: 'A', status: 'todo', externalBlockers: ['event:deploy:ready'] }];
    const nodes = toReadinessNodes(items, new Map());
    expect(nodes).toEqual([{ id: 'A', status: 'todo', blockedBy: [], externalBlockers: ['event:deploy:ready'] }]);
  });
});

const linkRow = (
  id: number,
  src: LinkRow['src'],
  rel: string,
  dst: LinkRow['dst'],
  createdTs: string,
): LinkRow => ({ id, src, rel, dst, created_by: 'test', created_ts: createdTs });

const fakeEdgeStore = (rows: LinkRow[]): BlockingEdgeReader => ({
  listOut: vi.fn(async () => rows),
  listIn: vi.fn(async () => rows),
  listOutMany: vi.fn(async () => rows),
  listInMany: vi.fn(async () => rows),
});

describe('readSettleEdges (WI-10003631 settle-edge prefetch)', () => {
  const issue = { kind: 'issue', ref: 'WI-1' };
  const feature = { kind: 'feature', ref: 'demo#F-2' };
  const planItem = { kind: 'plan_item', ref: 'demo-plan#P-001' };
  const other = { kind: 'issue', ref: 'WI-9' };

  it('returns exactly the three row sets the per-relation reader returns, in one coord statement', async () => {
    // coord_links rows by relation, as the store would filter them for `ref`.
    const out = [
      linkRow(1, issue, 'blocks', feature, '2026-01-01T00:00:00.000Z'), // stale work-item block
      linkRow(2, issue, 'blocks', planItem, '2026-01-02T00:00:00.000Z'), // non-work block survives
      linkRow(3, issue, 'fixes', other, '2026-01-03T00:00:00.000Z'),
    ];
    const inn = [linkRow(5, other, 'duplicates', issue, '2026-01-05T00:00:00.000Z')];
    const canonical = [linkRow(4, issue, 'blocks', feature, '2026-01-04T00:00:00.000Z')];
    const byRel = (rows: LinkRow[], rel?: string) => rows.filter((r) => rel == null || r.rel === rel);
    const coordStore: BlockingEdgeReader = {
      listOut: vi.fn(async (_s, o) => byRel(out, o?.rel)),
      listIn: vi.fn(async (_d, o) => byRel(inn, o?.rel)),
      listOutMany: vi.fn(async () => []),
      listInMany: vi.fn(async () => []),
    };
    const depStore: BlockingEdgeReader = {
      listOut: vi.fn(async (_s, o) => byRel(canonical, o?.rel)),
      listIn: vi.fn(async () => []),
      listOutMany: vi.fn(async () => []),
      listInMany: vi.fn(async () => []),
    };
    const listAround = vi.fn(async () => ({ out, in: inn }));

    const got = await readSettleEdges(issue, { listAround }, depStore);
    const reference = createBlockingEdgeReader(coordStore, depStore);

    expect(listAround).toHaveBeenCalledTimes(1);
    expect(listAround).toHaveBeenCalledWith(issue, { outRels: ['blocks', 'fixes'], inRels: ['duplicates'] });
    expect(got.blocksOut).toEqual(await reference.listOut(issue, { rel: 'blocks' }));
    expect(got.fixesOut).toEqual(await reference.listOut(issue, { rel: 'fixes' }));
    expect(got.duplicatesIn).toEqual(await reference.listIn(issue, { rel: 'duplicates' }));
    // The stale coord work-item block is replaced by the canonical one.
    expect(got.blocksOut.map((r) => r.id)).toEqual([2, 4]);
  });
});

describe('createBlockingEdgeReader canonical cutover (WI-41166)', () => {
  const issue = { kind: 'issue', ref: 'WI-1' };
  const feature = { kind: 'feature', ref: 'demo#F-2' };
  const planItem = { kind: 'plan_item', ref: 'demo-plan#P-001' };

  it('takes work-item blocks only from work_item_deps while retaining polymorphic coord links', async () => {
    const staleCoordBlock = linkRow(1, issue, 'blocks', feature, '2026-01-01T00:00:00.000Z');
    const planBlock = linkRow(2, issue, 'blocks', planItem, '2026-01-02T00:00:00.000Z');
    const relates = linkRow(3, issue, 'relates', feature, '2026-01-03T00:00:00.000Z');
    const canonicalBlock = linkRow(4, issue, 'blocks', feature, '2026-01-04T00:00:00.000Z');
    const reader = createBlockingEdgeReader(
      fakeEdgeStore([staleCoordBlock, planBlock, relates]),
      fakeEdgeStore([canonicalBlock]),
    );

    expect(await reader.listOut(issue)).toEqual([planBlock, relates, canonicalBlock]);
  });

  it('never resurrects a stale coord work-item block after its canonical edge is removed', async () => {
    const staleCoordBlock = linkRow(1, issue, 'blocks', feature, '2026-01-01T00:00:00.000Z');
    const reader = createBlockingEdgeReader(fakeEdgeStore([staleCoordBlock]), fakeEdgeStore([]));

    expect(await reader.listOut(issue, { rel: 'blocks' })).toEqual([]);
    expect(await reader.listIn(feature, { rel: 'blocks' })).toEqual([]);
  });

  it('does not query work_item_deps for a non-block relation', async () => {
    const relates = linkRow(3, issue, 'relates', feature, '2026-01-03T00:00:00.000Z');
    const coord = fakeEdgeStore([relates]);
    const deps = fakeEdgeStore([]);
    const reader = createBlockingEdgeReader(coord, deps);

    expect(await reader.listOut(issue, { rel: 'relates' })).toEqual([relates]);
    expect(deps.listOut).not.toHaveBeenCalled();
  });

  it('uses the batched canonical methods for both edge directions', async () => {
    const canonicalBlock = linkRow(4, issue, 'blocks', feature, '2026-01-04T00:00:00.000Z');
    const coord = fakeEdgeStore([]);
    const deps = fakeEdgeStore([canonicalBlock]);
    const reader = createBlockingEdgeReader(coord, deps);

    expect(await reader.listOutMany([issue], { rel: 'blocks' })).toEqual([canonicalBlock]);
    expect(await reader.listInMany([feature], { rel: 'blocks' })).toEqual([canonicalBlock]);
    expect(deps.listOutMany).toHaveBeenCalledWith([issue], { rel: 'blocks' });
    expect(deps.listInMany).toHaveBeenCalledWith([feature], { rel: 'blocks' });
  });
});

/**
 * Recurrence guard for EI-18792873324746237.
 *
 * The bug: the Learning tab's idea→work funnel filtered `state IN
 * ('resolved','closed')` — the PRE-unify spellings. After the writer-flip every
 * live row stores `done`/`dropped`, so the filter matched nothing and the tab
 * reported "0 shipped" against 137 genuinely shipped ideas. Nothing failed;
 * a wrong-but-well-formed enum member is invisible to tsc and to any test that
 * only asserts on fixtures it wrote itself.
 *
 * These assertions are anchored to ISSUE_STATES — the enum itself — so adding a
 * state to the union without classifying it FAILS HERE, at the definition,
 * rather than silently zeroing a number in a panel nobody is currently reading.
 */
describe('issue terminal-state partition (EI-18792873324746237)', () => {
  it('shipped and abandoned are disjoint — a dropped item is never counted as delivered', () => {
    const overlap = [...ISSUE_SHIPPED_STATUSES].filter((s) => ISSUE_ABANDONED_STATUSES.has(s));
    expect(overlap).toEqual([]);
  });

  it('shipped ∪ abandoned exactly covers the terminal set', () => {
    const union = new Set([...ISSUE_SHIPPED_STATUSES, ...ISSUE_ABANDONED_STATUSES]);
    expect([...union].sort()).toEqual([...ISSUE_TERMINAL_STATUSES].sort());
  });

  it('every terminal member of the live IssueState enum is classified', () => {
    // The enum is the source of truth. A new terminal state added to
    // ISSUE_STATES and to ISSUE_TERMINAL_STATUSES, but NOT to one of the two
    // outcome sets, lands here as an unclassified member.
    const unclassified = ISSUE_STATES.filter(
      (s) =>
        ISSUE_TERMINAL_STATUSES.has(s) &&
        !ISSUE_SHIPPED_STATUSES.has(s) &&
        !ISSUE_ABANDONED_STATUSES.has(s),
    );
    expect(unclassified).toEqual([]);
  });

  it('classifies the canonical unified spellings, not only the legacy aliases', () => {
    // The exact regression: a set holding only {resolved, closed} passes every
    // assertion above that does not name the post-flip spellings explicitly.
    expect(ISSUE_SHIPPED_STATUSES.has('done')).toBe(true);
    expect(ISSUE_ABANDONED_STATUSES.has('dropped')).toBe(true);
  });

  it('leaves every non-terminal state out of both sets', () => {
    for (const s of ['open', 'wip', 'blocked', 'needs-human']) {
      expect(ISSUE_SHIPPED_STATUSES.has(s)).toBe(false);
      expect(ISSUE_ABANDONED_STATUSES.has(s)).toBe(false);
    }
  });
});
