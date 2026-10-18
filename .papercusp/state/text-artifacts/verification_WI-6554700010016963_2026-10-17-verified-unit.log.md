---
rel_path: "verification/WI-6554700010016963/2026-10-17-verified-unit.log"
updated_at: 1792274874660
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.test.ts packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts

[pc-heavy] queued for a heavy slot (memory headroom: 6986 MiB free after 2 running reserve(s), 7168 MiB needed) — pid 398516, waiting up to 30s; other reserve 7 GiB (cold-start-max:5767MiB)
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=14 admittedCgroupMiB=2740 admissionId=pc-heavy-398516-1792274387839152236 retryHandle=psi-recovery:pc-heavy-398516-1792274387839152236 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.test.ts packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10014 capturedBytes=407 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20014 capturedBytes=850 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=20226 capturedBytes=850 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none
PC_HEAVY_PREEMPT_READY pid=404092
[db] target source=operator-env-file endpoint=localhost:5432
COMMITTED_SOURCE substituted packages/operator-core/lib/sync-resolver/table-to-query-names.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 404092, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=17 capturedBytes=0 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10017 capturedBytes=2698 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20018 capturedBytes=2698 completedFiles=[] pendingFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=27159 capturedBytes=2764 completedFiles=["lib/dream/dream-control-observations.test.ts"] pendingFiles=["lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30019 capturedBytes=3491 completedFiles=["lib/dream/dream-control-observations.test.ts"] pendingFiles=["lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=31304 capturedBytes=3560 completedFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts"] pendingFiles=["lib/sync-resolver/table-to-query-names.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
PC_HEAVY_PSI_FINALIZATION pid=404092
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=31325 capturedBytes=3980 completedFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=33113 capturedBytes=5337 completedFiles=["lib/dream/dream-control-observations.test.ts","lib/sync-resolver/learning-dream-metrics.test.ts","lib/sync-resolver/table-to-query-names.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none
Running as unit: papercusp-test-404092-mvcxwxsk-4.scope; invocation ID: 35a88ab1be814396913e8b0ce53c6525
TEST_FILE_STARTUP_TRACE {"pid":445074,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-forked","childPid":451019}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-forked","childPid":451061}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-forked","childPid":451099}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"start-sent","childPid":451019,"elapsedMs":31}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"start-sent","childPid":451061,"elapsedMs":14}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"start-sent","childPid":451099,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":451019,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":451061,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":451099,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"started-received","childPid":451019,"elapsedMs":572,"startupMs":540,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"started-received","childPid":451061,"elapsedMs":583,"startupMs":569,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"started-received","childPid":451099,"elapsedMs":585,"startupMs":583,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stop-sent","childPid":451019,"elapsedMs":22352}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stopped-received","childPid":451019,"elapsedMs":22353,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-signal","childPid":451019,"elapsedMs":22354,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-disconnect","childPid":451019,"elapsedMs":22771}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-exit","childPid":451019,"elapsedMs":22777,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-close","childPid":451019,"elapsedMs":22777,"code":null,"signal":"SIGTERM"}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stop-sent","childPid":451099,"elapsedMs":26466}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stopped-received","childPid":451099,"elapsedMs":26466,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-signal","childPid":451099,"elapsedMs":26466,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stop-sent","childPid":451061,"elapsedMs":26503}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"stopped-received","childPid":451061,"elapsedMs":26504,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-signal","childPid":451061,"elapsedMs":26504,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-disconnect","childPid":451061,"elapsedMs":26508}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-exit","childPid":451061,"elapsedMs":26510,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-close","childPid":451061,"elapsedMs":26510,"code":null,"signal":"SIGTERM"}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-disconnect","childPid":451099,"elapsedMs":26960}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-exit","childPid":451099,"elapsedMs":26960,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":447067,"event":"worker-close","childPid":451099,"elapsedMs":26960,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-398516-1792274387839152236 retryHandle=psi-recovery:pc-heavy-398516-1792274387839152236 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=3 groups=1
TEST_FILE_PROVENANCE head=2a070d598a testedPaths=3 uncommitted=2 unknown=0 phase=pre-run startedAt=2026-10-17T21:59:53.489Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/dream-control-observations.test.ts  [DIRTY +67/-1]
                 packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts  [DIRTY +15/-2]
                 packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 2 of 3 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/dream-control-observations.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/dream/dream-control-observations.test.ts
  requested lib/sync-resolver/learning-dream-metrics.test.ts
  requested lib/sync-resolver/table-to-query-names.test.ts
  matched lib/dream/dream-control-observations.test.ts
  matched lib/sync-resolver/learning-dream-metrics.test.ts
  matched lib/sync-resolver/table-to-query-names.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/dream/dream-control-observations.test.ts (32 tests) 99ms
 ✓ lib/sync-resolver/learning-dream-metrics.test.ts (7 tests) 29ms
 ✓ lib/sync-resolver/table-to-query-names.test.ts (44 tests) 47ms

 Test Files  3 passed (3)
      Tests  83 passed (83)
   Start at  18:00:25
   Duration  26.66s (transform 51.34s, setup 1.73s, import 71.60s, tests 174ms, environment 0ms)

TEST_FILE_PROVENANCE head=2a070d598a testedPaths=3 uncommitted=2 unknown=0 phase=post-run startedAt=2026-10-17T22:00:54.432Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/dream-control-observations.test.ts  [DIRTY +67/-1]
                 packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts  [DIRTY +15/-2]
                 packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 2 of 3 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/dream-control-observations.test.ts
TEST_FILE_RESULT requested=3 executed=3 matched=3 status=passed head=2a070d598a uncommittedPaths=2/3 provenance=stamped startedAt=2026-10-17T21:59:53.489Z childSubstituted=0 skippedTests=0

