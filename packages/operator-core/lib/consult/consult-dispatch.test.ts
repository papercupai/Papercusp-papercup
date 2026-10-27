/**
 * consult-dispatch.test.ts — the fork/convert walk (plan
 * consult-expert-routing-2026-09-22 P-003, D-002 / D-004 / D-009).
 *
 * WHAT THIS PINS, and why each one needs a test rather than a reading:
 *  - a consult NEVER messages a live agent: a LIVE source is FORKED, not pinged
 *    and not refused (the retired reviver refused a live target outright, which
 *    is the behaviour D-002 replaces);
 *  - the walk CONTINUES past a walled account / an unforkable source / a
 *    non-Claude cross-backend rank, and only an exhausted list is terminal —
 *    R-6's "a walled backend never ends a consult";
 *  - a FORK answers under a freshly PRE-PINNED identity, so the consult row can
 *    name its responder before that session exists.
 *
 * `buildAgentLaunchCommand` is deliberately NOT faked. The argv is the contract
 * between this module and psu, so a hand-written expectation here would only
 * restate this file's own assumptions; running the real composer is what makes
 * "--fork carries --owner-id" and "a conversion carries --agent=<target>" claims
 * about the shipped launcher rather than about the fixture.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY, RUBRIC_VETTING_POLICY } from './selection-policies';
import type { NativeConsultBoundary } from './native-consult';
import {
  analyzeClaudeResumeTranscriptFile,
  __resetClaudeResumeTranscriptCacheForTests,
} from '../claude-resume-tool-references.mjs';
import {
  DISPATCH_RECORD_TEXT_MAX,
  DISPATCH_VERIFY_TIMEOUT_MS,
  FIRST_TURN_POLL_MS,
  FIRST_TURN_WAIT_MS,
  PROVIDER_ERROR_LAUNCHES_PER_RANK,
  consultDispatchBrief,
  dispatchConsultResponder,
  dispatchRecordEntry,
  launchLogFailureReason,
  makeConsultReachDispatcher,
  planDispatchOperation,
  renderCitedTurnsBlock,
  BRIEF_FALLBACK_REASONS,
  BRIEF_TURN_TEXT_MAX,
  BRIEF_TOTAL_TEXT_MAX,
  SOURCE_COOLDOWN_MS,
  SOURCE_FAILURE_LOOKBACK_MS,
  SOURCE_LAUNCH_FAILURE_THRESHOLD,
  sourceCooldownFrom,
  answerFailureRecordEntry,
  resolveConsultBackendAvailability,
  rejudgeFirstTurn,
  type ConsultDispatchContext,
  type ConsultDispatchDeps,
  type ConsultDispatchRecordInput,
  type PersistedDispatchRecord,
} from './consult-dispatch';

/** The cool-down clock every fake dispatch runs at. */
const NOW_MS = Date.parse('2026-09-26T12:00:00.000Z');
import { buildAgentLaunchCommand, injectLaunchedByArg } from '../agent-launch-core';
import { checkConsultSessionPortTranscript } from './resume-transcript-preflight';
import { analyzeCodexRolloutText } from '../events/await/codex-rollout-overflow';
import {
  DEFAULT_EXPERT_MODEL_ALLOWLIST,
  normalizeExpertModelAllowlist,
  resolveExpertModelAllowlist,
  type AllowedExpertModel,
} from './expert-model-allowlist';
import { mockOrgPgSql } from '../testing/mock-org-pg';

const CTX: ConsultDispatchContext = {
  workspaceId: 'ws-dispatch',
  harnessSlug: 'papercusp',
  launchedBy: 'su-requester',
};

const OPTS = {
  sourceOwnerId: 'su-expert',
  conversationId: 'conv-d-1',
  brief: '🧭 CONSULT — answer this.',
  evidence: [{ session_id: 'sess-1', turn_idx: 1, sim: 0.8 }],
};

/** Only claude+codex ranks, so a three-step walk fits in one readable assertion. */
const RANKS: AllowedExpertModel[] = [
  { rank: 1, agent: 'claude', model: 'opus' },
  { rank: 2, agent: 'codex', model: 'sol' },
];

interface Fakes {
  deps: Partial<ConsultDispatchDeps>;
  calls: {
    spawn: Array<{
      envelope: { env: Record<string, string>; greetingCmd: string; cwd: string };
      writeMcpJson?: boolean;
      coordOwnerId?: string | null;
      label?: string | null;
    }>;
    verify: Array<{ ownerId: string; timeoutMs?: number }>;
    capacity: Array<{ agent: string; workspaceId: string }>;
    /** Task ids the dispatcher asked to stop after a failed rank. */
    stopped: Array<string | null | undefined>;
    /** The never-ran marker passed with each stop, index-aligned to `stopped` (WI-10006690). */
    stoppedNeverRan: Array<{ answeringOwnerId: string } | null>;
    /** Launch logs the dispatcher read a failure reason from. */
    logReads: Array<string | null | undefined>;
    /** Every walk the dispatcher asked to persist (WI-10003197). */
    recorded: ConsultDispatchRecordInput[];
  };
}

function makeFakes(
  over: Partial<Record<keyof ConsultDispatchDeps, unknown>> = {},
  opts: {
    source?: Record<string, unknown>;
    /** `exit-N`: the spawn returns, then its child exits with status N before registering. */
    spawnStatuses?: Array<'ok' | 'error' | 'no-proof' | 'exit-2'>;
    /** What the launch-log reader reports for a failed rank. */
    logReason?: string | null;
    /** Durable log path returned for a failed spawn. */
    errorLogPath?: string;
    /** The source's persisted dispatch walks the cool-down reads (WI-10003198). */
    sourceRecords?: PersistedDispatchRecord[];
  } = {},
): Fakes {
  const calls: Fakes['calls'] = {
    spawn: [], verify: [], capacity: [], stopped: [], stoppedNeverRan: [], logReads: [], recorded: [],
  };
  let mintSeq = 0;
  let spawnSeq = 0;
  const statuses = opts.spawnStatuses ?? [];
  const deps = {
    resolveResumeTarget: async () => ({
      ok: true,
      sessionId: 'sess-1',
      resumeId: 'sess-1',
      ompThreadId: null,
      ownerId: 'su-expert',
      agent: 'claude',
      cwd: '/recorded/cwd',
      model: null,
      modelSource: null,
      endedAt: '2026-09-22T00:00:00Z',
      endedBy: 'self',
      live: false,
      advSessionId: 7,
      binding: {
        coordOwnerId: 'su-expert',
        sessionId: (opts.source?.sessionId as string | null | undefined) ?? 'sess-1',
        startedAt: '2026-09-22T00:00:00Z',
      },
      ...(opts.source ?? {}),
    }),
    checkResumeTranscript: async () => ({ available: true, detail: 'fixture transcript' }),
    checkPortTranscript: async () => ({ available: true, detail: 'fixture port source' }),
    checkEvidenceIncarnationOwnedBy: async () => false,
    // REAL composer + REAL injector: see the file header.
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope: async () => ({ cwd: '/base/cwd', env: { BASE: '1' }, greetingCmd: '' }),
    spawnHeadless: async (o: Fakes['calls']['spawn'][number]) => {
      calls.spawn.push(o);
      const status = statuses[spawnSeq++] ?? 'ok';
      if (status === 'error') {
        return {
          status: 'error',
          code: 500,
          error: 'fixture spawn failure',
          ...(opts.errorLogPath ? { logPath: opts.errorLogPath } : {}),
        };
      }
      return {
        status: 'ok',
        pid: 42,
        taskId: `task-${spawnSeq}`,
        terminal: 'headless',
        logPath: `/logs/x-${spawnSeq}.log`,
        child: null,
        display: null,
        kickoffProof:
          status === 'no-proof'
            ? { persisted: false, nativeRef: null, reason: 'fixture-no-receipt' }
            : { persisted: true, nativeRef: '/native/answer.jsonl', reason: null },
        ...(status === 'exit-2' ? { childExit: Promise.resolve({ code: 2, signal: null }) } : {}),
      };
    },
    fetchContextPressure: async () => new Map(),
    estimateTranscriptTokens: async () => null,
    bucketTranscriptPressure: async () => null,
    verifyResumeStarted: async (ownerId: string, o: { timeoutMs?: number } = {}) => {
      calls.verify.push({ ownerId, ...o });
      return { started: true, waitedMs: 900 };
    },
    probeBackendAvailable: async (agent: string, workspaceId: string) => {
      calls.capacity.push({ agent, workspaceId });
      return { available: true, detail: `${agent} fixture headroom` };
    },
    mintOwnerId: () => `su-answer-${++mintSeq}`,
    stopFailedLaunch: async (taskId: string | null | undefined, neverRan?: { answeringOwnerId: string }) => {
      calls.stopped.push(taskId);
      calls.stoppedNeverRan.push(neverRan ?? null);
      return `stopped task ${taskId}`;
    },
    readLaunchLogReason: async (logPath: string | null | undefined) => {
      calls.logReads.push(logPath);
      return opts.logReason ?? null;
    },
    // Unit tests never reach Postgres: the default recorder is the real org pool.
    recordDispatchAttempts: async (record: ConsultDispatchRecordInput) => {
      calls.recorded.push(record);
    },
    // Same for the cool-down reader (WI-10003198): no history ⇒ no cool-down.
    readSourceDispatchRecords: async () => opts.sourceRecords ?? [],
    readReviewerModel: async () => null,
    isConsultOpen: async () => true,
    // No transcript is poisoned unless a test says so; never read the real fs here.
    analyzeClaudeTranscript: () => null,
    analyzeCodexRollout: () => null,
    nowMs: () => NOW_MS,
    // The first-turn wait (WI-10004645) never sleeps for real in unit tests.
    sleepMs: async () => {},
    loadRanks: async () => RANKS,
    // P-002: a brief launch quotes the cited turns; never read real transcripts here.
    readCitedTurns: async (_ws: string, _sessionId: string, turnIndices: readonly number[]) =>
      turnIndices.map((turn_idx) => ({ turn_idx, speaker: 'assistant', ts: null, text: `fixture cited turn ${turn_idx}` })),
    ...over,
  } as unknown as Partial<ConsultDispatchDeps>;
  return { deps, calls };
}

describe('consult child runtime routing (EI-25158565040432475)', () => {
  it.each([
    { port: '3170', target: 'claude', operation: 'fork' },
    { port: '3170', target: 'codex', operation: 'convert' },
    { port: '3271', target: 'claude', operation: 'fork' },
    { port: '3271', target: 'codex', operation: 'convert' },
  ] as const)('keeps $operation preparation on its spawning :$port runtime', async ({ port, target, operation }) => {
    const originalHono = process.env.PAPERCUSP_HONO_PORT;
    const originalDesktop = process.env.OPERATOR_DEV_PORT;
    const originalOperator = process.env.PAPERCUSP_OPERATOR_URL;
    try {
      process.env.PAPERCUSP_HONO_PORT = port;
      delete process.env.OPERATOR_DEV_PORT;
      process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:9071';
      const inputs: Array<Parameters<ConsultDispatchDeps['buildConsoleEnvelope']>[0]> = [];
      const { deps } = makeFakes({
        loadRanks: async () => [{ rank: 1, agent: target, model: target === 'codex' ? 'sol' : 'opus' }],
      });
      const buildEnvelope = deps.buildConsoleEnvelope;
      if (!buildEnvelope) throw new Error('makeFakes must provide buildConsoleEnvelope');
      deps.buildConsoleEnvelope = async (input) => {
        inputs.push(input);
        return buildEnvelope(input);
      };
      const result = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(result).toMatchObject({ dispatched: true, operation });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        operatorBaseUrl: `http://localhost:${port}`,
        agentMcpBaseUrl: `http://localhost:${port}`,
      });
    } finally {
      for (const [key, value] of Object.entries({
        PAPERCUSP_HONO_PORT: originalHono,
        OPERATOR_DEV_PORT: originalDesktop,
        PAPERCUSP_OPERATOR_URL: originalOperator,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('planDispatchOperation (D-009 walk shape)', () => {
  it('a claude source forks; claude → other backend converts', () => {
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'claude' })).toEqual({ operation: 'fork' });
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'codex' })).toEqual({ operation: 'convert' });
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'omp' })).toEqual({ operation: 'convert' });
  });

  it('an OMP source uses the maintained isolated port on its own backend', () => {
    expect(planDispatchOperation({ agent: 'omp', live: false }, { agent: 'omp' })).toMatchObject({
      operation: 'convert',
    });
  });

  it('a live or ended Codex source uses the maintained isolated port on its own backend', () => {
    // The launcher refuses an untracked fork for a pinned id, so planning this as
    // a fork launched a session that died at boot (conv-muhi8wkf, 2026-09-25).
    for (const live of [false, true]) {
      expect(planDispatchOperation({ agent: 'codex', live }, { agent: 'codex' })).toMatchObject({
        operation: 'convert',
      });
    }
  });

  it('an unsupported source backend remains skipped before launch', () => {
    for (const source of ['', null] as Array<string | null>) {
      const verdict = planDispatchOperation({ agent: source, live: false }, { agent: 'claude' });
      // A skip, never an error: D-009 §3 is explicit that this must not end the
      // consult, because the next rank may still be reachable.
      if (source === 'claude') continue;
      expect(verdict).toMatchObject({ operation: null, reason: 'conversion-unavailable' });
    }
  });

  it.each(['claude', 'codex', 'omp'])('refuses named %s personas on conversion ranks', (agent) => {
    expect(planDispatchOperation({ agent, live: false, role: 'reviewer' }, { agent: 'codex' }))
      .toMatchObject({ operation: null, reason: 'conversion-unavailable' });
  });

  it('a LIVE claude source can use an isolated conversion and still supports native forks', () => {
    expect(planDispatchOperation({ agent: 'claude', live: true }, { agent: 'codex' })).toMatchObject({
      operation: 'convert',
    });
    // The whole point of D-002: a live expert is reachable by FORK, so liveness
    // never costs the consult its rank-1 pick.
    expect(planDispatchOperation({ agent: 'claude', live: true }, { agent: 'claude' })).toEqual({ operation: 'fork' });
  });
});

