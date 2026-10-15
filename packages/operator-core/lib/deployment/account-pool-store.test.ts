/**
 * Tests for the account-pool wiring (cloud-deployment-layer Phase 7): deploy-time
 * selection (P-020), the scale-out reaction (P-021), and the governor-pause → pool
 * observer (P-019/P-021). All IO is injected; the observer test fires a REAL
 * account-keyed governor pause through the shared registry.
 * Run: cd packages/operator-core && npx vitest run account-pool-store
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Frame } from '@papercusp/deployment-driver';
import { getGovernor, resetGovernorRegistry, DEFAULT_ACCOUNT_ACTIVE_ENV } from '@papercusp/papercusp-shared/agent';

/**
 * default-deploy-account-2026-08-08 P-002/P-005: setDefaultAccount is the one function here
 * whose IO is NOT injectable — it validates against the real pool and persists through the
 * override row. Both of those go through operator-state-pg, so ONE seam at that boundary
 * covers the whole path, and getAccountOverride/setAccountOverride keep running for real.
 *
 * Deliberately a PARTIAL mock (`importOriginal` + spread) rather than an object factory: a
 * factory enumerates the module's exports, so it strands the moment anyone adds one — the
 * exact trap that left two suites in this workspace red (EI-19945223710397201). Spreading the
 * original cannot fail that way. Every pre-existing test in this file injects its own IO and
 * never reaches this seam.
 */
const stateStore = new Map<string, unknown>();
const stateKey = (table: string, ws?: string) => `${table}::${ws ?? 'default'}`;
vi.mock('../operator-state-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../operator-state-pg')>()),
  readOperatorState: vi.fn(async (table: string, ws?: string) => stateStore.get(stateKey(table, ws)) ?? null),
  writeOperatorState: vi.fn(async (table: string, payload: unknown, ws?: string) => {
    stateStore.set(stateKey(table, ws), payload);
  }),
}));

import {
  selectAccountForDeploy,
  recordNativeCredentialFailure,
  accountStatus,
  handleAccountExhausted,
  initAccountScaleObserver,
  _resetAccountScaleObserver,
  projectLiveEdgeThrottle,
  poolVerdictByProvider,
  setDefaultAccount,
  readDefaultAccountId,
  syncDefaultAccountEnv,
  type AccountStatusRow,
  type ScaleOutResult,
} from './account-pool-store';
import { AccountPoolError } from './account-pool';
import { readOperatorState } from '../operator-state-pg';
import {
  emptyPool,
  registerAccount,
  bindAccount,
  recordAccountPenalty,
  recordAccountWindow,
  getAccount,
  DEFAULT_SCALE_POLICY,
  type AccountPool,
} from './account-pool';

const T0 = 1_000_000_000_000;
const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 5));

function poolOf(...ids: string[]): AccountPool {
  let p = emptyPool();
  ids.forEach((id, i) => (p = registerAccount(p, { id, credentialRef: `token:~/.papercusp/${id}` }, T0 + i)));
  return p;
}

