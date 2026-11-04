---
rel_path: "security/p006-build-producer-development-20261103T0506Z.json"
updated_at: 1793682430081
_body: "content"
---

{
  "schema": "p006-development-evidence-v1",
  "measuredAt": "2026-11-03T05:06:00Z",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "item": "P-006",
  "proofOrigin": "WI-6554700010044291",
  "currentPlanStamp": "WI-6554700010045189",
  "phase": "local-development-only",
  "files": {
    "papercusp-desktop/src-tauri/update_build_inputs.rs": "965bf773a98d05ac5562d8af2a1089b48e71e10f0ad988f902ec6d223150cb5f",
    "papercusp-desktop/src-tauri/build.rs": "d24656955b4652ece9b07ac4f0855e2ba93478606be9c0cb7bf0858e4da1f72e",
    "papercusp-desktop/src-tauri/Cargo.toml": "8eab31323d28723680edec972fee60082e0403873a37ee697f0a695ac0008bd5",
    "papercusp-desktop/src-tauri/Cargo.lock": "b27ed46aa72b2ee4408a912f0d4ee0396a25643e3f2b3a97f43ff96d2fed9689",
    "papercusp-desktop/src-tauri/src/main.rs": "dcc09706dfb2f1a2ab2210f4ed5cd1fc52b727bb0856df4f51bf9f2beba4a5a1",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "72a28bd7eb8ab1b4aa5570a963c877fbdf0ff8a40b7990ef1ab53a1053d19eeb"
  },
  "native": {
    "handle": 91206,
    "exit": 0,
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/release/tauri-update-authorization-native.test.ts --testNamePattern='producer binds effective'",
    "summary": "1 new producer integration case passed; 2 unchanged prior cases filtered out and NOT run. Actual locked Tauri generation and real optimized stripped Linux native fixture.",
    "result": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=d748ad9de6 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T05:04:34.715Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=2",
    "log": "security/security-p006-producer-native-final-20261103T0503Z.log",
    "logSha256": "0f482c6392709632dbc57cb2e1ead795f3a8005b0cd19ab9098e1aa15a79812c"
  },
  "types": {
    "handle": 50828,
    "exit": 0,
    "command": "npm run lint:tsc -- --files=packages/operator-core/lib/release/tauri-update-authorization-native.test.ts",
    "result": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-03T05:03:55.643Z head=d748ad9de6",
    "log": "security/security-p006-producer-types-final-20261103T0503Z.log",
    "logSha256": "db3bfc6c7f3b439427b61c59499607437e3f2cdd90c85e037efaed11c962727c"
  },
  "dependencyGraph": {
    "handle": 22439,
    "exit": 0,
    "command": "cargo metadata --offline --locked --format-version 1",
    "summary": "Root build dependencies extend the already-locked json-patch3.0.1/serde/tauri-utils2.9.3 build-2 graph. Cargo.lock changes only two root dependency edges; no new crate."
  },
  "implementation": "Existing build.rs emits after try_build using locked tauri-utils read_from + json_patch merge + typed Config defaults, exact OUT_DIR ACL/capability/optional allowed-command bytes, existing baked provenance knobs, and native product/target/version. Generated section is referenced from main and survives LTO+symbol stripping.",
  "reuse": "Existing update-inputs section protocol, existing Cargo build/OUT_DIR files and already-locked maintained Tauri/json-patch/serde dependencies; no new service, registry, store or flag.",
  "limitations": [
    "Authenticated author is deliberately empty; native extraction refuses this production record. Git author/environment text is never promoted into authority. Source revision is recorded only for an existing full 40-hex baked SHA; it is not authenticated by this emitter.",
    "Scope is native shell Tauri configuration/ACL bytes. Broader sidecar/operator enforcement policy, source/author binding and trusted release-generation workflow remain open.",
    "Positive optimized image is Linux x86_64 fixture; no complete desktop product build or signed installed artifact was exercised. PE/Mach-O positive proof and universal/archive adapters remain open.",
    "Serialized CURRENT protected trust + activation/atomic monotonic floors, independent acceptance and final signed installed proof remain open. No SEC qualification or shipment claim.",
    "Six named source hashes stable before/after. Native runner stamp only covers its named TS path; full import-radius provenance is not established. Prior proof retained separately without unchanged replay."
  ],
  "next": "Bind authenticated source/author through existing protected review/release authority, preserving absent-identity refusal; then format-aware archive extraction and activation/floors."
}