describe('dispatchConsultResponder — the fork leg', () => {
  it.each(['claude', 'codex', 'omp'] as const)('ports authenticated earlier %s evidence through the tracked row without substituting its current transcript', async (sourceAgent) => {
    const historicalId = 'd4bbbcd2-b811-4c0e-ae78-8755f763186d';
    for (const targetAgent of ['claude', 'codex', 'omp'] as const) {
      const source = {
        agent: sourceAgent, sessionId: historicalId, live: true,
        binding: { coordOwnerId: 'su-expert', sessionId: 'current-native', startedAt: '2026-09-22T00:00:00Z' },
      };
      const before = structuredClone(source);
      const { deps, calls } = makeFakes({
        loadRanks: async () => [{ rank: 1, agent: targetAgent, model: targetAgent === 'codex' ? 'sol' : 'opus' }],
        checkEvidenceIncarnationOwnedBy: async (target: { ownerId: string }, id: string) =>
          target.ownerId === 'su-expert' && id === historicalId,
      }, { source });
      const result = await dispatchConsultResponder({ ...OPTS,
        evidence: [{ session_id: historicalId, turn_idx: 1, sim: 0.8 }],
      }, CTX, deps);
      expect(result).toMatchObject({ dispatched: true, operation: 'convert', answeringOwnerId: 'su-answer-1' });
      expect(calls.spawn).toHaveLength(1);
      expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--resume=7');
      expect(calls.spawn[0]!.envelope.greetingCmd).not.toContain('--fork');
      expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--owner-id=su-answer-1');
      expect(calls.spawn[0]!.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN).toBe(JSON.stringify({
        sessionId: historicalId, turnIndices: [1], contextTurns: 2,
      }));
      expect(source).toEqual(before);
    }
  });

  it.each(['foreign-owner', 'unavailable-proof', 'proof-error', 'untracked-row'] as const)('refuses historical evidence with %s before launch', async (control) => {
    const historicalId = 'd4bbbcd2-b811-4c0e-ae78-8755f763186d';
    const { deps, calls } = makeFakes({
      checkEvidenceIncarnationOwnedBy: async () => {
        if (control === 'proof-error') throw new Error('ownership read failed');
        return control !== 'unavailable-proof';
      },
    }, { source: { sessionId: historicalId,
      advSessionId: control === 'untracked-row' ? 0 : 7,
      binding: { coordOwnerId: control === 'foreign-owner' ? 'su-foreign' : 'su-expert',
        sessionId: 'current-native', startedAt: '2026-09-22T00:00:00Z' },
    } });
    const result = await dispatchConsultResponder({ ...OPTS,
      evidence: [{ session_id: historicalId, turn_idx: 1, sim: 0.8 }],
    }, CTX, deps);
    expect(result.dispatched).toBe(false);
    expect(calls.spawn).toHaveLength(0);
  });

  it.each(['sess-1', 'different-thread'])('requires the exact tracked OMP thread-only binding (%s)', async (threadId) => {
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'omp', model: 'opus' }],
    }, { source: { agent: 'omp', sessionId: 'sess-1', ompThreadId: 'sess-1',
      binding: { coordOwnerId: 'su-expert', sessionId: null, ompThreadId: threadId, startedAt: '2026-09-22T00:00:00Z' } } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.dispatched).toBe(threadId === 'sess-1');
    expect(calls.spawn).toHaveLength(threadId === 'sess-1' ? 1 : 0);
    if (threadId !== 'sess-1') expect(result.attempts[0]).toMatchObject({ reason: 'source-session-untracked' });
  });

  it.each(['claude', 'codex', 'omp'] as const)('reaches all three targets from fresh and ended %s sources under separate answer identities', async (sourceAgent) => {
    for (const live of [false, true]) {
      for (const targetAgent of ['claude', 'codex', 'omp'] as const) {
        const { deps, calls } = makeFakes({
          loadRanks: async () => [{ rank: 1, agent: targetAgent, model: targetAgent === 'codex' ? 'sol' : 'opus' }],
        }, { source: { agent: sourceAgent, live, endedAt: live ? null : '2026-09-22T00:00:00Z' } });
        const result = await dispatchConsultResponder(OPTS, CTX, deps);
        expect(result).toMatchObject({ dispatched: true, answeringOwnerId: 'su-answer-1', agent: targetAgent });
        expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--owner-id=su-answer-1');
        expect(calls.spawn[0]!.coordOwnerId).not.toBe(OPTS.sourceOwnerId);
        expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--launched-by=su-requester');
        if (result.operation === 'convert') {
          expect(calls.spawn[0]!.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN).toBe(JSON.stringify({
            sessionId: 'sess-1', turnIndices: [1], contextTurns: 2,
          }));
          expect(calls.spawn[0]!.envelope.greetingCmd).not.toContain('--fork');
        }
      }
    }
  });

  // P-002 / D-008: an untracked binding is briefed instead (see the brief suite
  // below); a binding naming ANOTHER owner contests the turns' attribution and
  // still refuses before any launch.
  it.each([{ coordOwnerId: 'su-other-owner', sessionId: 'sess-1', startedAt: '2026-09-22T00:00:00Z' },
    { coordOwnerId: 'su-expert', sessionId: 'different-native-session', startedAt: '2026-09-22T00:00:00Z' }])
  ('refuses a source binding that contests the evidence attribution before launch (%j)', async (binding) => {
    const { deps, calls } = makeFakes({}, { source: { binding } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts.every((attempt) => attempt.reason === 'source-session-untracked')).toBe(true);
    expect(calls.spawn).toHaveLength(0);
  });

  it('forks a dead claude source under a freshly PRE-PINNED identity', async () => {
    const { deps, calls } = makeFakes();
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({
      dispatched: true,
      operation: 'fork',
      agent: 'claude',
      model: 'opus',
      verified: true,
      answeringOwnerId: 'su-answer-1',
    });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'dispatched', operation: 'fork' });

    // The REAL composer's argv: a fork of the source session that pre-pins the
    // answering identity, and no conversion flag.
    const cmd = calls.spawn[0]!.envelope.greetingCmd;
    expect(cmd).toContain('--resume=sess-1');
    expect(cmd).toContain('--fork');
    expect(cmd).toContain('--owner-id=su-answer-1');
    expect(cmd).toContain('--model=opus');
    expect(cmd).toContain('--account=auto');
    expect(cmd).toContain('--headless');
    expect(cmd).toContain('--launched-by=su-requester');

    // The brief rides the ENV (never the greeting one-liner), the launch lands in
    // the source's recorded cwd, and the task is keyed to the ANSWERING identity.
    expect(calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain(OPTS.brief);
    expect(calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('EXACT TRANSCRIPT EVIDENCE: sess-1#1');
    expect(calls.spawn[0]!.envelope.env.BASE).toBe('1');
    expect(calls.spawn[0]!.envelope.cwd).toBe('/recorded/cwd');
    expect(calls.spawn[0]!.writeMcpJson).toBe(true);
    expect(calls.spawn[0]!.coordOwnerId).toBe('su-answer-1');
    // Verification polls the ANSWERING identity — the pre-pin is what makes that
    // possible for a fork at all.
    expect(calls.verify[0]).toMatchObject({ ownerId: 'su-answer-1', timeoutMs: DISPATCH_VERIFY_TIMEOUT_MS });
  });

  it('stamps the fork identity before spawnHeadless can process a first reply', async () => {
    const { deps } = makeFakes();
    let responderId = 'su-expert';
    let replyDuringSpawn: 'accepted' | 'not_a_participant' = 'not_a_participant';
    const spawn = deps.spawnHeadless!;
    deps.spawnHeadless = async (options) => {
      // A newly forked child can take its first turn before spawnHeadless
      // returns its kickoff receipt. Model the consult reply gate at that point.
      replyDuringSpawn = responderId === options.coordOwnerId ? 'accepted' : 'not_a_participant';
      return spawn(options);
    };

    const r = await dispatchConsultResponder(
      {
        ...OPTS,
        onAnsweringOwner: async (ownerId) => {
          responderId = ownerId;
        },
      },
      CTX,
      deps,
    );

    expect(replyDuringSpawn).toBe('accepted');
    expect(r).toMatchObject({ dispatched: true, operation: 'fork', answeringOwnerId: 'su-answer-1' });
  });

  it('publishes the fork responder before startup verification can admit a first reply', async () => {
    const { deps, calls } = makeFakes();
    const order: string[] = [];
    let rowResponder = 'su-expert';

    deps.verifyResumeStarted = async (ownerId) => {
      order.push('verify');
      expect(rowResponder).toBe(ownerId);
      expect(calls.spawn[0]!.coordOwnerId).toBe(ownerId);
      expect(calls.spawn[0]!.envelope.greetingCmd).toContain(`--owner-id=${ownerId}`);
      return { started: true, waitedMs: 900, expectedSessionId: null, actualSessionId: null, mismatch: false };
    };

    const r = await dispatchConsultResponder(
      {
        ...OPTS,
        onAnsweringOwner: async (ownerId) => {
          rowResponder = ownerId;
          order.push('stamped');
        },
      },
      CTX,
      deps,
    );

    expect(order).toEqual(['stamped', 'verify']);
    expect(r).toMatchObject({ dispatched: true, operation: 'fork', answeringOwnerId: 'su-answer-1' });
  });

  it.each([
    { agent: 'codex' as const, model: 'sol', account: 'auto' },
    { agent: 'omp' as const, model: 'sonnet', account: 'default' },
  ])('routes $agent consult conversions with the appropriate account path', async ({ agent, model, account }) => {
    const { deps, calls } = makeFakes({ loadRanks: async () => [{ rank: 1, agent, model }] });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent });
    const cmd = calls.spawn[0]!.envelope.greetingCmd;
    expect(cmd).toContain(`--account=${account}`);
    // A port keeps the source expert's coordination identity. The requester is
    // the process launcher, not the parent of that existing identity; stamping
    // it would make acceptance-lineage treat the expert as the requester's child.
    expect(cmd).toContain('--launched-by=su-requester');
  });

  it('FORKS a LIVE source rather than refusing it — the retired reviver refused here', async () => {
    const { deps, calls } = makeFakes({}, { source: { live: true, endedAt: null } });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({ dispatched: true, operation: 'fork', answeringOwnerId: 'su-answer-1' });
    // The answering session is a DIFFERENT identity from the live source, which
    // is what lets it run alongside without colliding on locks/presence/wake.
    expect(r.answeringOwnerId).not.toBe('su-expert');
    expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--fork');
  });

  it('resolves the brief PER OPERATION so a conversion is never told it is a fork', async () => {
    const seen: string[] = [];
    const { deps } = makeFakes(
      {
        loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }] as AllowedExpertModel[],
      },
      { source: { agent: 'claude' } },
    );
    await dispatchConsultResponder(
      {
        ...OPTS,
        brief: (operation) => {
          seen.push(operation);
          return `brief for ${operation}`;
        },
      },
      CTX,
      deps,
    );
    expect(seen).toEqual(['convert']);
  });

  it('refuses cross-backend conversion when no exact matched transcript turns exist', async () => {
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }] as AllowedExpertModel[],
    });
    const result = await dispatchConsultResponder({ ...OPTS, evidence: undefined }, CTX, deps);

    expect(result.dispatched).toBe(false);
    expect(result.attempts).toMatchObject([{ reason: 'evidence-span-unavailable' }]);
    expect(calls.spawn).toHaveLength(0);
  });
});

