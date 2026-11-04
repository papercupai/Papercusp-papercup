---
rel_path: "security/security-p006-producer-native-final-20261103T0503Z.log"
updated_at: 1793682430081
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=producer binds effective

[pc-heavy] queued for a heavy slot (all 4 slot(s) busy) — pid 1986215, waiting up to 30s; memory reserve 7 GiB/slot (cold-start-max:5619MiB)
[pc-heavy] still queued (15s elapsed, pid 1986215, slots=4)
[pc-heavy] still queued (30s elapsed, pid 1986215, slots=4)
[pc-heavy] slot acquired — starting real work
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2023190, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=producer binds effective (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":2}
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2024417, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=20 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":7446}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":7483}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=5165 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":7484}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":7484}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":7484}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":7484}
PC_HEAVY_PREEMPT_READY pid=2024417
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-forked","childPid":2045554}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"start-sent","childPid":2045554,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"started-received","childPid":2045554,"elapsedMs":744,"startupMs":743,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10010 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"started-received\",\"childPid\":2045554,\"elapsedMs\":744,\"startupMs\":743,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20012 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"started-received\",\"childPid\":2045554,\"elapsedMs\":744,\"startupMs\":743,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30013 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"started-received\",\"childPid\":2045554,\"elapsedMs\":744,\"startupMs\":743,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40014 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"started-received\",\"childPid\":2045554,\"elapsedMs\":744,\"startupMs\":743,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50086 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"started-received\",\"childPid\":2045554,\"elapsedMs\":744,\"startupMs\":743,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":50704}
PC_HEAVY_PSI_FINALIZATION pid=2024417
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=50640 capturedBytes=2715 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/release/tauri-update-authorization-native.test.ts (3 tests | 2 skipped) 42543ms"}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"stop-sent","childPid":2045554,"elapsedMs":43897}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"stopped-received","childPid":2045554,"elapsedMs":43898,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-signal","childPid":2045554,"elapsedMs":43898,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-disconnect","childPid":2045554,"elapsedMs":43924}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-exit","childPid":2045554,"elapsedMs":43926,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-close","childPid":2045554,"elapsedMs":43927,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":53362}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":53416}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=53351 capturedBytes=3832 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2043139,\"event\":\"worker-close\",\"childPid\":2045554,\"elapsedMs\":43927,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":53416}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":53417}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":53417}
TEST_FILE_FINALIZATION {"pid":2024417,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":53417}
Running as unit: papercusp-test-2024417-mw084aow-4.scope; invocation ID: 59b0271a998b4a8bbd10303dbbac0b79
TEST_FILE_STARTUP_TRACE {"pid":2042303,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-forked","childPid":2045554}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"start-sent","childPid":2045554,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2045554,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"started-received","childPid":2045554,"elapsedMs":744,"startupMs":743,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"stop-sent","childPid":2045554,"elapsedMs":43897}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"stopped-received","childPid":2045554,"elapsedMs":43898,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-signal","childPid":2045554,"elapsedMs":43898,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-disconnect","childPid":2045554,"elapsedMs":43924}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-exit","childPid":2045554,"elapsedMs":43926,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2043139,"event":"worker-close","childPid":2045554,"elapsedMs":43927,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":2024417,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":2024417,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1986215-1793682266152052511 retryHandle=psi-recovery:pc-heavy-1986215-1793682266152052511 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=d748ad9de6 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T05:04:34.715Z
  HEAD         : d748ad9de6
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +147/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/release/tauri-update-authorization-native.test.ts (3 tests | 2 skipped) 42543ms
   ✓ producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections  42538ms

 Test Files  1 passed (1)
      Tests  1 passed | 2 skipped (3)
   Start at  00:04:48
   Duration  43.94s (transform 357ms, setup 555ms, import 32ms, tests 42.54s, environment 0ms)

TEST_FILE_PROVENANCE head=d748ad9de6 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-03T05:05:35.859Z
  HEAD         : d748ad9de6
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +147/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_SKIPPED name="native consumer verifies real dual signatures, actual bytes, identities and current trust" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="extracts actual build inputs from a compiled native image and refuses decoys or malformed sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=d748ad9de6 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T05:04:34.715Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=2

