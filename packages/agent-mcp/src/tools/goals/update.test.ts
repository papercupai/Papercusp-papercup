/**
 * goals:update — closing the loop on a goal record
 * (goal-mode-2026-08-07 P-009).
 *
 * The failure this file exists to prevent is a PARTIAL update that silently
 * destroys state: reporting spend must not clear the kill criterion recorded at
 * creation, and an omitted field must not be written back as null. That is why
 * the handler resolves every column in JS against a prior read instead of
 * leaning on SQL COALESCE — COALESCE cannot express "detach this parent", and a
 * conditional SQL fragment to work around it is worse.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import tool from './update';
import { setGoalTransitionExecutor, type GoalStopReport } from './stop-seam';
import { PLATFORM_POT_SLUG } from '@papercusp/operator-core/lib/platform-pot-slug';
import { HARNESS_SLUG_RE, WILDCARD_SCOPE_TOKENS } from '@papercusp/operator-core/lib/harness-slug';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let existingRow: Record<string, unknown> | null = null;
let finalRow: Record<string, unknown> | null = null;
let blockedByRows: Array<{ blocked_ref: string; blocker_kind: string; blocker_ref: string }> = [];
let blockerGoalRows: Array<{ id: string; status: string }> = [];
let goalAuthorityRows: Array<Record<string, unknown>> = [];

function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/SELECT NULLIF\(current_setting\('app\.workspace_id'/.test(sql)) {
      return Promise.resolve([{ ws: 'papercusp-workspace' }]);
    }
    if (/SELECT blocked_ref, blocker_kind, blocker_ref/.test(sql)) {
      return Promise.resolve(blockedByRows);
    }
    if (/SELECT id, status FROM harness_shared\.goals/.test(sql)) {
      return Promise.resolve(blockerGoalRows);
    }
    if (/WITH mine AS MATERIALIZED/.test(sql) && /elected_owner_id/.test(sql)) {
      return Promise.resolve(goalAuthorityRows);
    }
    if (/SELECT id, workspace_id, title, body, status/.test(sql)) {
      return Promise.resolve(finalRow ? [finalRow] : existingRow ? [existingRow] : []);
    }
    if (/^\s*SELECT/.test(sql)) {
      return Promise.resolve(existingRow ? [existingRow] : []);
    }
    return Promise.resolve([]);
  };
}

const CTX = () => ({ tx: makeTx() as never, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' });
const updateCall = () => calls.find((c) => /UPDATE harness_shared\.goals/.test(c.sql))!;

/**
 * The metadata param as an OBJECT. Substring-matching the stringified params
 * cannot see it: the metadata is itself JSON, so inside a JSON.stringify of the
 * param list its quotes are escaped (`\"spentCents\":999`) and a plain
 * `toContain('"spentCents":999')` fails against a perfectly correct write.
 */
const writtenMetadata = (): Record<string, unknown> => {
  const jsonParam = updateCall().params.find(
    (p): p is string => typeof p === 'string' && p.trimStart().startsWith('{'),
  );
  return jsonParam ? JSON.parse(jsonParam) : {};
};

/**
 * The value bound to one SET column of the goals UPDATE.
 *
 * DERIVED from the recorded SQL rather than hardcoded, because a hardcoded index
 * is silently wrong the moment a column is added ahead of it — which is exactly
 * what happened: `install_slug` (EI-21563406996333542) was inserted between
 * `parent_id` and `kill_criterion`, so the previous `KILL_CRITERION_PARAM = 5`
 * began reading the install slug while still being named for the criterion. The
 * assertions kept their names and changed their meaning, which is the worst way
 * for a test to break.
 *
 * The mock `tx` joins the template strings with '?', one per bound param, so the
 * count of '?' before a column's placeholder IS that param's index.
 */
const setParam = (column: string): unknown => {
  const { sql, params } = updateCall();
  const m = new RegExp(`\\b${column}\\s*=\\s*`).exec(sql);
  if (!m) throw new Error(`goals UPDATE has no SET clause for ${column}`);
  return params[sql.slice(0, m.index + m[0].length).split('?').length - 1];
};

/** The kill criterion is a COLUMN now (migration 765), not a key inside metadata. */
const writtenCriterion = (): unknown => setParam('kill_criterion');

describe('existing-goal declaration extension contract', () => {
  it('requires an exact observed schema with each declaration patch', () => {
    expect(tool.args.safeParse({ id: 'g1', propertySchemaPatch: {} }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g1', expectedPropertySchema: {} }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g1', propertySchemaPatch: {}, expectedPropertySchema: {} }).success).toBe(true);
  });
});

beforeEach(() => {
  calls = [];
  existingRow = {
    workspace_id: 'papercusp-workspace',
    title: 'Ship a paid app',
    body: 'the original statement',
    status: 'active',
    parent_id: null,
    budget_cents: '50000',
    budget_window_sec: 604800,
    kill_criterion: 'no paying user after 2 weeks',
    tripwires: null,
    metadata: {},
    launch_settings: null,
    output_schema: null,
    outputs: null,
  };
  finalRow = null;
  blockedByRows = [];
  blockerGoalRows = [];
  goalAuthorityRows = [];
});

describe('goals:update — effective-holder mutation fence (WI-1139512)', () => {
  it('refuses an expired predecessor before any goal mutation', async () => {
    goalAuthorityRows = [{
      subject: 'goal-42',
      elected_owner_id: 'holder-new',
      elected_epoch: 9,
      predecessor_owner_id: 'holder-old',
      handoff_expires_at: '2020-01-01T00:00:00.000Z',
    }];

    const result = (await tool.handler(
      tool.args.parse({ id: 'g1', title: 'must not land' }) as never,
      {
        ...CTX(),
        isSuperuser: true,
        uiClientId: 'holder-old',
      } as never,
    )) as {
      data: unknown;
      degraded?: boolean;
      degradedReasons?: string[];
      goalHolderAuthority?: { code?: string; electedOwnerId?: string };
    };

    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons?.join(' ')).toContain('holder-new');
    expect(result.goalHolderAuthority).toMatchObject({
      code: 'goal_holder_superseded',
      electedOwnerId: 'holder-new',
    });
    expect(calls.some((call) => /UPDATE harness_shared\.goals/.test(call.sql))).toBe(false);
  });
});

