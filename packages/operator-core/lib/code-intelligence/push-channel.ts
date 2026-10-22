/** P-034/D-016: one code-intelligence leg at the existing PostToolBatch sink. */
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, posix, relative } from 'node:path';
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
import type { TaskBrief } from './task-brief';
import { shellSearchPatterns } from './native-adoption';
import { corroboratePushSources, peekPushSnapshot, safeSnapshotPath, type PushProofSource, type PushSnapshot, type SnapshotSymbol } from './push-snapshot';
import { FACT_FILE_ANCHOR_PREFIX, foldCodeNotesForPaths, isCodeNoteKey, isFactFileAnchor, type AgentFact } from '../agent-facts/store';
import type { FactDependencyStaleness } from '../agent-tools/facts/dependency-staleness';
import {
  deriveCodeWorkingSet, readForeignWorkingSets, readSessionEpoch, readWorkingSetSignals,
  type EpochRow, type ForeignWorkingSet, type WorkingSetQuery, type WorkingSetReason, type WorkingSetSignals,
} from './working-set';

export const CODE_INTEL_PUSH_TURN_CHARS = 1_500;
export const CODE_INTEL_PUSH_WALL_MS = 250;
export const PUSH_LEG_FLAGS = {
  grep: FLAGS.CODE_INTEL_PUSH_GREP, 'first-touch': FLAGS.CODE_INTEL_PUSH_FIRST_TOUCH,
  interface: FLAGS.CODE_INTEL_PUSH_INTERFACE, incident: FLAGS.CODE_INTEL_PUSH_INCIDENT,
  completion: FLAGS.CODE_INTEL_PUSH_COMPLETION,
  // No registered hook leg: this flag gates the task brief coord:declare-intent returns for
  // current_files (declare-intent.ts -> task-brief.ts getIntentTimeTaskBrief), recorded by
  // recordIntentTaskBrief (WI-6554700010018439).
  intent: FLAGS.CODE_INTEL_PUSH_INTENT,
  resume: FLAGS.CODE_INTEL_PUSH_RESUME, notes: FLAGS.CODE_INTEL_PUSH_NOTES,
} as const;
export type PushLegId = keyof typeof PUSH_LEG_FLAGS;
export interface PushCall { tool?: string; toolInput?: unknown; toolResponse?: unknown; incidentResult?: unknown; interfaceEdit?: unknown; interfaceEdits?: unknown[] }
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
  calls: readonly PushCall[];
}
export interface FirstTouchContext {
  docs: readonly string[] | null;
  specs: readonly string[] | null;
  locks: readonly LiveLockHolding[] | null;
  byPath?: Readonly<Record<string, { docs: readonly string[]; specs: readonly string[] }>>;
}
export interface PushFact {
  leg: PushLegId;
  /** Identifies the fact, not the request; compaction makes it eligible again. */
  subject: string;
  text: string;
  citedPaths: readonly string[];
  suggestedCall?: string;
  sourceHashes?: readonly PushProofSource[];
}
/** WI-6554700010018440: a fact dropped whole for budget, recorded in code_intel_push_skips.
 * `request-budget` = the request's share (1,500 minus the memory block) was strictly the
 * binding limit; `turn-budget` = the turn's own code-intel spend was (including a tie,
 * where memory took nothing and code intelligence filled the turn itself). */
