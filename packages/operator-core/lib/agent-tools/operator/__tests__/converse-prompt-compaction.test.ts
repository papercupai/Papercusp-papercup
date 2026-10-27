/**
 * buildOperatorPrompt — rolling-summary (compaction) context injection
 * (operator-context-compaction-2026-06-05 P-006/P-007).
 *
 * In 'compaction' mode (the default) a turn that carries a conversationId
 * composes the PG-stored rolling summary in as "## Earlier conversation
 * (compacted)" ABOVE the verbatim transcript; the 'window' escape hatch
 * (D-001), a missing conversationId, a missing summary, and a summary-read
 * failure all degrade to exactly the legacy window-only prompt. Mirrors the
 * sibling converse-prompt-surface.test.ts mocking style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const h = vi.hoisted(() => ({
  prefs: null as Record<string, unknown> | null,
  summary: null as string | null,
  readShouldThrow: false,
  readCalls: [] as string[],
}));

// Compaction behavior is independent of the catalog, which has its own strict
// registry tests. Avoid coupling this focused suite to production bootstrap.
vi.mock('../../../operator-mcp-tools', () => ({ ALL_AGENT_MCP_TOOLS: [] }));

vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: vi.fn(async () => null),
  lastUserContext: vi.fn(() => ''),
}));
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));
vi.mock('../../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => h.prefs),
}));
vi.mock('../../../operator-conversations', () => ({
  getConversationById: vi.fn(async () => null),
  readConversationSummary: vi.fn(async (id: string) => {
    h.readCalls.push(id);
    if (h.readShouldThrow) throw new Error('pg down');
    if (h.summary === null) return null;
    return {
      summaryText: h.summary,
      summaryThroughSeq: 17,
      summaryUpdatedAt: 1,
      summaryModel: 'stub-haiku',
      summaryTurnsCovered: 18,
    };
  }),
}));

import { buildOperatorPrompt } from '../converse-prompt';

const SUMMARY = 'DECISION: production harness is named "ledger". Open: voice cert.';
const MSGS = [
  { role: 'user' as const, content: 'recent turn A' },
  { role: 'assistant' as const, content: 'recent turn B' },
];

beforeEach(() => {
  h.prefs = null;
  h.summary = SUMMARY;
  h.readShouldThrow = false;
  h.readCalls = [];
});

describe('buildOperatorPrompt — compaction context', () => {
  it('composes the rolling summary above the verbatim transcript (default mode)', async () => {
    const out = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', conversationId: 'conv-1' },
      null,
    );
    expect(h.readCalls).toEqual(['conv-1']);
    expect(out.userPromptText).toContain('## Earlier conversation (compacted)');
    expect(out.userPromptText).toContain(SUMMARY);
    // Summary section sits ABOVE the verbatim transcript.
    const sumIdx = out.userPromptText.indexOf('## Earlier conversation (compacted)');
    const histIdx = out.userPromptText.indexOf('## Conversation history');
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(histIdx).toBeGreaterThan(sumIdx);
    // The verbatim window is still there, untouched.
    expect(out.userPromptText).toContain('recent turn A');
  });

  it('no conversationId ⇒ window-only prompt (no summary read at all)', async () => {
    const out = await buildOperatorPrompt({ messages: MSGS, trigger: 'user_message' }, null);
    expect(h.readCalls).toEqual([]);
    expect(out.userPromptText).not.toContain('## Earlier conversation (compacted)');
  });

  it("the 'window' escape hatch (D-001) suppresses the summary even with a conversationId", async () => {
    h.prefs = { operatorContextMode: 'window', operatorHistoryTokenBudget: 40000 };
    const out = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', conversationId: 'conv-1' },
      null,
    );
    expect(h.readCalls).toEqual([]);
    expect(out.userPromptText).not.toContain('## Earlier conversation (compacted)');
  });

  it('no stored summary yet ⇒ window-only prompt', async () => {
    h.summary = null;
    const out = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', conversationId: 'conv-1' },
      null,
    );
    expect(out.userPromptText).not.toContain('## Earlier conversation (compacted)');
  });

  it('a summary-read failure degrades silently to the window prompt', async () => {
    h.readShouldThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await buildOperatorPrompt(
        { messages: MSGS, trigger: 'user_message', conversationId: 'conv-1' },
        null,
      );
      expect(out.userPromptText).not.toContain('## Earlier conversation (compacted)');
      expect(out.userPromptText).toContain('recent turn A');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('summary read failed'),
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('P010 rendered summary and history share the configured hard budget', async () => {
    h.prefs = { operatorContextMode: 'compaction', operatorHistoryTokenBudget: 5000 };
    h.summary = 'summary decision '.repeat(400).slice(0, 6000); // Existing stored-summary cap.
    const messages = [
      { role: 'user' as const, content: 'old-marker ' + 'x'.repeat(7900) },
      { role: 'assistant' as const, content: 'assistant-marker ' + 'a'.repeat(7900) },
      { role: 'user' as const, content: 'latest-marker ' + 'u'.repeat(7900) },
    ];
    const out = await buildOperatorPrompt({ messages, trigger: 'user_message', conversationId: 'conv-1' }, null);
    const history = out.userPromptText.split('\n\n---\n\nTrigger:')[0];
    expect(history).toContain(h.summary);
    expect(history).toContain('latest-marker');
    expect(history).not.toContain('assistant-marker');
    expect(history).not.toContain('old-marker');
    expect(Math.ceil(history.length / 4)).toBeLessThanOrEqual(5000);
    h.prefs = { operatorContextMode: 'compaction', operatorHistoryTokenBudget: 8000 };
    const allowed = await buildOperatorPrompt({ messages, trigger: 'user_message', conversationId: 'conv-1' }, null);
    expect(allowed.userPromptText).toContain('old-marker');
    expect(allowed.userPromptText).toContain('assistant-marker');
    expect(allowed.userPromptText).toContain('latest-marker');
  });

  it('long-conversation guarantee: an early decision outside the verbatim window reaches the prompt via the summary', async () => {
    // A conversation > 2× the window: tiny budget keeps only the newest
    // turns; the early decision lives ONLY in the summary.
    h.prefs = { operatorContextMode: 'compaction', operatorHistoryTokenBudget: 5000 };
    const early = { role: 'user' as const, content: 'we decided to call it ledger' };
    const filler = Array.from({ length: 200 }, (_, i) => ({
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `filler turn ${i} `.repeat(40),
    }));
    const out = await buildOperatorPrompt(
      {
        messages: [early, ...filler],
        trigger: 'user_message',
        conversationId: 'conv-1',
      },
      null,
    );
    // The early turn itself was dropped by the budget window…
    expect(out.userPromptText).not.toContain('we decided to call it ledger');
    // …but the summary carries the decision to the model.
    expect(out.userPromptText).toContain('named "ledger"');
  });
});
