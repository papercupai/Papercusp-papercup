/**
 * Hold restricted writes at git-sync.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571), D-006 point 3.
 *
 * Papercusp does not author an agent's file edits the way it authors a coord
 * message, so the seal-at-write rule (P-006 / P-012) cannot reach the working
 * tree. What it does own is the commit: git-sync sweeps the shared tree and
 * pushes it off the machine. So a file an agent wrote while it held an active
 * disclosure is HELD there instead:
 *
 *   A path an agent edited at time t is held when that agent has a disclosure
 *   with delivered_at <= t that is still unreleased. The hold lifts when every
 *   such disclosure is released (D-002 / D-005).
 *
 * The hold is fed to git-sync as extra rows of its live-lock census, the same
 * seam a peer's edit lock uses (git-sync-action.ts → runGitSync liveLockHoldings
 * / refreshLiveLockHoldings). It therefore inherits everything that seam already
 * does: coordinate translation across checkouts and submodules, exclusion from
 * the staging pathspecs, edit-cohort expansion, and the late-lock unstage at the
 * final commit seam. A held path is neither committed nor pushed.
 *
 * WHICH EDITS. The source is harness_shared.edit_attribution_ledger, which records
 * each native edit (Edit / Write / apply_patch …) with its editor and time. For an
 * owner holding an active disclosure, the row is written BEFORE the edit lock is
 * released (`recordRestrictedEditBeforeRelease`, called from locks:release), so
 * there is no instant where git-sync sees neither the lock nor the hold.
 *
 * FAIL CLOSED (D-006 point 6). Both reads throw `disclosure_ledger_unavailable`
 * rather than returning an empty set. git-sync skips the tick on a census read
 * failure, and locks:release refuses (keeping the lock) when the ledger row for a
 * restricted owner cannot be written.
 *
 * WRITES WITH NO LEDGER ROW (WI-10005576). A Bash redirect, `sed -i`, a script or
 * a background job writes without a native edit tool, so it leaves no ledger row
 * and the rule above cannot see it. The second half of the census therefore works
 * from the working tree, not the ledger: while ANY disclosure is unreleased, every
 * changed or untracked file (superproject and submodules) whose mtime falls at or
 * after the earliest unreleased delivery is held — unless a native edit by an
 * editor with no active disclosure, recorded at or after that mtime, accounts for
 * it (`readRestrictedWindowHoldings`). Unattributed writes by anyone in the window
 * are held too: which session made them cannot be known, so the hold fails closed
 * and lifts with the last release. Deletions are never held (they carry nothing
 * off the machine). With no unreleased disclosure this half costs one query.
 */

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { DisclosureRefused } from './disclosure-ledger';

type Db = postgres.Sql | postgres.TransactionSql;

/** The intent every restricted hold carries. git-sync renders it in skipped-path diagnostics. */
export const RESTRICTED_HOLD_INTENT =
  'restricted-disclosure hold (D-006/P-014): edited while its editor held an active personal disclosure; held from commit until that disclosure is released';

const RESTRICTED_HOLD_PREFIX = 'restricted-disclosure hold (D-006';

/** True for a census row this module produced (not a real, releasable edit lock). */
export function isRestrictedHoldIntent(intent: string | null | undefined): boolean {
  return typeof intent === 'string' && intent.startsWith(RESTRICTED_HOLD_PREFIX);
}

/**
 * One held path. Structurally a `LiveLockHolding`, so it joins git-sync's census
 * unchanged; `coordinationDomain` is the ledger's `repo_root`, the domain the
 * edit lock was held in, which git-sync translates exactly as it does that lock.
 */
export interface RestrictedEditHolding {
  path: string;
  owner: string;
  intent: string;
  goalRef?: string;
  coordinationDomain?: string;
  /** ISO time of the edit that began the hold (turn holds only); git-sync reports the hold's age from it. */
  heldSince?: string;
}

/** A ledger row as `readRestrictedEditHoldings` selects it. */
export interface RestrictedEditRow {
  repo_root: string | null;
  file: string | null;
  agent_id: string | null;
  work_item_id: string | null;
}

