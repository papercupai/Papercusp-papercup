---
rel_path: "runtime-migration/p004-detached-eligibility-local-proof-0dcd3-20261102.json"
updated_at: 1793597573714
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022070",
  "decision": "node-to-bun-staged-migration-2026-10-22#D-010",
  "activationAudit": 8,
  "collectedAt": "2026-11-02T05:32:52.196642+00:00",
  "scope": "Local detached eligibility issuer/verifier and release CLI compatibility only. Boot/install transport is not wired. Node active; no final candidate acceptance or shipment.",
  "files": {
    "libs/generic/tauri-release-kit/src/index.ts": "01190dabfd853996b50c78d04330abd0991fb17a56cafd5359f9c8b65181aa80",
    "libs/generic/tauri-release-kit/src/signature.mjs": "74e92ed8822f96551a97fede20959048c2a0a6e2dcc00a9ba4d04209aef6360f",
    "libs/generic/tauri-release-kit/src/signature.d.mts": "8969b5a2ecb940be407f11b033abd23c9233792473fbf23c9c06386908a245c5",
    "libs/generic/tauri-release-kit/src/signature.test.ts": "447b7c1650f063a14950a84834b4e6d3af7348844cb9a85c92da2a03998f64c7",
    "papercusp-desktop/bin/verify-tauri-signature.mjs": "e06fb9772b8850b240afe150b0a6479007d85abf57922ade5eb8382ebb04c57f",
    "packages/operator-core/lib/application-runtime-acceptance.ts": "784ab3a2351e585b7c405e45e4339df5e6cb1b04f7934e7caf0f9fbccc26afe9",
    "packages/operator-core/lib/application-runtime-acceptance.test.ts": "b6d35105324b0c35224744451875cb0a1577d888408a51777752dcaeb35b13a8"
  },
  "verification": {
    "tests": {
      "log": "/tmp/p004-eligibility-tests-0dcd3-20261102.log",
      "sha256": "dfa38a90cdb7432fbc099256d97e9c94bf8025b7f09e229f69aff804537be4ad",
      "observations": [
        "close timed out after 10000ms",
        " Test Files  1 passed (1)",
        "      Tests  6 passed (6)",
        " Test Files  1 passed (1)",
        "      Tests  53 passed (53)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=1e78b2c83a uncommittedPaths=2/2 provenance=stamped startedAt=2026-11-02T05:23:27.275Z childSubstituted=0 skippedTests=0"
      ]
    },
    "types": {
      "log": "/tmp/p004-eligibility-types-0dcd3-20261102.log",
      "sha256": "7513138975c6aa3d4c36db9cabdb1eb8c4e9e8c5f41ffabec95a413ace769a83",
      "observations": [
        "workspaces typecheck: 1 passed, 0 failed.",
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=2 at=2026-11-02T05:24:00.594Z head=1e78b2c83a"
      ]
    }
  },
  "sourceMaps": [
    {
      "path": "/tmp/p004-eligibility-source-0dcd3-20261102.json",
      "sha256": "34935334265e39d51e3ede8d12044d0cde8df6cf7881855dca9f14c05720cc2f",
      "workspaceName": "papercusp-workspace",
      "recordedSha": "1e78b2c83a65a87328f6bf0526a79cd06d5c3a61",
      "worktreeDirty": true,
      "rows": [
        {
          "testFile": "libs/generic/tauri-release-kit/src/signature.test.ts",
          "sourceStatus": "stable",
          "sources": [
            {
              "path": "libs/generic/tauri-release-kit/src/signature.mjs",
              "sha256": "74e92ed8822f96551a97fede20959048c2a0a6e2dcc00a9ba4d04209aef6360f",
              "basis": "vite-pre-transform",
              "currentSha256": "74e92ed8822f96551a97fede20959048c2a0a6e2dcc00a9ba4d04209aef6360f"
            },
            {
              "path": "libs/generic/tauri-release-kit/src/signature.test.ts",
              "sha256": "447b7c1650f063a14950a84834b4e6d3af7348844cb9a85c92da2a03998f64c7",
              "basis": "vite-pre-transform",
              "currentSha256": "447b7c1650f063a14950a84834b4e6d3af7348844cb9a85c92da2a03998f64c7"
            }
          ],
          "opaqueReasons": [
            "child-process",
            "worker-runtime-unavailable",
            "config-deps-unavailable"
          ]
        }
      ]
    },
    {
      "path": "/tmp/p004-eligibility-source-0dcd3-20261102.1.json",
      "sha256": "fffaa0706a3aa8fd7322ba473212d9dfe5f9f124d21aa1079ca4cbd867fa044d",
      "workspaceName": "papercusp-workspace",
      "recordedSha": "1e78b2c83a65a87328f6bf0526a79cd06d5c3a61",
      "worktreeDirty": true,
      "rows": [
        {
          "testFile": "packages/operator-core/lib/application-runtime-acceptance.test.ts",
          "sourceStatus": "stable",
          "sources": [
            {
              "path": "libs/generic/tauri-release-kit/src/index.ts",
              "sha256": "01190dabfd853996b50c78d04330abd0991fb17a56cafd5359f9c8b65181aa80",
              "basis": "vite-pre-transform",
              "currentSha256": "01190dabfd853996b50c78d04330abd0991fb17a56cafd5359f9c8b65181aa80"
            },
            {
              "path": "libs/generic/tauri-release-kit/src/signature.mjs",
              "sha256": "74e92ed8822f96551a97fede20959048c2a0a6e2dcc00a9ba4d04209aef6360f",
              "basis": "vite-pre-transform",
              "currentSha256": "74e92ed8822f96551a97fede20959048c2a0a6e2dcc00a9ba4d04209aef6360f"
            },
            {
              "path": "packages/operator-core/lib/application-runtime-acceptance.test.ts",
              "sha256": "b6d35105324b0c35224744451875cb0a1577d888408a51777752dcaeb35b13a8",
              "basis": "vite-pre-transform",
              "currentSha256": "b6d35105324b0c35224744451875cb0a1577d888408a51777752dcaeb35b13a8"
            },
            {
              "path": "packages/operator-core/lib/application-runtime-acceptance.ts",
              "sha256": "784ab3a2351e585b7c405e45e4339df5e6cb1b04f7934e7caf0f9fbccc26afe9",
              "basis": "vite-pre-transform",
              "currentSha256": "784ab3a2351e585b7c405e45e4339df5e6cb1b04f7934e7caf0f9fbccc26afe9"
            }
          ],
          "opaqueReasons": [
            "worker-runtime-unavailable",
            "config-deps-unavailable"
          ]
        }
      ]
    }
  ],
  "nativeTestExit": 0,
  "nativeTypecheckExit": 0,
  "limits": [
    "Canonical acceptance snapshot/artifact storage mocked in unit tests; no live canonical issuer run.",
    "Real Ed25519 signing uses generated fixture keys; no production signature issued.",
    "Offline verifier trusts canonical eligibility at issuance through signed expiry; cannot see later revocations while disconnected.",
    "No compiled key pin, envelope installer, release signer command or pre-PG boot wiring yet.",
    "Source maps have child-process/worker-runtime/config opaque reasons; CLI child sources not fully observed. Source hashes collected after tests.",
    "worktreeDirty:true; no immutable-candidate or deployed-source claim.",
    "Vite close timeout warning filed as EI-27652818812404920; tests still native0."
  ]
}
