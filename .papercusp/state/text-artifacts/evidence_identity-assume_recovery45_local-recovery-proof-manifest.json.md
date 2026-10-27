---
rel_path: "evidence/identity-assume/recovery45/local-recovery-proof-manifest.json"
updated_at: 1792924847033
_body: "content"
---

{
  "workItem": "WI-6554700010025439",
  "bug": "EI-26945342104332409",
  "status": "local diagnostic only; not committed certification",
  "rootCause": "Native startup advances same-inode transcript; strict whole-target equality rejects owned unexpired retry. Distinguishing snapshot changedFields=[context], writerfree/nohost, all binding/writerGeneration unchanged.",
  "fix": "Separate durable CAS startup attempt from immutable prepared context; authenticate original same-inode prefix only under authorized attempt and enforce prior PTY incarnation exit before next generation. Keep reservation/writer/host/binding guards.",
  "artifacts": [
    "evidence/identity-assume/recovery45/assume45-advanced-source-map.json.startup-custody.jsonl.gz.b64",
    "evidence/identity-assume/recovery45/assume45-fixed-native-source-map.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-fixed-pg-source-map.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-unit-source-map.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-unit-source-map.1.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-final-launcher-source-map.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-host-witness-source-map.json.gz.b64",
    "evidence/identity-assume/recovery45/assume45-host-witness-source-map.1.json.gz.b64"
  ],
  "results": [
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-fixed-native-source-map.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "apps/operator/lib/psu-identity-assume-native.integration.test.ts",
          "passed": 1,
          "failed": 0,
          "skipped": 12
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-fixed-pg-source-map.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
          "passed": 58,
          "failed": 0,
          "skipped": 0
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-unit-source-map.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable",
        "stable"
      ],
      "execution": [
        {
          "testFile": "packages/operator-core/lib/session-assume-runtime-host.test.ts",
          "passed": 14,
          "failed": 0,
          "skipped": 0
        },
        {
          "testFile": "packages/operator-core/lib/session-assume-preparation.test.ts",
          "passed": 12,
          "failed": 0,
          "skipped": 0
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-unit-source-map.1.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "apps/operator/lib/psu-identity-assume.test.ts",
          "passed": 23,
          "failed": 0,
          "skipped": 0
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-final-launcher-source-map.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "apps/operator/lib/psu-identity-assume.test.ts",
          "passed": 23,
          "failed": 0,
          "skipped": 0
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-host-witness-source-map.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "apps/operator/lib/psu-pty-host.integration.test.ts",
          "passed": 1,
          "failed": 0,
          "skipped": 136
        }
      ]
    },
    {
      "artifact": "evidence/identity-assume/recovery45/assume45-host-witness-source-map.1.json.gz.b64",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "sourceStatus": [
        "stable"
      ],
      "execution": [
        {
          "testFile": "apps/operator/lib/psu-pty-host.test.ts",
          "passed": 2,
          "failed": 0,
          "skipped": 630
        }
      ]
    }
  ],
  "receipts": [
    {
      "file": "assume45-fixed-native-receipt.json",
      "status": "pass",
      "outcome": "inserted",
      "id": "21996695"
    },
    {
      "file": "assume45-fixed-pg-receipt.json",
      "status": "pass",
      "outcome": "inserted",
      "id": "21996696"
    },
    {
      "file": "assume45-final-launcher-receipt.json",
      "status": "pass",
      "outcome": "inserted",
      "id": "21996988"
    }
  ],
  "remaining": [
    "final typecheck running; all declared changes still need clean committed proof",
    "full native13 and race mutant",
    "six clause evidence bindings/adequacy",
    "P002/P003/P004 independent acceptance and shipment",
    "WI-6554700010028609 source cast fixed; repo lint still names peer paths; do not claim global lint green"
  ]
}
