/**
 * release.test.ts — work_items:release handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fn mocked. Pins: inline single →
 * one result with workItem; ids:[…] fan-out; a not-found item fails only itself (so the
 * plan-item reflect rules fire per released item via the D-007 fan-out).
 *
 * EI-7588: release now compare-and-releases under the caller's resolved identity
 * (`expectedAssignee`); an authorized cross-holder force CASes the exact holder it
 * assessed. A peer's live claim comes back `not_holder` + `holder` instead of being
 * silently cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me' }));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId }),
}));
vi.mock('../../work-items', () => ({
  releaseWorkItem: vi.fn(),
  setWorkItemClaimHold: vi.fn(),
  getWorkItem: vi.fn(),
  commentWorkItem: vi.fn(),
  isClaimHoldParked: vi.fn((payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false;
    return String((payload as Record<string, unknown>)._claimHold) === 'true';
  }),
}));
// WI-10006515: release heals an own-node issue row stranded at origin='remote' and retries
// once. Partial mock so every other export stays real. The helper is stubbed at the export
// release.ts imports: the real one resolves the workspace through a same-module call that a
// module mock cannot intercept, so stubbing only resolveIssueWorkspace would reach PG.
const ownNode = vi.hoisted(() => ({ heal: vi.fn(async (_ws: string, _id: string, _h?: string | null) => false) }));
vi.mock('../../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issues-engineer')>()),
  healOwnNodeIssueOrigin: vi.fn(async (id: string, harness?: string | null) => ownNode.heal('ws-test', id, harness ?? null)),
}));

// EI-21352358541526229: this factory is HAND-LISTED (no importOriginal), so every member
// release.ts imports must appear here or it resolves to `undefined` and the tool crashes on
// the call. `setWorkItemCheckpoint` is the release-disposition write; omitting it took this
// whole suite down with a synchronous TypeError. Add new members here when release.ts grows
// an import, or switch this factory to the partial (importOriginal) form its siblings use.
const checkpointStore = vi.hoisted(() => ({
  getWorkItemCheckpointWithMeta: vi.fn(async () => ({
    checkpoint: null as string | null,
    updatedAtMs: null as number | null,
  })),
  setWorkItemCheckpoint: vi.fn(async () => 'stored' as string | null),
}));
vi.mock('../../work-item-checkpoint', () => checkpointStore);

const reachabilityM = vi.hoisted(() =>
  vi.fn(async () => ({
    verdict: 'reachable' as const,
    basis: 'live-resolver' as const,
    authoritative: true,
    evidence: 'catalogued producer is live',
    checkedAt: '2026-09-01T12:00:00.000Z',
  })),
);
vi.mock('../../external-condition-reachability', () => ({
  readEventConditionReachability: reachabilityM,
}));

// WI-5974: a voluntary/authorized release auto-resolves any pending release request —
// mocked here so existing tests (no pending request on any item) are unaffected, and the
// dedicated describe block below pins the wiring itself.
const releaseRequest = vi.hoisted(() => ({
  readWorkItemReleaseRequest: vi.fn(() => null as unknown),
  resolveWorkItemReleaseRequest: vi.fn(async () => null as unknown),
}));
vi.mock('../../work-items-release-request', () => releaseRequest);

// WI-4198: the force guard is unit-tested in release-force-guard.test.ts; here it is
// mocked so these tests pin the HANDLER's contract (when the guard is consulted, what
// a refusal/approval does to the release + audit + notify calls).
const guard = vi.hoisted(() => ({
  verdict: { allowed: true, basis: 'holder-not-live', holderLiveness: { live: false } } as {
    allowed: boolean;
    basis?: string;
    holderLiveness: Record<string, unknown>;
  },
}));
vi.mock('./release-force-guard', () => ({
  assessForceRelease: vi.fn(async () => guard.verdict),
  forceRefusalHint: (holder: string) => `refused:${holder}`,
  recordForceReleaseAudit: vi.fn(async () => {}),
  notifyForceRelease: vi.fn(async () => {}),
}));

import {
  releaseWorkItem,
  setWorkItemClaimHold,
  getWorkItem,
  commentWorkItem,
  type WorkItem,
} from '../../work-items';
import { assessForceRelease, notifyForceRelease, recordForceReleaseAudit } from './release-force-guard';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
const releaseM = vi.mocked(releaseWorkItem);
const holdM = vi.mocked(setWorkItemClaimHold);
const getM = vi.mocked(getWorkItem);
const commentM = vi.mocked(commentWorkItem);
const assessM = vi.mocked(assessForceRelease);
const auditM = vi.mocked(recordForceReleaseAudit);
const notifyM = vi.mocked(notifyForceRelease);
const checkpointM = checkpointStore.getWorkItemCheckpointWithMeta;
const tool = (await import('./release')).default;
const LONG_REASON = 'r'.repeat(501);
const CLAMPED_REASON = LONG_REASON.slice(0, 500);

/** A complete issue-family row for typed release/get fixtures. */
const workItemFixture = ({ id, ...overrides }: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem => ({
  id,
  kind: 'bug',
  family: 'issue',
  harness: 'h',
  title: 'fixture',
  summary: '',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  goalId: null,
  parent: null,
  payload: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  ...overrides,
});
// vitest 4 infers a vi.fn mock's Parameters from its initial implementation —
// a zero-arg arrow made `.mock.calls[N]` the empty tuple `[]`, so indexing
// `[1]` below (line 262) failed to typecheck (TS2493) even though the real
// sendMessage takes multiple positional args. A rest param keeps the mock
// body identical while giving `.mock.calls[N][i]` real element types.
const sendMessageM = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({}) as never));
vi.mock('../coordination/messages', () => ({ sendMessage: sendMessageM }));
// EI-14883: release.ts folds the workspace's OPEN escalations to flag a re-pooled item
// that is still awaiting a decision. Left unmocked that is a live coord/PG read inside a
// unit test — stubbed empty here so these tests stay hermetic and the disclosure stays
// silent; its own behaviour is pinned in release.stranded-checkpoint.test.ts.
vi.mock('../coordination/escalations', () => ({ listEscalations: vi.fn(async () => []) }));

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;
const parse = (args: unknown) => (tool.args as { parse: (value: unknown) => unknown }).parse(args);

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  guard.verdict = { allowed: true, basis: 'holder-not-live', holderLiveness: { live: false } };
  releaseRequest.readWorkItemReleaseRequest.mockReturnValue(null);
  releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue(null);
  commentM.mockResolvedValue({ id: 'post-1' } as never);
  sendMessageM.mockResolvedValue({} as never);
  reachabilityM.mockResolvedValue({
    verdict: 'reachable',
    basis: 'live-resolver',
    authoritative: true,
    evidence: 'catalogued producer is live',
    checkedAt: '2026-09-01T12:00:00.000Z',
  });
  releaseM.mockImplementation(async (id: string) => ({ id, assignee: null }) as never);
  holdM.mockImplementation(
    async (id: string, hold: boolean) => ({ id, harness: null, hold, applicable: true }) as never,
  );
  checkpointM.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
});

