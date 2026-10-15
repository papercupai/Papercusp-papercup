/**
 * Tests for the chunk-boundary-safe output collector (WI-6728).
 *
 * ⚠ Every test here that matters SPLITS A MULTI-BYTE CHARACTER ACROSS CHUNKS
 * DELIBERATELY. That is the whole point: a normal-sized non-ASCII output
 * arrives in a single `data` event and passes against the BROKEN code too, so
 * a test that merely echoes an emoji proves nothing. The splits below are
 * constructed byte-by-byte so the boundary is where the test says it is.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createTextCollector, collectChildOutput } from './child-output.js';

/** Feed chunks to a fresh collector and read the final text. */
function collect(chunks: Buffer[]): string {
  const stream = new PassThrough();
  const c = createTextCollector(stream);
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return c.text();
}

/** The idiom this module replaces — reproduced so the bug is pinned, not described. */
function naive(chunks: Buffer[]): string {
  let s = '';
  for (const chunk of chunks) s += String(chunk);
  return s;
}

describe('the bug being fixed', () => {
  it('the naive `+= String(chunk)` idiom corrupts a split multi-byte character', () => {
    // '€' is E2 82 AC. Split after the first byte.
    const chunks = [Buffer.from([0xe2]), Buffer.from([0x82, 0xac])];
    const got = naive(chunks);

    expect(got).not.toBe('€');
    expect(got).toContain('�');
    // Silent: no throw, no error, just wrong bytes. That is why it survives.
    expect(got.length).toBeGreaterThan(0);
  });

  it('the naive idiom is CORRECT when the same character arrives whole — why casual tests miss it', () => {
    expect(naive([Buffer.from('€', 'utf8')])).toBe('€');
  });
});

