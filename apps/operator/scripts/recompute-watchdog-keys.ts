/**
 * recompute-watchdog-keys.ts — the deliberate POST-DEPLOY backfill that migrates
 * open improvement-EI watchdogKeys to the current key shape
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012).
 *
 * WHEN to run: ONCE, AFTER the new watchdog collector has DEPLOYED (the staging→
 * green→release pipeline carries it to :3070). Running it BEFORE the new collector
 * is live would migrate keys the live (old) collector doesn't yet emit, re-orphaning
 * them — hence "post-deploy". It is idempotent + dry-run-by-default, so a premature
 * or repeated run is safe (a no-op once everything is migrated).
 *
 * WHAT it does: for every OPEN `repeated-tool-error:*` EI still keyed in a legacy
 * shape (a message-fingerprint segment, or no code/field for structural/caller),
 * it recomputes the current STRUCTURAL key (bug-inflow-one-problem-one-row-2026-10-18
 * D-004) from the EI's stored body sample plus the failure's error_code from the
 * invocation ledger — so the open EI keeps matching what the live collector now
 * emits, instead of being orphaned + re-filed (re-file churn). Several legacy rows
 * that fold onto one structural key report as collisions (left as-is for the fold). The reusable engine is
 * operator-core/lib/harness/improvements/watchdog-key-migration.ts; this script is
 * just the live-PG wiring + CLI. Any FUTURE key-shape change = a new deriver + a
 * one-line swap here.
 *
 * Usage:
 *   tsx apps/operator/scripts/recompute-watchdog-keys.ts            # DRY RUN (default) — reports, writes nothing
 *   tsx apps/operator/scripts/recompute-watchdog-keys.ts --execute  # apply the migration
 *
 * Fail-soft: an unreachable DB is logged and exits 0.
 */

import postgres from 'postgres';
import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import {
  recomputeWatchdogKeys,
  deriveToolErrorWatchdogKey,
  extractSampleFromBody,
  parseRepeatedToolErrorKey,
  REPEATED_TOOL_ERROR_PREFIX,
  type RecomputeDeps,
} from '@papercusp/operator-core/lib/harness/improvements/watchdog-key-migration';
import type { ImprovementCandidate } from '@papercusp/operator-core/lib/harness/improvements/policy';
import {
  backfillDuplicateOfFromLinks,
  foldWatchdogKeyCollisions,
} from '@papercusp/operator-core/lib/harness/improvements/watchdog-key-fold';

