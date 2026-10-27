---
rel_path: "evidence/luna-capacity/R1-R3-339c94-bind-draft-20261024.json"
updated_at: 1792820951786
_body: "content"
---

{
  "status": "draft-not-bound",
  "candidateCommit": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
  "bindingArgs": {
    "harness": "papercusp",
    "slug": "luna-drain-capacity-recovery-2026-10-23",
    "items": [
      {
        "workItemId": "WI-6554700010025535",
        "specId": "LUNA-CAPACITY-001",
        "specRevision": 2,
        "fromTestRun": 21869294,
        "fixturePaths": [
          "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "packages/operator-core/test/_pg-helpers.ts",
          "packages/operator-core/test/_work-items-schema.ts",
          "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
          "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
          "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
          "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql"
        ]
      },
      {
        "workItemId": "WI-6554700010025535",
        "specId": "LUNA-CAPACITY-001",
        "specRevision": 2,
        "fromTestRun": 21869226,
        "fixturePaths": [
          "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
        ]
      },
      {
        "workItemId": "WI-6554700010025535",
        "specId": "AUTO-BAR-R-1-P-001",
        "specRevision": 3,
        "fromTestRun": 21869294,
        "fixturePaths": [
          "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "packages/operator-core/test/_pg-helpers.ts",
          "packages/operator-core/test/_work-items-schema.ts",
          "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
          "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
          "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
          "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql"
        ]
      },
      {
        "workItemId": "WI-6554700010025535",
        "specId": "AUTO-BAR-R-1-P-001",
        "specRevision": 3,
        "fromTestRun": 21869226,
        "fixturePaths": [
          "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
        ]
      },
      {
        "workItemId": "WI-6554700010025537",
        "specId": "LUNA-CAPACITY-003",
        "specRevision": 2,
        "fromTestRun": 21869227,
        "fixturePaths": [
          "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
        ]
      },
      {
        "workItemId": "WI-6554700010025537",
        "specId": "AUTO-BAR-R-3-P-003",
        "specRevision": 2,
        "fromTestRun": 21869227,
        "fixturePaths": [
          "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
        ]
      }
    ]
  },
  "proof": {
    "integration": {
      "testRunId": 21869294,
      "passed": 51,
      "failed": 0,
      "skipped": 0,
      "receiptPath": "/tmp/luna-R1-339c94-private-receipt.json",
      "receiptSha256": "c1c25d0549015330cadc7dcf244d0adb3e98243c642245adb259e9f3e4a240e3",
      "logPath": "/tmp/luna-R1-339c94-private-integration.log",
      "nativeSession": 7313,
      "exitCode": 0,
      "privatePgDataDirRemoved": true
    },
    "unit": {
      "testRunIds": [
        21869226,
        21869227
      ],
      "passed": 300,
      "skipped": 0,
      "logPath": "/tmp/luna-R1-R3-339c94-immutable-units.log",
      "nativeSession": 56392,
      "exitCode": 0
    }
  },
  "notes": [
    "No bind/currentness/adequacy or shipment claimed.",
    "Refresh schema and use qualified current runtime; server derives source imports. Inspect derived source closure and first-bind fixtures before acceptance.",
    "Original R4 draft and six passing run references remain unchanged.",
    "Shared-storage root defect remains owned EI-26838146234841358; private PG is a task-local recovery."
  ]
}
