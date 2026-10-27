/**
 * P-010 (code-intel-delivery-and-outcomes-2026-10-26, SPEC-P-010): the edit-time
 * "you hold no work item" nudge decision. The hook rendering is pinned in
 * apps/operator/scripts/hooks/cc/__tests__/pretooluse-locks-decision.test.ts; the
 * real-Postgres holder read in attribution-nudge.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_NUDGE,
  readAttributionNudge,
  startAttributionNudge,
  type NudgeSql,
} from './attribution-nudge';

/** A tagged-template stub that answers the holder read with `held` and records the call. */
function stubSql(answer: () => Promise<unknown>): { sql: NudgeSql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push([strings.join('?'), ...values]);
    return answer();
  }) as unknown as NudgeSql;
  return { sql, calls };
}

describe('readAttributionNudge', () => {
  it('nudges an owner who holds no non-terminal work item', async () => {
    const { sql, calls } = stubSql(async () => [{ held: false }]);
    await expect(readAttributionNudge({ sql, workspaceId: 'ws', ownerId: 'su-a' }))
      .resolves.toBe(ATTRIBUTION_NUDGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ws');
    expect(calls[0]).toContain('su-a');
    expect(String(calls[0][0])).toContain('taken_by');
  });

  it('stays silent for an owner who holds a work item', async () => {
    const { sql } = stubSql(async () => [{ held: true }]);
    await expect(readAttributionNudge({ sql, workspaceId: 'ws', ownerId: 'su-a' }))
      .resolves.toBeUndefined();
  });

  it('stays silent when the read fails, answers nothing, or is too slow', async () => {
    const failing = stubSql(async () => { throw new Error('pg down'); });
    await expect(readAttributionNudge({ sql: failing.sql, workspaceId: 'ws', ownerId: 'su-a' }))
      .resolves.toBeUndefined();
    const empty = stubSql(async () => []);
    await expect(readAttributionNudge({ sql: empty.sql, workspaceId: 'ws', ownerId: 'su-a' }))
      .resolves.toBeUndefined();
    const slow = stubSql(() => new Promise((resolve) => setTimeout(() => resolve([{ held: false }]), 200)));
    await expect(readAttributionNudge({ sql: slow.sql, workspaceId: 'ws', ownerId: 'su-a', timeoutMs: 20 }))
      .resolves.toBeUndefined();
  });

  it('does not query without a workspace, owner or pool', async () => {
    const { sql, calls } = stubSql(async () => [{ held: false }]);
    await expect(readAttributionNudge({ sql, workspaceId: null, ownerId: 'su-a' })).resolves.toBeUndefined();
    await expect(readAttributionNudge({ sql, workspaceId: 'ws', ownerId: '' })).resolves.toBeUndefined();
    await expect(readAttributionNudge({ sql: null, workspaceId: 'ws', ownerId: 'su-a' })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('names the claim and create verbs in the nudge text', () => {
    expect(ATTRIBUTION_NUDGE).toContain('hold no work item');
    expect(ATTRIBUTION_NUDGE).toContain('work_items:claim');
    expect(ATTRIBUTION_NUDGE).toContain('work_items:create');
  });
});

describe('startAttributionNudge', () => {
  it('resolves to no nudge when resolving the workspace or pool throws', async () => {
    await expect(startAttributionNudge({
      ownerId: 'su-a',
      resolveWorkspaceId: () => { throw new Error('no identity'); },
      resolveSql: () => stubSql(async () => [{ held: false }]).sql,
    })).resolves.toBeUndefined();
    await expect(startAttributionNudge({
      ownerId: 'su-a',
      resolveWorkspaceId: () => 'ws',
      resolveSql: () => { throw new Error('no pool'); },
    })).resolves.toBeUndefined();
  });

  it('carries the nudge through when both resolve', async () => {
    await expect(startAttributionNudge({
      ownerId: 'su-a',
      resolveWorkspaceId: () => 'ws',
      resolveSql: () => stubSql(async () => [{ held: false }]).sql,
    })).resolves.toBe(ATTRIBUTION_NUDGE);
  });
});
