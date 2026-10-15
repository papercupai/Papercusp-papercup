/**
 * set-status.coverage-guard.test.ts — the onlyIfNoOtherOpenCoverage guard
 * (EI-19972048649686949: "dropping a DUPLICATE work-item cascades `dropped`
 * onto its plan item, de-queueing live work that another work-item still
 * covers"). Opt-in and DESTRUCTIVE-flip-blocking (unlike the residual-coverage
 * warning): a →dropped flip carrying `onlyIfNoOtherOpenCoverage:true` is
 * SKIPPED entirely (never reaches the plan lock) when another non-terminal
 * work-item is still linked to the plan item via ANY of the three linkage
 * truth sources (`implements` edge, `relates` edge, `payload.plan_item`
 * stamp) — plan-items/reflect-rules.ts renders the flag on every automated
 * →dropped cascade so a duplicate's drop never de-queues a sibling
 * implementer's coverage.
 *
 * Sibling to set-status.residual-warning.test.ts (same lock-mocking harness);
 * this file mocks ../../plan-items/reconcile-linked-work-items instead of
 * ../../plan-items/convert, since the coverage guard reads the WIDER
 * findAllLinkedWorkItems union (implements + relates + stamp), not the
 * relates-only findCoverageWorkItems the residual warning uses.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.coverage-guard.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileMocks = vi.hoisted(() => ({
  findAllLinkedWorkItems: vi.fn(async () => [] as Array<{ id: string; state: string; assignee?: string | null }>),
  resolveAgentIdentity: vi.fn(),
  getClaim: vi.fn<typeof import('../../plan-items/claims').getClaim>(async () => null),
}));

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
// WI-10008137: the draft-plan item-start gate has its own suite (draft-item-start-gate.test.ts).
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => reconcileMocks.resolveAgentIdentity(),
  isEphemeralMcpCallIdentity: () => false,
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
}));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));
vi.mock('../../plan-items/claims', () => ({
  getClaim: (...args: Parameters<typeof import('../../plan-items/claims').getClaim>) => reconcileMocks.getClaim(...args),
}));
vi.mock('../../plan-items/reconcile-linked-work-items', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/reconcile-linked-work-items')>()),
  findAllLinkedWorkItems: reconcileMocks.findAllLinkedWorkItems,
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const { routedFollowUpConflict, routedWorkItemRefs } = await import('./set-status');
const tool = (await import('./set-status')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => (((await tool.handler(args as never, {} as never)) as Out).data);

/** Drive the lock: run the mutator against a fake body carrying `currentStatus`,
 *  then return its ok-value as a successful lock outcome (mirrors bulk test). */
function lockReturnsMutatorValue(knownItems: Set<string>, currentStatus = 'wip') {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const fakeBody = knownItems.has(itemId) ? `- **${itemId}** \`${currentStatus}\` x` : '';
    const { value } = await (mutate as (b: string | null) => Promise<{ value: unknown }>)(fakeBody);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([]);
  reconcileMocks.resolveAgentIdentity.mockImplementation(() => {
    throw new Error('no identity in this test');
  });
  reconcileMocks.getClaim.mockResolvedValue(null);
});

