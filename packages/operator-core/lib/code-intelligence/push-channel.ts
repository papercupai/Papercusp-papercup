/** P-034/D-016: one code-intelligence leg at the existing PostToolBatch sink. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { snapshotCloneLeg } from './clone-advisory';
import { AGENT_ANTIPATTERN_RULES } from './agent-antipatterns';
import { formatPriorWorkLine, readPriorWork, type PriorWorkReader, type PriorWorkReport } from './change-history';
import { symbolSpans } from './edited-symbols';
import { getActiveClaimForOwner } from '../work-item-claims';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { withBoundedTimeout } from '../bounded-timeout';
import { loadHarnessRegistry } from '../harness-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { interfaceSignatureEdits, readInterfacePeerContext, type InterfacePeerContext } from './peer-edit-impact';
import type { TaskBrief } from './task-brief';
import { shellSearchPatterns } from './native-adoption';
import { corroboratePushSources, peekPushSnapshot, safeSnapshotPath, type PushProofSource, type PushSnapshot, type SnapshotSymbol } from './push-snapshot';
import { FACT_FILE_ANCHOR_PREFIX, foldCodeNotesForPaths, isCodeNoteKey, isFactFileAnchor, type AgentFact } from '../agent-facts/store';
import type { FactDependencyStaleness } from '../agent-tools/facts/dependency-staleness';
import {
  deriveCodeWorkingSet, readForeignWorkingSets, readSessionEpoch, readWorkingSetSignals,
  type EpochRow, type ForeignWorkingSet, type WorkingSetQuery, type WorkingSetReason, type WorkingSetSignals,
} from './working-set';

/** Code intelligence's own per-turn budget (code-intel-delivery-and-outcomes-2026-10-26 P-005,
 * R-5). Reserved: memory recall and the other mid-turn blocks never draw on it. */
export const CODE_INTEL_PUSH_TURN_CHARS = 1_500;
/** P-005 / R-5 D-003: one rendered push, header and pointer included. A push still over it
 * after formatPushFact keeps only whole lines is dropped whole (skip site `push-cap`). */
export const CODE_INTEL_PUSH_MAX_CHARS = 500;
export const CODE_INTEL_PUSH_WALL_MS = 250;
/** WI-6554700010030085: the end of the wall held back for the commit. Gathering stops at
 * CODE_INTEL_PUSH_WALL_MS minus this, so the facts already gathered reach the ledger. */
export const CODE_INTEL_PUSH_COMMIT_RESERVE_MS = 90;
export const PUSH_LEG_FLAGS = {
  grep: FLAGS.CODE_INTEL_PUSH_GREP, 'first-touch': FLAGS.CODE_INTEL_PUSH_FIRST_TOUCH,
  interface: FLAGS.CODE_INTEL_PUSH_INTERFACE, incident: FLAGS.CODE_INTEL_PUSH_INCIDENT,
  completion: FLAGS.CODE_INTEL_PUSH_COMPLETION,
  clone: FLAGS.CODE_INTEL_PUSH_FIRST_TOUCH,
  // Active with the existing structural capability; no default-off feature gate.
  antipattern: FLAGS.CODE_INTEL_AST_GREP,
  // No registered hook leg: this flag gates the task brief coord:declare-intent returns for
  // current_files (declare-intent.ts -> task-brief.ts getIntentTimeTaskBrief), recorded by
  // recordIntentTaskBrief (WI-6554700010018439).
  intent: FLAGS.CODE_INTEL_PUSH_INTENT,
  resume: FLAGS.CODE_INTEL_PUSH_RESUME, notes: FLAGS.CODE_INTEL_PUSH_NOTES,
} as const;
export type PushLegId = keyof typeof PUSH_LEG_FLAGS;
export interface PushCall { tool?: string; toolInput?: unknown; toolResponse?: unknown; incidentResult?: unknown; interfaceEdit?: unknown; interfaceEdits?: unknown[]; antipatternEdits?: unknown[]; cloneEdits?: unknown[] }
export interface PushInput {
  owner: string; workspace: string; harness?: string; client?: string;
  /** Populated only from the registered harness root, never request cwd. */
  root?: string;
  firstTouchContext?: FirstTouchContext;
  /** Optional bounded ledger attribution for the incident leg. */
  incidentAttribution?: IncidentAttribution;
  /** Carried working-set files, read before the resume leg runs. */
  resumeContext?: ResumeContext;
  /** Code notes anchored to first-touched files, read before the notes leg runs. */
  notesContext?: NotesContext;
  interfacePeerContext?: InterfacePeerContext;
  calls: readonly PushCall[];
}
export interface FirstTouchContext {
  docs: readonly string[] | null;
  specs: readonly string[] | null;
  locks: readonly LiveLockHolding[] | null;
  byPath?: Readonly<Record<string, { docs: readonly string[]; specs: readonly string[] }>>;
  /** P-008: prior work on the symbols this batch touched. */
  priorWork?: PriorWorkContext | null;
}
export interface PushFact {
  leg: PushLegId;
  /** Identifies the fact, not the request; compaction makes it eligible again. */
  subject: string;
  text: string;
  citedPaths: readonly string[];
  suggestedCall?: string;
  sourceHashes?: readonly PushProofSource[];
  /** A self-contained one-line note, rendered without the snapshot header. */
  bare?: boolean;
}
/** WI-6554700010018440: a fact dropped whole for budget, recorded in code_intel_push_skips.
 * `request-budget` = the request's share (1,500 minus the memory block) was strictly the
 * binding limit; `turn-budget` = the turn's own code-intel spend was (including a tie,
 * where memory took nothing and code intelligence filled the turn itself).
 * WI-6554700010030085: `wall` = an enabled leg the push wall stopped before it ran
 * (subject `leg-not-run:<leg>`, chars 0), so "produced nothing" and "never ran" differ.
 * WI-6554700010029479: `push-cap` = the rendered push exceeded CODE_INTEL_PUSH_MAX_CHARS.
 * Memory recall no longer shares the budget, so new rows are never `request-budget`. */
interface PushSkip {
  leg: PushLegId;
  subject: string;
  chars: number;
  budgetLeft: number;
  site: 'request-budget' | 'turn-budget' | 'wall' | 'push-cap';
}
/** Measured attribution supplied by the incident caller. Static reach alone is
 * never upgraded to a change or work-item claim; callers must provide these
 * rows from a bounded, current ledger read. */
export interface IncidentAttribution {
  status: 'measured' | 'unknown';
  changedSymbols?: readonly string[];
  workItems?: readonly { id: string; state: string; title?: string; paths: readonly string[]; relation?: 'file-edit-ledger' | 'open-on-path' }[];
  recentEdits?: readonly { root: string; path: string; base: string; workspace: string; harness: string;
    agentId: string; at: number; beforeSha256: string; sha256: string; symbols: readonly { name: string; line: number }[] }[];
}

/** Reuse the edit-time WI authority. A file lock is not a symbol-change
 * measurement: only locally compared, still-current source hashes name symbols.
 * Old serving-checkout repo_root values are deliberately not used as a join key.
 */
export async function readPushIncidentAttribution(input: PushInput, paths: string[], sql = getOrgPg().sql): Promise<IncidentAttribution> {
  const changedSymbols: string[] = [];
  for (const row of (input.incidentAttribution?.recentEdits ?? []).slice(0, 8)) {
    if (!row || row.root !== input.root || row.workspace !== input.workspace || row.harness !== input.harness
      || row.agentId !== input.owner || !paths.includes(row.path) || !safeSnapshotPath(row.path)
      || !Number.isFinite(row.at) || row.at > Date.now() || Date.now() - row.at >= 86_400_000
      || !/^[a-f0-9]{40,64}$/i.test(row.base) || !/^[a-f0-9]{64}$/i.test(row.beforeSha256)
      || row.beforeSha256 === row.sha256 || !Array.isArray(row.symbols)
      || !await corroboratePushSources(input.root, [{ path: row.path, sha256: row.sha256 }], AbortSignal.timeout(75))) continue;
    for (const symbol of row.symbols.slice(0, 12)) if (/^[A-Za-z_$][\w$]*$/.test(symbol.name)
      && Number.isSafeInteger(symbol.line) && symbol.line > 0) changedSymbols.push(`${symbol.name}:${row.path}:${symbol.line}`);
  }
  const harness = input.harness;
  if (!harness || !paths.length) return { status: 'measured', changedSymbols };
  return (sql as any).begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', '75ms', true)`;
    const rows: { id: string; state: string; title: string; paths: string[]; relation: 'file-edit-ledger' | 'open-on-path' }[] = await tx`
      WITH attributed AS (
      SELECT w.feature_id AS id, w.status AS state, left(w.title, 100) AS title,
        e.file AS path, 'file-edit-ledger' AS relation
      FROM harness_shared.edit_attribution_ledger e JOIN harness_shared.work_items w
        ON w.workspace_id = e.workspace_id AND w.harness_slug = e.harness_slug AND w.feature_id = e.work_item_id
      WHERE e.workspace_id = ${input.workspace} AND e.harness_slug = ${harness}
        AND e.file = ANY(${paths}::text[]) AND e.ts >= now() - interval '24 hours'
      UNION
      SELECT w.feature_id AS id, w.status AS state, left(w.title, 100) AS title,
        p.path, 'open-on-path' AS relation
      FROM harness_shared.work_items w
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.payload->'paths') = 'array'
        THEN w.payload->'paths' ELSE '[]'::jsonb END) p(path)
      WHERE w.workspace_id = ${input.workspace} AND w.harness_slug = ${harness}
        -- Migration 1595's partial GIN index (work_items_payload_paths_gin). Without
        -- these two predicates this half seq-scans every open item (measured ~300 ms
        -- against the 75 ms statement_timeout above), so the read always failed.
        AND jsonb_typeof(w.payload->'paths') = 'array'
        AND (w.payload->'paths') ?| ${paths}::text[]
        AND NOT (w.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
        AND p.path = ANY(${paths}::text[])
      )
      SELECT id, state, title, relation, array_agg(path ORDER BY path COLLATE "C") AS paths
      FROM attributed GROUP BY id, state, title, relation
      ORDER BY relation, id LIMIT 8`;
    // Bound distinct relationships, not matched files: one broad work item
    // must neither repeat in the note nor consume the other items' slots.
    return { status: 'measured', changedSymbols: [...new Set(changedSymbols)].slice(0, 4),
      workItems: rows };
  });
}
export type PushLeg = (input: PushInput, snapshot: PushSnapshot) => readonly PushFact[];
const state = pinModuleState('@papercusp/operator-core.code-intel-push-legs', () => ({ legs: new Map<PushLegId, PushLeg>() }));
export function registerCodeIntelPushLeg(id: PushLegId, leg: PushLeg): void { state.legs.set(id, leg); }
registerCodeIntelPushLeg('clone', snapshotCloneLeg);

/** Only consumes prepared, hashed candidates. No parser, disk walk or subprocess here. */
export function snapshotAntipatternLeg(input: PushInput): PushFact[] {
  const lines: string[] = [], sources: PushProofSource[] = [], seen = new Set<string>();
  for (const call of input.calls.slice(-20)) {
    if (!/(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? '')) continue;
    for (const raw of (call.antipatternEdits ?? []).slice(0, 20)) {
      const edit = raw as { path?: string; sha256?: string; status?: string; hits?: { ruleId?: string; line1?: number }[] };
      if (!edit || edit.status !== 'measured' || !safeSnapshotPath(edit.path ?? '') || !/^[a-f0-9]{64}$/.test(edit.sha256 ?? '') || !Array.isArray(edit.hits)) continue;
      for (const hit of edit.hits.slice(0, 100)) {
        const rule = AGENT_ANTIPATTERN_RULES.find(rule => rule.id === hit.ruleId);
        const key = `${edit.path}:${edit.sha256}:${hit.ruleId}:${hit.line1}`;
        if (!rule || !Number.isSafeInteger(hit.line1) || hit.line1! < 1 || seen.has(key)) continue;
        seen.add(key);
        lines.push(`${edit.path}:${hit.line1} ${rule.id}: ${rule.hint}.`);
        sources.push({ path: edit.path!, sha256: edit.sha256! });
        if (lines.length === 3) break;
      }
      if (lines.length === 3) break;
    }
    if (lines.length === 3) break;
  }
  return lines.length ? [{ leg: 'antipattern', subject: sources.map(s => `${s.path}:${s.sha256}`).join('|').slice(0, 1000),
    text: lines.join('\n'), citedPaths: [...new Set(sources.map(s => s.path))], sourceHashes: sources }] : [];
}
registerCodeIntelPushLeg('antipattern', snapshotAntipatternLeg);

