/** P-012: one bounded task brief at the existing claim/resume seam; no cache or store. */
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import * as ts from 'typescript';
import { loadHarnessRegistry } from '../harness-registry';
import { activeWorkspaceId } from '../workspace-registry';
import type { ClaimTimeEnrichmentSubject } from '../claim-time-enrichment';
import { deriveRepoPathsFromText } from '../agent-tools/work_items/_derive-paths';
import { DEFAULT_PACKER_EFFECTS, nativeChangeReport, packerFacade, type ChangeReportEffects, type ChangeReportRequest,
  type PackerEffects, type PackerPhase, type PackerResult } from './packer-facade';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { pushSnapshotMissReason, queryPushSnapshot } from './push-snapshot';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import type { CodeIntelAnswer } from './contracts';
import { getClaimTimePlanDecisions, type ClaimTimePlanDecisionsBrief } from '../plan-decisions-claim-port';
import { pinModuleState } from '@papercusp/module-singleton';
import { composeReuseBrief, encodeClaimReuseContribution, registeredReuseBriefProviders, type ReuseBriefDestination, type ReuseBriefProvider,
  type ReuseContribution, type ReuseProviderContext, type ReuseProviderObservation } from './reuse-brief-providers';
import { recordReuseBriefIssued, type ReuseIssuedRecord } from './reuse-brief-ledger';
import { boundChangeHistoryProviders, changeHistoryProviders, readWarmCoChange, type PriorWorkReader } from './change-history';
import { readTaskEngineeringEvidence, type TaskEngineeringEvidence } from './task-brief-engineering';
import type { EngineeringQuery, readEngineeringEvidence } from './engineering-evidence';
import { withBoundedTimeout } from '../bounded-timeout';
import type { CoverageScopeData } from './test-coverage-map';
import { canCall, readRecipientToolset, type RecipientToolset } from './push-toolset';

export const TASK_BRIEF_BUDGET_MS = 6_000;
export const TASK_BRIEF_MAX_CHARS = 3_000;
const MAX_FILES = 12;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Ref = { workItem?: ClaimTimeEnrichmentSubject | null; harness?: string | null; workspaceId?: string | null;
  intent?: string; paths?: readonly string[]; reuse?: ClaimBriefReuseIdentity; maxChars?: number;
  /** The recipient session; its listed tools decide which recovery calls the brief may name. */
  owner?: string;
  /** Optional per-invocation timing sink; bounded by the scheduler before persistence. */
  onTiming?: (timing: { phase: string; elapsedMs: number; outcome: 'ok' | 'unknown' | 'error' }) => void };
export interface ClaimBriefReuseIdentity {
  owner: string;
  invocation: string;
  observe?: (outcome: { context: ReuseProviderContext; observations: ReuseProviderObservation[];
    recover: ReuseIssuedRecord['recover']; ledger: 'not-needed' | 'recorded' | 'unknown' }) => void;
}
export type TaskBriefReuseAdapter = (base: TaskBrief, value: ReuseContribution) => TaskBrief;
const reuseAdapters = pinModuleState('operator-core.task-brief-reuse-adapters.v1',
  () => new Map<ReuseBriefDestination, TaskBriefReuseAdapter>());
/** The upstream section owner installs a representation adapter once that slot exists. */
export function registerTaskBriefReuseAdapter(section: ReuseBriefDestination, adapter: TaskBriefReuseAdapter): () => void {
  if (reuseAdapters.has(section)) throw new Error(`Task brief destination already registered: ${section}`);
  reuseAdapters.set(section, adapter);
  return () => { if (reuseAdapters.get(section) === adapter) reuseAdapters.delete(section); };
}
export interface TaskFailureSignal {
  testRunId: number;
  path: string;
  status: 'fail' | 'error';
  commit: string | null;
  logSha256: string | null;
}
export interface TaskIncidentBrief {
  status: 'measured' | 'unknown';
  cause: 'unknown';
  failures: TaskFailureSignal[];
  candidates: { path: string; basis: 'failed-test' | 'static-relationship'; causation: 'unverified' }[];
  recentChanges: string[];
  recentChangesStatus: 'measured' | 'unknown';
  workRecord: string;
  runtimeExecution: 'unmeasured';
  /** Withheld when the recipient was not listed the tool; the run ids stay inline. */
  recover?: { tool: 'testing:runs'; args: { testRunIds: number[]; harness: string } }
    | { tool: 'work_items:get'; args: { id: string; harness: string } };
  limitations: string[];
}
export interface TaskBrief {
  status: 'current' | 'unknown';
  intent?: { text: string; fingerprint: string };
  scope: { harness: string | null; paths: string[] };
  repository?: { workspaceId: string; rootPath: string };
  decisions?: { status: 'measured' | 'unknown'; refs: { plan: string; id: string }[];
    recover?: { tool: 'plans:get'; args: { slug: string; harness: string; heading: 'Decisions' } } };
  sourceFingerprint: string | null;
  commit: string | null;
  files: { path: string; sha256: string; kind: 'implementation' | 'test' | 'doc' }[];
  excerpts: { path: string; text: string }[];
  graph: { status: 'measured' | 'unknown'; consumers: string[]; relationships: string[]; reason?: string };
  incident?: TaskIncidentBrief;
  engineering?: TaskEngineeringEvidence;
  exclusions: string[];
  /** P-006 (SPEC-P-006-B): every recovery call in a delivered brief is withheld unless the
   * recipient session was listed its tool (see gateTaskBriefRecover). */
  recover?: { tool: 'code:pack'; args: { op: 'pack'; include: string[]; rootPath: string } }
    | { tool: 'work_items:get'; args: { id: string; harness?: string } }
    | { tool: 'coord:declare-intent'; args: { intent: string; current_files: string[]; harness?: string } };
}
export interface TaskBriefDeps {
  root: (workspaceId: string, harness: string) => Promise<string | null>;
  effects: PackerEffects;
  pack: typeof packerFacade;
  graph: (root: string, name: string, file: string, paths: string[], budgetMs: number) => Promise<CodeIntelAnswer>;
  decisions?: (ref: Ref) => Promise<ClaimTimePlanDecisionsBrief | null>;
  failures?: (scope: { workspaceId: string; harness: string; root: string; paths: string[] }) => Promise<TaskFailureSignal[]>;
  /** WI-6554700010030367: the repository paths the owner's held, non-terminal claims
   * already cover (see claimedScopePaths). Throws when ownership is unreadable. */
  claimedPaths?: (workspaceId: string, owner: string) => Promise<readonly string[]>;
  engineering?: typeof readEngineeringEvidence;
  reuse?: {
    providers?: readonly ReuseBriefProvider[];
    adapters?: Partial<Record<ReuseBriefDestination, TaskBriefReuseAdapter>>;
    recordIssued?: (input: ReuseIssuedRecord, signal: AbortSignal) => Promise<boolean>;
    /** P-008: the shared prior-work reader behind the claim brief's provenance section. */
    priorWork?: PriorWorkReader;
  };
  /** P-006: the recipient's last listed toolset. Absent means the durable listing reader. */
  toolset?: (input: { workspace: string; owner: string }) => Promise<RecipientToolset>;
}
const defaults: TaskBriefDeps = {
  toolset: readRecipientToolset,
  engineering: async (query, scope) => (await import('./engineering-evidence')).readEngineeringEvidence(query, scope),
  claimedPaths: async (workspaceId, owner) => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { ANY_FAMILY_TERMINAL_STATES } = await import('../work-item-dispatch-states');
    const rows = await getOrgPg().sql<{ title: string | null; summary: string | null; payload: unknown }[]>`
      SELECT title, summary, jsonb_build_object('paths', payload->'paths') AS payload
        FROM harness_shared.work_items WHERE workspace_id = ${workspaceId}
         AND taken_by = ${owner} AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       LIMIT 100`;
    return claimedScopePaths(rows);
  },
  root: async (workspaceId, harness) =>
    (await loadHarnessRegistry(workspaceId)).projects.find(project => project.slug === harness)?.path ?? null,
  effects: DEFAULT_PACKER_EFFECTS,
  pack: packerFacade,
  graph: (root, name, filePath, paths, budgetMs) => firstPartyCallersOffthread({
    root, vendorDir: LSP_VENDOR_DIR, name, filePath, paths, op: 'callers', limit: 8,
  }, { budgetMs }),
  decisions: ref => getClaimTimePlanDecisions({ workItem: ref.workItem ? { payload: ref.workItem.payload } : undefined,
    planSlug: ref.workItem?.sourcePlanSlug, harness: ref.workItem?.harness ?? ref.harness,
    workspaceId: ref.workspaceId ?? activeWorkspaceId() }),
  failures: async scope => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // Latest normal run per selected file: a repaired test must not retain an old
    // red, and deliberate mutation failures are not production incidents.
    const rows = await sql<{ id: string; file_path: string; status: 'fail' | 'error'; commit_sha: string | null; output_tail: string | null }[]>`
      SELECT id, file_path, status, commit_sha, output_tail FROM (
        SELECT DISTINCT ON (file_path) id, file_path, status, commit_sha, output_tail, execution_details
        FROM harness_shared.test_runs
        WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
          AND source = 'local' AND file_path = ANY(${scope.paths}::text[])
          AND execution_details->>'root' = ${scope.root}
        ORDER BY file_path, id DESC
      ) latest WHERE status IN ('fail', 'error')
      ORDER BY id DESC LIMIT 3`;
    return rows.map(row => ({ testRunId: Number(row.id), path: row.file_path, status: row.status,
      commit: row.commit_sha, logSha256: row.output_tail ? hash(row.output_tail) : null }));
  },
};
/** The same scoped ledger reader used by claim/resume, also exercised in isolated PG tests. */
export const readTaskFailureSignals = defaults.failures!;
const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
const safePath = (path: string) => Boolean(path.trim()) && path !== '.' && !isAbsolute(path)
  && !path.startsWith('-') && !/[\\\r\n\0*?\[\]{},]/.test(path)
  && !path.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'));