describe('createTextCollector', () => {
  it('keeps a bounded decoded tail across split UTF-8 bytes', () => {
    const stream = new PassThrough();
    const c = createTextCollector(stream, { maxChars: 4 });
    const full = Buffer.from('abc€de', 'utf8');
    const cut = full.indexOf(Buffer.from('€', 'utf8')) + 1;
    stream.write(full.subarray(0, cut));
    expect(c.peek()).toBe('abc');
    stream.write(full.subarray(cut));
    expect(c.peek()).toBe('c€de');
    expect(c.text()).toBe('c€de');
    expect(c.bytes).toBe(full.length);
    c.append('fg');
    expect(c.text()).toBe('defg');
  });

  it('decodes a 3-byte character split across two chunks', () => {
    expect(collect([Buffer.from([0xe2]), Buffer.from([0x82, 0xac])])).toBe('€');
  });

  it('decodes a 4-byte character split at every interior boundary', () => {
    const full = Buffer.from('😀', 'utf8'); // F0 9F 98 80
    expect(full.length).toBe(4);
    for (let cut = 1; cut < full.length; cut++) {
      const got = collect([full.subarray(0, cut), full.subarray(cut)]);
      expect(got, `split after byte ${cut}`).toBe('😀');
    }
  });

  it('decodes a character split across THREE chunks (one byte at a time)', () => {
    const full = Buffer.from('😀', 'utf8');
    const chunks = [full.subarray(0, 1), full.subarray(1, 2), full.subarray(2, 3), full.subarray(3)];
    expect(collect(chunks)).toBe('😀');
  });

  it('preserves surrounding ASCII around a split character', () => {
    const full = Buffer.from('author: Renée Müller <r@x>', 'utf8');
    // Cut inside the 2-byte 'é'.
    const cut = full.indexOf(Buffer.from('é', 'utf8')) + 1;
    expect(collect([full.subarray(0, cut), full.subarray(cut)])).toBe('author: Renée Müller <r@x>');
  });

  it('emits a replacement char for genuinely invalid bytes, rather than hiding them', () => {
    // A lone continuation byte is not a truncated sequence — it is invalid.
    // The collector must not silently drop it.
    expect(collect([Buffer.from([0x82])])).toContain('�');
  });

  it('flushes an INCOMPLETE trailing sequence at end of stream', () => {
    // Stream ends mid-character (a killed child). The partial bytes must
    // surface as a replacement char, not vanish.
    const got = collect([Buffer.from('ok', 'utf8'), Buffer.from([0xe2, 0x82])]);
    expect(got.startsWith('ok')).toBe(true);
    expect(got).toContain('�');
  });

  it('text() is idempotent across repeated reads', () => {
    const stream = new PassThrough();
    const c = createTextCollector(stream);
    stream.write(Buffer.from('héllo', 'utf8'));
    const first = c.text();
    const second = c.text();
    expect(second).toBe(first);
    expect(first).toBe('héllo');
  });

  it('a chunk arriving AFTER an early read is not lost, and re-arms the flush', () => {
    // The timeout-handler pattern: something reads the text, then more output
    // arrives before the child actually closes.
    const stream = new PassThrough();
    const c = createTextCollector(stream);
    const full = Buffer.from('€', 'utf8');
    stream.write(full.subarray(0, 1));
    c.text(); // early read, mid-character
    stream.write(full.subarray(1));
    stream.write(Buffer.from('!', 'utf8'));
    expect(c.text()).toContain('!');
  });

  it('peek() does NOT corrupt a split character when polled on every chunk — text() does', () => {
    // The trap this pins, measured on a live guard red (EI-19972481847505004):
    // the obvious way to route an INCREMENTAL watcher ("has the landmark
    // appeared yet?") through this helper is to poll text() per 'data' event.
    // text() flushes via decoder.end(), which emits the held-back bytes of a
    // straddling character as U+FFFD and resets the decoder — so the
    // continuation bytes in the next chunk decode as invalid too. That passes
    // child-output-guard (no raw `+=` idiom remains) while reproducing the
    // exact corruption the guard exists to prevent: a green guard over a live
    // defect, which is the worst outcome available here.
    const split = (write: (c: { peek(): string; text(): string }) => void): string => {
      const stream = new PassThrough();
      const c = createTextCollector(stream);
      const full = Buffer.from('slot acquired ⚠ done', 'utf8');
      const at = full.indexOf(0xe2) + 1; // INSIDE the 3-byte ⚠
      stream.write(full.subarray(0, at));
      write(c); // the per-chunk poll under test
      stream.write(full.subarray(at));
      return c.text();
    };

    // The CONTROL: proves the hazard is real, so this test cannot quietly
    // degrade into asserting nothing if peek() ever starts flushing.
    expect(split((c) => void c.text())).toBe('slot acquired ��� done');
    expect(split((c) => void c.peek())).toBe('slot acquired ⚠ done');
  });

  it('peek() omits a character whose bytes have not all arrived, then reveals it', () => {
    // Not-yet-visible is the CORRECT answer for a needle search: those bytes
    // have not formed a character to match against.
    const stream = new PassThrough();
    const c = createTextCollector(stream);
    const full = Buffer.from('ok ⚠', 'utf8');
    stream.write(full.subarray(0, full.length - 1));
    expect(c.peek()).toBe('ok '); // no partial, no replacement char
    stream.write(full.subarray(full.length - 1));
    expect(c.peek()).toBe('ok ⚠');
    expect(c.text()).toBe('ok ⚠'); // and a terminal read still agrees
  });

  it('notifies incrementally with boundary-safe decoded text and flushes an incomplete tail', async () => {
    const stream = new PassThrough();
    const decoded: string[] = [];
    const c = createTextCollector(stream, { onDecodedText: (text) => decoded.push(text) });
    const full = Buffer.from('ready ⚠ done', 'utf8');
    const split = full.indexOf(Buffer.from('⚠', 'utf8')) + 1;

    stream.write(full.subarray(0, split));
    expect(decoded.join('')).toBe('ready ');
    stream.write(full.subarray(split));
    expect(decoded.join('')).toBe('ready ⚠ done');
    stream.write(Buffer.from([0xe2, 0x82]));
    expect(decoded.join('')).toBe('ready ⚠ done');

    const ended = new Promise<void>((resolve) => stream.once('end', () => resolve()));
    stream.end();
    await ended;
    expect(decoded.join('')).toBe('ready ⚠ done�');
    expect(c.text()).toBe('ready ⚠ done�');
  });

  it('streams boundary-safe decoded text without retaining the stream output', async () => {
    const stream = new PassThrough();
    const decoded: string[] = [];
    const c = createTextCollector(stream, {
      retainText: false,
      onDecodedText: (text) => decoded.push(text),
    });
    const full = Buffer.from('ready ⚠ done', 'utf8');
    const split = full.indexOf(Buffer.from('⚠', 'utf8')) + 1;
    stream.write(full.subarray(0, split));
    expect(decoded.join('')).toBe('ready ');
    stream.write(full.subarray(split));
    expect(decoded.join('')).toBe('ready ⚠ done');

    const ended = new Promise<void>((resolve) => stream.once('end', () => resolve()));
    stream.end();
    await ended;
    expect(c.peek()).toBe('');
    expect(c.text()).toBe('');
  });

  it('keeps decoder state separate when two streams are attached', async () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const decoded: string[] = [];
    const c = createTextCollector(first, {
      retainText: false,
      onDecodedText: (text) => decoded.push(text),
    });
    c.attach(second);
    const full = Buffer.from('é', 'utf8');

    first.write(full.subarray(0, 1));
    second.write(Buffer.from('B', 'utf8'));
    const secondEnded = new Promise<void>((resolve) => second.once('end', () => resolve()));
    second.end();
    await secondEnded;
    first.write(full.subarray(1));
    const firstEnded = new Promise<void>((resolve) => first.once('end', () => resolve()));
    first.end();
    await firstEnded;

    expect(decoded.join('')).toBe('Bé');
    expect(c.text()).toBe('');
  });

  it('append() adds literal text without decoding it', () => {
    const stream = new PassThrough();
    const c = createTextCollector(stream);
    stream.write(Buffer.from('out', 'utf8'));
    c.append('\ngit timed out');
    expect(c.text()).toBe('out\ngit timed out');
  });

  it('accepts a null/undefined stream (an un-piped fd) without throwing', () => {
    expect(createTextCollector(null).text()).toBe('');
    expect(createTextCollector(undefined).text()).toBe('');
    const c = createTextCollector(null);
    c.append('spawn failed');
    expect(c.text()).toBe('spawn failed');
  });

  it('takes an already-decoded string chunk as given (encoding set on the stream)', () => {
    const stream = new PassThrough({ encoding: 'utf8' });
    const c = createTextCollector(stream);
    stream.write(Buffer.from('héllo', 'utf8'));
    stream.end();
    expect(c.text()).toBe('héllo');
  });

  it('counts decoded bytes, not characters', () => {
    const stream = new PassThrough();
    const c = createTextCollector(stream);
    stream.write(Buffer.from('€', 'utf8'));
    expect(c.bytes).toBe(3);
    expect(c.text()).toBe('€');
  });
});

