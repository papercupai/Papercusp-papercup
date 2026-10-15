import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({ user: 'user-one', workspace: 'ws-one', prompts: [] as { promptText: string }[], localPrompts: [] as { signal?: AbortSignal }[], localDelayMs: 0, fail: false, synth: vi.fn(), prefs: vi.fn() }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => h.user ? { id: h.user } : null }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => h.workspace }));
vi.mock('../../../agent-chat-stream', () => ({ runAgentChat: async function* (request: { promptText: string }) {
  h.prompts.push(request);
  if (h.fail) { yield { type: 'error', message: 'Model unavailable.' }; return; }
  yield { type: 'result', finalText: 'Requested explicit summary.', costUsd: 0, tokensIn: 10, tokensOut: 10, stopReason: 'end_turn' };
}, ownerHeaders: () => ({}), priorityTierHeaders: () => ({}) }));
vi.mock('../../../agent-loop/ai-sdk-port', () => ({ createAiSdkPort: () => ({ stream: async function* (request: { signal?: AbortSignal }) {
  h.localPrompts.push(request);
  if (h.localDelayMs) await new Promise(resolve => setTimeout(resolve, h.localDelayMs));
  yield { type: 'text_delta', text: 'Local explicit summary.' };
  yield { type: 'stop', reason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
} }) }));
vi.mock('../../../inference-gateway/local-backend-store', () => ({ listLocalBackends: async () => [{ enabled: true, models: ['fixture-local'] }] }));
vi.mock('../../../operator-budget', () => ({ checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {} }));
vi.mock('../../../cache/instance', () => ({ getOperatorCache: () => ({ getOrSet: async (_workspace: string, _key: string, factory: () => Promise<unknown>) => factory() }) }));
vi.mock('../../../voice-prefs', () => ({ loadVoicePrefs: h.prefs }));
vi.mock('../../../voice-node/kokoro-local', () => ({ kokoroTtsAvailable: async () => false }));
vi.mock('./tts-synth', () => ({ synthesize: h.synth, synthesizeReading: h.synth }));
vi.mock('../../../endpoint-route/telemetry', () => ({ recordRouteInvocation: vi.fn() }));
import tool from './operator-tts';
import { registerRoute } from '../../../endpoint-route/define-route';
import { DEFAULT_ROUTE_STACK } from '../../../endpoint-route/route-stack';
type Route = { handler(req: Request, ctx?: { signal: AbortSignal }): Promise<Response> };
async function post(body: unknown, signal?: AbortSignal, routeSignal?: AbortSignal) {
  return (tool as unknown as Route).handler(new Request('http://localhost/api/agent-mcp/operator-tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }), routeSignal ? { signal: routeSignal } : undefined);
}
beforeEach(() => { h.user = 'user-one'; h.workspace = 'ws-one'; h.fail = false; h.localDelayMs = 0; h.prompts.length = 0; h.localPrompts.length = 0; vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });
describe('existing output endpoint explicit summary operation', () => {
  it('returns phase evidence for a bounded local-model timeout without source or partial output', async () => {
    vi.useFakeTimers(); h.localDelayMs = 1000;
    const pending = post({ operation: 'summarize', content: { kind: 'text', text: 'PRIVATE SOURCE-938' },
      summary: { model: 'fixture-local', timeoutMs: 100 } });
    await vi.waitFor(() => expect(h.localPrompts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: 'budget-exceeded', diagnostics: { stage: 'model-wait', calls: 1 } });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE SOURCE-938|Local explicit summary/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.localPrompts[0].signal?.aborted).toBe(true);
    expect(h.synth).not.toHaveBeenCalled();
  });
  it('honors a bounded summary longer than the default route watchdog', async () => {
    vi.useFakeTimers(); h.localDelayMs = 45_000;
    const app = new Hono();
    // Use the production invocation/watchdog; identity is covered separately.
    registerRoute(app, tool, DEFAULT_ROUTE_STACK.filter(step => step.name === 'invoke'));
    const pending = app.request('/agent-mcp/operator-tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'summarize', content: { kind: 'text', text: 'Bounded local source.' }, summary: { model: 'fixture-local', timeoutMs: 60_000 } }) });
    await vi.waitFor(() => expect(h.localPrompts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await pending;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, summary: 'Local explicit summary.' });
  });
  it('propagates the route abort to an in-flight summary even if the adapter returns late', async () => {
    vi.useFakeTimers(); h.localDelayMs = 1000;
    const route = new AbortController();
    const pending = post({ operation: 'summarize', content: { kind: 'text', text: 'Source.' }, summary: { model: 'fixture-local' } }, undefined, route.signal);
    await vi.waitFor(() => expect(h.localPrompts).toHaveLength(1));
    route.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(499);
    expect(h.localPrompts[0].signal?.aborted).toBe(true);
    expect(h.synth).not.toHaveBeenCalled();
  });
  it('propagates the route abort to original reading before audio can escape', async () => {
    const route = new AbortController(); route.abort();
    h.prefs.mockResolvedValue({ ttsEngine: 'kokoro' });
    h.synth.mockImplementationOnce(async function* (_text, _prefs, options) {
      if (options.signal.aborted) yield { ok: false, status: 499, error: 'speech cancelled' };
      else yield { ok: true, audio: new Uint8Array([1]).buffer };
    });
    expect((await post({ operation: 'read', text: 'Original source.' }, undefined, route.signal)).status).toBe(499);
  });
  it('propagates the route abort to the existing single-chunk speech path', async () => {
    const route = new AbortController(); route.abort();
    h.prefs.mockResolvedValue({ ttsEngine: 'kokoro' });
    h.synth.mockImplementationOnce(async (_engine, _text, _voice, _prefs, options) => options?.signal?.aborted
      ? { ok: false, status: 499, error: 'speech cancelled' }
      : { ok: true, audio: new Uint8Array([1]).buffer, contentType: 'audio/wav' });
    expect((await post({ text: 'Source.', engine: 'kokoro' }, undefined, route.signal)).status).toBe(499);
  });
  it('processes the full supplied selection, forwards options and never synthesizes speech', async () => {
    const text = 'Authorized selection. '.repeat(1800) + 'EXACT FINAL TAIL';
    const result = await post({ operation: 'summarize', content: { kind: 'selection', text, partial: true, ref: 'provided:selection' }, summary: { allowCloud: true, length: 'short', focus: 'numbers', language: 'French' } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, summary: 'Requested explicit summary.', sourceRefs: ['provided:selection'], coverage: { complete: false, characters: text.length, warnings: ['source-partial'] } });
    const leaves = h.prompts.map(p => JSON.parse(p.promptText)).filter(p => p.phase.startsWith('source chunk'));
    expect(leaves.map(p => p.quotedSource).join('')).toBe(text);
    expect(leaves[0]).toMatchObject({ length: 'short', focus: 'numbers', language: 'French' });
    expect(h.synth).not.toHaveBeenCalled(); expect(h.prefs).not.toHaveBeenCalled();
  });
  it('refuses unconsented cloud disclosure and never routes a local selection through the cloud runner', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'Source.' } };
    const denied = await post(body);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ ok: false, code: 'cloud-consent-required' });
    expect(h.prompts).toHaveLength(0);
    const local = await post({ ...body, summary: { model: 'fixture-local' } });
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ ok: true, summary: 'Local explicit summary.', usage: { costUsd: 0 } });
    expect(h.localPrompts).toHaveLength(1);
    expect(h.prompts).toHaveLength(0);
    const pin = await post({ ...body, summary: { model: 'fixture-local', account: 'cloud-pin', allowCloud: true } });
    expect(pin.status).toBe(503); expect(await pin.json()).toMatchObject({ code: 'local-route-unavailable' });
    expect(h.localPrompts).toHaveLength(1); expect(h.prompts).toHaveLength(0);
  });
  it('rejects reference-only input and malformed options before any model call', async () => {
    expect((await post({ operation: 'summarize', content: { kind: 'reference', ref: 'private:elsewhere' } })).status).toBe(400);
    expect((await post({ operation: 'summarize', content: { kind: 'text', text: 'source' }, summary: { maxCalls: 0 } })).status).toBe(400);
    expect(h.prompts).toHaveLength(0);
  });
  it('requires a current user and concrete workspace, including for repeated requests', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'private source' }, summary: { allowCloud: true } };
    h.user = ''; expect((await post(body)).status).toBe(401);
    h.user = 'user-one'; h.workspace = '*'; expect((await post(body)).status).toBe(401);
    expect(h.prompts).toHaveLength(0);
  });
  it('keeps cancellation and model errors honest and silent', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'source' }, summary: { allowCloud: true } };
    const ac = new AbortController(); ac.abort();
    expect((await post(body, ac.signal)).status).toBe(499);
    expect(h.prompts).toHaveLength(0);
    h.fail = true; const failed = await post(body);
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ ok: false, code: 'model-failed' });
    expect(h.synth).not.toHaveBeenCalled();
  });
});
