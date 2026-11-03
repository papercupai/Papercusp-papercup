/**
 * Unit tests for the pure account-pool core (cloud-deployment-layer Phase 7,
 * P-019/P-020/P-021). No PG / governor / deploy IO — pure value transforms.
 * Run: cd packages/operator-core && npx vitest run account-pool
 */
import { describe, it, expect } from 'vitest';
import {
  emptyPool,
  registerAccount,
  removeAccount,
  getAccount,
  accountByCredentialRef,
  egressEntries,
  bindAccount,
  unbindAccount,
  recordAccountPenalty,
  recordAccountCredentialFailure,
  recordAccountReset,
  recordAccountWindow,
  setAccountModelRefusal,
  recordProbeFailure,
  accountReadingStatus,
  isAvailable,
  isSustainedlyLimited,
  normalizeAccount,
  isSpawnEligible,
  selectAccountByHeadroom,
  selectAccountByDrain,
  selectAccountForSpawn,
  decideScaleOut,
  drainUtil,
  drainUtil7d,
  effectiveDrainUtil,
  accountFull,
  usageWalledUntil,
  accountBurnVerdict,
  AccountPoolError,
  DEFAULT_SCALE_POLICY,
  DRAIN_UTIL_STALE_MS,
  DRAIN_FULL_UTIL,
  type AccountPool,
} from './account-pool';
import { ROLLING_WINDOW_REPROBE_MAX_MS } from '@papercusp/papercusp-shared/resilience';

const T0 = 1_000_000_000_000; // a fixed epoch-ms base
const MIN = 60_000;

