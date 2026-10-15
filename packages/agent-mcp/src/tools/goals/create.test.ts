/**
 * goals:create — the write half of `harness_shared.goals`
 * (goal-mode-2026-08-07 P-009).
 *
 * The behaviours worth pinning are the ones the SCHEMA punishes silently:
 * `workspace_id` is NOT NULL with a `CHECK (workspace_id <> '')`, so the
 * blank-stamp fallback that other write tools use here would produce a
 * constraint error instead of a legible refusal — and would have re-created the
 * blank-workspace rows EI-280 had to repair. The rest is the goal-vs-pot
 * distinction: the kill criterion and spend ceiling must survive the write,
 * because they are the whole reason a goal needs a record of its own.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import tool, { goalId, GOAL_STATUSES } from './create';
import { PLATFORM_POT_SLUG } from '@papercusp/operator-core/lib/platform-pot-slug';
import { HARNESS_SLUG_RE } from '@papercusp/operator-core/lib/harness-slug';

// ── P-010 (consult-min-max-and-rubric-vetting-2026-08-17): the goal-kickoff
// consult's wiring is dynamically imported by the handler; mock every leg so
// the consult branch is deterministic (no embedder, no PG, no liveness oracle)
// and drivable per-test via `goalKickoffConsultMock`.
const { goalKickoffConsultMock, routeConsultMock, recordRoutingMock } = vi.hoisted(() => ({
  goalKickoffConsultMock: vi.fn(), routeConsultMock: vi.fn(), recordRoutingMock: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} as never }) }));
vi.mock('@papercusp/operator-core/lib/consult/relevance-router', () => ({ routeConsult: routeConsultMock }));
vi.mock('@papercusp/operator-core/lib/endpoint-route/telemetry', () => ({ recordExpertiseRoutingInvocation: recordRoutingMock }));
vi.mock('@papercusp/operator-core/lib/build-info', () => ({ getBuildInfo: () => ({ sha: 'fixture-build' }) }));
vi.mock('@papercusp/operator-core/lib/agent-tools/search/embedder', () => ({
  buildQueryEmbedderResolved: vi.fn(async () => ({
    mode: 'local',
    dims: 1,
    profile: { provider: 'fixture' },
    embed: vi.fn(async () => [0]),
  })),
}));
vi.mock('@papercusp/operator-core/lib/search/prose-vector-dims', () => ({
  resolveProseProfileSelection: vi.fn(() => ({ provider: 'fixture' })),
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: vi.fn(async () => new Map()),
}));
vi.mock('@papercusp/operator-core/lib/consult/plan-start-consult', () => ({
  goalKickoffConsult: goalKickoffConsultMock,
  fetchTurnExcerpts: vi.fn(async () => []),
}));

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let gucWorkspace: string | null = null;
/** Whether the caller has a GOAL-mode row — answers BOTH the P-010 kickoff
 * gating SELECT and the subject-stamp UPDATE (one definition of "in GOAL
 * mode", same as the handler's shared predicate). */
let callerInGoalMode = false;
/** Forces the subject stamp to throw, proving the goal still gets created. */
let modeUpdateThrows = false;
/** Forces the kickoff gating SELECT to throw — the consult must fail OPEN. */
let modeSelectThrows = false;

/** A postgres-js-shaped tagged-template `tx` that records what it was asked. */
function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/current_setting/.test(sql)) return Promise.resolve([{ ws: gucWorkspace }]);
    if (/SELECT[^]*FROM harness_shared\.agent_modes/.test(sql)) {
      if (modeSelectThrows) return Promise.reject(new Error('agent_modes read is down'));
      return Promise.resolve(callerInGoalMode ? [{ owner_id: 'su-test' }] : []);
    }
    if (/UPDATE harness_shared\.agent_modes/.test(sql)) {
      if (modeUpdateThrows) return Promise.reject(new Error('agent_modes is on fire'));
      return Promise.resolve(callerInGoalMode ? [{ owner_id: 'su-test' }] : []);
    }
    return Promise.resolve([]);
  };
}

const CTX = (over: Record<string, unknown> = {}) => ({
  tx: makeTx() as never,
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  uiClientId: 'su-test',
  log: () => {},
  ...over,
});

/**
 * The default fixture DECLARES a holder policy because the door now requires
 * one (goal-live-holder-guarantee-2026-08-18 P-003): every goal created here
 * would otherwise inherit the live-holder requirement without its creator
 * having chosen it, which is exactly what that item refuses.
 *
 * It lives in the shared fixture rather than being sprinkled per test so the
 * tests below keep testing what they are named for. Any test that cares about
 * the holder policy itself overrides it — including with `holder: undefined`,
 * which is how the refusal is exercised.
 */
