/** P-015/A-9 preparation only: synthetic inputs, never measured trial results.
 * Import this fixture from the selected workflow's real integration/operational
 * runner. Keep reviewer-only facts out of employee input and worker context.
 */
import type { SupportCaseInput } from '../support-workflow-contract';
import { supportTrialBodyHash, type SupportTrialArtifact, type SupportTrialAuthority,
  type SupportTrialInput, type SupportTrialObservation, type SupportTrialRegistration } from '../support-workflow-trial';
import type { BlueprintOperationHandle } from '../operation-service';

type Scenario = readonly [area: string, title: string, trigger: string, observation: string, expected: string];

const scenarios: readonly Scenario[] = [
  ['identity', 'Removed user keeps a browser session', 'Remove an active member from the approved directory group', 'An already open tab can still read the previous workspace', 'Existing sessions lose access within the recorded revocation deadline'],
  ['identity', 'Duplicate directory event repeats an invitation', 'Deliver the same signed provisioning event twice', 'Two invitations appear for one external identity', 'One local identity and one active invitation remain'],
  ['identity', 'Older group event restores a role', 'Apply a newer removal followed by an older membership event', 'The removed application role returns', 'The older event cannot restore revoked authority'],
  ['policy', 'Department exception survives its expiry', 'Retry an allowed action after its department exception expires', 'The action is still allowed', 'The expired exception no longer authorizes the action'],
  ['policy', 'Preview disagrees with inherited policy', 'Preview an action denied by the organization and allowed by a child', 'Preview says allow while execution says deny', 'Preview explains the same effective deny enforced at execution'],
  ['policy', 'Wildcard child widens a parent restriction', 'Save a child wildcard under a parent tool deny', 'The employee sees the denied tool as available', 'The parent restriction remains effective'],
  ['connector', 'Removed channel member sees a stored result', 'Remove the employee from an indexed synthetic Slack channel', 'The stored search result is still returned', 'Current membership controls stored and live disclosure'],
  ['connector', 'Connector repeats a rate-limited fetch', 'Return a retry-after response during a channel refresh', 'The diagnostic counter rises without a next-attempt time', 'The connector records bounded retry timing and a useful diagnostic'],
  ['connector', 'Removed app leaves a channel in the retry queue', 'Remove the synthetic app from an admitted channel', 'The same inaccessible channel is retried forever', 'The permanent denial is surfaced without an endless retry'],
  ['connector', 'Read admission permits a write', 'Request a channel update using a read-only source grant', 'The write path appears available', 'Writes require separate authorization'],
  ['citations', 'Handoff cites the wrong case', 'Open two cases with similar titles and select the first', 'The result includes a document from the second case', 'Citations stay within the selected ACL-checked case'],
  ['citations', 'Citation external identifier is rewritten', 'Return the selected document id with another thread identifier', 'The citation points to an unrelated thread', 'Citation metadata matches the canonical selected document'],
  ['citations', 'Revoked document remains in a prepared draft', 'Revoke a selected source before submitting the prepared case', 'The draft can still be submitted with the old content', 'Submission rechecks current source access'],
  ['review', 'Employee can accept their own handoff', 'Submit a handoff and invoke review as the employee', 'The result is marked accepted', 'An authorized distinct reviewer makes the business decision'],
  ['review', 'Rework is counted as an accepted outcome', 'Have the reviewer request another reproduction step', 'The outcome dashboard increments accepted work', 'Rework stays distinct from acceptance'],
  ['review', 'Review applies to an older result revision', 'Replace a draft after the reviewer opened its previous fingerprint', 'A review of the old draft accepts the replacement', 'Review binds the exact result fingerprint'],
  ['budget', 'Concurrent handoffs overrun a department limit', 'Start two cases near the remaining department allocation', 'Both reserve the full remaining allowance', 'Concurrent reservations respect the shared finite limit'],
  ['budget', 'Unknown provider bill appears as zero cost', 'Complete a case before the provider sends its final bill', 'Finance reports a zero final model cost', 'Unreconciled provider cost stays explicitly unknown'],
  ['budget', 'Cancelled case retains an unbounded reservation', 'Cancel before the provider starts processing', 'The allocation cannot be reconciled to a case receipt', 'Reservation and settlement remain attributable and bounded'],
  ['versions', 'Promotion changes an already running case', 'Promote a new approved workflow while an earlier case is running', 'The old receipt displays the new workflow revision', 'Running work stays pinned to its admitted revision'],
  ['versions', 'Rollback does not restore the approved form', 'Promote a revision with a changed input then roll back', 'The next case still uses the promoted input schema', 'New submissions use the restored approved revision'],
  ['versions', 'Stopped workflow admits another case', 'Stop the selected workflow and submit from an old browser tab', 'A new operation starts', 'The server refuses new work while stopped'],
  ['audit', 'Accepted action loses its request correlation', 'Follow an accepted handoff from operation to business review', 'The review event has no matching operation reference', 'Identity policy result and review remain correlated'],
  ['audit', 'Denied action lacks a useful reason', 'Attempt review from a foreign workspace', 'The admin diagnostic shows a generic success entry', 'The denial and its scope are recorded accurately'],
  ['audit', 'Export recovery repeats an acknowledged batch', 'Acknowledge a synthetic export batch then retry delivery', 'The acknowledgement cursor does not reflect the accepted batch', 'Recovery preserves deterministic batch identity and acknowledgement'],
  ['operations', 'Restart loses an awaiting business review', 'Restart the current-build service after preparation completes', 'The result returns without its pending review state', 'The durable operation and review state survive restart'],
  ['operations', 'Restore loses the workflow policy pin', 'Restore a labelled fixture snapshot into the isolated profile', 'The restored case uses a different policy revision', 'Restore preserves the declared identity policy and revision boundary'],
  ['operations', 'Installed command cannot read its own server', 'Run installed ptool help and an authenticated read in an isolated VM', 'The command fails resolving a development-only SDK path', 'The installed command works without a checkout dependency'],
  ['holds', 'Held case disappears during retention expiry', 'Expire synthetic case documents covered by an active legal hold', 'The handoff citation loses its retained source', 'The hold prevents destructive retention until released'],
  ['holds', 'Unauthorized reviewer exports held content', 'Request an e-discovery export as an unrelated internal principal', 'The held source is included in the response', 'Export requires the declared authorized scope'],
];

