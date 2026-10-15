import { describe, expect, it, vi } from 'vitest';
import {
  PostgresHostedIdentityDirectory,
  createHostedIdentityBinder,
  type HostedIdentityBindingDenialReason,
  type HostedIdentityDirectory,
} from './hosted-identity-binding';
import {
  hostedMembershipAuthorityVersion,
  toAuthority,
  type HostedMembershipAuthorityReader,
} from './hosted-membership-authority';
import type { HostedVerifiedIdentity } from './hosted/provider';

const PROVIDER = 'workos';
const SUBJECT = 'user_01HZY';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTERNAL_ORG = 'org_01HZY';
const UPDATED_AT = new Date('2026-08-27T12:00:00.000Z');

const identity: HostedVerifiedIdentity = {
  externalUserId: SUBJECT,
  primaryEmail: 'customer@example.com',
  emailVerified: true,
};

/** A postgres.js-shaped tagged template that records what it was asked. */
function fakeSql(rows: unknown[][] | unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queue = Array.isArray(rows[0]) ? ([...rows] as unknown[][]) : [rows as unknown[]];
  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    // postgres tagged fragments are lazy query pieces, not executed reads.
    if (strings.join('').trim() === '' || strings.join('').trim() === 'FOR UPDATE OF ei, hu') {
      return { fragment: strings.join('') };
    }
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), params });
    return Promise.resolve(queue.shift() ?? []);
  };
  return Object.assign(sql, { unsafe: (value: string) => value, calls });
}

function authorityFor(overrides: Record<string, unknown> = {}) {
  const membership = toAuthority({
    organization_id: ORG,
    user_id: USER,
    role: 'admin',
    status: 'active',
    updated_at: UPDATED_AT,
    ...overrides,
  });
  if (!membership) throw new Error('test fixture produced no authority');
  return membership;
}

function membershipAuthority(
  resolveActive: HostedMembershipAuthorityReader['resolveActive'],
): HostedMembershipAuthorityReader {
  return {
    resolveActive,
    workspaceBelongsToOrganization: async () => true,
  };
}

function directory(overrides: Partial<HostedIdentityDirectory> = {}): HostedIdentityDirectory {
  return {
    resolveLinkedUser: async () => ({ userId: USER }),
    resolveOrganization: async () => ({ organizationId: ORG }),
    listActiveOrganizationIds: async () => [ORG],
    ...overrides,
  };
}

function binderWith(
  dir: Partial<HostedIdentityDirectory> = {},
  resolveActive: HostedMembershipAuthorityReader['resolveActive'] = async () => authorityFor(),
) {
  const denials: HostedIdentityBindingDenialReason[] = [];
  const bind = createHostedIdentityBinder({
    directory: directory(dir),
    membershipAuthority: membershipAuthority(resolveActive),
    onDenied: (denial) => denials.push(denial.reason),
  });
  return { bind, denials };
}

const input = (extra: Record<string, unknown> = {}) => ({
  providerId: PROVIDER,
  identity,
  ...extra,
});

describe('createHostedIdentityBinder — the permission-version invariant', () => {
  it('takes permissionVersion from the membership authority, never its own clock', async () => {
    // The operative constraint for this whole module: a version minted from
    // anything but the authority is rejected on the very next request by
    // hosted-principal-resolver as `session_permission_version_stale`.
    const { bind } = binderWith();
    const binding = await bind(input());

    expect(binding?.permissionVersion).toBe(hostedMembershipAuthorityVersion(UPDATED_AT));
    expect(binding?.permissionVersion).toBe(1_787_832_000);
  });

  it('moves the minted version when the membership row is updated', async () => {
    const later = new Date(UPDATED_AT.getTime() + 60_000);
    const { bind: before } = binderWith();
    const { bind: after } = binderWith({}, async () => authorityFor({ updated_at: later }));

    const first = await before(input());
    const second = await after(input());

    expect(second?.permissionVersion).toBeGreaterThan(first?.permissionVersion ?? Infinity);
    expect(second?.permissionVersion).toBe(hostedMembershipAuthorityVersion(later));
  });

  it('mints a version the resolver will accept for every role in the vocabulary', async () => {
    for (const role of ['owner', 'admin', 'member', 'billing'] as const) {
      const { bind } = binderWith({}, async () => authorityFor({ role }));
      const binding = await bind(input());
      // Same row timestamp ⇒ same version regardless of role: the version
      // tracks the AUTHORITY's freshness, not the permission set.
      expect(binding?.permissionVersion).toBe(hostedMembershipAuthorityVersion(UPDATED_AT));
    }
  });

  it('mints a BIGINT-safe non-negative integer', async () => {
    const { bind } = binderWith({}, async () => authorityFor({ updated_at: '2026-08-27T12:00:00.999Z' }));
    const binding = await bind(input());

    expect(Number.isSafeInteger(binding?.permissionVersion)).toBe(true);
    expect(binding?.permissionVersion).toBeGreaterThanOrEqual(0);
  });
});

