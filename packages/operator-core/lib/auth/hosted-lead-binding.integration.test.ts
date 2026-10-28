import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { Sql } from 'postgres';
import { HostedSessionStore } from './hosted-session';
import { PostgresHostedMembershipAuthority } from './hosted-membership-authority';
import { createHostedPrincipal } from './hosted-principal';
import { PostgresHostedLeadBindingStore } from './hosted-lead-binding-postgres';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const migration = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1607-hosted-lead-binding-receipts.sql', import.meta.url), 'utf8');
  await db.adminSql.unsafe(migration);
  await db.adminSql.unsafe(migration);
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

// The hosted service runner's published Sql callback receives a transaction at
// runtime. Preserve that same boundary against the isolated PostgreSQL pool.
async function service<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return await db.adminSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as T;
}
const store = new PostgresHostedLeadBindingStore(service);
async function actor(organizationId?: string) {
  const [user] = await db.adminSql<{ id: string }[]>`INSERT INTO papercusp_auth.hosted_users DEFAULT VALUES RETURNING id`;
  if (!organizationId) {
    const [org] = await db.adminSql<{ id: string }[]>`INSERT INTO papercusp_auth.organizations (external_organization_id, display_name)
      VALUES (${randomUUID()}, 'Adapter test') RETURNING id`;
    organizationId = org!.id;
  }
  const userId = user!.id;
  await db.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'member', 'member_management')`;
  const member = await new PostgresHostedMembershipAuthority(db.adminSql).resolveActive({ userId, organizationId });
  if (!member) throw new Error('fixture membership missing');
  const session = await service(sql => new HostedSessionStore(sql).create({ userId, organizationId,
    permissionVersion: member.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000) }));
  return createHostedPrincipal({ workspaceId: 'graph-a', userId, activeOrganizationId: organizationId,
    sessionId: session.id, sessionVersion: member.permissionVersion, permissions: member.permissions });
}
function freshClaim(personRef = `PER-${randomUUID()}`) {
  return { challengeId: randomUUID(), graphWorkspaceId: 'graph-a', personRef, environment: 'production' as const,
    issuerRef: 'operator-a', issuedAt: Date.now() - 1000, expiresAt: Date.now() + 600_000 };
}

async function challenge() {
  const id = randomUUID();
  await db.adminSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    await tx`INSERT INTO papercusp_auth.hosted_lead_bindings
      (challenge_id, graph_workspace_id, person_ref, environment, issuer_ref, issued_at, expires_at)
      VALUES (${id}::uuid, 'graph-a', ${`PER-${randomUUID()}`}, 'production', 'operator-a',
        '2026-10-28T19:00:00Z', '2026-10-28T19:10:00Z')`;
  });
  return id;
}
describe('hosted lead binding durable proof', () => {
  it('persists exact issued claims and supports owner-only idempotent redemption/read/revocation', async () => {
    const principal = await actor();
    const other = await actor();
    const claim = freshClaim();
    await store.issue(claim);
    await store.issue(claim);
    await expect(store.issue({ ...claim, personRef: 'PER-conflict' })).rejects.toThrow('lead_binding_issue_conflict');
    expect(await store.redeem({ ...claim, issuerRef: 'operator-forged' }, principal)).toBeNull();
    const result = await store.redeem(claim, principal);
    expect(result).toMatchObject({ ref: `hosted-lead-binding:${claim.challengeId}`, personRef: claim.personRef,
      organizationId: principal.activeOrganizationId, userId: principal.userId });
    expect(await store.redeem(claim, principal)).toEqual(result);
    expect(await store.redeem(claim, other)).toBeNull();
    const scope = { graphWorkspaceId: claim.graphWorkspaceId, personRef: claim.personRef, environment: claim.environment };
    expect(await store.read(scope, principal)).toEqual(result);
    expect(await store.read(scope, other)).toBeNull();
    expect(await store.read({ ...scope, graphWorkspaceId: 'foreign-graph' }, principal)).toBeNull();
    expect(await store.read({ ...scope, environment: 'staging' }, principal)).toBeNull();
    expect(await store.revoke(scope, other)).toBe(false);
    expect(await store.revoke(scope, principal)).toBe(true);
    expect(await store.read(scope, principal)).toBeNull();
    expect(await store.redeem(claim, principal)).toBeNull();
  });
  it('refuses session revocation, stale authority and membership suspension on receipt reads', async () => {
    const principal = await actor();
    const claim = freshClaim();
    await store.issue(claim);
    expect(await store.redeem(claim, { ...principal, sessionVersion: principal.sessionVersion + 1 })).toBeNull();
    expect(await store.redeem(claim, principal)).not.toBeNull();
    const scope = { graphWorkspaceId: claim.graphWorkspaceId, personRef: claim.personRef, environment: claim.environment };
    await db.adminSql`UPDATE papercusp_auth.organization_memberships SET status = 'suspended', suspended_at = now()
      WHERE organization_id = ${principal.activeOrganizationId}::uuid AND user_id = ${principal.userId}::uuid`;
    expect(await store.read(scope, principal)).toBeNull();
    await db.adminSql`UPDATE papercusp_auth.organization_memberships SET status = 'active', suspended_at = NULL
      WHERE organization_id = ${principal.activeOrganizationId}::uuid AND user_id = ${principal.userId}::uuid`;
    await db.adminSql`UPDATE papercusp_auth.hosted_sessions SET revoked_at = now(), revocation_reason = 'fixture'
      WHERE id = ${principal.sessionId}`;
    expect(await store.read(scope, principal)).toBeNull();
  });
  it('refuses active user/person collisions and never invents a missing or expired challenge', async () => {
    const principal = await actor();
    const sameOrg = await actor(principal.activeOrganizationId);
    const claim = freshClaim();
    expect(await store.redeem(claim, principal)).toBeNull();
    await expect(store.issue({ ...claim, issuedAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 }))
      .rejects.toThrow('lead_binding_issue_conflict');
    await store.issue(claim);
    expect(await store.redeem(claim, principal)).not.toBeNull();
    const differentPerson = freshClaim();
    await store.issue(differentPerson);
    await expect(store.redeem(differentPerson, principal)).rejects.toMatchObject({ code: '23505' });
    const samePerson = freshClaim(claim.personRef);
    await store.issue(samePerson);
    await expect(store.redeem(samePerson, sameOrg)).rejects.toMatchObject({ code: '23505' });
  });
  it('allows service-only access and refuses changing the issued scope', async () => {
    const id = await challenge();
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_lead_bindings`).rejects.toThrow();
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET person_ref = 'PER-foreign'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
  });
  it('enforces a bounded lifetime and complete redemption identity', async () => {
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_lead_bindings
      (challenge_id, graph_workspace_id, person_ref, environment, issuer_ref, issued_at, expires_at)
      VALUES (${randomUUID()}::uuid, 'graph-a', 'PER-a', 'production', 'operator-a',
        '2026-10-28T19:00:00Z', '2026-10-28T20:00:00Z')`).rejects.toThrow();
    const id = await challenge();
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET redeemed_at = '2026-10-28T19:05:00Z'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow();
  });
  it('permits one atomic redemption and keeps identity and revocation immutable', async () => {
    const id = await challenge();
    const [user] = await db.adminSql`INSERT INTO papercusp_auth.hosted_users DEFAULT VALUES RETURNING id`;
    const [org] = await db.adminSql`INSERT INTO papercusp_auth.organizations (external_organization_id, display_name)
      VALUES (${randomUUID()}, 'Binding test') RETURNING id`;
    const redeem = () => db.adminSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return tx`UPDATE papercusp_auth.hosted_lead_bindings
        SET user_id = ${user!.id}::uuid, organization_id = ${org!.id}::uuid, redeemed_at = '2026-10-28T19:05:00Z'
        WHERE challenge_id = ${id}::uuid AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING challenge_id`;
    });
    const attempts = await Promise.all([redeem(), redeem()]);
    expect(attempts.map(rows => rows.length).sort()).toEqual([0, 1]);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET redeemed_at = '2026-10-28T19:06:00Z'
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
    await db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET revoked_at = '2026-10-28T19:07:00Z'
      WHERE challenge_id = ${id}::uuid`;
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_lead_bindings SET revoked_at = NULL
      WHERE challenge_id = ${id}::uuid`).rejects.toThrow('immutable');
  });
});