/** IDs are stable within this synthetic fixture, so imports can be idempotent. */
export function supportWorkflowTrialCases(approvedRevision: string) {
  return scenarios.map(([area, title, trigger, observation, expected], index) => {
    const number = String(index + 1).padStart(2, '0');
    const supportCaseId = `internal-support-${number}`;
    const documentId = (part: number) => `a9150000-0000-4000-8000-${String((index + 1) * 10 + part).padStart(12, '0')}`;
    const documents = [
      { id: documentId(1), source: 'slack', externalId: `SYNTHETIC:${supportCaseId}:report`,
        title: `[SYNTHETIC] ${title}`,
        snippet: `${supportCaseId}. Synthetic report. Trigger: ${trigger}. Observed: ${observation}.` },
      { id: documentId(2), source: 'slack', externalId: `SYNTHETIC:${supportCaseId}:triage`,
        title: `[SYNTHETIC] Triage for ${supportCaseId}`,
        snippet: `${supportCaseId}. Synthetic triage. Reproduce only in the isolated fixture. Verify: ${expected}. Preserve denial and recovery receipts.` },
    ];
    const input: SupportCaseInput = {
      supportCaseId, approvedRevision, documentIds: documents.map(({ id }) => id),
      query: supportCaseId, requestedAction: 'prepare-handoff',
    };
    return {
      provenance: 'synthetic' as const,
      resultLabel: 'internal-simulation' as const,
      area, title, input, documents,
      // Runner must put this in a different, denied source scope. Never send it
      // to the employee or worker; a leak is a measured stop, not an expected answer.
      deniedDocument: { id: documentId(3), source: 'slack',
        externalId: `SYNTHETIC:${supportCaseId}:restricted`,
        title: `[RESTRICTED SYNTHETIC] ${supportCaseId}`,
        snippet: `RESTRICTED_CANARY_${supportCaseId.toUpperCase().replaceAll('-', '_')}` },
      reviewerOnlyOracle: { trigger, observation, expected, suggestedRole: `${area}-engineer` },
    };
  });
}

/** Detector controls only. These fabricated immutable artifacts MUST NOT be
 * reported as a preregistered operational trial or customer evidence. */
