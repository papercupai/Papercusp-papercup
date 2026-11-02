/**
 * Goal-context resolution + launch-time inheritance
 * (goal-mode-hardening-2026-08-10 P-002, D-008) over a mock sql seam (no PG).
 *
 * The invariant these tests exist to pin is NOT "the resolver returns a string".
 * It is that goal PROVENANCE and GOAL MODE are separable: a descendant must
 * attribute its work to the goal while never becoming the goal's agent. A
 * regression that re-fused them would still pass a naive "does goal_id stamp?"
 * test, because stamping is precisely what a wrongly-inherited mode row also
 * achieves — so the mode-row assertion below is the load-bearing one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  assertGoalHolderMutationAuthority,
  resolveGoalContext,
  getInheritedGoalContext,
  setInheritedGoalContext,
  stampPlanGoalProvenance,
  enrollGoalAuthoredPlanOnWorklist,
  goalWorklistRef,
} from './goal-context';
import { readGoalHolderAuthority } from '../goals/holder';
import { goalIdFromModes, isGoalSessionModes, GOAL_MODE } from './goal-session';
import { modeById, axisKeyFor } from './registry';

interface ModeRow {
  workspace_id: string;
  owner_id: string;
  axis_key: string;
  mode: string;
  subject: string | null;
  goal_lease_epoch?: number | null;
  goal_handoff_from_owner_id?: string | null;
  goal_handoff_expires_at?: string | null;
  set_at?: string;
}

/**
 * In-memory agent_modes + session_briefs behind a postgres.js-shaped tagged
 * template, matching the mockSql discipline in store.test.ts. `failOn` forces
 * the "column does not exist / PG down" path the fail-soft legs must survive.
 */
interface PlanRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  goal_id: string | null;
}

function mockSql(opts: { modes?: ModeRow[]; briefs?: Array<{ owner_id: string; workspace_id: string; goal_id: string | null }>; plans?: PlanRow[]; failOn?: RegExp } = {}) {
  const modes = [...(opts.modes ?? [])];
  const briefs = [...(opts.briefs ?? [])];
  const plans = [...(opts.plans ?? [])];

  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    if (opts.failOn?.test(text)) return Promise.reject(new Error('column "goal_id" does not exist'));

    if (text.includes('UPDATE harness_shared.harness_plans')) {
      const [goalId, ws, harness, slug] = vals as string[];
      const stamped: Array<{ plan_slug: string }> = [];
      for (const p of plans) {
        if (p.workspace_id !== ws || p.harness_slug !== harness || p.plan_slug !== slug) continue;
        // Faithful to the statement's OWN predicate: the `goal_id IS NULL`
        // guard is honored only when the SQL still carries it. Dropping the
        // clause in production makes this mock overwrite — which is exactly
        // what fails the first-attribution test below (falsifiability: the
        // mock must not hardcode the invariant the SQL is supposed to state).
        if (!text.includes('goal_id IS NULL') || p.goal_id == null) {
          p.goal_id = goalId;
          stamped.push({ plan_slug: p.plan_slug });
        }
      }
      // Rows come back only when the statement asks for them, as in postgres.js.
      return Promise.resolve(text.includes('RETURNING plan_slug') ? stamped : []);
    }
    if (text.includes('WITH mine AS MATERIALIZED') && text.includes('elected_owner_id')) {
      const [ws, owner] = vals as string[];
      const mine = modes.find(
        (m) => m.workspace_id === ws && m.owner_id === owner && m.mode === GOAL_MODE && m.subject,
      );
      if (!mine?.subject) return Promise.resolve([]);
      const elected = modes
        .filter((m) => m.workspace_id === ws && m.mode === GOAL_MODE && m.subject === mine.subject)
        .sort(
          (a, b) =>
            (b.goal_lease_epoch ?? -1) - (a.goal_lease_epoch ?? -1) ||
            String(b.set_at ?? '').localeCompare(String(a.set_at ?? '')) ||
            a.owner_id.localeCompare(b.owner_id),
        )[0];
      if (!elected) return Promise.resolve([]);
      return Promise.resolve([
        {
          subject: mine.subject,
          elected_owner_id: elected.owner_id,
          elected_epoch: elected.goal_lease_epoch ?? null,
          predecessor_owner_id: elected.goal_handoff_from_owner_id ?? null,
          handoff_expires_at: elected.goal_handoff_expires_at ?? null,
        },
      ]);
    }
    if (text.includes('SELECT subject FROM harness_shared.agent_modes')) {
      const [ws, owner, axis, mode] = vals as string[];
      const row = modes.find(
        (m) => m.workspace_id === ws && m.owner_id === owner && m.axis_key === axis && m.mode === mode,
      );
      return Promise.resolve(row ? [{ subject: row.subject }] : []);
    }
    if (text.includes('SELECT goal_id FROM harness_shared.session_briefs')) {
      const [owner, ws] = vals as string[];
      const row = briefs.find((b) => b.owner_id === owner && b.workspace_id === ws);
      return Promise.resolve(row ? [{ goal_id: row.goal_id }] : []);
    }
    if (text.includes('INSERT INTO harness_shared.session_briefs')) {
      const [owner, ws, goalId] = vals as string[];
      const existing = briefs.find((b) => b.owner_id === owner);
      if (existing) existing.goal_id = goalId;
      else briefs.push({ owner_id: owner, workspace_id: ws, goal_id: goalId });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as Sql, briefs, plans };
}

