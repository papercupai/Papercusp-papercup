---
rel_path: "runtime-migration/p004-node-bun-handoff-local-proof-0dcd3-20261102.json"
updated_at: 1793594866214
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022070",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "owner": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "collectedAt": "2026-11-02T04:47:43.897449+00:00",
  "scope": "Local source and real-interpreter proof only; no installed-candidate/platform/acceptance/shipment verdict.",
  "sources": [
    {
      "path": "packages/operator-core/lib/bundled-node.ts",
      "sha256": "07a0844747cdd51a5242ead35bf5a4d2b964856c1042c6638ac4a1018e58fae5",
      "mtimeMs": 1793594514084
    },
    {
      "path": "packages/operator-core/lib/bundled-node-runtime.test.ts",
      "sha256": "767c3dd0db347bdbd08fc0f2d1f4960426d1928054eaa846e7e85b91306a7b4d",
      "mtimeMs": 1793594514506
    },
    {
      "path": "packages/operator-core/lib/vm-release-runtime-policy.ts",
      "sha256": "6cd33e5b43b7bd9e89719fddfbae10ba4dac7ffa947e493303eaf88e8dc80f58",
      "mtimeMs": 1793594514277
    },
    {
      "path": "packages/operator-core/lib/vm-release-runtime-policy.test.ts",
      "sha256": "1f67d6b07c8e0e480f7a15689947894b822082141427a7496faaa7f992ca775f",
      "mtimeMs": 1793594514782
    },
    {
      "path": "apps/operator/bin/serve.ts",
      "sha256": "2a5b33a401d9aa161cf5ee062e44a19a15a42263b23083a49611c9f0d3a5b6c4",
      "mtimeMs": 1793594514357
    }
  ],
  "bun": {
    "path": "/tmp/p004-bun-0dcd3-20261102/bun",
    "version": "1.4.4",
    "target": "linux-x64-baseline",
    "archiveSha256": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
    "binarySha256": "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235",
    "verification": "Existing maintained staging helper checked release-pinned archive before extraction; installed ~/.papercusp/bin/bun differs and was excluded from pinned evidence."
  },
  "tests": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_RUNTIME_TEST_BUN=/tmp/p004-bun-0dcd3-20261102/bun npm run test:file -- packages/operator-core/lib/bundled-node-runtime.test.ts packages/operator-core/lib/vm-release-runtime-policy.test.ts",
    "nativeExit": 0,
    "result": "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=3be6474c17 uncommittedPaths=2/2 provenance=unknown startedAt=2026-11-02T04:45:16.763Z childSubstituted=0 skippedTests=0",
    "summary": [
      "Test Files  2 passed (2)",
      "Tests  61 passed (61)"
    ],
    "log": "/tmp/p004-handoff-pinned-0dcd3-20261102.log",
    "logSha256": "2b2f8fb18fbff562a35ea749b6e08cbf99dd955a9976d0178adcc60eab46cb10",
    "provenance": [
      "TEST_FILE_PROVENANCE head=3be6474c17 testedPaths=2 uncommitted=2 unknown=0 phase=pre-run startedAt=2026-11-02T04:45:16.763Z",
      "TEST_FILE_PROVENANCE head=1538915f97 testedPaths=2 uncommitted=2 unknown=0 phase=post-run startedAt=2026-11-02T04:46:24.681Z"
    ],
    "substitutions": 0,
    "skips": 0
  },
  "typecheck": {
    "command": "scripts/pc-heavy.sh node scripts/lint-tsc.mjs --files=packages/operator-core/lib/bundled-node.ts,packages/operator-core/lib/bundled-node-runtime.test.ts,packages/operator-core/lib/vm-release-runtime-policy.ts,packages/operator-core/lib/vm-release-runtime-policy.test.ts,apps/operator/bin/serve.ts",
    "nativeExit": 0,
    "namedCore": "clean",
    "autoRoutedServe": "clean",
    "limits": "Existing unrelated core type errors were printed; no global type-clean claim."
  },
  "observed": [
    "Actual pinned Node bootstrap execve to pinned accepted Bun preserved PID, PPID, stdout and literal argv.",
    "Pinned preload ran before entrypoint under both real Node and Bun.",
    "Unaccepted/missing authority/foreign bootstrap/no execve/corrupt preload/mutated provenance refused before application output.",
    "Candidate/preload input copied before asynchronous acceptance reader; hashes rechecked before and after interpreter probes."
  ],
  "limitations": [
    "Canonical acceptance callback is substituted in policy unit test; actual pre-PG ledger transport remains unresolved.",
    "Source hashes collected after tests; no immutable candidate claim. HEAD moved during tests; reporter provenance unknown. Do not attach final/current HEAD retroactively.",
    "Windows native handoff lacks execve and refuses; Windows WSL and complete GUI/server matrix remain unproved.",
    "Node default retained. No cutoff, full60min soak, singleton/forced rollback, independent author acceptance or shipment claim."
  ],
  "next": "Reuse existing signed release/provenance envelope and canonical acceptance writer for offline pre-PG authorization, preserving revocation/expiry and exact candidate binding; no file-existence authority."
}
