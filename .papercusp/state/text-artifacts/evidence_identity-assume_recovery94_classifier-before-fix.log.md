---
rel_path: "evidence/identity-assume/recovery94/classifier-before-fix.log"
updated_at: 1793250616877
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs libs/test-config/src/vitest-failure-classification.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 259340, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 259340, slots=1)
[pc-heavy] still queued (30s elapsed, pid 259340, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs libs/test-config/src/vitest-failure-classification.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-start","elapsedMs":1}
COMMITTED_SOURCE substituted scripts/test-files.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 281749, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="libs/test-config" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-exit","elapsedMs":10239}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-close","elapsedMs":10277}
TEST_FILE_LIST_PROGRESS state=finished cwd="libs/test-config" elapsedMs=8702 capturedBytes=751 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"src/vitest-failure-classification.test.ts"}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"demand-sample-start","elapsedMs":10277}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"demand-sample-returned","elapsedMs":10278}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-returned","elapsedMs":10278}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"governed-returned","elapsedMs":10278}
PC_HEAVY_PREEMPT_READY pid=281749
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="libs/test-config" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=["src/vitest-failure-classification.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-forked","childPid":293969}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"start-sent","childPid":293969,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"started-received","childPid":293969,"elapsedMs":553,"startupMs":552,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the serialized Vitest AssertionError header"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the serialized Vitest AssertionError header","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest resolves settlement assertion after stack serialization"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest resolves settlement assertion after stack serialization","state":"failed","errors":[{"message":"expected false to be true // Object.is equality","stack":"AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest rejects settlement assertion after stack serialization"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest rejects settlement assertion after stack serialization","state":"failed","errors":[{"message":"expected false to be true // Object.is equality","stack":"AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > requires both the settlement message and the immediate Vitest matcher origin"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > requires both the settlement message and the immediate Vitest matcher origin","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > does not treat runtime exceptions or arbitrary failure text as assertion evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > does not treat runtime exceptions or arbitrary failure text as assertion evidence","state":"passed"}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"files-complete","elapsedMs":7313}
PC_HEAVY_PSI_FINALIZATION pid=281749
TEST_FILE_PROGRESS state=file-completed cwd="libs/test-config" elapsedMs=7222 capturedBytes=5320 completedFiles=["src/vitest-failure-classification.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"❯ src/vitest-failure-classification.test.ts (5 tests | 2 failed) 19ms"}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"stop-sent","childPid":293969,"elapsedMs":1388}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"stopped-received","childPid":293969,"elapsedMs":1389,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-signal","childPid":293969,"elapsedMs":1389,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-disconnect","childPid":293969,"elapsedMs":1767}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-exit","childPid":293969,"elapsedMs":1772,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-close","childPid":293969,"elapsedMs":1772,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="libs/test-config" elapsedMs=10010 capturedBytes=7693 completedFiles=["src/vitest-failure-classification.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-1ArZc8/group-0.json"}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-exit","elapsedMs":10485}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-close","elapsedMs":10531}
TEST_FILE_PROGRESS state=finished cwd="libs/test-config" elapsedMs=10440 capturedBytes=7693 completedFiles=["src/vitest-failure-classification.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-1ArZc8/group-0.json"}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"demand-sample-start","elapsedMs":10531}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"demand-sample-returned","elapsedMs":10532}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"child-returned","elapsedMs":10532}
TEST_FILE_FINALIZATION {"pid":281749,"cwd":"libs/test-config","phase":"governed-returned","elapsedMs":10532}
Running as unit: papercusp-test-281749-mvt2hxug-4.scope; invocation ID: 62015c9d22364a9db2014f26d5bfe8cb
TEST_FILE_STARTUP_TRACE {"pid":289857,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-forked","childPid":293969}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"start-sent","childPid":293969,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":293969,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"started-received","childPid":293969,"elapsedMs":553,"startupMs":552,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the serialized Vitest AssertionError header"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the serialized Vitest AssertionError header","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest resolves settlement assertion after stack serialization"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest resolves settlement assertion after stack serialization","state":"failed","errors":[{"message":"expected false to be true // Object.is equality","stack":"AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest rejects settlement assertion after stack serialization"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > recognizes the actual Vitest rejects settlement assertion after stack serialization","state":"failed","errors":[{"message":"expected false to be true // Object.is equality","stack":"AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > requires both the settlement message and the immediate Vitest matcher origin"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > requires both the settlement message and the immediate Vitest matcher origin","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > does not treat runtime exceptions or arbitrary failure text as assertion evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts","name":"isVitestAssertionFailure > does not treat runtime exceptions or arbitrary failure text as assertion evidence","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"stop-sent","childPid":293969,"elapsedMs":1388}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"stopped-received","childPid":293969,"elapsedMs":1389,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-signal","childPid":293969,"elapsedMs":1389,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-disconnect","childPid":293969,"elapsedMs":1767}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-exit","childPid":293969,"elapsedMs":1772,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":291201,"event":"worker-close","childPid":293969,"elapsedMs":1772,"code":null,"signal":"SIGTERM"}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/vitest-failure-classification.test.ts > isVitestAssertionFailure > recognizes the actual Vitest resolves settlement assertion after stack serialization
 FAIL  src/vitest-failure-classification.test.ts > isVitestAssertionFailure > recognizes the actual Vitest rejects settlement assertion after stack serialization
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/vitest-failure-classification.test.ts:29:54
     27|       const serialized = failure?.stack || failure?.message;
     28|       expect(serialized).toMatch(/^Error: promise (rejected|resolved) …
     29|       expect(isVitestAssertionFailure([serialized])).toBe(true);
       |                                                      ^
     30|     },
     31|   );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