const kindOf = (path: string): TaskBrief['files'][number]['kind'] =>
  /\.(?:md|mdx)$/.test(path) ? 'doc' : /(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\./.test(path) ? 'test' : 'implementation';

/** An observed failure and a static connection prioritize hypotheses, never prove a cause. */
export function taskIncidentBrief(input: {
  workItemId: string; harness: string; paths: string[]; failures: TaskFailureSignal[] | null;
  consumers: string[]; recentChanges: string[];
}): TaskIncidentBrief {
  const selected = new Set(input.paths);
  const failures = (input.failures ?? []).filter(row => selected.has(row.path) && safePath(row.path)
    && Number.isSafeInteger(row.testRunId) && row.testRunId > 0 && ['fail', 'error'].includes(row.status)).slice(0, 3)
    .map(row => ({ testRunId: row.testRunId, path: row.path, status: row.status, commit: row.commit, logSha256: row.logSha256 }));
  const candidates: TaskIncidentBrief['candidates'] = failures.map(row => ({ path: row.path, basis: 'failed-test', causation: 'unverified' }));
  if (failures.length) for (const consumer of input.consumers) {
    const path = consumer.replace(/:\d+$/, '');
    if (selected.has(path) && safePath(path) && !candidates.some(candidate => candidate.path === path)) {
      candidates.push({ path, basis: 'static-relationship', causation: 'unverified' });
    }
  }
  const recentChanges = input.recentChanges.filter(sha => /^[a-f0-9]{40,64}$/i.test(sha)).slice(0, 3);
  return { status: input.failures === null ? 'unknown' : 'measured', cause: 'unknown', failures,
    candidates: candidates.slice(0, 6), recentChanges, recentChangesStatus: recentChanges.length ? 'measured' : 'unknown',
    workRecord: input.workItemId, runtimeExecution: 'unmeasured',
    recover: failures.length
      ? { tool: 'testing:runs', args: { testRunIds: failures.map(row => row.testRunId), harness: input.harness } }
      : { tool: 'work_items:get', args: { id: input.workItemId, harness: input.harness } },
    limitations: ['Selected task files and their latest normal test runs only; graph paths and recent edits are candidate causes.',
      'Failure-log hashes identify recorded errors; no distinguishing causal test or runtime execution was measured.'] };
}

/** The toolset read starts beside the brief build, so this bound adds latency only when
 * the build finishes first. A slow or failed read is unknown, and unknown names no tool. */
const TOOLSET_READ_MS = 400;
function readBriefToolset(read: TaskBriefDeps['toolset'], workspace: string, owner: string | undefined): Promise<RecipientToolset> {
  if (!owner?.trim()) return Promise.resolve({ status: 'unknown', reason: 'no-owner' });
  const failed: RecipientToolset = { status: 'unknown', reason: 'read-failed' };
  return withBoundedTimeout(() => (read ?? readRecipientToolset)({ workspace, owner }), {
    // The fallback is an expected outcome (no listing yet, a slow read): it withholds calls, it is not an error.
    timeoutMs: TOOLSET_READ_MS, fallback: failed, label: 'task-brief:recipient-toolset', warn: false,
  }).then(result => result.value, () => failed);
}

/** P-006 (SPEC-P-006-B): a delivered brief names a recovery call only when the recipient
 * session was listed its tool. The evidence itself stays inline; only the follow-up call is
 * dropped. Mutates and returns `brief`. */
type RecoveryCall = { recover?: { tool: string } };
export function gateTaskBriefRecover<B extends RecoveryCall & { decisions?: RecoveryCall; incident?: RecoveryCall;
  engineering?: RecoveryCall }>(brief: B, toolset: RecipientToolset): B {
  const callable = (call: { tool: string } | undefined) => Boolean(call && canCall(toolset, call.tool));
  if (!callable(brief.recover)) delete brief.recover;
  if (brief.decisions && !callable(brief.decisions.recover)) delete brief.decisions.recover;
  if (brief.incident && !callable(brief.incident.recover)) delete brief.incident.recover;
  if (brief.engineering && !callable(brief.engineering.recover)) delete brief.engineering.recover;
  return brief;
}

/** Fit optional evidence to its caller's budget without changing measured scope. */
export function compactTaskBrief(input: TaskBrief, maxChars = TASK_BRIEF_MAX_CHARS): TaskBrief {
  const brief = structuredClone(input);
  const oversized = () => JSON.stringify(brief).length > maxChars;
  if (oversized()) brief.exclusions.push('Additional inline evidence omitted; use the scoped recovery readers.');
  while (oversized() && brief.excerpts.length) brief.excerpts.pop();
  while (oversized() && brief.graph.relationships.length) brief.graph.relationships.pop();
  while (oversized() && brief.graph.consumers.length) brief.graph.consumers.pop();
  while (oversized() && brief.files.length > 1) brief.files.pop();
  while (oversized() && brief.decisions?.refs.length) brief.decisions.refs.pop();
  while (oversized() && brief.incident?.recentChanges.length) brief.incident.recentChanges.pop();
  while (oversized() && brief.incident && brief.incident.candidates.length > 1) brief.incident.candidates.pop();
  if (oversized() && brief.incident) { delete brief.incident; brief.exclusions.push('Incident evidence omitted by the inline budget; use the test-run ledger.'); }
  if (oversized() && brief.engineering) {
    brief.engineering.gaps.unshift('additional-evidence-omitted');
    for (const axis of ['validation', 'rationale', 'intent', 'execution'] as const)
      while (oversized() && brief.engineering[axis].length) brief.engineering[axis].pop();
    if (oversized()) brief.engineering.gaps = ['Inline evidence omitted; use the scoped graph reader.'];
  }
  return brief;
}

function taskItemQuery(workItem?: ClaimTimeEnrichmentSubject | null): EngineeringQuery | null {
  const payload = workItem?.payload as { plan_item?: { plan_slug?: string; item_id?: string } } | null;
  const plan = workItem?.sourcePlanSlug ?? payload?.plan_item?.plan_slug;
  const item = workItem?.sourcePlanItemIds?.[0] ?? payload?.plan_item?.item_id;
  return plan && item && /^P-\d{3,}$/.test(item) ? { item: { plan, id: item } } : null;
}

async function taskEngineering(ref: Ref, root: string, paths: readonly string[], deps: Pick<TaskBriefDeps, 'engineering'>,
  deadline: number): Promise<TaskEngineeringEvidence | undefined> {
  if (!deps.engineering) return undefined;
  let query = taskItemQuery(ref.workItem);
  if (!query) {
    const path = paths.find(path => safePath(path) && /\.[cm]?[jt]sx?$/.test(path) && kindOf(path) === 'implementation');
    if (!path) return undefined;
    const absolute = await realpath(join(root, path)).catch(() => null);
    const info = absolute && await stat(absolute).catch(() => null);
    if (!absolute || !inside(root, absolute) || !info || info.size > 64_000) return undefined;
    const text = await readFile(absolute, 'utf8').catch(() => null);
    if (text === null) return undefined;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name);
    if (!declaration || (!ts.isFunctionDeclaration(declaration) && !ts.isClassDeclaration(declaration)) || !declaration.name) return undefined;
    query = { symbol: { path, name: declaration.name.text } };
  }
  return readTaskEngineeringEvidence(query, { workspaceId: ref.workspaceId ?? activeWorkspaceId(),
    harness: ref.workItem?.harness ?? ref.harness!, root }, deps.engineering, Math.max(0, Math.min(1_000, deadline - Date.now())));
}

