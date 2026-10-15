import { beforeEach, describe, expect, it, vi } from 'vitest';

type CapturedSink = {
  event(name: string, data: unknown): void;
  done(data?: unknown): void;
  close(): void;
  onClose(fn: () => void): void;
  readonly closed: boolean;
};
type CapturedSetup = (sink: CapturedSink) => Promise<void>;

const routeProbe = vi.hoisted(() => ({
  events: [] as Array<{ name: string; data: unknown }>,
  setup: null as (() => Promise<void>) | null,
}));
const resolverProbe = vi.hoisted(() => ({
  codexByUuid: vi.fn(async () => null as string | null),
}));
const dbSql = vi.hoisted(() => vi.fn((strings: TemplateStringsArray) => {
  const query = strings.join('');
  if (query.includes('session_turns') && query.includes('WHERE owner =')) {
    return Promise.resolve([
      { event_at: '2026-08-24T03:40:40.424Z', source_kind: 'claude', session_id: 'prior', turn_idx: 0, speaker: 'user', text: 'prior epoch prompt' },
      { event_at: '2026-08-24T03:40:42.267Z', source_kind: 'claude', session_id: 'prior', turn_idx: 1, speaker: 'assistant', text: 'prior epoch answer' },
      { event_at: '2026-08-25T03:40:40.424Z', source_kind: 'codex', session_id: 'current', turn_idx: 0, speaker: 'user', text: 'current epoch prompt' },
      { event_at: '2026-08-25T03:40:42.267Z', source_kind: 'codex', session_id: 'current', turn_idx: 1, speaker: 'assistant', text: 'current epoch answer' },
    ]);
  }
  if (query.includes('session_turn_parts')) return Promise.resolve([]);
  if (query.includes('session_turns') && query.includes('left(text')) {
    return Promise.resolve([
      { turn_idx: 0, ts: '2026-08-25T03:40:40.424Z', speaker: 'user', text: 'durable wake' },
      { turn_idx: 1, ts: '2026-08-25T03:40:42.267Z', speaker: 'assistant', text: 'durable answer' },
    ]);
  }
  if (query.includes('session_turns')) {
    return Promise.resolve([
      { turn_idx: 0, ts: '2026-08-25T03:40:40.424Z' },
      { turn_idx: 1, ts: '2026-08-25T03:40:42.267Z' },
    ]);
  }
  return Promise.resolve([]);
}));
vi.mock('@papercusp/sse', () => ({
  sseResponse: (opts: { setup: CapturedSetup }) => {
    routeProbe.events = [];
    let closed = false;
    const sink: CapturedSink = {
      event(name, data) { routeProbe.events.push({ name, data }); },
      done(data) { routeProbe.events.push({ name: 'done', data }); closed = true; },
      close() { closed = true; },
      onClose() {},
      get closed() { return closed; },
    };
    routeProbe.setup = () => opts.setup(sink);
    return new Response(null, { status: 200 });
  },
}));
vi.mock('@papercusp/scheduled-registry', () => ({
  managedSetInterval: () => ({ stop: vi.fn() }),
}));
const dbOrgHandle = { sql: dbSql };
const dbOrgMock = {
  getOrgPg: vi.fn(() => dbOrgHandle),
  getLegacyClient: vi.fn(() => dbOrgHandle),
  generated: {},
};
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  ...dbOrgMock,
}));
vi.mock('../../claude-sessions', () => ({
  resolveInteractiveTranscript: vi.fn(async () => null),
  SESSION_THINKING_ACTIVE_MS: 30_000,
}));
vi.mock('../../session-transcript-resolvers', () => ({
  findCodexRolloutPath: vi.fn(async () => null),
  findCodexRolloutPathByUuid: resolverProbe.codexByUuid,
  findOmpSessionPath: vi.fn(async () => null),
}));
vi.mock('../../session-timeline-parsers', () => ({
  createCodexTimelineParser: vi.fn(() => ({ parseLine: () => [], flush: () => [] })),
  createOmpTimelineParser: vi.fn(() => ({ parseLine: () => [], flush: () => [] })),
}));

