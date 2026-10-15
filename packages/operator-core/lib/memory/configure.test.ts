import { afterEach, describe, expect, it, vi } from 'vitest';

const initBackendSelection = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./backend-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backend-selection')>()),
  initMemoryBackendSelection: initBackendSelection,
}));

// EI-7279: mem0-client.ts caches the built client for a 1-HOUR TTL, so the
// `resolveEmbedderWith` cascade (which correctly prefers local during an
// OpenAI cooldown, per the EI-3381 tests below) is only ever RE-EVALUATED
// when the client is rebuilt. Without forcing a rebuild, a 60s cooldown flag
// sat inert for up to an hour: the already-built client kept routing every
// embed through the same dead OpenAI key. `markOpenAiEmbedFailure` must force
// that rebuild by invalidating the cached client — spy on the real
// `@papercusp/memory` export (keep everything else real) to pin it.
const invalidateMemoryClient = vi.fn();
vi.mock('@papercusp/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/memory')>();
  return { ...actual, invalidateMemoryClient: (...a: unknown[]) => invalidateMemoryClient(...a) };
});

import {
  buildOpenAiEmbedder,
  resolveEmbedderWith,
  readEmbedderPreference,
  markOpenAiEmbedFailure,
  isOpenAiEmbedInCooldown,
  clearOpenAiEmbedHardExhaustion,
  __resetOpenAiEmbedCooldownForTest,
  EMBEDDER_PREFERENCES,
  proseSurfacePreference,
  localAvailable,
  type ResolveEmbedderDeps,
} from './configure';
import {
  __resetEmbedExhaustionAlertForTest,
  __setEmbedExhaustionNotifierForTest,
} from './embed-exhaustion-alert';
import { EmbedBudgetExhaustedError } from './embed-admission';
// The per-mode declared widths — the emitting side of the dims contract. The
// mock above spreads `...actual`, so this is the real spec table.
import { EMBEDDER_DIM_SPECS, memoryHost } from '@papercusp/memory';

// Capture module evaluation before any test selects a backend. Registry-only
// imports must configure the host without starting the org-PG settings read.
const backendHydrationsDuringImport = initBackendSelection.mock.calls.length;

describe('memory backend hydration', () => {
  it('registers and configures the memory host without reading persisted settings', () => {
    expect(backendHydrationsDuringImport).toBe(0);
    expect(typeof memoryHost().backend).toBe('function');
  });

  it('starts hydration when the configured backend is actually selected', () => {
    const before = initBackendSelection.mock.calls.length;
    const select = memoryHost().backend;
    expect(typeof select).toBe('function');
    if (typeof select !== 'function') throw new Error('missing backend selector');
    expect(select()).toBeTypeOf('string');
    expect(initBackendSelection).toHaveBeenCalledTimes(before + 1);
  });
});

describe('mem0 history store — WI-10003284', () => {
  it('the operator keeps mem0 history IN MEMORY, never in a SQLite file its processes share', () => {
    // better-sqlite3 writes that history synchronously on the event loop. A
    // file shared by the request workers, the background host and staging made
    // every memory add wait on the others' locks and fsyncs: one INSERT blocked
    // a live :3070 worker for 32.8 s and timed out the requests behind it.
    const configured = memoryHost().localStoreDir;
    const dir = typeof configured === 'function' ? configured() : configured;
    expect(dir ?? null).toBeNull();
  });
});

// EI-7596: the 'memory' lane's admission acquire() is what THROWS the daily-spend-cap error —
// stub it directly (rather than driving the real governor through 5M real tokens) so the test
// can flip between "cap tripped" and "cap clear" deterministically.
const mockAcquire = vi.fn(async () => ({ release: () => {} }));
vi.mock('./embed-admission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./embed-admission')>();
  return {
    ...actual,
    embedAdmission: () => ({
      governor: {} as unknown,
      acquire: mockAcquire,
      recordResponse: () => {},
      penalize: () => {},
      usage: () => ({ day: 0, dayTokens: 0, capTokens: 0, overBudget: false }),
    }),
  };
});