/** Repository paths named in a work item's own text (title + summary, which holds
 * the plan-item text for promoted items). With `root`, only paths that exist
 * inside that registered repository survive. */
export function itemTextPaths(wi: ClaimTimeEnrichmentSubject | null | undefined, root?: string): string[] {
  const text = [wi?.title, wi?.summary].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
  return deriveRepoPathsFromText(text, { max: 8, ...(root ? { repoRoot: root } : {}) });
}

const normalizeScopePath = (path: string) => posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '');

/** WI-6554700010030367: the scope a set of held items covers, resolved the way
 * buildTaskBrief scopes each one: stored payload.paths, else the repository paths
 * the item's own text names. */
export function claimedScopePaths(items: readonly Pick<ClaimTimeEnrichmentSubject, 'title' | 'summary' | 'payload'>[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    const payload = item.payload as { paths?: unknown } | null | undefined;
    const stored = Array.isArray(payload?.paths) ? payload.paths.filter((path): path is string => typeof path === 'string') : [];
    for (const path of stored.length ? stored : itemTextPaths(item)) out.add(normalizeScopePath(path));
  }
  return [...out];
}

/** The capture phase in flight; a deadline fallback reports it so a timeout is diagnosable. */
export type TaskBriefPhase = 'setup' | 'repository-root' | 'plan-decisions' | 'scope-read' | 'safe-pack'
  | `safe-pack:${PackerPhase}` | 'compiler-wait' | 'incident' | 'source-recheck';

/** Native fixtures observe the existing capture clock without changing the inline brief. */
export const TASK_BRIEF_CAPTURE_CHANNEL = 'papercusp.code-intelligence.task-brief.capture';
export interface TaskBriefCaptureTiming {
  workItem: string | null;
  status: TaskBrief['status'];
  elapsedMs: number;
  phases: Array<{ phase: TaskBriefPhase; elapsedMs: number }>;
}
const captureDiagnostics = channel(TASK_BRIEF_CAPTURE_CHANNEL);

