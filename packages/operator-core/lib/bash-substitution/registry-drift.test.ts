/**
 * registry-drift.test.ts — the DB-projection drift check
 * (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 * These tests exist because the check they cover found a defect the moment it
 * ran: FOUR stale rows, not the three that were known. The unknown fourth was
 * `host-job-liveness-query`, whose stored `bash_pattern` had diverged from the
 * pair's — so both PreToolUse hooks were matching commands with a DIFFERENT
 * REGEX than the one the `not-a-substitute` verdict was earned under. That is
 * WI-5998's hazard (enforcement divorced from its evidence) in the pattern
 * dimension rather than the flags dimension, and no test or gate could see it.
 *
 * So the cases below are not decoration: each one is a drift SHAPE that was
 * live in the table, or that the seeder's own `ON CONFLICT` semantics make
 * possible. Run:
 *   npm run test:file -- packages/operator-core/lib/bash-substitution/registry-drift.test.ts
 */
import { describe, expect, it } from 'vitest';
import { loadPairFixtures } from './corpus';
import type { SubstitutionRow } from './match';
import { BASH_GATE_PAIRS } from './pairs';
import { diffRegistry, expectedRows, formatDrift, registryCheckVerdict, type ExpectedRow } from './registry-drift';

/** A seeded row that agrees with `want` on every compared field. */
function rowFor(want: ExpectedRow, overrides: Partial<SubstitutionRow> = {}): SubstitutionRow {
  return {
    intentLabel: want.intentLabel,
    bashPattern: want.bashPattern,
    bashPatternFlags: want.bashPatternFlags,
    toolName: want.toolName,
    // `want.tier` is set only for a pair that OWNS its tier (D-046); everything
    // else enters the registry at `observe` and is promoted by an observation
    // window. Defaulting to `observe` unconditionally — as this helper did
    // before tier became comparable — would have made the agreeing row DISAGREE
    // with the one pair whose tier is checked, i.e. the helper named "agrees on
    // every compared field" would have manufactured drift for exactly the row
    // the new comparison exists to protect.
    tier: want.tier ?? 'observe',
    advisoryText: want.advisoryText,
    equivalenceVerdict: want.equivalenceVerdict,
    ...overrides,
  };
}

/**
 * The intent label of the one pair that DECLARES its own tier, resolved from the
 * pairs rather than hardcoded.
 *
 * Hardcoding `'policy-violation:unsafe-dependency-install'` would let these tests
 * keep passing while silently covering nothing the day that pair is renamed or
 * retired — the pattern this suite's own header calls out as enforcement divorced
 * from its evidence. The assertion below makes the population itself the subject.
 */
const POLICY_PAIRS = BASH_GATE_PAIRS.filter((p) => p.policyTier !== undefined);

describe('expectedRows', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('derives one row per audited pair', () => {
    expect(expected).toHaveLength(BASH_GATE_PAIRS.length);
    expect(new Set(expected.map((e) => e.intentLabel)).size).toBe(BASH_GATE_PAIRS.length);
  });

  /**
   * The verdict must come from the SAMPLE, not from the pair's recorded
   * `expectedVerdict` — otherwise this check compares one hand-written claim
   * against another and can never detect that the evidence moved.
   */
  it('recomputes the verdict from the frozen sample rather than copying expectedVerdict', () => {
    for (const pair of BASH_GATE_PAIRS) {
      const row = expected.find((e) => e.intentLabel === pair.intentLabel);
      expect(row, `${pair.id} produced no expected row`).toBeDefined();
      expect(row!.equivalenceVerdict).toBe(pair.expectedVerdict);
    }
  });

  /**
   * The conditional half of D-046. `tier` must be present for exactly the pairs
   * that own one — a row with `tier: undefined` is not "unknown", it is an
   * explicit statement that the DATABASE owns that field and drift must not be
   * reported on it.
   */
  it('carries a tier expectation for exactly the pairs that declare one', () => {
    const withTier = expected.filter((e) => e.tier !== undefined).map((e) => e.intentLabel);
    expect(withTier.sort()).toEqual(POLICY_PAIRS.map((p) => p.intentLabel).sort());

    for (const pair of POLICY_PAIRS) {
      const row = expected.find((e) => e.intentLabel === pair.intentLabel)!;
      // The value must be what the SEEDER would write, which is the authorized
      // tier rather than the raw declaration — same function, both sides.
      expect(row.tier).toBe(pair.policyTier);
    }
  });

  it('carries the pattern SOURCE and FLAGS separately, as the registry stores them', () => {
    for (const pair of BASH_GATE_PAIRS) {
      const row = expected.find((e) => e.intentLabel === pair.intentLabel)!;
      expect(row.bashPattern).toBe(pair.bashPattern.source);
      expect(row.advisoryText).toBe(pair.advisoryText);
    }
  });
});