describe('native credential health', () => {
  it('alerts and atomically blocks a registered credential, without repeating on replay', async () => {
    let pool = poolOf('bad');
    const alert = vi.fn(async () => {});
    const updatePool = vi.fn(async (mutator: (p: AccountPool) => AccountPool) => (pool = mutator(pool)));
    const deps = { loadPool: async () => pool, updatePool, alert };
    const event = { accountId: 'bad', ownerId: 'su-failed', observedAt: T0 + MIN, workspaceId: 'ws' };
    await recordNativeCredentialFailure(event, deps);
    expect(alert).toHaveBeenCalledWith('bad', 'su-failed', 'ws');
    expect(updatePool).toHaveBeenCalledWith(expect.any(Function), 'ws');
    expect(pool.accounts[0].credentialFailure).toEqual({ observedAt: T0 + MIN, ownerId: 'su-failed' });
    await recordNativeCredentialFailure(event, deps);
    expect(alert).toHaveBeenCalledOnce();
    expect(updatePool).toHaveBeenCalledOnce();
  });

  it('keeps an alert failure retryable and fences a repair racing the update', async () => {
    let pool = poolOf('bad');
    const event = { accountId: 'bad', ownerId: 'su-failed', observedAt: T0 + MIN, workspaceId: 'ws' };
    const updatePool = vi.fn(async (mutator: (p: AccountPool) => AccountPool) => (pool = mutator(pool)));
    await expect(recordNativeCredentialFailure(event, { loadPool: async () => pool, updatePool, alert: async () => { throw new Error('alert store unavailable'); } })).rejects.toThrow('alert store unavailable');
    expect(updatePool).not.toHaveBeenCalled();
    await recordNativeCredentialFailure(event, {
      loadPool: async () => pool, updatePool,
      alert: async () => { pool = registerAccount(pool, { id: 'bad', credentialRef: 'token:repaired' }, T0 + 2 * MIN); },
    });
    expect(pool.accounts[0].credentialFailure).toBeNull();
  });
});
const frameOf = (id: string): Frame => ({ id, target: 'hetzner', placement: 'remote' });

describe('account sidebar wallet identity', () => {
  it('exposes the same public wallet identity for aliases without exposing auth tokens', async () => {
    let pool = registerAccount(emptyPool(), { id: 'local', provider: 'codex', credentialRef: 'codex-cli:/tmp/local' }, T0);
    pool = registerAccount(pool, { id: 'alias', provider: 'codex', credentialRef: 'codex-cli:/tmp/alias' }, T0);
    stateStore.set(stateKey('operator_account_pool', 'credit-test'), pool);
    const rows = await accountStatus('credit-test', T0, { gatewayStats: null, readCodexWalletId: async () => 'shared-wallet' });
    expect(rows.map((r) => r.creditWalletId)).toEqual(['shared-wallet', 'shared-wallet']);
    expect(rows.every((r) => !('accessToken' in r) && !('idToken' in r))).toBe(true);
  });

  it('keeps the pool readable if a credential identity read fails', async () => {
    const pool = registerAccount(emptyPool(), { id: 'local', provider: 'codex', credentialRef: 'codex-cli:/tmp/local' }, T0);
    stateStore.set(stateKey('operator_account_pool', 'credit-error-test'), pool);
    const rows = await accountStatus('credit-error-test', T0, { gatewayStats: null, readCodexWalletId: async () => { throw new Error('unavailable'); } });
    expect(rows).toHaveLength(1);
    expect(rows[0].creditWalletId).toBeUndefined();
  });
});

// ── P-002: per-provider capacity rollup ──────────────────────────────────────

