---
rel_path: "evidence/mutation-sandbox-classifier-fire63-20261025.json"
updated_at: 1792931245949
_body: "content"
---

{
  "schemaVersion": "mutation-sandbox-classifier-fire63-v1",
  "items": [
    "EI-26951876523801680",
    "EI-26953704118339243"
  ],
  "sourceHashes": {
    "scripts/mutation-probe.sh": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
    "packages/operator-core/lib/mutation-probe-script.test.ts": "321837160acdd9f6efd47e6a2e18aa01a6f6ffcf42a256a3b6283601cf095936"
  },
  "rootCause": "Only failed baselines inspected sandbox read-only diagnostics. Scored current/historical legs could assert about the wrong error and still certify caught.",
  "fix": "Shared run_guard rejects failed nonbaseline legs with sandbox read-only diagnostics before verdict classification. Existing baselines already refuse any failure.",
  "guard": "Two actual bwrap/mktemp failures after healthy controls, with embedded assertion reporter evidence, cover current-mutant and historical scoring.",
  "testRuns": {
    "red": 22004978,
    "focused": 22004985,
    "mutationBaseline": 22004999,
    "mutationCopyBaseline": 22005005,
    "mutationMutant": 22005006,
    "initialFull": 22005012,
    "fixtureFocused": 22005018,
    "fullFinal": 22005031,
    "postAnnotationFocused": 22005047
  },
  "outcomes": {
    "red": "FAIL2 reproduces both false catches",
    "focused": "PASS7",
    "mutation": "PASS2 baseline + PASS2 copy + FAIL2 mutant; parse ok, overlay, runner source unchanged",
    "initialFull": "177 pass / 2 stale fixture expectation failures",
    "fixtureFocused": "PASS10",
    "fullFinal": "PASS179 / FAIL0 / SKIP0",
    "postAnnotationFocused": "PASS10 / FAIL0 / filtered169; childSubstituted0"
  },
  "testFingerprintQualification": {
    "fullFinal": "906d2db2b94e3824b3d41407a9ece853070a8757f27fc4fe1341a0ea2056342c",
    "finalChange": "Only NodeJS.ProcessEnv annotation was added after the 179-case full run; erased at runtime. Final 10-case focused run and scoped TSC use the final test bytes."
  },
  "typecheck": "npm run typecheck:operator-core -- --files=lib/mutation-probe-script.test.ts: exit0/errors0; final12:25:10Z",
  "checks": [
    "bash -n exit0",
    "scoped git diff --check exit0"
  ],
  "mutationProbe": {
    "cwd": ".",
    "runnerPath": "scripts/mutation-probe.sh",
    "runnerCommit": "15bfd644479eda2f3c23a8334895269d16e180eb",
    "schemaVersion": 1,
    "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
    "environment": {
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health"
    },
    "result": {
      "assertionEvidence": "test-file-assertion-failure",
      "mutantLedger": "test_runs:22005006",
      "mutantParse": "ok",
      "guardExit": 1,
      "baselineLedger": "test_runs:22004999",
      "baselineExit": 0,
      "verdict": "caught",
      "relocation": "overlay",
      "target": "copy-out",
      "expected": "caught",
      "copyBaselineLedger": "test_runs:22005005"
    },
    "argv": [
      "--file",
      "scripts/mutation-probe.sh",
      "--fake-destructive",
      "--relocation",
      "overlay",
      "--mutate",
      "s/\\[ \"\\$phase\" != baseline \\] \\&\\& \\[ \"\\$phase\" != copy-baseline \\]/false/",
      "--test",
      "MUTATION_PROBE_SCRIPT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/mutation-probe-script.test.ts -t EI-26951876523801680"
    ]
  },
  "limits": [
    "Local source verification; no committed acceptance or deployment is asserted.",
    "P001 full builder/runtime/R4 remains incomplete; original parent-manifest authority UNKNOWN forbids real BG preparation and activation."
  ]
}