const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ title: 'Ship a paid app', holder: { requireLive: true }, ...over });

/**
 * `handler` is typed as the `ToolResult | ToolResponse<unknown>` union, so a
 * bare `res.data` does not narrow. The rest of this package's test corpus reads
 * it unnarrowed and carries the resulting TS2339s in its baseline; narrowing
 * here keeps these files from adding to that pile.
 */
type Res = { data: unknown; degraded?: boolean; degradedReasons?: string[] };
const call = async (args: unknown, ctx: unknown): Promise<Res> =>
  (await tool.handler(args as never, ctx as never)) as Res;

beforeEach(() => {
  calls = [];
  gucWorkspace = null;
  callerInGoalMode = false;
  modeUpdateThrows = false;
  modeSelectThrows = false;
  goalKickoffConsultMock.mockReset();
  routeConsultMock.mockReset();
  recordRoutingMock.mockReset();
  // Default: routing found nothing — the consult proceeds silently, so every
  // pre-P-010 test observes the exact behaviour it always did.
  goalKickoffConsultMock.mockResolvedValue({ outcome: 'proceed', verdict: 'no_qualified_responder' });
});

describe('goals:create — workspace resolution', () => {
  it('prefers the app.workspace_id GUC over ctx.workspaceId', async () => {
    gucWorkspace = 'from-guc';
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('from-guc');
  });

  it('falls back to ctx.workspaceId when the GUC is unset', async () => {
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('papercusp-workspace');
  });

  it('REFUSES rather than writing a blank workspace_id the CHECK would reject', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: undefined }));
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toMatch(/workspace/i);
    // The refusal must happen BEFORE the insert, not be cleaned up after one.
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('treats the wildcard workspace "*" as no concrete workspace', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: '*' }));
    expect(res.data).toBeNull();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('refuses when no harness is in scope — a goal is filed against an install', async () => {
    const res = await call(ARGS(), CTX({ harnessSlug: undefined }));
    expect(res.data).toBeNull();
    expect(res.degradedReasons?.join(' ')).toMatch(/harness/i);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });
});

/* ── the wildcard install_slug that produced an unlaunchable goal
   (EI-21563406996333542) ──────────────────────────────────────────────────────
   `install_slug` used to be `ctx.harnessSlug` RAW, so a workspace-global session
   stored the wildcard `'*'`. Nothing complained: it satisfies the NOT NULL, reads
   healthy on every surface, and the goal sat `active` looking perfectly ordinary.
   It was PERMANENTLY UNLAUNCHABLE — `adv/launch-su` refuses a slug failing
   HARNESS_SLUG_RE, so the holder spawn died with a bare "invalid harness slug"
   that pointed nowhere near creation.

   The reason this stayed invisible is worth stating, because it is what makes a
   regression here expensive rather than merely wrong: the `launchSettings.autoStart`
   leg is itself unreachable (EI-21562402496780915), so NOTHING ever attempted to
   launch such a goal. A write bug whose only detector is a code path that never
   runs is discovered by a human wondering why a goal never started.

   So these assert the STORED value, not just the returned one — the bug was
   entirely about what landed in the column. ── */
