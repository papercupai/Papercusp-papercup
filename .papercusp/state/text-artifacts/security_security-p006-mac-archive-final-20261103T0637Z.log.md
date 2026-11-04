---
rel_path: "security/security-p006-mac-archive-final-20261103T0637Z.log"
updated_at: 1793688420543
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts -- -t selects universal Mach-O

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 2844043, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 2844043, slots=1)
[pc-heavy] still queued (30s elapsed, pid 2844043, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts -- -t selects universal Mach-O (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":2}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=16 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":8285}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":8327}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=5789 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":8328}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":8328}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":8328}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":8329}
PC_HEAVY_PREEMPT_READY pid=2885554
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-forked","childPid":2907013}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"start-sent","childPid":2907013,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"started-received","childPid":2907013,"elapsedMs":882,"startupMs":879,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10012 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20012 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30013 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40014 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=50015 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=60018 capturedBytes=1440 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2903429,\"event\":\"started-received\",\"childPid\":2907013,\"elapsedMs\":882,\"startupMs\":879,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"failed","errors":[{"message":"     Locking 51 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling cfg-if v1.0.5\n   Compiling quote v1.0.47\n   Compiling unicode-ident v1.0.26\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling rustix v1.1.5\n   Compiling crc32fast v1.5.1\n   Compiling bitflags v2.13.2\n   Compiling serde v1.0.229\n   Compiling hashbrown v0.17.1\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling linux-raw-sys v0.12.1\n   Compiling powerfmt v0.2.0\n   Compiling simd-adler32 v0.3.10\n   Compiling time-core v0.1.9\n   Compiling object v0.37.3\n   Compiling deranged v0.5.8\n   Compiling adler2 v2.0.1\n   Compiling num-conv v0.2.2\n   Compiling serde_json v1.0.151\n   Compiling foldhash v0.1.5\n   Compiling cpufeatures v0.2.17\n   Compiling base64 v0.22.1\n   Compiling itoa v1.0.18\n   Compiling minisign-verify v0.2.5\n   Compiling hashbrown v0.15.5\n   Compiling miniz_oxide v0.8.9\n   Compiling generic-array v0.14.7\n   Compiling quick-xml v0.41.0\n   Compiling indexmap v2.14.2\n   Compiling time v0.3.55\n   Compiling flate2 v1.1.9\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling syn v3.0.9\n   Compiling filetime v0.2.29\n   Compiling xattr v1.6.1\n   Compiling tar v0.4.46\n   Compiling serde_derive v1.0.229\n   Compiling plist v1.10.0\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-ohVebV)\nwarning: struct `Metadata` is never constructed\n  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:16:12\n   |\n16 | pub struct Metadata {\n   |            ^^^^^^^^\n   |\n   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default\n\nwarning: struct `Envelope` is never constructed\n  --> /home/marsh-office/papercupai-workspace/p","stack":"AssertionError:      Locking 51 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling cfg-if v1.0.5\n   Compiling quote v1.0.47\n   Compiling unicode-ident v1.0.26\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling rustix v1.1.5\n   Compiling crc32fast v1.5.1\n   Compiling bitflags v2.13.2\n   Compiling serde v1.0.229\n   Compiling hashbrown v0.17.1\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling linux-raw-sys v0.12.1\n   Compiling powerfmt v0.2.0\n   Compiling simd-adler32 v0.3.10\n   Compiling time-core v0.1.9\n   Compiling object v0.37.3\n   Compiling deranged v0.5.8\n   Compiling adler2 v2.0.1\n   Compiling num-conv v0.2.2\n   Compiling serde_json v1.0.151\n   Compiling foldhash v0.1.5\n   Compiling cpufeatures v0.2.17\n   Compiling base64 v0.22.1\n   Compiling itoa"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":69040}
PC_HEAVY_PSI_FINALIZATION pid=2885554
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=68917 capturedBytes=6213 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"❯ lib/release/tauri-update-authorization-native.test.ts (4 tests | 1 failed | 3 skipped) 60816ms"}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"stop-sent","childPid":2907013,"elapsedMs":62418}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"stopped-received","childPid":2907013,"elapsedMs":62420,"stopMs":2,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-signal","childPid":2907013,"elapsedMs":62422,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-disconnect","childPid":2907013,"elapsedMs":62498}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-exit","childPid":2907013,"elapsedMs":62501,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-close","childPid":2907013,"elapsedMs":62504,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=70019 capturedBytes=14392 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-8HIEoB/group-0.json"}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":77942}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":78007}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=77884 capturedBytes=14392 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-8HIEoB/group-0.json"}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":78009}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":78009}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":78010}
TEST_FILE_FINALIZATION {"pid":2885554,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":78010}
Running as unit: papercusp-test-2885554-mw0bh069-4.scope; invocation ID: 756e2ab042ad42ae8c0910ffd6b20e11
TEST_FILE_STARTUP_TRACE {"pid":2901577,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-forked","childPid":2907013}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"start-sent","childPid":2907013,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":2907013,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"started-received","childPid":2907013,"elapsedMs":882,"startupMs":879,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths","state":"failed","errors":[{"message":"     Locking 51 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling cfg-if v1.0.5\n   Compiling quote v1.0.47\n   Compiling unicode-ident v1.0.26\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling rustix v1.1.5\n   Compiling crc32fast v1.5.1\n   Compiling bitflags v2.13.2\n   Compiling serde v1.0.229\n   Compiling hashbrown v0.17.1\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling linux-raw-sys v0.12.1\n   Compiling powerfmt v0.2.0\n   Compiling simd-adler32 v0.3.10\n   Compiling time-core v0.1.9\n   Compiling object v0.37.3\n   Compiling deranged v0.5.8\n   Compiling adler2 v2.0.1\n   Compiling num-conv v0.2.2\n   Compiling serde_json v1.0.151\n   Compiling foldhash v0.1.5\n   Compiling cpufeatures v0.2.17\n   Compiling base64 v0.22.1\n   Compiling itoa v1.0.18\n   Compiling minisign-verify v0.2.5\n   Compiling hashbrown v0.15.5\n   Compiling miniz_oxide v0.8.9\n   Compiling generic-array v0.14.7\n   Compiling quick-xml v0.41.0\n   Compiling indexmap v2.14.2\n   Compiling time v0.3.55\n   Compiling flate2 v1.1.9\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling syn v3.0.9\n   Compiling filetime v0.2.29\n   Compiling xattr v1.6.1\n   Compiling tar v0.4.46\n   Compiling serde_derive v1.0.229\n   Compiling plist v1.10.0\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-ohVebV)\nwarning: struct `Metadata` is never constructed\n  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:16:12\n   |\n16 | pub struct Metadata {\n   |            ^^^^^^^^\n   |\n   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default\n\nwarning: struct `Envelope` is never constructed\n  --> /home/marsh-office/papercupai-workspace/p","stack":"AssertionError:      Locking 51 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling cfg-if v1.0.5\n   Compiling quote v1.0.47\n   Compiling unicode-ident v1.0.26\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling rustix v1.1.5\n   Compiling crc32fast v1.5.1\n   Compiling bitflags v2.13.2\n   Compiling serde v1.0.229\n   Compiling hashbrown v0.17.1\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling linux-raw-sys v0.12.1\n   Compiling powerfmt v0.2.0\n   Compiling simd-adler32 v0.3.10\n   Compiling time-core v0.1.9\n   Compiling object v0.37.3\n   Compiling deranged v0.5.8\n   Compiling adler2 v2.0.1\n   Compiling num-conv v0.2.2\n   Compiling serde_json v1.0.151\n   Compiling foldhash v0.1.5\n   Compiling cpufeatures v0.2.17\n   Compiling base64 v0.22.1\n   Compiling itoa"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"stop-sent","childPid":2907013,"elapsedMs":62418}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"stopped-received","childPid":2907013,"elapsedMs":62420,"stopMs":2,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-signal","childPid":2907013,"elapsedMs":62422,"signal":"SIGTERM","sent":true}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/release/tauri-update-authorization-native.test.ts > selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths
AssertionError:      Locking 51 packages to latest compatible versions
      Adding base64 v0.22.1 (available: v0.23.1)
      Adding sha2 v0.10.9 (available: v0.11.1)
   Compiling version_check v0.9.5
   Compiling proc-macro2 v1.0.107
   Compiling cfg-if v1.0.5
   Compiling quote v1.0.47
   Compiling unicode-ident v1.0.26
   Compiling typenum v1.20.1
   Compiling serde_core v1.0.229
   Compiling libc v0.2.189
   Compiling memchr v2.8.3
   Compiling rustix v1.1.5
   Compiling crc32fast v1.5.1
   Compiling bitflags v2.13.2
   Compiling serde v1.0.229
   Compiling hashbrown v0.17.1
   Compiling zmij v1.0.23
   Compiling equivalent v1.0.2
   Compiling linux-raw-sys v0.12.1
   Compiling powerfmt v0.2.0
   Compiling simd-adler32 v0.3.10
   Compiling time-core v0.1.9
   Compiling object v0.37.3
   Compiling deranged v0.5.8
   Compiling adler2 v2.0.1
   Compiling num-conv v0.2.2
   Compiling serde_json v1.0.151
   Compiling foldhash v0.1.5
   Compiling cpufeatures v0.2.17
   Compiling base64 v0.22.1
   Compiling itoa v1.0.18
   Compiling minisign-verify v0.2.5
   Compiling hashbrown v0.15.5
   Compiling miniz_oxide v0.8.9
   Compiling generic-array v0.14.7
   Compiling quick-xml v0.41.0
   Compiling indexmap v2.14.2
   Compiling time v0.3.55
   Compiling flate2 v1.1.9
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.7
   Compiling digest v0.10.7
   Compiling sha2 v0.10.9
   Compiling syn v3.0.9
   Compiling filetime v0.2.29
   Compiling xattr v1.6.1
   Compiling tar v0.4.46
   Compiling serde_derive v1.0.229
   Compiling plist v1.10.0
   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-ohVebV)
