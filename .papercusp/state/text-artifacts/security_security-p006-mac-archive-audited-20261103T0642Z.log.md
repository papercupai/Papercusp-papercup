---
rel_path: "security/security-p006-mac-archive-audited-20261103T0642Z.log"
updated_at: 1793688420543
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts -- -t selects universal Mach-O

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3094893, waiting up to 30s
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts -- -t selects universal Mach-O (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10021 capturedBytes=409 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3112961,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}"}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":15865}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":15919}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=13963 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":15919}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":15920}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":15920}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":15920}
PC_HEAVY_PREEMPT_READY pid=3104510
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-forked","childPid":3134750}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"start-sent","childPid":3134750,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"started-received","childPid":3134750,"elapsedMs":985,"startupMs":983,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10014 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3129843,\"event\":\"started-received\",\"childPid\":3134750,\"elapsedMs\":985,\"startupMs\":983,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20015 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3129843,\"event\":\"started-received\",\"childPid\":3134750,\"elapsedMs\":985,\"startupMs\":983,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":29560}
PC_HEAVY_PSI_FINALIZATION pid=3104510
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=29503 capturedBytes=3118 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths  20382ms"}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"stop-sent","childPid":3134750,"elapsedMs":22320}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"stopped-received","childPid":3134750,"elapsedMs":22321,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-signal","childPid":3134750,"elapsedMs":22322,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-disconnect","childPid":3134750,"elapsedMs":22368}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-exit","childPid":3134750,"elapsedMs":22372,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-close","childPid":3134750,"elapsedMs":22372,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30015 capturedBytes=4120 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3129843,\"event\":\"worker-close\",\"childPid\":3134750,\"elapsedMs\":22372,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":34671}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":34727}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=34669 capturedBytes=4120 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3129843,\"event\":\"worker-close\",\"childPid\":3134750,\"elapsedMs\":22372,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":34727}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":34728}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":34728}
TEST_FILE_FINALIZATION {"pid":3104510,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":34728}
Running as unit: papercusp-test-3104510-mw0bltaz-4.scope; invocation ID: 7cbfb275c3494bda8b1831f86de3ba7d
TEST_FILE_STARTUP_TRACE {"pid":3126666,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-forked","childPid":3134750}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"start-sent","childPid":3134750,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3134750,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"started-received","childPid":3134750,"elapsedMs":985,"startupMs":983,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"stop-sent","childPid":3134750,"elapsedMs":22320}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"stopped-received","childPid":3134750,"elapsedMs":22321,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-signal","childPid":3134750,"elapsedMs":22322,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-disconnect","childPid":3134750,"elapsedMs":22368}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-exit","childPid":3134750,"elapsedMs":22372,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3129843,"event":"worker-close","childPid":3134750,"elapsedMs":22372,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3104510,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":3104510,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3094893-1793688111899331453 retryHandle=psi-recovery:pc-heavy-3094893-1793688111899331453 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=4b3b39bc9c testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T06:42:02.407Z
  HEAD         : 4b3b39bc9c
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +24/-9]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/release/tauri-update-authorization-native.test.ts (4 tests | 3 skipped) 20390ms
   ✓ selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths  20382ms

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  01:42:25
   Duration  22.39s (transform 604ms, setup 827ms, import 87ms, tests 20.39s, environment 0ms)

TEST_FILE_PROVENANCE head=4b3b39bc9c testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-03T06:42:53.336Z
  HEAD         : 4b3b39bc9c
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +24/-9]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_SKIPPED name="native consumer verifies real dual signatures, actual bytes, identities and current trust" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="extracts actual build inputs from a compiled native image and refuses decoys or malformed sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=4b3b39bc9c uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T06:42:02.407Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=3

