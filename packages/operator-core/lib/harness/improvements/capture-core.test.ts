import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  captureImprovement,
  captureToolInvocationFriction,
  validateScoutEvidenceCitations,
  storageKindOf,
  CaptureWatchdogIdentityConflictError,
  DUP_THRESHOLD,
  CONTAINMENT_THRESHOLD,
  CAPTURE_LEXICAL_SEARCH_BUDGET_MS,
  TOOL_FAILURE_SIGNATURE_MAX_CLASSES,
  tallyToolFailureClass,
  type CaptureDependencyTiming,
  type CaptureDeps,
} from './capture-core';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import type { SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';
import { titleSimilarity, titleContainment } from './digest';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC } from './read-items';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';
import { assessIssueAdmissionPressure, type RecordIssueOccurrenceInput } from '../../issue-occurrence-ledger';
import { metadataToolFailure, metadataWorkflowTargets } from '../../agent-tools/plans/coordination-metadata-fixtures';
import { normalizeSuspectedToolFailure, type SuspectedToolFailure } from './tool-error-classifier';

afterEach(() => {
  vi.mocked(findRecentLexicalDupes).mockReset().mockResolvedValue(null);
});

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../agent-tools/work_items/recent-lexical-dupe-guard', () => ({
  findRecentLexicalDupes: vi.fn(async () => null),
}));

import { findRecentLexicalDupes } from '../../agent-tools/work_items/recent-lexical-dupe-guard';

function existing(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
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
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    closedAt: null,
    goalId: null,
    ...p,
  };
}

function occurrenceReceipt(input: RecordIssueOccurrenceInput, occurrenceId: number) {
  return {
    occurrenceId,
    workspaceId: 'ws',
    canonicalHarness: input.canonicalHarness ?? 'papercusp',
    canonicalId: input.canonicalId,
    reportKind: input.reportKind,
    occurredAt: '2026-10-01T00:00:00.000Z',
  };
}

function deps(
  opts: {
    found?: EngineerIssue[];
    setCheckpoint?: CaptureDeps['setCheckpoint'];
    resolvePotScope?: CaptureDeps['resolvePotScope'];
  } = {},
): CaptureDeps & {
  created: CreateIssueInput[];
  occurrences: RecordIssueOccurrenceInput[];
  emitted: Parameters<NonNullable<CaptureDeps['emitAwaitedEvent']>>[0][];
} {
  const created: CreateIssueInput[] = [];
  const occurrences: RecordIssueOccurrenceInput[] = [];
  const emitted: Parameters<NonNullable<CaptureDeps['emitAwaitedEvent']>>[0][] = [];
  return {
    created,
    occurrences,
    emitted,
    // WI-6554700010008444: never reach the real awaited-event engine from a unit test.
    emitAwaitedEvent: async (opts) => {
      emitted.push(opts);
      return {};
    },
    searchIssues: async () => opts.found ?? [],
    setCheckpoint: opts.setCheckpoint,
    resolvePotScope: opts.resolvePotScope ?? (async ({ rawSlug }) => rawSlug),
    recordIssueOccurrence: async (input) => {
      occurrences.push(input);
      return occurrenceReceipt(input, occurrences.length);
    },
    createIssue: async (input) => {
      created.push(input);
      return existing({ id: 'EI-100', title: input.title, kind: (input.kind as 'bug' | 'change') ?? 'bug' });
    },
  };
}

function semanticCoverageAssessment(
  verdict: NonNullable<SemanticDupeResult['coverage']>['verdict'],
): NonNullable<SemanticDupeResult['coverage']> {
  return {
    source: 'work_items:semantic-dupe-guard',
    verdict,
    coverage: verdict === 'healthy' ? 0.99 : verdict === 'degraded' ? 0.5 : null,
    recentCoverage: null,
    surfaces: [],
    unknownSurfaces: verdict === 'unknown' ? ['harness_shared.work_items.embedding'] : [],
    note: `fixture coverage is ${verdict}`,
  };
}

function healthySemanticResult(
  thresholds: SemanticDupeResult['thresholds'] = { hard: 0.93, soft: 0.9 },
): SemanticDupeResult {
  return { hard: [], soft: [], thresholds, coverage: semanticCoverageAssessment('healthy') };
}

describe('storageKindOf — the native column mapping (close-loop D-002)', () => {
  it('bug → bug; change → change; feature → change (payload refinement)', () => {
    expect(storageKindOf('bug')).toBe('bug');
    expect(storageKindOf('change')).toBe('change');
    expect(storageKindOf('feature')).toBe('change');
  });
});

describe('captureImprovement — dependency timing observer', () => {
  it('reports dependency durations and ignores observer failures', async () => {
    const d = deps();
    const samples: CaptureDependencyTiming[] = [];
    const privateText = 'private dependency timing text';
    d.recordIssueOccurrence = async () => {
      throw new Error('temporary occurrence failure');
    };

    const result = await captureImprovement(
      {
        title: 'instrument dependency stages',
        body: privateText,
        kind: 'bug',
        scope: 'harness:papercusp',
        onDependencyTiming: (sample) => {
          samples.push(sample);
          throw new Error('diagnostic observer failed');
        },
      },
      d,
    );

    expect(result).toMatchObject({ ok: true, created: true, issue: { id: 'EI-100' } });
    expect(samples.map((sample) => sample.dependency)).toEqual(
      expect.arrayContaining(['searchIssues', 'createIssue', 'recordIssueOccurrence']),
    );
    expect(samples.find((sample) => sample.dependency === 'recordIssueOccurrence')?.outcome).toBe('rejected');
    expect(samples.every((sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(samples)).not.toContain(privateText);
  });
});

describe('captureImprovement — durable artifact reservation', () => {
  const input = {
    artifactId: 'EI-321',
    watchdogKey: 'dream:reserved-run',
    title: 'Frozen reviewed proposal',
    kind: 'feature' as const,
    scope: 'harness:papercusp',
  };
  it('reuses a terminal reserved artifact without rewriting its original body or provenance', async () => {
    const d = deps();
    const original = existing({
      id: 'EI-321',
      title: 'Original title',
      scope: input.scope,
      state: 'resolved',
      body: 'Original body',
      payload: { watchdogKey: input.watchdogKey, dream: { candidateHash: 'original' } },
    });
    d.getIssue = async () => original;
    const result = await captureImprovement(
      { ...input, body: 'A later replay', payloadExtra: { dream: { candidateHash: 'changed' } } },
      d,
    );
    expect(result).toMatchObject({ created: false, issue: original });
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toHaveLength(0);
  });
  it('passes the reserved id to the existing create writer and recovers a concurrent primary-key winner', async () => {
    const d = deps();
    let winner: EngineerIssue | null = null;
    d.getIssue = async () => winner;
    d.findIssuesByWatchdogKeys = async () => [];
    d.createIssue = async (value) => {
      expect(value.id).toBe(input.artifactId);
      winner = existing({ id: value.id!, title: value.title, scope: input.scope, payload: value.payload });
      throw Object.assign(new Error('concurrent primary-key insert'), { code: '23505' });
    };
    expect(await captureImprovement(input, d)).toMatchObject({ created: false, issue: { id: input.artifactId } });
  });
  it('counterexample: a reserved id owned by another run cannot be reused', async () => {
    const d = deps();
    d.getIssue = async () =>
      existing({
        id: input.artifactId,
        title: input.title,
        scope: input.scope,
        payload: { watchdogKey: 'dream:someone-else' },
      });
    await expect(captureImprovement(input, d)).rejects.toThrow('another identity');
    expect(d.created).toHaveLength(0);
  });
});

describe('captureImprovement — initialState seam (observation-lane-scorecard-classification-2026-08-16 D-002/D-005)', () => {
  it("passes initialState:'done' through to createIssue.state — the scorecards:emit verdict path", async () => {
    const d = deps();
    await captureImprovement(
      { title: 'Scorecard: Test Rubric', kind: 'change', lane: 'observation', initialState: 'done' },
      d,
    );
    expect(d.created[0].state).toBe('done');
  });

  it('CONTROL: an ordinary capture passes NO state — createIssue defaults to open downstream', async () => {
    const d = deps();
    await captureImprovement({ title: 'plain observation', kind: 'change', lane: 'observation' }, d);
    // Absence, not 'open': the default lives in ONE place (createIssue's INSERT),
    // so this seam must not restate it. The conditionKey collapse
    // (EI-19325151590626958) depends on capture-route rows staying open.
    expect(d.created[0].state).toBeUndefined();
  });

  it('scorecard verdicts bypass derived observation folding and mint an immutable row', async () => {
    setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
    const prior = existing({
      id: 'EI-prior-scorecard',
      title: 'an unrelated prior scorecard observation',
      kind: 'change',
      state: 'open',
      payload: { lane: 'observation', repeatCount: 1 },
    });
    const d = deps();
    const merges: string[] = [];
    d.findSemanticDupes = async () => ({
      hard: [{ id: prior.id, title: prior.title, state: prior.state, harness: null, similarity: 0.88 }],
      soft: [],
      thresholds: { hard: 0.93, soft: 0.8 },
    });
    d.getIssue = async (id) => (id === prior.id ? prior : null);
    d.mergeIssuePayload = async (id) => {
      merges.push(id);
      return prior;
    };

    const result = await captureImprovement(
      {
        title: 'a fresh acceptance scorecard',
        kind: 'change',
        lane: 'observation',
        initialState: 'done',
      },
      d,
    );

    expect(result).toMatchObject({ ok: true, created: true });
    expect(d.created).toHaveLength(1);
    expect(d.created[0].state).toBe('done');
    expect(merges).toEqual([]);
  });
});

describe('captureImprovement — retries transient atomic-write contention (EI-21869609589204831)', () => {
  it('retries a pre-execution postgres-js CONNECT_TIMEOUT at the atomic create boundary', async () => {
    const d = deps();
    const connectTimeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
      code: 'CONNECT_TIMEOUT',
    });
    let attempts = 0;
    d.createIssue = async (input) => {
      attempts += 1;
      if (attempts === 1) throw connectTimeout;
      return existing({ id: 'EI-connect-recovered', title: input.title, kind: 'change', state: 'done' });
    };

    const result = await captureImprovement({
      title: 'capture after a PostgreSQL connection timeout',
      kind: 'change',
      lane: 'observation',
      initialState: 'done',
    }, d);

    expect(result).toMatchObject({ ok: true, created: true, issue: { id: 'EI-connect-recovered' } });
    expect(attempts).toBe(2);
  });

  it('does not retry an ambiguous post-connect connection loss at the create boundary', async () => {
    const d = deps();
    const connectionClosed = Object.assign(new Error('write CONNECTION_CLOSED localhost:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    let attempts = 0;
    d.createIssue = async () => {
      attempts += 1;
      throw connectionClosed;
    };

    await expect(captureImprovement({
      title: 'do not replay a possibly applied write',
      kind: 'change',
      lane: 'observation',
      initialState: 'done',
    }, d)).rejects.toBe(connectionClosed);

    expect(attempts).toBe(1);
  });

  it('retries a 55P03 create timeout and preserves the capture when the next attempt succeeds', async () => {
    const d = deps();
    let attempts = 0;
    d.createIssue = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
      return existing({ id: 'EI-recovered', title: input.title, kind: (input.kind as 'bug' | 'change') ?? 'bug' });
    };

    const result = await captureImprovement({ title: 'capture after transient contention', kind: 'bug' }, d);

    expect(result).toMatchObject({ ok: true, created: true, issue: { id: 'EI-recovered' } });
    expect(attempts).toBe(2);
  });

  it('runs the pre-create check immediately before every insert attempt, including retries', async () => {
    const d = deps();
    const steps: string[] = [];
    let attempts = 0;
    d.searchIssues = async () => {
      steps.push('search');
      return [];
    };
    d.findSemanticDupes = async () => null;
    d.createIssue = async (input) => {
      steps.push('create');
      attempts += 1;
      if (attempts === 1) throw new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
      return existing({ id: 'EI-retried-boundary', title: input.title });
    };

    await expect(captureImprovement({
      title: 'recheck generation at every insert attempt',
      kind: 'bug',
      beforeIssueCreate: async () => {
        steps.push('before-create');
      },
    }, d)).resolves.toMatchObject({ created: true, issue: { id: 'EI-retried-boundary' } });

    expect(steps).toEqual(['search', 'before-create', 'create', 'before-create', 'create']);
  });

  it('does not attempt the insert when the pre-create check refuses', async () => {
    const d = deps();
    const refusal = new Error('generation changed; gather again');
    const beforeIssueCreate = vi.fn(() => {
      throw refusal;
    });

    await expect(captureImprovement({
      title: 'refuse stale scorecard generation',
      kind: 'change',
      lane: 'observation',
      initialState: 'done',
      beforeIssueCreate,
    }, d)).rejects.toBe(refusal);

    expect(beforeIssueCreate).toHaveBeenCalledTimes(1);
    expect(d.created).toHaveLength(0);
  });
});

describe('captureImprovement — review-required pre-enrollment park', () => {
  const reviewInput = {
    title: 'proposal requiring agent review',
    kind: 'change' as const,
    scope: 'harness:papercusp',
    createdBy: 'su-filer',
    reviewRequired: true,
    reviewHarness: 'papercusp',
  };

  it.each(['end-user', 'chat'] as const)('enrolls a %s bug in verification before it can be implemented', async (reporterKind) => {
    const d = deps();
    d.createIssue = async (input) => {
      d.created.push(input);
      return existing({ id: 'EI-100', title: input.title, payload: input.payload });
    };
    const transitions: string[] = [];
    d.setWorkItemStateWithAliasInfo = async (id, state) => {
      transitions.push(state);
      return { workItem: { id, state }, requestedState: state, appliedState: state };
    };
    d.enterAgentReview = vi.fn(async () => ({ entered: true, state: { status: 'pending' } }));

    const result = await captureImprovement({
      title: 'Checkout applies the wrong discount',
      kind: 'bug',
      reporterKind,
      scope: 'harness:papercusp',
      workspaceId: 'ws',
      createdBy: 'system:connector',
      severity: 'critical',
      assignee: 'su-fixer',
    }, d);

    expect(d.created[0]).toMatchObject({ admission: 'pending', payload: {
      implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' },
    } });
    expect(d.enterAgentReview).toHaveBeenCalledWith({
      id: 'EI-100', submittedBy: 'system:connector', harnessSlug: 'papercusp', workspaceId: 'ws',
    });
    expect(transitions).toEqual(['blocked', 'open']);
    expect(result).toMatchObject({ reviewRequired: true, reviewState: 'open' });
  });

  it('keeps a person bug fenced and records an enrollment failure', async () => {
    const d = deps();
    d.createIssue = async (input) => {
      d.created.push(input);
      return existing({ id: 'EI-100', title: input.title, payload: input.payload });
    };
    d.setWorkItemStateWithAliasInfo = async (id, state) => ({
      workItem: { id, state }, requestedState: state, appliedState: state,
    });
    d.enterAgentReview = async () => { throw new Error('review enrollment unavailable'); };
    d.mergeIssuePayload = vi.fn(async () => existing({ id: 'EI-100', title: 'bug' }));

    const result = await captureImprovement({
      title: 'Checkout applies the wrong discount', kind: 'bug', reporterKind: 'end-user',
      scope: 'harness:papercusp', createdBy: 'system:connector',
    }, d);

    expect(d.created[0]).toMatchObject({ admission: 'pending', payload: {
      implementationReadiness: { status: 'unknown' },
    } });
    expect(result).toMatchObject({ reviewState: 'blocked', agentReviewFailure: {
      phase: 'enrollment', message: 'review enrollment unavailable',
    } });
    expect(d.mergeIssuePayload).toHaveBeenCalledWith('EI-100', expect.objectContaining({
      agentReviewFailure: expect.objectContaining({ phase: 'enrollment' }),
    }));
  });

  it('creates with pending admission, then durably parks the row as blocked', async () => {
    const d = deps();
    const transitions: { id: string; state: string; opts?: Record<string, unknown> }[] = [];
    d.setWorkItemStateWithAliasInfo = async (id, state, opts) => {
      transitions.push({ id, state, opts });
      return { workItem: { id, state }, requestedState: state, appliedState: state };
    };

    const result = await captureImprovement(reviewInput, d);

    expect(d.created[0]).toMatchObject({ admission: 'pending' });
    expect(d.created[0].payload).toMatchObject({
      implementationReadiness: {
        schemaVersion: 'implementation-readiness-v1',
        status: 'unknown',
        source: 'capture-policy',
        reason: 'awaiting-agent-review',
      },
    });
    expect(transitions).toEqual([
      {
        id: 'EI-100',
        state: 'blocked',
        opts: { harness: 'papercusp', by: 'su-filer', reason: 'agent-review enrollment pending' },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      created: true,
      reviewRequired: true,
      reviewState: 'blocked',
    });
  });

  it('returns the committed capture and records block failure metadata when the park fails', async () => {
    const released: { id: string; opts?: Record<string, unknown> }[] = [];
    const merged: Record<string, unknown>[] = [];
    const d = {
      ...deps(),
      setWorkItemStateWithAliasInfo: async () => {
        throw new Error('blocked write failed');
      },
      releaseIssue: async (id: string, opts?: { expectedAssignee?: string }) => {
        released.push({ id, opts });
        return existing({ id, title: reviewInput.title });
      },
      mergeIssuePayload: async (_id: string, patch: Record<string, unknown>) => {
        merged.push(patch);
        return existing({ id: 'EI-100', title: reviewInput.title });
      },
    } satisfies CaptureDeps;

    const result = await captureImprovement(reviewInput, d);

    expect(result).toMatchObject({
      ok: true,
      created: true,
      reviewRequired: true,
      agentReviewFailure: { phase: 'block', message: 'blocked write failed' },
    });
    expect(released).toEqual([{ id: 'EI-100', opts: { expectedAssignee: 'su-filer' } }]);
    expect(merged[0]).toMatchObject({
      blockedReason: 'agent-review-block-failed',
      blockedAt: expect.any(String),
      agentReviewFailure: { phase: 'block', message: 'blocked write failed' },
    });
  });

  it('does not apply the review park to bugs or observation-lane captures', async () => {
    const d = deps();
    const writer = vi.fn(async (id: string, state: 'blocked' | 'open') => ({
      workItem: { id, state },
      requestedState: state,
      appliedState: state,
    }));
    d.setWorkItemStateWithAliasInfo = writer;

    await captureImprovement({ ...reviewInput, kind: 'bug' }, d);
    await captureImprovement({ ...reviewInput, lane: 'observation' }, d);

    expect(writer).not.toHaveBeenCalled();
    expect(d.created[0].payload).toMatchObject({
      implementationReadiness: {
        status: 'ready',
        reason: 'existing-immediate-capture-policy',
      },
    });
    expect(d.created[1].payload).not.toHaveProperty('implementationReadiness');
  });

  it('does not mistake a distinct-remedy/force assertion for implementation approval', async () => {
    const d = deps();
    d.setWorkItemStateWithAliasInfo = async (id, state) => ({
      workItem: { id, state },
      requestedState: state,
      appliedState: state,
    });

    await captureImprovement({ ...reviewInput, force: true }, d);

    expect(d.created[0].payload).toMatchObject({
      implementationReadiness: {
        status: 'unknown',
        reason: 'awaiting-agent-review',
      },
    });
  });
});

describe('captureImprovement — born admission for captured work', () => {
  it('starts ordinary bugs pending so the promoter sees duplicate and freshness evidence before self-pull', async () => {
    const d = deps();
    await captureImprovement({ title: 'novel admission regression', kind: 'bug' }, d);
    expect(d.created[0]).toMatchObject({ admission: 'pending' });
    expect(d.created[0].admittedBy).toBeUndefined();
  });

  it.each([
    [{ severity: 'critical' as const }, 'bypass:severity-critical'],
    [{ subTopic: 'security' }, 'bypass:topic-security'],
    [{ assignee: 'su-fixer', createdBy: 'su-filer' }, 'bypass:explicit-assignment'],
  ])('records an attributable bypass for %j', async (override, reason) => {
    const d = deps();
    await captureImprovement({ title: `urgent capture ${reason}`, kind: 'bug', ...override }, d);
    expect(d.created[0]).toMatchObject({ admission: 'auto', admittedBy: reason });
  });

  it('keeps observations outside admission and non-reviewed change captures pending', async () => {
    const d = deps();
    await captureImprovement({ title: 'sensor observation', kind: 'change', lane: 'observation' }, d);
    await captureImprovement({ title: 'ordinary change', kind: 'change' }, d);
    expect(d.created[0].admission).toBeUndefined();
    expect(d.created[1].admission).toBe('pending');
  });
});

describe('captureImprovement — filer-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('stamps payload.filedByRole on an observation when given (fixes the ~100% unknown bucket)', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'pot-coordination-health scorecard', kind: 'change', lane: 'observation', filedByRole: 'kettle' },
      d,
    );
    expect((d.created[0].payload as Record<string, unknown>).filedByRole).toBe('kettle');
  });

  it('stamps payload.filedByRole on an improvement too', async () => {
    const d = deps();
    await captureImprovement({ title: 'docs:search friction', kind: 'bug', filedByRole: 'cup' }, d);
    expect((d.created[0].payload as Record<string, unknown>).filedByRole).toBe('cup');
  });

  it('omits filedByRole when not provided (no empty stamp)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation' }, d);
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.filedByRole).toBeUndefined();
  });
});

describe('Scout evidence citations (EI-19450720466036446)', () => {
  it('records unresolved and same-role citations at capture time', async () => {
    const d = deps();
    d.getIssue = async (id) =>
      id === 'EI-200' ? existing({ id, title: 'Scout sibling', payload: { sourceRole: 'Scout' } }) : null;

    await captureImprovement(
      {
        title: 'watchdog false-fire experiment',
        kind: 'change',
        body: 'Known incident evidence: EI-200 and EI-404.',
        sourceRole: 'Scout',
      },
      d,
    );

    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.checked).toBe(true);
    expect(integrity.citedIds).toEqual(['EI-200', 'EI-404']);
    expect(integrity.resolvedIds).toEqual(['EI-200']);
    expect(integrity.unresolvedIds).toEqual(['EI-404']);
    expect(integrity.circularIds).toEqual(['EI-200']);
    expect(integrity.lookupFailedIds).toEqual([]);
  });

  it('records resolver failures without rejecting the Scout capture', async () => {
    const d = deps();
    d.getIssue = async () => {
      throw new Error('temporary datastore outage');
    };
    const result = await captureImprovement(
      { title: 'watchdog evidence retry', kind: 'bug', body: 'See EI-405.', sourceRole: 'Scout' },
      d,
    );

    expect(result.created).toBe(true);
    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.checked).toBe(true);
    expect(integrity.unresolvedIds).toEqual([]);
    expect(integrity.lookupFailedIds).toEqual(['EI-405']);
  });

  /**
   * WI-2147241 — the capture-time record resolved citations through the ISSUE-family door,
   * so a real feature-family `WI-`/`F-` row (which lives in `work_items`, invisible to that
   * view) was written into `evidenceIntegrity.unresolvedIds` — an audit record asserting
   * "fabricated" about a citation that resolves fine.
   */
  it('records a FEATURE-family citation as resolved via the mixed-family door, scoped to the harness', async () => {
    const d = deps();
    // The issue-family door genuinely cannot see feature rows — same as production.
    d.getIssue = async () => null;
    const seen: { id: string; harness?: string }[] = [];
    d.getCitedWorkItem = async (id, harness) => {
      seen.push({ id, harness });
      return id === 'WI-2145950' ? { payload: {} } : null;
    };

    await captureImprovement(
      {
        title: 'grounded proposal',
        kind: 'change',
        body: 'Grounded in the measurement published as WI-2145950.',
        sourceRole: 'Scout',
        scope: 'harness:papercusp',
      },
      d,
    );

    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.resolvedIds).toEqual(['WI-2145950']);
    expect(integrity.unresolvedIds).toEqual([]);
    // A `WI-<n>` id is unique only within a (workspace, harness) — an unscoped read can
    // resolve it to a stranger's row, so the citing item's harness must reach the door.
    expect(seen).toEqual([{ id: 'WI-2145950', harness: 'papercusp' }]);
  });

  it('STILL records a citation absent from BOTH families as unresolved (fabrication detection preserved)', async () => {
    const d = deps();
    d.getIssue = async () => null;
    d.getCitedWorkItem = async () => null;

    await captureImprovement(
      { title: 'ungrounded', kind: 'change', body: 'Per WI-999999.', sourceRole: 'Scout', scope: 'harness:papercusp' },
      d,
    );

    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.unresolvedIds).toEqual(['WI-999999']);
    expect(integrity.resolvedIds).toEqual([]);
  });

  it('returns no integrity record when a proposal has no work-item citations', async () => {
    const integrity = await validateScoutEvidenceCitations('No prior incident ids are named here.');
    expect(integrity).toBeUndefined();
  });
});

