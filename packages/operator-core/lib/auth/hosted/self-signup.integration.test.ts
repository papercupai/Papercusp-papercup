/**
 * Hosted self-serve signup against real Postgres, real roles and real RLS (P-319).
 *
 * WHY THIS EXISTS BESIDE `self-signup.test.ts`. The unit suite drives the adapter
 * through a pattern-matching fake SQL client, so it cannot fail when the database
 * refuses a write, when a SECURITY DEFINER function lacks a grant, or when a
 * rolled-back transaction erases a row the code expected to persist. Every case
 * here runs the production adapter on `harness_app` switched into
 * `hosted_service` with `SET LOCAL ROLE` — the same privilege path
 * `withHostedServiceContext` takes — and inspects the result with the
 * RLS-bypassing admin client.
 *
 * Specs covered (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-319):
 *   SIGNUP-OWNER-P319          one new organization, one ACTIVE owner membership
 *   SIGNUP-IDEMPOTENT-P319     a replayed attempt returns the original admission
 *   SIGNUP-ROLLBACK-P319       every refusal and an injected mid-transaction
 *                              failure leave no partial admission records
 *   SIGNIN-NO-ADMISSION-P319   ordinary sign-in never admits a nonmember
 * plus the per-email abuse limit, which has to survive the refusal it causes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';
import {
  HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
  HOSTED_SELF_SIGNUP_TERMS_VERSION,
  PostgresHostedSelfSignupAdmission,
  type HostedSelfSignupInput,
} from './self-signup';
import { createHostedIdentityBinder } from '../hosted-identity-binding';
import {
  HostedRuntimeMembershipAuthority,
  HostedServiceIdentityDirectory,
} from './service-adapters';
import { PostgresWorkosLifecycleProjectionStore, type HostedServiceContextRunner } from './workos-lifecycle-postgres';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

const PROVIDER = 'workos';
const SESSION_EXPIRES = new Date('2099-01-01T00:00:00.000Z');

let db: OrgTestDb;

/** Production's hosted-service transaction shape: harness_app, then SET LOCAL ROLE. */
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

function unique(label: string): string {
  return `${label}-${randomBytes(5).toString('hex')}`;
}

function signupInput(email: string, overrides: Partial<HostedSelfSignupInput> = {}): HostedSelfSignupInput {
  return {
    attemptId: unique('state'),
    providerId: PROVIDER,
    identity: {
      externalUserId: unique('user_'),
      primaryEmail: email,
      emailVerified: true,
      displayName: 'Integration Member',
    },
    upstreamSessionId: unique('session_'),
    sessionExpiresAt: SESSION_EXPIRES,
    termsVersion: HOSTED_SELF_SIGNUP_TERMS_VERSION,
    privacyVersion: HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
    acceptedAt: new Date(),
    ...overrides,
  };
}

interface AdmissionCensus {
  users: number;
  identities: number;
  organizations: number;
  memberships: number;
  ownerMemberships: number;
  legal: number;
  entitlements: number;
  sessions: number;
}

/** Every admission record reachable from one email, read past RLS. */
async function census(email: string): Promise<AdmissionCensus> {
  const [row] = await db.adminSql<Array<Record<keyof AdmissionCensus, number>>>`
    WITH u AS (
      SELECT id FROM papercusp_auth.hosted_users WHERE lower(primary_email) = lower(${email})
    ), m AS (
      SELECT * FROM papercusp_auth.organization_memberships WHERE user_id IN (SELECT id FROM u)
    )
    SELECT
      (SELECT count(*) FROM u)::int AS users,
      (SELECT count(*) FROM papercusp_auth.external_identities
        WHERE lower(provider_email) = lower(${email}))::int AS identities,
      (SELECT count(DISTINCT organization_id) FROM m)::int AS organizations,
      (SELECT count(*) FROM m)::int AS memberships,
      (SELECT count(*) FROM m WHERE role = 'owner' AND status = 'active')::int AS "ownerMemberships",
      (SELECT count(*) FROM papercusp_auth.legal_acceptances
        WHERE user_id IN (SELECT id FROM u))::int AS legal,
      (SELECT count(*) FROM papercusp_auth.hosted_entitlements
        WHERE user_id IN (SELECT id FROM u))::int AS entitlements,
      -- hosted_sessions keys users by TEXT (migration 902), unlike the uuid tables.
      (SELECT count(*) FROM papercusp_auth.hosted_sessions
        WHERE user_id IN (SELECT id::text FROM u))::int AS sessions
  `;
  return row as AdmissionCensus;
}

