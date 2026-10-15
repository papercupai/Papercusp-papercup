/**
 * accounts.test.ts — the accounts:* HANDLERS (the pure pool ops registerAccount/
 * removeAccount/recordAccountReset + the store load/save are mocked). These manage the
 * Queen's Claude-account pool — the multi-account routing the whole fleet depends on —
 * so the handler wiring is worth pinning:
 *   • register: updateAccountPool(register)→getAccount, and never-throw (400-char truncation);
 *   • remove: the `removed` flag reflects whether the account existed;
 *   • reset-rate: the unknown_account guard (no save when absent) + the success path;
 *   • scale_out: the force→requireSustained mapping (force skips the sustained check)
 *     and never-throw.
 * A regression in any of these silently breaks account management. Pure-op correctness
 * lives in the account-pool unit tests; this covers the tool layer.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/accounts.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: vi.fn(),
  // WI-38164: the handlers write through the ATOMIC updateAccountPool(mutator), never a
  // blind saveAccountPool(snapshot). The mock runs the mutator so the pure-op mocks below
  // still record their calls — and so a handler that reverts to load-then-save fails here.
  updateAccountPool: vi.fn(),
  accountStatus: vi.fn(),
  // P-002: accounts:status rolls the interleaved rows up per provider. The rollup's own logic
  // is proven in account-pool-store.test.ts; here we only prove the handler WIRES it.
  poolVerdictByProvider: vi.fn(() => []),
  handleAccountExhausted: vi.fn(),
  defaultScaleOutDeps: vi.fn(() => ({})),
}));
vi.mock('../../deployment/account-pool', () => ({
  accountsForProvider: vi.fn((pool: { accounts: Array<{ provider?: string }> }, provider: string) =>
    pool.accounts.filter((account) => (account.provider ?? 'claude') === provider)),
  registerAccount: vi.fn(() => 'POOL2'),
  removeAccount: vi.fn(() => 'POOL2'),
  recordAccountReset: vi.fn(() => 'POOL2'),
  getAccount: vi.fn(() => ({ id: 'A1', label: 'acct' })),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
// The live gateway seam. Unmocked, accounts:status and accounts:reset-rate would make REAL
// requests to the :8788 gateway on this box from a unit test. Default: the gateway is down.
vi.mock('../../inference-gateway/observability', () => ({
  fetchGatewayStatsRaw: vi.fn(async () => null),
  readmitGatewayAccounts: vi.fn(async () => ({ reachable: false, readmitted: [] })),
}));

import {
  loadAccountPool,
  updateAccountPool,
  handleAccountExhausted,
  accountStatus,
  poolVerdictByProvider,
  type AccountStatusRow,
  type ProviderPoolVerdict,
} from '../../deployment/account-pool-store';
import { getAccount, recordAccountReset } from '../../deployment/account-pool';
import { fetchGatewayStatsRaw } from '../../inference-gateway/observability';
import type { GatewayAccountBilling } from '../../inference-gateway/gateway';
import type { RawGatewayStats } from '../../inference-gateway/gateway-wedge';
import { mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
const statsM = vi.mocked(fetchGatewayStatsRaw);
const loadM = vi.mocked(loadAccountPool);
const saveM = vi.mocked(updateAccountPool);
const exhaustM = vi.mocked(handleAccountExhausted);
const getAcct = vi.mocked(getAccount);
const statusM = vi.mocked(accountStatus);
const verdictM = vi.mocked(poolVerdictByProvider);
const resetM = vi.mocked(recordAccountReset);

const mod = await import('./accounts');
const registerTool = mod.default;
const removeTool = mod.accountsRemoveTool;
const resetTool = mod.accountsResetRateTool;
const scaleTool = mod.accountsScaleOutTool;
const statusTool = mod.accountsStatusTool;
const listTool = mod.accountsListTool;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));
const listArgsSchema = listTool.args as { safeParse: (value: unknown) => { success: boolean } };

beforeEach(() => {
  vi.clearAllMocks();
  loadM.mockResolvedValue({ accounts: [] } as never);
  // Run the mutator against a stand-in pool, exactly as the real atomic RMW does.
  saveM.mockImplementation((async (mutator: (p: unknown) => unknown) => mutator({ accounts: [] })) as never);
  getAcct.mockReturnValue({ id: 'A1', label: 'acct' } as never);
});

describe('accounts:register', () => {
  it('registers, saves, and returns the account', async () => {
    const b = body(await registerTool.handler({ id: 'A1', credentialRef: 'token:/p' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, account: { id: 'A1' } });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('R-37: registering into a named workspace writes ONLY that workspace’s pool (D-001 tenancy)', async () => {
    const b = body(
      await registerTool.handler({ id: 'K1', credentialRef: 'apikey:env:WS_B_KEY', workspace: 'ws-b' } as never, {} as never) as Out,
    );
    expect(b.ok).toBe(true);
    expect(saveM).toHaveBeenCalledTimes(1);
    // The pool row is keyed by workspace: the write targets ws-b, never the active workspace.
    expect(saveM.mock.calls[0][1]).toBe('ws-b');
  });

  it('never throws — a store failure becomes { ok:false, error } truncated to 400', async () => {
    saveM.mockRejectedValue(new Error('y'.repeat(500)));
    const b = body(await registerTool.handler({ id: 'A1', credentialRef: 'token:/p' } as never, {} as never) as Out);
    expect(b.ok).toBe(false);
    expect(String(b.error).length).toBe(400);
  });
});

describe('accounts:remove (bulk keyed-array, P-006)', () => {
  it('n=1 { id } reports removed:true when the account existed; one keyed result', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await removeTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'A1', removed: true });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('reports removed:false when the account did not exist', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await removeTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b.results[0]).toMatchObject({ ok: true, id: 'ghost', removed: false });
  });

  it('ids:[…] removes many, each result keyed by id', async () => {
    getAcct.mockImplementation((_pool: unknown, id: string) => (id === 'A1' ? ({ id } as never) : (undefined as never)));
    const b = body(await removeTool.handler({ ids: ['A1', 'gone'] } as never, {} as never) as Out);
    expect(b.counts).toEqual({ ok: 2, failed: 0 }); // both remove ops succeed; `removed` differs
    expect(b.results.map((r: any) => [r.id, r.removed])).toEqual([
      ['A1', true],
      ['gone', false],
    ]);
    expect(saveM).toHaveBeenCalledTimes(2);
  });
});

describe('accounts:reset-rate (bulk keyed-array, P-006)', () => {
  it('n=1 guards unknown_account as that item\'s { ok:false } and does NOT save', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await resetTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'ghost', error: 'unknown_account' });
    expect(saveM).not.toHaveBeenCalled();
  });

  it('resets a known account and saves; one keyed result', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await resetTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b.results[0]).toMatchObject({ ok: true, id: 'A1', account: { id: 'A1' } });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('ids:[…] resets many; an unknown one fails ONLY itself (no save for it)', async () => {
    getAcct.mockImplementation((_pool: unknown, id: string) => (id === 'gone' ? (undefined as never) : ({ id } as never)));
    const b = body(await resetTool.handler({ ids: ['A1', 'gone', 'A2'] } as never, {} as never) as Out);
    expect(b.ok).toBe(false); // DERIVED from counts.failed — 'gone' failed
    expect(b.counts).toEqual({ ok: 2, failed: 1 }); // …but the batch still RAN: A1/A2 succeeded
    expect(b.results.map((r: any) => [r.id, r.ok])).toEqual([
      ['A1', true],
      ['gone', false],
      ['A2', true],
    ]);
    expect(b.results[1]).toMatchObject({ error: 'unknown_account' });
    expect(saveM).toHaveBeenCalledTimes(2); // only the two known accounts saved
  });

  // WI-3553: resetWindows is the deliberate owner override that also zeroes the observed-budget
  // projection. Default-off must stay byte-identical to pre-WI-3553 behavior (no resetWindows arg
  // reaches the pure op at all — undefined, not false, so an old mock/snapshot notices no change).
  it('default (no resetWindows arg) passes resetWindows:undefined through — byte-identical to pre-WI-3553', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    await resetTool.handler({ id: 'A1' } as never, {} as never);
    expect(resetM).toHaveBeenCalledWith(expect.anything(), 'A1', { resetWindows: undefined });
  });

  it('resetWindows:true is threaded through to recordAccountReset for every id in the batch', async () => {
    getAcct.mockImplementation((_pool: unknown, id: string) => ({ id }) as never);
    await resetTool.handler({ ids: ['A1', 'A2'], resetWindows: true } as never, {} as never);
    expect(resetM).toHaveBeenCalledWith(expect.anything(), 'A1', { resetWindows: true });
    expect(resetM).toHaveBeenCalledWith(expect.anything(), 'A2', { resetWindows: true });
  });
});

describe('accounts:scale_out', () => {
  it('default (no force) requires the sustained-limit check', async () => {
    exhaustM.mockResolvedValue({ scaledOut: true } as never);
    await scaleTool.handler({ id: 'A1' } as never, {} as never);
    expect(exhaustM.mock.calls[0]![3]).toMatchObject({ requireSustained: true });
  });

  it('force:true skips the sustained-limit check', async () => {
    exhaustM.mockResolvedValue({ scaledOut: true } as never);
    await scaleTool.handler({ id: 'A1', force: true } as never, {} as never);
    expect(exhaustM.mock.calls[0]![3]).toMatchObject({ requireSustained: false });
  });

  it('never throws — a scale-out failure becomes { ok:false, error }', async () => {
    exhaustM.mockRejectedValue(new Error('no capacity'));
    const b = body(await scaleTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/no capacity/);
  });
});

describe('accounts:status', () => {
  // The DONE criterion of the accounts:* control surface (B-GW-ACCT / gateway-live-control D-004):
  // `accounts:status` must reflect each account's EGRESS MAPPING (the per-account IP pin), so the
  // owner can see "account X → its own outbound IP" alongside rate headroom. This pins that the tool
  // surfaces `egress` verbatim from the read-model — a regression would hide which account egresses
  // through which proxy IP.
  it('surfaces each account row, INCLUDING its per-account egress mapping', async () => {
    statusM.mockResolvedValue([
      {
        id: 'A1',
        label: 'acct-1',
        credentialRef: 'token:/p',
        boundTo: [],
        available: true,
        sustainedlyLimited: false,
        rate: {} as never,
        egress: { proxyUrl: 'http://38.229.109.7:3128' },
        liveBuckets: [],
      },
      // An account with no egress pin (shared default egress) — `egress` must be absent, not faked.
      {
        id: 'A2',
        label: 'acct-2',
        credentialRef: 'token:/q',
        boundTo: [],
        available: false,
        sustainedlyLimited: true,
        rate: {} as never,
        liveBuckets: [],
      },
    ] as never);
    const b = body(await statusTool.handler({} as never, {} as never) as Out);
    expect(b.ok).toBe(true);
    expect(b.accounts).toHaveLength(2);
    expect(b.accounts[0]).toMatchObject({ id: 'A1', egress: { proxyUrl: 'http://38.229.109.7:3128' } });
    expect(b.accounts[1].id).toBe('A2');
    expect(b.accounts[1].egress).toBeUndefined();
  });

  describe('oversized-tool-results-reduction P-005: summary by default, full on request', () => {
    const history7d = [{ at: 1, u: 0.5 }, { at: 2, u: 0.6 }];
    const rows = () =>
      [
        { id: 'A1', provider: 'claude', credentialRef: 'token:/p', available: true, rate: { history7d, utilization7d: 0.6, pausedUntil: 0 }, burn: { action: 'shed' } },
        { id: 'A2', provider: 'claude', credentialRef: 'token:/q', available: false, rate: { history7d, utilization7d: 1 }, burn: { action: 'hold' } },
      ] as never;

    it('default (no account) omits rate.history7d and credentialRef but keeps every other field', async () => {
      statusM.mockResolvedValue(rows());
      const b = body(await statusTool.handler({} as never, {} as never) as Out);
      expect(b.detail).toBe('summary');
      expect(b.omitted.fields).toEqual(['rate.history7d', 'credentialRef']);
      expect(b.accounts).toHaveLength(2);
      for (const row of b.accounts) {
        expect(row.rate.history7d).toBeUndefined();
        expect(row.credentialRef).toBeUndefined();
      }
      expect(b.accounts[0]).toMatchObject({ id: 'A1', available: true, rate: { utilization7d: 0.6, pausedUntil: 0 }, burn: { action: 'shed' } });
    });

    it('account:<id> returns ONLY that row at full detail, while poolVerdict still covers the whole pool', async () => {
      const all = rows();
      statusM.mockResolvedValue(all);
      const b = body(await statusTool.handler({ account: 'A2' } as never, {} as never) as Out);
      expect(b.detail).toBeUndefined();
      expect(b.accounts).toHaveLength(1);
      expect(b.accounts[0]).toMatchObject({ id: 'A2', credentialRef: 'token:/q', rate: { history7d } });
      // The rollup is computed from EVERY row, not the one the caller narrowed to.
      expect(verdictM).toHaveBeenCalledWith(all, expect.any(Number));
    });

    it("detail:'full' keeps history7d and credentialRef on every row", async () => {
      statusM.mockResolvedValue(rows());
      const b = body(await statusTool.handler({ detail: 'full' } as never, {} as never) as Out);
      expect(b.accounts.map((r: { credentialRef: string }) => r.credentialRef)).toEqual(['token:/p', 'token:/q']);
      expect(b.accounts[0].rate.history7d).toEqual(history7d);
    });

    it('toAccountStatusSummaryRow leaves a row without rate history untouched apart from credentialRef', () => {
      expect(mod.toAccountStatusSummaryRow({ id: 'X', credentialRef: 'c', rate: { utilization7d: 0 } })).toEqual({ id: 'X', rate: { utilization7d: 0 } });
      expect(mod.toAccountStatusSummaryRow({ id: 'Y' })).toEqual({ id: 'Y' });
    });
  });

  it('passes the workspace arg through to the status read-model', async () => {
    statusM.mockResolvedValue([] as never);
    await statusTool.handler({ workspace: 'ws-7' } as never, {} as never);
    // P-002: one `now` is threaded through BOTH reads so the rows and their rollup cannot be
    // evaluated at two different instants. WI-10004486: the handler's one /stats snapshot (the
    // mocked gateway is down ⇒ null) is injected rather than re-fetched inside accountStatus.
    expect(statusM).toHaveBeenCalledWith('ws-7', expect.any(Number), { gatewayStats: null });
  });

  it('P-002: returns a per-provider poolVerdict rolled up from THOSE rows, at the same instant', async () => {
    const rows = [{ id: 'A1', provider: 'claude' }] as never;
    statusM.mockResolvedValue(rows);
    // A COMPLETE ProviderPoolVerdict, not an `as never` stub: the cast would silently strand
    // this fixture the next time the type gains a field, and only red the fleet gate.
    const verdict: ProviderPoolVerdict = {
      provider: 'claude',
      total: 1,
      serviceable: 1,
      walledFresh: 0,
      paused: 0,
      pacing: 0,
      unknown: 0,
      atCapacity: false,
      binding: 'none',
      reason: "1 of 1 'claude' account(s) can serve right now",
    };
    verdictM.mockReturnValue([verdict]);
    const b = body((await statusTool.handler({} as never, {} as never)) as Out);
    expect(b.poolVerdict).toEqual([verdict]);
    // Derived from the SAME rows the caller sees — not a second, independently-read population.
    expect(verdictM).toHaveBeenCalledWith(rows, expect.any(Number));
    expect(verdictM.mock.calls[0]![1]).toBe(statusM.mock.calls[0]![1]);
  });

  // WI-10004486: live billing state + metered totals exist only in the gateway's memory, so
  // accounts:status joins the gateway's /stats billing.byAccount entry onto each claude row.
  describe('WI-10004486: gateway billing join', () => {
    const tally = {
      requests: 3,
      inputTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 40,
      usageKnown: 3,
      outputKnown: 3,
    };
    const overageBilling: GatewayAccountBilling = {
      state: 'usage-credits',
      stateUntil: 1_790_900_000_000,
      meteredNow: true,
      authMode: 'oauth',
      meteredPolicy: 'overflow',
      classes: { 'usage-credits': tally },
      metered: tally,
    };
    // A COMPLETE AccountStatusRow (no `as never`): a cast would hide this fixture going stale
    // the next time the row type gains a required field.
    function statusRow(overrides: Partial<AccountStatusRow> & { id: string }): AccountStatusRow {
      return {
        provider: 'claude',
        credentialRef: `token:/tmp/${overrides.id}`,
        boundTo: [],
        available: true,
        usageWalled: false,
        sustainedlyLimited: false,
        edgeThrottleKnown: false,
        edgeThrottled: false,
        edgeThrottleCooledIps: 0,
        edgeThrottleBare429Streak: 0,
        rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
        liveBuckets: [],
        readingStatus: 'never-observed',
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
        ...overrides,
      };
    }
    const rows = [statusRow({ id: 'C1' }), statusRow({ id: 'C2' }), statusRow({ id: 'X1', provider: 'codex' })];

    it("joins each claude row with its gateway billing entry and marks unseen accounts 'not-observed'", async () => {
      mockResolvedTyped(statusM, rows);
      const stats: RawGatewayStats & { billing: unknown } = {
        billing: { byAccount: { C1: overageBilling }, metered: tally },
      };
      mockResolvedOnceTyped(statsM, stats);
      const b = body((await statusTool.handler({} as never, {} as never)) as Out);
      // The default view is the summary row (P-005: no credentialRef / rate.history7d), with
      // the billing join applied on top of it.
      const summary = mod.toAccountStatusSummaryRow;
      expect(b.accounts[0]).toEqual({ ...summary(rows[0]), billing: overageBilling });
      expect(b.accounts[1]).toEqual({ ...summary(rows[1]), billing: 'not-observed' });
      // The Anthropic billing model does not apply to codex: no key, not a fabricated value.
      expect(b.accounts[2]).toEqual(summary(rows[2]));
      expect(b.accounts[2]).not.toHaveProperty('billing');
      expect(b.billing).toEqual({ source: 'gateway:/stats', reachable: true, supported: true, metered: tally });
      // ONE /stats read, shared with accountStatus so edge-throttle and billing describe one instant.
      expect(statsM).toHaveBeenCalledTimes(1);
      expect(statsM).toHaveBeenCalledWith({ timeoutMs: 500 });
      expect(statusM).toHaveBeenCalledWith('default', expect.any(Number), { gatewayStats: stats });
      // The rollup still reads the store rows, unchanged by the join.
      expect(verdictM).toHaveBeenCalledWith(rows, expect.any(Number));
    });

    it("an unreachable gateway reads billing:'unavailable' on every claude row, never an omission", async () => {
      mockResolvedTyped(statusM, rows);
      mockResolvedOnceTyped(statsM, null);
      const b = body((await statusTool.handler({} as never, {} as never)) as Out);
      expect(b.ok).toBe(true);
      expect(b.accounts.map((r: { billing?: unknown }) => r.billing)).toEqual(['unavailable', 'unavailable', undefined]);
      expect(b.billing).toEqual({ source: 'gateway:/stats', reachable: false, supported: false });
      // null is injected (not undefined), so accountStatus does not re-fetch the dead gateway.
      expect(statusM).toHaveBeenCalledWith('default', expect.any(Number), { gatewayStats: null });
    });

    it("a gateway without a billing block (pre-P-009 build) reads 'not-observed', flagged supported:false", () => {
      const { accounts, billing } = mod.joinGatewayBilling(rows, { totalRequests: 4 });
      expect(accounts.map((r) => r.billing)).toEqual(['not-observed', 'not-observed', undefined]);
      expect(billing).toEqual({ source: 'gateway:/stats', reachable: true, supported: false });
    });

    it('does not resolve an inherited property name as a billing entry', () => {
      const { accounts } = mod.joinGatewayBilling([{ id: 'toString', provider: 'claude' }], {
        billing: { byAccount: {} },
      });
      expect(accounts[0]!.billing).toBe('not-observed');
    });
  });
});

describe('accounts:list', () => {
  it('accepts an optional provider filter and rejects unknown providers', () => {
    expect(listArgsSchema.safeParse({ provider: 'codex' }).success).toBe(true);
    expect(listArgsSchema.safeParse({ provider: 'vertex' }).success).toBe(false);
  });

  it('returns the pool accounts including their egress pins', async () => {
    loadM.mockResolvedValue({
      accounts: [
        { id: 'A1', credentialRef: 'token:/p', label: 'acct-1', boundTo: [], rate: {}, egress: { localAddress: '203.0.113.7' } },
      ],
    } as never);
    const b = body(await listTool.handler({} as never, {} as never) as Out);
    expect(b.ok).toBe(true);
    expect(b.accounts[0]).toMatchObject({ id: 'A1', egress: { localAddress: '203.0.113.7' } });
  });

  it('filters legacy Claude and explicit Codex rows when provider is supplied', async () => {
    // Complete ClaudeAccount rows (typed against the real pool shape rather than cast
    // through `never`); the assertion below is a subset match on the fields under test.
    const rateIdle = { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 };
    mockResolvedTyped(loadM, {
      accounts: [
        { id: 'legacy', credentialRef: 'token:/legacy', addedAt: 0, boundTo: [], rate: rateIdle },
        { id: 'claude-1', provider: 'claude', credentialRef: 'token:/claude', addedAt: 0, boundTo: [], rate: rateIdle },
        { id: 'codex-1', provider: 'codex', credentialRef: 'env:CODEX_TOKEN', addedAt: 0, boundTo: [], rate: rateIdle },
      ],
    });

    const b = body(await listTool.handler({ provider: 'codex' } as never, {} as never) as Out);

    expect(b.accounts).toMatchObject([
      { id: 'codex-1', provider: 'codex', credentialRef: 'env:CODEX_TOKEN' },
    ]);
  });
});
