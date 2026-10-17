/**
 * Per-goal launch settings + the one launch resolver
 * (goal-mode-hardening-2026-08-10 P-004, D-009) over a mock sql seam (no PG).
 *
 * The invariant under test is not "a number comes back". It is that the two
 * D-005 ceilings COMPOSE and that neither can be silently skipped:
 *
 *   • a fleet member counts against its fleet's cap AND the goal's total, so a
 *     fleet with room can still be refused by the goal — the case a per-fleet
 *     cap alone would wave through, and the reason D-005 asks for both;
 *   • a ceiling that cannot be COUNTED is reported as unenforced rather than
 *     passing silently, because "no refusal" and "no ceiling applied" are
 *     otherwise indistinguishable to a caller;
 *   • the goal is resolved from the LAUNCHER and never accepted as an argument,
 *     which is what stops a future launch door from dropping goal context by
 *     forgetting to pass it (D-008's constraint, made structural).
 *
 * WHAT A MOCK CANNOT PROVE: that the headcount SQL's liveness join and its
 * boot-grace leg select the right rows. A mock returns whatever fixture it is
 * handed. That half is verified against live PG separately; these tests pin the
 * DECISION logic sitting on top of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GOAL_OWNER_REPORT_HEADING_LIST } from './goal-owner-report';
import type { Sql } from 'postgres';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import {
  checkGoalInferenceAdmission,
  evaluateGoalInferenceBudget,
} from './goal-launch-settings';
import type { GoalSpendRollup } from './goals/spend-rollup';

// P-006: the budget gate reads its flag and opens its escalation through
// DYNAMIC imports (the module keeps heavyweight deps out of the launch path's
// static graph), so both seams are mocked at the module level. State lives in
// vi.hoisted so the factory closures survive hoisting.
const budgetGateFlag = vi.hoisted(() => ({ value: true, throws: false }));
const escalated = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
const goalHoldersMock = vi.hoisted(() =>
  vi.fn(async (_sql: unknown, opts: { workspaceId: string; goalId: string }) => ({
    workspaceId: opts.workspaceId,
    goalId: opts.goalId,
    holders: [] as Array<{ ownerId: string }>,
    live: [{ ownerId: 'su-live-goal-holder' }] as Array<{ ownerId: string }>,
    // Widened on purpose: the stale-owner-edge tests (WI-10004524) re-queue this
    // mock with every liveness verdict, and a literal `'held'` return type would
    // force a cast at each call site.
    liveness: 'held' as 'held' | 'unheld' | 'lost' | 'unknown',
  })),
);
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => {
    if (budgetGateFlag.throws) throw new Error('flag infra down');
    return budgetGateFlag.value;
  },
}));
vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: async (identity: unknown, input: Record<string, unknown>) => {
    escalated.calls.push({ identity, ...input });
    return {};
  },
}));
// EI-25642470052572430: this suite exercises the launch decisions above the
// holder reader, not its presence-oracle graph (covered by holder.test.ts).
// importOriginal pulls that graph back through agent-mcp before publishing the
// spy, leaving the dynamic reader in a circular module initialization.
vi.mock('./goals/holder', () => ({
  resolveGoalHolders: goalHoldersMock,
}));
// The launch-time spend measurement (D-011 clause 3 / stewardship D-014). The gate
// reaches computeGoalSpendRollup through a dynamic import; its SQL is covered by the
// spend-rollup suites, so here each test states the legs it wants the gate to see.
// Default: every leg empty (the zero-usage bootstrap).
const liveSpend = vi.hoisted(() => ({
  legs: { spentCents: null as number | null, lineage: 0, lineageUnpriced: 0, pot: 0, session: 0 },
  freshnessStatus: 'fresh' as 'fresh' | 'stale' | 'unavailable',
  throws: false,
  calls: 0,
}));
// EI-25306440159635835: only the READ is replaced (it builds the workspace identity
// graph); renderGoalRubricStewardshipBrief stays real. No other test here gives a
// goal rubric duties, so nothing else reaches this spy.
const rubricStewardshipRead = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./goal-rubric-stewardship', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./goal-rubric-stewardship')>()),
  readGoalRubricStewardship: rubricStewardshipRead,
}));
vi.mock('./goals/spend-rollup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./goals/spend-rollup')>()),
  computeGoalSpendRollup: async () => {
    liveSpend.calls += 1;
    if (liveSpend.throws) throw new Error('ledger read failed');
    const l = liveSpend.legs;
    const freshnessReason = liveSpend.freshnessStatus === 'fresh'
      ? null
      : `interactive-usage-${liveSpend.freshnessStatus}` as 'interactive-usage-stale' | 'interactive-usage-unavailable';
    return {
      spentCents: l.spentCents,
      unmeasuredReason: freshnessReason ??
        (l.spentCents != null ? null : l.lineage === 0 ? 'no-lineage-samples' : 'unpriced-lineage-samples'),
      samples: l.pot + l.session,
      pot: { samples: l.pot },
      session: { samples: l.session },
      lineage: { samples: l.lineage, unpricedSamples: l.lineageUnpriced },
      interactiveUsageFreshness: {
        status: liveSpend.freshnessStatus,
        lastIngestedAtMs: liveSpend.freshnessStatus === 'fresh' ? Date.now() : null,
        ageMs: liveSpend.freshnessStatus === 'fresh' ? 0 : null,
        windowMs: 30 * 60_000,
        reason: `test freshness ${liveSpend.freshnessStatus}`,
      },
    };
  },
}));
import {
  GOAL_LAUNCH_DEFAULTS,
  UNLIMITED_CEILING,
  goalArmWithholdsBrief,
  goalArmWithholdsReminders,
  goalWithholdsTurnStartReminders,
  resolveGoalBehaviorArm,
  goalLaunchSettingsSchema,
  launchProfileSchema,
  foldLaunchProfile,
  GOAL_LAUNCH_ROLES,
  isGoalLaunchRole,
  readGoalPortfolioBrief,
  readGoalPortfolioBriefStaged,
  compileGoalPlanPlacement,
  parseGoalLaunchSettings,
  readGoalLaunchSettings,
  readGoalLaunchSettingsForLauncher,
  resolveGoalPotPlacementAuthority,
  renderGoalPortfolioBrief,
  evaluateGoalOperatingInputs,
  evaluateGoalLadderHealth,
  goalHolderInputRefusal,
  writeGoalLaunchSettings,
  declareGoalHolderPolicy,
  resolveCeiling,
  resolveGoalLaunch,
  resolveGoalLaunchForGoal,
  goalHolderPolicySchema,
  goalHolderPolicyProblem,
  drainFleetTopologyProblem,
  DRAIN_FLEET_MIN_CEILINGS,
  resolveGoalHolderPolicy,
  GOAL_HOLDER_ON_LOSS,
  REFUSAL_SCOPES,
  hasUnmeasuredPricedSpend,
  type GoalLaunchSettings,
} from './goal-launch-settings';
import { GOAL_KICKOFF_REQUIRED_READS } from './goals/kickoff-evidence';

interface MockOpts {
  /** agent_modes rows — an entry here means that owner RUNS the goal. */
  modeSubject?: Record<string, string>;
  /** session_briefs.goal_id — an entry means that owner INHERITED the goal. */
  inherited?: Record<string, string>;
  /** launch_settings by goal id. */
  settings?: Record<string, unknown>;
  /** P-006 budget fixture by goal id — budget_cents as pg hands it over (bigint
   *  ⇒ string) and spent_cents as the jsonb scalar `metadata->'spentCents'`. */
  budget?: Record<
    string,
    {
      budget_cents?: number | string | null;
      spent_cents?: unknown;
      /** WI-10002052 / D-011: `metadata.spentCentsUnmeasuredReason`, which the
       *  unmeasurable-spend gate reads. */
      spent_cents_unmeasured_reason?: string | null;
      spent_cents_at?: string | null;
      spent_cents_source?: string | null;
      spent_cents_freshness_status?: 'fresh' | 'stale' | 'unavailable' | null;
      spent_cents_freshness_last_ingested_at_ms?: number | string | null;
    }
  >;
  /** Goal-owned fields that share the launch-policy row read. */
  brief?: Record<
    string,
    {
      title?: string;
      body?: string | null;
      kill_criterion?: string | null;
      budget_window_sec?: number | string | null;
      standing?: boolean;
    }
  >;
  /** Current lifecycle state for goal inference-admission fixtures. */
  goalStatus?: Record<string, string>;
  /** headcount fixture by goal id. */
  headcount?: Record<string, { total: number; fleet: number }>;
  /** P-012 canonical portfolio projection row by goal id. */
  portfolio?: Record<string, Record<string, unknown>>;
  /** Active role='owner' goal for a target harness. Terminal historical owners
   * are deliberately absent: the production query joins goals.status='active'. */
  activePotOwner?: Record<
    string,
    {
      goalId: string;
      title?: string | null;
      /** WI-10004524: `goals.metadata.disposition` of the owning goal. */
      disposition?: string | null;
      standing?: boolean;
      /** Non-archived non-terminal plans stamped to / listed by the owner goal.
       *  Omitted ⇒ the count column is absent, i.e. UNREAD (never read as 0). */
      liveWorklistPlans?: number;
    }
  >;
  /**
   * Holder-AUTHORITY election, by GOAL id — who currently holds the goal named
   * in `modeSubject`. Omitted ⇒ the owner that runs the goal is also its
   * elected holder, which is what every pre-02d9c38d1f fixture meant.
   *
   * Keyed by goal rather than by owner on purpose: the election is a property
   * of the subject, so two owners on the same goal must see the SAME verdict.
   * Naming a different `electedOwnerId` is how a test asks for a SUPERSEDED
   * caller; naming `predecessorOwnerId` + a future `handoffExpiresAt` is how it
   * asks for a live handoff.
   */
  holder?: Record<
    string,
    {
      electedOwnerId?: string;
      electedEpoch?: number | null;
      predecessorOwnerId?: string | null;
      handoffExpiresAt?: string | null;
    }
  >;
  /** Force a hard failure on any statement matching this. */
  failOn?: RegExp;
  /** Statements the mock actually saw, for structural assertions. */
  seen?: string[];
}

function mockSql(opts: MockOpts = {}): Sql {
  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    opts.seen?.push(text);
    if (opts.failOn?.test(text)) return Promise.reject(new Error('boom'));

    // resolveGoalContext leg 1 — does this owner RUN a goal?
    //
    // Since 02d9c38d1f this is the holder-AUTHORITY election read
    // (goals/holder-authority.ts): ONE row carrying the caller's own subject
    // AND the currently-elected holder for it. This fixture used to return
    // `{ subject }` alone, which left `elected_owner_id` undefined — and the
    // reader correctly reads "elected holder ≠ me" as SUPERSEDED. Every
    // modeSubject test therefore failed on the supersession fence instead of
    // exercising its own subject. Return the full row shape.
    if (text.includes('SELECT subject FROM harness_shared.agent_modes')) {
      const owner = vals[1] as string;
      const subj = opts.modeSubject?.[owner];
      if (!subj) return Promise.resolve([]);
      const h = opts.holder?.[subj];
      return Promise.resolve([
        {
          subject: subj,
          elected_owner_id: h?.electedOwnerId ?? owner,
          elected_epoch: h?.electedEpoch ?? 1,
          predecessor_owner_id: h?.predecessorOwnerId ?? null,
          handoff_expires_at: h?.handoffExpiresAt ?? null,
        },
      ]);
    }
    // resolveGoalContext leg 2 — did this owner INHERIT one?
    if (text.includes('SELECT goal_id FROM harness_shared.session_briefs')) {
      const owner = vals[0] as string;
      const g = opts.inherited?.[owner];
      return Promise.resolve(g ? [{ goal_id: g }] : []);
    }
    if (text.includes('FROM harness_shared.goals WHERE id')) {
      const goalId = vals[0] as string;
      const known = goalId in (opts.settings ?? {}) || goalId in (opts.budget ?? {}) || goalId in (opts.brief ?? {});
      if (!known) return Promise.resolve([]);
      const b = opts.budget?.[goalId];
      const brief = opts.brief?.[goalId];
      return Promise.resolve([
        {
          status: opts.goalStatus?.[goalId] ?? 'active',
          title: brief?.title ?? `Goal ${goalId}`,
          body: brief?.body ?? null,
          kill_criterion: brief?.kill_criterion ?? null,
          budget_window_sec: brief?.budget_window_sec ?? null,
          standing: brief?.standing ?? false,
          launch_settings: opts.settings?.[goalId] ?? null,
          budget_cents: b?.budget_cents ?? null,
          spent_cents: b?.spent_cents ?? null,
          spent_cents_unmeasured_reason: b?.spent_cents_unmeasured_reason ?? null,
          spent_cents_at: b?.spent_cents_at ?? null,
          spent_cents_source: b?.spent_cents_source ?? null,
          interactive_usage_freshness_status:
            b?.spent_cents_freshness_status ?? (b?.spent_cents != null ? 'fresh' : null),
          interactive_usage_last_ingested_at_ms:
            b?.spent_cents_freshness_last_ingested_at_ms ?? (b?.spent_cents != null ? Date.now() : null),
        },
      ]);
    }
    if (text.includes('WITH goal_row AS')) {
      const goalId = (vals as unknown[]).find(
        (value) => typeof value === 'string' && value in (opts.portfolio ?? {}),
      ) as string | undefined;
      const row = goalId ? opts.portfolio?.[goalId] : undefined;
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes('FROM harness_shared.goal_pots gp') && text.includes("g.status = 'active'")) {
      const harness = (vals as unknown[]).find(
        (value) => typeof value === 'string' && value in (opts.activePotOwner ?? {}),
      ) as string | undefined;
      const owner = harness ? opts.activePotOwner?.[harness] : undefined;
      return Promise.resolve(
        owner
          ? [
              {
                owner_goal_id: owner.goalId,
                owner_goal_title: owner.title ?? null,
                owner_disposition: owner.disposition ?? null,
                owner_standing: owner.standing ?? false,
                live_worklist_plans: owner.liveWorklistPlans,
              },
            ]
          : [],
      );
    }
    if (text.includes('FROM harness_shared.session_briefs b')) {
      // Located by VALUE, not by index. A positional lookup here silently
      // returns the zero fixture if the query's parameter order ever changes,
      // which reads as "nothing is running" and turns every ceiling test green
      // for the wrong reason.
      const goalId = (vals as unknown[]).find((v) => typeof v === 'string' && v in (opts.headcount ?? {})) as
        | string
        | undefined;
      const hc = (goalId ? opts.headcount?.[goalId] : undefined) ?? { total: 0, fleet: 0 };
      return Promise.resolve([{ total: hc.total, fleet: hc.fleet }]);
    }
    if (text.includes('UPDATE harness_shared.goals')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

const WS = 'ws-1';

beforeEach(() => {
  goalHoldersMock.mockClear();
});

describe('resolveGoalPotPlacementAuthority', () => {
  it('allows an unowned harness and proves terminal owner rows are excluded by goal status', async () => {
    const seen: string[] = [];
    const verdict = await resolveGoalPotPlacementAuthority({
      workspaceId: WS,
      launcherGoalId: 'goal-work-on-everything',
      harnessSlug: 'papercusp',
      sql: mockSql({ seen }),
    });

    expect(verdict).toEqual({
      allowed: true,
      reason: 'no-active-owner',
      ownerGoalId: null,
      ownerGoalTitle: null,
    });
    const query = seen.find((text) => text.includes('FROM harness_shared.goal_pots gp'));
    expect(query).toContain("gp.role = 'owner'");
    expect(query).toContain('gp.removed_at IS NULL');
    expect(query).toContain("g.status = 'active'");
  });

  it('allows the active goal that owns the target harness', async () => {
    await expect(
      resolveGoalPotPlacementAuthority({
        workspaceId: WS,
        launcherGoalId: 'goal-owner',
        harnessSlug: 'sidestage',
        sql: mockSql({ activePotOwner: { sidestage: { goalId: 'goal-owner', title: 'SideStage release' } } }),
      }),
    ).resolves.toEqual({
      allowed: true,
      reason: 'caller-goal-owns-pot',
      ownerGoalId: 'goal-owner',
      ownerGoalTitle: 'SideStage release',
    });
  });

  it('refuses placement when a different active goal owns the target harness', async () => {
    await expect(
      resolveGoalPotPlacementAuthority({
        workspaceId: WS,
        launcherGoalId: 'goal-work-on-everything',
        harnessSlug: 'sidestage',
        sql: mockSql({
          activePotOwner: {
            sidestage: { goalId: 'goal-sidestage-owner', title: 'SideStage release' },
          },
        }),
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'different-active-goal-owns-pot',
      ownerGoalId: 'goal-sidestage-owner',
      ownerGoalTitle: 'SideStage release',
      // The worklist count column was not read (the fixture omits it): UNREAD is
      // never 0, so the edge stays live and the oracle is not consulted.
      ownerState: { disposition: null, standing: false, liveWorklistPlans: null, holderLiveness: 'not-checked' },
    });
    expect(goalHoldersMock).not.toHaveBeenCalled();
  });

  describe('stale owner edge (WI-10004524)', () => {
    const launcher = 'goal-work-on-everything';
    const ownerGoal = 'goal-owner-handed-off';
    const verdictFor = (
      owner: Omit<NonNullable<MockOpts['activePotOwner']>[string], 'goalId' | 'title'>,
      seen?: string[],
    ) =>
      resolveGoalPotPlacementAuthority({
        workspaceId: WS,
        launcherGoalId: launcher,
        harnessSlug: 'papercusp',
        sql: mockSql({ activePotOwner: { papercusp: { goalId: ownerGoal, title: 'Handed off', ...owner } }, seen }),
      });
    const holderLiveness = (liveness: 'held' | 'unheld' | 'lost' | 'unknown') =>
      goalHoldersMock.mockImplementationOnce(async (_sql, opts) => ({
        workspaceId: opts.workspaceId,
        goalId: opts.goalId,
        holders: [],
        live: [],
        liveness,
      }));

    it('a LIVE owner (non-terminal worklist plan) refuses and never pays for the oracle', async () => {
      const verdict = await verdictFor({ liveWorklistPlans: 2, disposition: 'handoff' });
      expect(verdict).toMatchObject({ allowed: false, reason: 'different-active-goal-owns-pot' });
      expect(verdict.ownerState).toEqual({
        disposition: 'handoff',
        standing: false,
        liveWorklistPlans: 2,
        holderLiveness: 'not-checked',
      });
      expect(goalHoldersMock).not.toHaveBeenCalled();
    });

    it.each(['handoff', 'killed', 'achieved'])(
      'a %s owner with no live worklist is VACANT without consulting the oracle',
      async (disposition) => {
        const verdict = await verdictFor({ liveWorklistPlans: 0, disposition });
        expect(verdict).toMatchObject({
          allowed: true,
          reason: 'stale-owner-edge-vacant',
          ownerGoalId: ownerGoal,
        });
        expect(verdict.ownerState?.holderLiveness).toBe('not-checked');
        expect(goalHoldersMock).not.toHaveBeenCalled();
      },
    );

    it('an owner whose only worklist plan is terminal (count 0) with a DEAD holder is vacant', async () => {
      holderLiveness('lost');
      const verdict = await verdictFor({ liveWorklistPlans: 0 });
      expect(verdict).toMatchObject({ allowed: true, reason: 'stale-owner-edge-vacant' });
      expect(verdict.ownerState).toEqual({
        disposition: null,
        standing: false,
        liveWorklistPlans: 0,
        holderLiveness: 'lost',
      });
      expect(goalHoldersMock).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, goalId: ownerGoal });
    });

    it.each(['held', 'unheld', 'unknown'] as const)(
      'no worklist but holder %s keeps the edge LIVE (a just-created or live goal keeps its pot)',
      async (liveness) => {
        holderLiveness(liveness);
        const verdict = await verdictFor({ liveWorklistPlans: 0 });
        expect(verdict).toMatchObject({ allowed: false, reason: 'different-active-goal-owns-pot' });
        expect(verdict.ownerState?.holderLiveness).toBe(liveness);
      },
    );

    it('an unreadable presence oracle is UNKNOWN, never dead — the guard keeps refusing', async () => {
      goalHoldersMock.mockImplementationOnce(async () => {
        throw new Error('oracle down');
      });
      const verdict = await verdictFor({ liveWorklistPlans: 0 });
      expect(verdict).toMatchObject({ allowed: false });
      expect(verdict.ownerState?.holderLiveness).toBe('unknown');
    });

    it('a STANDING goal is not released by a recorded disposition alone', async () => {
      holderLiveness('held');
      const verdict = await verdictFor({ liveWorklistPlans: 0, disposition: 'killed', standing: true });
      expect(verdict).toMatchObject({ allowed: false });
      expect(verdict.ownerState).toMatchObject({ standing: true, holderLiveness: 'held' });
    });

    it('measures the worklist over non-archived, non-terminal plans using the plan grammar', async () => {
      const seen: string[] = [];
      await verdictFor({ liveWorklistPlans: 1 }, seen);
      const query = seen.find((text) => text.includes('FROM harness_shared.goal_pots gp')) ?? '';
      expect(query).toContain('FROM harness_shared.harness_plans hp');
      expect(query).toContain('NOT COALESCE(hp.archived, false)');
      expect(query).toContain('hp.goal_id = g.id');
      expect(query).toContain("g.properties->'worklist'->'value'");
      expect(query).toContain("g.status = 'active'");
    });
  });

  it('propagates an unreadable authority store so mutation doors can fail closed', async () => {
    await expect(
      resolveGoalPotPlacementAuthority({
        workspaceId: WS,
        launcherGoalId: 'goal-work-on-everything',
        harnessSlug: 'sidestage',
        sql: mockSql({ failOn: /FROM harness_shared\.goal_pots gp/ }),
      }),
    ).rejects.toThrow('boom');
  });
});

describe('R-4 / D-032 behaviour-experiment arm', () => {
  it('accepts each closed arm and null, and refuses an unknown arm', () => {
    for (const behaviorArm of ['baseline', 'brief-only', 'full', null] as const) {
      expect(goalLaunchSettingsSchema.safeParse({ behaviorArm }).success).toBe(true);
    }
    expect(goalLaunchSettingsSchema.safeParse({ behaviorArm: 'no-brief' }).success).toBe(false);
  });

  it("resolves absent, null and unknown values to 'full' (today's behaviour)", () => {
    expect(resolveGoalBehaviorArm(null)).toBe('full');
    expect(resolveGoalBehaviorArm({})).toBe('full');
    expect(resolveGoalBehaviorArm({ behaviorArm: null })).toBe('full');
    expect(resolveGoalBehaviorArm({ behaviorArm: 'bogus' })).toBe('full');
    expect(resolveGoalBehaviorArm({ behaviorArm: 'baseline' })).toBe('baseline');
  });

  it('maps each arm to exactly what it withholds', () => {
    expect([goalArmWithholdsBrief('full'), goalArmWithholdsReminders('full')]).toEqual([false, false]);
    expect([goalArmWithholdsBrief('brief-only'), goalArmWithholdsReminders('brief-only')]).toEqual([false, true]);
    expect([goalArmWithholdsBrief('baseline'), goalArmWithholdsReminders('baseline')]).toEqual([true, true]);
  });

  it('reads the arm from the goal row and fails soft toward full on a read error', async () => {
    await expect(goalWithholdsTurnStartReminders('g', async () => ({ settings: { behaviorArm: 'brief-only' } }))).resolves.toBe(true);
    await expect(goalWithholdsTurnStartReminders('g', async () => ({ settings: null }))).resolves.toBe(false);
    await expect(goalWithholdsTurnStartReminders('g', async () => { throw new Error('pg down'); })).resolves.toBe(false);
  });
});

describe('goalLaunchSettingsSchema', () => {
  it('accepts a full document', () => {
    const doc: GoalLaunchSettings = {
      maxAgents: 12,
      maxPerFleet: 4,
      defaults: { agent: 'claude', model: 'sonnet', effort: 'high', carry: 'warm' },
      roles: { grading: { model: 'opus', effort: 'xhigh', account: 'auto' } },
    };
    expect(goalLaunchSettingsSchema.safeParse(doc).success).toBe(true);
  });

  it('REJECTS an unknown key rather than silently dropping it', () => {
    // The owner hand-edits this in the P-005 panel. A typo that parses is a
    // setting that reads back as present while the launch ignores it.
    const r = goalLaunchSettingsSchema.safeParse({ maxAgent: 5 });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside a role profile too', () => {
    expect(goalLaunchSettingsSchema.safeParse({ roles: { grading: { modle: 'opus' } } }).success).toBe(false);
  });

  it('rejects a non-positive ceiling — 0 agents is a paused goal, not a launch policy', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 0 }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: -1 }).success).toBe(false);
  });

  it('allows null — which since D-015 means "unpinned", not "no ceiling"', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: null }).success).toBe(true);
  });

  it('accepts the explicit unlimited literal on either ceiling', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: UNLIMITED_CEILING }).success).toBe(true);
    expect(goalLaunchSettingsSchema.safeParse({ maxPerFleet: UNLIMITED_CEILING }).success).toBe(true);
  });

  it('rejects any OTHER string, so a typo cannot read as an opt-out', () => {
    // 'unlimted' silently accepted would store a ceiling nobody enforces while
    // the panel shows it as set — the exact class .strict() exists to catch, one
    // level down at the value.
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 'unlimted' }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 'none' }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: '12' }).success).toBe(false);
  });

  it('constrains carry and contextSize to the values psu honours', () => {
    expect(launchProfileSchema.safeParse({ carry: 'warm' }).success).toBe(true);
    expect(launchProfileSchema.safeParse({ carry: 'hot' }).success).toBe(false);
    expect(launchProfileSchema.safeParse({ contextSize: 'trimmed' }).success).toBe(true);
    // WI-2140338: steward is the explicit opt-in intermediate seed a goal
    // profile may pin; 'full' stays retired (WI-4608).
    expect(launchProfileSchema.safeParse({ contextSize: 'steward' }).success).toBe(true);
    expect(launchProfileSchema.safeParse({ contextSize: 'full' }).success).toBe(false);
    expect(launchProfileSchema.safeParse({ contextSize: 'medium' }).success).toBe(false);
  });

  // ── P-002: the holder policy (goal-live-holder-guarantee-2026-08-18) ──────────
  it('accepts a holder policy on the settings document', () => {
    expect(goalLaunchSettingsSchema.safeParse({ holder: { requireLive: true, onLoss: 'deactivate' } }).success).toBe(
      true,
    );
    expect(goalLaunchSettingsSchema.safeParse({ holder: { onLoss: 'respawn' } }).success).toBe(true);
  });

  it('REJECTS an unknown key inside the holder policy too — .strict() on BOTH levels', () => {
    // Same class as the ceiling typo: `requiresLive` silently accepted would read
    // back in the panel as a policy that is set, while the resolver applies the
    // default and nothing enforces what the owner thinks they declared.
    expect(goalLaunchSettingsSchema.safeParse({ holder: { requiresLive: true } }).success).toBe(false);
    expect(goalHolderPolicySchema.safeParse({ onLos: 'deactivate' }).success).toBe(false);
  });

  it('rejects an onLoss value outside the closed set, so a typo cannot read as a policy', () => {
    expect(goalHolderPolicySchema.safeParse({ onLoss: 'deactivte' }).success).toBe(false);
    expect(goalHolderPolicySchema.safeParse({ onLoss: 'restart' }).success).toBe(false);
    expect(goalHolderPolicySchema.safeParse({ onLoss: '' }).success).toBe(false);
  });

  it('rejects a non-boolean requireLive — "false" the string is not false', () => {
    expect(goalHolderPolicySchema.safeParse({ requireLive: 'false' }).success).toBe(false);
    expect(goalHolderPolicySchema.safeParse({ requireLive: 0 }).success).toBe(false);
  });

  it('accepts null on either field and on the policy itself — the panel clears with null', () => {
    expect(goalHolderPolicySchema.safeParse({ requireLive: null, onLoss: null }).success).toBe(true);
    expect(goalLaunchSettingsSchema.safeParse({ holder: null }).success).toBe(true);
  });

  it('every value the closed set admits actually parses', () => {
    // The schema and the closed set are one declaration; this fails if they ever
    // become two (the D-011 drift, one level down at the value).
    for (const v of GOAL_HOLDER_ON_LOSS) {
      expect(goalHolderPolicySchema.safeParse({ onLoss: v }).success, v).toBe(true);
    }
  });
});

