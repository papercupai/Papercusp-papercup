import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
const m = vi.hoisted(() => ({ sql: null as any, launch: vi.fn(), loops: vi.fn() }));
vi.mock('@papercusp/db-org', async orig => ({ ...(await orig<object>()), getOrgPg: () => ({ sql: m.sql }) }));
vi.mock('../../events/await/psu-pty-discovery', () => ({ findLiveHostAsync: async () => null }));
vi.mock('../../events/await/store', () => ({ hasPendingDeliberateWakeDelivery: async () => false }));
vi.mock('../../attention/gate-store', () => ({ listPendingGates: async () => [] }));
vi.mock('../../session-assume-pause', () => ({ readAssumeCallerPause: async () => null }));
vi.mock('./loop', () => ({ getLoopStatuses: m.loops }));
vi.mock('./psu-pty-host-events-ingest', () => ({ ingestPsuPtyHostEvents: async () => ({ ingestErrors: 0 }) }));
vi.mock('../../agent-tools/capability/launch-agent', () => ({ default: { handler: m.launch },
  INTERNAL_INTERRUPTION_RECOVERY: Symbol.for('integration-interruption') }));
import { interruptionFromEvent, runSessionInterruptionPass as sweepSessionInterruptions,
  createSessionInterruptionRuntime } from './session-interruption-runtime';
