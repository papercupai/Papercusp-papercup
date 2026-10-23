---
rel_path: "audits/managed-carry-rubric-review-2026-10-22/r7-native-shipment-v3-plan31.json"
updated_at: 1792714081735
_body: "content"
---

{
  "status": "draft-not-applied-cas-refreshed",
  "reviewRef": "thread-post:1197459",
  "validation": {
    "tests": "95 focused passes; latest local dirty ledger21793347/21793371/21793348/21793625",
    "types": "Six-file detector and final three-file SQL/integration scoped checks exit0",
    "provenance": "Local current tree only, no deployed/e2e acceptance"
  },
  "args": {
    "rubricRef": "acceptance-managed-carry-lifecycle-enforcement-2026-09-13",
    "criteria": [
      {
        "key": "r-1",
        "title": "Evidence before repair",
        "model": "Evidence before repair. Each diagnosed failure has a source-grounded causal account, a distinguishing reproduction and explicit remaining historical uncertainty.",
        "bar": "Evidence before repair. Each diagnosed failure has a source-grounded causal account, a distinguishing reproduction and explicit remaining historical uncertainty.",
        "barKey": "R-1",
        "barHash": "c18635cfac331e6a2a8f92d15f83bd74adb9d433ee0e1fc7ab3161662eedb0a2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Read plan decision D-004 and WI-10001264 completion, resolve every cited source and test, and confirm the managed-Codex native-compaction bypass and live duplicate-host takeover are distinct causal classes with distinguishing reproductions. The exact historical launcher and signal sender must remain explicitly unresolved unless new evidence proves them.",
        "driftMarkers": "R-1 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Read D-004 and WI-10001264 in full; inspect apps/operator/scripts/hooks/cc/precompact-managed-carry.mjs, packages/operator-core/lib/role-codex-home.ts, and apps/operator/scripts/psu-pty-host.mjs; run the managed PreCompact and duplicate-host unit/integration tests; verify each reproduction fails when its own guard is removed while the other class remains independently explained; confirm the D-004 retraction and surviving uncertainty are still present. No fixture cleanup is needed.",
        "check": {
          "kind": "requirements"
        }
      },
      {
        "key": "r-2",
        "title": "Managed continuity enforcement",
        "model": "Managed continuity enforcement. A managed carry request validates recipient-owned durable checkpoint and continuation authority before ending the predecessor, with an explicit pending or refusal result if prerequisites cannot be established.",
        "bar": "Managed continuity enforcement. A managed carry request validates recipient-owned durable checkpoint and continuation authority before ending the predecessor, with an explicit pending or refusal result if prerequisites cannot be established.",
        "barKey": "R-2",
        "barHash": "4946a59606d7a8eab42f4a278d46cd94a744c3671c0ad8d37c819ffb60c505c9",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Run the exact managed PreCompact, Codex-home, request-compaction, and continuation-addressing tests. Inspect their assertions for recipient-owned checkpoint/authority validation, same-owner route preservation, queued versus refused or transport outcomes, and continue:false protection of the predecessor on every non-queued path. Also run the existing request-compaction HTTP integration suite against its isolated current-build operator and private Postgres. The real dispatcher must refuse the no-host request while preserving WARM custody and leaving no pending respawn; this is the integration boundary, while the existing unit controls retain missing-route, wrong-owner and predecessor-protection coverage.",
        "driftMarkers": "R-2 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Run testing:run with harness:papercusp and files:[\"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\",\"packages/operator-core/lib/role-codex-home.test.ts\",\"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\",\"packages/operator-core/lib/agent-tools/session/request-compaction-continuation-addressing.test.ts\",\"packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts\"]. Resolve the returned durable recovery if the foreground budget yields. Require every requested file matched and executed. Inspect all managed hook/home/authority negative controls and the current-build HTTP integration receipt for preserved:true, noPendingRespawn:true, carry:warm and testedArgs:4 on its measured isolated operator identity. Do not count source-preflight-only cases as the HTTP behavior proof. The integration fixture owns its private operator, Postgres and cleanup.",
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts",
            "packages/operator-core/lib/role-codex-home.test.ts",
            "packages/operator-core/lib/agent-tools/session/request-compaction.test.ts",
            "packages/operator-core/lib/agent-tools/session/request-compaction-continuation-addressing.test.ts",
            "packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-3",
        "title": "Idempotent lifecycle",
        "model": "Idempotent lifecycle. Duplicate or superseded requests and delayed callbacks cannot repeat a settled carry or retire its live successor.",
        "bar": "Idempotent lifecycle. Duplicate or superseded requests and delayed callbacks cannot repeat a settled carry or retire its live successor.",
        "barKey": "R-3",
        "barHash": "7b05efeb93291ba8d0a1ed56a0e0a17d05861484c0cdc06145446098319f7eba",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Run the PTY-host unit, process-integration, and turn-lifecycle suites. Inspect the source admission order and generation fencing to prove a same-owner live host is refused before socket unlink or child spawn, stale or mismatched discovery records remain recoverable, and delayed terminal callbacks cannot settle a superseded generation.",
        "driftMarkers": "R-3 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Run npm exec vitest run apps/operator/lib/psu-pty-host.test.ts apps/operator/lib/psu-pty-host.integration.test.ts apps/operator/lib/psu-pty-host-turn.integration.test.ts -- --reporter=dot. Require the real competing-host case to receive the loud owner/pid refusal before onSpawn and the original socket to return ORIGINAL-ACK afterward; also require duplicate, stale, owner-mismatch, PID-reuse, delayed, failed, and superseded controls. All spawned processes and sockets must be cleaned by the tests.",
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host.test.ts",
            "apps/operator/lib/psu-pty-host.integration.test.ts",
            "apps/operator/lib/psu-pty-host-turn.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-4",
        "title": "Truthful continuation",
        "model": "Truthful continuation. Queued, submitted and native-turn-started outcomes remain distinct while a failed or deferred operation remains actionable.",
        "bar": "Truthful continuation. Queued, submitted and native-turn-started outcomes remain distinct while a failed or deferred operation remains actionable.",
        "barKey": "R-4",
        "barHash": "16e5d9d7b4e428959308af2d8b3ce3dd12c168fc27f4d8e917442546d2cb252d",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Run the request acknowledgement, durable outcome derivation, inbox surfacing, carry-delivery guard, and native-turn integration suites. Confirm a request ACK means queued only, delivered requires persisted native user-turn proof, pending stays pending, and terminal failure or delayed non-convergence becomes a stable actionable inbox condition.",
        "driftMarkers": "R-4 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Run npm exec vitest run packages/operator-core/lib/agent-tools/session/request-compaction.test.ts packages/operator-core/lib/carry-respawn-outcome.test.ts packages/operator-core/lib/agent-tools/coordination/tools/inbox-respawn-line.test.ts apps/operator/lib/psu-pty-host-carry-delivery-guard.integration.test.ts apps/operator/lib/psu-pty-host-turn.integration.test.ts -- --reporter=dot. Require green proof for queued acknowledgement, pending derivation, delivered first-turn persistence, dropped/retry exhaustion, and actionable inbox rendering; explicitly verify fresh child output without native user-turn persistence is not labeled delivered. Test fixtures self-clean.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/agent-tools/session/request-compaction.test.ts",
            "packages/operator-core/lib/carry-respawn-outcome.test.ts",
            "packages/operator-core/lib/agent-tools/coordination/tools/inbox-respawn-line.test.ts",
            "apps/operator/lib/psu-pty-host-carry-delivery-guard.integration.test.ts",
            "apps/operator/lib/psu-pty-host-turn.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-5",
        "title": "Protected boundaries",
        "model": "Protected boundaries. Carry preserves active work, human-staged input, owner-selected route and permission boundaries while missing prerequisites leave the predecessor intact.",
        "bar": "Protected boundaries. Carry preserves active work, human-staged input, owner-selected route and permission boundaries while missing prerequisites leave the predecessor intact.",
        "barKey": "R-5",
        "barHash": "a531ad83d13903b1b9cc8d6fc654c59ae0e5437e04c4a84618c30387d569867f",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Run the managed PreCompact, Codex-home, request-compaction, and carry-document suites. Inspect negative controls for non-auto compaction, unmanaged homes, owner or route mismatch, active or staged input, permission refusal, and missing durable authority; none may broaden authority, switch route, consume staged input, or end the predecessor. Execute the host rearm-epoch and carry-verifier detectors as well as the turn integration suite: deferred/staged human input must prevent recycle and waiting at the successor prompt, clearing input must recycle exactly once, and human input during submit verification must abort further CR retries. The quiet-output/recovery controls must still exercise resubmission and delivery.",
        "driftMarkers": "R-5 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Run testing:run with harness:'papercusp' and files:[\"apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts\",\"packages/operator-core/lib/role-codex-home.test.ts\",\"packages/operator-core/lib/agent-tools/session/request-compaction.test.ts\",\"packages/operator-core/lib/carry-doc.test.ts\",\"apps/operator/lib/psu-pty-host-rearm-epoch.test.ts\",\"apps/operator/lib/psu-pty-host-carry-verifier.test.ts\",\"apps/operator/lib/psu-pty-host-turn.integration.test.ts\"]. Resolve any returned durable recovery instead of launching a duplicate. Require every requested file matched/executed with zero omitted files before interpreting its verdict. Inspect the rearm-epoch human-input refusals and input-cleared recycle-once control, carry-verifier human-input abort/no-extra-CR and quiet-recovery controls, and the real PTY turn human-input interruption/settled-retry cases. Retain exact route/owner preservation, missing-authority, unmanaged/non-auto and permission negative controls. The managed home hook must reuse its exact signed per-session route. Fixtures self-clean.",
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/scripts/hooks/cc/__tests__/precompact-managed-carry.test.ts",
            "packages/operator-core/lib/role-codex-home.test.ts",
            "packages/operator-core/lib/agent-tools/session/request-compaction.test.ts",
            "packages/operator-core/lib/carry-doc.test.ts",
            "apps/operator/lib/psu-pty-host-rearm-epoch.test.ts",
            "apps/operator/lib/psu-pty-host-carry-verifier.test.ts",
            "apps/operator/lib/psu-pty-host-turn.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-6",
        "title": "Regression selection",
        "model": "Regression selection. Behavioral regressions distinguish defect from repair and are selected by the normal promotion suite.",
        "bar": "Regression selection. Behavioral regressions distinguish defect from repair and are selected by the normal promotion suite.",
        "barKey": "R-6",
        "barHash": "29e0655a0808b7c8bc696ddb4f16966e0cc1a579d0b184c226280ffa3d0eb2b7",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Run the affected-test changed-path provenance, declared-versus-consumed selection, and selected-files reporting tests, then invoke the real affected-test selector for the carry source paths. Require the operator-core stateful and lane-pure tasks, dependent workspaces, and repository guards to be selected with no carry test stranded outside normal promotion. The bound changed-path-provenance suite must execute its managed-carry source selection case, assert the normal apps/operator test plus both operator-core lanes and dependent/guard selection, and enumerate the real task configs with the maintained manifest reader. Its seven named managed-carry unit regressions must be present; unenumerated/overlapping/incomplete manifests fail the check. The exact unrelated docs-config path is the negative control. A formatter-only/provenance-only pass is insufficient.",
        "driftMarkers": "R-6 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the tree plane.",
        "replication": "REPLICATION DRILL: Run testing:run with harness:'papercusp' and files:[\"packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts\",\"packages/operator-core/lib/__tests__/affected-tests-declared-consumed-selection.test.ts\",\"packages/operator-core/lib/__tests__/affected-tests-selected-files-line.test.ts\"]. Resolve the one returned recovery if the foreground budget yields. Require requested files equal matched/executed files, with no omitted request. In the changed-path-provenance suite execute the carry-specific normal-promotion manifest regression. It executes the real --print-affected selector for managed PreCompact, Codex-home, PTY-host and carry-drill inputs; requires the apps/operator normal task, operator-core pure/stateful tasks, dependents and the post-compaction guard; enumerates the real configs and requires the seven named unit regressions; rejects an incomplete manifest and proves the unrelated docs-workspace control does not select those tasks. Selector enumeration must emit no execution verdict. No additional cleanup is needed.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts",
            "packages/operator-core/lib/__tests__/affected-tests-declared-consumed-selection.test.ts",
            "packages/operator-core/lib/__tests__/affected-tests-selected-files-line.test.ts"
          ]
        }
      },
      {
        "key": "r-7",
        "title": "Verified shipment",
        "model": "Verified shipment. The plan reaches shipped only after code-truth audit and independent acceptance grading with exact-runtime carry-and-resume evidence and honest older-host adoption status.",
        "bar": "Verified shipment. The plan reaches shipped only after code-truth audit and independent acceptance grading with exact-runtime carry-and-resume evidence and honest older-host adoption status.",
        "barKey": "R-7",
        "barHash": "bf6492bc0f63f22ec6c335f462f3909d4daaecac5d8e3d49406284b1bcd7cb82",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "deployed"
        ],
        "evidencePlane": "deployed",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-09-14T01:15:12.934Z",
          "declaredBy": "su-6eeda0f9-9087-43b2-b27d-e3856a7cf256"
        },
        "method": "Manual deployed-runtime contract: resolve current normal-promotion and deploy identity with dev:pipeline_position or the release trace, prove the green main pin contains every carry source change, run session:carry-drill start, grade exactly once, verify, and report against that exact deployed operator identity, and preserve any older-host or unsupported session-class gap as residue rather than relabeling it sufficient. Executable detector: session:carry-drill-lifecycle resolves the existing carry-drill-shipment native reader. Supply only exact ownerId, drillId, deploymentId (pipeline_events id) and reportId selection fields; no supplied pass, build SHA or cleanup boolean is trusted. Require exact successful green normal-promotion/deployment receipts; compare the deployed artifact's carry implementation paths to the committed current source population with no dirty paths; tie the durable drill request timestamp to its native start invocation; require start/grade/verify/report to share deployed port3070 build and serving process identity; read measured admission-time Codex-interactive host facts, exact addressed successor transcript and native verification result; enforce grade exactly once and zero recovery/surfacing gaps; require a durable owner-visible plan report naming owner/drill/full artifact and a native reports:get readback; require session:end, host shutdown-accepted and host-teardown receipts and absent disposable host. Missing, unreadable or incomplete receipts are non-pass. Native verifier evidence is retained after cleanup; do not require the retired subject to remain live. Independent acceptance judgment, Codex class-wide sufficiency, older-host adoption and honest residue interpretation remain required supplementary review.",
        "driftMarkers": "R-7 is falsified when the required outcome is absent, contradicted, or cannot be evidenced on the deployed plane.",
        "replication": "REPLICATION DRILL: After normal green promotion and deployment, record the exact main and deployed build identity; invoke session:carry-drill start from a disposable managed Codex session against that exact runtime, follow the addressed successor instruction to call grade exactly once with the injected drillId, then run verify and report. Require ledger-registered, host-respawned, terminal-outcome, owner-socket-live, and sufficient Codex-interactive evidence with zero surfacing gaps. Compare historical codex-headless and Claude-host coverage honestly; retire only explicitly proven classes. Clean up the disposable session through the supported drill lifecycle and retain the durable report id. For the registered check, select instrumentSnapshots[\"session:carry-drill-lifecycle\"].window={ownerId:<actual subject>,drillId:<injected id>,deploymentId:<successful native deploy event id>,reportId:<published durable owner report id>} and a completed bounded plan window. Publish/read back the exact owner/drill/full-build report after native grade/verify/report and before supported session:end cleanup. Evaluate after cleanup using native receipts. Negative controls must contradict healthy for wrong deployed build/process, non-green or missing-source artifact, headless/older host, foreign owner, duplicate grade, absent/foreign report, failed readback or incomplete cleanup. Local fixture tests validate the detector; only actual deployed/e2e receipts satisfy R7.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "session:carry-drill-lifecycle"
        }
      }
    ],
    "expectedRubricRevision": 4,
    "expectedSubjectPlanRevision": 31,
    "idempotencyKey": "managed-carry-r7-native-shipment-binding-20261023-v3",
    "reason": "Resolve reviewer thread-post1197459 full objective R7 detector gap; bind existing native pipeline, serving-identity, durable report/readback and supported cleanup receipts alongside exact Codex lifecycle. Preserve all outcomes, deployed/e2e scopes and independent/class-adoption judgment."
  },
  "supersedesDraft": "r7-native-shipment-v2-draft.json"
}
