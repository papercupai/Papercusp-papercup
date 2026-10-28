/** P017: successful dispatch evidence over a versioned, bounded registry population. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getServingHostIdentity } from '../serving-host-identity';
import type { CompilerInterfaceEvidence } from './first-party-callers';
import type { CodeIntelSourceFile, SymbolSite } from './contracts';
import type { ScopedContractReport } from './scoped-contracts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const GROUP_LIMIT = 1000;
// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedGit: typeof execFile.__promisify__ | undefined;
const git = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedGit ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;
const hash = (value: string | null | undefined): value is string => Boolean(value && /^[a-f0-9]{64}$/.test(value));
const build = (value: string | null | undefined): value is string => Boolean(value && /^[a-f0-9]{10,64}$/.test(value));
const safePath = (path: string) => path.length > 0 && !path.startsWith('/') && !path.includes('\\')
  && !path.split('/').some(part => part === '..' || part === '.' || !part);

export interface RuntimeRegistrySnapshot {
  repositoryId: string;
  version: string;
  pluginName: string;
  /** Exact ledger build identity whose sources were corroborated, never current HEAD as a substitute. */
  buildSha: string | null;
  complete: boolean;
  links: { tool: string; implementation: SymbolSite; contentHash: string }[];
  limitations: string[];
}

/** Reuse the canonical compiler registration-to-handler links, including aliases. */
export function runtimeRegistrySnapshot(input: {
  repositoryId: string; version: string; pluginName: string; buildSha: string | null;
  interfaces: CompilerInterfaceEvidence; sources: readonly CodeIntelSourceFile[];
}): RuntimeRegistrySnapshot {
  const { interfaces, sources } = input;
  const byPath = new Map(sources.map(source => [source.path, source.contentHash]));
  const links: RuntimeRegistrySnapshot['links'] = [];
  let complete = interfaces.status === 'measured' && !interfaces.truncated && hash(input.version)
    && createHash('sha256').update(JSON.stringify(sources)).digest('hex') === input.version;
  for (const row of interfaces.registrations) {
    if (row.kind === 'route') continue; // HTTP has a different traffic ledger; never infer it from tool traffic.
    const implementation = row.implementation;
    const contentHash = implementation && byPath.get(implementation.path);
    if (row.kind !== 'tool' || row.factoryAuthority === 'unverified' || !row.name || !implementation
      || !safePath(implementation.path) || !Number.isInteger(implementation.line1) || implementation.line1! < 1
      || !hash(contentHash) || !hash(byPath.get(row.site.path))) {
      complete = false;
      continue;
    }
    links.push({ tool: row.name, implementation, contentHash });
  }
  return { repositoryId: input.repositoryId, version: input.version, pluginName: input.pluginName,
    buildSha: build(input.buildSha) ? input.buildSha : null, complete, links,
    limitations: ['Population is the declared compiler tool-registration cohort, not every function or HTTP route.',
      ...(!complete ? ['Registry links are incomplete, dynamic, truncated or unversioned.'] : [])] };
}

export interface RuntimeLedgerRetention {
  status: 'complete' | 'partial' | 'unknown';
  start: string | null;
  end: string | null;
  /** Reference to the retention/completeness evidence, not the oldest surviving invocation. */
  evidenceRef: string | null;
}
export interface RuntimeImplementationEvidence {
  implementation: SymbolSite;
  contentHash: string;
  tools: string[];
  state: 'executed' | 'not-observed-in-window' | 'unknown';
  successfulDispatches: number;
  otherBuildDispatches: number;
  firstObserved: string | null;
  lastObserved: string | null;
  reason: string;
}
export interface RuntimeCodeEvidence {
  window: { start: string; end: string; boundary: '[start,end)' };
  population: { workspaceId: string; repositoryId: string; pluginName: string; registryVersion: string;
    buildSha: string | null; status: 'ok'; unit: 'successful dispatches per linked implementation' };
  completeness: { registry: boolean; query: boolean; retention: RuntimeLedgerRetention; absenceKnown: boolean };
  implementations: RuntimeImplementationEvidence[];
  limitations: string[];
  error: string | null;
}
type Group = { tool: string; build_sha: string | null; n: string | number; first: Date | string; last: Date | string };

