/**
 * WI-38354 — the reservation ledger is DERIVED from applied history.
 *
 * `lint:migrations` check 5 fails any on-disk `<NNN>-*.sql` with
 * NNN >= ENFORCED_FROM lacking a `harness_shared.migration_reservations` row.
 * It is a GATE lint, so one hand-numbered migration red-pins green-checkpoint
 * and every agent's release cut, hours later and in someone else's lane. That
 * class recurred six times and was closed six times by a one-off backfill
 * migration. `reconcileMigrationReservations()` closes it by making the ledger
 * a projection of `schema_migrations` rather than a parallel record kept in
 * sync by hand.
 *
 * FALSIFIABILITY (repo discipline: prove the guard CAN fail). The subject here
 * is an imported MODULE, which is tier 1 — so the deliberately-wrong
 * implementations live permanently in this file as CONTROLS, and the shared
 * property runs against all of them. Nothing in the working tree is ever
 * mutated: a mutation probe that edits a tracked file can be committed by the
 * git-sync sweep even when nothing goes wrong.
 *
 * The controls are paired with a CALIBRATION case that the REAL implementation
 * must pass — without it, a property broken in the same direction as the
 * controls would report every control as "caught" while testing nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ENFORCED_FROM } from '../../../scripts/lint-migrations.mjs';
import { RESERVATION_ENFORCED_FROM, migrationNumberOf, missingReservationRows } from './db-boot-migrate';
import {
  isUnpublishedMigrationDraft,
  migrationReservationGuardSql,
  readTrackedMigrationFilenames,
  reservationFilenameConflicts,
} from './migration-reservation';

describe('RESERVATION_ENFORCED_FROM', () => {
  it('equals the linter it mirrors — the two cannot drift apart silently', () => {
    // Imported from the linter itself, not re-typed: if someone moves
    // reservation enforcement to a different number, this fails here rather
    // than by reconciling the wrong set of migrations in production.
    expect(RESERVATION_ENFORCED_FROM).toBe(ENFORCED_FROM);
  });
});

describe('migrationNumberOf', () => {
  it('reads the numeric prefix', () => {
    expect(migrationNumberOf('815-expose-claim-spec-fields.sql')).toBe(815);
    expect(migrationNumberOf('007-early.sql')).toBe(7);
  });

  it('returns null for a name with no numeric prefix', () => {
    expect(migrationNumberOf('000-baseline.sql')).toBe(0);
    expect(migrationNumberOf('baseline.sql')).toBeNull();
    expect(migrationNumberOf('')).toBeNull();
  });
});

describe('migration reservation filename guard', () => {
  it('detects the applied-file/reserved-file collision and embeds a fail-closed db:migrate check', () => {
    expect(
      reservationFilenameConflicts(
        ['880-session-turn-parts-backfill.sql'],
        [{ num: 880, filename: '880-oauth-flow-private-context.sql' }],
      ),
    ).toEqual([
      {
        num: 880,
        file: '880-session-turn-parts-backfill.sql',
        reservedFilename: '880-oauth-flow-private-context.sql',
      },
    ]);
    const guard = migrationReservationGuardSql('882-oauth-flow-private-context.sql');
    expect(guard).toContain('WHERE num = 882');
    expect(guard).toContain("reserved_filename <> '882-oauth-flow-private-context.sql'");
  });

  it('ignores an applied historical filename that is no longer in the active tree', () => {
    expect(
      reservationFilenameConflicts(
        ['528-restore-fed-hlc-insert-stamp.sql', '528-restore-work-items-local-fed-hlc-stamp.sql'],
        [{ num: 528, filename: '528-restore-fed-hlc-insert-stamp.sql' }],
        494,
        new Set(['528-restore-fed-hlc-insert-stamp.sql']),
      ),
    ).toEqual([]);
  });

  it('still reports a mismatch for a conflicting filename that remains active', () => {
    expect(
      reservationFilenameConflicts(
        ['880-session-turn-parts-backfill.sql'],
        [{ num: 880, filename: '880-oauth-flow-private-context.sql' }],
        494,
        new Set(['880-session-turn-parts-backfill.sql']),
      ),
    ).toEqual([
      {
        num: 880,
        file: '880-session-turn-parts-backfill.sql',
        reservedFilename: '880-oauth-flow-private-context.sql',
      },
    ]);
  });
});

describe('missingReservationRows', () => {
  it('returns the applied migrations at/above the floor that have no reservation row', () => {
    const rows = missingReservationRows(
      ['814-harness-docs-retired-at.sql', '815-expose-claim-spec-fields.sql'],
      [814],
      494,
    );
    expect(rows).toEqual([{ num: 815, filename: '815-expose-claim-spec-fields.sql' }]);
  });

  it('leaves grandfathered legacy history below the floor alone', () => {
    // 135 predates reservation discipline. Backfilling it would be churn, and
    // the linter deliberately does not ask for it.
    const rows = missingReservationRows(['135-migration-reservations.sql'], [], 494);
    expect(rows).toEqual([]);
  });

  it('is a no-op when every applied migration is already reserved', () => {
    const rows = missingReservationRows(['815-a.sql', '816-b.sql'], [815, 816], 494);
    expect(rows).toEqual([]);
  });

  it('emits ONE row for a duplicated number (the EI-12709 collision shape)', () => {
    // 610-push-delivery.sql AND 610-session-ports.sql both landed once. Two
    // rows for one `num` would violate the PK and abort the whole INSERT —
    // which would take the reconcile down for every OTHER migration too.
    const rows = missingReservationRows(['610-push-delivery.sql', '610-session-ports.sql'], [], 494);
    expect(rows).toEqual([{ num: 610, filename: '610-push-delivery.sql' }]);
  });

  it('ignores rows whose filename carries no number', () => {
    expect(missingReservationRows(['not-a-migration.sql'], [], 494)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Falsifiability controls. Each is a plausible WRONG implementation of
// `missingReservationRows`. The property below must reject every one of them
// AND accept the real one.

type Impl = (
  applied: readonly string[],
  reserved: readonly number[],
  enforcedFrom: number,
) => { num: number; filename: string }[];

/** WRONG: ignores the floor, so it backfills grandfathered legacy history. */
const ignoresFloor: Impl = (applied, reserved) => {
  const have = new Set(reserved);
  const out = new Map<number, string>();
  for (const f of applied) {
    const n = migrationNumberOf(f);
    if (n === null || have.has(n) || out.has(n)) continue;
    out.set(n, f);
  }
  return [...out].map(([num, filename]) => ({ num, filename }));
};

