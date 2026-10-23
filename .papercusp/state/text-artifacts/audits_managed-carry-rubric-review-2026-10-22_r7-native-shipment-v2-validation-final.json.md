---
rel_path: "audits/managed-carry-rubric-review-2026-10-22/r7-native-shipment-v2-validation-final.json"
updated_at: 1792713836907
_body: "content"
---

{
  "draft": "artifact:papercusp:audits/managed-carry-rubric-review-2026-10-22/r7-native-shipment-v2-draft.json",
  "draftExactReadbackChars": 23536,
  "draftApplied": false,
  "governingReviewerPost": 1197459,
  "reviewThreadState": "closed_answered",
  "tests": {
    "live": {
      "id": 21793347,
      "passed": 59
    },
    "shipment": {
      "id": 21793371,
      "passed": 25
    },
    "scorecards": {
      "id": 21793348,
      "passed": 9
    },
    "postgres": {
      "id": 21793625,
      "passed": 2
    },
    "registry": {
      "passed": 50,
      "phase": "earlier registry-only run"
    }
  },
  "proofQualification": "Local, worktreeDirty true; not deployed acceptance. Real PG queries/assertions passed; fixture teardown corrected to drop and rerun exit0.",
  "types": {
    "sixFile": "exit0 at c7a5020128",
    "threeFilePostSql": "exit0, LINT_TSC_RESULT operator-core files3 clean at2026-10-22T23:54:43.949Z head a0b17c632f"
  },
  "fingerprints": {
    "head": "a0b17c632f0f810b8e1577bfd8fef20db6da125d",
    "sha256": {
      "packages/operator-core/lib/cold-boot-drill.ts": "f055c969735d7a4028c6d545b5ed5501c502e94964908ba229112d6cbfa8abea",
      "packages/operator-core/lib/cold-boot-drill-live.ts": "f315b136d0912a0f817c3508f1e149a74f4b966ac339bd4ca465176b93a016d1",
      "packages/operator-core/lib/cold-boot-drill-live.test.ts": "90c669029c57a67cd139aca9828e605a9b7fae6675ebb888048fc554510b34b3",
      "packages/operator-core/lib/carry-drill-shipment.ts": "3aee2609cc94b9c3afa9a60179f88450c796643ff54cc24bf325fa8c239e6e80",
      "packages/operator-core/lib/carry-drill-shipment.test.ts": "8b3964dabdeaf3361a66fd550ba5f2a206b02490743b7022297efd4297d29171",
      "packages/operator-core/lib/carry-drill-shipment.integration.test.ts": "b721eb75930cc39ef33d8dd4785b4c63f9938fd4f31119a89c95d460c7611bd9",
      "packages/operator-core/lib/rubric-instrument-registry.ts": "fd0be6914ed1a7a6fc6cdd992641d2c978ffb41bdc3657c7bc02113ead72965a",
      "packages/operator-core/lib/rubric-instrument-registry.test.ts": "43c4304eeb7e902b5d99c86f8204ac6750164be414618fc0617c6d737b120e4c",
      "packages/operator-core/lib/scorecards.ts": "bfd3efb7ab79576f29a30665ef3ee72ad9be51039218d2f38557f93d3b0886b1",
      "packages/operator-core/lib/scorecards-carry-drill-instruments.test.ts": "7655e29aa78131d72eea1dba8b1e2e38d0213ab4e77b78f14f3e4e26fca343b7"
    }
  },
  "next": "All native commands drained. Bounded exact resource-release wake351419 pending; then verify containing commit/current-build and route supported amendment+new exact-revision rubric vetting. No current R7 pass/shipment."
}