describe('poolVerdictByProvider (P-002)', () => {
  const NOW = T0;
  const row = (over: Partial<AccountStatusRow> & { id: string; provider: AccountStatusRow['provider'] }) =>
    ({
      credentialRef: `token:${over.id}`,
      boundTo: [],
      available: true,
      usageWalled: false,
      sustainedlyLimited: false,
      edgeThrottleKnown: false,
      edgeThrottled: false,
      edgeThrottleCooledIps: 0,
      edgeThrottleBare429Streak: 0,
      rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 },
      liveBuckets: [],
      readingStatus: 'fresh',
      burn: {
        burnRatePerHr: null,
        headroomFraction: null,
        projectedExhaustionAt: null,
        exhaustsBeforeReset: false,
        action: 'none',
        utilization7d: null,
        disposition: 'no-verdict',
        reason: 'fixture',
      },
      ...over,
    }) as AccountStatusRow;

  it('THE POINT: one provider walled does not make the OTHER provider at capacity', () => {
    // The failure this item exists to prevent: `accounts` interleaves providers, so a codex
    // diagnostician reads "3 of 4 rows walled" and concludes the pool is exhausted — when every
    // walled row is claude's and the one codex account is serving fine.
    const rows = [
      row({ id: 'claude-1', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'claude-2', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'claude-3', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'codex-1', provider: 'codex' }),
    ];
    const byProvider = Object.fromEntries(poolVerdictByProvider(rows, NOW).map((v) => [v.provider, v]));

    expect(byProvider.claude!.atCapacity).toBe(true);
    expect(byProvider.claude!.binding).toBe('usage-wall');
    expect(byProvider.claude!.walledFresh).toBe(3);

    expect(byProvider.codex!.atCapacity).toBe(false);
    expect(byProvider.codex!.binding).toBe('none');
    expect(byProvider.codex!.serviceable).toBe(1);
    expect(byProvider.codex!.reason).toContain('NOT at capacity');
    // Every reason names its own provider, so a quoted line cannot be misattributed.
    expect(byProvider.codex!.reason).toContain("'codex'");
  });

  it('a pool of STALE readings is UNKNOWN, never at capacity (never act on missing data)', () => {
    const rows = [
      row({ id: 'c1', provider: 'claude', available: false, usageWalled: true, readingStatus: 'stale' }),
      row({ id: 'c2', provider: 'claude', available: false, usageWalled: true, readingStatus: 'never-observed' }),
    ];
    const [v] = poolVerdictByProvider(rows, NOW);
    expect(v!.unknown).toBe(2);
    expect(v!.walledFresh).toBe(0); // a stale wall is not a MEASURED wall
    expect(v!.atCapacity).toBe(false);
    expect(v!.binding).toBe('none');
    expect(v!.reason).toContain('UNKNOWN, not walled');
  });

  it('a failed probe makes a row unknown even when its readingStatus says fresh', () => {
    const rows = [row({ id: 'c1', provider: 'claude', available: false, usageWalled: true, lastProbeFailedAt: NOW })];
    const [v] = poolVerdictByProvider(rows, NOW);
    expect(v!.unknown).toBe(1);
    expect(v!.atCapacity).toBe(false);
  });

  it('a PACING projection is counted apart and never makes the provider at capacity', () => {
    // P-001's disposition, consumed: these accounts still serve.
    const pacing = {
      burnRatePerHr: 0.1,
      headroomFraction: 0.42,
      projectedExhaustionAt: NOW + 4 * 3_600_000,
      exhaustsBeforeReset: true,
      action: 'throttle' as const,
      utilization7d: 0.58,
      disposition: 'pacing-projection' as const,
      reason: 'projection',
    };
    const rows = [
      row({ id: 'c1', provider: 'claude', burn: pacing }),
      row({ id: 'c2', provider: 'claude', burn: pacing }),
    ];
    const [v] = poolVerdictByProvider(rows, NOW);
    expect(v!.pacing).toBe(2);
    expect(v!.serviceable).toBe(2);
    expect(v!.atCapacity).toBe(false);
    expect(v!.binding).toBe('none');
    expect(v!.reason).toContain('does not stop them serving');
  });

  it('does not call a fresh but live edge-throttled account serviceable', () => {
    const rows = [
      row({ id: 'edge', provider: 'claude', edgeThrottled: true }),
      row({ id: 'healthy', provider: 'claude' }),
    ];
    const [v] = poolVerdictByProvider(rows, NOW);

    expect(v!.serviceable).toBe(1);
    expect(v!.edgeThrottled).toBe(1);
    expect(v!.atCapacity).toBe(false);
    expect(v!.reason).toContain("1 of 2 'claude' account(s) can serve right now");
    expect(v!.reason).toContain('1 live edge-throttled account(s) excluded');
  });

  it('names an edge-throttle wall when it is the only reason a fresh account cannot serve', () => {
    const [v] = poolVerdictByProvider([row({ id: 'edge', provider: 'claude', edgeThrottled: true })], NOW);

    expect(v!.serviceable).toBe(0);
    expect(v!.edgeThrottled).toBe(1);
    expect(v!.atCapacity).toBe(true);
    expect(v!.reason).toContain('0 usage-walled, 0 rate-paused, 1 edge-throttled of 1');
  });

  it('a partial answer is not a measured verdict: walled + one stale row ⇒ atCapacity false', () => {
    const rows = [
      row({ id: 'c1', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'c2', provider: 'claude', available: false, readingStatus: 'stale' }),
    ];
    const [v] = poolVerdictByProvider(rows, NOW);
    expect(v!.walledFresh).toBe(1);
    expect(v!.unknown).toBe(1);
    expect(v!.atCapacity).toBe(false);
    expect(v!.binding).toBe('usage-wall'); // what blocks the measured rows…
    expect(v!.reason).toContain('NOT a measured at-capacity verdict'); // …but the pool verdict is not
  });

  it('a rate-limit PAUSE binds as a usage-wall and is counted even on a stale row', () => {
    const rows = [
      row({
        id: 'c1',
        provider: 'claude',
        available: false,
        rate: { pausedUntil: NOW + MIN, penaltyCount: 3, lastPenaltyAt: NOW, windowStartedAt: NOW },
      }),
    ];
    const [v] = poolVerdictByProvider(rows, NOW);
    expect(v!.paused).toBe(1);
    expect(v!.binding).toBe('usage-wall');
    expect(v!.atCapacity).toBe(true);
  });

  it('every provider group carries a non-empty reason, and groups are stable-sorted', () => {
    const rows = [row({ id: 'z1', provider: 'codex' }), row({ id: 'a1', provider: 'claude' })];
    const out = poolVerdictByProvider(rows, NOW);
    expect(out.map((v) => v.provider)).toEqual(['claude', 'codex']);
    for (const v of out) expect(v.reason.length).toBeGreaterThan(10);
  });
});

