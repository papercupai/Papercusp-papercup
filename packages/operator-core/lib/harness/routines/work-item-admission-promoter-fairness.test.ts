import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const io = vi.hoisted(() => ({
  review: vi.fn(), recover: vi.fn(), promote: vi.fn(), components: vi.fn(),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerWorkflow: (workflow: unknown) => workflow },
}));
vi.mock('./system-actions', () => ({ SYSTEM_TARGET_PREFIX: 'system:', registerSystemAction: vi.fn() }));
vi.mock('../../work-item-admission-review', () => ({ runAdmissionReviews: io.review }));
vi.mock('../../work-item-admission-recovery', () => ({
  withAdmissionPromoterLock: async (_scope: unknown, _sql: unknown, run: () => Promise<unknown>) => run(),
  runAdmissionRecoveries: io.recover,
  readAuthorizedComponentScreening: io.components,
}));
vi.mock('../../work-items-admission-promoter', async (original) => ({
  ...await original<typeof import('../../work-items-admission-promoter')>(),
  runWorkItemAdmissionPromoter: io.promote,
}));
import { runAdmissionPromoterWithRecovery } from './work-item-admission-promoter-action';

const options = {
  workspaceId: 'ws-fairness', harnessSlug: 'papercusp', runId: 'ordinary-first',
  batchSize: 1, recentTerminalDays: 30, model: undefined,
};
const result = (runId: string) => ({
  runId, batchSize: 1, flaggedPairs: 0, promoted: 1, merged: 0, held: 0,
  modelCalled: false, tokensIn: 0, tokensOut: 0, censusBefore: 0, censusAfter: 0,
  guardRefusals: [], writerCoverageGap: [] as string[],
});

/** Inject storage/model ports into the real production composition. No PG,
 * model call, request creation, or dispatch can escape this test's ports. */
function fixture(due = true, now: Date | string = new Date('2026-11-02T09:40:00.000Z')) {
  const events: string[] = [];
  let slot: Record<string, unknown> = { dueAt: due ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z' };
  const ledger = new Map<string, { result: ReturnType<typeof result>; settled: boolean }>();
  let queued = true;
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?').replace(/\s+/g, ' ');
    if (text.includes('SELECT COALESCE(detail')) {
      const row = ledger.get(String(values[0]));
      const storedOnly = values.includes(true) && !values.includes(false);
      return row && (!storedOnly || row.settled) ? [{ result: row.result }] : [];
    }
    if (text.includes('SELECT id, trigger_config')) return [{
      id: 'original-promoter', trigger_config: { cron: '*/30 * * * *' },
      metadata: { admissionOrdinarySlot: slot }, now,
    }];
    if (text.includes('UPDATE harness_shared.routines SET metadata')) {
      const json = values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
      slot = JSON.parse(json);
      if (text.includes('next_fire_at')) events.push('finish-ordinary');
      return [];
    }
    if (text.includes('UPDATE harness_shared.admission_runs SET detail')) {
      const saved = JSON.parse(String(values[0]));
      ledger.set(saved.runId, { result: saved, settled: true });
      return [];
    }
    throw new Error(`unexpected storage operation: ${text}`);
  });
  const sql = Object.assign(query, {
    begin: async (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
    typed: (value: unknown) => value,
  }) as unknown as Sql;
  io.review.mockImplementation(async () => {
    events.push('review');
    return { result: null, guardRefusals: [] };
  });
  io.components.mockResolvedValue({ itemIds: [], receipts: [] });
  io.promote.mockImplementation(async ({ runId }) => {
    events.push('ordinary');
    const saved = result(runId);
    ledger.set(runId, { result: saved, settled: false });
    return saved;
  });
  io.recover.mockImplementation(async (scope) => {
    if (!queued) return 0;
    if (scope.deferUntilOrdinaryComplete) events.push('defer-original');
    else {
      events.push('recover-original');
      queued = false;
    }
    return 1;
  });
  const deps = { sql, authorize: vi.fn(), dispatch: vi.fn(), llmCall: vi.fn() };
  return { events, query, deps, slot: () => slot, queued: () => queued };
}

beforeEach(() => vi.resetAllMocks());

describe('D099 ordinary/exact admission fairness (injected production composition)', () => {
  it('gives the original queued request a disposition before settling a due ordinary pass', async () => {
    const f = fixture();
    await expect(runAdmissionPromoterWithRecovery(options, f.deps)).resolves.toEqual(result(options.runId));
    expect(f.events).toEqual(['review', 'defer-original', 'ordinary', 'recover-original', 'finish-ordinary']);
    expect(f.queued()).toBe(false);
    expect(io.recover).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: options.workspaceId, harnessSlug: options.harnessSlug,
    }), expect.objectContaining({ authorize: f.deps.authorize, dispatch: f.deps.dispatch }), f.deps.sql);
  });

  it('accepts raw PostgreSQL timestamptz strings when claiming an ordinary slot', async () => {
    const f = fixture(true, '2026-11-02 09:40:00.000000+00');
    await expect(runAdmissionPromoterWithRecovery(options, f.deps)).resolves.toEqual(result(options.runId));
    expect(f.events).toEqual(['review', 'defer-original', 'ordinary', 'recover-original', 'finish-ordinary']);
    expect(f.slot().runId).toBe(options.runId);
  });

  it('does not let an ordinary screen failure dispatch exact work or lose the ordinary slot', async () => {
    const f = fixture();
    io.promote.mockRejectedValueOnce(new Error('ordinary screening unavailable'));
    await expect(runAdmissionPromoterWithRecovery(options, f.deps)).rejects.toThrow('ordinary screening unavailable');
    expect(f.events).toEqual(['review', 'defer-original']);
    expect(f.queued()).toBe(true);
    expect(f.slot().runId).toBe(options.runId);
  });

  it('replays a settled ordinary invocation without consuming a later exact request', async () => {
    const f = fixture();
    await runAdmissionPromoterWithRecovery(options, f.deps);
    const calls = io.recover.mock.calls.length;
    await expect(runAdmissionPromoterWithRecovery(options, f.deps)).resolves.toEqual(result(options.runId));
    expect(io.recover).toHaveBeenCalledTimes(calls);
    expect(io.promote).toHaveBeenCalledTimes(1);
  });

  it('keeps review authorization first and fails closed before either admission path', async () => {
    const f = fixture();
    io.review.mockRejectedValueOnce(new Error('review authority unavailable'));
    await expect(runAdmissionPromoterWithRecovery(options, f.deps)).rejects.toThrow('review authority unavailable');
    expect(io.recover).not.toHaveBeenCalled();
    expect(io.promote).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1); // completed-run read only
  });

  it('does not accelerate unrelated ordinary screening on an exact-only fire', async () => {
    const f = fixture(false);
    await runAdmissionPromoterWithRecovery(options, f.deps);
    expect(f.events).toEqual(['review', 'recover-original']);
    expect(io.promote).not.toHaveBeenCalled();
    expect(f.slot().runId).toBeUndefined();
  });

  it('leaves explicit targets independent of queued recovery and recurring slots', async () => {
    const f = fixture();
    await runAdmissionPromoterWithRecovery({ ...options, targetItemIds: ['WI-explicit'] }, f.deps);
    expect(io.promote).toHaveBeenCalledWith(expect.objectContaining({ targetItemIds: ['WI-explicit'] }));
    expect(io.review).not.toHaveBeenCalled();
    expect(io.recover).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
});
