import { describe, it, expect, beforeAll } from 'vitest';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so we can
// unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

let externalStallReason: (s: unknown, selfHealAtFreezeStart: number) => string | null;
let deadProxyAlerts: (
  s: unknown,
  opts?: { minAttempts?: number; rateThreshold?: number },
) => Array<{ accountId: string; rate: number; attempts: number; fails: number }>;
let upstreamTransportAlerts: (
  s: unknown,
  opts?: { minAttempts?: number; rateThreshold?: number },
) => Array<{ accountId: string; rate: number; attempts: number; fails: number }>;
let egressPoolDownAlert: (
  s: unknown,
) => { totalProxyEntries: number; reachableProxyEntries: number } | null;
let sharedDirectEgressAlert: (
  s: unknown,
) => { accountCount: number; directRouteCount: number; sampledDirectRouteCount: number; distinctDirectExitIpCount: number } | null;
beforeAll(async () => {
  ({ externalStallReason, deadProxyAlerts, upstreamTransportAlerts, egressPoolDownAlert, sharedDirectEgressAlert } = await import('./watchdog.mjs'));
});

/**
 * EI-2421: the watchdog's frozen-while-saturated restart signature ALSO fires when the whole account
 * pool is rate-limit exhausted (nothing trickles → totalRequests frozen) or while the gateway's own
 * self-heal valve is draining the wedge. Restarting then is pure harm (drops in-flight bee/queen
 * spawns and can't fix a rate-limit). externalStallReason() returns a reason → SUPPRESS, or null →
 * a real internal wedge → restart proceeds.
 */
describe('gateway watchdog — externalStallReason (false-restart suppression)', () => {
  const now = Date.now();

  it('returns null for a TRUE internal wedge (no external/self-heal signal) → restart proceeds', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 5, unified: { rejected: false } }, 5)).toBeNull();
  });

  it('suppresses when the active account is governor-paused (rate-limit, not a wedge)', () => {
    expect(externalStallReason({ pausedUntil: now + 30_000, selfHealReclaims: 0 }, 0)).toMatch(/governor-paused/);
  });

  it('does NOT treat a stale (past) pausedUntil as an external stall', () => {
    expect(externalStallReason({ pausedUntil: now - 30_000, selfHealReclaims: 3 }, 3)).toBeNull();
  });

  it('suppresses when the unified budget window is exhausted (rejected)', () => {
    expect(externalStallReason({ pausedUntil: 0, unified: { rejected: true } }, 0)).toMatch(/exhausted|rejected/);
  });

  it('suppresses while the in-process self-heal valve is advancing reclaims (let it drain)', () => {
    // 7 reclaims now vs 4 captured when the freeze started → valve is actively draining.
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 7 }, 4)).toMatch(/self-heal/);
  });

  it('does NOT suppress on self-heal when reclaims have NOT advanced since freeze start (valve stuck)', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 4 }, 4)).toBeNull();
  });

  it('ignores the self-heal signal when the freeze-start baseline is unknown (-1)', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 9 }, -1)).toBeNull();
  });

  it('is robust to a missing / partial / undefined /stats payload', () => {
    expect(externalStallReason({}, -1)).toBeNull();
    expect(externalStallReason(undefined, -1)).toBeNull();
    expect(externalStallReason({ unified: {} }, -1)).toBeNull();
  });
});

/**
 * EI-2537: proactive DEAD-PROXY detection. deadProxyAlerts() ranks egress proxies whose volume-fair
 * egressFailRateByAccount crosses the threshold over a minimum attempt count — the floor filters the
 * small-sample 100% blip, and the rate (not the raw count) is the signal so the BUSIEST proxy isn't
 * mistaken for the deadest. Pure logic; the poll loop logs + debounces the result.
 */
