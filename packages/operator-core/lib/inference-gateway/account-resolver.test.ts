import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../deployment/account-pool-store', () => ({ loadAccountPool: vi.fn(), readDefaultAccountId: vi.fn() }));
vi.mock('../deployment/account-pool', () => ({ accountByCredentialRef: vi.fn() }));

import { resolveBoundAccount, resolveAccountPool, poolAccountIdForRef, localLoginCredentialRef } from './account-resolver';
import { loadAccountPool, readDefaultAccountId } from '../deployment/account-pool-store';
import { accountByCredentialRef } from '../deployment/account-pool';

import type { ClaudeAccount } from '../deployment/account-pool';

const mockedLoad = vi.mocked(loadAccountPool);
const mockedByRef = vi.mocked(accountByCredentialRef);
const mockedDefault = vi.mocked(readDefaultAccountId);

/**
 * A COMPLETE `ClaudeAccount`, so the pool fixtures below satisfy `AccountPool` on their own
 * and every `mockResolvedValue` can take them UNCAST.
 *
 * The whole file previously closed each mock setter with `as never` (37 of them), which is the
 * idiom `lint:mock-cast-escape` exists to stop: the cast silences the fixture type-check, so
 * when `ClaudeAccount` gains a required field these fixtures go stale INVISIBLY to tsc and fail
 * at runtime in some other file. Pass field overrides through `extra` rather than re-adding a
 * cast. Mirrors the sibling convention in `capacity-probe.test.ts`.
 */
const acct = (id: string, credentialRef: string, extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id,
  credentialRef,
  addedAt: 0,
  boundTo: [],
  rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
  ...extra,
});

/**
 * No default set is the overwhelmingly common case, so it is the baseline every test
 * starts from — `undefined` here means "the owner marked no default", which is NOT the
 * same as a read failure (that throws, and is asserted separately below).
 */
const noDefault = () => mockedDefault.mockResolvedValue(undefined);

