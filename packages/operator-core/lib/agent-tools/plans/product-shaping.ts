import { z } from 'zod';
import { parsePlan } from './parser';
import { splitPlanSections } from './plan-sections';
import { parseBarMappings, parseRequirementBars } from '../../acceptance-bar-seed';
import { previewPlanDeclarations, renderDeclarationsWalkthrough, type DiscoveryReadiness } from './plan-declarations';

const text = z.string().trim().max(2000);
const sourceRef = z.string().trim().max(500).regex(/^session_turn:(claude|codex|omp|agent_chat):[^\s:]+:\d+$/);

/** Authoring data lives in the canonical plan body, alongside its requirements. */
export const productShapingSchema = z.object({
  audience: text,
  problem: text,
  outcome: text,
  nonGoals: z.array(text).max(20),
  sourceRefs: z.array(sourceRef).max(20),
  context: z.array(z.object({
    kind: z.enum(['owner-request', 'observed-fact', 'assumption', 'product-choice']),
    text,
    sourceRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    decisionRef: z.string().regex(/^D-\d{3,}$/).optional(),
    material: z.boolean().optional(),
    resolved: z.boolean().optional(),
    recommendation: text.optional(),
  }).strict()).max(40),
  scenarios: z.array(z.object({
    id: z.string().max(20).regex(/^SC-\d{3,}$/),
    title: text,
    kind: z.enum(['normal', 'failure', 'boundary', 'authorization', 'concurrency', 'recovery']),
    trigger: text,
    action: text,
    outcome: text,
    requirementIds: z.array(z.string().regex(/^R-\d+$/)).max(20),
  }).strict()).max(40),
  considerations: z.array(z.object({
    category: text,
    disposition: z.enum(['covered', 'not-applicable', 'open']),
    reason: text,
    scenarioIds: z.array(z.string().regex(/^SC-\d{3,}$/)).max(20),
  }).strict()).max(20),
}).strict();

export type ProductShaping = z.infer<typeof productShapingSchema>;

export const DISCOVERY_WORKFLOW_GUIDANCE =
  'Brief → scoped discovery → findings incorporated → implementation review → execution. Discovery is draft task work, not an implementation start. Save bounded questions, conclusions, existing evidence refs and target dispositions with plans:set-content; then plans:audit { slug, phase:"discovery" }. The server derives identity, freshness and readiness; do not copy facts or assert ready. Reuse current evidence for small/general plans; justify unchanged scope. Relevant changes reopen affected judgments; cosmetic/unrelated edits reuse them. Preserve in-flight work and historical terminal records.';

/** Stage guidance is derived from the measured result, never an author attestation. */
export function discoveryWorkflow(readiness: Pick<DiscoveryReadiness, 'ready' | 'evidenceRefs' | 'nextAction'>, finalized: boolean) {
  const reviewable = finalized && readiness.ready;
  return {
    stage: reviewable ? 'implementation-review' as const : 'discovery' as const,
    label: reviewable ? 'Discovery finalized; implementation review may proceed' : 'Provisional discovery brief',
    evidenceRefs: readiness.evidenceRefs,
    nextAction: reviewable
      ? 'Review the reconciled current draft against original intent and its full BARs; then activation/spec-quality and execution. Discovery does not grant implementation authority.'
      : readiness.nextAction,
  };
}

export const PRODUCT_SHAPING_GUIDANCE =
  'Shape the product before requirements/tasks: record audience, current problem, intended outcome, non-goals and original source refs. Walk concrete user scenarios including failure/recovery and boundaries; keep facts, assumptions and material product choices distinct. Ask only consequential product choices with recommendations. Map scenarios to R-N requirements and the Design BAR-to-work map. plans:audit phase:shaping returns advisory gaps, the ownerWalkthrough and a two-pass blind intent-review brief; lead the owner\'s approval ask with the ownerWalkthrough, not the requirements. ' + DISCOVERY_WORKFLOW_GUIDANCE;

const WALKTHROUGH_FIELD_MAX = 400;
const clip = (value: string) => value.length > WALKTHROUGH_FIELD_MAX ? value.slice(0, WALKTHROUGH_FIELD_MAX - 1) + '…' : value;

/**
 * Plain-language rendering of the shaping data for the owner's approval read:
 * what changes for whom, every scenario as a trigger/action/outcome line
 * (normal journeys first), the assumptions made on the owner's behalf, and the
 * consequential choices still open. Rendered from data, so it cannot drift from
 * the brief; null when there is no valid brief to render.
 */
