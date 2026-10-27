---
rel_path: "evidence/p536-fire58-standing-lease-source-feasibility-20261025-v1.json"
updated_at: 1792898155798
_body: "content"
---

{
  "schemaVersion": "p536-source-feasibility-v1",
  "scope": "static source and deterministic arithmetic only; no private DB, runtime, identity or key effects",
  "sourceRows": [
    {
      "path": "packages/operator-core/lib/identity/attest.ts",
      "currentSha256": "e36a100348a1069d32d9c9962ffaa2eb3f3ef88ac007c7a8da352f5c85270ae7",
      "retainedSha256": "e36a100348a1069d32d9c9962ffaa2eb3f3ef88ac007c7a8da352f5c85270ae7",
      "sameBytes": true
    },
    {
      "path": "packages/operator-core/lib/sync/hyperbee/verify-binding-adapter.ts",
      "currentSha256": "13bd18f70c719c34f3b78c853faf5ae17903a0f35e87a0b2bc9548ccd8e93225",
      "retainedSha256": "13bd18f70c719c34f3b78c853faf5ae17903a0f35e87a0b2bc9548ccd8e93225",
      "sameBytes": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/capability/vm-copy-authority.ts",
      "currentSha256": "dc03fcbaab8febb78f60b35d18fb8d1d035bae30a1e0d3a5ed9d55b15dde1b08",
      "retainedSha256": "dc03fcbaab8febb78f60b35d18fb8d1d035bae30a1e0d3a5ed9d55b15dde1b08",
      "sameBytes": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/capability/vm-copy-authority-bridge.ts",
      "currentSha256": "4a0be39e4897251b1619dc6299022de569d27a8d41f882c2eb17631764356d98",
      "retainedSha256": "4a0be39e4897251b1619dc6299022de569d27a8d41f882c2eb17631764356d98",
      "sameBytes": true
    },
    {
      "path": "libs/papercusp/packages/locks/src/resource-lock-store.ts",
      "currentSha256": "6be3ba6a394070372f75345c57af856f4336837061b08cd86ab1853b7be423e9",
      "retainedSha256": "6be3ba6a394070372f75345c57af856f4336837061b08cd86ab1853b7be423e9",
      "sameBytes": true
    }
  ],
  "leaseExample": {
    "acquireSeconds": 1000.1,
    "observationSeconds": 1000.101,
    "ttlSec": 300,
    "requiredRemainingSec": 300,
    "writerExpirySeconds": 1300.1,
    "readerMinimumExpirySeconds": 1301,
    "wouldPassExpiryPredicate": false
  },
  "standingBlocker": "D331 real matching published GitHub attestation is required; current private key isolation/no-publication envelope has no admitted way to establish it. No actual identity/key/API probe performed.",
  "issueRef": "EI-26919547969987200",
  "activationAudit": {
    "auditSeq": 119,
    "auditedPlanRevisionSeq": 571,
    "currentPlanVersion": 574,
    "contentHash": "8b7f88d2668372c382ae7c06082e6e711b5a00c7fe8b806c908c5efb623ab697",
    "basis": "latest canonical audit row read via bounded dev:pg_query; exact hash equals plans:get current D331 hash. Version and audit revision sequence are different fields."
  },
  "routeProposal": {
    "status": "not-authorized",
    "proposal": "Narrow fixture amendment for exactly one genuine public disposable gist for fresh isolated key under explicitly designated real GitHub identity/credential, real skipCache verification and recorded cleanup; requires owner publication approval before execution.",
    "sourceOwner": "su-48ad7866-4ca5-48f1-90e7-5c5c4572e6d6",
    "sourceAck": "D331 setup blocker retained; checking exact publication scope before ruling."
  }
}
