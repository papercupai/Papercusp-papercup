/** Derived engineering relationships. The referenced stores remain the authorities. */
import type { PlanItemAnchor } from '../plan-items/anchors';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { HarnessRegistry } from '../harness-registry';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';
import type { EngineeringExecution } from '../observability/engineering-execution';
import type { ExecutionBoundaryReceipt } from '@papercusp/test-config/execution-details';

export const ENGINEERING_EVIDENCE_LIMITS = Object.freeze({
  nodes: 128, edges: 256, depth: 6, items: 8, specs: 16, proofs: 8, decisions: 16, cases: 20,
});
export type EngineeringState = 'current' | 'historical' | 'stale' | 'unknown';
export interface EngineeringScope { workspaceId: string; harness: string; root: string }
export interface EngineeringRef { tool: string; args: Record<string, unknown> }
export interface EngineeringQuery {
  symbol?: { path: string; name?: string; line1?: number };
  item?: { plan: string; id: string };
  includeContext?: boolean;
  limit?: number;
}
export interface EngineeringSymbol {
  path: string; name: string; line1: number; versionedSymbolId: string;
  fileFingerprint: string; declarationFingerprint: string | null;
}
export interface EngineeringItem {
  workspaceId: string; harness: string; plan: string; item: string;
  anchor?: PlanItemAnchor; anchorState?: EngineeringState;
}
export interface EngineeringSpec {
  plan: string; item: string; id: string; revision: number; currentRevision: number;
  fingerprint: string; behavior: string; lifecycle: string;
}
export interface EngineeringDecision {
  plan: string; id: string; title: string; body: string; itemRefs: string[]; affects: string[];
  bodyTruncated?: boolean;
}
export interface EngineeringProof {
  id: number; plan: string; spec: string; revision: number; workItem: string;
  evidenceRef: string; kind: string; state: EngineeringState; withdrawn: boolean;
  fingerprints: Record<string, string | null>; runId: number | null;
  reasons: string[];
}
export interface EngineeringRun { id: number; file: string; status: string; commit: string | null }
export interface EngineeringCase { runId: number; key: string; occurrence: number; status: string }
export interface EngineeringEvidenceDeps {
  /** Must validate the registered repository before any content adapter runs. */
  authorize(scope: EngineeringScope): Promise<boolean>;
  symbol(scope: EngineeringScope, query: NonNullable<EngineeringQuery['symbol']>): Promise<EngineeringSymbol[]>;
  sourceCurrent(scope: EngineeringScope, symbol: EngineeringSymbol): Promise<boolean>;
  items(scope: EngineeringScope, query: EngineeringQuery, symbol: EngineeringSymbol | null, limit: number): Promise<EngineeringItem[]>;
  specs(scope: EngineeringScope, item: EngineeringItem, limit: number): Promise<EngineeringSpec[]>;
  spec(scope: EngineeringScope, plan: string, id: string, revision: number): Promise<EngineeringSpec | null>;
  decisions(scope: EngineeringScope, item: EngineeringItem, limit: number): Promise<EngineeringDecision[]>;
  proofs(scope: EngineeringScope, spec: EngineeringSpec, limit: number): Promise<EngineeringProof[]>;
  run(scope: EngineeringScope, id: number): Promise<EngineeringRun | null>;
  cases(scope: EngineeringScope, runId: number, limit: number): Promise<EngineeringCase[]>;
  execution?(scope: EngineeringScope, runId: number): Promise<EngineeringExecution>;
}
export interface EngineeringNode {
  id: string; kind: 'symbol' | 'item' | 'spec' | 'decision' | 'proof' | 'work-item' | 'test-run' | 'test-case' | 'execution';
  state: EngineeringState; ref: EngineeringRef; data: Record<string, unknown>;
}
export interface EngineeringEdge {
  from: string; to: string; basis: 'declared-anchor' | 'item-spec' | 'decision-item-ref' | 'plan-affects'
    | 'unscoped-context' | 'proof-binding' | 'work-item-coverage' | 'recorded-test-run' | 'recorded-case' | 'recorded-boundary';
  knowledge: 'explicit' | 'observed'; state: EngineeringState; authority: EngineeringRef;
}
export interface EngineeringEvidence {
  schemaVersion: 1; scope: EngineeringScope; nodes: EngineeringNode[]; edges: EngineeringEdge[];
  gaps: { code: string; at: EngineeringRef; repair?: EngineeringRef }[];
  limits: Record<keyof typeof ENGINEERING_EVIDENCE_LIMITS, number>; truncated: boolean;
  execution: EngineeringExecution & { reason: string };
}