const {
  capEntryText,
  THINKING_ENTRY_TEXT_CAP,
  sessionTurnEntryKind,
  backfillFromOwnerSessionTurns,
  decodeOwnerHistoryCursor,
  encodeOwnerHistoryCursor,
} = await import('../../owner-sessions/transcript');

const {
  default: streamRoutes,
  parseAgentTimelineChunks,
  pickSessionTurnWindow,
  sessionPartEntryKind,
  positionalScanLimit,
  POSITIONAL_SCAN_CEILING,
  preferHigherFidelityBackfill,
  shouldServeDbBackfill,
  splitUtf8Chunks,
  batchRawLogLines,
  slimFeatureForStream,
  slimFeaturesForStream,
  featureStateForStream,
  featuresForStreamEvent,
  splitCompleteJsonlSnapshot,
  HARNESS_STREAM_LOG_BATCH_BYTES,
  HARNESS_STREAM_LOG_BATCH_LINES,
  HARNESS_STREAM_FEATURE_TEXT_CAP,
  HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES,
  backfillFromSessionTurns,
} = await import('../routes/harness/streams');

beforeEach(() => {
  routeProbe.events = [];
  routeProbe.setup = null;
  resolverProbe.codexByUuid.mockClear();
  dbSql.mockClear();
});

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe('harness Run-view stream framing', () => {
  it('splits raw text on Unicode boundaries under the byte cap', () => {
    const source = 'prefix-🙂-漢字-नमस्ते-尾';
    const chunks = splitUtf8Chunks(source, 12);

    expect(chunks.join('')).toBe(source);
    expect(chunks.every((chunk) => utf8Bytes(chunk) <= 12)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('�'))).toBe(false);
  });

  it('batches newline-delimited log lines without exceeding byte or line limits', () => {
    const lines = ['one', 'two🙂', '三'.repeat(20), 'four', 'five'];
    const batches = batchRawLogLines(lines, 24, 2);

    expect(batches.join('')).toBe(lines.map((line) => `${line}\n`).join(''));
    expect(batches.every((batch) => utf8Bytes(batch) <= 24)).toBe(true);
    expect(batches.every((batch) => batch.split('\n').filter(Boolean).length <= 2)).toBe(true);
  });

  it('keeps the Run-view feature shape while dropping heavy detail columns', () => {
    const feature = {
      id: 'F-1',
      title: 'A feature',
      summary: 's'.repeat(HARNESS_STREAM_FEATURE_TEXT_CAP + 50),
      status: 'in_progress',
      attempts: 2,
      claims: ['claim one'],
      project_id: 'project-a',
      tags: ['ui'],
      notes: 'large notes body',
      metadata: { huge: 'detail' },
      author_pubkey: 'secret-provenance',
    };

    const slim = slimFeatureForStream(feature);
    expect(slim).toMatchObject({
      id: 'F-1',
      title: 'A feature',
      status: 'in_progress',
      attempts: 2,
      claims: ['claim one'],
      project_id: 'project-a',
      tags: ['ui'],
    });
    expect(String(slim.summary)).toHaveLength(HARNESS_STREAM_FEATURE_TEXT_CAP + 1);
    expect(slim).not.toHaveProperty('notes');
    expect(slim).not.toHaveProperty('metadata');
    expect(slim).not.toHaveProperty('author_pubkey');
  });

  it('projects every feature before the heartbeat serializes it', () => {
    const features = slimFeaturesForStream([
      { id: 'F-1', title: 'one', status: 'todo', attempts: 0, metadata: { blob: 'x'.repeat(10_000) } },
      { id: 'F-2', title: 'two', status: 'passed', attempts: 1, notes: 'x'.repeat(10_000) },
    ]);

    expect(features).toHaveLength(2);
    expect(JSON.stringify(features)).not.toContain('blob');
    expect(JSON.stringify(features)).not.toContain('notes');
    expect(HARNESS_STREAM_LOG_BATCH_BYTES).toBe(64 * 1024);
    expect(HARNESS_STREAM_LOG_BATCH_LINES).toBe(100);
  });

  it('falls back to compact state tuples when a feature corpus is too large', () => {
    const features = Array.from({ length: 5_000 }, (_, i) => ({
      id: `F-${i}`,
      title: `feature ${i}`,
      summary: 'x'.repeat(10_000),
      status: i % 2 ? 'passed' : 'todo',
      attempts: i % 3,
    }));

    expect(JSON.stringify(slimFeaturesForStream(features)).length)
      .toBeGreaterThan(HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES);
    expect(featuresForStreamEvent(features)).toEqual(featureStateForStream(features));
  });
});

