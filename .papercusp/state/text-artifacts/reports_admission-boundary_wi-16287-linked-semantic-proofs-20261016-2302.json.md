---
rel_path: "reports/admission-boundary/wi-16287-linked-semantic-proofs-20261016-2302.json"
updated_at: 1792191706249
_body: "content"
---

{
  "schemaVersion": 1,
  "workItemId": "WI-6554700010016287",
  "testedCommit": "28f698820ec65c9ef301d257a34f7974a797f1eb",
  "bindingIds": [
    53582,
    53583,
    53584,
    53585,
    53586,
    53587
  ],
  "probes": [
    {
      "name": "liveprefix",
      "logPath": "/tmp/wi16287-linked-liveprefix-2253.log",
      "logSha256": "64c94067e85c66f4defca14ad54ad30a4a67e08f3cbdd45306f7ecf4e530e753",
      "descriptorLine": "[mutation-probe] mutation descriptor on: deployed reader 8005af2ad1 parses execution_details.mutation; probeInvocationId=41c50944-3e86-4187-81a6-17e7deb6d1f6 mode=copy-out subject=packages/operator-core/lib/coord/actionable-conditions.ts",
      "evidence": {
        "runnerPath": "scripts/mutation-probe.sh",
        "cwd": ".",
        "argv": [
          "--file",
          "packages/operator-core/lib/coord/actionable-conditions.ts",
          "--mutate",
          "s/prefix: 'green-stall:'/prefix: 'mutated-green-stall:'/",
          "--relocation",
          "overlay",
          "--test",
          "test -f {} && npm run test:file -- packages/operator-core/lib/coord/condition-bridge.test.ts -- --testNamePattern='rejects keys that are not opted in|admits the real condition keys'",
          "--expect",
          "caught"
        ],
        "runnerSha256": "576ab21c598086727d5e14cb578007aed99a067b6340040b8d7a18e78a888858",
        "result": {
          "copyBaselineLedger": "test_runs:21295957",
          "assertionEvidence": "test-file-assertion-failure",
          "target": "copy-out",
          "guardExit": 1,
          "relocation": "overlay",
          "verdict": "caught",
          "baselineLedger": "test_runs:21295947",
          "expected": "caught",
          "mutantParse": "unchecked",
          "mutantLedger": "test_runs:21295978",
          "baselineExit": 0
        },
        "environment": {
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
          "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
        },
        "schemaVersion": 1,
        "runnerCommit": "28f698820ec65c9ef301d257a34f7974a797f1eb"
      }
    },
    {
      "name": "coalesce",
      "logPath": "/tmp/wi16287-linked-coalesce-2253.log",
      "logSha256": "f5567b7c2759393e3a471cbd760da970bae0a2410c5d5e150ed9d75b804620a6",
      "descriptorLine": "[mutation-probe] mutation descriptor on: deployed reader 8005af2ad1 parses execution_details.mutation; probeInvocationId=1d511783-235b-44fe-80d8-3a09620ac48e mode=copy-out subject=packages/operator-core/lib/work-items-admission-promoter.ts",
      "evidence": {
        "environment": {
          "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
          "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
        },
        "runnerSha256": "576ab21c598086727d5e14cb578007aed99a067b6340040b8d7a18e78a888858",
        "result": {
          "verdict": "caught",
          "baselineExit": 0,
          "expected": "caught",
          "guardExit": 1,
          "mutantLedger": "test_runs:21295989",
          "mutantParse": "unchecked",
          "target": "copy-out",
          "baselineLedger": "test_runs:21295954",
          "assertionEvidence": "test-file-assertion-failure",
          "copyBaselineLedger": "test_runs:21295971",
          "relocation": "overlay"
        },
        "cwd": ".",
        "argv": [
          "--file",
          "packages/operator-core/lib/work-items-admission-promoter.ts",
          "--mutate",
          "s/SET status = 'dropped'/SET status = 'open'/",
          "--relocation",
          "overlay",
          "--test",
          "test -f {} && npm run test:file -- packages/operator-core/lib/work-items-admission-promoter.integration.test.ts -- --testNamePattern='replays six vitest clones'",
          "--expect",
          "caught"
        ],
        "schemaVersion": 1,
        "runnerCommit": "28f698820ec65c9ef301d257a34f7974a797f1eb",
        "runnerPath": "scripts/mutation-probe.sh"
      }
    }
  ],
  "limits": "Selected probes supplement original172 zero-skip corpus. Full transitive import graph unqualified. No production shipment claim."
}