/** Exact successful-dispatch population. Replay, refusal, timeout and invalid-input rows never count. */
export async function readRuntimeCodeEvidence(input: {
  workspaceId: string; registry: RuntimeRegistrySnapshot; windowEnd?: string;
  retention?: RuntimeLedgerRetention;
}, sql: Sql = getOrgPg().sql): Promise<RuntimeCodeEvidence> {
  const end = input.windowEnd === undefined ? Date.now() : Date.parse(input.windowEnd);
  if (!input.workspaceId.trim() || !Number.isFinite(end)) throw new Error('A workspace and valid windowEnd are required.');
  const startIso = new Date(end - WEEK_MS).toISOString(), endIso = new Date(end).toISOString();
  const registry = input.registry;
  const retention = input.retention ?? { status: 'unknown', start: null, end: null, evidenceRef: null };
  const retentionComplete = retention.status === 'complete' && Boolean(retention.evidenceRef?.trim())
    && Date.parse(retention.start ?? '') <= end - WEEK_MS && Date.parse(retention.end ?? '') >= end;
  const report: RuntimeCodeEvidence = {
    window: { start: startIso, end: endIso, boundary: '[start,end)' },
    population: { workspaceId: input.workspaceId, repositoryId: registry.repositoryId, pluginName: registry.pluginName,
      registryVersion: registry.version, buildSha: registry.buildSha, status: 'ok', unit: 'successful dispatches per linked implementation' },
    completeness: { registry: registry.complete, query: false, retention, absenceKnown: false },
    implementations: [], error: null,
    limitations: [...registry.limitations,
      'Unobserved means not observed in the declared seven-day window; it is never proof of never-executed or dead code.',
      'Dispatch success establishes entry to the registered handler, not execution of every branch or successful business effect.',
      'Counts exclude other workspaces/plugins, failed/refused dispatches and idempotent replays; other build versions remain separate.',
      'Partial ledger counts are lower bounds. No retention conclusion is inferred from the oldest surviving row.'],
  };
  const names = [...new Set(registry.links.map(link => link.tool))].sort();
  let groups: Group[] = [];
  if (names.length > 500) report.error = 'Registry population exceeds the 500-tool query bound.';
  else if (names.length) {
    try {
      groups = await sql.begin(async tx => {
        await tx`SELECT set_config('statement_timeout', '2000ms', true)`;
        return tx<Group[]>`
          WITH instants AS MATERIALIZED (
            SELECT DISTINCT invoked_at FROM harness_shared.tool_invocations
            WHERE invoked_at >= ${startIso}::timestamptz AND invoked_at < ${endIso}::timestamptz
              AND tool_name = ANY(${names}::text[])
          )
          SELECT tool_name AS tool, serving_build_sha AS build_sha, count(*)::text AS n,
            min(invoked_at) AS first, max(invoked_at) AS last
          FROM harness_shared.tool_invocations
          WHERE invoked_at = ANY(ARRAY(SELECT invoked_at FROM instants))
            AND workspace_id = ${input.workspaceId} AND plugin_name = ${registry.pluginName}
            AND tool_name = ANY(${names}::text[]) AND status = 'ok'
          GROUP BY tool_name, serving_build_sha ORDER BY tool_name, serving_build_sha NULLS FIRST
          LIMIT ${GROUP_LIMIT + 1}`;
      });
      report.completeness.query = groups.length <= GROUP_LIMIT;
      groups = groups.slice(0, GROUP_LIMIT);
    } catch (error) { report.error = error instanceof Error ? error.message : 'Invocation ledger unavailable.'; }
  } else report.completeness.query = true;
  const entries = new Map<string, RuntimeImplementationEvidence>();
  const targets = new Map<string, Set<string>>();
  for (const link of registry.links) {
    const id = JSON.stringify([link.implementation.path, link.implementation.line1, link.contentHash]);
    const aliases = targets.get(link.tool) ?? new Set(); aliases.add(id); targets.set(link.tool, aliases);
    const row = entries.get(id) ?? { implementation: link.implementation, contentHash: link.contentHash, tools: [],
      state: 'unknown', successfulDispatches: 0, otherBuildDispatches: 0, firstObserved: null, lastObserved: null, reason: '' };
    if (!row.tools.includes(link.tool)) row.tools.push(link.tool);
    entries.set(id, row);
  }
  report.completeness.absenceKnown = registry.complete && report.completeness.query && retentionComplete && build(registry.buildSha)
    && [...targets.values()].every(ids => ids.size === 1);
  for (const row of entries.values()) {
    row.tools.sort();
    const ambiguous = row.tools.some(name => targets.get(name)!.size !== 1);
    for (const group of groups.filter(group => row.tools.includes(group.tool))) {
      if (targets.get(group.tool)!.size !== 1) continue;
      const n = Number(group.n);
      if (!Number.isSafeInteger(n) || n < 0) { report.error = 'Invocation count is outside the exact integer range.'; continue; }
      if (!registry.buildSha || group.build_sha !== registry.buildSha) { row.otherBuildDispatches += n; continue; }
      row.successfulDispatches += n;
      const first = new Date(group.first).toISOString(), last = new Date(group.last).toISOString();
      if (!row.firstObserved || first < row.firstObserved) row.firstObserved = first;
      if (!row.lastObserved || last > row.lastObserved) row.lastObserved = last;
    }
    if (report.error || !registry.complete || !report.completeness.query || ambiguous || !build(registry.buildSha)) {
      row.reason = report.error ?? (ambiguous ? 'Tool name resolves to multiple implementations.'
        : !registry.complete ? 'Registry completeness is unknown.' : !build(registry.buildSha)
          ? 'Loaded build is not corroborated against this registry source snapshot.' : 'Invocation query was truncated.');
    } else if (row.successfulDispatches > 0) { row.state = 'executed'; row.reason = 'Successful dispatch observed for this linked implementation and loaded build.'; }
    else if (report.completeness.absenceKnown) { row.state = 'not-observed-in-window'; row.reason = 'No successful dispatch observed in the declared complete window/population.'; }
    else row.reason = 'Ledger retention/completeness is unknown or does not cover the declared window.';
  }
  report.implementations = [...entries.values()].sort((a, b) => a.implementation.path.localeCompare(b.implementation.path)
    || a.implementation.line1! - b.implementation.line1!);
  return report;
}

