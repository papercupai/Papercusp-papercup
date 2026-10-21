/**
 * code-run-batch-nudge.test — the inline batch nudge (code-run-token-frugality, owner directive
 * 2026-06-23; fan-out + felt-cost + backoff upgrade 2026-06-26). Pure in-process logic with an
 * injectable clock, so these are deterministic unit tests.
 *
 * TEETH: each "fires" assertion pairs with a "does NOT fire" under the same setup minus the one
 * triggering condition, so neutering a guard flips a test RED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  maybeBatchNudge,
  maybeOrientDedupNudge,
  maybeListFanoutPreempt,
  _resetBatchNudgeState,
  isPreferredDoor,
  EXCLUDED_TOOL_NORMS,
  PREFERRED_DOOR_NORMS,
  BATCH_NUDGE_THRESHOLD,
  FANOUT_DISTINCT_THRESHOLD,
  NUDGE_WINDOW_MS,
  ORIENT_DEDUP_WINDOW_MS,
  CODE_RUN_CAPABLE_ROLES,
  LIST_FANOUT_MIN_ROWS,
  CODE_RUN_RECENT_MS,
  MAX_PREEMPT_PER_SESSION,
  TURN_GAP_MS,
  FORCED_REISSUE_WINDOW_MS,
  clusterTurns,
  advisorySessionKey,
} from './code-run-batch-nudge';

const cap = { sessionKey: 's1', toolName: 'work_items:get', args: {}, canCodeRun: true };

beforeEach(() => _resetBatchNudgeState());

describe('maybeBatchNudge — same-tool trigger (windowed)', () => {
  it('stays silent below the threshold, fires exactly AT it with kind=same-tool', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, now: t })).toBeNull(); // calls 1..N-1
    }
    t += 1000;
    const hit = maybeBatchNudge({ ...cap, now: t }); // the Nth call
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.text).toContain('work_items:get');
    expect(hit?.text).toContain('code:run');
  });

  it('WI-2142449: the same-tool skeleton is Promise.all, not a sequential for-loop — its own "independent" claim must match the shape it hands back', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, now: t });
    }
    expect(hit?.suggestedScript).toContain('Promise.all');
    // The exact bug: this text used to say "for (const a of inputs)" — strictly sequential — while
    // the surrounding prose claimed the calls were independent. A sequential shape must never
    // reappear here.
    expect(hit?.suggestedScript).not.toMatch(/for\s*\(const \w+ of inputs\)/);
    expect(hit?.text).toContain('independent');
    // Isolated per-branch (EI-21712103510622160's pattern) so one bad input cannot discard results
    // already fetched for the others — the same protection fanoutSkeleton already has.
    expect(hit?.suggestedScript).toContain(".catch((e) => ({ error: String(e) }))");
  });

  it('describes timing-only evidence without claiming a measured model-turn count', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, now: t });
    }
    expect(hit?.text).toContain('Timing alone cannot identify model turns');
    expect(hit?.text).not.toContain('× observed turns');
    expect(hit?.text).toMatch(/round-trip/);
  });

  it('does NOT fire when the repeats fall OUTSIDE the window (only a bursty flurry trips it)', () => {
    expect(maybeBatchNudge({ ...cap, now: 0 })).toBeNull(); // count 1
    // next call far beyond the window — the first aged out, so the window count is back to 1.
    expect(maybeBatchNudge({ ...cap, now: NUDGE_WINDOW_MS + 2000 })).toBeNull();
    // and one more a window later — again the prior aged out, still a window count of 1.
    expect(maybeBatchNudge({ ...cap, now: 2 * (NUDGE_WINDOW_MS + 2000) })).toBeNull();
  });

  it('states the correct boundary — judgment mid-flow, NOT data dependency', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, now: t });
    }
    // WI-2142449: the old text claimed "independent or mechanically-chained" while handing back a
    // serial for-loop that could not correctly express a mechanically-chained (result-dependent)
    // call anyway — a static prefilled `inputs` list is incompatible with true runtime chaining
    // either way. It now states the real boundary directly instead.
    expect(hit?.text).toContain('read-then-decide steps separate');
    expect(hit?.text).toContain('already grouped calls need no change');
  });

  it('embeds a runnable list-then-fold (Promise.all) skeleton over the EXACT repeated tool', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, toolName: 'work_items:get', now: t });
    }
    expect(hit?.text).toContain('code:run { script:');
    expect(hit?.text).toContain('tools.workItems.get(a)'); // camelNamespace.camelVerb form, loop var
    expect(hit?.text).toContain('Promise.all(');
    expect(hit?.text).toContain('inputs.map((a) =>');
    expect(hit?.text).toContain('return out;');
  });

  it('camelCases a hyphenated verb in the skeleton (set-status → setStatus)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, toolName: 'plans:set-status', now: t });
    }
    expect(hit?.text).toContain('tools.plans.setStatus(a)');
  });
});

describe('maybeBatchNudge — fan-out trigger (the ~70% the old nudge missed)', () => {
  const fanTools = ['plans:get', 'work_items:get', 'docs:search', 'coord:inbox'];

  it('fires with kind=fanout once ≥ FANOUT_DISTINCT_THRESHOLD distinct tools hit the window', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    let i = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (i < FANOUT_DISTINCT_THRESHOLD - 1) expect(r).toBeNull(); // below the distinct threshold
      if (r && !firstFire) firstFire = r; // capture the fire — a later call cools down to null
      i++;
    }
    expect(firstFire?.kind).toBe('fanout');
  });

  it('isolates each fan-out branch so one bad call cannot discard the siblings', () => {
    // EI-21712103510622160 (+ EI-21546546359149278): a bare Promise.all is fail-FAST, and this
    // skeleton is emitted for INDEPENDENT reads — the case where that is wrong. One branch
    // omitted a required arg, the typed invalid_input propagated out of Promise.all, and every
    // sibling read that had ALREADY SUCCEEDED was discarded, because the script never reached
    // its return and only the return re-enters context.
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz-isolate', toolName, args: {}, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    const script = firstFire?.suggestedScript ?? '';
    expect(script).toContain('Promise.all');

    // EVERY branch is isolated, not just the first — a per-branch guard that covers only some
    // of them still loses the siblings of whichever call actually fails.
    const branches = script.split('\n').filter((line) => line.includes('tools.'));
    expect(branches.length).toBeGreaterThan(1);
    for (const branch of branches) {
      expect(branch, `unisolated fan-out branch: ${branch}`).toContain('.catch(');
    }

    // The paste-ready destructuring shape is preserved: isolation must not force the caller to
    // unwrap an allSettled { status, value } envelope at every bind.
    expect(script).toMatch(/const \[r0, r1/);
    expect(script).not.toContain('allSettled');
  });

  it('embeds a Promise.all skeleton over the EXACT distinct tools seen, in first-seen order', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, args: {}, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r; // the fire carries the tools seen UP TO the threshold
    }
    expect(firstFire?.text).toContain('Promise.all');
    // first-seen order, capped at the distinct threshold — the trailing tool fires later, in cooldown
    expect(firstFire?.text).toContain('tools.plans.get(');
    expect(firstFire?.text).toContain('tools.workItems.get(');
    expect(firstFire?.text).toContain('tools.docs.search(');
    expect(firstFire?.text).toMatch(/return \{ r0, r1, r2 \}/);
  });

  it('surfaces the felt cost for the fan-out (distinct-tool + total-call counts)', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.text).toContain('Timing alone cannot identify model turns');
    expect(firstFire?.text).toMatch(/round-trip/);
  });

  it('does NOT fire below BOTH thresholds — two distinct single reads stay silent', () => {
    let t = 0;
    // 2 distinct tools, each once: distinct (2) < FANOUT_DISTINCT_THRESHOLD AND maxSameTool (1) <
    // BATCH_NUDGE_THRESHOLD → below both triggers, so silent regardless of the (lowered) thresholds.
    for (const toolName of ['a:x', 'b:y']) {
      t += 1000;
      expect(maybeBatchNudge({ sessionKey: 'fn', toolName, canCodeRun: true, now: t })).toBeNull();
    }
  });
});

// ── P-012 (agent-operability-clarity-full-audit-2026-07-13): the guidance must measure model
//    INFERENCE TURNS, not raw downstream RPC count. A burst already collapsed into ONE turn via
//    parallel tool_use costs zero extra round-trips and must never be nudged as if it did; only a
//    burst that genuinely SPANS multiple turns has a round-trip to save. ──────────────────────────
describe('clusterTurns — the turn-clustering primitive', () => {
  it('groups events within TURN_GAP_MS of each other into the same turn', () => {
    const events = [{ at: 0 }, { at: 50 }, { at: TURN_GAP_MS }];
    expect(clusterTurns(events)).toEqual([0, 0, 0]);
  });

  it('starts a new turn once the gap exceeds TURN_GAP_MS', () => {
    const events = [{ at: 0 }, { at: TURN_GAP_MS + 1 }];
    expect(clusterTurns(events)).toEqual([0, 1]);
  });

  it('is order-independent — sorts by `at` internally', () => {
    const events = [{ at: TURN_GAP_MS + 1 }, { at: 0 }];
    expect(clusterTurns(events)).toEqual([1, 0]);
  });

  it('groups calls with the same explicit request turn ID even when the timing gap is large', () => {
    const events = [
      { at: 0, durationMs: 500, turnId: 'functions-exec-1' },
      { at: 2_547, durationMs: 500, turnId: 'functions-exec-1' },
      { at: 5_094, durationMs: 500, turnId: 'functions-exec-1' },
    ];
    expect(clusterTurns(events)).toEqual([0, 0, 0]);
  });

  it('keeps distinct explicit request turn IDs separate even when timestamps are close', () => {
    const events = [
      { at: 0, turnId: 'owner-turn-1' },
      { at: 10, turnId: 'owner-turn-2' },
    ];
    expect(clusterTurns(events)).toEqual([0, 1]);
  });

  // ── EI-23762928303536326: the IN-FLIGHT guard ────────────────────────────────────────────────
  // A call dispatched while an earlier call in the cluster is STILL RUNNING cannot open a new
  // inference turn — the model had not yet received that result to reason about. `at` is dispatch
  // as observed by the SERVER, so a parallel block is spread by request queueing under load.
  // Measured fleet-wide over 4h: 1,169 gaps exceeded TURN_GAP_MS while the previous call was still
  // executing (p50 gap 647ms vs p50 previous-call duration 1,473ms) — every one split into phantom
  // turns, so the nudge nagged hardest at the agents who WERE batching correctly.
  it('keeps a call in the SAME turn when it was dispatched while the previous call was still running', () => {
    const events = [
      { at: 0, durationMs: 1_473 },
      { at: 647, durationMs: 20 },
    ];
    expect(clusterTurns(events)).toEqual([0, 0]);
  });

  it('extends the in-flight horizon across a block — one slow call covers the later dispatches', () => {
    const events = [
      { at: 0, durationMs: 5_000 },
      { at: 900, durationMs: 10 },
      { at: 2_400, durationMs: 10 },
      { at: 4_900, durationMs: 10 },
    ];
    expect(clusterTurns(events)).toEqual([0, 0, 0, 0]);
  });

  // CALIBRATION — the guard must not merge everything. Without these, the two assertions above
  // would pass just as well against a broken clusterTurns that returned all-zeros.
  it('still splits genuinely sequential turns — the previous call had returned before the next dispatch', () => {
    const events = [
      { at: 0, durationMs: 83 },
      { at: 2_547, durationMs: 83 },
    ];
    expect(clusterTurns(events)).toEqual([0, 1]);
  });

  it('splits as soon as the earlier call has returned, even by 1ms', () => {
    // The first call ends at exactly TURN_GAP_MS, so the second dispatch is NOT in flight.
    const events = [
      { at: 0, durationMs: TURN_GAP_MS },
      { at: TURN_GAP_MS + 1, durationMs: 5 },
    ];
    expect(clusterTurns(events)).toEqual([0, 1]);
  });

  // DEGRADATION — absent or unusable timing must behave EXACTLY like the pre-guard gap rule.
  it('degrades to the pure gap rule when durations are absent', () => {
    expect(clusterTurns([{ at: 0 }, { at: TURN_GAP_MS + 1 }])).toEqual([0, 1]);
    expect(clusterTurns([{ at: 0, durationMs: undefined }, { at: 10_000 }])).toEqual([0, 1]);
  });

  it('ignores a non-finite or negative duration rather than trusting it', () => {
    const events = [
      { at: 0, durationMs: Number.NaN },
      { at: TURN_GAP_MS + 1, durationMs: -5 },
    ];
    expect(clusterTurns(events)).toEqual([0, 1]);
  });

  // FALSIFIABILITY CONTROL — the pre-fix algorithm, kept here deliberately wrong and permanently,
  // because a guard that has never failed is a guard nobody has tested. Mutating the real source to
  // prove this would be unsafe on the shared tree (git-sync sweeps every few minutes and would
  // commit the mutant), so the control lives in the test file instead.
  const gapOnlyClusterTurns = (events: readonly { at: number }[]): number[] => {
    const order = events.map((_, i) => i).sort((a, b) => events[a].at - events[b].at);
    const turnOf = new Array<number>(events.length);
    let turn = -1;
    let prevAt: number | undefined;
    for (const i of order) {
      const at = events[i].at;
      if (prevAt === undefined || at - prevAt > TURN_GAP_MS) turn++;
      turnOf[i] = turn;
      prevAt = at;
    }
    return turnOf;
  };

  it('CONTROL: the pre-fix gap-only algorithm splits the in-flight fixture — the guard is what fixes it', () => {
    const inFlight = [
      { at: 0, durationMs: 1_473 },
      { at: 647, durationMs: 20 },
    ];
    // The bug, reproduced: two dispatches from ONE parallel block counted as two round-trips.
    expect(gapOnlyClusterTurns(inFlight)).toEqual([0, 1]);
    // …and corrected. If clusterTurns ever regresses to gap-only clustering, this line fails.
    expect(clusterTurns(inFlight)).toEqual([0, 0]);

    // The other half of falsifiable: the guard must CHANGE only the in-flight case. Wherever timing
    // alone is decisive the two algorithms must still agree, or this is over-merging rather than
    // correcting — which would silence the nudge everywhere instead of fixing it.
    for (const agreeing of [
      [{ at: 0, durationMs: 83 }, { at: 2_547, durationMs: 83 }],
      [{ at: 0, durationMs: 5 }, { at: 50, durationMs: 5 }, { at: 120, durationMs: 5 }],
      [{ at: 0 }, { at: TURN_GAP_MS + 1 }],
    ]) {
      expect(clusterTurns(agreeing)).toEqual(gapOnlyClusterTurns(agreeing));
    }
  });
});

describe('maybeBatchNudge — turn-aware same-tool trigger (P-012)', () => {
  it('does NOT fire when the same tool is called ≥ threshold times but all within ONE turn (parallel dispatch)', () => {
    // BATCH_NUDGE_THRESHOLD calls, all landing inside the same inference turn (near-simultaneous
    // timestamps well under TURN_GAP_MS) — this is already ONE round-trip, not a hand-loop.
    let last: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      last = maybeBatchNudge({ ...cap, now: i * 10 }); // 10ms apart ≪ TURN_GAP_MS
    }
    expect(last).toBeNull();
  });

  it('DOES fire once the same tool spans ≥ threshold SEPARATE turns, even with extra same-turn repeats', () => {
    // Turn 1: two PARALLEL calls to the same tool (fine, one round-trip). Turn 2 (well past the
    // gap): one more call to the same tool — now it has genuinely repeated across 2 turns.
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    hit = maybeBatchNudge({ ...cap, sessionKey: 'turn-mix', now: 0 });
    expect(hit).toBeNull();
    hit = maybeBatchNudge({ ...cap, sessionKey: 'turn-mix', now: 10 }); // same turn as the first
    expect(hit).toBeNull(); // still only 1 distinct turn for this tool
    hit = maybeBatchNudge({ ...cap, sessionKey: 'turn-mix', now: TURN_GAP_MS + 100 }); // a new turn
    expect(hit?.kind).toBe('same-tool');
    // The felt-cost figure is the TURN count (2), never the raw call count (3).
    expect(hit?.text).not.toMatch(/\b3 separate round-trips\b/);
    expect(hit?.text).toContain('Timing alone cannot identify model turns');
  });

  it('does NOT count sequential calls in one explicit functions.exec request group as separate turns', () => {
    const fires: ReturnType<typeof maybeBatchNudge>[] = [];
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      const r = maybeBatchNudge({
        ...cap,
        sessionKey: 'same-explicit-request-group',
        turnId: 'functions-exec-group-1',
        now: i * 2_547,
        durationMs: 500,
      });
      if (r) fires.push(r);
    }
    expect(fires).toEqual([]);
  });

  it('still counts distinct explicit request groups as separate turns inside the timing gap', () => {
    const first = maybeBatchNudge({
      ...cap,
      sessionKey: 'distinct-explicit-request-groups',
      turnId: 'owner-turn-1',
      now: 0,
    });
    expect(first).toBeNull();
    const second = maybeBatchNudge({
      ...cap,
      sessionKey: 'distinct-explicit-request-groups',
      turnId: 'owner-turn-2',
      now: 10,
    });
    expect(second?.kind).toBe('same-tool');
    expect(second?.text).toContain('2× observed turns');
  });

  // EI-23762928303536326 — the reported symptom, end to end. A single parallel block whose
  // dispatches the SERVER observed 647ms apart (queueing spread under fleet load) while the first
  // call was still running: one round-trip, nothing to fold, so the nudge must stay silent. Before
  // the in-flight guard this fired, telling an agent who had correctly batched to batch harder.
  it('does NOT fire for one parallel block whose dispatches the server observed >TURN_GAP_MS apart while still in flight', () => {
    // Collect EVERY result, not just the last: a nudge that fired mid-loop and was then silenced by
    // the exponential backoff would leave `last` null and pass this test while the bug was live.
    const fires: ReturnType<typeof maybeBatchNudge>[] = [];
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      const r = maybeBatchNudge({
        ...cap,
        sessionKey: 'queued-parallel-block',
        now: i * (TURN_GAP_MS + 247), // 647ms apart — well past the timing threshold
        durationMs: 1_473, // …but every call is still running when the next is dispatched
      });
      if (r) fires.push(r);
    }
    expect(fires).toEqual([]);
  });

  // CALIBRATION for the test above: identical spacing, but each call RETURNS almost immediately,
  // so these are genuinely separate turns and the nudge must still fire. Without this, the
  // assertion above would pass against a nudge that had simply been disabled.
  it('DOES still fire at the same spacing when each call returned long before the next dispatch', () => {
    // Capture the FIRST fire, not the last: the trigger trips as soon as the turn count is reached,
    // and continuing calls hit the exponential backoff (a different guard).
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      const r = maybeBatchNudge({
        ...cap,
        sessionKey: 'sequential-turns',
        now: i * (TURN_GAP_MS + 247),
        durationMs: 5, // returns immediately ⇒ nothing is ever in flight ⇒ genuine turns
      });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('same-tool');
  });
});

describe('maybeBatchNudge — turn-aware fan-out trigger (P-012)', () => {
  const fanTools = ['plans:get', 'work_items:get', 'docs:search', 'coord:inbox'];

  it('does NOT fire when ≥ FANOUT_DISTINCT_THRESHOLD distinct tools are all called within ONE turn', () => {
    // A legitimate parallel fan-out: several independent, distinct-tool calls from ONE inference
    // turn (exactly the harness's "make independent calls in the same response block" guidance).
    // Already one round-trip — nudging this would steer the agent AWAY from best practice.
    let last: ReturnType<typeof maybeBatchNudge> = null;
    let i = 0;
    for (const toolName of fanTools) {
      last = maybeBatchNudge({ sessionKey: 'par-fan', toolName, canCodeRun: true, now: i * 5 });
      i++;
    }
    expect(last).toBeNull();
  });

  it('stays silent for one dispatch even when parallel call durations are highly uneven', () => {
    let last: ReturnType<typeof maybeBatchNudge> = null;
    const durations = [10, 950, 1_200, 75];
    for (let i = 0; i < fanTools.length; i++) {
      last = maybeBatchNudge({
        sessionKey: 'uneven-parallel-fan',
        toolName: fanTools[i]!,
        canCodeRun: true,
        now: 1_000,
        durationMs: durations[i],
      });
    }
    expect(last).toBeNull();
  });

  it('the production handler stamps the nudge with dispatch time, not completion time', () => {
    const source = readFileSync(
      new URL('./endpoint-route/routes/transport/_mcp-host.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/maybeBatchNudge\(\{[\s\S]*?now:\s*callStartedAt,[\s\S]*?durationMs:/);
    expect(source).toMatch(
      /maybeBatchNudge\(\{[\s\S]*?turnId:\s*req\.params\._meta\?\.outputGroupId\s*\?\?\s*req\.params\._meta\?\.turnId/,
    );
  });

  it('DOES fire when the same distinct-tool spread lands across ≥ FANOUT_DISTINCT_THRESHOLD SEPARATE turns', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += TURN_GAP_MS + 100; // each call is its own turn
      const r = maybeBatchNudge({ sessionKey: 'seq-fan', toolName, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('fanout');
    expect(firstFire?.text).toMatch(/round-trip/);
  });

  it('a burst that mixes one parallel turn + later separate turns counts turns, not calls', () => {
    // Turn 1: 2 parallel distinct-tool calls (1 turn so far). Turn 2 (later): a 3rd distinct tool.
    // Total calls = 3, but distinct turns = 2 — below FANOUT_DISTINCT_THRESHOLD (3), so silent.
    let last: ReturnType<typeof maybeBatchNudge> = null;
    last = maybeBatchNudge({ sessionKey: 'mix-fan', toolName: 'plans:get', canCodeRun: true, now: 0 });
    expect(last).toBeNull();
    last = maybeBatchNudge({ sessionKey: 'mix-fan', toolName: 'work_items:get', canCodeRun: true, now: 10 });
    expect(last).toBeNull();
    last = maybeBatchNudge({
      sessionKey: 'mix-fan',
      toolName: 'docs:search',
      canCodeRun: true,
      now: TURN_GAP_MS + 200,
    });
    // 3 distinct tools reached, but only 2 distinct turns — must stay silent (turns, not raw diversity).
    expect(last).toBeNull();
  });
});

describe('maybeBatchNudge — backoff (re-fires, NOT one-shot)', () => {
  it('re-fires on an exponential call-count cooldown instead of going permanently silent', () => {
    const fires: number[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      if (maybeBatchNudge({ ...cap, now: t })) fires.push(i);
    }
    // First fire at the 2nd call (index 1, threshold lowered 3→2); then re-fires after cooldowns
    // 4, 8 (→ indices 5, 13).
    expect(fires).toEqual([1, 5, 13]);
    // The gap between consecutive fires strictly grows (exponential backoff, never spam).
    expect(fires[1] - fires[0]).toBeLessThan(fires[2] - fires[1]);
  });

  it('does NOT re-fire on the call immediately after a nudge (the cooldown is real)', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      maybeBatchNudge({ ...cap, now: t });
    }
    t += 1000;
    expect(maybeBatchNudge({ ...cap, now: t })).toBeNull(); // immediate next call — still cooling down
  });
});

describe('maybeBatchNudge — bounded repeat reminders', () => {
  it('later fires stay short and do not escalate the prose', () => {
    const texts: string[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      const r = maybeBatchNudge({ ...cap, now: t });
      if (r) texts.push(r.text);
    }
    expect(texts).toHaveLength(3); // fires at indices 1, 5, 13 (see backoff test)
    expect(texts[0]).not.toMatch(/reminder this session/); // 1st = the original neutral message
    for (const text of texts.slice(1)) {
      expect(text.length).toBeLessThanOrEqual(250);
      expect(text).not.toMatch(/reminder this session/);
    }
  });

  // WI-6554700010008923 (oversized-tool-results-reduction-2026-10-12#P-008): the explanation is
  // taught once. Every repeat used to re-send the full ~1.2 KB hint, explanation included.
  it('a repeat fire retains the decision boundary and drops the argument replay', () => {
    const fires: Array<{ text: string; suggestedScript?: string }> = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      const r = maybeBatchNudge({ ...cap, sessionKey: 'repeat-compact', args: { id: `WI-${i}` }, now: t });
      if (r) fires.push(r);
    }
    expect(fires.length).toBeGreaterThanOrEqual(2);
    const [first, second] = fires;
    expect(first.suggestedScript).toBeTruthy();
    expect(first.text).toContain('read-then-decide steps separate');
    expect(second.suggestedScript).toBeUndefined();
    expect(second.text).not.toContain('WI-');
    expect(second.text).toContain('read-then-decide steps separate');
    expect(second.text).toContain('already grouped calls need no change');
    expect(second.text.length).toBeLessThan(first.text.length / 2);
  });
});

describe('maybeBatchNudge — scoping guards (teeth)', () => {
  it('does NOT fire for a caller that cannot run code:run', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 2; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, canCodeRun: false, now: t })).toBeNull();
    }
  });

  it('does NOT nudge the batch tools themselves, and never counts them toward fan-out', () => {
    let t = 0;
    for (const toolName of ['code:run', 'code_run', 'recipes:search', 'recipes_run']) {
      t += 1000;
      expect(maybeBatchNudge({ sessionKey: 'ex', toolName, canCodeRun: true, now: t })).toBeNull();
    }
    // Those four distinct EXCLUDED tools must NOT have populated the window — one real read is below
    // both thresholds, so still silent (proves excluded calls short-circuit before recording).
    t += 1000;
    expect(maybeBatchNudge({ sessionKey: 'ex', toolName: 'plans:get', canCodeRun: true, now: t })).toBeNull();
  });

  it('does NOT nudge AMBIENT hook/status tools, and never counts them toward any tally', () => {
    // activity:report / coord:glance / coord:inbox fire on the client hooks' cadence, not the
    // agent's reasoning — live fires 2026-07-12 were dominated by these phantom "bursts".
    let t = 0;
    for (const toolName of ['activity:report', 'activity_report', 'coord:glance', 'coord:inbox', 'activity:recent']) {
      for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
        t += 500;
        expect(maybeBatchNudge({ sessionKey: 'amb', toolName, canCodeRun: true, now: t })).toBeNull();
      }
    }
    // The ambient storm above must NOT have populated the window: 2 real distinct reads right
    // after it stay below both thresholds (proves ambient calls short-circuit before recording —
    // they can neither trigger a nudge themselves nor inflate a fan-out/same-tool tally).
    t += 500;
    expect(maybeBatchNudge({ sessionKey: 'amb', toolName: 'plans:get', canCodeRun: true, now: t })).toBeNull();
    t += 500;
    expect(maybeBatchNudge({ sessionKey: 'amb', toolName: 'work_items:get', canCodeRun: true, now: t })).toBeNull();
  });

  it('does NOT nudge LOCK-LIFECYCLE tools — an acquire/edit/release cycle is not a batchable burst (EI-10168)', () => {
    // The agent's real work happens BETWEEN acquire and release via native (non-MCP) edits, so a
    // repeated acquire→edit→release cycle is serialized by that intervening work and can NEVER be
    // folded into one code:run loop. Live fires 2026-07-12 (EI-10168): the residual nudge fires
    // after the ambient exclusion were exactly these lock cycles (locks:acquire + locks:release).
    let t = 0;
    // Without the exclusion, the 2nd locks:acquire alone trips the same-tool nudge → this loop reds.
    for (const toolName of ['locks:acquire', 'locks:release', 'locks:acquire', 'locks:release', 'locks:acquire', 'locks:release']) {
      t += 1000;
      expect(maybeBatchNudge({ sessionKey: 'lk', toolName, canCodeRun: true, now: t })).toBeNull();
    }
    // The granular / resource / heartbeat variants are lock lifecycle too — none nudge, however bursty.
    for (const toolName of [
      'locks:acquire_granular',
      'locks:release_granular',
      'locks:acquire_resource',
      'locks:release_resource',
      'locks:heartbeat',
      'locks:heartbeat_resource',
    ]) {
      for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
        t += 500;
        expect(maybeBatchNudge({ sessionKey: 'lk', toolName, canCodeRun: true, now: t })).toBeNull();
      }
    }
    // The lock storm above must NOT have populated the window: 2 real distinct reads right after it
    // stay below both thresholds (proves lock-lifecycle calls short-circuit before recording — they
    // can neither trigger a nudge themselves nor inflate a fan-out/same-tool tally).
    t += 500;
    expect(maybeBatchNudge({ sessionKey: 'lk', toolName: 'plans:get', canCodeRun: true, now: t })).toBeNull();
    t += 500;
    expect(maybeBatchNudge({ sessionKey: 'lk', toolName: 'work_items:get', canCodeRun: true, now: t })).toBeNull();
  });

  it('does NOT replay SESSION-LIFECYCLE calls in ready-to-paste skeletons (EI-22140114721989909)', () => {
    // `session:request-compaction` is a session transition, not a batchable read. If it enters the
    // recent-call ring, the fan-out skeleton can paste it back into the next code:run and trigger
    // another compaction; the same rule applies to session:end and session:carry-drill.
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const call of [
      { toolName: 'plans:get', args: { slug: 'alpha-plan' } },
      { toolName: 'session:request-compaction', args: { autoContinue: false } },
      { toolName: 'docs:search', args: { q: 'beta-topic' } },
      { toolName: 'session:end', args: { reason: 'finished' } },
      { toolName: 'session:carry-drill', args: { op: 'report' } },
      { toolName: 'work_items:get', args: { id: 'WI-1234' } },
    ]) {
      t += 1000;
      const hit = maybeBatchNudge({
        sessionKey: 'session-lifecycle',
        ...call,
        canCodeRun: true,
        now: t,
      });
      if (hit && !firstFire) firstFire = hit;
    }

    expect(firstFire?.kind).toBe('fanout');
    expect(firstFire?.suggestedScript).toContain('tools.plans.get({"slug":"alpha-plan"})');
    expect(firstFire?.suggestedScript).toContain('tools.docs.search({"q":"beta-topic"})');
    expect(firstFire?.suggestedScript).toContain('tools.workItems.get({"id":"WI-1234"})');
    expect(firstFire?.suggestedScript).not.toContain('session');
    expect(firstFire?.text).not.toContain('session:request-compaction');
    expect(firstFire?.text).not.toContain('session:end');
    expect(firstFire?.text).not.toContain('session:carry-drill');
  });

  it('does NOT fire on an empty session key or empty tool name', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, sessionKey: '', now: t })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: '', now: t })).toBeNull();
    }
  });
});

describe('maybeBatchNudge — isolation', () => {
  it('tracks each (session, tool) independently for the same-tool trigger', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, toolName: 'plans:get', now: t })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: 'docs:get', now: t })).toBeNull();
    }
    t += 1000;
    // NOTE: by now the session has seen plans:get + docs:get + work_items:get-shaped names? No — only
    // two distinct tools here, below the fan-out threshold, so only the same-tool trigger can fire.
    expect(maybeBatchNudge({ ...cap, toolName: 'plans:get', now: t })?.text).toContain('plans:get');
  });

  it('does NOT bleed counts across sessions', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      maybeBatchNudge({ ...cap, sessionKey: 'a', now: t });
    }
    // A fresh session starts at zero — one call is below threshold, so silent.
    t += 1000;
    expect(maybeBatchNudge({ ...cap, sessionKey: 'b', now: t })).toBeNull();
  });

  it('separates advisory state for transport connections sharing one stable owner', () => {
    const first = advisorySessionKey('stable-owner', 'transport-a');
    const second = advisorySessionKey('stable-owner', 'transport-b');
    expect(first).not.toBe(second);
    expect(first).toContain('stable-owner');
    expect(second).toContain('stable-owner');
  });

  it('keeps the stable key when transport identity is unavailable or identical', () => {
    expect(advisorySessionKey('stable-owner')).toBe('stable-owner');
    expect(advisorySessionKey('stable-owner', null)).toBe('stable-owner');
    expect(advisorySessionKey('stable-owner', 'stable-owner')).toBe('stable-owner');
  });

  it('uses the transport-scoped key at the production advisory seam', () => {
    const source = readFileSync(
      new URL('./endpoint-route/routes/transport/_mcp-host.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/const nudgeSessionKey = advisorySessionKey\(replayOwnerKey, transportSessionId\)/);
    expect(source).toMatch(/maybeBatchNudge\(\{[\s\S]*?sessionKey:\s*nudgeSessionKey/);
    expect(source).toMatch(/maybeListFanoutPreempt\(\{[\s\S]*?sessionKey:\s*nudgeSessionKey/);
    expect(source).toMatch(/maybeOrientDedupNudge\(\{[\s\S]*?sessionKey:\s*nudgeSessionKey/);
    expect(source).toMatch(/maybeStatePlaneNudge\(\{[\s\S]*?sessionKey:\s*nudgeSessionKey/);
  });
});

describe('maybeOrientDedupNudge (P-009) — soft, windowed, one-shot', () => {
  const KEY = 'spawn-1';

  it('nudges a subsumed fetch shortly after a successful orient, pointing back at orient', () => {
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 1000 })).toBeNull();
    const hit = maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 2000 });
    expect(hit).toContain('coord:orient already returned');
    expect(hit).toContain('coord:inbox');
    expect(hit).toContain('inbox');
  });

  it('covers all four tools orient subsumes (plan-events / inbox / memory:search / declare-intent)', () => {
    for (const toolName of ['coord:plan-events', 'coord:inbox', 'memory:search', 'coord:declare-intent']) {
      _resetBatchNudgeState();
      maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
      expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName, now: 100 })).not.toBeNull();
    }
  });

  it('is ONE-SHOT per (session, subsumed tool)', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 1 })).not.toBeNull();
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 2 })).toBeNull();
  });

  it('does NOT fire without a preceding orient this session (a fresh fetch is legitimate)', () => {
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 5000 })).toBeNull();
  });

  it('does NOT fire outside the window — a genuine LATER re-check is left alone', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    const tooLate = ORIENT_DEDUP_WINDOW_MS + 1;
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: tooLate })).toBeNull();
  });

  it('does NOT nudge unrelated tools, and never nudges orient itself', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'plans:get', now: 10 })).toBeNull();
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 20 })).toBeNull();
  });

  it('matches the MCP (underscore) name form too', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord_orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord_inbox', now: 10 })).not.toBeNull();
  });
});

describe('CODE_RUN_CAPABLE_ROLES', () => {
  it('includes EVERY built-in role (code:run is open to all roles, owner directive 2026-06-25)', () => {
    expect(CODE_RUN_CAPABLE_ROLES.has('worker')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('mug')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('cup')).toBe(true);
    // Previously-excluded non-SU/bee roles now qualify — the nudge fires for them too.
    expect(CODE_RUN_CAPABLE_ROLES.has('papercup')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('kettle')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('reviewer')).toBe(true);
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-004: surface-aware nudging ──────────────

import { canRoleActOnCodeRun } from './code-run-batch-nudge';

describe('canRoleActOnCodeRun — envelope-aware capability check (P-004)', () => {
  it('allows default-allow fleet roles (bee, queen, worker)', () => {
    for (const role of ['cup', 'mug', 'worker']) {
      expect(canRoleActOnCodeRun(role), role).toBe(true);
    }
  });

  it('refuses envelope-denied roles (overwatch/sentinel deny capability:bash) and unknown roles', () => {
    expect(canRoleActOnCodeRun('kettle')).toBe(false);
    expect(canRoleActOnCodeRun('papercup')).toBe(false);
    expect(canRoleActOnCodeRun('totally-unknown-role')).toBe(false);
  });
});

describe('maybeBatchNudge — codeRunInSurface teaches the activate path (P-004)', () => {
  it('appends the tools:find/tools:invoke path when the surface lacks code:run', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, codeRunInSurface: false, now: i * 1000 });
    }
    expect(hit).not.toBeNull();
    expect(hit!.text).toContain('not in your loaded tool list');
    expect(hit!.text).toContain('tools:find("code:run")');
    expect(hit!.text).toContain('tools:invoke');
  });

  it('does NOT append the activate path when the surface has code:run (default)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, now: i * 1000 });
    }
    expect(hit).not.toBeNull();
    expect(hit!.text).not.toContain('not in your loaded tool list');
  });
});

// ── code-run-batch-adoption-2026-07-12: tools:invoke unwrap (P-001), pipeline kind (P-002),
//    arg-prefilled skeletons (P-003). Distilled from the 2026-07-11 release-fleet burst: 8 serial
//    round-trips (3× release via tools:invoke + claim + comment on ONE work-item) that three
//    escalating hints failed to convert — each test below pins the blind spot that hid it. ──────

describe('maybeBatchNudge — tools:invoke unwrap (P-001)', () => {
  it('counts a tools:invoke-routed call as its INNER tool — a wrapped burst trips same-tool', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv1',
        toolName: 'tools:invoke',
        args: { name: 'work_items:release', args: { id: `WI-${1000 + i}` } },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.tool).toBe('work_items:release');
    expect(hit?.text).toContain('work_items:release');
    expect(hit?.text).toContain('tools.workItems.release(a)');
  });

  it('matches the MCP underscore wrapper form (tools_invoke) too', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv2',
        toolName: 'tools_invoke',
        args: { name: 'plans:get', args: { slug: `plan-${i}` } },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.tool).toBe('plans:get');
  });

  it('keeps the EXCLUSION on the inner tool — tools:invoke{name:"code:run"} never nudges or counts', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      t += 1000;
      expect(
        maybeBatchNudge({
          sessionKey: 'inv3',
          toolName: 'tools:invoke',
          args: { name: 'code:run', args: { script: 'return 1' } },
          canCodeRun: true,
          now: t,
        }),
      ).toBeNull();
    }
  });

  it('falls back to the wrapper name on malformed wrapper args', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv4',
        toolName: 'tools:invoke',
        args: { nope: 'no-name-key' },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.tool).toBe('tools:invoke');
  });
});

describe('maybeBatchNudge — pipeline kind (P-002): a chained burst is not "independent"', () => {
  const chainedCalls = [
    { toolName: 'work_items:release', args: { id: 'WI-4222', force: true } },
    { toolName: 'work_items:claim', args: { id: 'WI-4222', assignee: 'su-86bf' } },
    { toolName: 'work_items:comment', args: { id: 'WI-4222', body: 'reassigned' } },
  ];

  function fireChained(sessionKey: string): ReturnType<typeof maybeBatchNudge> {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const c of chainedCalls) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey, ...c, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    return firstFire;
  }

  it('fires kind=pipeline when the same id threads through different tools', () => {
    const hit = fireChained('pl1');
    expect(hit?.kind).toBe('pipeline');
    expect(hit?.text).toContain('CHAINED');
    // The old text's false exemption is gone: a chain must never be called independent.
    expect(hit?.text).not.toContain('independent fan-out');
  });

  it('renders a SEQUENTIAL skeleton (awaits in order, no Promise.all), args prefilled', () => {
    const hit = fireChained('pl2');
    expect(hit?.text).not.toContain('Promise.all');
    expect(hit?.text).toMatch(/const r0 = await tools\.workItems\.release\(\{"id":"WI-4222"/);
    expect(hit?.text).toMatch(/const r1 = await tools\.workItems\.claim\(/);
    expect(hit?.text).toContain('return { r0, r1, r2 }');
    expect(hit?.suggestedScript).toMatch(/const r0 = await tools\.workItems\.release\(\{"id":"WI-4222"/);
    expect(hit?.text).toContain(hit?.suggestedScript ?? '');
  });

  it('stays kind=fanout when the only shared values sit under ambient-context keys (harness etc.)', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of ['plans:get', 'docs:search', 'work_items:list']) {
      t += 1000;
      const r = maybeBatchNudge({
        sessionKey: 'pl3',
        toolName,
        args: { harness: 'papercusp' },
        canCodeRun: true,
        now: t,
      });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('fanout');
  });
});

describe('maybeBatchNudge — arg-prefilled skeletons (P-003)', () => {
  it('prefills the same-tool `inputs` list with the burst\'s actual args', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const id of ['WI-1111', 'WI-2222']) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf1', toolName: 'work_items:get', args: { id }, canCodeRun: true, now: t });
    }
    expect(hit?.text).toContain('{"id":"WI-1111"},');
    expect(hit?.text).toContain('{"id":"WI-2222"},');
    expect(hit?.text).toContain('extend this list');
    expect(hit?.suggestedScript).toContain('{"id":"WI-1111"},');
    expect(hit?.suggestedScript).toContain('{"id":"WI-2222"},');
    expect(hit?.text).toContain(hit?.suggestedScript ?? '');
  });

  it('prefills the fan-out skeleton with each tool\'s complete args, including an empty object', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    const calls = [
      { toolName: 'plans:get', args: { slug: 'alpha-plan' } },
      { toolName: 'docs:search', args: { q: 'beta-topic' } },
      { toolName: 'coord:presence', args: {} },
    ];
    for (const c of calls) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'pf2', ...c, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('fanout');
    expect(firstFire?.text).toContain('tools.plans.get({"slug":"alpha-plan"})');
    expect(firstFire?.text).toContain('tools.docs.search({"q":"beta-topic"})');
    expect(firstFire?.text).toContain('tools.coord.presence({})');
    expect(firstFire?.suggestedScript).toContain('tools.plans.get({"slug":"alpha-plan"})');
    expect(firstFire?.suggestedScript).toContain('tools.docs.search({"q":"beta-topic"})');
    expect(firstFire?.text).toContain(firstFire?.suggestedScript ?? '');
  });

  it('escapes backticks and ${ in prefilled args so the skeleton stays pasteable', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'pf3',
        toolName: 'docs:add',
        args: { text: 'a `tick` and ${x}' },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.text).toContain("\\`tick\\`");
    expect(hit?.text).toContain("\\${x}");
  });

  it('P008 G2 emits an executable example that preserves literal argument bytes', async () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    const text = 'literal `tick`, ${x}, newline\n and apostrophe \' end';
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ sessionKey: 'valid-example', toolName: 'docs:add', args: { text }, canCodeRun: true, now: i * 1000 });
    }
    expect(hit?.suggestedScript).toBeTruthy();
    const call = new Function(`return (${hit!.suggestedScript!.slice('code:run '.length)})`)() as { script: string };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const received: unknown[] = [];
    await new AsyncFunction('tools', call.script)({ docs: { add: async (args: unknown) => { received.push(args); return { ok: true }; } } });
    expect(received).toEqual(Array.from({ length: BATCH_NUDGE_THRESHOLD }, () => ({ text })));
  });

  it('P008 G2 does not invent arguments when the observed call supplied none', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, args: undefined, now: i * 1000 });
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.suggestedScript).toBeUndefined();
    expect(hit?.text).toContain('complete arguments');
  });

  it('P008 G2 omits an example rather than cutting an argument literal into invalid JavaScript', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    const big = 'x'.repeat(500);
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf4', toolName: 'docs:add', args: { text: big }, canCodeRun: true, now: t });
    }
    expect(hit?.suggestedScript).toBeUndefined();
    expect(hit?.text).not.toContain(big.slice(0, 50));
    expect(hit?.text).not.toContain('truncated');
    expect(hit?.text).toContain('complete arguments');
    expect(hit?.text.length).toBeLessThanOrEqual(1_000);
  });

  it('P008 G2 bounds repeated hints without replaying arguments or asserting timing groups are model turns', () => {
    const fires: NonNullable<ReturnType<typeof maybeBatchNudge>>[] = [];
    for (let i = 0; i < 20; i++) {
      const hit = maybeBatchNudge({ ...cap, sessionKey: 'blind45-repeat', args: { id: `WI-secret-history-${i}` }, now: i * 1000 });
      if (hit) fires.push(hit);
    }
    expect(fires.length).toBeGreaterThanOrEqual(2);
    expect(fires[0].text).toContain('Timing alone cannot identify model turns');
    for (const hit of fires.slice(1)) {
      expect(hit.text.length).toBeLessThanOrEqual(250);
      expect(hit.text).not.toContain('WI-secret-history');
      expect(hit.text).not.toContain('separate turns');
      expect(hit.suggestedScript).toBeUndefined();
      expect(hit.text).toContain('already grouped');
      expect(hit.text).toContain('recovery');
    }
  });

  it('reports the effective tool on every result (plain calls too)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf5', toolName: 'plans:get', canCodeRun: true, now: t });
    }
    expect(hit?.tool).toBe('plans:get');
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * EI-10894 — the PREDICTIVE trigger. The reactive nudges above all key on round-trips ALREADY
 * spent; this one fires on the list result, BEFORE the per-row calls are paid. Because it fires
 * on a prediction it can be WRONG in a way they cannot, so most of these tests are teeth on the
 * guards that keep a wrong fire from happening.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** N rows of `{ id, title }` — the shape a list verb hands back. */
