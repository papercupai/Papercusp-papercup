import { describe, expect, it } from 'vitest';
import {
  FREEZE_DISPOSITION_FRESH_MS,
  GATE_REPAIR_LATENCY_KIND,
  buildFreezeAndConvergeGateHealth,
  buildGateRepairLatencyLedgerRow,
  deriveTickFreezeDisposition,
  readFreezeAndConverge,
  summarizeFreezeAndConverge,
} from './freeze-disposition';

const T0 = Date.parse('2026-09-02T16:00:00.000Z');

describe('deriveTickFreezeDisposition — P-008 per-tick backstop', () => {
  // The defect this exists for, stated as a test: the four explicit recordFreezeDisposition
  // call sites cover `retired` x2, `held` and `off`. `converging` and `none` are recorded
  // NOWHERE, and the stored record is shallow-merged and never cleared — so a tick that
  // converges or clears leaves the previous hold standing and a reader inside the freshness
  // window takes it for current state.
  it('derives `converging` for a tick that still holds a frozen queue', () => {
    const d = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: { candidate: 'abc123def456789' },
      summary: 'frozen repair fixer sp-1 dispatched for abc123de (attempt 2); no suite run',
      green: null,
    });
    expect(d.state).toBe('converging');
    expect(d.enabled).toBe(true);
    expect(d.candidate).toBe('abc123def456789');
    // The run's own sentence is preferred over a generic one — a reason that says nothing
    // sends the reader back to the logs this record exists to replace.
    expect(d.reason).toContain('dispatched for abc123de');
  });

  it('derives `none` — NOT `off` — for a green tick with nothing frozen', () => {
    // `off` and `none` are the conflation the whole record exists to prevent: an
    // owner-suppressed mechanism and a gate with nothing to freeze are different facts.
    const d = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: null,
      summary: 'all legs green',
      green: true,
    });
    expect(d.state).toBe('none');
    expect(d.enabled).toBe(true);
    expect(d.candidate).toBeNull();
    expect(d.reason).toContain('went green');
  });

  it('P-025: derives `unreadable` instead of `none` for a present newer-schema queue', () => {
    const d = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: null,
      repairQueueRead: {
        status: 'unreadable',
        reason: 'schema-newer-than-reader',
        schemaVersion: 5,
      },
      summary: 'no candidate is frozen this tick',
      green: null,
    });
    expect(d).toMatchObject({
      enabled: true,
      state: 'unreadable',
      candidate: null,
    });
    expect(d.reason).toContain('schema-newer-than-reader');
    expect(d.reason).toContain('refusing to conclude');
    const stored = buildFreezeAndConvergeGateHealth(d, T0);
    expect(readFreezeAndConverge(stored)).toMatchObject({ state: 'unreadable' });
    expect(summarizeFreezeAndConverge(stored, T0)).toContain('queue is UNREADABLE');
  });

  it('derives `off` whenever the owner flag is off, whatever else the tick did', () => {
    const d = deriveTickFreezeDisposition({
      flagEnabled: false,
      repairQueue: { candidate: 'abc123def456789' },
      summary: 'not-green',
      green: false,
    });
    expect(d.state).toBe('off');
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('RELEASE_FREEZE_AND_CONVERGE_DEFAULT');
  });

  it('never emits a blank reason, so `readFreezeAndConverge` can never reject its own output', () => {
    // readFreezeAndConverge fails CLOSED on an empty reason. A derived disposition that
    // tripped that guard would write a record no reader accepts — absent state that LOOKS
    // written, which is strictly worse than not writing at all.
    for (const observation of [
      { flagEnabled: true, repairQueue: null, summary: '', green: false },
      { flagEnabled: true, repairQueue: null, summary: '   ', green: null },
      { flagEnabled: true, repairQueue: { candidate: 'deadbeefcafe' }, summary: '  ' },
      { flagEnabled: false, repairQueue: null },
    ]) {
      const derived = deriveTickFreezeDisposition(observation);
      expect(derived.reason.trim()).not.toBe('');
      const stored = buildFreezeAndConvergeGateHealth(derived, T0);
      expect(readFreezeAndConverge(stored)).not.toBeNull();
    }
  });
});