describe('goals:create — a wildcard scope resolves to a LAUNCHABLE install_slug', () => {
  /** `install_slug` is the 2nd bound param of the goals INSERT (id, install_slug, …). */
  const writtenInstallSlug = (): unknown =>
    calls.find((c) => /INSERT INTO\s+harness_shared\.goals/.test(c.sql))?.params[1];

  for (const wildcard of ['*', 'all']) {
    it(`resolves the workspace-global scope ${JSON.stringify(wildcard)} to the platform Pot`, async () => {
      const res = await call(ARGS(), CTX({ harnessSlug: wildcard }));
      // What actually reached the column — the bug was a stored value, so the
      // returned field alone would not have caught it.
      expect(writtenInstallSlug()).toBe(PLATFORM_POT_SLUG);
      expect((res.data as { install_slug: string }).install_slug).toBe(PLATFORM_POT_SLUG);
    });

    it(`never stores ${JSON.stringify(wildcard)} raw — the stored slug must satisfy the LAUNCH door`, async () => {
      await call(ARGS(), CTX({ harnessSlug: wildcard }));
      const stored = writtenInstallSlug();
      expect(stored).not.toBe(wildcard);
      // The invariant that actually matters, asserted against the same constant
      // `adv/launch-su` applies — not a copy of the pattern, which is free to drift.
      expect(HARNESS_SLUG_RE.test(String(stored))).toBe(true);
    });
  }

  it('leaves a concrete harness slug alone — resolution is scoped to the wildcards', async () => {
    await call(ARGS(), CTX({ harnessSlug: 'some-other-pot' }));
    expect(writtenInstallSlug()).toBe('some-other-pot');
  });

  /* The calibration case. Without it, every assertion above also passes when the
     wildcard is simply never reached — e.g. if a refusal moved ahead of the
     resolution and no INSERT ran at all, `writtenInstallSlug()` is `undefined`
     and `.not.toBe('*')` is trivially true. This pins that the fixture really
     does drive an insert. */
  it('CONTROL: the fixture reaches the insert at all', async () => {
    await call(ARGS(), CTX());
    expect(writtenInstallSlug()).toBe('papercusp');
  });

  /* The falsifiability control. A guard that has never failed is a guard nobody
     has tested, and the assertions above cannot demonstrate their own teeth: if
     the resolution were deleted tomorrow they would fail, but nothing here shows
     that. So the PRE-FIX implementation is kept as a deliberately-wrong control
     (the repo's prescribed shape for a subject you import rather than read from
     a path) — it stores `ctx.harnessSlug` raw, exactly as the handler did, and
     is measured against the same predicate. If this ever passes, the predicate
     has stopped discriminating and every assertion above is vacuous. */
  it('CONTROL: the pre-fix implementation FAILS the predicate these tests assert', () => {
    const preFixInstallSlug = (harnessSlug: string): string => harnessSlug;
    expect(HARNESS_SLUG_RE.test(preFixInstallSlug('*'))).toBe(false);
    expect(preFixInstallSlug('*')).not.toBe(PLATFORM_POT_SLUG);
  });
});

/* ── the holder-policy write boundary (goal-live-holder-guarantee-2026-08-18
   P-003, D-008) ───────────────────────────────────────────────────────────────
   `requireLive` defaults TRUE at READ time so the goals that already existed are
   covered with no migration. That default is a rescue for the legacy population,
   not a licence for it to grow — so this door refuses a NEW goal whose creator
   declared nothing, and the undeclared set can only shrink from here. ── */
