import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard under test: WI-38352. A hand-numbered migration red-pins lint:migrations, which is
// a RELEASE-CUT PREFLIGHT, so one file blocks every agent's cut (3 occurrences in ~24h).
//
// ⚠ THE SUBJECT PATH IS OVERRIDABLE ON PURPOSE (mutation-probe TIER 2, the repo's
// "proving a guard is falsifiable" rule). Point PAPERCUSP_UNRESERVED_MIGRATION_GUARD_HOOK
// at a MUTATED COPY outside the tree to prove this suite catches a weakened guard — never
// mutate the in-tree file: git-sync sweeps the whole working tree on a schedule and can
// commit the mutant even when nothing goes wrong, and a trap cannot fix that race.
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK =
  process.env.PAPERCUSP_UNRESERVED_MIGRATION_GUARD_HOOK ||
  resolve(HERE, '..', 'pretooluse-unreserved-migration-guard.mjs');
// apps/operator/scripts/hooks/cc/__tests__ -> repo root
const REPO = resolve(HERE, '..', '..', '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs/papercusp/libs/db/sql');

/**
 * A number that can never hold a reservation row: the allocator hands out MAX+1
 * sequentially and is in the 800s. Using an impossible number instead of a merely
 * currently-unused one keeps the deny case deterministic as the fleet keeps allocating.
 */
const IMPOSSIBLE = 999999;
/** Reserved by construction: the allocator's own ledger starts far above this. */
const BELOW_ENFORCED = 100;

type Run = { denied: boolean; reason: string; inert: boolean };

// This suite deliberately passes hermetic env fragments without NODE_ENV. The apps/operator
// ambient types augment NodeJS.ProcessEnv with a required NODE_ENV, but the child hook accepts
// an ordinary string map and the production process.env spread supplies the rest.
function runHook(payload: unknown, env: Record<string, string | undefined> = {}): Run {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // stderr carries the INERT marker: the guard announces when it ALLOWED without being able
  // to judge, which is what keeps a silently-inert guard distinguishable from a passing one.
  const inert = (res.stderr ?? '').includes('unreserved-migration-guard: INERT');
  const out = (res.stdout ?? '').trim();
  if (!out) return { denied: false, reason: '', inert };
  const parsed = JSON.parse(out);
  const d = parsed.hookSpecificOutput ?? {};
  expect(d.hookEventName).toBe('PreToolUse');
  return { denied: d.permissionDecision === 'deny', reason: d.permissionDecisionReason ?? '', inert };
}

const write = (file_path: string, tool = 'Write') => ({ tool_name: tool, tool_input: { file_path } });
const applyPatch = (file_path: string, wrapped = false) => {
  const patch = [
    '*** Begin Patch',
    `*** Add File: ${file_path}`,
    '+-- migration test',
    '*** End Patch',
  ].join('\n');
  return { tool_name: 'apply_patch', tool_input: wrapped ? { patch } : patch };
};

/**
 * Can this environment reach the reservations table at all?
 *
 * Every DENY assertion below needs live PG, and without it the guard fails OPEN — which
 * would turn "the guard is broken" into a quietly PASSING allow-test. Gating on the guard's
 * own INERT marker makes the difference explicit: the deny cases are skipped where they
 * cannot be judged, never silently satisfied.
 */
const PG_READY = !runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-probe.sql`))).inert;

describe.skipIf(!PG_READY)('pretooluse-unreserved-migration-guard — falsifiability in BOTH directions', () => {
  // The deny case alone cannot distinguish a correct guard from one that denies
  // everything, which is why the allow case below is not optional.
  it('DENIES a hand-numbered migration (no reservation row)', () => {
    const { denied, reason } = runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-hand-numbered.sql`)));
    expect(denied).toBe(true);
    expect(reason).toContain('has no row in harness_shared.migration_reservations');
    // it must relay the remedy, not just refuse
    expect(reason).toContain('node scripts/next-migration.mjs --name hand-numbered');
    // and say why this is not merely the author's problem
    expect(reason).toContain('RELEASE-CUT PREFLIGHT');
  });

  it('DENIES a repo-relative Codex apply_patch target', () => {
    const { denied, reason } = runHook(
      applyPatch(`libs/papercusp/libs/db/sql/${IMPOSSIBLE}-codex-patch.sql`),
      { PAPERCUSP_WORKSPACE_ROOT: REPO },
    );
    expect(denied).toBe(true);
    expect(reason).toContain('has no row in harness_shared.migration_reservations');
  });

  it('DENIES a wrapped Codex apply_patch target', () => {
    const { denied, reason } = runHook(
      applyPatch(`libs/papercusp/libs/db/sql/${IMPOSSIBLE}-wrapped-codex-patch.sql`, true),
      { PAPERCUSP_WORKSPACE_ROOT: REPO },
    );
    expect(denied).toBe(true);
    expect(reason).toContain('has no row in harness_shared.migration_reservations');
  });

  it('DENIES an already-applied migration even when its number was allocated', () => {
    // 818 was allocated through the allocator and is already applied. The old guard
    // returned early on `reserved`, allowing edits that only affected fresh installs.
    const { denied, reason } = runHook(write(join(SQL_DIR, '818-backfill-migration-reservation-815.sql'), 'Edit'));
    expect(denied).toBe(true);
    expect(reason).toContain('already recorded in harness_shared.schema_migrations');
    expect(reason).toContain('Do not edit');
    expect(reason).toContain('node scripts/next-migration.mjs --name backfill-migration-reservation-815-followup');
    expect(reason).not.toContain('has no row in harness_shared.migration_reservations');
  });

  it('ALLOWS an allocated migration that is not applied yet — silently', () => {
    // 848 has an allocator reservation but is still pending on the shared DB.
    const { denied, reason } = runHook(write(join(SQL_DIR, '848-widen-consult-and-interest-watch-embeddings-to-768.sql'), 'Edit'));
    expect(denied).toBe(false);
    expect(reason).toBe('');
  });

  it('ALLOWS a number below ENFORCED_FROM (grandfathered legacy)', () => {
    expect(runHook(write(join(SQL_DIR, `${BELOW_ENFORCED}-legacy.sql`), 'Edit')).denied).toBe(false);
  });

  it('DENIES an applied grandfathered migration below ENFORCED_FROM', () => {
    // 000-baseline is intentionally below the reservation-enforcement boundary, but
    // applied filenames are immutable independently of that newer allocator policy.
    const { denied, reason } = runHook(write(join(SQL_DIR, '000-baseline.sql'), 'Edit'));
    expect(denied).toBe(true);
    expect(reason).toContain('already recorded in harness_shared.schema_migrations');
    expect(reason).toContain('Do not edit');
  });
});

