---
rel_path: "runtime-migration/p004-offline-installed-transport-local-proof-0dcd3-20261102.json"
updated_at: 1793599890551
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022070",
  "decision": "node-to-bun-staged-migration-2026-10-22#D-010",
  "collectedAt": "2026-11-02T06:10:43.353344+00:00",
  "files": {
    "packages/operator-core/lib/application-runtime-acceptance.ts": "0b0db46d500f0a98184f80adaf3461284ab125e3766d47cf51c7b403636636a5",
    "packages/operator-core/lib/application-runtime-acceptance.test.ts": "416c4c31f99a6f3f967b7f841b8071d3fb1a01d1543ea292b5f3c9e36b2d9e1d",
    "packages/operator-core/lib/application-runtime-acceptance-offline.ts": "79fa90a78df3f3b2a43fd5b284fe9402109b00fef4704d90f79301f8b7b8d44d",
    "packages/operator-core/lib/application-runtime-acceptance-offline.test.ts": "f7e7171487aa70447557f944aedd343185ee5e5f14dfdcbab0208df146b5677a",
    "packages/operator-core/lib/application-runtime-acceptance-issuer.ts": "49608c204da55d74d1e28ec9f7f24ee658c03b0ea3f8f2e22589e90d624fd03f",
    "packages/operator-core/lib/vm-release-runtime-policy.test.ts": "7f9c7e943bc05440e3b75e44eab79d4164f252b58fefbc3468ca806749241b2d",
    "apps/operator/bin/serve.ts": "5d075a8d1384c7e99b2e0a29a926392387ecdb536ef61fd39b27c66fa39ab097",
    "papercusp-desktop/bin/build-desktop-sidecar.sh": "6f9f73229c20a6882ff3dddebeddb77bb8b115d4513372508e501ead12ceeb14",
    "papercusp-desktop/bin/issue-runtime-acceptance.sh": "af52d88d6ee9da78674759ee246341b160aafe0ad39367796f6f8d8c17be32da",
    "papercusp-desktop/bin/lib/inno-spanned-server.sh": "26f44d8a44a10638385599ca7595a8ce7cef67f6991ea0aadcdf479d3957329a",
    "papercusp-desktop/bin/install-workspace-host-entrypoints.sh": "b59e4c5aade576d850f8e604d3c210602cdf6d0e3fb799a6a412eb98e6e73838",
    "papercusp-desktop/test/bun-runtime-inputs.test.js": "16baa97ec5d77ddbce25ec832e5eec7aa5435b6a1ba32b52da09b50a7694b77d",
    "libs/generic/tauri-release-kit/package.json": "18f32ed0792e1fb618e380327709b0b6353a0189bb697b024fba2a2b297bb786"
  },
  "logs": [
    {
      "path": "/tmp/p004-offline-tests-0dcd3-20261102.log",
      "sha256": "36d36c7b17a6a857121b2b38d8e0e47a3c805a353635db9eff9e2d34fb163444",
      "observations": [
        " Test Files  2 passed (2)",
        "      Tests  62 passed (62)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=182804948d uncommittedPaths=2/2 provenance=stamped startedAt=2026-11-02T05:50:26.627Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/p004-issuer-tests-0dcd3-20261102.log",
      "sha256": "d524962da8d68c9372540ef6e5e3579e9d5b8dfa2f5a560e580e5ed97fd0e173",
      "observations": [
        " Test Files  1 passed (1)",
        "      Tests  1 passed | 53 skipped (54)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=52f8fe1f00 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-02T05:54:34.952Z childSubstituted=0 skippedTests=53"
      ]
    },
    {
      "path": "/tmp/p004-offline-boot-tests-0dcd3-20261102.log",
      "sha256": "ab5cdc1460fd28888567503ba80a65a4bebd924975c5cd75db39e1fa61b5d5bd",
      "observations": [
        " Test Files  1 passed (1)",
        "      Tests  4 passed | 32 skipped (36)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=52f8fe1f00 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-02T05:56:15.883Z childSubstituted=0 skippedTests=32"
      ]
    },
    {
      "path": "/tmp/p004-offline-desktop-0dcd3-20261102.log",
      "sha256": "509222e5bd93134c99c5c48491d18c5dafcef01236d18c318d2cd0fde36142bb",
      "observations": [
        "ℹ pass 47",
        "ℹ fail 0",
        "ℹ skipped 0"
      ]
    },
    {
      "path": "/tmp/p004-offline-signer-0dcd3-20261102.log",
      "sha256": "0433386476d2fa739947cd46b9017423346739b79ea6d617a22234a8318d4070",
      "observations": [
        "ℹ pass 2",
        "ℹ fail 0",
        "ℹ skipped 0"
      ]
    },
    {
      "path": "/tmp/p004-offline-install-route-0dcd3-20261102.log",
      "sha256": "9978e910a59094cc4a0aefe28083a5634b0034ebbc910fd7738bf5ebc14855b8",
      "observations": [
        "ℹ pass 1",
        "ℹ fail 0",
        "ℹ skipped 0"
      ]
    },
    {
      "path": "/tmp/p004-offline-types-0dcd3-20261102.log",
      "sha256": "66921e7e41ce5e88a52e835f98d3b161df28c4545f637c8f6232bbac82c9bf2e",
      "observations": [
        "LINT_TSC_RESULT label=operator scope=files exit=0 status=clean at=2026-11-02T05:56:40.299Z head=52f8fe1f00",
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-11-02T05:56:14.490Z head=52f8fe1f00"
      ]
    },
    {
      "path": "/tmp/p004-offline-final-tests-0dcd3-20261102.log",
      "sha256": "f27b43e51bac3b9fef5b41e7d25a3b67da4850292af2c573cbb114c8c521027b",
      "observations": [
        " Test Files  2 passed (2)",
        "      Tests  15 passed | 32 skipped (47)",
        "TEST_FILE_FINALIZATION_ERROR phase=native-proof-custody detail={\"status\":\"partial\",\"bytesRead\":17719961,\"limits\":{\"objects\":16384,\"bytes\":67108864,\"objectBytes\":16777216,\"referenceOccurrences\":65536,\"families\":{\"A\":{\"objects\":4096,\"bytes\":16777216},\"B\":{\"objects\":8192,\"bytes\":25165824},\"C\":{\"objects\":2048,\"bytes\":12582912},\"D\":{\"objects\":1024,\"bytes\":4194304},\"auxiliary\":{\"objects\":1024,\"bytes\":8388608}}},\"gapCount\":1,\"gaps\":[\"group-0:A:custody evaluator reference malformed\"],\"omittedGaps\":0}",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=cdd0218eb8 uncommittedPaths=2/2 provenance=stamped startedAt=2026-11-02T06:01:09.494Z childSubstituted=0 skippedTests=32 finalizationError=true"
      ]
    },
    {
      "path": "/tmp/p004-offline-final-types-0dcd3-20261102.log",
      "sha256": "5239cba3848900f0f592e8f326eaf3acf12d310dc935020baa015d787f2888b7",
      "observations": [
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-02T06:01:05.812Z head=cdd0218eb8"
      ]
    }
  ],
  "sourceMaps": [
    {
      "path": "/tmp/p004-offline-source-0dcd3-20261102.json",
      "sha256": "9ca153582d961698770dd7ab9d630d20a4c2de4949d2737f9dca35d9a909d8eb",
      "recordedSha": "182804948d0334010e10c3ef62863b12bd62dcdc",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "unhandledErrorCount": 0,
      "rows": [
        {
          "file": "packages/operator-core/lib/application-runtime-acceptance.test.ts",
          "status": "stable",
          "opaque": [
            "worker-runtime-unavailable"
          ]
        },
        {
          "file": "packages/operator-core/lib/application-runtime-acceptance-offline.test.ts",
          "status": "stable",
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        }
      ]
    },
    {
      "path": "/tmp/p004-issuer-source-0dcd3-20261102.json",
      "sha256": "62fec11501c80cbd920809168bf04a222653a059bd4c9918fd880ec50d0eb2c4",
      "recordedSha": "52f8fe1f00323692adc72fc9dffe574fc83f5a10",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "unhandledErrorCount": 0,
      "rows": [
        {
          "file": "packages/operator-core/lib/application-runtime-acceptance.test.ts",
          "status": "stable",
          "opaque": [
            "worker-runtime-unavailable"
          ]
        }
      ]
    },
    {
      "path": "/tmp/p004-offline-boot-source-0dcd3-20261102.json",
      "sha256": "f47c213dafbdf6082fc00eee2a584768789facc105f4685feea75b8ed6c12829",
      "recordedSha": "cdd0218eb861a0f44e5089fcc26bfc80a5eb92f0",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "unhandledErrorCount": 0,
      "rows": [
        {
          "file": "packages/operator-core/lib/vm-release-runtime-policy.test.ts",
          "status": "stable",
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        }
      ]
    },
    {
      "path": "/tmp/p004-offline-final-source-0dcd3-20261102.json",
      "sha256": "cb585f5010cfe6592375f78f34ac634955e71f5650185f97f454824db8f8f45e",
      "recordedSha": "cdd0218eb861a0f44e5089fcc26bfc80a5eb92f0",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "unhandledErrorCount": 0,
      "rows": [
        {
          "file": "packages/operator-core/lib/application-runtime-acceptance-offline.test.ts",
          "status": "stable",
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        },
        {
          "file": "packages/operator-core/lib/vm-release-runtime-policy.test.ts",
          "status": "stable",
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        }
      ]
    }
  ],
  "pinnedBun": {
    "path": "/tmp/p004-bun-0dcd3-20261102/bun",
    "sha256": "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235"
  },
  "scope": "Local compiled updater-key offline receipt installer; canonical issuer plus existing Tauri signer; actual retained Node to pinned Bun policy handoff fixture. Not final signed package/platform acceptance or shipment.",
  "behavior": {
    "boot": "serve before --ensure -> immutable runtime policy -> candidate-hash-selected detached receipt outside sidecar -> signature + signed expiry + exact tuple -> pinned Node/Bun selection",
    "trust": "Sidecar compiler reads source-cut tauri.conf.json updater pubkey and defines __PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY__. No runtime-env/envelope key fallback. New library subpath reuses existing crypto without full barrel.",
    "issuer": "serve --issue-runtime-acceptance REQUEST OUTPUT runs canonical R1-R7 evidence + independent grade + author snapshot re-read, exclusive unsigned output. bash papercusp-desktop/bin/issue-runtime-acceptance.sh NODE ISSUER_SERVE REQUEST OUTPUT reuses existing release signer then existing verifier. No existing output overwrite.",
    "installer": "serve --install-runtime-acceptance ENVELOPE SIGNATURE validates compiled key and signed expiry before caching outside frozen sidecar at ../runtime-acceptance/<candidate>.json(.sig). papercusp-install accepts --runtime-acceptance and --runtime-acceptance-signature before content bootstrap. Every Bun boot revalidates."
  },
  "verdict": "INCOMPLETE verification: initial focused runs exit0, final selected15 assertions pass/nativechild0 but router exit3 with evidence custody partial. No Bun activation.",
  "limits": [
    "Node active. No cutover, live canonical accepted grade, production signature, immutable candidate package, actual installed platform, or final shipment claimed.",
    "Canonical acceptance tests mock PG. Compiled subprocess tests generate fixture Ed25519 keys; signer test uses installed actual Tauri CLI2.11.0 with generated fixture key.",
    "Offline proof is canonical eligibility AT ISSUANCE through signed expiry; disconnected later revocation is unknowable.",
    "All13 source hashes are collection-time only. Source maps capture dirty checkout, watched in-process inputs only; child/esbuild input graph + worker/runtime/config remain opaque. Never promote collection hashes to retrospective closure evidence.",
    "Initial62pass0skip/substitution0 and issuer1pass53deliberatelyunselected and initialboot4pass32deliberatelyunselected are separate local measurements. Desktop47pass, native signer/build-key2pass, installer-route1pass. Do not sum into universal coverage.",
    "Final15pass comprises11offline tests +4actualBun handoff controls;32 deliberately unselected. Native child exit0; parent3 finalizationError=true due missing codeRef for detached-imports/index.ts evaluator pin (sha d3cd191a44087aae908b54187a71045a45763dc49fb1235ff03536d481ba7a04 byteLength8902). Owned EI-27654977482800018. Not clean verification.",
    "Named core+operator types and final2 core types clean/native0. Shell bash-n and scoped git diff --check exit0. No unchanged old59/61suite rerun.",
    "dev:pipeline_position candidate-install-upgrade currentBuildTestRoute readiness:gap; requires owned candidate install target and previous/rollback target plus signing/install credentials. Neither staging service nor final release substitutes.",
    "Full ordinary GUI/Server/WindowsWSL/native10cell/nativeguards/proofwriter/60minsoak/singleowner/forcedrollback/independentgrade+author/defaultswitch/exactfinalship/7day retained Node remain open."
  ],
  "followups": [
    "EI-27654977482800018 (assigned original0dcd3): fix evaluator archive/custody class before authoritative acceptance proof",
    "EI-27649359135482070: native PreToolUse transport walls measured1504ms/timeout1500; diagnostic guard reads HTTP200 in78/80ms; root cause unconfirmed"
  ]
}
