import {
  resolveEffectiveStatusForItems,
  type ItemStatus,
  type PlanItem,
} from '@papercusp/plan-parser';
import {
  getDependencyPolicy,
  type DependencyPolicyFinding,
} from '../../scheduler/dependency-invariants';
import type { CodeIntelSourceEvidence } from '../../code-intelligence/contracts';
import type { PlanItemCoverage } from '../../plan-item-coverage';

export interface PlanCodeScope {
  symbol: string;
  file: string;
  paths?: string[];
  taskPaths: { itemId: string; paths: string[] }[];
}

/** P-013: source-backed suggestions only. This reader cannot claim or assign work. */
export function nativePlanGraphAdvice(items: readonly Pick<PlanItem, 'id' | 'storedStatus' | 'blockedBy'>[], scope: PlanCodeScope,
  evidence: CodeIntelSourceEvidence | undefined, coverage: ReadonlyMap<string, PlanItemCoverage>, slug: string,
  fileClaims: { status: 'measured' | 'unknown'; held: readonly { path: string; owner: string; intent: string; coordinationDomain?: string }[] } = { status: 'unknown', held: [] }) {
  const active = items.filter(item => !['done', 'dropped'].includes(item.storedStatus));
  const byId = new Map(active.map(item => [item.id, item]));
  const tasks = scope.taskPaths.filter(task => byId.has(task.itemId));
  const ownsPath = (path: string) => tasks.filter(task => task.paths.includes(path)).map(task => task.itemId);
  const ordering: { producer: string; consumer: string; sourcePath: string; targetPath: string; kind: string }[] = [];
  const measured = evidence?.graphScope.basis === 'compiler-project' && Boolean(evidence.sourceScope.sourceFingerprint);
  if (measured) {
    for (const edge of evidence!.relationships) {
      if (edge.origin !== 'compiler' || edge.knowledge === 'unknown' || !edge.source || !edge.target
        || !['callers', 'callees', 'impact', 'imports'].includes(edge.kind)) continue;
      const sources = evidence!.sourceScope.supportingFiles;
      if (![edge.source, edge.target].every(site => sources.some(source => source.path === site.site.path
        && source.contentHash === site.contentHash && source.representation === 'full-source'))) continue;
      for (const consumer of ownsPath(edge.source.site.path)) for (const producer of ownsPath(edge.target.site.path)) {
        if (producer !== consumer && !ordering.some(pair => pair.producer === producer && pair.consumer === consumer)) {
          ordering.push({ producer, consumer, sourcePath: edge.source.site.path, targetPath: edge.target.site.path, kind: edge.kind });
        }
      }
    }
  }
  const remaining = new Set(active.map(item => item.id));
  const proposedOrder: string[] = [];
  while (remaining.size) {
    const ready = active.filter(item => remaining.has(item.id)
      && !item.blockedBy.some(id => remaining.has(id))
      && !ordering.some(edge => edge.consumer === item.id && remaining.has(edge.producer)));
    if (!ready.length) break;
    for (const item of ready) { remaining.delete(item.id); proposedOrder.push(item.id); }
  }
  const overlaps: { items: string[]; paths: string[] }[] = [];
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    if (tasks[i].itemId === tasks[j].itemId) continue;
    const paths = [...new Set(tasks[i].paths.filter(path => tasks[j].paths.includes(path)))];
    if (paths.length) overlaps.push({ items: [tasks[i].itemId, tasks[j].itemId], paths });
  }
  return { status: measured ? 'measured' as const : 'unknown' as const,
    sourceFingerprint: evidence?.sourceScope.sourceFingerprint ?? null,
    scope: { repositoryId: evidence?.sourceScope.repositoryId ?? null, paths: evidence?.sourceScope.paths ?? [], taskPaths: tasks },
    ordering, proposedOrder: remaining.size ? [] : proposedOrder, cyclesOrConflicts: [...remaining], overlaps,
    ownership: tasks.map(task => ({ itemId: task.itemId, coverage: coverage.get(`${slug}#${task.itemId}`) ?? null })),
    fileClaims,
    limitations: ['Static source dependencies are advisory; runtime execution and complete dependency coverage are unknown.',
      'Ownership comes from the current claim read. Re-read it before acting; assignments and file locks remain authoritative.'] };
}

const TERMINAL_STATUSES = new Set<ItemStatus>(['done', 'dropped']);

