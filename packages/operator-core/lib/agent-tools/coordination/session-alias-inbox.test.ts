/**
 * WI-10005678: a verified spawn session (an acceptance judge launched over an
 * HMAC-signed role-scoped spawn URL) resolves its coord identity as
 * `system:judge/<id>`, but peers, its inbox-wake key and the ship recruiter all
 * address the bare `<id>`. Measured 2026-10-02: judge su-69d54c2d read `total 0`
 * for four messages addressed to its bare id, and the implementer's
 * `coord:inbox { from: '<bare id>' }` missed the judge's reply.
 *
 * These tests pin the three pieces of the fix: which callers get the bare-id
 * alias (only a trusted spawn-url `system:` principal whose owner id is exactly
 * `<slug>/<client>`), the directed-only alias read, and the sender filter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, readLinesMock, fastPathState } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  readLinesMock: vi.fn(async () => [] as unknown[]),
  fastPathState: { on: false },
}));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import { mergeInboxEntries, readDirectedInbox } from './messages';
import { operationCallerId, senderMatchesFilter, verifiedSpawnSessionAlias } from './identity';

const JUDGE = 'su-69d54c2d-cdb7-44a2-b296-549e9767c36f';
const JUDGE_OWNER = `system:judge/${JUDGE}`;

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-10-02T21:20:21.000Z',
    msg_id: 'm1',
    from: 'su-d5eaa301',
    to: [JUDGE],
    kind: 'message',
    ...p,
  } as CoordEnvelope;
}

function primeSql(rows: { body: unknown }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (!text.includes('SELECT')) return { fragment: text, values };
    seen.push({ text, values });
    return Promise.resolve(rows);
  });
  return seen;
}

const trustedSpawn = { slug: 'system:judge', authMethod: 'spawn-url', trust: 'trusted' };

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = true;
  readLinesMock.mockResolvedValue([]);
});

describe('verifiedSpawnSessionAlias', () => {
  it('returns the bare client id for a trusted spawn-url system principal', () => {
    // The owner id is built by the same function resolveAgentIdentity uses, so a
    // change to the namespacing shape cannot silently disable the alias.
    const ownerId = operationCallerId('system:judge', JUDGE);
    expect(ownerId).toBe(JUDGE_OWNER);
    expect(verifiedSpawnSessionAlias({ principal: trustedSpawn, uiClientId: JUDGE }, ownerId)).toBe(JUDGE);
  });

  it.each([
    ['a bearer-token principal (client= is caller-chosen)', { ...trustedSpawn, authMethod: 'bearer-token' }],
    ['the unsigned legacy spawn fallback', { ...trustedSpawn, authMethod: 'host-loopback', trust: 'unverified-loopback' }],
    ['a spawn-url principal that is not trusted', { ...trustedSpawn, trust: 'unverified-loopback' }],
    ['a non-system principal', { slug: 'app:abc', authMethod: 'spawn-url', trust: 'trusted' }],
  ])('refuses %s', (_label, principal) => {
    const ownerId = operationCallerId(principal.slug, JUDGE);
    expect(verifiedSpawnSessionAlias({ principal, uiClientId: JUDGE }, ownerId)).toBeNull();
  });

  it('refuses when the resolved owner id is not <slug>/<client>', () => {
    expect(verifiedSpawnSessionAlias({ principal: trustedSpawn, uiClientId: JUDGE }, 'su-someone-else')).toBeNull();
    expect(verifiedSpawnSessionAlias({ principal: trustedSpawn, uiClientId: 'other' }, JUDGE_OWNER)).toBeNull();
  });

  it('refuses with no principal or no client', () => {
    expect(verifiedSpawnSessionAlias({ principal: null, uiClientId: JUDGE }, JUDGE_OWNER)).toBeNull();
    expect(verifiedSpawnSessionAlias({ principal: trustedSpawn, uiClientId: '' }, 'system:judge')).toBeNull();
  });
});

describe('senderMatchesFilter', () => {
  it('matches the exact sender and the system-namespaced form of a bare id', () => {
    expect(senderMatchesFilter(JUDGE, JUDGE)).toBe(true);
    expect(senderMatchesFilter(JUDGE_OWNER, JUDGE)).toBe(true);
    expect(senderMatchesFilter(JUDGE_OWNER, JUDGE_OWNER)).toBe(true);
  });

  it('does not widen to other namespaces, nested ids, or different ids', () => {
    expect(senderMatchesFilter(`app:abc/${JUDGE}`, JUDGE)).toBe(false);
    expect(senderMatchesFilter(`system:judge/x/${JUDGE}`, JUDGE)).toBe(false);
    expect(senderMatchesFilter('system:judge/su-other', JUDGE)).toBe(false);
    expect(senderMatchesFilter(undefined, JUDGE)).toBe(false);
  });
});

describe('readDirectedInbox', () => {
  it('pushes down an explicit-recipient predicate with no broadcast arm', async () => {
    const seen = primeSql([{ body: env() }]);
    const out = await readDirectedInbox(JUDGE);
    expect(out.map((e) => e.msg_id)).toEqual(['m1']);
    expect(seen).toHaveLength(1);
    const text = seen[0]!.text.replace(/\s+/g, ' ');
    expect(text).toContain("(body->'to') ?");
    expect(text).not.toContain("? '*'");
    expect(seen[0]!.values).toContain(JUDGE);
  });

  it('drops a broadcast even if one reaches the post-filter', async () => {
    fastPathState.on = false;
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'direct' }),
      env({ msg_id: 'broadcast', to: ['*'] }),
      env({ msg_id: 'other', to: ['su-other'] }),
    ]);
    const out = await readDirectedInbox(JUDGE);
    expect(out.map((e) => e.msg_id)).toEqual(['direct']);
  });

  it('returns nothing for an empty id without querying', async () => {
    const seen = primeSql([]);
    expect(await readDirectedInbox('')).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe('mergeInboxEntries', () => {
  it('adds alias-only messages, dedupes shared ones, and keeps ascending (ts, msg_id) order', () => {
    const own = [
      env({ msg_id: 'b', ts: '2026-10-02T21:00:00.000Z', to: ['*'] }),
      env({ msg_id: 'd', ts: '2026-10-02T21:30:00.000Z', to: [JUDGE_OWNER] }),
    ];
    const alias = [
      env({ msg_id: 'c', ts: '2026-10-02T21:20:00.000Z' }),
      env({ msg_id: 'd', ts: '2026-10-02T21:30:00.000Z', to: [JUDGE_OWNER, JUDGE] }),
    ];
    const merged = mergeInboxEntries(own, alias);
    expect(merged.map((e) => e.msg_id)).toEqual(['b', 'c', 'd']);
    // base wins on a collision
    expect(merged[2]!.to).toEqual([JUDGE_OWNER]);
  });

  it('returns a copy of base when there is nothing to add', () => {
    const own = [env({ msg_id: 'a' })];
    const merged = mergeInboxEntries(own, []);
    expect(merged).toEqual(own);
    expect(merged).not.toBe(own);
  });
});
