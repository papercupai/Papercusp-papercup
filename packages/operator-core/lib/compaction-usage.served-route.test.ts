/**
 * WI-2140943 lane 2 — the compaction watchdog's effective window and context
 * estimate follow the model the gateway actually SERVED, not the launch spec.
 *
 * Replays the 2026-09-02 da701a71 death: a session at 248,703 real tokens whose
 * CLI silently re-requested a bare `claude-opus-5` (no `[1m]`) after one 429.
 * Under the launch spec (`claude-fable-5-1[1m]` ⇒ 1M window ⇒ 400k limit) the
 * watchdog read it as under-limit while every request died on the 200k window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  estimateContextTokensForOwner,
  estimateContextWindowForOwner,
  gatewayServedRouteForOwner,
  observedPromptFloorForOwner,
  resetContextAnchorsForTests,
  servedWindowForRoute,
  type GatewayServedRoute,
  type SessionRef,
} from './compaction-usage';
import {
  MODEL_WINDOW_1M,
  MODEL_WINDOW_DEFAULT,
  defaultCompactionLimitForWindow,
} from './agent-config-constants';

const OWNER = 'su-test-served-route-owner';
// Synthetic uuids on purpose: `estimateContextTokens` resolves a REAL transcript by session id
// (owner-root fast path, then the fallback sweep), so a real id here would read a live session's
// file — measured: the first draft used the author's own session id and got its 203k back.
const NATIVE = '00000000-0000-4000-8000-00000000da70';
const SUCCESSOR = '00000000-0000-4000-8000-000000006700';
const claudeRef = (sessionId: string): SessionRef => ({
  agent: 'claude',
  sessionId,
  sessionKey: null,
  transcriptOwner: null,
});
const route = (over: Partial<GatewayServedRoute> = {}): GatewayServedRoute => ({
  account: 'aviynw2',
  model: 'claude-opus-5',
  context1m: false,
  nativeSessionId: NATIVE,
  usage: { inputTotal: 248_703, observedInputFloor: 167_686, observations: 2, at: 1 },
  // The da701a71 shape: the 248,703 reading came from an EARLIER request (served at 1M); the route
  // itself was re-stamped later by the bare-model request that failed. WI-10006049 only lets usage
  // raise the window when it was measured on the request the flag describes (usage.at >= at).
  at: 2,
  ...over,
});

afterEach(() => resetContextAnchorsForTests());

describe('servedWindowForRoute', () => {
  it('is the 200k default when the beta was NOT forwarded and 1M when it was', () => {
    expect(servedWindowForRoute(route({ context1m: false }))).toBe(MODEL_WINDOW_DEFAULT);
    expect(servedWindowForRoute(route({ context1m: true }))).toBe(MODEL_WINDOW_1M);
  });
  it('never guesses: unknown route or a pre-upgrade gateway (context1m null) ⇒ null', () => {
    expect(servedWindowForRoute(null)).toBeNull();
    expect(servedWindowForRoute(route({ context1m: null }))).toBeNull();
    expect(servedWindowForRoute(route({ model: null }))).toBeNull();
  });
});

/**
 * WI-10006049 — observed usage outranks the context1m flag (owner Avi approved option B,
 * 2026-10-05 #1369/#1371). The reset storm: a session already holding >200k was re-seeded at a
 * 158k limit (below its ~130-165k fixed prompt) because ONE request went out without the 1M beta.
 */
describe('servedWindowForRoute — usage measured on the same request raises the window', () => {
  const sameRequest = (inputTotal: number, over: Partial<GatewayServedRoute> = {}) =>
    route({
      model: 'claude-opus-5-5',
      context1m: false,
      usage: { inputTotal, observedInputFloor: Math.min(inputTotal, 140_040), observations: 5, at: 10 },
      at: 10,
      ...over,
    });
  it('a request that actually carried >200k input was served by a >200k window ⇒ 1M', () => {
    expect(servedWindowForRoute(sameRequest(212_000))).toBe(MODEL_WINDOW_1M);
  });
  it('usage stamped AFTER the route (message_start follows the headers) still counts', () => {
    expect(servedWindowForRoute(sameRequest(212_000, { at: 9 }))).toBe(MODEL_WINDOW_1M);
  });
  it('a real 200k session under 200k stays 200k — usage can only raise the window', () => {
    // su-56e2f83b live reading, 2026-10-06 00:34Z: bare menu pick, 150,952 tokens, no beta.
    expect(servedWindowForRoute(sameRequest(150_952))).toBe(MODEL_WINDOW_DEFAULT);
    expect(servedWindowForRoute(sameRequest(MODEL_WINDOW_DEFAULT))).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('da701a71: a >200k reading carried from an EARLIER request does not hide a real fallback to 200k', () => {
    expect(servedWindowForRoute(route({ context1m: false }))).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('the flag still wins when it says 1M, whatever the usage', () => {
    expect(servedWindowForRoute(sameRequest(50_000, { context1m: true }))).toBe(MODEL_WINDOW_1M);
  });
  it('no usage, or a route without a stamp, falls back to the flag', () => {
    expect(servedWindowForRoute(sameRequest(212_000, { usage: null }))).toBe(MODEL_WINDOW_DEFAULT);
    expect(servedWindowForRoute(sameRequest(212_000, { at: null }))).toBe(MODEL_WINDOW_DEFAULT);
  });
});

describe('estimateContextWindowForOwner — claude follows the SERVED model', () => {
  it('da701a71 replay: fable[1m] launch, gateway served bare opus-5 ⇒ window is 200k, not 1M', async () => {
    const window = await estimateContextWindowForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({ model: 'claude-opus-5', context1m: false }),
    });
    expect(window).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('a route still served at 1M keeps the 1M window', async () => {
    const window = await estimateContextWindowForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({ model: 'claude-fable-5-1', context1m: true }),
    });
    expect(window).toBe(MODEL_WINDOW_1M);
  });
  it('a route bound to a DIFFERENT native session (dead predecessor) is not trusted ⇒ null', async () => {
    const window = await estimateContextWindowForOwner(OWNER, {
      resolveRef: async () => claudeRef(SUCCESSOR),
      servedRoute: async () => route({ nativeSessionId: NATIVE }),
    });
    expect(window).toBeNull();
  });
  it('a route with no native id (non-CLI caller / pre-upgrade gateway) ⇒ null', async () => {
    const window = await estimateContextWindowForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({ nativeSessionId: null }),
    });
    expect(window).toBeNull();
  });
  it('gateway unreachable ⇒ null (caller falls back to the launch-spec window)', async () => {
    const window = await estimateContextWindowForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => null,
    });
    expect(window).toBeNull();
  });
  it('omp stays null-by-design and an unresolvable ref is null', async () => {
    expect(
      await estimateContextWindowForOwner(OWNER, {
        resolveRef: async () => ({ agent: 'omp', sessionId: 'x', sessionKey: null, transcriptOwner: null }),
        servedRoute: async () => route(),
      }),
    ).toBeNull();
    expect(await estimateContextWindowForOwner(OWNER, { resolveRef: async () => null })).toBeNull();
  });
});

