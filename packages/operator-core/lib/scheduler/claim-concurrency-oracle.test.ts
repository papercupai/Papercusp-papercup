/**
 * EI-19313376980892266 — the ONE ORACLE for claim concurrency.
 *
 * Before this, `maxConcurrentClaims` had four consumers and three behaviours:
 * `getNextWorkItem` enforced it, `get_next.ts`'s miss diagnosis enforced it via an
 * INDEPENDENT second copy of the rule, `fleet:leader-brief` never consulted it, and
 * `work_items:claim` had no check at all. Two copies of a rule that must agree will
 * eventually disagree; two surfaces that never consult it already did.
 *
 * These tests pin the shared DECISION. The point is not that `>=` works — it is that
 * there is exactly one place where that comparison is spelled, so a future edit cannot
 * change one surface's answer without changing every surface's answer.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_CLAIMS,
  evaluateClaimConcurrency,
  isParkedOnExternalBlocker,
} from './claim-spec-store';

/** A blocker record the REAL external-blockers parser accepts (every required field present). */
function blocker(status: 'active' | 'cleared', kind = 'event') {
  return {
    kind,
    ref: 'gate:green-checkpoint',
    summary: 'waiting on the gate',
    status,
    createdAt: '2026-10-11T00:00:00.000Z',
    createdBy: 'su-test',
    updatedAt: '2026-10-11T00:00:00.000Z',
  };
}

describe('isParkedOnExternalBlocker — P-010 (plan D-010)', () => {
  it('frees the slot for a blocked or needs-human hold with an active typed blocker', () => {
    expect(isParkedOnExternalBlocker({ status: 'blocked', externalBlockers: [blocker('active')] })).toBe(true);
    expect(isParkedOnExternalBlocker({ status: 'needs-human', externalBlockers: [blocker('active', 'human')] })).toBe(true);
  });

  it('still counts a wip hold even when it carries an active blocker (the holder says it is working it)', () => {
    expect(isParkedOnExternalBlocker({ status: 'wip', externalBlockers: [blocker('active')] })).toBe(false);
    expect(isParkedOnExternalBlocker({ status: 'open', externalBlockers: [blocker('active')] })).toBe(false);
  });

  it('still counts a plain park: blocked with no blocker, only cleared ones, or a record the parser rejects (EI-11796)', () => {
    expect(isParkedOnExternalBlocker({ status: 'blocked' })).toBe(false);
    expect(isParkedOnExternalBlocker({ status: 'blocked', externalBlockers: [] })).toBe(false);
    expect(isParkedOnExternalBlocker({ status: 'blocked', externalBlockers: [blocker('cleared')] })).toBe(false);
    // Malformed (no ref) — the real parser drops it, so it must not buy a slot either.
    const { ref: _ref, ...noRef } = blocker('active');
    expect(isParkedOnExternalBlocker({ status: 'blocked', externalBlockers: [noRef] })).toBe(false);
    expect(isParkedOnExternalBlocker({ status: 'blocked', externalBlockers: 'not-an-array' })).toBe(false);
    expect(isParkedOnExternalBlocker({ status: null, externalBlockers: [blocker('active')] })).toBe(false);
  });

  // Falsifiability control, kept permanently instead of mutating production code. Each case
  // below is one the real predicate must get right; each control is a plausible WRONG
  // implementation (the shapes a SQL re-spelling or a hurried edit would take). The table is
  // only a guard if the real predicate passes every case AND every control fails at least one.
  const { ref: _ref, ...noRef } = blocker('active');
  const cases: Array<{ name: string; row: { status: string | null; externalBlockers?: unknown }; parked: boolean }> = [
    { name: 'blocked + active', row: { status: 'blocked', externalBlockers: [blocker('active')] }, parked: true },
    { name: 'needs-human + active', row: { status: 'needs-human', externalBlockers: [blocker('active', 'human')] }, parked: true },
    { name: 'wip + active', row: { status: 'wip', externalBlockers: [blocker('active')] }, parked: false },
    { name: 'blocked + none', row: { status: 'blocked' }, parked: false },
    { name: 'blocked + cleared', row: { status: 'blocked', externalBlockers: [blocker('cleared')] }, parked: false },
    { name: 'blocked + malformed', row: { status: 'blocked', externalBlockers: [noRef] }, parked: false },
  ];
  const wrongImplementations: Record<string, (row: { status: string | null; externalBlockers?: unknown }) => boolean> = {
    'ignores status': (row) => Array.isArray(row.externalBlockers) && row.externalBlockers.length > 0,
    'any non-empty array (ignores cleared/malformed)': (row) =>
      (row.status === 'blocked' || row.status === 'needs-human') &&
      Array.isArray(row.externalBlockers) &&
      row.externalBlockers.length > 0,
    'blocked only (drops needs-human)': (row) => row.status === 'blocked' && isParkedOnExternalBlocker(row),
    'any blocked status parks (EI-11796 regression)': (row) => row.status === 'blocked' || row.status === 'needs-human',
  };

  it('calibration: the real predicate passes every case', () => {
    for (const c of cases) expect({ name: c.name, parked: isParkedOnExternalBlocker(c.row) }).toEqual({ name: c.name, parked: c.parked });
  });

  it.each(Object.entries(wrongImplementations))('control: the case table rejects a predicate that %s', (_label, wrong) => {
    expect(cases.some((c) => wrong(c.row) !== c.parked)).toBe(true);
  });
});