describe('resolveGoalHolderPolicy — read-time defaults (D-001, D-008)', () => {
  it('covers a goal that has pinned NOTHING — the case the defaults exist for', () => {
    // The measured exposure this addresses: 4 of 6 active goals had been dark for
    // days, and of 18 goals in the workspace only 3 carry launch_settings at all.
    // A create-time default would have reached none of them.
    for (const stored of [null, undefined, {} as GoalLaunchSettings, { holder: null }]) {
      const p = resolveGoalHolderPolicy(stored as GoalLaunchSettings | null);
      expect(p.requireLive).toBe(true);
      expect(p.onLoss).toBe('deactivate');
      expect(p.isDefault).toBe(true);
    }
  });

  it('defaults onLoss to deactivate — a goal earns respawn only by being NAMED (D-001)', () => {
    expect(resolveGoalHolderPolicy({ holder: { requireLive: true } }).onLoss).toBe('deactivate');
    expect(resolveGoalHolderPolicy({ holder: { onLoss: 'respawn' } }).onLoss).toBe('respawn');
  });

  it('an EXPLICIT false is the opt-out, and is not confused with absent', () => {
    // The whole three-way distinction. Collapsing absent into false would opt
    // every existing goal out of the guarantee silently; collapsing false into
    // absent would make the opt-out unsayable.
    const optedOut = resolveGoalHolderPolicy({ holder: { requireLive: false } });
    expect(optedOut.requireLive).toBe(false);
    expect(optedOut.isDefault).toBe(false);

    const unpinned = resolveGoalHolderPolicy({ holder: { requireLive: null } });
    expect(unpinned.requireLive).toBe(true);
    expect(unpinned.isDefault).toBe(true);
  });

  it('isDefault is false as soon as EITHER field is pinned', () => {
    expect(resolveGoalHolderPolicy({ holder: { onLoss: 'deactivate' } }).isDefault).toBe(false);
    expect(resolveGoalHolderPolicy({ holder: { requireLive: true } }).isDefault).toBe(false);
  });

  it('resolves through a document that came back from the SCHEMA, not just a literal', () => {
    // Guards the seam that actually runs in production: stored jsonb -> parse ->
    // resolve. A resolver tested only against hand-written literals can drift
    // from what the parser actually produces.
    const parsed = goalLaunchSettingsSchema.parse({
      maxAgents: 4,
      holder: { requireLive: false, onLoss: 'respawn' },
    });
    expect(resolveGoalHolderPolicy(parsed)).toEqual({
      requireLive: false,
      onLoss: 'respawn',
      isDefault: false,
    });
  });

  it('an existing stored document with no holder key still resolves — no migration needed', () => {
    // Measured 2026-08-19: 3 of 18 goals carry launch_settings, 0 carry `holder`.
    // This is the exact shape of a live row (a-working-browsable-visual-... ).
    const legacy = goalLaunchSettingsSchema.parse({ maxAgents: 6, maxPerFleet: 3 });
    expect(resolveGoalHolderPolicy(legacy)).toEqual({
      requireLive: true,
      onLoss: 'deactivate',
      isDefault: true,
    });
  });
});

/* ── the write-boundary rule (P-003) ──────────────────────────────────────────
   The ONE definition every door refuses on, so `goals:create`, `goals:start` and
   GOAL-mode attach cannot drift into three different answers. Its whole job is
   to keep the population of goals-nobody-chose-a-policy-for from GROWING, while
   D-008's read-time default covers the ones that already exist. ── */
describe('drainFleetTopologyProblem — ceilings must hold the drain worker (EI-24556293106348130)', () => {
  it('refuses the measured leader-only shape and names both short ceilings', () => {
    const problem = drainFleetTopologyProblem({ maxAgents: 2, maxPerFleet: 1 });
    expect(problem).toContain('maxAgents=2');
    expect(problem).toContain('maxPerFleet=1');
    expect(problem).toContain("'unlimited'"); // names the way out, not just the problem
  });

  it('names only the ceiling that is actually short', () => {
    const problem = drainFleetTopologyProblem({ maxAgents: 2, maxPerFleet: 5 });
    expect(problem).toContain('maxAgents=2');
    expect(problem).not.toContain('maxPerFleet=');
    expect(drainFleetTopologyProblem({ maxAgents: 12, maxPerFleet: 1 })).toContain('maxPerFleet=1');
  });

  it('admits ceilings exactly at the floor, unlimited ceilings, and undeclared ones', () => {
    expect(drainFleetTopologyProblem({ ...DRAIN_FLEET_MIN_CEILINGS })).toBeNull();
    expect(drainFleetTopologyProblem({ maxAgents: 'unlimited', maxPerFleet: 'unlimited' })).toBeNull();
    expect(drainFleetTopologyProblem(null)).toBeNull();
    expect(drainFleetTopologyProblem({})).toBeNull();
  });

  it('the floor is the real launch topology, and the system defaults clear it', () => {
    // holder + drain leader + one worker per goal; leader + worker per fleet.
    expect(DRAIN_FLEET_MIN_CEILINGS).toEqual({ maxAgents: 3, maxPerFleet: 2 });
    // A default lowered below the floor would strand EVERY goal that pins nothing.
    expect(GOAL_LAUNCH_DEFAULTS.maxAgents).toBeGreaterThanOrEqual(DRAIN_FLEET_MIN_CEILINGS.maxAgents);
    expect(GOAL_LAUNCH_DEFAULTS.maxPerFleet).toBeGreaterThanOrEqual(DRAIN_FLEET_MIN_CEILINGS.maxPerFleet);
  });
});

describe('goalHolderPolicyProblem — the P-003 write boundary', () => {
  it('REFUSES a goal that declares nothing (the case the item exists for)', () => {
    const problem = goalHolderPolicyProblem(null);
    expect(problem).not.toBeNull();
    // The refusal must name the way OUT, not just the problem — the same
    // contract killCriterionProblem's callers rely on.
    expect(problem).toMatch(/requireLive/);
  });

  it('treats an EMPTY document and a document with no holder key identically', () => {
    // Both mean "nobody answered". A door that admitted one and refused the
    // other would make the gate depend on whether some unrelated ceiling
    // happened to be set.
    expect(goalHolderPolicyProblem({})).not.toBeNull();
    expect(goalHolderPolicyProblem({ maxAgents: 6 })).not.toBeNull();
  });

  it('ADMITS an explicit opt-out — requireLive:false is a declaration, not an absence', () => {
    expect(goalHolderPolicyProblem({ holder: { requireLive: false } })).toBeNull();
  });

  it('ADMITS an explicit opt-in', () => {
    expect(goalHolderPolicyProblem({ holder: { requireLive: true } })).toBeNull();
  });

  it('ADMITS a goal that pinned only onLoss — engaging with the policy IS declaring it', () => {
    // isDefault, not `requireLive == null`, is what the rule reads: pinning
    // either field means somebody thought about the holder question and took
    // the other default knowingly.
    expect(goalHolderPolicyProblem({ holder: { onLoss: 'respawn' } })).toBeNull();
    expect(goalHolderPolicyProblem({ holder: { onLoss: 'deactivate' } })).toBeNull();
  });

  it('REFUSES a null-cleared policy — clearing is unpinning, not opting out', () => {
    // The P-005 panel clears a field by writing null. That must land back on
    // "undeclared" (and so be refused at a write boundary), never be mistaken
    // for the explicit `false` opt-out.
    expect(goalHolderPolicyProblem({ holder: { requireLive: null } })).not.toBeNull();
    expect(goalHolderPolicyProblem({ holder: { requireLive: null, onLoss: null } })).not.toBeNull();
  });

  it('CONTROL: the rule reads requireLive, so an opted-out goal is admitted even unpinned elsewhere', () => {
    // Without this, every assertion above still passes if the predicate simply
    // returned a message for EVERY input — strict-looking and broken, with the
    // suite unable to tell the difference.
    expect(goalHolderPolicyProblem({ holder: { requireLive: false, onLoss: 'deactivate' } })).toBeNull();
  });
});

describe('foldLaunchProfile', () => {
  const settings: GoalLaunchSettings = {
    defaults: { model: 'sonnet', effort: 'medium', carry: 'warm' },
    roles: { grading: { model: 'opus' } },
  };

  it('layers the slot profile over defaults', () => {
    expect(foldLaunchProfile(settings, 'grading')).toEqual({
      model: 'opus',
      effort: 'medium',
      carry: 'warm',
    });
  });

  it('falls back to defaults for a slot with no profile', () => {
    expect(foldLaunchProfile(settings, 'test').model).toBe('sonnet');
  });

  it('lets an explicit caller request beat the stored policy', () => {
    // The settings are standing policy; a value the caller just chose
    // deliberately for THIS launch is not something policy should override.
    expect(foldLaunchProfile(settings, 'grading', { model: 'haiku' }).model).toBe('haiku');
  });

  it('leaves an unset key ABSENT so the composer applies the system default', () => {
    // Not `account: undefined` and not an invented value — absent, so
    // buildAgentLaunchCommand reaches defaultLaunchAccount() as it does today.
    expect('account' in foldLaunchProfile(settings, 'grading')).toBe(false);
  });

  it('ignores empty strings from a half-filled form', () => {
    expect(foldLaunchProfile(settings, 'grading', { model: '' }).model).toBe('opus');
  });

  it('returns an empty profile when a goal has no settings at all', () => {
    expect(foldLaunchProfile(null, 'grading')).toEqual({});
  });
});