describe('captureImprovement — observation lane (turn-end-reflection-observations-2026-06-14 D-005)', () => {
  it('files the OBSERVATION topic, NOT the improvement topic (invisible to the work pipeline)', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'docs:search returned stale results', kind: 'change', lane: 'observation' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].topics).toContain(OBSERVATION_TOPIC);
    expect(d.created[0].topics).not.toContain(IMPROVEMENT_TOPIC);
  });

  it('always stores as a non-bug nit + marks payload.lane (never auto-implement-eligible)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'bug', lane: 'observation' }, d); // kind=bug is IGNORED for observations
    expect(d.created[0].kind).toBe('change');
    expect(d.created[0].severity).toBe('nit');
    expect(d.created[0].payload).toMatchObject({ lane: 'observation' });
  });

  it('keeps observations non-claimable when an assignee is supplied', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'observed friction', kind: 'change', lane: 'observation', assignee: 'su-filer' },
      d,
    );
    expect(d.created[0]).not.toHaveProperty('assignee');
    expect(d.created[0]).not.toHaveProperty('assignedBy');
  });

  it('carries NO auto-implement lifecycle / paths (it is never dispatchable)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation', paths: ['libs/x/y.ts'] }, d);
    const payload = d.created[0].payload as Record<string, unknown> | undefined;
    expect(payload?.ideaLifecycle).toBeUndefined();
    expect(payload?.paths).toBeUndefined();
  });

  it('SKIPS dedup — a recurring observation re-files even when a similar one exists (recurrence IS the signal)', async () => {
    const d = deps({ found: [existing({ id: 'EI-9', title: 'docs:search returned stale results' })] });
    const res = await captureImprovement(
      { title: 'docs:search returned stale results', kind: 'change', lane: 'observation' },
      d,
    );
    expect(res.created).toBe(true); // NOT declined as a likely-duplicate
    expect(d.created).toHaveLength(1);
  });

  it('merges the structured observation record via payloadExtra', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'validator loop is confusing',
        kind: 'change',
        lane: 'observation',
        payloadExtra: { observation: { kind: 'friction', scope: 'role', confidence: 'med' } },
      },
      d,
    );
    expect(d.created[0].payload).toMatchObject({
      lane: 'observation',
      observation: { kind: 'friction', scope: 'role', confidence: 'med' },
    });
  });
});

describe('captureImprovement — correlated tool-failure probation (P-013)', () => {
  const key = 'repeated-tool-error:coord:send:caller:invalid-args-body-must-be';
  const probation = (reporter: string) => ({
    state: 'probation' as const,
    class: 'caller',
    watchdogKey: key,
    correlationFingerprint: 'coord:send|invalid_args|42|body|codex-1.2|invalid-args-body-must-be',
    intendedKind: 'change' as const,
    reporters: [reporter],
    report: {
      toolName: 'coord:send', errorCode: 'invalid_args', status: 'error',
      message: 'invalid_args: body must be an array', schemaRevision: '42',
      fieldPath: 'body', runtimeVersion: 'codex-1.2',
    },
  });

  it('R-7 automatically coalesces the frozen retry population with zero incident fields', async () => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const prior = existing({ id: 'EI-METADATA-FRICTION', title: 'known friction', kind: 'change',
      scope: 'harness:papercusp', payload: { lane: 'observation', watchdogKey: normalized.watchdogKey,
        toolFailureProbation: { ...normalized, state: 'probation', reporters: ['su-a'], report: metadataToolFailure } } });
    const d = { ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      findIssuesByToolFailureClassKeys: async () => [prior],
      updateIssuePatch: async (_id: string, patch: object) => Object.assign(prior, patch),
      mergeIssuePayload: async (_id: string, patch: object) => {
        prior.payload = { ...(prior.payload as object), ...patch }; return prior;
      },
      tagIssue: vi.fn(), untagIssue: vi.fn(),
    } satisfies CaptureDeps;
    const ids = [];
    for (let retry = 0; retry < 2; retry++) {
      const result = await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp',
        ownerId: 'su-a', invokedAt: '2026-09-08T12:00:00Z', failure: metadataToolFailure }, d);
      expect(result).toMatchObject({ created: false, reason: 'coalesced' });
      ids.push(result!.issue!.id);
    }
    expect(new Set(ids).size).toBe(metadataWorkflowTargets.repeatedFrictionIdentities.maxAfter);
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toHaveLength(2);
    expect(prior.payload).toMatchObject({ lane: 'observation', toolFailureProbation: { state: 'probation', reporters: ['su-a'] } });
    expect(d.tagIssue).not.toHaveBeenCalled();
  });

  it('R-7 preserves an already-promoted issue and records the retry as occurrence evidence', async () => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const prior = existing({ id: 'EI-PROMOTED', title: 'confirmed actionable defect', severity: 'major',
      scope: 'harness:papercusp', payload: { lane: 'improvement', watchdogKey: normalized.watchdogKey,
        toolFailureProbation: { ...normalized, state: 'promoted', reporters: ['su-a'], report: metadataToolFailure } } });
    const original = structuredClone(prior);
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior] };
    expect(await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'su-a',
      invokedAt: '2026-09-08T12:00:00Z', failure: metadataToolFailure }, d)).toMatchObject({ created: false, issue: { id: prior.id } });
    expect(prior).toEqual(original);
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toHaveLength(1);
  });

  it('R-7 strips direct-evidence assertions and leaves missing dimensions explicitly unknown', async () => {
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [], findIssuesByWatchdogKeys: async () => [] };
    await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'su-a',
      invokedAt: '2026-09-08T12:00:00Z', failure: { toolName: 'coord:send', status: 'error',
        message: 'internal error', ...{ reproduced: true, hardInternal: true } } }, d);
    expect(d.created).toHaveLength(1);
    expect(d.created[0].payload).toMatchObject({ lane: 'observation', toolFailureProbation: {
      state: 'probation', direct: false, contractFingerprint: 'schema-unknown~field-unknown', deployedRevision: 'runtime-unknown' } });
    expect(d.created[0].payload).not.toHaveProperty('toolFailureProbation.report.reproduced');
  });

  it('does not class-coalesce agent reports with missing dimensions and different messages', async () => {
    const firstReport: SuspectedToolFailure = {
      toolName: 'coord:send', errorCode: 'invalid_args', status: 'error',
      message: 'invalid_args: first body value was rejected',
    };
    const incomingReport: SuspectedToolFailure = {
      ...firstReport, message: 'invalid_args: second body value was rejected',
    };
    const first = normalizeSuspectedToolFailure(firstReport);
    const incoming = normalizeSuspectedToolFailure(incomingReport);
    expect(incoming.classKey).toBe(first.classKey);
    expect(incoming.watchdogKey).not.toBe(first.watchdogKey);
    const prior = existing({ id: 'EI-INCOMPLETE-CLASS', title: 'first report', scope: 'harness:papercusp',
      payload: { lane: 'observation', watchdogKey: first.watchdogKey,
        toolFailureProbation: { ...first, state: 'probation', reporters: ['su-a'], report: firstReport } } });
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior] };

    const result = await captureImprovement({
      title: 'second report', kind: 'change', lane: 'observation', scope: 'harness:papercusp',
      workspaceId: 'ws', createdBy: 'su-b', watchdogKey: incoming.watchdogKey,
      payloadExtra: { toolFailureProbation: { ...incoming, state: 'probation', reporters: ['su-b'], report: incomingReport } },
    }, d);

    expect(result).toMatchObject({ created: true });
    expect(d.created).toHaveLength(1);
    expect((prior.payload as Record<string, any>).toolFailureProbation.reporters).toEqual(['su-a']);
  });

  it('keeps a timed-out capability:bash report separate from the legacy ECONNREFUSED row', async () => {
    const priorReport: SuspectedToolFailure = {
      toolName: 'capability:bash',
      message: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
      reproduced: true,
    };
    const timeoutReport: SuspectedToolFailure = {
      toolName: 'capability:bash',
      status: 'timed_out',
      message: 'A read-only du summary of a home directory exceeded its 40000ms capability:bash wall clock. The returned result says the pc-heavy slot-acquired marker was not seen and hypothesizes it may have timed out queued, but the cause is unverified. No host disk contents were changed.',
    };
    const priorNormalized = normalizeSuspectedToolFailure(priorReport);
    const timeoutNormalized = normalizeSuspectedToolFailure(timeoutReport);
    expect(priorNormalized.class).toBe('transient');
    expect(timeoutNormalized.class).toBe('transient');
    expect(priorNormalized.classKey).toBe(
      'repeated-tool-error-class:capability:bash:transient:error-code-unknown:schema-unknown~field-unknown:runtime-unknown',
    );
    expect(timeoutNormalized.classKey).toBe(priorNormalized.classKey);
    expect(priorNormalized.watchdogKey).toBe(
      'repeated-tool-error:capability:bash:transient:md5-1258d1f30c048e723dd13e6b951fa28b',
    );
    expect(timeoutNormalized.watchdogKey).not.toBe(priorNormalized.watchdogKey);

    const legacyWatchdogKey = 'repeated-tool-error:capability:bash:transient:econnrefused-unable-to-connect-is-the';
    const prior = existing({
      id: 'EI-LEGACY-ECONNREFUSED',
      title: 'Direct capability:bash calls return ECONNREFUSED',
      scope: 'harness:papercusp',
      payload: {
        watchdogKey: legacyWatchdogKey,
        toolFailureProbation: {
          ...priorNormalized,
          watchdogKey: legacyWatchdogKey,
          state: 'promoted',
          report: priorReport,
          reporters: ['su-prior-a', 'su-prior-b'],
          directEvidence: true,
        },
      },
    });
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior] };

    const result = await captureImprovement({
      title: 'capability:bash tool-call failure (timed_out)',
      body: timeoutReport.message,
      kind: 'change',
      lane: 'observation',
      scope: 'harness:papercusp',
      workspaceId: 'ws',
      createdBy: 'su-timeout-reporter',
      watchdogKey: timeoutNormalized.watchdogKey,
      payloadExtra: {
        toolFailureProbation: {
          ...timeoutNormalized,
          state: 'probation',
          report: timeoutReport,
          reporters: ['su-timeout-reporter'],
        },
      },
    }, d);

    expect(result).toMatchObject({ created: true });
    expect(d.created).toHaveLength(1);
    expect((prior.payload as Record<string, any>).toolFailureProbation.reporters).toEqual([
      'su-prior-a',
      'su-prior-b',
    ]);
  });

  // WI-10003605: a workspace-spanning invocation records harness '*'. Scoping it
  // `harness:*` hit the work-item scope guard, so every such capture threw and the
  // in-process operator console.warned per invocation (failing fail-on-console tests).
  it.each(['*', ' * ', ''])('files a wildcard/blank-harness invocation (%j) operator-scoped instead of throwing', async (harnessSlug) => {
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [], findIssuesByWatchdogKeys: async () => [] };
    await expect(captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug, ownerId: 'su-a',
      invokedAt: '2026-09-28T05:35:00Z', failure: { toolName: 'coord:send', status: 'error',
        message: 'internal error' } }, d)).resolves.toBeTruthy();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].scope).toBe('operator');
  });

  it('CONTROL: a concrete harness keeps its harness scope', async () => {
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [], findIssuesByWatchdogKeys: async () => [] };
    await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'su-a',
      invokedAt: '2026-09-28T05:35:00Z', failure: { toolName: 'coord:send', status: 'error',
        message: 'internal error' } }, d);
    expect(d.created[0].scope).toBe('harness:papercusp');
  });

  it('maps the engineering docs sentinel to the platform Pot and retains source harness metadata', async () => {
    const d = {
      ...deps({ resolvePotScope: async ({ rawSlug, workspaceId }) => {
        expect(rawSlug).toBeNull();
        expect(workspaceId).toBe('papercusp-workspace');
        return 'papercusp';
      } }),
      findIssuesByToolFailureClassKeys: async () => [],
      findIssuesByWatchdogKeys: async () => [],
    };

    await captureToolInvocationFriction({
      workspaceId: 'papercusp-workspace', harnessSlug: 'engineering', ownerId: 'su-a',
      invokedAt: '2026-09-28T05:35:00Z',
      failure: { toolName: 'docs:search', status: 'error', message: 'temporary lookup failure' },
    }, d);

    expect(d.created[0]?.scope).toBe('harness:papercusp');
    expect(d.created[0]?.payload).toMatchObject({
      toolInvocation: {
        workspaceId: 'papercusp-workspace', harnessSlug: 'engineering', ownerId: 'su-a',
      },
    });
  });

  it('stores member-harness friction under its resolved Pot home and retains the source harness', async () => {
    const d = {
      ...deps({ resolvePotScope: async ({ rawSlug, workspaceId }) => {
        expect(rawSlug).toBe('member-harness');
        expect(workspaceId).toBe('ws');
        return 'owner-home';
      } }),
      findIssuesByToolFailureClassKeys: async () => [],
      findIssuesByWatchdogKeys: async () => [],
    };

    await captureToolInvocationFriction({
      workspaceId: 'ws', harnessSlug: 'member-harness', ownerId: 'su-a',
      invokedAt: '2026-09-28T05:36:00Z',
      failure: { toolName: 'coord:send', status: 'error', message: 'temporary transport failure' },
    }, d);

    expect(d.created[0]?.scope).toBe('harness:owner-home');
    expect(d.created[0]?.payload).toMatchObject({
      toolInvocation: { workspaceId: 'ws', harnessSlug: 'member-harness', ownerId: 'su-a' },
    });
  });

  it('R-7 a second measured reporter promotes the same issue while readiness stays unknown', async () => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const prior = existing({ id: 'EI-R7', title: 'first report', scope: 'harness:papercusp',
      payload: { lane: 'observation', watchdogKey: normalized.watchdogKey,
        toolFailureProbation: { ...normalized, state: 'probation', reporters: ['su-a'], report: metadataToolFailure } } });
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior],
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id: string, patch: object) => Object.assign(prior, patch),
      mergeIssuePayload: async (_id: string, patch: object, opts?: { unset?: readonly string[] }) => {
        const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
        for (const key of opts?.unset ?? []) delete payload[key];
        prior.payload = payload; return prior;
      }, tagIssue: vi.fn(async () => {}), untagIssue: vi.fn(async () => {}),
    } satisfies CaptureDeps;
    expect(await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'su-b',
      invokedAt: '2026-09-08T12:00:00Z', failure: metadataToolFailure }, d))
      .toMatchObject({ reason: 'promoted', issue: { id: 'EI-R7' } });
    expect(prior.payload).toMatchObject({ toolFailureProbation: { state: 'promoted', reporters: ['su-a', 'su-b'] },
      implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' } });
    expect(d.created).toHaveLength(0);
    // WI-6554700010008444: the promoting reporter is new evidence for the row.
    expect(d.emitted).toEqual([expect.objectContaining({ key: 'work-item:tool-failure-reporter:EI-R7' })]);
    expect(typeof (prior.payload as Record<string, unknown>).evidenceAdvancedAt).toBe('string');
  });

  it.each(['missing', 'unreadable'] as const)('preserves a committed promotion when its optional review refresh is %s', async refresh => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const prior = existing({ id: 'EI-REFRESH', title: 'first report', scope: 'harness:papercusp',
      payload: { lane: 'observation', watchdogKey: normalized.watchdogKey,
        toolFailureProbation: { ...normalized, state: 'probation', reporters: ['su-a'], report: metadataToolFailure } } });
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior],
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id: string, patch: object) => Object.assign(prior, patch),
      mergeIssuePayload: async (_id: string, patch: object, opts?: { unset?: readonly string[] }) => {
        const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
        for (const key of opts?.unset ?? []) delete payload[key];
        prior.payload = payload; return prior;
      }, tagIssue: vi.fn(async () => {}), untagIssue: vi.fn(async () => {}),
      enterAgentReview: vi.fn(async () => ({ entered: true })),
      getIssue: vi.fn(async () => {
        if (refresh === 'unreadable') throw new Error('review refresh unavailable');
        return null;
      }),
    } satisfies CaptureDeps;
    const result = await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'su-b',
      invokedAt: '2026-09-08T12:00:00Z', failure: metadataToolFailure }, d);
    expect(d.enterAgentReview).toHaveBeenCalledOnce();
    expect(d.getIssue).toHaveBeenCalledExactlyOnceWith('EI-REFRESH');
    expect(result).toMatchObject({ ok: true, created: false, reason: 'promoted',
      issue: { id: 'EI-REFRESH', payload: { toolFailureProbation: { state: 'promoted', reporters: ['su-a', 'su-b'] } } } });
    expect(d.created).toHaveLength(0);
  });

  it.each(['schema', 'runtime', 'scope'] as const)('R-7 changed %s cannot corroborate or rewrite the old observation', async dimension => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const prior = existing({ id: 'EI-OTHER', title: 'first report', scope: 'harness:papercusp',
      payload: { lane: 'observation', watchdogKey: normalized.watchdogKey,
        toolFailureProbation: { ...normalized, state: 'probation', reporters: ['su-a'], report: metadataToolFailure } } });
    const original = structuredClone(prior);
    const d = { ...deps(), findIssuesByToolFailureClassKeys: async () => [prior],
      findIssuesByWatchdogKeys: async () => [prior], updateIssuePatch: vi.fn(), mergeIssuePayload: vi.fn(),
    } satisfies CaptureDeps;
    await captureToolInvocationFriction({ workspaceId: 'ws', harnessSlug: dimension === 'scope' ? 'other-pot' : 'papercusp',
      ownerId: 'su-b', invokedAt: '2026-09-08T12:00:00Z', failure: { ...metadataToolFailure,
        ...(dimension === 'schema' ? { schemaRevision: 'different-contract' } : {}),
        ...(dimension === 'runtime' ? { runtimeVersion: 'different-loaded-build' } : {}) } }, d);
    expect(prior).toEqual(original);
    expect(d.updateIssuePatch).not.toHaveBeenCalled();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].payload).toMatchObject({ lane: 'observation', toolFailureProbation: { state: 'probation', reporters: ['su-b'] } });
    if (dimension !== 'scope') expect(d.created[0].payload).not.toHaveProperty('watchdogKey', normalized.classKey);
  });

  it('P-001 R-7 coalesces two same-reporter retries without creating or promoting another identity', async () => {
    const normalized = normalizeSuspectedToolFailure(metadataToolFailure);
    const report = {
      ...normalized,
      state: 'probation' as const,
      intendedKind: 'change' as const,
      reporters: ['su-a'],
      report: metadataToolFailure,
    };
    const prior = existing({
      id: 'EI-METADATA-FRICTION',
      title: 'coord:send tool-call failure (invalid_args)',
      severity: 'nit',
      kind: 'change',
      payload: { lane: 'observation', watchdogKey: normalized.watchdogKey, toolFailureProbation: report },
    });
    const tagIssue = vi.fn();
    const untagIssue = vi.fn();
    const d = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      findIssuesByToolFailureClassKeys: async () => [prior],
      updateIssuePatch: async (_id: string, patch: object) => Object.assign(prior, patch),
      mergeIssuePayload: async (_id: string, patch: object) => {
        prior.payload = { ...(prior.payload as object), ...patch };
        return prior;
      },
      tagIssue,
      untagIssue,
    } satisfies CaptureDeps;
    const ids: string[] = [];
    for (let retry = 0; retry < 2; retry++) {
      const result = await captureImprovement({
        title: prior.title,
        kind: 'change',
        lane: 'observation',
        watchdogKey: normalized.watchdogKey,
        createdBy: 'su-a',
        payloadExtra: { toolFailureProbation: report },
      }, d);
      expect(result).toMatchObject({ ok: true, created: false, reason: 'coalesced', issue: { id: prior.id } });
      ids.push(result.issue!.id);
    }
    expect(new Set(ids).size).toBe(metadataWorkflowTargets.repeatedFrictionIdentities.before);
    expect(d.created).toHaveLength(0);
    expect(prior.payload).toMatchObject({
      lane: 'observation',
      toolFailureProbation: { state: 'probation', reporters: ['su-a'], report: metadataToolFailure },
    });
    expect(tagIssue).not.toHaveBeenCalled();
    expect(untagIssue).not.toHaveBeenCalled();
    expect(d.occurrences).toHaveLength(2);
    expect(d.occurrences).toEqual([
      expect.objectContaining({ canonicalId: prior.id, reporter: 'su-a', reportKind: 'coalesced' }),
      expect.objectContaining({ canonicalId: prior.id, reporter: 'su-a', reportKind: 'coalesced' }),
    ]);
    // A distinct reporter's promotion and watchdog promotion remain covered by
    // the adjacent tests. Repetition by one reporter must not impersonate either.
  });

  it('keeps the first report in the observation lane and preserves its correlation dimensions', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        lane: 'observation',
        watchdogKey: key,
        createdBy: 'su-a',
        payloadExtra: { toolFailureProbation: probation('su-a') },
      },
      d,
    );
    expect(d.created[0]).toMatchObject({ kind: 'change', severity: 'nit' });
    expect(d.created[0].payload).toMatchObject({
      lane: 'observation',
      watchdogKey: key,
      toolFailureProbation: { state: 'probation', reporters: ['su-a'] },
    });
  });

  it('promotes the same row in place when a second independent agent reports it', async () => {
    const prior = existing({
      id: 'EI-PROBATION',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      severity: 'nit',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const mergeCalls: Array<{
      patch: Record<string, unknown>;
      opts: { unset?: readonly string[] } | undefined;
    }> = [];
    const tags: string[] = [];
    const untags: string[] = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
      mergeIssuePayload: async (_id, patch, opts) => {
        mergeCalls.push({ patch, opts });
        const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
        for (const key of opts?.unset ?? []) delete payload[key];
        return existing({ ...prior, kind: 'change', severity: 'minor', payload });
      },
      tagIssue: async (_id, topic) => {
        tags.push(topic);
      },
      untagIssue: async (_id, topic) => {
        untags.push(topic);
      },
    };
    const res = await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        lane: 'observation',
        watchdogKey: key,
        paths: ['packages/operator-core/lib/agent-tools/coordination/tools/send.ts'],
        createdBy: 'su-b',
        payloadExtra: { toolFailureProbation: probation('su-b') },
      },
      d,
    );
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(mergeCalls[0]?.patch).not.toHaveProperty('lane');
    expect(mergeCalls[0]).toMatchObject({
      opts: { unset: ['lane'] },
      patch: {
        paths: ['packages/operator-core/lib/agent-tools/coordination/tools/send.ts'],
        toolFailureProbation: { state: 'promoted', reporters: ['su-a', 'su-b'] },
        implementationReadiness: {
          status: 'unknown',
          // P-008 / D-038: a promotion waits in the one review stage, not a probation hold.
          reason: 'awaiting-agent-review',
        },
      },
    });
    expect(tags).toEqual([IMPROVEMENT_TOPIC]);
    expect(untags).toEqual([OBSERVATION_TOPIC]);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-PROBATION',
        reporter: 'su-b',
        sourceTool: 'improvements:capture',
        reportKind: 'promoted',
      }),
    ]);
  });

  it('reconciles a migration-865 promotion collision onto the existing improvement canonical', async () => {
    const loser = existing({
      id: 'EI-PROBATION-LOSER',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      severity: 'nit',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const canonical = existing({
      id: 'EI-IMPROVEMENT-CANONICAL',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      severity: 'minor',
      payload: {
        watchdogKey: key,
        repeatCount: 3,
        toolFailureProbation: {
          ...probation('su-existing'),
          state: 'promoted',
          reporters: ['su-existing'],
          promotedBy: 'su-existing',
        },
      },
    });
    const stateCalls: Array<{
      id: string;
      state: string;
      by: string | undefined;
      opts: { skipCompletionGate?: boolean } | undefined;
    }> = [];
    const tags: string[] = [];
    const untags: string[] = [];
    const collisionMerges: Array<{ id: string; opts: { unset?: readonly string[] } | undefined }> = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [loser, canonical],
      updateIssuePatch: async (id, patch) => existing({ ...(id === loser.id ? loser : canonical), ...patch }),
      mergeIssuePayload: async (id, patch, opts) => {
        collisionMerges.push({ id, opts });
        if (id === loser.id && opts?.unset?.includes('lane')) {
          throw {
            code: '23505',
            constraint_name: 'work_items_watchdog_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
          };
        }
        const target = id === canonical.id ? canonical : loser;
        target.payload = { ...(target.payload as Record<string, unknown>), ...patch };
        return target;
      },
      setIssueState: async (id, state, by, _completionRef, opts) => {
        stateCalls.push({ id, state, by, opts });
        if (id !== loser.id) return null;
        loser.state = state;
        loser.terminalOwner = by ?? null;
        return loser;
      },
      tagIssue: async (id) => {
        tags.push(id);
      },
      untagIssue: async (id) => {
        untags.push(id);
      },
    };

    const res = await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        watchdogKey: key,
        createdBy: 'su-b',
        payloadExtra: { toolFailureProbation: probation('su-b') },
      },
      d,
    );

    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: canonical.id } });
    expect(d.created).toHaveLength(0);
    expect((canonical.payload as Record<string, unknown>).toolFailureProbation).toMatchObject({
      state: 'promoted',
      reporters: ['su-existing', 'su-a', 'su-b'],
      promotionReconciledFrom: loser.id,
    });
    expect(loser.state).toBe('resolved');
    expect(collisionMerges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: loser.id, opts: { unset: ['lane'] } }),
        expect.objectContaining({ id: canonical.id }),
        expect.objectContaining({ id: loser.id, opts: undefined }),
      ]),
    );
    expect(stateCalls).toEqual([
      expect.objectContaining({
        id: loser.id,
        state: 'resolved',
        by: 'improvement-promotion-reconciler',
        opts: { skipCompletionGate: true },
      }),
    ]);
    expect(tags).toContain(canonical.id);
    expect(untags).toContain(loser.id);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: canonical.id,
        reporter: 'su-b',
        reportKind: 'promoted',
      }),
    ]);
  });

  it('does not reconcile a legacy unknown-class report into a different exact report', async () => {
    const legacySignatureKey = 'tool-failure-signature:coord:read:structural:error-code-unknown:field-unknown';
    const priorReport: SuspectedToolFailure = {
      toolName: 'coord:read',
      status: 'output_spill_failed',
      message: 'The read for one known message id returned the full message, but its enrichment projection exceeded the hard budget and the spill write failed.',
    };
    const canonicalReport: SuspectedToolFailure = {
      toolName: 'coord:read',
      status: 'found:false',
      message: "No message id starts with '7b902c85'; not a full msg_id",
    };
    const priorNormalized = normalizeSuspectedToolFailure(priorReport);
    const canonicalNormalized = normalizeSuspectedToolFailure(canonicalReport);
    expect(priorNormalized.classKey).toBe(canonicalNormalized.classKey);
    expect(priorNormalized.watchdogKey).not.toBe(canonicalNormalized.watchdogKey);

    // Legacy rows lack classKey and share a broad signature because their
    // error/contract/runtime dimensions are unknown. Their full reports still
    // identify different events and must survive separately.
    const legacyProbation = (
      reporter: string,
      normalized: ReturnType<typeof normalizeSuspectedToolFailure>,
      report: SuspectedToolFailure,
      state: 'probation' | 'promoted',
    ) => ({
      state,
      class: normalized.class,
      watchdogKey: legacySignatureKey,
      correlationFingerprint: normalized.correlationFingerprint,
      intendedKind: 'change' as const,
      reporters: [reporter],
      report,
    });
    const loser = existing({
      id: 'EI-LEGACY-REPORT-LOSER',
      title: 'coord:read report with output spill failure',
      kind: 'change',
      scope: 'harness:papercusp',
      payload: {
        lane: 'observation',
        watchdogKey: legacySignatureKey,
        toolFailureProbation: legacyProbation('su-a', priorNormalized, priorReport, 'probation'),
      },
    });
    const canonical = existing({
      id: 'EI-LEGACY-REPORT-CANONICAL',
      title: 'coord:read report with abbreviated message id',
      kind: 'change',
      scope: 'harness:papercusp',
      payload: {
        watchdogKey: legacySignatureKey,
        toolFailureProbation: legacyProbation('su-existing', canonicalNormalized, canonicalReport, 'promoted'),
      },
    });
    const mergeCalls: Array<{ id: string; patch: object; opts: { unset?: readonly string[] } | undefined }> = [];
    const stateCalls: string[] = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [loser, canonical],
      updateIssuePatch: async (id, patch) => existing({ ...(id === loser.id ? loser : canonical), ...patch }),
      mergeIssuePayload: async (id, patch, opts) => {
        mergeCalls.push({ id, patch, opts });
        if (id === loser.id && opts?.unset?.includes('lane')) {
          throw {
            code: '23505',
            constraint_name: 'work_items_watchdog_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
          };
        }
        const target = id === canonical.id ? canonical : loser;
        target.payload = { ...(target.payload as Record<string, unknown>), ...patch };
        return target;
      },
      setIssueState: async (id, state) => {
        stateCalls.push(`${id}:${state}`);
        if (id !== loser.id) return null;
        loser.state = state;
        return loser;
      },
    };

    const result = await captureImprovement(
      {
        title: canonical.title,
        kind: 'change',
        scope: 'harness:papercusp',
        watchdogKey: legacySignatureKey,
        createdBy: 'su-b',
        payloadExtra: {
          toolFailureProbation: legacyProbation('su-b', canonicalNormalized, canonicalReport, 'probation'),
        },
      },
      d,
    );

    expect(result).not.toMatchObject({ reason: 'promoted' });
    expect(loser.state).toBe('open');
    expect((loser.payload as Record<string, any>).lane).toBe('observation');
    expect((loser.payload as Record<string, any>).toolFailureProbation.report).toEqual(priorReport);
    expect((canonical.payload as Record<string, any>).toolFailureProbation.report).toEqual(canonicalReport);
    expect((canonical.payload as Record<string, any>).promotionReconciledFrom).toBeUndefined();
    expect(stateCalls).not.toContain(`${loser.id}:resolved`);
    expect(mergeCalls.some((call) => call.id === canonical.id && 'promotionReconciledFrom' in call.patch)).toBe(false);
  });

  it('preserves the canonical top-level key when class-key coalescing sees a report-key collision', async () => {
    const classKey = 'repeated-tool-error-class:coord:send:caller:schema-7~field-body:runtime-9';
    const canonicalKey = 'repeated-tool-error:coord:send:caller:first-report';
    const incomingKey = 'repeated-tool-error:coord:send:caller:colliding-report';
    const classReport = {
      toolName: 'coord:send', errorCode: 'invalid_args', status: 'error',
      message: 'invalid_args: body must be an array', schemaRevision: 'schema-7',
      fieldPath: 'body', runtimeVersion: 'runtime-9',
    };
    const canonical = existing({
      id: 'EI-CLASS-CANONICAL',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      scope: 'harness:papercusp',
      payload: {
        watchdogKey: canonicalKey,
        toolFailureProbation: {
          ...probation('su-existing'),
          classKey,
          watchdogKey: canonicalKey,
          state: 'probation',
          report: classReport,
        },
      },
    });
    const mergePatches: Record<string, unknown>[] = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByToolFailureClassKeys: async () => [canonical],
      mergeIssuePayload: async (_id, patch) => {
        mergePatches.push(patch);
        if (patch.watchdogKey === incomingKey) {
          throw {
            code: '23505',
            constraint_name: 'work_items_watchdog_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
          };
        }
        canonical.payload = { ...(canonical.payload as Record<string, unknown>), ...patch };
        return canonical;
      },
      updateIssuePatch: async (_id, patch) => existing({ ...canonical, ...patch }),
    };

    const result = await captureImprovement(
      {
        title: canonical.title,
        kind: 'change',
        scope: 'harness:papercusp',
        watchdogKey: incomingKey,
        createdBy: 'su-b',
        payloadExtra: {
          toolFailureProbation: {
            ...probation('su-b'),
            classKey,
            watchdogKey: incomingKey,
            state: 'probation',
            report: classReport,
          },
        },
      },
      d,
    );

    expect(result).toMatchObject({ created: false, reason: 'coalesced', issue: { id: canonical.id } });
    expect(d.created).toHaveLength(0);
    expect(mergePatches[0]).toMatchObject({ watchdogKey: canonicalKey });
    expect(canonical.payload).toMatchObject({
      watchdogKey: canonicalKey,
      toolFailureProbation: { classKey, watchdogKey: incomingKey, reporters: ['su-existing', 'su-b'] },
    });
    expect(d.occurrences).toEqual([
      expect.objectContaining({ canonicalId: canonical.id, reporter: 'su-b', reportKind: 'coalesced' }),
    ]);
  });

  it('preserves the canonical top-level key when class-key promotion carries newer evidence', async () => {
    const classKey = 'repeated-tool-error-class:work_items:get:structural:schema-8~field-body:runtime-10';
    const canonicalKey = 'repeated-tool-error:work_items:get:structural:first-report';
    const incomingKey = 'repeated-tool-error:work_items:get:structural:second-report';
    const classReport = {
      toolName: 'work_items:get', errorCode: 'structural', status: 'error',
      message: 'work_items:get rejected the first shape', schemaRevision: 'schema-8',
      fieldPath: 'body', runtimeVersion: 'runtime-10',
    };
    const canonical = existing({
      id: 'EI-CLASS-PROBATION',
      title: 'work_items:get rejected a valid body',
      kind: 'change',
      scope: 'harness:papercusp',
      payload: {
        lane: 'observation',
        watchdogKey: canonicalKey,
        toolFailureProbation: {
          ...probation('su-a'),
          classKey,
          watchdogKey: canonicalKey,
          state: 'probation',
          report: classReport,
        },
      },
    });
    const mergePatches: Record<string, unknown>[] = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByToolFailureClassKeys: async () => [canonical],
      updateIssuePatch: async (_id, patch) => existing({ ...canonical, ...patch }),
      mergeIssuePayload: async (_id, patch, opts) => {
        mergePatches.push(patch);
        canonical.payload = { ...(canonical.payload as Record<string, unknown>), ...patch };
        for (const key of opts?.unset ?? []) delete (canonical.payload as Record<string, unknown>)[key];
        return canonical;
      },
      tagIssue: async () => {},
      untagIssue: async () => {},
    };

    const result = await captureImprovement(
      {
        title: canonical.title,
        kind: 'change',
        scope: 'harness:papercusp',
        watchdogKey: incomingKey,
        createdBy: 'su-b',
        payloadExtra: {
          toolFailureProbation: {
            ...probation('su-b'),
            classKey,
            watchdogKey: incomingKey,
            state: 'promoted',
            directEvidence: true,
            report: classReport,
          },
        },
      },
      d,
    );

    expect(result).toMatchObject({ created: false, reason: 'promoted', issue: { id: canonical.id } });
    expect(d.created).toHaveLength(0);
    expect(mergePatches[0]).not.toHaveProperty('watchdogKey');
    expect(canonical.payload).toMatchObject({
      watchdogKey: canonicalKey,
      toolFailureProbation: {
        classKey,
        watchdogKey: incomingKey,
        state: 'promoted',
        reporters: ['su-a', 'su-b'],
      },
    });
    expect(d.occurrences).toEqual([
      expect.objectContaining({ canonicalId: canonical.id, reporter: 'su-b', reportKind: 'promoted' }),
    ]);
  });

  it('lets the invocation-ledger watchdog promote an exact-key probation row without minting a duplicate', async () => {
    const prior = existing({
      id: 'EI-PROBATION',
      title: 'one-off report',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
      mergeIssuePayload: async (_id, patch) =>
        existing({ ...prior, kind: 'change', payload: { ...(prior.payload as object), ...patch } }),
      tagIssue: async () => {},
      untagIssue: async () => {},
    };
    const res = await captureImprovement(
      {
        title: 'Tool coord:send repeatedly rejecting caller input',
        kind: 'change',
        watchdogKey: key,
        createdBy: 'system:improvement-watchdog',
      },
      d,
    );
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(res.issue?.payload).toMatchObject({
      implementationReadiness: {
        status: 'ready',
        reason: 'trusted-tool-failure-promotion',
      },
    });
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-PROBATION',
        reporter: 'system:improvement-watchdog',
        sourceTool: 'improvements:capture',
        reportKind: 'promoted',
      }),
    ]);
  });

  it('does not promote or rewrite a known cross-class row sharing the report watchdog key', async () => {
    const reportKey = 'repeated-tool-error:work_items:get:structural:same-message-shape';
    const prior = existing({
      id: 'EI-CROSS-CLASS',
      title: 'same report-shaped title',
      kind: 'change',
      scope: 'operator',
      payload: {
        lane: 'observation',
        watchdogKey: reportKey,
        toolFailureProbation: {
          state: 'probation',
          class: 'structural',
          classKey: 'repeated-tool-error-class:work_items:get:structural:schema-old~field-old:runtime-old',
          watchdogKey: reportKey,
          reporters: ['su-a'],
        },
      },
    });
    const updateIssuePatch = vi.fn(async () => existing({ ...prior }));
    const mergeIssuePayload = vi.fn(async () => existing({ ...prior }));
    const d = {
      ...deps({ found: [prior] }),
      findIssuesByToolFailureClassKeys: async () => [],
      findIssuesByWatchdogKeys: async () => [prior],
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      updateIssuePatch,
      mergeIssuePayload,
    } satisfies CaptureDeps;

    const result = await captureImprovement(
      {
        title: prior.title,
        kind: 'bug',
        watchdogKey: reportKey,
        createdBy: 'su-b',
        payloadExtra: {
          toolFailureProbation: {
            state: 'promoted',
            class: 'structural',
            classKey: 'repeated-tool-error-class:work_items:get:structural:schema-new~field-new:runtime-new',
            watchdogKey: reportKey,
            directEvidence: true,
            reporters: ['su-b'],
          },
        },
      },
      d,
    );

    expect(result).toMatchObject({ created: true });
    expect(d.created).toHaveLength(1);
    expect(updateIssuePatch).not.toHaveBeenCalled();
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('promotes an exact-title probation row when direct evidence has a different message fingerprint', async () => {
    const title = 'ptool work_items:get exits silently with empty output after delayed invocation';
    const classKey = 'repeated-tool-error-class:work_items:get:structural:schema-42~field-required:runtime-7';
    const prior = existing({
      id: 'EI-TITLE-PROBATION',
      title,
      kind: 'change',
      severity: 'nit',
      payload: {
        lane: 'observation',
        watchdogKey: 'repeated-tool-error:work_items:get:structural:first-shape',
        toolFailureProbation: {
          state: 'probation',
          class: 'structural',
          classKey,
          watchdogKey: 'repeated-tool-error:work_items:get:structural:first-shape',
          report: {
            toolName: 'work_items:get', errorCode: 'structural', status: 'error',
            message: 'work_items:get failed the first shape', schemaRevision: 'schema-42',
            fieldPath: 'required', runtimeVersion: 'runtime-7',
          },
          intendedKind: 'bug',
          reporters: ['su-a'],
        },
      },
    });
    const mergeCalls: Array<{
      patch: Record<string, unknown>;
      opts: { unset?: readonly string[] } | undefined;
    }> = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps({ found: [prior] }),
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
      mergeIssuePayload: async (_id, patch, opts) => {
        mergeCalls.push({ patch, opts });
        const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
        for (const key of opts?.unset ?? []) delete payload[key];
        return existing({ ...prior, kind: 'bug', severity: 'major', payload });
      },
      tagIssue: async () => {},
      untagIssue: async () => {},
    };

    const res = await captureImprovement(
      {
        title,
        kind: 'bug',
        watchdogKey: 'repeated-tool-error:work_items:get:structural:second-shape',
        createdBy: 'su-a',
        payloadExtra: {
          toolFailureProbation: {
            state: 'promoted',
            class: 'structural',
            classKey,
            watchdogKey: 'repeated-tool-error:work_items:get:structural:second-shape',
            report: {
              toolName: 'work_items:get', errorCode: 'structural', status: 'error',
              message: 'work_items:get failed the second shape', schemaRevision: 'schema-42',
              fieldPath: 'required', runtimeVersion: 'runtime-7',
            },
            intendedKind: 'bug',
            directEvidence: true,
            reporters: ['su-a'],
          },
        },
      },
      d,
    );

    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-TITLE-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-TITLE-PROBATION',
        reporter: 'su-a',
        sourceTool: 'improvements:capture',
        reportKind: 'promoted',
      }),
    ]);
    expect(mergeCalls[0]?.patch).not.toHaveProperty('lane');
    expect(mergeCalls[0]).toMatchObject({
      opts: { unset: ['lane'] },
      patch: {
        watchdogKey: 'repeated-tool-error:work_items:get:structural:second-shape',
        toolFailureProbation: {
          state: 'promoted',
          watchdogKey: 'repeated-tool-error:work_items:get:structural:second-shape',
        },
        implementationReadiness: {
          status: 'ready',
          reason: 'trusted-tool-failure-promotion',
        },
      },
    });
  });
});