/** Installed hooks send bounded JSON strings; incomplete digests prove no lookup. */
function pushCallInput(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 4000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** `tools:invoke` and its MCP-mangled form (`mcp__…_tools_invoke`). */
const TOOLS_INVOKE_RE = /(?:^|_|:)tools[_:]invoke$/;

/**
 * WI-6554700010018441: a call dispatched through `tools:invoke { name, args }` is the
 * inner call. Every leg classifies the normalized call, so a wrapped `capability:read`
 * or `capability:bash` is seen exactly like a direct one. One level only.
 */
export function normalizePushCall(call: PushCall): PushCall {
  if (!TOOLS_INVOKE_RE.test(call.tool ?? '')) return call;
  const outer = pushCallInput(call.toolInput);
  const name = outer?.name;
  if (typeof name !== 'string' || !name) return call;
  return { ...call, tool: name, toolInput: outer?.args };
}

/** Native `Read`/`Edit`/`Write`, `capability:read|edit|write` and their MCP-mangled
 * forms (`mcp__…_capability_write`) — the same vocabulary the working-set ledger
 * counts as code tools (blind review 35 G-5: `Write` was not a first touch). */
const FIRST_TOUCH_TOOL_RE = /(?:^|_|:)(?:Read|Edit|Write|read|edit|write)$/;
/** Shell-running tools: native `Bash`, `capability:bash` (any mangling), Codex `exec_command`. */
const SHELL_TOOL_RE = /(?:^|_|:)(?:Bash|bash)$|^exec_command$/;
/** File-reading shell commands whose operands are first touches. */
const SHELL_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed']);
/** head/tail options that consume the following word as their value. */
const SHELL_VALUE_FLAGS = new Set(['-n', '-c', '--lines', '--bytes']);
const SHELL_WORD = /'([^']*)'|"([^"\\$`]*)"|([^\s'"]+)/g;

function shellWords(segment: string): Array<string | null> {
  // null = a word this reader will not resolve (expansion, glob, home, command substitution).
  return [...segment.matchAll(SHELL_WORD)].map(match => match[3] === undefined
    ? (match[1] ?? match[2] ?? '')
    : /[$`*?[{~]/.test(match[3]) ? null : match[3]);
}

function shellReadOperands(command: string, words: Array<string | null>): Array<string | null> {
  const operands: Array<string | null> = [];
  let scriptPending = command === 'sed';
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (word !== null && /^[0-9]*[<>]/.test(word)) break; // a redirection or heredoc ends the operands
    if (word !== null && word.length > 1 && word.startsWith('-')) {
      if (command === 'sed' && (word === '-e' || word === '--expression')) { scriptPending = false; i += 1; }
      else if (command === 'sed' && (word === '-f' || word === '--file')) { scriptPending = false; i += 1; }
      else if (command !== 'sed' && SHELL_VALUE_FLAGS.has(word)) i += 1;
      continue;
    }
    if (scriptPending) { scriptPending = false; continue; }
    if (word !== '-') operands.push(word);
  }
  return operands;
}

/**
 * WI-6554700010018441: files a shell command reads with `cat`, `head`, `tail` or `sed`.
 * Only literal operands resolve; a relative operand is resolved against the tracked `cd`
 * chain from `cwd` (the harness root when the call names none). A wrong guess is quiet,
 * because a first-touch fact needs the path to be covered by the snapshot.
 */
export function shellReadPaths(command: string, cwd: string | undefined): string[] {
  if (command.length > 4000) return [];
  const paths: string[] = [];
  let base = cwd;
  for (const raw of command.split(/\n|;|&&|\|\||\|/)) {
    const segment = raw.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim();
    const words = shellWords(segment);
    const head = words[0];
    if (head === 'cd') {
      const target = words[1];
      base = typeof target === 'string' && target
        ? (isAbsolute(target) ? target : base ? join(base, target) : undefined)
        : undefined;
      continue;
    }
    if (!head || !SHELL_READ_COMMANDS.has(head)) continue;
    for (const operand of shellReadOperands(head, words)) {
      if (!operand) continue;
      if (isAbsolute(operand)) paths.push(operand);
      else if (base) paths.push(join(base, operand));
    }
  }
  return paths;
}

function touchedRawPaths(call: PushCall, root: string | undefined): string[] {
  const args = pushCallInput(call.toolInput);
  if (FIRST_TOUCH_TOOL_RE.test(call.tool ?? '')) {
    const raw = args?.file_path ?? args?.path;
    return typeof raw === 'string' ? [raw] : [];
  }
  if (SHELL_TOOL_RE.test(call.tool ?? '')) {
    const command = args?.command ?? args?.cmd;
    if (typeof command !== 'string') return [];
    const cwd = typeof args?.cwd === 'string' && args.cwd
      ? (isAbsolute(args.cwd) ? args.cwd : root ? join(root, args.cwd) : undefined)
      : root;
    return shellReadPaths(command, cwd);
  }
  return [];
}

function touchPath(input: PushInput, raw: string): string | null {
  const path = isAbsolute(raw) ? (input.root ? relative(input.root, raw) : raw) : posix.normalize(raw);
  return safeSnapshotPath(path) ? path : null;
}

export function firstTouchPaths(input: PushInput): string[] {
  return [...new Set(input.calls.flatMap(rawCall => touchedRawPaths(normalizePushCall(rawCall), input.root)
    .flatMap(raw => { const path = touchPath(input, raw); return path ? [path] : []; })))].slice(0, 4);
}

/** Existing P-016 anchors and P-015 measurement recipes; these are links, not proof of acceptance. */
export async function readPushSourceLinks(input: PushInput, paths: string[], sql = getOrgPg().sql,
  diagnostics?: ResumeReadDiagnostics): Promise<Pick<FirstTouchContext, 'docs' | 'specs' | 'byPath'>> {
  const harness = input.harness;
  if (!harness || !paths.length) return { docs: null, specs: null };
  return sql.begin(async tx => {
    await tx`SELECT set_config('statement_timeout', '75ms', true)`;
    const docs = await timeResumeReadPhase(diagnostics, 'context.sourceLinks.docs', () => tx<{ doc_id: string; anchor_paths: string[] }[]>`SELECT doc_id, anchor_paths FROM harness_shared.harness_docs
      WHERE workspace_id = ${input.workspace} AND harness_slug = ${harness}
        AND anchor_paths && ${paths}::text[] ORDER BY doc_id LIMIT 3`);
    const specs = await timeResumeReadPhase(diagnostics, 'context.sourceLinks.specs', () => tx<{ path: string; plan_slug: string; spec_id: string; spec_revision: number }[]>`
      SELECT DISTINCT p.path, plan_slug, spec_id, spec_revision FROM harness_shared.spec_evidence_bindings b
      CROSS JOIN unnest(${paths}::text[]) p(path)
      WHERE workspace_id = ${input.workspace} AND harness_slug = ${harness}
        AND b.retracted_at IS NULL
        AND ((b.details->'currentMeasurement'->>'kind' = 'repo-files'
          AND COALESCE(b.details->'currentMeasurement'->>'rootHarnessSlug', b.harness_slug) = ${harness}
          AND COALESCE(b.details->'currentMeasurement'->'sourcePaths', '[]'::jsonb) ? p.path)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.details->'measurementPin'->'files') = 'array'
            THEN b.details->'measurementPin'->'files' ELSE '[]'::jsonb END) f
            WHERE f->>'dimension' = 'source' AND f->>'path' = p.path
              AND COALESCE(f->>'rootHarnessSlug', b.details->'currentMeasurement'->>'rootHarnessSlug', b.harness_slug) = ${harness}))
      ORDER BY p.path, plan_slug, spec_id, spec_revision DESC LIMIT 12`);
    return { docs: null, specs: null, byPath: Object.fromEntries(paths.map(path => [path, {
      docs: docs.filter(row => row.anchor_paths.includes(path)).map(row => row.doc_id),
      specs: specs.filter(row => row.path === path).map(row => `${row.plan_slug}#${row.spec_id}@${row.spec_revision}`),
    }])) };
  });
}

/** P-036: reverse static imports are a lower bound; stop instead of running a compiler. */
/** The first-touch brief for ONE path, computed from the CURRENT snapshot. Shared
 * with the resume leg so a carried file gets exactly the facts a fresh touch would
 * (code-intel-epoch-carry-2026-10-20 D-001: recompute, never replay). */
export function firstTouchFact(input: PushInput, snapshot: PushSnapshot, path: string): PushFact | null {
  {
    const consumers = snapshot.importers.get(path) ?? [];
    const symbols = [...new Map([...(snapshot.symbols?.values() ?? [])].flat().filter(symbol => symbol.path === path)
      .map(symbol => [symbol.id, symbol])).values()];
    const seen = new Set([path]);
    const queue = [path];
    const tests: string[] = [];
    while (queue.length && seen.size < 500) {
      for (const next of snapshot.importers.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next); queue.push(next);
        if (/\.(?:test|spec)\.[^.]+$/.test(next)) tests.push(next);
        if (seen.size >= 500) break;
      }
    }
    if (!consumers.length && !symbols.length) return null;
    const context = input.firstTouchContext;
    const sourceLinks = context?.byPath?.[path] ?? context;
    const locks = context?.locks?.filter(lock => lock.owner !== input.owner && lock.coordinationDomain === input.root && seen.has(lock.path));
    const suggestedCall = tests.length ? `testing:run ${JSON.stringify({ files: tests.slice(0, 2), harness: input.harness })}` : undefined;
    const exports = symbols.slice(0, 3).map(symbol => `${symbol.name}:${symbol.line} >=${symbol.callers.length} static calls`
      + (symbol.callers.some(site => site.workspace) ? ` [${[...new Set(symbol.callers.map(site => site.workspace ?? 'workspace unknown'))].slice(0, 2).join(', ')}]` : ' [workspace unknown]'));
    const links = (values: readonly string[] | null | undefined) => values?.length ? values.slice(0, 2).join(', ') : 'unknown';
    return { leg: 'first-touch', subject: path, citedPaths: [path, ...consumers.slice(0, 2), ...tests.slice(0, 2)], suggestedCall,
      text: `${path}: ${consumers.length} static file importers in this snapshot; examples: ${consumers.slice(0, 2).join(', ') || 'unknown'}.`
        + `\nExports (up to 3): ${exports.join('; ') || 'unknown'}.`
        + `\nTests with static import reach${queue.length ? ' (bounded search)' : ''}: ${suggestedCall || 'unknown'}.`
        + `\nAnchored docs: ${links(sourceLinks?.docs)}. Spec evidence links: ${links(sourceLinks?.specs)} (currentness unknown).`
        + `\nLive consumer locks/claims: ${locks?.length ? locks.slice(0, 2).map(lock => `${lock.path}: ${lock.owner}${lock.goalRef ? ' ' + lock.goalRef : ''}`).join('; ') : 'unknown'}.`
        + '\nSnapshot lower bounds only; current source hashes, unindexed exports, dynamic dispatch, untracked anchors, source completeness and runtime execution are unknown.' };
  }
}
/** code-intel-delivery-and-outcomes-2026-10-26 P-008: which part of a file one call touched,
 * resolved to function names against the current source in the context read. */
export type SymbolTouch = { kind: 'lines'; start: number; end: number } | { kind: 'tail'; count: number }
  | { kind: 'text'; needles: readonly string[] } | { kind: 'file' };
/** A touch spanning more functions than this is a file read, not a symbol touch: no note. */
export const PRIOR_WORK_MAX_TOUCH_NAMES = 6;
export const PRIOR_WORK_CONTEXT_TIMEOUT_MS = 80;
export const PRIOR_WORK_SUBJECT_PREFIX = 'prior-work:';
const asRecord = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : null;