describe('dispatchConsultResponder — the walk', () => {
  it('skips a WALLED backend and dispatches the next rank (R-6)', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) =>
        agent === 'claude'
          ? { available: false, detail: 'every claude account reads full/paused' }
          : { available: true, detail: 'codex headroom' },
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex', model: 'sol' });
    expect(r.attempts.map((a) => [a.rank, a.outcome, a.reason])).toEqual([
      [1, 'skipped', 'account-walled'],
      [2, 'dispatched', undefined],
    ]);
    // A conversion names the TARGET backend explicitly (P-002/R-12) — without it
    // psu back-fills from the model name and silently resumes the source backend.
    const cmd = calls.spawn[0]!.envelope.greetingCmd;
    expect(cmd).toContain('--agent=codex');
    expect(cmd).toContain('--resume=sess-1');
    expect(cmd).not.toContain('--fork');
    // A conversion continues the SOURCE identity (the port's authority
    // invariant), so there is nothing to pre-pin and nothing pinned.
    expect(cmd).toContain('--owner-id=su-answer-1');
    expect(r.answeringOwnerId).toBe('su-answer-1');
  });

  it('does not start a reviewer when the consult closes during async capacity preflight', async () => {
    let consultOpen = true;
    let answeringOwnerStamped = false;
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async () => {
        consultOpen = false;
        return { available: true, detail: 'backend has headroom' };
      },
      isConsultOpen: async () => consultOpen,
    });
    const r = await dispatchConsultResponder({
      ...OPTS,
      onAnsweringOwner: () => { answeringOwnerStamped = true; },
    }, CTX, deps);

    expect(r).toMatchObject({ dispatched: false, answeringOwnerId: null });
    expect(r.attempts).toMatchObject([{ outcome: 'skipped', reason: 'consult-closed' }]);
    expect(answeringOwnerStamped).toBe(false);
    expect(calls.spawn).toHaveLength(0);
  });

  it('re-checks consult state after the async answering-owner stamp and before spawn', async () => {
    let statusReads = 0;
    let answeringOwnerStamped = false;
    const { deps, calls } = makeFakes({
      isConsultOpen: async () => ++statusReads === 1,
    });
    const r = await dispatchConsultResponder({
      ...OPTS,
      onAnsweringOwner: () => { answeringOwnerStamped = true; },
    }, CTX, deps);

    expect(statusReads).toBe(2);
    expect(answeringOwnerStamped).toBe(true);
    expect(r).toMatchObject({ dispatched: false, answeringOwnerId: null });
    expect(r.attempts).toMatchObject([{ outcome: 'skipped', reason: 'consult-closed' }]);
    expect(calls.spawn).toHaveLength(0);
  });

  it('skips a consult that closes while the headless launch waits to create its process', async () => {
    let consultOpen = true;
    const { deps, calls } = makeFakes({ isConsultOpen: async () => consultOpen });
    const spawn = deps.spawnHeadless!;
    deps.spawnHeadless = async (options) => {
      consultOpen = false;
      expect(options.beforeSpawn).toBeTypeOf('function');
      if (await options.beforeSpawn?.() === false) {
        return { status: 'error', code: 409, error: 'launch cancelled', cancelled: true };
      }
      return spawn(options);
    };

    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({ dispatched: false, answeringOwnerId: null });
    expect(result.attempts).toMatchObject([{ outcome: 'skipped', reason: 'consult-closed' }]);
    expect(calls.spawn).toHaveLength(0);
    expect(calls.verify).toHaveLength(0);
    expect(calls.stopped).toHaveLength(0);
    expect(calls.logReads).toHaveLength(0);
  });

  it('preserves a responder that answers and closes the consult during kickoff proof', async () => {
    let consultOpen = true;
    const { deps, calls } = makeFakes({ isConsultOpen: async () => consultOpen });
    const spawn = deps.spawnHeadless!;
    deps.spawnHeadless = async (options) => {
      expect(options.beforeSpawn).toBeTypeOf('function');
      expect(await options.beforeSpawn?.()).toBe(true);
      // The OS child now exists and its first reply closes the consult while
      // spawnHeadless is still waiting for that child's kickoff receipt.
      consultOpen = false;
      return spawn(options);
    };

    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({ dispatched: true, answeringOwnerId: 'su-answer-1' });
    expect(calls.spawn).toHaveLength(1);
    expect(calls.stopped).toHaveLength(0);
  });

  it('does not launch a responder when persisting its participant identity fails', async () => {
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'claude', model: 'opus' }],
    });
    const r = await dispatchConsultResponder({
      ...OPTS,
      onAnsweringOwner: async () => { throw new Error('stamp write failed'); },
    }, CTX, deps);

    expect(r).toMatchObject({
      dispatched: false,
      answeringOwnerId: null,
      attempts: [{ outcome: 'failed', reason: 'answering-owner-stamp-failed' }],
    });
    expect(calls.spawn).toHaveLength(0);
  });

  it('skips a rank whose LAUNCH fails and dispatches the next', async () => {
    const { deps } = makeFakes({}, { spawnStatuses: ['error', 'ok'] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
    expect(r.attempts.map((a) => [a.rank, a.outcome, a.reason])).toEqual([
      [1, 'failed', 'launch-failed'],
      [2, 'dispatched', undefined],
    ]);
  });

  it('records the failed spawn log path and launcher reason before trying the next rank', async () => {
    const reason = 'psu: refusing unmanaged fork su-answer-1: could not recover adv row #29351';
    const { deps, calls } = makeFakes({}, {
      spawnStatuses: ['error', 'ok'],
      logReason: reason,
      errorLogPath: '/logs/x-1.log',
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(calls.logReads).toEqual(['/logs/x-1.log']);
    expect(r.attempts[0]).toMatchObject({
      outcome: 'failed',
      reason: 'launch-failed',
      launchError: reason,
      launchLogPath: '/logs/x-1.log',
    });
    expect(r.attempts[0]!.detail).toContain(`launcher said: ${reason}`);
    expect(calls.recorded[0]!.result.attempts[0]).toMatchObject({
      launchError: reason,
      launchLogPath: '/logs/x-1.log',
    });
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
  });

  it('treats an unpersisted kickoff as a FAILED rank — an unsubmitted brief is a phantom responder', async () => {
    const { deps } = makeFakes({}, { spawnStatuses: ['no-proof', 'ok'] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'failed', reason: 'kickoff-not-persisted' });
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
  });

  // EI-24106882795589775: a failed rank's spawned session used to be left running
  // while the walk launched the next one — ~80% of the leaked consult processes.
  it('STOPS the session a failed rank spawned — by its task id — and only that one', async () => {
    const { deps, calls } = makeFakes({}, { spawnStatuses: ['no-proof', 'ok'] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(calls.stopped).toEqual(['task-1']);
    expect(r.attempts[0]!.detail).toMatch(/stopped task task-1/);
    expect(r).toMatchObject({ dispatched: true });
    // WI-10006690: the kickoff never landed, so the rank never ran a turn and its
    // freshly minted answering identity's row is closed with the stop.
    expect(calls.stoppedNeverRan).toEqual([{ answeringOwnerId: 'su-answer-1' }]);
  });

  it('never stops the session of a DISPATCHED rank (CONTROL)', async () => {
    const { deps, calls } = makeFakes();
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(true);
    expect(calls.stopped).toEqual([]);
  });

  it('tags the answering ledger row with the consult it serves (for the reaper’s consult-settled class)', async () => {
    const { deps, calls } = makeFakes();
    await dispatchConsultResponder(OPTS, CTX, deps);
    const spawned = calls.spawn[0] as unknown as { ledgerDetail?: { consultAnswer?: Record<string, unknown> } };
    expect(spawned.ledgerDetail?.consultAnswer).toMatchObject({
      conversationId: OPTS.conversationId,
      operation: 'fork',
      answeringOwnerId: 'su-answer-1',
      // The expert this fork answers for — the reaper locates the fork's cascade
      // slot by it, since the answeringOwnerId stamp is usually absent.
      sourceOwnerId: OPTS.sourceOwnerId,
    });
    expect(OPTS.sourceOwnerId).toEqual(expect.any(String));
  });

  it('a CRITICAL-context source blocks the FORK ranks only — a conversion re-renders into the target budget', async () => {
    const { deps } = makeFakes({
      fetchContextPressure: async () => new Map([['su-expert', 'critical']]),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', reason: 'source-context-critical' });
    expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
  });

  // WI-10004888: the owner-level read measures the owner's CURRENT session, but a
  // fork replays the evidence-selected session, which was an older transcript at
  // 90.6% of the same limit while the owner read 81% ('high'). The fork started
  // over its limit and could only decline, burning a grading cascade slot.
  describe('the fork SOURCE transcript is bucketed, not only the owner', () => {
    const sourceTranscript = '/fixture/evidence-session.jsonl';
    function transcriptFakes(bucket: 'ok' | 'high' | 'critical' | null) {
      const seen: { estimated: string[]; bucketed: Array<[string, number]> } = { estimated: [], bucketed: [] };
      const { deps } = makeFakes({
        fetchContextPressure: async () => new Map([['su-expert', 'high']]),
        checkResumeTranscript: async () => ({ available: true, detail: 'fixture', transcriptPath: sourceTranscript }),
        estimateTranscriptTokens: async (path: string) => {
          seen.estimated.push(path);
          return 407_627;
        },
        bucketTranscriptPressure: async (ownerId: string, tokens: number) => {
          seen.bucketed.push([ownerId, tokens]);
          return bucket;
        },
      });
      return { deps, seen };
    }

    it('a CRITICAL source transcript blocks the fork ranks even when the owner reads high', async () => {
      const { deps, seen } = transcriptFakes('critical');
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(seen.estimated).toEqual([sourceTranscript]);
      expect(seen.bucketed).toEqual([['su-expert', 407_627]]);
      expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', reason: 'source-context-critical' });
      expect(r.attempts[0].detail).toContain('407627 tokens');
      expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    });

    it('a non-critical source transcript leaves the fork rank eligible', async () => {
      const { deps } = transcriptFakes('high');
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts.some((a) => a.reason === 'source-context-critical')).toBe(false);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork' });
    });

    it('an unreadable estimate fails open on this leg (the owner-level gate already fails closed)', async () => {
      const { deps } = transcriptFakes('critical');
      deps.estimateTranscriptTokens = async () => {
        throw new Error('EACCES');
      };
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts.some((a) => a.reason === 'source-context-critical')).toBe(false);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork' });
    });
  });

  describe('a Claude source with a persisted provider context rejection', () => {
    it.each([false, true])('checks the actual provider rejection; recovered=%s', async (recovered) => {
      const dir = mkdtempSync(join(tmpdir(), 'consult-context-preflight-'));
      const path = join(dir, 'source.jsonl');
      try {
        const error = JSON.stringify({
          type: 'assistant', error: 'invalid_request', isApiErrorMessage: true,
          message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] },
        });
        writeFileSync(path, [error, ...(recovered
          ? [JSON.stringify({ type: 'system', subtype: 'compact_boundary' })]
          : [JSON.stringify({ type: 'user', message: { role: 'user', content: 'Answer the exact consult.' } })])].join('\n'));
        const { deps, calls } = makeFakes({
          fetchContextPressure: async () => new Map([['su-expert', 'ok']]),
          checkResumeTranscript: async () => ({ available: true, detail: 'fixture', transcriptPath: path }),
          estimateTranscriptTokens: async () => 100,
          bucketTranscriptPressure: async () => 'ok',
          analyzeClaudeTranscript: analyzeClaudeResumeTranscriptFile,
        });
        const result = await dispatchConsultResponder(OPTS, CTX, deps);
        expect(calls.spawn).toHaveLength(1);
        if (recovered) {
          expect(result).toMatchObject({ dispatched: true, operation: 'fork' });
          expect(result.attempts.some(a => a.reason === 'source-context-critical')).toBe(false);
        } else {
          expect(result.attempts[0]).toMatchObject({ operation: 'fork', outcome: 'skipped', reason: 'source-context-critical' });
          expect(result.attempts[0].detail).toContain('Prompt is too long');
          expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // WI-10004260: two acceptance-grading forks of sources whose transcripts
  // already ended in a provider "Tool reference … not found" 400 each replayed
  // the poison on their first turn and held the grading slot until expiry.
  describe('a Claude source whose transcript ends in a missing-tool-reference 400', () => {
    const userTurn = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    const assistantTurn = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    // The real record shape of a provider rejection (see claude-resume-tool-references.test.ts).
    const rejection = (tool: string) =>
      JSON.stringify({
        type: 'assistant',
        error: 'unknown',
        isApiErrorMessage: true,
        apiErrorStatus: 400,
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: `API Error: 400 Tool reference '${tool}' not found in available tools` }],
        },
      });

    function withTranscript(lines: string[], run: (path: string) => Promise<void>) {
      return async () => {
        const dir = mkdtempSync(join(tmpdir(), 'consult-poison-'));
        const path = join(dir, 'sess-1.jsonl');
        writeFileSync(path, `${lines.join('\n')}\n`);
        __resetClaudeResumeTranscriptCacheForTests();
        try {
          await run(path);
        } finally {
          __resetClaudeResumeTranscriptCacheForTests();
          rmSync(dir, { recursive: true, force: true });
        }
      };
    }

    it(
      'skips the FORK ranks (real analyzer) and still reaches the expert by conversion',
      withTranscript(
        [userTurn('earlier work'), assistantTurn('done'), userTurn('wake'), rejection('WaitForMcpServers')],
        async (path) => {
          const { deps, calls } = makeFakes({
            checkResumeTranscript: async () => ({ available: true, detail: 'fixture', transcriptPath: path }),
            analyzeClaudeTranscript: analyzeClaudeResumeTranscriptFile,
          });
          const r = await dispatchConsultResponder(OPTS, CTX, deps);
          expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', reason: 'source-transcript-poisoned' });
          expect(r.attempts[0]!.detail).toContain("'WaitForMcpServers'");
          // No fork was launched: the only spawn is the conversion.
          expect(calls.spawn).toHaveLength(1);
          expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
        },
      ),
    );

    it(
      'CONTROL: a source that recovered after the rejection is forked normally',
      withTranscript(
        [userTurn('wake'), rejection('WaitForMcpServers'), userTurn('wake again'), assistantTurn('recovered')],
        async (path) => {
          const { deps } = makeFakes({
            checkResumeTranscript: async () => ({ available: true, detail: 'fixture', transcriptPath: path }),
            analyzeClaudeTranscript: analyzeClaudeResumeTranscriptFile,
          });
          const r = await dispatchConsultResponder(OPTS, CTX, deps);
          expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
        },
      ),
    );

    it('a fork whose FIRST reply is the rejection is a failed rank, stopped, and the walk cascades', async () => {
      // The fixture spawn's kickoff receipt names '/native/answer.jsonl' as the
      // answering session's transcript; the source itself is healthy.
      const { deps, calls } = makeFakes({
        analyzeClaudeTranscript: (p: string) =>
          p === '/native/answer.jsonl'
            ? {
              trailingMissingToolReferenceTurns: 1,
              lastMissingToolReferenceName: 'EndConversation',
              assistantTurnsSinceLastPrompt: 1,
            }
            : null,
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts[0]).toMatchObject({
        rank: 1,
        operation: 'fork',
        outcome: 'failed',
        reason: 'first-turn-rejected',
      });
      expect(r.attempts[0]!.detail).toContain("'EndConversation'");
      expect(calls.stopped).toEqual(['task-1']);
      // CONTROL (WI-10006690): this rank booted and replied, so its launcher reports
      // its own end. The stop must not also mark its row never-ran.
      expect(calls.stoppedNeverRan).toEqual([null]);
      // The conversion leg is not a Claude session, so it is not re-checked.
      expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    });

    it('rejects a context wall in the answering fork and continues through conversion', async () => {
      const { deps, calls } = makeFakes({
        analyzeClaudeTranscript: (path: string) => path === '/native/answer.jsonl' ? {
          trailingMissingToolReferenceTurns: 0,
          lastMissingToolReferenceName: null,
          assistantTurnsSinceLastPrompt: 1,
          trailingContextLimitTurns: 1,
          lastContextLimitEvidence: 'Prompt is too long',
        } : null,
      });
      const result = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(result.attempts[0]).toMatchObject({ operation: 'fork', outcome: 'failed', reason: 'first-turn-rejected' });
      expect(result.attempts[0].detail).toContain('provider context-limit rejection (Prompt is too long)');
      expect(calls.stopped).toEqual(['task-1']);
      expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    });

    it('stops a first-turn account-rate rejection and reaches the next backend without poisoning the source', async () => {
      const { deps, calls } = makeFakes({
        analyzeClaudeTranscript: (path: string) => path === '/native/answer.jsonl' ? {
          trailingMissingToolReferenceTurns: 0, lastMissingToolReferenceName: null,
          assistantTurnsSinceLastPrompt: 1, trailingAccountWallTurns: 1,
          lastAccountWallEvidence: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
        } : null,
      });
      const result = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(result.attempts[0]).toMatchObject({ operation: 'fork', outcome: 'failed', reason: 'account-walled' });
      expect(result.attempts[0].detail).toContain("provider account rejection (API Error: Request rejected (429) · This request would exceed your account's rate limit.");
      expect(calls.stopped).toEqual(['task-1']);
      expect(result.attempts.some(attempt => attempt.reason === 'source-transcript-poisoned')).toBe(false);
      expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    });

    // WI-6554700010029533: Codex ranks were never judged, so a convert whose first
    // turn ended on a ChatGPT usage limit held its slot until bounded pickup recovery
    // (measured 13-27 min, answer-pickup-stalled). Real analyzer over rollout text.
    describe('a Codex rank first turn, judged from its rollout', () => {
      const claudeWall = (path: string) => path === '/native/answer.jsonl' ? {
        trailingMissingToolReferenceTurns: 0, lastMissingToolReferenceName: null,
        assistantTurnsSinceLastPrompt: 1, trailingAccountWallTurns: 1,
        lastAccountWallEvidence: 'API Error: Request rejected (429)',
      } : null;
      const rollout = (...records: object[]) => (path: string) => path === '/native/answer.jsonl'
        ? analyzeCodexRolloutText(records.map((r) => JSON.stringify(r)).join('\n'))
        : null;
      const started = { type: 'event_msg', payload: { type: 'task_started' } };

      it('stops a usage-limit wall as account-walled instead of holding the slot', async () => {
        const { deps, calls } = makeFakes({
          analyzeClaudeTranscript: claudeWall,
          analyzeCodexRollout: rollout(started, {
            type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You’ve hit your usage limit. Upgrade to Pro' } },
          }),
        });
        const result = await dispatchConsultResponder(OPTS, CTX, deps);
        const codex = result.attempts.find((a) => a.operation === 'convert');
        expect(codex).toMatchObject({ outcome: 'failed', reason: 'account-walled' });
        expect(codex?.detail).toContain('provider account rejection (You’ve hit your usage limit. Upgrade to Pro)');
        expect(calls.stopped).toEqual(['task-1', 'task-2']);
        expect(result.attempts.some((a) => a.operation === 'convert' && a.outcome === 'dispatched')).toBe(false);
      });

      it('keeps a Codex convert whose first turn ended cleanly, with no unchecked note', async () => {
        const { deps, calls } = makeFakes({
          analyzeClaudeTranscript: claudeWall,
          analyzeCodexRollout: rollout(started, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answered' } }),
        });
        const result = await dispatchConsultResponder(OPTS, CTX, deps);
        expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
        expect(calls.stopped).toEqual(['task-1']);
        expect(result.attempts.find((a) => a.operation === 'convert')?.detail).not.toContain('First reply not');
      });

      it('keeps the dispatch when the rollout is unreadable, and says the check did not run', async () => {
        const { deps, calls } = makeFakes({ analyzeClaudeTranscript: claudeWall });
        const result = await dispatchConsultResponder(OPTS, CTX, deps);
        expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
        expect(calls.stopped).toEqual(['task-1']);
        expect(result.attempts.find((a) => a.operation === 'convert')?.detail)
          .toContain('First reply not checked for a provider rejection: its transcript /native/answer.jsonl could not be read.');
      });
    });

    // WI-6554700010018146: a first reply that is a transient provider failure was
    // counted as the answer, so the session parked with no answer and no cascade.
    describe('a first reply that is a transient provider error (real analyzer)', () => {
      // The measured record of a provider failure that ended an answer session's turn.
      const providerError = JSON.stringify({
        type: 'assistant', error: 'server_error', isApiErrorMessage: true,
        message: {
          role: 'assistant', model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: Server error mid-response. The response above may be incomplete.' }],
        },
      });
      const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Answer the exact consult.' } });
      const reply = JSON.stringify({
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
      });

      /** One answer transcript per launch; launch N reads file N (the last one repeats). */
      async function withAnswerTranscripts(perLaunch: string[][], run: (paths: string[]) => Promise<void>) {
        const dir = mkdtempSync(join(tmpdir(), 'consult-provider-error-'));
        const paths = perLaunch.map((lines, i) => {
          const path = join(dir, `answer-${i + 1}.jsonl`);
          writeFileSync(path, `${lines.join('\n')}\n`);
          return path;
        });
        __resetClaudeResumeTranscriptCacheForTests();
        try {
          await run(paths);
        } finally {
          __resetClaudeResumeTranscriptCacheForTests();
          rmSync(dir, { recursive: true, force: true });
        }
      }
      // The fixture spawn's kickoff receipt names '/native/answer.jsonl' for every launch.
      const answerReader = (paths: string[], launches: () => number) => (p: string) =>
        p === '/native/answer.jsonl'
          ? analyzeClaudeResumeTranscriptFile(paths[Math.min(Math.max(launches(), 1), paths.length) - 1]!)
          : null;
      const walk = (attempts: { rank: number; operation: string | null; outcome: string; reason?: string }[]) =>
        attempts.map((a) => [a.rank, a.operation, a.outcome, a.reason ?? null]);

      it('relaunches the same rank once, and dispatches the relaunch that replies', () =>
        withAnswerTranscripts([[prompt, providerError], [prompt, reply]], async (paths) => {
          const fakes: ReturnType<typeof makeFakes> = makeFakes({
            analyzeClaudeTranscript: answerReader(paths, () => fakes.calls.spawn.length),
          });
          const r = await dispatchConsultResponder(OPTS, CTX, fakes.deps);
          expect(walk(r.attempts)).toEqual([
            [1, 'fork', 'failed', 'first-turn-provider-error'],
            [1, 'fork', 'dispatched', null],
          ]);
          expect(r.attempts[0]!.detail).toContain(
            'its first reply was a transient provider error (API Error: Server error mid-response.');
          expect(r.attempts[0]!.detail).toContain(`Relaunching the same rank (launch 1 of ${PROVIDER_ERROR_LAUNCHES_PER_RANK})`);
          expect(fakes.calls.stopped).toEqual(['task-1']);
          expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
        }));

      it('cascades to the next rank once the bounded relaunches all hit provider errors', () =>
        withAnswerTranscripts([[prompt, providerError]], async (paths) => {
          const fakes: ReturnType<typeof makeFakes> = makeFakes({
            analyzeClaudeTranscript: answerReader(paths, () => fakes.calls.spawn.length),
          });
          const r = await dispatchConsultResponder(OPTS, CTX, fakes.deps);
          expect(walk(r.attempts)).toEqual([
            ...Array.from({ length: PROVIDER_ERROR_LAUNCHES_PER_RANK }, () => [1, 'fork', 'failed', 'first-turn-provider-error']),
            [2, 'convert', 'dispatched', null],
          ]);
          expect(fakes.calls.spawn).toHaveLength(PROVIDER_ERROR_LAUNCHES_PER_RANK + 1);
          expect(fakes.calls.stopped).toEqual(
            Array.from({ length: PROVIDER_ERROR_LAUNCHES_PER_RANK }, (_, i) => `task-${i + 1}`));
          expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
        }));

      it('does not treat a provider error as a poisoned source: the next fork rank still runs', () =>
        withAnswerTranscripts(
          [...Array.from({ length: PROVIDER_ERROR_LAUNCHES_PER_RANK }, () => [prompt, providerError]), [prompt, reply]],
          async (paths) => {
            const fakes: ReturnType<typeof makeFakes> = makeFakes({
              loadRanks: async () => [
                { rank: 1, agent: 'claude', model: 'opus' },
                { rank: 2, agent: 'claude', model: 'sonnet' },
              ],
              analyzeClaudeTranscript: answerReader(paths, () => fakes.calls.spawn.length),
            });
            const r = await dispatchConsultResponder(OPTS, CTX, fakes.deps);
            expect(walk(r.attempts).at(-1)).toEqual([2, 'fork', 'dispatched', null]);
            expect(r.attempts.some((a) => a.reason === 'first-turn-rejected')).toBe(false);
            expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude', model: 'sonnet' });
          },
        ));
    });

    it('CONTROL: a fork whose first reply has not been rejected stays dispatched', async () => {
      const { deps, calls } = makeFakes({
        analyzeClaudeTranscript: () => ({
          trailingMissingToolReferenceTurns: 0,
          lastMissingToolReferenceName: null,
          assistantTurnsSinceLastPrompt: 1,
        }),
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
      expect(r.attempts[0]!.detail).not.toContain('First reply not written');
      expect(calls.stopped).toEqual([]);
    });

    // WI-10004645 defect 1: the verification wait returned before the reply
    // existed, and the single read that followed saw no rejection yet.
    it('WAITS for the fork’s first reply: a rejection that lands after the verification wait still fails the rank', async () => {
      let clock = NOW_MS;
      const sleeps: number[] = [];
      let reads = 0;
      const { deps, calls } = makeFakes({
        nowMs: () => clock,
        sleepMs: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
        analyzeClaudeTranscript: (p: string) => {
          if (p !== '/native/answer.jsonl') return null;
          reads += 1;
          // The kickoff is written; the 400 lands on the 5th read (~2s later).
          return reads < 5
            ? { trailingMissingToolReferenceTurns: 0, lastMissingToolReferenceName: null, assistantTurnsSinceLastPrompt: 0 }
            : {
              trailingMissingToolReferenceTurns: 1,
              lastMissingToolReferenceName: 'EndConversation',
              assistantTurnsSinceLastPrompt: 1,
            };
        },
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', outcome: 'failed', reason: 'first-turn-rejected' });
      expect(r.attempts[0]!.detail).toContain("'EndConversation'");
      expect(reads).toBe(5);
      expect(sleeps).toEqual([FIRST_TURN_POLL_MS, FIRST_TURN_POLL_MS, FIRST_TURN_POLL_MS, FIRST_TURN_POLL_MS]);
      expect(calls.stopped).toEqual(['task-1']);
      expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    });

    it('the wait is BOUNDED: no reply by FIRST_TURN_WAIT_MS keeps the dispatch and says the first turn was not checked', async () => {
      let clock = NOW_MS;
      let slept = 0;
      const { deps, calls } = makeFakes({
        nowMs: () => clock,
        sleepMs: async (ms: number) => {
          slept += ms;
          clock += ms;
        },
        analyzeClaudeTranscript: () => ({
          trailingMissingToolReferenceTurns: 0,
          lastMissingToolReferenceName: null,
          assistantTurnsSinceLastPrompt: 0,
        }),
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
      expect(slept).toBe(FIRST_TURN_WAIT_MS);
      expect(r.attempts[0]!.detail).toContain(`First reply not written ${FIRST_TURN_WAIT_MS}ms after kickoff`);
      expect(r.attempts[0]!.detail).toContain('the consult expiry sweep re-checks it');
      // EI-27111739698817170: the window closing hands the judgement to the sweep.
      expect(r.attempts[0]!.firstTurnUnjudged).toEqual({
        agent: 'claude',
        transcriptPath: '/native/answer.jsonl',
        kickoffAt: new Date(NOW_MS).toISOString(),
      });
      expect(calls.stopped).toEqual([]);
    });

    it('a STALLED clock cannot make the wait unbounded — the read count caps it', async () => {
      let reads = 0;
      const { deps } = makeFakes({
        // nowMs stays at NOW_MS (the fixture default) and sleeping advances nothing.
        analyzeClaudeTranscript: () => {
          reads += 1;
          return { trailingMissingToolReferenceTurns: 0, lastMissingToolReferenceName: null, assistantTurnsSinceLastPrompt: 0 };
        },
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork' });
      // The fixture source has no transcript path, so gate A never reads; every
      // read here is the first-turn wait, capped at one per poll slot.
      expect(reads).toBe(Math.ceil(FIRST_TURN_WAIT_MS / FIRST_TURN_POLL_MS) + 1);
    });

    // WI-10004645 defect 2: rank 2 re-forked the source rank 1 had just been
    // rejected on, and died the same way.
    it('after one fork is rejected on its first turn, the remaining FORK ranks of that source are skipped', async () => {
      const { deps, calls } = makeFakes({
        loadRanks: async () => [
          { rank: 1, agent: 'claude', model: 'fable' },
          { rank: 2, agent: 'claude', model: 'opus' },
          { rank: 3, agent: 'codex', model: 'sol' },
        ],
        analyzeClaudeTranscript: (p: string) =>
          p === '/native/answer.jsonl'
            ? {
              trailingMissingToolReferenceTurns: 1,
              lastMissingToolReferenceName: 'EndConversation',
              assistantTurnsSinceLastPrompt: 1,
            }
            : null,
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', outcome: 'failed', reason: 'first-turn-rejected' });
      expect(r.attempts[1]).toMatchObject({
        rank: 2,
        operation: 'fork',
        outcome: 'skipped',
        reason: 'source-transcript-poisoned',
      });
      expect(r.attempts[1]!.detail).toContain('rank #1 (claude/fable)');
      // Two launches: the rejected fork and the conversion. Rank 2 never spawned.
      expect(calls.spawn).toHaveLength(2);
      expect(calls.stopped).toEqual(['task-1']);
      expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex', model: 'sol' });
    });

    it('CONTROL: a fork that fails for another reason does not block the next fork rank', async () => {
      const { deps, calls } = makeFakes(
        {
          loadRanks: async () => [
            { rank: 1, agent: 'claude', model: 'fable' },
            { rank: 2, agent: 'claude', model: 'opus' },
          ],
        },
        { spawnStatuses: ['no-proof', 'ok'] },
      );
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'failed', reason: 'kickoff-not-persisted' });
      expect(calls.spawn).toHaveLength(2);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', model: 'opus' });
    });

    it('an unreadable transcript analysis does not block the fork (the kickoff proof still guards it)', async () => {
      const { deps } = makeFakes({
        checkResumeTranscript: async () => ({ available: true, detail: 'fixture', transcriptPath: '/nope.jsonl' }),
        analyzeClaudeTranscript: () => {
          throw new Error('EACCES');
        },
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
      // WI-10006676: the dispatch stands, but its record must say the first reply
      // was never judged — a silent record reads like a fork judged clean.
      const dispatched = r.attempts.find((a) => a.outcome === 'dispatched');
      expect(dispatched?.detail).toContain(
        'First reply not checked for a provider rejection: its transcript /native/answer.jsonl could not be read.',
      );
    });

    it('a Claude fork whose kickoff proof names no native transcript says its first reply was not checked', async () => {
      const { deps } = makeFakes();
      const realSpawn = deps.spawnHeadless!;
      deps.spawnHeadless = (async (o: Parameters<typeof realSpawn>[0]) => {
        const res = await realSpawn(o);
        return res.status === 'ok'
          ? { ...res, kickoffProof: { persisted: true, nativeRef: null, reason: null } }
          : res;
      }) as typeof realSpawn;
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
      const dispatched = r.attempts.find((a) => a.outcome === 'dispatched');
      expect(dispatched?.detail).toContain(
        'First reply not checked for a provider rejection: the kickoff proof named no native transcript.',
      );
    });

    it('a readable, clean first reply leaves the record without an unchecked note (control)', async () => {
      const { deps } = makeFakes({
        analyzeClaudeTranscript: () => ({
          trailingMissingToolReferenceTurns: 0,
          lastMissingToolReferenceName: null,
          assistantTurnsSinceLastPrompt: 1,
          trailingContextLimitTurns: 0,
          lastContextLimitEvidence: null,
        }),
      });
      const r = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(r).toMatchObject({ dispatched: true, operation: 'fork', agent: 'claude' });
      const dispatched = r.attempts.find((a) => a.outcome === 'dispatched');
      expect(dispatched?.detail).toBeDefined();
      expect(dispatched?.detail).not.toContain('First reply not');
    });
  });

  it('an exhausted allowlist is the terminal verdict, with every rank recorded as evidence', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: false, detail: `${agent} walled` }),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.answeringOwnerId).toBeNull();
    expect(r.attempts.map((a) => a.reason)).toEqual(['account-walled', 'account-walled']);
    expect(r.detail).toContain('every allowed expert model was exhausted');
    expect(r.targetCapacityUnavailable).toBeUndefined();
    // Nothing was launched, and — the D-002 invariant — nothing was messaged:
    // this module has no notify seam to message anyone WITH.
    expect(calls.spawn).toHaveLength(0);
  });

  it('an OMP source with no OMP-reachable rank exhausts by SKIP, never by error', async () => {
    const { deps } = makeFakes(
      { loadRanks: async () => [...RANKS, { rank: 3, agent: 'omp', model: 'grok' }] as AllowedExpertModel[] },
      { source: { agent: 'omp', ompThreadId: 'thr-1', sessionId: 'thr-1', resumeId: '9' } },
    );
    const r = await dispatchConsultResponder({ ...OPTS, evidence: undefined }, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.attempts.map((a) => [a.agent, a.reason])).toEqual([
      ['claude', 'evidence-span-unavailable'],
      ['codex', 'evidence-span-unavailable'],
      ['omp', 'evidence-span-unavailable'],
    ]);
    expect(r.attempts.every((a) => a.outcome === 'skipped')).toBe(true);
  });

  it('skips non-plain conversion sources before any conversion spawn, briefs them instead, while retaining native forks', async () => {
    const blocked = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: agent !== 'claude', detail: 'provider capacity' }),
      checkPortTranscript: async () => { throw new Error('role refusal must precede transcript reads'); },
    }, { source: { role: 'reviewer' } });
    const result = await dispatchConsultResponder(OPTS, CTX, blocked.deps);
    // The conversion path still refuses a non-plain source before reading or launching it …
    expect(result.attempts.slice(0, 2).map((a) => a.reason)).toEqual(['account-walled', 'conversion-unavailable']);
    expect(result.attempts[1].detail).toContain('plain tracked SU');
    // … and P-002 / D-008 answers that intentional skip with a fresh briefed session.
    // Only the rank the port skipped ON PURPOSE is briefed; the already-walled rank is not retried.
    expect(result).toMatchObject({ dispatched: true, operation: 'brief', agent: 'codex' });
    expect(result.attempts.filter((a) => a.operation === 'brief').map((a) => [a.agent, a.outcome]))
      .toEqual([['codex', 'dispatched']]);
    expect(blocked.calls.spawn).toHaveLength(1);
    expect(blocked.calls.spawn[0]!.envelope.greetingCmd).not.toContain('--fork');

    const fork = makeFakes({}, { source: { role: 'reviewer' } });
    expect(await dispatchConsultResponder(OPTS, CTX, fork.deps)).toMatchObject({ dispatched: true, operation: 'fork' });
    expect(fork.calls.spawn).toHaveLength(1);
  });

  it('dispatches a Codex-source-only selection through a fresh cited-turn brief when conversion is unavailable', async () => {
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }],
      probeBackendAvailable: async () => ({ available: true, detail: 'codex fixture headroom' }),
    }, { source: { agent: 'codex', role: 'reviewer', binding: null } });

    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    // This is the clause's falsifier fixture: the only selected expert is a
    // Codex source. A conversion refusal must still produce an answering
    // session via the cited-turn fallback, rather than ending with no launch.
    expect(result).toMatchObject({
      dispatched: true,
      operation: 'brief',
      agent: 'codex',
      model: 'sol',
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({ agent: 'codex', operation: null, reason: 'source-session-untracked', outcome: 'skipped' }),
      expect.objectContaining({ agent: 'codex', operation: 'brief', outcome: 'dispatched' }),
    ]);
    expect(calls.spawn).toHaveLength(1);
    const spawn = calls.spawn[0]!;
    expect(spawn.coordOwnerId).not.toBe(OPTS.sourceOwnerId);
    expect(spawn.envelope.greetingCmd).toContain('--owner-id=su-answer-1');
    expect(spawn.envelope.greetingCmd).not.toContain('--resume');
    expect(spawn.envelope.greetingCmd).not.toContain('--fork');
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('fixture cited turn 1');
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('sess-1#1');
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('NOT your own history');
  });

  it('rejects a real cyclic source once for every conversion rank and quotes its indexed evidence in a fresh brief', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-port-cycle-'));
    const path = join(dir, 'source.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'a1', message: { role: 'user', content: 'question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'answer' } }),
    ].join('\n') + '\n');
    let reads = 0;
    try {
      const { deps, calls } = makeFakes({
        loadRanks: async () => [...RANKS, { rank: 3, agent: 'codex', model: 'astra' }],
        probeBackendAvailable: async (agent: string) => ({ available: agent !== 'claude', detail: 'provider capacity' }),
        // Indexed evidence remains readable even though the native graph is cyclic.
        checkResumeTranscript: async () => ({ available: true, detail: 'exact fixture source', transcriptPath: path }),
        checkPortTranscript: async (...args: Parameters<typeof checkConsultSessionPortTranscript>) => {
          reads++;
          return checkConsultSessionPortTranscript(...args);
        },
      });
      const result = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(result).toMatchObject({ dispatched: true, operation: 'brief' });
      expect(result.attempts.slice(0, 3).map((a) => a.reason)).toEqual([
        'account-walled', 'conversion-unavailable', 'conversion-unavailable',
      ]);
      expect(result.attempts.slice(1, 3).every((a) => a.detail.includes('cycle detected'))).toBe(true);
      expect(reads).toBe(1);
      expect(calls.spawn).toHaveLength(1);
      expect(calls.spawn[0].envelope.greetingCmd).not.toMatch(/--resume|--fork/);
      expect(calls.recorded[0].result).toEqual(result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the normal next-expert delivery reach a portable source after a preflight refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-port-fallback-'));
    const path = join(dir, 'source.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null,
      message: { role: 'user', content: 'eligible evidence' } }) + '\n');
    try {
      // No readable cited turns, so the P-002 brief fallback cannot answer this source either.
      const rejected = makeFakes({ readCitedTurns: async () => [] }, { source: { role: 'reviewer' } });
      rejected.deps.loadRanks = async () => [RANKS[1]];
      const first = await makeConsultReachDispatcher(CTX, rejected.deps)({
        responder: OPTS.sourceOwnerId, conversationId: OPTS.conversationId,
        summary: 'Review', body: 'Exact evidence', evidence: OPTS.evidence,
      });
      expect(first.queued).toBe(0);
      expect(rejected.calls.spawn).toHaveLength(0);

      const eligible = makeFakes({
        loadRanks: async () => [RANKS[1]],
        readCitedTurns: async () => [{ turn_idx: 1, speaker: 'user', ts: null, text: 'eligible evidence' }],
        checkResumeTranscript: async () => ({ available: true, detail: 'exact source', transcriptPath: path }),
        checkPortTranscript: checkConsultSessionPortTranscript,
      });
      const next = await makeConsultReachDispatcher(CTX, eligible.deps)({
        responder: OPTS.sourceOwnerId, conversationId: OPTS.conversationId,
        summary: 'Review', body: 'Exact evidence', evidence: OPTS.evidence,
      });
      expect(next).toMatchObject({ queued: 1, pickupConfirmed: true,
        dispatch: { dispatched: true, operation: 'convert' } });
      expect(eligible.calls.spawn).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on unknown conversion eligibility when cited evidence is also unreadable', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: agent !== 'claude', detail: 'provider capacity' }),
      checkPortTranscript: async () => { throw new Error('source read interrupted'); },
      readCitedTurns: async () => { throw new Error('source read interrupted'); },
    });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.attempts[1]).toMatchObject({ outcome: 'skipped', reason: 'conversion-unavailable' });
    expect(result.attempts[1].detail).toContain('source read interrupted');
    expect(calls.spawn).toHaveLength(0);
  });

  it('refuses before any launch when the source transcript is gone', async () => {
    const { deps, calls } = makeFakes({
      checkResumeTranscript: async () => ({ available: false, detail: 'native transcript unavailable (retired)' }),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.detail).toContain('source transcript unavailable');
    expect(calls.spawn).toHaveLength(0);
  });

  it('never throws — an unresolvable source is a dispatched:false verdict', async () => {
    const { deps } = makeFakes({
      resolveResumeTarget: async () => ({ ok: false, error: 'not_found', detail: 'no adv row' }),
    });
    await expect(dispatchConsultResponder(OPTS, CTX, deps)).resolves.toMatchObject({
      dispatched: false,
      detail: expect.stringContaining('source session unresolvable'),
    });
  });

  it('never throws — a throwing seam is a dispatched:false verdict', async () => {
    const { deps } = makeFakes({
      resolveResumeTarget: async () => {
        throw new Error('pg is down');
      },
    });
    await expect(dispatchConsultResponder(OPTS, CTX, deps)).resolves.toMatchObject({
      dispatched: false,
      detail: expect.stringContaining('dispatch threw: pg is down'),
    });
  });
});