describe('scope — what the guard must not touch', () => {
  it('ignores a non-migration file', () => {
    expect(runHook(write(join(REPO, 'scripts/lint-migrations.mjs'), 'Edit')).denied).toBe(false);
  });

  it('ignores a non-migration Codex apply_patch target', () => {
    expect(runHook(applyPatch('packages/operator-core/lib/example.ts'), { PAPERCUSP_WORKSPACE_ROOT: REPO }).denied).toBe(false);
  });

  it('ignores sql/archive/** (historical, one directory deeper)', () => {
    expect(runHook(write(join(SQL_DIR, `archive/${IMPOSSIBLE}-old.sql`))).denied).toBe(false);
  });

  it('ignores a tool that does not write bytes', () => {
    const p = join(SQL_DIR, `${IMPOSSIBLE}-hand-numbered.sql`);
    expect(runHook(write(p, 'Read')).denied).toBe(false);
    expect(runHook(write(p, 'mcp__papercusp-su__capability_read')).denied).toBe(false);
  });

  it.skipIf(!PG_READY)('COVERS the MCP capability twins — the hole measured on the sibling guard', () => {
    // isFileWritingTool is imported from pretooluse-generated-file-edit-guard rather than
    // re-listed, so a name-keyed omission cannot re-open it here.
    const p = join(SQL_DIR, `${IMPOSSIBLE}-hand-numbered.sql`);
    expect(runHook(write(p, 'mcp__papercusp-su__capability_write')).denied).toBe(true);
    expect(runHook(write(p, 'mcp__some-other-server__capability_edit')).denied).toBe(true);
  });
});

describe('fail-open — a guard that cannot decide must never block a write', () => {
  it('allows when PG is unreachable', () => {
    const { denied } = runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-x.sql`)), {
      HARNESS_ADMIN_DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nodb',
    });
    expect(denied).toBe(false);
  });

  it('allows when the repo root derived from the path has no lint-migrations.mjs', () => {
    // e.g. someone working inside the libs/papercusp SUBMODULE checkout, where the path is
    // only libs/db/sql/** and the superproject scripts/ is not above it.
    const { denied } = runHook(write(`/nonexistent-root/libs/papercusp/libs/db/sql/${IMPOSSIBLE}-x.sql`));
    expect(denied).toBe(false);
  });

  it('allows under the documented session bypass', () => {
    const { denied } = runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-x.sql`)), {
      PAPERCUSP_ALLOW_UNRESERVED_MIGRATION: '1',
    });
    expect(denied).toBe(false);
  });
});

describe.skipIf(!PG_READY)('the refusal names the repair that actually applies', () => {
  it('offers the cheap fix while the file is still renumberable', () => {
    const { reason } = runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-add-thing.sql`)));
    expect(reason).toContain('ONE-COMMAND fix');
    expect(reason).toContain('IMMUTABLE');
    expect(reason).not.toContain('ALREADY APPLIED');
  });

  it('documents its own bypass instead of leaving the author stuck', () => {
    const { reason } = runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-x.sql`)));
    expect(reason).toContain('PAPERCUSP_ALLOW_UNRESERVED_MIGRATION=1');
  });
});

describe('embedded self-test', () => {
  it('passes (path parsing, tool coverage, and both message shapes)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toMatch(/^ok — \d+ cases$/m);
    expect(out).not.toContain('FAIL');
  });
});

describe.skipIf(!PG_READY)('the boundary is IMPORTED from the lint, never copied', () => {
  it('uses the same ENFORCED_FROM the lint enforces', async () => {
    const lint = await import(join(REPO, 'scripts/lint-migrations.mjs'));
    // A number just below the lint's boundary must be allowed and one far above denied —
    // which is only true if the guard reads that same constant.
    expect(runHook(write(join(SQL_DIR, `${lint.ENFORCED_FROM - 1}-legacy.sql`), 'Edit')).denied).toBe(false);
    expect(runHook(write(join(SQL_DIR, `${IMPOSSIBLE}-x.sql`))).denied).toBe(true);
  });
});