describe('resolveBoundAccount', () => {
  it('carries the Anthropic workspace through full-pool, sole, pinned and default account resolution', async () => {
    const api = acct('api', 'apikey:env:TEST_API_KEY', { anthropicWorkspaceId: 'wrkspc_bound' });
    mockedLoad.mockResolvedValue({ accounts: [api] });
    expect((await resolveAccountPool('ws'))[0]?.anthropicWorkspaceId).toBe('wrkspc_bound');
    expect((await resolveBoundAccount('ws')).anthropicWorkspaceId).toBe('wrkspc_bound');
    process.env.PAPERCUSP_ACCOUNT_ID = 'api';
    expect((await resolveBoundAccount('ws')).anthropicWorkspaceId).toBe('wrkspc_bound');
    delete process.env.PAPERCUSP_ACCOUNT_ID;
    mockedDefault.mockResolvedValue('api');
    expect((await resolveBoundAccount('ws')).anthropicWorkspaceId).toBe('wrkspc_bound');
  });

  const savedAccountId = process.env.PAPERCUSP_ACCOUNT_ID;
  beforeEach(() => {
    vi.clearAllMocks();
    noDefault();
    delete process.env.PAPERCUSP_ACCOUNT_ID;
  });
  afterEach(() => {
    if (savedAccountId === undefined) delete process.env.PAPERCUSP_ACCOUNT_ID;
    else process.env.PAPERCUSP_ACCOUNT_ID = savedAccountId;
  });

  it('uses the env-pinned account when PAPERCUSP_ACCOUNT_ID matches a pool account', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'acct-b';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a'), acct('acct-b', 'ref:b')] });
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'acct-b', credentialRef: 'ref:b', source: 'env',
    });
  });

  it('throws when the env-pinned account id is not in the pool', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'missing';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a')] });
    await expect(resolveBoundAccount('ws')).rejects.toThrow(/not in the account pool/);
  });

  it('carries the account egress (per-account IP routing, B-GW-3) through to the resolved account', async () => {
    // End-to-end leg: the resolver must NOT drop a registered account's egress, else the gateway
    // never builds its per-account dispatcher and all subscriptions share one egress IP.
    process.env.PAPERCUSP_ACCOUNT_ID = 'acct-b';
    mockedLoad.mockResolvedValue({
      accounts: [acct('acct-a', 'ref:a'), acct('acct-b', 'ref:b', { egress: { proxyUrl: 'http://10.0.0.2:3128' } })],
    });
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'acct-b', credentialRef: 'ref:b', egress: { proxyUrl: 'http://10.0.0.2:3128' }, source: 'env',
    });
  });

  it('carries the account egressPool through to the resolved account (gateway-per-account-egress-ip-pool-2026-06-30)', async () => {
    // The resolver must thread egressPool so the gateway can rotate across per-account IPs.
    process.env.PAPERCUSP_ACCOUNT_ID = 'acct-b';
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('acct-a', 'ref:a'),
        acct('acct-b', 'ref:b', { egressPool: [{ proxyUrl: 'http://10.0.0.2:3128' }, {}] }),
      ],
    });
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'acct-b',
      credentialRef: 'ref:b',
      egressPool: [{ proxyUrl: 'http://10.0.0.2:3128' }, {}],
      source: 'env',
    });
  });

  it('uses the sole pool account when there is no env pin and exactly one account', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] });
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'only', credentialRef: 'ref:only', source: 'sole-pool-account',
    });
  });

  it('falls back to the local login bundle when the pool is empty', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] });
    const r = await resolveBoundAccount('ws');
    expect(r.accountId).toBe('local');
    expect(r.source).toBe('local-fallback');
    expect(r.credentialRef).toMatch(/^file:.*\.claude\/\.credentials\.json$/);
  });

  it('falls back to local when >1 account and no env pin (ambiguous → safe default)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    expect((await resolveBoundAccount('ws')).source).toBe('local-fallback');
  });

  it('FAILS CLOSED on a pool-load error — throws rather than silently using the local credential', async () => {
    // Regression (silent-local-fallback fault): a swallowed read error used to collapse the
    // lifetime-cached pool to `local`, silently ignoring every account pin for hours. A load
    // FAILURE must fail closed (the supervised gateway exits → systemd restarts → retries); only a
    // genuinely EMPTY pool resolves to local.
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveBoundAccount('ws')).rejects.toThrow(/account-pool load failed/);
  });

  it('trims surrounding whitespace on PAPERCUSP_ACCOUNT_ID before matching a pool account', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '  acct-b  ';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a'), acct('acct-b', 'ref:b')] });
    expect(await resolveBoundAccount('ws')).toEqual({ accountId: 'acct-b', credentialRef: 'ref:b', source: 'env' });
  });

  it('treats a whitespace-only PAPERCUSP_ACCOUNT_ID as NO pin (falls through to the sole pool account)', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '   ';
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] });
    expect(await resolveBoundAccount('ws')).toEqual({ accountId: 'only', credentialRef: 'ref:only', source: 'sole-pool-account' });
  });

  // ── the owner's default account (default-deploy-account-2026-08-08 P-003) ──

  it('uses the owner default INSTEAD of the local fallback when >1 account (the ambiguity it resolves)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockResolvedValue('b');
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'b', credentialRef: 'ref:b', egress: undefined, egressPool: undefined, source: 'default-account',
    });
  });

  it('reports `default-account`, not `sole-pool-account`, when the default names the only account', async () => {
    // They pick the same credential, so this is purely about ATTRIBUTION: the default is
    // checked ABOVE the sole-pool shortcut so /healthz and the logs can answer "why is it on
    // this account" from `source` alone. Collapsing the two would make an explicit owner
    // choice indistinguishable from a box that happens to have one account registered.
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] });
    mockedDefault.mockResolvedValue('only');
    expect((await resolveBoundAccount('ws')).source).toBe('default-account');
  });

  it('the env pin still outranks the owner default', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'a';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockResolvedValue('b');
    const r = await resolveBoundAccount('ws');
    expect([r.accountId, r.source]).toEqual(['a', 'env']);
    expect(mockedDefault).not.toHaveBeenCalled(); // resolved before the default is even read
  });

  it('carries the default account’s egress + egressPool through', async () => {
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('a', 'ref:a'),
        acct('b', 'ref:b', { egress: { localAddress: '10.0.0.2' }, egressPool: [{}] }),
      ],
    });
    mockedDefault.mockResolvedValue('b');
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'b',
      credentialRef: 'ref:b',
      egress: { localAddress: '10.0.0.2' },
      egressPool: [{}],
      source: 'default-account',
    });
  });

  it('a STALE default naming a removed account DEGRADES to the next rule — it does not throw (D-003)', async () => {
    // Deliberately asymmetric with the env pin, which throws on the same input. The env pin is
    // set by an operator for one process and should fail loudly; the default is persisted
    // config that outlives the account it names, so removing an account must not wedge routing.
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] });
    mockedDefault.mockResolvedValue('deleted-account');
    expect((await resolveBoundAccount('ws')).source).toBe('sole-pool-account');
  });

  it('a stale default with an ambiguous pool degrades all the way to the local login, still no throw', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockResolvedValue('deleted-account');
    expect((await resolveBoundAccount('ws')).source).toBe('local-fallback');
  });

  it('a default naming a CODEX account never matches the Claude pool (it degrades instead)', async () => {
    // ⚠ This is now a FIRST-CLASS supported state, not defence in depth. Until
    // inference-rename-and-provider-agnostic-default-2026-08-09 P-003, setDefaultAccount rejected
    // a Codex id at the write, so this test guarded a row that "should not exist"; a Codex
    // default is now a normal thing an owner can set from the UI. Do not delete this as
    // unreachable — it is the guard that Claude traffic never egresses on a Codex credential,
    // and it is exercised every time someone sets a Codex default.
    mockedLoad.mockResolvedValue({
      accounts: [acct('claude-a', 'ref:claude-a'), acct('codex-a', 'ref:codex-a', { provider: 'codex' })],
    });
    mockedDefault.mockResolvedValue('codex-a');
    expect((await resolveBoundAccount('ws')).source).toBe('sole-pool-account');
  });

  it('FAILS CLOSED on a default-read error — never silently degrades to the local login', async () => {
    // The mirror of the pool-load fail-closed rule, through the other door: an unreadable
    // override row must not resolve as "no default set" (undefined), because the gateway caches
    // its resolution for its whole lifetime — that would route every unpinned call to the box's
    // own credential for hours while looking perfectly healthy.
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockRejectedValue(new Error('pg down'));
    await expect(resolveBoundAccount('ws')).rejects.toThrow(/default-account read failed/);
    expect(mockedDefault).toHaveBeenCalledTimes(3); // same retry budget as the pool load
  });

  it('retries a TRANSIENT default-read blip then succeeds', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockRejectedValueOnce(new Error('blip')).mockResolvedValue('b');
    expect((await resolveBoundAccount('ws')).accountId).toBe('b');
  });
});