/* ── the repair door for an unlaunchable install_slug (EI-21563406996333542)
   ─────────────────────────────────────────────────────────────────────────────
   A goal created from a workspace-global session was written with
   `install_slug = '*'`, which reads healthy everywhere and is refused by
   `adv/launch-su` at every holder spawn — so the goal could never start and
   there was no way to fix the row in place. This door is that way.

   The subtle failure mode is the SECOND one below: a repair door that admits a
   value the LAUNCH door refuses just moves the bug rather than fixing it. That
   is why the validation and the launch door share HARNESS_SLUG_RE instead of
   each carrying a copy — the assertion here is against the same constant
   `adv/launch-su` applies, so a drift between them fails HERE rather than at a
   holder launch weeks later. ── */
describe('goals:update — install_slug repair cannot write an unlaunchable value', () => {
  const writtenInstallSlug = (): unknown => setParam('install_slug');

  it('REFUSES the wildcard "*" — the exact value that produced the unlaunchable goal', () => {
    expect(tool.args.safeParse({ id: 'g1', installSlug: '*' }).success).toBe(false);
  });

  it('refuses every mis-SHAPED slug the launch door would reject', () => {
    for (const bad of ['*', 'a/b', 'a b', 'a:b', '', 'x'.repeat(121)]) {
      expect(tool.args.safeParse({ id: 'g1', installSlug: bad }).success).toBe(false);
      // Cross-check against the launch door's own predicate rather than a copy
      // of it: anything this schema accepts must be a slug launch-su accepts.
      expect(HARNESS_SLUG_RE.test(bad) && bad.length <= 120).toBe(false);
    }
  });

  /* The case a pattern check cannot catch, and the reason this door needs a
     refinement on top of the regex. `'all'` is a workspace-global SCOPE token,
     but it is also a perfectly well-shaped slug — so shape validation waves it
     through and the goal ends up filed against a Pot named `all` that does not
     exist. That failure is quieter than the original wildcard bug: `'*'` at
     least dies loudly at the launch door, whereas `'all'` is launchable-looking
     all the way down. */
  it('refuses "all" — shape-VALID, but a scope token rather than a Pot name', () => {
    // The premise: this is exactly the case the regex alone would have admitted.
    expect(HARNESS_SLUG_RE.test('all')).toBe(true);
    const res = tool.args.safeParse({ id: 'g1', installSlug: 'all' });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues ?? [])).toMatch(/scope/i);
  });

  it('agrees with goals:create on WHICH tokens are wildcards, so the doors cannot diverge', () => {
    for (const token of WILDCARD_SCOPE_TOKENS) {
      expect(tool.args.safeParse({ id: 'g1', installSlug: token }).success).toBe(false);
    }
  });

  it('accepts a concrete Pot slug and WRITES it', async () => {
    expect(tool.args.safeParse({ id: 'g1', installSlug: PLATFORM_POT_SLUG }).success).toBe(true);
    await tool.handler(
      tool.args.parse({ id: 'g1', installSlug: PLATFORM_POT_SLUG }) as never,
      CTX() as never,
    );
    expect(writtenInstallSlug()).toBe(PLATFORM_POT_SLUG);
  });

  it('preserves the existing install_slug when the arg is omitted', async () => {
    existingRow = { ...(existingRow as Record<string, unknown>), install_slug: 'some-other-pot' };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(writtenInstallSlug()).toBe('some-other-pot');
  });
});

