import { describe, expect, it, vi } from 'vitest';
import { estimatePortableTokens, fitPortableTurns, inspectPortableTurnFit, type SessionPortSummarizer } from './fit';
import type { PortableTurn } from './types';

const turns = (count: number, words = 500): PortableTurn[] => Array.from({ length: count }, (_, i) => ({
  id: String(i), parentId: i ? String(i - 1) : null, role: i % 2 ? 'assistant' : 'user', timestamp: null,
  blocks: [{ type: 'text', text: `${i}:${'word '.repeat(words)}` }],
}));

describe('fitPortableTurns', () => {
  it('uses full fidelity when the shared target budget fits', async () => {
    const out = await fitPortableTurns({ turns: turns(2), availableTokens: 10_000 });
    expect(out.fidelity).toBe('full');
  });

  it('fails closed without a summarizer instead of dropping history', async () => {
    await expect(fitPortableTurns({ turns: turns(8), availableTokens: 1_500 })).rejects.toThrow(/no summarizer/);
  });

  it('summarizes older chunks and keeps a recent verbatim tail within budget', async () => {
    const summarizer = vi.fn(async (_input: Parameters<SessionPortSummarizer>[0]) => ({
      text: 'Older work established the architecture and tests.',
      model: 'summary-model',
      provider: 'gateway',
    }));
    const out = await fitPortableTurns({ turns: turns(8), availableTokens: 8_000, summarizer });
    expect(out.fidelity).toBe('summary-tail');
    expect(out.transcript).toContain('RECENT VERBATIM TAIL');
    expect(out.summary).toMatchObject({ model: 'summary-model', provider: 'gateway', promptVersion: 1 });
    expect(summarizer).toHaveBeenCalled();
    expect(summarizer.mock.calls[0]![0].maxOutputTokens).toBeGreaterThan(0);
  });

  it('uses a conservative UTF-8 byte upper bound and honors the exact final-payload boundary', async () => {
    expect(estimatePortableTokens('🙂')).toBe(4);
    const one = turns(1, 1);
    const rendered = 'prefix:' + '### USER\n0:word ';
    await expect(fitPortableTurns({
      turns: one,
      availableTokens: estimatePortableTokens(rendered),
      renderPayload: (text) => `prefix:${text}`,
    })).resolves.toMatchObject({ fidelity: 'full', estimatedTokens: estimatePortableTokens(rendered) });
    await expect(fitPortableTurns({
      turns: one,
      availableTokens: estimatePortableTokens(rendered) - 1,
      renderPayload: (text) => `prefix:${text}`,
    })).rejects.toThrow(/no summarizer/);
  });

  it('never splits an atomic conversation/tool group and globally bounds multi-chunk outputs', async () => {
    const summarizer = vi.fn(async (input: Parameters<SessionPortSummarizer>[0]) => ({
      text: `bounded-${input.maxOutputTokens}`,
      model: 'summary-model',
      provider: 'gateway',
    }));
    const out = await fitPortableTurns({
      turns: turns(6, 30_000),
      availableTokens: 400_000,
      summarizer,
    });
    expect(summarizer).toHaveBeenCalledTimes(2);
    expect(out.summary?.chunks).toBe(2);
    expect(out.estimatedTokens).toBeLessThanOrEqual(400_000);
    for (const [call] of summarizer.mock.calls) {
      expect(call.text).toContain('### USER');
      expect(call.text).toContain('### ASSISTANT');
      expect(call.maxOutputTokens).toBe(out.summary?.maxOutputTokensPerChunk);
    }
  });

  it('fails honestly when the latest atomic group cannot fit', async () => {
    const oversized = turns(2, 5_000);
    const preview = inspectPortableTurnFit({ turns: oversized, availableTokens: 100 });
    expect(preview).toMatchObject({
      feasible: false,
      fidelity: 'summary-tail',
      reason: expect.stringMatching(/latest required atomic/),
      summaryChunks: null,
    });
    expect(preview.minimumRequiredTokens).toBeGreaterThan(100);
    expect(preview.latestAtomicGroupEstimatedTokens).toBeGreaterThan(100);
    await expect(fitPortableTurns({
      turns: oversized,
      availableTokens: 100,
      summarizer: async () => ({ text: 'small', model: 'm', provider: 'p' }),
    })).rejects.toThrow(/latest required atomic/);
  });
});