/**
 * WI-10003197: over 7 days, 545 of 1,168 answering-session launches were refused
 * by psu within seconds, and the reason reached no table — only fleet-logs. These
 * pin that every walk is persisted, and that a failed rank carries psu's words.
 * The fixtures below are real launch-log lines (2026-09-25), control bytes kept.
 */
const FORK_REFUSAL_LOG = [
  '\x1b]0;psu\x07papercusp superuser launcher (psu): launcher\r',
  '/home/u/papercusp-staging/apps/operator/scripts/psu-launcher.mjs\r',
  '\x1b[31mpsu: refusing unmanaged fork su-faca4604-e062-469a-85b6-cf551ea52752: tracked source session ' +
    'd073dd42-6761-436e-b86c-df822ce3da38 could not recover adv row #29351.\x1b[0m\r',
  '[papercusp] initial terminal command exited with status 2; headless launch exiting.\r',
  '',
].join('\n');

const CONVERT_REFUSAL_LOG = [
  'papercusp superuser launcher (psu): launcher',
  // An informational psu line: NOT a failure, and must not be reported as one.
  'psu: session 247965b5-922e-435b-95ad-f41db0232d81 is a psu-launched claude session — older than the ' +
    'recent-session window; resuming from its per-session CLAUDE_CONFIG_DIR.',
  'psu: cross-backend resume requires a psu-tracked source session; raw native sessions can only resume/fork in place',
  '[papercusp] initial terminal command exited with status 1; headless launch exiting.',
].join('\n');

