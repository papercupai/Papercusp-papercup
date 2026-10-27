---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/documents-dispatch-20261025-a/native-test.log"
updated_at: 1792938235080
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts

[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
COMMITTED_SOURCE substituted src/admin-test-runs-reporter.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2225046, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=2588 capturedBytes=1076 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/documents/search-freshness.integration.test.ts"}
PC_HEAVY_PREEMPT_READY pid=2225046
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=8 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10009 capturedBytes=1432 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2232069,\"event\":\"start-sent\",\"childPid\":2237064,\"elapsedMs\":1}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20009 capturedBytes=1897 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2232069,\"event\":\"started-received\",\"childPid\":2237064,\"elapsedMs\":1874,\"startupMs\":1873,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30010 capturedBytes=4626 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"finished\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts\",\"name\":\"P001 actual documents:search field projection > refuses malformed input and a disallowed dispatch role before returning documents\",\"state\":\"passed\"}"}
PC_HEAVY_PSI_FINALIZATION pid=2225046
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=31016 capturedBytes=4767 completedFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"\u001b[32m✓\u001b[39m lib/agent-tools/documents/search-freshness.integration.test.ts \u001b[2m(\u001b[22m\u001b[2m4 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 7200\u001b[2mms\u001b[22m\u001b[39m"}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=32886 capturedBytes=5861 completedFiles=["lib/agent-tools/documents/search-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-jS8Bb3/group-0.json"}
Running as unit: papercusp-test-2225046-mvnwwwgk-4.scope; invocation ID: 33bbc0fc889b42b78c9b661e352ef168
TEST_FILE_STARTUP_TRACE {"pid":2230879,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
COMMITTED_SOURCE substituted src/admin-test-runs-reporter.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2232069, entry node_modules/vitest/vitest.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
[org-template-global-setup] template ready key=8d6a8d8e25c05157 name=tmpl_8d6a8d8e25c05157 elapsedMs=163
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"worker-forked","childPid":2237064}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"start-sent","childPid":2237064,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2237064,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"started-received","childPid":2237064,"elapsedMs":1874,"startupMs":1873,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > compares four projected organization fields against separate canonical reads"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > compares four projected organization fields against separate canonical reads","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > observes an in-place update through dispatch and detects a retained old projected title"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > observes an in-place update through dispatch and detects a retained old projected title","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > projects changed privacy and removes revoked ACL results without a content revision change"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > projects changed privacy and removes revoked ACL results without a content revision change","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > refuses malformed input and a disallowed dispatch role before returning documents"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts","name":"P001 actual documents:search field projection > refuses malformed input and a disallowed dispatch role before returning documents","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"stop-sent","childPid":2237064,"elapsedMs":22466}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"stopped-received","childPid":2237064,"elapsedMs":22466,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"worker-signal","childPid":2237064,"elapsedMs":22467,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"worker-disconnect","childPid":2237064,"elapsedMs":22566}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"worker-exit","childPid":2237064,"elapsedMs":22567,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2232069,"event":"worker-close","childPid":2237064,"elapsedMs":22567,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2224589-1792937855312343648 retryHandle=psi-recovery:pc-heavy-2224589-1792937855312343648 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=23a1fa6f7c testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-25T14:17:38.054Z
  HEAD         : 23a1fa6f7c
  tested files : packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/documents/search-freshness.integration.test.ts
  matched lib/agent-tools/documents/search-freshness.integration.test.ts

[1m[30m[46m RUN [49m[39m[22m [36mv4.1.8 [39m[90m/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core[39m

 [32m✓[39m lib/agent-tools/documents/search-freshness.integration.test.ts [2m([22m[2m4 tests[22m[2m)[22m[33m 7200[2mms[22m[39m

[2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
[2m      Tests [22m [1m[32m4 passed[39m[22m[90m (4)[39m
[2m   Start at [22m 10:17:50
[2m   Duration [22m 28.58s[2m (transform 9.10s, setup 346ms, import 13.03s, tests 7.20s, environment 0ms)[22m

TEST_FILE_PROVENANCE head=23a1fa6f7c testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-25T14:18:20.353Z
  HEAD         : 23a1fa6f7c
  tested files : packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-freshness.integration.test.ts
TEST_FILE_CHILD_SUBSTITUTED count=2
  substituted esm src/admin-test-runs-reporter.ts  pid=2227247 entry=node_modules/vitest/vitest.mjs
  substituted esm src/admin-test-runs-reporter.ts  pid=2232069 entry=node_modules/vitest/vitest.mjs
  ⚠ a test-spawned node child ran the COMMITTED blob of these files (substituted) or refused them: any assertion that depends on that child measured HEAD, not your working tree.
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=23a1fa6f7c uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T14:17:38.054Z childSubstituted=2 skippedTests=0

