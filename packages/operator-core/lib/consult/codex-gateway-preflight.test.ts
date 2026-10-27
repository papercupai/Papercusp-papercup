/**
 * WI-6554700010029514 — the consult router's Codex preflight must refuse exactly
 * when the psu launcher refuses. Before this, the router asked the local account
 * pool (`anyAccountAvailable`) while the launcher asked the gateway `/stats`, so
 * the router launched converts that died at boot with "REFUSING TO LAUNCH —
 * Codex auto-route has no serviceable accounts" and recorded them as avoidable
 * launch failures.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCodexGatewayRefusal,
  codexGatewayLaunchRefusal,
  readCodexGatewayPoolStats,
  type CodexGatewayPoolStats,
} from './consult-dispatch';
// The launcher is the authority this preflight mirrors; pin to it, never to a copy.
import { codexAutoPoolVerdict } from '../../../../apps/operator/scripts/psu-launcher.mjs';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const FUTURE = NOW + 15 * 60_000;
const PAST = NOW - 60_000;

const FIXTURES: Array<[string, CodexGatewayPoolStats | null | undefined]> = [
  ['no stats', undefined],
  ['null stats', null],
  ['healthy accounts', { codexHealthyAccounts: 2, codexTotalAccounts: 8, codexEarliestRecoveryAt: null }],
  ['unserviceable, future recovery', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: FUTURE, codexUnserviceableCause: 'accounts-unserviceable' }],
  ['unserviceable, recovery unknown', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: null, codexUnserviceableCause: 'accounts-unserviceable' }],
  ['unserviceable, recovery already passed', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: PAST, codexUnserviceableCause: 'accounts-unserviceable' }],
  ['temporary cooldown', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: FUTURE, codexUnserviceableCause: 'temporary-cooldown' }],
  ['upstream unreachable', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: null, codexUnserviceableCause: 'upstream-unreachable' }],
  ['upstream unreachable with past horizon', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: PAST, codexUnserviceableCause: 'upstream-unreachable' }],
  ['fully walled, no cause', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: FUTURE }],
  ['legacy snapshot without recovery field', { codexHealthyAccounts: 0, codexTotalAccounts: 8 }],
  ['empty pool', { codexHealthyAccounts: 0, codexTotalAccounts: 0, codexEarliestRecoveryAt: null }],
  ['string total', { codexHealthyAccounts: 0, codexTotalAccounts: '8', codexEarliestRecoveryAt: null }],
  ['invalid recovery', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: 'soon' }],
  ['non-finite recovery', { codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: Number.NaN }],
  ['healthy unknown', { codexHealthyAccounts: null, codexTotalAccounts: 8, codexEarliestRecoveryAt: null }],
];

// The fixtures deliberately carry malformed and legacy snapshots, exactly as a live
// /stats read can return them; the launcher's static type only names the good shape.
type LauncherStats = NonNullable<Parameters<typeof codexAutoPoolVerdict>[0]>['stats'];
const asLauncherStats = (stats: unknown): LauncherStats => stats as LauncherStats;

describe('codexGatewayLaunchRefusal parity with the psu launcher', () => {
  it.each(FIXTURES)('%s: refuses exactly when codexAutoPoolVerdict refuses', (_label, stats) => {
    const launcher = codexAutoPoolVerdict({ agent: 'codex', model: 'gpt-6-astra', account: 'auto', stats: asLauncherStats(stats), now: NOW });
    const refusal = codexGatewayLaunchRefusal(stats, NOW);
    expect(refusal !== null).toBe(launcher.kind === 'refuse');
    if (refusal) expect(refusal.recoveryAt).toBe(launcher.recoveryAt);
  });

  it('covers both refuse and launch outcomes, so parity is not vacuous', () => {
    const kinds = new Set(FIXTURES.map(([, stats]) =>
      codexAutoPoolVerdict({ agent: 'codex', model: 'gpt-6-astra', account: 'auto', stats: asLauncherStats(stats), now: NOW }).kind));
    expect(kinds).toEqual(new Set(['proceed', 'warn', 'refuse']));
  });

  it('classifies an upstream outage as routing-unavailable, not an account wall', () => {
    expect(codexGatewayLaunchRefusal({
      codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: null, codexUnserviceableCause: 'upstream-unreachable',
    }, NOW)?.failureReason).toBe('account-routing-unavailable');
    expect(codexGatewayLaunchRefusal({
      codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: FUTURE, codexUnserviceableCause: 'accounts-unserviceable',
    }, NOW)?.failureReason).toBe('account-walled');
  });
});

describe('applyCodexGatewayRefusal', () => {
  const available = { available: true, accountRoute: 'auto' as const, detail: 'codex pool has headroom (8 account(s))' };
  const walled: CodexGatewayPoolStats = {
    codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: FUTURE, codexUnserviceableCause: 'accounts-unserviceable',
  };

  it('turns a local-pool "headroom" verdict into an account-walled skip when the gateway would refuse', () => {
    const out = applyCodexGatewayRefusal(available, 'codex', walled, NOW);
    expect(out.available).toBe(false);
    expect(out.failureReason).toBe('account-walled');
    expect(out.detail).toContain('no serviceable accounts (0 of 8)');
    expect(out.detail).toContain('launcher would refuse');
  });

  it('fails open when the gateway snapshot is unavailable, exactly like the launcher', () => {
    expect(applyCodexGatewayRefusal(available, 'codex', undefined, NOW)).toBe(available);
  });

  it('never narrows Claude, the default route, or an already-unavailable verdict', () => {
    expect(applyCodexGatewayRefusal(available, 'claude', walled, NOW)).toBe(available);
    const defaultRoute = { available: true, accountRoute: 'default' as const, detail: 'gateway disabled' };
    expect(applyCodexGatewayRefusal(defaultRoute, 'codex', walled, NOW)).toBe(defaultRoute);
    const unavailable = { available: false, failureReason: 'account-routing-unavailable' as const, detail: 'x' };
    expect(applyCodexGatewayRefusal(unavailable, 'codex', walled, NOW)).toBe(unavailable);
  });
});

describe('readCodexGatewayPoolStats', () => {
  it('returns the parsed /stats body', async () => {
    const fake = (async () => new Response(JSON.stringify({ codexHealthyAccounts: 0, codexTotalAccounts: 8 }), { status: 200 })) as typeof fetch;
    await expect(readCodexGatewayPoolStats(fake)).resolves.toEqual({ codexHealthyAccounts: 0, codexTotalAccounts: 8 });
  });

  it('is undefined (unknown, never a wall) on HTTP failure or a thrown fetch', async () => {
    const notOk = (async () => new Response('down', { status: 503 })) as typeof fetch;
    const thrown = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    await expect(readCodexGatewayPoolStats(notOk)).resolves.toBeUndefined();
    await expect(readCodexGatewayPoolStats(thrown)).resolves.toBeUndefined();
  });
});
