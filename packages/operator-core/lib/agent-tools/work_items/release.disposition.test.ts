/**
 * work_items:release — the RELEASE DISPOSITION (EI-21352358541526229).
 *
 * A voluntary release's `reason` was collected and then went nowhere the next claimant
 * could see it. Measured on the live substrate: `harness_shared.work_items` carries only
 * `last_released_by` / `last_released_at` / `worked_by_history` (whose entries are
 * `{at, owner}` — no reason field), and `PriorWorkRow` reads exactly those columns. So a
 * disposition typed into `reason` reached the audit row and the notifications and STOPPED.
 * The next claimant was told `priorWork hasCheckpoint:false` — "someone worked this and
 * left nothing" — and had to re-derive the rest: 6–10 tool calls of Postgres forensics and
 * repo greps per item, measured across three items in ONE 2026-08-24 drain pass whose
 * deliverables were already built and landed (WI-6222, WI-6250, EI-18755383809076205).
 *
 * Two behaviours are pinned here:
 *
 *   (A) RECORD — a voluntary release carrying a `reason` for an item with NO checkpoint
 *       stores that reason AS the checkpoint, which is the surface every pickup path
 *       already reads, so the disposition reaches the claimant through machinery that
 *       already exists. It must never clobber a real worked checkpoint, must never
 *       attribute a FORCER's audit reason to the displaced holder, and must never fail
 *       the release when the bookkeeping write fails.
 *
 *   (B) NUDGE — the fully-blind release (no checkpoint AND no reason) previously returned
 *       NOTHING: `claimHoldNudge` requires `(releaseCheckpoint || reason)` and
 *       `strandedCheckpointWarning` requires a checkpoint, so the releaser who left the
 *       LEAST behind got the LEAST feedback. Measured 2026-09-05 on papercusp: 192 of
 *       1,088 released-and-claimable non-observation items (17.6%) are in this state.
 *
 * The mocking mirrors release.stranded-checkpoint.test.ts deliberately, including its
 * PARTIAL (importOriginal) factories: a hand-listed factory silently returns `undefined`
 * for any member release.ts imports but the list forgot, and the tool then crashes on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const readOutbox = vi.hoisted(() => vi.fn());
vi.mock('../coordination/identity', () => ({
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseWorkItem: vi.fn(),
  setWorkItemClaimHold: vi.fn(),
  getWorkItem: vi.fn(),
  commentWorkItem: vi.fn(async () => null),
}));
const assessForceReleaseM = vi.hoisted(() => vi.fn());
vi.mock('./release-force-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assessForceRelease: assessForceReleaseM,
  recordForceReleaseAudit: vi.fn(async () => {}),
  notifyForceRelease: vi.fn(async () => {}),
}));
vi.mock('../../work-items-release-request', () => ({
  readWorkItemReleaseRequest: vi.fn(() => null),
  resolveWorkItemReleaseRequest: vi.fn(async () => null),
}));

/**
 * `getWorkItemCheckpoint` is the "what does the checkpoint currently say" knob;
 * `setWorkItemCheckpointM` is the WRITE under test. Both sit on the partial factory so a
 * future member of this module cannot silently become `undefined`.
 */
const getWorkItemCheckpoint = vi.fn();
// Declared WITH its real parameter list, not `vi.fn(async () => …)`: a zero-arg mock types
// `mock.calls[0]` as `[]`, so reading the recorded (ref, text) back needs a cast that TS
// rejects (TS2352) — and casting through `unknown` to silence it would throw away exactly
// the argument types these assertions depend on.
const setWorkItemCheckpointM = vi.hoisted(() =>
  vi.fn(async (_ref: { harness: string | null; workItemId: string; workspaceId?: string }, _text: string) =>
    'stored' as string | null,
  ),
);
vi.mock('../../work-item-checkpoint', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkItemCheckpointWithMeta: async (...a: unknown[]) => ({
    checkpoint: ((await getWorkItemCheckpoint(...a)) as string | null) ?? null,
    updatedAtMs: null,
  }),
  setWorkItemCheckpoint: setWorkItemCheckpointM,
}));
vi.mock('../coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOutbox,
}));
const listEscalationsM = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../coordination/escalations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listEscalations: listEscalationsM,
}));