describe('goals:update — partial writes preserve untouched state', () => {
  it('records an explicit contract edit on a packaged instance for later starts', async () => {
    existingRow!.metadata = {
      goalPackageRef: 'work-on-everything',
      packageVersion: '1.0.0',
      startedBy: 'su-old',
    };

    await tool.handler(
      tool.args.parse({ id: 'g1', body: 'owner directive: keep this across instances' }) as never,
      CTX() as never,
    );

    expect(writtenMetadata()).toMatchObject({
      goalPackageRef: 'work-on-everything',
      packageVersion: '1.0.0',
      startedBy: 'su-old',
      packageInstanceOverride: {
        body: 'owner directive: keep this across instances',
      },
    });
  });

  it('an unrelated edit does NOT clear the kill criterion', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(writtenCriterion()).toBe('no paying user after 2 weeks');
    expect(writtenMetadata()).toEqual({});
  });

  /*
   * spentCents is not an argument (WI-1074208): the platform spend rollup is
   * its only writer (D-003, D-011). The strict schema REJECTS a caller-supplied
   * figure rather than silently dropping it, so an agent trying to hand-write
   * spend is told so instead of believing it succeeded.
   */
  it('rejects a caller spentCents — the rollup is the only writer', async () => {
    existingRow!.metadata = { spentCents: 999, spentCentsSource: 'goal-lineage-rollup' };
    expect(() => tool.args.parse({ id: 'g1', spentCents: 1234, title: 'Ship a paid app, revised' })).toThrow(
      /spentCents/,
    );
    // The same edit without it goes through and leaves the rollup's figure alone.
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({ spentCents: 999, spentCentsSource: 'goal-lineage-rollup' });
    expect(calls.some((c) => /agent_usage_samples/.test(c.sql))).toBe(false);
  });

  /*
   * TRIPWIRE PROVENANCE (EI-22512669283419131) — the sibling of spentCents
   * provenance directly above, and the class that actually fired.
   *
   * On 2026-09-06 an agent attached a tripwire to a live STANDING goal for
   * VISIBILITY, hand-writing current:1165.2 — its own diagnostic estimate,
   * labelled "estimated, likely a floor". For a standing goal the tripwires ARE
   * the stopping condition, so the rollup read that number as a breach and
   * killed the goal, winding down a whole drain fleet. No measured breach had
   * occurred: the authoritative pot scope was 0 against a 10000c budget.
   *
   * The numbers below are that incident's, so this fails if the guard is ever
   * loosened back to accepting a caller-written `current`.
   */
  const spendTripwire = (current?: number) => [
    {
      metric: 'spend_usd',
      label: 'Spend $1,165 vs $100/7d ceiling (11.6x) — estimated, likely a floor',
      threshold: 100,
      ...(current === undefined ? {} : { current }),
      unit: 'usd',
    },
  ];

  it('refuses a hand-written `current` for a metric the rollup owns — the kill that fired', async () => {
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', tripwires: spendTripwire(1165.2) }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean; degradedReasons?: string[] };
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toContain('KILL TRIGGER');
    // The write must not reach the row: a stored breaching `current` is what
    // the rollup executes on, so refusing after the UPDATE would be no guard.
    expect(calls.some((c) => /UPDATE harness_shared\.goals/.test(c.sql))).toBe(false);
  });

  it('still ACCEPTS a rollup-owned `current` BELOW its threshold — the bars must keep moving', async () => {
    // The guard is deliberately not "provenance, always": advancing a bar by
    // hand ("$310 of $500") is designed, tested behaviour further down this
    // file, and a guard that revoked it would be a wider change than the defect
    // it fixes. Only the KILL TRIGGER is refused.
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', tripwires: spendTripwire(42) }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean };
    expect(res.degraded).not.toBe(true);
    expect(calls.some((c) => /UPDATE harness_shared\.goals/.test(c.sql))).toBe(true);
  });

  it('ACCEPTS a `current` for a metric the platform cannot resolve', async () => {
    // Most metrics live outside this database, and for those the caller is the
    // only source. Over-tightening the guard would break the designed use.
    const res = (await tool.handler(
      tool.args.parse({
        id: 'g1',
        tripwires: [
          { metric: 'species_covered', label: '7 of 20 species', threshold: 20, current: 7 },
        ],
      }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean };
    expect(res.degraded).not.toBe(true);
    expect(calls.some((c) => /UPDATE harness_shared\.goals/.test(c.sql))).toBe(true);
  });

  it('ACCEPTS a rollup-owned tripwire when `current` is omitted — the correct setup path', async () => {
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', tripwires: spendTripwire() }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean };
    expect(res.degraded).not.toBe(true);
    expect(calls.some((c) => /UPDATE harness_shared\.goals/.test(c.sql))).toBe(true);
  });

  it('advises on tripwires no resolver will measure, judged against the PERSISTED window (WI-10004424)', async () => {
    const tripwires = [
      { metric: 'spend_usd_week', label: 'weekly spend', threshold: 100 },
      { metric: 'spend_usd_7d', label: '7d spend', threshold: 100 },
      { metric: 'spend_usd_24h', label: 'daily spend', threshold: 20 },
    ];
    // The re-read row is what the advisory reads: a 7d budget window.
    finalRow = { id: 'g1', ...existingRow, tripwires, budget_window_sec: 604800 };
    const res = (await tool.handler(tool.args.parse({ id: 'g1', tripwires }) as never, CTX() as never)) as {
      data: { tripwire_advisories?: Array<{ metric: string; code: string; suggestedMetric: string | null }> };
      degraded?: boolean;
    };
    expect(res.degraded).not.toBe(true);
    expect(res.data.tripwire_advisories?.map((a) => [a.metric, a.code, a.suggestedMetric])).toEqual([
      ['spend_usd_week', 'platform-shaped-metric-unresolved', 'spend_usd_7d'],
      ['spend_usd_24h', 'spend-window-never-measured', null],
    ]);
  });

  it('does not re-advise on an update that touches neither tripwires nor the budget window', async () => {
    finalRow = {
      id: 'g1',
      ...existingRow,
      tripwires: [{ metric: 'spend_usd_week', label: 'weekly spend', threshold: 100 }],
    };
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never,
      CTX() as never,
    )) as { data: unknown };
    expect(res.data).not.toHaveProperty('tripwire_advisories');
  });

  it('revising the kill criterion does NOT clear previously reported spend', async () => {
    // ⚠ THE INCOMING CRITERION MUST BE ≥ KILL_CRITERION_MIN_CHARS (12) — do not
    // shorten these fixtures back to 'old'/'new'. The handler validates
    // `killCriterion` through the shared `killCriterionProblem` and returns
    // `degraded` BEFORE issuing the UPDATE, so a stub criterion makes
    // `updateCall()` undefined and this test dies on `.params of undefined` —
    // a failure that reads like a broken mock rather than a rejected input.
    // Only the INCOMING value is validated; `existingRow.kill_criterion` is a
    // prior DB value that is read back, never re-checked.
    existingRow!.kill_criterion = 'no paying user after 2 weeks';
    existingRow!.metadata = { spentCents: 999 };
    await tool.handler(
      tool.args.parse({ id: 'g1', killCriterion: 'no repeat purchase after 30 days' }) as never,
      CTX() as never,
    );
    expect(writtenCriterion()).toBe('no repeat purchase after 30 days');
    expect(writtenMetadata()).toEqual({ spentCents: 999 });
  });

  it('leaves unrelated metadata keys alone (merge, not replace)', async () => {
    existingRow!.metadata = { ownerNote: 'keep me' };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({ ownerNote: 'keep me' });
  });

  /**
   * Goals written before migration 765 carry the criterion at
   * `metadata.killCriterion`. Reading only the column would blank the single
   * most load-bearing string in goal mode on every legacy row — and blank it
   * SILENTLY, on the next unrelated update.
   */
  it('migrates a legacy metadata.killCriterion into the column, and drops the stale copy', async () => {
    existingRow!.kill_criterion = null;
    existingRow!.metadata = { killCriterion: 'legacy prose', spentCents: 12 };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(writtenCriterion()).toBe('legacy prose');
    // Exactly one source of truth afterwards — the stale key is gone.
    expect(writtenMetadata()).toEqual({ spentCents: 12 });
  });

  it('an explicit criterion beats the legacy metadata copy', async () => {
    existingRow!.kill_criterion = null;
    existingRow!.metadata = { killCriterion: 'legacy prose' };
    await tool.handler(
      tool.args.parse({ id: 'g1', killCriterion: 'the real one' }) as never,
      CTX() as never,
    );
    expect(writtenCriterion()).toBe('the real one');
  });
});