/** The CLI draws its wall inside TUI output with cursor moves, mid-way through the brief's own "line". */
const WALL_LOG =
  '🧭 CONSULT — the existing relevance router selected you as an independent audit candidate; ' +
  'read the request in conversations:get { id:"conv-x" }. '.repeat(8) +
  "\x1b[1B\x1b[49m\x1b[38;5;246m  ⎿  \x1b[38;5;211mYou've hit your weekly limit · resets Sep 26, 5am " +
  '(America/New_York)\x1b[1B\x1b[39m \x1b[3G   \x1b[38;5;246m/usage-credits\n';

describe('launchLogFailureReason (the launcher’s own words, from a real log)', () => {
  it('reports psu’s fork refusal and the exit status, with control bytes stripped', () => {
    expect(launchLogFailureReason(FORK_REFUSAL_LOG)).toBe(
      'psu: refusing unmanaged fork su-faca4604-e062-469a-85b6-cf551ea52752: tracked source session ' +
        'd073dd42-6761-436e-b86c-df822ce3da38 could not recover adv row #29351. · ' +
        '[papercusp] initial terminal command exited with status 2',
    );
  });

  it('reports the convert refusal, not the informational psu line before it', () => {
    const reason = launchLogFailureReason(CONVERT_REFUSAL_LOG)!;
    expect(reason).toMatch(/^psu: cross-backend resume requires a psu-tracked source session/);
    expect(reason).toMatch(/exited with status 1$/);
    expect(reason).not.toContain('older than the recent-session window');
  });

  it('preserves an unrecoverable transcript graph refusal instead of only its exit status', () => {
    const refusal = 'psu: POST /api/adv/sessions/port/inspect (HTTP 409) — ' +
      'unrecoverable Claude transcript graph: cycle detected at cede960f-af9d-49c8-96e8-9d6b3f845536';
    const log = '\x1b]0;consult-convert\x07psu: inspecting Claude transcript graph\r\n' +
      `\x1b[31m${refusal}\x1b[0m\r\n` +
      '[papercusp] initial terminal command exited with status 1; headless launch exiting.\r\n';
    expect(launchLogFailureReason(log)).toBe(
      `${refusal} · [papercusp] initial terminal command exited with status 1`,
    );
    expect(launchLogFailureReason('psu: inspecting Claude transcript graph\n')).toBeNull();
  });

  it('extracts an account wall drawn mid-line, never the brief text it is drawn beside', () => {
    // Keeping the whole rendered line would clip to its START — the consult
    // brief — which is exactly what the first version of this parser reported.
    expect(launchLogFailureReason(WALL_LOG)).toBe("You've hit your weekly limit · resets Sep 26, 5am (America/New_York)");
  });

  it('reports the LAST failure when a log holds several', () => {
    const log = 'psu: tracked resume failed: first\npsu: refusing fork: second\n';
    expect(launchLogFailureReason(log)).toBe('psu: refusing fork: second');
  });

  it.each(['Context limit reached · /clear to continue', 'Prompt is too long'])
    ('reports the actual terminal context rejection: %s', (failure) => {
      expect(launchLogFailureReason(`consult brief\x1b[1B  ⎿  ${failure}\n`)).toBe(failure);
      expect(launchLogFailureReason(`The request quotes ${failure} for investigation.\n`)).toBeNull();
    });

  it.each([
    'psu: V1 targetBackend must be codex|omp',
    'psu: consult evidence refs are not all present in the exact source session (0/1)',
  ])('preserves the session-port validation refusal: %s', (failure) => {
    const log = 'psu: last active model in this session: gpt-6-luna:max\n' +
      `${failure}\n[ papercusp greeting ]\n` +
      '[papercusp] initial terminal command exited with status 1; headless launch exiting.\n';
    expect(launchLogFailureReason(log)).toBe(
      `${failure} · [papercusp] initial terminal command exited with status 1`,
    );
  });

  it('falls back to the exit status alone, and is null for a log with no failure', () => {
    expect(launchLogFailureReason('booting\n[papercusp] initial terminal command exited with status 2\n')).toBe(
      '[papercusp] initial terminal command exited with status 2',
    );
    expect(launchLogFailureReason('psu: resuming session abc\nready\n')).toBeNull();
    expect(launchLogFailureReason('')).toBeNull();
  });
});

describe('dispatchConsultResponder — every walk is persisted on its consult (WI-10003197)', () => {
  it('records a DISPATCHED walk once, carrying the exact verdict it returned', async () => {
    const { deps, calls } = makeFakes();
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(true);
    expect(calls.recorded).toEqual([
      {
        workspaceId: CTX.workspaceId,
        conversationId: OPTS.conversationId,
        sourceOwnerId: OPTS.sourceOwnerId,
        result: r,
      },
    ]);
  });

  it('records an EXHAUSTED walk — the case that used to leave no trace at all', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: false, detail: `${agent} walled` }),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(calls.recorded).toHaveLength(1);
    expect(calls.recorded[0]!.result.attempts.map((a) => a.reason)).toEqual(['account-walled', 'account-walled']);
  });

  it('records a walk refused BEFORE any rank, and one whose resolution threw', async () => {
    const gone = makeFakes({
      checkResumeTranscript: async () => ({ available: false, detail: 'native transcript unavailable (retired)' }),
    });
    await dispatchConsultResponder(OPTS, CTX, gone.deps);
    expect(gone.calls.recorded).toHaveLength(1);
    expect(gone.calls.recorded[0]!.result.detail).toContain('source transcript unavailable');

    const threw = makeFakes({
      resolveResumeTarget: async () => {
        throw new Error('pg is down');
      },
    });
    await dispatchConsultResponder(OPTS, CTX, threw.deps);
    expect(threw.calls.recorded).toHaveLength(1);
    expect(threw.calls.recorded[0]!.result.detail).toContain('dispatch threw: pg is down');
  });

  it('a recorder that THROWS never costs the dispatch its verdict', async () => {
    const { deps } = makeFakes({
      recordDispatchAttempts: async () => {
        throw new Error('column "dispatch_attempts" does not exist');
      },
    });
    await expect(dispatchConsultResponder(OPTS, CTX, deps)).resolves.toMatchObject({
      dispatched: true,
      answeringOwnerId: 'su-answer-1',
    });
  });

  it('an unpersisted kickoff carries the launcher’s own reason, read from THAT rank’s log', async () => {
    const reason = 'psu: refusing unmanaged fork su-answer-1: could not recover adv row #?.';
    const { deps, calls } = makeFakes({}, { spawnStatuses: ['no-proof', 'ok'], logReason: reason });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(calls.logReads).toEqual(['/logs/x-1.log']);
    expect(r.attempts[0]).toMatchObject({ reason: 'kickoff-not-persisted', launchError: reason });
    expect(r.attempts[0]!.detail).toContain(`launcher said: ${reason}`);
    // and the persisted record carries it too, not just the in-memory verdict
    expect(calls.recorded[0]!.result.attempts[0]!.launchError).toBe(reason);
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
  });

  it('a rank whose process EXITS before registering carries the launcher’s reason', async () => {
    const reason = 'psu: cross-backend resume requires a psu-tracked source session';
    let verifies = 0;
    const { deps, calls } = makeFakes(
      {
        // Rank 1 never registers a host; its child exit must win the race.
        verifyResumeStarted: () =>
          ++verifies === 1 ? new Promise(() => {}) : Promise.resolve({ started: true, waitedMs: 5 }),
      },
      { spawnStatuses: ['exit-2', 'ok'], logReason: reason },
    );
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'failed', reason: 'launch-exited', launchError: reason });
    expect(r.attempts[0]!.detail).toContain('exited with status 2');
    expect(r.attempts[0]!.detail).toContain(`launcher said: ${reason}`);
    expect(calls.stopped).toEqual(['task-1']);
    // WI-10006690: the host never registered, so the row is closed as never-ran.
    expect(calls.stoppedNeverRan).toEqual([{ answeringOwnerId: 'su-answer-1' }]);
    expect(calls.logReads).toEqual(['/logs/x-1.log']);
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
  });

  it('with no recognisable log line, a failed rank has NO launchError key and no "launcher said" (CONTROL)', async () => {
    const { deps } = makeFakes({}, { spawnStatuses: ['no-proof', 'ok'], logReason: null });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]!.reason).toBe('kickoff-not-persisted');
    expect(r.attempts[0]).not.toHaveProperty('launchError');
    expect(r.attempts[0]!.detail).not.toContain('launcher said');
  });

  it('never reads a DISPATCHED rank’s log (CONTROL)', async () => {
    const { deps, calls } = makeFakes({}, { logReason: 'psu: would be wrong to report' });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(true);
    expect(calls.logReads).toEqual([]);
    expect(r.attempts.some((a) => 'launchError' in a)).toBe(false);
  });
});

describe('dispatchRecordEntry (the persisted shape is bounded)', () => {
  const base: ConsultDispatchRecordInput = {
    workspaceId: 'ws',
    conversationId: 'conv',
    sourceOwnerId: 'su-src',
    result: {
      dispatched: false,
      answeringOwnerId: null,
      operation: null,
      agent: null,
      model: null,
      verified: false,
      detail: 'x'.repeat(5000),
      attempts: [
        {
          rank: 1,
          agent: 'claude',
          model: 'opus',
          operation: 'fork',
          outcome: 'failed',
          reason: 'launch-exited',
          detail: 'y'.repeat(5000),
          launchError: 'z'.repeat(1000),
          launchLogPath: '/logs/failed-launch.log',
        },
        { rank: 2, agent: 'codex', model: 'sol', operation: 'convert', outcome: 'skipped', detail: 'short' },
      ],
    },
  };

  it('clips every free-text field so a record is a pointer, never a log copy', () => {
    const e = dispatchRecordEntry(base, '2026-09-26T00:00:00.000Z') as {
      at: string;
      detail: string;
      attempts: Array<Record<string, unknown>>;
    };
    expect(e.at).toBe('2026-09-26T00:00:00.000Z');
    expect(e.detail).toHaveLength(DISPATCH_RECORD_TEXT_MAX);
    expect(e.detail.endsWith('…')).toBe(true);
    expect((e.attempts[0]!.detail as string).length).toBe(DISPATCH_RECORD_TEXT_MAX);
    expect((e.attempts[0]!.launchError as string).length).toBe(300);
    expect(e.attempts[0]!.launchLogPath).toBe('/logs/failed-launch.log');
  });

  it('omits reason and launchError when a rank has none, rather than writing null', () => {
    const e = dispatchRecordEntry(base, '2026-09-26T00:00:00.000Z') as { attempts: Array<Record<string, unknown>> };
    expect(e.attempts[1]).toEqual({
      rank: 2,
      agent: 'codex',
      model: 'sol',
      operation: 'convert',
      outcome: 'skipped',
      detail: 'short',
    });
  });

  // EI-27111739698817170: the sweep re-judges from this persisted pointer.
  it('persists an unjudged first turn verbatim, and drops (never clips) an over-long transcript path', () => {
    const unjudged = (transcriptPath: string): ConsultDispatchRecordInput => ({
      ...base,
      result: {
        ...base.result,
        dispatched: true,
        attempts: [{
          rank: 1, agent: 'codex', model: 'sol', operation: 'convert', outcome: 'dispatched', detail: 'ok',
          firstTurnUnjudged: { agent: 'codex', transcriptPath, kickoffAt: '2026-09-26T00:00:00.000Z' },
        }],
      },
    });
    const kept = dispatchRecordEntry(unjudged('/codex/rollout-a.jsonl'), '2026-09-26T00:00:01.000Z') as {
      attempts: Array<Record<string, unknown>>;
    };
    expect(kept.attempts[0]!.firstTurnUnjudged).toEqual({
      agent: 'codex', transcriptPath: '/codex/rollout-a.jsonl', kickoffAt: '2026-09-26T00:00:00.000Z',
    });
    const long = `/${'p'.repeat(DISPATCH_RECORD_TEXT_MAX)}.jsonl`;
    const dropped = dispatchRecordEntry(unjudged(long), '2026-09-26T00:00:01.000Z') as {
      attempts: Array<Record<string, unknown>>;
    };
    expect(dropped.attempts[0]).not.toHaveProperty('firstTurnUnjudged');
  });
});

