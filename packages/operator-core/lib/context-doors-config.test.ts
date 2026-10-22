/**
 * context-doors-config.test.ts — the P-023 config surface over the door/threshold
 * constants (deterministic-context-carry-2026-07-14).
 *
 * The operator-state PG layer is replaced with an in-memory store, so the real
 * sanitize/merge/prune/snapshot logic runs with NO database. Asserts: sanitization
 * (bad fields drop; doorSplit is all-or-nothing and must sum to 1) · layered resolve
 * (BAKED ⟵ workspace ⟵ session; expired session ignored; floor>cap clamps) · session
 * write/prune (stamp, clear, age GC, entry bound) · the sync snapshot (baked before
 * the first refresh, configured after, kill-switch) · the override concern.
 *
 * Run: cd packages/operator-core && npx vitest run lib/context-doors-config.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

const store = new Map<string, unknown>();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async (table: string) => (store.has(table) ? store.get(table) : null)),
  writeOperatorState: vi.fn(async (table: string, payload: unknown) => { store.set(table, payload); }),
  invalidateOperatorStateCache: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

import { BAKED_DOOR_CONSTANTS, computeTurnDoors } from './context-doors';
import {
  SESSION_DOORS_OVERRIDE_MAX_AGE_MS,
  SESSION_DOORS_OVERRIDE_MAX_ENTRIES,
  getDoorConstantsSync,
  invalidateDoorConstantsSnapshot,
  readContextDoorsConfig,
  resolveDoorConstants,
  sanitizeDoorPatch,
  writeContextDoorsDefaults,
  writeSessionDoorsOverride,
  type ContextDoorsConfigRow,
} from './context-doors-config';
import { getOverrideConcern } from './config-overrides/registry';
import { readOperatorState } from './operator-state-pg';

const TABLE = 'operator_context_doors_config';

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  invalidateDoorConstantsSnapshot();
  delete process.env.PAPERCUSP_DOORS_CONFIG_OFF;
});
afterEach(() => {
  delete process.env.PAPERCUSP_DOORS_CONFIG_OFF;
});

describe('sanitizeDoorPatch', () => {
  it('keeps valid fields, drops invalid ones silently (never throws)', () => {
    expect(
      sanitizeDoorPatch({
        maxTurnFloorTokens: 10_000,
        maxTurnCapTokens: -5, // invalid → dropped
        maxTurnWindowDivisor: 0.5, // < 1 → dropped
        compactionOverheadTokens: 0, // 0 is valid (≥ 0)
        junk: 'ignored',
      }),
    ).toEqual({ maxTurnFloorTokens: 10_000, compactionOverheadTokens: 0 });
    expect(sanitizeDoorPatch(null)).toEqual({});
    expect(sanitizeDoorPatch('nonsense')).toEqual({});
  });

  it('doorSplit is all-or-nothing and must sum to 1 with an integer slot count', () => {
    const good = { output: 0.4, resultEach: 0.2, resultSlots: 2, injections: 0.2 }; // 0.4+0.4+0.2 = 1
    expect(sanitizeDoorPatch({ doorSplit: good }).doorSplit).toEqual(good);
    // sum ≠ 1 → dropped
    expect(sanitizeDoorPatch({ doorSplit: { ...good, injections: 0.3 } }).doorSplit).toBeUndefined();
    // fractional slots → dropped
    expect(sanitizeDoorPatch({ doorSplit: { ...good, resultSlots: 1.5 } }).doorSplit).toBeUndefined();
    // missing member → dropped
    expect(sanitizeDoorPatch({ doorSplit: { output: 0.5, resultEach: 0.25, resultSlots: 2 } }).doorSplit).toBeUndefined();
  });
});

describe('resolveDoorConstants (BAKED ⟵ workspace ⟵ session)', () => {
  it('null/empty row is exactly the baked constants', () => {
    expect(resolveDoorConstants(null)).toEqual(BAKED_DOOR_CONSTANTS);
    expect(resolveDoorConstants({}, 'su-x')).toEqual(BAKED_DOOR_CONSTANTS);
  });

  it('workspace defaults override baked; a session override wins over both — per key', () => {
    const row: ContextDoorsConfigRow = {
      defaults: { maxTurnFloorTokens: 10_000, compactionOverheadTokens: 6_000 },
      sessions: {
        'su-x': { overrides: { maxTurnFloorTokens: 12_000 }, setBy: 'su-x', setAt: Date.now(), provenance: 't' },
      },
    };
    const noSession = resolveDoorConstants(row, null);
    expect(noSession.maxTurnFloorTokens).toBe(10_000);
    expect(noSession.compactionOverheadTokens).toBe(6_000);
    const withSession = resolveDoorConstants(row, 'su-x');
    expect(withSession.maxTurnFloorTokens).toBe(12_000); // session key wins
    expect(withSession.compactionOverheadTokens).toBe(6_000); // workspace key shows through
    expect(withSession.maxTurnCapTokens).toBe(BAKED_DOOR_CONSTANTS.maxTurnCapTokens);
  });

  it('an expired session override is ignored (TTL age cap)', () => {
    const row: ContextDoorsConfigRow = {
      sessions: {
        'su-x': {
          overrides: { maxTurnFloorTokens: 12_000 },
          setBy: 'su-x',
          setAt: Date.now() - SESSION_DOORS_OVERRIDE_MAX_AGE_MS - 1,
          provenance: 't',
        },
      },
    };
    expect(resolveDoorConstants(row, 'su-x')).toEqual(BAKED_DOOR_CONSTANTS);
  });

  it('a merged floor above the cap clamps the floor DOWN (never inverted)', () => {
    const c = resolveDoorConstants({ defaults: { maxTurnFloorTokens: 40_000 } }, null);
    expect(c.maxTurnFloorTokens).toBe(BAKED_DOOR_CONSTANTS.maxTurnCapTokens);
    expect(c.maxTurnFloorTokens).toBeLessThanOrEqual(c.maxTurnCapTokens);
  });

  it('feeds computeTurnDoors: a raised floor raises every door proportionally', () => {
    const c = resolveDoorConstants({ defaults: { maxTurnFloorTokens: 12_000 } }, null);
    expect(computeTurnDoors(0, c)).toEqual({ maxTurn: 12_000, output: 6_000, resultEach: 2_250, resultSlots: 2, injections: 1_500 });
  });
});

describe('writes', () => {
  it('writeContextDoorsDefaults sanitizes and persists; {} clears the layer', async () => {
    await writeContextDoorsDefaults({ maxTurnFloorTokens: 9_000, maxTurnCapTokens: -1 as never });
    expect((store.get(TABLE) as ContextDoorsConfigRow).defaults).toEqual({ maxTurnFloorTokens: 9_000 });
    await writeContextDoorsDefaults({});
    expect((store.get(TABLE) as ContextDoorsConfigRow).defaults).toBeUndefined();
  });

  it('writeSessionDoorsOverride stamps setAt/provenance; null clears the entry', async () => {
    await writeSessionDoorsOverride('su-x', { overrides: { maxTurnFloorTokens: 11_000 }, setBy: 'su-x', provenance: 'role:superuser' });
    const row = store.get(TABLE) as ContextDoorsConfigRow;
    expect(row.sessions?.['su-x']?.overrides).toEqual({ maxTurnFloorTokens: 11_000 });
    expect(row.sessions?.['su-x']?.provenance).toBe('role:superuser');
    expect(typeof row.sessions?.['su-x']?.setAt).toBe('number');
    await writeSessionDoorsOverride('su-x', null);
    expect((store.get(TABLE) as ContextDoorsConfigRow).sessions).toBeUndefined();
  });

  it('prunes expired entries and bounds the session map on write (newest kept)', async () => {
    const now = Date.now();
    const sessions: NonNullable<ContextDoorsConfigRow['sessions']> = {
      expired: { overrides: {}, setBy: 'expired', setAt: now - SESSION_DOORS_OVERRIDE_MAX_AGE_MS - 1, provenance: 't' },
    };
    for (let i = 0; i < SESSION_DOORS_OVERRIDE_MAX_ENTRIES + 10; i++) {
      sessions[`su-${i}`] = { overrides: {}, setBy: `su-${i}`, setAt: now - i, provenance: 't' };
    }
    store.set(TABLE, { sessions } satisfies ContextDoorsConfigRow);
    await writeSessionDoorsOverride('su-new', { overrides: { maxTurnFloorTokens: 9_000 }, setBy: 'su-new', provenance: 't' });
    const row = store.get(TABLE) as ContextDoorsConfigRow;
    const keys = Object.keys(row.sessions ?? {});
    expect(keys).not.toContain('expired');
    expect(keys.length).toBeLessThanOrEqual(SESSION_DOORS_OVERRIDE_MAX_ENTRIES + 1); // pruned set + the new entry
    expect(row.sessions?.['su-new']).toBeDefined();
    // the OLDEST of the overflowing entries fell off
    expect(row.sessions?.[`su-${SESSION_DOORS_OVERRIDE_MAX_ENTRIES + 9}`]).toBeUndefined();
  });
});

describe('getDoorConstantsSync (sync consume + background refresh)', () => {
  it('serves BAKED before the first refresh lands, the configured value after', async () => {
    store.set(TABLE, { defaults: { maxTurnFloorTokens: 10_000 } } satisfies ContextDoorsConfigRow);
    // First call: snapshot empty → kicks the refresh, serves baked.
    expect(getDoorConstantsSync().maxTurnFloorTokens).toBe(BAKED_DOOR_CONSTANTS.maxTurnFloorTokens);
    await Promise.resolve(); // let the refresh promise settle
    await Promise.resolve();
    expect(getDoorConstantsSync().maxTurnFloorTokens).toBe(10_000);
  });

  it('a same-process write invalidates the snapshot (read-after-write consistency)', async () => {
    expect(getDoorConstantsSync().maxTurnFloorTokens).toBe(BAKED_DOOR_CONSTANTS.maxTurnFloorTokens);
    await writeContextDoorsDefaults({ maxTurnFloorTokens: 9_500 });
    getDoorConstantsSync(); // kicks a fresh refresh (snapshot was invalidated)
    await Promise.resolve();
    await Promise.resolve();
    expect(getDoorConstantsSync().maxTurnFloorTokens).toBe(9_500);
  });

  it('kill-switch pins BAKED regardless of stored config', async () => {
    store.set(TABLE, { defaults: { maxTurnFloorTokens: 10_000 } } satisfies ContextDoorsConfigRow);
    process.env.PAPERCUSP_DOORS_CONFIG_OFF = '1';
    expect(getDoorConstantsSync()).toEqual(BAKED_DOOR_CONSTANTS);
    expect(readOperatorState).not.toHaveBeenCalled();
  });
});

describe('override concern (config:list-overrides / reset)', () => {
  it('registers; diff reports workspace keys + a sessions summary; reset clears; restore round-trips', async () => {
    const c = getOverrideConcern('context-doors-config')!;
    expect(c).toBeDefined();
    expect(await c.diff()).toEqual([]);

    await writeContextDoorsDefaults({ maxTurnFloorTokens: 10_000 });
    await writeSessionDoorsOverride('su-x', { overrides: { compactionOverheadTokens: 5_000 }, setBy: 'su-x', provenance: 't' });
    const diff = await c.diff();
    expect(diff.find((e) => e.key === 'maxTurnFloorTokens')).toMatchObject({ effective: 10_000, default: 8_000 });
    const sessions = diff.find((e) => e.key === 'sessions');
    expect(sessions?.effective).toEqual([{ ownerId: 'su-x', setBy: 'su-x', setAt: expect.any(Number), keys: ['compactionOverheadTokens'] }]);

    const snap = await c.capture();
    await c.reset();
    expect(await c.diff()).toEqual([]);
    expect(await readContextDoorsConfig()).toEqual({});
    await c.restore(snap);
    expect((await c.diff()).find((e) => e.key === 'maxTurnFloorTokens')?.effective).toBe(10_000);
  });
});