describe('provider credit-balance observations', () => {
  it('persists zero and its observation time without refreshing an unrelated quota meter', () => {
    let pool = registerAccount(emptyPool(), { id: 'codex', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' }, T0);
    pool = recordAccountWindow(pool, 'codex', { utilization7d: 1 }, T0);
    pool = recordAccountWindow(pool, 'codex', { creditBalance: { amount: 0, unit: 'credits', source: 'codex' } }, T0 + MIN);
    const row = normalizeAccount(JSON.parse(JSON.stringify(getAccount(pool, 'codex'))));
    expect(row.rate.creditBalance).toEqual({ amount: 0, unit: 'credits', source: 'codex', observedAt: T0 + MIN });
    expect(row.rate.utilizationAt).toBe(T0);
    expect(recordAccountWindow(pool, 'codex', { utilization7d: 0.5 }, T0 + 2 * MIN).accounts[0].rate.creditBalance).toEqual(row.rate.creditBalance);
  });

  it('accepts verified Claude Console dollars only on API accounts', () => {
    let pool = registerAccount(emptyPool(), { id: 'api', provider: 'claude', credentialRef: 'apikey:env:TEST_KEY' }, T0);
    pool = registerAccount(pool, { id: 'subscription', provider: 'claude', credentialRef: 'token:/tmp/claude' }, T0);
    const reading = { amount: 12.34, unit: 'USD' as const, source: 'claude-console' as const, walletId: 'org-1' };
    pool = recordAccountWindow(pool, 'api', { creditBalance: reading }, T0);
    pool = recordAccountWindow(pool, 'subscription', { creditBalance: reading }, T0);
    expect(getAccount(pool, 'api')?.rate.creditBalance).toMatchObject({ amount: 12.34, unit: 'USD', walletId: 'org-1', observedAt: T0 });
    expect(getAccount(pool, 'subscription')?.rate.creditBalance).toBeUndefined();
  });

  it('rejects a provider/unit mismatch and non-finite amounts', () => {
    const pool = registerAccount(emptyPool(), { id: 'codex', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' }, T0);
    for (const creditBalance of [
      { amount: 10, unit: 'USD' as const, source: 'claude-console' as const },
      { amount: NaN, unit: 'credits' as const, source: 'codex' as const },
      { amount: -1, unit: 'credits' as const, source: 'codex' as const },
    ]) expect(recordAccountWindow(pool, 'codex', { creditBalance }, T0).accounts[0].rate.creditBalance).toBeUndefined();
  });
});

describe('Codex credit-backed allowance exhaustion', () => {
  const creditedPool = (available: boolean) => recordAccountWindow(
    registerAccount(emptyPool(), { id: 'credited', provider: 'codex', credentialRef: 'codex-cli:/tmp/credited' }, T0),
    'credited',
    { utilization7d: 1, windowResetAt7d: T0 + 10_080 * MIN, usageCreditsAvailable: available },
    T0,
  );

  it('persists credits and keeps a full included meter serviceable after rehydration', () => {
    const account = normalizeAccount(JSON.parse(JSON.stringify(getAccount(creditedPool(true), 'credited'))));
    expect(account.rate.utilization7d).toBe(1);
    expect(account.rate.usageCreditsAvailable).toBe(true);
    expect(accountFull(account, T0)).toBe(false);
    expect(usageWalledUntil(account, T0)).toBe(0);
    expect(accountBurnVerdict(account.rate, T0).action).toBe('none');
  });

  it('reinstates the allowance wall when credits are no longer available', () => {
    const p = recordAccountWindow(creditedPool(true), 'credited', { usageCreditsAvailable: false }, T0 + MIN);
    expect(getAccount(p, 'credited')!.rate.utilizationAt).toBe(T0);
    expect(getAccount(p, 'credited')!.rate.usageCreditsObservedAt).toBe(T0 + MIN);
    expect(accountFull(getAccount(p, 'credited')!, T0 + MIN)).toBe(true);
    expect(usageWalledUntil(getAccount(p, 'credited')!, T0 + MIN)).toBe(T0 + 10_080 * MIN);
  });

  it('does not bypass an actual account pause', () => {
    const p = recordAccountPenalty(creditedPool(true), 'credited', T0, { pausedUntil: T0 + 10 * MIN });
    expect(accountFull(getAccount(p, 'credited')!, T0)).toBe(true);
  });
});

function poolOf(...ids: string[]): AccountPool {
  let p = emptyPool();
  ids.forEach((id, i) => (p = registerAccount(p, { id, credentialRef: `token:~/.papercusp/${id}` }, T0 + i)));
  return p;
}

describe('registerAccount', () => {
  it('persists, preserves, updates and explicitly clears an Anthropic workspace binding', () => {
    const input = { id: 'api', credentialRef: 'apikey:env:TEST_API_KEY' };
    let p = registerAccount(emptyPool(), { ...input, anthropicWorkspaceId: 'wrkspc_first' }, T0);
    expect(normalizeAccount(JSON.parse(JSON.stringify(getAccount(p, 'api')))).anthropicWorkspaceId).toBe('wrkspc_first');
    p = registerAccount(p, input, T0 + 1);
    expect(getAccount(p, 'api')?.anthropicWorkspaceId).toBe('wrkspc_first');
    p = registerAccount(p, { ...input, anthropicWorkspaceId: 'wrkspc_second' }, T0 + 2);
    expect(getAccount(p, 'api')?.anthropicWorkspaceId).toBe('wrkspc_second');
    p = registerAccount(p, { ...input, anthropicWorkspaceId: null }, T0 + 3);
    expect(getAccount(p, 'api')?.anthropicWorkspaceId).toBeUndefined();
    expect(() => registerAccount(p, { ...input, anthropicWorkspaceId: 'wrong' }, T0)).toThrow(/anthropicWorkspaceId/);
    expect(() => registerAccount(p, { ...input, provider: 'codex', anthropicWorkspaceId: 'wrkspc_wrong_provider' }, T0)).toThrow(/anthropicWorkspaceId/);
  });

  it('blocks failed credentials across quota resets, sticky pins and permissive selectors until repair', () => {
    let pool = registerAccount(emptyPool(), { id: 'bad', credentialRef: 'token:bad' }, T0);
    pool = registerAccount(pool, { id: 'good', credentialRef: 'token:good' }, T0);
    pool = recordAccountCredentialFailure(pool, 'bad', T0 + 1, 'su-failed');
    const failed = getAccount(pool, 'bad')!;
    expect(isAvailable(failed, T0 + 99 * MIN)).toBe(false);
    expect(isSpawnEligible(failed, T0 + MIN)).toBe(false);
    expect(selectAccountForSpawn(pool, T0 + MIN, { priorAccountId: 'bad', rng: () => 0 }).accountId).toBe('good');
    expect(selectAccountByHeadroom(pool, T0 + MIN, { availableOnly: false })?.id).toBe('good');
    expect(selectAccountByDrain(pool, T0 + MIN, { eligible: () => true })?.id).toBe('good');
    expect(getAccount(recordAccountReset(pool, 'bad'), 'bad')?.credentialFailure).toEqual(failed.credentialFailure);
    const repaired = registerAccount(pool, { id: 'bad', credentialRef: 'token:repaired' }, T0 + 2);
    expect(isAvailable(getAccount(repaired, 'bad')!, T0 + MIN)).toBe(true);
    expect(recordAccountCredentialFailure(repaired, 'bad', T0 + 1, 'su-stale')).toBe(repaired);
    expect(recordAccountCredentialFailure(pool, 'bad', T0 + 1, 'su-replay')).toBe(pool);
    expect(recordAccountCredentialFailure(pool, 'missing', T0 + 3, 'su-missing')).toBe(pool);
  });

  it('appends a fresh account with empty bindings + zeroed rate state', () => {
    const p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/t', label: 'main' }, T0);
    const a = getAccount(p, 'acct-1')!;
    expect(a).toMatchObject({ id: 'acct-1', credentialRef: 'token:~/t', label: 'main', addedAt: T0, boundTo: [] });
    expect(a.rate).toEqual({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 });
  });

  it('is idempotent on a repeat id — updates credentialRef/label, preserves bindings + rate', () => {
    let p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/old' }, T0);
    p = bindAccount(p, 'acct-1', 'harness-a');
    p = recordAccountPenalty(p, 'acct-1', T0 + MIN, { pausedUntil: T0 + 5 * MIN });
    p = registerAccount(p, { id: 'acct-1', credentialRef: 'token:~/new', label: 'renamed' }, T0 + 99);
    const a = getAccount(p, 'acct-1')!;
    expect(p.accounts).toHaveLength(1);
    expect(a.credentialRef).toBe('token:~/new');
    expect(a.label).toBe('renamed');
    expect(a.boundTo).toEqual(['harness-a']);
    expect(a.rate.pausedUntil).toBe(T0 + 5 * MIN);
  });

  it('persists a per-account egress binding (per-account IP routing) + updates it on re-register', () => {
    let p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/t', egress: { proxyUrl: 'http://10.0.0.1:3128' } }, T0);
    expect(getAccount(p, 'acct-1')!.egress).toEqual({ proxyUrl: 'http://10.0.0.1:3128' });
    p = registerAccount(p, { id: 'acct-1', credentialRef: 'token:~/t', egress: { localAddress: '203.0.113.7' } }, T0 + 1);
    expect(getAccount(p, 'acct-1')!.egress).toEqual({ localAddress: '203.0.113.7' });
  });

  it('defaults legacy registrations to claude and preserves explicit codex provider', () => {
    let p = registerAccount(emptyPool(), { id: 'claude-a', credentialRef: 'token:~/claude' }, T0);
    p = registerAccount(p, { id: 'codex-a', provider: 'codex', credentialRef: 'env:OPENAI_API_KEY' }, T0 + 1);
    expect(getAccount(p, 'claude-a')!.provider).toBe('claude');
    expect(getAccount(p, 'codex-a')!.provider).toBe('codex');
  });

  it('rejects ids containing the bucket-key delimiters or empty credentialRef', () => {
    expect(() => registerAccount(emptyPool(), { id: 'a:b', credentialRef: 'x' }, T0)).toThrow(AccountPoolError);
    expect(() => registerAccount(emptyPool(), { id: 'a@b', credentialRef: 'x' }, T0)).toThrow(AccountPoolError);
    expect(() => registerAccount(emptyPool(), { id: 'ok', credentialRef: '  ' }, T0)).toThrow(/credentialRef/);
  });
});

describe('remove / lookup / bind / unbind', () => {
  it('removeAccount drops it', () => {
    const p = removeAccount(poolOf('a', 'b'), 'a');
    expect(p.accounts.map((x) => x.id)).toEqual(['b']);
  });

  it('accountByCredentialRef reverse-looks-up', () => {
    const p = poolOf('a', 'b');
    expect(accountByCredentialRef(p, 'token:~/.papercusp/b')?.id).toBe('b');
    expect(accountByCredentialRef(p, 'nope')).toBeUndefined();
  });

  it('bind is idempotent; unbind removes the slug from whichever account holds it', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(bindAccount(p, 'a', 'h1'), 'a', 'h1'); // double-bind = one entry
    expect(getAccount(p, 'a')!.boundTo).toEqual(['h1']);
    p = bindAccount(p, 'b', 'h2');
    p = unbindAccount(p, 'h1');
    expect(getAccount(p, 'a')!.boundTo).toEqual([]);
    expect(getAccount(p, 'b')!.boundTo).toEqual(['h2']);
  });
});

describe('recordAccountPenalty + window rolling', () => {
  it('opens a window of 1, then increments inside the window', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    expect(getAccount(p, 'a')!.rate).toMatchObject({ penaltyCount: 1, windowStartedAt: T0, lastPenaltyAt: T0 });
    p = recordAccountPenalty(p, 'a', T0 + 2 * MIN, { pausedUntil: T0 + 3 * MIN });
    expect(getAccount(p, 'a')!.rate).toMatchObject({ penaltyCount: 2, windowStartedAt: T0 });
  });

  it('a penalty past the window opens a fresh count', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, {});
    p = recordAccountPenalty(p, 'a', T0 + DEFAULT_SCALE_POLICY.windowMs + 1, {});
    expect(getAccount(p, 'a')!.rate.penaltyCount).toBe(1);
    expect(getAccount(p, 'a')!.rate.windowStartedAt).toBe(T0 + DEFAULT_SCALE_POLICY.windowMs + 1);
  });

  it('keeps three slow re-probe penalties in one accrual window', () => {
    expect(DEFAULT_SCALE_POLICY.windowMs).toBeGreaterThanOrEqual(ROLLING_WINDOW_REPROBE_MAX_MS);
    let p = recordAccountPenalty(poolOf('a'), 'a', T0, {});
    p = recordAccountPenalty(p, 'a', T0 + ROLLING_WINDOW_REPROBE_MAX_MS, {});
    p = recordAccountPenalty(p, 'a', T0 + 2 * ROLLING_WINDOW_REPROBE_MAX_MS, {});
    const a = getAccount(p, 'a')!;
    expect(a.rate.penaltyCount).toBe(3);
    expect(isSustainedlyLimited(a, T0 + 2 * ROLLING_WINDOW_REPROBE_MAX_MS)).toBe(true);
  });

  it('pausedUntil advances monotonically (never shortened by a later, nearer penalty)', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 2 * MIN });
    expect(getAccount(p, 'a')!.rate.pausedUntil).toBe(T0 + 10 * MIN);
  });

  it('a penalty for an unknown id is a no-op', () => {
    const p = recordAccountPenalty(poolOf('a'), 'ghost', T0, { pausedUntil: T0 + MIN });
    expect(getAccount(p, 'a')!.rate.penaltyCount).toBe(0);
  });

  it('recordAccountReset clears the rate state', () => {
    let p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountReset(p, 'a');
    expect(getAccount(p, 'a')!.rate).toEqual({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 });
  });

  it('confirmed serving clears an older sustained penalty streak while retaining observations', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.2, utilization7d: 0.73 }, T0);
    for (let i = 1; i <= 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + MIN });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + 4)).toBe(false);
    const before = getAccount(p, 'a')!.rate;
    p = recordAccountReset(p, 'a', { confirmedServingSince: T0 + 4 });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + 5)).toBe(true);
    expect(getAccount(p, 'a')!.rate).toEqual({ ...before, pausedUntil: 0, penaltyCount: 0, windowStartedAt: 0 });
    // A later real wall must start a new streak; recovery does not disable it.
    for (let i = 5; i <= 7; i++) p = recordAccountPenalty(p, 'a', T0 + i);
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + 8)).toBe(false);
  });

  it('confirmed serving preserves newer penalties, full budgets and failed credentials', () => {
    const p = recordAccountPenalty(poolOf('a'), 'a', T0 + 2, { pausedUntil: T0 + MIN });
    expect(recordAccountReset(p, 'a', { confirmedServingSince: T0 + 1 })).toEqual(p);
    expect(recordAccountReset(p, 'a', { confirmedServingSince: T0 + 2 })).toEqual(p);
    expect(recordAccountReset(p, 'a', { confirmedServingSince: NaN })).toBe(p);
    const full = recordAccountWindow(p, 'a', { utilization7d: 1, windowResetAt7d: T0 + 100 * MIN }, T0 + 3);
    expect(isSpawnEligible(getAccount(recordAccountReset(full, 'a', { confirmedServingSince: T0 + 4 }), 'a')!, T0 + 5)).toBe(false);
    const failed = recordAccountCredentialFailure(p, 'a', T0 + 3, 'owner');
    expect(isSpawnEligible(getAccount(recordAccountReset(failed, 'a', { confirmedServingSince: T0 + 4 }), 'a')!, T0 + 5)).toBe(false);
  });

  it('a 429 penalty PRESERVES the last-known observed budget (utilization survives)', () => {
    // Regression: the rate object was rebuilt on every penalty WITHOUT the utilization fields, so an
    // account's "% used" vanished the instant it got rate-limited — exactly when the Accounts tab
    // should show it. The reading must survive the penalty (only pause/penalty are recomputed).
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.82, windowResetAt: T0 + 300 * MIN, utilization7d: 0.4 }, T0);
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 10 * MIN });
    const r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.82);
    expect(r.utilization7d).toBe(0.4);
    expect(r.windowResetAt).toBe(T0 + 300 * MIN);
    expect(r.utilizationAt).toBe(T0); // the observation time, untouched by the penalty
    expect(r.penaltyCount).toBe(1); // pause/penalty still recorded
    expect(r.pausedUntil).toBe(T0 + 10 * MIN);
  });

  it('recordAccountReset clears pause+penalty but PRESERVES the observed budget reading', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.91, utilization7d: 0.55 }, T0);
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountReset(p, 'a');
    const r = getAccount(p, 'a')!.rate;
    expect(r.pausedUntil).toBe(0);
    expect(r.penaltyCount).toBe(0);
    expect(r.windowStartedAt).toBe(0);
    expect(r.utilization).toBe(0.91); // kept so the tab still renders "~91% used · as of …"
    expect(r.utilization7d).toBe(0.55);
    expect(r.utilizationAt).toBe(T0);
  });

  it('recordAccountReset default (no opts / resetWindows:false) is byte-identical to pre-WI-3553 behavior', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.91, windowResetAt: T0 + 300 * MIN, utilization7d: 0.55, windowResetAt7d: T0 + 9999 * MIN }, T0);
    const withNoOpts = getAccount(recordAccountReset(p, 'a'), 'a')!.rate;
    const withExplicitFalse = getAccount(recordAccountReset(p, 'a', { resetWindows: false }), 'a')!.rate;
    expect(withNoOpts).toEqual(withExplicitFalse);
    expect(withNoOpts.utilization).toBe(0.91);
    expect(withNoOpts.windowResetAt).toBe(T0 + 300 * MIN);
    expect(withNoOpts.utilization7d).toBe(0.55);
    expect(withNoOpts.windowResetAt7d).toBe(T0 + 9999 * MIN);
  });

  it('recordAccountReset { resetWindows: true } (WI-3553) ALSO zeroes the observed-budget projection', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.91, windowResetAt: T0 + 300 * MIN, utilization7d: 0.55, windowResetAt7d: T0 + 9999 * MIN }, T0);
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountReset(p, 'a', { resetWindows: true });
    const r = getAccount(p, 'a')!.rate;
    // pause/penalty cleared exactly as the default path does
    expect(r.pausedUntil).toBe(0);
    expect(r.penaltyCount).toBe(0);
    expect(r.windowStartedAt).toBe(0);
    // the deliberate additional override: the observed-budget projection is gone too
    expect(r.utilization).toBeUndefined();
    expect(r.windowResetAt).toBeUndefined();
    expect(r.utilization7d).toBeUndefined();
    expect(r.windowResetAt7d).toBeUndefined();
    expect(r.utilizationAt).toBeUndefined();
  });
});