// Exported so a test can use the REAL vocabulary as a negative control instead of hand-copying it
// (a copied vocabulary drifts from the code that owns it, silently, and only under load).
export const RELEASE_GATE_RE =
  /\b(?:alpha|beta|distribution|general availability|go[- ]?live|launch|publish|release|rollout|ship(?:ping)?|production)\b/i;
const FOUNDATION_BUILD_RE =
  /\b(?:adapter|api|backend|build|core|database|foundation(?:al)?|frontend|implement(?:ation)?|infrastructure|provider|provision|scaffold|schema|storage)\b/i;
// EI-22089706217678704: the platform's mandatory post-implementation phase (code-truth audit →
// acceptance rubric → independent grading → ship) is a GATE too, but it is not a *release* gate and
// RELEASE_GATE_RE does not recognise it — measured on the reporting incident, that regex matched
// the plan's ship item and missed its sibling test item entirely. Kept deliberately narrow: these
// are whole-phase names, not the bare word "test", which appears in most ordinary build items.
// Measured over the 172 active plans: this vocabulary adds 9 findings on top of RELEASE_GATE_RE's
// 74, where keying on /\btests?\b/ instead would have flagged 49 mostly-ordinary items.
const VERIFICATION_GATE_RE =
  /\b(?:acceptance|post-implementation|final act|rubric|sign[- ]?off|code-truth|independent grading|every changed seam)\b/i;

function isGateItem(item: PlanItem): boolean {
  const text = itemSearchText(item);
  return RELEASE_GATE_RE.test(text) || VERIFICATION_GATE_RE.test(text);
}

// Keep the semantic summaries below the generic result door's lean 300-char
// string cap. Ordinary plans still show their complete path; pathological DAGs
// retain both ends and an exact omitted count instead of losing the chokepoint
// to the raw-array prefix (WI-41311 / P-052).
const CRITICAL_PATH_SUMMARY_MAX_ITEMS = 24;
const CRITICAL_PATH_SUMMARY_EDGE_ITEMS = CRITICAL_PATH_SUMMARY_MAX_ITEMS / 2;
const FAN_IN_SUMMARY_MAX_ITEMS = 5;
const FAN_IN_SUMMARY_MAX_BLOCKERS = 4;

export interface PlanDagBlockingEdge {
  itemId: string;
  blockerId: string;
  itemPhase: string | null;
  blockerPhase: string | null;
  blockerStatus: ItemStatus | 'missing';
}

export interface PlanDagFanInChokepoint {
  itemId: string;
  blockerIds: string[];
}

export interface PlanDagPhaseInversion {
  itemId: string;
  itemPhase: string;
  blockerId: string;
  blockerPhase: string;
}

export interface PlanDagReleaseGateBlock {
  itemId: string;
  itemPhase: string | null;
  blockerId: string;
  blockerPhase: string | null;
}

export type PlanDagNonReadyReason =
  | 'cycle'
  | 'dangling'
  | 'dependency'
  | 'needs-human'
  | 'sticky-blocked'
  | 'in-progress'
  | 'non-actionable-status';

export interface PlanDagNonReadyItem {
  itemId: string;
  effectiveStatus: ItemStatus;
  reason: PlanDagNonReadyReason;
  blockerIds: string[];
}

export interface PlanDagParallelismDiagnostics {
  nonTerminal: number;
  nonTerminalItemIds: string[];
  readyWidth: number;
  readyItemIds: string[];
  criticalPathDepth: number;
  criticalPathSummary: string;
  topFanInChokepointsSummary: string;
  criticalPathItemIds: string[];
  blockingEdges: PlanDagBlockingEdge[];
  nonReadyItems: PlanDagNonReadyItem[];
  fanInChokepoints: PlanDagFanInChokepoint[];
  phaseInversions: PlanDagPhaseInversion[];
  releaseGateBlocksBuild: PlanDagReleaseGateBlock[];
  /** Shared, evidence-bearing probable-mistake output consumed by lint and admission. */
  findings: DependencyPolicyFinding[];
}

function finding(
  code: string,
  detail: Omit<DependencyPolicyFinding, 'code' | 'classification' | 'confidence' | 'provenance' | 'suggestedAction'>,
): DependencyPolicyFinding {
  const policy = getDependencyPolicy(code);
  if (!policy) throw new Error(`unknown dependency policy code: ${code}`);
  return {
    code,
    classification: policy.classification,
    confidence: policy.confidence,
    provenance: [...policy.provenance],
    suggestedAction: policy.suggestedAction,
    ...detail,
  };
}

