/**
 * hive-canary-action.test.ts — tests for deadline tracking and enforcement
 */
import { describe, it, expect } from 'vitest';
import {
  planCanaryTick,
  planCanarySlaCheck,
  isCanaryTerminal,
  canaryIdFor,
  isVoidedCanaryOwner,
} from './hive-canary-action';
import type { CanaryFeatureRow } from './hive-canary-action';

describe('canaryIdFor', () => {
  it('generates correct date-based canary IDs', () => {
    const june11_2026 = new Date('2026-06-11').getTime();
    expect(canaryIdFor(june11_2026)).toBe('F-CANARY-20260611');

    const june12_2026 = new Date('2026-06-12').getTime();
    expect(canaryIdFor(june12_2026)).toBe('F-CANARY-20260612');
  });
});

describe('planCanaryTick', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();

  it('returns empty overdue list when no canaries exist', () => {
    const rows: CanaryFeatureRow[] = [];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
    expect(plan.queueId).toBe('F-CANARY-20260612');
  });

  it('excludes canaries with null payload', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago
        payload: null,
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('excludes canaries with canary_reported flag set', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago
        payload: { canary: true, canary_reported: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('excludes terminal canaries', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'passed',
        created_ts: now - 7 * 3600 * 1000,
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260610',
        status: 'failed',
        created_ts: now - 24 * 3600 * 1000,
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260609',
        status: 'deprecated',
        created_ts: now - 48 * 3600 * 1000,
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('identifies overdue canaries that are non-terminal and unreported', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago (overdue by 1h)
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260610',
        status: 'todo',
        created_ts: now - 25 * 3600 * 1000, // 25 hours ago (overdue by 19h)
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual(['F-CANARY-20260611', 'F-CANARY-20260610']);
  });

  it('respects deadline hours parameter', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 5 * 3600 * 1000, // 5 hours ago
        payload: { canary: true },
      },
    ];
    // With 6-hour deadline, should be overdue
    let plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]); // Not yet overdue

    // With 4-hour deadline, should be overdue
    plan = planCanaryTick(rows, { deadlineHours: 4, nowMs: now });
    expect(plan.overdue).toEqual(['F-CANARY-20260611']);
  });

  it('generates correct queue ID for today', () => {
    const rows: CanaryFeatureRow[] = [];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.queueId).toBe('F-CANARY-20260612');
  });

  it('EI-7420: suppresses overdue reports (never overdue) when isPaused — the Hive is owner-paused, not broken', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 25 * 3600 * 1000, // 25 hours ago (overdue by 19h)
        payload: { canary: true },
      },
    ];
    const paused = planCanaryTick(rows, { deadlineHours: 6, nowMs: now, isPaused: true });
    expect(paused.overdue).toEqual([]);
    expect(paused.suppressed).toEqual(['F-CANARY-20260611']);

    // Same rows, unpaused, still reports as genuinely overdue.
    const unpaused = planCanaryTick(rows, { deadlineHours: 6, nowMs: now, isPaused: false });
    expect(unpaused.overdue).toEqual(['F-CANARY-20260611']);
    expect(unpaused.suppressed).toEqual([]);
  });

  it('caps overdue list at input array size', () => {
    const rows: CanaryFeatureRow[] = Array.from({ length: 10 }, (_, i) => ({
      feature_id: `F-CANARY-${String(20260601 + i).padStart(8, '0')}`,
      status: 'todo',
      created_ts: now - (8 + i) * 3600 * 1000,
      payload: { canary: true },
    }));
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue.length).toBeLessThanOrEqual(rows.length);
  });
});

describe('isCanaryTerminal (EI-18170: post-status-unify terminal set)', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();
  it('treats the unified work-item terminal states (done/dropped) as terminal', () => {
    // The pre-fix bug: a cup now COMPLETES a canary to `done`, but `done`/`dropped`
    // were absent from the terminal set, so a SUCCEEDED canary read as non-terminal
    // and the daily 6h check would falsely re-report + deprecate every completed
    // canary older than the deadline.
    expect(isCanaryTerminal('done')).toBe(true);
    expect(isCanaryTerminal('dropped')).toBe(true);
  });

  it('still treats the legacy feature terminal spellings as terminal', () => {
    for (const s of ['passed', 'failed', 'deprecated', 'resolved', 'closed']) {
      expect(isCanaryTerminal(s)).toBe(true);
    }
  });

  it('treats in-flight states as non-terminal', () => {
    for (const s of ['open', 'todo', 'wip', 'blocked']) {
      expect(isCanaryTerminal(s)).toBe(false);
    }
  });

  it('a done canary is NOT overdue for the daily check (regression guard for the false-deprecate bug)', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'done', // completed by a cup, well past any deadline
        created_ts: now - 25 * 3600 * 1000,
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });
});

