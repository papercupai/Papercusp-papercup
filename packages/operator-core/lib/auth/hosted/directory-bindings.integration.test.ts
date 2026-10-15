import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { createHostedPrincipal } from '../hosted-principal';
import { HostedDirectoryBindingManager, appendOrganizationAuditEvent, type DirectoryBindingInput } from './governance';
import { PostgresWorkosLifecycleProjectionStore, type HostedServiceContextRunner } from './workos-lifecycle-postgres';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');
let db: MigratedTestDb;
let sql: Sql;
let run: HostedServiceContextRunner;
let manager: HostedDirectoryBindingManager;
let actorId: string;
let memberId: string;
let otherId: string;
let organizationId: string;
let foreignOrganizationId: string;
const input = (): DirectoryBindingInput => ({ organizationId, userId: memberId, externalOrganizationId: 'workos-org',
  directoryId: 'directory-1', directoryUserId: 'dsync-user-1', authorizedGroupIds: ['group-b', 'group-a'], purpose: 'Approved directory mapping' });
const principal = (permissions = ['members:manage']) => createHostedPrincipal({ workspaceId: 'control', userId: actorId,
  activeOrganizationId: organizationId, sessionId: 'session', sessionVersion: 1, permissions });

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'directorybindings1473' });
  sql = postgres(db.url, { max: 3, onnotice: () => {} });
  await sql.unsafe(`DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['hosted_owner','hosted_app','hosted_service','harness_admin','harness_app','harness_zero'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',r); END IF;
    END LOOP; EXECUTE format('GRANT hosted_owner, hosted_app, hosted_service, harness_admin, harness_app, harness_zero TO %I',current_user); END $$;
    CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.workspace_hosts (workspace_id text NOT NULL, id text NOT NULL, PRIMARY KEY(workspace_id,id));`);
  for (const name of ['902-hosted-session-webhook-receipts.sql', '903-customer-organization-boundary.sql',
    '904-hosted-identity-links.sql', '906-customer-workspace-directory.sql', '907-hosted-governance.sql',
    '978-hosted-customer-rls.sql', '1005-hosted-service-lifecycle-runtime.sql',
    // 1188 owns the hosted_owner SELECT/INSERT policies on organization_memberships
    // that 1496's SECURITY DEFINER provision_directory_membership relies on.
    '1188-hosted-self-signup.sql', '1473-hosted-directory-binding-audit.sql',
    '1496-hosted-directory-group-mappings.sql']) {
    const armed = path.join(SQL_DIR, name);
    await sql.unsafe(readFileSync(existsSync(armed) ? armed : `${armed}.DRAFT`, 'utf8'));
  }
  run = async (fn) => sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<never>;
  manager = new HostedDirectoryBindingManager(run);
  const posture = await sql`SELECT
    has_table_privilege('hosted_service','papercusp_auth.organization_audit_events','INSERT') AS can_append,
    has_table_privilege('hosted_service','papercusp_auth.organization_audit_events','SELECT') AS can_read,
    has_table_privilege('hosted_service','papercusp_auth.organization_audit_events','UPDATE') AS can_update,
    has_table_privilege('hosted_service','papercusp_auth.organization_audit_events','DELETE') AS can_delete`;
  expect(posture).toMatchObject([{ can_append: true, can_read: false, can_update: false, can_delete: false }]);
  // Exercise the real serializer before behavior tests; passing serialized
  // text directly as jsonb would encode a JSON string a second time.
  expect(await sql`SELECT jsonb_typeof(${JSON.stringify({ groups: ['group'] })}::jsonb) AS former,
    jsonb_typeof(${JSON.stringify({ groups: ['group'] })}::text::jsonb) AS corrected`)
    .toMatchObject([{ former: 'string', corrected: 'object' }]);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql.unsafe('TRUNCATE papercusp_auth.directory_user_observations, papercusp_auth.directory_group_role_mappings, papercusp_auth.hosted_sessions, papercusp_auth.organization_audit_events, papercusp_auth.external_identities, papercusp_auth.organization_memberships, papercusp_auth.hosted_users, papercusp_auth.organizations CASCADE');
  const users = await sql<{ id: string }[]>`INSERT INTO papercusp_auth.hosted_users(primary_email)
    VALUES ('admin@example.test'),('member@example.test'),('other@example.test') RETURNING id`;
  [actorId, memberId, otherId] = users.map((u) => u.id);
  const orgs = await sql<{ id: string }[]>`INSERT INTO papercusp_auth.organizations(identity_provider,external_organization_id,display_name)
    VALUES ('workos','workos-org','Org'),('workos','foreign-org','Foreign') RETURNING id`;
  [organizationId, foreignOrganizationId] = orgs.map((o) => o.id);
  await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
    VALUES (${organizationId}::uuid,${actorId}::uuid,'admin','active','member_management'),
      (${organizationId}::uuid,${memberId}::uuid,'member','active','member_management'),
      (${organizationId}::uuid,${otherId}::uuid,'member','active','member_management')`;
});

describe('bounded delegated membership reduction', () => {
  const reduction = (status: 'suspended' | 'revoked' = 'suspended') => ({ organizationId, userId: memberId, status, purpose: 'Approved access reduction' });
  async function role(userId: string, next: string) {
    await sql`DELETE FROM papercusp_auth.organization_memberships WHERE organization_id=${organizationId}::uuid AND user_id=${userId}::uuid`;
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${organizationId}::uuid,${userId}::uuid,${next},'active','member_management')`;
  }
  async function sessions() {
    await sql`INSERT INTO papercusp_auth.hosted_sessions(id,user_id,organization_id,upstream_provider,upstream_session_id,expires_at)
      VALUES ('target',${memberId},${organizationId},'workos','target',now()+interval '1 hour'),
        ('foreign',${memberId},${foreignOrganizationId},'workos','foreign',now()+interval '1 hour'),
        ('actor',${actorId},${organizationId},'workos','actor',now()+interval '1 hour')`;
  }
  it.each([
    ['owner', 'admin'], ['owner', 'member'], ['owner', 'billing'], ['admin', 'member'], ['admin', 'billing'],
  ])('allows %s to reduce %s with tenant-scoped session closure and audit', async (actorRole, targetRole) => {
    await role(actorId, actorRole); await role(memberId, targetRole); await sessions();
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${foreignOrganizationId}::uuid,${memberId}::uuid,'member','active','member_management')`;
    const suspended = await manager.reduceMembership(principal(), reduction());
    expect(suspended).toMatchObject({ status: 'suspended', changed: true });
    expect(await sql`SELECT role,status,suspended_at IS NOT NULL AS suspension_recorded FROM papercusp_auth.organization_memberships WHERE id=${suspended.membershipId}::uuid`)
      .toMatchObject([{ role: targetRole, status: 'suspended', suspension_recorded: true }]);
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE organization_id=${foreignOrganizationId}::uuid`)
      .toMatchObject([{ status: 'active' }]);
    expect(await sql`SELECT id,revoked_at IS NOT NULL AS revoked FROM papercusp_auth.hosted_sessions ORDER BY id`)
      .toEqual([{ id: 'actor', revoked: false }, { id: 'foreign', revoked: false }, { id: 'target', revoked: true }]);
    expect(await sql`SELECT actor_id,action,purpose,target_id,metadata FROM papercusp_auth.organization_audit_events WHERE id=${suspended.auditId}::uuid`)
      .toMatchObject([{ actor_id: actorId, action: 'membership.reduce', purpose: 'Approved access reduction', target_id: suspended.membershipId,
        metadata: { previousStatus: 'active', status: 'suspended', role: targetRole, changed: true } }]);
    expect(await manager.reduceMembership(principal(), reduction())).toMatchObject({ changed: false, status: 'suspended' });
    expect(await manager.reduceMembership(principal(), reduction('revoked'))).toMatchObject({ changed: true, status: 'revoked' });
    await expect(manager.reduceMembership(principal(), reduction())).rejects.toThrow('membership_reduction_restore_forbidden');
  });
  it.each([['admin', 'admin'], ['admin', 'owner'], ['owner', 'owner']])('refuses %s acting on %s', async (actorRole, targetRole) => {
    await role(actorId, actorRole); await role(memberId, targetRole); await sessions();
    await expect(manager.reduceMembership(principal(), reduction())).rejects.toThrow('membership_reduction_forbidden');
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'active' }]);
    expect(await sql`SELECT id FROM papercusp_auth.hosted_sessions WHERE revoked_at IS NOT NULL`).toHaveLength(0);
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });
  it.each(['member', 'billing'])('refuses stale %s actor authority', async (actorRole) => {
    await role(actorId, actorRole);
    await expect(manager.reduceMembership(principal(), reduction())).rejects.toThrow('membership_reduction_forbidden');
  });
  it.each(['suspended', 'revoked'])('refuses a %s administrator', async (status) => {
    await sql`UPDATE papercusp_auth.organization_memberships SET status=${status},
      suspended_at=CASE WHEN ${status}='suspended' THEN now() ELSE suspended_at END,
      revoked_at=CASE WHEN ${status}='revoked' THEN now() ELSE revoked_at END WHERE user_id=${actorId}::uuid`;
    await expect(manager.reduceMembership(principal(), reduction())).rejects.toThrow('membership_reduction_forbidden');
  });
  it('refuses self, foreign organization, absent target and principal without permission', async () => {
    await expect(manager.reduceMembership(principal(), { ...reduction(), userId: actorId.toUpperCase() })).rejects.toThrow('membership_reduction_forbidden');
    await expect(manager.reduceMembership(principal(), { ...reduction(), organizationId: foreignOrganizationId })).rejects.toThrow('membership_reduction_forbidden');
    await expect(manager.reduceMembership(principal(['workspace:view']), reduction())).rejects.toThrow('membership_reduction_forbidden');
    await sql`DELETE FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`;
    await expect(manager.reduceMembership(principal(), reduction())).rejects.toThrow('membership_reduction_member_not_found');
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });
  it.each([{ status: 'active' }, { purpose: '' }, { purpose: 'sk_012345678901234567890123' }, { userId: 'not-a-uuid' }])('rejects malformed or elevating input %j', async (override) => {
    await expect(manager.reduceMembership(principal(), { ...reduction(), ...override } as never)).rejects.toThrow();
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'active' }]);
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });
  it('rolls back membership and session closure together when audit insertion fails', async () => {
    await sessions();
    await sql.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
    try {
      await expect(manager.reduceMembership(principal(), reduction('revoked'))).rejects.toThrow(/permission denied/);
      expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'active' }]);
      expect(await sql`SELECT id FROM papercusp_auth.hosted_sessions WHERE revoked_at IS NOT NULL`).toHaveLength(0);
    } finally { await sql.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service'); }
  });
  it('concurrent reductions cannot restore a revoked membership', async () => {
    await sessions();
    const outcomes = await Promise.allSettled([manager.reduceMembership(principal(), reduction()), manager.reduceMembership(principal(), reduction('revoked'))]);
    expect(outcomes[1].status).toBe('fulfilled');
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'revoked' }]);
    expect(await sql`SELECT id FROM papercusp_auth.hosted_sessions WHERE id='target' AND revoked_at IS NULL`).toHaveLength(0);
  });
  it('database service authority independently refuses role elevation and restoration', async () => {
    await expect(run(async (tx) => tx`UPDATE papercusp_auth.organization_memberships SET role='owner' WHERE user_id=${memberId}::uuid`)).rejects.toThrow(/only reduce/);
    await manager.reduceMembership(principal(), reduction('revoked'));
    await expect(run(async (tx) => tx`UPDATE papercusp_auth.organization_memberships SET status='active' WHERE user_id=${memberId}::uuid`)).rejects.toThrow(/restore or elevate/);
  });
});

