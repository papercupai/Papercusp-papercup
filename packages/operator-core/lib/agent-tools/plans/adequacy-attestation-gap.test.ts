import { describe, expect, it } from 'vitest';
import {
  attestationGap,
  attestationLoss,
  carriesAttestation,
  DESIGN_ATTESTATION_KEYS,
  type ClauseAdequacyRow,
} from './adequacy-attestation-gap';

const LIFECYCLE = 'packages/operator-core/lib/work-items-lifecycle.integration.test.ts';
const RUN_FACTS = { outcome: 'passed', skipped: false, executed: true, collected: true, testLayer: 'integration' };
const ATTESTED = {
  ...RUN_FACTS,
  targeted: 'gbe-p-008-contract',
  falsifiable: true,
  pathReachable: true,
  fixtureCalibrated: true,
  fixtureFree: true,
  oracleIndependent: true,
};

const row = (id: number, adequacy: Record<string, unknown> | null, over: Partial<ClauseAdequacyRow> = {}): ClauseAdequacyRow => ({
  id,
  evidenceKind: 'test',
  evidenceRef: LIFECYCLE,
  adequacy,
  ...over,
});

describe('carriesAttestation', () => {
  it('counts only POSITIVE attestations', () => {
    expect(carriesAttestation({ pathReachable: true }, 'pathReachable')).toBe(true);
    expect(carriesAttestation({ pathReachable: false }, 'pathReachable')).toBe(false);
    expect(carriesAttestation({}, 'pathReachable')).toBe(false);
    expect(carriesAttestation(null, 'pathReachable')).toBe(false);
    expect(carriesAttestation({ targeted: 'auto-bar-r-6-p-008' }, 'targeted')).toBe(true);
    expect(carriesAttestation({ targeted: '  ' }, 'targeted')).toBe(false);
    expect(carriesAttestation({ coverageRungs: { l1: false, l2: true } }, 'coverageRungs')).toBe(true);
    expect(carriesAttestation({ coverageRungs: { l1: false } }, 'coverageRungs')).toBe(false);
  });

  it('never treats a run-derived fact as a design attestation', () => {
    for (const fact of Object.keys(RUN_FACTS)) expect(DESIGN_ATTESTATION_KEYS).not.toContain(fact);
  });
});

describe('attestationGap — a fresh re-bind of the same test', () => {
  it('reports every attestation the older live row of the same test file carries and the new row lacks (GBE-P-008: 12398 → 22753)', () => {
    const gap = attestationGap(row(22753, RUN_FACTS), [row(12398, ATTESTED), row(22753, RUN_FACTS)]);
    expect(gap.map((g) => g.key).sort()).toEqual(
      ['falsifiable', 'fixtureCalibrated', 'fixtureFree', 'oracleIndependent', 'pathReachable', 'targeted'].sort(),
    );
    expect(gap.every((g) => g.carriedBy.length === 1 && g.carriedBy[0] === 12398)).toBe(true);
  });

  it('is silent when the re-bind re-attests deliberately', () => {
    expect(attestationGap(row(22764, ATTESTED), [row(12398, ATTESTED)])).toEqual([]);
  });

  it('ignores another test file and another evidence kind: their attestations say nothing about this test', () => {
    const otherFile = row(1, ATTESTED, { evidenceRef: 'packages/x/other.integration.test.ts' });
    const mutation = row(2, ATTESTED, { evidenceKind: 'mutation', evidenceRef: 'test-run 9 local mutant' });
    expect(attestationGap(row(3, RUN_FACTS), [otherFile, mutation])).toEqual([]);
  });

  it('compares mutation rows across evidence refs, since each mutation row names its own run', () => {
    const older = row(10, { targeted: 'auto-bar-r-1-p-004', falsifiable: true }, { evidenceKind: 'mutation', evidenceRef: 'test-run 1' });
    const fresh = row(11, { outcome: 'caught' }, { evidenceKind: 'mutation', evidenceRef: 'test-run 2' });
    expect(attestationGap(fresh, [older]).map((g) => g.key).sort()).toEqual(['falsifiable', 'targeted']);
  });
});

describe('attestationLoss — retracting rows from a clause', () => {
  it('reports an attestation whose LAST live carrier was retracted', () => {
    const loss = attestationLoss([row(12398, ATTESTED)], [row(17686, RUN_FACTS)]);
    expect(loss.map((l) => l.key)).toContain('pathReachable');
    expect(loss.find((l) => l.key === 'pathReachable')?.lostFrom).toEqual([12398]);
  });

  it('is silent when any remaining live row of the clause still carries it, whatever its kind', () => {
    const survivingMutation = row(5, { ...ATTESTED, coverageRungs: undefined }, { evidenceKind: 'mutation' });
    expect(attestationLoss([row(4, ATTESTED)], [survivingMutation])).toEqual([]);
  });

  it('treats a batch retraction as one event: two retracted carriers do not vouch for each other', () => {
    const loss = attestationLoss([row(1, ATTESTED), row(2, ATTESTED)], [row(3, RUN_FACTS)]);
    expect(loss.find((l) => l.key === 'oracleIndependent')?.lostFrom).toEqual([1, 2]);
  });

  it('is silent when the retracted rows carried no attestations (a run-facts-only row)', () => {
    expect(attestationLoss([row(17705, RUN_FACTS)], [row(22754, RUN_FACTS)])).toEqual([]);
  });
});
