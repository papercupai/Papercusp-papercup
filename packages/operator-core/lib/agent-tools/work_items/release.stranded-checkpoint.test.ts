/**
 * work_items:release — the STRANDING warning (WI-38297).
 *
 * The bg-job checkpoint classifier (EI-18654296679612119) already fires on every
 * PICKUP path — work_items:get, work_items:claim, scheduler:get_next — so whoever
 * INHERITS an item is told its checkpoint leans on a background job. Nothing fired
 * on the way OUT, which is the moment the strand is actually created: a holder
 * writes "verification running in bg job <id>, will report+complete once it
 * finishes", releases, and their session dies taking that job's bookkeeping with it
 * (EI-16611). The result is an item that is FINISHED but reads `open`.
 *
 * Measured 2026-08-12 (WI-38297): WI-5895 sat open 17 days with its fix already
 * committed, stranded exactly this way, and 47 of the ~449 open+unheld items holding
 * a checkpoint cite a background job.
 *
 * FALSIFIABILITY: `detectBgJobCheckpointClaim` is deliberately left REAL here (never
 * mocked), so these tests exercise the actual regex rather than a stub that would
 * pass no matter what the classifier does. The "cites no background job" case is the
 * permanent CONTROL — without it, a warning wired to fire on ANY checkpoint would
 * pass the positive test just as happily.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const readOutbox = vi.hoisted(() => vi.fn());
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// PARTIAL mock (importOriginal), deliberately — a hand-listed factory silently returns
// `undefined` for any member release.ts imports but the list forgot, and the tool then
// crashes on it (the documented failure mode in claim.checkpoint-hint.test.ts).
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseWorkItem: vi.fn(),
  setWorkItemClaimHold: vi.fn(),
  getWorkItem: vi.fn(),
  commentWorkItem: vi.fn(async () => null),
}));
vi.mock('./release-force-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordForceReleaseAudit: vi.fn(async () => {}),
  notifyForceRelease: vi.fn(async () => {}),
}));
// No pending release-request in any of these scenarios — keep that bookkeeping inert
// so it cannot reach a real coord/DB backend.
vi.mock('../../work-items-release-request', () => ({
  readWorkItemReleaseRequest: vi.fn(() => null),
  resolveWorkItemReleaseRequest: vi.fn(async () => null),
}));

/**
 * release.ts migrated to `getWorkItemCheckpointWithMeta` (it needs `updatedAtMs` for the
 * checkpointed-but-unowned window), but this factory still hand-listed only the OLD
 * `getWorkItemCheckpoint`. A hand-listed factory returns `undefined` for any member it
 * forgot, so the tool crashed on `undefined(...)` for every case that reads a checkpoint:
 * 13 of 17 tests here were red on that alone, across every recorded run since the rename.
 * That is the EXACT failure the work-items mock above is commented to avoid — so this one
 * uses the same partial (importOriginal) form, which cannot silently drop a future member.
 *
 * The `getWorkItemCheckpoint` seam is KEPT as the "what does the checkpoint say" knob, so
 * every mockResolvedValue / mockRejectedValue / toHaveBeenCalledWith below keeps its
 * original meaning; only the return is adapted to the WithMeta shape.
 */
const getWorkItemCheckpoint = vi.fn();
vi.mock('../../work-item-checkpoint', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkItemCheckpointWithMeta: async (...a: unknown[]) => ({
    checkpoint: ((await getWorkItemCheckpoint(...a)) as string | null) ?? null,
    updatedAtMs: null,
  }),
}));
vi.mock('../coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOutbox,
}));
// EI-14883: the open-escalation read is a live coord/PG fold — keep it mocked so these
// unit tests never reach a real backend. Default [] = no open escalation = silent, so
// every pre-existing case above is unaffected.
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

/**
 * A COMPLETE WorkItem with a Partial override seam — never `as never`. The cast form is
 * what makes a fixture go stale invisibly: it stays assignable to any signature, so the
 * day `WorkItem` gains a required field this file still compiles and fails at RUNTIME in
 * a run some unrelated peer's change selected. Typed, that day is a compile error HERE.
 */
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