import { sessionRecoveryKey } from './session-interruption-recovery';
let db: OrgTestDb;
const ws = 'interruption-integration';
const owner = 'su-interruption-integration';
const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
const ctx = { workspaceId: ws, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeAll(async () => { db = await createOrgTestDb({ adminPoolMax: 6 }); m.sql = db.adminSql; });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks(); m.loops.mockResolvedValue(new Map());
  m.launch.mockResolvedValue({ data: { launch: { resumeVerified: true } } });
  const sql = db.adminSql;
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${owner}`;
  await sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.psu_pty_host_events WHERE owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner}`;
  const [a] = await sql`INSERT INTO harness_shared.adv_sessions
    (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, launch_spec)
    VALUES (${ws}, 'codex', 'console', ${owner}, ${native}, now() - interval '1 minute', now(),
      '{"headless":true}'::jsonb) RETURNING id`;
  const now = Date.now();
  const payload = { workspaceId: ws, ownerId: owner, nativeSessionId: native, advSessionId: String(a.id),
    hostPid: 99999999, hostStartedAt: now - 10000,
    execution: { ownerId: owner, hostPid: 99999999, observedAt: now - 1, phase: 'running',
      turnStartedAt: now - 5000, lastProgressAt: now - 1, pendingTools: 0 } };
  await sql`INSERT INTO harness_shared.psu_pty_host_events
    (workspace_id, owner_id, ts, kind, payload, row_digest)
    VALUES (${ws}, ${owner}, now(), 'session-execution-observed', ${JSON.stringify(payload)}::jsonb, ${String(now)})`;
});
async function receipt() {
  const [r] = await db.adminSql`SELECT control_state #> '{lifecycle,interruption}' AS marker
    FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
  return r?.marker;
}
async function reserveFixture(attempts: number, state = 'pending') {
  const [row] = await db.adminSql<Array<{ owner_id: string; payload: Record<string, unknown>;
    ts: Date; session_id: string }>>`SELECT owner_id, payload, ts,
    payload->>'nativeSessionId' AS session_id FROM harness_shared.psu_pty_host_events
    WHERE owner_id = ${owner}`;
  const interruption = interruptionFromEvent(row)!;
  const marker = { ...interruption, key: sessionRecoveryKey(interruption), attempts,
    state, nextAttemptAt: 0, ...(state === 'recovering' ? { leaseKey: 'expired-reservation' } : {}) };
  await db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
    VALUES (${owner}, ${ws}, ${JSON.stringify({ lifecycle: { interruption: marker } })}::jsonb)`;
}
describe('production interruption SQL against migrated PostgreSQL', () => {
  it('replays an already committed settlement without changing its deadline or accepting another result', async () => {
    const runtime = await createSessionInterruptionRuntime(ctx);
    const original = (await runtime.list())[0];
    const key = sessionRecoveryKey(original.interruption!);
    const claimed = (await runtime.claim(original, key))!;
    const outcome = { verified: false, terminal: true, reason: 'uncertain-native-creation' };
    expect(await runtime.finish(claimed, key, outcome)).toBe(true);
    const committed = await receipt();
    expect(await runtime.finish(claimed, key, outcome)).toBe(true);
    expect(await receipt()).toEqual(committed);
    expect(await runtime.finish(claimed, key, { verified: true, reason: 'different-result' })).toBe(false);
    expect(await receipt()).toEqual(committed);
  });
  it('allows exactly one dispatch-intent writer and preserves the marker through held settlement', async () => {
    const runtime = await createSessionInterruptionRuntime(ctx);
    const original = (await runtime.list())[0];
    const key = sessionRecoveryKey(original.interruption!);
    const claimed = (await runtime.claim(original, key))!;
    expect(claimed).toBeTruthy();
    const results = await Promise.all(Array.from({ length: 3 }, () => runtime.markDispatch(claimed)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const dispatched = await receipt();
    expect(dispatched.dispatchStartedAt).toBeGreaterThan(0);
    await db.adminSql`UPDATE harness_shared.session_briefs SET control_state =
      jsonb_set(control_state, '{lifecycle,interruption,nextAttemptAt}', '0'::jsonb) WHERE owner_id = ${owner}`;
    expect(await runtime.claim((await runtime.read(owner))!, key)).toBeNull();
    expect(await runtime.finish(claimed, key, { verified: false, terminal: true, reason: 'uncertain-native-creation' })).toBe(true);
    expect(await receipt()).toMatchObject({ state: 'blocked', attempts: 1,
      dispatchStartedAt: dispatched.dispatchStartedAt, reason: 'uncertain-native-creation' });
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('uses durable member lineage after presence teardown and honors a later explicit leave', async () => {
    await db.adminSql`INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event, at)
      VALUES (${ws}, ${owner}, ${owner}, 'original-fleet', 'member', 'join', now())`;
    try {
      const joined = await sweepSessionInterruptions(ctx, true, { fleetSlug: 'original-fleet' });
      expect(joined.protectedOwnerIds).toEqual([owner]);
      expect(m.launch).not.toHaveBeenCalled();
      // A stale presence mirror must not resurrect an explicit durable leave.
      await db.adminSql`INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, fleet_slug, fleet_role)
        VALUES (${owner}, ${ws}, 'original-fleet', 'member')`;
      await db.adminSql`INSERT INTO harness_shared.fleet_membership_events
        (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event, at)
        VALUES (${ws}, ${owner}, ${owner}, NULL, NULL, 'leave', now())`;
      const left = await sweepSessionInterruptions(ctx, true, { fleetSlug: 'original-fleet' });
      expect(left.protectedOwnerIds).toEqual([]);
    } finally {
      await db.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.fleet_membership_events WHERE owner_id = ${owner}`;
    }
  });
  it('shares a fleet-filtered original-member claim with the ordinary interruption actor', async () => {
    await db.adminSql`INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, fleet_slug, fleet_role)
      VALUES (${owner}, ${ws}, 'original-fleet', 'member')
      ON CONFLICT (owner_id) DO UPDATE SET fleet_slug = 'original-fleet', fleet_role = 'member'`;
    try {
      const [fleet] = await Promise.all([
        sweepSessionInterruptions(ctx, false, { fleetSlug: 'original-fleet' }),
        sweepSessionInterruptions(ctx),
      ]);
      expect(fleet.protectedOwnerIds).toEqual([owner]);
      expect(m.launch).toHaveBeenCalledTimes(1);
      expect(await receipt()).toMatchObject({ attempts: 1, state: 'restored' });
      const foreign = await sweepSessionInterruptions(ctx, false, { fleetSlug: 'foreign-fleet' });
      expect(foreign.protectedOwnerIds).toEqual([]);
    } finally {
      await db.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${owner}`;
    }
  });
  it('allows only one of three concurrent writers to consume the final attempt', async () => {
    await reserveFixture(2);
    m.launch.mockResolvedValue({ isError: true });
    await Promise.all(Array.from({ length: 3 }, () => sweepSessionInterruptions(ctx)));
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(await receipt()).toMatchObject({ attempts: 3, state: 'blocked' });
    await Promise.all(Array.from({ length: 3 }, () => sweepSessionInterruptions(ctx)));
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
  });
  it('does not let a delayed earlier launcher finish a later reservation', async () => {
    let release!: (value: any) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    m.launch.mockImplementationOnce(() => {
      started(); return new Promise(resolve => { release = resolve; });
    }).mockResolvedValue({ isError: true });
    const first = sweepSessionInterruptions(ctx);
    await entered;
    const firstLease = (await receipt()).leaseKey;
    try {
      await db.adminSql`UPDATE harness_shared.session_briefs SET control_state =
        jsonb_set(control_state, '{lifecycle,interruption,nextAttemptAt}', '0'::jsonb)
        WHERE owner_id = ${owner}`;
      await sweepSessionInterruptions(ctx);
      const second = await receipt();
      expect(second).toMatchObject({ attempts: 2, state: 'pending' });
      expect(second.leaseKey).not.toBe(firstLease);
      release({ data: { launch: { resumeVerified: true } } });
      await first;
      expect(await receipt()).toEqual(second);
    } finally {
      release({ isError: true }); await first;
    }
  });
  it('durably holds an expired final reservation whose native outcome is uncertain', async () => {
    await reserveFixture(3, 'recovering');
    await sweepSessionInterruptions(ctx);
    expect(m.launch).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ attempts: 3, state: 'blocked',
      reason: 'expired-final-reservation-uncertain', leaseKey: null });
    await sweepSessionInterruptions(ctx);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it.each(['stop', 'retirement', 'completion'])('revalidates durable %s after reservation', async kind => {
    let nativeCreations = 0;
    m.launch.mockImplementation(async args => {
      if (kind === 'retirement') {
        await db.adminSql`UPDATE harness_shared.adv_sessions SET retired_at = now()
          WHERE coord_owner_id = ${owner}`;
      } else {
        const field = kind === 'stop' ? 'ownerStopRequested' : 'phase';
        const value = kind === 'stop' ? 'true' : '"settled"';
        await db.adminSql`UPDATE harness_shared.psu_pty_host_events SET payload =
          jsonb_set(payload, ${['execution', field]}::text[], ${value}::jsonb)
          WHERE owner_id = ${owner}`;
      }
      await args[Symbol.for('integration-interruption')].beforeNativeCreate();
      nativeCreations += 1;
      return { data: { launch: { resumeVerified: true } } };
    });
    const result = await sweepSessionInterruptions(ctx);
    expect(nativeCreations).toBe(0);
    expect(result.restored).toEqual([]);
    expect(await receipt()).toMatchObject({ attempts: 1, state: 'pending' });
  });
  it('arbitrates concurrent and repeated recoveries through one durable lifecycle receipt', async () => {
    await Promise.all([sweepSessionInterruptions(ctx), sweepSessionInterruptions(ctx)]);
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(await receipt()).toMatchObject({ attempts: 1, state: 'restored', leaseKey: null });
  });
  it('persists a bounded failure budget across separate sweeps', async () => {
    m.launch.mockResolvedValue({ isError: true });
    for (let i = 0; i < 4; i++) {
      await sweepSessionInterruptions(ctx);
      await db.adminSql`UPDATE harness_shared.session_briefs SET control_state =
        jsonb_set(control_state, '{lifecycle,interruption,nextAttemptAt}', '0'::jsonb) WHERE owner_id = ${owner}`;
    }
    expect(m.launch).toHaveBeenCalledTimes(3);
    expect(await receipt()).toMatchObject({ attempts: 3, state: 'blocked' });
  });
  it('reads only policy=wake awaits and restores them without a work prompt', async () => {
    await db.adminSql`INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy)
      VALUES (${ws}, ${owner}, 'dependency:ready', 'wake')`;
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(m.launch.mock.calls[0][0]).not.toHaveProperty('brief');
  });
  it('does not resume a retired incarnation', async () => {
    await db.adminSql`UPDATE harness_shared.adv_sessions SET retired_at = now() WHERE coord_owner_id = ${owner}`;
    await sweepSessionInterruptions(ctx);
    expect(m.launch).not.toHaveBeenCalled(); expect(await receipt()).toBeUndefined();
  });
});
