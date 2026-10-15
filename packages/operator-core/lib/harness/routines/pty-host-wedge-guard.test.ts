/**
 * Tests for the wake-deaf pty-host guard (EI-20287339148365013).
 *
 * Several of these encode facts that were WRONG in the first draft and were corrected by
 * calibrating against the live host population. They are marked as such, because a guard
 * whose assumptions were falsified once is exactly the guard that needs them pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyComposerWedge,
  classifyBusyGateWedge,
  sweepWedgedPtyHosts,
  DEFER_KIND,
  BUSY_GATE_KIND,
  DEFAULT_MIN_CONSECUTIVE_DEFERS,
  DEFAULT_MIN_STREAK_SPAN_MS,
  DEFAULT_MIN_BUSY_GATE_DEFERS,
  DEFAULT_MIN_BUSY_STREAK_SPAN_MS,
  DEFAULT_BUSY_GATE_MAX_QUIET_FRACTION,
  type PtyHostWedgeSweepDeps,
} from './pty-host-wedge-guard';
import type { PtyHostEvent, PsuPtyHost } from '../../events/await/psu-pty-discovery';

const HOST_STARTED = Date.parse('2026-08-12T06:00:00.000Z');
const NOW = Date.parse('2026-08-12T22:00:00.000Z');

/** A run of defers ending at `endIso`, spaced `spacingMs` apart, oldest-first. */
function defers(
  count: number,
  opts: { pendingLength?: number; endMs?: number; spacingMs?: number; forensics?: boolean } = {},
): PtyHostEvent[] {
  const { pendingLength = 11, endMs = NOW - 60_000, spacingMs = 10 * 60_000, forensics = false } = opts;
  const out: PtyHostEvent[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      ts: new Date(endMs - i * spacingMs).toISOString(),
      kind: DEFER_KIND,
      reason: 'owner-input-cap',
      pendingLength,
      ...(forensics ? { pendingAgeMs: 120_000, ownerQuietMs: 120_000 } : {}),
    });
  }
  return out;
}

function ev(kind: string, atMs: number, extra: Record<string, unknown> = {}): PtyHostEvent {
  return { ts: new Date(atMs).toISOString(), kind, ...extra };
}

function classify(events: PtyHostEvent[], over: Partial<Parameters<typeof classifyComposerWedge>[0]> = {}) {
  return classifyComposerWedge({ events, startedAtMs: HOST_STARTED, now: NOW, ...over });
}

