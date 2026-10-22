import { describe, expect, it } from 'vitest';
import {
  mapSessionTimeline,
  sessionTimelineToChatMessages as sessionTimelineToChatMessagesWithTurnIdentity,
} from './session-transcript-mapping';
import type { TimelineEntry } from '../../harness/AgentThinkingStream';

function sessionTimelineToChatMessages(
  ...args: Parameters<typeof sessionTimelineToChatMessagesWithTurnIdentity>
) {
  return sessionTimelineToChatMessagesWithTurnIdentity(...args).map(
    ({ sessionTurn: _sessionTurn, ...message }) => message,
  );
}

describe('sessionTimelineToChatMessages', () => {
  it('returns nothing for an empty timeline', () => {
    expect(sessionTimelineToChatMessages([])).toEqual([]);
  });

  it('maps a prompt into a user message', () => {
    const entries: TimelineEntry[] = [{ kind: 'prompt', text: 'do the thing', ts: 't1' }];
    expect(sessionTimelineToChatMessages(entries)).toEqual([
      { role: 'user', content: 'do the thing', id: 'prompt-0', ts: 't1' },
    ]);
  });

  it('stamps one shared owner-safe identity on the visible prompt and reply', () => {
    const out = sessionTimelineToChatMessagesWithTurnIdentity([
      { kind: 'prompt', text: 'do the thing', ts: 't1' },
      { kind: 'text', text: 'Done.', ts: 't2' },
    ]);
    expect(out[0].sessionTurn).toEqual({
      id: 'session-turn-0',
      kind: 'owner',
      preview: 'do the thing',
      startedAt: 't1',
    });
    expect(out[1].sessionTurn).toBe(out[0].sessionTurn);
  });

  /**
   * EI-20130618357432548 — this pane renders the transcript back TO the owner, so
   * papercusp's own injection plumbing was being read as part of their
   * conversation: the owner's "hi" appeared as a wall of wake-pump envelope.
   */
  describe('machine annotations the owner never typed', () => {
    it('HIDES a machine-injected prompt entirely — it is not the owner speaking', () => {
      // REVERSAL, same day, on the owner's evidence (EI-20135573616431912). The
      // first cut of this feature stripped the ENVELOPE and kept the BODY, on the
      // reasoning that hiding delivered content is worse than showing plumbing.
      // That was wrong for THIS surface: the body is machine text addressed to the
      // AGENT, and the pane renders user-role turns as the OWNER's own messages —
      // so wake blobs and Stop-hook walls appeared in the owner's chat as things
      // they had apparently said, reported as "I said hi and it replied with all this".
      // Measured: machine turns are the MAJORITY of this pane's user-role rows
      // (1756 envelopes + 44 hook walls vs 1540 genuine, 3-day window).
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\ndo the thing', ts: 't1' },
      ];
      expect(sessionTimelineToChatMessages(entries)).toEqual([]);
    });

    /**
     * NOT a hand-written approximation — these are the exact bytes a live parked
     * session received on 2026-08-11 through the real
     * send → wake → pty path (:3170), captured from the delivered turn. Pinning
     * the real wire format keeps this honest if the envelope or the note ever
     * changes shape: the earlier cut of this feature passed hand-written fixtures
     * while the live path was still broken.
     */
    it('renders the REAL delivered owner-chat turn as exactly what the owner typed', () => {
      const delivered =
        '⟦turn-origin:coord-inject:owner nonce:fa2f7c5a6200e4ad⟧\n' +
        'take 2: does this arrive as my own turn?\n\n' +
        '⟦owner-chat⟧ Your owner typed the message above in their session chat pane, and that pane ' +
        'renders YOUR TRANSCRIPT — so answer in THIS TURN, in your ordinary response, and they will ' +
        'see it. Do NOT coord:send a reply: the sender id is a UI pseudo-agent with no live session, ' +
        'so a reply addressed to it fails with recipients_gone, and mirroring it to `human` puts your ' +
        'answer in the Inbox rather than the chat they are looking at. Zero coord sends are needed to ' +
        'answer this.';
      const entries: TimelineEntry[] = [{ kind: 'prompt', text: delivered, ts: 't1' }];
      expect(sessionTimelineToChatMessages(entries)).toEqual([
        { role: 'user', content: 'take 2: does this arrive as my own turn?', id: 'prompt-0', ts: 't1' },
      ]);
    });

    it('renders an owner chat-pane message as exactly what was typed', () => {
      // The delivered shape: provenance envelope + the owner's text + the machine
      // note addressed to the agent. Only the middle is the owner's.
      const entries: TimelineEntry[] = [
        {
          kind: 'prompt',
          text:
            '⟦turn-origin:coord-inject:owner nonce:deadbeef⟧\nhi\n\n⟦owner-chat⟧ Your owner typed the ' +
            'message above in their session chat pane, and that pane renders YOUR TRANSCRIPT…',
          ts: 't1',
        },
      ];
      expect(sessionTimelineToChatMessages(entries)).toEqual([
        { role: 'user', content: 'hi', id: 'prompt-0', ts: 't1' },
      ]);
    });

    it('HIDES the wake body too — it was delivered to the AGENT, and this pane is the OWNER conversation', () => {
      // Supersedes this file's earlier "keeps the wake BODY … so nothing delivered
      // vanishes" assertion. The premise was that hiding delivered content is the
      // worse failure. It still is — for the AGENT. But nothing is deleted here:
      // this is a RENDER filter, the turn remains in the transcript stores and in
      // every audit / session-search path. What changed is only WHOSE conversation
      // this pane claims to be showing.
      const entries: TimelineEntry[] = [
        {
          kind: 'prompt',
          text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\n[await-event] lock:grant:t-1 fired.',
          ts: 't1',
        },
      ];
      expect(sessionTimelineToChatMessages(entries)).toEqual([]);
    });

    it('drops a prompt that is NOTHING but annotations rather than rendering an empty bubble', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\n', ts: 't1' },
      ];
      expect(sessionTimelineToChatMessages(entries)).toEqual([]);
    });

    it('keeps the machine body hidden while marking its visible reply as an automatic turn', () => {
      const out = sessionTimelineToChatMessagesWithTurnIdentity([
        {
          kind: 'prompt',
          text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\n[await-event] lock:grant:t-1 fired.',
          ts: 't1',
        },
        { kind: 'text', text: 'The lock opened, so I continued.', ts: 't2' },
      ]);
      expect(out).toEqual([
        {
          role: 'assistant',
          content: 'The lock opened, so I continued.',
          id: 'turn-0',
          ts: 't2',
          sessionTurn: {
            id: 'session-turn-0',
            kind: 'automatic',
            preview: 'Automatic continuation.',
            startedAt: 't1',
          },
        },
      ]);
      expect(JSON.stringify(out)).not.toContain('[await-event] lock:grant:t-1 fired.');
    });
  });

  it('drops a blank/whitespace-only prompt', () => {
    const entries: TimelineEntry[] = [{ kind: 'prompt', text: '   ', ts: 't1' }];
    expect(sessionTimelineToChatMessages(entries)).toEqual([]);
  });

  it('joins text entries into one assistant message per turn', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'hi', ts: 't1' },
      { kind: 'text', text: 'Hello', ts: 't2' },
      { kind: 'text', text: 'there.', ts: 't3' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'hi', id: 'prompt-0', ts: 't1' },
      // t3, not t2: the stamp follows the LAST text entry that contributed, so a
      // multi-chunk reply is dated when it finished arriving.
      { role: 'assistant', content: 'Hello\n\nthere.', id: 'turn-0', ts: 't3' },
    ]);
  });

  it('strips raw OpenAI citation tokens from owner-facing assistant text', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'explain Kubernetes', ts: 't1' },
      {
        kind: 'text',
        text:
          'Kubernetes runs containerized applications. \uE200cite\uE202turn613222view0\uE201\n\n' +
          'It reconciles the desired state. \uE200cite\uE202turn613222view1\uE201',
        ts: 't2',
      },
    ];

    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'explain Kubernetes', id: 'prompt-0', ts: 't1' },
      {
        role: 'assistant',
        content: 'Kubernetes runs containerized applications.\n\nIt reconciles the desired state.',
        id: 'turn-0',
        ts: 't2',
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/[\uE200-\uE202]/);
  });

  it('the TOOL-NOISE FILTER: an ~90%-tool-calls turn collapses tool_use into chips and drops tool_result/status entirely', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'fix the bug', ts: 't0' },
      { kind: 'status', text: '[thinking] let me look', ts: 't1' },
      { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolId: 'tu1', ts: 't2' },
      { kind: 'tool_result', toolId: 'tu1', text: 'A'.repeat(50_000), ts: 't3' },
      { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: '/a.ts', old: 'x', new: 'y' }, toolId: 'tu2', ts: 't4' },
      { kind: 'tool_result', toolId: 'tu2', text: 'ok', ts: 't5' },
      { kind: 'status', text: '[thinking] done', ts: 't6' },
      { kind: 'text', text: 'Fixed it.', ts: 't7' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'fix the bug', id: 'prompt-0', ts: 't0' },
      {
        role: 'assistant',
        content: 'Fixed it.',
        tools: [
          { name: 'Read', input: { file_path: '/a.ts' } },
          { name: 'Edit', input: { file_path: '/a.ts', old: 'x', new: 'y' } },
        ],
        id: 'turn-0',
        // t7 (the text), NOT t0 (the turn's start). This is the case the stamp
        // exists for: a turn spanning several tool calls is dated when its
        // ANSWER appeared, not when the agent started working on it.
        ts: 't7',
      },
    ]);
    // The 50KB tool_result never reaches the mapped output — the whole point
    // of the filter.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('A'.repeat(50_000));
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('a tool-only turn (no text) still surfaces as an assistant message carrying just the tool chips', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'run the tests', ts: 't0' },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, ts: 't1' },
      { kind: 'tool_result', text: 'PASS', ts: 't2' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'run the tests', id: 'prompt-0', ts: 't0' },
      {
        role: 'assistant',
        content: '',
        tools: [{ name: 'Bash', input: { command: 'npm test' } }],
        id: 'turn-0',
        // Nothing content-bearing to date, so the turn's own end wins: t2, the
        // dropped tool_result. The turn HAPPENED even though its text did not.
        ts: 't2',
      },
    ]);
  });

  it('a turn with only status/tool_result (no text, no tool_use) produces no assistant message', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'ping', ts: 't0' },
      { kind: 'status', text: '[thinking] …', ts: 't1' },
    ];
    expect(sessionTimelineToChatMessages(entries)).toEqual([
      { role: 'user', content: 'ping', id: 'prompt-0', ts: 't0' },
    ]);
  });

  it('falls back to the `result` entry text only when no `text` entries exist in the turn', () => {
    const withResultOnly: TimelineEntry[] = [
      { kind: 'prompt', text: 'summarize', ts: 't0' },
      { kind: 'tool_use', toolName: 'search', toolInput: {}, ts: 't1' },
      { kind: 'result', text: 'Final answer from result.', costUsd: 0.01, ts: 't2' },
    ];
    expect(sessionTimelineToChatMessages(withResultOnly)).toEqual([
      { role: 'user', content: 'summarize', id: 'prompt-0', ts: 't0' },
      {
        role: 'assistant',
        content: 'Final answer from result.',
        tools: [{ name: 'search', input: {} }],
        id: 'turn-0',
        // The content came from the `result` entry, so the stamp does too.
        ts: 't2',
      },
    ]);

    const withBothTextAndResult: TimelineEntry[] = [
      { kind: 'prompt', text: 'summarize', ts: 't0' },
      { kind: 'text', text: 'Streamed answer.', ts: 't1' },
      { kind: 'result', text: 'Streamed answer. (duplicate summary)', ts: 't2' },
    ];
    // `text` wins over `result` when both are present — no duplicated content.
    expect(sessionTimelineToChatMessages(withBothTextAndResult)).toEqual([
      { role: 'user', content: 'summarize', id: 'prompt-0', ts: 't0' },
      // ...and the STAMP follows the same branch: t1 (the text that is actually
      // rendered), never t2 (the result record whose text was discarded). A
      // shared "last content entry" cursor would get this one wrong.
      { role: 'assistant', content: 'Streamed answer.', id: 'turn-0', ts: 't1' },
    ]);
  });

  it('handles multiple turns in order, including a leading partial turn before the first prompt', () => {
    const entries: TimelineEntry[] = [
      { kind: 'text', text: 'leftover from before this window', ts: 't0' },
      { kind: 'prompt', text: 'first', ts: 't1' },
      { kind: 'text', text: 'first reply', ts: 't2' },
      { kind: 'prompt', text: 'second', ts: 't3' },
      { kind: 'tool_use', toolName: 'Grep', toolInput: { pattern: 'x' }, ts: 't4' },
      { kind: 'text', text: 'second reply', ts: 't5' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'assistant', content: 'leftover from before this window', id: 'turn-0', ts: 't0' },
      { role: 'user', content: 'first', id: 'prompt-1', ts: 't1' },
      { role: 'assistant', content: 'first reply', id: 'turn-1', ts: 't2' },
      { role: 'user', content: 'second', id: 'prompt-2', ts: 't3' },
      {
        role: 'assistant',
        content: 'second reply',
        tools: [{ name: 'Grep', input: { pattern: 'x' } }],
        id: 'turn-2',
        ts: 't5',
      },
    ]);
    // The stamps ASCEND across the whole transcript — the property a reader
    // actually relies on, and the one a per-turn bug would break invisibly.
    expect(out.map((m) => m.ts)).toEqual(['t0', 't1', 't2', 't3', 't5']);
  });

  /* session-chat-popup-timestamps-and-modes-2026-08-09 P-001 — the per-message
     `ts`. The cases above already pin the happy paths inline; these pin the
     edges, where the mapper has to CHOOSE a timestamp rather than copy one. */
  describe('ts (P-001)', () => {
    it('OMITS the field entirely when the source entry carried no timestamp — never undefined, never a sentinel', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi' },
        { kind: 'text', text: 'Hello' },
      ];
      const out = sessionTimelineToChatMessages(entries);
      // `toEqual` would pass against `{ ts: undefined }`, so assert on the KEY.
      // The renderer's no-stamp branch is reached by absence, and a message that
      // silently carried an undefined `ts` would look stamped to any `in` check.
      expect(out).toHaveLength(2);
      expect(out.every((m) => !('ts' in m))).toBe(true);
    });

    it('a turn whose entries are PARTIALLY stamped still dates the message from the stamped one', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'go', ts: 't0' },
        { kind: 'text', text: 'working' },
        { kind: 'text', text: 'done', ts: 't9' },
      ];
      expect(sessionTimelineToChatMessages(entries)[1].ts).toBe('t9');
    });

    it('an UNSTAMPED text entry after a stamped one does not blank the message stamp', () => {
      // The mapper only ever ADVANCES the cursor on a real ts, so a trailing
      // unstamped chunk cannot erase what an earlier one established. Assigning
      // `e.ts` unconditionally would regress exactly this to undefined.
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'go', ts: 't0' },
        { kind: 'text', text: 'first', ts: 't1' },
        { kind: 'text', text: 'trailing chunk with no ts' },
      ];
      expect(sessionTimelineToChatMessages(entries)[1].ts).toBe('t1');
    });

    it('a tool-only turn falls back to the turn END, and a turn with neither to its START', () => {
      const toolOnly: TimelineEntry[] = [
        { kind: 'prompt', text: 'run', ts: 't0' },
        { kind: 'tool_use', toolName: 'Bash', toolInput: {}, ts: 't1' },
        { kind: 'tool_result', text: 'ok', ts: 't2' },
      ];
      expect(sessionTimelineToChatMessages(toolOnly)[1].ts).toBe('t2');

      // Only the prompt is stamped: the turn's start is the sole honest answer.
      const startOnly: TimelineEntry[] = [
        { kind: 'prompt', text: 'run', ts: 't0' },
        { kind: 'tool_use', toolName: 'Bash', toolInput: {} },
      ];
      expect(sessionTimelineToChatMessages(startOnly)[1].ts).toBe('t0');
    });

    it('is carried by the messages-only wrapper and the full mapper identically', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi', ts: 't1' },
        { kind: 'text', text: 'Hello', ts: 't2' },
      ];
      expect(mapSessionTimeline(entries).messages.map((m) => m.ts)).toEqual(['t1', 't2']);
    });
  });

  // WI-5997 (chat-ref-pills-2026-07-26 P-007 residual): a P-NNN ref pill's
  // click resolves off ChatMessage.planSlug (PapercupChat reads it
  // per-message) — this mapper never set it, so a real P-ref pill rendered
  // and hydrated but silently no-op'd on click.
  describe('planSlug (WI-5997)', () => {
    it('omits planSlug entirely when the caller passes no second argument (unchanged default behavior)', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi', ts: 't1' },
        { kind: 'text', text: 'Hello', ts: 't2' },
      ];
      const out = sessionTimelineToChatMessages(entries);
      expect(out.every((m) => !('planSlug' in m))).toBe(true);
    });

    it('stamps every mapped message (user + assistant) with the given planSlug', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi', ts: 't1' },
        { kind: 'text', text: 'Hello', ts: 't2' },
      ];
      const out = sessionTimelineToChatMessages(entries, 'my-plan-2026-07-26');
      expect(out).toEqual([
        { role: 'user', content: 'hi', id: 'prompt-0', ts: 't1', planSlug: 'my-plan-2026-07-26' },
        { role: 'assistant', content: 'Hello', id: 'turn-0', ts: 't2', planSlug: 'my-plan-2026-07-26' },
      ]);
    });

    it('stamps an explicit null (no active plan) rather than omitting the field, distinct from the undefined default', () => {
      const entries: TimelineEntry[] = [{ kind: 'prompt', text: 'hi', ts: 't1' }];
      const out = sessionTimelineToChatMessages(entries, null);
      expect(out).toEqual([{ role: 'user', content: 'hi', id: 'prompt-0', ts: 't1', planSlug: null }]);
    });

    it('a tool-only assistant message is also stamped', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'run the tests', ts: 't0' },
        { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, ts: 't1' },
      ];
      const out = sessionTimelineToChatMessages(entries, 'p');
      expect(out).toEqual([
        { role: 'user', content: 'run the tests', id: 'prompt-0', ts: 't0', planSlug: 'p' },
        {
          role: 'assistant',
          content: '',
          tools: [{ name: 'Bash', input: { command: 'npm test' } }],
          id: 'turn-0',
          ts: 't1',
          planSlug: 'p',
        },
      ]);
    });
  });
});