describe('projectLiveEdgeThrottle (EI-11790)', () => {
  it('links a live bare-429 edge penalty to the account status row without changing quota availability', () => {
    expect(
      projectLiveEdgeThrottle('aviynw8', {
        edgeThrottleByAccount: {
          aviynw8: { edgeThrottled: true, cooldownUntil: T0 + 30_000, cooledIpCount: 1, bare429Streak: 4 },
        },
      }),
    ).toEqual({
      edgeThrottleKnown: true,
      edgeThrottled: true,
      edgeThrottleResetAt: T0 + 30_000,
      edgeThrottleCooledIps: 1,
      edgeThrottleBare429Streak: 4,
    });
  });

  it('keeps deploy-skew/old gateway evidence distinct from a healthy edge signal', () => {
    expect(projectLiveEdgeThrottle('aviynw8', null)).toEqual({
      edgeThrottleKnown: false,
      edgeThrottled: false,
      edgeThrottleCooledIps: 0,
      edgeThrottleBare429Streak: 0,
    });
    expect(projectLiveEdgeThrottle('aviynw8', {})).toMatchObject({ edgeThrottleKnown: false, edgeThrottled: false });
  });
});

describe('selectAccountForDeploy (P-020)', () => {
  it('respects an explicit credentialRef (no pool touch)', async () => {
    let saved = false;
    const out = await selectAccountForDeploy({ target: 'hetzner', credentialRef: 'token:/pinned' }, 'h1', 'ws', {
      loadPool: async () => poolOf('a'),
      mutatePool: async (m) => ((saved = true), m(poolOf('a'))),
    });
    expect(out.credentialRef).toBe('token:/pinned');
    expect(saved).toBe(false);
  });

  it('returns the config unchanged when the pool is empty', async () => {
    const out = await selectAccountForDeploy({ target: 'hetzner' }, 'h1', 'ws', {
      loadPool: async () => emptyPool(),
      mutatePool: async (m) => m(emptyPool()),
    });
    expect(out).toEqual({ target: 'hetzner' });
  });

  it('binds the most-available account + stamps credentialRef/accountId', async () => {
    let pool = poolOf('a', 'b');
    const out = await selectAccountForDeploy({ target: 'hetzner', region: 'ash' }, 'h1', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      mutatePool: async (m) => (pool = m(pool)),
    });
    expect(out).toMatchObject({ target: 'hetzner', region: 'ash', credentialRef: 'token:~/.papercusp/a', accountId: 'a' });
    expect(getAccount(pool, 'a')!.boundTo).toEqual(['h1']);
  });
});

