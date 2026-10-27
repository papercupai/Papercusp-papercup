/** The original census reads exact durable episode owners after their status changes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  identityActivationConditionKey,
  loadDenialAttestationsFromLedger,
  runUnappliedActivationCensusOnce,
  runWedgedIdentitySweepOnce,
  type CandidateRow,
  type WedgedIdentitySweepDeps,
  type WedgedLiveness,
} from './wedged-identity-activation-watchdog';

const store = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: store.sql }),
}));
vi.mock('../workspace-registry', async (original) => ({
  ...(await original<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'identity-rail-pg',
}));

let db: FreshPgDb;
const WS = 'identity-rail-pg', OWNER = 'identity-pg-owner';
const pair = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const activation = (applied: boolean) => ({ schemaVersion: 1,
  attribution: { actorId: OWNER, principalId: 'system:superuser', sessionId: OWNER },
  desired: pair, prepared: applied ? null : pair, applied: applied ? pair : null,
  status: applied ? 'applied' : 'prepared' });
const key = identityActivationConditionKey('unapplied', WS, OWNER);
let open: Set<string>;
const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
  expect(event.oneShot).toBe(true); open.add(event.conditionKey!); return true;
});
const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
const pass = () => runUnappliedActivationCensusOnce({
  rail: { broadcast, resolve }, readOpenConditions: async () => [...open],
  loadPositiveControl: async () => ({ recentBriefs: 1, recentJournalTurns: 2 }),
  resolveLiveness: async ids => new Map(ids.map(id => [id, 'live' as const])),
  escalateUnapplied: async () => { expect(open.has(key)).toBe(true); },
  escalateNotMeasured: async () => {},
});

beforeAll(async () => {
  db = await createFreshPgDb('identity-rail'); store.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text, control_state jsonb);
    CREATE TABLE harness_shared.session_identity_activation_events
      (id integer, owner_id text, workspace_id text, phase text, recorded_at timestamptz);
    CREATE TABLE harness_shared.session_turn_journal (owner_id text, workspace_id text, created_at timestamptz);
    -- WI-6554700010029612: the columns loadDenialAttestationsFromLedger reads, with the
    -- live types and NOT NULL constraints of harness_shared.tool_invocations.
    CREATE TABLE harness_shared.tool_invocations
      (workspace_id text NOT NULL, harness_slug text NOT NULL, plugin_name text NOT NULL,
       tool_name text NOT NULL, role text NOT NULL, spawn_id text NOT NULL, window_key text NOT NULL,
       invoked_at timestamptz NOT NULL, status text NOT NULL, error_message text,
       coord_owner_id text, serving_host text, serving_build_sha text);`);
}, 120_000);
afterAll(async () => { store.sql = null; await db?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks(); open = new Set();
  await db.sql`TRUNCATE harness_shared.session_briefs, harness_shared.session_identity_activation_events,
    harness_shared.session_turn_journal`;
  await db.sql`INSERT INTO harness_shared.session_briefs VALUES
    (${OWNER}, ${WS}, ${db.sql.json({ activation: activation(false) })})`;
  await db.sql`INSERT INTO harness_shared.session_identity_activation_events VALUES
    (1, ${OWNER}, ${WS}, 'prepared', now() - interval '1 hour')`;
  await db.sql`INSERT INTO harness_shared.session_turn_journal VALUES
    (${OWNER}, ${WS}, now() - interval '30 minutes'), (${OWNER}, ${WS}, now() - interval '10 minutes')`;
});

describe('original identity census durable recovery SQL', () => {
  it('opens from journaled turns, reloads a now-applied owner, resolves, and rearms', async () => {
    expect((await pass()).verdict).toBe('unapplied'); expect(open.has(key)).toBe(true);
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(true) })} WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
    expect((await pass()).verdict).toBe('clean'); expect(open.size).toBe(0);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(false) })} WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
    await pass(); expect(open.has(key)).toBe(true);
  });

  it('preserves missing, foreign, malformed and unreadable registrations', async () => {
    await pass();
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(true) })}, workspace_id = 'foreign'`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`UPDATE harness_shared.session_briefs SET workspace_id = ${WS}, control_state = '{}'::jsonb`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`DELETE FROM harness_shared.session_briefs`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`ALTER TABLE harness_shared.session_briefs RENAME TO briefs_unreadable`;
    try {
      expect((await pass()).verdict).toBe('not-measured');
      expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    } finally { await db.sql`ALTER TABLE harness_shared.briefs_unreadable RENAME TO session_briefs`; }
  });
});

// WI-6554700010029612 — the ATTEST rung's ledger read, against the real tool_invocations shape.
describe('loadDenialAttestationsFromLedger', () => {
  it('counts only this workspace, inside the window, at or above the threshold, and names the serving build', async () => {
    const insert = (owner: string, workspace: string, minutesAgo: number, message: string) => db.sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, invoked_at, status,
         coord_owner_id, error_message, serving_host, serving_build_sha)
      VALUES (${workspace}, 'papercusp', 'papercusp', 'coord:send', 'su', 'spawn-attest', 'w-attest',
         now() - make_interval(mins => ${minutesAgo}), 'error', ${owner}, ${message}, 'port-3070', 'd740fc3802abcdef')`;
    for (let i = 0; i < 3; i++) await insert('attest-denied', WS, 5, 'identity preflight refused: stale-artifact');
    for (let i = 0; i < 2; i++) await insert('attest-below-threshold', WS, 5, 'stale-artifact');
    for (let i = 0; i < 3; i++) await insert('attest-outside-window', WS, 90, 'stale-artifact');
    for (let i = 0; i < 3; i++) await insert('attest-foreign', 'foreign-ws', 5, 'stale-artifact');
    for (let i = 0; i < 3; i++) await insert('attest-other-error', WS, 5, 'statement timeout');

    expect(await loadDenialAttestationsFromLedger(WS)).toEqual([
      { ownerId: 'attest-denied', denials: 3, servedBy: ['port-3070@d740fc3802'] },
    ]);
  });
});

// WI-6554700010029612 prescribed guard: denials seeded in the real ledger shape, read by the real
// loader, raise the wedged alarm through the real sweep. The candidate read returns one RETIRED row:
// it satisfies the sweep's scanned>0 positive control but is never classified, so the alarm can
// only come from the serving build's refusals, never from an activation record. (The "record
// would admit this session" half is the unit control-then-veto case.)
describe('ATTEST rung end-to-end', () => {
  it('raises the wedged condition from seeded serving-build denials and names the denying build', async () => {
    const owner = 'attest-e2e-owner';
    for (let i = 0; i < 3; i++) {
      await db.sql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, invoked_at, status,
           coord_owner_id, error_message, serving_host, serving_build_sha)
        VALUES (${WS}, 'papercusp', 'papercusp', 'coord:send', 'su', 'spawn-e2e', 'w-e2e',
           now() - interval '2 minutes', 'error', ${owner}, 'identity preflight refused: stale-artifact',
           'port-3070', 'd740fc3802abcdef')`;
    }
    const retiredRow: CandidateRow = {
      ownerId: 'attest-e2e-retired', launchSpec: null, advSessionId: null, activation: null, retired: true,
    };
    const raised = new Set<string>();
    const resolveCondition = vi.fn(async () => true);
    const escalateWedged = vi.fn(async () => {});
    const sweepDeps: WedgedIdentitySweepDeps = {
      workspaceId: WS,
      readOpenConditions: async () => [...raised],
      rail: {
        broadcast: vi.fn(async (event: { conditionKey?: string }) => { raised.add(event.conditionKey!); return true; }),
        resolve: resolveCondition,
      },
      loadCandidates: async () => [retiredRow],
      verdictCache: { verdicts: new Map(), lastReused: 0, lastScanned: 0, lastRetired: 0 },
      yieldAfterClassified: async (classifiedSoFar) => classifiedSoFar + 1,
      resolveLiveness: async (ids) => new Map(ids.map((id) => [id, 'live' as WedgedLiveness])),
      escalateWedged,
      escalateNotMeasured: vi.fn(async () => {}),
      loadDenialAttestations: () => loadDenialAttestationsFromLedger(WS),
    };

    const out = await runWedgedIdentitySweepOnce(sweepDeps);
    expect(out.verdict).toBe('wedged');
    if (out.verdict !== 'wedged') return;
    expect(out.wedged.find((w) => w.ownerId === owner)?.reason).toContain('port-3070@d740fc3802');
    expect(raised.has(identityActivationConditionKey('wedged', WS, owner))).toBe(true);
    expect(escalateWedged).toHaveBeenCalled();
  });
});
