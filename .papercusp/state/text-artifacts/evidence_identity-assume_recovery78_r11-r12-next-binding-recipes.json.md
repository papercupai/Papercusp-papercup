---
rel_path: "evidence/identity-assume/recovery78/r11-r12-next-binding-recipes.json"
updated_at: 1793032757566
_body: "content"
---

[
  {
    "specId": "AUTO-BAR-R-11-P-001",
    "specRevision": 3,
    "workItemId": "WI-6554700010025439",
    "sourcePaths": [
      "apps/operator/scripts/psu-identity-assume.mjs",
      "apps/operator/scripts/psu-launcher.mjs",
      "apps/operator/scripts/psu-pty-host.mjs",
      "packages/operator-core/lib/adv-sessions.ts",
      "packages/operator-core/lib/session-assume-caller.ts",
      "packages/operator-core/lib/session-assume-custody.ts",
      "packages/operator-core/lib/session-assume-preparation.ts",
      "packages/operator-core/lib/session-assume-store.ts",
      "packages/operator-core/lib/session-assume.ts"
    ],
    "fixturePaths": [
      "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "packages/operator-core/test/_org-test-db.ts"
    ],
    "details": {
      "adequacy": {
        "outcome": "caught",
        "skipped": false,
        "executed": true,
        "targeted": "AUTO-BAR-R-11-P-001",
        "collected": true,
        "testLayer": "integration",
        "falsifiable": true,
        "testCases": [
          "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance"
        ]
      }
    },
    "oldRun": 22133595
  },
  {
    "specId": "AUTO-BAR-R-12-P-001",
    "specRevision": 3,
    "workItemId": "WI-6554700010025439",
    "sourcePaths": [
      "apps/operator/scripts/psu-identity-assume.mjs",
      "apps/operator/scripts/psu-launcher.mjs",
      "apps/operator/scripts/psu-pty-host.mjs",
      "packages/operator-core/lib/adv-sessions.ts",
      "packages/operator-core/lib/session-assume-caller.ts",
      "packages/operator-core/lib/session-assume-custody.ts",
      "packages/operator-core/lib/session-assume-preparation.ts",
      "packages/operator-core/lib/session-assume-store.ts",
      "packages/operator-core/lib/session-assume.ts"
    ],
    "fixturePaths": [
      "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "packages/operator-core/test/_org-test-db.ts"
    ],
    "details": {
      "adequacy": {
        "outcome": "caught",
        "skipped": false,
        "executed": true,
        "targeted": "AUTO-BAR-R-12-P-001",
        "collected": true,
        "testLayer": "integration",
        "falsifiable": true,
        "testCases": [
          "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots"
        ]
      }
    },
    "oldRun": 22133652
  }
]
