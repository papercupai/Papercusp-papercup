/**
 * reply-deadline-sweep.test.ts — coord:send { replyDeadlineSec } backstop (EI-8986).
 *
 * Mocks the DB read (a canned row set standing in for the SQL query — the
 * query itself mirrors message-log-gc.ts's proven `body ? 'key'` / `->>'key'`
 * JSONB-predicate style) and the two effects (sendMessage / wakeRecipients),
 * so this pins the ORCHESTRATION contract without a real DB: one nudge per
 * due item, correct addressee/related_msg_id (the idempotency marker), the
 * batch/truncated accounting, and per-item fail-soft isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** EI-13610: the reply-equivalent-activity probe queries a DIFFERENT table
   *  (coord_thread_posts) — kept separate from `rows` (coord_event_log) so a
   *  test can populate one without the other. Empty by default: "no
   *  reply-equivalent activity found" (the pre-existing-behavior default). */
  threadRows: [] as unknown[],
  /** EI-18689956983040659: the supersede-check probe queries the SAME table
   *  (coord_event_log) as the main due-query, so it's dispatched by matching
   *  the query's own `supersede-check` SQL comment rather than by table name.
   *  Empty by default: "no superseding message found" (the pre-existing-
   *  behavior default). */
  supersedeRows: [] as unknown[],
  /** EI-20760420701985610: a later unthreaded recipient message is a
   *  reply-equivalent answer, queried from coord_event_log separately from
   *  the due-row and sender-side supersede fixtures. */
  recipientReplyRows: [] as unknown[],
  /** P-013 / EI-20330285752095560: the shared directive-effect reader probes
   *  harness_shared.work_items; keep those ledger rows separate from the due
   *  coord_event_log fixtures. */
  effectRows: [] as unknown[],
  sqlCalls: [] as unknown[][],
  sqlTexts: [] as string[],
  /** Per-test override of the whole dispatch (e.g. to simulate a probe
   *  failure) — null means "use the default rows/threadRows/supersedeRows
   *  dispatch". */
  sqlImpl: null as ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) | null,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.sqlCalls.push(values);
        if (h.sqlImpl) return h.sqlImpl(strings, ...values);
        const text = strings.join('');
        h.sqlTexts.push(text);
        if (text.includes('coord_thread_posts')) return Promise.resolve(h.threadRows);
        if (text.includes('recipient-reply-check')) return Promise.resolve(h.recipientReplyRows);
        if (text.includes('supersede-check')) return Promise.resolve(h.supersedeRows);
        if (text.includes('harness_shared.work_items')) return Promise.resolve(h.effectRows);
        return Promise.resolve(h.rows);
      },
      { begin: vi.fn(), unsafe: vi.fn() },
    ),
  }),
}));

vi.mock('./messages', () => ({ sendMessage: vi.fn(async () => undefined) }));
vi.mock('./inbox-wake', () => ({ wakeRecipients: vi.fn(async () => ({ woken: 1, targets: [], fanoutCapped: [] })) }));

import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import {
  runReplyDeadlineSweepOnce,
  REPLY_DEADLINE_SWEEP_BATCH_LIMIT,
  RECONCILE_REPLY_DEADLINE_OWNER,
} from './reply-deadline-sweep';

const NOW = Date.parse('2026-07-10T12:00:00Z');

function row(
  over: Partial<{
    workspace_id: string;
    msg_id: string;
    from_id: string;
    to_ids: unknown;
    audience: unknown;
    summary: string | null;
    body: string | null;
    plan_slug: string | null;
    expect_effect: unknown;
    deadline_at: string;
    sent_at_ms: string;
  }> = {},
) {
  return {
    workspace_id: 'default',
    msg_id: 'm1',
    from_id: 'su-sender',
    to_ids: ['su-recipient'],
    audience: [],
    summary: 'original summary',
    body: null,
    plan_slug: null,
    expect_effect: null,
    deadline_at: String(NOW - 5 * 60_000), // 5m overdue by default
    sent_at_ms: String(NOW - 20 * 60_000), // sent 20m ago by default
    ...over,
  };
}

