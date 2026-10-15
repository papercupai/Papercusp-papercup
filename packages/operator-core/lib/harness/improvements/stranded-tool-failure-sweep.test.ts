/**
 * Unit tests for the stranded tool-failure sweep (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05 P-003 / D-022).
 *
 * The integration test drives the real tables; these pin every classification
 * branch and the executor's write discipline with injected deps, so a change to
 * the outcome order or the retirement evidence fails here first.
 */
import { describe, expect, it, vi } from 'vitest';

import type { GitRead } from '../../candidate-contains';
import type { ReproductionLedgerDeps, ReproductionVerification } from '../../attention/bug-reproduction';
import {
  STRANDED_SWEEP_OWNER,
  classifyExpiryCandidate,
  classifyStrandedRow,
  isAutomaticReport,
  renderCandidateExpiryNote,
  renderStrandedSweepNote,
  sweepExpiredCandidates,
  reportBuildOf,
  reportLastSeenAt,
  retirementFact,
  reproductionFact,
  sweepStrandedToolFailures,
  type RetirementVerdict,
} from './stranded-tool-failure-sweep';

const ROOT = '/repo';
const REPORT = 'aaaaaaa1111';
const CURRENT = 'bbbbbbb2222';
const T0 = '2026-10-01T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** A git reader over one path's commit history; `--since` filters by commit time, as git does. */
function fakeGit(commits: Array<{ sha: string; at: string }>, opts: { unreadable?: boolean } = {}): GitRead {
  return async (args) => {
    if (args[0] === 'config') return '';
    if (opts.unreadable) return null;
    if (args[0] === 'log') {
      const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
      return commits
        .filter((commit) => !since || Date.parse(commit.at) >= Date.parse(since))
        .map((commit) => commit.sha)
        .join('\n');
    }
    if (args[0] === 'ls-tree') return '100644 blob 0123456789abcdef\tpackages/tool.ts';
    return null;
  };
}

function strandedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    implementationReadiness: {
      schemaVersion: 'implementation-readiness-v1',
      status: 'unknown',
      source: 'capture-policy',
      reason: 'corroborated-tool-failure-awaiting-review',
      updatedAt: T0,
    },
    toolFailureProbation: {
      state: 'promoted',
      class: 'structural',
      deployedRevision: 'runtime-unknown',
      report: { toolName: 'facts:assert', errorCode: 'handler_error' },
    },
    freshnessEnvelope: { observedSourceSha: REPORT, observedRuntimeSha: REPORT, observedAt: T0 },
    ...overrides,
  };
}

function retirementDeps(over: Partial<Parameters<typeof retirementFact>[1]> = {}): Parameters<typeof retirementFact>[1] {
  return {
    currentBuild: () => CURRENT,
    sourceFileFor: () => `${ROOT}/packages/tool.ts`,
    repoRoot: ROOT,
    git: fakeGit([{ sha: 'c-fix', at: at(30) }]),
    lastFailureAfter: async () => null,
    ...over,
  };
}

const verified: ReproductionVerification = { status: 'verified', detail: 'ok', checkedAt: T0 };
const notRetirable: RetirementVerdict = { retirable: false, reason: 'freshness-unknown:git-unreadable' };
const retirable: RetirementVerdict = {
  retirable: true,
  toolName: 'facts:assert',
  errorCode: 'handler_error',
  relPath: 'packages/tool.ts',
  reportBuild: REPORT,
  currentBuild: CURRENT,
  changeCommits: ['c-fix'],
  lastMatchingFailureAt: T0,
};

