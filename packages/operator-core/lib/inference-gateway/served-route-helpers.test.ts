/**
 * WI-2140943 lane 2 — the gateway's served-route helpers: binding a per-owner
 * reading to the CLI's native session id, and the STICKY 1M WINDOW rule that
 * restores the 1M beta when a caller drops its `[1m]` marker while holding more
 * context than a 200k window can take (the da701a71 death, 2026-09-02).
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_AFFINITY_TTL_MS,
  CONTEXT_1M_STICKY_MIN_EST_TOKENS,
  accumulateGatewayRouteUsage,
  hasContext1mBeta,
  isDefaultContext1mModel,
  nativeSessionIdFromMetaUserId,
  shouldDefaultContext1m,
  shouldRestoreContext1m,
  supportsContext1m,
} from './gateway';
import { CLAUDE_CONTEXT_1M_BETA, withOAuthBeta } from './credential-store';

const NATIVE = 'da701a71-7e45-4018-bb76-cca675de0cfd';

describe('accumulateGatewayRouteUsage — observed prompt floor', () => {
  const sample = (inputTotal: number) => ({
    inputTotal,
    inputTokens: 10,
    cacheRead: inputTotal - 20,
    cacheCreate: 10,
  });

  it('records the first exact total as the observed floor', () => {
    expect(accumulateGatewayRouteUsage(null, sample(168_100), 10)).toEqual({
      ...sample(168_100),
      observedInputFloor: 168_100,
      observations: 1,
      at: 10,
    });
  });

  it('keeps the minimum across samples while the latest exact usage advances', () => {
    const first = accumulateGatewayRouteUsage(null, sample(168_100), 10);
    const grown = accumulateGatewayRouteUsage(first, sample(199_236), 20);
    const smaller = accumulateGatewayRouteUsage(grown, sample(167_686), 30);
    expect(grown).toMatchObject({ inputTotal: 199_236, observedInputFloor: 168_100, observations: 2, at: 20 });
    expect(smaller).toMatchObject({ inputTotal: 167_686, observedInputFloor: 167_686, observations: 3, at: 30 });
  });
});

describe('hasContext1mBeta — the served window is the HEADER, not the body marker', () => {
  it('sees the CLI’s client-side [1m] resolution (bare model id + beta header)', () => {
    expect(hasContext1mBeta(`oauth-2025-04-20, ${CLAUDE_CONTEXT_1M_BETA}`)).toBe(true);
    expect(hasContext1mBeta(withOAuthBeta('interleaved-thinking-2025-05-14', true))).toBe(true);
    expect(hasContext1mBeta(withOAuthBeta(CLAUDE_CONTEXT_1M_BETA, false))).toBe(true);
  });
  it('a header without the beta — the exact shape of a CLI that fell back to 200k — is false', () => {
    expect(hasContext1mBeta('oauth-2025-04-20,interleaved-thinking-2025-05-14')).toBe(false);
    expect(hasContext1mBeta(withOAuthBeta(undefined, false))).toBe(false);
    expect(hasContext1mBeta(undefined)).toBe(false);
    expect(hasContext1mBeta('')).toBe(false);
  });
});

describe('nativeSessionIdFromMetaUserId', () => {
  it('reads the CC 2.1.x JSON-string form', () => {
    const meta = JSON.stringify({ device_id: 'e9c7d7d8', account_uuid: '', session_id: NATIVE });
    expect(nativeSessionIdFromMetaUserId(meta)).toBe(NATIVE);
  });
  it('reads the legacy `…_session_<uuid>` suffix form', () => {
    expect(nativeSessionIdFromMetaUserId(`user_abc_account_def_session_${NATIVE}`)).toBe(NATIVE);
  });
  it('never invents an id: garbage, non-uuid, non-string ⇒ null', () => {
    expect(nativeSessionIdFromMetaUserId('{"session_id":"not-a-uuid"}')).toBeNull();
    expect(nativeSessionIdFromMetaUserId('{not json')).toBeNull();
    expect(nativeSessionIdFromMetaUserId('plain-user')).toBeNull();
    expect(nativeSessionIdFromMetaUserId(undefined)).toBeNull();
    expect(nativeSessionIdFromMetaUserId(42)).toBeNull();
  });
});

describe('supportsContext1m', () => {
  it('accepts the [1m]-alias targets and the caller’s own prior 1M model', () => {
    expect(supportsContext1m('claude-opus-5')).toBe(true);
    expect(supportsContext1m('claude-sonnet-5')).toBe(true);
    expect(supportsContext1m('claude-fable-5')).toBe(true);
    expect(supportsContext1m('claude-fable-5-1', 'claude-fable-5-1')).toBe(true);
  });
  it('refuses models that were never served at 1M: haiku and the sonnet-4.x downgrade target', () => {
    expect(supportsContext1m('claude-haiku-4-5')).toBe(false);
    expect(supportsContext1m('claude-sonnet-4-6', 'claude-fable-5-1')).toBe(false);
  });
  it('WI-10006049: accepts the dated point releases the 2.1.289 CLI actually sends, with no prior', () => {
    expect(supportsContext1m('claude-opus-5-5')).toBe(true);
    expect(supportsContext1m('claude-sonnet-5-5')).toBe(true);
    expect(supportsContext1m('claude-fable-5-1')).toBe(true);
  });
});

/**
 * WI-10006049 — the 1M DEFAULT for every 1M-capable Claude family (owner Avi 2026-10-05 #1369
 * "if the default is 1m that sounds good", #1371 "make sure this works for all claude models too
 * not just opus"). The model ids below are the ones the installed Claude Code 2.1.289 binary
 * carries; `claude-opus-5-5` without the beta is exactly what a bare `/model` menu pick sent
 * (su-56e2f83b, gateway route context1m:false, 2026-10-05).
 */
