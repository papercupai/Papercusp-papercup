/**
 * EI-13120: on a clustered operator, `sessionRespawned`'s `clearContextAnchor` clears
 * only the ONE worker process that happened to handle that MCP call — every sibling
 * worker's in-process anchor Map never learns the pre-respawn transcript died, so
 * (pre-fix) `advanceAnchor`'s "file size unchanged ⇒ ok" fast path replayed the frozen
 * pre-respawn/pre-compaction reading FOREVER on any request that routed to one of
 * those siblings (a fresh post-compaction wake re-reporting the byte-identical
 * pre-compaction token count — the exact live symptom this work item was filed from).
 *
 * These tests exercise the periodic path re-verify added to `currentContextTokensForOwner`
 * (and the sync variant's background-kick counterpart): DB/fs resolution is mocked so we
 * control what "the live transcript" resolves to, independent of the anchor's own state.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, findSessionTranscriptMock, newestTranscriptUnderOwnerMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  findSessionTranscriptMock: vi.fn(),
  newestTranscriptUnderOwnerMock: vi.fn(() => null as string | null),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('./claude-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-sessions')>();
  return {
    ...actual,
    findSessionTranscript: findSessionTranscriptMock,
    newestTranscriptUnderOwner: newestTranscriptUnderOwnerMock,
  };
});

import {
  currentContextTokensForOwner,
  currentContextTokensSyncForOwner,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
  tokensFromFileSize,
} from './compaction-usage';

const PATH_REVERIFY_MS = 30_000; // mirrors the private constant in compaction-usage.ts

let dir: string;
let predecessorFile: string;
let n = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ agent: 'claude', session_id: 'successor-session' }]);
  findSessionTranscriptMock.mockResolvedValue(null);
  newestTranscriptUnderOwnerMock.mockReturnValue(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-reverify-test-'));
  predecessorFile = path.join(dir, `${++n}-predecessor.jsonl`);
});

afterEach(() => {
  resetContextAnchorsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A complete JSONL line of exactly `bytes` bytes (ASCII only). */
function line(bytes: number, fill = 'x'): string {
  const overhead = '{"t":""}\n'.length;
  return `{"t":"${fill.repeat(bytes - overhead)}"}\n`;
}

describe('EI-13120: periodic path re-verify bounds a cross-process-stale anchor', () => {
  it('within the re-verify window, a dead-but-unchanged predecessor anchor is trusted as-is (no DB hit)', async () => {
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens
    seedContextAnchorForTests('owner-fresh', predecessorFile);
    expect(currentContextTokensSyncForOwner('owner-fresh')).toBe(350_000);
    vi.advanceTimersByTime(PATH_REVERIFY_MS - 1_000);
    expect(await currentContextTokensForOwner('owner-fresh')).toBe(350_000);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('past the re-verify window, a dead predecessor anchor is DETECTED and reseeds onto the confirmed-live successor file (async path)', async () => {
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens — CRITICAL-band
    seedContextAnchorForTests('owner-stale', predecessorFile);
    expect(await currentContextTokensForOwner('owner-stale')).toBe(350_000);

    const successorFile = path.join(dir, 'successor.jsonl');
    fs.writeFileSync(successorFile, line(4_000)); // 1k tokens — the real, current usage
    findSessionTranscriptMock.mockResolvedValue(successorFile);

    // Cross the re-verify TTL without the predecessor file changing size (it's dead —
    // the killed process never writes to it again).
    vi.advanceTimersByTime(PATH_REVERIFY_MS + 1_000);

    const tokens = await currentContextTokensForOwner('owner-stale');
    // Pre-fix this stayed frozen at 350_000 forever (EI-12966's documented bug, now
    // additionally bounded by this re-verify instead of persisting for the rest of
    // the process's life). Post-fix it self-corrects to the successor's real reading.
    expect(tokens).toBe(await tokensFromFileSize(successorFile));
    expect(tokens).not.toBe(350_000);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('a resolution blip (DB/fs failure) fails OPEN on the existing anchor rather than flapping to null', async () => {
    fs.writeFileSync(predecessorFile, line(400_000)); // 100k tokens
    seedContextAnchorForTests('owner-blip', predecessorFile);
    expect(await currentContextTokensForOwner('owner-blip')).toBe(100_000);

    sqlMock.mockRejectedValue(new Error('pg unreachable'));
    vi.advanceTimersByTime(PATH_REVERIFY_MS + 1_000);

    // resolveSessionRef swallows the DB error internally and returns null; the
    // re-verify then treats "couldn't resolve" as fail-open, not fail-null.
    expect(await currentContextTokensForOwner('owner-blip')).toBe(100_000);
  });

  // WI-10001513 RETARGETED this test. It previously asserted that the past-TTL sync
  // call returns the "bounded-stale" reading (350_000) — which encoded the DEFECT as
  // intended behaviour: 350_000 is the dead predecessor's CRITICAL-band number, and
  // handing it to a fresh successor is what made agents consider re-compacting with no
  // work done. An unproven anchor now renders NOTHING. The reseed-and-self-correct half
  // of the original contract is unchanged and still asserted below.
  it('the sync path DECLINES past TTL (unproven ⇒ no number) but kicks a background reseed that self-corrects the NEXT call', async () => {
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens
    seedContextAnchorForTests('owner-sync', predecessorFile);
    expect(currentContextTokensSyncForOwner('owner-sync')).toBe(350_000);

    const successorFile = path.join(dir, 'successor-sync.jsonl');
    fs.writeFileSync(successorFile, line(4_000));
    findSessionTranscriptMock.mockResolvedValue(successorFile);

    vi.advanceTimersByTime(PATH_REVERIFY_MS + 1_000);
    // Past the TTL this process can no longer prove the anchor names the owner's live
    // transcript, so it renders nothing rather than a possibly-stale number...
    expect(currentContextTokensSyncForOwner('owner-sync')).toBeNull();
    // ...but kicked a background async reseed. The reseed awaits real async fs
    // (tokensFromFileSize is async), which settles on the libuv loop rather than the
    // microtask queue, so a single advanceTimersByTimeAsync(0) can return first.
    // Poll until it lands; the anchor is then corrected for every subsequent
    // caller (sync or async) on this process.
    const expected = await tokensFromFileSize(successorFile);
    await vi.waitFor(() => {
      expect(sqlMock).toHaveBeenCalled();
      expect(currentContextTokensSyncForOwner('owner-sync')).toBe(expected);
    });
  });
});
