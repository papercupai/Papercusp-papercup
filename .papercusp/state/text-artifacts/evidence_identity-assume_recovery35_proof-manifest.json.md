---
rel_path: "evidence/identity-assume/recovery35/proof-manifest.json"
updated_at: 1792898669187
_body: "content"
---

{
  "workItem": "WI-6554700010025439",
  "plan": "agent-assume-identity-2026-10-23",
  "item": "P-001",
  "scope": "clean committed native7 clause evidence; not BAR certification or shipment",
  "commit": "5ef349f8bd7e52d6e66045e67419066d3a1c08eb",
  "worktreeDirty": false,
  "testRunId": 21960648,
  "receiptOutcome": "inserted",
  "execution": {
    "passed": 7,
    "failed": 0,
    "skipped": 0
  },
  "nativeRun": {
    "terminalHook": "onTestRunEnd",
    "reason": "passed",
    "unhandledErrorCount": 0,
    "modulePopulationMatched": true
  },
  "sourceEvidence": "stable",
  "privatePGStopped": true,
  "artifacts": [
    {
      "path": "evidence/identity-assume/recovery35/assume35-materialize.log.gz.b64",
      "bytes": 12287,
      "sha256": "7957b4a68c13d851d8a36e335ba950a15249551b9bd555dd78e461383d400319"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-native-manifest.json.gz.b64",
      "bytes": 530,
      "sha256": "e26e703ceaf6dca2964d287de0fc026b3c3eb4a083646842a8c5e0e487d1d56f"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-native-source-map.json.gz.b64",
      "bytes": 9547114,
      "sha256": "7a6a8617849f3c8c828fc354e4c41248fb8c61abbb473ba12e111a0fc7440cad"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-native-receipt.json.gz.b64",
      "bytes": 3336,
      "sha256": "ad9ef481e158921e1c5f11a045122191d409514977e86d6fa640abf5e9ea6d76"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-native.log.gz.b64",
      "bytes": 868486,
      "sha256": "36d0d644bfadaf20d0671754badee41d1a0dfce66dbced66c009c7568b7a8c3c"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-bind-input.json.gz.b64",
      "bytes": 8612,
      "sha256": "cf64f18d33d4e51fd360ecf7b8b8046a41641323b39dd73284d1fe5cd6deb4e9"
    },
    {
      "path": "evidence/identity-assume/recovery35/assume35-bind-output.json.gz.b64",
      "bytes": 2619,
      "sha256": "229790acc9ec8bbd4d5996ea533620663881fbb2fc528aa8728ec1ae6955ad19"
    }
  ],
  "holds": [
    "native execution",
    "custody",
    "admission",
    "release",
    "no author/live-peer takeover",
    "no LIVE_GATE_OPS"
  ]
}
