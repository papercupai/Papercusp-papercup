---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/memory-dispatch-auth-20261026-r1/test-router.log"
updated_at: 1793044018823
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 2421598, waiting up to 30s
[pc-heavy] still queued (16s elapsed, pid 2421598, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=22 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":7519}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":7615}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=5265 capturedBytes=781 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":7616}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":7617}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":7617}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":7617}
PC_HEAVY_PREEMPT_READY pid=2461322
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=18 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10018 capturedBytes=1545 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2479968,\"event\":\"started-received\",\"childPid\":2487458,\"elapsedMs\":686,\"startupMs\":684,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20023 capturedBytes=1545 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2479968,\"event\":\"started-received\",\"childPid\":2487458,\"elapsedMs\":686,\"startupMs\":684,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30025 capturedBytes=1545 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2479968,\"event\":\"started-received\",\"childPid\":2487458,\"elapsedMs\":686,\"startupMs\":684,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40028 capturedBytes=1697 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50028 capturedBytes=1697 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=60030 capturedBytes=1697 completedFiles=[] pendingFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
PC_HEAVY_PSI_FINALIZATION pid=2461322
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=65362 capturedBytes=6625 completedFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts (7 tests) 3122ms"}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":69556}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":69649}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=69530 capturedBytes=7840 completedFiles=["lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2479968,\"event\":\"worker-close\",\"childPid\":2487458,\"elapsedMs\":59195,\"code\":null,\"signal\":\"SIGKILL\"}"}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":69649}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":69650}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":69650}
TEST_FILE_FINALIZATION {"pid":2461322,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":69650}
Running as unit: papercusp-test-2461322-mvpnwd83-4.scope; invocation ID: 8d7f04c8e7ca449db35f002758e5e943
TEST_FILE_STARTUP_TRACE {"pid":2478197,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[org-template-global-setup] template ready key=5813f817e74fd48e name=tmpl_5813f817e74fd48e elapsedMs=235
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-forked","childPid":2487458}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"start-sent","childPid":2487458,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":2487458,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"started-received","childPid":2487458,"elapsedMs":686,"startupMs":684,"error":false}
(node:2487458) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > refuses invalid bearer, stored hash mismatch, missing grant and caller-supplied scope channels before recall"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > refuses invalid bearer, stored hash mismatch, missing grant and caller-supplied scope channels before recall","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid derives default user and workspace fan-out from persisted authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid derives default user and workspace fan-out from persisted authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback derives default user and workspace fan-out from persisted authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback derives default user and workspace fan-out from persisted authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid derives wearer identity and observes package/grant revocation"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid derives wearer identity and observes package/grant revocation","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback derives wearer identity and observes package/grant revocation"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback derives wearer identity and observes package/grant revocation","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid preserves hive and judge session scope through actual projected dispatch"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > hybrid preserves hive and judge session scope through actual projected dispatch","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback preserves hive and judge session scope through actual projected dispatch"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts","name":"P001 actual memory dispatch/auth/scope capture > lexical-fallback preserves hive and judge session scope through actual projected dispatch","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"stop-sent","childPid":2487458,"elapsedMs":57719}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"stopped-received","childPid":2487458,"elapsedMs":57720,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-signal","childPid":2487458,"elapsedMs":57720,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-disconnect","childPid":2487458,"elapsedMs":57839}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-signal","childPid":2487458,"elapsedMs":58222,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-exit","childPid":2487458,"elapsedMs":59194,"code":null,"signal":"SIGKILL","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2479968,"event":"worker-close","childPid":2487458,"elapsedMs":59195,"code":null,"signal":"SIGKILL"}
TEST_FILE_PROVENANCE_HEAD_MOVED from=d2571cc313 to=8501366a0a; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2421598-1793043643457216524 retryHandle=psi-recovery:pc-heavy-2421598-1793043643457216524 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=d2571cc313 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-26T19:40:50.480Z
  HEAD         : d2571cc313
  tested files : packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts
  matched lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts (7 tests) 3122ms
     ✓ hybrid derives default user and workspace fan-out from persisted authority  620ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  15:41:03
   Duration  59.73s (transform 41.39s, setup 745ms, import 53.14s, tests 3.12s, environment 0ms)

TEST_FILE_PROVENANCE head=8501366a0a testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-26T19:42:08.023Z
  HEAD         : 8501366a0a
  tested files : packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=d2571cc313 uncommittedPaths=1/1 provenance=unknown startedAt=2026-10-26T19:40:50.480Z childSubstituted=0 skippedTests=0

