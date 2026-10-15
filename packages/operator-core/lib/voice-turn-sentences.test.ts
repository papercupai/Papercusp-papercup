/**
 * voice-turn-sentences — the incremental speakable-sentence extractor behind
 * the device voice-turn SSE route (on-desktop-direct-lan-voice-2026-07-14
 * P-001/P-004). Verifies: sentence boundaries across chunk splits, <say>
 * unwrapping, control-tag block dropping (markup is NEVER spoken — D-006),
 * deferred partial tags at the stream tail, literal '<' prose, decimal
 * guards, and flush() semantics.
 */
import { describe, expect, it } from 'vitest';
import { createSentenceExtractor, splitSpeechText } from './voice-turn-sentences';

function feedAll(chunks: string[]): { sentences: string[]; flushed: string[] } {
  const ex = createSentenceExtractor();
  const sentences: string[] = [];
  for (const c of chunks) sentences.push(...ex.feed(c));
  return { sentences, flushed: ex.flush() };
}

describe('lossless provider-bounded speech chunks', () => {
  it('preserves every final tail beyond both historical reply/preview limits', () => {
    const original = 'Start. ' + 'long sentence '.repeat(700) + 'FINAL TAIL';
    const chunks = splitSpeechText(original, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.join('')).toBe(original);
    expect(chunks.at(-1)).toContain('FINAL TAIL');
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= 1000)).toBe(true);
  });
  it('retains whitespace and source-looking control tags as data', () => {
    const original = '  one\r\n\n<report>source data</report>\t two  ';
    expect(splitSpeechText(original, { maxChars: 8 }).join('')).toBe(original);
  });
  it('keeps Unicode code points whole while enforcing UTF-8 and character bounds', () => {
    const original = '😀界é'.repeat(100) + '🦉TAIL';
    const chunks = splitSpeechText(original, { maxChars: 9, maxUtf8Bytes: 12 });
    expect(chunks.join('')).toBe(original);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(9);
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(12);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
  it('falls back to bounded cuts for very long words, without duplication or overlap', () => {
    for (const maxChars of [1, 2, 7, 200, 4000]) {
      const original = 'x'.repeat(10_003) + 'TAIL';
      const chunks = splitSpeechText(original, { maxChars });
      expect(chunks.join('')).toBe(original);
      expect(chunks.every(chunk => chunk.length <= maxChars)).toBe(true);
    }
  });
  it('prefers a sentence boundary when it fits within a useful chunk', () => {
    expect(splitSpeechText('First sentence. Second sentence.', { maxChars: 20 })).toEqual(['First sentence. ', 'Second sentence.']);
  });
  it('fails explicitly when the provider cannot fit a source character', () => {
    expect(() => splitSpeechText('😀', { maxChars: 1 })).toThrow(RangeError);
    expect(() => splitSpeechText('界', { maxChars: 10, maxUtf8Bytes: 2 })).toThrow(RangeError);
    expect(() => splitSpeechText('text', { maxChars: 0 })).toThrow(RangeError);
    expect(splitSpeechText('', { maxChars: 10 })).toEqual([]);
  });
});

describe('plain prose sentence boundaries', () => {
  it('emits a sentence once the terminator + following whitespace arrive', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Hello there')).toEqual([]);
    expect(ex.feed('. ')).toEqual(['Hello there.']);
  });

  it('holds an end-of-buffer period until the next chunk proves it final', () => {
    const ex = createSentenceExtractor();
    // "3." might be "3.5" — no whitespace seen yet, so nothing emits.
    expect(ex.feed('It costs 3.')).toEqual([]);
    expect(ex.feed('5 dollars today. Next')).toEqual(['It costs 3.5 dollars today.']);
    expect(ex.flush()).toEqual(['Next']);
  });

  it('splits on ! and ? and newline', () => {
    const { sentences, flushed } = feedAll(['One! Two? Three\nFour']);
    expect(sentences).toEqual(['One!', 'Two?', 'Three']);
    expect(flushed).toEqual(['Four']);
  });

  it('does not split inside a decimal number', () => {
    const { sentences, flushed } = feedAll(['Pi is 3.14 about. Done']);
    expect(sentences).toEqual(['Pi is 3.14 about.']);
    expect(flushed).toEqual(['Done']);
  });

  it('drops punctuation-only fragments (nothing speakable)', () => {
    const { sentences, flushed } = feedAll(['... \n !! \n']);
    expect(sentences).toEqual([]);
    expect(flushed).toEqual([]);
  });

  it('handles sentences split across many tiny chunks', () => {
    const { sentences } = feedAll(['He', 'llo the', 're. How a', 're you? ']);
    expect(sentences).toEqual(['Hello there.', 'How are you?']);
  });
});

describe('operator tag protocol', () => {
  it('unwraps <say> content — the tag literals are never spoken', () => {
    const { sentences, flushed } = feedAll(['<say>Hi there. All good.</say>']);
    expect(sentences).toEqual(['Hi there.']);
    expect(flushed).toEqual(['All good.']);
  });

  it('drops a <set_mode> block entirely', () => {
    const { sentences, flushed } = feedAll(['Sure thing. <set_mode>passive</set_mode>Done now. ']);
    expect(sentences).toEqual(['Sure thing.', 'Done now.']);
    expect(flushed).toEqual([]);
  });

  it('drops a <report> block spanning multiple chunks', () => {
    const { sentences, flushed } = feedAll([
      'Answer here. <repo',
      'rt>secret machinery ',
      'inside</report> Tail prose',
    ]);
    expect(sentences).toEqual(['Answer here.']);
    expect(flushed).toEqual(['Tail prose']);
  });

  it('drops a self-closing <continue/> tag', () => {
    const { sentences, flushed } = feedAll(['Okay. <continue/>Next part here']);
    expect(sentences).toEqual(['Okay.']);
    expect(flushed).toEqual(['Next part here']);
  });

  it('defers a partial tag at the chunk tail instead of speaking it', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Wait for it. <sa')).toEqual(['Wait for it.']);
    expect(ex.feed('y>The answer. </say>')).toEqual(['The answer.']);
  });

  it('drops an unterminated tag/skip block at flush (markup noise, not speech)', () => {
    const ex = createSentenceExtractor();
    expect(ex.feed('Spoken bit. <report>never closed machinery')).toEqual(['Spoken bit.']);
    expect(ex.flush()).toEqual([]);
  });

  it('keeps a lone "<" that is not a tag as literal prose', () => {
    const { sentences } = feedAll(['2 < 5 is true. ']);
    expect(sentences).toEqual(['2 < 5 is true.']);
  });

  it('a tagless turn is fully spoken (parseOperatorTurn fallback parity)', () => {
    const { sentences, flushed } = feedAll(['Bare prose reply with no tags at all. Second bit']);
    expect(sentences).toEqual(['Bare prose reply with no tags at all.']);
    expect(flushed).toEqual(['Second bit']);
  });

  it('drops an unknown tag literal but keeps the prose after it', () => {
    const { flushed } = feedAll(['<thinking>real words here']);
    expect(flushed).toEqual(['real words here']);
  });
});
