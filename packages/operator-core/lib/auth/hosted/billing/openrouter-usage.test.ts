import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { OpenRouterHostedUsageCollector, createOpenRouterHostedUsageCollector, openRouterUsageRecord, type OpenRouterUsageBinding } from './openrouter-usage';
import { createHostedUsageSource } from './usage-service';
import { buildHostedUsageStatement, type HostedUsageRecord } from './usage-statement';

const scope = { controlWorkspaceId: 'control', organizationId: 'org', customerWorkspaceId: 'customer' };
const time = Date.UTC(2026, 9, 2);
const binding: OpenRouterUsageBinding = { scope, generationId: 'gen-server-recorded', payer: 'consumption',
  isByok: false, credentialRef: 'secret-ref:org-openrouter', revision: 1,
  occurredAtMs: time, observedAtMs: time + 1000, evidenceRef: 'provider-receipt:report-1' };
const payload = (cost: unknown = 0.0015, extra: Record<string, unknown> = {}) => ({ data: {
  id: binding.generationId, is_byok: false, total_cost: cost,
  // Documented generation metadata plus hostile private extras: none is saved.
  native_tokens_prompt: 100, native_tokens_cached: 80, native_tokens_completion: 25,
  upstream_inference_cost: 9, prompts: ['private prompt'], api_key: 'provider-secret',
  model: 'model/private', external_user: 'private-user', ...extra,
} });
const statement = (records: HostedUsageRecord[]) => buildHostedUsageStatement({ scope, month: '2026-10',
  asOfMs: time + 2000, source: { complete: false, observedAtMs: time + 1000, maximumAgeMs: 2000,
    evidenceRef: 'collector:incomplete-census' }, records });
