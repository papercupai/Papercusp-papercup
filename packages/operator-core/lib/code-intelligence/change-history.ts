/** P013/R9: bounded commit co-change and edit-time ledger provenance.
 * Commit authorship is intentionally never read. Counts concern eligible commits,
 * and Edit provenance requires a unique session and assignment at the edit instant.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Sql } from 'postgres';
import * as ts from 'typescript';
import { getOrgPg } from '@papercusp/db-org';
import { safeHistoryPath as safe } from './history-path';
import { hunksFromToolCall } from '../release/frozen-repair-edit-ledger';
import { measureCodeHealth } from './code-health';
import { symbolSpans } from './edited-symbols';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';
import { registerReuseBriefProvider } from './reuse-brief-providers';
import { queryWarmCoChange } from './warm-cochange-index';
import { coChangeFromCommits, readHistoryCommits, type CoChangeReport } from './cochange-index';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
export const PROVENANCE_EDIT_CAP = 50;
export { eligibleHistoryPath } from './history-path';
// The window read and index live in the dependency-free leaf so the resident index worker can
// bundle them without this module's provenance dependencies (WI-6554700010030353).
export {
  CHANGE_HISTORY_VERSION, FULL_WINDOW_HISTORY_BOUNDS, IN_PROCESS_HISTORY_BOUNDS,
  buildCoChangeIndex, coChangeFromCommits, coChangeFromIndex, parseHistoryLog, readHistoryCommits,
  type CoChangeIndex, type CoChangePair, type CoChangeReport, type HistoryCommit, type HistoryReadBounds,
} from './cochange-index';

/** Full commit file lists, never a pathspec-pruned log (which would hide partners). */
export async function readCoChange(root: string, paths: readonly string[], end = new Date().toISOString(), signal?: AbortSignal): Promise<CoChangeReport> {
  const empty = () => coChangeFromCommits({ commits: [], paths, end, commit: null, complete: false });
  try {
    if (!paths.length || paths.length > 50 || !paths.every(safe)) throw new Error('History requires 1–50 exact repo-relative paths');
    const { commits, commit, complete } = await readHistoryCommits(root, end, signal);
    return coChangeFromCommits({ commits, paths, end, commit, complete });
  } catch (error) { return { ...empty(), error: error instanceof Error ? error.message : 'Commit history unavailable' }; }
}

/** WI-6554700010030353: the same report, answered by the resident full-window index
 * (warm-cochange-index.ts) instead of a capped in-process read. On this repository the in-process
 * read can never be complete (the window is ~37k commits) and takes longer than the brief deadline;
 * the resident index answers in ~25 ms. A miss (not warm yet, built at another commit, deadline) is
 * the empty report with the miss as `error`, so the brief records why it is unknown. */
export async function readWarmCoChange(root: string, paths: readonly string[], end = new Date().toISOString(), signal?: AbortSignal): Promise<CoChangeReport> {
  const empty = (error: string) => ({ ...coChangeFromCommits({ commits: [], paths, end, commit: null, complete: false }), error });
  if (!paths.length || paths.length > 50 || !paths.every(safe)) return empty('History requires 1–50 exact repo-relative paths');
  const answer = await queryWarmCoChange(root, paths, signal);
  return 'report' in answer ? answer.report : empty(answer.error);
}
export interface ProvenanceAssignment { workItem: string; owner: string; start: string; end: string | null; complete: boolean }
export interface ProvenanceEdit {
  invocation: string; at: string; owner: string | null; session: string | null;
  sessionOwners: string[]; tool: string; input: unknown; status: string;
}
export interface SymbolProvenance {
  path: string; symbol: string; contentHash: string; start: number; end: number;
  status: 'measured' | 'unknown'; workItem: string | null;
  edits: { invocation: string; session: string; owner: string; workItem: string; at: string }[];
  reason: string;
  /** Historical label evidence does not establish continuity with the current range. */
  recordedHistory?: RecordedSymbolHistory;
}
export interface LedgerProvenanceEdit {
  id: string; at: string; owner: string; session: string | null;
  workItem: string | null; symbols: string[] | null;
  /** Session context recorded for an edit with no work item. Never a work-item attribution. */
  fallback?: { intent: string | null; planSlug: string | null };
}
export interface RecordedSymbolHistory {
  symbol: string; status: 'measured' | 'unknown'; workItems: string[];
  edits: LedgerProvenanceEdit[]; currentIdentity: 'unknown';
}
export interface SymbolProvenanceReport {
  status: 'measured' | 'unknown'; symbols: SymbolProvenance[];
  history: RecordedSymbolHistory[]; fileEdits: LedgerProvenanceEdit[];
  truncated: boolean; symbolStatus: 'measured' | 'unknown'; limitations: string[];
}
const normalizedPath = (root: string, path: string) => {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return safe(rel) ? rel : null;
};

