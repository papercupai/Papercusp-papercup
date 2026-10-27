---
rel_path: "evidence/identity-assume/recovery47/committed-native-failure-manifest.json"
updated_at: 1792927505561
_body: "content"
---

{
  "workItem": "WI-6554700010025439",
  "startupBug": "EI-26945342104332409",
  "seedBug": "WI-6554700010028643",
  "checkpointBug": "WI-6554700010028642",
  "commit": "852255b47bd216d0ad5452e62bcc9b676749cbbd",
  "status": "Failed committed native cohort: not acceptance proof",
  "terminalHook": "onTestRunEnd",
  "reason": "failed",
  "populationMatched": true,
  "unhandled": 0,
  "sourceStatus": "stable",
  "worktreeDirty": false,
  "completionId": "65e26002-06c6-4397-b129-8c06753551c2",
  "counts": {
    "passed": 11,
    "failed": 2,
    "skipped": 0
  },
  "cases": [
    {
      "name": "discovers a deferred handoff tool before invoking an already advertised executor",
      "status": "pass"
    },
    {
      "name": "read-only context preview isolates an overlapping coordination writer",
      "status": "pass"
    },
    {
      "name": "resumes installed native target context and returns the caller on the same managed attachment (native-resume)",
      "status": "fail"
    },
    {
      "name": "resumes installed native target context and returns the caller on the same managed attachment (checkpoint)",
      "status": "pass"
    },
    {
      "name": "uses production custody and routed responsibilities through the installed native handoff (native-resume)",
      "status": "pass"
    },
    {
      "name": "uses production custody and routed responsibilities through the installed native handoff (checkpoint)",
      "status": "fail"
    },
    {
      "name": "admits exactly one of two installed native callers and preserves the losing caller responsibilities",
      "status": "pass"
    },
    {
      "name": "routes installed native target input output resize interrupt and exit through the inherited managed channel",
      "status": "pass"
    },
    {
      "name": "previews one exact ended target without writes and refuses live, foreign and unknown custody",
      "status": "pass"
    },
    {
      "name": "R-8 recovers persisted native handoff after managed host SIGKILL before target execution",
      "status": "pass"
    },
    {
      "name": "R-5 exact caller return restores input output resize interrupt and exit on the original pane",
      "status": "pass"
    },
    {
      "name": "R-1 delivers the invoking native tool response before fresh completion permits caller replacement",
      "status": "pass"
    },
    {
      "name": "R-8 recovers after target native writer acquisition and managed host SIGKILL before verification",
      "status": "pass"
    }
  ],
  "artifacts": [
    "evidence/identity-assume/recovery47/assume47-native-source-map.json.gz.b64",
    "evidence/identity-assume/recovery47/assume47-native-source-map.json.journey-failures.jsonl.gz.b64",
    "evidence/identity-assume/recovery47/assume47-native-source-map.json.startup-custody.jsonl.gz.b64",
    "evidence/identity-assume/recovery47/assume47-native.log.gz.b64",
    "evidence/identity-assume/recovery47/assume47-diagnostic-typecheck.log.gz.b64"
  ],
  "diagnosticFix": "Canonical test now preserves original errorStack plus per-owner host events and native process startup counters before fixture cleanup; stderr artifact pointer no longer masks original failure via fail-on-console. Changed-file operator typecheck exit0. Not yet exercised in native rerun.",
  "remaining": [
    "Audit two distinct expensive native failure classes before another full run",
    "Use only exact failed-case native selection after diagnostic commit; no timeout widening",
    "Current committed full native13 and race-only mutant",
    "Six clause proof bindings/adequacy",
    "Ordered P002/P003/P004, independent acceptance and shipment"
  ]
}
