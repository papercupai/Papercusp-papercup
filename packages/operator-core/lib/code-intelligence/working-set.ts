/**
 * code-intel-epoch-carry-2026-10-20 P-001: the code an agent was working in,
 * DERIVED from ledgers that already exist — never an agent-authored list, never
 * a stored code-intelligence answer.
 *
 * Sources (one bounded read, all indexed; every read is bounded by the epoch
 * window AND scoped to the query's harness — blind review 35 G-1/G-2):
 *  - `harness_shared.code_intel_pushes` for (owner, epoch) in the epoch window:
 *    first-touch subjects are files read, interface facts cite the edited file
 *    first, grep subjects are symbol names whose first cited path is the definition.
 *  - `harness_shared.edit_attribution_ledger` rows with `agent_id = owner` in the
 *    epoch window and the query's harness (files edited).
 *  - `harness_shared.tool_invocations` rows with `coord_owner_id = owner` in the
 *    epoch window, in the query's harness or attributed to no harness (a
 *    harness-less su's calls): `lsp:query` / `graph:query` arguments name queried
 *    symbols and files; `capability:read|edit|write` name files read or edited.
 *
 * The result is a set of HANDLES (paths, symbol names) for the next epoch to
 * re-run, ranked edited > queried > read. Tier 1 of the plan: nothing here
 * carries a caller count, a definition or any other answer text.
 */
import { isAbsolute, relative } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { safeSnapshotPath } from './push-snapshot';

export const WORKING_SET_MAX_FILES = 8;
export const WORKING_SET_MAX_SYMBOLS = 6;
/** The previous epoch's start is not recorded (memory_session_epochs keeps only
 * the current bump), so its ledger window is bounded by a fixed lookback. */
export const WORKING_SET_PREVIOUS_EPOCH_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const ROW_LIMIT = 300;

export type WorkingSetReason = 'edited' | 'queried' | 'read';
const REASON_RANK: Record<WorkingSetReason, number> = { edited: 3, queried: 2, read: 1 };

export interface WorkingSetFile { path: string; reason: WorkingSetReason; hits: number }
export interface WorkingSetSymbol { name: string; path: string | null; hits: number }
export interface CodeWorkingSet {
  owner: string;
  epoch: number;
  window: { start: string; end: string };
  derivedAt: string;
  files: WorkingSetFile[];
  symbols: WorkingSetSymbol[];
  /** How many files / symbols were dropped by the caps (0 = complete). */
  truncated: { files: number; symbols: number };
}

export interface WorkingSetPushRow { leg: string; subject: string; citedPaths: readonly string[]; at: number }
export interface WorkingSetEditRow { file: string; at: number }
export interface WorkingSetToolRow { tool: string; args: unknown; at: number }
export interface WorkingSetSignals {
  pushes: readonly WorkingSetPushRow[];
  edits: readonly WorkingSetEditRow[];
  tools: readonly WorkingSetToolRow[];
}

export interface WorkingSetQuery {
  workspace: string;
  harness: string;
  owner: string;
  epoch: number;
  windowStart: Date;
  windowEnd: Date;
}

/** Tools whose arguments name code. Anything else in tool_invocations is ignored. */
export const WORKING_SET_TOOLS = ['lsp:query', 'graph:query', 'capability:read', 'capability:edit', 'capability:write'] as const;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** A path argument names a FILE only when its last segment carries an extension;
 * `lsp:query { file:'packages/operator-core/lib' }` is a search root, not a file. */
const FILE_RE = /\.[A-Za-z0-9]{1,8}$/;

/** A working-set path names first-party code. Hidden directories (`.papercusp/scratch`,
 * `.vitest-tmp`, `.git`) and `node_modules` hold agent scratch or vendored output the
 * snapshot does not index: carrying them spends the file cap on entries that can never
 * produce a resume fact (P-006 live run 1: an owner's whole previous-epoch set was
 * `.papercusp/scratch/*`, so the resume leg had nothing to push). */
export function isCodeWorkingSetPath(path: unknown): path is string {
  return safeSnapshotPath(path) && !path.split('/').some(part => part.startsWith('.') || part === 'node_modules');
}

