import { describe, expect, it, vi } from 'vitest';
import { buildAgentLaunchCommand, injectLaunchedByArg } from '../agent-launch-core';
import {
  dispatchConsultResponder,
  rankConsultEvidenceSources,
  selectConsultEvidenceSource,
  type ConsultDispatchDeps,
  type ConsultDispatchEvidenceRef,
} from './consult-dispatch';
import { summarizePreLaunchRefusals } from './get-feedback-core';
import type { AllowedExpertModel } from './expert-model-allowlist';

const context = { workspaceId: 'ws', harnessSlug: 'papercusp', launchedBy: 'su-requester' };
const targetFor = (sessionId: string) => ({
  ok: true as const,
  sessionId,
  resumeId: sessionId,
  ompThreadId: null,
  ownerId: 'su-expert',
  agent: 'claude',
  cwd: '/source',
  model: null,
  modelSource: null,
  endedAt: '2026-09-22T00:00:00.000Z',
  endedBy: 'self' as const,
  live: false,
  advSessionId: 17,
  binding: {
    coordOwnerId: 'su-expert',
    sessionId,
    startedAt: '2026-09-22T00:00:00.000Z',
  },
});

function depsFor(input: { ranks: AllowedExpertModel[]; resolved?: string[] }) {
  const launched: Array<Parameters<ConsultDispatchDeps['spawnHeadless']>[0]> = [];
  const resolved: unknown[] = [];
  let minted = 0;
  const deps: Partial<ConsultDispatchDeps> = {
    isConsultOpen: async () => true,
    resolveResumeTarget: vi.fn(async (ref: { agentId?: string | null; sessionId?: string | null }) => {
      resolved.push(ref);
      const sessionId = ref.sessionId ?? input.resolved?.[0] ?? 'latest-session';
      return targetFor(sessionId);
    }) as never,
    checkResumeTranscript: async () => ({ available: true, detail: 'source is readable' }),
    // These synthetic sessions have no native file; conversion-path tests keep the port preflight isolated.
    checkPortTranscript: async () => ({ available: true, detail: 'fixture source passes session-port preflight' }),
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope: async () => ({ cwd: '/fallback', env: { BASE: '1' }, greetingCmd: '' }) as never,
    spawnHeadless: async (options: Parameters<ConsultDispatchDeps['spawnHeadless']>[0]) => {
      launched.push(options);
      return {
        status: 'ok', pid: 12, terminal: 'headless', logPath: '/logs/consult', child: null, display: null,
        kickoffProof: { persisted: true, nativeRef: '/native/answer.jsonl', reason: null },
      } as Awaited<ReturnType<ConsultDispatchDeps['spawnHeadless']>>;
    },
    verifyResumeStarted: (async (_ownerId: string) => ({ started: true, waitedMs: 1 })) as never,
    fetchContextPressure: async () => new Map(),
    probeBackendAvailable: async () => ({ available: true, detail: 'headroom' }),
    mintOwnerId: () => `su-answer-${++minted}`,
    loadRanks: async () => input.ranks,
    // Unit tier: the default recorder writes through the real org pool (WI-10003197).
    readLaunchLogReason: async () => null,
    recordDispatchAttempts: async () => {},
    // Likewise the cool-down reader (WI-10003198): no history ⇒ no cool-down.
    readSourceDispatchRecords: async () => [],
  };
  return { deps, launched, resolved };
}

describe('P-007 consult evidence span routing', () => {
  it('uses the exact highest-ranked evidence session and passes only its refs to conversion', async () => {
    const evidence: ConsultDispatchEvidenceRef[] = [
      { session_id: 'session-weaker', turn_idx: 8, sim: 0.62 },
      { session_id: 'session-best', turn_idx: 4, sim: 0.91 },
      { session_id: 'session-best', turn_idx: 6, sim: 0.83 },
    ];
    expect(selectConsultEvidenceSource(evidence)).toEqual({
      sessionId: 'session-best',
      evidence: [evidence[1], evidence[2]],
    });

    const fakes = depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] });
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert',
      conversationId: 'conv-evidence',
      evidence,
      brief: 'answer from the selected evidence',
    }, context, fakes.deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', answeringOwnerId: 'su-answer-1' });
    expect(fakes.resolved).toEqual([{ sessionId: 'session-best' }]);
    const env = fakes.launched[0]!.envelope.env;
    expect(fakes.launched[0]!.coordOwnerId).toBe('su-answer-1');
    expect(fakes.launched[0]!.coordOwnerId).not.toBe('su-expert');
    expect(JSON.parse(env.PAPERCUSP_CONSULT_EVIDENCE_SPAN!)).toEqual({
      sessionId: 'session-best',
      turnIndices: [4, 6],
      contextTurns: 2,
    });
    expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain('session-best#4; session-best#6');
    expect(env.PAPERCUSP_KICKOFF_PROMPT).not.toContain('session-weaker#8');
  });

  it('does not fall back to a full-transcript conversion when exact evidence is absent', async () => {
    const fakes = depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] });
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert', conversationId: 'conv-no-evidence', brief: 'answer',
    }, context, fakes.deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts).toMatchObject([{ operation: 'convert', outcome: 'skipped', reason: 'evidence-span-unavailable' }]);
    expect(fakes.launched).toHaveLength(0);
  });
});