/** Map ledger rows to census holdings: one per (domain, path), blanks dropped. Pure. */
export function restrictedHoldingsFromRows(rows: readonly RestrictedEditRow[]): RestrictedEditHolding[] {
  return holdingsFromLedgerRows(rows, RESTRICTED_HOLD_INTENT);
}

/** Shared row → holding mapping for every ledger-backed hold. Pure. */
function holdingsFromLedgerRows(
  rows: readonly (RestrictedEditRow & { ts?: string | null })[],
  intent: string,
): RestrictedEditHolding[] {
  const out: RestrictedEditHolding[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const path = row.file?.trim() ?? '';
    const owner = row.agent_id?.trim() ?? '';
    if (!path || !owner) continue;
    const domain = row.repo_root?.trim() ?? '';
    const key = `${domain}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const goalRef = row.work_item_id?.trim() ?? '';
    const heldSinceMs = row.ts ? Date.parse(row.ts) : Number.NaN;
    out.push({
      path,
      owner,
      intent,
      // A work-item seeds git-sync's edit-cohort expansion, so a restricted edit's
      // source+test siblings stay together instead of one reaching HEAD alone.
      ...(goalRef ? { goalRef } : {}),
      ...(domain ? { coordinationDomain: domain } : {}),
      ...(Number.isFinite(heldSinceMs) ? { heldSince: new Date(heldSinceMs).toISOString() } : {}),
    });
  }
  return out;
}

function ledgerUnavailable(what: string, error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `${what}: the disclosure ledger could not be read (${(error as Error)?.message ?? error})`,
  );
}

/**
 * Every path edited by an agent while it held a disclosure that is still active.
 * Driven from the (small) active-disclosure set, so the ledger is reached only
 * through its (agent_id, ts) index (migration 1345). Throws
 * `disclosure_ledger_unavailable` on any read failure: a census that silently
 * read as empty would commit the very files this exists to hold.
 */
export async function readRestrictedEditHoldings(sql: Db = getOrgPg().sql): Promise<RestrictedEditHolding[]> {
  let rows: RestrictedEditRow[];
  try {
    rows = await sql<RestrictedEditRow[]>`
      SELECT DISTINCT ON (l.repo_root, l.file)
             l.repo_root, l.file, l.agent_id, l.work_item_id
        FROM harness_shared.personal_disclosures d
        JOIN harness_shared.edit_attribution_ledger l
          ON l.agent_id = d.agent_owner_id
         AND l.ts >= d.delivered_at
       WHERE d.released_at IS NULL
       ORDER BY l.repo_root, l.file, l.ts DESC`;
  } catch (error) {
    throw ledgerUnavailable('git-sync restricted-write hold', error);
  }
  return restrictedHoldingsFromRows(rows);
}

// ── turn-scoped hold (git-sync-turn-scoped-commit-hold-2026-10-11) ─────────

/**
 * The intent of a turn hold. git-sync renders it in skipped-path diagnostics; the
 * holder lifts it by ending its turn, not with `locks:release`.
 */
export const TURN_HOLD_INTENT =
  'turn-scoped hold (git-sync-turn-scoped-commit-hold P-002): edited during its editor\'s current turn; held from commit until that turn ends, the session ends, or 60 min after the edit';

const TURN_HOLD_PREFIX = 'turn-scoped hold (';

/** True for a census row produced by the turn-scoped hold. */
export function isTurnHoldIntent(intent: string | null | undefined): boolean {
  return typeof intent === 'string' && intent.startsWith(TURN_HOLD_PREFIX);
}

/**
 * True for ANY census row this module produced — a hold rather than a real,
 * releasable edit lock. Its holder cannot lift it with `locks:release`, so
 * git-sync does not tell them to.
 */
export function isCensusHoldIntent(intent: string | null | undefined): boolean {
  return isRestrictedHoldIntent(intent) || isTurnHoldIntent(intent);
}

/**
 * D-001 [owner 2026-10-11]: the hold never outlives this age, measured
 * from the EDIT. A session that never records a turn end (a crash with no session
 * end recorded, or a client whose Stop hook is missing — WI-6554700010008402)
 * therefore delays a file's commit by at most this long after its last edit.
 */
export const TURN_HOLD_MAX_AGE_MS = 60 * 60 * 1000;

/** A ledger row as `readTurnHoldings` selects it. */
export interface TurnEditRow extends RestrictedEditRow {
  /** ISO time of the newest qualifying edit of this path. */
  ts: string | null;
}

/** Map turn-hold rows to census holdings. Pure. */
export function turnHoldingsFromRows(rows: readonly TurnEditRow[]): RestrictedEditHolding[] {
  return holdingsFromLedgerRows(rows, TURN_HOLD_INTENT);
}

/**
 * Every path a live session edited during its CURRENT turn: a native edit
 * (edit_attribution_ledger — written at lock grant, before the edit) newer than
 * the editor's last recorded turn end, unless every recorded session of the
 * editor has ended or the turn has outlived the cap.
 *
 *  - THE CAP IS PER TURN (plan git-sync-turn-scoped-commit-hold-2026-10-11#D-005):
 *    once ANY edit the owner made since its turn end is older than `maxAgeMs`,
 *    none of its edits are held, so a long turn's files commit together rather
 *    than one at a time (which could commit a source ahead of the importer that
 *    depends on it). The anchor is the turn's oldest edit, not the previous turn
 *    end, which for a parked agent can be hours old.
 *  - TURN END = the newest `session_turn_journal` row for the owner, using its
 *    `turn_ts` (the turn's final assistant message, transcript-derived) and only
 *    falling back to `created_at` (the asynchronous insert) when absent. The
 *    insert can land AFTER the next turn's first edit, which would release a
 *    mid-turn file; `turn_ts` cannot. Erring early holds longer, never shorter.
 *  - SESSION ENDED needs POSITIVE evidence: the owner has adv_sessions rows and
 *    none is still open (`ended_at IS NULL`) — the same session-log authority as
 *    the liveness oracle's `recorded` leg. An owner with no session row is
 *    treated as live and bounded by `maxAgeMs`.
 *  - ONLY JOURNALING EDITORS ARE HELD: the owner must have at least one
 *    `session_turn_journal` row, ever. A host that never journals turn ends
 *    (e.g. a Codex home written by a build without the stop-turn-journal
 *    enrolment, WI-6554700010008402) has nothing that could release its edits early, so
 *    holding it would delay every edit by the full `maxAgeMs` cap. Such an
 *    editor is not held, which is the pre-hold behaviour. Consequence: a brand-new
 *    owner's first turn is also unheld, until its first turn end is journaled.
 *
 * Throws `disclosure_ledger_unavailable` on any read failure: git-sync then
 * skips the tick rather than staging a file an agent is still editing.
 */
export async function readTurnHoldings(
  sql: Db = getOrgPg().sql,
  opts: { maxAgeMs?: number } = {},
): Promise<RestrictedEditHolding[]> {
  const maxAgeSec = Math.max(1, Math.round((opts.maxAgeMs ?? TURN_HOLD_MAX_AGE_MS) / 1000));
  // A turn end older than every candidate edit cannot release any of them, so the
  // journal read is bounded to the same window (plus slack for turn_ts lagging
  // created_at), which keeps it on the (owner_id, created_at) index.
  const journalWindowSec = maxAgeSec + 600;
  let rows: TurnEditRow[];
  try {
    rows = await sql<TurnEditRow[]>`
      WITH recent AS (
        SELECT l.repo_root, l.file, l.agent_id, l.work_item_id, l.ts
          FROM harness_shared.edit_attribution_ledger l
         WHERE l.ts > now() - make_interval(secs => ${maxAgeSec})
           AND l.agent_id IS NOT NULL
      ),
      editors AS (
        SELECT e.agent_id,
               -- The newest turn end in the window; outside it, the owner's newest row
               -- ever (one backward probe of the (owner_id, created_at) index). NULL
               -- only for an owner that has never journaled a turn end (D-003).
               COALESCE(
                 (SELECT max(COALESCE(j.turn_ts, j.created_at))
                    FROM harness_shared.session_turn_journal j
                   WHERE j.owner_id = e.agent_id
                     AND j.created_at > now() - make_interval(secs => ${journalWindowSec})),
                 (SELECT COALESCE(j.turn_ts, j.created_at)
                    FROM harness_shared.session_turn_journal j
                   WHERE j.owner_id = e.agent_id
                   ORDER BY j.created_at DESC
                   LIMIT 1)) AS turn_ended_at,
               (EXISTS (SELECT 1 FROM harness_shared.adv_sessions s WHERE s.coord_owner_id = e.agent_id)
                AND NOT EXISTS (SELECT 1 FROM harness_shared.adv_sessions s
                                 WHERE s.coord_owner_id = e.agent_id AND s.ended_at IS NULL)) AS session_ended
          FROM (SELECT DISTINCT agent_id FROM recent) e
      ),
      held AS (
        -- D-005: the cap is per TURN. Once any edit since the turn end is older than
        -- the cap, none of the owner's edits are held, so the whole turn commits
        -- together instead of one file at a time. Probes the (agent_id, ts) index.
        SELECT e.agent_id, e.turn_ended_at
          FROM editors e
         WHERE NOT e.session_ended
           AND e.turn_ended_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM harness_shared.edit_attribution_ledger o
                            WHERE o.agent_id = e.agent_id
                              AND o.ts > e.turn_ended_at
                              AND o.ts <= now() - make_interval(secs => ${maxAgeSec}))
      )
      SELECT DISTINCT ON (r.repo_root, r.file)
             r.repo_root, r.file, r.agent_id, r.work_item_id, r.ts::text AS ts
        FROM recent r
        JOIN held h ON h.agent_id = r.agent_id
       WHERE r.ts > h.turn_ended_at
       ORDER BY r.repo_root, r.file, r.ts DESC`;
  } catch (error) {
    throw ledgerUnavailable('git-sync turn-scoped hold', error);
  }
  return turnHoldingsFromRows(rows);
}

// ── writes with no ledger row (WI-10005576) ───────────────────────────────

/** The intent of a window hold. Shares the restricted prefix, so git-sync treats it as a hold, not a lock. */
export const RESTRICTED_WINDOW_INTENT =
  'restricted-disclosure hold (D-006/P-014, unattributed write): changed while a personal disclosure was active and not accounted for by a native edit of an unrestricted editor; held until every active disclosure is released';

/** The census `owner` of a window hold: no single session can be named for an unattributed write. */
export const RESTRICTED_WINDOW_OWNER = 'personal-disclosure-window';

/** A native edit recorded this close to (or after) a file's mtime accounts for that write. */
export const RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS = 2_000;

export type HoldRunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A changed or untracked file: the absolute repository root and the root-relative path. */
export interface DirtyFile {
  root: string;
  path: string;
}

/**
 * Every changed or untracked file of `repoPath` and its initialised submodules
 * (`git submodule status --recursive`, the discovery git-sync itself uses).
 * Deleted paths are skipped. Throws when any git call fails: an unlisted tree
 * would read as "nothing to hold".
 */
export async function listDirtyFilesRecursive(runGit: HoldRunGit, repoPath: string): Promise<DirtyFile[]> {
  const subs = await runGit(['submodule', 'status', '--recursive'], repoPath);
  if (subs.code !== 0) throw new Error(`git submodule status failed in ${repoPath}: ${subs.stderr.trim()}`);
  const submoduleRoots = subs.stdout
    .split('\n')
    .filter((line) => line.length > 1 && line[0] !== '-') // '-' = not initialised
    .map((line) => line.slice(1).trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p))
    .map((p) => path.join(repoPath, p));
  const out: DirtyFile[] = [];
  for (const root of [repoPath, ...submoduleRoots]) {
    const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], root);
    if (status.code !== 0) throw new Error(`git status failed in ${root}: ${status.stderr.trim()}`);
    const fields = status.stdout.split('\0');
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      // -z rename/copy: "XY <to>\0<from>\0" — the next field is the source path.
      if (xy[0] === 'R' || xy[0] === 'C') i += 1;
      if (xy.includes('D')) continue;
      out.push({ root, path: entry.slice(3) });
    }
  }
  return out;
}

export interface RestrictedWindowDeps {
  sql?: Db;
  /** The working tree's changed files (production: `listDirtyFilesRecursive`). */
  listDirtyFiles: () => Promise<DirtyFile[]>;
  /** A file's mtime in ms, or null when it no longer exists. */
  mtimeMs?: (absPath: string) => Promise<number | null>;
}

async function fileMtimeMs(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Hold every changed file written inside an active disclosure window that no
 * unrestricted native edit accounts for (module header, WI-10005576). Throws
 * `disclosure_ledger_unavailable` when the ledger or the tree cannot be read
 * while a disclosure is active.
 */
export async function readRestrictedWindowHoldings(deps: RestrictedWindowDeps): Promise<RestrictedEditHolding[]> {
  const sql = deps.sql ?? getOrgPg().sql;
  let window: { since: Date | string | null; restricted: string[] | null } | undefined;
  try {
    [window] = await sql<Array<{ since: Date | string | null; restricted: string[] | null }>>`
      SELECT min(delivered_at) AS since, array_agg(DISTINCT agent_owner_id) AS restricted
        FROM harness_shared.personal_disclosures
       WHERE released_at IS NULL`;
  } catch (error) {
    throw ledgerUnavailable('git-sync unattributed-write hold', error);
  }
  if (!window?.since) return [];
  const sinceMs = new Date(window.since).getTime();
  const restricted = new Set(window.restricted ?? []);

  let dirty: DirtyFile[];
  try {
    dirty = await deps.listDirtyFiles();
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `git-sync unattributed-write hold: the working tree's changed files could not be listed while a personal disclosure is active (${(error as Error)?.message ?? error})`,
    );
  }
  const mtimeOf = deps.mtimeMs ?? fileMtimeMs;
  const candidates: Array<DirtyFile & { abs: string; mtimeMs: number }> = [];
  for (const file of dirty) {
    const abs = path.join(file.root, file.path);
    const mtimeMs = await mtimeOf(abs);
    if (mtimeMs !== null && mtimeMs >= sinceMs) candidates.push({ ...file, abs, mtimeMs });
  }
  if (!candidates.length) return [];

  // A ledger row's file is relative to the lock's domain, which may be the
  // superproject or the submodule, so query every root-relative spelling and
  // match on the absolute path.
  const roots = [...new Set(candidates.map((c) => c.root))];
  const spellings = new Set<string>();
  for (const c of candidates) {
    for (const root of roots) if (c.abs.startsWith(`${root}${path.sep}`)) spellings.add(path.relative(root, c.abs));
  }
  let rows: Array<{ repo_root: string; file: string; agent_id: string | null; ts: Date | string }>;
  try {
    rows = await sql<Array<{ repo_root: string; file: string; agent_id: string | null; ts: Date | string }>>`
      SELECT repo_root, file, agent_id, ts
        FROM harness_shared.edit_attribution_ledger
       WHERE repo_root = ANY(${roots}::text[])
         AND file = ANY(${[...spellings]}::text[])
         AND ts >= ${new Date(sinceMs - RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS)}`;
  } catch (error) {
    throw ledgerUnavailable('git-sync unattributed-write hold', error);
  }
  const latest = new Map<string, { agent: string; tsMs: number }>();
  for (const row of rows) {
    const abs = path.join(row.repo_root, row.file);
    const tsMs = new Date(row.ts).getTime();
    const prior = latest.get(abs);
    if (!prior || tsMs > prior.tsMs) latest.set(abs, { agent: row.agent_id?.trim() ?? '', tsMs });
  }

  const out: RestrictedEditHolding[] = [];
  for (const c of candidates) {
    const edit = latest.get(c.abs);
    const accounted =
      edit !== undefined &&
      edit.agent !== '' &&
      !restricted.has(edit.agent) &&
      edit.tsMs >= c.mtimeMs - RESTRICTED_WINDOW_ATTRIBUTION_SLACK_MS;
    if (!accounted) out.push({ path: c.path, owner: RESTRICTED_WINDOW_OWNER, intent: RESTRICTED_WINDOW_INTENT, coordinationDomain: c.root });
  }
  return out;
}

