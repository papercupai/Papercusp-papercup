import { readEngineeringEvidence, type EngineeringEvidence, type EngineeringQuery, type EngineeringRef,
  type EngineeringScope, type EngineeringState } from './engineering-evidence';

type EvidenceRef = { state: EngineeringState; ref: EngineeringRef };
export interface TaskEngineeringEvidence {
  intent: EvidenceRef[];
  rationale: EvidenceRef[];
  validation: EvidenceRef[];
  execution: EvidenceRef[];
  gaps: string[];
  recover: EngineeringRef;
}

/** A view over canonical records, never a second index or an execution assertion. */
export function summarizeTaskEngineeringEvidence(graph: EngineeringEvidence, recover: EngineeringRef): TaskEngineeringEvidence {
  const refs = (kinds: string[], directDecision = false): EvidenceRef[] => graph.nodes.filter(node => kinds.includes(node.kind)
    && (!directDecision || graph.edges.some(edge => edge.from === node.id && edge.basis === 'decision-item-ref'))).slice(0, 2)
    .map(node => ({ state: node.state, ref: node.ref }));
  const intent = refs(['spec']), rationale = refs(['decision'], true);
  const validation = refs(['proof', 'test-run', 'test-case']), execution = refs(['execution']);
  return { intent, rationale, validation, execution,
    gaps: [...new Set([...graph.gaps.map(gap => gap.code),
      ...(!intent.length ? ['intent-not-linked'] : []), ...(!rationale.length ? ['rationale-not-linked'] : []),
      ...(!validation.length ? ['validation-not-linked'] : []), ...(!execution.length ? [graph.execution.reason] : []),
      ...(graph.edges.some(edge => edge.basis === 'plan-affects') ? ['broader-plan-context-available'] : []),
      ...(graph.truncated ? ['additional-evidence-omitted'] : [])])].slice(0, 6), recover };
}

/** Optional evidence has its own deadline; an absent trace never blocks task work. */
export async function readTaskEngineeringEvidence(query: EngineeringQuery, scope: EngineeringScope,
  reader: typeof readEngineeringEvidence = readEngineeringEvidence, budgetMs = 1_000): Promise<TaskEngineeringEvidence> {
  const recover: EngineeringRef = { tool: 'graph:query', args: { op: 'evidence', harnesses: [scope.harness],
    ...(query.item ? { plan: query.item.plan, item: query.item.id }
      : { file_path: query.symbol?.path, ...(query.symbol?.name ? { name: query.symbol.name } : { line1: query.symbol?.line1 }) }) } };
  const unavailable = (): TaskEngineeringEvidence => ({ intent: [], rationale: [], validation: [], execution: [],
    gaps: ['engineering-evidence-unavailable'], recover });
  if (budgetMs <= 0) return unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader(query, scope).then(graph => summarizeTaskEngineeringEvidence(graph, recover)).catch(unavailable),
      new Promise<TaskEngineeringEvidence>(resolve => { timer = setTimeout(() => resolve(unavailable()), budgetMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
