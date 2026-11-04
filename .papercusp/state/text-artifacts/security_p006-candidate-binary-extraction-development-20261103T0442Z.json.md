---
rel_path: "security/p006-candidate-binary-extraction-development-20261103T0442Z.json"
updated_at: 1793681032986
_body: "content"
---

{
  "schema": "p006-development-evidence-v1",
  "measuredAt": "2026-11-03T04:43:15.538Z",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "nativeSession": "01a19fa0-5628-7180-833f-5c14f382f3e5",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "item": "P-006",
  "proofOrigin": "WI-6554700010044291",
  "currentPlanStamp": "WI-6554700010045189",
  "phase": "local-development-only",
  "files": {
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "c93b1336dc9b3af0e1f2c56ca076dd8ef7062bf4fe3062649271cf2b7c2d40ac",
    "papercusp-desktop/src-tauri/Cargo.toml": "a8aeddbc428e1785c96ca7097dc2a16a97b28c978571cc2b799a7cddc8fe93e3",
    "papercusp-desktop/src-tauri/Cargo.lock": "e6d79712d8189baa5635f6ab6696a6bcf8671f6da2f5061828f4f1252bd9d74c",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "5f88dd22da9eade17039ff4e611806ce4e3b677ca38b377c7eb24c40840b93a7"
  },
  "native": {
    "handle": 60375,
    "exit": 0,
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/release/tauri-update-authorization-native.test.ts",
    "summary": "1 file, 2 tests passed, 0 skipped. Existing authentic dual-signature/current-trust vectors and protected-policy cases; new actual compiled native image plus 12 negative embedded-input cases.",
    "result": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=b878271db1 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T04:37:49.631Z childSubstituted=12 childNoticeOffsetBytes=0 skippedTests=0",
    "log": "security/security-p006-candidate-native-final-20261103T0437Z.log"
  },
  "types": {
    "handle": 61061,
    "exit": 0,
    "scope": "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts",
    "command": "npm run lint:tsc -- --files=packages/operator-core/lib/release/tauri-update-authorization-native.test.ts",
    "result": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-03T04:34:40.542Z head=716bbb36bf",
    "log": "security/security-p006-candidate-types-20261103T0437Z.log",
    "limitation": "Service timed out; maintained full compiler fallback completed. Scoped file clean, not whole-project type cleanliness."
  },
  "implementation": "Maintained object 0.37.3 reads exactly one bounded .pcupd/__pcupd section of supported thin native images without executing a candidate. Extracted policy/configuration bytes and identity feed Candidate. No manifest digest is treated as actual bytes. Cargo.lock adds only object with existing memchr.",
  "reuse": "Extends the existing native verifier/Candidate and release provenance work; object parser is maintained. No store, registry, service, or runtime flag added.",
  "limitations": [
    "Measured positive image is Linux x86_64 compiled fixture, not a signed installed product.",
    "PE/Mach-O dispatch implemented but not positively verified on those platforms.",
    "Real producer does not yet emit the section; effective-input/source/author binding remains required.",
    "Archive and universal adapters, serialized CURRENT protected trust + activation and monotonic floors remain open.",
    "Independent review, exact installed proof, SEC qualification and shipment are not claimed.",
    "Runner import-radius provenance is unknown after HEAD movement; four named source hashes remained stable. Trace-helper committed substitutions do not constitute full-source acceptance."
  ],
  "next": "Bind embedded native provenance to actual effective build inputs using existing build/provenance surfaces, then archive adapters and shared install authorization."
}