warning: struct `Metadata` is never constructed
  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:16:12
   |
16 | pub struct Metadata {
   |            ^^^^^^^^
   |
   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: struct `Envelope` is never constructed
  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:38:12
   |
38 | pub struct Envelope {
   |            ^^^^^^^^

warning: function `read_current_trust` is never used
  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:69:8
   |
69 | pub fn read_current_trust() -> Result<Trust, String> {
   |        ^^^^^^^^^^^^^^^^^^

warning: fields `policy`, `configuration`, and `source_revision` are never read
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:368:9
    |
366 | pub struct Candidate<'a> {
    |            --------- fields in this struct
367 |     pub artifact: &'a [u8],
368 |     pub policy: &'a [u8],
    |         ^^^^^^
369 |     pub configuration: &'a [u8],
    |         ^^^^^^^^^^^^^
370 |     pub source_revision: &'a str,
    |         ^^^^^^^^^^^^^^^

warning: struct `AuthorizedUpdate` is never constructed
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:731:12
    |
731 | pub struct AuthorizedUpdate {
    |            ^^^^^^^^^^^^^^^^

warning: method `metadata` is never used
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:736:12
    |
735 | impl AuthorizedUpdate {
    | --------------------- method in this implementation
736 |     pub fn metadata(&self) -> &Metadata {
    |            ^^^^^^^^

warning: function `signature` is never used
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:796:4
    |
796 | fn signature(value: &str) -> Result<Signature, String> {
    |    ^^^^^^^^^

warning: function `select` is never used
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:808:4
    |
808 | fn select<'a>(keys: &'a [TrustedKey], id: &str, epoch: u64) -> Result<&'a TrustedKey, String> {
    |    ^^^^^^

warning: function `verify` is never used
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:817:8
    |
817 | pub fn verify(
    |        ^^^^^^

warning: function `read_current` is never used
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:120:19
    |
120 |     pub(super) fn read_current() -> Result<Trust, String> {
    |                   ^^^^^^^^^^^^

warning: `update-universal-native-regression` (lib test) generated 10 warnings
    Finished `test` profile [unoptimized + debuginfo] target(s) in 59.94s
     Running unittests driver.rs (/tmp/pcv/tauri-update-universal-ohVebV/target/debug/deps/update_universal_native_regression-579fae91dea81ff9)

thread 'tests::candidate_mac_archive_bounds_and_gzip_integrity' (2963864) panicked at driver.rs:126:35:
called `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: "paths in archives must have at least one component when setting link name for " }
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

thread 'tests::candidate_mac_bundle_main_and_archive_binding' (2963866) panicked at driver.rs:126:35:
called `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: "paths in archives must have at least one component when setting link name for " }

thread 'tests::candidate_mac_bundle_refuses_identity_and_namespace_ambiguity' (2963868) panicked at driver.rs:126:35:
called `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: "paths in archives must have at least one component when setting link name for " }
error: test failed, to rerun pass `--lib`
: expected 101 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 101

 ❯ lib/release/tauri-update-authorization-native.test.ts:540:83
    538|     const result = spawnSync('cargo', ['test', '--offline', '--manifes…
    539|       { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CAR…
    540|     expect(result.status, String(result.error || result.stderr || resu…
       |                                                                                   ^
    541|     expect(result.stdout).toContain('native-universal: both table widt…
    542|     expect(result.stdout).toContain('native-mac-archive: XML/binary pl…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-disconnect","childPid":2907013,"elapsedMs":62498}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-exit","childPid":2907013,"elapsedMs":62501,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2903429,"event":"worker-close","childPid":2907013,"elapsedMs":62504,"code":null,"signal":"SIGTERM"}
TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" name="selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths" message="AssertionError:      Locking 51 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling cfg-if v1.0.5\n   Compiling quote v1.0.47\n   Compiling unicode-ident v1.0.26\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling rustix v1.1.5\n   Compiling crc32fast v1.5.1\n   Compiling bitflags v2.13.2\n   Compiling serde v1.0.229\n   Compiling hashbrown v0.17.1\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling linux-raw-sys v0.12.1\n   Compiling powerfmt v0.2.0\n   Compiling simd-adler32 v0.3.10\n   Compiling time-core v0.1.9\n   Compiling object v0.37.3\n   Compiling deranged v0.5.8\n   Compiling adler2 v2.0.1\n   Compiling num-conv v0.2.2\n   Compiling serde_json v1.0.151\n   Compiling foldhash v0.1.5\n   Compiling cpufeatures v0.2.17\n   Compiling base64 v0.22.1\n   Compiling itoa v1.0.18\n   Compiling minisign-verify v0.2.5\n   Compiling hashbrown v0.15.5\n   Compiling miniz_oxide v0.8.9\n   Compiling generic-array v0.14.7\n   Compiling quick-xml v0.41.0\n   Compiling indexmap v2.14.2\n   Compiling time v0.3.55\n   Compiling flate2 v1.1.9\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling syn v3.0.9\n   Compiling filetime v0.2.29\n   Compiling xattr v1.6.1\n   Compiling tar v0.4.46\n   Compiling serde_derive v1.0.229\n   Compiling plist v1.10.0\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-ohVebV)\nwarning: struct `Metadata` is never constructed\n  --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:16:12\n   |\n16 | pub struct Metadata {\n   |            ^^^^^^^^\n   |\n   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default\n\nwarning: struct `Envelope` is …"
TEST_FILE_FINALIZATION {"pid":2885554,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":2885554,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2844043-1793687899860952472 retryHandle=psi-recovery:pc-heavy-2844043-1793687899860952472 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=38efe886f2 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T06:38:25.554Z
  HEAD         : 38efe886f2
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +4/-2]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ❯ lib/release/tauri-update-authorization-native.test.ts (4 tests | 1 failed | 3 skipped) 60816ms
   ↓ native consumer verifies real dual signatures, actual bytes, identities and current trust
   ↓ extracts actual build inputs from a compiled native image and refuses decoys or malformed sections
   × selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths 60807ms
   ↓ producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections

 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  01:38:40
   Duration  62.48s (transform 389ms, setup 584ms, import 68ms, tests 60.82s, environment 0ms)

TEST_FILE_PROVENANCE head=38efe886f2 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-03T06:39:52.210Z
  HEAD         : 38efe886f2
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +4/-2]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_SKIPPED name="native consumer verifies real dual signatures, actual bytes, identities and current trust" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="extracts actual build inputs from a compiled native image and refuses decoys or malformed sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=38efe886f2 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T06:38:25.554Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=3