describe('captureImprovement — auto-ratify-on-first-scorecard hook (WI-5415)', () => {
  it('calls autoRatifyRubric with the rubricRef + grader when a scorecard lands against it', async () => {
    const calls: Array<[string, string]> = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (rubricId, graderId) => {
        calls.push([rubricId, graderId]);
        return null;
      },
    };
    await captureImprovement(
      {
        title: 'scorecard for my-rubric',
        kind: 'change',
        lane: 'observation',
        createdBy: 'cup-42',
        payloadExtra: { observation: { rubricRef: 'my-rubric', ratings: {} } },
      },
      d,
    );
    expect(calls).toEqual([['my-rubric', 'cup-42']]);
  });

  it('does NOT call it when the observation carries no rubricRef', async () => {
    const calls: unknown[] = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (...args: [string, string]) => {
        calls.push(args);
        return null;
      },
    };
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation', createdBy: 'cup-1' }, d);
    expect(calls).toHaveLength(0);
  });

  it('does NOT call it for a non-observation (improvement lane) capture', async () => {
    const calls: unknown[] = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (...args: [string, string]) => {
        calls.push(args);
        return null;
      },
    };
    await captureImprovement({ title: 'x', kind: 'bug', createdBy: 'cup-1' }, d);
    expect(calls).toHaveLength(0);
  });

  it('never fails the capture when auto-ratify rejects (best-effort side effect)', async () => {
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async () => {
        throw new Error('boom — plan lock busy');
      },
    };
    const res = await captureImprovement(
      {
        title: 'scorecard for my-rubric',
        kind: 'change',
        lane: 'observation',
        createdBy: 'cup-42',
        payloadExtra: { observation: { rubricRef: 'my-rubric', ratings: {} } },
      },
      d,
    );
    expect(res.created).toBe(true);
  });
});

describe('captureImprovement — native kind + paths (close-loop D-002)', () => {
  it('writes the REAL kind column and a CLEAN title (no [kind] prefix)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].kind).toBe('bug');
    expect(d.created[0].title).toBe('presence list dumps stale rows'); // no prefix
    expect(d.created[0].topics).toContain(IMPROVEMENT_TOPIC);
  });

  it('kind=feature stores as change + payload.improvementKind (engineer_issues kinds are bug|change|task)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'a net-new capability', kind: 'feature' }, d);
    expect(d.created[0].kind).toBe('change');
    expect(d.created[0].payload).toMatchObject({ improvementKind: 'feature' });
    expect(res).toMatchObject({
      kind: 'change',
      improvementKind: 'feature',
      issue: { kind: 'change' },
    });
  });

  it('stores candidate paths in the payload (the protected-path gate feed)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x y z broken', kind: 'bug', paths: ['libs/flags/src/types.ts'] }, d);
    expect(d.created[0].payload).toMatchObject({ paths: ['libs/flags/src/types.ts'] });
  });

  it('defaults severity by kind (bug → major, others → minor)', async () => {
    const d = deps();
    await captureImprovement({ title: 'broken thing one', kind: 'bug' }, d);
    await captureImprovement({ title: 'nicer thing two', kind: 'change' }, d);
    expect(d.created[0].severity).toBe('major');
    expect(d.created[1].severity).toBe('minor');
  });

  it('seeds a successor checkpoint for an atomically claimed improvement', async () => {
    const checkpoints: Array<{ id: string; text: string }> = [];
    const d = deps({
      setCheckpoint: async (id, text) => {
        checkpoints.push({ id, text });
      },
    });

    await captureImprovement(
      { title: 'claimed capture needs continuity', kind: 'bug', assignee: 'su-a', createdBy: 'su-a' },
      d,
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ id: 'EI-100' });
    expect(checkpoints[0].text).toContain('no implementation work has started');
  });

  it('keeps the capture successful when checkpoint seeding fails', async () => {
    const d = deps({
      setCheckpoint: async () => {
        throw new Error('checkpoint store unavailable');
      },
    });

    const result = await captureImprovement(
      { title: 'claimed capture survives checkpoint outage', kind: 'bug', assignee: 'su-a', createdBy: 'su-a' },
      d,
    );

    expect(result.created).toBe(true);
    expect(result.issue?.id).toBe('EI-100');
  });
});

