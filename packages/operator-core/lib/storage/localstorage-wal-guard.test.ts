import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true),
  broadcastSevereEventResolved: vi.fn(async () => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [],
  computeConditionStates: () => [],
  readLatestConditionEnvelope: async () => null,
}));
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  planWalCheckpoints,
  discoverWalCandidates,
  checkpointOne,
  runWalCheckpointSweep,
  runWalCheckpointGuard,
  DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES,
  type WalCandidate,
} from './localstorage-wal-guard';

const MB = 1024 * 1024;

function cand(p: Partial<WalCandidate> & { walPath: string }): WalCandidate {
  return { dbPath: p.walPath.replace(/-wal$/, ''), sizeBytes: 0, ...p };
}

describe('planWalCheckpoints (pure)', () => {
  it('filters out anything below the threshold', () => {
    const out = planWalCheckpoints(
      [cand({ walPath: '/a-wal', sizeBytes: 10 * MB }), cand({ walPath: '/b-wal', sizeBytes: 300 * MB })],
      200 * MB,
    );
    expect(out.map((c) => c.walPath)).toEqual(['/b-wal']);
  });

  it('sorts survivors largest-first', () => {
    const out = planWalCheckpoints(
      [
        cand({ walPath: '/small-wal', sizeBytes: 250 * MB }),
        cand({ walPath: '/huge-wal', sizeBytes: 900 * MB }),
        cand({ walPath: '/mid-wal', sizeBytes: 500 * MB }),
      ],
      200 * MB,
    );
    expect(out.map((c) => c.walPath)).toEqual(['/huge-wal', '/mid-wal', '/small-wal']);
  });

  it('defaults to DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES (200MB) when unset', () => {
    expect(DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES).toBe(200 * MB);
    const out = planWalCheckpoints([
      cand({ walPath: '/under-wal', sizeBytes: 199 * MB }),
      cand({ walPath: '/over-wal', sizeBytes: 201 * MB }),
    ]);
    expect(out.map((c) => c.walPath)).toEqual(['/over-wal']);
  });

  it('empty input → empty output', () => {
    expect(planWalCheckpoints([])).toEqual([]);
  });
});

describe('discoverWalCandidates (real fs)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds only *.localstorage-wal files, skipping other extensions and dirs', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-disc-'));
    // NB: keep the connection OPEN (never .close()) — SQLite auto-checkpoints
    // (and removes) the WAL when the last connection closes cleanly, which
    // would defeat the point of this fixture. A real WebKit process never
    // closes its connection either, which is exactly the scenario this guard
    // exists for.
    const db = new DatabaseSync(join(dir, 'http_localhost_3070.localstorage'));
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE t (v TEXT);');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    // an unrelated file that must be ignored
    require('node:fs').writeFileSync(join(dir, 'notes.txt'), 'hi');

    const found = discoverWalCandidates([dir]);
    db.close();
    expect(found).toHaveLength(1);
    expect(found[0].walPath).toBe(join(dir, 'http_localhost_3070.localstorage-wal'));
    expect(found[0].dbPath).toBe(join(dir, 'http_localhost_3070.localstorage'));
    expect(found[0].sizeBytes).toBeGreaterThan(0);
  });

  it('a missing root is skipped, not thrown', () => {
    expect(discoverWalCandidates(['/definitely/not/here/' + Date.now()])).toEqual([]);
  });

  it('no roots given → empty (never throws)', () => {
    expect(discoverWalCandidates([])).toEqual([]);
  });
});

describe('checkpointOne (real sqlite)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims the WAL to (near) zero when nothing else holds a snapshot open', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-ckpt-'));
    const dbPath = join(dir, 'test.localstorage');
    // NB: keep the writer connection OPEN (idle, no explicit transaction) —
    // this is the realistic shape: WebKit never closes its connection either.
    // SQLite only blocks a TRUNCATE checkpoint on an ACTIVE txn/read snapshot,
    // not on a merely-open idle connection (verified — an idle open connection
    // does not prevent a full reclaim).
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE t (v TEXT);');
    const stmt = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 3000; i++) stmt.run('x'.repeat(2000));

    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const before = statSync(walPath).size;
    expect(before).toBeGreaterThan(1 * MB);

    const outcome = checkpointOne(dbPath);
    db.close();
    expect(outcome.ok).toBe(true);
    expect(outcome.walBytesBefore).toBe(before);
    // TRUNCATE mode with no active reader/writer reclaims fully.
    expect(outcome.walBytesAfter).toBe(0);
    expect(outcome.busy).toBe(false);
  });

  it('degrades gracefully (no throw, partial progress) when a reader holds an old snapshot open', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-busy-'));
    const dbPath = join(dir, 'busy.localstorage');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE t (v TEXT);');
    const stmt = writer.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 1000; i++) stmt.run('x'.repeat(2000));

    // A second connection holding a long-lived read transaction — the WebKit
    // reader-pins-the-WAL scenario the whole module exists to survive.
    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN;');
    reader.prepare('SELECT count(*) FROM t').get();

    for (let i = 0; i < 1000; i++) stmt.run('y'.repeat(2000));

    const outcome = checkpointOne(dbPath);
    expect(outcome.ok).toBe(true); // never throws under contention
    expect(outcome.busy).toBe(true);
    // Nothing corrupted, nothing lost — the file is still a valid, readable WAL.
    expect(reader.prepare('SELECT count(*) AS n FROM t').get()).toBeTruthy();

    reader.exec('COMMIT;');
    reader.close();
    writer.close();
  });

  it('refuses to open (and so never creates) a db path that does not exist', () => {
    const outcome = checkpointOne('/tmp/wal-guard-does-not-exist-' + Date.now() + '.db');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('db_file_missing');
    expect(existsSync('/tmp/wal-guard-does-not-exist-' + Date.now() + '.db')).toBe(false);
  });
});