describe('planCanarySlaCheck (EI-18170: fast completion-SLA sweep)', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();

  it('returns empty when no canaries exist', () => {
    const plan = planCanarySlaCheck([], { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
    expect(plan.suppressed).toEqual([]);
  });

  it('flags a canary older than the SLA that is still non-terminal', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 45 * 60 * 1000, // 45 min ago — past a 30-min SLA
        payload: { canary: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual(['F-CANARY-20260612']);
  });

  it('does NOT flag a canary still inside its SLA window', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 20 * 60 * 1000, // 20 min ago — inside a 30-min SLA
        payload: { canary: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('excludes terminal canaries — including the unified `done` (a completed canary never alarms)', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-DONE', status: 'done', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
      { feature_id: 'F-DEP', status: 'deprecated', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('excludes canaries already SLA-reported (idempotent — one alarm per canary)', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 90 * 60 * 1000,
        payload: { canary: true, canary_sla_reported: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('is INDEPENDENT of the daily canary_reported stamp — still alarms when only canary_reported is set', () => {
    // Proves the two detectors dedup on separate stamps: a canary the daily check
    // already flagged (canary_reported) but that is somehow still open + un-SLA-
    // reported must still fire the fast alarm.
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 90 * 60 * 1000,
        payload: { canary: true, canary_reported: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual(['F-CANARY-20260612']);
  });

  it('excludes canaries with null payload', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-CANARY-20260612', status: 'open', created_ts: now - 90 * 60 * 1000, payload: null },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('defaults to a 30-minute SLA when slaMinutes is omitted', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-IN', status: 'open', created_ts: now - 25 * 60 * 1000, payload: { canary: true } },
      { feature_id: 'F-OUT', status: 'open', created_ts: now - 35 * 60 * 1000, payload: { canary: true } },
    ];
    const plan = planCanarySlaCheck(rows, { nowMs: now });
    expect(plan.breaching).toEqual(['F-OUT']);
  });

  it('EI-7420: suppresses SLA breaches (never breaching) when isPaused — an owner pause is not a broken loop', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-CANARY-20260612', status: 'open', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
    ];
    const paused = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now, isPaused: true });
    expect(paused.breaching).toEqual([]);
    expect(paused.suppressed).toEqual(['F-CANARY-20260612']);

    const unpaused = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now, isPaused: false });
    expect(unpaused.breaching).toEqual(['F-CANARY-20260612']);
    expect(unpaused.suppressed).toEqual([]);
  });
});

/**
 * EI-19298246923137692 — the canary detectors' READ slug must agree with the slug
 * their rows actually REST at.
 *
 * `hive-canary` is a WORKSPACE_GLOBAL_LABEL, so Pot-membership enforcement re-homes
 * every canary row to the platform Pot. For ~12 days both detectors filtered on the
 * literal `installSlug` and therefore matched ZERO rows — silently, with no error:
 * 6 canaries (F-CANARY-20260722..27) sat open, never stamped, while the 15-min SLA
 * sweep reported nothing on every tick. A detector that cannot see its subject is
 * indistinguishable from a healthy system, which is what made this expensive.
 */