function rows(n: number, key = 'id'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_v, i) => ({ [key]: `WI-${1000 + i}`, title: `item ${i}` }));
}

const listCall = {
  sessionKey: 'p1',
  toolName: 'work_items:list',
  canCodeRun: true,
};

describe('maybeListFanoutPreempt — fires on the LIST, before the per-row round-trips', () => {
  it('fires at >5 addressable rows, and NOT at 5 (the same call, one row short)', () => {
    const under = maybeListFanoutPreempt({
      ...listCall,
      payload: () => rows(LIST_FANOUT_MIN_ROWS - 1),
      now: 1000,
    });
    expect(under).toBeNull();

    _resetBatchNudgeState();
    const hit = maybeListFanoutPreempt({
      ...listCall,
      payload: () => rows(LIST_FANOUT_MIN_ROWS),
      now: 1000,
    });
    expect(hit?.kind).toBe('preempt');
    expect(hit?.tool).toBe('work_items:list');
  });

  it('extracts the real ids into the skeleton — acting on it is a paste, not a transcription', () => {
    const hit = maybeListFanoutPreempt({ ...listCall, payload: () => rows(8), now: 1000 });
    expect(hit?.text).toContain('"WI-1000"');
    expect(hit?.text).toContain('"WI-1007"');
    // The ids are bound to the key they were found under, and fanned out in ONE call.
    expect(hit?.text).toContain('const ids = [');
    expect(hit?.text).toContain('Promise.all');
    // 8 rows ⇒ the felt cost is stated as 8 round-trips NOT YET paid.
    expect(hit?.text).toContain('8 rows');
    expect(hit?.text).toContain('independent per-row reads');
    expect(hit!.text.length).toBeLessThanOrEqual(1_000);
  });

  it('binds the skeleton to the identifier the rows ACTUALLY carry (slug, not id)', () => {
    const hit = maybeListFanoutPreempt({
      ...listCall,
      toolName: 'plans:list',
      payload: () => rows(7, 'slug'),
      now: 1000,
    });
    expect(hit?.text).toContain('const slugs = [');
    expect(hit?.text).toContain('.map((slug) =>');
    expect(hit?.text).not.toContain('const ids = [');
  });

  it('finds the rows one hop down — the `{ results: [...] }` shape most list verbs return', () => {
    const hit = maybeListFanoutPreempt({
      ...listCall,
      toolName: 'sessions:search',
      payload: () => ({ ok: true, total: 9, results: rows(9) }),
      now: 1000,
    });
    expect(hit?.kind).toBe('preempt');
    expect(hit?.text).toContain('9 rows');
  });

  it('owns its own conditionality — a wrong fire costs one line, not the agent’s trust', () => {
    const hit = maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 1000 });
    expect(hit?.text).toContain('If you were only reading the list, ignore this');
  });

  it('P008 G2 bounds a predictive hint with long identifiers without cutting literals', () => {
    const ids = Array.from({ length: 8 }, (_, i) => ({ id: `record-${i}-` + 'x'.repeat(100) }));
    const hit = maybeListFanoutPreempt({ ...listCall, payload: () => ids, now: 1000 });
    expect(hit?.kind).toBe('preempt');
    expect(hit!.text.length).toBeLessThanOrEqual(1_000);
    expect(hit?.text).not.toContain('const ids');
    expect(hit?.text).toContain('complete identifiers');
  });
});