describe('captureImprovement — search-first dedup (D-001)', () => {
  const dup = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });

  it('P-002 / D-001: a likely duplicate FILES with payload.dedupVerdict (silent intake)', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', body: 'fresh repro evidence', createdBy: 'su-reporter' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates?.[0].id).toBe('EI-7');
    expect(d.created).toHaveLength(1);
    expect(d.created[0].admission).toBe('pending');
    // The created row IS the record: the file-time verdict + candidates ride its
    // payload for the central resolver; the 'duplicate' occurrence append onto the
    // canonical is retired with the decline.
    expect(d.created[0].payload).toMatchObject({
      dedupVerdict: 'likely-duplicate',
      dedupCandidates: [expect.objectContaining({ id: 'EI-7' })],
    });
    expect(d.occurrences).not.toContainEqual(expect.objectContaining({ reportKind: 'duplicate' }));
  });

  it('force asserts distinctness — files with NO dedupVerdict annotation', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', force: true }, d);
    expect(res.created).toBe(true);
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.dedupVerdict).toBeUndefined();
  });

  it('checkDuplicatesOnly never creates and warns that title-only results are incomplete', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', checkDuplicatesOnly: true },
      d,
    );
    expect(res.created).toBe(false);
    expect(d.created).toHaveLength(0);
    expect(res.possibleDuplicates).toHaveLength(1);
    expect(res.hint).toContain('title-only pre-check');
    expect(res.hint).toContain('An empty `possibleDuplicates` list is not evidence');
    expect(res.hint).toContain('Rerun checkDuplicatesOnly with the exact final body');
  });

  it('makes an observation-lane check-only empty list explicit as skipped, not clean', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement(
      {
        title: 'capability:read evidence_class depends on scratch contents',
        body: 'A coord:conditions result spill did not contain event evidence.',
        kind: 'change',
        lane: 'observation',
        checkDuplicatesOnly: true,
        payloadExtra: {
          observation: {
            kind: 'friction',
            scope: 'harness',
            confidence: 'high',
            refs: ['coord:conditions result-door spill'],
          },
        },
      },
      d,
    );

    expect(res).toMatchObject({
      ok: true,
      created: false,
      reason: 'check-only',
      possibleDuplicates: [],
      dedupCoverage: { lexical: 'skipped', semantic: 'skipped', degraded: true },
    });
    expect(res.hint).toContain('Observation-lane captures intentionally skip duplicate search');
    expect(res.hint).toContain('`possibleDuplicates: []` is not a duplicate verdict');
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toHaveLength(0);
  });

  it('uses the same candidates as capture when check-only receives the final body', async () => {
    const prior = existing({
      id: 'EI-CHECK-ONLY-SEMANTIC',
      title: 'the related persisted issue',
    });
    const d = deps({ found: [] });
    d.findSemanticDupes = async () => ({
      hard: [{
        id: prior.id,
        title: prior.title,
        state: prior.state,
        harness: 'papercusp',
        similarity: 0.96,
      }],
      soft: [],
      thresholds: { hard: 0.9, soft: 0.8 },
      coverage: semanticCoverageAssessment('healthy'),
    });
    d.getIssue = async () => prior;
    const input = {
      title: 'the symptom query before diagnosis',
      body: 'the final report body',
      kind: 'bug' as const,
    };

    const checked = await captureImprovement({ ...input, checkDuplicatesOnly: true }, d);
    const captured = await captureImprovement(input, d);

    expect(checked.possibleDuplicates).toEqual(captured.possibleDuplicates);
    expect(checked.possibleDuplicates).toMatchObject([{ id: prior.id, semantic: 'hard' }]);
  });

  it('checkDuplicatesOnly does not coalesce or refresh an exact-key prior', async () => {
    const prior = existing({
      id: 'EI-CHECK-ONLY-KEY',
      title: 'the original keyed finding',
      body: 'the original body',
      payload: { watchdogKey: 'check-only:key' },
    });
    const original = structuredClone(prior);
    const mergeIssuePayload = vi.fn(async () => prior);
    const updateIssuePatch = vi.fn(async () => prior);
    const d = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      mergeIssuePayload,
      updateIssuePatch,
    } satisfies CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] };

    const res = await captureImprovement(
      {
        title: 'the refreshed keyed finding',
        body: 'the refreshed body must not persist during a pre-check',
        kind: 'bug',
        watchdogKey: 'check-only:key',
        checkDuplicatesOnly: true,
      },
      d,
    );

    expect(res).toMatchObject({
      created: false,
      reason: 'check-only',
      possibleDuplicates: [{ id: prior.id, exactKey: true }],
    });
    expect(prior).toEqual(original);
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toHaveLength(0);
    expect(mergeIssuePayload).not.toHaveBeenCalled();
    expect(updateIssuePatch).not.toHaveBeenCalled();
  });

  it('warns that a check-only result with a body is valid only for that exact body', async () => {
    const d = deps({ found: [] });
    const res = await captureImprovement(
      {
        title: 'capture pre-check changes when the body changes',
        body: 'Placeholder for dedup check',
        kind: 'bug',
        checkDuplicatesOnly: true,
      },
      d,
    );
    expect(res.possibleDuplicates).toEqual([]);
    expect(res.hint).toContain('exact title and body');
    expect(res.hint).toContain('rerun checkDuplicatesOnly with the final body');
  });

  it("dedupScope:'open' — a RESOLVED duplicate does NOT decline (a regression re-files)", async () => {
    const resolved = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'resolved' });
    const d = deps({ found: [resolved] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    // ...but the dup is still REPORTED for visibility.
    expect(res.possibleDuplicates?.[0].id).toBe('EI-7');
  });

  it("dedupScope:'open' — an OPEN duplicate still carries the verdict (files under P-002)", async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'likely-duplicate' });
  });

  it('an unrelated existing item does not decline', async () => {
    const d = deps({ found: [existing({ id: 'EI-8', title: 'completely different subject entirely' })] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
  });
});

describe('captureImprovement — canonical occurrence recording (P-004)', () => {
  it('runs the persistence hook before a delayed post-create occurrence write', async () => {
    const d = deps();
    let releaseOccurrence!: () => void;
    let occurrenceStarted!: () => void;
    const occurrenceGate = new Promise<void>((resolve) => {
      releaseOccurrence = resolve;
    });
    const occurrenceStartedPromise = new Promise<void>((resolve) => {
      occurrenceStarted = resolve;
    });
    const steps: string[] = [];
    d.recordIssueOccurrence = async (input) => {
      steps.push('occurrence-started');
      occurrenceStarted();
      await occurrenceGate;
      return occurrenceReceipt(input, d.occurrences.length + 1);
    };

    const capture = captureImprovement(
      {
        title: 'scorecard persistence hook regression',
        kind: 'change',
        lane: 'observation',
        initialState: 'done',
        onIssuePersisted: async (issue) => {
          expect(issue.id).toBe('EI-100');
          steps.push('issue-persisted');
        },
      },
      d,
    );

    await occurrenceStartedPromise;
    expect(steps).toEqual(['issue-persisted', 'occurrence-started']);
    let settled = false;
    void capture.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseOccurrence();
    await expect(capture).resolves.toMatchObject({ created: true, issue: { id: 'EI-100' } });
  });

  it('records the newly created issue as the canonical occurrence with its evidence', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'new canonical control-plane failure',
        kind: 'bug',
        body: 'journal evidence and reproduction steps',
        scope: 'harness:papercusp',
        createdBy: 'su-reporter',
        payloadExtra: { observation: { confidence: 'high' } },
      },
      d,
    );

    expect(res).toMatchObject({ created: true, issue: { id: 'EI-100' } });
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-100',
        canonicalHarness: 'papercusp',
        reporter: 'su-reporter',
        sourceTool: 'improvements:capture',
        reportKind: 'canonical-created',
        reportedTitle: 'new canonical control-plane failure',
        evidence: expect.objectContaining({
          body: 'journal evidence and reproduction steps',
          payloadExtra: { observation: { confidence: 'high' } },
        }),
      }),
    ]);
  });
});

describe('captureImprovement — "already decided" recall (self-learning P-003)', () => {
  it('surfaces a prior RESOLVED same-signature item as already-decided, with its reason', async () => {
    const decided = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      payload: { decidedReason: 'fixed by the TTL sweep in PR-x' },
    });
    // dedupScope:'open' so the resolved dup does not BLOCK the create — we want to
    // assert the recall fires even on a created capture (it is recall, not a gate).
    const d = deps({ found: [decided] });
    const res = await captureImprovement(
      { title: 'stale rows dumps presence list', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.alreadyDecided?.[0]).toMatchObject({
      id: 'EI-7',
      matchKind: 'signature',
      reason: 'already decided: fixed by the TTL sweep in PR-x',
    });
  });

  it('does NOT recall when the only prior same-signature item is OPEN', async () => {
    const open = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });
    const d = deps({ found: [open] });
    const res = await captureImprovement({ title: 'stale rows dumps presence list', kind: 'bug', force: true }, d);
    expect(res.created).toBe(true);
    expect(res.alreadyDecided).toBeUndefined();
  });
});

describe('captureImprovement — P-010 source-tag and per-Hive scope', () => {
  it('stores sourceRole in payload when not human (P-010 source-tag)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'broken watchdog signal', kind: 'bug', sourceRole: 'system' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ sourceRole: 'system' });
  });

  it('does not store sourceRole in payload when human (default)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'broken thing', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.sourceRole).toBeUndefined();
  });

  it('adds improvement-source topic tag when sourceRole is Queen or cup (P-010)', async () => {
    const d1 = deps();
    await captureImprovement({ title: 'queen-filed idea', kind: 'bug', sourceRole: 'Queen' }, d1);
    expect(d1.created[0].topics).toContain('improvement-source:Queen');

    const d2 = deps();
    await captureImprovement({ title: 'cup-filed idea', kind: 'bug', sourceRole: 'cup' }, d2);
    expect(d2.created[0].topics).toContain('improvement-source:cup');
  });

  it('respects per-Hive scope (harness:<slug>) alongside sourceRole (P-010)', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'harness-specific bug',
        kind: 'bug',
        scope: 'harness:sheets',
        sourceRole: 'cup',
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].scope).toBe('harness:sheets');
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.sourceRole).toBe('cup');
  });
});

describe('captureImprovement — watchdogKey-aware dedup (watchdog-audit P-004 / D-001)', () => {
  it('stamps payload.watchdogKey on the created item', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'Test failing repeatedly: lib/a.test.ts', kind: 'bug', watchdogKey: 'red-test:lib/a.test.ts' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ watchdogKey: 'red-test:lib/a.test.ts' });
  });

  it('stamps payload.findingClass — the taxonomy slug the rails route/count by (frontier P-044)', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'Resolution gap: plans searches for "x-2026-06-06" zero-hit although it exists',
        kind: 'bug',
        watchdogKey: 'negative-space:plans:x-2026-06-06',
        findingClass: 'negative-space:resolution-gap',
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ findingClass: 'negative-space:resolution-gap' });
  });

  it('a title-similar candidate with a DIFFERENT watchdogKey never declines (the subset-title edge)', async () => {
    // The nested-path shape: "lib/deep/a.test.ts" token-subsets "lib/a.test.ts"-style
    // titles enough to clear the Jaccard bar, but the keys differ — distinct signals.
    const other = existing({
      id: 'EI-9',
      title: 'Test failing repeatedly: packages/x/lib/sub/a.test.ts',
      state: 'open',
      payload: { watchdogKey: 'red-test:packages/x/lib/sub/a.test.ts' },
    });
    const d = deps({ found: [other] });
    const res = await captureImprovement(
      {
        title: 'Test failing repeatedly: packages/x/lib/sub/a.test.ts and more packages/x/lib',
        kind: 'bug',
        dedupScope: 'open',
        watchdogKey: 'red-test:packages/x/lib/sub-other/a.test.ts',
      },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('a candidate WITHOUT a key stays in the net (legacy items still classify — verdict rides the row)', async () => {
    const legacy = existing({
      id: 'EI-9',
      title: 'Test failing repeatedly: lib/a.test.ts',
      state: 'open',
      payload: null,
    });
    const d = deps({ found: [legacy] });
    const res = await captureImprovement(
      {
        title: 'Test failing repeatedly: lib/a.test.ts',
        kind: 'bug',
        dedupScope: 'open',
        watchdogKey: 'red-test:lib/a.test.ts',
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'likely-duplicate' });
  });
});

describe('captureImprovement — resolved-dup evidence gate (watchdog-audit P-005 / D-002)', () => {
  const resolvedAt = '2026-06-09T00:00:00.000Z';
  const resolvedDup = existing({
    id: 'EI-7',
    title: 'presence list dumps stale rows',
    state: 'resolved',
    updatedAt: resolvedAt,
  });

  it("dedupScope:'open' + evidence OLDER than the resolution → files with dedupVerdict 'stale-evidence' (P-002)", async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      {
        title: 'presence list dumps stale rows',
        kind: 'bug',
        dedupScope: 'open',
        evidenceAt: '2026-06-08T00:00:00.000Z', // pre-fix lookback evidence
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'stale-evidence' });
    expect(d.created[0].admission).toBe('pending');
  });

  it("dedupScope:'open' + evidence NEWER than the resolution → re-files (real regression)", async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      {
        title: 'presence list dumps stale rows',
        kind: 'bug',
        dedupScope: 'open',
        evidenceAt: '2026-06-09T12:00:00.000Z',
      },
      d,
    );
    expect(res.created).toBe(true);
    // A real regression re-file carries NO stale verdict — the annotation is scoped
    // to the case the old decline covered.
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.dedupVerdict).toBeUndefined();
    expect(d.created[0].admission).toBe('pending');
  });

  it('no evidenceAt (live-state signal) keeps the old regression semantics — re-file', async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('an unparseable resolution timestamp fails open (re-file beats suppressing a regression)', async () => {
    const weird = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      updatedAt: 'not-a-date',
    });
    const d = deps({ found: [weird] });
    const res = await captureImprovement(
      {
        title: 'presence list dumps stale rows',
        kind: 'bug',
        dedupScope: 'open',
        evidenceAt: '2026-06-08T00:00:00.000Z',
      },
      d,
    );
    expect(res.created).toBe(true);
  });
});

describe('captureImprovement — signal provenance (frontier P-002 / D-002)', () => {
  it('writes signal_origin=organic by default', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'a real friction', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].signalOrigin).toBe('organic');
  });

  it('passes a frontier origin through to the column (drill)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'planted flaky test', kind: 'bug', origin: 'drill' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].signalOrigin).toBe('drill');
  });

  it('an OPEN organic duplicate never declines a drill capture (the drill must file)', async () => {
    const organicDup = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });
    const d = deps({ found: [organicDup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', origin: 'drill' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toHaveLength(0); // cross-origin rows are not even surfaced
  });

  it('an OPEN drill duplicate never declines an ORGANIC capture (synthetic must not suppress real)', async () => {
    const drillDup = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'open',
      signalOrigin: 'drill',
    });
    const d = deps({ found: [drillDup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
  });

  it('same-origin dedup still classifies (drill vs drill — files with the verdict, P-002)', async () => {
    const drillDup = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'open',
      signalOrigin: 'drill',
    });
    const d = deps({ found: [drillDup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', origin: 'drill' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'likely-duplicate' });
  });

  it('already-decided recall is origin-scoped: a decided REPLAY row is not recalled for an organic capture', async () => {
    const decidedReplay = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      signalOrigin: 'replay',
      payload: { decidedReason: 'replay counterfactual outcome — not a live decision' },
    });
    const d = deps({ found: [decidedReplay] });
    const res = await captureImprovement(
      { title: 'stale rows dumps presence list', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.alreadyDecided).toBeUndefined();
  });
});