describe('gateway watchdog — deadProxyAlerts (proactive dead-proxy detection)', () => {
  const stats = (over = {}) => ({
    egressFailRateByAccount: {},
    egressAttemptsByAccount: {},
    egressFailsByAccount: {},
    ...over,
  });

  it('flags a chronically-failing proxy (high rate over enough attempts)', () => {
    const out = deadProxyAlerts(
      stats({
        egressFailRateByAccount: { definitelyahuman: 0.95, aviynw6: 0.03 },
        egressAttemptsByAccount: { definitelyahuman: 60, aviynw6: 100 },
        egressFailsByAccount: { definitelyahuman: 57, aviynw6: 3 },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: 'definitelyahuman', rate: 0.95, attempts: 60, fails: 57 });
  });

  it('does NOT flag a small-sample 100% blip (below the min-attempts floor)', () => {
    const out = deadProxyAlerts(
      stats({ egressFailRateByAccount: { x: 1 }, egressAttemptsByAccount: { x: 1 }, egressFailsByAccount: { x: 1 } }),
    );
    expect(out).toEqual([]);
  });

  it('does NOT flag a healthy proxy (rate below threshold even with high volume)', () => {
    const out = deadProxyAlerts(
      stats({ egressFailRateByAccount: { busy: 0.04 }, egressAttemptsByAccount: { busy: 5000 }, egressFailsByAccount: { busy: 200 } }),
    );
    expect(out).toEqual([]);
  });

  it('returns multiple offenders sorted worst-first (by rate)', () => {
    const out = deadProxyAlerts(
      stats({
        egressFailRateByAccount: { a: 0.6, b: 0.9, c: 0.1 },
        egressAttemptsByAccount: { a: 40, b: 40, c: 40 },
        egressFailsByAccount: { a: 24, b: 36, c: 4 },
      }),
    );
    expect(out.map((d) => d.accountId)).toEqual(['b', 'a']);
  });

  it('honors custom thresholds', () => {
    const s = stats({ egressFailRateByAccount: { p: 0.3 }, egressAttemptsByAccount: { p: 10 }, egressFailsByAccount: { p: 3 } });
    expect(deadProxyAlerts(s)).toEqual([]); // default 0.5/20 → not flagged
    expect(deadProxyAlerts(s, { minAttempts: 5, rateThreshold: 0.25 })).toHaveLength(1); // relaxed → flagged
  });

  it('ignores direct-route failures when the gateway confirms that no proxy is configured', () => {
    const s = stats({
      egressFailRateByAccount: { direct: 0.95 },
      egressAttemptsByAccount: { direct: 60 },
      egressFailsByAccount: { direct: 57 },
      egressProxyHealth: { configured: false, totalProxyEntries: 0, reachableProxyEntries: 0, allDown: false },
    });
    expect(deadProxyAlerts(s)).toEqual([]);
  });

  it('uses proxy-only counters and keeps direct failures visible as upstream transport alerts', () => {
    const s = stats({
      egressFailRateByAccount: { direct: 0.95, proxied: 0.9 },
      egressAttemptsByAccount: { direct: 60, proxied: 60 },
      egressFailsByAccount: { direct: 57, proxied: 54 },
      egressProxyAttemptsByAccount: { proxied: 60 },
      egressProxyFailsByAccount: { proxied: 54 },
      egressProxyFailRateByAccount: { proxied: 0.9 },
    });
    expect(deadProxyAlerts(s)).toEqual([{ accountId: 'proxied', rate: 0.9, attempts: 60, fails: 54 }]);
    expect(upstreamTransportAlerts(s)).toEqual([{ accountId: 'direct', rate: 0.95, attempts: 60, fails: 57 }]);
  });

  it('is robust to a missing / partial / undefined /stats payload', () => {
    expect(deadProxyAlerts(undefined)).toEqual([]);
    expect(deadProxyAlerts({})).toEqual([]);
    expect(deadProxyAlerts({ egressFailRateByAccount: { x: 0.9 } })).toEqual([]); // no attempts map → 0 attempts → filtered
  });
});

/**
 * EI-18664933641195210: the pool-wide egress-down signal. `deadProxyAlerts` above keys on the PER-ACCOUNT
 * fail rate, which rotation structurally hides — an account whose pool is [deadProxy, {}] rotates onto
 * box-direct and the request SUCCEEDS, so its account rate stays near zero while its proxy is 100% dead.
 * Measured: a 16-day three-proxy outage produced ZERO DEAD-PROXY lines for exactly this reason.
 */
describe('gateway watchdog — egressPoolDownAlert (pool-wide egress outage)', () => {
  const health = (h: unknown) => ({ egressProxyHealth: h });

  it('fires when every configured proxy entry is unreachable', () => {
    expect(egressPoolDownAlert(health({ totalProxyEntries: 4, reachableProxyEntries: 0, allDown: true, configured: true })))
      .toEqual({ totalProxyEntries: 4, reachableProxyEntries: 0 });
  });

  it('stays silent while ANY proxy entry is still reachable', () => {
    expect(egressPoolDownAlert(health({ totalProxyEntries: 4, reachableProxyEntries: 1, allDown: false, configured: true }))).toBeNull();
  });

  it('stays silent when no proxy egress is configured at all (EI-19962845612125031)', () => {
    // configured:false means there is no proxy PATH to be down — allDown is vacuously false, and alerting
    // here would page on a box-direct-only deployment that is working exactly as intended.
    expect(egressPoolDownAlert(health({ totalProxyEntries: 0, reachableProxyEntries: 0, allDown: false, configured: false }))).toBeNull();
    // ...and must not fire even if a malformed payload claims allDown while reporting no proxy path.
    expect(egressPoolDownAlert(health({ totalProxyEntries: 0, reachableProxyEntries: 0, allDown: true, configured: false }))).toBeNull();
  });

  it('would have caught the outage the per-account check missed (the regression this exists for)', () => {
    // The live 2026-08-11 shape: rotation kept every ACCOUNT's fail rate under the 50%/20-attempt floor,
    // so deadProxyAlerts saw nothing — while all 4 proxy entries were cooled and unproven.
    const live = {
      egressFailRateByAccount: { aviynw: 0.12, aviynw3: 0.1, 'avistorewolf.com': 0.14, aviynw10: 0.09 },
      egressAttemptsByAccount: { aviynw: 80, aviynw3: 80, 'avistorewolf.com': 80, aviynw10: 80 },
      egressFailsByAccount: { aviynw: 10, aviynw3: 8, 'avistorewolf.com': 11, aviynw10: 7 },
      egressProxyHealth: { totalProxyEntries: 4, reachableProxyEntries: 0, allDown: true, configured: true },
    };
    expect(deadProxyAlerts(live), 'per-account rates are all under the floor — this is the blind spot').toEqual([]);
    expect(egressPoolDownAlert(live), 'the pool-wide signal still fires').toEqual({ totalProxyEntries: 4, reachableProxyEntries: 0 });
  });

  it('is robust to a missing / partial / undefined /stats payload', () => {
    expect(egressPoolDownAlert(undefined)).toBeNull();
    expect(egressPoolDownAlert({})).toBeNull();
    expect(egressPoolDownAlert(health(undefined))).toBeNull();
    expect(egressPoolDownAlert(health({ allDown: true }))).toBeNull(); // no `configured` → not a judgeable proxy path
  });
});

describe('gateway watchdog — sharedDirectEgressAlert (collapsed direct exit IP)', () => {
  it('alerts only after every account and direct route has a fresh sample showing one exit IP', () => {
    expect(sharedDirectEgressAlert({
      egressExitIpHealth: {
        accountCount: 18,
        directAccountCount: 18,
        directRouteCount: 1,
        sampledDirectRouteCount: 1,
        distinctDirectExitIpCount: 1,
        sameDirectExitIp: true,
      },
    })).toEqual({ accountCount: 18, directRouteCount: 1, sampledDirectRouteCount: 1, distinctDirectExitIpCount: 1 });
  });

  it('stays silent for partial samples, proxy-backed accounts, missing telemetry, and a single-account pool', () => {
    expect(sharedDirectEgressAlert({ egressExitIpHealth: {
      accountCount: 18, directAccountCount: 18, directRouteCount: 2, sampledDirectRouteCount: 1,
      distinctDirectExitIpCount: 1, sameDirectExitIp: false,
    } })).toBeNull();
    expect(sharedDirectEgressAlert({ egressExitIpHealth: {
      accountCount: 18, directAccountCount: 17, directRouteCount: 1, sampledDirectRouteCount: 1,
      distinctDirectExitIpCount: 1, sameDirectExitIp: false,
    } })).toBeNull();
    expect(sharedDirectEgressAlert({})).toBeNull();
    expect(sharedDirectEgressAlert({ egressExitIpHealth: {
      accountCount: 1, directAccountCount: 1, directRouteCount: 1, sampledDirectRouteCount: 1,
      distinctDirectExitIpCount: 1, sameDirectExitIp: false,
    } })).toBeNull();
  });
});