/**
 * The owner's approval read. When the plan content is passed, the reuse and
 * libraries declarations follow the brief (R-7): every reuse entry, every new
 * surface with why nothing existing fit, and every library row with its decision.
 */
export function renderOwnerWalkthrough(brief: ProductShaping | null, planContent?: string): string | null {
  const declarations = planContent != null ? previewPlanDeclarations(planContent) : null;
  if (!brief) {
    // D-013 #5: with no Product shaping brief, a plan that carries either declaration
    // section still shows Avi its reuse and library decisions.
    const anyDeclared = declarations && (declarations.reuse.status !== 'missing' || declarations.libraries.status !== 'missing');
    return anyDeclared ? renderDeclarationsWalkthrough(declarations).join('\n').trim() || null : null;
  }
  const lines: string[] = [];
  if (brief.audience) lines.push(`**Who this is for:** ${clip(brief.audience)}`);
  if (brief.problem) lines.push(`**The problem today:** ${clip(brief.problem)}`);
  if (brief.outcome) lines.push(`**After this ships:** ${clip(brief.outcome)}`);
  if (brief.nonGoals.some(Boolean)) lines.push(`**Not included:** ${brief.nonGoals.filter(Boolean).map(clip).join('; ')}`);
  const scenarioLine = (scenario: ProductShaping['scenarios'][number]) =>
    `- ${scenario.kind === 'normal' ? '' : `[${scenario.kind}] `}**${clip(scenario.title) || scenario.id}** (${scenario.id}) — When: ${clip(scenario.trigger) || '(not stated)'}. Then: ${clip(scenario.action) || '(not stated)'}. Result: ${clip(scenario.outcome) || '(not stated)'}.`;
  const normal = brief.scenarios.filter(scenario => scenario.kind === 'normal');
  const other = brief.scenarios.filter(scenario => scenario.kind !== 'normal');
  if (normal.length) lines.push('', '**What you will be able to do:**', ...normal.map(scenarioLine));
  if (other.length) lines.push('', '**When things go wrong or reach a limit:**', ...other.map(scenarioLine));
  const assumptions = brief.context.filter(entry => entry.kind === 'assumption' && entry.text);
  if (assumptions.length) lines.push('', '**Assumptions made on your behalf (correct any that are wrong):**',
    ...assumptions.map(entry => `- ${clip(entry.text)}${entry.recommendation ? ` (proposed: ${clip(entry.recommendation)})` : ''}`));
  const choices = brief.context.filter(entry => entry.kind === 'product-choice' && entry.material && !entry.resolved && entry.text);
  if (choices.length) lines.push('', '**Choices for you:**',
    ...choices.map(entry => `- ${clip(entry.text)} — recommended: ${entry.recommendation ? clip(entry.recommendation) : '(no recommendation yet)'}`));
  if (declarations) lines.push('', ...renderDeclarationsWalkthrough(declarations));
  return lines.join('\n').trim() || null;
}

/**
 * Pass one of the original-intent review sees ONLY the owner's own turns and
 * cited evidence, never the plan's interpretation (brief text, scenarios or
 * requirements), so the reviewer's expected scenarios are not anchored by it.
 */
function intentReviewPassOne(brief: ProductShaping | null) {
  const ownerSourceRefs = [...new Set([...(brief?.sourceRefs ?? []),
    ...(brief?.context ?? []).filter(entry => entry.kind === 'owner-request').flatMap(entry => entry.sourceRefs ?? [])])];
  const observedFactRefs = [...new Set((brief?.context ?? []).filter(entry => entry.kind === 'observed-fact').flatMap(entry => entry.sourceRefs ?? []))];
  return {
    ownerSourceRefs,
    packet: {
      observedFactRefs,
      withheld: 'Brief, scenarios and requirements are withheld so they cannot anchor your reading.',
      task: 'Read each owner turn in sourceRefs (sessions:read) and the cited evidence; list the scenarios you expect as trigger, action, outcome, including failure and boundary cases, and what the owner excluded.',
      consultQuestion: ownerSourceRefs.length
        ? `Without reading the plan, read these owner turns: ${ownerSourceRefs.join(', ')}${observedFactRefs.length ? `; evidence: ${observedFactRefs.join(', ')}` : ''}. List the user scenarios (trigger, action, outcome) the owner expects, including failure and boundary cases, and anything excluded.`
        : null,
    },
  };
}