// EI-24833606853730057: a consult fork's seed copy replays its source's turns with the
// same ts/turn_idx, so one hit ties across sessions owned by DIFFERENT agents. The
// measured failure: the alphabetical tie-break took a foreign copy, dispatch refused on
// ownership, and every walk of two rubric-vetting consults launched nothing.
describe('EI-24833606853730057 evidence sessions tied across fork copies', () => {
  const owners: Record<string, string> = {
    '0b0ccf95-foreign-seed-copy': 'su-original-author',
    '1010aec4-candidate-own': 'su-expert',
    '99e0584c-other-fork': 'su-other-fork',
  };
  const tied: ConsultDispatchEvidenceRef[] = Object.keys(owners).map((session_id) => ({
    session_id, turn_idx: 11, sim: 0.83, ts: '2026-09-30T17:12:41.858Z',
  }));
  const withOwners = (fakes: ReturnType<typeof depsFor>, map: Record<string, string>) => {
    fakes.deps.resolveResumeTarget = vi.fn(async (ref: { agentId?: string | null; sessionId?: string | null }) => {
      fakes.resolved.push(ref);
      const sessionId = ref.sessionId ?? 'latest-session';
      return { ...targetFor(sessionId), ownerId: map[sessionId] ?? 'su-expert' };
    }) as never;
    return fakes;
  };

  it('ranks every evidence session and keeps the tie order the single pick used', () => {
    expect(rankConsultEvidenceSources(tied).map((s) => s.sessionId)).toEqual([
      '0b0ccf95-foreign-seed-copy', '1010aec4-candidate-own', '99e0584c-other-fork',
    ]);
    expect(selectConsultEvidenceSource(tied)?.sessionId).toBe('0b0ccf95-foreign-seed-copy');
  });

  it('dispatches from the candidate’s OWN session when a foreign seed copy wins the tie', async () => {
    const fakes = withOwners(depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] }), owners);
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert', conversationId: 'conv-tied', evidence: tied, brief: 'answer',
    }, context, fakes.deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', answeringOwnerId: 'su-answer-1' });
    // Tried in rank order and stopped at the first session the candidate owns.
    expect(fakes.resolved).toEqual([
      { sessionId: '0b0ccf95-foreign-seed-copy' }, { sessionId: '1010aec4-candidate-own' },
    ]);
    const span = JSON.parse(fakes.launched[0]!.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN!);
    expect(span.sessionId).toBe('1010aec4-candidate-own');
  });

  it('refuses only when NO evidence session belongs to the candidate, naming every one tried', async () => {
    const foreign = { ...owners, '1010aec4-candidate-own': 'su-someone-else' };
    const fakes = withOwners(depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] }), foreign);
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert', conversationId: 'conv-all-foreign', evidence: tied, brief: 'answer',
    }, context, fakes.deps);

    expect(result.dispatched).toBe(false);
    expect(result.attempts).toEqual([]);
    expect(result.detail).toContain('no evidence session resolves to su-expert (3 tried)');
    for (const session of Object.keys(owners)) expect(result.detail).toContain(session);
    expect(fakes.launched).toHaveLength(0);
  });
});

describe('EI-24833606853730057 summarizePreLaunchRefusals', () => {
  it('separates walks refused before any rank from walks whose ranks were tried', () => {
    const refusedWalk = { dispatched: false, attempts: [], detail: 'evidence session ownership changed: a resolves to b' };
    const walledWalk = { dispatched: false, attempts: [{ outcome: 'skipped', reason: 'backend-walled' }], detail: 'walled' };
    expect(summarizePreLaunchRefusals([refusedWalk, refusedWalk, { dispatched: true, attempts: [{}] }])).toEqual({
      total: 2, refused: 2, details: ['evidence session ownership changed: a resolves to b'],
    });
    expect(summarizePreLaunchRefusals([refusedWalk, walledWalk])).toMatchObject({ total: 2, refused: 1 });
    expect(summarizePreLaunchRefusals(null)).toEqual({ total: 0, refused: 0, details: [] });
  });
});
