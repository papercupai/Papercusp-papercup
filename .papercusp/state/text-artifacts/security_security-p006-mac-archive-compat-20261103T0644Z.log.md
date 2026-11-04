---
rel_path: "security/security-p006-mac-archive-compat-20261103T0644Z.log"
updated_at: 1793688572415
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3227063, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 3227063, slots=1)
[pc-heavy] still queued (30s elapsed, pid 3227063, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":2}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=17 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10017 capturedBytes=712 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3288180,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}"}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":16270}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":16326}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=13789 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":16327}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":16327}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":16327}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":16327}
PC_HEAVY_PREEMPT_READY pid=3272168
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=20 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10022 capturedBytes=800 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core"}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-forked","childPid":3307871}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"start-sent","childPid":3307871,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"started-received","childPid":3307871,"elapsedMs":1003,"startupMs":1001,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20026 capturedBytes=1442 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3301841,\"event\":\"started-received\",\"childPid\":3307871,\"elapsedMs\":1003,\"startupMs\":1001,\"error\":false}"}
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=5 admittedCgroupMiB=3563 admissionId=pc-heavy-3227063-1793688278884081877 retryHandle=psi-recovery:pc-heavy-3227063-1793688278884081877 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30027 capturedBytes=1442 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3301841,\"event\":\"started-received\",\"childPid\":3307871,\"elapsedMs\":1003,\"startupMs\":1001,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40028 capturedBytes=1718 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50029 capturedBytes=1718 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=60030 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=70032 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=80033 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=90034 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=100035 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=110036 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=120037 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=130038 capturedBytes=2923 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":135783}
PC_HEAVY_PSI_FINALIZATION pid=3272168
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=135618 capturedBytes=3930 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/release/tauri-update-authorization-native.test.ts (4 tests) 123316ms"}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"stop-sent","childPid":3307871,"elapsedMs":125541}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"stopped-received","childPid":3307871,"elapsedMs":125542,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-signal","childPid":3307871,"elapsedMs":125545,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-disconnect","childPid":3307871,"elapsedMs":125664}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-exit","childPid":3307871,"elapsedMs":125668,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-close","childPid":3307871,"elapsedMs":125668,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=140039 capturedBytes=5380 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3301841,\"event\":\"worker-close\",\"childPid\":3307871,\"elapsedMs\":125668,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":142716}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":142780}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=142610 capturedBytes=5380 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3301841,\"event\":\"worker-close\",\"childPid\":3307871,\"elapsedMs\":125668,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":142781}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":142782}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":142782}
TEST_FILE_FINALIZATION {"pid":3272168,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":142782}
Running as unit: papercusp-test-3272168-mw0bpdd5-4.scope; invocation ID: 27c46925cda6459c864847e73b580ad2
TEST_FILE_STARTUP_TRACE {"pid":3296473,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-forked","childPid":3307871}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"start-sent","childPid":3307871,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3307871,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"started-received","childPid":3307871,"elapsedMs":1003,"startupMs":1001,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=3
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"stop-sent","childPid":3307871,"elapsedMs":125541}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"stopped-received","childPid":3307871,"elapsedMs":125542,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-signal","childPid":3307871,"elapsedMs":125545,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-disconnect","childPid":3307871,"elapsedMs":125664}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-exit","childPid":3307871,"elapsedMs":125668,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3301841,"event":"worker-close","childPid":3307871,"elapsedMs":125668,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3272168,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":3272168,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE_HEAD_MOVED from=0a458561cc to=e6fac060f4; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3227063-1793688278884081877 retryHandle=psi-recovery:pc-heavy-3227063-1793688278884081877 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=0a458561cc testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T06:44:47.853Z
  HEAD         : 0a458561cc
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

 ✓ lib/release/tauri-update-authorization-native.test.ts (4 tests) 123316ms
   ✓ native consumer verifies real dual signatures, actual bytes, identities and current trust  19231ms
   ✓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections  24927ms
   ✓ selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths  22209ms
   ✓ producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections  56939ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  01:45:14
   Duration  125.67s (transform 740ms, setup 1.09s, import 92ms, tests 123.32s, environment 0ms)

TEST_FILE_PROVENANCE head=e6fac060f4 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-03T06:47:27.225Z
  HEAD         : e6fac060f4
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +24/-9]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=0a458561cc uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T06:44:47.853Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=0

