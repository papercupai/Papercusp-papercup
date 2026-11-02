---
rel_path: "runtime-migration/p006-baseline-checker-root-repair-0dcd3-20261102.json"
updated_at: 1793609039067
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "source-compatibility-repair",
  "workItem": "EI-27664259679585995",
  "rootCause": "Current producer invoked its ptool SDK checker from frozen product ROOT/bin, which predates the newer checker.",
  "repair": "Resolve checker from producer HERE; check that current helper is readable before dependency or UI builds.",
  "test": {
    "command": "node --test --test-global-setup=test/monorepo-host-preflight.mjs test/check-ptool-sdk-bundle.test.js",
    "cwd": "papercusp-desktop",
    "taskId": "0mvz052mm1m7019v1ht",
    "exitCode": 0,
    "passed": 7,
    "failed": 0,
    "skipped": 0,
    "log": ".papercusp/scratch/bash-0e84ba42-7fa.log",
    "cases": [
      "Missing current helper refuses before UI/dependency work.",
      "Actual caller qualifies real standalone bundled ptool against empty older target.",
      "Mutant changing HERE back to frozen ROOT fails MODULE_NOT_FOUND.",
      "Computed SDK loader, missing table, CLI bootstrap and contaminated isolation negative controls remain rejected."
    ]
  },
  "audit": {
    "sourceInputs": "Frozen WEB_DIR bundle-host-common retains product import graph; current missing-recipe adapters remain in place.",
    "productPreload": "ROOT/bin/sidecar-preload.js is shipped product code and exists in retained baseline.",
    "nextPrecondition": "Direct current checker on actual baseline failed-stage ptool refuses missing PTOOL_SDK_MODULE_LOADERS. No further full producer rerun until retained-loader compatibility is resolved."
  },
  "residue": [
    {
      "id": "EI-27664931934067649",
      "assignee": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
      "scope": "Historical computed SDK loader lacks current standalonefile contract; maintained compatibility route required."
    }
  ],
  "sourcePaths": [
    "papercusp-desktop/bin/build-desktop-sidecar.sh",
    "papercusp-desktop/test/check-ptool-sdk-bundle.test.js"
  ],
  "sourceHashes": "Not measured in this proof; read actual test/caller and task transcript. Post-test read-only hashing command refused by pretool execution-authority lookup timeout; no proof inferred from refusal.",
  "limits": [
    "Source-root helper repair only.",
    "Baseline full producer, final signed pairs, installed matrix, native/BAR/rollback/soak/shipment remain open."
  ]
}