const url =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const sql = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} });
  // EI-18698602043482898: this script builds its OWN raw postgres() client
  // (not getOrgPg()), so it needs the hybrid jsonb serializer applied
  // explicitly — without it, `setWatchdogKey`'s `${JSON.stringify(x)}::jsonb`
  // bind below double-encodes into a jsonb scalar string instead of an
  // object (verified live against the same call shape via operator-cli.ts's
  // savePrefs). See connection.ts's `restoreRawJsonbSerializer` doc.
  restoreRawJsonbSerializer(sql);

  // EI-<n> ids are GLOBALLY allocated, so we read + update rows by issue_id across
  // every workspace — each row is migrated IN PLACE (its workspace_id is unchanged),
  // so the per-workspace watchdog dedup reads the migrated key in its own scope.
  const deps: RecomputeDeps = {
    listOpenKeyed: async (): Promise<ImprovementCandidate[]> => {
      const rows = await sql<{ issue_id: string; body: string | null; wk: string }[]>`
        SELECT issue_id, body, payload->>'watchdogKey' AS wk
          FROM harness_shared.engineer_issues
         WHERE state = 'open'
           AND payload ? 'watchdogKey'
           AND payload->>'watchdogKey' LIKE ${REPEATED_TOOL_ERROR_PREFIX + '%'}
         -- The CANONICAL-ROW rule (recomputeWatchdogKeys: the first candidate holds a key):
         -- a work-lane row before an observation row, a claimed row before an unclaimed
         -- one, then the oldest, then the id. The fold drops later holders onto it.
         ORDER BY (coalesce(lane, payload->>'lane', '') = 'observation') ASC,
                  (assignee IS NULL) ASC,
                  created_at ASC,
                  issue_id ASC`;
      return rows.map((r) => ({
        id: r.issue_id,
        kind: 'bug',
        scope: 'operator',
        title: '',
        state: 'open',
        body: r.body ?? undefined,
        watchdogKey: r.wk,
      }));
    },
    setWatchdogKey: async (id, newKey) => {
      await sql`
        UPDATE harness_shared.engineer_issues
           SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify({ watchdogKey: newKey })}::jsonb,
               origin = 'local'
         WHERE issue_id = ${id}`;
    },
  };

  // bug-inflow-one-problem-one-row-2026-10-18 D-004: a structural/caller key names
  // the failure's error CODE, which the EI body does not carry. Look it up in the
  // invocation ledger by tool + the stored sample (the collector's sample is the
  // first 800 chars of the message), newest failure first. Absent → the deriver
  // falls back to a code carried in the message itself.
  const codeById = new Map<string, string | null>();
  const errorCodeOf = (candidate: ImprovementCandidate): string | null =>
    codeById.get(String(candidate.id)) ?? null;
  const listOpenKeyed = deps.listOpenKeyed;
  deps.listOpenKeyed = async () => {
    const candidates = await listOpenKeyed();
    for (const c of candidates) {
      const parsed = parseRepeatedToolErrorKey(String(c.watchdogKey ?? ''));
      const sample = extractSampleFromBody(c.body);
      if (!parsed || parsed.errorCode !== null || !sample) continue;
      if (parsed.klass !== 'structural' && parsed.klass !== 'caller') continue;
      const rows = await sql<{ error_code: string | null }[]>`
        SELECT error_code
          FROM harness_shared.tool_invocations
         WHERE tool_name = ${parsed.tool}
           AND status <> 'ok'
           AND invoked_at > now() - interval '30 days'
           AND left(error_message, 800) = ${sample}
         ORDER BY invoked_at DESC
         LIMIT 1`;
      codeById.set(String(c.id), rows[0]?.error_code ?? null);
    }
    return candidates;
  };

  try {
    const res = await recomputeWatchdogKeys(
      (candidate) => deriveToolErrorWatchdogKey(candidate, errorCodeOf),
      deps,
      { dryRun: !execute },
    );
    const mode = res.dryRun ? 'DRY RUN (no writes — pass --execute to apply)' : 'EXECUTED';
    process.stdout.write(
      `\nwatchdog-key recompute — ${mode}\n` +
        `  scanned (open repeated-tool-error EIs): ${res.scanned}\n` +
        `  ${res.dryRun ? 'would migrate' : 'migrated'}: ${res.changed.length}\n` +
        `  collisions skipped: ${res.collisions.length}\n` +
        `  unchanged: ${res.unchanged}\n`,
    );
    for (const c of res.changed.slice(0, 50)) {
      process.stdout.write(`    ${c.id}: ${c.oldKey}\n        → ${c.newKey}\n`);
    }
    if (res.changed.length > 50) process.stdout.write(`    … +${res.changed.length - 50} more\n`);
    for (const c of res.collisions) {
      process.stdout.write(`    COLLISION ${c.id} → ${c.newKey} (already held by ${c.heldBy})\n`);
    }

    // bug-inflow-one-problem-one-row-2026-10-18 P-008: fold each collision onto the row
    // holding the key (duplicate_of + dropped), then backfill duplicate_of from the
    // `duplicates` edges written before migration 1534. Same dry-run switch.
    const fold = await foldWatchdogKeyCollisions(res.collisions, { sql }, { dryRun: !execute });
    process.stdout.write(
      `\nwatchdog-key fold — ${mode}\n` +
        `  shared keys: ${fold.groups.length}\n` +
        `  ${fold.dryRun ? 'would fold' : 'folded'}: ${fold.folded}\n` +
        `  skipped (not open, claimed, already a duplicate, or another workspace): ${fold.skipped.length}\n`,
    );
    for (const g of fold.groups) {
      process.stdout.write(`    FOLD ${g.folded.length} → ${g.canonical}  ${g.key}\n`);
    }
    const links = await backfillDuplicateOfFromLinks({ sql }, { dryRun: !execute });
    process.stdout.write(
      `\nduplicates-link backfill — ${mode}\n` +
        `  ${links.dryRun ? 'would stamp' : 'stamped'} duplicate_of: ${links.stamped} (still open: ${links.open})\n`,
    );
  } catch (e) {
    process.stdout.write(`⚠ recompute-watchdog-keys: skipped (${e instanceof Error ? e.message : String(e)})\n`);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* swallow */ }
  }
}

void main();
