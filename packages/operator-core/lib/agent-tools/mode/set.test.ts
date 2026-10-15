/**
 * mode:set TOOL handler — gui-chat-session-controls-2026-07-25 P-003.
 *
 * Pins the wiring the tool layer is responsible for (the store's own
 * ownerAuthorized semantics are covered in isolation by
 * packages/operator-core/lib/modes/store.test.ts): the admin-UI's synthesized
 * identity (ownerId === ADMIN_COORD_UI_OWNER) must be threaded into
 * setMode()'s callerIsOwnerAuthority, and into refreshControlAnchorAfterMutation's
 * origin/ownerDirected — an ordinary peer must NOT get either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from '../coordination/identity';

const h = vi.hoisted(() => ({
  getSelectedModeDefinitions: vi.fn(),
  // stickyConflict is optional here (not part of the default resolved value) so
  // TS infers a return type wide enough for the sticky-guard-refusal test below
  // (mockResolvedValue({ ..., stickyConflict: true, ... })) without an excess-
  // property error.
  //
  // ⚠ It MUST be optional on the ANNOTATION, never present-but-undefined in the
  // default value. Writing `stickyConflict: undefined as boolean | undefined`
  // inside the returned object states the intent above but achieves the OPPOSITE:
  // the key becomes REQUIRED in the inferred type, so every mockResolvedValue()
  // that omits it is stranded (4 × TS2345, a committed gate red — WI-37470).
  // The optionality here mirrors the real contract: SetModeResult declares
  // `stickyConflict?: boolean` (packages/operator-core/lib/modes/store.ts:85).
  setMode: vi.fn(
    async (
      _opts: unknown,
    ): Promise<{
      ok: boolean;
      mode: { id: string };
      switchedFrom?: string | null;
      noop?: boolean;
      stickyConflict?: boolean;
      // D-003. Optional on the ANNOTATION for the same reason stickyConflict is
      // (see above): present-but-undefined in the default value would make it
      // REQUIRED in the inferred type and strand every fixture that omits it.
      // Declared here rather than cast at the call site so the fixture stays
      // typechecked — an `as never` would silence exactly the check that catches
      // this shape going stale (lint:mock-cast-escape).
      implied?: { mode: string; status: string; by?: string; error?: string }[];
      goalElection?: {
        ownerId: string;
        goalId: string;
        epoch: number;
        predecessorOwnerId: string | null;
        handoffExpiresAt: string | null;
      };
      goalElectionConflict?: {
        goalId: string;
        electedOwnerId: string;
        electedEpoch: number | null;
      };
    }> => ({
      ok: true,
      mode: { id: 'auto' },
      switchedFrom: null,
      noop: false,
    }),
  ),
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ msg_id: 'm-1' })),
  // `state.modes` is what the consumer reads back (WI-10005199); `null` is the
  // fail-soft refresh outcome (bounded timeout / lock failure).
  refreshControlAnchorAfterMutation: vi.fn(
    async (_opts: unknown): Promise<{ generation: number; state?: { modes: string[] } } | null> => ({ generation: 1 }),
  ),
  getLoopStatus: vi.fn(async (_ownerId: string) => null as { active: boolean } | null),
  deactivateLoopForGoal: vi.fn(async (..._args: unknown[]) => false),
  assertFact: vi.fn(async (_input: unknown) => ({ ok: true })),
  retractFact: vi.fn(async (_args: unknown) => true),
  wakeRecipients: vi.fn(
    async (..._args: unknown[]): Promise<{
      woken: number;
      staged: number;
      stagedTargets: string[];
      fanoutCapped: string[];
      timedOutTargets: string[];
    }> => ({
      woken: 0,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    }),
  ),
  // EI-20015592992797890: set.ts reads the INCUMBENT subject before refusing a
  // subject-requiring mode, so this binding must exist on the mock or the named
  // import breaks at module load rather than in a test.
  getModeSubject: vi.fn(async (..._args: unknown[]) => null as string | null),
  getModes: vi.fn(async (..._args: unknown[]) => [] as Array<{ mode: string; subject: string | null }>),
  // P-003: the attach guard reads the target goal's launch settings. Shaped like
  // the real return so `budget: null` can mean "no such goal" — the distinction
  // the guard uses to avoid guessing in its refusal message.
  readGoalLaunchSettings: vi.fn(
    async (..._args: unknown[]) =>
      ({ settings: null, budget: {}, error: null }) as {
        settings: Record<string, unknown> | null;
        budget: Record<string, unknown> | null;
        error: string | null;
      },
  ),
  notifyGoalHolderHandoff: vi.fn(async (..._args: unknown[]) => ({
    predecessorOwnerId: 'su-old',
    successorOwnerId: 'su-new',
    goalId: 'goal-1',
    epoch: 2,
    handoffExpiresAt: null,
    loopDeactivated: true,
    woken: 1,
    staged: 0,
  })),
}));

vi.mock('../../modes/store', () => ({ setMode: h.setMode, getModeSubject: h.getModeSubject, getModes: h.getModes }));
vi.mock('../../agent-identities/source', () => ({
  getSelectedModeDefinitions: h.getSelectedModeDefinitions,
}));
// PARTIAL on purpose: the guard's RULE (goalHolderPolicyProblem) is pure and must
// stay REAL here — mocking it would leave this suite asserting against a stub of
// the very thing it is meant to pin. Only the DB read is replaced.
vi.mock('../../goal-launch-settings', async () => {
  const actual = await vi.importActual<typeof import('../../goal-launch-settings')>(
    '../../goal-launch-settings',
  );
  return { ...actual, readGoalLaunchSettings: h.readGoalLaunchSettings };
});
// Partial mock on purpose: set.ts uses only getLoopStatus from this module, and a real
// import would drag the org-PG client into a unit test.
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: h.getLoopStatus,
  deactivateLoopForGoal: h.deactivateLoopForGoal,
}));
vi.mock('../coordination/messages', () => ({ sendMessage: h.sendMessage }));
// Partial-shaped on purpose, like the loop mock above: set.ts uses exactly these
// three bindings, and the real module opens a PG client at import.
// FACT_BODY_MAX_CHARS is read at MODULE SCOPE (it is interpolated into the
// `instructions` arg description), so omitting it here breaks the import, not a test.
vi.mock('../../agent-facts/store', () => ({
  assertFact: h.assertFact,
  retractFact: h.retractFact,
  FACT_BODY_MAX_CHARS: 1200,
}));
vi.mock('../coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: h.refreshControlAnchorAfterMutation,
}));
vi.mock('../coordination/inbox-wake', () => ({ wakeRecipients: h.wakeRecipients }));
vi.mock('../../goals/holder-handoff', () => ({
  notifyGoalHolderHandoff: h.notifyGoalHolderHandoff,
}));

let currentIdentity: AgentIdentity = {
  ownerId: 'su-me',
  ownerLabel: 'su · me',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};

vi.mock('../coordination/identity', async () => {
  const actual = await vi.importActual<typeof import('../coordination/identity')>('../coordination/identity');
  return {
    ...actual,
    resolveAgentIdentity: () => currentIdentity,
  };
});

import setTool, {
  wakeSourceWarning,
  wakeSourceLostWarning,
  modeInstructionsFactKey,
  renderModeInstructionsFact,
  renderImpliedNote,
} from './set';
import { ADMIN_COORD_UI_OWNER } from '../coordination/identity';
import { modeById } from '../../modes/registry';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (args: Record<string, unknown>) => setTool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => JSON.parse(res.content[0].text);

const ME = 'su-me';
const PEER = 'su-peer';

describe('mode:set registration', () => {
  it('opts out of the ambient workspace transaction for independent control-plane awaits', () => {
    expect((setTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('returns the immutable GRADE scorecard route on the live self-set projection', async () => {
    const body = parse(await run({ mode: 'grade', reason: 'grade the named goal' }));

    expect(body.contract).toContain('scorecards:evaluate { rubricRef }');
    expect(body.contract).toContain('scorecards:emit');
    expect(body.contract).toMatch(/complete per-run or terminal scorecard NEVER goes through improvements:capture/);
    expect(body.contract).not.toMatch(/emits a scorecard\s+\(improvements:capture/);
  });

  it('delivers the scoped GOAL gap-review contract with its goal-day candidate yield', async () => {
    const body = parse(await run({ mode: 'goal', subject: 'goal-1', reason: 'manage goal-local planning' }));
    expect(body.ok).toBe(true);
    const text = String(body.contract).replace(/\s+/g, ' ');
    expect(text.includes('GOAL-LOCAL GAP REVIEW')).toBe(true);
    expect(/Blender.*workspace-level/.test(text)).toBe(true);
    expect(text.includes('Both may originate plans')).toBe(true);
    expect(text.includes('adopt or revise a suitable existing plan')).toBe(true);
    expect(text.includes('goalReview')).toBe(true);
    expect(text.includes('existing-plans-sufficient')).toBe(true);
    expect(/no minimum new-idea or feature count/i.test(text)).toBe(false);
    expect(text.includes('at least one evaluated new candidate per goal per goal-day')).toBe(true);
    expect(text.includes('a review is not a worker claim')).toBe(true);
  });
});

beforeEach(() => {
  h.getSelectedModeDefinitions.mockReset().mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, {
      contract: modeById(id)?.contract ?? '',
      contractRevision: 'definition-' + id,
      sourceRevision: 'source-' + id,
    }])),
  );
  h.setMode.mockClear().mockResolvedValue({ ok: true, mode: { id: 'auto' }, switchedFrom: null, noop: false });
  h.sendMessage.mockClear().mockResolvedValue({ msg_id: 'm-1' });
  // Default: the projection LANDS and reflects the mode just written, so the
  // pre-WI-10005199 tests observe exactly what they always did. The diverging
  // outcomes are exercised in the dedicated describe below.
  h.refreshControlAnchorAfterMutation.mockClear().mockImplementation(async () => {
    const written = h.setMode.mock.calls.at(-1)?.[0] as { modeId: string; enabled: boolean } | undefined;
    return { generation: 1, state: { modes: written?.enabled ? [written.modeId] : [] } };
  });
  h.getLoopStatus.mockClear().mockResolvedValue(null);
  h.deactivateLoopForGoal.mockClear().mockResolvedValue(false);
  h.assertFact.mockClear().mockResolvedValue({ ok: true });
  h.retractFact.mockClear().mockResolvedValue(true);
  h.wakeRecipients.mockClear().mockResolvedValue({
    woken: 0,
    staged: 0,
    stagedTargets: [],
    fanoutCapped: [],
    timedOutTargets: [],
  });
  h.getModeSubject.mockClear().mockResolvedValue(null);
  h.getModes.mockClear().mockResolvedValue([]);
  // Default: the goal exists and HAS declared a policy, so the pre-P-003 tests
  // above observe exactly the behaviour they always did.
  h.readGoalLaunchSettings
    .mockClear()
    .mockResolvedValue({ settings: { holder: { requireLive: true } }, budget: {}, error: null });
});

describe('GOAL holder cannot enter its own verifier mode', () => {
  it.each(['grade', 'test'])('refuses self %s while GOAL is active', async (mode) => {
    h.getModes.mockResolvedValue([{ mode: 'goal', subject: 'goal-1' }]);
    const res = parse(await run({ mode, reason: 'verify my goal' }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('goal_holder_self_verification_refused');
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('allows a separate session to enter TEST', async () => {
    const res = parse(await run({ mode: 'test', reason: 'verify delegated work' }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledWith(expect.objectContaining({ modeId: 'test' }));
  });
});

// WI-10005199 (EI-23770243810745552): `agent_modes` is the write target; the consumer
// reads the PROJECTED `control_state->modes`, and that projection is fail-soft.
describe('mode:set — consumerView on the control-anchor projection', () => {
  it('stays ABSENT when the projected modes reflect the write (exception-only)', async () => {
    const res = parse(await run({ mode: 'auto', reason: 'agreeing projection' }));
    expect(res.ok).toBe(true);
    expect(res.controlGeneration).toBe(1);
    expect(res).not.toHaveProperty('controlConsumerView');
  });

  it('DIVERGES when the fail-soft refresh returned null: ok:true but the consumer sees the OLD modes', async () => {
    h.refreshControlAnchorAfterMutation.mockResolvedValueOnce(null);
    const res = parse(await run({ mode: 'auto', reason: 'timed-out projection' }));
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('controlGeneration');
    expect(res.controlConsumerView).toMatchObject({
      readPath: 'harness_shared.session_briefs.control_state->modes',
      value: { modeId: 'auto', present: null },
      divergedFromWrite: true,
    });
  });

  it('DIVERGES when the projection landed WITHOUT the mode that was written', async () => {
    h.refreshControlAnchorAfterMutation.mockResolvedValueOnce({ generation: 7, state: { modes: ['ideate'] } });
    const res = parse(await run({ mode: 'auto', reason: 'projection lost the mode' }));
    expect(res.controlConsumerView).toMatchObject({ value: { modeId: 'auto', present: false }, divergedFromWrite: true });
  });

  it('DIVERGES when a cleared mode still lingers in the projection', async () => {
    h.refreshControlAnchorAfterMutation.mockResolvedValueOnce({ generation: 8, state: { modes: ['auto'] } });
    const res = parse(await run({ mode: 'auto', enabled: false, reason: 'exit auto' }));
    expect(res.controlConsumerView).toMatchObject({ value: { modeId: 'auto', present: true }, divergedFromWrite: true });
  });

  it('is not attested at all for a store no-op (nothing was written, nothing projected)', async () => {
    h.setMode.mockResolvedValueOnce({ ok: true, mode: { id: 'auto' }, switchedFrom: null, noop: true });
    const res = parse(await run({ mode: 'auto', reason: 're-assert' }));
    expect(h.refreshControlAnchorAfterMutation).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('controlConsumerView');
  });
});

describe('mode:set selected definition delivery', () => {
  it('uses the approved selected bytes and revisions in the self result', async () => {
    h.getSelectedModeDefinitions.mockResolvedValueOnce(new Map([[
      'auto', { contract: 'SELECTED AUTO DEFINITION', contractRevision: 'definition-r2',
        sourceRevision: 'source-r2' },
    ]]));
    const body = parse(await run({ mode: 'auto', reason: 'activate selected source' }));
    expect(body).toMatchObject({
      ok: true, contract: 'SELECTED AUTO DEFINITION',
      definitionRevision: 'definition-r2', sourceRevision: 'source-r2',
    });
    expect(h.getSelectedModeDefinitions).toHaveBeenCalledExactlyOnceWith(['auto']);
  });

  it('delivers the same selected definition to a peer', async () => {
    h.getSelectedModeDefinitions.mockResolvedValueOnce(new Map([[
      'auto', { contract: 'SELECTED PEER AUTO', contractRevision: 'definition-r3',
        sourceRevision: 'source-r3' },
    ]]));
    await run({ mode: 'auto', agent: PEER, reason: 'peer posture change' });
    const body = (h.sendMessage.mock.calls[0]![1] as { body: string }).body;
    expect(body).toContain('SELECTED PEER AUTO');
    expect(body).toContain('source-r3');
    expect(body).not.toContain(modeById('auto')!.contract.slice(0, 60));
  });

  it('refuses stale selected content before any mode write or peer message', async () => {
    h.getSelectedModeDefinitions.mockRejectedValueOnce(new Error('approval changed'));
    const body = parse(await run({ mode: 'auto', agent: PEER, reason: 'must not apply stale mode' }));
    expect(body).toMatchObject({ ok: false, error: 'selected-mode-definition-unavailable',
      detail: 'approval changed' });
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('preflights the registry implication closure in one selected read', async () => {
    await run({ mode: 'goal', subject: 'goal-1', reason: 'own goal' });
    expect(h.getSelectedModeDefinitions).toHaveBeenCalledExactlyOnceWith(['goal', 'auto', 'ideate']);
  });
});

/* ── a subject-requiring mode cannot be entered unattributed (EI-20015592992797890)
   `agent_modes.subject` is what every downstream consumer joins on:
   work_items._create-core stamps `work_items.goal_id` FROM it, and the goal stop
   attributes sessions BY it. An unset subject therefore does not error — it
   silently zeroes BOTH while every surface still reads healthy. That is what was
   measured live: ONE mode='goal' row, subject NULL, and a stop mechanism that was
   built, wired, green and inert.

   goals:start and goals:create both stamp it (rolling back / reporting when they
   cannot). This tool was the one door that admitted `goal` with no way to supply
   one — so the guard belongs HERE, and it is anchored on ModeDef.requiresSubject
   rather than on the id 'goal', so the next subject-requiring mode is covered
   without anyone remembering to widen a string match. ── */