describe('classifyStrandedRow (D-022 outcome order)', () => {
  it('a still-accepted receipt is born verified, ahead of retirement', () => {
    expect(classifyStrandedRow(strandedPayload(), { reproduction: verified, retirement: retirable })).toEqual({
      outcome: 'verified',
      reason: 'receipt-verified',
    });
    expect(
      classifyStrandedRow(strandedPayload(), {
        reproduction: { ...verified, status: 'attested' },
        retirement: notRetirable,
      }).outcome,
    ).toBe('verified');
  });

  it('a caller-classified failure never skips review on a receipt', () => {
    const payload = strandedPayload({
      toolFailureProbation: { state: 'promoted', class: 'caller', report: { toolName: 'facts:assert' } },
    });
    expect(classifyStrandedRow(payload, { reproduction: verified, retirement: notRetirable })).toEqual({
      outcome: 'review',
      reason: 'freshness-unknown:git-unreadable',
    });
  });

  it('a refuted receipt falls through to retirement evidence', () => {
    const refuted = { ...verified, status: 'refuted' as const };
    expect(classifyStrandedRow(strandedPayload(), { reproduction: refuted, retirement: retirable }).outcome).toBe('retired');
  });

  it('an unresolved freshness goes to review, never to retirement', () => {
    expect(classifyStrandedRow(strandedPayload(), { reproduction: null, retirement: notRetirable })).toEqual({
      outcome: 'review',
      reason: 'freshness-unknown:git-unreadable',
    });
  });
});

describe('report field readers', () => {
  it('reads the report build from the envelope source sha first, then runtime, then the probation revision', () => {
    expect(reportBuildOf(strandedPayload())).toBe(REPORT);
    expect(
      reportBuildOf({ freshnessEnvelope: { observedRuntimeSha: 'ccccccc3333' }, toolFailureProbation: { deployedRevision: 'ddddddd' } }),
    ).toBe('ccccccc3333');
    expect(reportBuildOf({ toolFailureProbation: { deployedRevision: 'ddddddd4444' } })).toBe('ddddddd4444');
    expect(reportBuildOf({ toolFailureProbation: { deployedRevision: 'runtime-unknown' } })).toBeNull();
    expect(reportBuildOf({})).toBeNull();
  });

  it('takes the latest stamp the report carries as its last sighting', () => {
    expect(
      reportLastSeenAt({
        lastSeenAt: at(5),
        toolFailureProbation: { firstSeenAt: at(1), lastSeenAt: at(9) },
        freshnessEnvelope: { observedAt: at(2) },
        toolInvocation: { invokedAt: 'not-a-date' },
      }),
    ).toBe(at(9));
    expect(reportLastSeenAt({})).toBeNull();
  });
});

describe('retirementFact (D-012 evidence)', () => {
  it('retires when the defining file changed after the last matching failure', async () => {
    const lastFailureAfter = vi.fn(async () => at(10));
    const verdict = await retirementFact(strandedPayload(), retirementDeps({ lastFailureAfter }));
    expect(verdict).toEqual({
      retirable: true,
      toolName: 'facts:assert',
      errorCode: 'handler_error',
      relPath: 'packages/tool.ts',
      reportBuild: REPORT,
      currentBuild: CURRENT,
      changeCommits: ['c-fix'],
      lastMatchingFailureAt: at(10),
    });
    expect(lastFailureAfter).toHaveBeenCalledWith('facts:assert', 'handler_error', T0);
  });

  it("falls back to the report's own sighting when the ledger shows no later failure", async () => {
    const verdict = await retirementFact(strandedPayload(), retirementDeps());
    expect(verdict).toMatchObject({ retirable: true, lastMatchingFailureAt: T0 });
  });

  it('keeps the row when the failure recurred after the last change', async () => {
    const verdict = await retirementFact(strandedPayload(), retirementDeps({ lastFailureAfter: async () => at(45) }));
    expect(verdict).toEqual({ retirable: false, reason: 'failure-after-last-change' });
  });

  it('keeps the row when the defining file did not change between the two builds', async () => {
    const verdict = await retirementFact(strandedPayload(), retirementDeps({ git: fakeGit([]) }));
    expect(verdict).toEqual({ retirable: false, reason: 'tool-unchanged-since-report' });
  });

  it('never retires on an unreadable git range', async () => {
    const verdict = await retirementFact(strandedPayload(), retirementDeps({ git: fakeGit([], { unreadable: true }) }));
    expect(verdict).toEqual({ retirable: false, reason: 'freshness-unknown:git-unreadable' });
  });

  it('names each missing input instead of guessing', async () => {
    expect(await retirementFact({}, retirementDeps())).toEqual({ retirable: false, reason: 'no-structured-tool-failure' });
    expect(await retirementFact(strandedPayload({ freshnessEnvelope: {} }), retirementDeps())).toEqual({
      retirable: false,
      reason: 'report-build-unknown',
    });
    expect(await retirementFact(strandedPayload(), retirementDeps({ currentBuild: () => null }))).toEqual({
      retirable: false,
      reason: 'current-build-unknown',
    });
    expect(await retirementFact(strandedPayload(), retirementDeps({ currentBuild: () => REPORT }))).toEqual({
      retirable: false,
      reason: 'report-on-current-build',
    });
    expect(await retirementFact(strandedPayload(), retirementDeps({ sourceFileFor: () => null }))).toEqual({
      retirable: false,
      reason: 'tool-source-unknown',
    });
    expect(await retirementFact(strandedPayload(), retirementDeps({ sourceFileFor: () => '/elsewhere/tool.ts' }))).toEqual({
      retirable: false,
      reason: 'source-outside-repo',
    });
    const throwing = retirementDeps({
      lastFailureAfter: async () => {
        throw new Error('pool exhausted');
      },
    });
    expect(await retirementFact(strandedPayload(), throwing)).toEqual({ retirable: false, reason: 'ledger-unreadable' });
  });
});