function normalizePath(raw: unknown, root?: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  let path = raw;
  if (isAbsolute(path)) {
    if (!root) return null;
    path = relative(root, path);
  }
  path = path.replace(/^\.\//, '');
  return FILE_RE.test(path) && isCodeWorkingSetPath(path) ? path : null;
}

function argsRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 8000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Pure: rank derived signals into a bounded working set. */
export function rankCodeWorkingSet(signals: WorkingSetSignals, opts: { root?: string } = {}): Pick<CodeWorkingSet, 'files' | 'symbols' | 'truncated'> {
  const files = new Map<string, { best: WorkingSetReason; hits: number; at: number }>();
  const symbols = new Map<string, { path: string | null; hits: number; at: number }>();
  const touchFile = (raw: unknown, reason: WorkingSetReason, at: number) => {
    const path = normalizePath(raw, opts.root);
    if (!path) return;
    const prior = files.get(path);
    if (!prior) { files.set(path, { best: reason, hits: 1, at }); return; }
    prior.hits += 1;
    prior.at = Math.max(prior.at, at);
    if (REASON_RANK[reason] > REASON_RANK[prior.best]) prior.best = reason;
  };
  const touchSymbol = (raw: unknown, path: string | null, at: number) => {
    if (typeof raw !== 'string' || raw.length > 120 || !SYMBOL_RE.test(raw)) return;
    const prior = symbols.get(raw);
    if (!prior) { symbols.set(raw, { path, hits: 1, at }); return; }
    prior.hits += 1;
    prior.at = Math.max(prior.at, at);
    if (!prior.path && path) prior.path = path;
  };

  for (const row of signals.pushes) {
    const at = Number(row.at) || 0;
    if (row.leg === 'first-touch') touchFile(row.subject, 'read', at);
    else if (row.leg === 'interface') touchFile(row.citedPaths[0], 'edited', at);
    else if (row.leg === 'grep') {
      const definition = normalizePath(row.citedPaths[0], opts.root);
      touchSymbol(row.subject, definition, at);
      touchFile(definition, 'queried', at);
    }
    // resume / notes / incident / completion / intent pushes describe what the
    // channel SHOWED the agent, not what it worked in — carrying them would let a
    // file ride forward forever without ever being touched again.
  }
  for (const row of signals.edits) touchFile(row.file, 'edited', Number(row.at) || 0);
  for (const row of signals.tools) {
    const at = Number(row.at) || 0;
    const args = argsRecord(row.args);
    if (!args) continue;
    if (row.tool === 'capability:read') { touchFile(args.file_path ?? args.path, 'read', at); continue; }
    if (row.tool === 'capability:edit' || row.tool === 'capability:write') { touchFile(args.file_path ?? args.path, 'edited', at); continue; }
    if (row.tool !== 'lsp:query' && row.tool !== 'graph:query') continue;
    const file = normalizePath(args.file, opts.root);
    touchSymbol(args.name ?? args.symbol, file, at);
    touchFile(args.file, 'queried', at);
    if (Array.isArray(args.paths)) for (const path of args.paths.slice(0, 8)) touchFile(path, 'queried', at);
  }

  const rankedFiles = [...files.entries()]
    .sort(([pa, a], [pb, b]) => REASON_RANK[b.best] - REASON_RANK[a.best] || b.hits - a.hits || b.at - a.at || pa.localeCompare(pb))
    .map(([path, v]): WorkingSetFile => ({ path, reason: v.best, hits: v.hits }));
  const rankedSymbols = [...symbols.entries()]
    .sort(([na, a], [nb, b]) => b.hits - a.hits || b.at - a.at || na.localeCompare(nb))
    .map(([name, v]): WorkingSetSymbol => ({ name, path: v.path, hits: v.hits }));
  return {
    files: rankedFiles.slice(0, WORKING_SET_MAX_FILES),
    symbols: rankedSymbols.slice(0, WORKING_SET_MAX_SYMBOLS),
    truncated: {
      files: Math.max(0, rankedFiles.length - WORKING_SET_MAX_FILES),
      symbols: Math.max(0, rankedSymbols.length - WORKING_SET_MAX_SYMBOLS),
    },
  };
}

type ReservedSqlLike = {
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  release(): void;
};
type SqlLike = {
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  reserve?(): Promise<ReservedSqlLike>;
};

/** `tool_invocations.harness_slug` values that attribute a call to NO harness: a
 * harness-less su records `''`, operator-level calls record `'*'`. Those calls stay
 * in every harness's working set; a call attributed to a DIFFERENT harness never
 * does (blind review 35 G-2). */
export const UNATTRIBUTED_TOOL_HARNESS_SLUGS = ['', '*'] as const;

/** Bounded read of the three ledgers for one owner/epoch window. Every ledger is
 * bounded by [windowStart, windowEnd) — the push ledger too, so a long-lived epoch
 * cannot carry pushes older than the window (G-1) — and scoped to `query.harness`. */
export async function readWorkingSetSignals(query: WorkingSetQuery, sql: SqlLike = getOrgPg().sql as unknown as SqlLike,
  statementTimeoutMs = 200): Promise<WorkingSetSignals> {
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', ${`${Math.max(10, Math.floor(statementTimeoutMs))}ms`}, true)`;
    const pushes: { leg: string; subject: string; cited_paths: string[] | null; at: number }[] = await tx`
      SELECT leg, subject, cited_paths, (extract(epoch FROM pushed_at) * 1000)::float8 AS at
      FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${query.workspace} AND owner_id = ${query.owner} AND epoch = ${query.epoch}
        AND pushed_at >= ${query.windowStart} AND pushed_at < ${query.windowEnd}
        AND leg IN ('first-touch', 'interface', 'grep')
      ORDER BY pushed_at DESC LIMIT ${ROW_LIMIT}`;
    const edits: { file: string; at: number }[] = await tx`
      SELECT file, (extract(epoch FROM ts) * 1000)::float8 AS at
      FROM harness_shared.edit_attribution_ledger
      WHERE agent_id = ${query.owner} AND ts >= ${query.windowStart} AND ts < ${query.windowEnd}
        AND workspace_id = ${query.workspace} AND harness_slug = ${query.harness}
      ORDER BY ts DESC LIMIT ${ROW_LIMIT}`;
    const tools: { tool_name: string; args_json: unknown; at: number }[] = await tx`
      SELECT tool_name, args_json, (extract(epoch FROM invoked_at) * 1000)::float8 AS at
      FROM harness_shared.tool_invocations
      WHERE coord_owner_id = ${query.owner} AND invoked_at >= ${query.windowStart} AND invoked_at < ${query.windowEnd}
        AND workspace_id = ${query.workspace} AND tool_name = ANY(${[...WORKING_SET_TOOLS]}::text[])
        AND (harness_slug = ${query.harness} OR harness_slug = ANY(${[...UNATTRIBUTED_TOOL_HARNESS_SLUGS]}::text[]))
      ORDER BY invoked_at DESC LIMIT ${ROW_LIMIT}`;
    return {
      pushes: pushes.map(row => ({ leg: row.leg, subject: row.subject, citedPaths: row.cited_paths ?? [], at: Number(row.at) })),
      edits: edits.map(row => ({ file: row.file, at: Number(row.at) })),
      tools: tools.map(row => ({ tool: row.tool_name, args: row.args_json, at: Number(row.at) })),
    };
  });
}

