/**
 * embed-backfill sweep — audit P-010 (EI-119/EI-80).
 *
 * Asserts the sweep runs on the SHARED org pool (getOrgPg — no per-sweep
 * pg.Client), that concurrent sweeps dedupe via the globalThis-pinned state
 * (A18), and that NULL-embedding rows get vectors written back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Seams ────────────────────────────────────────────────────────────
const unsafeCalls: Array<{ q: string; params?: unknown[] }> = [];
// Handler queue: each entry answers the next sql.unsafe call.
let unsafeResults: Array<unknown[]> = [];
// When set, the next sql.unsafe call awaits this gate before resolving —
// lets the concurrency test hold a sweep in flight deterministically.
let unsafeGate: Promise<void> | null = null;
// WI-7348: same idiom, one phase earlier. When set, embedder RESOLUTION blocks
// on this gate — the only way to reproduce a hang that happens before any row
// is read (and before getOrgPg), which is what `unsafeGate` cannot reach.
let voicePrefsGate: Promise<void> | null = null;

vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: {
      unsafe: async (q: string, params?: unknown[]) => {
        unsafeCalls.push({ q, params });
        if (unsafeGate) {
          const gate = unsafeGate;
          unsafeGate = null;
          await gate;
        }
        return unsafeResults.shift() ?? [];
      },
    },
  }),
}));

vi.mock('../voice-prefs', () => ({
  loadVoicePrefs: async () => {
    if (voicePrefsGate) await voicePrefsGate;
    return { memoryEmbedderMode: 'openai' };
  },
}));
vi.mock('../credentials', () => ({
  readCredentials: async () => ({ openai_api_key: 'test-key' }),
}));

import {
  runBackfillSweep,
  getLastBackfillResult,
  backfillTable,
  TARGETS,
  logMemoryVecOutcome,
  resetMemoryVecIdleLogState,
  MEMORY_VEC_IDLE_LOG_INTERVAL_MS,
  stalePredicateSql,
  profileColOf,
  recipeColOf,
  activeRecipeVersion,
  BASELINE_RECIPE_VERSION,
  __sweepStateForTest,
  resetSweepStateForTest,
  type BackfillTarget,
} from './embed-backfill';
// Import the width — the sweep writes into the prose columns, so a width change
// must move this fixture automatically rather than stranding it (384→768).
import { PROSE_VECTOR_DIMS } from './prose-vector-dims';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
// The default per-target cap is derived from the resource profile's batch size,
// so the WI-7111 test asserts against the real value rather than a literal that
// would silently stop testing anything if the profile changed.
import { getResourceProfile } from '../resource-profile';

// Reset THROUGH the module's own seam. Reaching for `globalThis[Symbol.for(...)]`
// targets the storage LOCATION rather than the module's state, so it keeps
// compiling and silently resets NOTHING once the state moves — which is exactly
// what a pinModuleState migration does (EI-19479108855357092).
function resetSweepState(): void {
  resetSweepStateForTest();
}

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

beforeEach(() => {
  unsafeCalls.length = 0;
  unsafeResults = [];
  voicePrefsGate = null;
  resetSweepState();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: VEC }] }),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runBackfillSweep (P-010)', () => {
  it('runs entirely on the shared org pool and writes vectors for NULL rows', async () => {
    // P-005: probe-ALL-then-drain. The queue is ext-probe, then one column-probe
    // per TARGET, then the round-robin drain.
    unsafeResults = [
      [{ extname: 'vector' }],            // pg_extension probe
      // target 1 (harness_escalations): column exists → the only live target
      [{ column_name: 'body_embedding' }],
      // the other targets: column missing → skipped. DERIVED from TARGETS (the
      // same rule the ordering test below already uses) because this fixture is
      // a POSITIONAL response queue: a hand-written count silently shifts every
      // later response by one the moment a target is added, and the failure
      // surfaces as an unrelated assertion ("stats[0] is the wrong table",
      // "update is undefined") rather than as "the fixture is stale".
      ...TARGETS.slice(1).map(() => []),
      // drain round 1 for harness_escalations
      [{ id: '(0,1)', body: 'escalation text' }],
      [],                                  // UPDATE (returns rows array)
      [],                                  // next batch → empty, loop ends
    ];

    const r = await runBackfillSweep();
    expect(Array.isArray(r)).toBe(true);
    const stats = r as Array<{ table: string; embedded: number }>;
    expect(stats[0]).toMatchObject({ table: 'harness_shared.harness_escalations', embedded: 1 });

    // Every query went through the mocked shared pool.
    expect(unsafeCalls.length).toBeGreaterThan(0);
    const update = unsafeCalls.find((c) => c.q.includes('UPDATE harness_shared.harness_escalations'));
    expect(update).toBeTruthy();
    expect(String(update!.params![0])).toMatch(/^\[0\.1,/); // vector literal
    expect(getLastBackfillResult()).toEqual(stats);
  });

  it('dedupes concurrent sweeps via the globalThis-pinned running flag (A18)', async () => {
    // Hold the first sweep in flight at its pg_extension probe.
    let release!: () => void;
    unsafeGate = new Promise<void>((res) => { release = res; });
    unsafeResults = [[], []]; // ext probe (sweep 1) → no extension → early exit

    const first = runBackfillSweep();
    // Give sweep 1 time to pass mode/embedder resolution and reach the gated
    // PG probe (dynamic imports take real event-loop turns).
    await new Promise((r) => setTimeout(r, 25));

    const second = await runBackfillSweep();
    expect(second).toEqual({ skipped: 'already_running' });

    release();
    const firstResult = await first;
    expect(Array.isArray(firstResult)).toBe(true); // ran to its early-exit result
  });

  it('takes over a STALE latch instead of deferring to a hung sweep forever (WI-7327)', async () => {
    // The regression: `running` was a bare boolean cleared only in a `finally`.
    // A sweep that THROWS reaches that finally; a sweep that HANGS never does —
    // and the flag is pinned to globalThis, so every later tick returned
    // `already_running` and the backfill was wedged until the host restarted.
    // Measured 2026-08-03: a sweep hung at 04:45:04Z, the next 9 ticks each
    // no-opped in ~265ms, and 451k rows stayed unembedded with ZERO log output.
    const state = __sweepStateForTest();

    // Simulate a sweep that took the latch and never gave it back.
    state.running = true;
    state.startedAt = Date.now() - 61 * 60 * 1000; // older than the 60-min ceiling

    unsafeResults = [[]]; // ext probe → no vector extension → clean early exit

    // Precondition: we really are holding the latch the module reads.
    expect(state.running).toBe(true);
    expect(state.startedAt).toBeLessThan(Date.now() - 60 * 60 * 1000);

    const result = await runBackfillSweep();

    // It must RUN, not skip: a holder this old is gone, not slow.
    expect(result).not.toEqual({ skipped: 'already_running' });
    expect(Array.isArray(result)).toBe(true);
    // And the latch must be re-stamped and released cleanly, so the NEXT sweep
    // is judged on its own start time rather than inheriting a dead one.
    expect(state.running).toBe(false);
    expect(state.startedAt).toBeNull();
    // (The takeover also warns loudly; that log is allowlisted in
    // libs/test-config console-noise-filter — an in-test spy does not reliably
    // catch it under the forks pool, so behaviour is what we assert here.)
  });

  it('still defers to a FRESH in-flight sweep (the stale ceiling must not break dedupe)', async () => {
    // Guard the other direction: the WI-7327 takeover must fire ONLY on a hang.
    // A ceiling that is too eager would let two sweeps run concurrently and
    // double-embed, which is the bug the latch exists to prevent.
    const state = __sweepStateForTest();

    // 20 MINUTES — deliberately longer than a naive "surely a sweep is done by
    // now" guess. Measured 2026-08-03: consecutive HEALTHY sweeps took 14.5min
    // and 15.3min against the real backlog. An earlier draft of this fix set the
    // ceiling at 15min, which would have declared both of those dead and run a
    // second sweep alongside them. This case fails if anyone re-lowers it.
    state.running = true;
    state.startedAt = Date.now() - 20 * 60 * 1000;

    const result = await runBackfillSweep();
    expect(result).toEqual({ skipped: 'already_running' });

    state.running = false;
    state.startedAt = null;
  });

  // ── WI-2905: sweep fairness (no table can starve the shared daily budget) ──

  it('caps one table at maxRows per sweep instead of draining until the budget dies (WI-2905)', async () => {
    // A target with an endless NULL backlog: every SELECT returns a full batch.
    // With maxRows=4 the sweep must stop after scanning 4 rows (2 batches of 2)
    // and NEVER issue a third SELECT — pre-fix it looped until budget exhaustion.
    const rows = [
      { k0: 'a', body: 'one' },
      { k0: 'b', body: 'two' },
    ];
    unsafeResults = [
      [...rows], [], [],       // batch 1 (2 rows) + its 2 UPDATEs
      [...rows], [], [],       // batch 2 (2 rows) + its 2 UPDATEs
      [...rows],               // would-be batch 3 — must never be consumed
    ];
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql as unknown as Parameters<typeof backfillTable>[0];
    const stats = await backfillTable(sql, { table: 'harness_shared.session_turns', embedCol: 'text_embedding', bodySql: 'text', keyCols: ['id'] }, { embed: async () => VEC, maxRows: 4, mode: 'openai' });
    expect(stats.scanned).toBe(4);
    expect(stats.embedded).toBe(4);
    const selects = unsafeCalls.filter((c) => c.q.trimStart().startsWith('SELECT'));
    expect(selects).toHaveLength(2); // 2 batches, then the cap — no 3rd pull
    // The second pull shrank its LIMIT to the remaining allowance.
    expect(selects[1]!.params![0]).toBe(2);
  });

  it('rotates which target leads each sweep so budget priority round-robins (WI-2905)', async () => {
    // Two sweeps, vector ext present, every column probe returns "missing" so
    // each sweep is just its TARGETS.length ordered column probes — enough to
    // observe order. Derived from TARGETS so adding a target never silently
    // starves sweep 2's ext probe again (EI-9318 — two agents paid the
    // "expected undefined" debugging round-trip before this).
    unsafeResults = [
      [{ extname: 'vector' }], ...TARGETS.map(() => []),
      [{ extname: 'vector' }], ...TARGETS.map(() => []),
    ];
    await runBackfillSweep();
    const probesSweep1 = unsafeCalls
      .filter((c) => c.q.includes('information_schema.columns'))
      .map((c) => c.params![0]);
    unsafeCalls.length = 0;
    await runBackfillSweep();
    const probesSweep2 = unsafeCalls
      .filter((c) => c.q.includes('information_schema.columns'))
      .map((c) => c.params![0]);

    expect(probesSweep1[0]).toBe('harness_shared.harness_escalations'); // offset 0
    expect(probesSweep2[0]).toBe('harness_shared.harness_brainstorm');  // offset 1
    // Same SET of targets either way — rotation never drops one.
    expect([...probesSweep1].sort()).toEqual([...probesSweep2].sort());
    // And the RESULT order stays canonical regardless of sweep order.
    const last = getLastBackfillResult()!;
    expect(last[0]!.table).toBe('harness_shared.harness_escalations');
  });

  /**
   * WI-7111 — `maxRowsPerTarget` threads to the per-target ceiling so a BULK
   * REFILL is not cap-bound at the WI-2905 fairness cap.
   *
   * Why this needs pinning: a prose width change (migration 727: 384→768) drops
   * every stored vector, because pgvector cannot cast between widths. Refilling
   * ~500k rows through the fairness cap takes 2-5 DAYS for session_turns alone
   * (EI-19375205903428632), with semantic search lexical-only throughout. The
   * regression this guards is silent — a refill that "works" but at trickle
   * speed looks identical to a working sweep, and is only distinguishable by
   * the LIMIT the batch pull asks for.
   */
  it('threads maxRowsPerTarget to the batch LIMIT, leaving the default cap intact (WI-7111)', async () => {
    // Reach the first target's batch pull, then end the loop immediately: the
    // LIMIT of that first pull is the whole observable.
    const reachFirstBatchPull = () => [
      [{ extname: 'vector' }],              // pg_extension probe
      [{ column_name: 'body_embedding' }],  // target 1 column probe (no mode col → spaceAware false)
      [],                                   // batch pull → empty, per-target loop ends
      ...TARGETS.slice(1).map(() => []),    // remaining targets: column missing → skipped
    ];
    const firstBatchLimit = () =>
      unsafeCalls.find((c) => c.q.includes('LIMIT $1'))!.params![0];

    // Explicit bulk ceiling, deliberately below BATCH_SIZE so it is the binding
    // constraint (the pull asks for min(BATCH_SIZE, remaining)).
    unsafeResults = reachFirstBatchPull();
    await runBackfillSweep({ maxRowsPerTarget: 3 });
    expect(firstBatchLimit()).toBe(3);

    // Default is unchanged: the routine scheduler calls this with no arguments
    // and must still get the WI-2905 fairness cap, whose first pull is a full
    // BATCH_SIZE (cap = BATCH_SIZE * 4, so min(BATCH_SIZE, cap) === BATCH_SIZE).
    unsafeCalls.length = 0;
    resetSweepState();
    unsafeResults = reachFirstBatchPull();
    await runBackfillSweep();
    expect(firstBatchLimit()).toBe(getResourceProfile().embedBatchSize);
  });
});

