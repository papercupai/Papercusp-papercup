/**
 * su-cold-by-default — P-021 verdict-gated cold-by-default resolver tests
 * (deterministic-context-carry-2026-07-14, WI-5000) + the shared P-026 read
 * (carryProvenClassForOwner, WI-5001).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_EXCHANGE_WINDOW_MS,
  DRILL_VERDICT_CACHE_MS,
  _resetColdByDefaultMemoForTests,
  carryProvenClassForOwner,
  classDefaultColdForWake,
  decideClassDefaultCold,
} from './su-cold-by-default';
import { sessionClassForHost } from './events/await/psu-pty-discovery';

afterEach(() => {
  _resetColdByDefaultMemoForTests();
  vi.restoreAllMocks();
});

describe('sessionClassForHost — the canonical ownerId→class mapping (one vocabulary)', () => {
  it("bridgeTty:false is the ONLY headless signal — everything else is 'claude-interactive'", () => {
    expect(sessionClassForHost({ bridgeTty: false })).toBe('claude-headless');
    expect(sessionClassForHost({ bridgeTty: true })).toBe('claude-interactive');
    // Old hosts (field absent) + null-ish fail-soft interactive — the SAFE direction
    // (interactive additionally requires the no-recent-human-input guard).
    expect(sessionClassForHost({})).toBe('claude-interactive');
    expect(sessionClassForHost({ bridgeTty: null })).toBe('claude-interactive');
    expect(sessionClassForHost(null)).toBe('claude-interactive');
    expect(sessionClassForHost(undefined)).toBe('claude-interactive');
  });
});

describe('decideClassDefaultCold — the pure P-021 ladder', () => {
  const base = {
    flagOn: true,
    sessionClass: 'claude-headless',
    sufficientClasses: ['claude-headless'],
    lastHumanInputAtMs: null,
    nowMs: 1_000_000_000,
  };

  it('cold when flag on + class proven + no human input on record', () => {
    expect(decideClassDefaultCold(base)).toEqual({
      cold: true,
      reason: "class 'claude-headless' drill-proven cold-by-default (P-021)",
    });
  });

  it('the kill-switch flag off is warm regardless of everything else', () => {
    expect(decideClassDefaultCold({ ...base, flagOn: false }).cold).toBe(false);
  });

  it('an unproven class is warm — the verdict is per-class, never global', () => {
    expect(decideClassDefaultCold({ ...base, sessionClass: 'claude-interactive' }).cold).toBe(false);
    expect(decideClassDefaultCold({ ...base, sufficientClasses: [] }).cold).toBe(false);
  });

  it('a recent human keystroke = an ACTIVE INTERACTIVE EXCHANGE — stays warm (the plan carve-out)', () => {
    const recent = decideClassDefaultCold({
      ...base,
      sessionClass: 'claude-interactive',
      sufficientClasses: ['claude-interactive'],
      lastHumanInputAtMs: base.nowMs - 5 * 60_000, // 5 min ago, inside the 30-min window
    });
    expect(recent).toEqual({
      cold: false,
      reason: 'active interactive exchange (recent human input) — stays warm',
    });
  });

  it('a keystroke OLDER than the window no longer holds the wake warm', () => {
    const idle = decideClassDefaultCold({
      ...base,
      sessionClass: 'claude-interactive',
      sufficientClasses: ['claude-interactive'],
      lastHumanInputAtMs: base.nowMs - ACTIVE_EXCHANGE_WINDOW_MS - 1,
    });
    expect(idle.cold).toBe(true);
  });

  it('a custom window override is honoured (tests / env tuning)', () => {
    const input = {
      ...base,
      sessionClass: 'claude-interactive',
      sufficientClasses: ['claude-interactive'],
      lastHumanInputAtMs: base.nowMs - 10_000,
    };
    expect(decideClassDefaultCold({ ...input, windowMs: 5_000 }).cold).toBe(true);
    expect(decideClassDefaultCold({ ...input, windowMs: 60_000 }).cold).toBe(false);
  });
});

describe('classDefaultColdForWake — the live resolver (fail-soft, memoized)', () => {
  const headlessHost = { bridgeTty: false as const, lastInputAt: null };

  it('resolves the full ladder: flag + drill verdict + host class → cold', async () => {
    const reportFn = vi.fn(async () => ({ sufficientClasses: ['claude-headless'] }));
    await expect(
      classDefaultColdForWake(headlessHost, { getFlagFn: async () => true, reportFn }),
    ).resolves.toBe(true);
  });

  it('no host view ⇒ warm (cannot classify)', async () => {
    await expect(
      classDefaultColdForWake(null, { getFlagFn: async () => true, reportFn: async () => ({ sufficientClasses: ['claude-headless'] }) }),
    ).resolves.toBe(false);
  });

  it('flag off short-circuits BEFORE the ledger read (no report call)', async () => {
    const reportFn = vi.fn(async () => ({ sufficientClasses: ['claude-headless'] }));
    await expect(classDefaultColdForWake(headlessHost, { getFlagFn: async () => false, reportFn })).resolves.toBe(false);
    expect(reportFn).not.toHaveBeenCalled();
  });

  it('an empty verdict (nothing proven) is warm without evaluating further', async () => {
    await expect(
      classDefaultColdForWake(headlessHost, { getFlagFn: async () => true, reportFn: async () => ({ sufficientClasses: [] }) }),
    ).resolves.toBe(false);
  });

  it('FAIL-SOFT: a throwing flag store or ledger read is warm, never a thrown wake', async () => {
    await expect(
      classDefaultColdForWake(headlessHost, {
        getFlagFn: async () => {
          throw new Error('flag store down');
        },
      }),
    ).resolves.toBe(false);
    await expect(
      classDefaultColdForWake(headlessHost, {
        getFlagFn: async () => true,
        reportFn: async () => {
          throw new Error('ledger unreadable');
        },
      }),
    ).resolves.toBe(false);
  });

  it(`memoizes the drill verdict for ${DRILL_VERDICT_CACHE_MS}ms (a busy pump never re-parses per wake)`, async () => {
    const reportFn = vi.fn(async () => ({ sufficientClasses: ['claude-headless'] }));
    let now = 1_000_000;
    const deps = { getFlagFn: async () => true, reportFn, now: () => now };
    await classDefaultColdForWake(headlessHost, deps);
    await classDefaultColdForWake(headlessHost, deps);
    expect(reportFn).toHaveBeenCalledTimes(1);
    now += DRILL_VERDICT_CACHE_MS + 1;
    await classDefaultColdForWake(headlessHost, deps);
    expect(reportFn).toHaveBeenCalledTimes(2);
  });

  it('the memo survives a later read failure (stale verdict beats no verdict)', async () => {
    let now = 1_000_000;
    let fail = false;
    const reportFn = vi.fn(async () => {
      if (fail) throw new Error('transient');
      return { sufficientClasses: ['claude-headless'] };
    });
    const deps = { getFlagFn: async () => true, reportFn, now: () => now };
    await expect(classDefaultColdForWake(headlessHost, deps)).resolves.toBe(true);
    fail = true;
    now += DRILL_VERDICT_CACHE_MS + 1;
    await expect(classDefaultColdForWake(headlessHost, deps)).resolves.toBe(true);
  });

  it('an interactive host with a fresh keystroke stays warm even when its class is proven', async () => {
    const now = Date.now();
    await expect(
      classDefaultColdForWake(
        { bridgeTty: true, lastInputAt: now - 60_000 },
        { getFlagFn: async () => true, reportFn: async () => ({ sufficientClasses: ['claude-interactive'] }), now: () => now },
      ),
    ).resolves.toBe(false);
  });
});

describe('carryProvenClassForOwner — the shared P-026 read (WI-5001)', () => {
  it('returns the class when the owner’s live host classifies into a proven class', async () => {
    await expect(
      carryProvenClassForOwner('su-x', {
        findHostFn: async () => ({ bridgeTty: false, lastInputAt: null }),
        reportFn: async () => ({ sufficientClasses: ['claude-headless'] }),
      }),
    ).resolves.toBe('claude-headless');
  });

  it('null when the class is not proven / nothing is proven', async () => {
    await expect(
      carryProvenClassForOwner('su-x', {
        findHostFn: async () => ({ bridgeTty: true, lastInputAt: null }),
        reportFn: async () => ({ sufficientClasses: ['claude-headless'] }),
      }),
    ).resolves.toBe(null);
  });

  it('null when the owner has NO live host (cannot classify ⇒ keep the enrichment)', async () => {
    await expect(
      carryProvenClassForOwner('su-x', {
        findHostFn: async () => null,
        reportFn: async () => ({ sufficientClasses: ['claude-headless', 'claude-interactive'] }),
      }),
    ).resolves.toBe(null);
  });

  it('deliberately does NOT apply the active-exchange guard (a compaction already happened)', async () => {
    await expect(
      carryProvenClassForOwner('su-x', {
        findHostFn: async () => ({ bridgeTty: true, lastInputAt: Date.now() }),
        reportFn: async () => ({ sufficientClasses: ['claude-interactive'] }),
      }),
    ).resolves.toBe('claude-interactive');
  });

  it('FAIL-SOFT null on any resolution failure', async () => {
    await expect(
      carryProvenClassForOwner('su-x', {
        findHostFn: async () => {
          throw new Error('discovery dir gone');
        },
      }),
    ).resolves.toBe(null);
    await expect(carryProvenClassForOwner('', {})).resolves.toBe(null);
  });
});
