/**
 * release-deploy-staleness-watchdog.test.ts (WI-1623).
 * Pure tests for the staleness decider + the sweep's alert/debounce/kill-switch
 * shell. IO deps (PG, the pipeline snapshot) are mocked.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';

const recentWatchdogFires = vi.fn().mockResolvedValue(0);
const claimWatchdogFire = vi.fn().mockResolvedValue(true);
vi.mock('./pot/watchdog', () => ({ recentWatchdogFires: (...a: unknown[]) => recentWatchdogFires(...a), claimWatchdogFire: (...a: unknown[]) => claimWatchdogFire(...a) }));

const gitPipelineSnapshot = vi.fn().mockResolvedValue({});
vi.mock('./git-pipeline-stats', () => ({ gitPipelineSnapshot: (...a: unknown[]) => gitPipelineSnapshot(...a) }));

const computeDeployStatus = vi.fn();
vi.mock('./release-deploy-launch', () => ({ computeDeployStatus: (...a: unknown[]) => computeDeployStatus(...a) }));

// EI-16537 paging rails. The `sql` fake answers by statement shape: the escalation-row
// SELECT (the one-shot latch), and the recovery UPDATE whose `count` is the "were we
// alarmed?" test. Every reference is behind a closure so vi.mock's hoisting never
// dereferences these consts before they initialize.
let escalationRows: { escalation: unknown }[] = [];
let recoveryUpdateCount = 0;
const sqlStatements: string[] = [];
// EI-20101010229759029: the deployable-since watermark lives in the operator_settings KV,
// so the fake has to tell the two tables apart — routing its SELECT to the escalation-latch
// rows would make every watermark read answer with the wrong shape.
let greenSinceValue: string | null = null;
let settingsFail = false;
const settingsWrites: unknown[][] = [];
const fakeSql = Object.assign((strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown> => {
  const text = strings.join('?').trim();
  sqlStatements.push(text);
  if (/operator_settings/.test(text)) {
    if (settingsFail) return Promise.reject(new Error('KV unavailable'));
    if (/^SELECT/i.test(text)) {
      return Promise.resolve(greenSinceValue == null ? [] : [{ value: greenSinceValue }]);
    }
    if (/^DELETE/i.test(text)) {
      const had = greenSinceValue != null;
      greenSinceValue = null;
      return Promise.resolve(Object.assign([], { count: had ? 1 : 0 }));
    }
    settingsWrites.push(vals);
    greenSinceValue = String(vals[1]);
    return Promise.resolve(Object.assign([], { count: 1 }));
  }
  if (/^SELECT/i.test(text)) return Promise.resolve(escalationRows);
  if (/^UPDATE/i.test(text)) return Promise.resolve(Object.assign([], { count: recoveryUpdateCount }));
  return Promise.resolve(Object.assign([], { count: 1 }));
}, { begin: vi.fn() });
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

const notifyAttention = vi.fn().mockResolvedValue(undefined);
vi.mock('./attention-notify', () => ({ notifyAttention: (...a: unknown[]) => notifyAttention(...a) }));

const broadcastSevereEvent = vi.fn().mockResolvedValue(true);
const broadcastSevereEventResolved = vi.fn().mockResolvedValue(true);
vi.mock('./severe-event-broadcast', () => ({
  broadcastSevereEvent: (...a: unknown[]) => broadcastSevereEvent(...a),
  broadcastSevereEventResolved: (...a: unknown[]) => broadcastSevereEventResolved(...a),
}));

import {
  evaluateDeployStaleness,
  deployStalenessThresholdSec,
  releaseDeployStalenessSweep,
} from './release-deploy-staleness-watchdog';
import type { DeployStateKind } from './release-deploy-launch';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function status(
  state: DeployStateKind,
  deployedAtMs: number | null,
  deployedBehindGreenPin: number | null = state === 'up-to-date' ? 0 : null,
) {
  return { state, deploy: { deployedAtMs, deployedBehindGreenPin } };
}

describe('evaluateDeployStaleness', () => {
  const thresholdMs = 3 * HOUR;

  it('is never stale below the threshold', () => {
    const v = evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: NOW - HOUR, now: NOW, thresholdMs });
    expect(v.stale).toBe(false);
  });

  it('flags stale once the green pin has sat deployable past the threshold', () => {
    const v = evaluateDeployStaleness({
      state: 'green-deployable',
      deployedAtMs: NOW - 4 * HOUR,
      greenDeployableSinceMs: NOW - 4 * HOUR,
      now: NOW,
      thresholdMs,
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/deployable-but-not-live for 4h/);
    expect(v.ageBasis).toBe('green-deployable-since');
  });

  /**
   * EI-20101010229759029 — THE REGRESSION. Measured live 2026-08-10: a 6h red gate went
   * green, and because `deployedAtMs` age also runs during red-gate windows it was ALREADY
   * 5h, so the watchdog fired instantly and announced a 5h stall. The real wait was ~3
   * minutes, and auto-serve had not yet had a single chance at its ≤15-min cadence.
   *
   * This is the falsifying case: it PASSES only because the threshold now reads the
   * condition's own clock. Revert the decider to `now - deployedAtMs` and it fails.
   */
  it('does NOT fire on the first green tick after a long red gate — the deployedAt clock ran while nothing was deployable', () => {
    const v = evaluateDeployStaleness({
      state: 'green-deployable',
      deployedAtMs: NOW - 5 * HOUR, // last deploy 5h ago; the gate was RED for ~6h of it
      greenDeployableSinceMs: NOW - 3 * 60_000, // deployable for 3 MINUTES
      now: NOW,
      thresholdMs,
    });
    expect(v.stale).toBe(false);
    expect(v.ageMs).toBe(3 * 60_000);
    expect(v.ageBasis).toBe('green-deployable-since');
  });

  it('the watermark is the operative clock — an ancient deployedAt cannot make a fresh condition stale', () => {
    const v = evaluateDeployStaleness({
      state: 'green-deployable',
      deployedAtMs: NOW - 999 * HOUR,
      greenDeployableSinceMs: NOW - 60_000,
      now: NOW,
      thresholdMs,
    });
    expect(v.stale).toBe(false);
  });

  it('falls back to deployedAt age when the watermark is unresolvable — and LABELS it inferred rather than measured', () => {
    const v = evaluateDeployStaleness({
      state: 'green-deployable',
      deployedAtMs: NOW - 4 * HOUR,
      greenDeployableSinceMs: null,
      now: NOW,
      thresholdMs,
    });
    expect(v.stale).toBe(true);
    expect(v.ageBasis).toBe('deployed-at-fallback');
    expect(v.reason).toMatch(/UPPER BOUND|inferred/);
    // The fallback must never assert the measured-wait sentence that read FALSE live.
    expect(v.reason).not.toMatch(/has been deployable-but-not-live for/);
  });

  it('is never stale outside the green-deployable state (up-to-date/gate-red/etc — something else already explains it)', () => {
    for (const s of ['up-to-date', 'gate-red', 'gate-wedged', 'staging-buffered', 'unknown'] as DeployStateKind[]) {
      expect(evaluateDeployStaleness({ state: s, deployedAtMs: NOW - 999 * HOUR, now: NOW, thresholdMs }).stale).toBe(false);
    }
  });

  it('flags stale when deployedAtMs is unresolvable (null) while green code waits — unknown is not assumed healthy', () => {
    const v = evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: null, now: NOW, thresholdMs });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/unresolvable/);
  });

  it('kill switch: thresholdMs <= 0 is never stale', () => {
    expect(evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: null, now: NOW, thresholdMs: 0 }).stale).toBe(false);
    expect(evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: NOW - 999 * HOUR, now: NOW, thresholdMs: -1 }).stale).toBe(false);
  });
});

