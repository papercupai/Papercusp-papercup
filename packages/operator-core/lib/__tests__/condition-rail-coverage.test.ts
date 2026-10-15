import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import * as recorder from '../degradation/fallback-observations';
import { acceptanceProblems, inventoryTree, migrationCoverageProblems } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { listDegradationMechanisms } from '../system-health/degradation-watchdog';
import { RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS } from '../degradation/rail-migration-cases';
import { original, execute } from '../degradation/host-startup-migration-cases';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url)), 'utf8'));
let currentTree: ReturnType<typeof inventoryTree> | undefined;
function currentInventory(): ReturnType<typeof inventoryTree> {
  if (currentTree) return currentTree;
  const startedAt = Date.now();
  console.info('[condition-rail-coverage] current-tree census started');
  currentTree = inventoryTree(fileURLToPath(new URL('../../../../', import.meta.url)));
  console.info(`[condition-rail-coverage] current-tree census finished in ${Date.now() - startedAt}ms`);
  return currentTree;
}

// Some real producers import configuration whose readiness promise reads the
// operator-state store during module evaluation. Install this dependency seam
// before imports, rather than waiting for beforeEach after the read has started.
const operatorState = vi.hoisted(() => ({
  read: vi.fn(async () => null),
  write: vi.fn(async () => undefined),
}));
vi.mock('../operator-state-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../operator-state-pg')>()),
  readOperatorState: operatorState.read,
  writeOperatorState: operatorState.write,
}));

// These cases verify real producers at their dependency seams. Durable INSERTs
// have separate integration coverage; never let incidental imported telemetry
// flush against the unit fixture's database. A case replaces this sink to assert
// its exact observation; the default also covers import-time initialization.
beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
afterEach(() => { recorder._resetFallbackObservationsForTests(); vi.restoreAllMocks(); });

