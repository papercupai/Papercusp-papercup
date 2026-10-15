import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptClaudeJsonl } from './claude-adapter';

const fixture = readFileSync(join(import.meta.dirname, '__fixtures__', 'claude-structural.jsonl'), 'utf8');

describe('adaptClaudeJsonl', () => {
  it('reconstructs the active path, drops sidechains, and de-duplicates compacted ancestors', () => {
    const out = adaptClaudeJsonl(fixture);
    expect(out.activeLeafId).toBe('a-leaf');
    expect(out.turns.map((turn) => turn.id)).toEqual([
      'u-summary',
      'a-after-compact',
      'u-attachment',
      'a-leaf',
    ]);
    expect(out.turns[0]).toMatchObject({ compactSummary: true, role: 'user' });
    expect(out.stats).toMatchObject({
      sourceRecords: 12,
      activePathRecords: 4,
      malformedRecords: 0,
      sidechainRecords: 2,
      compactedAncestors: 4,
      omittedAttachments: 1,
      unsupportedBlocks: 1,
      syntheticRecords: 1,
    });
  });

  it('preserves tool call/result pairs when no compaction supersedes them', () => {
    const preCompact = fixture.split('\n').slice(0, 4).join('\n');
    const out = adaptClaudeJsonl(preCompact);
    expect(out.stats).toMatchObject({ toolCalls: 1, toolResults: 1 });
    expect(out.turns[1].blocks).toContainEqual({
      type: 'tool_narrative',
      event: 'call',
      relationId: 'tool-1',
      name: 'Read',
      content: '{"file_path":"/workspace/example.ts"}',
    });
    expect(out.turns[2].blocks).toContainEqual({
      type: 'tool_narrative',
      event: 'result',
      relationId: 'tool-1',
      name: 'prior tool',
      content: 'export const answer = 42;',
      isError: false,
    });
  });

  it('retains the compact summary and tail when discarded logical ancestry contains a cycle', () => {
    const jsonl = [
      { type: 'system', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'old-attachment' },
      { type: 'user', uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true,
        message: { role: 'user', content: 'Current compacted context' } },
      { type: 'user', uuid: 'old-attachment', parentUuid: 'boundary',
        message: { role: 'user', content: 'Discarded old context' } },
      { type: 'assistant', uuid: 'tail', parentUuid: 'summary',
        message: { role: 'assistant', content: 'Continue from the summary' } },
    ].map((record) => JSON.stringify(record)).join('\n');

    const out = adaptClaudeJsonl(jsonl);
    expect(out.activeLeafId).toBe('tail');
    expect(out.turns.map((turn) => turn.id)).toEqual(['summary', 'tail']);
    expect(out.turns[0]).toMatchObject({ compactSummary: true });
    expect(JSON.stringify(out.turns)).not.toContain('Discarded old context');
    expect(out.stats).toMatchObject({ activePathRecords: 2, compactedAncestors: 2 });
    expect(out.warnings.join('\n')).toMatch(/summarized.*cycle/i);
  });

  it('rejects cycles in the retained tail even when an older compact summary exists', () => {
    const jsonl = [
      { type: 'user', uuid: 'summary', parentUuid: null, isCompactSummary: true,
        message: { role: 'user', content: 'Earlier summary' } },
      { type: 'user', uuid: 'active-user', parentUuid: 'active-assistant',
        message: { role: 'user', content: 'Current request' } },
      { type: 'assistant', uuid: 'active-assistant', parentUuid: 'active-user',
        message: { role: 'assistant', content: 'Current answer' } },
    ].map((record) => JSON.stringify(record)).join('\n');

    expect(() => adaptClaudeJsonl(jsonl)).toThrow(/cycle detected/);
  });

  it('drops foreign thinking/signatures while preserving text attachments and local inert tool links', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant', uuid: 'a1', parentUuid: null,
        message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'private chain', signature: 'provider-signature' },
          { type: 'tool_use', id: 'provider-call-id', name: 'Read', input: { path: '/tmp/a' } },
        ] },
      }),
      JSON.stringify({
        type: 'user', uuid: 'u2', parentUuid: 'a1',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'provider-call-id', content: 'result' },
          { type: 'document', name: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'portable notes' } },
          { type: 'attachment', content: 'QUJDREVGRw==' },
        ] },
      }),
    ].join('\n');
    const out = adaptClaudeJsonl(jsonl);
    const serialized = JSON.stringify(out.turns);
    expect(serialized).not.toContain('private chain');
    expect(serialized).not.toContain('provider-signature');
    expect(serialized).not.toContain('provider-call-id');
    expect(out.turns[0].blocks).toContainEqual(expect.objectContaining({
      type: 'tool_narrative', event: 'call', relationId: 'tool-1',
    }));
    expect(out.turns[1].blocks).toContainEqual(expect.objectContaining({
      type: 'tool_narrative', event: 'result', relationId: 'tool-1',
    }));
    expect(out.turns[1].blocks).toContainEqual(expect.objectContaining({
      type: 'text_attachment', name: 'notes.txt', text: 'portable notes', truncated: false,
    }));
    expect(out.stats).toMatchObject({
      omittedThinkingBlocks: 1,
      omittedSignatureBlocks: 1,
      textAttachments: 1,
      omittedAttachments: 1,
    });
  });

  it('fails boundedly on malformed lines and broken/cyclic parents', () => {
    const malformed = [
      '{not json',
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'missing', message: { role: 'user', content: 'x' } }),
    ].join('\n');
    const out = adaptClaudeJsonl(malformed);
    expect(out.turns).toHaveLength(1);
    expect(out.stats.malformedRecords).toBe(1);
    expect(out.warnings.join('\n')).toMatch(/malformed|missing parent/);
  });

  it('fails closed when a format drift leaves no material dialogue', () => {
    expect(() => adaptClaudeJsonl(JSON.stringify({ type: 'progress', uuid: 'p1', message: { content: null } })))
      .toThrow(/format drift/);
  });

  it('rejects ambiguous duplicate ids and cyclic active graphs', () => {
    const duplicate = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'u1', parentUuid: null, message: { role: 'assistant', content: 'two' } }),
    ].join('\n');
    expect(() => adaptClaudeJsonl(duplicate)).toThrow(/duplicate uuid/);

    const cycle = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'a1', message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'two' } }),
    ].join('\n');
    expect(() => adaptClaudeJsonl(cycle)).toThrow(/cycle detected/);
  });
});
