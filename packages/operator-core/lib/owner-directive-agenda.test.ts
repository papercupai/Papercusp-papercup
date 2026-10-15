/**
 * owner-directive-agenda.test.ts — acceptance proof for P-008 of plan
 * `directive-visibility-and-ownership-2026-09-22`, as re-scoped by D-008.
 *
 * D-008 splits ONE directive into TWO different questions, which the pre-1195
 * schema conflated into the single global `owner_directives.capture_status`
 * column:
 *
 *   AGENDA  — "is this still on MY banner?"  Per (directive, session).
 *             Clearing a FOREIGN directive off your own banner is CORRECT and
 *             must never be ownership-guarded: guarding it is what would strand
 *             every foreign row in every agent's Orientation forever.
 *   ACTION  — "is this really an owner order / is it not a directive at all?"
 *             Global. Asserting it about someone else's directive erases a live
 *             peer's order (D-009, measured on directive #96), so only the
 *             addressed session, or a holder of a work-item that LINKS the
 *             directive, may do it.
 *
 * So the two rails are tested as OPPOSITES, because that is how they fail:
 * every ACTION case proves a refusal, and the agenda cases prove the absence of
 * any such check. A test file that only proved "foreign is refused" would pass
 * against an implementation that also refused the agenda clear — which is the
 * regression D-008 exists to prevent.
 *
 * WHY INJECTED SQL RATHER THAN A LIVE DB. Every function here takes an optional
 * `sql`. The fake records the statement text and the bound values, which is what
 * lets the terminal-status case below be tested at all: the terminal filter is
 * evaluated inside Postgres, so the only thing observable from outside is WHICH
 * set was bound and in which direction it was applied. `@papercusp/db-org` is
 * mocked to THROW, so any function that quietly fell back to the ambient pool
 * fails loudly instead of silently reaching the real database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
import type { DirectiveRoutingDeps } from './owner-directive-routing';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    throw new Error('ambient pool reached — this call should have used the injected sql');
  },
}));

const {
  clearDirectiveFromAgenda,
  directiveActionVerdict,
  listClearedDirectiveIds,
  restoreDirectiveToAgenda,
} = await import('./owner-directive-agenda');
const { TERMINAL_WORK_ITEM_STATES } = await import('./work-items');
const { countOpenOwnerDirectives, listOwnerDirectives } = await import('./owner-directives');
const { checkOpenDirectivesGuard } = await import('./agent-tools/orders/open-directives-guard');

interface RecordedCall {
  text: string;
  values: unknown[];
  /** What the fake handed back — how a nested FRAGMENT is located in its outer query's values. */
  returned: unknown;
}

/**
 * A tagged-template stand-in for `postgres`'s `sql`. `respond` sees the joined
 * statement text and returns the rows that statement should yield; anything it
 * does not recognize yields no rows, so an UNEXPECTED query reads as "found
 * nothing" at the call site and the recorded `calls` say exactly which ran.
 */
function fakeSql(respond: (text: string) => unknown[] = () => []) {
  const calls: RecordedCall[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    const returned = Promise.resolve(respond(text));
    calls.push({ text, values, returned });
    return returned;
  };
  return Object.assign(fn as unknown as Sql, { calls }) as Sql & { calls: RecordedCall[] };
}

const WS = 'papercusp-workspace';
const ME = 'su-mine';
const THEM = 'su-theirs';

function rawDirective(id: number, recordedBy: string) {
  return {
    id,
    workspace_id: WS,
    owner_id: 'owner',
    session_ref: null,
    source_turn_ref: null,
    verbatim_text: `directive ${id}`,
    recorded_by: recordedBy,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    dispositioned_at: null,
    disposition_status: null,
    disposition_note: null,
    dispositioned_by: null,
    summary_text: null,
    summary_by: null,
    summary_at: null,
    captured_by_hook: true,
    other_session_copies: 0,
  };
}