describe('goals:update — unrestricted amendments are always reversible from history (D-008/D-013)', () => {
  const amendmentInsert = () =>
    calls.find((call) => /INSERT INTO harness_shared\.audit_log/.test(call.sql));

  it('allows the goal executor to amend every row field and records before/after + author + reason', async () => {
    const nextTripwires = [
      { metric: 'spend_usd', label: '$120 of $750', threshold: 750, current: 120 },
    ];
    finalRow = {
      ...existingRow!,
      id: 'g1',
      title: 'Ship a profitable app',
      body: 'the revised outcome',
      status: 'achieved',
      parent_id: 'parent-goal',
      budget_cents: '75000',
      budget_window_sec: 86400,
      kill_criterion: 'no repeat purchase after 30 days',
      tripwires: nextTripwires,
      metadata: {
        spentCents: 1234,
        spentCentsSource: 'goal-lineage-rollup',
        drainFleet: 'goal-drain',
      },
      launch_settings: { maxAgents: 3 },
    };

    await tool.handler(
      tool.args.parse({
        id: 'g1',
        title: 'Ship a profitable app',
        body: 'the revised outcome',
        status: 'achieved',
        parentId: 'parent-goal',
        budgetCents: 75000,
        budgetWindowSec: 86400,
        killCriterion: 'no repeat purchase after 30 days',
        tripwires: nextTripwires,
        drainFleet: 'goal-drain',
        launchSettings: { maxAgents: 3 },
        reason: 'the latest measured cohort changed the goal',
      }) as never,
      { ...CTX(), uiClientId: 'su-goal-executor', role: 'su' } as never,
    );

    expect(calls.some((call) => /UPDATE harness_shared\.goals/.test(call.sql))).toBe(true);
    const audit = amendmentInsert();
    expect(audit).toBeDefined();
    expect(audit!.params[2]).toBe('su-goal-executor');
    expect(audit!.params[3]).toBe('goal:amendment');
    expect(audit!.params[4]).toBe('g1');
    expect(audit!.params[6]).toBe('papercusp-workspace');
    const detail = JSON.parse(audit!.params[5] as string) as {
      reason: string;
      reasonSource: string;
      changes: Array<{ field: string; before: unknown; after: unknown }>;
    };
    expect(detail.reason).toBe('the latest measured cohort changed the goal');
    expect(detail.reasonSource).toBe('caller');
    expect(detail.changes.map((change) => change.field)).toEqual([
      'title',
      'body',
      'status',
      'parentId',
      'budgetCents',
      'budgetWindowSec',
      'killCriterion',
      'tripwires',
      'metadata',
      'launchSettings',
    ]);
    expect(detail.changes.find((change) => change.field === 'budgetCents')).toEqual({
      field: 'budgetCents',
      before: 50000,
      after: 75000,
    });
    expect(detail.changes.find((change) => change.field === 'title')).toEqual({
      field: 'title',
      before: 'Ship a paid app',
      after: 'Ship a profitable app',
    });
    expect(detail.changes.find((change) => change.field === 'body')).toEqual({
      field: 'body',
      before: 'the original statement',
      after: 'the revised outcome',
    });
    expect(detail.changes.find((change) => change.field === 'killCriterion')).toEqual({
      field: 'killCriterion',
      before: 'no paying user after 2 weeks',
      after: 'no repeat purchase after 30 days',
    });
  });

  it('generates an explicit reason when a non-pause caller omitted one', async () => {
    finalRow = { ...existingRow!, id: 'g1', title: 'Renamed goal' };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Renamed goal' }) as never, CTX() as never);

    const detail = JSON.parse(amendmentInsert()!.params[5] as string) as {
      reason: string;
      reasonSource: string;
    };
    expect(detail.reasonSource).toBe('generated');
    expect(detail.reason).toContain('title');
  });

  it('does not manufacture an amendment row for a semantic no-op', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(amendmentInsert()).toBeUndefined();
  });

  it('records the dependency field as a set-level before/after change', async () => {
    blockedByRows = [{ blocked_ref: 'g1', blocker_kind: 'goal', blocker_ref: 'old-blocker' }];
    blockerGoalRows = [{ id: 'new-blocker', status: 'active' }];
    finalRow = { ...existingRow!, id: 'g1' };

    await tool.handler(
      tool.args.parse({ id: 'g1', blockedBy: ['new-blocker'], reason: 'dependency changed' }) as never,
      CTX() as never,
    );

    const detail = JSON.parse(amendmentInsert()!.params[5] as string) as {
      changes: Array<{ field: string; before: unknown; after: unknown }>;
    };
    expect(detail.changes).toContainEqual({
      field: 'blockedBy',
      before: ['old-blocker'],
      after: ['new-blocker'],
    });
  });
});

/**
 * The money ceiling is CLEARABLE (EI-20072247655456262).
 *
 * It was the only unset-able-looking field on this tool without `.nullable()`,
 * so there was no value a caller could send that returned a goal to "no
 * ceiling" — and the HUD's inline ceiling editor was shaped around that gap,
 * refusing a blank field in as many words. Both halves of the fix are pinned
 * here: the schema must ACCEPT null, and the handler must WRITE it. Accepting
 * it while the merge still read `args.budgetCents ?? prev` would be the worst
 * outcome available — a clear that validates, returns ok, and changes nothing.
 */
describe('goals:update — clearing the budget ceiling', () => {
  const writtenBudget = (): unknown => setParam('budget_cents');
  const writtenWindow = (): unknown => setParam('budget_window_sec');

  it('accepts a ceiling, an explicit null, and still refuses a negative one', () => {
    expect(tool.args.safeParse({ id: 'g1', budgetCents: 75000 }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'g1', budgetCents: null }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'g1', budgetCents: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g1', budgetCents: 1.5 }).success).toBe(false);
  });

  it('writes NULL for an explicit null — the removal actually lands', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', budgetCents: null }) as never, CTX() as never);
    expect(writtenBudget()).toBeNull();
  });

  it('preserves the existing ceiling when the field is omitted', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', title: 'Renamed goal' }) as never,
      CTX() as never,
    );
    // The fixture stores '50000' as a STRING (numeric column), so this also
    // pins that the merge still coerces rather than writing the raw text.
    expect(writtenBudget()).toBe(50000);
  });

  it('writes an explicit ZERO ceiling rather than falling through to the prior one', async () => {
    // The regression the `??` → `=== undefined` change must not introduce in
    // the other direction: 0 is a real declared ceiling, not an absence.
    await tool.handler(tool.args.parse({ id: 'g1', budgetCents: 0 }) as never, CTX() as never);
    expect(writtenBudget()).toBe(0);
  });

  it('clears the window along with the ceiling — no dangling window to re-attach', async () => {
    // The fixture has a 604800s window. Left behind, it is inert while there is
    // no ceiling and then silently scopes the NEXT ceiling somebody sets.
    await tool.handler(tool.args.parse({ id: 'g1', budgetCents: null }) as never, CTX() as never);
    expect(writtenWindow()).toBeNull();
  });

  it('lets an explicit window in the same call win over that clearing', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', budgetCents: null, budgetWindowSec: 86400 }) as never,
      CTX() as never,
    );
    expect(writtenBudget()).toBeNull();
    expect(writtenWindow()).toBe(86400);
  });

  it('leaves the window alone when the ceiling is REVISED rather than removed', async () => {
    // Paired control for the clearing test above: the window only follows the
    // ceiling out, never on an ordinary revision.
    await tool.handler(tool.args.parse({ id: 'g1', budgetCents: 75000 }) as never, CTX() as never);
    expect(writtenBudget()).toBe(75000);
    expect(writtenWindow()).toBe(604800);
  });
});

