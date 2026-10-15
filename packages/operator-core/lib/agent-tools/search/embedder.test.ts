/**
 * GAP 11 — `buildQueryEmbedder` mode-resolution (embedder.ts).
 *
 * The cascade that picks the query-embedding provider for `search:semantic`:
 *
 *   key   = operator_credentials.openai_api_key  ||  OPENAI_API_KEY env
 *   mode  = voice-pref `memoryEmbedderMode` ∈ {openai, local, auto, unset}
 *           resolved against key-presence:
 *             openai + key  → openai
 *             local         → local
 *             auto | unset  → key ? openai : local
 *           loadVoicePrefs throwing + key → openai (the catch fallback)
 *
 *   openai → an Embedder that POSTs OpenAI /embeddings with
 *            dimensions:PROSE_VECTOR_DIMS, throwing `openai_embed_<status>` on
 *            a non-2xx;
 *   local  → a transformers pipeline, or null when the dynamic import fails;
 *   no mode resolved → null (→ engine falls back to BM25-only).
 *
 * readCredentials / loadVoicePrefs / fetch / the dynamic local import are all
 * stubbed so this isolates the resolution logic with zero network / model.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { beginEmbedLatencyTrace, finishEmbedLatencyTrace } from '@papercusp/search';

// Both deps are pulled in via dynamic import() inside buildQueryEmbedder, so the
// mocks below intercept those too (same shape rerank.test.ts uses).
vi.mock('../../credentials', () => ({ readCredentials: vi.fn() }));
// PARTIAL mock (real exports preserved, only loadVoicePrefs stubbed): the typed
// fixtures below need the REAL `DEFAULT_VOICE_PREFS`, and a whole-module factory
// would leave it `undefined` at runtime while still typechecking — the exact
// silently-wrong shape typed-mock.ts exists to remove.
vi.mock('../../voice-prefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../voice-prefs')>()),
  loadVoicePrefs: vi.fn(),
}));
// EI-19347189538723471: `@huggingface/transformers` is a real declared+installed
// dependency (packages/operator-core/package.json), so `localAvailable()` (the
// resolveEmbedderWith cascade's `localInstalled` seam, memory/configure.ts)
// genuinely resolves true in this test env — it no longer simulates "local
// unavailable" the way the local/null-fallback tests below need. Mock the
// actual pipeline BUILD seam instead (rejects → mirrors a real pipeline load
// failure: sidecar down, model fetch failed, …) so those tests stay hermetic
// regardless of what's installed on disk, rather than depending on package
// presence like the previous (now-stale) dynamic-import assumption did.
vi.mock('../../memory/embed-sidecar-wiring', () => ({
  buildSidecarAwareEmbedder: vi.fn().mockRejectedValue(new Error('local pipeline unavailable (mocked)')),
  // WI-3923: defaults to "cheap" (warm/no-sidecar) so every pre-existing test
  // above is unaffected — only the skipAcquisitionWhenCold suite below flips
  // this to false to exercise the cold-pipeline short-circuit.
  isLocalEmbedAcquisitionCheap: vi.fn().mockReturnValue(true),
  // memory/configure.ts localAvailable() consults this before probing the local
  // package; no test here installs an engine override, so mirror the real default.
  hasLocalEmbedEngineOverride: vi.fn().mockReturnValue(false),
}));

import {
  buildQueryEmbedder,
  buildQueryEmbedderResolved,
  embedderProfileIdOf,
  withAcquireBudget,
  _clearQueryEmbedCacheForTests,
} from './embedder';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
// Import the width rather than restating it: this assertion is ABOUT the prose
// column contract, so a future width change must move it automatically instead
// of stranding a fixture here (the 384→768 strand this line was fixed for).
import { PROSE_VECTOR_DIMS } from '../../search/prose-vector-dims';
import { readCredentials } from '../../credentials';
import { loadVoicePrefs, DEFAULT_VOICE_PREFS } from '../../voice-prefs';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { buildSidecarAwareEmbedder, isLocalEmbedAcquisitionCheap } from '../../memory/embed-sidecar-wiring';
import { markOpenAiEmbedFailure, __resetOpenAiEmbedCooldownForTest } from '../../memory/configure';

const savedKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks preserves mock implementations; restore the default local
  // build failure so a local-success case cannot leak into later fallback cases.
  vi.mocked(buildSidecarAwareEmbedder).mockRejectedValue(new Error('local pipeline unavailable (mocked)'));
  // WI-4734: the query-embed memo is module-scoped — without this, a vector
  // cached by one test (closing over ITS fetch stub) leaks into the next.
  _clearQueryEmbedCacheForTests();
  delete process.env.OPENAI_API_KEY;
  // Defaults: no stored key, no voice pref. Each test overrides as needed.
  vi.mocked(readCredentials).mockResolvedValue({});
  vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe('buildQueryEmbedder — OpenAI path', () => {
  it('forwards cancellation to the provider and rejects aborted cached callers', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    const controller = new AbortController();
    const reason = new Error('obsolete corpus query');
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBe(controller.signal);
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort(reason);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const embed = (await buildQueryEmbedder())!;
    await expect(embed('cancel provider', controller.signal)).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(embed('cancel provider', controller.signal)).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('carries the exact immutable query profile beside the compatibility mode and width', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    })));

    const resolved = await buildQueryEmbedderResolved();
    expect(resolved).toMatchObject({
      mode: 'openai',
      dims: EMBEDDER_DIM_SPECS.openai.targetDims,
      profile: EMBEDDER_DIM_SPECS.openai,
    });
    expect(embedderProfileIdOf(resolved!.embed)).toBe(
      EMBEDDER_DIM_SPECS.openai.profileId,
    );
  });

  it('records admission and provider time on the same query-embed trace', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    })));

    const embedder = await buildQueryEmbedder();
    const signal = new AbortController().signal;
    beginEmbedLatencyTrace(signal);
    await embedder!('stage trace', signal);

    const stages = finishEmbedLatencyTrace(signal);
    expect(stages?.admission).toEqual(expect.any(Number));
    expect(stages?.provider).toEqual(expect.any(Number));
  });

  it('records local inference time without exposing query content', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'local' });
    vi.mocked(buildSidecarAwareEmbedder).mockResolvedValue(async () => [0.1]);

    const embedder = await buildQueryEmbedder();
    const signal = new AbortController().signal;
    beginEmbedLatencyTrace(signal);
    await embedder!('private query text', signal);

    const stages = finishEmbedLatencyTrace(signal);
    expect(stages?.localInference).toEqual(expect.any(Number));
  });

  it('(a) openai mode + key → an embedder that POSTs OpenAI with dimensions:PROSE_VECTOR_DIMS, returns the vector', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeTypeOf('function');

    const vec = await embedder!('auth strategy');
    expect(vec).toEqual([0.1, 0.2, 0.3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-stored');
    const body = JSON.parse(init.body as string);
    expect(body.dimensions).toBe(PROSE_VECTOR_DIMS);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toBe('auth strategy');
  });

  it('(a2) the openai embedder throws `openai_embed_<status>` on a non-2xx response', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));

    const embedder = await buildQueryEmbedder();
    await expect(embedder!('x')).rejects.toThrow('openai_embed_429');
  });

  it('uses the OPENAI_API_KEY env var as the key when no credential is stored', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(readCredentials).mockResolvedValue({}); // no stored key
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    await embedder!('x');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-env');
  });

  it('(c) auto mode + key → openai (POSTs OpenAI)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [9] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(await embedder!('x')).toEqual([9]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('(e) loadVoicePrefs throwing + key → openai (the catch fallback)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(loadVoicePrefs).mockRejectedValue(new Error('voice-prefs boom'));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [7] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeTypeOf('function');
    expect(await embedder!('x')).toEqual([7]);
  });
});

describe('buildQueryEmbedder — local / null fallback', () => {
  // The local branch delegates to `buildSidecarAwareEmbedder` (memory/embed-sidecar-wiring,
  // mocked above to always reject) — simulating a local pipeline that is selected but fails
  // to build (sidecar down, model fetch failed, package genuinely missing, …). That is
  // exactly the (b)/(d)/(f) contract: when local is selected but unavailable,
  // buildQueryEmbedder yields null and the engine degrades to BM25-only.
  //
  // ⚠ THE DEGRADE IS LOGGED, AND THAT LOG IS COVERED BEHAVIOR — NOT NOISE.
  // embedder.ts's acquisition catch console.warn()s the degrade (added
  // 2026-08-04, after a swallowed ReferenceError disabled semantic search for a
  // whole process while every caller reported a normal "no embedder" degrade —
  // it surfaced only as red gate tests hours later). This repo runs
  // vitest-fail-on-console, so an unasserted warn fails the test; these three
  // cases therefore OWN the warn instead of being broken by it.
  //
  // Asserting it beats silencing it twice over: the warn becomes covered (delete
  // it and a test reds, so the observability cannot be quietly lost again), and
  // it is the ONLY thing separating (b) from (d)/(f)/unset. All four return
  // null, but (b) never selects local at all — it falls off the end of the
  // cascade — whereas the others select local and fail to build it. Without the
  // warn assertion those two very different paths are indistinguishable here,
  // which is precisely the confusion the log was added to end.
  let warnSpy: MockInstance;
  const DEGRADE_WARN = /\[query-embedder\] embedder acquisition failed — degrading to BM25-only/;

  beforeEach(() => {
    // Installed AFTER the file-level beforeEach's clearAllMocks(); removed by
    // the file-level afterEach's restoreAllMocks().
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('(b) openai mode but NO key → does not pick openai; falls to local → null (import unavailable)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({}); // no key
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // mode='openai' but no key → the `m==='openai' && key` guard fails, and no
    // other branch matches (m is neither 'local' nor 'auto'/unset) → mode stays
    // null → returns null. No OpenAI call.
    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // THE CONTROL for (d)/(f)/unset below: this null comes from falling off the
    // end of the cascade, not from a failed acquisition — so nothing degraded
    // and nothing was logged. If this ever warns, the cascade started attempting
    // a local build it is not supposed to attempt.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('(d) auto mode + NO key → local selected → null (local import unavailable) + no OpenAI call', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    // local was selected but the transformers import fails → null (BM25 fallback).
    expect(embedder).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // …and unlike (b), the failure was ANNOUNCED rather than swallowed.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(DEGRADE_WARN));
  });

  it('(f) explicit local mode (even with a key) → local import fails → null', async () => {
    process.env.OPENAI_API_KEY = 'sk-env'; // key present but mode pins local
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'local' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
    // mode pinned local → OpenAI never used despite the key.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(DEGRADE_WARN));
  });

  it('unset mode + NO key → local → null (no mode resolved to a usable embedder)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    vi.mocked(loadVoicePrefs).mockResolvedValue({} as never); // memoryEmbedderMode undefined
    vi.stubGlobal('fetch', vi.fn());

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
    // unset + no key resolves to local (per the cascade), so this is a FAILED
    // acquisition like (d)/(f) — announced, not a fall-off-the-end like (b).
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(DEGRADE_WARN));
  });

  it('readCredentials throwing falls back to the env key (try/catch around creds read)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(readCredentials).mockRejectedValue(new Error('creds boom'));
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [3] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(await embedder!('x')).toEqual([3]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-env');
  });
});

describe('withAcquireBudget — bounds the query-embedder acquisition (WI-3922)', () => {
  // The acquisition itself resolves fast in this test env (the local transformers
  // import is unavailable → null immediately), so the race logic that guards a
  // slow cold-pipeline acquisition is exercised directly against a controllable
  // slow promise here.
  const slow = <T>(v: T, ms: number): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
  const sentinel = { tag: 'embedder' as const };

  it('returns the acquisition value when it settles within budget', async () => {
    await expect(withAcquireBudget(slow(sentinel, 10), 200)).resolves.toBe(sentinel);
  });

  it('returns null when the acquisition exceeds the budget (cold pipeline → BM25 degrade)', async () => {
    await expect(withAcquireBudget(slow(sentinel, 200), 20)).resolves.toBeNull();
  });

  it('budget ≤ 0 ⇒ unbounded — awaits the acquisition however slow (background/batch callers)', async () => {
    await expect(withAcquireBudget(slow(sentinel, 30), 0)).resolves.toBe(sentinel);
  });

  it('a rejected acquisition within budget degrades to null, never throws', async () => {
    await expect(withAcquireBudget(Promise.reject(new Error('cold pipeline boom')), 200)).resolves.toBeNull();
  });
});

describe('query-embed memo (WI-4734 — facet/window re-queries must not re-pay the embed)', () => {
  function openAiReady(vec: number[] = [0.1, 0.2]) {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vec }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('the same query embeds ONCE — the second call is a cache hit (even across embedder builds)', async () => {
    const fetchMock = openAiReady([0.5]);
    const e1 = await buildQueryEmbedder();
    expect(await e1!('improvements')).toEqual([0.5]);
    expect(await e1!('improvements')).toEqual([0.5]);
    // A facet/window re-query builds a FRESH embedder for the same q — still a hit.
    const e2 = await buildQueryEmbedder();
    expect(await e2!('improvements')).toEqual([0.5]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes casing and incidental whitespace for exact-query memo identity', async () => {
    const fetchMock = openAiReady([0.6]);
    const embedder = await buildQueryEmbedder();
    await expect(embedder!('  Same\tQuery ')).resolves.toEqual([0.6]);
    await expect(embedder!('same query')).resolves.toEqual([0.6]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a different query is a miss; a failed embed is evicted (never sticks)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi
      .fn()
      // 1st: q-a ok; 2nd: q-b fails; 3rd: q-b retried ok (proves eviction).
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1] }] }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [2] }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(await embedder!('q-a')).toEqual([1]);
    await expect(embedder!('q-b')).rejects.toThrow('openai_embed_500');
    expect(await embedder!('q-b')).toEqual([2]); // retried — the failure was not cached
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not share an abortable in-flight embed, but caches its completed vector (WI-41248)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'local' } as never);
    const pending: Array<{
      signal: AbortSignal | undefined;
      resolve: (vector: number[]) => void;
      reject: (error: unknown) => void;
    }> = [];
    const inner = vi.fn((_text: string, signal?: AbortSignal) =>
      new Promise<number[]>((resolve, reject) => {
        pending.push({ signal, resolve, reject });
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
    vi.mocked(buildSidecarAwareEmbedder).mockResolvedValueOnce(inner);
    const embed = await buildQueryEmbedder();
    expect(embed).not.toBeNull();

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = embed!('same query', firstAbort.signal);
    const second = embed!('same query', secondAbort.signal);
    expect(inner).toHaveBeenCalledTimes(2); // no shared cancellation ownership

    const reason = new Error('first caller expired');
    firstAbort.abort(reason);
    await expect(first).rejects.toBe(reason);
    pending[1].resolve([0.4, 0.5]);
    await expect(second).resolves.toEqual([0.4, 0.5]);

    // Once complete, the deterministic vector is safe to share again.
    await expect(embed!('same query', new AbortController().signal)).resolves.toEqual([0.4, 0.5]);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe('buildQueryEmbedder — skipAcquisitionWhenCold (WI-3923)', () => {
  afterEach(() => {
    // Cooldown is real module state on `../../memory/configure` (not mocked,
    // since the 'openai'/'local' explicit-mode branches this file exercises
    // don't depend on it) — reset it so one test's cooldown can't leak into
    // the next.
    __resetOpenAiEmbedCooldownForTest();
  });

  it('OpenAI cooldown + local acquisition cold + opt-in → resolves null immediately (BM25 degrade), never touches the cascade', async () => {
    markOpenAiEmbedFailure();
    vi.mocked(isLocalEmbedAcquisitionCheap).mockReturnValue(false);
    // Deliberately NOT stubbing fetch/readCredentials/loadVoicePrefs beyond the
    // defaults: the short-circuit must fire BEFORE the cascade is ever awaited,
    // so what it would otherwise have resolved to is moot — if this test needed
    // those mocks to pass, the short-circuit would not actually be short.
    const embedder = await buildQueryEmbedder({ skipAcquisitionWhenCold: true });
    expect(embedder).toBeNull();
  });

  it('not in cooldown → opt-in has no effect; normal cascade still resolves an embedder', async () => {
    vi.mocked(isLocalEmbedAcquisitionCheap).mockReturnValue(false); // cold, but irrelevant here
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.9] }] }) })),
    );
    const embedder = await buildQueryEmbedder({ skipAcquisitionWhenCold: true });
    await expect(embedder!('x')).resolves.toEqual([0.9]);
  });

  it('in cooldown but local acquisition is CHEAP (warm) → does not skip; cascade still resolves', async () => {
    markOpenAiEmbedFailure();
    vi.mocked(isLocalEmbedAcquisitionCheap).mockReturnValue(true);
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.7] }] }) })),
    );
    const embedder = await buildQueryEmbedder({ skipAcquisitionWhenCold: true });
    await expect(embedder!('x')).resolves.toEqual([0.7]);
  });

  it('opt-in omitted (default) → unaffected even while in cooldown + cold (background/batch callers keep waiting)', async () => {
    markOpenAiEmbedFailure();
    vi.mocked(isLocalEmbedAcquisitionCheap).mockReturnValue(false);
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    mockResolvedTyped(vi.mocked(loadVoicePrefs), { ...DEFAULT_VOICE_PREFS, memoryEmbedderMode: 'openai' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.3] }] }) })),
    );
    const embedder = await buildQueryEmbedder(); // no opts at all
    await expect(embedder!('x')).resolves.toEqual([0.3]);
  });
});