/**
 * Rows for a directive recorded by `recordedBy`; work_items rows from `holders`.
 *
 * The holder rows MUST be keyed `taken_by` — the real column on
 * harness_shared.work_items. Keying them `assignee` is what made the outage
 * below invisible to this suite: the fixture agreed with the bug, so the
 * oracle was not independent of the implementation and every assertion passed
 * while the real query raised 42703. The control at the bottom of this file
 * pins the spelling so the two cannot drift apart again.
 */
function directiveWorld(recordedBy: string | null, holders: Array<string | null> = []) {
  return (text: string) => {
    if (text.includes('harness_shared.owner_directives')) {
      return recordedBy == null ? [] : [{ recorded_by: recordedBy }];
    }
    if (text.includes('harness_shared.work_items')) {
      return holders.map((takenBy) => ({ taken_by: takenBy }));
    }
    return [];
  };
}

/**
 * Routing facts for the ended-addressee branch (plan
 * owner-directive-delivery-redesign-2026-09-22 P-008). The liveness oracle has
 * no `sql` seam, so every foreign-directive case injects these instead; an
 * owner id absent from `states` is UNKNOWN (null), which never reroutes.
 */
function routingWorld(opts: {
  states?: Record<string, SessionState>;
  fleets?: Record<string, string>;
  leaders?: Record<string, string | null>;
} = {}): DirectiveRoutingDeps {
  return {
    async sessionStates(ids) {
      return new Map(ids.map((id) => [id, opts.states?.[id] ?? null]));
    },
    async lastFleets(_ws, ids) {
      return new Map(ids.flatMap((id) => (opts.fleets?.[id] ? [[id, opts.fleets[id]] as const] : [])));
    },
    async fleetLeaders(_ws, slugs) {
      return new Map(slugs.map((s) => [s, opts.leaders?.[s] ?? null]));
    },
    async directiveHolders() {
      return new Map();
    },
    async fleetsLedBy() {
      return [];
    },
  };
}

/** The addressee is alive: routing leaves every foreign directive where it is. */
const THEM_LIVE = routingWorld({ states: { [THEM]: 'live' } });