describe('buildFreezeAndConvergeGateHealth', () => {
  it('writes every optional field EXPLICITLY as null, so a shallow merge cannot strand stale bounds', () => {
    // The gate_health write is `existing || fragment`. An OMITTED key leaves the previous
    // tick's value in place, so a hold that has since cleared would keep advertising its old
    // holdUntilMs — a dead deadline presented as live. That is the whole reason these are
    // written rather than spread.
    const fragment = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall, attempts=0' },
      T0,
    );
    expect(fragment.freezeAndConverge).toEqual({
      enabled: true,
      repairLatency: null,
      state: 'retired',
      reason: 'provider wall, attempts=0',
      candidate: null,
      holdUntilMs: null,
      capacityRetryAtMs: null,
      observedAtMs: T0,
    });
    expect(Object.keys(fragment.freezeAndConverge)).toContain('holdUntilMs');
  });

  it('round-trips through the reader', () => {
    const fragment = buildFreezeAndConvergeGateHealth(
      {
        enabled: true,
        state: 'held',
        reason: 'wall outlasts the stall window',
        candidate: 'a'.repeat(40),
        holdUntilMs: T0 + 3 * 60 * 60 * 1_000,
        capacityRetryAtMs: T0 + 6 * 24 * 60 * 60 * 1_000,
      },
      T0,
    );
    expect(readFreezeAndConverge(fragment)).toMatchObject({
      state: 'held',
      candidate: 'a'.repeat(40),
      holdUntilMs: T0 + 3 * 60 * 60 * 1_000,
    });
  });
});

describe('readFreezeAndConverge fails CLOSED', () => {
  it('returns null for an absent record rather than a healthy-looking default', () => {
    // "Not measured" and "the freeze is fine" must never be the same value — that
    // equivalence is what hid a full day of suppression.
    expect(readFreezeAndConverge(undefined)).toBeNull();
    expect(readFreezeAndConverge(null)).toBeNull();
    expect(readFreezeAndConverge({})).toBeNull();
    expect(readFreezeAndConverge({ freezeAndConverge: null })).toBeNull();
  });

  it('rejects a half-written blob instead of coercing it into a plausible record', () => {
    const base = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    ).freezeAndConverge;
    // Each of these would otherwise render as a confident statement about the release gate.
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, state: 'paused' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, enabled: 'yes' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, reason: '' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, observedAtMs: 'now' } }),
    ).toBeNull();
  });

  it('CONTROL: the same reader accepts the well-formed record, so the rejections mean something', () => {
    const ok = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    );
    expect(readFreezeAndConverge(ok)).not.toBeNull();
  });

  it('drops a non-finite numeric rather than propagating NaN into a rendered deadline', () => {
    const base = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    ).freezeAndConverge;
    expect(
      readFreezeAndConverge({
        freezeAndConverge: { ...base, holdUntilMs: Number.NaN },
      }),
    ).toMatchObject({ holdUntilMs: null });
  });
});