describe('mode:set — a subject-requiring mode must resolve a subject', () => {
  it('REFUSES goal mode with no subject supplied and none incumbent', async () => {
    const res = parse(await run({ mode: 'goal', reason: 'own the outcome' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/requires a subject/);
    // The refusal must name the way OUT, not just the problem.
    expect(res.fix).toMatch(/goals:start/);
    // and must not have written anything
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('ACCEPTS goal mode when the subject is supplied, and threads it to the store', async () => {
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-abc' }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledTimes(1);
    expect(h.setMode.mock.calls[0][0]).toMatchObject({ modeId: 'goal', subject: 'goal-abc' });
  });

  it('delivers the elected-holder stand-down transition to the predecessor', async () => {
    h.setMode.mockResolvedValueOnce({
      ok: true,
      mode: { id: 'goal' },
      goalElection: {
        ownerId: ME,
        goalId: 'goal-declared',
        epoch: 2,
        predecessorOwnerId: PEER,
        handoffExpiresAt: '2026-08-30T08:00:00.000Z',
      },
    });
    const res = parse(await run({ mode: 'goal', reason: 'take over', subject: 'goal-declared' }));

    expect(h.notifyGoalHolderHandoff).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ predecessorOwnerId: PEER, ownerId: ME, epoch: 2 }),
    );
    expect(res.goalHandoffNotice).toMatchObject({ loopDeactivated: true, woken: 1 });
  });

  it('ACCEPTS a reason-only re-registration when a subject is already incumbent, and PRESERVES it', async () => {
    h.getModeSubject.mockResolvedValue('goal-existing');
    const res = parse(await run({ mode: 'goal', reason: 're-registering after compaction' }));
    expect(res.ok).toBe(true);
    // Tri-state: `subject` must be ABSENT, not null — passing null would CLEAR
    // the incumbent, re-creating the unattributed row this guard exists to stop.
    expect(h.setMode.mock.calls[0][0]).not.toHaveProperty('subject');
  });

  it('fails CLOSED when the incumbent read throws', async () => {
    h.getModeSubject.mockRejectedValue(new Error('pg down'));
    const res = parse(await run({ mode: 'goal', reason: 'own it' }));
    expect(res.ok).toBe(false);
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('does NOT gate EXITING the mode — you can always leave', async () => {
    const res = parse(await run({ mode: 'goal', reason: 'done', enabled: false }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledTimes(1);
  });

  it('clearing GOAL deactivates only the loop tied to the surrendered subject', async () => {
    h.getModeSubject.mockResolvedValue('goal-123');
    h.deactivateLoopForGoal.mockResolvedValue(true);

    const res = parse(await run({ mode: 'goal', reason: 'authority transferred', enabled: false }));

    expect(h.deactivateLoopForGoal).toHaveBeenCalledWith(
      ME,
      'goal-123',
      expect.objectContaining({
        actor: ME,
        reason: expect.stringContaining("authority 'goal-123' revoked"),
      }),
    );
    expect(res).toMatchObject({ ok: true, goalLoopDeactivated: true });
  });

  it('does not deactivate a loop when the GOAL clear is a store no-op', async () => {
    h.getModeSubject.mockResolvedValue('goal-123');
    h.setMode.mockResolvedValue({ ok: true, mode: { id: 'goal' }, noop: true });

    const res = parse(await run({ mode: 'goal', reason: 'already cleared', enabled: false }));

    expect(res).toMatchObject({ ok: true, noop: true });
    expect(h.deactivateLoopForGoal).not.toHaveBeenCalled();
  });

  /* CONTROL. Without this, every assertion above would still pass if the guard
     rejected EVERY mode — the check would look strict while actually being
     broken, and the suite could not tell the difference. */
  it('CONTROL: a mode that requires no subject is unaffected', async () => {
    const res = parse(await run({ mode: 'auto', reason: 'act, do not ask' }));
    expect(res.ok).toBe(true);
    expect(h.getModeSubject).not.toHaveBeenCalled();
    expect(h.setMode.mock.calls[0][0]).not.toHaveProperty('subject');
  });
});

/* ── ATTACHING to a goal requires that goal to have declared a holder policy
   (goal-live-holder-guarantee-2026-08-18 P-003, D-008) ───────────────────────
   `goals:create` / `goals:start` cover goals born after P-003. This door covers
   the ones that already exist — measured 2026-08-19, all 18 of them, none
   carrying a holder key. Attaching is the moment somebody takes responsibility
   for HOLDING the goal, which is why the question is asked here and not on
   every mode:set. ── */
describe('mode:set — attaching to a goal requires a declared holder policy', () => {
  it('REFUSES attaching to a goal that declares nothing, and writes nothing', async () => {
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: {}, error: null });
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-undeclared' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/holder policy/i);
    // The refusal must name the way OUT, and that way must be the MERGING door:
    // pointing at launchSettings would tell the reader to clobber their ceilings.
    expect(res.fix).toMatch(/goals:update/);
    expect(res.fix).toMatch(/requireLive/);
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('ACCEPTS attaching to a goal that opted OUT explicitly', async () => {
    h.readGoalLaunchSettings.mockResolvedValue({
      settings: { holder: { requireLive: false } },
      budget: {},
      error: null,
    });
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-optout' }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledTimes(1);
  });

  /* THE LOAD-BEARING CASE. The subject guard's own comment records why: a
     reason-only re-registration must keep working. Every live GOAL-mode agent
     today holds an UNDECLARED goal, so a guard that fired on those would not be
     a declaration gate — it would be an outage, refusing exactly the sessions
     that are already doing the work. */
  it('does NOT refuse a re-registration of an ALREADY-attached session, even undeclared', async () => {
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: {}, error: null });
    h.getModeSubject.mockResolvedValue('goal-existing');
    const res = parse(await run({ mode: 'goal', reason: 're-registering after compaction' }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledTimes(1);
  });

  it('does NOT refuse re-asserting the SAME subject a session already holds', async () => {
    // Passing the subject explicitly is still a re-registration, not an attach.
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: {}, error: null });
    h.getModeSubject.mockResolvedValue('goal-existing');
    const res = parse(await run({ mode: 'goal', reason: 'refresh', subject: 'goal-existing' }));
    expect(res.ok).toBe(true);
    expect(h.setMode).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a SWITCH to a different, undeclared goal', async () => {
    // The complement of the two cases above: same session, different subject, so
    // it IS an attach and the question has to be answered.
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: {}, error: null });
    h.getModeSubject.mockResolvedValue('goal-existing');
    const res = parse(await run({ mode: 'goal', reason: 'switching', subject: 'goal-other' }));
    expect(res.ok).toBe(false);
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the goal read errors — an unreadable goal is not an admitted one', async () => {
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: null, error: 'pg down' });
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-x' }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/pg down/);
    expect(h.setMode).not.toHaveBeenCalled();
  });

  it('says NO SUCH GOAL rather than blaming the policy when the goal does not exist', async () => {
    // budget:null with no error is the "zero rows" signal. Without this branch
    // the guard would tell a caller to declare a policy on a goal that is not
    // there — a refusal that sends them to fix the wrong thing.
    h.readGoalLaunchSettings.mockResolvedValue({ settings: null, budget: null, error: null });
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-ghost' }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no goal 'goal-ghost' exists/);
  });

  /* CONTROL. Without it, every refusal above still passes if the guard refused
     EVERY goal attach — including declared ones — and the suite could not tell. */
  it('CONTROL: attaching to a DECLARED goal is admitted and threads the subject', async () => {
    const res = parse(await run({ mode: 'goal', reason: 'own it', subject: 'goal-declared' }));
    expect(res.ok).toBe(true);
    expect(h.setMode.mock.calls[0][0]).toMatchObject({ modeId: 'goal', subject: 'goal-declared' });
  });

  it('CONTROL: a non-goal mode never reads goal launch settings', async () => {
    await run({ mode: 'auto', reason: 'act, do not ask' });
    expect(h.readGoalLaunchSettings).not.toHaveBeenCalled();
  });
});

