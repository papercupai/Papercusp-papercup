---
rel_path: "verification/WI-10006424/fire156-imported-types-proof.json"
updated_at: 1791269515349
_body: "content"
---

{
  "scope": "WI-10006424 local source repair only",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "measuredHead": "f7abe91dfde1a5867ac1573e9a5d4ea8e50af796",
  "blobs": {
    "packages/operator-core/lib/external-bench/competitor-live.ts": "0089f41cc07e66239f84d3fa2a5d96a2e738a4cf",
    "packages/operator-core/lib/external-bench/competitor-live.test.ts": "711dbb2402dbfc007cb8f05cf7affea021ec659b",
    "packages/operator-core/lib/inference-gateway/observability.test.ts": "08c6d07ea1fe0fcac1aaf09f821686f06f0d9502"
  },
  "commands": {
    "tests": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/external-bench/competitor-live.test.ts packages/operator-core/lib/inference-gateway/observability.test.ts",
    "types": {
      "tool": "build:typecheck",
      "args": {
        "project": "packages/operator-core",
        "files": [
          "packages/operator-core/lib/external-bench/competitor-live.ts",
          "packages/operator-core/lib/external-bench/competitor-live.test.ts",
          "packages/operator-core/lib/inference-gateway/observability.test.ts"
        ],
        "scopeToFiles": true,
        "maxErrors": 5
      }
    }
  },
  "before": {
    "tests": "2FAIL 30PASS 0SKIP; both files executed",
    "runIds": [
      20828358,
      20828357
    ],
    "logs": [
      "/tmp/fire156-imported-types-before.log"
    ],
    "observations": [
      "Each of three default runner inputs lacked model; explicit override control passed",
      "Default fixture projected healthyAccounts undefined",
      "Compiler reproduced two requested TS2322; after health supplied it exposed missing billing; AST source comparison confirmed billing omitted"
    ]
  },
  "after": {
    "tests": "32PASS 0FAIL 0SKIP; 2 requested/executed",
    "runIds": [
      20828405,
      20828406
    ],
    "logs": [
      "/tmp/fire156-imported-types-final2.log"
    ],
    "source": "local",
    "harness": "papercusp",
    "dirty": true,
    "runGroup": null,
    "types": "tsc-service requested-files-clean, 3 named/26 checked, requested 0/other 0/unattributed 0/exit0",
    "diffCheck": "PASS"
  },
  "residue": {
    "id": "EI-25211799735268940",
    "assignee": "su-aa2d6526-7743-44c8-85f9-edc95df6da16",
    "finding": "Existing competitor binding separately omits thinkingBudgetTokens/maxTokens; source observation, runtime reproduction not yet performed",
    "dedupCoverage": "degraded/unavailable; absence of prior work not established"
  },
  "limits": [
    "No paid calls; injected ExecFn and gateway fetches",
    "No full project/gate verdict",
    "No complete imported-graph identity or shipped-artifact proof",
    "Native WI-10006164 remains open"
  ]
}