describe('D-016 / WI-38048 — profiles bind by launch SLOT, never by psu --role', () => {
  // THE DEFECT THIS PINS. `roles` used to take free-text keys and the launch
  // doors looked them up by psu `--role`. Persona is `su` for ~every session
  // (measured: 121 of 124 live), so a profile the owner configured for a
  // contract slot matched nothing — the panel read as configured while every
  // launch ignored it. Both halves are asserted here: a psu role can no longer
  // be STORED, and a real slot actually BINDS.

  it('accepts every slot the GOAL contract enumerates', () => {
    // Guards the count too: the contract lists SEVEN slots and goals:start uses
    // an eighth (`goal`). WI-38048's own prose said "six" — building to that
    // number silently refuses two slots that are already in use.
    //
    // 8 → 12 (P-005 of goal-launch-headless-and-fleet-type-2026-08-26): a paired
    // fleet splits each family into directors and implementers whose knobs are
    // independent by design, so `plan-` and `drain-fleet-{director,implementer}`
    // are four MORE real slots. Without them a goal could declare
    // fleetType:'paired' and have nothing to say about either half.
    //
    // The number is asserted rather than derived on purpose: this guard's whole
    // job is to make growing the closed set a DELIBERATE act. Every launch door
    // looks profiles up by these keys, so a slot added without a binding site is
    // the WI-38048 failure again — configured in the panel, binding nothing.
    expect(GOAL_LAUNCH_ROLES).toHaveLength(12);
    for (const slot of GOAL_LAUNCH_ROLES) {
      const r = goalLaunchSettingsSchema.safeParse({ roles: { [slot]: { model: 'opus' } } });
      expect(r.success, `slot ${slot} should be storable`).toBe(true);
    }
  });

  it('REFUSES a psu --role as a profile key — the exact key the old doors passed', () => {
    // `su` is what launch-on-plan / launch-agent / fleet-headcount-action all
    // fed the lookup. Storing it has to fail at WRITE time, because a stored
    // key that binds nothing is indistinguishable from a working setting.
    expect(goalLaunchSettingsSchema.safeParse({ roles: { su: { model: 'opus' } } }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ roles: { scout: { model: 'opus' } } }).success).toBe(false);
  });

  it('REFUSES free-text keys generally, so a typo cannot masquerade as a slot', () => {
    for (const key of ['reviewer', 'builder', 'dev', 'plan-fleet-membr', '']) {
      expect(
        goalLaunchSettingsSchema.safeParse({ roles: { [key]: { model: 'opus' } } }).success,
        `key ${JSON.stringify(key)} must not be storable`,
      ).toBe(false);
    }
  });

  it('BINDS: a slot profile reaches the effective launch knobs, not just the document', () => {
    // D-016's verification standard — prove BINDING, not WRITING. The old code
    // saved this document perfectly well and bound none of it.
    const settings: GoalLaunchSettings = {
      defaults: { model: 'sonnet' },
      roles: {
        'plan-fleet-member': { model: 'opus', effort: 'xhigh' },
        'drain-fleet-member': { model: 'haiku' },
      },
    };
    expect(foldLaunchProfile(settings, 'plan-fleet-member')).toEqual({
      model: 'opus',
      effort: 'xhigh',
    });
    // and the slots do not bleed into one another
    expect(foldLaunchProfile(settings, 'drain-fleet-member').model).toBe('haiku');
    expect(foldLaunchProfile(settings, 'grading').model).toBe('sonnet');
  });

  it('isGoalLaunchRole separates a slot from a persona', () => {
    expect(isGoalLaunchRole('plan-fleet-leader')).toBe(true);
    expect(isGoalLaunchRole('goal')).toBe(true);
    expect(isGoalLaunchRole('su')).toBe(false);
    expect(isGoalLaunchRole(undefined)).toBe(false);
  });
});

describe('the schema accepts/refuses `headless` and `fleetType` (P-007)', () => {
  // Both keys shipped in Phase 1/2 without a schema test. `.strict()` is what
  // makes a typo'd key a WRITE-time refusal instead of a stored setting that
  // reads as configured and is silently ignored — so it is worth pinning that
  // these two are genuinely accepted, and that near-misses are genuinely not.
  const parse = (o: Record<string, unknown>) => goalLaunchSettingsSchema.safeParse(o);

  it('accepts an explicit headless boolean on a profile, either way round', () => {
    expect(parse({ defaults: { headless: true } }).success).toBe(true);
    expect(parse({ defaults: { headless: false } }).success).toBe(true);
  });

  it("REFUSES the editor's word-form — the stored key is a real boolean (D-002)", () => {
    // LAUNCH_PROFILE_HEADLESS ('headless'/'headed') is the editor's RENDERING,
    // converted at the form boundary. If those words could be stored, the goal
    // record and the fleet layer would hold two spellings of one concept.
    expect(parse({ defaults: { headless: 'headed' } }).success).toBe(false);
    expect(parse({ defaults: { headless: 'true' } }).success).toBe(false);
  });

  it('leaves an absent headless UNPINNED — undefined, never false (D-002)', () => {
    // The whole reason the default resolves to `true` downstream: absent must
    // stay distinguishable from an explicit false, or adding the key would have
    // silently re-pointed every stored goal at a visible terminal.
    const r = parse({ defaults: { model: 'opus' } });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.defaults?.headless).toBeUndefined();
    expect('headless' in (r.data.defaults ?? {})).toBe(false);
  });

  it('accepts both fleet shapes, sourced from FLEET_TYPES', () => {
    expect(parse({ fleetType: 'single' }).success).toBe(true);
    expect(parse({ fleetType: 'paired' }).success).toBe(true);
  });

  it("REFUSES a plausible near-miss like 'singular'", () => {
    // Worth an explicit case: 'singular' is the word people reach for, and a
    // silently-stored one would read as configured in the panel while
    // resolveLaunchOptions branched to single anyway.
    expect(parse({ fleetType: 'singular' }).success).toBe(false);
    expect(parse({ fleetType: 'pair' }).success).toBe(false);
  });

  it('leaves an absent fleetType undefined so the default stays invisible', () => {
    const r = parse({ maxAgents: 3 });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.fleetType).toBeUndefined();
  });
});

describe('P-020 intended parallel plan fleets', () => {
  it('accepts a deliberate width independently of either ceiling', () => {
    const result = goalLaunchSettingsSchema.safeParse({
      intendedParallelPlanFleets: 3,
      maxAgents: 2,
      maxPerFleet: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.intendedParallelPlanFleets).toBe(3);
    for (const width of [0, -1, 1.5, 101, '3', 'unlimited']) {
      expect(goalLaunchSettingsSchema.safeParse({ intendedParallelPlanFleets: width }).success).toBe(false);
    }
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 12 }).success).toBe(true);
  });
});

describe('readGoalLaunchSettings', () => {
  it('reports "none declared" for a NULL column — the common case, not an error', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: null } }));
    expect(r).toEqual({
      settings: null,
      error: null,
      // P-006: budget truth rides the same row read; a goal with nothing
      // declared resolves an all-null truth, not an absent one.
      // P-004: the provenance marker rides along with the cents so the ceiling
      // refusal can name the population its number measured.
      budget: {
        budgetCents: null,
        spentCents: null,
        // WI-10002052: nothing declared and nothing ticked — no unmeasured spend
        // to flag, which is what keeps this goal on the fail-open path.
        unmeasuredPricedSpend: false,
        spentCentsAt: null,
        spentCentsSource: null,
        interactiveUsageFreshnessStatus: null,
        interactiveUsageLastIngestedAtMs: null,
      },
      brief: {
        title: 'Goal g1',
        body: null,
        killCriterion: null,
        budgetCents: null,
        budgetWindowSec: null,
        standing: false,
      },
      // P-006 (goal-launch-headless-and-fleet-type): the drain-fleet declaration
      // rides that same row too, for the same reason — the launch boundary needs
      // it to pick a slot family, and a second round-trip per launch to read one
      // jsonb key would be pure overhead.
      drainFleetSlug: null,
      // WI-2140573: nothing was stripped from a NULL document.
      unknownKeys: [],
    });
  });

  it('parses a jsonb string as readily as an object', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: '{"maxAgents":3}' } }));
    expect(r.settings?.maxAgents).toBe(3);
  });

  it('returns the canonical holder-brief fields from the same row, with bigint numerics coerced', async () => {
    const r = await readGoalLaunchSettings(
      'g1',
      mockSql({
        settings: { g1: null },
        budget: { g1: { budget_cents: '2500' } },
        brief: {
          g1: {
            title: 'Work on everything',
            body: 'Keep the frontier moving.',
            kill_criterion: 'the owner stops the standing duty',
            budget_window_sec: '604800',
            standing: true,
          },
        },
      }),
    );
    expect(r.brief).toEqual({
      title: 'Work on everything',
      body: 'Keep the frontier moving.',
      killCriterion: 'the owner stops the standing duty',
      budgetCents: 2_500,
      budgetWindowSec: 604_800,
      standing: true,
    });
  });

  it('reports a MALFORMED document as an error instead of treating it as absent', async () => {
    // Absent means "no ceiling declared" — a legitimate state. Malformed means
    // the owner declared one and it is NOT in force. Collapsing the two hides
    // exactly the case they need to hear about.
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: { maxAgents: -5 } } }));
    expect(r.settings).toBeNull();
    expect(r.error).toMatch(/invalid/i);
  });

  it('fails soft on a dead database', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ failOn: /goals/ }));
    expect(r.settings).toBeNull();
    expect(r.error).toBe('boom');
  });

  it('threads the lenient read’s stripped keys through the row read (WI-2140573)', async () => {
    const r = await readGoalLaunchSettings(
      'g1',
      mockSql({ settings: { g1: { holder: { onLoss: 'respawn' }, notAKey: 1 } } }),
    );
    expect(r.error).toBeNull();
    expect(r.settings?.holder?.onLoss).toBe('respawn');
    expect(r.unknownKeys).toEqual(['notAKey']);
  });
});

describe('parseGoalLaunchSettings — READ-lenient on unknown keys, STRICT on values (WI-2140573)', () => {
  // The measured safety-net kill: a key written by a NEWER schema than the
  // reading host runs (bg-host's bundle predated `roles.goal.compactionLimit`)
  // made the WHOLE document parse to null, so `holder.onLoss='respawn'` silently
  // stopped being in force on the one goal it protected. Deliberately-fake key
  // names below, so the test cannot go stale when a real key is added.
  const doc = {
    maxAgents: 12,
    holder: { onLoss: 'respawn', requireLive: true },
    roles: { goal: { model: 'opus', notYetAProfileKey: 'steward' } },
    notYetATopLevelKey: { seed: 'intermediate' },
  };

  it('keeps every KNOWN key in force and reports the stripped paths — nested AND top-level', () => {
    const r = parseGoalLaunchSettings(doc, 'goal g1 launch_settings');
    expect(r.error).toBeNull();
    expect(r.settings?.holder?.onLoss).toBe('respawn');
    expect(r.settings?.maxAgents).toBe(12);
    expect(r.settings?.roles?.goal?.model).toBe('opus');
    expect([...r.unknownKeys].sort()).toEqual(['notYetATopLevelKey', 'roles.goal.notYetAProfileKey']);
  });

  it('never mutates the caller’s document — it is usually a row still in use', () => {
    const before = JSON.stringify(doc);
    parseGoalLaunchSettings(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('stays STRICT on a bad VALUE: the document is invalid, and the stripped keys are still named', () => {
    const r = parseGoalLaunchSettings({ ...doc, maxAgents: -5 }, 'goal g1 launch_settings');
    expect(r.settings).toBeNull();
    expect(r.error).toMatch(/invalid/i);
    expect([...r.unknownKeys].sort()).toEqual(['notYetATopLevelKey', 'roles.goal.notYetAProfileKey']);
  });

  it('reports NO unknown keys on a clean document, on none-declared, and on unreadable JSON', () => {
    expect(parseGoalLaunchSettings({ maxAgents: 3 })).toEqual({
      settings: { maxAgents: 3 },
      error: null,
      unknownKeys: [],
    });
    expect(parseGoalLaunchSettings(null)).toEqual({ settings: null, error: null, unknownKeys: [] });
    const unreadable = parseGoalLaunchSettings('{not json');
    expect(unreadable.settings).toBeNull();
    expect(unreadable.error).toMatch(/unreadable/i);
    expect(unreadable.unknownKeys).toEqual([]);
  });

  it('reads a jsonb STRING the same way', () => {
    const r = parseGoalLaunchSettings(JSON.stringify(doc));
    expect(r.settings?.holder?.onLoss).toBe('respawn');
    expect(r.unknownKeys).toContain('roles.goal.notYetAProfileKey');
  });

  it('the WRITE boundary is untouched — the same document is still refused by the strict schema', () => {
    expect(goalLaunchSettingsSchema.safeParse(doc).success).toBe(false);
    // And the lenient read is not a licence for a strict-valued typo to land.
    expect(goalLaunchSettingsSchema.safeParse({ maxAgent: 5 }).success).toBe(false);
  });
});

describe('writeGoalLaunchSettings', () => {
  it('refuses to persist an invalid document', async () => {
    const r = await writeGoalLaunchSettings('g1', { maxAgents: 0 } as GoalLaunchSettings, mockSql());
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('accepts null as an explicit clear', async () => {
    const seen: string[] = [];
    const r = await writeGoalLaunchSettings('g1', null, mockSql({ seen }));
    expect(r.ok).toBe(true);
    expect(seen.some((s) => s.includes('UPDATE harness_shared.goals'))).toBe(true);
  });
});

describe('writeGoalLaunchSettings — drain-fleet floor after start (WI-10004407)', () => {
  /**
   * A goal row whose metadata.drainFleet is `drainFleet` (null = sole-member goal)
   * and whose stored launch_settings is `stored`.
   */
  function goalSql(drainFleet: string | null, seen: string[], stored: unknown = null): Sql {
    const fn = (first: unknown): unknown => {
      const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
      seen.push(text);
      // The full read (readGoalLaunchSettings) also selects drainFleet, so match it first.
      if (text.includes('SELECT title, body, kill_criterion')) {
        return Promise.resolve([
          { title: 'g1', body: null, kill_criterion: null, standing: false, launch_settings: stored, drain_fleet: drainFleet },
        ]);
      }
      if (text.includes("metadata->>'drainFleet'")) return Promise.resolve([{ drain_fleet: drainFleet }]);
      return Promise.resolve([]);
    };
    return fn as unknown as Sql;
  }
  const wroteColumn = (seen: string[]) => seen.some((s) => s.includes('SET launch_settings'));

  it('refuses ceilings below the floor on a goal that runs a drain fleet, and writes nothing', async () => {
    const seen: string[] = [];
    const r = await writeGoalLaunchSettings('g1', { maxAgents: 2, maxPerFleet: 1 }, goalSql('goal-drain-g1', seen));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('maxAgents=2');
    expect(r.error).toContain('maxPerFleet=1');
    expect(r.error).toContain('goal-drain-g1');
    expect(wroteColumn(seen)).toBe(false);
  });

  it('allows the same ceilings on a sole-member goal (no drain fleet)', async () => {
    const seen: string[] = [];
    const r = await writeGoalLaunchSettings('g1', { maxAgents: 1, maxPerFleet: 1 }, goalSql(null, seen));
    expect(r.ok).toBe(true);
    expect(wroteColumn(seen)).toBe(true);
  });

  it('does not read the goal row when the new ceilings already clear the floor', async () => {
    const seen: string[] = [];
    const r = await writeGoalLaunchSettings(
      'g1',
      { ...DRAIN_FLEET_MIN_CEILINGS },
      goalSql('goal-drain-g1', seen),
    );
    expect(r.ok).toBe(true);
    expect(seen.some((s) => s.includes("metadata->>'drainFleet'"))).toBe(false);
    expect(wroteColumn(seen)).toBe(true);
  });

  it('fails CLOSED when the goal row cannot be read', async () => {
    const r = await writeGoalLaunchSettings(
      'g1',
      { maxAgents: 2, maxPerFleet: 1 },
      mockSql({ failOn: /metadata->>'drainFleet'/ }),
    );
    expect(r.ok).toBe(false);
  });

  it('lets a drain-fleet goal clear to defaults or go unlimited', async () => {
    for (const settings of [null, { maxAgents: 'unlimited', maxPerFleet: 'unlimited' }] as const) {
      const seen: string[] = [];
      const r = await writeGoalLaunchSettings('g1', settings as GoalLaunchSettings | null, goalSql('goal-drain-g1', seen));
      expect(r.ok).toBe(true);
      expect(wroteColumn(seen)).toBe(true);
    }
  });

  it('binds the holder-policy merge door too, since it writes through the same writer', async () => {
    // declareGoalHolderPolicy reads the stored document, merges `holder`, and
    // writes through writeGoalLaunchSettings — so it cannot carry a below-floor
    // document onto a drain-fleet goal either.
    const refusedSeen: string[] = [];
    const refused = await declareGoalHolderPolicy(
      'g1',
      { onLoss: 'respawn' },
      goalSql('goal-drain-g1', refusedSeen, { maxAgents: 2, maxPerFleet: 1 }),
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('goal-drain-g1');
    expect(wroteColumn(refusedSeen)).toBe(false);

    const okSeen: string[] = [];
    const ok = await declareGoalHolderPolicy(
      'g1',
      { onLoss: 'respawn' },
      goalSql('goal-drain-g1', okSeen, { maxAgents: 6, maxPerFleet: 3 }),
    );
    expect(ok.ok).toBe(true);
    expect(wroteColumn(okSeen)).toBe(true);
  });
});

describe('resolveGoalLaunch — goal resolution', () => {
  it('resolves the goal from the LAUNCHER and takes no goalId argument', async () => {
    // Structural: the signature has no goalId. This asserts the behaviour that
    // makes that safe — a launcher running a goal yields that goal with nothing
    // passed in.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' } }),
    });
    expect(r.goalId).toBe('g1');
  });

  it('resolves the INHERITED goal for a launcher that merely works under one', async () => {
    // Transitivity: a fleet member spawning a helper keeps the goal, so the
    // grandchild is bounded by the same ceiling as the goal agent's own spawns.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-member',
      sql: mockSql({ inherited: { 'su-member': 'g1' } }),
    });
    expect(r.goalId).toBe('g1');
  });

  it('is inert with no goal in scope — no ceiling, no profile, not degraded', async () => {
    const r = await resolveGoalLaunch({ workspaceId: WS, launcherOwnerId: 'su-x', sql: mockSql() });
    expect(r.goalId).toBeNull();
    expect(r.refusal).toBeNull();
    expect(r.ceilings).toEqual({ maxAgents: null, maxPerFleet: null });
    expect(r.degraded).toBe(false);
  });
});

describe('an UNREADABLE holder-authority store degrades, it does not throw the launch (WI-1195329)', () => {
  // 02d9c38d1f widened GoalHolderAuthorityError from "the store said SUPERSEDED"
  // to also mean "the store could not be read". Both read doors below rethrew it
  // unconditionally, so a transient DB failure hard-failed a fleet launch —
  // contradicting their own documented contract ("never a thrown launch") and
  // red-ing 94 launch-on-plan unit tests, where pg() refuses a real connection.
  //
  // These pin the READ doors as fail-soft. The MUTATION fence
  // (assertGoalHolderMutationAuthority) still refuses both conditions by design;
  // that asymmetry is the whole point and must not be "simplified" away.
  const unreadable = () => mockSql({ failOn: /agent_modes/ });

  it('readGoalLaunchSettingsForLauncher degrades with a reason instead of throwing', async () => {
    const r = await readGoalLaunchSettingsForLauncher({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: unreadable(),
    });
    expect(r.goalId).toBeNull();
    expect(r.settings).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/goal context unresolved/);
  });

  it('resolveGoalLaunch degrades instead of throwing, and imposes no ceiling', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: unreadable(),
    });
    expect(r.goalId).toBeNull();
    // Load-bearing: an unreadable store must not silently become a REFUSAL either.
    expect(r.refusal).toBeNull();
    expect(r.ceilings).toEqual({ maxAgents: null, maxPerFleet: null });
    expect(r.degraded).toBe(true);
  });

  it('says WHY it degraded — an unexplained degrade is undebuggable in production', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: unreadable(),
    });
    // The underlying authority message must survive into the reason, so an
    // operator can tell a storage blip from a genuine absence of goal context.
    expect(r.degradedReasons.join(' ')).toMatch(/unreadable|goal context unresolved/i);
  });

  // The other half of the same fix, and the reason it is a CODE test and not a
  // blanket try/catch: a SUPERSEDED caller must still be refused. Degrading
  // here would let an agent whose lease was taken keep launching under the old
  // goal's ceiling — the exact thing the fence exists to stop. If someone
  // "simplifies" isFatalGoalHolderVerdict into catch-everything, these fail.
  const superseded = () =>
    mockSql({ modeSubject: { 'su-goal': 'g1' }, holder: { g1: { electedOwnerId: 'su-successor' } } });

  it('resolveGoalLaunch still THROWS for a superseded holder', async () => {
    await expect(
      resolveGoalLaunch({ workspaceId: WS, launcherOwnerId: 'su-goal', sql: superseded() }),
    ).rejects.toMatchObject({ code: 'goal_holder_superseded' });
  });

  it('readGoalLaunchSettingsForLauncher still THROWS for a superseded holder', async () => {
    await expect(
      readGoalLaunchSettingsForLauncher({ workspaceId: WS, launcherOwnerId: 'su-goal', sql: superseded() }),
    ).rejects.toMatchObject({ code: 'goal_holder_superseded' });
  });

  it('a LIVE handoff is not superseded — the predecessor still resolves its goal', async () => {
    // Pins the third status the reader can return, so a future narrowing of the
    // fence to "elected only" cannot pass by looking like the two cases above.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        holder: {
          g1: {
            electedOwnerId: 'su-successor',
            predecessorOwnerId: 'su-goal',
            handoffExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }),
    });
    expect(r.goalId).toBe('g1');
    expect(r.degraded).toBe(false);
  });
});