/** Root authority is the workspace registry, never payload.rootPath or operator cwd. */
export async function buildTaskBrief(ref: Ref, deps: TaskBriefDeps = defaults,
  phase: { current: TaskBriefPhase } = { current: 'setup' },
  deadline = Date.now() + TASK_BRIEF_BUDGET_MS): Promise<TaskBrief> {
  const wi = ref.workItem;
  const harness = wi?.harness ?? ref.harness ?? null;
  const payload = wi?.payload as { paths?: unknown } | null;
  const stored = Array.isArray(payload?.paths) ? payload.paths.filter((path): path is string => typeof path === 'string') : [...(ref.paths ?? [])];
  // WI-6554700010030367: most plan-created items never carry payload.paths, so
  // fall back to the repository paths their own text names (re-checked against
  // the registered root below, so a not-yet-created file is dropped, never read).
  const scopeFromText = stored.length === 0 && Boolean(wi?.id);
  let requested = scopeFromText ? itemTextPaths(wi) : stored;
  const recover: TaskBrief['recover'] = wi?.id
    ? { tool: 'work_items:get', args: { id: wi.id, ...(harness ? { harness } : {}) } }
    : { tool: 'coord:declare-intent', args: { intent: ref.intent?.slice(0, 500) ?? '', current_files: requested.slice(0, 8),
      ...(harness ? { harness } : {}) } };
  const brief: TaskBrief = {
    status: 'unknown', scope: { harness, paths: [] }, sourceFingerprint: null, commit: null,
    ...(ref.intent ? { intent: { text: ref.intent.slice(0, 200),
      fingerprint: hash(JSON.stringify([ref.intent, [...new Set(requested)].sort()])) } } : {}),
    files: [], excerpts: [], graph: { status: 'unknown', consumers: [], relationships: [] }, exclusions: [],
    recover,
  };
  const finish = () => {
    const bounded = compactTaskBrief(brief);
    // Long repository paths can consume the budget even without excerpts. Keep
    // the scoped pack reader and a measured card before omitting the whole brief.
    if (JSON.stringify(bounded).length > TASK_BRIEF_MAX_CHARS) {
      bounded.files = []; bounded.excerpts = []; bounded.scope.paths = [];
      bounded.status = 'unknown'; bounded.sourceFingerprint = null; bounded.commit = null;
      bounded.graph = { status: 'unknown', consumers: [], relationships: [], reason: 'Task scope could not fit the inline budget.' };
      delete bounded.repository; delete bounded.decisions; delete bounded.incident;
      bounded.exclusions = ['Task scope exceeded the inline brief budget; use the recovery reader.'];
      bounded.recover = recover;
    }
    return bounded;
  };
  if ((!wi?.id && !ref.intent) || !harness || requested.length === 0) {
    brief.exclusions.push('No identified work item, registered harness, or stored payload.paths; no repository scope was inferred.');
    return finish();
  }
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('task brief deadline exceeded');
    return ms;
  };
  const effects: PackerEffects = { ...deps.effects,
    onPhase: value => { phase.current = `safe-pack:${value}`; deps.effects.onPhase?.(value); },
    exec: (bin, argv, opts) => deps.effects.exec(bin, argv, {
      ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? TASK_BRIEF_BUDGET_MS, remaining()),
      maxBuffer: Math.min(opts?.maxBuffer ?? 262144, 262144),
    }),
  };
  try {
    const workspaceId = ref.workspaceId ?? activeWorkspaceId();
    phase.current = 'repository-root';
    const registered = await deps.root(workspaceId, harness);
    if (!registered) throw new Error('harness is not registered in the task workspace');
    const root = await realpath(registered);
    brief.repository = { workspaceId, rootPath: root };
    if (scopeFromText) {
      requested = itemTextPaths(wi, root);
      brief.exclusions.push(requested.length > 0
        ? 'Task scope was inferred from repository paths named in the work item text; store payload.paths for an exact scope.'
        : 'The work item text names no existing repository path; no repository scope was inferred.');
      if (requested.length === 0) return finish();
    }
    const planPayload = wi?.payload as { plan_item?: { plan_slug?: string } } | null;
    const planSlug = wi?.sourcePlanSlug ?? planPayload?.plan_item?.plan_slug;
    if (planSlug) {
      phase.current = 'plan-decisions';
      const authority = await deps.decisions?.({ ...ref, workspaceId, harness }).catch(() => null);
      brief.decisions = { status: authority && !authority.authorityReadFailed ? 'measured' : 'unknown',
        refs: authority?.decisions.slice(0, 8).map(decision => ({ plan: decision.sourcePlanSlug ?? authority.planSlug, id: decision.id })) ?? [],
        recover: { tool: 'plans:get', args: { slug: planSlug, harness, heading: 'Decisions' } } };
      if (!authority || authority.authorityReadFailed || authority.totalDecisions > brief.decisions.refs.length) {
        brief.exclusions.push('Governing decision bodies or unread authority remain at the canonical plan reader.');
      }
    }
    phase.current = 'scope-read';
    let incompleteDeclaredScope = false;
    for (const path of [...new Set(requested)].slice(0, 8)) {
      if (!safePath(path)) {
        brief.exclusions.push('Rejected unsafe, hidden, or unbounded stored task path.');
        if (!scopeFromText) incompleteDeclaredScope = true;
        continue;
      }
      try {
        const abs = await realpath(join(root, path));
        if (!inside(root, abs)) {
          brief.exclusions.push('Rejected task path escaping its registered repository.');
          if (!scopeFromText) incompleteDeclaredScope = true;
          continue;
        }
        if ((await stat(abs)).isDirectory()) {
          const { stdout } = await effects.exec('rg', ['--files', '--', path], { cwd: root });
          const expanded = stdout.split(/\r?\n/).filter(Boolean);
          if (expanded.length === 0 && !scopeFromText) incompleteDeclaredScope = true;
          brief.scope.paths.push(...expanded);
        } else brief.scope.paths.push(path);
      } catch {
        brief.exclusions.push('A stored task path is unavailable.');
        if (!scopeFromText) incompleteDeclaredScope = true;
      }
    }
    if (incompleteDeclaredScope) {
      brief.scope.paths = [];
      brief.exclusions.push('The declared task scope is incomplete; no partial file brief was emitted.');
      return finish();
    }
    if (requested.length > 8 || brief.scope.paths.length > MAX_FILES) brief.exclusions.push('Additional task paths omitted by the bounded selection.');
    const candidates = [...new Set(brief.scope.paths)].filter(safePath).sort().slice(0, MAX_FILES);
    brief.scope.paths = [];
    const texts = new Map<string, string>();
    for (const path of candidates) {
      const abs = await realpath(join(root, path));
      if (!inside(root, abs) || (await stat(abs)).size > 64_000) { brief.exclusions.push('Escaping or oversized task source omitted.'); continue; }
      // Metadata may cover docs and tests, but no source excerpt is emitted before safe packing.
      texts.set(path, await readFile(abs, 'utf8'));
      brief.scope.paths.push(path);
    }
    if (!brief.scope.paths.length) throw new Error('no accessible bounded task files');
    brief.recover = { tool: 'code:pack', args: { op: 'pack', include: brief.scope.paths, rootPath: root } };
    const before = hash(JSON.stringify([...texts].map(([path, text]) => [path, hash(text)])));
    const implementation = [...texts.keys()].find(path => {
      if (kindOf(path) !== 'implementation' || !/\.[cm]?[jt]sx?$/.test(path)) return false;
      const source = ts.createSourceFile(path, texts.get(path)!, ts.ScriptTarget.Latest, true);
      return source.statements.some(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name);
    });
    const source = implementation && ts.createSourceFile(implementation, texts.get(implementation)!, ts.ScriptTarget.Latest, true);
    const declaration = source && source.statements.find(statement =>
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name);
    const name = declaration && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) ? declaration.name?.text : null;
    // Packing and compilation consume the SAME bounded capture window. Starting
    // the optional worker after packing gave a cold worker only two seconds even
    // when its answer could fit the whole brief deadline. Publish its result only
    // after safe packing and the final source-byte recheck both succeed.
    const compilerMs = Math.max(0, deadline - Date.now() - 250);
    const compiler = implementation && name && compilerMs > 0
      ? deps.graph(root, name, implementation, brief.scope.paths, compilerMs).catch(() => null)
      : Promise.resolve(null);
    const failures = wi?.id && deps.failures
      ? deps.failures({ workspaceId, harness, root, paths: brief.scope.paths.filter(path => kindOf(path) === 'test') }).catch(() => null)
      : null;
    phase.current = 'safe-pack';
    const packed: PackerResult = await deps.pack('pack', {
      rootPath: root, include: brief.scope.paths, format: 'xml', compress: false,
    }, effects);
    phase.current = 'source-recheck';
    if (packed.answer.error || !packed.artifact?.path) throw new Error(packed.answer.error ?? 'safe pack unavailable');
    const after = await Promise.all([...texts.keys()].map(async path => [path, hash(await readFile(join(root, path), 'utf8'))]));
    if (hash(JSON.stringify(after)) !== before) throw new Error('task source changed while packing; re-read before using excerpts');
    brief.sourceFingerprint = before;
    brief.commit = packed.artifact.provenance.commit;
    const included = new Set(packed.answer.sites.map(site => site.path));
    brief.files = [...texts].filter(([path]) => included.has(path)).map(([path, text]) => ({ path, sha256: hash(text), kind: kindOf(path) }));
    const body = await readFile(packed.artifact.path, 'utf8');
    for (const match of body.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)) {
      if (included.has(match[1]!) && brief.files.some(file => file.path === match[1])) {
        brief.excerpts.push({ path: match[1]!, text: match[2]!.trim().slice(0, 350) });
      }
    }
    for (const path of texts.keys()) if (!included.has(path)) brief.exclusions.push('A scoped file was excluded by the safe packer.');
    if (implementation && brief.files.some(file => file.path === implementation)) {
      brief.excerpts.sort((a, b) => Number(b.path === implementation) - Number(a.path === implementation));
      if (name) {
        // Compiler enrichment is optional. Reserve time to recheck the captured
        // source and finish the brief; worker termination can outlast its deadline.
        const waitMs = Math.max(0, deadline - Date.now() - 250);
        let graph: CodeIntelAnswer | null = null;
        let compilerTimer: ReturnType<typeof setTimeout> | undefined;
        if (waitMs > 0) {
          phase.current = 'compiler-wait';
          try {
            graph = await Promise.race([
              compiler,
              new Promise<null>(resolve => { compilerTimer = setTimeout(() => resolve(null), waitMs); }),
            ]);
          } finally { clearTimeout(compilerTimer); }
        }
        const scope = graph?.evidence?.sourceScope;
        if (graph && !graph.error && scope?.repositoryId && scope.supportingFiles.length
          && scope.supportingFiles.every(file => texts.has(file.path) && file.contentHash === hash(texts.get(file.path)!))) {
          brief.graph = { status: 'measured', consumers: graph.sites.filter((site, index) => texts.has(site.path)
            && graph.evidence?.relationships.some(edge => edge.siteIndex === index && edge.knowledge === 'observed'))
            .map(site => `${site.path}:${site.line1 ?? '?'}`),
            relationships: (graph.evidence?.relationships ?? []).slice(0, 8).map(edge => `${edge.knowledge}:${edge.kind}:${edge.source?.site.path ?? '?'}->${edge.target?.site.path ?? '?'}`) };
          if (graph.truncation.truncated) brief.exclusions.push('Additional compiler sites omitted by the bounded query.');
        } else brief.graph.reason = graph?.error?.slice(0, 180) ?? (graph
          ? 'Compiler evidence is unavailable or outside the measured task files.'
          : 'Compiler enrichment exceeded its remaining budget or was unavailable.');
      } else brief.graph.reason = 'No named function or class in the bounded implementation scope.';
    } else brief.graph.reason = 'No supported implementation in the stored task scope.';
    remaining();
    if (failures && wi?.id) {
      phase.current = 'incident';
      let incidentTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const signals = await Promise.race([failures, new Promise<null>(resolve => {
          incidentTimer = setTimeout(() => resolve(null), Math.min(250, Math.max(0, deadline - Date.now() - 25)));
        })]);
        let recentChanges: string[] = [];
        if (signals?.length && deadline - Date.now() > 100) {
          recentChanges = await effects.exec('git', ['log', '-3', '--format=%H', '--', ...brief.files.map(file => file.path)],
            { cwd: root, timeoutMs: Math.min(100, remaining()) }).then(result => result.stdout.trim().split(/\r?\n/)).catch(() => []);
        }
        brief.incident = taskIncidentBrief({ workItemId: wi.id, harness, paths: brief.files.map(file => file.path),
          failures: signals, consumers: brief.graph.consumers, recentChanges });
      } finally { clearTimeout(incidentTimer); }
    }
    remaining();
    // Optional incident reads also belong to the capture window. Recheck AFTER
    // they finish, so their latency cannot publish an already-edited source pin.
    phase.current = 'source-recheck';
    const final = await Promise.all([...texts.keys()].map(async path => {
      if (!inside(root, await realpath(join(root, path)))) throw new Error('task source escaped during capture');
      return [path, hash(await readFile(join(root, path), 'utf8'))];
    }));
    remaining();
    if (hash(JSON.stringify(final)) !== before) throw new Error('task source changed during compiler capture; re-read the brief');
    brief.status = 'current';
    brief.exclusions.push('Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution.');
    return finish();
  } catch (error) {
    brief.files = []; brief.excerpts = []; brief.sourceFingerprint = null; delete brief.incident;
    brief.graph = { status: 'unknown', consumers: [], relationships: [], reason: 'No current compiler evidence.' };
    brief.exclusions.push(error instanceof Error ? error.message.slice(0, 220) : 'task brief unavailable');
    return finish();
  }
}

