---
rel_path: "evidence/identity-assume/recovery30/race-refresh-recipe.json"
updated_at: 1792890389508
_body: "content"
---

{
  "subjectPath": "packages/operator-core/lib/session-assume.ts",
  "mutateExpression": "s/if \\(!reservation\\.acquired\\)/if (false && !reservation.acquired)/",
  "testCommand": "node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs apps/operator/lib/psu-identity-assume-native.integration.test.ts -- --testNamePattern=\"two installed native callers\"",
  "root": "/tmp/pcv/papercusp-lint-as-committed-bc14dfe85a-c7AyuZ",
  "commit": "bc14dfe85a71cfc0c11805bd8dd37a8f485f09f0",
  "runner": "scripts/mutation-probe.sh",
  "mode": "copy-out",
  "relocation": "overlay",
  "expect": "caught",
  "prerequisite": "Run via maintained with-test-pg from this retained committed root with shared durable test ledger and scoped original-source reporter. This is the single reservation-bypass race mutant, not any of the five already current clause mutants. Let the runner perform both ordinary and unchanged-overlay baselines. Preserve all receipt and descriptor metadata.",
  "replacesBindingId": 69388,
  "specId": "TRANSITION-CONTENDED-CUSTODY",
  "nativeBaselineReceipt": 21954203
}
