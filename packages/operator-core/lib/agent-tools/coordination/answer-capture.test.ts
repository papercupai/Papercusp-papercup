/**
 * answer-capture.test.ts — D-004 capture core (answer-capture.ts), unit.
 *
 * The capture is stubbed in every OTHER test (the conversations integration test
 * injects a fake CaptureFn), so the REAL captureResolvedAnswer + captureMem0Key
 * have no direct coverage. This file unit-tests them against a MOCKED neutral
 * MemoryBackend (generalize-memory-backend-swappable D-003):
 *  • captureMem0Key — the pseudo-user-key mapping (harness:<slug> vs
 *    workspace:<id> vs workspace:default) that must mirror memory:remember's
 *    scoping so coord:ask's memory read finds a captured answer.
 *  • captureResolvedAnswer — target:'none' (skip, no backend touched);
 *    available() not-ok / throwing (mem0_unavailable); remember throwing
 *    (mem0_error); and the happy path's `Q:…\nA:…` content written under the
 *    right scope key.
 *
 * The whole posture is best-effort: a capture failure reports {ok:false} but is
 * NEVER thrown (the resolve must not fail on a store outage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// answer-capture resolves the store via getMemoryBackend from '../../memory/backend'; mock it.
const getMemoryBackend = vi.fn();
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: () => getMemoryBackend(),
}));

// captureResolvedAnswer resolves an omitted workspace via activeWorkspaceId() (D-003 —
// never a silent 'default'). Override it to a fixed value so the fallback path is
// deterministic without a live workspace registry; all other exports stay real.
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'active-ws',
}));

import { captureMem0Key, captureResolvedAnswer, type CaptureInput } from './answer-capture';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
};

function fakeBackend(): FakeBackend {
  return {
    name: 'fake',
    available: vi.fn(async () => ({ ok: true })),
    remember: vi.fn(async () => ({ ids: ['id-1'] })),
  };
}

function baseInput(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    target: 'mem0',
    question: 'why does the shop freeze?',
    answer: 'zero-cache was down (orphaned replicator lock)',
    scope: 'operator',
    harness_slug: null,
    workspace_id: 'default',
    asker_id: 'agA',
    resolver_id: 'agB',
    conversation_id: 'conv-1',
    ...over,
  };
}

describe('captureMem0Key — pseudo-user-key mapping', () => {
  it('harness scope with a slug → harness:<slug>', () => {
    expect(captureMem0Key('harness', 'papercup', 'default')).toBe('harness:papercup');
    // The slug wins over the workspace id when scope is harness.
    expect(captureMem0Key('harness', 'restart', 'ws-7')).toBe('harness:restart');
  });

  it('operator scope → workspace:<workspace_id>', () => {
    expect(captureMem0Key('operator', null, 'ws-7')).toBe('workspace:ws-7');
  });

  it('operator scope builds the workspace key from the (caller-resolved) workspace id', () => {
    // captureMem0Key is now PURE + requires a CONCRETE workspace — the omitted-scope
    // fallback (activeWorkspaceId()) lives in captureResolvedAnswer, not here (D-003).
    expect(captureMem0Key('operator', null, 'default')).toBe('workspace:default');
    expect(captureMem0Key('operator', null, 'papercusp-workspace')).toBe('workspace:papercusp-workspace');
  });

  it('harness scope WITHOUT a slug falls back to the workspace key (guards the CHECK-less core)', () => {
    // scope==='harness' but no slug → not a valid harness key; the core degrades
    // to the workspace key rather than emitting `harness:null`.
    expect(captureMem0Key('harness', null, 'ws-7')).toBe('workspace:ws-7');
    expect(captureMem0Key('harness', '', 'ws-7')).toBe('workspace:ws-7');
  });
});

describe('captureResolvedAnswer', () => {
  beforeEach(() => {
    getMemoryBackend.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('target:none → skipped, ok, and the backend is never resolved', async () => {
    const res = await captureResolvedAnswer(baseInput({ target: 'none' }));
    expect(res).toEqual({ target: 'none', ok: true, detail: 'capture skipped by resolver' });
    expect(getMemoryBackend).not.toHaveBeenCalled();
  });

  it('available() not-ok → mem0_unavailable (ok:false), never throws', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'mem0_unavailable' });
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_unavailable');
    expect(b.remember).not.toHaveBeenCalled();
  });

  it('available() itself throwing → mem0_unavailable (caught → unavailable)', async () => {
    const b = fakeBackend();
    b.available.mockRejectedValue(new Error('boom resolving client'));
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_unavailable');
  });

  it('remember throwing → mem0_error (ok:false) carrying the error message', async () => {
    const b = fakeBackend();
    b.remember.mockRejectedValue(new Error('store add failed'));
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_error');
    expect(res.detail).toBe('store add failed');
  });

  it('remember errors preserve only allowlisted diagnostics found in a nested cause', async () => {
    const rawDiagnostics = {
      status: 404,
      requestId: 'req.123',
      type: 'anthropic',
      classification: 'permanent',
      transport: 'anthropic-direct',
      transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
      url: 'https://provider.invalid/private-path',
      headers: { authorization: 'Bearer secret-token' },
      body: 'private provider response',
      account: 'private-account',
    };
    const cause = Object.assign(new Error('provider failure'), { diagnostics: rawDiagnostics });
    const wrapped = Object.assign(new Error('mem0 wrapper'), { cause });
    const outer = Object.assign(new Error('LLM extraction failed'), { cause: wrapped });
    const b = fakeBackend();
    b.remember.mockRejectedValue(outer);
    getMemoryBackend.mockReturnValue(b);

    await expect(captureResolvedAnswer(baseInput())).resolves.toEqual({
      target: 'mem0_error',
      ok: false,
      detail: 'LLM extraction failed',
      diagnostics: {
        status: 404,
        requestId: 'req.123',
        type: 'anthropic',
        classification: 'permanent',
        transport: 'anthropic-direct',
        transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
      },
    });
  });

  it('remember resolving with ZERO stored events → mem0_no_store (ok:false) — the EI-25 false-success fix', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [], storedEvents: 0 });
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_no_store');
    expect(res.detail).toContain('persisted nothing');
  });

  it('remember resolving with a MERGE (no new ids, storedEvents>0) → ok:true (an UPDATE is a real store)', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [], storedEvents: 1 });
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput({ workspace_id: 'ws-7' }));
    expect(res).toEqual({ target: 'mem0:workspace:ws-7', ok: true });
  });

  it('backend that omits storedEvents falls back to ids.length (empty ids ⇒ no_store)', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [] });
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_no_store');
  });

  it('happy path (operator) → writes Q:…\\nA:… under workspace:<id>, returns mem0:<scopeKey>', async () => {
    const b = fakeBackend();
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput({ workspace_id: 'ws-7' }));

    expect(res).toEqual({ target: 'mem0:workspace:ws-7', ok: true });
    expect(b.remember).toHaveBeenCalledTimes(1);
    const [content, opts] = b.remember.mock.calls[0];
    expect(content).toBe('Q: why does the shop freeze?\nA: zero-cache was down (orphaned replicator lock)');
    expect(opts.scope).toBe('workspace:ws-7');
    expect(opts.kind).toBe('project');
    expect(opts.metadata).toMatchObject({
      scope: 'workspace',
      source: 'conversation',
      conversation_id: 'conv-1',
      resolved_by: 'agB',
      asked_by: 'agA',
      workspace_id: 'ws-7',
    });
    expect(opts.metadata.harness_slug).toBeUndefined();
  });

  it('an omitted workspace_id resolves via activeWorkspaceId() — never the literal "default" (D-003)', async () => {
    const b = fakeBackend();
    getMemoryBackend.mockReturnValue(b);
    // workspace_id blank → the operator-scope key falls back to the resolved active
    // workspace (mocked 'active-ws'), matching what ask-knowledge-tier reads.
    const res = await captureResolvedAnswer(baseInput({ workspace_id: '' }));
    expect(res).toEqual({ target: 'mem0:workspace:active-ws', ok: true });
    const [, opts] = b.remember.mock.calls[0];
    expect(opts.scope).toBe('workspace:active-ws');
    expect(opts.metadata).toMatchObject({ workspace_id: 'active-ws' });
  });

  it('happy path (harness) → writes under harness:<slug> with the harness metadata', async () => {
    const b = fakeBackend();
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(
      baseInput({ scope: 'harness', harness_slug: 'papercup', workspace_id: 'ws-7' }),
    );

    expect(res).toEqual({ target: 'mem0:harness:papercup', ok: true });
    const [, opts] = b.remember.mock.calls[0];
    expect(opts.scope).toBe('harness:papercup');
    expect(opts.metadata).toMatchObject({ scope: 'harness', harness_slug: 'papercup' });
  });

  it('trims the question + answer before the Q/A content', async () => {
    const b = fakeBackend();
    getMemoryBackend.mockReturnValue(b);
    await captureResolvedAnswer(baseInput({ question: '  spaced q  ', answer: '\tspaced a\n' }));
    expect(b.remember.mock.calls[0][0]).toBe('Q: spaced q\nA: spaced a');
  });

  // P2-20: a malformed/blank question must not yield a "Q: \nA: …" entry with a
  // dangling blank question stem. Capture is best-effort, so a blank question is
  // SKIPPED (ok:false, backend untouched) — the accepted answer still lives on
  // the conversation row, so nothing is lost.
  it('a blank question is skipped (ok:false) without writing a blank-Q entry — answer stays on the row', async () => {
    const b = fakeBackend();
    getMemoryBackend.mockReturnValue(b);
    const res = await captureResolvedAnswer(baseInput({ question: '   \n  ', answer: 'fix' }));

    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_blank_question');
    // Best-effort: the backend was never asked to persist a malformed entry.
    expect(b.remember).not.toHaveBeenCalled();
  });
});
