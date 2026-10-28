import { describe, expect, it } from 'vitest';
import { DESKTOP_PERF_BUDGETS, evaluateInteractionBudget } from './desktop-perf-budgets';

describe('DESKTOP_PERF_BUDGETS', () => {
  it('declares the plan-popup-open interaction budget (WI-5547)', () => {
    expect(DESKTOP_PERF_BUDGETS.interactions['plan-popup-open']).toBe(1500);
  });

  it('declares the P-013 Inbox bulk-report-open budget', () => {
    expect(DESKTOP_PERF_BUDGETS.interactions['inbox-bulk-report-open']).toBe(1500);
    expect(evaluateInteractionBudget('inbox-bulk-report-open', 1500).ok).toBe(true);
    expect(evaluateInteractionBudget('inbox-bulk-report-open', 1501).ok).toBe(false);
  });

  it('declares the P-006 broadened interaction budgets', () => {
    expect(DESKTOP_PERF_BUDGETS.interactions['command-palette-open']).toBe(400);
    expect(DESKTOP_PERF_BUDGETS.interactions['conversation-thread-load']).toBe(1500);
    expect(DESKTOP_PERF_BUDGETS.interactions['harness-dock-open']).toBe(1500);
    expect(DESKTOP_PERF_BUDGETS.interactions['report-markdown-first-mount']).toBe(1500);
    expect(DESKTOP_PERF_BUDGETS.interactions['report-markdown-input-delay']).toBe(200);
  });

  it('evaluates each P-006 interaction against its own budget', () => {
    // over budget → fail; at/under → pass, per interaction key.
    expect(evaluateInteractionBudget('command-palette-open', 401).ok).toBe(false);
    expect(evaluateInteractionBudget('command-palette-open', 400).ok).toBe(true);
    expect(evaluateInteractionBudget('conversation-thread-load', 1600).ok).toBe(false);
    expect(evaluateInteractionBudget('harness-dock-open', 1500).ok).toBe(true);
  });

  it('preserves the historical suite thresholds extracted in P-004', () => {
    expect(DESKTOP_PERF_BUDGETS.warmRouteSettleMs).toBe(1500);
    expect(DESKTOP_PERF_BUDGETS.interactionMaxMs).toBe(200);
    expect(DESKTOP_PERF_BUDGETS.chaosInpP95Ms).toBe(250);
    expect(DESKTOP_PERF_BUDGETS.chaosInpMaxMs).toBe(500);
    expect(DESKTOP_PERF_BUDGETS.chaosMaxFrameMs).toBe(200);
    expect(DESKTOP_PERF_BUDGETS.chaosMaxFrameDrops).toBe(8);
    expect(DESKTOP_PERF_BUDGETS.maxProcessRssKb).toBe(3584 * 1024);
  });
});

describe('evaluateInteractionBudget', () => {
  it('passes a measure at or under its budget', () => {
    expect(evaluateInteractionBudget('plan-popup-open', 1500).ok).toBe(true);
    expect(evaluateInteractionBudget('plan-popup-open', 1200).ok).toBe(true);
  });

  it('fails a measure over its budget and reports both numbers', () => {
    const v = evaluateInteractionBudget('plan-popup-open', 1600);
    expect(v.ok).toBe(false);
    expect(v.budgetMs).toBe(1500);
    expect(v.measuredMs).toBe(1600);
    expect(v.name).toBe('plan-popup-open');
  });

  it('passes an UNBUDGETED interaction (recorded, never a failure) with budgetMs null', () => {
    const v = evaluateInteractionBudget('some-future-interaction', 99_999);
    expect(v.ok).toBe(true);
    expect(v.budgetMs).toBeNull();
  });

  it('honors an override budget table', () => {
    const tighter = { ...DESKTOP_PERF_BUDGETS, interactions: { 'plan-popup-open': 1000 } };
    expect(evaluateInteractionBudget('plan-popup-open', 1200, tighter).ok).toBe(false);
    expect(evaluateInteractionBudget('plan-popup-open', 900, tighter).ok).toBe(true);
  });
});