/**
 * WI-3616 — the embedding SPACE discriminator (migration 530).
 *
 * The bug these pin: `memoryEmbedderMode` selects the embedder at runtime AND drives
 * the query-side vector. Flipping it left every already-stored vector in a foreign
 * 384-D space. Because the sweep only ever looked for `embedding IS NULL`, those rows
 * were never revisited — the column silently mixed OpenAI and BGE vectors forever and
 * search returned noise (measured: a row's own exact text ranked #6574 of 8383).
 */
describe('embedder-resolution deadline (WI-7348)', () => {
  const sweepState = () => __sweepStateForTest();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws instead of hanging forever when embedder RESOLUTION never returns', async () => {
    vi.useFakeTimers();
    // Never resolved: reproduces the measured 2026-08-03 hang, which sat 55min
    // inside pass 1 before any row was read — no DB connection, no socket.
    voicePrefsGate = new Promise<void>(() => {});

    const p = runBackfillSweep();
    const assertion = expect(p).rejects.toThrow(/embedder_resolve_timeout_after_60000ms/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('RELEASES the sweep latch when resolution times out, so backfill is not disabled forever', async () => {
    vi.useFakeTimers();
    voicePrefsGate = new Promise<void>(() => {});

    const p = runBackfillSweep();
    const assertion = expect(p).rejects.toThrow(/embedder_resolve_timeout_after_60000ms/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // THE regression property. A hang never reached the `finally` that clears
    // `running`, and the state is pinned to globalThis — so one wedged resolve
    // silently disabled ALL future backfill until the much-later stale-latch
    // ceiling expired. Converting the hang into a throw makes the existing
    // `finally` do the work, which is why this is a fix and not a second backstop.
    expect(sweepState()?.running).toBe(false);
    expect(sweepState()?.startedAt).toBeNull();
  });

  it('announces the start and the resolved embedder, so silence is always a fault', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      // No vector extension -> the sweep returns early, but only AFTER both
      // heartbeat lines. That is the point: the shortest possible successful
      // path still says it ran.
      unsafeResults = [[]];
      await runBackfillSweep();
    } finally {
      spy.mockRestore();
    }

    expect(logs.some((l) => l.includes('sweep starting: resolving embedder'))).toBe(true);
    expect(logs.some((l) => l.includes('embedder resolved: mode='))).toBe(true);
  });
});