/* ── `instructions`: scope that outlives its delivery (plan D-002) ────────────
   [owner 2026-08-09] "the drain mode should have an input box where you can type
   in instructions for the drain… e.g. all bugs except the ones related to the
   p2p features."

   The message is the PUSH; the standing fact is the DURABILITY. A drain runs for
   hours across several compactions, and a reason delivered once is gone by the
   second — which is exactly how a scope instruction stops being obeyed while the
   mode still reads ON. ── */
describe('mode:set — instructions become a standing fact', () => {
  const DRAIN_KEY = 'mode-instructions:drain';
  const SCOPE = 'all bugs except the ones related to the p2p features';

  it('renders the operative clause FIRST, provenance last', () => {
    const body = renderModeInstructionsFact({
      modeId: 'drain',
      instructions: SCOPE,
      ownerDirected: true,
      setBy: 'su-admin',
    });
    // The store hard-clips the body, and the caller's instruction can be longer
    // than every other part combined — so the ordering is load-bearing, not
    // style. Clipping the provenance tail costs an anchor; clipping the
    // instruction would silently change what the agent is told to do.
    expect(body.indexOf(SCOPE)).toBeLessThan(body.indexOf('set by'));
    expect(body).toContain('obey this verbatim');
    expect(modeInstructionsFactKey('drain')).toBe(DRAIN_KEY);
  });

  it('asserts the fact on the TARGET, keyed per mode', async () => {
    const res = parse(
      await run({ mode: 'drain', reason: 'owner scoped a drain', instructions: SCOPE, agent: PEER }),
    );
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact.mock.calls[0][0]).toMatchObject({
      scope: 'owner',
      scopeRef: PEER,
      key: DRAIN_KEY,
    });
    expect((h.assertFact.mock.calls[0][0] as { body: string }).body).toContain(SCOPE);
    expect(res).toMatchObject({ instructionsFact: 'asserted', instructionsFactKey: DRAIN_KEY });
  });

  it('also delivers the scope in the message — the fact is durability, not delivery', async () => {
    await run({ mode: 'drain', reason: 'owner scoped a drain', instructions: SCOPE, agent: PEER });
    const body = (h.sendMessage.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain(SCOPE);
    expect(body).toContain('obey verbatim');
  });

  /* Turning the mode off must clear the instruction. D-002 is explicit that a
     stale standing instruction delivered verbatim on every wake is WORSE than
     none — the agent keeps scoping a drain that is no longer running. */
  it('retracts on disable, with no instructions argument needed', async () => {
    const res = parse(await run({ mode: 'drain', reason: 'owner stopped the drain', enabled: false, agent: PEER }));
    expect(h.retractFact).toHaveBeenCalledTimes(1);
    expect(h.retractFact.mock.calls[0][0]).toMatchObject({ scope: 'owner', scopeRef: PEER, key: DRAIN_KEY });
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(res).toMatchObject({ instructionsFact: 'retracted' });
  });

  /* OMITTED and EMPTY are different on purpose. A caller that predates this
     field must not silently wipe a standing instruction; an owner who empties
     the box must not silently inherit last week's exclusions. */
  it('OMITTED leaves a standing instruction alone', async () => {
    const res = parse(await run({ mode: 'drain', reason: 'owner restarted the drain', agent: PEER }));
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.retractFact).not.toHaveBeenCalled();
    expect(res.instructionsFact).toBeUndefined();
  });

  it('EMPTY clears it', async () => {
    await run({ mode: 'drain', reason: 'owner started an unscoped drain', instructions: '   ', agent: PEER });
    expect(h.retractFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact).not.toHaveBeenCalled();
  });

  /* Deliberately NOT gated on `!noop`: re-scoping a RUNNING drain is a no-op
     mode-wise and is exactly the case that must still rewrite the fact. */
  it('re-scopes a drain that is already running (a mode-level no-op)', async () => {
    h.setMode.mockResolvedValue({ ok: true, mode: { id: 'drain' }, switchedFrom: null, noop: true });
    await run({ mode: 'drain', reason: 'owner re-scoped', instructions: 'only p2p bugs', agent: PEER });
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect((h.assertFact.mock.calls[0][0] as { body: string }).body).toContain('only p2p bugs');
  });

  /* A refused write must leave NO standing instruction for a mode change that
     never applied — the race a client-side pair of calls cannot close. */
  it('writes nothing when the owner-sticky guard refuses', async () => {
    h.setMode.mockResolvedValue({ ok: false, stickyConflict: true, mode: { id: 'drain' }, noop: false });
    const res = parse(
      await run({ mode: 'drain', reason: 'peer tried to re-scope', instructions: SCOPE, agent: PEER }),
    );
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.retractFact).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, stickyConflict: true });
  });

  /* Fail-soft, like the delivery beside it: the mode change is already applied
     and audited, so a facts hiccup must not fail a write that landed — but it
     is REPORTED, because the instruction is now push-only and will not survive
     the agent's next compaction. */
  it('a facts failure degrades the change instead of failing it', async () => {
    // EI-19952118814692217: the catch now LOGS the cause (see the dedicated test
    // below) — this suite runs fail-on-console, so a degrade-path test that
    // triggers a real warn must spy+suppress it explicitly or the harness itself
    // fails the test on the unexpected console call.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.assertFact.mockRejectedValue(new Error('pg down'));
    const res = parse(
      await run({ mode: 'drain', reason: 'owner scoped a drain', instructions: SCOPE, agent: PEER }),
    );
    expect(res).toMatchObject({ ok: true, instructionsFact: 'failed' });
    warn.mockRestore();
  });

  /* EI-19952118814692217: the catch used to be bare (`catch {}`) — the error was
     discarded entirely, so a broken assert was undiagnosable from logs even though
     every downstream signal (the mode write, the UI, the peer wake) still reported
     success. This pins that the cause is now surfaced instead of swallowed. */
  it('a facts failure is LOGGED, not silently swallowed', async () => {
    // Not `toHaveBeenCalledTimes(1)`: this suite's fail-on-console harness keeps
    // console.warn spied file-wide, so an already-spied mock's call history can
    // carry residue across `it()` blocks depending on spy-nesting order — the
    // count itself is not the contract. What matters is that OUR call landed
    // with the right content, which the slice-since-`before` isolates.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = warn.mock.calls.length;
    h.assertFact.mockRejectedValue(new Error('UNDEFINED_VALUE: Undefined values are not allowed'));
    await run({ mode: 'drain', reason: 'owner scoped a drain', instructions: SCOPE, agent: PEER });
    const calls = warn.mock.calls.slice(before);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const logged = calls.map((c) => c.join(' ')).join(' | ');
    expect(logged).toContain('drain');
    expect(logged).toContain('UNDEFINED_VALUE');
    warn.mockRestore();
  });
});