describe('isAvailable / isSustainedlyLimited', () => {
  it('isAvailable reflects the pause window', () => {
    let p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 5 * MIN });
    expect(isAvailable(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
    expect(isAvailable(getAccount(p, 'a')!, T0 + 6 * MIN)).toBe(true);
  });

  it('a single long pause alone is NOT sustained (D-003 false-exhaustion fix)', () => {
    // On Claude Max a single 429 routinely pauses to the multi-hour 5h/7d reset even when the account
    // is not actually over budget — that used to flip it straight to "exhausted" (false scale-out).
    const p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 31 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(false);
  });

  it('fresh unified utilization at/over cap IS sustained, and self-heals as the window recovers', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 1.01 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(true);
    p = recordAccountWindow(p, 'a', { utilization: 0.7 }, T0 + MIN); // recovered below cap
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });

  it('fresh unified 7d utilization at/over cap IS sustained even when 5h is fresh', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.08, utilization7d: 1.01 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(true);
  });

  it('stale utilization at cap is NOT sustained (only a fresh budget reading counts)', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 1.2 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(false);
  });

  it('stale weekly-full utilization remains sustained until the weekly reset', () => {
    const p = recordAccountWindow(
      poolOf('a'),
      'a',
      { utilization: 0.05, utilization7d: 1.0, windowResetAt7d: T0 + 7 * 24 * 60 * MIN },
      T0,
    );
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(true);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + 8 * 24 * 60 * MIN)).toBe(false);
  });

  it('threshold penalties within the window is sustained; below it is not', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 2 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + MIN)).toBe(false); // 2 < 3
    p = recordAccountPenalty(p, 'a', T0 + 2 * MIN, { pausedUntil: T0 + 3 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + 2 * MIN)).toBe(true); // 3 ≥ 3
  });
});

