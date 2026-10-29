import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { Sql } from 'postgres';
import { HostedSessionStore } from './hosted-session';
import { PostgresHostedMembershipAuthority } from './hosted-membership-authority';
import { createHostedPrincipal } from './hosted-principal';
import { PostgresHostedLeadBindingStore } from './hosted-lead-binding-postgres';
import { PostgresHostedLeadBindingAuthority, hostedLeadBindingIssuerRef, createPostgresHostedLeadBindingService,
  type LeadBindingAuthorityRunner } from './hosted-lead-binding-authority';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const migration = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1607-hosted-lead-binding-receipts.sql', import.meta.url), 'utf8');
  await db.adminSql.unsafe(migration);
  await db.adminSql.unsafe(migration);
  const graphRegistry = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1383-relationship-graph-datatypes.sql', import.meta.url), 'utf8');
  await db.adminSql.unsafe(graphRegistry.replaceAll('papercusp-workspace', 'graph-a'));
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

async function authorityFixture() {
  const token = randomUUID().replaceAll('-', '').repeat(2);
  const [operator] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${randomUUID()}, 'Binding operator') RETURNING id`;
  await db.adminSql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id, capabilities, expires_at)
    VALUES (${token}, ${operator!.id}::uuid, 'graph-a', ARRAY['*']::text[], clock_timestamp() + interval '1 hour')`;
  const personRef = `PER-${randomUUID()}`;
  const [sessionProof] = await db.adminSql`SELECT s.workspace_id, s.capabilities, u.is_active,
    s.expires_at > clock_timestamp() AS unexpired, encode(sha256(convert_to(s.token, 'UTF8')), 'hex') AS digest
    FROM harness_shared.user_sessions s JOIN harness_shared.users u ON u.id = s.user_id WHERE s.token = ${token}`;
  expect(sessionProof).toMatchObject({ workspace_id: 'graph-a', capabilities: ['*'], is_active: true,
    unexpired: true, digest: hostedLeadBindingIssuerRef(token).slice('operator-session:'.length) });
  await db.adminSql`INSERT INTO harness_shared.harness_features_consolidated
    (workspace_id, harness_slug, feature_id, title, item_kind, nature, payload)
    VALUES ('graph-a', 'papercusp', ${personRef}, 'Binding person', 'person', 'record', '{"canonical":true}'::jsonb)`;
  const rows = await db.adminSql`SELECT feature_id, payload, item_kind, nature FROM harness_shared.work_items
    WHERE workspace_id = 'graph-a' AND feature_id = ${personRef}`;
  expect(rows).toMatchObject([{ feature_id: personRef, item_kind: 'person', nature: 'record', payload: { canonical: true } }]);
  const guarded = await db.adminSql`SELECT feature_id FROM harness_shared.work_items
    WHERE workspace_id = 'graph-a' AND feature_id = ${personRef} AND item_kind = 'person' AND nature = 'record'
      AND payload->>'canonical' = 'true' AND NOT (payload ? 'mergedInto') AND NOT (payload ? 'retiredAt')`;
  expect(guarded, 'exact canonical subject guard').toHaveLength(1);
  const issuers = await db.adminSql`SELECT s.user_id FROM harness_shared.user_sessions s
    JOIN harness_shared.users u ON u.id = s.user_id WHERE s.workspace_id = 'graph-a'
      AND s.expires_at > clock_timestamp() AND u.is_active = true AND s.capabilities @> ARRAY['*']::text[]
      AND encode(sha256(convert_to(s.token, 'UTF8')), 'hex') = ${hostedLeadBindingIssuerRef(token).slice('operator-session:'.length)}`;
  expect(issuers, 'exact operator issuer guard').toHaveLength(1);
  const runAuthority: LeadBindingAuthorityRunner = async (_workspace, fn) =>
    await db.adminSql.begin(tx => fn(tx as unknown as Sql)) as Awaited<ReturnType<typeof fn>>;
  const authority = new PostgresHostedLeadBindingAuthority('graph-a', runAuthority);
  const binding = createPostgresHostedLeadBindingService({ graphWorkspaceId: 'graph-a', environment: 'production',
    secret: 'a'.repeat(32), runAuthority });
  const scope = { graphWorkspaceId: 'graph-a', personRef, environment: 'production' as const };
  return { token, operatorId: operator!.id, authority, binding, scope, issuerRef: hostedLeadBindingIssuerRef(token) };
}

describe('hosted binding current production authority', () => {
  it('issues and redeems against the canonical graph and current operator session in one transaction', async () => {
    const f = await authorityFixture(); const principal = await actor();
    const token = await f.binding.issue(f.scope, f.issuerRef);
    expect(token).toBeTypeOf('string'); expect(f.issuerRef).not.toContain(f.token);
    expect(await f.binding.redeem(f.scope, token, principal)).toMatchObject({ personRef: f.scope.personRef, userId: principal.userId });
    expect(await f.binding.read(f.scope, principal)).not.toBeNull();
    expect(await f.binding.revoke(f.scope, principal)).toBe(true);
  });
  it('refuses current session downgrade, expiration, inactive operator and merged canonical person', async () => {
    const f = await authorityFixture(); const principal = await actor();
    const token = await f.binding.issue(f.scope, f.issuerRef);
    await db.adminSql`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['workspace:view']::text[] WHERE token = ${f.token}`;
    expect(await f.binding.redeem(f.scope, token, principal)).toBeNull();
    await db.adminSql`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['*']::text[], expires_at = clock_timestamp() - interval '1 second' WHERE token = ${f.token}`;
    expect(await f.binding.redeem(f.scope, token, principal)).toBeNull();
    await db.adminSql`UPDATE harness_shared.user_sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE token = ${f.token}`;
    await db.adminSql`UPDATE harness_shared.users SET is_active = false WHERE id = ${f.operatorId}::uuid`;
    expect(await f.binding.redeem(f.scope, token, principal)).toBeNull();
    await db.adminSql`UPDATE harness_shared.users SET is_active = true WHERE id = ${f.operatorId}::uuid`;
    await db.adminSql`UPDATE harness_shared.harness_features_consolidated SET payload = payload || '{"mergedInto":"PER-survivor"}'::jsonb
      WHERE workspace_id = 'graph-a' AND feature_id = ${f.scope.personRef}`;
    expect(await f.binding.redeem(f.scope, token, principal)).toBeNull();
    expect(await f.binding.read(f.scope, principal)).toBeNull();
    expect(await f.binding.issue({ ...f.scope, graphWorkspaceId: 'foreign' }, f.issuerRef)).toBeNull();
  });
  it('rolls receipt persistence back when the enclosing authority callback fails', async () => {
    const f = await authorityFixture(); const claim = { ...freshClaim(f.scope.personRef), issuerRef: f.issuerRef };
    await expect(f.authority.withCurrentIssuer(f.scope, f.issuerRef, async bound => {
      if (!bound) throw new Error('missing transaction store');
      await bound.issue(claim);
      throw new Error('authority callback aborted');
    })).rejects.toThrow('authority callback aborted');
    const rows = await db.adminSql`SELECT challenge_id FROM papercusp_auth.hosted_lead_bindings WHERE challenge_id = ${claim.challengeId}::uuid`;
    expect(rows).toHaveLength(0);
  });
});

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
