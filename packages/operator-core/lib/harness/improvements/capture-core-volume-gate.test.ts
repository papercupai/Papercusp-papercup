// WI-6554700010018038 (plan bug-inflow-one-problem-one-row-2026-10-18, R-9 lever): a transient or
// rate-limit tool failure is volume-gated by the invocation watchdog, so a second AGENT reporter on
// its probation row is counted on that row — it never promotes the row into the work lane. A
// structural row, and an explicitly promoted (structured directEvidence) report, still promote.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { captureImprovement, type CaptureDeps } from './capture-core';
import { isVolumeGatedToolErrorClass, isVolumeGatedToolFailureProbation } from './tool-error-volume-gate';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';
import type { RecordIssueOccurrenceInput } from '../../issue-occurrence-ledger';
import { findRecentLexicalDupes } from '../../agent-tools/work_items/recent-lexical-dupe-guard';

afterEach(() => {
  vi.mocked(findRecentLexicalDupes).mockReset().mockResolvedValue(null);
});

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../agent-tools/work_items/recent-lexical-dupe-guard', () => ({
  findRecentLexicalDupes: vi.fn(async () => null),
}));

function existing(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug', scope: 'operator', body: '', severity: 'minor', source: 'su', state: 'open',
    assignee: null, assignedBy: null, assignedAt: null, payload: null, foundDuring: null,
    linkedFeatureId: null, parent: null, createdBy: null, signalOrigin: 'organic', assigneeRank: null,
    rankWriter: null, rankUpdatedAt: null, lastProgressAt: null, origin: 'local', terminalOwner: null,
    terminalCompletionRef: null, completionAuthority: null, featureOrder: null,
    createdAt: '2026-06-04T00:00:00Z', updatedAt: '2026-06-04T00:00:00Z', closedAt: null, goalId: null,
    ...p,
  };
}

type Klass = 'transient' | 'rate-limit' | 'structural';
const KEY: Record<Klass, string> = {
  transient: 'repeated-tool-error:coord:send:transient',
  'rate-limit': 'repeated-tool-error:coord:send:rate-limit',
  structural: 'repeated-tool-error:coord:send:structural:upstream-500',
};

function probation(klass: Klass, reporter: string, state: 'probation' | 'promoted' = 'probation') {
  return {
    state,
    class: klass,
    watchdogKey: KEY[klass],
    correlationFingerprint: `coord:send|${klass}|42|-|codex-1.2|${klass}`,
    intendedKind: 'bug' as const,
    reporters: [reporter],
    report: {
      toolName: 'coord:send', errorCode: klass === 'structural' ? 'internal_error' : 'upstream_timeout',
      status: 'error', message: `${klass} failure`, schemaRevision: '42', runtimeVersion: 'codex-1.2',
    },
  };
}

/** A probation row held by su-a, and a capture harness that records every write. */
function harness(klass: Klass) {
  const prior = existing({
    id: 'EI-PROBATION', title: 'coord:send tool-call failure', kind: 'bug', severity: 'nit',
    payload: { lane: 'observation', watchdogKey: KEY[klass], repeatCount: 1, toolFailureProbation: probation(klass, 'su-a') },
  });
  const created: CreateIssueInput[] = [];
  const occurrences: RecordIssueOccurrenceInput[] = [];
  const merges: Array<{ patch: Record<string, unknown>; opts: { unset?: readonly string[] } | undefined }> = [];
  const d: CaptureDeps = {
    emitAwaitedEvent: async () => ({}),
    searchIssues: async () => [],
    resolvePotScope: async ({ rawSlug }) => rawSlug,
    recordIssueOccurrence: async (input) => {
      occurrences.push(input);
      return { occurrenceId: occurrences.length, workspaceId: 'ws', canonicalHarness: 'papercusp',
        canonicalId: input.canonicalId, reportKind: input.reportKind, occurredAt: '2026-10-20T00:00:00.000Z' };
    },
    createIssue: async (input) => {
      created.push(input);
      return existing({ id: 'EI-NEW', title: input.title });
    },
    findIssuesByWatchdogKeys: async () => [prior],
    updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
    mergeIssuePayload: async (_id, patch, opts) => {
      merges.push({ patch, opts });
      const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
      for (const k of opts?.unset ?? []) delete payload[k];
      return existing({ ...prior, payload });
    },
    tagIssue: async () => {},
    untagIssue: async () => {},
  };
  return { d, created, merges };
}

async function secondReport(klass: Klass, state: 'probation' | 'promoted' = 'probation') {
  const h = harness(klass);
  const res = await captureImprovement(
    {
      title: 'coord:send tool-call failure', kind: 'bug', lane: 'observation', watchdogKey: KEY[klass],
      createdBy: 'su-b', payloadExtra: { toolFailureProbation: probation(klass, 'su-b', state) },
    },
    h.d,
  );
  const promotedWrite = h.merges.some((m) =>
    (m.patch.toolFailureProbation as { state?: string } | undefined)?.state === 'promoted' ||
    (m.opts?.unset ?? []).includes('lane'));
  return { res, promotedWrite, ...h };
}

describe('tool-failure volume gate (WI-6554700010018038)', () => {
  it('classifies transient and rate-limit as volume-gated, structural and caller as not', () => {
    expect(isVolumeGatedToolErrorClass('transient')).toBe(true);
    expect(isVolumeGatedToolErrorClass('rate-limit')).toBe(true);
    expect(isVolumeGatedToolErrorClass('structural')).toBe(false);
    expect(isVolumeGatedToolErrorClass('caller')).toBe(false);
    expect(isVolumeGatedToolErrorClass(undefined)).toBe(false);
  });

  it('gates only a probation-state payload: an explicitly promoted one carries its own evidence', () => {
    expect(isVolumeGatedToolFailureProbation({ state: 'probation', class: 'transient' })).toBe(true);
    expect(isVolumeGatedToolFailureProbation({ state: 'promoted', class: 'transient' })).toBe(false);
    expect(isVolumeGatedToolFailureProbation({ state: 'probation', class: 'structural' })).toBe(false);
    expect(isVolumeGatedToolFailureProbation(null)).toBe(false);
  });

  it.each(['transient', 'rate-limit'] as const)(
    'a second independent agent reporter on a %s probation row is counted, not promoted',
    async (klass) => {
      const { res, promotedWrite, created } = await secondReport(klass);
      expect(res.created).toBe(false);
      expect(res.reason).not.toBe('promoted');
      expect(res.issue?.id).toBe('EI-PROBATION');
      expect(created).toHaveLength(0);
      expect(promotedWrite).toBe(false);
    },
  );

  it('CONTROL: a second independent agent reporter on a structural probation row still promotes it', async () => {
    const { res, promotedWrite, created } = await secondReport('structural');
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(created).toHaveLength(0);
    expect(promotedWrite).toBe(true);
  });

  it('CONTROL: an explicitly promoted transient report (structured directEvidence) still promotes', async () => {
    const { res, promotedWrite } = await secondReport('transient', 'promoted');
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(promotedWrite).toBe(true);
  });
});
