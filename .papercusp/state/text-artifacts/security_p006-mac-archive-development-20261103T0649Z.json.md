---
rel_path: "security/p006-mac-archive-development-20261103T0649Z.json"
updated_at: 1793688572415
_body: "content"
---

{
  "schema": "p006-development-evidence-v1",
  "measuredAt": "2026-11-03T06:49:31.302180+00:00",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "nativeSession": "01a1a015-937f-7e92-9c49-acc75fc68fe7",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "item": "P-006",
  "proofOrigin": "WI-6554700010044291",
  "currentPlanStamp": "WI-6554700010045189",
  "phase": "local-development-only",
  "files": {
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "d6b3b0ed5c99e035608379e353e8d3ab37e0908b631c3f4b9a3903648521bfb1",
    "papercusp-desktop/src-tauri/Cargo.toml": "f19338fedd968bd1f991cf6772b59791c30b15f7f6d06ee651763d304e62c835",
    "papercusp-desktop/src-tauri/Cargo.lock": "9ff60288d3c0f442a6cbddba23c2ac4e9380891a23c2a76b386feed8651cdff7",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "48ab364d002193933c514a60e6084a9a90fe3b6185490cc0dc3dac171f1194c9"
  },
  "implementation": "Extend existing portable verifier using locked tar0.4.46/flate2 1.1.9/plist1.10.0. Pinned plist stream feature bounds nesting/events. Validate physical metadata first, installed namespace second, selected main third. Mirror updater first-component stripping. Bind Info.plist CFBundleExecutable/CFBundleIdentifier/CFBundleShortVersionString to selected thin/universal native inputs; candidate artifact remains WHOLE gzip archive. No filesystem unpack or execution. No new service/store/flag.",
  "bounds": {
    "compressedBytes": 1073741824,
    "inflatedBytesPerPass": 2147483648,
    "physicalEntries": 65536,
    "fileBytes": 536870912,
    "metadataAndPathBytes": 4096,
    "plistBytes": 65536,
    "plistEvents": 16384,
    "plistDepth": 32
  },
  "verification": {
    "first": {
      "handle": 36859,
      "exit": 1,
      "result": "Compile failed before runtime: plist stream feature missing; corrected explicitly in both production and harness."
    },
    "second": {
      "handle": 8532,
      "exit": 1,
      "result": "Compile succeeded; archive fixture builder panicked setting empty link names. Fixed helper precondition; retained both output streams and meaningful valid duplicate/deep/event-amplified plists. Harness audit recorded on WI before third attempt."
    },
    "auditedFocus": {
      "handle": 64453,
      "exit": 0,
      "result": "1 selected Vitest case PASS; 3 filtered. Requires 5 native success markers including universal, archive positive, hostile input, physical bounds/gzip integrity, total inflation after tar end."
    },
    "finalCompatibility": {
      "handle": 3760,
      "exit": 0,
      "result": "All4 maintained native Vitest cases PASS,0skipped. Real dual-signature/current-trust, actual compiled thin extraction, universal+Mac archives, effective real-Tauri producer with empty-author refusal.",
      "runnerResult": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=0a458561cc uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T06:44:47.853Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=0",
      "sourceIdentity": "Four named file hashes stable before/after final compatibility. Rust module included by path. Full imported/dependency closure NOT attested; HEAD moved so runner provenance=unknown. Local working-source proof only."
    },
    "types": {
      "handle": 17115,
      "exit": 0,
      "result": "Final named TS file clean; shared service used1/errors0."
    },
    "metadataAndDiff": "Cargo metadata --locked --offline --no-deps EXIT0 and focused diffchecks both repositories EXIT0. Every native handle drained; manual edit locks explicitly released."
  },
  "coverage": "XML/binary plist; main before/after plist; implicit/explicit dirs; GNU long path; benign nonascending Framework links; thin/universal both CPUs; full artifact digest. Refuse wrong/missing/duplicate plist identities, depth/event amplification, oversize plist, decoys, case aliases, duplicate/escaping/noncanonical paths, file/link ancestors both orders, missing/nonexecuting/link main or info, hardlinks/devices/FIFO/sparse/PAX/setuid, empty authors, wrong platform, physical count/size/metadata bounds, CRC/truncation/trailing gzip members and inflated padding. Synthetic Mach-O parser fixtures on Linux only.",
  "logs": [
    {
      "local": "/tmp/security-p006-mac-archive-20261103T0640Z.log",
      "artifact": "security/security-p006-mac-archive-20261103T0640Z.log",
      "sha256": "2b9e6cf45447133c6657f00860fbb8db968e1195b5d1212102eb401938de3ac4"
    },
    {
      "local": "/tmp/security-p006-mac-archive-final-20261103T0637Z.log",
      "artifact": "security/security-p006-mac-archive-final-20261103T0637Z.log",
      "sha256": "28886f3944d46fc1fa9751d617ed9e42d755965f858c3321ccc60359ca205af5"
    },
    {
      "local": "/tmp/security-p006-mac-archive-audited-20261103T0642Z.log",
      "artifact": "security/security-p006-mac-archive-audited-20261103T0642Z.log",
      "sha256": "30a3083c3e53d43967f63f1d245f1d668e28f348e57931fb771f3ee424d90b86"
    },
    {
      "local": "/tmp/security-p006-mac-archive-types-20261103T0640Z.log",
      "artifact": "security/security-p006-mac-archive-types-20261103T0640Z.log",
      "sha256": "4497f8982e618456d613c34f235c69426c25fb79b40bd965d48e25e72f2741b7"
    },
    {
      "local": "/tmp/security-p006-mac-archive-types-final-20261103T0642Z.log",
      "artifact": "security/security-p006-mac-archive-types-final-20261103T0642Z.log",
      "sha256": "367c30680d5043aa6fa48f077ee10def87867b0d0cd43840db906c789e384a87"
    },
    {
      "local": "/tmp/security-p006-mac-archive-compat-20261103T0644Z.log",
      "artifact": "security/security-p006-mac-archive-compat-20261103T0644Z.log",
      "sha256": "dc9d180a2b9576aaa2aca4c75471436d349de41de8bc7cff4b0da765f3e3754b"
    }
  ],
  "limitations": [
    "Production authorIds remains empty/refused; exact authenticated source AND all authors still missing.",
    "ASCII paths and nonascending relative symlinks only. PAX/sparse/hardlinks/nonASCII explicitly refuse pending native format qualification; preserve supported journeys before rollout.",
    "Actual Mac-built/signed installed artifact and cross-platform runtime positives are unmeasured.",
    "Adapter is not wired into the installer yet: CURRENT protected trust + serialized activation + atomic monotonic floors, Linux AppImage/Windows installer adapters, sidecar/operator policy scope, independent release approval/generation, SEC and exact signed installed proof remain OPEN.",
    "P001 seven closure populations UNKNOWN; P002 historical proof retained; earlier background exit/cleanup UNKNOWN. No extra implementers/LIVE_GATE_OPS."
  ],
  "incidents": [
    "TSC service timeout recurrence attached existing EI-26676694530779732 comment1213735; final service clean.",
    "ptool save refused before dispatch serving_generation_missing; direct same-payload save5/5 succeeds. Capture coalesced/promoted EI-26670523231844612; unassigned existing bug, not worked as separate mission."
  ],
  "next": "Continue P006 protected CURRENT-trust/activation/floors using existing machinery, preserve empty-source-author refusal, qualify actual Mac formats before rollout. Read this packet by ref; do not replay unchanged tests."
}