/** A checkpoint in the exact shape that strands an item — the WI-5895 sentence. */
const BG_CHECKPOINT =
  'Fix implemented + committed. test:affected running in background (bash id bx76day3h) to confirm ' +
  'no other suite depended on the old behavior — will report+complete once it finishes.';
/** An isolated session-local handle: this must trigger without relying on other keywords. */
const SESSION_LOCAL_TASK_HANDLE_CHECKPOINT = 'read task id bf5ryqqze output when it lands. If green -> complete.';
const HISTORICAL_TERMINAL_TASK_CHECKPOINT = [
  'Task ID 0mv2kuyk2ctvxu6p7qd encodes mint time 2026-10-10T15:57:11.666Z.',
  "Current processes:list exact-task read returned state=stranded, exitReason='unaccounted residue no longer present', livePids=null, logPath=null, launchedBy='unknown', workItemId=null.",
  'There is no live process or recorded log to wait on; there is no background job to await.',
  "Rerunnable re-check: processes:list {taskId:'0mv2kuyk2ctvxu6p7qd', live:true, includeEnded:true}.",
].join('\n');
/** A server-side deferred writer is not a session-local process/job. */
const SERVER_SIDE_DEFERRED_WRITER_CHECKPOINT =
  'The applyResultDoorAsync deferred writer may continue in the background after the request times out.';
/** A SQL column mention without a native task handle is ordinary source evidence. */
const SQL_TASK_ID_COLUMN_CHECKPOINT =
  'gcTerminalTasks deleted expired non-release ledger rows with RETURNING task_id only';
/** The CONTROL: a real, substantial checkpoint that cites NO background job. */
const PLAIN_CHECKPOINT =
  'Fix implemented + committed at 7a8371a1caf9. Ran npm run test:file -- swarm.test.ts: 61/61 green. ' +
  'Left: nothing — closing next wake.';

/** Release mock reporting the item WAS held (a real release), or was already free (a no-op). */
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
  outboxM.mockResolvedValue([]);
  listEscalationsM.mockResolvedValue([]);
});

