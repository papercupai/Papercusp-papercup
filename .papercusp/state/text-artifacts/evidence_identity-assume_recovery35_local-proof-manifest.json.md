---
rel_path: "evidence/identity-assume/recovery35/local-proof-manifest.json"
updated_at: 1792900285592
_body: "content"
---

{
  "workItem": "WI-6554700010025439",
  "scope": "local working-tree R1/R2 increment; not committed BAR certification",
  "nativeCommittedProof": "evidence/identity-assume/recovery35/proof-manifest.json",
  "nativeBindings": [
    69628,
    69629,
    69630,
    69631,
    69632,
    69633
  ],
  "runs": [
    {
      "kind": "pg",
      "testFile": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "testRunId": 21965565,
      "recordedSha": "ed22c6cb2b8bf1b9a8c1d87f189bb805e1106ccf",
      "worktreeDirty": true,
      "sourceEvidence": "stable",
      "capturedTestSha256": "48377fe5d0ba5507e5f1a3d0d188ef0a2b8911b8ecd8d7f8c23e72766d921938",
      "execution": {
        "passed": 39,
        "failed": 0,
        "skipped": 0
      },
      "nativeRun": {
        "reason": "passed",
        "terminalHook": "onTestRunEnd",
        "modulePopulationMatched": true,
        "unhandledErrorCount": 0
      },
      "sourceMap": "assume35-final-pg-source-map.json",
      "receipt": "assume35-final-pg-receipt.json"
    },
    {
      "kind": "core",
      "testFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "testRunId": 21965562,
      "recordedSha": "ed22c6cb2b8bf1b9a8c1d87f189bb805e1106ccf",
      "worktreeDirty": true,
      "sourceEvidence": "stable",
      "capturedTestSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
      "execution": {
        "passed": 68,
        "failed": 0,
        "skipped": 0
      },
      "nativeRun": {
        "reason": "passed",
        "terminalHook": "onTestRunEnd",
        "modulePopulationMatched": true,
        "unhandledErrorCount": 0
      },
      "sourceMap": "assume35-final-unit-source-map.1.json",
      "receipt": "assume35-final-unit-receipt.json"
    },
    {
      "kind": "channel",
      "testFile": "apps/operator/lib/psu-session-assume.test.ts",
      "testRunId": 21965568,
      "recordedSha": "d6094ca6bc2a15fcbbb1271b14ffea9b0664fc2e",
      "worktreeDirty": true,
      "sourceEvidence": "stable",
      "capturedTestSha256": "5138c0c64e73b80730e2321c9fe4c96394786e1ba6238d4d33b1475bd114960c",
      "execution": {
        "passed": 3,
        "failed": 0,
        "skipped": 0
      },
      "nativeRun": {
        "reason": "passed",
        "terminalHook": "onTestRunEnd",
        "modulePopulationMatched": true,
        "unhandledErrorCount": 0
      },
      "sourceMap": "assume35-channel-final-source-map.json",
      "receipt": "assume35-channel-final-receipt.json"
    }
  ],
  "privatePGStopped": true,
  "typecheckLog": "assume35-final-typecheck.log",
  "followups": [
    "EI-26917338932462786",
    "EI-26921648817075246",
    "EI-26921800584080140"
  ],
  "remaining": "Missing R1/R2 full installed-native responsibility/control population, remaining BAR selectors, six stale mutation proofs, ordered dependent items and independent acceptance/shipment.",
  "artifacts": [
    {
      "path": "evidence/identity-assume/recovery35/assume35-channel-final-receipt.json.gz.b64",
      "bytes": 2166,
      "sha256": "5e6906d2db0bef65c89c972d283fb940b914df4ef181f404b6d13aeaf7a2875a"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-channel-final-source-map.json.gz.b64",
      "bytes": 124599,
      "sha256": "31f27798f500a8ae1710aed3bafe4dd19ec2fc5ae4b29d107387e230b4261461"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-channel-final.log.gz.b64",
      "bytes": 8744,
      "sha256": "01088acf865c6a99ad12b5759e01066f9ac4592953e47ae4d3ea93b4af8d3811"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-pg-receipt.json.gz.b64",
      "bytes": 15236,
      "sha256": "2c1e3efe579dfd5c8878e567c0c6b685c906820d58dbd0a18548d6cf13f4ba35"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-pg-source-map.json.gz.b64",
      "bytes": 9432595,
      "sha256": "bbb551cb689259f0dc4b2efad13ed72c018ca2cb74edd40a275c8793051763a2"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-pg.log.gz.b64",
      "bytes": 869526,
      "sha256": "703b23d9ddb5fc775cb61b1c8ee039dbc86b639ee4548e423dff7009919d6101"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-typecheck.log.gz.b64",
      "bytes": 6508,
      "sha256": "206e5facf61985d123729b9ed7cba57af01065e77795392c65594a4e5d733dc7"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-unit-receipt.json.gz.b64",
      "bytes": 26211,
      "sha256": "68a626597de53656e55f75b2a6d9730fc0440b5156767a2b3e77a5a491d04cdc"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-unit-source-map.1.json.gz.b64",
      "bytes": 101059,
      "sha256": "8cb6e9b2fddca8fddd1c1f69b35ff45398e2932fd331dc6529dc1d66cd6ac7d1"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-final-unit.log.gz.b64",
      "bytes": 27304,
      "sha256": "a271593b5897df12def20c3b7cf0c85c245648e734b18a76c0e956ce3921ea6b"
    }
  ]
}