const EMPTY: AdmissionCensus = {
  users: 0, identities: 0, organizations: 0, memberships: 0,
  ownerMemberships: 0, legal: 0, entitlements: 0, sessions: 0,
};

async function attemptStatuses(email: string): Promise<string[]> {
  const rows = await db.adminSql<Array<{ status: string }>>`
    SELECT status FROM papercusp_auth.hosted_signup_attempts
     WHERE email = lower(${email}) ORDER BY created_at, attempt_id
  `;
  return rows.map((r) => r.status);
}

function signInBinder(denials: string[]) {
  return createHostedIdentityBinder({
    directory: new HostedServiceIdentityDirectory(runService),
    membershipAuthority: new HostedRuntimeMembershipAuthority(runService, () => {
      throw new Error('tenant runner is not used by sign-in');
    }),
    onDenied: (d) => denials.push(d.reason),
  });
}

/** Run the actual lifecycle writer that can win the race with explicit signup. */
async function projectWorkosUser(input: HostedSelfSignupInput): Promise<string> {
  const eventId = unique('workos-event');
  const occurredAt = new Date().toISOString();
  await db.adminSql`
    INSERT INTO papercusp_auth.webhook_event_receipts
      (provider, event_id, event_type, subject_ref, event_created_at, payload,
       payload_sha256, received_at, verified_at, enqueued_at, retention_until)
    VALUES ('workos', ${eventId}, 'user.created', ${input.identity.externalUserId},
      ${occurredAt}::timestamptz, '{}'::jsonb, ${'a'.repeat(64)}, now(), now(), now(), now() + interval '1 day')
  `;
  const store = new PostgresWorkosLifecycleProjectionStore(runService);
  expect(await store.applyOrdered({
    entityKey: `workos:user:${input.identity.externalUserId}`,
    cursor: { eventId, occurredAt, version: '1' },
    mutation: { kind: 'upsert-user', provider: 'workos', subject: input.identity.externalUserId,
      email: input.identity.primaryEmail.toLowerCase(), displayName: 'Lifecycle User' },
  })).toMatchObject({ disposition: 'applied' });
  const [row] = await db.adminSql<Array<{ id: string }>>`
    SELECT id::text FROM papercusp_auth.hosted_users WHERE primary_email = ${input.identity.primaryEmail.toLowerCase()}
  `;
  return row.id;
}

