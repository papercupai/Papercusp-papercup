/**
 * compaction-usage — the per-session context-size estimator's backend gating +
 * graceful degradation (agent-managed-compaction-2026-07-01 P-007/P-009). The
 * transcript-size path is exercised by integration; here we pin the pure guards:
 * unresolvable / non-Claude sessions must degrade to null, never throw.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const advSessionRowsMock = vi.hoisted(() =>
  vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]),
);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: advSessionRowsMock }),
}));
import {
  codexContextSnapshotFromRollout,
  codexRolloutSessionId,
  estimateContextTokens,
  estimateContextWindowForOwner,
  fallbackTranscriptFresh,
  healthyClaudeTranscriptResponseAt,
  observeHealthyClaudeTranscriptForOwner,
  newestTranscriptUnderOwner,
  parseLaunchCompactionLimitArgv,
  resolveCodexRolloutPathForRef,
  resolveSessionRef,
  resolveSessionRefReconciled,
  tokensFromFileSize,
} from './compaction-usage';

beforeEach(() => {
  advSessionRowsMock.mockResolvedValue([]);
});

describe('positive live transcript recovery evidence', () => {
  const now = 1_900_000_000_000;
  const response = { type: 'assistant', timestamp: new Date(now - 1).toISOString(),
    message: { model: 'claude', content: [{ type: 'text', text: 'The measured work continues.' }] } };
  it('uses the actual response clock, including a healthy quote of the provider error', () => {
    expect(healthyClaudeTranscriptResponseAt(JSON.stringify(response), now)).toBe(now - 1);
    expect(healthyClaudeTranscriptResponseAt(JSON.stringify({ ...response, message: { ...response.message,
      content: [{ type: 'text', text: 'I investigated "Prompt is too long".' }] } }), now)).toBe(now - 1);
  });
  it.each(['empty', 'partial', 'user-only', 'missing-clock', 'future-clock', 'api-error', 'synthetic',
    'synthetic-model', 'empty-response'])('does not call %s a healthy measurement', kind => {
    const record = structuredClone(response) as Record<string, any>;
    if (kind === 'user-only') record.type = 'user';
    if (kind === 'missing-clock') delete record.timestamp;
    if (kind === 'future-clock') record.timestamp = new Date(now + 1).toISOString();
    if (kind === 'api-error') record.isApiErrorMessage = true;
    if (kind === 'synthetic') record.isSynthetic = true;
    if (kind === 'synthetic-model') record.message.model = '<synthetic>';
    if (kind === 'empty-response') record.message.content = [];
    expect(healthyClaudeTranscriptResponseAt(kind === 'empty' ? '' : kind === 'partial' ? '{' : JSON.stringify(record), now)).toBeNull();
  });
  it('returns the response time from the same reconciled live transcript, with a bounded exact-owner read', async () => {
    const at = Date.now() - 10;
    const ref = { agent: 'claude', sessionId: 'current', transcriptOwner: 'original-root' };
    const readTail = vi.fn(async () => JSON.stringify({ ...response, timestamp: new Date(at).toISOString() }));
    const result = await observeHealthyClaudeTranscriptForOwner('owner', { resolveRef: async () => ref, readTail });
    expect(result).toEqual({ sessionId: 'current', measuredAtMs: at });
    expect(readTail).toHaveBeenCalledWith('owner', 256 * 1024, ref);
  });
  it.each(['missing-ref', 'non-claude', 'changing-session', 'changing-root', 'failed-read', 'failed-ref', 'unreadable-tail'])
    ('preserves %s instead of inventing a healthy response', async kind => {
      let calls = 0;
      const result = await observeHealthyClaudeTranscriptForOwner('owner', {
        resolveRef: async () => {
          calls++;
          if (kind === 'failed-ref') throw new Error('reference unreadable');
          if (kind === 'missing-ref') return null;
          return { agent: kind === 'non-claude' ? 'codex' : 'claude',
            sessionId: kind === 'changing-session' && calls > 1 ? 'other' : 'current',
            transcriptOwner: kind === 'changing-root' && calls > 1 ? 'other-root' : 'root' };
        }, readTail: async () => {
          if (kind === 'failed-read') throw new Error('transcript unreadable');
          return kind === 'unreadable-tail' ? null : JSON.stringify({ ...response, timestamp: new Date(Date.now() - 1).toISOString() });
        },
      });
      expect(result).toBeNull();
    });
});

describe('estimateContextTokens (backend gating + degradation)', () => {
  it('returns null for a null sessionId', async () => {
    expect(await estimateContextTokens({ agent: 'claude', sessionId: null })).toBeNull();
  });

  it('returns null for OMP (self-compacts natively — no v1 signal)', async () => {
    expect(await estimateContextTokens({ agent: 'omp', sessionId: 'omp-thread-123' })).toBeNull();
  });

  it('returns null for Codex before its adv-session key/rollout resolves', async () => {
    expect(await estimateContextTokens({ agent: 'codex', sessionId: 'codex-rollout-123' })).toBeNull();
  });

  it('returns null for an unresolvable Claude session (no transcript on disk)', async () => {
    const est = await estimateContextTokens({ agent: 'claude', sessionId: 'nonexistent-session-9999' });
    expect(est).toBeNull();
  });
});

describe('Codex rollout token_count telemetry (agent-managed-compaction D-011)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-codex-'));
  const rollout = join(dir, 'rollout.jsonl');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('retains a Codex adv-session row with no native session_id and keys it by row id', async () => {
    advSessionRowsMock.mockResolvedValue([{ id: 14795, agent: 'codex', session_id: null }]);
    await expect(resolveSessionRef('su-codex')).resolves.toEqual({
      agent: 'codex',
      sessionId: null,
      sessionKey: 14795,
    });
  });

  it('selects the latest adv-session deterministically for the context-write fence', async () => {
    advSessionRowsMock.mockClear();
    advSessionRowsMock.mockResolvedValue([{ id: 22, agent: 'claude', session_id: 'native-newest' }]);
    await resolveSessionRef('su-order');
    const statement = advSessionRowsMock.mock.calls[0]?.[0];
    expect(statement.join('')).toContain('ORDER BY started_at DESC, id DESC');
  });

  it('excludes terminal adv-session rows while keeping the active control selectable', async () => {
    const rows = [
      { id: 24, agent: 'claude', session_id: 'ended-with-time', started_at: '2026-10-14T12:00:00Z', ended_at: '2026-10-14T12:01:00Z', ended_by: 'self' },
      { id: 23, agent: 'claude', session_id: 'ended-with-writer-only', started_at: '2026-10-14T11:00:00Z', ended_at: null, ended_by: 'reconciler' },
      { id: 22, agent: 'claude', session_id: 'native-active', started_at: '2026-10-14T10:00:00Z', ended_at: null, ended_by: null },
    ];
    advSessionRowsMock.mockImplementation(async (strings) => {
      const query = strings.join('');
      const excludesTerminalRows = query.includes('ended_at IS NULL') && query.includes('ended_by IS NULL');
      return excludesTerminalRows ? rows.filter((row) => row.ended_at == null && row.ended_by == null) : rows;
    });

    await expect(resolveSessionRef('su-ended')).resolves.toMatchObject({
      agent: 'claude',
      sessionId: 'native-active',
      sessionKey: 22,
    });
    const statement = advSessionRowsMock.mock.calls[0]?.[0];
    expect(statement.join('')).toContain('ended_at IS NULL');
    expect(statement.join('')).toContain('ended_by IS NULL');
  });

  it('reads the newest valid last_token_usage and effective model window, never cumulative usage', async () => {
    const event = (tokens: number, total: number, window = 258_400) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: total },
            last_token_usage: { input_tokens: tokens - 100, output_tokens: 100, total_tokens: tokens },
            model_context_window: window,
          },
        },
      });
    writeFileSync(rollout, `${event(120_000, 9_000_000)}\n${event(156_981, 126_734_214)}\n`);

    expect(await codexContextSnapshotFromRollout(rollout)).toEqual({
      tokens: 156_981,
      modelContextWindow: 258_400,
    });
    expect(
      await estimateContextTokens(
        { agent: 'codex', sessionId: 'rollout-id', sessionKey: 14795 },
        null,
        { findCodexRollout: async () => rollout },
      ),
    ).toBe(156_981);
  });

  // EI-21595542328480968: the codex home is keyed by the adv-session ROW id, and an
  // owner can hold more than one live row, so this path can resolve to a home whose
  // newest rollout belongs to an already-dead session. Its final token_count is
  // frozen ABOVE the limit by construction (the predecessor respawned because it was
  // over), which pins the watchdog in a carry-respawn loop until it self-suppresses.
  describe('stale predecessor rollout (EI-21595542328480968)', () => {
    const named = (sessionId: string) => join(dir, `rollout-2026-08-27T03-39-24-${sessionId}.jsonl`);
    const tokenEvent = (tokens: number) =>
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: tokens - 100, output_tokens: 100, total_tokens: tokens },
            model_context_window: 200_000,
          },
        },
      })}\n`;
    // Shapes taken verbatim from the live failure: the resolver's reconciled ref named
    // 01a0426c-b998… while the keyed home's newest rollout was 01a04228-cb53…, 71.5
    // minutes stale, frozen at 227005/200000.
    const LIVE_SID = '01a0426c-b998-7e00-96ea-fd711dfcaa19';
    const DEAD_SID = '01a04228-cb53-7af1-ac58-0b3f7a5cf79b';

    it('extracts the native session id from a rollout filename, and returns null when it cannot', () => {
      expect(codexRolloutSessionId(named(DEAD_SID))).toBe(DEAD_SID);
      expect(codexRolloutSessionId(named(LIVE_SID))).toBe(LIVE_SID);
      // "cannot check" — never to be read as "mismatch".
      expect(codexRolloutSessionId(join(dir, 'rollout.jsonl'))).toBeNull();
      expect(codexRolloutSessionId(join(dir, 'notes.txt'))).toBeNull();
    });

    it('does NOT gate the estimate on a session-id mismatch — measured to disarm 15 healthy sessions per 1 fixed', async () => {
      // The tempting fix is to return null when the resolved rollout names a different
      // session and is stale. Measured against the live fleet 2026-08-27 (A/B, 134 live
      // codex sessions): that gate nulls 16, of which only ONE is the actual pathology
      // (227005/200000, over-limit, 71min stale). The other 15 sit comfortably UNDER
      // their limit — they are simply IDLE, which produces the same signature, and
      // nulling them disarms their compaction backstop. Net harm, so it is not wired.
      //
      // This test pins that decision so a future reader re-deriving the "obvious" fix
      // finds the measurement instead of re-shipping it. The correct discriminator
      // needs the session's own last_active_at, which lives in the watchdog.
      const path = named(DEAD_SID);
      writeFileSync(path, tokenEvent(227_005));
      const stale = Date.now() - 71.5 * 60_000;
      utimesSync(path, stale / 1000, stale / 1000);

      expect(codexRolloutSessionId(path)).not.toBe(LIVE_SID); // mismatched …
      expect(
        await estimateContextTokens(
          { agent: 'codex', sessionId: LIVE_SID, sessionKey: 14795 },
          null,
          { findCodexRollout: async () => path },
        ),
      ).toBe(227_005); // … and still reported, deliberately
    });
  });

  it('D-007 reads the runtime-capped GPT-5.6 effective window from rollout telemetry', async () => {
    writeFileSync(
      rollout,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 12_345 },
            model_context_window: 828_400,
          },
        },
      }) + '\n',
    );
    const snapshot = await codexContextSnapshotFromRollout(rollout);
    expect(snapshot).toEqual({ tokens: 12_345, modelContextWindow: 828_400 });
    expect(snapshot!.modelContextWindow).toBeGreaterThan(400_000);
  });

  it('skips a trailing rate-limit-only event and falls back to input+output when total_tokens is absent', async () => {
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 40_000, output_tokens: 321 },
              model_context_window: 258_400,
            },
          },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      ].join('\n') + '\n',
    );
    expect(await codexContextSnapshotFromRollout(rollout)).toEqual({
      tokens: 40_321,
      modelContextWindow: 258_400,
    });
  });

  // WI-10005305: the sweep asks for the same rollout twice per pass (tokens, then
  // window) and again every pass; an unchanged rollout must not be re-read.
  describe('rollout snapshot memo (WI-10005305)', () => {
    const tokenLine = (tokens: number) =>
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: tokens }, model_context_window: 258_400 },
        },
      })}\n`;
    const countingOps = () => {
      const open = vi.fn((p: fs.PathLike, flags?: string | number) => fs.promises.open(p, flags));
      return { ops: { stat: fs.promises.stat, open } as Pick<typeof fs.promises, 'stat' | 'open'>, open };
    };

    it('reads an unchanged rollout once and serves the repeat from the memo', async () => {
      const p = join(dir, 'memo-unchanged.jsonl');
      writeFileSync(p, tokenLine(111_111));
      const { ops, open } = countingOps();
      expect(await codexContextSnapshotFromRollout(p, ops)).toEqual({ tokens: 111_111, modelContextWindow: 258_400 });
      expect(await codexContextSnapshotFromRollout(p, ops)).toEqual({ tokens: 111_111, modelContextWindow: 258_400 });
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('re-reads after a new token_count event is appended', async () => {
      const p = join(dir, 'memo-append.jsonl');
      writeFileSync(p, tokenLine(111_111));
      const { ops, open } = countingOps();
      expect((await codexContextSnapshotFromRollout(p, ops))?.tokens).toBe(111_111);
      appendFileSync(p, tokenLine(150_000));
      expect((await codexContextSnapshotFromRollout(p, ops))?.tokens).toBe(150_000);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('re-reads a rollout replaced by rename even when size and mtime match', async () => {
      const p = join(dir, 'memo-replaced.jsonl');
      const fixedTime = new Date('2026-10-02T05:00:00Z');
      writeFileSync(p, tokenLine(111_111));
      utimesSync(p, fixedTime, fixedTime);
      const { ops, open } = countingOps();
      expect((await codexContextSnapshotFromRollout(p, ops))?.tokens).toBe(111_111);

      const staged = join(dir, 'memo-replaced.staged');
      writeFileSync(staged, tokenLine(222_222)); // same byte length as 111_111
      utimesSync(staged, fixedTime, fixedTime);
      const before = statSync(p);
      fs.renameSync(staged, p);
      const after = statSync(p);
      // Only the inode differs, so this pins the ino component of the memo key.
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).not.toBe(before.ino);

      expect((await codexContextSnapshotFromRollout(p, ops))?.tokens).toBe(222_222);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('does not remember a failed read', async () => {
      const p = join(dir, 'memo-failed-read.jsonl');
      writeFileSync(p, tokenLine(111_111));
      const failing = {
        stat: fs.promises.stat,
        open: vi.fn(async () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }),
      } as unknown as Pick<typeof fs.promises, 'stat' | 'open'>;
      expect(await codexContextSnapshotFromRollout(p, failing)).toBeNull();

      const { ops, open } = countingOps();
      expect((await codexContextSnapshotFromRollout(p, ops))?.tokens).toBe(111_111);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('returns null for a missing rollout', async () => {
      expect(await codexContextSnapshotFromRollout(join(dir, 'memo-missing.jsonl'))).toBeNull();
    });
  });

  it('exposes the rollout window for the watchdog limit clamp', async () => {
    writeFileSync(
      rollout,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 80_000 }, model_context_window: 258_400 },
        },
      }) + '\n',
    );
    // The owner resolver is integration-covered; the per-ref parser above pins
    // the exact window. A non-Codex/unresolvable owner remains fail-soft.
    expect(await estimateContextWindowForOwner('definitely-missing-owner')).toBeNull();
  });
});

describe('tokensFromFileSize (EI-6410 compaction-boundary discount)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-usage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const MB = 1024 * 1024;

  it('a small file stays whole-file/4 (no scan)', async () => {
    const p = join(dir, 'small.jsonl');
    writeFileSync(p, 'x'.repeat(40_000));
    expect(await tokensFromFileSize(p)).toBe(10_000);
  });

  it('counts only bytes AFTER the last raw compaction marker', async () => {
    const p = join(dir, 'compacted.jsonl');
    // 2MB of pre-compaction history, a compaction-summary entry, 400KB since.
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(400_000));
    const tokens = (await tokensFromFileSize(p))!;
    // ≈ (marker + 400KB)/4 — nowhere near the whole-file 2.4MB/4 ≈ 630k.
    expect(tokens).toBeLessThan(120_000);
    expect(tokens).toBeGreaterThan(90_000);
  });

  it('an ESCAPED text mention of the marker does not reset the count', async () => {
    const p = join(dir, 'mention.jsonl');
    const escapedMention = '{"content":"discussing \\"isCompactSummary\\":true in prose"}\n';
    writeFileSync(p, 'a'.repeat(2 * MB) + escapedMention + 'b'.repeat(100_000));
    // No RAW marker anywhere → whole-file count (the conservative old behavior).
    expect((await tokensFromFileSize(p))!).toBeGreaterThan(500_000);
  });

  it('missing file → null', async () => {
    expect(await tokensFromFileSize(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('EI-10434: a marker OUTSIDE the scan window stays BOUNDED at the scan cap — never the raw (unboundedly-growing) whole-file size', async () => {
    const p = join(dir, 'huge-no-marker-in-window.jsonl');
    // A real compaction marker sits near the START of a file that has since
    // grown well past BOUNDARY_SCAN_CAP (8MB) — the LAST-8MB scan window no
    // longer contains ANY marker, even though one genuinely exists earlier in
    // the file. This is the shape a long-running, many-times-compacted
    // session transcript takes over a full day (EI-10434: readings like
    // 20.9M/21.17M/24.3M tokens, monotonically growing across the day).
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    writeFileSync(p, marker + 'a'.repeat(12 * MB));
    const tokens = (await tokensFromFileSize(p))!;
    // Bounded by the scan window (BOUNDARY_SCAN_CAP=8MB / 4 = 2,097,152 tokens)
    // — NOT the raw ~12MB file's ≈3M-token whole-file reading, and must NEVER
    // be allowed to grow without bound as the file keeps growing (the
    // garbage-reading signature).
    expect(tokens).toBeLessThanOrEqual(8 * MB / 4);

    // Append 5MB more with still no marker in the new scan window — a
    // regression here means the estimate keeps climbing forever even though
    // nothing about "how much is unaccounted-for within the scan window" has
    // changed. That unbounded climb IS the EI-10434 bug signature.
    const before = tokens;
    appendFileSync(p, 'b'.repeat(5 * MB));
    const after = (await tokensFromFileSize(p))!;
    expect(after).toBeLessThanOrEqual(before + 10_000);
  });
});

describe('tokensFromFileSize (WI-3176 base64-image discount)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-usage-img-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const MB = 1024 * 1024;
  const b64 = (n: number) => 'iVBORw0KGgoAAAANSUhEUg'.repeat(Math.ceil(n / 23)).slice(0, n);

  it('counts an image payload at ~1600 tokens, not byte-weight', async () => {
    const p = join(dir, 'screenshot.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    // 2MB pre-compaction, then 100KB of text + one 2MB screenshot since.
    const img = `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${b64(2 * MB)}"}}\n`;
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(100_000) + img);
    const tokens = (await tokensFromFileSize(p))!;
    // ≈ 100KB/4 + 1600 ≈ 27k — NOT the undiscounted (100KB + 2MB)/4 ≈ 550k.
    expect(tokens).toBeLessThan(40_000);
    expect(tokens).toBeGreaterThan(20_000);
  });

  it('discounts the toolUseResult duplicate ("base64" key) too', async () => {
    const p = join(dir, 'tooluseresult.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    const dup = `{"toolUseResult":{"type":"image","file":{"base64":"${b64(1 * MB)}","media_type":"image/png"}}}\n`;
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(100_000) + dup);
    const tokens = (await tokensFromFileSize(p))!;
    expect(tokens).toBeLessThan(40_000);
  });

  it('a long base64-alphabet run NOT under an image key keeps full weight', async () => {
    const p = join(dir, 'hexdump.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    // e.g. a hex dump / minified blob inside ordinary tool-result text.
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + `{"content":"${b64(1 * MB)}"}\n`);
    // Full weight ≈ 1MB/4 ≈ 262k — no discount.
    expect((await tokensFromFileSize(p))!).toBeGreaterThan(250_000);
  });

  it('a sub-1MB screenshot-carrying file is scanned (fast path lowered to 256KB)', async () => {
    const p = join(dir, 'small-with-image.jsonl');
    const img = `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${b64(700_000)}"}}\n`;
    writeFileSync(p, 'b'.repeat(50_000) + img);
    const tokens = (await tokensFromFileSize(p))!;
    // Old fast path would have read ~187k (750KB/4) — enough to trip a
    // 200k-window force threshold; discounted it is ~12.5k + 1600.
    expect(tokens).toBeLessThan(30_000);
  });

  it('uses the injected async filesystem for bounded transcript scans', async () => {
    const p = join(dir, 'async-io.jsonl');
    writeFileSync(p, 'x'.repeat(MB));
    const fileOps: Pick<typeof fs.promises, 'stat' | 'open'> = {
      stat: fs.promises.stat,
      open: fs.promises.open,
    };
    const stat = vi.spyOn(fileOps, 'stat');
    const open = vi.spyOn(fileOps, 'open');
    const tokens = await tokensFromFileSize(p, fileOps);

    expect(tokens).toBeGreaterThan(0);
    expect(stat).toHaveBeenCalledWith(p);
    expect(open).toHaveBeenCalledWith(p, 'r');
  });
});

describe('resolveSessionRefReconciled — rung 4: unlogged native-session transitions (WI-5650 / WI-5075)', () => {
  const OWNER = 'su-8e9c1164-aa6e-4302-b78d-b03c7c86ae0a';
  const claudeRef = (sessionId: string) => async () => ({ agent: 'claude', sessionId });
  const never = () => {
    throw new Error('should not be consulted');
  };

  it('rung 4 corrects a stale DB ref to the newest ACTIVELY-WRITTEN transcript when the respawn log is silent', async () => {
    // The 2026-07-20 su-8e9c1164 case: DB + respawn log both froze at an early id
    // while a later transcript was written via an unlogged (service-restart) path.
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: claudeRef('de49cf4e-stale'),
      latestRespawn: () => null, // no `respawned` event since host start
      newestTranscript: () => '/iso/su/projects/proj/c95d04fe-current.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({ agent: 'claude', sessionId: 'c95d04fe-current' });
  });

  it('rung 4 also corrects when the respawn log AGREES with the stale DB ref (both frozen)', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: claudeRef('de49cf4e-stale'),
      latestRespawn: () => 'de49cf4e-stale', // log names the SAME stale id
      newestTranscript: () => '/iso/c95d04fe-current.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({ agent: 'claude', sessionId: 'c95d04fe-current' });
  });

  it('rung 3 WINS over rung 4 — a just-respawned idle successor is never re-pinned to its dead predecessor', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: claudeRef('predecessor'),
      latestRespawn: () => 'successor', // host log named the successor (no transcript yet)
      newestTranscript: () => '/iso/predecessor.jsonl', // predecessor is still newest on disk, fresh
      isFresh: () => true,
    });
    expect(out).toEqual({ agent: 'claude', sessionId: 'successor' });
  });

  it('does not let an older respawn event override a newer adv-session ref', async () => {
    // Live WI-2143790 chronology: the host event named cb3e6dba on 2026-09-03,
    // while the current adv row was started/rebound as 1b5b38ae on 2026-09-04.
    // The event is valid for that host but cannot be newer than this DB ref.
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => ({
        agent: 'claude',
        sessionId: '1b5b38ae-current',
        startedAtMs: Date.parse('2026-09-04T15:02:05.756Z'),
      }),
      latestRespawn: () => 'cb3e6dba-stale',
      latestRespawnInfo: () => ({
        nativeId: 'cb3e6dba-stale',
        atMs: Date.parse('2026-09-03T13:25:33.769Z'),
      }),
      newestTranscript: () => '/iso/1f22e935-current.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({ agent: 'claude', sessionId: '1f22e935-current', startedAtMs: Date.parse('2026-09-04T15:02:05.756Z') });
  });

  it('still lets a timestamped respawn event win over the predecessor when it is newer than the DB ref', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => ({
        agent: 'claude',
        sessionId: 'predecessor',
        startedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
      }),
      latestRespawn: () => 'successor',
      latestRespawnInfo: () => ({
        nativeId: 'successor',
        atMs: Date.parse('2026-09-03T13:25:33.769Z'),
      }),
      newestTranscript: () => '/iso/predecessor.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({
      agent: 'claude',
      sessionId: 'successor',
      startedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
    });
  });

  it('does NOT override when the newest transcript is STALE/frozen (a dead predecessor)', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: claudeRef('live-id'),
      latestRespawn: () => null,
      newestTranscript: () => '/iso/some-frozen.jsonl',
      isFresh: () => false, // >10min old ⇒ not the live session
    });
    expect(out).toEqual({ agent: 'claude', sessionId: 'live-id' });
  });

  it('does NOT override when the newest transcript already matches the DB ref', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: claudeRef('cur'),
      latestRespawn: () => null,
      newestTranscript: () => '/iso/cur.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({ agent: 'claude', sessionId: 'cur' });
  });

  it('leaves omp/codex refs untouched (rotation is claude-only) without consulting the FS', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => ({ agent: 'omp', sessionId: 'omp-thread' }),
      latestRespawn: never,
      newestTranscript: never,
      isFresh: never,
    });
    expect(out).toEqual({ agent: 'omp', sessionId: 'omp-thread' });
  });

  it('recovers a missing adv_sessions row from the owner event and marks the transcript owner unanchored', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => null,
      latestRespawn: (_owner, opts) => {
        expect(opts).toEqual({ allowWithoutHost: true });
        return '21dfdd94-current';
      },
      newestTranscript: never,
      isFresh: never,
    });
    expect(out).toEqual({
      agent: 'claude',
      sessionId: '21dfdd94-current',
      sessionKey: null,
      transcriptOwner: null,
    });
  });

  it('recovers a missing adv_sessions row from a fresh owner-local transcript when no event exists', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => null,
      latestRespawn: () => null,
      newestTranscript: () => '/iso/current-owner-native.jsonl',
      isFresh: () => true,
    });
    expect(out).toEqual({
      agent: 'claude',
      sessionId: 'current-owner-native',
      sessionKey: null,
      transcriptOwner: OWNER,
    });
  });

  it('returns null when the DB has no session ref AND neither reconciliation rung has evidence', async () => {
    const out = await resolveSessionRefReconciled(OWNER, {
      resolveRef: async () => null,
      latestRespawn: never,
      newestTranscript: never,
      isFresh: never,
    });
    expect(out).toBeNull();
  });
});

describe('newestTranscriptUnderOwner (P-016 resume-rotation / dark-cohort fallback)', () => {
  const base = mkdtempSync(join(tmpdir(), 'compaction-owner-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const OWNER = 'su-11111111-2222-3333-4444-555555555555';
  const projDir = join(base, OWNER, 'projects', '-home-x-papercusp');

  it('picks the NEWEST session *.jsonl under the owner root, ignoring history.jsonl', () => {
    mkdirSync(projDir, { recursive: true });
    const older = join(projDir, 'aaaa1111-1111-1111-1111-111111111111.jsonl');
    const newer = join(projDir, 'bbbb2222-2222-2222-2222-222222222222.jsonl');
    const hist = join(projDir, 'history.jsonl');
    writeFileSync(older, 'x');
    writeFileSync(newer, 'y');
    writeFileSync(hist, 'z'.repeat(4096)); // bigger + newest mtime, but must be excluded
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    utimesSync(hist, new Date(3_000_000), new Date(3_000_000));
    expect(newestTranscriptUnderOwner(OWNER, base)).toBe(newer);
  });

  it('returns null when the owner root holds no session transcript', () => {
    expect(newestTranscriptUnderOwner('su-99999999-0000-0000-0000-000000000000', base)).toBeNull();
  });

  it('refuses a path-escaping owner id', () => {
    expect(newestTranscriptUnderOwner('../../etc', base)).toBeNull();
    expect(newestTranscriptUnderOwner('a/b', base)).toBeNull();
  });
});

describe('fallbackTranscriptFresh (the P-016 fallback freshness gate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-fresh-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a recently-written transcript (the live stale-session_id case P-016 targets)', () => {
    const p = join(dir, 'live.jsonl');
    writeFileSync(p, 'x');
    expect(fallbackTranscriptFresh(p)).toBe(true);
  });

  it('rejects a transcript frozen longer than the freshness window — a dead predecessor must not be read against its idle successor', () => {
    const p = join(dir, 'dead-predecessor.jsonl');
    writeFileSync(p, 'x'.repeat(1024));
    const frozenAt = new Date(Date.now() - 11 * 60_000);
    utimesSync(p, frozenAt, frozenAt);
    expect(fallbackTranscriptFresh(p)).toBe(false);
  });

  it('a boundary-fresh file stays accepted under an injected clock', () => {
    const p = join(dir, 'boundary.jsonl');
    writeFileSync(p, 'x');
    const mtime = statSync(p).mtimeMs;
    expect(fallbackTranscriptFresh(p, mtime + 9 * 60_000)).toBe(true);
    expect(fallbackTranscriptFresh(p, mtime + 11 * 60_000)).toBe(false);
  });

  it('fail-soft false on a missing path (never throws)', () => {
    expect(fallbackTranscriptFresh(join(dir, 'nope.jsonl'))).toBe(false);
  });
});

// per-member-declarative-launch-specs P-005: the explicit per-member compaction
// limit rides the recorded launch argv (a psu session has no spawned_agents row,
// and adv_sessions.launch_argv is already this seeding path's per-session truth).
// The DB read is integration-covered; this pins the PARSING contract.
describe('parseLaunchCompactionLimitArgv (psu --compaction-limit off the recorded argv)', () => {
  it('reads the = form psu emits', () => {
    expect(parseLaunchCompactionLimitArgv(['psu', '--no-picker', '--compaction-limit=200000'])).toBe(200_000);
  });

  it('reads the space form a hand-composed argv may use', () => {
    expect(parseLaunchCompactionLimitArgv(['psu', '--compaction-limit', '150000'])).toBe(150_000);
  });

  it('returns null when the launch named no limit (the common case)', () => {
    expect(parseLaunchCompactionLimitArgv(['psu', '--no-picker', '--model=opus[1m]'])).toBeNull();
  });

  it('degrades to null on a non-array / absent argv rather than throwing', () => {
    expect(parseLaunchCompactionLimitArgv(null)).toBeNull();
    expect(parseLaunchCompactionLimitArgv(undefined)).toBeNull();
    expect(parseLaunchCompactionLimitArgv('--compaction-limit=200000')).toBeNull();
  });

  it('DROPS a malformed value instead of coercing it — the model default is the safe read', () => {
    expect(parseLaunchCompactionLimitArgv(['psu', '--compaction-limit=lots'])).toBeNull();
    expect(parseLaunchCompactionLimitArgv(['psu', '--compaction-limit=-5'])).toBeNull();
    expect(parseLaunchCompactionLimitArgv(['psu', '--compaction-limit='])).toBeNull();
  });

  it('does not treat a --compaction-limit with no following token as a match', () => {
    expect(parseLaunchCompactionLimitArgv(['psu', '--compaction-limit'])).toBeNull();
  });

  it('ignores non-string argv entries (launch_argv is JSON — it can hold anything)', () => {
    expect(parseLaunchCompactionLimitArgv([1, null, { a: 1 }, '--compaction-limit=90000'])).toBe(90_000);
  });
});

/**
 * WI-42507 — the adv ROW and the codex HOME its native session writes into can come
 * apart, so a home-keyed read serves a stranger's transcript. The repair follows the
 * ref's own session id into a sibling home, but only ever ONTO A FRESHER FILE.
 *
 * The negative cases below are the point of this block: each is a way the repair could
 * have reintroduced WI-38090 (pinning a live session to a dead predecessor's frozen
 * rollout) by the other door.
 */