describe('isDefaultContext1mModel — which families default to 1M', () => {
  it.each([
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-opus-5-5-20261001',
    'claude-opus-6',
  ])('%s ⇒ 1M by default', (model) => {
    expect(isDefaultContext1mModel(model)).toBe(true);
  });
  it.each([
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-8',
    'claude-opus-4-1-20250805',
    'gpt-5.5',
    '',
    null,
  ])('%s ⇒ keeps its real window (no forced beta)', (model) => {
    expect(isDefaultContext1mModel(model)).toBe(false);
  });
});

describe('shouldDefaultContext1m — the menu-proof 1M default', () => {
  const base = {
    owner: 'su-56e2f83b-010d-4f42-b750-19bc8fde6ea5',
    url: '/v1/messages?beta=true',
    model: 'claude-opus-5-5',
    context1m: false,
    clientHas1m: false,
  };
  it('a bare /model pick (opus, sonnet or fable sent WITHOUT the beta) is served at 1M', () => {
    expect(shouldDefaultContext1m(base)).toBe(true);
    expect(shouldDefaultContext1m({ ...base, model: 'claude-sonnet-5-5' })).toBe(true);
    expect(shouldDefaultContext1m({ ...base, model: 'claude-fable-5-1' })).toBe(true);
  });
  it('haiku and the 4.x generations are never forced (a rejected beta is a 400)', () => {
    expect(shouldDefaultContext1m({ ...base, model: 'claude-haiku-4-5' })).toBe(false);
    expect(shouldDefaultContext1m({ ...base, model: 'claude-sonnet-4-6' })).toBe(false);
  });
  it('a caller already at 1M (body marker or client beta) needs nothing', () => {
    expect(shouldDefaultContext1m({ ...base, context1m: true })).toBe(false);
    expect(shouldDefaultContext1m({ ...base, clientHas1m: true })).toBe(false);
  });
  it('callers papercusp does not manage (no owner header) and non-messages endpoints are untouched', () => {
    expect(shouldDefaultContext1m({ ...base, owner: undefined })).toBe(false);
    expect(shouldDefaultContext1m({ ...base, owner: '' })).toBe(false);
    expect(shouldDefaultContext1m({ ...base, url: '/v1/models' })).toBe(false);
  });
});

describe('shouldRestoreContext1m — sticky 1M window', () => {
  const now = 1_700_000_000_000;
  const priorFable1m = { model: 'claude-fable-5-1', context1m: true, at: now - 10 * 60_000 };

  it('da701a71 replay: fable[1m] served 10 min ago, now bare claude-opus-5 at est 180k ⇒ restore', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 180_000, now)).toBe(true);
  });
  it('a small body is left alone — the caller may have dropped [1m] on purpose', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', CONTEXT_1M_STICKY_MIN_EST_TOKENS - 1, now)).toBe(
      false,
    );
  });
  it('no prior route, or a prior route that was itself 200k ⇒ nothing to restore', () => {
    expect(shouldRestoreContext1m(undefined, 'claude-opus-5', 180_000, now)).toBe(false);
    expect(shouldRestoreContext1m({ ...priorFable1m, context1m: false }, 'claude-opus-5', 180_000, now)).toBe(false);
  });
  it('a prior route older than the affinity TTL is forgotten', () => {
    const stale = { ...priorFable1m, at: now - AUTO_AFFINITY_TTL_MS - 1 };
    expect(shouldRestoreContext1m(stale, 'claude-opus-5', 180_000, now)).toBe(false);
  });
  it('never restores onto a model that would reject the beta (the sonnet-4.x downgrade target)', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-sonnet-4-6', 180_000, now)).toBe(false);
  });
  it('honours explicit ttl/min overrides', () => {
    expect(
      shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 50_000, now, { minEstTokens: 40_000 }),
    ).toBe(true);
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 180_000, now, { ttlMs: 60_000 })).toBe(false);
  });
});
