import { describe, expect, it } from 'vitest';
import {
  deriveLastRespawnOutcome,
  priorRespawnNote,
  lostRespawnAmbientLine,
  isOrphanedPendingRespawn,
  LOST_RESPAWN_AMBIENT_MAX_AGE_MS,
  PENDING_RESPAWN_DEFAULT_CAP_MS,
  PENDING_RESPAWN_ORPHAN_GRACE_MS,
  type PriorRespawn,
} from './carry-respawn-outcome';

/**
 * EI-19480099650947832 — `session:request-compaction` returned `respawn: true`
 * and the cut never happened; the caller was never told. The host DID record
 * every outcome, in a per-owner JSONL no tool read. These rows are copied from
 * the real log that produced the filing:
 * ~/.papercusp/psu-pty/su-4a6e2255-….events.jsonl, 2026-08-03/04.
 */
const NOW = Date.parse('2026-08-04T00:47:00.000Z');

describe('deriveLastRespawnOutcome', () => {
  it('does not infer a dead retry from the real multi-window pending sequence (EI-23072259158385662)', () => {
    const out = deriveLastRespawnOutcome([
      { ts: '2026-09-12T15:52:24.659Z', kind: 'respawn-rearm-queued', capMs: 360_000 },
      { ts: '2026-09-12T16:13:24.667Z', kind: 'respawn-rearm-superseded', capMs: 180_000 },
      { ts: '2026-09-12T16:22:38.477Z', kind: 'wake-turn-deferred-for-pending-respawn' },
    ], { now: Date.parse('2026-09-12T16:23:00.000Z') });
    expect(out.outcome).toBe('pending');
    expect(lostRespawnAmbientLine(out)).toContain('carry-respawn DELAYED');
    expect(lostRespawnAmbientLine(out)).not.toContain('ORPHANED');
    expect(priorRespawnNote(out)).not.toContain('does NOT inherit');
    expect(priorRespawnNote(out)).toContain('may still be retrying');
  });

  it('reports `dropped` with the host reason for the real 2026-08-04 failure sequence', () => {
    const rows = [
      { ts: '2026-08-04T00:25:22.517Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
      { ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued', reason: 'busy-gate-expired' },
      { ts: '2026-08-04T00:32:17.214Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
      { ts: '2026-08-04T00:38:29.702Z', kind: 'respawn-carry-dropped', reason: 'busy-gate-expired' },
      { ts: '2026-08-04T00:39:49.595Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('dropped');
    expect(out.reason).toBe('busy-gate-expired');
    expect(out.ts).toBe('2026-08-04T00:38:29.702Z');
    expect(out.ageMs).toBe(NOW - Date.parse('2026-08-04T00:38:29.702Z'));
  });

  it('treats respawn-failed as terminal instead of leaving the carry pending', () => {
    const out = deriveLastRespawnOutcome(
      [
        {
          ts: '2026-09-20T00:00:00.000Z',
          kind: 'respawn-rearm-queued',
          reason: 'busy-gate-expired',
          mode: 'carry-respawn',
        },
        {
          ts: '2026-09-20T00:05:00.000Z',
          kind: 'respawn-failed',
          reason: 'argv-build-failed',
          mode: 'carry-respawn',
        },
      ],
      { now: Date.parse('2026-09-20T00:10:00.000Z') },
    );
    expect(out).toMatchObject({
      outcome: 'dropped',
      reason: 'argv-build-failed',
      ts: '2026-09-20T00:05:00.000Z',
    });
  });

  it('ignores non-lifecycle rows entirely — a wake deferral is not a verdict about a respawn', () => {
    const rows = [
      { ts: '2026-08-04T00:10:00.000Z', kind: 'respawn-carry-delivered' },
      { ts: '2026-08-04T00:25:22.517Z', kind: 'wake-turn-deferred-for-pending-respawn' },
      { ts: '2026-08-04T00:30:00.000Z', kind: 'stale-fire-dropped' },
      { ts: '2026-08-04T00:31:00.000Z', kind: 'shutdown-refused' },
    ];
    expect(deriveLastRespawnOutcome(rows, { now: NOW }).outcome).toBe('delivered');
  });

  it('a later success supersedes an earlier drop (newest-first, first lifecycle row wins)', () => {
    const rows = [
      { ts: '2026-08-03T16:16:42.518Z', kind: 'respawn-carry-dropped', reason: 'carry-stale' },
      { ts: '2026-08-03T16:52:28.309Z', kind: 'respawned' },
      { ts: '2026-08-03T16:53:01.997Z', kind: 'respawn-carry-delivered' },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('delivered');
    expect(out.reason).toBeUndefined();
  });

  it('keeps a spawned successor pending until its continuation turn is delivered', () => {
    const firstRealWindow = [
      {
        ts: '2026-08-22T20:00:35.220Z',
        kind: 'respawned',
        mode: 'carry-respawn',
        nativeId: '895c7c97-6cf4-4585-837d-238c7fdd93e3',
      },
    ];
    expect(deriveLastRespawnOutcome(firstRealWindow, { now: NOW }).outcome).toBe('pending');
    expect(deriveLastRespawnOutcome([
      ...firstRealWindow,
      { ts: '2026-08-22T20:01:00.000Z', kind: 'respawn-carry-delivered' },
    ], { now: NOW }).outcome).toBe('delivered');
  });

  it('a newer Claude self-relaunch does NOT turn an unresolved requested cut into success', () => {
    const rows = [
      {
        ts: '2026-08-23T13:30:52.272Z',
        kind: 'respawn-rearm-queued',
        mode: 'carry-respawn',
        reason: 'busy-gate-expired',
        capMs: 360_000,
      },
      {
        ts: '2026-08-24T10:24:32.892Z',
        kind: 'respawned',
        mode: 'self-relaunch',
        nativeId: '508c7f43-133b-4abf-9fcb-f9bf11f7a8fc',
      },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: Date.parse('2026-08-24T10:30:00.000Z') });
    expect(out).toMatchObject({ outcome: 'pending', reason: 'busy-gate-expired', capMs: 360_000 });
    expect(isOrphanedPendingRespawn(out)).toBe(true);
  });

  it('a self-relaunch with no carry request is not fabricated into carry history', () => {
    const out = deriveLastRespawnOutcome(
      [{ ts: '2026-08-24T21:36:04.643Z', kind: 'respawned', mode: 'self-relaunch', nativeId: '21dfdd94' }],
      { now: NOW },
    );
    expect(out).toEqual({ outcome: 'none' });
  });

  it('reports `pending` while a re-poll is still in flight, including after a supersede', () => {
    expect(
      deriveLastRespawnOutcome([{ ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued' }], { now: NOW })
        .outcome,
    ).toBe('pending');
    expect(
      deriveLastRespawnOutcome(
        [
          { ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued' },
          { ts: '2026-08-04T00:38:29.702Z', kind: 'respawn-rearm-superseded', reason: 'superseded-pending-rearm' },
        ],
        { now: NOW },
      ).outcome,
    ).toBe('pending');
  });

  it('reports `none` for an empty / respawn-free log rather than guessing', () => {
    expect(deriveLastRespawnOutcome([], { now: NOW })).toEqual({ outcome: 'none' });
    expect(deriveLastRespawnOutcome([{ ts: '2026-08-04T00:00:00.000Z', kind: 'shutdown-accepted' }], { now: NOW })).toEqual(
      { outcome: 'none' },
    );
  });

  it('survives malformed rows (a partially-written final line, a row with no kind/ts)', () => {
    const rows = [
      {},
      { kind: '' },
      { kind: 'respawn-carry-dropped', reason: 'rearm-error' }, // no ts
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('dropped');
    expect(out.ageMs).toBeNull();
    expect(out.ts).toBeUndefined();
  });
});

describe('priorRespawnNote', () => {
  it('warns LOUDLY and names the host reason when the previous respawn was dropped', () => {
    const note = priorRespawnNote({
      outcome: 'dropped',
      reason: 'busy-gate-expired',
      ts: '2026-08-04T00:38:29.702Z',
      ageMs: 9 * 60_000,
    });
    expect(note).toContain('prior-respawn-DROPPED');
    expect(note).toContain('busy-gate-expired');
    expect(note).toContain('9m ago');
    // The operative correction: an ack is not a landed cut.
    expect(note).toContain('spawning and submitting its first turn are separate steps');
    expect(note).not.toContain('never cut');
  });

  // The age here is load-bearing since P-009: a pending attempt past its re-poll
  // cap is ORPHANED, not racing, and gets the other branch (see the orphan suite
  // at the bottom). This one is deliberately well inside the window.
  it('says a pending re-poll STILL INSIDE its window is SUPERSEDED by this request rather than racing it', () => {
    const note = priorRespawnNote({ outcome: 'pending', ts: '2026-08-04T00:28:00.818Z', ageMs: 90_000 });
    expect(note).toContain('prior-respawn-STILL-PENDING');
    expect(note).toContain('SUPERSEDES');
  });

  // A warning that fires when nothing is wrong trains agents to ignore it —
  // the note is emitted ONLY on evidence.
  it('is SILENT when the last respawn delivered, when there is no history, or on a null verdict', () => {
    expect(priorRespawnNote({ outcome: 'delivered', ageMs: 1000 })).toBe('');
    expect(priorRespawnNote({ outcome: 'none' })).toBe('');
    expect(priorRespawnNote(null)).toBe('');
    expect(priorRespawnNote(undefined)).toBe('');
  });

  it('renders age sanely across the minute/hour boundary and with no timestamp at all', () => {
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: 30_000 })).toContain('just now');
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: 3 * 3_600_000 })).toContain('3h ago');
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: null })).toContain('unknown age');
  });
});

/**
 * EI-19326331501849713 (owner-directed 2026-08-09) — the AMBIENT line, which
 * exists because `priorRespawnNote` only reaches an agent that calls
 * `session:request-compaction` AGAIN, and a dropped respawn removes every reason
 * to call again. Measured on session bd819348: the owner read the resulting
 * silence as "the successor got an error" when no successor had ever existed.
 */
describe('lostRespawnAmbientLine', () => {
  const dropped = (over: Partial<{ reason: string; ageMs: number | null }> = {}) => ({
    outcome: 'dropped' as const,
    reason: 'busy-gate-expired',
    ts: '2026-08-04T00:38:29.702Z',
    ageMs: 4 * 60_000,
    ...over,
  });

  it('warns on a RECENT drop, naming the reason and the observable that confirms it', () => {
    const line = lostRespawnAmbientLine(dropped());
    expect(line).toContain('carry-respawn DROPPED');
    expect(line).toContain('busy-gate-expired');
    // The observable is what makes this actionable rather than merely alarming:
    // the agent can confirm it without any tool call.
    expect(line).toContain('verify which native session is running');
    expect(line).not.toContain('still the same session');
    expect(line).toContain('session:request-compaction');
  });

  // A line that fires when nothing is wrong is a line agents learn to skip —
  // which would defeat the entire point of adding another per-turn line.
  it('is SILENT for delivered / pending / none / null', () => {
    expect(lostRespawnAmbientLine({ outcome: 'delivered', ageMs: 1_000 })).toBeNull();
    expect(lostRespawnAmbientLine({ outcome: 'pending', ageMs: 1_000 })).toBeNull();
    expect(lostRespawnAmbientLine({ outcome: 'none' })).toBeNull();
    expect(lostRespawnAmbientLine(null)).toBeNull();
    expect(lostRespawnAmbientLine(undefined)).toBeNull();
  });

  it('goes quiet once the drop is old news, treating the boundary itself as still-recent', () => {
    expect(lostRespawnAmbientLine(dropped({ ageMs: LOST_RESPAWN_AMBIENT_MAX_AGE_MS }))).not.toBeNull();
    expect(lostRespawnAmbientLine(dropped({ ageMs: LOST_RESPAWN_AMBIENT_MAX_AGE_MS + 1 }))).toBeNull();
  });

  // An unparseable host timestamp yields ageMs null. Rendering that as "recent"
  // would nag every turn forever on exactly the rows we know least about.
  it('is SILENT on a drop of UNKNOWN age rather than assuming it is recent', () => {
    expect(lostRespawnAmbientLine(dropped({ ageMs: null }))).toBeNull();
  });

  it('omits the reason clause cleanly when the host recorded none', () => {
    const line = lostRespawnAmbientLine({ outcome: 'dropped', ageMs: 60_000 });
    expect(line).toContain('carry-respawn DROPPED');
    expect(line).not.toContain('(reason:');
  });

  // CONTROL (falsifiability, per the repo's guard-testing rule): the age gate is
  // the only thing between this line and permanent noise, so prove a
  // deliberately-weaker gate WOULD fire where the real one stays silent. If this
  // control ever stops discriminating, the assertions above have gone vacuous.
  it('CONTROL: an age-blind gate fires on an ancient drop where the real one does not', () => {
    const ancient = dropped({ ageMs: 30 * 24 * 3_600_000 });
    const ageBlindGate = (p: ReturnType<typeof dropped>) => (p.outcome === 'dropped' ? 'would fire' : null);
    expect(ageBlindGate(ancient)).not.toBeNull();
    expect(lostRespawnAmbientLine(ancient)).toBeNull();
  });
});

/**
 * P-009 (fleet-lead-instrumentation-audit-2026-08-09) — the ORPHANED attempt.
 * `session:request-compaction` acked `respawn: true`, an internal claude re-exec
 * pre-empted the cut, and context resumed at 79%. Nothing distinguished the
 * requested cut from a performed one, because the pre-empted attempt never got a
 * verdict row: it stayed `pending`, and every warning in this module was gated on
 * `dropped`. The rows below carry the real `capMs` values the host stamps
 * (~/.papercusp/psu-pty/su-b8422496-….events.jsonl, 2026-08-09T01:46:12Z).
 */
describe('isOrphanedPendingRespawn', () => {
  const pending = (over: Partial<PriorRespawn> = {}): PriorRespawn => ({
    outcome: 'pending',
    reason: 'busy-gate-expired',
    ts: '2026-08-09T01:46:12.000Z',
    ageMs: 20 * 60_000,
    capMs: 360_000,
    ...over,
  });

  it('reads capMs off the deciding row so the verdict tracks the HOST budget, not a copy of it', () => {
    const rows = [
      // WI-2141048 renamed this row's kind to the mode-carrying `busy-gate-expired`
      // (one kind for every deferred mode). It stays a NON-deciding row here — the
      // point of this case is that capMs is read off the deciding rearm row below.
      { ts: '2026-08-09T01:46:12.000Z', kind: 'busy-gate-expired', mode: 'carry-respawn', capMs: 180_000 },
      { ts: '2026-08-09T01:46:12.000Z', kind: 'respawn-rearm-queued', reason: 'busy-gate-expired', capMs: 360_000 },
      { ts: '2026-08-09T01:46:22.406Z', kind: 'wake-turn-deferred-for-pending-respawn' },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: Date.parse('2026-08-09T02:06:12.000Z') });
    expect(out.outcome).toBe('pending');
    expect(out.capMs).toBe(360_000);
    expect(isOrphanedPendingRespawn(out)).toBe(true);
  });

  it('is FALSE while the re-poll window is still open — a slow attempt is not a lost one', () => {
    expect(isOrphanedPendingRespawn(pending({ ageMs: 60_000 }))).toBe(false);
    expect(isOrphanedPendingRespawn(pending({ ageMs: 360_000 }))).toBe(false);
    // The grace band: the cap is a wait budget, not a promise to write the row on
    // the tick, so a verdict trailing it slightly must not read as pre-emption.
    expect(isOrphanedPendingRespawn(pending({ ageMs: 360_000 + PENDING_RESPAWN_ORPHAN_GRACE_MS }))).toBe(false);
    expect(isOrphanedPendingRespawn(pending({ ageMs: 360_000 + PENDING_RESPAWN_ORPHAN_GRACE_MS + 1 }))).toBe(true);
  });

  // The discriminating case: a row stamped with a LONGER cap than the default is
  // still in flight at an age that would be orphaned under the default. If this
  // ever passes with the row's capMs ignored, the predicate is reading a constant.
  it('honours a LONGER host cap instead of the default, and falls back only when the row carried none', () => {
    expect(isOrphanedPendingRespawn(pending({ ageMs: 10 * 60_000, capMs: 1_800_000 }))).toBe(false);
    expect(isOrphanedPendingRespawn(pending({ ageMs: 10 * 60_000, capMs: null }))).toBe(true);
    expect(PENDING_RESPAWN_DEFAULT_CAP_MS).toBe(360_000);
  });

  it('is FALSE on unknown age, and on every non-pending outcome', () => {
    expect(isOrphanedPendingRespawn(pending({ ageMs: null }))).toBe(false);
    expect(isOrphanedPendingRespawn({ outcome: 'dropped', ageMs: 10 * 3_600_000 })).toBe(false);
    expect(isOrphanedPendingRespawn({ outcome: 'delivered', ageMs: 10 * 3_600_000 })).toBe(false);
    expect(isOrphanedPendingRespawn({ outcome: 'none' })).toBe(false);
    expect(isOrphanedPendingRespawn(null)).toBe(false);
  });
});

