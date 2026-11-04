---
rel_path: "security/security-p006-authors-tests-20261103T0530Z.log"
updated_at: 1793684372886
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs libs/generic/tauri-release-kit/src/signature.test.ts packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3383889, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 3383889, slots=1)
[pc-heavy] still queued (30s elapsed, pid 3383889, slots=1)
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=5 admittedCgroupMiB=17881 admissionId=pc-heavy-3383889-1793683849125535844 retryHandle=psi-recovery:pc-heavy-3383889-1793683849125535844 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3412973, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs libs/generic/tauri-release-kit/src/signature.test.ts packages/operator-core/lib/release/tauri-update-authorization-native.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-start","elapsedMs":1}
COMMITTED_SOURCE substituted scripts/lib/fs-mutex.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3413819, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="libs/generic/tauri-release-kit" elapsedMs=25 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-exit","elapsedMs":9830}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-close","elapsedMs":9879}
TEST_FILE_LIST_PROGRESS state=finished cwd="libs/generic/tauri-release-kit" elapsedMs=6305 capturedBytes=734 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"src/signature.test.ts"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"demand-sample-start","elapsedMs":9880}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"demand-sample-returned","elapsedMs":9880}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-returned","elapsedMs":9881}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"governed-returned","elapsedMs":9881}
PC_HEAVY_PREEMPT_READY pid=3413819
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="libs/generic/tauri-release-kit" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=["src/signature.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="libs/generic/tauri-release-kit" elapsedMs=10063 capturedBytes=409 completedFiles=[] pendingFiles=["src/signature.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3432120,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}"}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-forked","childPid":3446747}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"start-sent","childPid":3446747,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"started-received","childPid":3446747,"elapsedMs":1242,"startupMs":1240,"error":false}
TEST_FILE_PROGRESS state=running cwd="libs/generic/tauri-release-kit" elapsedMs=20064 capturedBytes=1450 completedFiles=[] pendingFiles=["src/signature.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3434322,\"event\":\"started-received\",\"childPid\":3446747,\"elapsedMs\":1242,\"startupMs\":1240,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real ED signatures, both key encodings and legacy/full envelopes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real ED signatures, both key encodings and legacy/full envelopes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real Ed signatures, both key encodings and legacy/full envelopes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real Ed signatures, both key encodings and legacy/full envelopes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects a changed trusted comment despite a valid artifact signature"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects a changed trusted comment despite a valid artifact signature","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > supports both public-key algorithm markers accepted by the native Minisign library"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > supports both public-key algorithm markers accepted by the native Minisign library","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects malformed keys before reading and rejects a different key even with the same key id"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects malformed keys before reading and rejects a different key even with the same key id","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real ED signatures and exit codes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real ED signatures and exit codes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real Ed signatures and exit codes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real Ed signatures and exit codes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > preserves authentic approval bytes through manifest construction, incremental merge and JSON transport"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > preserves authentic approval bytes through manifest construction, incremental merge and JSON transport","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > accepts authentic signatures over the exact artifact, reviewed metadata and current trust epoch"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > accepts authentic signatures over the exact artifact, reviewed metadata and current trust epoch","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual artifactSha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual artifactSha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual policySha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual policySha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual configurationSha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual configurationSha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual sourceRevision"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual sourceRevision","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual version"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual version","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual product"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual product","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual platform"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual platform","state":"passed"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"files-complete","elapsedMs":20892}
PC_HEAVY_PSI_FINALIZATION pid=3413819
TEST_FILE_PROGRESS state=file-completed cwd="libs/generic/tauri-release-kit" elapsedMs=20851 capturedBytes=11013 completedFiles=["src/signature.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ src/signature.test.ts (42 tests) 493ms"}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"stop-sent","childPid":3446747,"elapsedMs":2392}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"stopped-received","childPid":3446747,"elapsedMs":2393,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-signal","childPid":3446747,"elapsedMs":2394,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-signal","childPid":3446747,"elapsedMs":2896,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-disconnect","childPid":3446747,"elapsedMs":3852}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-exit","childPid":3446747,"elapsedMs":3854,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-close","childPid":3446747,"elapsedMs":3855,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-exit","elapsedMs":24767}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-close","elapsedMs":24825}
TEST_FILE_PROGRESS state=finished cwd="libs/generic/tauri-release-kit" elapsedMs=24783 capturedBytes=12128 completedFiles=["src/signature.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-gXt3mG/group-0.json"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"demand-sample-start","elapsedMs":24826}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"demand-sample-returned","elapsedMs":24826}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"child-returned","elapsedMs":24826}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"libs/generic/tauri-release-kit","phase":"governed-returned","elapsedMs":24826}
Running as unit: papercusp-test-3413819-mw092en7-4.scope; invocation ID: 291523fc6c8a4c3387ad9c53c1b9151d
TEST_FILE_STARTUP_TRACE {"pid":3432120,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-forked","childPid":3446747}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"start-sent","childPid":3446747,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3446747,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"started-received","childPid":3446747,"elapsedMs":1242,"startupMs":1240,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real ED signatures, both key encodings and legacy/full envelopes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real ED signatures, both key encodings and legacy/full envelopes","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real Ed signatures, both key encodings and legacy/full envelopes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > verifies real Ed signatures, both key encodings and legacy/full envelopes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects a changed trusted comment despite a valid artifact signature"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects a changed trusted comment despite a valid artifact signature","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > supports both public-key algorithm markers accepted by the native Minisign library"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > supports both public-key algorithm markers accepted by the native Minisign library","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects malformed keys before reading and rejects a different key even with the same key id"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > rejects malformed keys before reading and rejects a different key even with the same key id","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real ED signatures and exit codes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real ED signatures and exit codes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real Ed signatures and exit codes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"shared updater signature verifier > keeps the release CLI compatible with real Ed signatures and exit codes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > preserves authentic approval bytes through manifest construction, incremental merge and JSON transport"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > preserves authentic approval bytes through manifest construction, incremental merge and JSON transport","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > accepts authentic signatures over the exact artifact, reviewed metadata and current trust epoch"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > accepts authentic signatures over the exact artifact, reviewed metadata and current trust epoch","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual artifactSha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual artifactSha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual policySha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual policySha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual configurationSha256"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual configurationSha256","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual sourceRevision"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual sourceRevision","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual version"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual version","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual product"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual product","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual platform"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit/src/signature.test.ts","name":"exact independently approved update authorization > refuses an otherwise correctly signed update for different actual platform","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"stop-sent","childPid":3446747,"elapsedMs":2392}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"stopped-received","childPid":3446747,"elapsedMs":2393,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-signal","childPid":3446747,"elapsedMs":2394,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-signal","childPid":3446747,"elapsedMs":2896,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-disconnect","childPid":3446747,"elapsedMs":3852}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-exit","childPid":3446747,"elapsedMs":3854,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3434322,"event":"worker-close","childPid":3446747,"elapsedMs":3855,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":0}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":5431}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":5475}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=5439 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":5476}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":5476}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":5476}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":5476}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":0}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10013 capturedBytes=712 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3454919,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}"}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-forked","childPid":3463678}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"start-sent","childPid":3463678,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"started-received","childPid":3463678,"elapsedMs":4612,"startupMs":4610,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20014 capturedBytes=1442 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3454919,\"event\":\"started-received\",\"childPid\":3463678,\"elapsedMs\":4612,\"startupMs\":4610,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30016 capturedBytes=1442 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3454919,\"event\":\"started-received\",\"childPid\":3463678,\"elapsedMs\":4612,\"startupMs\":4610,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40018 capturedBytes=1442 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3454919,\"event\":\"started-received\",\"childPid\":3463678,\"elapsedMs\":4612,\"startupMs\":4610,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50024 capturedBytes=1718 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=60024 capturedBytes=1718 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"native consumer verifies real dual signatures, actual bytes, identities and current trust\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=70026 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=80025 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=90031 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=100034 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=110034 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=120035 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=130036 capturedBytes=2334 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"failed","errors":[{"message":"expected '\\nrunning 1 test\\nnative-extraction-r…' to contain 'native-extraction-refused: \"invalid a…'","stack":"AssertionError: expected '\\nrunning 1 test\\nnative-extraction-r…' to contain 'native-extraction-refused: \"invalid a…'\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts:279:58\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\n    at new Promise (<anonymous>)\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\n  "}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":131660}
PC_HEAVY_PSI_FINALIZATION pid=3413819
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=131569 capturedBytes=4535 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"❯ lib/release/tauri-update-authorization-native.test.ts (3 tests | 1 failed) 112101ms"}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"stop-sent","childPid":3463678,"elapsedMs":117924}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"stopped-received","childPid":3463678,"elapsedMs":117926,"stopMs":2,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-signal","childPid":3463678,"elapsedMs":117929,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-disconnect","childPid":3463678,"elapsedMs":118066}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-exit","childPid":3463678,"elapsedMs":118071,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-close","childPid":3463678,"elapsedMs":118072,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":134643}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":134681}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=134586 capturedBytes=8561 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-gXt3mG/group-1.json"}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":134683}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":134683}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":134684}
TEST_FILE_FINALIZATION {"pid":3413819,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":134684}
Running as unit: papercusp-test-3413819-mw09322k-8.scope; invocation ID: de0f9128cc8f4c50985946cdcfccf9dc
TEST_FILE_STARTUP_TRACE {"pid":3453613,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-forked","childPid":3463678}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"start-sent","childPid":3463678,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":3463678,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"started-received","childPid":3463678,"elapsedMs":4612,"startupMs":4610,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"failed","errors":[{"message":"expected '\\nrunning 1 test\\nnative-extraction-r…' to contain 'native-extraction-refused: \"invalid a…'","stack":"AssertionError: expected '\\nrunning 1 test\\nnative-extraction-r…' to contain 'native-extraction-refused: \"invalid a…'\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts:279:58\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\n    at new Promise (<anonymous>)\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\n  "}]}
TEST_FILE_HEARTBEAT completedCases=2
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"stop-sent","childPid":3463678,"elapsedMs":117924}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"stopped-received","childPid":3463678,"elapsedMs":117926,"stopMs":2,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-signal","childPid":3463678,"elapsedMs":117929,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-disconnect","childPid":3463678,"elapsedMs":118066}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-exit","childPid":3463678,"elapsedMs":118071,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3454919,"event":"worker-close","childPid":3463678,"elapsedMs":118072,"code":null,"signal":"SIGTERM"}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/release/tauri-update-authorization-native.test.ts > extracts actual build inputs from a compiled native image and refuses decoys or malformed sections
AssertionError: expected '\nrunning 1 test\nnative-extraction-r…' to contain 'native-extraction-refused: "invalid a…'