describe('goals:create — a goal must declare its holder policy', () => {
  it('REFUSES a goal that declares no holder policy, BEFORE any insert', async () => {
    const res = await call(ARGS({ holder: undefined }), CTX());
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toMatch(/holder policy/i);
    // Refused, not written-then-repaired: a goal that exists for even a moment
    // with no declared policy is the state this guard exists to prevent.
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  /* The column is written as a JSON STRING param, so read it back by PARSING
     the param rather than substring-matching the serialised params array:
     `JSON.stringify(params)` escapes the inner quotes, so a `'"requireLive":false'`
     substring can never match however correct the code is — a false red that
     says nothing about the subject. */
  const holderWritten = () => {
    const insert = calls.find((c) => /INSERT INTO harness_shared\.goals/.test(c.sql))!;
    expect(insert.sql).toMatch(/launch_settings/);
    // Params ride in COLUMN order, so read launch_settings by its position in
    // the INSERT's column list — "last param" broke the moment P-021 appended
    // input_schema/inputs/output_schema after it, and would break again on the
    // next append.
    const cols = /\(([^)]*)\)\s*VALUES/i
      .exec(insert.sql.replace(/\s+/g, ' '))![1]
      .split(',')
      .map((c) => c.trim());
    const raw = insert.params[cols.indexOf('launch_settings')];
    return raw == null ? null : (JSON.parse(String(raw)) as { holder?: Record<string, unknown> }).holder;
  };

  it('ACCEPTS an explicit opt-OUT and stores it — the escape hatch must be sayable', async () => {
    const res = await call(ARGS({ holder: { requireLive: false } }), CTX());
    expect(res.data).not.toBeNull();
    expect(holderWritten()).toEqual({ requireLive: false });
  });

  it('persists the declared policy into launch_settings on the SAME insert', async () => {
    // Same statement as the row it governs, not a follow-up write: a two-write
    // shape has a window in which the goal exists undeclared, and on a failure
    // between them that window never closes.
    const res = await call(ARGS({ holder: { requireLive: true, onLoss: 'respawn' } }), CTX());
    expect(res.data).not.toBeNull();
    expect(holderWritten()).toEqual({ requireLive: true, onLoss: 'respawn' });
  });

  /* CONTROL. Without this, every assertion above still passes if the door
     refused EVERY create — strict-looking and broken, with no way for the suite
     to tell the difference. The default fixture declares a policy, so this also
     pins that declaring is genuinely sufficient. */
  it('CONTROL: a declared policy is admitted and writes the row', async () => {
    const res = await call(ARGS(), CTX());
    expect(res.data).not.toBeNull();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
  });
});

describe('goals:create — what the row must carry', () => {
  it('creates a paused standing record with its window and complete launch settings', async () => {
    const launchSettings = {
      holder: { requireLive: true, onLoss: 'deactivate' },
      defaults: { agent: 'codex', model: 'fixture-model', carry: 'warm' },
      roles: { goal: { effort: 'high', account: 'example' } },
    };
    const res = await call(ARGS({
      status: 'paused', standing: true, budgetCents: 50_000, budgetWindowSec: 604_800,
      holder: undefined, launchSettings,
    }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    const columns = insert.sql.match(/\(([^]*?)\)\s*VALUES/)![1]!.replace(/\s/g, '').split(',');
    const value = (column: string) => insert.params[columns.indexOf(column)];
    expect(value('standing')).toBe(true);
    expect(value('status')).toBe('paused');
    expect(value('budget_window_sec')).toBe(604_800);
    expect(JSON.parse(value('launch_settings') as string)).toEqual(launchSettings);
    expect(res.data).toMatchObject({ status: 'paused', standing: true, budget_window_sec: 604_800,
      mode_subject_stamped: false });
    const modeStamp = calls.find((c) => /UPDATE harness_shared\.agent_modes/.test(c.sql));
    expect(modeStamp?.sql).toMatch(/mode = 'goal'/);
  });

  it('overlays the explicit holder policy without dropping launch settings siblings', async () => {
    await call(ARGS({ holder: { requireLive: false }, launchSettings: {
      holder: { requireLive: true }, defaults: { model: 'fixture-model' }, maxAgents: 4,
    } }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.params).toContain(JSON.stringify({
      maxAgents: 4, defaults: { model: 'fixture-model' }, holder: { requireLive: false },
    }));
  });

  it('rejects invalid launch settings and nonpositive windows before a write', () => {
    expect(() => ARGS({ launchSettings: { roles: { unknown: {} } } })).toThrow();
    expect(() => ARGS({ budgetWindowSec: 0 })).toThrow();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('checks window-specific tripwires against the declared creation window', async () => {
    const res = await call(ARGS({ budgetWindowSec: 604_800,
      tripwires: [{ metric: 'spend_usd_7d', label: '7d spend', threshold: 100, unit: 'usd' }],
    }), CTX());
    expect(res.data).not.toHaveProperty('tripwire_advisories');
  });

  it('persists the kill criterion, which no pot could carry for a multi-project goal', async () => {
    const res = await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    expect((res.data as { kill_criterion: string }).kill_criterion).toBe('no paying user after 2 weeks');
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).toContain('no paying user after 2 weeks');
  });

  it('persists the declared spend ceiling', async () => {
    const res = await call(ARGS({ budgetCents: 50_000 }), CTX());
    expect((res.data as { budget_cents: number }).budget_cents).toBe(50_000);
  });

  it('writes null metadata rather than an empty object when there is nothing to record', async () => {
    await call(ARGS(), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.params).toContain(null);
    expect(JSON.stringify(insert.params)).not.toContain('{}');
  });

  it('supports a sub-goal via parentId (the table\'s self-referencing lineage edge)', async () => {
    const res = await call(ARGS({ parentId: 'parent-abc123' }), CTX());
    expect((res.data as { parent_id: string }).parent_id).toBe('parent-abc123');
  });
});

describe('goals:create — the kill criterion is a COLUMN, not a metadata key', () => {
  /**
   * It lived in `metadata` only because the column did not exist. The whole GUI
   * reads it — the detail view's "THIS GOAL ENDS WHEN" headline is the single
   * most load-bearing string in goal mode — and a jsonb key cannot be indexed
   * or joined the way the read path needs. If this regresses, the criterion
   * still *round-trips through the tool* (so a handler test alone would pass)
   * while rendering blank everywhere the owner actually looks.
   */
  it('sends the criterion to the kill_criterion column and NOT into metadata', async () => {
    await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.sql).toMatch(/kill_criterion/);
    // The metadata parameter must be null — the criterion is not hiding in it.
    const jsonParams = insert.params.filter((p): p is string => typeof p === 'string' && p.startsWith('{'));
    expect(jsonParams.join(' ')).not.toContain('no paying user');
  });

  it('persists tripwires as jsonb so the criterion renders as bars, not prose', async () => {
    const tripwires = [
      { metric: 'spend_usd', label: '$310 of $500', threshold: 500, current: 310, unit: 'usd' },
    ];
    const res = await call(ARGS({ killCriterion: 'stop at $500', tripwires }), CTX());
    expect((res.data as { tripwires: unknown }).tripwires).toEqual(tripwires);
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.sql).toMatch(/tripwires/);
    expect(JSON.stringify(insert.params)).toContain('spend_usd');
  });

  it('advises on a tripwire that reads as platform-measured but no resolver measures (WI-10004424)', async () => {
    const tripwires = [
      { metric: 'spend_usd_week', label: 'weekly spend', threshold: 100, unit: 'usd' },
      { metric: 'spend_usd', label: 'spend', threshold: 500, unit: 'usd' },
      { metric: 'species_covered', label: 'species', threshold: 20 },
    ];
    const res = await call(ARGS({ killCriterion: 'stop at $500 total spend', tripwires }), CTX());
    const data = res.data as { tripwire_advisories?: Array<{ metric: string; suggestedMetric: string | null }> };
    // The goal is still written — the advisory never blocks.
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
    expect(data.tripwire_advisories?.map((a) => [a.metric, a.suggestedMetric])).toEqual([
      ['spend_usd_week', 'spend_usd_7d'],
    ]);
  });

  it('advises that a window-suffixed spend metric is never measured on a lifetime-window goal', async () => {
    // goals:create writes no budget window, and spend_usd_7d resolves only on a 7d one.
    const tripwires = [{ metric: 'spend_usd_7d', label: '7d spend', threshold: 100, unit: 'usd' }];
    const res = await call(ARGS({ killCriterion: 'stop at $100 per week', tripwires }), CTX());
    const data = res.data as { tripwire_advisories?: Array<{ code: string }> };
    expect(data.tripwire_advisories?.map((a) => a.code)).toEqual(['spend-window-never-measured']);
  });

  it('omits tripwire_advisories when every tripwire is measured or executor-scored', async () => {
    const tripwires = [
      { metric: 'spend_usd', label: 'spend', threshold: 500, unit: 'usd' },
      { metric: 'days_elapsed', label: 'day of 30', threshold: 30 },
    ];
    const res = await call(ARGS({ killCriterion: 'stop at $500 total spend', tripwires }), CTX());
    expect(res.data).not.toHaveProperty('tripwire_advisories');
  });

  it('leaves tripwires null when none are given — a prose-only criterion is valid', async () => {
    // ⚠ The criterion here must clear `killCriterionProblem` (≥12 chars, no
    // placeholder opener). This test is about TRIPWIRES — the criterion is
    // incidental fixture data — but since EI-20049757392342975 `goals:create`
    // refuses a stub BEFORE reaching the INSERT, so a short one would return
    // `degraded`, leave `calls` without an INSERT, and blow up on the `!` below
    // as a TypeError. That reads like a broken mock rather than a rejected
    // input — the exact costume this failure wears (it red-pinned the gate via
    // goals/update.test.ts on 2026-08-10, EI-20048757608108893).
    // It was `'gut feel'` (8 chars), which asserted the pre-fix bug as correct.
    await call(ARGS({ killCriterion: 'no paying user by day 30' }), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).not.toContain('[]');
  });

  // ── EI-20049757392342975: the refusal itself ────────────────────────────
  describe('kill criterion — the shared rule, applied at THIS door too', () => {
    it('refuses a stub criterion instead of writing it, the way goals:propose and goals:update do', async () => {
      const res = await call(ARGS({ killCriterion: 'gut feel' }), CTX());
      expect(res.degraded).toBe(true);
      expect(res.degradedReasons?.[0]).toMatch(/states no abandonment condition/);
      // The REAL assertion: nothing was written. A refusal that still inserts
      // is the bug wearing a better error message.
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeUndefined();
    });

    it('refuses a placeholder opener even when it is long enough', async () => {
      const res = await call(ARGS({ killCriterion: 'TBD once we see some real numbers' }), CTX());
      expect(res.degraded).toBe(true);
      // Assert the REASON, not just the refusal: this string clears the length
      // bar, so a bare `degraded` here could be some unrelated rejection and the
      // test would pass without exercising PLACEHOLDER_OPENER at all.
      expect(res.degradedReasons?.[0]).toMatch(/states no abandonment condition/);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeUndefined();
    });

    // CONTROL for WI-37604 (owner-directed 2026-08-09): the overrule is about
    // PRESENCE, this rule is about quality GIVEN presence. Without this case a
    // guard that simply required a criterion would pass every test above while
    // silently re-imposing the requirement the owner removed.
    it('still allows NO criterion at all — WI-37604 is about presence, not quality', async () => {
      const res = await call(ARGS({ killCriterion: undefined }), CTX());
      expect(res.degraded).not.toBe(true);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeDefined();
    });

    it('still allows a blank criterion, for the same reason', async () => {
      const res = await call(ARGS({ killCriterion: '   ' }), CTX());
      expect(res.degraded).not.toBe(true);
      expect(calls.find((c) => /INSERT INTO/.test(c.sql))).toBeDefined();
    });
  });
});

describe('goals:create — stamping the caller\'s GOAL mode (the provenance mechanism)', () => {
  /**
   * P-016. Everything created after this reads `agent_modes.subject` from
   * session context to fill `goal_id`, which is why "what belongs to this
   * goal?" is answerable at all. The alternative — asking the agent to
   * remember to pass the id — does not survive a compaction.
   */
  it('points the caller\'s GOAL mode at the new goal', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS(), CTX());
    const id = (res.data as { id: string }).id;
    const upd = calls.find((c) => /UPDATE harness_shared\.agent_modes/.test(c.sql))!;
    expect(upd).toBeDefined();
    expect(upd.params).toContain(id);
    expect(upd.params).toContain('su-test');
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(true);
  });

  it('scopes the stamp to the caller AND the workspace, never a blanket update', async () => {
    callerInGoalMode = true;
    await call(ARGS(), CTX());
    const upd = calls.find((c) => /UPDATE harness_shared\.agent_modes/.test(c.sql))!;
    expect(upd.sql).toMatch(/workspace_id\s*=/);
    expect(upd.sql).toMatch(/owner_id\s*=/);
    expect(upd.sql).toMatch(/mode\s*=\s*'goal'/);
  });

  it('reports stamped:false — not an error — when the caller is not in GOAL mode', async () => {
    callerInGoalMode = false;
    const res = await call(ARGS(), CTX());
    expect(res.data).not.toBeNull();
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(false);
    expect((res.data as { mode_subject_advisory?: unknown }).mode_subject_advisory).toBeUndefined();
  });

  it.each([
    ['kill criterion', { killCriterion: 'no paying user after 2 weeks' }],
    ['zero budget', { budgetCents: 0 }],
    [
      'tripwire',
      {
        tripwires: [
          { metric: 'spend_usd', label: '$310 of $500', threshold: 500, current: 310, unit: 'usd' },
        ],
      },
    ],
  ])('returns a loud mode advisory when %s is supplied outside GOAL mode', async (_label, controls) => {
    const res = await call(ARGS(controls), CTX());
    const data = res.data as {
      id: string;
      mode_subject_stamped: boolean;
      mode_subject_advisory?: {
        code: string;
        severity: string;
        message: string;
        next: Array<{ tool: string; args?: Record<string, unknown> }>;
      };
    };

    expect(data.mode_subject_stamped).toBe(false);
    expect(data.mode_subject_advisory).toMatchObject({
      code: 'goal_mode_not_active',
      severity: 'warning',
    });
    expect(data.mode_subject_advisory?.message).toMatch(/not in GOAL mode/i);
    expect(data.mode_subject_advisory?.next.map((step) => step.tool)).toEqual(['goals:start', 'mode:set']);
    expect(data.mode_subject_advisory?.next[1]?.args).toMatchObject({
      mode: 'goal',
      subject: data.id,
    });
  });

  it('does not warn when the caller is already in GOAL mode', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS({ budgetCents: 0 }), CTX());
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(true);
    expect((res.data as { mode_subject_advisory?: unknown }).mode_subject_advisory).toBeUndefined();
  });

  it('does not attempt the stamp at all when the transport carried no session id', async () => {
    const res = await call(ARGS(), CTX({ uiClientId: null }));
    expect(res.data).not.toBeNull();
    expect(calls.some((c) => /agent_modes/.test(c.sql))).toBe(false);
  });

  it('still creates the goal when the stamp throws — a decoration must never fail the write', async () => {
    modeUpdateThrows = true;
    const res = await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    expect(res.data).not.toBeNull();
    expect((res.data as { mode_subject_stamped: boolean }).mode_subject_stamped).toBe(false);
    expect((res.data as { mode_subject_advisory?: { code: string } }).mode_subject_advisory?.code).toBe(
      'goal_mode_not_active',
    );
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
  });
});

