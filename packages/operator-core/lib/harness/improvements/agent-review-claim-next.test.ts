/**
 * EI-24720168531118378: `claimNextAgentReview` must never hand a reviewer a pending round whose
 * ledger row ALREADY carries a standing grade. `enterAgentReview` enrolls with `preserveExisting`,
 * so a pre-existing su-ideate row the owner had already graded keeps that sovereign grade while the
 * payload starts at 'pending'; handing it out made the reviewer spend a review on a foregone
 * conclusion and (before the holder-CAS fix) strand the claim. The pickup converges it instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItem } from '../../work-items';
import { buildP2pLaneFence } from '../../scheduler/p2p-lane-fence';

const h = vi.hoisted(() => ({ rows: [] as Array<{ feature_id: string }>, sqlSources: [] as string[] }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  // A tagged-template fake: the pickup query (and every nested SQL fragment builder) resolves to
  // the candidate rows. The rows are what is under test here, not the SQL text. Partial mock so
  // the package's other exports (other modules import them at load) stay real.
  const sql: any = (strings: TemplateStringsArray, ..._args: unknown[]) => {
    h.sqlSources.push(Array.from(strings).join(' '));
    return Promise.resolve(h.rows);
  };
  sql.unsafe = sql;
  sql.json = (v: unknown) => v;
  sql.array = (v: unknown) => v;
  return { ...(await importOriginal<Record<string, unknown>>()), getOrgPg: () => ({ sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

import {
  claimNextAgentReview,
  type AgentReviewDeps,
  type AgentReviewLedgerGrade,
} from './agent-review';

function item(id: string, round = 1): WorkItem {
  return {
    id,
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: `Proposal ${id}`,
    summary: 'body',
    severity: 'minor',
    state: 'open',
    assignee: null,
    payload: {
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: id, round },
    },
    origin: 'local',
  } as unknown as WorkItem;
}

function build(ledger: Record<string, AgentReviewLedgerGrade | null>) {
  const items = new Map<string, WorkItem>([['WI-A', item('WI-A')], ['WI-B', item('WI-B')]]);
  const claimWorkItem = vi.fn(async (id: string, assignee: string) => {
    const current = items.get(id)!;
    const claimed = { ...current, assignee } as WorkItem;
    items.set(id, claimed);
    return claimed;
  });
  const mergeWorkItemPayload = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const current = items.get(id)!;
    const next = { ...current, payload: { ...(current.payload as object), ...patch } } as WorkItem;
    items.set(id, next);
    return next;
  });
  const releaseWorkItem = vi.fn(async (id: string) => {
    const current = items.get(id);
    if (!current) return null;
    const released = { ...current, assignee: null };
    items.set(id, released);
    return released;
  });
  const commentWorkItem = vi.fn(async () => ({}) as never);
  const deps = {
    getWorkItem: vi.fn(async (id: string) => items.get(id) ?? null),
    getWorkItemDetail: vi.fn(async (id: string) => ({ ...items.get(id), posts: [], topics: [], links: [] }) as never),
    mergeWorkItemPayload,
    releaseWorkItem,
    claimWorkItem,
    commentWorkItem,
    readLedgerGrade: vi.fn(async (ideaId: string) => ledger[ideaId] ?? null),
    deliverRevision: vi.fn(async () => ({ woken: 0 })),
    healOwnNodeOrigin: vi.fn(async () => false),
  } as unknown as AgentReviewDeps;
  return { items, deps, claimWorkItem, mergeWorkItemPayload, releaseWorkItem };
}

// WI-10006314 — `origin` records how a row ARRIVED, not who wrote it. The pickup selector does not
// filter on origin, so an own-node pending row stranded at 'remote' used to be selected and then
// silently skipped as 'remote-owned'. It must be healed and handed out; a foreign one stays skipped.
describe('P-026 review pickup scope and cancellation', () => {
  beforeEach(() => { h.rows = [{ feature_id: 'WI-A' }, { feature_id: 'WI-B' }]; h.sqlSources = []; });

  it('uses the stored review projection in the candidate lookup (EI-25555666233005302)', async () => {
    const { deps } = build({});

    await claimNextAgentReview({ reviewer: 'su-reviewer' }, deps);

    expect(h.sqlSources.some(source => source.includes("agent_review_projection ->> 'status' = 'pending'"))).toBe(true);
    expect(h.sqlSources.join('\n')).not.toContain("-> 'agentReview' ->> 'status' = 'pending'");
  });

  it('reports bounded lookup and per-candidate timings through the opt-in diagnostics callback', async () => {
    const { deps } = build({});
    const onDiagnostics = vi.fn();

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', onDiagnostics }, deps);

    expect(claimed?.id).toBe('WI-A');
    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics).toMatchObject({
      schemaVersion: 'agent-review-claim-next-v1',
      unit: 'ms',
      candidateLimit: 25,
      candidateCount: 2,
      candidatesProcessed: 1,
      stages: [
        { name: 'candidateLookup', status: 'ok', candidateCount: 2 },
        {
          name: 'candidate',
          candidateIndex: 1,
          outcome: 'claimed',
          phases: {
            getWorkItem: { status: 'ok' },
            healOwnNodeRemoteOrigin: { status: 'ok' },
            readLedgerGrade: { status: 'ok' },
            claimVerificationCandidate: { status: 'ok' },
          },
        },
      ],
    });
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.stages[1]).not.toHaveProperty('candidateId');
  });

  it('skips an excluded proposal before its ledger or claim is touched', async () => {
    const { items, deps, claimWorkItem } = build({});
    items.set('WI-A', { ...items.get('WI-A')!, sourcePlanSlug: 'p2p-release' });
    expect((await claimNextAgentReview({ reviewer: 'su-reviewer', filter: buildP2pLaneFence() }, deps))?.id).toBe('WI-B');
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    expect(deps.readLedgerGrade).not.toHaveBeenCalledWith('WI-A');
  });

  it('releases a scope change racing the review claim', async () => {
    const { items, deps, claimWorkItem, releaseWorkItem } = build({});
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      const claimed = { ...items.get(id)!, assignee, sourcePlanSlug: 'p2p-release' };
      items.set(id, claimed);
      return claimed;
    });
    expect((await claimNextAgentReview({ reviewer: 'su-reviewer', filter: buildP2pLaneFence() }, deps))?.id).toBe('WI-B');
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-A', {
      harness: 'papercusp', expectedAssignee: 'su-reviewer', announceClaimable: false,
    });
    expect(items.get('WI-A')!.assignee).toBeNull();
  });

  it('propagates an uncertain review claim after reconciling, without trying the next candidate', async () => {
    const { items, deps, claimWorkItem } = build({});
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      items.set(id, { ...items.get(id)!, assignee });
      throw new Error('review response lost');
    });
    await expect(claimNextAgentReview({ reviewer: 'su-reviewer' }, deps)).rejects.toThrow('review response lost');
    expect(items.get('WI-A')!.assignee).toBeNull();
    expect(claimWorkItem).toHaveBeenCalledOnce();
  });

  it('releases a claim completed during cancellation and never retries', async () => {
    const { items, deps, claimWorkItem } = build({});
    const abort = new AbortController();
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      const claimed = { ...items.get(id)!, assignee };
      items.set(id, claimed);
      abort.abort(new Error('cancelled review'));
      return claimed;
    });
    await expect(claimNextAgentReview({ reviewer: 'su-reviewer', signal: abort.signal }, deps)).rejects.toThrow('cancelled review');
    expect(items.get('WI-A')!.assignee).toBeNull();
    expect(claimWorkItem).toHaveBeenCalledOnce();
  });
});

describe('claimNextAgentReview heals own-node rows stranded at origin=remote', () => {
  beforeEach(() => {
    h.rows = [{ feature_id: 'WI-A' }, { feature_id: 'WI-B' }];
  });

  function withRemoteA(ownNode: boolean) {
    const t = build({});
    t.items.set('WI-A', { ...t.items.get('WI-A')!, origin: 'remote' } as WorkItem);
    const healOwnNodeOrigin = vi.fn(async (_workspaceId: string, id: string) => {
      const current = t.items.get(id)!;
      if (!ownNode || current.origin !== 'remote') return false;
      t.items.set(id, { ...current, origin: 'local' } as WorkItem);
      return true;
    });
    (t.deps as unknown as { healOwnNodeOrigin: typeof healOwnNodeOrigin }).healOwnNodeOrigin = healOwnNodeOrigin;
    return { t, healOwnNodeOrigin };
  }

  it('hands out the own-node row instead of skipping it', async () => {
    const { t, healOwnNodeOrigin } = withRemoteA(true);
    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);
    expect(claimed?.id).toBe('WI-A');
    expect(healOwnNodeOrigin).toHaveBeenCalledWith(expect.any(String), 'WI-A', 'papercusp');
    expect(t.items.get('WI-A')!.origin).toBe('local');
  });

  it('still skips a FOREIGN remote row and claims the next one', async () => {
    const { t } = withRemoteA(false);
    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);
    expect(claimed?.id).toBe('WI-B');
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    expect(t.items.get('WI-A')!.origin).toBe('remote');
  });
});

describe('claimNextAgentReview skips and converges rows the ledger already settled', () => {
  beforeEach(() => {
    h.rows = [{ feature_id: 'WI-A' }, { feature_id: 'WI-B' }];
  });

  it('does not hand out an owner-graded pending row; it converges it and claims the next pending one', async () => {
    const t = build({
      'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: 4, feedback: null, gradedBy: 'owner' },
    });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-B');
    // WI-A was never claimed by the reviewer…
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    // …and its payload converged to the standing (owner) grade instead of staying pending forever.
    expect((t.items.get('WI-A')!.payload as any).agentReview.status).toBe('approved');
  });

  it('skips (never hands out) a settled row that cannot converge, without throwing', async () => {
    // A low standing grade with no feedback makes reconcile throw 'agent-review-feedback-required'.
    const t = build({
      'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: 2, feedback: null, gradedBy: 'owner' },
    });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-B');
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    expect((t.items.get('WI-A')!.payload as any).agentReview.status).toBe('pending');
  });

  it('hands out a resubmitted round whose ledger still carries the PRIOR round grade (WI-10005365)', async () => {
    // Round 1 was graded 3/5 with feedback; the submitter revised and resubmitted, which advances
    // the round without clearing the ledger row. That grade decided round 1 — it is not a
    // verdict on round 2, so the pickup must not replay it.
    const t = build({
      'WI-A': {
        ideaId: 'WI-A',
        workItemId: 'WI-A',
        grade: 3,
        feedback: 'round-1 asks, already answered by the revision',
        gradedBy: 'su-round1-reviewer',
      },
    });
    t.items.set('WI-A', item('WI-A', 2));

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-A');
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-A']);
    const review = (t.items.get('WI-A')!.payload as any).agentReview;
    expect(review).toMatchObject({ status: 'pending', round: 2 });
    expect(t.deps.deliverRevision).not.toHaveBeenCalled();
  });

  it('still claims an ordinary pending row whose ledger row carries no standing grade', async () => {
    const t = build({ 'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: null, feedback: null, gradedBy: null } });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-A');
  });
});
