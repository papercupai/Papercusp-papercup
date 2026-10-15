/**
 * Unit tests for the PURE half of condition-object.ts (P-001 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * No database: the claim-state decision is deliberately separated from the query
 * so its edge cases are testable directly, and `nowMs` is injected so the
 * lease-expiry boundary needs no sleeping (a test that sleeps to cross a real
 * deadline is a test that flakes in CI).
 *
 * The case that earns most of this file is `held` vs `lease-expired`. Both have a
 * non-null `takenBy`, so a reader that treats "someone is on it" as
 * `takenBy != null` reports a dead agent's abandoned lease as live ownership —
 * strictly worse than reporting no owner, because it suppresses the next agent
 * from picking the condition up. That is the failure the enum exists to prevent,
 * so it is pinned here rather than left to the caller.
 */
import { describe, it, expect } from 'vitest';
import {
  findConditionObjects,
  resolveConditionObject,
  claimStateOf,
  claimHoldBlocked,
  leaseExpired,
  effectiveConditionLeaseExpiresAt,
  CONDITION_LINK_REL,
  type ConditionWorkItemRow,
} from './condition-object';
import { CHECKPOINT_RUN_LOCK_STALE_MS } from '../release-checkpoint-launch';
import type { Sql } from 'postgres';

const NOW = Date.parse('2026-08-03T01:00:00.000Z');
const KEY = 'green-stall:papercusp';

function row(over: Partial<ConditionWorkItemRow> = {}): ConditionWorkItemRow {
  return {
    workItem: 'EI-1',
    title: 'gate is red',
    status: 'open',
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    payload: null,
    ...over,
  };
}

describe('resolveConditionObject', () => {
  it('reports no-object when nothing is linked to the key', () => {
    const got = resolveConditionObject(KEY, [], NOW);
    expect(got.claimState).toBe('no-object');
    expect(got.workItem).toBeNull();
    expect(got.takenBy).toBeNull();
    expect(got.duplicates).toEqual([]);
    // The key is echoed back even with no rows, so a batched caller can key its
    // map off the result without tracking which requests came back empty.
    expect(got.conditionKey).toBe(KEY);
    expect(got.reachability).toMatchObject({ verdict: 'unknown', authoritative: false });
  });

  it('reports claimable for a linked item nobody holds', () => {
    const got = resolveConditionObject(KEY, [row()], NOW);
    expect(got.claimState).toBe('claimable');
    expect(got.workItem).toBe('EI-1');
    expect(got.takenBy).toBeNull();
    expect(got.reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver' });
  });

  it('reports held for a claim whose lease has not lapsed', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', takenAt: '2026-08-03T00:50:00Z', expiresAt: '2026-08-03T02:00:00Z' })],
      NOW,
    );
    expect(got.claimState).toBe('held');
    expect(got.takenBy).toBe('su-abc');
  });

  it('reports held for an unanchored claim with NO expiry — an absent lease is not a lapsed one', () => {
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', expiresAt: null })], NOW);
    expect(got.claimState).toBe('held');
    expect(got.expiresAt).toBeNull();
  });

  it('derives a condition-owner lease from takenAt when issue expiry is intentionally absent', () => {
    const takenAt = new Date(NOW - 29 * 60_000).toISOString();
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', takenAt, expiresAt: null })], NOW);
    expect(got.claimState).toBe('held');
    expect(got.expiresAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('expires an anchored condition owner after the shared critical-claim lease', () => {
    const takenAt = new Date(NOW - 31 * 60_000).toISOString();
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', takenAt, expiresAt: null })], NOW);
    expect(got.claimState).toBe('lease-expired');
    expect(got.expiresAt).toBe(new Date(NOW - 1 * 60_000).toISOString());
  });

  it('uses fresh condition progress as the derived lease renewal', () => {
    const takenAt = new Date(NOW - 90 * 60_000).toISOString();
    const lastProgressAt = new Date(NOW - 2 * 60_000).toISOString();
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', takenAt, lastProgressAt, expiresAt: null })],
      NOW,
    );
    expect(got.claimState).toBe('held');
    expect(got.expiresAt).toBe(new Date(NOW + 28 * 60_000).toISOString());
  });

  it('renews an expired legacy stored lease when newer item progress exists', () => {
    const takenAt = new Date(NOW - 90 * 60_000).toISOString();
    const lastProgressAt = new Date(NOW - 2 * 60_000).toISOString();
    const staleStoredExpiry = new Date(NOW - 25 * 60_000).toISOString();
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', takenAt, lastProgressAt, expiresAt: staleStoredExpiry })],
      NOW,
    );

    expect(got.claimState).toBe('held');
    expect(got.expiresAt).toBe(new Date(NOW + 28 * 60_000).toISOString());
    expect(
      effectiveConditionLeaseExpiresAt(
        row({ takenBy: 'su-abc', takenAt, lastProgressAt, expiresAt: new Date(NOW + 60 * 60_000).toISOString() }),
        NOW,
      ),
    ).toBe(new Date(NOW + 60 * 60_000).toISOString());
  });

  it('does not invent a lease for an unclaimed condition row', () => {
    expect(effectiveConditionLeaseExpiresAt(row({ takenBy: null, takenAt: new Date(NOW - 60_000).toISOString() }), NOW)).toBeNull();
  });

  it('reports lease-expired — NOT held — for a lapsed claim, so a dead holder never reads as live', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-dead', expiresAt: '2026-08-03T00:30:00Z' })],
      NOW,
    );
    expect(got.claimState).toBe('lease-expired');
    // takenBy is still reported: the caller wants to know WHO abandoned it.
    expect(got.takenBy).toBe('su-dead');
  });

  it('treats an expiry exactly at now as expired (boundary is inclusive)', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', expiresAt: new Date(NOW).toISOString() })],
      NOW,
    );
    expect(got.claimState).toBe('lease-expired');
  });

  it('ignores an unparseable expiry rather than treating it as lapsed', () => {
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', expiresAt: 'not-a-date' })], NOW);
    expect(got.claimState).toBe('held');
  });

  it('reports hold-blocked for an attributed durable claim hold', () => {
    const got = resolveConditionObject(
      KEY,
      [
        row({
          payload: {
            _claimHold: true,
            claim_hold_by: 'su-parker',
            claim_hold_reason: 'keep unassigned until explicit resume',
          },
        }),
      ],
      NOW,
    );
    expect(got.claimState).toBe('hold-blocked');
    expect(got.takenBy).toBeNull();
  });

  it('uses the same held-open provenance convention as the claim guard', () => {
    expect(
      claimHoldBlocked(
        row({
          payload: {
            _claimHold: 'true',
            held_open_by: 'su-holder',
            held_open_reason: 'owner gate',
          },
        }),
      ),
    ).toBe(true);
    expect(claimHoldBlocked(row({ payload: { _claimHold: true } }))).toBe(false);
  });
});