describe('maybeListFanoutPreempt — the guards against a WRONG prediction', () => {
  it('stays SILENT for a caller who already used code:run — they need no lecture', () => {
    // Same list, same rows: the ONLY difference is a code:run earlier in the session.
    const beforeBatching = maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 1000 });
    expect(beforeBatching).not.toBeNull();

    _resetBatchNudgeState();
    maybeListFanoutPreempt({
      ...listCall,
      toolName: 'code:run',
      payload: () => ({}),
      now: 1000,
    });
    const afterBatching = maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 2000 });
    expect(afterBatching).toBeNull();
  });

  it('re-arms once the code:run is stale — a batch 20 minutes ago is not a habit', () => {
    maybeListFanoutPreempt({ ...listCall, toolName: 'code:run', payload: () => ({}), now: 1000 });
    expect(
      maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 1000 + CODE_RUN_RECENT_MS + 1 }),
    ).not.toBeNull();
  });

  it('ignores a NON-list verb returning the very same rows (coord:orient is nobody’s fan-out)', () => {
    expect(
      maybeListFanoutPreempt({
        ...listCall,
        toolName: 'coord:orient',
        payload: () => ({ claimable: rows(9) }),
        now: 1000,
      }),
    ).toBeNull();
  });

  it('ignores rows that are not ADDRESSABLE — no per-row key means no per-row fan-out', () => {
    const unaddressable = Array.from({ length: 9 }, (_v, i) => ({ title: `t${i}`, count: i }));
    expect(maybeListFanoutPreempt({ ...listCall, payload: () => unaddressable, now: 1000 })).toBeNull();
  });

  it('ignores a set where only a MINORITY of rows carry the id (a heterogeneous blob)', () => {
    const mixed = [...rows(2), ...Array.from({ length: 7 }, (_v, i) => ({ title: `t${i}` }))];
    expect(maybeListFanoutPreempt({ ...listCall, payload: () => mixed, now: 1000 })).toBeNull();
  });

  it('is ONE-SHOT per (session, tool) — it fires on a guess, so it never nags', () => {
    expect(maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 1000 })).not.toBeNull();
    expect(maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 2000 })).toBeNull();
    expect(maybeListFanoutPreempt({ ...listCall, payload: () => rows(9), now: 900_000 })).toBeNull();
  });

  it('caps the session — a listing-heavy session is not a nudging-heavy session', () => {
    const tools = ['work_items:list', 'plans:list', 'docs:search', 'coord:feed', 'events:catalog'];
    const fired = tools.filter(
      (t, i) =>
        maybeListFanoutPreempt({
          sessionKey: 'cap1',
          toolName: t,
          canCodeRun: true,
          payload: () => rows(9),
          now: 1000 + i,
        }) !== null,
    );
    expect(fired).toHaveLength(MAX_PREEMPT_PER_SESSION);
  });

  it('does not burn a cap slot on a call that produced NO hint', () => {
    // Three list calls too small to fire, then three that should — the cap must be intact.
    for (let i = 0; i < 3; i++) {
      maybeListFanoutPreempt({
        sessionKey: 'cap2',
        toolName: `x${i}:list`,
        canCodeRun: true,
        payload: () => rows(2),
        now: 1000 + i,
      });
    }
    const fired = [0, 1, 2].filter(
      (i) =>
        maybeListFanoutPreempt({
          sessionKey: 'cap2',
          toolName: `y${i}:list`,
          canCodeRun: true,
          payload: () => rows(9),
          now: 2000 + i,
        }) !== null,
    );
    expect(fired).toHaveLength(MAX_PREEMPT_PER_SESSION);
  });

  it('never nudges a caller who cannot run code:run', () => {
    expect(
      maybeListFanoutPreempt({ ...listCall, canCodeRun: false, payload: () => rows(9), now: 1000 }),
    ).toBeNull();
  });

  it('does not materialize the payload unless every cheap gate has already passed', () => {
    let parsed = 0;
    const payload = (): unknown => {
      parsed++;
      return rows(9);
    };
    // Not list-shaped ⇒ the thunk must never be called (this is the MCP hot path).
    maybeListFanoutPreempt({ ...listCall, toolName: 'work_items:get', payload, now: 1000 });
    expect(parsed).toBe(0);
    // List-shaped ⇒ parsed exactly once.
    maybeListFanoutPreempt({ ...listCall, payload, now: 1000 });
    expect(parsed).toBe(1);
  });

  it('treats an unparseable body as nothing-to-judge, never as an error', () => {
    expect(() =>
      maybeListFanoutPreempt({
        ...listCall,
        payload: () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
        now: 1000,
      }),
    ).not.toThrow();
  });

  it('unwraps a tools:invoke-routed list call (and a wrapper-routed code:run still counts as batching)', () => {
    const hit = maybeListFanoutPreempt({
      sessionKey: 'inv1',
      toolName: 'tools:invoke',
      args: { name: 'work_items:list', args: { state: 'todo' } },
      canCodeRun: true,
      payload: () => rows(9),
      now: 1000,
    });
    expect(hit?.tool).toBe('work_items:list');

    _resetBatchNudgeState();
    maybeListFanoutPreempt({
      sessionKey: 'inv2',
      toolName: 'tools:invoke',
      args: { name: 'code:run', args: { script: '…' } },
      canCodeRun: true,
      payload: () => ({}),
      now: 1000,
    });
    expect(
      maybeListFanoutPreempt({
        sessionKey: 'inv2',
        toolName: 'work_items:list',
        canCodeRun: true,
        payload: () => rows(9),
        now: 2000,
      }),
    ).toBeNull();
  });
});

