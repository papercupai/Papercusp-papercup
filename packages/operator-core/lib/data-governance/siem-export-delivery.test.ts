import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { SIEM_MIN_KEY_BYTES, SiemExportAccessError, siemStreamId } from './siem-export';
import { assertOrgAuditExportAuthorized, orgAuditStreamId } from './siem-export-org-audit';
import {
  SIEM_EXPORT_KEY_REF_ENV,
  SiemExportError,
  resolveSiemExportKey,
  siemExportAck,
  siemKeyId,
  siemStreamIdOf,
} from './siem-export-delivery';

const LONG = 'x'.repeat(SIEM_MIN_KEY_BYTES);

/** A Sql that fails the test if anything reaches the database. */
const NO_SQL = new Proxy(() => undefined, {
  apply() {
    throw new Error('the database was reached');
  },
  get() {
    throw new Error('the database was reached');
  },
}) as unknown as Sql;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof SiemExportError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('resolveSiemExportKey — key custody (D-018 item 8)', () => {
  it('refuses with key_unconfigured when the reference env var is unset or blank', async () => {
    expect(await codeOf(resolveSiemExportKey({ env: {} }))).toBe('key_unconfigured');
    expect(await codeOf(resolveSiemExportKey({ env: { [SIEM_EXPORT_KEY_REF_ENV]: '   ' } }))).toBe('key_unconfigured');
  });

  it('resolves the trimmed reference through the injected resolver, never reading the value from the env var itself', async () => {
    const seen: string[] = [];
    const out = await resolveSiemExportKey({
      env: { [SIEM_EXPORT_KEY_REF_ENV]: '  env:SIEM_KEY  ' },
      resolve: async (ref) => {
        seen.push(ref);
        return LONG;
      },
    });
    expect(seen).toEqual(['env:SIEM_KEY']);
    expect(Buffer.from(out.key).toString('utf8')).toBe(LONG);
    expect(out.keyId).toBe(siemKeyId(new Uint8Array(Buffer.from(LONG))));
  });

  it('refuses a key shorter than the minimum, and the refusal never carries the value', async () => {
    const short = 'secret-but-short';
    const p = resolveSiemExportKey({ env: { [SIEM_EXPORT_KEY_REF_ENV]: 'env:K' }, resolve: async () => short });
    await expect(p).rejects.toMatchObject({ code: 'key_too_short' });
    await expect(p).rejects.not.toThrow(short);
  });
});

describe('siemKeyId and siemStreamIdOf', () => {
  it("names a key 'k:' plus the first 16 hex characters of its sha256", () => {
    const key = new Uint8Array(Buffer.from(LONG));
    expect(siemKeyId(key)).toBe(`k:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
    expect(siemKeyId(key)).toMatch(/^k:[0-9a-f]{16}$/);
  });

  it('routes each stream kind to its own stream id', () => {
    expect(siemStreamIdOf({ kind: 'tool-invocations', workspaceId: 'ws-1' })).toBe(siemStreamId('ws-1'));
    expect(siemStreamIdOf({ kind: 'org-audit', organizationId: 'org-1' })).toBe(orgAuditStreamId('org-1'));
    expect(siemStreamIdOf({ kind: 'org-audit', organizationId: 'org-1' })).not.toBe(siemStreamIdOf({ kind: 'tool-invocations', workspaceId: 'org-1' }));
  });
});

describe('siemExportAck input validation — refused before authorization or any database read', () => {
  const stream = { kind: 'tool-invocations', workspaceId: 'ws-1' } as const;

  it('refuses an idempotency key that is not 64 lowercase hex characters', async () => {
    for (const idempotencyKey of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(await codeOf(siemExportAck({ principal: 'admin:x', stream, idempotencyKey, cursorTo: '9', sql: NO_SQL })), idempotencyKey).toBe(
        'bad_request',
      );
    }
  });

  it('refuses a blank cursorTo', async () => {
    expect(await codeOf(siemExportAck({ principal: 'admin:x', stream, idempotencyKey: 'a'.repeat(64), cursorTo: '  ', sql: NO_SQL }))).toBe(
      'bad_request',
    );
  });
});

describe('restricted organization audit authorization', () => {
  it('refuses non-human readers before looking up an organization or its audit records', async () => {
    for (const principal of ['su-agent-1', 'pot:customer-worker', '']) {
      await expect(assertOrgAuditExportAuthorized(
        principal, '33333333-3333-4333-8333-333333333333', { sql: NO_SQL },
      )).rejects.toBeInstanceOf(SiemExportAccessError);
    }
  });
});
