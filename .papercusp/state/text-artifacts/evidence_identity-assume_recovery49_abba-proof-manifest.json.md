---
rel_path: "evidence/identity-assume/recovery49/abba-proof-manifest.json"
updated_at: 1792930596592
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "P001 Recovery49 installed-native matched return-item-ID experiment",
  "verdict": "All four ABBA arms pass A/B/C/D/E. Duplicate item ID is not supported as the cause by this bounded experiment. Both original roots remain unconfirmed and owned. No protocol behavior change applied.",
  "runs": [
    {
      "arm": 1,
      "identity": "duplicate",
      "testRunId": "22004974",
      "outcome": "inserted",
      "execution": {
        "passed": 1,
        "failed": 0,
        "skipped": 13,
        "collectionFailed": false,
        "passedCaseTitles": [
          "uses production custody and routed responsibilities through the installed native handoff (checkpoint)"
        ]
      },
      "terminalHook": "onTestRunEnd",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "fixtureSha256": "2b7cc552bf13d5807f51f21456ef3381b347ff5b6afd7ac45017a22ca1037c6c",
      "taskComplete": "2026-10-25T12:09:08.571Z",
      "milestones": [
        {
          "stage": "A-provider-received-target-result",
          "atMs": 1792930147069
        },
        {
          "stage": "B-return-call-emitted",
          "atMs": 1792930147193
        },
        {
          "stage": "C-return-tool-result",
          "atMs": 1792930148539
        },
        {
          "stage": "D-provider-received-return-result",
          "atMs": 1792930148562
        },
        {
          "stage": "E-target-native-exit-after-completion",
          "atMs": 1792930149363
        }
      ]
    },
    {
      "arm": 2,
      "identity": "unique",
      "testRunId": "22004976",
      "outcome": "inserted",
      "execution": {
        "passed": 1,
        "failed": 0,
        "skipped": 13,
        "collectionFailed": false,
        "passedCaseTitles": [
          "uses production custody and routed responsibilities through the installed native handoff (checkpoint)"
        ]
      },
      "terminalHook": "onTestRunEnd",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "fixtureSha256": "2b7cc552bf13d5807f51f21456ef3381b347ff5b6afd7ac45017a22ca1037c6c",
      "taskComplete": "2026-10-25T12:10:09.862Z",
      "milestones": [
        {
          "stage": "A-provider-received-target-result",
          "atMs": 1792930208670
        },
        {
          "stage": "B-return-call-emitted",
          "atMs": 1792930208748
        },
        {
          "stage": "C-return-tool-result",
          "atMs": 1792930209828
        },
        {
          "stage": "D-provider-received-return-result",
          "atMs": 1792930209853
        },
        {
          "stage": "E-target-native-exit-after-completion",
          "atMs": 1792930210581
        }
      ]
    },
    {
      "arm": 3,
      "identity": "unique",
      "testRunId": "22004982",
      "outcome": "inserted",
      "execution": {
        "passed": 1,
        "failed": 0,
        "skipped": 13,
        "collectionFailed": false,
        "passedCaseTitles": [
          "uses production custody and routed responsibilities through the installed native handoff (checkpoint)"
        ]
      },
      "terminalHook": "onTestRunEnd",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "fixtureSha256": "2b7cc552bf13d5807f51f21456ef3381b347ff5b6afd7ac45017a22ca1037c6c",
      "taskComplete": "2026-10-25T12:11:23.811Z",
      "milestones": [
        {
          "stage": "A-provider-received-target-result",
          "atMs": 1792930282592
        },
        {
          "stage": "B-return-call-emitted",
          "atMs": 1792930282708
        },
        {
          "stage": "C-return-tool-result",
          "atMs": 1792930283780
        },
        {
          "stage": "D-provider-received-return-result",
          "atMs": 1792930283803
        },
        {
          "stage": "E-target-native-exit-after-completion",
          "atMs": 1792930284493
        }
      ]
    },
    {
      "arm": 4,
      "identity": "duplicate",
      "testRunId": "22004995",
      "outcome": "inserted",
      "execution": {
        "passed": 1,
        "failed": 0,
        "skipped": 13,
        "collectionFailed": false,
        "passedCaseTitles": [
          "uses production custody and routed responsibilities through the installed native handoff (checkpoint)"
        ]
      },
      "terminalHook": "onTestRunEnd",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "fixtureSha256": "2b7cc552bf13d5807f51f21456ef3381b347ff5b6afd7ac45017a22ca1037c6c",
      "taskComplete": "2026-10-25T12:12:39.431Z",
      "milestones": [
        {
          "stage": "A-provider-received-target-result",
          "atMs": 1792930358125
        },
        {
          "stage": "B-return-call-emitted",
          "atMs": 1792930358234
        },
        {
          "stage": "C-return-tool-result",
          "atMs": 1792930359400
        },
        {
          "stage": "D-provider-received-return-result",
          "atMs": 1792930359422
        },
        {
          "stage": "E-target-native-exit-after-completion",
          "atMs": 1792930360096
        }
      ]
    }
  ],
  "comparison": {
    "order": [
      "duplicate",
      "unique",
      "unique",
      "duplicate"
    ],
    "emittedCallsIdenticalExceptItemId": true,
    "callId": "handoff-target-return",
    "promptsCustodyAndDeadlinesUnchanged": true
  },
  "acceptanceLimit": "Diagnostic dirty-source experiment; arm3 also reports source provenance movement. Does not certify full native14, six clauses, acceptance or shipment.",
  "typecheck": "lint:tsc scoped operator exit0clean",
  "remaining": [
    "Commit new diagnostic instrumentation after edit-turn boundary",
    "Clean committed full native14 with original-error/native evidence capture; retain unknown-root defects",
    "Custody race-only mutation and six-clause current bindings/adequacy",
    "Ordered P002/P003/P004, independent acceptance and exact-artifact shipment"
  ],
  "artifacts": [
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm1-source-map.json.gz.b64",
      "sha256": "178885470b044cf93e688a0eed381f40447f00c978100dbb7263f0aa8b6eb951",
      "originalBytes": 9397225
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm1-receipt.json.gz.b64",
      "sha256": "99d2f7975b27b752cb1278d90de4d011cdd88ac099a127d258772d458f6ff0af",
      "originalBytes": 4441
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm1-source-map.json.native-milestones.jsonl.gz.b64",
      "sha256": "7522205d4c20fa113be39c37aef4cabe6c9ce1358543171d6e50fcb508f808ed",
      "originalBytes": 189688
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm2-source-map.json.gz.b64",
      "sha256": "d89f9d88607ac50c2bb53d89dc20598600b78c0fce1ed6311f1591909e23ec85",
      "originalBytes": 9397225
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm2-receipt.json.gz.b64",
      "sha256": "2ac103cc146800a6de141d3edfd809b79b7d1df20e56188279ffde8602abbdec",
      "originalBytes": 4422
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm2-source-map.json.native-milestones.jsonl.gz.b64",
      "sha256": "b794fe9991b22fc4e16c89b383f0bfd4e8dd5f69e567155f8f2f8721e99fd88e",
      "originalBytes": 189447
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm3-source-map.json.gz.b64",
      "sha256": "0e24654d2c0a77f82df7557114498f9ff4df8868993056e2ab06b6bf9a5b38bd",
      "originalBytes": 9397225
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm3-receipt.json.gz.b64",
      "sha256": "dc88a6496be2a542bbf48f14248652d4299f375d86d2ce36b42bebfb2c28e538",
      "originalBytes": 4109
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm3-source-map.json.native-milestones.jsonl.gz.b64",
      "sha256": "9b4790da588c67c2e7af65f90ae9d5a92a8e74c5c408b37f33c8688bdf7e9808",
      "originalBytes": 189802
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm4-source-map.json.gz.b64",
      "sha256": "b1ee188a9862eddafcaecfc115ddd0782a47e5936315faeed80631a9e066ada8",
      "originalBytes": 9397225
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm4-receipt.json.gz.b64",
      "sha256": "68fa3f19bc5a88e05b40e5d4736b3c520432dcde23e27363925bedb4637895a7",
      "originalBytes": 4456
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-arm4-source-map.json.native-milestones.jsonl.gz.b64",
      "sha256": "e04d76efce137549e813ff9fc984bb6d46255f46922a165ce21a20cb98f92e8e",
      "originalBytes": 189797
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-abba.log.gz.b64",
      "sha256": "d96226a5930ad955968ca8bfbd99892be2ea5adb7fb8f4e801a6494d1dc09342",
      "originalBytes": 987110
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/assume49-typecheck.log.gz.b64",
      "sha256": "0a4c53c67d7ad47bb7a93854c400208c721c78261b407b3fb3f2e49e2b932522",
      "originalBytes": 2616
    },
    {
      "rel_path": "evidence/identity-assume/recovery49/native-fixture.ts.gz.b64",
      "sha256": "2b7cc552bf13d5807f51f21456ef3381b347ff5b6afd7ac45017a22ca1037c6c",
      "originalBytes": 79277
    }
  ]
}