export type RestrictedSourceHoldState = 'held' | 'clear' | 'unknown';

export interface RestrictedSourceHoldDeps {
  /** Override the attributed edit census. */
  readAttributed?: () => Promise<RestrictedEditHolding[]>;
  /** Override the dirty-window census for a canonical integration root. */
  readWindow?: (realRoot: string) => Promise<RestrictedEditHolding[]>;
}

function pathIsUnder(root: string, target: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  return absoluteTarget === absoluteRoot || absoluteTarget.startsWith(absoluteRoot + path.sep);
}

async function holdingTouchesRoot(realRoot: string, holding: RestrictedEditHolding): Promise<boolean> {
  let domain = realRoot;
  if (holding.coordinationDomain) {
    const candidate = holding.coordinationDomain.trim();
    if (!path.isAbsolute(candidate)) throw new Error('restricted hold coordination domain is not absolute');
    domain = await realpath(candidate).catch(() => path.resolve(candidate));
  }
  const absolute = path.resolve(path.isAbsolute(holding.path) ? holding.path : path.resolve(domain, holding.path));
  const real = await realpath(absolute).catch(() => absolute);
  return pathIsUnder(realRoot, absolute) || pathIsUnder(realRoot, real);
}

async function runRestrictedSourceGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // Keep the source census on git-sync's bounded runner so its dirty-window view
  // has the same timeout, locale, and dispatch behavior as the writer's census.
  const { gitTimeoutMsFor, runGitBounded } = await import('../harness/git-sync/run-git-sync');
  return runGitBounded(args, cwd, gitTimeoutMsFor(args));
}