describe('live JSONL snapshot framing', () => {
  it('excludes an incomplete tail and seeds follow at the last complete byte', () => {
    const complete = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'ready' } })}\n`;
    const incomplete = '{"type":"event_msg","payload":{"type":"agent_message","message":"still writing';
    const snapshot = splitCompleteJsonlSnapshot(Buffer.from(complete + incomplete));

    expect(snapshot.complete.toString('utf8')).toBe(complete);
    expect(snapshot.trailing.toString('utf8')).toBe(incomplete);
    expect(snapshot.cursor).toBe(Buffer.byteLength(complete));
    expect(snapshot.snapshotEnd).toBe(Buffer.byteLength(complete + incomplete));
  });

  it('keeps the cursor absolute when a bounded tail starts mid-record', () => {
    const prefix = '{"discarded":true}\n';
    const complete = `${JSON.stringify({ type: 'compacted', payload: {} })}\n`;
    const incomplete = '{"type":"compacted"';
    const start = prefix.length - 4;
    const snapshot = splitCompleteJsonlSnapshot(
      Buffer.from(`${prefix.slice(start)}${complete}${incomplete}`),
      start,
    );

    expect(snapshot.complete.toString('utf8')).toBe(complete);
    expect(snapshot.trailing.toString('utf8')).toBe(incomplete);
    expect(snapshot.cursor).toBe(start + Buffer.byteLength(prefix.slice(start) + complete));
  });
});

describe('capEntryText (UI-bound thinking entry cap)', () => {
  it('leaves short/absent text untouched (same object, no copy)', () => {
    const short = { kind: 'text' as const, text: 'hi' };
    expect(capEntryText(short)).toBe(short);
    const noText = { kind: 'status' as const };
    expect(capEntryText(noText)).toBe(noText);
  });

  it('caps oversized text with an explicit truncation marker', () => {
    const big = { kind: 'tool_result' as const, text: 'x'.repeat(THINKING_ENTRY_TEXT_CAP + 500), ts: 't1' };
    const capped = capEntryText(big);
    expect(capped).not.toBe(big);
    expect(capped.text!.length).toBeLessThan(big.text.length);
    expect(capped.text).toContain('[truncated 500 chars]');
    expect(capped.ts).toBe('t1'); // other fields preserved
    expect(big.text.length).toBe(THINKING_ENTRY_TEXT_CAP + 500); // input not mutated
  });
});

describe('harness agent thinking stream parsing', () => {
  it('attests native Claude end_turn and explicit result success while preserving unknown and errored results', () => {
    const timestamp = '2026-10-01T12:00:00.000Z';
    const parse = (row: unknown) => parseAgentTimelineChunks([JSON.stringify(row) + '\n']).entries;
    expect(parse({ type: 'assistant', uuid: 'reply', timestamp, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tools: read.' }] } }).at(-1)?.outcome).toBe('succeeded');
    expect(parse({ type: 'assistant', uuid: 'reply', timestamp, message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Working.' }] } }).some(entry => entry.outcome)).toBe(false);
    expect(parse({ type: 'result', is_error: true, result: 'Account error', timestamp }).at(-1)?.outcome).toBe('failed');
    expect(parse({ type: 'result', is_error: false, result: 'Tools: read.', timestamp }).at(-1)?.outcome).toBe('succeeded');
    expect(parse({ type: 'result', result: 'Legacy answer', timestamp }).at(-1)?.outcome).toBeUndefined();
  });
  it('parses durable run chunks into an initial live-thinking timeline', () => {
    const chunks = [
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"checking "}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"state"}}\n{"type":"message_update","assistantMessageEvent":{"type":"thinking_end"}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"I found "}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"the issue."}}\n',
      '{"type":"tool_execution_start","toolName":"Read","toolCallId":"t1","args":{"file":"x.ts"}}\n',
    ];

    const parsed = parseAgentTimelineChunks(chunks);

    expect(parsed.done).toBe(false);
    expect(parsed.entries).toEqual([
      { kind: 'status', text: '[thinking] checking state' },
      { kind: 'text', text: 'I found the issue.' },
      { kind: 'tool_use', toolName: 'Read', toolInput: { file: 'x.ts' }, toolId: 't1' },
    ]);
  });

  it('keeps a partial final line visible instead of waiting for another chunk', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial text"}}}',
    ]);

    expect(parsed.entries).toEqual([{ kind: 'text', text: 'partial text' }]);
  });

  it('stamps each entry with its source-record timestamp (transcript records)', () => {
    const T1 = '2026-07-01T02:14:43.029Z';
    const T2 = '2026-07-01T02:14:50.100Z';
    const parsed = parseAgentTimelineChunks([
      `{"type":"assistant","timestamp":"${T1}","message":{"content":[{"type":"text","text":"Working on it."},{"type":"tool_use","name":"Bash","input":{"command":"ls"},"id":"tu1"}]}}\n`,
      `{"type":"user","timestamp":"${T2}","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}\n`,
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'Working on it.', ts: T1 },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolId: 'tu1', ts: T1 },
      { kind: 'tool_result', toolId: 'tu1', text: 'ok', ts: T2 },
    ]);
  });

  it('emits a `prompt` entry for a real user/wake message (a turn boundary), not for tool_result', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"user","timestamp":"2026-07-01T10:00:00Z","message":{"content":"do the thing"}}\n',
      '{"type":"assistant","timestamp":"2026-07-01T10:00:01Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"c":"ls"},"id":"t1"}]}}\n',
      '{"type":"user","timestamp":"2026-07-01T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'prompt', text: 'do the thing', ts: '2026-07-01T10:00:00Z' },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { c: 'ls' }, toolId: 't1', ts: '2026-07-01T10:00:01Z' },
      { kind: 'tool_result', toolId: 't1', text: 'ok', ts: '2026-07-01T10:00:02Z' },
    ]);
  });

  it('treats a text-block-only user record as a prompt too', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"user","message":{"content":[{"type":"text","text":"hello wake"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([{ kind: 'prompt', text: 'hello wake' }]);
  });

  it('stamps accumulated text with the START-of-span timestamp, not the flush time', () => {
    const T = '2026-07-01T03:00:00.000Z';
    const parsed = parseAgentTimelineChunks([
      `{"type":"stream_event","timestamp":"${T}","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}\n`,
      '{"type":"stream_event","timestamp":"2026-07-01T03:00:05.000Z","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}\n',
      '{"type":"assistant","timestamp":"2026-07-01T03:00:06.000Z","message":{"content":[{"type":"text","text":"done"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'hello world', ts: T }, // first delta's time, not the flush
      { kind: 'text', text: 'done', ts: '2026-07-01T03:00:06.000Z' },
    ]);
  });
});

