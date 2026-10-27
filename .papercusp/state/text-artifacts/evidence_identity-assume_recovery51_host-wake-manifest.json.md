---
rel_path: "evidence/identity-assume/recovery51/host-wake-manifest.json"
updated_at: 1792944671010
_body: "content"
---

{
  "scope": "P001 recovery51 host/wake plus native lifecycle instrumentation",
  "sourceCommit": "2bbff3bf44ad94fc5165c25d87793432c102ca26",
  "hostRun": 22028727,
  "wakeRun": 22028728,
  "hostPassed": 6,
  "wakePassed": 8,
  "failed": 0,
  "skipped": 0,
  "wrapperExit": {
    "code": 0,
    "signal": null
  },
  "limitations": [
    "Initial reporter sink selected another local database; same original receipts reinserted through canonical reporter with original receipt identities; do not cite129/130.",
    "PC_EXECUTED_SOURCE_MAP_OUT alone did not arm source reporter: no source-map artifact exists; receipt commit/worktree evidence retained; no fabricated native source-population assertion.",
    "Native lifecycle instrumentation in shared tree has clean scoped typecheck but is uncommitted and not behaviorally run."
  ],
  "artifacts": [
    {
      "rel_path": "evidence/identity-assume/recovery51/assume51-host-wake-manifest.json.gz.b64",
      "bytes": 629,
      "sha256": "3034641bff3871210d9121ffa0e56fe803d516c8e6e3aa022ec3ab8f76c42f34"
    },
    {
      "rel_path": "evidence/identity-assume/recovery51/assume51-host-wake.log.gz.b64",
      "bytes": 824646,
      "sha256": "2b2155e4da94bba2c640e4578f346f174dce63880a73aa736405fe910ccf33a9"
    },
    {
      "rel_path": "evidence/identity-assume/recovery51/assume51-host-wake-exit.json.gz.b64",
      "bytes": 24,
      "sha256": "1aff36f796932c34d424461078ea28c3b7feef0b4538624958a98e8dc7e4bca4"
    },
    {
      "rel_path": "evidence/identity-assume/recovery51/assume51-host-wake-canonical-receipt.jsonl.gz.b64",
      "bytes": 6836,
      "sha256": "d43a1afdeb127593f90afef8737336f72afddb05ed98ca9a1e4649e7fc739fbe"
    },
    {
      "rel_path": "evidence/identity-assume/recovery51/assume51-runtime-typecheck3.log.gz.b64",
      "bytes": 2616,
      "sha256": "356fe8a195ab4c756c7def5225927219a6fd8b730128a98b28e8fa4849eef226"
    }
  ]
}