interface PushSkip {
  fact: PushFact;
  chars: number;
  budgetLeft: number;
  site: 'request-budget' | 'turn-budget';
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

export function firstTouchPaths(input: PushInput): string[] {
  return [...new Set(input.calls.flatMap(rawCall => touchedRawPaths(normalizePushCall(rawCall), input.root).flatMap(raw => {
    const path = isAbsolute(raw) ? (input.root ? relative(input.root, raw) : raw) : posix.normalize(raw);
    return safeSnapshotPath(path) ? [path] : [];
  })))].slice(0, 4);
}

/** Existing P-016 anchors and P-015 measurement recipes; these are links, not proof of acceptance. */
export async function readPushSourceLinks(input: PushInput, paths: string[], sql = getOrgPg().sql): Promise<Pick<FirstTouchContext, 'docs' | 'specs' | 'byPath'>> {
  const harness = input.harness;
  if (!harness || !paths.length) return { docs: null, specs: null };
  return sql.begin(async tx => {
    await tx`SELECT set_config('statement_timeout', '75ms', true)`;
    const docs = await tx<{ doc_id: string; anchor_paths: string[] }[]>`SELECT doc_id, anchor_paths FROM harness_shared.harness_docs
      WHERE workspace_id = ${input.workspace} AND harness_slug = ${harness}
        AND anchor_paths && ${paths}::text[] ORDER BY doc_id LIMIT 3`;
    const specs = await tx<{ path: string; plan_slug: string; spec_id: string; spec_revision: number }[]>`
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
      ORDER BY p.path, plan_slug, spec_id, spec_revision DESC LIMIT 12`;
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
export const snapshotFirstTouchLeg: PushLeg = (input, snapshot) =>
  firstTouchPaths(input).flatMap(path => { const fact = firstTouchFact(input, snapshot, path); return fact ? [fact] : []; });
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
  label?: string;
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
    if (diagnostics) diagnostics.phaseOutcomes[phase] = 'error';
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
  if (!input.owner || !input.workspace || !input.harness) return { entries: [] };
  const epoch = await timeResumeReadPhase(diagnostics, 'epoch', () => deps.epoch(input.owner));
  const [previous, foreign, pushed] = await Promise.all([
    timeResumeReadPhase(diagnostics, 'previousWorkingSet', () => deriveCodeWorkingSet(
      { workspace: input.workspace, harness: input.harness, owner: input.owner, which: 'previous', root: input.root },
      { epoch: async () => epoch, signals: query => deps.signals(query) },
    )).catch(() => null),
    timeResumeReadPhase(diagnostics, 'foreignWorkingSets', () => deps.foreign(input.owner, input.workspace, input.harness))
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
  fold: (input, paths) =>
    foldCodeNotesForPaths(
      [{ scope: 'workspace' }, ...(input.harness ? [{ scope: 'harness' as const, scopeRef: input.harness }] : [])],
      paths, { workspaceId: input.workspace }),
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
    facts.push({ leg: 'interface', subject: `${edit.path}:${changes.join('|')}`, citedPaths: [edit.path, ...consumers.slice(0, 2), ...tests.slice(0, 2)], suggestedCall,
      text: `${edit.path}: ${changes.join('; ')}.\nStatic consumers: ${consumers.slice(0, 2).join(', ') || 'unknown'}.`
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
  snapshot(input: PushInput): Promise<PushSnapshot | null>;
  enabled(flag: FlagKey): Promise<boolean>;
  legs(): ReadonlyMap<PushLegId, PushLeg>;
  context?(input: PushInput, paths: string[], diagnostics?: ResumeReadDiagnostics): Promise<FirstTouchContext>;
  incidentContext?(input: PushInput, paths: string[]): Promise<IncidentAttribution>;
  resumeContext?(input: PushInput, diagnostics?: ResumeReadDiagnostics): Promise<ResumeContext>;
  notesContext?(input: PushInput, paths: readonly string[]): Promise<NotesContext>;
  /** `dropped`: facts the request already found too big for `requestBudget`; the commit
   * classifies and records them with its own budget drops (WI-6554700010018440). */
  commit(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[], requestBudget: number, signal: AbortSignal,
    dropped: readonly PushFact[]): Promise<string>;
}

const skipSite = (requestLeft: number, turnLeft: number): PushSkip['site'] =>
  requestLeft < turnLeft ? 'request-budget' : 'turn-budget';

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
      FROM unnest(${skips.map(s => s.fact.leg)}::text[], ${skips.map(s => s.fact.subject)}::text[],
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
  requestBudget: number, signal: AbortSignal, dropped: readonly PushFact[] = []): Promise<string> {
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
    const skips: PushSkip[] = dropped.map(fact => ({ fact, chars: formatPushFact(fact, snapshot).length + 2,
      budgetLeft: Math.max(0, Math.min(requestLeft, turnLeft)), site: skipSite(requestLeft, turnLeft) }));
    const text: string[] = [];
    for (const fact of facts) {
      const block = formatPushFact(fact, snapshot);
      const chars = block.length + 2;
      const left = Math.min(requestLeft, turnLeft);
      if (signal.aborted) throw new Error('code-intel push cancelled');
      if (chars > left) { // Never cut a qualifier or citation off a fact.
        skips.push({ fact, chars, budgetLeft: Math.max(0, left), site: skipSite(requestLeft, turnLeft) });
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

export function formatPushFact(fact: PushFact, snapshot: PushSnapshot): string {
  return `## Code intelligence (${fact.leg})\nSnapshot ${snapshot.commit.slice(0, 12)} · ${snapshot.generatedAt}\n${fact.text}`;
}

const defaults: PushChannelDeps = {
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
  context: async (input, paths, diagnostics) => {
    const [links, locks] = await Promise.allSettled([
      timeResumeReadPhase(diagnostics, 'context.sourceLinks', () => readPushSourceLinks(input, paths)),
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
    ]);
    if (diagnostics?.label === FIRST_TOUCH_CONTEXT_LABEL &&
      Date.now() - diagnostics.startedAtMs >= FIRST_TOUCH_CONTEXT_TIMEOUT_MS) {
      resumeParking.firstTouchSettledReads = (resumeParking.firstTouchSettledReads ?? 0) + 1;
      const hasError = Object.values(diagnostics.phaseOutcomes).includes('error');
      logResumeContextDiagnostic(hasError ? 'warn' : 'info', 'late-settled', diagnostics,
        Date.now() - diagnostics.startedAtMs, FIRST_TOUCH_CONTEXT_TIMEOUT_MS);
    }
    return { ...(links.status === 'fulfilled' ? links.value : { docs: null, specs: null }),
      locks: locks.status === 'fulfilled' ? locks.value : null };
  },
  commit: commitPushFacts,
  incidentContext: readPushIncidentAttribution,
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

/** A failed optional push never drops memory, worn rules, or the failure hint. */
export async function codeIntelPushText(input: PushInput, memoryChars = 0, deps: PushChannelDeps = defaults): Promise<string> {
  if (!input.owner || !input.workspace || !input.calls.length || !deps.legs().size) return '';
  // WI-6554700010018441: every leg classifies the call a `tools:invoke` wrapper dispatched.
  input = { ...input, calls: input.calls.map(normalizePushCall) };
  const requestBudget = Math.max(0, CODE_INTEL_PUSH_TURN_CHARS - Math.max(0, memoryChars));
  if (!requestBudget) return '';
  const result = await withBoundedTimeout(async signal => {
    const snapshot = await deps.snapshot(input);
    if (!snapshot || signal.aborted) return '';
    // The resume read does not depend on any other leg, so it overlaps with them
    // instead of adding its own wait to the 250ms wall (P-003).
    const resumeContext = deps.resumeContext && deps.legs().has('resume') && await deps.enabled(PUSH_LEG_FLAGS.resume)
      ? boundedResumeContext(input, (i, diagnostics) => readResumeWithLinks(i, deps, diagnostics))
        .then(value => ({ value }), () => ({ value: undefined }))
      : null;
    // P-005: same overlap for the code-note read (a fact fold plus a re-hash of the
    // notes' file anchors), started only when this batch first-touched a file.
    const touchedPaths = firstTouchPaths(input);
    const notesContext = deps.notesContext && touchedPaths.length && deps.legs().has('notes') && await deps.enabled(PUSH_LEG_FLAGS.notes)
      ? withBoundedTimeout(() => deps.notesContext!(input, touchedPaths), { timeoutMs: 120, fallback: undefined, label: 'code-intel-notes-context' })
        .catch(() => ({ value: undefined }))
      : null;
    const facts: PushFact[] = [];
    const dropped: PushFact[] = [];
    // Consequences take precedence over a first-touch brief for the same edit.
    for (const [id, leg] of [...deps.legs()].sort(([a], [b]) => Number(b === 'interface') - Number(a === 'interface'))) {
      if (signal.aborted || !await deps.enabled(PUSH_LEG_FLAGS[id])) continue;
      try {
        if (id === 'first-touch' && deps.context && touchedPaths.length) {
          const diagnostics: ResumeReadDiagnostics = {
            readId: randomUUID(), startedAtMs: Date.now(), phaseMs: {},
            phaseOutcomes: { outerContext: 'running' }, label: FIRST_TOUCH_CONTEXT_LABEL,
          };
          const context = await withBoundedTimeout(() => deps.context!(input, touchedPaths, diagnostics),
            { timeoutMs: FIRST_TOUCH_CONTEXT_TIMEOUT_MS, fallback: undefined, label: FIRST_TOUCH_CONTEXT_LABEL, warn: false });
          diagnostics.phaseOutcomes.outerContext = context.reason ?? 'completed';
          diagnostics.phaseMs.outerContext = context.elapsedMs;
          if (context.reason === 'timeout') diagnostics.phaseOutcomes.underlyingCancellation = 'not-supported';
          input.firstTouchContext = context.value;
          const hasPhaseError = Object.values(diagnostics.phaseOutcomes).includes('error');
          if (context.reason) {
            const event = context.reason === 'timeout' ? 'wait-timeout'
              : context.reason === 'error' ? 'read-error' : 'read-aborted';
            logResumeContextDiagnostic('warn', event, diagnostics, context.elapsedMs,
              FIRST_TOUCH_CONTEXT_TIMEOUT_MS, context.errorMessage);
          } else {
            const settledReads = resumeParking.firstTouchSettledReads = (resumeParking.firstTouchSettledReads ?? 0) + 1;
            if (context.elapsedMs >= FIRST_TOUCH_CONTEXT_DIAGNOSTIC_SLOW_MS || hasPhaseError ||
              settledReads % RESUME_CONTEXT_DIAGNOSTIC_SAMPLE_EVERY === 0) {
              logResumeContextDiagnostic(hasPhaseError ? 'warn' : 'info',
                hasPhaseError ? 'read-settled-with-error' : 'read-settled', diagnostics, context.elapsedMs,
                FIRST_TOUCH_CONTEXT_TIMEOUT_MS);
            }
          }
        }
        if (id === 'notes') {
          if (!notesContext) continue;
          // A timed-out read delivers nothing rather than an unverified note.
          input.notesContext = (await notesContext).value ?? { fresh: [], withheld: [] };
        }
        if (id === 'resume') {
          if (!resumeContext) continue;
          input.resumeContext = (await resumeContext).value ?? { entries: [] };
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
            { timeoutMs: 100, fallback: undefined, label: 'code-intel-incident-context' });
          input.incidentAttribution = measured.value ?? { status: 'unknown' };
          candidates = leg(input, snapshot);
        }
        for (const fact of candidates) {
          if (id === 'first-touch' && facts.some(f => f.leg === 'interface' && f.citedPaths[0] === fact.subject)) continue;
          if (fact.leg !== id || fact.subject.length > 1000 || !fact.subject.trim() || !fact.text.trim()
            || !fact.citedPaths.every(safeSnapshotPath)) continue;
          const chars = formatPushFact(fact, snapshot).length + 2;
          // WI-6554700010018440: too big for this request's share, so dropped whole and
          // recorded. Not source-corroborated first: that check costs wall time for a
          // fact that cannot be delivered either way.
          if (chars > requestBudget) {
            if (dropped.length < 12) dropped.push(fact);
            continue;
          }
          if (!fact.sourceHashes || await corroboratePushSources(input.root, fact.sourceHashes, signal)) facts.push(fact);
          if (facts.length >= 12) break;
        }
      } catch (error) { console.warn(`[code-intel-push] ${id} failed:`, String(error).slice(0, 200)); }
      if (facts.length >= 12) break;
    }
    // A request whose only candidates were dropped still commits, to record the skips.
    return (facts.length || dropped.length) && !signal.aborted
      ? deps.commit(input, snapshot, facts, requestBudget, signal, dropped) : '';
  }, { timeoutMs: CODE_INTEL_PUSH_WALL_MS, fallback: '', label: 'code-intel-push' });
  return result.value;
}
