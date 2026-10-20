import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const batchMock = vi.fn();
vi.mock('../agent-tools/coordination/escalations', () => ({
  listEscalations: (...a: unknown[]) => listMock(...a),
  resolveEscalationsBatch: (...a: unknown[]) => batchMock(...a),
}));

const resolveStatesMock = vi.fn();
const getPresenceMock = vi.fn();
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: (...a: unknown[]) => resolveStatesMock(...a),
}));
vi.mock('../agent-tools/coordination/presence', () => ({
  getPresence: (...a: unknown[]) => getPresenceMock(...a),
  listPresence: vi.fn(),
  probeProcessLiveness: vi.fn(),
}));

const getWorkItemMock = vi.fn();
vi.mock('../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItemMock(...a),
  TERMINAL_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed'],
}));

import {
  selectStaleEscalations,
  reconcileStaleEscalationsOnce,
  selectUnanswerableEscalations,
  unanswerableCandidateAuthors,
  reconcileUnanswerableEscalationsOnce,
  UNANSWERABLE_ESCALATION_TTL_MS,
  UNANSWERABLE_CHOICE_ESCALATION_TTL_MS,
  selectEscalationSlaReroutes,
  rerouteUnackedEscalationsOnce,
  type StaleEscalationInput,
  type EscalationRerouteDriver,
  type EscalationRerouteInput,
} from './reconcile-escalations';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // a fixed "now" far from epoch
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ttl = 3 * DAY;

function row(over: Partial<StaleEscalationInput>): StaleEscalationInput {
  return { msg_id: 'm', from: 'system:hive-placement-watchdog', options: [], ts: iso(10 * DAY), ...over };
}