- Expected
+ Received

- native-extraction-refused: "invalid authors ["a","a"]"
+
+ running 1 test
+ native-extraction-refused: "decoy outside provenance section"
+ native-extraction-refused: "two provenance sections"
+ native-extraction-refused: "oversized section"
+ native-extraction-refused: "unknown field"
+ native-extraction-refused: "reordered fields"
+ native-extraction-refused: "duplicate field"
+ native-extraction-refused: "wrong schema"
+ native-extraction-refused: "wrong platform identity"
+ native-extraction-refused: "invalid source identity"
+ native-extraction-refused: "legacy single author"
+ native-extraction-refused: "missing authors"
+ native-extraction-refused: "invalid authors []"
+ native-extraction-refused: "invalid authors [\"a\",\"a\"]"
+ native-extraction-refused: "invalid authors [\"z\",\"a\"]"
+ native-extraction-refused: "invalid authors [\"bad author\"]"
+ native-extraction-refused: "invalid authors [\"a0\",\"a1\",\"a2\",\"a3\",\"a4\",\"a5\",\"a6\",\"a7\",\"a8\",\"a9\",\"a10\",\"a11\",\"a12\",\"a13\",\"a14\",\"a15\",\"a16\",\"a17\",\"a18\",\"a19\",\"a20\",\"a21\",\"a22\",\"a23\",\"a24\",\"a25\",\"a26\",\"a27\",\"a28\",\"a29\",\"a30\",\"a31\",\"a32\",\"a33\",\"a34\",\"a35\",\"a36\",\"a37\",\"a38\",\"a39\",\"a40\",\"a41\",\"a42\",\"a43\",\"a44\",\"a45\",\"a46\",\"a47\",\"a48\",\"a49\",\"a50\",\"a51\",\"a52\",\"a53\",\"a54\",\"a55\",\"a56\",\"a57\",\"a58\",\"a59\",\"a60\",\"a61\",\"a62\",\"a63\",\"a64\"]"
+ native-extraction-refused: "nonobject policy"
+ native-extraction-refused: "nonobject configuration"
+ native-extraction: actual compiled image and exact bytes
+ test tests::actual_compiled_image_and_negative_containers ... ok
+
+ test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.27s
+
+

 ❯ lib/release/tauri-update-authorization-native.test.ts:279:58
    277|     expect(result.status, String(result.error || result.stderr || resu…
    278|     expect(result.stdout).toContain('native-extraction: actual compile…
    279|     for (const [name] of variants) expect(result.stdout).toContain(`na…
       |                                                          ^
    280|   } finally {
    281|     rmSync(root, { recursive: true, force: true });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" name="extracts actual build inputs from a compiled native image and refuses decoys or malformed sections" message="AssertionError: expected '\\nrunning 1 test\\nnative-extraction-r…' to contain 'native-extraction-refused: \"invalid a…'\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts:279:58\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\n    at new Promise (<anonymous>)\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\n    at new Promise (<anonymous>)\n    at runWithTimeout (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2272:10)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2955:64"
TEST_FILE_FINALIZATION {"pid":3413819,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":3413819,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE_HEAD_MOVED from=b9b1369ffc to=9279288316; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3383889-1793683849125535844 retryHandle=psi-recovery:pc-heavy-3383889-1793683849125535844 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=2 groups=2
TEST_FILE_PROVENANCE head=b9b1369ffc testedPaths=2 uncommitted=2 unknown=0 phase=pre-run startedAt=2026-11-03T05:31:03.759Z
  HEAD         : b9b1369ffc
  tested files : libs/generic/tauri-release-kit/src/signature.test.ts  [DIRTY +49/-5 repo=libs/generic/tauri-release-kit repoHead=0325191205 superprojectPin=0325191205dd25c9b2ba09d57054135149168810 pointer=matched]
                 packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +43/-15]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 2 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git -C libs/generic/tauri-release-kit show <candidate-pin-for-libs/generic/tauri-release-kit>:src/signature.test.ts   # submodule: from the superproject, git status/show answer about the gitlink, not this file
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=libs/generic/tauri-release-kit config=vitest.config.ts
  requested src/signature.test.ts
  matched src/signature.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/libs/generic/tauri-release-kit

 ✓ src/signature.test.ts (42 tests) 493ms

 Test Files  1 passed (1)
      Tests  42 passed (42)
   Start at  00:31:32
   Duration  4.11s (transform 368ms, setup 580ms, import 49ms, tests 493ms, environment 0ms)

ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ❯ lib/release/tauri-update-authorization-native.test.ts (3 tests | 1 failed) 112101ms
   ✓ native consumer verifies real dual signatures, actual bytes, identities and current trust  20798ms
   × extracts actual build inputs from a compiled native image and refuses decoys or malformed sections 24937ms
   ✓ producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections  66332ms

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  00:31:57
   Duration  118.14s (transform 809ms, setup 1.05s, import 69ms, tests 112.10s, environment 0ms)

TEST_FILE_PROVENANCE head=9279288316 testedPaths=2 uncommitted=2 unknown=0 phase=post-run startedAt=2026-11-03T05:33:59.475Z
  HEAD         : 9279288316
  tested files : libs/generic/tauri-release-kit/src/signature.test.ts  [DIRTY +49/-5 repo=libs/generic/tauri-release-kit repoHead=0325191205 superprojectPin=0325191205dd25c9b2ba09d57054135149168810 pointer=matched]
                 packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +43/-15]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 2 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git -C libs/generic/tauri-release-kit show <candidate-pin-for-libs/generic/tauri-release-kit>:src/signature.test.ts   # submodule: from the superproject, git status/show answer about the gitlink, not this file
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_RESULT requested=2 executed=2 matched=2 status=failed head=b9b1369ffc uncommittedPaths=2/2 provenance=unknown startedAt=2026-11-03T05:31:03.759Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=0