function callTouch(call: PushCall): SymbolTouch {
  const args = pushCallInput(call.toolInput);
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (/(?:Read|read)$/.test(call.tool ?? '')) {
    const tail = count(args?.tail);
    if (tail) return { kind: 'tail', count: tail };
    const offset = count(args?.offset), limit = count(args?.limit);
    if (offset === null && limit === null) return { kind: 'file' };
    const start = Math.max(0, (offset ?? 1) - 1);
    return { kind: 'lines', start, end: start + (limit ?? 2000) };
  }
  if (/(?:Edit|edit)$/.test(call.tool ?? '')) {
    const edits = Array.isArray(args?.edits) ? args.edits.map(asRecord) : [args];
    const needles = edits.map(edit => edit?.new_string);
    // An empty or missing new_string (a pure deletion) cannot be located: unknown symbol.
    return { kind: 'text', needles: needles.every(n => typeof n === 'string' && n.length > 0) ? needles as string[] : [] };
  }
  return { kind: 'file' }; // Write and shell reads cover the whole file.
}

export function symbolTouches(input: PushInput): Map<string, SymbolTouch[]> {
  const touches = new Map<string, SymbolTouch[]>();
  for (const call of input.calls.map(normalizePushCall)) {
    const touch: SymbolTouch | null = FIRST_TOUCH_TOOL_RE.test(call.tool ?? '') ? callTouch(call)
      : SHELL_TOOL_RE.test(call.tool ?? '') ? { kind: 'file' } : null;
    if (!touch) continue;
    for (const raw of touchedRawPaths(call, input.root)) {
      const path = touchPath(input, raw);
      if (path) touches.set(path, [...(touches.get(path) ?? []), touch]);
    }
  }
  return touches;
}

/** Function names a touch covers (classes only when no function is hit). `null` = the touched
 * symbol is unknown (parse failure or an edit that cannot be located once); `'broad'` = too many. */
export function touchedSymbolNames(path: string, source: string, touches: readonly SymbolTouch[]): string[] | null | 'broad' {
  const spans = symbolSpans(path, source);
  if (!spans) return null;
  const lineCount = source.split('\n').length;
  const ranges: { start: number; end: number }[] = [];
  for (const touch of touches) {
    if (touch.kind === 'file') ranges.push({ start: 0, end: lineCount });
    else if (touch.kind === 'tail') ranges.push({ start: Math.max(0, lineCount - touch.count), end: lineCount });
    else if (touch.kind === 'lines') ranges.push({ start: touch.start, end: Math.min(touch.end, lineCount) });
    else {
      if (!touch.needles.length) return null;
      for (const needle of touch.needles) {
        const at = source.indexOf(needle);
        if (at < 0 || source.indexOf(needle, at + 1) >= 0) return null;
        const start = source.slice(0, at).split('\n').length - 1;
        ranges.push({ start, end: start + needle.split('\n').length });
      }
    }
  }
  const hits = spans.filter(span => ranges.some(range => span.first < range.end && span.last >= range.start));
  const functions = hits.filter(span => span.kind === 'function');
  const names = [...new Set((functions.length ? functions : hits).map(span => span.name))].sort();
  return names.length > PRIOR_WORK_MAX_TOUCH_NAMES ? 'broad' : names;
}

/** The session's claimed work item and, per touched path, prior work on symbols it has not been shown. */
export interface PriorWorkContext { workItem: string; reports: Readonly<Record<string, PriorWorkReport>> }
export interface ReadPriorWorkContextDeps {
  claim(workspace: string, owner: string): Promise<string | null>;
  /** prior-work subjects already pushed to this owner in its current epoch. */
  noted(input: PushInput): Promise<readonly string[]>;
  source(root: string, path: string): Promise<string>;
  read: PriorWorkReader;
}
/** A session's first touch of a symbol within one claimed work item: the commit's
 * (owner, epoch, leg, subject) dedup makes a second touch of the same symbol silent. */
export const priorWorkSubject = (workItem: string, path: string, names: readonly string[] | null) =>
  `${PRIOR_WORK_SUBJECT_PREFIX}${workItem}:${path}#${names ? names.join(',') : '?'}`;
function notedNames(subjects: readonly string[], workItem: string, path: string): Set<string> {
  const prefix = `${PRIOR_WORK_SUBJECT_PREFIX}${workItem}:${path}#`;
  return new Set(subjects.filter(subject => subject.startsWith(prefix)).flatMap(subject => subject.slice(prefix.length).split(',')));
}
const priorWorkDefaults: ReadPriorWorkContextDeps = {
  claim: async (workspace, owner) => (await getActiveClaimForOwner(workspace, owner))?.workItemId ?? null,
  noted: input => withWorkspace(input.workspace, async tx => {
    await tx`SELECT set_config('statement_timeout', '50ms', true)`;
    const rows = await tx<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} AND leg = 'first-touch'
        AND epoch = COALESCE((SELECT epoch FROM harness_shared.memory_session_epochs WHERE session_id = ${input.owner}), 0)
        AND subject LIKE ${PRIOR_WORK_SUBJECT_PREFIX + '%'} ORDER BY pushed_at DESC LIMIT 500`;
    return rows.map(row => row.subject);
  }),
  source: (root, path) => readFile(resolve(root, path), 'utf8'),
  read: query => readPriorWork(query),
};

export async function readPushPriorWork(input: PushInput, paths: readonly string[],
  deps: ReadPriorWorkContextDeps = priorWorkDefaults): Promise<PriorWorkContext | null> {
  const touches = symbolTouches(input);
  const touched = paths.filter(path => touches.has(path));
  const root = input.root;
  if (!root || !input.workspace || !input.owner || !touched.length) return null;
  const [claimed, noted] = await Promise.all([deps.claim(input.workspace, input.owner).catch(() => null),
    deps.noted(input).catch((): readonly string[] => [])]);
  const workItem = claimed ?? 'none';
  const reports: Record<string, PriorWorkReport> = {};
  await Promise.all(touched.map(async path => {
    let source: string;
    try { source = await deps.source(root, path); } catch { return; }
    const resolved = touchedSymbolNames(path, source, touches.get(path)!);
    if (resolved === 'broad') return;
    const shown = notedNames(noted, workItem, path);
    const names = resolved === null ? null : resolved.filter(name => !shown.has(name));
    if (names === null ? shown.has('?') : !names.length) return;
    reports[path] = await deps.read({ workspaceId: input.workspace, root, path, names, excludeWorkItem: claimed });
  }));
  return { workItem, reports };
}

/** The one-line prior-work note for a first-touched path, or null when there is nothing to say. */
export function priorWorkFact(input: PushInput, path: string): PushFact | null {
  const context = input.firstTouchContext?.priorWork;
  const report = context?.reports[path];
  if (!context || !report || !input.harness) return null;
  const text = formatPriorWorkLine(report, { harness: input.harness });
  return text ? { leg: 'first-touch', subject: priorWorkSubject(context.workItem, path, report.names),
    text, citedPaths: [path], bare: true } : null;
}

export const snapshotFirstTouchLeg: PushLeg = (input, snapshot) => firstTouchPaths(input).flatMap(path =>
  [firstTouchFact(input, snapshot, path), priorWorkFact(input, path)].filter((fact): fact is PushFact => fact !== null));
registerCodeIntelPushLeg('first-touch', snapshotFirstTouchLeg);

/** code-intel-epoch-carry-2026-10-20 P-003/P-004: working-set files a NEW epoch (or
 * a new holder) has not been pushed yet. Read before the resume leg runs. */
export interface ResumeContext {
  entries: readonly ResumeEntry[];
  /** Source links for the entries, read with the context and off the push wall (P-006). */
  links?: FirstTouchContext;
}

interface ResumeReadDiagnostics {
  readId: string;
  startedAtMs: number;
  phaseMs: Record<string, number>;
  phaseOutcomes: Record<string, string>;
  phaseErrors?: Record<string, string>;
  label?: string;
}

function summarizeResumePhaseError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = error !== null && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' ? error.code.slice(0, 32) : '';
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 160);
  return [name, code ? `[${code}]` : '', message].filter(Boolean).join(': ');
}

async function timeResumeReadPhase<T>(diagnostics: ResumeReadDiagnostics | undefined, phase: string,
  work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  if (diagnostics) diagnostics.phaseOutcomes[phase] = 'running';
  try {
    const value = await work();
    if (diagnostics) diagnostics.phaseOutcomes[phase] = 'completed';
    return value;
  } catch (error) {
    if (diagnostics) {
      diagnostics.phaseOutcomes[phase] = 'error';
      diagnostics.phaseErrors ??= {};
      diagnostics.phaseErrors[phase] = summarizeResumePhaseError(error);
    }
    throw error;
  } finally {
    if (diagnostics) diagnostics.phaseMs[phase] = Date.now() - startedAt;
  }
}

export interface ResumeEntry {
  path: string;
  /** Why the file was in the carried set (`held` = from a work-item stamp). */
  reason: WorkingSetReason | 'held';
  from: 'previous-epoch' | 'work-item';
  itemId?: string;
  previousOwner?: string;
  epoch?: number;
  /** Symbol HANDLES carried with this file (blind review 35 G-4). Names only: the
   * resume leg re-resolves each against the CURRENT snapshot, never a stored answer. */
  symbols?: readonly string[];
}
export const RESUME_FACTS_PER_BATCH = 2;
export const RESUME_SYMBOLS_PER_ENTRY = 6;

/** One carried symbol handle, re-resolved in the current snapshot: its definition in
 * this file if there is exactly one, else its unique definition elsewhere, else named
 * as unresolved. The caller count is the snapshot's static lower bound. */
export function resolveCarriedSymbol(snapshot: PushSnapshot, name: string, path: string): string {
  const definitions: readonly SnapshotSymbol[] = snapshot.symbols?.get(name) ?? [];
  const here = definitions.filter(symbol => symbol.path === path);
  const pick = here.length === 1 ? here[0] : definitions.length === 1 ? definitions[0] : null;
  if (!pick) return `${name} (${definitions.length ? 'ambiguous' : 'not indexed'} in this snapshot)`;
  return `${name}${pick.path === path ? '' : ` @${pick.path}`}:${pick.line} >=${pick.callers.length} static calls`;
}

/** P-003: fresh first-touch facts for carried files, from the CURRENT snapshot. The
 * subject is `resume:<path>`, so the existing (owner, epoch, leg, subject) dedupe
 * and per-turn budget apply unchanged and each file is resumed once per epoch. */
export const snapshotResumeLeg: PushLeg = (input, snapshot) => {
  const touched = new Set(firstTouchPaths(input));
  const facts: PushFact[] = [];
  for (const entry of input.resumeContext?.entries ?? []) {
    if (facts.length >= RESUME_FACTS_PER_BATCH) break;
    // A file touched in this very batch gets its ordinary first-touch brief.
    if (touched.has(entry.path) || !safeSnapshotPath(entry.path)) continue;
    const base = firstTouchFact(input, snapshot, entry.path);
    if (!base) continue;
    const origin = entry.from === 'work-item'
      ? `Carried from ${entry.itemId ?? 'a held work item'}'s working set (stamped by ${entry.previousOwner ?? 'its previous holder'})`
      : `Carried from your previous epoch's working set${entry.epoch !== undefined ? ` (epoch ${entry.epoch})` : ''} (${entry.reason})`;
    const carried = (entry.symbols ?? []).slice(0, RESUME_SYMBOLS_PER_ENTRY);
    const symbolLine = carried.length
      ? `\nCarried symbol handles, re-resolved in this snapshot: ${carried.map(name => resolveCarriedSymbol(snapshot, name, entry.path)).join('; ')}.`
      : '';
    facts.push({ ...base, leg: 'resume', subject: `resume:${entry.path}`,
      text: `${origin}; recomputed from the current snapshot, not replayed.\n${base.text}${symbolLine}` });
  }
  return facts;
};
registerCodeIntelPushLeg('resume', snapshotResumeLeg);

export interface ReadResumeContextDeps {
  epoch(owner: string): Promise<EpochRow>;
  signals(query: WorkingSetQuery): Promise<WorkingSetSignals>;
  foreign(owner: string, workspace: string, harness: string): Promise<ForeignWorkingSet[]>;
  /** Subjects already pushed to this owner in its CURRENT epoch on the first-touch / resume legs. */
  pushed(input: PushInput, epoch: number): Promise<string[]>;
}