describe('handleAccountExhausted (P-021)', () => {
  it('not-sustained → no provisioning', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountPenalty(pool, 'a', T0, { pausedUntil: T0 + MIN });
    const res = await handleAccountExhausted('a', 'ws', {
      now: () => T0 + 30_000,
      loadPool: async () => pool,
      mutatePool: async (m) => (pool = m(pool)),
      memberDeployment: async () => ({ target: 'hetzner' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    });
    expect(res).toEqual({ scaledOut: false, reason: 'not-sustained' });
  });

  it('sustained + fresh account → redeploys bound members on the fresh account + rebinds', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountWindow(pool, 'a', { utilization: 1.01 }, T0); // genuinely over 5h budget = sustained
    const redeployed: { slug: string; credentialRef?: string; accountId?: string }[] = [];
    const res = (await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      mutatePool: async (m) => (pool = m(pool)),
      memberDeployment: async () => ({ target: 'hetzner', region: 'ash', size: 'cpx31' }),
      redeploy: async (slug, _ws, dep) => {
        redeployed.push({ slug, credentialRef: dep.credentialRef, accountId: dep.accountId });
        return { frame: frameOf(`f-${slug}`) };
      },
    })) as Extract<ScaleOutResult, { scaledOut: true }>;
    expect(res.scaledOut).toBe(true);
    expect(res.account).toBe('b');
    expect(redeployed).toEqual([{ slug: 'h1', credentialRef: 'token:~/.papercusp/b', accountId: 'b' }]);
    expect(getAccount(pool, 'b')!.boundTo).toContain('h1');
    expect(getAccount(pool, 'a')!.boundTo).not.toContain('h1');
  });

  it('no fresh account available → does not provision', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountWindow(pool, 'a', { utilization: 1.01 }, T0); // a genuinely over budget
    pool = recordAccountPenalty(pool, 'b', T0, { pausedUntil: T0 + 20 * MIN }); // b paused → no fresh account
    const res = await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      mutatePool: async (m) => (pool = m(pool)),
      memberDeployment: async () => ({ target: 'hetzner' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    });
    expect(res).toEqual({ scaledOut: false, reason: 'no-fresh-account' });
  });

  it('a local-only member template is reported per-member, not provisioned', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h-local');
    pool = recordAccountWindow(pool, 'a', { utilization: 1.01 }, T0); // genuinely over budget = sustained
    const res = (await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      mutatePool: async (m) => (pool = m(pool)),
      memberDeployment: async () => ({ target: 'local' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    })) as Extract<ScaleOutResult, { scaledOut: true }>;
    expect(res.scaledOut).toBe(true);
    expect(res.members[0]).toMatchObject({ slug: 'h-local', error: expect.stringContaining('no cloud') });
  });
});