describe('registryCheckVerdict (measured 2026-10-27: gate leg red on an unseeded private DB)', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('calls an EMPTY registry unseeded (nothing compared), never drift', () => {
    expect(expected.length).toBeGreaterThan(0);
    expect(registryCheckVerdict(expected, [])).toEqual({ kind: 'unseeded' });
  });

  it('still reports real drift and a clean match on a seeded registry', () => {
    const rows = expected.map((e) => rowFor(e));
    expect(registryCheckVerdict(expected, rows)).toEqual({ kind: 'clean' });
    const missingOne = registryCheckVerdict(expected, rows.slice(1));
    expect(missingOne.kind).toBe('drift');
    expect(missingOne.kind === 'drift' ? missingOne.drifts.length : 0).toBeGreaterThan(0);
  });
});

describe('diffRegistry', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('reports NO drift when the table matches the pairs', () => {
    expect(diffRegistry(expected, expected.map((e) => rowFor(e)))).toEqual([]);
  });

  it('ignores an EARNED tier, so a row promoted by an observation window is not called drifted', () => {
    // P-020 promotion is state the seeder deliberately does NOT overwrite.
    // Flagging it would report the system working correctly and train the
    // reader to ignore the report.
    //
    // Promote every row whose tier the DATABASE owns — not just the first one.
    // Picking a single index (which is what this test did before D-046) passes
    // just as well when the comparison is broken for ordinary rows generally,
    // and would silently stop covering anything at all if the pair ordering ever
    // put a policy pair at that index.
    const rows = expected.map((e) => rowFor(e, e.tier === undefined ? { tier: 'advise' } : {}));
    expect(rows.some((r) => r.tier === 'advise')).toBe(true);
    expect(diffRegistry(expected, rows)).toEqual([]);
  });

  /**
   * D-046 — the blind spot that let a `deny` pattern serve stale for four days.
   *
   * `tier` was excluded from the comparison outright, for a reason that is right
   * for ordinary rows (promotion is earned, and the seeder does not overwrite it)
   * and wrong for the one row class where tier is pair-owned and re-asserted on
   * every seed. So the drift check could not see the highest-consequence drift on
   * the table: a policy row sitting at the wrong ENFORCEMENT STRENGTH.
   */
  it('detects a drifted POLICY tier — the pair-owned field the check used to be blind to', () => {
    // Calibration. Every assertion below is vacuous if no pair owns a tier, and
    // that is a state this repo can legitimately reach (D-044's deny family was
    // withdrawn the same hour it landed). Fail loudly rather than pass emptily.
    expect(POLICY_PAIRS.length, 'no pair declares a policyTier — this test covers nothing').toBeGreaterThan(0);

    for (const pair of POLICY_PAIRS) {
      // The un-seeded widening, in its live shape: the pair says `deny`, the row
      // the gate actually enforces is still sitting at `observe`.
      const rows = expected.map((e) => rowFor(e, e.intentLabel === pair.intentLabel ? { tier: 'observe' } : {}));
      const drifts = diffRegistry(expected, rows);

      expect(drifts, `${pair.id}: a wrong-strength policy row must be reported`).toHaveLength(1);
      expect(drifts[0]).toMatchObject({ kind: 'changed', intentLabel: pair.intentLabel });
      expect(drifts[0].kind === 'changed' && drifts[0].fields).toEqual([
        { field: 'tier', expected: pair.policyTier, actual: 'observe' },
      ]);
    }
  });

  /**
   * FALSIFIABILITY CONTROL for the test directly above — a guard that has never
   * failed is a guard nobody has tested.
   *
   * The control is the PRE-D-046 expectation shape (an `ExpectedRow` carrying no
   * `tier`), fed to the REAL `diffRegistry`. That is the whole of the old
   * behaviour, reproduced without duplicating the comparison logic and without
   * mutating anything in the tree: if the tier expectation were not load-bearing,
   * this would report the same drift the real expectation does, and the assertion
   * that it reports NOTHING would fail.
   *
   * The second half is the calibration the repo's mutation-probe guidance asks
   * for: a control that catches nothing because it is simply broken would pass
   * the first assertion for the wrong reason, so the same stripped expectation
   * must still detect an ordinary, non-tier drift.
   */
  it('CONTROL: the pre-D-046 expectation (no tier) misses the drift, but still catches an ordinary one', () => {
    const pair = POLICY_PAIRS[0];
    expect(pair, 'no policy pair to control against').toBeDefined();
    const withoutTier: ExpectedRow[] = expected.map(({ tier: _tier, ...rest }) => rest);

    const tierDrifted = expected.map((e) => rowFor(e, e.intentLabel === pair.intentLabel ? { tier: 'observe' } : {}));
    expect(
      diffRegistry(withoutTier, tierDrifted),
      'the old shape must be BLIND to this — if it sees it, the new expectation is not what catches it',
    ).toEqual([]);

    // Calibration: the control is not merely inert.
    const advisoryDrifted = expected.map((e) =>
      rowFor(e, e.intentLabel === pair.intentLabel ? { advisoryText: 'stale' } : {}),
    );
    expect(diffRegistry(withoutTier, advisoryDrifted)).toHaveLength(1);
  });

  it('names the direction of a tier drift, so the reader knows which value is LIVE', () => {
    const pair = POLICY_PAIRS[0];
    expect(pair, 'no policy pair to format').toBeDefined();
    const rows = expected.map((e) => rowFor(e, e.intentLabel === pair.intentLabel ? { tier: 'observe' } : {}));
    const report = formatDrift(diffRegistry(expected, rows));

    // The bare field dump ("db observe / pairs deny") leaves the reader to work
    // out which side is currently enforcing. Say it.
    expect(report).toContain('ENFORCING AT THE WRONG STRENGTH');
    expect(report).toContain(`the gate is applying 'observe'`);
    expect(report).toContain(`the pair declares '${pair.policyTier}'`);
  });

  it('detects a stale ADVISORY — the shape that told agents to keep using ss/lsof after the tool existed', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'listening-socket-query' ? { advisoryText: 'there is no tool form today' } : {}),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'changed', intentLabel: 'listening-socket-query' });
    expect(drifts[0].kind === 'changed' && drifts[0].fields.map((f) => f.field)).toEqual(['advisoryText']);
  });

  it('detects a re-pointed TOOL and VERDICT together (D-018: service_health → listening_ports)', () => {
    const rows = expected.map((e) =>
      rowFor(
        e,
        e.intentLabel === 'listening-socket-query'
          ? { toolName: 'dev:service_health', equivalenceVerdict: 'not-a-substitute' }
          : {},
      ),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields.map((f) => f.field).sort()).toEqual([
      'equivalenceVerdict',
      'toolName',
    ]);
  });

  /**
   * The regression guard for the defect this check found on its first run.
   * A drifted pattern means the gate enforces a regex no sample was scored
   * against — silent, and invisible to every other gate in the plan.
   */
  it('detects a drifted bash PATTERN, the defect the first live run surfaced', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'host-job-liveness-query' ? { bashPattern: String.raw`^(?:ps|pgrep)\b` } : {}),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0].field).toBe('bashPattern');
  });

  it('detects a drifted pattern FLAGS (WI-5998: same source, different regex)', () => {
    const rows = expected.map((e, i) => rowFor(e, i === 0 ? { bashPatternFlags: 'i' } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0].field).toBe('bashPatternFlags');
  });

  it('detects a MISSING row — a pair the gate cannot enforce because it was never seeded', () => {
    const rows = expected.slice(1).map((e) => rowFor(e));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'missing', intentLabel: expected[0].intentLabel });
  });

  /**
   * The drift direction `gen-tool-routing --check` is structurally blind to,
   * named in its own docstring: it reads the pairs and never the DB, so a row
   * with a novel intent_label is enforced by both hooks yet appears in no
   * prose and rests on no sample. Only a DB-reading check can see it.
   */
  it('detects an ORPHAN row that no pair produces — enforced, but resting on no sample', () => {
    const rows = [
      ...expected.map((e) => rowFor(e)),
      {
        intentLabel: 'hand-inserted-rule',
        bashPattern: '^rm\\b',
        bashPatternFlags: '',
        toolName: 'some:tool',
        tier: 'deny' as const,
        advisoryText: 'inserted by hand, audited by nobody',
        equivalenceVerdict: 'unaudited' as const,
      },
    ];
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'orphan', intentLabel: 'hand-inserted-rule', tier: 'deny' });
  });

  it('treats a NULL advisory as drift rather than throwing', () => {
    const rows = expected.map((e, i) => rowFor(e, i === 0 ? { advisoryText: null } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0]).toMatchObject({ field: 'advisoryText', actual: '' });
  });

  it('reports every drifted row, not just the first', () => {
    const rows = expected.slice(2).map((e, i) => rowFor(e, i === 0 ? { toolName: 'wrong:tool' } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts.filter((d) => d.kind === 'missing')).toHaveLength(2);
    expect(drifts.filter((d) => d.kind === 'changed')).toHaveLength(1);
  });
});

