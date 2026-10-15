---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-preflight-verified-fire28-424d5.json"
updated_at: 1791847773856
_body: "content"
---

{
  "schemaVersion": "r13-source-preflight-fire28-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "rootItem": "EI-25793355480687493",
  "route": "approved SELF/AUTO; cold carry unchanged",
  "test": {
    "path": "packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts",
    "sha256": "a46938cf6883f5affec56be3dde0a650aacf8fdef6ce8043a921ffd2c45b0477",
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts -t 'source preflight'",
    "log": "/tmp/parked-fire28-preflight-424d5.log",
    "exit": 0,
    "passed": 3,
    "skipped": 1,
    "startedAt": "2026-10-12T23:13:29.358Z",
    "head": "81d5c6e275",
    "provenance": "LOCAL; named test untracked; not private behavior or committed-source acceptance"
  },
  "verifiedGuardCases": [
    "Committed fixture/scenario bytes accepted under inherited loader",
    "Each runtime path missing, older or uncommitted is refused",
    "Worktree execution allowed when inherited committed-source loader absent"
  ],
  "publication": {
    "observedHead": "775ff68279c5f43fec8e656c4655db26e608e5c2",
    "fixture": {
      "path": "packages/operator-core/test/staging-first-http-fixture.ts",
      "working": "2a6166d475081bac285e1910bba4619fecb571870a8f9587c21c7acbd68ada4e",
      "committed": "c79a55a814c05e3430987a0ce1cba40b4b48ea455d50cc63dff797f9bf0432e4",
      "equal": false
    },
    "scenario": {
      "sha256": "f6c80e8631d29261d2b8971397585a86f9787f46c349d9befd9c60ec62c6e283",
      "equal": true
    },
    "test": {
      "committed": false
    },
    "syncProgress": "Exact recipe read shows local-sync progressing at 2026-10-12T22:37:23.387Z; safe_to_restart:false. Saved /tmp/parked-fire28-sync-progress-424d5.json. One resource-release await timed out; no duplicate sync fire or restart.",
    "activeFileLocks": "Final unrestricted exact two-path queue is empty. Manual lock cc692dcb edit finished; release receipt held_before0/released[]; no active own edit."
  },
  "retryCleanup": {
    "sourceSha256": "3c4192ffaa392bff066093d81fb2a0618d15741bc42a40bf452255198b8192ac",
    "testSha256": "9c75cec8333f3ee3d03eaece90a78847e4d433138b17480911fd198e07789234",
    "committedEqual": true,
    "installedEqual": true,
    "proofs": [
      "r13-native-retry-cleanup-fire25-424d5.json",
      "r13-retry-publication-fire26-424d5.json"
    ],
    "limitation": "Original failed-parent PostToolUse omission remains unverified; root961 not closed."
  },
  "frozenR13": {
    "artifact": "r13-original116-route-custody-cold8-v5-424d5.json",
    "fullLocalRead": "/tmp/parked-fire28-custody-v5-full-424d5.json",
    "contentChars": 588094,
    "rows": 116,
    "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  },
  "remaining": [
    "Exact three-file publication then current-runtime preflight before THIRD expensive private HTTP attempt",
    "Frozen original116 eligibility and legitimate exclusions before existing18+7 outcome joins",
    "Original root961 initial failed-parent mechanism",
    "Legacy R5 source-pin residue",
    "ALL final-fix runtime/time anchor and real >=24h R14 census"
  ],
  "handles": "All fresh handles completed and drained; no surviving private worker",
  "limits": "No private WARM behavior verdict, no whole-plan completion, no R14 due date, no peer model/account/carry changes, no LIVE_GATE_OPS"
}