describe('hosted self-signup admission (real Postgres, real roles)', () => {
  const admission = () => new PostgresHostedSelfSignupAdmission(runService);

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Exercise a reserved .DRAFT in the isolated fixture before it is armed.
    const probe = process.env.ACCOUNT_TUTORIAL_SIGNUP_MIGRATION_PROBE;
    if (probe) await db.adminSql.unsafe(readFileSync(probe, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('enrolls a newly admitted invitation account before workspace selection and preserves completed progress on replay', async () => {
    const owner = await admission().complete(signupInput(`${unique('inviter')}@example.test`));
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('owner admission failed');
    const email = `${unique('invited')}@example.test`;
    const [user] = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.hosted_users (primary_email) VALUES (${email}) RETURNING id`;
    const [invitation] = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.organization_invitation_refs
        (organization_id, identity_provider, external_invitation_id, invitee_email)
      VALUES (${owner.binding.organizationId}::uuid, 'workos', ${unique('invite')}, ${email}) RETURNING id`;
    await db.adminSql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via, invitation_ref_id)
      VALUES (${owner.binding.organizationId}::uuid, ${user.id}::uuid, 'member',
        'invitation_acceptance', ${invitation.id}::uuid)`;
    const read = () => db.adminSql<Array<{ tutorial: { disposition: string; scope: unknown } }>>`
      SELECT profile #> '{productTutorial,3}' AS tutorial FROM papercusp_auth.hosted_user_preferences
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${user.id}::uuid`;
    expect((await read())[0].tutorial).toMatchObject({
      scope: { tenantId: owner.binding.organizationId, userId: user.id },
      disposition: 'active', currentLessonId: 'welcome', revision: 0,
    });
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences
      SET profile = jsonb_set(profile, '{productTutorial,3,disposition}', '"closed"'::jsonb)
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${user.id}::uuid`;
    await db.adminSql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via, invitation_ref_id)
      VALUES (${owner.binding.organizationId}::uuid, ${user.id}::uuid, 'member',
        'invitation_acceptance', ${invitation.id}::uuid) ON CONFLICT DO NOTHING`;
    expect((await read())[0].tutorial.disposition).toBe('closed');
    await expect(runService(sql => sql`SELECT profile FROM papercusp_auth.hosted_user_preferences`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('does not enroll inactive/restored memberships and rolls enrollment back with admission', async () => {
    const owner = await admission().complete(signupInput(`${unique('membership')}@example.test`));
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('owner admission failed');
    const [legacy] = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.hosted_users (primary_email) VALUES (${`${unique('legacy')}@example.test`}) RETURNING id`;
    await db.adminSql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, status, suspended_at, created_via)
      VALUES (${owner.binding.organizationId}::uuid, ${legacy.id}::uuid, 'member', 'suspended', now(), 'member_management')`;
    await db.adminSql`UPDATE papercusp_auth.organization_memberships SET status = 'active'
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${legacy.id}::uuid`;
    expect(await db.adminSql`SELECT 1 FROM papercusp_auth.hosted_user_preferences
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${legacy.id}::uuid`).toHaveLength(0);
    const [cancelled] = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.hosted_users (primary_email) VALUES (${`${unique('cancelled')}@example.test`}) RETURNING id`;
    await expect(db.adminSql.begin(async tx => {
      await tx`INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via)
        VALUES (${owner.binding.organizationId}::uuid, ${cancelled.id}::uuid, 'member', 'member_management')`;
      expect(await tx`SELECT 1 FROM papercusp_auth.hosted_user_preferences
        WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${cancelled.id}::uuid`).toHaveLength(1);
      throw new Error('admission rolled back');
    })).rejects.toThrow('admission rolled back');
    expect(await db.adminSql`SELECT 1 FROM papercusp_auth.hosted_user_preferences
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${cancelled.id}::uuid`).toHaveLength(0);
    expect(await db.adminSql`SELECT 1 FROM papercusp_auth.organization_memberships
      WHERE organization_id = ${owner.binding.organizationId}::uuid AND user_id = ${cancelled.id}::uuid`).toHaveLength(0);
  });

  it('SIGNUP-OWNER: a valid signup creates exactly one organization with one active owner membership and a usable session', async () => {
    const email = `${unique('owner')}@example.test`;
    const input = signupInput(email);
    const result = await admission().complete(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await census(email)).toEqual({
      users: 1, identities: 1, organizations: 1, memberships: 1,
      ownerMemberships: 1, legal: 2, entitlements: 1, sessions: 1,
    });
    const [session] = await db.adminSql<Array<{ user_id: string; organization_id: string; workspace_id: string | null }>>`
      SELECT user_id, organization_id, workspace_id
        FROM papercusp_auth.hosted_sessions WHERE id = ${result.session.id}
    `;
    expect(session).toEqual({
      user_id: result.binding.userId,
      organization_id: result.binding.organizationId,
      workspace_id: null,
    });
    expect(await attemptStatuses(email)).toEqual(['completed']);

    const [preference] = await db.adminSql<Array<{ tutorial: unknown }>>`
      SELECT profile #> '{productTutorial,3}' AS tutorial FROM papercusp_auth.hosted_user_preferences
      WHERE organization_id = ${result.binding.organizationId}::uuid AND user_id = ${result.binding.userId}::uuid`;
    expect(preference.tutorial).toEqual({
      scope: { tenantId: result.binding.organizationId, userId: result.binding.userId },
      version: 3, revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [],
    });
    // The bootstrap may enroll, but the caller cannot inspect unrelated profiles.
    await expect(runService(sql => sql`SELECT profile FROM papercusp_auth.hosted_user_preferences`)).rejects.toMatchObject({ code: '42501' });

    // The minted binding must agree with the request-time authority, or the
    // first request on the new session is rejected as permission-stale.
    const denials: string[] = [];
    const bound = await signInBinder(denials)({
      providerId: PROVIDER,
      identity: input.identity,
    } as never);
    expect(denials).toEqual([]);
    expect(bound).toEqual(result.binding);
  });

  it('SIGNUP-IDEMPOTENT: replaying the same attempt returns the original admission and writes nothing', async () => {
    const email = `${unique('replay')}@example.test`;
    const input = signupInput(email);
    const first = await admission().complete(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('signup must succeed');
    await db.adminSql`UPDATE papercusp_auth.hosted_user_preferences
      SET profile = jsonb_set(profile, '{productTutorial,3,disposition}', '"paused"'::jsonb)
      WHERE organization_id = ${first.binding.organizationId}::uuid AND user_id = ${first.binding.userId}::uuid`;
    const before = await census(email);

    const replay = await admission().complete(input);
    expect(replay).toEqual(first);
    expect(await census(email)).toEqual(before);
    expect(await attemptStatuses(email)).toEqual(['completed']);
    const [preference] = await db.adminSql<Array<{ disposition: string }>>`
      SELECT profile #>> '{productTutorial,3,disposition}' AS disposition FROM papercusp_auth.hosted_user_preferences
      WHERE organization_id = ${first.binding.organizationId}::uuid AND user_id = ${first.binding.userId}::uuid`;
    expect(preference.disposition).toBe('paused');
  });

  it('admits a lifecycle-projected active identity only through explicit signup, reusing its user', async () => {
    const email = `${unique('projected')}@example.test`;
    const input = signupInput(email);
    const userId = await projectWorkosUser(input);
    const denials: string[] = [];
    expect(await signInBinder(denials)({ providerId: PROVIDER, identity: input.identity } as never)).toBeNull();
    expect(denials).toEqual(['no_active_membership']);

    const result = await admission().complete(input);
    expect(result).toMatchObject({ ok: true, binding: { userId } });
    expect(await census(email)).toEqual({ users: 1, identities: 1, organizations: 1, memberships: 1,
      ownerMemberships: 1, legal: 2, entitlements: 1, sessions: 1 });
    expect(await attemptStatuses(email)).toEqual(['completed']);
    expect(await admission().complete(input)).toEqual(result);
  });

  it('serializes concurrent explicit admissions for a lifecycle-projected identity', async () => {
    const email = `${unique('projected-race')}@example.test`;
    const input = signupInput(email);
    await projectWorkosUser(input);
    const results = await Promise.all([
      admission().complete(input),
      admission().complete({ ...input, attemptId: unique('racing-attempt') }),
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, code: 'duplicate_identity', retryable: false }]);
    expect(await census(email)).toMatchObject({ users: 1, organizations: 1, memberships: 1, sessions: 1 });
  });

  it('shares the lifecycle ordering lock when projection and explicit admission race', async () => {
    const email = `${unique('lifecycle-race')}@example.test`;
    const input = signupInput(email);
    const [userId, result] = await Promise.all([projectWorkosUser(input), admission().complete(input)]);
    expect(result).toMatchObject({ ok: true, binding: { userId } });
    expect(await census(email)).toEqual({ users: 1, identities: 1, organizations: 1, memberships: 1,
      ownerMemberships: 1, legal: 2, entitlements: 1, sessions: 1 });
  });

  it('counts admission attempts for a projected identity without membership toward the abuse limit', async () => {
    const email = `${unique('projected-abuse')}@example.test`;
    const input = signupInput(email);
    await projectWorkosUser(input);
    for (let i = 0; i < 5; i += 1) {
      await db.adminSql`
        INSERT INTO papercusp_auth.hosted_signup_attempts (attempt_id, provider, subject, email, fingerprint, status)
        VALUES (${unique('failed-attempt')}, ${PROVIDER}, ${input.identity.externalUserId}, ${email},
          ${`${PROVIDER}|${input.identity.externalUserId}|${email}`}, 'pending')
      `;
    }
    expect(await admission().complete(input)).toEqual({ ok: false, code: 'rate_limited', retryable: false });
    expect(await attemptStatuses(email)).toContain('rate_limited');
    expect(await census(email)).toMatchObject({ organizations: 0, memberships: 0, sessions: 0 });
  });

  it('refuses inactive lifecycle identities and a mismatch with the verified email', async () => {
    for (const status of ['deactivated', 'deleted']) {
      const email = `${unique(status)}@example.test`;
      const input = signupInput(email);
      const userId = await projectWorkosUser(input);
      await db.adminSql`UPDATE papercusp_auth.hosted_users SET status = ${status},
        deactivated_at = CASE WHEN ${status} = 'deactivated' THEN now() ELSE NULL END,
        deleted_at = CASE WHEN ${status} = 'deleted' THEN now() ELSE NULL END WHERE id = ${userId}::uuid`;
      await db.adminSql`UPDATE papercusp_auth.external_identities SET status = ${status},
        deactivated_at = CASE WHEN ${status} = 'deactivated' THEN now() ELSE NULL END,
        deleted_at = CASE WHEN ${status} = 'deleted' THEN now() ELSE NULL END WHERE hosted_user_id = ${userId}::uuid`;
      expect(await admission().complete(input)).toEqual({ ok: false, code: 'duplicate_identity', retryable: false });
      expect(await census(email)).toMatchObject({ organizations: 0, memberships: 0, sessions: 0 });
    }
    const input = signupInput(`${unique('email-match')}@example.test`);
    await projectWorkosUser(input);
    expect(await admission().complete({ ...input, identity: { ...input.identity, primaryEmail: `${unique('different')}@example.test` } }))
      .toEqual({ ok: false, code: 'duplicate_identity', retryable: false });
  });

  it('does not create a new tenant for a user with revoked membership history', async () => {
    const email = `${unique('prior-member')}@example.test`;
    const input = signupInput(email);
    const first = await admission().complete(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await db.adminSql`UPDATE papercusp_auth.organization_memberships SET status = 'revoked', revoked_at = now() WHERE user_id = ${first.binding.userId}::uuid`;
    const before = await census(email);
    expect(await admission().complete({ ...input, attemptId: unique('new-attempt') }))
      .toEqual({ ok: false, code: 'duplicate_identity', retryable: false });
    expect(await census(email)).toEqual(before);
  });

  it('refuses a second signup for an existing identity or email without admitting anything new', async () => {
    const email = `${unique('dup')}@example.test`;
    const original = signupInput(email);
    expect((await admission().complete(original)).ok).toBe(true);
    const before = await census(email);

    const sameSubject = await admission().complete(signupInput(email, { identity: original.identity }));
    expect(sameSubject).toEqual({ ok: false, code: 'duplicate_identity', retryable: false });

    const sameEmail = await admission().complete(signupInput(email.toUpperCase()));
    expect(sameEmail).toEqual({ ok: false, code: 'duplicate_identity', retryable: false });

    expect(await census(email)).toEqual(before);
  });

  it('SIGNUP-ROLLBACK: invalid input and a reused attempt with a different identity leave no admission records', async () => {
    const unverified = `${unique('unverified')}@example.test`;
    const result = await admission().complete(signupInput(unverified, {
      identity: {
        externalUserId: unique('user_'),
        primaryEmail: unverified,
        emailVerified: false as never,
      },
    }));
    expect(result).toEqual({ ok: false, code: 'invalid_request', retryable: false });
    expect(await census(unverified)).toEqual(EMPTY);
    expect(await attemptStatuses(unverified)).toEqual([]);

    const noTerms = `${unique('noterms')}@example.test`;
    expect(await admission().complete(signupInput(noTerms, { termsVersion: '' })))
      .toEqual({ ok: false, code: 'invalid_request', retryable: false });
    expect(await census(noTerms)).toEqual(EMPTY);

    const first = `${unique('state')}@example.test`;
    const hijack = `${unique('hijack')}@example.test`;
    const input = signupInput(first);
    expect((await admission().complete(input)).ok).toBe(true);
    const reused = await admission().complete(signupInput(hijack, { attemptId: input.attemptId }));
    expect(reused).toEqual({ ok: false, code: 'state_conflict', retryable: false });
    expect(await census(hijack)).toEqual(EMPTY);
  });

  it('SIGNUP-ROLLBACK: a failure injected at the last admission write rolls back every earlier write', async () => {
    const email = `${unique('rollback')}@example.test`;
    // A real database failure inside the admission transaction, raised at the
    // final write so that user, identity, organization, membership, legal and
    // entitlement rows have ALL been written before it fires.
    const fn = `fail_session_${randomBytes(4).toString('hex')}`;
    await db.adminSql.unsafe(`
      CREATE FUNCTION papercusp_auth.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM papercusp_auth.hosted_users
                    WHERE id::text = NEW.user_id AND primary_email = '${email}') THEN
          RAISE EXCEPTION 'injected admission failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${fn} BEFORE INSERT ON papercusp_auth.hosted_sessions
        FOR EACH ROW EXECUTE FUNCTION papercusp_auth.${fn}();
    `);
    try {
      const result = await admission().complete(signupInput(email));
      expect(result).toEqual({ ok: false, code: 'unavailable', retryable: true });
      expect(await census(email)).toEqual(EMPTY);
      // The attempt ledger may keep a non-completed row (it is how abuse is
      // counted), but never a completed one pointing at rolled-back ids.
      expect(await attemptStatuses(email)).not.toContain('completed');
    } finally {
      await db.adminSql.unsafe(`
        DROP TRIGGER IF EXISTS ${fn} ON papercusp_auth.hosted_sessions;
        DROP FUNCTION IF EXISTS papercusp_auth.${fn}();
      `);
    }
  });

  it('refuses a sixth signup attempt for one email within an hour, and the refusal persists', async () => {
    const email = `${unique('abuse')}@example.test`;
    // Five failed attempts for one email: the first admits, the next four are
    // duplicate refusals. None of the refusals may be forgotten.
    expect((await admission().complete(signupInput(email))).ok).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      expect((await admission().complete(signupInput(email))).ok).toBe(false);
    }
    const before = await census(email);

    const limited = await admission().complete(signupInput(email));
    expect(limited).toEqual({ ok: false, code: 'rate_limited', retryable: false });
    expect(await census(email)).toEqual(before);
    expect(await attemptStatuses(email)).toContain('rate_limited');
  });

  it('does not rate-limit a returning user whose identity is already linked', async () => {
    const email = `${unique('returning')}@example.test`;
    const original = signupInput(email);
    expect((await admission().complete(original)).ok).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      const again = await admission().complete(signupInput(email, { identity: original.identity }));
      // duplicate_identity is what lets the route sign a returning user in.
      expect(again).toEqual({ ok: false, code: 'duplicate_identity', retryable: false });
    }
    // A returning user's sign-up click is a sign-in, not an admission attempt:
    // it must leave no ledger row behind. Measured live 2026-09-29 (WI-10002240):
    // the committed pre-admission ledger write left a 'pending' row per replay
    // that nothing ever resolved.
    expect(await attemptStatuses(email)).toEqual(['completed']);
  });

  it('SIGNIN-NO-ADMISSION: ordinary sign-in refuses a nonmember and writes nothing', async () => {
    const denials: string[] = [];
    const bind = signInBinder(denials);

    const strangerEmail = `${unique('stranger')}@example.test`;
    const stranger = await bind({
      providerId: PROVIDER,
      identity: { externalUserId: unique('user_'), primaryEmail: strangerEmail, emailVerified: true },
    } as never);
    expect(stranger).toBeNull();
    expect(denials).toEqual(['identity_not_linked']);
    expect(await census(strangerEmail)).toEqual(EMPTY);

    // A linked identity with no membership is still refused, and sign-in does
    // not repair that by creating one.
    const orphanEmail = `${unique('orphan')}@example.test`;
    const subject = unique('user_');
    await db.adminSql`
      WITH u AS (
        INSERT INTO papercusp_auth.hosted_users (primary_email) VALUES (${orphanEmail}) RETURNING id
      )
      INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject, provider_email, profile)
      SELECT id, ${PROVIDER}, ${subject}, ${orphanEmail}, '{}'::jsonb FROM u
    `;
    const orphan = await bind({
      providerId: PROVIDER,
      identity: { externalUserId: subject, primaryEmail: orphanEmail, emailVerified: true },
    } as never);
    expect(orphan).toBeNull();
    expect(denials).toEqual(['identity_not_linked', 'no_active_membership']);
    expect(await census(orphanEmail)).toMatchObject({ users: 1, memberships: 0, organizations: 0, sessions: 0 });
  });
});