describe('reproductionFact', () => {
  const ledger: ReproductionLedgerDeps = {
    readTestRun: async () => null,
    readToolInvocation: async () => ({ status: 'error', servingBuildSha: REPORT }),
    now: () => new Date(T0),
  };
  const receipt = (status: string) => ({
    reproduction: {
      schemaVersion: 'bug-reproduction-v1',
      receipt: { kind: 'encounter', ref: 'tool_invocations:42', buildSha: REPORT },
      filedBy: 'su-peer',
      verification: { status, detail: '', checkedAt: T0 },
    },
  });

  it('re-verifies a stored receipt against the ledger', async () => {
    expect(await reproductionFact(strandedPayload(receipt('verified')), ledger)).toMatchObject({ status: 'verified' });
  });

  it('ignores ineligible filings, caller-classified failures and rows without a receipt', async () => {
    expect(await reproductionFact(strandedPayload(receipt('not-eligible')), ledger)).toBeNull();
    const caller = strandedPayload({
      ...receipt('verified'),
      toolFailureProbation: { class: 'caller', report: { toolName: 'facts:assert' } },
    });
    expect(await reproductionFact(caller, ledger)).toBeNull();
    expect(await reproductionFact(strandedPayload(), ledger)).toBeNull();
  });
});

describe('sweepStrandedToolFailures (executor)', () => {
  const rows = [
    { id: 'EI-verify', harness_slug: 'papercusp', createdBy: null, payload: strandedPayload({
      reproduction: {
        schemaVersion: 'bug-reproduction-v1',
        receipt: { kind: 'encounter', ref: 'tool_invocations:42', buildSha: REPORT },
        filedBy: 'su-peer',
        verification: { status: 'verified', detail: '', checkedAt: T0 },
      },
      // Unchanged tool: only the receipt can clear this row.
      toolFailureProbation: { class: 'structural', report: { toolName: 'tool:stable', errorCode: 'handler_error' } },
    }) },
    { id: 'EI-retire', harness_slug: 'papercusp', createdBy: null, payload: strandedPayload() },
    { id: 'EI-review', harness_slug: 'papercusp', createdBy: 'su-original', payload: strandedPayload({
      _ei: { created_by: 'su-original' },
      implementationReadiness: {
        schemaVersion: 'implementation-readiness-v1',
        status: 'unknown',
        source: 'triage-freshness',
        reason: 'deployment-freshness-unknown',
        updatedAt: T0,
      },
      toolFailureProbation: { class: 'structural', report: { toolName: 'tool:recurring', errorCode: 'timeout' } },
    }) },
  ];

  function harness(opts: { enterResult?: { entered: boolean; reason?: string } } = {}) {
    const sql = { unsafe: vi.fn(async () => rows) };
    const merge = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({}));
    const enterAgentReview = vi.fn(async () => opts.enterResult ?? { entered: true });
    const captureMerge = vi.fn(async () => ({}));
    const deps = {
      sql: sql as never,
      currentBuild: () => CURRENT,
      sourceFileFor: (tool: string) => `${ROOT}/packages/${tool.replace(':', '-')}.ts`,
      repoRoot: ROOT,
      git: (async (args: string[]) => {
        const path = String(args.at(-1));
        // tool:stable never changed; the others changed at +30m.
        return fakeGit(path.includes('tool-stable') ? [] : [{ sha: 'c-fix', at: at(30) }])(args);
      }) as GitRead,
      lastFailureAfter: async (tool: string) => (tool === 'tool:recurring' ? at(60) : null),
      ledger: {
        readTestRun: async () => null,
        readToolInvocation: async () => ({ status: 'error', servingBuildSha: REPORT }),
        now: () => new Date(T0),
      },
      mergeIssuePayload: merge,
      resolveRetired: resolve,
      getIssue: async (id: string) => {
        const row = rows.find((candidate) => candidate.id === id)!;
        return ({ id, scope: 'harness:papercusp', createdBy: row.createdBy, payload: row.payload }) as never;
      },
      captureDeps: { enterAgentReview, mergeIssuePayload: captureMerge } as never,
      now: () => Date.parse(T0),
    };
    return { deps, sql, merge, resolve, enterAgentReview, captureMerge };
  }

  it('verifies, retires and enrols each row once, under its own owner', async () => {
    const h = harness();
    const result = await sweepStrandedToolFailures('ws-1', h.deps);
    expect(result).toMatchObject({ scanned: 3, verified: 1, retired: 1, review: 1, enrolFailed: 0, deferred: 0, failed: 0 });
    expect(result.reviewReasons).toEqual({ 'failure-after-last-change': 1 });

    expect(h.merge).toHaveBeenCalledWith('EI-verify', expect.objectContaining({
      implementationReadiness: expect.objectContaining({ status: 'ready', reason: 'born-verified-tool-failure-promotion' }),
      reproduction: expect.objectContaining({ verification: expect.objectContaining({ status: 'verified' }) }),
    }));
    expect(h.merge).toHaveBeenCalledWith('EI-retire', expect.objectContaining({
      strandedToolFailureSweep: expect.objectContaining({
        owner: STRANDED_SWEEP_OWNER,
        outcome: 'retired',
        reportBuild: REPORT,
        currentBuild: CURRENT,
        lastMatchingFailureAt: T0,
        changeCommits: ['c-fix'],
      }),
      decidedReason: expect.stringContaining('D-012/D-022'),
    }));
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledWith('EI-retire');
    expect(h.enterAgentReview).toHaveBeenCalledWith(expect.objectContaining({
      id: 'EI-review',
      submittedBy: 'su-original',
      harnessSlug: 'papercusp',
      workspaceId: 'ws-1',
    }));
    expect(h.merge).toHaveBeenCalledWith('EI-review', {
      strandedToolFailureSweep: expect.objectContaining({ outcome: 'review', reason: 'failure-after-last-change' }),
    });
    // The candidate query is bounded and reads every stranded reason: the one stage
    // reason (P-008 / D-038) plus the two legacy reasons stamped before its migration.
    const [, params] = h.sql.unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([
      'ws-1',
      ['awaiting-agent-review', 'corroborated-tool-failure-awaiting-review', 'deployment-freshness-unknown'],
      200,
    ]);
  });

  it('dry run classifies without writing', async () => {
    const h = harness();
    const result = await sweepStrandedToolFailures('ws-1', h.deps, { dryRun: true });
    expect(result.plan).toEqual([
      { id: 'EI-verify', outcome: 'verified', reason: 'receipt-verified' },
      { id: 'EI-retire', outcome: 'retired', reason: 'tool-changed-and-quiet' },
      { id: 'EI-review', outcome: 'review', reason: 'failure-after-last-change' },
    ]);
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.enterAgentReview).not.toHaveBeenCalled();
  });

  it('stamps a refused enrolment instead of dropping it', async () => {
    const h = harness({ enterResult: { entered: false, reason: 'owner-capability' } });
    const result = await sweepStrandedToolFailures('ws-1', h.deps);
    expect(result).toMatchObject({ review: 0, enrolFailed: 1 });
    // The cause is reported, not just counted (first live run: 3 rows, cause invisible).
    expect(result.enrolFailures).toEqual([
      { id: 'EI-review', message: 'agent-review enrollment was not entered: owner-capability' },
    ]);
    expect(renderStrandedSweepNote(result)).toContain('enrolFailures=EI-review:owner-capability');
    expect(h.captureMerge).toHaveBeenCalledWith('EI-review', expect.objectContaining({
      agentReviewFailure: expect.objectContaining({ phase: 'enrollment' }),
    }));
  });

  it('defers the rest of the batch once the wall-time budget is spent', async () => {
    const h = harness();
    let clock = Date.parse(T0);
    const result = await sweepStrandedToolFailures(
      'ws-1',
      { ...h.deps, now: () => (clock += 1_000) },
      { budgetMs: 2_500 },
    );
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.verified + result.retired + result.review + result.deferred).toBe(3);
  });

  it('counts a row that throws and keeps going', async () => {
    const h = harness();
    h.merge.mockImplementationOnce(async () => {
      throw new Error('write conflict');
    });
    const result = await sweepStrandedToolFailures('ws-1', h.deps);
    expect(result.failed).toBe(1);
    expect(result.retired + result.review).toBe(2);
  });
});