describe('canary storage-slug agreement (EI-19298246923137692)', () => {
  it('re-homes a workspace-global install slug to the platform Pot', async () => {
    const { resolveWorkItemPot, PLATFORM_POT_SLUG } = await import('../../pot-membership');
    const lookup = {
      resolveRealPot: async (s: string) => (s === PLATFORM_POT_SLUG ? PLATFORM_POT_SLUG : null),
      platformPot: async () => PLATFORM_POT_SLUG,
    };
    // The canary's own install slug is the regression case.
    expect(
      await resolveWorkItemPot({ rawSlug: 'hive-canary', workspaceId: 'ws', lookup }),
    ).toBe(PLATFORM_POT_SLUG);
    expect(
      await resolveWorkItemPot({ rawSlug: 'hive-canary', workspaceId: 'ws', lookup }),
    ).not.toBe('hive-canary');
  });

  it('never filters canary rows by the raw installSlug', async () => {
    // Structural guard: re-introducing `harness_slug = ${installSlug}` restores the
    // exact blindness above, and no unit test of the pure planners can catch it —
    // the bug lived entirely in the SQL row addressing.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./hive-canary-action.ts', import.meta.url), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((l) => /harness_slug\s*=\s*\$\{installSlug\}/.test(l.line));
    expect(
      offenders,
      'canary DB row addressing must use the resolved storageSlug, not installSlug',
    ).toEqual([]);
  });
});

/**
 * Recurrence guard for EI-19441925633833456: the canary verdict must not be
 * satisfiable by the population it does not measure.
 *
 * The canary asks ONE question — does the autonomous hive loop carry queued work
 * end-to-end? Before this guard, `planCanaryTick` decided that from `status` alone
 * and dropped every terminal row, so an su that self-selected the canary via
 * `scheduler:get_next` and marked it `done` produced a row byte-identical to one a
 * cup had carried. The detector's silence then read as a healthy pass.
 *
 * Measured precedent: F-CANARY-20260802 (terminal_owner su-e6ac4eb7…, created
 * 01:16:19Z, done 01:17) recorded completion evidence claiming "Every hop of the
 * canary loop exercised" while the Hive was owner-paused and no cup could run.
 */
describe('planCanaryTick — VOID measurement (agent-completed canaries)', () => {
  const now = new Date('2026-08-03T15:00:00Z').getTime();
  const CUP = 's-1784466222583-818cdfaa'; // a real cup session id shape
  const SU = 'su-e6ac4eb7-9966-4e03-8122-5d761aff294d'; // a real su agent id shape

  const row = (over: Partial<CanaryFeatureRow> = {}): CanaryFeatureRow => ({
    feature_id: 'F-CANARY-20260802',
    status: 'done',
    created_ts: now - 24 * 3600 * 1000,
    terminal_owner: CUP,
    payload: { canary: true },
    ...over,
  });

  it('THE GUARD: an su-completed canary is VOID, not a healthy pass', () => {
    const plan = planCanaryTick([row({ terminal_owner: SU })], { nowMs: now });
    expect(plan.voided).toEqual(['F-CANARY-20260802']);
    // ...and it must NOT be laundered into the overdue path either: it is not a
    // missed deadline, it is a measurement that never happened.
    expect(plan.overdue).toEqual([]);
  });

  it('a cup-carried canary is a genuine pass — never voided', () => {
    const plan = planCanaryTick([row({ terminal_owner: CUP })], { nowMs: now });
    expect(plan.voided).toEqual([]);
  });

  it('an agent DROPPING a stale canary is honest cleanup, not a false green', () => {
    // Only PASS-like terminals can constitute a false green. The 6 canaries
    // bulk-dropped by an su on 2026-08-02 during an owner pause were legitimate
    // backlog cleanup and must not be reported as voided measurements.
    for (const status of ['dropped', 'deprecated', 'failed']) {
      const plan = planCanaryTick([row({ status, terminal_owner: SU })], { nowMs: now });
      expect(plan.voided, `${status} by an agent must not be voided`).toEqual([]);
    }
  });

  it("the routine's own deprecation stamp is not an agent completion", () => {
    const plan = planCanaryTick(
      [row({ status: 'deprecated', terminal_owner: 'system:hive-canary' })],
      { nowMs: now },
    );
    expect(plan.voided).toEqual([]);
  });

  it('an owner pause does NOT suppress a void (it explains STUCK, not FAKED)', () => {
    // A pause is why a canary sits untouched. It is not a reason for one to be
    // marked done — if anything a pause makes a pass-like completion more suspect,
    // since no cup could have produced it.
    const plan = planCanaryTick([row({ terminal_owner: SU })], { nowMs: now, isPaused: true });
    expect(plan.voided).toEqual(['F-CANARY-20260802']);
    expect(plan.overdue).toEqual([]);
  });

  it('reports each void once — an already-stamped row is not re-filed', () => {
    const plan = planCanaryTick(
      [row({ terminal_owner: SU, payload: { canary: true, canary_void_reported: true } })],
      { nowMs: now },
    );
    expect(plan.voided).toEqual([]);
  });

  it('fails CLOSED on an unrecognised owner rather than manufacturing a red', () => {
    // This predicate gates a bug report. Rows predating terminal_owner, or any
    // shape we do not recognise, must stay silent instead of retro-firing.
    expect(isVoidedCanaryOwner(null)).toBe(false);
    expect(isVoidedCanaryOwner(undefined)).toBe(false);
    expect(isVoidedCanaryOwner('')).toBe(false);
    expect(planCanaryTick([row({ terminal_owner: null })], { nowMs: now }).voided).toEqual([]);
  });

  it('classifies cup vs agent ownership by the cup shape, not an agent blacklist', () => {
    // Positive-matching the cup shape means any FUTURE agent-id prefix is treated
    // as an agent (fail loud on the measurement) rather than silently as a cup.
    expect(isVoidedCanaryOwner(CUP)).toBe(false);
    expect(isVoidedCanaryOwner('s-1783883513875-4d713256')).toBe(false);
    expect(isVoidedCanaryOwner(SU)).toBe(true);
    expect(isVoidedCanaryOwner('human:avi')).toBe(true);
    expect(isVoidedCanaryOwner('some-future-agent-kind-7f3a')).toBe(true);
  });
});

