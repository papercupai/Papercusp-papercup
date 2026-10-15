/**
 * RECURRENCE GUARD: no `pg_stat_activity` reader may run on the RLS-subject
 * `harness_app` role.
 *
 * ── THE DEFECT CLASS (EI-19442084790376701 / EI-19446353497531835) ──────────
 * `pg_stat_activity` is ROLE-FILTERED. A role that is neither superuser nor a
 * member of `pg_read_all_stats` still sees other roles' backend ROWS, but with
 * `query` masked to the literal '<insufficient privilege>' and
 * `application_name` NULLED. Postgres does NOT error — so a predicate like
 *
 *     WHERE application_name LIKE 'dbos_transact_%'      -- single-primary guard
 *     WHERE query ILIKE '%coord_event_log%'              -- coord furnace forensics
 *
 * simply matches nothing and `count()` returns a flawless `0`. That zero is
 * deterministic, permanent for the process's life, and INDISTINGUISHABLE from a
 * true zero. It is the purest form of the defect class that has cost this fleet
 * the most: **a rigorous check that is structurally incapable of expressing the
 * failure it is aimed at.** The check passing tells you nothing, and its rigour
 * is exactly what makes the wrong answer convincing.
 *
 * Real cost, measured 2026-08-03: the request-path single-primary guard (R4-2)
 * paged `Live DBOS background primaries: 0 (expected exactly 1)` every 30min for
 * ~10 hours while exactly ONE primary was demonstrably live the whole time.
 * Migration 733 records the sibling incident: 108 of 403 backends (~27%) carried
 * query='<insufficient privilege>', which silently broke a BINDING
 * caller-attribution method — 60 samples returned 0 hits for a statement
 * pg_stat_statements proved was firing ~2.9/s.
 *
 * ── WHY A GUARD RATHER THAN N FIXES ────────────────────────────────────────
 * Swept 2026-08-03: every functional reader in the tree connects via
 * `getOrgPg()` (the `harness_admin` role), and migration 733 grants
 * `pg_read_all_stats` TO harness_admin. So the vulnerable population today is
 * EMPTY — there is nothing to fix. What there is, is an INVISIBLE COUPLING:
 * "pg_stat_activity readers must be admin-connected" is load-bearing, relied on
 * by every reader, and written down nowhere. A future reader wired to
 * `getOrgPgApp()` re-creates the 10-hour false page, and NOTHING FAILS — no
 * error, no red test, just a confident zero. This guard makes that coupling
 * explicit and mechanical.
 *
 * ── WHY IT STRIPS COMMENTS ─────────────────────────────────────────────────
 * `single-primary-check.ts` DISCUSSES `getOrgPgApp()` in a doc comment (it
 * documents switching to it as the way to REPRODUCE the bug). A naive
 * "file mentions getOrgPgApp(" check therefore fires on the one file that is
 * most careful about this — a false positive on prose. That would give the
 * guard the mirror image of the very defect it polices, so usage is detected in
 * CODE only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line prettier/prettier
import { listFilesIncludingUntracked } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A real read of the view — not a comment mentioning it, not an application_name tag. */
const READS_VIEW = /from\s+pg_stat_activity/i;

