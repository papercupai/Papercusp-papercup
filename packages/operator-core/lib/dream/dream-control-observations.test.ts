import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import type { FlagAttestation } from '@papercusp/flags/server';
import { assessDreamControlObservationCurrentness, readDreamControlObservations, type ControlObservationScope } from './dream-control-observations';

const now = Date.parse('2026-10-17T12:00:00Z');
const runtime = { host: 'port-3170', processId: 'linux:boot:1234', buildSha: 'loaded-build' };
const scope: ControlObservationScope = { workspaceId: 'ws', potSlug: 'pot',
  since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z', expectedRuntime: runtime };
const flag = (key: FlagAttestation['key']): FlagAttestation => ({ key, resolvedValue: true, compiledDefault: true,
  source: 'env-override', observedAtMs: now, backendConfigured: false,
  overrideRead: { kind: 'not-read', storeConfigured: false, cacheKey: 'test', cacheGeneration: null,
    cacheLoadedAtMs: null, cacheAgeMs: null, ttlMs: 5000, ttlRemainingMs: 0, loadError: null } });
const deps = { now: () => now, workspace: () => 'ws', runtime: () => runtime,
  flags: async () => ({ dream: flag(FLAGS.DREAM_CYCLE), learningGovernor: flag(FLAGS.LEARNING_GOVERNOR) }) };
type Row = Record<string, unknown>;
function fixture(change: Record<string, readonly Row[]> = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tagged = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?');
    queries.push({ text, values });
    expect(text.trim()).toMatch(/^SELECT\b/); // writes fail even if introduced in a collaborator
    expect(values).toContain('ws');
    const key = Object.keys(change).find(k => text.includes(k));
    if (key) return change[key];
    if (text.includes('FROM harness_shared.routines')) return ['manual', 'auto'].map(mode => ({
      name: `dream-cycle-${mode}`, active: false, next_fire_at: null, metadata: {},
      payload_template: { mode, cycle: mode === 'manual' ? { timeoutMs: 12_345, maxCostUsd: 0.75 } : {} },
    }));
    if (text.includes('FROM harness_shared.gym_autoloop_config')) return [{
      workspace_id: 'ws', harness_slug: 'pot', enabled: true, budget_usd: 2, spent_usd: 0.25,
      status: 'idle', last_cycle: null, last_cycle_at: null, updated_at: now,
    }];
    if (text.includes('FROM harness_shared.learning_governor_loops')) return [{
      workspace_id: 'ws', loop_id: values[1], pot_slug: 'pot', budget_kind: 'per-cycle', budget_usd: null,
      spent_usd: 0, enabled: true, enforcement: 'native', registered_at: new Date(now), updated_at: new Date(now),
    }];
    return [];
  };
  return { sql: tagged as unknown as Sql, queries };
}