/**
 * WI-6949 — the wake-source guard. An autonomy mode is an AUTHORIZATION posture, not a
 * wake source; registering one with no armed loop leaves the agent running only for as
 * long as an interactive owner keeps replying, and silently inert the moment they stop.
 */
describe('wakeSourceLostWarning (pure) — WI-7302 part 2', () => {
  const lost = (o: Partial<Parameters<typeof wakeSourceLostWarning>[0]>) =>
    wakeSourceLostWarning({ modes: ['auto'], wakeSource: 'none', ...o });

  it('warns when an autonomy mode is registered and nothing will wake the session', () => {
    const msg = lost({});
    expect(msg).toContain('WAKE SOURCE GONE');
    expect(msg).toContain('loop:arm'); // the remedy, callable, not alluded to
  });

  it('gives a valid mode:set shape for exiting the stranded mode', () => {
    const msg = lost({});
    expect(msg).toContain("mode:set { mode: '<active mode>', enabled: false, reason: '<why>' }");
    expect(msg).not.toContain('mode:set { enabled: false }');
  });

  it('does NOT warn a session correctly parked on an events:await', () => {
    // THE false-alarm case, and the reason this keys on wakeSource rather than
    // on !loop.active. A member parked on `events:await { work-item:claimable }`
    // has NO armed loop and is still perfectly wakeable — and the member
    // contract explicitly PRESCRIBES that park. A loop-only predicate would
    // fire hardest at sanctioned behaviour, which is worse than not warning.
    expect(lost({ wakeSource: 'event' })).toBeNull();
  });

  it('does NOT warn when a loop is armed', () => {
    expect(lost({ wakeSource: 'loop' })).toBeNull();
  });

  it('does NOT warn a session in no autonomy mode — it never claimed to self-run', () => {
    // An interactive session with no loop is the NORMAL, correct case.
    expect(lost({ modes: [] })).toBeNull();
    expect(lost({ modes: ['ideate'] })).toBeNull(); // orthogonal axis, not autonomy
  });

  it('fires for cold-auto and drain, not just auto', () => {
    expect(lost({ modes: ['cold-auto'] })).toContain('WAKE SOURCE GONE');
    expect(lost({ modes: ['drain'] })).toContain('WAKE SOURCE GONE');
    // …and names which posture is stranded, so the reader knows what to fix.
    expect(lost({ modes: ['drain'] })).toContain('drain');
  });

  it('stays SILENT when the wake-source leg was not resolved (UNKNOWN)', () => {
    // A degraded query must never be able to tell a healthy AUTO session that
    // it is about to die. Absent is unknown, and unknown is not 'none'.
    expect(lost({ wakeSource: undefined })).toBeNull();
  });
});

