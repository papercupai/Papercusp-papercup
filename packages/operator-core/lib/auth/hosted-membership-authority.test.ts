import { describe, expect, it } from 'vitest';
import {
  PostgresHostedMembershipAuthority,
  hostedMembershipAuthorityVersion,
  toAuthority,
} from './hosted-membership-authority';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const UPDATED_AT = new Date('2026-08-27T12:00:00.000Z');

interface Recorded {
  sql: string;
  params: unknown[];
}

/** A postgres.js-shaped tagged template that records what it was asked. */
function fakeSql(rows: unknown[][] | unknown[]) {
  const calls: Recorded[] = [];
  const queue = Array.isArray(rows[0]) ? ([...rows] as unknown[][]) : [rows as unknown[]];
  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), params });
    return Promise.resolve(queue.shift() ?? []);
  };
  return Object.assign(sql, { unsafe: (value: string) => value, calls });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    user_id: USER,
    role: 'admin',
    status: 'active',
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

describe('hostedMembershipAuthorityVersion', () => {
  it('derives whole epoch seconds from the membership row timestamp', () => {
    expect(hostedMembershipAuthorityVersion(UPDATED_AT)).toBe(1_787_832_000);
    expect(hostedMembershipAuthorityVersion('2026-08-27T12:00:00.000Z')).toBe(1_787_832_000);
  });

  it('floors sub-second precision so the value stays a BIGINT', () => {
    // hosted_sessions.permission_version is BIGINT CHECK (>= 0): a fractional
    // value would be rejected at mint time rather than fail closed at check.
    const version = hostedMembershipAuthorityVersion(new Date('2026-08-27T12:00:00.999Z'));
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBe(1_787_832_000);
  });

  it('never returns a negative version', () => {
    expect(hostedMembershipAuthorityVersion(new Date('1900-01-01T00:00:00.000Z'))).toBe(0);
  });

  it('moves forward when the membership row is updated', () => {
    const before = hostedMembershipAuthorityVersion(UPDATED_AT);
    const after = hostedMembershipAuthorityVersion(new Date(UPDATED_AT.getTime() + 60_000));
    expect(after).toBeGreaterThan(before);
  });

  it('rejects an unusable timestamp instead of inventing a version', () => {
    expect(() => hostedMembershipAuthorityVersion('not-a-date')).toThrow(/valid_timestamp/);
    expect(() => hostedMembershipAuthorityVersion(new Date(Number.NaN))).toThrow(/valid_timestamp/);
  });
});

describe('toAuthority', () => {
  it('builds authority with permissions derived from the role', () => {
    const authority = toAuthority(row());
    expect(authority).not.toBeNull();
    expect(authority?.role).toBe('admin');
    expect(authority?.permissionVersion).toBe(1_787_832_000);
    expect([...(authority?.permissions ?? [])].sort()).toEqual([
      'cloud-connection:manage',
      'members:manage',
      'workspace:destroy',
      'workspace:operate',
      'workspace:view',
    ]);
  });

  it('fails closed on an unknown role or status', () => {
    expect(toAuthority(row({ role: 'superuser' }))).toBeNull();
    expect(toAuthority(row({ role: '*' }))).toBeNull();
    expect(toAuthority(row({ status: 'pending' }))).toBeNull();
  });

  it('fails closed on a non-active membership', () => {
    expect(toAuthority(row({ status: 'suspended' }))).toBeNull();
    expect(toAuthority(row({ status: 'revoked' }))).toBeNull();
  });

  it('fails closed on blank identifiers and unusable timestamps', () => {
    expect(toAuthority(row({ organization_id: '   ' }))).toBeNull();
    expect(toAuthority(row({ user_id: '' }))).toBeNull();
    expect(toAuthority(row({ updated_at: 'not-a-date' }))).toBeNull();
  });
});