describe('session_turns fallback backfill (WI-4194 — pruned-transcript ended session)', () => {
  describe('sessionTurnEntryKind', () => {
    it('maps user/human turns to the prompt turn-boundary, everything else to text', () => {
      expect(sessionTurnEntryKind('user')).toBe('prompt');
      expect(sessionTurnEntryKind('human')).toBe('prompt');
      expect(sessionTurnEntryKind('assistant')).toBe('text');
      expect(sessionTurnEntryKind('tool')).toBe('text');
      expect(sessionTurnEntryKind(null)).toBe('text');
      expect(sessionTurnEntryKind(undefined)).toBe('text');
    });
  });

  describe('pickSessionTurnWindow', () => {
    // Monotonic, always-valid timestamps: turn i is i minutes after the base
    // (epoch math, so it scales past 59 without rolling into an invalid field).
    const BASE = Date.parse('2026-06-05T00:00:00.000Z');
    const tsAt = (i: number) => new Date(BASE + i * 60_000).toISOString();
    const list = (n: number) => Array.from({ length: n }, (_, i) => tsAt(i));

    it('tails the last cap turns when no anchor is given', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200);
      expect(start).toBe(800);
      expect(anchorPos).toBeNull();
    });

    it('returns start 0 when the session is shorter than the cap', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(50), 200);
      expect(start).toBe(0);
      expect(anchorPos).toBeNull();
    });

    it('centers the window on the turn nearest anchorTs', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(500));
      expect(anchorPos).toBe(500);
      expect(start).toBe(400); // 500 - cap/2
    });

    it('clamps the centered window to the end of the list', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(990));
      expect(anchorPos).toBe(990);
      expect(start).toBe(800); // clamped so start+cap never exceeds length
    });

    it('clamps the centered window to the start of the list', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(10));
      expect(anchorPos).toBe(10);
      expect(start).toBe(0); // 10 - 100 would be negative
    });

    it('picks the NEAREST turn by timestamp for an anchor between turns', () => {
      // anchor at 00:07:30 sits between turn 7 (00:07:00) and turn 8 (00:08:00);
      // turn 7 is 30s away, turn 8 is 30s away — the first-seen closest (7) wins.
      const { anchorPos } = pickSessionTurnWindow(list(20), 200, '2026-06-05T00:07:30.000Z');
      expect(anchorPos).toBe(7);
    });

    it('falls back to the tail when anchorTs is unparseable', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, 'not-a-date');
      expect(start).toBe(800);
      expect(anchorPos).toBeNull();
    });

    it('ignores turns with null ts when matching an anchor', () => {
      const withGaps: Array<string | null> = [tsAt(0), null, tsAt(2), null, tsAt(4)];
      const { anchorPos } = pickSessionTurnWindow(withGaps, 2, tsAt(2));
      expect(anchorPos).toBe(2); // the null rows are skipped, exact ts match wins
    });
  });
});