/** Match an edit's resulting bytes to one unique current range. Never guess from name alone. */
export function symbolProvenance(input: { root: string; path: string; source: string; name?: string;
  edits: readonly ProvenanceEdit[]; assignments: readonly ProvenanceAssignment[]; complete: boolean }): SymbolProvenance[] {
  const sf = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true,
    input.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const health = measureCodeHealth(ts, sf, input.path);
  return health.functions.filter(fn => !input.name || fn.name === input.name).map(fn => {
    const evidence: SymbolProvenance['edits'] = [];
    let ambiguous = !input.complete || health.status !== 'measured';
    for (const edit of input.edits) {
      if (edit.status !== 'ok') continue;
      const hunks = hunksFromToolCall(edit.tool.replace(':', '_'), edit.input);
      for (const h of hunks) {
        if (normalizedPath(input.root, h.path) !== input.path) continue;
        const text = h.hunk.kind === 'write' ? h.hunk.body : h.hunk.kind === 'edit' ? h.hunk.new : null;
        if (!text) { ambiguous = true; continue; }
        const start = input.source.indexOf(text);
        if (start < 0 || input.source.indexOf(text, start + 1) >= 0) { ambiguous = true; continue; }
        if (start >= fn.end || start + text.length <= fn.start) continue;
        const at = Date.parse(edit.at);
        const assignments = input.assignments.filter(a => a.owner === edit.owner && a.complete
          && Date.parse(a.start) <= at && (!a.end || at < Date.parse(a.end)));
        const items = [...new Set(assignments.map(a => a.workItem))];
        const owners = [...new Set(edit.sessionOwners)];
        if (!edit.owner || !edit.session || owners.length !== 1 || owners[0] !== edit.owner || items.length !== 1) {
          ambiguous = true; continue;
        }
        if (!evidence.some(e => e.invocation === edit.invocation)) evidence.push({ invocation: edit.invocation,
          session: edit.session, owner: edit.owner, workItem: items[0]!, at: edit.at });
      }
    }
    evidence.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.invocation.localeCompare(b.invocation));
    const status = evidence.length && !ambiguous ? 'measured' as const : 'unknown' as const;
    return { path: input.path, symbol: fn.name, contentHash: fn.contentHash, start: fn.start, end: fn.end,
      status, workItem: status === 'measured' ? evidence[0]!.workItem : null, edits: evidence,
      reason: status === 'measured' ? 'Successful edit → exact session owner → unique assignment interval → current blob/range.'
        : 'Missing, stale, ambiguous or partial edit/session/assignment evidence; git authorship is not a substitute.' };
  });
}

