import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyReplayIncident, evaluateReplayThreshold, REPLAY_SIGNALS, type ReplayIncident } from './graph-replay';

// Overridable so scripts/mutation-probe.sh can point the pin at a mutated COPY (never the tree).
const EVIDENCE_PATH = process.env.GRAPH_REPLAY_EVIDENCE_PATH ||
  fileURLToPath(new URL('../../../../docs/evidence/gitnexus-replay-baseline-2026-10-06.json', import.meta.url));

const SHA = '0123456789abcdef0123456789abcdef01234567';
function incident(id = 'incident-1'): ReplayIncident {
  return {
    id,
    kind: 'cross-workspace-red',
    rootCauseVerified: true,
    staticIndex: { verdict: 'missed', sourceSha: SHA, positiveControl: true, evidenceRefs: ['static-replay:control'] },
    signals: Object.fromEntries(REPLAY_SIGNALS.map((signal) => [signal, {
      verdict: 'not-incremental', comparison: 'observed', graphHealth: 'verified', sourceSha: SHA, evidenceRefs: [`paired-replay:${signal}`],
    }])) as ReplayIncident['signals'],
  };
}

describe('historical graph replay evidence accounting', () => {
  it('credits an observed, independently controlled additional catch', () => {
    const row = incident();
    row.signals['graph-added-workspaces'].verdict = 'incremental';
    expect(classifyReplayIncident(row).graphOnly).toBe(true);
    expect(evaluateReplayThreshold([row]).decision).toBe('go');
  });

  it.each(['counterfactual', 'unavailable'] as const)('does not count a %s as a measured graph catch', (comparison) => {
    const row = incident();
    row.signals['graph-added-workspaces'] = { ...row.signals['graph-added-workspaces'], verdict: 'incremental', comparison };
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
    expect(evaluateReplayThreshold([row]).decision).toBe('unresolved');
  });

  it('does not credit adding a workspace the static index already selected', () => {
    const row = incident();
    row.staticIndex.verdict = 'caught';
    row.signals['graph-added-workspaces'].verdict = 'incremental';
    expect(classifyReplayIncident(row).signals['graph-added-workspaces']).toBe('unknown');
  });

  it('requires a paired measured acceleration for ordering, even with known reach', () => {
    const row = incident();
    row.staticIndex.verdict = 'caught';
    row.signals['graph-ordering'].verdict = 'incremental';
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
    row.signals['graph-ordering'].savedMs = 1000;
    expect(classifyReplayIncident(row).graphOnly).toBe(true);
    row.signals['graph-ordering'].savedMs = -1;
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
  });

  it('does not substitute a current index or an unbound source for a historical replay', () => {
    const row = incident();
    row.signals['graph-added-workspaces'].verdict = 'incremental';
    row.signals['graph-added-workspaces'].sourceSha = 'fedcba9876543210fedcba9876543210fedcba98';
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
    row.staticIndex.sourceSha = null;
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
  });

  it.each(['stale', 'failed', 'empty-unproven'] as const)('does not grade a %s graph as a negative replay', (graphHealth) => {
    const row = incident();
    expect(evaluateReplayThreshold([row]).decision).toBe('scale-back');
    row.signals['graph-added-workspaces'].graphHealth = graphHealth;
    expect(classifyReplayIncident(row).graphOnly).toBeNull();
    expect(evaluateReplayThreshold([row]).decision).toBe('unresolved');
  });

  it('requires positive controls, root-cause verification and inspectable references', () => {
    for (const corrupt of [
      (row: ReplayIncident) => { row.staticIndex.positiveControl = false; },
      (row: ReplayIncident) => { row.rootCauseVerified = false; },
      (row: ReplayIncident) => { row.staticIndex.evidenceRefs = []; },
      (row: ReplayIncident) => { row.signals['graph-added-workspaces'].evidenceRefs = [' ']; },
    ]) {
      const row = incident();
      row.signals['graph-added-workspaces'].verdict = 'incremental';
      expect(classifyReplayIncident(row).graphOnly).toBe(true);
      corrupt(row);
      expect(classifyReplayIncident(row).graphOnly).toBeNull();
    }
  });

  it('keeps the incident count and sampled-red denominator separate', () => {
    const rows = Array.from({ length: 3 }, (_, index) => incident(`absence-${index}`));
    for (const row of rows) {
      row.kind = 'retracted-absence';
      row.signals['edit-time-impact'].verdict = 'incremental';
    }
    expect(evaluateReplayThreshold(rows)).toMatchObject({ decision: 'go', graphOnlyIncidents: 3, sampledReds: 0, graphOnlyReds: 0 });
  });

  it('implements the 20 percent threshold at the boundary', () => {
    const rows = Array.from({ length: 5 }, (_, index) => incident(`red-${index}`));
    rows[0].signals['graph-added-workspaces'].verdict = 'incremental';
    expect(evaluateReplayThreshold(rows).decision).toBe('go');
    rows.push(incident('red-5'));
    expect(evaluateReplayThreshold(rows).decision).toBe('scale-back');
  });

  it('unknown graph answers cannot masquerade as evidence to scale back', () => {
    const row = incident();
    row.signals['graph-ordering'].verdict = 'unknown';
    expect(evaluateReplayThreshold([row]).decision).toBe('unresolved');
    expect(evaluateReplayThreshold([]).decision).toBe('unresolved');
  });

  it('rejects duplicate incident ids instead of counting repeated gate reds twice', () => {
    expect(() => evaluateReplayThreshold([incident(), incident()])).toThrow(/unique/);
  });

  it('does not dilute the rate with an unverified cross-workspace candidate', () => {
    const rows = Array.from({ length: 6 }, (_, index) => incident(`red-${index}`));
    rows[0].signals['graph-added-workspaces'].verdict = 'incremental';
    rows[5].rootCauseVerified = false;
    expect(evaluateReplayThreshold(rows)).toMatchObject({ decision: 'unresolved', sampledReds: 5, unqualifiedIds: ['red-5'] });
  });
});

describe('P-003 evidence document (gitnexus-replay-baseline-2026-10-06.json)', () => {
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as {
    status: string;
    replayIncidents: ReplayIncident[];
    thresholdEvaluation: ReturnType<typeof evaluateReplayThreshold> & Record<string, unknown>;
  };

  it('records exactly the decision the classifier computes from its own incidents', () => {
    const computed = evaluateReplayThreshold(evidence.replayIncidents);
    const { decision, graphOnlyIncidents, sampledReds, graphOnlyReds, unknownIds, unqualifiedIds } = evidence.thresholdEvaluation;
    expect({ decision, graphOnlyIncidents, sampledReds, graphOnlyReds, unknownIds, unqualifiedIds }).toEqual(computed);
  });

  it('never states a go or a scale-back that the evidence did not demonstrate', () => {
    const { decision } = evaluateReplayThreshold(evidence.replayIncidents);
    expect(evidence.status).toBe(decision === 'go' ? 'complete-go' : decision === 'scale-back' ? 'complete-scale-back' : 'complete-threshold-not-demonstrated');
  });

  it('gives no graph credit for a signal with no observation behind it', () => {
    for (const row of evidence.replayIncidents) {
      for (const signal of REPLAY_SIGNALS) {
        const observation = row.signals[signal];
        if (observation.comparison !== 'observed') expect(classifyReplayIncident(row).signals[signal]).toBe('unknown');
      }
    }
  });
});