import { releaseWorkItem, setWorkItemClaimHold, type WorkItem } from '../../work-items';
import { readOutbox as readOutboxSurface } from '../coordination/messages';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
const releaseM = vi.mocked(releaseWorkItem);
const holdM = vi.mocked(setWorkItemClaimHold);
const outboxM = vi.mocked(readOutboxSurface);
const tool = (await import('./release')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

/** A COMPLETE WorkItem with a Partial override seam — never `as never`. */
const wi = (over: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem => ({
  kind: 'bug',
  family: 'issue',
  harness: 'papercusp',
  title: 't',
  summary: 's',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
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
  goalId: null,
  ...over,
});

/** A real worked checkpoint — the thing a one-line disposition must never overwrite. */
const REAL_CHECKPOINT =
  'Fix implemented + committed at 7a8371a1caf9. Ran npm run test:file -- swarm.test.ts: 61/61 green. ' +
  'Left: nothing — closing next wake.';

const releaseReporting = (prior: { assignee: string | null; wasClaimed: boolean }) =>
  mockImplementationTyped(releaseM, async (id, opts) => {
    opts?.onPriorState?.(prior);
    return wi({ id, assignee: null });
  });

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  releaseReporting({ assignee: 'me', wasClaimed: true });
  mockResolvedTyped(holdM, { id: 'WI-PARK', harness: 'papercusp', hold: true, applicable: true });
  getWorkItemCheckpoint.mockResolvedValue(null);
  setWorkItemCheckpointM.mockResolvedValue('stored');
  outboxM.mockResolvedValue([]);
  listEscalationsM.mockResolvedValue([]);
});

