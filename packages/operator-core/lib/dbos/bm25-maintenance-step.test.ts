import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bm25MaintenanceReport } from '../search/lexical/bm25-maintenance';
import { runBm25MaintenanceStep } from './bm25-maintenance-step';

function report(overrides: Partial<Bm25MaintenanceReport> = {}): Bm25MaintenanceReport {
  return {
    ensure: [],
    engineSkipped: null,
    built: null,
    rebuiltInvalid: false,
    droppedOrphans: [],
    pendingBuilds: [],
    compacted: [],
    reclaimed: null,
    pendingReclaims: [],
    retired: [],
    errors: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('runBm25MaintenanceStep output', () => {
  it('persists a quiet no-op report with timestamps and the loaded source SHA', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runBm25MaintenanceStep({
      runMaintenance: async () => report(),
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025),
      loadedSourceSha: 'a'.repeat(40),
    });

    expect(result).toEqual({
      outcome: 'no-op',
      noOp: true,
      loadedSourceSha: 'a'.repeat(40),
      startedAtMs: 1_000,
      finishedAtMs: 1_025,
      durationMs: 25,
      report: report(),
      error: null,
    });
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('persists the complete success report while keeping the readable log line', async () => {
    const maintenanceReport = report({
      built: 'harness_shared.work_items_bm25',
      ensure: [{ corpusIndex: 'harness_shared.work_items_bm25', outcome: 'created' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runBm25MaintenanceStep({
      runMaintenance: async () => maintenanceReport,
      now: vi.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(2_080),
      loadedSourceSha: 'b'.repeat(40),
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      noOp: false,
      loadedSourceSha: 'b'.repeat(40),
      startedAtMs: 2_000,
      finishedAtMs: 2_080,
      durationMs: 80,
      report: maintenanceReport,
      error: null,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('built harness_shared.work_items_bm25'));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('returns structured output for a non-fatal thrown failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runBm25MaintenanceStep({
      runMaintenance: async () => { throw new Error('database unavailable'); },
      now: vi.fn().mockReturnValueOnce(3_000).mockReturnValueOnce(3_010),
      loadedSourceSha: 'c'.repeat(40),
    });

    expect(result).toEqual({
      outcome: 'non-fatal-failure',
      noOp: false,
      loadedSourceSha: 'c'.repeat(40),
      startedAtMs: 3_000,
      finishedAtMs: 3_010,
      durationMs: 10,
      report: null,
      error: 'database unavailable',
    });
    expect(warn).toHaveBeenCalledWith('[bm25-maintenance] run skipped (non-fatal): database unavailable');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('does not substitute an unbundled checkout SHA when the artifact has no baked SHA', async () => {
    vi.stubEnv('PAPERCUSP_BUILD_SHA', 'checkout-sha');
    const result = await runBm25MaintenanceStep({
      runMaintenance: async () => report(),
      now: vi.fn().mockReturnValueOnce(4_000).mockReturnValueOnce(4_001),
    });

    expect(result.loadedSourceSha).toBeNull();
  });
});