/**
 * GAP 4 — the `resolveEmbedder` cascade (configure.ts) was UNTESTED.
 *
 * A wrong fallthrough here is silent and corrupting: it routes writes to the
 * WRONG per-model vec table (openai's 384-dim space vs local's, which aren't
 * comparable — recall from the wrong table is garbage), or disables embedding
 * entirely when a usable key existed (memory goes dark). The four preferences
 * (`auto` / `openai` / `local` / `disabled`) crossed with {key present/absent}
 * and {local installed/not} have to land on the exact `{mode, reason}` the
 * downstream store keys off of. We pin every cell of that table.
 *
 * The cascade core is `resolveEmbedderWith(deps)` — the same logic the
 * production `resolveEmbedder` runs, with the network/credential/package seams
 * injected so we exercise the branch logic without real I/O. Behavior is
 * identical to the previous inline form; the injection is a testability seam.
 */

const STUB_OPENAI_EMBED = async () => [1, 2, 3];
const STUB_LOCAL_EMBED = async () => [4, 5, 6];
const STUB_GEMMA_EMBED = async () => [7, 8, 9];
const STUB_HARRIER_EMBED = async () => [10, 11, 12];
/**
 * A resolved embedder's `dims` is its MODE'S declared target width, and those
 * now differ per mode (local 384, gemma/openai 768, harrier 1024). This used to
 * be a single `EMBEDDER_DIM = 384` shared by every assertion below, which was
 * only ever correct while every mode happened to agree — the 384→768 move broke
 * six assertions at once. Asserting each mode against its OWN declared spec is
 * both the real contract and immune to the next width change.
 */
const declaredDims = (mode: string): number =>
  EMBEDDER_DIM_SPECS[mode as keyof typeof EMBEDDER_DIM_SPECS].targetDims;

/** Build a deps object; each seam defaults to a recorded spy so a test can
 *  assert which legs were/weren't consulted. */
function makeDeps(overrides: Partial<ResolveEmbedderDeps> = {}): {
  deps: ResolveEmbedderDeps;
  buildOpenAi: ReturnType<typeof vi.fn>;
  buildLocal: ReturnType<typeof vi.fn>;
  buildGemma: ReturnType<typeof vi.fn>;
  buildHarrier: ReturnType<typeof vi.fn>;
  resolveKey: ReturnType<typeof vi.fn>;
  localInstalled: ReturnType<typeof vi.fn>;
} {
  const buildOpenAi = vi.fn(() => STUB_OPENAI_EMBED);
  const buildLocal = vi.fn(async () => STUB_LOCAL_EMBED);
  const buildGemma = vi.fn(async () => STUB_GEMMA_EMBED);
  const buildHarrier = vi.fn(async () => STUB_HARRIER_EMBED);
  const resolveKey = vi.fn(async () => '');
  const localInstalled = vi.fn(async () => false);
  const deps: ResolveEmbedderDeps = {
    readPreference: async () => 'auto',
    resolveKey,
    localInstalled,
    buildOpenAi,
    buildLocal,
    buildGemma,
    buildHarrier,
    isOpenAiRecentlyExhausted: () => false, // not in cooldown by default (EI-3381) — its own describe block below covers the cooldown branch
    ...overrides,
  };
  return { deps, buildOpenAi, buildLocal, buildGemma, buildHarrier, resolveKey, localInstalled };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invalidateMemoryClient.mockClear();
  __resetOpenAiEmbedCooldownForTest();
  __resetEmbedExhaustionAlertForTest();
  mockAcquire.mockReset();
  mockAcquire.mockImplementation(async () => ({ release: () => {} }));
});

describe('markOpenAiEmbedFailure / isOpenAiEmbedInCooldown — the EI-3381 cooldown tracker', () => {
  it('is not in cooldown before any failure is marked', () => {
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(false);
  });

  it('is in cooldown at the instant a failure is marked, and stays in cooldown shortly after', () => {
    markOpenAiEmbedFailure(1_000_000);
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(true);
    expect(isOpenAiEmbedInCooldown(1_000_010)).toBe(true);
  });

  it('lapses well after the cooldown window (bounded, self-healing — never a permanent local pin)', () => {
    markOpenAiEmbedFailure(1_000_000);
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(false);
  });

  it('a second failure extends the cooldown from ITS OWN mark time (never shortens it)', () => {
    markOpenAiEmbedFailure(1_000_000);
    markOpenAiEmbedFailure(1_000_010); // fired again shortly after, e.g. two callers racing
    expect(isOpenAiEmbedInCooldown(1_000_010)).toBe(true);
  });

  it('EI-7279: invalidates the cached mem0 client so the cascade is re-evaluated on the VERY NEXT call, not up to an hour late (the client TTL)', () => {
    expect(invalidateMemoryClient).not.toHaveBeenCalled();
    markOpenAiEmbedFailure(1_000_000);
    expect(invalidateMemoryClient).toHaveBeenCalledTimes(1);
  });

  it('EI-7279: a second failure invalidates again (never leaves a stale client cached across repeated failures)', () => {
    markOpenAiEmbedFailure(1_000_000);
    markOpenAiEmbedFailure(1_000_010);
    expect(invalidateMemoryClient).toHaveBeenCalledTimes(2);
  });
});