/** Bind the existing serving-build identity to the compiler's exact captured inputs. */
export async function corroborateRuntimeRegistryBuild(root: string, sources: readonly CodeIntelSourceFile[],
  loadedBuild: string | null = getServingHostIdentity().buildSha): Promise<string | null> {
  if (!build(loadedBuild) || !sources.length || sources.length > 32) return null;
  try {
    const matches = await Promise.all(sources.map(async source => {
      if (!safePath(source.path) || !hash(source.contentHash)) return false;
      const { stdout } = await git('git', ['-C', root, 'show', `${loadedBuild}:${source.path}`],
        { timeout: 2000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
      return createHash('sha256').update(stdout).digest('hex') === source.contentHash;
    }));
    return matches.every(Boolean) ? loadedBuild : null;
  } catch { return null; } // Explicit unversioned evidence; never substitutes HEAD.
}

/** Existing graph:query contracts seam; optional and no claim-brief emission without efficacy proof. */
export async function runtimeEvidenceForContracts(report: ScopedContractReport, root: string): Promise<{
  repositories: RuntimeCodeEvidence[]; unknownRepositories: { repositoryId: string; reason: string }[];
}> {
  const result: RuntimeCodeEvidence[] = [];
  const unknownRepositories: { repositoryId: string; reason: string }[] = [];
  if (report.error || !report.workspaceId) return { repositories: result, unknownRepositories };
  const end = new Date().toISOString();
  for (const repository of report.repositories) {
    // Other repositories have no proven association with the Papercusp tool invocation plugin.
    if (repository.harness !== 'papercusp') {
      unknownRepositories.push({ repositoryId: repository.repositoryId,
        reason: 'Repository-to-serving-plugin association is unmeasured; no invocation attribution made.' });
      continue;
    }
    const buildSha = await corroborateRuntimeRegistryBuild(root, repository.sources);
    result.push(await readRuntimeCodeEvidence({ workspaceId: report.workspaceId, windowEnd: end,
      registry: runtimeRegistrySnapshot({ ...repository, version: repository.sourceFingerprint,
        pluginName: 'papercusp', buildSha }) }));
  }
  return { repositories: result, unknownRepositories };
}