describe('lostRespawnAmbientLine — orphaned pending (P-009)', () => {
  const orphan: PriorRespawn = {
    outcome: 'pending',
    reason: 'busy-gate-expired',
    ts: '2026-08-09T01:46:12.000Z',
    ageMs: 20 * 60_000,
    capMs: 360_000,
  };

  it('warns about delayed delivery without inventing preemption or a terminal verdict', () => {
    const line = lostRespawnAmbientLine(orphan);
    expect(line).toContain('carry-respawn DELAYED');
    expect(line).toContain('no recorded terminal outcome');
    expect(line).toContain('may still be retrying');
    expect(line).not.toContain('ORPHANED');
    expect(line).toContain('verify which native session is running');
    expect(line).not.toContain('still the same session');
    // A drop has a verdict row to quote; an orphan does not. Reporting one as the
    // other manufactures certainty the host never produced.
    expect(line).not.toContain('DROPPED');
    // The re-poll budget is named so the reader can check the claim themselves.
    expect(line).toContain('360s');
  });

  it('stays SILENT on an attempt still inside its window, and once the orphan is old news', () => {
    expect(lostRespawnAmbientLine({ ...orphan, ageMs: 60_000 })).toBeNull();
    expect(lostRespawnAmbientLine({ ...orphan, ageMs: LOST_RESPAWN_AMBIENT_MAX_AGE_MS + 1 })).toBeNull();
  });

  // CONTROL (falsifiability): the cap gate is the only thing between this line and
  // firing on every healthy in-flight respawn — which would nag exactly the agents
  // whose cut IS about to land. A cap-blind gate fires where the real one is silent.
  it('CONTROL: a cap-blind gate fires on a healthy in-flight pending where the real one does not', () => {
    const fresh: PriorRespawn = { ...orphan, ageMs: 30_000 };
    const capBlindGate = (p: PriorRespawn) => (p.outcome === 'pending' ? 'would fire' : null);
    expect(capBlindGate(fresh)).not.toBeNull();
    expect(lostRespawnAmbientLine(fresh)).toBeNull();
  });

  it('priorRespawnNote does not invent a dead retry or a fresh request from a wait cap', () => {
    const note = priorRespawnNote(orphan);
    expect(note).toContain('prior-respawn-DELAYED');
    expect(note).toContain('may still be retrying');
    expect(note).not.toContain('does NOT inherit it');
    expect(note).not.toContain('SUPERSEDES');
  });
});

