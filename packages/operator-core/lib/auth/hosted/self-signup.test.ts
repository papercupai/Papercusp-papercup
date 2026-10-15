import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  PostgresHostedSelfSignupAdmission,
  type HostedSelfSignupInput,
} from './self-signup';

const EXPIRES = new Date('2099-01-01T00:00:00.000Z');
const ACCEPTED = new Date('2026-09-21T00:00:00.000Z');

function input(overrides: Partial<HostedSelfSignupInput> = {}): HostedSelfSignupInput {
  return {
    attemptId: 'attempt-1',
    providerId: 'workos',
    identity: {
      externalUserId: 'workos-user-1',
      primaryEmail: 'Member@example.com',
      emailVerified: true,
      displayName: 'Member',
    },
    upstreamSessionId: 'workos-session-1',
    sessionExpiresAt: EXPIRES,
    termsVersion: 'terms-2026-09',
    privacyVersion: 'privacy-2026-09',
    acceptedAt: ACCEPTED,
    ...overrides,
  };
}

/** Minimal SQL harness for the adapter's transaction contract. */
function harness(options: { failAt?: string; recentAttempts?: number } = {}) {
  const attempts = new Map<string, any>();
  const users = new Set<string>();
  const identities = new Set<string>();
  const sessions = new Map<string, any>();
  const orgs = new Set<string>();
  let userSequence = 0;
  let orgSequence = 0;
  let calls = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ');
    calls += 1;
    if (options.failAt && query.includes(options.failAt)) throw new Error('forced rollback');
    if (query.includes('INSERT INTO papercusp_auth.hosted_signup_attempts')) {
      const [attemptId, provider, subject, email, fingerprint] = values;
      if (!attempts.has(String(attemptId))) attempts.set(String(attemptId), {
        attempt_id: attemptId, provider, subject, email, fingerprint, status: 'pending',
        user_id: null, organization_id: null, session_id: null,
      });
      return [];
    }
    if (query.includes('FROM papercusp_auth.hosted_signup_attempts') && query.includes('FOR UPDATE')) {
      return [...attempts.values()].filter((row) => row.attempt_id === values[0]);
    }
    if (query.includes('SELECT count(*)')) return [{ count: options.recentAttempts ?? 0 }];
    // Identities are stored as provider|subject|userId, so match on the
    // provider|subject PREFIX. (An exact provider|subject comparison could never
    // match, which silently kept every unit test off the linked-identity path.)
    if (query.includes('SELECT hosted_user_id')) return [...identities]
      .filter((key) => key.startsWith(`${values[0]}|${values[1]}|`))
      .map((key) => ({ hosted_user_id: key.split('|')[2], identity_status: 'active', user_status: 'active', primary_email: 'member@example.com' }));
    if (query.includes('FROM papercusp_auth.organization_memberships')) return [{ id: 'membership-1' }];
    if (query.includes('SELECT id::text AS id') && query.includes('hosted_users')) return [];
    if (query.includes('INSERT INTO papercusp_auth.hosted_users')) {
      const id = `00000000-0000-4000-8000-${String(++userSequence).padStart(12, '0')}`;
      users.add(id);
      return [{ id }];
    }
    if (query.includes('INSERT INTO papercusp_auth.external_identities')) {
      identities.add(`${values[1]}|${values[2]}|${values[0]}`);
      return [];
    }
    if (query.includes('INSERT INTO papercusp_auth.organizations')) {
      const id = `10000000-0000-4000-8000-${String(++orgSequence).padStart(12, '0')}`;
      orgs.add(id);
      return [{ id }];
    }
    if (query.includes('bootstrap_hosted_self_signup_membership')) {
      return [{ id: 'membership-1', updated_at: ACCEPTED }];
    }
    if (query.includes('INSERT INTO papercusp_auth.hosted_sessions')) {
      const id = String(values[0]);
      const row = {
        id,
        user_id: String(values[1]),
        organization_id: String(values[2]),
        permission_version: Math.floor(ACCEPTED.getTime() / 1000),
        upstream_provider: String(values[4]),
        upstream_session_id: String(values[5]),
        created_at: ACCEPTED,
        expires_at: EXPIRES,
        updated_at: ACCEPTED,
      };
      sessions.set(id, row);
      return [row];
    }
    if (query.includes('SELECT id, user_id, organization_id') && query.includes('hosted_sessions')) {
      return [...sessions.values()].filter((row) => row.id === values[0]);
    }
    if (query.includes('UPDATE papercusp_auth.hosted_signup_attempts') && query.includes("'rate_limited'")) {
      const row = attempts.get(String(values.at(-1)));
      if (row) row.status = 'rate_limited';
      return [];
    }
    if (query.includes('UPDATE papercusp_auth.hosted_signup_attempts')) {
      const row = attempts.get(String(values.at(-1)));
      if (row) {
        row.status = 'completed';
        row.user_id = values[0];
        row.organization_id = values[1];
        row.session_id = values[2];
      }
      return [];
    }
    return [];
  }) as unknown as Sql;
  let transactions = 0;
  const admission = new PostgresHostedSelfSignupAdmission(async (fn) => {
    transactions += 1;
    return fn(sql);
  });
  return {
    admission, attempts, sessions, orgs, users,
    get calls() { return calls; },
    get transactions() { return transactions; },
  };
}