/** WI-40720. `isPreferredDoor` and the two norm sets are EXPORTED FROM THIS MODULE, so their
 *  direct classification tests belong here — the wider derivation guards (that every SQL predicate
 *  interpolates the same set) live in code-run-adoption.test.ts, where the SQL constants are.
 *
 *  Why this predicate exists: the door set was hand-copied across nine sites and `orchestrate:run`
 *  was missing from every one, so preferred-door usage went unmeasured in adoption, in nudge
 *  conversion, and in the post-door telemetry backfill. Anywhere that used to ask
 *  `toolName === 'code:run'` must ask this instead. */
describe('isPreferredDoor — the door classifier the nine hardcoded copies used to each re-implement', () => {
  it('accepts every door, in both the verb and MCP spellings', () => {
    for (const norm of PREFERRED_DOOR_NORMS) expect(isPreferredDoor(norm), norm).toBe(true);
    expect(isPreferredDoor('code:run')).toBe(true);
    expect(isPreferredDoor('code_run')).toBe(true);
    expect(isPreferredDoor('recipes:run')).toBe(true);
    expect(isPreferredDoor('recipes_run')).toBe(true);
    expect(isPreferredDoor('orchestrate:run')).toBe(true);
    expect(isPreferredDoor('orchestrate_run')).toBe(true);
  });

  it('pins orchestrate:run specifically — the door whose absence caused this work', () => {
    // Not redundant with the loop above: that loop would pass just as happily on a set this
    // door had been dropped from. This is the regression itself.
    expect(isPreferredDoor('orchestrate:run')).toBe(true);
    expect(PREFERRED_DOOR_NORMS.has('orchestraterun')).toBe(true);
  });

  it('rejects near-misses — normalization strips punctuation, so the risk is over-matching', () => {
    expect(isPreferredDoor('orchestrate:trace')).toBe(false);
    expect(isPreferredDoor('recipes:search')).toBe(false);
    expect(isPreferredDoor('work_items:get')).toBe(false);
    expect(isPreferredDoor('')).toBe(false);
  });

  it('never nudges a door at itself — every door is excluded by construction', () => {
    for (const norm of PREFERRED_DOOR_NORMS) {
      expect(EXCLUDED_TOOL_NORMS.has(norm), `${norm} is a door but nudgeable`).toBe(true);
    }
  });
});