/** Read labels as recorded, never reconstruct historical identity from today's AST. */
export function ledgerSymbolProvenance(input: { path: string; source: string; name?: string;
  rows: readonly LedgerProvenanceEdit[]; complete: boolean }): SymbolProvenanceReport {
  const sf = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true,
    input.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const health = measureCodeHealth(ts, sf, input.path);
  const rows = input.rows.slice(0, PROVENANCE_EDIT_CAP);
  const truncated = input.rows.length > PROVENANCE_EDIT_CAP || !input.complete;
  const complete = !truncated && health.status === 'measured';
  const labels = [...new Set(rows.flatMap(row => row.symbols ?? []))]
    .filter(label => !input.name || label === input.name).sort();
  const history: RecordedSymbolHistory[] = labels.map(symbol => {
    const edits = rows.filter(row => row.symbols?.includes(symbol));
    return { symbol, status: complete && edits.every(row => Boolean(row.workItem)) ? 'measured' : 'unknown',
      workItems: [...new Set(edits.flatMap(row => row.workItem ? [row.workItem] : []))], edits, currentIdentity: 'unknown' };
  });
  const symbols = health.functions.filter(fn => !input.name || fn.name === input.name).map(fn => ({
    path: input.path, symbol: fn.name, contentHash: fn.contentHash, start: fn.start, end: fn.end,
    status: 'unknown' as const, workItem: null, edits: [],
    recordedHistory: history.find(record => record.symbol === fn.name),
    reason: 'Edit-time labels are historical evidence only; current blob/range continuity is unknown.' }));
  return { status: complete ? 'measured' : 'unknown', symbols, history, fileEdits: rows, truncated,
    symbolStatus: complete && rows.every(row => row.symbols !== null && Boolean(row.workItem)) ? 'measured' : 'unknown',
    limitations: ['Work items and symbol labels were recorded at edit time, independently of current claims.',
      'Labels do not prove current identity across rename, move, overload, nesting or later edits.',
      'NULL symbol capture is unknown file-level evidence; [] means measured top-level only.',
      'An edit with no work item stays unattributed; its fallback intent/plan is session context only.',
      ...(truncated ? ['Provenance is truncated at 50 edit rows; history is incomplete.'] : []),
      ...(health.status !== 'measured' ? health.limitations : [])] };
}

/** Indexed, bounded ledger read; no invocation scan or current-holder join. */
export async function readSymbolProvenance(input: { workspaceId: string; harness: string; root: string; path: string;
  name?: string; since?: string }, sql: Sql = getOrgPg().sql): Promise<SymbolProvenanceReport> {
  if (!input.workspaceId || !input.harness || !safe(input.path)) throw new Error('Exact workspace/harness/path required');
  try {
    const root = await realpath(input.root), file = await realpath(resolve(root, input.path));
    if (normalizedPath(root, file) !== input.path) throw new Error('Path escapes registered repository');
    const source = await readFile(file, 'utf8');
    const since = input.since ?? new Date(Date.now() - 90 * DAY).toISOString();
    if (!Number.isFinite(Date.parse(since))) throw new Error('Invalid provenance window');
    const rows = await sql.begin(async tx => {
      await tx`SELECT set_config('statement_timeout', '500ms', true)`;
      return tx<{ id: string; ts: string; agent_id: string; session_id: string | null;
        work_item_id: string | null; symbols: string[] | null; intent: string | null; plan_slug: string | null }[]>`
        SELECT id::text, ts, agent_id, session_id, work_item_id, symbols, intent, plan_slug
        FROM harness_shared.edit_attribution_ledger
        -- harness_slug is stamped only when the writer resolves a work item, so an
        -- unattributed edit carries NULL; repo_root + file already scope the row.
        WHERE workspace_id = ${input.workspaceId}
          AND (harness_slug = ${input.harness} OR harness_slug IS NULL)
          AND repo_root = ${root} AND file = ${input.path} AND ts >= ${since}::timestamptz
          AND (${input.name ?? null}::text IS NULL OR symbols IS NULL OR symbols @> ${input.name ? [input.name] : []}::text[])
        ORDER BY ts DESC, id DESC LIMIT ${PROVENANCE_EDIT_CAP + 1}`;
    });
    return ledgerSymbolProvenance({ path: input.path, source, name: input.name,
      rows: rows.map(row => ({ id: row.id, at: new Date(row.ts).toISOString(), owner: row.agent_id,
        session: row.session_id, workItem: row.work_item_id, symbols: row.symbols,
        // SPEC-P-010-B: an unattributed edit shows the session's recorded intent/plan as
        // context beside workItem: null; it never enters workItems or the measured status.
        ...(!row.work_item_id && (row.intent || row.plan_slug)
          ? { fallback: { intent: row.intent, planSlug: row.plan_slug } } : {}) })),
      complete: source === await readFile(file, 'utf8') });
  } catch (error) { return { status: 'unknown', symbols: [], history: [], fileEdits: [], truncated: false, symbolStatus: 'unknown', limitations: [
    error instanceof Error ? error.message : 'Provenance ledger unavailable'] }; }
}

