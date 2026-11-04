---
rel_path: "security/security-p006-authors-extraction-final-20261103T0536Z.log"
updated_at: 1793684372886
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=extracts actual build inputs

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3638268, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 3638268, slots=1)
[pc-heavy] still queued (30s elapsed, pid 3638268, slots=1)
[pc-heavy] slot acquired — starting real work
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3665663, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=extracts actual build inputs (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3666567, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=19 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":9391}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":9437}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=6970 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":9437}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":9438}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":9438}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":9438}
PC_HEAVY_PREEMPT_READY pid=3666567
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":0}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10008 capturedBytes=800 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20009 capturedBytes=800 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core"}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-forked","childPid":3691778}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"start-sent","childPid":3691778,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"started-received","childPid":3691778,"elapsedMs":836,"startupMs":834,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30010 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3681165,\"event\":\"started-received\",\"childPid\":3691778,\"elapsedMs\":836,\"startupMs\":834,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40011 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3681165,\"event\":\"started-received\",\"childPid\":3691778,\"elapsedMs\":836,\"startupMs\":834,\"error\":false}"}
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=5 admittedCgroupMiB=9384 admissionId=pc-heavy-3638268-1793684173321122896 retryHandle=psi-recovery:pc-heavy-3638268-1793684173321122896 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50012 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3681165,\"event\":\"started-received\",\"childPid\":3691778,\"elapsedMs\":836,\"startupMs\":834,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":53507}
PC_HEAVY_PSI_FINALIZATION pid=3666567
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=53341 capturedBytes=2830 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections  31142ms"}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"stop-sent","childPid":3691778,"elapsedMs":32682}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"stopped-received","childPid":3691778,"elapsedMs":32683,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-signal","childPid":3691778,"elapsedMs":32684,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-disconnect","childPid":3691778,"elapsedMs":32810}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-exit","childPid":3691778,"elapsedMs":32813,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-close","childPid":3691778,"elapsedMs":32814,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":58847}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":58907}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=58741 capturedBytes=3832 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-OjMyj9/group-0.json"}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":58908}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":58908}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":58908}
TEST_FILE_FINALIZATION {"pid":3666567,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":58908}
Running as unit: papercusp-test-3666567-mw0997yq-4.scope; invocation ID: 7c9738b9e00742f2aec029244f398f41
TEST_FILE_STARTUP_TRACE {"pid":3679868,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-forked","childPid":3691778}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"start-sent","childPid":3691778,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":3691778,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"started-received","childPid":3691778,"elapsedMs":836,"startupMs":834,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"stop-sent","childPid":3691778,"elapsedMs":32682}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"stopped-received","childPid":3691778,"elapsedMs":32683,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-signal","childPid":3691778,"elapsedMs":32684,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-disconnect","childPid":3691778,"elapsedMs":32810}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-exit","childPid":3691778,"elapsedMs":32813,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3681165,"event":"worker-close","childPid":3691778,"elapsedMs":32814,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3666567,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":3666567,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE_HEAD_MOVED from=61ebd68548 to=838edecd1a; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3638268-1793684173321122896 retryHandle=psi-recovery:pc-heavy-3638268-1793684173321122896 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=61ebd68548 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T05:36:22.018Z
  HEAD         : 61ebd68548
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +1/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/release/tauri-update-authorization-native.test.ts (3 tests | 2 skipped) 31146ms
   ✓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections  31142ms

 Test Files  1 passed (1)
      Tests  1 passed | 2 skipped (3)
   Start at  00:36:52
   Duration  34.21s (transform 391ms, setup 650ms, import 28ms, tests 31.15s, environment 0ms)

TEST_FILE_PROVENANCE head=838edecd1a testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-11-03T05:37:30.642Z
  HEAD         : 838edecd1a
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
TEST_FILE_SKIPPED name="native consumer verifies real dual signatures, actual bytes, identities and current trust" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=61ebd68548 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T05:36:22.018Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=2