describe('maybeBatchNudge — the fold must FIT the script budget (EI-21254965187146713)', () => {
  // The founding incident: the hint told an agent to chain testing:run calls inside one script,
  // prefilled with its own args and escalating on repetition. The script's budget is 30s; the
  // dispatch stack grants a single child 60s (`exec.tool.timeoutSec ?? 60`). The fold was killed
  // at 30s, four dispatches were spent for nothing, and the work was finished with the individual
  // calls the hint had discouraged. Complying cost strictly MORE than ignoring it.
  const burst = (durationMs: number | undefined, opts: { tool?: string; times?: number } = {}) => {
    const tool = opts.tool ?? 'testing:run';
    const times = opts.times ?? BATCH_NUDGE_THRESHOLD;
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < times; i++) {
      // EI-23762928303536326: this helper models SEQUENTIAL turns, so each dispatch must land after
      // the previous call RETURNED — t advances by the call's own duration plus an inference gap.
      // Spacing them closer than `durationMs` would describe a PARALLEL block, which clusterTurns'
      // in-flight guard correctly folds into one turn; the budget triggers under test would then
      // never fire and every assertion below would be vacuous. (Undefined duration keeps the
      // original 1000ms spacing exactly, so the no-timing control is unchanged.)
      t += (durationMs ?? 0) + 1000;
      hit = maybeBatchNudge({ sessionKey: 's-budget', toolName: tool, args: {}, canCodeRun: true, now: t, durationMs });
    }
    return hit;
  };

  it('stays silent when even the SLOWEST call cannot finish within the foreground ceiling', () => {
    // WI-2142449: same-tool folds as Promise.all (max, not sum), so parallelism cannot rescue a
    // single branch that is itself too slow — 55s alone is past the 50s ceiling. There is no
    // timeoutSec that rescues this, so the honest move is to say nothing: a recommendation that
    // cannot succeed is worse than none, because it spends a round-trip teaching the agent to
    // distrust the hint.
    expect(burst(55_000)).toBeNull();
  });

  it('CONTROL: the identical burst WITHOUT timing still fires — measurement is what suppresses it', () => {
    // Without this control, the test above passes just as happily if the suppression were caused
    // by the tool name, the burst shape, or a broken trigger. Same session shape, same tool, same
    // call count; the ONLY difference is that no duration was recorded.
    const hit = burst(undefined);
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.suggestedScript).toContain('testing:run');
  });

  it('fires unchanged for a fast burst — no timeoutSec on a fold that fits the default budget', () => {
    const hit = burst(200);
    expect(hit?.kind).toBe('same-tool');
    // Emitting the arg unconditionally would teach that it is always required.
    expect(hit?.suggestedScript).toContain('code:run { script:');
    expect(hit?.suggestedScript).not.toContain('timeoutSec');
    expect(hit?.text).not.toContain('script budget');
  });

  it('fires WITH a fitting timeoutSec when the SLOWEST call overruns the default but not the ceiling', () => {
    // WI-2142449: same-tool folds as Promise.all (max, not sum) — a single 32s call alone (+2s fold
    // overhead) pushes past the 30s default, well inside the 50s ceiling. The skeleton must carry
    // the budget that makes it work, not be suppressed.
    const hit = burst(32_000);
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.suggestedScript).toMatch(/code:run \{ timeoutSec: 34, script:/);
    expect(hit?.text).toContain('script budget');
  });

  it('WI-2142449 regression: the reported ~6s-per-call dev:pipeline_position shape fits by default as a max — it would have needed a raised budget as a sum', () => {
    // The reported incident: 8 dev:pipeline_position calls at ~3-6s each, hand-looped SEQUENTIALLY,
    // blew the 30s script_timeout. As a SEQUENTIAL sum over just the first two (the earliest point
    // the trigger can fire) that is already 12s; over a realistic 6-call burst it would be 36s —
    // past the 30s default, needing an explicit raised budget. As the Promise.all fold this
    // skeleton now emits, the script waits only for the slowest branch: 6s, comfortably inside the
    // default with no timeoutSec required at all. (Captures the FIRST fire, not `burst`'s last —
    // continuing calls past the first trip the exponential backoff, which is a different guard.)
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    const perCall = 6_000;
    for (let i = 0; i < 8; i++) {
      // HAND-LOOPED SEQUENTIALLY is the whole premise of this regression (the agent waited for each
      // call before making the next), so the dispatches must be a full call apart — not 1s apart,
      // which would describe the parallel block clusterTurns now folds into one turn.
      t += perCall + 1_000;
      const r = maybeBatchNudge({
        sessionKey: 's-budget-8call',
        toolName: 'dev:pipeline_position',
        args: {},
        canCodeRun: true,
        now: t,
        durationMs: perCall,
      });
      if (r && !hit) hit = r;
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.suggestedScript).toContain('Promise.all');
    expect(hit?.suggestedScript).toContain('code:run { script:');
    expect(hit?.suggestedScript).not.toContain('timeoutSec');
    expect(hit?.text).not.toContain('script budget');
  });

  it('declining to recommend does NOT consume the backoff — the next foldable burst still fires', () => {
    // The caller did nothing wrong. Burning their cooldown here would silence the NEXT burst,
    // which may well be foldable — turning one bad recommendation into a lasting blind spot.
    expect(burst(55_000)).toBeNull();
    // Past the END of that burst plus a full NUDGE_WINDOW_MS. `burst` now spaces its dispatches by
    // the call duration (EI-23762928303536326), so a 55s burst runs out to ~112s — a "fresh window"
    // at 100s would sit BEFORE it, leaving the testing:run calls in the ring and the clock moving
    // backwards. This must stay comfortably clear of burst's end, not merely a round number.
    let t = 300_000; // a fresh window, same session
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 's-budget',
        toolName: 'work_items:get',
        canCodeRun: true,
        now: t,
        durationMs: 150,
      });
    }
    expect(hit?.kind).toBe('same-tool');
    // First fire for this session ⇒ no escalation banner. A consumed nudgeCount would show here.
    expect(hit?.text).not.toContain('reminder this session');
  });

  it('projects fan-out as the SLOWEST branch, not the sum — Promise.all does not add up', () => {
    // Three independent 15s reads: sequentially 45s, but the fan-out skeleton is a Promise.all, so
    // the script waits ~15s. Summing here would suppress a fold that is not only valid but is
    // exactly the case parallelism was for.
    let t = 0;
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (const tool of ['plans:get', 'work_items:get', 'issues:list']) {
      // Distinct inference turns: each dispatch follows the previous call's RETURN (15s) plus an
      // inference gap. A 1.2s spacing with 15s calls would be a parallel block, which clusterTurns'
      // in-flight guard folds into one turn — no fan-out trigger, and nothing here would be tested.
      t += 15_000 + TURN_GAP_MS * 3;
      hit = maybeBatchNudge({ sessionKey: 's-fan', toolName: tool, args: {}, canCodeRun: true, now: t, durationMs: 15_000 });
    }
    expect(hit?.kind).toBe('fanout');
    expect(hit?.suggestedScript).toContain('Promise.all');
    expect(hit?.suggestedScript).not.toContain('timeoutSec');
  });

  it('CONTROL: the same fan-out at a duration that overruns even in parallel IS suppressed', () => {
    // Guards the test above from passing because fan-out is simply never gated: raise the SLOWEST
    // branch past the ceiling and the same shape must go quiet.
    // This control asserts NULL, so it is the one most easily made VACUOUS — there are three
    // different ways to get null here and only one of them is the budget gate under test:
    //   1. dispatches spaced closer than their duration ⇒ clusterTurns' in-flight guard folds them
    //      into ONE turn and the fan-out trigger never fires (EI-23762928303536326);
    //   2. three SEQUENTIAL 55s calls span ~168s ⇒ the first is trimmed out of the 90s
    //      NUDGE_WINDOW_MS, leaving too few distinct tools to trigger;
    //   3. the intended reason: the fold is projected past the foreground ceiling.
    // Fan-out is projected as the SLOWEST branch, so one slow branch is all the ceiling needs —
    // keeping the other two fast makes the burst fit the window AND stay genuinely sequential.
    const branches: [string, number][] = [
      ['plans:get', 200],
      ['work_items:get', 200],
      ['issues:list', 55_000],
    ];
    let t = 0;
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (const [tool, durationMs] of branches) {
      t += TURN_GAP_MS * 3; // a real inference gap, and past every preceding call's return
      hit = maybeBatchNudge({ sessionKey: 's-fan2', toolName: tool, canCodeRun: true, now: t, durationMs });
      t += durationMs; // …this call returns before the next is dispatched
    }
    expect(hit).toBeNull();
  });
});