async function readPushedResumeSubjects(input: PushInput, epoch: number, sql = getOrgPg().sql): Promise<string[]> {
  return (sql as any).begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', '75ms', true)`;
    const rows: { subject: string }[] = await tx`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} AND epoch = ${epoch}
        AND leg IN ('first-touch', 'resume') ORDER BY pushed_at DESC LIMIT 200`;
    return rows.map(row => row.subject);
  });
}

const resumeDefaults: ReadResumeContextDeps = {
  epoch: owner => readSessionEpoch(owner),
  signals: query => readWorkingSetSignals(query, undefined, 75),
  foreign: (owner, workspace, harness) => readForeignWorkingSets(owner, workspace, harness),
  pushed: (input, epoch) => readPushedResumeSubjects(input, epoch),
};

/** Previous-epoch working set first (in rank order), then sets stamped on held
 * items by a different owner; minus anything already pushed this epoch. */
export async function readPushResumeContext(input: PushInput, deps: ReadResumeContextDeps = resumeDefaults,
  diagnostics?: ResumeReadDiagnostics): Promise<ResumeContext> {
  const harness = input.harness;
  if (!input.owner || !input.workspace || !harness) return { entries: [] };
  const epoch = await timeResumeReadPhase(diagnostics, 'epoch', () => deps.epoch(input.owner));
  const [previous, foreign, pushed] = await Promise.all([
    timeResumeReadPhase(diagnostics, 'previousWorkingSet', () => deriveCodeWorkingSet(
      { workspace: input.workspace, harness, owner: input.owner, which: 'previous', root: input.root },
      { epoch: async () => epoch, signals: query => deps.signals(query) },
    )).catch(() => null),
    timeResumeReadPhase(diagnostics, 'foreignWorkingSets', () => deps.foreign(input.owner, input.workspace, harness))
      .catch(() => [] as ForeignWorkingSet[]),
    timeResumeReadPhase(diagnostics, 'pushedSubjects', () => deps.pushed(input, epoch.epoch)).catch(() => [] as string[]),
  ]);
  const done = new Set(pushed.map(subject => subject.startsWith('resume:') ? subject.slice('resume:'.length) : subject));
  const entries: ResumeEntry[] = [];
  const add = (entry: ResumeEntry): ResumeEntry | null => {
    if (entries.length >= 8 || done.has(entry.path) || !safeSnapshotPath(entry.path)) return null;
    done.add(entry.path);
    entries.push(entry);
    return entry;
  };
  /** G-4: names that could not be placed on their own file ride on the source's first added entry. */
  const placeRest = (first: ResumeEntry | null, names: readonly string[]) => {
    if (!first || !names.length) return;
    first.symbols = [...new Set([...(first.symbols ?? []), ...names])].slice(0, RESUME_SYMBOLS_PER_ENTRY);
  };
  // Previous epoch: each file carries the symbols defined in it; a symbol whose file
  // the cap dropped still brings that file forward (G-4).
  const previousSymbols = previous?.symbols ?? [];
  const definedIn = (path: string) => previousSymbols.filter(symbol => symbol.path === path).map(symbol => symbol.name);
  const previousPaths = [...new Set([...(previous?.files ?? []).map(file => file.path),
    ...previousSymbols.flatMap(symbol => symbol.path ? [symbol.path] : [])])];
  let firstPrevious: ResumeEntry | null = null;
  for (const path of previousPaths) {
    const file = previous?.files.find(candidate => candidate.path === path);
    const symbols = definedIn(path);
    const added = add({ path, reason: file?.reason ?? 'queried', from: 'previous-epoch', epoch: previous!.epoch,
      ...(symbols.length ? { symbols } : {}) });
    firstPrevious ??= added;
  }
  placeRest(firstPrevious, previousSymbols.filter(symbol => !symbol.path).map(symbol => symbol.name));
  // A work-item stamp records symbol NAMES without paths; the leg resolves them.
  for (const set of foreign) {
    let first: ResumeEntry | null = null;
    for (const path of set.stamp.paths) {
      const added = add({ path, reason: 'held', from: 'work-item', itemId: set.itemId, previousOwner: set.stamp.owner });
      first ??= added;
    }
    placeRest(first, set.stamp.symbols);
  }
  return { entries };
}

/** P-006 (live run 1): the resume read keeps running after it misses its 100ms bound.
 * Discarding that late result and re-reading on every batch meant a loaded host never
 * fit the read inside the bound, so resume never fired. A late result is instead parked
 * per (workspace, owner) and served once to the next batch; an in-flight read is joined,
 * never duplicated. Consume-once keeps the already-pushed subjects current: the next
 * read after a consumption sees what that batch pushed. */
export const RESUME_CONTEXT_TIMEOUT_MS = 100;
/** The links read runs inside the parked background read, so it is not on the 250ms wall. */
export const RESUME_LINKS_TIMEOUT_MS = 2_000;
export const RESUME_PARK_TTL_MS = 60_000;
export const RESUME_PARK_MAX = 256;
export const RESUME_CONTEXT_DIAGNOSTIC_SAMPLE_EVERY = 32;
const FIRST_TOUCH_CONTEXT_TIMEOUT_MS = 100;
const FIRST_TOUCH_CONTEXT_DIAGNOSTIC_SLOW_MS = 50;
const FIRST_TOUCH_CONTEXT_LABEL = 'code-intel-first-touch-context';
interface ParkedResume { at: number; read: Promise<ResumeContext>; diagnostics: ResumeReadDiagnostics; value?: ResumeContext }
const resumeParking = pinModuleState('@papercusp/operator-core.code-intel-resume-parking',
  () => ({ parked: new Map<string, ParkedResume>(), readSequence: 0, settledReads: 0, firstTouchSettledReads: 0 }));
/** Test seam: forget every parked resume read. */
export function resetParkedResumeContexts(): void { resumeParking.parked.clear(); }
/** Test/diagnostic seam: how many resume reads are parked right now. */
export function parkedResumeContextCount(): number { return resumeParking.parked.size; }

function logResumeContextDiagnostic(level: 'info' | 'warn', event: string, diagnostics: ResumeReadDiagnostics,
  elapsedMs: number, timeoutMs: number, errorMessage?: string): void {
  const line = '[' + (diagnostics.label ?? 'code-intel-resume-context') + '] '
    + JSON.stringify({ event, readId: diagnostics.readId, elapsedMs, timeoutMs,
    phaseMs: { ...diagnostics.phaseMs }, phaseOutcomes: { ...diagnostics.phaseOutcomes },
    ...(Object.keys(diagnostics.phaseErrors ?? {}).length ? { phaseErrors: { ...diagnostics.phaseErrors } } : {}),
    ...(errorMessage ? { errorMessage: errorMessage.slice(0, 200) } : {}) });
  if (level === 'warn') console.warn(line);
  else console.info(line);
}

export async function boundedResumeContext(input: PushInput,
  read: (input: PushInput, diagnostics?: ResumeReadDiagnostics) => Promise<ResumeContext>,
  timeoutMs = RESUME_CONTEXT_TIMEOUT_MS): Promise<ResumeContext | undefined> {
  const { parked } = resumeParking;
  const key = `${input.workspace}\u0000${input.owner}`;
  const now = Date.now();
  for (const [k, entry] of parked) if (now - entry.at > RESUME_PARK_TTL_MS) parked.delete(k);
  let entry = parked.get(key);
  if (entry?.value) { parked.delete(key); return entry.value; }
  if (!entry) {
    while (parked.size >= RESUME_PARK_MAX) parked.delete(parked.keys().next().value!);
    resumeParking.readSequence = (resumeParking.readSequence ?? 0) + 1;
    const diagnostics: ResumeReadDiagnostics = {
      readId: `${process.pid}:${resumeParking.readSequence}`, startedAtMs: 0, phaseMs: {}, phaseOutcomes: {},
      label: 'code-intel-resume-context',
    };
    const readPromise = Promise.resolve().then(() => {
      diagnostics.startedAtMs = Date.now();
      return read(input, diagnostics);
    });
    const fresh: ParkedResume = { at: now, read: readPromise, diagnostics };
    fresh.read.then(
      value => {
        if (parked.get(key) === fresh) { fresh.value = value; fresh.at = Date.now(); }
        resumeParking.settledReads = (resumeParking.settledReads ?? 0) + 1;
        const elapsedMs = Date.now() - diagnostics.startedAtMs;
        if (elapsedMs >= RESUME_CONTEXT_TIMEOUT_MS || resumeParking.settledReads % RESUME_CONTEXT_DIAGNOSTIC_SAMPLE_EVERY === 0) {
          logResumeContextDiagnostic('info', 'read-settled', diagnostics, elapsedMs, RESUME_CONTEXT_TIMEOUT_MS);
        }
      },
      error => {
        resumeParking.settledReads = (resumeParking.settledReads ?? 0) + 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logResumeContextDiagnostic('warn', 'read-error', diagnostics, Date.now() - diagnostics.startedAtMs,
          RESUME_CONTEXT_TIMEOUT_MS, errorMessage);
        if (parked.get(key) === fresh) parked.delete(key);
      });
    parked.set(key, fresh);
    entry = fresh;
  }
  const result = await withBoundedTimeout(entry.read, {
    timeoutMs, fallback: undefined, label: 'code-intel-resume-context', warn: false,
  });
  if (result.reason === 'timeout') {
    logResumeContextDiagnostic('warn', 'wait-timeout', entry.diagnostics, result.elapsedMs, timeoutMs);
  }
  // Answered in time (or failed): consumed. Timed out: stays parked for the next batch.
  if (result.reason !== 'timeout' && parked.get(key) === entry) parked.delete(key);
  return result.value;
}

/** code-intel-epoch-carry-2026-10-20 P-005: code notes (`code-note:` facts) anchored
 * to the files this batch first-touched, split by whether every `file:` anchor still
 * hashes to what it did when the note was written. Read before the notes leg runs. */
export interface NotesContext {
  fresh: readonly NoteEntry[];
  withheld: readonly WithheldNote[];
}
export interface NoteEntry { key: string; body: string; paths: readonly string[]; scope: string; scopeRef: string | null }
export interface WithheldNote {
  key: string;
  path: string;
  /** `changed` = an anchored file's content moved; `unverifiable` = it could not be hashed now. */
  reason: 'changed' | 'unverifiable';
}
export const NOTES_FACTS_PER_PATH = 2;
export const NOTE_BODY_PUSH_CHARS = 360;

/** P-005 (R-7/R-8): deliver fresh code notes on first touch; never push a note whose
 * anchored code changed — name how many were withheld and their keys instead. */
export const snapshotNotesLeg: PushLeg = input => {
  const context = input.notesContext;
  if (!context) return [];
  const facts: PushFact[] = [];
  for (const path of firstTouchPaths(input)) {
    for (const note of context.fresh.filter(entry => entry.paths.includes(path)).slice(0, NOTES_FACTS_PER_PATH)) {
      const body = note.body.length > NOTE_BODY_PUSH_CHARS ? `${note.body.slice(0, NOTE_BODY_PUSH_CHARS - 1)}…` : note.body;
      facts.push({ leg: 'notes', subject: `note:${note.key}`, citedPaths: [path],
        suggestedCall: `facts:list ${JSON.stringify({ scope: note.scope, ...(note.scopeRef ? { scopeRef: note.scopeRef } : {}), key: note.key })}`,
        text: `Code note ${note.key} on ${path} — its file anchors still match the content it was written against:\n${body}` });
    }
    const withheld = context.withheld.filter(entry => entry.path === path);
    if (withheld.length) {
      const keys = [...new Set(withheld.map(entry => entry.key))];
      facts.push({ leg: 'notes', subject: `notes-withheld:${path}:${keys.join(',')}`.slice(0, 1000), citedPaths: [path],
        text: `${keys.length} code note(s) on ${path} withheld because the code changed since they were written`
          + ` (or could not be re-hashed): ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}.`
          + ' Re-verify against the current file, then re-assert the note or facts:retract it.' });
    }
  }
  return facts;
};
registerCodeIntelPushLeg('notes', snapshotNotesLeg);