describe('work_items:release handler (keyed-array)', () => {
  it('releases one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1' } });
    expect(releaseM).toHaveBeenCalledWith('WI-1', {
      harness: undefined,
      expectedAssignee: 'me',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
  });

  it('releases MANY via ids:[…]', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(releaseM).toHaveBeenCalledWith('WI-2', {
      harness: 'h',
      expectedAssignee: 'me',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
  });

  it('a not-found item (null) fails only itself', async () => {
    releaseM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id } as never)));
    getM.mockResolvedValue(null as never);
    const b = await body({ ids: ['WI-1', 'WI-X'] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });

  it('preserves a labeled PG timeout in the runBulk item error', async () => {
    releaseM.mockRejectedValue(
      new OrgTxnTimeoutError('57014', new Error('statement canceled'), undefined, 'pg', 'read', 'work_items:release:read-preflight'),
    );

    const b = await body({ id: 'EI-timeout' });

    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-timeout' });
    expect(b.results[0].error).toContain('[phase: work_items:release:read-preflight]');
    expect(b.results[0].error).toContain('pg 57014 statement_timeout');
  });
});

describe('work_items:release reason soft cap', () => {
  it('accepts an over-length reason in both batch and per-item schemas', () => {
    const batch = tool.args.safeParse({ id: 'WI-1', reason: LONG_REASON });
    const perItem = tool.args.safeParse({ items: [{ id: 'WI-1', reason: LONG_REASON }] });

    expect(batch.success).toBe(true);
    expect(perItem.success).toBe(true);
    if (batch.success) expect(batch.data.reason).toHaveLength(LONG_REASON.length);
    if (perItem.success) expect(perItem.data.items?.[0]?.reason).toHaveLength(LONG_REASON.length);
  });

  it('reports reasonTruncated on a normal release instead of rejecting the call', async () => {
    const b = await body({ id: 'WI-1', reason: LONG_REASON });

    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', reasonTruncated: true });
  });

  it('warns that a plain reason is recorded but does not make the disposition sticky', async () => {
    releaseM.mockImplementation(async (id: string, opts?: Record<string, unknown>) => {
      (opts?.onPriorState as ((p: { assignee: string | null; wasClaimed: boolean }) => void) | undefined)?.({
        assignee: 'me',
        wasClaimed: true,
      });
      return { id, assignee: null } as never;
    });

    const b = await body({ id: 'WI-DEFER', reason: 'deferred until the supervised migration window' });

    expect(b.results[0].claimHoldNudge).toMatch(/release reason was recorded, but does not change selectability/);
    expect(b.results[0].claimHoldNudge).toMatch(/work_items:release.*claimHold:true.*claimHoldRelease/);
    expect(b.results[0].claimHoldNudge).toMatch(/original work_items:release call/);
    expect(b.results[0].claimHoldNudge).toMatch(/re-read work_items:get before following up/);
    expect(b.results[0].claimHoldNudge).toMatch(/not_holder result means another agent currently holds it/);
    expect(b.results[0].claimHoldNudge).toMatch(/coordinate with them instead of forcing/);
    expect(holdM).not.toHaveBeenCalled();
  });

  it('does not warn that a durably claim-held row is self-selectable after plain release', async () => {
    releaseM.mockImplementation(async (id: string, opts?: Record<string, unknown>) => {
      (opts?.onPriorState as ((p: { assignee: string | null; wasClaimed: boolean }) => void) | undefined)?.({
        assignee: 'me',
        wasClaimed: true,
      });
      return workItemFixture({
        id,
        assignee: null,
        payload: { _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'await recurrence' },
      }) as never;
    });

    const b = await body({ id: 'WI-HELD', reason: 'no review until fresh recurrence' });

    expect(b.results[0].workItem.payload).toMatchObject({ _claimHold: true });
    expect(b.results[0]).not.toHaveProperty('claimHoldNudge');
    expect(holdM).not.toHaveBeenCalled();
  });
});