// EI-23761431768707969 — the batch-hint and the result door's per-turn fan-out budget gave OPPOSED
// advice: widening a turn is what CAUSES a sibling to spill, and the door then tells the agent to
// re-issue that one call — a round-trip the hint counted as an unforced separate turn and nagged
// ("default to code:run now"). `aggregateSpill` lets the host tell the nudge which call the door
// spilled, so the single re-issue it asked for is not charged against the agent.
describe('maybeBatchNudge — a door-forced re-issue after an aggregate spill is not a chosen round-trip', () => {
  const K = 'wi-spill';
  const call = (o: { now: number; aggregateSpill?: boolean; durationMs?: number }) =>
    maybeBatchNudge({ sessionKey: K, toolName: 'work_items:get', canCodeRun: true, ...o });

  it('CONTROL: two same-tool calls in separate turns DO nudge when nothing spilled (the trigger is live)', () => {
    expect(call({ now: 0 })).toBeNull();
    expect(call({ now: 5_000 })?.kind).toBe('same-tool');
  });

  it('the identical sequence stays silent once the first call carries aggregateSpill (paired with the control)', () => {
    expect(call({ now: 0, aggregateSpill: true })).toBeNull();
    expect(call({ now: 5_000 })).toBeNull(); // the re-issue the door asked for — forced, not chosen
  });

  it('an explicit aggregateSpill:false forgives nothing', () => {
    expect(call({ now: 0, aggregateSpill: false })).toBeNull();
    expect(call({ now: 5_000 })?.kind).toBe('same-tool');
  });

  it('one spill forgives exactly ONE re-issue — the next chosen call nudges again', () => {
    call({ now: 0, aggregateSpill: true });
    expect(call({ now: 5_000 })).toBeNull(); // forced
    expect(call({ now: 10_000 })?.kind).toBe('same-tool'); // chosen: the spilled turn + this one
  });

  it('a same-turn sibling that merely COMPLETES after the spill is not mistaken for the re-issue', () => {
    // The spilled call is still in flight (2s) when its sibling is dispatched, so nothing about the
    // sibling was forced by the spill. If it consumed the forgiveness, the REAL re-issue below would
    // count as a separate chosen turn and fire — which is what flips this assertion red.
    call({ now: 0, aggregateSpill: true, durationMs: 2_000 });
    call({ now: 100, durationMs: 50 });
    expect(call({ now: 10_000 })).toBeNull();
  });

  it('a DIFFERENT tool is not forgiven — only the re-issue of the spilled tool is', () => {
    const t = (toolName: string, now: number, args?: unknown, aggregateSpill?: boolean) =>
      maybeBatchNudge({ sessionKey: K, toolName, args, canCodeRun: true, now, aggregateSpill });
    t('work_items:list', 0, undefined, true);
    t('plans:get', 5_000, { slug: 'alpha-plan' });
    // three distinct tools in three separate turns is a real fan-out: spilling the first must not hide it
    expect(t('docs:search', 10_000, { q: 'beta-topic' })).not.toBeNull();
  });

  it('forgiveness lapses after FORCED_REISSUE_WINDOW_MS, so a late same-tool call counts as chosen', () => {
    call({ now: 0, aggregateSpill: true });
    expect(call({ now: FORCED_REISSUE_WINDOW_MS + 1 })?.kind).toBe('same-tool');
  });

  it('the forgiveness window never outlives the nudge window (nothing left to forgive AGAINST)', () => {
    expect(FORCED_REISSUE_WINDOW_MS).toBeLessThanOrEqual(NUDGE_WINDOW_MS);
  });

  it('WIRING PIN: the MCP host feeds the door verdict into maybeBatchNudge (else the whole mechanism is inert)', () => {
    // The nudge cannot see the result door; the host is the only seam that has both. Dropping this
    // one line leaves every unit test above green while production never forgives anything.
    const host = readFileSync(
      new URL('./endpoint-route/routes/transport/_mcp-host.ts', import.meta.url),
      'utf8',
    );
    expect(host).toContain("aggregateSpill: doorMeta?.reason === 'aggregate-output-budget-exceeded'");
  });
});