/**
 * Structural guard for the ASYMMETRIC canary claim floor (EI-19441925633833456).
 *
 * The requirement has two halves and BOTH must hold: a canary must be invisible to
 * agent self-select, and fully visible to Mug->cup placement. Getting the second one
 * wrong is the expensive direction and is not hypothetical — the original fix
 * proposed expressing this via `payload._claimHold`, which is honored by BOTH
 * `claimFloorsWhereSql` (self-select) AND `fetchFrontierRows` (the Mug's placement
 * frontier, pot/survey.ts, "structurally NOT cup-placeable"). That would have made
 * the canary permanently unplaceable, so the detector would report "the autonomous
 * hive loop is not carrying queued work end-to-end" every single day — breaking the
 * instrument in exactly the way it exists to detect, with no test to catch it.
 *
 * These assertions are cheap and source-level on purpose: the property lives in SQL
 * fragments, so no unit test of the pure planners can see it.
 */
describe('canary claim floor is asymmetric (agents NO, cups YES)', () => {
  it('claimFloorsWhereSql excludes canary rows from agent self-select', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../work-items.ts', import.meta.url), 'utf8');
    const fnBody = (name: string): string => {
      const start = src.indexOf(`export function ${name}`);
      expect(start, `${name} not found — did it move or get renamed?`).toBeGreaterThan(-1);
      // Scope to the function body so a canary mention elsewhere in this very large
      // file cannot satisfy the assertion by accident.
      const nextExport = src.indexOf('\nexport ', start + 1);
      return src.slice(start, nextExport === -1 ? undefined : nextExport);
    };
    // claimFloorsWhereSql ANDs every named predicate of the shared floor registry;
    // the canary floor lives in that registry (so diagnostics see it too).
    expect(fnBody('claimFloorsWhereSql')).toMatch(/featureClaimFloorPredicatesSql\(sql, opts\)/);
    const body = fnBody('featureClaimFloorPredicatesSql');
    expect(
      /->>\s*'canary'\s+IS DISTINCT FROM\s+'true'/.test(body),
      'claimFloorsWhereSql must exclude payload.canary=true so scheduler:get_next / claim_next ' +
        'cannot hand an agent the hive canary (it is a measurement instrument, not work).',
    ).toBe(true);
  });

  it('the Mug placement frontier does NOT exclude canaries — they must stay cup-placeable', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../pot/survey.ts', import.meta.url), 'utf8');
    expect(
      /->>\s*'canary'/.test(src),
      'pot/survey.ts must NOT filter on payload.canary: the Mug has to keep placing canaries ' +
        'onto cups. Excluding them here (or reusing _claimHold, which this file DOES honor) ' +
        'silently disables the canary and turns the daily detector into a permanent false red.',
    ).toBe(false);
  });
});
