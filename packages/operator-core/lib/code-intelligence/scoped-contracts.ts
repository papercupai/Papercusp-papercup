/** P019: join the existing compiler interface evidence over an admitted registry cohort. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { HarnessRegistry, ProjectEntry } from '../harness-registry';
import { loadHarnessRegistry } from '../harness-registry';
import type { FirstPartyCallersAnswer, CompilerInterfaceEvidence } from './first-party-callers';
import { firstPartyCallersOffthread, type FirstPartyCallersRunOptions } from './first-party-callers-offthread';
import type { FirstPartyCallersJob } from './first-party-callers.worker';
import type { CodeIntelSourceFile, SymbolSite } from './contracts';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';

type Context = Pick<UnifiedToolContext, 'principal' | 'workspaceId' | 'harnessSlug' | 'role'>;
type Endpoint = { harness: string; repositoryId: string; sourceFingerprint: string; site: SymbolSite; contentHash: string };
type Candidate = { protocol: 'http' | 'rpc' | 'event'; role: 'producer' | 'consumer'; key: string | null;
  method: string | null; endpoint: Endpoint; authority: string; handler: SymbolSite | null };
export interface ScopedContractReport {
  status: 'measured' | 'unknown'; workspaceId: string | null; harnesses: string[]; error: string | null;
  repositories: { harness: string; repositoryId: string; sourceFingerprint: string; sources: readonly CodeIntelSourceFile[];
    interfaces: CompilerInterfaceEvidence }[];
  candidates: Candidate[];
  relationships: { protocol: Candidate['protocol']; key: string; producer: Endpoint; consumer: Endpoint;
    knowledge: 'static-possible'; ambiguous: boolean; middleware: 'unknown'; runtimeExecution: 'unknown' }[];
  mismatchedConsumers: { harness: string; site: SymbolSite; code: number; message: string }[];
  truncated: boolean; limitations: string[];
}
export interface ScopedContractEffects {
  registry(workspaceId: string): Promise<HarnessRegistry>;
  worker(job: FirstPartyCallersJob, options?: FirstPartyCallersRunOptions): Promise<FirstPartyCallersAnswer>;
}
const contains = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
};
const hash = (value: string | null | undefined): value is string => Boolean(value && /^[a-f0-9]{64}$/.test(value));
const origin = (project: ProjectEntry): string | null => {
  const endpoint = project.localEndpoint;
  return endpoint ? `http://${endpoint.host}:${endpoint.port}` : null;
};

export async function scopedContractQuery(args: { harnesses?: string[]; workspace?: string; name?: string;
  limit?: number; paths?: string[] }, ctx: Context,
effects: ScopedContractEffects = { registry: workspaceId => loadHarnessRegistry(workspaceId, { fresh: true }), worker: firstPartyCallersOffthread },
): Promise<ScopedContractReport> {
  const report: ScopedContractReport = { status: 'unknown', workspaceId: null, harnesses: [], error: null,
    repositories: [], candidates: [], relationships: [], mismatchedConsumers: [], truncated: false,
    limitations: ['Literal contract matches are static possibilities. Receiver/bus identity, middleware, authentication and runtime execution remain unknown.',
      'Only the requested registered JS/TS cohort and source paths are analyzed; dynamic keys, route patterns and untyped clients remain unknown.'] };
  const refuse = (error: string) => ({ ...report, error });
  // This branch is stronger than graph:query's legacy role gate. Never derive
  // a global workspace or repository list from an absent/wildcard principal.
  const workspace = ctx.principal?.workspaceId;
  if (!workspace || workspace === '*' || !ctx.principal?.slug
    || (!ctx.principal.capabilities.has('intel:read') && !ctx.principal.capabilities.has('*')))
    return refuse('contracts requires an authenticated concrete workspace principal with intel:read.');
  if ((ctx.workspaceId && ctx.workspaceId !== '*' && ctx.workspaceId !== workspace)
    || (args.workspace && args.workspace !== workspace)) return refuse('contracts workspace is outside the authenticated scope.');
  const callerHarness = resolveConcreteHarnessSlug(undefined, ctx);
  const harnesses = [...new Set(args.harnesses ?? (callerHarness ? [callerHarness] : []))];
  if (!harnesses.length || harnesses.length > 8 || harnesses.some(slug => !slug || slug === '*' || slug === 'all'))
    return refuse('contracts requires one to eight explicit registered harness slugs.');
  if (callerHarness) {
    if (harnesses.some(slug => slug !== callerHarness)) return refuse('contracts repository is outside the caller harness scope.');
  } else if (ctx.role !== 'operator' && ctx.role !== 'oracle') return refuse('Cross-harness contracts requires the existing operator/oracle read scope.');
  // All authorization decisions above precede registry IO and worker/source IO.
  const registry = await effects.registry(workspace);
  const projects = harnesses.map(slug => registry.projects.find(project => project.slug === slug));
  if (projects.some(project => !project?.path || (project.harness_kind === 'hive' && !project.self_repo)))
    return refuse('contracts repository is not registered as a source checkout in the authenticated workspace.');
  const admitted = projects as ProjectEntry[];
  let roots: string[];
  try { roots = admitted.map(project => realpathSync(project.path)); }
  catch { return refuse('contracts registered source checkout is unavailable.'); }
  // A broad registered parent must not silently admit another unselected repo.
  for (const project of registry.projects) {
    if (harnesses.includes(project.slug) || !project.path || (project.harness_kind === 'hive' && !project.self_repo)) continue;
    let physical: string;
    try { physical = realpathSync(project.path); } catch { continue; }
    if (roots.some(root => contains(root, physical))) return refuse('contracts source scope overlaps an unselected registered repository; select a narrower cohort.');
  }
  const limit = Math.min(500, Math.max(1, args.limit ?? 100));
  const answers: FirstPartyCallersAnswer[] = [];
  // Keep worker memory and the total 90s tool budget bounded; no fleet or index.
  for (let index = 0; index < admitted.length; index++) {
    const project = admitted[index]!;
    const answer = await effects.worker({ vendorDir: LSP_VENDOR_DIR, root: roots[index]!,
      repositoryId: `registry:${workspace}:${project.slug}`, name: '__contracts__', op: 'contracts',
      includeInterfaces: true, authorizedReadRoots: roots, paths: args.paths, limit },
    { budgetMs: Math.min(60_000, Math.floor(80_000 / admitted.length)) });
    if (answer.error || answer.interfaces?.status !== 'measured' || !hash(answer.evidence?.sourceScope.sourceFingerprint))
      return refuse(`contracts compiler evidence unavailable for ${project.slug}: ${answer.error ?? 'unmeasured source snapshot'}`);
    answers.push(answer);
  }
  // Check captured sources in the entire cohort before exposing a single row.
  // A source edit while a later worker runs invalidates the joined snapshot.
  for (let index = 0; index < answers.length; index++) {
    const answer = answers[index]!, root = roots[index]!;
    if (answer.evidence!.sourceScope.repositoryId !== `registry:${workspace}:${admitted[index]!.slug}`)
      return refuse('contracts compiler returned a different repository identity.');
    if (createHash('sha256').update(JSON.stringify(answer.evidence!.sourceScope.supportingFiles)).digest('hex')
      !== answer.evidence!.sourceScope.sourceFingerprint) return refuse('contracts compiler source fingerprint does not match its captured inputs.');
    for (const source of answer.evidence!.sourceScope.supportingFiles) {
      try {
        const file = realpathSync(join(root, source.path));
        if (!contains(root, file) || !hash(source.contentHash)
          || createHash('sha256').update(readFileSync(file)).digest('hex') !== source.contentHash)
          return refuse('contracts source snapshot changed or escaped the admitted repository.');
      } catch { return refuse('contracts captured source is unavailable.'); }
    }
  }
  report.workspaceId = workspace; report.harnesses = harnesses;
  const all: Candidate[] = [];
  for (let index = 0; index < answers.length; index++) {
    const answer = answers[index]!, project = admitted[index]!, evidence = answer.evidence!.sourceScope;
    report.repositories.push({ harness: project.slug, repositoryId: evidence.repositoryId!, sourceFingerprint: evidence.sourceFingerprint!,
      sources: evidence.supportingFiles, interfaces: answer.interfaces! });
    report.truncated ||= answer.truncation.truncated || answer.interfaces!.truncated;
    const endpoint = (site: SymbolSite): Endpoint | null => {
      const source = evidence.supportingFiles.find(file => file.path === site.path);
      return hash(source?.contentHash) ? { harness: project.slug, repositoryId: evidence.repositoryId!,
        sourceFingerprint: evidence.sourceFingerprint!, site, contentHash: source.contentHash } : null;
    };
    const add = (row: Omit<Candidate, 'endpoint'>, site: SymbolSite) => {
      const target = endpoint(site); if (target) all.push({ ...row, endpoint: target });
    };
    for (const registration of answer.interfaces!.registrations) {
      if (registration.factoryAuthority === 'unverified' || registration.kind === 'unknown') continue;
      add({ protocol: registration.kind === 'route' ? 'http' : 'rpc', role: 'producer',
        key: registration.kind === 'route' ? registration.path : registration.name, method: registration.method?.toUpperCase() ?? null,
        authority: registration.factoryAuthority, handler: registration.implementation }, registration.site);
    }
    for (const row of answer.interfaces!.interactions ?? []) add({ protocol: row.protocol, role: row.role, key: row.key,
      method: row.method, authority: row.authority, handler: row.handler }, row.site);
    for (const diagnostic of answer.interfaces!.diagnostics) report.mismatchedConsumers.push({ harness: project.slug, ...diagnostic });
  }
  const producers = all.filter(row => row.role === 'producer');
  for (const consumer of all.filter(row => row.role === 'consumer' && row.key !== null)) {
    const matches = producers.filter(producer => {
      if (producer.protocol !== consumer.protocol || producer.key === null || (args.name && producer.key !== args.name)) return false;
      if (producer.protocol !== 'http') return producer.key === consumer.key;
      // Same-spelled local fetch functions are candidates, not HTTP evidence.
      if (consumer.authority !== 'compiler-global' || !consumer.method || producer.method !== consumer.method) return false;
      let path = consumer.key!, service: string | null = null;
      try { const url = new URL(path); path = url.pathname; service = url.origin; } catch { /* relative URL */ }
      const targetProject = admitted.find(entry => entry.slug === producer.endpoint.harness)!;
      return path === producer.key && (service ? service === origin(targetProject) : producer.endpoint.harness === consumer.endpoint.harness);
    });
    for (const producer of matches) {
      if (report.relationships.length >= limit) { report.truncated = true; break; }
      report.relationships.push({ protocol: consumer.protocol, key: producer.key!, producer: producer.endpoint, consumer: consumer.endpoint,
        knowledge: 'static-possible', ambiguous: matches.length > 1 || consumer.authority === 'syntax', middleware: 'unknown', runtimeExecution: 'unknown' });
    }
  }
  const selectedCandidates = all.filter(row => !args.name || row.key === args.name);
  report.candidates = selectedCandidates.slice(0, limit);
  report.truncated ||= selectedCandidates.length > limit;
  report.status = 'measured';
  return report;
}