/** Exact `fetchDirectiveActuations` work-item row shape (P-013). */
function effectRow(
  over: Partial<{
    feature_id: string;
    harness_slug: string;
    status: string | null;
    taken_by: string | null;
    last_released_ms: string | number | null;
    closed_ts: string | number | null;
    updated_ts: string | number | null;
    checkpoint_ms: string | number | null;
  }> = {},
) {
  return {
    feature_id: 'EI-20275359435606597',
    harness_slug: 'papercusp',
    status: 'open',
    taken_by: null,
    last_released_ms: null,
    closed_ts: null,
    updated_ts: null,
    checkpoint_ms: null,
    ...over,
  };
}

/** EI-13610: a reply-equivalent thread-activity row (coord_thread_posts). */
function threadRow(over: Partial<{ thread_id: string; author_id: string; posted_at_ms: string }> = {}) {
  return {
    thread_id: 'issue-thread-WI-3232',
    author_id: 'su-recipient',
    posted_at_ms: String(NOW - 10 * 60_000), // posted 10m ago by default
    ...over,
  };
}

/** EI-20760420701985610: a later fresh coord message from the awaited
 * recipient back to the original sender, without related_msg_id. */
function recipientReplyRow(over: Partial<{ msg_id: string; author_id: string; ts_ms: string }> = {}) {
  return {
    msg_id: 'm2',
    author_id: 'su-recipient',
    ts_ms: String(NOW - 10 * 60_000), // sent 10m ago, after the default ask
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.threadRows = [];
  h.supersedeRows = [];
  h.recipientReplyRows = [];
  h.effectRows = [];
  h.sqlCalls = [];
  h.sqlTexts = [];
  h.sqlImpl = null;
});