/** WRONG: ignores existing reservations, so it tries to re-reserve every number. */
const ignoresExistingReservations: Impl = (applied, _reserved, enforcedFrom) => {
  const out = new Map<number, string>();
  for (const f of applied) {
    const n = migrationNumberOf(f);
    if (n === null || n < enforcedFrom || out.has(n)) continue;
    out.set(n, f);
  }
  return [...out].map(([num, filename]) => ({ num, filename }));
};

/** WRONG: does not dedupe, so a collided number yields two rows and the INSERT aborts. */
const doesNotDedupe: Impl = (applied, reserved, enforcedFrom) => {
  const have = new Set(reserved);
  const out: { num: number; filename: string }[] = [];
  for (const f of applied) {
    const n = migrationNumberOf(f);
    if (n === null || n < enforcedFrom || have.has(n)) continue;
    out.push({ num: n, filename: f });
  }
  return out;
};

/**
 * The property, stated once and run against the real implementation and every
 * control. Each clause corresponds to a way the reconcile has to be right:
 * respect the floor, respect existing rows, never emit a PK conflict.
 */
function assertReconcileProperty(impl: Impl): void {
  // floor respected
  expect(impl(['135-legacy.sql'], [], 494)).toEqual([]);
  // existing reservations respected
  expect(impl(['815-a.sql'], [815], 494)).toEqual([]);
  // a collided number yields at most one row
  const collided = impl(['610-a.sql', '610-b.sql'], [], 494);
  expect(collided.filter((r) => r.num === 610)).toHaveLength(1);
  // and the thing it actually exists to do still happens
  expect(impl(['815-a.sql'], [814], 494)).toEqual([{ num: 815, filename: '815-a.sql' }]);
}

