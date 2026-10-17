/**
 * `graph:query` — the curated GitNexus call-graph facade, exposed as a tool.
 *
 * Plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-006 / WI-40206,
 * decision D-057.
 *
 * WHY THIS FILE EXISTS. `gitnexusFacade` (the GitNexus half of the read-only
 * code-intelligence plane) was built in P-012 and then reached by NOTHING: it
 * had zero non-test callers, and `configureGitnexusDispatch` was never called
 * outside tests. That is not a cosmetic gap. `code:run` exposes only
 * `tools.ns.verb(args)` — "no require/process/import" (see `code/run.ts`) — so
 * a facade with no tool of its own is unreachable from every agent surface,
 * and the curated plane silently degraded to "use the raw `gitnexus.*` plugin
 * tools", which is exactly what D-021 warns against: they answer with unranked,
 * unbudgeted results and no freshness contract, so a wrong answer is
 * indistinguishable from a confident one.
 *
 * NAMING. Deliberately NOT `gitnexus:query`. The bridge plugin already
 * registers a bare `query` handler, surfaced as `gitnexus.query`; a colon-form
 * `gitnexus:query` would collide with it in the `code:run` tool namespace
 * (`tools.gitnexus.query`) — the curated and uncurated planes would answer to
 * one name. `graph:` is a free namespace, and it names the plane rather than
 * the vendor, matching its sibling `lsp:query`.
 *
 * ONE tool with an op enum rather than five, because D-007 makes prompt weight
 * an acceptance criterion for this plan.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import {
  GITNEXUS_FACADE_OPS,
  GITNEXUS_NOT_ROUTABLE,
  MAX_SITES_PER_ANSWER,
  gitnexusFacade,
  gitnexusRefusal,
  type GitnexusFacadeOp,
} from '../../code-intelligence/gitnexus-facade';
import { unmeasuredSourceEvidence, versionedSymbolIdentity, type CodeIntelAnswer, type CodeIntelIntent } from '../../code-intelligence/contracts';
import { FIRST_PARTY_CALLERS_DEFAULT_LIMIT } from '../../code-intelligence/first-party-callers';
import { firstPartyCallersOffthread } from '../../code-intelligence/first-party-callers-offthread';
import { LSP_VENDOR_DIR } from '../../code-intelligence/lsp-adapter';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { SERVING_RUNTIME_IDS } from '../../serving-runtimes';
import { sourceRuntimeProvenance } from '../../code-intelligence/source-runtime-provenance';
import { scopedContractQuery } from '../../code-intelligence/scoped-contracts';
import { queryPushSnapshot } from '../../code-intelligence/push-snapshot';

/**
 * WI-10006543 (plan gitnexus-deterministic-integration-2026-10-05, D-026, D-018):
 * `callers` first admits positive syntax matches from the maintained snapshot,
 * after corroborating its source hashes against the registered workspace root.
 * Misses and ambiguities use the vendored TypeScript call hierarchy in a forked
 * worker. Snapshot coverage explicitly remains a lower bound. The compiler unions
 * same-name declarations, and every reported site has a line. The
 * GitNexus selectors (kind, file_path, uid, repo) do not apply to it.
 */
async function firstPartyCallersAnswer(
  args: { op?: string; name?: string; kind?: string; file_path?: string; line1?: number; uid?: string; repo?: string; limit?: number; paths?: string[];
    target?: string; target_file_path?: string; target_line1?: number; direction?: 'upstream' | 'downstream' | 'both'; max_depth?: number; max_paths?: number },
  ctx: { projectDir?: string; workspaceId?: string; principal?: { workspaceId?: string } | null },
): Promise<CodeIntelAnswer> {
  const limit = Math.min(Math.max(1, args.limit ?? MAX_SITES_PER_ANSWER), FIRST_PARTY_CALLERS_DEFAULT_LIMIT);
  const nativeOp = ['communities', 'flows', 'concept-search'].includes(args.op ?? '') ? args.op as 'communities' | 'flows' | 'concept-search'
    : args.op === 'symbol' || args.op === 'callees' || args.op === 'context' || args.op === 'impact' || args.op === 'trace' ? args.op : 'callers';
  if (nativeOp !== 'callers' && (args.uid || args.repo)) return {
    backend: 'typescript-service', intent: nativeOp === 'impact' || nativeOp === 'trace' ? nativeOp : nativeOp === 'callees' ? 'callees' : 'definition', query: args.name ?? '', sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unknown', indexedAt: null, indexedCommit: null, staleVsDisk: null }, latencyMs: 0,
    error: 'Native symbol queries use the current workspace and file_path/line1/kind; GitNexus uid/repo selectors are unsupported.',
  };
  const root = resolveAgentWorkspaceRoot(ctx);
  const snapshot = nativeOp === 'callers' ? await queryPushSnapshot({ op: 'callers', root,
    workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId, name: args.name, paths: args.paths, limit }) : null;
  const answer = snapshot ?? await firstPartyCallersOffthread({
    vendorDir: LSP_VENDOR_DIR,
    root,
    name: args.name ?? '',
    ...(nativeOp !== 'callers' ? { op: nativeOp, filePath: args.file_path, line1: args.line1, kind: args.kind } : {}),
    ...(['impact', 'trace', 'flows'].includes(nativeOp) ? { target: args.target, targetFilePath: args.target_file_path,
      targetLine1: args.target_line1, direction: args.direction, maxDepth: args.max_depth, maxPaths: args.max_paths } : {}),
    limit,
    ...(args.paths && args.paths.length > 0 ? { paths: args.paths } : {}),
  });
  if (nativeOp !== 'callers') return answer;
  const ignored = (['kind', 'file_path', 'uid', 'repo'] as const).filter((k) => args[k] !== undefined);
  if (ignored.length === 0) return answer;
  const coverage = answer.coverage ?? {
    basis: 'compiler-project' as const,
    sourceCompleteness: 'unverified' as const,
    limitations: [],
  };
  return {
    ...answer,
    coverage: {
      ...coverage,
      limitations: [
        ...coverage.limitations,
        `callers ignores ${ignored.join(', ')}: it answers for every symbol with this name in the workspace.`,
      ],
    },
  };
}