describe('plans:set-status coverage guard (EI-19972048649686949)', () => {
  it('extracts only explicit routed/follow-up work-item references', () => {
    expect(routedWorkItemRefs('ROUTED, UNPERFORMED TO WI-41495')).toEqual(['WI-41495']);
    expect(routedWorkItemRefs('see WI-41495 for historical context')).toEqual([]);
    expect(routedWorkItemRefs('follow-up WI-41495 and WI-835974')).toEqual(['WI-41495', 'WI-835974']);
  });

  it('identifies a non-terminal linked routed follow-up as a drop conflict', () => {
    expect(
      routedFollowUpConflict('ROUTED, UNPERFORMED TO WI-41495', [
        { id: 'WI-41495', state: 'blocked' },
        { id: 'WI-835974', state: 'open' },
      ]),
    ).toEqual({ id: 'WI-41495', state: 'blocked' });
    expect(
      routedFollowUpConflict('ROUTED, UNPERFORMED TO WI-835974', [
        { id: 'WI-41495', state: 'blocked' },
      ]),
    ).toBeNull();
  });

  it('matches the reconciler safety rails: assigned or unproven issue rows survive the drop', () => {
    expect(
      routedFollowUpConflict('ROUTED TO WI-111', [
        { id: 'WI-111', state: 'open', family: 'feature', assignee: 'su-live' },
      ]),
    ).toBeNull();
    expect(
      routedFollowUpConflict('ROUTED TO WI-112', [
        { id: 'WI-112', state: 'open', family: 'issue', viaImplementsEdge: false },
      ]),
    ).toBeNull();
    expect(
      routedFollowUpConflict('ROUTED TO WI-113', [
        { id: 'WI-113', state: 'open', family: 'issue', viaImplementsEdge: true },
      ]),
    ).toMatchObject({ id: 'WI-113', state: 'open' });
  });

  it('REFUSES a drop whose route note names a still-live linked work-item', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-41495', state: 'blocked' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-010']));
    const b = await body({
      slug: 'main-gate-qualification-transaction-acceleration-2026-08-25',
      item: 'P-010',
      status: 'dropped',
      note: 'ROUTED, UNPERFORMED TO WI-41495; preserve the operational obligation.',
    });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'routed_follow_up_conflict',
      routedWorkItem: 'WI-41495',
      routedWorkItemState: 'blocked',
    });
    expect(b.results[0].reason).toMatch(/would reconcile that obligation as stale residue/);
    expect(lockM).not.toHaveBeenCalled();
  });

  it('allows a route to an independently unlinked follow-up', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-41495', state: 'blocked' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-010']));
    const b = await body({
      slug: 'main-gate-qualification-transaction-acceleration-2026-08-25',
      item: 'P-010',
      status: 'dropped',
      note: 'ROUTED, UNPERFORMED TO WI-835974. WI-41495 is historical residue.',
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].newStatus).toBe('dropped');
    expect(lockM).toHaveBeenCalled();
  });

  it('allows a route whose named linked work-item is already terminal', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-41495', state: 'dropped' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-010']));
    const b = await body({
      slug: 'main-gate-qualification-transaction-acceleration-2026-08-25',
      item: 'P-010',
      status: 'dropped',
      note: 'ROUTED follow-up WI-41495 was already terminal; close the plan item.',
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].newStatus).toBe('dropped');
  });

  it('SKIPS a → dropped flip when another non-terminal work-item still covers the plan item', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37457', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'context-injection-retrieval-reach-and-visibility-2026-08-03',
      item: 'P-012',
      status: 'dropped',
      note: 'Intentional drop for the coverage-guard scenario.',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true); // never a hard error
    expect(b.results[0].skipped).toBe('coverage_guard');
    expect(b.results[0].coveredBy).toEqual(['WI-37457']);
    expect(b.results[0].reason).toMatch(/WI-37457/);
    // Never even entered the plan lock — a true no-op, not a write-then-revert.
    expect(lockM).not.toHaveBeenCalled();
  });

  it('returns the terminal coverage skip before refusing an agent reflection for another live claim', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([{ id: 'WI-37457', state: 'open' }]);
    reconcileMocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-agent' });
    reconcileMocks.getClaim.mockResolvedValue({
      workspaceId: 'default', harnessSlug: 'papercup', planSlug: 'plan-a', itemId: 'P-012',
      claimId: 'claim-peer', ownerName: null, livenessMode: 'activity', ttlSec: 300,
      acquiredTs: '2026-10-01T12:00:00Z', lastActivityTs: '2026-10-01T12:00:00Z',
      owner: 'su-peer',
      ownerLabel: 'Peer',
      intent: 'verifying this plan item',
      expiresTs: '2099-01-01T00:00:00.000Z',
      expired: false,
    });

    const b = await body({
      slug: 'context-injection-retrieval-reach-and-visibility-2026-08-03',
      item: 'P-012',
      status: 'done',
      onlyIfNoOtherOpenCoverage: true,
    });

    expect(b.results[0]).toMatchObject({ ok: true, skipped: 'coverage_guard', coveredBy: ['WI-37457'] });
    expect(reconcileMocks.getClaim).not.toHaveBeenCalled();
    expect(lockM).not.toHaveBeenCalled();
  });

  it('proceeds with the drop when nothing else covers the plan item (the flipping item excludes itself)', async () => {
    // findAllLinkedWorkItems is queried AFTER the triggering item's own state
    // already committed terminal — so the only linked row is itself, terminal.
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37458', state: 'dropped' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      note: 'Intentional drop after all linked work reached terminal state.',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
  });

  it('is a no-op unless the caller opts in with onlyIfNoOtherOpenCoverage — a bare → dropped flip is unaffected even with open coverage', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37457', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      note: 'Intentional unguarded drop for this scenario.',
    });
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  // WI-38908 CHANGED THIS CONTRACT. This test previously asserted the guard never fired
  // on `done` ("never checks coverage on a status other than dropped") — that assertion
  // WAS the bug, pinned. The guard now covers either TERMINAL status; only non-terminal
  // flips (reopen/park) still skip the check outright.
  it('never checks coverage on a NON-TERMINAL status, even with the flag set', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-37457', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-012']), 'done');
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'wip',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].skipped).toBeUndefined();
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  /**
   * WI-38908 — the 1:N lane. The guard was drop-only on the assumption that ONE work-item
   * implements a plan item, so a `done` cascade always meant "finished". A fix-loop lane
   * has MANY bugs stamped to one item: completing the first sibling marked the whole lane
   * done while the rest were open, which hid open blockers AND (because a plan-scoped claim
   * spec admits through that item) stopped anyone claiming them. Live: three auto-closes in
   * ~1h on sidestage-public-release-testing-2026-08-14#P-009 with 8+ non-terminal siblings.
   */
  it('SKIPS a → done flip while sibling work-items stamped to the same plan item are still open', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-38872', state: 'done' } as never, // the sibling that just completed
      { id: 'WI-38876', state: 'open' } as never, // still open — a CRITICAL blocker
      { id: 'WI-38863', state: 'wip' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-009']));
    const b = await body({
      slug: 'sidestage-public-release-testing-2026-08-14',
      item: 'P-009',
      status: 'done',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true); // a deliberate no-op, never a hard error
    expect(b.results[0].skipped).toBe('coverage_guard');
    // The completed sibling self-excludes (terminal); only the live ones are named.
    expect(b.results[0].coveredBy).toEqual(['WI-38876', 'WI-38863']);
    expect(b.results[0].reason).toMatch(/would de-queue work that is not finished/);
    expect(lockM).not.toHaveBeenCalled();
  });

  /**
   * FALSIFIABILITY for the case above: same lane, same flag — but every sibling is now
   * terminal, which is what closing the LAST bug looks like. The flip must proceed. Without
   * this, the test above could pass against a guard that simply refused every `done` flip.
   */
  it('proceeds with the → done flip once the LAST stamped sibling goes terminal', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-38872', state: 'done' } as never,
      { id: 'WI-38876', state: 'done' } as never,
      { id: 'WI-38863', state: 'dropped' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-009']));
    const b = await body({
      slug: 'sidestage-public-release-testing-2026-08-14',
      item: 'P-009',
      status: 'done',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('done');
  });

  // The 1:1 case the guard must leave exactly as it was: one implementer, it completes,
  // nothing else covers the item, so the plan item still auto-completes.
  it('leaves the 1:1 completion path unchanged — a lone implementer still closes its plan item', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-40001', state: 'done' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-003']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-003',
      status: 'done',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('done');
  });

  // Opt-in, like every other guard here: a leader deliberately closing a lane with open
  // children omits the flag and must still be able to (this is the manual restore path).
  it('is a no-op on → done unless the caller opts in — a bare human close still works with open coverage', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-38876', state: 'open' } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-009']));
    const b = await body({ slug: 'demo-plan', item: 'P-009', status: 'done' });
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('done');
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('a lookup failure is fail-safe — the drop still proceeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reconcileMocks.findAllLinkedWorkItems.mockRejectedValue(new Error('pg unavailable'));
    lockReturnsMutatorValue(new Set(['P-012']));
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      note: 'Intentional drop despite the best-effort coverage lookup failure.',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plans:set-status] coverage guard'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