export interface ReadNotesContextDeps {
  /** Live code notes with a `file:` anchor on any of `paths`. */
  fold(input: PushInput, paths: readonly string[]): Promise<AgentFact[]>;
  /** Re-hash the notes' file anchors against `input.root` (dependency-staleness). */
  staleness(facts: AgentFact[], input: PushInput): Promise<Array<AgentFact & { depsStale?: FactDependencyStaleness }>>;
}
/** The production anchor check: the SAME `file:` resolver checkpoints and facts:list
 * use, against the registered harness root the snapshot set on `input.root`. Only
 * file anchors reach it (see {@link readPushNotesContext}), so no cell is dispatched. */
// Prefetched at module load (still a dynamic import, so no static cycle through the
// cell-read graph): a cold import inside the 120ms notes bound would make the
// FIRST touch in a process time out and silently deliver nothing.
let stalenessModule: Promise<typeof import('../agent-tools/facts/dependency-staleness')> | null = null;
const loadStaleness = () => (stalenessModule ??= import('../agent-tools/facts/dependency-staleness'));
void loadStaleness().catch(() => { stalenessModule = null; });
export const readNoteAnchorStaleness: ReadNotesContextDeps['staleness'] = async (facts, input) => {
  const { markStaleDependencyFacts } = await loadStaleness();
  return markStaleDependencyFacts(facts, { ownerId: input.owner, ...(input.harness ? { harnessSlug: input.harness } : {}) },
    { workspaceId: input.workspace, harnessSlug: input.harness ?? null, role: 'su' },
    input.root ? { fileRepoRoot: input.root } : undefined);
};
const notesDefaults: ReadNotesContextDeps = {
  fold: (input, paths) => withWorkspace(input.workspace, tx =>
    foldCodeNotesForPaths(
      [{ scope: 'workspace' }, ...(input.harness ? [{ scope: 'harness' as const, scopeRef: input.harness }] : [])],
      paths, { workspaceId: input.workspace }, tx)),
  staleness: readNoteAnchorStaleness,
};

/** Fail-closed on staleness: a note is FRESH only when every one of its `file:`
 * anchors re-hashed to its stored digest. Non-file dependencies are not consulted
 * here (they need a cell dispatch the 250ms push wall cannot afford). */
export async function readPushNotesContext(input: PushInput, paths: readonly string[], deps: ReadNotesContextDeps = notesDefaults): Promise<NotesContext> {
  if (!paths.length) return { fresh: [], withheld: [] };
  const notes = (await deps.fold(input, paths)).filter(fact => isCodeNoteKey(fact.key));
  if (!notes.length) return { fresh: [], withheld: [] };
  const anchorsOnly = notes.map(fact => ({ ...fact, dependsOn: (fact.dependsOn ?? []).filter(dep => isFactFileAnchor(dep.cell)) }));
  const marked = await deps.staleness(anchorsOnly, input);
  const fresh: NoteEntry[] = [];
  const withheld: WithheldNote[] = [];
  for (const fact of marked) {
    const anchors = (fact.dependsOn ?? []).map(dep => dep.cell.slice(FACT_FILE_ANCHOR_PREFIX.length));
    const touched = anchors.filter(path => paths.includes(path));
    if (!touched.length) continue;
    const verdicts = fact.depsStale?.deps ?? [];
    const allFresh = anchors.length > 0 && verdicts.length === anchors.length && verdicts.every(verdict => verdict.status === 'fresh');
    if (allFresh) { fresh.push({ key: fact.key, body: fact.body, paths: touched, scope: fact.scope, scopeRef: fact.scopeRef ?? null }); continue; }
    const reason = verdicts.some(verdict => verdict.status === 'changed') ? 'changed' : 'unverifiable';
    for (const path of touched) withheld.push({ key: fact.key, path, reason });
  }
  return { fresh, withheld };
}

/** P-037: one note for local interface/strand triggers plus static snapshot reach.
 * The edited file intentionally no longer hashes to the pre-edit snapshot: all
 * reach is labelled historical/lower-bound, never a current resolver verdict.
 */
export const snapshotInterfaceLeg: PushLeg = (input, snapshot) => {
  const facts: PushFact[] = [];
  for (const value of input.calls.filter(call => /(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? ''))
    .flatMap(call => call.interfaceEdits ?? (call.interfaceEdit ? [call.interfaceEdit] : [])).slice(0, 2)) {
    const edit = value as { path?: unknown; base?: unknown; changes?: unknown; checks?: unknown } | null;
    if (!edit || typeof edit.path !== 'string' || !safeSnapshotPath(edit.path)
      || typeof edit.base !== 'string' || !/^[a-f0-9]{40,64}$/.test(edit.base)
      || !Array.isArray(edit.changes) || !edit.changes.length || !Array.isArray(edit.checks)) continue;
    const changes = edit.changes.filter((v): v is string => typeof v === 'string' && v.length <= 120).slice(0, 4);
    // Prescriptions are built from validated path/base here, never arbitrary client commands.
    if (!changes.length || !/^[A-Za-z0-9_./@+-]+$/.test(edit.path)) continue;
    const scripts = ['check-required-field-strands', 'check-behavioural-strands'];
    const rawChecks = edit.checks;
    const checks = scripts.filter(script => rawChecks.some((v: unknown) => typeof v === 'string' && v.startsWith(`node scripts/${script}.mjs `)))
      .map(script => `node scripts/${script}.mjs ${script === scripts[0] ? '--typecheck ' : ''}--base ${edit.base} --files=${edit.path}`);
    const seen = new Set([edit.path]), queue = [edit.path], tests: string[] = [];
    while (queue.length && seen.size < 200) {
      for (const next of snapshot.importers.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next); queue.push(next);
        if (/\.(?:test|spec)\.[^.]+$/.test(next)) tests.push(next);
        if (seen.size >= 200) break;
      }
    }
    const consumers = snapshot.importers.get(edit.path) ?? [];
    const suggestedCall = tests.length ? `testing:run ${JSON.stringify({ files: tests.slice(0, 2), harness: input.harness })}` : undefined;
    const peerContext = input.interfacePeerContext?.byPath[edit.path];
    const peerText = changes.some(s => /^signature /.test(s))
      ? peerContext?.status === 'measured' && peerContext.peers.length
        ? '\nLive caller peers (static candidates): ' + peerContext.peers.slice(0, 2)
          .map(p => `${p.owner.slice(0, 80)} ${p.path.slice(0, 180)} (${p.via})`).join('; ') + '.'
        : '\nLive caller peers: unknown' + (peerContext?.reason ? ` (${peerContext.reason})` : ' (no matched live peer measured)') + '.'
      : '';
    facts.push({ leg: 'interface', subject: `${edit.path}:${changes.join('|')}`,
      citedPaths: [...new Set([edit.path, ...consumers.slice(0, 2), ...tests.slice(0, 2),
        ...(peerContext?.status === 'measured' ? peerContext.peers.slice(0, 2).map(p => p.path) : [])])], suggestedCall,
      text: `${edit.path}: ${changes.join('; ')}.\nStatic consumers: ${consumers.slice(0, 2).join(', ') || 'unknown'}.`
        + peerText
        + `\nTests with static import reach${queue.length ? ' (bounded)' : ''}: ${suggestedCall ?? 'unknown'}.`
        + `\nPinned strand checks (advisory; run typecheck in background):\n${checks.join('\n')}`
        + '\nSnapshot reach predates this edit; affected consumers are candidates, not proven failures. Dynamic dispatch, new imports, source completeness and runtime execution remain unknown.' });
  }
  return facts;
};
registerCodeIntelPushLeg('interface', snapshotInterfaceLeg);

function incidentResponseRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    try { return incidentResponseRecord(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.structuredContent) return incidentResponseRecord(record.structuredContent, depth + 1);
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      const item = block as { type?: unknown; text?: unknown } | null;
      if (item?.type !== 'text') continue;
      const nested = incidentResponseRecord(item.text, depth + 1);
      if (nested) return nested;
    }
  }
  return record;
}

function failedIncidentPaths(call: PushCall): string[] {
  if (!/(?:^|[:_/.])(?:testing[:_]run|test[:_]file|run-tests)(?:$|[:_/.])/.test(call.tool ?? '')) return [];
  const response = incidentResponseRecord(call.incidentResult ?? call.toolResponse);
  if (!response) return [];
  const paths = new Set<string>();
  const byFile = response.byFile;
  if (byFile && typeof byFile === 'object' && !Array.isArray(byFile)) {
    for (const [path, value] of Object.entries(byFile as Record<string, unknown>)) {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (Number(row.failed ?? 0) > 0 || row.collectionFailed === true || row.status === 'fail' || row.status === 'error') {
        if (safeSnapshotPath(path)) paths.add(path);
      }
    }
  }
  const files = response.files;
  if (Array.isArray(files)) {
    for (const value of files) {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const path = typeof value === 'string' ? value : row.path ?? row.file ?? row.filePath;
      const failed = row.status === 'fail' || row.status === 'error' || Number(row.failed ?? 0) > 0 || row.ok === false;
      if (failed && safeSnapshotPath(path)) paths.add(path);
    }
  }
  // A refused/aborted run and the list of requested files prove no file failed.
  return [...paths].slice(0, 4);
}

/** P-038: observed test failures are authoritative; static reach is hypothesis-only. */
export const snapshotIncidentLeg: PushLeg = (input, snapshot) => {
  const calls = input.calls.filter(call => {
    const scope = incidentResponseRecord(call.toolInput)?.harness;
    return scope === undefined || scope === input.harness;
  });
  const failed = [...new Set(calls.flatMap(failedIncidentPaths))].slice(0, 4);
  if (!failed.length) return [];
  const reverse = new Map<string, string[]>();
  for (const [imported, importers] of snapshot.importers) {
    for (const importer of importers) {
      const paths = reverse.get(importer) ?? [];
      paths.push(imported);
      reverse.set(importer, paths);
    }
  }
  const reached = new Set<string>(failed);
  const queue = [...failed];
  while (queue.length && reached.size < 80) {
    const path = queue.shift()!;
    for (const dependency of reverse.get(path) ?? []) {
      if (!safeSnapshotPath(dependency) || reached.has(dependency)) continue;
      reached.add(dependency); queue.push(dependency);
      if (reached.size >= 80) break;
    }
  }
  const symbols = [...new Map([...(snapshot.symbols?.values() ?? [])].flat()
    .filter(symbol => reached.has(symbol.path)).map(symbol => [symbol.id, symbol])).values()].slice(0, 4);
  const edits = input.calls.flatMap(call => call.interfaceEdits ?? (call.interfaceEdit ? [call.interfaceEdit] : []))
    .flatMap(value => {
      const edit = value as { path?: unknown; changes?: unknown } | null;
      return edit && typeof edit.path === 'string' && reached.has(edit.path) && Array.isArray(edit.changes)
        ? edit.changes.filter((change): change is string => typeof change === 'string' && change.length <= 120).slice(0, 3)
        : [];
    }).slice(0, 3);
  const dependencies = [...reached].filter(path => !failed.includes(path)).slice(0, 8);
  const symbolText = symbols.length ? symbols.map(symbol => symbol.name + ':' + symbol.path + ':' + symbol.line).join(', ') : 'unknown';
  const changedText = edits.length ? edits.join('; ') : 'unknown';
  const attribution = input.incidentAttribution;
  const changedSymbols = attribution?.status === 'measured' && attribution.changedSymbols?.length
    ? attribution.changedSymbols.slice(0, 4).join(', ') : 'unknown';
  const workItems = attribution?.status === 'measured' && attribution.workItems?.length
    ? attribution.workItems.filter(item => item.paths.some(path => reached.has(path))).slice(0, 4)
      .map(item => `${item.id} [${item.state}]${item.relation ? ` (${item.relation})` : ''}${item.title ? ` ${item.title}` : ''}`).join('; ') || 'none measured on static reach'
    : 'unknown';
  const suggestedCall = 'testing:run ' + JSON.stringify({ files: failed.slice(0, 2), harness: input.harness });
  const subject = ('failed-tests:' + failed.join('|')).slice(0, 1000);
  const citedPaths = [...new Set([...failed, ...dependencies, ...symbols.map(symbol => symbol.path)])].slice(0, 12);
  const runIds = [...new Set(calls.flatMap(call => {
    const response = incidentResponseRecord(call.incidentResult ?? call.toolResponse);
    const rows = response?.byFile;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return [];
    return Object.entries(rows).flatMap(([path, row]) => {
      const id = row && typeof row === 'object' ? (row as { runId?: unknown }).runId : undefined;
      return failed.includes(path) && typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? [id] : [];
    });
  }))].slice(0, 4);
  const recovery = runIds.length ? 'Recover recorded failures with testing:runs '
    + JSON.stringify({ testRunIds: runIds, harness: input.harness }) + '.'
    : 'Original test-row identity unknown; no exact ledger recovery can be prescribed.';
  return [{
    leg: 'incident',
    subject,
    citedPaths,
    suggestedCall,
    text: 'Observed failing test files: ' + failed.join(', ') + '. The observed failure is authoritative.\n'
      + 'Static reach candidates (unverified): ' + (dependencies.join(', ') || 'unknown') + '.\n'
      + 'Symbols on static reach (change status unknown): ' + symbolText + '; observed turn edit strands: ' + changedText + '.\n'
      + 'Recently changed symbols (measured ledger attribution): ' + changedSymbols + '.\n'
      + 'Work items changed/open on these paths: ' + workItems + '. '
      + 'File-edit attribution does not prove symbol authorship. Graph paths are hypotheses only; cause, runtime execution and dynamic dispatch are unknown. '
      + recovery,
  }];
};
registerCodeIntelPushLeg('incident', snapshotIncidentLeg);