TEST_FILE_GROUP_RESULT cwd=libs/test-config executed=1 status=failed
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts" name="isVitestAssertionFailure recognizes the actual Vitest resolves settlement assertion after stack serialization" message="AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts" name="isVitestAssertionFailure recognizes the actual Vitest rejects settlement assertion after stack serialization" message="AssertionError: expected false to be true // Object.is equality\n    at /home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/vitest-failure-classification.test.ts:29:54\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"
TEST_FILE_FINALIZATION {"pid":281749,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":281749,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-259340-1793249559868937638 retryHandle=psi-recovery:pc-heavy-259340-1793249559868937638 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=f76cc76493 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-29T04:52:47.505Z
  HEAD         : f76cc76493
  tested files : libs/test-config/src/vitest-failure-classification.test.ts  [DIRTY +40/-0 repo=libs/test-config repoHead=09a03e26d1 superprojectPin=adb50571f56d46bbc8f55f5c3d56aa8b5366c0a2 pointer=mismatch]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git -C libs/test-config show <candidate-pin-for-libs/test-config>:src/vitest-failure-classification.test.ts   # submodule: from the superproject, git status/show answer about the gitlink, not this file
ROUTE cwd=libs/test-config config=vitest.config.ts
  requested src/vitest-failure-classification.test.ts
  matched src/vitest-failure-classification.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/libs/test-config

 ❯ src/vitest-failure-classification.test.ts (5 tests | 2 failed) 19ms
     ✓ recognizes the serialized Vitest AssertionError header 2ms
     × recognizes the actual Vitest resolves settlement assertion after stack serialization 9ms
     × recognizes the actual Vitest rejects settlement assertion after stack serialization 1ms
     ✓ requires both the settlement message and the immediate Vitest matcher origin 0ms
     ✓ does not treat runtime exceptions or arbitrary failure text as assertion evidence 0ms

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
   Start at  00:53:03
   Duration  2.27s (transform 237ms, setup 753ms, import 15ms, tests 19ms, environment 0ms)

TEST_FILE_PROVENANCE head=f76cc76493 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-29T04:53:08.478Z
  HEAD         : f76cc76493
  tested files : libs/test-config/src/vitest-failure-classification.test.ts  [DIRTY +40/-0 repo=libs/test-config repoHead=09a03e26d1 superprojectPin=adb50571f56d46bbc8f55f5c3d56aa8b5366c0a2 pointer=mismatch]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git -C libs/test-config show <candidate-pin-for-libs/test-config>:src/vitest-failure-classification.test.ts   # submodule: from the superproject, git status/show answer about the gitlink, not this file
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=f76cc76493 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-29T04:52:47.505Z childSubstituted=0 skippedTests=0