describe('wakeSourceWarning (pure)', () => {
  const warn = (o: Partial<Parameters<typeof wakeSourceWarning>[0]>) =>
    wakeSourceWarning({ modeId: 'auto', axis: 'autonomy', enabled: true, loopActive: false, ...o });

  it('warns when an autonomy mode is entered with no armed loop', () => {
    const msg = warn({});
    expect(msg).toContain('NO WAKE SOURCE');
    // The remedy must be spelled out as a callable, not alluded to.
    expect(msg).toContain('loop:arm');
  });

  it('stays silent when a loop is already armed — the agent has a real wake source', () => {
    expect(warn({ loopActive: true })).toBeNull();
  });

  it('stays silent when EXITING a mode (enabled:false), which removes no wake source', () => {
    expect(warn({ enabled: false })).toBeNull();
  });

  it('covers cold-auto (same autonomy axis)', () => {
    expect(warn({ modeId: 'cold-auto' })).toContain('NO WAKE SOURCE');
  });

  it('covers drain, an OVERLAY-axis mode that nonetheless implies auto', () => {
    expect(warn({ modeId: 'drain', axis: 'overlay' })).toContain('NO WAKE SOURCE');
  });

  it('fires only for overlays that imply autonomy (grade) and stays silent for ideate', () => {
    expect(warn({ modeId: 'ideate', axis: 'overlay' })).toBeNull();
    expect(warn({ modeId: 'grade', axis: 'overlay' })).toContain('NO WAKE SOURCE');
  });
});

