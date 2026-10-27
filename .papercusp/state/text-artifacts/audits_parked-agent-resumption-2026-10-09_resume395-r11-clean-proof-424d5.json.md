---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume395-r11-clean-proof-424d5.json"
updated_at: 1792985654423
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010008887",
  "clause": "AUTO-BAR-R-11-P-011",
  "specRevision": 5,
  "measuredAt": "2026-10-26T03:25:12.960Z",
  "commit": "56859cff637cd26d472f6c2c35e0e1406053f792",
  "tests": {
    "runs": [
      22104604,
      22104605,
      22104606,
      22104607
    ],
    "passed": 228,
    "failed": 0,
    "skipped": 0,
    "worktreeDirty": false,
    "requiredCurrentCoverageBinding": 52430
  },
  "mutation": {
    "baseline": 22104613,
    "copyBaseline": 22104616,
    "mutant": 22104617,
    "baselinePassed": 30,
    "copyBaselinePassed": 30,
    "mutantPassed": 21,
    "mutantFailed": 9,
    "skipped": 0,
    "verdict": "caught",
    "containment": "overlays=1 uncovered=0 failed=0",
    "sourceRestored": true
  },
  "bindings": [
    52430,
    70931,
    70932,
    70933,
    70934,
    70935
  ],
  "governingEvaluation": {
    "build": "staging",
    "sha": "3bea28d963",
    "verdict": "pass",
    "mechanicallyVerified": 1,
    "gaps": [],
    "filed": 0
  },
  "logs": [
    "/tmp/parked-resume395-r11-committed-424d5.log",
    "/tmp/parked-resume395-r11-mutation-424d5.log"
  ],
  "transcript": "/home/marsh-office/.papercusp/su-codex-homes/session-40770/sessions/2026/10/25/rollout-2026-10-25T23-00-06-01a17626-a1f6-7552-bccc-72c138f36389.jsonl",
  "limits": [
    "Historical fixed-commit proof; source movement requires scoped currentness recheck.",
    "No deployed-runtime, original116, strict24h, independent grade, or whole-plan acceptance claimed.",
    "No production source edit or live-gate operation."
  ]
}
