---
rel_path: "verification/WI-6554700010016963/2026-10-17-reader-final.log"
updated_at: 1792274874660
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.test.ts

[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=4001 capturedBytes=754 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none
PC_HEAVY_PREEMPT_READY pid=778715
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=25 capturedBytes=0 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10026 capturedBytes=1430 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20027 capturedBytes=1430 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
PC_HEAVY_PSI_FINALIZATION pid=778715
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=27796 capturedBytes=1496 completedFiles=["lib/dream/dream-control-observations.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30028 capturedBytes=2607 completedFiles=["lib/dream/dream-control-observations.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=30308 capturedBytes=2607 completedFiles=["lib/dream/dream-control-observations.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none
Running as unit: papercusp-test-778715-mvcy41js-4.scope; invocation ID: 17d84230c5d6416bb0816b5301dab36a
TEST_FILE_STARTUP_TRACE {"pid":791384,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-forked","childPid":796200}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"start-sent","childPid":796200,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":796200,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"started-received","childPid":796200,"elapsedMs":521,"startupMs":520,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"stop-sent","childPid":796200,"elapsedMs":24344}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"stopped-received","childPid":796200,"elapsedMs":24346,"stopMs":2,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-signal","childPid":796200,"elapsedMs":24347,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-signal","childPid":796200,"elapsedMs":24849,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-disconnect","childPid":796200,"elapsedMs":24975}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-exit","childPid":796200,"elapsedMs":24977,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":793341,"event":"worker-close","childPid":796200,"elapsedMs":24977,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-775931-1792274741194951553 retryHandle=psi-recovery:pc-heavy-775931-1792274741194951553 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=2a070d598a testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-17T22:05:46.348Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/dream-control-observations.test.ts  [DIRTY +68/-2]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/dream-control-observations.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/dream/dream-control-observations.test.ts
  matched lib/dream/dream-control-observations.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/dream/dream-control-observations.test.ts (32 tests) 90ms

 Test Files  1 passed (1)
      Tests  32 passed (32)
   Start at  18:05:55
   Duration  24.41s (transform 17.56s, setup 758ms, import 22.93s, tests 90ms, environment 0ms)

TEST_FILE_PROVENANCE head=2a070d598a testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-17T22:06:22.764Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/dream-control-observations.test.ts  [DIRTY +68/-2]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/dream-control-observations.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=2a070d598a uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-17T22:05:46.348Z childSubstituted=0 skippedTests=0