describe('selectAccountForSpawn (P-005 cache-affinity)', () => {
  it('sticks to the prior account when it is still available (overrides headroom)', () => {
    const p = poolOf('a', 'b', 'c'); // headroom would pick 'a'
    expect(selectAccountForSpawn(p, T0, { priorAccountId: 'c' }).accountId).toBe('c');
  });

  it('falls through a paused prior account to the next rule', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    // rng: () => 0 → the drain spread picks its deterministic best (the clean, never-penalized 'a').
    expect(selectAccountForSpawn(p, T0 + MIN, { priorAccountId: 'b', rng: () => 0 }).accountId).toBe('a');
  });

  it('falls through a weekly-full prior account even when it is not paused', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'b', { utilization: 0.05, utilization7d: 1.0 }, T0);
    // A hard pin to a weekly-full prior account kills spawned CLI roles before they can emit artifacts.
    expect(selectAccountForSpawn(p, T0, { priorAccountId: 'b', rng: () => 0 }).accountId).toBe('a');
  });

  it('pins a harness to the account it is bound to (cache co-location)', () => {
    let p = poolOf('a', 'b', 'c');
    p = bindAccount(p, 'b', 'harness-x');
    expect(selectAccountForSpawn(p, T0, { harness: 'harness-x' }).accountId).toBe('b');
  });

  it('skips a paused bound account (manual-bind stays available-only) and falls back to headroom', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountForSpawn(p, T0 + MIN, { harness: 'harness-x', rng: () => 0 }).accountId).toBe('a');
  });

  it('skips a weekly-full bound account and falls back to headroom', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    p = recordAccountWindow(p, 'b', { utilization: 0.02, utilization7d: 1.0 }, T0);
    expect(selectAccountForSpawn(p, T0, { harness: 'harness-x', rng: () => 0 }).accountId).toBe('a');
  });

  it('falls back to the least-loaded available account with no prior/harness', () => {
    expect(selectAccountForSpawn(poolOf('a', 'b'), T0, { rng: () => 0 }).accountId).toBe('a');
  });

  it('does not hard-pin a budget-healthy but currently paused account into a spawned CLI turn', () => {
    // A single 429 can carry a far-future pause even though the account still has budget, but a spawned
    // CLI turn with a hard account pin dies immediately on the gateway's pinned-account 429. Spawn
    // selection therefore returns no header when every account is paused; the unpinned gateway path can
    // pace/fail over without killing the autonomous turn on a known-bad pin.
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    const pick = selectAccountForSpawn(p, T0 + MIN, { priorAccountId: 'a', harness: 'h', rng: () => 0 }).accountId;
    expect(pick).toBeUndefined();
  });

  it('does not hard-pin the soonest-recovering account when every account is genuinely exhausted', () => {
    // 3 penalties in-window = sustainedly limited (truly out of budget) → not spawn-eligible. A hard pin
    // to the soonest paused account still returns a terminal 429 to the spawned CLI, so emit no account
    // header and let the gateway own pacing/failover.
    let p = poolOf('a', 'b');
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + 20 * MIN });
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'b', T0 + i, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountForSpawn(p, T0 + MIN, { rng: () => 0 }).accountId).toBeUndefined();
  });

  it('does not hard-pin any account when every available account is weekly-full', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.05, utilization7d: 1.0 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.10, utilization7d: 0.99 }, T0);
    expect(selectAccountForSpawn(p, T0, { rng: () => 0 }).accountId).toBeUndefined();
  });

  it('does not re-admit a stale weekly-full account before its weekly reset', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(
      p,
      'a',
      { utilization: 0.05, utilization7d: 1.0, windowResetAt7d: T0 + 7 * 24 * 60 * MIN },
      T0,
    );
    p = recordAccountWindow(p, 'b', { utilization: 0.30, utilization7d: 0.40 }, T0);
    expect(selectAccountForSpawn(p, T0 + DRAIN_UTIL_STALE_MS + MIN, { rng: () => 0 }).accountId).toBe('b');
  });

  it('returns undefined for an empty pool', () => {
    expect(selectAccountForSpawn(emptyPool(), T0).accountId).toBeUndefined();
  });

  it('a soft-pinned harness PREFERS its pin but no longer funnels every concurrent bee onto it', () => {
    // Soft-pin harness 'h' to 'b' (a healthy account); the hive must spread, not 100%-pile on 'b'.
    let p = poolOf('a', 'b', 'c');
    p = { accounts: p.accounts.map((acc) => (acc.id === 'b' ? { ...acc, softPin: ['h'] } : acc)) };
    const picks = Array.from(
      { length: 60 },
      (_, i) => selectAccountForSpawn(p, T0, { harness: 'h', rng: () => i / 60 }).accountId,
    );
    const counts = picks.reduce<Record<string, number>>((m, id) => ((m[id!] = (m[id!] ?? 0) + 1), m), {});
    expect(Object.keys(counts).length).toBeGreaterThan(1); // fans out across the pool (not a funnel)
    expect(counts['b']).toBeGreaterThan(counts['a'] ?? 0); // ...while still PREFERRING the warm-cache pin
    expect(counts['b']).toBeGreaterThan(counts['c'] ?? 0);
  });

  it('does NOT re-pin the harness when a bee spills off its existing soft-pin (anchor stays stable)', () => {
    let p = poolOf('a', 'b');
    p = { accounts: p.accounts.map((acc) => (acc.id === 'b' ? { ...acc, softPin: ['h'] } : acc)) };
    // rng=0.1 lands in 'a's weight band (below 'b's affinity-boosted slice) → this bee SPILLS to 'a',
    // but newlyPinned must stay unset: the hive's pin 'b' holds; a spilled bee never re-anchors the harness.
    const sel = selectAccountForSpawn(p, T0, { harness: 'h', rng: () => 0.1 });
    expect(sel.accountId).toBe('a'); // spilled off the pin
    expect(sel.newlyPinned).toBeUndefined(); // ...without re-pinning the harness
  });

  it('establishes a fresh soft-pin (newlyPinned) only when the harness has none yet', () => {
    const sel = selectAccountForSpawn(poolOf('a', 'b'), T0, { harness: 'fresh-harness', rng: () => 0 });
    expect(sel.newlyPinned).toEqual({ harness: 'fresh-harness', accountId: sel.accountId });
  });
});