describe('resolveAccountPool (EI-535 failover)', () => {
  const savedAccountId = process.env.PAPERCUSP_ACCOUNT_ID;
  beforeEach(() => {
    vi.clearAllMocks();
    noDefault();
    delete process.env.PAPERCUSP_ACCOUNT_ID;
  });
  afterEach(() => {
    if (savedAccountId === undefined) delete process.env.PAPERCUSP_ACCOUNT_ID;
    else process.env.PAPERCUSP_ACCOUNT_ID = savedAccountId;
  });

  it('returns ALL pool accounts in order when there is no pin (not ambiguous → use them all)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a', 'b']);
  });

  it('R-37: resolves ONLY the asked workspace’s pool — an account registered in another workspace never appears (D-001)', async () => {
    const pools: Record<string, ClaudeAccount[]> = {
      'ws-a': [acct('a-sub', 'token:/a-sub'), acct('a-key', 'apikey:env:WS_A_KEY')],
      'ws-b': [acct('b-key', 'apikey:env:WS_B_KEY')],
    };
    mockedLoad.mockImplementation(async (ws?: string) => ({ accounts: ws ? (pools[ws] ?? []) : [] }));
    expect((await resolveAccountPool('ws-a')).map((p) => p.accountId)).toEqual(['a-sub', 'a-key']);
    expect((await resolveAccountPool('ws-b')).map((p) => p.accountId)).toEqual(['b-key']);
    // Each resolution read its own workspace's pool row and no other.
    expect(mockedLoad.mock.calls.map((c) => c[0])).toEqual(['ws-a', 'ws-b']);
  });

  it('filters provider-specific pools and does not mix Codex accounts into the Claude pool', async () => {
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('claude-a', 'ref:claude-a'),
        acct('codex-a', 'ref:codex-a', { provider: 'codex' }),
      ],
    });
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['claude-a']);
    expect((await resolveAccountPool('ws', 'codex')).map((p) => p.accountId)).toEqual(['codex-a']);
  });

  it('puts the env-pinned account FIRST (primary) with the rest as failover targets', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'b';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')] });
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.accountId)).toEqual(['b', 'a', 'c']);
    expect(pool[0].source).toBe('env');
  });

  it('throws when the pinned id is not in the pool', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'missing';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a')] });
    await expect(resolveAccountPool('ws')).rejects.toThrow(/not in the account pool/);
  });

  it('carries each account egress through (end-to-end per-account IP routing, B-GW-3)', async () => {
    // Both egress forms (proxyUrl + bound localAddress) and a no-egress account must survive the
    // resolve → so the gateway can route each account through its own dispatcher (or shared default).
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('a', 'ref:a', { egress: { proxyUrl: 'http://10.0.0.1:3128' } }),
        acct('b', 'ref:b', { egress: { localAddress: '10.0.0.2' } }),
        acct('c', 'ref:c'),
      ],
    });
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.egress)).toEqual([
      { proxyUrl: 'http://10.0.0.1:3128' },
      { localAddress: '10.0.0.2' },
      undefined,
    ]);
  });

  it('carries each account egress POOL through (gateway-per-account-egress-ip-pool-2026-06-30)', async () => {
    // An account's egressPool must survive the resolve path so the gateway can rotate across its IPs.
    // A {} entry means "the box-direct IP" — a valid distinct egress, not a no-op. An account with
    // only the singular `egress` must still carry that field (the resolver does not touch it). An
    // account with neither must come through with both fields undefined.
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('a', 'ref:a', { egressPool: [{ proxyUrl: 'http://10.0.0.1:3128' }, {}] }),
        acct('b', 'ref:b', { egress: { proxyUrl: 'http://10.0.0.2:3128' } }),
        acct('c', 'ref:c'),
      ],
    });
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.egressPool)).toEqual([
      [{ proxyUrl: 'http://10.0.0.1:3128' }, {}],
      undefined,
      undefined,
    ]);
    // singular egress is still carried for the single-egress account
    expect(pool[1].egress).toEqual({ proxyUrl: 'http://10.0.0.2:3128' });
  });

  it('falls back to a single local account when the pool is empty', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] });
    const pool = await resolveAccountPool('ws');
    expect(pool).toHaveLength(1);
    expect(pool[0].source).toBe('local-fallback');
  });

  it('FAILS CLOSED on a pool-load error — throws rather than degrading to the local credential', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws')).rejects.toThrow(/account-pool load failed/);
  });

  it('retries a TRANSIENT load error then succeeds (a PG blip must not collapse the pool)', async () => {
    mockedLoad
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a', 'b']);
  });

  it('retries up to POOL_LOAD_ATTEMPTS (3): succeeds on the LAST attempt after 2 transient failures', async () => {
    mockedLoad
      .mockRejectedValueOnce(new Error('blip-1'))
      .mockRejectedValueOnce(new Error('blip-2'))
      .mockResolvedValue({ accounts: [acct('a', 'ref:a')] });
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a']);
    expect(mockedLoad).toHaveBeenCalledTimes(3);
  });

  it('fails closed after EXACTLY POOL_LOAD_ATTEMPTS (3) attempts — does not retry forever', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws')).rejects.toThrow(/account-pool load failed/);
    expect(mockedLoad).toHaveBeenCalledTimes(3);
  });

  it('an EMPTY codex pool resolves to [] — codex has no local-login fallback (only claude does)', async () => {
    // Only a claude account is registered; the codex pool is empty. claude empty → local fallback,
    // but codex empty MUST return [] (there is no box-local codex login to degrade to).
    mockedLoad.mockResolvedValue({ accounts: [acct('claude-a', 'ref:claude-a')] });
    expect(await resolveAccountPool('ws', 'codex')).toEqual([]);
  });

  it('trims surrounding whitespace on PAPERCUSP_ACCOUNT_ID when choosing the primary', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '  b  ';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')] });
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['b', 'a', 'c']);
  });

  // ── the owner's default is the failover PRIMARY, never a filter (D-003) ────

  it('REORDERS the default to the front and keeps every other account behind it as failover', async () => {
    // The tail is the assertion that matters. Asserting only pool[0] would pass just as
    // happily against a `filter(a => a.id === defaultId)` implementation — which is exactly
    // the regression D-003 forbids, because it turns a preference into a hard pin and leaves
    // in-process traffic with nothing to fail over to when that account hits its rate window.
    mockedLoad.mockResolvedValue({
      accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')],
    });
    mockedDefault.mockResolvedValue('b');
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.accountId)).toEqual(['b', 'a', 'c']);
    expect(pool).toHaveLength(3); // no narrowing
    expect(pool.map((p) => p.source)).toEqual(['default-account', 'pool', 'pool']);
  });

  it('the env pin outranks the default, and the default is not even read', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'c';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')] });
    mockedDefault.mockResolvedValue('b');
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.accountId)).toEqual(['c', 'a', 'b']);
    expect(pool[0].source).toBe('env');
    expect(mockedDefault).not.toHaveBeenCalled();
  });

  it('a STALE default falls through to plain pool order rather than throwing', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockResolvedValue('deleted-account');
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.accountId)).toEqual(['a', 'b']);
    expect(pool.map((p) => p.source)).toEqual(['pool', 'pool']);
  });

  it('PROMOTES a Codex default for a codex pool', async () => {
    // Inverted by inference-rename-and-provider-agnostic-default-2026-08-09 P-003: the default
    // used to be skipped entirely for codex because it "could only ever name a Claude account".
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('codex-a', 'ref:codex-a', { provider: 'codex' }),
        acct('codex-b', 'ref:codex-b', { provider: 'codex' }),
      ],
    });
    mockedDefault.mockResolvedValue('codex-b');
    const pool = await resolveAccountPool('ws', 'codex');
    expect(pool.map((p) => p.accountId)).toEqual(['codex-b', 'codex-a']);
    expect(pool[0].source).toBe('default-account');
  });

  it('does NOT let a CODEX default front the CLAUDE pool, or vice versa (D-002)', async () => {
    // The cross-provider guard is STRUCTURAL — the default is looked up inside the already
    // provider-filtered list — so this is the test that would catch someone "simplifying" the
    // lookup to search the whole pool. Both directions, because one-way would pass on a bug
    // that only leaks the other way.
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('claude-a', 'ref:claude-a'),
        acct('claude-b', 'ref:claude-b'),
        acct('codex-a', 'ref:codex-a', { provider: 'codex' }),
      ],
    });
    mockedDefault.mockResolvedValue('codex-a');
    const claudePool = await resolveAccountPool('ws', 'claude');
    expect(claudePool.map((p) => p.accountId)).toEqual(['claude-a', 'claude-b']);
    expect(claudePool.map((p) => p.source)).toEqual(['pool', 'pool']);

    mockedDefault.mockResolvedValue('claude-a');
    const codexPool = await resolveAccountPool('ws', 'codex');
    expect(codexPool.map((p) => p.accountId)).toEqual(['codex-a']);
    expect(codexPool[0].source).toBe('pool');
  });

  it('FAILS CLOSED on a default-read error for a CODEX pool too', async () => {
    // Consequence of reading the default for every provider: a codex resolve is now exposed to
    // the same read failure claude always was. That is the intended trade — the value CAN apply
    // to codex now, so silently serving unordered pool order would ignore a real owner choice.
    mockedLoad.mockResolvedValue({
      accounts: [acct('codex-a', 'ref:codex-a', { provider: 'codex' })],
    });
    mockedDefault.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws', 'codex')).rejects.toThrow(/default-account read failed/);
  });

  it('the default is not consulted for an EMPTY claude pool (local fallback short-circuits first)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] });
    mockedDefault.mockResolvedValue('b');
    expect((await resolveAccountPool('ws'))[0].source).toBe('local-fallback');
  });

  it('FAILS CLOSED on a default-read error rather than serving unordered pool order', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] });
    mockedDefault.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws')).rejects.toThrow(/default-account read failed/);
  });
});

describe('poolAccountIdForRef', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the account id for a known credential ref', () => {
    mockedByRef.mockReturnValue(acct('acct-x', 'ref:x'));
    expect(poolAccountIdForRef({ accounts: [] }, 'ref:x')).toBe('acct-x');
  });

  it('returns undefined for an unknown credential ref', () => {
    mockedByRef.mockReturnValue(undefined);
    expect(poolAccountIdForRef({ accounts: [] }, 'ref:nope')).toBeUndefined();
  });
});

describe('localLoginCredentialRef (darwin freshest-scan channel)', () => {
  it('darwin ALWAYS routes to the keychain: scan channel — a stale on-disk snapshot must never shadow the live Keychain bundles (the 2026-07-06 fleet-member login root cause)', () => {
    expect(localLoginCredentialRef({ platform: 'darwin', home: '/Users/u' })).toBe(
      'keychain:Claude Code-credentials',
    );
  });
  it('linux always uses the file ref (even when absent — the resolve-time error is the right surface there)', () => {
    expect(localLoginCredentialRef({ platform: 'linux', home: '/home/u' })).toBe(
      'file:/home/u/.claude/.credentials.json',
    );
  });
});