describe('resolveCodexRolloutPathForRef (WI-42507 — row/home identity mismatch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-mismatch-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const SID = '01a04287-e5a2-4c1e-9f30-2b7d5a6c8e11';
  const OTHER_SID = 'ff9c1234-aaaa-4bbb-8ccc-0123456789ab';

  const aged = (p: string, ageMs: number): string => {
    writeFileSync(p, '{}\n');
    const when = new Date(Date.now() - ageMs);
    utimesSync(p, when, when);
    return p;
  };

  /** The real filename shape the repair parses, so codexRolloutSessionId() sees `sid`. */
  const namedRollout = (sid: string, ageMs: number): string =>
    aged(join(dir, `rollout-2026-08-27T09-00-00-${sid}.jsonl`), ageMs);

  /** A sibling-home hit. Its name is never parsed — findCodexRolloutByUuid vouches for it. */
  const siblingRollout = (label: string, ageMs: number): string =>
    aged(join(dir, `sibling-${label}.jsonl`), ageMs);

  const ref = { agent: 'codex', sessionId: SID, sessionKey: 19845 };

  it('keeps the keyed home and never searches siblings when it already holds the ref session', async () => {
    const keyed = namedRollout(SID, 1_000);
    const siblings = vi.fn(async () => [19993]);
    const byUuid = vi.fn(async () => siblingRollout('unused', 0));

    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => keyed,
        codexSiblingSessionKeys: siblings,
        findCodexRolloutByUuid: byUuid,
      }),
    ).resolves.toBe(keyed);
    // The healthy majority must pay NO extra I/O — this is what keeps the repair off
    // the watchdog's hot path.
    expect(siblings).not.toHaveBeenCalled();
    expect(byUuid).not.toHaveBeenCalled();
  });

  it('follows the ref session into a sibling home when the keyed home holds only a frozen stranger', async () => {
    // The measured pathology: row 19845's home held nothing but 03:14–03:39 rollouts
    // belonging to a different session, while SID was actively writing under 19993.
    const frozenStranger = namedRollout(OTHER_SID, 99 * 60_000);
    const liveElsewhere = siblingRollout('live', 5_000);

    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => frozenStranger,
        codexSiblingSessionKeys: async () => [19993],
        findCodexRolloutByUuid: async () => liveElsewhere,
      }),
    ).resolves.toBe(liveElsewhere);
  });

  it('REFUSES to move onto the ref session when it is OLDER than the keyed home (WI-38090 guard)', async () => {
    // A ref naming a DEAD predecessor whose rollout happens to sit in a sibling home.
    // Without the strictly-fresher rule the repair would drag the reading BACKWARDS
    // onto that frozen file — exactly the pathology it exists to remove.
    const liveKeyed = namedRollout(OTHER_SID, 2_000);
    const deadElsewhere = siblingRollout('dead', 90 * 60_000);

    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => liveKeyed,
        codexSiblingSessionKeys: async () => [19993],
        findCodexRolloutByUuid: async () => deadElsewhere,
      }),
    ).resolves.toBe(liveKeyed);
  });

  it('keeps the keyed home on an mtime TIE (the strict boundary of "strictly fresher")', async () => {
    // Third point of the falsifiability triple. With the two tests above this pins the
    // comparison exactly, so no mutation of that one line survives: `>` → `>=` breaks
    // THIS test, `> ` → `true` breaks the WI-38090 guard, `> ` → `false` breaks the
    // follows-into-sibling case. A tie means neither file is newer, so there is no
    // evidence to move on and the incumbent keeps it.
    const keyed = namedRollout(OTHER_SID, 5_000);
    const tied = siblingRollout('tied', 5_000);
    const sameMtime = () => 1_700_000_000_000;

    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => keyed,
        codexSiblingSessionKeys: async () => [19993],
        findCodexRolloutByUuid: async () => tied,
        statMtimeMs: sameMtime,
      }),
    ).resolves.toBe(keyed);
  });

  it('adopts a sibling rollout when the keyed home has NOTHING — but only a fresh one', async () => {
    const fresh = siblingRollout('fresh', 5_000);
    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => null,
        codexSiblingSessionKeys: async () => [19993],
        findCodexRolloutByUuid: async () => fresh,
      }),
    ).resolves.toBe(fresh);
  });

  it('degrades to null rather than adopt a STALE sibling when the keyed home has nothing', async () => {
    // Null is not a failure here: it degrades to the watchdog's dark-telemetry grace,
    // whereas a frozen number is the input that drives respawn-streak suppression.
    const stale = siblingRollout('stale', 90 * 60_000);
    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => null,
        codexSiblingSessionKeys: async () => [19993],
        findCodexRolloutByUuid: async () => stale,
      }),
    ).resolves.toBeNull();
  });

  it('returns the keyed answer unchanged when no sibling holds the ref session', async () => {
    const keyed = namedRollout(OTHER_SID, 1_000);
    await expect(
      resolveCodexRolloutPathForRef(ref, 'su-e602814a', {
        findCodexRollout: async () => keyed,
        codexSiblingSessionKeys: async () => [19993, 20001],
        findCodexRolloutByUuid: async () => null,
      }),
    ).resolves.toBe(keyed);
  });

  it('cannot check without a ref session id or an owner, so it leaves the keyed answer alone', async () => {
    const keyed = namedRollout(OTHER_SID, 1_000);
    const siblings = vi.fn(async () => [19993]);
    const deps = { findCodexRollout: async () => keyed, codexSiblingSessionKeys: siblings };

    // A codex row with no native session_id is the DOCUMENTED normal state, not an anomaly.
    await expect(
      resolveCodexRolloutPathForRef({ agent: 'codex', sessionId: null, sessionKey: 19845 }, 'su-x', deps),
    ).resolves.toBe(keyed);
    await expect(resolveCodexRolloutPathForRef(ref, null, deps)).resolves.toBe(keyed);
    expect(siblings).not.toHaveBeenCalled();
  });

  it('returns null for a ref with no session key at all', async () => {
    await expect(
      resolveCodexRolloutPathForRef({ agent: 'codex', sessionId: SID, sessionKey: null }, 'su-x', {}),
    ).resolves.toBeNull();
  });
});