describe('selectAccountByHeadroom (P-020)', () => {
  it('returns undefined when the pool is empty / all excluded / all paused', () => {
    expect(selectAccountByHeadroom(emptyPool(), T0)).toBeUndefined();
    expect(selectAccountByHeadroom(poolOf('a'), T0, { exclude: ['a'] })).toBeUndefined();
    const paused = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByHeadroom(paused, T0 + MIN)).toBeUndefined();
  });

  it('skips paused accounts and picks an available one', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByHeadroom(p, T0 + MIN)!.id).toBe('b');
  });

  it('prefers the least-recently-penalized available account', () => {
    let p = poolOf('a', 'b');
    // both available now, but b was penalized more recently
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 1 }); // pause already elapsed by T0+MIN
    expect(selectAccountByHeadroom(p, T0 + MIN)!.id).toBe('a');
  });

  it('preferUnbound spreads load to a fresh account', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'a', 'h1'); // a bound; a was added first so without preferUnbound it'd tie-break to... fewest bindings = b
    expect(selectAccountByHeadroom(p, T0, { preferUnbound: true })!.id).toBe('b');
  });
});

describe('recordAccountWindow (D-003 unified-5h projection)', () => {
  it('records utilization + reset + a freshness stamp; an undefined field keeps its prior value', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0.4, windowResetAt: T0 + 60 * MIN }, T0);
    let r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.4);
    expect(r.windowResetAt).toBe(T0 + 60 * MIN);
    expect(r.utilizationAt).toBe(T0);
    // a later partial update bumps utilization but keeps the prior reset
    p = recordAccountWindow(p, 'a', { utilization: 0.6 }, T0 + MIN);
    r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.6);
    expect(r.windowResetAt).toBe(T0 + 60 * MIN);
    expect(r.utilizationAt).toBe(T0 + MIN);
  });

  it('is a no-op for an unknown id', () => {
    const p = recordAccountWindow(poolOf('a'), 'nope', { utilization: 0.9 }, T0);
    expect(getAccount(p, 'a')!.rate.utilization).toBeUndefined();
  });

  it('clears a prior lastProbeFailedAt marker once a real observation lands', () => {
    let p = recordProbeFailure(poolOf('a'), 'a', T0);
    expect(getAccount(p, 'a')!.rate.lastProbeFailedAt).toBe(T0);
    p = recordAccountWindow(p, 'a', { utilization: 0.5 }, T0 + MIN);
    expect(getAccount(p, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });
});

describe('accountReadingStatus (EI-18809949582687481: freshness verdict)', () => {
  it('never-observed when utilizationAt is undefined', () => {
    expect(accountReadingStatus(getAccount(poolOf('a'), 'a')!, T0)).toEqual({ readingStatus: 'never-observed' });
  });

  it('fresh right after an observation, and at the staleness boundary', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.4 }, T0);
    const a = getAccount(p, 'a')!;
    expect(accountReadingStatus(a, T0)).toEqual({ readingStatus: 'fresh', readingAgeMs: 0 });
    expect(accountReadingStatus(a, T0 + DRAIN_UTIL_STALE_MS)).toEqual({
      readingStatus: 'fresh',
      readingAgeMs: DRAIN_UTIL_STALE_MS,
    });
  });

  it('stale once older than DRAIN_UTIL_STALE_MS', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.4 }, T0);
    const a = getAccount(p, 'a')!;
    expect(accountReadingStatus(a, T0 + DRAIN_UTIL_STALE_MS + 1)).toEqual({
      readingStatus: 'stale',
      readingAgeMs: DRAIN_UTIL_STALE_MS + 1,
    });
  });
});

describe('recordProbeFailure (EI-18809949582687481: no-reading marker)', () => {
  it('stamps lastProbeFailedAt without touching any other rate field', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.3 }, T0);
    p = recordProbeFailure(p, 'a', T0 + MIN);
    const r = getAccount(p, 'a')!.rate;
    expect(r.lastProbeFailedAt).toBe(T0 + MIN);
    expect(r.utilization).toBe(0.3); // untouched — a failed probe must not erase the last real reading
    expect(r.utilizationAt).toBe(T0);
  });

  it('is a no-op for an unknown id', () => {
    const p = recordProbeFailure(poolOf('a'), 'nope', T0);
    expect(getAccount(p, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });
});