export function productShapingScaffold(): string {
  const draft: ProductShaping = {
    audience: '', problem: '', outcome: '', nonGoals: [], sourceRefs: [], context: [],
    scenarios: [{ id: 'SC-001', title: '', kind: 'normal', trigger: '', action: '', outcome: '', requirementIds: [] }],
    considerations: [],
  };
  return '## Product shaping\n\n' + PRODUCT_SHAPING_GUIDANCE +
    '\n\n```product-shaping\n' + JSON.stringify(draft, null, 2) + '\n```';
}

export interface ShapingDiagnostic { code: string; ref: string; message: string }

/** Structural advice, never a verdict that the author's interpretation is correct. */
export function previewProductShaping(planContent: string) {
  const diagnostics: ShapingDiagnostic[] = [];
  const add = (code: string, ref: string, message: string) => diagnostics.push({ code, ref, message });
  const sections = splitPlanSections(planContent).filter(section => section.heading === 'Product shaping');
  let brief: ProductShaping | null = null;
  let status: 'missing' | 'invalid' | 'incomplete' | 'ready-for-review' = 'missing';
  if (sections.length === 0) {
    add('shaping_missing', 'section:Product shaping', 'Develop the product brief and user scenarios before formal requirements.');
  } else if (sections.length !== 1) {
    status = 'invalid';
    add('shaping_ambiguous', 'section:Product shaping', 'Keep one canonical Product shaping section.');
  } else {
    const blocks = [...sections[0]!.body.matchAll(/^```product-shaping\s*\n([\s\S]*?)\n```\s*$/gm)];
    status = 'invalid';
    if (blocks.length !== 1) {
      add('shaping_block_missing_or_ambiguous', 'section:Product shaping', 'Author exactly one product-shaping JSON fence using the scaffold.');
    } else {
      try {
        const parsed = productShapingSchema.safeParse(JSON.parse(blocks[0]![1]!));
        if (parsed.success) { brief = parsed.data; status = 'ready-for-review'; }
        else for (const issue of parsed.error.issues.slice(0, 20)) add('shaping_invalid', issue.path.join('.'), issue.message);
      } catch {
        add('shaping_invalid_json', 'section:Product shaping', 'Repair malformed product-shaping JSON; partial data is not a complete brief.');
      }
    }
  }

  const requirements = parseRequirementBars(planContent);
  const requirementIds = requirements.ok ? new Set(requirements.bars.map(bar => bar.barKey)) : new Set<string>();
  const parsedItems = parsePlan(planContent).items.filter(item => item.storedStatus !== 'dropped');
  const itemIds = new Set(parsedItems.map(item => item.id));
  const map = requirements.ok ? parseBarMappings(planContent, requirementIds) : null;
  const mappings = map?.ok ? map.mappings : [];
  const trace: Array<{ scenarioId: string; requirementIds: string[]; planItemIds: string[] }> = [];
  if (brief) {
    if (!requirements.ok) for (const problem of requirements.problems) add(problem.code, problem.barKey ?? 'Requirements', problem.detail);
    if (map && !map.ok) for (const problem of map.problems) add(problem.code, problem.barKey ?? 'Design', problem.detail);
    for (const key of ['audience', 'problem', 'outcome'] as const) if (!brief[key]) add('brief_field_missing', key, `Describe ${key} in product terms.`);
    if (!brief.sourceRefs.length) add('original_sources_missing', 'sourceRefs', 'Cite the original request; generated specs alone cannot establish intent.');
    if (!brief.nonGoals.length || brief.nonGoals.some(value => !value)) add('non_goals_missing', 'nonGoals', 'State explicit scope boundaries.');
    if (!brief.scenarios.some(scenario => scenario.kind === 'normal')) add('normal_journey_missing', 'scenarios', 'Walk through the normal user journey from trigger to outcome.');
    const scenarioIds = new Set<string>();
    const decisions = new Set(parsePlan(planContent).decisions.map(decision => decision.id));
    for (const scenario of brief.scenarios) {
      if (scenarioIds.has(scenario.id)) add('scenario_duplicate', scenario.id, 'Use unique scenario identities.');
      scenarioIds.add(scenario.id);
      for (const key of ['title', 'trigger', 'action', 'outcome'] as const) if (!scenario[key]) add('scenario_field_missing', scenario.id, `Describe the scenario ${key}.`);
      if (!scenario.requirementIds.length) add('scenario_unmapped', scenario.id, 'Derive observable requirements from this scenario before tasks.');
      for (const id of scenario.requirementIds) if (!requirementIds.has(id)) add('scenario_requirement_missing', scenario.id, `${id} is not a canonical requirement in this plan.`);
      const linkedItems = [...new Set(mappings.filter(mapping => scenario.requirementIds.includes(mapping.barKey)).flatMap(mapping => mapping.planItemIds))];
      trace.push({ scenarioId: scenario.id, requirementIds: scenario.requirementIds, planItemIds: linkedItems });
      for (const id of linkedItems) if (!itemIds.has(id)) add('scenario_item_missing', scenario.id, `${id} is absent or dropped.`);
      if (scenario.requirementIds.length && !linkedItems.length) add('scenario_work_unmapped', scenario.id, 'Map scenario requirements through the existing Design BAR-to-work map.');
    }
    for (const id of requirementIds) if (!brief.scenarios.some(scenario => scenario.requirementIds.includes(id))) add('requirement_untraced', id, 'Explain which user scenario motivates this requirement; check for unsupported scope.');
    for (const [index, entry] of brief.context.entries()) {
      const ref = `context.${index}`;
      if (!entry.text) add('context_empty', ref, 'State the fact, assumption or choice explicitly.');
      if ((entry.kind === 'owner-request' || entry.kind === 'observed-fact') && !entry.sourceRefs?.length) add('context_source_missing', ref, 'Cite evidence; do not present an assumption as an owner request or observed fact.');
      if (entry.kind === 'owner-request' && entry.sourceRefs?.some(value => !sourceRef.safeParse(value).success)) add('owner_source_invalid', ref, 'An owner request must cite an original session_turn reference, not an agent-authored artifact.');
      if (entry.kind === 'product-choice' && entry.material && !entry.resolved) add('material_choice_open', ref, `Resolve this consequential product choice with a recommendation: ${entry.recommendation || 'recommendation missing'}`);
      if (entry.decisionRef && !decisions.has(entry.decisionRef)) add('context_decision_missing', ref, `${entry.decisionRef} is absent from Decisions.`);
    }
    for (const consideration of brief.considerations) {
      if (!consideration.category || !consideration.reason) add('consideration_reason_missing', consideration.category, 'Explain applicability instead of mechanically requiring every category.');
      if (consideration.disposition === 'open') add('consideration_open', consideration.category, consideration.reason);
      if (consideration.disposition === 'covered' && !consideration.scenarioIds.length) add('consideration_unmapped', consideration.category, 'Link the scenarios that cover this concern.');
      for (const id of consideration.scenarioIds) if (!scenarioIds.has(id)) add('consideration_scenario_missing', consideration.category, `${id} is absent from scenarios.`);
    }
    if (diagnostics.length) status = 'incomplete';
  }
  const { ownerSourceRefs, packet: passOne } = intentReviewPassOne(brief);
  // sourceRefs are the pass-one owner turns (brief refs plus owner-request
  // refs); passOne adds only evidence refs and the task, never plan text.
  const reviewerBrief = {
    scope: 'provisional-discovery-brief' as const,
    sourceRefs: ownerSourceRefs,
    planSection: 'Product shaping',
    readFullContext: 'Pass one: sessions:read each sourceRefs turn only. Pass two: plans:get { slug, heading:"Product shaping" } and { heading:"Requirements" }.',
    protocol: 'two-pass-blind' as const,
    passOne,
    passTwo: {
      task: 'Then read the plan and report omissions (owner expects, plan lacks), unsupported additions (in the plan, no owner turn supports) and contradictions, each with its owner turn ref.',
      reportShape: '{ omissions, unsupportedAdditions, contradictions }, each entry with ownerRef',
    },
    instructions: [
      'Pass one is blind: BEFORE reading the plan\'s brief, scenarios or requirements, read sourceRefs and passOne.observedFactRefs and write your expected scenarios. Source syntax is checked; source content and authorship are not.',
      'Pass two: compare your list with the plan. Keep assumptions distinct from owner requests; ask only material product questions, with a recommended answer.',
      'Use the existing independent review route (passOne.consultQuestion suits consult:get_feedback). These diagnostics do not prove semantic completeness or owner approval.',
      'This is intent/discovery feedback, not formal implementation approval. Formal review reads finalized Discovery findings, their evidence and target dispositions in the reconciled current draft; preserve full BAR re-review without a round cap.',
    ],
  };
  const ownerWalkthrough = renderOwnerWalkthrough(brief, planContent);
  const preview = {
    status, advisory: true as const, semanticCompleteness: 'not-measured' as const,
    sourceContentVerified: false as const, brief, trace, diagnostics: diagnostics.slice(0, 20),
    diagnosticsOmitted: Math.max(0, diagnostics.length - 20),
    overflowRead: diagnostics.length > 20 ? 'Read the canonical Product shaping section and repair these diagnostics first, then repeat the shaping preview.' : null,
    ownerWalkthrough, ownerWalkthroughIsExcerpt: false,
    reviewerBrief, scaffold: status === 'missing' || status === 'invalid' ? productShapingScaffold() : null,
    next: PRODUCT_SHAPING_GUIDANCE,
  };
  // A large brief remains in the canonical plan; never duplicate it into a
  // tool-result spill that conceals the diagnostic or review instructions.
  if (JSON.stringify(preview).length > PREVIEW_BUDGET) {
    const refs = (values: string[]) => values.slice(0, 3);
    // Preserve distinct repair categories before spending the excerpt on repeats
    // from several scenarios. A material choice must remain visible too.
    const diagnosticCodes = new Set<string>();
    const distinctDiagnostics = diagnostics.filter(row => {
      if (diagnosticCodes.has(row.code)) return false;
      diagnosticCodes.add(row.code);
      return true;
    });
    const excerptDiagnostics = [...distinctDiagnostics,
      ...diagnostics.filter(row => !distinctDiagnostics.includes(row))].slice(0, 5);
    const bounded = { ...preview, brief: brief ? { audience: brief.audience.slice(0, 240),
      problem: brief.problem.slice(0, 240), outcome: brief.outcome.slice(0, 240) } : null,
      reviewerBrief: { ...reviewerBrief, sourceRefs: refs(reviewerBrief.sourceRefs),
        sourceRefsOmitted: Math.max(0, reviewerBrief.sourceRefs.length - 3),
        passOne: { ...passOne, observedFactRefs: refs(passOne.observedFactRefs),
          observedFactRefsOmitted: Math.max(0, passOne.observedFactRefs.length - 3),
          consultQuestion: passOne.consultQuestion && passOne.consultQuestion.length > 600 ? null : passOne.consultQuestion } },
      briefIsExcerpt: true, trace: trace.slice(0, 3).map(row => ({ ...row,
        requirementIds: row.requirementIds.slice(0, 5), planItemIds: row.planItemIds.slice(0, 5),
        linksAreExcerpt: row.requirementIds.length > 5 || row.planItemIds.length > 5 })),
      traceOmitted: Math.max(0, trace.length - 3),
      diagnostics: excerptDiagnostics.map(row => ({ ...row, message: row.message.slice(0, 160) })),
      diagnosticsOmitted: Math.max(0, diagnostics.length - 5),
      ownerWalkthrough: null as string | null,
      overflowRead: 'Read the full canonical Product shaping section with plans:get; the brief, trace, diagnostics and walkthrough here are excerpts. renderOwnerWalkthrough over the full brief yields the complete walkthrough.' };
    // The walkthrough gets whatever budget the rest leaves, cut at a line so no
    // scenario is shown half-rendered; the excerpt flag says lines were dropped.
    if (ownerWalkthrough) {
      const room = Math.max(600, PREVIEW_BUDGET - JSON.stringify(bounded).length - 200);
      if (ownerWalkthrough.length <= room) bounded.ownerWalkthrough = ownerWalkthrough;
      else {
        const cut = ownerWalkthrough.slice(0, room);
        bounded.ownerWalkthrough = cut.slice(0, Math.max(0, cut.lastIndexOf('\n'))) + '\n…';
        bounded.ownerWalkthroughIsExcerpt = true;
      }
    }
    return bounded;
  }
  return { ...preview, briefIsExcerpt: false, traceOmitted: 0 };
}

const PREVIEW_BUDGET = 6000;

/**
 * Compact advisory for a plan CONTENT WRITE (plans:new with a body,
 * plans:set-content): when the body has no usable Product shaping section the
 * write still succeeds, and its response carries this preview with the scaffold
 * so a hand-written plan meets shaping at the moment it is authored. Returns
 * null once a section parses (gaps in it are plans:audit phase:shaping's job,
 * not noise on every edit).
 */
export function productShapingWriteAdvisory(content: string) {
  const preview = previewProductShaping(content);
  if (preview.status !== 'missing' && preview.status !== 'invalid') return null;
  return {
    advisory: true as const,
    status: preview.status,
    diagnostics: preview.diagnostics.slice(0, 3),
    scaffold: preview.scaffold,
    next: 'Write accepted. Shape before requirements: add the scaffold section, then plans:audit { slug, phase:"shaping" } for gaps and the ownerWalkthrough that leads the owner\'s approval ask.',
  };
}