// EI-27111739698817170: a provider refusal that lands after FIRST_TURN_WAIT_MS was
// never judged. The sweep re-judges with the dispatcher's own classifier. Real
// analyzers over the measured shapes: the Codex convert ended its turn with
// task_complete carrying model_not_found ~48s after launch.
describe('rejudgeFirstTurn (the same first-turn judge, run after the window)', () => {
  const codex = (...records: object[]) => ({
    analyzeClaudeTranscript: () => null,
    analyzeCodexRollout: () => analyzeCodexRolloutText(records.map((r) => JSON.stringify(r)).join('\n')),
  });
  const started = { type: 'event_msg', payload: { type: 'task_started' } };
  const target = { agent: 'codex' as const, transcriptPath: '/codex/rollout-a.jsonl' };

  it('a Codex first turn that ended on model_not_found is a rejection with the dispatcher reason', () => {
    const verdict = rejudgeFirstTurn(target, codex(started, {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: null,
        error: {
          code: 'model_not_found',
          message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      },
    }));
    expect(verdict).toMatchObject({ status: 'rejected', reason: 'first-turn-provider-error' });
    expect(verdict.status === 'rejected' && verdict.evidence).toBe(
      "its first reply was a provider error (The 'gpt-5.6-sol' model is not supported when using Codex " +
        'with a ChatGPT account.) in /codex/rollout-a.jsonl',
    );
  });

  it('a usage-limit first turn is an account wall', () => {
    const verdict = rejudgeFirstTurn(target, codex(started, {
      type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You’ve hit your usage limit. Upgrade to Pro' } },
    }));
    expect(verdict).toMatchObject({ status: 'rejected', reason: 'account-walled' });
  });

  it('a turn still running is pending, a clean turn is replied, an unreadable file is unreadable', () => {
    expect(rejudgeFirstTurn(target, codex(started))).toEqual({ status: 'pending' });
    expect(rejudgeFirstTurn(target, codex(started, {
      type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answered' },
    }))).toEqual({ status: 'replied' });
    expect(rejudgeFirstTurn(target, { analyzeClaudeTranscript: () => null, analyzeCodexRollout: () => null }))
      .toEqual({ status: 'unreadable' });
  });

  it('a Claude first reply is judged by the Claude reader, never the Codex one', () => {
    const verdict = rejudgeFirstTurn({ agent: 'claude', transcriptPath: '/native/answer.jsonl' }, {
      analyzeClaudeTranscript: (path) => path === '/native/answer.jsonl' ? {
        trailingMissingToolReferenceTurns: 0, lastMissingToolReferenceName: null,
        assistantTurnsSinceLastPrompt: 1, trailingContextLimitTurns: 1, lastContextLimitEvidence: 'Prompt is too long',
      } : null,
      analyzeCodexRollout: () => { throw new Error('codex reader must not be used for a claude rank'); },
    });
    expect(verdict).toMatchObject({ status: 'rejected', reason: 'first-turn-rejected' });
    expect(verdict.status === 'rejected' && verdict.evidence).toContain('provider context-limit rejection (Prompt is too long)');
  });
});

