/**
 * WI-37774 — the ADVERTISE side of the row-intrinsic claim floors.
 *
 * A floor meaning "agents must never get this" has TWO sides, implemented in DIFFERENT
 * functions: cannot-CLAIM (`claimNextIssueWorkItem`, work-items.ts) and is-not-OFFERED
 * (`issueAdmissibleWhereSql`, issues-engineer.ts). WI-2633 guarded only the claim side and
 * its test file guarded only the claim side, so the advertise side sat unguarded for months
 * while LOOKING covered. WI-37761 fixed one such floor (federation-detector); this file
 * covers the three siblings found by auditing for the same shape rather than by hitting them:
 *
 *   - loop-noise                    (EI-8802, loopIterationNoiseExclusionSql)
 *   - already-terminally-completed  (EI-8972, alreadyTerminallyCompletedExclusionSql)
 *   - an ACTIVE typed external blocker      (externalBlockersExclusionSql)
 *
 * Each is ROW-INTRINSIC — its helper takes only `sql`, no assignee/rigAvailable/swarmId — so
 * each is one of the "unconditional per-row floors" WI-4405's contract already claims to
 * mirror, as opposed to the readiness/rig/cooldown/swarm/redundancy floors it deliberately
 * omits for needing live claim context.
 *
 * THE LAST DESCRIBE IS THE POINT. The per-floor cases below pin the three floors I fixed;
 * the INVARIANT case pins the RULE ("nothing advertised is unclaimable") against the real
 * claim oracle, so a FOURTH floor added to the claim path and not here fails without anyone
 * remembering this file exists. Enumerating floors is what let the gap open in the first
 * place — a test that only enumerates would reproduce the original defect one floor later.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const adm = await import('./work-items-admission');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedIssue(
  id: string,
  opts: {
    title?: string;
    status?: string;
    payload?: Record<string, unknown> | null;
    terminalOwner?: string | null;
    terminalCompletionRef?: string | null;
    authority?: string | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       payload, terminal_owner, terminal_completion_ref, authority)
    VALUES (${H}, ${id}, 'bug', ${opts.title ?? `title ${id}`}, ${opts.status ?? 'open'}, ${null},
       ${WS}, 0, 0,
       ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null},
       ${opts.terminalOwner ?? null}, ${opts.terminalCompletionRef ?? null}, ${opts.authority ?? null})`;
}

const advertisedIds = async () =>
  (await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true })).map((r) => r.id);
const allIds = async () => (await wi.listWorkItems({ harness: H, state: 'open' })).map((r) => r.id);

beforeAll(async () => {
  db = await createFreshPgDb('wi-advertise-floor-parity');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('admissibleOnly EXCLUDES a loop-iteration bookkeeping marker (WI-37774 / EI-8802)', () => {
  it('is offered WITHOUT admissibleOnly but NOT with it (the floor is what removes it)', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-WAKE', { title: 'Loop wake #9775: continue papercusp backlog drain' });
    // The without-flag leg is the POSITIVE CONTROL: without it, the exclusion assertion
    // below would pass just as well if the fixture never seeded the row at all.
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-WAKE']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-WAKE');
  });

  it('excludes the OTHER marker form too ("AUTO loop iteration:")', async () => {
    await seedIssue('WI-AUTO', { title: 'AUTO loop iteration: delta rollout contract runtime policy' });
    expect(await allIds()).toContain('WI-AUTO');
    expect(await advertisedIds()).not.toContain('WI-AUTO');
  });

  it('a row merely MENTIONING a loop wake mid-title is still advertised (prefix-anchored, not a substring)', async () => {
    // Guards against "fixing" the floor into a substring match, which would silently swallow
    // legitimate work — e.g. a bug report ABOUT the loop-wake markers, like this very item.
    await seedIssue('WI-ABOUT', { title: 'Stale "Loop wake #" rows are advertised but unclaimable' });
    expect(await advertisedIds()).toContain('WI-ABOUT');
  });
});

describe('admissibleOnly EXCLUDES an already-terminally-completed row (WI-37774 / EI-8972)', () => {
  it('terminal_owner + terminal_completion_ref ⇒ advertised without the flag, excluded with it', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-DONE', { terminalOwner: 'su-someone', terminalCompletionRef: 'WI-DONE#completion' });
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-DONE']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-DONE');
  });

  it('terminal_owner + authority (no completion ref) is also excluded', async () => {
    await seedIssue('WI-AUTH', { terminalOwner: 'su-someone', authority: 'committed' });
    expect(await advertisedIds()).not.toContain('WI-AUTH');
  });

  it('a BARE terminal_owner with neither ref nor authority is STILL advertised', async () => {
    // Mirrors alreadyTerminallyCompletedExclusionSql's own shape: an owner alone is not a
    // genuine terminal completion, so this row must stay claimable.
    await seedIssue('WI-BARE', { terminalOwner: 'su-someone' });
    expect(await advertisedIds()).toContain('WI-BARE');
  });
});

describe('admissibleOnly EXCLUDES a row with an ACTIVE external blocker (WI-37774)', () => {
  it('advertised without the flag, excluded with it', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-BLOCKED', {
      payload: { externalBlockers: [{ ref: 'mac-rig-vm', kind: 'runtime', status: 'active' }] },
    });
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-BLOCKED']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-BLOCKED');
  });

  it('EI-20213672709897481: excludes legacy uppercase ACTIVE blockers too', async () => {
    await seedIssue('WI-UPPERCASE-BLOCKED', {
      payload: {
        externalBlockers: [{ ref: '2-machine-rig', kind: 'runtime', status: 'ACTIVE', capability: 'physical-device' }],
      },
    });
    expect(await allIds()).toContain('WI-UPPERCASE-BLOCKED');
    expect(await advertisedIds()).not.toContain('WI-UPPERCASE-BLOCKED');
    const [verdict] = await wi.explainIssueClaimFloors(H, ['WI-UPPERCASE-BLOCKED']);
    expect(verdict).toMatchObject({ admissible: false, refusedBy: 'external-blocker' });
  });

  it('a RESOLVED blocker does not exclude (only status=="active" gates)', async () => {
    await seedIssue('WI-CLEARED', {
      payload: { externalBlockers: [{ ref: 'mac-rig-vm', kind: 'runtime', status: 'resolved' }] },
    });
    expect(await advertisedIds()).toContain('WI-CLEARED');
  });

  it('an empty/absent externalBlockers array does not exclude (NULL-safe)', async () => {
    await seedIssue('WI-EMPTY', { payload: { externalBlockers: [] } });
    await seedIssue('WI-NOPAYLOAD', { payload: null });
    const admissible = await advertisedIds();
    expect(admissible).toEqual(expect.arrayContaining(['WI-EMPTY', 'WI-NOPAYLOAD']));
  });
});

/**
 * THE CLASS GUARD. Everything above enumerates the floors I happened to fix; this asserts the
 * RULE they are instances of, against the real per-id claim oracle (`explainIssueClaimFloors`,
 * which is built from the SAME exported sql fragments the claim itself ANDs in).
 *
 * A future floor added to the claim path and not to issueAdmissibleWhereSql makes some seeded
 * row advertised-but-refused, and this fails naming the exact floor — no one has to remember
 * this file exists. That is the property whose absence let WI-37761 and WI-37774 happen.
 */
