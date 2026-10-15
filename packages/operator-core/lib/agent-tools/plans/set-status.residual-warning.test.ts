/**
 * set-status.residual-warning.test.ts — the residual-coverage guard
 * (EI-18655063958515097: "a residual split off a closing plan item silently
 * leaves the lane — no plan link, not claimable, parent reads done while its
 * acceptance ask is unmet"). Non-blocking: a →done/dropped flip warns
 * (`residualWarning`) when a linked coverage work-item is still non-terminal, or
 * when the note/rationale reads like an unmet acceptance criterion was split off
 * with nothing linked to cover it — but the flip itself always succeeds.
 *
 * Sibling to set-status.bulk.test.ts (same lock-mocking harness); this file adds
 * its own mock of ../../plan-items/convert so findCoverageWorkItems is
 * controllable per test without touching PG.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.residual-warning.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convertMocks = vi.hoisted(() => ({
  findCoverageWorkItems: vi.fn(async () => [] as Array<{ id: string; state: string }>),
}));
const reconcileMocks = vi.hoisted(() => ({
  findAllLinkedWorkItems: vi.fn(async () => [] as Array<{
    id: string;
    state: string;
    family?: string;
    assignee?: string | null;
    viaImplementsEdge?: boolean;
  }>),
}));

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
// WI-10008137: the draft-plan item-start gate has its own suite (draft-item-start-gate.test.ts).
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// No attributable agent identity → the claim/terminal-claim discipline is skipped
// (mirrors set-status.bulk.test.ts); only the terminal-grip clear-assignment leg runs.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
}));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));
vi.mock('../../plan-items/convert', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/convert')>()),
  findCoverageWorkItems: convertMocks.findCoverageWorkItems,
}));
vi.mock('../../plan-items/reconcile-linked-work-items', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/reconcile-linked-work-items')>()),
  findAllLinkedWorkItems: reconcileMocks.findAllLinkedWorkItems,
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

/** Drive the lock: run the mutator against a fake body carrying `currentStatus`,
 *  then return its ok-value as a successful lock outcome (mirrors bulk test). */
function lockReturnsMutatorValue(knownItems: Set<string>, currentStatus = 'wip') {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const fakeBody = knownItems.has(itemId) ? `- **${itemId}** \`${currentStatus}\` x` : '';
    const { value } = await (mutate as (b: string | null) => Promise<{ value: unknown }>)(fakeBody);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  convertMocks.findCoverageWorkItems.mockResolvedValue([]);
  reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([]);
});

describe('plans:set-status residual-coverage guard (EI-18655063958515097)', () => {
  it('warns when a linked coverage work-item is still non-terminal on a →done flip', async () => {
    convertMocks.findCoverageWorkItems.mockResolvedValue([{ id: 'EI-999', state: 'open' } as never]);
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done' });
    expect(b.results[0].ok).toBe(true); // never blocks
    expect(b.results[0].residualWarning).toMatch(/EI-999/);
    expect(b.results[0].residualWarning).toMatch(/non-terminal/);
  });

  it('describes feature coverage that the terminal reaction will auto-resolve as residue', async () => {
    convertMocks.findCoverageWorkItems.mockResolvedValue([
      { id: 'WI-38675', state: 'open', family: 'feature', assignee: null } as never,
    ]);
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'WI-38675', state: 'open', family: 'feature', assignee: null, viaImplementsEdge: false } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done' });
    expect(b.results[0].residualWarning).toMatch(/auto-resolved as residue/);
    expect(b.results[0].residualWarning).toMatch(/WI-38675/);
    expect(b.results[0].residualWarning).not.toMatch(/hold this item open until they close/);
  });

  it('keeps the follow-up warning for an issue stamp without an implements edge', async () => {
    convertMocks.findCoverageWorkItems.mockResolvedValue([
      { id: 'EI-issue-stamp', state: 'open', family: 'issue', assignee: null } as never,
    ]);
    reconcileMocks.findAllLinkedWorkItems.mockResolvedValue([
      { id: 'EI-issue-stamp', state: 'open', family: 'issue', assignee: null, viaImplementsEdge: false } as never,
    ]);
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done' });
    expect(b.results[0].residualWarning).toMatch(/remain non-terminal/);
    expect(b.results[0].residualWarning).toMatch(/hold this item open until they close/);
    expect(b.results[0].residualWarning).not.toMatch(/auto-resolved as residue/);
  });

  it('does NOT warn when the linked coverage work-item is already terminal', async () => {
    convertMocks.findCoverageWorkItems.mockResolvedValue([{ id: 'EI-999', state: 'done' } as never]);
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done' });
    expect(b.results[0].residualWarning).toBeUndefined();
  });

  it('warns via the note-language heuristic when nothing covers the item at all', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-001',
      status: 'done',
      note: 'the acceptance ask was not met — split off into a follow-up',
    });
    expect(b.results[0].residualWarning).toMatch(/work_items:create/);
    expect(b.results[0].residualWarning).toMatch(/EI-18655063958515097/);
  });

  it('rationale (not just note) also triggers the language heuristic', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-001',
      status: 'done',
      rationale: 'closing this out — the second-frame check was carved off into a follow-up',
    });
    expect(b.results[0].residualWarning).toMatch(/work_items:create/);
  });

  it('does not warn when a completed investigation records a discovered defect as a filed finding', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-001',
      status: 'done',
      rationale:
        'VERDICT: the row predates the cascade; diagnosed the issue and recorded the decision; residual defect filed as WI-37856.',
    });
    expect(b.results[0].residualWarning).toBeUndefined();
  });

  it('no warning on a clean close with no coverage and no residual language', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done', note: 'all green, shipped' });
    expect(b.results[0].residualWarning).toBeUndefined();
  });

  it('never checks coverage or fires on a non-terminal flip (e.g. →wip)', async () => {
    lockReturnsMutatorValue(new Set(['P-001']), 'todo');
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip', note: 'split off residual work' });
    expect(b.results[0].residualWarning).toBeUndefined();
    expect(convertMocks.findCoverageWorkItems).not.toHaveBeenCalled();
  });

  it('a lookup failure is fail-safe — the flip still succeeds with no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    convertMocks.findCoverageWorkItems.mockRejectedValue(new Error('pg unavailable'));
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done', note: 'split off residual work' });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].residualWarning).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plans:set-status] residual-coverage check'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});