describe('selectStaleEscalations (P-003/P-005)', () => {
  it('selects an operational system escalation older than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'old' })], { nowMs: NOW, ttlMs: ttl });
    expect(r.map((x) => x.msg_id)).toEqual(['old']);
    expect(r[0].ageDays).toBeCloseTo(10, 1);
  });

  it('skips an operational escalation younger than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'fresh', ts: iso(1 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a genuine agent escalation (non-system sender), even if ancient', () => {
    const r = selectStaleEscalations([row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a system escalation that carries options (a real choice)', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(99 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r).toEqual([]);
  });

  it('treats both bare `system` and `system:<emitter>` as operational', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'bare', from: 'system' }), row({ msg_id: 'wd', from: 'system:hive-placement-watchdog' })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['bare', 'wd']);
  });

  it('skips rows with an unparseable timestamp (no crash)', () => {
    const r = selectStaleEscalations([row({ msg_id: 'bad', ts: 'not-a-date' })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('returns oldest-first so a batch-limited sweep drains the longest-stale first', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'a', ts: iso(5 * DAY) }), row({ msg_id: 'b', ts: iso(40 * DAY) }), row({ msg_id: 'c', ts: iso(12 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['b', 'c', 'a']);
  });

  // ── WI-36154: the row IS the suppressor ────────────────────────────────────
  // liveness-alarm.ts:1552 skips firing a signal that already has an open
  // escalation, so GC'ing that row does not tidy a duplicate — it re-arms the
  // alarm on a still-true condition. Measured 14d: 5 of 5 such auto-resolves
  // re-fired within 120s.
  it('NEVER selects a row carrying a livenessSignature — resolving it re-arms the alarm (WI-36154)', () => {
    const r = selectStaleEscalations(
      [
        row({
          msg_id: 'oscillator',
          from: 'system:infra-liveness-alarm',
          ts: iso(3 * DAY),
          livenessSignature: 'stale-paused-routines',
        }),
        // CALIBRATION CONTROL: same sender, same age, NO signature. The sweep
        // must still clear this one — otherwise the assertion above would pass
        // just as well with the whole sweep disabled, and prove nothing.
        row({ msg_id: 'control', from: 'system:infra-liveness-alarm', ts: iso(3 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['control']);
  });

  it('exempts ONLY a non-empty string signature — a junk jsonb value must not widen the exemption', () => {
    // The field arrives from jsonb, so the guard is typed `unknown`. If any
    // truthy-ish value exempted a row, the narrow exemption would become a
    // silent opt-out for anything that happened to carry the key.
    const r = selectStaleEscalations(
      [
        row({ msg_id: 'empty', livenessSignature: '' }),
        row({ msg_id: 'nonstring', livenessSignature: 1 }),
        row({ msg_id: 'nullish', livenessSignature: null }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['empty', 'nonstring', 'nullish']);
  });

  // ── WI-36214: the general marker ───────────────────────────────────────────
  // The livenessSignature leg above covers ONE emitter. Re-running the
  // resolve→re-fire probe against the rows that exemption LEFT BEHIND found 6
  // more oscillators from system:escalation-aging-alarm, whose gate
  // (escalation-aging-alarm.ts:167) is identical but carries no signature.
  it('NEVER selects a row an emitter marked selfReconciling (WI-36214)', () => {
    const r = selectStaleEscalations(
      [
        row({
          msg_id: 'aging-alarm',
          from: 'system:escalation-aging-alarm',
          ts: iso(3 * DAY),
          selfReconciling: true,
        }),
        // CALIBRATION CONTROL: an operational row from the mass-emitter this
        // sweep was BUILT for (one row per cursed placement, no re-fire gate,
        // ~7000 opened / ~135 resolved). If this ever stops being selected the
        // exemption has leaked into the population the GC exists to drain.
        row({ msg_id: 'cursed-placement', from: 'system:pot-placement-watchdog', ts: iso(3 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['cursed-placement']);
  });

  it('exempts ONLY selfReconciling === true, never a merely truthy value', () => {
    const r = selectStaleEscalations(
      [
        row({ msg_id: 'truthy-string', selfReconciling: 'yes' }),
        row({ msg_id: 'truthy-number', selfReconciling: 1 }),
        row({ msg_id: 'false', selfReconciling: false }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['false', 'truthy-number', 'truthy-string']);
  });
});

describe('reconcileStaleEscalationsOnce (P-003)', () => {
  beforeEach(() => {
    listMock.mockReset();
    batchMock.mockReset();
    // Default: the batch resolves everything it is handed.
    batchMock.mockImplementation((items: { msg_id: string }[]) =>
      Promise.resolve({ resolved: items.length, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 }),
    );
  });

  it('resolves only the stale operational escalations and reports counts', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'old1', ts: iso(10 * DAY) }), // stale operational → resolve
      row({ msg_id: 'old2', ts: iso(20 * DAY) }), // stale operational → resolve
      row({ msg_id: 'fresh', ts: iso(1 * DAY) }), // too fresh → keep
      row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) }), // genuine → never
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ scanned: 4, stale: 2, resolved: 2, truncated: false });
    // EI-1490: the sweep resolves the whole batch in ONE call (was one call per
    // item, each re-loading the entire escalation log — O(n²) over ~13k rows).
    expect(batchMock).toHaveBeenCalledTimes(1);
    const items = batchMock.mock.calls[0][0] as { msg_id: string; resolver: string }[];
    expect(items.map((i) => i.msg_id).sort()).toEqual(['old1', 'old2']);
    // stamps the reconcile owner so the resolution is attributable in the ledger
    expect(items[0].resolver).toBe('system:attention-reconcile');
  });

  it('respects the batch limit and reports truncated=true', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'a', ts: iso(10 * DAY) }),
      row({ msg_id: 'b', ts: iso(20 * DAY) }),
      row({ msg_id: 'c', ts: iso(30 * DAY) }),
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl, limit: 2 });
    expect(r).toMatchObject({ stale: 3, resolved: 2, truncated: true });
    // ONE batch call carrying exactly the limit-bounded slice.
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect((batchMock.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('does not hand a livenessSignature row to the batch resolver (WI-36154, end-to-end)', async () => {
    // Pins the PLUMBING, not just the selector: `listEscalations` returns the
    // stored envelope whole (the projection selects `body`; the event-fold
    // spreads `{ ...open, resolved }`), and liveness-alarm's `meta` is FLATTENED
    // onto that envelope (escalations.ts:190), so the signature really does
    // arrive top-level. The call site casts through `unknown`, which would
    // happily drop a field the interface never declared — this test fails if
    // that plumbing is ever narrowed.
    listMock.mockResolvedValue([
      row({
        msg_id: 'live-suppressor',
        from: 'system:infra-liveness-alarm',
        ts: iso(30 * DAY),
        livenessSignature: 'stale-paused-routines',
      }),
      row({ msg_id: 'ordinary', ts: iso(10 * DAY) }),
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ scanned: 2, stale: 1, resolved: 1 });
    const items = batchMock.mock.calls[0][0] as { msg_id: string }[];
    expect(items.map((i) => i.msg_id)).toEqual(['ordinary']);
  });

  it('is idempotent: an already-resolved escalation is not counted as resolved', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'gone', ts: iso(10 * DAY) })]);
    batchMock.mockResolvedValue({ resolved: 0, notFound: 0, alreadyResolved: 1, requiresSpawnApprove: 0 });
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 0 });
  });

  it('makes NO batch call when there is nothing stale (empty sweep)', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'fresh', ts: iso(1 * DAY) })]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });
});

// ─── EI-19411323991062966: dead-author (unanswerable) reaper ──────────────────

/** A NON-operational row — an agent-authored ask, which the operational sweep
 *  never touches. Ancient by default so age is never what a case turns on. */
function humanRow(over: Partial<StaleEscalationInput>): StaleEscalationInput {
  return { msg_id: 'h', from: 'su-dead-1', options: [], ts: iso(30 * DAY), ...over };
}
const GONE = () => true;
const ALIVE = () => false;