describe('directiveActionVerdict — who may ACT on an owner directive (P-008 / D-008)', () => {
  it('reports notFound for a directive id that does not exist in this workspace', async () => {
    const sql = fakeSql(directiveWorld(null));

    const verdict = await directiveActionVerdict({ directiveId: 404, ownerId: ME, workspaceId: WS }, sql);

    expect(verdict).toEqual({ allowed: false, notFound: true });
    // A missing directive must not be reported as "foreign": the caller's repair
    // is different (a wrong id, versus a correct id in someone else's lane).
    expect(verdict).not.toHaveProperty('addressedTo');
  });

  it('the ADDRESSEE is allowed, and short-circuits before any work-item lookup', async () => {
    const sql = fakeSql(directiveWorld(ME));

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql);

    expect(verdict).toEqual({ allowed: true, because: 'addressee' });
    // The short-circuit is the assertion, not an optimization note: a version
    // that consulted work_items for its own directives would report
    // 'holds-linking-work-item' for an addressee that happens to hold one, and
    // the two `because` values are how a refusal message picks its wording.
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]!.text).toContain('harness_shared.owner_directives');
  });

  it('a FOREIGN directive with no linking work-item is refused, naming its addressee', async () => {
    const sql = fakeSql(directiveWorld(THEM));

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, THEM_LIVE);

    expect(verdict).toEqual({ allowed: false, addressedTo: THEM, holders: [] });
  });

  it('a holder of a NON-TERMINAL linking work-item passes through', async () => {
    const sql = fakeSql(directiveWorld(THEM, [ME]));

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql);

    expect(verdict).toEqual({ allowed: true, because: 'holds-linking-work-item' });
  });

  it('refusing names the OTHER holders, de-duplicated, so the caller can route to them', async () => {
    const sql = fakeSql(directiveWorld(THEM, ['su-peer-a', 'su-peer-a', 'su-peer-b']));

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, THEM_LIVE);

    expect(verdict).toEqual({ allowed: false, addressedTo: THEM, holders: ['su-peer-a', 'su-peer-b'] });
  });

  it('an ENDED addressee\'s live fleet leader inherits the directive', async () => {
    const sql = fakeSql(directiveWorld(THEM));
    const routing = routingWorld({
      states: { [THEM]: 'ended', [ME]: 'live' },
      fleets: { [THEM]: 'fleet-x' },
      leaders: { 'fleet-x': ME },
    });

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, routing);

    expect(verdict).toEqual({ allowed: true, because: 'inherited-from-ended-session' });
  });

  it('a NON-leader is still refused when an ended addressee has a live leader', async () => {
    // Inheritance goes to the leader only; without this case a verdict that let
    // any session act on a fleet-routed directive would pass the one above.
    const sql = fakeSql(directiveWorld(THEM));
    const routing = routingWorld({
      states: { [THEM]: 'ended', 'su-leader': 'live' },
      fleets: { [THEM]: 'fleet-x' },
      leaders: { 'fleet-x': 'su-leader' },
    });

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, routing);

    expect(verdict).toEqual({ allowed: false, addressedTo: THEM, holders: [] });
  });

  it('an UNHANDLED directive (ended addressee, no fleet) may be adopted by anyone', async () => {
    const sql = fakeSql(directiveWorld(THEM));

    const verdict = await directiveActionVerdict(
      { directiveId: 96, ownerId: ME, workspaceId: WS },
      sql,
      routingWorld({ states: { [THEM]: 'ended' } }),
    );

    expect(verdict).toEqual({ allowed: true, because: 'adopting-unhandled' });
  });

  it('an UNKNOWN addressee state never reroutes — the refusal stands', async () => {
    const sql = fakeSql(directiveWorld(THEM));

    const verdict = await directiveActionVerdict(
      { directiveId: 96, ownerId: ME, workspaceId: WS },
      sql,
      routingWorld(),
    );

    expect(verdict).toEqual({ allowed: false, addressedTo: THEM, holders: [] });
  });

  it('fails CLOSED: a routing read error leaves the refusal standing', async () => {
    const sql = fakeSql(directiveWorld(THEM));
    const broken: DirectiveRoutingDeps = {
      ...routingWorld(),
      async sessionStates() {
        throw new Error('liveness oracle unavailable');
      },
    };

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, broken);

    expect(verdict).toEqual({ allowed: false, addressedTo: THEM, holders: [] });
  });

  it('binds the CANONICAL terminal set, and EXCLUDES it rather than selecting it', async () => {
    const sql = fakeSql(directiveWorld(THEM, []));

    await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql, THEM_LIVE);

    const workItemsCall = sql.calls.find((c) => c.text.includes('harness_shared.work_items'));
    expect(workItemsCall, 'a foreign directive must consult linking work-items').toBeDefined();

    // HALF 1 — the SET. A hand-listed terminal set is a second copy of
    // TERMINAL_WORK_ITEM_STATES and drifts in the PERMISSIVE direction: the
    // measured drift (EI-18653071581558556) omitted members, and an omitted
    // member here means a holder of a FINISHED work-item keeps authority over
    // a live peer's directive. Pinning the identity of the array is what makes
    // a re-listed copy fail here instead of in production.
    const bound = workItemsCall!.values.find((v) => Array.isArray(v)) as string[] | undefined;
    expect(bound).toEqual([...TERMINAL_WORK_ITEM_STATES]);

    // HALF 2 — the DIRECTION. The bound-array check alone still passes if the
    // predicate is inverted to `status = ANY(...)`, which would hand authority
    // to exactly the terminal holders it was written to exclude.
    expect(workItemsCall!.text).toContain('NOT (status = ANY(');
    expect(workItemsCall!.text).toContain('directive_ref');
  });

  it('CALIBRATION: the canonical set really does carry the drift-prone members', () => {
    // Without this, the identity assertion above would still pass against a
    // TERMINAL_WORK_ITEM_STATES that had itself lost `deprecated`/`passed` —
    // the precise drift that produced ~88% phantom stranded-placement reports.
    for (const terminal of ['done', 'dropped', 'passed', 'deprecated']) {
      expect(TERMINAL_WORK_ITEM_STATES, `${terminal} must be terminal`).toContain(terminal);
    }
    // And the live states must NOT be in it, or the filter would exclude every
    // legitimate holder and silently collapse the pass-through to nothing.
    for (const live of ['open', 'wip', 'blocked', 'needs-human']) {
      expect(TERMINAL_WORK_ITEM_STATES, `${live} must not be terminal`).not.toContain(live);
    }
  });
});

