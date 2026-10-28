/**
 * WI-6554700010042484 — the Claude context gauge anchors on the transcript's last
 * BILLED usage record and estimates only the bytes appended after it.
 *
 * Why: bytes/4 over the whole transcript broke twice when Claude Code added a new
 * out-of-context record type — `prompt_snapshot` (EI-23747373965813124) and, in
 * 2.1.312, `api-request-shape` / `api-request-blob` / `api-request`
 * (WI-6554700010042482). On 2.1.312 the gauge read ~2.2x real usage, so su sessions
 * self-compacted after ~18 API calls instead of ~76 (owner #2581). The class guard is
 * the "unknown record type" case below: a record type nobody has taught the
 * estimator about must not move the reading once a usage record follows it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  billedContextTokensOfLine,
  currentContextTokensSyncForOwner,
  lastBilledUsageIn,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
  tokensFromFileSize,
} from './compaction-usage';

/** Below this the estimator takes the stat-only fast path (size/4, no scan). */
const BOUNDARY_SCAN_MIN = 256 * 1024;

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-billed-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'latin1');
  return p;
}

/** An in-context line with no usage record (a user turn / tool result). */
function userLine(i: number, filler = 2000): string {
  return JSON.stringify({
    parentUuid: `u${i}`,
    type: 'user',
    message: { role: 'user', content: 'x'.repeat(filler) },
  });
}

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  iterations?: Usage[];
}

function assistantLine(usage: Usage, opts: { sidechain?: boolean; filler?: number } = {}): string {
  return JSON.stringify({
    parentUuid: 'a',
    isSidechain: opts.sidechain ?? false,
    type: 'assistant',
    message: { role: 'assistant', content: 'z'.repeat(opts.filler ?? 500), usage },
  });
}

/** Claude Code 2.1.312's replay record — one whole out-of-context line. */
function apiRequestShapeLine(filler = 300_000): string {
  return `{"type":"api-request-shape","system":"${'s'.repeat(filler)}"}`;
}

/** A record type the estimator has never heard of: the next Claude Code release's. */
function futureRecordLine(filler = 400_000): string {
  return `{"type":"some-future-replay-record","body":"${'f'.repeat(filler)}"}`;
}

const USAGE: Usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 1_000,
  cache_read_input_tokens: 150_000,
  output_tokens: 500,
};
const BILLED = 2 + 1_000 + 150_000 + 500;