export interface EngineeringToolQuery {
  workspace?: string; harnesses?: string[]; plan?: string; item?: string;
  file_path?: string; name?: string; line1?: number; include_context?: boolean; limit?: number;
}
export interface EngineeringQueryReport {
  status: 'measured' | 'unknown'; error: string | null;
  evidence: EngineeringEvidence | null; recovery: EngineeringRef | null;
  /** This request's boundary receipt; it is not a recorded test/execution join. */
  boundaryObservation?: ExecutionBoundaryReceipt;
  boundaryObservationGap?: string;
}
type QueryContext = Pick<UnifiedToolContext, 'principal' | 'workspaceId' | 'harnessSlug' | 'role' | 'isSuperuser' | 'gateBypass'>;
export interface EngineeringQueryEffects {
  registry(workspaceId: string): Promise<HarnessRegistry>;
  read: typeof readEngineeringEvidence;
}

/** Public admission uses the existing principal and registry, never projectDir or caller roots. */
export async function engineeringEvidenceQuery(args: EngineeringToolQuery, ctx: QueryContext,
  effects: EngineeringQueryEffects = {
    registry: async workspace => (await import('../harness-registry')).loadHarnessRegistry(workspace, { fresh: true }),
    read: readEngineeringEvidence,
  },
): Promise<EngineeringQueryReport> {
  const refuse = (error: string, recovery: EngineeringRef | null = null): EngineeringQueryReport =>
    ({ status: 'unknown', error, evidence: null, recovery });
  const workspace = ctx.principal?.workspaceId;
  // Native SU transport intentionally leaves capabilities empty and carries
  // its authenticated authority in the dispatch context. Preserve that existing
  // contract without letting ordinary or caller-declared principals acquire it.
  const nativeSuperuser = ctx.isSuperuser === true && ctx.gateBypass?.capability === true
    && ctx.principal?.kind === 'system' && ctx.principal.trust === 'trusted'
    && ctx.principal.authMethod === 'bearer-token';
  if (!workspace || workspace === '*' || !ctx.principal?.slug
    || (!nativeSuperuser && !ctx.principal.capabilities.has('intel:read') && !ctx.principal.capabilities.has('*')))
    return refuse('evidence requires an authenticated concrete workspace principal with intel:read.');
  if ((ctx.workspaceId && ctx.workspaceId !== '*' && ctx.workspaceId !== workspace)
    || (args.workspace && args.workspace !== workspace)) return refuse('evidence workspace is outside the authenticated scope.');
  const callerHarness = resolveConcreteHarnessSlug(undefined, ctx);
  const harnesses = args.harnesses ?? (callerHarness ? [callerHarness] : []);
  if (harnesses.length !== 1 || !harnesses[0]?.trim() || ['*', 'all'].includes(harnesses[0]))
    return refuse('evidence requires exactly one registered harness.');
  const harness = harnesses[0];
  if (callerHarness ? harness !== callerHarness : ctx.role !== 'operator' && ctx.role !== 'oracle')
    return refuse('evidence repository is outside the caller harness scope.');
  const hasItem = args.plan !== undefined || args.item !== undefined;
  const hasSymbol = args.file_path !== undefined || args.name !== undefined || args.line1 !== undefined;
  const recovery: EngineeringRef = { tool: 'graph:query', args: { op: 'evidence', ...args, harnesses: [harness] } };
  if (hasItem === hasSymbol || (hasItem && (!args.plan || !/^P-\d{3,}$/.test(args.item ?? ''))))
    return refuse('evidence requires plan and item, or file_path with name or line1.', recovery);
  if (hasSymbol && (!args.file_path || (!args.name && args.line1 === undefined)))
    return refuse('Disambiguate evidence with file_path and name or line1.',
      { tool: 'graph:query', args: { op: 'symbol', name: args.name, harnesses: [harness] } });
  try {
    const registry = await effects.registry(workspace);
    const project = registry.projects.find(p => p.slug === harness);
    if (!project?.path || (project.harness_kind === 'hive' && !project.self_repo))
      return refuse('evidence repository is not registered as a source checkout in the authenticated workspace.');
    const evidence = await effects.read(hasItem ? { item: { plan: args.plan!, id: args.item! },
      includeContext: args.include_context, limit: args.limit } : {
      symbol: { path: args.file_path!, name: args.name, line1: args.line1 }, includeContext: args.include_context, limit: args.limit,
    }, { workspaceId: workspace, harness, root: project.path });
    return { status: 'measured', error: null, evidence, recovery: null };
  } catch {
    return refuse('Engineering evidence is unavailable or its registered source scope could not be validated. Retry the scoped query.', recovery);
  }
}

