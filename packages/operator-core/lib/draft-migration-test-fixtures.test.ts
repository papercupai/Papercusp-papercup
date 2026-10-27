/**
 * WI-6554700010008558 — a test must not keep loading a migration that never shipped.
 *
 * Migrations are written at `libs/papercusp/libs/db/sql/<NNN>-<slug>.sql.DRAFT` and armed later
 * with `node scripts/next-migration.mjs --arm`. The runner applies only `*.sql`, so a DRAFT never
 * reaches a real database. Integration tests often apply the DRAFT directly, or fall back to it
 * when the armed file is missing. That is right while the migration is being written. It is wrong
 * once the work that wrote it has moved on: the test then proves code against a schema that no
 * database has, and stays green while production differs.
 *
 * Measured instances:
 * - invocation-friction.integration.test.ts applied 1148's DRAFT, so its EXPLAIN index guard
 *   passed while no real database had the index; the recovery sweep ran unindexed for weeks
 *   (WI-10007741, fixed by armed migration 1454).
 * - 920 (claim floor) was applied by three claim-floor integration tests for seven weeks after
 *   the shipped TS selector had deliberately gone the other way; retired under this work-item.
 *
 * Rule: a DRAFT that some test names and whose first git add is older than GRACE_DAYS must be
 * listed in ALLOWED_TEST_LOADED_DRAFTS with an accountable owner and a reason. Every entry must
 * still describe a real DRAFT that a test still loads, so the list can only shrink as drafts are
 * armed or retired.
 *
 * Fix a failure by, in order of preference: arming the migration; deleting the DRAFT and the
 * test's use of it when the design moved on; or adding an entry that names an OPEN work-item
 * owning the arm-or-retire decision.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF_PATH), '../../..');
const DB_REPO = resolve(REPO_ROOT, 'libs/papercusp');
const SQL_DIR_IN_DB_REPO = 'libs/db/sql';
const SELF = relative(REPO_ROOT, SELF_PATH);
const DRAFT_SUFFIX = '.sql.DRAFT';
const GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_PATHSPECS = ['*.test.ts', '*.test.tsx', '*.test.mts', '*.test.mjs'];

interface AllowedDraft {
  kind: 'contract-phase' | 'parked';
  /** An OPEN work-item that owns arming or retiring this draft. */
  owner: string;
  reason: string;
}

/**
 * Keyed by migration NUMBER only. Writing the full `<NNN>-<slug>` basename here would make this
 * file a "test that names the draft", which is exactly what the scan looks for.
 */
const ALLOWED_TEST_LOADED_DRAFTS: Record<string, AllowedDraft> = {
  '1077': {
    kind: 'parked',
    // resource-governor-admission-ledger-2026-09-01#P-005 (still open) owns this retirement.
    owner: 'WI-2092046',
    reason:
      'Guarded deletion of legacy resource-governor receipts. Not armable yet: on 2026-10-11 both governed workspaces still lacked the retired-writer marker, so the migration would refuse. admission-ledger-removal-contract.test.ts asserts it is parked or armed, never both.',
  },
  '1145': {
    kind: 'parked',
    owner: 'WI-6554700010008642',
    reason:
      'Expand phase; its header requires separate rollout authorization, which coordination-metadata-friction-reduction-2026-09-07#P-007 (controlled adoption) owns.',
  },
  '1146': {
    kind: 'contract-phase',
    owner: 'WI-6554700010008642',
    reason:
      'Contract phase of 1145. Also blocked because the deployed activeAcceptanceRubricsQuery is keyed by plan slug alone and relies on the broad index this drops.',
  },
  '1416': {
    kind: 'contract-phase',
    owner: 'WI-10007030',
    reason:
      'Drops the Vault transitional normalizers once :3070 and bg-host serve WI-10006490 code; the test proves that code survives the contract.',
  },
  '1466': {
    kind: 'parked',
    owner: 'WI-6554700010008759',
    reason:
      'Feature-receiver equal-key apply clock (report-plan D-028). Its header forbids live execution without a separately scoped migration/backup/rollout operation; the hyperbee remote-clock integration tests verify it on disposable migrated PG.',
  },
  '1467': {
    kind: 'parked',
    owner: 'WI-6554700010008773',
    reason:
      'Issue-receiver extension of 1466 (report-plan D033): "DRAFT ONLY: disposable migrated-PG verification; no live schema rollout", and 1466 must precede it in any approved rollout.',
  },
};

interface DraftScan {
  /** migration number -> `<NNN>-<slug>` basename (no suffix) */
  drafts: Map<string, string>;
  /** migration number -> repo-relative test files that name its basename */
  referencedBy: Map<string, string[]>;
  /** migration number -> first-add time in ms, or null when the draft is not committed yet */
  firstAddedMs: Map<string, number | null>;
}