export interface EpochRow { epoch: number; bumpedAt: Date | null }

export async function readSessionEpoch(owner: string, sql: SqlLike = getOrgPg().sql as unknown as SqlLike): Promise<EpochRow> {
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', '75ms', true)`;
    const rows: { epoch: number; bumped_at: Date | string | null }[] = await tx`
      SELECT epoch, bumped_at FROM harness_shared.memory_session_epochs WHERE session_id = ${owner}`;
    const row = rows[0];
    return { epoch: Number(row?.epoch ?? 0), bumpedAt: row?.bumped_at ? new Date(row.bumped_at) : null };
  });
}

/** The epoch to derive and its ledger window. `current` = the epoch the owner is
 * in now (what a carry document describes); `previous` = the epoch before the
 * last bump (what a fresh epoch resumes from). */
export function workingSetWindow(which: 'current' | 'previous', epoch: EpochRow, now: Date): { epoch: number; start: Date; end: Date } | null {
  const lookback = WORKING_SET_PREVIOUS_EPOCH_LOOKBACK_MS;
  if (which === 'current') {
    const start = epoch.bumpedAt && epoch.bumpedAt.getTime() <= now.getTime() ? epoch.bumpedAt : new Date(now.getTime() - lookback);
    return { epoch: epoch.epoch, start, end: now };
  }
  if (epoch.epoch < 1 || !epoch.bumpedAt) return null;
  return { epoch: epoch.epoch - 1, start: new Date(epoch.bumpedAt.getTime() - lookback), end: epoch.bumpedAt };
}