describe('evaluateClaimConcurrency — the shared verdict', () => {
  it('defaults to one held lane when the spec names no limit (EI-11796 fail-closed default)', () => {
    expect(DEFAULT_MAX_CONCURRENT_CLAIMS).toBe(1);
    const v = evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-1' }] });
    expect(v).toMatchObject({ blocked: true, activeClaims: 1, maxConcurrentClaims: 1 });
  });

  it('is NOT blocked when the bee holds nothing', () => {
    const v = evaluateClaimConcurrency({ activeClaims: [] });
    expect(v.blocked).toBe(false);
    expect(v.activeClaims).toBe(0);
    expect(v.heldIds).toEqual([]);
  });

  it('honours a leader-authored limit above 1 rather than assuming the default', () => {
    // The false-suppression direction: with a hard-coded 1, a member holding one claim
    // under a concurrency-2 spec would be reported blocked and its genuine starvation
    // signal silenced.
    const v = evaluateClaimConcurrency({
      activeClaims: [{ id: 'WI-1' }],
      maxConcurrentClaims: 2,
    });
    expect(v.blocked).toBe(false);
    expect(v.maxConcurrentClaims).toBe(2);
  });

  it('blocks at the limit, not merely above it (>= is the scheduler semantic)', () => {
    const at = evaluateClaimConcurrency({
      activeClaims: [{ id: 'WI-1' }, { id: 'WI-2' }],
      maxConcurrentClaims: 2,
    });
    expect(at.blocked).toBe(true);
  });

  it('names the held ids so a refusal or alert can say exactly what to release', () => {
    const v = evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    expect(v.heldIds).toEqual(['WI-1', 'WI-2']);
  });

  it('accepts a bare count for callers that only have a number (heldIds then empty, never fabricated)', () => {
    const v = evaluateClaimConcurrency({ activeClaims: 3, maxConcurrentClaims: 2 });
    expect(v).toMatchObject({ blocked: true, activeClaims: 3, heldIds: [] });
  });

  it('reports blocker-parked holds without counting them (P-010) — named, never hidden', () => {
    const v = evaluateClaimConcurrency({
      activeClaims: [{ id: 'WI-1' }],
      blockerParked: [{ id: 'WI-2' }, { id: 'WI-3' }],
      maxConcurrentClaims: 2,
    });
    expect(v).toMatchObject({ blocked: false, activeClaims: 1, heldIds: ['WI-1'], blockerParkedIds: ['WI-2', 'WI-3'] });
    // The 2/2 starvation the parked-agent census measured: two parked holds no longer block a pull.
    expect(
      evaluateClaimConcurrency({ activeClaims: [], blockerParked: [{ id: 'A' }, { id: 'B' }], maxConcurrentClaims: 2 })
        .blocked,
    ).toBe(false);
    expect(evaluateClaimConcurrency({ activeClaims: 1 }).blockerParkedIds).toEqual([]);
  });

  it('treats a nullish limit as the default rather than as "unlimited"', () => {
    // Reading absent-as-unlimited would silently disable the cap everywhere at once.
    expect(evaluateClaimConcurrency({ activeClaims: [{ id: 'A' }], maxConcurrentClaims: null }).blocked).toBe(true);
    expect(evaluateClaimConcurrency({ activeClaims: [{ id: 'A' }], maxConcurrentClaims: undefined }).blocked).toBe(true);
  });
});
