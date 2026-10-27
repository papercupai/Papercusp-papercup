---
rel_path: "runtime-migration/p001-routine-claim-baseline-501c.json"
updated_at: 1792744453370
_body: "content"
---

{
  "schema": "papercusp-runtime-claim-local-baseline-v1",
  "workItem": "WI-6554700010022067",
  "planItem": "P-001",
  "candidateAcceptance": false,
  "closureAccepted": false,
  "log": {
    "path": "/tmp/bun-p001-claims-corrected-private-tests-501c.log",
    "sha256": "802823539bac78bdff4630227f255a861237333a87464fe232bb52a4f86db9c9"
  },
  "sourceMap": {
    "path": "/tmp/bun-p001-claims-corrected-source-map-501c.json",
    "sha256": "0f6e33e838c09ccd27537ea1c5254880733640d142ba260535d6123d5022a870",
    "recordedSha": "ccbbc7111a2c5a9995991b10118dc33f377fd29e",
    "worktreeDirty": true
  },
  "sources": {
    "packages/operator-core/lib/harness/routines/runtime-claim.integration.test.ts": "fbc73a48d9c09a09bbe145cd8940a756716cf8c176aced796c0c6cfa668e54f9",
    "scripts/lib/runtime-compatibility-claims.mjs": "172c9958101201b7e1691d1d5ce180d013caa912c0b291412236fffaff51e644",
    "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
    "packages/operator-core/lib/harness/routines/claim.ts": "53b22d90a836656d239b8f9779596c548fdc9b1501b067d3b4d472bc54840f7a"
  },
  "result": {
    "exitCode": 0,
    "passed": 4,
    "failed": 0,
    "skipped": 0,
    "childSubstituted": 5,
    "privatePgStopped": true
  },
  "measured": [
    "same-snapshot Node/Bun contention: one claim/effect, recurring and one-shot",
    "stale captured timestamp rejected after retune",
    "recurring pause fence and claimed one-shot dispatch"
  ],
  "limitations": [
    "explicit synthetic candidate identity; no immutable application/deployed receipt",
    "five runner/config support module substitutions; named test source-map hash matches current bytes",
    "no DBOS delivery, global bg owner lease, crash takeover or rollback acceptance",
    "claim child transitive source census and raw per-child receipts not retained",
    "source digests taken after run; binary digests are postrun observations"
  ],
  "priorFailure": {
    "log": "/tmp/bun-p001-claims-private-tests-501c.log",
    "passed": 2,
    "failed": 2,
    "correction": "Predecessor changed schedule interpolation from pre-stringified jsonb to explicit text-to-jsonb cast after that run; corrected bytes now pass."
  }
}
