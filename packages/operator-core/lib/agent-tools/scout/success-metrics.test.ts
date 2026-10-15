/**
 * success-metrics.test.ts (tool surface) — the EI-12148 window-floor args on
 * blender:success-metrics, plus the EI-12146 rubric-derived DEFAULT window. The ledger
 * math lives in scout/success-metrics.test.ts; this pins the ARG semantics (mutual
 * exclusion, loud unknown-watermark failure, schema shape) and the window-resolution
 * PROVENANCE for every path: explicit sinceMs/watermarkRef, the rubric's own declared
 * window (rolling / post-watermark, resolved / unresolved), and the rubric-unavailable
 * fallback. All paths here return before any real PG/systemctl IO.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildProgramSuccessReport: vi.fn(),
  readRunningGeneration: vi.fn(),
  resolveWatermarkRef: vi.fn(),
  getRubric: vi.fn(),
  resolveConcreteWorkspaceId: vi.fn(),
}));

vi.mock('../../scout/success-metrics', () => ({
  buildProgramSuccessReport: mocks.buildProgramSuccessReport,
}));

vi.mock('../../scout/generation-watermark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/generation-watermark')>();
  // Default: pass through to the REAL resolver (no IO for an unknown/typo'd ref — it
  // returns synchronously-failed before ever touching systemctl). Individual tests
  // override this via mockResolvedValueOnce/mockImplementationOnce for the
  // known 'bg-host-restart' ref, so no test ever execs a real systemctl.
  mocks.resolveWatermarkRef.mockImplementation(actual.resolveWatermarkRef);
  return { ...actual, readRunningGeneration: mocks.readRunningGeneration, resolveWatermarkRef: mocks.resolveWatermarkRef };
});

vi.mock('../../rubrics', () => ({ getRubric: mocks.getRubric }));

// EI-19480382468465942: stubbed so the workspace-id guard below never reads real workspace
// config (keeping this file's "no real IO" property), and so the ctx→resolver→report thread
// is observable at both ends. The stub returns a value distinguishable from every real slug.
vi.mock('../../workspace-registry', () => ({
  resolveConcreteWorkspaceId: mocks.resolveConcreteWorkspaceId,
}));

import {
  runSuccessMetrics,
  successMetricsArgs,
  RELEASE_READINESS_RUBRIC_SLUG,
  CYCLE_ERROR_RATE_CRITERION_KEY,
} from './success-metrics';

describe('blender:success-metrics window-floor args (EI-12148) + rubric-derived default (EI-12146)', () => {
  beforeEach(() => {
    mocks.buildProgramSuccessReport.mockReset().mockResolvedValue({
      verdict: 'pass',
      criteria: [],
      window: { ticks: 1, ranCycles: 1, routedIdeas: 0, ledgerTruncated: false },
    });
    mocks.readRunningGeneration.mockReset().mockResolvedValue({
      deployedSha: '8a9ce7c105',
      hostStartedAt: '2026-07-15T03:11:25.000Z',
      bootHeadSha: '8a9ce7c105abcdef0000000000000000000000',
      scoutCodeHash: 'deadbeef12345678',
      staleHost: false,
    });
    // Default: no rubric found — every test exercises the EI-12146 rubric-derived
    // default path explicitly instead, via its own mockResolvedValueOnce.
    mocks.getRubric.mockReset().mockResolvedValue(null);
    mocks.resolveConcreteWorkspaceId.mockReset().mockReturnValue('ws-resolved');
  });

  // EI-19480382468465942 — the report must never be built without a concrete workspaceId.
  // buildProgramSuccessReport resolves the scout tick install_slug through
  // resolveScoutTickInstallSlug(opts.workspaceId), which short-circuits to the legacy
  // '@singleton' constant when that is falsy. Omitting it therefore pointed the cadence
  // read at a DEAD ledger stream (last tick 2026-08-02T02:04:47Z) while the live writer
  // had moved to install_slug='papercusp-workspace' — and the failure was silent: the bar
  // reported status:'unknown' ("denominator too small") forever instead of saying the
  // stream it watched had stopped. Assert the WIRING, because the symptom is invisible.
  describe('workspace scoping (EI-19480382468465942)', () => {
    it('threads the ctx workspaceId through the resolver into the report options', async () => {
      const out = await runSuccessMetrics({}, { workspaceId: 'ws-from-ctx' });
      expect(out.ok).toBe(true);
      // Leg 1: ctx's value actually reaches the resolver (not silently dropped).
      expect(mocks.resolveConcreteWorkspaceId).toHaveBeenCalledWith('ws-from-ctx');
      // Leg 2: the RESOLVED value — not the raw ctx value — is what the report is built on.
      expect(mocks.buildProgramSuccessReport).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-resolved' }),
      );
    });

    it('still supplies a concrete workspaceId when ctx carries none (the fallback must not be undefined)', async () => {
      // The regression this guards is not "ctx was missing" — it is "workspaceId reached
      // buildProgramSuccessReport as undefined", which is what arms the '@singleton'
      // short-circuit. A ctx-less call must still resolve to a real workspace.
      const out = await runSuccessMetrics({}, undefined);
      expect(out.ok).toBe(true);
      expect(mocks.resolveConcreteWorkspaceId).toHaveBeenCalledWith(undefined);
      const opts = mocks.buildProgramSuccessReport.mock.calls[0]?.[0] as { workspaceId?: unknown };
      expect(opts.workspaceId).toBe('ws-resolved');
      expect(opts.workspaceId).toBeTruthy();
    });

    it('CONTROL: a falsy resolved workspaceId is exactly the shape that armed the bug', async () => {
      // Deliberately wrong resolver, proving the assertions above are falsifiable rather
      // than trivially true — if the production code stopped passing workspaceId, the
      // options object would look like THIS, and the two tests above would fail.
      mocks.resolveConcreteWorkspaceId.mockReturnValue('');
      await runSuccessMetrics({}, { workspaceId: '*' });
      const opts = mocks.buildProgramSuccessReport.mock.calls[0]?.[0] as { workspaceId?: unknown };
      expect(opts.workspaceId).toBe('');
      expect(opts.workspaceId).toBeFalsy();
    });
  });

  it('schema accepts sinceMs and watermarkRef', () => {
    expect(successMetricsArgs.safeParse({ sinceMs: Date.parse('2026-07-14T18:08:24Z') }).success).toBe(true);
    expect(successMetricsArgs.safeParse({ watermarkRef: 'bg-host-restart' }).success).toBe(true);
    expect(successMetricsArgs.safeParse({}).success).toBe(true);
  });

  it('sinceMs + watermarkRef together is a TEACHING error — two floors cannot both judge', async () => {
    const out = await runSuccessMetrics({ sinceMs: 1, watermarkRef: 'bg-host-restart' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('invalid_args');
    expect(mocks.getRubric).not.toHaveBeenCalled();
  });

  it('an unknown watermarkRef fails LOUD, never silently judges some other window', async () => {
    const out = await runSuccessMetrics({ watermarkRef: 'not-a-watermark' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('watermark_unresolved');
      // The teaching error names the vocabulary so the caller can self-correct.
      expect(out.error).toContain('bg-host-restart');
    }
    expect(mocks.getRubric).not.toHaveBeenCalled();
  });

  it('adds running-generation parity evidence to an explicitly windowed judgment', async () => {
    const sinceMs = Date.parse('2026-07-15T03:11:25.000Z');
    const out = await runSuccessMetrics({ sinceMs });

    expect(out).toMatchObject({
      ok: true,
      resolvedWindow: {
        sinceMs,
        sinceIso: '2026-07-15T03:11:25.000Z',
        source: 'sinceMs',
      },
      runningGeneration: {
        deployedSha: '8a9ce7c105',
        hostStartedAt: '2026-07-15T03:11:25.000Z',
        staleHost: false,
      },
    });
    expect(mocks.readRunningGeneration).toHaveBeenCalledOnce();
    // An explicit override skips the rubric read entirely — it is not consulted at all.
    expect(mocks.getRubric).not.toHaveBeenCalled();
  });

  it('keeps parity unknown when reading the running generation fails', async () => {
    mocks.readRunningGeneration.mockRejectedValue(new Error('host metadata unavailable'));

    const out = await runSuccessMetrics({ sinceMs: Date.parse('2026-07-15T03:11:25.000Z') });

    expect(out).toMatchObject({
      ok: true,
      runningGeneration: {
        deployedSha: null,
        hostStartedAt: null,
        bootHeadSha: null,
        scoutCodeHash: null,
        staleHost: null,
      },
    });
  });

  describe('EI-12146: default window (no sinceMs/watermarkRef) resolves from the rubric', () => {
    it('reads the release-readiness rubric\'s cycle-error-rate criterion', async () => {
      await runSuccessMetrics({});
      expect(mocks.getRubric).toHaveBeenCalledWith(RELEASE_READINESS_RUBRIC_SLUG);
    });

    it('falls back to the pre-EI-12146 hardcoded default when the rubric cannot be read at all (byte-compatible)', async () => {
      // beforeEach already stubs getRubric → null (rubric not found / read failed).
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.resolvedWindow).toBeUndefined();
        expect(out.runningGeneration).toBeUndefined();
      }
      expect(mocks.readRunningGeneration).not.toHaveBeenCalled();
      const callArg = mocks.buildProgramSuccessReport.mock.calls[0]?.[0];
      expect(callArg?.sinceMs).toBeUndefined();
    });

    it('falls back to the hardcoded default when the rubric has no cycle-error-rate criterion window declared', async () => {
      mocks.getRubric.mockResolvedValue({
        criteria: [{ key: CYCLE_ERROR_RATE_CRITERION_KEY, title: 'x', model: 'x', method: 'x', driftMarkers: 'x' }],
      });
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) expect(out.resolvedWindow).toBeUndefined();
      expect(mocks.readRunningGeneration).not.toHaveBeenCalled();
    });

    it('resolves a rolling window the rubric declares, and passes it through to the report + parity evidence', async () => {
      const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
      vi.useFakeTimers().setSystemTime(nowMs);
      try {
        mocks.getRubric.mockResolvedValue({
          criteria: [
            {
              key: CYCLE_ERROR_RATE_CRITERION_KEY,
              title: 'x',
              model: 'x',
              method: 'x',
              driftMarkers: 'x',
              window: { kind: 'rolling', ms: 3_600_000 },
            },
          ],
        });

        const out = await runSuccessMetrics({});

        const expectedSinceMs = nowMs - 3_600_000;
        expect(out).toMatchObject({
          ok: true,
          resolvedWindow: { sinceMs: expectedSinceMs, source: 'rubric:window' },
          runningGeneration: { deployedSha: '8a9ce7c105' },
        });
        expect(mocks.buildProgramSuccessReport).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: expectedSinceMs }));
        expect(mocks.readRunningGeneration).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves a post-watermark window the rubric declares via the named watermark ref', async () => {
      const wmMs = Date.parse('2026-07-17T09:00:00.000Z');
      mocks.getRubric.mockResolvedValue({
        criteria: [
          {
            key: CYCLE_ERROR_RATE_CRITERION_KEY,
            title: 'x',
            model: 'x',
            method: 'x',
            driftMarkers: 'x',
            window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
          },
        ],
      });
      mocks.resolveWatermarkRef.mockResolvedValueOnce({ ok: true, ms: wmMs });

      const out = await runSuccessMetrics({});

      expect(out).toMatchObject({
        ok: true,
        resolvedWindow: { sinceMs: wmMs, sinceIso: new Date(wmMs).toISOString(), source: 'rubric:window' },
      });
      expect(mocks.buildProgramSuccessReport).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: wmMs }));
    });

    it('degrades to the rolling default (with provenance) when the rubric\'s post-watermark ref cannot resolve — never silently judges nothing', async () => {
      const nowMs = Date.parse('2026-07-18T12:00:00.000Z');
      vi.useFakeTimers().setSystemTime(nowMs);
      try {
        mocks.getRubric.mockResolvedValue({
          criteria: [
            {
              key: CYCLE_ERROR_RATE_CRITERION_KEY,
              title: 'x',
              model: 'x',
              method: 'x',
              driftMarkers: 'x',
              window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
            },
          ],
        });
        mocks.resolveWatermarkRef.mockResolvedValueOnce({ ok: false, error: 'bg-host not running' });

        const out = await runSuccessMetrics({});

        expect(out.ok).toBe(true);
        if (out.ok) {
          expect(out.resolvedWindow?.source).toBe('rubric:watermark-unresolved');
          // A never-throws degrade must still judge SOME concrete window, not nothing.
          expect(typeof out.resolvedWindow?.sinceMs).toBe('number');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('a rubric read that throws degrades to the hardcoded default rather than failing the whole done-check', async () => {
      mocks.getRubric.mockRejectedValue(new Error('pg unavailable'));
      const out = await runSuccessMetrics({});

      expect(out.ok).toBe(true);
      if (out.ok) expect(out.resolvedWindow).toBeUndefined();
    });
  });
});