describe('selectAccountByDrain (D-003 budget-draining selector)', () => {
  it('with no budget data, degrades to recency order (oldest-added among clean accounts)', () => {
    expect(selectAccountByDrain(poolOf('a', 'b'), T0)!.id).toBe('a');
  });

  it('prefers the account with the most remaining 5h budget (lowest utilization)', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.8 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.2 }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('drains an about-to-reset window first (use-it-before-you-lose-it), over a lower-util fresh window', () => {
    let p = poolOf('a', 'b');
    // a is busier (0.6) but resets in 5 min → its budget vanishes soon → drain it first
    p = recordAccountWindow(p, 'a', { utilization: 0.6, windowResetAt: T0 + 5 * MIN }, T0);
    // b is fresher (0.1) but resets in 4h → its budget persists → keep in reserve
    p = recordAccountWindow(p, 'b', { utilization: 0.1, windowResetAt: T0 + 240 * MIN }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('a');
  });

  it('does NOT treat an about-to-reset but already-full account as urgent', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.99, windowResetAt: T0 + 5 * MIN }, T0); // full → not urgent
    p = recordAccountWindow(p, 'b', { utilization: 0.3, windowResetAt: T0 + 240 * MIN }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('7d-aware: avoids a 5h-fresh but 7d-near-cap account (the aviynw2 trap), preferring both-window headroom', () => {
    let p = poolOf('a', 'b');
    // a = aviynw2: 5h-fresh (0.09) but 7d near the WEEKLY cap (0.96) → effective fullness 0.96.
    p = recordAccountWindow(p, 'a', { utilization: 0.09, utilization7d: 0.96 }, T0);
    // b = aviynw6: headroom in BOTH windows (5h 0.49, 7d 0.39) → effective fullness 0.49 → preferred.
    p = recordAccountWindow(p, 'b', { utilization: 0.49, utilization7d: 0.39 }, T0);
    // 5h-only ranking would (wrongly) pick 'a' (0.09 < 0.49); 7d-aware picks 'b'.
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('ignores stale utilization (older than the staleness horizon) → treats it as most-available', () => {
    let p = poolOf('a', 'b');
    // a's high utilization is stale → treated as 0; b's is fresh at 0.5 → a wins as "emptier"
    p = recordAccountWindow(p, 'a', { utilization: 0.9 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.5 }, T0 + DRAIN_UTIL_STALE_MS + MIN);
    expect(selectAccountByDrain(p, T0 + DRAIN_UTIL_STALE_MS + MIN)!.id).toBe('a');
  });

  it('skips paused accounts and honors exclude', () => {
    let p = poolOf('a', 'b', 'c');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByDrain(p, T0 + MIN, { exclude: ['b'] })!.id).toBe('c');
  });
});

describe('isSpawnEligible (account-spawn-eligibility — D-003 stranding fix)', () => {
  it('an available account is eligible', () => {
    expect(isSpawnEligible(getAccount(poolOf('a'), 'a')!, T0)).toBe(true);
  });

  it('a budget-healthy account is eligible EVEN while paused (a stale single-429 pause must not strand it)', () => {
    // The aviynw case: util5h=0, penaltyCount=1, yet paused to the far-future window reset.
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    const a = getAccount(p, 'a')!;
    expect(isAvailable(a, T0 + MIN)).toBe(false); // narrow availability would exclude it...
    expect(isSpawnEligible(a, T0 + MIN)).toBe(true); // ...but it still has budget, so it's selectable
  });

  it('a genuinely rate-exhausted account (sustained penalties) is NOT eligible', () => {
    let p = poolOf('a');
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + 20 * MIN });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });

  it('a paused account at/over its fresh budget cap is NOT eligible', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 1.0 }, T0); // fresh at-cap reading
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 20 * MIN });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });

  // EI-8070: the original version only consulted isSustainedlyLimited when the account was
  // CURRENTLY paused (`if (isAvailable(a, now)) return true` short-circuited past the check
  // entirely). A real repeated-429 burst racks up 3+ penalties in the 15-min window with each
  // individual pause SHORT — so by the time a later selection call runs, the most recent pause
  // has already lapsed (isAvailable back to true) even though the account is still genuinely
  // struggling. Live: accounts:status showed aviynw7/aviynw8/aviynw8-direct/avistorewolf.com as
  // sustainedlyLimited:true with available:true — fresh cup:spawn placements kept landing there
  // and crash-looped (sessionState:ended within ~20-30s, zero progress).
  it('EI-8070: an AVAILABLE account with a lapsed-but-recent 429 penalty burst is NOT eligible', () => {
    let p = poolOf('a');
    // 3 penalties inside the 15-min window, each with a SHORT pause that has since lapsed.
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + 2 * MIN });
    const checkAt = T0 + 5 * MIN; // after the last pause (T0+2min) lapsed, still inside the 15-min window
    const a = getAccount(p, 'a')!;
    expect(isAvailable(a, checkAt)).toBe(true); // the narrow pause check alone would wrongly say "fine"
    expect(isSustainedlyLimited(a, checkAt)).toBe(true); // the penalty-burst signal IS present
    expect(isSpawnEligible(a, checkAt)).toBe(false); // must exclude it despite being "available"
  });

  it('EI-8070: selectAccountForSpawn never routes a fresh spawn to a lapsed-but-sustained-limited account', () => {
    let p = poolOf('bad', 'good');
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'bad', T0 + i, { pausedUntil: T0 + 2 * MIN });
    const checkAt = T0 + 5 * MIN;
    const sel = selectAccountForSpawn(p, checkAt, {});
    expect(sel.accountId).toBe('good');
  });
});

describe('selectAccountByDrain spread (anti-thundering-herd, 2026-06-23)', () => {
  it('rng()===0 reproduces the deterministic best (spread is opt-in and order-preserving)', () => {
    let p = poolOf('a', 'b', 'c');
    p = recordAccountWindow(p, 'a', { utilization: 0.8 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.1 }, T0); // b has the most headroom
    p = recordAccountWindow(p, 'c', { utilization: 0.8 }, T0);
    expect(selectAccountByDrain(p, T0, { spread: true, rng: () => 0 })!.id).toBe('b');
    expect(selectAccountByDrain(p, T0)!.id).toBe('b'); // == non-spread
  });

  it('spreads a burst across budget-healthy accounts instead of piling on one', () => {
    const p = poolOf('a', 'b', 'c'); // all equal headroom (no util data)
    // Deterministic (no spread): every pick is the same account → the thundering herd.
    const herd = new Set(Array.from({ length: 20 }, () => selectAccountByDrain(p, T0)!.id));
    expect(herd.size).toBe(1);
    // Spread: walking rng across [0,1) lands on multiple distinct accounts → load fans out.
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => selectAccountByDrain(p, T0, { spread: true, rng: () => i / 20 })!.id),
    );
    expect(spread.size).toBeGreaterThan(1);
  });

  it('prefers AVAILABLE accounts; a budget-healthy paused one is selectable only when none are available', () => {
    // One paused (but budget-healthy), one available → the spread must NOT demote the available account.
    let pMixed = poolOf('a', 'b');
    pMixed = recordAccountPenalty(pMixed, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    const mixed = new Set(
      Array.from({ length: 20 }, (_, i) =>
        selectAccountByDrain(pMixed, T0 + MIN, { spread: true, rng: () => i / 20, eligible: isSpawnEligible })!.id,
      ),
    );
    expect(mixed).toEqual(new Set(['b'])); // only the available account is used while one exists

    // BOTH paused but budget-healthy → the narrow `isAvailable` filter strands them (undefined: the bug);
    // spawn eligibility keeps them selectable so the spread still routes across them (no frame-default herd).
    let pBoth = poolOf('a', 'b');
    pBoth = recordAccountPenalty(pBoth, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    pBoth = recordAccountPenalty(pBoth, 'b', T0, { pausedUntil: T0 + 26 * MIN });
    expect(selectAccountByDrain(pBoth, T0 + MIN)).toBeUndefined(); // narrow filter → stranded
    const both = new Set(
      Array.from({ length: 20 }, (_, i) =>
        selectAccountByDrain(pBoth, T0 + MIN, { spread: true, rng: () => i / 20, eligible: isSpawnEligible })!.id,
      ),
    );
    expect(both.has('a')).toBe(true);
    expect(both.has('b')).toBe(true);
  });
});