afterEach(() => vi.unstubAllEnvs());
describe('mutation-free Dream/Gym/Scout control observations', () => {
  it('reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch', async () => {
    vi.stubEnv('PAPERCUSP_GYM_BUDGET_FLOOR_USD', '0.8');
    const { sql, queries } = fixture();
    const value = await readDreamControlObservations(sql, scope, deps);
    expect(value.status).toBe('observed');
    expect(value.observations?.dream).toMatchObject({ status: 'observed', value: { resolved: {
      manual: { maxDreamsPerCycle: 3, maxCostUsd: 0.75, rolling24hCostUsd: 5, timeoutMs: 12_345, autoIdleRatioFloor: 0.5 },
      auto: { maxDreamsPerCycle: 3, maxCostUsd: 1, rolling24hCostUsd: 5, timeoutMs: 600_000, autoIdleRatioFloor: 0.5 },
    } } });
    expect(value.observations?.gym).toMatchObject({ value: {
      budgetFloorUsd: 0.8, remainingUsd: 1.75, cycleHardCapUsd: 1.75, nativeBudgetEligible: true, nullBudgetRefusesUnattended: true,
    } });
    expect(value.observations?.governors).toMatchObject({ value: { loops: [
      { budgetUsd: null }, { budgetUsd: null }, { budgetUsd: null },
    ], admission: 'not-evaluated' } });
    expect(value.observations?.activity).toMatchObject({ value: {
      dream: { rows: [], hasMore: false }, modelExecution: 'not-established',
      preLedgerPolicySkips: 'not-recorded-in-attempt-ledger', outputQuality: 'not-evaluated',
    } });
    expect(queries.length).toBeGreaterThan(5);
    expect(assessDreamControlObservationCurrentness(value, scope, now + 59_999)).toEqual({ current: true, reason: null });
  });

  it('keeps missing usage/cost NULL and exposes bounded actual rows and one-ideator zero-route raw provenance', async () => {
    const run = { workspace_id: 'ws', pot_slug: 'pot', run_id: 'r', started_at: scope.since, mode: 'auto', dream_usage: null,
      review_usage: null, cost_usd: null, dreamer_model: null, input_tokens: 0, output_tokens: 0 };
    const tick = { workspace_id: 'ws', install_slug: '@singleton', pot_slug: 'pot', tick_at: scope.since, origin: 'scout', status: 'ran',
      ideas_routed: 0, budget_used_usd: 0.12, detail: { ideators: [{ lens: 'analogical', ok: true, raw: 0, produced: 0 }] } };
    const { sql } = fixture({ 'FROM harness_shared.dream_runs': Array.from({ length: 21 }, (_, i) => ({ ...run, run_id: `r${i}` })),
      'FROM harness_shared.scout_ticks': [tick] });
    const value = await readDreamControlObservations(sql, scope, deps);
    expect(value.observations?.activity).toMatchObject({ status: 'observed', value: {
      dream: { hasMore: true, limit: 20, population: 'bounded-window-rows', rows: expect.arrayContaining([expect.objectContaining({ cost_usd: null, dreamer_model: null, dream_usage: null })]) },
      scout: { rows: [tick], observations: [{ origin: 'scout', ideatorCount: 1, lenses: ['analogical'], ideasRouted: 0, costUsd: 0.12, oneIdeatorZeroRoute: true, modelUsage: 'not-established' }] },
    } });
    if (value.observations?.activity.status === 'observed') expect(value.observations.activity.value.dream.rows).toHaveLength(20);
  });

  it.each([
    ['missing controls', { 'FROM harness_shared.gym_autoloop_config': [] }, 'gym'],
    ['wrong pot', { 'FROM harness_shared.gym_autoloop_config': [{ workspace_id: 'ws', harness_slug: 'other' }] }, 'gym'],
    ['missing routine', { 'FROM harness_shared.routines': [] }, 'dream'],
    ['invalid limits', { 'FROM harness_shared.routines': ['manual', 'auto'].map(mode => ({ name: `dream-cycle-${mode}`, active: false, payload_template: { mode, cycle: { maxDreamsPerCycle: 4 } } })) }, 'dream'],
    ['missing governor', { 'FROM harness_shared.learning_governor_loops': [] }, 'governors'],
    ['wrong activity origin', { 'FROM harness_shared.scout_ticks': [{ workspace_id: 'ws', install_slug: 'pot', origin: 'su-ideate' }] }, 'activity'],
    ['invalid gate payload', { 'FROM harness_shared.operator_gym_gates': [{ payload: [1, 2] }] }, 'gym'],
  ] as const)('reports %s as unknown rather than approved defaults', async (_label, change, section) => {
    const { sql } = fixture(change);
    const value = await readDreamControlObservations(sql, scope, deps);
    expect(value.status).toBe('unknown');
    expect(value.observations?.[section]).toMatchObject({ status: 'unknown', value: null });
    expect(assessDreamControlObservationCurrentness(value, scope, now).current).toBe(false);
  });

  it('preserves a real NULL Gym refusal separately from an unreadable control', async () => {
    const { sql } = fixture({ 'FROM harness_shared.gym_autoloop_config': [{
      workspace_id: 'ws', harness_slug: 'pot', enabled: true, budget_usd: null, spent_usd: 0, status: 'idle', updated_at: now,
    }] });
    const value = await readDreamControlObservations(sql, scope, deps);
    expect(value.observations?.gym).toMatchObject({ status: 'observed', value: {
      nativeBudgetEligible: false, cycleHardCapUsd: null, remainingUsd: null, autoloop: { budgetUsd: null },
    } });
  });

  it('refuses another serving runtime before touching flags or stores', async () => {
    const { sql, queries } = fixture();
    const flags = vi.fn(deps.flags);
    const value = await readDreamControlObservations(sql, { ...scope, expectedRuntime: { ...runtime, processId: 'another-process' } }, { ...deps, flags });
    expect(value).toMatchObject({ status: 'unknown', reason: 'wrong-or-unproven-serving-runtime', observations: null });
    expect(queries).toHaveLength(0);
    expect(flags).not.toHaveBeenCalled();
  });

  it('rejects missing/invalid/oversized/future scope before reading and refuses another workspace', async () => {
    const { sql, queries } = fixture();
    for (const input of [{ ...scope, potSlug: '' }, { ...scope, since: 'invalid' }, { ...scope, expectedRuntime: undefined },
      { ...scope, since: '2026-01-01T00:00:00Z' }, { ...scope, until: '2026-10-17T13:00:00Z' }])
      await expect(readDreamControlObservations(sql, input as ControlObservationScope, deps)).rejects.toThrow();
    await expect(readDreamControlObservations(sql, { ...scope, workspaceId: 'other' }, deps)).rejects.toThrow('wrong-serving-workspace');
    expect(queries).toHaveLength(0);
  });

  it('invalidates stored evidence on time, process, build, scope or window changes', async () => {
    const value = await readDreamControlObservations(fixture().sql, scope, deps);
    for (const time of [now - 1, now + 60_000, Number.NaN])
      expect(assessDreamControlObservationCurrentness(value, scope, time).current).toBe(false);
    for (const input of [{ ...scope, potSlug: 'other' }, { ...scope, since: '2026-10-16T13:00:00Z' },
      { ...scope, expectedRuntime: { ...runtime, buildSha: 'new-build' } }])
      expect(assessDreamControlObservationCurrentness(value, input, now).current).toBe(false);
    expect(assessDreamControlObservationCurrentness({ ...value, expiresAt: new Date(now + 999_999).toISOString() }, scope, now).current).toBe(false);
    const slow = await readDreamControlObservations(fixture().sql, scope, { ...deps, now: vi.fn().mockReturnValueOnce(now).mockReturnValue(now + 60_000) });
    expect(slow).toMatchObject({ status: 'unknown', reason: 'read-expired-or-clock-invalid' });
  });

  it('refuses degraded flags instead of certifying a default as a loaded runtime override', async () => {
    const value = await readDreamControlObservations(fixture().sql, scope, { ...deps, flags: async () => ({
      dream: { ...flag(FLAGS.DREAM_CYCLE), source: 'compiled-default', overrideRead: { ...flag(FLAGS.DREAM_CYCLE).overrideRead, kind: 'unconfigured' } },
      learningGovernor: flag(FLAGS.LEARNING_GOVERNOR),
    }) });
    expect(value.status).toBe('unknown');
    expect(value.observations?.flags).toMatchObject({ status: 'unknown', reason: 'flag-override-read-unavailable' });
  });
});
