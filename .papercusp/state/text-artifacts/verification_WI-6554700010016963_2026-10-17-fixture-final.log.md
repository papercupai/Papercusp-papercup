---
rel_path: "verification/WI-6554700010016963/2026-10-17-fixture-final.log"
updated_at: 1792274874660
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts

[pc-heavy] queued for a heavy slot (memory headroom: 5233 MiB free after 3 running reserve(s), 7168 MiB needed) — pid 586093, waiting up to 30s; other reserve 7 GiB (cold-start-max:5767MiB)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10011 capturedBytes=709 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=12113 capturedBytes=760 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none
PC_HEAVY_PREEMPT_READY pid=590313
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=["lib/dream/r2-method-predicates.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10010 capturedBytes=797 completedFiles=[] pendingFiles=["lib/dream/r2-method-predicates.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending
PC_HEAVY_PSI_FINALIZATION pid=590313
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=19797 capturedBytes=1771 completedFiles=["lib/dream/r2-method-predicates.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20011 capturedBytes=2492 completedFiles=["lib/dream/r2-method-predicates.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=21475 capturedBytes=2743 completedFiles=["lib/dream/r2-method-predicates.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none
Running as unit: papercusp-test-590313-mvcy03m1-4.scope; invocation ID: ecf12d20f1ad4ef79c77d9a4b3201db3
TEST_FILE_STARTUP_TRACE {"pid":615537,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[baseline-schema-global-setup] stage=migration-apply status=waiting elapsedMs>=5000
[baseline-schema-global-setup] stage=migration-apply status=done elapsedMs=6916
[org-template-global-setup] template ready key=418f63cdc4f5e621 name=tmpl_418f63cdc4f5e621 elapsedMs=94
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"worker-forked","childPid":628904}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"start-sent","childPid":628904,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":628904,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"started-received","childPid":628904,"elapsedMs":551,"startupMs":550,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"stop-sent","childPid":628904,"elapsedMs":5281}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"stopped-received","childPid":628904,"elapsedMs":5282,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"worker-signal","childPid":628904,"elapsedMs":5283,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"worker-disconnect","childPid":628904,"elapsedMs":5398}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"worker-exit","childPid":628904,"elapsedMs":5399,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":616603,"event":"worker-close","childPid":628904,"elapsedMs":5399,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-586093-1792274545163450929 retryHandle=psi-recovery:pc-heavy-586093-1792274545163450929 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=2a070d598a testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-17T22:02:34.199Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/dream/r2-method-predicates.integration.test.ts
  matched lib/dream/r2-method-predicates.integration.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/dream/r2-method-predicates.integration.test.ts (8 tests) 2196ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  18:02:52
   Duration  15.35s (transform 645ms, setup 778ms, import 1.73s, tests 2.20s, environment 0ms)

TEST_FILE_PROVENANCE head=2a070d598a testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-17T22:03:09.924Z
  HEAD         : 2a070d598a
  tested files : packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=2a070d598a uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-17T22:02:34.199Z childSubstituted=0 skippedTests=0

