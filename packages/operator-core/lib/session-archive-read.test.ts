/**
 * Archive fall-through reader tests (session-db-archive-retire-dirs P-009):
 * an archived-then-deleted session stays readable — decompressed, re-parsed
 * with the ingest parsers, and re-capped/redacted exactly like the index.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchivedSessionTurns, readLiveSessionTurns } from './session-archive-read';
import {
  archiveAndDeleteSession,
  archiveSession,
  SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES,
  type ArchiveFileRow,
  type ArchiveStampRow,
  type SessionArchiveStore,
} from './session-archive';

const SID = '99999999-1111-2222-3333-444444444444';
// Built at runtime so the repo's secrets-guard never sees a key-shaped literal
// in tree bytes; still matches the ingest SECRET_RE (sk- + 16+ word chars).
const FAKE_SECRET = ['sk', 'fixture0123456789abcdef'].join('-');

class MiniStore implements SessionArchiveStore {
  files: ArchiveFileRow[] = [];
  stamps = new Map<string, ArchiveStampRow>();
  parsingOffset: number | null = null;
  async readTurnParsingOffset(): Promise<number | null> { return this.parsingOffset; }
  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    this.files = files;
    this.stamps.set(`${stamp.source_kind}:${stamp.session_id}`, stamp);
  }
  async readStamp(kind: string, id: string): Promise<ArchiveStampRow | null> {
    return this.stamps.get(`${kind}:${id}`) ?? null;
  }
  async readFiles(kind: string, id: string): Promise<ArchiveFileRow[]> {
    return this.files.filter((f) => f.source_kind === kind && f.session_id === id);
  }
  async stampAdvSessionArchived(): Promise<void> {}
}

let tmp: string | null = null;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('readArchivedSessionTurns', () => {
  it.each(['legacy', 'new', 'mixed'] as const)('keeps canonical indexes in a %s short-decision archive', async (mode) => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-short-decisions-'));
    const root = join(tmp, 'sessions', '2026', '10', '08');
    await mkdir(root, { recursive: true });
    const message = (text: string, role = 'user') => JSON.stringify({
      type: 'response_item', timestamp: '2026-10-08T01:10:19.604Z',
      payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
    });
    const prefix = `${message('original request é')}\n${message('A')}\n`;
    const raw = `${prefix}${message('B')}\n${message('after decision', 'assistant')}\n`;
    await writeFile(join(root, `rollout-${SID}.jsonl`), raw);
    const store = new MiniStore();
    store.parsingOffset = mode === 'legacy' ? null : mode === 'new' ? 0 : Buffer.byteLength(prefix);
    const expectedOffset = store.parsingOffset;
    expect((await archiveSession({ sourceKind: 'codex', sessionId: SID, sessionRoot: tmp }, store)).ok).toBe(true);
    // The bounded ingest-state ledger can be pruned before a repeat snapshot.
    store.parsingOffset = null;
    const result = await archiveAndDeleteSession({ sourceKind: 'codex', sessionId: SID, sessionRoot: tmp }, store);
    expect(result.archive.ok).toBe(true);
    expect(store.files).toHaveLength(1);
    const manifest = store.stamps.get(`codex:${SID}`)!.manifest[0];
    expect(manifest.short_user_turns_offset ?? null).toBe(expectedOffset);
    const archived = await readArchivedSessionTurns(SID, 'codex', store);
    const expected = mode === 'legacy' ? ['original request é', 'after decision']
      : mode === 'new' ? ['original request é', 'A', 'B', 'after decision']
        : ['original request é', 'B', 'after decision'];
    expect(archived?.errors).toEqual([]);
    expect(archived?.turns.map((turn) => turn.text)).toEqual(expected);
    expect(archived?.turns.map((turn) => turn.turn_idx)).toEqual(expected.map((_, index) => index));
    const selected = await readArchivedSessionTurns(SID, 'codex', store, { turnIndices: [1], fullSource: true });
    expect(selected?.turns).toHaveLength(1);
    expect(selected?.turns[0]).toMatchObject({ turn_idx: 1, text: expected[1] });
  });

  it('reads turns from a deleted, archived claude session — capped + redacted like the index', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-read-'));
    await mkdir(join(tmp, 'projects', '-repo'), { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'please fix the provenance stamp in the ingest pipeline' },
        timestamp: '2026-07-10T01:00:00.000Z',
        cwd: '/repo',
        sessionId: SID,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning that must not surface' },
            { type: 'text', text: `Root cause found: the API key ${FAKE_SECRET} was hardcoded.` },
          ],
        },
        timestamp: '2026-07-10T01:00:05.000Z',
        cwd: '/repo',
        sessionId: SID,
      }),
      'not-json garbage line', // resilience: one bad line never kills the read
    ].join('\n');
    await writeFile(join(tmp, 'projects', '-repo', `${SID}.jsonl`), lines + '\n');

    const store = new MiniStore();
    const r = await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: tmp }, store);
    expect(r.archive.ok).toBe(true);
    expect(r.delete?.deleted).toBe(1);

    const arch = await readArchivedSessionTurns(SID, undefined, store);
    expect(arch).not.toBeNull();
    expect(arch!.sourceKind).toBe('claude');
    expect(arch!.turns.length).toBe(2);
    expect(arch!.turns[0]).toMatchObject({ turn_idx: 0, speaker: 'user' });
    expect(arch!.turns[0].ts).toBe('2026-07-10T01:00:00.000Z');
    // ingest-equivalent hygiene: thinking dropped, secrets redacted
    const assistant = arch!.turns[1].text;
    expect(assistant).not.toContain('private reasoning');
    expect(assistant).not.toContain(FAKE_SECRET);
    expect(assistant).toContain('[redacted]');
    expect(assistant).toContain('Root cause found');
  });

  it('recovers a full redacted turn beyond the index cap and can retain only requested indexes', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-read-codex-full-'));
    const root = join(tmp, 'sessions', '2026', '10', '01');
    await mkdir(root, { recursive: true });
    const secret = `token=${FAKE_SECRET} `;
    const suffix = 'tail-sentinel';
    const sourceText = `${secret}${'x'.repeat(9_572 - secret.length - suffix.length)}${suffix}`;
    expect(sourceText).toHaveLength(9_572);
    const line = JSON.stringify({
      timestamp: '2026-10-01T21:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: sourceText }],
      },
    });
    await writeFile(join(root, `rollout-2026-10-01T21-00-00-${SID}.jsonl`), `${line}\n`);

    const store = new MiniStore();
    await archiveAndDeleteSession({ sourceKind: 'codex', sessionId: SID, sessionRoot: tmp, owner: 'owner-a' }, store);

    const indexed = await readArchivedSessionTurns(SID, 'codex', store);
    expect(indexed?.turns[0]?.text.length).toBeLessThan(8_000);
    expect(indexed?.turns[0]?.text).not.toContain(FAKE_SECRET);
    const full = await readArchivedSessionTurns(SID, 'codex', store, { fullSource: true, turnIndices: [0] });
    expect(full?.errors).toEqual([]);
    expect(full?.turns).toHaveLength(1);
    expect(full?.turns[0]).toMatchObject({ turn_idx: 0, speaker: 'assistant' });
    expect(full?.turns[0]?.text).toContain('[redacted]');
    expect(full?.turns[0]?.text).not.toContain(FAKE_SECRET);
    expect(full?.turns[0]?.text).toContain(suffix);
    expect(full?.turns[0]?.text.length).toBeGreaterThan(8_000);
  });

  it('reads a live capped turn from the source file before archive-at-death', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-live-read-'));
    const sourceText = `token=${FAKE_SECRET} ${'x'.repeat(9_572 - FAKE_SECRET.length - 7)}tail-sentinel`;
    const line = JSON.stringify({
      timestamp: '2026-10-16T08:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: sourceText }],
      },
    });
    const sourcePath = join(tmp, 'live-rollout.jsonl');
    await writeFile(sourcePath, `${line}\n`);

    const live = await readLiveSessionTurns(sourcePath, 'codex', 'owner-a', {
      fullSource: true,
      turnIndices: [0],
    });
    expect(live?.errors).toEqual([]);
    expect(live?.turns).toHaveLength(1);
    expect(live?.turns[0]).toMatchObject({
      turn_idx: 0,
      owner: 'owner-a',
      speaker: 'assistant',
    });
    expect(live?.turns[0]?.text).toContain('tail-sentinel');
    expect(live?.turns[0]?.text).toContain('[redacted]');
    expect(live?.turns[0]?.text).not.toContain(FAKE_SECRET);
    expect(live?.turns[0]?.text.length).toBeGreaterThan(8_000);
  });

  it('rejects an archive whose declared raw bytes exceed the decompression budget', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-read-codex-bound-'));
    const root = join(tmp, 'sessions', '2026', '10', '01');
    await mkdir(root, { recursive: true });
    const line = JSON.stringify({
      timestamp: '2026-10-01T21:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'bounded source turn' }] },
    });
    await writeFile(join(root, `rollout-2026-10-01T21-00-00-${SID}.jsonl`), `${line}\n`);
    const store = new MiniStore();
    await archiveAndDeleteSession({ sourceKind: 'codex', sessionId: SID, sessionRoot: tmp }, store);
    const row = store.files[0]!;
    row.bytes_raw = SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES + 1;

    const result = await readArchivedSessionTurns(SID, 'codex', store);
    expect(result?.turns).toEqual([]);
    expect(result?.errors).toEqual([expect.objectContaining({ error: expect.stringContaining('raw-byte limit') })]);
  });

  it('returns null when nothing is archived under any kind', async () => {
    expect(await readArchivedSessionTurns('no-such-session', undefined, new MiniStore())).toBeNull();
  });

  it('skips a corrupt Codex archive file, keeps healthy files, and reports the path/error', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-read-codex-'));
    const first = join(tmp, 'sessions', '2026', '07', '10');
    const second = join(tmp, 'sessions', '2026', '07', '11');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const healthyRelpath = join(
      'sessions',
      '2026',
      '07',
      '10',
      `rollout-2026-07-10T01-00-00-${SID}.jsonl`,
    );
    const corruptRelpath = join(
      'sessions',
      '2026',
      '07',
      '11',
      `rollout-2026-07-11T01-00-00-${SID}.jsonl`,
    );
    const codexLine = JSON.stringify({
      timestamp: '2026-07-10T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'healthy Codex archive turn' }],
      },
    });
    await writeFile(join(tmp, healthyRelpath), `${codexLine}\n`);
    await writeFile(join(tmp, corruptRelpath), `${codexLine}\n`);

    const store = new MiniStore();
    const archived = await archiveAndDeleteSession(
      { sourceKind: 'codex', sessionId: SID, sessionRoot: tmp, owner: 'owner-a' },
      store,
    );
    expect(archived.archive.ok).toBe(true);
    const corrupt = store.files.find((row) => row.relpath === corruptRelpath);
    expect(corrupt).toBeDefined();
    corrupt!.blob = Buffer.from('not-a-zstd-frame');

    const result = await readArchivedSessionTurns(SID, 'codex', store);
    expect(result).toMatchObject({
      sourceKind: 'codex',
      owner: 'owner-a',
      turns: [expect.objectContaining({ text: 'healthy Codex archive turn' })],
      errors: [{ path: corruptRelpath }],
    });
    expect(result!.turns).toHaveLength(1);
    expect(result!.errors[0]!.error).toBeTruthy();
  });
});
