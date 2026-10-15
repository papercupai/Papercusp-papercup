import { describe, expect, test } from 'vitest';
import { paneContains, screenContains, screenHasApprovalQuestion, screenHasAssistantReply, screenIsSendReady, SEND_READY_MARKERS, VtScreen } from './vt-screen';

describe('composer readiness during new-session setup', () => {
  test.each(SEND_READY_MARKERS)('rejects a background %s composer while the wizard has focus', (marker) => {
    // Retained candidate47a6 OMP failure: setup overlays the composer and
    // its footer. Seeing that footer did not authorize typing a greeting.
    const frame = `┌ New session — 1 Context ───┐\n│Connection: Connected      │\n└───────────────────────────┘\n${marker}\n>`;
    expect(screenIsSendReady(frame)).toBe(false);
    expect(screenIsSendReady(marker)).toBe(true);
  });

  test('waits for a running asynchronous setup driver until its final frame arrives', () => {
    expect(screenIsSendReady('Message — Enter send', true)).toBe(false);
    expect(screenIsSendReady('Message — Enter send', false)).toBe(true);
  });

  test('does not mistake ordinary transcript wording for a setup modal', () => {
    expect(screenIsSendReady('agent: New session setup is complete.\nEnter sends')).toBe(true);
  });

  test('accepts the initial draft composer before submission opens setup', () => {
    const frame = 'Message — Enter send · ↑↓ history · Esc cancel\n>\npot papercusp · role operator · session new';
    expect(screenIsSendReady(frame, false)).toBe(true);
  });
});

function frame(left: string[], right?: string[], title = 'Agent Chat'): string {
  const header = `┌ ${title} `.padEnd(36, '─') + '┐';
  return [header + (right ? '┌ Presence ──────┐' : ''), ...left.map((line, index) =>
    '│' + line.padEnd(35) + '│' + (right ? '│' + (right[index] ?? '').padEnd(16) + '│' : ''))].join('\n');
}

describe('rendered screen needle matching', () => {
  // A double-width glyph occupies TWO terminal columns. VtScreen models one
  // cell per character and honours the cursor move Ratatui emits past the
  // continuation column, so that column replays as the blank it began as: a
  // composer holding `日本語` reads back off the grid as `日 本 語`.
  const padded = '│> δraft ünsent 日 本 語          ││';

  test('matches a double-width needle across its continuation columns', () => {
    expect(screenContains(padded, '> δraft ünsent 日本語')).toBe(true);
  });
  test('still matches a needle written with the padding intact', () => {
    expect(screenContains(padded, '日 本 語')).toBe(true);
  });
  test('treats an astral-plane glyph as ONE character, not a surrogate pair', () => {
    expect(screenContains('│draft 🙂 x', 'draft 🙂x')).toBe(true);
  });

  // Negative controls. Collapsing the screen must not MANUFACTURE a match:
  // a helper that simply stripped every space would satisfy all three cases
  // above while making this clause's assertions unfalsifiable.
  test('rejects a double-width needle that is not on the screen', () => {
    expect(screenContains(padded, '日本語字')).toBe(false);
    expect(screenContains(padded, '日語')).toBe(false);
  });
  test('never strips a space that follows a NARROW character', () => {
    expect(screenContains(padded, 'δraftünsent')).toBe(false);
  });
  test('leaves an all-narrow needle on the untouched path', () => {
    expect(screenContains('│PUI-REPLY        ││', 'PUI-REPLY')).toBe(true);
    expect(screenContains('│PUI-REPLY        ││', 'PUI-ABSENT')).toBe(false);
  });

  test('workbench readiness waits for both independent renderers in the same frame', () => {
    const vt = new VtScreen(4, 100);
    const ready = ['Claude · /launch', 'Zellij (pui-chat-123)'];
    // The measured failure shape: the child chat is ready while the tab-bar
    // plugin has not painted row one. A chat-only wait returns too early.
    vt.feed('\x1b[2;1H┌ chat ──────────────\x1b[3;1HClaude · /launch');
    expect(screenContains(vt.text(), ready[0])).toBe(true);
    expect(screenContains(vt.text(), ready)).toBe(false);
    vt.feed('\x1b[1;1HZellij (pui-chat-123)');
    expect(screenContains(vt.text(), ready)).toBe(true);
    // An earlier appearance is insufficient if the current frame lost it.
    vt.feed('\x1b[1;1H\x1b[2K');
    expect(screenContains(vt.text(), ready)).toBe(false);
    expect(screenContains(vt.text(), [])).toBe(false);
  });
});