describe('hosted self-signup admission', () => {
  it('rejects unverified identities and missing legal acceptance before opening a transaction', async () => {
    const h = harness();
    const result = await h.admission.complete(input({
      identity: { ...input().identity, emailVerified: false as never },
      termsVersion: '',
    }));
    expect(result).toEqual({ ok: false, code: 'invalid_request', retryable: false });
    expect(h.calls).toBe(0);
  });

  it('creates an owner tenant and session, then replays the same attempt idempotently', async () => {
    const h = harness();
    const first = await h.admission.complete(input());
    expect(first).toMatchObject({
      ok: true,
      binding: { organizationId: expect.any(String), permissionVersion: Math.floor(ACCEPTED.getTime() / 1000), workspaceId: null },
      session: { workspaceId: null, upstreamSessionId: 'workos-session-1' },
    });
    const callCount = h.calls;
    const replay = await h.admission.complete(input());
    expect(replay).toEqual(first);
    // Ledger transaction (linked-identity probe only: a linked identity writes
    // no ledger row) then the replay read (insert + locked read + stored
    // session) — no admission writes.
    expect(h.calls).toBe(callCount + 4);
    expect(h.attempts.size).toBe(1);
    expect(h.orgs.size).toBe(1);
  });

  it('refuses past the per-email limit in its own transaction, before any admission write', async () => {
    const h = harness({ recentAttempts: 5 });
    const result = await h.admission.complete(input());
    expect(result).toEqual({ ok: false, code: 'rate_limited', retryable: false });
    // Exactly one transaction ran — the ledger one — so the refusal it records
    // is committed rather than rolled back with a failed admission.
    expect(h.transactions).toBe(1);
    expect(h.attempts.get('attempt-1')?.status).toBe('rate_limited');
    expect(h.users.size).toBe(0);

    // The same attempt stays refused without a second count.
    expect(await h.admission.complete(input())).toEqual({ ok: false, code: 'rate_limited', retryable: false });
  });

  it('keeps a reused attempt id bound to its original identity', async () => {
    const h = harness();
    expect((await h.admission.complete(input())).ok).toBe(true);
    const hijack = await h.admission.complete(input({
      identity: { ...input().identity, externalUserId: 'workos-user-2', primaryEmail: 'other@example.com' },
    }));
    expect(hijack).toEqual({ ok: false, code: 'state_conflict', retryable: false });
  });

  it('fails closed and exposes no partial binding when the transaction errors', async () => {
    const h = harness({ failAt: 'hosted_sessions' });
    const result = await h.admission.complete(input());
    expect(result).toEqual({ ok: false, code: 'unavailable', retryable: true });
    expect(h.sessions.size).toBe(0);
  });
});
