---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold21-committed-custody-proof-424d5.json"
updated_at: 1791887752025
_body: "content"
---

{
  "schemaVersion": "parked-cold21-custody-committed-proof-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "EI-25855583682954393",
  "plan": "parked-agent-census-resumption-and-root-cause-2026-10-09",
  "lane": "P-013",
  "head": "9d4c38edefea40ad3c098330634f6e6b4f86a3f8",
  "sourceSha256": "5f2e9c35751e75a2ffbdafc78a319dc18604c9ffdaeb4474093f5259f0b2f35b",
  "testSha256": "bc5dd0d6097bc6d951bfe30bb51997bbb127f958b2527c5bac1f73205a6326ee",
  "offloadTestSha256": "a9a29dd9d1222622725c023bdb801fcffaa63d8155935cc24698302911722bdf",
  "workingAndHeadEquality": "all three exact scoped blobs independently compared equal before/after maintained rerun",
  "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/role-codex-home.test.ts packages/operator-core/lib/role-codex-home-offload.test.ts",
  "exitCode": 0,
  "result": {
    "passed": 98,
    "failed": 0,
    "skipped": 0,
    "childSubstituted": 0,
    "testFiles": 2
  },
  "testRunIds": [
    21193326,
    21193327
  ],
  "ledgerScope": {
    "harness": "papercusp",
    "source": "local",
    "commit": "9d4c38edefea40ad3c098330634f6e6b4f86a3f8",
    "fileStatuses": "pass",
    "worktreeDirty": true,
    "note": "Ledger reports worktreeDirty:true. This proof asserts exact named source/test blobs equal HEAD; it makes no global clean-tree assertion."
  },
  "logSha256": "e0a66e5e8c98ee249832af7f0be8a31b50a67da016b206a4b95b8b1bdde52154",
  "logBytes": 6491,
  "fullLog": "\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/role-codex-home.test.ts packages/operator-core/lib/role-codex-home-offload.test.ts\n\n[pc-heavy] release gate is JUDGING (phase=unknown) — heavy slots clamped to 1 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).\n[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3309112, waiting up to 30s\n[pc-heavy] still queued (15s elapsed, pid 3309112, slots=1)\n[pc-heavy] still queued (30s elapsed, pid 3309112, slots=1)\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/role-codex-home.test.ts packages/operator-core/lib/role-codex-home-offload.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3800 capturedBytes=170 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3354582\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/role-codex-home-offload.test.ts\",\"lib/role-codex-home.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=9040 capturedBytes=252 completedFiles=[\"lib/role-codex-home-offload.test.ts\"] pendingFiles=[\"lib/role-codex-home.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10014 capturedBytes=356 completedFiles=[\"lib/role-codex-home-offload.test.ts\"] pendingFiles=[\"lib/role-codex-home.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20014 capturedBytes=356 completedFiles=[\"lib/role-codex-home-offload.test.ts\"] pendingFiles=[\"lib/role-codex-home.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3354582\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=29646 capturedBytes=520 completedFiles=[\"lib/role-codex-home-offload.test.ts\",\"lib/role-codex-home.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=30015 capturedBytes=1293 completedFiles=[\"lib/role-codex-home-offload.test.ts\",\"lib/role-codex-home.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=31063 capturedBytes=1293 completedFiles=[\"lib/role-codex-home-offload.test.ts\",\"lib/role-codex-home.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3354582-mv6jm29x-4.scope; invocation ID: c9c56a6ff70049da8f78a2687b5a5ece\nTEST_FILE_ROUTE requested=2 groups=1\nTEST_FILE_PROVENANCE head=9d4c38edef testedPaths=2 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-13T10:33:07.040Z\n  HEAD         : 9d4c38edef\n  tested files : packages/operator-core/lib/role-codex-home.test.ts  [clean]\n                 packages/operator-core/lib/role-codex-home-offload.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/role-codex-home.test.ts\n  requested lib/role-codex-home-offload.test.ts\n  matched lib/role-codex-home-offload.test.ts\n  matched lib/role-codex-home.test.ts\n[db] target source=operator-env-file endpoint=localhost:5432\n\n RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core\n\n ✓ lib/role-codex-home-offload.test.ts (4 tests) 2696ms\n     ✓ writes a role home through the worker entry and confines files to the configured roots  2592ms\n ✓ lib/role-codex-home.test.ts (94 tests) 23375ms\n     ✓ writeRoleCodexHome retains original native transcripts while rebuilding generated launch files  5954ms\n     ✓ writeSuCodexHomeAsync retains original native transcripts while rebuilding generated launch files  8124ms\n     ✓ uses async filesystem access for owner-sid reads and stamps during fresh creation  3026ms\n     ✓ uses async filesystem access for owner-sid reads and stamps during repair  3150ms\n     ✓ end to end: the composed Stop command preserves a codex turn with 'synchronous success'  680ms\n     ✓ end to end: the composed Stop command preserves a codex turn with 'detached blocked response'  335ms\n\n Test Files  2 passed (2)\n      Tests  98 passed (98)\n   Start at  06:33:26\n   Duration  25.06s (transform 4.84s, setup 1.10s, import 782ms, tests 26.07s, environment 0ms)\n\nTEST_FILE_PROVENANCE head=9d4c38edef testedPaths=2 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-13T10:33:52.995Z\n  HEAD         : 9d4c38edef\n  tested files : packages/operator-core/lib/role-codex-home.test.ts  [clean]\n                 packages/operator-core/lib/role-codex-home-offload.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=9d4c38edef uncommittedPaths=0/2 provenance=stamped startedAt=2026-10-13T10:33:07.040Z childSubstituted=0 skippedTests=0\n",
  "priorArtifact": "audits/parked-agent-resumption-2026-10-09/r13-cold20-native-custody-fix-and-verification-424d5.json",
  "remaining": "Historical deletion actor/custody,79 unresolved original COLD receipts,whole116 cutoff continuity/eligibility before outcome joins,R5/root961/R12/malformednative/final all-fix runtime anchor and actual>=24h R14 remain open. No shipment or final acceptance claim."
}
