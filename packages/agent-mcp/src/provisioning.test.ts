import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  responses: [] as unknown[][],
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async (_workspaceId: string, callback: (tx: unknown) => unknown) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      pgMock.queries.push({ text: strings.join(' ? '), values });
      return Promise.resolve(pgMock.responses.shift() ?? []);
    };
    return callback(tx);
  },
}));
vi.mock('./auth', () => ({ PRINCIPAL_INVALIDATE_CHANNEL: 'agent_mcp_principal_invalidate' }));

import { createHash } from 'node:crypto';
import type { Principal } from '@papercusp/tooldef';
import { startPiSession, provisionNativeRuntimeBearer, verifyNativeRuntimeBearer } from './provisioning';

beforeEach(() => {
  pgMock.queries.length = 0;
  pgMock.responses.length = 0;
});

describe('native runtime supplemental possession', () => {
  const binding = { workspaceId: 'ws-native', advSessionId: 123, ownerId: 'su-issued', provider: 'codex' as const };
  const live = { ...binding, endedAt: null, retiredAt: null };
  const issuer: Principal = { workspaceId: binding.workspaceId, slug: 'launch-user', kind: 'user',
    trust: 'verified', authMethod: 'cookie-session', capabilities: new Set(['*']) };
  const bearer = 'a'.repeat(43);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const principalName = `native-runtime:123:${hash(JSON.stringify([
    binding.workspaceId, binding.ownerId, binding.provider,
  ]))}`;
  const receipt = { ...live, name: principalName, bearerHash: hash(bearer) };

  it('mints an unguessable capabilityless credential from the locked canonical runtime', async () => {
    pgMock.responses.push([{ ...live, advSessionId: String(live.advSessionId) }]);
    const issued = await provisionNativeRuntimeBearer({ ...binding, issuer });
    expect(issued.binding).toEqual(binding);
    expect(issued.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pgMock.queries[0]?.text).toContain('FOR UPDATE');
    const principalWrite = pgMock.queries.find(q => q.text.includes('INSERT INTO harness_shared.system_principals'))!;
    expect(principalWrite.text).toContain("'[]'::jsonb");
    expect(principalWrite.values).toContain(hash(issued.bearer));
    expect(principalWrite.values).not.toContain(issued.bearer);
    expect(pgMock.queries.find(q => q.text.includes('INSERT INTO harness_shared.token_index'))?.values)
      .toContain(issued.bearer);
    expect(pgMock.queries.at(-1)?.text).toContain('pg_notify');
  });

  it.each([
    { ...issuer, trust: 'unverified-loopback' as const },
    { ...issuer, capabilities: new Set(['harness:read']) },
    { ...issuer, workspaceId: 'other-workspace' },
  ])('refuses an unverified, limited or foreign issuer before database access', async (invalid) => {
    await expect(provisionNativeRuntimeBearer({ ...binding, issuer: invalid }))
      .rejects.toThrow('native_runtime_issuer_denied');
    expect(pgMock.queries).toHaveLength(0);
  });

  it.each([
    [], [live, live], [{ ...live, workspaceId: 'foreign' }],
    [{ ...live, endedAt: '2026-01-01' }], [{ ...live, retiredAt: '2026-01-01' }],
    [{ ...live, provider: 'unknown' }], [{ ...live, ownerId: null }],
  ].map(rows => ({ rows })))('refuses missing, ambiguous, foreign, ended or invalid issued runtimes', async ({ rows }) => {
    pgMock.responses.push(rows);
    await expect(provisionNativeRuntimeBearer({ ...binding, issuer }))
      .rejects.toThrow('native_runtime_issuance_binding_unavailable');
    expect(pgMock.queries).toHaveLength(1);
  });

  it('rechecks token deletion immediately without cached possession', async () => {
    pgMock.responses.push([{ ...receipt, advSessionId: String(receipt.advSessionId) }], []);
    expect(await verifyNativeRuntimeBearer(bearer, binding)).toBe(true);
    expect(await verifyNativeRuntimeBearer(bearer, binding)).toBe(false);
    expect(pgMock.queries).toHaveLength(2);
  });

  it.each([
    { ...receipt, bearerHash: hash('rotated') }, { ...receipt, name: 'system:operator' },
    { ...receipt, ownerId: 'su-sibling' }, { ...receipt, provider: 'claude' },
    { ...receipt, workspaceId: 'foreign' }, { ...receipt, advSessionId: 124 },
    { ...receipt, endedAt: 'ended' }, { ...receipt, retiredAt: 'retired' },
  ])('rejects mismatched, rotated or ended possession', async (row) => {
    pgMock.responses.push([row]);
    expect(await verifyNativeRuntimeBearer(bearer, binding)).toBe(false);
  });

  it('rejects shared/operator credentials and malformed runtime ids before querying', async () => {
    expect(await verifyNativeRuntimeBearer('shared-bearer', binding)).toBe(false);
    expect(await verifyNativeRuntimeBearer(bearer, { ...binding, advSessionId: -1 })).toBe(false);
    expect(pgMock.queries).toHaveLength(0);
  });
});

describe('startPiSession', () => {
  it('persists exact tool names and a durable expiry with the bearer hash', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await startPiSession({
      workspaceId: 'ws-customer',
      sessionId: 'converse-test',
      capabilities: ['chat:write'],
      allowedTools: ['chat:ask_choice'],
      expiresAt,
    });

    expect(result.sessionId).toBe('converse-test');
    expect(result.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pgMock.queries[0]?.text).toContain('allowed_tools, expires_at');
    expect(pgMock.queries[0]?.values).toContain('ws-customer');
    expect(pgMock.queries[0]?.values).toContain('converse-test');
    expect(pgMock.queries[0]?.values).toContain(JSON.stringify(['chat:write']));
    expect(pgMock.queries[0]?.values).toContain(JSON.stringify(['chat:ask_choice']));
    expect(pgMock.queries[0]?.values).toContain(expiresAt);
  });

  it('rejects an already-expired session before writing anything', async () => {
    await expect(startPiSession({
      workspaceId: 'ws-customer',
      sessionId: 'expired',
      capabilities: [],
      allowedTools: [],
      expiresAt: new Date(Date.now() - 1),
    })).rejects.toThrow('pi_session_expiry_must_be_in_the_future');
    expect(pgMock.queries).toHaveLength(0);
  });
});