function setup(change: Record<string, unknown> = {}) {
  const readBinding = vi.fn(async () => binding);
  const readCredential = vi.fn(async () => 'server-secret');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(payload()), { status: 200 }));
  const append = vi.fn(async (_: HostedUsageRecord) => 'recorded' as const);
  return { readBinding, readCredential, fetch, append,
    collector: new OpenRouterHostedUsageCollector({ readBinding, readCredential, fetch, append, ...change }) };
}
describe('OpenRouter hosted usage collector', () => {
  it('preserves the original JSON decimal token before Number parsing loses low digits', async () => {
    const s = setup({ fetch: async () => new Response('{"data":{"id":"gen-server-recorded","is_byok":false,"total_cost":0.001234560000000000000001}}') });
    const result = await s.collector.collect({ scope, generationId: binding.generationId });
    expect(result).toMatchObject({ outcome: 'recorded', record: { costMicros: 1234, costMicrosExact: '1234.560000000000000001' } });
    expect(s.append.mock.calls[0]?.[0].costMicrosExact).toBe('1234.560000000000000001');
  });
  it('preserves a numeric exponent token and refuses unsupported excessive precision without rounding', async () => {
    for (const [token, exact] of [['1.234567890123456789E-7', '0.1234567890123456789'], ['1e-9999', null]] as const) {
      const s = setup({ fetch: async () => new Response('{"data":{"id":"gen-server-recorded","is_byok":false,"total_cost":' + token + '}}') });
      const result = await s.collector.collect({ scope, generationId: binding.generationId });
      expect(result).toMatchObject({ outcome: 'recorded', record: exact === null
        ? { costSource: 'unpriced', costMicros: null } : { costSource: 'provider-reported', costMicros: 0, costMicrosExact: exact } });
    }
  });
  it('reads only the bound generation metadata using the bound account and persists a whitelist', async () => {
    const s = setup(); const result = await s.collector.collect({ scope, generationId: binding.generationId });
    expect(result.outcome).toBe('recorded'); expect(s.readBinding).toHaveBeenCalledWith(scope, binding.generationId, expect.any(AbortSignal));
    expect(s.readCredential).toHaveBeenCalledWith(binding.credentialRef, expect.any(AbortSignal));
    const [url, options] = s.fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/generation?id=gen-server-recorded');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer server-secret' } });
    const saved = s.append.mock.calls[0]![0];
    expect(saved).toMatchObject({ ...scope, provider: 'openrouter', quantity: 1, unit: 'generations',
      costSource: 'provider-reported', costMicros: 1500, payer: 'consumption' });
    expect(JSON.stringify(saved)).not.toMatch(/private|secret|tokens|upstream|prompts/);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(statement([saved]).settlementEligible).toBe(false);
  });
  it('counts the account charge once for cached/uncached requests instead of adding token rates or upstream cost', () => {
    const first = openRouterUsageRecord(binding, payload(0.0001));
    const second = openRouterUsageRecord({ ...binding, generationId: 'gen-uncached', evidenceRef: 'receipt:uncached' },
      { data: { id: 'gen-uncached', is_byok: false, total_cost: 0.001, native_tokens_cached: 0 } });
    expect(statement([first, first, second]).lines[0]).toMatchObject({ usages: 2, quantity: 2, reportedMicros: 1100 });
    expect(statement([first, first, second]).consumptionBilled.micros).toBe(0);
  });
  it('keeps upstream BYOK cost separate from the bound OpenRouter account payer', () => {
    const r = openRouterUsageRecord({ ...binding, isByok: true }, payload(0.0005, { is_byok: true, upstream_inference_cost: 0.02 }));
    expect(r).toMatchObject({ payer: 'consumption', costMicros: 500 });
    const direct = openRouterUsageRecord({ ...binding, isByok: true, payer: 'customer-direct' },
      payload(0.0005, { is_byok: true }));
    expect(statement([direct]).lines[0]).toMatchObject({ payer: 'customer-direct', reportedMicros: 500 });
    expect(statement([direct]).consumptionBilled.micros).toBe(0);
  });
  it.each([0, 0.000001, 0.000123, 0.1, 1e-5, 1e3])('converts exact decimal USD %s to integer micros', usd => {
    expect(openRouterUsageRecord(binding, payload(usd)).costMicros).toBe(Math.round(usd * 1_000_000));
  });
  it.each([[0.0000001, 0, '0.1'], [0.00123456, 1234, '1234.56'],
    [5e-324, 0, '0.' + '0'.repeat(317) + '5']] as const)('preserves exact provider USD %s without request rounding', (cost, micros, exact) => {
    const r = openRouterUsageRecord(binding, payload(cost));
    expect(r).toMatchObject({ costSource: 'provider-reported', costMicros: micros, costMicrosExact: exact });
    expect(statement([r]).lines[0]).toMatchObject({ unpricedUsages: 0, reportedMicros: micros, reportedMicrosExact: exact });
    expect(statement([r]).settlementEligible).toBe(false);
  });
  it.each([null, undefined, '0.001', -1, NaN, Infinity, 1e20])(
    'preserves missing/invalid/overflow charge %s as unpriced', cost => {
      const body = cost === undefined ? { data: { id: binding.generationId, is_byok: false } } : payload(cost);
      const r = openRouterUsageRecord(binding, body);
      expect(r).toMatchObject({ costSource: 'unpriced', costMicros: null });
      expect(statement([r]).lines[0]?.unpricedUsages).toBe(1);
    });
  it('preserves cancelled generation reports without asserting a final bill or releasing a budget hold', () => {
    const r = openRouterUsageRecord(binding, payload(0, { cancelled: true, finish_reason: null }));
    expect(r).toMatchObject({ costSource: 'provider-reported', costMicros: 0 });
    expect(statement([r]).settlementEligible).toBe(false);
  });
  it('pins replay identity and replaces a later cost report through the existing revision history', () => {
    const first = openRouterUsageRecord(binding, payload(0.001));
    expect(openRouterUsageRecord(binding, payload(0.001, { prompts: ['changed private text'] }))).toEqual(first);
    const later = openRouterUsageRecord({ ...binding, revision: 2, observedAtMs: time + 1500, evidenceRef: 'receipt:correction' }, payload(0.002));
    expect(later.recordId).not.toBe(first.recordId);
    expect(statement([later, first, later]).lines[0]).toMatchObject({ usages: 1, reportedMicros: 2000 });
  });
  it('refuses missing configuration/binding and foreign tenant/account bindings before reading a key', async () => {
    expect(await new OpenRouterHostedUsageCollector().collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'unconfigured' });
    for (const response of [null, { ...binding, scope: { ...scope, organizationId: 'other' } },
      { ...binding, scope: { ...scope, customerWorkspaceId: 'other' } }, { ...binding, generationId: 'gen-other' }]) {
      const s = setup({ readBinding: async () => response });
      expect((await s.collector.collect({ scope, generationId: binding.generationId })).outcome).toBe('unavailable');
      expect(s.readCredential).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
    }
  });
  it('snapshots the server binding before asynchronous credential lookup', async () => {
    const mutable = { ...binding, scope: { ...scope } };
    const s = setup({ readBinding: async () => mutable, readCredential: async () => {
      mutable.scope.organizationId = 'other'; mutable.payer = 'customer-direct'; return 'server-secret';
    } });
    await s.collector.collect({ scope, generationId: binding.generationId });
    expect(s.append.mock.calls[0]![0]).toMatchObject({ organizationId: scope.organizationId, payer: 'consumption' });
  });
  it('refuses a rotated/unrelated key before provider I/O and strips the fingerprint from a matching report', async () => {
    const pinned = { ...binding, credentialSha256: createHash('sha256').update('server-secret').digest('hex') };
    const s = setup({ readBinding: async () => pinned });
    expect((await s.collector.collect({ scope, generationId: binding.generationId })).outcome).toBe('recorded');
    expect(JSON.stringify(s.append.mock.calls[0]![0])).not.toMatch(/credential|sha256|server-secret/);
    const rotated = setup({ readBinding: async () => pinned, readCredential: async () => 'other-account-key' });
    expect(await rotated.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'credential-mismatch' });
    expect(rotated.fetch).not.toHaveBeenCalled(); expect(rotated.append).not.toHaveBeenCalled();
    const malformed = setup({ readBinding: async () => ({ ...pinned, credentialSha256: 'bad-hash' }) });
    await expect(malformed.collector.collect({ scope, generationId: binding.generationId })).rejects.toThrow('invalid OpenRouter usage binding');
    expect(malformed.readCredential).not.toHaveBeenCalled();
  });
  it('keeps a failing credential resolver unavailable without leaking its error or calling the provider', async () => {
    const s = setup({ readCredential: async () => { throw new Error('private secret server-secret'); } });
    expect(await s.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'missing-credential' });
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });
  it('composes the durable binding reader through the existing source without inventing provider census or billing finality', async () => {
    const pinned = { ...binding, observedAtMs: time + 2000, credentialSha256: createHash('sha256').update('server-secret').digest('hex') };
    const readOpenRouterBindings = vi.fn(async () => [pinned]);
    const records: HostedUsageRecord[] = [];
    const store = { readOpenRouterBindings, append: vi.fn(async (r: HostedUsageRecord) => {
      records.push(r); return 'recorded' as const;
    }), readRecords: async () => records };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(payload(0.0000001))));
    const source = createHostedUsageSource({ store, maximumAgeMs: 1000,
      collectors: [createOpenRouterHostedUsageCollector({ store, readCredential: async () => 'server-secret', fetch })] });
    const input = { scope, month: '2026-10', asOfMs: time + 2000 };
    const result = await source(input);
    expect(readOpenRouterBindings).toHaveBeenCalledWith(input);
    expect(store.append).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.lines[0]).toMatchObject({ reportedMicros: 0, reportedMicrosExact: '0.1', billedMicros: 0 });
    expect(result.settlementEligible).toBe(false); expect(result.forecast.unavailableReason).toBe('incomplete-source');
    expect(JSON.stringify(result)).not.toMatch(/server-secret|credential|sha256|private/);
  });
  it('does not resolve keys for an empty/foreign population or turn an account failure into a zero receipt', async () => {
    const readCredential = vi.fn(async () => 'wrong-key');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const empty = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => [] }, readCredential, fetch });
    const input = { scope, month: '2026-10', asOfMs: time + 2000 };
    expect(await empty.read(input)).toMatchObject({ complete: false, records: [] });
    expect(readCredential).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    const mismatched = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => [{ ...binding, observedAtMs: input.asOfMs,
      credentialSha256: createHash('sha256').update('correct-key').digest('hex') }] }, readCredential, fetch });
    expect(await mismatched.read(input)).toMatchObject({ complete: false, records: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('validates the entire bound population before any credential lookup, including foreign tenant/time/metadata', async () => {
    const input = { scope, month: '2026-10', asOfMs: time + 2000 };
    const good = { ...binding, observedAtMs: input.asOfMs };
    for (const bad of [{ ...good, scope: { ...scope, organizationId: 'other' } },
      { ...good, scope: { ...scope, customerWorkspaceId: 'other' } }, { ...good, observedAtMs: input.asOfMs + 1 },
      { ...good, occurredAtMs: Date.UTC(2026, 10, 1) }, { ...good, credentialSha256: 'invalid' }]) {
      const readCredential = vi.fn(async () => 'server-secret'); const fetch = vi.fn<typeof globalThis.fetch>();
      const collector = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => [good, bad] }, readCredential, fetch });
      await expect(collector.read(input)).rejects.toThrow(/binding/);
      expect(readCredential).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('stops the provider-read batch after its shared deadline aborts, keeping the census explicitly incomplete', async () => {
    const input = { scope, month: '2026-10', asOfMs: time + 2000 };
    const b = { ...binding, observedAtMs: input.asOfMs };
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    const readCredential = vi.fn(async () => 'server-secret');
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const requestSignal = options?.signal;
      expect(requestSignal?.aborted).toBe(false); abort.abort();
      expect(requestSignal?.aborted).toBe(true); throw new Error('timed out');
    });
    try {
      const collector = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => [b, { ...b, generationId: 'gen-other' }] }, readCredential, fetch });
      expect(await collector.read(input)).toMatchObject({ complete: false, records: [] });
      expect(readCredential).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });
  it('rejects malformed server authority before credential lookup', async () => {
    const s = setup({ readBinding: async () => ({ ...binding, revision: 0 }) });
    await expect(s.collector.collect({ scope, generationId: binding.generationId })).rejects.toThrow(/usage receipt/);
    expect(s.readCredential).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each([null, '', ' key ', 'key\nInjected: header'])('refuses missing/malformed credentials %s', async secret => {
    const s = setup({ readCredential: async () => secret });
    expect(await s.collector.collect({ scope, generationId: binding.generationId })).toEqual({ outcome: 'unavailable', reason: 'missing-credential' });
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });
  it.each([401, 404, 429, 500])('keeps HTTP %s as an unavailable read without persisting provider error text', async status => {
    const s = setup({ fetch: async () => new Response('private error server-secret', { status }) });
    expect(await s.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'provider-http-error', status });
    expect(s.append).not.toHaveBeenCalled();
  });
  it('does not retry a failed/aborted read or surface its private error text', async () => {
    const fetch = vi.fn(async () => { throw new Error('private error server-secret'); }); const s = setup({ fetch });
    expect(await s.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'provider-read-failed' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(s.append).not.toHaveBeenCalled();
  });
  it.each([{ data: { id: 'gen-other', is_byok: false, total_cost: 1 } },
    payload(1, { is_byok: true }), { data: null }, { error: 'private', data: payload().data }])(
    'refuses wrong generation/BYOK/error envelopes', async report => {
      const s = setup({ fetch: async () => new Response(JSON.stringify(report)) });
      expect(await s.collector.collect({ scope, generationId: binding.generationId }))
        .toEqual({ outcome: 'unavailable', reason: 'invalid-provider-report' });
      expect(s.append).not.toHaveBeenCalled();
    });
  it('passes existing store conflict outcomes through and propagates a failed durable write', async () => {
    const s = setup({ append: async () => 'revision-conflict' });
    expect((await s.collector.collect({ scope, generationId: binding.generationId })).outcome).toBe('revision-conflict');
    const failed = setup({ append: async () => { throw new Error('database unavailable'); } });
    await expect(failed.collector.collect({ scope, generationId: binding.generationId })).rejects.toThrow('database unavailable');
  });
  it('rejects caller-supplied payer/cost/account fields and invalid generation selectors before I/O', async () => {
    const s = setup();
    for (const input of [
      { scope, generationId: '../generation/content' },
      { scope, generationId: binding.generationId, payer: 'platform' },
      { scope, generationId: binding.generationId, total_cost: 0 },
      { scope: { ...scope, account: 'other' }, generationId: binding.generationId },
    ]) await expect(s.collector.collect(input)).rejects.toThrow(/invalid OpenRouter usage/);
    expect(s.readBinding).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
});

describe('OpenRouter authenticated read cancellation', () => {
  const input = { scope, generationId: binding.generationId };
  const refusal = { outcome: 'unavailable', reason: 'provider-read-failed' };

  it('refuses a pre-cancelled request before binding, credential or provider I/O', async () => {
    const s = setup(); const parent = new AbortController();
    parent.abort(new Error('private cancellation reason'));
    expect(await s.collector.collect(input, parent.signal)).toEqual(refusal);
    expect(s.readBinding).not.toHaveBeenCalled(); expect(s.readCredential).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });

  it.each(['binding', 'credential'] as const)('bounds caller cancellation while the %s reader is held', async phase => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reader = vi.fn(async () => { entered(); await held; return phase === 'binding' ? binding : 'server-secret'; });
    const s = setup(phase === 'binding' ? { readBinding: reader } : { readCredential: reader });
    let settled = false;
    const pending = s.collector.collect(input, parent.signal).then(result => { settled = true; return result; });
    try {
      await started; parent.abort(new Error('private cancellation reason'));
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      expect(await pending).toEqual(refusal);
      expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
    } finally {
      release(); await pending; vi.useRealTimers();
    }
    // An abort-ignoring reader may settle later, but cannot resume HTTP or DML.
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });

  it.each(['binding', 'credential'] as const)('owns the deadline while the %s reader ignores cancellation', async phase => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let entered!: () => void; let release!: () => void; let readerSignal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reader = async (...args: unknown[]) => {
      readerSignal = args.at(-1) as AbortSignal; entered(); await held;
      return phase === 'binding' ? binding : 'server-secret';
    };
    const s = setup(phase === 'binding' ? { readBinding: reader } : { readCredential: reader });
    let settled = false;
    const pending = s.collector.collect(input, parent.signal).then(result => { settled = true; return result; });
    try {
      await started; await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false); expect(readerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true); expect(await pending).toEqual(refusal);
      expect(readerSignal?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); parent.abort(); await pending; vi.useRealTimers(); }
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });

  it.each(['binding', 'credential'] as const)('refuses a late %s read before timer delivery', async phase => {
    let elapsed = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const reader = async () => { elapsed = 10_000; return phase === 'binding' ? binding : 'server-secret'; };
      const s = setup(phase === 'binding' ? { readBinding: reader } : { readCredential: reader });
      expect(await s.collector.collect(input)).toEqual(refusal);
      expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
      if (phase === 'binding') expect(s.readCredential).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each(['fetch', 'body'] as const)('bounds caller cancellation when %s ignores its signal', async phase => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const s = setup({ fetch: async () => {
      const response = new Response(JSON.stringify(payload()));
      if (phase === 'fetch') { entered(); await held; }
      else response.text = async () => { entered(); await held; return JSON.stringify(payload()); };
      return response;
    } });
    let settled = false;
    const pending = s.collector.collect(input, parent.signal).then(result => { settled = true; return result; });
    try {
      await started; parent.abort(); await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true); expect(await pending).toEqual(refusal);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); await pending; vi.useRealTimers(); }
    expect(s.append).not.toHaveBeenCalled();
  });

  it('bounds the initial persisted binding population read before resolving credentials', async () => {
    vi.useFakeTimers();
    const deadline = new AbortController();
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(10_000); timer = setTimeout(() => deadline.abort(), ms); return deadline.signal;
    });
    const readCredential = vi.fn(async () => 'server-secret'); const fetch = vi.fn<typeof globalThis.fetch>();
    const request = { scope, month: '2026-10', asOfMs: time + 2000 };
    const collector = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => {
      entered(); await held; return [{ ...binding, observedAtMs: request.asOfMs }];
    } }, readCredential, fetch });
    let settled = false; const pending = collector.read(request).then(result => { settled = true; return result; });
    try {
      await started; await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(true); expect(await pending).toMatchObject({ complete: false, records: [] });
    } finally { release(); await pending; clearTimeout(timer); timeout.mockRestore(); vi.useRealTimers(); }
    expect(readCredential).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a late persisted binding population before deadline timer delivery', async () => {
    let elapsed = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const readCredential = vi.fn(async () => 'server-secret'); const fetch = vi.fn<typeof globalThis.fetch>();
    const request = { scope, month: '2026-10', asOfMs: time + 2000 };
    try {
      const collector = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => {
        elapsed = 10_000; return [{ ...binding, observedAtMs: request.asOfMs }];
      } }, readCredential, fetch });
      expect(await collector.read(request)).toMatchObject({ complete: false, records: [] });
      expect(readCredential).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('rechecks caller cancellation triggered by request cleanup before appending', async () => {
    const parent = new AbortController();
    const s = setup({ fetch: async (_url: unknown, options: RequestInit) => {
      options.signal?.addEventListener('abort', () => parent.abort(), { once: true });
      return new Response(JSON.stringify(payload()));
    } });
    expect(await s.collector.collect(input, parent.signal)).toEqual(refusal);
    expect(s.append).not.toHaveBeenCalled();
  });

  it('preserves the actual outcome of an append already in flight when the caller cancels', async () => {
    vi.useFakeTimers();
    const parent = new AbortController(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const append = vi.fn(async () => { entered(); await held; return 'recorded' as const; });
    const s = setup({ append }); let settled = false;
    const pending = s.collector.collect(input, parent.signal).then(result => { settled = true; return result; });
    try {
      await started; parent.abort(); await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false); expect(append).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { release(); await pending; vi.useRealTimers(); }
    expect(await pending).toMatchObject({ outcome: 'recorded' });
  });

  it.each(['fetch', 'body'] as const)('bounds stalled %s despite a non-expiring parent signal', async phase => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      let requestSignal: AbortSignal | undefined; let pendingIo = false; let settled = false;
      const fetch: typeof globalThis.fetch = async (_url, options) => {
        requestSignal = options?.signal ?? undefined;
        const stall = () => new Promise<never>((_resolve, reject) => {
          pendingIo = true;
          requestSignal!.addEventListener('abort', () => { pendingIo = false; reject(new Error('private provider error')); }, { once: true });
        });
        if (phase === 'fetch') return stall();
        const response = new Response('{}'); response.text = stall; return response;
      };
      const s = setup({ fetch });
      pending = s.collector.collect(input, parent.signal).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(pendingIo).toBe(true); expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toEqual(refusal);
      expect(requestSignal?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
      expect(pendingIo).toBe(false); expect(s.append).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { parent.abort(); await pending; vi.useRealTimers(); }
  });

  it.each(['success', 'error-status', 'invalid-body'] as const)('owns the request controller through %s and releases its timer', async outcome => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const parent = new AbortController();
      const s = setup({ fetch: async (_url: unknown, options: RequestInit) => {
        requestSignal = options.signal ?? undefined;
        return outcome === 'success' ? new Response(JSON.stringify(payload()))
          : outcome === 'error-status' ? new Response('private body', { status: 503 }) : new Response('{');
      } });
      const result = await s.collector.collect(input, parent.signal);
      expect(result.outcome).toBe(outcome === 'success' ? 'recorded' : 'unavailable');
      expect(requestSignal).not.toBe(parent.signal); expect(requestSignal?.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['fetch', 'body'] as const)('refuses a late %s result before timer delivery', async phase => {
    let elapsed = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const s = setup({ fetch: async () => {
        const response = new Response(JSON.stringify(payload()));
        if (phase === 'fetch') elapsed = 10_000;
        else response.text = async () => { elapsed = 10_000; return JSON.stringify(payload()); };
        return response;
      } });
      expect(await s.collector.collect(input, new AbortController().signal)).toEqual(refusal);
      expect(s.append).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each(['caller', 'error-status'] as const)('closes an actual streaming HTTP connection on %s', async reason => {
    let bodyOpened!: () => void; const opened = new Promise<void>(resolve => { bodyOpened = resolve; });
    let connectionClosed!: () => void; const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
    const server = createServer((_request, response) => {
      response.on('close', connectionClosed);
      response.writeHead(reason === 'caller' ? 200 : 503, { 'content-type': 'application/json' }); response.write('{');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture');
    const parent = new AbortController(); let requestSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, options) => {
      requestSignal = options?.signal ?? undefined;
      const response = await fetch(`http://127.0.0.1:${address.port}`, options); bodyOpened(); return response;
    };
    try {
      const s = setup({ fetch: fetchImpl }); const pending = s.collector.collect(input, parent.signal);
      await opened; if (reason === 'caller') parent.abort(new Error('private reason'));
      expect(await pending).toEqual(reason === 'caller' ? refusal
        : { outcome: 'unavailable', reason: 'provider-http-error', status: 503 });
      expect(requestSignal?.aborted).toBe(true); expect(s.append).not.toHaveBeenCalled(); await closed;
    } finally {
      parent.abort(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('does not restart the batch deadline for successive reads even before timer delivery', async () => {
    let elapsed = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const request = { scope, month: '2026-10', asOfMs: time + 2000 };
      const bindings = Array.from({ length: 5 }, (_, index) => ({ ...binding,
        generationId: `gen-batch-${index}`, observedAtMs: request.asOfMs }));
      const fetchImpl = vi.fn<typeof fetch>(async url => {
        elapsed += 3_000;
        const generationId = new URL(String(url)).searchParams.get('id');
        return new Response(JSON.stringify(payload(0.001, { id: generationId })));
      });
      const collector = createOpenRouterHostedUsageCollector({ store: { readOpenRouterBindings: async () => bindings },
        readCredential: async () => 'server-secret', fetch: fetchImpl });
      const result = await collector.read(request);
      expect(result.complete).toBe(false); expect(result.records).toHaveLength(3);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally { clock.mockRestore(); }
  });
});