/**
 * Read the source hold for the explicitly configured canonical integration tree.
 * The answer is fail-closed: no configured/resolvable root or a failed attributed
 * or dirty-window census is unknown, never clear. The window half uses git-sync's
 * recursive superproject/submodule census, so shell writes stay visible too.
 */
export async function readRestrictedSourceHoldState(
  integrationRoot: string | null | undefined = process.env.PAPERCUSP_INTEGRATION_ROOT,
  deps: RestrictedSourceHoldDeps = {},
): Promise<RestrictedSourceHoldState> {
  const configuredRoot = integrationRoot?.trim();
  if (!configuredRoot) return 'unknown';

  let realRoot: string;
  try {
    realRoot = await realpath(configuredRoot);
  } catch {
    return 'unknown';
  }

  try {
    const readAttributed = deps.readAttributed ?? (() => readRestrictedEditHoldings());
    const readWindow =
      deps.readWindow ??
      ((root: string) =>
        readRestrictedWindowHoldings({
          listDirtyFiles: () => listDirtyFilesRecursive(runRestrictedSourceGit, root),
        }));
    const [attributed, window] = await Promise.all([readAttributed(), readWindow(realRoot)]);
    for (const holding of [...attributed, ...window]) {
      if (await holdingTouchesRoot(realRoot, holding)) return 'held';
    }
    return 'clear';
  } catch {
    return 'unknown';
  }
}

