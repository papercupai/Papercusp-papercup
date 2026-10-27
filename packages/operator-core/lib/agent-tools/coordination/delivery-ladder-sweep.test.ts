/**
 * delivery-ladder-sweep (coord-delivery-residual-gaps-2026-07-11 P-004,
 * WI-4160) — the pure escalation verdict + the DI'd sweep pass, no PG.
 * Ratified defaults pinned here: TTL 5m (clamped >=1m), storm cap
 * 1/recipient/10m, LIVE recipients only, directed-only candidates (the SQL
 * filters are exercised by shape via the classifier's inputs).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyLadderEscalations,
  renderLadderBody,
  type LadderMsg,
  runDeliveryLadderSweepOnce,
  ladderTtlMs,
  ladderStormMs,
  LADDER_TTL_MS_DEFAULT,
  LADDER_STORM_MS_DEFAULT,
  DELIVERY_LADDER_OWNER,
  type LadderCandidateRow,
} from './delivery-ladder-sweep';
import type { sendMessage } from './messages';
import type { wakeRecipients } from './inbox-wake';
import type { UnansweredDirectedSummary } from './unanswered-directed';

const NOW = Date.parse('2026-07-11T12:00:00Z');
const MIN = 60_000;

const LIVE = { wakeable: true, liveTurn: true };
const PARKED = { wakeable: true, liveTurn: false };
const ENDED = { wakeable: false, liveTurn: false };

function row(recipient: string, over: Partial<LadderCandidateRow> = {}): LadderCandidateRow {
  return {
    workspace_id: 'ws-1',
    recipient,
    cnt: 2,
    oldest_ts_ms: NOW - 20 * MIN,
    newest_ts_ms: NOW - 6 * MIN,
    newest_from: 'su-peer',
    newest_summary: 'please review X',
    ...over,
  };
}

describe('classifyLadderEscalations (pure verdict)', () => {
  it('escalates a LIVE recipient whose last read predates the newest candidate', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-deaf')],
      lastReadByOwner: new Map([['su-deaf', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-deaf', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      workspaceId: 'ws-1',
      recipient: 'su-deaf',
      candidateCount: 2,
      newestFrom: 'su-peer',
      newestSummary: 'please review X',
    });
    expect(out[0].oldestAgeMs).toBe(20 * MIN);
  });

  it('never escalates a recipient who has read since the newest candidate landed', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-fresh')],
      lastReadByOwner: new Map([['su-fresh', new Date(NOW - MIN).toISOString()]]),
      signals: new Map([['su-fresh', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('a read exactly AT the newest candidate ts counts as read (boundary)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-edge', { newest_ts_ms: NOW - 6 * MIN })],
      lastReadByOwner: new Map([['su-edge', new Date(NOW - 6 * MIN).toISOString()]]),
      signals: new Map([['su-edge', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('escalates a NEVER-read live recipient (no coord read on record at all)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-never')],
      lastReadByOwner: new Map(),
      signals: new Map([['su-never', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
  });

  it('skips PARKED and ENDED recipients — LIVE sessions only (sender-intent rule)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-parked'), row('su-ended')],
      lastReadByOwner: new Map(),
      signals: new Map([
        ['su-parked', PARKED],
        ['su-ended', ENDED],
      ]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('skips a recipient with NO liveness signals (skip-toward-null — a wake is billable)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-unknown')],
      lastReadByOwner: new Map(),
      signals: new Map(),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('skips a storm-capped recipient (1 wake / recipient / window)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-capped')],
      lastReadByOwner: new Map(),
      signals: new Map([['su-capped', LIVE]]),
      capped: new Set(['su-capped']),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('never escalates unread mail from machine senders that cannot receive a reply (EI-13286)', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-finished', {
          cnt: 1,
          newest_from: 'claim-discipline-watch',
          newest_summary: 'claim your lane',
          recent_msgs: [
            msg(6, {
              from: 'claim-discipline-watch',
              summary: 'claim your lane',
            }),
          ],
        }),
      ],
      lastReadByOwner: new Map([['su-finished', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-finished', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('still escalates a peer message when machine chatter shares the candidate window', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-mixed', {
          cnt: 2,
          newest_from: 'claim-discipline-watch',
          newest_summary: 'claim your lane',
          recent_msgs: [
            msg(6, { from: 'claim-discipline-watch', summary: 'claim your lane' }),
            msg(7, { from: 'su-peer', summary: 'can you review this?' }),
          ],
        }),
      ],
      lastReadByOwner: new Map([['su-mixed', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-mixed', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      candidateCount: 1,
      newestFrom: 'su-peer',
      newestSummary: 'can you review this?',
    });
  });

  it('never escalates auto:true wake notices from a sender that does not match MACHINE_SENDER_PATTERN (EI-18688610206822254 — the self-nag loop)', () => {
    // `await-event` (park / degrade-to-inbox notices) always stamps auto:true but its
    // ownerId does not match MACHINE_SENDER_PATTERN (no `system:`/`system-` prefix, no
    // `-watch`/`-sweep`/… suffix) — this is the sole exclusion for it.
    const out = classifyLadderEscalations({
      rows: [
        row('su-looped', {
          cnt: 1,
          newest_from: 'await-event',
          newest_summary: '[await-event] lock:grant:abc fired — wake parked (no live pty)',
          recent_msgs: [
            msg(6, {
              from: 'await-event',
              summary: '[await-event] lock:grant:abc fired — wake parked (no live pty)',
              auto: true,
            }),
          ],
        }),
      ],
      lastReadByOwner: new Map([['su-looped', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-looped', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('still escalates a real peer message when an auto:true await-event notice shares the candidate window', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-mixed-auto', {
          cnt: 2,
          newest_from: 'await-event',
          newest_summary: '[await-event] fired',
          recent_msgs: [
            msg(6, { from: 'await-event', summary: '[await-event] fired', auto: true }),
            msg(7, { from: 'su-peer', summary: 'can you review this?' }),
          ],
        }),
      ],
      lastReadByOwner: new Map([['su-mixed-auto', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-mixed-auto', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      candidateCount: 1,
      newestFrom: 'su-peer',
      newestSummary: 'can you review this?',
    });
  });

  it('skips a row with an unparseable newest ts (never escalate on bad data)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-garbage', { newest_ts_ms: 'not-a-number' })],
      lastReadByOwner: new Map(),
      signals: new Map([['su-garbage', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('orders longest-waiting first (oldest unread drains first under the batch limit)', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-recent', { oldest_ts_ms: NOW - 7 * MIN }),
        row('su-ancient', { oldest_ts_ms: NOW - 300 * MIN }),
      ],
      lastReadByOwner: new Map(),
      signals: new Map([
        ['su-recent', LIVE],
        ['su-ancient', LIVE],
      ]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out.map((e) => e.recipient)).toEqual(['su-ancient', 'su-recent']);
  });
});

/**
 * EI-10551 — the escalation must describe the mail the recipient has NOT read.
 *
 * Live incident (su-00a91, fleet leader, 2026-07-12): the ladder woke me with "19 DIRECTED
 * message(s) ... oldest ~88m ... you have not read". I had read 17 of them — they arrived
 * before my last coord:orient, and I had already ACTED on them. Only 2 were genuinely
 * unread, the oldest ~9m old. The wake itself was CORRECT (2 unread is a real signal); the
 * numbers attached to it were window-wide aggregates computed before the read-watermark was
 * known, and the body rendered them as unread anyway.
 *
 * Why that is worth a test rather than a shrug: an alarm that fires correctly but describes
 * the situation falsely teaches the fleet to disbelieve it — and this alarm is load-bearing
 * for the one case it exists to catch, a peer genuinely blocked on an answer. Crying wolf
 * against correct behavior gets it tuned out exactly when it is right.
 */