describe('resolveGoalLaunch — the D-005 ceilings', () => {
  const base = (settings: unknown, headcount: { total: number; fleet: number }) =>
    mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: settings }, headcount: { g1: headcount } });

  it('admits a launch with headroom', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: base({ maxAgents: 10 }, { total: 3, fleet: 0 }),
    });
    expect(r.refusal).toBeNull();
    expect(r.headcount.total).toBe(3);
  });

  it('refuses the N+1th agent', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: base({ maxAgents: 4 }, { total: 4, fleet: 0 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.limit).toBe(4);
    expect(r.refusal?.current).toBe(4);
  });

  it('refuses an over-large BATCH once, up front', async () => {
    // A fleet of 10 against room for 3 is refused here rather than discovered on
    // the 4th spawn with 3 half-briefed members already running.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      count: 10,
      sql: base({ maxAgents: 10 }, { total: 7, fleet: 0 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.requested).toBe(10);
  });

  it('refuses on the per-fleet cap', async () => {
    // maxAgents is opted out EXPLICITLY so this isolates the per-fleet leg.
    // Leaving it unset used to do that; since D-015 an unset ceiling is the
    // default (12), and a fixture with 20 live agents would be refused by the
    // GOAL leg before the fleet leg is ever reached — the test would still pass
    // for a while, then start asserting the wrong mechanism.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: base({ maxAgents: UNLIMITED_CEILING, maxPerFleet: 5 }, { total: 20, fleet: 5 }),
    });
    expect(r.refusal?.reason).toBe('fleet_max_agents');
  });

  it('COMPOSES: a fleet with room is still refused when the GOAL is full', async () => {
    // The load-bearing D-005 case. A per-fleet cap alone waves this through —
    // the fleet has 1 of 5 — and the goal quietly runs 12 agents against a
    // ceiling of 12. The goal ceiling must be checked independently of the fleet.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: base({ maxAgents: 12, maxPerFleet: 5 }, { total: 12, fleet: 1 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
  });

  it('skips the headcount query only when BOTH ceilings are explicitly unlimited', async () => {
    // The resolver is on every launch path; it must not add a count query to
    // launches it cannot refuse. Since D-015 that is the RARE case — a goal has
    // to have opted out of both ceilings by name to get here.
    const seen: string[] = [];
    await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING, maxPerFleet: UNLIMITED_CEILING } },
        seen,
      }),
    });
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(false);
  });
});