describe('makeConsultReachDispatcher (D-010: the seam shape survives, its meaning changes)', () => {
  it.each(['deferred-initial', 'decline-cascade', 'expiry-recovery'])(
    'restores the persisted METHOD scope and rejects a related source on %s', async leg => {
      const db = await import('@papercusp/db-org');
      const spy = vi.spyOn(db, 'getOrgPg');
      mockOrgPgSql(spy, vi.fn(async () => [{ policy: 'method-review', method_rubric: 'acceptance-native',
        requester_id: 'saved-applier', reviewer_model: null, native_consult: null }]));
      const check = vi.fn(async () => ({ eligible: false, reason: 'related_to_plan_implementer' }));
      const { deps, calls } = makeFakes({ readReviewerModel: undefined, checkApprover: check as never });
      try {
        const result = await makeConsultReachDispatcher({ ...CTX, launchedBy: `system:${leg}` }, deps)({
          responder: 'su-expert', conversationId: `conv-${leg}`, summary: 'method', body: 'current method',
        });
        expect(result.queued).toBe(0);
        expect(check).toHaveBeenCalledWith({ rubricId: 'acceptance-native', applierId: 'saved-applier', ownerId: 'su-expert' });
        expect(calls.spawn).toHaveLength(0);
        expect(calls.capacity).toHaveLength(0);
      } finally { spy.mockRestore(); }
    },
  );

  it.each(['missing-target', 'screen-error', 'answerer-screen-error', 'related-answerer', 'unrelated-answerer'])(
    'fails closed before spawn while checking actual METHOD answerer: %s', async state => {
      const db = await import('@papercusp/db-org');
      const spy = vi.spyOn(db, 'getOrgPg');
      mockOrgPgSql(spy, vi.fn(async () => [{ policy: 'method-review',
        method_rubric: state === 'missing-target' ? null : 'acceptance-native', requester_id: 'saved-applier',
        reviewer_model: null, native_consult: null }]));
      const reserved: string[] = [];
      const check = vi.fn(async ({ ownerId }: { ownerId: string }) => {
        if (state === 'screen-error') throw new Error('lineage unavailable');
        if (ownerId !== 'su-expert') expect(reserved).toContain(ownerId);
        if (ownerId !== 'su-expert' && state === 'answerer-screen-error') throw new Error('answerer lineage unavailable');
        return { eligible: ownerId === 'su-expert' || state === 'unrelated-answerer', reason: 'related_to_plan_implementer' };
      });
      const { deps, calls } = makeFakes({ readReviewerModel: undefined, checkApprover: check as never });
      try {
        const run = () => makeConsultReachDispatcher(CTX, deps)({ responder: 'su-expert',
          conversationId: 'conv-method-answerer', summary: 'method', body: 'current method', evidence: OPTS.evidence,
          onAnsweringOwner: async ownerId => { reserved.push(ownerId); },
        });
        if (state === 'missing-target') await expect(run()).rejects.toThrow('method_review_requires_acceptance_rubric');
        else {
          const result = await run();
          expect(result.queued).toBe(state === 'unrelated-answerer' ? 1 : 0);
          expect(calls.spawn).toHaveLength(state === 'unrelated-answerer' ? 1 : 0);
        }
        if (state !== 'missing-target' && state !== 'screen-error') {
          expect(check.mock.calls.some(([input]) => input.ownerId.startsWith('su-answer-'))).toBe(true);
        }
      } finally { spy.mockRestore(); }
    },
  );

  const leasedBoundary = (): Extract<NativeConsultBoundary, { status: 'measured' }> => ({
    status: 'measured', capturedAt: '2026-09-26T12:00:00.000Z', completedAt: '2026-09-26T12:00:01.000Z',
    readScope: 'fixture source and plan-lease endpoint', sourceAdvSessionId: 7,
    sourceNativeSessionId: 'sess-1', sourceOwnerId: 'su-expert',
    snapshot: { kind: 'live-jsonl', highWaterBytes: 12, completeBytes: 12, sha256: 'fixture-prefix',
      archiveRelpath: null, fileIdentity: null },
    claims: { checked: [], truncated: false, scope: 'no work-item claims' },
    planClaims: { checked: [{ workspaceId: CTX.workspaceId, harnessSlug: 'papercusp', planSlug: 'source-plan',
      itemId: 'P-001', claimId: 'source-lease-incarnation', owner: 'su-expert', livenessMode: 'activity',
      ttlSec: 120, acquiredTs: '2026-09-26T11:59:00.000Z', expiresTs: '2026-09-26T12:01:00.000Z',
      lastActivityTs: '2026-09-26T12:00:00.000Z', expired: false }],
    truncated: false, scope: 'source-owner plan lease' },
  });

  it.each(['empty', 'expired', 'unmeasured'] as const)(
    'refuses a selected native source with %s plan leases before a cascade launch', async state => {
      const boundary = leasedBoundary();
      if (state === 'empty') boundary.planClaims.checked = [];
      if (state === 'expired') boundary.planClaims.checked[0]!.expiresTs = boundary.completedAt;
      let captured = 0;
      const { deps, calls } = makeFakes({
        readDispatchChoice: async () => ({ reviewerModel: null,
          nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex',
            requireSourcePlanClaims: true } }),
        captureNativeBoundary: async () => {
          captured++;
          return state === 'unmeasured' ? { status: 'unknown', reason: 'canonical claim reader unavailable' } : boundary;
        },
      });
      const result = await makeConsultReachDispatcher(CTX, deps)({
        responder: 'su-expert', conversationId: 'conv-native-lease', summary: 'native probe',
        body: 'selected source lost its lease', evidence: OPTS.evidence,
      });
      expect(captured).toBe(1);
      expect(result.dispatch).toMatchObject({ dispatched: false, attempts: [],
        detail: expect.stringContaining(state === 'unmeasured' ? 'not measured' : 'nonexpired source plan lease missing') });
      expect(calls.spawn).toHaveLength(0);
      expect(calls.capacity).toHaveLength(0);
      expect(calls.recorded[0]!.result.dispatched).toBe(false);
    },
  );

  it('allows a native source with a measured nonexpired plan lease and no work-item claims', async () => {
    const { deps, calls } = makeFakes({
      readDispatchChoice: async () => ({ reviewerModel: null,
        nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex',
          requireSourcePlanClaims: true } }),
      captureNativeBoundary: async () => leasedBoundary(),
    });
    const result = await makeConsultReachDispatcher(CTX, deps)({
      responder: 'su-expert', conversationId: 'conv-native-lease', summary: 'native probe',
      body: 'source with a plan-only claim', evidence: OPTS.evidence,
    });
    expect(result.dispatch).toMatchObject({ dispatched: true, agent: 'codex' });
    expect(calls.spawn).toHaveLength(1);
  });

  it('never substitutes seed models when the configured native target is absent', async () => {
    const { deps, calls } = makeFakes({
      readDispatchChoice: async () => ({ reviewerModel: null,
        nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' } }),
      loadRanks: async () => [],
    });
    const result = await makeConsultReachDispatcher(CTX, deps)({
      responder: 'su-expert', conversationId: 'conv-native-empty', summary: 'native probe', body: 'next responder',
      evidence: OPTS.evidence,
    });
    expect(result.dispatch).toMatchObject({ dispatched: false, attempts: [],
      detail: expect.stringContaining('no configured allowed model') });
    expect(calls.spawn).toHaveLength(0);
    expect(calls.capacity).toHaveLength(0);
  });

  it('keeps native backend constraints on a later cascade and preserves a walled target as unavailable', async () => {
    const { deps, calls } = makeFakes({
      readDispatchChoice: async () => ({ reviewerModel: null,
        nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' } }),
      probeBackendAvailable: async () => ({ available: false, detail: 'target account unavailable' }),
    });
    const result = await makeConsultReachDispatcher(CTX, deps)({
      responder: 'su-expert', conversationId: 'conv-native', summary: 'native probe', body: 'next responder',
      evidence: OPTS.evidence,
    });
    expect(result.dispatch.dispatched).toBe(false);
    expect(result.targetCapacityUnavailable).toContain('native target codex capacity unavailable');
    expect(result.dispatch.targetCapacityUnavailable).toBe(result.targetCapacityUnavailable);
    expect(result.dispatch.attempts).toEqual([expect.objectContaining({ agent: 'codex', reason: 'account-walled' })]);
    expect(calls.spawn).toHaveLength(0);
  });

  it('records every native target rank but probes a source-independent capacity wall only once', async () => {
    const probe = vi.fn(async () => ({ available: false, detail: 'all target accounts walled' }));
    const { deps, calls } = makeFakes({
      loadRanks: async () => [RANKS[0]!, RANKS[1]!, { rank: 3, agent: 'codex', model: 'sol-lite' }],
      probeBackendAvailable: probe,
    });
    const result = await dispatchConsultResponder({ ...OPTS,
      nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' },
    }, CTX, deps);
    expect(probe).toHaveBeenCalledExactlyOnceWith('codex', CTX.workspaceId);
    expect(result).toMatchObject({ dispatched: false, targetCapacityUnavailable: expect.stringContaining('all target accounts walled') });
    expect(result.attempts.map(a => [a.rank, a.reason])).toEqual([[2, 'account-walled'], [3, 'account-walled']]);
    expect(calls.spawn).toHaveLength(0);
    expect(dispatchRecordEntry(calls.recorded[0]!, new Date(NOW_MS).toISOString()))
      .toHaveProperty('targetCapacityUnavailable', result.targetCapacityUnavailable);
  });

  it('rechecks native source state before a later cascade instead of using a changed live source', async () => {
    const { deps, calls } = makeFakes({
      readDispatchChoice: async () => ({ reviewerModel: null,
        nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' } }),
    }, { source: { live: true } });
    const result = await makeConsultReachDispatcher(CTX, deps)({
      responder: 'su-expert', conversationId: 'conv-native', summary: 'native probe', body: 'next responder',
      evidence: OPTS.evidence,
    });
    expect(result.dispatch.dispatched).toBe(false);
    expect(result.dispatch.detail).toContain('source state');
    expect(calls.spawn).toHaveLength(0);
  });

  it('keeps a saved reviewer model and effort on a later cascade leg', async () => {
    const { deps, calls } = makeFakes({
      readReviewerModel: async () => ({ agent: 'codex', model: 'sol', effort: 'xhigh' }),
    });
    const reach = makeConsultReachDispatcher(CTX, deps);
    const result = await reach({
      responder: 'su-expert', conversationId: 'conv-review', summary: 'review', body: 'next reviewer',
      evidence: OPTS.evidence,
    });
    expect(result.dispatch).toMatchObject({ agent: 'codex', model: 'sol:xhigh' });
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]!.envelope.greetingCmd).toContain('sol');
  });

  it.each([RUBRIC_VETTING_POLICY, ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY])(
    'loads the persisted %s reviewer choice on a later dispatch without substituting the default rank', async (policy) => {
      const db = await import('@papercusp/db-org');
      const sql = vi.fn(async () => [{ policy,
        reviewer_model: { agent: 'codex', model: 'sol', effort: 'xhigh' }, native_consult: null }]);
      const spy = vi.spyOn(db, 'getOrgPg');
      mockOrgPgSql(spy, sql);
      try {
        const { deps, calls } = makeFakes({ readReviewerModel: undefined });
        const result = await makeConsultReachDispatcher(CTX, deps)({
          responder: 'su-expert', conversationId: 'conv-saved-review', summary: 'review', body: 'next reviewer',
          evidence: OPTS.evidence,
        });
        expect(sql).toHaveBeenCalled();
        expect(result.dispatch).toMatchObject({ agent: 'codex', model: 'sol:xhigh', dispatched: true });
        expect(calls.spawn).toHaveLength(1);
        expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--account=auto');
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('rejects a saved reviewer model on an unrelated policy before launching', async () => {
    const db = await import('@papercusp/db-org');
    const spy = vi.spyOn(db, 'getOrgPg');
    mockOrgPgSql(spy, vi.fn(async () => [{
      policy: 'ordinary-consult', reviewer_model: { agent: 'codex', model: 'sol' }, native_consult: null,
    }]));
    try {
      const { deps, calls } = makeFakes({ readReviewerModel: undefined });
      await expect(makeConsultReachDispatcher(CTX, deps)({
        responder: 'su-expert', conversationId: 'conv-invalid-policy', summary: 'review', body: 'next reviewer',
      })).rejects.toThrow('outside an authorized review policy');
      expect(calls.spawn).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a reviewer model removed from the allowlist without launching a substitute', async () => {
    const { deps, calls } = makeFakes({
      readReviewerModel: async () => ({ agent: 'codex', model: 'unlisted' }),
    });
    const result = await makeConsultReachDispatcher(CTX, deps)({
      responder: 'su-expert', conversationId: 'conv-review', summary: 'review', body: 'next reviewer',
    });
    expect(result).toMatchObject({ queued: 0, woke: 0, dispatch: { dispatched: false } });
    expect(result.dispatch.detail).toContain('absent from the current expert allowlist');
    expect(calls.spawn).toHaveLength(0);
  });

  it('reports a dispatched launch in the delivery-count shape every consult call site already reads', async () => {
    const { deps, calls } = makeFakes();
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({
      responder: 'su-expert',
      conversationId: 'conv-d-1',
      summary: '🧭 consult from su-requester: why?',
      body: 'Why you: evidence line.',
    });
    expect(r).toMatchObject({ queued: 1, woke: 1, pickupConfirmed: true, answeringOwnerId: 'su-answer-1' });
    // The wake copy carries over verbatim into the brief, under a frame that says
    // this session was launched FOR the consult.
    const brief = calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT;
    expect(brief).toContain('conv-d-1');
    expect(brief).toContain('Why you: evidence line.');
    expect(brief).toContain('🧭 consult from su-requester: why?');
    expect(brief).toContain('FORK of su-expert');
  });

  it('a still-BOOTING launch is a delivery without a pickup claim', async () => {
    const { deps } = makeFakes({
      verifyResumeStarted: async () => ({ started: false, waitedMs: DISPATCH_VERIFY_TIMEOUT_MS }),
    });
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({ responder: 'su-expert', conversationId: 'c', summary: 's', body: 'b' });
    expect(r).toMatchObject({ queued: 1, woke: 0, pickupConfirmed: false });
  });

  it('an exhausted walk reports ZERO deliveries — which is what every caller already cascades on', async () => {
    const { deps } = makeFakes({
      probeBackendAvailable: async () => ({ available: false, detail: 'walled' }),
    });
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({ responder: 'su-expert', conversationId: 'c', summary: 's', body: 'b' });
    expect(r).toMatchObject({ queued: 0, woke: 0, pickupConfirmed: false, answeringOwnerId: null });
    expect(r.dispatch.attempts.length).toBeGreaterThan(0);
  });
});

describe('consultDispatchBrief', () => {
  it('tells a fork it is a fork, and says the source was NOT notified', () => {
    const brief = consultDispatchBrief({
      conversationId: 'conv-1',
      sourceOwnerId: 'su-expert',
      operation: 'fork',
      summary: 'S',
      body: 'B',
    });
    expect(brief).toContain('FORK of su-expert');
    expect(brief).toContain('NOT notified');
    expect(brief).toContain('conv-1');
  });

  it('tells a conversion it was carried across backends', () => {
    const brief = consultDispatchBrief({
      conversationId: 'conv-1',
      sourceOwnerId: 'su-expert',
      operation: 'convert',
      summary: 'S',
      body: 'B',
    });
    expect(brief).toContain('isolated answering session');
    expect(brief).toContain('NEW identity');
    expect(brief).not.toContain('FORK of');
  });

  it('P-004: carries the ANSWER-ONLY posture on BOTH operations — the brief is the only thing that sets it', () => {
    for (const operation of ['fork', 'convert'] as const) {
      const brief = consultDispatchBrief({
        conversationId: 'conv-1',
        sourceOwnerId: 'su-expert',
        operation,
        summary: 'S',
        body: 'B',
      });
      expect(brief).toContain('ANSWER-ONLY');
      expect(brief).toContain('END YOUR TURN');
      // The specific failure this exists to prevent: a session reading its
      // inherited transcript as its own agenda and resuming the source's work
      // under a second identity.
      expect(brief).toContain('not an agenda to continue');
      expect(brief).toContain('Do not claim work-items');
    }
  });
});

describe('expert-model allowlist (D-004)', () => {
  it('seeds the D-006 rank order: Claude fable/opus, then ChatGPT sol/astra', () => {
    expect([...DEFAULT_EXPERT_MODEL_ALLOWLIST]).toEqual([
      { rank: 1, agent: 'claude', model: 'fable' },
      { rank: 2, agent: 'claude', model: 'opus' },
      { rank: 3, agent: 'codex', model: 'sol' },
      { rank: 4, agent: 'codex', model: 'gpt-6-astra' },
    ]);
  });

  it('re-ranks densely after a GUI reorder leaves gaps, and keeps authored order on a tie', () => {
    expect(
      normalizeExpertModelAllowlist([
        { rank: 7, agent: 'codex', model: 'sol' },
        { rank: 1, agent: 'claude', model: 'opus' },
        { rank: 1, agent: 'claude', model: 'fable' },
      ]),
    ).toEqual([
      { rank: 1, agent: 'claude', model: 'opus' },
      { rank: 2, agent: 'claude', model: 'fable' },
      { rank: 3, agent: 'codex', model: 'sol' },
    ]);
  });

  it('drops unusable rows instead of failing the consult, and de-duplicates a repeated pair', () => {
    expect(
      normalizeExpertModelAllowlist([
        null,
        'opus',
        { agent: 'gemini', model: 'pro' },
        { agent: 'claude', model: '   ' },
        { agent: 'claude', model: 'opus' },
        { agent: 'CLAUDE', model: 'opus' },
      ]),
    ).toEqual([{ rank: 1, agent: 'claude', model: 'opus' }]);
  });

  it('falls back to the seed when the stored setting is empty, unusable, or unreadable', async () => {
    const seed = normalizeExpertModelAllowlist([...DEFAULT_EXPERT_MODEL_ALLOWLIST]);
    await expect(resolveExpertModelAllowlist('ws', {})).resolves.toEqual(seed);
    await expect(resolveExpertModelAllowlist('ws', { loadRanks: async () => [] })).resolves.toEqual(seed);
    await expect(
      resolveExpertModelAllowlist('ws', { loadRanks: async () => [{ agent: 'nope', model: 'x' }] as never }),
    ).resolves.toEqual(seed);
    await expect(
      resolveExpertModelAllowlist('ws', {
        loadRanks: async () => {
          throw new Error('settings table missing');
        },
      }),
    ).resolves.toEqual(seed);
  });

  it('uses the stored ranks when they are usable', async () => {
    await expect(
      resolveExpertModelAllowlist('ws', { loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'astra' }] }),
    ).resolves.toEqual([{ rank: 1, agent: 'codex', model: 'astra' }]);
  });
});

describe('buildAgentLaunchCommand ownerId rule (the pre-pin this dispatch depends on)', () => {
  it('pins a fork and a cross-backend conversion', () => {
    expect(
      buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid', agent: 'claude', ownerId: 'su-new' }),
    ).toContain('--owner-id=su-new');
    expect(
      buildAgentLaunchCommand({
        mode: 'resume',
        sessionId: 'sid',
        agent: 'claude',
        targetAgent: 'omp',
        ownerId: 'su-new',
      }),
    ).toContain('--owner-id=su-new');
  });

  it('REFUSES a same-backend resume rather than silently resuming under the recorded id', () => {
    expect(() =>
      buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid', agent: 'claude', ownerId: 'su-new' }),
    ).toThrow(/same-backend resume/);
    expect(
      buildAgentLaunchCommand({
        mode: 'resume',
        sessionId: 'sid',
        agent: 'claude',
        targetAgent: 'claude',
        ownerId: 'su-new',
      }),
    ).toContain('--owner-id=su-new');
  });
});

describe('source cool-down (WI-10003198 — a source whose launches keep failing is not relaunched)', () => {
  const at = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
  /** One persisted walk that launched and lost both ranks, shaped as dispatchRecordEntry writes it. */
  const failedWalk = (minutesAgo: number): PersistedDispatchRecord => ({
    at: at(minutesAgo),
    sourceOwnerId: 'su-expert',
    dispatched: false,
    attempts: [
      { outcome: 'failed', reason: 'kickoff-not-persisted', agent: 'claude', model: 'opus', launchError: 'psu: refusing unmanaged fork' },
      { outcome: 'failed', reason: 'launch-exited', agent: 'codex', model: 'sol' },
    ],
  });

  it('a source past the failure threshold is skipped with a concrete reason, and nothing is launched', async () => {
    const { deps, calls } = makeFakes({}, { sourceRecords: [failedWalk(5), failedWalk(20)] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.attempts).toEqual([]);
    expect(r.detail).toMatch(/su-expert is cooling down until 2026-09-26T12:55:00\.000Z/);
    expect(r.detail).toMatch(/last 4 answering-session launches failed \(newest: kickoff-not-persisted on claude\/opus: psu: refusing unmanaged fork\)/);
    expect(calls.spawn).toHaveLength(0);
    expect(calls.capacity).toHaveLength(0);
    // The refusal itself is persisted, so the consult shows why it was skipped.
    expect(calls.recorded).toHaveLength(1);
    expect(calls.recorded[0].result.detail).toMatch(/cooling down/);
  });

  it('launches again once the cool-down has elapsed', async () => {
    const minutesPastCooldown = SOURCE_COOLDOWN_MS / 60_000 + 1;
    const { deps, calls } = makeFakes({}, { sourceRecords: [failedWalk(minutesPastCooldown), failedWalk(minutesPastCooldown + 5)] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(true);
    expect(calls.spawn).toHaveLength(1);
  });

  it('a reader failure fails open — the cool-down never blocks a dispatch', async () => {
    const { deps, calls } = makeFakes({
      readSourceDispatchRecords: async () => {
        throw new Error('pool exhausted');
      },
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(true);
    expect(calls.spawn).toHaveLength(1);
  });

  it('asks for exactly the lookback window of this source in this workspace', async () => {
    const seen: unknown[][] = [];
    const { deps } = makeFakes({
      readSourceDispatchRecords: async (...args: unknown[]) => {
        seen.push(args);
        return [];
      },
    });
    await dispatchConsultResponder(OPTS, CTX, deps);
    expect(seen).toEqual([[CTX.workspaceId, 'su-expert', new Date(NOW_MS - SOURCE_FAILURE_LOOKBACK_MS).toISOString()]]);
  });

  describe('sourceCooldownFrom (pure)', () => {
    const failedOnce = (minutesAgo: number): PersistedDispatchRecord => ({
      at: at(minutesAgo),
      dispatched: false,
      attempts: [{ outcome: 'failed', reason: 'launch-failed', agent: 'claude', model: 'opus' }],
    });

    it('starts at the threshold, not before', () => {
      const below = Array.from({ length: SOURCE_LAUNCH_FAILURE_THRESHOLD - 1 }, (_, i) => failedOnce(i + 1));
      expect(sourceCooldownFrom(below, NOW_MS)).toBeNull();
      const at_ = Array.from({ length: SOURCE_LAUNCH_FAILURE_THRESHOLD }, (_, i) => failedOnce(i + 1));
      expect(sourceCooldownFrom(at_, NOW_MS)).toMatchObject({
        failures: SOURCE_LAUNCH_FAILURE_THRESHOLD,
        until: new Date(NOW_MS - 60_000 + SOURCE_COOLDOWN_MS).toISOString(),
      });
    });

    it('a successful dispatch resets the count; failures before it do not count', () => {
      const records = [
        failedOnce(1),
        { at: at(2), dispatched: true, attempts: [{ outcome: 'dispatched' }] },
        failedOnce(3),
        failedOnce(4),
        failedOnce(5),
      ];
      expect(sourceCooldownFrom(records, NOW_MS)).toBeNull();
    });

    it('skips (walls, pressure, unsupported) and launch-less walks neither count nor reset', () => {
      const records: PersistedDispatchRecord[] = [
        failedOnce(1),
        { at: at(2), dispatched: false, attempts: [{ outcome: 'skipped', reason: 'account-walled' }] },
        { at: at(3), dispatched: false, attempts: [] },
        failedOnce(4),
        failedOnce(5),
      ];
      expect(sourceCooldownFrom(records, NOW_MS)).toMatchObject({ failures: 3 });
    });

    it('failures older than the lookback do not count, and order is by time, not array position', () => {
      const old = SOURCE_FAILURE_LOOKBACK_MS / 60_000 + 10;
      expect(sourceCooldownFrom([failedOnce(old), failedOnce(1), failedOnce(old + 1)], NOW_MS)).toBeNull();
      // Unsorted input: the newest failure still anchors the cool-down end.
      expect(sourceCooldownFrom([failedOnce(30), failedOnce(1), failedOnce(10)], NOW_MS)?.until).toBe(
        new Date(NOW_MS - 60_000 + SOURCE_COOLDOWN_MS).toISOString(),
      );
    });

    it('ignores records with no parseable time', () => {
      expect(sourceCooldownFrom([{ at: 'not-a-time' } as PersistedDispatchRecord, failedOnce(1)], NOW_MS)).toBeNull();
    });
  });
});

describe('answer-window failure records (WI-10003199, P-003)', () => {
  const T0 = Date.parse('2026-09-26T05:00:00Z');
  const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
  const input = {
    workspaceId: 'ws',
    conversationId: 'conv-1',
    sourceOwnerId: 'src-1',
    answeringOwnerId: 'fork-1',
    cascadeCursor: 2,
    reason: 'answer-window-expired' as const,
    detail: 'answering session for src-1 did not post before its proceed consult window expired',
    stopOutcome: 'stopped task t-1',
  };

  it('records a failed attempt carrying the expiry reason and the stop outcome', () => {
    const entry = answerFailureRecordEntry(input, iso(0));
    expect(entry).toMatchObject({
      at: iso(0),
      sourceOwnerId: 'src-1',
      dispatched: false,
      answeringOwnerId: 'fork-1',
      answerFailure: { reason: 'answer-window-expired', cascadeCursor: 2, stopOutcome: 'stopped task t-1' },
      attempts: [{ outcome: 'failed', reason: 'answer-window-expired' }],
    });
    expect(String(entry.detail)).toContain('stopped task t-1');
  });

  it('is neutral to the source cool-down: it neither counts as a launch failure nor resets the count', () => {
    const launchFail = (minAgo: number): PersistedDispatchRecord => ({
      at: iso(minAgo),
      sourceOwnerId: 'src-1',
      dispatched: false,
      attempts: [{ outcome: 'failed', reason: 'launch-exited', agent: 'claude', model: 'm' }],
    });
    const expiry = (minAgo: number) => answerFailureRecordEntry(input, iso(minAgo)) as unknown as PersistedDispatchRecord;
    // Not counted: three answer failures alone never start a cool-down.
    expect(sourceCooldownFrom([expiry(1), expiry(2), expiry(3)], T0)).toBeNull();
    // Not a reset: failed launches on either side of it still add up to the threshold.
    const cd = sourceCooldownFrom([launchFail(1), expiry(2), launchFail(3), launchFail(4)], T0);
    expect(cd?.failures).toBe(SOURCE_LAUNCH_FAILURE_THRESHOLD);
  });
});

// consult-backed-parking-2026-10-12 P-002 / D-008: a source the session port
// skips ON PURPOSE (untracked native, non-plain-SU) is answered by a FRESH
// session under its own identity, briefed with the expert's cited turns.
describe('cited-turn brief launch for unforkable sources (P-002, D-008)', () => {
  it('covers exactly the two intentional session-port skips', () => {
    expect([...BRIEF_FALLBACK_REASONS].sort()).toEqual(['conversion-unavailable', 'source-session-untracked']);
  });

  it('launches a fresh briefed session for an untracked native source instead of refusing', async () => {
    const reads: Array<{ sessionId: string; turnIndices: readonly number[] }> = [];
    const { deps, calls } = makeFakes({
      readCitedTurns: async (_ws: string, sessionId: string, turnIndices: readonly number[]) => {
        reads.push({ sessionId, turnIndices });
        return [{ turn_idx: 1, speaker: 'assistant', ts: '2026-09-22T00:00:01Z', text: 'the expert explained the lock order' }];
      },
    }, { source: { binding: null } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result).toMatchObject({ dispatched: true, operation: 'brief', agent: 'claude', model: 'opus' });
    expect(reads).toEqual([{ sessionId: 'sess-1', turnIndices: [1] }]);
    // Every port rank is still recorded as skipped before the brief rank dispatches.
    expect(result.attempts.filter((a) => a.reason === 'source-session-untracked').length).toBeGreaterThan(0);
    expect(result.attempts.at(-1)).toMatchObject({ operation: 'brief', outcome: 'dispatched' });
    expect(calls.spawn).toHaveLength(1);
    const spawn = calls.spawn[0]!;
    // A distinct answering identity, never the expert's session.
    expect(spawn.coordOwnerId).not.toBe(OPTS.sourceOwnerId);
    expect(spawn.envelope.greetingCmd).not.toContain('--fork');
    expect(spawn.envelope.greetingCmd).not.toContain('sess-1');
    expect(spawn.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN).toBeUndefined();
    expect(spawn.envelope.env.CODEX_HOME).toBeUndefined();
    // The kickoff carries the quoted turn and says it is evidence, not history.
    const kickoff = spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT ?? '';
    expect(kickoff).toContain('the expert explained the lock order');
    expect(kickoff).toContain('sess-1#1');
    expect(kickoff).toContain('NOT your own history');
  });

  it('records evidence-span-unavailable per brief rank when no evidence span was supplied', async () => {
    const { deps, calls } = makeFakes({}, { source: { binding: null } });
    const { evidence: _omit, ...noEvidence } = OPTS;
    const result = await dispatchConsultResponder(noEvidence, CTX, deps);
    expect(result.dispatched).toBe(false);
    const briefs = result.attempts.filter((a) => a.operation === 'brief');
    expect(briefs.length).toBe(RANKS.length);
    expect(briefs.every((a) => a.outcome === 'skipped' && a.reason === 'evidence-span-unavailable')).toBe(true);
    expect(calls.spawn).toHaveLength(0);
  });

  it.each([
    ['empty', async () => []],
    ['throwing', async () => { throw new Error('archive offline'); }],
  ] as const)('records evidence-span-unavailable when the cited-turn read is %s', async (_label, readCitedTurns) => {
    const { deps, calls } = makeFakes({ readCitedTurns }, { source: { binding: null } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.dispatched).toBe(false);
    const briefs = result.attempts.filter((a) => a.operation === 'brief');
    expect(briefs.length).toBe(RANKS.length);
    expect(briefs.every((a) => a.reason === 'evidence-span-unavailable')).toBe(true);
    expect(calls.spawn).toHaveLength(0);
  });

  it('records account-walled for a brief rank whose backend is walled and briefs the next rank', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: agent !== 'claude', detail: 'provider capacity' }),
    }, { source: { binding: null } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result).toMatchObject({ dispatched: true, operation: 'brief', agent: 'codex' });
    expect(result.attempts.filter((a) => a.operation === 'brief').map((a) => a.reason ?? a.outcome))
      .toEqual(['account-walled', 'dispatched']);
    expect(calls.spawn).toHaveLength(1);
  });

  it('does not brief a source whose binding names another owner', async () => {
    const { deps, calls } = makeFakes({}, {
      source: { binding: { coordOwnerId: 'su-other-owner', sessionId: 'sess-1', startedAt: '2026-09-22T00:00:00Z' } },
    });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts.some((a) => a.operation === 'brief')).toBe(false);
    expect(calls.spawn).toHaveLength(0);
  });
});

describe('consult port-preflight brief fallback (EI-26911042163731548)', () => {
  const ranks: AllowedExpertModel[] = [
    { rank: 1, agent: 'codex', model: 'sol' },
    { rank: 2, agent: 'codex', model: 'astra' },
  ];
  const refusal = { available: false, detail: 'source span cannot be ported' };

  it.each(['missing', 'ambiguous'] as const)('refuses a real %s span once across ranks and launches only a fresh brief', async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-span-preflight-'));
    const path = join(dir, 'source.jsonl');
    const text = 'repeated native evidence';
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'question' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: text } },
      ...(kind === 'ambiguous' ? [
        { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: text } },
      ] : []),
    ];
    writeFileSync(path, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    try {
      const checkPortTranscript = vi.fn(checkConsultSessionPortTranscript);
      const readCitedTurns = vi.fn(async () => [
        { turn_idx: 1, speaker: 'assistant', ts: null, text: kind === 'missing' ? 'indexed evidence off active path' : text },
      ]);
      const { deps, calls } = makeFakes({ loadRanks: async () => ranks, checkPortTranscript, readCitedTurns,
        checkResumeTranscript: async () => ({ available: true, detail: 'real span fixture', transcriptPath: path }),
      });
      const result = await dispatchConsultResponder(OPTS, CTX, deps);
      expect(result).toMatchObject({ dispatched: true, operation: 'brief' });
      expect(result.attempts.slice(0, 2).every((a) => a.operation === 'convert' && a.reason === 'conversion-unavailable')).toBe(true);
      expect(result.attempts[0].detail).toMatch(kind === 'missing' ? /not present/ : /ambiguously/);
      expect(checkPortTranscript).toHaveBeenCalledTimes(1);
      expect(readCitedTurns).toHaveBeenCalledTimes(1);
      expect(calls.spawn).toHaveLength(1);
      expect(calls.spawn[0].envelope.greetingCmd).not.toMatch(/--resume|--fork/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can brief readable evidence after a thrown port preflight without repeating the source check', async () => {
    const checkPortTranscript = vi.fn(async () => { throw new Error('native source unavailable'); });
    const { deps, calls } = makeFakes({ loadRanks: async () => ranks, checkPortTranscript });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result).toMatchObject({ dispatched: true, operation: 'brief' });
    expect(checkPortTranscript).toHaveBeenCalledTimes(1);
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0].envelope.greetingCmd).not.toMatch(/--resume|--fork/);
  });

  it('keeps a refused explicit native trial from substituting a brief', async () => {
    const { deps, calls } = makeFakes({ loadRanks: async () => ranks, checkPortTranscript: async () => refusal });
    const result = await dispatchConsultResponder({ ...OPTS,
      nativeConsult: { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' },
    }, CTX, deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts.map((a) => a.operation)).toEqual(['convert', 'convert']);
    expect(calls.spawn).toHaveLength(0);
  });

  it('checks the selected source once and briefs readable cited turns under a distinct identity', async () => {
    const checkPortTranscript = vi.fn(async () => refusal);
    const readCitedTurns = vi.fn(async () => [
      { turn_idx: 1, speaker: 'assistant', ts: null, text: 'indexed expert evidence' },
    ]);
    const { deps, calls } = makeFakes({ loadRanks: async () => ranks, checkPortTranscript, readCitedTurns });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result).toMatchObject({ dispatched: true, operation: 'brief', answeringOwnerId: 'su-answer-1' });
    expect(checkPortTranscript).toHaveBeenCalledTimes(1);
    expect(checkPortTranscript.mock.calls[0]).toEqual([
      expect.objectContaining({ ownerId: OPTS.sourceOwnerId, sessionId: 'sess-1' }),
      expect.objectContaining({ available: true }),
      { sessionId: 'sess-1', turnIndices: [1], contextTurns: 2,
        evidenceTurns: [{ turnIdx: 1, speaker: 'assistant', timestamp: null, text: 'indexed expert evidence' }] },
    ]);
    expect(readCitedTurns).toHaveBeenCalledExactlyOnceWith(CTX.workspaceId, 'sess-1', [1]);
    expect(result.attempts.map((a) => [a.operation, a.reason ?? a.outcome])).toEqual([
      ['convert', 'conversion-unavailable'], ['convert', 'conversion-unavailable'], ['brief', 'dispatched'],
    ]);
    expect(calls.spawn).toHaveLength(1);
    const spawn = calls.spawn[0]!;
    expect(spawn.coordOwnerId).not.toBe(OPTS.sourceOwnerId);
    expect(spawn.envelope.greetingCmd).not.toMatch(/--resume|--fork/);
    expect(spawn.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN).toBeUndefined();
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('indexed expert evidence');
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('sess-1#1');
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('NOT your own history');
    expect(calls.recorded[0].result).toEqual(result);
  });

  it.each(['empty', 'throwing', 'partial', 'foreign-index', 'duplicate', 'blank'] as const)(
    'does not port or brief %s cited evidence', async (kind) => {
      const row = { turn_idx: 1, speaker: 'assistant', ts: null, text: 'indexed evidence' };
      const checkPortTranscript = vi.fn(async () => refusal);
      const readCitedTurns = vi.fn(async () => {
        if (kind === 'throwing') throw new Error('index unavailable');
        return kind === 'empty' ? [] : kind === 'foreign-index' ? [{ ...row, turn_idx: 9 }]
          : kind === 'duplicate' ? [row, row] : kind === 'blank' ? [{ ...row, text: ' ' }] : [row];
      });
      const { deps, calls } = makeFakes({ loadRanks: async () => ranks, checkPortTranscript, readCitedTurns });
      const result = await dispatchConsultResponder({ ...OPTS,
        evidence: kind === 'partial' ? [...OPTS.evidence, { session_id: 'sess-1', turn_idx: 2 }] : OPTS.evidence,
      }, CTX, deps);
      expect(result.dispatched).toBe(false);
      expect(result.attempts.filter((a) => a.operation === 'brief')).toHaveLength(2);
      expect(result.attempts.filter((a) => a.operation === 'brief').every((a) => a.reason === 'evidence-span-unavailable')).toBe(true);
      expect(readCitedTurns).toHaveBeenCalledTimes(1);
      expect(checkPortTranscript).not.toHaveBeenCalled();
      expect(calls.spawn).toHaveLength(0);
    });

  it.each(['owner', 'native-session'] as const)('does not brief contested %s attribution', async (kind) => {
    const readCitedTurns = vi.fn(async () => []);
    const { deps, calls } = makeFakes({ loadRanks: async () => ranks, readCitedTurns }, { source: {
      binding: { coordOwnerId: kind === 'owner' ? 'su-foreign' : OPTS.sourceOwnerId,
        sessionId: kind === 'native-session' ? 'foreign-session' : 'sess-1', startedAt: '2026-09-22T00:00:00Z' },
    } });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts.some((a) => a.operation === 'brief')).toBe(false);
    expect(readCitedTurns).not.toHaveBeenCalled();
    expect(calls.spawn).toHaveLength(0);
  });

  it('rechecks account routing before a brief and records a changed route refusal', async () => {
    let probes = 0;
    const { deps, calls } = makeFakes({
      loadRanks: async () => [ranks[0]], checkPortTranscript: async () => refusal,
      probeBackendAvailable: async () => ++probes === 1
        ? { available: true, detail: 'initial capacity' }
        : { available: false, detail: 'routing unknown', failureReason: 'account-routing-unavailable' },
    });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.attempts.at(-1)).toMatchObject({ operation: 'brief', reason: 'account-routing-unavailable' });
    expect(calls.spawn).toHaveLength(0);
  });

  it('does not launch a brief when the consult closes during source preflight', async () => {
    let open = true;
    const { deps, calls } = makeFakes({ loadRanks: async () => ranks,
      checkPortTranscript: async () => { open = false; return refusal; }, isConsultOpen: async () => open,
    });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(result.attempts.at(-1)).toMatchObject({ operation: 'brief', reason: 'consult-closed' });
    expect(calls.spawn).toHaveLength(0);
  });
});