/** A directed message in the ladder window. `replyTo` set ⇒ it is a reply. */
function msg(agoMin: number, over: Partial<LadderMsg> = {}): LadderMsg {
  return { ts: NOW - agoMin * MIN, from: 'su-peer', summary: `msg ${agoMin}m`, replyTo: null, ...over };
}

describe('classifyLadderEscalations — reports UNREAD mail, not the whole window (EI-10551)', () => {
  it('counts only messages that landed after the last read, and ages from the oldest UNREAD', () => {
    // The incident, in miniature: 5 in the window, last read 10m ago ⇒ only the 2 newest
    // are unread. Pre-fix this reported cnt=5 / oldest=88m — both true of the window, both
    // false of the recipient.
    const out = classifyLadderEscalations({
      rows: [
        row('su-leader', {
          cnt: 5,
          oldest_ts_ms: NOW - 88 * MIN,
          newest_ts_ms: NOW - 1 * MIN,
          recent_msgs: [msg(1), msg(9), msg(30), msg(60), msg(88)],
        }),
      ],
      lastReadByOwner: new Map([['su-leader', new Date(NOW - 10 * MIN).toISOString()]]),
      signals: new Map([['su-leader', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });

    expect(out).toHaveLength(1);
    expect(out[0].candidateCount).toBe(2); // NOT 5 — the other three predate the read
    expect(out[0].oldestAgeMs).toBe(9 * MIN); // NOT 88m — that message was read long ago
    expect(out[0].unread).toHaveLength(2); // and it CARRIES them, so triage needs no inbox call
    expect(out[0].neverRead).toBe(false);
  });

  it('a never-read recipient reports the FULL window and is flagged neverRead (a real hook fault)', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-never', {
          cnt: 3,
          oldest_ts_ms: NOW - 40 * MIN,
          newest_ts_ms: NOW - 6 * MIN,
          recent_msgs: [msg(6), msg(20), msg(40)],
        }),
      ],
      lastReadByOwner: new Map(), // no coord:inbox/orient on record — genuinely deaf
      signals: new Map([['su-never', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out[0].candidateCount).toBe(3);
    expect(out[0].oldestAgeMs).toBe(40 * MIN);
    expect(out[0].neverRead).toBe(true);
  });

  it('degrades to the window aggregates when per-message rows are absent (never worse than before)', () => {
    // A row without recent_msgs (older shape / stubbed IO) must behave EXACTLY as it did
    // pre-fix. A correctness fix that throws or drops an escalation on an unexpected row
    // shape would trade a false alarm for a MISSED one — strictly the worse failure.
    const out = classifyLadderEscalations({
      rows: [row('su-legacy', { cnt: 4, oldest_ts_ms: NOW - 25 * MIN })],
      lastReadByOwner: new Map([['su-legacy', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-legacy', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].candidateCount).toBe(4);
    expect(out[0].oldestAgeMs).toBe(25 * MIN);
    expect(out[0].unread).toEqual([]);
  });

  it('still does not escalate when EVERY message predates the last read (the gate is unchanged)', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-caughtup', {
          cnt: 3,
          newest_ts_ms: NOW - 20 * MIN,
          recent_msgs: [msg(20), msg(40), msg(60)],
        }),
      ],
      lastReadByOwner: new Map([['su-caughtup', new Date(NOW - 5 * MIN).toISOString()]]),
      signals: new Map([['su-caughtup', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(0);
  });
});

/**
 * The BODY is the product. Everything above computes a correct verdict; this is the only
 * part an agent ever reads, so its wording is under test too — a truthful alarm that still
 * forces a manual investigation has not actually been fixed.
 */
describe('renderLadderBody — the escalation an agent actually reads (EI-10551)', () => {
  const opts = { ttlMin: 5, stormMin: 10 };

  it('NAMES the unread mail (sender + summary) so triage needs no coord:inbox round-trip', () => {
    const body = renderLadderBody(
      {
        candidateCount: 2,
        oldestAgeMs: 9 * MIN,
        neverRead: false,
        unread: [
          msg(1, { from: 'su-peer-a', summary: 'can you unblock the deploy?' }),
          msg(9, { from: 'su-peer-b', summary: 'WI-1 done' }),
        ],
      },
      opts,
    );
    expect(body).toContain('su-peer-a');
    expect(body).toContain('can you unblock the deploy?');
    expect(body).toContain('su-peer-b');
    // The old body's whole payload was a count + "read your inbox now" — the instruction to
    // go fetch is precisely the round-trip we removed.
    expect(body).not.toContain('read your inbox now');
  });

  it('marks a REPLY distinctly from a fresh message (an answer arriving ≠ an ask waiting)', () => {
    const body = renderLadderBody(
      {
        candidateCount: 2,
        oldestAgeMs: 5 * MIN,
        neverRead: false,
        unread: [
          msg(2, { from: 'su-ack', summary: 'ack, standing down', replyTo: 'mri-abc' }),
          msg(5, { from: 'su-asker', summary: 'which account should I use?' }),
        ],
      },
      opts,
    );
    expect(body).toContain('↩ su-ack');
    expect(body).toContain('• su-asker');
    expect(body).toContain('related_msg_id'); // the legend explains WHY ↩ matters
  });

  it('does NOT cry "broken hooks" at a recipient whose read is merely STALE', () => {
    // The red herring that cost me a real detour: the old body asserted a hook fault
    // unconditionally, so an agent whose delivery is perfectly healthy went and debugged it.
    const body = renderLadderBody(
      { candidateCount: 1, oldestAgeMs: 6 * MIN, neverRead: false, unread: [msg(6)] },
      opts,
    );
    expect(body).not.toMatch(/hook/i);
  });

  it('DOES call out a hook fault when there is no inbox read on record at all', () => {
    const body = renderLadderBody(
      { candidateCount: 1, oldestAgeMs: 6 * MIN, neverRead: true, unread: [msg(6)] },
      opts,
    );
    expect(body).toMatch(/hook/i);
    expect(body).toContain('coord-mid-turn-delivery');
  });

  it('requires a recorded inbox read to discharge an FYI reminder without demanding a reply', () => {
    // The alarm fires on "unread", not on "someone is blocked" — a stand-down ack and an
    // urgent question look identical to the sweep. Saying so stops the next agent treating a
    // correct-but-uninteresting fire as evidence they did something wrong.
    const body = renderLadderBody(
      { candidateCount: 1, oldestAgeMs: 6 * MIN, neverRead: false, unread: [msg(6)] },
      opts,
    );
    expect(body).toContain('does NOT mean a peer is necessarily blocked on you');
    expect(body).toContain('DISCHARGED');
    expect(body).toContain('once the read is recorded');
    expect(body).toContain('expects:none');
    expect(body).toContain('no reply is required');
    expect(body).toContain('A read does not answer a request for an ack, answer, or action');
    expect(body).not.toContain('nothing is required of you');
  });

  it('puts the clearing action before the mail preview and explains why FYIs can recur', () => {
    const body = renderLadderBody(
      { candidateCount: 1, oldestAgeMs: 6 * MIN, neverRead: false,
        unread: [msg(6, { summary: 'FYI: both related items are closed' })] },
      opts,
    );
    expect(body.indexOf('call coord:inbox')).toBeLessThan(body.indexOf('FYI: both related items'));
    expect(body).toContain('reminder can recur until an inbox read is recorded');
    expect(body).toContain('closing a related work-item, or saving a memory note does not record that read');
    expect(body).toContain('no personal memory note is needed');
  });

  it('tells the reader that coord:orient counts as a read (it does — and I assumed it did not)', () => {
    const body = renderLadderBody(
      { candidateCount: 1, oldestAgeMs: 6 * MIN, neverRead: false, unread: [msg(6)] },
      opts,
    );
    expect(body).toContain('coord:orient');
    expect(body).toMatch(/both count/i);
  });
});

describe('ladder tunables (env-clamped, ratified defaults)', () => {
  it('defaults: TTL 5m, storm cap 10m', () => {
    expect(ladderTtlMs({})).toBe(LADDER_TTL_MS_DEFAULT);
    expect(LADDER_TTL_MS_DEFAULT).toBe(5 * MIN);
    expect(ladderStormMs({})).toBe(LADDER_STORM_MS_DEFAULT);
    expect(LADDER_STORM_MS_DEFAULT).toBe(10 * MIN);
  });

  it('env overrides apply; sub-minute values clamp to 1m (wake-storm guard)', () => {
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '180000' })).toBe(180_000);
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '5000' })).toBe(MIN);
    expect(ladderStormMs({ PAPERCUSP_COORD_LADDER_STORM_MS: '1' })).toBe(MIN);
  });

  it('garbage / non-positive env falls back to the default', () => {
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: 'soon' })).toBe(LADDER_TTL_MS_DEFAULT);
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '-5' })).toBe(LADDER_TTL_MS_DEFAULT);
    expect(ladderStormMs({ PAPERCUSP_COORD_LADDER_STORM_MS: '' })).toBe(LADDER_STORM_MS_DEFAULT);
  });
});