describe('P-012 authoritative GOAL portfolio brief', () => {
  const NOW = new Date('2026-08-28T02:30:00.000Z');
  const launch = {
    goalBrief: {
      title: 'Keep the portfolio moving',
      body: 'Supervise the ordered worklist without implementing it personally.',
      killCriterion: 'the owner stops the standing goal',
      budgetCents: 5_000,
      budgetWindowSec: 604_800,
      standing: true,
    },
    settings: null,
    budget: {
      budgetCents: 5_000,
      spentCents: 1_250,
      // Measured, so nothing unmeasured to flag (WI-10002052).
      unmeasuredPricedSpend: false,
      spentCentsAt: '2026-08-28T02:00:00Z',
      // The ordinary case: a rollup-written figure, so it carries the marker.
      spentCentsSource: 'goal-lineage-rollup',
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
    },
    ceilings: { maxAgents: 12, maxPerFleet: 5 },
    headcount: { total: 3, fleet: 2 },
    degradedReasons: [],
  };
  const portfolioRow = {
    status: 'active',
    parent_id: null,
    tripwires: [{ metric: 'queue_age', label: 'Queue age', threshold: 60, current: 12, unit: 'minutes' }],
    properties: { worklist: { value: ['plan:papercusp/alpha'] } },
    metadata: { drainFleet: 'goal-1-drain' },
    pots: [{ id: '42', harness: 'papercusp', role: 'owner', note: 'canonical pot', killCriterion: 'stop if no owner' }],
    plans: [
      {
        ref: 'plan:papercusp/alpha',
        ordinal: 1,
        harness: 'papercusp',
        slug: 'alpha',
        title: 'Alpha plan',
        status: 'active',
        goalId: 'goal-1',
        ambiguousMatches: 1,
        items: [
          { id: 'P-001', text: 'Done', status: 'done', phase: 'Build', blockedBy: [], seq: 1 },
          { id: 'P-002', text: 'Place next', status: 'todo', phase: 'Build', blockedBy: [], seq: 2 },
          { id: 'P-003', text: 'Wait', status: 'todo', phase: 'Verify', blockedBy: ['P-002'], seq: 3 },
        ],
      },
    ],
    ladder_work_items: [{ id: 'WI-42', harness: 'papercusp', planSlug: 'alpha', goalId: 'goal-1' }],
    queue: {
      total: 7,
      terminal: 2,
      inFlight: 2,
      blocked: 1,
      needsHuman: 1,
      issueCandidates: [],
    },
    drain_fleet: {
      slug: 'goal-1-drain',
      controlState: 'active',
      leaderOwnerId: 'su-drain',
      live: 2,
      working: 1,
    },
    checkpoint: {
      workItemId: 'WI-42',
      updatedAtMs: Date.parse('2026-08-28T02:15:00.000Z'),
      note: 'Placed P-001; P-002 is next.',
    },
    report_movements: [],
    owner_walls: [{ ref: 'WI-43', action: 'provide billing access' }],
    killed_work: [],
    blender_pending: 2,
    acceptance_rubric: {
      id: 'goal-mode-e2e',
      status: 'active',
      latestScorecardAt: '2026-08-28T01:28:33Z',
    },
  };

  it("claimability:'skip' leaves claimable unmeasured without running the per-id floor count", async () => {
    // Obligation readers never read queue.claimable, and the per-id claim-floor
    // SQL alone exceeded their optional-read budget on a 333-row goal queue.
    const explainIssueClaimFloors = vi.fn(async (_harness: string, ids: string[]) =>
      ids.map(() => ({ admissible: true })));
    vi.doMock('./work-items', () => ({ explainIssueClaimFloors }));
    try {
      const row = {
        ...portfolioRow,
        queue: {
          ...portfolioRow.queue,
          issueCandidates: [{ id: 'EI-1', harness: 'papercusp' }, { id: 'EI-2', harness: 'papercusp' }],
        },
      };
      const read = (claimability: 'count' | 'skip') => readGoalPortfolioBrief({
        workspaceId: WS,
        goalId: 'goal-1',
        sql: mockSql({ portfolio: { 'goal-1': row } }),
        now: NOW,
        launch,
        claimability,
      });

      // CONTROL: the count path reaches the mocked floor count, so the skip
      // assertion below cannot pass merely because the mock never bound.
      const counted = await read('count');
      expect(explainIssueClaimFloors).toHaveBeenCalledWith('papercusp', ['EI-1', 'EI-2']);
      expect(counted?.queue).toMatchObject({ claimable: 2, claimabilityScope: 'issue-family' });

      explainIssueClaimFloors.mockClear();
      const skipped = await read('skip');
      expect(explainIssueClaimFloors).not.toHaveBeenCalled();
      expect(skipped?.queue).toMatchObject({ claimable: null, claimabilityScope: 'not-requested' });
      expect(skipped?.degradedReasons.join(' ') ?? '').not.toContain('claimability unavailable');
    } finally {
      vi.doUnmock('./work-items');
    }
  });

  it("rubricStewardship:'skip' omits the stewardship read even for a goal with rubric duties (EI-25306440159635835)", async () => {
    // The stewardship read's identity graph was the slowest statement (455-500ms on
    // 60d3a8) inside the obligation reader's 900ms budget, and that reader never reads it.
    const dutyLaunch = { ...launch, goalBrief: { ...launch.goalBrief, body: 'Maintain rubric coverage on every worklist plan.' } };
    const read = (rubricStewardship: 'read' | 'skip') => readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'goal-1',
      sql: mockSql({ portfolio: { 'goal-1': portfolioRow } }),
      now: NOW,
      launch: dutyLaunch,
      claimability: 'skip',
      rubricStewardship,
    });

    // CONTROL: a goal with rubric duties reaches the stewardship read by default,
    // so the skip assertion cannot pass merely because the duty phrase never matched.
    rubricStewardshipRead.mockClear();
    const withDuties = await read('read');
    expect(rubricStewardshipRead).toHaveBeenCalledTimes(1);
    expect(withDuties).toHaveProperty('rubricStewardship');

    rubricStewardshipRead.mockClear();
    const skipped = await read('skip');
    expect(rubricStewardshipRead).not.toHaveBeenCalled();
    expect(skipped).not.toHaveProperty('rubricStewardship');
    expect(skipped?.worklist).toEqual(withDuties?.worklist);
  });

  it('staged snapshot preserves planning inputs while rubric stewardship is still pending (EI-25679819974924161)', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stewardshipStarted = new Promise<void>((resolve) => { started = resolve; });
    let stewardshipEntries = 0;
    const blockedStewardship = async () => {
      if (++stewardshipEntries === 2) started();
      await gate;
      return null;
    };
    rubricStewardshipRead.mockImplementationOnce(blockedStewardship).mockImplementationOnce(blockedStewardship);
    const args = {
      workspaceId: WS, goalId: 'goal-1', now: NOW,
      sql: mockSql({ portfolio: { 'goal-1': { ...portfolioRow, blender_pending: 7 } } }),
      launch: { ...launch, goalBrief: { ...launch.goalBrief, body: 'Maintain rubric coverage on every worklist plan.' } },
    };
    // The previous shared-read shape waits for the same pending provider.
    const unsplit = readGoalPortfolioBrief({ ...args, claimability: 'skip' });
    const staged = readGoalPortfolioBriefStaged(args);
    let snapshotSettled = false;
    let countedSettled = false;
    let unsplitSettled = false;
    void staged.snapshot.then(() => { snapshotSettled = true; });
    void staged.counted.then(() => { countedSettled = true; });
    void unsplit.then(() => { unsplitSettled = true; });
    try {
      await stewardshipStarted;
      await new Promise((resolve) => setImmediate(resolve));
      expect(snapshotSettled).toBe(true);
      expect(countedSettled).toBe(false);
      expect(unsplitSettled).toBe(false);
      const snapshot = await staged.snapshot;
      expect(snapshot?.goal.id).toBe('goal-1');
      expect(snapshot?.worklist.length).toBeGreaterThan(0);
      expect(snapshot?.pending.blenderIdeas).toBe(7);
      expect(snapshot).not.toHaveProperty('rubricStewardship');
      release();
      const counted = await staged.counted;
      expect(counted).toHaveProperty('rubricStewardship', null);
      expect(counted?.goal).toEqual(snapshot?.goal);
      expect(counted?.worklist).toEqual(snapshot?.worklist);
      expect(counted?.pending).toEqual(snapshot?.pending);
      expect(counted?.assembledAt).toBe(snapshot?.assembledAt);
      expect((await unsplit)?.worklist).toEqual(snapshot?.worklist);
    } finally {
      release();
      await Promise.all([staged.counted, unsplit]);
    }
  });

  it('stewardship failure rejects the display stage without losing the obligation snapshot', async () => {
    rubricStewardshipRead.mockRejectedValueOnce(new Error('stewardship unavailable'));
    const staged = readGoalPortfolioBriefStaged({
      workspaceId: WS, goalId: 'goal-1', now: NOW,
      sql: mockSql({ portfolio: { 'goal-1': { ...portfolioRow, blender_pending: 7 } } }),
      launch: { ...launch, goalBrief: { ...launch.goalBrief, body: 'Maintain rubric coverage on every worklist plan.' } },
    });
    await expect(staged.counted).rejects.toThrow('stewardship unavailable');
    const snapshot = await staged.snapshot;
    expect(snapshot?.worklist.length).toBeGreaterThan(0);
    expect(snapshot?.pending.blenderIdeas).toBe(7);
    expect(snapshot?.degradedReasons).toEqual([]);
    expect(snapshot).not.toHaveProperty('rubricStewardship');
  });

  it('staged read delivers the snapshot before the claim-floor count finishes (EI-25191349922959563)', async () => {
    // orient shares one portfolio snapshot between its obligation fold (900ms
    // budget, never reads queue.claimable) and its display fold. The obligation
    // fold must not wait on the per-id count, which alone timed it out every wake.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const explainIssueClaimFloors = vi.fn(async (_harness: string, ids: string[]) => {
      await gate;
      return ids.map(() => ({ admissible: true }));
    });
    vi.doMock('./work-items', () => ({ explainIssueClaimFloors }));
    try {
      const row = {
        ...portfolioRow,
        queue: {
          ...portfolioRow.queue,
          issueCandidates: [
            { id: 'EI-1', harness: 'papercusp' },
            { id: 'EI-2', harness: 'papercusp' },
            { id: 'EI-3', harness: 'other' },
          ],
        },
      };
      const staged = readGoalPortfolioBriefStaged({
        workspaceId: WS,
        goalId: 'goal-1',
        sql: mockSql({ portfolio: { 'goal-1': row } }),
        now: NOW,
        launch,
      });
      let countedSettled = false;
      void staged.counted.then(() => { countedSettled = true; });

      const snapshot = await staged.snapshot;
      expect(snapshot?.queue).toMatchObject({ claimable: null, claimabilityScope: 'not-requested' });
      expect(snapshot?.priorities.join(' ') ?? '').not.toContain('goal-scoped claimable');
      // The count is in flight but blocked: the snapshot did not wait for it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(explainIssueClaimFloors).toHaveBeenCalled();
      expect(countedSettled).toBe(false);

      release();
      const counted = await staged.counted;
      // Same candidate rows, counted per harness.
      expect(explainIssueClaimFloors).toHaveBeenCalledWith('papercusp', ['EI-1', 'EI-2']);
      expect(explainIssueClaimFloors).toHaveBeenCalledWith('other', ['EI-3']);
      expect(counted?.queue).toMatchObject({ claimable: 3, claimabilityScope: 'issue-family' });
      expect(counted?.priorities.join(' ') ?? '').toContain('Place 3 goal-scoped claimable issue(s)');
      expect(counted?.assembledAt).toBe(snapshot?.assembledAt);
    } finally {
      vi.doUnmock('./work-items');
    }
  });

  it('a failed claim-floor count leaves the counted stage unknown and degraded, not zero', async () => {
    const explainIssueClaimFloors = vi.fn(async () => { throw new Error('floor read down'); });
    vi.doMock('./work-items', () => ({ explainIssueClaimFloors }));
    try {
      const row = { ...portfolioRow, queue: { ...portfolioRow.queue, issueCandidates: [{ id: 'EI-1', harness: 'papercusp' }] } };
      const counted = await readGoalPortfolioBrief({
        workspaceId: WS, goalId: 'goal-1', sql: mockSql({ portfolio: { 'goal-1': row } }), now: NOW, launch,
      });
      expect(counted?.queue).toMatchObject({ claimable: null, claimabilityScope: 'unknown' });
      expect(counted?.degradedReasons.join(' ') ?? '').toContain('goal-scoped claimability unavailable: floor read down');
    } finally {
      vi.doUnmock('./work-items');
    }
  });

  it('assembles ordered plan state while keeping drain and TEST activity out of plan placement', async () => {
    const seen: string[] = [];
    const brief = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'goal-1',
      sql: mockSql({ portfolio: { 'goal-1': portfolioRow }, seen }),
      now: NOW,
      launch,
    });

    expect(brief).not.toBeNull();
    expect(brief).toMatchObject({
      schemaVersion: 1,
      assembledAt: NOW.toISOString(),
      goal: { id: 'goal-1', title: 'Keep the portfolio moving', status: 'active', standing: true },
      worklist: [
        {
          ref: 'plan:papercusp/alpha',
          next: { id: 'P-002', text: 'Place next', phase: 'Build', blockedBy: [] },
          counts: { todo: 2, wip: 0, blocked: 0, needsHuman: 0, done: 1 },
          placement: {
            state: 'unplaced',
            reconciliation: {
              consistent: false,
              action: 'launch-plan-fleet',
              toolCall: {
                tool: 'fleet:launch-on-plan',
                args: {
                  name: 'papercusp-alpha-plan-fleet',
                  plan: 'alpha',
                  harness: 'papercusp',
                  leader: 'spawn',
                  headless: true,
                },
              },
            },
          },
        },
      ],
      drainFleet: { slug: 'goal-1-drain', exists: true, live: 2, working: 1 },
      queue: { total: 7, terminal: 2, inFlight: 2, blocked: 1, needsHuman: 1, claimable: 0 },
      continuity: {
        checkpoint: { workItemId: 'WI-42', updatedAt: '2026-08-28T02:15:00.000Z' },
        lastOwnerReportAt: null,
      },
      reporting: { draft: { fields: {
        moved: expect.stringContaining('no previous report watermark'),
        cost: expect.stringContaining(
          'coverage=measured; source=goal-lineage-rollup; measured at=2026-08-28T02:00:00Z; read at=2026-08-28T02:30:00.000Z',
        ),
        ownerWalled: expect.stringContaining('WI-43: provide billing access'),
        killed: 'none evidenced in the current portfolio',
      } } },
      operatingInputs: { status: 'ready', canExecute: true, spendCoverage: 'measured' },
      attribution: { status: 'healthy', checked: { pots: 1, plans: 1, workItems: 1 }, issues: [] },
    });
    expect(brief?.priorities).toEqual([
      'Report 1 owner-walled queue item(s) with exact asks.',
      expect.stringContaining('Reconcile plan:papercusp/alpha: Launch the independently led plan fleet'),
      'Triage 1 blocked/cursed queue item(s) and remove stranded blockers.',
      'Grade or route 2 pending Blender idea(s).',
    ]);
    expect(brief?.reporting?.draft.fields.cost).not.toContain('unmeasured');
    expect(goalHoldersMock).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS,
      goalId: 'goal-1',
    });

    const rendered = renderGoalPortfolioBrief(brief!);
    const rubricContext = renderGoalPortfolioBrief({ ...brief!, rubricStewardship: {
      measuredAt: NOW.toISOString(), windowStart: NOW.toISOString(), complete: false,
      rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 47,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null, 'grading-correction-closure': null },
      cycles: [], error: null,
    } });
    expect(rubricContext).toContain('RUBRIC STEWARDSHIP');
    expect(rubricContext).toContain('work-on-everything-stewardship-health@47');
    expect(rubricContext).toContain('Grading cycles: none measured');
    expect(rubricContext).toContain('limited recent page, not a census');
    expect(rendered).toContain('intendedParallelPlanFleets=undeclared');
    expect(rendered).toContain('Independent plan-lane placement candidates: plan:papercusp/alpha');
    expect(rendered).toContain('OWNER REPORT DRAFT');
    expect(rendered).toContain('OWNER-WALLED: work-item:WI-43: provide billing access');
    expect(renderGoalPortfolioBrief({
      ...brief!,
      launch: { ...brief!.launch, settings: { intendedParallelPlanFleets: 2 }, intendedParallelPlanFleets: 2 },
    })).toContain('intendedParallelPlanFleets=2');
    expect(rendered).toContain(`GOAL PORTFOLIO SNAPSHOT — assembled ${NOW.toISOString()}`);
    expect(rendered).toContain('Pots: papercusp:owner[kill=stop if no owner]');
    expect(rendered).toContain('Attribution ladder: healthy; checked=1 pot links/1 plans/1 work items');
    const attested = renderGoalPortfolioBrief({
      ...brief!,
      holderAttestation: {
        status: 'partial', workspaceId: WS, goalId: 'goal-1', ownerId: 'su-holder',
        modeSetAt: NOW.toISOString(), loopActive: true, checkpointAt: NOW.toISOString(),
        portfolioAct: null, missing: ['portfolio-act'], unavailable: [],
      },
    });
    expect(attested).toContain('Holder first-turn attestation: partial; missing=portfolio-act');
    expect(rendered).toContain('1. plan:papercusp/alpha [active; placement=unplaced] next=P-002');
    expect(rendered).toContain('Queue: total=7; terminal=2; in-flight=2; blocked=1; needs-human=1');
    // P-004: this line lands in every goal agent's kickoff (goals:start,
    // start-goal-by-id, goal-holder-launch-action all render it), which makes it
    // the most-read rendering of spentCents anywhere. Unqualified, `spent=1250c`
    // does not say which population it counts; since D-011 it is the goal's
    // lineage-attributed stream, and that population must travel with the number.
    expect(rendered).toContain('Budget: spent=1250c [attributed-by-lineage:authoritative] / 5000c');
    // And the label must be EARNED, not decorative: an unmarked figure says so
    // rather than borrowing the lineage scope's standing.
    const unmarked = renderGoalPortfolioBrief({
      ...brief!,
      budget: { ...brief!.budget, spentCentsSource: null },
    });
    expect(unmarked).toContain('Budget: spent=1250c [unverified-provenance:unmarked-snapshot]');
    // No figure ⇒ no population to name; do not label 'unknown' with a scope.
    const absent = renderGoalPortfolioBrief({
      ...brief!,
      budget: { ...brief!.budget, spentCents: null },
    });
    expect(absent).toContain('Budget: spent=unknownc /');
    const kickoffEvidenceMarker = rendered.indexOf('GOAL KICKOFF EVIDENCE — REQUIRED BEFORE ANY PORTFOLIO MUTATION');
    const kickoffReadInstruction = rendered.indexOf(
      `Before any portfolio mutation, successfully run ${GOAL_KICKOFF_REQUIRED_READS.join(', ')} against goal "goal-1" and use those current reads to choose this pass’s actions.`,
    );
    const actionPrioritiesMarker = rendered.indexOf('CURRENT ACTION PRIORITIES');
    const postActionReportMarker = rendered.indexOf('POST-ACTION OWNER REPORT — REQUIRED AFTER THE PASS ACTIONS');
    const ownerReportRefreshInstruction = rendered.indexOf(
      'After all selected actions have returned, fetch goals:get { id: "goal-1", detail: "full" } again. Send the report from that post-action response’s reporting.draft and use its assembledAt as the portfolio read time.',
    );
    const mandatoryPlacementMarker = rendered.indexOf('MANDATORY NEXT PLAN PLACEMENT');
    expect(kickoffEvidenceMarker).toBeGreaterThanOrEqual(0);
    expect(kickoffReadInstruction).toBeGreaterThan(kickoffEvidenceMarker);
    expect(mandatoryPlacementMarker).toBeGreaterThan(kickoffReadInstruction);
    expect(actionPrioritiesMarker).toBeGreaterThan(mandatoryPlacementMarker);
    expect(postActionReportMarker).toBeGreaterThan(actionPrioritiesMarker);
    expect(ownerReportRefreshInstruction).toBeGreaterThan(postActionReportMarker);
    expect(rendered).toContain('reports:publish goal_owner_report snapshot');
    expect(rendered).toContain('report: { plans: [], goalReport:');
    expect(rendered).toContain('Do not truncate owner asks to fit');
    expect(rendered).toContain(
      `Only after that final refresh, send ${GOAL_OWNER_REPORT_HEADING_LIST} to ["human"] with coord:send or use coord:escalate, naming exact goal id "goal-1".`,
    );
    expect(rendered).toContain('OWNER REPORT DRAFT — provisional snapshot');
    expect(rendered).toContain('only actions with a successful result already returned');
    expect(rendered).toContain('every goal-scoped work item that reached a terminal state after the previous report watermark');
    expect(rendered).toContain('When refreshed evidence says coverage=measured, do not describe spend as unmeasured');
    expect(rendered).toContain('MANDATORY NEXT PLAN PLACEMENT');
    expect(rendered).toContain(
      'Use fleet:launch-on-plan with this plan/leader identity: {"name":"papercusp-alpha-plan-fleet","plan":"alpha","harness":"papercusp","leader":"spawn","headless":true}.',
    );
    expect(rendered).toContain('YOU select the plan allocation');
    expect(rendered).toContain('Add your chosen count and role configuration');
    expect(rendered).toContain('GOAL steward owns plan priority, fleet size, and model choice');
    expect(brief!.worklist[0].placement.reconciliation.toolCall!.args).not.toHaveProperty('count');
    expect(rendered).toContain('Do not claim its plan item from the GOAL session');
    expect(rendered).toContain('CURRENT ACTION PRIORITIES');

    const portfolioSql = seen.find((statement) => statement.includes('WITH goal_row AS')) ?? '';
    expect(portfolioSql).toContain("pic.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])");
    expect(portfolioSql).toContain("cp.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])");
    expect(portfolioSql).toContain('count(DISTINCT member_presence.owner_id)');
    const planFleetPrefetchSql = portfolioSql.slice(
      portfolioSql.indexOf('plan_fleets AS MATERIALIZED'),
      portfolioSql.indexOf('SELECT g.status'),
    );
    expect(planFleetPrefetchSql).toContain('af.workspace_id = g.workspace_id');
    expect(planFleetPrefetchSql).toContain('CASE jsonb_typeof(af.headcount_config)');
    expect(planFleetPrefetchSql).toContain("WHEN 'string' THEN (af.headcount_config #>> '{}')::jsonb");
    expect(planFleetPrefetchSql).toContain('ELSE af.headcount_config');
    expect(planFleetPrefetchSql).toContain("SELECT DISTINCT ON (fc.cfg->>'harness', fc.cfg->>'plan')");
    expect(planFleetPrefetchSql).toContain("ORDER BY fc.cfg->>'harness', fc.cfg->>'plan', af.updated_at DESC");
    expect(portfolioSql).toContain('af.plan_slug = p.plan_slug');
    expect(portfolioSql).toContain('af.harness_slug = p.harness_slug');
    const placementFleetSql = portfolioSql.slice(
      portfolioSql.indexOf("'fleet', ("),
      portfolioSql.indexOf('FROM jsonb_array_elements_text', portfolioSql.indexOf("'fleet', (")),
    );
    expect(placementFleetSql).toContain('FROM plan_fleets af');
    expect(placementFleetSql).not.toMatch(/agent_modes|session_briefs|goal_role|drain_fleet/);
  });

  it('compiles every placement state and one deterministic repair from existing ledgers', () => {
    const base = {
      plan: { harness: 'papercusp', slug: 'alpha', ambiguousMatches: 1 },
      status: 'active',
      itemStatuses: ['done', 'todo'],
      actionableItemId: 'P-002',
      now: NOW,
    };
    const lane = {
      itemId: 'P-002',
      ownerId: 'su-plan',
      fleetSlug: 'alpha-fleet',
      holderLive: true,
      expiresAt: '2026-08-28T02:40:00.000Z',
    };
    const fleet = {
      slug: 'alpha-fleet',
      controlState: 'active',
      leaderOwnerId: 'su-plan',
      leaderLive: true,
      liveMembers: 2,
      target: 3,
      launchTransaction: {
        transactionId: 'tx-1',
        state: 'verified',
        recovery: { retryOwnerIds: [], nextAction: 'none' },
      },
    };
    const memberSource = {
      goalHolderOwnerIds: ['su-goal'],
      claims: [{ ...lane, ownerId: 'su-member', workItemId: 'WI-alpha-member' }],
      fleet: { ...fleet, claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } } },
    };

    expect(compileGoalPlanPlacement({ ...base, source: {} })).toMatchObject({
      state: 'unplaced',
      reconciliation: {
        action: 'launch-plan-fleet',
        toolCall: {
          tool: 'fleet:launch-on-plan',
          args: {
            name: 'papercusp-alpha-plan-fleet',
            plan: 'alpha',
            harness: 'papercusp',
            leader: 'spawn',
            headless: true,
          },
        },
      },
    });
    expect(compileGoalPlanPlacement({ ...base, source: { claims: [lane], goalHolderOwnerIds: ['su-plan'] } })).toMatchObject({
      state: 'admitting',
      reconciliation: {
        action: 'launch-spawned-leader',
        toolCall: { tool: 'fleet:launch-on-plan' },
      },
    });
    expect(compileGoalPlanPlacement({
      ...base,
      source: {
        claims: [{ ...lane, ownerId: 'su-member', fleetSlug: 'other-alpha-fleet', workItemId: 'WI-alpha-member' }],
        goalHolderOwnerIds: ['su-goal'],
      },
    })).toMatchObject({
      state: 'blocked',
      activeLane: { ownerId: 'su-member', ownerFleet: 'other-alpha-fleet', workItemId: 'WI-alpha-member' },
      reconciliation: {
        consistent: false,
        action: 'reconcile-plan-lane-holder',
        reason: expect.stringContaining('other-alpha-fleet'),
        toolCall: null,
      },
    });
    expect(compileGoalPlanPlacement({
      ...base,
      source: {
        claims: [{ ...lane, ownerId: 'su-solo', fleetSlug: null, workItemId: 'WI-alpha-solo' }],
        goalHolderOwnerIds: ['su-goal'],
      },
    })).toMatchObject({
      state: 'blocked',
      activeLane: { ownerId: 'su-solo', ownerFleet: null, workItemId: 'WI-alpha-solo' },
      reconciliation: {
        consistent: false,
        action: 'reconcile-plan-lane-holder',
        reason: expect.stringContaining('su-solo'),
        toolCall: null,
      },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        source: {
          claims: [lane],
          fleet: {
            ...fleet,
            slug: 'legacy-alpha',
            launchTransaction: {
              transactionId: 'tx-partial',
              state: 'partial',
              recovery: { retryOwnerIds: ['su-retry'], nextAction: 'retry only su-retry' },
            },
          },
        },
      }),
    ).toMatchObject({
      state: 'admitting',
      launchTransaction: { retryOwnerIds: ['su-retry'] },
      reconciliation: {
        action: 'resume-partial-launch',
        reason: 'retry only su-retry',
        toolCall: { tool: 'fleet:launch-on-plan', args: { name: 'legacy-alpha' } },
      },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        source: { claims: [lane], fleet: { ...fleet, slug: 'legacy-alpha', leaderLive: false } },
      }),
    ).toMatchObject({
      state: 'admitting',
      reconciliation: {
        action: 'restore-spawned-leader',
        toolCall: { tool: 'fleet:launch-on-plan', args: { name: 'legacy-alpha' } },
      },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        source: memberSource,
      }),
    ).toMatchObject({ state: 'independently-led', reconciliation: { action: 'none', consistent: true } });
    expect(
      compileGoalPlanPlacement({
        ...base,
        itemStatuses: ['done', 'wip'],
        source: memberSource,
      }),
    ).toMatchObject({ state: 'working', reconciliation: { action: 'none', consistent: true } });
    // D-033 (WI-10004710): the sanctioned fence-preserving widen keeps the plan arm
    // beside id disjuncts, so it still admits the plan and a live member claim on the
    // plan's own item is working. Only a spec with no plan arm is a filter to restore.
    const withFilter = (filter: unknown) => ({
      ...memberSource,
      fleet: { ...memberSource.fleet, claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter } } },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        itemStatuses: ['done', 'wip'],
        source: withFilter({ any: [{ field: 'plan', op: '=', value: 'alpha' }, { field: 'id', op: '=', value: 'WI-standalone' }] }),
      }),
    ).toMatchObject({
      state: 'working',
      fleet: { planScoped: false, planAdmitted: true },
      reconciliation: { action: 'none', consistent: true },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        itemStatuses: ['done', 'wip'],
        source: withFilter({ any: [{ field: 'id', op: 'in', value: ['WI-standalone'] }, { not: { field: 'plan', op: '=', value: 'alpha' } }] }),
      }),
    ).toMatchObject({
      state: 'blocked',
      fleet: { planScoped: false, planAdmitted: false },
      reconciliation: { action: 'reconcile-plan-lane-holder', reason: expect.stringContaining('positive plan/plan_item claim filter') },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        source: { claims: [{ ...lane, holderLive: false }], fleet },
      }),
    ).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'reconcile-plan-lane-holder', toolCall: null },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        itemStatuses: ['done', 'blocked'],
        actionableItemId: null,
        source: { claims: [lane], fleet },
      }),
    ).toMatchObject({ state: 'blocked', reconciliation: { action: 'resolve-plan-blockers', toolCall: null } });
    expect(
      compileGoalPlanPlacement({
        ...base,
        status: 'shipped',
        itemStatuses: ['done', 'done'],
        actionableItemId: null,
        source: { claims: [lane], fleet },
      }),
      // P-026 / D-012: administrative completion alone no longer terminates a
      // plan. With NO closure reading supplied this is `awaiting-closure`, not
      // `terminal` — "we never looked" must not read the same as "it closed".
    ).toMatchObject({
      state: 'awaiting-closure',
      reconciliation: { action: 'close-plan', consistent: false, toolCall: null },
    });
  });

  describe('physically complete partial launch placement (EI-25157449632977265)', () => {
    const base = {
      plan: { harness: 'papercusp', slug: 'alpha', ambiguousMatches: 1 },
      status: 'active',
      itemStatuses: ['done', 'wip'],
      actionableItemId: 'P-002',
      now: NOW,
    };
    const memberSource = () => ({
      goalHolderOwnerIds: ['su-goal'],
      claims: [{
        itemId: 'P-002',
        ownerId: 'su-member',
        fleetSlug: 'alpha-fleet',
        holderLive: true,
        expiresAt: '2026-08-28T02:40:00.000Z',
        workItemId: 'WI-alpha-member',
      }],
      fleet: {
        slug: 'alpha-fleet',
        controlState: 'active',
        leaderOwnerId: 'su-leader',
        leaderLive: true,
        liveMembers: 1,
        target: 1,
        claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } },
        launchTransaction: {
          transactionId: 'tx-physically-complete',
          state: 'partial',
          requestedMemberIds: ['su-member'],
          openedMemberIds: ['su-member'],
          verifiedMemberIds: ['su-member'],
          failed: [],
          // Historical readiness is NOT current worker accountability.
          workerReadyMemberIds: [],
          workerAttestations: [{ ownerId: 'su-member', gaps: ['scheduler-pull-missing', 'disposition-missing'] }],
          recovery: { retryOwnerIds: [], nextAction: 'resume the first unresolved identity' },
        },
      },
    });
    const withTransaction = (patch: Record<string, unknown>) => {
      const source = memberSource();
      return {
        ...source,
        fleet: { ...source.fleet, launchTransaction: { ...source.fleet.launchTransaction, ...patch } },
      };
    };

    it.each([{ unconfirmedMemberIds: undefined }, { unconfirmedMemberIds: [] }])(
      'uses current accountability with legacy/empty unconfirmed=$unconfirmedMemberIds without rewriting history',
      ({ unconfirmedMemberIds }) => {
        const source = withTransaction({ unconfirmedMemberIds });
        const before = structuredClone(source);
        const placement = compileGoalPlanPlacement({ ...base, source });
        expect(placement).toMatchObject({
          state: 'working',
          activeLane: { ownerId: 'su-member', workItemId: 'WI-alpha-member' },
          reconciliation: { action: 'none', consistent: true, toolCall: null },
        });
        expect(placement.launchTransaction).toEqual({
          transactionId: 'tx-physically-complete',
          state: 'partial',
          retryOwnerIds: [],
          nextAction: 'resume the first unresolved identity',
        });
        expect(source).toEqual(before);
      },
    );

    it('keeps the completed launch cohort separate from the current member identity', () => {
      const source = withTransaction({
        requestedMemberIds: ['su-original', 'su-second'],
        openedMemberIds: ['su-original', 'su-second'],
        verifiedMemberIds: ['su-original', 'su-second'],
      });
      expect(compileGoalPlanPlacement({ ...base, source })).toMatchObject({
        state: 'working',
        activeLane: { ownerId: 'su-member', workItemId: 'WI-alpha-member' },
        launchTransaction: { state: 'partial' },
        reconciliation: { action: 'none', consistent: true, toolCall: null },
      });
    });

    it('accepts the existing JSON transaction provider and follows the current work transition', () => {
      const source = memberSource();
      expect(compileGoalPlanPlacement({
        ...base,
        itemStatuses: ['done', 'todo'],
        source: {
          ...source,
          fleet: { ...source.fleet, launchTransaction: JSON.stringify(source.fleet.launchTransaction) },
        },
      })).toMatchObject({
        state: 'independently-led',
        launchTransaction: { state: 'partial' },
        reconciliation: { action: 'none', consistent: true, toolCall: null },
      });
    });

    it.each([
      ['retry pending', { recovery: { retryOwnerIds: ['su-retry'] } }],
      ['retry unmeasured', { recovery: {} }],
      ['retry null', { recovery: { retryOwnerIds: null } }],
      ['retry malformed', { recovery: { retryOwnerIds: 'none' } }],
      ['recovery absent', { recovery: undefined }],
      ['request absent', { requestedMemberIds: undefined }],
      ['request empty', { requestedMemberIds: [] }],
      ['request malformed', { requestedMemberIds: ['su-member', null] }],
      ['request blank', { requestedMemberIds: [''] }],
      ['opened unmeasured', { openedMemberIds: undefined }],
      ['unopened member', { openedMemberIds: [] }],
      ['opened wrong identity', { openedMemberIds: ['su-other'] }],
      ['second member unopened', { requestedMemberIds: ['su-member', 'su-second'], verifiedMemberIds: ['su-member', 'su-second'] }],
      ['verified unmeasured', { verifiedMemberIds: undefined }],
      ['unverified member', { verifiedMemberIds: [] }],
      ['verified wrong identity', { verifiedMemberIds: ['su-other'] }],
      ['second member unverified', { requestedMemberIds: ['su-member', 'su-second'], openedMemberIds: ['su-member', 'su-second'] }],
      ['failure recorded', { failed: [{ ownerId: 'su-member', phase: 'verify', reason: 'failed' }] }],
      ['failure unmeasured', { failed: undefined }],
      ['failure null', { failed: null }],
      ['unconfirmed member', { unconfirmedMemberIds: ['su-member'] }],
      ['unconfirmed null', { unconfirmedMemberIds: null }],
      ['unconfirmed malformed', { unconfirmedMemberIds: 'unknown' }],
      ['still launching', { state: 'launching' }],
    ])('retains recovery for %s despite a live claimed lane', (_label, transactionPatch) => {
      const placement = compileGoalPlanPlacement({ ...base, source: withTransaction(transactionPatch) });
      expect(placement).toMatchObject({
        state: 'admitting',
        reconciliation: {
          action: 'resume-partial-launch',
          consistent: false,
          toolCall: { tool: 'fleet:launch-on-plan', args: { name: 'alpha-fleet' } },
        },
      });
    });

    it.each([
      ['no live leader', { leaderLive: false }, 'restore-spawned-leader'],
      ['paused fleet', { controlState: 'paused' }, 'reconcile-plan-lane-holder'],
      ['GOAL steward leader', { leaderOwnerId: 'su-goal' }, 'reconcile-plan-lane-holder'],
      ['leader identity absent', { leaderOwnerId: null }, 'reconcile-plan-lane-holder'],
      ['plan admission absent', { claimSpec: null }, 'reconcile-plan-lane-holder'],
      ['other plan admitted', { claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'other' } } } }, 'reconcile-plan-lane-holder'],
    ])('still repairs %s after physical completion', (_label, fleetPatch, action) => {
      const source = memberSource();
      const placement = compileGoalPlanPlacement({ ...base, source: { ...source, fleet: { ...source.fleet, ...fleetPatch } } });
      expect(placement.reconciliation).toMatchObject({ action, consistent: false });
      expect(placement.state).not.toBe('working');
      expect(placement.launchTransaction?.state).toBe('partial');
    });

    it.each([
      ['member not live', { holderLive: false }],
      ['work item absent', { workItemId: null }],
      ['another fleet', { fleetSlug: 'other-fleet' }],
      ['leader-only lease', { ownerId: 'su-leader' }],
      ['GOAL steward lease', { ownerId: 'su-goal' }],
      ['lease expiry absent', { expiresAt: null }],
      ['expired lease', { expiresAt: '2026-08-28T02:00:00.000Z' }],
    ])('requires current matching member accountability: %s', (_label, claimPatch) => {
      const source = memberSource();
      expect(compileGoalPlanPlacement({
        ...base,
        source: { ...source, claims: [{ ...source.claims[0], ...claimPatch }] },
      })).toMatchObject({
        launchTransaction: { state: 'partial' },
        reconciliation: { action: 'reconcile-plan-lane-holder', consistent: false, toolCall: null },
      });
    });

    it('does not treat physical completion or live-member count as a current claim', () => {
      const source = memberSource();
      expect(compileGoalPlanPlacement({ ...base, source: { ...source, claims: [] } })).toMatchObject({
        state: 'admitting',
        reconciliation: { action: 'reconcile-plan-lane-holder', toolCall: null },
      });
      const { goalHolderOwnerIds: _unmeasured, ...withoutHolderIdentity } = source;
      expect(compileGoalPlanPlacement({ ...base, source: withoutHolderIdentity })).toMatchObject({
        state: 'blocked',
        reconciliation: { action: 'reconcile-plan-lane-holder', toolCall: null },
      });
    });
  });

  it('terminates the same shipped plan once its closure evidence is supplied', () => {
    // The other half of the pair above: closure is what terminates a plan now,
    // so the SAME input with evidenced closure must still reach `terminal`.
    expect(
      compileGoalPlanPlacement({
        plan: { harness: 'papercusp', slug: 'shipped', ambiguousMatches: 1 },
        status: 'shipped',
        itemStatuses: ['done', 'done'],
        actionableItemId: null,
        // No lane/fleet needed: closure is what terminates the plan now, and
        // supplying them would hide that by making the placement consistent anyway.
        source: {},
        closure: {
          state: 'closed',
          evidenceSatisfied: true,
          reason: 'acceptance satisfied',
          legs: {
            terminalEvidence: 'pass',
            verificationReadBack: 'pass',
            independentRegrade: 'pass',
            measuredReport: 'pass',
          },
        },
      }),
    ).toMatchObject({
      state: 'terminal',
      reconciliation: { action: 'none', consistent: true, toolCall: null },
    });
  });

  it('does not emit a launch for a draft plan with a dependency-free todo item', () => {
    const placement = compileGoalPlanPlacement({
      plan: { harness: 'papercusp', slug: 'draft', ambiguousMatches: 1 },
      status: 'draft',
      itemStatuses: ['todo'],
      actionableItemId: 'P-001',
      source: {},
      now: NOW,
    });

    expect(placement).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'resolve-plan-blockers', toolCall: null },
    });
    expect(placement.reconciliation.reason).toMatch(/draft.*cannot launch/i);
  });

  it('WI-10005657: compiles a plan whose dependency-free frontier is only needs-human as owner-walled, never launchable', () => {
    const args = {
      plan: { harness: 'papercusp', slug: 'hud', ambiguousMatches: 1 },
      status: 'active',
      itemStatuses: ['done', 'needs-human'],
      actionableItemId: null,
      source: {},
      now: NOW,
    };
    // Positive control: the SAME input without the wall evidence stays the generic
    // repairable `blocked` — so the wall is the ONLY thing that changes the state.
    expect(compileGoalPlanPlacement(args)).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'resolve-plan-blockers', toolCall: null },
    });
    const walled = compileGoalPlanPlacement({ ...args, ownerWalledItemIds: ['P-003'] });
    expect(walled).toMatchObject({
      state: 'owner-walled',
      wall: { kind: 'owner', itemIds: ['P-003'] },
      reconciliation: { action: 'none', consistent: true, toolCall: null },
    });
    expect(walled.reconciliation.reason).toMatch(/needs-human/);
    // A wall never overrides a harder fact: an unstartable (draft) plan is still
    // blocked on its lifecycle gate, and an ambiguous plan on its identity.
    expect(compileGoalPlanPlacement({ ...args, status: 'draft', ownerWalledItemIds: ['P-003'] })).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'resolve-plan-blockers' },
    });
    expect(
      compileGoalPlanPlacement({ ...args, plan: { ...args.plan, ambiguousMatches: 2 }, ownerWalledItemIds: ['P-003'] }),
    ).toMatchObject({ state: 'blocked', reconciliation: { action: 'resolve-plan-identity' } });
  });

  it('WI-10005657: an owner-walled plan is named in the brief and never re-mandates a fleet launch', async () => {
    const readBrief = (plans: readonly Record<string, unknown>[]) =>
      readGoalPortfolioBrief({
        workspaceId: WS,
        goalId: 'goal-1',
        sql: mockSql({ portfolio: { 'goal-1': { ...portfolioRow, plans } } }),
        now: NOW,
        launch,
      });
    const hud = {
      ref: 'plan:papercusp/hud',
      ordinal: 1,
      harness: 'papercusp',
      slug: 'hud',
      title: 'Owner-reserved plan',
      status: 'active',
      ambiguousMatches: 1,
      items: [
        { id: 'P-001', text: 'Shipped', status: 'done', phase: 'Build', blockedBy: [], seq: 1 },
        { id: 'P-003', text: 'Owner route change', status: 'needs-human', phase: 'Build', blockedBy: [], seq: 2 },
      ],
    };
    const walledBrief = await readBrief([hud]);
    expect(walledBrief?.worklist).toMatchObject([
      { slug: 'hud', placement: { state: 'owner-walled', wall: { kind: 'owner', itemIds: ['P-003'] }, reconciliation: { toolCall: null } } },
    ]);
    const walledRendered = renderGoalPortfolioBrief(walledBrief!);
    expect(walledRendered).toContain('OWNER-WALLED placement');
    expect(walledRendered).toContain('plan:papercusp/hud (P-003)');
    expect(walledRendered).not.toContain('MANDATORY NEXT PLAN PLACEMENT');

    // Positive control 1: a needs-human item BESIDE a dependency-free todo is one of
    // several open fronts, not a wall — the plan is still launchable.
    const mixed = await readBrief([
      { ...hud, items: [...hud.items, { id: 'P-004', text: 'Agent-doable', status: 'todo', phase: 'Build', blockedBy: [], seq: 3 }] },
    ]);
    expect(mixed?.worklist[0]?.placement).toMatchObject({ state: 'unplaced', reconciliation: { action: 'launch-plan-fleet' } });
    expect(renderGoalPortfolioBrief(mixed!)).not.toContain('OWNER-WALLED placement');

    // Positive control 2: a needs-human item that is itself still blocked by an open
    // dependency is not the frontier — the dependency is, so nothing is walled yet.
    const gated = await readBrief([
      {
        ...hud,
        items: [
          { id: 'P-001', text: 'Open dep', status: 'todo', phase: 'Build', blockedBy: [], seq: 1 },
          { id: 'P-003', text: 'Owner route change', status: 'needs-human', phase: 'Build', blockedBy: ['P-001'], seq: 2 },
        ],
      },
    ]);
    expect(gated?.worklist[0]?.placement.state).not.toBe('owner-walled');

    // The walled plan must not starve a later eligible plan: the launch mandate
    // names the NEXT plan, not the wall.
    const beta = {
      ref: 'plan:papercusp/beta',
      ordinal: 2,
      harness: 'papercusp',
      slug: 'beta',
      title: 'Eligible plan',
      status: 'active',
      ambiguousMatches: 1,
      items: [{ id: 'P-001', text: 'Launch me', status: 'todo', phase: 'Build', blockedBy: [], seq: 1 }],
    };
    const both = await readBrief([hud, beta]);
    const bothRendered = renderGoalPortfolioBrief(both!);
    expect(bothRendered).toContain('OWNER-WALLED placement');
    expect(bothRendered).toContain('MANDATORY NEXT PLAN PLACEMENT');
    expect(bothRendered).toContain('plan:papercusp/beta is the highest-priority eligible worklist plan');
  });

  it('owner reordering two eligible plans changes the next canonical launch from alpha to beta', async () => {
    const alpha = 'plan:papercusp/alpha';
    const beta = 'plan:papercusp/beta';
    const property_schema = {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', collection: {
        source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
        selectable: true, defaultSelected: true,
      } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } },
    };
    const plans = ['alpha', 'beta'].map((slug, index) => ({
      ...portfolioRow.plans[0], ref: `plan:papercusp/${slug}`, slug,
      ordinal: index + 1, title: `${slug} plan`,
    }));
    for (const [order, expected, other] of [
      [[alpha, beta], 'alpha', 'beta'], [[beta, alpha], 'beta', 'alpha'],
    ] as const) {
      const brief = await readGoalPortfolioBrief({
        workspaceId: WS, goalId: 'goal-1', now: NOW, launch,
        sql: mockSql({ portfolio: { 'goal-1': {
          ...portfolioRow, property_schema, plans,
          properties: { worklist: { value: [alpha, beta] },
            worklist_policy: { value: { order: [...order], excluded: [] }, version: 1,
              edited_at: NOW.toISOString(), edited_by: 'owner', provenance: 'owner-edit' } },
        } } }),
      });
      expect(brief?.collection).toMatchObject({ available: true, policyVersion: 1 });
      expect(brief?.worklist.map(plan => plan.slug)).toEqual([expected, other]);
      const eligible = brief?.worklist.filter(plan => plan.placement.reconciliation.toolCall?.tool === 'fleet:launch-on-plan');
      expect(eligible).toHaveLength(2);
      expect(eligible?.[0].placement.reconciliation.toolCall?.args.plan).toBe(expected);
      expect(renderGoalPortfolioBrief(brief!)).toContain(`plan:papercusp/${expected} is the highest-priority eligible worklist plan`);
    }
  });

  it('skips a blocked first worklist plan and emits the next eligible launch', async () => {
    const brief = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'goal-1',
      sql: mockSql({
        portfolio: {
          'goal-1': {
            ...portfolioRow,
            plans: [
              {
                ref: 'plan:papercusp/draft',
                ordinal: 1,
                harness: 'papercusp',
                slug: 'draft',
                title: 'Draft plan',
                status: 'draft',
                ambiguousMatches: 1,
                items: [
                  { id: 'P-001', text: 'Blocked by start gate', status: 'todo', phase: 'Build', blockedBy: [], seq: 1 },
                ],
              },
              {
                ref: 'plan:papercusp/beta',
                ordinal: 2,
                harness: 'papercusp',
                slug: 'beta',
                title: 'Eligible plan',
                status: 'active',
                ambiguousMatches: 1,
                items: [{ id: 'P-001', text: 'Launch me', status: 'todo', phase: 'Build', blockedBy: [], seq: 1 }],
              },
            ],
          },
        },
      }),
      now: NOW,
      launch,
    });

    expect(brief?.worklist).toMatchObject([
      { placement: { state: 'blocked', reconciliation: { toolCall: null } } },
      {
        placement: {
          state: 'unplaced',
          reconciliation: {
            action: 'launch-plan-fleet',
            toolCall: { tool: 'fleet:launch-on-plan', args: { plan: 'beta' } },
          },
        },
      },
    ]);
    const rendered = renderGoalPortfolioBrief(brief!);
    expect(rendered).toContain('MANDATORY NEXT PLAN PLACEMENT');
    expect(rendered).toContain('plan:papercusp/beta is the highest-priority eligible worklist plan');
    expect(rendered).not.toContain('Call fleet:launch-on-plan exactly once with {"name":"papercusp-draft');
  });

  it('treats a todo whose blockers are all done or dropped as dependency-free, and keeps an open blocker blocking', async () => {
    // Live shape on goal 60d3a8 (2026-10-01): gitnexus P-005 waited only on done P-004 and
    // compiled as `blocked`, so placement offered nothing but a floor-gated plan.
    const brief = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'goal-1',
      sql: mockSql({
        portfolio: {
          'goal-1': {
            ...portfolioRow,
            plans: [
              {
                ref: 'plan:papercusp/open-blocker',
                ordinal: 1,
                harness: 'papercusp',
                slug: 'open-blocker',
                title: 'Waits on unfinished work',
                status: 'active',
                ambiguousMatches: 1,
                items: [
                  { id: 'P-001', text: 'Still going', status: 'blocked', phase: 'Build', blockedBy: [], seq: 1 },
                  { id: 'P-002', text: 'Waits', status: 'todo', phase: 'Build', blockedBy: ['P-001'], seq: 2 },
                ],
              },
              {
                ref: 'plan:papercusp/resolved',
                ordinal: 2,
                harness: 'papercusp',
                slug: 'resolved',
                title: 'Blockers finished',
                status: 'ready',
                ambiguousMatches: 1,
                items: [
                  { id: 'P-001', text: 'Done', status: 'done', phase: 'Build', blockedBy: [], seq: 1 },
                  { id: 'P-002', text: 'Dropped', status: 'dropped', phase: 'Build', blockedBy: [], seq: 2 },
                  { id: 'P-003', text: 'Next', status: 'todo', phase: 'Build', blockedBy: ['P-001', 'P-002'], seq: 3 },
                  { id: 'P-004', text: 'After', status: 'todo', phase: 'Build', blockedBy: ['P-003'], seq: 4 },
                ],
              },
            ],
          },
        },
      }),
      now: NOW,
      launch,
    });

    expect(brief?.worklist).toMatchObject([
      { next: null, placement: { state: 'blocked', reconciliation: { action: 'resolve-plan-blockers' } } },
      {
        next: { id: 'P-003', blockedBy: [] },
        placement: {
          state: 'unplaced',
          reconciliation: {
            action: 'launch-plan-fleet',
            toolCall: { tool: 'fleet:launch-on-plan', args: { plan: 'resolved' } },
          },
        },
      },
    ]);
  });

  it('ignores an expired actionable lease instead of compiling a false placement', () => {
    expect(
      compileGoalPlanPlacement({
        plan: { harness: 'papercusp', slug: 'alpha', ambiguousMatches: 1 },
        status: 'active',
        itemStatuses: ['todo'],
        actionableItemId: 'P-001',
        now: NOW,
        source: {
          claims: [
            {
              itemId: 'P-001',
              ownerId: 'su-dead',
              holderLive: false,
              expiresAt: '2026-08-28T02:20:00.000Z',
            },
          ],
        },
      }),
    ).toMatchObject({
      state: 'unplaced',
      activeLane: null,
      reconciliation: { action: 'launch-plan-fleet', toolCall: { tool: 'fleet:launch-on-plan' } },
    });
  });

  it('blocks launch deterministically when the worklist plan identity is unresolved', () => {
    const base = {
      status: 'active',
      itemStatuses: ['todo'],
      actionableItemId: 'P-001',
      now: NOW,
      source: {},
    };

    expect(
      compileGoalPlanPlacement({
        ...base,
        plan: { harness: null, slug: 'alpha', ambiguousMatches: 1 },
      }),
    ).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'resolve-plan-identity', toolCall: null },
    });
    expect(
      compileGoalPlanPlacement({
        ...base,
        plan: { harness: 'papercusp', slug: 'alpha', ambiguousMatches: 2 },
      }),
    ).toMatchObject({
      state: 'blocked',
      reconciliation: { action: 'resolve-plan-identity', toolCall: null },
    });
  });

  it('returns an explicit degraded snapshot instead of dropping a failed canonical read', async () => {
    const brief = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'goal-1',
      sql: mockSql({ failOn: /WITH goal_row AS/ }),
      now: NOW,
      launch,
    });

    expect(brief).not.toBeNull();
    expect(brief?.goal).toMatchObject({ id: 'goal-1', title: 'Keep the portfolio moving', status: null });
    expect(brief?.degradedReasons).toEqual([expect.stringContaining('portfolio read failed: boom')]);
    expect(brief?.priorities).toEqual(['Re-read the goal portfolio before any placement or write.']);
  });

  it('assembles the portfolio only for the GOAL-holder launch slot', async () => {
    const goalSeen: string[] = [];
    const goal = await resolveGoalLaunchForGoal({
      workspaceId: WS,
      goalId: 'goal-1',
      goalRole: 'goal',
      sql: mockSql({
        brief: { 'goal-1': { title: 'Keep the portfolio moving', standing: true } },
        headcount: { 'goal-1': { total: 1, fleet: 0 } },
        portfolio: { 'goal-1': portfolioRow },
        seen: goalSeen,
      }),
    });
    expect(goal.goalBrief?.portfolio?.goal.id).toBe('goal-1');
    expect(goalSeen.some((sql) => sql.includes('WITH goal_row AS'))).toBe(true);

    const childSeen: string[] = [];
    const child = await resolveGoalLaunchForGoal({
      workspaceId: WS,
      goalId: 'goal-1',
      goalRole: 'plan-fleet-leader',
      sql: mockSql({
        brief: { 'goal-1': { title: 'Keep the portfolio moving', standing: true } },
        headcount: { 'goal-1': { total: 1, fleet: 0 } },
        portfolio: { 'goal-1': portfolioRow },
        seen: childSeen,
      }),
    });
    expect(child.goalBrief?.portfolio).toBeUndefined();
    expect(childSeen.some((sql) => sql.includes('WITH goal_row AS'))).toBe(false);
  });
});

