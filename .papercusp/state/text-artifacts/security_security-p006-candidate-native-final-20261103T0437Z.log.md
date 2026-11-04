---
rel_path: "security/security-p006-candidate-native-final-20261103T0437Z.log"
updated_at: 1793680996232
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 381970, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 381970, slots=1)
[pc-heavy] still queued (30s elapsed, pid 381970, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":2}
COMMITTED_SOURCE substituted scripts/test-files.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 421088, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 421088, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":10820}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":10890}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=7810 capturedBytes=1346 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":10891}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":10891}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":10892}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":10892}
PC_HEAVY_PREEMPT_READY pid=421088
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10021 capturedBytes=987 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":440157,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}"}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-forked","childPid":449224}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"start-sent","childPid":449224,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"started-received","childPid":449224,"elapsedMs":821,"startupMs":820,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20022 capturedBytes=2925 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":440157,\"event\":\"started-received\",\"childPid\":449224,\"elapsedMs\":821,\"startupMs\":820,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30023 capturedBytes=2925 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":440157,\"event\":\"started-received\",\"childPid\":449224,\"elapsedMs\":821,\"startupMs\":820,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40024 capturedBytes=3201 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50028 capturedBytes=3201 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":57062}
PC_HEAVY_PSI_FINALIZATION pid=421088
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=56955 capturedBytes=4418 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections  21862ms"}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"stop-sent","childPid":449224,"elapsedMs":42680}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"stopped-received","childPid":449224,"elapsedMs":42682,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-signal","childPid":449224,"elapsedMs":42683,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-disconnect","childPid":449224,"elapsedMs":42744}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-exit","childPid":449224,"elapsedMs":42747,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-close","childPid":449224,"elapsedMs":42747,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=60029 capturedBytes=5992 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes"}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":64778}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":64829}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=64720 capturedBytes=6886 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes"}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":64829}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":64829}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":64830}
TEST_FILE_FINALIZATION {"pid":421088,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":64830}
Running as unit: papercusp-test-421088-mw075yv7-4.scope; invocation ID: b888ea57a4804ee89407231fb04ee261
TEST_FILE_STARTUP_TRACE {"pid":437458,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 437458, entry npx); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry node_modules/vitest/vitest.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-forked","childPid":449224}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"start-sent","childPid":449224,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":449224,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 449224, entry node_modules/vitest/dist/workers/forks.js); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"started-received","childPid":449224,"elapsedMs":821,"startupMs":820,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"stop-sent","childPid":449224,"elapsedMs":42680}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"stopped-received","childPid":449224,"elapsedMs":42682,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-signal","childPid":449224,"elapsedMs":42683,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-disconnect","childPid":449224,"elapsedMs":42744}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-exit","childPid":449224,"elapsedMs":42747,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":440157,"event":"worker-close","childPid":449224,"elapsedMs":42747,"code":null,"signal":"SIGTERM"}
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted scripts/lib/vitest-startup-trace.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 440157, entry src/git-read-worker.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_FINALIZATION {"pid":421088,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":421088,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE_HEAD_MOVED from=b878271db1 to=dbeb7be15a; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-381970-1793680660119815956 retryHandle=psi-recovery:pc-heavy-381970-1793680660119815956 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=b878271db1 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T04:37:49.631Z
  HEAD         : b878271db1
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +100/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/release/tauri-update-authorization-native.test.ts (2 tests) 41110ms
   ✓ native consumer verifies real dual signatures, actual bytes, identities and current trust  19240ms
   ✓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections  21862ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  23:38:14
   Duration  42.93s (transform 429ms, setup 665ms, import 50ms, tests 41.11s, environment 0ms)

TEST_FILE_PROVENANCE head=dbeb7be15a testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-11-03T04:39:05.676Z
  HEAD         : dbeb7be15a
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
TEST_FILE_CHILD_SUBSTITUTED count=12
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=431727 entry=npx
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=433643 entry=node_modules/vitest/vitest.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=437458 entry=npx
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=node_modules/vitest/vitest.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=449224 entry=node_modules/vitest/dist/workers/forks.js
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  substituted esm scripts/lib/vitest-startup-trace.mjs  pid=440157 entry=src/git-read-worker.mjs
  ⚠ a test-spawned node child ran the COMMITTED blob of these files (substituted) or refused them: any assertion that depends on that child measured HEAD, not your working tree.
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=b878271db1 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T04:37:49.631Z childSubstituted=12 childNoticeOffsetBytes=0 skippedTests=0