describe('embedding-space discriminator (WI-3616)', () => {
  const TARGET = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };

  /** Minimal `sql` double: records calls, replays queued results. */
  function fakeSql(results: unknown[][]) {
    const calls: Array<{ q: string; params?: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params?: unknown[]) => {
        calls.push({ q, params });
        return results.shift() ?? [];
      },
    };
    return { sql: sql as never, calls };
  }

  const embed = async (): Promise<number[]> => VEC;

  it('re-embeds a row whose recorded space differs from the active embedder', async () => {
    // One stale row (its vector is non-NULL but was made by openai), then empty.
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'hello world' }], [], []]);

    const stats = await backfillTable(sql, TARGET, { embed: embed, maxRows: 10, mode: 'local', spaceAware: true });

    // It was NOT skipped just because text_embedding was already non-NULL.
    expect(stats.embedded).toBe(1);

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    // NULL-safe comparison: `mode <> 'local'` is NULL for pre-530 rows and would
    // match nothing, silently reintroducing the original bug.
    expect(select.q).toContain('IS DISTINCT FROM $2');
    expect(select.q).toContain('text_embedding IS NULL OR');
    // P-005: $3 is the failure-skip OFFSET (0 on the first pull — nothing has
    // failed yet). It is bound on every pull so the placeholder count is stable.
    expect(select.params).toEqual([10, 'local', 0]);

    // The vector and the space it belongs to are written together — a row can
    // never advertise a space it is not actually in.
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).toContain('text_embedding_mode = $2');
    expect(update.q).toContain('IS DISTINCT FROM $2'); // re-asserted guard
    expect(update.params![1]).toBe('local');
    expect(update.params![2]).toBe('row-1'); // PK shifted to $3
  });

  it('stamps the active mode so a converged column stops being re-swept', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'x' }], [], []]);
    await backfillTable(sql, TARGET, { embed: embed, maxRows: 10, mode: 'openai', spaceAware: true });
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.params![1]).toBe('openai');
  });

  it('legacy DB without migration 530: never binds a parameter the SQL does not use', async () => {
    // Postgres derives the parameter COUNT from the highest $n referenced and rejects a
    // Bind that supplies an unused one ("could not determine data type of parameter $2").
    // The legacy path must therefore omit `mode` entirely — not just skip reading it.
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'x' }], [], []]);

    await backfillTable(sql, TARGET, { embed: embed, maxRows: 10, mode: 'local', spaceAware: false });

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).not.toContain('_mode');
    // No mode bound — but the P-005 OFFSET still is, at $2 instead of $3.
    expect(select.params).toEqual([10, 0]);

    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).not.toContain('_mode');
    expect(update.q).toContain('text_embedding IS NULL');
    expect(update.params).toEqual([`[${VEC.join(',')}]`, 'row-1']); // PK back at $2
  });

  it('sweep turns space-awareness on only when the discriminator column exists', async () => {
    // P-005 reordered the sweep: ALL targets are schema-probed first, THEN drained
    // round-robin. So the queue is ext-probe, 10 column-probes, then the drain.
    unsafeResults = [
      [{ extname: 'vector' }],
      // harness_escalations: BOTH the vector column and its _mode column exist.
      [{ column_name: 'body_embedding' }, { column_name: 'body_embedding_mode' }],
      // The other TARGETS probe as column-missing → skipped, never drained.
      // Derived, not hand-counted — see the note on the first sweep fixture.
      ...TARGETS.slice(1).map(() => []),
      // Drain round 1 for harness_escalations: batch, UPDATE, then empty.
      [{ k0: 'h', k1: 'p', body: 'escalation text' }],
      [],
      [],
    ];

    await runBackfillSweep();

    const update = unsafeCalls.find((c) => c.q.includes('UPDATE harness_shared.harness_escalations'))!;
    expect(update.q).toContain('body_embedding_mode = $2');
    expect(update.params![1]).toBe('openai'); // the mocked active mode
  });
});