describe('P-019 goal attribution ladder', () => {
  const pot = {
    harness: 'papercusp', role: 'owner' as const, note: null,
    killCriterion: 'stop after two failed cuts', linkId: '42',
  };
  it('surfaces missing owner, link criterion and goal stamps as typed issues', () => {
    const verdict = evaluateGoalLadderHealth({
      goalId: 'goal-a',
      pots: [{ ...pot, role: 'contributing', killCriterion: null }],
      plans: [{ ref: 'plan:papercusp/alpha', harness: 'papercusp', goalId: null, exists: true }],
      workItems: [{ id: 'WI-1', harness: 'papercusp', planSlug: 'alpha', goalId: null }],
    });
    expect(verdict.status).toBe('incomplete');
    expect(verdict.issues.map((issue) => issue.code)).toEqual([
      'missing-pot-owner', 'missing-link-kill-criterion', 'unstamped-plan', 'unstamped-work-item',
    ]);
  });

  it('distinguishes wrong attribution from absent attribution, and never calls unreadable healthy', () => {
    const wrong = evaluateGoalLadderHealth({
      goalId: 'goal-a', pots: [pot],
      plans: [{ ref: 'plan:papercusp/alpha', harness: 'papercusp', goalId: 'goal-b', exists: true }],
      workItems: [{ id: 'WI-1', harness: 'papercusp', planSlug: 'alpha', goalId: 'goal-b' }],
    });
    expect(wrong.issues.map((issue) => issue.code)).toEqual(['plan-goal-mismatch', 'work-item-goal-mismatch']);
    expect(evaluateGoalLadderHealth({ goalId: 'goal-a', pots: [], plans: [], workItems: [], unreadable: true }))
      .toMatchObject({ status: 'unknown', issues: [{ code: 'ladder-unreadable' }], remoteOwned: [] });
  });

  // WI-10005269: federation-owned (origin='remote') rows refuse local field edits and the attribution
  // backfill skips them, so no local verb can ever stamp one. Reporting them as an actionable
  // `unstamped-work-item` pinned the ladder at `incomplete` forever. The split is by ORIGIN only.
  describe('remote-owned unstamped work-items', () => {
    const plan = { ref: 'plan:papercusp/alpha', harness: 'papercusp', goalId: 'goal-a', exists: true };
    const remote = { id: 'WI-R', harness: 'papercusp', planSlug: 'alpha', goalId: null, origin: 'remote' };

    it('lists a remote unstamped row as non-blocking remoteOwned, never as an issue', () => {
      const verdict = evaluateGoalLadderHealth({ goalId: 'goal-a', pots: [pot], plans: [plan], workItems: [remote] });
      expect(verdict).toMatchObject({
        status: 'healthy', issues: [], remoteOwned: ['WI-R'], checked: { pots: 1, plans: 1, workItems: 1 },
      });
    });

    it('still fails the ladder for a LOCAL unstamped row beside a remote one (origin, not a blanket skip)', () => {
      const verdict = evaluateGoalLadderHealth({
        goalId: 'goal-a', pots: [pot], plans: [plan],
        workItems: [
          remote,
          { id: 'WI-L', harness: 'papercusp', planSlug: 'alpha', goalId: null, origin: 'local' },
          { id: 'WI-U', harness: 'papercusp', planSlug: 'alpha', goalId: null },
        ],
      });
      expect(verdict.status).toBe('incomplete');
      expect(verdict.issues).toEqual([
        expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-L' }),
        expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-U' }),
      ]);
      expect(verdict.remoteOwned).toEqual(['WI-R']);
    });

    it('does not excuse a remote row stamped to ANOTHER goal — that is a real mismatch', () => {
      const verdict = evaluateGoalLadderHealth({
        goalId: 'goal-a', pots: [pot], plans: [plan], workItems: [{ ...remote, goalId: 'goal-b' }],
      });
      expect(verdict.issues).toEqual([expect.objectContaining({ code: 'work-item-goal-mismatch', ref: 'WI-R' })]);
      expect(verdict.remoteOwned).toEqual([]);
    });
  });
});