/** The census's independent reads, in the order git-sync reports them. */
export const GIT_SYNC_CENSUS_LEGS = ['live-locks', 'restricted-holds', 'working-tree-window', 'turn-holds'] as const;
export type GitSyncCensusLeg = (typeof GIT_SYNC_CENSUS_LEGS)[number];

/** One census entry: a live lock, or a hold that also carries when it began (turn holds). */
export type GitSyncCensusHolding = LiveLockHolding & Pick<RestrictedEditHolding, 'heldSince'>;

/**
 * git-sync's commit-gate census: every live edit lock, every restricted hold,
 * (given the tree to read) every unattributed write inside an active disclosure
 * window, and every path a live session edited during its current turn. Every
 * leg is strict, so any read failing throws and git-sync fails the tick closed
 * rather than staging a held path. Used for the initial census AND the
 * final-commit-seam refresh (git-sync-action.ts).
 */
export async function readGitSyncCensusStrict(
  deps: {
    locks?: () => Promise<LiveLockHolding[]>;
    restricted?: () => Promise<RestrictedEditHolding[]>;
    /** The tree git-sync is about to sweep. Production always passes it (git-sync-action.ts). */
    window?: { repoPath: string; runGit: HoldRunGit } | (() => Promise<RestrictedEditHolding[]>);
    /**
     * Turn-scoped holds. Omitted ⇒ no turn hold (the leg reports complete with an
     * empty set); git-sync-action passes `readTurnHoldings` while its kill-switch
     * flag is ON, so this default never silently widens another caller's census.
     */
    turn?: () => Promise<RestrictedEditHolding[]>;
    /** Progress for the independent reads. Diagnostic callbacks never affect the fail-closed census. */
    onLeg?: (leg: GitSyncCensusLeg, status: 'started' | 'completed' | 'failed') => void;
  } = {},
): Promise<GitSyncCensusHolding[]> {
  const tree = deps.window;
  const readWindow: () => Promise<RestrictedEditHolding[]> =
    typeof tree === 'function'
      ? tree
      : tree
        ? () => readRestrictedWindowHoldings({ listDirtyFiles: () => listDirtyFilesRecursive(tree.runGit, tree.repoPath) })
        : async () => [];

  const observeLeg = async <T>(leg: GitSyncCensusLeg, read: () => Promise<T>): Promise<T> => {
    const notify = (status: 'started' | 'completed' | 'failed'): void => {
      try {
        deps.onLeg?.(leg, status);
      } catch {
        // Diagnostic progress is best-effort and never weakens the strict census.
      }
    };
    notify('started');
    try {
      const value = await read();
      notify('completed');
      return value;
    } catch (error) {
      notify('failed');
      throw error;
    }
  };

  const [locks, restricted, windowHolds, turnHolds] = await Promise.all([
    observeLeg('live-locks', deps.locks ?? liveLockHoldingsStrict),
    observeLeg('restricted-holds', deps.restricted ?? (() => readRestrictedEditHoldings())),
    observeLeg('working-tree-window', readWindow),
    observeLeg('turn-holds', deps.turn ?? (async () => [])),
  ]);
  return [...locks, ...restricted, ...windowHolds, ...turnHolds];
}