describe('INVARIANT: nothing advertised by admissibleOnly is refused by the claim floors (WI-37774)', () => {
  it('every advertised row is admissible per explainIssueClaimFloors', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-REAL-2', { payload: { externalBlockers: [{ ref: 'x', status: 'resolved' }] } });
    await seedIssue('WI-WAKE', { title: 'Loop wake #9775: continue papercusp backlog drain' });
    await seedIssue('WI-AUTO', { title: 'AUTO loop iteration: something' });
    await seedIssue('WI-DONE', { terminalOwner: 'su-someone', terminalCompletionRef: 'ref' });
    await seedIssue('WI-BLOCKED', { payload: { externalBlockers: [{ ref: 'rig', status: 'active' }] } });
    await seedIssue('WI-HUMAN', { payload: { needsHuman: true } });
    await seedIssue('WI-HOLD', { payload: { _claimHold: true } });

    const advertised = await advertisedIds();
    // Guard the guard: if the fixture stopped seeding, an empty advertised set would make the
    // assertion below vacuously true — the exact false-green this whole file is about.
    expect(advertised.length).toBeGreaterThan(0);

    const verdicts = await wi.explainIssueClaimFloors(H, advertised);
    const refused = verdicts.filter((v) => !v.admissible).map((v) => `${v.id}:${v.refusedBy}`);
    expect(refused).toEqual([]);
  });

  it('and the rows it withholds really are the unclaimable ones (no over-exclusion)', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-WAKE', { title: 'Loop wake #1: x' });
    const advertised = new Set(await advertisedIds());
    const withheld = (await allIds()).filter((id) => !advertised.has(id));
    const verdicts = await wi.explainIssueClaimFloors(H, withheld);
    // Every withheld row must have a REASON — withholding a claimable row is the dual
    // defect (a fleet idles while claimable work exists) and is just as wrong.
    expect(verdicts.filter((v) => v.admissible)).toEqual([]);
  });
});

