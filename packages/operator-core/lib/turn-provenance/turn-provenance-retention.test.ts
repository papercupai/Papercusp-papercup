import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexedLoopTurnStartRecord } from '../harness/routines/loop-turn-start-stamp';
import {
  appendLedgerRow, classify, formatEnvelope, gcLedgerDir, LEDGER_GC_GRACE_MS,
  ledgerPathForSid, payloadSha256, readLedgerRows, type LedgerRow,
} from './turn-provenance';

const SID = 'su-retained-enrollment';
const NOW = 1_760_000_000_000;
const TTL = 600_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-prov-retention-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(nonce: string, ts: number, ttlMs?: number): LedgerRow {
  return { sid: SID, nonce, ts, origin: 'wake-pump', sha256: 'x', ...(ttlMs === undefined ? {} : { ttlMs }) };
}

/** Force the real append-time compactor, with padding old enough to reclaim. */
function oversizedLedger(rows: LedgerRow[], nowMs: number): void {
  const padding = JSON.stringify(row('f'.repeat(16), nowMs - TTL - LEDGER_GC_GRACE_MS - 1)) + '\n';
  writeFileSync(ledgerPathForSid(SID, dir),
    padding.repeat(Math.ceil(40 * 1024 / padding.length)) + rows.map(value => JSON.stringify(value) + '\n').join(''));
}

describe('append compaction preserves bounded provenance history (EI-26995183706038210)', () => {
  it.each(['claude', 'codex', 'omp'])('delayed %s ingest keeps the submission-valid typed loop fire after compaction', async (source) => {
    const body = 'Continue the enrolled loop fire.';
    const enrollment: LedgerRow = {
      sid: SID, nonce: 'a'.repeat(16), origin: 'loop-fire', sha256: payloadSha256(body),
      ts: NOW, ttlMs: TTL, loopFire: { routineId: 'loop:retained', wakeCount: 7 },
    };
    const prompt = `${formatEnvelope('loop-fire', enrollment.nonce)}\n${body}`;
    const ingestedAt = NOW + TTL + 60_000;
    oversizedLedger([enrollment], ingestedAt);
    expect(await appendLedgerRow(row('b'.repeat(16), ingestedAt), { dir, nowMs: ingestedAt, ttlMs: TTL })).toBe(true);

    const history = readLedgerRows(SID, { dir, nowMs: ingestedAt, ttlMs: TTL, includeExpired: true });
    expect(history).toContainEqual(enrollment);
    expect(readLedgerRows(SID, { dir, nowMs: ingestedAt, ttlMs: TTL }).map(value => value.nonce)).toEqual(['b'.repeat(16)]);
    expect(classify(prompt, history, { nowMs: ingestedAt, ttlMs: TTL }).verdict).toBe('unverified-claim');

    const turn = {
      workspace_id: 'default', source_kind: source, session_id: 'native-retention', turn_idx: 7,
      ts: new Date(NOW + 1_000), owner: SID, speaker: 'user', text: prompt, turn_origin: 'loop-fire',
    };
    expect(indexedLoopTurnStartRecord(turn, undefined, { dir, workspaceId: 'workspace-a' })).toMatchObject({
      sessionId: turn.session_id,
      detail: { source: 'session-ingest', loopFire: enrollment.loopFire, provenanceWorkspaceId: 'workspace-a' },
    });
    // Retention does not authorize a turn actually submitted after its TTL.
    expect(indexedLoopTurnStartRecord({ ...turn, ts: new Date(ingestedAt) }, undefined,
      { dir, workspaceId: 'workspace-a' })).toBeNull();
  });

  it.each([undefined, 30_000, 3_900_000])('uses the row TTL (%s) and reclaims only beyond the grace boundary', async (override) => {
    const effectiveTtl = override ?? TTL;
    const expired = row('1'.repeat(16), NOW - effectiveTtl - 1, override);
    const boundary = row('2'.repeat(16), NOW - effectiveTtl - LEDGER_GC_GRACE_MS, override);
    const pastGrace = row('3'.repeat(16), boundary.ts - 1, override);
    const fresh = row('4'.repeat(16), NOW);
    oversizedLedger([expired, boundary, pastGrace], NOW);
    expect(await appendLedgerRow(fresh, { dir, nowMs: NOW, ttlMs: TTL })).toBe(true);
    expect(readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL, includeExpired: true })).toEqual([expired, boundary, fresh]);
    expect(readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL })).toEqual([fresh]);
    expect(await gcLedgerDir({ dir, nowMs: NOW, ttlMs: TTL })).toEqual({ filesRemoved: 0, rowsDropped: 0 });
    expect(await gcLedgerDir({ dir, nowMs: NOW + 1, ttlMs: TTL })).toEqual({ filesRemoved: 0, rowsDropped: 1 });
    expect(readLedgerRows(SID, { dir, nowMs: NOW + 1, ttlMs: TTL, includeExpired: true })).toEqual([expired, fresh]);
  });

  it('does not promote an expired hash-only scheduled turn to owner authority', async () => {
    const text = 'Resume the scheduled check.';
    const enrollment: LedgerRow = {
      ...row('a'.repeat(16), NOW - TTL - 1), origin: 'cli-schedule-wakeup', sha256: payloadSha256(text),
    };
    oversizedLedger([enrollment], NOW);
    expect(await appendLedgerRow(row('b'.repeat(16), NOW), { dir, nowMs: NOW, ttlMs: TTL })).toBe(true);
    const history = readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL, includeExpired: true });
    expect(classify(text, history, { nowMs: NOW, ttlMs: TTL }).verdict).toBe('unverified-claim');
    expect(classify(text, [], { nowMs: NOW, ttlMs: TTL }).verdict).toBe('owner-interactive');
  });
});
