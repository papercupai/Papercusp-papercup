/** P-034/D-016: one code-intelligence leg at the existing PostToolBatch sink. */
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
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
import { corroboratePushSources, peekPushSnapshot, safeSnapshotPath, type PushSnapshot } from './push-snapshot';

export const CODE_INTEL_PUSH_TURN_CHARS = 1_500;
export const CODE_INTEL_PUSH_WALL_MS = 250;
export const PUSH_LEG_FLAGS = {
  grep: FLAGS.CODE_INTEL_PUSH_GREP, 'first-touch': FLAGS.CODE_INTEL_PUSH_FIRST_TOUCH,
  interface: FLAGS.CODE_INTEL_PUSH_INTERFACE, incident: FLAGS.CODE_INTEL_PUSH_INCIDENT,
  completion: FLAGS.CODE_INTEL_PUSH_COMPLETION, intent: FLAGS.CODE_INTEL_PUSH_INTENT,
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
  sourceHashes?: readonly { path: string; sha256: string }[];
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
      SELECT id, state, title, relation, array_agg(path ORDER BY path) AS paths
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

export function firstTouchPaths(input: PushInput): string[] {
  return [...new Set(input.calls.flatMap(call => {
    if (!/(?:^|_|:)(?:Read|Edit|read|edit)$/.test(call.tool ?? '')) return [];
    const args = pushCallInput(call.toolInput);
    const raw = args?.file_path ?? args?.path;
    if (typeof raw !== 'string') return [];
    const path = isAbsolute(raw) && input.root ? relative(input.root, raw) : raw;
    return safeSnapshotPath(path) ? [path] : [];
  }))].slice(0, 4);
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
export const snapshotFirstTouchLeg: PushLeg = (input, snapshot) => {
  const facts: PushFact[] = [];
  for (const path of firstTouchPaths(input)) {
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
    if (!consumers.length && !symbols.length) continue;
    const context = input.firstTouchContext;
    const sourceLinks = context?.byPath?.[path] ?? context;
    const locks = context?.locks?.filter(lock => lock.owner !== input.owner && lock.coordinationDomain === input.root && seen.has(lock.path));
    const suggestedCall = tests.length ? `testing:run ${JSON.stringify({ files: tests.slice(0, 2), harness: input.harness })}` : undefined;
    const exports = symbols.slice(0, 3).map(symbol => `${symbol.name}:${symbol.line} >=${symbol.callers.length} static calls`
      + (symbol.callers.some(site => site.workspace) ? ` [${[...new Set(symbol.callers.map(site => site.workspace ?? 'workspace unknown'))].slice(0, 2).join(', ')}]` : ' [workspace unknown]'));
    const links = (values: readonly string[] | null | undefined) => values?.length ? values.slice(0, 2).join(', ') : 'unknown';
    facts.push({ leg: 'first-touch', subject: path, citedPaths: [path, ...consumers.slice(0, 2), ...tests.slice(0, 2)], suggestedCall,
      text: `${path}: ${consumers.length} static file importers in this snapshot; examples: ${consumers.slice(0, 2).join(', ') || 'unknown'}.`
        + `\nExports (up to 3): ${exports.join('; ') || 'unknown'}.`
        + `\nTests with static import reach${queue.length ? ' (bounded search)' : ''}: ${suggestedCall || 'unknown'}.`
        + `\nAnchored docs: ${links(sourceLinks?.docs)}. Spec evidence links: ${links(sourceLinks?.specs)} (currentness unknown).`
        + `\nLive consumer locks/claims: ${locks?.length ? locks.slice(0, 2).map(lock => `${lock.path}: ${lock.owner}${lock.goalRef ? ' ' + lock.goalRef : ''}`).join('; ') : 'unknown'}.`
        + '\nSnapshot lower bounds only; current source hashes, unindexed exports, dynamic dispatch, untracked anchors, source completeness and runtime execution are unknown.' });
  }
  return facts;
};
registerCodeIntelPushLeg('first-touch', snapshotFirstTouchLeg);

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
export function grepLookupSubject(call: PushCall): string | null {
  const args = pushCallInput(call.toolInput);
  const tool = call.tool ?? '';
  let pattern: string | null = null;
  if (/(?:^|_|:)(?:Grep|grep)$/.test(tool) && typeof args?.pattern === 'string') pattern = args.pattern;
  else {
    const command = args?.command ?? args?.cmd;
    if (typeof command !== 'string' || command.length > 4000) return null;
    const head = command.split(/\n|;|&&|\|/)[0]?.trim() ?? '';
    if (!/^(?:rg|grep|git\s+grep)\s/.test(head)) return null;
    const quoted = /(['"])(.*?)\1/.exec(head);
    pattern = quoted?.[2] ?? head.replace(/^(?:rg|grep|git\s+grep)\s+/, '').split(/\s+/).find(token => !token.startsWith('-')) ?? null;
  }
  if (!pattern) return null;
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
  context?(input: PushInput, paths: string[]): Promise<FirstTouchContext>;
  incidentContext?(input: PushInput, paths: string[]): Promise<IncidentAttribution>;
  commit(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[], requestBudget: number, signal: AbortSignal): Promise<string>;
}

/** One transaction serializes both the turn ceiling and session dedupe across cluster workers. */
export async function commitPushFacts(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[],
  requestBudget: number, signal: AbortSignal): Promise<string> {
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
    const spent = await tx<{ chars: number }[]>`SELECT COALESCE(SUM(chars), 0)::int AS chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} AND turn_id = ${turn}`;
    let left = Math.min(requestBudget, CODE_INTEL_PUSH_TURN_CHARS - Number(spent[0]?.chars ?? 0));
    const text: string[] = [];
    for (const fact of facts) {
      const block = formatPushFact(fact, snapshot);
      const chars = block.length + 2;
      if (signal.aborted) throw new Error('code-intel push cancelled');
      if (chars > left) continue; // Never cut a qualifier or citation off a fact.
      const inserted = await tx<{ id: number }[]>`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, snapshot_generated_at, cited_paths, suggested_call, chars, client)
        VALUES (${input.workspace}, ${input.owner}, ${epoch}, ${turn}, ${fact.leg}, ${fact.subject}, ${snapshot.commit},
          ${snapshot.generatedAt}::timestamptz, ${[...fact.citedPaths]}::text[], ${fact.suggestedCall ?? null}, ${chars}, ${input.client ?? null})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING RETURNING id`;
      if (inserted.length) { text.push(block); left -= chars; }
    }
    if (signal.aborted) throw new Error('code-intel push cancelled');
    return text.join('\n\n');
  });
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
  context: async (input, paths) => {
    const [links, locks] = await Promise.allSettled([readPushSourceLinks(input, paths), liveLockHoldingsStrict()]);
    return { ...(links.status === 'fulfilled' ? links.value : { docs: null, specs: null }),
      locks: locks.status === 'fulfilled' ? locks.value : null };
  },
  commit: commitPushFacts,
  incidentContext: readPushIncidentAttribution,
};

/** A failed optional push never drops memory, worn rules, or the failure hint. */
export async function codeIntelPushText(input: PushInput, memoryChars = 0, deps: PushChannelDeps = defaults): Promise<string> {
  if (!input.owner || !input.workspace || !input.calls.length || !deps.legs().size) return '';
  const requestBudget = Math.max(0, CODE_INTEL_PUSH_TURN_CHARS - Math.max(0, memoryChars));
  if (!requestBudget) return '';
  const result = await withBoundedTimeout(async signal => {
    const snapshot = await deps.snapshot(input);
    if (!snapshot || signal.aborted) return '';
    const facts: PushFact[] = [];
    // Consequences take precedence over a first-touch brief for the same edit.
    for (const [id, leg] of [...deps.legs()].sort(([a], [b]) => Number(b === 'interface') - Number(a === 'interface'))) {
      if (signal.aborted || !await deps.enabled(PUSH_LEG_FLAGS[id])) continue;
      try {
        if (id === 'first-touch' && deps.context && firstTouchPaths(input).length) {
          const context = await withBoundedTimeout(() => deps.context!(input, firstTouchPaths(input)),
            { timeoutMs: 100, fallback: undefined, label: 'code-intel-first-touch-context' });
          input.firstTouchContext = context.value;
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
          if (fact.leg === id && fact.subject.length <= 1000 && fact.subject.trim() && fact.text.trim()
            && fact.citedPaths.every(safeSnapshotPath)
            && formatPushFact(fact, snapshot).length + 2 <= requestBudget
            && (!fact.sourceHashes || await corroboratePushSources(input.root, fact.sourceHashes, signal))) facts.push(fact);
          if (facts.length >= 12) break;
        }
      } catch (error) { console.warn(`[code-intel-push] ${id} failed:`, String(error).slice(0, 200)); }
      if (facts.length >= 12) break;
    }
    return facts.length && !signal.aborted ? deps.commit(input, snapshot, facts, requestBudget, signal) : '';
  }, { timeoutMs: CODE_INTEL_PUSH_WALL_MS, fallback: '', label: 'code-intel-push' });
  return result.value;
}