describe('estimateContextTokensForOwner — exact gateway usage beats bytes/4', () => {
  it('da701a71 replay: the exact 248,703 reading is returned and exceeds the 200k-window limit', async () => {
    const est = await estimateContextTokensForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({ usage: { inputTotal: 248_703, at: 1 } }),
    });
    expect(est).toBe(248_703);
    // The watchdog's over-limit rung: est ≥ the limit derived from the SERVED window ⇒ carry-respawn.
    const servedLimit = defaultCompactionLimitForWindow(MODEL_WINDOW_DEFAULT, { fleetMember: false });
    expect(est!).toBeGreaterThanOrEqual(servedLimit);
    expect(est!).toBeGreaterThan(MODEL_WINDOW_DEFAULT);
  });
  it('retains the route-bound observed prompt floor for the existing context gauge writer', async () => {
    await estimateContextTokensForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({
        usage: { inputTotal: 199_236, observedInputFloor: 167_686, observations: 3, at: 50 },
      }),
    });
    expect(observedPromptFloorForOwner(OWNER, 50)).toEqual({ tokens: 167_686, observations: 3, at: 50 });
  });
  it('a successor (new native id) never inherits the predecessor usage', async () => {
    const est = await estimateContextTokensForOwner(OWNER, {
      resolveRef: async () => claudeRef(SUCCESSOR),
      servedRoute: async () => route({ nativeSessionId: NATIVE, usage: { inputTotal: 248_703, at: 1 } }),
    });
    // No transcript exists for this synthetic owner, so nothing else can answer either.
    expect(est).toBeNull();
  });
  it('a route without usage yet (before the first message_start) changes nothing', async () => {
    const est = await estimateContextTokensForOwner(OWNER, {
      resolveRef: async () => claudeRef(NATIVE),
      servedRoute: async () => route({ usage: null }),
    });
    expect(est).toBeNull();
  });
});

describe('gatewayServedRouteForOwner — /admin/route client', () => {
  const jsonResponse = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response;
  it('parses a full served route', async () => {
    const r = await gatewayServedRouteForOwner(OWNER, {
      fetchImpl: async (url) => {
        expect(String(url)).toContain(`/admin/route?owner=${encodeURIComponent(OWNER)}`);
        return jsonResponse({
          ok: true,
          owner: OWNER,
          account: 'aviynw2',
          model: 'claude-opus-5',
          context1m: false,
          nativeSessionId: NATIVE,
          usage: {
            inputTotal: 248703,
            inputTokens: 3,
            cacheRead: 248000,
            cacheCreate: 700,
            observedInputFloor: 167686,
            observations: 4,
            at: 5,
          },
          at: 6,
        });
      },
    });
    expect(r).toEqual({
      account: 'aviynw2',
      model: 'claude-opus-5',
      context1m: false,
      nativeSessionId: NATIVE,
      usage: { inputTotal: 248703, observedInputFloor: 167686, observations: 4, at: 5 },
      at: 6,
    });
  });
  it('an unseen owner (model null), a non-ok reply, and a thrown fetch all read as unknown (null)', async () => {
    expect(
      await gatewayServedRouteForOwner(OWNER, {
        fetchImpl: async () => jsonResponse({ ok: true, owner: OWNER, account: null, model: null, at: null }),
      }),
    ).toBeNull();
    expect(await gatewayServedRouteForOwner(OWNER, { fetchImpl: async () => jsonResponse({}, false) })).toBeNull();
    expect(
      await gatewayServedRouteForOwner(OWNER, {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).toBeNull();
  });
});