describe('goals:update — budget windows', () => {
  const writtenBudgetWindow = (): unknown => setParam('budget_window_sec');

  it('accepts positive integer windows and an explicit null lifetime reset', () => {
    expect(tool.args.safeParse({ id: 'g1', budgetWindowSec: 604800 }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'g1', budgetWindowSec: null }).success).toBe(true);
  });

  it('rejects zero, negative, and fractional windows', () => {
    expect(tool.args.safeParse({ id: 'g1', budgetWindowSec: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g1', budgetWindowSec: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g1', budgetWindowSec: 1.5 }).success).toBe(false);
  });

  it('writes a revised window', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', budgetWindowSec: 86400 }) as never,
      CTX() as never,
    );
    expect(writtenBudgetWindow()).toBe(86400);
  });

  it('clears the window only when null is explicit', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', budgetWindowSec: null }) as never,
      CTX() as never,
    );
    expect(writtenBudgetWindow()).toBeNull();
  });

  it('preserves the existing window when omitted', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Renamed goal' }) as never, CTX() as never);
    expect(writtenBudgetWindow()).toBe(604800);
  });
});

describe('goals:update — tripwires', () => {
  const TRIPWIRES = [{ metric: 'spend_usd', label: '$310 of $500', threshold: 500, current: 310 }];

  it('advances a tripwire\'s current value — this is how the bars move', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', tripwires: TRIPWIRES }) as never,
      CTX() as never,
    );
    expect(JSON.stringify(updateCall().params)).toContain('spend_usd');
  });

  it('leaves existing tripwires untouched when the arg is omitted', async () => {
    existingRow!.tripwires = TRIPWIRES;
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never);
    expect(JSON.stringify(updateCall().params)).toContain('spend_usd');
  });

  it('drops back to prose-only on an explicit null', async () => {
    existingRow!.tripwires = TRIPWIRES;
    await tool.handler(tool.args.parse({ id: 'g1', tripwires: null }) as never, CTX() as never);
    expect(JSON.stringify(updateCall().params)).not.toContain('spend_usd');
  });

  it('an omitted field is written back as its previous value, never as null', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', status: 'killed' }) as never, CTX() as never);
    const params = updateCall().params;
    expect(params).toContain('Ship a paid app'); // title preserved
    expect(params).toContain('the original statement'); // body preserved
    expect(params).toContain('killed'); // the one field that moved
  });

  it('preserves the declared ceiling as a NUMBER when untouched (bigint arrives as a string)', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', status: 'achieved' }) as never, CTX() as never);
    expect(updateCall().params).toContain(50000);
  });
});

describe('goals:update — parent re-parenting', () => {
  it('leaves the parent alone when parentId is omitted', async () => {
    existingRow!.parent_id = 'parent-abc';
    // `reason` is REQUIRED alongside status:'paused' (P-005/D-009) — without it
    // the handler refuses before the write and there is no UPDATE to inspect.
    await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused', reason: 'holding for the owner' }) as never,
      CTX() as never,
    );
    expect(updateCall().params).toContain('parent-abc');
  });

  it('DETACHES the parent on an explicit null — the case COALESCE cannot express', async () => {
    existingRow!.parent_id = 'parent-abc';
    await tool.handler(tool.args.parse({ id: 'g1', parentId: null }) as never, CTX() as never);
    expect(updateCall().params).not.toContain('parent-abc');
  });
});

describe('goals:update — closing a goal', () => {
  it('accepts the terminal statuses that stop the ratchet', async () => {
    for (const status of ['killed', 'achieved']) {
      expect(tool.args.safeParse({ id: 'g1', status }).success).toBe(true);
    }
  });

  it('rejects an invented status rather than writing it', () => {
    expect(tool.args.safeParse({ id: 'g1', status: 'sunsetted' }).success).toBe(false);
  });

  it('degrades rather than throwing when the goal does not exist', async () => {
    existingRow = null;
    // `handler` is typed as the ToolResult | ToolResponse union, which does not
    // narrow on a bare `.data`; the rest of this package's tests carry the
    // resulting TS2339s in its baseline, so narrow here rather than add to it.
    const res = (await tool.handler(tool.args.parse({ id: 'nope' }) as never, CTX() as never)) as {
      data: unknown;
      degraded?: boolean;
      degradedReasons?: string[];
    };
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toContain('nope');
    // and must not have attempted the write
    expect(calls.some((c) => /^\s*UPDATE\s/.test(c.sql))).toBe(false);
  });

  it('passes the goal write transaction to the terminal stop fan-out', async () => {
    const transaction = makeTx();
    let received: unknown;
    const report: GoalStopReport = {
      goalId: 'g1',
      status: 'killed',
      potsStopped: [],
      potsSkippedContributing: [],
      loopsStopped: [],
      unattributedActiveLoops: 0,
      modesCleared: [],
      modesLeftArmed: [],
      degraded: false,
    };
    setGoalTransitionExecutor(async (input) => {
      received = input;
      return report;
    });

    try {
      await tool.handler(
        tool.args.parse({ id: 'g1', status: 'killed' }) as never,
        {
          tx: transaction as never,
          workspaceId: 'papercusp-workspace',
          harnessSlug: 'papercusp',
          principal: { workspaceId: 'papercusp-workspace' },
        } as never,
      );
    } finally {
      setGoalTransitionExecutor(undefined);
    }

    expect(received).toMatchObject({
      goalId: 'g1',
      workspaceId: 'papercusp-workspace',
      status: 'killed',
      sql: transaction,
    });
  });

  it('requires an id', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ id: '' }).success).toBe(false);
  });
});