describe('exact embedding-profile discriminator (P-003)', () => {
  const TARGET: BackfillTarget = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };

  function fakeSql(results: unknown[][]) {
    const calls: Array<{ q: string; params?: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params?: unknown[]) => {
        calls.push({ q, params });
        return results.shift() ?? [];
      },
    };
    return { sql: sql as never, calls };
  }

  it('keeps exact profile identity separate from legacy mode and text recipe', () => {
    expect(profileColOf(TARGET)).toBe('text_embedding_profile');
    expect(profileColOf(TARGET)).not.toBe('text_embedding_mode');
    expect(profileColOf(TARGET)).not.toBe('text_embedding_recipe');
  });

  it('accepts a mode-only legacy row only for that mode\'s current profile', () => {
    const predicate = stalePredicateSql(TARGET, true, '$2', null, {
      profileExpr: '$3',
      legacyModeCompatible: true,
    });
    expect(predicate).toContain('text_embedding_profile IS NOT DISTINCT FROM $3');
    expect(predicate).toContain('text_embedding_profile IS NULL');
    expect(predicate).toContain('text_embedding_mode IS NOT DISTINCT FROM $2');

    // Mutation/control: the same-mode alternate profile cannot use the legacy
    // branch. It has to match an exact stored id or the row is stale.
    const alternate = stalePredicateSql(TARGET, true, '$2', null, {
      profileExpr: '$3',
      legacyModeCompatible: false,
    });
    expect(alternate).toBe(
      '(text_embedding IS NULL OR text_embedding_profile IS DISTINCT FROM $3)',
    );
    expect(alternate).not.toContain('text_embedding_mode');
  });

  it('writes vector, legacy mode and exact profile atomically without re-deriving identity', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'x' }], [], []]);
    const stats = await backfillTable(sql, TARGET, { embed: async () => VEC, maxRows: 10, mode: 'gemma', spaceAware: true, profileColPresent: true,
      profile: EMBEDDER_DIM_SPECS.gemma });
    expect(stats.embedded).toBe(1);

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.params).toEqual([
      10,
      'gemma',
      EMBEDDER_DIM_SPECS.gemma.profileId,
      0,
    ]);
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).toContain('text_embedding_mode = $2');
    expect(update.q).toContain('text_embedding_profile = $3');
    expect(update.params).toEqual([
      `[${VEC.join(',')}]`,
      'gemma',
      EMBEDDER_DIM_SPECS.gemma.profileId,
      'row-1',
    ]);
  });

  it('fails closed when a profile-aware target is called without exact profile identity', async () => {
    const { sql, calls } = fakeSql([]);
    await expect(
      backfillTable(sql, TARGET, { embed: async () => VEC, maxRows: 10, mode: 'gemma', spaceAware: true, profileColPresent: true }),
    ).rejects.toThrow(/requires an exact embedding profile/);
    expect(calls).toEqual([]);
  });
});

/**
 * P-026 / D-087 — the TEXT-RECIPE discriminator (migration 777).
 *
 * `<embedCol>_mode` says which EMBEDDER made a vector and nothing about WHICH TEXT went
 * in, so editing a `bodySql` used to mark nothing stale. These cover the second axis, and
 * three of them exist because the feature's failure modes are all SILENT: introducing the
 * column must re-embed NOTHING (a false positive costs ~28h of sidecar), the UPDATE guard
 * must accept every row the SELECT calls stale (a false negative re-embeds one row
 * forever), and coverage must bind the SAME version (or it reads 0% and blames the sweep).
 */