/**
 * EI-22172757071586188 — `explainIssueClaimFloors` had SILENTLY omitted `ok_stop_line`: the
 * oracle could report `admissible: true` for a row the real claim path refused, exactly the
 * shape WI-37356 already fixed three times over (ok_no_blocker/ok_cooldown/ok_origin) for this
 * SAME oracle. This is the recurrence guard: a STRUCTURAL parity check (so a FIFTH floor added
 * to the claim path and forgotten here fails a unit test, never live data), plus one behavioral
 * case proving THIS fix works.
 */
describe('EI-22172757071586188 — the oracle floor set is a SUPERSET of the real claim bar', () => {
  it('every floor ALL_ISSUE_CLAIM_FLOORS_PASS ANDs is decorated by the oracle (read from LIVE column metadata, never source text)', async () => {
    const { ALL_ISSUE_CLAIM_FLOORS_PASS } = await import('./scheduler/get-next');
    const sql = db.sql as unknown as Parameters<typeof wi.issueClaimBarFloorColumnsSql>[0];
    const cols = wi.issueClaimBarFloorColumnsSql(sql, {
      issueWs: WS,
      assignee: 'su-probe',
      cooldown: 0,
      rigAvailable: true,
    });
    // WHERE false still forces Postgres to parse+plan the whole SELECT (a malformed floor
    // fails loudly here), while postgres.js still populates `.columns` on the empty result.
    const rows = await db.sql`SELECT ${cols} FROM harness_shared.work_items wi WHERE false`;
    const decorated = ((rows.columns ?? []) as unknown as ReadonlyArray<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n.startsWith('ok_'));
    // Guard the guard: an empty decorated set would make the superset assertion below
    // vacuously true — the exact false-green this test exists to prevent.
    expect(decorated.length, 'probe returned no ok_* columns — the probe is broken, not the oracle').toBeGreaterThan(0);

    const barFloors = [...new Set(ALL_ISSUE_CLAIM_FLOORS_PASS.match(/ok_[a-z_]+/g) ?? [])];
    expect(barFloors.length).toBeGreaterThan(0);
    const missing = barFloors.filter((f) => !decorated.includes(f));
    expect(
      missing,
      `ALL_ISSUE_CLAIM_FLOORS_PASS ANDs ${JSON.stringify(missing)} but explainIssueClaimFloors ` +
        `never decorates it, so the per-id oracle can report admissible:true for a row the real ` +
        `claim path refuses. Add it to issueClaimBarFloorColumnsSql AND the refusedBy ternary in ` +
        `explainIssueClaimFloors.`,
    ).toEqual([]);
  });

  it('a non-repair row is refused by stop-line once the harness gate-red-streak condition is >24h open', async () => {
    const conditionKey = `gate-red-streak:${H}`;
    const agedMs = Date.now() - 25 * 3_600_000; // 25h old — over STOP_THE_LINE_RED_HOURS
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, origin,
         created_ts, updated_ts, title, condition_key)
      VALUES (${H}, 'WI-STL-CONDITION', 'bug', 'open', ${WS}, 'local',
              ${agedMs}, 0, 'gate red-streak condition', ${conditionKey})`;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, origin,
         created_ts, updated_ts, title)
      VALUES (${H}, 'WI-STL-CHANGE', 'change', 'open', ${WS}, 'local', 0, 0, 'ordinary change row')`;

    const [conditionVerdict, changeVerdict] = await wi.explainIssueClaimFloors(H, [
      'WI-STL-CONDITION',
      'WI-STL-CHANGE',
    ]);
    // The condition item itself remains stop-line-exempt repair work, but its narrower
    // LIVE_GATE_OPS reservation keeps it out of generic self-select. The registered
    // fixer still has the explicit by-id door (covered by stop-the-line-floor's claim test).
    expect(conditionVerdict).toMatchObject({ admissible: false, refusedBy: 'live-gate-ops' });
    expect(conditionVerdict.detail).toContain('BY ID');
    expect(changeVerdict).toMatchObject({ admissible: false, refusedBy: 'stop-line' });
    expect(changeVerdict.detail).toContain('stop-the-line');
  });
});

/**
 * EI-25209690807142935 / EI-26282407214531658 — the admission-pending floor promised the
 * fail-open runner's ceiling (`retry.guaranteedWithinSec`) to rows that runner never admits.
 * Measured live on EI-26277464744695494 (degraded dedup coverage): promised 90 min, still
 * pending two days later. The guard is AGREEMENT against the runner's own eligibility fragment,
 * evaluated by real Postgres: a bound is published for a row IFF the runner would admit it.
 */
