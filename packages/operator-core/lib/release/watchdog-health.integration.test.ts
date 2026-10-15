/**
 * `recordWatchdogPassOutcome` — the marker that makes a release watchdog's OWN failure visible
 * (EI-21297913810967409). Proven against a REAL migrated Postgres (testcontainer).
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A MOCK. The defect being fixed is a statement that
 * SILENTLY DOES NOTHING — a query rejected by Postgres every run, swallowed as "(non-fatal)".
 * The fix is itself a SQL write with two ways to fail exactly that way: an `UPDATE` whose WHERE
 * matches zero rows, and a `jsonb_set` on a two-level path whose parent key does not exist yet
 * (which returns the row UNCHANGED rather than erroring). A fake `sql` tag would happily accept
 * both and report success. Only a real database can tell the difference between "wrote it" and
 * "silently wrote nothing", so shipping this guarded by a mock would reproduce the very bug it
 * closes, one layer down.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/release/watchdog-health.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Metadata SQL remains real; observation delivery belongs to the isolated
// caller/condition coverage suite, not the operator DB outside this fixture.
vi.mock('../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  recordWatchdogPassOutcome,
  WATCHDOG_HEALTH_METADATA_KEY,
  type WatchdogPassHealth,
} from './watchdog-health';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-watchdog-health';
/** A SECOND workspace, to pin the documented breadth of an install-unscoped pass. */
const WS_OTHER = 'ws-watchdog-health-other';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id IN (${WS}, ${WS_OTHER})`;
});

async function seedRoutine(opts: {
  id: string;
  installSlug: string;
  name: 'green-checkpoint' | 'release-trigger';
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES (
      ${opts.id}, ${opts.installSlug}, ${opts.name}, 'cron', '{}'::jsonb,
      ${`system:${opts.name}`}, TRUE, ${opts.workspaceId ?? WS},
      ${JSON.stringify(opts.metadata ?? {})}::text::jsonb
    )`;
}

async function readMeta(id: string): Promise<Record<string, unknown> | null> {
  const r = await sql<{ metadata: Record<string, unknown> | null }[]>`
    SELECT metadata FROM harness_shared.routines WHERE id = ${id}`;
  return r[0]?.metadata ?? null;
}

async function readPass(id: string, pass: string): Promise<WatchdogPassHealth | undefined> {
  const meta = await readMeta(id);
  const block = meta?.[WATCHDOG_HEALTH_METADATA_KEY] as Record<string, WatchdogPassHealth> | undefined;
  return block?.[pass];
}