describe('text-recipe discriminator (P-026 / D-087)', () => {
  const TARGET: BackfillTarget = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };
  const V2: BackfillTarget = { ...TARGET, recipeVersion: 2 };

  function fakeSql(results: unknown[][]) {
    const calls: Array<{ q: string; params?: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params?: unknown[]) => {
        calls.push({ q, params });
        return results.shift() ?? [];
      },
    };
    return { sql: sql as never, calls };
  }
  const embed = async (): Promise<number[]> => VEC;
  const oneRow = (): unknown[][] => [[{ k0: 'row-1', body: 'x' }], [], []];

  it('is SEPARATE from the mode column — a recipe bump must be invisible to query-time readers', () => {
    // The whole of D-087. Four readers equality-match `<embedCol>_mode`
    // (work-items.ts:1256/:1318, plans/semantic-leg.ts:77, doc-section-overlap.ts:179/:213),
    // so folding a recipe token into it (`gemma#r2`) matches ZERO rows there — the semantic
    // leg silently returns empty and the corpus leg degrades to lexical-only.
    expect(recipeColOf(TARGET)).toBe('text_embedding_recipe');
    expect(recipeColOf(TARGET)).not.toContain('_mode');
  });

  it('applies ONLY when the target declares a version AND the column exists', () => {
    expect(activeRecipeVersion(V2, true)).toBe(2);
    expect(activeRecipeVersion(V2, false)).toBeNull(); // migration 777 not run here
    expect(activeRecipeVersion(TARGET, true)).toBeNull(); // surface has not opted in
    expect(activeRecipeVersion(TARGET, false)).toBeNull();
  });

  it('INTRODUCING the discriminator re-embeds nothing: an undeclared target keeps the pre-777 predicate', async () => {
    // The expensive false positive. If the column merely EXISTING made rows stale, deploying
    // migration 777 would re-embed the whole corpus (~28h of sidecar) for no change in what
    // is embedded. Same SQL and the same binds as before 777.
    const { sql, calls } = fakeSql(oneRow());
    await backfillTable(sql, TARGET, { embed: embed, maxRows: 10, mode: 'local', spaceAware: true, recipeColPresent: true });

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).not.toContain('_recipe');
    expect(select.params).toEqual([10, 'local', 0]);
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).not.toContain('_recipe');
    expect(update.params![2]).toBe('row-1'); // PK still at $3
  });

  it('reads a NULL recipe as the baseline version, so pre-777 rows are not stale at v1', () => {
    // A row embedded before the column existed is not of UNKNOWN recipe — it was made by
    // the bodySql in force at the time, which IS recipe 1. Comparing raw (NULL IS DISTINCT
    // FROM 1 → true) would mark the entire existing population stale at version 1, which is
    // the same 28h false positive arriving through the predicate instead of the probe.
    expect(BASELINE_RECIPE_VERSION).toBe(1);
    const sql = stalePredicateSql(V2, true, '$2', '$3');
    expect(sql).toContain(`coalesce(text_embedding_recipe, ${BASELINE_RECIPE_VERSION})`);
    expect(sql).toContain('IS DISTINCT FROM $3');
  });

  it('a declared bump makes the existing population stale and stamps the new version', async () => {
    const { sql, calls } = fakeSql(oneRow());
    const stats = await backfillTable(sql, V2, { embed: embed, maxRows: 10, mode: 'local', spaceAware: true, recipeColPresent: true });
    expect(stats.embedded).toBe(1);

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).toContain('coalesce(text_embedding_recipe, 1) IS DISTINCT FROM $3');
    // $1 batch · $2 mode · $3 recipe · $4 failure offset — every one referenced.
    expect(select.params).toEqual([10, 'local', 2, 0]);

    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).toContain('text_embedding_recipe = $3');
    expect(update.params![2]).toBe(2);
    expect(update.params![3]).toBe('row-1'); // PK shifted to $4
  });

  it('degrades to the pre-777 predicate when the column is absent, rather than throwing', async () => {
    // Migration 777 is per-table on purpose, so "declared but absent" is an ordinary state
    // (a surface that opted in, on a database where only other surfaces were migrated).
    const { sql, calls } = fakeSql(oneRow());
    await backfillTable(sql, V2, { embed: embed, maxRows: 10, mode: 'local', spaceAware: true, recipeColPresent: false });
    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).not.toContain('_recipe');
    expect(select.params).toEqual([10, 'local', 0]);
  });

  it('never binds a parameter the SQL does not use, in any combination of the two discriminators', async () => {
    // Postgres derives the parameter COUNT from the highest $n referenced and rejects an
    // unused bind. With TWO optional terms there are four layouts, and the two that only
    // occur on a partially-migrated database are exactly the ones nothing else covers.
    const { sql, calls } = fakeSql(oneRow());
    await backfillTable(sql, V2, { embed: embed, maxRows: 10, mode: 'local', spaceAware: false, recipeColPresent: true });
    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).not.toContain('_mode');
    expect(select.q).toContain('coalesce(text_embedding_recipe, 1) IS DISTINCT FROM $2');
    expect(select.params).toEqual([10, 2, 0]); // $1 batch · $2 recipe · $3 offset

    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).not.toContain('_mode');
    expect(update.q).toContain('text_embedding_recipe = $2');
    expect(update.params).toEqual([`[${VEC.join(',')}]`, 2, 'row-1']); // PK at $3
  });

  it('work_items ships the Tier 0 ref expansion AND the version bump that makes it retroactive — the two are one change', () => {
    // The pairing IS the contract, and either half alone is a silent no-op:
    //   • expansion without a bump ⇒ only rows written from now on are enriched, and the
    //     ~36.6k existing vectors keep the old recipe forever — the exact defect P-026 was
    //     opened to remove, restored while looking finished.
    //   • bump without the expansion ⇒ a gratuitous ~2.2h re-embed onto identical text.
    // Nothing else can catch this: both halves are valid SQL/TS on their own.
    const wi = TARGETS.find((t) => t.table === 'harness_shared.work_items')!;
    expect(wi.bodySql).toContain('[refs] ');
    expect(wi.recipeVersion).toBeGreaterThanOrEqual(2);

    // The ref grammar must see MODERN ids. `[0-9]{2,5}` does not truncate a 17-digit
    // EI — the trailing \y fails mid-number and it matches NOTHING, so a narrow range
    // silently drops the whole class (the JS sibling still has it: WI-37523).
    const range = wi.bodySql.match(/\[0-9\]\{(\d+),(\d+)\}/);
    expect(range, 'work_items bodySql lost its ref pattern').not.toBeNull();
    expect(Number(range![2])).toBeGreaterThanOrEqual(20);

    // Resolution is scoped to the SAME harness. The PK is (harness_slug, feature_id), so
    // an unscoped join can bind a ref to another tenant's item and embed a confidently
    // wrong title into the vector.
    expect(wi.bodySql).toContain('w2.harness_slug = work_items.harness_slug');
  });

  it('P-006: work_items orderBySql boosts the open-lane (dedup-corpus) population ahead of plain recency', () => {
    // silent-intake-central-resolution-2026-09-01 P-006: the whole-corpus resolver needs
    // embeddings on open-lane rows to compute cosine edges at all; a pure updated_ts order
    // starves an old-but-still-open row behind every recently-touched terminal/observation
    // row in the 36k+ table. The boost predicate must be the SAME population the resolver
    // itself reads (work-items-admission-census.ts corpusWhere) or the two can silently
    // diverge on what "open lane" means.
    const wi = TARGETS.find((t) => t.table === 'harness_shared.work_items')!;
    expect(wi.orderBySql).toBeDefined();
    expect(wi.orderBySql).toContain("lane IS DISTINCT FROM 'observation'");
    expect(wi.orderBySql).toContain('NOT harness_shared.work_item_status_is_terminal(status)');
    // The boost is a PREFIX ahead of the prior recency order, not a replacement for it —
    // every row outside the boosted population (and ties within it) must still fall back
    // to updated_ts DESC, so this does not silently reorder the rest of the table.
    const order = wi.orderBySql!;
    expect(order.indexOf('work_item_status_is_terminal')).toBeLessThan(order.indexOf('updated_ts DESC'));
    expect(order).toMatch(/\)\s*DESC,\s*updated_ts DESC$/);
  });

  it("the UPDATE guard accepts every row the SELECT calls stale — the sweep's convergence invariant", async () => {
    // THE failure this feature could introduce, and it is invisible: if the write guard is
    // narrower than the selector, the row is selected as stale, the UPDATE matches nothing,
    // the row stays stale, and every later pull re-selects and re-embeds it — burning tokens
    // forever while `stats.embedded` cheerfully counts successes. Both predicates must be
    // the SAME expression; only their placeholder positions differ.
    const { sql, calls } = fakeSql(oneRow());
    await backfillTable(sql, V2, { embed: embed, maxRows: 10, mode: 'local', spaceAware: true, recipeColPresent: true });
    const norm = (s: string): string => s.replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim();
    // Both statements bind mode at $2 and recipe at $3, so after normalising placeholders
    // the predicate is literally the same string on both sides.
    const expected = norm(stalePredicateSql(V2, true, '$2', '$3'));
    const selectQ = norm(calls.find((c) => c.q.includes('SELECT'))!.q);
    const updateQ = norm(calls.find((c) => c.q.includes('UPDATE'))!.q);

    expect(selectQ).toContain(expected);
    // ENDS WITH, not merely contains: the guard must be the WHOLE staleness predicate and
    // the last thing in the statement. `toContain` is too weak to be worth writing here —
    // the mode-only predicate is a SUB-expression of the recipe-aware one, so a guard that
    // never learned about recipes would satisfy a containment check while still failing to
    // match the very rows the SELECT hands it.
    expect(updateQ.endsWith(expected)).toBe(true);

    // FALSIFIABILITY CONTROL: the guard this replaced (mode-only, hand-restated) against the
    // same assertion. It must FAIL — otherwise the check above proves nothing.
    const narrower = norm(`(text_embedding IS NULL OR text_embedding_mode IS DISTINCT FROM $2)`);
    expect(narrower).not.toBe(expected);
    expect(updateQ.endsWith(narrower)).toBe(false);
  });
});