describe('deployStalenessThresholdSec tunable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to 3h', () => {
    delete process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC;
    expect(deployStalenessThresholdSec()).toBe(10_800);
  });

  it('honors the env override (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '60';
    expect(deployStalenessThresholdSec()).toBe(60);
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '0';
    expect(deployStalenessThresholdSec()).toBe(0);
  });
});

describe('releaseDeployStalenessSweep', () => {
  beforeEach(() => {
    // EI-20101010229759029: these cases mean "the pin has been deployable for ages", which
    // is now the WATERMARK's job to say — an absent watermark would (correctly) start the
    // clock at zero on this very tick and nothing would be stale.
    greenSinceValue = String(Date.now() - 999 * HOUR);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC;
    escalationRows = [];
    recoveryUpdateCount = 0;
    sqlStatements.length = 0;
    greenSinceValue = null;
    settingsWrites.length = 0;
  });

  it('alerts + records a fire when stale and not already debounced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
    recentWatchdogFires.mockResolvedValueOnce(0);
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('alerted');
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'release-deploy-staleness', wakeAt: null }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[release-deploy-staleness] ALERT'));
    warn.mockRestore();
  });

  it('skips (debounced) when already fired recently', async () => {
    computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
    recentWatchdogFires.mockResolvedValueOnce(1);
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('skipped');
    expect(claimWatchdogFire).not.toHaveBeenCalled();
  });

  it('skips (debounced) when the atomic claim loses the race / backs off', async () => {
    computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
    recentWatchdogFires.mockResolvedValueOnce(0);
    claimWatchdogFire.mockResolvedValueOnce(false);
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('skipped');
  });

  it('is a no-op (healthy) when the pipeline is not in green-deployable', async () => {
    computeDeployStatus.mockReturnValue(status('up-to-date', Date.now() - 999 * HOUR));
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('healthy');
    expect(claimWatchdogFire).not.toHaveBeenCalled();
  });

  it('kill switch skips entirely without touching PG', async () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '0';
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('skipped');
    expect(gitPipelineSnapshot).not.toHaveBeenCalled();
  });

  it('degrades to outcome:error, never throws, on a snapshot failure', async () => {
    gitPipelineSnapshot.mockRejectedValueOnce(new Error('pg down'));
    await expect(releaseDeployStalenessSweep({})).resolves.toMatchObject({ outcome: 'error' });
  });

  /**
   * EI-20101010229759029 — the watermark's lifecycle, end-to-end through the sweep.
   * The decider tests above prove the arithmetic; these prove the sweep actually keeps
   * the clock it reads (a correct decider fed a clock nobody winds is still broken).
   */
  describe('deployable-since watermark (EI-20101010229759029)', () => {
    it('starts the clock on ENTRY and stays silent on that first tick — even with an ancient deployedAt', async () => {
      greenSinceValue = null; // nothing recorded yet: the gate just went green this tick
      computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res.outcome).toBe('healthy');
      expect(claimWatchdogFire).not.toHaveBeenCalled();
      expect(notifyAttention).not.toHaveBeenCalled();
      // and it WROTE the watermark, so the next tick measures from here
      expect(settingsWrites.length).toBe(1);
      expect(greenSinceValue).not.toBeNull();
    });

    it('retains the first observation across ticks rather than resetting the clock every sweep', async () => {
      greenSinceValue = null;
      computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
      await releaseDeployStalenessSweep({ installSlug: 'papercusp' });
      const firstWatermark = greenSinceValue;

      await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(greenSinceValue).toBe(firstWatermark);
      expect(settingsWrites.length).toBe(1); // second tick read, did not re-write
    });

    it('alerts once the WATERMARK itself passes the threshold', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      greenSinceValue = String(Date.now() - 4 * HOUR);
      computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 4 * HOUR));
      recentWatchdogFires.mockResolvedValueOnce(0);

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res.outcome).toBe('alerted');
      warn.mockRestore();
    });

    it('clears the clock when the condition ends, so a later re-entry starts fresh', async () => {
      computeDeployStatus.mockReturnValue(status('up-to-date', Date.now()));

      await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(greenSinceValue).toBeNull();
      expect(sqlStatements.some((s) => /^DELETE FROM harness_shared\.operator_settings/i.test(s))).toBe(true);
    });

    it('a KV failure degrades to the labelled fallback instead of breaking the sweep', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      greenSinceValue = null;
      settingsFail = true;
      computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
      recentWatchdogFires.mockResolvedValueOnce(0);

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      // Fallback clock ⇒ still alerts on a genuinely ancient deploy, but says it is inferred.
      expect(res.outcome).toBe('alerted');
      expect(res.verdict?.ageBasis).toBe('deployed-at-fallback');
      expect(res.verdict?.reason).toMatch(/UPPER BOUND|inferred/);
      settingsFail = false;
      warn.mockRestore();
    });
  });

  /**
   * EI-16537 — the alert has to LEAVE this process. Before this, a stale finding
   * produced only a console.warn + a ledger row; measured live, the sweep fired
   * correctly for 96h of unshipped code and paged nobody.
   */
  describe('paging rails (EI-16537)', () => {
    const stale = () => {
      computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 5 * HOUR));
      recentWatchdogFires.mockResolvedValueOnce(0);
    };

    it('pages the owner AND the fleet and writes a durable escalation row on a fresh stale episode', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stale();

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res).toMatchObject({ outcome: 'alerted', paged: true });
      expect(notifyAttention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'intervention', importance: 'urgent' }),
      );
      expect(broadcastSevereEvent).toHaveBeenCalledWith(
        expect.objectContaining({ conditionKey: 'release-deploy-staleness:papercusp', oneShot: true }),
      );
      expect(sqlStatements.some((s) => /^INSERT INTO harness_shared\.harness_escalations/i.test(s))).toBe(true);
      warn.mockRestore();
    });

    it('is ONE-SHOT until recovery: an episode already escalated never re-pages', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stale();
      escalationRows = [{ escalation: { kind: 'release-deploy-staleness-watchdog' } }];

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      // Still an alert for the ledger/EI leg (which keeps its own backoff) — but the
      // human/fleet rails stay silent for the rest of the episode.
      expect(res).toMatchObject({ outcome: 'alerted', paged: false });
      expect(notifyAttention).not.toHaveBeenCalled();
      expect(broadcastSevereEvent).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('retracts the page once the pipeline recovers', async () => {
      computeDeployStatus.mockReturnValue(status('up-to-date', Date.now()));
      recoveryUpdateCount = 1;

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res).toMatchObject({ outcome: 'healthy', recovered: true });
      expect(broadcastSevereEventResolved).toHaveBeenCalledWith(
        expect.objectContaining({ conditionKey: 'release-deploy-staleness:papercusp' }),
      );
    });

    it('does not retract the page while a deploy is in flight and the green pin remains ahead', async () => {
      computeDeployStatus.mockReturnValue(status('deploy-in-flight', Date.now(), 652));
      escalationRows = [{ escalation: { kind: 'release-deploy-staleness-watchdog' } }];
      recoveryUpdateCount = 1;

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res).toMatchObject({ outcome: 'healthy', recovered: false });
      expect(sqlStatements.some((s) => /^UPDATE harness_shared\.harness_escalations/i.test(s))).toBe(false);
      expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
    });

    it('a routinely-healthy pass retracts nothing and broadcasts nothing', async () => {
      computeDeployStatus.mockReturnValue(status('up-to-date', Date.now()));
      recoveryUpdateCount = 0;

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res).toMatchObject({ outcome: 'healthy', recovered: false });
      expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
    });

    it('alarm and recovery share ONE conditionKey — otherwise the all-clear never supersedes the alarm', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stale();
      await releaseDeployStalenessSweep({ installSlug: 'oddsmith' });

      computeDeployStatus.mockReturnValue(status('up-to-date', Date.now()));
      recoveryUpdateCount = 1;
      await releaseDeployStalenessSweep({ installSlug: 'oddsmith' });

      const alarmKey = (broadcastSevereEvent.mock.calls[0]?.[0] as { conditionKey?: string }).conditionKey;
      const clearKey = (broadcastSevereEventResolved.mock.calls[0]?.[0] as { conditionKey?: string }).conditionKey;
      expect(alarmKey).toBe('release-deploy-staleness:oddsmith');
      expect(clearKey).toBe(alarmKey);
      warn.mockRestore();
    });

    it('a paging failure never breaks the sweep, and one dead rail never silences the other', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stale();
      notifyAttention.mockRejectedValueOnce(new Error('push service down'));

      const res = await releaseDeployStalenessSweep({ installSlug: 'papercusp' });

      expect(res.outcome).toBe('alerted');
      expect(broadcastSevereEvent).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
