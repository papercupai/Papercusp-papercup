import { describe, expect, it } from 'vitest';
import { evidenceArtifactShas, evidenceVerdict } from './p2p-candidate-evidence';
import { P521_JOURNEYS } from './p2p-candidate-manifest';
import { DRILL_LEG_JOURNEYS, deriveDrillJourneyEvidence, type DrillJourneyEvidenceInput } from './p521-drill-journey-evidence';

const DEB = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const LEGS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

function drill(status: Record<string, string> = {}) {
  return {
    schemaVersion: 'hive-git-physical-evidence/v3',
    runId: '20261001T120000Z-123',
    window: { startedAt: '2026-10-01T12:00:00.000Z', finishedAt: '2026-10-01T13:00:00.000Z' },
    legVerdicts: LEGS.map((leg) => ({ leg, status: status[leg] ?? 'pass', scope: 'physical' })),
  };
}

function input(over: Partial<DrillJourneyEvidenceInput> = {}): DrillJourneyEvidenceInput {
  return {
    drill: drill(),
    drillPath: 'docs/evidence/drill-run.json',
    drillSha256: 'c'.repeat(64),
    validation: { ok: true, errors: [], summary: 'valid' },
    release: '0.0.28-alpha',
    artifact: 'Papercusp Server_0.0.28_amd64.deb',
    actualDebSha256: DEB,
    expectedDebSha256: DEB,
    observer: 'su-test',
    command: ['bash hive-git-physical-scenario.sh'],
    precheckSubject: { artifactDigest: 'd'.repeat(64), installerSha256: DEB },
    localPrechecks: DRILL_LEG_JOURNEYS.map(({ journey }) => ({
      journey, check: 'p521-local-precheck:' + journey, verdict: 'pass',
      startedAt: '2026-10-01T11:58:00.000Z', finishedAt: '2026-10-01T11:59:00.000Z',
      subject: { artifactDigest: 'd'.repeat(64), installerSha256: DEB },
      command: ['local-fixture'], evidence: [{ ref: 'local-fixture', kind: 'local-precheck' }],
    })),
    ...over,
  };
}

const byJourney = (docs: ReturnType<typeof deriveDrillJourneyEvidence>) =>
  Object.fromEntries(docs.map((d) => [d.journey, d.doc]));

describe('deriveDrillJourneyEvidence', () => {
  it('maps only journeys the P-521 manifest knows', () => {
    const known = new Set(P521_JOURNEYS.map((j) => j.key));
    for (const row of DRILL_LEG_JOURNEYS) expect(known.has(row.journey)).toBe(true);
  });

  it('a valid run on the exact artifact passes every mapped journey and binds the computed deb sha', () => {
    const docs = deriveDrillJourneyEvidence(input());
    expect(docs.map((d) => d.journey).sort()).toEqual(DRILL_LEG_JOURNEYS.map((r) => r.journey).sort());
    for (const { doc } of docs) {
      expect(doc.kind).toBe('operational-test-evidence');
      expect(evidenceVerdict(doc).verdict).toBe('pass');
      expect(evidenceArtifactShas(doc)).toEqual([DEB]);
    }
  });

  it('scopes legVerdicts to the journey legs', () => {
    const docs = byJourney(deriveDrillJourneyEvidence(input()));
    const legsOf = (j: string) =>
      ((docs[j].physicalRun as { legVerdicts: Array<{ leg: string }> }).legVerdicts).map((l) => l.leg);
    expect(legsOf('serving-identity-restart')).toEqual(['H']);
    expect(legsOf('protected-effect-fencing')).toEqual(['G', 'I']);
    expect(legsOf('replicated-write-outage-replay')).toEqual(['J']);
  });

  it('a failed leg fails only the journeys that leg backs', () => {
    const docs = byJourney(deriveDrillJourneyEvidence(input({ drill: drill({ J: 'fail' }) })));
    expect(evidenceVerdict(docs['replicated-write-outage-replay']).verdict).toBe('fail');
    expect(evidenceVerdict(docs['serving-identity-restart']).verdict).toBe('pass');
  });

  it('a leg missing from the run is never a pass', () => {
    const d = drill();
    d.legVerdicts = d.legVerdicts.filter((l) => l.leg !== 'H');
    const docs = byJourney(deriveDrillJourneyEvidence(input({ drill: d })));
    expect(evidenceVerdict(docs['serving-identity-restart']).verdict).not.toBe('pass');
  });

  it('an invalid drill fails every journey', () => {
    const docs = deriveDrillJourneyEvidence(input({ validation: { ok: false, errors: ['bad receipt'], summary: 'rejected' } }));
    for (const { doc } of docs) expect(evidenceVerdict(doc).verdict).toBe('fail');
  });

  it('an artifact mismatch fails and records the COMPUTED digest, not the expected one', () => {
    const docs = deriveDrillJourneyEvidence(input({ actualDebSha256: OTHER }));
    for (const { doc } of docs) {
      expect(evidenceVerdict(doc).verdict).toBe('fail');
      expect(evidenceArtifactShas(doc)).toEqual([OTHER]);
    }
  });

  it('fails when the drill recorded a different deb (subject.debSha256) than the one installed', () => {
    const d = { ...drill(), subject: { debSha256: OTHER } };
    const docs = deriveDrillJourneyEvidence(input({ drill: d }));
    for (const { doc } of docs) expect(evidenceVerdict(doc).verdict).toBe('fail');
  });

  it('passes when the drill recorded the same deb (case-insensitive)', () => {
    const d = { ...drill(), subject: { debSha256: DEB.toUpperCase() } };
    const docs = deriveDrillJourneyEvidence(input({ drill: d }));
    for (const { doc } of docs) expect(evidenceVerdict(doc).verdict).toBe('pass');
  });

  it('refuses an unmapped journey (delegated-seat-lifecycle is LIVE-2, not the drill)', () => {
    expect(() => deriveDrillJourneyEvidence(input({ journeys: ['delegated-seat-lifecycle'] }))).toThrow(/no drill legs/);
  });
});