describe('summarizeFreezeAndConverge', () => {
  it('answers the exact question the item names: OFF, and why', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      {
        enabled: false,
        state: 'off',
        reason: 'FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT is OFF (owner-set)',
        candidate: 'b'.repeat(40),
      },
      T0,
    );
    const line = summarizeFreezeAndConverge(gh, T0 + 1_000);
    expect(line).toContain('freeze-and-converge is OFF');
    expect(line).toContain('owner-set');
    expect(line).toContain('bbbbbbbbbbbb');
  });

  it('distinguishes an owner-suppressed freeze from one with nothing to freeze', () => {
    // `off` and `none` are BOTH `repairQueue: null` at the old surface. If the summary
    // collapsed them again the whole record would be pointless.
    const off = summarizeFreezeAndConverge(
      buildFreezeAndConvergeGateHealth(
        { enabled: false, state: 'off', reason: 'owner-set' },
        T0,
      ),
      T0,
    );
    const none = summarizeFreezeAndConverge(
      buildFreezeAndConvergeGateHealth(
        { enabled: true, state: 'none', reason: 'no frozen candidate this tick' },
        T0,
      ),
      T0,
    );
    expect(off).not.toEqual(none);
    expect(off).toContain('OFF');
    expect(none).toContain('ON, none');
  });

  it('marks a stale record as history rather than presenting it as current state', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall' },
      T0,
    );
    const line = summarizeFreezeAndConverge(
      gh,
      T0 + FREEZE_DISPOSITION_FRESH_MS + 60_000,
    );
    expect(line).toContain('history, not current state');
  });

  it('does NOT mark a fresh record stale', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall' },
      T0,
    );
    expect(
      summarizeFreezeAndConverge(gh, T0 + FREEZE_DISPOSITION_FRESH_MS - 60_000),
    ).not.toContain('history, not current state');
  });

  it('returns null — never a reassuring sentence — when nothing was measured', () => {
    expect(summarizeFreezeAndConverge({}, T0)).toBeNull();
  });
});

