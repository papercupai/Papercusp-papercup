---
rel_path: "security/p006-complete-authors-development-20261103T0539Z.json"
updated_at: 1793684372886
_body: "content"
---

{
  "schema": "p006-development-evidence-v1",
  "measuredAt": "2026-11-03T05:39:00Z",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "item": "P-006",
  "proofOrigin": "WI-6554700010044291",
  "currentPlanStamp": "WI-6554700010045189",
  "phase": "local-development-only",
  "files": {
    "libs/generic/tauri-release-kit/src/signature.mjs": "d30a117b616d2b38ed6e3e62a684a859fc2e3abb1d1fc861291ea3c61e134cf6",
    "libs/generic/tauri-release-kit/src/signature.d.mts": "669990fd9093ba93a041641360a17712cd16d410a02460cefd6fdb11229b9445",
    "libs/generic/tauri-release-kit/src/signature.test.ts": "0dccc5a0bf32547d85000f0a64686873c2c2d2c485a27c9a2af28f5b8b3baf4e",
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "9aba2c7c826bef2df0a943557af5d956af20ff16e3e92594bcde3ac68c50b6a4",
    "papercusp-desktop/src-tauri/update_build_inputs.rs": "5162150e9f0693fd7dada8d9159f79c13a2566e1a9c2827a1b18f1541e0a2ff8",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "8660dc4f8f0b99918246a9ce81f0c46ebce66af38449531bd1364ed191aac127",
    "packages/operator-core/lib/endpoint-route/routes/misc/updates-manifest.test.ts": "f9ebb55cc2fba3767dc36034bf36d68ff75049c1915476623f566eb2d4047dc1",
    "packages/operator-core/lib/endpoint-route/routes/misc/updates-rollback.test.ts": "15ce1c302b6291301bf8d06659dc1aebaf47fc3374c1f6b300952eaf2a64e448"
  },
  "verification": {
    "primary": {
      "handle": 50711,
      "exit": 1,
      "scope": "signature.test.ts plus all 3 native integration cases",
      "result": "42 JS signature cases passed; native dual-signature/current-trust case and real Tauri producer case passed. Extraction native Cargo assertions passed, but outer TS stdout comparison failed on JSON-escaped quotes in new negative-case names. Whole combined run FAILED; do not call it green.",
      "provenance": "UNKNOWN: HEAD moved; full imported-source radius not captured."
    },
    "extractionFinal": {
      "handle": 64898,
      "exit": 0,
      "result": "1 affected extraction case passed; 2 unchanged prior cases filtered out. Corrected stdout comparison uses JSON.stringify(name). All malformed native-image fixtures were refused.",
      "provenance": "UNKNOWN: HEAD moved; named source stamp alone is not import-radius proof."
    },
    "publication": {
      "handle": 21049,
      "exit": 0,
      "result": "15 selected authorization/approval transport cases passed; 60 unrelated cases intentionally filtered out, NOT executed."
    },
    "nativeTypes": {
      "handle": 39514,
      "exit": 0,
      "result": "Scoped native test file clean; before final stdout-only assertion fix."
    },
    "kitTypes": {
      "exit": 0,
      "result": "npx tsc --noEmit -p libs/generic/tauri-release-kit/tsconfig.json"
    },
    "routeTypes": {
      "handle": 90607,
      "exit": 0,
      "result": "Scoped two changed route fixtures clean."
    }
  },
  "logs": [
    {
      "local": "/tmp/security-p006-authors-tests-20261103T0530Z.log",
      "artifact": "security/security-p006-authors-tests-20261103T0530Z.log",
      "sha256": "eb95ccfefaa17cf3b9b1a1fc4756701aac259510b4e517f54033fd3b79bb0f83"
    },
    {
      "local": "/tmp/security-p006-authors-types-20261103T0530Z.log",
      "artifact": "security/security-p006-authors-types-20261103T0530Z.log",
      "sha256": "507bdfcb549ab507c0f49bf1ff7bc4ac4ce6e6098a0fd6c87002d32ffa2644f1"
    },
    {
      "local": "/tmp/security-p006-authors-kit-types-20261103T0530Z.log",
      "artifact": "security/security-p006-authors-kit-types-20261103T0530Z.log",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "local": "/tmp/security-p006-authors-transport-20261103T0534Z.log",
      "artifact": "security/security-p006-authors-transport-20261103T0534Z.log",
      "sha256": "018a63176e1d5274c808bb1c4679cc72bce52bdafe1b1976d038fccc95e75e7e"
    },
    {
      "local": "/tmp/security-p006-authors-extraction-final-20261103T0536Z.log",
      "artifact": "security/security-p006-authors-extraction-final-20261103T0536Z.log",
      "sha256": "73b7cf6e57d3e7a2df1c9252386ab8069a54bc2553fdbd4ce01b7874ad25dd79"
    },
    {
      "local": "/tmp/security-p006-authors-route-types-20261103T0536Z.log",
      "artifact": "security/security-p006-authors-route-types-20261103T0536Z.log",
      "sha256": "c31def82976b83d84863127c278002ad2fccf36c12da47473bc2a3fc6b1ae169"
    }
  ],
  "rootCause": "Existing exact update metadata and native build inputs represented only one author, although git-sync may merge several. Independence compared the reviewer with only that single principal; no complete applicable-author set could be bound.",
  "implementation": "Extend existing protocol to mandatory authorIds under tauri-update-authorization-v2 / tauri-update-inputs-v2. One to 64 nonempty unique principals, strictly sorted by UTF-16 units in both languages. Compare the entire candidate set by value; exclude every author and release signer from reviewer authority; signatures cover the entire set. Refuse v1, missing/empty/duplicate/unsorted/oversized/malformed sets. Preserve production empty-author refusal.",
  "reuse": "Existing signature/verifier, native section/build producer, metadata declarations and publication fixtures; no new store, service, registry, flag or author environment knob.",
  "authorityReads": "edit-attribution.ts is best-effort and stores coordination agentId/session without content/revision attestation; Git trailers are not authority. review:approve requirePrincipal:false resolves a pending response. release-owner-approval.ts concerns partial platform scope. None was promoted to source-author authentication. Retrieval-only consult conv-mw099n92-0000-6955255560134ec18d8a0b53e8846a41 returned no_qualified_responder; no dispatch requested.",
  "limitations": [
    "Still requires authenticated exact source revision AND all applicable author principals. Producer emits authorIds:[]; extractor refuses production record. This development change does not prove complete author attribution.",
    "Native positives are local compiled Linux fixtures, including real Tauri effective config/ACL producer and optimized retained section. No signed installed product or cross-platform positive proof.",
    "Broader sidecar/operator policy, archive/universal extraction, cross-platform protected trust, serialized CURRENT trust with activation and atomic monotonic floors, independent release generation/SEC acceptance/final shipment remain open.",
    "Earlier background parent exit/cleanup UNKNOWN remains unchanged. No extra implementation agents or LIVE_GATE_OPS."
  ],
  "next": "Bind authenticated source+all-authors using protected host-owned review/release authority; preserve empty-author refusal until real. Do not replay unchanged suites merely to stamp a newer HEAD."
}