describe('P-015 GOAL operating inputs', () => {
  const base = {
    standing: false,
    killCriterion: 'stop if no paying user by day 30',
    budgetCents: 50_000,
    budgetWindowSec: null,
    spentCents: 1_000,
    spentCentsSource: 'goal-lineage-rollup',
    unmeasuredPricedSpend: false,
    tripwires: [{ metric: 'paying_users', threshold: 1 }],
  };

  it('blocks outcome holders missing their stop rule or budget, while a standing duty stays explicitly incomplete', () => {
    const missing = { ...base, killCriterion: null, budgetCents: null };
    const outcome = evaluateGoalOperatingInputs(missing);
    expect(outcome).toMatchObject({ status: 'blocked', canExecute: false, budgetWindow: 'undeclared' });
    expect(goalHolderInputRefusal(outcome)).toContain('missing-kill-criterion');
    expect(goalHolderInputRefusal(outcome)).toContain('missing-budget-ceiling');

    const standing = evaluateGoalOperatingInputs({ ...missing, standing: true });
    expect(standing).toMatchObject({ status: 'incomplete', canExecute: true });
    expect(goalHolderInputRefusal(standing)).toBeNull();
  });

  it('treats countable tripwires without a threshold and priced spend without measurement as recovery work', () => {
    const verdict = evaluateGoalOperatingInputs({
      ...base, tripwires: [{ metric: 'paying_users' }],
      spentCents: null, unmeasuredPricedSpend: true,
    });
    expect(verdict).toMatchObject({ status: 'blocked', spendCoverage: 'unmeasurable' });
    expect(verdict.issues.map((issue) => issue.code)).toEqual([
      'tripwire-missing-threshold', 'spend-unmeasurable',
    ]);
    expect(evaluateGoalOperatingInputs(base)).toMatchObject({ status: 'ready', canExecute: true });
  });
});

describe('resolveGoalLaunch — the D-015 system defaults', () => {
  /**
   * The regression these pin is not "the numbers changed". It is that an
   * UNPINNED goal used to be UNGOVERNED: with both ceilings null, `needsCount`
   * went false, the headcount was never taken and nothing could be refused —
   * while D-004 had already deleted the capacity preflight on the premise that
   * these ceilings were doing the work. Nine of eleven live goals were in that
   * state when it was found.
   */

  it('governs a goal that has pinned NOTHING — the case that was ungoverned', async () => {
    const seen: string[] = [];
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      // No settings row at all: the shape 9 of 11 live goals were in.
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, headcount: { g1: { total: 0, fleet: 0 } }, seen }),
    });
    expect(r.ceilings.maxAgents).toBe(GOAL_LAUNCH_DEFAULTS.maxAgents);
    expect(r.ceilings.maxPerFleet).toBe(GOAL_LAUNCH_DEFAULTS.maxPerFleet);
    // The count is the proof it is ENFORCEABLE, not merely reported: a ceiling
    // nobody counts against refuses nothing.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(true);
  });

  it('actually REFUSES an unpinned goal at the default, rather than reporting a number it ignores', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        headcount: { g1: { total: GOAL_LAUNCH_DEFAULTS.maxAgents, fleet: 0 } },
      }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.limit).toBe(GOAL_LAUNCH_DEFAULTS.maxAgents);
  });

  it('says the ceiling was a DEFAULT, so nobody hunts the panel for a number they never typed', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        headcount: { g1: { total: GOAL_LAUNCH_DEFAULTS.maxAgents, fleet: 0 } },
      }),
    });
    expect(r.refusal?.message).toContain('system default');
  });

  it('gives the exact self-end fallback and warns that idle or parked sessions retain the slot', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        headcount: { g1: { total: GOAL_LAUNCH_DEFAULTS.maxAgents, fleet: 0 } },
      }),
    });
    const message = r.refusal?.message ?? '';
    expect(message).toContain('session:end');
    expect(message).toContain('tools:find');
    expect(message).toContain('tools:invoke');
    expect(message).toMatch(/tools:find.*session:end.*tools:invoke/s);
    expect(message).toMatch(/idle or park.*idle\/parked sessions still retain.*concurrency slot/i);
  });

  it('does NOT claim a default when the owner pinned the number themselves', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 2 } },
        headcount: { g1: { total: 2, fleet: 0 } },
      }),
    });
    expect(r.refusal?.limit).toBe(2);
    expect(r.refusal?.message).not.toContain('system default');
  });

  it('a pinned ceiling beats the default in BOTH directions', async () => {
    const lower = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 3 } },
        headcount: { g1: { total: 0, fleet: 0 } },
      }),
    });
    expect(lower.ceilings.maxAgents).toBe(3);
    const higher = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 400 } },
        headcount: { g1: { total: 0, fleet: 0 } },
      }),
    });
    expect(higher.ceilings.maxAgents).toBe(400);
  });

  it('lets an owner opt a goal OUT entirely, and admits a launch the default would refuse', async () => {
    // The owner-directed half of D-015: absent means "defaulted", so ungoverned
    // has to remain SAYABLE — and saying it has to actually work.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      count: 50,
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING } },
        headcount: { g1: { total: 999, fleet: 0 } },
      }),
    });
    expect(r.ceilings.maxAgents).toBeNull();
    expect(r.refusal).toBeNull();
  });

  it('opting ONE ceiling out leaves the OTHER on its default — they are independent', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING } },
        headcount: { g1: { total: 999, fleet: GOAL_LAUNCH_DEFAULTS.maxPerFleet } },
      }),
    });
    expect(r.ceilings.maxAgents).toBeNull();
    expect(r.ceilings.maxPerFleet).toBe(GOAL_LAUNCH_DEFAULTS.maxPerFleet);
    expect(r.refusal?.reason).toBe('fleet_max_agents');
  });

  it('applies NO ceiling when there is no goal in scope — defaults are per-GOAL, not global', async () => {
    // A launch outside any goal is not a goal launch. Defaulting it to 12 would
    // put a goal-mode ceiling on every ordinary spawn in the workspace.
    const r = await resolveGoalLaunch({ workspaceId: WS, launcherOwnerId: 'su-nobody', sql: mockSql({}) });
    expect(r.goalId).toBeNull();
    expect(r.ceilings).toEqual({ maxAgents: null, maxPerFleet: null });
    expect(r.refusal).toBeNull();
  });
});

describe('resolveCeiling — the three states stay three', () => {
  it('maps each state to its own outcome', () => {
    expect(resolveCeiling(undefined, 12)).toBe(12);
    expect(resolveCeiling(null, 12)).toBe(12);
    expect(resolveCeiling(UNLIMITED_CEILING, 12)).toBeNull();
    expect(resolveCeiling(7, 12)).toBe(7);
  });

  it('keeps unlimited and unpinned DISTINGUISHABLE — collapsing them is the original bug', () => {
    expect(resolveCeiling(UNLIMITED_CEILING, 12)).not.toBe(resolveCeiling(undefined, 12));
  });

  it('defaults are above the contract floor of 8', () => {
    // The GOAL contract obliges a goal agent + a standing drain fleet + one plan
    // fleet. A default below that refuses the fleet the contract mandates, so
    // the default itself would be the bug. This guards the NUMBER against a
    // well-meaning trim.
    expect(GOAL_LAUNCH_DEFAULTS.maxAgents).toBeGreaterThanOrEqual(8);
    // And a goal must be able to run more than one fleet at a time, or
    // "parallelize hard" is unreachable by construction.
    expect(GOAL_LAUNCH_DEFAULTS.maxAgents).toBeGreaterThan(GOAL_LAUNCH_DEFAULTS.maxPerFleet * 2);
  });
});

describe('resolveGoalLaunch — degradation is REPORTED, never silent', () => {
  it('fails OPEN when the headcount cannot be taken, and says the ceiling was not enforced', async () => {
    // Failing closed would brick every launch in the workspace on a transient
    // error, including the launches needed to repair it. But "no refusal" must
    // not be readable as "within the ceiling".
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 1 } },
        failOn: /FROM harness_shared\.session_briefs b/,
      }),
    });
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/ceiling not enforced/);
    expect(r.headcountMeasurement).toBeNull();
  });

  it('reports an unreadable settings document without blocking the launch', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { maxAgents: 'lots' } } }),
    });
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/launch settings not applied/);
  });
});

describe('resolveGoalLaunch — concurrent versus sequential admission evidence (EI-25166050736574344)', () => {
  it('identifies two decisions on one pre-registration population; a sequential second read refuses', async () => {
    const baseSql = mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { maxAgents: 6, maxPerFleet: 3 } } });
    const existing = Array.from({ length: 5 }, (_, index) => ({
      ownerId: `existing-${index}`, inFleet: index === 0, basis: 'boot-grace',
      heartbeatAt: null, briefUpdatedAt: '2026-10-05 18:40:16+00',
    }));
    let readers = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const wrap = (countRead: () => Promise<unknown[]>) => ((strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('').includes('FROM harness_shared.session_briefs b')
        ? countRead() : (baseSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values)
    ) as unknown as Sql;
    const row = (population_rows = existing) => ({
      total: population_rows.length, fleet: population_rows.filter((owner) => owner.inFleet).length,
      measured_at: '2026-10-05 18:40:16+00', population_rows, presence_rows: [],
    });
    const concurrentSql = wrap(async () => {
      const snapshot = row();
      if (++readers === 2) release();
      await barrier;
      return [snapshot];
    });
    const launch = (sql: Sql) => resolveGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'su-goal', fleetSlug: 'f1', count: 1, sql,
    });
    // The resolver is a measurement/decision seam, not a registration or
    // reservation. This fixture does not attribute the original Fire57 run.
    const concurrent = await Promise.all([launch(concurrentSql), launch(concurrentSql)]);
    expect(readers).toBe(2);
    expect(concurrent.map((result) => result.refusal)).toEqual([null, null]);
    expect(concurrent.map((result) => result.headcountMeasurement?.counted.map((owner) => owner.ownerId)))
      .toEqual([existing.map((owner) => owner.ownerId), existing.map((owner) => owner.ownerId)]);
    const sequentialFirst = await launch(wrap(async () => [row()]));
    const sequentialSecond = await launch(wrap(async () => [row([...existing, {
      ownerId: 'first-registration', inFleet: true, basis: 'boot-grace',
      heartbeatAt: null, briefUpdatedAt: '2026-10-05 18:40:16+00',
    }])]));
    expect(sequentialFirst.refusal).toBeNull();
    expect(sequentialSecond.refusal?.reason).toBe('goal_max_agents');
    expect(sequentialSecond.headcountMeasurement?.counted.map((owner) => owner.ownerId)).toContain('first-registration');
  });
});

describe('resolveGoalLaunch — profile hand-down', () => {
  it('hands down the per-SLOT profile the goal declared', async () => {
    // D-016: keyed by launch slot. Before that, this passed psu `--role` and so
    // only ever bound for a goal whose owner had guessed a psu role string.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      goalRole: 'grading',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { defaults: { model: 'sonnet', carry: 'warm' }, roles: { grading: { model: 'opus' } } } },
      }),
    });
    expect(r.effective).toEqual({ model: 'opus', carry: 'warm' });
  });

  it('actually goes through the mode-subject lookup (mock fidelity)', async () => {
    // Guards the mock against itself: every ceiling assertion above depends on
    // the mode-subject leg matching a query the resolver really makes. If that
    // statement's text ever moves, the mock stops matching, `goalId` comes back
    // null, and the ceiling tests all pass by resolving no goal at all.
    const seen: string[] = [];
    await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, seen }),
    });
    expect(seen.some((s) => s.includes('SELECT subject FROM harness_shared.agent_modes'))).toBe(true);
  });
});

/**
 * P-006 (goal-mode-design-intent-hardening-2026-08-16): goals.budget_cents is a
 * BINDING launch ceiling over the PLATFORM spend snapshot. The invariants:
 *
 *   • the ceiling is INCLUSIVE — spent == budget refuses (the off-by-one that
 *     admits one launch past every budget is pinned by a permanent wrong
 *     comparator, the falsifiability control);
 *   • D-003 — a declared budget with NO platform snapshot degrades, it never
 *     guesses (a null from a careful platform outranks an invented figure);
 *   • the kill-switch (flag OFF) is deliberate config and silent, while a flag
 *     INFRA failure is a declared-but-unenforced ceiling and must be reported;
 *   • the refusal escalates the OWNER, deduped per goal, attributed to the
 *     refused launcher.
 */
