import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchPendingTriggerRuns = vi.fn();
const sql = { name: 'sql-fixture' };

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql }),
}));
vi.mock('../../external-triggers/binding-engine', () => ({
  dispatchPendingTriggerRuns: (...args: unknown[]) => dispatchPendingTriggerRuns(...args),
}));

import { runExternalTriggerDispatch, spendPauseEnabled } from './external-trigger-dispatch-action';

const ctx = (triggerConfig: Record<string, unknown>) => ({
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig,
  payloadTemplate: null,
});

describe('external-trigger-dispatch spend pause', () => {
  beforeEach(() => {
    dispatchPendingTriggerRuns.mockReset().mockResolvedValue({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      triggerRunIds: [],
    });
  });

  it('reads the existing routines triggerConfig pause surface without changing whole-dispatcher active state', async () => {
    expect(spendPauseEnabled({ spend_paused: true })).toBe(true);
    expect(spendPauseEnabled({ spendPaused: true })).toBe(true);
    expect(spendPauseEnabled({ spend_paused: false })).toBe(false);

    await runExternalTriggerDispatch(ctx({ spend_paused: true, batch_size: 7, stale_after_seconds: 19 }));

    expect(dispatchPendingTriggerRuns).toHaveBeenCalledWith(sql, {
      batchSize: 7,
      staleAfterSeconds: 19,
      spendPaused: true,
    });
  });

  it('leaves the selective pause disabled by default', async () => {
    await runExternalTriggerDispatch(ctx({}));

    expect(dispatchPendingTriggerRuns).toHaveBeenCalledWith(sql, {
      batchSize: 25,
      staleAfterSeconds: 60,
      spendPaused: false,
    });
  });
});
