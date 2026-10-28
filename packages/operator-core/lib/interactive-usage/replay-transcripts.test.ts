import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseCodexChunk, parseOmpChunk } from './ingest-adapters';
import { parseTranscriptChunk } from './ingest-claude-transcripts';
import { replayTranscriptPrefix, transcriptSourceKindForAdapter } from './replay-transcripts';

const roots: string[] = [];
const line = (value: unknown) => JSON.stringify(value) + '\n';
const context = (model: string) => line({ type: 'turn_context', payload: { model } });
const codexUsage = (total: number, writes?: number) => line({ timestamp: '2026-09-23T12:00:00Z',
  type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: total },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 20,
      ...(writes === undefined ? {} : { cache_write_input_tokens: writes }) },
  } } });
async function file(text: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-replay-'));
  roots.push(root);
  const filePath = path.join(root, 'source.jsonl');
  await fs.writeFile(filePath, text);
  return filePath;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const codex = { name: 'codex', parse: parseCodexChunk };

describe('read-only historical transcript replay', () => {
  it('normalizes isolated adapter ids to the archive source family and leaves unknown ids unfiltered', () => {
    expect(transcriptSourceKindForAdapter('codex-iso-261')).toBe('codex');
    expect(transcriptSourceKindForAdapter('claude-iso-9')).toBe('claude');
    expect(transcriptSourceKindForAdapter('omp')).toBe('omp');
    expect(transcriptSourceKindForAdapter('custom-adapter')).toBeUndefined();
  });

  it('reconstructs model state, deduplicates cumulative updates and excludes bytes beyond the committed frontier', async () => {
    const source = context('gpt-6-luna') + codexUsage(1000, 100) + codexUsage(1000, 100) +
      context('gpt-6-sol') + codexUsage(2000, 0);
    const filePath = await file(source + codexUsage(3000, 0));
    const args = { filePath, byteOffset: Buffer.byteLength(source), adapter: codex, chunkBytes: 400 };
    const first = await replayTranscriptPrefix(args);
    expect(first.status).toBe('available');
    if (first.status !== 'available') throw new Error(first.reason);
    expect(first.events).toHaveLength(2);
    expect(first.models['gpt-6-luna']).toMatchObject({ requests: 1, uncachedInputTokensLowerBound: 300,
      cacheWriteTokensLowerBound: 100, pricedRequests: 1 });
    expect(first.models['gpt-6-sol']).toMatchObject({ requests: 1, uncachedInputTokensLowerBound: 400 });
    expect(first.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(await replayTranscriptPrefix(args)).toEqual(first);
    expect(await fs.readFile(filePath, 'utf8')).toBe(source + codexUsage(3000, 0));
  });

  it('keeps missing model, writes, uncached decomposition and price unknown', async () => {
    const source = codexUsage(1000);
    const result = await replayTranscriptPrefix({ filePath: await file(source), byteOffset: Buffer.byteLength(source), adapter: codex });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.models['unknown-openai']).toMatchObject({ requests: 1, inputTotalTokens: 1000,
      writeCountKnown: 0, uncachedInputKnown: 0, uncachedInputTokensLowerBound: 0, estimatedUsd: null });
  });

  it('merges Claude streaming duplicates across chunks and retains reported one-hour writes', async () => {
    const observation = (output: number) => line({ type: 'assistant', timestamp: '2026-09-23T12:00:00Z',
      message: { id: 'same', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: output,
        cache_read_input_tokens: 600, cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } } } });
    const source = observation(10) + observation(20);
    const result = await replayTranscriptPrefix({ filePath: await file(source), byteOffset: Buffer.byteLength(source),
      chunkBytes: Buffer.byteLength(observation(10)), adapter: { name: 'claude', parse: parseTranscriptChunk } });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.repeatedObservations).toBe(1);
    expect(result.models['claude-sonnet-4-6']).toMatchObject({ requests: 1, outputTokens: 20,
      cacheWrite1hTokensLowerBound: 100, cacheWrite5mTokensLowerBound: 0, inputTotalTokens: 710 });
  });

  it('resolves anonymous byte identities and handles UTF-8 without chunk corruption', async () => {
    const observation = line({ type: 'message', message: { role: 'assistant', model: 'claude-sonnet-4-6',
      content: '雪', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 } } });
    const source = observation + observation;
    const result = await replayTranscriptPrefix({ filePath: await file(source), byteOffset: Buffer.byteLength(source),
      chunkBytes: Buffer.byteLength(observation) + 4, adapter: { name: 'omp', parse: parseOmpChunk } });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.events.map(event => event.sourceId)).toEqual(['line:0', `line:${Buffer.byteLength(observation)}`]);
  });

  it('reports missing and truncated sources without inventing zero usage', async () => {
    const filePath = await file('x\n');
    expect(await replayTranscriptPrefix({ filePath: filePath + '.missing', byteOffset: 2, adapter: codex }))
      .toMatchObject({ status: 'unavailable', reason: 'missing' });
    expect(await replayTranscriptPrefix({ filePath, byteOffset: 3, adapter: codex }))
      .toMatchObject({ status: 'unavailable', reason: 'truncated' });
  });

  it('treats object-property model names as unknown source data, not aggregation objects', async () => {
    const source = context('constructor') + codexUsage(1000, 0);
    const result = await replayTranscriptPrefix({ filePath: await file(source), byteOffset: Buffer.byteLength(source), adapter: codex });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.models.constructor).toMatchObject({ requests: 1, estimatedUsd: null });
  });

  it('refuses partial frontiers and bounded replay exhaustion', async () => {
    const source = context('gpt-6-luna') + codexUsage(1000, 0) + codexUsage(2000, 0);
    const filePath = await file(source);
    const args = { filePath, byteOffset: Buffer.byteLength(source), adapter: codex };
    expect(await replayTranscriptPrefix({ ...args, byteOffset: args.byteOffset - 1 }))
      .toMatchObject({ status: 'unavailable', reason: 'incomplete-frontier' });
    expect(await replayTranscriptPrefix({ ...args, chunkBytes: 2 }))
      .toMatchObject({ status: 'unavailable', reason: 'line-too-large' });
    expect(await replayTranscriptPrefix({ ...args, maxRequests: 1 }))
      .toMatchObject({ status: 'unavailable', reason: 'request-limit' });
  });
});
