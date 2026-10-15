import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_SNAPSHOT_READ_CEILING_MS,
  reviveDependencySnapshotHealth,
  reviveGitnexusHealth,
} from './dependency-snapshot-health';
import { DEPENDENCY_SNAPSHOT_MAX_AGE_MS } from './gitnexus-reindex-action';

const H = 3_600_000;
const generatedAt = '2026-10-06T09:02:35.042Z';
const gen = Date.parse(generatedAt);

/** The stored block as measured live on 2026-10-06: checked 09:37Z, then never re-judged. */
const frozenFresh = {
  status: 'fresh' as const,
  reason: null,
  generatedAt,
  ageMs: 2_074_683,
  indexCommit: '47a899a680fee3cce3b1a023ff52db9b43a24edb',
  edges: 52108,
  checkedAt: Date.parse('2026-10-06T09:37:09.744Z'),
  alerted: false,
};

describe('reviveDependencySnapshotHealth (WI-10006666)', () => {
  it('pins the read ceiling to the action ceiling', () => {
    expect(DEPENDENCY_SNAPSHOT_READ_CEILING_MS).toBe(DEPENDENCY_SNAPSHOT_MAX_AGE_MS);
  });

  it('flips a stored fresh block to stale once generatedAt is past the ceiling', () => {
    const now = gen + 25 * H;
    const r = reviveDependencySnapshotHealth(frozenFresh, now);
    expect(r.status).toBe('stale');
    expect(r.storedStatus).toBe('fresh');
    expect(r.ageMs).toBe(25 * H);
    expect(r.storedAgeMs).toBe(2_074_683);
    expect(r.ageDerivedAt).toBe(new Date(now).toISOString());
    expect(r.reason).toMatch(/24h selector ceiling/);
    // Fields the read does not own pass through.
    expect(r.edges).toBe(52108);
    expect(r.checkedAt).toBe(frozenFresh.checkedAt);
    expect(r.alerted).toBe(false);
  });

  it('keeps fresh but reports the real age while under the ceiling', () => {
    const r = reviveDependencySnapshotHealth(frozenFresh, gen + 3.75 * H);
    expect(r.status).toBe('fresh');
    expect(r.ageMs).toBe(3.75 * H);
    expect(r.storedStatus).toBeUndefined();
  });

  it('treats exactly the ceiling as not yet over it, matching judgeDependencySnapshot', () => {
    const r = reviveDependencySnapshotHealth(frozenFresh, gen + DEPENDENCY_SNAPSHOT_READ_CEILING_MS);
    expect(r.status).toBe('fresh');
  });

  it('flips behind-index too, and leaves an already-stale block stale', () => {
    const now = gen + 30 * H;
    expect(reviveDependencySnapshotHealth({ ...frozenFresh, status: 'behind-index' as const }, now).status).toBe('stale');
    const s = reviveDependencySnapshotHealth({ ...frozenFresh, status: 'stale' as const, reason: 'x' }, now);
    expect(s.status).toBe('stale');
    expect(s.reason).toBe('x');
    expect(s.storedStatus).toBeUndefined();
  });

  it('passes time-independent statuses and unparseable generatedAt through unchanged', () => {
    const absent = { status: 'absent' as const, reason: 'no snapshot file', generatedAt: null, ageMs: null };
    expect(reviveDependencySnapshotHealth(absent, gen + 99 * H)).toBe(absent);
    const invalid = { ...frozenFresh, status: 'invalid' as const, reason: 'zero edges' };
    expect(reviveDependencySnapshotHealth(invalid, gen + 99 * H)).toBe(invalid);
    const noDate = { ...frozenFresh, generatedAt: 'not a date' };
    expect(reviveDependencySnapshotHealth(noDate, gen + 99 * H)).toBe(noDate);
  });

  it('never reports a negative age when the clock reads before generatedAt', () => {
    expect(reviveDependencySnapshotHealth(frozenFresh, gen - H).ageMs).toBe(0);
  });
});

describe('reviveGitnexusHealth', () => {
  it('revives only the nested dependencySnapshot and keeps the other health fields', () => {
    const health = { consecutiveFailures: 0, lastSuccessAt: 1, dependencySnapshot: frozenFresh };
    const out = reviveGitnexusHealth(health, gen + 25 * H) as typeof health & {
      dependencySnapshot: { status: string; storedStatus?: string };
    };
    expect(out.consecutiveFailures).toBe(0);
    expect(out.lastSuccessAt).toBe(1);
    expect(out.dependencySnapshot.status).toBe('stale');
    expect(out.dependencySnapshot.storedStatus).toBe('fresh');
    // The stored value is not mutated.
    expect(health.dependencySnapshot.status).toBe('fresh');
  });

  it('passes through values without a dependencySnapshot object', () => {
    for (const v of [null, undefined, 'x', 3, [], { consecutiveFailures: 2 }, { dependencySnapshot: null }]) {
      expect(reviveGitnexusHealth(v, gen)).toBe(v);
    }
  });
});
