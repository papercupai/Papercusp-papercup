/**
 * work-items-claim-workspace-consistency.test.ts — EI-1545 regression guard.
 *
 * Bug: `work_items:claim { id: 'WI-246' }` returned "not found" for an item-family
 * (bug/change/task) work-item that `work_items:get`/`work_items:complete` resolved
 * fine moments before/after. Root cause: `claimWorkItem`'s issue-family leg used to
 * (a) call `getWorkItem`/`getIssue` (→ `issuesScopeWorkspace()`) for its pre-check,
 * then (b) call a bare `claimIssue()` (→ its OWN independent `issuesScopeWorkspace()`
 * call) for the actual UPDATE. `resolveIssuesScopeWorkspace()`/`issuesScopeWorkspace()`
 * re-derive their answer on every call (a cached flag that self-heals on a TTL, layered
 * on `activeWorkspaceId()`'s own request-scope-dependent resolution) — so two
 * independent calls a few ms apart could legitimately disagree, making the pre-check
 * and the write reason about DIFFERENT scoped workspaces. The fix: resolve the
 * issue-scope workspace ONCE per `claimWorkItem` call and thread that SAME value into
 * both `getIssueInWorkspace` (the pre-check) and `claimIssue` (the write) explicitly,
 * mirroring the fix already applied to the self-select path (claimNextIssueWorkItem,
 * EI-6480/WI-5261).
 *
 * This is a pure unit test: PG (db-org) and issues-engineer are both mocked so it
 * proves the CALL SHAPE (one resolve, one consistent value threaded through) without
 * needing a real database or a real flag-flip race to reproduce.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => {
    const sql = Object.assign(async () => [], { unsafe: vi.fn() });
    return {
      sql: Object.assign(sql, {
        // claimWorkItem emits a claim event. The event latch now uses a
        // transaction; keep this pure unit test's DB seam transaction-capable
        // without changing what the test observes.
        begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql),
      }),
    };
  },
}));

const fakeIssue = {
  id: 'WI-246',
  kind: 'task',
  scope: 'operator',
  title: 't',
  body: 'b',
  severity: 'minor',
  source: 'agent',
  state: 'open',
  assignee: null,
  assignedBy: null,
  assignedAt: null,
  lastProgressAt: null,
  payload: null,
  origin: 'local',
  foundDuring: null,
  linkedFeatureId: null,
  createdBy: null,
  signalOrigin: 'organic',
  assigneeRank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  featureOrder: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

// resolveIssuesScopeWorkspace returns a DIFFERENT value on every call — simulating the
// real TTL-flip / ALS-loss race. If claimWorkItem still resolves the scope only ONCE and
// threads that value through, getIssueInWorkspace and claimIssue must observe the SAME
// (first) value despite this. A regression to the old "call it twice, independently" shape
// would leak the SECOND (different) value into claimIssue's opts.
let resolveCallCount = 0;
const resolveIssuesScopeWorkspace = vi.fn(() => `ws-${resolveCallCount++}`);
const getIssueInWorkspace = vi.fn(async (_ws: string, id: string) => (id === 'WI-246' ? { ...fakeIssue } : null));
const claimIssue = vi.fn(async (id: string, assignee: string, _opts?: { workspaceId?: string }) => ({
  ...fakeIssue,
  id,
  assignee,
}));

vi.mock('./issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIssuesScopeWorkspace,
  getIssueInWorkspace,
  claimIssue,
}));

const { claimWorkItem } = await import('./work-items');

beforeEach(() => {
  resolveCallCount = 0;
  resolveIssuesScopeWorkspace.mockClear();
  getIssueInWorkspace.mockClear();
  claimIssue.mockClear();
});

describe('claimWorkItem — issue-family workspace-scope consistency (EI-1545)', () => {
  it('forwards dispatch provenance to the issue writer (EI-25163151398656476)', async () => {
    await claimWorkItem('WI-246', 'su-member', { assignedBy: 'su-leader' });
    expect(claimIssue).toHaveBeenCalledWith('WI-246', 'su-member', expect.objectContaining({
      workspaceId: 'ws-0', assignedBy: 'su-leader',
    }));
  });

  it('resolves the issue-scope workspace exactly ONCE per claim, and threads that SAME value into both the pre-check and the write', async () => {
    const result = await claimWorkItem('WI-246', 'su-me');

    expect(resolveIssuesScopeWorkspace).toHaveBeenCalledTimes(1);

    const [wsUsedForCheck] = getIssueInWorkspace.mock.calls[0]!;
    const [, , claimOpts] = claimIssue.mock.calls[0]!;
    expect(getIssueInWorkspace).toHaveBeenCalledWith('ws-0', 'WI-246');
    expect(claimOpts).toEqual({ workspaceId: 'ws-0' });
    expect(wsUsedForCheck).toBe(claimOpts!.workspaceId);

    // ... and the claim itself actually succeeds (the reported symptom: it used to
    // spuriously return null/"not found" here).
    expect(result).not.toBeNull();
    expect(result?.id).toBe('WI-246');
    expect(result?.assignee).toBe('su-me');
  });
});
