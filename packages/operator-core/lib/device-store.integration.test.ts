/**
 * device-store.integration.test.ts — the paired-mobile-device + push-token store
 * against REAL Postgres (testcontainer), exercising REAL RLS.
 *
 * harness_shared.connected_apps (kind='mobile' rows; migration 1244 generalized
 * the old mobile_devices table) / mobile_push_tokens are RLS-enabled with a
 * `workspace_id = current_setting('app.workspace_id')` policy. The store's
 * workspace-scoped functions go through `withWorkspace(ws, cb)` (RLS-subject
 * harness_app role + the GUC), while the desktop-facing helpers (isRevoked,
 * listAllDevices, revokeDeviceById) go through `getOrgPg().sql` (harness_admin,
 * RLS-bypass). So:
 *   - withWorkspace is mocked to run its callback inside an appSql transaction
 *     that sets the GUC — the canonical RLS pattern from test/_org-test-db.ts.
 *     This means listDevices/pushTargetsForWorkspace isolation is enforced by
 *     REAL policies, not by a WHERE clause the store doesn't even write.
 *   - getOrgPg().sql is mocked to the admin (RLS-bypass) client.
 *
 * Each test uses fresh device ids / workspace ids so cases don't collide.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  // RLS-subject path: open a tx on the harness_app client, set the workspace
  // GUC (local to the tx), then run the store's callback against it.
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
  // RLS-bypass path used by isRevoked / listAllDevices / revokeDeviceById.
  getOrgPg: () => ({ sql: h.adminSql }),
}));

const {
  insertDevice,
  listDevices,
  touchLastSeen,
  revokeDevice,
  isRevoked,
  listAllDevices,
  revokeDeviceById,
  upsertPushToken,
  pushTargetsForWorkspace,
  findDeviceIdByNoisePublicKey,
  getDeviceNoisePublicKey,
  deviceAgentSessionsAllowed,
  setDeviceAgentSessionsEnabled,
  setDevicePaused,
} = await import('./device-store');
const { createOrgTestDb } = await import('../test/_org-test-db');

let n = 0;
const freshWs = () => `dev_ws_${++n}_${randomBytes(2).toString('hex')}`;
const freshDevice = () => `device_${++n}_${randomBytes(3).toString('hex')}`;

describe('device-store (real PG + real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
    // EI-21863578695350444: 120s local floor, but honor the gate's higher
    // VITEST_INTEGRATION_HOOK_TIMEOUT_MS (see vitest-config.ts + green-checkpoint.ts)
    // when the schema-template cache is cold under fleet contention — see those
    // comments for the measured mechanism (this was NOT a bug in this fixture).
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('inserts a device and reads it back within its workspace', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws, deviceLabel: 'iPhone' });
    const rows = await listDevices(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      device_id: id,
      user_email: 'a@example.com',
      workspace_id: ws,
      device_kind: 'mobile',
      device_label: 'iPhone',
      revoked_at: null,
    });
    expect(rows[0].paired_at).toBeInstanceOf(Date);
  });

  it('session grants require an explicit grant and remain isolated by device/workspace through real RLS', async () => {
    const ws = freshWs();
    const otherWs = freshWs();
    const id = freshDevice();
    const second = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws });
    await insertDevice({ deviceId: second, userEmail: 'a@example.com', workspaceId: ws });
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(false);
    expect(await setDeviceAgentSessionsEnabled(id, otherWs, true)).toBe(false);
    expect(await setDeviceAgentSessionsEnabled(id, ws, true)).toBe(true);
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(true);
    expect(await deviceAgentSessionsAllowed(id, otherWs)).toBe(false);
    expect(await deviceAgentSessionsAllowed(second, ws)).toBe(false);
    await setDevicePaused(ws, id, true);
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(false);
    await setDevicePaused(ws, id, false);
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(true);
    await revokeDevice(id, ws);
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(false);
    expect(await setDeviceAgentSessionsEnabled(id, ws, true)).toBe(false);
  });

  it('session grant changes are idempotent and preserve unrelated connected-app scopes', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws });
    const scopes = { capabilities: ['device:read'], harnesses: ['project'], tools: ['safe:read'] };
    await db.adminSql`UPDATE harness_shared.connected_apps SET scopes = ${JSON.stringify(scopes)}::jsonb WHERE id = ${id}`;
    await setDeviceAgentSessionsEnabled(id, ws, true);
    await setDeviceAgentSessionsEnabled(id, ws, true);
    const granted = await db.adminSql<{ scopes: Record<string, unknown> }[]>`SELECT scopes FROM harness_shared.connected_apps WHERE id = ${id}`;
    expect(granted[0].scopes).toEqual({ ...scopes, capabilities: ['device:read', 'agent-sessions'] });
    await setDeviceAgentSessionsEnabled(id, ws, false);
    const revoked = await db.adminSql<{ scopes: Record<string, unknown> }[]>`SELECT scopes FROM harness_shared.connected_apps WHERE id = ${id}`;
    expect(revoked[0].scopes).toEqual(scopes);
    expect(await deviceAgentSessionsAllowed(id, ws)).toBe(false);
  });

  it('insertDevice ON CONFLICT (device_id) DO NOTHING — the first label wins', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws, deviceLabel: 'first' });
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws, deviceLabel: 'second' });
    const rows = await listDevices(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0].device_label).toBe('first');
  });

  it('RLS isolates devices by workspace — another workspace can\'t see them', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    await insertDevice({ deviceId: freshDevice(), userEmail: 'a@example.com', workspaceId: wsA });
    await insertDevice({ deviceId: freshDevice(), userEmail: 'b@example.com', workspaceId: wsB });
    expect(await listDevices(wsA)).toHaveLength(1);
    expect(await listDevices(wsB)).toHaveLength(1);
    // A third, empty workspace sees nothing.
    expect(await listDevices(freshWs())).toHaveLength(0);
  });

  it('listDevices is newest-first by paired_at and excludes revoked devices', async () => {
    const ws = freshWs();
    const older = freshDevice();
    const newer = freshDevice();
    await insertDevice({ deviceId: older, userEmail: 'a@example.com', workspaceId: ws });
    await new Promise((r) => setTimeout(r, 25)); // distinct paired_at (now())
    await insertDevice({ deviceId: newer, userEmail: 'a@example.com', workspaceId: ws });
    let rows = await listDevices(ws);
    expect(rows.map((r) => r.device_id)).toEqual([newer, older]);

    await revokeDevice(older, ws);
    rows = await listDevices(ws);
    expect(rows.map((r) => r.device_id)).toEqual([newer]);
  });

  it('touchLastSeen updates last_seen from null to a timestamp', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws });
    expect((await listDevices(ws))[0].last_seen).toBeNull();
    await touchLastSeen(id, ws);
    expect((await listDevices(ws))[0].last_seen).toBeInstanceOf(Date);
  });

  it('isRevoked: false for a live device, true after revoke, true for an unknown device', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws });
    expect(await isRevoked(id)).toBe(false);
    await revokeDevice(id, ws);
    expect(await isRevoked(id)).toBe(true);
    // Unknown device → treated as revoked (fail-closed).
    expect(await isRevoked(`unknown_${randomBytes(4).toString('hex')}`)).toBe(true);
  });

  it('revokeDeviceById (admin, no workspace ctx) revokes across workspaces and listAllDevices spans them', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    const idA = freshDevice();
    const idB = freshDevice();
    await insertDevice({ deviceId: idA, userEmail: 'a@example.com', workspaceId: wsA, deviceLabel: 'A' });
    await insertDevice({ deviceId: idB, userEmail: 'b@example.com', workspaceId: wsB, deviceLabel: 'B' });

    // listAllDevices (admin, RLS-bypass) sees both devices regardless of ws.
    const all = await listAllDevices();
    const ids = new Set(all.map((d) => d.device_id));
    expect(ids.has(idA)).toBe(true);
    expect(ids.has(idB)).toBe(true);

    await revokeDeviceById(idA);
    expect(await isRevoked(idA)).toBe(true);
    // The workspace-scoped list now excludes it.
    expect(await listDevices(wsA)).toHaveLength(0);
    // listAllDevices excludes revoked too.
    expect(new Set((await listAllDevices()).map((d) => d.device_id)).has(idA)).toBe(false);
  });

  it('upsertPushToken inserts then ON CONFLICT (device_id, platform) overwrites the token', async () => {
    const ws = freshWs();
    const id = freshDevice();
    await insertDevice({ deviceId: id, userEmail: 'a@example.com', workspaceId: ws });
    await upsertPushToken({ deviceId: id, workspaceId: ws, platform: 'apns', token: 'tok-1' });
    let targets = await pushTargetsForWorkspace(ws);
    expect(targets).toEqual([{ platform: 'apns', token: 'tok-1' }]);

    // Re-register with a new token for the same (device, platform) → upsert.
    await upsertPushToken({ deviceId: id, workspaceId: ws, platform: 'apns', token: 'tok-2' });
    targets = await pushTargetsForWorkspace(ws);
    expect(targets).toEqual([{ platform: 'apns', token: 'tok-2' }]);

    // A second platform for the same device coexists.
    await upsertPushToken({ deviceId: id, workspaceId: ws, platform: 'fcm', token: 'fcm-1' });
    targets = await pushTargetsForWorkspace(ws);
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((t) => t.platform))).toEqual(new Set(['apns', 'fcm']));
  });

  it('pushTargetsForWorkspace excludes tokens of revoked devices and is workspace-scoped', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    const idA = freshDevice();
    const idB = freshDevice();
    await insertDevice({ deviceId: idA, userEmail: 'a@example.com', workspaceId: wsA });
    await insertDevice({ deviceId: idB, userEmail: 'b@example.com', workspaceId: wsB });
    await upsertPushToken({ deviceId: idA, workspaceId: wsA, platform: 'apns', token: 'a-tok' });
    await upsertPushToken({ deviceId: idB, workspaceId: wsB, platform: 'apns', token: 'b-tok' });

    // wsA only sees its own token (RLS on the JOINed connected_apps).
    expect(await pushTargetsForWorkspace(wsA)).toEqual([{ platform: 'apns', token: 'a-tok' }]);

    // Revoking device A drops its token from the targets (JOIN ... WHERE revoked_at IS NULL).
    await revokeDevice(idA, wsA);
    expect(await pushTargetsForWorkspace(wsA)).toHaveLength(0);
  });
  it('session pushes require the grant and exclude paused, revoked and foreign devices', async () => {
    const ws = freshWs(); const foreign = freshWs();
    const allowed = freshDevice(); const absent = freshDevice(); const paused = freshDevice(); const revoked = freshDevice(); const other = freshDevice();
    for (const [id, workspaceId] of [[allowed, ws], [absent, ws], [paused, ws], [revoked, ws], [other, foreign]]) {
      await insertDevice({ deviceId: id, workspaceId, userEmail: 'owner@example.com' });
      await upsertPushToken({ deviceId: id, workspaceId, platform: 'fcm', token: `token-${id}` });
      if (id !== absent) await setDeviceAgentSessionsEnabled(id, workspaceId, true);
    }
    await setDevicePaused(ws, paused, true); await revokeDevice(revoked, ws);
    expect(await pushTargetsForWorkspace(ws, 'agent-sessions')).toEqual([{ platform: 'fcm', token: `token-${allowed}` }]);
    await setDeviceAgentSessionsEnabled(allowed, ws, false);
    expect(await pushTargetsForWorkspace(ws, 'agent-sessions')).toEqual([]);
  });

  // D-013 #6: a sealed cloud channel identifies the phone by its Noise static key.
  it('findDeviceIdByNoisePublicKey: resolves one live device, fails closed on unknown, revoked, shared or foreign keys', async () => {
    const ws = freshWs();
    const other = freshWs();
    const key = () => randomBytes(32).toString('base64');
    const keyA = key();
    const idA = freshDevice();
    await insertDevice({ deviceId: idA, userEmail: 'a@example.com', workspaceId: ws, noisePublicKey: keyA });
    expect(await findDeviceIdByNoisePublicKey(ws, keyA)).toBe(idA);
    expect(await getDeviceNoisePublicKey(idA, ws)).toBe(keyA);

    expect(await findDeviceIdByNoisePublicKey(ws, key())).toBeNull();
    expect(await findDeviceIdByNoisePublicKey(ws, '')).toBeNull();
    // Another workspace never resolves this workspace's phone.
    expect(await findDeviceIdByNoisePublicKey(other, keyA)).toBeNull();

    // Two live devices sharing one key: ambiguous, so neither authenticates.
    const shared = key();
    const idB = freshDevice();
    const idC = freshDevice();
    await insertDevice({ deviceId: idB, userEmail: 'b@example.com', workspaceId: ws, noisePublicKey: shared });
    await insertDevice({ deviceId: idC, userEmail: 'c@example.com', workspaceId: ws, noisePublicKey: shared });
    expect(await findDeviceIdByNoisePublicKey(ws, shared)).toBeNull();
    // Revoking one leaves the other as the single live holder.
    await revokeDevice(idC, ws);
    expect(await findDeviceIdByNoisePublicKey(ws, shared)).toBe(idB);

    await revokeDevice(idA, ws);
    expect(await findDeviceIdByNoisePublicKey(ws, keyA)).toBeNull();
    expect(await getDeviceNoisePublicKey(idA, ws)).toBeNull();
  });
});
