---
rel_path: "audits/managed-carry-rubric-review-2026-10-22/supported-v3-preview-d32eae0110.json"
updated_at: 1792708646401
_body: "content"
---

{
  "sourceArtifact": "artifact:papercusp:audits/managed-carry-rubric-review-2026-10-22/amendment-v3-r2-r5-r6.json",
  "sourceUpdatedAt": 1792700504190,
  "sourceRequestJSON": "{\n  \"rubricRef\": \"acceptance-managed-carry-lifecycle-enforcement-2026-09-13\",\n  \"criteria\": [\n    {\n      \"key\": \"r-1\",\n      \"title\": \"Evidence before repair\",\n      \"model\": \"Evidence before repair. Each diagnosed failure has a source-grounded causal account, a distinguishing reproduction and explicit remaining historical uncertainty.\",\n      \"bar\": \"Evidence before repair. Each diagnosed failure has a source-grounded causal account, a distinguishing reproduction and explicit remaining historical uncertainty.\",\n      \"barKey\": \"R-1\",\n      \"barHash\": \"c18635cfac331e6a2a8f92d15f83bd74adb9d433ee0e1fc7ab3161662eedb0a2\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"integration\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Read plan decision D-004 and WI-10001264 completion, resolve every cited source and test, and confirm the managed-Codex native-compaction bypass and live duplicate-host takeover are distinct causal classes with distinguishing reproductions. The exact historical launcher and signal sender must remain explicitly unresolved unless new evidence proves them.\",\n      \"driftMarkers\": \"R-1 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Read D-004 and WI-10001264 in full; inspect apps/operator/scripts/hooks/cc/precompact-managed-carry.mjs, packages/operator-core/lib/role-codex-home.ts, and apps/operator/scripts/psu-pty-host.mjs; run the managed PreCompact and duplicate-host unit/integration tests; verify each reproduction fails when its own guard is removed while the other class remains independently explained; confirm the D-004 retraction and surviving uncertainty are still present. No fixture cleanup is needed.\",\n      \"check\": {\n        \"kind\": \"requirements\"\n      }\n    },\n    {\n      \"key\": \"r-2\",\n      \"title\": \"Managed continuity enforcement\",\n      \"model\": \"Managed continuity enforcement. A managed carry request validates recipient-owned durable checkpoint and continuation authority before ending the predecessor, with an explicit pending or refusal result if prerequisites cannot be established.\",\n      \"bar\": \"Managed continuity enforcement. A managed carry request validates recipient-owned durable checkpoint and continuation authority before ending the predecessor, with an explicit pending or refusal result if prerequisites cannot be established.\",\n      \"barKey\": \"R-2\",\n      \"barHash\": \"81c6b2f13f067c3b38dce2bc20c1a3a201c4596c46bfdacff9b8d6a5ec7688ad\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"integration\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Run the exact managed PreCompact, Codex-home, request-compaction, and continuation-addressing tests. Inspect their assertions for recipient-owned checkpoint/authority validation, same-owner route preservation, queued versus refused or transport outcomes, and continue:false protection of the predecessor on every non-queued path. Also run the existing request-compaction HTTP integration suite against its isolated current-build operator and private Postgres. The real dispatcher must refuse the no-host request while preserving WARM custody and leaving no pending respawn; this is the integration boundary, while the existing unit controls retain missing-route, wrong-owner and predecessor-protection coverage.\",\n      \"driftMarkers\": \"R-2 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Run testing:run with harness:papercusp and files:[\\\"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\\\",\\\"packages/operator-core/lib/role-codex-home.test.ts\\\",\\\"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\\\",\\\"packages/operator-core/lib/agent-tools/session/request-compaction-continuation-addressing.test.ts\\\",\\\"packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts\\\"]. Resolve the returned durable recovery if the foreground budget yields. Require every requested file matched and executed. Inspect all managed hook/home/authority negative controls and the current-build HTTP integration receipt for preserved:true, noPendingRespawn:true, carry:warm and testedArgs:4 on its measured isolated operator identity. Do not count source-preflight-only cases as the HTTP behavior proof. The integration fixture owns its private operator, Postgres and cleanup.\",\n      \"check\": {\n        \"kind\": \"tests\",\n        \"files\": [\n          \"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\",\n          \"packages/operator-core/lib/role-codex-home.test.ts\",\n          \"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\",\n          \"packages/operator-core/lib/agent-tools/session/request-compaction-continuation-addressing.test.ts\",\n          \"packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts\"\n        ]\n      }\n    },\n    {\n      \"key\": \"r-3\",\n      \"title\": \"Idempotent lifecycle\",\n      \"model\": \"Idempotent lifecycle. Duplicate or superseded requests and delayed callbacks cannot repeat a settled carry or retire its live successor.\",\n      \"bar\": \"Idempotent lifecycle. Duplicate or superseded requests and delayed callbacks cannot repeat a settled carry or retire its live successor.\",\n      \"barKey\": \"R-3\",\n      \"barHash\": \"7b05efeb93291ba8d0a1ed56a0e0a17d05861484c0cdc06145446098319f7eba\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"integration\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Run the PTY-host unit, process-integration, and turn-lifecycle suites. Inspect the source admission order and generation fencing to prove a same-owner live host is refused before socket unlink or child spawn, stale or mismatched discovery records remain recoverable, and delayed terminal callbacks cannot settle a superseded generation.\",\n      \"driftMarkers\": \"R-3 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Run npm exec vitest run apps/operator/lib/psu-pty-host.test.ts apps/operator/lib/psu-pty-host.integration.test.ts apps/operator/lib/psu-pty-host-turn.integration.test.ts -- --reporter=dot. Require the real competing-host case to receive the loud owner/pid refusal before onSpawn and the original socket to return ORIGINAL-ACK afterward; also require duplicate, stale, owner-mismatch, PID-reuse, delayed, failed, and superseded controls. All spawned processes and sockets must be cleaned by the tests.\",\n      \"check\": {\n        \"kind\": \"tests\",\n        \"files\": [\n          \"apps/operator/lib/psu-pty-host.test.ts\",\n          \"apps/operator/lib/psu-pty-host.integration.test.ts\",\n          \"apps/operator/lib/psu-pty-host-turn.integration.test.ts\"\n        ]\n      }\n    },\n    {\n      \"key\": \"r-4\",\n      \"title\": \"Truthful continuation\",\n      \"model\": \"Truthful continuation. Queued, submitted and native-turn-started outcomes remain distinct while a failed or deferred operation remains actionable.\",\n      \"bar\": \"Truthful continuation. Queued, submitted and native-turn-started outcomes remain distinct while a failed or deferred operation remains actionable.\",\n      \"barKey\": \"R-4\",\n      \"barHash\": \"16e5d9d7b4e428959308af2d8b3ce3dd12c168fc27f4d8e917442546d2cb252d\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"integration\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Run the request acknowledgement, durable outcome derivation, inbox surfacing, carry-delivery guard, and native-turn integration suites. Confirm a request ACK means queued only, delivered requires persisted native user-turn proof, pending stays pending, and terminal failure or delayed non-convergence becomes a stable actionable inbox condition.\",\n      \"driftMarkers\": \"R-4 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Run npm exec vitest run packages/operator-core/lib/agent-tools/session/request-compaction.test.ts packages/operator-core/lib/carry-respawn-outcome.test.ts packages/operator-core/lib/agent-tools/coordination/tools/inbox-respawn-line.test.ts apps/operator/lib/psu-pty-host-carry-delivery-guard.integration.test.ts apps/operator/lib/psu-pty-host-turn.integration.test.ts -- --reporter=dot. Require green proof for queued acknowledgement, pending derivation, delivered first-turn persistence, dropped/retry exhaustion, and actionable inbox rendering; explicitly verify fresh child output without native user-turn persistence is not labeled delivered. Test fixtures self-clean.\",\n      \"check\": {\n        \"kind\": \"tests\",\n        \"files\": [\n          \"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\",\n          \"packages/operator-core/lib/carry-respawn-outcome.test.ts\",\n          \"packages/operator-core/lib/agent-tools/coordination/tools/inbox-respawn-line.test.ts\",\n          \"apps/operator/lib/psu-pty-host-carry-delivery-guard.integration.test.ts\",\n          \"apps/operator/lib/psu-pty-host-turn.integration.test.ts\"\n        ]\n      }\n    },\n    {\n      \"key\": \"r-5\",\n      \"title\": \"Protected boundaries\",\n      \"model\": \"Protected boundaries. Carry preserves active work, human-staged input, owner-selected route and permission boundaries while missing prerequisites leave the predecessor intact.\",\n      \"bar\": \"Protected boundaries. Carry preserves active work, human-staged input, owner-selected route and permission boundaries while missing prerequisites leave the predecessor intact.\",\n      \"barKey\": \"R-5\",\n      \"barHash\": \"c3e07dcbcdca5ec9bcf19878f5d77ffa2e658ca60143ee87ae12973778958d93\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"integration\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Run the managed PreCompact, Codex-home, request-compaction, and carry-document suites. Inspect negative controls for non-auto compaction, unmanaged homes, owner or route mismatch, active or staged input, permission refusal, and missing durable authority; none may broaden authority, switch route, consume staged input, or end the predecessor. Execute the host rearm-epoch and carry-verifier detectors as well as the turn integration suite: deferred/staged human input must prevent recycle and waiting at the successor prompt, clearing input must recycle exactly once, and human input during submit verification must abort further CR retries. The quiet-output/recovery controls must still exercise resubmission and delivery.\",\n      \"driftMarkers\": \"R-5 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Run testing:run with harness:'papercusp' and files:[\\\"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\\\",\\\"packages/operator-core/lib/role-codex-home.test.ts\\\",\\\"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\\\",\\\"packages/operator-core/lib/carry-doc.test.ts\\\",\\\"apps/operator/lib/psu-pty-host-rearm-epoch.test.ts\\\",\\\"apps/operator/lib/psu-pty-host-carry-verifier.test.ts\\\",\\\"apps/operator/lib/psu-pty-host-turn.integration.test.ts\\\"]. Resolve any returned durable recovery instead of launching a duplicate. Require every requested file matched/executed with zero omitted files before interpreting its verdict. Inspect the rearm-epoch human-input refusals and input-cleared recycle-once control, carry-verifier human-input abort/no-extra-CR and quiet-recovery controls, and the real PTY turn human-input interruption/settled-retry cases. Retain exact route/owner preservation, missing-authority, unmanaged/non-auto and permission negative controls. The managed home hook must reuse its exact signed per-session route. Fixtures self-clean.\",\n      \"check\": {\n        \"kind\": \"tests\",\n        \"files\": [\n          \"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\",\n          \"packages/operator-core/lib/role-codex-home.test.ts\",\n          \"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\",\n          \"packages/operator-core/lib/carry-doc.test.ts\",\n          \"apps/operator/lib/psu-pty-host-rearm-epoch.test.ts\",\n          \"apps/operator/lib/psu-pty-host-carry-verifier.test.ts\",\n          \"apps/operator/lib/psu-pty-host-turn.integration.test.ts\"\n        ]\n      }\n    },\n    {\n      \"key\": \"r-6\",\n      \"title\": \"Regression selection\",\n      \"model\": \"Regression selection. Behavioral regressions distinguish defect from repair and are selected by the normal promotion suite.\",\n      \"bar\": \"Regression selection. Behavioral regressions distinguish defect from repair and are selected by the normal promotion suite.\",\n      \"barKey\": \"R-6\",\n      \"barHash\": \"29e0655a0808b7c8bc696ddb4f16966e0cc1a579d0b184c226280ffa3d0eb2b7\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"tree\"\n      ],\n      \"evidencePlane\": \"tree\",\n      \"requiredTestLayers\": [\n        \"unit\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Run the affected-test changed-path provenance, declared-versus-consumed selection, and selected-files reporting tests, then invoke the real affected-test selector for the carry source paths. Require the operator-core stateful and lane-pure tasks, dependent workspaces, and repository guards to be selected with no carry test stranded outside normal promotion. The bound changed-path-provenance suite must execute its managed-carry source selection case, assert the normal apps/operator test plus both operator-core lanes and dependent/guard selection, and enumerate the real task configs with the maintained manifest reader. Its seven named managed-carry unit regressions must be present; unenumerated/overlapping/incomplete manifests fail the check. The exact unrelated docs-config path is the negative control. A formatter-only/provenance-only pass is insufficient.\",\n      \"driftMarkers\": \"R-6 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.\",\n      \"replication\": \"REPLICATION DRILL: Run testing:run with harness:'papercusp' and files:[\\\"packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts\\\",\\\"packages/operator-core/lib/__tests__/affected-tests-declared-consumed-selection.test.ts\\\",\\\"packages/operator-core/lib/__tests__/affected-tests-selected-files-line.test.ts\\\"]. Resolve the one returned recovery if the foreground budget yields. Require requested files equal matched/executed files, with no omitted request. In the changed-path-provenance suite execute the carry-specific normal-promotion manifest regression. It executes the real --print-affected selector for managed PreCompact, Codex-home, PTY-host and carry-drill inputs; requires the apps/operator normal task, operator-core pure/stateful tasks, dependents and the post-compaction guard; enumerates the real configs and requires the seven named unit regressions; rejects an incomplete manifest and proves the unrelated docs-workspace control does not select those tasks. Selector enumeration must emit no execution verdict. No additional cleanup is needed.\",\n      \"check\": {\n        \"kind\": \"tests\",\n        \"files\": [\n          \"packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts\",\n          \"packages/operator-core/lib/__tests__/affected-tests-declared-consumed-selection.test.ts\",\n          \"packages/operator-core/lib/__tests__/affected-tests-selected-files-line.test.ts\"\n        ]\n      }\n    },\n    {\n      \"key\": \"r-7\",\n      \"title\": \"Verified shipment\",\n      \"model\": \"Verified shipment. The plan reaches shipped only after code-truth audit and independent acceptance grading with exact-runtime carry-and-resume evidence and honest older-host adoption status.\",\n      \"bar\": \"Verified shipment. The plan reaches shipped only after code-truth audit and independent acceptance grading with exact-runtime carry-and-resume evidence and honest older-host adoption status.\",\n      \"barKey\": \"R-7\",\n      \"barHash\": \"bf6492bc0f63f22ec6c335f462f3909d4daaecac5d8e3d49406284b1bcd7cb82\",\n      \"role\": \"outcome\",\n      \"mandatory\": true,\n      \"requiredScope\": [\n        \"deployed\"\n      ],\n      \"evidencePlane\": \"deployed\",\n      \"requiredTestLayers\": [\n        \"e2e\"\n      ],\n      \"passRatings\": [\n        \"healthy\"\n      ],\n      \"barProvenance\": {\n        \"lifecycle\": \"pre-implementation\",\n        \"declaredAt\": \"2026-09-14T01:15:12.934Z\",\n        \"declaredBy\": \"su-6eeda0f9-9087-43b2-b27d-e3856a7cf256\"\n      },\n      \"method\": \"Manual deployed-runtime contract: resolve current normal-promotion and deploy identity with dev:pipeline_position or the release trace, prove the green main pin contains every carry source change, run session:carry-drill start, grade exactly once, verify, and report against that exact deployed operator identity, and preserve any older-host or unsupported session-class gap as residue rather than relabeling it sufficient.\",\n      \"driftMarkers\": \"R-7 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the deployed plane.\",\n      \"replication\": \"REPLICATION DRILL: After normal green promotion and deployment, record the exact main and deployed build identity; invoke session:carry-drill start from a disposable managed Codex session against that exact runtime, follow the addressed successor instruction to call grade exactly once with the injected drillId, then run verify and report. Require ledger-registered, host-respawned, terminal-outcome, owner-socket-live, and sufficient Codex-interactive evidence with zero surfacing gaps. Compare historical codex-headless and Claude-host coverage honestly; retire only explicitly proven classes. Clean up the disposable session through the supported drill lifecycle and retain the durable report id.\",\n      \"check\": {\n        \"kind\": \"instrument\",\n        \"instrumentKey\": \"none\"\n      }\n    }\n  ],\n  \"dryRun\": true,\n  \"requestReview\": {\n    \"workItemId\": \"WI-10001395\",\n    \"harness\": \"papercusp\"\n  },\n  \"reviewerModel\": {\n    \"agent\": \"codex\",\n    \"model\": \"gpt-6.1-sol\",\n    \"effort\": \"xhigh\"\n  },\n  \"expectedRubricRevision\": 3,\n  \"expectedSubjectPlanRevision\": 29,\n  \"idempotencyKey\": \"managed-carry-r2-r5-r6-detectors-20261022-v3\",\n  \"reason\": \"Resolve independent critique thread-post1196520 F1/F2: bind real R5 human-input actuator controls and the R6 carry-specific normal-promotion manifest detector. Preserve all seven outcome BARs, scopes, pass semantics and evidence planes. V2 repairs legacy requirement projection by materializing the exact prior contracts and removes the ambiguous quoted R6 case citation; R5 check strengthening intentionally receives a new server-derived BAR hash and will require proof rebind. V3 also addresses confirmed F3 in thread-post1196798: retain R2 integration requirement and bind the existing real HTTP integration/WARM custody detector. No outcome, required scope or evidence plane changes.\"\n}",
  "servingBuild": "d32eae0110",
  "receipt": {
    "rubricRef": "acceptance-managed-carry-lifecycle-enforcement-2026-09-13",
    "idempotencyKey": "preview-38bf8914-d93e-4471-acf7-80b054f07907"
  },
  "status": {
    "ok": true,
    "state": "previewed",
    "source": "receipt",
    "ageSec": 2,
    "result": {
      "ok": true,
      "dryRun": true,
      "preview": {
        "changes": [
          {
            "kinds": [
              "bar-meaning",
              "method-only"
            ],
            "barKey": "R-2",
            "fields": [
              "check",
              "method",
              "replication"
            ]
          },
          {
            "kinds": [
              "bar-meaning",
              "method-only"
            ],
            "barKey": "R-5",
            "fields": [
              "check",
              "method",
              "replication"
            ]
          },
          {
            "kinds": [
              "method-only"
            ],
            "barKey": "R-6",
            "fields": [
              "method",
              "replication"
            ]
          }
        ],
        "approval": {
          "bars": [
            {
              "barKey": "R-2",
              "nextBarHash": "4946a59606d7a8eab42f4a278d46cd94a744c3671c0ad8d37c819ffb60c505c9",
              "priorBarHash": "81c6b2f13f067c3b38dce2bc20c1a3a201c4596c46bfdacff9b8d6a5ec7688ad"
            },
            {
              "barKey": "R-5",
              "nextBarHash": "a531ad83d13903b1b9cc8d6fc654c59ae0e5437e04c4a84618c30387d569867f",
              "priorBarHash": "c3e07dcbcdca5ec9bcf19878f5d77ffa2e658ca60143ee87ae12973778958d93"
            }
          ],
          "kind": "acceptance-bar-amendment-approval",
          "rubricRef": "acceptance-managed-carry-lifecycle-enforcement-2026-09-13",
          "subjectPlan": "managed-carry-lifecycle-enforcement-2026-09-13",
          "schemaVersion": 1
        },
        "nextRepair": {
          "code": "bar_snapshot_proof_stale",
          "action": "Re-bind the 8 proof ref(s) in invalidatedProofRefs for the changed bar(s) R-2, R-5; the 7 in carriedProofRefs survive unchanged. Then refresh vetting and independent grading; historical ship verdicts remain recorded but cannot authorize this revision."
        },
        "changedBars": [
          "R-2",
          "R-5"
        ],
        "implementers": [
          "su-2a9a92e5-4d2b-491a-b56f-416d19814c8f",
          "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256",
          "su-ad0c109f-ae8b-4547-a1cf-f1079dbf0351",
          "su-c77f160e-1bd4-4436-9090-bb0360873809"
        ],
        "plannedPaths": [],
        "nextBarSetHash": "9f99606107e1ba6fd871c41a70380bb75c62325767bbb51db78e1a1943ee960f",
        "readinessDelta": {
          "bars": [
            {
              "label": "automated proof owed",
              "barKey": "R-1",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-2",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-3",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-4",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-5",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-6",
              "codesAdded": [
                "bar_snapshot_proof_inadequate",
                "bar_snapshot_proof_stale"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            },
            {
              "label": "automated proof owed",
              "barKey": "R-7",
              "codesAdded": [
                "bar_snapshot_proof_inadequate"
              ],
              "codesRemoved": [
                "bar_snapshot_clause_not_accepted"
              ],
              "contractAfter": "automated",
              "contractBefore": "automated"
            }
          ],
          "after": {
            "codes": [
              "bar_snapshot_proof_inadequate",
              "bar_snapshot_proof_stale",
              "bar_snapshot_grading_missing",
              "bar_snapshot_proof_missing",
              "bar_snapshot_evidence_plane_unmet",
              "bar_snapshot_vetting_stale",
              "bar_snapshot_author_verdict_missing"
            ],
            "barCount": 7,
            "blockingBarCount": 7
          },
          "phase": "ship",
          "before": {
            "codes": [
              "bar_snapshot_clause_not_accepted",
              "bar_snapshot_grading_missing",
              "bar_snapshot_evidence_plane_unmet",
              "bar_snapshot_proof_missing",
              "bar_snapshot_vetting_stale",
              "bar_snapshot_author_verdict_missing"
            ],
            "barCount": 7,
            "blockingBarCount": 7
          },
          "summary": "Ship readiness: 7 of 7 BAR(s) blocking before, 7 of 7 after; codes added: bar_snapshot_proof_inadequate, bar_snapshot_proof_stale; codes removed: bar_snapshot_clause_not_accepted.",
          "codesAdded": [
            "bar_snapshot_proof_inadequate",
            "bar_snapshot_proof_stale"
          ],
          "codesRemoved": [
            "bar_snapshot_clause_not_accepted"
          ],
          "flippedToManual": [],
          "flippedToAutomated": [],
          "raisesProofFloorOnly": false
        },
        "rubricRevision": 3,
        "priorBarSetHash": "516cedb0ca57935325813c04fc4154949e4cfe5b5cd42ef119e3073497ce545f",
        "projectionCount": 10,
        "approvalRequired": false,
        "carriedProofRefs": [
          "test-run:18043692:R1-P001-negative-controls",
          "test-run:18043712:R6-P005",
          "test-run:18043712:R6-P005-negative-controls",
          "test-run:18043713:R4-P004",
          "test-run:18043713:R4-P004-negative-controls",
          "test-run:18049161:R3-P003-negative-controls",
          "test-run:18049161:R4-P003-negative-controls"
        ],
        "revisionMovement": {
          "rubric": {
            "to": 4,
            "from": 3
          },
          "subject": {
            "to": 30,
            "from": 29
          }
        },
        "sourceDerivation": {
          "retired": [],
          "removedMapRows": [],
          "baselineSourceFingerprint": "ba171eae0be822df1d619ee893adbf0a635716743235bac27dc791858f24eae5",
          "proposedSourceFingerprint": "ba171eae0be822df1d619ee893adbf0a635716743235bac27dc791858f24eae5"
        },
        "cohortDisposition": {
          "action": "preserve",
          "cohort": "post-epoch",
          "adoptionEpoch": 1
        },
        "requirementsDrift": {
          "action": "The plan's ## Requirements block disagrees with the amended rubric on R-2 (method, check, replication); R-5 (method, check, replication); R-6 (method, replication). The rubric is canonical after seeding. Applying this amendment re-renders the explicit requirement block of R-2, R-5, R-6 from the amended criterion. No manual plan edit is needed.",
          "inSync": false,
          "entries": [
            {
              "kind": "text-differs",
              "barKey": "R-2",
              "fields": [
                "method",
                "check",
                "replication"
              ],
              "changedByAmendment": true
            },
            {
              "kind": "text-differs",
              "barKey": "R-5",
              "fields": [
                "method",
                "check",
                "replication"
              ],
              "changedByAmendment": true
            },
            {
              "kind": "text-differs",
              "barKey": "R-6",
              "fields": [
                "method",
                "replication"
              ],
              "changedByAmendment": true
            }
          ],
          "rerenderedOnApply": [
            "R-2",
            "R-5",
            "R-6"
          ]
        },
        "reboundWorkItemIds": [
          "WI-10001395"
        ],
        "sourceSnapshotHash": "82a18fea899da9c26d1141f27c9edd48badc7dd0b1453427fba61eff9f0962e7",
        "subjectPlanRevision": 29,
        "invalidatedProofRefs": [
          "apps/operator/lib/psu-pty-host.test.ts",
          "test-run:18043667:R5-P002",
          "test-run:18043667:R5-P002-negative-controls",
          "test-run:18043717:R5-P004",
          "test-run:18043717:R5-P004-negative-controls",
          "test-run:18043719:R2-P002",
          "test-run:18043719:R2-P002-negative-controls",
          "test-run:18049161:R5-P003-negative-controls"
        ],
        "approvalClassification": {
          "additiveBars": [
            "R-2",
            "R-5"
          ],
          "reviewedBars": []
        },
        "invalidatedScorecardIds": [],
        "authorVerdictBecomesStale": false,
        "invalidatedAdequacyCardSubjects": [
          "managed-carry-lifecycle-enforcement-2026-09-13#AUTO-BAR-R-2-P-002@5",
          "managed-carry-lifecycle-enforcement-2026-09-13#AUTO-BAR-R-5-P-002@5",
          "managed-carry-lifecycle-enforcement-2026-09-13#AUTO-BAR-R-5-P-003@5",
          "managed-carry-lifecycle-enforcement-2026-09-13#AUTO-BAR-R-5-P-004@5"
        ]
      }
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json"
    }
  }
}