describe('selectUnanswerableEscalations (EI-19411323991062966)', () => {
  it('selects a past-TTL non-operational row whose author is GONE', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'dead' })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: GONE,
    });
    expect(r.map((x) => x.msg_id)).toEqual(['dead']);
  });

  // The load-bearing guard: this reaper closes rows that LOOK like human
  // decisions, so a live author must be untouchable at ANY age.
  it('NEVER selects a row whose author is LIVE, however ancient', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'live', ts: iso(999 * DAY) })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: ALIVE,
    });
    expect(r).toEqual([]);
  });

  it('NEVER selects an OPERATIONAL row — the TTL sweep owns those', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'op', from: 'system:hive-placement-watchdog' })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  // WI-2140594: an option-carrying row is a REAL CHOICE, so the bar is higher on
  // BOTH legs — the longer choice TTL, and gone-ness by EXPLICIT verdict only
  // (presence-absence, which suffices for an option-less row, never does here).
  it('NEVER selects a row carrying options when the caller supplies no verdict leg, however ancient', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(999 * DAY) })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  it('NEVER selects a row carrying options inside the choice TTL, even from an explicitly-ended author', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(5 * DAY) })],
      { nowMs: NOW, ttlMs: ttl, choiceTtlMs: 6 * DAY, isAuthorGone: GONE, isAuthorGoneByVerdict: GONE },
    );
    expect(r).toEqual([]);
  });

  it('NEVER selects a row carrying options on presence-absence alone (no explicit verdict)', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(999 * DAY) })],
      { nowMs: NOW, ttlMs: ttl, choiceTtlMs: 6 * DAY, isAuthorGone: GONE, isAuthorGoneByVerdict: ALIVE },
    );
    expect(r).toEqual([]);
  });

  it('selects a row carrying options past the choice TTL when the author is gone by EXPLICIT verdict', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(7 * DAY) })],
      { nowMs: NOW, ttlMs: ttl, choiceTtlMs: 6 * DAY, isAuthorGone: ALIVE, isAuthorGoneByVerdict: GONE },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['choice']);
    expect(r[0].hasOptions).toBe(true);
  });

  it('the default choice window is longer than the option-less window (a choice is never the cheaper reap)', () => {
    expect(UNANSWERABLE_CHOICE_ESCALATION_TTL_MS).toBeGreaterThan(UNANSWERABLE_ESCALATION_TTL_MS);
  });

  it('does not select inside the TTL even when the author is gone', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: GONE,
    });
    expect(r).toEqual([]);
  });

  it('skips a blank sender (nobody to prove absent) and an unparseable ts', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'blank', from: '  ' }), humanRow({ msg_id: 'bad', ts: 'not-a-date' })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  it('probes only distinct non-operational past-TTL senders', () => {
    const authors = unanswerableCandidateAuthors(
      [
        humanRow({ msg_id: 'a', from: 'su-x' }),
        humanRow({ msg_id: 'b', from: 'su-x' }),
        humanRow({ msg_id: 'c', from: 'system:wd' }),
        humanRow({ msg_id: 'd', from: 'su-y', ts: iso(1 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(authors).toEqual(['su-x']);
  });
});

describe('reconcileUnanswerableEscalationsOnce (EI-19411323991062966)', () => {
  beforeEach(() => {
    listMock.mockReset();
    batchMock.mockReset();
    resolveStatesMock.mockReset();
    getPresenceMock.mockReset();
  });

  // The real-world path: 226 of 229 authors have no presence row AND no verdict.
  it('resolves when there is NO verdict and NO presence row (the dominant case)', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockResolvedValue(null);
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
    expect(batchMock.mock.calls[0][0][0]).toMatchObject({ msg_id: 'dead', choice: 'unanswerable' });
  });

  // no-entry is AMBIGUOUS: it means degraded-fetch OR never-heard-of. A present
  // presence row proves the author is known, so absence-of-verdict is not death.
  it('does NOT resolve when a presence row EXISTS despite no verdict', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'known' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockResolvedValue({ ownerId: 'su-dead-1' });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('an explicit LIVE verdict outranks a missing presence row', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'live' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'live' }]]));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("treats 'suspect' as ambiguous — NOT gone", async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'maybe' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'suspect' }]]));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
  });

  it("resolves on an explicit 'ended' verdict", async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'ended' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'ended' }]]));
    getPresenceMock.mockResolvedValue({ ownerId: 'su-dead-1' });
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
  });

  // WI-2140594: the oracle is TOTAL (EI-18771777750306094) — an owner it has no
  // signal for gets an in-band `sessionState: null`, never a missing entry. That
  // null is UNKNOWN, so it must fall through to the presence leg rather than read
  // as "not gone" (which is what silently retired the presence leg).
  it('a null (unknown) verdict falls through to the presence leg — absent row ⇒ gone', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'unknown-absent' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: null, signalMissing: true }]]));
    getPresenceMock.mockResolvedValue(null);
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
  });

  it('a null (unknown) verdict with a presence row PRESENT ⇒ NOT gone', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'unknown-known' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: null, signalMissing: true }]]));
    getPresenceMock.mockResolvedValue({ ownerId: 'su-dead-1' });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });

  // WI-2140594: an option-carrying row is a real choice, so it needs BOTH the
  // longer window AND an explicit verdict — presence-absence alone never does it.
  it('reaps an option-carrying row past the choice TTL ONLY on an explicit ended verdict', async () => {
    const choiceTtl = 2 * ttl;
    const choiceRow = humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(choiceTtl + DAY) });

    listMock.mockResolvedValue([choiceRow]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockResolvedValue(null);
    let r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl, choiceTtlMs: choiceTtl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'swept' });
    expect(batchMock).not.toHaveBeenCalled();

    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'ended' }]]));
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });
    r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl, choiceTtlMs: choiceTtl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
    expect(batchMock.mock.calls[0][0][0]).toMatchObject({ msg_id: 'choice', choice: 'unanswerable' });
    expect(batchMock.mock.calls[0][0][0].note).toMatch(/options were never chosen/);
  });

  it('an option-carrying row inside the choice TTL is not even a probe candidate', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'choice-young', options: [{ id: 'a' }], ts: iso(ttl + DAY) })]);
    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl, choiceTtlMs: 4 * ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'no-candidates' });
    expect(resolveStatesMock).not.toHaveBeenCalled();
  });

  // FAIL-SAFE. Without this, one transient outage mass-closes every real ask.
  it('resolves NOTHING when the liveness probe throws', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockRejectedValue(new Error('oracle down'));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'aborted' });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('resolves NOTHING when the presence read throws', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockRejectedValue(new Error('presence down'));

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'aborted' });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('never probes liveness at all when nothing is past the TTL', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })]);
    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'no-candidates' });
    expect(resolveStatesMock).not.toHaveBeenCalled();
    expect(getPresenceMock).not.toHaveBeenCalled();
  });

  // WI-7397 regression guard. The defect was NOT that the fail-safe resolves
  // nothing — that is correct — but that it was INDISTINGUISHABLE from a
  // healthy idle tick, so a permanently-degraded reaper looked exactly like one
  // with no work to do. If someone ever collapses these back onto a single
  // shared `nothing` value, this fails.
  it('WI-7397: a fail-safe abort is distinguishable from a healthy no-op', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })]);
    const healthy = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });

    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockRejectedValue(new Error('oracle down'));
    getPresenceMock.mockResolvedValue(null);
    const degraded = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });

    // The counts are identical — that is precisely why they used to be confused.
    expect(healthy.resolved).toBe(degraded.resolved);
    expect(healthy.stale).toBe(degraded.stale);
    // The outcome is what separates them.
    expect(healthy.outcome).toBe('no-candidates');
    expect(degraded.outcome).toBe('aborted');
    expect(healthy.outcome).not.toBe(degraded.outcome);
  });
});

