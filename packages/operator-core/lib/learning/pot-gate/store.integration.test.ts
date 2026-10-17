/**
 * store.integration.test.ts — learning-pot-scope SQL over migration 1039
 * (plan learning-pot-scope-gate-2026-08-30, P-001 / D-001).
 *
 * Provisions a throwaway DB with the full live schema (provisionGymDatabase
 * applies 000-baseline + every pending migration, so 1039's
 * harness_shared.learning_pot_scope exists), then round-trips the gate:
 * the empty-table default, the batched write in both directions, the audit
 * stamp, the exact-inverse clear, and the two batch read shapes.
 *
 * The load-bearing case is `does not touch any lane's own config`: the whole
 * reason D-001 chose a stored gate over a remembered bulk write is that a pot
 * switched off and back on restores EXACTLY the lanes that were armed before.
 * That property is only true while this store leaves gym_autoloop_config and
 * learning_governor_loops alone, so it is asserted against real rows rather
 * than trusted to code review.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { dropDatabaseWithLock, getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../../gym/gym-db-init';
import {
  clearPotLearningScope,
  disabledPotSlugs,
  getPotLearningScope,
  listPotLearningScope,
  normalizePauseProvenance,
  potLearningEnabled,
  potScopeResolver,
  setPotLearningScope,
} from './store';
import { isDeliberatePause } from './core';
import { observeFallback } from '../../degradation/fallback-observations';

// These tests exercise transactional gate reads, not the separate durable recorder.
vi.mock('../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

let sql: postgres.Sql;
let containerUri: string;
const dbName = `lpotscope_${randomBytes(5).toString('hex')}`;
const WS = 'ws-pot-scope-test';
const OTHER_WS = 'ws-pot-scope-other';

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    // R-009 is an acceptance detector, so its teardown must also be bounded.
    // A raw DROP can wait behind another integration process's I/O-heavy DROP
    // until Vitest kills this hook. The shared helper uses a cluster-wide
    // try-lock, caps the statement, and safely defers instead of queueing.
    await dropDatabaseWithLock(maint, dbName);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  // Best-effort: the reused test container is shared across vitest processes
  // on the dev box — a concurrent suite's teardown can stop it first (404).
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

describe('learning-pot-scope store', () => {
  it('missing-relation fallbacks leave an enclosing transaction usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations = vi.mocked(observeFallback);
    observations.mockClear();
    try {
      await sql.begin(async tx => {
        await tx`ALTER TABLE harness_shared.learning_pot_scope RENAME TO learning_pot_scope_unavailable`;
        try {
          const client = tx as unknown as postgres.Sql;
          expect(await potLearningEnabled(client, { workspaceId: WS, potSlug: 'any' })).toBe(true);
          expect(await listPotLearningScope(client, { workspaceId: WS })).toEqual([]);
          expect(await disabledPotSlugs(client, { workspaceId: WS })).toEqual([]);
          expect(await tx`SELECT 1 AS alive`).toMatchObject([{ alive: 1 }]);
          expect(observations).toHaveBeenCalled();
          expect(observations.mock.calls.every(([, , options]) => options?.sql === client && options.workspaceId === WS)).toBe(true);
        } finally {
          await tx`ALTER TABLE harness_shared.learning_pot_scope_unavailable RENAME TO learning_pot_scope`;
        }
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is answering fail-OPEN'));
    } finally {
      warn.mockRestore();
    }
  });

  it('propagates other read errors while leaving the enclosing transaction usable', async () => {
    await sql.begin(async tx => {
      await tx`ALTER TABLE harness_shared.learning_pot_scope RENAME COLUMN pot_slug TO unavailable_slug`;
      try {
        await expect(getPotLearningScope(tx as unknown as postgres.Sql, { workspaceId: WS, potSlug: 'any' }))
          .rejects.toMatchObject({ code: '42703' });
        expect(await tx`SELECT 1 AS alive`).toMatchObject([{ alive: 1 }]);
      } finally {
        await tx`ALTER TABLE harness_shared.learning_pot_scope RENAME COLUMN unavailable_slug TO pot_slug`;
      }
    });
  });

  it('an empty table means every pot is enabled', async () => {
    // R-5, against the real relation: this is the state migration 1039 ships in,
    // so a regression here stops the whole fleet's learning the moment it applies.
    expect(await getPotLearningScope(sql, { workspaceId: WS, potSlug: 'never-flipped' })).toBeNull();
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: 'never-flipped' })).toBe(true);
    expect(await disabledPotSlugs(sql, { workspaceId: WS })).toEqual([]);
  });

  it('switches many pots off in ONE write, and reads back as gated', async () => {
    const written = await setPotLearningScope(sql, {
      workspaceId: WS,
      potSlugs: ['alpha', 'beta', 'gamma'],
      enabled: false,
      setBy: 'su-test',
    });
    expect(written.map((r) => r.potSlug).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(written.every((r) => r.enabled === false)).toBe(true);

    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: 'alpha' })).toBe(false);
    expect(await disabledPotSlugs(sql, { workspaceId: WS })).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('stamps the audit trail on every row it writes', async () => {
    const before = Date.now();
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: ['delta'], enabled: false, setBy: 'su-auditor' });
    const row = await getPotLearningScope(sql, { workspaceId: WS, potSlug: 'delta' });
    expect(row?.setBy).toBe('su-auditor');
    // Allow generous clock slack — the assertion is that set_at is stamped at
    // write time, not that the test and PG agree to the millisecond.
    expect(row!.setAt).toBeGreaterThan(before - 60_000);
  });

  it('re-enabling writes a row rather than deleting one, and reads identically to absent', async () => {
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: ['beta'], enabled: true, setBy: 'su-restorer' });
    const row = await getPotLearningScope(sql, { workspaceId: WS, potSlug: 'beta' });
    expect(row).not.toBeNull(); // the audit stamp survives the re-enable
    expect(row?.setBy).toBe('su-restorer');
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: 'beta' })).toBe(true);
    expect(await disabledPotSlugs(sql, { workspaceId: WS })).not.toContain('beta');
  });

  it('is idempotent — the same flip twice leaves one row', async () => {
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: ['alpha', 'alpha'], enabled: false, setBy: 'su-test' });
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: ['alpha'], enabled: false, setBy: 'su-test' });
    const rows = (await sql`
      SELECT count(*)::int AS n FROM harness_shared.learning_pot_scope
       WHERE workspace_id = ${WS} AND pot_slug = 'alpha'`) as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
  });

  it('ignores an empty selection instead of writing every pot', async () => {
    // A bulk footer with nothing selected must be a no-op, never a fleet-wide flip.
    expect(await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [], enabled: false, setBy: 'su-test' })).toEqual([]);
    expect(await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [''], enabled: false, setBy: 'su-test' })).toEqual([]);
  });

  it('scopes to its workspace — another tenant\'s flip is invisible', async () => {
    await setPotLearningScope(sql, { workspaceId: OTHER_WS, potSlugs: ['alpha'], enabled: false, setBy: 'su-other' });
    // 'alpha' is disabled in BOTH workspaces now; prove the reads are keyed by
    // workspace by flipping it back on in one and re-reading the other.
    await setPotLearningScope(sql, { workspaceId: OTHER_WS, potSlugs: ['alpha'], enabled: true, setBy: 'su-other' });
    expect(await potLearningEnabled(sql, { workspaceId: OTHER_WS, potSlug: 'alpha' })).toBe(true);
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: 'alpha' })).toBe(false);
  });

  it('resolves a whole batch from one query, with unknown slugs enabled', async () => {
    const resolve = await potScopeResolver(sql, { workspaceId: WS });
    expect(resolve('alpha')).toBe(false);
    expect(resolve('beta')).toBe(true);
    expect(resolve('a-pot-with-no-row-at-all')).toBe(true);
  });

  it('clear removes rows entirely — the exact inverse of a write', async () => {
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: ['epsilon'], enabled: false, setBy: 'su-test' });
    const { deleted } = await clearPotLearningScope(sql, { workspaceId: WS, potSlugs: ['epsilon'] });
    expect(deleted).toBe(1);
    expect(await getPotLearningScope(sql, { workspaceId: WS, potSlug: 'epsilon' })).toBeNull();
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: 'epsilon' })).toBe(true);
    // Clearing a pot that has no row is a no-op, not an error.
    expect((await clearPotLearningScope(sql, { workspaceId: WS, potSlugs: ['epsilon'] })).deleted).toBe(0);
  });

  it('lists every stored row for the picker', async () => {
    const rows = await listPotLearningScope(sql, { workspaceId: WS });
    expect(rows.map((r) => r.potSlug).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('NEVER touches a lane\'s own config — the property that makes the restore lossless', async () => {
    // D-001. Arm two lanes for a pot the way their own tools would, flip the pot
    // off and back on through the gate, and assert both lane rows are byte-identical.
    // If this ever fails, switching a pot back on has started reviving or parking
    // lanes on its own and the gate has become the remembered-bulk-write design
    // the owner rejected.
    const POT = 'lane-owner';
    await sql`
      INSERT INTO harness_shared.gym_autoloop_config
        (workspace_id, harness_slug, enabled, budget_usd, spent_usd, status, updated_at)
      VALUES (${WS}, ${POT}, true, 12.5, 3.25, 'running', ${Date.now()})`;
    await sql`
      INSERT INTO harness_shared.learning_governor_loops
        (workspace_id, loop_id, pot_slug, display_name, budget_kind, budget_usd, enabled, enforcement)
      VALUES (${WS}, ${'gym:' + POT}, ${POT}, 'gym lane', 'usd', 40, true, 'native')`;

    // Spread rather than cast. postgres.js hands back a `RowList`, which is not a plain
    // array: it carries query metadata (count, command, columns, statement) alongside the
    // rows, and it is readonly — so `as unknown[]` is both a type error and the wrong shape
    // to compare. `toEqual` on the RowList itself would fold that metadata into the
    // assertion, which is not what this test means by "byte-identical"; the comment above
    // says the subject is the lane ROWS. Spreading takes an actual copy of exactly those,
    // which is also what makes `before` a real snapshot instead of a live handle.
    const laneSnapshot = async () => ({
      gym: [
        ...(await sql`
        SELECT * FROM harness_shared.gym_autoloop_config
         WHERE workspace_id = ${WS} AND harness_slug = ${POT}`),
      ],
      governor: [
        ...(await sql`
        SELECT * FROM harness_shared.learning_governor_loops
         WHERE workspace_id = ${WS} AND loop_id = ${'gym:' + POT}`),
      ],
    });

    const before = await laneSnapshot();
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: false, setBy: 'su-test' });
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: POT })).toBe(false);
    expect(await laneSnapshot()).toEqual(before); // still armed, just gated

    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: true, setBy: 'su-test' });
    expect(await potLearningEnabled(sql, { workspaceId: WS, potSlug: POT })).toBe(true);
    expect(await laneSnapshot()).toEqual(before); // restored to EXACTLY what was armed
  });
});

// WI-10002099 — migration 1271: structured deliberate-pause provenance. Replaces
// the hand-typed ' (owner directive)' suffix on set_by, which had already drifted
// (absent on the one row that mattered) and misled a peer into filing a major bug
// against a deliberate pause.
describe('learning-pot-scope pause provenance (migration 1271)', () => {
  const PWS = 'ws-pot-scope-pause';

  it('round-trips reason / ownerDirected / reviewBy and reads them back as a deliberate pause', async () => {
    const reviewBy = new Date('2026-12-01T00:00:00.000Z');
    const [written] = await setPotLearningScope(sql, {
      workspaceId: PWS,
      potSlugs: ['paused-on-purpose'],
      enabled: false,
      setBy: 'su-test',
      pauseReason: 'owner directive 2026-09-15: re-arm only on the owner\'s word (WI-10001478)',
      ownerDirected: true,
      reviewBy,
    });
    expect(written.setBy).toBe('su-test'); // bare identity — no provenance suffix
    expect(written.ownerDirected).toBe(true);
    expect(written.pauseReason).toContain('WI-10001478');
    expect(written.reviewBy).toBe(reviewBy.getTime());
    expect(isDeliberatePause(written)).toBe(true);

    const read = await getPotLearningScope(sql, { workspaceId: PWS, potSlug: 'paused-on-purpose' });
    expect(read).toEqual(written);
  });

  it('a bare switch-off is an UNEXPLAINED pause, not a deliberate one', async () => {
    const [written] = await setPotLearningScope(sql, {
      workspaceId: PWS,
      potSlugs: ['bare-off'],
      enabled: false,
      setBy: 'su-test',
    });
    expect(written.pauseReason).toBeNull();
    expect(written.ownerDirected).toBe(false);
    expect(written.reviewBy).toBeNull();
    expect(isDeliberatePause(written)).toBe(false);
  });

  it('re-enabling CLEARS the pause record so a learning pot never keeps a stale owner-directive stamp', async () => {
    await setPotLearningScope(sql, {
      workspaceId: PWS,
      potSlugs: ['flip-back'],
      enabled: false,
      setBy: 'su-test',
      pauseReason: 'owner directive #1',
      ownerDirected: true,
      reviewBy: new Date('2026-12-01T00:00:00.000Z'),
    });
    const [back] = await setPotLearningScope(sql, {
      workspaceId: PWS,
      potSlugs: ['flip-back'],
      enabled: true,
      setBy: 'su-test',
      pauseReason: 'ignored while enabling',
      ownerDirected: true,
    });
    expect(back.enabled).toBe(true);
    expect(back.pauseReason).toBeNull();
    expect(back.ownerDirected).toBe(false);
    expect(back.reviewBy).toBeNull();
  });

  it('refuses ownerDirected without a citation — in the store AND (belt and braces) in the DB', () => {
    expect(() => normalizePauseProvenance({ enabled: false, ownerDirected: true })).toThrow(/pauseReason/);
    expect(() => normalizePauseProvenance({ enabled: false, ownerDirected: true, pauseReason: '  ' })).toThrow(/pauseReason/);
    return expect(
      sql`INSERT INTO harness_shared.learning_pot_scope (workspace_id, pot_slug, enabled, owner_directed)
          VALUES (${PWS}, 'db-guard', false, true)`,
    ).rejects.toThrow(/owner_directed_needs_reason/);
  });

  it('the DB refuses a pause record on an ENABLED row', async () => {
    await expect(
      sql`INSERT INTO harness_shared.learning_pot_scope (workspace_id, pot_slug, enabled, pause_reason)
          VALUES (${PWS}, 'db-guard-2', true, 'stale')`,
    ).rejects.toThrow(/pause_record_only_while_paused/);
  });

  it('migration backfill: a legacy " (owner directive)" set_by suffix becomes owner_directed + a bare identity', async () => {
    // provisionGymDatabase applies every migration to an EMPTY table, so the
    // backfill has nothing to convert at provision time. Seed the legacy shape
    // (the new columns default to the pre-1271 state), then re-run the migration
    // file itself — it is idempotent by construction (IF NOT EXISTS / guarded DO).
    await sql`INSERT INTO harness_shared.learning_pot_scope (workspace_id, pot_slug, enabled, set_by)
              VALUES (${PWS}, 'legacy-directive', false, 'su-8c2ebfa6 (owner directive)'),
                     (${PWS}, 'legacy-plain', false, 'su-12459024'),
                     (${PWS}, 'legacy-enabled', true, 'su-8c2ebfa6 (owner directive)')`;
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../../../libs/papercusp/libs/db/sql/1271-learning-pot-scope-pause-provenance.sql', import.meta.url),
      ),
      'utf8',
    );
    await sql.unsafe(migration);

    const byPot = async (pot: string) =>
      (await getPotLearningScope(sql, { workspaceId: PWS, potSlug: pot }))!;

    const directive = await byPot('legacy-directive');
    expect(directive.setBy).toBe('su-8c2ebfa6');
    expect(directive.ownerDirected).toBe(true);
    expect(directive.pauseReason).toMatch(/legacy record/);
    expect(isDeliberatePause(directive)).toBe(true);

    // A disabled row with no suffix is NOT promoted to deliberate — the backfill
    // converts what was recorded, it does not invent provenance.
    const plain = await byPot('legacy-plain');
    expect(plain.setBy).toBe('su-12459024');
    expect(plain.ownerDirected).toBe(false);
    expect(isDeliberatePause(plain)).toBe(false);

    // The backfill is scoped to paused rows: an enabled row is left alone.
    const enabledRow = await byPot('legacy-enabled');
    expect(enabledRow.ownerDirected).toBe(false);
    expect(enabledRow.setBy).toBe('su-8c2ebfa6 (owner directive)');
  });
});
