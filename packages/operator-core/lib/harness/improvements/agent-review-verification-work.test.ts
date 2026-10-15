/**
 * P-007 Phase B (D-027): one verifier-lane pull serves pending agent reviews FIRST, then
 * verification tasks. Both legs claim through the injected by-id writer (claimWorkItem), which
 * enforces the D-021 conflict rule, the floors and admission, so the self-select SQL only orders
 * candidates. The real SQL predicate (who is refused) is covered by the integration suite; here
 * the SQL is a fake that answers by which pool the query reads, and what is under test is the
 * ordering and the writer hand-off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItem } from '../../work-items';

const h = vi.hoisted(() => ({
  reviewRows: [] as Array<{ feature_id: string }>,
  taskRows: [] as Array<{ feature_id: string; harness_slug: string | null }>,
  queries: [] as string[],
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  // A tagged-template fake: a query whose text selects payload.verification objects is the
  // verification-task pool; any other top-level query is the agent-review pool. Nested fragment
  // builders resolve too, but their values are only interpolated, never read.
  const sql: any = (strings: TemplateStringsArray | unknown, ..._values: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as readonly string[]).join('?') : '';
    if (text.includes('FROM harness_shared.work_items')) h.queries.push(text);
    if (text.includes("-> 'verification') = 'object'")) return Promise.resolve(h.taskRows);
    if (text.includes('FROM harness_shared.work_items')) return Promise.resolve(h.reviewRows);
    return Promise.resolve([]);
  };
  sql.unsafe = sql;
  sql.json = (v: unknown) => v;
  sql.array = (v: unknown) => v;
  return { ...(await importOriginal<Record<string, unknown>>()), getOrgPg: () => ({ sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

import { claimNextVerificationTask, claimNextVerificationWork, type AgentReviewDeps } from './agent-review';
import { buildP2pLaneFence } from '../../scheduler/p2p-lane-fence';

function review(id: string): WorkItem {
  return {
    id,
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: `Proposal ${id}`,
    summary: 'body',
    state: 'open',
    assignee: null,
    payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: id, round: 2 } },
    origin: 'local',
  } as unknown as WorkItem;
}

function task(id: string): WorkItem {
  return {
    id,
    kind: 'task',
    family: 'feature',
    harness: 'papercusp',
    title: `Verify ${id}`,
    state: 'open',
    assignee: null,
    payload: { verification: { schemaVersion: 'verification-task-v1', subject: 'WI-S', check: 'completion' } },
    origin: 'local',
  } as unknown as WorkItem;
}

function build(refuse: ReadonlySet<string> = new Set()) {
  const items = new Map<string, WorkItem>();
  for (const r of h.reviewRows) items.set(r.feature_id, review(r.feature_id));
  for (const t of h.taskRows) items.set(t.feature_id, task(t.feature_id));
  const claimWorkItem = vi.fn(async (id: string, assignee: string, _opts?: unknown) => {
    if (refuse.has(id)) return null;
    const claimed = { ...items.get(id)!, assignee } as WorkItem;
    items.set(id, claimed);
    return claimed;
  });
  const deps = {
    getWorkItem: vi.fn(async (id: string) => items.get(id) ?? null),
    getWorkItemDetail: vi.fn(async (id: string) => ({ ...items.get(id), posts: [], topics: [], links: [] }) as never),
    mergeWorkItemPayload: vi.fn(async (id: string) => items.get(id) ?? null),
    releaseWorkItem: vi.fn(async (id: string, opts: { expectedAssignee?: string }) => {
      const current = items.get(id);
      if (!current) return null;
      if (current.assignee !== opts.expectedAssignee) return current;
      const released = { ...current, assignee: null };
      items.set(id, released);
      return released;
    }),
    claimWorkItem,
    commentWorkItem: vi.fn(async () => ({}) as never),
    readLedgerGrade: vi.fn(async () => null),
    deliverRevision: vi.fn(async () => ({ woken: 0 })),
    healOwnNodeOrigin: vi.fn(async () => false),
  } as unknown as AgentReviewDeps;
  return { deps, claimWorkItem, items };
}

describe('claimNextVerificationWork — pending reviews first, then verification tasks (P-007 Phase B)', () => {
  beforeEach(() => {
    h.reviewRows = [];
    h.taskRows = [];
    h.queries = [];
  });

  it('serves a pending agent review before any verification task, and never reads the task pool', async () => {
    h.reviewRows = [{ feature_id: 'EI-REVIEW' }];
    h.taskRows = [{ feature_id: 'WI-TASK', harness_slug: 'papercusp' }];
    const { deps, claimWorkItem } = build();

    const served = await claimNextVerificationWork({ verifier: 'su-verifier', harnessSlug: 'papercusp' }, deps);

    expect(served?.kind).toBe('agent-review');
    expect(served?.workItem.id).toBe('EI-REVIEW');
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['EI-REVIEW']);
    expect(h.queries.some((q) => q.includes("-> 'verification') = 'object'"))).toBe(false);
  });

  it('falls through to a verification task when no review is pending', async () => {
    h.taskRows = [{ feature_id: 'WI-TASK', harness_slug: 'papercusp' }];
    const { deps, claimWorkItem } = build();

    const served = await claimNextVerificationWork({ verifier: 'su-verifier', harnessSlug: 'papercusp' }, deps);

    expect(served?.kind).toBe('verification-task');
    expect(served?.workItem.id).toBe('WI-TASK');
    expect(served?.workItem.assignee).toBe('su-verifier');
    expect(claimWorkItem).toHaveBeenCalledWith('WI-TASK', 'su-verifier', { harness: 'papercusp' });
  });

  it('falls through to a verification task when every pending review is refused by the writer', async () => {
    h.reviewRows = [{ feature_id: 'EI-REVIEW' }];
    h.taskRows = [{ feature_id: 'WI-TASK', harness_slug: 'papercusp' }];
    const { deps } = build(new Set(['EI-REVIEW']));

    const served = await claimNextVerificationWork({ verifier: 'su-verifier' }, deps);

    expect(served?.kind).toBe('verification-task');
    expect(served?.workItem.id).toBe('WI-TASK');
  });

  it('returns null when neither pool has work', async () => {
    const { deps, claimWorkItem } = build();

    expect(await claimNextVerificationWork({ verifier: 'su-verifier' }, deps)).toBeNull();
    expect(claimWorkItem).not.toHaveBeenCalled();
  });
});

describe('claimNextVerificationTask — the writer decides, the SQL only orders (P-007 Phase B)', () => {
  beforeEach(() => {
    h.reviewRows = [];
    h.taskRows = [];
    h.queries = [];
  });

  it('moves past a candidate the by-id writer refuses and takes the next one', async () => {
    h.taskRows = [
      { feature_id: 'WI-T1', harness_slug: 'papercusp' },
      { feature_id: 'WI-T2', harness_slug: null },
    ];
    const { deps, claimWorkItem } = build(new Set(['WI-T1']));

    const claimed = await claimNextVerificationTask({ verifier: 'su-verifier' }, deps);

    expect(claimed?.id).toBe('WI-T2');
    expect(claimWorkItem.mock.calls).toEqual([
      ['WI-T1', 'su-verifier', { harness: 'papercusp' }],
      ['WI-T2', 'su-verifier', {}],
    ]);
  });

  it('returns null when the writer refuses every candidate', async () => {
    h.taskRows = [{ feature_id: 'WI-T1', harness_slug: 'papercusp' }];
    const { deps } = build(new Set(['WI-T1']));

    expect(await claimNextVerificationTask({ verifier: 'su-verifier' }, deps)).toBeNull();
  });

  it('a blank verifier claims nothing and reads nothing', async () => {
    h.taskRows = [{ feature_id: 'WI-T1', harness_slug: 'papercusp' }];
    const { deps, claimWorkItem } = build();

    expect(await claimNextVerificationTask({ verifier: '   ' }, deps)).toBeNull();
    expect(claimWorkItem).not.toHaveBeenCalled();
    expect(h.queries).toEqual([]);
  });

  it('never hands the writer an excluded task or a reporter/implementer conflict', async () => {
    h.taskRows = ['WI-P2P', 'WI-REPORTER', 'WI-IMPLEMENTER', 'WI-IN'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp' }));
    const { deps, claimWorkItem, items } = build();
    items.set('WI-P2P', { ...items.get('WI-P2P')!, sourcePlanSlug: 'p2p-release' });
    for (const [id, role] of [['WI-REPORTER', 'reporters'], ['WI-IMPLEMENTER', 'implementers']] as const) {
      items.set(id, { ...items.get(id)!, payload: { verification: {
        schemaVersion: 'verification-task-v1', subject: 'WI-S', check: 'completion', [role]: ['su-verifier'],
      } } });
    }
    items.set('WI-IN', { ...items.get('WI-IN')!, createdBy: 'su-verifier' });
    expect((await claimNextVerificationTask({ verifier: 'su-verifier', filter: buildP2pLaneFence() }, deps))?.id).toBe('WI-IN');
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-IN']);
  });

  it('releases a task whose scope changed during the claim, then takes the in-scope control', async () => {
    h.taskRows = ['WI-RACE', 'WI-IN'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp' }));
    const { deps, claimWorkItem, items } = build();
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      const raced = { ...items.get(id)!, assignee, sourcePlanSlug: 'p2p-release' };
      items.set(id, raced);
      return raced;
    });
    expect((await claimNextVerificationTask({ verifier: 'su-verifier', filter: buildP2pLaneFence() }, deps))?.id).toBe('WI-IN');
    expect(items.get('WI-RACE')!.assignee).toBeNull();
    expect(deps.releaseWorkItem).toHaveBeenCalledWith('WI-RACE', {
      harness: 'papercusp', expectedAssignee: 'su-verifier', announceClaimable: false,
    });
  });

  it('reconciles a committed but failed writer and propagates instead of trying another row', async () => {
    h.taskRows = ['WI-UNKNOWN', 'WI-NEXT'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp' }));
    const { deps, claimWorkItem, items } = build();
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      items.set(id, { ...items.get(id)!, assignee });
      throw new Error('claim response lost');
    });
    await expect(claimNextVerificationTask({ verifier: 'su-verifier' }, deps)).rejects.toThrow('claim response lost');
    expect(items.get('WI-UNKNOWN')!.assignee).toBeNull();
    expect(claimWorkItem).toHaveBeenCalledOnce();
  });

  it('does not release a peer when an uncertain claim reconciles to that peer', async () => {
    h.taskRows = [{ feature_id: 'WI-UNKNOWN', harness_slug: 'papercusp' }];
    const { deps, claimWorkItem, items } = build();
    claimWorkItem.mockImplementationOnce(async (id) => {
      items.set(id, { ...items.get(id)!, assignee: 'su-peer' });
      throw new Error('claim response lost');
    });
    await expect(claimNextVerificationTask({ verifier: 'su-verifier' }, deps)).rejects.toThrow('claim response lost');
    expect(deps.releaseWorkItem).not.toHaveBeenCalled();
    expect(items.get('WI-UNKNOWN')!.assignee).toBe('su-peer');
  });

  it('releases a completed claim after cancellation and never retries', async () => {
    h.taskRows = ['WI-ABORT', 'WI-NEXT'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp' }));
    const { deps, claimWorkItem, items } = build();
    const abort = new AbortController();
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      const claimed = { ...items.get(id)!, assignee };
      items.set(id, claimed);
      abort.abort(new Error('cancelled pickup'));
      return claimed;
    });
    await expect(claimNextVerificationTask({ verifier: 'su-verifier', signal: abort.signal }, deps)).rejects.toThrow('cancelled pickup');
    expect(items.get('WI-ABORT')!.assignee).toBeNull();
    expect(claimWorkItem).toHaveBeenCalledOnce();
  });

  it('fails closed when reconciliation cannot release its own uncertain claim', async () => {
    h.taskRows = ['WI-UNKNOWN', 'WI-NEXT'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp' }));
    const { deps, claimWorkItem, items } = build();
    claimWorkItem.mockImplementationOnce(async (id, assignee) => {
      items.set(id, { ...items.get(id)!, assignee });
      throw new Error('claim response lost');
    });
    vi.mocked(deps.releaseWorkItem).mockResolvedValueOnce(null);
    await expect(claimNextVerificationTask({ verifier: 'su-verifier' }, deps)).rejects.toThrow('could not reconcile');
    expect(claimWorkItem).toHaveBeenCalledOnce();
  });
});