// ─── EI-7024: past-SLA escalation reroute ─────────────────────────────────────

function rerouteRow(over: Partial<EscalationRerouteInput>): EscalationRerouteInput {
  return {
    msg_id: 'e-1',
    from: 'su-author',
    options: [],
    ts: iso(60 * 60 * 1000),
    summary: 'human decision is waiting',
    plan_slug: 'plan-a',
    harness_slug: 'pot-a',
    ...over,
  };
}

function driver(ownerId: string, over: Partial<EscalationRerouteDriver> = {}): EscalationRerouteDriver {
  return {
    ownerId,
    sessionState: 'live',
    agentRole: 'su',
    currentPlanSlug: null,
    potSlug: null,
    fleetSlug: null,
    standdownHeld: false,
    ...over,
  };
}

describe('selectEscalationSlaReroutes (EI-7024)', () => {
  it('ranks a different live su by author fleet leader, same fleet, plan, then harness', () => {
    const roster = [
      driver('su-author', { fleetSlug: 'alpha', currentPlanSlug: 'plan-a', potSlug: 'pot-a' }),
      driver('su-harness', { potSlug: 'pot-a' }),
      driver('su-plan', { currentPlanSlug: 'plan-a' }),
      driver('su-member', { fleetSlug: 'alpha' }),
      driver('su-leader', { fleetSlug: 'alpha' }),
    ];
    const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      leaderByFleet: new Map([['alpha', 'su-leader']]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ targetOwnerId: 'su-leader', reason: 'author-fleet-leader' });
  });

  it('falls through deterministically and never chooses the author or a non-su/non-live/contextless agent', () => {
    const roster = [
      // Non-live author: a LIVE author would suppress every non-leader hop
      // (WI-10003519), and this case is about the fall-through order.
      driver('su-author', { sessionState: 'ended', currentPlanSlug: 'plan-a' }),
      driver('su-contextless'),
      driver('cup-plan', { agentRole: 'cup', currentPlanSlug: 'plan-a' }),
      driver('su-parked-plan', { sessionState: 'parked', currentPlanSlug: 'plan-a' }),
      driver('su-z-plan', { currentPlanSlug: 'plan-a' }),
      driver('su-a-plan', { currentPlanSlug: 'plan-a' }),
    ];
    const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
    });
    expect(selected[0]).toMatchObject({ targetOwnerId: 'su-a-plan', reason: 'same-plan' });
  });

  // WI-10003519: measured 2026-09-27 — a live fleet leader's owner-spend ask
  // (to:['human']) was rerouted 'author-fleet-member' to its own member, twice.
  it('never reroutes a LIVE fleet leader author down to its own member or sideways to a peer', () => {
    const roster = [
      driver('su-author', { fleetSlug: 'alpha', currentPlanSlug: 'plan-a', potSlug: 'pot-a' }),
      driver('su-member', { fleetSlug: 'alpha' }),
      driver('su-plan', { currentPlanSlug: 'plan-a' }),
      driver('su-harness', { potSlug: 'pot-a' }),
    ];
    const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      leaderByFleet: new Map([['alpha', 'su-author']]),
    });
    expect(selected).toEqual([]);
  });

  it('a LIVE member author reroutes only UP to its fleet leader, never to a sibling or plan peer', () => {
    const base = [
      driver('su-author', { fleetSlug: 'alpha', currentPlanSlug: 'plan-a' }),
      driver('su-sibling', { fleetSlug: 'alpha' }),
      driver('su-plan', { currentPlanSlug: 'plan-a' }),
    ];
    const ctx = { nowMs: NOW, slaMs: 30 * 60 * 1000, leaderByFleet: new Map([['alpha', 'su-leader']]) };
    // Leader not live → nobody above the author is available → no reroute.
    expect(selectEscalationSlaReroutes([rerouteRow({})], base, ctx)).toEqual([]);
    // Leader live → the upward hop is still taken.
    const withLeader = [...base, driver('su-leader', { fleetSlug: 'alpha' })];
    expect(selectEscalationSlaReroutes([rerouteRow({})], withLeader, ctx)[0]).toMatchObject({
      targetOwnerId: 'su-leader',
      reason: 'author-fleet-leader',
    });
  });

  it('a NON-live author (dead leader) still falls through to its fleet member', () => {
    for (const authorState of ['ended', 'suspect', null] as const) {
      const roster = [
        driver('su-author', { sessionState: authorState, fleetSlug: 'alpha', currentPlanSlug: 'plan-a' }),
        driver('su-member', { fleetSlug: 'alpha' }),
        driver('su-plan', { currentPlanSlug: 'plan-a' }),
      ];
      const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
        nowMs: NOW,
        slaMs: 30 * 60 * 1000,
        leaderByFleet: new Map([['alpha', 'su-author']]),
      });
      expect(selected[0]).toMatchObject({ targetOwnerId: 'su-member', reason: 'author-fleet-member' });
    }
  });

  it('rejects young, operational, non-agent, loopback-test, acknowledged, and contextless rows', () => {
    const rows = [
      rerouteRow({ msg_id: 'young', ts: iso(5 * 60 * 1000) }),
      rerouteRow({ msg_id: 'system', from: 'system:watchdog' }),
      rerouteRow({ msg_id: 'human', from: 'human' }),
      rerouteRow({
        msg_id: 'loopback-fixture',
        from: 'su-loopback',
        summary: 'Test?',
        body: '',
        options: ['Yes', 'No'],
      }),
      rerouteRow({ msg_id: 'loopback-namespaced', from: 'su-loopback:transport-test' }),
      rerouteRow({ msg_id: 'acked' }),
      rerouteRow({ msg_id: 'contextless', plan_slug: undefined, harness_slug: undefined }),
    ];
    const selected = selectEscalationSlaReroutes(rows, [driver('su-plan', { currentPlanSlug: 'plan-a' })], {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      responseMarkers: new Set(['acked']),
    });
    expect(selected).toEqual([]);
  });

  // EI-21451978219397190: during an owner-directed global stand-down,
  // "unacknowledged by the human" is the EXPECTED state — so the SLA must not
  // read it as a fault and go wake the agents the stand-down told to stay idle.
  describe('global stand-down guard (EI-21451978219397190)', () => {
    it('skips a stood-down driver and lands on whoever the owner left running', () => {
      const roster = [
        // Non-live author: a live one would suppress the same-plan hop (WI-10003519).
        driver('su-author', { sessionState: 'ended', currentPlanSlug: 'plan-a' }),
        // Sorts first, so it wins on every tie-break EXCEPT the stand-down.
        driver('su-a-plan', { currentPlanSlug: 'plan-a', standdownHeld: true }),
        driver('su-z-plan', { currentPlanSlug: 'plan-a' }),
      ];
      const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
        nowMs: NOW,
        slaMs: 30 * 60 * 1000,
      });
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ targetOwnerId: 'su-z-plan', reason: 'same-plan' });

      // Control: with the hold lifted, the SAME roster picks the stood-down one
      // back up — so the assertion above is the guard firing, not the ranking.
      const lifted = selectEscalationSlaReroutes(
        [rerouteRow({})],
        roster.map((r) => ({ ...r, standdownHeld: false })),
        { nowMs: NOW, slaMs: 30 * 60 * 1000 },
      );
      expect(lifted[0]).toMatchObject({ targetOwnerId: 'su-a-plan' });
    });

    it('selects nobody when every eligible driver is stood down, rather than walking the roster', () => {
      const roster = [
        driver('su-author', { fleetSlug: 'alpha', currentPlanSlug: 'plan-a', potSlug: 'pot-a' }),
        driver('su-leader', { fleetSlug: 'alpha', standdownHeld: true }),
        driver('su-member', { fleetSlug: 'alpha', standdownHeld: true }),
        driver('su-plan', { currentPlanSlug: 'plan-a', standdownHeld: true }),
        driver('su-harness', { potSlug: 'pot-a', standdownHeld: true }),
      ];
      const ctx = {
        nowMs: NOW,
        slaMs: 30 * 60 * 1000,
        leaderByFleet: new Map([['alpha', 'su-leader']]),
      };
      expect(selectEscalationSlaReroutes([rerouteRow({})], roster, ctx)).toEqual([]);
      // Control: the fixture DOES reroute once the stand-down lapses, so the
      // empty result above cannot be an inert fixture that selects nothing.
      expect(
        selectEscalationSlaReroutes([rerouteRow({})], roster.map((r) => ({ ...r, standdownHeld: false })), ctx),
      ).toHaveLength(1);
    });
  });
});