// Keep the closed operation set, but also accept intents that the facade
// deliberately refuses. That lets an agent receive the typed `useInstead`
// guidance rather than a schema error with no redirect.
const OP_VALUES = [
  'communities', 'flows', 'concept-search',
  'contracts',
  'context',
  'trace',
  ...GITNEXUS_FACADE_OPS,
  ...Object.keys(GITNEXUS_NOT_ROUTABLE),
] as [string, ...string[]];

export default defineTool({
  name: 'graph:query',
  description:
    'Code topology: symbol | context | callers | callees | impact | trace | contracts | communities | flows | concept-search | health. Callers prefer hash-checked positive syntax snapshots; misses use the compiler. Read coverage for lower bounds. Other native operations use JS/TS compiler snapshots. Discovery requires bounded paths; communities are weak call components, flows are possible call paths, and concept-search fuses symbol/path and source-text rankings. Retrieval and static paths do not prove runtime execution. contracts joins scoped static HTTP/RPC/event evidence. Other languages receive explicit unsupported results.',
  guidance: {
    when: 'For "who calls X?", use op:"callers", name and bounded paths; for "what does X call?", use op:"callees". Read syntax/compiler coverage before treating sites as binding or change-impact evidence.',
    notWhen:
      'Use lsp:query for references, implementations, diagnostics and rename previews; scoped rg for literals. Native symbol/context/callees currently admit JS/TS compiler inputs. Runtime diagnosis needs state/log tools.',
    chaining:
    'op:"context" → op:"impact" for the change radius → op:"trace", target:"name" for a forward call path. Use paths to bound compiler source scope. Static paths do not establish runtime execution. op:"health" reports index freshness; lsp:query handles references/diagnostics.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // Compiler workers and nested runtime probes do not need an ambient DB transaction.
  skipWorkspaceTx: true,
  // The bridge keeps a resident child per workspace, but a COLD first call pays
  // graph load on a multi-GiB index. Declared so the dispatch stack's budget
  // matches the backend's real worst case instead of timing out mid-load.
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z.enum(OP_VALUES).describe('Which read-only operation to run.'),
    harnesses: z.array(z.string().min(1)).min(1).max(8).optional()
      .describe('contracts: explicit registered repository cohort; scoped callers may only select their own harness.'),
    workspace: z.string().min(1).optional().describe('contracts: must equal the authenticated principal workspace; never expands authority.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Exact symbol name for topology; concept-search takes a phrase. Optional for communities/flows/health.'),
    kind: z
      .string()
      .min(1)
      .optional()
      .describe(
        "GitNexus symbol kind ('Function', 'Class', ...). Optional; narrows an ambiguous name.",
      ),
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe('symbol/context/callees: defining file; picks one of several same-name symbols.'),
    line1: z.number().int().min(1).optional().describe('Native symbol/context/callees: defining line to distinguish same-name declarations in one file.'),
    target: z.string().min(1).optional().describe('trace: exact destination symbol name.'),
    target_file_path: z.string().min(1).optional().describe('trace: destination defining file to disambiguate homonyms.'),
    target_line1: z.number().int().min(1).optional().describe('trace: destination defining line.'),
    max_depth: z.number().int().min(0).max(16).optional().describe('impact/trace: maximum call hops; default 5.'),
    max_paths: z.number().int().min(1).max(100).optional().describe('impact/trace: maximum reported paths; default 20.'),
    uid: z
      .string()
      .min(1)
      .optional()
      .describe('GitNexus index uid; unsupported by native symbol/context/callees. Use file_path/line1 for native disambiguation.'),
    direction: z
      .enum(['upstream', 'downstream', 'both'])
      .optional()
      .describe(
        '`impact` only: which way to walk the graph. Defaults to downstream (what this change breaks).',
      ),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe('Repository name in the GitNexus index. Defaults to the papercusp index.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. Default 100; callers allows up to 500.'),
    paths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('Native symbol/context/callers/callees: repo-relative search files/dirs. Default: whole repo.'),
    runtime: z.enum(SERVING_RUNTIME_IDS).optional()
      .describe('Native operations: join captured source versions to the selected runtime artifact via existing pipeline evidence. Unknown measurements remain explicit.'),
    runtime_limit: z.number().int().min(1).max(8).optional()
      .describe('Maximum supporting files compared to the selected runtime; default 4. Omitted files remain unmeasured.'),
  }),
  async handler(args, ctx) {
    const op = args.op as string;
    if (op === 'contracts') return { data: await scopedContractQuery(args, ctx) };
    const native = ['callers', 'symbol', 'callees', 'context', 'impact', 'trace', 'communities', 'flows', 'concept-search'].includes(op);
    const scoped = (answer: CodeIntelAnswer): CodeIntelAnswer => {
      const measured = answer.evidence ? answer : { ...answer,
      evidence: unmeasuredSourceEvidence(answer, { repositoryId: null, identityKind: 'unknown',
        paths: native ? args.paths ?? (args.file_path ? [args.file_path] : ['.']) : [],
        basis: native ? 'compiler-project' : 'indexed-code' }, [
        'The producer supplied no measured repository/content snapshot. Resolve source versions before treating these sites as source-backed relationships.',
        'A repository selector and current disk contents do not identify the indexed source snapshot.',
      ]) };
      const evidence = measured.evidence!;
      const sourceByPath = new Map(evidence.sourceScope.supportingFiles.map(source => [source.path, source]));
      const hash = (value: string | null | undefined) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      const endpointBacked = (endpoint: import('../../code-intelligence/contracts').CodeIntelVersionedSite) =>
        hash(endpoint.contentHash) && Boolean(endpoint.versionedSymbolId) &&
        endpoint.contentHash === sourceByPath.get(endpoint.site.path)?.contentHash &&
        endpoint.versionedSymbolId === versionedSymbolIdentity(evidence.sourceScope.repositoryId,
          endpoint.site, sourceByPath.get(endpoint.site.path));
      const traversal = measured.traversal;
      const pathsBacked = !traversal ? (!['impact', 'trace'].includes(op) || measured.error !== null) :
        (traversal.maxDepth === (args.max_depth ?? 5) && traversal.maxPaths === (args.max_paths ?? 20) &&
        traversal.direction === (op === 'trace' ? 'forward' : args.direction ?? 'downstream') &&
        (op !== 'trace' || (Boolean(traversal.target) && (traversal.outcome !== 'found' || traversal.paths.length > 0))) &&
        endpointBacked(traversal.start) && (!traversal.target || endpointBacked(traversal.target)) &&
        traversal.paths.length <= traversal.maxPaths && traversal.paths.every(path => {
          if (path.siteIndices.length > traversal.maxDepth || (op === 'trace' && path.walk !== 'forward')) return false;
          let previous = traversal.start.versionedSymbolId;
          for (const index of path.siteIndices) {
            if (!Number.isInteger(index) || index < 0 || index >= measured.sites.length) return false;
            const edge = evidence.relationships.find(row => row.siteIndex === index);
            if (!edge?.source || !edge.target || edge.knowledge !== 'observed') return false;
            const from = path.walk === 'forward' ? edge.source : edge.target;
            const to = path.walk === 'forward' ? edge.target : edge.source;
            if (!endpointBacked(from) || !endpointBacked(to) || from.versionedSymbolId !== previous) return false;
            previous = to.versionedSymbolId;
          }
          return op !== 'trace' || (Boolean(traversal.target) && previous === traversal.target!.versionedSymbolId);
        }));
      const discovery = measured.discovery;
      const discoveryBacked = !discovery ? (!['communities', 'flows', 'concept-search'].includes(op) || measured.error !== null)
        : discovery.knowledge === 'inferred' && discovery.semanticSimilarity === 'unmeasured' &&
          hash(evidence.sourceScope.sourceFingerprint) && discovery.groups.every(group => group.members.every(endpointBacked)) &&
          discovery.matches.every(match => match.evidence === 'retrieval' && Number.isFinite(match.score) && match.score > 0 &&
            endpointBacked(match.symbol) && discovery.groups.some(group => group.id === match.groupId &&
              group.members.some(member => member.versionedSymbolId === match.symbol.versionedSymbolId))) &&
          discovery.flows.length <= (args.max_paths ?? 20) && discovery.flows.every(flow =>
            flow.runtimeExecution === 'unknown' && endpointBacked(flow.entry) && flow.nodes.length > 0 &&
            flow.nodes.length - 1 <= (args.max_depth ?? 5) && flow.nodes.every(endpointBacked) &&
            flow.entry.versionedSymbolId === flow.nodes[0]!.versionedSymbolId && flow.nodes.slice(1).every((node, index) =>
              evidence.relationships.some(edge => edge.knowledge === 'observed' && edge.binding === 'direct' &&
                edge.source?.versionedSymbolId === flow.nodes[index]!.versionedSymbolId && edge.target?.versionedSymbolId === node.versionedSymbolId)));
      const sourceBacked = pathsBacked && discoveryBacked && (measured.sites.length === 0 || (Boolean(evidence.sourceScope.repositoryId) &&
        hash(evidence.sourceScope.sourceFingerprint) && measured.sites.every((site, index) => {
          const identity = evidence.siteIdentities.find(row => row.siteIndex === index);
          return identity?.sourcePath === site.path && hash(identity.contentHash) && Boolean(identity.versionedSymbolId) &&
            identity.contentHash === sourceByPath.get(site.path)?.contentHash &&
            identity.versionedSymbolId === versionedSymbolIdentity(evidence.sourceScope.repositoryId, site, sourceByPath.get(site.path));
        }) && evidence.relationships.every(relation => (!relation.source || endpointBacked(relation.source)) &&
          (!relation.target || endpointBacked(relation.target)))));
      if (sourceBacked) return measured;
      const reason = 'Graph source versions are unavailable: refusing sites whose repository/content snapshot cannot be determined. Re-query through an admitted current compiler route.';
      return { ...measured, sites: [], traversal: undefined, discovery: undefined, error: [measured.error, reason].filter(Boolean).join(' '),
        freshness: { ...measured.freshness, health: 'unknown' },
        truncation: { truncated: false, totalAvailable: null, continuation: null },
        evidence: { ...evidence, siteIdentities: [], relationships: [],
          graphScope: { ...evidence.graphScope, limitations: [...evidence.graphScope.limitations, reason] } } };
    };
    if (!native && !GITNEXUS_FACADE_OPS.includes(op as GitnexusFacadeOp)) {
      // OP_VALUES admits these intentionally so the refusal map is reachable
      // through the actual agent-facing tool, not just through unit imports.
      const refusal = gitnexusRefusal(op as CodeIntelIntent, args.name ?? '');
      if (refusal) return { data: scoped(refusal) };
    }

    if (native) {
      const answer = scoped(await firstPartyCallersAnswer(args, ctx));
      if (!args.runtime) return { data: answer };
      const runtimeProvenance = await sourceRuntimeProvenance(answer, args.runtime,
        resolveAgentWorkspaceRoot(ctx), ctx.dispatchTool, args.runtime_limit);
      return { data: { ...answer, runtimeProvenance } };
    }

    // The dispatcher is passed PER CALL rather than installed into the module
    // global by this handler. It closes over `ctx` — which carries the calling
    // principal and workspace — so publishing it to a process-wide global would
    // hand this request's context to every concurrent caller. The facade
    // prefers an explicitly-passed dispatcher for exactly this reason.
    //
    // The bridge's handlers are registered under bare names (`context`,
    // `impact`, ...); namespacing to the plugin's tool id is this seam's job,
    // which is why the facade dispatches bare names.
    //
    // `dispatchTool` is OPTIONAL on the context — "present only on transports
    // with a server-side dispatcher (MCP)". On a transport without one we pass
    // NO dispatcher rather than crashing, which lands on the facade's wiring-
    // fault refusal. That refusal is the correct answer here: it says the plane
    // is unreachable in this process, where a thrown error would be reported as
    // a failed query and an empty result would be read as "no matches" — the
    // exact confusion this facade exists to prevent.
    const dispatchTool = ctx.dispatchTool;
    const dispatch = dispatchTool
      ? (tool: string, toolArgs: Record<string, unknown>) =>
          dispatchTool(`gitnexus.${tool}`, toolArgs)
      : undefined;

    const answer = await gitnexusFacade(
      op as GitnexusFacadeOp,
      {
        name: args.name,
        kind: args.kind,
        file_path: args.file_path,
        uid: args.uid,
        direction: args.direction,
        repo: args.repo,
        limit: args.limit,
      },
      dispatch,
    );
    return { data: scoped(answer) };
  },
});
