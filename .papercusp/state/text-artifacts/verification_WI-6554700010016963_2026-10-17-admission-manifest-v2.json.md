---
rel_path: "verification/WI-6554700010016963/2026-10-17-admission-manifest-v2.json"
updated_at: 1792277791795
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010016963",
  "edition": "2026-10-17-production-admission-source-and-isolated-runtime",
  "status": "partial-shared-runtime-journal-and-R2-binding-open",
  "priorManifest": "verification/WI-6554700010016963/2026-10-17-source16963-manifest.json",
  "sourceFiles": {
    "packages/operator-core/test/_dream-admission-background-child.ts": "51cbf922544d7b9dee0fe0fd73dfbf8fd420c917570b3146581932ae7af31dcf",
    "packages/operator-core/lib/dream/dream-cycle-action.ts": "54948b079a2934f98f03251594653bb351bf546fae08f7727c39340cd49fa3b1",
    "packages/operator-core/lib/dream/dream-config.ts": "736922183a686b41af0e95069478c5f1b293ebd09fb920299fbba4d1ebc1195e",
    "packages/operator-core/lib/dream/dream-control-observations.ts": "6b425ad14ad9fc6b6a5c43a846f379c6d4d0b2469d5e079be4a3b19299c51907",
    "packages/operator-core/lib/gym/autoloop-tick.ts": "a9b483942f6dac8d307bff55d9dbbe0e57e6da88104222c4967d433363b85fdb",
    "packages/operator-core/lib/harness/routines/gym-actions.ts": "85b6191c5efba0abd602ae68136c8efe5197e30ea175ee64c20005bc8456f5f5",
    "packages/operator-core/lib/autoloop.ts": "e8ee2884808493ec13477b77f1af23d56d891090d438c4f458113daf568ae72b",
    "packages/operator-core/lib/owner-steering.ts": "275128dbbc19af792edd5d850575942449cbeb4b7d080706f189c6346ed85c1d",
    "packages/operator-core/lib/serving-host-identity.ts": "3e5a8e0c4308a2a7f60aaeba951ae6bee88125bb27c3806aa65898dc67a7476a",
    "scripts/with-test-pg.mjs": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b",
    "packages/operator-core/test/isolated-integration-proof.ts": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d",
    "packages/operator-core/lib/dream/dream-cycle-action.test.ts": "3d467ae0410369f9c7b1667cfd9dfc59dfced23ce7b12e3cfcd13e08bc0e154b",
    "packages/operator-core/lib/dream/dream-cycle-production.test.ts": "597526da495674d0fa7444a0d213a1b8ba18227cf7c053e3170d1addd5381053",
    "packages/operator-core/lib/dream/dream-control-observations.test.ts": "ba374f4d5162544a890de588c4a1ec48595bc8f186848331fcf1f8cac2e7b0b6",
    "packages/operator-core/lib/gym/__tests__/autoloop-tick.test.ts": "8971d1a6b0855a6af0287543537185feb021165314fcb1d4430f72131e983716",
    "packages/operator-core/lib/owner-steering.test.ts": "46290b5fe3cc507c00d2e65675735c9b89d4c3b1acad2fdb275fef27932b037e",
    "packages/operator-core/lib/sync-resolver/index.ts": "9bfe27e9251f4841013ff6920351f49b2bd89b0e4fdb18784dbb603b18e672d6",
    "packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts": "828aeadeb5116283e400383323940670789fad4fc4994e1cc9e9dab707df5a1f",
    "packages/operator-core/lib/autoloop-state.integration.test.ts": "4834463cb69d59d9d1e290e4ee1b77618dca5ca986d80c0ec740bb2f0bb0e6e3",
    "packages/operator-core/lib/dream/dream-admission-background.integration.test.ts": "9554f03c194597934468cfa03eb4ed0a31f042910882de3b2ac79f9f6a25639a"
  },
  "currentHead": "6d864c64ebc8081d5ce1e2457fdb9f1518cb84a4",
  "filesEqualCurrentHead": {
    "packages/operator-core/test/_dream-admission-background-child.ts": false,
    "packages/operator-core/lib/dream/dream-cycle-action.ts": false,
    "packages/operator-core/lib/dream/dream-config.ts": false,
    "packages/operator-core/lib/dream/dream-control-observations.ts": false,
    "packages/operator-core/lib/gym/autoloop-tick.ts": false,
    "packages/operator-core/lib/harness/routines/gym-actions.ts": false,
    "packages/operator-core/lib/autoloop.ts": false,
    "packages/operator-core/lib/owner-steering.ts": false,
    "packages/operator-core/lib/serving-host-identity.ts": true,
    "scripts/with-test-pg.mjs": true,
    "packages/operator-core/test/isolated-integration-proof.ts": true,
    "packages/operator-core/lib/dream/dream-cycle-action.test.ts": false,
    "packages/operator-core/lib/dream/dream-cycle-production.test.ts": false,
    "packages/operator-core/lib/dream/dream-control-observations.test.ts": false,
    "packages/operator-core/lib/gym/__tests__/autoloop-tick.test.ts": false,
    "packages/operator-core/lib/owner-steering.test.ts": false,
    "packages/operator-core/lib/sync-resolver/index.ts": false,
    "packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts": false,
    "packages/operator-core/lib/autoloop-state.integration.test.ts": false,
    "packages/operator-core/lib/dream/dream-admission-background.integration.test.ts": false
  },
  "tests": {
    "unit": {
      "passed": 185,
      "path": "verification/WI-6554700010016963/2026-10-17-admission-unit-185.log"
    },
    "fireGatePostgres": {
      "passed": 19,
      "log": "/tmp/wi16963-admission-runtime.log"
    },
    "runtime": {
      "runId": "20261017T225348Z-3328872",
      "verdict": "pass",
      "assertionCase": "observes production Dream/Gym policy refusals, a private write, and original child cleanup",
      "sourceReceiptPath": "/mnt/data/offload/verification-harness/isolated-integration/20261017T225348Z-3328872/phases/prepare/source.json",
      "scope": "isolated-production-policy-skip-and-read-only-observations",
      "journalBoundary": "stdout-capture-only; shared-runtime journal acceptance remains unverified"
    }
  },
  "runtime": {
    "host": "port-44925",
    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106662609",
    "buildSha": "6d864c64eb"
  },
  "consumedAt": "2026-10-17T22:54:31.163Z",
  "capturedAt": "2026-10-17T22:54:31.147Z",
  "expiresAt": "2026-10-17T22:55:31.147Z",
  "rootCause": {
    "fixture": "Original JSON.stringify parameter bound as jsonb serialized into JSON string; sql.json binds object.",
    "distinguishingTest": {
      "legacy_type": "string",
      "typed_type": "object"
    },
    "guard": "Required setting columns and exact stored routine object equality before production actions; raw read retained before assertions."
  },
  "openGaps": [
    "exact containing shared-background runtime Dream/Gym journal reads",
    "ordinary Scout supplied cap/lens/origin observations on containing runtime",
    "coherent canonical operational artifact/run/current R2 binding and c6/SAME4f572 independent METHOD approval",
    "original human disposition/science/native-author proof/quality/final artifact shipment retained"
  ],
  "claimsExcluded": [
    "no acceptance or grading",
    "no paid cycle",
    "no shared journal fabricated from stdout",
    "no shipment",
    "source16926/run21355021 historical DONE unchanged",
    "candidate1188995/96/1188997 remain unapplied"
  ]
}