describe('recordWatchdogPassOutcome (real PG)', () => {
  it('retains a fixer-silence failure across healthy outer passes until the subpass recovers', async () => {
    await seedRoutine({ id: 'rt-fixer-silence', installSlug: 'papercusp', name: 'green-checkpoint' });
    const scope = { routineName: 'green-checkpoint' as const, installSlug: 'papercusp' };

    await recordWatchdogPassOutcome(sql, 'stranded-repair-fixer-silence', scope, new Error('activity read failed'));
    await recordWatchdogPassOutcome(sql, 'stranded-repair-queue', scope);
    expect(await readPass('rt-fixer-silence', 'stranded-repair-fixer-silence')).toMatchObject({
      lastError: 'activity read failed', consecutiveFailures: 1,
    });

    await recordWatchdogPassOutcome(sql, 'stranded-repair-fixer-silence', scope, new Error('activity read failed'));
    await recordWatchdogPassOutcome(sql, 'stranded-repair-queue', scope);
    expect((await readPass('rt-fixer-silence', 'stranded-repair-fixer-silence'))?.consecutiveFailures).toBe(2);

    await recordWatchdogPassOutcome(sql, 'stranded-repair-fixer-silence', scope);
    expect(await readPass('rt-fixer-silence', 'stranded-repair-fixer-silence')).toBeUndefined();
  });

  it('creates the marker on the FIRST failure, when the parent key does not exist yet', async () => {
    // The regression this pins: `jsonb_set(metadata, '{watchdog_health,green-stall}', …)` returns
    // the row UNCHANGED when `watchdog_health` is absent. That would silently drop the first
    // failure — the one that matters most, and the one a naive implementation loses.
    await seedRoutine({ id: 'rt-first', installSlug: 'papercusp', name: 'green-checkpoint' });

    const rows = await recordWatchdogPassOutcome(
      sql,
      'green-stall',
      { routineName: 'green-checkpoint' },
      new Error('column cp.revoked_at does not exist'),
    );

    expect(rows).toBe(1);
    const health = await readPass('rt-first', 'green-stall');
    expect(health?.lastError).toBe('column cp.revoked_at does not exist');
    expect(health?.consecutiveFailures).toBe(1);
    expect(Date.parse(health?.lastErrorAt ?? '')).not.toBeNaN();
  });

  it('increments consecutiveFailures across repeated failures', async () => {
    await seedRoutine({ id: 'rt-inc', installSlug: 'papercusp', name: 'green-checkpoint' });
    const scope = { routineName: 'green-checkpoint' } as const;

    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('boom 1'));
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('boom 2'));
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('boom 3'));

    const health = await readPass('rt-inc', 'green-stall');
    expect(health?.consecutiveFailures).toBe(3);
    expect(health?.lastError).toBe('boom 3'); // latest error, not the first
  });

  it('clears the marker on a clean pass, and removes the parent key once empty', async () => {
    await seedRoutine({ id: 'rt-clear', installSlug: 'papercusp', name: 'green-checkpoint' });
    const scope = { routineName: 'green-checkpoint' } as const;
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('transient'));
    expect(await readPass('rt-clear', 'green-stall')).toBeDefined();

    const cleared = await recordWatchdogPassOutcome(sql, 'green-stall', scope, undefined);

    expect(cleared).toBe(1);
    const meta = await readMeta('rt-clear');
    // Not merely the pass entry — the whole key, so a healthy net leaves NO residue in the
    // `routines:list` health projection rather than an empty object a reader must interpret.
    expect(meta?.[WATCHDOG_HEALTH_METADATA_KEY]).toBeUndefined();
  });

  it('writes NOTHING on a clean pass over a healthy row (the write-churn guard)', async () => {
    // Without the `jsonb_exists` guard in the WHERE, every healthy tick would bump `updated_at`
    // on every routine row it watches — turning a diagnostic into write churn on a table other
    // watchdogs read for freshness. 21 green-checkpoint rows × every 15 min, forever.
    await seedRoutine({ id: 'rt-quiet', installSlug: 'papercusp', name: 'green-checkpoint' });
    const before = await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM harness_shared.routines WHERE id = 'rt-quiet'`;

    const rows = await recordWatchdogPassOutcome(sql, 'green-stall', { routineName: 'green-checkpoint' }, undefined);

    expect(rows).toBe(0);
    const after = await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM harness_shared.routines WHERE id = 'rt-quiet'`;
    expect(after[0].u).toBe(before[0].u);
  });

  it('NEVER touches updated_at — it is the release-trigger freeze SIGNAL, not bookkeeping', async () => {
    // HISTORICAL RATIONALE, still worth pinning. `evaluateReleaseTriggerFreeze` USED TO compute
    // the age of a pause as `now - routines.updated_at`. Both release-trigger passes write to
    // THAT row, so `SET updated_at = now()` here would have reset the age of the very freeze they
    // exist to detect — every failing pass refreshing the clock, and the silent fleet-wide
    // deploy freeze (recurred 2026-06-18 and 2026-07-12, no auto-recovery either time) never
    // alarming at all. Migration 933 moved that signal to `active_changed_at` (trigger-stamped
    // only on a real flip), so this write can no longer reach the alarm — see
    // routines-active-changed-at.integration.test.ts. The omission is pinned anyway: `updated_at`
    // is a shared column with no single owner, and a diagnostic should not claim one.
    await seedRoutine({ id: 'rt-touch', installSlug: 'papercusp', name: 'release-trigger' });
    const before = await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM harness_shared.routines WHERE id = 'rt-touch'`;
    const scope = { routineName: 'release-trigger', installSlug: 'papercusp' } as const;

    await recordWatchdogPassOutcome(sql, 'release-trigger-freeze', scope, new Error('boom'));
    await recordWatchdogPassOutcome(sql, 'release-trigger-freeze', scope, undefined); // and the clear

    // The marker round-tripped, so the writes definitely ran...
    expect(await readPass('rt-touch', 'release-trigger-freeze')).toBeUndefined();
    // ...and neither of them moved the freeze clock.
    const after = await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM harness_shared.routines WHERE id = 'rt-touch'`;
    expect(after[0].u).toBe(before[0].u);
  });

  it('clearing one pass PRESERVES a sibling pass still failing', async () => {
    // The five passes are independent by design; one recovering must not blind the reader to
    // another that is still broken.
    await seedRoutine({ id: 'rt-sib', installSlug: 'papercusp', name: 'green-checkpoint' });
    const scope = { routineName: 'green-checkpoint' } as const;
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('still broken'));
    await recordWatchdogPassOutcome(sql, 'paused-green-checkpoint', scope, new Error('recovers'));

    await recordWatchdogPassOutcome(sql, 'paused-green-checkpoint', scope, undefined);

    expect(await readPass('rt-sib', 'paused-green-checkpoint')).toBeUndefined();
    expect((await readPass('rt-sib', 'green-stall'))?.lastError).toBe('still broken');
  });

  it('preserves unrelated metadata — gate_health is a different subject and must not be touched', async () => {
    await seedRoutine({
      id: 'rt-gh',
      installSlug: 'papercusp',
      name: 'green-checkpoint',
      metadata: { gate_health: { consecutiveReds: 35, observedCandidate: 'abc123' }, last_status: 'ok' },
    });

    await recordWatchdogPassOutcome(sql, 'green-stall', { routineName: 'green-checkpoint' }, new Error('x'));

    const meta = await readMeta('rt-gh');
    expect(meta?.gate_health).toMatchObject({ consecutiveReds: 35, observedCandidate: 'abc123' });
    expect(meta?.last_status).toBe('ok');
  });

  it('an install-UNSCOPED pass marks every row it scans, across installs AND workspaces', async () => {
    // `checkGreenStall` / the stranded-pause scan select green-checkpoint rows with no install
    // and no workspace filter, so when one throws, every one of those rows genuinely went
    // unwatched. The write scope is copied from the scan scope — this pins that breadth as
    // deliberate rather than accidental.
    await seedRoutine({ id: 'rt-a', installSlug: 'papercusp', name: 'green-checkpoint' });
    await seedRoutine({ id: 'rt-b', installSlug: 'hotel-reservations', name: 'green-checkpoint' });
    await seedRoutine({ id: 'rt-c', installSlug: 'oddsmith', name: 'green-checkpoint', workspaceId: WS_OTHER });
    await seedRoutine({ id: 'rt-rt', installSlug: 'papercusp', name: 'release-trigger' });

    await recordWatchdogPassOutcome(sql, 'green-stall', { routineName: 'green-checkpoint' }, new Error('wide'));

    expect(await readPass('rt-a', 'green-stall')).toBeDefined();
    expect(await readPass('rt-b', 'green-stall')).toBeDefined();
    expect(await readPass('rt-c', 'green-stall')).toBeDefined();
    // ...but never a routine of a different KIND: the release-trigger row is watched by its own
    // two passes and must not inherit the gate watchdog's failure.
    expect(await readPass('rt-rt', 'green-stall')).toBeUndefined();
  });

  it('an install-SCOPED pass marks only its own install', async () => {
    await seedRoutine({ id: 'rt-mine', installSlug: 'papercusp', name: 'release-trigger' });
    await seedRoutine({ id: 'rt-theirs', installSlug: 'hotel-reservations', name: 'release-trigger' });

    await recordWatchdogPassOutcome(
      sql,
      'release-trigger-freeze',
      { routineName: 'release-trigger', installSlug: 'papercusp' },
      new Error('scoped'),
    );

    expect(await readPass('rt-mine', 'release-trigger-freeze')).toBeDefined();
    expect(await readPass('rt-theirs', 'release-trigger-freeze')).toBeUndefined();
  });

  it('caps a pathological error message instead of storing it whole', async () => {
    await seedRoutine({ id: 'rt-big', installSlug: 'papercusp', name: 'green-checkpoint' });

    await recordWatchdogPassOutcome(sql, 'green-stall', { routineName: 'green-checkpoint' }, new Error('x'.repeat(5000)));

    const health = await readPass('rt-big', 'green-stall');
    expect(health?.lastError.length).toBeLessThan(500);
  });

  it('NEVER THROWS when the write itself fails — but still leaves a console witness', async () => {
    // A throw here would replace the pass's return value, so a broken diagnostic would break the
    // watchdog it is diagnosing. Simulate with a handle that rejects.
    const broken = (() => {
      throw new Error('connection terminated');
    }) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        recordWatchdogPassOutcome(broken, 'green-stall', { routineName: 'green-checkpoint' }, new Error('x')),
      ).resolves.toBe(0);

      // The honest gap this module documents: if the RECORDER is what is broken, the database
      // cannot witness it, so the console line is the only rung left. Asserted rather than
      // assumed — swallowing this one silently would reproduce the bug being fixed, one layer up.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('[watchdog-health]');
      expect(String(warn.mock.calls[0][0])).toContain('green-stall');
    } finally {
      warn.mockRestore();
    }
  });
});