describe('WI-3615 — hard exhaustion is STICKY (never thrashes a known-dead key)', () => {
  it('a soft failure (no `hard` flag) still lapses — unaffected by the sticky latch', () => {
    markOpenAiEmbedFailure(1_000_000); // no { hard: true } — the daily-cap / retry-budget shape
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(false);
  });

  it('a hard failure ({ hard: true }) does NOT lapse, arbitrarily far in the future', () => {
    markOpenAiEmbedFailure(1_000_000, { hard: true });
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(true);
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(true); // would have lapsed if soft
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999_999)).toBe(true); // still true, days later
  });

  it('the recurrence guard: N consecutive hard failures never un-stick the latch on their own (no external re-latching needed, no thrash)', () => {
    // The exact bug shape: cascade keeps calling markOpenAiEmbedFailure(hard) every time it
    // re-tries a dead key. Assert the latch stays set continuously across repeated marks —
    // there is no window where isOpenAiEmbedInCooldown reports false in between.
    for (let i = 0; i < 5; i++) {
      markOpenAiEmbedFailure(1_000_000 + i * 70_000, { hard: true }); // spaced past the old 60s window
      expect(isOpenAiEmbedInCooldown(1_000_000 + i * 70_000 + 65_000)).toBe(true);
    }
  });

  it('clearOpenAiEmbedHardExhaustion() clears the sticky latch (the ONLY way it clears)', () => {
    markOpenAiEmbedFailure(1_000_000, { hard: true });
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(true);
    clearOpenAiEmbedHardExhaustion();
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(false);
  });

  it('clearOpenAiEmbedHardExhaustion() does not touch an unrelated still-live SOFT cooldown', () => {
    markOpenAiEmbedFailure(1_000_000); // soft only
    clearOpenAiEmbedHardExhaustion(); // no-op — nothing sticky was set
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(true); // the soft cooldown is still live
  });

  it('is a no-op when the latch was never set (no crash, no state change)', () => {
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(false);
    clearOpenAiEmbedHardExhaustion();
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(false);
  });
});

describe('buildOpenAiEmbedder — caller cancellation', () => {
  it('cancels retry backoff without waiting for it or firing another attempt', async () => {
    __resetOpenAiEmbedCooldownForTest();
    const controller = new AbortController();
    const fetchM = vi.fn(async () => new Response('temporary fault', { status: 500 }));
    vi.stubGlobal('fetch', fetchM);
    const pending = buildOpenAiEmbedder('sk-test', { baseMs: 2000, rand: () => 0 })('retry backoff', controller.signal);
    await vi.waitFor(() => expect(fetchM).toHaveBeenCalledOnce());
    controller.abort(new Error('obsolete retry'));
    await expect(pending).rejects.toThrow('obsolete retry');
    expect(fetchM).toHaveBeenCalledOnce();
    expect(isOpenAiEmbedInCooldown()).toBe(false);
  });

  it('aborts the provider request without retrying or marking provider cooldown', async () => {
    __resetOpenAiEmbedCooldownForTest();
    mockAcquire.mockResolvedValue({ release: () => {} });
    const controller = new AbortController();
    const reason = new Error('obsolete memory request');
    const fetchM = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBeDefined();
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort(reason);
    }));
    vi.stubGlobal('fetch', fetchM);
    const sleep = vi.fn(async () => {});
    await expect(buildOpenAiEmbedder('sk-test', { sleep })('cancelled', controller.signal)).rejects.toBe(reason);
    expect(fetchM).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(isOpenAiEmbedInCooldown()).toBe(false);
  });

  it('releases late admission without starting a provider request', async () => {
    const controller = new AbortController();
    const release = vi.fn();
    let admit!: (slot: { release: () => void }) => void;
    mockAcquire.mockImplementationOnce(() => new Promise((resolve) => { admit = resolve; }));
    const fetchM = vi.fn();
    vi.stubGlobal('fetch', fetchM);
    const pending = buildOpenAiEmbedder('sk-test')('late admission', controller.signal);
    controller.abort(new Error('obsolete queue entry'));
    admit({ release });
    await expect(pending).rejects.toThrow('obsolete queue entry');
    expect(release).toHaveBeenCalledOnce();
    expect(fetchM).not.toHaveBeenCalled();
  });
});