// EI-7588: release refuses to silently clear ANOTHER agent's live claim.
describe('work_items:release holder guard (EI-7588)', () => {
  it('a peer-held item fails loudly with not_holder + holder, never silently clearing it', async () => {
    releaseM.mockResolvedValue(null as never); // the atomic compare-and-release matched 0 rows
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    const b = await body({ id: 'WI-HELD' });
    expect(releaseM).toHaveBeenCalledWith('WI-HELD', {
      harness: undefined,
      expectedAssignee: 'me',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'not_holder', holder: 'peer' });
    expect(b.results[0].hint).toMatch(/Held by peer, not you \(me\)/);
  });

  it('a batch default force applies to every item unless a per-item override is given', async () => {
    releaseM.mockImplementation(async (id: string, opts?: { expectedAssignee?: string }) =>
      opts?.expectedAssignee && id === 'WI-2' ? null : ({ id } as never),
    );
    getM.mockImplementation(async (id: string) => ({ id, assignee: id === 'WI-2' ? 'peer' : null }) as never);
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2', force: false }], force: true });
    expect(releaseM).toHaveBeenNthCalledWith(1, 'WI-1', {
      harness: undefined,
      expectedAssignee: undefined,
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(releaseM).toHaveBeenNthCalledWith(2, 'WI-2', {
      harness: undefined,
      expectedAssignee: 'me',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-2', error: 'not_holder', holder: 'peer' });
  });

  it('releasing an already-unclaimed item still succeeds (no holder to conflict with)', async () => {
    const b = await body({ id: 'WI-FREE' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FREE' });
    expect(getM).not.toHaveBeenCalled();
  });
});

// WI-6678: a mutation must report its DELTA, not just ok:true. Releasing an ALREADY
// unassigned item is not an error but is also not a release, and it used to return a
// result byte-identical to a real one — so a caller could verify the post-state, see
// `assignee: null` (exactly what the pre-state was), and conclude it had cleared a claim
// it never touched. Observed live 2026-08-01 on fleet:leader-brief orphaned_in_flight.
describe('work_items:release reports its delta (WI-6678)', () => {
  /** Drive the pre-state through the SAME seam production uses: releaseWorkItem's own
   *  row-read hands the holder back via onPriorState. Mocking it this way is what makes
   *  these tests able to fail if the handler ever goes back to a call-site pre-read. */
  const releaseWithPrior = (assignee: string | null) =>
    releaseM.mockImplementation(async (id: string, opts?: Record<string, unknown>) => {
      (opts?.onPriorState as ((p: { assignee: string | null; wasClaimed: boolean }) => void) | undefined)?.({
        assignee,
        wasClaimed: Boolean(assignee),
      });
      return { id } as never;
    });

  it('a REAL release reports released:true + the previous holder, and no noop hint', async () => {
    releaseWithPrior('me');
    const b = await body({ id: 'WI-MINE' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-MINE', released: true, previousAssignee: 'me' });
    expect(b.results[0]).not.toHaveProperty('noop');
  });

  it('a NO-OP release reports released:false + previousAssignee:null + a noop hint, still ok:true', async () => {
    releaseWithPrior(null);
    const b = await body({ id: 'WI-FREE' });
    // ok:true is deliberately preserved — the call DID succeed; the delta is what
    // distinguishes it, which is the whole point of the field.
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FREE', released: false, previousAssignee: null });
    expect(String((b.results[0] as { noop?: string }).noop)).toMatch(/ALREADY unassigned/i);
  });

  it("the delta comes from releaseWorkItem's own read — the handler never pre-reads the row itself", async () => {
    // The first cut of this fix called getWorkItem at the call site. That was a redundant
    // round-trip AND racy: the assignee can change between the call site's read and the
    // library's, so previousAssignee could describe a state the release never acted on.
    releaseWithPrior('me');
    await body({ id: 'WI-MINE' });
    expect(getM).not.toHaveBeenCalled();
    expect(releaseM).toHaveBeenCalledWith('WI-MINE', expect.objectContaining({ onPriorState: expect.any(Function) }));
  });

  it('a release that reports NO prior state (row vanished) degrades to released:false, never a false positive', async () => {
    // onPriorState never fires when the row is not found. The handler must not invent a
    // release it cannot evidence.
    releaseM.mockImplementation(async (id: string) => ({ id }) as never);
    const b = await body({ id: 'WI-GONE' });
    expect(b.results[0]).toMatchObject({ ok: true, released: false, previousAssignee: null });
  });
});

// WI-6031: a federated (origin='remote') issue-family row's release is intentionally
// no-op'd by the engineer_issues_view_dml trigger (EI-7833) — every OTHER visible
// predicate (unassigned, ids match) looks eligible, so the caller needs a NAMED signal
// instead of the generic release_failed catch-all.
describe('work_items:release remote-origin guard (WI-6031)', () => {
  it('a remote-origin issue fails with release_blocked_remote_origin, not the generic release_failed', async () => {
    releaseM.mockResolvedValue(null as never); // engineer_issues_view_dml no-ops the UPDATE
    getM.mockResolvedValue({ id: 'EI-REMOTE', family: 'issue', origin: 'remote', assignee: null } as never);
    const b = await body({ id: 'EI-REMOTE' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-REMOTE', error: 'release_blocked_remote_origin' });
    expect(b.results[0].hint).toMatch(/federated.*origin='remote'/);
    expect(b.results[0].workItem).toMatchObject({ id: 'EI-REMOTE', origin: 'remote' });
  });

  // WI-10006515: `origin` records how a row ARRIVED, not who wrote it.
  it('an OWN-NODE issue stranded at origin=remote is healed and the release retried once', async () => {
    ownNode.heal.mockReset();
    ownNode.heal.mockResolvedValueOnce(true);
    releaseM.mockReset();
    mockResolvedOnceTyped(releaseM, null);
    mockResolvedOnceTyped(releaseM, workItemFixture({ id: 'EI-OWN', family: 'issue', origin: 'local', harness: 'papercusp' }));
    mockResolvedTyped(getM, workItemFixture({ id: 'EI-OWN', family: 'issue', origin: 'remote', assignee: null, harness: 'papercusp' }));
    const b = await body({ id: 'EI-OWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-OWN' });
    expect(ownNode.heal).toHaveBeenCalledTimes(1);
    expect(ownNode.heal).toHaveBeenCalledWith('ws-test', 'EI-OWN', 'papercusp');
    expect(releaseM).toHaveBeenCalledTimes(2);
  });

  it('a TRUE peer row (heal finds no own-node author key) is not retried and still names the remote origin', async () => {
    ownNode.heal.mockReset();
    ownNode.heal.mockResolvedValue(false);
    releaseM.mockReset();
    mockResolvedTyped(releaseM, null);
    mockResolvedTyped(getM, workItemFixture({ id: 'EI-PEER', family: 'issue', origin: 'remote', assignee: null }));
    const b = await body({ id: 'EI-PEER' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-PEER', error: 'release_blocked_remote_origin' });
    expect(ownNode.heal).toHaveBeenCalledTimes(1);
    expect(releaseM).toHaveBeenCalledTimes(1);
  });

  it('a remote row a PEER holds is never healed (the answer is not_holder)', async () => {
    ownNode.heal.mockReset();
    ownNode.heal.mockResolvedValue(true);
    releaseM.mockReset();
    mockResolvedTyped(releaseM, null);
    mockResolvedTyped(getM, workItemFixture({ id: 'EI-HELD', family: 'issue', origin: 'remote', assignee: 'su-peer' }));
    const b = await body({ id: 'EI-HELD' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-HELD', error: 'not_holder', holder: 'su-peer' });
    expect(ownNode.heal).not.toHaveBeenCalled();
  });

  it('a local-origin item with no other cause still falls back to the generic release_failed', async () => {
    releaseM.mockResolvedValue(null as never);
    getM.mockResolvedValue({ id: 'WI-ODD', family: 'feature', origin: 'local', assignee: null } as never);
    const b = await body({ id: 'WI-ODD' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-ODD', error: 'release_failed' });
  });

  it('a remote-origin FEATURE-family row (origin only meaningful for issues) still falls back to release_failed', async () => {
    releaseM.mockResolvedValue(null as never);
    getM.mockResolvedValue({ id: 'F-1', family: 'feature', origin: 'remote', assignee: null } as never);
    const b = await body({ id: 'F-1' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'F-1', error: 'release_failed' });
  });
});

// WI-4198: force is a CHECKED override — authority/liveness guard + reason + audit + notify.
describe('work_items:release force guard (WI-4198)', () => {
  it('clamps an over-length force reason in the result, audit, and notification', async () => {
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer', lastProgressAt: 'ts' } as never);
    const b = await body({ id: 'WI-HELD', force: true, reason: LONG_REASON });

    expect(b.results[0].forced).toMatchObject({ reason: CLAMPED_REASON, reasonTruncated: true });
    expect(auditM).toHaveBeenCalledWith(
      'me',
      'WI-HELD',
      expect.objectContaining({ reason: CLAMPED_REASON, reasonTruncated: true }),
    );
    expect(notifyM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'me' }),
      expect.objectContaining({ itemId: 'WI-HELD', reason: CLAMPED_REASON }),
    );
  });

  it('an authorized cross-holder force releases, reports `forced`, and audits + notifies', async () => {
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer', lastProgressAt: 'ts' } as never);
    const b = await body({ id: 'WI-HELD', force: true, reason: 'holder session dead 3h; reclaiming for the drain' });
    expect(releaseM).toHaveBeenCalledWith('WI-HELD', {
      harness: undefined,
      expectedAssignee: 'peer',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'WI-HELD',
      forced: { holder: 'peer', basis: 'holder-not-live', reason: 'holder session dead 3h; reclaiming for the drain' },
    });
    expect(auditM).toHaveBeenCalledWith(
      'me',
      'WI-HELD',
      expect.objectContaining({ holder: 'peer', basis: 'holder-not-live' }),
    );
    expect(notifyM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'me' }),
      expect.objectContaining({ itemId: 'WI-HELD', holder: 'peer' }),
    );
  });

  it('a cross-holder force WITHOUT a reason refuses (force_requires_reason) before touching the claim', async () => {
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    const b = await body({ id: 'WI-HELD', force: true });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'force_requires_reason', holder: 'peer' });
    expect(releaseM).not.toHaveBeenCalled();
    expect(assessM).not.toHaveBeenCalled();
  });

  it('executes an expired announced reclaim and resolves the exact request as consequence-reclaim', async () => {
    const request = {
      by: 'me',
      holder: 'peer',
      reason: 'deadline elapsed',
      onSilence: 'reclaim' as const,
      deadlineAt: 123,
      requestedAt: 100,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    };
    getM.mockResolvedValue({ id: 'WI-EXPIRED', assignee: 'peer', payload: { request: true } } as never);
    releaseRequest.readWorkItemReleaseRequest.mockReturnValue(request);
    guard.verdict = {
      allowed: true,
      basis: 'announced-release-request-expired',
      holderLiveness: { live: true, oracleSessionState: 'recorded' },
    };
    releaseM.mockResolvedValue({ id: 'WI-EXPIRED', assignee: null, harness: 'h', payload: { request: true } } as never);
    releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue({
      ...request,
      resolved: true,
      resolution: 'consequence-reclaim',
      resolvedAt: 456,
    });

    const b = await body({ id: 'WI-EXPIRED', force: true, reason: 'executing announced deadline' });

    expect(assessM).toHaveBeenCalledWith(expect.objectContaining({ releaseRequest: request }));
    expect(releaseM).toHaveBeenCalledWith('WI-EXPIRED', {
      harness: undefined,
      expectedAssignee: 'peer',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(releaseRequest.resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-EXPIRED', {
      harness: 'h',
      resolution: 'consequence-reclaim',
      expectedBy: 'me',
      expectedHolder: 'peer',
      expectedDeadlineAt: 123,
    });
    expect(commentM).toHaveBeenCalledWith('WI-EXPIRED', expect.stringContaining('EXPIRED unanswered'), 'me', {
      harness: 'h',
    });
    expect(b.results[0].forced).toMatchObject({ basis: 'announced-release-request-expired' });
  });

  it('an UNAUTHORIZED force on a live holder refuses (force_unauthorized) — the incident class', async () => {
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    guard.verdict = { allowed: false, holderLiveness: { live: true } };
    const b = await body({ id: 'WI-HELD', force: true, reason: 'taking over per drain mandate' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'force_unauthorized', holder: 'peer' });
    expect(b.results[0].hint).toBe('refused:peer');
    expect(releaseM).not.toHaveBeenCalled();
    expect(auditM).not.toHaveBeenCalled();
    expect(notifyM).not.toHaveBeenCalled();
  });

  it('force on an unclaimed or self-held item skips the guard entirely (plain unconditional release)', async () => {
    getM.mockImplementation(async (id: string) => ({ id, assignee: id === 'WI-MINE' ? 'me' : null }) as never);
    const b = await body({ ids: ['WI-FREE', 'WI-MINE'], force: true });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(assessM).not.toHaveBeenCalled();
    expect(auditM).not.toHaveBeenCalled();
    expect(releaseM).toHaveBeenCalledWith('WI-FREE', {
      harness: undefined,
      expectedAssignee: undefined,
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    expect(b.results[0].forced).toBeUndefined();
  });

  it('force on a missing item fails that item cleanly', async () => {
    getM.mockResolvedValue(null as never);
    const b = await body({ id: 'WI-GONE', force: true, reason: 'r' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-GONE' });
    expect(String(b.results[0].error)).toMatch(/not found/i);
    expect(releaseM).not.toHaveBeenCalled();
  });
});

// WI-2797: claimHold — the durable self-select-exclusion lever a release can ALSO apply.
describe('work_items:release { claimHold } (WI-2797 claim-hold lever)', () => {
  it('clamps an over-length durable park reason and reports reasonTruncated', async () => {
    const b = await body({ id: 'WI-1', claimHold: true, reason: LONG_REASON });

    expect(holdM).toHaveBeenCalledWith('WI-1', true, {
      harness: undefined,
      parkedBy: 'me',
      parkedReason: CLAMPED_REASON,
    });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: true, reasonTruncated: true });
  });

  it('omitting claimHold never calls setWorkItemClaimHold (no extra write when not requested)', async () => {
    const b = await body({ id: 'WI-1' });
    expect(holdM).not.toHaveBeenCalled();
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('claimHold');
  });

  it('claimHold:true releases without a broad claimable wake before applying a DURABLE park', async () => {
    const b = await body({ id: 'WI-1', claimHold: true, reason: 'umbrella item' });
    expect(releaseM).toHaveBeenCalledWith('WI-1', {
      harness: undefined,
      // releaseWorkItem emits from the pre-hold snapshot; the handler must keep the
      // parked item out of the broad claimable pool wake.
      announceClaimable: false,
      expectedAssignee: 'me',
      releasingOwnerId: 'me',
      onPriorState: expect.any(Function),
    });
    // WI-321 boomerang fix: park provenance goes in claim_hold_* (parkedBy), never held_open_*
    // — a held_open lease dies ~2h after the parker's session ends (WI-4531 reaper), which made
    // every ephemeral agent's park boomerang back into scheduler:get_next.
    expect(holdM).toHaveBeenCalledWith('WI-1', true, {
      harness: undefined,
      parkedBy: 'me',
      parkedReason: 'umbrella item',
    });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: true });
  });

  it('warns when claimHold:true parks an already-unassigned item with a fresh checkpoint (WI-5860)', async () => {
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    checkpointM.mockResolvedValue({ checkpoint: 'implemented; verification still running', updatedAtMs: now - 60_000 });
    try {
      const b = await body({ id: 'WI-FRESH', claimHold: true, reason: 'park after release' });

      expect(b.results[0]).toMatchObject({
        ok: true,
        released: false,
        claimHold: true,
        freshUnclaimedCheckpoint: {
          status: 'checkpointed-but-unowned',
          checkpointAgeMs: 60_000,
        },
      });
      expect(b.results[0].freshUnclaimedCheckpointWarning).toMatch(/CHECKPOINTED-BUT-UNOWNED/);
      expect(b.results[0].freshUnclaimedCheckpointWarning).toMatch(/assignee\/takenAt alone/);
      expect(checkpointM).toHaveBeenCalledWith({
        harness: null,
        workItemId: 'WI-FRESH',
        workspaceId: undefined,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not label an old checkpoint fresh when claimHold:true parks an already-unassigned item', async () => {
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    checkpointM.mockResolvedValue({ checkpoint: 'old handoff', updatedAtMs: now - 2 * 60 * 60_000 });
    try {
      const b = await body({ id: 'WI-OLD', claimHold: true });

      expect(b.results[0]).not.toHaveProperty('freshUnclaimedCheckpoint');
      expect(b.results[0]).not.toHaveProperty('freshUnclaimedCheckpointWarning');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('requires a typed release contract for every claimHold:true park', () => {
    expect(() => parse({ id: 'WI-1', claimHold: true, reason: 'wait for deploy' })).toThrow(
      /claimHoldRelease.*typed re-evaluation contract/,
    );
    expect(() =>
      parse({
        id: 'WI-1',
        claimHold: true,
        reason: 'wait for deploy',
        claimHoldRelease: { condition: 'deployment finishes', trigger: 'deploy:ready:staging' },
      }),
    ).not.toThrow();
  });

  it('derives reachability evidence and persists the typed claim_hold_release contract with the park', async () => {
    const b = await body({
      id: 'WI-1',
      claimHold: true,
      reason: 'wait for deploy',
      claimHoldRelease: {
        condition: 'deployment finishes',
        trigger: 'deploy:ready:staging',
        owner: 'release-owner',
      },
    });
    expect(reachabilityM).toHaveBeenCalledWith('deploy:ready:staging', { requireSpecificCondition: true });
    expect(holdM).toHaveBeenCalledWith('WI-1', true, {
      harness: undefined,
      parkedBy: 'me',
      parkedReason: 'wait for deploy',
      releaseContract: {
        condition: 'deployment finishes',
        owner: 'release-owner',
        trigger: 'deploy:ready:staging',
        reachability: 'reachable',
        evidence: 'catalogued producer is live',
      },
    });
    expect(b.results[0].claimHoldRelease).toMatchObject({
      trigger: 'deploy:ready:staging',
      reachability: 'reachable',
    });
  });

  it('claimHold:false clears a prior hold', async () => {
    const b = await body({ id: 'WI-1', claimHold: false });
    expect(holdM).toHaveBeenCalledWith('WI-1', false, { harness: undefined, parkedBy: 'me', parkedReason: undefined });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimHold: false });
  });

  it('returns the post-write workItem snapshot after clearing a prior hold', async () => {
    mockResolvedTyped(releaseM, workItemFixture({
      id: 'WI-1',
      harness: 'h1',
      payload: {
        _claimHold: true,
        claim_hold_by: 'me',
        claim_hold_release: { condition: 'gate opens', trigger: 'gate:open' },
        other: 'kept',
      },
    }));
    mockResolvedTyped(getM, workItemFixture({ id: 'WI-1', harness: 'h1', payload: { other: 'kept' } }));

    const b = await body({ id: 'WI-1', claimHold: false });

    expect(getM).toHaveBeenCalledWith('WI-1', 'h1');
    expect(b.results[0].workItem.payload).toEqual({ other: 'kept' });
    expect(b.results[0].workItem.payload).not.toHaveProperty('_claimHold');
    expect(b.results[0].workItem.payload).not.toHaveProperty('claim_hold_release');
  });

  it('a hold-engine miss (null — item vanished between release and hold) omits claimHold rather than reporting a false hold', async () => {
    holdM.mockResolvedValue(null);
    const b = await body({ id: 'F-1', claimHold: true });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'F-1' });
    expect(b.results[0].claimHold).toBeUndefined();
  });

  // EI-21966077123218777: omitting `claimHold` on a null avoids a FALSE POSITIVE but leaves
  // the caller unable to tell a no-op apart from success — the reply still says ok:true.
  // The park/unpark must be reported as FAILED, not merely left unmentioned.
  it('a hold-engine miss NAMES the failure (claimHoldFailed) instead of only staying silent', async () => {
    holdM.mockResolvedValue(null);
    const b = await body({ id: 'F-1', claimHold: true });
    // The pre-existing guarantee is unchanged — still no false hold reported.
    expect(b.results[0].claimHold).toBeUndefined();
    // ...but the no-op is now explicit, and says the release itself still happened.
    expect(b.results[0].claimHoldFailed).toEqual(expect.stringContaining('did NOT persist'));
    expect(b.results[0].claimHoldFailed).toEqual(expect.stringContaining('F-1'));
  });

  it('the UNPARK direction reports the miss too — a silently-unwritten claimHold:false leaves the row hidden from self-select', async () => {
    holdM.mockResolvedValue(null);
    const b = await body({ id: 'WI-9', claimHold: false });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-9' });
    expect(b.results[0].claimHold).toBeUndefined();
    expect(b.results[0].claimHoldFailed).toEqual(expect.stringContaining('claimHold:false'));
  });

  it('the miss names the harness it filtered on, so the caller can retry with the scope the row actually carries', async () => {
    holdM.mockResolvedValue(null);
    const b = await body({ items: [{ id: 'WI-1', harness: 'h1', claimHold: true }] });
    expect(b.results[0].claimHoldFailed).toEqual(expect.stringContaining("harness_slug='h1'"));
  });

  it('a SUCCESSFUL hold never carries claimHoldFailed (the field marks a real miss, not every claimHold call)', async () => {
    const b = await body({ id: 'WI-1', claimHold: true });
    expect(b.results[0]).toMatchObject({ ok: true, claimHold: true });
    expect(b.results[0].claimHoldFailed).toBeUndefined();
  });

  it('a batch default claimHold applies to every item unless a per-item override is given', async () => {
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2', claimHold: false }], claimHold: true });
    expect(holdM).toHaveBeenNthCalledWith(1, 'WI-1', true, {
      harness: undefined,
      parkedBy: 'me',
      parkedReason: undefined,
    });
    expect(holdM).toHaveBeenNthCalledWith(2, 'WI-2', false, {
      harness: undefined,
      parkedBy: 'me',
      parkedReason: undefined,
    });
    expect(b.results[0]).toMatchObject({ claimHold: true });
    expect(b.results[1]).toMatchObject({ claimHold: false });
  });

  it('per-item harness flows through to setWorkItemClaimHold', async () => {
    await body({ items: [{ id: 'WI-1', harness: 'h1', claimHold: true }], harness: 'default-h' });
    expect(holdM).toHaveBeenCalledWith('WI-1', true, { harness: 'h1', parkedBy: 'me', parkedReason: undefined });
  });
});

// WI-5974: a release resolves any pending work_items:request_release against the item early.
describe('work_items:release resolves a pending release request (WI-5974)', () => {
  it('no pending request on the item → no resolve attempt, no notify', async () => {
    releaseM.mockResolvedValue({ id: 'WI-1', assignee: null, harness: 'h', payload: null } as never);
    releaseRequest.readWorkItemReleaseRequest.mockReturnValue(null);
    await body({ id: 'WI-1' });
    expect(releaseRequest.resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
    expect(sendMessageM).not.toHaveBeenCalled();
  });

  it('a voluntary (non-forced) release resolves a pending request as holder-released and notifies the requester', async () => {
    const payload = { release_request_by: 'req-1' }; // shape irrelevant — readWorkItemReleaseRequest is mocked
    releaseM.mockResolvedValue({ id: 'WI-1', assignee: null, harness: 'h', payload } as never);
    releaseRequest.readWorkItemReleaseRequest.mockReturnValue({
      by: 'req-1',
      holder: 'me',
      reason: 'stalled',
      onSilence: 'reclaim',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    });
    releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue({
      by: 'req-1',
      holder: 'me',
      reason: 'stalled',
      onSilence: 'reclaim',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: true,
      resolution: 'holder-released',
      resolvedAt: Date.now(),
    });
    await body({ id: 'WI-1' });
    expect(releaseRequest.resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-1', {
      harness: 'h',
      resolution: 'holder-released',
    });
    expect(sendMessageM).toHaveBeenCalledTimes(1);
    expect(sendMessageM.mock.calls[0][1]).toMatchObject({ to: ['req-1'] });
    expect(commentM).toHaveBeenCalledTimes(1);
  });

  it('an already-resolved pending request (race) is never re-notified (CAS returns null)', async () => {
    releaseM.mockResolvedValue({ id: 'WI-1', assignee: null, harness: 'h', payload: {} } as never);
    releaseRequest.readWorkItemReleaseRequest.mockReturnValue({
      by: 'req-1',
      holder: 'me',
      reason: 'x',
      onSilence: 'nothing',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    });
    releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue(null); // lost the race
    await body({ id: 'WI-1' });
    expect(sendMessageM).not.toHaveBeenCalled();
    expect(commentM).not.toHaveBeenCalled();
  });

  it('a FORCED release resolves the pending request as "superseded", not "holder-released"', async () => {
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer', lastProgressAt: 'ts' } as never);
    releaseM.mockResolvedValue({ id: 'WI-HELD', assignee: null, harness: 'h', payload: {} } as never);
    releaseRequest.readWorkItemReleaseRequest.mockReturnValue({
      by: 'req-1',
      holder: 'peer',
      reason: 'x',
      onSilence: 'escalate',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    });
    releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue({
      by: 'req-1',
      holder: 'peer',
      reason: 'x',
      onSilence: 'escalate',
      deadlineAt: 1,
      requestedAt: 1,
      resolved: true,
      resolution: 'superseded',
      resolvedAt: Date.now(),
    });
    await body({ id: 'WI-HELD', force: true, reason: 'holder session dead 3h' });
    expect(releaseRequest.resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-HELD', {
      harness: 'h',
      resolution: 'superseded',
    });
  });

  it('a failure resolving the release request never fails the release itself (best-effort)', async () => {
    releaseM.mockResolvedValue({ id: 'WI-1', assignee: null, harness: 'h', payload: {} } as never);
    releaseRequest.readWorkItemReleaseRequest.mockImplementation(() => {
      throw new Error('boom');
    });
    const b = await body({ id: 'WI-1' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
  });
});
