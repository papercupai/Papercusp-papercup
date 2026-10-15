/**
 * observation-schema-v2.test.ts — the P-001 write→read round-trip
 * (rubric-driven-observations-2026-06-20 P-001 / D-002 / D-003).
 *
 * Proves the structured-observation v2 contract end-to-end through the parts
 * this brief owns: capture-core WRITES the v2 payload + enforces the mandatory-
 * evidence gate, and read-items SURFACES it onto the candidate. The remaining
 * leg — Scout's corpus-digest reading candidate.observation (P-006, su-3a5d7) —
 * consumes exactly the candidate.observation surfaced here.
 */
import { describe, it, expect } from 'vitest';
import { captureImprovement, type CaptureDeps } from './capture-core';
import { issueToCandidate } from './read-items';
import { ObservationEvidenceError } from './observation-types';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';

function existing(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'change',
    scope: 'operator',
    body: '',
    severity: 'nit',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    parent: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    goalId: null,
    createdAt: '2026-06-20T00:00:00Z',
    updatedAt: '2026-06-20T00:00:00Z',
    closedAt: null,
    ...p,
  };
}

function deps(): CaptureDeps & { created: CreateIssueInput[] } {
  const created: CreateIssueInput[] = [];
  return {
    created,
    searchIssues: async () => [],
    createIssue: async (input) => {
      created.push(input);
      return existing({ id: 'EI-100', title: input.title, kind: (input.kind as 'bug' | 'change') ?? 'change' });
    },
  };
}

const SCORECARD = {
  scope: 'papercusp' as const,
  rubricRef: 'pot-coordination-health',
  sourceHive: 'papercusp',
  ratings: {
    'end-to-end-flow': { rating: 'healthy', evidence: '8 completions/hr last window (hive_throughput_ticks)' },
    'watchdog-determinism': { rating: 'degraded', evidence: 'EI-1607 throttle still live' },
    'tool-utilization': { rating: 'unknown', evidence: 'idle wake — no tool-call samples this window' },
  },
};

describe('observation schema v2 — capture-core WRITE (P-001)', () => {
  it('stores the structured v2 payload for a rubric-graded observation', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'pot-coordination-health scorecard', kind: 'change', lane: 'observation', payloadExtra: { observation: SCORECARD } },
      d,
    );
    expect(res.created).toBe(true);
    const payload = d.created[0].payload as Record<string, any>;
    expect(payload.lane).toBe('observation');
    expect(payload.observation.rubricRef).toBe('pot-coordination-health');
    expect(payload.observation.sourceHive).toBe('papercusp');
    expect(payload.observation.ratings['end-to-end-flow']).toEqual({
      rating: 'healthy',
      evidence: '8 completions/hr last window (hive_throughput_ticks)',
    });
  });

  it('REJECTS (fail-fast, never creates) a rating missing evidence — D-002 gate, both writers', async () => {
    const d = deps();
    await expect(
      captureImprovement(
        {
          title: 'bad scorecard',
          kind: 'change',
          lane: 'observation',
          payloadExtra: { observation: { rubricRef: 'pot-coordination-health', ratings: { 'end-to-end-flow': { rating: 'broken', evidence: '' } } } },
        },
        d,
      ),
    ).rejects.toThrow(ObservationEvidenceError);
    expect(d.created).toHaveLength(0);
  });

  it('REJECTS ratings that name no rubric (rubricRef required when ratings present)', async () => {
    const d = deps();
    await expect(
      captureImprovement(
        { title: 'orphan ratings', kind: 'change', lane: 'observation', payloadExtra: { observation: { ratings: { k: { rating: 'healthy', evidence: 'e' } } } } },
        d,
      ),
    ).rejects.toThrow(/must name the rubric/);
  });

  it('still files a FREE-TEXT observation with no ratings (first-class)', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'a plain friction', kind: 'change', lane: 'observation', payloadExtra: { observation: { kind: 'friction', confidence: 'high' } } },
      d,
    );
    expect(res.created).toBe(true);
    const payload = d.created[0].payload as Record<string, any>;
    expect(payload.observation.kind).toBe('friction');
    expect(payload.observation.ratings).toBeUndefined();
  });

  it('REJECTS a PARTIAL rubric scorecard when the rubric is loaded (P-014a completeness gate)', async () => {
    // loadRubric returns 4 criteria; SCORECARD rates only 3 → the missing one fails LOUD.
    const d = {
      ...deps(),
      loadRubric: async () => ({
        criteria: [
          { key: 'end-to-end-flow' },
          { key: 'watchdog-determinism' },
          { key: 'tool-utilization' },
          { key: 'placement-health' },
        ],
      }),
    };
    await expect(
      captureImprovement(
        { title: 'partial scorecard', kind: 'change', lane: 'observation', payloadExtra: { observation: SCORECARD } },
        d,
      ),
    ).rejects.toThrow(/INCOMPLETE/);
    expect(d.created).toHaveLength(0);
  });

  it('STORES a COMPLETE rubric scorecard when every loaded criterion is rated (P-014a)', async () => {
    // loadRubric returns exactly the 3 criteria SCORECARD rates → complete → stored.
    const d = {
      ...deps(),
      loadRubric: async () => ({
        criteria: [{ key: 'end-to-end-flow' }, { key: 'watchdog-determinism' }, { key: 'tool-utilization' }],
      }),
    };
    const res = await captureImprovement(
      { title: 'complete scorecard', kind: 'change', lane: 'observation', payloadExtra: { observation: SCORECARD } },
      d,
    );
    expect(res.created).toBe(true);
  });
});

describe('observation schema v2 — read-items SURFACE (P-001 → P-006 seam)', () => {
  it('surfaces candidate.observation (ratings + sourceHive) for the Scout digest', () => {
    const issue = existing({
      id: 'EI-200',
      title: 'pot-coordination-health scorecard',
      payload: { lane: 'observation', observation: SCORECARD } as unknown as EngineerIssue['payload'],
    });
    const c = issueToCandidate(issue);
    expect(c.observation).toBeDefined();
    expect(c.observation?.rubricRef).toBe('pot-coordination-health');
    expect(c.observation?.sourceHive).toBe('papercusp');
    expect(c.observation?.ratings?.['watchdog-determinism']).toEqual({ rating: 'degraded', evidence: 'EI-1607 throttle still live' });
  });

  it('a free-text observation surfaces its free-text fields, no rubric (still first-class)', () => {
    const issue = existing({
      id: 'EI-201',
      title: 'plain obs',
      payload: { lane: 'observation', observation: { kind: 'friction', confidence: 'high' } } as unknown as EngineerIssue['payload'],
    });
    const c = issueToCandidate(issue);
    expect(c.observation?.kind).toBe('friction');
    expect(c.observation?.rubricRef).toBeUndefined();
    expect(c.observation?.ratings).toBeUndefined();
  });

  it('a non-observation improvement surfaces no observation view', () => {
    const issue = existing({ id: 'EI-202', title: 'a real bug', kind: 'bug', payload: { paths: ['x.ts'] } as unknown as EngineerIssue['payload'] });
    const c = issueToCandidate(issue);
    expect(c.observation).toBeUndefined();
  });
});
