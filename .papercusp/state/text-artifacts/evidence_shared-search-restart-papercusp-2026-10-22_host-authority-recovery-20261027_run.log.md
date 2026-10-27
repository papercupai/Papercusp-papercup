---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/host-authority-recovery-20261027/run.log"
updated_at: 1793066155161
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 2363494, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 2363494, slots=1)
[pc-heavy] still queued (30s elapsed, pid 2363494, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":5977}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":6037}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=4672 capturedBytes=1088 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":6037}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":6037}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":6038}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":6038}
PC_HEAVY_PREEMPT_READY pid=2397703
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=15 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10015 capturedBytes=1846 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2409661,\"event\":\"started-received\",\"childPid\":2415996,\"elapsedMs\":696,\"startupMs\":695,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20015 capturedBytes=1998 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30016 capturedBytes=1998 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40018 capturedBytes=1998 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50018 capturedBytes=1998 completedFiles=[] pendingFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"(Use `node --trace-warnings ...` to show where the warning was created)"}
PC_HEAVY_PSI_FINALIZATION pid=2397703
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=55321 capturedBytes=6386 completedFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts (6 tests) 3571ms"}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":58243}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":58278}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=58216 capturedBytes=7615 completedFiles=["lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2409661,\"event\":\"worker-close\",\"childPid\":2415996,\"elapsedMs\":49107,\"code\":null,\"signal\":\"SIGKILL\"}"}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":58279}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":58279}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":58280}
TEST_FILE_FINALIZATION {"pid":2397703,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":58280}
Running as unit: papercusp-test-2397703-mvq17t1l-4.scope; invocation ID: 40f8e612b164460bacce87501777cf16
TEST_FILE_STARTUP_TRACE {"pid":2408298,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
COMMITTED_SOURCE substituted src/admin-test-runs-reporter.ts: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 2409661, entry node_modules/vitest/vitest.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
[org-template-global-setup] template ready key=9a5261243bc1dcc9 name=tmpl_9a5261243bc1dcc9 elapsedMs=296
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-forked","childPid":2415996}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"start-sent","childPid":2415996,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2415996,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"started-received","childPid":2415996,"elapsedMs":696,"startupMs":695,"error":false}
(node:2415996) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > admits a local SU file credential and refuses a wrong or remote credential before recall"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > admits a local SU file credential and refuses a wrong or remote credential before recall","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > clamps a real power-user HMAC to its workspace and refuses expiry, tampering and remote ingress"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > clamps a real power-user HMAC to its workspace and refuses expiry, tampering and remote ingress","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > uses persisted app grants and rejects missing capability, foreign scope and revocation before recall"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > uses persisted app grants and rejects missing capability, foreign scope and revocation before recall","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > verifies a real signed spawn and refuses a changed authority field before recall"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > verifies a real signed spawn and refuses a changed authority field before recall","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > re-reads a changed persisted power signing epoch without resetting its process cache"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > re-reads a changed persisted power signing epoch without resetting its process cache","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > re-reads a changed persisted spawn signing epoch without resetting its process cache"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts","name":"P001 actual additional host authority branches > re-reads a changed persisted spawn signing epoch without resetting its process cache","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"stop-sent","childPid":2415996,"elapsedMs":48259}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"stopped-received","childPid":2415996,"elapsedMs":48260,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-signal","childPid":2415996,"elapsedMs":48261,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-disconnect","childPid":2415996,"elapsedMs":48364}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-signal","childPid":2415996,"elapsedMs":48761,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-exit","childPid":2415996,"elapsedMs":49107,"code":null,"signal":"SIGKILL","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2409661,"event":"worker-close","childPid":2415996,"elapsedMs":49107,"code":null,"signal":"SIGKILL"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2363494-1793066015494652435 retryHandle=psi-recovery:pc-heavy-2363494-1793066015494652435 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=e4737dffc5 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-27T01:53:40.844Z
  HEAD         : e4737dffc5
  tested files : packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts  [DIRTY +32/-5]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts
  matched lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts (6 tests) 3571ms
     ✓ admits a local SU file credential and refuses a wrong or remote credential before recall  691ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  21:53:52
   Duration  50.16s (transform 31.76s, setup 556ms, import 43.41s, tests 3.57s, environment 0ms)

TEST_FILE_PROVENANCE head=e4737dffc5 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-27T01:54:45.368Z
  HEAD         : e4737dffc5
  tested files : packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts  [DIRTY +32/-5]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts
TEST_FILE_CHILD_SUBSTITUTED count=2
  substituted esm src/admin-test-runs-reporter.ts  pid=2404711 entry=node_modules/vitest/vitest.mjs
  substituted esm src/admin-test-runs-reporter.ts  pid=2409661 entry=node_modules/vitest/vitest.mjs
  ⚠ a test-spawned node child ran the COMMITTED blob of these files (substituted) or refused them: any assertion that depends on that child measured HEAD, not your working tree.
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=e4737dffc5 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-27T01:53:40.844Z childSubstituted=2 skippedTests=0