describe('directory group mappings and delegated provisioning (WI-10007899 / P-004)', () => {
  const DIR = 'directory-1';
  let newUserId: string;
  const mapping = (groupId: string, role: 'admin' | 'member' | 'billing') =>
    ({ organizationId, directoryId: DIR, groupId, role, purpose: 'Approved directory group mapping' });
  const unmap = (groupId: string) => ({ organizationId, directoryId: DIR, groupId, purpose: 'Retire directory group mapping' });
  const provision = (directoryUserId = 'dsync-new', userId = newUserId) =>
    ({ organizationId, userId, directoryId: DIR, directoryUserId, purpose: 'Directory provisioning' });
  const observe = (groups: string[], state = 'active', directoryUserId = 'dsync-new') =>
    sql`INSERT INTO papercusp_auth.directory_user_observations(external_organization_id,directory_id,directory_user_id,state,groups)
      VALUES ('workos-org',${DIR},${directoryUserId},${state},${groups}::text[])
      ON CONFLICT (external_organization_id,directory_id,directory_user_id) DO UPDATE SET state = EXCLUDED.state, groups = EXCLUDED.groups`;
  // A separate seeded owner: the canonical 978 trigger forbids changing local
  // role authority in place, so the owner is inserted rather than promoted.
  let ownerId: string;
  const owner = () => createHostedPrincipal({ workspaceId: 'control', userId: ownerId,
    activeOrganizationId: organizationId, sessionId: 'owner-session', sessionVersion: 1, permissions: ['members:manage'] });
  const membershipOf = async (userId: string) => (await sql<{ id: string; role: string; status: string }[]>`
    SELECT id::text, role, status FROM papercusp_auth.organization_memberships
     WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`)[0];
  const auditCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM papercusp_auth.organization_audit_events`)[0].n;

  beforeEach(async () => {
    const [row, ownerRow] = await sql<{ id: string }[]>`INSERT INTO papercusp_auth.hosted_users(primary_email)
      VALUES ('new@example.test'),('owner@example.test') RETURNING id`;
    newUserId = row.id;
    ownerId = ownerRow.id;
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${organizationId}::uuid,${ownerId}::uuid,'owner','active','member_management')`;
  });

  it('sets, changes and removes a mapping with append-only audit and no membership side effect', async () => {
    const before = await auditCount();
    const set = await manager.setGroupMapping(principal(), mapping('eng', 'member'));
    expect(set).toMatchObject({ groupId: 'eng', role: 'member', status: 'active', revokedMembershipIds: [] });
    const changed = await manager.setGroupMapping(principal(), mapping('eng', 'billing'));
    expect(changed).toMatchObject({ mappingId: set.mappingId, role: 'billing', status: 'active' });
    const removed = await manager.removeGroupMapping(principal(), unmap('eng'));
    expect(removed).toMatchObject({ mappingId: set.mappingId, status: 'removed' });
    expect(await sql`SELECT status, removed_at IS NOT NULL AS removed FROM papercusp_auth.directory_group_role_mappings`)
      .toEqual([{ status: 'removed', removed: true }]);
    expect(await auditCount()).toBe(before + 3);
    expect(await membershipOf(newUserId)).toBeUndefined();
  });

  it('only an owner may approve an admin mapping', async () => {
    await expect(manager.setGroupMapping(principal(), mapping('admins', 'admin'))).rejects.toThrow('directory_group_mapping_forbidden_role');
    await expect(manager.setGroupMapping(owner(), mapping('admins', 'admin'))).resolves.toMatchObject({ role: 'admin' });
  });

  it('provisions an observed active user with the highest-precedence mapped role', async () => {
    await manager.setGroupMapping(principal(), mapping('eng', 'member'));
    await manager.setGroupMapping(principal(), mapping('finance', 'billing'));
    await observe(['finance', 'eng', 'unmapped']);
    const result = await manager.provisionFromDirectory(principal(), provision());
    expect(result).toMatchObject({ role: 'member', mappedGroupIds: ['eng', 'finance'] });
    expect(await membershipOf(newUserId)).toEqual({ id: result.membershipId, role: 'member', status: 'active' });
  });

  it('an admin actor cannot provision an admin grant; an owner can', async () => {
    await manager.setGroupMapping(owner(), mapping('admins', 'admin'));
    await observe(['admins']);
    await expect(manager.provisionFromDirectory(principal(), provision())).rejects.toThrow('directory_provision_forbidden_role');
    expect(await membershipOf(newUserId)).toBeUndefined();
    await expect(manager.provisionFromDirectory(owner(), provision())).resolves.toMatchObject({ role: 'admin' });
  });

  it('refuses existing members, unobserved, inactive and unmapped directory users', async () => {
    await manager.setGroupMapping(principal(), mapping('eng', 'member'));
    await expect(manager.provisionFromDirectory(principal(), provision('dsync-member', memberId)))
      .rejects.toThrow('directory_provision_membership_exists');
    await expect(manager.provisionFromDirectory(principal(), provision())).rejects.toThrow('directory_provision_not_observed');
    await observe(['eng'], 'inactive');
    await expect(manager.provisionFromDirectory(principal(), provision())).rejects.toThrow('directory_provision_not_observed');
    await observe(['other'], 'active');
    await expect(manager.provisionFromDirectory(principal(), provision())).rejects.toThrow('directory_provision_no_mapped_group');
    expect(await membershipOf(newUserId)).toBeUndefined();
  });

  it('removing a mapping revokes the provisioned membership and closes its sessions', async () => {
    await manager.setGroupMapping(principal(), mapping('eng', 'member'));
    await observe(['eng']);
    const { membershipId } = await manager.provisionFromDirectory(principal(), provision());
    await sql`INSERT INTO papercusp_auth.hosted_sessions(id,user_id,organization_id,upstream_provider,upstream_session_id,expires_at)
      VALUES ('provisioned',${newUserId},${organizationId},'workos','provisioned',now()+interval '1 hour')`;
    const removed = await manager.removeGroupMapping(principal(), unmap('eng'));
    expect(removed.revokedMembershipIds).toEqual([membershipId]);
    expect((await membershipOf(newUserId))?.status).toBe('revoked');
    expect(await sql`SELECT revoked_at IS NOT NULL AS revoked, revocation_reason FROM papercusp_auth.hosted_sessions WHERE id = 'provisioned'`)
      .toEqual([{ revoked: true, revocation_reason: 'directory_group_mapping_changed' }]);
  });

  it('a downgrade revokes a now-excessive grant while an upgrade keeps it', async () => {
    await manager.setGroupMapping(owner(), mapping('eng', 'member'));
    await observe(['eng']);
    const { membershipId } = await manager.provisionFromDirectory(owner(), provision());
    const upgraded = await manager.setGroupMapping(owner(), mapping('eng', 'admin'));
    expect(upgraded.revokedMembershipIds).toEqual([]);
    expect(await membershipOf(newUserId)).toEqual({ id: membershipId, role: 'member', status: 'active' });
    const downgraded = await manager.setGroupMapping(owner(), mapping('eng', 'billing'));
    expect(downgraded.revokedMembershipIds).toEqual([membershipId]);
    expect((await membershipOf(newUserId))?.status).toBe('revoked');
  });
});