describe('captureImprovement — P-011 semantic candidate widening (shared-embedding-sidecar-and-enrichment-2026-07-10)', () => {
  const semDeps = (
    d: ReturnType<typeof deps>,
    verdict: {
      hard: Array<{ id: string; similarity: number }>;
      soft: Array<{ id: string; similarity: number }>;
    } | null,
    issues: EngineerIssue[],
  ): CaptureDeps & { created: CreateIssueInput[] } => ({
    ...d,
    findSemanticDupes: async () =>
      verdict === null
        ? null
        : {
            hard: verdict.hard.map((c) => ({ ...c, title: 't', state: 'open', harness: null })),
            soft: verdict.soft.map((c) => ({ ...c, title: 't', state: 'open', harness: null })),
            thresholds: { hard: 0.93, soft: 0.85 },
          },
    getIssue: async (id) => issues.find((i) => i.id === id) ?? null,
  });

  it('a HARD semantic hit carries the verdict even when the lexical net misses it (files, P-002)', async () => {
    const worded = existing({ id: 'EI-50', title: 'agents keep refiling identical tool bugs' });
    const d = semDeps(deps({ found: [] }), { hard: [{ id: 'EI-50', similarity: 0.95 }], soft: [] }, [worded]);
    const res = await captureImprovement({ title: 'duplicate friction reports flood the queue', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates?.[0]).toMatchObject({ id: 'EI-50', semantic: 'hard', similarity: 0.95 });
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'likely-duplicate' });
  });

  it('surfaces a recent open item before async embeddings arrive, without blocking the filing', async () => {
    const prior = existing({
      id: 'EI-RECENT-LEXICAL',
      title: 'grading audit judge launch blocked by evaluator SHA freshness',
    });
    const d = deps({ found: [] });
    d.findSemanticDupes = async () => healthySemanticResult();
    d.getIssue = async (id) => (id === prior.id ? prior : null);
    vi.mocked(findRecentLexicalDupes).mockResolvedValue({
      candidates: [{
        id: prior.id,
        title: prior.title,
        state: 'open',
        harness: 'papercusp',
        similarity: 0.72,
        source: 'lexical-recent',
      }],
      coverage: { scanned: 1, unembedded: 1, truncated: false, complete: false },
    });

    const res = await captureImprovement({
      title: 'judge dispatch sees stale evaluator currentness',
      body: 'The judge must refuse before grading when evaluator currentness is stale.',
      kind: 'bug',
      scope: 'harness:papercusp',
    }, d);

    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toMatchObject([
      { id: prior.id, lexical: 'recent', similarity: 0.72 },
    ]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'partial', degraded: true });
    expect(d.created[0].payload?.dedupCandidates).toEqual([
      { id: prior.id, similarity: 0.72, method: 'lexical-recent' },
    ]);
  });

  it('a SOFT semantic hit is advisory-only: surfaced in possibleDuplicates, capture still created', async () => {
    const worded = existing({ id: 'EI-51', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-51', similarity: 0.87 }] }, [worded]);
    const res = await captureImprovement({ title: 'a completely differently worded capture', kind: 'change' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([
      expect.objectContaining({ id: 'EI-51', semantic: 'soft', similarity: 0.87 }),
    ]);
  });

  it('P-005 coalesces a SOFT semantic sibling during a concentrated low-diversity burst', async () => {
    const worded = existing({ id: 'EI-57', title: 'similar queue admission failure' });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: 'EI-57', similarity: 0.91 }] }, [worded]);
    d.readIssueAdmissionPressure = async () =>
      assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
        emitterCounts: [430, 5, 5, 5, 5, 5],
      });

    const res = await captureImprovement({ title: 'differently worded queue admission failure', kind: 'bug' }, d);
    expect(res).toMatchObject({
      created: false,
      reason: 'coalesced',
      issue: { id: 'EI-57' },
      queueAdmission: { active: true, rawOccurrences: 455, canonicalStock: 2_494 },
    });
    expect(base.created).toHaveLength(0);
    expect(base.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-57',
        reportKind: 'coalesced',
        evidence: expect.objectContaining({
          queueAdmission: expect.objectContaining({ active: true, rawOccurrences: 455 }),
        }),
      }),
    ]);
  });

  it.each(['null', 'throw'] as const)(
    'P-005 mints a canonical filing when occurrence recording %s',
    async (failure) => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: false });
      try {
        const worded = existing({ id: 'EI-57', title: 'similar queue admission failure' });
        const base = deps({ found: [] });
        const d = semDeps(base, { hard: [], soft: [{ id: 'EI-57', similarity: 0.91 }] }, [worded]);
        d.readIssueAdmissionPressure = async () =>
          assessIssueAdmissionPressure({
            rawOccurrences: 455,
            duplicateOccurrences: 455,
            canonicalStock: 2_494,
            canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
            emitterCounts: [430, 5, 5, 5, 5, 5],
          });
        const recordIssueOccurrence = vi.fn(async (_input: RecordIssueOccurrenceInput) => {
          if (failure === 'throw') throw new Error('occurrence insert failed');
          return null;
        });
        d.recordIssueOccurrence = recordIssueOccurrence;

        const report = {
          title: 'differently worded queue admission failure',
          body: 'This report detail must survive an unavailable occurrence ledger.',
          kind: 'bug' as const,
          scope: 'harness:papercusp',
        };
        const res = await captureImprovement(report, d);

        expect(res).toMatchObject({ ok: true, created: true, issue: { id: 'EI-100' } });
        expect(base.created).toHaveLength(1);
        expect(base.created[0]).toMatchObject({
          title: report.title,
          body: report.body,
          kind: 'bug',
        });
        expect(recordIssueOccurrence.mock.calls.map(([call]) => call.reportKind)).toEqual([
          'coalesced',
          'canonical-created',
        ]);
      } finally {
        setFlagOverridesForTest(null);
      }
    },
  );

  it('P-005 direct-evidence tool failures ignore keyless soft siblings during a burst', async () => {
    const unrelated = existing({
      id: 'EI-24441622330454419',
      title: 'background command quoted-$L expansion',
      scope: 'harness:papercusp',
      payload: { lane: 'improvement' },
    });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: unrelated.id, similarity: 0.91 }] }, [unrelated]);
    let pressureReads = 0;
    d.readIssueAdmissionPressure = async () => {
      pressureReads += 1;
      return assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
        emitterCounts: [430, 5, 5, 5, 5, 5],
      });
    };
    const watchdogKey = 'repeated-tool-error:improvements:capture:structural:unrelated-coalescence:field-unknown';

    const res = await captureImprovement({
      title: 'improvements:capture tool-call failure (unrelated-coalescence)',
      kind: 'bug',
      scope: 'harness:papercusp',
      watchdogKey,
      payloadExtra: {
        toolFailureProbation: { state: 'promoted', directEvidence: true, watchdogKey },
      },
    }, d);

    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([
      expect.objectContaining({ id: unrelated.id, semantic: 'soft' }),
    ]);
    expect(pressureReads).toBe(0);
    expect(base.created).toHaveLength(1);
  });

  it('P-005 does not coalesce a coord:presence timeout into a keyless client-wrapper failure sibling', async () => {
    const wrapperFailure = existing({
      id: 'EI-25547463864163185',
      title: 'coord:presence tool-call failure (client-wrapper-missing)',
      scope: 'harness:papercusp',
      payload: { lane: 'improvement' },
    });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: wrapperFailure.id, similarity: 0.91 }] }, [wrapperFailure]);
    let pressureReads = 0;
    d.readIssueAdmissionPressure = async () => {
      pressureReads += 1;
      return assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
        emitterCounts: [430, 5, 5, 5, 5, 5],
      });
    };
    const watchdogKey = 'repeated-tool-error:coord:presence:structural:timeout-report';

    const res = await captureImprovement({
      title: 'coord:presence tool-call failure (request_timeout)',
      body: 'A nested tools:invoke request for coord:presence exceeded its 55s timeout.',
      kind: 'bug',
      scope: 'harness:papercusp',
      watchdogKey,
      payloadExtra: {
        toolFailureProbation: {
          state: 'promoted',
          directEvidence: true,
          watchdogKey,
          class: 'structural',
          report: {
            toolName: 'coord:presence',
            status: 'request_timeout',
            message: 'A nested tools:invoke request for coord:presence exceeded its 55s timeout.',
          },
        },
      },
    }, d);

    expect(res).toMatchObject({ ok: true, created: true, issue: { id: 'EI-100' } });
    expect(res.possibleDuplicates).toEqual([
      expect.objectContaining({ id: wrapperFailure.id, semantic: 'soft' }),
    ]);
    expect(pressureReads).toBe(0);
    expect(base.created).toHaveLength(1);
    expect(base.created[0]).toMatchObject({
      title: 'coord:presence tool-call failure (request_timeout)',
      body: 'A nested tools:invoke request for coord:presence exceeded its 55s timeout.',
    });
  });

  it('P-005 CONTROL: ordinary keyed captures still use a keyless soft sibling during a burst', async () => {
    const worded = existing({
      id: 'EI-59',
      title: 'similar queue admission failure',
      scope: 'harness:papercusp',
      payload: { lane: 'improvement' },
    });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: worded.id, similarity: 0.91 }] }, [worded]);
    d.readIssueAdmissionPressure = async () =>
      assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
        emitterCounts: [430, 5, 5, 5, 5, 5],
      });

    const res = await captureImprovement({
      title: 'differently worded queue admission failure',
      kind: 'bug',
      scope: 'harness:papercusp',
      watchdogKey: 'condition:ordinary-keyed-capture',
    }, d);

    expect(res).toMatchObject({ created: false, reason: 'coalesced', issue: { id: 'EI-59' } });
    expect(base.created).toHaveLength(0);
  });

  it('P-005 direct-evidence tool failures still coalesce on their exact watchdog key', async () => {
    const watchdogKey = 'repeated-tool-error:improvements:capture:structural:unrelated-coalescence:field-unknown';
    const sameFailure = existing({
      id: 'EI-SAME-TOOL-FAILURE',
      title: 'the same captured tool failure',
      scope: 'harness:papercusp',
      payload: {
        lane: 'improvement',
        watchdogKey,
        toolFailureProbation: { state: 'promoted', directEvidence: true, watchdogKey },
      },
    });
    const d = {
      ...deps({ found: [sameFailure] }),
      findIssuesByWatchdogKeys: async () => [sameFailure],
      mergeIssuePayload: async (_id, patch) => {
        sameFailure.payload = { ...(sameFailure.payload as Record<string, unknown>), ...patch };
        return sameFailure;
      },
      updateIssuePatch: async (_id, patch) => {
        Object.assign(sameFailure, { title: patch.title, body: patch.body });
        return sameFailure;
      },
    } satisfies CaptureDeps;

    const res = await captureImprovement({
      title: 'improvements:capture tool-call failure (unrelated-coalescence)',
      kind: 'bug',
      scope: 'harness:papercusp',
      watchdogKey,
      payloadExtra: {
        toolFailureProbation: { state: 'promoted', directEvidence: true, watchdogKey },
      },
    }, d);

    expect(res).toMatchObject({ created: false, reason: 'coalesced', issue: { id: sameFailure.id } });
    expect(d.created).toHaveLength(0);
  });

  it('P-005 never consults the burst circuit for a critical finding', async () => {
    const worded = existing({ id: 'EI-58', title: 'near critical finding' });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: 'EI-58', similarity: 0.91 }] }, [worded]);
    let pressureReads = 0;
    d.readIssueAdmissionPressure = async () => {
      pressureReads += 1;
      return assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [455],
        emitterCounts: [455],
      });
    };

    const res = await captureImprovement(
      { title: 'novel critical queue failure', kind: 'bug', severity: 'critical' },
      d,
    );
    expect(res.created).toBe(true);
    expect(pressureReads).toBe(0);
    expect(base.created).toHaveLength(1);
  });

  // ── D-033 (learning-loop-identity-and-consumption-2026-08-08 P-008), narrowed
  // by P-002 (silent-intake, D-001): `semanticBlockBand:'soft'` now lets a soft
  // hit carry the file-time VERDICT (the decline it used to gate is retired), for
  // high-volume MACHINE ideation only. The pair below is deliberate: the CONTROL
  // pins the default so a future change that makes the soft band verdict-eligible
  // universally fails HERE rather than silently mislabeling agent filings
  // (owner constraint D-004).
  it('D-033: semanticBlockBand:"soft" lets a SOFT hit carry the dedupVerdict (files, P-002)', async () => {
    const worded = existing({ id: 'EI-54', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-54', similarity: 0.87 }] }, [worded]);
    const res = await captureImprovement(
      { title: 'a completely differently worded capture', kind: 'change', semanticBlockBand: 'soft' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates?.[0]).toMatchObject({ id: 'EI-54', semantic: 'soft', similarity: 0.87 });
    expect(d.created[0].payload).toMatchObject({ dedupVerdict: 'likely-duplicate' });
  });

  it('D-033 CONTROL: the DEFAULT still lets a soft hit through — agent filings are never blocked by a soft band', async () => {
    const worded = existing({ id: 'EI-55', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-55', similarity: 0.87 }] }, [worded]);
    // Same inputs as the case above, minus the opt-in. Only the flag differs.
    const res = await captureImprovement({ title: 'a completely differently worded capture', kind: 'change' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates?.[0]).toMatchObject({ id: 'EI-55', semantic: 'soft' });
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.dedupVerdict).toBeUndefined();
  });

  it('D-033: semanticBlockBand:"soft" does NOT widen blocking to CONTAINMENT hits (asymmetric, stays advisory in both modes)', async () => {
    // Calibration: proves the opt-in widens the SEMANTIC band specifically rather
    // than loosening blocking generally — otherwise both tests above would pass
    // for a predicate that simply blocks everything.
    const broad = existing({ id: 'EI-56', title: 'queue' });
    const d = semDeps(deps({ found: [broad] }), { hard: [], soft: [] }, [broad]);
    const res = await captureImprovement(
      { title: 'queue starves under fleet load', kind: 'change', semanticBlockBand: 'soft' },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('a null verdict (guard disabled / embedder down) leaves the lexical behavior unchanged', async () => {
    const d = semDeps(deps({ found: [] }), null, []);
    const res = await captureImprovement({ title: 'anything at all', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([]);
  });

  it('origin discipline holds: a drill-origin semantic hit never widens an organic capture', async () => {
    const drill = existing({ id: 'EI-52', title: 'drill row', signalOrigin: 'drill' });
    const d = semDeps(deps({ found: [] }), { hard: [{ id: 'EI-52', similarity: 0.97 }], soft: [] }, [drill]);
    const res = await captureImprovement({ title: 'an organic capture', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([]);
  });

  it('a lexically-caught candidate keeps its lexical score and gains no semantic flag', async () => {
    const same = existing({ id: 'EI-53', title: 'docs search returns stale results' });
    const d = semDeps(deps({ found: [same] }), { hard: [{ id: 'EI-53', similarity: 0.96 }], soft: [] }, [same]);
    const res = await captureImprovement({ title: 'docs search returns stale results', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates?.[0].semantic).toBeUndefined();
    expect(res.possibleDuplicates?.[0].similarity).toBe(1);
  });

  // P-013 (D-042) narrowed this test's original claim, and deliberately so. It
  // used to read "observations skip the semantic net ENTIRELY". They no longer
  // do: the derived-identity fold consults the same embedder. What survives —
  // and is the invariant P-011 actually cared about — is that the DECLINE net
  // never applies to an observation. Folding is not declining: the filing lands
  // either way (ok:true), which is the D-003 half the owner left unweakened.
  it('the semantic DECLINE net still never applies to an observation, however similar', async () => {
    setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
    // 0.99 — far above every hard threshold. For an improvement this declines.
    const d = semDeps(deps({ found: [] }), { hard: [{ id: 'EI-57', similarity: 0.99 }], soft: [] }, []);

    const res = await captureImprovement({ title: 'x', kind: 'change', lane: 'observation' }, d);

    expect(res.ok).toBe(true);
    expect(res.reason).not.toBe('likely-duplicate');
    expect(res.created).toBe(true); // the scored row does not hydrate, so it mints
    setFlagOverridesForTest(null);
  });

  it('with the derived fold OFF, an observation consults no embedder at all (the pre-P-013 behaviour)', async () => {
    setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: false });
    let called = false;
    const d = {
      ...deps(),
      findSemanticDupes: async () => {
        called = true;
        return null;
      },
    };
    const res = await captureImprovement({ title: 'x', kind: 'change', lane: 'observation' }, d);
    expect(res.created).toBe(true);
    expect(called).toBe(false);
    setFlagOverridesForTest(null);
  });
});

describe('captureImprovement — observation coalescing by conditionKey (EI-15448)', () => {
  /** A stateful watchdogKey-aware store: findIssuesByWatchdogKeys/mergeIssuePayload/
   *  updateIssuePatch all operate on the SAME in-memory `store` array so a 2nd call
   *  in the same test genuinely finds the 1st call's row — exercising the real
   *  coalesce loop, not a canned return. */
  function coalesceDeps(): CaptureDeps & {
    created: CreateIssueInput[];
    store: EngineerIssue[];
    occurrences: RecordIssueOccurrenceInput[];
  } {
    const created: CreateIssueInput[] = [];
    const store: EngineerIssue[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    let nextId = 100;
    return {
      created,
      store,
      occurrences,
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      searchIssues: async () => [],
      createIssue: async (input) => {
        created.push(input);
        const issue = existing({
          id: `EI-${nextId++}`,
          title: input.title,
          kind: (input.kind as 'bug' | 'change') ?? 'change',
          payload: input.payload ?? null,
          // Faithful to the real writer (capture-core passes `createdBy: input.createdBy`
          // into createIssue) — without this the stored row is always unattributed, and
          // the cross-author coalesce below could never be exercised.
          createdBy: input.createdBy ?? null,
        });
        store.push(issue);
        return issue;
      },
      findIssuesByWatchdogKeys: async (keys) =>
        store.filter((i) => {
          const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
          return typeof k === 'string' && keys.includes(k);
        }),
      mergeIssuePayload: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
        return i;
      },
      updateIssuePatch: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        if (patch.title !== undefined) i.title = patch.title;
        if (patch.body !== undefined) i.body = patch.body;
        return i;
      },
    };
  }

  it('2 calls with the SAME watchdogKey + lane:observation → 1 row, repeatCount:2, reason:coalesced', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      {
        title: 'escalation-aging holding flat at 312',
        kind: 'change',
        lane: 'observation',
        watchdogKey: 'overwatch:escalation-aging',
      },
      d,
    );
    expect(first.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).watchdogKey).toBe('overwatch:escalation-aging');

    const second = await captureImprovement(
      {
        title: 'escalation-aging holding flat at 318',
        kind: 'change',
        lane: 'observation',
        watchdogKey: 'overwatch:escalation-aging',
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1); // still only ONE row ever created
    expect(d.store).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(d.store[0].title).toBe('escalation-aging holding flat at 318'); // title refreshed to latest reading
    expect(second.issue?.id).toBe(first.issue?.id);
    expect(d.occurrences.map((occurrence) => occurrence.reportKind)).toEqual(['canonical-created', 'coalesced']);
    expect(d.occurrences[1]).toMatchObject({
      canonicalId: first.issue?.id,
      sourceTool: 'improvements:capture',
      reportedTitle: 'escalation-aging holding flat at 318',
    });
  });

  it('folds differently worded reports of the same native shell refusal without rewriting the first account', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement({
      title: 'exec_command rejects safe temporary-log cleanup',
      body: 'CreateProcess refused: rm -f style commands are not permitted',
      kind: 'change', lane: 'observation', createdBy: 'su-first',
    }, d);
    const second = await captureImprovement({
      title: 'shell guard blocks explicit mktemp cleanup',
      body: 'The sandbox says RM -F STYLE COMMANDS ARE NOT PERMITTED.',
      kind: 'change', lane: 'observation', createdBy: 'su-second',
    }, d);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, reason: 'coalesced' });
    expect(second.coalescedOnto).toMatchObject({ identity: 'derived', textDisposition: 'append-only' });
    expect(d.created).toHaveLength(1);
    expect(d.store[0].title).toBe('exec_command rejects safe temporary-log cleanup');
    expect((d.store[0].payload as Record<string, unknown>)).toMatchObject({
      watchdogKey: 'native-exec-refusal:rm-f-style-commands-not-permitted',
      repeatCount: 2,
    });
    expect(d.occurrences.map((row) => row.reportKind)).toEqual(['canonical-created', 'coalesced']);
    expect(d.occurrences.map((row) => row.reporter)).toEqual(['su-first', 'su-second']);
  });

  it('keeps distinct cleanup failures and immutable verdicts separate from the native refusal identity', async () => {
    const d = coalesceDeps();
    const filings = [
      { title: 'exec_command refuses rm -f cleanup', body: 'rm -f style commands are not permitted' },
      { title: 'shell cleanup failed', body: 'rm -f returned permission denied from the container filesystem' },
      { title: 'exec_command had a quoting error', body: 'the shell did not expand the mktemp path' },
    ];
    for (const filing of filings) {
      expect((await captureImprovement({ ...filing, kind: 'change', lane: 'observation' }, d)).created).toBe(true);
    }
    expect((await captureImprovement({
      ...filings[0], kind: 'change', lane: 'observation', initialState: 'done',
    }, d)).created).toBe(true);
    expect(d.created).toHaveLength(4);
    expect(d.created[3].state).toBe('done');
    expect((d.created[3].payload as Record<string, unknown>).watchdogKey).toBeUndefined();
  });

  // P-006/D-004: a coalesce used to return ok:true / created:false / reason:'coalesced'
  // and nothing more — identical whether the caller's text replaced the row's or was
  // silently dropped by the refresh's `.catch(() => null)`, and identical whether the
  // row was the caller's own or a peer's. `coalescedOnto` reports what actually happened.
  describe('coalescedOnto — what the write actually did (P-006/D-004)', () => {
    it('reports the row, the bumped count, and that the body PERSISTED', async () => {
      const d = coalesceDeps();
      const first = await captureImprovement(
        { title: 'reading 312', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      const second = await captureImprovement(
        { title: 'reading 318', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(second.coalescedOnto).toMatchObject({
        id: first.issue?.id,
        repeatCount: 2,
        bodyPersisted: true,
        priorAuthor: 'agent-a',
        crossAuthor: false,
      });
      expect(second.coalescedOnto?.bodyDiscarded).toBeUndefined();
      expect(d.store[0].title).toBe('reading 318');
    });

    // The load-bearing case: the refresh fails, the row keeps the PREVIOUS text, and
    // the call still returns ok. Before this the caller had no way to know.
    it('reports bodyDiscarded when the title/body refresh FAILED — the silent write-loss', async () => {
      const d = coalesceDeps();
      await captureImprovement(
        { title: 'reading 312', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      d.updateIssuePatch = async () => {
        throw new Error('shrink guard tripped');
      };
      const second = await captureImprovement(
        { title: 'reading 318', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(second.ok).toBe(true); // still not an error — the coalesce itself succeeded
      expect(second.coalescedOnto).toMatchObject({ bodyPersisted: false, bodyDiscarded: true, repeatCount: 2 });
      expect(String(second.coalescedOnto?.note)).toMatch(/DISCARDED/);
      expect(d.store[0].title).toBe('reading 312'); // the row really does still show the OLD reading
    });

    it("flags crossAuthor when the coalesce lands on ANOTHER agent's row", async () => {
      const d = coalesceDeps();
      await captureImprovement(
        { title: 'grade A', kind: 'change', lane: 'observation', watchdogKey: 'scorecard:r:h', createdBy: 'agent-a' },
        d,
      );
      const second = await captureImprovement(
        { title: 'grade B', kind: 'change', lane: 'observation', watchdogKey: 'scorecard:r:h', createdBy: 'agent-b' },
        d,
      );
      expect(second.coalescedOnto).toMatchObject({ crossAuthor: true, priorAuthor: 'agent-a' });
      expect(String(second.coalescedOnto?.note)).toMatch(/PEER'?’?s row/);
    });

    // crossAuthor must never be ASSERTED from missing data: an unattributed row is
    // "not established", not "a peer's" and not "your own".
    it('does NOT claim crossAuthor when either side is unattributed', async () => {
      const d = coalesceDeps();
      await captureImprovement({ title: 'a', kind: 'change', lane: 'observation', watchdogKey: 'k' }, d);
      const second = await captureImprovement(
        { title: 'b', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-b' },
        d,
      );
      expect(second.coalescedOnto?.priorAuthor).toBeNull();
      expect(second.coalescedOnto?.crossAuthor).toBe(false);
    });

    it('is absent entirely on a normal CREATE — it is a property of coalescing only', async () => {
      const d = coalesceDeps();
      const first = await captureImprovement(
        { title: 'fresh', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(first.created).toBe(true);
      expect(first.coalescedOnto).toBeUndefined();
    });
  });

  it('a 3rd call with the same key bumps repeatCount to 3 (running count, not a flip-flag)', async () => {
    const d = coalesceDeps();
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' }, d);
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' }, d);
    const third = await captureImprovement(
      { title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' },
      d,
    );
    expect(third.reason).toBe('coalesced');
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(3);
    expect(d.created).toHaveLength(1);
  });

  it('a call WITHOUT watchdogKey always re-files, even when a same-titled observation already exists', async () => {
    const d = coalesceDeps();
    await captureImprovement({ title: 'a one-off reading', kind: 'change', lane: 'observation' }, d);
    const second = await captureImprovement({ title: 'a one-off reading', kind: 'change', lane: 'observation' }, d);
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2); // no coalescing — 2 distinct rows
  });

  it("a DIFFERENT watchdogKey never coalesces onto another key's open row", async () => {
    const d = coalesceDeps();
    await captureImprovement(
      { title: 'condition A', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:a' },
      d,
    );
    const res = await captureImprovement(
      { title: 'condition B', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:b' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('a NON-observation keyed re-fire coalesces onto ITS OWN lane row, never into an observation row', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      { title: 'a real bug', kind: 'bug', watchdogKey: 'overwatch:not-an-observation' },
      d,
    );
    const second = await captureImprovement(
      { title: 'a real bug', kind: 'bug', watchdogKey: 'overwatch:not-an-observation' },
      d,
    );
    expect(first.created).toBe(true);
    // CONTRACT CHANGED TWICE. EI-20484430331973864 turned the re-file from a fresh
    // row (the 459-copy duplicate storm) into a DECLINE; WI-39594 turned the decline
    // into a COALESCE — same zero-new-rows guarantee, but the standing row now
    // carries repeatCount + the newest reading instead of the occurrence being
    // dropped on the floor. The invariant that SURVIVES both changes: the merge
    // target is the same-lane prior — a non-observation capture never merges into
    // an observation-lane row (see the WI-39594 cross-lane CONTROL below).
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(second.issue?.id).toBe(first.issue?.id);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(d.created).toHaveLength(1);
  });

  it('a CLOSED/resolved row carrying the same key does not coalesce (only an OPEN prior does)', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      { title: 'condition C', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:c' },
      d,
    );
    d.store[0].state = 'resolved';
    const second = await captureImprovement(
      { title: 'condition C recurred', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:c' },
      d,
    );
    expect(second.created).toBe(true);
    expect(second.reason).not.toBe('coalesced');
    expect(d.created).toHaveLength(2);
    expect(first.issue?.id).not.toBe(second.issue?.id);
  });
});

describe('captureImprovement — atomic claim-on-file (WI-5950)', () => {
  it('passes assignee through to createIssue so the filed item lands CLAIMED', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'bug I am already fixing', kind: 'bug', assignee: 'su-abc', createdBy: 'su-abc' },
      d,
    );
    expect(d.created[0].assignee).toBe('su-abc');
  });

  it('stamps assignedBy from the filer, so the claim has a durable delegator', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'bug', assignee: 'su-abc', createdBy: 'su-abc' }, d);
    expect(d.created[0].assignedBy).toBe('su-abc');
  });

  it('leaves the item UNCLAIMED when assignee is omitted — filing stays cheap', async () => {
    const d = deps();
    await captureImprovement({ title: 'a finding for whoever picks it up', kind: 'bug', createdBy: 'su-abc' }, d);
    expect(d.created[0].assignee).toBeUndefined();
  });

  it('NEVER claims an observation — a sensor reading is not claimable work', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'docs:search felt slow',
        kind: 'change',
        lane: 'observation',
        assignee: 'su-abc',
        createdBy: 'su-abc',
      },
      d,
    );
    expect(d.created[0].assignee).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// P-007 (knowledge-at-symptom-time-2026-08-09) — symptom-first dedup lookup.
//
// The MEASURED incident, 2026-08-09: I filed EI-19948333346987654, then ran the
// `checkDuplicatesOnly` lookup with a query that is a VERBATIM SUBSTRING of that item's
// own title. It returned `possibleDuplicates: []`. The exact full title returned it at
// similarity 1.0 — so the item was indexed and reachable; the NET was the problem.
//
// Root cause: titleSimilarity is token-set Jaccard, which divides by the UNION. A short
// query that is a perfect SUBSET of a longer stored title therefore scores |query|/|title|
// and can never clear DUP_THRESHOLD. That is a structural bias against the exact shape of
// a symptom-first lookup: at symptom time the query is SHORT (the error you just saw)
// while stored titles are LONG (written after diagnosis).
//
// A prior filing (EI-19502216864373653, dropped) attributed an identical empty result
// SOLELY to the embedder being down. That was one cause; this is a second, independent
// one that persists with a perfectly healthy semantic leg.
// ───────────────────────────────────────────────────────────────────────────────────────

/** The real stored title, verbatim. */
const REAL_TITLE =
  'No way to locate or focus an agent\'s desktop terminal window — GNOME Wayland makes wmctrl/xdotool return EMPTY with exit 0, indistinguishable from "no window exists"';
/** The real symptom-first query, verbatim — a literal substring of REAL_TITLE. */
const SYMPTOM_QUERY = "No way to locate or focus an agent's desktop terminal window";

describe('P-007 — symptom-first containment lookup', () => {
  it('FALSIFIABILITY CONTROL: the PRE-FIX metric (Jaccard alone) misses the real measured pair; containment catches it', () => {
    // This control is PERMANENT. Every assertion below would pass against an implementation
    // that quietly did nothing if the underlying pair were not actually hard for Jaccard —
    // so pin BOTH sides of the discrimination on the real strings.
    const jac = titleSimilarity(SYMPTOM_QUERY, REAL_TITLE);
    expect(jac).toBeLessThan(DUP_THRESHOLD); // CONTROL: the pre-fix net genuinely fails here
    const contained = titleContainment(SYMPTOM_QUERY, REAL_TITLE);
    expect(contained).toBeGreaterThanOrEqual(CONTAINMENT_THRESHOLD); // and the fix genuinely rescues it
  });

  it('surfaces the containment hit that Jaccard missed, flagged as such', async () => {
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: SYMPTOM_QUERY, kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates?.map((p) => p.id)).toEqual(['EI-19948333346987654']);
    expect(res.possibleDuplicates?.[0].lexical).toBe('containment');
    expect(res.possibleDuplicates?.[0].similarity).toBeGreaterThanOrEqual(CONTAINMENT_THRESHOLD);
  });

  it('SAFETY: a containment-only hit NEVER declines a capture — surfacing is widened, blocking is not', async () => {
    // The asymmetry matters: containment says "your short title is covered by this broad
    // one", which is true for many genuinely-distinct narrow items. Missing a duplicate
    // costs a duplicate; wrongly declining costs the FINDING.
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: SYMPTOM_QUERY, kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect(res.possibleDuplicates?.[0].lexical).toBe('containment'); // still SHOWN, just not blocking
  });

  it('does not re-label a candidate the lexical net already caught (exact title keeps similarity 1, no containment flag)', async () => {
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: REAL_TITLE, kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates?.[0].similarity).toBe(1);
    expect(res.possibleDuplicates?.[0].lexical).toBeUndefined();
  });

  it('a too-short query is NOT a containment match (below CONTAINMENT_MIN_TOKENS it would match half the backlog)', async () => {
    const d = deps({ found: [existing({ id: 'EI-1', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: 'window focus', kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates).toEqual([]);
  });
});

describe('P-007 — dedupCoverage: an empty result must disclose whether it could CHECK', () => {
  it('reports semantic UNAVAILABLE + degraded when the embedding leg returns no verdict', async () => {
    // The embedder fails OPEN (null on timeout / down / disabled). EI-19502216864373653
    // measured the cost of not saying so: an agent read a bare [] as "no duplicates",
    // filed, and retracted minutes later against an open major item from ~12h earlier.
    const d = { ...deps(), findSemanticDupes: async () => null };
    const res = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      d,
    );
    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
  });

  it('reports semantic OK + not degraded only when the embedding leg and index coverage are healthy', async () => {
    const d = {
      ...deps(),
      findSemanticDupes: async () => healthySemanticResult({ hard: 0.9, soft: 0.8 }),
    };
    const res = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      d,
    );
    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });

  it('makes an empty title-only pre-check explicitly inconclusive for the eventual full capture', async () => {
    const d = {
      ...deps(),
      findSemanticDupes: async () => healthySemanticResult(),
    };
    const res = await captureImprovement(
      { title: 'a title-only query with a healthy semantic index', kind: 'bug', checkDuplicatesOnly: true },
      d,
    );

    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
    expect(res.hint).toContain('An empty `possibleDuplicates` list is not evidence');
    expect(res.hint).toContain('Rerun checkDuplicatesOnly with the exact final body');
  });

  it('forwards harness scope to title-only and final-body semantic searches', async () => {
    const title = 'scorecards:get ignores rerunRecipe evidence used by the auditor';
    const body = 'The projection omits payload.observation.rerunRecipe from scorecards:get results.';
    const prior = existing({
      id: 'EI-TITLE-ONLY-SEMANTIC-MISS',
      title: 'scorecards:get omits payload.observation.rerunRecipe needed for auditor reruns',
    });
    const queries: Array<{ title: string; summary?: string; harness?: string }> = [];
    const d = {
      ...deps(),
      searchIssues: async () => {
        throw new Error('lexical search unavailable');
      },
      findSemanticDupes: async (query: { title: string; summary?: string; harness?: string }) => {
        queries.push(query);
        return query.summary
          ? {
              ...healthySemanticResult(),
              hard: [{
                id: prior.id,
                title: prior.title,
                state: prior.state,
                harness: 'papercusp',
                similarity: 0.96,
              }],
            }
          : healthySemanticResult();
      },
      getIssue: async () => prior,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const titleOnly = await captureImprovement(
        { title, kind: 'bug', scope: 'harness:papercusp', checkDuplicatesOnly: true },
        d,
      );
      const withFinalBody = await captureImprovement(
        { title, body, kind: 'bug', scope: 'harness:papercusp', checkDuplicatesOnly: true },
        d,
      );

      expect(queries).toEqual([
        { title, harness: 'papercusp' },
        { title, summary: body, harness: 'papercusp' },
      ]);
      expect(titleOnly.possibleDuplicates).toEqual([]);
      expect(titleOnly.dedupCoverage).toEqual({ lexical: 'unavailable', semantic: 'ok', degraded: true });
      expect(titleOnly.hint).toContain('an empty possibleDuplicates list is inconclusive');
      expect(titleOnly.hint).toContain('one search leg reports ok');
      expect(titleOnly.hint).toContain('Include the final body and rerun checkDuplicatesOnly');
      expect(withFinalBody.possibleDuplicates).toMatchObject([
        { id: prior.id, semantic: 'hard', similarity: 0.96 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { name: 'below-floor index', verdict: 'degraded' as const, semantic: 'partial' as const, degraded: true },
    { name: 'unknown index coverage', verdict: 'unknown' as const, semantic: 'unavailable' as const, degraded: true },
    { name: 'unmapped semantic source', verdict: 'not-semantic' as const, semantic: 'unavailable' as const, degraded: true },
    { name: 'missing coverage assessment', verdict: undefined, semantic: 'unavailable' as const, degraded: true },
  ])('does not call an empty result clean with $name', async ({ verdict, semantic, degraded }) => {
    const d = {
      ...deps(),
      findSemanticDupes: async () => ({
        hard: [],
        soft: [],
        thresholds: { hard: 0.93, soft: 0.9 },
        ...(verdict ? { coverage: semanticCoverageAssessment(verdict) } : {}),
      }),
    };

    const res = await captureImprovement(
      { title: 'same title queried against an incomplete semantic index', kind: 'bug', checkDuplicatesOnly: true },
      d,
    );

    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic, degraded });
  });

  it('CONTROL: the two cases above are DISTINGUISHABLE — pre-fix they were byte-identical', async () => {
    // Without dedupCoverage both calls return exactly `possibleDuplicates: []`. If this
    // assertion ever fails, the disclosure has been dropped and the ambiguity is back.
    const down = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      { ...deps(), findSemanticDupes: async () => null },
    );
    const up = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      { ...deps(), findSemanticDupes: async () => healthySemanticResult({ hard: 0.9, soft: 0.8 }) },
    );
    expect(down.possibleDuplicates).toEqual(up.possibleDuplicates); // the pre-fix payload: identical
    expect(down.dedupCoverage).not.toEqual(up.dedupCoverage); // the fix: no longer identical
  });

  it('the CREATE path carries coverage too — that is where the retraction incident happened', async () => {
    const d = { ...deps(), findSemanticDupes: async () => null };
    const res = await captureImprovement({ title: 'a brand new finding', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.dedupCoverage?.degraded).toBe(true);
  });
});

describe('EI-20275452450016416 — the achieved coverage is PERSISTED, not just reported', () => {
  const coverageOf = (d: ReturnType<typeof deps>) =>
    (d.created[0].payload as Record<string, unknown> | undefined)?.dedupCoverage;

  it('stamps payload.dedupCoverage when the semantic leg was DOWN — the re-dedup work-list', async () => {
    // Returning the degraded bit to the caller and then discarding it left no way to
    // find the rows admitted without a differently-worded-duplicate check. Measured
    // pre-fix: 0 of 6,179 rows in 7 days carried it.
    const d = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...d, findSemanticDupes: async () => null },
    );
    expect(coverageOf(d)).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
  });

  it('stamps it when the leg was HEALTHY too — absence must not be ambiguous', async () => {
    // Stamping only the degraded rows would make a missing key mean either "checked
    // clean" or "filed before this existed" — the same lost distinction the discard
    // created. Presence of the key is what makes the population measurable.
    const d = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...d, findSemanticDupes: async () => healthySemanticResult({ hard: 0.9, soft: 0.8 }) },
    );
    expect(coverageOf(d)).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });

  it('CONTROL: the two persisted rows are DISTINGUISHABLE — a stamp that never varies is not evidence', async () => {
    const down = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...down, findSemanticDupes: async () => null },
    );
    const up = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...up, findSemanticDupes: async () => healthySemanticResult({ hard: 0.9, soft: 0.8 }) },
    );
    expect(coverageOf(down)).not.toEqual(coverageOf(up));
  });

  it('does NOT stamp the observation lane — both legs are skipped by design, so the value is a constant', async () => {
    // An observation skips dedup entirely (recurrence IS its signal), so its coverage
    // is always {skipped, skipped, false}. Persisting a constant would add a column of
    // noise to the highest-volume lane and dilute the degraded work-list.
    const d = deps();
    await captureImprovement(
      { title: 'a sensor reading', kind: 'change', lane: 'observation' },
      { ...d, findSemanticDupes: async () => null },
    );
    expect(coverageOf(d)).toBeUndefined();
  });
});

describe('WI-38403 — stable identity + fail-closed DRAIN admission', () => {
  const payloadOf = (d: ReturnType<typeof deps>) => d.created[0].payload as Record<string, unknown> | undefined;

  it('persists the server-authored normalized title identity and stronger signal key', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: '[bug] Agents file duplicate drain blockers', kind: 'bug', watchdogKey: 'drain:blocked:queue' },
      { ...d, findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }) },
    );
    expect(res.admissionIdentity).toEqual({
      schemaVersion: 'admission-identity-v1',
      titleKey: 'title:agents blockers drain duplicate file',
      signalKey: 'drain:blocked:queue',
    });
    expect(payloadOf(d)?.admissionIdentity).toEqual(res.admissionIdentity);
  });

  it('marks a failed lexical search unavailable instead of reporting a false all-clear', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps();
      const res = await captureImprovement(
        { title: 'novel direct drain blocker', kind: 'bug', checkDuplicatesOnly: true },
        {
          ...d,
          searchIssues: async () => {
            throw new Error('search unavailable');
          },
          findSemanticDupes: async () => healthySemanticResult(),
        },
      );
      expect(res.dedupCoverage).toEqual({ lexical: 'unavailable', semantic: 'ok', degraded: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('search unavailable'));
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds a hanging lexical search and keeps lexical coverage unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const d = deps();
      const hangingSearch = new Promise<EngineerIssue[]>(() => {});
      const resultPromise = captureImprovement(
        { title: 'hanging lexical dedup search', kind: 'bug', checkDuplicatesOnly: true },
        {
          ...d,
          searchIssues: async () => hangingSearch,
          findSemanticDupes: async () => healthySemanticResult(),
        },
      );

      await vi.advanceTimersByTimeAsync(CAPTURE_LEXICAL_SEARCH_BUDGET_MS + 1);
      const res = await resultPromise;

      expect(res.dedupCoverage).toEqual({ lexical: 'unavailable', semantic: 'ok', degraded: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 1500ms'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('P-002: a DRAIN bug on an unmeasured dedup path now FILES with the degradation stamped (veto retired)', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'direct drain blocker with no semantic verdict',
        kind: 'bug',
        force: true,
        requireCompleteDedupCoverage: true,
      },
      { ...d, findSemanticDupes: async () => null },
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect(payloadOf(d)?.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
  });

  it('admits a DRAIN bug when both dedup legs returned real verdicts', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'verified unique direct drain blocker', kind: 'bug', requireCompleteDedupCoverage: true },
      { ...d, findSemanticDupes: async () => healthySemanticResult() },
    );
    expect(res.created).toBe(true);
    expect(payloadOf(d)?.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });
});