describe('EI-25209690807142935 — admission-pending publishes the fail-open bound only for rows the runner admits', () => {
  interface FailOpenCase {
    id: string;
    /** The runner exclusion this row must carry; undefined = the runner admits it. */
    exclusion: string | undefined;
    payload?: Record<string, unknown>;
    duplicateOf?: string;
    admission?: string;
  }

  async function seedPending(id: string, opts: Omit<FailOpenCase, 'id' | 'exclusion'>) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, origin, created_ts, updated_ts,
         title, admission, duplicate_of, payload)
      VALUES (${H}, ${id}, 'bug', 'open', ${WS}, 'local', 0, 0, ${`title ${id}`},
              ${opts.admission ?? 'pending'}, ${opts.duplicateOf ?? null},
              ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
  }

  const CASES: readonly FailOpenCase[] = [
    { id: 'WI-FO-CLEAN', exclusion: undefined },
    { id: 'WI-FO-DEGRADED', exclusion: 'degraded-dedup-coverage', payload: { dedupCoverage: { degraded: true, lexical: 'unavailable' } } },
    { id: 'WI-FO-CANDIDATES', exclusion: 'duplicate-candidates', payload: { dedupCandidates: [{ id: 'WI-FO-CLEAN', method: 'lexical' }] } },
    // Candidates AND degraded: the record's ORDER decides, so the stronger signal is named.
    { id: 'WI-FO-BOTH', exclusion: 'duplicate-candidates', payload: { dedupCandidates: [{ id: 'WI-FO-CLEAN' }], dedupCoverage: { degraded: true } } },
    // An admitted row with a verdict is still floored by admission-pending (admittedWhereSql).
    { id: 'WI-FO-VERDICT', exclusion: 'duplicate-verdict', duplicateOf: 'WI-FO-CLEAN', admission: 'admitted' },
    // degraded:false is NOT an exclusion — the complement must be exact.
    { id: 'WI-FO-NOT-DEGRADED', exclusion: undefined, payload: { dedupCoverage: { degraded: false } } },
  ];

  it('every case is refused by admission-pending, with a bound IFF the runner would admit it', async () => {
    for (const c of CASES) await seedPending(c.id, c);
    const ids = CASES.map((c) => c.id);
    const verdicts = await wi.explainIssueClaimFloors(H, ids);

    const sql = db.sql as unknown as Parameters<typeof adm.failOpenDedupEligibleWhereSql>[0];
    const eligibleRows = await db.sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE feature_id = ANY(${ids}::text[]) AND ${adm.failOpenDedupEligibleWhereSql(sql)}`;
    const runnerAdmits = new Set(eligibleRows.map((r) => r.feature_id));
    // Positive controls: the agreement below is vacuous unless both populations are present.
    expect([...runnerAdmits].sort()).toEqual(['WI-FO-CLEAN', 'WI-FO-NOT-DEGRADED']);

    for (const c of CASES) {
      const v = verdicts.find((x) => x.id === c.id)!;
      expect(v, c.id).toMatchObject({ admissible: false, refusedBy: 'admission-pending' });
      expect(v.failOpenExclusion, c.id).toBe(c.exclusion);
      expect(v.retry !== undefined, `${c.id}: published a bound the runner does not honour (or withheld one it does)`).toBe(
        runnerAdmits.has(c.id),
      );
      if (v.retry) expect(v.retry.guaranteedWithinSec).toBe(adm.admissionFailOpenGuaranteedSec());
    }
    const verdictRow = verdicts.find((x) => x.id === 'WI-FO-VERDICT')!;
    expect(verdictRow.detail).toContain('(WI-FO-CLEAN)');
    expect(verdicts.find((x) => x.id === 'WI-FO-DEGRADED')!.detail).toContain('could NOT RUN');
  });

  it('the re-screen selector predicate is exactly "degraded and nothing stronger"', async () => {
    for (const c of CASES) await seedPending(c.id, c);
    const sql = db.sql as unknown as Parameters<typeof adm.failOpenExclusionSql>[0];
    const rows = await db.sql<{ feature_id: string; exclusion: string | null }[]>`
      SELECT feature_id, ${adm.failOpenExclusionSql(sql)} AS exclusion
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${CASES.map((c) => c.id)}::text[])`;
    const got = Object.fromEntries(rows.map((r) => [r.feature_id, r.exclusion]));
    expect(got).toEqual(Object.fromEntries(CASES.map((c) => [c.id, c.exclusion ?? null])));
  });
});