describe('duplicate filings — the condition this plan exists to remove', () => {
  it('picks the oldest row as canonical and reports the rest as duplicates', () => {
    // Caller orders by created_ts, so rows[0] is the oldest.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2' }), row({ workItem: 'EI-3' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-1');
    expect(got.duplicates).toEqual(['EI-2', 'EI-3']);
  });

  it('prefers a genuinely HELD row over an older unheld one', () => {
    // If any agent is actually live on the condition, that is the answer the
    // caller needs — otherwise a stale unclaimed duplicate would mask a real owner.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2', takenBy: 'su-live', expiresAt: '2026-08-03T02:00:00Z' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-2');
    expect(got.claimState).toBe('held');
    expect(got.duplicates).toEqual(['EI-1']);
  });

  it('does NOT let an expired-lease row outrank the oldest row', () => {
    // A lapsed claim is not ownership, so it must not win canonical position.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2', takenBy: 'su-dead', expiresAt: '2026-08-03T00:30:00Z' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-1');
    expect(got.claimState).toBe('claimable');
  });

  it('lets an attributed hold row outrank an older unheld duplicate', () => {
    const got = resolveConditionObject(
      KEY,
      [
        row({ workItem: 'EI-unheld' }),
        row({
          workItem: 'EI-held-open',
          payload: { _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'parked' },
        }),
      ],
      NOW,
    );
    expect(got.workItem).toBe('EI-held-open');
    expect(got.claimState).toBe('hold-blocked');
    expect(got.duplicates).toEqual(['EI-unheld']);
  });

  it('lets an active held row outrank an older unheld duplicate', () => {
    const got = resolveConditionObject(
      KEY,
      [
        row({ workItem: 'EI-unheld' }),
        row({ workItem: 'EI-held', takenBy: 'su-live', expiresAt: '2026-08-03T02:00:00Z' }),
      ],
      NOW,
    );
    expect(got.workItem).toBe('EI-held');
    expect(got.claimState).toBe('held');
    expect(got.duplicates).toEqual(['EI-unheld']);
  });

  it('reports every duplicate rather than silently collapsing them', () => {
    // Six agents filed one condition on 2026-08-02/03 and none saw the others.
    // Until P-002's partial unique index lands, duplicates are REAL and must be
    // visible — a resolver that hid them would make the problem unmeasurable.
    const rows = ['EI-1', 'EI-2', 'EI-3', 'EI-4', 'EI-5', 'EI-6'].map((id) => row({ workItem: id }));
    const got = resolveConditionObject('single-primary:no-primary', rows, NOW);
    expect(got.workItem).toBe('EI-1');
    expect(got.duplicates).toHaveLength(5);
  });
});