export async function getClaimTimeTaskBrief(ref: Ref, deps: TaskBriefDeps = defaults): Promise<{ taskBrief: TaskBrief } | null> {
  const payload = ref.workItem?.payload as { paths?: unknown } | null;
  if (ref.workItem?.id ? (!Array.isArray(payload?.paths) || payload.paths.length === 0) && !taskItemQuery(ref.workItem)
    && itemTextPaths(ref.workItem).length === 0
    : !ref.intent || !ref.paths?.length) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each phase transition is timed so a deadline fallback says how the window
  // was spent, not only where it ended (WI-6554700010018774: a claim-path
  // safe-pack timeout that a standalone re-run could not reproduce).
  const started = Date.now();
  const spent: Array<[TaskBriefPhase, number]> = [];
  let timingOutcome: 'ok' | 'unknown' | 'error' = 'error';
  let current: TaskBriefPhase = 'setup', enteredAt = started;
  const phase = {
    get current() { return current; },
    set current(next: TaskBriefPhase) {
      const at = Date.now();
      spent.push([current, at - enteredAt]);
      current = next; enteredAt = at;
    },
  };
  const phaseTimings = () => [...spent, [current, Date.now() - enteredAt] as [TaskBriefPhase, number]]
    .map(([name, ms]) => `${name} ${ms}ms`).join(', ');
  const toolset = readBriefToolset(deps.toolset, ref.workspaceId ?? activeWorkspaceId(), ref.reuse?.owner ?? ref.owner);
  try {
    const deadline = started + TASK_BRIEF_BUDGET_MS;
    const base = await Promise.race([buildTaskBrief(ref, deps, phase, deadline), new Promise<TaskBrief>(resolve => {
      timer = setTimeout(() => resolve({ status: 'unknown', scope: { harness: ref.workItem?.harness ?? ref.harness ?? null, paths: [] },
        sourceFingerprint: null, commit: null, files: [], excerpts: [],
        graph: { status: 'unknown', consumers: [], relationships: [] },
        exclusions: [
          `Task brief exceeded its bounded read deadline during ${phase.current}`
            + ` (elapsed ${Date.now() - started}ms; ${phaseTimings()}).`,
          'Scope paths are unknown because the bounded capture did not complete; an empty path list does not prove an empty input scope.',
        ],
        recover: ref.workItem?.id ? { tool: 'work_items:get', args: { id: ref.workItem.id } }
          : { tool: 'coord:declare-intent', args: { intent: ref.intent!.slice(0, 500), current_files: [...ref.paths!].slice(0, 8),
            ...(ref.harness ? { harness: ref.harness } : {}) } } }), TASK_BRIEF_BUDGET_MS);
    })]);
    timingOutcome = base.status === 'unknown' ? 'unknown' : 'ok';
    clearTimeout(timer);
    if (captureDiagnostics.hasSubscribers) {
      const at = Date.now();
      // Reuse the deadline's phase clock for successful captures too. Copies
      // keep subscribers from mutating the in-flight capture state.
      captureDiagnostics.publish({ workItem: ref.workItem?.id ?? null, status: base.status,
        elapsedMs: at - started,
        phases: [...spent, [current, at - enteredAt] as [TaskBriefPhase, number]]
          .map(([phase, elapsedMs]) => ({ phase, elapsedMs })),
      } satisfies TaskBriefCaptureTiming);
    }
    const harness = ref.workItem?.harness ?? ref.harness;
    let root = base.repository?.rootPath ?? null;
    if (!root && harness && deps.engineering && Date.now() < deadline) {
      let rootTimer: ReturnType<typeof setTimeout> | undefined;
      try { root = await Promise.race([
        deps.root(ref.workspaceId ?? activeWorkspaceId(), harness).catch(() => null),
        new Promise<null>(resolve => { rootTimer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
      ]); } finally { clearTimeout(rootTimer); }
    }
    if (root && harness) base.engineering = await taskEngineering(ref, root, base.scope.paths, deps, deadline);
    // Gate before reuse enrichment so its ledger row and invocation outcome carry the call
    // the recipient actually received (a withheld call is a null suggested_call).
    gateTaskBriefRecover(base, await toolset);
    // Optional reuse must fit around the complete mandatory response. Adding
    // engineering or compacting afterwards could replace base evidence and
    // remove hints after their issuance was recorded.
    const mandatory = compactTaskBrief(base, ref.maxChars ?? TASK_BRIEF_MAX_CHARS);
    // notify-classification: {"id":"packages/operator-core/lib/code-intelligence/task-brief.ts#<module>/getClaimTimeTaskBrief:fa78d302a2e17cd5d2de:1","classification":"durable","reason":"Re-keyed from getClaimTimeTaskBrief:19e65e51 (WI-6554700010042548). No safe-to-lose proof recorded. This call reaches <unresolved-computed-dispatch>; retain its terminal delivery obligation, including through aliases/wrappers.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const result = { taskBrief: await enrichTaskBriefWithReuse(mandatory, ref, deps, deadline) };
    timingOutcome = result.taskBrief.status === 'unknown' ? 'unknown' : 'ok';
    return result;
  } finally {
    clearTimeout(timer);
    const finishedAt = Date.now();
    const phases = [...spent, [current, finishedAt - enteredAt] as [TaskBriefPhase, number]];
    for (const [name, elapsedMs] of phases) {
      try {
        ref.onTiming?.({
          phase: name,
          elapsedMs: Math.min(300_000, Math.max(0, elapsedMs)),
          outcome: timingOutcome,
        });
      } catch {
        // Optional telemetry must not change the claim-time advisory.
      }
    }
    try {
      ref.onTiming?.({
        phase: 'total',
        elapsedMs: Math.min(300_000, Math.max(0, finishedAt - started)),
        outcome: timingOutcome,
      });
    } catch {
      // Optional telemetry must not change the claim-time advisory.
    }
  }
}

/** Only additive edits to existing fields are allowed: no replacement of mandatory evidence,
 * and no invention of top-level destinations while anchors P-008 is still upstream. */
function preservesBriefBase(base: unknown, next: unknown): boolean {
  if (Array.isArray(base)) return Array.isArray(next) && next.length >= base.length
    && base.every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]));
  if (base && typeof base === 'object') return Boolean(next && typeof next === 'object'
    && Object.keys(next).every(key => Object.hasOwn(base, key))
    && Object.entries(base).every(([key, value]) => preservesBriefBase(value, (next as Record<string, unknown>)[key])));
  return Object.is(base, next);
}