describe('createHostedIdentityBinder — what it returns', () => {
  it('binds the authority user and organization, never the caller-supplied ones', async () => {
    const { bind } = binderWith();
    const binding = await bind(input());

    expect(binding).toEqual({
      userId: USER,
      organizationId: ORG,
      workspaceId: null,
      permissionVersion: hostedMembershipAuthorityVersion(UPDATED_AT),
    });
  });

  it('never selects a workspace at bind time', async () => {
    // A selection made here would skip the org-ownership check the principal
    // resolver applies to a session's selected workspace.
    const { bind } = binderWith();
    expect((await bind(input()))?.workspaceId).toBeNull();
  });

  it('never carries permissions or capabilities into the binding', async () => {
    const { bind } = binderWith();
    const binding = await bind(input());

    expect(binding).not.toHaveProperty('permissions');
    expect(binding).not.toHaveProperty('capabilities');
    expect(binding).not.toHaveProperty('role');
  });

  it('resolves the organization from the upstream hint when one is supplied', async () => {
    const resolveOrganization = vi.fn(async () => ({ organizationId: ORG }));
    const listActiveOrganizationIds = vi.fn(async () => [ORG, OTHER_ORG]);
    const { bind } = binderWith({ resolveOrganization, listActiveOrganizationIds });

    const binding = await bind(input({ externalOrganizationId: EXTERNAL_ORG }));

    expect(binding?.organizationId).toBe(ORG);
    expect(resolveOrganization).toHaveBeenCalledWith({
      providerId: PROVIDER,
      externalOrganizationId: EXTERNAL_ORG,
    });
    // The hint is authoritative, so the ambiguity fallback is not consulted.
    expect(listActiveOrganizationIds).not.toHaveBeenCalled();
  });

  it('falls back to a single active membership when there is no hint', async () => {
    const { bind } = binderWith({ listActiveOrganizationIds: async () => [ORG] });
    expect((await bind(input()))?.organizationId).toBe(ORG);
  });

  it('tolerates a duplicated organization id in the fallback list', async () => {
    const { bind } = binderWith({ listActiveOrganizationIds: async () => [ORG, ORG] });
    expect((await bind(input()))?.organizationId).toBe(ORG);
  });
});

describe('createHostedIdentityBinder — denials', () => {
  const denialCases: Array<{
    name: string;
    reason: HostedIdentityBindingDenialReason;
    dir?: Partial<HostedIdentityDirectory>;
    resolveActive?: HostedMembershipAuthorityReader['resolveActive'];
    payload?: Record<string, unknown>;
  }> = [
    {
      name: 'no active external identity link',
      reason: 'identity_not_linked',
      dir: { resolveLinkedUser: async () => null },
    },
    {
      name: 'the link resolves to a blank user id',
      reason: 'user_not_active',
      dir: { resolveLinkedUser: async () => ({ userId: '   ' }) },
    },
    {
      name: 'the organization hint matches nothing active',
      reason: 'organization_not_found',
      dir: { resolveOrganization: async () => null },
      payload: { externalOrganizationId: EXTERNAL_ORG },
    },
    {
      name: 'the user has no active membership at all',
      reason: 'no_active_membership',
      dir: { listActiveOrganizationIds: async () => [] },
    },
    {
      name: 'the user is in several organizations and gave no hint',
      reason: 'organization_ambiguous',
      dir: { listActiveOrganizationIds: async () => [ORG, OTHER_ORG] },
    },
    {
      name: 'the membership is not currently active',
      reason: 'membership_not_active',
      resolveActive: async () => null,
    },
  ];

  for (const testCase of denialCases) {
    it(`denies with \`${testCase.reason}\` when ${testCase.name}`, async () => {
      const { bind, denials } = binderWith(
        testCase.dir ?? {},
        testCase.resolveActive ?? (async () => authorityFor()),
      );

      await expect(bind(input(testCase.payload))).resolves.toBeNull();
      expect(denials).toEqual([testCase.reason]);
    });
  }

  it('denies an identity whose email is not verified', async () => {
    const { bind, denials } = binderWith();
    const unverified = { ...identity, emailVerified: false } as unknown as HostedVerifiedIdentity;

    await expect(bind(input({ identity: unverified }))).resolves.toBeNull();
    expect(denials).toEqual(['invalid_identity']);
  });

  it('denies a truthy-but-not-literal `emailVerified`', async () => {
    // The provider contract types this as the literal `true` precisely so an
    // unverified identity cannot satisfy it; this is the runtime half.
    const { bind, denials } = binderWith();
    const truthy = { ...identity, emailVerified: 'yes' } as unknown as HostedVerifiedIdentity;

    await expect(bind(input({ identity: truthy }))).resolves.toBeNull();
    expect(denials).toEqual(['invalid_identity']);
  });

  it.each([
    ['a blank provider id', { providerId: '  ' }],
    ['a blank subject', { identity: { ...identity, externalUserId: '' } }],
    ['a blank email', { identity: { ...identity, primaryEmail: '   ' } }],
  ])('denies %s', async (_label, patch) => {
    const { bind, denials } = binderWith();
    await expect(bind(input(patch))).resolves.toBeNull();
    expect(denials).toEqual(['invalid_identity']);
  });

  it('does not consult the directory for a malformed identity', async () => {
    const resolveLinkedUser = vi.fn(async () => ({ userId: USER }));
    const { bind } = binderWith({ resolveLinkedUser });

    await bind(input({ providerId: '' }));

    expect(resolveLinkedUser).not.toHaveBeenCalled();
  });
});

