import { describe, expect, it } from 'vitest';
import { adaptCodexJsonl, adaptOmpJsonl } from './native-adapter';

const sid = '11111111-1111-4111-8111-111111111111';
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const codexHeader = { type: 'session_meta', payload: { id: sid } };
const ompHeader = { type: 'session', id: sid };

describe('native session-port adapters', () => {
  it('retains Codex tool inputs/results as linked inert evidence without provider ids or reasoning', () => {
    const adapted = adaptCodexJsonl(jsonl([
      codexHeader,
      { type: 'event_msg', payload: { type: 'user_message', message: 'decision' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'decision' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'provider-secret-id', input: 'exact input' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'provider-secret-id', output: [{ type: 'input_text', text: 'exact result' }, { type: 'input_image', image_url: 'binary-secret' }] } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'encrypted-secret', summary: [{ text: 'private reasoning' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'chosen' }] } },
    ]), sid);
    expect(adapted.turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
    const blocks = adapted.turns.flatMap((turn) => turn.blocks);
    const tools = blocks.filter((block) => block.type === 'tool_narrative');
    expect(tools).toMatchObject([
      { event: 'call', relationId: 'tool-1', name: 'exec', content: 'exact input' },
      { event: 'result', relationId: 'tool-1', content: 'exact result\n[input_image omitted]' },
    ]);
    expect(JSON.stringify(adapted)).not.toMatch(/provider-secret-id|binary-secret|encrypted-secret|private reasoning/);
    expect(adapted.stats.omittedThinkingBlocks).toBe(1);
  });

  it('uses Codex replacement history plus the following tail after compaction', () => {
    const adapted = adaptCodexJsonl(jsonl([
      codexHeader,
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old history' }] } },
      { type: 'compacted', payload: { replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept tail' }] },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] } },
    ]), sid);
    expect(adapted.turns.map((turn) => turn.blocks[0])).toEqual([
      { type: 'text', text: 'summary' }, { type: 'text', text: 'kept tail' }, { type: 'text', text: 'next' },
    ]);
    expect(adapted.turns[0]?.compactSummary).toBe(true);
  });

  it('selects the OMP active branch, retains tool pairs and excludes another branch', () => {
    const adapted = adaptOmpJsonl(jsonl([
      ompHeader,
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'decision' } },
      { type: 'message', id: 'side', parentId: 'u', message: { role: 'assistant', content: 'discarded branch' } },
      { type: 'message', id: 'call', parentId: 'u', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'native-call', name: 'read', arguments: { path: 'evidence.ts' } }] } },
      { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolCallId: 'native-call', content: [{ type: 'text', text: 'evidence' }] } },
    ]), sid);
    expect(adapted.turns.map((turn) => turn.id)).toEqual(['u', 'call', 'result']);
    expect(adapted.stats.sidechainRecords).toBe(1);
    expect(adapted.turns[1]?.blocks[0]).toMatchObject({ event: 'call', relationId: 'tool-1' });
    expect(adapted.turns[2]?.blocks[0]).toMatchObject({ event: 'result', relationId: 'tool-1', content: 'evidence' });
    expect(JSON.stringify(adapted)).not.toMatch(/native-call|discarded branch/);
  });

  it('retains the exact kept OMP tail with its summary and post-compaction records', () => {
    const adapted = adaptOmpJsonl(jsonl([
      ompHeader,
      { type: 'message', id: 'old', parentId: null, message: { role: 'user', content: 'old history' } },
      { type: 'message', id: 'kept', parentId: 'old', message: { role: 'assistant', content: 'kept tail' } },
      { type: 'compaction', id: 'compact', parentId: 'kept', summary: 'summary', firstKeptEntryId: 'kept' },
      { type: 'message', id: 'next', parentId: 'compact', message: { role: 'user', content: 'next' } },
    ]), sid);
    expect(adapted.turns.map((turn) => turn.id)).toEqual(['compact', 'kept', 'next']);
    expect(adapted.turns[0]?.compactSummary).toBe(true);
    expect(JSON.stringify(adapted)).not.toContain('old history');
  });

  it('refuses mismatched identities, malformed records, broken branches and unknown material wire', () => {
    expect(() => adaptCodexJsonl(jsonl([codexHeader]), 'another-native-id')).toThrow(/exact native session/);
    expect(() => adaptOmpJsonl(jsonl([ompHeader]), 'another-native-id')).toThrow(/exact native session/);
    expect(() => adaptCodexJsonl(jsonl([codexHeader]) + '{broken}\n', sid)).toThrow(/malformed/);
    expect(() => adaptOmpJsonl(jsonl([ompHeader, { type: 'message', id: 'a', parentId: 'missing' }]), sid)).toThrow(/missing parent/);
    expect(() => adaptOmpJsonl(jsonl([ompHeader, { type: 'message', id: 'a', parentId: 'a' }]), sid)).toThrow(/cycle/);
    expect(() => adaptCodexJsonl(jsonl([codexHeader, { type: 'response_item', payload: { type: 'new-wire' } }]), sid)).toThrow(/unsupported/);
    expect(() => adaptCodexJsonl(jsonl([codexHeader, { type: 'compacted', payload: {} }]), sid)).toThrow(/replacement history/);
  });
});
