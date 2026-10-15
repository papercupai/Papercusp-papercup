import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS,
  CARRY_BLIND_WINDOW_MIN_MS,
  buildCarryBlindWindow,
  cutAtFromRespawn,
  readCarryBlindWindow,
  renderCarryBlindWindowLine,
} from './carry-blind-window';
import type { PriorRespawn } from './carry-respawn-outcome';

/**
 * EI-21442716425230784 — the arithmetic behind the successor's blind-window line.
 *
 * The failure being guarded is asymmetric, and the tests below are ordered by it:
 * a MISSED window costs the successor one `sessions:read`, while a MANUFACTURED
 * one sends it hunting turns that never happened and teaches it to distrust the
 * line entirely. So every null-returning case here is a deliberate silence, not
 * an oversight, and each is asserted separately rather than as one "invalid input"
 * clump — they are different claims about what the tool may not invent.
 */
describe('carry blind window', () => {
  const T = Date.parse('2026-08-25T16:13:55.000Z');
  const CUT = Date.parse('2026-08-25T16:17:52.000Z'); // the real incident's ~4m gate wait
  const ok = {
    snapshotAtMs: T,
    cutAtMs: CUT,
    callsAfter: 26,
    lastCallAtMs: Date.parse('2026-08-25T16:17:33.000Z'),
    lastToolName: 'capability:bash',
    nowMs: CUT + 20_000,
  };

  it('measures the window the reported incident actually had', () => {
    const w = buildCarryBlindWindow(ok);
    expect(w).not.toBeNull();
    expect(w!.windowMs).toBe(CUT - T);
    expect(w!.callsAfter).toBe(26);
    expect(w!.lastToolName).toBe('capability:bash');
  });

  it('renders a COUNT, the window, and the retrieval verb — the three things prose lacked', () => {
    const line = renderCarryBlindWindowLine(buildCarryBlindWindow(ok)!);
    // The count is what makes the warning falsifiable: without it a successor
    // cannot tell an empty window from one holding an owner-facing deliverable.
    expect(line).toMatch(/26 tool call\(s\)/);
    expect(line).toMatch(/3m57s/);
    expect(line).toMatch(/2026-08-25T16:13:55Z/);
    // A warning with no recovery move is the prose this replaces.
    expect(line).toMatch(/sessions:read \{ session:'self' \}/);
  });

  it('says NOTHING when the window was genuinely empty', () => {
    // Zero measured calls is an ANSWER — the carry really is complete — and it is
    // only reachable when the count was measured, so silence here is correct.
    expect(buildCarryBlindWindow({ ...ok, callsAfter: 0 })).toBeNull();
  });

  it('says NOTHING when either endpoint is unmeasured — never invents a window', () => {
    expect(buildCarryBlindWindow({ ...ok, snapshotAtMs: null })).toBeNull();
    expect(buildCarryBlindWindow({ ...ok, cutAtMs: null })).toBeNull();
    expect(buildCarryBlindWindow({ ...ok, callsAfter: null })).toBeNull();
    expect(buildCarryBlindWindow({ ...ok, snapshotAtMs: Number.NaN })).toBeNull();
  });

  it('says NOTHING when the cut precedes the snapshot (mismatched pair / clock skew)', () => {
    expect(buildCarryBlindWindow({ ...ok, cutAtMs: T - 1_000 })).toBeNull();
  });

  it('says NOTHING for the ordinary build→inject latency, only for a real gate wait', () => {
    const brief = { ...ok, cutAtMs: T + CARRY_BLIND_WINDOW_MIN_MS - 1, nowMs: T + 60_000 };
    expect(buildCarryBlindWindow(brief)).toBeNull();
    const gateWait = { ...ok, cutAtMs: T + CARRY_BLIND_WINDOW_MIN_MS, nowMs: T + 60_000 };
    expect(buildCarryBlindWindow(gateWait)).not.toBeNull();
  });

  it('stops being news once the successor has demonstrably moved on', () => {
    // A warning that is always on is one nobody reads. Past the age cap the
    // successor has taken many turns and the perishable content is stale.
    expect(
      buildCarryBlindWindow({ ...ok, nowMs: CUT + CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS + 1 }),
    ).toBeNull();
    expect(
      buildCarryBlindWindow({ ...ok, nowMs: CUT + CARRY_BLIND_WINDOW_MAX_CUT_AGE_MS - 1 }),
    ).not.toBeNull();
  });

  /**
   * The cut timestamp may ONLY come from a delivered verdict. A `pending` or
   * `dropped` respawn describes a cut that has not happened — dating a window
   * from one would measure an interval the predecessor never reached, and the
   * `pending` case is the dangerous one because it is the ordinary steady state
   * of a respawn still waiting on the busy-gate.
   */
  it('takes a cut timestamp ONLY from a delivered respawn verdict', () => {
    const ts = '2026-08-25T16:17:52.000Z';
    expect(cutAtFromRespawn({ outcome: 'delivered', ts })).toBe(Date.parse(ts));
    expect(cutAtFromRespawn({ outcome: 'pending', ts })).toBeNull();
    expect(cutAtFromRespawn({ outcome: 'dropped', ts })).toBeNull();
    expect(cutAtFromRespawn({ outcome: 'none' })).toBeNull();
    expect(cutAtFromRespawn({ outcome: 'delivered' })).toBeNull();
    expect(cutAtFromRespawn({ outcome: 'delivered', ts: 'not-a-date' })).toBeNull();
    expect(cutAtFromRespawn(null)).toBeNull();
  });

  /**
   * The count is bounded at the CUT, which is what makes the rendered line a
   * ONE-SHOT: the coord ownerId survives the respawn, so a count bounded at
   * "now" would keep growing with the successor's OWN calls and re-emit a
   * different line every turn. This asserts the property the fingerprint token
   * depends on — same inputs, byte-identical line, however late it is read.
   */
  it('is stable across re-reads, so the line renders once per respawn', () => {
    const first = buildCarryBlindWindow({ ...ok, nowMs: CUT + 1_000 })!;
    const later = buildCarryBlindWindow({ ...ok, nowMs: CUT + 10 * 60_000 })!;
    expect(`${later.cutAtMs}:${later.callsAfter}`).toBe(`${first.cutAtMs}:${first.callsAfter}`);
    expect(renderCarryBlindWindowLine(later)).toBe(renderCarryBlindWindowLine(first));
  });

  it('excludes automatic hook telemetry from the database-counted predecessor window', async () => {
    const cutAtMs = Date.parse('2026-10-03T04:53:51.000Z');
    let capturedQuery = '';
    const render = (value: unknown): string => {
      if (value && typeof value === 'object' && 'sqlText' in value) {
        return String((value as { sqlText: string }).sqlText);
      }
      return '$value';
    };
    const fakeSql = Object.assign(
      (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.reduce(
          (text, part, index) => `${text}${part}${index < values.length ? render(values[index]) : ''}`,
          '',
        );
        if (query.includes('WITH snapshot AS')) {
          capturedQuery = query;
          return Promise.resolve([{
            snapshot_at: new Date(cutAtMs - 60_000),
            calls_after: 0,
            last_call_at: null,
            last_tool: null,
          }]);
        }
        return { sqlText: query };
      },
      {
        unsafe: (sqlText: string) => ({ sqlText }),
        array: (values: unknown[]) => ({ sqlText: `ARRAY[${values.map(value => JSON.stringify(value)).join(',')}]` }),
      },
    ) as unknown as Sql;

    const prior: PriorRespawn = {
      outcome: 'delivered',
      ts: new Date(cutAtMs).toISOString(),
    } as PriorRespawn;
    const result = await readCarryBlindWindow('owner-1', {
      workspaceId: 'papercusp-workspace',
      now: cutAtMs + 10_000,
      sql: fakeSql,
      prior,
    });

    expect(result).toBeNull();
    expect(capturedQuery).toContain('t.call_origin');
    expect(capturedQuery).toContain('activity:report');
  });
});