export async function enrichTaskBriefWithReuse(base: TaskBrief, ref: Ref, deps: TaskBriefDeps,
  deadline: number): Promise<TaskBrief> {
  if (!ref.reuse?.owner || !ref.reuse.invocation) return base;
  const harness = ref.workItem?.harness ?? ref.harness;
  const context: ReuseProviderContext = { surface: 'claim', workspaceId: ref.workspaceId ?? activeWorkspaceId(),
    owner: ref.reuse.owner, invocation: ref.reuse.invocation, workItem: ref.workItem?.id ?? undefined,
    itemText: ref.intent ?? [ref.workItem?.title, ref.workItem?.summary].filter(Boolean).join('\n'),
    plan: ref.workItem?.sourcePlanSlug ?? undefined, planItems: ref.workItem?.sourcePlanItemIds ?? [],
    paths: base.scope.paths, sourceVersion: base.sourceFingerprint, commit: base.commit,
    repository: base.repository ? { ...base.repository, ...(harness ? { harness } : {}) } : undefined,
    sourceFiles: base.files.map(file => ({ path: file.path, sha256: file.sha256 })) };
  // D011: append to the existing representation; preserve mandatory fields and
  // never manufacture parallel top-level anchor sections.
  const append: TaskBriefReuseAdapter = (brief, value) => ({ ...brief,
    graph: { ...brief.graph, relationships: [...brief.graph.relationships, encodeClaimReuseContribution(brief, value)] } });
  const adapters = deps.reuse?.adapters ?? {
    impact: append, tests: append, coChange: append, whatChangedSincePlanning: append,
    ...Object.fromEntries(reuseAdapters),
  };
  const history = harness ? boundChangeHistoryProviders({ harness,
    root: () => deps.root(context.workspaceId, harness), priorWork: deps.reuse?.priorWork }) : [];
  // notify-classification: {"id":"packages/operator-core/lib/code-intelligence/task-brief.ts#<module>/enrichTaskBriefWithReuse:3eca8252554396366205:1","classification":"durable","reason":"Re-keyed from enrichTaskBriefWithReuse:7467be5e and /plannedAt:586f92c5 (WI-6554700010042548). No safe-to-lose proof recorded. This call reaches <unresolved-computed-dispatch>; retain its terminal delivery obligation, including through aliases/wrappers.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
  const result = await composeReuseBrief({ base, context, deadline: deadline - 150,
    maxChars: ref.maxChars ?? TASK_BRIEF_MAX_CHARS,
    providers: deps.reuse?.providers ?? (() => {
      const registered = registeredReuseBriefProviders();
      return [...registered, ...history.filter(provider => !registered.some(row => row.id === provider.id))];
    })(),
    available: section => base.status === 'current' && Boolean(adapters[section]),
    append: (brief, value) => {
      const next = adapters[value.section]!(brief, value);
      if (!preservesBriefBase(base, next)) throw new Error('Reuse adapter replaced mandatory task evidence');
      return next;
    } });
  let ledger: 'not-needed' | 'recorded' | 'unknown' = 'not-needed';
  if (result.observations.some(row => row.status === 'issued' || row.status === 'held-out')) {
    ledger = 'unknown';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining) {
        const recorded = await Promise.race([
          Promise.resolve().then(() => (deps.reuse?.recordIssued ?? recordReuseBriefIssued)(
            { context, observations: result.observations, recover: base.recover }, controller.signal)),
          new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, remaining); }),
        ]);
        if (recorded) ledger = 'recorded';
      }
    } catch { /* Ledger outages do not remove mandatory or independently issued evidence. */ }
    finally { clearTimeout(timer); controller.abort(); }
  }
  // The dispatcher persists these outcomes in tool_invocations, not the issued-only table.
  try { ref.reuse.observe?.({ context, observations: result.observations, recover: base.recover, ledger }); } catch { /* advisory */ }
  return result.brief;
}

/** P-039: explicit transient scope uses the same safe capture as claims. A failed
 * ownership read cannot be interpreted as a measured absence of a claim.
 * WI-6554700010030367: a held claim suppresses only the declared paths its own
 * scope covers (its claim brief carries those); a declared path outside every
 * held claim still gets an intent brief, scoped to just those paths. */
export async function getIntentTimeTaskBrief(ref: { owner: string; workspaceId: string; harness: string;
  intent: string; paths: readonly string[]; maxChars?: number }, deps: TaskBriefDeps = defaults): Promise<{ taskBrief: TaskBrief } | null> {
  if (!ref.intent.trim() || !ref.paths.length || !deps.claimedPaths) return null;
  try {
    const claimed = new Set(await deps.claimedPaths(ref.workspaceId, ref.owner));
    const paths = ref.paths.filter(path => !claimed.has(normalizeScopePath(path)));
    if (!paths.length) return null;
    // notify-classification: {"id":"packages/operator-core/lib/code-intelligence/task-brief.ts#<module>/getIntentTimeTaskBrief:3a5020e17447d3339ad1:1","classification":"durable","reason":"Re-keyed from getIntentTimeTaskBrief:8f185819 (WI-6554700010042548). No safe-to-lose proof recorded. This call reaches <unresolved-computed-dispatch>; retain its terminal delivery obligation, including through aliases/wrappers.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    return await getClaimTimeTaskBrief({ ...ref, paths }, deps);
  } catch { return null; }
}

export interface CompletionBriefDeps {
  root: TaskBriefDeps['root'];
  report: typeof nativeChangeReport;
  /** Only server-bound run evidence, never paths parsed from completion prose. */
  runs?: (paths: string[]) => Promise<{ path: string; status: string; runGroupId: string }[] | null>;
  /** The default report's graph leg; `budgetMs` is what remains of the brief deadline. */
  graph?: (request: ChangeReportRequest, root: string, budgetMs: number) => Promise<CodeIntelAnswer>;
  /** WI-6554700010042518: the operator-home harness's warm caller index and its miss reason. */
  snapshot?: typeof queryPushSnapshot;
  snapshotMissReason?: typeof pushSnapshotMissReason;
  /** The default report's non-graph effects (git, artifact writes). */
  effects?: Omit<ChangeReportEffects, 'graph'>;
  cochange?: typeof readWarmCoChange;
  /** One source-qualified, close-bound test run batch, shared by SQL/coverage. */
  coverage?: (context: Readonly<ReuseProviderContext>, signal: AbortSignal) => Promise<CoverageScopeData | null>;
  reuse?: TaskBriefDeps['reuse'];
  engineering?: TaskBriefDeps['engineering'];
  toolset?: TaskBriefDeps['toolset'];
  /** Override the capture budget in tests; production keeps the six-second default. */
  budgetMs?: number;
}

/** Added lines from a complete native diff only. Context/deletions and truncated
 * excerpts cannot establish a changed executable line. */
function completionChangedLines(patch: string): number[] | null {
  const added: number[] = [];
  let line = 0, oldLeft = 0, newLeft = 0, seen = false;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      if (oldLeft || newLeft) return null;
      oldLeft = Number(hunk[1] ?? 1); line = Number(hunk[2]); newLeft = Number(hunk[3] ?? 1); seen = true;
    } else if (seen && (oldLeft || newLeft)) {
      if (text.startsWith(' ')) { oldLeft--; newLeft--; line++; }
      else if (text.startsWith('-')) oldLeft--;
      else if (text.startsWith('+')) { newLeft--; added.push(line++); }
      else if (text !== '\\ No newline at end of file') return null;
      if (oldLeft < 0 || newLeft < 0 || added.length > 10_000) return null;
    }
  }
  return seen && !oldLeft && !newLeft ? added : null;
}

/** WI-6554700010042518: the completion graph leg on the operator-home harness. Answers
 * DIRECT callers from the maintained push snapshot, a file read by both :3070 and :3170,
 * so no per-process cache and no cold worker on the request path. The snapshot matches by
 * name, so an answer counts only when its one declaration is the changed file. The changed
 * file was edited after the snapshot by definition, so the proof is per caller file: callers
 * in unchanged files count and the rest are named as dropped. A miss is an unmeasured answer
 * with a named reason, never an empty consumer set. */