describe('classifyComposerWedge', () => {
  it('names a host whose wakes are all deferred against one unchanging staged line', () => {
    const v = classify(defers(12));
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
    expect(v.pendingLength).toBe(11);
    expect(v.reason).toContain('11-char');
  });

  it('reports no wedge when the ledger holds no deferrals at all', () => {
    const v = classify([ev('respawned', NOW - 60_000)]);
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(0);
  });

  // THE SCOPING TRAP. The per-owner ledger OUTLIVES the host process; counting unscoped
  // charged four hosts with their predecessors' incidents (2026-08-12 retraction).
  it('ignores deferrals from a PREVIOUS host incarnation', () => {
    const previous = defers(30, { endMs: HOST_STARTED - 60_000 });
    const mine = defers(2, { endMs: NOW - 60_000 });
    const v = classify([...previous, ...mine]);
    expect(v.consecutiveDefers).toBe(2);
    expect(v.wedged).toBe(false);
  });

  it('counts a run that is exactly at the floor, and not one below it', () => {
    expect(classify(defers(DEFAULT_MIN_CONSECUTIVE_DEFERS)).wedged).toBe(true);
    expect(classify(defers(DEFAULT_MIN_CONSECUTIVE_DEFERS - 1)).wedged).toBe(false);
  });

  // THE FALSE-POSITIVE CONTROL. A person's line changes length as they type, so each defer
  // starts a fresh run of one — a human can never accumulate a streak however long they
  // leave a message unsent.
  it('never accumulates a streak for a human typing (the staged length moves)', () => {
    const typing: PtyHostEvent[] = [];
    for (let i = 0; i < 30; i++) {
      typing.push(...defers(1, { pendingLength: 10 + i, endMs: NOW - (30 - i) * 60_000 }));
    }
    const v = classify(typing);
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(1);
  });

  it('treats a different staged length as a run BOUNDARY, not a poisoned run', () => {
    // A long phantom episode, then one defer against a different line (su-efa8b152's shape).
    const v = classify([...defers(20, { pendingLength: 11, endMs: NOW - 120 * 60_000 }), ...defers(1, { pendingLength: 31 })]);
    expect(v.consecutiveDefers).toBe(1);
    expect(v.pendingLength).toBe(31);
    expect(v.wedged).toBe(false);
  });

  // CALIBRATION REGRESSION GUARD. Trusting carry-delivery as proof the composer cleared
  // cut recall from 3 known-wedged hosts to 1: on su-91ef0643 the phantom demonstrably
  // SURVIVES `respawned` + `respawn-carry-delivered`, twice, across four hours.
  it('does NOT treat a respawn or its carry delivery as clearing the staged line', () => {
    const v = classify([
      ...defers(6, { endMs: NOW - 200 * 60_000 }),
      ev('respawned', NOW - 190 * 60_000),
      ev('respawn-carry-delivered', NOW - 189 * 60_000),
      ...defers(6, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
  });

  it('DOES end the run at an explicit composer clear', () => {
    const v = classify([
      ...defers(20, { endMs: NOW - 200 * 60_000 }),
      ev('owner-composer-wedge-cleared', NOW - 190 * 60_000),
      ...defers(3, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(3);
    expect(v.wedged).toBe(false);
  });

  it('ends the run when a human is observed typing', () => {
    const v = classify([
      ...defers(20, { endMs: NOW - 200 * 60_000 }),
      ev('owner-input-during-compact-wait', NOW - 190 * 60_000),
      ...defers(2, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(false);
  });

  it('steps over unrelated lifecycle events without breaking the run', () => {
    const v = classify([
      ...defers(6, { endMs: NOW - 200 * 60_000 }),
      ev('mcp-reconnect-started', NOW - 190 * 60_000),
      ev('stale-fire-dropped', NOW - 185 * 60_000),
      ev('wake-turn-deferred-for-pending-respawn', NOW - 180 * 60_000, { reason: 'pending-respawn' }),
      ...defers(6, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
  });

  it('refuses a burst — many deferrals inside a span too short to be a wedge', () => {
    const v = classify(defers(20, { spacingMs: 1_000 }));
    expect(v.wedged).toBe(false);
    expect(v.streakSpanMs).toBeLessThan(DEFAULT_MIN_STREAK_SPAN_MS);
    expect(v.reason).toContain('backpressure');
  });

  it('reports whether the host emitted the forensics fields the in-host breaker keys on', () => {
    expect(classify(defers(12, { forensics: false })).emitsForensics).toBe(false);
    expect(classify(defers(12, { forensics: true })).emitsForensics).toBe(true);
    // The absence is the "cannot self-heal" signature, so it must reach the human-readable line.
    expect(classify(defers(12, { forensics: false })).reason).toContain('too old');
  });

  it('stops at an event with no readable timestamp rather than crediting it to this host', () => {
    const v = classify([...defers(6, { endMs: NOW - 200 * 60_000 }), { kind: DEFER_KIND, pendingLength: 11 }]);
    expect(v.consecutiveDefers).toBe(0);
  });
});

/**
 * THE LAYERING PROPERTY, asserted mechanically rather than documented.
 *
 * This guard is only meaningful if it sits ABOVE the in-host breaker: a host running
 * current code must break its own wedge before this ever names it, so that a firing here
 * is itself evidence the first-line fix could not run. Raising the breaker's default past
 * this floor would silently invert that, and nothing else in either file would fail.
 */
describe('threshold layering against the in-host breaker', () => {
  it('sits strictly above psu-pty-host.mjs shouldBreakComposerWedge maxDefers default', () => {
    const source = readFileSync(
      new URL('../../../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    // Anchored to the shouldBreakComposerWedge destructuring specifically, so a stray
    // `maxDefers = <small number>` elsewhere in the file cannot make this pass vacuously.
    // `[\d_]` because the source writes numeric separators (`minQuietMs = 90_000`).
    const m = /minQuietMs\s*=\s*[\d_]+,\s*maxDefers\s*=\s*([\d_]+)/.exec(source);
    expect(m, 'could not find the in-host breaker maxDefers default — did it move?').toBeTruthy();
    const inHostDefault = Number(m![1].replace(/_/g, ''));
    expect(Number.isFinite(inHostDefault)).toBe(true);
    expect(inHostDefault).toBeGreaterThan(0);
    expect(DEFAULT_MIN_CONSECUTIVE_DEFERS).toBeGreaterThan(inHostDefault);
  });
});

/**
 * Tests for the SECOND wedge class (WI-2141553) — a busy-gate streak.
 *
 * The invariant under test is the discriminator: the run's longest observed quiet gap
 * staying near zero. Two of these are false-POSITIVE controls rather than feature tests,
 * because this class's dangerous error is naming a healthy agent that is simply working.
 */
const QUIET_CAP_MS = 1_500;

/** A run of busy-gate defers ending at `endMs`, spaced `spacingMs` apart, oldest-first. */
function busyDefers(
  count: number,
  opts: {
    mode?: string;
    observedMaxQuietMs?: number | null;
    quietMs?: number | null;
    endMs?: number;
    spacingMs?: number;
  } = {},
): PtyHostEvent[] {
  const {
    mode = 'turn',
    observedMaxQuietMs = 0,
    quietMs = QUIET_CAP_MS,
    endMs = NOW - 60_000,
    spacingMs = 15 * 60_000,
  } = opts;
  const out: PtyHostEvent[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      ts: new Date(endMs - i * spacingMs).toISOString(),
      kind: BUSY_GATE_KIND,
      mode,
      capMs: 120_000,
      observedMaxQuietMs,
      quietMs,
    });
  }
  return out;
}

function classifyBusy(
  events: PtyHostEvent[],
  over: Partial<Parameters<typeof classifyBusyGateWedge>[0]> = {},
) {
  return classifyBusyGateWedge({ events, startedAtMs: HOST_STARTED, now: NOW, ...over });
}

describe('classifyBusyGateWedge', () => {
  it('names a host whose deliveries all expired against a pty that never fell silent', () => {
    const v = classifyBusy(busyDefers(10));
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(10);
    expect(v.observedMaxQuietMs).toBe(0);
    expect(v.quietCapMs).toBe(QUIET_CAP_MS);
    expect(v.modes).toEqual(['turn']);
    expect(v.reason).toContain('never observed at its prompt');
  });

  // ⚠ THE NULL TRAP, and the single most important test in this block. Both quiet fields are
  // nullable at the emitter. Reading a null as "near zero" would MANUFACTURE a wedge verdict
  // out of missing data — on a detector that pages a human.
  it('refuses to read a NULL observedMaxQuietMs as near-zero', () => {
    const v = classifyBusy(busyDefers(20, { observedMaxQuietMs: null }));
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(0);
    expect(v.reason).toContain('no usable');
  });

  it('refuses to judge a defer whose quietMs threshold is missing', () => {
    const v = classifyBusy(busyDefers(20, { quietMs: null }));
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(0);
  });

  // The OTHER half of the emitter's documented pair: a gap approaching the cap means the
  // threshold is merely too tight, which resolves on its own and has the OPPOSITE fix.
  it('does not name a near-miss against a too-tight cap', () => {
    const v = classifyBusy(busyDefers(20, { observedMaxQuietMs: QUIET_CAP_MS - 1 }));
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('near-miss');
  });

  it('treats a near-miss defer as a run BOUNDARY, keeping only the newer episode', () => {
    const v = classifyBusy([
      ...busyDefers(10, { endMs: NOW - 400 * 60_000 }),
      ...busyDefers(1, { observedMaxQuietMs: QUIET_CAP_MS - 1, endMs: NOW - 380 * 60_000 }),
      ...busyDefers(3, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(3);
    expect(v.wedged).toBe(false);
  });

  // ⚠ THE FALSE-POSITIVE CONTROL THIS CLASS EXISTS TO SURVIVE. A genuinely long turn emits
  // continuously, so its longest quiet gap is ALSO ≈0 and it is indistinguishable from a
  // wedge to the discriminator. Only the span floor separates them — and long turns are
  // ordinary here: the green-checkpoint gate suite alone runs ~55 minutes.
  it('never names a long but legitimate turn (a ~55m suite deferring every wake)', () => {
    const v = classifyBusy(busyDefers(12, { spacingMs: 5 * 60_000 }));
    expect(v.streakSpanMs).toBeLessThan(DEFAULT_MIN_BUSY_STREAK_SPAN_MS);
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('long legitimate turn');
  });

  it('counts a run exactly at the defer floor, and not one below it', () => {
    expect(classifyBusy(busyDefers(DEFAULT_MIN_BUSY_GATE_DEFERS)).wedged).toBe(true);
    const below = classifyBusy(busyDefers(DEFAULT_MIN_BUSY_GATE_DEFERS - 1));
    // Isolates the DEFER floor: at 15m spacing this run still clears the span floor, so the
    // count is the only thing that can be refusing it.
    expect(below.streakSpanMs).toBeGreaterThanOrEqual(DEFAULT_MIN_BUSY_STREAK_SPAN_MS);
    expect(below.wedged).toBe(false);
  });

  // carry-respawn already had durable coverage pre-WI-2141048 and owns its own re-arm
  // lifecycle, so it is NEUTRAL here: not counted, and — the half that would truncate real
  // streaks if it were wrong — not treated as clearing either.
  it('steps over a carry-respawn defer without counting or breaking the run', () => {
    const v = classifyBusy([
      ...busyDefers(5, { endMs: NOW - 400 * 60_000 }),
      ...busyDefers(1, { mode: 'carry-respawn', endMs: NOW - 380 * 60_000 }),
      ...busyDefers(5, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(10);
    expect(v.modes).toEqual(['turn']);
    expect(v.wedged).toBe(true);
  });

  it('counts reset and recycle deliveries alongside turn', () => {
    const v = classifyBusy([
      ...busyDefers(5, { mode: 'reset', endMs: NOW - 300 * 60_000 }),
      ...busyDefers(5, { mode: 'recycle', endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(true);
    expect(v.modes).toEqual(['recycle', 'reset']);
  });

  // THE DELIBERATE DIVERGENCE FROM THE COMPOSER CLASS. A composer phantom provably survives
  // a respawn, so `respawned` is NOT clearing there. A busy-gate verdict describes the
  // CHILD's output, and a respawn replaces that child — merging across one would repeat the
  // unscoped-attribution error the host-lifetime rule exists to prevent.
  it('ENDS the run at a respawn, unlike the composer class', () => {
    const v = classifyBusy([
      ...busyDefers(20, { endMs: NOW - 400 * 60_000 }),
      ev('respawned', NOW - 380 * 60_000),
      ...busyDefers(3, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(3);
    expect(v.wedged).toBe(false);
  });

  it('ignores defers from a PREVIOUS host incarnation', () => {
    const v = classifyBusy([
      ...busyDefers(30, { endMs: HOST_STARTED - 60_000 }),
      ...busyDefers(2, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(2);
    expect(v.wedged).toBe(false);
  });

  it('steps over unrelated lifecycle events without breaking the run', () => {
    const v = classifyBusy([
      ...busyDefers(5, { endMs: NOW - 400 * 60_000 }),
      ev('mcp-reconnect-started', NOW - 380 * 60_000),
      ev('stale-fire-dropped', NOW - 370 * 60_000),
      ...busyDefers(5, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(10);
    expect(v.wedged).toBe(true);
  });

  it('reports no wedge when the ledger holds no busy-gate defers at all', () => {
    const v = classifyBusy(defers(20));
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('no busy-gate deferrals');
  });

  /**
   * THE INERT-DETECTOR REGRESSION GUARD, and the reason this block exists at all.
   *
   * The quiet fraction shipped at 0.1 on a reading of the emitter's phrase "gaps ≈ 0ms".
   * Measured against the live box (2026-09-02, 81 hosts, 9 emitting), EVERY observation sat
   * between 188ms and 1322ms against a uniform 1500ms cap — so 0.1 (≤150ms) admitted
   * NOTHING and the classifier could not fire on any input this box produces.
   *
   * That is the dangerous failure because it is SILENT: an inert detector reports zero
   * wedged hosts forever, which is indistinguishable from a healthy fleet. These cases pin
   * the real measured distribution so a future tightening has to fail here rather than in
   * production silence.
   */
  describe('calibration against the measured live distribution', () => {
    const CAP = 1500;
    // The continuously-redrawing cluster measured on real hosts — a TUI repainting a few
    // times a second. These MUST be admitted, or the detector is inert.
    it.each([188, 275, 374, 504])('admits a redrawing-cluster observation of %dms', (obs) => {
      const v = classifyBusy(busyDefers(10, { observedMaxQuietMs: obs, quietMs: CAP }));
      expect(v.wedged).toBe(true);
      expect(v.consecutiveDefers).toBe(10);
    });

    // The near-miss cluster: 85–88% of the cap, having very nearly settled. These must stay
    // excluded — they resolve on their own and have the OPPOSITE fix.
    it.each([1275, 1322])('still excludes a near-miss observation of %dms', (obs) => {
      const v = classifyBusy(busyDefers(10, { observedMaxQuietMs: obs, quietMs: CAP }));
      expect(v.wedged).toBe(false);
      expect(v.reason).toContain('near-miss');
    });

    /**
     * THE RECALL CONTROL — the one known POSITIVE, replayed.
     *
     * Precision was measurable (0 hits across 81 live hosts, 2026-09-02) because the box was
     * full of healthy hosts. Recall was not: the population contained no wedged host, so
     * nothing on that box could show the detector catches a real one. The only true positive
     * available is the incident this class was built from — EI-22102038982840555, su-be3900dd,
     * 2026-09-01 20:15–23:16Z: ~15 accepted-but-parked deliveries across ~2.5h, which ended
     * only via an unrelated host-code-staleness respawn.
     *
     * Replaying its shape is what stops the thresholds being tuned into silence: the measured
     * healthy population tops out at a 0-minute span, so the floors could drift a long way
     * before precision complained, and this is the only case that would notice.
     */
    it('CATCHES the incident it was built from (~15 parked deliveries over ~2.5h)', () => {
      const v = classifyBusy(
        busyDefers(15, { observedMaxQuietMs: 300, quietMs: CAP, spacingMs: 11 * 60_000 }),
      );
      expect(v.wedged).toBe(true);
      expect(v.consecutiveDefers).toBe(15);
      expect(v.streakSpanMs).toBeGreaterThanOrEqual(DEFAULT_MIN_BUSY_STREAK_SPAN_MS);
      expect(v.reason).toContain('never observed at its prompt');
    });

    it('keeps clear margin between the two measured clusters', () => {
      const ceiling = CAP * DEFAULT_BUSY_GATE_MAX_QUIET_FRACTION;
      expect(ceiling).toBeGreaterThan(504); // above the redrawing cluster's top
      expect(ceiling).toBeLessThan(1275); //  below the near-miss cluster's floor
    });
  });
});

function host(over: Partial<PsuPtyHost> = {}): PsuPtyHost {
  return {
    ownerId: 'su-test',
    advSessionId: null,
    pid: 4242,
    ptyPid: 4243,
    sock: '/tmp/x.sock',
    command: 'claude',
    startedAt: HOST_STARTED,
    ...over,
  } as PsuPtyHost;
}

function sweepDeps(over: Partial<PtyHostWedgeSweepDeps> = {}): PtyHostWedgeSweepDeps {
  return {
    listHosts: () => [host()],
    readEvents: () => defers(12),
    readStartedAt: () => HOST_STARTED,
    broadcast: vi.fn(async () => true),
    notify: vi.fn(async () => undefined),
    // Always stubbed: the defaults import the real issue store / telemetry read, so an
    // unstubbed sweep test would reach live infrastructure (and silently swallow the error).
    recordEpisode: vi.fn(async () => ({ action: 'created' as const, id: 'EI-test' })),
    readHealth: vi.fn(async () => ({ measured: false }) as never),
    now: NOW,
    ...over,
  };
}

type EpisodeCall = [{ wedgeClass: string; ownerIds: string[]; detail: string[]; health?: unknown }];
const episodeCalls = (deps: PtyHostWedgeSweepDeps) =>
  (deps.recordEpisode as unknown as { mock: { calls: EpisodeCall[] } }).mock.calls.map((c) => c[0]);

/**
 * P-008 / rubric bar R-4: the guard must be ACCOUNTABLE, not a detector that only logs.
 * The issue module (pty-host-wedge-issue) is tested on its own, but nothing pinned that the
 * guard actually CALLS it — so regressing the sweep to broadcast-only failed no test. These
 * cases pin the wiring at the guard seam.
 */
describe('sweepWedgedPtyHosts — durable wedge record (recordEpisode)', () => {
  it('records exactly one episode for a wedged class, carrying class, owners and health', async () => {
    const deps = sweepDeps({ readHealth: vi.fn(async () => ({ probe: 'health' }) as never) });
    await sweepWedgedPtyHosts({}, deps);
    const calls = episodeCalls(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].wedgeClass).toBe('composer');
    expect(calls[0].ownerIds).toEqual(['su-test']);
    expect(calls[0].detail.length).toBeGreaterThan(0);
    expect(calls[0].health).toEqual({ probe: 'health' });
  });

  it('records nothing when no host is wedged', async () => {
    const deps = sweepDeps({ readEvents: () => defers(2) });
    await sweepWedgedPtyHosts({}, deps);
    expect(deps.recordEpisode).not.toHaveBeenCalled();
  });

  it('records nothing under dryRun', async () => {
    const deps = sweepDeps();
    await sweepWedgedPtyHosts({ dryRun: true }, deps);
    expect(deps.recordEpisode).not.toHaveBeenCalled();
  });

  it('records one episode PER class when a host is wedged both ways', async () => {
    const deps = sweepDeps({ readEvents: () => [...defers(12), ...busyDefers(10)] });
    await sweepWedgedPtyHosts({}, deps);
    expect(episodeCalls(deps).map((c) => c.wedgeClass).sort()).toEqual(['busy-gate', 'composer']);
  });

  it('still records the episode when the health read fails (health omitted, not fatal)', async () => {
    const deps = sweepDeps({
      readHealth: vi.fn(async () => {
        throw new Error('telemetry down');
      }),
    });
    await sweepWedgedPtyHosts({}, deps);
    const calls = episodeCalls(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('health');
  });

  it('survives a recordEpisode failure without failing the sweep or the page', async () => {
    const deps = sweepDeps({
      recordEpisode: vi.fn(async () => {
        throw new Error('issue store down');
      }),
    });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});

describe('sweepWedgedPtyHosts', () => {
  it('reports a wedged host and broadcasts once', async () => {
    const deps = sweepDeps();
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.checked).toBe(1);
    expect(res.wedged).toHaveLength(1);
    expect(res.wedged[0].ownerId).toBe('su-test');
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing is wedged', async () => {
    const deps = sweepDeps({ readEvents: () => defers(2) });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(0);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('does not broadcast under dryRun, but still reports', async () => {
    const deps = sweepDeps();
    const res = await sweepWedgedPtyHosts({ dryRun: true }, deps);
    expect(res.wedged).toHaveLength(1);
    expect(res.dryRun).toBe(true);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  // "I could not see" and "there is nothing there" are the two readings this must never
  // conflate — an unreadable ledger is reported, never silently counted as healthy.
  it('reports an unreadable ledger as unreadable rather than as clean', async () => {
    const res = await sweepWedgedPtyHosts({}, sweepDeps({ readEvents: () => [] }));
    expect(res.unreadable).toEqual(['su-test']);
    expect(res.wedged).toHaveLength(0);
  });

  it('classifies a still-emitting wedged host as BUSY so it is never trampled', async () => {
    const res = await sweepWedgedPtyHosts(
      {},
      sweepDeps({ listHosts: () => [host({ lastOutputAt: NOW - 30_000 })] }),
    );
    expect(res.wedged[0].recoverySafety).toBe('busy');
  });

  it('classifies a long-silent wedged host as IDLE', async () => {
    const res = await sweepWedgedPtyHosts(
      {},
      sweepDeps({ listHosts: () => [host({ lastOutputAt: NOW - 60 * 60_000 })] }),
    );
    expect(res.wedged[0].recoverySafety).toBe('idle');
    expect(res.wedged[0].idleMs).toBe(60 * 60_000);
  });

  // Absent evidence must not authorise action: the dangerous error here is destroying
  // in-flight work, so an unknown activity stamp fails toward "do not touch".
  it('classifies a host with no activity stamps as UNKNOWN, not idle', async () => {
    const res = await sweepWedgedPtyHosts({}, sweepDeps());
    expect(res.wedged[0].recoverySafety).toBe('unknown');
    expect(res.wedged[0].idleMs).toBeNull();
  });

  it('orders the report worst-first', async () => {
    const deps = sweepDeps({
      listHosts: () => [host({ ownerId: 'su-small' }), host({ ownerId: 'su-big' })],
      readEvents: (ownerId: string) => defers(ownerId === 'su-big' ? 25 : 10),
    });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged.map((w) => w.ownerId)).toEqual(['su-big', 'su-small']);
  });

  it('survives a broadcast failure without failing the sweep', async () => {
    const deps = sweepDeps({
      broadcast: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(1);
  });

  it('labels a composer hit with its wedge class', async () => {
    const res = await sweepWedgedPtyHosts({}, sweepDeps());
    expect(res.wedged[0].wedgeClass).toBe('composer');
  });

  it('finds a busy-gate wedge from the SAME ledger read', async () => {
    const deps = sweepDeps({ readEvents: () => busyDefers(10) });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(1);
    expect(res.wedged[0].wedgeClass).toBe('busy-gate');
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  // The two classes are `oneShot`. Sharing a conditionKey would let whichever fired first
  // silently swallow the other — reporting a solved problem while the second class stayed
  // invisible, which is the failure mode this whole guard exists to prevent.
  it('broadcasts each class under its OWN conditionKey', async () => {
    const deps = sweepDeps({ readEvents: () => [...defers(12), ...busyDefers(10)] });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged.map((w) => w.wedgeClass).sort()).toEqual(['busy-gate', 'composer']);

    const keys = (deps.broadcast as unknown as { mock: { calls: Array<[{ conditionKey: string }]> } }).mock.calls
      .map((c) => c[0].conditionKey)
      .sort();
    expect(keys).toEqual(['pty-host-busy-gate-wedge', 'pty-host-wedge']);
  });

  // A host named by both classes is TWO findings about ONE session. The page counts
  // sessions, because "2 sessions cannot receive wakes" about one session is the kind of
  // inflation nobody re-derives before acting on it.
  it('pages by distinct OWNER when one host is wedged both ways', async () => {
    const deps = sweepDeps({ readEvents: () => [...defers(12), ...busyDefers(10)] });
    await sweepWedgedPtyHosts({}, deps);
    const page = (deps.notify as unknown as { mock: { calls: Array<[{ title: string; data: Record<string, unknown> }]> } })
      .mock.calls[0][0];
    expect(page.title).toContain('1 agent session');
    expect(page.data.owners).toEqual(['su-test']);
    expect(page.data.byClass).toEqual({ composer: 1, 'busy-gate': 1 });
  });

  it('does not broadcast a busy-gate hit under dryRun, but still reports it', async () => {
    const deps = sweepDeps({ readEvents: () => busyDefers(10) });
    const res = await sweepWedgedPtyHosts({ dryRun: true }, deps);
    expect(res.wedged).toHaveLength(1);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});

// WI-10006344: the sweep visits every live psu-pty host on the box, so a synchronous
// per-host ledger read parks the main thread once per host. Under host IO pressure a
// single readSync of a 1.5 kB ledger was measured blocked for 1.7 s. The default readers
// must therefore be the async ones; these cases exercise those defaults on real files.
describe('sweepWedgedPtyHosts default readers (async, real files)', () => {
  it('reads the ledger tail and start time through the async defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wedge-guard-'));
    try {
      const ownerId = 'su-wedge-async';
      writeFileSync(
        join(dir, `${ownerId}.events.jsonl`),
        defers(12).map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
      writeFileSync(join(dir, `${ownerId}.json`), JSON.stringify({ ownerId, startedAt: HOST_STARTED }));
      const deps = sweepDeps({ listHosts: () => [host({ ownerId, startedAt: undefined })] });
      delete deps.readEvents;
      delete deps.readStartedAt;
      const res = await sweepWedgedPtyHosts({ dir, dryRun: true }, deps);
      expect(res.unreadable).toEqual([]);
      expect(res.wedged.map((w) => [w.ownerId, w.startedAt])).toContainEqual([ownerId, HOST_STARTED]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing ledger as unreadable rather than throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wedge-guard-'));
    try {
      const deps = sweepDeps({ listHosts: () => [host({ ownerId: 'su-no-ledger' })] });
      delete deps.readEvents;
      delete deps.readStartedAt;
      const res = await sweepWedgedPtyHosts({ dir, dryRun: true }, deps);
      expect(res.unreadable).toEqual(['su-no-ledger']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not import the synchronous per-host readers', () => {
    const src = readFileSync(new URL('./pty-host-wedge-guard.ts', import.meta.url), 'utf8');
    const importBlock = src.slice(0, src.indexOf("from '../../events/await/psu-pty-discovery'"));
    expect(importBlock).toMatch(/\breadHostEventTailAsync\b/);
    expect(importBlock).not.toMatch(/\breadHostEventTail\b(?!Async)/);
    expect(importBlock).not.toMatch(/\bhostStartedAt\b(?!Async)/);
  });
});