describe('createHostedIdentityBinder — failing closed', () => {
  it.each([
    ['the identity directory', { resolveLinkedUser: async () => { throw new Error('pg down'); } }],
    ['the organization lookup', { resolveOrganization: async () => { throw new Error('pg down'); } }],
    ['the membership listing', { listActiveOrganizationIds: async () => { throw new Error('pg down'); } }],
  ])('denies rather than throwing when %s is unavailable', async (_label, dir) => {
    const { bind, denials } = binderWith(dir as Partial<HostedIdentityDirectory>, async () => authorityFor());

    await expect(
      bind(input(_label === 'the organization lookup' ? { externalOrganizationId: EXTERNAL_ORG } : {})),
    ).resolves.toBeNull();
    expect(denials).toEqual(['authority_unavailable']);
  });

  it('denies rather than throwing when the membership authority is unavailable', async () => {
    const { bind, denials } = binderWith({}, async () => {
      throw new Error('pg down');
    });

    await expect(bind(input())).resolves.toBeNull();
    expect(denials).toEqual(['authority_unavailable']);
  });

  it('never throws, so the route cannot report a fault as a membership problem', async () => {
    const bind = createHostedIdentityBinder({
      directory: directory({
        resolveLinkedUser: async () => {
          throw new Error('boom');
        },
      }),
      membershipAuthority: membershipAuthority(async () => authorityFor()),
    });

    await expect(bind(input())).resolves.toBeNull();
  });

  it('refuses an authority that answered about a different user', async () => {
    const { bind, denials } = binderWith({}, async () => authorityFor({ user_id: OTHER_USER }));

    await expect(bind(input())).resolves.toBeNull();
    expect(denials).toEqual(['membership_not_active']);
  });

  it('refuses an authority that answered about a different organization', async () => {
    // The session minted from this binding IS the tenant boundary, so a
    // disagreement is never resolved in favour of the request.
    const { bind, denials } = binderWith(
      { resolveOrganization: async () => ({ organizationId: ORG }) },
      async () => authorityFor({ organization_id: OTHER_ORG }),
    );

    await expect(bind(input({ externalOrganizationId: EXTERNAL_ORG }))).resolves.toBeNull();
    expect(denials).toEqual(['membership_not_active']);
  });

  it('asks the authority only about the resolved user and organization', async () => {
    const resolveActive = vi.fn(async () => authorityFor());
    const bind = createHostedIdentityBinder({
      directory: directory(),
      membershipAuthority: membershipAuthority(resolveActive),
    });

    await bind(input({ externalOrganizationId: EXTERNAL_ORG }));

    expect(resolveActive).toHaveBeenCalledTimes(1);
    expect(resolveActive).toHaveBeenCalledWith({ userId: USER, organizationId: ORG });
  });

  it('reports the denial reason without the email or provider subject', async () => {
    const onDenied = vi.fn();
    const bind = createHostedIdentityBinder({
      directory: directory({ resolveLinkedUser: async () => null }),
      membershipAuthority: membershipAuthority(async () => authorityFor()),
      onDenied,
    });

    await bind(input());

    const denial = JSON.stringify(onDenied.mock.calls[0][0]);
    expect(denial).not.toContain(identity.primaryEmail);
    expect(denial).not.toContain(SUBJECT);
    expect(onDenied).toHaveBeenCalledWith({ reason: 'identity_not_linked', providerId: PROVIDER });
  });

  it('does not call the denial observer on success', async () => {
    const onDenied = vi.fn();
    const bind = createHostedIdentityBinder({
      directory: directory(),
      membershipAuthority: membershipAuthority(async () => authorityFor()),
      onDenied,
    });

    await expect(bind(input())).resolves.not.toBeNull();
    expect(onDenied).not.toHaveBeenCalled();
  });
});