const WS = 'ws-1';

// Derived from the registry, never hardcoded: GOAL's axis is 'overlay', not
// 'goal', and a mock that assumed otherwise returned no rows — which reads as
// "this agent runs no goal", i.e. a green-looking false negative. Deriving it
// means a future axis change moves the mock with the code instead of silently
// unhooking these tests.
const GOAL_AXIS = axisKeyFor(modeById(GOAL_MODE)!);

function goalMode(
  ownerId: string,
  subject: string | null,
  overrides: Partial<ModeRow> = {},
): ModeRow {
  return {
    workspace_id: WS,
    owner_id: ownerId,
    axis_key: GOAL_AXIS,
    mode: GOAL_MODE,
    subject,
    goal_lease_epoch: 1,
    set_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveGoalContext', () => {
  it('resolves the goal an agent RUNS from its own goal-mode subject', async () => {
    const { sql } = mockSql({ modes: [goalMode('agent-a', 'goal-42')] });
    expect(await resolveGoalContext(WS, 'agent-a', sql)).toBe('goal-42');
  });

  it('resolves an INHERITED goal for an agent with no goal-mode row — the P-002 case', async () => {
    // The fleet member: launched by a goal agent, never in GOAL mode itself.
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }] });
    expect(await resolveGoalContext(WS, 'member-1', sql)).toBe('goal-42');
  });

  it('returns null for an agent attached to no goal at all (the common case)', async () => {
    const { sql } = mockSql();
    expect(await resolveGoalContext(WS, 'ordinary-agent', sql)).toBeNull();
  });

  it('prefers the goal it RUNS over the goal it inherited', async () => {
    // A goal agent spawned by a higher-level goal agent. Its work belongs to the
    // goal it manages, not its parent's — the opposite order would silently
    // re-parent a whole sub-portfolio's work to the grandparent.
    const { sql } = mockSql({
      modes: [goalMode('sub-manager', 'goal-child')],
      briefs: [{ owner_id: 'sub-manager', workspace_id: WS, goal_id: 'goal-parent' }],
    });
    expect(await resolveGoalContext(WS, 'sub-manager', sql)).toBe('goal-child');
  });

  it('allows the elected successor and refuses an expired predecessor with an elected-holder diagnosis', async () => {
    const predecessor = goalMode('holder-old', 'goal-42', { goal_lease_epoch: 1 });
    const successor = goalMode('holder-new', 'goal-42', {
      goal_lease_epoch: 2,
      goal_handoff_from_owner_id: 'holder-old',
      goal_handoff_expires_at: '2020-01-01T00:00:00.000Z',
    });
    const { sql } = mockSql({ modes: [predecessor, successor] });

    expect(await resolveGoalContext(WS, 'holder-new', sql)).toBe('goal-42');
    await expect(resolveGoalContext(WS, 'holder-old', sql)).rejects.toMatchObject({
      name: 'GoalHolderAuthorityError',
      authority: { electedOwnerId: 'holder-new', electedEpoch: 2 },
    });
  });

  it('permits only the named predecessor during the explicit handoff window', async () => {
    const predecessor = goalMode('holder-old', 'goal-42', { goal_lease_epoch: 1 });
    const successor = goalMode('holder-new', 'goal-42', {
      goal_lease_epoch: 2,
      goal_handoff_from_owner_id: 'holder-old',
      goal_handoff_expires_at: '2999-01-01T00:00:00.000Z',
    });
    const { sql } = mockSql({ modes: [predecessor, successor] });

    expect(await readGoalHolderAuthority(sql, WS, 'holder-old')).toMatchObject({
      status: 'handoff',
      electedOwnerId: 'holder-new',
    });
    expect(await resolveGoalContext(WS, 'holder-old', sql)).toBe('goal-42');
  });

  it('does not fence an ordinary descendant that only inherited goal context', async () => {
    const { sql } = mockSql({
      modes: [goalMode('holder-new', 'goal-42', { goal_lease_epoch: 2 })],
      briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }],
    });
    await expect(resolveGoalContext(WS, 'member-1', sql)).resolves.toBe('goal-42');
  });

  it('fails closed when holder authority is unreadable instead of falling through to inherited context', async () => {
    const { sql } = mockSql({
      briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }],
      failOn: /WITH mine AS MATERIALIZED/,
    });

    await expect(resolveGoalContext(WS, 'member-1', sql)).rejects.toMatchObject({
      name: 'GoalHolderAuthorityError',
      code: 'goal_holder_authority_unreadable',
      authority: null,
      ownerId: 'member-1',
    });
  });

  it('the explicit mutation fence permits non-GOAL actors and refuses an expired predecessor', async () => {
    const predecessor = goalMode('holder-old', 'goal-42', { goal_lease_epoch: 1 });
    const successor = goalMode('holder-new', 'goal-42', {
      goal_lease_epoch: 2,
      goal_handoff_from_owner_id: 'holder-old',
      goal_handoff_expires_at: '2020-01-01T00:00:00.000Z',
    });
    const { sql } = mockSql({ modes: [predecessor, successor] });

    await expect(assertGoalHolderMutationAuthority(WS, 'ordinary-agent', sql)).resolves.toMatchObject({
      status: 'none',
    });
    await expect(assertGoalHolderMutationAuthority(WS, 'holder-new', sql)).resolves.toMatchObject({
      status: 'elected',
    });
    await expect(assertGoalHolderMutationAuthority(WS, 'holder-old', sql)).rejects.toMatchObject({
      code: 'goal_holder_superseded',
      authority: { electedOwnerId: 'holder-new' },
    });
  });

  it('treats a goal-mode row with no subject as no goal, falling through to inherited', async () => {
    // The measured-real state: an agent entered GOAL mode but has not filed its
    // goal yet (goal-session.ts). It must not resolve to a bogus stamp.
    const { sql } = mockSql({
      modes: [goalMode('pending', null)],
      briefs: [{ owner_id: 'pending', workspace_id: WS, goal_id: 'goal-inherited' }],
    });
    expect(await resolveGoalContext(WS, 'pending', sql)).toBe('goal-inherited');
  });

  it('refuses to resolve across a wildcard workspace', async () => {
    const { sql } = mockSql({ briefs: [{ owner_id: 'x', workspace_id: '*', goal_id: 'goal-42' }] });
    expect(await resolveGoalContext('*', 'x', sql)).toBeNull();
  });

  it('degrades to null rather than throwing when the brief read fails', async () => {
    // A node that has not yet applied migration 785. Provenance is a decoration:
    // losing it must never fail the creation it was decorating.
    const { sql } = mockSql({ failOn: /session_briefs/ });
    await expect(resolveGoalContext(WS, 'member-1', sql, { requireRead: true }))
      .rejects.toThrow('column "goal_id" does not exist');
    await expect(resolveGoalContext(WS, 'member-1', sql)).resolves.toBeNull();
  });
});