describe('runWalCheckpointSweep (end-to-end, real fs + sqlite)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reports and alerts on an unreclaimed WAL without disturbing a live reader', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-retained-'));
    const dbPath = join(dir, 'busy.localstorage');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT);');
    const insert = writer.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 16; i++) insert.run('x'.repeat(4096));
    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN;');
    reader.prepare('SELECT count(*) FROM t').get();
    try {
      for (let i = 0; i < 128; i++) insert.run('y'.repeat(4096));
      const before = statSync(`${dbPath}-wal`).size;
      expect(before).toBeGreaterThan(MB);
      const result = runWalCheckpointSweep({ roots: [dir], thresholdBytes: MB });
      expect(result.checkpointed).toBe(1);
      expect(result.bytesReclaimed).toBe(0);
      expect(result.retained).toEqual([{ dbPath, walBytes: before, busy: true }]);
      const notify = vi.fn(async (_input: { title: string; body: string }) => {});
      const reported = await runWalCheckpointGuard({ roots: [dir], thresholdBytes: MB }, {
        notify, recentlyEscalated: async () => false,
      });
      expect(reported.escalated).toBe(true);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Desktop localStorage WAL not reclaimed',
        body: expect.stringContaining(`${dbPath}-wal`),
      }));
      expect(notify.mock.calls[0]?.[0].body).toContain('SQLite reported busy');
      const suppressed = await runWalCheckpointGuard({ roots: [dir], thresholdBytes: MB }, {
        notify, recentlyEscalated: async () => true,
      });
      expect(suppressed.escalated).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(reader.prepare('SELECT count(*) AS n FROM t').get()?.n).toBe(16);
      expect(writer.prepare('SELECT count(*) AS n FROM t').get()?.n).toBe(144);
    } finally {
      reader.exec('COMMIT;');
      reader.close();
      writer.close();
    }
  });

  it('does not alert after a successful checkpoint or an empty sweep', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-no-alert-'));
    const dbPath = join(dir, 'healthy.localstorage');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT);');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('healthy');
    const notify = vi.fn(async (_input: { title: string; body: string }) => {});
    try {
      const result = await runWalCheckpointGuard({ roots: [dir], thresholdBytes: 1 }, {
        notify, recentlyEscalated: async () => false,
      });
      expect(result.bytesReclaimed).toBeGreaterThan(0);
      expect(result.retained).toEqual([]);
      expect(result.escalated).toBe(false);
      expect(notify).not.toHaveBeenCalled();
      const empty = await runWalCheckpointGuard({ roots: [] }, { notify });
      expect(empty.escalated).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    } finally { writer.close(); }
  });

  it('checkpoints only the over-threshold db and reports bytes reclaimed', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-sweep-'));

    // Both connections stay OPEN (idle) through the sweep — see the note on
    // the checkpointOne test above for why closing early defeats the fixture.

    // A big WAL, over threshold.
    const bigDb = join(dir, 'big.localstorage');
    const big = new DatabaseSync(bigDb);
    big.exec('PRAGMA journal_mode=WAL;');
    big.exec('CREATE TABLE t (v TEXT);');
    const bigStmt = big.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 4000; i++) bigStmt.run('x'.repeat(2000));

    // A tiny WAL, under threshold — must be left untouched.
    const smallDb = join(dir, 'small.localstorage');
    const small = new DatabaseSync(smallDb);
    small.exec('PRAGMA journal_mode=WAL;');
    small.exec('CREATE TABLE t (v TEXT);');
    small.prepare('INSERT INTO t (v) VALUES (?)').run('x');

    const smallWalBefore = statSync(`${smallDb}-wal`).size;
    const bigWalBefore = statSync(`${bigDb}-wal`).size;
    expect(bigWalBefore).toBeGreaterThan(1 * MB);

    const result = runWalCheckpointSweep({ thresholdBytes: 1 * MB, roots: [dir] });

    expect(result.checked).toBe(2);
    expect(result.overThreshold).toBe(1);
    expect(result.checkpointed).toBe(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);

    // The small one was never touched — assert BEFORE closing either
    // connection: closing the last connection to a WAL db triggers SQLite's
    // own auto-checkpoint, which would remove/shrink the file regardless of
    // what the sweep did and make this assertion meaningless.
    expect(statSync(`${smallDb}-wal`).size).toBe(smallWalBefore);
    expect(statSync(`${bigDb}-wal`).size).toBe(0);

    big.close();
    small.close();
  });

  it('a missing root sweeps to an empty, error-free result', () => {
    const result = runWalCheckpointSweep({ roots: ['/nope/' + Date.now()] });
    expect(result).toEqual({ checked: 0, overThreshold: 0, checkpointed: 0, bytesReclaimed: 0, retained: [], errors: [] });
  });
});
