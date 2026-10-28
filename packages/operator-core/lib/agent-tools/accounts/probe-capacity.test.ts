/**
 * accounts:probe-capacity — the persistence wiring around a FAILED probe (EI-18809949582687481).
 * A probe that never got a response (`ok:false`, "no-reading") must NOT be silently dropped: it
 * must stamp `lastProbeFailedAt` on the account so `accounts:status` can tell "we just asked and
 * got nothing" apart from "no one has asked in days". A SUCCESSFUL probe must still record the
 * window as before (and clear any stale failure marker — covered in account-pool.test.ts).
 *
 * The pure pool ops (`recordAccountWindow` / `recordProbeFailure`) are the REAL implementations
 * here (their own correctness is pinned in account-pool.test.ts); only IO (load/save the pool,
 * the actual upstream probe) is mocked, so this test pins the WIRING between them.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/probe-capacity.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPool, registerAccount, getAccount, recordAccountWindow, type AccountPool } from '../../deployment/account-pool';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

let pool: AccountPool = emptyPool();

vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: vi.fn(async () => pool),
  updateAccountPool: vi.fn(async (mutator: (p: AccountPool) => AccountPool) => {
    pool = mutator(pool);
    return pool;
  }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const probeM = vi.fn();
vi.mock('../../inference-gateway/capacity-probe', () => ({ probeCapacityForAccounts: probeM }));

const gatewayFetchM = vi.fn();

const mod = await import('./probe-capacity');
const tool = mod.default;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => o.data ?? JSON.parse(o.content![0].text);

const T0 = 1_000_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', gatewayFetchM);
  gatewayFetchM.mockResolvedValue(
    new Response(JSON.stringify({ readmitted: ['a'], healthyAccounts: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  pool = emptyPool();
  pool = registerAccount(pool, { id: 'a', credentialRef: 'token:~/.papercusp/a' }, T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accounts:probe-capacity — failure persistence', () => {
  it.each(['refused', 'relink-required'])('reports %s authentication without mutating accounts or launching recovery', async (authentication) => {
    const before = JSON.stringify(pool);
    probeM.mockResolvedValue([{ accountId: 'a', ok: false, status: 401, authentication, windows: {}, before: {}, unwalls: false }]);
    const out = body((await tool.handler({} as never, {} as never)) as Out);
    expect(out.rows[0]).toMatchObject({ authentication, verdict: authentication === 'relink-required'
      ? 'authentication refused (relink required)' : 'authentication refused' });
    expect(out.serving).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(JSON.stringify(pool)).toBe(before);
    expect(gatewayFetchM).not.toHaveBeenCalled();
  });

  it('reports HTTP refusal metadata read-only without claiming capacity or changing the pool', async () => {
    const httpRefusal = { status: 400, bodyState: 'parsed', errorType: 'invalid_request_error', message: 'model is unavailable', requestId: 'req_test' };
    probeM.mockResolvedValue([{ accountId: 'a', ok: false, status: 400, windows: {}, before: {}, unwalls: false, error: 'no capacity headers', httpRefusal }]);
    const before = JSON.stringify(pool);
    const out = body((await tool.handler({ id: 'a', provider: 'claude', apply: false } as never, {} as never)) as Out);
    expect(out.rows[0]).toMatchObject({ status: 400, verdict: 'no-reading', httpRefusal });
    expect(out.serving).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(JSON.stringify(pool)).toBe(before);
    expect(gatewayFetchM).not.toHaveBeenCalled();
  });

  it('advertises provider in the MCP schema and accepts Codex probes', () => {
    expect(tool.args.safeParse({ provider: 'codex' }).success).toBe(true);
  });

  it('a no-reading result stamps lastProbeFailedAt on the account', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    const out = body((await tool.handler({ apply: true } as never, {} as never)) as Out);
    expect(out.ok).toBe(true);
    expect(out.failed).toEqual(['a']);
    expect(out.applied).toEqual([]);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toEqual(expect.any(Number));
  });

  it('does not stamp lastProbeFailedAt when apply:false (dry run)', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    await tool.handler({ apply: false } as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('defaults to read-only so a successful probe does not mutate projection or gateway state', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: { utilization: 0.25 }, before: {}, unwalls: false },
    ]);

    const out = body((await tool.handler({} as never, {} as never)) as Out);

    expect(out.dryRun).toBe(true);
    expect(out.serving).toEqual(['a']);
    expect(out.applied).toEqual([]);
    expect(out.gatewayReadmitted).toEqual([]);
    expect(getAccount(pool, 'a')!.rate.utilization).toBeUndefined();
    expect(gatewayFetchM).not.toHaveBeenCalled();
  });

  it('a successful probe records the window and does NOT touch lastProbeFailedAt on other accounts', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: { utilization: 0.5 }, before: {}, unwalls: false },
    ]);
    const out = body((await tool.handler({ apply: true } as never, {} as never)) as Out);
    expect(out.applied).toEqual(['a']);
    expect(getAccount(pool, 'a')!.rate.utilization).toBe(0.5);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('a prior failure marker is cleared once a later probe succeeds', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    await tool.handler({ apply: true } as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeDefined();

    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: { utilization: 0.3 }, before: {}, unwalls: false },
    ]);
    await tool.handler({ apply: true } as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('readmits only serving Claude accounts with an account selector', async () => {
    pool = registerAccount(pool, { id: 'walled', credentialRef: 'token:~/.papercusp/walled' }, T0 + 1);
    pool = registerAccount(
      pool,
      { id: 'codex-account', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' },
      T0 + 2,
    );
    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
      { accountId: 'walled', ok: true, status: 429, windows: {}, before: {}, unwalls: false },
      { accountId: 'codex-account', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
    ]);

    const out = body((await tool.handler({ apply: true } as never, {} as never)) as Out);

    expect(out.serving).toEqual(['a']);
    expect(gatewayFetchM).toHaveBeenCalledTimes(1);
    expect(gatewayFetchM.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8788/admin/readmit?account=a');
    expect(out.gatewayReadmitted).toEqual(['a']);
  });

  it('preserves a valid 200/header reading but does not serve or readmit while another premium window remains full', async () => {
    const shortReset = Date.now() + 60_000;
    const weeklyReset = Date.now() + 7 * 86_400_000;
    pool = recordAccountWindow(
      pool,
      'a',
      { utilization: 0.99, utilization7d: 0.99, windowResetAt: shortReset, windowResetAt7d: weeklyReset },
      T0 + 1,
    );
    probeM.mockResolvedValue([
      {
        accountId: 'a',
        ok: true,
        status: 200,
        // The 5h window dropped, but the upstream result still confirms the weekly premium wall.
        windows: { utilization: 0.04, utilization7d: 0.99, windowResetAt7d: weeklyReset },
        before: { utilization: 0.99, utilization7d: 0.99 },
        unwalls: false,
      },
    ]);

    const out = body((await tool.handler({ apply: true } as never, {} as never)) as Out);

    expect(out.rows[0]).toMatchObject({
      accountId: 'a',
      ok: true,
      status: 200,
      before: { utilization: 0.99, utilization7d: 0.99 },
      upstream: { utilization: 0.04, utilization7d: 0.99 },
    });
    expect(out.applied).toEqual(['a']);
    expect(out.serving).toEqual([]);
    expect(out.gatewayReadmitted).toEqual([]);
    expect(gatewayFetchM).not.toHaveBeenCalled();
  });

  it('provider:codex scopes the probe and readmits through the Codex gateway path', async () => {
    pool = registerAccount(
      pool,
      { id: 'codex-account', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' },
      T0 + 1,
    );
    probeM.mockResolvedValue([
      { accountId: 'codex-account', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
    ]);
    gatewayFetchM.mockResolvedValue(
      new Response(JSON.stringify({ readmitted: ['codex-account'], healthyAccounts: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const out = body((await tool.handler({ provider: 'codex', apply: true } as never, {} as never)) as Out);

    expect(out.provider).toBe('codex');
    expect(out.probed).toBe(1);
    expect(out.serving).toEqual(['codex-account']);
    expect(probeM).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'codex-account', provider: 'codex' })],
      expect.objectContaining({ walledOnly: false }),
    );
    expect(gatewayFetchM).toHaveBeenCalledTimes(1);
    expect(gatewayFetchM.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:8788/admin/readmit?account=codex-account&provider=codex',
    );
  });

  it('bounds gateway readmit convergence with one shared deadline', async () => {
    vi.useFakeTimers();
    try {
      pool = registerAccount(pool, { id: 'b', credentialRef: 'token:~/.papercusp/b' }, T0 + 1);
      pool = registerAccount(pool, { id: 'c', credentialRef: 'token:~/.papercusp/c' }, T0 + 2);
      probeM.mockResolvedValue([
        { accountId: 'a', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
        { accountId: 'b', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
        { accountId: 'c', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
      ]);
      gatewayFetchM.mockImplementation(() => new Promise<Response>(() => undefined));

      const pending = tool.handler({ apply: true } as never, {} as never) as Promise<Out>;
      await vi.advanceTimersByTimeAsync(mod.GATEWAY_READMIT_PHASE_TIMEOUT_MS);
      const out = body(await pending);

      expect(out.ok).toBe(true);
      expect(out.gatewayConverged).toBe(false);
      expect(out.warning).toMatch(/gateway's in-memory exclusions were NOT cleared for 3\/3/);
      expect(gatewayFetchM).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Luna reserve-meter reading (model:gpt-reserve) is reported but NEVER projected, never serving, never readmitted (EI-22103680502746318)', async () => {
    // The observed 2026-09-02 shape: 'aviynw5_codex' premium weekly at 1.00 (walled); a gpt-reserve
    // probe returns 200 with the reserve bucket at 4%. Before the fix that 0.04 overwrote the 1.00,
    // the gateway readmitted the account, live codex traffic burned terminal 429s on it, and the
    // next premium reading re-walled it — a burn-governor fact flip + fleet broadcast every cycle.
    pool = registerAccount(
      pool,
      { id: 'codex-account', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' },
      T0 + 1,
    );
    pool = recordAccountWindow(pool, 'codex-account', { utilization7d: 1, windowResetAt7d: T0 + 5 * 86_400_000 }, T0 + 2);
    probeM.mockResolvedValue([
      {
        accountId: 'codex-account',
        ok: true,
        status: 200,
        windows: { utilization7d: 0.04, windowResetAt7d: T0 + 6 * 86_400_000, bucket: 'base_model_inference' },
        before: { utilization7d: 1 },
        unwalls: false,
      },
    ]);

    const out = body((await tool.handler({ provider: 'codex', model: 'gpt-reserve', apply: true } as never, {} as never)) as Out);

    expect(out.reserveNotProjected).toEqual(['codex-account']);
    expect(out.applied).toEqual([]);
    expect(out.serving).toEqual([]);
    expect(out.unwalled).toEqual([]);
    expect(out.rows[0].upstream.bucket).toBe('base_model_inference');
    expect(out.rows[0].verdict).toContain('NOT projected');
    // The premium projection is untouched — still walled at 1.00.
    expect(getAccount(pool, 'codex-account')!.rate.utilization7d).toBe(1);
    expect(getAccount(pool, 'codex-account')!.rate.windowResetAt7d).toBe(T0 + 5 * 86_400_000);
    // And the live gateway was NOT told to readmit it.
    expect(
      gatewayFetchM.mock.calls.some((c) => String(c[0]).includes('readmit?account=codex-account')),
    ).toBe(false);
  });
});