describe('setInheritedGoalContext', () => {
  it('records the goal on a session with no prior brief row', async () => {
    const { sql, briefs } = mockSql();
    expect(await setInheritedGoalContext(WS, 'member-1', 'goal-42', sql)).toBe(true);
    expect(briefs).toEqual([{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }]);
    expect(await getInheritedGoalContext(WS, 'member-1', sql)).toBe('goal-42');
  });

  it('re-parents an existing row — a relaunch under a different goal wins', async () => {
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-old' }] });
    await setInheritedGoalContext(WS, 'member-1', 'goal-new', sql);
    expect(await getInheritedGoalContext(WS, 'member-1', sql)).toBe('goal-new');
  });

  it('clears obsolete inherited context when an explicit launcher has no goal', async () => {
    const { sql, briefs } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-paused' }] });
    expect(await setInheritedGoalContext(WS, 'member-1', null, sql)).toBe(true);
    expect(briefs).toEqual([{ owner_id: 'member-1', workspace_id: WS, goal_id: null }]);
    expect(await resolveGoalContext(WS, 'member-1', sql)).toBeNull();
  });

  it('clearing inherited context preserves the target own GOAL authority', async () => {
    const { sql } = mockSql({ modes: [goalMode('manager', 'goal-owned')],
      briefs: [{ owner_id: 'manager', workspace_id: WS, goal_id: 'goal-parent' }] });
    expect(await setInheritedGoalContext(WS, 'manager', null, sql)).toBe(true);
    expect(await getInheritedGoalContext(WS, 'manager', sql)).toBeNull();
    expect(await resolveGoalContext(WS, 'manager', sql)).toBe('goal-owned');
  });

  it('reports failure instead of throwing, so a launch is never blocked', async () => {
    const { sql } = mockSql({ failOn: /INSERT INTO harness_shared.session_briefs/ });
    await expect(setInheritedGoalContext(WS, 'member-1', 'goal-42', sql)).resolves.toBe(false);
  });

  it.each(['', '   ', undefined])('refuses a missing or blank goal id %s without clearing context', async (goal) => {
    const { sql, briefs } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-paused' }] });
    expect(await setInheritedGoalContext(WS, 'member-1', goal as never, sql)).toBe(false);
    expect(briefs).toEqual([{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-paused' }]);
  });
});

describe('inheriting goal context does NOT confer GOAL mode', () => {
  it('leaves a descendant off the goal boards while still resolving its goal', async () => {
    // THE P-002 INVARIANT. A fleet member inherits provenance through
    // session_briefs, so its work stamps goal_id — but it has no goal-mode row,
    // so goal-session's predicates still read it as an ordinary session and it
    // keeps appearing in the sessions pane. Fusing the two would hide every
    // fleet member into a goal card, which is silent in the direction that
    // matters: nobody files a bug about a session they cannot see.
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }] });

    expect(await resolveGoalContext(WS, 'member-1', sql)).toBe('goal-42');

    const memberModes: Array<{ mode: string; subject?: string | null }> = [{ mode: 'auto' }];
    expect(goalIdFromModes(memberModes)).toBeNull();
    expect(isGoalSessionModes(memberModes)).toBe(false);
  });

  it('still recognises the goal AGENT itself as a goal session', async () => {
    const { sql } = mockSql({ modes: [goalMode('agent-a', 'goal-42')] });
    expect(await resolveGoalContext(WS, 'agent-a', sql)).toBe('goal-42');

    const agentModes = [{ mode: 'goal', subject: 'goal-42' }];
    expect(goalIdFromModes(agentModes)).toBe('goal-42');
    expect(isGoalSessionModes(agentModes)).toBe(true);
  });
});

