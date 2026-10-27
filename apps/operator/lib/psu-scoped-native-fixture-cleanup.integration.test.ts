// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { trackDetached } from '@papercusp/operator-core/lib/detached-imports';
import {
  observeFallback, flushFallbackObservations, _resetFallbackObservationsForTests,
} from '@papercusp/operator-core/lib/degradation/fallback-observations';
import { cleanupScopedNativeFixtureDatabase } from '../vitest-shims/scoped-native-fixture-cleanup';
import { notifySyncInvalidate, stopInvalidationListener } from '../../../packages/operator-core/lib/sync-sse';

const routing = vi.hoisted(() => ({ getOrgPg: vi.fn() }));
vi.mock('@papercusp/db-org', async original => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: routing.getOrgPg };
});

afterEach(async () => {
  await stopInvalidationListener();
  routing.getOrgPg.mockReset();
  _resetFallbackObservationsForTests();
  vi.restoreAllMocks();
});

it('distinguishes buffered writes to an already closed handle from native startup failures', async () => {
  const sql = postgres(await getTestPg(), { max: 1 });
  await sql`SELECT 1`;
  await sql.end();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(observeFallback('scoped-native-fixture', { eligible: 1, applied: 0, reason: 'closed-handle-control' }, { sql })).toBe(true);
  expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 1 });
  expect(warning).toHaveBeenCalledWith(expect.stringMatching(/fallback-observations.*write failed.*CONNECTION_ENDED/));
});

it('persists tracked late observations before the fixture closes its database', async () => {
  const db = await createOrgTestDb();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const workspaceId = 'scoped-native-fixture-cleanup';
  let releaseWriter!: () => void;
  let persisted = false;
  let closed = false;
  const writer = new Promise<void>(resolve => {
    releaseWriter = () => {
      observeFallback('scoped-native-fixture', { eligible: 1, applied: 0, reason: 'tracked-before-close' },
        { sql: db.adminSql, workspaceId });
      resolve();
    };
  });
  trackDetached(writer);
  const cleanup = cleanupScopedNativeFixtureDatabase({ adminSql: db.adminSql, cleanup: async () => {
    try {
      const rows = await db.adminSql`SELECT reason FROM harness_shared.fallback_observations
        WHERE workspace_id = ${workspaceId}`;
      persisted = rows.length === 1 && rows[0]?.reason === 'tracked-before-close';
    } finally { await db.cleanup(); closed = true; }
  } });
  try {
    // Leave the tracked writer pending across an event-loop turn. The old
    // close-first path would retire its SQL handle before it can enqueue IO.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally { releaseWriter(); }
  expect(await cleanup).toMatchObject({ written: 1, failed: 0 });
  expect(persisted).toBe(true);
  expect(closed).toBe(true);
  expect(warning).not.toHaveBeenCalled();
}, 120_000);

it('flushes coalesced sync notifications before closing the fixture SQL route', async () => {
  const db = await createOrgTestDb();
  routing.getOrgPg.mockReturnValue({ sql: db.adminSql });
  const query = 'nativeFixture.teardown';
  await notifySyncInvalidate(query, undefined, undefined, { dedupeWindowMs: 60_000 });
  await notifySyncInvalidate(query, undefined, undefined, { dedupeWindowMs: 60_000 });
  expect(routing.getOrgPg).toHaveBeenCalledTimes(1);
  let callsBeforeClose = 0;
  await cleanupScopedNativeFixtureDatabase({ adminSql: db.adminSql, cleanup: async () => {
    callsBeforeClose = routing.getOrgPg.mock.calls.length;
    await db.cleanup();
    routing.getOrgPg.mockImplementation(() => { throw new Error('Fixture SQL route already closed'); });
  } });
  // The second notification is held by the bus, not a detached promise. A
  // close-first cleanup leaves it scheduled against the next test's SQL route.
  expect(callsBeforeClose).toBe(2);
  expect(routing.getOrgPg).toHaveBeenCalledTimes(2);
}, 120_000);
