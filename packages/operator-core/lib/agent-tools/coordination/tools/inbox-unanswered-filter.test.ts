/**
 * inbox-unanswered-filter.test.ts — filterInboxByUnanswered, the coord:inbox
 * `unanswered_only` filter (EI-13159: coord:inbox had no way to directly
 * fetch/filter to the directed messages fleet:assignments'
 * `unanswered_directed` counter flags — an operator had to fetch + classify a
 * broad inbox to find the flagged message). Pins the pure filtering
 * behaviour; the IO wiring (fetchUnansweredDirected) is exercised by the
 * existing unanswered-directed.test.ts + fleet/assignments' own tests, which
 * this filter deliberately reuses rather than re-deriving.
 */
import { describe, it, expect } from 'vitest';
import { filterInboxByUnanswered, replyOwedMessageIds } from './inbox';
import inboxTool from './inbox';
import { prioritizedInboxWindow } from '../inbox-visibility';
import { sectionsToText } from '../message-fields';
import { chunkOverCapMessage } from './send-chunking';

type E = { msg_id: string; from?: unknown };
const rows: E[] = [
  { msg_id: 'a', from: 'leader' },
  { msg_id: 'b', from: 'system:doc-freshness' },
  { msg_id: 'c', from: 'leader' },
  { msg_id: 'd', from: 'peer' },
  { msg_id: 'e' }, // no from at all
];

describe('filterInboxByUnanswered (EI-13159)', () => {
  it('keeps the complete message when only the final chunk part expects an answer', () => {
    const plan = chunkOverCapMessage({
      to: ['recipient'],
      summary: 'long request',
      body: [{ text: 'body content '.repeat(80) }],
      expects: 'answer',
    });
    if (plan.kind !== 'chunked') throw new Error('fixture must exceed the inbox body cap');
    const parts = plan.parts.map(({ message, meta }, index) => ({
      msg_id: `chunk-${meta.part}`,
      from: 'sender',
      to: ['recipient'],
      kind: 'message',
      summary: message.summary,
      body: sectionsToText(message.body as Array<{ text: string }>),
      ts: `2026-10-09T05:0${index}:00.000Z`,
      expects: message.expects,
    }));
    const finalPart = parts.at(-1)!;
    const unanswered = replyOwedMessageIds([
      { msgId: finalPart.msg_id, senderState: 'live' },
    ]);

    expect(finalPart.expects).toBe('answer');
    expect(parts[0]?.expects).toBe('none');
    const filtered = filterInboxByUnanswered(parts, unanswered);
    expect(filtered).toEqual(parts);
    expect(prioritizedInboxWindow(filtered as ReadonlyArray<Record<string, unknown>>, 20)).toEqual(parts);
  });

  it('does not mark messages from positively ended senders as reply-owed', () => {
    const unanswered = replyOwedMessageIds([
      { msgId: 'live-msg', senderState: 'live' },
      { msgId: 'ended-msg', senderState: 'ended' },
      { msgId: 'unknown-msg', senderState: 'unknown' },
      { msgId: 'unmeasured-msg' },
    ]);
    const inboxRows = [
      { msg_id: 'live-msg' },
      { msg_id: 'ended-msg' },
      { msg_id: 'unknown-msg' },
      { msg_id: 'unmeasured-msg' },
    ];

    expect([...unanswered]).toEqual(['live-msg', 'unknown-msg', 'unmeasured-msg']);
    expect(filterInboxByUnanswered(inboxRows, unanswered).map((row) => row.msg_id)).toEqual([
      'live-msg',
      'unknown-msg',
      'unmeasured-msg',
    ]);
  });

  it('keeps only entries whose msg_id is in the unanswered set', () => {
    const unanswered = new Set(['a', 'd']);
    expect(filterInboxByUnanswered(rows, unanswered).map((r) => r.msg_id)).toEqual(['a', 'd']);
  });

  it('an empty unanswered set (the fail-safe lookup-failure case) filters to nothing', () => {
    expect(filterInboxByUnanswered(rows, new Set())).toEqual([]);
  });

  it('undefined/null unansweredMsgIds is a NO-OP — returns the input unchanged (same reference)', () => {
    expect(filterInboxByUnanswered(rows, undefined)).toBe(rows);
    expect(filterInboxByUnanswered(rows, null)).toBe(rows);
  });

  it('preserves ascending order (no re-sort)', () => {
    const unanswered = new Set(['c', 'a']);
    expect(filterInboxByUnanswered(rows, unanswered).map((r) => r.msg_id)).toEqual(['a', 'c']);
  });

  it('a msg_id in the set that no longer exists in the inbox window is simply absent from the result', () => {
    const unanswered = new Set(['ghost-id']);
    expect(filterInboxByUnanswered(rows, unanswered)).toEqual([]);
  });
});

describe('coord:inbox unanswered filter aliases (EI-21374977511049906)', () => {
  it('accepts both canonical snake_case and the camelCase compatibility alias', () => {
    const args = inboxTool.args as { safeParse: (value: unknown) => { success: boolean } };
    expect(args.safeParse({ unanswered_only: true }).success).toBe(true);
    expect(args.safeParse({ unansweredOnly: true }).success).toBe(true);
  });
});