describe('condition-rail per-row executable coverage (P-017)', () => {
  it('isolates import-time release configuration reads from real PostgreSQL', async () => {
    const blockedBefore = readRealPgRailBlocks().blocked;
    expect(blockedBefore).toBe(0);
    const config = await import('../release-checkpoint-config');
    await config.releaseCheckpointConfigReady;
    expect(operatorState.read).toHaveBeenCalledWith('operator_release_checkpoint_config');
    expect(config.releaseCheckpointConfig()).toEqual(config.RELEASE_CHECKPOINT_DEFAULTS);
    expect(readRealPgRailBlocks().blocked).toBe(blockedBefore);
  });

  it('has a matching executable case for every row in every completed migration', () => {
    expect(migrationCoverageProblems(manifest, RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS,
      listDegradationMechanisms().map((mechanism) => mechanism.mechanism))).toEqual([]);
  });

  describe('strict acceptance controls on the actual immutable seed and current tree', () => {
    const conditionId = 'bespoke-watchdog|packages/operator-core/lib/system-health/goal-liveness-watchdog.ts|<module>|1';
    const observationId = 'log-only-fallback|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts|maybeForceRespawn|1';
    let live: ReturnType<typeof inventoryTree>;
    let mechanisms: string[];
    let baselineProblems: string[];
    beforeAll(() => {
      live = currentInventory();
      mechanisms = listDegradationMechanisms().map((entry) => entry.mechanism);
      baselineProblems = acceptanceProblems(manifest, live, RAIL_MIGRATION_CASES, mechanisms);
      expect(live.unreadable).toBe(0);
      for (const id of [conditionId, observationId]) {
        expect(manifest.rows.find((row: { id: string }) => row.id === id), id)
          .toMatchObject({ disposition: 'migrate', item: 'P-014' });
        expect(live.sites.find((site: { id: string }) => site.id === id), id)
          .toMatchObject({ onRail: true });
        expect(baselineProblems.filter((problem) => problem.startsWith(id + ':')), id).toEqual([]);
      }
    }, 120_000);

    function expectExactDelta(problems: string[], expected: string): void {
      expect(problems.filter((problem) => !baselineProblems.includes(problem))).toEqual([expected]);
      expect(baselineProblems.filter((problem) => !problems.includes(problem))).toEqual([]);
    }

    it('names the exact original runtime row when only that live site moves off the rail', () => {
      const site = live.sites.find((entry: { id: string }) => entry.id === conditionId)!;
      const changed = {
        ...live,
        sites: live.sites.map((entry: { id: string }) => entry.id === conditionId ? { ...entry, onRail: false } : entry),
        rows: [...live.rows, { ...site, onRail: false, disposition: { disposition: 'migrate', item: 'P-014' }, problem: null }],
      };
      expectExactDelta(acceptanceProblems(manifest, changed, RAIL_MIGRATION_CASES, mechanisms),
        conditionId + ': completed migration still bypasses rail');
    });

    it('names a missing original-row case even when the incremental completion list is empty', () => {
      const cases = RAIL_MIGRATION_CASES.map((entry) => ({
        ...entry, rowIds: entry.rowIds.filter((id) => id !== conditionId),
      }));
      const expected = conditionId + ': completed migration has no case';
      expect(migrationCoverageProblems(manifest, cases, [], mechanisms)).not.toContain(expected);
      expectExactDelta(acceptanceProblems(manifest, live, cases, mechanisms), expected);
    });

    it('names only the original observation row whose mechanism is no longer registered', () => {
      const testCase = RAIL_MIGRATION_CASES.find((entry) => entry.rowIds.includes(observationId))!;
      expect(testCase).toMatchObject({ item: 'P-014', route: 'observation' });
      expect(mechanisms).toContain(testCase.mechanism);
      const unregistered = '__condition_rail_unregistered_control__';
      expect(mechanisms).not.toContain(unregistered);
      // Split this row out so any siblings keep their real case and mechanism.
      const cases = [
        ...RAIL_MIGRATION_CASES.map((entry) => ({ ...entry, rowIds: entry.rowIds.filter((id) => id !== observationId) })),
        { ...testCase, id: testCase.id + '-unregistered-control', rowIds: [observationId], mechanism: unregistered },
      ];
      expectExactDelta(acceptanceProblems(manifest, live, cases, mechanisms),
        observationId + ': unregistered observation mechanism');
    });
  });

  it('keeps the reviewed P-013 histogram and unit-tier refusal outside runtime degradation', async () => {
    const histogramId = 'health-flag-no-condition|packages/operator-core/lib/consult/consult-routing-health.ts|expertiseExecutionHealthFromRows|1';
    const guardId = 'log-only-fallback|packages/agent-mcp/src/entity-resolvers-papercusp.ts|assertNotUnitTier|1';
    for (const rowId of [histogramId, guardId]) {
      expect(manifest.rows.find((row: { id: string }) => row.id === rowId)?.disposition).toBe('migrate');
      expect(manifest.amendments.find((row: { rowId: string }) => row.rowId === rowId)).toMatchObject({
        change: { disposition: 'not-applicable' }, reviewerRef: 'thread-post:1175978',
      });
    }

    const { expertiseExecutionHealthFromRows } = await import('../consult/consult-routing-health');
    const read = expertiseExecutionHealthFromRows(['returned', 'degraded', 'threw'].map((outcome) => ({
      metadata_json: { schemaVersion: 1, caller: 'fixture', policy: 'fixture', outcome },
    })));
    expect(read.groups).toHaveLength(1);
    expect(read.groups[0].outcomes).toEqual({ returned: 1, degraded: 1, threw: 1 });
    expect(recorder.observeFallback).not.toHaveBeenCalled();

    // Execute the actual original guard without importing its live entity registry.
    const env: Record<string, string> = { VITEST: 'true' };
    const errors: string[] = [];
    const guard = execute('console.error = reportError;\n' + original('packages/agent-mcp/src/entity-resolvers-papercusp.ts',
      'function assertNotUnitTier', 'function'), { process: { env },
      reportError: (message: string) => errors.push(message),
    }, 'assertNotUnitTier') as () => void;
    expect(guard).toThrow('UNIT-tier test reached the live org database');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('UNIT-TIER DB REACH REFUSED');
    env.PAPERCUSP_ALLOW_DB_IN_TESTS = '1';
    expect(guard).not.toThrow();
    delete env.VITEST;
    delete env.PAPERCUSP_ALLOW_DB_IN_TESTS;
    expect(guard).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(recorder.observeFallback).not.toHaveBeenCalled();
  });

  it('retains each implemented P-011, P-013 and P-014 original site identity on the rail', () => {
    const live = currentInventory();
    expect(live.unreadable).toBe(0);
    for (const testCase of RAIL_MIGRATION_CASES.filter((entry) => ['P-011', 'P-013', 'P-014'].includes(entry.item))) {
      for (const id of testCase.rowIds) {
        expect(manifest.rows.find((row: { id: string }) => row.id === id), id).toBeDefined();
        expect(live.sites.find((site: { id: string }) => site.id === id)?.onRail, id).toBe(true);
      }
    }
  }, 120_000);

  for (const testCase of RAIL_MIGRATION_CASES) {
    it(`${testCase.item}: ${testCase.id}`, async () => {
      const blockedBefore = readRealPgRailBlocks().blocked;
      const result = await testCase.run();
      expect(readRealPgRailBlocks().blocked, `${testCase.id}: producer dependency escaped to real PostgreSQL`)
        .toBe(blockedBefore);
      expect(result.route).toBe(testCase.route);
      if (result.route === 'condition') {
        expect(result.openedKeys.length).toBeGreaterThan(0);
        expect([...result.openedKeys].sort()).toEqual([...result.resolvedKeys].sort());
      } else {
        expect(result.mechanism).toBe(testCase.mechanism);
        expect(result.observations.length).toBeGreaterThan(0);
        for (const observation of result.observations) {
          expect(observation.eligible).toBeGreaterThan(0);
          expect(observation.applied).toBeGreaterThanOrEqual(0);
          expect(observation.applied).toBeLessThanOrEqual(observation.eligible);
          expect(observation.reason.trim()).not.toBe('');
        }
        if (testCase.item === 'P-015') {
          expect(result.observations.some((row) => row.eligible === 1 && row.applied === 1)).toBe(true);
          expect(result.observations.some((row) => row.eligible === 1 && row.applied === 0)).toBe(true);
        }
      }
    });
  }

  it('catches missing cases, invalid routes, and unregistered observation mechanisms', () => {
    const row = { id: 'one', disposition: 'migrate', item: 'P-010', route: 'observation' };
    const fixture = { rows: [row], amendments: [] };
    expect(migrationCoverageProblems(fixture, [], ['P-010'], []).join()).toMatch(/has no case/);
    const testCase = { id: 'case', item: 'P-010', rowIds: ['one'], route: 'observation', mechanism: 'x', run: () => ({}) };
    expect(migrationCoverageProblems(fixture, [testCase], ['P-010'], []).join()).toMatch(/unregistered/);
    expect(migrationCoverageProblems(fixture, [testCase], ['P-010'], ['x'])).toEqual([]);
    expect(migrationCoverageProblems({ rows: [{ ...row, route: '' }], amendments: [] }, [], [], []).join()).toMatch(/missing route/);
  });
});
