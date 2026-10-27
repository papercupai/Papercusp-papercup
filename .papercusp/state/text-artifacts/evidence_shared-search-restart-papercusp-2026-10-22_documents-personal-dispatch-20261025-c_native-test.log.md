---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/documents-personal-dispatch-20261025-c/native-test.log"
updated_at: 1792948990456
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts

[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=2711 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/documents/search-personal-freshness.integration.test.ts"}
PC_HEAVY_PREEMPT_READY pid=1891931
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=8 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-personal-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10009 capturedBytes=1594 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-personal-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":1897316,\"event\":\"started-received\",\"childPid\":1899844,\"elapsedMs\":479,\"startupMs\":478,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20010 capturedBytes=1594 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-personal-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":1897316,\"event\":\"started-received\",\"childPid\":1899844,\"elapsedMs\":479,\"startupMs\":478,\"error\":false}"}
PC_HEAVY_PSI_FINALIZATION pid=1891931
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=25721 capturedBytes=4617 completedFiles=["lib/agent-tools/documents/search-personal-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"\u001b[32m✓\u001b[39m lib/agent-tools/documents/search-personal-freshness.integration.test.ts \u001b[2m(\u001b[22m\u001b[2m4 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 1816\u001b[2mms\u001b[22m\u001b[39m"}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=27374 capturedBytes=5712 completedFiles=["lib/agent-tools/documents/search-personal-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":1897316,\"event\":\"worker-close\",\"childPid\":1899844,\"elapsedMs\":21213,\"code\":null,\"signal\":\"SIGTERM\"}"}
Running as unit: papercusp-test-1891931-mvo3fxoj-4.scope; invocation ID: cb5adf5a4ad4424495fd985009551d9f
TEST_FILE_STARTUP_TRACE {"pid":1896505,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[org-template-global-setup] template ready key=e16fd6df1d391c96 name=tmpl_e16fd6df1d391c96 elapsedMs=161
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"worker-forked","childPid":1899844}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"start-sent","childPid":1899844,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":1899844,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"started-received","childPid":1899844,"elapsedMs":479,"startupMs":478,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > compares stored fields and excludes competing foreign users and ungranted sources"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > compares stored fields and excludes competing foreign users and ungranted sources","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > observes an in-place personal update and detects a retained old title in the oracle"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > observes an in-place personal update and detects a retained old title in the oracle","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > refuses revoked or mismatched grants and a disabled vault without changing content revision"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > refuses revoked or mismatched grants and a disabled vault without changing content revision","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > projects changed privacy without changing the stored personal document revision"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts","name":"P001 actual documents:search personal field projection > projects changed privacy without changing the stored personal document revision","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"stop-sent","childPid":1899844,"elapsedMs":21071}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"stopped-received","childPid":1899844,"elapsedMs":21076,"stopMs":5,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"worker-signal","childPid":1899844,"elapsedMs":21077,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"worker-disconnect","childPid":1899844,"elapsedMs":21200}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"worker-exit","childPid":1899844,"elapsedMs":21213,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":1897316,"event":"worker-close","childPid":1899844,"elapsedMs":21213,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1891092-1792948825979455114 retryHandle=psi-recovery:pc-heavy-1891092-1792948825979455114 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=caf08cec13 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-25T17:20:29.215Z
  HEAD         : caf08cec13
  tested files : packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/documents/search-personal-freshness.integration.test.ts
  matched lib/agent-tools/documents/search-personal-freshness.integration.test.ts

[1m[30m[46m RUN [49m[39m[22m [36mv4.1.8 [39m[90m/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core[39m

 [32m✓[39m lib/agent-tools/documents/search-personal-freshness.integration.test.ts [2m([22m[2m4 tests[22m[2m)[22m[33m 1816[2mms[22m[39m

[2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
[2m      Tests [22m [1m[32m4 passed[39m[22m[90m (4)[39m
[2m   Start at [22m 13:20:36
[2m   Duration [22m 22.16s[2m (transform 13.31s, setup 498ms, import 18.26s, tests 1.82s, environment 0ms)[22m

TEST_FILE_PROVENANCE head=caf08cec13 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-25T17:21:00.596Z
  HEAD         : caf08cec13
  tested files : packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-personal-freshness.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=caf08cec13 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T17:20:29.215Z childSubstituted=0 skippedTests=0

