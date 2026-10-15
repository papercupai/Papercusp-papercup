/**
 * GN-BENCH-PROVENANCE (integration layer) — replays the REAL committed arm reports
 * (docs/evidence/gitnexus-engine-comparison-2026-10-01/report-*.json, the P-005 four-arm run)
 * through the same `orderReports` → `renderEvidence` path the CLI `--aggregate` uses, and
 * checks the provenance contract on real measured data rather than a hand-built fixture:
 *
 *  - the recorded verdict is reproduced (keep), with the recorded source-parity reading;
 *  - an arm that was never executed is rendered UNAVAILABLE and can never support a pass;
 *  - re-pointing one arm at a different tree fingerprint is reported as a mismatch.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ArmReport, EngineRunMeta } from './engine-comparison';
import { ARM_ORDER, orderReports, renderEvidence } from './engine-comparison-report';

const EVIDENCE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence/gitnexus-engine-comparison-2026-10-01');
const read = <T>(name: string): T => JSON.parse(readFileSync(resolve(EVIDENCE, name), 'utf8')) as T;
const META: EngineRunMeta = { runId: 'replay', seed: 0, createdAt: '2026-10-01T00:00:00.000Z', preregHash: 'replay' };

const loadReports = (): ArmReport[] => orderReports(ARM_ORDER.map((id) => read<ArmReport>(`report-${id}.json`)));
interface Verdict { decision: string; residue: string[]; reasons: string[]; sourceParity: { same: boolean; fingerprints: Record<string, string | null> } }
const verdictOf = (reports: ArmReport[]): { v: Verdict; markdown: string } => {
  const b = renderEvidence(reports, META, []);
  return { v: JSON.parse(b.verdictJson) as Verdict, markdown: b.markdown };
};

describe('GN-BENCH-PROVENANCE on the real committed four-arm evidence', () => {
  it('reproduces the recorded verdict, residue and source-parity reading', () => {
    const recorded = read<Verdict>('verdict.json');
    const { v } = verdictOf(loadReports());
    expect(recorded.decision).toBe('keep');
    expect(v.decision).toBe(recorded.decision);
    expect(v.residue).toEqual(recorded.residue);
    expect(v.reasons).toEqual(recorded.reasons);
    expect(v.sourceParity).toEqual(recorded.sourceParity);
    // the clean installed-arm rerun (WI-10005374) put all four arms on one pristine tree
    expect(v.sourceParity.same).toBe(true);
    expect(v.sourceParity.fingerprints['gitnexus-installed']).not.toMatch(/\+dirty$/);
  });

  it('a dirty-tree installed arm is still disclosed as a parity break, not normalised away', () => {
    const reports = loadReports().map((r): ArmReport =>
      r.armId === 'gitnexus-installed' ? { ...r, treeFingerprint: `${r.treeFingerprint}+dirty` } : r);
    const { v } = verdictOf(reports);
    expect(v.sourceParity.same).toBe(false);
    expect(v.sourceParity.fingerprints['gitnexus-installed']).toMatch(/\+dirty$/);
  });

  it('an arm that was never executed is UNAVAILABLE residue and the verdict cannot be a pass', () => {
    const reports = loadReports().map((r): ArmReport =>
      r.armId === 'gitnexus-candidate'
        ? { ...r, version: 'n/a', unavailable: 'no report-gitnexus-candidate.json — arm was not run', treeFingerprint: null, coldIndex: null, indexBytes: null, cases: [], fixtures: [] }
        : r);
    const { v, markdown } = verdictOf(reports);
    expect(markdown).toContain('UNAVAILABLE: no report-gitnexus-candidate.json');
    expect(v.decision).toBe('inconclusive');
    expect(v.residue.join(' ')).toContain('gitnexus-candidate');
  });

  it('re-pointing one executed arm at a different tree is reported as a fingerprint mismatch', () => {
    const reports = loadReports().map((r): ArmReport => (r.armId === 'codebase-memory' ? { ...r, treeFingerprint: 'a-different-tree' } : r));
    const { v, markdown } = verdictOf(reports);
    expect(markdown).toContain('identical tree fingerprint across arms: **NO**');
    expect(v.sourceParity.fingerprints['codebase-memory']).toBe('a-different-tree');
    expect(v.sourceParity.same).toBe(false);
  });

  it('with every fingerprint forced equal the same measured data still yields keep (parity gates winners, it does not invent one)', () => {
    const fp = '08104b5503ccf9a3b0cf486a81bbc06fc94329f5';
    const reports = loadReports().map((r): ArmReport => ({ ...r, treeFingerprint: fp }));
    const { v } = verdictOf(reports);
    expect(v.sourceParity.same).toBe(true);
    expect(v.decision).toBe('keep');
  });
});