/**
 * The entry→message translation a search deep-link needs.
 *
 * The stream's `anchor` event names an index into the FLAT timeline; this
 * mapper collapses that timeline into turns and drops whole entry kinds. The
 * two indices are therefore NOT interchangeable, and the failure mode of
 * assuming they are is silent: you scroll confidently to the wrong turn.
 */
describe('mapSessionTimeline — messageIndexForEntryIndex', () => {
  it('translates a flat entry index into the message that entry ended up in', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'first ask', ts: 't1' },   // 0 -> msg 0 (user)
      { kind: 'text', text: 'first answer', ts: 't2' },  // 1 -> msg 1 (assistant)
      { kind: 'prompt', text: 'second ask', ts: 't3' },  // 2 -> msg 2 (user)
      { kind: 'text', text: 'second answer', ts: 't4' }, // 3 -> msg 3 (assistant)
    ];
    const m = mapSessionTimeline(entries);
    expect(m.messages.map((x) => x.content)).toEqual([
      'first ask', 'first answer', 'second ask', 'second answer',
    ]);
    expect([0, 1, 2, 3].map((i) => m.messageIndexForEntryIndex(i))).toEqual([0, 1, 2, 3]);
  });

  it('collapses MANY entries onto ONE message — the case a raw index gets wrong', () => {
    // Three text entries become a single assistant message, so entry index 3
    // is message index 1, not 3. Reading the anchor as a message index here
    // would overshoot past the end of a short transcript.
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'ask', ts: 't1' },
      { kind: 'text', text: 'a', ts: 't2' },
      { kind: 'text', text: 'b', ts: 't3' },
      { kind: 'text', text: 'c', ts: 't4' },
    ];
    const m = mapSessionTimeline(entries);
    expect(m.messages).toHaveLength(2);
    expect(m.messageIndexForEntryIndex(3)).toBe(1);
  });

  it('maps a DROPPED tool_result to the turn that ran the tool', () => {
    // tool_result never becomes a message, but anchoring on one must still
    // land somewhere useful — the turn it belongs to — rather than failing.
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'ask', ts: 't1' },
      { kind: 'tool_use', toolName: 'grep', toolInput: { q: 'x' }, ts: 't2' },
      { kind: 'tool_result', text: 'a very large blob', ts: 't3' },
      { kind: 'text', text: 'done', ts: 't4' },
    ];
    const m = mapSessionTimeline(entries);
    expect(m.messageIndexForEntryIndex(2)).toBe(1);
    expect(m.messageIndexForEntryIndex(1)).toBe(1);
  });

  it('returns -1 for an out-of-range index and for an empty timeline', () => {
    expect(mapSessionTimeline([]).messageIndexForEntryIndex(0)).toBe(-1);
    const m = mapSessionTimeline([{ kind: 'prompt', text: 'ask', ts: 't1' }]);
    expect(m.messageIndexForEntryIndex(99)).toBe(-1);
    expect(m.messageIndexForEntryIndex(-1)).toBe(-1);
  });

  it('returns -1 for a turn that produced NO message (pure status)', () => {
    // A status-only turn is dropped entirely, so there is nothing to scroll
    // to — and saying so is better than pointing at a neighbouring turn.
    const entries: TimelineEntry[] = [{ kind: 'status', text: 'thinking…', ts: 't1' }];
    const m = mapSessionTimeline(entries);
    expect(m.messages).toEqual([]);
    expect(m.messageIndexForEntryIndex(0)).toBe(-1);
  });

  it('is byte-identical to sessionTimelineToChatMessages for the same input', () => {
    // The old export is now a wrapper; every existing caller must be unchanged.
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'ask', ts: 't1' },
      { kind: 'tool_use', toolName: 'grep', toolInput: { q: 'x' }, ts: 't2' },
      { kind: 'text', text: 'done', ts: 't3' },
    ];
    expect(mapSessionTimeline(entries).messages).toEqual(sessionTimelineToChatMessagesWithTurnIdentity(entries));
    expect(mapSessionTimeline(entries, 'p-1').messages)
      .toEqual(sessionTimelineToChatMessagesWithTurnIdentity(entries, 'p-1'));
  });
});