describe('stampPlanGoalProvenance (migration 791 / goal-mode-design-intent-hardening P-003)', () => {
  const planRow = (goal: string | null = null): PlanRow => ({
    workspace_id: WS,
    harness_slug: 'hive-home',
    plan_slug: 'the-plan',
    goal_id: goal,
  });
  const stampArgs = (ownerId: string) => ({
    workspaceId: WS,
    harnessSlug: 'hive-home',
    planSlug: 'the-plan',
    ownerId,
    // Worklist enrollment has its own suite below; stub it here.
    enroll: async (a: { harnessSlug: string; planSlug: string }) =>
      ({ outcome: 'enrolled' as const, ref: goalWorklistRef(a.harnessSlug, a.planSlug), version: 1 }),
  });

  it('stamps a plan created by an agent RUNNING a goal', async () => {
    const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
    expect(await stampPlanGoalProvenance({ ...stampArgs('agent-a'), sql })).toBe('goal-42');
    expect(plans[0]!.goal_id).toBe('goal-42');
  });

  it('stamps a plan created by an agent that INHERITED its goal — a launched descendant', async () => {
    const { sql, plans } = mockSql({
      briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }],
      plans: [planRow()],
    });
    expect(await stampPlanGoalProvenance({ ...stampArgs('member-1'), sql })).toBe('goal-42');
    expect(plans[0]!.goal_id).toBe('goal-42');
  });

  it('writes nothing for a goal-less creator — the common case stays NULL', async () => {
    const { sql, plans } = mockSql({ plans: [planRow()] });
    expect(await stampPlanGoalProvenance({ ...stampArgs('ordinary-agent'), sql })).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('NEVER overwrites an existing stamp — first attribution wins, a later editor cannot re-parent', async () => {
    // The mock honors the statement's own `goal_id IS NULL` predicate, so this
    // fails if production drops that clause — not because the mock hardcodes it.
    const { sql, plans } = mockSql({
      modes: [goalMode('agent-b', 'goal-B')],
      plans: [planRow('goal-A')],
    });
    await stampPlanGoalProvenance({ ...stampArgs('agent-b'), sql });
    expect(plans[0]!.goal_id).toBe('goal-A');
  });

  it('no argument can name the goal: the goal id is only ever the RESOLVED context', async () => {
    // The args type carries workspace/harness/plan/owner — there is no goalId
    // input to smuggle. A creator resolving to no goal stamps nothing even when
    // a caller tries to pass one; the excess property is a TS error, and at
    // runtime the resolver (not the argument) decides.
    const { sql, plans } = mockSql({ plans: [planRow()] });
    const smuggled = { ...stampArgs('ordinary-agent'), goalId: 'goal-evil', sql } as Parameters<
      typeof stampPlanGoalProvenance
    >[0];
    expect(await stampPlanGoalProvenance(smuggled)).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('degrades to null rather than throwing when the plans UPDATE fails', async () => {
    const { sql, plans } = mockSql({
      modes: [goalMode('agent-a', 'goal-42')],
      plans: [planRow()],
      failOn: /UPDATE harness_shared.harness_plans/,
    });
    await expect(stampPlanGoalProvenance({ ...stampArgs('agent-a'), sql })).resolves.toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('never downgrades a superseded-holder refusal into a missing provenance stamp', async () => {
    const predecessor = goalMode('holder-old', 'goal-42', { goal_lease_epoch: 1 });
    const successor = goalMode('holder-new', 'goal-42', {
      goal_lease_epoch: 2,
      goal_handoff_from_owner_id: 'holder-old',
      goal_handoff_expires_at: '2020-01-01T00:00:00.000Z',
    });
    const { sql, plans } = mockSql({ modes: [predecessor, successor], plans: [planRow()] });

    await expect(stampPlanGoalProvenance({ ...stampArgs('holder-old'), sql })).rejects.toMatchObject({
      code: 'goal_holder_superseded',
    });
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('refuses a wildcard workspace and missing identifiers', async () => {
    const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
    expect(
      await stampPlanGoalProvenance({ ...stampArgs('agent-a'), workspaceId: '*', sql }),
    ).toBeNull();
    expect(
      await stampPlanGoalProvenance({ ...stampArgs('agent-a'), ownerId: undefined as unknown as string, sql }),
    ).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });
});

describe('goal-authored plans join the canonical worklist on first attribution (WI-10003913)', () => {
  type EnrollArgs = Parameters<typeof enrollGoalAuthoredPlanOnWorklist>[0];
  const stampArgs = { workspaceId: WS, harnessSlug: 'hive-home', planSlug: 'the-plan', ownerId: 'agent-a' };
  const planRow = (goal: string | null = null): PlanRow => ({
    workspace_id: WS, harness_slug: 'hive-home', plan_slug: 'the-plan', goal_id: goal,
  });
  const recordingEnroll = () => {
    const calls: EnrollArgs[] = [];
    const enroll = async (a: EnrollArgs) => {
      calls.push(a);
      return { outcome: 'enrolled' as const, ref: goalWorklistRef(a.harnessSlug, a.planSlug), version: 1 };
    };
    return { calls, enroll };
  };

  it('enrolls the plan exactly once, on the FIRST attribution', async () => {
    const { calls, enroll } = recordingEnroll();
    const { sql } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
    expect(await stampPlanGoalProvenance({ ...stampArgs, sql, enroll })).toBe('goal-42');
    expect(calls).toEqual([expect.objectContaining({
      workspaceId: WS, goalId: 'goal-42', harnessSlug: 'hive-home', planSlug: 'the-plan', actorId: 'agent-a',
    })]);
    // Re-stamping finds goal_id already set, so nothing is re-listed (an owner's later removal sticks).
    expect(await stampPlanGoalProvenance({ ...stampArgs, sql, enroll })).toBe('goal-42');
    expect(calls).toHaveLength(1);
  });

  it('never enrolls a plan another goal already owns', async () => {
    const { calls, enroll } = recordingEnroll();
    const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow('goal-other')] });
    await stampPlanGoalProvenance({ ...stampArgs, sql, enroll });
    expect(calls).toHaveLength(0);
    expect(plans[0]!.goal_id).toBe('goal-other');
  });

  it('a failed enrollment never fails the stamp, and says so loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const enroll = async (): Promise<never> => { throw new Error('pg down'); };
      const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
      expect(await stampPlanGoalProvenance({ ...stampArgs, sql, enroll })).toBe('goal-42');
      expect(plans[0]!.goal_id).toBe('goal-42');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT enrolled on its worklist: pg down'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('enrollGoalAuthoredPlanOnWorklist', () => {
  type WriteArgs = Parameters<NonNullable<Parameters<typeof enrollGoalAuthoredPlanOnWorklist>[0]['write']>>[1];
  const base = { workspaceId: WS, goalId: 'goal-42', harnessSlug: 'papercusp', planSlug: 'p', actorId: 'agent-a' };
  /** A goals row read behind a postgres.js-shaped tag; `undefined` = no such goal. */
  function goalSql(worklist: unknown, definition: unknown = null) {
    const seen: string[] = [];
    const fn = (first: unknown): unknown => {
      const text = (first as string[]).join('?').replace(/\s+/g, ' ');
      seen.push(text);
      if (text.includes('FROM harness_shared.goals')) return Promise.resolve(worklist === undefined ? [] : [{ worklist, definition }]);
      return Promise.resolve([]);
    };
    return { sql: fn as unknown as Sql, seen };
  }
  function recordingWrite(result: { ok: boolean; code?: string } = { ok: true }) {
    const writes: WriteArgs[] = [];
    const write = (async (_tx: unknown, a: WriteArgs) => { writes.push(a); return result; }) as never;
    return { writes, write };
  }

  it('appends the ref under CAS at the version read under the row lock, keeping existing entries', async () => {
    const { writes, write } = recordingWrite();
    const { sql, seen } = goalSql({ value: ['plan:papercusp/older'], version: 3 });
    expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql, write }))
      .toEqual({ outcome: 'enrolled', ref: 'plan:papercusp/p', version: 4 });
    expect(writes).toEqual([expect.objectContaining({
      goalId: 'goal-42', property: 'worklist', value: ['plan:papercusp/older', 'plan:papercusp/p'],
      expectedVersion: 3, provenance: 'agent-edit', actorId: 'agent-a',
    })]);
    expect(seen.some((t) => t.includes('FOR UPDATE'))).toBe(true);
  });

  it('starts an unset worklist at version 0', async () => {
    const { writes, write } = recordingWrite();
    await enrollGoalAuthoredPlanOnWorklist({ ...base, sql: goalSql(null).sql, write });
    expect(writes).toEqual([expect.objectContaining({ value: ['plan:papercusp/p'], expectedVersion: 0 })]);
  });

  it.each([null, { value: ['plan:papercusp/owner-picked'], version: 16 }])(
    'leaves an owner-selected worklist unchanged on automatic enrollment (stored=%j)',
    async (worklist) => {
      const { writes, write } = recordingWrite();
      const { sql } = goalSql(worklist, { collection: { defaultSelected: false } });
      expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql, write }))
        .toEqual({ outcome: 'not-selected', ref: 'plan:papercusp/p' });
      expect(writes).toHaveLength(0);
    },
  );

  it('continues automatic enrollment for a default-selected collection', async () => {
    const { writes, write } = recordingWrite();
    const { sql } = goalSql({ value: [], version: 3 }, { collection: { defaultSelected: true } });
    expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql, write }))
      .toEqual({ outcome: 'enrolled', ref: 'plan:papercusp/p', version: 4 });
    expect(writes).toEqual([expect.objectContaining({ value: ['plan:papercusp/p'], expectedVersion: 3 })]);
  });

  it('is idempotent for an already-listed plan in either ref shape', async () => {
    for (const listed of ['plan:papercusp/p', 'plan:p']) {
      const { writes, write } = recordingWrite();
      expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql: goalSql({ value: [listed], version: 2 }).sql, write }))
        .toEqual({ outcome: 'already-listed', ref: 'plan:papercusp/p' });
      expect(writes).toHaveLength(0);
    }
  });

  it('reports a missing goal and the writer refusal code instead of claiming success', async () => {
    const { write } = recordingWrite({ ok: false, code: 'stale' });
    expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql: goalSql(undefined).sql, write }))
      .toEqual({ outcome: 'refused', ref: 'plan:papercusp/p', code: 'not_found' });
    expect(await enrollGoalAuthoredPlanOnWorklist({ ...base, sql: goalSql({ value: [], version: 1 }).sql, write }))
      .toEqual({ outcome: 'refused', ref: 'plan:papercusp/p', code: 'stale' });
  });
});
