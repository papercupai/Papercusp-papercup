---
rel_path: "runtime-migration/p004-hook-import-c5b20-20261026.json"
updated_at: 1793040342188
_body: "content"
---

{
  "schema": "bun-p004-hook-import-proof-v1",
  "owner": "su-c5b20036-1420-45e1-a14b-60fd21571af8",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022070",
  "bug": "EI-27067912305139455",
  "acceptance": false,
  "nodeRemainsActive": true,
  "sourceHeadAtCollection": "82c8e15b190f87c57cabedfc5035d03589152982",
  "sources": {
    "packages/operator-core/lib/tool-delivery-clean-runtime.ts": "f9ddd51797efae3a72bea134bb07a273c4817c0931c3567a7d6dc7e7f3d4c3ca",
    "packages/operator-core/lib/tool-delivery-clean-runtime.test.ts": "19eeec5595ef2cb878be4fcbced4eb91f8c8b691097cb66a337de34ff3ea5f59"
  },
  "files": {
    "/tmp/bun-c5b20-boot-import-initial.log": "21e2402a7039b2efcd15e38ec2a8857a9ae89a9bf4760a0645c3b93a914ba057",
    "/tmp/bun-c5b20-clean-hook-red2.log": "e6966cb603ae468fdd06f5c51cd47fa56b890da4599d14edfa89274b6331ba8f",
    "/tmp/bun-c5b20-clean-hook-red2-receipt.jsonl": "549707c7bfe948a43c8a0f1d0ed2e6f59cf0047776f2d12d5eb7a18dfcf43748",
    "/tmp/bun-c5b20-clean-hook-green.log": "1c16c618876026c0c9016da074e879eb401c0b116ba1ffd6429b0734c0575511",
    "/tmp/bun-c5b20-clean-hook-green-receipt.jsonl": "a2ce1d56c9acd15645b811ee9efb1d7de05884255028a30923a12e5e3c6ba7c9",
    "/tmp/bun-c5b20-clean-hook-green-source.json": "f22ca567b836fde8f42aba725b5950c95db20b935e3bf8141da71bf564dd1689",
    "/tmp/bun-c5b20-boot-import-after-hook.log": "a95cfe2f404ed6f6e501c338e35f16094979ef70eaeb48ad0ee18c92405f27c0",
    "/tmp/bun-c5b20-clean-hook-types3.log": "6d0deaf246a9a390d5ff8a8c24248a20db9b1b7aea720eb83eebcb27dce54215"
  },
  "bun": {
    "path": "/home/marsh-office/.bun/bin/bun",
    "version": "1.3.14",
    "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74"
  },
  "results": {
    "initialBoot": {
      "exit": 1,
      "failure": "Export named registerHooks not found in node:module"
    },
    "correctedRed": {
      "exit": 1,
      "passed": 1,
      "failed": 2,
      "unselected": 66,
      "testRunId": 22247515
    },
    "fullRegression": {
      "exit": 0,
      "passed": 69,
      "skipped": 0,
      "childSubstituted": 0,
      "testRunId": 22247518
    },
    "bootAfter": {
      "exit": 0,
      "marker": "PAPERCUSP_BOOT_IMPORTS_OK"
    },
    "types": {
      "exit": 0,
      "scope": "two named source/test files",
      "verdict": [
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-26T18:41:44.081Z head=82c8e15b19"
      ]
    }
  },
  "rootCause": "Node-only synchronous module hook imported as a named ESM export by a module containing pure validators in the eager tool registry closure. Bun rejects the import before any tool can run.",
  "fix": "Use namespace access for optional runtime export; reject Bun or missing synchronous hook capability before filesystem access; preserve Node resolve hook containment enforcement. Existing clean cohort retains its Node controller.",
  "limits": [
    "Source and import-readiness proof only; no database-backed host, packaged candidate or platform acceptance.",
    "Source test execution has dirty checkout; named source hashes and captured source-map receipt are retained, global executed-source map not persisted.",
    "Corrected red fixture externalizes production optional packages; initial red attempt was confounded by bundler resolution errors."
  ]
}