describe('goals:create — arg contract', () => {
  it('defaults status to active', () => {
    expect(tool.args.parse({ title: 'x' }).status).toBe('active');
  });

  it('accepts every declared status and rejects an invented one', () => {
    for (const s of GOAL_STATUSES) {
      expect(tool.args.safeParse({ title: 'x', status: s }).success).toBe(true);
    }
    expect(tool.args.safeParse({ title: 'x', status: 'abandoned' }).success).toBe(false);
  });

  it('requires a title and rejects a negative or fractional budget', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ title: '' }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: 1.5 }).success).toBe(false);
  });
});

describe('goalId', () => {
  it('derives a readable slug from the title', () => {
    expect(goalId('Ship a paid app')).toMatch(/^ship-a-paid-app-[0-9a-f]{6}$/);
  });

  it('is collision-resistant for identical titles', () => {
    expect(goalId('same')).not.toBe(goalId('same'));
  });

  it('still produces a valid id when the title has no usable characters', () => {
    expect(goalId('!!! ???')).toMatch(/^goal-[0-9a-f]{6}$/);
  });

  it('bounds the stem so a long title cannot produce an unwieldy key', () => {
    const id = goalId('x'.repeat(300));
    expect(id.length).toBeLessThanOrEqual(48 + 1 + 6);
  });
});