describe('falsifiability', () => {
  it('CALIBRATION: the real implementation satisfies the property', () => {
    // Without this, a property that is itself broken would "catch" every
    // control below while proving nothing about the shipped code.
    expect(() => assertReconcileProperty(missingReservationRows)).not.toThrow();
  });

  it.each([
    ['ignores the enforcement floor', ignoresFloor],
    ['ignores existing reservation rows', ignoresExistingReservations],
    ['does not dedupe a collided number', doesNotDedupe],
  ])('rejects a control that %s', (_label, impl) => {
    expect(() => assertReconcileProperty(impl)).toThrow();
  });
});

/**
 * WI-6554700010042536 — an untracked, unreserved migration draft in the shared
 * tree must not withhold bg-host's background plane. The discriminator has to
 * be POSITIVE evidence of "untracked": anything git cannot vouch for (no repo,
 * no tracked migration, git failing) stays fail-closed.
 */
describe('unpublished migration draft discriminator', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' });
  };
  /** A repo whose sql dir tracks `tracked` and also holds untracked `untracked`. */
  function sqlRepo(tracked: string[], untracked: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'unpublished-draft-'));
    dirs.push(root);
    const sqlDir = join(root, 'libs', 'db', 'sql');
    mkdirSync(sqlDir, { recursive: true });
    git(root, 'init', '-q');
    for (const name of tracked) writeFileSync(join(sqlDir, name), 'SELECT 1;');
    if (tracked.length > 0) git(root, 'add', '--', ...tracked.map((name) => join('libs', 'db', 'sql', name)));
    for (const name of untracked) writeFileSync(join(sqlDir, name), 'SELECT 1;');
    return sqlDir;
  }

  it('reads exactly the tracked migration basenames of the sql dir', async () => {
    const sqlDir = sqlRepo(['1600-published.sql', '1601-also-published.sql'], ['1606-draft.sql']);
    mkdirSync(join(sqlDir, 'nested'));
    writeFileSync(join(sqlDir, 'nested', '1700-nested.sql'), 'SELECT 1;');
    git(sqlDir, 'add', '--', 'nested/1700-nested.sql');
    const tracked = await readTrackedMigrationFilenames(sqlDir);
    expect(tracked && [...tracked].sort()).toEqual(['1600-published.sql', '1601-also-published.sql']);
  });

  it('returns null (unknown) outside a git working tree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'unpublished-draft-plain-'));
    dirs.push(plain);
    writeFileSync(join(plain, '1606-draft.sql'), 'SELECT 1;');
    // tmpdir() must not itself sit inside a repo, or this case proves nothing.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain, stdio: 'ignore' })).toThrow();
    expect(await readTrackedMigrationFilenames(plain)).toBeNull();
  });

  it('returns null (unknown) for a repo directory that tracks no migration at all', async () => {
    const sqlDir = sqlRepo([], ['1606-draft.sql']);
    expect(await readTrackedMigrationFilenames(sqlDir)).toBeNull();
  });

  it('flags only a file git positively reports as untracked', async () => {
    const sqlDir = sqlRepo(['1600-published.sql'], ['1606-draft.sql']);
    const tracked = await readTrackedMigrationFilenames(sqlDir);
    expect(isUnpublishedMigrationDraft('1606-draft.sql', tracked)).toBe(true);
    expect(isUnpublishedMigrationDraft('1600-published.sql', tracked)).toBe(false);
  });

  it('fails closed when tracking is unknown', () => {
    expect(isUnpublishedMigrationDraft('1606-draft.sql', null)).toBe(false);
    expect(isUnpublishedMigrationDraft('1606-draft.sql', new Set())).toBe(false);
  });
});