describe('work_items:release — stranding warning (WI-38297)', () => {
  it('warns when the released item\'s checkpoint cites a background job', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    const b = await body({ id: 'WI-5895' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-5895', released: true });
    const w = b.results[0].strandedCheckpointWarning as string;
    expect(w).toBeTypeOf('string');
    expect(w).toMatch(/BACKGROUND JOB/);
    expect(w).toMatch(/EI-16611/);
    // It must tell the releaser what to actually DO, not merely that something is wrong.
    expect(w).toMatch(/work_items:complete/);
    expect(w).toMatch(/blocked/);
    expect(w).toMatch(/cannot prove that the job is still live or owned by this session/);
  });

  it('warns for an isolated session-local task handle', async () => {
    getWorkItemCheckpoint.mockResolvedValue(SESSION_LOCAL_TASK_HANDLE_CHECKPOINT);
    const b = await body({ id: 'WI-TASK-HANDLE' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-TASK-HANDLE', released: true });
    expect(b.results[0].strandedCheckpointWarning).toMatch(/BACKGROUND JOB/);
  });

  it('stays silent for a historical task handle with an exact terminal process-ledger recheck', async () => {
    getWorkItemCheckpoint.mockResolvedValue(HISTORICAL_TERMINAL_TASK_CHECKPOINT);
    const b = await body({ id: 'EI-25634752058895221' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-25634752058895221', released: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('stays silent for a server-side deferred writer that may continue in the background', async () => {
    getWorkItemCheckpoint.mockResolvedValue(SERVER_SIDE_DEFERRED_WRITER_CHECKPOINT);
    const b = await body({ id: 'WI-SERVER-WRITER' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-SERVER-WRITER', released: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('stays silent when a checkpoint names an SQL task_id column without a handle', async () => {
    getWorkItemCheckpoint.mockResolvedValue(SQL_TASK_ID_COLUMN_CHECKPOINT);
    const b = await body({ id: 'WI-SQL-TASK-ID' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-SQL-TASK-ID', released: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('reads the checkpoint under the item\'s own harness + the caller workspace', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    await body({ id: 'WI-5895' });
    expect(getWorkItemCheckpoint).toHaveBeenCalledWith({
      harness: 'papercusp',
      workItemId: 'WI-5895',
      workspaceId: 'ws-1',
    });
  });

  // THE CONTROL. A warning wired to fire on any checkpoint at all would pass the
  // positive test above; only this case can tell the two implementations apart.
  it('stays SILENT for a substantial checkpoint that cites no background job', async () => {
    getWorkItemCheckpoint.mockResolvedValue(PLAIN_CHECKPOINT);
    const b = await body({ id: 'WI-CLEAN' });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
    expect(b.results[0].claimHoldNudge).toMatch(/self-selectable by other agents immediately/);
    expect(b.results[0].claimHoldNudge).toMatch(/claimHold:true/);
    expect(b.results[0].claimHoldNudge).toMatch(/checkpoint remains resume context, not a queue disposition/);
  });

  it('stays silent when the item has no checkpoint at all', async () => {
    getWorkItemCheckpoint.mockResolvedValue(null);
    const b = await body({ id: 'WI-NONE' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  // A release that changed nothing stranded nothing — warning here would be noise on a
  // call that did not create the condition.
  it('stays silent on a NO-OP release (item was already unassigned)', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    releaseReporting({ assignee: null, wasClaimed: false });
    const b = await body({ id: 'WI-NOOP' });
    expect(b.results[0]).toMatchObject({ ok: true, released: false });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
    // and it must not have paid for a checkpoint read it cannot use
    expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('still warns on the claim-hold (durable park) path — a park strands it too', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    const b = await body({ id: 'WI-PARK', claimHold: true, reason: 'parking' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PARK' });
    expect(b.results[0].strandedCheckpointWarning).toMatch(/BACKGROUND JOB/);
    expect(b.results[0].claimHold).toBeDefined();
    expect(b.results[0].claimHoldNudge).toBeUndefined();
  });

  it('explicit claimHold:false is the deliberate re-pool signal and suppresses the nudge', async () => {
    getWorkItemCheckpoint.mockResolvedValue(PLAIN_CHECKPOINT);
    mockResolvedTyped(holdM, { id: 'WI-HANDOFF', harness: 'papercusp', hold: false, applicable: true });
    const b = await body({ id: 'WI-HANDOFF', claimHold: false, reason: 'normal successor handoff' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-HANDOFF', claimHold: false });
    expect(b.results[0].claimHoldNudge).toBeUndefined();
  });

  it('degrades to a normal release (no crash, no warning) when the checkpoint read throws', async () => {
    getWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-PGDOWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PGDOWN', released: true });
    expect(b.results[0].error).toBeUndefined();
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('evaluates each item of a batch independently', async () => {
    getWorkItemCheckpoint.mockImplementation(async ({ workItemId }: { workItemId: string }) =>
      workItemId === 'WI-HOT' ? BG_CHECKPOINT : PLAIN_CHECKPOINT,
    );
    const b = await body({ ids: ['WI-COLD', 'WI-HOT'] });
    expect(b.results[0]).toMatchObject({ id: 'WI-COLD' });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
    expect(b.results[1]).toMatchObject({ id: 'WI-HOT' });
    expect(b.results[1].strandedCheckpointWarning).toMatch(/BACKGROUND JOB/);
  });
});

describe('work_items:release — prior completion assertion warning (EI-20744001855099113)', () => {
  const ITEM = 'EI-20744001855099113';

  it('warns when the released holder asserted this item was complete over coord', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-complete-1',
        ts: '2026-08-20T18:40:00.000Z',
        from: 'me',
        summary: `${ITEM} is COMPLETE — nothing remains; do not rebuild it.`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(outboxM).toHaveBeenCalledWith('me', {}, expect.objectContaining({ enough: expect.any(Function) }));
    expect(b.results[0].completionAssertionWarning).toMatch(/msg-complete-1/);
    expect(b.results[0].completionAssertionWarning).toMatch(/work_items:complete/);
  });

  it('does not treat a completed bounded observation as completion of the referenced item', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'coord-send-63ac7f89f2c165b527963983fccddd74257a663d1f0627cc3bf10b3cbec7c657',
        ts: '2026-10-03T13:31:00.549Z',
        from: 'me',
        summary:
          'WI-10005168 observation is complete; please route the remaining root-cause work through an admitted lane.',
        body:
          'The missing-run blocker cleared; the delay and failure causes remain unknown. Please route any root-cause follow-up through an admitted lane.',
        sections: [
          {
            text:
              'The missing-run blocker cleared; the delay and failure causes remain unknown. Please route any root-cause follow-up through an admitted lane.',
          },
        ],
      } as never,
    ]);

    const b = await body({ id: 'WI-10005168' });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('does not attribute a completed ledger check to a later work-item reference', async () => {
    const releasedItem = 'WI-10008236';
    outboxM.mockResolvedValue([
      {
        msg_id: 'mvob1pt2-0000-530d07575482423aa1518c5bf28dc31d',
        ts: '2026-10-25T20:53:26.630Z',
        from: 'me',
        summary: '💬 su · su-a26de messaged you re WI-10008236',
        body:
          'Thanks for confirming the holds. After your stated current-ledger/decision check is complete, please reply in this thread with (1) the exact served Portal build/runtime identity and route for WI-10008236 if verified, and (2) whether D-215/D-223 still hold EI-25744454665452865. If neither changes, say no change. I will keep both items unchanged until that reply.',
      } as never,
    ]);

    const b = await body({ id: releasedItem });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('does not attribute a closed continuation gate to a later held item reference', async () => {
    const heldItem = 'EI-25808080765499113';
    const messageBody =
      'I understand EI-26230276858390783 is a new instrument change, distinct from EI-25715022243880956. ' +
      'Concrete capacity refusal for this turn: the cold-loop continuation gate is closed at 76% context ' +
      'after I completed one review, and I still hold EI-25808080765499113. I cannot start another independent ' +
      'review before settling. On the next wake I will re-read this item’s pending round and current claim state.';
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-closed-continuation-gate-held-item',
        ts: '2026-10-17T13:23:07.046Z',
        from: 'me',
        summary: 'Capacity refusal this turn; I’ll recheck this distinct S41 review next wake.',
        body: messageBody,
        sections: [{ text: messageBody }],
      } as never,
    ]);

    const b = await body({ id: heldItem });
    expect(outboxM).toHaveBeenCalledWith('me', {}, expect.objectContaining({ enough: expect.any(Function) }));
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('still recognizes explicit item completion after a bounded activity in the same clause', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-item-complete-after-observation',
        ts: '2026-10-03T13:32:00.000Z',
        from: 'me',
        summary: `${ITEM} observation is complete, and ${ITEM} is complete.`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toMatch(/msg-item-complete-after-observation/);
  });

  it('recognizes an explicit structured completion premise for the item', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-complete-structured',
        ts: '2026-08-20T18:41:00.000Z',
        from: 'me',
        sections: [{ text: 'The verification is recorded.', premises: [`${ITEM}#completion`] }],
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toMatch(/msg-complete-structured/);
  });

  it('stays silent when completion belongs to a different item in a scoped consolidation message', async () => {
    const duplicate = 'EI-21201399884691584';
    const canonical = 'EI-21201391254071051';
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-scoped-consolidation',
        ts: '2026-08-23T00:29:10.000Z',
        from: 'me',
        summary:
          `Consolidation is complete: ${duplicate} is dropped; ${canonical} remains canonical and I am releasing that claim now.`,
      } as never,
    ]);

    const b = await body({ id: canonical });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('stays silent when a neighboring item completion shares the same clause', async () => {
    const sibling = 'EI-24732811620490811';
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-neighboring-completion',
        ts: '2026-08-23T00:30:10.000Z',
        from: 'me',
        summary: `${ITEM} remains unresolved and should stay open while the sibling item ${sibling} is done`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('still warns when this item is complete beside an unresolved sibling', async () => {
    const sibling = 'EI-24732811620490811';
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-target-completion-neighbor',
        ts: '2026-08-23T00:31:10.000Z',
        from: 'me',
        summary: `${ITEM} is done while the sibling item ${sibling} remains unresolved and should stay open`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toMatch(/msg-target-completion-neighbor/);
  });

  it('stays silent for negated or still-in-progress completion language', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-not-complete',
        ts: '2026-08-20T18:42:00.000Z',
        from: 'me',
        summary: `${ITEM} is not complete yet; I am still investigating it.`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('stays silent when only another sender asserted completion', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-other-holder',
        ts: '2026-08-20T18:43:00.000Z',
        from: 'peer',
        summary: `${ITEM} is complete.`,
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(outboxM).toHaveBeenCalledWith(
      'me',
      {},
      expect.objectContaining({ enough: expect.any(Function) }),
    );
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  it('degrades to a normal release when the coord read fails', async () => {
    outboxM.mockRejectedValue(new Error('coord db down'));

    const b = await body({ id: ITEM });
    expect(b.results[0]).toMatchObject({ ok: true, id: ITEM, released: true });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  // EI-22067370681761514: a structured `#completion` premise citation is only an
  // assertion when it actually resolved true (or was never resolved at all — the
  // pre-existing conservative fallback). A `premiseStamps` verdict of `broken`
  // means the sender checked at send time and found the item NOT complete — the
  // exact "next admitted item, no edits have started" shape the report named.
  it('stays silent when the structured #completion premise resolved to broken', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-completion-broken',
        ts: '2026-08-20T18:44:00.000Z',
        from: 'me',
        summary: `${ITEM} was newly claimed for the next wake; no edits have started.`,
        sections: [{ text: 'Picking this up next.', premises: [`${ITEM}#completion`] }],
        premiseStamps: [
          { ref: `${ITEM}#completion`, kind: 'work-item-completion', invalidatable: true, status: 'broken' },
        ],
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toBeUndefined();
  });

  // Control for the case above: the SAME structured citation but a `holds` verdict
  // (or no verdict at all) must still fire — the fix reads the resolved status, it
  // does not just go quiet whenever `premiseStamps` happens to be present.
  it('still warns when the structured #completion premise resolved to holds', async () => {
    outboxM.mockResolvedValue([
      {
        msg_id: 'msg-completion-holds',
        ts: '2026-08-20T18:45:00.000Z',
        from: 'me',
        sections: [{ text: 'Verification is recorded.', premises: [`${ITEM}#completion`] }],
        premiseStamps: [
          { ref: `${ITEM}#completion`, kind: 'work-item-completion', invalidatable: true, status: 'holds' },
        ],
      } as never,
    ]);

    const b = await body({ id: ITEM });
    expect(b.results[0].completionAssertionWarning).toMatch(/msg-completion-holds/);
  });
});

/**
 * EI-14883 — the OPEN-ESCALATION disclosure.
 *
 * Observed live on WI-3627 (2026-07-17): the holder did the owner-gated steps correctly
 * (enumerate + coord:escalate), then plain-released with no claimHold and no state change.
 * The row stayed claimable, so scheduler:get_next handed it to the next drive-by fleet
 * member ~2.5h later, who had no new information and could only re-derive "already
 * escalated, awaiting a decision" from the comment thread.
 *
 * FALSIFIABILITY: `escalationNamesItem` and the claimable-state gate are left REAL here
 * (only the coord fold is mocked), so these exercise the actual matcher. The "names a
 * DIFFERENT item" and "already parked needs-human" cases are the permanent CONTROLS —
 * without them, a warning wired to fire on ANY open escalation, or on EVERY release,
 * would pass the positive test just as happily.
 */
describe('work_items:release — open-escalation disclosure (EI-14883)', () => {
  const ITEM = 'WI-3627';
  const escalation = (over: Record<string, unknown> = {}) => ({
    msg_id: 'esc-3627',
    ts: '2026-07-17T14:02:00.000Z',
    from: 'su-b7b40c9b',
    kind: 'escalation',
    severity: 'blocker',
    summary: `${ITEM} needs an owner decision before it can proceed`,
    body: 'Enumerated the options; only the owner can pick one.',
    resolved: null,
    ...over,
  });

  it('warns when a release re-pools an item whose escalation is still open', async () => {
    listEscalationsM.mockResolvedValue([escalation()]);
    const b = await body({ id: ITEM });
    expect(b.results[0]).toMatchObject({ ok: true, id: ITEM, released: true });
    const w = b.results[0].openEscalationWarning as string;
    expect(w).toBeTypeOf('string');
    expect(w).toMatch(/esc-3627/);
    // It must tell the releaser what to DO, and name BOTH durable dispositions.
    expect(w).toMatch(/needs-human/);
    expect(w).toMatch(/claimHold:true/);
    // Machine-readable, so a caller can branch instead of regex-ing the prose.
    expect(b.results[0].openEscalation).toMatchObject({
      msgId: 'esc-3627',
      from: 'su-b7b40c9b',
      severity: 'blocker',
    });
  });

  // THE CONTROL. A warning wired to fire whenever ANY escalation is open would pass the
  // positive case above; only this can tell the two implementations apart.
  it('stays SILENT when the open escalation names a different item', async () => {
    listEscalationsM.mockResolvedValue([
      escalation({ msg_id: 'esc-other', summary: 'WI-9999 needs a decision', body: 'unrelated' }),
    ]);
    const b = await body({ id: ITEM });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
    expect(b.results[0].openEscalation).toBeUndefined();
  });

  // Boundary: a longer id must not be matched by a shorter one that prefixes it.
  it('does not match a different item whose id merely prefixes this one', async () => {
    listEscalationsM.mockResolvedValue([escalation({ summary: 'WI-36271 needs a decision' })]);
    const b = await body({ id: ITEM });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
  });

  // THE SECOND CONTROL, and the whole point of the item: the agent who ALREADY applied
  // the correct durable disposition must not be nagged for having done it right.
  it('stays SILENT when the row was already parked needs-human', async () => {
    listEscalationsM.mockResolvedValue([escalation()]);
    mockImplementationTyped(releaseM, async (id, opts) => {
      opts?.onPriorState?.({ assignee: 'me', wasClaimed: true });
      return wi({ id, assignee: null, state: 'needs-human' });
    });
    const b = await body({ id: ITEM });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
  });

  // The design decision this fix turns on: match ANY open escalation, not just the
  // releasing holder's. Hop 1 escalates and releases; hop 2 claims, re-discovers the same
  // wall, releases. Scoping to the prior holder would go silent for every repeat — which
  // is the part that actually burns turns.
  it('warns on an escalation raised by someone OTHER than the releasing holder', async () => {
    listEscalationsM.mockResolvedValue([escalation({ from: 'su-first-hop' })]);
    identity.ownerId = 'su-second-hop';
    releaseReporting({ assignee: 'su-second-hop', wasClaimed: true });
    const b = await body({ id: ITEM });
    expect(b.results[0].openEscalationWarning).toMatch(/su-first-hop/);
  });

  it('stays silent when the release was not holding a claim', async () => {
    listEscalationsM.mockResolvedValue([escalation()]);
    releaseReporting({ assignee: null, wasClaimed: false });
    const b = await body({ id: ITEM });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
  });

  // claimHold:true IS the durable disposition the warning asks for — do not ask twice.
  it('stays silent when the caller already applied the durable park', async () => {
    listEscalationsM.mockResolvedValue([escalation()]);
    const b = await body({
      id: 'WI-PARK',
      claimHold: true,
      claimHoldRelease: { condition: 'owner decides', trigger: 'coord:escalation-resolved' },
    });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
  });

  it('degrades to a normal release (no crash, no warning) when the escalation read fails', async () => {
    listEscalationsM.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: ITEM });
    expect(b.results[0]).toMatchObject({ ok: true, id: ITEM, released: true });
    expect(b.results[0].openEscalationWarning).toBeUndefined();
  });

  // Release is bulk (up to 200 items) and listEscalations folds the workspace's whole
  // open set, so a per-item read would multiply that by the batch size.
  it('folds the open-escalation set ONCE per call, not once per item', async () => {
    listEscalationsM.mockResolvedValue([escalation()]);
    const b = await body({ ids: [ITEM, 'WI-OTHER', 'WI-THIRD'] });
    expect(b.results).toHaveLength(3);
    expect(listEscalationsM).toHaveBeenCalledTimes(1);
    // ...and it still evaluates each item independently against that one fold.
    expect(b.results[0].openEscalationWarning).toMatch(/esc-3627/);
    expect(b.results[1].openEscalationWarning).toBeUndefined();
    expect(b.results[2].openEscalationWarning).toBeUndefined();
  });
});
