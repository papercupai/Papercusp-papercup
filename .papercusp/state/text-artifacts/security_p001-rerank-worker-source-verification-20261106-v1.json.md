---
rel_path: "security/p001-rerank-worker-source-verification-20261106-v1.json"
updated_at: 1793939684215
_body: "content"
---

{
  "schema": "p001-rerank-worker-source-verification-v1",
  "method": "Independent Python hashlib SHA256 and git-blob SHA1 of git-show bytes versus Nodecrypto/git-cat-file; exact text, explicit source import/constructor/require assertions and relative worker script identities. Source-only, no worker/native execution.",
  "extraction": {
    "path": "/tmp/p001-rerank-worker-source-extraction-20261106-v1.json",
    "bytes": 63508,
    "sha256": "cc4bce02feb3fbaf0e1e809fca533cf852a93a4ef14980e882be9c312804b856"
  },
  "checks": [
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/execution-target.ts",
      "sha256": "183936cbef9e11d98cf3b7ef0672bf4cd297551ed0ce7fc5811b194a979b6a37",
      "gitBlob": "6f7a3f806bad9f733df26afbecbd10a3f19427fe",
      "bytes": 6870,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "constructorAndRequireAssertionsMatch": true,
      "relativeAndWorkerEntrypointIdentitiesMatch": true,
      "diagnosticsEmpty": true
    },
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/local-reranker-worker.ts",
      "sha256": "d58a9be8a3bf58d5f78debd24285af1253dcf7ace7118144c40a6948fe1c709f",
      "gitBlob": "5b64cf164f510a6f72ce19f663e8a438c4b7e03a",
      "bytes": 20559,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "constructorAndRequireAssertionsMatch": true,
      "relativeAndWorkerEntrypointIdentitiesMatch": true,
      "diagnosticsEmpty": true
    }
  ]
}