function rationaleFor(...items: Array<PlanItem | undefined>): string[] {
  return [...new Set(items.flatMap((item) => item?.decisionRefs ?? []))].sort();
}

function edgeFinding(
  code: string,
  subject: PlanItem,
  dependency: PlanItem,
  evidence: Record<string, unknown>,
): DependencyPolicyFinding {
  const refs = rationaleFor(subject, dependency);
  return finding(code, {
    nodes: [subject.id, dependency.id],
    edges: [{ subject: subject.id, dependency: dependency.id }],
    evidence,
    ...(refs.length ? { suppressedBy: { kind: 'structured-rationale', refs } } : {}),
  });
}

function summarizeCriticalPath(path: readonly string[]): string {
  if (path.length === 0) return 'depth=0: none';
  if (path.length <= CRITICAL_PATH_SUMMARY_MAX_ITEMS) {
    return `depth=${path.length}: ${path.join(' -> ')}`;
  }
  const head = path.slice(0, CRITICAL_PATH_SUMMARY_EDGE_ITEMS);
  const tail = path.slice(-CRITICAL_PATH_SUMMARY_EDGE_ITEMS);
  const omitted = path.length - head.length - tail.length;
  return `depth=${path.length}: ${head.join(' -> ')} -> … +${omitted} item(s) … -> ${tail.join(' -> ')}`;
}

function summarizeFanInChokepoints(chokepoints: readonly PlanDagFanInChokepoint[]): string {
  if (chokepoints.length === 0) return 'top=0/0: none';
  const ranked = [...chokepoints].sort(
    (a, b) => b.blockerIds.length - a.blockerIds.length || a.itemId.localeCompare(b.itemId),
  );
  const shown = ranked.slice(0, FAN_IN_SUMMARY_MAX_ITEMS);
  const entries = shown.map((entry) => {
    const blockerIds = entry.blockerIds.slice(0, FAN_IN_SUMMARY_MAX_BLOCKERS);
    const omitted = entry.blockerIds.length - blockerIds.length;
    const suffix = omitted > 0 ? `,…+${omitted}` : '';
    return `${entry.itemId}(${entry.blockerIds.length})<-[${blockerIds.join(',')}${suffix}]`;
  });
  const suffix = ranked.length > shown.length ? `; … +${ranked.length - shown.length} chokepoint(s)` : '';
  return `top=${shown.length}/${ranked.length}: ${entries.join('; ')}${suffix}`;
}