/**
 * The N of every `left(<expr>, N)` in `sql`, with `<expr>` matched by BALANCED
 * parentheses (string literals skipped), so the capped expression may nest calls to
 * any depth. A fixed-depth regex silently missed `left(concat_ws(E'\n',
 * nullif(header, ''), content), 2000)` — a correctly capped body read as uncapped.
 */
function leftCapsOf(sql: string): number[] {
  const caps: number[] = [];
  for (const m of sql.matchAll(/\bleft\(/gi)) {
    let depth = 1;
    let lastTopComma = -1;
    let i = (m.index ?? 0) + m[0].length;
    for (; i < sql.length && depth > 0; i++) {
      const c = sql[i];
      if (c === "'") {
        i++;
        while (i < sql.length) {
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              i += 2;
              continue;
            }
            break;
          }
          i++;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 1) lastTopComma = i;
    }
    if (depth !== 0 || lastTopComma < 0) continue;
    const n = sql.slice(lastTopComma + 1, i - 1).trim();
    if (/^\d+$/.test(n)) caps.push(Number(n));
  }
  return caps;
}

describe('leftCapsOf — the EI-12967 guard instrument', () => {
  it('finds the cap through nested calls and string literals', () => {
    expect(leftCapsOf(`left(concat_ws(E'\\n', nullif(header, ''), content), 2000)`)).toEqual([2000]);
    expect(leftCapsOf(`left(concat_ws(')', a), 10)`)).toEqual([10]);
    expect(leftCapsOf(`left(coalesce(a, ''), 500) || ' ' || left(b, 300)`)).toEqual([500, 300]);
    expect(leftCapsOf('LEFT(body, 4000)')).toEqual([4000]);
  });

  it('CONTROL: an uncapped body yields no cap, so the guard below can fail', () => {
    expect(leftCapsOf('body')).toEqual([]);
    expect(leftCapsOf(`coalesce(title, '') || ' ' || body`)).toEqual([]);
    expect(leftCapsOf(`left(body)`)).toEqual([]);
  });
});

describe('every TARGETS bodySql caps its free-text input (EI-12967)', () => {
  // The sidecar hard-rejects any text over 32000 chars with an UNRETRYABLE 400 — a row
  // whose embed input has no cap stays `embedCol IS NULL` forever and gets re-selected
  // (and re-fails) by every future sweep tick. harness_escalations/harness_brainstorm/
  // operator_turns/harness_decisions shipped with NO cap at all (live: 392 operator_turns
  // rows + 9 harness_escalations rows over 32000 chars, one re-failing every ~5min since
  // 2026-07-16) while every other target already used the `left(…, 2000)` convention.
  // This is the recurrence guard: a future target (or a re-edit of one of these) that
  // forgets the cap fails HERE instead of silently retry-looping in production.
  it('wraps every bodySql column reference in left(…, N) for N <= 2000', () => {
    for (const target of TARGETS) {
      // A bodySql that is just a bare column name (no left(), no COALESCE-of-a-literal)
      // is the exact shape that caused EI-12967 — every target must at minimum cap via
      // left(<col-or-coalesce>, N). Constant/short expressions (verb, titles) are fine
      // uncapped; every target below DOES reference a free-text column, so demand a cap
      // present somewhere in the expression.
      // The capped argument may be a bare column or ANY expression, nested to any depth —
      // COALESCE(…), or concat_ws(E'\n', nullif(header, ''), content) for a header +
      // content body (harness_shared.text_chunks) — the property is that the whole embed
      // input sits inside a left(…, N), not which function builds it.
      const leftCaps = leftCapsOf(target.bodySql);
      expect(leftCaps.length, `${target.table}.bodySql has no left(…, N) cap: ${target.bodySql}`).toBeGreaterThan(0);
      for (const n of leftCaps) {
        expect(n, `${target.table}.bodySql cap exceeds 2000: ${target.bodySql}`).toBeLessThanOrEqual(2000);
      }
    }
  });
});

/**
 * EI-19409840792445272 — the memory-vec leg used to log ONLY when
 * `embedded > 0 || failed > 0`, which made three states byte-identical and silent:
 * healthy-idle, a predicate matching nothing, and a disabled embedder. Two of those
 * are total outages of semantic recall.
 *
 * The property under test is NOT the message wording — it is that the states are
 * DISTINGUISHABLE from outside, and that a healthy system stays quiet enough that
 * the loud cases still read as loud.
 */