export interface DeriveWorkingSetInput {
  workspace: string;
  harness: string;
  owner: string;
  which?: 'current' | 'previous';
  /** Registered harness root, used only to relativize absolute tool paths. */
  root?: string;
  now?: Date;
}
export interface DeriveWorkingSetDeps {
  epoch(owner: string): Promise<EpochRow>;
  signals(query: WorkingSetQuery): Promise<WorkingSetSignals>;
}
const defaultDeps: DeriveWorkingSetDeps = {
  epoch: owner => readSessionEpoch(owner),
  signals: query => readWorkingSetSignals(query),
};

/** Derive one owner's working set for its current or previous epoch. Returns
 * null when there is no such epoch (a fresh owner has no previous epoch). */
export async function deriveCodeWorkingSet(input: DeriveWorkingSetInput, deps: DeriveWorkingSetDeps = defaultDeps): Promise<CodeWorkingSet | null> {
  if (!input.owner || !input.workspace || !input.harness) return null;
  const now = input.now ?? new Date();
  const window = workingSetWindow(input.which ?? 'current', await deps.epoch(input.owner), now);
  if (!window) return null;
  const signals = await deps.signals({ workspace: input.workspace, harness: input.harness, owner: input.owner,
    epoch: window.epoch, windowStart: window.start, windowEnd: window.end });
  return {
    owner: input.owner,
    epoch: window.epoch,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    derivedAt: now.toISOString(),
    ...rankCodeWorkingSet(signals, { root: input.root }),
  };
}

/** The compact form stamped on a held work item (`payload.codeWorkingSet`). */
export interface StampedCodeWorkingSet {
  owner: string;
  epoch: number;
  derivedAt: string;
  paths: string[];
  symbols: string[];
}
export function stampableWorkingSet(set: CodeWorkingSet): StampedCodeWorkingSet {
  return { owner: set.owner, epoch: set.epoch, derivedAt: set.derivedAt,
    paths: set.files.map(file => file.path), symbols: set.symbols.map(symbol => symbol.name) };
}

/** P-002/P-004 default for the carry document: the CURRENT epoch's working set in
 * the caller's harness (or the operator home harness for a harness-less su). */
export async function deriveCarryWorkingSet(owner: string, workspace: string, harness: string | null): Promise<CodeWorkingSet | null> {
  const { operatorHomeHarnessSlug } = await import('../harness/operator-home-harness');
  return deriveCodeWorkingSet({ owner, workspace, harness: harness ?? operatorHomeHarnessSlug(), which: 'current' });
}

/** P-004: stamp the set onto each NON-TERMINAL work item this owner still holds
 * (`taken_by = owner`), so whoever holds it next inherits the handles. Returns the
 * stamped ids. A terminal item, or one already taken by someone else, is never
 * rewritten. */
export async function stampCodeWorkingSet(owner: string, workspace: string, set: CodeWorkingSet, itemIds: readonly string[],
  sql: SqlLike = getOrgPg().sql as unknown as SqlLike): Promise<string[]> {
  const ids = [...new Set(itemIds.filter(id => typeof id === 'string' && id))].slice(0, 12);
  if (!owner || !workspace || !ids.length || !set.files.length) return [];
  const { ANY_FAMILY_TERMINAL_STATES } = await import('../work-item-dispatch-states');
  const stamp = stampableWorkingSet(set);
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', '500ms', true)`;
    const rows: { feature_id: string }[] = await tx`
      UPDATE harness_shared.work_items
         SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('codeWorkingSet', ${JSON.stringify(stamp)}::jsonb)
       WHERE workspace_id = ${workspace} AND taken_by = ${owner} AND feature_id = ANY(${ids}::text[])
         AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       RETURNING feature_id`;
    return rows.map(row => row.feature_id).sort();
  });
}

