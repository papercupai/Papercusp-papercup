---
rel_path: "evidence/identity-assume/recovery48/diagnostic-proof-manifest.json"
updated_at: 1792928909084
_body: "content"
---

{
  "workItem": "WI-6554700010025439",
  "failures": [
    "WI-6554700010028643",
    "WI-6554700010028642"
  ],
  "scope": "Current-source diagnostic only; no committed acceptance; roots unconfirmed. Original R8 root remains fixed and committed verified.",
  "runs": [
    {
      "stem": "assume48-targeted-native",
      "testRunId": "21999425",
      "outcome": "inserted",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "changed",
      "selected": [
        {
          "caseIndex": 2,
          "caseKey": "resumes installed native target context and returns the caller on the same managed attachment (native-resume)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 4418,
          "errorTail": null
        },
        {
          "caseIndex": 5,
          "caseKey": "uses production custody and routed responsibilities through the installed native handoff (checkpoint)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 42697,
          "errorTail": null
        }
      ]
    },
    {
      "stem": "assume48-diagnostic-native",
      "testRunId": "22000215",
      "outcome": "inserted",
      "terminalHook": "onTestRunEnd",
      "reason": "failed",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "selected": [
        {
          "caseIndex": 2,
          "caseKey": "preserves the original native failure and startup evidence after fixture cleanup",
          "occurrence": 1,
          "status": "fail",
          "durationMs": 895,
          "errorTail": "expected { \u2026(2) } to match object { present: true }\n(1 matching property omitted from actual)\nactual: {\n  \"present\": false,\n}\nexpected: {\n  \"present\": true,\n}"
        },
        {
          "caseIndex": 3,
          "caseKey": "resumes installed native target context and returns the caller on the same managed attachment (native-resume)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 2870,
          "errorTail": null
        },
        {
          "caseIndex": 6,
          "caseKey": "uses production custody and routed responsibilities through the installed native handoff (checkpoint)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 30047,
          "errorTail": null
        }
      ]
    },
    {
      "stem": "assume48-guard-native",
      "testRunId": "22000726",
      "outcome": "inserted",
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "populationMatched": true,
      "unhandled": 0,
      "worktreeDirty": true,
      "sourceStatus": "stable",
      "selected": [
        {
          "caseIndex": 2,
          "caseKey": "preserves the original native failure and startup evidence after fixture cleanup",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1789,
          "errorTail": null
        }
      ]
    }
  ],
  "typecheck": "Changed native fixture operator typecheck exit0/clean; final edit only corrects missing-log expectation.",
  "detector": "Preserves original stack plus host events/process counters, native transcript bytes/hash, explicit TUI log absence or tail, timestamped MCP/provider requests, productionTrace and returnReceipt before cleanup. Real native controlled failure guard22000726 proves original error identity and evidence survive cleanup.",
  "hypothesis": "Consult post1205197 identifies repeated Responses output item id call-target across two distinct target call_ids; not measured as cause. Matched duplicate/unique experiment suggested; no protocol change applied yet. Seed bootstrap cause still unconfirmed.",
  "sourcePopulation": "Required 13 original journeys plus new maintained diagnostic guard =14 cases now. No full cohort attempted this turn.",
  "remaining": [
    "Verify diagnostic fixture commits after edit-turn boundary; do not replay old startup-fix wait",
    "Distinguish target return item-identity hypothesis without timeout/custody relaxation; capture any seed stall native evidence",
    "Current committed native14 (13 required + new guard) and only custody race mutation; retain five Recovery42 mutants",
    "Six clause bindings/adequacy; ordered P002/P003/P004; independent acceptance and exact-artifact shipment"
  ],
  "artifacts": [
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-targeted-native-source-map.json.gz.b64",
      "sha256": "4070554cce7fd51e93107255c13ff0cc1d010fc6f4ad2c96381804797effedc5",
      "originalBytes": 9565756
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-targeted-native-receipt.json.gz.b64",
      "sha256": "b8a1aed33369599399c5f078fe0ce8e08a9e69e0b835297958c39b72cdfb9373",
      "originalBytes": 4544
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-targeted-native.log.gz.b64",
      "sha256": "567ae703ee9496fcebc7bab31a9ce60dce7ad8f8e6bb3cffdb883131e9a3d3d5",
      "originalBytes": 867902
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-diagnostic-native-source-map.json.gz.b64",
      "sha256": "0322c1b7c64d71a6e8c937c7e8c71549405a9b4ec21b282ccd77a986f98c95dc",
      "originalBytes": 6357178
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-diagnostic-native-receipt.json.gz.b64",
      "sha256": "7957a11346e035027839f7ca4241c67b77b3de262848c42ce9bbeeae74fc8352",
      "originalBytes": 5316
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-diagnostic-native.log.gz.b64",
      "sha256": "378e8710272a43a74dc4ae11de5f31dabcf4b5a7852131349fb87120b6caed63",
      "originalBytes": 873976
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-guard-native-source-map.json.gz.b64",
      "sha256": "6ed0f1835f0b86333512175de7b2a7cb3b234cbca890935de35246dd00db7692",
      "originalBytes": 4220209
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-guard-native-receipt.json.gz.b64",
      "sha256": "4c9d984771030c613fa882ae5e4dfff71993969a9e25c73772c668776fb4422c",
      "originalBytes": 4451
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-guard-native.log.gz.b64",
      "sha256": "bfa01454c1df30c37e9d7dd398463d044c6adb584ff6eaa3ec1bdb9ad0880034",
      "originalBytes": 866121
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-diagnostic-typecheck.log.gz.b64",
      "sha256": "d800edce5e2a567b30acee116dded1d1f6fee533061c1749013b6e0387a719a4",
      "originalBytes": 2616
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-consult-answer.json.gz.b64",
      "sha256": "2046523e18b04cff62ba34e2541626a28ab0eade2fdfa56c1a78a3ebe5675201",
      "originalBytes": 8141
    },
    {
      "rel_path": "evidence/identity-assume/recovery48/assume48-native-fixture.ts.gz.b64",
      "sha256": "84662fb7af31fa7602f9a56204d2163201c084fcaeeced6985bf7f6110240391",
      "originalBytes": 77826
    }
  ]
}
