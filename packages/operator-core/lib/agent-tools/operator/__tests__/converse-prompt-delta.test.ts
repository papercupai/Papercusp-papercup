/**
 * buildOperatorPrompt — WI-5071 session-reuse prompt variants.
 *
 * Three contracts:
 *  1. `userPromptTextDelta` = the full user prompt MINUS the history-carrying
 *     sections (rolling summary + verbatim transcript), PLUS the new-messages
 *     tail — a resumed claude session already holds prior turns verbatim, but
 *     has never seen the messages after its last reply (the current utterance
 *     reaches the brain ONLY through these sections).
 *  2. `memoryInUser: true` relocates the memory recall block from the SYSTEM
 *     prompt into BOTH user variants, so the system prompt stays byte-stable
 *     across a session's turns (the hash-invalidation + prompt-cache lever).
 *  3. Default (`memoryInUser` unset) stays byte-identical to the legacy
 *     layout: memory in system, delta never consumed.
 * Mirrors the sibling converse-prompt-compaction.test.ts mocking style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  memBlock: null as string | null,
}));

// Delta/history behavior is independent of the catalog, which has its own
// strict registry tests. Avoid coupling this suite to production bootstrap.
vi.mock('../../../operator-mcp-tools', () => ({ ALL_AGENT_MCP_TOOLS: [] }));

vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: vi.fn(async () => h.memBlock),
  lastUserContext: vi.fn(() => ''),
}));
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));
vi.mock('../../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => null),
}));
vi.mock('../../../operator-conversations', () => ({
  getConversationById: vi.fn(async () => null),
  readConversationSummary: vi.fn(async () => ({
    summaryText: 'SUMMARY: older turns compacted.',
    summaryThroughSeq: 3,
    summaryUpdatedAt: 1,
    summaryModel: 'stub',
    summaryTurnsCovered: 4,
  })),
}));

import { buildOperatorPrompt } from '../converse-prompt';

const MSGS = [
  { role: 'user' as const, content: 'old question' },
  { role: 'assistant' as const, content: 'old answer' },
  { role: 'user' as const, content: 'NEW utterance this turn' },
];
const MEM = '## Operator memory (relevant entries)\n\n- remembered fact';

beforeEach(() => {
  h.memBlock = MEM;
});

describe('buildOperatorPrompt — WI-5071 delta variant', () => {
  it('delta drops history sections but carries the new-messages tail + trigger', async () => {
    const out = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', conversationId: 'conv-1', memoryInUser: true },
      null,
    );
    // Full prompt: history present, no duplicate tail section.
    expect(out.userPromptText).toContain('## Conversation history');
    expect(out.userPromptText).toContain('## Earlier conversation (compacted)');
    expect(out.userPromptText).not.toContain('## New message(s) this turn');
    // Delta: history sections gone…
    expect(out.userPromptTextDelta).not.toContain('## Conversation history');
    expect(out.userPromptTextDelta).not.toContain('## Earlier conversation (compacted)');
    expect(out.userPromptTextDelta).not.toContain('old question');
    // …but the CURRENT utterance and the per-turn sections survive.
    expect(out.userPromptTextDelta).toContain('## New message(s) this turn');
    expect(out.userPromptTextDelta).toContain('NEW utterance this turn');
    expect(out.userPromptTextDelta).toContain('## Trigger');
    expect(out.userPromptTextDelta).toContain('## Modality');
  });

  it('delta tail spans everything after the last assistant message', async () => {
    const out = await buildOperatorPrompt(
      {
        messages: [
          { role: 'assistant', content: 'prior reply' },
          { role: 'system', content: 'card pick: option A' },
          { role: 'user', content: 'and another thing' },
        ],
        trigger: 'user_message',
        memoryInUser: true,
      },
      null,
    );
    expect(out.userPromptTextDelta).toContain('card pick: option A');
    expect(out.userPromptTextDelta).toContain('and another thing');
    expect(out.userPromptTextDelta).not.toContain('prior reply');
  });

  it('memoryInUser moves the recall block out of system into both user variants', async () => {
    const out = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', memoryInUser: true },
      null,
    );
    expect(out.systemPromptText).not.toContain('remembered fact');
    expect(out.userPromptText).toContain('remembered fact');
    expect(out.userPromptTextDelta).toContain('remembered fact');
  });

  it('system prompt is byte-stable across turns with differing histories (memoryInUser)', async () => {
    const a = await buildOperatorPrompt(
      { messages: MSGS, trigger: 'user_message', memoryInUser: true },
      null,
    );
    const b = await buildOperatorPrompt(
      {
        messages: [...MSGS, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'more' }],
        trigger: 'continue',
        memoryInUser: true,
      },
      null,
    );
    expect(a.systemPromptText).toBe(b.systemPromptText);
  });

  it('legacy layout (memoryInUser unset): memory stays in system, user prompt unchanged', async () => {
    const out = await buildOperatorPrompt({ messages: MSGS, trigger: 'user_message' }, null);
    expect(out.systemPromptText).toContain('remembered fact');
    expect(out.userPromptText).not.toContain('remembered fact');
  });
});
