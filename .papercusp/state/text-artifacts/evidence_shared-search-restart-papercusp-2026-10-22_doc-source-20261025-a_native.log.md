---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/doc-source-20261025-a/native.log"
updated_at: 1792966078142
_body: "content"
---


[capability:bash] JOB PHASE: phase=unit-runner-started at=1792965839186

[capability:bash] JOB PHASE: phase=payload-spawn-requested at=1792965839188

[capability:bash] JOB PHASE: phase=payload-spawned at=1792965839192

[capability:bash] JOB PHASE: phase=payload-first-byte at=1792965839541

> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
COMMITTED_SOURCE substituted scripts/test-files.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2199822, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=2399 capturedBytes=776 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/search/doc-source-freshness.integration.test.ts"}
PC_HEAVY_PREEMPT_READY pid=2199822
[db] target source=operator-env-file endpoint=localhost:5432
COMMITTED_SOURCE substituted packages/operator-core/lib/consult/selection-policies.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2199822, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=16 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10016 capturedBytes=849 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"\u001b[1m\u001b[30m\u001b[46m RUN \u001b[49m\u001b[39m\u001b[22m \u001b[36mv4.1.8 \u001b[39m\u001b[90m/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core\u001b[39m"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20016 capturedBytes=1746 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30016 capturedBytes=1746 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40017 capturedBytes=1746 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50017 capturedBytes=3099 completedFiles=[] pendingFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"finished\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts\",\"name\":\"P001 — docs authority, section sync and changing reader scope > embedding: source changes, sync, candidates and retirement\",\"state\":\"passed\"}"}
PC_HEAVY_PSI_FINALIZATION pid=2199822
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=51092 capturedBytes=3242 completedFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"\u001b[32m✓\u001b[39m lib/agent-tools/search/doc-source-freshness.integration.test.ts \u001b[2m(\u001b[22m\u001b[2m2 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 16974\u001b[2mms\u001b[22m\u001b[39m"}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=53460 capturedBytes=4338 completedFiles=["lib/agent-tools/search/doc-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2209943,\"event\":\"worker-close\",\"childPid\":2222191,\"elapsedMs\":37131,\"code\":null,\"signal\":\"SIGTERM\"}"}
Running as unit: papercusp-test-2199822-mvodkonh-4.scope; invocation ID: 4bf93575032143ccb538b7b49c760db1
TEST_FILE_STARTUP_TRACE {"pid":2208825,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[org-template-global-setup] template ready key=e16fd6df1d391c96 name=tmpl_e16fd6df1d391c96 elapsedMs=254
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"worker-forked","childPid":2222191}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"start-sent","childPid":2222191,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2222191,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"started-received","childPid":2222191,"elapsedMs":489,"startupMs":487,"error":false}
(node:2222191) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts","name":"P001 — docs authority, section sync and changing reader scope > lexical: source changes, sync, candidates and retirement"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts","name":"P001 — docs authority, section sync and changing reader scope > lexical: source changes, sync, candidates and retirement","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts","name":"P001 — docs authority, section sync and changing reader scope > embedding: source changes, sync, candidates and retirement"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts","name":"P001 — docs authority, section sync and changing reader scope > embedding: source changes, sync, candidates and retirement","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"stop-sent","childPid":2222191,"elapsedMs":36712}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"stopped-received","childPid":2222191,"elapsedMs":36712,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"worker-signal","childPid":2222191,"elapsedMs":36713,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"worker-disconnect","childPid":2222191,"elapsedMs":37129}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"worker-exit","childPid":2222191,"elapsedMs":37131,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2209943,"event":"worker-close","childPid":2222191,"elapsedMs":37131,"code":null,"signal":"SIGTERM"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2198703-1792965840381491059 retryHandle=psi-recovery:pc-heavy-2198703-1792965840381491059 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=17cf04f31c testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-25T22:04:03.732Z
  HEAD         : 17cf04f31c
  tested files : packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts  [DIRTY +1/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/search/doc-source-freshness.integration.test.ts
  matched lib/agent-tools/search/doc-source-freshness.integration.test.ts

[1m[30m[46m RUN [49m[39m[22m [36mv4.1.8 [39m[90m/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core[39m

 [32m✓[39m lib/agent-tools/search/doc-source-freshness.integration.test.ts [2m([22m[2m2 tests[22m[2m)[22m[33m 16974[2mms[22m[39m

[2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
[2m      Tests [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m   Start at [22m 18:04:16
[2m   Duration [22m 45.25s[2m (transform 13.34s, setup 556ms, import 18.67s, tests 16.97s, environment 0ms)[22m

TEST_FILE_PROVENANCE head=17cf04f31c testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-25T22:05:04.659Z
  HEAD         : 17cf04f31c
  tested files : packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts  [DIRTY +1/-1]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=17cf04f31c uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T22:04:03.732Z childSubstituted=0 skippedTests=0

[capability:bash] JOB PHASE: phase=payload-closed at=1792965905294

[capability:bash] JOB END: status=completed exit=0 at 2026-10-25T22:05:05.294Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.

[capability:bash] JOB TIMING: spawn_requested_at=1792965839057 spawn_returned_at=1792965839108 client_spawned_at=1792965839112 first_pipe_byte_at=1792965839542 ended_at=1792965905318

[capability:bash] JOB END: status=completed exit=0 at 2026-10-25T22:05:05.318Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death.

