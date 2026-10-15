# Cloud E2E campaign acceptance runbook
URL: /internal/docs/agent-insights/cloud-e2e-campaign-acceptance-runbook

Runbook for source-backed cloud census and canonical detector, defect, runtime and exact shipment evidence joins.

## Purpose and prerequisites

Use this runbook for the existing cloud-cross-feature-e2e-shipment-2026-10-08 acceptance rubric. Reuse the campaign manifest, maintained evaluator, test ledger, provider executors and release journals. The existing Cloud first-agent lesson and isolated-stack guides cover individual journeys; this page adds the cross-feature evidence joins they do not define. It adds no parallel tool, service, table or scheduler.

Work in canonical staging. Read the current subject plan, decisions and rubric before collecting evidence; pin the exact revisions and hashes. Use only campaign-created disposable identities and resources. Respect existing controller, provider publication and live release-gate ownership.

The maintained checker is packages/operator-core/lib/workspace-host/cloud-e2e-campaign-evidence.ts, exported function evaluateCloudCampaignEvidence. Its unit suite validates contradictions; a passing unit suite does not establish actual cloud acceptance.

## Ordered procedure

1. Read docs/reports/cloud-cross-feature-e2e-2026-10-08.md, Acceptance population, and docs/evidence/cloud-e2e-campaign-2026-10-08.json. Derive the denominator from the source-backed population rather than successful receipts. Preserve every unsupported, unavailable and untested entry, and the explicit checked/notChecked/notApplicable partition with separately owned residue. Inspect the listed route/UI writers when their supported scope changes.
2. Read the manifest detectorMatrix and requiredFailurePaths. For every required happy and adversarial scenario, read the full exact test-run row from testing:runs and its unmodified executionDetails. Bind id, filePath, commitSha, finishedAt, passedCaseTitles, failures and collection status. Hash the actual tested file and obtain measured affected-suite selection. Run the maintained detector and its negative control. Unverified lookup targets, missing long-running cancellation, absent source/selection/control binding and skipped cases remain nonpass.
3. Read every canonical defectPopulationRecords and outOfScopeResidue id through work\_items:get with complete completion evidence. Verify committed originating fix bytes, distinct predicted observations, distinguishing measurement, registered recurrence guard and passing triggering-journey receipt. A proposed close or an open repair is incomplete. Every deferred defect needs its actual assignee; owning it does not prove the runtime or shipment bar.
4. Select the maintained current-build route using dev:pipeline\_position with the exact changed path and testClass. Exercise operator-api, hosted, desktop-native, GCP and AWS obligations on their actual runtime. Retain authenticated source/artifact, tenant/workspace/account/run/unique label identities and action assertions. Provider journeys require create, readiness, task completion, stop/start, reconnect, snapshot/restore, destroy, controller-independent full-kind census and separately timed billing closure. Fixture HTTP responses remain fixture evidence.
5. For final shipment read the authoritative green promotion, deployment and authenticated serving receipts. Repeat the same required journeys on that exact artifact after deployment. Retain the current completion audit, independent plan grade and complete owner report publication/readback. Staging and candidate receipts do not establish deployment.
6. Independently assemble a JSON context conforming to CloudCampaignEvidenceContext from the source-derived denominator and canonical records. It contains population, detectorObligations, discoveredDefectIds, testRuns, runtimeObligations, notBefore, now and the independently collected shipment context described below. Use the actual pinned identities and evidence window; do not infer these obligations from submitted receipts. Save the context alongside its extraction evidence outside the source tree and pass its exact path as CLOUD\_CAMPAIGN\_CONTEXT. Preserve the unmodified records and their hashes. Never copy completeFixture() or other synthetic test inputs into acceptanceEvidence.

## Canonical shipment context

The existing evaluator accepts a read-only projection of existing writers in context.shipment. This adds no persistence surface. Keep the full raw canonical records alongside the projection; hash those exact bytes for evidenceSha256. The projection is not proof of its own authenticity.