function phaseOrdinal(phase: string | null): number | null {
  if (!phase) return null;
  const match = /^Phase\s+(\d+)\b/i.exec(phase.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function itemSearchText(item: PlanItem): string {
  return `${item.phase ?? ''} ${item.text}`;
}

/**
 * Pure, snapshot-local analysis of the remaining plan DAG.
 *
 * `readyWidth` deliberately uses the same actionable definition as exact-plan
 * admission: a todo item with no unresolved blocker and no needs-human gate.
 * `criticalPathDepth` counts only non-terminal items, so completed setup does
 * not keep making a mature plan look artificially deep.
 */
export function analyzePlanDagParallelism(
  planItems: readonly PlanItem[],
  planItemIds?: readonly string[],
): PlanDagParallelismDiagnostics {
  const items = [...planItems];
  const byId = new Map(items.map((item) => [item.id, item]));
  const resolved = resolveEffectiveStatusForItems(items);
  const resolvedById = new Map(resolved.items.map((item) => [item.id, item]));
  const cycleMembers = new Set(resolved.cycleMembers);
  const danglingItems = new Set(resolved.missingRefs.map((entry) => entry.itemId));
  // Resolve against the complete DAG before narrowing the claimed lane. An
  // out-of-scope dependency still blocks its consumer until it is terminal.
  const scope = planItemIds === undefined ? null : new Set(planItemIds);
  const nonTerminalItems = resolved.items.filter((item) =>
    !TERMINAL_STATUSES.has(item.storedStatus) && (!scope || scope.has(item.id)));
  const nonTerminalIds = new Set(nonTerminalItems.map((item) => item.id));
  const readyItems = nonTerminalItems.filter(
    (item) => item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman,
  );

  const blockingEdges: PlanDagBlockingEdge[] = [];
  for (const item of nonTerminalItems) {
    for (const blockerId of item.unresolvedBlockers) {
      const blocker = byId.get(blockerId);
      blockingEdges.push({
        itemId: item.id,
        blockerId,
        itemPhase: item.phase,
        blockerPhase: blocker?.phase ?? null,
        blockerStatus: blocker?.storedStatus ?? 'missing',
      });
    }
  }

  const nonReadyItems: PlanDagNonReadyItem[] = nonTerminalItems
    .filter((item) => !readyItems.some((ready) => ready.id === item.id))
    .map((item) => {
      let reason: PlanDagNonReadyReason;
      if (cycleMembers.has(item.id)) reason = 'cycle';
      else if (danglingItems.has(item.id)) reason = 'dangling';
      else if (item.needsHuman) reason = 'needs-human';
      else if (item.staleBlockedHint) reason = 'sticky-blocked';
      else if (item.unresolvedBlockers.length > 0) reason = 'dependency';
      else if (item.effectiveStatus === 'wip') reason = 'in-progress';
      else reason = 'non-actionable-status';
      return {
        itemId: item.id,
        effectiveStatus: item.effectiveStatus,
        reason,
        blockerIds: [...item.unresolvedBlockers],
      };
    });

  const fanInChokepoints = nonTerminalItems.flatMap<PlanDagFanInChokepoint>((item) => {
    const blockerIds = item.unresolvedBlockers.filter((id) => nonTerminalIds.has(id) || !byId.has(id));
    return blockerIds.length >= 2 ? [{ itemId: item.id, blockerIds }] : [];
  });

  const phaseInversions: PlanDagPhaseInversion[] = [];
  const releaseGateBlocksBuild: PlanDagReleaseGateBlock[] = [];
  for (const item of nonTerminalItems) {
    for (const blockerId of item.blockedBy) {
      const blocker = byId.get(blockerId);
      if (!blocker || TERMINAL_STATUSES.has(blocker.storedStatus)) continue;
      const itemOrder = phaseOrdinal(item.phase);
      const blockerOrder = phaseOrdinal(blocker.phase);
      if (item.phase && blocker.phase && itemOrder != null && blockerOrder != null && blockerOrder > itemOrder) {
        phaseInversions.push({
          itemId: item.id,
          itemPhase: item.phase,
          blockerId,
          blockerPhase: blocker.phase,
        });
      }
      if (RELEASE_GATE_RE.test(itemSearchText(blocker)) && FOUNDATION_BUILD_RE.test(itemSearchText(item))) {
        releaseGateBlocksBuild.push({
          itemId: item.id,
          itemPhase: item.phase,
          blockerId,
          blockerPhase: blocker.phase,
        });
      }
    }
  }

  const depthMemo = new Map<string, { depth: number; path: string[] }>();
  const depthFor = (id: string, visiting: Set<string>): { depth: number; path: string[] } => {
    const memo = depthMemo.get(id);
    if (memo) return memo;
    if (visiting.has(id)) return { depth: 0, path: [] };
    const item = resolvedById.get(id);
    if (!item || !nonTerminalIds.has(id)) return { depth: 0, path: [] };
    const nextVisiting = new Set(visiting).add(id);
    let deepest = { depth: 0, path: [] as string[] };
    for (const blockerId of item.blockedBy) {
      if (!nonTerminalIds.has(blockerId)) continue;
      const candidate = depthFor(blockerId, nextVisiting);
      if (candidate.depth > deepest.depth) deepest = candidate;
    }
    const result = { depth: deepest.depth + 1, path: [...deepest.path, id] };
    depthMemo.set(id, result);
    return result;
  };

  let criticalPath = { depth: 0, path: [] as string[] };
  for (const item of nonTerminalItems) {
    const candidate = depthFor(item.id, new Set());
    if (candidate.depth > criticalPath.depth) criticalPath = candidate;
  }

  const findings: DependencyPolicyFinding[] = [];
  for (const item of items) {
    for (const blockerId of item.blockedBy) {
      const blocker = byId.get(blockerId);
      if (!blocker) continue;
      if (TERMINAL_STATUSES.has(blocker.storedStatus)) {
        findings.push(edgeFinding('satisfied-edge-retained', item, blocker, {
          lifecycle: { subject: item.storedStatus, dependency: blocker.storedStatus },
        }));
      }
      if (TERMINAL_STATUSES.has(item.storedStatus) && !TERMINAL_STATUSES.has(blocker.storedStatus)) {
        findings.push(edgeFinding('terminal-dependant-live-blocker', item, blocker, {
          lifecycle: { subject: item.storedStatus, dependency: blocker.storedStatus },
        }));
      }
    }
  }
  for (const inversion of phaseInversions) {
    const subject = byId.get(inversion.itemId)!;
    const dependency = byId.get(inversion.blockerId)!;
    findings.push(edgeFinding('phase-inversion', subject, dependency, {
      phases: { subject: inversion.itemPhase, dependency: inversion.blockerPhase },
    }));
  }
  for (const inversion of releaseGateBlocksBuild) {
    const subject = byId.get(inversion.itemId)!;
    const dependency = byId.get(inversion.blockerId)!;
    findings.push(edgeFinding('gate-foundation-inversion', subject, dependency, {
      phases: { subject: inversion.itemPhase, dependency: inversion.blockerPhase },
      titles: { subject: subject.text, dependency: dependency.text },
    }));
  }
  // EI-22089706217678704: a gate item carrying NO prerequisite edges at all, while foundational
  // work in the same plan is still open. The inversion check above needs an edge to inspect, so
  // this shape — the one that actually reaches the scheduler as claimable work — was invisible to
  // it. Requiring OTHER open foundation work is what keeps this off deliberately-parallel items:
  // an edgeless gate in a plan whose build work is already done is simply the next thing to do.
  for (const item of nonTerminalItems) {
    if (item.blockedBy.length > 0) continue;
    const subject = byId.get(item.id);
    if (!subject || !isGateItem(subject)) continue;
    const openFoundation = nonTerminalItems.filter(
      (candidate) =>
        candidate.id !== item.id && FOUNDATION_BUILD_RE.test(itemSearchText(byId.get(candidate.id) ?? subject)),
    );
    if (openFoundation.length === 0) continue;
    const refs = rationaleFor(subject);
    findings.push(finding('gate-without-dependency', {
      nodes: [subject.id, ...openFoundation.map((candidate) => candidate.id)],
      edges: [],
      evidence: {
        lifecycle: { subject: subject.storedStatus },
        titles: { subject: subject.text },
        ungatedBy: openFoundation.map((candidate) => candidate.id),
      },
      ...(refs.length ? { suppressedBy: { kind: 'structured-rationale', refs } } : {}),
    }));
  }
  if (nonTerminalItems.length >= 3 && readyItems.length <= 1 && criticalPath.depth >= 3) {
    const refs = rationaleFor(...criticalPath.path.map((id) => byId.get(id)));
    findings.push(finding('narrow-or-deep-topology', {
      nodes: [...criticalPath.path],
      edges: criticalPath.path.slice(1).map((id, index) => ({ subject: id, dependency: criticalPath.path[index] })),
      evidence: {
        topologyMetrics: { nonTerminal: nonTerminalItems.length, readyWidth: readyItems.length, criticalPathDepth: criticalPath.depth },
        path: [...criticalPath.path],
      },
      ...(refs.length ? { suppressedBy: { kind: 'structured-rationale', refs } } : {}),
    }));
  }
  for (const chokepoint of fanInChokepoints.filter((entry) => entry.blockerIds.length >= 4)) {
    const subject = byId.get(chokepoint.itemId)!;
    const blockers = chokepoint.blockerIds.map((id) => byId.get(id)).filter((item): item is PlanItem => Boolean(item));
    const refs = rationaleFor(subject, ...blockers);
    findings.push(finding('high-degree-node', {
      nodes: [subject.id, ...blockers.map((item) => item.id)],
      edges: blockers.map((item) => ({ subject: subject.id, dependency: item.id })),
      evidence: { topologyMetrics: { fanIn: blockers.length } },
      ...(refs.length ? { suppressedBy: { kind: 'structured-rationale', refs } } : {}),
    }));
  }

  return {
    nonTerminal: nonTerminalItems.length,
    readyWidth: readyItems.length,
    criticalPathDepth: criticalPath.depth,
    // Deliberately precede every raw array in insertion order: the generic
    // result projector is domain-neutral and walks non-identity fields in that
    // order, so these source-owned semantic answers survive when arrays cap.
    criticalPathSummary: summarizeCriticalPath(criticalPath.path),
    topFanInChokepointsSummary: summarizeFanInChokepoints(fanInChokepoints),
    nonTerminalItemIds: nonTerminalItems.map((item) => item.id),
    readyItemIds: readyItems.map((item) => item.id),
    criticalPathItemIds: criticalPath.path,
    blockingEdges,
    nonReadyItems,
    fanInChokepoints,
    phaseInversions,
    releaseGateBlocksBuild,
    findings,
  };
}
