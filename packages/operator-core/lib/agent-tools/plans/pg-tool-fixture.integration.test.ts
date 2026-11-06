import { expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_BRIDGE_COALESCE_WINDOW_MS } from '@papercusp/sync/server';
import { notifySyncInvalidate } from '../../sync-sse';
import { setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const failedProbe = vi.hoisted(() => ({ error: undefined as Error | undefined, dsn: '' }));
vi.mock('@papercusp/test-config/pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/test-config/pg')>();
  return {
    ...original,
    assertPgReachable: (...args: Parameters<typeof original.assertPgReachable>) => {
      if (failedProbe.error) {
        failedProbe.dsn = args[0];
        return Promise.reject(failedProbe.error);
      }
      return original.assertPgReachable(...args);
    },
  };
});

// EI-28009223489415143: exercise readiness, real tool routing and teardown as
// one lifecycle. A created clone alone does not prove a new client can use it.
it('opens an isolated plan database and removes it after all fixture clients close', async () => {
  const server = postgres(await getTestPg(), { max: 1, onnotice: () => {} });
  let fixture: PlanPgFixture | undefined;
  try {
    fixture = await setupPlanPgFixture({ isolated: true });
    const [row] = await fixture.admin<{ name: string; role: string }[]>`
      SELECT current_database() AS name, current_user AS role
    `;
    expect(row?.name).toMatch(/^org_[a-f0-9]+$/);
    expect(row?.role).toBe('harness_admin');
    const name = row!.name;
    const [routed] = await getOrgPg().sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(routed?.name).toBe(name);
    await fixture.dispose();
    fixture = undefined;
    const [remaining] = await server<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS present
    `;
    expect(remaining?.present).toBe(false);
  } finally {
    try { await fixture?.dispose(); }
    finally { await server.end({ timeout: 5 }); }
  }
}, 120_000);

it('drains trailing sync invalidations before restoring ambient database URLs', async () => {
  let fixture: PlanPgFixture | undefined;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fixture = await setupPlanPgFixture({ isolated: true });
    await notifySyncInvalidate('planFixture.disposeProbe');
    await notifySyncInvalidate('planFixture.disposeProbe'); // held for the trailing publish
    await fixture.dispose();
    fixture = undefined;

    // The old timer must not resolve getOrgPg() after the fixture restores the
    // captured live URL. Its guard refusal used to surface as a sync-sse error.
    await new Promise(resolve => setTimeout(resolve, DEFAULT_BRIDGE_COALESCE_WINDOW_MS + 50));
    expect(error).not.toHaveBeenCalledWith('[sync-sse] notify failed:', expect.anything());
  } finally {
    await fixture?.dispose();
    error.mockRestore();
  }
}, 120_000);

it('removes the real private clone when readiness fails before process routing changes', async () => {
  const server = postgres(await getTestPg(), { max: 1, onnotice: () => {} });
  const appUrl = process.env.HARNESS_DATABASE_URL;
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  const failure = new Error('controlled private fixture readiness failure');
  failedProbe.error = failure;
  failedProbe.dsn = '';
  try {
    await expect(setupPlanPgFixture({ isolated: true })).rejects.toBe(failure);
    expect(failedProbe.dsn).not.toBe('');
    const name = new URL(failedProbe.dsn).pathname.slice(1);
    expect(name).toMatch(/^org_[a-f0-9]+$/);
    const [remaining] = await server<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS present
    `;
    expect(remaining?.present).toBe(false);
    expect(process.env.HARNESS_DATABASE_URL).toBe(appUrl);
    expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(adminUrl);
  } finally {
    failedProbe.error = undefined;
    await server.end({ timeout: 5 });
  }
}, 120_000);