describe('work_items:release — (A) records a reason as the next claimant\'s context', () => {
  it('stores the reason AS the checkpoint when the item has none', async () => {
    const b = await body({ id: 'WI-5001', reason: 'wrote migration 824, not yet applied' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-5001', releaseDispositionRecorded: true });

    expect(setWorkItemCheckpointM).toHaveBeenCalledTimes(1);
    const [ref, text] = setWorkItemCheckpointM.mock.calls[0];
    expect(ref).toMatchObject({ workItemId: 'WI-5001', workspaceId: 'ws-1', harness: 'papercusp' });
    // The releaser's own words must survive verbatim — that IS the payload.
    expect(text).toContain('wrote migration 824, not yet applied');
    // ...and must be labelled as a disposition, not misread as a verified resume brief.
    expect(text).toMatch(/NOT a worked checkpoint/);
    expect(text).toContain('me');
  });

  it('does NOT clobber an existing worked checkpoint', async () => {
    getWorkItemCheckpoint.mockResolvedValue(REAL_CHECKPOINT);
    const b = await body({ id: 'WI-5002', reason: 'one line' });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
    expect(setWorkItemCheckpointM).not.toHaveBeenCalled();
  });

  it('records nothing when there is no reason to record', async () => {
    const b = await body({ id: 'WI-5003' });
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
    expect(setWorkItemCheckpointM).not.toHaveBeenCalled();
  });

  it('stays silent on a NO-OP release (the item was already unassigned)', async () => {
    releaseReporting({ assignee: null, wasClaimed: false });
    const b = await body({ id: 'WI-5004', reason: 'never held it' });
    expect(b.results[0]).toMatchObject({ ok: true, released: false });
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
    expect(setWorkItemCheckpointM).not.toHaveBeenCalled();
  });

  it('never fails the release when the checkpoint write throws', async () => {
    setWorkItemCheckpointM.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-5005', reason: 'left a note' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-5005', released: true });
    expect(b.results[0].error).toBeUndefined();
    // No claim of having recorded something that was not recorded.
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
  });

  it('never fails the release when the checkpoint write throws SYNCHRONOUSLY', async () => {
    // The control for the real defect this shipped with. `.catch()` attaches to the promise a
    // call RETURNS, so it cannot catch a throw from the call ITSELF — and a hand-listed
    // vi.mock factory that omits the member yields `undefined`, making `undefined(...)` throw
    // exactly that way. It took release.test.ts down as a TypeError with the release already
    // performed. Revert the try/catch in release.ts to `.catch(() => null)` and this fails.
    setWorkItemCheckpointM.mockImplementation(() => {
      throw new TypeError('setWorkItemCheckpoint is not a function');
    });
    const b = await body({ id: 'WI-5007', reason: 'left a note' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-5007', released: true });
    expect(b.results[0].error).toBeUndefined();
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
  });

  it('does not attribute a FORCER\'s audit reason to the displaced holder', async () => {
    const { getWorkItem } = await import('../../work-items');
    mockResolvedTyped(vi.mocked(getWorkItem), wi({ id: 'WI-5006', assignee: 'peer' }));
    assessForceReleaseM.mockResolvedValue({ allowed: true, basis: 'holder-not-live', holderLiveness: {} });
    releaseReporting({ assignee: 'peer', wasClaimed: true });

    const b = await body({ id: 'WI-5006', force: true, reason: 'peer session dead, reclaiming for the drain' });
    expect(b.results[0].ok).toBe(true);
    // The reason belongs to the forcer's audit trail, not to the holder's resume context.
    expect(setWorkItemCheckpointM).not.toHaveBeenCalled();
    expect(b.results[0].releaseDispositionRecorded).toBeUndefined();
  });
});

describe('work_items:release — (B) the fully-blind release is no longer silent', () => {
  it('nudges when there is NEITHER a checkpoint NOR a reason', async () => {
    const b = await body({ id: 'WI-6001' });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    const n = b.results[0].blindReleaseNudge;
    expect(n).toBeTypeOf('string');
    expect(n).toMatch(/UNSTARTED/);
    expect(n).toMatch(/hasCheckpoint:false/);
    // It must name the remedy and make the post-release peer-reclaim race explicit.
    expect(n).toContain("work_items:release { id:'WI-6001'");
    expect(n).toMatch(/original work_items:release call/);
    expect(n).toMatch(/re-read work_items:get before following up/);
    expect(n).toMatch(/not_holder result means another agent currently holds it/);
    expect(n).toMatch(/coordinate with them instead of forcing/);
  });

  it('is SILENT once a reason is supplied — the two paths are mutually exclusive', async () => {
    const b = await body({ id: 'WI-6002', reason: 'migration written, not applied' });
    expect(b.results[0].blindReleaseNudge).toBeUndefined();
    // ...and the reason took the RECORD path instead.
    expect(b.results[0].releaseDispositionRecorded).toBe(true);
    // The pre-existing claimHoldNudge still fires for the reason case (unchanged behaviour).
    expect(b.results[0].claimHoldNudge).toMatch(/self-selectable by other agents immediately/);
  });

  it('is SILENT when a checkpoint already carries the context', async () => {
    getWorkItemCheckpoint.mockResolvedValue(REAL_CHECKPOINT);
    const b = await body({ id: 'WI-6003' });
    expect(b.results[0].blindReleaseNudge).toBeUndefined();
    expect(b.results[0].claimHoldNudge).toMatch(/checkpoint remains resume context/);
  });

  it('is SILENT on a NO-OP release — nothing was stranded', async () => {
    releaseReporting({ assignee: null, wasClaimed: false });
    const b = await body({ id: 'WI-6004' });
    expect(b.results[0]).toMatchObject({ ok: true, released: false });
    expect(b.results[0].blindReleaseNudge).toBeUndefined();
  });

  it('is SILENT on an explicit claimHold:false re-pool (a deliberate handoff)', async () => {
    const b = await body({ id: 'WI-6005', claimHold: false });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].blindReleaseNudge).toBeUndefined();
  });

  it('evaluates each item of a batch independently', async () => {
    getWorkItemCheckpoint.mockImplementation(async (ref: unknown) =>
      (ref as { workItemId: string }).workItemId === 'WI-WARM' ? REAL_CHECKPOINT : null,
    );
    const b = await body({ ids: ['WI-COLD', 'WI-WARM'] });
    expect(b.results[0]).toMatchObject({ id: 'WI-COLD' });
    expect(b.results[0].blindReleaseNudge).toMatch(/UNSTARTED/);
    expect(b.results[1]).toMatchObject({ id: 'WI-WARM' });
    expect(b.results[1].blindReleaseNudge).toBeUndefined();
  });
});