/** Bytes of the lines after the anchor, each with its trailing newline. */
function tailBytes(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

describe('billedContextTokensOfLine', () => {
  it('reads input + cache_creation + cache_read + output from a main-chain assistant record', () => {
    expect(billedContextTokensOfLine(assistantLine(USAGE))).toBe(BILLED);
  });

  it('uses the LAST iteration when a response ran several server-side iterations', () => {
    const line = assistantLine({
      ...USAGE,
      iterations: [
        { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 50 },
        { input_tokens: 1, cache_read_input_tokens: 120_000, output_tokens: 70 },
      ],
    });
    expect(billedContextTokensOfLine(line)).toBe(1 + 120_000 + 70);
  });

  it('returns null for sidechain records, zero-usage stubs, non-assistant lines and bad JSON', () => {
    expect(billedContextTokensOfLine(assistantLine(USAGE, { sidechain: true }))).toBeNull();
    expect(billedContextTokensOfLine(assistantLine({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
    expect(billedContextTokensOfLine(userLine(0))).toBeNull();
    expect(billedContextTokensOfLine('{"type":"assistant",')).toBeNull();
  });
});

describe('lastBilledUsageIn', () => {
  it('skips a trailing assistant line that has no newline yet (mid-write)', () => {
    const earlier = assistantLine(USAGE);
    const text = `${earlier}\n${assistantLine({ ...USAGE, cache_read_input_tokens: 999_999 })}`;
    expect(lastBilledUsageIn(text)).toEqual({ tokens: BILLED, lineEnd: earlier.length });
  });

  it('returns null when no assistant record carries usage', () => {
    expect(lastBilledUsageIn(`${userLine(0)}\n${userLine(1)}\n`)).toBeNull();
  });
});

describe('tokensFromFileSize — billed-usage anchor (WI-6554700010042484)', () => {
  it('reads the billed size plus the bytes appended after it, ignoring replay records before it', async () => {
    const after = [userLine(100, 4_000), userLine(101, 6_000)];
    const lines = [apiRequestShapeLine(), userLine(0), assistantLine(USAGE), ...after];
    const p = writeTranscript(lines);
    expect(fs.statSync(p).size).toBeGreaterThan(BOUNDARY_SCAN_MIN);

    expect(await tokensFromFileSize(p)).toBe(BILLED + Math.floor(tailBytes(after) / 4));
  });

  it('CLASS GUARD: an unknown out-of-context record type before the anchor does not move the reading', async () => {
    const after = [userLine(100)];
    const clean = writeTranscript([userLine(0, 300_000), assistantLine(USAGE), ...after]);
    const polluted = writeTranscript([
      userLine(0, 300_000),
      futureRecordLine(),
      futureRecordLine(),
      assistantLine(USAGE),
      ...after,
    ]);
    const cleanReading = await tokensFromFileSize(clean);
    expect(await tokensFromFileSize(polluted)).toBe(cleanReading);
    // Falsifiability control: under whole-file bytes/4 the two 400 KB junk lines add
    // ~200,000 tokens. A reading anywhere near that is this regression returning.
    expect(cleanReading).toBe(BILLED + Math.floor(tailBytes(after) / 4));
  });

  it('skips a sidechain record and a zero-usage error stub to reach the last real main-chain reading', async () => {
    const sidechain = assistantLine({ ...USAGE, cache_read_input_tokens: 5 }, { sidechain: true });
    const stub = assistantLine({ input_tokens: 0, output_tokens: 0 });
    const after = [sidechain, stub];
    const p = writeTranscript([userLine(0, 300_000), assistantLine(USAGE), ...after]);
    expect(await tokensFromFileSize(p)).toBe(BILLED + Math.floor(tailBytes(after) / 4));
  });

  it('ignores a usage record from BEFORE the last compaction marker (counts bytes/4 from the marker)', async () => {
    const marker = JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'summary' } });
    const lines = [userLine(0, 300_000), assistantLine(USAGE), marker, userLine(1)];
    const p = writeTranscript(lines);
    const text = lines.join('\n') + '\n';
    const markerAt = text.indexOf('"isCompactSummary":true');
    expect(await tokensFromFileSize(p)).toBe(Math.floor((text.length - markerAt) / 4));
  });

  it('falls back to bytes/4 when the transcript has no usage record at all', async () => {
    const lines = [userLine(0, 300_000), userLine(1)];
    const p = writeTranscript(lines);
    expect(await tokensFromFileSize(p)).toBe(Math.floor((lines.join('\n').length + 1) / 4));
  });
});

describe('incremental anchor — billed-usage re-basing (WI-6554700010042484)', () => {
  afterEach(() => resetContextAnchorsForTests());

  it('seeds on the last billed record and agrees with the full scan', async () => {
    const p = writeTranscript([apiRequestShapeLine(), assistantLine(USAGE), userLine(1)]);
    expect(seedContextAnchorForTests('billed-seed', p)).toBe(true);
    expect(currentContextTokensSyncForOwner('billed-seed')).toBe(await tokensFromFileSize(p));
    expect(currentContextTokensSyncForOwner('billed-seed')).toBe(
      BILLED + Math.floor(tailBytes([userLine(1)]) / 4),
    );
  });

  it('a new billed record appended between reads re-bases the count; junk before it never adds up', async () => {
    const p = writeTranscript([userLine(0, 300_000), assistantLine(USAGE)]);
    expect(seedContextAnchorForTests('billed-advance', p)).toBe(true);
    expect(currentContextTokensSyncForOwner('billed-advance')).toBe(BILLED);

    // One turn on 2.1.312: request replay records, a tool result, then the next reply.
    const next: Usage = { ...USAGE, cache_read_input_tokens: 151_500, cache_creation_input_tokens: 2_000 };
    const tail = userLine(7);
    fs.appendFileSync(
      p,
      [futureRecordLine(200_000), userLine(5), assistantLine(next), tail].join('\n') + '\n',
      'latin1',
    );
    const expected = 2 + 2_000 + 151_500 + 500 + Math.floor(tailBytes([tail]) / 4);
    expect(currentContextTokensSyncForOwner('billed-advance')).toBe(expected);
    expect(await tokensFromFileSize(p)).toBe(expected);
  });

  it('without a new billed record, appended in-context bytes still grow the reading', () => {
    const p = writeTranscript([userLine(0, 300_000), assistantLine(USAGE)]);
    expect(seedContextAnchorForTests('billed-grow', p)).toBe(true);
    const grow = userLine(9, 8_000);
    fs.appendFileSync(p, grow + '\n', 'latin1');
    expect(currentContextTokensSyncForOwner('billed-grow')).toBe(
      BILLED + Math.floor(tailBytes([grow]) / 4),
    );
  });
});