describe('renderCitedTurnsBlock (P-002 brief evidence)', () => {
  const source = { ownerId: 'su-expert', sessionId: 'sess-9' };

  it('orders turns by index and labels them as quoted evidence', () => {
    const out = renderCitedTurnsBlock(source, [
      { turn_idx: 7, speaker: 'user', ts: null, text: 'second' },
      { turn_idx: 3, speaker: 'assistant', ts: '2026-10-01T00:00:00Z', text: 'first' },
    ]);
    expect(out.indexOf('sess-9#3')).toBeLessThan(out.indexOf('sess-9#7'));
    expect(out).toContain("quoted from su-expert's session sess-9");
    expect(out).toContain('you are not that session');
  });

  it('caps each turn and the total quoted text', () => {
    const long = 'x'.repeat(BRIEF_TURN_TEXT_MAX + 100);
    const turns = Array.from({ length: Math.ceil(BRIEF_TOTAL_TEXT_MAX / BRIEF_TURN_TEXT_MAX) + 2 },
      (_, i) => ({ turn_idx: i, speaker: 'assistant', ts: null, text: long }));
    const out = renderCitedTurnsBlock(source, turns);
    expect(out).not.toContain('x'.repeat(BRIEF_TURN_TEXT_MAX + 1));
    expect(out).toContain('brief cap');
    expect(out.length).toBeLessThan(BRIEF_TOTAL_TEXT_MAX + 2_000);
  });
});

describe('consult backend account-route preflight', () => {
  it('uses the default system route only for a confirmed gateway-off or empty-pool state', () => {
    expect(resolveConsultBackendAvailability('codex', {
      gatewayOn: false, poolAccountCount: null, poolHasHeadroom: null,
    })).toMatchObject({ available: true, accountRoute: 'default', routeReason: 'codex inference gateway is disabled' });
    expect(resolveConsultBackendAvailability('claude', {
      gatewayOn: true, poolAccountCount: 0, poolHasHeadroom: null,
    })).toMatchObject({ available: true, accountRoute: 'default', routeReason: 'claude provider pool is empty' });
  });

  it('uses auto only with a measured nonempty pool, and keeps measured account walls distinct', () => {
    expect(resolveConsultBackendAvailability('codex', {
      gatewayOn: true, poolAccountCount: 3, poolHasHeadroom: true,
    })).toMatchObject({ available: true, accountRoute: 'auto' });
    expect(resolveConsultBackendAvailability('claude', {
      gatewayOn: true, poolAccountCount: 2, poolHasHeadroom: false,
    })).toMatchObject({ available: false, accountRoute: 'auto', failureReason: 'account-walled' });
  });

  it('rejects an unknown gateway or pool preflight before any answering-session launch', async () => {
    const route = resolveConsultBackendAvailability('codex', {
      gatewayOn: null, poolAccountCount: null, poolHasHeadroom: null,
    });
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }],
      probeBackendAvailable: async () => route,
    });

    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({
      dispatched: false,
      attempts: [{ outcome: 'skipped', reason: 'account-routing-unavailable' }],
    });
    expect(calls.spawn).toHaveLength(0);
    expect(calls.recorded[0]!.result.attempts[0]!.detail).toContain('automatic launch was not attempted');
  });

  it('routes through the system account and persists the reason when auto routing is confirmed unavailable', async () => {
    const route = resolveConsultBackendAvailability('codex', {
      gatewayOn: false, poolAccountCount: null, poolHasHeadroom: null,
    });
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }],
      probeBackendAvailable: async () => route,
    });

    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
    expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--account=default');
    expect(result.attempts[0]).toMatchObject({
      accountRoute: 'default',
      accountRouteReason: 'codex inference gateway is disabled',
    });
    const entry = dispatchRecordEntry(calls.recorded[0]!, new Date(NOW_MS).toISOString()) as {
      attempts: Array<Record<string, unknown>>;
    };
    expect(entry.attempts[0]).toMatchObject({
      accountRoute: 'default',
      accountRouteReason: 'codex inference gateway is disabled',
    });
  });
});