describe('window-reset expiry — a freed account auto-re-enters rotation (stale-capped-projection fix, 2026-06-29)', () => {
  it('drainUtil expires a FRESH-but-window-reset 5h reading to 0 (no manual accounts:reset-rate needed)', () => {
    // util 0.99 observed at T0 with a 5h window that resets in 2 min. The observation is still FRESH
    // (well within DRAIN_UTIL_STALE_MS) at T0+3min, but the window has RESET — the prior fraction
    // describes a window that no longer exists, so the budget is freed → 0.
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0.99, windowResetAt: T0 + 2 * MIN }, T0);
    const a = getAccount(p, 'a')!;
    expect(drainUtil(a, T0 + MIN)).toBe(0.99); // before the reset: still gated full
    expect(drainUtil(a, T0 + 3 * MIN)).toBe(0); // after the reset, even though the reading is fresh
  });

  it('drainUtil7d expires a FRESH-but-weekly-reset reading to 0', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization7d: 1.0, windowResetAt7d: T0 + 5 * MIN }, T0);
    const a = getAccount(p, 'a')!;
    expect(drainUtil7d(a, T0 + MIN)).toBe(1.0); // weekly window still open → gated full
    expect(drainUtil7d(a, T0 + 6 * MIN)).toBe(0); // weekly window reset → freed (fresh reading notwithstanding)
  });

  it('drainUtil7d STILL holds a weekly-capped account out until its reset (no regression of the aviynw2 trap)', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0.05, utilization7d: 1.0, windowResetAt7d: T0 + 7 * 24 * 60 * MIN }, T0);
    const a = getAccount(p, 'a')!;
    // Stale reading but the weekly window is still open → keeps reading full (the harder constraint).
    expect(drainUtil7d(a, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(1.0);
    // Past the weekly reset → freed.
    expect(drainUtil7d(a, T0 + 8 * 24 * 60 * MIN)).toBe(0);
  });

  it('a window-reset account is no longer accountFull and becomes spawn-eligible / drain-selectable again', () => {
    let p = poolOf('a', 'b');
    // a was weekly-capped (1.0) with its window resetting in 5 min; b is healthy but mid-utilization.
    p = recordAccountWindow(p, 'a', { utilization: 0.1, utilization7d: 1.0, windowResetAt7d: T0 + 5 * MIN }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.5, utilization7d: 0.5, windowResetAt7d: T0 + 7 * 24 * 60 * MIN }, T0);
    const after = T0 + 6 * MIN; // a's weekly window has reset
    const a = getAccount(p, 'a')!;
    expect(accountFull(a, T0 + MIN)).toBe(true); // before the reset: full
    expect(effectiveDrainUtil(a, after)).toBe(0.1); // after: only its (fresh, healthy) 5h reading remains
    expect(accountFull(a, after)).toBe(false);
    expect(isSpawnEligible(a, after)).toBe(true);
    // a (effective 0.1) now beats b (effective 0.5) in the drain selector — the freed account re-enters.
    expect(selectAccountByDrain(p, after)!.id).toBe('a');
  });

  it('isSustainedlyLimited clears once the window resets even with a fresh at-cap reading', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 1.01, windowResetAt: T0 + 2 * MIN }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + MIN)).toBe(true); // before reset
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + 3 * MIN)).toBe(false); // window reset → derived limit cleared
  });

  it('DRAIN_FULL_UTIL guard is unaffected: a still-open at-cap window is full', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: DRAIN_FULL_UTIL, windowResetAt: T0 + 60 * MIN }, T0);
    expect(accountFull(getAccount(p, 'a')!, T0 + MIN)).toBe(true);
  });
});

describe('usageWalledUntil (WI-3310 — the usage limit is a DIFFERENT meter than the rate-limit pause)', () => {
  const WEEK = 7 * 24 * 60 * MIN;

  it('a weekly-exhausted account is walled until windowResetAt7d even though its pause has lapsed', () => {
    // The 2026-07-07 avistorewolf.com incident: util7d=1.0 with the weekly reset DAYS out, while the
    // rate-limit pause is deliberately bounded (≤6h) and lapses long before. Pause expiry must never
    // read as "the usage limit recovered".
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0, utilization7d: 1.0, windowResetAt7d: T0 + WEEK }, T0);
    const a = getAccount(p, 'a')!;
    expect(isAvailable(a, T0 + MIN)).toBe(true); // the pause-only primitive says "usable"…
    expect(usageWalledUntil(a, T0 + MIN)).toBe(T0 + WEEK); // …but the usage wall holds until the weekly reset
    expect(accountFull(a, T0 + MIN)).toBe(true); // and the canonical serve predicate is full
  });

  it('the wall self-expires the instant the window resets (no manual accounts:reset-rate needed)', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization7d: 1.0, windowResetAt7d: T0 + 5 * MIN }, T0);
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + 6 * MIN)).toBe(0);
  });

  it('when both windows are exhausted the LATEST binding reset wins', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 1.0, windowResetAt: T0 + 60 * MIN, utilization7d: 1.0, windowResetAt7d: T0 + WEEK }, T0);
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + MIN)).toBe(T0 + WEEK);
  });

  it('a 5h-only exhaustion walls until the 5h reset', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 1.0, windowResetAt: T0 + 60 * MIN, utilization7d: 0.4, windowResetAt7d: T0 + WEEK }, T0);
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + MIN)).toBe(T0 + 60 * MIN);
  });

  it('sub-cap utilization is NOT a wall', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0.5, windowResetAt: T0 + 60 * MIN, utilization7d: 0.6, windowResetAt7d: T0 + WEEK }, T0);
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + MIN)).toBe(0);
  });

  it('a STALE at-cap weekly reading still walls while its reset is pending (drainUtil7d parity)', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization7d: 1.0, windowResetAt7d: T0 + WEEK }, T0);
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(T0 + WEEK);
  });

  it('an account with no observed windows is never walled (cold pool degrades gracefully)', () => {
    const p = poolOf('a');
    expect(usageWalledUntil(getAccount(p, 'a')!, T0 + MIN)).toBe(0);
  });
});

describe('decideScaleOut (P-021)', () => {
  it('not-sustained when the exhausted account has not crossed the threshold', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    const d = decideScaleOut(p, 'a', T0 + 30_000);
    expect(d).toEqual({ provision: false, reason: 'not-sustained' });
  });

  it('provisions a fresh account when sustained + a fresh one exists', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 1.01 }, T0); // genuinely over 5h budget = sustained
    const d = decideScaleOut(p, 'a', T0);
    expect(d).toEqual({ provision: true, account: expect.objectContaining({ id: 'b' }) });
  });

  it('no-fresh-account when sustained but every other account is paused too', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 1.01 }, T0); // a genuinely over budget
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 20 * MIN }); // b paused → no fresh account
    const d = decideScaleOut(p, 'a', T0);
    expect(d).toEqual({ provision: false, reason: 'no-fresh-account' });
  });

  it('requireSustained:false provisions even on a single penalty (the manual-trigger path)', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    const d = decideScaleOut(p, 'a', T0 + 30_000, { requireSustained: false });
    expect(d).toMatchObject({ provision: true, account: { id: 'b' } });
  });
});