/** code-intel-delivery-and-outcomes-2026-10-26 P-008: prior work on the functions a
 * session touches, from the edit-time ledger's `symbols` (P-007). One reader serves the
 * first-touch push note and the claim brief's provenance section. Ranking: bugs and
 * decisions first, then the most recent edit of the symbol, ties by most recent close. */
export const PRIOR_WORK_CAP = 3;
export const PRIOR_WORK_WINDOW_DAYS = 90;
/** Distinct (work item, capture) groups read per query; beyond this the total is a floor. */
export const PRIOR_WORK_GROUP_CAP = 200;
const PRIORITY_KINDS = new Set(['bug', 'decision']);
export interface PriorWorkItem {
  workItem: string; title: string; state: string; kind: string | null;
  lastEditAt: string; closedAt: string | null; symbols: readonly string[];
}
/** One grouped ledger read row. `visible` = the reader's workspace holds the item;
 * `measured` = the edits carried symbol capture (NULL capture is file-level evidence). */
export interface PriorWorkLedgerRow extends PriorWorkItem { visible: boolean; measured: boolean }
export interface PriorWorkReport {
  status: 'measured' | 'unknown'; path: string;
  /** Touched symbols; `null` = the touched symbol could not be resolved. */
  names: readonly string[] | null;
  items: PriorWorkItem[]; total: number;
  /** Items whose edits to this file predate symbol capture, so may or may not touch `names`. */
  fileLevel: PriorWorkItem[]; fileLevelTotal: number;
  truncated: boolean; error: string | null;
}
export interface PriorWorkQuery {
  workspaceId: string; root: string; path: string; names: readonly string[] | null;
  /** The reader's own claimed item, which is current work, not prior work. */
  excludeWorkItem?: string | null; since?: string;
}
export type PriorWorkReader = (query: PriorWorkQuery) => Promise<PriorWorkReport>;

/** One entry per work item however many ledger rows name it, ranked and capped. */
export function rankPriorWork(rows: readonly PriorWorkItem[], cap = PRIOR_WORK_CAP): { items: PriorWorkItem[]; total: number } {
  const merged = new Map<string, PriorWorkItem>();
  for (const row of rows) {
    const prev = merged.get(row.workItem);
    const item: PriorWorkItem = { workItem: row.workItem, title: row.title, state: row.state, kind: row.kind,
      lastEditAt: row.lastEditAt, closedAt: row.closedAt, symbols: [...new Set(row.symbols)].sort() };
    merged.set(row.workItem, !prev ? item : { ...prev,
      lastEditAt: Date.parse(item.lastEditAt) > Date.parse(prev.lastEditAt) ? item.lastEditAt : prev.lastEditAt,
      symbols: [...new Set([...prev.symbols, ...item.symbols])].sort() });
  }
  const closed = (row: PriorWorkItem) => row.closedAt ? Date.parse(row.closedAt) : -1;
  const ordered = [...merged.values()].sort((a, b) =>
    Number(PRIORITY_KINDS.has(b.kind ?? '')) - Number(PRIORITY_KINDS.has(a.kind ?? ''))
    || Date.parse(b.lastEditAt) - Date.parse(a.lastEditAt)
    || closed(b) - closed(a) || a.workItem.localeCompare(b.workItem));
  return { items: ordered.slice(0, Math.max(0, cap)), total: ordered.length };
}