export async function snapshotCallersAnswer(request: ChangeReportRequest, root: string,
  query: typeof queryPushSnapshot = queryPushSnapshot,
  missReason: typeof pushSnapshotMissReason = pushSnapshotMissReason, budgetMs = 2_000): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const file = isAbsolute(request.file) ? relative(root, request.file) : request.file;
  const answer = await query({ op: 'callers', root, name: request.symbol, paths: [...(request.paths ?? ['.'])],
    limit: request.limit ?? 20, callerProof: 'per-file', declaredIn: file,
    timeoutMs: Math.min(2_000, Math.max(1, budgetMs)) });
  const declaredAt = [...new Set((answer?.evidence?.relationships ?? [])
    .flatMap(edge => edge.target ? [edge.target.site.path] : []))];
  if (answer && declaredAt.length === 1 && declaredAt[0] === file) {
    const limitations = [...(answer.coverage?.limitations ?? []),
      'Direct callers from the first-party snapshot; transitive impact was not measured at completion.'];
    const coverage = { basis: 'syntax' as const, sourceCompleteness: 'unverified' as const, ...answer.coverage, limitations };
    return { ...answer, coverage, ...(answer.evidence ? { evidence: { ...answer.evidence, graphScope: coverage } } : {}) };
  }
  const reason = missReason('papercusp');
  return {
    backend: 'first-party-snapshot', intent: 'callers', query: request.symbol, sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unknown', indexedAt: null, indexedCommit: null, staleVsDisk: null },
    latencyMs: Date.now() - started,
    error: answer ? `snapshot-miss: the snapshot's ${request.symbol} is declared in ${declaredAt.join(', ') || 'no recorded file'}, not ${file}; callers were not measured.`
      : reason ? `index-not-ready: the caller snapshot is ${reason}; callers were not measured.`
        : `snapshot-miss: no caller of ${request.symbol} declared in ${file} could be verified against current disk (absent from the snapshot, no recorded caller, a changed forwarding module, or every caller file changed since the snapshot); callers were not measured.`,
  };
}

/** P-039: reuse the pre-review report at the completion receipt, without
 * treating a declared test command or a static edge as execution evidence. */