describe('logMemoryVecOutcome — silent-failure discrimination', () => {
  function capture() {
    const lines: Array<{ level: 'log' | 'warn'; text: string }> = [];
    return {
      lines,
      sink: {
        log: (...a: unknown[]) => lines.push({ level: 'log', text: a.join(' ') }),
        warn: (...a: unknown[]) => lines.push({ level: 'warn', text: a.join(' ') }),
      } as Pick<Console, 'log' | 'warn'>,
    };
  }

  beforeEach(() => resetMemoryVecIdleLogState());

  it('a disabled embedder is LOUD — the most dangerous state must never be silent', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' }, 0, sink);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].text).toMatch(/DISABLED/);
  });

  it('an empty vector space WITH recallable rows is LOUD, and repeats every tick (it cannot self-heal)', () => {
    const { lines, sink } = capture();
    const totalFailure = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'gemma',
      table: 'memory_vec_gemma',
      zeroYield: { vectorSpaceEmpty: true, canonicalHasRows: true },
    };
    logMemoryVecOutcome(totalFailure, 0, sink);
    logMemoryVecOutcome(totalFailure, 1000, sink);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.level === 'warn')).toBe(true);
    expect(lines[0].text).toMatch(/TOTAL FAILURE/);
    // It must name the table — the whole point is answering "which space is empty?"
    expect(lines[0].text).toContain('memory_vec_gemma');
  });

  it('a HEALTHY idle sweep is quiet after its first line — and is NOT confusable with the failure above', () => {
    const { lines, sink } = capture();
    const healthy = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    };
    logMemoryVecOutcome(healthy, 0, sink);
    logMemoryVecOutcome(healthy, 60_000, sink);
    logMemoryVecOutcome(healthy, 120_000, sink);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('log');
    expect(lines[0].text).not.toMatch(/TOTAL FAILURE|DISABLED/);
  });

  it('names the ACTIVE table on the idle line — the line that would have prevented the misdiagnosis', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome(
      {
        scanned: 0,
        embedded: 0,
        failed: 0,
        mode: 'harrier',
        table: 'memory_vec_harrier',
        zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
      },
      0,
      sink,
    );
    expect(lines[0].text).toContain('memory_vec_harrier');
    expect(lines[0].text).toContain('harrier');
  });

  it('re-logs IMMEDIATELY when the active target changes, without waiting for the interval', () => {
    const { lines, sink } = capture();
    const at = (table: string, mode: string) => ({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode,
      table,
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    });
    logMemoryVecOutcome(at('memory_vec_harrier', 'harrier'), 0, sink);
    logMemoryVecOutcome(at('memory_vec_gemma', 'gemma'), 1000, sink);
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toContain('memory_vec_gemma');
  });

  it('restates the live target once the interval elapses, so the signal never goes permanently dark', () => {
    const { lines, sink } = capture();
    const healthy = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    };
    logMemoryVecOutcome(healthy, 0, sink);
    logMemoryVecOutcome(healthy, MEMORY_VEC_IDLE_LOG_INTERVAL_MS, sink);
    expect(lines).toHaveLength(2);
  });

  it('a productive pass names the target too (counts alone never identified the table)', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome(
      { scanned: 5, embedded: 4, failed: 1, mode: 'harrier', table: 'memory_vec_harrier' },
      0,
      sink,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('memory_vec_harrier');
    expect(lines[0].text).toMatch(/embedded=4/);
  });

  it('the three zero-count states are mutually DISTINGUISHABLE — the core regression guard', () => {
    const render = (r: Parameters<typeof logMemoryVecOutcome>[0]) => {
      resetMemoryVecIdleLogState();
      const { lines, sink } = capture();
      logMemoryVecOutcome(r, 0, sink);
      return lines.map((l) => `${l.level}:${l.text}`).join('|');
    };
    const disabled = render({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' });
    const dead = render({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: true, canonicalHasRows: true },
    });
    const healthy = render({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    });
    expect(new Set([disabled, dead, healthy]).size).toBe(3);
  });
});

/**
 * P-005 — drain policy: freshest-first ordering, batched embeds, failure-skip,
 * and round-robin fairness in place of the per-sweep row ceiling.
 *
 * These guard the four properties that made the sweep starve a big table:
 * arbitrary pull order, one HTTP round-trip per ROW, persistent failures pinning
 * the head of the queue, and a ceiling set without reference to write rate.
 */
