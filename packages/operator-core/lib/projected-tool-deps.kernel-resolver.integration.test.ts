import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const connection = vi.hoisted(() => ({ sql: null as unknown }));

// Keep the import graph intact. Only bind the reader to the private test DB;
// its authority query and PostgreSQL errors are the production implementations.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

import { controlAnchorKernelResolver } from './projected-tool-deps';
import { getServingHostIdentity } from './serving-host-identity';

describe('authority SQL lock failures (real PostgreSQL, EI-25380637492003672)', () => {
  let db: FreshPgDb;
  let reader: postgres.Sql;
  let blocker: postgres.Sql;
  const request: KernelEnforcementRequest = {
    phase: 'enforce',
    boundary: 'dispatch',
    toolName: 'plans:set-status',
    capabilities: ['plans:write'],
    args: { slug: 'private-lock-regression' },
    ctx: {
      workspaceId: 'private-authority-lock-workspace',
      isSuperuser: true,
      uiClientId: 'private-authority-lock-owner',
    } as KernelEnforcementRequest['ctx'],
  };

  beforeAll(async () => {
    db = await createFreshPgDb('authority_lock');
    // Minimal read-only projections of the two authority relations. No shared
    // operator data or locks are involved; createFreshPgDb owns DB cleanup.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.session_briefs (
        owner_id text, workspace_id text, control_state jsonb, control_generation bigint
      );
      CREATE TABLE harness_shared.adv_sessions (
        id bigint PRIMARY KEY, coord_owner_id text, workspace_id text,
        launch_spec jsonb, started_at timestamptz, ended_at timestamptz, ended_by text
      );
    `);
    reader = postgres(db.url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { lock_timeout: 200, statement_timeout: 2000 },
    });
    blocker = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    connection.sql = reader;
  }, 120_000);

  afterAll(async () => {
    connection.sql = null;
    await reader?.end({ timeout: 5 });
    await blocker?.end({ timeout: 5 });
    await db?.cleanup();
  });

  it.each(['session_briefs', 'adv_sessions'])(
    'distinguishes a locked %s from a successfully read absent legacy row',
    async (table) => {
      await expect(controlAnchorKernelResolver(request)).resolves.toMatchObject({
        decision: 'allow', availability: 'unavailable',
      });

      let acquired!: () => void;
      let acquisitionFailed!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        acquired = resolve;
        acquisitionFailed = reject;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const held = blocker.begin(async (sql) => {
        await sql.unsafe(`LOCK TABLE harness_shared.${table} IN ACCESS EXCLUSIVE MODE`);
        acquired();
        await released;
      });
      void held.catch(acquisitionFailed);

      try {
        await ready;
        const verdict = await controlAnchorKernelResolver(request);
        expect(verdict).toMatchObject({
          decision: 'deny', availability: 'available', code: 'policy-unavailable',
          serverAudit: {
            authorityUnavailableSources: ['control-anchor-query-failed'],
            authorityReadFailures: [{
              source: 'control-anchor-query-failed', pgCode: '55P03', elapsedMs: expect.any(Number),
              servingPid: process.pid, servingProcessId: getServingHostIdentity().processId,
            }],
          },
        });
        const failures = verdict?.serverAudit?.authorityReadFailures as Array<Record<string, unknown>>;
        expect(failures).toHaveLength(1);
        expect(Object.keys(failures[0]).sort()).toEqual(['elapsedMs', 'pgCode', 'servingPid', 'servingProcessId', 'source']);
        expect(failures[0].elapsedMs).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(verdict?.serverAudit)).not.toMatch(/private-authority|SELECT|LOCK TABLE/);
      } finally {
        release();
        await held;
      }

      await expect(controlAnchorKernelResolver(request)).resolves.toMatchObject({
        decision: 'allow', availability: 'unavailable',
      });
    },
  );
});