function gitGrepLines(args: string[]): string[] {
  try {
    const out = execFileSync('git', ['grep', '--recurse-submodules', ...args, '--', ...TEST_PATHSPECS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch (error) {
    // git grep exits 1 for "no match"; anything else is a broken instrument and must fail loudly.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

function firstAddedMs(basename: string): number | null {
  const out = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%cI', '-1', '--', `${SQL_DIR_IN_DB_REPO}/${basename}${DRAFT_SUFFIX}`],
    { cwd: DB_REPO, encoding: 'utf8' },
  ).trim();
  return out ? Date.parse(out) : null;
}

let memo: DraftScan | undefined;
function scan(): DraftScan {
  if (memo) return memo;
  const drafts = new Map<string, string>();
  for (const file of readdirSync(resolve(DB_REPO, SQL_DIR_IN_DB_REPO))) {
    if (!file.endsWith(DRAFT_SUFFIX)) continue;
    const basename = file.slice(0, -DRAFT_SUFFIX.length);
    drafts.set(basename.split('-')[0]!, basename);
  }
  const numberByBasename = new Map([...drafts].map(([n, b]) => [b, n]));
  const referencedBy = new Map<string, string[]>();
  if (drafts.size > 0) {
    const patterns = [...drafts.values()].flatMap((b) => ['-e', b]);
    for (const line of gitGrepLines(['-o', '-F', ...patterns])) {
      // `<path>:<match>` — paths never contain ':' in this tree, the basenames never do either.
      const cut = line.indexOf(':');
      const path = line.slice(0, cut);
      const number = numberByBasename.get(line.slice(cut + 1));
      if (!number || path === SELF) continue;
      const files = referencedBy.get(number) ?? [];
      if (!files.includes(path)) files.push(path);
      referencedBy.set(number, files);
    }
  }
  const added = new Map<string, number | null>();
  for (const number of referencedBy.keys()) added.set(number, firstAddedMs(drafts.get(number)!));
  memo = { drafts, referencedBy, firstAddedMs: added };
  return memo;
}

/** Drafts that tests have loaded past the grace window with no accountable allowlist entry. */
function unownedStaleDrafts(s: DraftScan, allow: Record<string, AllowedDraft>, nowMs: number): string[] {
  const offenders: string[] = [];
  for (const [number, files] of s.referencedBy) {
    if (allow[number]) continue;
    const since = s.firstAddedMs.get(number);
    if (since === null || since === undefined) continue; // not committed yet: being written now
    const ageDays = Math.floor((nowMs - since) / DAY_MS);
    if (ageDays <= GRACE_DAYS) continue;
    offenders.push(`${s.drafts.get(number)}${DRAFT_SUFFIX} (first added ${ageDays} days ago) is loaded by: ${files.join(', ')}`);
  }
  return offenders;
}

/** Allowlist entries that no longer describe a real, still-test-loaded draft. */
function staleEntries(s: DraftScan, allow: Record<string, AllowedDraft>): string[] {
  return Object.keys(allow).flatMap((number) => {
    if (!s.drafts.has(number)) return [`${number}: no ${DRAFT_SUFFIX} file any more (armed or retired) — delete the entry`];
    if (!s.referencedBy.has(number)) return [`${number}: no test loads it any more — delete the entry`];
    return [];
  });
}

describe('test-loaded migration drafts (WI-6554700010008558)', () => {
  it('the rule flags exactly the old, test-loaded, unowned drafts (synthetic control)', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const synthetic: DraftScan = {
      drafts: new Map([
        ['901', '901-old-unowned'],
        ['902', '902-in-grace'],
        ['903', '903-uncommitted'],
        ['904', '904-old-owned'],
        ['905', '905-old-not-test-loaded'],
      ]),
      referencedBy: new Map([
        ['901', ['a.integration.test.ts']],
        ['902', ['b.integration.test.ts']],
        ['903', ['c.integration.test.ts']],
        ['904', ['d.integration.test.ts']],
      ]),
      firstAddedMs: new Map<string, number | null>([
        ['901', now - (GRACE_DAYS + 1) * DAY_MS],
        ['902', now - (GRACE_DAYS - 1) * DAY_MS],
        ['903', null],
        ['904', now - 60 * DAY_MS],
      ]),
    };
    const allow: Record<string, AllowedDraft> = {
      '904': { kind: 'parked', owner: 'WI-1', reason: 'synthetic owned entry for the control case' },
      '905': { kind: 'parked', owner: 'WI-2', reason: 'synthetic entry whose draft no test loads' },
      '906': { kind: 'parked', owner: 'WI-3', reason: 'synthetic entry whose draft file is gone' },
    };
    expect(unownedStaleDrafts(synthetic, allow, now)).toEqual([
      `901-old-unowned${DRAFT_SUFFIX} (first added ${GRACE_DAYS + 1} days ago) is loaded by: a.integration.test.ts`,
    ]);
    expect(staleEntries(synthetic, allow).map((e) => e.split(':')[0])).toEqual(['905', '906']);
  });

  it('the scan reaches test files in both the superproject and the db submodule', () => {
    // Positive control: an empty reference map must mean "no test names a draft", never
    // "git grep did not recurse into libs/papercusp" or "the pathspecs matched nothing".
    const files = gitGrepLines(['-l', '-F', '-e', "from 'vitest'"]);
    expect(files.some((f) => f.startsWith('packages/operator-core/'))).toBe(true);
    expect(files.some((f) => f.startsWith('libs/papercusp/libs/db/'))).toBe(true);
  });

  it(`every draft a test has loaded for more than ${GRACE_DAYS} days has an accountable owner`, () => {
    expect(
      unownedStaleDrafts(scan(), ALLOWED_TEST_LOADED_DRAFTS, Date.now()),
      'These tests prove code against migrations no database has. Arm each migration, or delete the draft and ' +
        "the test's use of it if the design moved on, or add an ALLOWED_TEST_LOADED_DRAFTS entry naming an OPEN owner.",
    ).toEqual([]);
  });

  it('every allowlist entry still names a draft that exists and that a test still loads', () => {
    expect(staleEntries(scan(), ALLOWED_TEST_LOADED_DRAFTS)).toEqual([]);
  });

  it('every allowlist entry names an owner and a reason', () => {
    for (const [number, entry] of Object.entries(ALLOWED_TEST_LOADED_DRAFTS)) {
      expect(entry.owner.trim(), `${number}.owner`).not.toBe('');
      expect(entry.reason.trim().length, `${number}.reason`).toBeGreaterThan(20);
    }
  });
});
