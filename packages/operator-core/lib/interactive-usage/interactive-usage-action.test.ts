import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from '../harness/routines/system-actions';

const mocks = vi.hoisted(() => ({
  managedSetInterval: vi.fn(),
  registerSystemAction: vi.fn(),
  ingestInteractiveUsage: vi.fn(),
  repriceUsageSamples: vi.fn(),
  getOrgPg: vi.fn(),
}));

vi.mock('@papercusp/scheduled-registry', () => ({ managedSetInterval: mocks.managedSetInterval }));
vi.mock('../harness/routines/system-actions', () => ({ registerSystemAction: mocks.registerSystemAction }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: mocks.getOrgPg }));
vi.mock('./ingest-claude-transcripts', () => ({ ingestInteractiveUsage: mocks.ingestInteractiveUsage }));
vi.mock('./reprice-usage-samples', () => ({ repriceUsageSamples: mocks.repriceUsageSamples }));

import './interactive-usage-action';

const registeredHandler = mocks.registerSystemAction.mock.calls.find(
  ([name]) => name === 'interactive-usage-ingest',
)?.[1] as ((ctx: SystemActionCtx) => Promise<void>) | undefined;

describe('interactive usage ingest action progress timer', () => {
  let stopTimer: ReturnType<typeof vi.fn>;
  let intervalTick: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    intervalTick = undefined;
    stopTimer = vi.fn();

    mocks.managedSetInterval.mockImplementation((
      _name: string,
      _intervalMs: number,
      callback: () => void,
    ) => {
      intervalTick = callback;
      return { stop: stopTimer };
    });
    mocks.getOrgPg.mockReturnValue({ sql: {} });
    mocks.repriceUsageSamples.mockResolvedValue({ stamped: 0, skippedConcurrent: 0 });
    mocks.ingestInteractiveUsage.mockImplementation(async (options: { onProgress?: (snapshot: object) => void }) => {
      options.onProgress?.({
        phase: 'decode', source: 'codex', filesScanned: 2, filesIngested: 0, samples: 0, bytesRead: 128,
        elapsedMs: 100, phaseMs: { decode: 12 }, sourcePhaseMs: { codex: { decode: 9 } },
      });
      intervalTick?.();
      options.onProgress?.({
        phase: 'completed', filesScanned: 2, filesIngested: 0, samples: 0, bytesRead: 128,
        elapsedMs: 120, phaseMs: {
          'root-discovery': 1, 'watermark-read': 2, 'directory-scan': 3, 'file-stat': 4,
          decode: 12, 'write-transaction': 7, 'account-reconciliation': 1, 'completion-settlement': 1,
        },
        sourcePhaseMs: { codex: { decode: 9, 'write-transaction': 2 } },
      });
      return {
        scannedFiles: 2,
        ingestedFiles: 0,
        samples: 0,
        skippedUnchanged: 2,
        errors: [],
        totals: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('registers a classified must-sample timer, logs current progress, and stops it after the action', async () => {
    expect(registeredHandler).toBeTypeOf('function');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await registeredHandler!({
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      workflowId: 'test-run-123',
      triggerConfig: {},
      payloadTemplate: null,
    });

    expect(mocks.managedSetInterval).toHaveBeenCalledWith(
      'interactive-usage-ingest-progress',
      60_000,
      expect.any(Function),
      { category: 'watchdog', classification: 'must-sample' },
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"phase":"decode"'));
    const messages = info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes('"workflowId":"test-run-123"') &&
      message.includes('"phaseTotalMs":12') && message.includes('"sourcePhaseTotalMs":9'))).toBe(true);
    expect(messages.some((message) => message.includes('[interactive-usage] phase-timings') &&
      message.includes('"source":"all"') && message.includes('"workflowId":"test-run-123"'))).toBe(true);
    expect(messages.some((message) => message.includes('[interactive-usage] phase-timings') &&
      message.includes('"source":"codex"') && message.includes('"write-transaction":2'))).toBe(true);
    expect(stopTimer).toHaveBeenCalledOnce();
  });
});