describe('exact watchdogKey is a first-class blocking dedup source (EI-20484430331973864)', () => {
  const noSemantic = async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } });
  const KEY = 'routine-engine-death:engine:live';
  const DEAD_ENGINE = 'The routines engine is dead — every active routine is overdue';

  it('a standing re-file lands on the exact-key row even when the lexical search is UNAVAILABLE', async () => {
    // The 459-copy regression: the red-queen sentinel re-files a standing outage on a
    // stable key every 5 min. Blocking dedup used to rest entirely on the fuzzy title
    // search, which fails OPEN — so every pass where search was down minted a fresh
    // critical row. The exact key was fetched all along and then thrown away.
    // CONTRACT SHARPENED by WI-39594: the open exact-key row is now a COALESCE
    // target (repeatCount bump + refresh) rather than a bare decline — same
    // zero-new-rows guarantee, and the outcome no longer depends on the fuzzy
    // search at all (the coalesce runs before it).
    const d = deps();
    const prior = existing({ id: 'EI-900', title: DEAD_ENGINE, payload: { watchdogKey: KEY } });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', severity: 'critical', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        searchIssues: async () => {
          throw new Error('search unavailable');
        },
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => [prior],
        mergeIssuePayload: async (_id, patch) =>
          existing({ ...prior, payload: { ...(prior.payload as object), ...patch } }),
        updateIssuePatch: async (_id, patch) => existing({ ...prior, title: patch.title ?? prior.title }),
      },
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.issue?.id).toBe('EI-900');
    expect(d.created).toHaveLength(0);
  });

  it('lands on the KEY row even when the title is completely different', async () => {
    const d = deps();
    const prior = existing({ id: 'EI-901', title: 'totally unrelated wording', payload: { watchdogKey: KEY } });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => [prior],
        mergeIssuePayload: async (_id, patch) =>
          existing({ ...prior, payload: { ...(prior.payload as object), ...patch } }),
        updateIssuePatch: async (_id, patch) => existing({ ...prior, title: patch.title ?? prior.title }),
      },
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(d.created).toHaveLength(0);
  });

  it('CONTROL — a DIFFERENT watchdogKey still creates (the key net must not become a blanket block)', async () => {
    const d = deps();
    const other = existing({
      id: 'EI-902',
      title: 'some other standing condition',
      payload: { watchdogKey: 'a-different-key' },
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [other] },
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
  });

  it('CONTROL — a DRILL-origin exact-key row never suppresses a real organic outage filing', async () => {
    const d = deps();
    const drill = existing({
      id: 'EI-903',
      title: DEAD_ENGINE,
      payload: { watchdogKey: KEY },
      signalOrigin: 'drill',
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [drill] },
    );
    expect(res.created).toBe(true);
  });

  it('CONTROL — a RESOLVED exact-key item does not block under dedupScope:open', async () => {
    const d = deps();
    const resolved = existing({
      id: 'EI-904',
      title: DEAD_ENGINE,
      payload: { watchdogKey: KEY },
      state: 'resolved',
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [resolved] },
    );
    expect(res.created).toBe(true);
  });

  it('a failed exact-key lookup marks coverage degraded instead of a false all-clear', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'novel condition with a key', kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => {
          throw new Error('key lookup unavailable');
        },
      },
    );
    expect(res.dedupCoverage?.degraded).toBe(true);
  });
});

describe('captureImprovement — NON-observation coalescing by watchdogKey (WI-39594)', () => {
  /** Same stateful store shape as the observation-coalesce fixture above: a 2nd
   *  call genuinely finds the 1st call's row, exercising the real coalesce loop. */
  function keyDeps(): CaptureDeps & {
    created: CreateIssueInput[];
    store: EngineerIssue[];
    occurrences: RecordIssueOccurrenceInput[];
  } {
    const created: CreateIssueInput[] = [];
    const store: EngineerIssue[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    let nextId = 500;
    return {
      created,
      store,
      occurrences,
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      searchIssues: async () => [],
      createIssue: async (input) => {
        created.push(input);
        const issue = existing({
          id: `EI-${nextId++}`,
          title: input.title,
          kind: (input.kind as 'bug' | 'change') ?? 'change',
          payload: input.payload ?? null,
          createdBy: input.createdBy ?? null,
        });
        store.push(issue);
        return issue;
      },
      findIssuesByWatchdogKeys: async (keys) =>
        store.filter((i) => {
          const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
          return typeof k === 'string' && keys.includes(k);
        }),
      mergeIssuePayload: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
        return i;
      },
      updateIssuePatch: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        if (patch.title !== undefined) i.title = patch.title;
        if (patch.body !== undefined) i.body = patch.body;
        return i;
      },
    };
  }

  it('re-firing a keyed detector twice yields ONE open row — 2nd call coalesces (repeatCount 2, title refreshed)', async () => {
    const d = keyDeps();
    const firstPaths = ['packages/operator-core/lib/issues-engineer.ts'];
    const latestPaths = ['packages/operator-core/lib/harness/improvements/capture-core.ts'];
    const first = await captureImprovement(
      {
        title: 'Gym champion promoted: judge@h-pao cycle 4 — consider generalizing',
        kind: 'change',
        lane: 'improvement',
        watchdogKey: 'gym-champion:h-pao:judge',
        paths: firstPaths,
      },
      d,
    );
    expect(first.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).watchdogKey).toBe('gym-champion:h-pao:judge');

    const second = await captureImprovement(
      {
        title: 'Gym champion promoted: judge@h-pao cycle 5 — consider generalizing',
        kind: 'change',
        lane: 'improvement',
        watchdogKey: 'gym-champion:h-pao:judge',
        paths: latestPaths,
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1); // ONE open item — the WI-39594 acceptance
    expect(d.store).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect((d.store[0].payload as Record<string, unknown>).paths).toEqual(latestPaths);
    expect(d.store[0].title).toBe('Gym champion promoted: judge@h-pao cycle 5 — consider generalizing');
    expect(second.issue?.id).toBe(first.issue?.id);
    expect(second.coalescedOnto).toMatchObject({ id: first.issue?.id, repeatCount: 2 });
  });

  it('key-coalesce WINS over force:true — a forced detector re-fire refreshes, never forks (the champion-escalation dupe class)', async () => {
    const d = keyDeps();
    await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-1 breached its 30min completion SLA',
        kind: 'bug',
        force: true,
        watchdogKey: 'hive-canary-sla:papercusp',
      },
      d,
    );
    const second = await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-2 breached its 30min completion SLA',
        kind: 'bug',
        force: true,
        watchdogKey: 'hive-canary-sla:papercusp',
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
  });

  it('CONTROL: a different watchdogKey files fresh — coalesce is keyed identity, not a blanket suppressor', async () => {
    const d = keyDeps();
    await captureImprovement(
      { title: 'Hive canary a/WI-1 breached its SLA', kind: 'bug', watchdogKey: 'hive-canary-sla:a' },
      d,
    );
    const second = await captureImprovement(
      { title: 'Hive canary b/WI-9 breached its SLA', kind: 'bug', watchdogKey: 'hive-canary-sla:b' },
      d,
    );
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('CONTROL: a RESOLVED prior with the same key never coalesces — under dedupScope:open a recurrence re-files fresh', async () => {
    const d = keyDeps();
    await captureImprovement(
      {
        title: 'live-federation-gate RED: content-matrix failed (t1)',
        kind: 'bug',
        dedupScope: 'open',
        watchdogKey: 'live-federation-gate-red:papercusp',
      },
      d,
    );
    d.store[0].state = 'resolved';
    const second = await captureImprovement(
      {
        title: 'live-federation-gate RED: content-matrix failed (t2)',
        kind: 'bug',
        dedupScope: 'open',
        watchdogKey: 'live-federation-gate-red:papercusp',
      },
      d,
    );
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('CONTROL: an open OBSERVATION-lane row with the same key has a distinct identity from an improvement filing', async () => {
    const d = keyDeps();
    await captureImprovement(
      { title: 'sensor reading', kind: 'change', lane: 'observation', watchdogKey: 'shared:key' },
      d,
    );
    const second = await captureImprovement(
      { title: 'real improvement filing', kind: 'change', watchdogKey: 'shared:key' },
      d,
    );
    expect(second.created).toBe(true);
    expect(second.reason).not.toBe('coalesced');
    expect(d.created).toHaveLength(2); // migration 865 keeps observation/improvement identities separate
  });

  it('migration 865 recovers a concurrent same-identity INSERT conflict by coalescing the winner', async () => {
    const attempts: CreateIssueInput[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    const KEY = 'catalog-registration:prompt-weight';
    let lookupCount = 0;
    let releaseInitialLookups!: () => void;
    const initialLookups = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });
    let winner: EngineerIssue | undefined;
    const d: CaptureDeps & { store: EngineerIssue[]; occurrences: RecordIssueOccurrenceInput[] } = {
      store: [],
      searchIssues: async () => [],
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      findIssuesByWatchdogKeys: async () => {
        lookupCount += 1;
        if (lookupCount <= 2) {
          if (lookupCount === 2) releaseInitialLookups();
          await initialLookups;
          return [];
        }
        return winner ? [winner] : [];
      },
      createIssue: async (input) => {
        attempts.push(input);
        if (attempts.length > 1) {
          throw {
            code: '23505',
            constraint_name: 'work_items_watchdog_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
          };
        }
        winner = existing({
          id: 'EI-RACE-WINNER',
          title: input.title,
          scope: input.scope ?? 'operator',
          signalOrigin: input.signalOrigin ?? 'organic',
          payload: input.payload as Record<string, unknown>,
        });
        d.store.push(winner);
        return winner;
      },
      mergeIssuePayload: async (_id, patch) => {
        if (!winner) return null;
        winner.payload = { ...(winner.payload as Record<string, unknown> | null), ...patch };
        return winner;
      },
      updateIssuePatch: async (_id, patch) => {
        if (!winner) return null;
        if (patch.title !== undefined) winner.title = patch.title;
        if (patch.body !== undefined) winner.body = patch.body;
        return winner;
      },
      occurrences,
    };

    const leftInput = {
      title: 'prompt weight catalog registration is red',
      kind: 'bug' as const,
      watchdogKey: KEY,
      scope: 'harness:papercusp',
      paths: ['packages/operator-core/lib/issues-engineer.ts'],
    };
    const rightInput = {
      ...leftInput,
      title: 'prompt weight catalog registration is still red',
      paths: ['packages/operator-core/lib/harness/improvements/capture-core.ts'],
    };
    const [left, right] = await Promise.all([captureImprovement(leftInput, d), captureImprovement(rightInput, d)]);
    const results = [left, right];
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'coalesced')).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(d.store).toHaveLength(1);
    expect((winner?.payload as Record<string, unknown>).repeatCount).toBe(2);
    expect((winner?.payload as Record<string, unknown>).paths).toEqual(rightInput.paths);
    expect(occurrences.map((row) => row.reportKind).sort()).toEqual(['canonical-created', 'coalesced']);
  });

  it.each([
    ['origin', { signalOrigin: 'drill', scope: 'harness:papercusp', payload: { watchdogKey: 'k' } }],
    [
      'lane',
      { signalOrigin: 'organic', scope: 'harness:papercusp', payload: { watchdogKey: 'k', lane: 'observation' } },
    ],
    ['scope', { signalOrigin: 'organic', scope: 'harness:other-pot', payload: { watchdogKey: 'k' } }],
  ] as const)(
    'does not coalesce a unique-conflict winner with a mismatched %s identity component',
    async (_dimension, mismatch) => {
      let lookupCount = 0;
      const winner = existing({
        id: `EI-MISMATCH-${_dimension}`,
        title: 'winner from another identity partition',
        signalOrigin: mismatch.signalOrigin,
        scope: mismatch.scope,
        payload: mismatch.payload,
      });
      const d: CaptureDeps = {
        searchIssues: async () => [],
        findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
        findIssuesByWatchdogKeys: async () => {
          lookupCount += 1;
          return lookupCount === 1 ? [] : [winner];
        },
        createIssue: async () => {
          throw {
            code: '23505',
            constraint_name: 'work_items_watchdog_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
          };
        },
        mergeIssuePayload: async () => {
          throw new Error('must not merge a mismatched identity winner');
        },
      };

      await expect(
        captureImprovement(
          {
            title: 'same key from the requested partition',
            kind: 'bug',
            watchdogKey: 'k',
            scope: 'harness:papercusp',
          },
          d,
        ),
      ).rejects.toMatchObject({
        name: 'CaptureWatchdogIdentityConflictError',
        code: 'watchdog_identity_conflict',
        reason: 'no_compatible_winner',
        retryable: false,
        watchdogKey: 'k',
        relatedIds: [`EI-MISMATCH-${_dimension}`],
      });
    },
  );

  it('returns a retryable typed refusal when the named conflict winner cannot be re-read', async () => {
    let lookupCount = 0;
    const d = deps();
    d.findIssuesByWatchdogKeys = async () => {
      lookupCount += 1;
      if (lookupCount === 1) return [];
      throw new Error('secondary watchdog read unavailable');
    };
    d.createIssue = async () => {
      throw {
        code: '23505',
        constraint_name: 'work_items_watchdog_identity_uq',
        message: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
      };
    };

    await expect(
      captureImprovement({ title: 'winner lookup unavailable', kind: 'bug', watchdogKey: 'lookup:k' }, d),
    ).rejects.toMatchObject({
      name: 'CaptureWatchdogIdentityConflictError',
      code: 'watchdog_identity_conflict',
      reason: 'winner_lookup_failed',
      retryable: true,
      watchdogKey: 'lookup:k',
      relatedIds: [],
    });
  });

  it.each([true, false])('retains a conflicting tool-failure class only after a durable occurrence append (%s)', async (retained) => {
    const report: SuspectedToolFailure = {
      toolName: 'tools:invoke', errorCode: 'invalid_args', fieldPath: 'args',
      message: 'args: Invalid input: expected record, received string',
    };
    const incoming = normalizeSuspectedToolFailure(report);
    const priorReport = { ...report, fieldPath: undefined, runtimeVersion: '80b4797100' };
    const prior = normalizeSuspectedToolFailure(priorReport);
    const winner = existing({
      id: 'EI-OTHER-CLASS', title: 'prior failure', scope: 'harness:papercusp',
      payload: { watchdogKey: incoming.watchdogKey, lane: 'observation',
        toolFailureProbation: { ...prior, state: 'probation', report: priorReport, reporters: ['su-prior'] } },
    });
    const record = vi.fn(async () => retained ? { id: 1 } : null);
    const merge = vi.fn(async () => { throw new Error('must preserve the incumbent class'); });
    const d = deps();
    d.findIssuesByToolFailureClassKeys = async () => [];
    d.findIssuesByWatchdogKeys = async () => [winner];
    d.createIssue = async () => { throw { code: '23505', constraint_name: 'work_items_watchdog_identity_uq' }; };
    d.mergeIssuePayload = merge;
    d.recordIssueOccurrence = record as CaptureDeps['recordIssueOccurrence'];
    const input = {
      title: 'incoming failure from another class', kind: 'change' as const,
      lane: 'observation' as const, scope: 'harness:papercusp',
      watchdogKey: incoming.watchdogKey, createdBy: 'su-incoming',
      payloadExtra: { toolFailureProbation: { ...incoming, state: 'probation', report, reporters: ['su-incoming'] } },
    };
    if (retained) {
      await expect(captureImprovement(input, d)).resolves.toMatchObject({
        ok: true, created: false, reason: 'coalesced', issue: { id: winner.id },
      });
    } else {
      await expect(captureImprovement(input, d)).rejects.toMatchObject({
        code: 'watchdog_identity_conflict', reason: 'no_compatible_winner',
      });
    }
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      canonicalId: winner.id, reporter: 'su-incoming',
      evidence: expect.objectContaining({ payloadExtra: input.payloadExtra }),
    }));
    expect(merge).not.toHaveBeenCalled();
    expect(winner).toMatchObject({ payload: { toolFailureProbation: { classKey: prior.classKey } } });
  });

  it('does not swallow a different unique violation as a watchdog race', async () => {
    const d = deps();
    d.createIssue = async () => {
      throw {
        code: '23505',
        constraint_name: 'work_items_condition_key_uq',
        message: 'duplicate key value violates unique constraint "work_items_condition_key_uq"',
      };
    };
    await expect(
      captureImprovement({ title: 'unrelated unique failure', kind: 'bug', watchdogKey: 'condition:k' }, d),
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'work_items_condition_key_uq' });
  });
});

/**
 * P-013 (owner amendment D-042) — the DERIVED-identity fold, at the WIRING level.
 *
 * observation-fold.test.ts already proves the decider's precision on a labelled
 * sample. What it cannot prove is that captureImprovement actually ROUTES a
 * verdict: that a 'hard' verdict really bumps repeatCount on the survivor
 * instead of minting, that 'soft' really mints AND links, and — the clause the
 * owner made non-negotiable — that NO path rejects the filing. Those are
 * properties of this file's branch, so they are tested here.
 *
 * Every seam is injected; nothing below opens PG or an embedder.
 */