describe('collectChildOutput against a REAL child process', () => {
  /**
   * The end-to-end case. A large non-ASCII payload is guaranteed to cross a
   * pipe chunk boundary (pipes deliver at most 64KiB per read here), and the
   * boundary lands mid-character with high probability because the multi-byte
   * characters are dense. Under the naive idiom this test fails.
   */
  it('round-trips a multi-megabyte non-ASCII payload byte-for-byte', async () => {
    const unit = 'é€😀漢';
    const payload = unit.repeat(200_000); // > 2 MB of UTF-8, dense multi-byte
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(2_000_000);

    // Build the payload INSIDE the child — passing 2 MB through argv is E2BIG.
    const child = spawn(process.execPath, [
      '-e',
      // Write from a Buffer so node does not re-chunk on character boundaries.
      `process.stdout.write(Buffer.from(${JSON.stringify(unit)}.repeat(200000), 'utf8'))`,
    ]);
    const out = collectChildOutput(child);
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));

    expect(code).toBe(0);
    const text = out.stdout.text();
    expect(text).not.toContain('�');
    expect(text.length).toBe(payload.length);
    expect(text).toBe(payload);
  }, 30_000);

  /**
   * SELF-VALIDATION for the test above. A round-trip test only proves anything
   * if the payload actually crosses a chunk boundary MID-CHARACTER — otherwise
   * the broken idiom would pass it too and the green above would be worthless.
   *
   * So run the identical scenario through the NAIVE accumulator and require it
   * to corrupt. If Node ever changes its chunking such that boundaries stop
   * landing mid-character, THIS test fails — telling us the round-trip test has
   * gone vacuous, instead of letting it sit green and prove nothing.
   */
  it('the same payload DOES corrupt under the naive idiom (proves the case is live)', async () => {
    const unit = 'é€😀漢';
    const child = spawn(process.execPath, [
      '-e',
      `process.stdout.write(Buffer.from(${JSON.stringify(unit)}.repeat(200000), 'utf8'))`,
    ]);
    let naiveOut = '';
    child.stdout.on('data', (d) => (naiveOut += String(d)));
    await new Promise<void>((resolve) => child.on('close', () => resolve()));

    expect(
      naiveOut,
      'no chunk split mid-character — the round-trip test above is now vacuous',
    ).toContain('�');
  }, 30_000);

  it('captures stderr independently of stdout', async () => {
    const child = spawn(process.execPath, [
      '-e',
      `process.stdout.write('OUT-é'); process.stderr.write('ERR-€')`,
    ]);
    const out = collectChildOutput(child);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));

    expect(out.stdout.text()).toBe('OUT-é');
    expect(out.stderr.text()).toBe('ERR-€');
  }, 15_000);
});