describe('claimStateOf / leaseExpired', () => {
  it('never returns no-object for an existing row', () => {
    expect(claimStateOf(row(), NOW)).toBe('claimable');
    expect(claimStateOf(row({ takenBy: 'x' }), NOW)).toBe('held');
  });

  it('returns hold-blocked before lease/claim state when attributed hold provenance exists', () => {
    expect(
      claimStateOf(
        row({
          takenBy: 'su-holder',
          expiresAt: '2026-08-03T00:30:00Z',
          payload: { _claimHold: true, held_open_by: 'su-holder' },
        }),
        NOW,
      ),
    ).toBe('hold-blocked');
  });

  it('an unclaimed row has no lease to expire', () => {
    expect(leaseExpired(row({ takenBy: null, expiresAt: '2000-01-01T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('pending checkpoint outcome awaits preserve condition leases', () => {
  it('extends an expired progress lease only to the earlier await deadline or 190-minute cap', () => {
    const takenAt = new Date(NOW - 31 * 60_000).toISOString();
    const awaitCreatedAt = new Date(NOW - 10 * 60_000).toISOString();
    const awaitExpiresAt = new Date(NOW + 300 * 60_000).toISOString();
    const withAwait = row({
      takenBy: 'su-abc',
      takenAt,
      lastProgressAt: takenAt,
      checkpointAwaitCreatedAt: awaitCreatedAt,
      checkpointAwaitExpiresAt: awaitExpiresAt,
    });

    expect(effectiveConditionLeaseExpiresAt(withAwait, NOW)).toBe(
      new Date(Date.parse(awaitCreatedAt) + CHECKPOINT_RUN_LOCK_STALE_MS).toISOString(),
    );
    expect(leaseExpired(withAwait, NOW)).toBe(false);
    expect(
      effectiveConditionLeaseExpiresAt(
        { ...withAwait, checkpointAwaitExpiresAt: new Date(NOW + 20 * 60_000).toISOString() },
        NOW,
      ),
    ).toBe(new Date(NOW + 20 * 60_000).toISOString());
  });

  it('does not extend an unclaimed row or a timed-out/over-cap await', () => {
    const stale = row({
      takenBy: 'su-abc',
      takenAt: new Date(NOW - 31 * 60_000).toISOString(),
      lastProgressAt: new Date(NOW - 31 * 60_000).toISOString(),
    });
    const baseExpiry = new Date(NOW - 1 * 60_000).toISOString();
    expect(effectiveConditionLeaseExpiresAt(stale, NOW)).toBe(baseExpiry);
    expect(
      effectiveConditionLeaseExpiresAt(
        {
          ...stale,
          checkpointAwaitCreatedAt: new Date(NOW - 20 * 60_000).toISOString(),
          checkpointAwaitExpiresAt: new Date(NOW - 1 * 60_000).toISOString(),
        },
        NOW,
      ),
    ).toBe(baseExpiry);
    expect(
      effectiveConditionLeaseExpiresAt(
        {
          ...stale,
          checkpointAwaitCreatedAt: new Date(NOW - CHECKPOINT_RUN_LOCK_STALE_MS - 1).toISOString(),
        },
        NOW,
      ),
    ).toBe(baseExpiry);
    expect(
      effectiveConditionLeaseExpiresAt(
        {
          ...stale,
          takenBy: null,
          checkpointAwaitCreatedAt: new Date(NOW - 1_000).toISOString(),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('wires condition reads to a pending same-holder await with an exact runId', async () => {
    let queryText = '';
    let queryValues: unknown[] = [];
    const awaitCreatedAt = new Date(NOW - 10 * 60_000).toISOString();
    const fakeSql = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      queryText = strings.join(' ');
      queryValues = values;
      return Promise.resolve([
        {
          condition_key: KEY,
          work_item: 'EI-1',
          title: 'gate is red',
          status: 'open',
          taken_by: 'su-abc',
          taken_at: new Date(NOW - 31 * 60_000).toISOString(),
          last_progress_at: new Date(NOW - 31 * 60_000).toISOString(),
          expires_at: null,
          payload: null,
          checkpoint_await_created_at: awaitCreatedAt,
          checkpoint_await_expires_at: new Date(NOW + 300 * 60_000).toISOString(),
        },
      ]);
    }) as unknown as Sql;

    const got = await findConditionObjects([KEY], { harnessSlug: 'papercusp', sql: fakeSql, nowMs: NOW });
    const owner = got.get(KEY);
    expect(owner?.claimState).toBe('held');
    expect(owner?.expiresAt).toBe(
      new Date(Date.parse(awaitCreatedAt) + CHECKPOINT_RUN_LOCK_STALE_MS).toISOString(),
    );

    const normalizedSql = queryText.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizedSql).toContain('from harness_shared.event_awaits_effective a');
    expect(normalizedSql).toContain('a.subscriber_id = w.taken_by');
    expect(normalizedSql).toContain("jsonb_typeof(a.payload_filter -> 'runid') = 'string'");
    expect(normalizedSql).toContain("length(a.payload_filter ->> 'runid') >= 4");
    expect(normalizedSql).toContain('a.fired_at is null');
    expect(normalizedSql).toContain('a.cancelled_at is null');
    expect(normalizedSql).toContain('a.superseded_at is null');
    expect(normalizedSql).toContain('a.effective_expires_ts is null or a.effective_expires_ts > to_timestamp(');
    expect(normalizedSql).toContain('a.created_at <= to_timestamp(');
    expect(normalizedSql).toMatch(/a\.created_at \+\s+\* interval '1 millisecond'/);
    expect(normalizedSql).toContain('a.event_key = any(');
    expect(normalizedSql).toContain("'release:green:' || split_part(l.dst_ref, ':', 2)");
    expect(normalizedSql).toContain("l.dst_ref like 'green-stall:%'");
    expect(normalizedSql).toContain("l.dst_ref like 'gate-red-streak:%'");
    expect(normalizedSql).not.toContain('a.workspace_id');
    expect(queryValues).toContain(CHECKPOINT_RUN_LOCK_STALE_MS);
    expect(
      queryValues.some(
        (value) =>
          Array.isArray(value) &&
          value.includes('release:green') &&
          value.includes('green-checkpoint:red') &&
          value.includes('green-checkpoint:inconclusive') &&
          value.includes('green-checkpoint:held'),
      ),
    ).toBe(true);
  });

  it('extends for a pending same-holder await on the exact pipeline outcome key without runId', async () => {
    let queryText = '';
    const awaitCreatedAt = new Date(NOW - 10 * 60_000).toISOString();
    const fakeSql = ((strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      return Promise.resolve([
        {
          condition_key: KEY,
          work_item: 'EI-1',
          title: 'gate is red',
          status: 'open',
          taken_by: 'su-abc',
          taken_at: new Date(NOW - 31 * 60_000).toISOString(),
          last_progress_at: new Date(NOW - 31 * 60_000).toISOString(),
          expires_at: null,
          payload: null,
          checkpoint_await_created_at: awaitCreatedAt,
          checkpoint_await_expires_at: new Date(NOW + 300 * 60_000).toISOString(),
        },
      ]);
    }) as unknown as Sql;

    const got = await findConditionObjects([KEY], { harnessSlug: 'papercusp', sql: fakeSql, nowMs: NOW });
    const owner = got.get(KEY);
    expect(owner?.claimState).toBe('held');
    expect(owner?.expiresAt).toBe(
      new Date(Date.parse(awaitCreatedAt) + CHECKPOINT_RUN_LOCK_STALE_MS).toISOString(),
    );

    const normalizedSql = queryText.replace(/\s+/g, ' ').toLowerCase();
    const globalKeyClause = normalizedSql.indexOf('a.event_key = any(');
    const exactRunGuard = normalizedSql.indexOf("jsonb_typeof(a.payload_filter -> 'runid') = 'string'");
    const pipelineKeyClause = normalizedSql.indexOf('or a.event_key = any(array[');
    expect(globalKeyClause).toBeGreaterThanOrEqual(0);
    expect(exactRunGuard).toBeGreaterThan(globalKeyClause);
    expect(pipelineKeyClause).toBeGreaterThan(exactRunGuard);
    expect(normalizedSql).toContain("'release:green:' || split_part(l.dst_ref, ':', 2)");
    expect(normalizedSql).toContain("'green-checkpoint:inconclusive:' || split_part(l.dst_ref, ':', 2)");
    expect(normalizedSql).toContain('a.fired_at is null');
    expect(normalizedSql).toContain('a.cancelled_at is null');
    expect(normalizedSql).toContain('a.superseded_at is null');
  });
});

describe('database timestamp projection', () => {
  it('normalizes session-local Postgres timestamptz text to explicit UTC ISO values', async () => {
    const fakeSql = ((
      _strings: TemplateStringsArray,
      ..._values: unknown[]
    ) => Promise.resolve([
      {
        condition_key: KEY,
        work_item: 'EI-1',
        title: 'gate is red',
        status: 'open',
        taken_by: 'su-abc',
        taken_at: '2026-08-02 20:50:00.000000-04',
        last_progress_at: '2026-08-02 20:59:00.000000-04',
        expires_at: '2026-08-02 22:00:00.000000-04',
        payload: null,
        checkpoint_await_created_at: null,
        checkpoint_await_expires_at: null,
      },
    ])) as unknown as Sql;

    const got = await findConditionObjects([KEY], { harnessSlug: 'papercusp', sql: fakeSql, nowMs: NOW });
    expect(got.get(KEY)).toMatchObject({
      takenAt: '2026-08-03T00:50:00.000Z',
      lastProgressAt: '2026-08-03T00:59:00.000Z',
      expiresAt: '2026-08-03T02:00:00.000Z',
    });
  });
});

describe('openness is `status`, never `closed_ts` (recurrence guard)', () => {
  // This module originally filtered open items with `closed_ts IS NULL`. That is
  // wrong, and wrong in a way no unit test would have caught, because the pure
  // half never sees the predicate.
  //
  // Measured live 2026-08-03: closed_ts is NULL on 77.4% of `done` rows, 98.8%
  // of `resolved`, 91.5% of `dropped` and 100% of `closed` — 13,000+ terminal
  // rows carry no close stamp. `directive-effect.ts` reads it as
  // `closed_ts ?? updated_ts` ("the precise stamp; updated_ts is the fallback"),
  // i.e. a best-effort timestamp, not an openness predicate.
  //
  // The cost of a regression here is not a bad read but a PERMANENT one: P-002's
  // singleton index would treat stamp-less terminal rows as live owners, so a
  // resolved-then-reopened condition could never mint a new owner again.
  //
  // A source-level assertion is the only thing that can catch this without a
  // database, and this trap is expensive enough to be worth one.
  it('does not use closed_ts as an openness predicate', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-object.ts', import.meta.url), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments (which discuss closed_ts on purpose)
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/closed_ts/);
    // ...and it DOES derive the terminal set from the shared constant rather
    // than re-listing the words (EI-18653071581558556: hand-copied unions drift).
    expect(code).toMatch(/ANY_FAMILY_TERMINAL_STATES/);
  });

  it('the shared terminal set still covers every terminal status we measured', async () => {
    // If someone narrows ANY_FAMILY_TERMINAL_STATES, this resolver silently
    // starts reporting finished work-items as live condition owners.
    const { ANY_FAMILY_TERMINAL_STATES } = await import('../work-item-dispatch-states');
    for (const s of ['done', 'resolved', 'dropped', 'closed', 'passed', 'deprecated']) {
      expect(ANY_FAMILY_TERMINAL_STATES).toContain(s);
    }
  });
});

describe('vocabulary', () => {
  it('reuses the existing `about` rel rather than inventing one', () => {
    // `about` is already in LINK_RELS ("this item concerns a target — a topic,
    // event key, or object"). A new rel here would be a parallel surface for a
    // relationship the substrate already names.
    expect(CONDITION_LINK_REL).toBe('about');
  });
});
