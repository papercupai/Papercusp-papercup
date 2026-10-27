/**
 * reduceSnapshotEvent — pure reducer behind useStateSnapshots (P-009). Full
 * snapshots win by version; a delta applies on top of the run base and falls back
 * to keeping the stale entry (no-op) when it can't be applied, so a bad/late delta
 * can never corrupt or crash the chat-surface card map.
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshot } from '@papercusp/agent-mcp';
import { reduceSnapshotEvent } from './snapshot-reducer';
import type { SnapshotEnvelope } from './use-state-snapshots';

const card = (correlationId: string, extra: Record<string, unknown> = {}): unknown => ({
  correlationId,
  id: `c:${correlationId}`,
  ...extra,
});
const env = (runId: string, version: number, openCards: unknown[], toolState?: unknown): SnapshotEnvelope =>
  ({ runId, version, snapshot: { openCards, toolState } }) as SnapshotEnvelope;

describe('reduceSnapshotEvent', () => {
  it('discards a previous worker baseline before accepting a lower restarted version', () => {
    const previous = new Map([['old-run', env('old-run', 100, [card('stale')])]]);
    const reset = reduceSnapshotEvent(previous, { kind: 'reset' });
    expect(reset.size).toBe(0);
    expect(reduceSnapshotEvent(reset, { kind: 'snapshot', env: env('old-run', 1, [card('recovered')]) })
      .get('old-run')?.snapshot.openCards).toEqual([card('recovered')]);
  });
  it('adds a new run from a full snapshot', () => {
    const out = reduceSnapshotEvent(new Map(), { kind: 'snapshot', env: env('r1', 1, [card('a')]) });
    expect(out.get('r1')?.version).toBe(1);
  });

  it('replaces on a higher version; ignores a stale/equal version (same ref → no re-render)', () => {
    const m = new Map<string, SnapshotEnvelope>([['r1', env('r1', 2, [card('a')])]]);
    expect(reduceSnapshotEvent(m, { kind: 'snapshot', env: env('r1', 3, [card('a'), card('b')]) }).get('r1')?.version).toBe(3);
    expect(reduceSnapshotEvent(m, { kind: 'snapshot', env: env('r1', 1, []) })).toBe(m); // stale → no-op
  });

  it('applies a delta on top of the run base, reconstructing next', () => {
    const base = env('r1', 1, [card('a')]);
    const next = env('r1', 2, [card('a'), card('b')]);
    const delta = diffSnapshot(base as never, next as never)!;
    const out = reduceSnapshotEvent(new Map([['r1', base]]), { kind: 'delta', delta });
    expect(out.get('r1')).toEqual(next);
  });

  it('keeps the stale entry (no-op) when a delta has no base or a version gap', () => {
    const base = env('r1', 1, [card('a')]);
    const delta = diffSnapshot(base as never, env('r1', 2, [card('a'), card('b')]) as never)!;
    expect(reduceSnapshotEvent(new Map(), { kind: 'delta', delta }).size).toBe(0); // no base
    const gap = new Map<string, SnapshotEnvelope>([['r1', env('r1', 5, [card('a')])]]);
    expect(reduceSnapshotEvent(gap, { kind: 'delta', delta })).toBe(gap); // baseVersion mismatch → keep stale
  });
});