describe('DB-primary history backfill (session-turn-storage-2026-07-28 P-008/P-009)', () => {
  describe('sessionPartEntryKind', () => {
    it('maps each stored part_kind to the entry kind the pane already renders', () => {
      expect(sessionPartEntryKind('tool_use', 'assistant')).toBe('tool_use');
      expect(sessionPartEntryKind('tool_result', 'user')).toBe('tool_result');
      // A thinking block becomes a `status` entry — the same shape the JSONL
      // timeline parsers emit for reasoning, so the pane styles it unchanged.
      expect(sessionPartEntryKind('thinking', 'assistant')).toBe('status');
    });

    it('falls back to the SPEAKER for text parts, preserving turn boundaries', () => {
      // The frontend groups the timeline into turns on `prompt` entries, so a
      // user text part must stay a prompt or the pane loses its turn structure.
      expect(sessionPartEntryKind('text', 'user')).toBe('prompt');
      expect(sessionPartEntryKind('text', 'assistant')).toBe('text');
      expect(sessionPartEntryKind(null, 'human')).toBe('prompt');
      expect(sessionPartEntryKind(undefined, undefined)).toBe('text');
    });
  });

  describe('preferHigherFidelityBackfill (the cutover regression guard)', () => {
    const at = (iso: string) => ({ kind: 'text' as const, text: 'x', ts: iso });
    const bf = (isos: string[]) => ({ entries: isos.map(at), anchorIndex: null });

    it('does NOT shorten history for a session that predates the parts store', () => {
      // Caught live on the first real sweep: a running session had 13 parts
      // against 85 turns, because parts only accrue from the byte offset the
      // ingest had reached when P-001 shipped. Preferring parts here is a
      // fidelity upgrade that reads to the user as data loss.
      const parts = bf(['2026-07-28T05:00:00Z', '2026-07-28T05:01:00Z']);
      const turns = bf(['2026-07-27T09:00:00Z', '2026-07-28T05:01:00Z']);
      expect(preferHigherFidelityBackfill(parts, turns)).toBe(turns);
    });

    it('prefers parts once they reach as far back as the turns window', () => {
      const parts = bf(['2026-07-27T09:00:00Z', '2026-07-28T05:00:00Z']);
      const turns = bf(['2026-07-27T09:00:00Z', '2026-07-28T05:00:00Z']);
      expect(preferHigherFidelityBackfill(parts, turns)).toBe(parts);
    });

    it('prefers parts whenever their window is already full', () => {
      // Nothing can reach further back within `cap`, so fidelity wins outright.
      const parts = { entries: [at('2026-07-28T05:00:00Z'), at('2026-07-28T05:01:00Z')], anchorIndex: null };
      const turns = bf(['2020-01-01T00:00:00Z']);
      expect(preferHigherFidelityBackfill(parts, turns, 2)).toBe(parts);
    });

    it('falls through cleanly when either side is empty or absent', () => {
      const turns = bf(['2026-07-28T05:00:00Z']);
      expect(preferHigherFidelityBackfill(null, turns)).toBe(turns);
      expect(preferHigherFidelityBackfill({ entries: [], anchorIndex: null }, turns)).toBe(turns);
      const parts = bf(['2026-07-28T05:00:00Z']);
      expect(preferHigherFidelityBackfill(parts, null)).toBe(parts);
      expect(preferHigherFidelityBackfill(null, null)).toBeNull();
    });

    it('identity of the winner is what the caller gates on when the FILE is available', () => {
      // The P-008 regression: session_turns is TEXT-ONLY, so when the JSONL is
      // still on disk, serving turns is a DOWNGRADE from the file's full
      // tool-call timeline — and for any session predating the parts store
      // (no parts, plenty of turns) that is precisely the branch that fires.
      // The caller therefore checks `backfill !== fromParts` and declines, so
      // the guarantee this pins is that a turns win is IDENTIFIABLE as such by
      // reference, not silently indistinguishable from a parts win.
      const parts = bf(['2026-07-28T05:00:00Z']);
      const turns = bf(['2026-07-27T09:00:00Z']);
      const won = preferHigherFidelityBackfill(parts, turns);
      expect(won).toBe(turns);
      expect(won).not.toBe(parts);

      // ...and when parts legitimately win, the caller may serve the DB.
      const wideParts = bf(['2026-07-27T09:00:00Z', '2026-07-28T05:00:00Z']);
      expect(preferHigherFidelityBackfill(wideParts, turns)).toBe(wideParts);
    });

    it('does not let an untimestamped parts window claim to reach further back', () => {
      const parts = { entries: [{ kind: 'text' as const, text: 'x' }], anchorIndex: null };
      const turns = bf(['2026-07-27T09:00:00Z']);
      expect(preferHigherFidelityBackfill(parts, turns)).toBe(turns);
    });
  });

  describe('shouldServeDbBackfill (store-integrity guard, EI-20637908167729753)', () => {
    const at = (iso: string) => ({ kind: 'text' as const, text: 'x', ts: iso });
    const bf = (isos: string[], storeTruncated?: boolean) => ({
      entries: isos.map(at),
      anchorIndex: null,
      ...(storeTruncated === undefined ? {} : { storeTruncated }),
    });

    it('DECLINES a truncated parts win while the file is available', () => {
      // THE BUG. Ingest had already shortened these rows below what the pane
      // can render, so serving them shows a body that is quietly missing text
      // with no signal to the reader — while the JSONL on disk has all of it.
      // This is the exact shape that rendered a 7,051-char report as 2,000.
      const parts = bf(['2026-07-28T05:00:00Z'], true);
      expect(shouldServeDbBackfill(parts, { fileAvailable: true, fromParts: parts })).toBe(false);
    });

    it('SERVES an intact parts win while the file is available', () => {
      // The other half: declining unconditionally would abandon the DB path
      // (and its bounded windowed read) for every session, which is the cost
      // P-008 existed to remove. Only a LOSSY row is worth the file read.
      const parts = bf(['2026-07-28T05:00:00Z'], false);
      expect(shouldServeDbBackfill(parts, { fileAvailable: true, fromParts: parts })).toBe(true);
    });

    it('still SERVES a truncated parts win when the file is GONE', () => {
      // An ended+archived session has no file to fall back to. A truncated
      // body beats a dead pane, so the guard must not fire here — this is the
      // difference between degrading and breaking.
      const parts = bf(['2026-07-28T05:00:00Z'], true);
      expect(shouldServeDbBackfill(parts, { fileAvailable: false, fromParts: parts })).toBe(true);
    });

    it('keeps the original P-008 store guard: a turns win with a file present is declined', () => {
      const parts = bf(['2026-07-28T05:00:00Z']);
      const turns = bf(['2026-07-27T09:00:00Z']);
      expect(shouldServeDbBackfill(turns, { fileAvailable: true, fromParts: parts })).toBe(false);
      expect(shouldServeDbBackfill(turns, { fileAvailable: false, fromParts: parts })).toBe(true);
    });

    it('declines an absent or empty backfill regardless of file availability', () => {
      expect(shouldServeDbBackfill(null, { fileAvailable: false, fromParts: null })).toBe(false);
      const empty = { entries: [], anchorIndex: null };
      expect(shouldServeDbBackfill(empty, { fileAvailable: false, fromParts: empty })).toBe(false);
    });

    it('treats a missing storeTruncated flag as intact (turns carry no marker)', () => {
      // session_turns never sets the flag; absence must not be read as lossy or
      // every pre-parts session would pointlessly abandon the DB path.
      const turns = bf(['2026-07-28T05:00:00Z']);
      expect(shouldServeDbBackfill(turns, { fileAvailable: true, fromParts: turns })).toBe(true);
    });
  });

  describe('positionalScanLimit (P-009 — the unbounded scan this replaces)', () => {
    it('reads only the window it can actually use when tailing', () => {
      // The old query had NO LIMIT: a row per turn of the whole session, pulled
      // purely to choose a 200-row tail. Harmless as a rare fallback, a hot-path
      // cost the moment P-008 makes this the primary read.
      expect(positionalScanLimit(200, false)).toBe(200);
      expect(positionalScanLimit(1, false)).toBe(1);
      expect(positionalScanLimit(0, false)).toBe(1); // never a zero LIMIT
    });

    it('widens to a FIXED ceiling for an anchored deep-link, never to session length', () => {
      // An anchor can sit anywhere in the session, so the scan widens — but to
      // a constant, so the query stays O(1) in session length. An anchor older
      // than the ceiling degrades to the tail window + `anchor {found:false}`,
      // the same honest miss the file path already emits.
      expect(positionalScanLimit(200, true)).toBe(POSITIONAL_SCAN_CEILING);
      expect(positionalScanLimit(5000, true)).toBe(POSITIONAL_SCAN_CEILING);
    });
  });
});