describe('goals:update — terminal output-schema gate (P-021)', () => {
  const declaredOutputs = {
    type: 'object',
    required: ['report'],
    properties: { report: { type: 'string' } },
  };

  it('refuses achieved when a declared required output is still null', async () => {
    existingRow = {
      ...existingRow,
      output_schema: declaredOutputs,
      outputs: null,
    };

    const result = (await tool.handler(
      tool.args.parse({ id: 'g1', status: 'achieved' }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean; degradedReasons?: string[] };

    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons?.join(' ')).toMatch(/report|unfilled/i);
    expect(calls.some((call) => /UPDATE harness_shared\.goals/.test(call.sql))).toBe(false);
  });

  it('keeps killed lenient when the same declared output is absent', async () => {
    existingRow = {
      ...existingRow,
      output_schema: declaredOutputs,
      outputs: null,
    };

    await tool.handler(tool.args.parse({ id: 'g1', status: 'killed' }) as never, CTX() as never);

    expect(calls.some((call) => /UPDATE harness_shared\.goals/.test(call.sql))).toBe(true);
  });

  it('accepts complete outputs on an achieved update and writes them with the status', async () => {
    existingRow = {
      ...existingRow,
      output_schema: declaredOutputs,
      outputs: null,
    };

    await tool.handler(
      tool.args.parse({ id: 'g1', status: 'achieved', outputs: { report: 'shipped' } }) as never,
      CTX() as never,
    );

    expect(setParam('outputs')).toBe(JSON.stringify({ report: 'shipped' }));
  });
});

/**
 * LAUNCH SETTINGS (goal-mode-hardening-2026-08-10 P-005 wiring P-004's store).
 *
 * These are D-005's two BINDING ceilings — the machine-enforced replacement for
 * the capacity preflight D-004 removed — so the failure that matters here is a
 * write that reports success without landing: an owner who lowers a ceiling and
 * is told it saved will not check again.
 */
describe('goals:update — per-goal launch settings', () => {
  /* Matches the UPDATE that SETS the column, not any statement mentioning it —
     the handler's read-back SELECT names `launch_settings` too, so a bare
     substring match reports a write on every call and the omitted-field test
     passes for the wrong reason. */
  const settingsWrite = () => calls.find((c) => /UPDATE[\s\S]*SET[\s\S]*launch_settings/.test(c.sql));

  it('does not touch the column when the field is omitted', () => {
    // The whole tool is partial-by-construction; a settings write on every
    // unrelated update would clear a ceiling by reporting spend.
    return tool
      .handler(tool.args.parse({ id: 'g1', title: 'Ship a paid app, revised' }) as never, CTX() as never)
      .then(() => {
        expect(settingsWrite()).toBeUndefined();
      });
  });

  it('writes the document when given one', async () => {
    await tool.handler(
      tool.args.parse({
        id: 'g1',
        launchSettings: { maxAgents: 3, defaults: { model: 'sonnet' } },
      }) as never,
      CTX() as never,
    );
    const w = settingsWrite();
    expect(w).toBeDefined();
    expect(JSON.parse(w!.params[0] as string)).toEqual({ maxAgents: 3, defaults: { model: 'sonnet' } });
  });

  it('clears the column on an explicit null', async () => {
    // Explicit null is how "back to unlimited" is expressed — distinct from
    // omitted, exactly as parentId and tripwires are.
    await tool.handler(
      tool.args.parse({ id: 'g1', launchSettings: null }) as never,
      CTX() as never,
    );
    expect(settingsWrite()!.params[0]).toBeNull();
  });

  it('refuses a ceiling of 0 at the door — it would forbid every launch', () => {
    expect(tool.args.safeParse({ id: 'g1', launchSettings: { maxAgents: 0 } }).success).toBe(false);
  });

  it('refuses an unknown key rather than accepting a typo that pins nothing', () => {
    // The store's schema is `.strict()` for this reason: a silently-accepted
    // `maxAgent` reads back as "the setting is there" while the launch ignores it.
    expect(
      tool.args.safeParse({ id: 'g1', launchSettings: { maxAgent: 3 } }).success,
    ).toBe(false);
  });

  it('refuses an agent outside the schema’s closed set', () => {
    expect(
      tool.args.safeParse({ id: 'g1', launchSettings: { defaults: { agent: 'gpt' } } }).success,
    ).toBe(false);
  });

  /**
   * WI-10002016 — the DROP GUARD.
   *
   * `launchSettings` REPLACES the document, so a partial patch deletes every
   * sibling key. On a live goal a `{ maxAgents }` patch silently disarmed
   * `holder.onLoss:'respawn'` (goal continuity) and `defaults.account:'auto'`
   * (inference-gateway routing); it was recoverable only because audit_log keeps
   * the full `before`.
   *
   * NOTE the shared fixture has `launch_settings: null`, which is exactly why
   * every test above passes without ever meeting this guard. These populate it on
   * purpose — without that the guard would be shipped untested, which is how the
   * original defect shipped.
   */
  const POPULATED = {
    holder: { requireLive: true, onLoss: 'respawn' },
    defaults: { model: 'sonnet' },
    maxAgents: 4,
    maxPerFleet: 2,
  };

  it('REFUSES a partial patch that would delete sibling keys, and names them', async () => {
    existingRow = { ...existingRow!, launch_settings: POPULATED };
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', launchSettings: { maxAgents: 6 } }) as never,
      CTX() as never,
    )) as { degraded?: boolean; degradedReasons?: string[] };
    // The destructive write must not have reached the column at all.
    expect(settingsWrite()).toBeUndefined();
    expect(res.degraded).toBe(true);
    const why = res.degradedReasons?.join(' ') ?? '';
    expect(why).toContain('launch settings NOT saved');
    // Exactly the three unsent keys — `maxAgents` was supplied, so it is not a drop.
    expect(why).toContain('would DELETE 3 ');
    for (const key of ['holder', 'defaults', 'maxPerFleet']) expect(why).toContain(key);
  });

  it('allows the same patch once the dropped keys are confirmed', async () => {
    existingRow = { ...existingRow!, launch_settings: POPULATED };
    await tool.handler(
      tool.args.parse({
        id: 'g1',
        launchSettings: { maxAgents: 6 },
        confirmDropLaunchSettingsKeys: ['holder', 'defaults', 'maxPerFleet'],
      }) as never,
      CTX() as never,
    );
    expect(JSON.parse(settingsWrite()!.params[0] as string)).toEqual({ maxAgents: 6 });
  });

  it('allows a full re-send, which drops nothing', async () => {
    existingRow = { ...existingRow!, launch_settings: POPULATED };
    await tool.handler(
      tool.args.parse({ id: 'g1', launchSettings: { ...POPULATED, maxAgents: 6 } }) as never,
      CTX() as never,
    );
    expect(JSON.parse(settingsWrite()!.params[0] as string)).toMatchObject({
      maxAgents: 6,
      maxPerFleet: 2,
      holder: { onLoss: 'respawn' },
    });
  });

  it('still clears the whole document on an explicit null — that intent is unambiguous', async () => {
    // The guard deliberately does NOT cover null: nobody types null while meaning
    // "patch one field", and null is the documented way to clear the document.
    existingRow = { ...existingRow!, launch_settings: POPULATED };
    await tool.handler(
      tool.args.parse({ id: 'g1', launchSettings: null }) as never,
      CTX() as never,
    );
    expect(settingsWrite()!.params[0]).toBeNull();
  });

  it('reports a failed settings write as degraded instead of returning a clean ok', async () => {
    // The handler gets a document the arg schema would have refused, which is
    // reachable when a caller invokes the handler directly. It must NOT come
    // back looking like a saved ceiling.
    const res = (await tool.handler(
      { id: 'g1', launchSettings: { maxAgents: -1 } } as never,
      CTX() as never,
    )) as { degraded?: boolean; degradedReasons?: string[] };
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toContain('launch settings NOT saved');
  });
});