describe('PostgresHostedIdentityDirectory', () => {
  it('requires the identity link AND the user to be active', async () => {
    const sql = fakeSql([{ hosted_user_id: USER }]);
    const found = await new PostgresHostedIdentityDirectory(sql as never).resolveLinkedUser({
      providerId: PROVIDER,
      subject: SUBJECT,
    });

    expect(found).toEqual({ userId: USER });
    const [call] = sql.calls;
    expect(call.params).toEqual([PROVIDER, SUBJECT, { fragment: '' }]);
    // The FK proves the user EXISTS, never that it is still active.
    expect(call.sql).toContain('JOIN papercusp_auth.hosted_users');
    for (const clause of [
      "ei.status = 'active'",
      'ei.deleted_at IS NULL',
      'ei.deactivated_at IS NULL',
      "hu.status = 'active'",
      'hu.deleted_at IS NULL',
      'hu.deactivated_at IS NULL',
    ]) {
      expect(call.sql).toContain(clause);
    }
  });

  it('returns null when no active link exists', async () => {
    const sql = fakeSql([]);
    await expect(
      new PostgresHostedIdentityDirectory(sql as never).resolveLinkedUser({
        providerId: PROVIDER,
        subject: SUBJECT,
      }),
    ).resolves.toBeNull();
  });

  it('resolves an organization only while it is active', async () => {
    const sql = fakeSql([{ id: ORG }]);
    const found = await new PostgresHostedIdentityDirectory(sql as never).resolveOrganization({
      providerId: PROVIDER,
      externalOrganizationId: EXTERNAL_ORG,
    });

    expect(found).toEqual({ organizationId: ORG });
    const [call] = sql.calls;
    expect(call.params).toEqual([PROVIDER, EXTERNAL_ORG]);
    // Suspended/offboarding tenants are excluded here rather than producing a
    // session whose every action is then refused.
    expect(call.sql).toContain("status = 'active'");
    expect(call.sql).toContain('deleted_at IS NULL');
  });

  it('lists only active memberships in active organizations, bounded to two', async () => {
    const sql = fakeSql([{ organization_id: ORG }, { organization_id: OTHER_ORG }]);
    const ids = await new PostgresHostedIdentityDirectory(sql as never).listActiveOrganizationIds({
      userId: USER,
    });

    expect(ids).toEqual([ORG, OTHER_ORG]);
    const [call] = sql.calls;
    expect(call.params).toEqual([USER]);
    for (const clause of [
      "m.status = 'active'",
      'm.revoked_at IS NULL',
      "o.status = 'active'",
      'o.deleted_at IS NULL',
      // Only ever used to decide "exactly one or not".
      'LIMIT 2',
    ]) {
      expect(call.sql).toContain(clause);
    }
  });

  it('returns an empty list rather than null when the user has no memberships', async () => {
    const sql = fakeSql([]);
    await expect(
      new PostgresHostedIdentityDirectory(sql as never).listActiveOrganizationIds({ userId: USER }),
    ).resolves.toEqual([]);
  });

  it('issues no write on any resolution path', async () => {
    const sql = fakeSql([[{ hosted_user_id: USER }], [{ id: ORG }], [{ organization_id: ORG }]]);
    const dir = new PostgresHostedIdentityDirectory(sql as never);

    await dir.resolveLinkedUser({ providerId: PROVIDER, subject: SUBJECT });
    await dir.resolveOrganization({ providerId: PROVIDER, externalOrganizationId: EXTERNAL_ORG });
    await dir.listActiveOrganizationIds({ userId: USER });

    expect(sql.calls).toHaveLength(3);
    for (const call of sql.calls) {
      expect(call.sql).toMatch(/^SELECT /);
      expect(call.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    }
  });
});
