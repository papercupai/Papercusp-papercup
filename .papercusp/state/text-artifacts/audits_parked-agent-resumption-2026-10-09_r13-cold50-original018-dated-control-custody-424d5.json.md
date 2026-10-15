---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold50-original018-dated-control-custody-424d5.json"
updated_at: 1791988156961
_body: "content"
---

{
  "schemaVersion": "r13-cold50-original018-dated-control-custody-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subject": "su-01864986-d27d-497b-b501-7082b6e0caab",
  "route": "approved SELF/AUTO/P-013/account/cold",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "prior": "r13-cold49-dated-cutoff-evidence-index-424d5.json",
  "sourceRefs": [
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold50-independent018-review-to-cutoff-invocations-424d5.json",
      "found": true,
      "chars": 4300
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold50-original018-user-frame-locators-424d5.json",
      "found": true,
      "chars": 74473
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold50-independent018-delivered-wake-424d5.json",
      "found": true,
      "chars": 13670
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold50-original018-directive-assignment-audit-custody-424d5.json",
      "found": true,
      "chars": 2619
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold50-original018-assignment-audit-corrected-424d5.json",
      "found": true,
      "chars": 1689
    }
  ],
  "assessment": {
    "independentWork": "Original checkpoint35083319 names audit row89; coord_event_log23766617 at02:52:57.269 repeats it in wake envelope572850.",
    "wakeLimit": "The coordination row establishes a recorded wake envelope; it does not verify delivery, pickup, or final-cutoff custody. Earlier commentary wording delivered is corrected.",
    "invocationWindow": "Exact self and selected structured external targets:0 rows after02:38:07.691 throughcutoff; original35083319 positive control passed. MCP only; other aliases/fleet/broadcast excluded.",
    "transcript": "122 indexed speaker=user rows include tool results; only11 are text frames:3 instruction,3 environment,5 wake/recovery prefixes. Prefix locators are not human-control classifications or archive-completeness proof.",
    "directiveWindow": "Exact recorded_by original018 rows throughcutoff:0 without positive control. No absence conclusion.",
    "assignmentAudit": "First query failed22P02 by comparing bigint timestamp to ISO; no evidence from it. Corrected Date.now millisecond query:0 rows, positive control passed. Audit coverage omits ordinary/nonterminal transitions; cannot establish assignment continuity.",
    "originalAssignmentWitness": "Reuse Cold45 four original worked_by_history rows; direction remains unknown. Current historical checkpoint guard permits unassigned rows, so successful checkpoint alone does not prove a claim.",
    "cutoffVerdict": "review-open",
    "eligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0,
    "originalReceipts": {
      "accepted": 113,
      "unresolved": 24
    },
    "wholeMembership": 116,
    "remaining": [
      "Exact original018 full held-item custody and applicable control scope remain unresolved",
      "Continue dated source frames for other110; freeze whole116 eligibility before any outcome joins",
      "Preserve R5/root961/R12/all-final-fix-runtime and actual>=24h R14"
    ]
  },
  "callerCorrection": {
    "observation": "EI-25965124557912473",
    "classification": "caller SQL units error; no platform-fault claim"
  },
  "forbiddenActionsPreserved": [
    "No source edits/tests/acquisitions/replays/restores/route/account changes/LIVE_GATE_OPS/terminal closes"
  ]
}