* subject pins the current planSlug, planRevision, planContentHash, rubricRef, rubricRevision, criteriaHash, authorId and exact audited workItemIds. Read these identities from plans:get, rubrics:get and the canonical claimed/completed work items.
* obligations pins each of operator-api, hosted, desktop-native, gcp and aws independently: evidenceRef/evidenceSha256 plus promotionRef, deploymentRef, servingRef, auditRef, gradingRef and reportReadbackRef. These are expected canonical identities, never copied from submitted shipmentReceipts.
* promotions and deployments come from the maintained release journals/artifact receipts. Retain record ref/hash/time, runtime, sourceSha, artifactSha256, green verdict or successful deployed status, and deployment.promotionRef. A red/refused/unknown record remains nonpass.
* serving comes from an authenticated measurement of the exact loaded runtime. Retain record ref/hash/time, deploymentRef, identity, runtime, source/artifact, tenant/workspace/account/run/resource label. The final realRuntimeReceipt must carry the same deploymentRef and servingIdentity. Candidate identity alone is not serving identity.
* completionAudits comes from the canonical completion audit results. Retain record ref/hash/time, exact plan identity and source, passed verdict, committed completion authority and complete audited workItemIds. A proposed or partial audit fails.
* planGrades comes from the exact plan scorecard and its canonical gradingAudit/independence evidence, read through scorecards:get. Retain record ref/hash/time, exact plan/source and rubric revision/criteriaHash, passed verdict, createdBy, independenceVerified and gradingAuditState. Never derive independence from prose; require the canonical independently admitted/audited result and a different author.
* reportReadbacks comes from successful reports:publish followed by reports:get. Retain record ref/hash/time, exact plan/source, reportId/path/publicationRef, publishedAt, owner visibility, full publishedMarkdownSha256 and readbackMarkdownSha256, and complete=true only after complete Markdown readback. Both digests must match; a returned path without readback does not establish delivery.

Every submitted shipment reference and evidence digest joins an exact expected obligation and unique canonical record. Promotion precedes successful deployment, serving is measured after deployment, and final execution is strictly later than deployment and no earlier than serving. Completion audit, grade and report readback follow the final journey; publication is not earlier than final execution. All records must lie inside the explicit campaign window. Wrong nonempty refs, unknown/missing/duplicate records, source/artifact/tenant drift, self or stale grades, partial audits, report digest mismatch and unresolved prior bars remain nonpass.

The maintained regression tests include wrong-but-nonempty promotionRef, deploymentRef, servingRef/identity, auditRef, gradingRef, reportReadbackRef and evidenceRef controls. Use testing:run with the canonical test file and harness papercusp for ledger-backed checker evidence. The CLI test:file collection stall is separately owned by WI-10007991; an alternate-runner pass does not fix that incident. Preserve an actual missing-record context as nonpass; never import synthetic completeFixture records into this context.

## Executable checks

From the repository root, the checker regression command is:

```bash
npm run test:file -- packages/operator-core/lib/workspace-host/cloud-e2e-campaign-evidence.test.ts
```

This command tests the checker, inventory and explicit boundary disclosures only.

After independent record collection, select one actual bar with this command. Set CLOUD\_CAMPAIGN\_CONTEXT to the retained, independently collected context JSON path. Replace R-1 with R-2 through R-6 for the other criteria. Missing context, missing receipts or failed joins must fail; do not manufacture a context to make the command pass.

```bash
node --import tsx --input-type=module - "$CLOUD_CAMPAIGN_CONTEXT" R-1 <<'JS'
import { readFileSync } from 'node:fs';
import { evaluateCloudCampaignEvidence } from './packages/operator-core/lib/workspace-host/cloud-e2e-campaign-evidence.ts';
const contextPath = process.argv[2];
const bar = process.argv[3];
if (!contextPath || !/^R-[1-6]$/.test(bar)) throw new Error('actual context path and bar are required');
const manifest = JSON.parse(readFileSync('docs/evidence/cloud-e2e-campaign-2026-10-08.json', 'utf8'));
const context = JSON.parse(readFileSync(contextPath, 'utf8'));
const result = evaluateCloudCampaignEvidence(manifest, context);
console.log(JSON.stringify({ bar, problems: result.problems[bar], allBarsPassed: result.passed }, null, 2));
process.exitCode = result.problems[bar].length === 0 ? 0 : 1;
JS
```

Read the full result and independently inspect the cited underlying records. The evaluator checks record joins and contradictions; text references and context supplied by a caller are not self-authenticating. Execute all six criteria independently. Do not infer R5 from R2/R3 detector success, R4 from bookkeeping, or R6 from a candidate run.

## Verification and failure handling

Record the exact command, source/test/data/context hashes, canonical row ids, underlying receipt locations, evidence window and per-bar result. A wrong source/artifact, stale record, synthetic runtime, incomplete resource census, missing billing receipt or pre-deploy final execution remains nonpass. Unit results establish no live/deployed property.

If a check fails, retain its original evidence, register/own the originating repair and use the maintained regression plus triggering journey to verify it. Do not weaken a bar, delete an unavailable population member, silently quarantine a failure or overwrite failed build identities. Provider cleanup is limited to campaign-created resources. This read-only evidence evaluation needs no rollback; amendments go through rubrics:amend and its exact independent approval contract when required.