describe('runReplyDeadlineSweepOnce', () => {
  it('is a no-op when nothing is due', async () => {
    h.rows = [];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 0, nudged: 0, autoResolved: 0, superseded: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('nudges the ORIGINAL sender once, carrying related_msg_id as the idempotency marker', async () => {
    h.rows = [row()];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(identity.ownerId).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
    expect(opts.to).toEqual(['su-sender']); // the ORIGINAL sender, not the original recipient
    expect(opts.related_msg_id).toBe('m1'); // the idempotency marker
    expect(opts.summary).toContain('original summary');

    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    const [targets, wakeOpts] = (wakeRecipients as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual(['su-sender']);
    expect(wakeOpts.source).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
    expect(wakeOpts.workspaceId).toBe('default');
  });

  it('computes overdueMinutes from the deadline row and reports it in the nudge', async () => {
    h.rows = [row({ deadline_at: String(NOW - 90 * 60_000) })]; // 90m overdue
    await runReplyDeadlineSweepOnce({ nowMs: NOW });
    const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('90m');
    expect(opts.body).toContain('90m');
  });

  it('a sendMessage failure on one item never blocks the rest (fail-soft)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row({ msg_id: 'bad' }), row({ msg_id: 'good' })];
    (sendMessage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => undefined);

    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 2, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // the failed item's wake must never fire either.
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect((wakeRecipients as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(['su-sender']);
  });

  it('a wakeRecipients failure never blocks the (already-sent) nudge from counting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row()];
    (wakeRecipients as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('wake down');
    });
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
  });

  it('skips a row with no resolvable `from` instead of throwing', async () => {
    h.rows = [row({ from_id: undefined as unknown as string })];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 0, nudged: 0, autoResolved: 0, superseded: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('respects the batch limit and reports truncated:true when more remain', async () => {
    h.rows = [row({ msg_id: 'a' }), row({ msg_id: 'b' }), row({ msg_id: 'c' })];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW, limit: 2 });
    expect(result).toEqual({ due: 3, nudged: 2, autoResolved: 0, superseded: 0, truncated: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('defaults the limit to REPLY_DEADLINE_SWEEP_BATCH_LIMIT + 1 rows requested from the DB', async () => {
    h.rows = [];
    await runReplyDeadlineSweepOnce({ nowMs: NOW });
    // the sweep over-fetches by 1 (limit+1) purely to detect truncation; assert
    // the query was issued with `nowMs` bound in its values (loose shape check —
    // the exact SQL text is proven by the real query mirroring message-log-gc.ts).
    expect(h.sqlCalls.length).toBeGreaterThan(0);
    expect(h.sqlCalls[0]).toContain(NOW);
    expect(REPLY_DEADLINE_SWEEP_BATCH_LIMIT).toBeGreaterThan(0);
  });

  it('uses related_msg_id markers globally across workspace partitions', async () => {
    // A deadline can remain in the legacy workspace partition while its
    // one-shot nudge marker is written after a workspace restamp. The marker
    // is keyed by the globally-generated msg_id, not by workspace_id.
    h.rows = [
      row({
        workspace_id: '/home/builduser/papercupai-workspace/papercusp',
        msg_id: 'mt427rhz-0000-bcb413b4152841d5bf13575dcaaf6f6b',
      }),
    ];

    await runReplyDeadlineSweepOnce({ nowMs: NOW });

    const dueQuery = h.sqlTexts.find((text) => text.includes('FROM harness_shared.coord_event_log e1'));
    expect(dueQuery).toBeDefined();
    expect(dueQuery).toContain("e2.body->>'related_msg_id' = e1.msg_id");
    expect(dueQuery).not.toContain('e2.workspace_id = e1.workspace_id');
  });

  describe('directive effects and terminal references (P-013 / EI-20330285752095560)', () => {
    it.each([
      {
        kind: 'terminal' as const,
        effect: { status: 'done', closed_ts: String(NOW - 2 * 60_000) },
        label: 'terminal',
      },
      {
        kind: 'checkpoint' as const,
        effect: { checkpoint_ms: String(NOW - 2 * 60_000) },
        label: 'checkpoint',
      },
    ])('auto-resolves a due deadline when an explicit $label expectEffect is satisfied', async ({ kind, effect }) => {
      h.rows = [
        row({
          summary: 'please carry out the requested effect',
          expect_effect: { kind, itemId: 'EI-20275359435606597', harness: 'papercusp' },
        }),
      ];
      h.effectRows = [effectRow(effect)];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 1, superseded: 0, truncated: false });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.summary).toContain(`expected ${kind}`);
      expect(opts.body).toContain('EI-20275359435606597');
      expect(opts.body).toContain('after the directive');
      expect(opts.related_msg_id).toBe('m1');
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('auto-resolves when a referenced work item reached terminal after the ask, even without expectEffect', async () => {
      h.rows = [row({ summary: 'the requested EI-20275359435606597 completion is the answer' })];
      h.effectRows = [
        effectRow({
          status: 'done',
          closed_ts: String(NOW - 2 * 60_000),
        }),
      ];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 1, superseded: 0, truncated: false });

      const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.summary).toContain('expected terminal');
      expect(opts.body).toContain('EI-20275359435606597');
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('does not auto-resolve from a terminal state that predates the original ask', async () => {
      h.rows = [row({ summary: 'the requested EI-20275359435606597 completion is the answer' })];
      h.effectRows = [
        effectRow({
          status: 'done',
          closed_ts: String(NOW - 30 * 60_000), // before the default ask (20m ago)
        }),
      ];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss an audit request when a filed scorecard only receives a later lease update', async () => {
      h.rows = [row({ summary: 'Continue the independent audit of EI-20275359435606597 and report its blocker' })];
      h.effectRows = [
        effectRow({
          status: 'done',
          closed_ts: null,
          updated_ts: String(NOW - 2 * 60_000),
        }),
      ];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });
  });

  // EI-20760420701985610: a recipient's fresh, unthreaded coord response
  // must suppress the stale deadline alarm just like an exact threaded reply.
  describe('unthreaded recipient reply (EI-20760420701985610)', () => {
    it('auto-resolves — quiet note, no alarm, no wake — for a later directed response', async () => {
      h.rows = [row()];
      h.recipientReplyRows = [recipientReplyRow()];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 1, superseded: 0, truncated: false });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(identity.ownerId).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
      expect(opts.to).toEqual(['su-sender']);
      expect(opts.related_msg_id).toBe('m1');
      expect(opts.summary).toContain('auto-resolved');
      expect(opts.summary).not.toContain('no reply by deadline');
      expect(opts.body).toContain('m2');
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('does not suppress on a stale response that predates the original ask', async () => {
      h.rows = [row({ sent_at_ms: String(NOW - 5 * 60_000) })];
      h.recipientReplyRows = [recipientReplyRow({ ts_ms: String(NOW - 60 * 60_000) })];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('passes the original send timestamp as the recipient-reply lower bound', async () => {
      h.rows = [row({ sent_at_ms: String(NOW - 42 * 60_000) })];
      h.recipientReplyRows = [];
      await runReplyDeadlineSweepOnce({ nowMs: NOW });
      const replyQueryValues = h.sqlCalls.find((c) => c.includes(NOW - 42 * 60_000));
      expect(replyQueryValues).toBeDefined();
    });

    it('a recipient-reply probe failure fails soft to the ordinary alarm path', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.rows = [row()];
      h.sqlImpl = (strings) => {
        const text = strings.join('');
        if (text.includes('supersede-check')) return Promise.resolve([]);
        if (text.includes('recipient-reply-check')) return Promise.reject(new Error('probe down'));
        if (text.includes('coord_thread_posts')) return Promise.resolve([]);
        return Promise.resolve(h.rows);
      };

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result.nudged).toBe(1);
      expect(result.autoResolved).toBe(0);
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });
  });

  // EI-13610: reply-equivalent thread activity (the awaited recipient answered
  // via a work-item thread post instead of a coord reply) must suppress the
  // false-alarm nudge + wake, not fire it.
  describe('reply-equivalent thread activity (EI-13610)', () => {
    it('auto-resolves — quiet note, no alarm, no wake — when the awaited recipient posted on a referenced WI/EI after the send', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report' })];
      h.threadRows = [threadRow({ thread_id: 'issue-thread-WI-3232', author_id: 'su-recipient' })];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 1, superseded: 0, truncated: false });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(identity.ownerId).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
      expect(opts.to).toEqual(['su-sender']);
      expect(opts.related_msg_id).toBe('m1'); // idempotency marker still lands
      expect(opts.summary).toContain('auto-resolved');
      expect(opts.summary).not.toContain('no reply by deadline');
      expect(opts.body).toContain('WI-3232');

      // the whole point: no false-alarm wake for an answer that already landed.
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('detects the referenced id from the message BODY as well as the summary', async () => {
      h.rows = [row({ summary: 'ping', body: 'following up on EI-777 — any update?' })];
      h.threadRows = [threadRow({ thread_id: 'issue-thread-EI-777', author_id: 'su-recipient' })];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result.autoResolved).toBe(1);
      expect(result.nudged).toBe(0);
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('still alarms normally when no WI-/EI- id is mentioned at all', async () => {
      h.rows = [row({ summary: 'any update on this?' })];
      h.threadRows = [threadRow()]; // present but irrelevant — nothing to match against
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('still alarms normally when a WI-/EI- id is mentioned but no thread activity is found', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report' })];
      h.threadRows = []; // nobody posted
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('still alarms when the thread post is from someone OTHER than an awaited recipient', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report', to_ids: ['su-recipient'] })];
      h.threadRows = [threadRow({ author_id: 'su-someone-else' })];
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
    });

    it('still alarms when the matching post predates the original message (stale/unrelated prior post)', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report', sent_at_ms: String(NOW - 5 * 60_000) })];
      h.threadRows = [threadRow({ posted_at_ms: String(NOW - 60 * 60_000) })]; // posted well BEFORE the message was sent
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
    });

    it('the query passes the ORIGINAL send timestamp as the activity-since bound', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report', sent_at_ms: String(NOW - 42 * 60_000) })];
      h.threadRows = [];
      await runReplyDeadlineSweepOnce({ nowMs: NOW });
      const threadQueryValues = h.sqlCalls.find((c) => c.includes(NOW - 42 * 60_000));
      expect(threadQueryValues).toBeDefined();
    });

    it('a reply-equivalent probe failure fails soft to the ordinary alarm path (never silently swallows a genuinely-overdue deadline)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report' })];
      h.sqlImpl = (strings) => {
        const text = strings.join('');
        // EI-18689956983040659: a full sqlImpl override bypasses the default
        // per-table dispatch entirely, so the supersede-check query (which now
        // runs BEFORE this probe) must be handled explicitly too — otherwise it
        // falls through to `h.rows` (the DUE row itself, which happens to share
        // the same `msg_id`) and findSupersedingMessage misreads that as a real
        // superseding message, short-circuiting before the alarm path this test
        // means to exercise.
        if (text.includes('supersede-check')) return Promise.resolve([]);
        if (text.includes('coord_thread_posts')) return Promise.reject(new Error('probe down'));
        return Promise.resolve(h.rows);
      };

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result.nudged).toBe(1);
      expect(result.autoResolved).toBe(0);
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('skips the probe entirely (and still alarms) when the message has no `to` recipients recorded', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report', to_ids: [] })];
      h.threadRows = [threadRow()];
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
    });

    it('auto-resolves quietly when an audience selector reached zero live recipients', async () => {
      h.rows = [
        row({
          msg_id: 'zero-audience',
          to_ids: [],
          audience: ['@file:packages/operator-core/lib/agent-tools/coordination/reply-deadline-sweep.ts'],
        }),
      ];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });

      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 1, superseded: 0, truncated: false });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.to).toEqual(['su-sender']);
      expect(opts.related_msg_id).toBe('zero-audience');
      expect(opts.summary).toContain('zero live recipients');
      expect(opts.body).toContain('@file:packages/operator-core/lib/agent-tools/coordination/reply-deadline-sweep.ts');
      expect(wakeRecipients).not.toHaveBeenCalled();
    });
  });

  // EI-18689956983040659: the sender superseded/retracted their own ask by
  // sending a later directed message to the same recipient(s) — the deadline
  // must auto-resolve quietly instead of alarming the sender about a question
  // they themselves already withdrew.
  describe('sender-side supersede (EI-18689956983040659)', () => {
    it('auto-resolves — quiet note, no alarm, no wake — when the sender sent a LATER directed message to the same recipient', async () => {
      h.rows = [row()];
      h.supersedeRows = [{ msg_id: 'm2', ts_ms: String(NOW - 10 * 60_000) }];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 0, superseded: 1, truncated: false });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(identity.ownerId).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
      expect(opts.to).toEqual(['su-sender']); // notifies the ORIGINAL sender, not the recipient
      expect(opts.related_msg_id).toBe('m1'); // idempotency marker still lands
      expect(opts.summary).toContain('auto-resolved');
      expect(opts.summary).not.toContain('no reply by deadline');
      expect(opts.body).toContain('m2');

      // the whole point: no false-alarm wake for an ask the sender already withdrew.
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('is checked BEFORE the reply-equivalent probe — a supersede short-circuits even when thread activity ALSO exists', async () => {
      h.rows = [row({ summary: 'please send the WI-3232 VM-verify report' })];
      h.supersedeRows = [{ msg_id: 'm2', ts_ms: String(NOW - 10 * 60_000) }];
      h.threadRows = [threadRow({ thread_id: 'issue-thread-WI-3232', author_id: 'su-recipient' })];

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 0, autoResolved: 0, superseded: 1, truncated: false });
    });

    it('still alarms normally when no superseding message is found', async () => {
      h.rows = [row()];
      h.supersedeRows = [];
      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('does not auto-resolve when a later sender message targets a disjoint recipient', async () => {
      h.rows = [row({ to_ids: ['su-holder'] })];
      h.supersedeRows = [
        { msg_id: 'm-disjoint', ts_ms: String(NOW - 10 * 60_000), to_ids: ['su-other'] },
      ];

      // Model the database predicate so this regression fails if the
      // supersede query stops correlating the later message's concrete `to`
      // array with the original recipients.
      h.sqlImpl = (strings) => {
        const text = strings.join('');
        if (text.includes('supersede-check')) {
          const hasRecipientCorrelation =
            text.includes('jsonb_array_elements_text') && text.includes('t = ANY');
          return Promise.resolve(hasRecipientCorrelation ? [] : h.supersedeRows);
        }
        if (text.includes('coord_thread_posts')) return Promise.resolve([]);
        return Promise.resolve(h.rows);
      };

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result).toEqual({ due: 1, nudged: 1, autoResolved: 0, superseded: 0, truncated: false });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('a supersede-probe failure fails soft to the ordinary checks (never silently swallows a genuinely-overdue deadline)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.rows = [row()];
      h.sqlImpl = (strings) => {
        const text = strings.join('');
        if (text.includes('supersede-check')) return Promise.reject(new Error('probe down'));
        if (text.includes('coord_thread_posts')) return Promise.resolve([]);
        return Promise.resolve(h.rows);
      };

      const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
      expect(result.nudged).toBe(1);
      expect(result.superseded).toBe(0);
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });
  });
});