/** Items the reader may not see are dropped before ranking, so they are in neither the list nor the count. */
export function priorWorkReport(input: { path: string; names: readonly string[] | null;
  rows: readonly PriorWorkLedgerRow[]; truncated: boolean }): PriorWorkReport {
  const visible = input.rows.filter(row => row.visible && row.workItem);
  const measured = input.names === null ? [] : visible.filter(row => row.measured);
  const ranked = rankPriorWork(measured);
  const measuredItems = new Set(measured.map(row => row.workItem));
  const file = rankPriorWork(visible.filter(row => !measuredItems.has(row.workItem)));
  return { status: input.names === null || (!ranked.total && file.total) ? 'unknown' : 'measured',
    path: input.path, names: input.names, items: ranked.items, total: ranked.total,
    fileLevel: file.items, fileLevelTotal: file.total, truncated: input.truncated, error: null };
}

const clipTitle = (title: string) => title.length > 60 ? `${title.slice(0, 59)}…` : title;
function priorWorkAge(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  return ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m`
    : ms < DAY ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / DAY)}d`;
}
export function priorWorkPointer(path: string, names: readonly string[] | null, harness: string): string {
  return `graph:query ${JSON.stringify({ op: 'provenance', file_path: path,
    ...(names?.length === 1 ? { name: names[0] } : {}), harnesses: [harness] })}`;
}

/** The single prior-work line, or null when there is nothing to say: zero prior rows,
 * no named symbol touched, or a failed read (a failed read never renders as absence). */
export function formatPriorWorkLine(report: PriorWorkReport, opts: { harness: string; now?: number }): string | null {
  if (report.error || (report.names !== null && !report.names.length)) return null;
  const now = opts.now ?? Date.now();
  const label = report.names === null ? `\`${report.path}\``
    : report.names.length <= 3 ? report.names.map(name => `\`${name}\``).join(', ')
      : `\`${report.path}\` (${report.names.length} functions)`;
  const list = (items: readonly PriorWorkItem[]) => items.map(item =>
    `${item.workItem} (${clipTitle(item.title)}, ${item.state}, ${priorWorkAge(item.lastEditAt, now)})`).join('; ');
  const more = `more: ${priorWorkPointer(report.path, report.names, opts.harness)}`;
  const floor = report.truncated ? '+' : '';
  // The total and the recovery pointer are printed only when the line omits something: the
  // note shares a bounded brief/push budget, so a complete list carries no tail.
  if (report.total) {
    const omitted = report.total > report.items.length || report.truncated || report.fileLevelTotal > 0;
    const fileLevel = report.fileLevelTotal ? `; +${report.fileLevelTotal}${floor} file-level without symbol capture` : '';
    return `Prior work on ${label}: ${list(report.items)}.`
      + (omitted ? ` ${report.total}${floor} total${fileLevel}; ${more}` : '');
  }
  if (!report.fileLevelTotal) return null;
  const why = report.names === null ? 'touched symbol not resolved' : 'earlier edits have no symbol capture';
  const omitted = report.fileLevelTotal > report.fileLevel.length || report.truncated;
  return `Prior work on ${label}: unknown (${why}); file-level: ${list(report.fileLevel)}.`
    + (omitted ? ` ${report.fileLevelTotal}${floor} total; ${more}` : '');
}