export async function getCompletionTimeBrief(ref: { workspaceId: string; harness: string; paths: readonly string[];
  reuse?: ClaimBriefReuseIdentity; workItem?: string; subject?: ClaimTimeEnrichmentSubject; maxChars?: number;
  owner?: string;
  /** WI-6554700010030397: the caller's absolute deadline (epoch ms). A caller that bounds this
   * brief from outside passes a deadline inside its own bound, so a slow leg returns this
   * brief's named limitation instead of losing the whole brief to the caller's fallback. */
  deadlineMs?: number },
  deps: Partial<CompletionBriefDeps> = {}) {
  const rootResolver = deps.root ?? defaults.root;
  const budgetMs = Number.isFinite(deps.budgetMs) ? Math.max(1, deps.budgetMs!) : TASK_BRIEF_BUDGET_MS;
  const deadline = Math.min(ref.deadlineMs ?? Number.POSITIVE_INFINITY, Date.now() + budgetMs);
  const toolset = readBriefToolset(deps.toolset, ref.workspaceId, ref.reuse?.owner ?? ref.owner);
  // WI-6554700010042518: on the operator-home harness a cold per-symbol worker measured past
  // the completion deadline, so callers come from the maintained push snapshot. Other
  // harnesses have no snapshot and keep the worker inside what remains of the deadline.
  const graphSource: NonNullable<CompletionBriefDeps['graph']> = deps.graph ?? (ref.harness === operatorHomeHarnessSlug()
    ? (request, root, budgetMs) => snapshotCallersAnswer(request, root, deps.snapshot, deps.snapshotMissReason, budgetMs)
    : (request, root, budgetMs) => firstPartyCallersOffthread({ vendorDir: LSP_VENDOR_DIR, root,
      op: 'impact', name: request.symbol, filePath: request.file, paths: request.paths ?? ['.'],
      direction: 'downstream', limit: 20, maxDepth: 5, maxPaths: 10, includeInterfaces: true }, { budgetMs }));
  // The graph leg gets what remains of the brief deadline. A fixed 2000 ms sub-budget expired
  // under host load (a fresh worker measured 1048-2598 ms), so the brief read `unknown` with
  // most of its own deadline unused (WI-6554700010019386).
  const reportSource: typeof nativeChangeReport = deps.report ?? ((args, subject) => nativeChangeReport(args, subject, {
    ...deps.effects,
    graph: (request, root) => graphSource(request, root, Math.max(1, deadline - Date.now() - 250)),
  }));
  // WI-6554700010042685: a report re-reads git provenance and the diff for every symbol (measured
  // 0.9-2.3 s each) while the snapshot answers in milliseconds. An export the snapshot cannot
  // answer (a constant, a type, a caller-less helper) then spent a whole report only to read
  // `unmeasured`, so a file led by such exports used up the deadline before any report measured.
  // On the snapshot path, ask the snapshot first and spend reports only on answered symbols.
  const snapshotFirst = !deps.graph && !deps.report && ref.harness === operatorHomeHarnessSlug();
  const brief = { phase: 'pre-review' as const, status: 'unknown' as 'measured' | 'unknown',
    scope: { paths: [...new Set(ref.paths)].filter(path => safePath(path) && path.length <= 240).slice(0, 8), processed: [] as string[] },
    changes: [] as { file: string; symbol: string; sourceFingerprint: string; consumers: string[] }[],
    tests: [] as { path: string; execution: 'recorded' | 'not-recorded-in-bound-run' | 'unknown';
      runGroupId: string | null; status: string | null }[],
    testsWithoutRunEvidence: null as string[] | null,
    executionCoverage: 'unmeasured' as const,
    engineering: undefined as TaskEngineeringEvidence | undefined,
    limitations: ['Bounded static source reach, not complete change coverage. A recorded file run may be filtered or stale; current-source test execution is unmeasured.'],
    recover: { tool: 'code:pack' as const, args: { op: 'diff' as const, include: [] as string[],
      rootPath: '', explain: undefined as { symbol: string; file: string; phase: 'pre-review' } | undefined } },
  };
  const finish = (value: typeof brief) => {
    const result = structuredClone(value);
    // Keep both serialized copies in the size measurement, including early
    // returns before the registry root resolves.
    result.recover.args.include = result.scope.paths;
    const oversized = () => JSON.stringify(result).length > (ref.maxChars ?? TASK_BRIEF_MAX_CHARS);
    if (oversized()) result.limitations.push('Additional inline records omitted by the response budget.');
    while (oversized() && result.tests.length) result.tests.pop();
    if (result.testsWithoutRunEvidence) result.testsWithoutRunEvidence = result.testsWithoutRunEvidence.filter(path => result.tests.some(test => test.path === path));
    while (oversized() && result.changes.some(change => change.consumers.length)) result.changes.find(change => change.consumers.length)!.consumers.pop();
    while (oversized() && result.changes.length > 1) result.changes.pop();
    while (oversized() && result.scope.processed.length) result.scope.processed.pop();
    while (oversized() && result.scope.paths.length > 1) result.scope.paths.pop();
    if (oversized() && result.engineering) {
      result.engineering.gaps.unshift('additional-evidence-omitted');
      for (const axis of ['validation', 'rationale', 'intent', 'execution'] as const)
        while (oversized() && result.engineering[axis].length) result.engineering[axis].pop();
      if (oversized()) result.engineering.gaps = ['Inline evidence omitted; use the scoped graph reader.'];
    }
    result.recover.args.include = result.scope.paths;
    if (oversized()) { result.recover.args.rootPath = ''; result.limitations.push('Use the registered harness root for recovery; its path exceeded the inline budget.'); }
    return result;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const rootValue = await rootResolver(ref.workspaceId, ref.harness);
    if (!rootValue || Date.now() >= deadline) return brief;
    const root = await realpath(rootValue);
    if (Date.now() >= deadline) return brief;
    brief.recover.args.rootPath = root; brief.recover.args.include = brief.scope.paths;
    const engineering = taskEngineering({ workspaceId: ref.workspaceId, harness: ref.harness, workItem: ref.subject },
      root, brief.scope.paths, { engineering: deps.engineering ?? (!deps.root && !deps.report ? defaults.engineering : undefined) }, deadline);
    const historyController = new AbortController();
    const historyTimer = setTimeout(() => historyController.abort(), Math.min(750, Math.max(0, deadline - Date.now())));
    const history = (ref.reuse ? (deps.cochange ?? readWarmCoChange)(root, brief.scope.paths, undefined, historyController.signal)
      .catch(() => null) : Promise.resolve(null)).finally(() => clearTimeout(historyTimer));
    const captured = new Map<string, string>();
    const tests = new Set<string>();
    const changedLines: Record<string, readonly number[]> = {};
    const unmeasured: string[] = [];
    for (const file of brief.scope.paths) {
      if (Date.now() >= deadline || brief.changes.length >= 2) break;
      if (kindOf(file) !== 'implementation' || !/\.[cm]?[jt]sx?$/.test(file)) continue;
      const abs = await realpath(join(root, file));
      if (!inside(root, abs) || (await stat(abs)).size > 64_000) continue;
      const text = await readFile(abs, 'utf8'); captured.set(file, hash(text));
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const names = source.statements.flatMap(statement => {
        if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) return [];
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
          .flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
        return 'name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)
          ? [(statement.name as ts.Identifier).text] : [];
      });
      for (const symbol of names) {
        if (Date.now() >= deadline || brief.changes.length >= 2) break;
        const subject = { file, symbol, phase: 'pre-review' as const, paths: ['.'], limit: 20 };
        if (snapshotFirst) {
          const miss = (await graphSource(subject, root, Math.max(1, deadline - Date.now() - 250))).error;
          if (Date.now() >= deadline) return brief;
          if (miss) {
            if (unmeasured.length < 2) unmeasured.push(`${file}#${symbol}: ${miss}`.slice(0, 240));
            continue;
          }
        }
        const { answer, report } = await reportSource({ rootPath: root, include: brief.scope.paths }, subject);
        if (Date.now() >= deadline) return brief;
        if (report.freshness === 'unmeasured') {
          // Keep the reason: an unmeasured report is otherwise indistinguishable from a file
          // with nothing to report, and the brief's `unknown` status would carry no cause.
          const why = answer.error ?? report.limitations[report.limitations.length - 1] ?? 'no compiler input identity';
          if (unmeasured.length < 2) unmeasured.push(`${file}#${symbol}: ${why}`.slice(0, 240));
          continue;
        }
        for (const change of report.changed) {
          if (!brief.scope.paths.includes(change.path)
            || report.limitations.includes(`Diff excerpt truncated for ${change.path}.`)) continue;
          const lines = completionChangedLines(change.patch);
          if (lines) changedLines[change.path] = lines;
        }
        for (const input of answer.evidence?.sourceScope.supportingFiles ?? []) {
          if (input.representation !== 'full-source' || !safePath(input.path)) continue;
          if (captured.has(input.path) && captured.get(input.path) !== input.contentHash)
            throw new Error('Completion source changed between compiler reports.');
          captured.set(input.path, input.contentHash);
        }
        brief.changes.push({ file, symbol, sourceFingerprint: report.sourceFingerprint,
          consumers: report.consumers.slice(0, 4).map(site => `${site.path}:${site.line1 ?? '?'}`) });
        for (const site of report.relevantTests) if (safePath(site.path)) tests.add(site.path);
        brief.recover.args.explain ??= { file, symbol, phase: 'pre-review' };
      }
      brief.scope.processed.push(file);
    }
    const paths = [...tests].slice(0, 12);
    const runs = deps.runs && Date.now() < deadline ? await deps.runs(paths).catch(() => null) : null;
    if (Date.now() >= deadline) return brief;
    for (const [file, before] of captured) {
      const abs = await realpath(join(root, file));
      if (!inside(root, abs) || hash(await readFile(abs, 'utf8')) !== before)
        throw new Error('Completion source changed during analysis.');
    }
    brief.tests = paths.map(path => {
      const run = runs?.find(row => row.path === path && row.runGroupId && ['pass', 'fail', 'error'].includes(row.status));
      return { path, execution: run ? 'recorded' : runs ? 'not-recorded-in-bound-run' : 'unknown',
        runGroupId: run?.runGroupId ?? null, status: run?.status ?? null };
    });
    brief.testsWithoutRunEvidence = runs ? brief.tests.filter(test => test.execution !== 'recorded').map(test => test.path) : null;
    brief.status = brief.changes.length ? 'measured' : 'unknown';
    if (!brief.changes.length && unmeasured.length)
      brief.limitations.push(`Compiler evidence was unmeasured for ${unmeasured.join('; ')}.`);
    brief.engineering = await engineering;
    const cochange = await history;
    if (ref.reuse && Date.now() < deadline - 150) {
      const sourceFiles = [...captured].map(([path, sha256]) => ({ path, sha256 }));
      const context: ReuseProviderContext = { surface: 'completion', workspaceId: ref.workspaceId,
        owner: ref.reuse.owner, invocation: ref.reuse.invocation, workItem: ref.workItem, paths: brief.scope.paths,
        sourceVersion: hash(JSON.stringify([...captured])), commit: cochange?.commit ?? null,
        repository: { workspaceId: ref.workspaceId, rootPath: root, harness: ref.harness }, sourceFiles,
        changedLines: Object.keys(changedLines).length ? changedLines : undefined, staticTests: paths };
      const { coverageBriefProvider, sourceBoundCoverageSnapshots } = await import('./test-coverage-map');
      const receipt = deps.coverage ? (await withBoundedTimeout(signal => deps.coverage!(context, signal), {
        timeoutMs: Math.max(1, Math.min(750, deadline - Date.now() - 150)), fallback: null,
        label: 'completion:bound-coverage',
      })).value : null;
      const qualified = receipt ? sourceBoundCoverageSnapshots(root, receipt.snapshots, receipt.currentHashes) : [];
      const validReceipt = receipt && qualified.length > 0 && qualified.length === receipt.snapshots.length
        && new Set(qualified.map(s => `${s.scopeRoot}\0${s.observedAt}`)).size === 1
        && sourceFiles.every(file => receipt.currentHashes.get(file.path) === file.sha256);
      if (validReceipt) context.checkedPaths = [...new Set(qualified.flatMap(s => s.sources
        .filter(source => source.covered.length > 0).map(source => source.path)))];
      const registered = registeredReuseBriefProviders();
      const historyProviders = cochange ? changeHistoryProviders({ cochange: async () => cochange,
        provenance: async () => [] }).filter(provider => provider.id === 'cochange') : [];
      const providers = deps.reuse?.providers ?? [...registered.map(provider => deps.coverage && provider.id === 'coverage'
        ? coverageBriefProvider(async () => validReceipt ? receipt : null) : provider),
        ...historyProviders.filter(provider => !registered.some(row => row.id === provider.id))];
      const result = await composeReuseBrief({ base: finish(brief), context, deadline: deadline - 150, providers,
        append: (base, contribution) => ({ ...base, limitations: [...base.limitations, contribution.text] }) });
      Object.assign(brief, result.brief);
      // The ledger row and invocation outcome carry the call the recipient will receive.
      const recover = canCall(await toolset, brief.recover.tool) ? brief.recover : undefined;
      let ledger: 'not-needed' | 'recorded' | 'unknown' = 'not-needed';
      if (result.observations.some(row => row.status === 'issued' || row.status === 'held-out')) {
        ledger = 'unknown';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        try {
          const recorded = await Promise.race([(deps.reuse?.recordIssued ?? recordReuseBriefIssued)(
            { context, observations: result.observations, recover }, controller.signal),
          new Promise<false>(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true }))]);
          if (recorded) ledger = 'recorded';
        } catch { /* Failure is observed below and cannot erase mandatory completion evidence. */ }
        finally { clearTimeout(timeout); controller.abort(); }
      }
      ref.reuse.observe?.({ context, observations: result.observations, recover, ledger });
    }
    return brief;
  };
  let result: ReturnType<typeof finish>;
  try {
    result = finish(await Promise.race([work(), new Promise<typeof brief>(resolve => {
      timer = setTimeout(() => resolve(finish({ ...brief, status: 'unknown', changes: [], tests: [], testsWithoutRunEvidence: null,
        limitations: [...brief.limitations, 'Completion brief exceeded its read deadline.'] })), Math.max(1, deadline - Date.now()));
    })]));
  } catch {
    result = finish({ ...brief, status: 'unknown' as const, changes: [], tests: [], testsWithoutRunEvidence: null,
      limitations: [...brief.limitations, 'Completion source or analysis was unavailable; re-read before review.'] });
  } finally { clearTimeout(timer); }
  return gateTaskBriefRecover<Omit<typeof result, 'recover'> & { recover?: typeof result.recover }>(result, await toolset);
}