/** Whether `ownerId` holds any unreleased disclosure. Throws `disclosure_ledger_unavailable`. */
export async function ownerHasActiveDisclosure(sql: Db, ownerId: string): Promise<boolean> {
  try {
    const [row] = await sql<Array<{ active: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM harness_shared.personal_disclosures
                      WHERE agent_owner_id = ${ownerId} AND released_at IS NULL) AS active`;
    return row?.active === true;
  } catch (error) {
    throw ledgerUnavailable('restricted-edit hold check', error);
  }
}

export interface RestrictedEditBeforeRelease {
  /** The lock's coordination domain: the root the paths are relative to. */
  repoRoot: string;
  /** The paths the native-edit proof says were written. */
  files: string[];
  ownerId: string;
  intent?: string;
  workspaceId?: string;
  contributor?: string;
  sessionId?: string;
}

export interface RestrictedEditBeforeReleaseDeps {
  hasActiveDisclosure?: (ownerId: string) => Promise<boolean>;
  /** Must THROW when the row is not written (the best-effort recorder swallows). */
  recordStrict?: (input: RestrictedEditBeforeRelease) => Promise<void>;
}

/**
 * Called by locks:release BEFORE it releases a native-edit lock. When the owner
 * holds an active disclosure, write the edit's ledger row first and return true,
 * so git-sync's census sees the hold before the lock disappears. Returns false
 * (and writes nothing) for an unrestricted owner. Throws
 * `disclosure_ledger_unavailable` when the check or the write fails; the caller
 * must then keep the lock rather than release it.
 */
export async function recordRestrictedEditBeforeRelease(
  input: RestrictedEditBeforeRelease,
  deps: RestrictedEditBeforeReleaseDeps = {},
): Promise<boolean> {
  const files = input.files.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0 || !input.ownerId || !input.repoRoot) return false;
  const hasActive = deps.hasActiveDisclosure ?? ((owner: string) => ownerHasActiveDisclosure(getOrgPg().sql, owner));
  if (!(await hasActive(input.ownerId))) return false;
  const record =
    deps.recordStrict ??
    (async (i: RestrictedEditBeforeRelease) => {
      const { recordEditAttributionStrict } = await import('../edit-attribution');
      await recordEditAttributionStrict({
        repoRoot: i.repoRoot,
        files: i.files,
        agentId: i.ownerId,
        intent: i.intent,
        workspaceId: i.workspaceId,
        contributor: i.contributor,
        sessionId: i.sessionId,
      });
    });
  try {
    await record({ ...input, files });
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `restricted-edit hold: the edit could not be recorded, so the lock is kept (${(error as Error)?.message ?? error})`,
    );
  }
  return true;
}