describe('initAccountScaleObserver (P-019/P-021 bridge)', () => {
  beforeEach(() => {
    resetGovernorRegistry();
    _resetAccountScaleObserver();
  });
  afterEach(() => _resetAccountScaleObserver());

  it('a sustained account-keyed pause records the penalty, emits exhausted, and scales out', async () => {
    let pool = bindAccount(poolOf('acct-1', 'acct-2'), 'acct-1', 'h1');
    const scaleCalls: string[] = [];
    const emitCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: true, account: 'acct-2', members: [] };
      },
      emitExhausted: (id) => emitCalls.push(id),
      autoScaleOutAllowed: async () => true, // P-006 gate isolated (its own test covers OFF)
      log: () => {},
      readScalePolicy: async () => DEFAULT_SCALE_POLICY,
    });
    // A SUSTAINED burst of real account-keyed governor pauses for acct-1 (threshold = 3 in-window).
    // A single pause is no longer "sustained" (D-003: that was the false-exhaustion trigger); it
    // takes a genuine repeated-429 pattern (each penalty extends the pause so onPause re-fires).
    const g = getGovernor('anthropic', 'opus', undefined, 'acct-1');
    g.penalize({ retryAfterMs: 5 * MIN });
    g.penalize({ retryAfterMs: 10 * MIN });
    g.penalize({ retryAfterMs: 15 * MIN });
    await flush();
    expect(emitCalls).toEqual(['acct-1']);
    expect(scaleCalls).toEqual(['acct-1']);
    expect(getAccount(pool, 'acct-1')!.rate.penaltyCount).toBe(3);
  });

  it('a TRANSPORT pause (egress-proxy circuit) is NOT counted toward exhaustion — no penalty, no emit, no scale-out (2026-06-22)', async () => {
    let pool = bindAccount(poolOf('acct-1', 'acct-2'), 'acct-1', 'h1');
    const scaleCalls: string[] = [];
    const emitCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: true, account: 'acct-2', members: [] };
      },
      emitExhausted: (id) => emitCalls.push(id),
      autoScaleOutAllowed: async () => true,
      log: () => {},
      readScalePolicy: async () => DEFAULT_SCALE_POLICY,
    });
    // THREE transport pauses (a flaky egress proxy) — WAY past the sustained threshold of 3 — must NOT mark a
    // quota-healthy account exhausted. Before the fix these counted exactly like 429s (aviynw: penaltyCount 32
    // from proxy flaps → "sustainedly limited" while only 6% of its 5h budget was used).
    const g = getGovernor('anthropic', 'opus', undefined, 'acct-1');
    g.penalize({ retryAfterMs: 5 * MIN, transport: true });
    g.penalize({ retryAfterMs: 10 * MIN, transport: true });
    g.penalize({ retryAfterMs: 15 * MIN, transport: true });
    await flush();
    expect(emitCalls).toEqual([]); // never marked exhausted
    expect(scaleCalls).toEqual([]); // never triggers a PAID scale-out
    expect(getAccount(pool, 'acct-1')!.rate.penaltyCount).toBe(0); // transport pauses don't accrue rate penalties
  });

  it('owner auto-scale-out toggle OFF (P-006): exhaustion still emits, but does NOT scale out', async () => {
    let pool = bindAccount(poolOf('acct-1', 'acct-2'), 'acct-1', 'h1');
    const scaleCalls: string[] = [];
    const emitCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: true, account: 'acct-2', members: [] };
      },
      emitExhausted: (id) => emitCalls.push(id),
      autoScaleOutAllowed: async () => false, // owner disabled auto-scale-out
      log: () => {},
      readScalePolicy: async () => DEFAULT_SCALE_POLICY,
    });
    const g = getGovernor('anthropic', 'opus', undefined, 'acct-1');
    g.penalize({ retryAfterMs: 5 * MIN });
    g.penalize({ retryAfterMs: 10 * MIN });
    g.penalize({ retryAfterMs: 15 * MIN });
    await flush();
    expect(emitCalls).toEqual(['acct-1']); // observability fires regardless of the toggle
    expect(scaleCalls).toEqual([]); // ...but no auto-scale-out
  });

  it('a short (non-sustained) account pause records but does NOT scale out', async () => {
    let pool = poolOf('acct-1', 'acct-2');
    const scaleCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: false, reason: 'not-sustained' };
      },
      emitExhausted: () => {},
      log: () => {},
      readScalePolicy: async () => DEFAULT_SCALE_POLICY,
    });
    getGovernor('anthropic', 'opus', undefined, 'acct-1').penalize({ retryAfterMs: 60_000 }); // 1 min
    await flush();
    expect(scaleCalls).toEqual([]);
    expect(getAccount(pool, 'acct-1')!.rate.penaltyCount).toBe(1);
  });

  it('a GLOBAL (non-account) pause is ignored by the account observer', async () => {
    let pool = poolOf('acct-1');
    const scaleCalls: string[] = [];
    let updated = false;
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => {
        updated = true;
        return (pool = m(pool));
      },
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: false, reason: 'not-sustained' };
      },
      emitExhausted: () => {},
      log: () => {},
      readScalePolicy: async () => DEFAULT_SCALE_POLICY,
    });
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 31 * MIN }); // no accountId → global bucket
    await flush();
    expect(updated).toBe(false);
    expect(scaleCalls).toEqual([]);
  });
});

