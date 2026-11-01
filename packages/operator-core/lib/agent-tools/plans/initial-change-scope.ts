/** Initial implementation scope reuses canonical code anchors, never behavior clauses. */
import { parsePlan } from './parser';
import { resolveVerification } from '../../plan-verification-profile';
import { anchorChangeSchema, type PlanItemAnchor } from '../../plan-items/anchors';

export function initialChangeScopeProblems(input: {
  content: string; verificationProfile?: string | null; anchors: Record<string, PlanItemAnchor[]>;
}): string[] {
  const plan = parsePlan(input.content);
  const problems: string[] = [];
  for (const item of plan.items) {
    if (item.storedStatus === 'done' || item.storedStatus === 'dropped') continue;
    if (!resolveVerification({ verificationProfile: input.verificationProfile, planType: plan.frontmatter.type },
      { deliverable: item.deliverable }).codeDeliverable) continue;
    const anchors = input.anchors[item.id] ?? [];
    if (!anchors.length) { problems.push(`${item.id}: declare initial source targets or an investigation target.`); continue; }
    for (const anchor of anchors) {
      const change = anchorChangeSchema.safeParse(anchor.change);
      if (!change.success) { problems.push(`${item.id}: ${anchor.requested} needs an action, intended change and reason.`); continue; }
      if (anchor.resolution === 'unknown' && !['create', 'investigate'].includes(change.data.action) && !change.data.unknowns)
        problems.push(`${item.id}: ${anchor.requested} is unresolved; state the unknowns or mark an investigation.`);
    }
  }
  return problems;
}
