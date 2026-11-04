---
rel_path: "security/p006-universal-extraction-development-20261103T0610Z.json"
updated_at: 1793686255087
_body: "content"
---

{
  "schema": "p006-development-evidence-v1",
  "measuredAt": "2026-11-03T06:10:00Z",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "item": "P-006",
  "proofOrigin": "WI-6554700010044291",
  "currentPlanStamp": "WI-6554700010045189",
  "phase": "local-development-only",
  "files": {
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "e71c861c82a0013ee41af94db362531f293272515f80bc7b5caf053912d46779",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "b85ed9baffee78a094436ca4dbd73c545832fce1f22cc25f1c73eefac2ef040b"
  },
  "implementation": "Reuse object0.37.3 MachOFatFile32/64 and thin parser. Validate target, at most two baseline CPU slices, unique CPU types, alignment/ranges/overlap, actual thin Mach-O CPU and subtype. Inspect every slice; require exact shared sourceRevision/product/version/authorIds while permitting target-specific effective policy/config. Keep artifact hash bound to full universal image. No new production dependency/store/flag.",
  "verification": {
    "first": {
      "handle": 42482,
      "exit": 1,
      "result": "Both selected cases failed to compile: object MachOFile64::parse required explicit Endianness. Corrected type argument. No runtime assertions passed in that attempt."
    },
    "final": {
      "handle": 87681,
      "exit": 0,
      "result": "2 selected maintained cases PASS: new universal-image parser fixtures and existing actual compiled native thin-image extraction. 2 other cases deliberately filtered, not executed.",
      "runnerStamp": "head=d67a959022 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-03T06:07:43.343Z",
      "sourceIdentity": "Two named source hashes stable across run/readback. Rust included directly by path; full imported-source/dependency closure not attested. Local working-source evidence only."
    },
    "types": {
      "handle": 21098,
      "exit": 0,
      "result": "Scoped changed TypeScript native test file clean. Completed before native-only explicit-endian correction."
    },
    "diffCheck": "Both changed source repositories focused diff checks EXIT0. All native handles drained."
  },
  "fixtureCoverage": "Both fat table widths and both target CPU selections; full artifact digest; wrong target; empty/missing/duplicate/too many/unsupported slices; subtype/header mismatch; nested fat image; disagreement in source/product/version/authors; overlapping/header-overlapping/out-of-range/overflow/misaligned slices and truncation. Uses maintained object writer, marks synthetic Mach-O parser fixtures MH_EXECUTE; no execution or actual Mac build claimed.",
  "authorityReads": "NativeEditProof validates tool/path set and optional sessionId but carries no source bytes/revision digest (file-lock-authority-ops.ts, locks/release.ts). blind-review-source-admission.ts and source-seal.ts bind sealed reviewer-runtime source bytes, not complete authenticated editor principals. Neither substitutes for source-author authentication.",
  "logs": [
    {
      "local": "/tmp/security-p006-universal-20261103T0606Z.log",
      "artifact": "security/security-p006-universal-20261103T0606Z.log",
      "sha256": "bd808a1858d81f0075d32a1a7b302650a912abc486717d0701db657c453127cb"
    },
    {
      "local": "/tmp/security-p006-universal-final-20261103T0609Z.log",
      "artifact": "security/security-p006-universal-final-20261103T0609Z.log",
      "sha256": "0f415c6522684b6abbb465ee7051bd5e5e83230903bacb735e745a01fcb0a88a"
    },
    {
      "local": "/tmp/security-p006-universal-types-20261103T0607Z.log",
      "artifact": "security/security-p006-universal-types-20261103T0607Z.log",
      "sha256": "797b4fe2c41954df2c58d1e763a67423e1e59028f4b171d9a42cbf94780e8b62"
    }
  ],
  "parentArchive": "security/parent3433-checkpoint-before-universal-20261103T0608Z.md@papercusp; exact 30460 characters reassembled from 11 disjoint readback pages before parent replacement.",
  "limitations": [
    "Producer authorIds remains empty and refused; exact authenticated source plus all authors still missing.",
    "Universal positives are synthetic Mach-O parser fixtures on Linux, not signed Mac product/installed proof. Existing thin native extraction test is local host compiled fixture.",
    "Archive adapters, sidecar/operator policy scope, cross-platform protected trust, CURRENT trust serialized with activation and atomic monotonic floors, independent release approval/generation, accepted SEC and final signed installed artifact remain open.",
    "P001/P002 historical scopes and earlier background exit/cleanup UNKNOWN unchanged. No extra implementers or LIVE_GATE_OPS."
  ],
  "next": "Implement macOS updater archive selection from actual Info.plist/CFBundleExecutable and bounded archive entries, then protected activation/floors. Continue real source-author authentication under existing protected custody; never fill it from Git or coordination labels."
}
