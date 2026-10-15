/**
 * GN-BENCH-PROVENANCE (unit layer) — `decideDisposition` / `sourceParity`.
 *
 * The spec's falsifier: "An unexecuted arm is reported as passed OR a task/source/cache/
 * configuration mismatch supports a winner or savings conclusion." Every case below builds the
 * SAME measured data and changes exactly one provenance fact, so a pass here cannot be a
 * property of the fixture. The first case is the calibration control: it proves the winning
 * scenario really does yield `upgrade` when provenance is clean, so the mismatch cases are not
 * vacuously `inconclusive`.
 */

import { describe, expect, it } from 'vitest';
import {
  decideDisposition,
  sourceParity,
  type ArmReport,
  type CaseMeasurement,
  type PhaseCost,
  type UpdateFixtureResult,
} from './engine-comparison';

const COST: PhaseCost = { wallMs: 60_000, peakRssKb: 2_048_000, ok: true, error: null, loadAvg1: 4 };
const TREE = 'tree-aaaa';

const kase = (id: string, correct: boolean): CaseMeasurement => ({
  caseId: id, intent: 'callers', coldQueryMs: 100, warmQueryMs: 50, warmSamplesMs: [50],
  responseBytes: 400, estTokens: 100, correct, recall: correct ? 1 : 0,
  grade: { correct, missing: [], extra: [], reason: correct ? 'ok' : 'miss' }, returnedSites: [], error: null,
});

const fixture = (name: UpdateFixtureResult['name']): UpdateFixtureResult => ({
  name, pass: true, detail: `${name} ok`, refreshCost: COST, recoveryCost: COST,
  faultSurfaced: name === 'refresh-failure' ? true : null,
});

/** `correct` of 5 cases pass; every arm has identical resource numbers so only correctness differs. */
const arm = (armId: string, correct: number, fingerprint: string | null = TREE, over: Partial<ArmReport> = {}): ArmReport => ({
  armId, version: '1.0.0', unavailable: null, treeFingerprint: fingerprint, coldIndex: COST, indexBytes: 10 * 1024 * 1024,
  cases: [0, 1, 2, 3, 4].map((i) => kase(`c${i}`, i < correct)),
  fixtures: [fixture('edit'), fixture('delete'), fixture('refresh-failure')],
  error: null, ...over,
});

const unexecuted = (armId: string): ArmReport =>
  arm(armId, 0, null, { unavailable: `no report-${armId}.json — arm was not run`, coldIndex: null, indexBytes: null, cases: [], fixtures: [] });

const winningSet = (candFp: string | null = TREE): ArmReport[] => [
  arm('baseline-lsp-rg', 1), arm('gitnexus-installed', 2), arm('gitnexus-candidate', 4, candFp), arm('codebase-memory', 1),
];

describe('decideDisposition provenance (GN-BENCH-PROVENANCE)', () => {
  it('CALIBRATION: a candidate that clears every bar on one shared tree yields upgrade', () => {
    const v = decideDisposition(winningSet());
    expect(v.decision).toBe('upgrade');
    expect(v.residue).toEqual([]);
  });

  it('a tree-fingerprint mismatch downgrades the SAME winning candidate to inconclusive and names the fingerprints', () => {
    const v = decideDisposition(winningSet('tree-bbbb'));
    expect(v.decision).toBe('inconclusive');
    expect(v.decision).not.toBe('upgrade');
    const text = v.reasons.join(' | ');
    expect(text).toContain('source parity failed');
    expect(text).toContain('gitnexus-candidate=tree-bbbb');
    expect(text).toContain('gitnexus-installed=tree-aaaa');
  });

  it('a dirty-tree installed arm (fingerprint +dirty) also blocks a Codebase-Memory replace', () => {
    const v = decideDisposition([
      arm('baseline-lsp-rg', 1), arm('gitnexus-installed', 2, `${TREE}+dirty`), arm('gitnexus-candidate', 2), arm('codebase-memory', 4),
    ]);
    expect(v.decision).toBe('inconclusive');
    expect(v.reasons.join(' ')).toContain('Codebase-Memory clears every bar and wins');
    expect(v.reasons.join(' ')).toContain('no winner can be declared');
  });

  it('a null fingerprint is a mismatch, not a match (an unmeasured tree cannot support a winner)', () => {
    expect(sourceParity(winningSet(null)).same).toBe(false);
    expect(decideDisposition(winningSet(null)).decision).toBe('inconclusive');
  });

  it('an UNEXECUTED required arm is nonpassing residue and never lets a winner be declared', () => {
    const v = decideDisposition([arm('baseline-lsp-rg', 1), arm('gitnexus-installed', 2), unexecuted('gitnexus-candidate'), arm('codebase-memory', 1)]);
    expect(v.decision).toBe('inconclusive');
    expect(v.residue).toEqual(['gitnexus-candidate: unavailable or errored — nonpassing residue']);
  });

  it('an arm whose cold index FAILED is treated as unexecuted, not as a zero-score pass', () => {
    const failedCold = arm('codebase-memory', 5, TREE, { coldIndex: { ...COST, ok: false, error: 'index crashed' } });
    const v = decideDisposition([arm('baseline-lsp-rg', 1), arm('gitnexus-installed', 2), arm('gitnexus-candidate', 1), failedCold]);
    expect(v.decision).toBe('inconclusive');
    expect(v.residue.join(' ')).toContain('codebase-memory');
  });

  it('without the installed reference arm no comparison is made at all', () => {
    const v = decideDisposition([arm('baseline-lsp-rg', 1), unexecuted('gitnexus-installed'), arm('gitnexus-candidate', 5), arm('codebase-memory', 5)]);
    expect(v.decision).toBe('inconclusive');
    expect(v.reasons.join(' ')).toContain('did not run');
    expect(v.residue.join(' ')).toContain('gitnexus-installed');
  });

  it('keep claims no win: both challengers measured worse on the shared tree', () => {
    const v = decideDisposition([arm('baseline-lsp-rg', 1), arm('gitnexus-installed', 2), arm('gitnexus-candidate', 1), arm('codebase-memory', 1)]);
    expect(v.decision).toBe('keep');
    expect(v.residue).toEqual([]);
    expect(v.reasons.join(' ')).toContain('does not upgrade');
  });
});