/** The RLS-subject app-role client. `harness_app` holds no pg_read_all_stats. */
const APP_ROLE_CLIENT = /getOrgPgApp\s*\(/;

/**
 * Strip line- and block-comments so a doc comment DISCUSSING the app-role client
 * is never mistaken for a call to it. Deliberately conservative: it only has to
 * be good enough to tell prose from a call site.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

function isScannableSource(p: string): boolean {
  if (!p.endsWith('.ts') && !p.endsWith('.mts')) return false;
  if (p.endsWith('.d.ts') || p.endsWith('.d.mts')) return false;
  if (p.includes('_retired/')) return false;
  if (p.includes('dist-host/') || p.includes('/dist/')) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return false;
  return true;
}

describe('pg_stat_activity readers must not run on the harness_app role', () => {
  // UNTRACKED-INCLUSIVE on purpose. A brand-new file is invisible to a plain
  // `git ls-files` until it is added, and on this fleet git-sync commits the tree
  // only every few minutes — so a freshly-written reader would sit UNGUARDED for
  // exactly the window in which it is being written and is most likely to be
  // wrong. That is the same reason the identity guards pass
  // `--others --exclude-standard` (see the helper's own docstring). This variant
  // buys untracked coverage AND submodule coverage instead of trading one for
  // the other.
  const scan = listFilesIncludingUntracked() as { files: string[]; unscannedPresent: string[] };

  const readers: string[] = [];
  for (const rel of scan.files.filter(isScannableSource)) {
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // raced deletion / unreadable — never fail the suite on tree churn
    }
    if (READS_VIEW.test(stripComments(src))) readers.push(rel);
  }

  // ── ANTI-VACUITY ─────────────────────────────────────────────────────────
  // Every failure mode of a source-scanning guard is SILENT: the pattern stops
  // matching, the loop finds nothing, and the guard prints a confident ✓ over
  // zero files. That is the same false-zero shape this guard exists to police,
  // so the floor is asserted rather than left to inspection.
  it('actually finds the known reader population (guard is not vacuous)', () => {
    expect(
      readers,
      `Expected to find pg_stat_activity readers and found ${readers.length}. ` +
        'Either the enumerator or the READS_VIEW pattern silently stopped matching — ' +
        'do NOT relax this assertion; fix the detection.',
    ).not.toHaveLength(0);

    // The canonical reader. If this file stops being detected, detection is broken.
    expect(readers).toContain('packages/operator-core/lib/system-health/single-primary-check.ts');
  });

  it('scans every checked-out submodule (no silent blind spot)', () => {
    // listTrackedFiles reports subtrees it could not enumerate. A guard that
    // skips a present-but-unscanned submodule reports ✓ over code it never read.
    expect(scan.unscannedPresent ?? []).toEqual([]);
  });

  // ── THE INVARIANT ────────────────────────────────────────────────────────
  it('no reader uses the RLS-subject app-role client (harness_app lacks pg_read_all_stats)', () => {
    const offenders = readers.filter((rel) => {
      const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      return APP_ROLE_CLIENT.test(src);
    });

    expect(
      offenders,
      'A file that reads pg_stat_activity is wired to getOrgPgApp() (the harness_app role).\n' +
        'harness_app is NOT a member of pg_read_all_stats, so Postgres masks other roles’ ' +
        'backends instead of erroring: `query` becomes ‘<insufficient privilege>’ and ' +
        '`application_name` becomes NULL. Any predicate over those columns then matches nothing ' +
        'and returns a well-formed, permanent, WRONG zero.\n' +
        'Fix by reading through getOrgPg() (harness_admin, granted pg_read_all_stats by ' +
        'migration 733). If this read genuinely must use the app role, it MUST first establish ' +
        'the capability directly — see countBackgroundPrimaries() in ' +
        'system-health/single-primary-check.ts, which returns null (“I could not look”) ' +
        'rather than 0 when pg_has_role(current_user, ‘pg_read_all_stats’, ‘member’) is false.\n' +
        `Offending file(s): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

describe('pg_read_all_stats boot assertion wiring (EI-19447868110362941)', () => {
  const host = stripComments(readFileSync(join(REPO_ROOT, 'apps/operator/bin/hono-host.ts'), 'utf8'));

  it('runs exactly once from primary boot after the migration gate, not from each request worker', () => {
    const primaryAt = host.indexOf('onPrimary:');
    const workerAt = host.indexOf('onWorker:', primaryAt);
    const primary = primaryAt >= 0 && workerAt > primaryAt ? host.slice(primaryAt, workerAt) : '';
    const workerEnd = host.indexOf('onUnbootable:', workerAt);
    const worker = workerAt >= 0 && workerEnd > workerAt ? host.slice(workerAt, workerEnd) : '';
    const calls = host.match(/assertPgReadAllStatsCapabilityAtBoot\s*\(/g) ?? [];

    expect(calls, 'the host must retain one boot assertion call').toHaveLength(1);
    expect(primary, 'the one call belongs to the host primary').toContain('assertPgReadAllStatsCapabilityAtBoot()');
    expect(primary.indexOf('waitForBootMigrationGate')).toBeGreaterThanOrEqual(0);
    expect(primary.indexOf('waitForBootMigrationGate')).toBeLessThan(
      primary.indexOf('assertPgReadAllStatsCapabilityAtBoot()'),
    );
    expect(worker, 'request workers must not repeat the capability probe').not.toContain(
      'assertPgReadAllStatsCapabilityAtBoot()',
    );
  });
});