describe('PostgresHostedMembershipAuthority.resolveActive', () => {
  it('reads the membership row and maps it to authority', async () => {
    const sql = fakeSql([row()]);
    const authority = await new PostgresHostedMembershipAuthority(sql as never).resolveActive({
      userId: USER,
      organizationId: ORG,
    });

    expect(authority?.organizationId).toBe(ORG);
    expect(authority?.userId).toBe(USER);
    expect(authority?.role).toBe('admin');
    expect(sql.calls).toHaveLength(1);
    // This fake exposes unsafe SQL fragments as a recorded value.
    expect(sql.calls[0].params).toEqual([USER, ORG, '']);
  });

  it('filters to active, non-revoked rows in SQL, not only in code', async () => {
    const sql = fakeSql([row()]);
    await new PostgresHostedMembershipAuthority(sql as never).resolveActive({
      userId: USER,
      organizationId: ORG,
    });

    expect(sql.calls[0].sql).toContain('papercusp_auth.organization_memberships');
    expect(sql.calls[0].sql).toContain("status = 'active'");
    expect(sql.calls[0].sql).toContain('revoked_at IS NULL');
  });

  it('returns null when there is no active membership', async () => {
    const sql = fakeSql([[]]);
    const authority = await new PostgresHostedMembershipAuthority(sql as never).resolveActive({
      userId: USER,
      organizationId: ORG,
    });
    expect(authority).toBeNull();
  });

  it('refuses blank identifiers without touching the database', async () => {
    const sql = fakeSql([row()]);
    const reader = new PostgresHostedMembershipAuthority(sql as never);

    expect(await reader.resolveActive({ userId: '  ', organizationId: ORG })).toBeNull();
    expect(await reader.resolveActive({ userId: USER, organizationId: '' })).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });

  it('fails closed when the stored row carries an unknown role', async () => {
    const sql = fakeSql([row({ role: 'superuser' })]);
    const authority = await new PostgresHostedMembershipAuthority(sql as never).resolveActive({
      userId: USER,
      organizationId: ORG,
    });
    expect(authority).toBeNull();
  });
});

describe('PostgresHostedMembershipAuthority.workspaceBelongsToOrganization', () => {
  const input = {
    userId: USER,
    sessionId: `hs_${'A'.repeat(43)}`,
    sessionVersion: 1,
    organizationId: ORG,
    customerWorkspaceId: 'cw-1',
    controlPlaneWorkspaceId: 'papercusp-control-plane',
  };

  it('scopes the lookup by control-plane workspace, id, and organization', async () => {
    // customer_workspaces is keyed (workspace_id, id): an (organization_id, id)
    // filter alone is not unique across control-plane workspaces.
    const sql = fakeSql([[{ organization_id: ORG }]]);
    const owned = await new PostgresHostedMembershipAuthority(sql as never).workspaceBelongsToOrganization(input);

    expect(owned).toBe(true);
    expect(sql.calls[0].sql).toContain('harness_shared.customer_workspaces');
    expect(sql.calls[0].sql).toContain('deleted_at IS NULL');
    expect(sql.calls[0].params).toEqual(['papercusp-control-plane', 'cw-1', ORG, '']);
  });

  it('is false when no row matches', async () => {
    const sql = fakeSql([[]]);
    expect(await new PostgresHostedMembershipAuthority(sql as never).workspaceBelongsToOrganization(input)).toBe(false);
  });

  it('locks the exact workspace row and refuses a pool whose lock would end early', async () => {
    const sql = fakeSql([[{ organization_id: ORG }]]);
    expect(await new PostgresHostedMembershipAuthority(sql as never).workspaceBelongsToOrganizationForUpdate(input)).toBe(true);
    expect(sql.calls[0].params).toEqual(['papercusp-control-plane', 'cw-1', ORG, 'FOR UPDATE']);
    const pool = Object.assign(fakeSql([]), { begin: () => {} });
    await expect(new PostgresHostedMembershipAuthority(pool as never).workspaceBelongsToOrganizationForUpdate(input))
      .rejects.toThrow('hosted_workspace_lock_requires_transaction');
    expect(pool.calls).toHaveLength(0);
  });

  it('refuses blank identifiers without touching the database', async () => {
    const sql = fakeSql([[{ organization_id: ORG }]]);
    const reader = new PostgresHostedMembershipAuthority(sql as never);

    expect(await reader.workspaceBelongsToOrganization({ ...input, organizationId: '' })).toBe(false);
    expect(await reader.workspaceBelongsToOrganization({ ...input, userId: '' })).toBe(false);
    expect(await reader.workspaceBelongsToOrganization({ ...input, sessionId: '' })).toBe(false);
    expect(await reader.workspaceBelongsToOrganization({ ...input, sessionVersion: -1 })).toBe(false);
    expect(await reader.workspaceBelongsToOrganization({ ...input, customerWorkspaceId: ' ' })).toBe(false);
    expect(await reader.workspaceBelongsToOrganization({ ...input, controlPlaneWorkspaceId: '' })).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });
});