describe('rerouteUnackedEscalationsOnce (EI-7024)', () => {
  it('sends one deterministic action marker, wakes the target, and never resolves the escalation', async () => {
    const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
    const wake = vi.fn(async () => ({ woken: 1 }));
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      listEscalationsFn: vi.fn(async () => [rerouteRow({})]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        {
          ownerId: 'su-author',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
        {
          ownerId: 'su-driver',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      sendMessageFn: send as never,
      wakeRecipientsFn: wake as never,
    });

    expect(result).toMatchObject({ scanned: 1, selected: 1, rerouted: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({
      to: ['su-driver'],
      msgId: 'escalation-sla-reroute:e-1',
      extra: {
        expects: 'action',
        lifecycle: 'escalation-sla-reroute',
        escalationRerouteOf: 'e-1',
      },
    });
    expect(send.mock.calls[0][1].related_msg_id).toBeUndefined();
    expect(send.mock.calls[0][1].body).toContain(
      "coord:ack { msg_id: 'escalation-sla-reroute:e-1' }",
    );
    expect(batchMock).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(
      ['su-driver'],
      expect.objectContaining({ source: 'system:escalation-sla-reroute', workspaceId: 'ws-a' }),
    );
  });

  // EI-26354731733540396: the escalation summary is caller prose and can name
  // an older conversation. The flat conversationId stamp is the machine link
  // and must drive the reroute headline plus its structured/wake payloads.
  it('uses the canonical linked conversation id instead of a stale id in caller prose', async () => {
    const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
    const wake = vi.fn(async () => ({ woken: 1 }));
    const staleConversationId = 'conv-stale-summary';
    const canonicalConversationId = 'conv-canonical-link';
    const summary = `publisher gate for ${staleConversationId}`;
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      listEscalationsFn: vi.fn(async () => [
        rerouteRow({ summary, conversationId: ` ${canonicalConversationId} ` }),
      ]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        {
          ownerId: 'su-author',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
        {
          ownerId: 'su-driver',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      sendMessageFn: send as never,
      wakeRecipientsFn: wake as never,
    });

    expect(result).toMatchObject({ scanned: 1, selected: 1, rerouted: 1, failed: 0 });
    const notice = send.mock.calls[0]![1];
    expect(notice.summary).toContain(`linked conversation ${canonicalConversationId}`);
    expect(notice.summary).not.toContain(staleConversationId);
    expect(notice.body).toContain(`Canonical linked conversation: ${canonicalConversationId}`);
    expect(notice.body).toContain(`Original escalation summary (verbatim): ${summary}`);
    expect(notice.extra).toMatchObject({ conversationId: canonicalConversationId });
    expect(wake).toHaveBeenCalledWith(
      ['su-driver'],
      expect.objectContaining({
        payload: expect.objectContaining({ conversationId: canonicalConversationId }),
      }),
    );
  });

  // EI-21451978219397190: the pause must not manufacture the wakes that break it.
  it('sends and wakes NOTHING when the only driver is stood down, and reports it as standdownSuppressed', async () => {
    const runWith = async (standdown: string[]) => {
      const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
      const wake = vi.fn(async () => ({ woken: 1 }));
      const result = await rerouteUnackedEscalationsOnce({
        nowMs: NOW,
        slaMs: 30 * 60 * 1000,
        workspaceId: 'ws-a',
        listEscalationsFn: vi.fn(async () => [rerouteRow({})]) as typeof listMock,
        readResponseMarkersFn: vi.fn(async () => new Set<string>()),
        listLoopStanddownOwnersFn: vi.fn(async () => new Set(standdown)),
        listPresenceFn: vi.fn(async () => [
          {
            ownerId: 'su-author',
            agentRole: 'su',
            currentPlanSlug: 'plan-a',
            potSlug: 'pot-a',
            heartbeatAt: iso(0),
            stale: false,
            host: '',
            pid: null,
            source: 'omp-hook-session',
          },
          {
            ownerId: 'su-driver',
            agentRole: 'su',
            currentPlanSlug: 'plan-a',
            potSlug: 'pot-a',
            heartbeatAt: iso(0),
            stale: false,
            host: '',
            pid: null,
            source: 'omp-hook-session',
          },
        ]) as never,
        resolveSessionStatesFn: vi.fn(
          async () =>
            new Map([
              ['su-author', { sessionState: 'parked' }],
              ['su-driver', { sessionState: 'live' }],
            ]),
        ) as never,
        fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
        getFleetFn: vi.fn(async () => null) as never,
        sendMessageFn: send as never,
        wakeRecipientsFn: wake as never,
      });
      return { result, send, wake };
    };

    const held = await runWith(['su-driver']);
    expect(held.result).toMatchObject({
      scanned: 1,
      selected: 0,
      rerouted: 0,
      failed: 0,
      standdownSuppressed: 1,
    });
    expect(held.send).not.toHaveBeenCalled();
    expect(held.wake).not.toHaveBeenCalled();

    // Both-ways control on the IDENTICAL fixture: with no stand-down held it
    // reroutes and wakes as before. Without this, an inert fixture that never
    // selected anything would pass the assertions above and look like a guard.
    const free = await runWith([]);
    expect(free.result).toMatchObject({ selected: 1, rerouted: 1, standdownSuppressed: 0 });
    expect(free.wake).toHaveBeenCalledTimes(1);
  });

  // EI-21834041480805949: never wake a second member when the escalation's own
  // subject work-item already has a live, actively-progressing assignee.
  describe('subject-work-item liveness guard (EI-21834041480805949)', () => {
    const baseArgs = {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        { ownerId: 'su-author', agentRole: 'su', currentPlanSlug: 'plan-a', potSlug: 'pot-a', heartbeatAt: iso(0), stale: false, host: '', pid: null, source: 'omp-hook-session' },
        { ownerId: 'su-driver', agentRole: 'su', currentPlanSlug: 'plan-a', potSlug: 'pot-a', heartbeatAt: iso(0), stale: false, host: '', pid: null, source: 'omp-hook-session' },
        { ownerId: 'su-progressing', agentRole: 'su', currentPlanSlug: 'plan-a', potSlug: 'pot-a', heartbeatAt: iso(0), stale: false, host: '', pid: null, source: 'omp-hook-session' },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
            ['su-progressing', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
    };

    it('suppresses the reroute when the named subject already has a live, actively-progressing assignee', async () => {
      const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
      const wake = vi.fn(async () => ({ woken: 1 }));
      getWorkItemMock.mockResolvedValueOnce({
        id: 'WI-924391',
        state: 'wip',
        assignee: 'su-progressing',
        takenAt: iso(5 * 60 * 1000),
        lastProgressAt: iso(60 * 1000), // 1 minute ago — well within the staleness window
      });
      const result = await rerouteUnackedEscalationsOnce({
        ...baseArgs,
        listEscalationsFn: vi.fn(async () => [
          rerouteRow({ summary: 'take over unacknowledged escalation for WI-924391' }),
        ]) as typeof listMock,
        sendMessageFn: send as never,
        wakeRecipientsFn: wake as never,
      });
      expect(result).toMatchObject({
        scanned: 1,
        selected: 0,
        rerouted: 0,
        subjectActivelyWorkedSkipped: 1,
      });
      expect(send).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    });

    it.each([
      ['no subject id in prose', 'human decision is waiting', () => {}],
      [
        'subject is terminal',
        'take over unacknowledged escalation for WI-924391',
        () =>
          getWorkItemMock.mockResolvedValueOnce({
            id: 'WI-924391',
            state: 'passed',
            assignee: 'su-progressing',
            takenAt: iso(5 * 60 * 1000),
            lastProgressAt: iso(60 * 1000),
          }),
      ],
      [
        'subject has no assignee',
        'take over unacknowledged escalation for WI-924391',
        () =>
          getWorkItemMock.mockResolvedValueOnce({
            id: 'WI-924391',
            state: 'wip',
            assignee: null,
            takenAt: null,
            lastProgressAt: null,
          }),
      ],
      [
        "subject's assignee is stale (no recent progress)",
        'take over unacknowledged escalation for WI-924391',
        () =>
          getWorkItemMock.mockResolvedValueOnce({
            id: 'WI-924391',
            state: 'wip',
            assignee: 'su-progressing',
            takenAt: iso(60 * DAY),
            lastProgressAt: iso(60 * DAY), // far past the staleness window
          }),
      ],
      [
        "subject's assignee is absent from the live roster",
        'take over unacknowledged escalation for WI-924391',
        () =>
          getWorkItemMock.mockResolvedValueOnce({
            id: 'WI-924391',
            state: 'wip',
            assignee: 'su-unknown-elsewhere',
            takenAt: iso(60 * 1000),
            lastProgressAt: iso(60 * 1000),
          }),
      ],
      [
        'subject id does not resolve to a real work-item',
        'take over unacknowledged escalation for WI-924391',
        () => getWorkItemMock.mockResolvedValueOnce(null),
      ],
    ])('still selects the reroute when %s', async (_label, summary, arrange) => {
      arrange();
      const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
      const wake = vi.fn(async () => ({ woken: 1 }));
      const result = await rerouteUnackedEscalationsOnce({
        ...baseArgs,
        listEscalationsFn: vi.fn(async () => [rerouteRow({ summary })]) as typeof listMock,
        sendMessageFn: send as never,
        wakeRecipientsFn: wake as never,
      });
      expect(result).toMatchObject({ scanned: 1, selected: 1, rerouted: 1, subjectActivelyWorkedSkipped: 0 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  it('annotates malformed and contradicted predicates before fail-closed suppression', async () => {
    const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
    const wake = vi.fn(async () => ({ woken: 1 }));
    const revalidate = vi.fn(async () => ({
      status: 'contradicted' as const,
      checkedAt: '2026-08-30T00:00:00.000Z',
      reason: 'current value no longer matches',
    }));
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      listEscalationsFn: vi.fn(async () => [
        rerouteRow({
          msg_id: 'malformed-predicate',
          escalationPredicate: { tool: 'coord:watermark' },
        }),
        rerouteRow({
          msg_id: 'contradicted-predicate',
          escalationPredicate: {
            tool: 'coord:watermark',
            path: 'watermark.messages_since_ts',
            op: 'eq',
            value: 'old',
          },
        }),
      ]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        {
          ownerId: 'su-author',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
        {
          ownerId: 'su-driver',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      revalidatePredicateFn: revalidate as never,
      sendMessageFn: send as never,
      wakeRecipientsFn: wake as never,
    });

    expect(result).toMatchObject({
      scanned: 2,
      selected: 0,
      rerouted: 0,
      failed: 0,
      predicateSkipped: 2,
      artifactUnknownSkipped: 0,
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([, opts]) => opts.msgId).sort()).toEqual([
      'escalation-revalidation:contradicted-predicate:contradicted+no-artifact',
      'escalation-revalidation:malformed-predicate:unknown+no-artifact',
    ]);
    expect(send.mock.calls.find(([, opts]) => opts.msgId.includes('malformed'))?.[1]).toMatchObject({
      to: ['human'],
      extra: {
        lifecycle: 'escalation-revalidation',
        escalationRevalidationOf: 'malformed-predicate',
        predicateValidation: {
          status: 'unknown',
          reason: 'stored escalation predicate is malformed',
        },
      },
    });
    expect(send.mock.calls.find(([, opts]) => opts.msgId.includes('contradicted'))?.[1]).toMatchObject({
      extra: {
        predicateValidation: {
          status: 'contradicted',
          checkedAt: '2026-08-30T00:00:00.000Z',
        },
      },
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it('annotates an unknown artifact read and keeps the automatic route suppressed', async () => {
    const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
    const wake = vi.fn(async () => ({ woken: 1 }));
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      listEscalationsFn: vi.fn(async () => [
        rerouteRow({
          msg_id: 'unknown-artifact',
          escalationPredicate: {
            tool: 'coord:watermark',
            path: 'watermark.messages_since_ts',
            op: 'exists',
          },
          evidence: { band: 'tool-output', ref: 'evidence.txt' },
        }),
      ]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        {
          ownerId: 'su-author',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
        {
          ownerId: 'su-driver',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      revalidatePredicateFn: vi.fn(async () => ({
        status: 'satisfied' as const,
        checkedAt: '2026-08-30T00:00:00.000Z',
      })) as never,
      validateArtifactRefFn: vi.fn(async () => ({
        status: 'unknown' as const,
        ref: 'evidence.txt',
        path: '/unreadable/evidence.txt',
        checkedAt: '2026-08-30T00:00:01.000Z',
        reason: 'permission denied',
      })) as never,
      sendMessageFn: send as never,
      wakeRecipientsFn: wake as never,
    });

    expect(result).toMatchObject({
      scanned: 1,
      selected: 0,
      rerouted: 0,
      failed: 0,
      predicateSkipped: 0,
      artifactUnknownSkipped: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({
      to: ['human'],
      msgId: 'escalation-revalidation:unknown-artifact:satisfied+unknown',
      body: expect.stringContaining('permission denied'),
      extra: {
        lifecycle: 'escalation-revalidation',
        escalationRevalidationOf: 'unknown-artifact',
        predicateValidation: {
          status: 'satisfied',
          checkedAt: '2026-08-30T00:00:00.000Z',
        },
        evidenceValidation: {
          status: 'unknown',
          ref: 'evidence.txt',
          checkedAt: '2026-08-30T00:00:01.000Z',
        },
      },
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it('does no roster/liveness/send work after an existing related-message marker', async () => {
    const listPresenceFn = vi.fn();
    const send = vi.fn();
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      listEscalationsFn: vi.fn(async () => [rerouteRow({})]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set(['e-1'])),
      listPresenceFn: listPresenceFn as never,
      sendMessageFn: send as never,
    });
    expect(result).toMatchObject({ selected: 0, rerouted: 0, failed: 0 });
    expect(listPresenceFn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
