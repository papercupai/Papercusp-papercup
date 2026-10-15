/**
 * directive-effect.test.ts — P-013.
 *
 * The fixture below (`row`) is the REAL column set `fetchDirectiveActuations`
 * selects, not a convenient invention. That is deliberate and load-bearing: a
 * fixture shaped for the test rather than for the query is how eleven green unit
 * tests came to assert nothing at all in this same plan (P-020), so a column rename
 * must red these tests rather than silently read `undefined`.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDirectiveEffect,
  actuationLine,
  summarizeActuations,
  DIRECTIVE_EFFECT_KINDS,
  type DirectiveEffectRow,
  type DirectiveActuation,
} from './directive-effect';

const SENT = Date.UTC(2026, 7, 1, 12, 0, 0);
const AFTER = SENT + 60_000;
const BEFORE = SENT - 60_000;

/** The exact shape of a `fetchDirectiveActuations` row (bigints as strings, as
 *  postgres-js returns them). */
function row(over: Partial<DirectiveEffectRow> = {}): DirectiveEffectRow {
  return {
    feature_id: 'WI-100',
    harness_slug: 'papercusp',
    status: 'open',
    taken_by: null,
    terminal_owner: null,
    completion_authority: null,
    completion_evidence: null,
    last_released_ms: null,
    closed_ts: null,
    updated_ts: null,
    checkpoint_ms: null,
    ...over,
  };
}

describe('resolveDirectiveEffect — checkpoint', () => {
  it('SATISFIED when a checkpoint was written after the directive', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({ checkpoint_ms: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('satisfied');
    expect(a.observedAtMs).toBe(AFTER);
  });

  it('PRE-EXISTING when the only checkpoint predates the directive — never credited', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({ checkpoint_ms: String(BEFORE) }),
      SENT,
    );
    expect(a.verdict).toBe('pre-existing');
    expect(a.evidence).toMatch(/OLDER than the directive/);
  });

  it('NOT-YET when no checkpoint has ever been written', () => {
    const a = resolveDirectiveEffect({ kind: 'checkpoint', itemId: 'WI-100' }, row(), SENT);
    expect(a.verdict).toBe('not-yet');
  });

  it('accepts a numeric (already-coerced) timestamp as well as the string form', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({ checkpoint_ms: AFTER }),
      SENT,
    );
    expect(a.verdict).toBe('satisfied');
  });

  it('recognises committed terminal completion evidence as an alternative durable proof', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({
        status: 'done',
        terminal_owner: 'su-closer',
        completion_authority: 'committed',
        completion_evidence: {
          verifiedHow: 'unit',
          testsRun: 'npm run test:file -- checkpoint.test.ts',
          testResult: 'PASS',
        },
        closed_ts: String(BEFORE),
      }),
      SENT,
    );
    expect(a.verdict).toBe('pre-existing');
    expect(a.alternativeProof).toBe('terminal-completion');
    expect(a.evidence).toMatch(/no additional checkpoint write is possible or required/);
  });

  it('does not treat a proposed terminal record as durable checkpoint proof', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({
        status: 'done',
        terminal_owner: 'su-closer',
        completion_authority: 'proposed',
        completion_evidence: {
          verifiedHow: 'unit',
          testsRun: 'npm run test:file -- checkpoint.test.ts',
          testResult: 'PASS',
        },
      }),
      SENT,
    );
    expect(a.verdict).toBe('not-yet');
    expect(a.alternativeProof).toBeUndefined();
  });

  it('keeps terminal completion as pre-existing for generic effect attribution even when it closed later', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({
        status: 'done',
        terminal_owner: 'su-closer',
        completion_authority: 'committed',
        completion_evidence: JSON.stringify({
          verifiedHow: 'integration',
          testsRun: 'npm run test:file -- checkpoint.test.ts',
          testResult: 'PASS',
        }),
        closed_ts: String(AFTER),
      }),
      SENT,
    );
    expect(a.verdict).toBe('pre-existing');
    expect(a.alternativeProof).toBe('terminal-completion');
  });

  it('rejects a committed row whose persisted evidence is insufficient', () => {
    const a = resolveDirectiveEffect(
      { kind: 'checkpoint', itemId: 'WI-100' },
      row({
        status: 'done',
        terminal_owner: 'su-closer',
        completion_authority: 'committed',
        completion_evidence: { summary: 'closed' },
      }),
      SENT,
    );
    expect(a.verdict).toBe('not-yet');
    expect(a.alternativeProof).toBeUndefined();
  });
});

