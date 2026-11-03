/**
 * WI-6554700010029514 — the consult router's Codex preflight must refuse exactly
 * when the psu launcher refuses. Before this, the router asked the local account
 * pool (`anyAccountAvailable`) while the launcher asked the gateway `/stats`, so
 * the router launched converts that died at boot with "REFUSING TO LAUNCH —
 * Codex auto-route has no serviceable accounts" and recorded them as avoidable
 * launch failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCodexGatewayRefusal,
  codexGatewayLaunchRefusal,
  defaultProbeBackendAvailable,
  readCodexGatewayPoolStats,
  type CodexGatewayPoolStats,
} from './consult-dispatch';
// The launcher is the authority this preflight mirrors; pin to it, never to a copy.
import { codexAutoPoolVerdict } from '../../../../apps/operator/scripts/psu-launcher.mjs';
import { normalizeCodexCliModel } from '../model-context-budget.mjs';
import { accountFull, emptyPool, isSpawnEligible, registerAccount } from '../deployment/account-pool';

const routing = vi.hoisted(() => ({ loadAccountPool: vi.fn(), getFlag: vi.fn() }));
vi.mock('../deployment/account-pool-store', () => ({ loadAccountPool: routing.loadAccountPool }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: routing.getFlag }));

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const FUTURE = NOW + 15 * 60_000;
const PAST = NOW - 60_000;

describe('live consult account preflight', () => {
  let gatewayFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    routing.getFlag.mockResolvedValue(true);
    gatewayFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      codexHealthyAccounts: 1, codexTotalAccounts: 1, codexEarliestRecoveryAt: null,
    })));
    vi.stubGlobal('fetch', gatewayFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function pausedPool(provider: 'codex' | 'claude' = 'codex') {
    const pool = registerAccount(emptyPool(), {
      id: 'reviewer', provider, credentialRef: 'file:/test/reviewer',
    }, NOW);
    Object.assign(pool.accounts[0]!.rate, {
      pausedUntil: FUTURE, utilization: 0.2, utilization7d: 0.3,
      utilizationAt: NOW, penaltyCount: 1, windowStartedAt: NOW,
    });
    return pool;
  }

  it('does not veto a serviceable Codex auto route from a predictive local pause', async () => {
    const pool = pausedPool();
    expect(accountFull(pool.accounts[0]!, NOW)).toBe(true);
    expect(isSpawnEligible(pool.accounts[0]!, NOW)).toBe(true);
    routing.loadAccountPool.mockResolvedValue(pool);

    await expect(defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol'))
      .resolves.toMatchObject({ available: true, accountRoute: 'auto' });
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });

  it.each(['usage', 'credential', 'sustained'] as const)('retains a measured %s wall', async (wall) => {
    const pool = pausedPool();
    const account = pool.accounts[0]!;
    if (wall === 'usage') account.rate.utilization7d = 1;
    if (wall === 'credential') account.credentialFailure = { observedAt: NOW, ownerId: 'test' };
    if (wall === 'sustained') account.rate.penaltyCount = 3;
    expect(isSpawnEligible(account, NOW)).toBe(false);
    routing.loadAccountPool.mockResolvedValue(pool);

    await expect(defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol'))
      .resolves.toMatchObject({ available: false, failureReason: 'account-walled' });
  });

  it('still refuses a model the gateway cannot serve after a predictive local pause', async () => {
    routing.loadAccountPool.mockResolvedValue(pausedPool());
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      codexHealthyAccounts: 1, codexTotalAccounts: 1, codexEarliestRecoveryAt: null,
      codexServiceableByModel: { [normalizeCodexCliModel('sol')]: 0 },
    })));
    const verdict = await defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol');
    expect(verdict).toMatchObject({ available: false, failureReason: 'account-walled' });
    expect(verdict.routeReason).toContain('refuses model');
  });

  it('preserves launcher pacing for a temporary Codex cooldown', async () => {
    routing.loadAccountPool.mockResolvedValue(pausedPool());
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      codexHealthyAccounts: 0, codexTotalAccounts: 1, codexEarliestRecoveryAt: FUTURE,
      codexUnserviceableCause: 'temporary-cooldown',
    })));
    await expect(defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol'))
      .resolves.toMatchObject({ available: true, accountRoute: 'auto' });
  });

  it('retains a genuine gateway account wall despite local budget eligibility', async () => {
    routing.loadAccountPool.mockResolvedValue(pausedPool());
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      codexHealthyAccounts: 0, codexTotalAccounts: 1, codexEarliestRecoveryAt: FUTURE,
      codexUnserviceableCause: 'accounts-unserviceable',
    })));
    await expect(defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol'))
      .resolves.toMatchObject({ available: false, failureReason: 'account-walled' });
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });

  it('retains launcher fail-open behavior for unknown gateway stats with budget eligible accounts', async () => {
    routing.loadAccountPool.mockResolvedValue(pausedPool());
    gatewayFetch.mockRejectedValue(new Error('unavailable'));
    await expect(defaultProbeBackendAvailable('codex', 'ws-preflight', 'sol'))
      .resolves.toMatchObject({ available: true, accountRoute: 'auto' });
  });

  it('keeps the strict pause guard for Claude launches', async () => {
    routing.loadAccountPool.mockResolvedValue(pausedPool('claude'));
    await expect(defaultProbeBackendAvailable('claude', 'ws-preflight', 'opus'))
      .resolves.toMatchObject({ available: false, failureReason: 'account-walled' });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});

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

describe('codexGatewayLaunchRefusal is model-aware, like the launcher (WI-6554700010030413)', () => {
  // Measured 2026-10-27 19:02Z: one serviceable account refused the allowed Codex
  // models (the alias sol among them) but served gpt-6-luna. The router walled no
  // rank and paid a headless launch per rank that psu then refused for its model.
  const SOL = normalizeCodexCliModel('sol');
  const stats: CodexGatewayPoolStats = {
    codexHealthyAccounts: 1, codexTotalAccounts: 8, codexEarliestRecoveryAt: null,
    codexServiceableByModel: { [SOL]: 0, 'gpt-6.1-sol': 0, 'GPT-6-Astra': 0, 'gpt-6-luna': 1 },
  };
  const MODELS = ['sol', 'sol:high', 'gpt-6.1-sol', 'gpt-6.1-sol[1m]', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-terra', null];

  it.each(MODELS)('model %s: refuses exactly when codexAutoPoolVerdict refuses', (model) => {
    const launcher = codexAutoPoolVerdict({ agent: 'codex', model, account: 'auto', stats: asLauncherStats(stats), now: NOW });
    expect(codexGatewayLaunchRefusal(stats, NOW, model) !== null).toBe(launcher.kind === 'refuse');
  });

  it('walls every model measured at zero, aliases and suffixes included, and no other', () => {
    expect(MODELS.filter((model) => codexGatewayLaunchRefusal(stats, NOW, model) !== null))
      .toEqual(['sol', 'sol:high', 'gpt-6.1-sol', 'gpt-6.1-sol[1m]', 'gpt-6-astra']);
    expect(codexGatewayLaunchRefusal(stats, NOW, 'sol')).toMatchObject({
      failureReason: 'account-walled', recoveryAt: null, routeReason: expect.stringContaining(`refuses model ${SOL}`),
    });
  });

  it('answers provider-wide when no model is given or the map has no reading', () => {
    expect(codexGatewayLaunchRefusal(stats, NOW)).toBeNull();
    expect(codexGatewayLaunchRefusal({ ...stats, codexServiceableByModel: undefined }, NOW, 'sol')).toBeNull();
  });

  it('narrows an available auto route by the rank model', () => {
    const available = { available: true, accountRoute: 'auto' as const, detail: 'codex pool has headroom' };
    expect(applyCodexGatewayRefusal(available, 'codex', stats, NOW, 'gpt-6-luna')).toBe(available);
    expect(applyCodexGatewayRefusal(available, 'codex', stats, NOW, 'gpt-6.1-sol'))
      .toMatchObject({ available: false, accountRoute: 'auto', failureReason: 'account-walled' });
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
