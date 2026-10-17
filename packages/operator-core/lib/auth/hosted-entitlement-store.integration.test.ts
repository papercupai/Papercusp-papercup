/** P-537: actual ledger persistence, role isolation and concurrent revisions. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  backfillHostedTrialEntitlementAuthority, readHostedEntitlementAuthority, writeHostedEntitlementAuthority,
  type HostedEntitlementAuthorityRecords, type HostedTrialEntitlementPolicy,
} from './hosted-entitlement-store';

const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url));
const migrationSql = readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8');
const now = new Date('2026-10-16T08:00:00Z');

describe('hosted entitlement authority (real PG + hosted roles)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(migrationSql);
    await db.adminSql.unsafe(migrationSql);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  const service = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => db.appSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
  const read = (org: string, at = now) => db.appSql.begin(tx =>
    readHostedEntitlementAuthority(tx as unknown as Sql, org, at));
  async function grant() {
    const organizationId = randomUUID();
    const userId = randomUUID();
    await service(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
        VALUES (${organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')`;
    });
    return { organizationId, userId, kind: 'hosted-free', expectedRevision: 0 };
  }
  function authority(organizationId: string, agents = 50): HostedEntitlementAuthorityRecords {
    const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:trial-policy' },
      auditReceiptId: 'audit:trial-policy-v1', effectiveFrom: '2026-10-01T00:00:00Z', effectiveUntil: '2026-11-01T00:00:00Z' };
    return { schemaVersion: 1,
      bundles: [{ schemaVersion: 1, bundleId: 'trial-v1', bundleVersion: 1, record,
        entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
          browserAccess: { pty: true, files: true }, supportTier: 'trial',
          quotas: { 'pool.agents': agents, 'pool.db-gib': 256 }, budgets: {}, rolloutFlags: {} } }],
      assignments: [{ schemaVersion: 1, assignmentId: `trial:${organizationId}`, organizationId,
        bundleId: 'trial-v1', bundleVersion: 1,
        record: { ...record, auditReceiptId: 'audit:trial-assignment-v1' } }], overrides: [] };
  }
  function trialPolicy(): HostedTrialEntitlementPolicy {
    const bundle = structuredClone(authority(randomUUID()).bundles[0]) as any;
    bundle.record.source = 'trial';
    Object.assign(bundle.entitlements.quotas, { 'pool.hosts': 1, 'pool.cpu-millicores': 4000,
      'pool.memory-mib': 16384, 'pool.workspace-gib': 100 });
    bundle.entitlements.budgets['pool.cost.usd.minor'] = 10000;
    return { bundle, assignmentDurationMs: 86_400_000 };
  }
  async function legacyGrant(createdAt: Date) {
    const g = await grant();
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET created_at = ${createdAt}
      WHERE organization_id = ${g.organizationId}::uuid`;
    return g;
  }
  it('backfills a legacy trial once under contention using the original grant clock', async () => {
    const createdAt = new Date('2026-10-15T20:00:00Z');
    const g = await legacyGrant(createdAt);
    const policy = trialPolicy();
    const results = await Promise.all([0, 1].map(() => service(tx =>
      backfillHostedTrialEntitlementAuthority(tx, { organizationId: g.organizationId, policy }))));
    expect(results.sort()).toEqual(['ineligible', 'initialized']);
    expect(await read(g.organizationId)).toMatchObject({ ok: true, authorityRevision: 1,
      resolution: { quotas: { 'pool.agents': 50 } } });
    const [stored] = await db.adminSql`SELECT authority, authority_revision, created_at
      FROM papercusp_auth.hosted_entitlements WHERE organization_id = ${g.organizationId}::uuid`;
    expect(new Date(stored.created_at)).toEqual(createdAt);
    expect(stored.authority.assignments[0].record).toMatchObject({
      effectiveFrom: createdAt.toISOString(), effectiveUntil: '2026-10-16T20:00:00.000Z',
      auditReceiptId: `trial-backfill:${g.organizationId}` });
    policy.assignmentDurationMs *= 10;
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: g.organizationId, policy })))
      .toBe('ineligible');
    expect(await read(g.organizationId, new Date('2026-10-16T20:00:00Z')))
      .toEqual({ ok: false, reason: 'no_active_assignment' });
    const [replayed] = await db.adminSql`SELECT authority, authority_revision
      FROM papercusp_auth.hosted_entitlements WHERE organization_id = ${g.organizationId}::uuid`;
    expect(replayed).toEqual({ authority: stored.authority, authority_revision: stored.authority_revision });
  });
  it('records already-expired original trials without renewal and preserves revocation or paid authority', async () => {
    const g = await legacyGrant(new Date('2026-10-12T00:00:00Z'));
    const policy = trialPolicy();
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: g.organizationId, policy })))
      .toBe('initialized');
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'no_active_assignment' });
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: null }, service);
    policy.assignmentDurationMs *= 100;
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: g.organizationId, policy })))
      .toBe('ineligible');
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'authority_missing' });
    const paid = await grant();
    await writeHostedEntitlementAuthority({ ...paid, authority: authority(paid.organizationId, 100) }, service);
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: paid.organizationId, policy })))
      .toBe('ineligible');
    expect(await read(paid.organizationId)).toMatchObject({ ok: true, authorityRevision: 1,
      resolution: { quotas: { 'pool.agents': 100 } } });
  });
  it('does not backfill a missing, ambiguous or non-signup grant and rolls back with its transaction', async () => {
    const policy = trialPolicy();
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: randomUUID(), policy })))
      .toBe('ineligible');
    const ambiguous = await grant();
    await service(async sql => { await sql`INSERT INTO papercusp_auth.hosted_entitlements
      (organization_id, user_id, kind, source) VALUES
      (${ambiguous.organizationId}::uuid, ${randomUUID()}::uuid, 'hosted-free', 'self_signup')`; });
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: ambiguous.organizationId, policy })))
      .toBe('ineligible');
    const other = await grant();
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET source = 'billing'
      WHERE organization_id = ${other.organizationId}::uuid`;
    expect(await service(tx => backfillHostedTrialEntitlementAuthority(tx, { organizationId: other.organizationId, policy })))
      .toBe('ineligible');
    const rollback = await legacyGrant(new Date('2026-10-15T20:00:00Z'));
    await expect(service(async tx => {
      expect(await backfillHostedTrialEntitlementAuthority(tx, { organizationId: rollback.organizationId, policy }))
        .toBe('initialized');
      throw new Error('injected_backfill_rollback');
    })).rejects.toThrow('injected_backfill_rollback');
    expect(await read(rollback.organizationId)).toEqual({ ok: false, reason: 'authority_missing' });
  });
  it('keeps legacy labels allowance-free and stores versioned authority on the existing grant', async () => {
    const g = await grant();
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'authority_missing' });
    expect(await writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId) }, service)).toBe(1);
    expect(await read(g.organizationId)).toMatchObject({ ok: true, authorityRevision: 1, grantUserId: g.userId,
      resolution: { organizationId: g.organizationId, bundleVersion: 1,
        quotas: { 'pool.agents': 50, 'pool.db-gib': 256 },
        auditReceiptIds: ['audit:trial-policy-v1', 'audit:trial-assignment-v1'] } });
    expect(await read(randomUUID())).toEqual({ ok: false, reason: 'authority_missing' });
    await expect(db.appSql`SELECT authority FROM papercusp_auth.hosted_entitlements`).rejects.toMatchObject({ code: '42501' });
    await db.appSql.begin(async tx => {
      expect(await readHostedEntitlementAuthority(tx as unknown as Sql, g.organizationId, now)).toMatchObject({ ok: true });
      expect((await tx`SELECT current_user AS role`)[0].role).toBe('harness_app');
    });
  });
  it('serializes competing revisions, supports downgrade/revocation, and never creates a missing grant', async () => {
    const g = await grant();
    const writes = await Promise.allSettled([10, 20].map(agents =>
      writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId, agents) }, service)));
    expect(writes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(row => row.status === 'rejected')).toHaveLength(1);
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: authority(g.organizationId, 1) }, service);
    expect(await read(g.organizationId)).toMatchObject({ ok: true, authorityRevision: 2,
      resolution: { quotas: { 'pool.agents': 1 } } });
    expect(await read(g.organizationId, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ ok: false, reason: 'no_active_assignment' });
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 2, authority: null }, service);
    expect(await read(g.organizationId)).toMatchObject({ ok: false, reason: 'authority_missing' });
    await expect(writeHostedEntitlementAuthority({ ...g, userId: randomUUID(), authority: authority(g.organizationId) }, service))
      .rejects.toThrow('hosted_entitlement_revision_conflict');
  });
  it('refuses foreign history, malformed persisted records and ambiguous grant authorities', async () => {
    const g = await grant();
    for (const malformed of [{}, { schemaVersion: null, bundles: [], assignments: [], overrides: [] }]) {
      await expect(service(async sql => {
        await sql`UPDATE papercusp_auth.hosted_entitlements SET authority = ${JSON.stringify(malformed)}::jsonb,
          authority_revision = 1 WHERE organization_id = ${g.organizationId}::uuid`;
      })).rejects.toMatchObject({ code: '23514' });
    }
    await expect(writeHostedEntitlementAuthority({ ...g, authority: authority(randomUUID()) }, service))
      .rejects.toThrow('hosted_entitlement_assignment_invalid');
    const bad = authority(g.organizationId);
    (bad.bundles[0] as any).entitlements.quotas['pool.agents'] = -1;
    await expect(writeHostedEntitlementAuthority({ ...g, authority: bad }, service)).rejects.toThrow('hosted_entitlement_bundle_invalid');
    // A service/old-version writer can bypass the parser. Validate persisted bytes too.
    await service(async sql => { await sql`UPDATE papercusp_auth.hosted_entitlements SET authority = ${JSON.stringify(bad)}::jsonb,
      authority_revision = 1 WHERE organization_id = ${g.organizationId}::uuid`; });
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'invalid_authority_records' });
    await writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: authority(g.organizationId) }, service);
    await service(async sql => { await sql`INSERT INTO papercusp_auth.hosted_entitlements
      (organization_id, user_id, kind, source, authority, authority_revision)
      VALUES (${g.organizationId}::uuid, ${randomUUID()}::uuid, 'hosted-paid:untrusted-label', 'billing',
        ${JSON.stringify(authority(g.organizationId))}::jsonb, 1)`; });
    expect(await read(g.organizationId)).toEqual({ ok: false, reason: 'ambiguous_authority' });
  });
  it('shares the admission lock with authority writers and rolls back authority with its transaction', async () => {
    const g = await grant();
    await writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId) }, service);
    let started!: () => void;
    const writerStarted = new Promise<void>(resolve => { started = resolve; });
    let writer!: Promise<number>;
    await db.appSql.begin(async tx => {
      expect(await readHostedEntitlementAuthority(tx as unknown as Sql, g.organizationId, now)).toMatchObject({ ok: true });
      writer = writeHostedEntitlementAuthority({ ...g, expectedRevision: 1, authority: null }, async run => {
        started(); return service(run);
      });
      await writerStarted;
      const [probe] = await db.adminSql`SELECT pg_try_advisory_xact_lock(hashtextextended(
        ${`hosted-entitlement:organization:${g.organizationId}`}, 0)) AS acquired`;
      expect(probe.acquired).toBe(false);
    });
    expect(await writer).toBe(2);
    await expect(service(async tx => {
      await writeHostedEntitlementAuthority({ ...g, expectedRevision: 2, authority: authority(g.organizationId) }, async run => run(tx));
      throw new Error('injected_rollback');
    })).rejects.toThrow('injected_rollback');
    expect(await read(g.organizationId)).toMatchObject({ ok: false, reason: 'authority_missing' });
  });

  it('samples the default evaluation time after waiting for the organization authority lock', async () => {
    const g = await grant();
    await writeHostedEntitlementAuthority({ ...g, authority: authority(g.organizationId) }, service);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    let reader!: ReturnType<typeof read>;
    try {
      await db.adminSql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-entitlement:organization:${g.organizationId}`}, 0))`;
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        reader = db.appSql.begin(readTx => readHostedEntitlementAuthority(readTx as unknown as Sql, g.organizationId));
        await expect.poll(async () => {
          const [row] = await db.adminSql`SELECT EXISTS (
            SELECT 1 FROM pg_locks waiting JOIN pg_locks held
              ON held.locktype = waiting.locktype AND held.classid = waiting.classid AND held.objid = waiting.objid
             WHERE held.pid = ${pid} AND held.granted AND NOT waiting.granted) AS blocked`;
          return row.blocked;
        }).toBe(true);
        vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
      });
      expect(await reader).toEqual({ ok: false, reason: 'no_active_assignment' });
      // Explicit historical reads retain their requested timestamp.
      expect(await read(g.organizationId, now)).toMatchObject({ ok: true });
    } finally {
      await reader?.catch(() => {});
      vi.useRealTimers();
    }
  });
});