export interface ForeignWorkingSet { itemId: string; stamp: StampedCodeWorkingSet }

/** P-004: working sets stamped by a DIFFERENT owner on items this owner now holds
 * IN THIS HARNESS — a stamp on an item of another harness names paths of another
 * checkout, so it is never inherited (blind review 35 G-3). */
export async function readForeignWorkingSets(owner: string, workspace: string, harness: string,
  sql: SqlLike = getOrgPg().sql as unknown as SqlLike, statementTimeoutMs = 75,
  onTiming?: (phase: string, elapsedMs: number) => void): Promise<ForeignWorkingSet[]> {
  if (!owner || !workspace || !harness) return [];
  const { ANY_FAMILY_TERMINAL_STATES } = await import('../work-item-dispatch-states');
  const read = async (tx: any): Promise<ForeignWorkingSet[]> => {
    const timeoutStarted = Date.now();
    await tx`SELECT set_config('statement_timeout', ${`${Math.max(10, Math.floor(statementTimeoutMs))}ms`}, true)`;
    onTiming?.('setTimeout', Date.now() - timeoutStarted);
    const queryStarted = Date.now();
    const rows: { feature_id: string; stamp: unknown }[] = await tx`
      SELECT feature_id, payload -> 'codeWorkingSet' AS stamp FROM harness_shared.work_items
       WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND taken_by = ${owner}
         AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
         AND jsonb_typeof(payload -> 'codeWorkingSet') = 'object'
         AND payload -> 'codeWorkingSet' ->> 'owner' IS DISTINCT FROM ${owner}
       ORDER BY feature_id DESC LIMIT 4`;
    onTiming?.('select', Date.now() - queryStarted);
    const parseStarted = Date.now();
    const result = rows.flatMap(row => {
      const stamp = parseStampedWorkingSet(row.stamp);
      return stamp && stamp.owner !== owner ? [{ itemId: row.feature_id, stamp }] : [];
    });
    onTiming?.('parse', Date.now() - parseStarted);
    return result;
  };
  if (sql.reserve) {
    const acquireStarted = Date.now();
    const conn = await sql.reserve().finally(() => onTiming?.('poolAcquire', Date.now() - acquireStarted));
    const transactionStarted = Date.now();
    try {
      const result = await conn.begin(async tx => {
        onTiming?.('beginCallbackEntry', Date.now() - transactionStarted);
        return read(tx);
      });
      onTiming?.('transactionTotal', Date.now() - transactionStarted);
      return result;
    } finally {
      conn.release();
    }
  }
  const transactionStarted = Date.now();
  const result = await sql.begin(async tx => {
    onTiming?.('beginCallbackEntry', Date.now() - transactionStarted);
    return read(tx);
  });
  onTiming?.('transactionTotal', Date.now() - transactionStarted);
  return result;
}

/** Validate a stamp read back from a work-item payload. */
export function parseStampedWorkingSet(value: unknown): StampedCodeWorkingSet | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record || typeof record.owner !== 'string' || !record.owner || !Array.isArray(record.paths)) return null;
  const paths = record.paths.filter(isCodeWorkingSetPath).slice(0, WORKING_SET_MAX_FILES);
  const symbols = Array.isArray(record.symbols)
    ? record.symbols.filter((name): name is string => typeof name === 'string' && name.length <= 120 && SYMBOL_RE.test(name)).slice(0, WORKING_SET_MAX_SYMBOLS)
    : [];
  return { owner: record.owner, epoch: Number(record.epoch) || 0, derivedAt: typeof record.derivedAt === 'string' ? record.derivedAt : '',
    paths, symbols };
}