describe('buildGateRepairLatencyLedgerRow — R-7 durable latency ledger (EI-23420599799124840)', () => {
  it('retains original admissions and pending head after retirement without mutable aliases', () => {
    const admission = { atMs: T0 + 60_000, fromRepairHead: 'a', toRepairHead: 'b',
      actor: 'agent', source: { ref: 'staging', sha: 'b' }, paths: ['p.ts'], unchanged: [], blobs: { 'p.ts': 'blob' } };
    const disposition = deriveTickFreezeDisposition({ flagEnabled: true, nowMs: T0 + 120_000,
      repairQueue: { candidate: 'a', repairHead: 'b', phase: 'ready-to-verify', openedAtMs: T0,
        convergenceRounds: [{ round: 1, head: 'a', atMs: T0, failingCount: 1 }], admissions: [admission] } });
    const row = buildGateRepairLatencyLedgerRow({ ...disposition, state: 'retired' }, T0 + 120_000)!;
    admission.atMs++;
    expect(row.detail.repairProgress!.admissionHistory).toEqual({ version: 1, repairHead: 'b',
      admissions: [{ atMs: T0 + 60_000, fromRepairHead: 'a', toRepairHead: 'b' }] });
    expect(row.status).toBe('retired');
  });
  it('preserves original round ordinals and clocks beyond the mutable queue lifetime', () => {
    const rounds = [{ round: 1, head: 'a'.repeat(40), atMs: T0, failingCount: 4 },
      { round: 3, head: 'b'.repeat(40), atMs: T0 + 60_000, failingCount: 2 }];
    const disposition = deriveTickFreezeDisposition({ flagEnabled: true, nowMs: T0 + 120_000,
      repairQueue: { candidate: 'a'.repeat(40), phase: 'awaiting-fixer', openedAtMs: T0, convergenceRounds: rounds } });
    const row = buildGateRepairLatencyLedgerRow(disposition, T0 + 120_000)!;
    expect(row.detail.repairProgress).toEqual({ phase: 'awaiting-fixer', rounds: [
      { round: 1, head: 'a'.repeat(40), atMs: T0 }, { round: 3, head: 'b'.repeat(40), atMs: T0 + 60_000 },
    ] });
    rounds[1]!.atMs = T0 + 90_000;
    expect(row.detail.repairProgress!.rounds[1]!.atMs).toBe(T0 + 60_000);
  });
  it('keeps an absent legacy round vector unmeasured instead of inventing empty history', () => {
    const disposition = deriveTickFreezeDisposition({ flagEnabled: true, nowMs: T0 + 60_000,
      repairQueue: { candidate: 'a'.repeat(40), phase: 'awaiting-fixer', openedAtMs: T0 } });
    expect(buildGateRepairLatencyLedgerRow(disposition, T0 + 60_000)!.detail).not.toHaveProperty('repairProgress');
  });
  const latency = {
    redToFixerSpawnMs: 4 * 60_000,
    fixToAdmitMs: 9 * 60_000,
    admitToResumeRunStartMs: 83_713,
    admitToVerdictMs: 31 * 60_000,
    redAwaitingFixerMs: null,
    admitAwaitingResumeRunStartMs: null,
    admitAwaitingVerdictMs: null,
    stamps: {
      openedAtMs: T0,
      lastRedAtMs: T0,
      fixerSpawnedAtMs: T0 + 4 * 60_000,
      lastAdmittedAtMs: T0 + 13 * 60_000,
      lastResumeRunStartedAtMs: T0 + 13 * 60_000 + 83_713,
      lastVerdictAtMs: T0 + 44 * 60_000,
    },
  };

  // THE DEFECT, stated as a test. These same numbers already reach
  // `gate_health.freezeAndConverge.repairLatency` — but that is ONE MUTABLE SLOT: the next
  // tick shallow-merges over it and a retire nulls it outright. So the figures R-7 requires
  // to be "measurable, not anecdotal" evaporate exactly when a postmortem needs them.
  it('carries the whole latency record, so it survives the queue that produced it', () => {
    const row = buildGateRepairLatencyLedgerRow(
      {
        enabled: true,
        state: 'converging',
        reason: 'repairHead advancing',
        candidate: 'abc123',
        repairLatency: latency,
      },
      T0 + 45 * 60_000,
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe('converging');
    expect(row!.detail.candidate).toBe('abc123');
    expect(row!.detail.observedAtMs).toBe(T0 + 45 * 60_000);
    // Whole-record, not a hand-picked subset: a ledger that stores only today's interesting
    // fields cannot answer tomorrow's question, and the stamps are what make a row
    // re-derivable rather than merely readable.
    expect(row!.detail.repairLatency).toEqual(latency);
  });

  // The retire is the case the ledger exists for: it is the tick that CLEARS the slot.
  it('still records the latencies on the RETIRE tick — the moment the slot is cleared', () => {
    const row = buildGateRepairLatencyLedgerRow(
      {
        enabled: true,
        state: 'retired',
        reason: 'unreachable-green',
        candidate: 'abc123',
        repairLatency: latency,
      },
      T0 + 46 * 60_000,
    );
    expect(row?.status).toBe('retired');
    expect(row?.detail.repairLatency.admitToResumeRunStartMs).toBe(83_713);
  });

  it('records NOTHING when the tick held no readable queue', () => {
    // The null is the point. `repairLatency:null` is LEGITIMATE for a tick with no readable
    // queue (R-7's own falsifier carves that case out explicitly). Writing an empty row
    // anyway would bury the ticks that DID measure something under ~24 meaningless rows a
    // day, and leave a reader unable to tell "not measured" from "measured as nothing".
    expect(
      buildGateRepairLatencyLedgerRow({ enabled: true, state: 'none', reason: 'no frozen candidate' }, T0),
    ).toBeNull();
    expect(
      buildGateRepairLatencyLedgerRow(
        { enabled: false, state: 'off', reason: 'flag off', repairLatency: null },
        T0,
      ),
    ).toBeNull();
  });

  // RECURRENCE GUARD for the CLASS, not this instance. Folding these rows into either
  // existing gate kind is silent and corrupting: `green_checkpoint` advances
  // green-stall-watchdog's last_verdict_ms clock (blinding the verdict-less limb), and
  // `green_checkpoint_fire` rows are COUNTED AS FIRES by reconstructGateFireDays (inflating
  // the very count that reconstruction exists to make trustworthy). Neither failure raises
  // an error — each just quietly wrongs a consumer, which is why it is pinned here.
  it('uses a kind no existing pipeline_events consumer reads', () => {
    expect(GATE_REPAIR_LATENCY_KIND).toBe('green_checkpoint_repair_latency');
    expect(GATE_REPAIR_LATENCY_KIND).not.toBe('green_checkpoint');
    expect(GATE_REPAIR_LATENCY_KIND).not.toBe('green_checkpoint_fire');
  });
});