describe('goals:create — the GOAL-mode kickoff consult (P-010)', () => {
  /**
   * The consult is GATED on the caller's active GOAL-mode row: the owner UI
   * confirm cards (GoalProposalCard, SubGoalsSection) call this tool as the
   * OWNER with no goal-mode row and must never be nudge-refused. For a
   * GOAL-mode agent it is a NUDGE, never a gate: one refusal with labeled
   * candidates, always overridable, and any infra fault proceeds.
   */
  const peer = (ownerId: string, liveness: string, score = 0.7) => ({
    ownerId,
    score,
    relevance: score,
    relativeAgeDays: 0,
    signals: { similarity: 0.6, verification: 0.2, authorship: 0, freshness: 1 },
    evidence: [{ session_id: `s-${ownerId}`, turn_idx: 1, ts: null, sim: 0.6 }],
    liveness,
  });
  const nudgeOutcome = (via: 'floor' | 'minimum' = 'minimum') => ({
    outcome: 'nudge',
    candidates: [peer('su-peer', 'live')],
    selection: { min: 1, max: 3, selected: [{ ownerId: 'su-peer', via, score: 0.7 }] },
  });

  it('nudge-refuses ONCE for a GOAL-mode caller — the goal is NOT created', async () => {
    callerInGoalMode = true;
    goalKickoffConsultMock.mockResolvedValue(nudgeOutcome());
    const res = await call(ARGS({ killCriterion: 'no paying user by day 30' }), CTX());
    const data = res.data as { error: string; candidates: unknown[]; hint: string };
    expect(data.error).toBe('consult_available');
    expect(data.candidates).toHaveLength(1);
    // The minimum-fill selectee gets the first-principles line in the hint.
    expect(data.hint).toMatch(/FIRST PRINCIPLES/);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toMatch(/NOT created/);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
    // The consult received the OUTLINE, requester-scoped.
    expect(goalKickoffConsultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'papercusp-workspace',
        requesterId: 'su-test',
        title: 'Ship a paid app',
        killCriterion: 'no paying user by day 30',
      }),
      expect.anything(),
    );
  });

  it('a floor-qualified selection omits the first-principles caveat', async () => {
    callerInGoalMode = true;
    goalKickoffConsultMock.mockResolvedValue(nudgeOutcome('floor'));
    const res = await call(ARGS(), CTX());
    expect((res.data as { hint: string }).hint).not.toMatch(/FIRST PRINCIPLES/);
  });

  it('attributes the active kickoff route and forwards its receipt to the shared ledger sink', async () => {
    callerInGoalMode = true;
    const params = { workspaceId: 'papercusp-workspace', requesterId: 'su-test', question: 'fixture question' };
    const receipt = { correlationId: 'fixture-kickoff' };
    goalKickoffConsultMock.mockImplementationOnce(async (_input, deps) => {
      await deps.route(params);
      return { outcome: 'proceed', verdict: 'no_qualified_responder' };
    });
    routeConsultMock.mockImplementationOnce(async (_params, deps) => { await deps.recordTelemetry(receipt); });
    await call(ARGS({ killCriterion: 'no paying user by day 30' }), CTX());
    expect(routeConsultMock).toHaveBeenCalledWith({
      ...params, telemetry: { caller: 'goals:create', policy: 'consult-default', buildSha: 'fixture-build' },
    }, expect.objectContaining({ recordTelemetry: expect.any(Function) }));
    expect(recordRoutingMock).toHaveBeenCalledWith(receipt, expect.anything());
  });

  it('NEVER consults a caller without a GOAL-mode row — the owner UI confirm-card path stays unrefused', async () => {
    callerInGoalMode = false;
    goalKickoffConsultMock.mockResolvedValue(nudgeOutcome());
    const res = await call(ARGS(), CTX());
    expect((res.data as { id?: string }).id).toBeTruthy();
    expect(goalKickoffConsultMock).not.toHaveBeenCalled();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
  });

  it('consulted: true acknowledges the refusal — no re-route, disposition recorded on the result', async () => {
    callerInGoalMode = true;
    const res = await call(
      ARGS({ consulted: true, consult_reason: 'consulted su-peer; outline confirmed' }),
      CTX(),
    );
    expect(goalKickoffConsultMock).not.toHaveBeenCalled();
    const data = res.data as { id: string; kickoff_consult?: Record<string, unknown> };
    expect(data.id).toBeTruthy();
    expect(data.kickoff_consult).toMatchObject({
      overridden: true,
      consulted: true,
      reason: 'consulted su-peer; outline confirmed',
    });
  });

  it('consulted: false + reason proceeds without consulting, reason recorded', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS({ consulted: false, consult_reason: 'time-critical kickoff' }), CTX());
    expect(goalKickoffConsultMock).not.toHaveBeenCalled();
    const data = res.data as { id: string; kickoff_consult?: Record<string, unknown> };
    expect(data.id).toBeTruthy();
    expect(data.kickoff_consult).toMatchObject({ overridden: true, consulted: false, reason: 'time-critical kickoff' });
  });

  it('arg contract: consulted:false without consult_reason is refused at parse; wire strings tolerated', () => {
    expect(tool.args.safeParse({ title: 'x', consulted: false }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', consulted: false, consult_reason: 'why' }).success).toBe(true);
    expect(tool.args.safeParse({ title: 'x', consulted: 'true' }).success).toBe(true);
    expect(tool.args.parse({ title: 'x', consulted: 'false', consult_reason: 'why' }).consulted).toBe(false);
  });

  it('a consult infra fault proceeds — nudge never blocks the create', async () => {
    callerInGoalMode = true;
    goalKickoffConsultMock.mockRejectedValue(new Error('router down'));
    const res = await call(ARGS(), CTX());
    expect((res.data as { id?: string }).id).toBeTruthy();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(true);
  });

  it('the gating probe fails OPEN: an agent_modes read fault skips the consult and creates', async () => {
    callerInGoalMode = true;
    modeSelectThrows = true;
    goalKickoffConsultMock.mockResolvedValue(nudgeOutcome());
    const res = await call(ARGS(), CTX());
    expect((res.data as { id?: string }).id).toBeTruthy();
    expect(goalKickoffConsultMock).not.toHaveBeenCalled();
  });

  it('routed_paused_context annotates the create with excerpts instead of refusing', async () => {
    callerInGoalMode = true;
    // The owner-pause gate is what emptied the selection — note the candidate is
    // LIVE. Since D-002 a dead session is dispatchable (fork/convert), so
    // deadness could not produce this branch; only a paused owner can.
    goalKickoffConsultMock.mockResolvedValue({
      outcome: 'proceed_with_excerpts',
      candidates: [peer('su-paused', 'live')],
      excerpts: [
        { ownerId: 'su-paused', session_id: 's-su-paused', turn_idx: 1, ts: null, sim: 0.6, excerpt: 'I tried this…' },
      ],
    });
    const res = await call(ARGS(), CTX());
    const data = res.data as {
      id: string;
      kickoff_consult?: { verdict: string; excerpts: unknown[]; candidates: Array<{ ownerId: string }> };
    };
    expect(data.id).toBeTruthy();
    expect(data.kickoff_consult?.verdict).toBe('routed_paused_context');
    expect(data.kickoff_consult?.excerpts).toHaveLength(1);
    expect(data.kickoff_consult?.candidates).toEqual([
      expect.objectContaining({ ownerId: 'su-paused', liveness: 'live' }),
    ]);
  });

  it('all_responders_paused is recorded honestly on the created goal', async () => {
    callerInGoalMode = true;
    goalKickoffConsultMock.mockResolvedValue({ outcome: 'proceed', verdict: 'all_responders_paused' });
    const res = await call(ARGS(), CTX());
    const data = res.data as { id: string; kickoff_consult?: { verdict: string } };
    expect(data.id).toBeTruthy();
    expect(data.kickoff_consult?.verdict).toBe('all_responders_paused');
  });

  it('the silent verdict (no_qualified_responder) stays silent — no kickoff_consult clutter', async () => {
    callerInGoalMode = true;
    const res = await call(ARGS(), CTX());
    expect((res.data as { kickoff_consult?: unknown }).kickoff_consult).toBeUndefined();
  });
});