describe('captureImprovement — derived-identity fold for agent filings (P-013 / D-042)', () => {
  // Restore normal flag resolution. `null` CLEARS the override map; `{}` does
  // not — it is a truthy map that pins every flag to FLAG_DEFAULTS for the rest
  // of the process, which would silently govern later tests in this file.
afterEach(() => setFlagOverridesForTest(null));

  const PRIOR_ID = 'EI-500';

  /** An open, unkeyed observation row in the same scope + origin — i.e. one the
   *  retrieval filter is supposed to ACCEPT as a fold candidate. */
  function priorObservation(p: Partial<EngineerIssue> = {}): EngineerIssue {
    return existing({
      id: PRIOR_ID,
      title: '`coord:send` rejects a body over the size cap without naming the cap',
      kind: 'change',
      severity: 'nit',
      state: 'open',
      scope: 'operator',
      signalOrigin: 'organic',
      createdBy: 'su-first-reporter',
      payload: { lane: 'observation', repeatCount: 1, reporters: ['su-first-reporter'] },
      ...p,
    });
  }

  function semantic(hard: SemanticDupeResult['hard'], soft: SemanticDupeResult['soft'] = []): SemanticDupeResult {
    return { hard, soft, thresholds: { hard: 0.93, soft: 0.8 } };
  }

  /** A candidate the guard scored. `title`/`state`/`harness` are the guard's own
   *  columns; the fold path re-reads the row via getIssue, so only `id` and the
   *  scores steer the decision. */
  function scored(similarity: number, titleSimilarity?: number): SemanticDupeResult['hard'][number] {
    return {
      id: PRIOR_ID,
      title: 'from the vector index',
      state: 'open',
      harness: null,
      similarity,
      ...(typeof titleSimilarity === 'number' ? { titleSimilarity } : {}),
    };
  }

  function foldDeps(opts: {
    sem?: SemanticDupeResult | null;
    prior?: EngineerIssue | null;
    mergeFails?: boolean;
    linkFails?: boolean;
  }): CaptureDeps & {
    created: CreateIssueInput[];
    occurrences: RecordIssueOccurrenceInput[];
    merges: { id: string; patch: Record<string, unknown> }[];
    links: { src: string; dst: string; rel: string }[];
    patched: string[];
    semanticQueries: Array<{ title: string; summary?: string; harness?: string }>;
  } {
    const base = deps();
    const merges: { id: string; patch: Record<string, unknown> }[] = [];
    const links: { src: string; dst: string; rel: string }[] = [];
    const patched: string[] = [];
    const semanticQueries: Array<{ title: string; summary?: string; harness?: string }> = [];
    const prior = opts.prior === undefined ? priorObservation() : opts.prior;
    return {
      ...base,
      merges,
      links,
      patched,
      semanticQueries,
      findSemanticDupes: async (query) => {
        semanticQueries.push(query);
        return opts.sem === undefined ? semantic([scored(0.88, 0.62)]) : opts.sem;
      },
      getIssue: async (id: string) => (prior && id === prior.id ? prior : null),
      mergeIssuePayload: async (id, patch) => {
        merges.push({ id, patch });
        if (opts.mergeFails) return null;
        const before = ((prior?.payload as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        return existing({
          ...(prior ?? {}),
          id,
          title: prior?.title ?? 'survivor',
          payload: { ...before, ...patch },
        });
      },
      // The derived fold must NEVER call this: rewriting the survivor's text on
      // an INFERRED match is the over-merge D-042 warns about. Recording the
      // call (rather than throwing) lets the assertion name the violation.
      updateIssuePatch: async (id) => {
        patched.push(id);
        return prior;
      },
      linkIssues: async (src, dst, rel) => {
        if (opts.linkFails) throw new Error('link write failed');
        links.push({ src, dst, rel });
      },
    };
  }

  /** The same observation, filed by a second agent. Shares the backticked
   *  subject `coord:send` with the prior row, so the D-036 discriminator finds
   *  the subjects AGREE and does not demote. */
  const repeatFiling = {
    title: '`coord:send` refuses an oversized body and never says what the limit is',
    kind: 'change' as const,
    lane: 'observation' as const,
    createdBy: 'su-second-reporter',
  };

  it('passes harness scope to semantic search before the derived-fold query limits candidates', async () => {
    setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
    const d = foldDeps({ sem: null, prior: priorObservation({ scope: 'harness:papercusp' }) });

    await captureImprovement({ ...repeatFiling, scope: 'harness:papercusp' }, d);

    expect(d.semanticQueries).toEqual([{ title: repeatFiling.title, harness: 'papercusp' }]);
  });

  describe('HARD verdict — two agents, one row', () => {
    it('folds onto the survivor: no new row, repeatCount 2, BOTH reporters recorded', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      const res = await captureImprovement(repeatFiling, d);

      expect(res.ok).toBe(true); // D-003: the filing always lands
      expect(res.created).toBe(false);
      expect(res.reason).toBe('coalesced');
      expect(d.created).toHaveLength(0); // the whole point: no second row
      expect(d.merges).toHaveLength(1);
      expect(d.merges[0].id).toBe(PRIOR_ID);
      expect(d.merges[0].patch).toMatchObject({
        repeatCount: 2,
        reporters: ['su-first-reporter', 'su-second-reporter'],
      });
    });

    it('reports the fold as DERIVED identity and append-only text — not a keyed fold, not a write loss', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      const res = await captureImprovement(repeatFiling, d);

      expect(res.coalescedOnto).toMatchObject({
        id: PRIOR_ID,
        repeatCount: 2,
        identity: 'derived',
        textDisposition: 'append-only',
        foldRule: 'co-signal',
        similarity: 0.88,
        crossAuthor: true,
        priorAuthor: 'su-first-reporter',
      });
      // append-only is a POLICY, so it must not be reported with the
      // write-loss marker the keyed path uses when a refresh actually failed.
      expect(res.coalescedOnto?.bodyDiscarded).toBeUndefined();
    });

    it('REGRESSION: the note never renders a literal "conditionKey `undefined`" (there is no key on this path)', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      const res = await captureImprovement(repeatFiling, d);

      expect(res.coalescedOnto?.note).not.toContain('undefined');
      expect(res.coalescedOnto?.note).toContain('derived identity');
    });

    it("appends the reading to the occurrence ledger as 'coalesced' with the second agent as reporter", async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      await captureImprovement(repeatFiling, d);

      expect(d.occurrences).toHaveLength(1);
      expect(d.occurrences[0]).toMatchObject({
        canonicalId: PRIOR_ID,
        reportKind: 'coalesced',
        reporter: 'su-second-reporter',
        reportedTitle: repeatFiling.title,
      });
    });

    it("leaves the survivor's own title/body ALONE — an inferred match must not overwrite another agent's account", async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      await captureImprovement(repeatFiling, d);

      expect(d.patched).toEqual([]); // updateIssuePatch never called
    });

    it('NEVER REJECTS: a failed merge falls through to a normal mint instead of erroring', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({ mergeFails: true });

      const res = await captureImprovement(repeatFiling, d);

      expect(res.ok).toBe(true);
      expect(res.created).toBe(true);
      expect(d.created).toHaveLength(1);
    });

    it.each(['null', 'throw'] as const)(
      'mints the incoming report when occurrence recording %s',
      async (failure) => {
        setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
        try {
          const d = foldDeps({});
          const recordIssueOccurrence = vi.fn(async (_input: RecordIssueOccurrenceInput) => {
            if (failure === 'throw') throw new Error('occurrence insert failed');
            return null;
          });
          d.recordIssueOccurrence = recordIssueOccurrence;
          const report = {
            ...repeatFiling,
            body: 'The complete second report exists only in its occurrence record before this fallback.',
          };

          const res = await captureImprovement(report, d);

          expect(res).toMatchObject({ ok: true, created: true, issue: { id: 'EI-100' } });
          expect(d.created).toHaveLength(1);
          expect(d.created[0]).toMatchObject({
            title: report.title,
            body: report.body,
            payload: expect.objectContaining({ lane: 'observation' }),
          });
          expect(d.merges).toHaveLength(1);
          expect(recordIssueOccurrence.mock.calls.map(([call]) => call.reportKind)).toEqual([
            'coalesced',
            'canonical-created',
          ]);
        } finally {
          setFlagOverridesForTest(null);
        }
      },
    );
  });

  describe('SOFT verdict — both rows survive, linked', () => {
    it('mints the row AND writes a `relates` edge to the similar one', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      // 0.91: above the soft floor, below pure-cosine, and no title score, so
      // the co-signal cannot fire — the soft-band rule.
      const d = foldDeps({ sem: semantic([], [scored(0.91)]) });

      const res = await captureImprovement(repeatFiling, d);

      expect(res.created).toBe(true);
      expect(d.created).toHaveLength(1);
      expect(d.merges).toHaveLength(0);
      expect(res.linkedTo).toMatchObject({
        id: PRIOR_ID,
        rule: 'soft-band',
        similarity: 0.91,
        linkWritten: true,
      });
      expect(d.links).toEqual([{ src: 'EI-100', dst: PRIOR_ID, rel: 'relates' }]);
    });

    it('a link-write failure is REPORTED, never fatal — the filing still lands', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({ sem: semantic([], [scored(0.91)]), linkFails: true });

      const res = await captureImprovement(repeatFiling, d);

      expect(res.ok).toBe(true);
      expect(res.created).toBe(true);
      expect(res.linkedTo?.linkWritten).toBe(false);
      expect(res.linkedTo?.note).toContain('could NOT be written');
    });

    it('D-036 over-merge guard, end to end: same template, DIFFERENT subjects → links instead of folding', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      // Co-signal scores that WOULD fold, against a row naming a different tool.
      const d = foldDeps({
        sem: semantic([scored(0.88, 0.62)]),
        prior: priorObservation({
          title: '`locks:acquire` rejects a body over the size cap without naming the cap',
        }),
      });

      const res = await captureImprovement(repeatFiling, d);

      expect(res.created).toBe(true); // NOT folded
      expect(d.merges).toHaveLength(0);
      expect(res.linkedTo?.rule).toBe('discriminator-demoted');
    });
  });

  describe('the retrieval filter — which rows are eligible to be folded onto', () => {
    const cases: { why: string; prior: EngineerIssue | null }[] = [
      {
        why: 'a KEYED row (a machine emitter’s standing condition) is never rewritten by an inferred match',
        prior: priorObservation({
          payload: { lane: 'observation', repeatCount: 1, watchdogKey: 'condition:some-machine-key' },
        }),
      },
      { why: 'a CLOSED row does not absorb a fresh report', prior: priorObservation({ state: 'resolved' }) },
      {
        why: 'an improvement-lane row is not an observation',
        prior: priorObservation({ payload: { lane: 'improvement' } }),
      },
      {
        why: 'a different signalOrigin (a drill row must never suppress an organic filing)',
        prior: priorObservation({ signalOrigin: 'drill' }),
      },
      {
        why: 'a different Pot scope',
        prior: priorObservation({ scope: 'harness:some-other-pot' }),
      },
      { why: 'the scored candidate no longer resolves', prior: null },
    ];

    for (const { why, prior } of cases) {
      it(`mints instead of folding: ${why}`, async () => {
        setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
        const d = foldDeps({ prior });

        const res = await captureImprovement(repeatFiling, d);

        expect(res.created).toBe(true);
        expect(d.created).toHaveLength(1);
        expect(d.merges).toHaveLength(0);
        expect(res.linkedTo).toBeUndefined();
      });
    }
  });

  describe('fail-open paths — no verdict is NOT a verdict of none', () => {
    it('flag OFF: today’s behaviour exactly — mint, no fold, no link', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: false });
      const d = foldDeps({});

      const res = await captureImprovement(repeatFiling, d);

      expect(res.created).toBe(true);
      expect(d.created).toHaveLength(1);
      expect(d.merges).toHaveLength(0);
      expect(res.linkedTo).toBeUndefined();
    });

    it('embedder unavailable (null verdict): mints, and does not consult the fold decider at all', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({ sem: null });

      const res = await captureImprovement(repeatFiling, d);

      expect(res.created).toBe(true);
      expect(d.merges).toHaveLength(0);
    });

    it('a KEYED capture still takes the conditionKey path, not the derived one', async () => {
      setFlagOverridesForTest({ [FLAGS.OBSERVATION_DERIVED_FOLD]: true });
      const d = foldDeps({});

      const res = await captureImprovement({ ...repeatFiling, watchdogKey: 'condition:explicitly-keyed' }, d);

      // No keyed row exists to coalesce onto here, so it mints — the point is
      // that the DERIVED branch never ran (no merge, no link) for a keyed filing.
      expect(res.created).toBe(true);
      expect(d.merges).toHaveLength(0);
      expect(res.linkedTo).toBeUndefined();
    });
  });
});

describe('P-001 dedupCandidates payload stamp (silent-intake-central-resolution-2026-09-01)', () => {
  // D-001/D-003: file-time detection is persisted FOR THE RESOLVER on the created row
  // (payload.dedupCandidates: id + similarity + method), never surfaced to the filer.
  // Previously possibleDuplicates was computed, returned, and discarded (observed live
  // on EI-22068807981214694: 5 twins in the response, none on the row).

  it('a force-created capture persists its lexical twins as payload.dedupCandidates', async () => {
    const twin = existing({ id: 'EI-twin', title: 'exact same friction title' });
    const d = deps({ found: [twin] });
    const res = await captureImprovement({ title: 'exact same friction title', kind: 'bug', force: true }, d);
    expect(res).toMatchObject({ ok: true, created: true });
    const payload = d.created[0].payload as Record<string, unknown>;
    expect(payload.dedupCandidates).toEqual([{ id: 'EI-twin', similarity: 1, method: 'lexical' }]);
    // The coverage verdict (EI-20275452450016416) still rides beside the candidates.
    expect(payload.dedupCoverage).toBeDefined();
  });

  it('an advisory containment hit is stamped method containment — no force needed', async () => {
    // titleContainment returns 0 below CONTAINMENT_MIN_TOKENS, so the short side
    // carries enough distinctive tokens to clear the floor.
    const shortTitle = 'alpha beta gamma delta epsilon zeta';
    const longTitle =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';
    // Preconditions: below the lexical blocking net, inside the containment net.
    expect(titleSimilarity(shortTitle, longTitle)).toBeLessThan(DUP_THRESHOLD);
    expect(titleContainment(shortTitle, longTitle)).toBeGreaterThanOrEqual(CONTAINMENT_THRESHOLD);
    const d = deps({ found: [existing({ id: 'EI-broad', title: longTitle })] });
    const res = await captureImprovement({ title: shortTitle, kind: 'bug' }, d);
    expect(res).toMatchObject({ ok: true, created: true });
    const payload = d.created[0].payload as Record<string, unknown>;
    expect(payload.dedupCandidates).toEqual([
      {
        id: 'EI-broad',
        similarity: Math.round(titleContainment(shortTitle, longTitle) * 100) / 100,
        method: 'containment',
      },
    ]);
  });

  it('a net-new semantic soft hit is stamped semantic-soft with its cosine', async () => {
    const prior = existing({
      id: 'EI-sem',
      title: 'completely different wording of the same underlying friction',
    });
    const d = deps({ found: [prior] });
    d.findSemanticDupes = async () => ({
      hard: [],
      soft: [{ id: prior.id, title: prior.title, state: prior.state, harness: null, similarity: 0.87 }],
      thresholds: { hard: 0.93, soft: 0.8 },
    });
    const res = await captureImprovement({ title: 'my freshly worded filing about a recurring thing', kind: 'bug' }, d);
    expect(res).toMatchObject({ ok: true, created: true });
    const payload = d.created[0].payload as Record<string, unknown>;
    expect(payload.dedupCandidates).toEqual([{ id: 'EI-sem', similarity: 0.87, method: 'semantic-soft' }]);
  });

  it('no candidates ⇒ no dedupCandidates key — dedupCoverage alone says "checked clean"', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'entirely novel friction nobody filed', kind: 'bug' }, d);
    expect(res).toMatchObject({ ok: true, created: true });
    const payload = d.created[0].payload as Record<string, unknown>;
    expect(payload.dedupCoverage).toBeDefined();
    expect(payload.dedupCandidates).toBeUndefined();
  });

  it('observations never carry the stamp — they skip dedup entirely (D-005)', async () => {
    const d = deps({ found: [existing({ id: 'EI-x', title: 'plain observation' })] });
    await captureImprovement({ title: 'plain observation', kind: 'change', lane: 'observation' }, d);
    const payload = d.created[0].payload as Record<string, unknown> | undefined;
    expect(payload?.dedupCandidates).toBeUndefined();
  });
});

// ─── P-004 (silent-intake-central-resolution-2026-09-01): detector recurrence fold ───

/** Stateful fixture shared by the two P-004 blocks: rows live in `store`, the
 *  lifecycle writer actually flips state, and every seam records its calls so the
 *  assertions exercise what the write DID, not what the return value claimed. */
function recurrenceDeps(seed: EngineerIssue[] = []): CaptureDeps & {
  created: CreateIssueInput[];
  store: EngineerIssue[];
  occurrences: RecordIssueOccurrenceInput[];
  stateWrites: { id: string; state: string }[];
} {
  const created: CreateIssueInput[] = [];
  const store: EngineerIssue[] = [...seed];
  const occurrences: RecordIssueOccurrenceInput[] = [];
  const stateWrites: { id: string; state: string }[] = [];
  let nextId = 700;
  return {
    created,
    store,
    occurrences,
    stateWrites,
    recordIssueOccurrence: async (input) => {
      occurrences.push(input);
      return null;
    },
    searchIssues: async (query) => {
      void query;
      return store;
    },
    createIssue: async (input) => {
      created.push(input);
      const issue = existing({
        id: `EI-${nextId++}`,
        title: input.title,
        kind: (input.kind as 'bug' | 'change') ?? 'bug',
        payload: input.payload ?? null,
      });
      store.push(issue);
      return issue;
    },
    findIssuesByWatchdogKeys: async (keys) =>
      store.filter((i) => {
        const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
        return typeof k === 'string' && keys.includes(k);
      }),
    mergeIssuePayload: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
      return i;
    },
    updateIssuePatch: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      if (patch.title !== undefined) i.title = patch.title;
      if (patch.body !== undefined) i.body = patch.body;
      return i;
    },
    setWorkItemStateWithAliasInfo: async (id, requestedState) => {
      stateWrites.push({ id, state: requestedState });
      const i = store.find((x) => x.id === id);
      if (i) i.state = requestedState as EngineerIssue['state'];
      return {
        workItem: i ? { id, state: requestedState } : null,
        requestedState,
        appliedState: i ? requestedState : null,
      };
    },
  };
}

describe('captureImprovement — exact-key recurrence REOPENS a watchdog-auto-resolved row (P-004)', () => {
  const KEY = 'tool-failure:release:checkpoint-run:wait_for_eligibility';
  const TITLE = 'release:checkpoint-run wait_for_eligibility unavailable';

  /** The EI-22065259669472144 shape: resolved by the watchdog auto-close (which
   *  stamps terminalOwner='watchdog-auto-close' via setIssueState), key intact. */
  function autoResolvedRow(p: Partial<EngineerIssue> = {}): EngineerIssue {
    return existing({
      id: 'EI-800',
      title: TITLE,
      state: 'resolved',
      terminalOwner: 'watchdog-auto-close',
      updatedAt: '2026-08-30T12:00:00Z',
      payload: { watchdogKey: KEY, repeatCount: 3 },
      ...p,
    });
  }

  it('recurrence with fresh evidence REOPENS the canonical row — no sibling minted (EI-22065259669472144)', async () => {
    const d = recurrenceDeps([autoResolvedRow()]);
    const res = await captureImprovement({ title: TITLE, kind: 'bug', dedupScope: 'open', watchdogKey: KEY }, d);
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.coalescedOnto?.reopened).toBe(true);
    expect(res.coalescedOnto?.identity).toBe('condition-key');
    expect(d.created).toHaveLength(0);
    expect(d.stateWrites).toEqual([{ id: 'EI-800', state: 'open' }]);
    expect(d.store[0].state).toBe('open');
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(4);
    expect(d.occurrences).toHaveLength(1);
    expect(d.occurrences[0].reportKind).toBe('coalesced');
    expect(res.issue?.id).toBe('EI-800');
  });

  it('STALE evidence does not reopen — the resolved row stands and the filing mints with dedupVerdict stale-evidence', async () => {
    const d = recurrenceDeps([autoResolvedRow()]);
    const res = await captureImprovement(
      {
        title: TITLE,
        kind: 'bug',
        dedupScope: 'open',
        // Pre-dates the row's resolution (updatedAt 2026-08-30): collector lookback junk.
        evidenceAt: '2026-08-29T00:00:00Z',
        watchdogKey: KEY,
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.stateWrites).toHaveLength(0);
    expect(d.store[0].state).toBe('resolved');
    expect((d.created[0].payload as Record<string, unknown>).dedupVerdict).toBe('stale-evidence');
  });

  it('CONTROL: an agent-resolved row (terminalOwner ≠ watchdog-auto-close) is NOT reopened — regression re-file mints', async () => {
    const d = recurrenceDeps([autoResolvedRow({ terminalOwner: 'su-a-real-agent' })]);
    const res = await captureImprovement({ title: TITLE, kind: 'bug', dedupScope: 'open', watchdogKey: KEY }, d);
    expect(res.created).toBe(true);
    expect(d.stateWrites).toHaveLength(0);
    expect(d.store[0].state).toBe('resolved');
  });

  it('reopen writer failure falls through to the mint — the capture is never lost', async () => {
    const d = recurrenceDeps([autoResolvedRow()]);
    d.setWorkItemStateWithAliasInfo = async () => {
      throw new Error('pg down');
    };
    const res = await captureImprovement({ title: TITLE, kind: 'bug', dedupScope: 'open', watchdogKey: KEY }, d);
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(d.store[0].state).toBe('resolved');
  });

  it('an OPEN keyed row still wins over the resolved one — WI-39594 coalesce, no reopen call', async () => {
    const open = existing({ id: 'EI-801', title: TITLE, state: 'open', payload: { watchdogKey: KEY } });
    const d = recurrenceDeps([autoResolvedRow(), open]);
    const res = await captureImprovement({ title: TITLE, kind: 'bug', dedupScope: 'open', watchdogKey: KEY }, d);
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.issue?.id).toBe('EI-801');
    expect(res.coalescedOnto?.reopened).toBeUndefined();
    expect(d.stateWrites).toHaveLength(0);
  });
});

