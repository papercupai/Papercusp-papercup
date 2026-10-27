---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/documents-pot-dispatch-20261025-a/native-test.log"
updated_at: 1792945371986
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts

[pc-heavy] release gate is JUDGING (phase=materializing) — heavy slots clamped to 1 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3421155, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 3421155, slots=1)
[pc-heavy] still queued (30s elapsed, pid 3421155, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=2974 capturedBytes=779 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/documents/search-pot-freshness.integration.test.ts"}
PC_HEAVY_PREEMPT_READY pid=3455659
[db] target source=operator-env-file endpoint=localhost:5432
COMMITTED_SOURCE substituted src/index.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3455659, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted src/card-correlator.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3455659, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
COMMITTED_SOURCE substituted packages/agent-mcp/src/index.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3455659, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=16 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-pot-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10017 capturedBytes=1594 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-pot-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3469465,\"event\":\"started-received\",\"childPid\":3473075,\"elapsedMs\":367,\"startupMs\":366,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20018 capturedBytes=1594 completedFiles=[] pendingFiles=["lib/agent-tools/documents/search-pot-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3469465,\"event\":\"started-received\",\"childPid\":3473075,\"elapsedMs\":367,\"startupMs\":366,\"error\":false}"}
PC_HEAVY_PSI_FINALIZATION pid=3455659
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=27118 capturedBytes=4536 completedFiles=["lib/agent-tools/documents/search-pot-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"\u001b[32m✓\u001b[39m lib/agent-tools/documents/search-pot-freshness.integration.test.ts \u001b[2m(\u001b[22m\u001b[2m4 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 3136\u001b[2mms\u001b[22m\u001b[39m"}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=29612 capturedBytes=5763 completedFiles=["lib/agent-tools/documents/search-pot-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3469465,\"event\":\"worker-close\",\"childPid\":3473075,\"elapsedMs\":22683,\"code\":null,\"signal\":\"SIGTERM\"}"}
Running as unit: papercusp-test-3455659-mvo1ax04-4.scope; invocation ID: 90537e79ad6545dfa902703168b0aa54
TEST_FILE_STARTUP_TRACE {"pid":3468626,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[org-template-global-setup] template ready key=e16fd6df1d391c96 name=tmpl_e16fd6df1d391c96 elapsedMs=166
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-forked","childPid":3473075}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"start-sent","childPid":3473075,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":3473075,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"started-received","childPid":3473075,"elapsedMs":367,"startupMs":366,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > compares projected pot fields against canonical SQL and excludes a competing foreign pot"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > compares projected pot fields against canonical SQL and excludes a competing foreign pot","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > observes an in-place pot update and rejects a retained old projected title in the oracle"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > observes an in-place pot update and rejects a retained old projected title in the oracle","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > switches results with server-owned presence and refuses the leg after presence removal"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > switches results with server-owned presence and refuses the leg after presence removal","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > projects changed privacy without changing the stored pot document revision"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts","name":"P001 actual documents:search pot field projection > projects changed privacy without changing the stored pot document revision","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"stop-sent","childPid":3473075,"elapsedMs":22137}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"stopped-received","childPid":3473075,"elapsedMs":22138,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-signal","childPid":3473075,"elapsedMs":22138,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-signal","childPid":3473075,"elapsedMs":22639,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-disconnect","childPid":3473075,"elapsedMs":22682}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-exit","childPid":3473075,"elapsedMs":22683,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3469465,"event":"worker-close","childPid":3473075,"elapsedMs":22683,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3421155-1792945226154747941 retryHandle=psi-recovery:pc-heavy-3421155-1792945226154747941 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=5d98acfb8a testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-25T16:20:30.409Z
  HEAD         : 5d98acfb8a
  tested files : packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/documents/search-pot-freshness.integration.test.ts
  matched lib/agent-tools/documents/search-pot-freshness.integration.test.ts

[1m[30m[46m RUN [49m[39m[22m [36mv4.1.8 [39m[90m/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core[39m

 [32m✓[39m lib/agent-tools/documents/search-pot-freshness.integration.test.ts [2m([22m[2m4 tests[22m[2m)[22m[33m 3136[2mms[22m[39m

[2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
[2m      Tests [22m [1m[32m4 passed[39m[22m[90m (4)[39m
[2m   Start at [22m 12:20:43
[2m   Duration [22m 23.33s[2m (transform 12.76s, setup 402ms, import 18.21s, tests 3.14s, environment 0ms)[22m

TEST_FILE_PROVENANCE head=5d98acfb8a testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-25T16:21:09.575Z
  HEAD         : 5d98acfb8a
  tested files : packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/documents/search-pot-freshness.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=5d98acfb8a uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T16:20:30.409Z childSubstituted=0 skippedTests=0