describe('agenda writes — per-session, and deliberately UNGUARDED (D-008 defect B)', () => {
  it('clearDirectiveFromAgenda keys the row by the ACTING owner and never touches the global column', async () => {
    const sql = fakeSql();

    const result = await clearDirectiveFromAgenda(
      { directiveId: 96, ownerId: ME, workspaceId: WS, reason: '  not my lane  ' },
      sql,
    );

    expect(result).toEqual({ ok: true, state: 'dismissed' });
    expect(sql.calls).toHaveLength(1);
    const [call] = sql.calls;
    expect(call!.text).toContain('harness_shared.owner_directive_agenda');
    expect(call!.text).toContain('ON CONFLICT');
    // The acting owner is part of the KEY, which is what makes a global
    // dismissal unrepresentable rather than merely forbidden.
    expect(call!.values).toContain(ME);
    expect(call!.values).toContain(WS);
    expect(call!.values).toContain(96);
    // Reason is trimmed before it reaches the NOT-NULL/length CHECK, so a
    // whitespace-only reason cannot satisfy the constraint by accident.
    expect(call!.values).toContain('not my lane');
    // The whole point of the split: this write must not reach the column whose
    // single global value erased directive #96 for its rightful addressee.
    expect(call!.text).not.toContain('capture_status');
  });

  it('restoreDirectiveToAgenda re-opens the row and clears the reason', async () => {
    const sql = fakeSql();

    const result = await restoreDirectiveToAgenda({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql);

    expect(result).toEqual({ ok: true, state: 'open' });
    expect(sql.calls[0]!.text).toContain("state = 'open'");
    // A re-opened row must not keep the old dismissal reason: the reason is
    // only meaningful as the justification of a CURRENT dismissal.
    expect(sql.calls[0]!.text).toContain('reason = NULL');
  });

  it('the exclusion is absent unless a viewer is named, so an un-threaded reader is unchanged', async () => {
    const sql = fakeSql();

    await listOwnerDirectives({ workspaceId: WS, open: true, limit: 12 }, sql);

    // The LEDGER view (orders:list, the disposition audit trail) must keep
    // showing rows a session personally cleared — otherwise `clear` reads as an
    // untraceable disappearance rather than a per-session agenda action.
    expect(sql.calls.some((c) => c.text.includes('owner_directive_agenda'))).toBe(false);
  });

  it('naming a viewer excludes that viewer’s cleared rows, BEFORE the LIMIT', async () => {
    const sql = fakeSql();

    await listOwnerDirectives({ workspaceId: WS, open: true, limit: 12, viewerOwnerId: ME }, sql);

    const fragment = sql.calls.find((c) => c.text.includes('owner_directive_agenda'));
    expect(fragment, 'a named viewer must contribute an exclusion').toBeDefined();
    expect(fragment!.text).toContain('NOT EXISTS');
    expect(fragment!.text).toContain("cleared.state = 'dismissed'");
    expect(fragment!.values).toContain(ME);
    // It must correlate on the OTHER session's row, never on the directive's own
    // recorded_by — clearing is about whose banner this is, not whose order it is.
    expect(fragment!.text).toContain('cleared.owner_id');

    // PRE-LIMIT is the load-bearing half. The banner reads a fixed number of
    // rows, so an exclusion applied to the returned PAGE spends render slots on
    // rows the viewer never sees: clear three and the banner shows three FEWER
    // live directives, which reads as "nothing else is owed". fakeSql joins on
    // ' ? ', so the fragment's placeholder index locates it in the statement.
    const query = sql.calls.find((c) => c.text.includes('FROM harness_shared.owner_directives'))!;
    const slot = query.values.indexOf(fragment!.returned);
    expect(slot, 'the fragment must be embedded in the directive query itself').toBeGreaterThanOrEqual(0);
    const beforeFragment = query.text.split(' ? ').slice(0, slot + 1).join(' ');
    expect(beforeFragment).not.toContain('LIMIT');
    expect(query.text).toContain('LIMIT');
  });

  it('the open-directive COUNT applies the same exclusion as the list', async () => {
    const sql = fakeSql(() => [{ n: 0 }]);

    await countOpenOwnerDirectives(WS, sql, ME);

    // A count that skipped it would announce "+3 more" for rows the banner is
    // deliberately hiding, sending the reader to orders:list to hunt for
    // directives its own agenda already discharged.
    const fragment = sql.calls.find((c) => c.text.includes('owner_directive_agenda'));
    expect(fragment, 'the count must exclude the viewer’s cleared rows too').toBeDefined();
    expect(fragment!.values).toContain(ME);
  });

  it('a stop guard ignores foreign FYI directives while filtering the owner list in SQL', async () => {
    const foreign = rawDirective(501, THEM);
    let ownerFilterPresent = false;
    const sql = fakeSql((text) => {
      if (text.includes('AND recorded_by =')) {
        ownerFilterPresent = true;
        return [];
      }
      if (!text.includes('FROM harness_shared.owner_directives')) return [];
      return ownerFilterPresent ? [] : [foreign];
    });

    const guard = await checkOpenDirectivesGuard({
      workspaceId: WS,
      viewerOwnerId: ME,
      acknowledged: false,
      action: 'loop:end',
      sql,
    });

    expect(guard).toBeNull();
    const list = sql.calls.find((call) => call.text.includes('FROM harness_shared.owner_directives'))!;
    const ownerFilter = sql.calls.find((call) => call.text.includes('AND recorded_by ='))!;
    expect(ownerFilter.values).toContain(ME);
    const slot = list.values.indexOf(ownerFilter.returned);
    expect(slot, 'the caller filter must be embedded in the directive query').toBeGreaterThanOrEqual(0);
    expect(list.text.split(' ? ').slice(0, slot + 1).join(' ')).not.toContain('LIMIT');
  });

  it('blocks on this session’s directives and uses the same owner filter for the overflow count', async () => {
    const ownRows = Array.from({ length: 5 }, (_, i) => rawDirective(600 + i, ME));
    const foreignRows = Array.from({ length: 5 }, (_, i) => rawDirective(700 + i, THEM));
    let ownerFilterPresent = false;
    const sql = fakeSql((text) => {
      if (text.includes('AND recorded_by =')) {
        ownerFilterPresent = true;
        return [];
      }
      if (text.includes('SELECT count(*) AS n')) {
        return [{ n: ownerFilterPresent ? '7' : '12' }];
      }
      if (text.includes('FROM harness_shared.owner_directives')) {
        return ownerFilterPresent ? ownRows : foreignRows;
      }
      return [];
    });

    const guard = await checkOpenDirectivesGuard({
      workspaceId: WS,
      viewerOwnerId: ME,
      acknowledged: false,
      action: 'loop:end',
      sql,
    });

    expect(guard).toMatchObject({ ok: false, error: 'open_owner_directives', openCount: 7 });
    expect(guard?.directives).toHaveLength(5);
    expect(guard?.directives.every((directive) => directive.includes('[FOR THIS SESSION]'))).toBe(true);
    const list = sql.calls.find((call) => call.text.includes('SELECT *,'))!;
    const count = sql.calls.find((call) => call.text.includes('SELECT count(*) AS n'))!;
    const listFilter = sql.calls.find(
      (call) => call.text.includes('AND recorded_by =') && list.values.includes(call.returned),
    );
    const countFilter = sql.calls.find(
      (call) => call.text.includes('AND recorded_by =') && count.values.includes(call.returned),
    );
    expect(listFilter?.values).toContain(ME);
    expect(countFilter?.values).toContain(ME);
  });

  it('fails open when no viewer identity is available instead of blocking on workspace-wide rows', async () => {
    const sql = fakeSql(() => [rawDirective(801, THEM)]);

    const guard = await checkOpenDirectivesGuard({
      workspaceId: WS,
      viewerOwnerId: null,
      acknowledged: false,
      action: 'loop:end',
      sql,
    });

    expect(guard).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });

  it('listClearedDirectiveIds reads only DISMISSED rows for one owner, as numbers', async () => {
    // bigint comes back from `postgres` as a STRING; a Set of strings silently
    // never matches the numeric directive ids the renderer holds, so the whole
    // clear would appear to do nothing while every write succeeded.
    const sql = fakeSql(() => [{ directive_id: '96' }, { directive_id: 110 }]);

    const cleared = await listClearedDirectiveIds({ ownerId: ME, workspaceId: WS }, sql);

    expect(cleared).toEqual(new Set([96, 110]));
    expect([...cleared].every((id) => typeof id === 'number')).toBe(true);
    const [call] = sql.calls;
    expect(call!.text).toContain("state = 'dismissed'");
    expect(call!.values).toContain(ME);
    expect(call!.values).toContain(WS);
  });
});

describe('control: the holder-column assertion is falsifiable (P-008 outage class)', () => {
  // NOT hypothetical: the first draft of directiveActionVerdict selected
  // `assignee` from harness_shared.work_items. That column does not exist on
  // that table — the spelling belongs to the issue-family view — so the query
  // raised 42703 and `orders:resolve-pending` failed 100% of calls fleet-wide
  // until it was fixed.
  //
  // This suite did not catch it, and the reason is the point of this block:
  // `directiveWorld` handed back rows keyed `assignee`, so the FIXTURE agreed
  // with the bug. An oracle derived from the implementation cannot falsify it.
  // Fixing the column alone would have left that trap armed — the fixture was
  // then stranded the other way, silently yielding `undefined` for every
  // holder — so the spelling is pinned here, on the generated SQL itself.
  //
  // Mutating the real module to re-prove this would dirty a swept shared tree,
  // so the wrong implementation lives here permanently instead (repo
  // mutation-probe tier 1, matching fleet_registry/pause-holds.test.ts).
  it('the real holders query selects taken_by, and never assignee', async () => {
    const sql = fakeSql(directiveWorld(THEM, [ME]));

    const verdict = await directiveActionVerdict({ directiveId: 96, ownerId: ME, workspaceId: WS }, sql);

    const call = sql.calls.find((c) => c.text.includes('harness_shared.work_items'));
    expect(call, 'the work_items holder lookup must actually run').toBeDefined();
    expect(call!.text).toContain('taken_by');
    expect(call!.text).not.toContain('assignee');
    // Calibration: the query must also be WIRED UP, not merely spelled right.
    // Without this, a holders lookup whose rows never reach the verdict would
    // still satisfy both assertions above.
    expect(verdict).toEqual({ allowed: true, because: 'holds-linking-work-item' });
  });

  it('control: the pre-fix query FAILS both assertions the real one passes', () => {
    const preFixSql =
      'SELECT assignee FROM harness_shared.work_items WHERE workspace_id = ? AND assignee IS NOT NULL';

    expect(preFixSql).not.toContain('taken_by');
    expect(preFixSql).toContain('assignee');
  });
});