describe('embed-backfill drain policy (P-005)', () => {
  const ORDERED = {
    table: 'harness_shared.session_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
    orderBySql: 'ingested_at DESC',
  };
  const UNORDERED = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };

  function fakeSql(results: unknown[][]) {
    const calls: Array<{ q: string; params?: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params?: unknown[]) => {
        calls.push({ q, params });
        return results.shift() ?? [];
      },
    };
    return { sql: sql as never, calls };
  }
  const embed = async (): Promise<number[]> => VEC;
  // The param type must carry `params` through: narrowing it to `{ q: string }` compiles
  // at the call site and then fails at every `.params!` on the RESULT (P-005 shipped it
  // that way — `lint:tsc --files` only sees files you NAME, and naming the source without
  // its test hides exactly this).
  // STARTS with SELECT: the guarded UPDATE carries a SELECT subquery (WI-10006735).
  const selects = (calls: Array<{ q: string; params?: unknown[] }>) =>
    calls.filter((c) => c.q.trimStart().startsWith('SELECT'));

  it('pulls FRESHEST-FIRST when the target declares an order', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'r1', body: 'x' }], [], []]);
    await backfillTable(sql, ORDERED, { embed: embed, maxRows: 10, mode: 'gemma', spaceAware: true });
    expect(selects(calls)[0].q).toContain('ORDER BY ingested_at DESC');
  });

  it('omits ORDER BY entirely for a target that declares none', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'r1', body: 'x' }], [], []]);
    await backfillTable(sql, UNORDERED, { embed: embed, maxRows: 10, mode: 'gemma', spaceAware: true });
    expect(selects(calls)[0].q).not.toContain('ORDER BY');
  });

  it('embeds a whole batch in ONE call when a batch embedder is supplied', async () => {
    const rows = [
      { k0: 'a', body: 'aaa' },
      { k0: 'b', body: 'bbb' },
      { k0: 'c', body: 'ccc' },
    ];
    const { sql } = fakeSql([rows, [], [], [], []]);
    const batchCalls: string[][] = [];
    const embedMany = async (texts: string[]) => {
      batchCalls.push(texts);
      return texts.map(() => VEC);
    };
    const perRow = vi.fn(async () => VEC);

    const stats = await backfillTable(sql, ORDERED, { embed: perRow, maxRows: 10, mode: 'gemma', spaceAware: true, embedMany: embedMany });

    expect(stats.embedded).toBe(3);
    // ONE batch call carrying all three bodies — not three single-text calls.
    expect(batchCalls).toEqual([['aaa', 'bbb', 'ccc']]);
    // The per-row embedder is never touched on the happy path.
    expect(perRow).not.toHaveBeenCalled();
  });

  it('splits a large batch into bounded chunks rather than one all-or-nothing sidecar call', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ k0: `k${i}`, body: `b${i}` }));
    const { sql } = fakeSql([rows, [], [], [], []]);
    const batchCalls: string[][] = [];
    const embedMany = async (texts: string[]) => {
      batchCalls.push(texts);
      return texts.map(() => VEC);
    };
    const perRow = vi.fn(async () => VEC);

    const stats = await backfillTable(sql, ORDERED, { embed: perRow, maxRows: 20, mode: 'gemma', spaceAware: true, embedMany: embedMany });

    expect(stats.embedded).toBe(20);
    // No single call may carry more than BATCH_EMBED_CHUNK_SIZE. The smaller
    // chunks leave headroom under the count-scaled sidecar deadline.
    expect(batchCalls.map((c) => c.length)).toEqual([8, 8, 4]);
    expect(perRow).not.toHaveBeenCalled();
  });

  it('KEEPS the vectors a chunk already produced when a LATER chunk breaches its deadline', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ k0: `k${i}`, body: `b${i}` }));
    const { sql } = fakeSql([rows, [], [], [], []]);
    let call = 0;
    const embedMany = async (texts: string[]) => {
      call += 1;
      if (call < 3) return texts.map(() => VEC);
      // The exact live failure: the AbortController in sidecarEmbedBatch firing
      // because the sidecar is slower than the count-scaled budget allows.
      throw new Error('This operation was aborted');
    };
    const perRow = vi.fn(async () => VEC);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let stats;
    try {
      stats = await backfillTable(sql, ORDERED, { embed: perRow, maxRows: 20, mode: 'gemma', spaceAware: true, embedMany: embedMany });
    } finally {
      warn.mockRestore();
    }

    // Every row still lands.
    expect(stats.embedded).toBe(20);
    // …but ONLY the 4 rows past the breach pay the per-row price. This is the whole
    // point of chunking: before it, a breach discarded the entire batch, so all 20
    // rows were re-embedded one at a time AFTER the full budget had already been
    // spent — the sidecar was charged twice for the same rows, which is how one
    // target consumed the sweep budget and starved the other 15.
    expect(perRow).toHaveBeenCalledTimes(4);
  });

  it('falls back to the PER-ROW embedder when the batch call fails, so one bad row cannot sink its batch', async () => {
    const rows = [
      { k0: 'a', body: 'aaa' },
      { k0: 'b', body: 'bbb' },
    ];
    const { sql } = fakeSql([rows, [], [], [], []]);
    const embedMany = async () => {
      throw new Error('sidecar_embed_400: one text too long');
    };
    const perRow = vi.fn(async () => VEC);

    // The fallback MUST announce itself. A batch path that always throws and
    // always falls back is otherwise indistinguishable from a working one —
    // same rows, same counts, just N× slower — which is exactly what happened
    // during this change's own live verification.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let stats;
    try {
      stats = await backfillTable(sql, ORDERED, { embed: perRow, maxRows: 10, mode: 'gemma', spaceAware: true, embedMany: embedMany });
    } finally {
      warn.mockRestore();
    }

    // Every row still lands, via the isolating per-row path.
    expect(stats.embedded).toBe(2);
    expect(perRow).toHaveBeenCalledTimes(2);

    // NOTE: the fallback also warns (once per target), and that warning is the
    // point — a silently-falling-back batch path is indistinguishable from a
    // working one. It is deliberately NOT asserted here: under the forks pool an
    // in-test console spy does not reliably observe the module's own console
    // calls, the same limitation already documented on the WI-7327 takeover test
    // above. The spy exists to keep the warning from tripping fail-on-console;
    // BEHAVIOUR is what we assert.
  });

  it('guards the operator_turns recurrence: a batch abort still isolates rows to per-row embeds', async () => {
    const operatorTurns = TARGETS.find((target) => target.table === 'harness_shared.operator_turns')!;
    const rows = [
      { k0: 'turn-a', body: 'operator turn A' },
      { k0: 'turn-b', body: 'operator turn B' },
    ];
    const { sql } = fakeSql([rows, [], [], [], []]);
    const embedMany = async () => {
      throw new Error('This operation was aborted');
    };
    const perRow = vi.fn(async () => VEC);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let stats;
    try {
      stats = await backfillTable(sql, operatorTurns, { embed: perRow, maxRows: 10, mode: 'gemma', spaceAware: true, embedMany: embedMany });
    } finally {
      warn.mockRestore();
    }

    expect(stats.table).toBe('harness_shared.operator_turns');
    expect(stats.embedded).toBe(2);
    expect(stats.errors).toBe(0);
    expect(perRow).toHaveBeenCalledTimes(2);
  });

  it('OFFSETs past rows that persistently FAIL, so they cannot pin the head of an ordered queue', async () => {
    // Row 'bad' always throws; 'good' succeeds. With a stable ORDER BY and no
    // offset, 'bad' would be re-selected in every batch forever.
    const { sql, calls } = fakeSql([
      [{ k0: 'bad', body: 'bad' }, { k0: 'good', body: 'good' }],
      [], // UPDATE for 'good'
      [], // next pull → empty
    ]);
    const flaky = async (t: string) => {
      if (t === 'bad') throw new Error('permanent');
      return VEC;
    };

    const stats = await backfillTable(sql, ORDERED, { embed: flaky, maxRows: 10, mode: 'gemma', spaceAware: true });

    expect(stats.embedded).toBe(1);
    expect(stats.errors).toBe(1);
    const pulls = selects(calls);
    // First pull starts at 0; the pull AFTER a failure skips it.
    expect(pulls[0].params![2]).toBe(0);
    expect(pulls[1].params![2]).toBe(1);
  });

  it('does NOT cap a target at the old 4-batch ceiling — the bound is time, not rows', async () => {
    // Nine consecutive full batches of 1 row each. The pre-P-005 default would
    // have stopped this target after BATCH_SIZE*4 rows regardless of capacity.
    const rows: unknown[][] = [];
    for (let i = 0; i < 9; i++) {
      rows.push([{ k0: `r${i}`, body: `body-${i}` }]);
      rows.push([]); // its UPDATE
    }
    rows.push([]); // final empty pull
    const { sql } = fakeSql(rows);

    // maxRows well above the old ceiling: the loop must keep going, not stop at 4.
    const stats = await backfillTable(sql, ORDERED, { embed: embed, maxRows: 1000, mode: 'gemma', spaceAware: true });
    expect(stats.embedded).toBe(9);
  });
});