/** Indexed, bounded read: one grouped row per (work item, capture), visibility by workspace join. */
export async function readPriorWork(query: PriorWorkQuery, sql: Sql = getOrgPg().sql): Promise<PriorWorkReport> {
  const failed = (error: string): PriorWorkReport => ({ status: 'unknown', path: query.path, names: query.names,
    items: [], total: 0, fileLevel: [], fileLevelTotal: 0, truncated: false, error });
  if (!query.workspaceId || !query.root || !safe(query.path)) return failed('Exact workspace/root/path required');
  if (query.names && !query.names.length) return priorWorkReport({ path: query.path, names: [], rows: [], truncated: false });
  try {
    const root = await realpath(query.root);
    const since = query.since ?? new Date(Date.now() - PRIOR_WORK_WINDOW_DAYS * DAY).toISOString();
    if (!Number.isFinite(Date.parse(since))) throw new Error('Invalid prior-work window');
    const names = query.names ? [...query.names] : null;
    const rows = await sql.begin(async tx => {
      await tx`SELECT set_config('statement_timeout', '75ms', true)`;
      return tx<{ work_item: string; visible: boolean; title: string | null; state: string | null; kind: string | null;
        closed_at: Date | string | null; last_edit_at: Date | string; measured: boolean; symbols: string[] }[]>`
        SELECT e.work_item_id AS work_item, (w.feature_id IS NOT NULL) AS visible, left(w.title, 120) AS title,
          w.status AS state, COALESCE(w.item_kind, w.kind) AS kind, w.closed_ts AS closed_at,
          max(e.ts) AS last_edit_at, (e.symbols IS NOT NULL) AS measured,
          COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS symbols
        FROM harness_shared.edit_attribution_ledger e
        LEFT JOIN harness_shared.work_items w ON w.workspace_id = e.workspace_id AND w.feature_id = e.work_item_id
        LEFT JOIN LATERAL unnest(e.symbols) AS s(name) ON s.name = ANY(${names}::text[])
        WHERE e.workspace_id = ${query.workspaceId} AND e.repo_root = ${root} AND e.file = ${query.path}
          AND e.ts >= ${since}::timestamptz AND e.work_item_id IS NOT NULL
          AND e.work_item_id IS DISTINCT FROM ${query.excludeWorkItem ?? null}
          AND (${names}::text[] IS NULL OR e.symbols IS NULL OR e.symbols && ${names}::text[])
        GROUP BY e.work_item_id, w.feature_id, w.title, w.status, w.item_kind, w.kind, w.closed_ts, (e.symbols IS NOT NULL)
        ORDER BY max(e.ts) DESC, e.work_item_id
        LIMIT ${PRIOR_WORK_GROUP_CAP + 1}`;
    });
    const iso = (value: Date | string) => new Date(value).toISOString();
    return priorWorkReport({ path: query.path, names: query.names, truncated: rows.length > PRIOR_WORK_GROUP_CAP,
      rows: rows.slice(0, PRIOR_WORK_GROUP_CAP).map(row => ({ workItem: row.work_item, visible: row.visible,
        title: row.title ?? '', state: row.state ?? 'unknown', kind: row.kind, measured: row.measured,
        lastEditAt: iso(row.last_edit_at), closedAt: row.closed_at ? iso(row.closed_at) : null, symbols: row.symbols ?? [] })) });
  } catch (error) { return failed(error instanceof Error ? error.message : 'Prior-work ledger unavailable'); }
}

/** Every function/class name in a file, derived from its current source (the claim brief's symbols). */
export function fileSymbolNames(path: string, source: string): string[] | null {
  const spans = symbolSpans(path, source);
  return spans ? [...new Set(spans.map(span => span.name))].sort() : null;
}

export function coChangeOverlap(report: CoChangeReport, tasks: readonly { itemId: string; paths: readonly string[] }[]) {
  return { status: report.status, pairs: report.pairs.flatMap(pair => tasks.flatMap(a => tasks.filter(b => a.itemId < b.itemId
    && (a.paths.includes(pair.path) && b.paths.includes(pair.partner) || a.paths.includes(pair.partner) && b.paths.includes(pair.path)))
    .map(b => ({ items: [a.itemId, b.itemId], paths: [pair.path, pair.partner], shared: pair.shared, union: pair.union })))),
  unanchored: report.pairs.filter(p => !tasks.some(task => task.paths.includes(p.partner))).map(p => p.partner),
  limitations: report.limitations };
}

/** P009 provider seam: the caller supplies the shared registered repository resolver.
 * P-008: the provenance section is the prior-work reader the first-touch note uses. */