describe('captureImprovement — keyless non-observation bug folds onto its open exact-titleKey twin (P-004 / EI-22068807981214694)', () => {
  const CANARY_TITLE = 'coord probe-pair canary breached its cycle SLO';

  it('a keyless system filing coalesces onto the open identical-title twin — ONE open row, occurrence appended', async () => {
    const twin = existing({ id: 'EI-900', title: CANARY_TITLE, payload: { repeatCount: 9 } });
    const d = recurrenceDeps([twin]);
    const res = await captureImprovement(
      {
        title: CANARY_TITLE,
        kind: 'bug',
        dedupScope: 'open',
        foundDuring: 'system:coord-probe-canary',
        body: 'latest breach forensics',
      },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.coalescedOnto?.identity).toBe('title-key');
    expect(res.issue?.id).toBe('EI-900');
    expect(d.created).toHaveLength(0);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(10);
    expect(d.store[0].body).toBe('latest breach forensics');
    expect(d.occurrences).toHaveLength(1);
    expect(d.occurrences[0].reportKind).toBe('coalesced');
  });

  it('an ordinary keyless filing coalesces even when semantic dedup is unavailable', async () => {
    const twin = existing({ id: 'EI-901', title: CANARY_TITLE });
    const d = { ...recurrenceDeps([twin]), findSemanticDupes: async () => null };
    const res = await captureImprovement({ title: CANARY_TITLE, kind: 'bug' }, d);
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.coalescedOnto).toMatchObject({ id: 'EI-901', identity: 'title-key', repeatCount: 2 });
    expect(res.coalescedOnto?.note).toContain('no conditionKey supplied');
    expect(res.coalescedOnto?.note).not.toContain('system filer');
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(d.created).toHaveLength(0);
  });

  it('CONTROL: a DIFFERENT titleKey mints — the fold is exact normalized-title identity, not similarity', async () => {
    const twin = existing({ id: 'EI-902', title: CANARY_TITLE });
    const d = { ...recurrenceDeps([twin]), findSemanticDupes: async () => null };
    const res = await captureImprovement(
      {
        title: "coord probe-pair canary failed at 'sendMessage'",
        kind: 'bug',
        dedupScope: 'open',
      },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('CONTROL: force:true skips the fold — the caller asserted distinctness', async () => {
    const twin = existing({ id: 'EI-903', title: CANARY_TITLE });
    const d = { ...recurrenceDeps([twin]), findSemanticDupes: async () => null };
    const res = await captureImprovement(
      {
        title: CANARY_TITLE,
        kind: 'bug',
        force: true,
      },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('force:true keyless captures omit admissionIdentity so the title arbiter preserves distinctness', async () => {
    const d = { ...recurrenceDeps(), findSemanticDupes: async () => null };
    const first = await captureImprovement({ title: CANARY_TITLE, kind: 'bug', force: true }, d);
    const second = await captureImprovement({ title: CANARY_TITLE, kind: 'bug', force: true }, d);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: true });
    expect(first.admissionIdentity).toBeUndefined();
    expect(second.admissionIdentity).toBeUndefined();
    expect(d.created).toHaveLength(2);
    for (const created of d.created) expect(created.payload).not.toHaveProperty('admissionIdentity');
  });

  it('migration 1157 recovers a concurrent same-title INSERT conflict by coalescing the exact winner', async () => {
    const attempts: CreateIssueInput[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    const TITLE = 'operator MCP admission sheds requests during grading fan-out';
    let lookupCount = 0;
    let releaseInitialLookups!: () => void;
    const initialLookups = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });
    let winner: EngineerIssue | null = null;
    const d: CaptureDeps & { store: EngineerIssue[]; occurrences: RecordIssueOccurrenceInput[] } = {
      store: [],
      occurrences,
      searchIssues: async () => {
        lookupCount += 1;
        if (lookupCount <= 2) {
          if (lookupCount === 2) releaseInitialLookups();
          await initialLookups;
          return [];
        }
        return winner ? [winner] : [];
      },
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      createIssue: async (input) => {
        attempts.push(input);
        if (winner) {
          throw {
            code: '23505',
            constraint_name: 'work_items_keyless_title_identity_uq',
            message: 'duplicate key value violates unique constraint "work_items_keyless_title_identity_uq"',
          };
        }
        winner = existing({
          id: 'EI-TITLE-RACE-WINNER',
          title: input.title,
          scope: input.scope ?? 'operator',
          payload: input.payload as Record<string, unknown>,
        });
        d.store.push(winner);
        return winner;
      },
      mergeIssuePayload: async (_id, patch) => {
        if (!winner) return null;
        winner.payload = { ...(winner.payload as Record<string, unknown> | null), ...patch };
        return winner;
      },
      updateIssuePatch: async (_id, patch) => {
        if (!winner) return null;
        if (patch.title !== undefined) winner.title = patch.title;
        if (patch.body !== undefined) winner.body = patch.body;
        return winner;
      },
    };

    const [left, right] = await Promise.all([
      captureImprovement({ title: TITLE, kind: 'bug', scope: 'harness:papercusp' }, d),
      captureImprovement({ title: TITLE, kind: 'bug', scope: 'harness:papercusp' }, d),
    ]);
    const results = [left, right];

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'coalesced')).toHaveLength(1);
    expect(results.find((result) => result.reason === 'coalesced')?.coalescedOnto).toMatchObject({
      id: 'EI-TITLE-RACE-WINNER',
      identity: 'title-key',
      repeatCount: 2,
    });
    expect(attempts).toHaveLength(2);
    expect(d.store).toHaveLength(1);
    const winningIssue = winner!;
    expect((winningIssue.payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(occurrences.map((row) => row.reportKind).sort()).toEqual(['canonical-created', 'coalesced']);
  });

  it.each([
    ['titleKey', { payload: { admissionIdentity: { schemaVersion: 'admission-identity-v1', titleKey: 'title:other' } } }],
    ['scope', { scope: 'harness:other-pot' }],
    ['lane', { payload: { lane: 'observation' } }],
    ['terminal', { state: 'done' }],
  ] as const)('does not coalesce a named title-index conflict with a mismatched %s winner', async (_dimension, mismatch) => {
    const TITLE = 'keyless title winner must match every identity component';
    const identity = { schemaVersion: 'admission-identity-v1' as const, titleKey: 'title:component every identity keyless match must title winner' };
    const winner = existing({
      id: `EI-TITLE-MISMATCH-${_dimension}`,
      title: TITLE,
      scope: 'harness:papercusp',
      payload: {
        admissionIdentity: identity,
        ...('payload' in mismatch ? mismatch.payload : {}),
      },
      ...('scope' in mismatch ? { scope: mismatch.scope } : {}),
      ...('state' in mismatch ? { state: mismatch.state } : {}),
    });
    let lookupCount = 0;
    const d: CaptureDeps = {
      searchIssues: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? [] : [winner];
      },
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      createIssue: async () => {
        throw {
          code: '23505',
          constraint_name: 'work_items_keyless_title_identity_uq',
          message: 'duplicate key value violates unique constraint "work_items_keyless_title_identity_uq"',
        };
      },
      mergeIssuePayload: async () => {
        throw new Error('must not merge a mismatched title identity winner');
      },
    };

    await expect(
      captureImprovement({ title: TITLE, kind: 'bug', scope: 'harness:papercusp' }, d),
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'work_items_keyless_title_identity_uq' });
  });

  it('does not swallow a different unique violation as a keyless title race', async () => {
    const d: CaptureDeps = {
      searchIssues: async () => [],
      findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      createIssue: async () => {
        throw {
          code: '23505',
          constraint_name: 'work_items_condition_key_uq',
          message: 'duplicate key value violates unique constraint "work_items_condition_key_uq"',
        };
      },
    };

    await expect(
      captureImprovement({ title: 'unrelated keyless unique failure', kind: 'bug' }, d),
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'work_items_condition_key_uq' });
  });

  it('CONTROL: a RESOLVED twin does not absorb the filing — the fold is open-rows-only', async () => {
    const twin = existing({ id: 'EI-904', title: CANARY_TITLE, state: 'resolved' });
    const d = { ...recurrenceDeps([twin]), findSemanticDupes: async () => null };
    const res = await captureImprovement(
      {
        title: CANARY_TITLE,
        kind: 'bug',
        dedupScope: 'open',
      },
      d,
    );
    expect(res.created).toBe(true);
  });
});

/**
 * WI-2140701 (b) — goal provenance through the CAPTURE door.
 *
 * Until this leg existed every row minted through improvements:capture carried
 * goal_id NULL (only work_items:create stamped), so a goal steward's own filings
 * were invisible to its goal's "what belongs to me" view and spend rollup. The
 * stamp itself is verified against real SQL in
 * agent-tools/work_items/goal-provenance-stamp.integration.test.ts; THIS pins the
 * seam: when it is called, with what identity, and that a throw is recorded
 * rather than raised.
 */
describe('captureImprovement — goal provenance stamp (WI-2140701 (b))', () => {
  type StampCall = { item: { id: string; harness?: string | null }; workspaceId: string; ownerId: string };
  function stamping(impl: (call: StampCall) => Promise<string | null>, opts: Parameters<typeof deps>[0] = {}) {
    const calls: StampCall[] = [];
    const d = deps(opts);
    d.stampGoalProvenance = async (item, workspaceId, ownerId) => {
      const call = { item, workspaceId, ownerId };
      calls.push(call);
      return impl(call);
    };
    return { d, calls };
  }

  it('stamps a freshly-minted row with the creator goal and surfaces goalId on the result', async () => {
    const { d, calls } = stamping(async () => 'work-on-everything-070565');
    const res = await captureImprovement(
      {
        title: 'Goal steward finding: drain fleet dead',
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-holder',
        workspaceId: 'papercusp-workspace',
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.goalId).toBe('work-on-everything-070565');
    expect(res.goalStampError).toBeUndefined();
    expect(calls).toEqual([
      {
        item: { id: 'EI-100', harness: 'papercusp' },
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-holder',
      },
    ]);
  });

  it('passes a null harness for an operator-scope row (the stamp keys on workspace instead)', async () => {
    const { d, calls } = stamping(async () => null);
    const res = await captureImprovement(
      { title: 'Operator-scope finding', kind: 'change', scope: 'operator', createdBy: 'su-x', workspaceId: 'ws' },
      d,
    );
    expect(res.created).toBe(true);
    // A creator under no goal: the stamp declined, and the result carries neither field.
    expect(res.goalId).toBeUndefined();
    expect(res.goalStampError).toBeUndefined();
    expect(calls[0]?.item).toEqual({ id: 'EI-100', harness: null });
  });

  it('RECORDS a stamp failure on the result (and warns) — never fails the capture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { d } = stamping(async () => {
        throw new Error('column "goal_id" does not exist');
      });
      const res = await captureImprovement(
        { title: 'Finding under a broken stamp', kind: 'bug', createdBy: 'su-x', workspaceId: 'ws' },
        d,
      );
      expect(res.ok).toBe(true);
      expect(res.created).toBe(true);
      expect(res.goalId).toBeUndefined();
      expect(res.goalStampError).toBe('column "goal_id" does not exist');
      // EI-20075667133396690: a stamp that THREW must be distinguishable from one that
      // DECLINED — the warning is the operator-visible half of that distinction.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('goal provenance stamp failed for EI-100');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips the stamp — no call at all — without a concrete workspace or a creator', async () => {
    const noWorkspace = stamping(async () => 'g');
    await captureImprovement({ title: 'No workspace', kind: 'bug', createdBy: 'su-x' }, noWorkspace.d);
    expect(noWorkspace.calls).toEqual([]);

    const noCreator = stamping(async () => 'g');
    await captureImprovement({ title: 'No creator', kind: 'bug', workspaceId: 'ws' }, noCreator.d);
    expect(noCreator.calls).toEqual([]);
  });

  it('never stamps a PROMOTED prior row — a re-capture by a goal agent cannot re-home it', async () => {
    // Same fixture shape as the P-013 probation promotion above: a second independent
    // reporter promotes the prior observation IN PLACE, so no row is minted.
    const key = 'repeated-tool-error:coord:send:caller:invalid-args-body-must-be';
    const probation = (reporter: string) => ({
      state: 'probation' as const,
      class: 'caller',
      watchdogKey: key,
      correlationFingerprint: 'coord:send|invalid_args|42|body|codex-1.2|invalid-args-body-must-be',
      intendedKind: 'change' as const,
      reporters: [reporter],
    });
    const prior = existing({
      id: 'EI-PROBATION',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      severity: 'nit',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const { d, calls } = stamping(async () => 'work-on-everything-070565');
    d.findIssuesByWatchdogKeys = async () => [prior];
    d.updateIssuePatch = async (_id, patch) => existing({ ...prior, ...patch });
    d.mergeIssuePayload = async (_id, patch, opts) => {
      const payload = { ...(prior.payload as Record<string, unknown>), ...patch };
      for (const k of opts?.unset ?? []) delete payload[k];
      return existing({ ...prior, kind: 'change', severity: 'minor', payload });
    };
    d.tagIssue = async () => {};
    d.untagIssue = async () => {};
    const res = await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        lane: 'observation',
        watchdogKey: key,
        createdBy: 'su-goal-agent',
        workspaceId: 'ws',
        payloadExtra: { toolFailureProbation: probation('su-goal-agent') },
      },
      d,
    );
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(res.goalId).toBeUndefined();
  });
});

describe('captureToolInvocationFriction — one row per signature (review-system-rework-reduction D-010)', () => {
  /** A stateful issue store: every capture reads what the previous one wrote. */
  function signatureStore() {
    const rows: EngineerIssue[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    const emitted: Parameters<NonNullable<CaptureDeps['emitAwaitedEvent']>>[0][] = [];
    const payloadOf = (row: EngineerIssue) => (row.payload as Record<string, any>) ?? {};
    const d: CaptureDeps = {
      // WI-6554700010008444: a new reporter fires an awaited event; never reach the real engine.
      emitAwaitedEvent: async (opts) => { emitted.push(opts); return {}; },
      searchIssues: async () => [],
      recordIssueOccurrence: async (input) => { occurrences.push(input); return null; },
      resolvePotScope: async ({ rawSlug }) => rawSlug,
      findIssuesByWatchdogKeys: async (keys) => rows.filter((row) => keys.includes(payloadOf(row).watchdogKey)),
      findIssuesByToolFailureClassKeys: async (keys) =>
        rows.filter((row) => keys.includes(payloadOf(row).toolFailureProbation?.classKey)),
      createIssue: async (input) => {
        const row = existing({ id: `EI-S${rows.length + 1}`, title: input.title,
          kind: (input.kind as 'bug' | 'change') ?? 'bug', scope: input.scope ?? 'operator',
          payload: structuredClone(input.payload ?? {}) as EngineerIssue['payload'] });
        rows.push(row);
        return row;
      },
      mergeIssuePayload: async (id, patch, opts) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return null;
        const next: Record<string, unknown> = { ...payloadOf(row), ...structuredClone(patch) };
        for (const key of opts?.unset ?? []) delete next[key];
        row.payload = next as EngineerIssue['payload'];
        return row;
      },
      updateIssuePatch: async (id, patch) => {
        const row = rows.find((r) => r.id === id);
        return row ? Object.assign(row, patch) : null;
      },
      tagIssue: async () => {},
      untagIssue: async () => {},
    };
    const capture = (ownerId: string, runtimeVersion: string, failure: Partial<SuspectedToolFailure> = {}) =>
      captureToolInvocationFriction({
        workspaceId: 'ws', harnessSlug: 'papercusp', ownerId, invokedAt: '2026-09-23T12:00:00Z',
        failure: { ...metadataToolFailure, runtimeVersion, ...failure },
      }, d);
    return { rows, occurrences, emitted, capture, payloadOf };
  }
  const SIGNATURE = 'tool-failure-signature:coord:send:caller:invalid_args:body';

  it('WI-6554700010008444: a reporter new to the row stamps evidenceAdvancedAt and fires the reporter key once', async () => {
    const store = signatureStore();
    await store.capture('su-a', 'build-1');
    expect(store.emitted).toHaveLength(0);
    expect(store.payloadOf(store.rows[0]).evidenceAdvancedAt).toBeUndefined();
    // su-b reports the signature from another build: a counted occurrence, not a promotion.
    const counted = await store.capture('su-b', 'build-2');
    expect(counted).toMatchObject({ created: false, reason: 'coalesced', issue: { id: 'EI-S1' } });
    expect(store.emitted).toEqual([expect.objectContaining({
      key: 'work-item:tool-failure-reporter:EI-S1', workspaceId: 'ws',
      payload: expect.objectContaining({ id: 'EI-S1', reporter: 'su-b' }),
    })]);
    const epoch = store.payloadOf(store.rows[0]).evidenceAdvancedAt;
    expect(typeof epoch).toBe('string');
    // Neither su-b repeating nor the original reporter su-a is new evidence.
    await store.capture('su-b', 'build-2');
    await store.capture('su-a', 'build-1');
    expect(store.rows).toHaveLength(1);
    expect(store.emitted).toHaveLength(1);
    expect(store.payloadOf(store.rows[0]).evidenceAdvancedAt).toBe(epoch);
  });

  it('P-023: 100 identical refusals across two builds produce ONE row whose count is 100', async () => {
    const store = signatureStore();
    for (let i = 0; i < 100; i++) await store.capture('su-a', i < 50 ? 'build-1' : 'build-2');
    expect(store.rows).toHaveLength(1);
    const payload = store.payloadOf(store.rows[0]);
    expect(payload.repeatCount).toBe(100);
    expect(payload.watchdogKey).toBe(SIGNATURE);
    const classes = Object.values(payload.toolFailureSignature.classes) as Array<{ count: number }>;
    expect(classes.map((c) => c.count)).toEqual([50, 50]);
    // One reporter never corroborates, whichever build it reports from.
    expect(payload.lane).toBe('observation');
    expect(payload.toolFailureProbation).toMatchObject({ state: 'probation', reporters: ['su-a'],
      deployedRevision: 'build-1' });
    // Every filing leaves an occurrence, the first one included.
    expect(store.occurrences).toHaveLength(100);
    expect(new Set(store.occurrences.map((o) => o.canonicalId))).toEqual(new Set(['EI-S1']));
  });

  it('a report on another build counts onto the row but neither corroborates nor rewrites it', async () => {
    const store = signatureStore();
    await store.capture('su-a', 'build-1');
    const before = structuredClone(store.payloadOf(store.rows[0]).toolFailureProbation);
    const result = await store.capture('su-b', 'build-2');
    expect(result).toMatchObject({ created: false, reason: 'coalesced', issue: { id: 'EI-S1' } });
    expect(store.rows).toHaveLength(1);
    const payload = store.payloadOf(store.rows[0]);
    expect(payload.toolFailureProbation).toEqual(before);
    expect(payload.lane).toBe('observation');
    expect(payload.repeatCount).toBe(2);
  });

  it('two independent reporters of ONE new-build class promote the row to that class', async () => {
    const store = signatureStore();
    await store.capture('su-a', 'build-1');
    await store.capture('su-b', 'build-2');
    const result = await store.capture('su-c', 'build-2');
    expect(result).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-S1' } });
    expect(store.rows).toHaveLength(1);
    const payload = store.payloadOf(store.rows[0]);
    expect(payload).not.toHaveProperty('lane');
    expect(payload.toolFailureProbation).toMatchObject({ state: 'promoted', deployedRevision: 'build-2' });
    expect([...payload.toolFailureProbation.reporters].sort()).toEqual(['su-b', 'su-c']);
    expect(payload.watchdogKey).toBe(SIGNATURE);
    expect(payload.repeatCount).toBe(3);
  });

  it('the same class still corroborates exactly as before D-010', async () => {
    const store = signatureStore();
    await store.capture('su-a', 'build-1');
    expect(await store.capture('su-b', 'build-1')).toMatchObject({ reason: 'promoted', issue: { id: 'EI-S1' } });
    expect(store.payloadOf(store.rows[0]).toolFailureProbation).toMatchObject({ state: 'promoted',
      deployedRevision: 'build-1' });
  });

  it('a different error code, field or tool is a different signature and a different row', async () => {
    const store = signatureStore();
    await store.capture('su-a', 'build-1');
    await store.capture('su-a', 'build-1', { errorCode: 'timeout' });
    await store.capture('su-a', 'build-1', { fieldPath: 'expects' });
    await store.capture('su-a', 'build-1', { toolName: 'coord:inbox' });
    expect(store.rows).toHaveLength(4);
    expect(new Set(store.rows.map((row) => store.payloadOf(row).watchdogKey)).size).toBe(4);
  });

  it('coalesces result-door output-spill failures across tool names without complete class metadata', async () => {
    const store = signatureStore();
    const failure = (toolName: string, message: string) => ({
      toolName,
      errorCode: 'output_spill_failed',
      status: undefined,
      schemaRevision: undefined,
      fieldPath: undefined,
      runtimeVersion: undefined,
      message,
    });

    await store.capture('su-a', 'build-1', failure('facts:list', 'result spill write failed'));
    const second = await store.capture('su-b', 'build-2', failure('work_items:get', 'result spill write failed'));

    expect(second).toMatchObject({ created: false, reason: 'coalesced', issue: { id: 'EI-S1' } });
    expect(store.rows).toHaveLength(1);
    const payload = store.payloadOf(store.rows[0]);
    expect(payload.watchdogKey).toBe(
      'tool-failure-signature:result-door:structural:output_spill_failed:field-unknown',
    );
    expect(payload.repeatCount).toBe(2);
    expect(Object.values(payload.toolFailureSignature.classes).map((entry: any) => entry.count).sort())
      .toEqual([1, 1]);
    expect(new Set(store.occurrences.map((occurrence) => occurrence.canonicalId))).toEqual(new Set(['EI-S1']));
  });

  it('keeps same-prefix helper-eligible lock failures separate while exact repeats still coalesce (EI-25714783883986261)', async () => {
    const store = signatureStore();
    const firstMessage = 'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
      'No edit attempted. Reconcile authoritative lock for crates/papercup-core/tests/android_uniffi_abi_guard.rs in mobile coordination_domain before writing or retrying.';
    const secondMessage = 'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
      'No edit attempted. Reconcile authoritative lock for packages/operator-core/lib/agent-tools/improvements/capture.test.ts in papercusp coordination before writing or retrying.';
    // This core helper intentionally accepts `status: error`; the HTTP 502
    // production route falls through to captureImprovement and is covered by
    // the two-report wrapper regression in capture.test.ts.
    const failure = (message: string) => ({
      toolName: 'locks:acquire', errorCode: 'mcp_proxy_upstream_error', status: 'error',
      schemaRevision: '', fieldPath: '', runtimeVersion: '', message,
    });

    const first = await store.capture('su-a', '', failure(firstMessage));
    const second = await store.capture('su-a', '', failure(secondMessage));
    const repeatedFirst = await store.capture('su-a', '', failure(firstMessage));

    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: true });
    expect(repeatedFirst).toMatchObject({ created: false, reason: 'coalesced', issue: { id: first?.issue?.id } });
    expect(store.rows).toHaveLength(2);
    expect(new Set(store.rows.map((row) => store.payloadOf(row).watchdogKey)).size).toBe(2);
    expect(store.payloadOf(store.rows[0]).repeatCount).toBe(2);
    expect(store.payloadOf(store.rows[1])).not.toHaveProperty('repeatCount');
  });

  it('uses the exact message key when any class dimension is missing', async () => {
    const store = signatureStore();
    const firstMessage = 'invalid_args: first body value was rejected';
    const secondMessage = 'invalid_args: second body value was rejected';
    const incomplete = { schemaRevision: '', fieldPath: '', message: firstMessage };
    await store.capture('su-a', '', incomplete);
    const first = store.rows[0];
    const expectedFirstKey = normalizeSuspectedToolFailure({ ...metadataToolFailure, runtimeVersion: '', ...incomplete }).watchdogKey;
    expect(store.payloadOf(first).watchdogKey).toBe(expectedFirstKey);
    expect(store.payloadOf(first).watchdogKey).not.toBe(SIGNATURE);

    await store.capture('su-b', '', { ...incomplete, message: secondMessage });
    await store.capture('su-a', '', incomplete);

    expect(store.rows).toHaveLength(2);
    expect(store.payloadOf(store.rows[0]).watchdogKey).not.toBe(store.payloadOf(store.rows[1]).watchdogKey);
    expect(store.payloadOf(store.rows[0]).repeatCount).toBe(2);
    expect(store.payloadOf(store.rows[1])).not.toHaveProperty('repeatCount');
    expect(store.payloadOf(store.rows[0]).toolFailureProbation).toMatchObject({ state: 'probation', reporters: ['su-a'] });
    expect(store.payloadOf(store.rows[1]).toolFailureProbation).toMatchObject({ state: 'probation', reporters: ['su-b'] });
  });

  it('bounds the per-class tally but always keeps the class the probation is about', () => {
    let tally = null as ReturnType<typeof tallyToolFailureClass> | null;
    for (let i = 0; i < TOOL_FAILURE_SIGNATURE_MAX_CLASSES + 8; i++) {
      tally = tallyToolFailureClass(tally, SIGNATURE, { classKey: `class-${i}`, ownerId: 'su-a',
        at: `2026-09-23T12:${String(i).padStart(2, '0')}:00Z`, contractFingerprint: 'c', deployedRevision: `b-${i}` },
        'class-0');
    }
    const keys = Object.keys(tally!.classes);
    expect(keys).toHaveLength(TOOL_FAILURE_SIGNATURE_MAX_CLASSES);
    expect(keys).toContain('class-0');
    expect(keys).toContain(`class-${TOOL_FAILURE_SIGNATURE_MAX_CLASSES + 7}`);
    expect(keys).not.toContain('class-1');
  });
});