/**
 * WI-10005752 — the SUCCESSOR of a delivered carry-respawn was told its own creating
 * respawn had been "DROPPED just now". Rows below are copied from the real log
 * ~/.papercusp/psu-pty/su-622ab60b-….events.jsonl, 2026-10-03 00:33–00:36Z: the cut was
 * DELIVERED at 00:33:31, then a stale pending request — moot because a newer child
 * already existed — expired its busy gate at 00:36:31 and the host RETIRED it by writing
 * `respawn-carry-dropped {reason:'superseded'}` (host: isCarryRespawnSuperseded). That
 * row is the newest lifecycle row in the file but carries no loss evidence.
 */
describe('deriveLastRespawnOutcome — superseded retirement is not a loss (WI-10005752)', () => {
  const ghostAfterDelivery = [
    { ts: '2026-10-03T00:33:25.211Z', kind: 'respawned', mode: 'carry-respawn', capMs: 600_000 },
    { ts: '2026-10-03T00:33:31.325Z', kind: 'respawn-carry-delivered', mode: 'carry-respawn' },
    { ts: '2026-10-03T00:33:32.243Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
    { ts: '2026-10-03T00:36:31.325Z', kind: 'busy-gate-expired', mode: 'carry-respawn', capMs: 180_000 },
    { ts: '2026-10-03T00:36:31.326Z', kind: 'respawn-rearm-queued', mode: 'carry-respawn', reason: 'busy-gate-expired', capMs: 360_000 },
    { ts: '2026-10-03T00:36:31.326Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'superseded', capMs: 360_000, rearmed: true },
  ];
  const at = (iso: string) => ({ now: Date.parse(iso) });

  // The pre-fix reader, kept as a CONTROL: it trusted every `respawn-carry-dropped`.
  const naiveOutcome = (rows: typeof ghostAfterDelivery) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const k = rows[i].kind;
      if (k === 'respawn-carry-dropped') return 'dropped';
      if (k === 'respawn-carry-delivered') return 'delivered';
      if (k === 'respawn-rearm-queued') return 'pending';
    }
    return 'none';
  };

  it('CONTROL: the pre-fix newest-first reader reads this real sequence as DROPPED', () => {
    expect(naiveOutcome(ghostAfterDelivery)).toBe('dropped');
  });

  it('reports the delivered cut, not a loss, when a retirement row follows the delivery', () => {
    const out = deriveLastRespawnOutcome(ghostAfterDelivery, at('2026-10-03T00:36:51.000Z'));
    expect(out.outcome).toBe('delivered');
    expect(out.ts).toBe('2026-10-03T00:33:31.325Z');
    expect(lostRespawnAmbientLine(out)).toBeNull();
    expect(priorRespawnNote(out)).toBe('');
  });

  it('stays quiet as the retired request ages — no spurious DELAYED once capMs + grace elapses', () => {
    // 40 min later: a surviving `respawn-rearm-queued` would read as an orphaned pending
    // (capMs 360s + 120s grace) and raise DELAYED. Retiring it with the drop prevents that.
    const out = deriveLastRespawnOutcome(ghostAfterDelivery, at('2026-10-03T01:16:31.000Z'));
    expect(out.outcome).toBe('delivered');
    expect(lostRespawnAmbientLine(out)).toBeNull();
  });

  it('a retirement row alone (no earlier verdict) is `none`, not `dropped` or `pending`', () => {
    const out = deriveLastRespawnOutcome(ghostAfterDelivery.slice(3), at('2026-10-03T00:40:00.000Z'));
    expect(out).toEqual({ outcome: 'none' });
    expect(lostRespawnAmbientLine(out)).toBeNull();
  });

  it('a non-rearmed superseded drop (stale injectChild) is also a retirement', () => {
    const out = deriveLastRespawnOutcome(
      [
        { ts: '2026-10-03T00:33:31.325Z', kind: 'respawn-carry-delivered', mode: 'carry-respawn' },
        { ts: '2026-10-03T00:34:00.000Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'superseded' },
      ],
      at('2026-10-03T00:34:10.000Z'),
    );
    expect(out.outcome).toBe('delivered');
  });

  it('CONTROL: a REAL drop after the delivery is still a drop, with its host reason', () => {
    const out = deriveLastRespawnOutcome(
      [
        ...ghostAfterDelivery.slice(0, 2),
        { ts: '2026-10-03T00:50:00.000Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'turn-start-unverified' },
      ],
      at('2026-10-03T00:50:30.000Z'),
    );
    expect(out).toMatchObject({ outcome: 'dropped', reason: 'turn-start-unverified' });
    expect(lostRespawnAmbientLine(out)).toContain('carry-respawn DROPPED');
  });

  it('a NEWER request pending after the retirement is still reported pending', () => {
    const out = deriveLastRespawnOutcome(
      [
        ...ghostAfterDelivery,
        { ts: '2026-10-03T00:45:00.000Z', kind: 'respawn-rearm-queued', mode: 'carry-respawn', reason: 'busy-gate-expired', capMs: 360_000 },
      ],
      at('2026-10-03T00:45:20.000Z'),
    );
    expect(out.outcome).toBe('pending');
    expect(out.ts).toBe('2026-10-03T00:45:00.000Z');
  });

  it('retirement does not mask an OLDER real drop — no respawn has succeeded since it', () => {
    const out = deriveLastRespawnOutcome(
      [
        { ts: '2026-10-03T00:10:00.000Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'busy-gate-expired' },
        { ts: '2026-10-03T00:20:00.000Z', kind: 'respawn-rearm-queued', mode: 'carry-respawn', capMs: 360_000 },
        { ts: '2026-10-03T00:20:00.001Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'superseded', rearmed: true },
      ],
      at('2026-10-03T00:21:00.000Z'),
    );
    expect(out).toMatchObject({ outcome: 'dropped', reason: 'busy-gate-expired' });
  });

  it('chained retirements fold together onto the last real verdict', () => {
    const out = deriveLastRespawnOutcome(
      [
        { ts: '2026-10-03T00:33:31.325Z', kind: 'respawn-carry-delivered', mode: 'carry-respawn' },
        { ts: '2026-10-03T00:36:00.000Z', kind: 'respawn-rearm-queued', mode: 'carry-respawn', capMs: 360_000 },
        { ts: '2026-10-03T00:36:00.001Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'superseded', rearmed: true },
        { ts: '2026-10-03T00:41:00.000Z', kind: 'respawn-rearm-superseded', mode: 'carry-respawn' },
        { ts: '2026-10-03T00:41:00.001Z', kind: 'respawn-carry-dropped', mode: 'carry-respawn', reason: 'superseded' },
      ],
      at('2026-10-03T00:42:00.000Z'),
    );
    expect(out.outcome).toBe('delivered');
  });
});
