/**
 * WI-10004357: the auth-audit session HMAC is keyed off the superuser token the
 * operator actually authenticates with — `$PAPERCUSP_HOME/superuser-token` when a
 * scoped home is set — not a hardcoded `~/.papercusp` path. A different key would
 * still hash, so only an exact expected digest catches a wrong source.
 */

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hmacSessionToken never touches PG; stub the pool so importing the module opens nothing.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: Object.assign(vi.fn(), { begin: vi.fn() }) }),
}));

describe('hmacSessionToken key source (WI-10004357)', () => {
  let home: string;
  const savedHome = process.env.PAPERCUSP_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'auth-audit-token-'));
    process.env.PAPERCUSP_HOME = home;
    // The key is cached per module instance; each case needs a fresh one.
    vi.resetModules();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keys the HMAC with the token in $PAPERCUSP_HOME', async () => {
    const token = 'scoped-home-token-0123456789abcdef';
    writeFileSync(join(home, 'superuser-token'), `${token}\n`, { mode: 0o600 });
    const { hmacSessionToken } = await import('./auth-audit');

    const expected = createHmac('sha256', Buffer.from(token, 'utf8'))
      .update('session-abc')
      .digest('hex')
      .slice(0, 16);
    expect(hmacSessionToken('session-abc')).toBe(expected);
  });

  it('falls back to an ephemeral key, never another home, when the scoped token is too short', async () => {
    writeFileSync(join(home, 'superuser-token'), 'short\n', { mode: 0o600 });
    const { hmacSessionToken } = await import('./auth-audit');

    const fromShort = createHmac('sha256', Buffer.from('short', 'utf8'))
      .update('session-abc')
      .digest('hex')
      .slice(0, 16);
    const first = hmacSessionToken('session-abc');
    expect(first).not.toBe(fromShort);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // Stable within the process, so rows written by one operator still correlate.
    expect(hmacSessionToken('session-abc')).toBe(first);
  });
});