describe('egressEntries — per-account egress IP pool (gateway-per-account-egress-ip-pool-2026-06-30)', () => {
  it('returns an explicit egressPool verbatim, INCLUDING a {} entry (= the box-default egress, a valid distinct IP)', () => {
    expect(egressEntries({ egressPool: [{ proxyUrl: 'http://p1:3128' }, {}] })).toEqual([{ proxyUrl: 'http://p1:3128' }, {}]);
  });
  it('treats the singular legacy `egress` as a 1-entry pool when it actually routes (back-compat)', () => {
    expect(egressEntries({ egress: { proxyUrl: 'http://p1:3128' } })).toEqual([{ proxyUrl: 'http://p1:3128' }]);
    expect(egressEntries({ egress: { localAddress: '10.0.0.7' } })).toEqual([{ localAddress: '10.0.0.7' }]);
  });
  it('a non-empty egressPool SUPERSEDES the singular egress', () => {
    expect(
      egressEntries({ egress: { proxyUrl: 'http://legacy:3128' }, egressPool: [{ proxyUrl: 'http://p1:3128' }] }),
    ).toEqual([{ proxyUrl: 'http://p1:3128' }]);
  });
  it('no egress + no pool ⇒ [] (default shared egress), and a bare {} SINGULAR egress is NOT a pool entry', () => {
    expect(egressEntries({})).toEqual([]);
    expect(egressEntries({ egress: {} })).toEqual([]);
    expect(egressEntries({ egressPool: [] })).toEqual([]);
  });
});

describe('registerAccount — egressPool round-trips (gateway-per-account-egress-ip-pool-2026-06-30)', () => {
  it('persists egressPool on create, keeps it on an omitted update, replaces it when provided', () => {
    let p = emptyPool();
    p = registerAccount(p, { id: 'a', credentialRef: 'token:/x', egressPool: [{ proxyUrl: 'http://p1:3128' }, {}] }, T0);
    expect(getAccount(p, 'a')?.egressPool).toEqual([{ proxyUrl: 'http://p1:3128' }, {}]);
    // an update that omits egressPool preserves the existing pool (idempotent re-register)
    p = registerAccount(p, { id: 'a', credentialRef: 'token:/x' }, T0 + MIN);
    expect(getAccount(p, 'a')?.egressPool).toEqual([{ proxyUrl: 'http://p1:3128' }, {}]);
    // an update that provides egressPool replaces it
    p = registerAccount(p, { id: 'a', credentialRef: 'token:/x', egressPool: [{ proxyUrl: 'http://p2:3128' }] }, T0 + 2 * MIN);
    expect(getAccount(p, 'a')?.egressPool).toEqual([{ proxyUrl: 'http://p2:3128' }]);
  });
});

describe('partially-hydrated rows (WI-3068 — codex CLI-bridge read as permanently paused)', () => {
  // A pool row persisted with `rate: {}` (hand-written / partial writer) made `isAvailable`
  // evaluate `undefined <= now` → false, so the account read paused-forever while its bridge
  // served fine. Guard BOTH layers: the tolerant predicate and the load-time normalizer.
  const cliRow = {
    id: 'chatgpt-sub-cli',
    provider: 'codex',
    credentialRef: 'codex-cli:/home/x/.codex',
    addedAt: T0,
    boundTo: [],
    rate: {},
  } as never as Parameters<typeof isAvailable>[0];

  it('isAvailable treats a missing pausedUntil as "never paused", not "paused forever"', () => {
    expect(isAvailable(cliRow, T0 + MIN)).toBe(true);
    // and a genuinely-paused normalized row still reads unavailable
    const paused = normalizeAccount({ ...cliRow, rate: { pausedUntil: T0 + 10 * MIN } as never });
    expect(isAvailable(paused, T0 + MIN)).toBe(false);
  });

  it('normalizeAccount re-hydrates required rate counters and defaults boundTo, keeping observed budget fields', () => {
    const n = normalizeAccount({ ...cliRow, boundTo: undefined as never, rate: { utilization: 0.4 } as never });
    expect(n.rate).toMatchObject({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, utilization: 0.4 });
    expect(n.boundTo).toEqual([]);
    // NaN in a required counter is repaired too (would poison the penalty Math.max chain)
    const nan = normalizeAccount({ ...cliRow, rate: { pausedUntil: Number.NaN } as never });
    expect(nan.rate.pausedUntil).toBe(0);
    // a fully-formed row round-trips unchanged
    const full = getAccount(poolOf('a'), 'a')!;
    expect(normalizeAccount(full)).toEqual(full);
  });
});

/** WI-6554700010030570 — the durable Codex per-model refusal field the gateway re-seeds from. */
describe('setAccountModelRefusal', () => {
  const codexPool = (): AccountPool =>
    registerAccount(emptyPool(), { id: 'cx', provider: 'codex', credentialRef: 'codex-cli:/tmp/cx' }, T0);
  const refusal = (model: string, reportUntil: number) => ({
    model, since: T0, lastAt: T0, until: T0 + 30 * MIN, reportUntil, hits: 1, detail: 'not supported',
  });

  it('writes under the lower-cased model key and clears it with null', () => {
    let p = setAccountModelRefusal(codexPool(), 'cx', 'GPT-5.6-Sol', refusal('GPT-5.6-Sol', T0 + 60 * MIN), T0);
    expect(getAccount(p, 'cx')!.rate.modelRefusals).toEqual({ 'gpt-5.6-sol': refusal('GPT-5.6-Sol', T0 + 60 * MIN) });
    p = setAccountModelRefusal(p, 'cx', 'gpt-5.6-sol', null, T0 + MIN);
    expect(getAccount(p, 'cx')!.rate).not.toHaveProperty('modelRefusals');
  });

  it('prunes entries past their report horizon on any write, and never stores an already-lapsed one', () => {
    let p = setAccountModelRefusal(codexPool(), 'cx', 'old', refusal('old', T0 + 10 * MIN), T0);
    p = setAccountModelRefusal(p, 'cx', 'keep', refusal('keep', T0 + 90 * MIN), T0);
    p = setAccountModelRefusal(p, 'cx', 'new', refusal('new', T0 + 120 * MIN), T0 + 20 * MIN);
    expect(Object.keys(getAccount(p, 'cx')!.rate.modelRefusals ?? {}).sort()).toEqual(['keep', 'new']);
    p = setAccountModelRefusal(p, 'cx', 'stale', refusal('stale', T0 + 20 * MIN), T0 + 20 * MIN);
    expect(Object.keys(getAccount(p, 'cx')!.rate.modelRefusals ?? {}).sort()).toEqual(['keep', 'new']);
  });

  it('is a no-op for an unknown account', () => {
    const p = codexPool();
    expect(setAccountModelRefusal(p, 'nope', 'm', refusal('m', T0 + 60 * MIN), T0)).toEqual(p);
  });

  it('survives a rate reset in both modes — a refusal is an entitlement, not a rate reading', () => {
    const p = setAccountModelRefusal(codexPool(), 'cx', 'm', refusal('m', T0 + 60 * MIN), T0);
    for (const resetWindows of [false, true]) {
      expect(getAccount(recordAccountReset(p, 'cx', { resetWindows }), 'cx')!.rate.modelRefusals)
        .toEqual({ m: refusal('m', T0 + 60 * MIN) });
    }
    expect(getAccount(recordAccountReset(codexPool(), 'cx'), 'cx')!.rate).not.toHaveProperty('modelRefusals');
  });
});
