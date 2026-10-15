/**
 * describe-leg.test.ts — WI-10005676.
 *
 * `describeLeg` / `describeSearchLegs` are the ONE projection of the engine's leg
 * report shared by `search:semantic` and `sessions:search`. Two projections of one
 * verdict drift, so the contract is pinned here once: `candidates` is ALWAYS stated
 * (it is the number that separates "the leg ran and found nothing" from "the leg
 * never ran"), while `floored`, `blocked` and `failures` appear only when non-zero /
 * set so a healthy search stays compact.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/search/describe-leg.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { LegReport, SearchLegs } from '@papercusp/search';
import { describeLeg, describeSearchLegs } from './describe-leg';

function leg(over: Partial<LegReport> = {}): LegReport {
  return {
    status: 'ran',
    candidates: 5,
    floored: 0,
    stage2Added: 0,
    callsRun: 1,
    callsFailed: 0,
    failures: [],
    blocked: null,
    ...over,
  };
}

describe('describeLeg', () => {
  it('keeps successful empty, blocked and deadline source receipts in the tool result', () => {
    const sourceCalls: NonNullable<LegReport['sourceCalls']> = [
      { source: 'doc',ranker: 'lexical',status: 'ran',rows: 0,durationMs: 2,reason: null },
      { source: 'plan',ranker: 'lexical',status: 'timed-out',rows: null,durationMs: 10,reason: 'source deadline' },
      { source: 'report',ranker: 'embeddings',status: 'blocked',rows: null,durationMs: 0,reason: 'embed unavailable' },
    ];
    expect(describeLeg(leg({ sourceCalls })).sourceCalls).toEqual(sourceCalls);
  });
  it('states candidates even when zero — the number that distinguishes an empty leg from an absent one', () => {
    expect(describeLeg(leg({ candidates: 0 }))).toEqual({ status: 'ran', candidates: 0 });
  });

  it('omits floored / blocked / failures on a healthy leg so the result stays compact', () => {
    const out = describeLeg(leg());
    expect(out).toEqual({ status: 'ran', candidates: 5 });
    expect(out).not.toHaveProperty('floored');
    expect(out).not.toHaveProperty('blocked');
    expect(out).not.toHaveProperty('failures');
  });

  it('reports floored only when the score floor actually removed rows', () => {
    expect(describeLeg(leg({ candidates: 0, floored: 7 }))).toEqual({
      status: 'ran',
      candidates: 0,
      floored: 7,
    });
  });

  it('reports a blocked leg with its reason (nothing was even attempted)', () => {
    expect(
      describeLeg(leg({ status: 'not-run', candidates: 0, blocked: 'query embed failed: timeout' })),
    ).toEqual({ status: 'not-run', candidates: 0, blocked: 'query embed failed: timeout' });
  });

  it('projects only source/ranker/error from each failure — never the raw accumulator fields', () => {
    const out = describeLeg(
      leg({
        status: 'errored',
        callsFailed: 1,
        failures: [{ source: 'session_turn', ranker: 'semantic', error: 'boom' }],
      }),
    );
    expect(out.failures).toEqual([{ source: 'session_turn', ranker: 'semantic', error: 'boom' }]);
    expect(out).not.toHaveProperty('callsFailed');
    expect(out).not.toHaveProperty('stage2Added');
  });
});

describe('describeSearchLegs', () => {
  it('carries degraded + warning and projects BOTH legs', () => {
    const legs: SearchLegs = {
      degraded: true,
      warning: 'semantic leg contributed 0 candidates',
      lexical: leg({ candidates: 12 }),
      semantic: leg({ candidates: 0 }),
    };
    expect(describeSearchLegs(legs)).toEqual({
      degraded: true,
      warning: 'semantic leg contributed 0 candidates',
      lexical: { status: 'ran', candidates: 12 },
      semantic: { status: 'ran', candidates: 0 },
    });
  });

  it('reports a healthy search as not degraded with a null warning', () => {
    const out = describeSearchLegs({
      degraded: false,
      warning: null,
      lexical: leg(),
      semantic: leg({ candidates: 9 }),
    });
    expect(out.degraded).toBe(false);
    expect(out.warning).toBeNull();
  });
});
