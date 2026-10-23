/**
 * timeout-fallback.test.ts — the PG-free guidance + dead-drop detector
 * (await-timeout-fallback-defaults-2026-07-03 P-003/P-004/P-006).
 *
 * Pure unit tests — no Docker/testcontainers. Covers:
 *  - eventKeyFamily: id-bearing segments collapse to `*`, static words survive.
 *  - summarizeTimeoutFires: groups by family, sorts desc by count then family,
 *    dedupes + caps raw keys.
 *  - recordTimeoutFires: edge-triggers exactly once at the crossing of the warn
 *    threshold (with __resetTimeoutFireTotals between cases).
 *  - the guidance strings say "re-orient" + "re-arm" (the whole point of P-004).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  eventKeyFamily,
  summarizeTimeoutFires,
  recordTimeoutFires,
  timeoutFireTotals,
  __resetTimeoutFireTotals,
  TIMEOUT_FIRE_WARN_THRESHOLD,
  TIMEOUT_WAKE_SUMMARY,
  TIMEOUT_WAKE_GUIDANCE,
  buildPredicateTimeoutFallback,
  buildPredicateTimeoutRecovery,
} from './timeout-fallback';

describe('eventKeyFamily — collapse id-bearing segments to `*`', () => {
  it('collapses a segment with a digit anywhere', () => {
    expect(eventKeyFamily('lock:grant:t123')).toBe('lock:grant:*');
    expect(eventKeyFamily('lock:grant:t456')).toBe('lock:grant:*');
    expect(eventKeyFamily('work-item:done:WI-1')).toBe('work-item:done:*');
    expect(eventKeyFamily('plan-item:done:my-plan:7')).toBe('plan-item:done:my-plan:*');
  });

  it('collapses a long hex/uuid run even with no digits', () => {
    // 16+ chars, all [a-f] — a hex id with no digit still matches the hex rule.
    expect(eventKeyFamily('session:deadbeefdeadbeef')).toBe('session:*');
    expect(eventKeyFamily('sub:abcdefabcdefabcdef01')).toBe('sub:*');
  });

  it('preserves static words (no id) — they name the family', () => {
    expect(eventKeyFamily('deploy:finished')).toBe('deploy:finished');
    expect(eventKeyFamily('git-sync:pushed')).toBe('git-sync:pushed');
    expect(eventKeyFamily('service:up')).toBe('service:up');
    // a short hex-looking word (<16 chars, no digit) is NOT an id → kept
    expect(eventKeyFamily('session:abc')).toBe('session:abc');
  });

  it('two keys that differ only by id land in the SAME family', () => {
    expect(eventKeyFamily('fleet:drained:red-team-9')).toBe(eventKeyFamily('fleet:drained:red-team-42'));
  });

  it('keys with different static shapes stay in DIFFERENT families', () => {
    expect(eventKeyFamily('lock:grant:t1')).not.toBe(eventKeyFamily('lock:release:t1'));
  });
});

describe('summarizeTimeoutFires — group + rank per-sweep fires', () => {
  it('groups by family and counts each', () => {
    const out = summarizeTimeoutFires([
      { eventKey: 'lock:grant:t1' },
      { eventKey: 'lock:grant:t2' },
      { eventKey: 'deploy:finished' },
    ]);
    const byFam = Object.fromEntries(out.map((s) => [s.family, s.count]));
    expect(byFam['lock:grant:*']).toBe(2);
    expect(byFam['deploy:finished']).toBe(1);
  });

  it('sorts most-frequent family first, ties broken by family name asc', () => {
    const out = summarizeTimeoutFires([
      { eventKey: 'deploy:finished' },
      { eventKey: 'lock:grant:t1' },
      { eventKey: 'lock:grant:t2' },
      { eventKey: 'lock:grant:t3' },
      { eventKey: 'aaa:done' },
      { eventKey: 'zzz:done' },
    ]);
    expect(out[0]).toMatchObject({ family: 'lock:grant:*', count: 3 });
    // the two 1-count families tie → alphabetical: aaa:done before zzz:done
    const ones = out.filter((s) => s.count === 1).map((s) => s.family);
    expect(ones).toEqual(['aaa:done', 'deploy:finished', 'zzz:done']);
  });

  it('dedupes raw keys within a family and caps the sample at 10', () => {
    const awaits = Array.from({ length: 25 }, (_, i) => ({ eventKey: `lock:grant:t${i}` }));
    // add a duplicate raw key — must not appear twice
    awaits.push({ eventKey: 'lock:grant:t0' });
    const out = summarizeTimeoutFires(awaits);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe('lock:grant:*');
    expect(out[0].count).toBe(26); // every await counted…
    expect(out[0].keys.length).toBe(10); // …but the raw-key sample is capped
    expect(new Set(out[0].keys).size).toBe(out[0].keys.length); // deduped
  });

  it('returns [] for an empty sweep', () => {
    expect(summarizeTimeoutFires([])).toEqual([]);
  });
});

describe('recordTimeoutFires — edge-triggered dead-drop warning', () => {
  beforeEach(() => __resetTimeoutFireTotals());

  it('does NOT warn below the threshold, then fires exactly ONCE at the crossing', () => {
    // 9 accumulated → no crossing yet
    expect(recordTimeoutFires([{ family: 'lock:grant:*', count: 9, keys: [] }])).toEqual([]);
    expect(timeoutFireTotals()['lock:grant:*']).toBe(9);

    // +1 → total 10 == threshold → crosses NOW, reported once
    const crossed = recordTimeoutFires([{ family: 'lock:grant:*', count: 1, keys: [] }]);
    expect(crossed).toEqual([{ family: 'lock:grant:*', total: 10 }]);

    // subsequent sweeps keep accumulating but never re-report the same family
    expect(recordTimeoutFires([{ family: 'lock:grant:*', count: 5, keys: [] }])).toEqual([]);
    expect(timeoutFireTotals()['lock:grant:*']).toBe(15);
  });

  it('crosses on a single sweep that jumps past the threshold', () => {
    const crossed = recordTimeoutFires([{ family: 'x:y:*', count: TIMEOUT_FIRE_WARN_THRESHOLD + 3, keys: [] }]);
    expect(crossed).toEqual([{ family: 'x:y:*', total: TIMEOUT_FIRE_WARN_THRESHOLD + 3 }]);
  });

  it('tracks families independently — only the one that crosses is reported', () => {
    const crossed = recordTimeoutFires([
      { family: 'hot:*', count: 10, keys: [] },
      { family: 'cold:*', count: 2, keys: [] },
    ]);
    expect(crossed).toEqual([{ family: 'hot:*', total: 10 }]);
    expect(timeoutFireTotals()['cold:*']).toBe(2);
  });

  it('__resetTimeoutFireTotals clears the lifetime counter', () => {
    recordTimeoutFires([{ family: 'a:*', count: 20, keys: [] }]);
    expect(timeoutFireTotals()['a:*']).toBe(20);
    __resetTimeoutFireTotals();
    expect(timeoutFireTotals()).toEqual({});
    // after reset the family can cross again
    expect(recordTimeoutFires([{ family: 'a:*', count: 10, keys: [] }])).toEqual([{ family: 'a:*', total: 10 }]);
  });
});

describe('timeout-wake guidance strings (P-004)', () => {
  it('the summary bounds the timeout to its deadline and tells the agent to check current state', () => {
    expect(TIMEOUT_WAKE_SUMMARY).toMatch(/deadline passed without the event firing/i);
    expect(TIMEOUT_WAKE_SUMMARY).toMatch(/may have fired since/i);
    expect(TIMEOUT_WAKE_SUMMARY).toMatch(/events:status/i);
    expect(TIMEOUT_WAKE_SUMMARY).toMatch(/re-orient/i);
    expect(TIMEOUT_WAKE_SUMMARY).toMatch(/re-arm/i);
  });

  it('the structured guidance frames the wake as a FALLBACK, not the event', () => {
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/not observed by its deadline/i);
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/may have fired since/i);
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/events:status/i);
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/fallback/i);
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/re-orient/i);
    expect(TIMEOUT_WAKE_GUIDANCE).toMatch(/re-arm/i);
  });
});

describe('predicate timeout recovery', () => {
  it('carries a one-call watch:create spec and explicitly avoids the expired key', () => {
    const recovery = buildPredicateTimeoutRecovery({
      spec: {
        tool: 'state:read',
        args: { cell: 'gate.greenCheckpoint.verdict' },
        path: 'value.sha',
        op: 'changed',
        intervalSec: 30,
        once: true,
      },
      timeoutSec: 3600,
    });
    expect(recovery).toEqual({
      tool: 'watch:create',
      args: {
        pattern: 'predicate-timeout-recovery',
        wake: true,
        once: true,
        interval_sec: 30,
        on_timeout: 'wake',
        timeout_sec: 3600,
        predicate: {
          tool: 'state:read',
          args: { cell: 'gate.greenCheckpoint.verdict' },
          path: 'value.sha',
          op: 'changed',
        },
      },
    });

    const fallback = buildPredicateTimeoutFallback('predicate:expired-id', recovery);
    expect(fallback.summary).toContain('do not re-arm the expired key');
    expect(fallback.summary).toContain('let its own wake registration notify you');
    expect(fallback.guidance).toContain('Do NOT call events:await on this expired key');
    expect(fallback.guidance).toContain('predicateRecovery.args');
    expect(fallback.guidance).toContain('watch:create registers the new predicate wake itself');
    expect(fallback.guidance).toContain('Do NOT call events:await on the returned watch.pattern');
    expect(fallback.predicateRecovery).toEqual(recovery);
  });

  it('keeps the no-spec fallback safe when the retired registration cannot be recovered', () => {
    const fallback = buildPredicateTimeoutFallback('predicate:expired-id');
    expect(fallback.guidance).toContain('Do NOT call events:await on this expired key');
    expect(fallback.guidance).toContain('the new registration owns its wake/subscription');
    expect(fallback.guidance).toContain('Do NOT call events:await on the returned key');
    expect(fallback.guidance).toContain('Recover the original predicate specification');
    expect(fallback).not.toHaveProperty('predicateRecovery');
  });
});