export function changeHistoryProviders(deps: {
  harness?: string;
  cochange(context: Readonly<ReuseProviderContext>, signal: AbortSignal): Promise<CoChangeReport>;
  provenance(context: Readonly<ReuseProviderContext>, signal: AbortSignal): Promise<PriorWorkReport[]>;
}): ReuseBriefProvider[] {
  return [{ id: 'cochange', read: async (ctx, signal) => {
    const report = await deps.cochange(ctx, signal);
    const measured = report.status === 'measured' && report.commit !== null && report.commit === ctx.commit && Boolean(ctx.sourceVersion);
    return { status: measured ? 'measured' : 'unknown', sourceVersion: measured ? ctx.sourceVersion : null,
      indexVersion: report.version.slice(0, 12), citedPaths: report.pairs.flatMap(p => [p.path, p.partner]),
      lines: measured ? report.pairs.filter(p => !ctx.paths.includes(p.partner)).slice(0, 3)
        .map(p => `${ctx.surface === 'completion' ? 'Untouched' : 'Unanchored'} ${p.partner} (${p.shared}/${p.union};90d)`) : [] };
  } }, { id: 'provenance', read: async (ctx, signal) => {
    const reports = await deps.provenance(ctx, signal);
    // A completed read is measured even when a file's line is an explicit unknown; a failed one never is.
    const measured = Boolean(ctx.sourceVersion) && reports.length > 0 && reports.every(report => !report.error);
    const harness = deps.harness ?? ctx.repository?.harness ?? 'unknown';
    return { status: measured ? 'measured' : 'unknown', sourceVersion: measured ? ctx.sourceVersion : null,
      indexVersion: digest(JSON.stringify(reports)).slice(0, 12), citedPaths: reports.map(report => report.path),
      lines: measured ? reports.flatMap(report => formatPriorWorkLine(report, { harness }) ?? []).slice(0, 3) : [] };
  } }];
}

/** P010 owns authoring/completion delivery; install these producers at its P009 seam. */
export function registerChangeHistoryProviders(deps: Parameters<typeof changeHistoryProviders>[0]): () => void {
  const remove: (() => void)[] = [];
  try { for (const provider of changeHistoryProviders(deps)) remove.push(registerReuseBriefProvider(provider)); }
  catch (error) { for (const dispose of remove.reverse()) dispose(); throw error; }
  return () => { for (const dispose of remove.reverse()) dispose(); };
}

/** Production binding to the same source fingerprint used by task-brief. No side index. */
export function boundChangeHistoryProviders(input: {
  root: () => Promise<string | null>; harness: string;
  /** Injectable for tests; production reads the edit-attribution ledger. */
  priorWork?: PriorWorkReader;
}): ReuseBriefProvider[] {
  const current = async (ctx: Readonly<ReuseProviderContext>, signal: AbortSignal) => {
    const root = await input.root();
    if (!root || signal.aborted || !ctx.paths.length || !ctx.paths.every(safe)) throw new Error('History source unavailable');
    const sources: [string, string][] = [];
    for (const path of ctx.paths) {
      const file = await realpath(resolve(root, path));
      if (normalizedPath(await realpath(root), file) !== path) throw new Error('History source escapes repository');
      sources.push([path, digest(await readFile(file, 'utf8'))]);
    }
    if (signal.aborted || digest(JSON.stringify(sources)) !== ctx.sourceVersion) throw new Error('History source fingerprint changed');
    return root;
  };
  const priorWork = input.priorWork ?? (query => readPriorWork(query));
  return changeHistoryProviders({
    harness: input.harness,
    cochange: async (ctx, signal) => {
      const root = await current(ctx, signal);
      const report = await readWarmCoChange(root, ctx.paths, undefined, signal);
      await current(ctx, signal);
      return report;
    },
    // Symbols come from the item's files as they are at claim time, never from a declared list.
    provenance: async (ctx, signal) => {
      const root = await current(ctx, signal);
      const reports = await Promise.all(ctx.paths.filter(path => /\.[cm]?[jt]sx?$/.test(path)).slice(0, 4).map(async path => {
        const names = fileSymbolNames(path, await readFile(resolve(root, path), 'utf8'));
        return priorWork({ workspaceId: ctx.workspaceId, root, path, names, excludeWorkItem: ctx.workItem ?? null });
      }));
      await current(ctx, signal);
      if (signal.aborted) throw new Error('Prior-work read aborted');
      return reports;
    },
  });
}
