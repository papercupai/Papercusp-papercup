/** Current-principal ACL adapter for the selected support case.
 *
 * Identity comes only from the verified user principal in the transport's tool
 * context. The selected ids narrow the canonical corpus query; they never grant
 * access. documents-corpus rechecks the live organization grant, provider ACL,
 * identity mapping, revocation and disclosure ledger on every call.
 */
import type { Sql } from 'postgres';
import type { operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import {
  searchOrganizationDocuments,
  type OrganizationSearchOutcome,
} from '../data-sources/documents-corpus';
import type { PersonalToolContext } from '../personal-vault/types';
import { assertSupportCaseInput, parseSupportToEngineeringResult, safeSupportSourceUrl,
  type ApprovedSupportWorkflow, type SupportCaseInput, type SupportToEngineeringResult } from './support-workflow-contract';
import { BlueprintOperationRefusal } from './operation-refusal';
import type { AcceptedOperationPin } from './operation-admission';
import { supportWorkflowFromOperation } from './support-workflow-operation';
import { runWithWorkspace } from '../workspace-als';

export async function readSelectedSupportCase(
  sql: Sql,
  context: PersonalToolContext & { principal?: {
    kind?: string; slug?: string; workspaceId?: string; trust?: string;
  } | null },
  workflow: ApprovedSupportWorkflow,
  input: SupportCaseInput,
): Promise<OrganizationSearchOutcome> {
  const selected = assertSupportCaseInput(workflow, input);
  const principal = context.principal;
  if (principal?.kind !== 'user' || principal.trust !== 'verified' ||
      !principal.slug || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal.slug) ||
      !principal.workspaceId?.trim() || principal.workspaceId === '*' ||
      (context.workspaceId != null && context.workspaceId !== principal.workspaceId)) {
    throw new BlueprintOperationRefusal('handle_mismatch', 'support workflow requires a verified user principal in the current workspace');
  }
  const result = await searchOrganizationDocuments(sql, context, {
    workspaceId: principal.workspaceId,
    principalUserId: principal.slug,
    agentOwnerId: principal.slug,
    query: selected.query,
    sources: [...workflow.allowedSources],
    documentIds: selected.documentIds,
    limit: selected.documentIds.length,
  });
  if (result.allowed && (result.results.length !== selected.documentIds.length ||
      result.results.some((document) => !selected.documentIds.includes(document.id)))) {
    throw new BlueprintOperationRefusal('invalid_payload', 'selected support case is unavailable or its current source access was revoked');
  }
  return result;
}

/** Shape validation alone cannot bind citations to the employee's case. Both
 * completion and later result/reviewer reads use the accepted selection and a
 * fresh canonical corpus read; worker output never supplies its own evidence. */
export async function validateSupportOperationResult(sql: Sql, workspaceId: string,
  operation: ReturnType<typeof operationFromSpecification>['operation'], pin: AcceptedOperationPin, output: unknown,
  viewerPrincipalId?: string): Promise<SupportToEngineeringResult | undefined> {
  const workflow = supportWorkflowFromOperation(operation, pin.harnessSlug, pin.specificationRevision);
  if (!workflow) return;
  return runWithWorkspace(workspaceId, async () => {
    const selection = assertSupportCaseInput(workflow, pin.input as unknown as SupportCaseInput);
    const selected = await readSelectedSupportCase(sql, { workspaceId, harnessSlug: pin.harnessSlug,
      role: operation.execution?.kind === 'agent' ? operation.execution.role : undefined,
      principal: { kind: 'user', trust: 'verified', workspaceId, slug: pin.callerId?.split('/')[0] },
    }, workflow, selection);
    if (!selected.allowed) throw new BlueprintOperationRefusal('invalid_payload',
      'support result source access was revoked');
    let parsed: SupportToEngineeringResult;
    let documents = selected.results;
    try { parsed = parseSupportToEngineeringResult(output, selection, selected.results); }
    catch (error) {
      throw new BlueprintOperationRefusal('invalid_payload',
        `support result is invalid: ${error instanceof Error ? error.message : 'invalid evidence'}`);
    }
    // Business-review allowlisting grants a decision, never disclosure of source
    // content. Preserve employee revocation checks and independently authorize
    // the current viewer before returning the derived handoff to that reviewer.
    if (viewerPrincipalId && viewerPrincipalId !== pin.callerId?.split('/')[0]) {
      const visible = await readSelectedSupportCase(sql, { workspaceId, harnessSlug: pin.harnessSlug,
        role: operation.execution?.kind === 'agent' ? operation.execution.role : undefined,
        principal: { kind: 'user', trust: 'verified', workspaceId, slug: viewerPrincipalId },
      }, workflow, selection);
      if (!visible.allowed) throw new BlueprintOperationRefusal('invalid_payload', 'support reviewer source access was refused');
      try { parseSupportToEngineeringResult(output, selection, visible.results); }
      catch (error) { throw new BlueprintOperationRefusal('invalid_payload',
        `support reviewer evidence is invalid: ${error instanceof Error ? error.message : 'invalid evidence'}`); }
      documents = visible.results;
    }
    // Use the current viewer read after both authorization checks. These links
    // are presentation metadata, not part of the saved worker output/review.
    return Object.freeze({ ...parsed, citations: Object.freeze(parsed.citations.map(citation => {
      const sourceUrl = safeSupportSourceUrl(documents.find(document => document.id === citation.id)?.metadata?.permalink);
      return Object.freeze({ id: citation.id, source: citation.source, externalId: citation.externalId,
        ...(sourceUrl ? { sourceUrl } : {}) });
    })) });
  });
}
