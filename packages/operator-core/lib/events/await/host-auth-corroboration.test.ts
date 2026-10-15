/**
 * WI-6554700010008461 (parked-agent-census-resumption-and-root-cause-2026-10-09 P-011):
 * a psu host record without `authBlocked` predates P-004, so the missing field is UNKNOWN,
 * never `false`. These tests pin the corroboration rule and the census path that misread it:
 * silent-halt classifies a halted session through `readStalledLoopHost` +
 * `classifyStalledLoopHost`, and called three dead-auth codex sessions `stranded` (wake them)
 * instead of `needs-relaunch`. PG-free and fs-free: the rollout read is injected.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_CORROBORATION_TAIL_BYTES,
  corroborateHostAuth,
  hostReportsAuth,
  isProviderAuthFailure,
} from './host-auth-corroboration';
import { classifyStalledLoopHost } from './host-recovery-eligibility';
import { readStalledLoopHost } from '../../harness/routines/stalled-loops-guard';
import type { PsuPtyHost } from './psu-pty-discovery';

const NOW = Date.parse('2026-10-11T07:00:00.000Z');
const STARTED_AT = NOW - 3 * 24 * 60 * 60_000;
const OWNER = 'su-old-code-codex';

const unauthorized = {
  code: 'unauthorized',
  rawCode: 'unauthorized',
  message:
    'Your access token could not be refreshed because you have since logged out or signed in to another ' +
    'account. Please sign in again.',
};

/** A headless, agent-launched host record as pre-P-004 psu-pty-host wrote it: no authBlocked, no caps for it. */
const oldHeadlessHost = {
  ownerId: OWNER,
  advSessionId: '38238',
  startedAt: STARTED_AT,
  bridgeTty: false,
  launchedBy: 'su-launcher',
  caps: ['quota-recovery'],
  quotaBlocked: false,
  lastOutputAt: NOW - 2 * 60 * 60_000,
};

describe('isProviderAuthFailure', () => {
  it('matches the structured codex_error_info, in either spelling of the raw code', () => {
    expect(isProviderAuthFailure(unauthorized)).toBe(true);
    expect(isProviderAuthFailure({ code: 'provider_error', rawCode: 'Unauthorized', message: null })).toBe(true);
  });

  it("matches codex's own copy when the code is generic", () => {
    expect(isProviderAuthFailure({ ...unauthorized, code: 'provider_error', rawCode: 'provider_error' })).toBe(true);
  });

  it('does not match quota or transport failures', () => {
    expect(isProviderAuthFailure({ code: 'usage_limit_exceeded', rawCode: 'usageLimitExceeded', message: null })).toBe(
      false,
    );
    expect(
      isProviderAuthFailure({ code: 'stream_error', rawCode: 'stream_error', message: 'connection reset by peer' }),
    ).toBe(false);
  });
});

describe('corroborateHostAuth', () => {
  it('trusts a host that reports the field either way and never reads the rollout', async () => {
    const read = vi.fn(async () => unauthorized);
    for (const authBlocked of [true, false]) {
      const host = { ...oldHeadlessHost, authBlocked };
      expect(hostReportsAuth(host)).toBe(true);
      expect(await corroborateHostAuth(host, read)).toBe(host);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('marks an old host auth-blocked when its latest codex terminal since host start is an auth failure', async () => {
    const read = vi.fn(async () => unauthorized);
    const out = await corroborateHostAuth(oldHeadlessHost, read);
    expect(out.authBlocked).toBe(true);
    expect(out.authBlockedSource).toBe('codex-rollout');
    expect(read).toHaveBeenCalledWith('38238', STARTED_AT, AUTH_CORROBORATION_TAIL_BYTES);
  });

  it('leaves the host unchanged when the latest terminal succeeded or is not an auth failure', async () => {
    expect(await corroborateHostAuth(oldHeadlessHost, async () => null)).toBe(oldHeadlessHost);
    const quota = { code: 'usage_limit_exceeded', rawCode: 'usageLimitExceeded', message: null };
    expect(await corroborateHostAuth(oldHeadlessHost, async () => quota)).toBe(oldHeadlessHost);
  });

  it('reads nothing for a missing or path-unsafe session key, and an unknown start counts every terminal', async () => {
    const read = vi.fn(async () => unauthorized);
    expect(await corroborateHostAuth({ ...oldHeadlessHost, advSessionId: null }, read)).toMatchObject({
      advSessionId: null,
    });
    expect(await corroborateHostAuth({ ...oldHeadlessHost, advSessionId: '../escape' }, read)).not.toHaveProperty(
      'authBlockedSource',
    );
    expect(read).not.toHaveBeenCalled();
    await corroborateHostAuth({ ...oldHeadlessHost, startedAt: null }, read);
    expect(read).toHaveBeenCalledWith('38238', 0, AUTH_CORROBORATION_TAIL_BYTES);
  });

  it('a throwing rollout read is no reading', async () => {
    const out = await corroborateHostAuth(oldHeadlessHost, async () => {
      throw new Error('EACCES');
    });
    expect(out).toBe(oldHeadlessHost);
  });
});

describe('the census path: readStalledLoopHost → classifyStalledLoopHost (silent-halt, stalled-loops guard)', () => {
  const deps = (error: Awaited<ReturnType<NonNullable<Parameters<typeof corroborateHostAuth>[1]>>>) => ({
    findHost: vi.fn(async () => oldHeadlessHost as unknown as PsuPtyHost),
    readTail: vi.fn(async () => []),
    readProviderError: vi.fn(async () => error),
  });

  it('POSITIVE CONTROL: an old host whose latest turn succeeded classifies healthy', async () => {
    const d = deps(null);
    const reading = await readStalledLoopHost(OWNER, d);
    expect(d.readProviderError).toHaveBeenCalledTimes(1);
    expect(classifyStalledLoopHost(reading, OWNER, NOW)).toEqual({ kind: 'healthy' });
  });

  it('an old dead-auth host classifies needs-relaunch: it predates automatic auth recovery', async () => {
    const reading = await readStalledLoopHost(OWNER, deps(unauthorized));
    const cls = classifyStalledLoopHost(reading, OWNER, NOW);
    expect(cls.kind).toBe('needs-relaunch');
    if (cls.kind !== 'needs-relaunch') throw new Error('unreachable');
    expect(cls.condition).toBe('auth-blocked');
    expect(cls.why).toContain('host-capability-missing');
  });

  it('an interactive (bridged) old dead-auth host names the owner restart remedy', async () => {
    const d = deps(unauthorized);
    d.findHost.mockResolvedValue({ ...oldHeadlessHost, bridgeTty: true } as unknown as PsuPtyHost);
    const cls = classifyStalledLoopHost(await readStalledLoopHost(OWNER, d), OWNER, NOW);
    expect(cls.kind).toBe('needs-relaunch');
    if (cls.kind !== 'needs-relaunch') throw new Error('unreachable');
    expect(cls.why).toContain('not-headless');
  });

  it('no live host reads nothing else', async () => {
    const d = deps(unauthorized);
    d.findHost.mockResolvedValue(null as unknown as PsuPtyHost);
    expect(await readStalledLoopHost(OWNER, d)).toEqual({ host: null, events: [] });
    expect(d.readTail).not.toHaveBeenCalled();
    expect(d.readProviderError).not.toHaveBeenCalled();
  });
});