describe('runDeliveryLadderSweepOnce (DI end-to-end, no PG)', () => {
  const wakeOk = {
    targets: ['x'], keys: ['k'], woken: 1, staged: 0, stagedTargets: [], fanoutCapped: [],
  };

  function makeIo(over: Record<string, unknown> = {}) {
    const send = vi.fn(async () => ({}) as never);
    const wake = vi.fn(async () => wakeOk);
    return {
      send: send as unknown as typeof sendMessage,
      wake: wake as unknown as typeof wakeRecipients,
      sendMock: send,
      wakeMock: wake,
      fetchCandidates: vi.fn(async () => [row('su-deaf')]),
      fetchReads: vi.fn(async () => new Map<string, string>()),
      fetchSignals: vi.fn(async () => new Map([['su-deaf', LIVE]])),
      fetchCapped: vi.fn(async () => new Set<string>()),
      hasPgFastPath: vi.fn(() => false),
      fetchUnanswered: vi.fn(async () => new Map<string, UnansweredDirectedSummary>()),
      ...over,
    };
  }

  it('escalates: marker message to the recipient, then the standing inbox-wake fire', async () => {
    const io = makeIo();
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 1, escalations: 1, woken: 1, truncated: false });
    expect(io.sendMock).toHaveBeenCalledTimes(1);
    const [identity, sendArgs] = io.sendMock.mock.calls[0] as unknown as [
      { ownerId: string }, { to: string[]; summary: string; body: string },
    ];
    expect(identity.ownerId).toBe(DELIVERY_LADDER_OWNER);
    expect(sendArgs.to).toEqual(['su-deaf']);
    expect(sendArgs.summary).toContain('delivery-ladder');
    expect(sendArgs.summary).toContain('read via coord:inbox or coord:orient; FYIs need no reply');
    expect(sendArgs.body).toContain('coord:inbox');
    expect(io.wakeMock).toHaveBeenCalledWith(['su-deaf'], expect.objectContaining({
      summary: expect.stringContaining('read via coord:inbox or coord:orient; FYIs need no reply'),
      source: DELIVERY_LADDER_OWNER,
      workspaceId: 'ws-1',
    }));
  });

  it('suppresses only workspaces with an authoritative zero unanswered count', async () => {
    const actionable: UnansweredDirectedSummary = {
      count: 1,
      oldestAgeMs: 0,
      newest: [],
      staleCount: 0,
      staleOldestAgeMs: 0,
      senders: [],
    };
    const fetchUnanswered = vi.fn(async (_owners: string[], workspaceId: string) =>
      workspaceId === 'ws-answered'
        ? new Map<string, UnansweredDirectedSummary>()
        : new Map([['su-deaf', actionable]]),
    );
    const io = makeIo({
      fetchCandidates: vi.fn(async () => [
        row('su-deaf', { workspace_id: 'ws-answered' }),
        row('su-deaf', { workspace_id: 'ws-actionable' }),
      ]),
      hasPgFastPath: vi.fn(() => true),
      fetchUnanswered,
    });

    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });

    expect(fetchUnanswered).toHaveBeenNthCalledWith(1, ['su-deaf'], 'ws-answered');
    expect(fetchUnanswered).toHaveBeenNthCalledWith(2, ['su-deaf'], 'ws-actionable');
    expect(res).toEqual({ candidates: 2, escalations: 1, woken: 1, truncated: false });
    expect(io.wakeMock).toHaveBeenCalledWith(['su-deaf'], expect.objectContaining({
      workspaceId: 'ws-actionable',
    }));
  });

  it('fails open without the PG fast path and does not mistake unavailable for zero', async () => {
    const fetchUnanswered = vi.fn(async () => new Map<string, UnansweredDirectedSummary>());
    const io = makeIo({ hasPgFastPath: vi.fn(() => false), fetchUnanswered });

    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });

    expect(res.escalations).toBe(1);
    expect(fetchUnanswered).not.toHaveBeenCalled();
    expect(io.sendMock).toHaveBeenCalledTimes(1);
  });

  it('fails open when the unanswered lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchUnanswered = vi.fn(async () => {
      throw new Error('coordination DB unavailable');
    });
    const io = makeIo({ hasPgFastPath: vi.fn(() => true), fetchUnanswered });

    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });

    expect(res.escalations).toBe(1);
    expect(io.sendMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserving candidates'));
    warn.mockRestore();
  });

  it('zero candidates short-circuits — no read/signal/cap fetches, no sends', async () => {
    const io = makeIo({ fetchCandidates: vi.fn(async () => []) });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 0, escalations: 0, woken: 0, truncated: false });
    expect(io.fetchReads).not.toHaveBeenCalled();
    expect(io.fetchSignals).not.toHaveBeenCalled();
    expect(io.sendMock).not.toHaveBeenCalled();
  });

  it('batch limit truncates the pass (rest picked up next tick) and reports it', async () => {
    const io = makeIo({
      fetchCandidates: vi.fn(async () => [row('su-a'), row('su-b'), row('su-c')]),
      fetchSignals: vi.fn(async () => new Map([
        ['su-a', LIVE], ['su-b', LIVE], ['su-c', LIVE],
      ])),
    });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io, limit: 2 });
    expect(res.escalations).toBe(3);
    expect(res.woken).toBe(2);
    expect(res.truncated).toBe(true);
    expect(io.sendMock).toHaveBeenCalledTimes(2);
  });

  it('a wake failure is fail-soft: marker already sent, pass continues, woken uncounted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wake = vi.fn(async () => { throw new Error('pump down'); });
    const io = makeIo({ wake: wake as unknown as typeof wakeRecipients, wakeMock: wake });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res.woken).toBe(0);
    expect(res.escalations).toBe(1);
    expect(io.sendMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a marker-send failure skips the wake for that recipient (no cap record ⇒ next tick retries)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(async () => { throw new Error('log write failed'); });
    const io = makeIo({ send: send as unknown as typeof sendMessage, sendMock: send });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res.woken).toBe(0);
    expect(io.wakeMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a read/parked/capped recipient produces zero escalations end-to-end', async () => {
    const io = makeIo({
      fetchCandidates: vi.fn(async () => [row('su-read'), row('su-parked'), row('su-capped')]),
      fetchReads: vi.fn(async () => new Map([['su-read', new Date(NOW).toISOString()]])),
      fetchSignals: vi.fn(async () => new Map([
        ['su-read', LIVE], ['su-parked', PARKED], ['su-capped', LIVE],
      ])),
      fetchCapped: vi.fn(async () => new Set(['su-capped'])),
    });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 3, escalations: 0, woken: 0, truncated: false });
    expect(io.sendMock).not.toHaveBeenCalled();
  });
});
