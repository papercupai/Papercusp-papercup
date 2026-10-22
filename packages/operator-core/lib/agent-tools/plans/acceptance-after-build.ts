/** Shared ordering policy for grading recruitment and plan-item promotion. */
import { unfinishedItemsAreAuditedNonCode, type VerificationPlanInput } from '../../plan-verification-profile';

export interface AcceptanceOrderingItem {
  id: string;
  text: string;
  phase?: string | null;
  status?: string | null;
  storedStatus?: string | null;
  deliverable?: string | null;
}

/** Use the existing phase and item text; no parallel item-kind registry. */
export function isAcceptanceWork(item: AcceptanceOrderingItem): boolean {
  return /\b(?:acceptance|grading|proof)\b/i.test(item.phase ?? '') ||
    /^(?:independent\s+)?(?:acceptance\s+(?:grad(?:e|ing)|proof|audit|verification)|(?:grade|audit|verify|prove|record)\s+(?:the\s+)?(?:independent\s+)?acceptance)\b/i.test(item.text.trim());
}

export function openBuildItems(items: readonly AcceptanceOrderingItem[], verification: VerificationPlanInput & {
  effectiveAudits?: readonly { entry: { itemId: string; verdict: string } }[];
} = {}): AcceptanceOrderingItem[] {
  return items.filter(item => !['done', 'dropped'].includes(item.status ?? item.storedStatus ?? 'todo') &&
    !isAcceptanceWork(item) && !unfinishedItemsAreAuditedNonCode(
      [{ itemId: item.id, deliverable: item.deliverable }], verification.effectiveAudits ?? [], verification,
    ));
}

export function buildOrderingItems(plan: {
  row: { items: readonly AcceptanceOrderingItem[] };
  parsed?: { items: readonly AcceptanceOrderingItem[] };
}): readonly AcceptanceOrderingItem[] {
  return plan.row.items.length > 0 ? plan.row.items : plan.parsed?.items ?? [];
}