describe('mode:set handler — wake-source guard wiring', () => {
  beforeEach(() => {
    currentIdentity = { ownerId: ME, ownerLabel: 'su · me', source: 'omp-hook-session', workspaceId: 'default', userId: null };
  });

  it('self-set auto with no loop returns the warning in the payload', async () => {
    h.getLoopStatus.mockResolvedValue(null);
    const body = parse(await run({ mode: 'auto', reason: 'go', ownerDirected: true }));
    expect(body.wakeSource).toBe('owner-only');
    expect(body.wakeSourceWarning).toContain('loop:arm');
  });

  it('self-set auto with a loop already armed returns no warning', async () => {
    h.getLoopStatus.mockResolvedValue({ active: true });
    const body = parse(await run({ mode: 'auto', reason: 'go', ownerDirected: true }));
    expect(body.wakeSourceWarning).toBeUndefined();
    expect(body.wakeSource).toBeUndefined();
  });

  it('reads the TARGET\'s loop on a peer-set, not the caller\'s — the target is who goes inert', async () => {
    currentIdentity = { ownerId: PEER, ownerLabel: 'su · peer', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    await run({ mode: 'auto', reason: 'you drive', agent: ME });
    expect(h.getLoopStatus).toHaveBeenCalledWith(ME);
  });

  it('appends the warning to the coord message a peer-set delivers, so the target sees it too', async () => {
    currentIdentity = { ownerId: PEER, ownerLabel: 'su · peer', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    h.getLoopStatus.mockResolvedValue(null);
    await run({ mode: 'auto', reason: 'you drive', agent: ME });
    const [, sendOpts] = h.sendMessage.mock.calls[0] as [unknown, Record<string, string>];
    expect(sendOpts.body).toContain('NO WAKE SOURCE');
  });

  it('is FAIL-SOFT: a loop-read failure suppresses the advisory but never fails the mode change', async () => {
    h.getLoopStatus.mockRejectedValue(new Error('pg down'));
    const body = parse(await run({ mode: 'auto', reason: 'go' }));
    expect(body.ok).toBe(true);
    expect(body.wakeSourceWarning).toBeUndefined();
  });

  it('does not even read the loop when the mode change was a no-op', async () => {
    h.setMode.mockResolvedValue({ ok: true, mode: { id: 'auto' }, switchedFrom: null, noop: true });
    await run({ mode: 'auto', reason: 'already on' });
    expect(h.getLoopStatus).not.toHaveBeenCalled();
  });
});

describe('mode:set handler — callerIsOwnerAuthority wiring', () => {
  it('self-set: callerIsOwnerAuthority is NOT set (ownerAuthorized is implied by isSelf in the store)', async () => {
    currentIdentity = { ownerId: ME, ownerLabel: 'su · me', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    await run({ mode: 'auto', reason: 'self', ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(ME);
    expect(opts.ownerId).toBe(ME);
    expect(opts.callerIsOwnerAuthority).toBe(false);
  });

  it("admin-UI peer-set (ownerId === ADMIN_COORD_UI_OWNER) passes callerIsOwnerAuthority:true to setMode", async () => {
    currentIdentity = {
      ownerId: ADMIN_COORD_UI_OWNER,
      ownerLabel: 'admin-coord-ui',
      source: 'static-client',
      workspaceId: 'default',
      userId: null,
    };
    const res = await run({ mode: 'auto', reason: 'owner clicked Autonomy: auto', agent: ME, ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(ADMIN_COORD_UI_OWNER);
    expect(opts.ownerId).toBe(ME);
    expect(opts.ownerDirected).toBe(true);
    expect(opts.callerIsOwnerAuthority).toBe(true);

    // The control-anchor refresh is stamped 'owner' origin + ownerDirected:true —
    // an admin-UI-driven posture change reads as owner-originated, not agent-originated.
    expect(h.refreshControlAnchorAfterMutation).toHaveBeenCalledTimes(1);
    const anchorOpts = h.refreshControlAnchorAfterMutation.mock.calls[0][0] as Record<string, unknown>;
    expect(anchorOpts.origin).toBe('owner');
    expect(anchorOpts.ownerDirected).toBe(true);

    const body = parse(res);
    expect(body.ok).toBe(true);
  });

  it('ordinary peer-set (not the admin-UI identity) does NOT get callerIsOwnerAuthority, even claiming ownerDirected:true', async () => {
    currentIdentity = { ownerId: PEER, ownerLabel: 'su · peer', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    await run({ mode: 'auto', reason: 'peer claims owner authority', agent: ME, ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(PEER);
    expect(opts.callerIsOwnerAuthority).toBe(false);

    // Not owner-authorized ⇒ the control-anchor refresh stays agent-originated.
    const anchorOpts = h.refreshControlAnchorAfterMutation.mock.calls[0][0] as Record<string, unknown>;
    expect(anchorOpts.origin).toBe('agent');
    expect(anchorOpts.ownerDirected).toBe(false);
  });

  it('admin-UI peer-set is delivered to the target as a coord message (peer-set delivery path still fires)', async () => {
    currentIdentity = {
      ownerId: ADMIN_COORD_UI_OWNER,
      ownerLabel: 'admin-coord-ui',
      source: 'static-client',
      workspaceId: 'default',
      userId: null,
    };
    await run({ mode: 'auto', reason: 'owner toggled autonomy', agent: ME, ownerDirected: true });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [, sendOpts] = h.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(sendOpts.to).toEqual([ME]);
  });
});

describe('mode:set handler — wake outcome reporting', () => {
  beforeEach(() => {
    currentIdentity = { ownerId: PEER, ownerLabel: 'su · peer', source: 'omp-hook-session', workspaceId: 'default', userId: null };
  });

  it('reports a fired wake alongside the durable mode result', async () => {
    h.wakeRecipients.mockResolvedValueOnce({
      woken: 1,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    });

    const body = parse(await run({ mode: 'auto', reason: 'wake peer', agent: ME }));

    expect(body.ok).toBe(true);
    expect(body.wake).toEqual({ woken: 1, staged: 0 });
    expect(h.wakeRecipients).toHaveBeenCalledWith(
      [ME],
      expect.objectContaining({ source: 'mode:set' }),
    );
  });

  it('names a staged target so manual wake-mode is not mistaken for delivery', async () => {
    h.wakeRecipients.mockResolvedValueOnce({
      woken: 0,
      staged: 1,
      stagedTargets: [ME],
      fanoutCapped: [],
      timedOutTargets: [],
    });

    const body = parse(await run({ mode: 'auto', reason: 'wake paused peer', agent: ME }));

    expect(body.wake).toEqual({ woken: 0, staged: 1, stagedTargets: [ME] });
  });

  it('reports a wake failure without failing the already-applied mode change', async () => {
    h.wakeRecipients.mockRejectedValueOnce(new Error('await store unavailable'));

    const body = parse(await run({ mode: 'auto', reason: 'wake peer', agent: ME }));

    expect(body.ok).toBe(true);
    expect(body.wake).toEqual({ failed: true });
  });
});

/**
 * REPORTING THE CASCADE (D-003).
 *
 * The store writes the implied rows; this layer's job is making them VISIBLE.
 * An agent that cannot see it entered AUTO will still write "should I proceed?",
 * which is the behaviour the implication exists to remove — so an unreported
 * cascade is only half the fix.
 */
describe('implied-mode reporting', () => {
  it('states the resulting posture, and distinguishes axis-held from already-on', () => {
    const note = renderImpliedNote('goal', [
      { mode: 'auto', status: 'axis-held', by: 'cold-auto' },
      { mode: 'ideate', status: 'set' },
    ]);
    expect(note).toContain("'goal' IMPLIES auto + ideate");
    // the distinction that matters: telling an agent in cold-auto that "auto is
    // already on" would be telling it something false.
    expect(note).toContain("'cold-auto' already holds that axis");
    expect(note).toContain('You now hold: goal, ideate');
    expect(note).not.toContain('auto,'); // auto is NOT among what it holds
  });

  it('flags a partial posture loudly and names the repair', () => {
    const note = renderImpliedNote('goal', [
      { mode: 'auto', status: 'failed', error: 'deadlock detected' },
      { mode: 'ideate', status: 'set' },
    ])!;
    expect(note).toContain('FAILED: deadlock detected');
    expect(note).toContain('re-run mode:set to repair it');
  });

  it('renders nothing for a mode that implies nothing', () => {
    expect(renderImpliedNote('grade', [])).toBeNull();
  });

  it('returns the CONTRACTS of newly-entered modes on a self-set — they bind immediately', async () => {
    h.setMode.mockResolvedValueOnce({
      ok: true,
      mode: { id: 'goal' },
      implied: [
        { mode: 'auto', status: 'set' },
        { mode: 'ideate', status: 'already-on' },
      ],
    });
    const out = parse(await run({ mode: 'goal', reason: 'owns g-1', subject: 'g-1' }));
    expect(out.implied).toHaveLength(2);
    expect(out.impliedNote).toContain('IMPLIES auto + ideate');
    // ONLY the newly-entered one: the agent has already read the other's rules.
    expect(Object.keys(out.impliedContracts)).toEqual(['auto']);
    expect(out.impliedContracts.auto).toContain('AUTO mode');
  });
});

describe("EI-22179589084262757 — a '*' session must not stamp the wildcard on stored rows", () => {
  // `ident.workspaceId` is `'*'` for a superuser session that chose no workspace
  // (_mcp-handler's `workspaceId || '*'`). `'*'` is a READ-scoping sentinel and is never
  // storable: a row carrying it is invisible to every concrete-workspace read. The old
  // `ident.workspaceId ?? 'default'` let it through because '*' is TRUTHY.
  // MEASURED 2026-09-02 before the fix: harness_shared.agent_modes held 95 rows under
  // '*' across 48 distinct owners — 48 agents whose registered mode no concrete read
  // could see, i.e. "a registered mode survives compaction" failing silently.
  it('resolves the mode row AND its instructions fact to the same CONCRETE workspace', async () => {
    currentIdentity = {
      ownerId: ME,
      ownerLabel: 'su · me',
      source: 'omp-hook-session',
      workspaceId: '*',
      userId: null,
    };
    await run({ mode: 'auto', reason: 'go', instructions: 'keep going' });

    // Assert the calls HAPPENED before reading them. `calls[0]?.[0]` is undefined when
    // the write never occurred, and `expect(undefined).not.toBe('*')` passes vacuously —
    // a test that proves nothing while looking green is the exact failure class this
    // whole work-item is about.
    expect(h.setMode).toHaveBeenCalledTimes(1);
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    const modeWs = h.setMode.mock.calls[0]![0] as { workspaceId?: string };
    const factWs = h.assertFact.mock.calls[0]![0] as { workspaceId?: string };

    // A concrete, non-empty id — not '*', and not absent.
    expect(typeof modeWs.workspaceId).toBe('string');
    expect(modeWs.workspaceId).not.toBe('*');
    expect(modeWs.workspaceId).not.toBe('');
    expect(factWs.workspaceId).not.toBe('*');
    // The SAME value on both: fixing only one write would split a session's mode row
    // from its instructions across two workspaces — worse than consistently wrong.
    expect(factWs.workspaceId).toBe(modeWs.workspaceId);
  });

  it('CONTROL — the old expression really did pass the wildcard through', () => {
    // Kept permanently so the assertion above is demonstrably load-bearing rather than
    // passing for some unrelated reason.
    const oldForm = (ws: string | null | undefined) => ws ?? 'default';
    expect(oldForm('*')).toBe('*'); // truthy, so `??` never fires — the whole bug
    expect(resolveConcreteWorkspaceId('*')).not.toBe('*');
  });
});
