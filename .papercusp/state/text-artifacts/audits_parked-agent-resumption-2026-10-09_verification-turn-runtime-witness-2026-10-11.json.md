---
rel_path: "audits/parked-agent-resumption-2026-10-09/verification-turn-runtime-witness-2026-10-11.json"
updated_at: 1791757503121
_body: "content"
---

{
  "schemaVersion": 1,
  "sourceTurn": "self",
  "runtimeWitness": {
    "testRunId": 21126397,
    "profile": "packages/operator-core/test/parked-agent-audit.live-profile.json",
    "units": [
      "postgres:5432"
    ],
    "beforeFingerprint": "4be5371e61fe56328985c351921c2ae25736ac1751a45888a1e8feed200c74f1",
    "afterFingerprint": "4be5371e61fe56328985c351921c2ae25736ac1751a45888a1e8feed200c74f1",
    "status": "local-dirty-pass-not-committed"
  },
  "mutation": {
    "baselineRunId": 21126291,
    "copyBaselineRunId": 21126293,
    "mutantRunId": 21126298,
    "mutation": "s/return errors[.]sort[(][)];/return [];/g",
    "verdict": "caught",
    "relocation": "overlay",
    "trackedTree": "byte-identical",
    "bindings": [
      38163,
      38164
    ],
    "status": "staging-adequacy-unknown-dirty-environment-not-recorded"
  },
  "guard": {
    "unitTests": 88,
    "isolatedPgRunId": 21126421,
    "isolatedTestsPassed": 2,
    "intentionallyFiltered": 48,
    "cleanup": {
      "runtimeRemoved": true,
      "pgDataRemoved": true
    },
    "scope": "local current-build helper proof, not full hosted recovery or real successor pickup"
  },
  "r1SourceBarRepair": {
    "oldSpecRevision": 2,
    "newSpecRevision": 3,
    "newSpecHash": "d3f28e270b6e0c82fd6697dd7c60fede5107eedf9b9930e6905985c1bcc264c8",
    "unchangedBarHash": "ab28108c84ec07a84271980d8af11bc910e31a9a5ffba0748590357ba59b13b2",
    "rubricRevision": 6,
    "rootFixItem": "EI-25723294071196988",
    "status": "temporary-metadata-repin-class-fix-still-open"
  },
  "notVerified": [
    "independent meta audit",
    "committed live runtime witness",
    "committed mutation proof",
    "shared bg-host contains guard fix",
    "actual same-profile successor pickup",
    "final contained fix anchor +24h census"
  ]
}