describe('P-006: the budget launch gate', () => {
  beforeEach(() => {
    budgetGateFlag.value = true;
    budgetGateFlag.throws = false;
    escalated.calls.length = 0;
    liveSpend.legs = { spentCents: null, lineage: 0, lineageUnpriced: 0, pot: 0, session: 0 };
    liveSpend.freshnessStatus = 'fresh';
    liveSpend.throws = false;
    liveSpend.calls = 0;
  });

  const UNPRICED = 'unpriced-lineage-samples';

  const launchWithBudget = (
    budget: {
      budget_cents?: number | string | null;
      spent_cents?: unknown;
      /** WI-10002052 / D-011: why the rollup left spentCents null. */
      spent_cents_unmeasured_reason?: string | null;
      spent_cents_at?: string | null;
      spent_cents_source?: string | null;
      spent_cents_freshness_status?: 'fresh' | 'stale' | 'unavailable' | null;
      spent_cents_freshness_last_ingested_at_ms?: number | string | null;
    },
    seen?: string[],
  ) => {
    const freshSnapshotDefaults = budget.spent_cents_unmeasured_reason === UNPRICED &&
      budget.spent_cents_freshness_status === undefined
      ? {
          spent_cents_freshness_status: 'fresh' as const,
          spent_cents_freshness_last_ingested_at_ms: Date.now(),
        }
      : {};
    return resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        budget: { g1: { ...budget, ...freshSnapshotDefaults } },
        ...(seen ? { seen } : {}),
      }),
    });
  };

  it('refuses at spent == budget (the ceiling is inclusive) and skips the headcount read', async () => {
    const seen: string[] = [];
    const r = await launchWithBudget(
      {
        budget_cents: 5000,
        spent_cents: 5000,
        spent_cents_at: '2026-08-17T03:00:00Z',
        spent_cents_source: 'goal-lineage-rollup',
      },
      seen,
    );
    expect(r.refusal).not.toBeNull();
    expect(r.refusal!.reason).toBe('goal_budget_exceeded');
    expect(r.refusal!.limit).toBe(5000);
    expect(r.refusal!.current).toBe(5000);
    expect(r.refusal!.message).toContain('5000');
    // A formed budget refusal makes the headcount read pure overhead.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(false);
  });

  it('CONTROL (falsifiability): the exclusive comparator admits the boundary the gate refuses', async () => {
    // Permanent wrong implementation — the natural mutant. If the gate ever
    // regresses from >= to >, the boundary case above and this pairing catch it:
    // the control PASSES a spent==budget launch that the real gate refuses.
    const wrongExceeds = (spent: number, budget: number): boolean => spent > budget;
    expect(wrongExceeds(5000, 5000)).toBe(false); // the mutant admits it…
    const r = await launchWithBudget({
      budget_cents: 5000,
      spent_cents: 5000,
      spent_cents_source: 'goal-lineage-rollup',
    });
    expect(r.refusal?.reason).toBe('goal_budget_exceeded'); // …the real gate refuses it
  });

  it('admits under budget, surfaces the truth for display, and the agent ceilings still apply', async () => {
    const seen: string[] = [];
    const r = await launchWithBudget(
      { budget_cents: 5000, spent_cents: 4999, spent_cents_source: 'goal-lineage-rollup' },
      seen,
    );
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(false);
    expect(r.budget).toEqual({
      budgetCents: 5000,
      spentCents: 4999,
      // WI-10002052: the rollup MEASURED, so the unmeasured-spend signal is
      // false by construction and cannot soften this measured reading.
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: 'goal-lineage-rollup',
      interactiveUsageFreshnessStatus: 'fresh',
      interactiveUsageLastIngestedAtMs: expect.any(Number),
    });
    // Under budget the D-015 default ceilings still get their headcount.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(true);
  });

  it('coerces the bigint string budget_cents pg actually hands over', async () => {
    const r = await launchWithBudget({
      budget_cents: '7000',
      spent_cents: 7000,
      spent_cents_source: 'goal-lineage-rollup',
    });
    expect(r.refusal?.reason).toBe('goal_budget_exceeded');
    expect(r.refusal?.limit).toBe(7000);
  });

  it('the retired goal-spend-tick marker no longer carries authority (D-011)', async () => {
    // Its writer was deleted. The cached figure cannot decide admission, and
    // the empty live rollup cannot establish budget headroom either.
    const r = await launchWithBudget({
      budget_cents: '7000',
      spent_cents: 7000,
      spent_cents_source: 'goal-spend-tick',
    });
    expect(liveSpend.calls).toBe(1);
    expect(r.refusal).toMatchObject({
      reason: 'goal_budget_unmeasurable',
      current: null,
      currentScope: REFUSAL_SCOPES.BUDGET_NO_SAMPLES,
    });
  });

  // ── WI-10002052 / D-011 clause 3: an unmeasurable ceiling must not fail OPEN ──
  //
  // `spentCents: null` carries TWO populations, and the rollup names which one in
  // `spentCentsUnmeasuredReason`: no attributed samples, or attributed samples
  // the ledger could not price. Neither supplies a priced spend figure, so
  // launch admission must refuse until the ceiling can be measured.
  it('REFUSES a goal whose window holds attributed samples that carry no price', async () => {
    const r = await launchWithBudget({
      budget_cents: 50000,
      spent_cents: null,
      spent_cents_unmeasured_reason: UNPRICED,
    });
    expect(r.refusal).not.toBeNull();
    expect(r.refusal!.reason).toBe('goal_budget_unmeasurable');
    expect(r.refusal!.limit).toBe(50000);
    // The point of the whole change: it refuses WITHOUT asserting a spend figure.
    expect(r.refusal!.current).toBeNull();
    expect(r.refusal!.currentScope).toBe(REFUSAL_SCOPES.BUDGET_UNMEASURABLE);
    // Refused, not "reported unenforced and admitted anyway".
    expect(r.degraded).toBe(false);
  });

  it('forecloses the forbidden mitigations instead of inviting them (D-004 clause 2)', async () => {
    const r = await launchWithBudget({
      budget_cents: 50000,
      spent_cents: null,
      spent_cents_unmeasured_reason: UNPRICED,
    });
    // Attaching a pot changes nothing since D-011 (spend is not measured from
    // pots), and moving the ceiling only to get admitted fabricates headroom.
    expect(r.refusal!.message).toContain('Do NOT attach a pot');
    expect(r.refusal!.message).toMatch(/repair the pricing of those samples/i);
    expect(r.refusal!.message).not.toContain('Levers: raise or clear budget_cents');
    expect(r.refusal!.message).toContain('do not infer headroom');
  });

  // ── The OTHER null: no snapshot, or an empty authoritative stream ──
  //
  // Neither is evidence that nothing was spent (D-011 clause 3). The gate used to
  // admit both on the absence; D-017 now refuses either when no priced goal spend
  // can be measured, including the all-empty case.
  const NULL_SNAPSHOTS = [null, 'no-lineage-samples'] as const;

  it('REFUSES an empty authoritative stream beside goal usage on the pot/session legs', async () => {
    // The failure the stewardship plan was opened for: 0 attributed samples while
    // the session ledger measured real spend. Never read as "nothing spent".
    for (const spent_cents_unmeasured_reason of NULL_SNAPSHOTS) {
      liveSpend.legs = { spentCents: null, lineage: 0, lineageUnpriced: 0, pot: 0, session: 102 };
      const r = await launchWithBudget({ budget_cents: 50000, spent_cents: null, spent_cents_unmeasured_reason });
      expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
      expect(r.refusal!.current).toBeNull();
      expect(r.refusal!.currentScope).toBe(REFUSAL_SCOPES.BUDGET_UNATTRIBUTED);
      expect(r.refusal!.message).toContain('102 usage sample(s)');
      expect(r.refusal!.message).toContain('Do NOT attach a pot');
      expect(r.degraded).toBe(false);
    }
  });

  it('REFUSES when the launch-time measurement itself fails — no figure, no headroom', async () => {
    for (const spent_cents_unmeasured_reason of NULL_SNAPSHOTS) {
      liveSpend.throws = true;
      const r = await launchWithBudget({ budget_cents: 50000, spent_cents: null, spent_cents_unmeasured_reason });
      expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
      expect(r.refusal!.currentScope).toBe(REFUSAL_SCOPES.BUDGET_MEASUREMENT_FAILED);
      expect(r.refusal!.message).toContain('ledger read failed');
    }
  });

  it('refuses unpriced samples found at launch exactly as it refuses the snapshot reason', async () => {
    liveSpend.legs = { spentCents: null, lineage: 4, lineageUnpriced: 1, pot: 0, session: 4 };
    const r = await launchWithBudget({ budget_cents: 50000, spent_cents: null });
    expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
    expect(r.refusal!.currentScope).toBe(REFUSAL_SCOPES.BUDGET_UNMEASURABLE);
  });

  it('enforces the ceiling on a figure measured at launch when the snapshot carried none', async () => {
    liveSpend.legs = { spentCents: 6000, lineage: 30, lineageUnpriced: 0, pot: 0, session: 30 };
    const over = await launchWithBudget({ budget_cents: 5000, spent_cents: null });
    expect(over.refusal?.reason).toBe('goal_budget_exceeded');
    expect(over.refusal!.current).toBe(6000);
    expect(over.refusal!.currentScope).toBe(REFUSAL_SCOPES.BUDGET_LINEAGE);
    expect(over.refusal!.message).toContain('measured at launch');

    liveSpend.legs = { spentCents: 100, lineage: 3, lineageUnpriced: 0, pot: 0, session: 3 };
    const under = await launchWithBudget({ budget_cents: 5000, spent_cents: null });
    expect(under.refusal).toBeNull();
    // Measured, so nothing about the budget is reported unenforced.
    expect(under.degradedReasons.filter((s) => s.includes('budget'))).toEqual([]);
  });

  it('REFUSES the all-empty bootstrap because no priced spend was measured (D-011)', async () => {
    for (const spent_cents_unmeasured_reason of NULL_SNAPSHOTS) {
      const r = await launchWithBudget({ budget_cents: 50000, spent_cents: null, spent_cents_unmeasured_reason });
      expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
      expect(r.refusal?.current).toBeNull();
      expect(r.refusal?.currentScope).toBe(REFUSAL_SCOPES.BUDGET_NO_SAMPLES);
      expect(r.degraded).toBe(false);
    }
  });

  it('classifies diagnostic-only usage separately from an all-empty refusal', async () => {
    // Both cases refuse admission. A diagnostic-only sample changes the refusal
    // scope to unattributed usage without inventing a priced goal spend figure.
    for (const legs of [
      { spentCents: null, lineage: 0, lineageUnpriced: 0, pot: 1, session: 0 },
      { spentCents: null, lineage: 0, lineageUnpriced: 0, pot: 0, session: 1 },
    ]) {
      liveSpend.legs = legs;
      const r = await launchWithBudget({ budget_cents: 50000, spent_cents: null });
      expect(r.refusal?.currentScope).toBe(REFUSAL_SCOPES.BUDGET_UNATTRIBUTED);
    }
  });

  it('reads the ledger at launch only when the snapshot has no figure and no unpriced reason', async () => {
    await launchWithBudget({ budget_cents: 50000, spent_cents: null, spent_cents_unmeasured_reason: UNPRICED });
    await launchWithBudget({
      budget_cents: 50000,
      spent_cents: 10,
      spent_cents_source: 'goal-lineage-rollup',
    });
    expect(liveSpend.calls).toBe(0);
    await launchWithBudget({ budget_cents: 50000, spent_cents: null });
    expect(liveSpend.calls).toBe(1);
  });

  it.each(['stale', 'unavailable'] as const)(
    're-measures a stale snapshot and refuses %s live usage without an authoritative spend figure', async (status) => {
      liveSpend.freshnessStatus = status;
      liveSpend.legs = { spentCents: null, lineage: 1, lineageUnpriced: 0, pot: 0, session: 1 };
      const r = await launchWithBudget({
        budget_cents: 5000,
        spent_cents: 6000,
        spent_cents_source: 'goal-lineage-rollup',
        spent_cents_freshness_status: 'fresh',
        spent_cents_freshness_last_ingested_at_ms: Date.now() - 31 * 60_000,
      });
      expect(liveSpend.calls).toBe(1);
      expect(r.refusal).toMatchObject({
        reason: 'goal_budget_unmeasurable',
        current: null,
        currentScope: REFUSAL_SCOPES.BUDGET_MEASUREMENT_FAILED,
      });
      expect(r.refusal?.message).toContain(`interactive usage stream is ${status}`);
      expect(r.degradedReasons.some((reason) => reason.includes('admitted as headroom'))).toBe(false);
      await vi.waitFor(() => expect(escalated.calls.length).toBe(1));
      expect(String(escalated.calls[0]?.summary)).toContain('UNMEASURABLE');
    },
  );

  it('opens a distinctly-deduped owner escalation, so the refusal is never silent', async () => {
    await launchWithBudget({
      budget_cents: 50000,
      spent_cents: null,
      spent_cents_unmeasured_reason: UNPRICED,
    });
    await vi.waitFor(() => expect(escalated.calls.length).toBe(1));
    const call = escalated.calls[0]!;
    expect(String(call.summary)).toContain('UNMEASURABLE');
    // A separate dedup kind from 'goal-budget-exceeded': different problem,
    // different levers. Sharing one card would let the first hide the second.
    expect((call.meta as Record<string, unknown>).dedupKind).toBe('goal-budget-unmeasurable');
  });

  it('CONTROL (falsifiability): a MEASURED figure suppresses the signal entirely', () => {
    // The signal can only ever ADD a refusal where the gate would fail open,
    // never soften or override a measured one. A mutant that dropped the
    // spentCents guard would fail here while every other test above still passed.
    expect(hasUnmeasuredPricedSpend(UNPRICED, 4999)).toBe(false);
    expect(hasUnmeasuredPricedSpend(UNPRICED, 0)).toBe(false);
    expect(hasUnmeasuredPricedSpend(UNPRICED, null)).toBe(true);
  });

  it('only the unpriced-samples reason is a hole — any other value is not evidence of spend', () => {
    expect(hasUnmeasuredPricedSpend('no-lineage-samples', null)).toBe(false);
    expect(hasUnmeasuredPricedSpend(null, null)).toBe(false);
    // The retired breakdown object shape must not be mistaken for the reason.
    expect(hasUnmeasuredPricedSpend({ sessionCents: 42042, sessionSamples: 193 }, null)).toBe(false);
    expect(hasUnmeasuredPricedSpend([], null)).toBe(false);
  });

  it('D-003: a declared budget with NO snapshot is measured at launch — never guessed', async () => {
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: null });
    expect(liveSpend.calls).toBe(1);
    expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
    expect(r.refusal?.currentScope).toBe(REFUSAL_SCOPES.BUDGET_NO_SAMPLES);
    expect(r.refusal?.current).toBeNull();
  });

  it('re-measures untrusted cached cents and admits only measured live headroom', async () => {
    for (const spent_cents_source of [null, 'legacy-import']) {
      liveSpend.legs = { spentCents: 100, lineage: 2, lineageUnpriced: 0, pot: 0, session: 2 };
      const seen: string[] = [];
      const r = await launchWithBudget(
        { budget_cents: 5000, spent_cents: 6000, spent_cents_source },
        seen,
      );
      expect(r.refusal).toBeNull();
      expect(r.degraded).toBe(false);
      expect(r.budget?.spentCents).toBe(6000);
      expect(r.budget?.spentCentsSource).toBe(spent_cents_source);
      // The cached 6000 cannot refuse against this 5000 cap; live 100 can admit.
      expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(true);
    }
    expect(liveSpend.calls).toBe(2);
  });

  it.each([null, 'legacy-import'])(
    'refuses an unmeasured live rollup behind untrusted cached provenance %s', async (spent_cents_source) => {
      const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 100, spent_cents_source });
      expect(liveSpend.calls).toBe(1);
      expect(r.refusal).toMatchObject({
        reason: 'goal_budget_unmeasurable',
        current: null,
        currentScope: REFUSAL_SCOPES.BUDGET_NO_SAMPLES,
      });
    },
  );

  it('refuses a measured live breach behind an untrusted under-budget cache', async () => {
    liveSpend.legs = { spentCents: 5000, lineage: 2, lineageUnpriced: 0, pot: 0, session: 2 };
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 100, spent_cents_source: 'legacy-import' });
    expect(liveSpend.calls).toBe(1);
    expect(r.refusal).toMatchObject({
      reason: 'goal_budget_exceeded',
      current: 5000,
      currentScope: REFUSAL_SCOPES.BUDGET_LINEAGE,
    });
  });

  it('garbage spentCents stays UNKNOWN and cannot admit a launch on an empty live measurement', async () => {
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 'not-a-number' });
    expect(r.refusal?.reason).toBe('goal_budget_unmeasurable');
    expect(r.refusal?.currentScope).toBe(REFUSAL_SCOPES.BUDGET_NO_SAMPLES);
    expect(r.budget?.spentCents).toBeNull();
    expect(r.degraded).toBe(false);
  });

  it('no budget declared → the gate is silent (no refusal, no degradation)', async () => {
    const r = await launchWithBudget({ budget_cents: null, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.filter((s) => s.includes('budget'))).toEqual([]);
    expect(r.budget).toEqual({
      budgetCents: null,
      spentCents: 9999,
      // WI-10002052: measured, so no unmeasured spend to flag — and with no
      // ceiling declared the gate has nothing to enforce either way.
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: null,
      interactiveUsageFreshnessStatus: 'fresh',
      interactiveUsageLastIngestedAtMs: expect.any(Number),
    });
  });

  it('kill-switch: flag OFF admits over-budget launches SILENTLY (deliberate config, not degradation)', async () => {
    budgetGateFlag.value = false;
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.filter((s) => s.includes('budget'))).toEqual([]);
    expect(escalated.calls.length).toBe(0);
  });

  it('flag INFRA failure fails OPEN but is REPORTED — a declared ceiling silently unenforced is the bug', async () => {
    budgetGateFlag.throws = true;
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.some((s) => s.includes('flag read failed'))).toBe(true);
  });

  it('escalates the owner on refusal: blocker severity, deduped per goal, attributed to the launcher', async () => {
    await launchWithBudget({
      budget_cents: 5000,
      spent_cents: 6000,
      spent_cents_source: 'goal-lineage-rollup',
    });
    await vi.waitFor(() => expect(escalated.calls.length).toBe(1));
    const call = escalated.calls[0]!;
    expect(call.severity).toBe('blocker');
    const meta = call.meta as Record<string, unknown>;
    expect(meta.dedupKind).toBe('goal-budget-exceeded');
    expect(meta.subjectSignature).toBe(`${WS}:g1`);
    expect((call.identity as { ownerId: string }).ownerId).toBe('su-goal');
  });
});

describe('per-turn goal inference budget admission (WI-10003507)', () => {
  const base = {
    goalId: 'goal-1',
    goalStatus: 'active',
    budgetCents: 1000,
    budgetWindowSec: 21600,
  };
  const rollup = (override: Record<string, unknown> = {}) =>
    ({
      spentCents: null,
      unmeasuredReason: 'no-lineage-samples',
      windowSec: 21600,
      samples: 0,
      pot: { samples: 0 },
      session: { samples: 0 },
      lineage: { samples: 0, unpricedSamples: 0 },
      interactiveUsageFreshness: {
        status: 'fresh', lastIngestedAtMs: 1, ageMs: 0, windowMs: 30 * 60_000, reason: 'test fresh data',
      },
      ...override,
    }) as unknown as GoalSpendRollup;

  it('refuses unmeasured spend even when every usage leg is empty, and refuses a reached ceiling', () => {
    expect(evaluateGoalInferenceBudget({ ...base, rollup: rollup() })).toMatchObject({
      allowed: false,
      status: 403,
      code: 'goal_budget_unmeasurable',
      spentCents: null,
    });
    expect(
      evaluateGoalInferenceBudget({
        ...base,
        rollup: rollup({ samples: 1, session: { samples: 1 } }),
      }),
    ).toMatchObject({ allowed: false, status: 403, code: 'goal_budget_unmeasurable' });
    expect(
      evaluateGoalInferenceBudget({
        ...base,
        rollup: rollup({ spentCents: 1000, unmeasuredReason: null }),
      }),
    ).toMatchObject({ allowed: false, status: 403, code: 'goal_budget_exceeded', spentCents: 1000 });
  });

  it.each(['interactive-usage-stale', 'interactive-usage-unavailable'] as const)(
    'refuses %s live spend when usage rows exist but its price cannot be verified', (unmeasuredReason) => {
      const status = unmeasuredReason === 'interactive-usage-stale' ? 'stale' : 'unavailable';
      const decision = evaluateGoalInferenceBudget({
        ...base,
        rollup: rollup({
          unmeasuredReason,
          samples: 1,
          pot: { samples: 1 },
          session: { samples: 0 },
          lineage: { samples: 1, unpricedSamples: 0 },
          interactiveUsageFreshness: {
            status, lastIngestedAtMs: null, ageMs: null, windowMs: 30 * 60_000, reason: unmeasuredReason,
          },
        }),
      });
      expect(decision).toMatchObject({
        allowed: false,
        goalId: 'goal-1',
        status: 503,
        code: 'goal_budget_unmeasurable',
        spentCents: null,
      });
      if (!decision.allowed) expect(decision.message).toContain(unmeasuredReason);
    },
  );

  it('resolves the active goal and measures current spend before allowing another turn', async () => {
    budgetGateFlag.value = true;
    budgetGateFlag.throws = false;
    liveSpend.throws = false;
    liveSpend.legs = { spentCents: 1001, lineage: 4, lineageUnpriced: 0, pot: 2, session: 2 };
    const seen: string[] = [];
    const before = liveSpend.calls;
    const sql = mockSql({
      modeSubject: { 'owner-1': 'goal-1' },
      budget: { 'goal-1': { budget_cents: 1000 } },
      brief: { 'goal-1': { budget_window_sec: 21600 } },
      seen,
    });

    const decision = await checkGoalInferenceAdmission({ workspaceId: WS, ownerId: 'owner-1', sql });

    expect(decision).toMatchObject({
      allowed: false,
      status: 403,
      code: 'goal_budget_exceeded',
      goalId: 'goal-1',
      spentCents: 1001,
    });
    expect(liveSpend.calls).toBe(before + 1);
    expect(seen.some((statement) => statement.includes('SELECT status, budget_cents, budget_window_sec'))).toBe(true);
  });

  it('fails closed when the live spend measurement fails', async () => {
    budgetGateFlag.value = true;
    budgetGateFlag.throws = false;
    liveSpend.throws = true;
    const sql = mockSql({
      modeSubject: { 'owner-1': 'goal-1' },
      budget: { 'goal-1': { budget_cents: 1000 } },
      brief: { 'goal-1': { budget_window_sec: 21600 } },
    });

    const decision = await checkGoalInferenceAdmission({ workspaceId: WS, ownerId: 'owner-1', sql });

    expect(decision).toMatchObject({
      allowed: false,
      status: 503,
      code: 'goal_budget_unmeasurable',
    });
  });
});