describe('rendered assistant reply evidence', () => {
  // Real frames: the transcript list draws a two-column highlight gutter, so
  // labels read `  agent` / `  you`, and `▸ agent` on the focused message.
  test('accepts the gutter and focus-marker label forms the PUI actually renders', () => {
    expect(screenHasAssistantReply(frame(['  you', 'Hi.', '▸ agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(true);
    expect(screenHasAssistantReply(frame(['  agent', 'PUI-REPLY', '▸ you', 'next']), 'PUI-REPLY')).toBe(true);
  });
  test('still ends the bubble at the next gutter-labelled owner turn', () => {
    expect(screenHasAssistantReply(frame(['  agent', 'waiting', '  you', 'PUI-REPLY']), 'PUI-REPLY')).toBe(false);
  });
  test('accepts an assistant bubble in a single pane', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(true);
  });
  test('accepts the same bubble beside populated Presence rows', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY'], ['omp active', 'working']), 'PUI-REPLY')).toBe(true);
  });
  test('retains literal pipe characters inside the assistant content', () => {
    expect(screenHasAssistantReply(frame(['agent', 'PUI│REPLY'], ['codex active']), /^PUI│REPLY$/)).toBe(true);
  });
  test('accepts a final reply after an indented reasoning section', () => {
    const screen = frame(['agent', '  reasoning', '  The requested marker is PUI-REPLY', 'RESUMED: PUI-REPLY']);
    expect(screenHasAssistantReply(screen, /^RESUMED:\s*PUI-REPLY$/)).toBe(true);
  });
  test('rejects a marker that appears only in reasoning detail', () => {
    expect(screenHasAssistantReply(frame(['agent', '  reasoning', '  PUI-REPLY']), 'PUI-REPLY')).toBe(false);
  });
  test('rejects an echoed owner request', () => {
    expect(screenHasAssistantReply(frame(['you', 'PUI-REPLY'], []), 'PUI-REPLY')).toBe(false);
  });
  test('rejects an apparent answer in a different pane', () => {
    expect(screenHasAssistantReply(frame(['you', 'still waiting'], ['agent', 'PUI-REPLY']), 'PUI-REPLY')).toBe(false);
    expect(screenHasAssistantReply(frame(['agent', 'PUI-REPLY'], undefined, 'Plans'), 'PUI-REPLY')).toBe(false);
  });
});

describe('pane-scoped wrapped text', () => {
  const composer = 'Message not accepted';
  test('reads a phrase the pane soft-wrapped across rows, which the row-bound matcher cannot', () => {
    // The measured shape: the composer wrapped the operator error between
    // "connection" and "interrupted", and where it wraps depends on open panes.
    const screen = frame(['503: PUI-E2E startup connection', 'interrupted draft kept'], ['omp', 'active'], composer);
    expect(screenContains(screen, 'PUI-E2E startup connection interrupted')).toBe(false);
    expect(paneContains(screen, composer, 'PUI-E2E startup connection interrupted')).toBe(true);
  });
  test('never splices the neighbouring pane into the phrase', () => {
    const screen = frame(['PUI-E2E startup', 'draft kept'], ['connection', 'interrupted'], composer);
    expect(paneContains(screen, composer, 'PUI-E2E startup connection')).toBe(false);
    expect(paneContains(screen, 'Presence', 'connection interrupted')).toBe(true);
  });
  test('only reads the pane the title names', () => {
    expect(paneContains(frame(['PUI-E2E startup connection interrupted']), 'Plans', 'startup connection')).toBe(false);
  });
});

describe('native approval question matching', () => {
  const path = '/tmp/pui-acceptance/.pui-note-with-a-deliberately-long-name.txt';
  const question = `Do you want to make this edit to ${path}?`;

  test('accepts a single-row question with the immediate Yes choice', () => {
    expect(screenHasApprovalQuestion(`${question}\n❯ 1. Yes\n  2. No`, question)).toBe(true);
  });

  test('accepts a measured soft wrap and a long-word path wrap', () => {
    expect(screenHasApprovalQuestion(
      `Do you want to make this edit to\n${path}?\n❯ 1. Yes`, question,
    )).toBe(true);
    expect(screenHasApprovalQuestion(
      `Do you want to make this edit to /tmp/pui-acceptance/.pui-\nacceptance-note.txt?\n❯ 1. Yes`,
      'Do you want to make this edit to /tmp/pui-acceptance/.pui-acceptance-note.txt?',
    )).toBe(true);
  });

  test.each([
    ['wrong target path', `${question.replace(path, '/tmp/other.txt')}\n❯ 1. Yes`],
    ['missing choice', question],
    ['blank between question rows', `Do you want to make this edit to\n\n${path}?\n❯ 1. Yes`],
    ['border between question rows', `Do you want to make this edit to\n┌ Card ─────┐\n${path}?\n❯ 1. Yes`],
    ['unrelated content before choice', `${question}\nunrelated pane text\n❯ 1. Yes`],
    ['blank before choice', `${question}\n\n❯ 1. Yes`],
    ['border before choice', `${question}\n┌ Another pane ──┐\n❯ 1. Yes`],
    ['different choice label', `${question}\n❯ 1. Yes, and allow all edits`],
    ['bordered question row', `│${question}│\n❯ 1. Yes`],
  ])('rejects %s', (_label, frame) => {
    expect(screenHasApprovalQuestion(frame, question)).toBe(false);
  });
});
