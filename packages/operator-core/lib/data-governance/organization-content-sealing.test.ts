/**
 * Unit tests for organization document sealing (WI-6554700010012443 U2, plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09#D-020). The real-Postgres journey (seal on write,
 * search, revoke) is organization-content-sealing.integration.test.ts.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  contentSealing,
  openDocument,
  positiveQueryLexemes,
  sealedCandidateLimit,
  SEALED_DOCUMENT_FORMAT,
  workspaceOrganization,
  type ContentSealing,
} from './organization-content-sealing';
import { BLIND_TOKEN_CHARS, OrganizationKeyUnavailableError, blindToken } from './organization-keys';

/** A tagged-template stand-in that answers every query with `rows`. */
function fakeSql(rows: unknown[]): Sql {
  return (async () => rows) as unknown as Sql;
}

const key = (byte: number) => Buffer.alloc(32, byte);

/** An identity "cipher": tests the JSON framing, not the envelope (organization-keys covers that). */
function plainService(): ContentSealing['service'] {
  return {
    encrypt: async (_org: string, _scope: string, data: Buffer) => data,
    decrypt: async (_org: string, _scope: string, blob: Buffer) => blob,
    blindIndexKeys: async () => ({ active: { dekVersion: 1, key: key(1) }, all: [{ dekVersion: 1, key: key(1) }] }),
  } as unknown as ContentSealing['service'];
}

describe('positiveQueryLexemes', () => {
  it('keeps required, optional and phrase lexemes and drops a directly negated one', () => {
    expect(positiveQueryLexemes("'quarter' & 'revenu' & !'forecast' & 'board' <-> 'meet' | 'invoic'"))
      .toEqual(['quarter', 'revenu', 'board', 'meet', 'invoic']);
  });

  it('keeps lexemes inside a negated phrase (the exact match after decryption removes the extra rows)', () => {
    expect(positiveQueryLexemes("'o' <-> 'brien' & !( 'secret' <-> 'plan' )")).toEqual(['o', 'brien', 'secret', 'plan']);
  });

  it('unescapes a doubled quote and returns nothing for an empty query', () => {
    expect(positiveQueryLexemes("'it''s'")).toEqual(["it's"]);
    expect(positiveQueryLexemes('')).toEqual([]);
  });
});

describe('blindToken', () => {
  it('is deterministic per key, fixed-length, and differs across keys', () => {
    const a = blindToken(key(1), 'revenu');
    expect(a).toHaveLength(BLIND_TOKEN_CHARS);
    expect(blindToken(key(1), 'revenu')).toBe(a);
    expect(blindToken(key(2), 'revenu')).not.toBe(a);
    expect(blindToken(key(1), 'forecast')).not.toBe(a);
    expect(a).not.toContain('revenu');
  });
});

describe('openDocument', () => {
  const sealing = { organizationId: 'org-1', service: plainService() };

  it('round-trips the sealed JSON frame', async () => {
    const blob = Buffer.from(JSON.stringify({ v: SEALED_DOCUMENT_FORMAT, title: 'T', text: 'body' }));
    await expect(openDocument(sealing, blob)).resolves.toEqual({ title: 'T', text: 'body' });
  });

  it('fails closed with a typed error on a frame it does not recognize', async () => {
    for (const blob of [Buffer.from('not json'), Buffer.from(JSON.stringify({ v: 99, title: 'T', text: 'x' }))]) {
      const err = await openDocument(sealing, blob).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
      expect((err as OrganizationKeyUnavailableError).code).toBe('envelope-malformed');
    }
  });
});

describe('contentSealing', () => {
  it('is null for a workspace with no organization or no key custody', async () => {
    await expect(contentSealing(fakeSql([]), 'ws')).resolves.toBeNull();
    await expect(contentSealing(fakeSql([{ organization_id: 'org-1' }]), 'ws', { custodyState: async () => null })).resolves.toBeNull();
  });

  it('seals whenever custody exists, and a revoked key fails closed instead of falling back to plaintext', async () => {
    const ok = await contentSealing(fakeSql([{ organization_id: 'org-1' }]), 'ws', {
      custodyState: async () => 'enabled',
      keyService: plainService,
    });
    expect(ok?.organizationId).toBe('org-1');
    expect(ok?.keys.active.dekVersion).toBe(1);

    const revoked = new OrganizationKeyUnavailableError('org-1', 'organization-key-revoked', 'revoked');
    const err = await contentSealing(fakeSql([{ organization_id: 'org-1' }]), 'ws', {
      custodyState: async () => 'revoked',
      keyService: () => ({ ...plainService(), blindIndexKeys: async () => { throw revoked; } }),
    }).then(() => null, (e: unknown) => e);
    expect(err).toBe(revoked);
  });

  it('refuses a workspace that resolves to two organizations', async () => {
    await expect(workspaceOrganization(fakeSql([{ organization_id: 'a' }, { organization_id: 'b' }]), 'ws'))
      .rejects.toThrow(/more than one organization/);
  });
});

describe('sealedCandidateLimit', () => {
  it('decrypts 20 candidates per result, capped at 500', () => {
    expect(sealedCandidateLimit(1)).toBe(20);
    expect(sealedCandidateLimit(10)).toBe(200);
    expect(sealedCandidateLimit(50)).toBe(500);
    expect(sealedCandidateLimit(0)).toBe(20);
  });
});