describe('candidate expiry (P-011 / D-046 pt 6)', () => {
  const candidate = (overrides: Record<string, unknown> = {}) =>
    strandedPayload({ implementationReadiness: undefined, reporter: { kind: 'agent' }, reporterKinds: ['agent'], ...overrides });

  it('never expires a report any person made, whatever the evidence says', () => {
    for (const payload of [
      candidate({ reporter: { kind: 'end-user' }, reporterKinds: ['end-user'] }),
      candidate({ reporter: { kind: 'agent' }, reporterKinds: ['agent', 'end-user'] }),
      // A Slack report is a person's report (slack-messages-to-bug-reports D-012).
      candidate({ reporter: { kind: 'chat' }, reporterKinds: ['chat'] }),
      candidate({ reporter: { kind: 'watchdog' }, reporterKinds: ['watchdog', 'chat'] }),
    ]) {
      expect(isAutomaticReport(payload)).toBe(false);
      expect(classifyExpiryCandidate(payload, { reproduction: null, retirement: retirable })).toEqual({
        outcome: 'kept',
        reason: 'person-reported',
      });
    }
    expect(isAutomaticReport(candidate({ reporter: { kind: 'watchdog' }, reporterKinds: ['watchdog'] }))).toBe(true);
  });

  it('keeps a candidate somebody reproduced, and one whose evidence is incomplete', () => {
    expect(classifyExpiryCandidate(candidate(), { reproduction: verified, retirement: retirable })).toEqual({
      outcome: 'kept',
      reason: 'receipt-verified',
    });
    expect(classifyExpiryCandidate(candidate(), { reproduction: null, retirement: notRetirable })).toEqual({
      outcome: 'kept',
      reason: 'freshness-unknown:git-unreadable',
    });
    expect(classifyExpiryCandidate(candidate(), { reproduction: null, retirement: retirable })).toEqual({
      outcome: 'expired',
      reason: 'tool-changed-and-quiet',
    });
  });

  function harness(rows: Array<{ id: string; harness_slug: string; payload: Record<string, unknown> }>) {
    const sql = { unsafe: vi.fn(async () => rows) };
    const merge = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({}));
    const deps = {
      sql: sql as never,
      currentBuild: () => CURRENT,
      sourceFileFor: (tool: string) => `${ROOT}/packages/${tool.replace(':', '-')}.ts`,
      repoRoot: ROOT,
      git: (async (args: string[]) => {
        const path = String(args.at(-1));
        return fakeGit(path.includes('tool-stable') ? [] : [{ sha: 'c-fix', at: at(30) }])(args);
      }) as GitRead,
      lastFailureAfter: async () => null,
      ledger: { readTestRun: async () => null, readToolInvocation: async () => null, now: () => new Date(T0) },
      mergeIssuePayload: merge,
      resolveRetired: resolve,
      now: () => Date.parse(T0),
    };
    return { deps, sql, merge, resolve };
  }

  it('expires a quiet automatic candidate with D-012 evidence and stamps the rest against this build', async () => {
    const h = harness([
      { id: 'EI-expire', harness_slug: 'papercusp', payload: candidate() },
      {
        id: 'EI-stable',
        harness_slug: 'papercusp',
        payload: candidate({ toolFailureProbation: { class: 'structural', report: { toolName: 'tool:stable', errorCode: 'x' } } }),
      },
    ]);
    const result = await sweepExpiredCandidates('ws-1', h.deps);

    expect(result).toMatchObject({ scanned: 2, expired: 1, kept: 1, failed: 0 });
    expect(result.keptReasons).toEqual({ 'tool-unchanged-since-report': 1 });
    expect(h.merge).toHaveBeenCalledWith('EI-expire', expect.objectContaining({
      decidedReason: expect.stringContaining('D-012/D-046'),
      candidateExpiry: expect.objectContaining({
        owner: STRANDED_SWEEP_OWNER,
        outcome: 'expired',
        checkedBuild: CURRENT,
        reportBuild: REPORT,
        changeCommits: ['c-fix'],
      }),
    }));
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledWith('EI-expire');
    expect(h.merge).toHaveBeenCalledWith('EI-stable', {
      candidateExpiry: expect.objectContaining({ outcome: 'kept', reason: 'tool-unchanged-since-report', checkedBuild: CURRENT }),
    });
    // Only admission-pending automatic candidates not yet checked against this build are read.
    const [query, params] = h.sql.unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(['ws-1', CURRENT, 200]);
    expect(query).toContain("admission = 'pending'");
    // Every person door is excluded in SQL too: an end user, or a chat report (Slack D-012).
    expect(query).toContain("?| ARRAY['end-user', 'chat']");
    expect(query).toContain("payload->'candidateExpiry'->>'checkedBuild' IS DISTINCT FROM $2");
  });

  it('re-checks a transient unknown next tick instead of stamping it', async () => {
    const h = harness([{ id: 'EI-flaky', harness_slug: 'papercusp', payload: candidate() }]);
    const result = await sweepExpiredCandidates('ws-1', { ...h.deps, lastFailureAfter: async () => { throw new Error('pg down'); } });
    expect(result).toMatchObject({ kept: 1, keptReasons: { 'ledger-unreadable': 1 } });
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('does nothing when the serving build is unknown, and dry run writes nothing', async () => {
    const h = harness([{ id: 'EI-expire', harness_slug: 'papercusp', payload: candidate() }]);
    expect(await sweepExpiredCandidates('ws-1', { ...h.deps, currentBuild: () => null })).toMatchObject({
      scanned: 0,
      skipped: 'current-build-unknown',
    });
    expect(h.sql.unsafe).not.toHaveBeenCalled();

    const dry = await sweepExpiredCandidates('ws-1', h.deps, { dryRun: true });
    expect(dry.plan).toEqual([{ id: 'EI-expire', outcome: 'expired', reason: 'tool-changed-and-quiet' }]);
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('renders a one-line note', () => {
    expect(
      renderCandidateExpiryNote({ scanned: 3, expired: 1, kept: 2, deferred: 0, failed: 0, keptReasons: { 'person-reported': 2 } }),
    ).toBe('candidate-expiry scanned=3 expired=1 kept=2 deferred=0 failed=0 keptReasons=person-reported:2');
    expect(renderCandidateExpiryNote({ scanned: 0, expired: 0, kept: 0, deferred: 0, failed: 0, keptReasons: {}, skipped: 'current-build-unknown' })).toBe(
      'candidate-expiry skipped=current-build-unknown',
    );
    expect(renderCandidateExpiryNote({ error: 'boom' })).toBe('candidate-expiry error=boom');
  });
});

describe('renderStrandedSweepNote', () => {
  it('renders counts and the top review reasons', () => {
    expect(
      renderStrandedSweepNote({
        scanned: 4, verified: 1, retired: 1, review: 2, enrolFailed: 0, enrolFailures: [], deferred: 0, failed: 0,
        reviewReasons: { 'tool-unchanged-since-report': 2 },
      }),
    ).toBe(
      'stranded-sweep scanned=4 verified=1 retired=1 review=2 enrolFailed=0 deferred=0 failed=0 ' +
        'reviewReasons=tool-unchanged-since-report:2',
    );
    expect(renderStrandedSweepNote({ error: 'boom' })).toBe('stranded-sweep error=boom');
  });
});