export function supportWorkflowTrialEvidenceFixture(options: {
  workspace?: string; harness?: string; workflowRevision?: string; operationId?: string;
  submitter?: string; reviewer?: string; supportCaseId?: string; documentIds?: string[]; now?: number;
} = {}) {
  const now = options.now ?? Date.parse('2026-10-15T12:00:00Z');
  const iso = (offset: number) => new Date(now + offset).toISOString();
  const artifacts = new Map<string, SupportTrialArtifact>();
  const authority: SupportTrialAuthority = { workspace: options.workspace ?? 'trial-fixture', harness: options.harness ?? 'trial',
    subject: 'P-023@fixture', planRevision: 'fixture-plan@1', candidateSha256: 'a'.repeat(64),
    workflowRevision: options.workflowRevision ?? 'b'.repeat(64), approvers: ['fixture-approver'], now,
    resolve: async ref => artifacts.get(ref) };
  const put = (ref: string, body: unknown, approved = false, offset = -120_000) => {
    const record = { ref, hash: supportTrialBodyHash(body), workspace: authority.workspace, subject: authority.subject,
      profile: 'assumed-internal', owner: 'fixture-approver', observedAt: iso(offset), expiresAt: iso(3_600_000) };
    artifacts.set(ref, { record: structuredClone(record), body: structuredClone(body),
      ...(approved ? { approval: { principal: 'fixture-approver', at: iso(-90_000) } } : {}) });
    return record;
  };
  const source = put('fixture:cohort-source', { supportCaseId: options.supportCaseId ?? 'fixture-case', provenance: 'synthetic',
    documentIds: options.documentIds ?? ['fixture-document'] });
  const registration: SupportTrialRegistration = { trialId: 'fixture-trial', planRevision: authority.planRevision,
    candidateSha256: authority.candidateSha256, workflowRevision: authority.workflowRevision,
    operationId: options.operationId ?? 'fixture-operation', startsAt: iso(-60_000), endsAt: iso(-1),
    reviewer: options.reviewer ?? 'fixture-reviewer', implementers: ['fixture-implementer'], resultLabel: 'internal-simulation',
    cohort: [{ id: 'cohort-1', supportCaseId: options.supportCaseId ?? 'fixture-case', submitter: options.submitter ?? 'fixture-employee',
      provenance: 'synthetic', source: source.ref, sourceSha256: source.hash }],
    thresholds: { acceptedRate: { pass: 1, stop: 0.5 }, repeatUses: { pass: 2, stop: 1 },
      costMicros: { pass: 30_000, stop: 50_000 }, reviewSeconds: { pass: 60, stop: 120 },
      reworkCount: { pass: 1, stop: 2 }, supportSeconds: { pass: 60, stop: 120 }, recoverySeconds: { pass: 60, stop: 120 } } };
  const input: SupportTrialInput = { registration: put('fixture:registration', registration, true),
    prerequisites: [...Array.from({ length: 10 }, (_, i) => `A-${i + 1}`), 'P-002', 'P-003', 'R-8'].map(id => ({ id,
      record: put(`fixture:${id}`, { prerequisite: id, state: 'satisfied', planRevision: authority.planRevision,
        candidateSha256: authority.candidateSha256 }, true) })), observations: [] };
  const observe = (handle: BlueprintOperationHandle, fingerprint: string, overrides: Partial<SupportTrialObservation> = {}) => {
    const values = { costMicros: { value: 23_000 }, reviewSeconds: { value: 10 }, reworkCount: { value: 0 },
      supportSeconds: { value: 10 }, recoverySeconds: { value: 10 } };
    const body: SupportTrialObservation = { trialId: registration.trialId, cohortId: 'cohort-1', receiptId: handle.receiptId,
      candidateSha256: authority.candidateSha256, resultLabel: 'internal-simulation', resultFingerprint: fingerprint,
      observedAt: iso(-2), baseline: structuredClone(values), measured: structuredClone(values),
      administration: true, policyUnderstood: true, recovered: true, ...overrides };
    const record = put(`fixture:observation:${handle.receiptId}`, body, false, -1);
    input.observations.push({ record, handle, callerId: registration.cohort[0]!.submitter });
    return body;
  };
  return { authority, input, registration, artifacts, put, observe };
}