describe('formatDrift', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('says so plainly when the registry is clean', () => {
    expect(formatDrift([])).toMatch(/^✓ bash_tool_substitutions matches the audited pairs/);
  });

  it('names the row, the field, and BOTH sides so the report is actionable without a second query', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'listening-socket-query' ? { toolName: 'dev:service_health' } : {}),
    );
    const out = formatDrift(diffRegistry(expected, rows));
    expect(out).toContain('listening-socket-query');
    expect(out).toContain('toolName');
    expect(out).toContain('dev:service_health'); // what the DB holds
    expect(out).toContain('dev:listening_ports'); // what the pairs say
  });

  it('distinguishes the three drift kinds by label', () => {
    const out = formatDrift([
      { kind: 'missing', intentLabel: 'a', expected: expected[0] },
      { kind: 'orphan', intentLabel: 'b', toolName: 't', tier: 'deny' },
      { kind: 'changed', intentLabel: 'c', fields: [{ field: 'toolName', expected: 'x', actual: 'y' }] },
    ]);
    expect(out).toContain('MISSING');
    expect(out).toContain('ORPHAN');
    expect(out).toContain('STALE');
  });

  it('clips a long advisory so a report stays readable in a terminal', () => {
    const long = 'x'.repeat(400);
    const out = formatDrift([
      { kind: 'changed', intentLabel: 'c', fields: [{ field: 'advisoryText', expected: long, actual: long }] },
    ]);
    expect(out).toContain('…');
    expect(out).not.toContain(long);
  });
});