describe('stable-owner history cursor paging', () => {
  const CURSOR = {
    at: '2026-08-24T03:40:42.267Z',
    sourceKind: 'claude',
    sessionId: 'prior',
    turnIdx: 1,
  };

  it('round-trips the complete ordering tuple and rejects malformed cursors', () => {
    expect(decodeOwnerHistoryCursor(encodeOwnerHistoryCursor(CURSOR))).toEqual(CURSOR);
    expect(decodeOwnerHistoryCursor('not-base64-json')).toBeNull();
    expect(decodeOwnerHistoryCursor(Buffer.from(JSON.stringify({ ...CURSOR, turnIdx: -1 })).toString('base64url'))).toBeNull();
  });

  it('drops the cap+1 look-behind row and returns a cursor for the oldest visible row', async () => {
    dbSql.mockResolvedValueOnce([
      { event_at: '2026-08-24T03:40:40.000Z', source_kind: 'claude', session_id: 'old', turn_idx: 9, speaker: 'assistant', text: 'look-behind' },
      { event_at: CURSOR.at, source_kind: CURSOR.sourceKind, session_id: CURSOR.sessionId, turn_idx: CURSOR.turnIdx, speaker: 'user', text: 'oldest visible' },
      { event_at: '2026-08-25T03:40:42.267Z', source_kind: 'codex', session_id: 'current', turn_idx: 2, speaker: 'assistant', text: 'newest visible' },
    ]);
    const page = await backfillFromOwnerSessionTurns('su-stable', { cap: 2 });
    expect(page?.entries.map((entry) => entry.text)).toEqual(['oldest visible', 'newest visible']);
    expect(page?.hasMore).toBe(true);
    expect(decodeOwnerHistoryCursor(page!.cursor!)).toEqual(CURSOR);
  });

  it('serves an older page as JSON without opening an SSE follower', async () => {
    const route = streamRoutes.find((candidate) => candidate.path === '/adv/session/thinking')!;
    const cursor = encodeOwnerHistoryCursor(CURSOR);
    const response = await route.handler(
      new Request(`http://localhost/api/adv/session/thinking?historyPage=1&historyOwner=su-stable&historyCursor=${cursor}`),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, hasMore: false, cursor: null });
    expect(routeProbe.setup).toBeNull();
    expect(dbSql.mock.calls.at(-1)?.slice(1)).toEqual(expect.arrayContaining([
      CURSOR.at,
      CURSOR.sourceKind,
      CURSOR.sessionId,
      CURSOR.turnIdx,
    ]));
  });
});

