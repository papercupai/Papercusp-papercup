/** P-012b support-to-engineering operation contract.
 *
 * This is deliberately a small, provider-neutral value layer. The operation
 * receipt still owns revision/caller identity; this contract only validates the
 * employee's selected case against the approved declaration before the app
 * submits it to blueprint:submit.
 */
export interface ApprovedSupportWorkflow {
  readonly harnessSlug: string;
  readonly operationId: string;
  readonly approvedRevision: string;
  readonly accountableOwner: string;
  readonly reviewerPrincipals: readonly string[];
  readonly allowedSources: readonly string[];
  readonly allowedActions: readonly string[];
  /** Required maximum in micro-USD; declaration alone does not enforce spend. */
  readonly maximumCostMicros: number;
}

export interface SupportCaseInput {
  readonly supportCaseId: string;
  readonly approvedRevision: string;
  readonly documentIds: readonly string[];
  readonly query: string;
  readonly requestedAction: string;
}

export interface SupportToEngineeringResult {
  readonly supportCaseId: string;
  readonly summary: string;
  readonly reproduction: readonly string[];
  readonly checklist: readonly string[];
  readonly suggestedRole: string;
  readonly citations: readonly { id: string; source: string; externalId: string | null; sourceUrl?: string }[];
}

/** Display-only link from current corpus metadata, never a provider URL invented
 * by the worker. The browser repeats this guard at its output boundary. */
export function safeSupportSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 ||
      !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return; }
}

const REVISION = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function assertApprovedSupportWorkflow(workflow: ApprovedSupportWorkflow): void {
  if (!text(workflow.harnessSlug, 120) || !text(workflow.operationId, 200) ||
      !REVISION.test(workflow.approvedRevision) || !text(workflow.accountableOwner, 200) ||
      !Number.isSafeInteger(workflow.maximumCostMicros) || workflow.maximumCostMicros <= 0) {
    throw new Error('approved support workflow declaration is malformed');
  }
  if (!workflow.reviewerPrincipals.length || new Set(workflow.reviewerPrincipals).size !== workflow.reviewerPrincipals.length ||
      workflow.reviewerPrincipals.some((id) => !text(id, 200))) {
    throw new Error('approved support workflow requires distinct reviewer principals');
  }
  if (!workflow.allowedSources.length || workflow.allowedSources.some((source) => !text(source, 120))) {
    throw new Error('approved support workflow requires allowed sources');
  }
  if (!workflow.allowedActions.length || workflow.allowedActions.some((action) => !text(action, 120))) {
    throw new Error('approved support workflow requires allowed actions');
  }
}

/** Validate a UI selection before it enters a durable operation request. */
export function assertSupportCaseInput(
  workflow: ApprovedSupportWorkflow,
  input: SupportCaseInput,
): SupportCaseInput {
  assertApprovedSupportWorkflow(workflow);
  if (!text(input.supportCaseId, 200) || !REVISION.test(input.approvedRevision) ||
      input.approvedRevision !== workflow.approvedRevision || !text(input.query, 500) ||
      !text(input.requestedAction, 120) || !workflow.allowedActions.includes(input.requestedAction)) {
    throw new Error('support case selection is outside the approved workflow');
  }
  if (!Array.isArray(input.documentIds) || input.documentIds.length < 1 || input.documentIds.length > 50 ||
      input.documentIds.some((id) => !UUID.test(id)) || new Set(input.documentIds).size !== input.documentIds.length) {
    throw new Error('support case selection requires 1..50 distinct canonical document ids');
  }
  return Object.freeze({ ...input, documentIds: Object.freeze([...input.documentIds]) });
}

/** Browser-safe display gate. This checks shape only; the canonical result
 * service separately binds the case and citations to current authorized sources. */
export function parseSupportToEngineeringResultShape(value: unknown): SupportToEngineeringResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('support result must be an object');
  const result = value as Record<string, unknown>;
  if (!text(result.supportCaseId, 200) || !text(result.summary, 20_000) ||
      !text(result.suggestedRole, 200) || !Array.isArray(result.reproduction) ||
      !Array.isArray(result.checklist) || !Array.isArray(result.citations) ||
      result.citations.length < 1 || result.citations.length > 50 ||
      result.reproduction.length + result.checklist.length < 1 ||
      result.reproduction.length > 50 || result.checklist.length > 50) {
    throw new Error('support result does not match the approved output contract');
  }
  const strings = (items: unknown[]) => items.every((item) => text(item, 2000));
  if (!strings(result.reproduction) || !strings(result.checklist) || result.citations.some((citation) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return true;
    const row = citation as Record<string, unknown>;
    return typeof row.id !== 'string' || !UUID.test(row.id) || !text(row.source, 120) ||
      (row.externalId !== null && !text(row.externalId, 500));
  })) throw new Error('support result contains malformed evidence');
  if (new Set(result.citations.map((citation) => citation.id)).size !== result.citations.length) {
    throw new Error('support result contains ambiguous evidence');
  }
  return Object.freeze({
    supportCaseId: result.supportCaseId, summary: result.summary,
    reproduction: Object.freeze([...result.reproduction] as string[]),
    checklist: Object.freeze([...result.checklist] as string[]), suggestedRole: result.suggestedRole,
    citations: Object.freeze(result.citations.map((row) => Object.freeze({
      id: row.id as string, source: row.source as string, externalId: row.externalId as string | null,
      ...(safeSupportSourceUrl(row.sourceUrl) ? { sourceUrl: safeSupportSourceUrl(row.sourceUrl) } : {}),
    }))),
  });
}

/** Semantic gate. canonicalDocuments must come from the current ACL-checked
 * case read, never from the worker's output. */
export function parseSupportToEngineeringResult(value: unknown,
  selection: Pick<SupportCaseInput, 'supportCaseId' | 'documentIds'>,
  canonicalDocuments: SupportToEngineeringResult['citations']): SupportToEngineeringResult {
  const result = parseSupportToEngineeringResultShape(value);
  if (result.supportCaseId !== selection.supportCaseId) {
    throw new Error('support result does not match the approved output contract');
  }
  const selectedIds = new Set(selection.documentIds);
  if (!selectedIds.size || selectedIds.size !== selection.documentIds.length || selectedIds.size > 50 ||
      !Array.isArray(canonicalDocuments) || canonicalDocuments.length !== selectedIds.size ||
      canonicalDocuments.some((document) => !document || !UUID.test(document.id) ||
        !selectedIds.has(document.id) || !text(document.source, 120) ||
        (document.externalId !== null && !text(document.externalId, 500)))) {
    throw new Error('support result requires complete canonical evidence for the selected case');
  }
  const documentsById = new Map(canonicalDocuments.map((document) => [document.id, document]));
  if (documentsById.size !== selectedIds.size) {
    throw new Error('support result contains ambiguous evidence');
  }
  if (result.citations.some((citation) => {
    const document = documentsById.get(citation.id);
    return !document || citation.source !== document.source || citation.externalId !== document.externalId;
  })) throw new Error('support result contains malformed evidence');
  return result;
}