/** Only a single literal identifier lookup is resolved; arbitrary regexes remain quiet. */
export function grepLookupSubject(rawCall: PushCall): string | null {
  const call = normalizePushCall(rawCall);
  const args = pushCallInput(call.toolInput);
  const tool = call.tool ?? '';
  if (/(?:^|_|:)(?:Grep|grep)$/.test(tool) && typeof args?.pattern === 'string') return grepPatternSubject(args.pattern);
  const command = args?.command ?? args?.cmd;
  if (typeof command !== 'string' || command.length > 4000) return null;
  // Same segment parser as the P-033 instrument: the search may follow `cd <dir> || exit 1;`,
  // a variable assignment or a pipe. The first single-symbol pattern wins.
  for (const pattern of shellSearchPatterns(command)) {
    const subject = grepPatternSubject(pattern);
    if (subject) return subject;
  }
  return null;
}

/** One search pattern → the single symbol it looks up, or null (alternations stay ambiguous). */
function grepPatternSubject(pattern: string): string | null {
  const simple = pattern.replace(/\\b/g, '').replace(/\\?\($/, '').replace(/^\^/, '').replace(/\$$/, '').trim();
  const declaration = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)$/.exec(simple);
  const name = declaration?.[1] ?? simple;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

export const snapshotGrepLeg: PushLeg = (input, snapshot) => {
  const facts: PushFact[] = [];
  for (const call of input.calls) {
    const subject = grepLookupSubject(call);
    if (!subject) continue;
    const symbols = snapshot.symbols?.get(subject);
    if (symbols?.length !== 1) continue; // Ambiguous / unresolved means no push.
    const symbol = symbols[0]!;
    if (!symbol.sources?.length) continue; // Older metadata cannot prove forwarding-module freshness.
    const callers = symbol.callers.slice(0, 4);
    const workspaces = new Map<string, number>();
    for (const site of symbol.callers) {
      const workspace = typeof site.workspace === 'string' ? site.workspace : '(workspace unknown)';
      workspaces.set(workspace, (workspaces.get(workspace) ?? 0) + 1);
    }
    const aliases = [...new Set(symbol.callers.filter(site => site.spelling !== subject).map(site => site.spelling))].slice(0, 4);
    facts.push({ leg: 'grep', subject, sourceHashes: symbol.sources, citedPaths: [symbol.path, ...callers.map(site => site.path)],
      text: `${subject}: definition ${symbol.path}:${symbol.line}. At least ${symbol.callers.length} syntax-bound static calls `
        + `(${[...workspaces].map(([workspace, count]) => `${workspace}: ${count}`).join('; ') || 'none resolved'}).`
        + (callers.length ? `\nTop callers: ${callers.map(site => `${site.path}:${site.line}`).join(', ')}.` : '')
        + (aliases.length ? `\nAliases a literal grep can miss: ${aliases.join(', ')}.` : '')
        + '\nDefinition, forwarding and caller file hashes corroborated. Comments/strings are excluded. Dynamic dispatch, shadowed bindings, other languages, current resolver configuration and runtime execution remain unknown.' });
  }
  return facts;
};
registerCodeIntelPushLeg('grep', snapshotGrepLeg);

export interface PushChannelDeps {
  research?(input: PushInput): Promise<void>;
  snapshot(input: PushInput): Promise<PushSnapshot | null>;
  enabled(flag: FlagKey): Promise<boolean>;
  legs(): ReadonlyMap<PushLegId, PushLeg>;
  context?(input: PushInput, paths: string[], diagnostics?: ResumeReadDiagnostics): Promise<FirstTouchContext>;
  incidentContext?(input: PushInput, paths: string[]): Promise<IncidentAttribution>;
  resumeContext?(input: PushInput, diagnostics?: ResumeReadDiagnostics): Promise<ResumeContext>;
  notesContext?(input: PushInput, paths: readonly string[]): Promise<NotesContext>;
  interfaceContext?(input: PushInput, snapshot: PushSnapshot): Promise<InterfacePeerContext>;
  /** P-005: measured acted-on rate per leg, read synchronously from a cache that refreshes
   * off the push wall; null while nothing has been measured (arrival order then stands). */
  legFollowThrough?(workspace: string): ReadonlyMap<string, LegFollowThrough> | null;
  /** `dropped`: facts the request already found over CODE_INTEL_PUSH_MAX_CHARS; the commit
   * classifies and records them with its own budget drops (WI-6554700010018440).
   * `notRun`: enabled legs the wall stopped before they ran, recorded as site `wall`
   * (WI-6554700010030085). */
  commit(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[], requestBudget: number, signal: AbortSignal,
    dropped: readonly PushFact[], notRun: readonly PushLegId[]): Promise<string>;
}


/** WI-6554700010018440: budget drops, written beside the deliveries. Telemetry only: the
 * savepoint keeps a failed write from rolling back the facts this request delivered. A fact
 * already delivered this epoch is not a budget loss, so it is not recorded. */
async function recordPushSkips(tx: Sql, input: PushInput, epoch: number, turn: string,
  skips: readonly PushSkip[]): Promise<void> {
  if (typeof (tx as Sql & Partial<Pick<TransactionSql, 'savepoint'>>).savepoint !== 'function') return;
  try {
    await (tx as unknown as TransactionSql).savepoint(sp => sp`INSERT INTO harness_shared.code_intel_push_skips
      (workspace_id, owner_id, epoch, turn_id, leg, subject, chars, budget_left, site, client)
      SELECT ${input.workspace}, ${input.owner}, ${epoch}, ${turn}, s.leg, s.subject, s.chars, s.budget_left, s.site, ${input.client ?? null}
      FROM unnest(${skips.map(s => s.leg)}::text[], ${skips.map(s => s.subject)}::text[],
        ${skips.map(s => s.chars)}::int[], ${skips.map(s => s.budgetLeft)}::int[], ${skips.map(s => s.site)}::text[])
        AS s(leg, subject, chars, budget_left, site)
      WHERE NOT EXISTS (SELECT 1 FROM harness_shared.code_intel_pushes p
        WHERE p.workspace_id = ${input.workspace} AND p.owner_id = ${input.owner} AND p.epoch = ${epoch}
          AND p.leg = s.leg AND p.subject = s.subject)
      ON CONFLICT (workspace_id, owner_id, turn_id, leg, subject) DO NOTHING`);
  } catch (error) { console.warn('[code-intel-push] skip record failed:', String(error).slice(0, 200)); }
}

/** One transaction serializes both the turn ceiling and session dedupe across cluster workers. */
export async function commitPushFacts(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[],
  requestBudget: number, signal: AbortSignal, dropped: readonly PushFact[] = [],
  notRun: readonly PushLegId[] = []): Promise<string> {
  return withWorkspace(input.workspace, async tx => {
    // The hook must not leave a slow query behind after its response deadline.
    await tx`SELECT set_config('lock_timeout', '100ms', true), set_config('statement_timeout', '150ms', true)`;
    await tx`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${input.workspace}, ${input.owner}, ${randomUUID()}) ON CONFLICT DO NOTHING`;
    const turns = await tx<{ turn_id: string }[]>`SELECT turn_id FROM harness_shared.identity_hook_turns
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} FOR UPDATE`;
    const turn = turns[0]?.turn_id;
    if (!turn || signal.aborted) return '';
    const epochs = await tx<{ epoch: number }[]>`SELECT epoch FROM harness_shared.memory_session_epochs WHERE session_id = ${input.owner}`;
    const epoch = Number(epochs[0]?.epoch ?? 0);
    // The intent leg's rows are tool-result briefs, never hook text (recordIntentTaskBrief).
    const spent = await tx<{ chars: number }[]>`SELECT COALESCE(SUM(chars), 0)::int AS chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} AND turn_id = ${turn} AND leg <> 'intent'`;
    let requestLeft = requestBudget;
    let turnLeft = CODE_INTEL_PUSH_TURN_CHARS - Number(spent[0]?.chars ?? 0);
    const budgetLeft = Math.max(0, Math.min(requestLeft, turnLeft));
    // P-005: a fact costs its rendered length; the '\n\n' join is not charged, so three
    // CODE_INTEL_PUSH_MAX_CHARS pushes fill exactly CODE_INTEL_PUSH_TURN_CHARS (R-5 D-009).
    const skips: PushSkip[] = [
      ...dropped.map(fact => ({ leg: fact.leg, subject: fact.subject, chars: formatPushFact(fact, snapshot).length,
        budgetLeft, site: 'push-cap' as const })),
      ...notRun.map(leg => ({ leg, subject: `leg-not-run:${leg}`, chars: 0, budgetLeft, site: 'wall' as const })),
    ];
    const text: string[] = [];
    for (const fact of facts) {
      const block = formatPushFact(fact, snapshot);
      const chars = block.length;
      const left = Math.min(requestLeft, turnLeft);
      if (signal.aborted) throw new Error('code-intel push cancelled');
      // Never cut a qualifier or citation off a fact: an over-cap or over-budget push
      // is dropped whole and recorded.
      if (chars > CODE_INTEL_PUSH_MAX_CHARS || chars > left) {
        // The production caller's request share is the whole turn, so a request-budget
        // skip comes only from a caller that passes a smaller share.
        skips.push({ leg: fact.leg, subject: fact.subject, chars, budgetLeft: Math.max(0, left),
          site: chars > CODE_INTEL_PUSH_MAX_CHARS ? 'push-cap' : chars > turnLeft ? 'turn-budget' : 'request-budget' });
        continue;
      }
      const inserted = await tx<{ id: number }[]>`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, snapshot_generated_at, cited_paths, suggested_call, chars, client)
        VALUES (${input.workspace}, ${input.owner}, ${epoch}, ${turn}, ${fact.leg}, ${fact.subject}, ${snapshot.commit},
          ${snapshot.generatedAt}::timestamptz, ${[...fact.citedPaths]}::text[], ${fact.suggestedCall ?? null}, ${chars}, ${input.client ?? null})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING RETURNING id`;
      if (inserted.length) { text.push(block); requestLeft -= chars; turnLeft -= chars; }
    }
    if (skips.length && !signal.aborted) await recordPushSkips(tx, input, epoch, turn, skips);
    if (signal.aborted) throw new Error('code-intel push cancelled');
    return text.join('\n\n');
  });
}

/** WI-6554700010018439: the intent leg delivers through a TOOL RESULT, not this hook. When
 * coord:declare-intent is given current_files, it returns the task brief from
 * getIntentTimeTaskBrief (task-brief.ts). This records one ledger row per delivered brief so
 * the push-outcome instrument measures the leg like the others. Unlike hook facts, the brief
 * is not budgeted here: it has its own TASK_BRIEF_MAX_CHARS cap and never shares the hook
 * response, so commitPushFacts excludes leg 'intent' from the per-turn spend. A brief that
 * measured nothing (status 'unknown', for example a timed-out read) delivered no code facts
 * and is not recorded. Best-effort: returns false instead of failing the declaration. */
export async function recordIntentTaskBrief(input: { workspace: string; owner: string; client?: string },
  brief: Pick<TaskBrief, 'status' | 'intent' | 'sourceFingerprint' | 'commit' | 'files' | 'recover'>): Promise<boolean> {
  if (brief.status !== 'current' || !input.workspace || !input.owner) return false;
  const subject = `${brief.intent?.fingerprint ?? 'no-intent'}:${brief.sourceFingerprint ?? 'unmeasured'}`.slice(0, 1000);
  const citedPaths = [...new Set(brief.files.map(file => file.path))].filter(safeSnapshotPath).slice(0, 20);
  const suggestedCall = `${brief.recover.tool} ${JSON.stringify(brief.recover.args)}`.slice(0, 1000);
  const chars = JSON.stringify(brief).length;
  try {
    return await withWorkspace(input.workspace, async tx => {
      await tx`SELECT set_config('lock_timeout', '100ms', true), set_config('statement_timeout', '150ms', true)`;
      await tx`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
        VALUES (${input.workspace}, ${input.owner}, ${randomUUID()}) ON CONFLICT DO NOTHING`;
      const turns = await tx<{ turn_id: string }[]>`SELECT turn_id FROM harness_shared.identity_hook_turns
        WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner}`;
      const turn = turns[0]?.turn_id;
      if (!turn) return false;
      const epochs = await tx<{ epoch: number }[]>`SELECT epoch FROM harness_shared.memory_session_epochs WHERE session_id = ${input.owner}`;
      const inserted = await tx<{ id: number }[]>`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, cited_paths, suggested_call, chars, client)
        VALUES (${input.workspace}, ${input.owner}, ${Number(epochs[0]?.epoch ?? 0)}, ${turn}, 'intent', ${subject},
          ${brief.commit}, ${citedPaths}::text[], ${suggestedCall}, ${chars}, ${input.client ?? null})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING RETURNING id`;
      return inserted.length > 0;
    });
  } catch (error) {
    console.warn('[code-intel-push] intent brief record failed:', String(error).slice(0, 200));
    return false;
  }
}

/** P-005: the qualifier an omitted-lines marker keeps, so a shortened push is never read
 * as complete or as runtime truth. */
export const PUSH_OMITTED_QUALIFIER = 'static snapshot lower bounds; runtime unknown';

/**
 * One push, at most CODE_INTEL_PUSH_MAX_CHARS where its first line allows (R-5 D-003/D-014).
 * A leg's text is newline-separated whole statements. The render keeps the first line, then
 * the line carrying the fact's `suggestedCall` (its pointer; appended as `Next: …` when no
 * line carries it), then the remaining lines in order while they fit, and names how many it
 * left out. A line is never cut. A push whose first line and pointer alone exceed the cap is
 * returned whole and dropped by the caller (site push-cap). Bare one-line notes render as is.
 * The snapshot commit stays in the header; its generation time is in the ledger row.
 */
export function formatPushFact(fact: PushFact, snapshot: PushSnapshot): string {
  if (fact.leg === 'antipattern' || fact.leg === 'clone' || fact.bare) return fact.text;
  const header = `## Code intelligence (${fact.leg}) @${snapshot.commit.slice(0, 12)}`;
  const [head = '', ...rest] = fact.text.split('\n');
  const pointerAt = fact.suggestedCall ? rest.findIndex(line => line.includes(fact.suggestedCall!)) : -1;
  const pointer = pointerAt >= 0 ? rest[pointerAt] : fact.suggestedCall ? `Next: ${fact.suggestedCall}` : '';
  const others = rest.filter((_, index) => index !== pointerAt);
  const marker = (count: number) => `(+${count} line${count === 1 ? '' : 's'} omitted; ${PUSH_OMITTED_QUALIFIER})`;
  const lines = [header, head];
  let used = header.length + 1 + head.length + (pointer ? pointer.length + 1 : 0);
  let omitted = 0;
  for (const [index, line] of others.entries()) {
    const later = others.length - index - 1;
    // Room for this line, plus the marker if anything after it could still be left out.
    const reserve = later ? marker(later + omitted).length + 1 : omitted ? marker(omitted).length + 1 : 0;
    if (!omitted && used + line.length + 1 + reserve <= CODE_INTEL_PUSH_MAX_CHARS) {
      lines.push(line);
      used += line.length + 1;
    } else omitted += 1;
  }
  if (pointer) lines.push(pointer);
  if (omitted) lines.push(marker(omitted));
  return lines.join('\n');
}

/** P-005: one leg's measured follow-through (native-adoption.ts actedOn over closed windows). */
export interface LegFollowThrough { rate: number; measured: number }
/** Below this many closed measurements a leg's rate is not trusted; it takes the measured mean. */
export const LEG_FOLLOW_THROUGH_MIN_MEASURED = 20;
export const LEG_FOLLOW_THROUGH_WINDOW_MS = 7 * 86_400_000;
export const LEG_FOLLOW_THROUGH_REFRESH_MS = 60 * 60_000;
const LEG_FOLLOW_THROUGH_READ_TIMEOUT_MS = 30_000;

/**
 * Commit order for a request's facts (P-005): highest measured acted-on rate first, so the
 * reserved budget goes to what agents use. A leg with fewer than
 * LEG_FOLLOW_THROUGH_MIN_MEASURED closed measurements takes the mean of the trusted legs,
 * so a rare leg (interface) is neither buried nor promoted on noise. Ties, and every fact
 * when nothing is measured, keep arrival order (a stable sort).
 */
export function rankPushFacts(facts: readonly PushFact[], rates: ReadonlyMap<string, LegFollowThrough> | null): PushFact[] {
  if (!rates?.size) return [...facts];
  const trusted = [...rates.values()].filter(entry => entry.measured >= LEG_FOLLOW_THROUGH_MIN_MEASURED);
  if (!trusted.length) return [...facts];
  const prior = trusted.reduce((sum, entry) => sum + entry.rate, 0) / trusted.length;
  const score = (leg: string) => {
    const entry = rates.get(leg);
    return entry && entry.measured >= LEG_FOLLOW_THROUGH_MIN_MEASURED ? entry.rate : prior;
  };
  return facts.map((fact, index) => ({ fact, index, score: score(fact.leg) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(entry => entry.fact);
}

/** Per-workspace follow-through, refreshed in the background at most hourly. Derived and
 * recomputable from code_intel_pushes + agent_activity, so nothing durable lives here. */
const followThrough = pinModuleState('@papercusp/operator-core.code-intel-leg-follow-through',
  () => ({ byWorkspace: new Map<string, { rates: ReadonlyMap<string, LegFollowThrough> | null; at: number; inFlight: boolean }>() }));

/** Never awaited on the push path: returns what is cached and starts a refresh when stale. */
export function cachedLegFollowThrough(workspace: string,
  measure: (workspace: string) => Promise<ReadonlyMap<string, LegFollowThrough>> = measureLegFollowThrough,
  now = Date.now()): ReadonlyMap<string, LegFollowThrough> | null {
  // Never measured: the first read starts whatever the clock says.
  const entry = followThrough.byWorkspace.get(workspace) ?? { rates: null, at: -Infinity, inFlight: false };
  if (!entry.inFlight && now - entry.at >= LEG_FOLLOW_THROUGH_REFRESH_MS) {
    entry.inFlight = true;
    entry.at = now;
    followThrough.byWorkspace.set(workspace, entry);
    void withBoundedTimeout(() => measure(workspace), {
      timeoutMs: LEG_FOLLOW_THROUGH_READ_TIMEOUT_MS, fallback: undefined, label: 'code-intel-leg-follow-through',
    }).then(result => { if (result.value) entry.rates = result.value; })
      .catch(() => undefined).finally(() => { entry.inFlight = false; });
  }
  return entry.rates;
}

export function resetLegFollowThroughCache(): void { followThrough.byWorkspace.clear(); }

async function measureLegFollowThrough(workspace: string): Promise<ReadonlyMap<string, LegFollowThrough>> {
  const { measureNativePushOutcomesWindow } = await import('./native-adoption');
  const end = Date.now();
  const metrics = await measureNativePushOutcomesWindow({ workspaceId: workspace,
    windowStart: new Date(end - LEG_FOLLOW_THROUGH_WINDOW_MS).toISOString(), windowEnd: new Date(end).toISOString() });
  return new Map(Object.entries(metrics.byLeg).flatMap(([leg, stats]) => stats.actedOn.rate === null ? []
    : [[leg, { rate: stats.actedOn.rate, measured: stats.actedOn.measured }] as const]));
}

const defaults: PushChannelDeps = {
  research: async input => (await import('./research-trail')).recordResearchBatch(input),
  snapshot: async input => {
    // Only the registered home repository currently has the maintained producer.
    // Never use the operator's snapshot for a different harness/workspace.
    const home = operatorHomeHarnessSlug();
    if (input.workspace !== activeWorkspaceId() || input.harness !== home) return null;
    const registry = await loadHarnessRegistry(input.workspace);
    const project = registry.projects.find(project => project.slug === home && project.path);
    if (!project) return null;
    input.root = project.path;
    return peekPushSnapshot('papercusp');
  },
  enabled: flag => getFlag(flag, 'system'),
  legs: () => state.legs,
  legFollowThrough: workspace => cachedLegFollowThrough(workspace),
  context: async (input, paths, diagnostics) => {
    const [links, locks, priorWork] = await Promise.allSettled([
      timeResumeReadPhase(diagnostics, 'context.sourceLinks', () => readPushSourceLinks(input, paths, undefined, diagnostics)),
      timeResumeReadPhase(diagnostics, 'context.liveLockHoldings', () => liveLockHoldingsStrict({
        onPhase: event => {
          if (!diagnostics) return;
          const phase = 'context.locks.' + event.phase;
          if (event.state === 'start') diagnostics.phaseOutcomes[phase] = 'running';
          else {
            diagnostics.phaseOutcomes[phase] = 'completed';
            if (event.durationMs !== undefined) diagnostics.phaseMs[phase] = event.durationMs;
          }
        },
      })),
      // Its own bound: a slow prior-work read must not cost this batch its links and locks.
      timeResumeReadPhase(diagnostics, 'context.priorWork', () => withBoundedTimeout(() => readPushPriorWork(input, paths),
        { timeoutMs: PRIOR_WORK_CONTEXT_TIMEOUT_MS, fallback: null, label: 'code-intel-prior-work', warn: false })
        .then(result => result.value)),
    ]);
    if (diagnostics?.label === FIRST_TOUCH_CONTEXT_LABEL &&
      Date.now() - diagnostics.startedAtMs >= FIRST_TOUCH_CONTEXT_TIMEOUT_MS) {
      resumeParking.firstTouchSettledReads = (resumeParking.firstTouchSettledReads ?? 0) + 1;
      const hasError = Object.values(diagnostics.phaseOutcomes).includes('error');
      logResumeContextDiagnostic(hasError ? 'warn' : 'info', 'late-settled', diagnostics,
        Date.now() - diagnostics.startedAtMs, FIRST_TOUCH_CONTEXT_TIMEOUT_MS);
    }
    return { ...(links.status === 'fulfilled' ? links.value : { docs: null, specs: null }),
      locks: locks.status === 'fulfilled' ? locks.value : null,
      priorWork: priorWork.status === 'fulfilled' ? priorWork.value ?? null : null };
  },
  commit: commitPushFacts,
  incidentContext: readPushIncidentAttribution,
  interfaceContext: readInterfacePeerContext,
  resumeContext: (input, diagnostics) => readPushResumeContext(input, undefined, diagnostics),
  notesContext: (input, paths) => readPushNotesContext(input, paths),
};

/** P-006: the resume context and its entries' source links in ONE background read. A
 * links read awaited inside the wall (`code-intel-resume-links`) was measured on :3170
 * to push the whole batch past CODE_INTEL_PUSH_WALL_MS, so nothing was committed. */
async function readResumeWithLinks(input: PushInput, deps: PushChannelDeps,
  diagnostics?: ResumeReadDiagnostics): Promise<ResumeContext> {
  const context = await deps.resumeContext!(input, diagnostics);
  const paths = context.entries.map(entry => entry.path).slice(0, RESUME_FACTS_PER_BATCH + 2);
  if (!deps.context || !paths.length) return context;
  const links = await timeResumeReadPhase(diagnostics, 'sourceLinks', () => withBoundedTimeout(() => deps.context!(input, paths, diagnostics),
    { timeoutMs: RESUME_LINKS_TIMEOUT_MS, fallback: undefined, label: 'code-intel-resume-links', warn: false }));
  if (links.reason && diagnostics) diagnostics.phaseOutcomes.sourceLinks = links.reason;
  return links.value ? { ...context, links: links.value } : context;
}

/** Leg run order inside the push wall; unlisted legs keep registration order (stable sort). */
const PUSH_LEG_PRIORITY: readonly PushLegId[] = ['interface', 'incident'];
/** WI-6554700010030085: legs that wait on a context read run after the snapshot-only legs.
 * Registered before grep, they used the whole gather deadline on every turn and grep never
 * ran: 12/12 turns on :3170 d6bfe13a4d (2026-10-27 09:50-09:54Z) recorded `leg-not-run:grep`
 * while :3070, without the deadline, still delivered grep pushes. Delivery order is
 * rankPushFacts's job, so gathering the cheap legs first costs the waiting legs nothing. */
const PUSH_LEGS_THAT_WAIT: readonly PushLegId[] = ['first-touch', 'resume', 'notes'];
export function pushLegRank(id: PushLegId): number {
  const rank = PUSH_LEG_PRIORITY.indexOf(id);
  if (rank !== -1) return rank;
  return PUSH_LEG_PRIORITY.length + (PUSH_LEGS_THAT_WAIT.includes(id) ? 1 : 0);
}

/** A failed optional push never drops memory, worn rules, or the failure hint.
 * P-005 (WI-6554700010029479): code intelligence spends its own reserved
 * CODE_INTEL_PUSH_TURN_CHARS per turn. It used to get 1,500 minus the memory block, so a
 * full memory recall starved it (650 request-budget skips in 7 days); the dominant cause,
 * pushes of ~1,100-1,200 chars (10,143 turn-budget skips), is CODE_INTEL_PUSH_MAX_CHARS. */
export async function codeIntelPushText(input: PushInput, deps: PushChannelDeps = defaults): Promise<string> {
  // Capture is independent of push flags, snapshot warmth and available text budget.
  if (input.owner && input.workspace && input.calls.length && deps.research) {
    await withBoundedTimeout(() => deps.research!(input), {
      timeoutMs: 100, fallback: undefined, label: 'code-intel-research-trail',
    });
  }
  if (!input.owner || !input.workspace || !input.calls.length || !deps.legs().size) return '';
  // WI-6554700010018441: every leg classifies the call a `tools:invoke` wrapper dispatched.
  input = { ...input, calls: input.calls.map(normalizePushCall) };
  const requestBudget = CODE_INTEL_PUSH_TURN_CHARS;
  // WI-6554700010030085: the legs and the commit share one wall, so gathering stops at
  // a deadline that leaves the commit CODE_INTEL_PUSH_COMMIT_RESERVE_MS. Before, a slow
  // gather made the wall fire first and every fact already gathered was lost, with no
  // row in code_intel_pushes or code_intel_push_skips (3/3 incident replays on :3170).
  let phase: 'snapshot' | 'gather' | 'commit' = 'snapshot';
  let gathered = 0;
  const result = await withBoundedTimeout(async signal => {
    const gatherDeadline = Date.now() + CODE_INTEL_PUSH_WALL_MS - CODE_INTEL_PUSH_COMMIT_RESERVE_MS;
    const gatherLeft = () => Math.max(1, gatherDeadline - Date.now());
    const gatherSignal = AbortSignal.any([signal, AbortSignal.timeout(gatherLeft())]);
    // Every wait inside the gather ends by the deadline; a read still running then
    // degrades exactly as it would on its own timeout.
    const byGatherDeadline = <T>(work: Promise<T>, fallback: T) =>
      withBoundedTimeout(work, { timeoutMs: gatherLeft(), fallback, warn: false }).then(settled => settled.value);
    const snapshot = await deps.snapshot(input);
    if (!snapshot || signal.aborted) return '';
    phase = 'gather';
    const legs = [...deps.legs()].sort(([a], [b]) => pushLegRank(a) - pushLegRank(b));
    // Read every leg's flag at once: one wait instead of one per leg, and the commit
    // needs to know which legs were ON to record the ones the wall stopped.
    const on = new Map(await Promise.all(legs.map(async ([id]) => [id, await deps.enabled(PUSH_LEG_FLAGS[id])] as const)));
    // The resume read does not depend on any other leg, so it overlaps with them
    // instead of adding its own wait to the 250ms wall (P-003).
    const resumeContext = deps.resumeContext && on.get('resume')
      ? boundedResumeContext(input, (i, diagnostics) => readResumeWithLinks(i, deps, diagnostics))
        .then(value => ({ value }), () => ({ value: undefined }))
      : null;
    // P-005: same overlap for the code-note read (a fact fold plus a re-hash of the
    // notes' file anchors), started only when this batch first-touched a file.
    const touchedPaths = firstTouchPaths(input);
    const notesContext = deps.notesContext && touchedPaths.length && on.get('notes')
      ? withBoundedTimeout(() => deps.notesContext!(input, touchedPaths), { timeoutMs: 120, fallback: undefined, label: 'code-intel-notes-context' })
        .catch(() => ({ value: undefined }))
      : null;
    const facts: PushFact[] = [];
    const dropped: PushFact[] = [];
    const notRun: PushLegId[] = [];
    // A leg the deadline stopped is a loss only if it had work: a leg whose read never
    // started, or a snapshot leg with no candidate for this batch, would have pushed
    // nothing anyway. Recording those made `notes` a wall skip on 12/12 turns.
    const hadWork = (id: PushLegId, leg: PushLeg): boolean => {
      if (id === 'notes') return notesContext !== null;
      if (id === 'resume') return resumeContext !== null;
      if (id === 'first-touch') return touchedPaths.length > 0;
      try { return leg(input, snapshot).length > 0; } catch { return false; }
    };
    // Consequences take precedence over a first-touch brief for the same edit. An
    // observed test failure (incident, P-038) goes next: it is rare, authoritative and
    // cheap, and its attribution read then overlaps the resume/notes reads already in
    // flight. Queued after them it started past the 250ms wall and never committed
    // (measured on :3170 2026-10-27, code-intel-delivery-and-outcomes-2026-10-26#P-002).
    for (const [index, [id, leg]] of legs.entries()) {
      if (signal.aborted || !on.get(id)) continue;
      if (Date.now() >= gatherDeadline) {
        notRun.push(...legs.slice(index).filter(([rest, restLeg]) => on.get(rest) && hadWork(rest, restLeg)).map(([rest]) => rest));
        break;
      }
      try {
        if (id === 'interface' && deps.interfaceContext && interfaceSignatureEdits(input).length) {
          const context = await withBoundedTimeout(() => deps.interfaceContext!(input, snapshot),
            { timeoutMs: Math.min(100, gatherLeft()), fallback: undefined, label: 'code-intel-interface-peers' });
          input.interfacePeerContext = context.value;
        }
        if (id === 'first-touch' && deps.context && touchedPaths.length) {
          const diagnostics: ResumeReadDiagnostics = {
            readId: randomUUID(), startedAtMs: Date.now(), phaseMs: {},
            phaseOutcomes: { outerContext: 'running' }, label: FIRST_TOUCH_CONTEXT_LABEL,
          };
          const contextTimeoutMs = Math.min(FIRST_TOUCH_CONTEXT_TIMEOUT_MS, gatherLeft());
          const context = await withBoundedTimeout(() => deps.context!(input, touchedPaths, diagnostics),
            { timeoutMs: contextTimeoutMs, fallback: undefined, label: FIRST_TOUCH_CONTEXT_LABEL, warn: false });
          diagnostics.phaseOutcomes.outerContext = context.reason ?? 'completed';
          diagnostics.phaseMs.outerContext = context.elapsedMs;
          if (context.reason === 'timeout') diagnostics.phaseOutcomes.underlyingCancellation = 'not-supported';
          input.firstTouchContext = context.value;
          const hasPhaseError = Object.values(diagnostics.phaseOutcomes).includes('error');
          if (context.reason) {
            const event = context.reason === 'timeout' ? 'wait-timeout'
              : context.reason === 'error' ? 'read-error' : 'read-aborted';
            logResumeContextDiagnostic('warn', event, diagnostics, context.elapsedMs,
              contextTimeoutMs, context.errorMessage);
          } else {
            const settledReads = resumeParking.firstTouchSettledReads = (resumeParking.firstTouchSettledReads ?? 0) + 1;
            if (context.elapsedMs >= FIRST_TOUCH_CONTEXT_DIAGNOSTIC_SLOW_MS || hasPhaseError ||
              settledReads % RESUME_CONTEXT_DIAGNOSTIC_SAMPLE_EVERY === 0) {
              logResumeContextDiagnostic(hasPhaseError ? 'warn' : 'info',
                hasPhaseError ? 'read-settled-with-error' : 'read-settled', diagnostics, context.elapsedMs,
                contextTimeoutMs);
            }
          }
        }
        if (id === 'notes') {
          if (!notesContext) continue;
          // A timed-out read delivers nothing rather than an unverified note.
          input.notesContext = (await byGatherDeadline(notesContext, { value: undefined })).value ?? { fresh: [], withheld: [] };
        }
        if (id === 'resume') {
          if (!resumeContext) continue;
          input.resumeContext = (await byGatherDeadline(resumeContext, { value: undefined })).value ?? { entries: [] };
          // A resume carries the same source links a first touch would; they were read
          // with the context. Merge per path so this batch's first-touch links survive.
          const links = input.resumeContext.links;
          if (links) input.firstTouchContext = input.firstTouchContext
            ? { ...input.firstTouchContext, byPath: { ...links.byPath, ...input.firstTouchContext.byPath } }
            : links;
        }
        let candidates = leg(input, snapshot);
        if (id === 'incident' && candidates.length && deps.incidentContext) {
          const measured = await withBoundedTimeout(() => deps.incidentContext!(input, [...candidates[0].citedPaths]),
            { timeoutMs: Math.min(100, gatherLeft()), fallback: undefined, label: 'code-intel-incident-context' });
          input.incidentAttribution = measured.value ?? { status: 'unknown' };
          candidates = leg(input, snapshot);
        }
        for (const fact of candidates) {
          if (id === 'first-touch' && facts.some(f => f.leg === 'interface' && f.citedPaths[0] === fact.subject)) continue;
          if (fact.leg !== id || fact.subject.length > 1000 || !fact.subject.trim() || !fact.text.trim()
            || !fact.citedPaths.every(safeSnapshotPath)) continue;
          // P-005: over the per-push cap even after formatPushFact kept only whole lines,
          // so dropped whole and recorded (site push-cap). Not source-corroborated first:
          // that check costs wall time for a fact that cannot be delivered either way.
          if (formatPushFact(fact, snapshot).length > CODE_INTEL_PUSH_MAX_CHARS) {
            if (dropped.length < 12) dropped.push(fact);
            continue;
          }
          // Past the deadline the check reports false, so an unverified fact is never pushed.
          if (!fact.sourceHashes || await corroboratePushSources(input.root, fact.sourceHashes, gatherSignal)) facts.push(fact);
          if (facts.length >= 12) break;
        }
      } catch (error) { console.warn(`[code-intel-push] ${id} failed:`, String(error).slice(0, 200)); }
      gathered = facts.length;
      if (facts.length >= 12) break;
    }
    phase = 'commit';
    // A request whose only candidates were dropped, or whose legs the wall stopped,
    // still commits, to record the skips.
    // P-005: the budget goes to the legs agents act on most, not to whichever leg ran first.
    const ranked = rankPushFacts(facts, deps.legFollowThrough?.(input.workspace) ?? null);
    return (ranked.length || dropped.length || notRun.length) && !signal.aborted
      ? deps.commit(input, snapshot, ranked, requestBudget, signal, dropped, notRun) : '';
  }, { timeoutMs: CODE_INTEL_PUSH_WALL_MS, fallback: '', label: 'code-intel-push' });
  // Names the phase the wall cut, so a remaining loss is attributable: 'snapshot' or
  // 'commit' now, since the gather itself ends by its deadline.
  if (result.reason === 'timeout') {
    console.warn(`[code-intel-push] wall fired during ${phase} after ${result.elapsedMs}ms with ${gathered} fact(s) gathered`);
  }
  return result.value;
}
