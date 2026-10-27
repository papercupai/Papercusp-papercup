---
rel_path: "evidence/native-d046-guarded-route-20261026.json"
updated_at: 1792999014389
_body: "content"
---

{
  "schema": "native-guarded-method-route-v1",
  "workItem": "WI-6554700010012117",
  "measuredAt": "2026-10-26T07:06:29.458Z",
  "authority": "native-code-intelligence-ecosystem-and-dream-2026-10-09#D-046",
  "sourceProof": "evidence/native-d045-eligibility-immutable-f1e47c8fe156-2026-10-25.json",
  "rows": [
    {
      "path": "packages/operator-core/lib/agent-tools/consult/get-feedback.ts",
      "expected": "2973e49294540687c8807a0d8abda173f68834f4e0f54223f4b6ba674782248f",
      "accepted": {
        "expectedSha256": "2973e49294540687c8807a0d8abda173f68834f4e0f54223f4b6ba674782248f",
        "observedSha256": "2973e49294540687c8807a0d8abda173f68834f4e0f54223f4b6ba674782248f",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/consult/consult-dispatch.ts",
      "expected": "1c6b3dffc699b5436f8e7b0830b3b7fbd26cffa02e604608bbf1fc7eaddf0aff",
      "accepted": {
        "expectedSha256": "1c6b3dffc699b5436f8e7b0830b3b7fbd26cffa02e604608bbf1fc7eaddf0aff",
        "observedSha256": "1c6b3dffc699b5436f8e7b0830b3b7fbd26cffa02e604608bbf1fc7eaddf0aff",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/consult/get-feedback-core.ts",
      "expected": "2727079f5c22d2b13b755c5aaf382e8e1f448c482044f9b82c0f98c5e75cf975",
      "accepted": {
        "expectedSha256": "2727079f5c22d2b13b755c5aaf382e8e1f448c482044f9b82c0f98c5e75cf975",
        "observedSha256": "2727079f5c22d2b13b755c5aaf382e8e1f448c482044f9b82c0f98c5e75cf975",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/consult/get-feedback-prod.ts",
      "expected": "8d6560b8b51d0cb8708fba0c29fdc995a4547c636f7d575a251337bbf7f201e3",
      "accepted": {
        "expectedSha256": "8d6560b8b51d0cb8708fba0c29fdc995a4547c636f7d575a251337bbf7f201e3",
        "observedSha256": "8d6560b8b51d0cb8708fba0c29fdc995a4547c636f7d575a251337bbf7f201e3",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/consult/relevance-router.ts",
      "expected": "852c301599f804f18bc1d3f80bcb828b767a2434ff81019becc0a9e956bec656",
      "accepted": {
        "expectedSha256": "852c301599f804f18bc1d3f80bcb828b767a2434ff81019becc0a9e956bec656",
        "observedSha256": "852c301599f804f18bc1d3f80bcb828b767a2434ff81019becc0a9e956bec656",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/consult/selection-policies.ts",
      "expected": "b42c25c73eb58f849ae14672bc1c13ff505deba025996175684ec48edce9bc94",
      "accepted": {
        "expectedSha256": "b42c25c73eb58f849ae14672bc1c13ff505deba025996175684ec48edce9bc94",
        "observedSha256": "b42c25c73eb58f849ae14672bc1c13ff505deba025996175684ec48edce9bc94",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": true,
          "gateway": false
        }
      },
      "runtimes": [
        {
          "runtime": "release-operator",
          "pid": 3041049,
          "buildSha": "d740fc3802",
          "containsChange": false,
          "method": "blob"
        },
        {
          "runtime": "staging-operator",
          "pid": 2820353,
          "buildSha": "a10a17b808",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "bg-host",
          "pid": 3923637,
          "buildSha": "1317f4e4ea",
          "containsChange": true,
          "method": "blob"
        },
        {
          "runtime": "gateway",
          "pid": 1328394,
          "buildSha": "733ca29978",
          "containsChange": false,
          "method": "start-after-mtime"
        }
      ]
    }
  ],
  "framing": {
    "path": "packages/operator-core/lib/consult/responder-verb-menu.ts",
    "sha256": "16a0410da9a33275eaef69cfe50a593f965928397516ca4c6033250ec739c322",
    "matches": true,
    "runtimeContainment": {
      "staging-operator": true,
      "bg-host": true,
      "release-operator": false,
      "gateway": false
    },
    "method": "blob"
  },
  "rawSixFileProof": {
    "uri": "papercusp://scratch/papercusp-workspace/code:run/2fcb3601-39e6-4aa4-9056-da7099345752/raw-summary-1792998389458.json",
    "sha256": "ac6e972f7b316f8468b9eb6fbb91de1985460e8a4c419b1b87887b099a6fbd79",
    "bytes": 5458
  },
  "limits": [
    "Source/runtime containment is not observed reviewer delivery, independence, METHOD approval, or shipment.",
    "D044 request consumed; no new request authorized by this evidence.",
    "D013 ceiling/custody/execution/release and unidentified carry-action holds remain.",
    "No source census or source80/native/provider/release operation performed."
  ]
}