describe('audited directory binding administration', () => {
  it('exports local roles and approved bindings without foreign tenant or profile/email disclosure', async () => {
    await manager.set(principal(), input());
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${foreignOrganizationId}::uuid,${memberId}::uuid,'owner','active','member_management')`;
    await sql`INSERT INTO papercusp_auth.external_identities(hosted_user_id,provider,subject,profile)
      VALUES (${memberId}::uuid,'workos-dsync',${JSON.stringify(['foreign-org','foreign-directory','foreign-user'])},
        '{"authorized_directory_groups":["foreign-group"],"private_note":"do not export"}'::jsonb)`;
    await sql`UPDATE papercusp_auth.external_identities SET profile=profile || '{"private_note":"do not export","email":"private@example.test"}'::jsonb
      WHERE provider='workos-dsync' AND subject=${JSON.stringify(['workos-org','directory-1','dsync-user-1'])}`;
    const review = await manager.review(principal(), { organizationId, purpose: 'Quarterly access review' });
    expect(review.members).toHaveLength(3);
    expect(review.scope).toBe('local-memberships-and-directory-bindings');
    expect(review.members.find(m => m.userId === memberId)).toMatchObject({ role: 'member', membershipStatus: 'active',
      effectivePermissions: ['workspace:operate','workspace:view'], directoryBindings: [{ directoryId: 'directory-1',
        directoryUserId: 'dsync-user-1', authorizedGroupIds: ['group-a','group-b'], status: 'active' }] });
    expect(JSON.stringify(review)).not.toMatch(/foreign-|private_note|private@example|admin@example|member@example/);
    expect(await sql`SELECT actor_id,purpose,metadata FROM papercusp_auth.organization_audit_events WHERE id=${review.auditId}::uuid`)
      .toMatchObject([{ actor_id: actorId, purpose: 'Quarterly access review', metadata: { memberCount: 3, generatedAt: review.generatedAt } }]);
  });

  it.each(['member','billing'])('refuses stale administrator permission after live %s role replacement', async (role) => {
    await sql`DELETE FROM papercusp_auth.organization_memberships WHERE user_id=${actorId}::uuid`;
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${organizationId}::uuid,${actorId}::uuid,${role},'active','member_management')`;
    await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_forbidden');
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });

  it('refuses foreign, suspended administrator and permission-free requests', async () => {
    await expect(manager.review(principal(), { organizationId: foreignOrganizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_forbidden');
    await expect(manager.review(principal(['workspace:view']), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_forbidden');
    await sql`UPDATE papercusp_auth.organization_memberships SET status='suspended',suspended_at=now() WHERE user_id=${actorId}::uuid`;
    await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_forbidden');
  });

  it('reports suspended memberships and deleted users without effective permission', async () => {
    await sql`UPDATE papercusp_auth.organization_memberships SET status='suspended',suspended_at=now() WHERE user_id=${memberId}::uuid`;
    await sql`UPDATE papercusp_auth.hosted_users SET status='deleted',deleted_at=now() WHERE id=${otherId}::uuid`;
    const review = await manager.review(principal(), { organizationId, purpose: 'Review lifecycle' });
    expect(review.members.find(m => m.userId === memberId)).toMatchObject({ membershipStatus: 'suspended', effectivePermissions: [] });
    expect(review.members.find(m => m.userId === otherId)).toMatchObject({ userStatus: 'deleted', effectivePermissions: [] });
    expect(review.members.find(m => m.userId === actorId)?.effectivePermissions).toContain('members:manage');
  });

  it('fails closed on malformed directory coordinates before recording a successful export', async () => {
    await sql`INSERT INTO papercusp_auth.external_identities(hosted_user_id,provider,subject)
      VALUES (${memberId}::uuid,'workos-dsync','not-json')`;
    await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_invalid_binding');
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });

  it('refuses population overflow instead of exporting a silently truncated review', async () => {
    await sql`INSERT INTO papercusp_auth.hosted_users(primary_email)
      SELECT 'bulk-' || n || '@example.test' FROM generate_series(1,998) AS n`;
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      SELECT ${organizationId}::uuid,id,'member','active','member_management' FROM papercusp_auth.hosted_users WHERE primary_email LIKE 'bulk-%'`;
    await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_member_limit');
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });

  it('refuses directory identity overflow without a partial review', async () => {
    await sql`INSERT INTO papercusp_auth.external_identities(hosted_user_id,provider,subject)
      SELECT ${memberId}::uuid,'workos-dsync',json_build_array('workos-org','directory',n::text)::text FROM generate_series(1,101) AS n`;
    await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('directory_access_review_identity_limit');
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
  });

  it('does not return a review when the append-only audit insert fails', async () => {
    await sql.unsafe(`CREATE FUNCTION pg_temp.reject_access_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'review audit unavailable'; END $$;
      CREATE TRIGGER reject_access_review BEFORE INSERT ON papercusp_auth.organization_audit_events
      FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_access_review();`);
    try {
      await expect(manager.review(principal(), { organizationId, purpose: 'Review' })).rejects.toThrow('review audit unavailable');
      expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events`).toHaveLength(0);
    } finally { await sql.unsafe('DROP TRIGGER reject_access_review ON papercusp_auth.organization_audit_events'); }
    expect((await manager.review(principal(), { organizationId, purpose: 'Review after recovery' })).auditId).toBeTruthy();
  });
  it('sets and updates immutable references with old/new groups in append-only audit and no role change', async () => {
    const first = await manager.set(principal(), input());
    const next = await manager.set(principal(), { ...input(), authorizedGroupIds: ['group-c'] });
    expect(next.identityId).toBe(first.identityId);
    const audit = await sql`SELECT actor_id,metadata FROM papercusp_auth.organization_audit_events ORDER BY recorded_at`;
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ actor_id: actorId, metadata: { previousGroups: ['group-a', 'group-b'], authorizedGroups: ['group-c'] } });
    expect(await sql`SELECT role,status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`)
      .toMatchObject([{ role: 'member', status: 'active' }]);
    await expect(sql`UPDATE papercusp_auth.organization_audit_events SET purpose='tampered'`).rejects.toThrow(/append-only/);
  });

  it.each(['member', 'billing'])('rechecks the live %s role even with stale admin permissions', async (role) => {
    // Canonical RLS trigger forbids all service-inheriting roles from changing
    // local role authority. Seed the intended role instead of bypassing it.
    await sql`DELETE FROM papercusp_auth.organization_memberships WHERE user_id=${actorId}::uuid`;
    await sql`INSERT INTO papercusp_auth.organization_memberships(organization_id,user_id,role,status,created_via)
      VALUES (${organizationId}::uuid,${actorId}::uuid,${role},'active','member_management')`;
    await expect(manager.set(principal(), input())).rejects.toThrow('directory_binding_forbidden');
    expect(await sql`SELECT id FROM papercusp_auth.external_identities`).toHaveLength(0);
  });

  it('rejects revoked administrators and sessions without member-management permission', async () => {
    await expect(manager.set(principal(['workspace:view']), input())).rejects.toThrow('directory_binding_forbidden');
    await sql`UPDATE papercusp_auth.organization_memberships SET status='revoked',revoked_at=now() WHERE user_id=${actorId}::uuid`;
    await expect(manager.set(principal(), input())).rejects.toThrow('directory_binding_forbidden');
  });

  it('rejects foreign organization, wrong provider organization, and a user outside the organization', async () => {
    await expect(manager.set(principal(), { ...input(), organizationId: foreignOrganizationId })).rejects.toThrow('directory_binding_forbidden');
    await expect(manager.set(principal(), { ...input(), externalOrganizationId: 'foreign-org' })).rejects.toThrow('organization_mismatch');
    await sql`DELETE FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`;
    await expect(manager.set(principal(), input())).rejects.toThrow('member_not_found');
  });

  it('prevents subject reassignment, including concurrent binding attempts', async () => {
    const outcomes = await Promise.allSettled([
      manager.set(principal(), input()), manager.set(principal(), { ...input(), userId: otherId }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { message: 'directory_binding_subject_conflict' } }]);
    expect(await sql`SELECT id FROM papercusp_auth.external_identities`).toHaveLength(1);
  });

  it('removes authority without deleting history or reactivating a revoked membership', async () => {
    await manager.set(principal(), input());
    await sql`UPDATE papercusp_auth.organization_memberships SET status='revoked',revoked_at=now() WHERE user_id=${memberId}::uuid`;
    const removed = await manager.remove(principal(), input());
    expect(removed).toMatchObject({ status: 'deactivated', authorizedGroupIds: [] });
    await expect(manager.set(principal(), input())).rejects.toThrow('directory_binding_inactive');
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'revoked' }]);
  });

  it('rolls back a binding when the append-only audit cannot be written', async () => {
    await sql.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
    try {
      await expect(manager.set(principal(), input())).rejects.toThrow(/permission denied/);
      expect(await sql`SELECT id FROM papercusp_auth.external_identities`).toHaveLength(0);
    } finally { await sql.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service'); }
  });

  it('uses the transaction clock for default audit time after transaction start', async () => {
    // Same writer, same role and table: only the wall-clock default used by
    // the former implementation differs. The database constraint exposes it.
    await expect(run(async (tx) => {
      await tx`SELECT pg_sleep(0.02)`;
      return appendOrganizationAuditEvent({ organizationId, actorKind: 'customer_user', actorId,
        action: 'directory_binding.clock', purpose: 'Former wall clock control', occurredAt: new Date() }, tx);
    })).rejects.toThrow(/organization_audit_events_recorded_after_occurred_ck/);
    const id = await run(async (tx) => {
      await tx`SELECT pg_sleep(0.02)`;
      return appendOrganizationAuditEvent({ organizationId, actorKind: 'customer_user', actorId, action: 'directory_binding.clock', purpose: 'Clock regression control' }, tx);
    });
    expect(await sql`SELECT id FROM papercusp_auth.organization_audit_events WHERE id=${id}::uuid`).toHaveLength(1);
  });

  it('a removed identity no longer participates in directory revocation projection', async () => {
    await manager.set(principal(), input());
    await manager.remove(principal(), input());
    await sql`INSERT INTO papercusp_auth.webhook_event_receipts(provider,event_id,event_type,event_created_at,payload,payload_sha256,retention_until)
      VALUES ('workos','removed-binding-event','dsync.user.deleted',now(),'{}'::jsonb,${'a'.repeat(64)},now()+interval '1 day')`;
    const result = await new PostgresWorkosLifecycleProjectionStore(run).applyOrdered({
      entityKey: 'removed-binding-test', cursor: { eventId: 'removed-binding-event', occurredAt: new Date().toISOString(), version: '1' },
      mutation: { kind: 'reduce-directory-access', provider: 'workos', userSubject: 'dsync-user-1', externalOrganizationId: 'workos-org', directorySubject: 'directory-1' },
    });
    expect(result.pendingClosure).toBeUndefined();
    expect(await sql`SELECT status FROM papercusp_auth.organization_memberships WHERE user_id=${memberId}::uuid`).toMatchObject([{ status: 'active' }]);
  });
});