describe('setDefaultAccount (default-deploy-account-2026-08-08 P-002)', () => {
  const WS = 'ws-default';
  const seedPool = (...accounts: { id: string; provider?: 'claude' | 'codex' }[]) =>
    stateStore.set(`operator_account_pool::${WS}`, {
      accounts: accounts.map((a) => ({ ...a, credentialRef: `token:~/.papercusp/${a.id}` })),
    });

  beforeEach(() => {
    stateStore.clear();
    delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
  });
  afterEach(() => {
    delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
  });

  it('persists a valid claude account as the default', async () => {
    seedPool({ id: 'aviynw6' }, { id: 'aviynw2' });
    const out = await setDefaultAccount('aviynw2', WS);
    expect(out.defaultAccountId).toBe('aviynw2');
    expect(await readDefaultAccountId(WS)).toBe('aviynw2');
  });

  it('leaves the allow/exclude axes untouched (a default is a different axis)', async () => {
    // The session-override write guard rejects stale/unknown ids, so seed the excluded
    // account as part of the concrete pool this fixture claims to steer.
    seedPool({ id: 'aviynw6' }, { id: 'other' });
    stateStore.set(`operator_account_override::${WS}`, { forcedAccounts: ['aviynw6'], excludeAccounts: ['other'] });
    const out = await setDefaultAccount('aviynw6', WS);
    expect(out).toEqual({ forcedAccounts: ['aviynw6'], excludeAccounts: ['other'], defaultAccountId: 'aviynw6' });
  });

  // ── validation happens at the WRITE, so a bad value can never reach resolve time ──

  it('REJECTS an unknown id with an AccountPoolError naming the known accounts', async () => {
    // The message has to name them: the caller is a settings UI, and "no such account" alone
    // gives the owner nothing to act on.
    seedPool({ id: 'aviynw6' }, { id: 'aviynw2' });
    await expect(setDefaultAccount('nope', WS)).rejects.toThrow(AccountPoolError);
    await expect(setDefaultAccount('nope', WS)).rejects.toThrow(
      /no such account 'nope'[\s\S]*Known accounts: aviynw6, aviynw2/,
    );
  });

  it('says "(pool is empty)" rather than a bare empty list when nothing is registered', async () => {
    seedPool();
    await expect(setDefaultAccount('nope', WS)).rejects.toThrow(/\(pool is empty\)/);
  });

  it('ACCEPTS a Codex account as the default', async () => {
    // Inverted by inference-rename-and-provider-agnostic-default-2026-08-09 P-003. This used to
    // reject a Codex id by name, on the reasoning that the default stands in for the machine's
    // CLAUDE login. It is now a PER-PROVIDER primary (D-002), so a Codex default is a real,
    // meaningful choice: it fronts the Codex pool and leaves Anthropic resolution untouched.
    seedPool({ id: 'claude-a' }, { id: 'codex-main', provider: 'codex' });
    const out = await setDefaultAccount('codex-main', WS);
    expect(out.defaultAccountId).toBe('codex-main');
    expect(await readDefaultAccountId(WS)).toBe('codex-main');
  });

  it('does NOT publish the in-process transport marker for a CODEX default', async () => {
    // The marker's only job is to route the in-process ANTHROPIC-direct family through the
    // gateway. A Codex default says nothing about Anthropic traffic, so setting it would
    // silently move every judge/summariser off the local login on an unrelated choice.
    seedPool({ id: 'claude-a' }, { id: 'codex-main', provider: 'codex' });
    await setDefaultAccount('codex-main', WS);
    expect(DEFAULT_ACCOUNT_ACTIVE_ENV in process.env).toBe(false);
    // ...and a Claude default still does publish it, so the assertion above is discriminating
    // rather than passing because the marker never gets set at all.
    await setDefaultAccount('claude-a', WS);
    expect(process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]).toBe('1');
  });

  it('a REJECTED write leaves an existing default intact (validate before persist)', async () => {
    // Still validated — an UNKNOWN id is the remaining rejection case now that provider is not one.
    seedPool({ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' });
    await setDefaultAccount('aviynw6', WS);
    await expect(setDefaultAccount('no-such-account', WS)).rejects.toThrow(AccountPoolError);
    expect(await readDefaultAccountId(WS)).toBe('aviynw6'); // not clobbered by the failed write
    expect(process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]).toBe('1'); // and the marker still reflects reality
  });

  // ── clearing: the way back to the ~/.claude login (D-002) ──

  it.each([null, undefined, '', '   '])('%p CLEARS the default without consulting the pool', async (id) => {
    // Notably it does NOT validate: clearing must work even when the pool is unreadable or the
    // named account is already gone, because this is the recovery path.
    seedPool({ id: 'aviynw6' });
    await setDefaultAccount('aviynw6', WS);
    const out = await setDefaultAccount(id, WS);
    expect(out.defaultAccountId).toBeUndefined();
    expect(await readDefaultAccountId(WS)).toBeUndefined();
  });

  // ── the in-process transport marker (D-004) ──

  it('publishes the env marker on set and REMOVES it on clear', async () => {
    // chooseStatelessTransport (papercusp-shared) reads this to send the in-process
    // anthropic-direct family through the gateway. It is a boolean, not an account id, on
    // purpose — see the known per-process staleness gap (EI-19944784972017743).
    seedPool({ id: 'aviynw6' });
    await setDefaultAccount('aviynw6', WS);
    expect(process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]).toBe('1');
    await setDefaultAccount(null, WS);
    expect(DEFAULT_ACCOUNT_ACTIVE_ENV in process.env).toBe(false); // deleted, not set to ''
  });

  it('syncDefaultAccountEnv reconciles a process that booted before the default was set', async () => {
    seedPool({ id: 'aviynw6' });
    await setDefaultAccount('aviynw6', WS);
    delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]; // a sibling host that never saw the write
    expect(await syncDefaultAccountEnv(WS)).toBe(true);
    expect(process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]).toBe('1');
  });

  it('syncDefaultAccountEnv reports a CODEX default as INACTIVE (it is not an Anthropic transport steer)', async () => {
    // The sibling-host reconciler has to agree with setDefaultAccount's claude-only marker rule
    // (P-003 / D-002), or a bg-host would boot and flip in-process Anthropic traffic onto the
    // gateway on the strength of a Codex choice — the exact drift the marker exists to prevent.
    seedPool({ id: 'claude-a' }, { id: 'codex-main', provider: 'codex' });
    await setDefaultAccount('codex-main', WS);
    delete process.env[DEFAULT_ACCOUNT_ACTIVE_ENV];
    expect(await syncDefaultAccountEnv(WS)).toBe(false);
    expect(DEFAULT_ACCOUNT_ACTIVE_ENV in process.env).toBe(false);
  });

  it('syncDefaultAccountEnv is FAIL-SOFT on a read error — it keeps the previous marker', async () => {
    // Deliberately unlike readDefaultAccountId's other callers, which fail closed. This one is a
    // best-effort refresher, so flipping every in-process call onto a different transport over a
    // transient blip would be strictly worse than leaving the marker alone.
    seedPool({ id: 'aviynw6' });
    await setDefaultAccount('aviynw6', WS);
    vi.mocked(readOperatorState).mockRejectedValueOnce(new Error('pg blip'));
    expect(await syncDefaultAccountEnv(WS)).toBeUndefined();
    expect(process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]).toBe('1'); // unchanged, not cleared
  });
});