describe('buildOpenAiEmbedder — owner alert on quota exhaustion', () => {
  it('alerts once on OpenAI insufficient_quota and clears the condition after a successful embed', async () => {
    const notify = vi.fn();
    const resolve = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify, resolve);

    const fetchM = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"type":"insufficient_quota"}}', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchM);

    const embed = buildOpenAiEmbedder('sk-test', { maxAttempts: 1, maxTotalWaitMs: 1000, sleep: async () => {} });
    await expect(embed('quota exhausted')).rejects.toThrow(/openai_embed_quota_exhausted/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      kind: 'openai_billing',
      conditionKey: 'embed-exhaustion:openai_billing',
    });

    await expect(embed('recovered')).resolves.toEqual([1, 2, 3]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toMatchObject({ conditionKey: 'embed-exhaustion:openai_billing' });
  });

  it('EI-7475: also escalates when the RETRY BUDGET exhausts (not just a hard insufficient_quota)', async () => {
    const notify = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify);

    // A transient 500 that never recovers within the (tiny, test) retry budget — exhausts
    // attempts without ever hitting the insufficient_quota branch.
    const fetchM = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));
    vi.stubGlobal('fetch', fetchM);

    const embed = buildOpenAiEmbedder('sk-test', { maxAttempts: 2, maxTotalWaitMs: 1000, sleep: async () => {} });
    await expect(embed('still down')).rejects.toThrow(/openai_embed_failed_500/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'openai_billing' });
  });

  it('EI-7596: our OWN daily spend cap (EmbedBudgetExhaustedError) starts the EI-3381 local-fallback cooldown, not just insufficient_quota', async () => {
    // Before the fix: the admission throw happened BEFORE the fetch/retry loop's own
    // markOpenAiEmbedFailure() calls, so this cooldown never engaged and every subsequent
    // memory:remember/update hard-failed for the rest of the UTC day even though local
    // (BGE-ONNX) was fully able to serve the request.
    mockAcquire.mockRejectedValueOnce(new EmbedBudgetExhaustedError('memory'));
    const fetchM = vi.fn(); // must NEVER be called — the cap throw happens before any HTTP attempt
    vi.stubGlobal('fetch', fetchM);

    expect(isOpenAiEmbedInCooldown()).toBe(false);
    const embed = buildOpenAiEmbedder('sk-test', { maxAttempts: 3, maxTotalWaitMs: 1000, sleep: async () => {} });
    await expect(embed('over budget')).rejects.toThrow(/embed_daily_budget_exhausted/);

    expect(fetchM).not.toHaveBeenCalled();
    expect(isOpenAiEmbedInCooldown()).toBe(true); // the NEXT resolveEmbedder() call now prefers local
  });

  it('EI-7596: a plain admission pass-through (no cap hit) does NOT start the cooldown', async () => {
    const fetchM = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchM);

    const embed = buildOpenAiEmbedder('sk-test', { maxAttempts: 1, maxTotalWaitMs: 1000, sleep: async () => {} });
    await expect(embed('fine')).resolves.toEqual([1, 2, 3]);
    expect(isOpenAiEmbedInCooldown()).toBe(false);
  });
});

