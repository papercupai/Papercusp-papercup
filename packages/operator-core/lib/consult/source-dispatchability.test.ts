/**
 * WI-6554700010009982 — routed candidates whose transcript the dispatch walk can
 * never open (no native file, no archive) must not occupy a consult or grading
 * menu seat. Measured: a grading cascade seated three such sources, every walk
 * refused pre-launch `not_archived`, and the plan waited on the 4h expiry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeTarget } from '../agent-launch-core';
import type { RouteResult, RoutingCandidate } from './relevance-router';
import {
  filterDispatchableRoute,
  probeConsultSourceDispatchable,
  type SourceDispatchabilityObservation,
} from './source-dispatchability';
import { probeConsultResumeTranscript } from './resume-transcript-preflight';
import { probeTranscriptArchive } from '../session-transcript-remat';

const findSessionTranscript = vi.hoisted(() => vi.fn<(id: string, opts?: unknown) => Promise<string | null>>());
vi.mock('../claude-sessions', () => ({ findSessionTranscript }));

beforeEach(() => {
  findSessionTranscript.mockReset();
  findSessionTranscript.mockResolvedValue(null);
});

const cand = (ownerId: string): RoutingCandidate => ({ ownerId, evidence: [] } as unknown as RoutingCandidate);
const route = (owners: string[], qualified = owners, verdict: RouteResult['verdict'] = 'routed'): RouteResult => ({
  verdict,
  qualified: qualified.map(cand),
  snapshot: { candidates: owners.map(cand) },
} as unknown as RouteResult);
const obs = (ownerId: string, dispatchable: boolean | null): SourceDispatchabilityObservation =>
  ({ ownerId, dispatchable, detail: `fixture ${String(dispatchable)}` });

describe('filterDispatchableRoute', () => {
  it('drops measured-undispatchable sources from both pools and keeps unknown ones, in rank order', async () => {
    const verdicts: Record<string, boolean | null> = { dead: false, live: true, unknown: null, ended: true };
    const out = await filterDispatchableRoute(
      route(['dead', 'live', 'unknown', 'ended'], ['dead', 'live']),
      async (c) => obs(c.ownerId, verdicts[c.ownerId]!),
    );
    expect(out.snapshot.candidates.map((c) => c.ownerId)).toEqual(['live', 'unknown', 'ended']);
    expect(out.qualified.map((c) => c.ownerId)).toEqual(['live']);
    expect(out.verdict).toBe('routed');
    expect(out.snapshot.undispatchableSources).toEqual([obs('dead', false)]);
  });

  it('the measured incident: an all-dead qualified pool becomes no_qualified_responder, never a dead menu', async () => {
    const out = await filterDispatchableRoute(
      route(['su-0b88f408', 'su-74f97ac7', 'su-2d3f55a2', 'su-alive'], ['su-0b88f408', 'su-74f97ac7', 'su-2d3f55a2']),
      async (c) => obs(c.ownerId, c.ownerId === 'su-alive'),
    );
    expect(out.qualified).toEqual([]);
    expect(out.verdict).toBe('no_qualified_responder');
    // The minimum-fill pool still offers the dispatchable source.
    expect(out.snapshot.candidates.map((c) => c.ownerId)).toEqual(['su-alive']);
  });

  it('returns the route untouched when nothing is removed (no disclosure noise)', async () => {
    const input = route(['a', 'b']);
    expect(await filterDispatchableRoute(input, async (c) => obs(c.ownerId, null))).toBe(input);
  });

  it('fails OPEN: a probe that throws keeps its candidate', async () => {
    const out = await filterDispatchableRoute(route(['boom', 'dead']), async (c) => {
      if (c.ownerId === 'boom') throw new Error('pg down');
      return obs(c.ownerId, false);
    });
    expect(out.snapshot.candidates.map((c) => c.ownerId)).toEqual(['boom']);
  });

  it('removes a candidate whose persisted launch failures put it on cooldown before selection', async () => {
    const readCooldown = vi.fn(async () => ({
      failures: 3,
      until: '2026-10-14T17:00:00.000Z',
      lastFailure: 'kickoff-not-persisted on claude/opus',
    }));
    const out = await filterDispatchableRoute(
      route(['cooling']),
      (candidate, workspaceId) => probeConsultSourceDispatchable(candidate, workspaceId, { readCooldown }),
      { workspaceId: 'workspace-1' },
    );
    expect(readCooldown).toHaveBeenCalledWith('workspace-1', 'cooling', expect.any(Number));
    expect(out.snapshot.candidates).toEqual([]);
    expect(out.qualified).toEqual([]);
    expect(out.verdict).toBe('no_qualified_responder');
    expect(out.snapshot.undispatchableSources).toEqual([{
      ownerId: 'cooling',
      dispatchable: false,
      detail: 'source launch cooldown until 2026-10-14T17:00:00.000Z: kickoff-not-persisted on claude/opus',
    }]);
  });

  it('fails open when the persisted cooldown read is unavailable', async () => {
    const out = await filterDispatchableRoute(
      route(['cooling']),
      (candidate, workspaceId) => probeConsultSourceDispatchable(candidate, workspaceId, {
        readCooldown: async () => { throw new Error('pg unavailable'); },
      }),
      { workspaceId: 'workspace-1' },
    );
    expect(out).toEqual(expect.objectContaining({
      qualified: expect.any(Array),
      snapshot: expect.objectContaining({ candidates: expect.any(Array) }),
    }));
    expect(out.snapshot.candidates.map((candidate) => candidate.ownerId)).toEqual(['cooling']);
  });

  it('fails OPEN: candidates not probed within the budget are kept', async () => {
    const out = await filterDispatchableRoute(
      route(['fast-dead', 'slow-dead']),
      async (c) => {
        if (c.ownerId === 'slow-dead') await new Promise((r) => setTimeout(r, 200));
        return obs(c.ownerId, false);
      },
      { concurrency: 2, budgetMs: 20 },
    );
    expect(out.snapshot.candidates.map((c) => c.ownerId)).toEqual(['slow-dead']);
  });

  it('leaves an unmeasured route verdict alone', async () => {
    const out = await filterDispatchableRoute(route(['dead'], [], 'relevance_unmeasured'), async (c) => obs(c.ownerId, false));
    expect(out.verdict).toBe('relevance_unmeasured');
  });
});

describe('probeTranscriptArchive (read-only)', () => {
  it('reports a claude session with a stamp as archived and one without as not_archived', async () => {
    const hasArchiveStamp = vi.fn(async (_kind: string, id: string) => id === 'kept');
    const deps = { findArchivedSessionIdForAdv: async () => null, hasArchiveStamp };
    expect(await probeTranscriptArchive({ kind: 'claude', sessionId: 'kept' }, deps))
      .toEqual({ archived: true, reason: 'archived' });
    expect(await probeTranscriptArchive({ kind: 'claude', sessionId: '1353e87b' }, deps))
      .toEqual({ archived: false, reason: 'not_archived' });
    expect(hasArchiveStamp).toHaveBeenCalledWith('claude', '1353e87b');
  });

  it('keys a codex adv id through the archive index; no index row is a measured absence', async () => {
    const hasArchiveStamp = vi.fn(async () => true);
    const deps = { findArchivedSessionIdForAdv: async (adv: number) => (adv === 7 ? 'rollout-7' : null), hasArchiveStamp };
    expect(await probeTranscriptArchive({ kind: 'codex-session-key', sessionKey: '7' }, deps)).toMatchObject({ archived: true });
    expect(hasArchiveStamp).toHaveBeenCalledWith('codex', 'rollout-7');
    expect(await probeTranscriptArchive({ kind: 'codex-session-key', sessionKey: '8' }, deps))
      .toEqual({ archived: false, reason: 'no_archive_key' });
  });

  it('reports a store fault as UNKNOWN, never as absent', async () => {
    const boom = async () => { throw new Error('pg down'); };
    expect(await probeTranscriptArchive({ kind: 'claude', sessionId: 'x' }, { findArchivedSessionIdForAdv: async () => null, hasArchiveStamp: boom }))
      .toEqual({ archived: null, reason: 'unavailable' });
    expect(await probeTranscriptArchive({ kind: 'codex-session-key', sessionKey: '7' }, { findArchivedSessionIdForAdv: boom, hasArchiveStamp: async () => true }))
      .toEqual({ archived: null, reason: 'unavailable' });
  });
});

describe('probeConsultResumeTranscript (read-only selection twin of the walk preflight)', () => {
  const target = (extra: Partial<ResumeTarget> = {}): ResumeTarget =>
    ({ agent: 'claude', role: null, sessionId: 'sess-1', ownerId: 'su-x', ompThreadId: null, advSessionId: 1, ...extra } as ResumeTarget);

  it('a present native transcript is dispatchable without touching the archive', async () => {
    findSessionTranscript.mockResolvedValue('/tmp/sess-1.jsonl');
    const probeArchive = vi.fn();
    expect(await probeConsultResumeTranscript(target(), { probeArchive })).toMatchObject({ dispatchable: true });
    expect(probeArchive).not.toHaveBeenCalled();
  });

  it('no native file and no archive is a measured absence — the incident shape', async () => {
    const out = await probeConsultResumeTranscript(target(), {
      probeArchive: async () => ({ archived: false, reason: 'not_archived' }),
    });
    expect(out).toEqual({ dispatchable: false, detail: 'native transcript absent on disk and not_archived' });
  });

  it('no native file but an archive stamp is dispatchable (the walk restores it)', async () => {
    expect(await probeConsultResumeTranscript(target(), {
      probeArchive: async () => ({ archived: true, reason: 'archived' }),
    })).toMatchObject({ dispatchable: true });
  });

  it('an unknown archive state stays unknown', async () => {
    expect(await probeConsultResumeTranscript(target(), {
      probeArchive: async () => ({ archived: null, reason: 'unavailable' }),
    })).toMatchObject({ dispatchable: null });
  });

  it('a native lookup fault is unknown, not absent', async () => {
    findSessionTranscript.mockRejectedValue(new Error('EACCES'));
    expect(await probeConsultResumeTranscript(target(), {
      probeArchive: async () => ({ archived: false, reason: 'not_archived' }),
    })).toMatchObject({ dispatchable: null });
  });

  it('targets the walk refuses identically are undispatchable', async () => {
    expect(await probeConsultResumeTranscript(target({ sessionId: null }))).toMatchObject({ dispatchable: false });
    expect(await probeConsultResumeTranscript(target({ agent: 'gemini' }))).toMatchObject({ dispatchable: false });
  });
});
