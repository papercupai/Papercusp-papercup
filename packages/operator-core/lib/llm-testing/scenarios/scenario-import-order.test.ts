/**
 * The scenario catalog must load no matter which module enters the graph first
 * (WI-6554700010030765).
 *
 * scenarios/index.ts spreads each scenario module's exported array at module
 * evaluation. If a scenario module can reach index.ts through its own static
 * imports, then entering the graph through that scenario evaluates index.ts while
 * the scenario's `const` is still uninitialised, and the spread throws
 * `SU_S42_DRAIN_WATCH_RECHECK is not iterable`. Production code reaches the S42
 * scenario first (scorecards -> rubric-instrument-registry ->
 * fleet/capacity-recovery-evidence), and S42 used to reach the catalog through
 * agent-tools/events/watch -> ... -> blueprint-steps/index ->
 * ops/prompt-ablation -> ablation/run -> ablation/runner. That broke every test
 * whose import graph entered through scorecards, for example
 * dream/dream-control-live-instrument.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

describe('llm-testing scenario catalog import order', () => {
  it('loads when the S42 scenario module is entered before the catalog index', async () => {
    vi.resetModules();
    const s42 = await import('./su/S42-drain-watch-recheck');
    const catalog = await import('./index');

    expect(Array.isArray(s42.SU_S42_DRAIN_WATCH_RECHECK)).toBe(true);
    expect(s42.SU_S42_DRAIN_WATCH_RECHECK.length).toBeGreaterThan(0);
    const suIds = new Set(catalog.getScenariosForTarget('su').map(scenario => scenario.id));
    for (const scenario of s42.SU_S42_DRAIN_WATCH_RECHECK) expect(suIds.has(scenario.id)).toBe(true);
  });
});