describe('resolveEmbedderWith — the openai → local → disabled cascade (GAP 4)', () => {
  // The full truth table: 4 preferences × {key} × {local installed}. Each row
  // asserts the resolved {mode, reason} — the contract the store reads.
  type Row = {
    name: string;
    preference: 'auto' | 'openai' | 'local' | 'disabled';
    key: string;
    local: boolean;
    expectMode: 'openai' | 'local' | 'disabled';
    expectReason?: string;
  };

  const rows: Row[] = [
    // disabled is a HARD STOP — never touches key/local, regardless of state.
    { name: 'disabled + key + local', preference: 'disabled', key: 'sk', local: true, expectMode: 'disabled', expectReason: 'user_disabled' },
    { name: 'disabled + no key + no local', preference: 'disabled', key: '', local: false, expectMode: 'disabled', expectReason: 'user_disabled' },

    // openai forced: key present → openai; key absent → disabled with the
    // SPECIFIC reason (openai_forced_but_no_key), never a silent local fall.
    { name: 'openai forced + key', preference: 'openai', key: 'sk', local: true, expectMode: 'openai' },
    { name: 'openai forced + key (local absent — irrelevant)', preference: 'openai', key: 'sk', local: false, expectMode: 'openai' },
    { name: 'openai forced + NO key → disabled (forced reason, NOT local)', preference: 'openai', key: '', local: true, expectMode: 'disabled', expectReason: 'openai_forced_but_no_key' },
    { name: 'openai forced + NO key + no local', preference: 'openai', key: '', local: false, expectMode: 'disabled', expectReason: 'openai_forced_but_no_key' },

    // local forced: never consults the key; installed → local, else disabled
    // with the SPECIFIC reason (local_forced_but_not_installed).
    { name: 'local forced + installed', preference: 'local', key: '', local: true, expectMode: 'local' },
    { name: 'local forced + installed (key present — irrelevant)', preference: 'local', key: 'sk', local: true, expectMode: 'local' },
    { name: 'local forced + NOT installed → disabled (forced reason)', preference: 'local', key: 'sk', local: false, expectMode: 'disabled', expectReason: 'local_forced_but_not_installed' },

    // auto: openai FIRST, then local, then disabled.
    { name: 'auto + key → openai (prefers openai)', preference: 'auto', key: 'sk', local: true, expectMode: 'openai' },
    { name: 'auto + key + no local → still openai', preference: 'auto', key: 'sk', local: false, expectMode: 'openai' },
    { name: 'auto + no key + local → local fallback', preference: 'auto', key: '', local: true, expectMode: 'local' },
    { name: 'auto + no key + no local → disabled', preference: 'auto', key: '', local: false, expectMode: 'disabled', expectReason: 'no_openai_key_and_local_not_installed' },
  ];

  for (const row of rows) {
    it(`${row.name} → ${row.expectMode}${row.expectReason ? ` (${row.expectReason})` : ''}`, async () => {
      const { deps } = makeDeps({
        readPreference: async () => row.preference,
        resolveKey: async () => row.key,
        localInstalled: async () => row.local,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe(row.expectMode);
      if (row.expectReason !== undefined) {
        expect((res as { reason?: string }).reason).toBe(row.expectReason);
      }
      if (res.mode !== 'disabled') {
        // a resolved embedder always carries ITS MODE's declared width + an embed fn
        expect(res.dims).toBe(declaredDims(res.mode));
        expect(typeof res.embed).toBe('function');
      }
    });
  }

  it('disabled returns NO embed fn and NO dims (hard stop — store must not write)', async () => {
    const { deps, resolveKey, localInstalled, buildOpenAi, buildLocal } = makeDeps({
      readPreference: async () => 'disabled',
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'user_disabled' });
    expect('embed' in res).toBe(false);
    expect('dims' in res).toBe(false);
    // hard stop: the cascade never consults key/local/builders for disabled
    expect(resolveKey).not.toHaveBeenCalled();
    expect(localInstalled).not.toHaveBeenCalled();
    expect(buildOpenAi).not.toHaveBeenCalled();
    expect(buildLocal).not.toHaveBeenCalled();
  });

  it('auto prefers openai — builds the openai embedder and NEVER the local one when a key exists', async () => {
    const { deps, buildOpenAi, buildLocal, localInstalled } = makeDeps({
      readPreference: async () => 'auto',
      resolveKey: async () => 'sk-key',
      localInstalled: async () => true, // available, but openai wins
    });
    const res = await resolveEmbedderWith(deps);
    expect(res.mode).toBe('openai');
    expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
    expect(buildLocal).not.toHaveBeenCalled();
    // short-circuits before even probing local availability
    expect(localInstalled).not.toHaveBeenCalled();
  });

  it('openai-forced-but-no-key disables WITHOUT falling through to local (no wrong-table write)', async () => {
    const { deps, buildLocal, localInstalled } = makeDeps({
      readPreference: async () => 'openai',
      resolveKey: async () => '',
      localInstalled: async () => true, // local IS installed, but must NOT be used
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'openai_forced_but_no_key' });
    expect(buildLocal).not.toHaveBeenCalled();
    expect(localInstalled).not.toHaveBeenCalled();
  });

  it('local-forced never consults the openai key (forced means forced)', async () => {
    const { deps, resolveKey, buildOpenAi } = makeDeps({
      readPreference: async () => 'local',
      resolveKey: async () => 'sk-present',
      localInstalled: async () => true,
    });
    const res = await resolveEmbedderWith(deps);
    expect(res.mode).toBe('local');
    expect(resolveKey).not.toHaveBeenCalled();
    expect(buildOpenAi).not.toHaveBeenCalled();
  });

  it('gemma-forced resolves EmbeddingGemma (mode gemma, at its declared native width) via the local package', async () => {
    const { deps, buildGemma, buildLocal, buildOpenAi, resolveKey } = makeDeps({
      readPreference: async () => 'gemma',
      resolveKey: async () => 'sk-present',
      localInstalled: async () => true, // shares the @huggingface/transformers package
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toMatchObject({
      mode: 'gemma',
      dims: declaredDims('gemma'),
      profile: EMBEDDER_DIM_SPECS.gemma,
    });
    expect(buildGemma).toHaveBeenCalledOnce();
    // gemma is its OWN model — never the BGE ('local') or OpenAI builder
    expect(buildLocal).not.toHaveBeenCalled();
    expect(buildOpenAi).not.toHaveBeenCalled();
    expect(resolveKey).not.toHaveBeenCalled(); // forced means forced
  });

  it('gemma-forced-but-transformers-not-installed disables (no wrong-space write)', async () => {
    const { deps, buildGemma } = makeDeps({
      readPreference: async () => 'gemma',
      localInstalled: async () => false,
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'gemma_forced_but_transformers_not_installed' });
    expect(buildGemma).not.toHaveBeenCalled();
  });

  // Live 2026-07-10: frozen pre-gemma dist-host bundles read the freshly-flipped
  // 'gemma' pref — a mode THEIR build had never heard of — and fell through the
  // cascade's 'auto' tail onto the out-of-credit OpenAI key (alert storm; with
  // credit it would have been silent PAID embeddings in a foreign vector space).
  // An unknown stored mode is always a deliberate move to some NEWER embedder,
  // so an old build must read it as 'local': free, on-box, recoverable by
  // re-embed — never the paid cloud leg.
  it('an UNKNOWN preference (written by newer code) resolves as local-forced, never the auto→openai tail', async () => {
    const { deps, buildOpenAi, buildLocal } = makeDeps({
      readPreference: async () => 'some-future-mode' as never,
      resolveKey: async () => 'sk-present', // key available — the auto tail WOULD have taken it
      localInstalled: async () => true,
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toMatchObject({ mode: 'local', dims: declaredDims('local') });
    expect(buildLocal).toHaveBeenCalledOnce();
    expect(buildOpenAi).not.toHaveBeenCalled();
  });

  it('an UNKNOWN preference without the local package disables (still never openai)', async () => {
    const { deps, buildOpenAi } = makeDeps({
      readPreference: async () => 'some-future-mode' as never,
      resolveKey: async () => 'sk-present',
      localInstalled: async () => false,
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'local_forced_but_not_installed' });
    expect(buildOpenAi).not.toHaveBeenCalled();
  });

  describe('EI-3381 — auto prefers local during an OpenAI post-failure cooldown', () => {
    it('auto + key present + in cooldown + local installed → local (NOT openai)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key', // a valid key exists...
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true, // ...but openai just failed hard
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
      expect(buildLocal).toHaveBeenCalled();
      expect(buildOpenAi).not.toHaveBeenCalled();
    });

    it('auto + in cooldown + local NOT installed → still falls through to openai (no embedder left otherwise)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => false, // no local escape hatch available
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai'); // trying a possibly-still-bad key beats no embedder at all
      expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
      expect(buildLocal).not.toHaveBeenCalled();
    });

    it('auto + in cooldown + NO key + local installed → local (same as the no-key case, just reached via the cooldown leg)', async () => {
      const { deps, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => '',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
      expect(buildLocal).toHaveBeenCalled();
    });

    it('openai-FORCED preference ignores the cooldown entirely (an explicit override, not an auto pick)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'openai',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true, // must be irrelevant to a forced preference
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai');
      expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
      expect(buildLocal).not.toHaveBeenCalled();
    });

    it('local-FORCED preference is unaffected by cooldown state either way (already local, nothing to change)', async () => {
      const { deps } = makeDeps({
        readPreference: async () => 'local',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
    });

    it('auto + NOT in cooldown behaves exactly as before (openai wins when a key exists)', async () => {
      const { deps, buildOpenAi } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => false,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai');
      expect(buildOpenAi).toHaveBeenCalled();
    });
  });
});

describe('readEmbedderPreference — env override wiring (production seam)', () => {
  const ORIGINAL = process.env.PAPERCUSP_MEMORY_EMBEDDER;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAPERCUSP_MEMORY_EMBEDDER;
    else process.env.PAPERCUSP_MEMORY_EMBEDDER = ORIGINAL;
  });

  for (const v of EMBEDDER_PREFERENCES) {
    it(`PAPERCUSP_MEMORY_EMBEDDER=${v} overrides the persisted pref`, async () => {
      process.env.PAPERCUSP_MEMORY_EMBEDDER = v;
      await expect(readEmbedderPreference()).resolves.toBe(v);
    });
  }

  it('an unrecognized env value is ignored (falls through to the persisted pref / default)', async () => {
    process.env.PAPERCUSP_MEMORY_EMBEDDER = 'bogus';
    // With no PG-backed voice prefs in this unit env the cascade lands on the
    // voice-prefs DEFAULT (currently 'harrier'). The point is only that 'bogus'
    // is NOT returned — so assert against the full preference union, never a
    // hand-copied subset that silently reds when a default flips.
    const pref = await readEmbedderPreference();
    expect(pref).not.toBe('bogus');
    expect(EMBEDDER_PREFERENCES).toContain(pref);
  });
});

/**
 * THE REGRESSION GUARD for the VM-realm dynamic-import trap.
 *
 * `localAvailable()` answered the question "is @huggingface/transformers
 * installed?" with a dynamic import performed inside a `new Function` body — a
 * realm that, in some embedders (Vitest among them), has NO host dynamic-import
 * callback. The import then throws `A dynamic import callback was not specified`
 * whether or not the package exists, and the bare `catch` turns that into
 * `false`. Downstream, the cascade reports
 * `harrier_forced_but_transformers_not_installed` and the memory store silently
 * runs with NO EMBEDDER on a box where the package imports fine from node.
 *
 * Nothing caught it because every cascade test above injects `localInstalled` as
 * a seam, so the real function was never called under a test runner — the one
 * environment that reproduces the bug.
 *
 * The assertion is conditional on the package genuinely being importable, so
 * this stays honest (rather than brittle) in an environment that really lacks
 * it: the invariant under test is "reachable by a direct import ⇒ reported
 * available", never "this box has transformers installed".
 */
describe('localAvailable — must not report "not installed" for a VM-realm import failure', () => {
  it('reports true whenever the package is genuinely importable here', async () => {
    let importable = false;
    try {
      await import(/* @vite-ignore */ '@huggingface/transformers');
      importable = true;
    } catch {
      importable = false;
    }
    if (!importable) {
      // Genuinely absent — `false` is then the correct answer, and there is no
      // invariant left to test. Assert that much rather than silently passing.
      await expect(localAvailable()).resolves.toBe(false);
      return;
    }
    await expect(localAvailable()).resolves.toBe(true);
  }, 120_000);
});

describe('proseSurfacePreference — P-015 harrier is memory-side only', () => {
  it('maps harrier → gemma (prose/search surfaces stay in the gemma space)', () => {
    expect(proseSurfacePreference('harrier')).toBe('gemma');
  });

  // `local` joined harrier as a re-mapped mode when the prose columns moved to
  // gemma's native 768: bge-small is natively 384 with mrl:'none', so it CANNOT
  // emit the column width and is no longer prose-eligible at all. Left in the
  // pass-through set below it asserted the exact opposite of the contract.
  it('maps local → gemma (bge-small@384 cannot emit the prose column width)', () => {
    expect(proseSurfacePreference('local')).toBe('gemma');
  });

  for (const v of EMBEDDER_PREFERENCES.filter((p) => p !== 'harrier' && p !== 'local')) {
    it(`passes '${v}' through unchanged`, () => {
      expect(proseSurfacePreference(v)).toBe(v);
    });
  }
});