describe('resolveDirectiveEffect — claim-release', () => {
  it('NOT-YET while the item is still held, naming the holder', () => {
    const a = resolveDirectiveEffect(
      { kind: 'claim-release', itemId: 'WI-100' },
      row({ taken_by: 'su-abc' }),
      SENT,
    );
    expect(a.verdict).toBe('not-yet');
    expect(a.evidence).toContain('su-abc');
  });

  it('SATISFIED when released after the directive', () => {
    const a = resolveDirectiveEffect(
      { kind: 'claim-release', itemId: 'WI-100' },
      row({ last_released_ms: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('satisfied');
    expect(a.observedAtMs).toBe(AFTER);
  });

  it('PRE-EXISTING when the item was already free before the directive', () => {
    const a = resolveDirectiveEffect(
      { kind: 'claim-release', itemId: 'WI-100' },
      row({ last_released_ms: String(BEFORE) }),
      SENT,
    );
    expect(a.verdict).toBe('pre-existing');
  });

  it('UNKNOWN — not "not-yet" — for a row with no release history (issue family)', () => {
    // The false-miss guard. An issue-family row carries no last_released_at at all,
    // so an unheld item is unprovable, and must never be reported as ignored.
    const a = resolveDirectiveEffect(
      { kind: 'claim-release', itemId: 'EI-77' },
      row({ feature_id: 'EI-77', taken_by: '', last_released_ms: null }),
      SENT,
    );
    expect(a.verdict).toBe('unknown');
    expect(a.evidence).toMatch(/no release timestamp is recorded/);
  });
});

describe('resolveDirectiveEffect — terminal', () => {
  it('NOT-YET while the item is still open', () => {
    const a = resolveDirectiveEffect({ kind: 'terminal', itemId: 'WI-100' }, row({ status: 'open' }), SENT);
    expect(a.verdict).toBe('not-yet');
  });

  it('SATISFIED when closed after the directive', () => {
    const a = resolveDirectiveEffect(
      { kind: 'terminal', itemId: 'WI-100' },
      row({ status: 'done', closed_ts: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('satisfied');
  });

  it('does not credit a later row update when the terminal transition is undated', () => {
    const a = resolveDirectiveEffect(
      { kind: 'terminal', itemId: 'WI-100' },
      row({ status: 'resolved', closed_ts: null, updated_ts: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('unknown');
    expect(a.observedAtMs).toBeNull();
    expect(a.evidence).toContain('no close timestamp');
  });

  it('PRE-EXISTING when it was already terminal before the directive', () => {
    const a = resolveDirectiveEffect(
      { kind: 'terminal', itemId: 'WI-100' },
      row({ status: 'done', closed_ts: String(BEFORE), updated_ts: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('pre-existing');
    expect(a.evidence).toMatch(/ALREADY/);
  });

  it('UNKNOWN when terminal but undatable', () => {
    const a = resolveDirectiveEffect(
      { kind: 'terminal', itemId: 'WI-100' },
      row({ status: 'done', closed_ts: null, updated_ts: null }),
      SENT,
    );
    expect(a.verdict).toBe('unknown');
  });

  it('recognises a legacy/aliased terminal spelling, not just the unified enum', () => {
    // `passed` is terminal only after aliasing — this is why the shared
    // isTerminalStateInput is used instead of a local hardcoded list.
    const a = resolveDirectiveEffect(
      { kind: 'terminal', itemId: 'WI-100' },
      row({ status: 'passed', closed_ts: String(AFTER) }),
      SENT,
    );
    expect(a.verdict).toBe('satisfied');
  });
});

describe('resolveDirectiveEffect — missing row', () => {
  it('UNKNOWN (never not-yet) when the item cannot be resolved at all', () => {
    for (const kind of DIRECTIVE_EFFECT_KINDS) {
      const a = resolveDirectiveEffect({ kind, itemId: 'WI-nope' }, null, SENT);
      expect(a.verdict).toBe('unknown');
      expect(a.evidence).toMatch(/not found/);
    }
  });
});

describe('actuationLine + summarizeActuations', () => {
  const mk = (verdict: DirectiveActuation['verdict'], itemId: string): DirectiveActuation => ({
    spec: { kind: 'checkpoint', itemId },
    verdict,
    observedAtMs: null,
    evidence: 'e',
  });

  it('labels each verdict distinguishably', () => {
    expect(actuationLine(mk('satisfied', 'A'))).toMatch(/ACTED ON/);
    expect(actuationLine(mk('not-yet', 'B'))).toMatch(/NOT ACTED ON/);
    expect(actuationLine(mk('pre-existing', 'C'))).toMatch(/PRE-EXISTING/);
    expect(actuationLine(mk('unknown', 'D'))).toMatch(/UNPROVABLE/);
  });

  it('counts only not-yet as outstanding — pre-existing/unknown are never fabricated misses', () => {
    const s = summarizeActuations([
      mk('satisfied', 'A'),
      mk('not-yet', 'B'),
      mk('pre-existing', 'C'),
      mk('unknown', 'D'),
    ]);
    expect(s).toMatchObject({ total: 4, satisfied: 1, notYet: 1, unprovable: 2 });
    expect(s.outstanding).toHaveLength(1);
    expect(s.outstanding[0]).toContain('B');
  });

  it('caps the outstanding list without capping the count', () => {
    const s = summarizeActuations(
      [mk('not-yet', 'A'), mk('not-yet', 'B'), mk('not-yet', 'C'), mk('not-yet', 'D')],
      2,
    );
    expect(s.notYet).toBe(4);
    expect(s.outstanding).toHaveLength(2);
  });
});