describe('live session DB fallback (WI-41527)', () => {
  it('serves durable turns when a live session has no resolvable transcript file', async () => {
    const route = streamRoutes.find((r) => r.path === '/adv/session/thinking');
    expect(route).toBeDefined();

    const response = await route!.handler(
      new Request('http://localhost/api/adv/session/thinking?codexRolloutId=missing-transcript'),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(routeProbe.setup).not.toBeNull();

    resolverProbe.codexByUuid.mockResolvedValueOnce(null);
    await routeProbe.setup!();

    expect(resolverProbe.codexByUuid).toHaveBeenCalledWith('missing-transcript');
    expect(routeProbe.events).toContainEqual({
      name: 'backfill',
      data: [
        { kind: 'prompt', text: 'durable wake', ts: '2026-08-25T03:40:40.424Z' },
        { kind: 'text', text: 'durable answer', ts: '2026-08-25T03:40:42.267Z' },
      ],
    });
    expect(routeProbe.events).toContainEqual({ name: 'thinking', data: { active: false } });
  });

  it('backfills predecessor and current epochs through the stable HUD owner id', async () => {
    const route = streamRoutes.find((r) => r.path === '/adv/session/thinking');
    expect(route).toBeDefined();

    const response = await route!.handler(
      new Request('http://localhost/api/adv/session/thinking?codexRolloutId=current-rollout&historyOwner=su-stable'),
      {} as never,
    );
    expect(response.status).toBe(200);
    await routeProbe.setup!();

    expect(routeProbe.events).toContainEqual({
      name: 'backfill',
      data: [
        { kind: 'prompt', text: 'prior epoch prompt', ts: '2026-08-24T03:40:40.424Z' },
        { kind: 'text', text: 'prior epoch answer', ts: '2026-08-24T03:40:42.267Z' },
        { kind: 'prompt', text: 'current epoch prompt', ts: '2026-08-25T03:40:40.424Z' },
        { kind: 'text', text: 'current epoch answer', ts: '2026-08-25T03:40:42.267Z' },
      ],
    });
    expect(routeProbe.events).toContainEqual({
      name: 'history',
      data: { hasMore: false, cursor: null },
    });
    expect(dbSql.mock.calls.some(([strings]) => strings.join('').includes('WHERE owner ='))).toBe(true);
    expect(dbSql.mock.calls.some(([strings]) =>
      strings.join('').includes('session_turn_parts') && strings.join('').includes('WHERE owner ='),
    )).toBe(false);
  });
});