/**
 * WI-37834 — the degraded REASON must name the cause that actually fired.
 *
 * `stop.degraded` became reachable two ways once a terminal goal started retiring
 * GOAL-mode rows: burn it could not attribute, and a mode row the OWNER-STICKY guard
 * refused to clear. A single hardcoded sentence would report whichever one it happens
 * to name — so a sticky-refusal degrade would have read "…but 0 active loop(s) are
 * STILL RUNNING": a confident statement about the wrong quantity, on the one surface
 * (GoalStatusControl's sticky warning toast) that exists to stop a steering surface
 * reporting a state that is not the state of the system (EI-19995648221353323).
 */
describe('goals:update — the degraded reason names the cause that fired', () => {
  const stopReport = (over: Partial<GoalStopReport>): GoalStopReport => ({
    goalId: 'g1',
    status: 'achieved',
    potsStopped: ['pot-a'],
    potsSkippedContributing: [],
    loopsStopped: [],
    unattributedActiveLoops: 0,
    modesCleared: [],
    modesLeftArmed: [],
    degraded: false,
    ...over,
  });

  /**
   * The fan-out ctx needs `principal.workspaceId`, which the shared CTX() does not
   * carry: `resolveGoalWorkspace` reads it (UnifiedToolContext has no top-level
   * workspaceId — EI-18884122799901600) and without it the handler degrades with
   * "no concrete workspace in scope" BEFORE reaching the executor at all. Left
   * unfixed these tests pass vacuously against any reason-building code whatsoever,
   * which is how they first failed.
   */
  const withExecutor = async (report: GoalStopReport) => {
    setGoalTransitionExecutor(async () => report);
    try {
      return (await tool.handler(
        tool.args.parse({ id: 'g1', status: 'achieved' }) as never,
        { ...CTX(), principal: { workspaceId: 'papercusp-workspace' } } as never,
      )) as { degraded?: boolean; degradedReasons?: string[] };
    } finally {
      setGoalTransitionExecutor(undefined);
    }
  };

  it('reports a REFUSED mode clear as the mode refusal, not as phantom running loops', async () => {
    const res = await withExecutor(
      stopReport({ modesLeftArmed: ['su-owner-directed'], degraded: true }),
    );

    const joined = res.degradedReasons?.join(' ') ?? '';
    expect(joined).toContain('GOAL mode retired');
    expect(joined).toContain('su-owner-directed');
    // The negative control, and the whole point: with zero unattributed loops the
    // loops sentence must not appear at all. Without it this test passes on a build
    // that reports "0 active loop(s) … STILL RUNNING" beside the real reason.
    expect(joined).not.toContain('STILL RUNNING');
  });

  it('still reports unattributed burn on its own', async () => {
    const res = await withExecutor(stopReport({ unattributedActiveLoops: 3, degraded: true }));

    const joined = res.degradedReasons?.join(' ') ?? '';
    expect(joined).toContain('3 active loop(s)');
    expect(joined).toContain('STILL RUNNING');
    expect(joined).not.toContain('GOAL mode retired');
  });

  it('reports BOTH causes when both fired', async () => {
    const res = await withExecutor(
      stopReport({ unattributedActiveLoops: 2, modesLeftArmed: ['su-a'], degraded: true }),
    );

    expect(res.degradedReasons).toHaveLength(2);
  });
});

/**
 * The deliberate-pause record (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
 *
 * `status='paused'` already had teeth — it gates placement and disarms attributed
 * loops — but carried no record of the DECISION, so a later reader could not tell an
 * owner's hold from a goal that quietly lost its holder. That is the distinction
 * P-004's derived deactivation has to make, and it is the same one
 * `isAdministrativelyPaused` makes one layer down by reading a PERSISTED marker
 * rather than inferring from the fact that nothing is running.
 */
