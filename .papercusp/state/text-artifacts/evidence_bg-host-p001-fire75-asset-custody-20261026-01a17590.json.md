---
rel_path: "evidence/bg-host-p001-fire75-asset-custody-20261026-01a17590.json"
updated_at: 1792975691839
_body: "content"
---

{
  "schemaVersion": "bg-p001-asset-custody-proof-v1",
  "createdAt": "2026-10-26T00:48:08.246Z",
  "owner": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
  "nativeThread": "01a17590-5567-79b0-a6e3-066161a2fa37",
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "item": "P-001",
  "scope": "Detached original-transaction ancillary-file custody. P001 remains open; production command/asset selection and runtime acceptance are incomplete.",
  "changes": [
    "Original transaction can nominate source-censused ancillary file copies. Membership is validated before exclusive stage creation, including source census, traversal, PID token, duplicate and directory collisions.",
    "stageBgVerifierAssetCopies verifies the original source buffer digest and stable descriptor, writes those same bytes exclusively through physical directories, and refuses existing destinations.",
    "Whole-output qualification includes the exact ancillary file population, rejects non-independent or altered files, and logical/publication verification retains their original bytes and inode custody.",
    "Output-only recipe stages copies after all original compiler invocations and before whole-output qualification. No service activation or live-gate operation."
  ],
  "tests": [
    {
      "testRunId": 22085400,
      "result": "pass",
      "passed": 12,
      "failed": 0,
      "filtered": 377,
      "childSubstituted": 0,
      "pattern": "BG ancillary asset custody",
      "routerProvenance": "stamped named-path local dirty scope only",
      "qualification": "After this run only the receipts array's TypeScript annotation changed in the test file; behavioral source did not change."
    },
    {
      "testRunId": 22086203,
      "result": "pass",
      "passed": 5,
      "failed": 0,
      "filtered": 384,
      "childSubstituted": 0,
      "pattern": "BG recipe output-only|qualifies the whole-output set|logical-output qualification retains",
      "routerProvenance": "unknown: HEAD moved, imported source radius unmeasured; local behavioral evidence only"
    }
  ],
  "typechecks": {
    "finalCommand": "npm run lint:tsc -- --files=scripts/source-preview.d.mts,packages/operator-core/lib/source-preview-export.test.ts",
    "exitCode": 0,
    "scriptsNamedErrors": 0,
    "operatorNamedErrors": 0,
    "qualification": "Three diagnostics in two unrelated files remain outside the named scope. Initial mjs-only scripts run was out-of-scope; corrected to the owned declaration. Initial operator test array implicit-any diagnostics fixed with a type annotation."
  },
  "metrics": {
    "files": {
      "scripts/source-preview.mjs": {
        "sha256": "c9bfcdef465e430e312bea89e88eec94426a9c36bf3a3f44dbae3d8339e4eb1c",
        "bytes": 207194
      },
      "scripts/source-preview.d.mts": {
        "sha256": "bd469342310c6ab71726caa5763b17f3b5d784e75b16891cbfe65aea8cc36ad1",
        "bytes": 95364
      },
      "packages/operator-core/lib/source-preview-export.test.ts": {
        "sha256": "e5a548f84302b9801881d3b020e8014dd7c1b02120939aba92e322770327eef3",
        "bytes": 225653
      },
      "apps/operator/bin/bundle-host.sh": {
        "sha256": "1c79a34f8edda032ecd246ce39082781ef1a95a39697e7bfd9b2eef5d34908f3",
        "bytes": 56204
      }
    },
    "logs": {
      "/tmp/bg-host-fire75-assets-20261026.log": {
        "sha256": "4e2df89d6a5620ed3fa892947238d560c7859daed15200260661173355295d86",
        "bytes": 159754,
        "summary": [
          " Test Files  1 passed (1)",
          "      Tests  12 passed | 377 skipped (389)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=ed29bd33d5 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-26T00:33:02.900Z childSubstituted=0 skippedTests=377"
        ]
      },
      "/tmp/bg-host-fire75-regression-20261026.log": {
        "sha256": "030bc43ed354aaa03d2d68d1da9b8d43a998179f29d6328f02d2aa6467602809",
        "bytes": 159735,
        "summary": [
          " Test Files  1 passed (1)",
          "      Tests  5 passed | 384 skipped (389)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=95cda52a37 uncommittedPaths=1/1 provenance=unknown startedAt=2026-10-26T00:41:35.357Z childSubstituted=0 skippedTests=384"
        ]
      },
      "/tmp/bg-host-fire75-final-tsc-20261026.log": {
        "sha256": "52976bde9c30ba89bbde376491b6555d853f51ec14f096edc54156d5fdb9ff2d",
        "bytes": 4910,
        "summary": [
          "✓ gen:declarations: emitted 1 of 148 declaration file(s) — compiler: node_modules/typescript/lib/tsc.js",
          "TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=316 checkMs=2529 snapshotAgeMs=2529",
          "LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-10-26T00:39:11.841Z head=30d105b746",
          "✓ gen:declarations: emitted 1 of 148 declaration file(s) — compiler: node_modules/typescript/lib/tsc.js",
          "TSC_SERVICE used=1 checked=128 named=2 typeReferencing=0 importers=126 errors=3 queuedMs=2266 checkMs=8503 snapshotAgeMs=8503",
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-10-26T00:38:54.358Z head=30d105b746"
        ]
      },
      "/tmp/bg-host-fire75-declarations-check-20261026.log": {
        "sha256": "87226833b9310e62dcb2b0abc78befbe11ad3533e4b6005ab4d11d797ca9ec6a",
        "bytes": 370,
        "summary": [
          "✓ gen:declarations:check: 1 of 148 declaration file(s) up to date; hand-written declarations match their sources; no importer suppresses a declared module"
        ]
      }
    }
  },
  "limits": [
    "Caller-retained ancillary population is executable, but complete production command/population capture and directory expansion are not yet implemented.",
    "Resolver metadata, compiler self-consumption, closed workspace/dependency/external/runtime imports and R4 remain incomplete.",
    "REAL original parent manifest remains UNKNOWN. Actual preparation/activation is prohibited.",
    "D014 plan version16 versus activation audit13 requires a delta audit before further canonical activation/acceptance.",
    "No commit containment, serving runtime custody, deployment, new gate verdict, or canonical independent acceptance is claimed."
  ],
  "priorProofs": [
    "evidence/bg-host-p001-fire74-recipe-output-20261026.json",
    "evidence/bg-host-p001-fire73-logical-publication-20261025.json",
    "evidence/bg-host-through-fire73-wip-952a8aae234b-20261025.md"
  ],
  "next": "Use maintained bundle-host/common recipe to generate the full original compiler and ancillary population without duplicating its lists; finish resolver/toolchain/runtime closure. Preserve original authority and blocked parent claims."
}