const id = (kind: string, ...parts: unknown[]) => `${kind}:${JSON.stringify(parts)}`;
const specRef = (scope: EngineeringScope, plan: string, spec: string, revision?: number): EngineeringRef => ({
  tool: 'plans:get-specs', args: { harness: scope.harness, slug: plan, specIds: [spec], ...(revision ? { revision } : {}) },
});
const itemRef = (scope: EngineeringScope, plan: string, item: string): EngineeringRef => ({
  tool: 'plans:get', args: { harness: scope.harness, slug: plan, itemIds: [item] },
});
const runRef = (scope: EngineeringScope, runId: number): EngineeringRef => ({
  tool: 'testing:runs', args: { harness: scope.harness, testRunIds: [runId], cases: true },
});

/** Scope is supplied by the authenticated caller, never inferred from a symbol name. */
export async function readEngineeringEvidence(
  query: EngineeringQuery, scope: EngineeringScope, supplied?: EngineeringEvidenceDeps,
): Promise<EngineeringEvidence> {
  if (Boolean(query.symbol) === Boolean(query.item)) throw new Error('engineering_selector_requires_symbol_or_item');
  if (!scope.workspaceId || !scope.harness || !scope.root) throw new Error('engineering_scope_required');
  if (query.symbol && (!query.symbol.path || query.symbol.path.startsWith('/') || query.symbol.path.includes('\\')
    || query.symbol.path.split('/').some(p => !p || p === '.' || p === '..')
    || (query.symbol.line1 !== undefined && (!Number.isInteger(query.symbol.line1) || query.symbol.line1 < 1)))) {
    throw new Error('engineering_symbol_selector_invalid');
  }
  if (query.item && (!query.item.plan || !/^P-\d{3,}$/.test(query.item.id))) throw new Error('engineering_item_selector_invalid');
  const deps = supplied ?? (await import('./engineering-evidence-store')).engineeringEvidenceStore();
  if (!await deps.authorize(scope)) throw new Error('engineering_scope_forbidden');
  const nodeLimit = Math.min(ENGINEERING_EVIDENCE_LIMITS.nodes,
    Number.isFinite(query.limit) ? Math.max(1, Math.trunc(query.limit!)) : ENGINEERING_EVIDENCE_LIMITS.nodes);
  const result: EngineeringEvidence = { schemaVersion: 1, scope, nodes: [], edges: [], gaps: [],
    limits: { ...ENGINEERING_EVIDENCE_LIMITS, nodes: nodeLimit }, truncated: false,
    execution: { status: 'unobserved', scope: 'instrumented-boundaries-only', observations: [], gaps: [],
      reason: 'Only named child boundaries are observed; static anchors, test outcomes and parent spans do not observe their callees.' } };
  const nodes = new Map<string, EngineeringNode>();
  const pendingRuns = new Map<number, { run: EngineeringRun; node: string; state: EngineeringState; ref: EngineeringRef;
    cases: EngineeringCase[]; observations: EngineeringExecution['observations'] }>();
  const edgeKeys = new Set<string>();
  const gapKeys = new Set<string>();
  const gap = (code: string, at: EngineeringRef, repair?: EngineeringRef) => {
    const key = JSON.stringify([code, at]);
    if (!gapKeys.has(key)) { gapKeys.add(key); result.gaps.push({ code, at, ...(repair ? { repair } : {}) }); }
  };
  const recover: EngineeringRef = { tool: 'graph:query', args: { op: 'evidence', harnesses: [scope.harness],
    ...(query.item ? { plan: query.item.plan, item: query.item.id } : {
      file_path: query.symbol!.path, name: query.symbol!.name, line1: query.symbol!.line1,
    }) } };
  const bounded = <T>(rows: T[], cap: number, at: EngineeringRef): T[] => {
    if (rows.length > cap) { result.truncated = true; gap('row-limit', at); }
    return rows.slice(0, cap);
  };
  const add = (node: EngineeringNode): string | null => {
    if (nodes.has(node.id)) return node.id;
    if (nodes.size >= nodeLimit) { result.truncated = true; gap('node-limit', node.ref); return null; }
    nodes.set(node.id, node); result.nodes.push(node); return node.id;
  };
  const edge = (from: string | null, to: string | null, basis: EngineeringEdge['basis'], state: EngineeringState, authority: EngineeringRef,
    knowledge: EngineeringEdge['knowledge'] = 'explicit') => {
    if (!from || !to) return;
    const key = JSON.stringify([from, to, basis]);
    if (edgeKeys.has(key)) return;
    if (result.edges.length >= ENGINEERING_EVIDENCE_LIMITS.edges) { result.truncated = true; gap('edge-limit', authority); return; }
    edgeKeys.add(key); result.edges.push({ from, to, basis, knowledge, state, authority });
  };
  const read = async <T>(at: EngineeringRef, action: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await action(); } catch { gap('authority-unavailable', at); return fallback; }
  };
  let symbol: EngineeringSymbol | null = null;
  let symbolNode: string | null = null;
  if (query.symbol) {
    const symbols = await read(recover, () => deps.symbol(scope, query.symbol!), []);
    if (symbols.length !== 1) { gap(symbols.length > 1 ? 'ambiguous-symbol' : 'symbol-unresolved', recover); return result; }
    symbol = symbols[0]!;
    if (symbol.path !== query.symbol.path || (query.symbol.name && symbol.name !== query.symbol.name)
      || (query.symbol.line1 && symbol.line1 !== query.symbol.line1)) {
      gap('symbol-selector-mismatch', recover); return result;
    }
    symbolNode = add({ id: id('symbol', symbol.versionedSymbolId), kind: 'symbol', state: 'current',
      ref: { tool: 'graph:query', args: { op: 'symbol', name: symbol.name, file_path: symbol.path, line1: symbol.line1 } },
      data: { ...symbol } });
  }
  const items = bounded(await read(recover, () => deps.items(scope, query, symbol, ENGINEERING_EVIDENCE_LIMITS.items + 1), []),
    ENGINEERING_EVIDENCE_LIMITS.items, recover);
  if (!items.length) gap('no-visible-item-anchor', recover, { tool: 'plans:add-item', args: { harness: scope.harness } });
  for (const item of items) {
    if (nodes.size >= nodeLimit) { result.truncated = true; gap('node-limit', recover); break; }
    if (item.workspaceId !== scope.workspaceId || item.harness !== scope.harness
      || (query.item && (item.plan !== query.item.plan || item.item !== query.item.id))) { gap('scope-mismatch', recover); continue; }
    const iref = itemRef(scope, item.plan, item.item);
    const itemNode = add({ id: id('item', scope.workspaceId, scope.harness, item.plan, item.item), kind: 'item',
      state: 'current', ref: iref, data: { plan: item.plan, item: item.item,
        ...(item.anchor ? { anchor: { id: item.anchor.id, kind: item.anchor.anchorKind, path: item.anchor.path,
          symbol: item.anchor.symbolName, line1: item.anchor.line, fingerprint: item.anchor.contentHash,
          fingerprintKind: item.anchor.anchorKind === 'symbol' ? 'declaration' : 'file',
          resolution: item.anchor.resolution, state: item.anchorState ?? 'unknown' } } : {}) } });
    if (symbolNode) {
      edge(symbolNode, itemNode, 'declared-anchor', item.anchorState ?? 'unknown', iref);
      if (item.anchorState !== 'current') gap('anchor-not-current', iref);
    }
    const decisions = bounded(await read(iref, () => deps.decisions(scope, item, ENGINEERING_EVIDENCE_LIMITS.decisions + 1), []),
      ENGINEERING_EVIDENCE_LIMITS.decisions, iref);
    for (const decision of decisions) {
      const direct = decision.plan === item.plan && decision.itemRefs.includes(item.item);
      const broader = decision.affects.includes(item.plan);
      if (!direct && !broader && !query.includeContext) continue;
      const dref: EngineeringRef = { tool: 'plans:get', args: { harness: scope.harness, slug: decision.plan, decisionId: decision.id } };
      const dnode = add({ id: id('decision', scope.workspaceId, scope.harness, decision.plan, decision.id), kind: 'decision',
        state: 'current', ref: dref, data: { plan: decision.plan, decision: decision.id, title: decision.title, body: decision.body } });
      edge(dnode, itemNode, direct ? 'decision-item-ref' : broader ? 'plan-affects' : 'unscoped-context', 'current', dref);
      if (decision.bodyTruncated) { result.truncated = true; gap('decision-body-limit', dref); }
      if (!direct && !broader) gap('decision-applicability-unknown', dref);
    }
    const specs = bounded(await read(iref, () => deps.specs(scope, item, ENGINEERING_EVIDENCE_LIMITS.specs + 1), []),
      ENGINEERING_EVIDENCE_LIMITS.specs, iref);
    if (!specs.length) gap('no-visible-spec', iref);
    for (const spec of specs) {
      if (nodes.size >= nodeLimit) { result.truncated = true; gap('node-limit', iref); break; }
      if (spec.plan !== item.plan || spec.item !== item.item) { gap('scope-mismatch', iref); continue; }
      const sref = specRef(scope, spec.plan, spec.id, spec.revision);
      const liveSpec = (value: EngineeringSpec) => value.revision === value.currentRevision
        && value.lifecycle !== 'retired' && value.lifecycle !== 'superseded';
      const addSpec = (value: EngineeringSpec) => add({ id: id('spec', scope.workspaceId, scope.harness, value.plan, value.id, value.revision),
        kind: 'spec', state: liveSpec(value) ? 'current' : 'historical',
        ref: specRef(scope, value.plan, value.id, value.revision), data: { ...value } });
      const specNode = addSpec(spec);
      edge(itemNode, specNode, 'item-spec', liveSpec(spec) ? 'current' : 'historical', sref);
      const proofs = bounded(await read(sref, () => deps.proofs(scope, spec, ENGINEERING_EVIDENCE_LIMITS.proofs + 1), []),
        ENGINEERING_EVIDENCE_LIMITS.proofs, sref);
      if (!proofs.length) gap('no-visible-proof', sref);
      for (const proof of proofs) {
        if (nodes.size >= nodeLimit) { result.truncated = true; gap('node-limit', sref); break; }
        if (proof.plan !== spec.plan || proof.spec !== spec.id) { gap('scope-mismatch', sref); continue; }
        const pref: EngineeringRef = { tool: 'plans:get-spec-evidence', args: { harness: scope.harness,
          slug: proof.plan, bindingIds: [proof.id], ...(proof.withdrawn ? { includeRetracted: true } : {}) } };
        const state = proof.withdrawn || proof.revision !== spec.currentRevision || !liveSpec(spec) ? 'historical' : proof.state;
        const proofNode = add({ id: id('proof', scope.workspaceId, scope.harness, proof.id), kind: 'proof', state,
          ref: pref, data: { ...proof } });
        let owningSpec = specNode;
        if (proof.revision !== spec.revision) {
          const historical = await read(pref, () => deps.spec(scope, proof.plan, proof.spec, proof.revision), null);
          owningSpec = historical && historical.plan === spec.plan && historical.item === item.item
            && historical.id === spec.id && historical.revision === proof.revision ? addSpec(historical) : null;
          if (!owningSpec) gap('historical-spec-unavailable', pref);
        }
        edge(owningSpec, proofNode, 'proof-binding', state, pref);
        if (proof.workItem) {
          const wref: EngineeringRef = { tool: 'work_items:get', args: { harness: scope.harness, id: proof.workItem } };
          const workNode = add({ id: id('work-item', scope.workspaceId, proof.workItem), kind: 'work-item', state: 'unknown',
            ref: wref, data: { id: proof.workItem } });
          edge(workNode, owningSpec, 'work-item-coverage', state, pref);
        }
        if (state !== 'current') gap(`proof-${state}`, pref);
        if (proof.runId === null || !proofNode) continue;
        const rref = runRef(scope, proof.runId);
        const run = await read(rref, () => deps.run(scope, proof.runId!), null);
        if (run && run.id !== proof.runId) { gap('scope-mismatch', rref); continue; }
        const runNode = add({ id: id('test-run', scope.workspaceId, scope.harness, proof.runId), kind: 'test-run',
          state: run ? state : 'unknown', ref: rref, data: run ? { ...run } : { id: proof.runId, present: false } });
        edge(proofNode, runNode, 'recorded-test-run', run ? state : 'unknown', pref);
        if (!run || run.id !== proof.runId) { gap('test-run-unavailable', rref); continue; }
        // Run membership is an observed ledger fact, not an invented spec→case assertion.
        gap('exact-spec-case-mapping-not-measured', pref);
        if (runNode && !pendingRuns.has(run.id)) pendingRuns.set(run.id, {
          run, node: runNode, state, ref: rref, cases: [], observations: [],
        });
      }
    }
  }
  // Retain each branch's exact references before spending the shared node budget
  // on cases. A large early suite must not hide a later requirement's only run.
  for (const entry of pendingRuns.values()) {
    const { run, ref } = entry;
    entry.cases = bounded(await read(ref, () => deps.cases(scope, run.id, ENGINEERING_EVIDENCE_LIMITS.cases + 1), []),
      ENGINEERING_EVIDENCE_LIMITS.cases, ref).filter(test => {
      if (test.runId === run.id) return true;
      gap('scope-mismatch', ref); return false;
    });
    if (!entry.cases.length) gap('test-cases-unavailable', ref);
    if (deps.execution) {
      const observed = await read(ref, () => deps.execution!(scope, run.id), null);
      for (const reason of observed?.gaps ?? ['execution-unavailable']) {
        gap(reason, ref);
        if (!result.execution.gaps.includes(reason)) result.execution.gaps.push(reason);
      }
      entry.observations = bounded(observed?.observations ?? [], ENGINEERING_EVIDENCE_LIMITS.cases, ref).filter(observation => {
        if (observation.runId === run.id && entry.cases.some(test => test.key === observation.caseKey
          && test.occurrence === observation.occurrence)) return true;
        gap('execution-case-mismatch', ref); return false;
      });
      const observedCase = (test: EngineeringCase) => entry.observations.some(observation =>
        observation.caseKey === test.key && observation.occurrence === test.occurrence);
      entry.cases.sort((a, b) => Number(observedCase(b)) - Number(observedCase(a)));
    }
  }
  for (let index = 0; index < ENGINEERING_EVIDENCE_LIMITS.cases; index++) {
    for (const { run, node, state, ref, cases, observations } of pendingRuns.values()) {
      const test = cases[index];
      if (!test) continue;
      const caseNode = add({ id: id('test-case', scope.workspaceId, run.id, test.key, test.occurrence), kind: 'test-case',
        state, ref, data: { ...test } });
      edge(node, caseNode, 'recorded-case', state, ref);
      if (!caseNode) continue;
      for (const observation of observations) {
        if (observation.caseKey === test.key && observation.occurrence === test.occurrence) {
          const execution = add({ id: id('execution', scope.workspaceId, observation.invocationId, observation.receipt.spanId),
            kind: 'execution', state, ref, data: { ...observation } });
          edge(caseNode, execution, 'recorded-boundary', state, ref, 'observed');
          if (execution && result.execution.observations.length < ENGINEERING_EVIDENCE_LIMITS.cases
            && !result.execution.observations.some(row => row.invocationId === observation.invocationId
              && row.receipt.spanId === observation.receipt.spanId)) {
            result.execution.observations.push(observation);
            result.execution.status = 'observed';
          }
        }
      }
    }
  }
  if (symbol && !await read(recover, () => deps.sourceCurrent(scope, symbol!), false)) {
    if (symbolNode) nodes.get(symbolNode)!.state = 'unknown';
    for (const relation of result.edges) if (relation.from === symbolNode && relation.basis === 'declared-anchor') relation.state = 'unknown';
    gap('source-revalidation-failed', recover);
  }
  return result;
}