describe('plans:set-status in-flight coverage guard (EI-21233859539099062)', () => {
  it('SKIPS a →todo flip when another linked non-terminal work-item is currently assigned', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-parent', state: 'wip', assignee: 'su-parent' },
      { id: 'WI-released', state: 'open', assignee: null },
    ]);
    lockReturnsMutatorValue(new Set(['P-020']), 'wip');
    const b = await body({
      slug: 'p020-plan',
      item: 'P-020',
      status: 'todo',
      onlyIfNoOtherInFlightCoverage: true,
    });
    expect(b.results[0]).toMatchObject({
      ok: true,
      skipped: 'in_flight_coverage_guard',
      coveredBy: ['WI-parent'],
    });
    expect(b.results[0].reason).toMatch(/held parent plan lane/);
    expect(lockM).not.toHaveBeenCalled();
  });

  it('only counts current assignees on non-terminal rows; released or terminal rows do not block', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-free', state: 'open', assignee: null },
      { id: 'WI-terminal', state: 'done', assignee: 'su-finished' },
      { id: 'WI-sentinel', state: 'wip', assignee: 'unassigned' },
    ]);
    lockReturnsMutatorValue(new Set(['P-020']), 'wip');
    const b = await body({
      slug: 'p020-plan',
      item: 'P-020',
      status: 'todo',
      onlyIfNoOtherInFlightCoverage: true,
    });
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('todo');
    expect(lockM).toHaveBeenCalled();
  });

  it('is opt-in and applies only to →todo; other callers do not pay for the linked-row read', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-parent', state: 'wip', assignee: 'su-parent' },
    ]);
    lockReturnsMutatorValue(new Set(['P-020']), 'wip');
    const unguarded = await body({ slug: 'p020-plan', item: 'P-020', status: 'todo' });
    expect(unguarded.results[0].newStatus).toBe('todo');
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();

    const terminal = await body({
      slug: 'p020-plan',
      item: 'P-020',
      status: 'done',
      onlyIfNoOtherInFlightCoverage: true,
    });
    expect(terminal.results[0].newStatus).toBe('done');
    expect(reconcileMocks.findAllLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('is fail-soft when the linked-row lookup fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reconcileMocks.findAllLinkedWorkItems.mockRejectedValue(new Error('pg unavailable'));
    lockReturnsMutatorValue(new Set(['P-020']), 'wip');
    const b = await body({
      slug: 'p020-plan',
      item: 'P-020',
      status: 'todo',
      onlyIfNoOtherInFlightCoverage: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('todo');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plans:set-status] in-flight coverage guard'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

/**
 * The completed guard (EI-20129670928216719) — the case that falls BETWEEN the coverage guard
 * above and `onlyIfNotTerminal`, by each one's own contract:
 *   - the coverage guard filters out terminal siblings, so the `done` work-item that actually
 *     COMPLETED the plan item never registers as coverage → the item reads as uncovered;
 *   - `terminalGuardTrips` deliberately permits terminal→terminal (done→dropped), pinned by
 *     set-status.test.ts.
 * So an automated cascade downgraded finished work. Live: dropping WI-37872 (merely
 * `relates`-linked) flipped fix-0014-platform-defects-2026-08-10#P-005 done→dropped 67ms
 * later, while its real completer WI-37735 sat `done`.
 *
 * Shares this file's lock-mocking harness. NOTE the guards run at different depths: the
 * coverage guard short-circuits BEFORE the plan lock, this one runs INSIDE it (it reads the
 * plan item's current status, which is only race-safe under the lock).
 */
describe('plans:set-status completed guard (EI-20129670928216719)', () => {
  /** The exact P-005 shape: a `done` plan item, its real completer `done`, the item being
   *  dropped merely linked. No OPEN coverage exists — which is precisely why the older guard
   *  cannot save it. */
  // Typed to the mock's real signature rather than cast — an `as never` here would defeat the
  // one check vi.mocked() gives us, and would go stale invisibly if that signature ever gains
  // a required field (lint:mock-cast-escape).
  const p005Links: Array<{ id: string; state: string }> = [
    { id: 'WI-37735', state: 'done' },
    { id: 'WI-37872', state: 'dropped' },
  ];

  it('SKIPS a done → dropped cascade — finished work is never downgraded', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue(p005Links);
    lockReturnsMutatorValue(new Set(['P-005']), 'done');
    const b = await body({
      slug: 'fix-0014-platform-defects-2026-08-10',
      item: 'P-005',
      status: 'dropped',
      note: 'Intentional cascade used to verify the completed-item guard.',
      onlyIfNoOtherOpenCoverage: true,
      onlyIfNotCompleted: true,
    });
    expect(b.results[0].ok).toBe(true); // a deliberate no-op, never a hard error
    expect(b.results[0].skipped).toBe('completed_guard');
    expect(b.results[0].currentStatus).toBe('done');
    expect(b.results[0].reason).toMatch(/done/);
  });

  /**
   * FALSIFIABILITY — this is the test that gives the one above its meaning. It runs the SAME
   * scenario carrying ONLY the pre-existing coverage flag, and asserts the downgrade still
   * happens. If someone "simplifies" the new guard away, the test above goes green-by-vacuity
   * unless this one pins that the old configuration genuinely does NOT protect the item.
   * (Proving it this way costs no tree mutation — see CLAUDE.md on why a mutate-and-restore
   * probe is unsafe here: git-sync can commit the mutant mid-run.)
   */
  it('reproduces the regression WITHOUT the flag — the coverage guard alone does not protect a done item', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue(p005Links);
    lockReturnsMutatorValue(new Set(['P-005']), 'done');
    const b = await body({
      slug: 'fix-0014-platform-defects-2026-08-10',
      item: 'P-005',
      status: 'dropped',
      note: 'Intentional drop used to reproduce the pre-guard downgrade.',
      onlyIfNoOtherOpenCoverage: true, // the guard that was ALREADY there
      // onlyIfNotCompleted deliberately omitted — this is the pre-fix behaviour
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped'); // ← the silent downgrade this bug is about
  });

  // OPT-IN, like every other guard here: a human deliberately reclassifying finished work as
  // abandoned omits the flag and must still be able to.
  it('leaves a genuine drop of UNFINISHED work alone even with the flag set', async () => {
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([]);
    lockReturnsMutatorValue(new Set(['P-012']), 'wip');
    const b = await body({
      slug: 'demo-plan',
      item: 'P-012',
      status: 'dropped',
      note: 'Intentional drop of unfinished work.',
      onlyIfNotCompleted: true,
    });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].skipped).toBeUndefined();
    expect(b.results[0].newStatus).toBe('dropped');
  });
});