describe('goals:update — the deliberate-pause record (P-005)', () => {
  const PRINCIPAL_CTX = () => ({
    tx: makeTx() as never,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    principal: { slug: 'su-abc' },
  });

  // The fan-out suite above installs a host executor; this one is about the
  // RECORD, not the fan-out, so start from the un-wired state either way.
  beforeEach(() => setGoalTransitionExecutor(undefined));

  it('REFUSES status:"paused" with no reason, and writes NOTHING', async () => {
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused' }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean; degradedReasons?: string[] };

    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toContain('requires `reason`');
    // The refusal must cost nothing — not even the pre-read.
    expect(calls.some((c) => /UPDATE harness_shared\.goals/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /SELECT workspace_id, title, body, status/.test(c.sql))).toBe(false);
  });

  it('a whitespace-only reason is NOT a reason', async () => {
    const res = (await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused', reason: '   ' }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean };
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it('stamps { reason, pausedBy, pausedAtMs } on pause', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused', reason: 'owner holding the spend' }) as never,
      PRINCIPAL_CTX() as never,
    );
    const pause = writtenMetadata().pause as Record<string, unknown>;
    expect(pause.reason).toBe('owner holding the spend');
    expect(pause.pausedBy).toBe('su-abc');
    expect(typeof pause.pausedAtMs).toBe('number');
  });

  it('an unattributable caller degrades to a marker rather than BLOCKING the pause', async () => {
    await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused', reason: 'hold' }) as never,
      CTX() as never, // no principal
    );
    expect((writtenMetadata().pause as Record<string, unknown>).pausedBy).toBe('unknown');
  });

  it('PRESERVES the rest of the metadata document — the data-loss case', async () => {
    existingRow!.metadata = { startedBy: 'su-zzz', drainFleet: 'fleet-a' };
    await tool.handler(
      tool.args.parse({ id: 'g1', status: 'paused', reason: 'hold' }) as never,
      PRINCIPAL_CTX() as never,
    );
    const meta = writtenMetadata();
    expect(meta.startedBy).toBe('su-zzz');
    expect(meta.drainFleet).toBe('fleet-a');
    expect(meta.pause).toBeTruthy();
  });

  it('RESUME archives the record to lastPause and clears the live one', async () => {
    existingRow!.status = 'paused';
    existingRow!.metadata = {
      pause: { reason: 'hold', pausedBy: 'su-abc', pausedAtMs: 1_755_000_000_000 },
    };
    await tool.handler(tool.args.parse({ id: 'g1', status: 'active' }) as never, CTX() as never);
    const meta = writtenMetadata();
    expect(meta.pause).toBeUndefined();
    expect(meta.lastPause).toMatchObject({ reason: 'hold', pausedBy: 'su-abc' });
    expect(typeof (meta.lastPause as Record<string, unknown>).resumedAtMs).toBe('number');
  });

  it('a TERMINAL status also ends the hold — a killed goal must not report a live pause', async () => {
    existingRow!.status = 'paused';
    existingRow!.metadata = {
      pause: { reason: 'hold', pausedBy: 'su-abc', pausedAtMs: 1_755_000_000_000 },
    };
    await tool.handler(tool.args.parse({ id: 'g1', status: 'killed' }) as never, CTX() as never);
    const meta = writtenMetadata();
    expect(meta.pause).toBeUndefined();
    expect(meta.lastPause).toBeTruthy();
  });

  it('an unrelated edit on a PAUSED goal leaves the record alone', async () => {
    // The gate is the explicit `status` ARGUMENT, never the resolved value — a
    // title edit passes no status, and clearing the record because next.status
    // happens to be 'paused' would delete it on every unrelated write.
    existingRow!.status = 'paused';
    const stored = { reason: 'hold', pausedBy: 'su-abc', pausedAtMs: 1_755_000_000_000 };
    existingRow!.metadata = { pause: stored };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Renamed' }) as never, CTX() as never);
    expect(writtenMetadata().pause).toEqual(stored);
  });

  it('does not stamp a pause record on any other status', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', status: 'achieved' }) as never, CTX() as never);
    expect(writtenMetadata().pause).toBeUndefined();
    expect(writtenMetadata().lastPause).toBeUndefined();
  });
});

/**
 * EI-24732367604234855 — a wind-down stamps `metadata.disposition*` on the goal
 * and flips it to killed/achieved; reactivating it with goals:update must drop
 * that stamp, or loop:end / session:end read the stale record as "this end is
 * already covered" and wave a later end through the disposition gate.
 */
describe('goals:update — reactivating a terminal goal clears the wind-down disposition', () => {
  const STAMP = {
    disposition: 'killed',
    dispositionBy: 'su-holder',
    dispositionAt: '2026-09-30T22:38:28.000Z',
    handoffTo: 'su-next',
  };

  it('drops disposition/dispositionBy/dispositionAt/handoffTo when a KILLED goal goes active', async () => {
    existingRow!.status = 'killed';
    existingRow!.metadata = { ...STAMP, spentCents: 999 };
    await tool.handler(tool.args.parse({ id: 'g1', status: 'active' }) as never, CTX() as never);
    // Every other key survives — only the wind-down stamp goes.
    expect(writtenMetadata()).toEqual({ spentCents: 999 });
  });

  it('does the same for an ACHIEVED goal', async () => {
    existingRow!.status = 'achieved';
    existingRow!.metadata = { ...STAMP, disposition: 'achieved' };
    await tool.handler(tool.args.parse({ id: 'g1', status: 'active' }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({});
  });

  it('CONTROL: a handoff stamp on an ACTIVE goal survives status:"active" (active → active)', async () => {
    existingRow!.status = 'active';
    existingRow!.metadata = { disposition: 'handoff', dispositionBy: 'su-holder', handoffTo: 'su-next' };
    await tool.handler(tool.args.parse({ id: 'g1', status: 'active' }) as never, CTX() as never);
    expect(writtenMetadata()).toMatchObject({ disposition: 'handoff', handoffTo: 'su-next' });
  });

  it('CONTROL: an unrelated edit on a killed goal keeps the record that explains why it ended', async () => {
    existingRow!.status = 'killed';
    existingRow!.metadata = { ...STAMP };
    await tool.handler(tool.args.parse({ id: 'g1', title: 'Renamed' }) as never, CTX() as never);
    expect(writtenMetadata()).toMatchObject({ disposition: 'killed', dispositionBy: 'su-holder' });
  });
});
