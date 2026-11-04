---
rel_path: "security/security-p006-universal-20261103T0606Z.log"
updated_at: 1793686254215
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=selects universal|extracts actual build inputs

[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 908878, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 908878, slots=1)
[pc-heavy] still queued (30s elapsed, pid 908878, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern=selects universal|extracts actual build inputs (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":5830}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":5897}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=4025 capturedBytes=763 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/release/tauri-update-authorization-native.test.ts"}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":5897}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":5898}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":5898}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":5898}
PC_HEAVY_PREEMPT_READY pid=936023
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"governed-start","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-start","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-forked","childPid":950755}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"start-sent","childPid":950755,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"started-received","childPid":950755,"elapsedMs":775,"startupMs":774,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10014 capturedBytes=1430 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":947353,\"event\":\"started-received\",\"childPid\":950755,\"elapsedMs\":775,\"startupMs\":774,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20015 capturedBytes=1430 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":947353,\"event\":\"started-received\",\"childPid\":950755,\"elapsedMs\":775,\"startupMs\":774,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30017 capturedBytes=1430 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":947353,\"event\":\"started-received\",\"childPid\":950755,\"elapsedMs\":775,\"startupMs\":774,\"error\":false}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40018 capturedBytes=2028 completedFiles=[] pendingFiles=["lib/release/tauri-update-authorization-native.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts\",\"name\":\"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"failed","errors":[{"message":"     Locking 24 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling unicode-ident v1.0.26\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling zmij v1.0.23\n   Compiling memchr v2.8.3\n   Compiling libc v0.2.189\n   Compiling serde_json v1.0.151\n   Compiling object v0.37.3\n   Compiling serde v1.0.229\n   Compiling cfg-if v1.0.5\n   Compiling cpufeatures v0.2.17\n   Compiling itoa v1.0.18\n   Compiling base64 v0.22.1\n   Compiling minisign-verify v0.2.5\n   Compiling generic-array v0.14.7\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling syn v3.0.9\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`\n    = note: required for `MachHeader64<_>` to implement `MachHeader`\nhelp: consider giving `image` an explicit type, where the type for type parameter `Endian` is specified\n    |\n461 |         let image: Ma","stack":"AssertionError:      Locking 24 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling unicode-ident v1.0.26\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling zmij v1.0.23\n   Compiling memchr v2.8.3\n   Compiling libc v0.2.189\n   Compiling serde_json v1.0.151\n   Compiling object v0.37.3\n   Compiling serde v1.0.229\n   Compiling cfg-if v1.0.5\n   Compiling cpufeatures v0.2.17\n   Compiling itoa v1.0.18\n   Compiling base64 v0.22.1\n   Compiling minisign-verify v0.2.5\n   Compiling generic-array v0.14.7\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling syn v3.0.9\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)\nerror[E0283]: type annotations nee"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O inputs by validated slices and refuses alternate executable identities"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O inputs by validated slices and refuses alternate executable identities","state":"failed","errors":[{"message":"     Locking 30 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling unicode-ident v1.0.26\n   Compiling serde_core v1.0.229\n   Compiling crc32fast v1.5.1\n   Compiling cfg-if v1.0.5\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling foldhash v0.1.5\n   Compiling serde v1.0.229\n   Compiling object v0.37.3\n   Compiling hashbrown v0.17.1\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling serde_json v1.0.151\n   Compiling itoa v1.0.18\n   Compiling cpufeatures v0.2.17\n   Compiling minisign-verify v0.2.5\n   Compiling base64 v0.22.1\n   Compiling hashbrown v0.15.5\n   Compiling generic-array v0.14.7\n   Compiling indexmap v2.14.2\n   Compiling syn v3.0.9\n   Compiling crypto-common v0.1.7\n   Compiling block-buffer v0.10.4\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-BU38Pi)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`\n    = note: required for","stack":"AssertionError:      Locking 30 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling unicode-ident v1.0.26\n   Compiling serde_core v1.0.229\n   Compiling crc32fast v1.5.1\n   Compiling cfg-if v1.0.5\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling foldhash v0.1.5\n   Compiling serde v1.0.229\n   Compiling object v0.37.3\n   Compiling hashbrown v0.17.1\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling serde_json v1.0.151\n   Compiling itoa v1.0.18\n   Compiling cpufeatures v0.2.17\n   Compiling minisign-verify v0.2.5\n   Compiling base64 v0.22.1\n   Compiling hashbrown v0.15.5\n   Compiling generic-array v0.14.7\n   Compiling indexmap v2.14.2\n   Compiling syn v3.0.9\n   Compiling crypto-common v0.1.7\n   Compiling block-buffer v0.10.4\n   Compiling digest v0.10.7\n   Compil"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"files-complete","elapsedMs":43624}
PC_HEAVY_PSI_FINALIZATION pid=936023
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=43595 capturedBytes=9680 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"❯ lib/release/tauri-update-authorization-native.test.ts (4 tests | 2 failed | 2 skipped) 35879ms"}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"stop-sent","childPid":950755,"elapsedMs":37551}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"stopped-received","childPid":950755,"elapsedMs":37552,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-signal","childPid":950755,"elapsedMs":37553,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-disconnect","childPid":950755,"elapsedMs":37711}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-exit","childPid":950755,"elapsedMs":37715,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-close","childPid":950755,"elapsedMs":37716,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-exit","elapsedMs":47804}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-close","elapsedMs":47878}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=47849 capturedBytes=17922 completedFiles=["lib/release/tauri-update-authorization-native.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":947353,\"event\":\"worker-close\",\"childPid\":950755,\"elapsedMs\":37716,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"demand-sample-start","elapsedMs":47878}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"demand-sample-returned","elapsedMs":47879}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"child-returned","elapsedMs":47879}
TEST_FILE_FINALIZATION {"pid":936023,"cwd":"packages/operator-core","phase":"governed-returned","elapsedMs":47879}
Running as unit: papercusp-test-936023-mw0aar7j-4.scope; invocation ID: 0d02da097342401781078521b2d3e145
TEST_FILE_STARTUP_TRACE {"pid":946343,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-forked","childPid":950755}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"start-sent","childPid":950755,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":950755,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"started-received","childPid":950755,"elapsedMs":775,"startupMs":774,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"native consumer verifies real dual signatures, actual bytes, identities and current trust"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"extracts actual build inputs from a compiled native image and refuses decoys or malformed sections","state":"failed","errors":[{"message":"     Locking 24 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling unicode-ident v1.0.26\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling zmij v1.0.23\n   Compiling memchr v2.8.3\n   Compiling libc v0.2.189\n   Compiling serde_json v1.0.151\n   Compiling object v0.37.3\n   Compiling serde v1.0.229\n   Compiling cfg-if v1.0.5\n   Compiling cpufeatures v0.2.17\n   Compiling itoa v1.0.18\n   Compiling base64 v0.22.1\n   Compiling minisign-verify v0.2.5\n   Compiling generic-array v0.14.7\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling syn v3.0.9\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`\n    = note: required for `MachHeader64<_>` to implement `MachHeader`\nhelp: consider giving `image` an explicit type, where the type for type parameter `Endian` is specified\n    |\n461 |         let image: Ma","stack":"AssertionError:      Locking 24 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling unicode-ident v1.0.26\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling zmij v1.0.23\n   Compiling memchr v2.8.3\n   Compiling libc v0.2.189\n   Compiling serde_json v1.0.151\n   Compiling object v0.37.3\n   Compiling serde v1.0.229\n   Compiling cfg-if v1.0.5\n   Compiling cpufeatures v0.2.17\n   Compiling itoa v1.0.18\n   Compiling base64 v0.22.1\n   Compiling minisign-verify v0.2.5\n   Compiling generic-array v0.14.7\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling syn v3.0.9\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)\nerror[E0283]: type annotations nee"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O inputs by validated slices and refuses alternate executable identities"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"selects universal Mach-O inputs by validated slices and refuses alternate executable identities","state":"failed","errors":[{"message":"     Locking 30 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling unicode-ident v1.0.26\n   Compiling serde_core v1.0.229\n   Compiling crc32fast v1.5.1\n   Compiling cfg-if v1.0.5\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling foldhash v0.1.5\n   Compiling serde v1.0.229\n   Compiling object v0.37.3\n   Compiling hashbrown v0.17.1\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling serde_json v1.0.151\n   Compiling itoa v1.0.18\n   Compiling cpufeatures v0.2.17\n   Compiling minisign-verify v0.2.5\n   Compiling base64 v0.22.1\n   Compiling hashbrown v0.15.5\n   Compiling generic-array v0.14.7\n   Compiling indexmap v2.14.2\n   Compiling syn v3.0.9\n   Compiling crypto-common v0.1.7\n   Compiling block-buffer v0.10.4\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-BU38Pi)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`\n    = note: required for","stack":"AssertionError:      Locking 30 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling unicode-ident v1.0.26\n   Compiling serde_core v1.0.229\n   Compiling crc32fast v1.5.1\n   Compiling cfg-if v1.0.5\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling foldhash v0.1.5\n   Compiling serde v1.0.229\n   Compiling object v0.37.3\n   Compiling hashbrown v0.17.1\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling serde_json v1.0.151\n   Compiling itoa v1.0.18\n   Compiling cpufeatures v0.2.17\n   Compiling minisign-verify v0.2.5\n   Compiling base64 v0.22.1\n   Compiling hashbrown v0.15.5\n   Compiling generic-array v0.14.7\n   Compiling indexmap v2.14.2\n   Compiling syn v3.0.9\n   Compiling crypto-common v0.1.7\n   Compiling block-buffer v0.10.4\n   Compiling digest v0.10.7\n   Compil"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts","name":"producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections"}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"stop-sent","childPid":950755,"elapsedMs":37551}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"stopped-received","childPid":950755,"elapsedMs":37552,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-signal","childPid":950755,"elapsedMs":37553,"signal":"SIGTERM","sent":true}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/release/tauri-update-authorization-native.test.ts > extracts actual build inputs from a compiled native image and refuses decoys or malformed sections
AssertionError:      Locking 24 packages to latest compatible versions
      Adding base64 v0.22.1 (available: v0.23.1)
      Adding sha2 v0.10.9 (available: v0.11.1)
   Compiling version_check v0.9.5
   Compiling proc-macro2 v1.0.107
   Compiling unicode-ident v1.0.26
   Compiling quote v1.0.47
   Compiling typenum v1.20.1
   Compiling serde_core v1.0.229
   Compiling zmij v1.0.23
   Compiling memchr v2.8.3
   Compiling libc v0.2.189
   Compiling serde_json v1.0.151
   Compiling object v0.37.3
   Compiling serde v1.0.229
   Compiling cfg-if v1.0.5
   Compiling cpufeatures v0.2.17
   Compiling itoa v1.0.18
   Compiling base64 v0.22.1
   Compiling minisign-verify v0.2.5
   Compiling generic-array v0.14.7
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.7
   Compiling digest v0.10.7
   Compiling syn v3.0.9
   Compiling sha2 v0.10.9
   Compiling serde_derive v1.0.229
   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)
error[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13
    |
461 |         let image = MachOFile64::parse(bytes).map_err(|_| "universal candidate slice is not thin Mach-O")?;
    |             ^^^^^   ----------- type must be known at this point
    |
    = note: the type must implement `Endian`
help: the following types implement trait `Endian`
   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1
    |
299 | impl Endian for Endianness {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`
...
326 | impl Endian for LittleEndian {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`
...
353 | impl Endian for BigEndian {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`
    = note: required for `MachHeader64<_>` to implement `MachHeader`
help: consider giving `image` an explicit type, where the type for type parameter `Endian` is specified
    |
461 |         let image: MachOFile<'_, MachHeader64<Endian>, &_> = MachOFile64::parse(bytes).map_err(|_| "universal candidate slice is not thin Mach-O")?;
    |                  +++++++++++++++++++++++++++++++++++++++++

For more information about this error, try `rustc --explain E0283`.
error: could not compile `update-candidate-native-regression` (lib test) due to 1 previous error
: expected 101 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 101

 ❯ lib/release/tauri-update-authorization-native.test.ts:277:83
    275|     const result = spawnSync('cargo', ['test', '--offline', '--manifes…
    276|       { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CAR…
    277|     expect(result.status, String(result.error || result.stderr || resu…
       |                                                                                   ^
    278|     expect(result.stdout).toContain('native-extraction: actual compile…
    279|     for (const [name] of variants) expect(result.stdout).toContain(`na…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  lib/release/tauri-update-authorization-native.test.ts > selects universal Mach-O inputs by validated slices and refuses alternate executable identities
AssertionError:      Locking 30 packages to latest compatible versions
      Adding base64 v0.22.1 (available: v0.23.1)
      Adding sha2 v0.10.9 (available: v0.11.1)
   Compiling version_check v0.9.5
   Compiling proc-macro2 v1.0.107
   Compiling quote v1.0.47
   Compiling typenum v1.20.1
   Compiling unicode-ident v1.0.26
   Compiling serde_core v1.0.229
   Compiling crc32fast v1.5.1
   Compiling cfg-if v1.0.5
   Compiling zmij v1.0.23
   Compiling equivalent v1.0.2
   Compiling foldhash v0.1.5
   Compiling serde v1.0.229
   Compiling object v0.37.3
   Compiling hashbrown v0.17.1
   Compiling libc v0.2.189
   Compiling memchr v2.8.3
   Compiling serde_json v1.0.151
   Compiling itoa v1.0.18
   Compiling cpufeatures v0.2.17
   Compiling minisign-verify v0.2.5
   Compiling base64 v0.22.1
   Compiling hashbrown v0.15.5
   Compiling generic-array v0.14.7
   Compiling indexmap v2.14.2
   Compiling syn v3.0.9
   Compiling crypto-common v0.1.7
   Compiling block-buffer v0.10.4
   Compiling digest v0.10.7
   Compiling sha2 v0.10.9
   Compiling serde_derive v1.0.229
   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-BU38Pi)
error[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`
   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13
    |
461 |         let image = MachOFile64::parse(bytes).map_err(|_| "universal candidate slice is not thin Mach-O")?;
    |             ^^^^^   ----------- type must be known at this point
    |
    = note: the type must implement `Endian`
help: the following types implement trait `Endian`
   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1
    |
299 | impl Endian for Endianness {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`
...
326 | impl Endian for LittleEndian {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`
...
353 | impl Endian for BigEndian {
    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`
    = note: required for `MachHeader64<_>` to implement `MachHeader`
help: consider giving `image` an explicit type, where the type for type parameter `Endian` is specified
    |
461 |         let image: MachOFile<'_, MachHeader64<Endian>, &_> = MachOFile64::parse(bytes).map_err(|_| "universal candidate slice is not thin Mach-O")?;
    |                  +++++++++++++++++++++++++++++++++++++++++

For more information about this error, try `rustc --explain E0283`.
error: could not compile `update-universal-native-regression` (lib test) due to 1 previous error
: expected 101 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 101

 ❯ lib/release/tauri-update-authorization-native.test.ts:401:83
    399|     const result = spawnSync('cargo', ['test', '--offline', '--manifes…
    400|       { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CAR…
    401|     expect(result.status, String(result.error || result.stderr || resu…
       |                                                                                   ^
    402|     expect(result.stdout).toContain('native-universal: both table widt…
    403|   } finally {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-disconnect","childPid":950755,"elapsedMs":37711}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-exit","childPid":950755,"elapsedMs":37715,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":947353,"event":"worker-close","childPid":950755,"elapsedMs":37716,"code":null,"signal":"SIGTERM"}
TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" name="extracts actual build inputs from a compiled native image and refuses decoys or malformed sections" message="AssertionError:      Locking 24 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling unicode-ident v1.0.26\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling serde_core v1.0.229\n   Compiling zmij v1.0.23\n   Compiling memchr v2.8.3\n   Compiling libc v0.2.189\n   Compiling serde_json v1.0.151\n   Compiling object v0.37.3\n   Compiling serde v1.0.229\n   Compiling cfg-if v1.0.5\n   Compiling cpufeatures v0.2.17\n   Compiling itoa v1.0.18\n   Compiling base64 v0.22.1\n   Compiling minisign-verify v0.2.5\n   Compiling generic-array v0.14.7\n   Compiling block-buffer v0.10.4\n   Compiling crypto-common v0.1.7\n   Compiling digest v0.10.7\n   Compiling syn v3.0.9\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-candidate-native-regression v0.0.0 (/tmp/pcv/tauri-update-candidate-mNFzK2)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^ `BigEndian`\n    = note: required for `MachHeader64<_>` to implement `MachHeader`\nhelp: consider giving `image` an explicit type, where the type for type …"
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" name="selects universal Mach-O inputs by validated slices and refuses alternate executable identities" message="AssertionError:      Locking 30 packages to latest compatible versions\n      Adding base64 v0.22.1 (available: v0.23.1)\n      Adding sha2 v0.10.9 (available: v0.11.1)\n   Compiling version_check v0.9.5\n   Compiling proc-macro2 v1.0.107\n   Compiling quote v1.0.47\n   Compiling typenum v1.20.1\n   Compiling unicode-ident v1.0.26\n   Compiling serde_core v1.0.229\n   Compiling crc32fast v1.5.1\n   Compiling cfg-if v1.0.5\n   Compiling zmij v1.0.23\n   Compiling equivalent v1.0.2\n   Compiling foldhash v0.1.5\n   Compiling serde v1.0.229\n   Compiling object v0.37.3\n   Compiling hashbrown v0.17.1\n   Compiling libc v0.2.189\n   Compiling memchr v2.8.3\n   Compiling serde_json v1.0.151\n   Compiling itoa v1.0.18\n   Compiling cpufeatures v0.2.17\n   Compiling minisign-verify v0.2.5\n   Compiling base64 v0.22.1\n   Compiling hashbrown v0.15.5\n   Compiling generic-array v0.14.7\n   Compiling indexmap v2.14.2\n   Compiling syn v3.0.9\n   Compiling crypto-common v0.1.7\n   Compiling block-buffer v0.10.4\n   Compiling digest v0.10.7\n   Compiling sha2 v0.10.9\n   Compiling serde_derive v1.0.229\n   Compiling update-universal-native-regression v0.0.0 (/tmp/pcv/tauri-update-universal-BU38Pi)\nerror[E0283]: type annotations needed for `MachOFile<'_, MachHeader64<_>, &[u8]>`\n   --> /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/src/update_authorization.rs:461:13\n    |\n461 |         let image = MachOFile64::parse(bytes).map_err(|_| \"universal candidate slice is not thin Mach-O\")?;\n    |             ^^^^^   ----------- type must be known at this point\n    |\n    = note: the type must implement `Endian`\nhelp: the following types implement trait `Endian`\n   --> /home/marsh-office/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/object-0.37.3/src/endian.rs:299:1\n    |\n299 | impl Endian for Endianness {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^ `Endianness`\n...\n326 | impl Endian for LittleEndian {\n    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `LittleEndian`\n...\n353 | impl Endian for BigEndian {\n   …"
TEST_FILE_FINALIZATION {"pid":936023,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":936023,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-908878-1793685931333480820 retryHandle=psi-recovery:pc-heavy-908878-1793685931333480820 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=d67a959022 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-03T06:05:36.913Z
  HEAD         : d67a959022
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +123/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/release/tauri-update-authorization-native.test.ts
  matched lib/release/tauri-update-authorization-native.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ❯ lib/release/tauri-update-authorization-native.test.ts (4 tests | 2 failed | 2 skipped) 35879ms
   ↓ native consumer verifies real dual signatures, actual bytes, identities and current trust
   × extracts actual build inputs from a compiled native image and refuses decoys or malformed sections 23996ms
   × selects universal Mach-O inputs by validated slices and refuses alternate executable identities 11875ms
   ↓ producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections

 Test Files  1 failed (1)
      Tests  2 failed | 2 skipped (4)
   Start at  01:05:48
   Duration  37.73s (transform 428ms, setup 790ms, import 49ms, tests 35.88s, environment 0ms)

TEST_FILE_PROVENANCE head=d67a959022 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-03T06:06:30.933Z
  HEAD         : d67a959022
  tested files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts  [DIRTY +123/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
TEST_FILE_SKIPPED name="native consumer verifies real dual signatures, actual bytes, identities and current trust" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_SKIPPED name="producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections" file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/release/tauri-update-authorization-native.test.ts" — COLLECTED, NOT RUN: this assertion produced no evidence in this run
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=d67a959022 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T06:05:36.913Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=2

