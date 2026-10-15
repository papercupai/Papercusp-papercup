/**
 * effective-deadline.test.ts — P-016.
 *
 * The two properties that matter are opposites, and a fix for either one alone
 * produces a differently-wrong verdict:
 *   - a composed leaf with no deadline of its own must NOT read as "waits forever";
 *   - a composed leaf whose TREE already lapsed must NOT read as an active park
 *     (the SQL-side `expires_ts > now()` filter cannot see the root's deadline).
 */
import { describe, it, expect } from 'vitest';
import {
  applyRootDeadlines,
  rootIdsNeedingResolution,
  isStillPending,
  type RootDeadline,
} from './effective-deadline';

const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const roots = new Map<number, RootDeadline>([
  [7, { expiresTs: iso(T0 + 30 * 60_000), timeoutBehavior: 'wake' }],
  [8, { expiresTs: null, timeoutBehavior: 'expire' }],
]);

describe('applyRootDeadlines', () => {
  it("fills a composed leaf's missing deadline from its root", () => {
    const [row] = applyRootDeadlines([{ expiresTs: null, rootId: 7 }], roots);
    expect(row?.expiresTs).toBe(iso(T0 + 30 * 60_000));
  });

  it('inherits the composed root timeout policy instead of the delivery anchor expiry policy', () => {
    const input = { expiresTs: null, rootId: 7, timeoutBehavior: 'expire' };
    const [row] = applyRootDeadlines([input], roots);
    expect(row).toMatchObject({ expiresTs: iso(T0 + 30 * 60_000), timeoutBehavior: 'wake' });
    expect(input).toEqual({ expiresTs: null, rootId: 7, timeoutBehavior: 'expire' });
  });

  it('does not promote a composed root that expires silently to a wake guarantee', () => {
    const expiringRoots = new Map([[7, { expiresTs: iso(T0 + 30 * 60_000), timeoutBehavior: 'expire' }]]);
    const [row] = applyRootDeadlines([{ expiresTs: null, rootId: 7, timeoutBehavior: 'wake' }], expiringRoots);
    expect(row).toMatchObject({ expiresTs: iso(T0 + 30 * 60_000), timeoutBehavior: 'expire' });
  });

  it('preserves the original policy when the composed root policy could not be read', () => {
    const unknownPolicy = new Map([[7, { expiresTs: iso(T0 + 30 * 60_000), timeoutBehavior: null }]]);
    const [row] = applyRootDeadlines([{ expiresTs: null, rootId: 7, timeoutBehavior: 'expire' }], unknownPolicy);
    expect(row?.timeoutBehavior).toBe('expire');
  });

  it("NEVER overrides a row's own deadline — the helper only fills a gap", () => {
    const own = iso(T0 + 60_000);
    const input = { expiresTs: own, rootId: 7, timeoutBehavior: 'expire' };
    const [row] = applyRootDeadlines([input], roots);
    expect(row).toBe(input);
  });

  it('leaves an ordinary (non-composed) await completely untouched', () => {
    const rows = [{ expiresTs: null, rootId: null }, { expiresTs: null }];
    expect(applyRootDeadlines(rows, roots)).toEqual(rows);
  });

  it('leaves the row alone when the root itself has no deadline', () => {
    const [row] = applyRootDeadlines([{ expiresTs: null, rootId: 8 }], roots);
    expect(row?.expiresTs).toBeNull();
  });

  it('leaves the row alone when the root could not be read (fail-soft path)', () => {
    const [row] = applyRootDeadlines([{ expiresTs: null, rootId: 99 }], new Map());
    expect(row?.expiresTs).toBeNull();
  });

  it('returns NEW objects rather than mutating the caller\'s rows', () => {
    const input = [{ expiresTs: null, rootId: 7 }];
    const out = applyRootDeadlines(input, roots);
    expect(input[0]!.expiresTs).toBeNull();
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('rootIdsNeedingResolution', () => {
  it('asks for nothing when no row is a composed leaf — the common case costs no query', () => {
    expect(
      rootIdsNeedingResolution([{ expiresTs: null }, { expiresTs: iso(T0), rootId: null }]),
    ).toEqual([]);
  });

  it('skips a composed row that already has its own deadline', () => {
    expect(rootIdsNeedingResolution([{ expiresTs: iso(T0), rootId: 7 }])).toEqual([]);
  });

  it('dedupes ids across sibling leaves of the same tree', () => {
    expect(
      rootIdsNeedingResolution([
        { expiresTs: null, rootId: 7 },
        { expiresTs: null, rootId: 7 },
        { expiresTs: null, rootId: 8 },
      ]),
    ).toEqual([7, 8]);
  });
});

describe('isStillPending', () => {
  it('treats a deadline-free row as pending', () => {
    expect(isStillPending({ expiresTs: null }, T0)).toBe(true);
  });

  it('is pending strictly before the deadline, lapsed after it', () => {
    expect(isStillPending({ expiresTs: iso(T0 + 1000) }, T0)).toBe(true);
    expect(isStillPending({ expiresTs: iso(T0 - 1000) }, T0)).toBe(false);
  });

  it('fails OPEN on an unparseable timestamp — never invents a lapse', () => {
    expect(isStillPending({ expiresTs: 'not-a-date' }, T0)).toBe(true);
  });

  it('drops a leaf whose TREE has lapsed — the half the SQL filter cannot see', () => {
    const lapsed = new Map<number, RootDeadline>([
      [7, { expiresTs: iso(T0 - 60_000), timeoutBehavior: 'expire' }],
    ]);
    const resolved = applyRootDeadlines([{ expiresTs: null, rootId: 7 }], lapsed);
    // Before P-016 this row survived `expires_ts IS NULL OR expires_ts > now()` and
    // was reported as an ACTIVE park on a tree that had already timed out.
    expect(resolved.filter((r) => isStillPending(r, T0))).toHaveLength(0);
  });
});
