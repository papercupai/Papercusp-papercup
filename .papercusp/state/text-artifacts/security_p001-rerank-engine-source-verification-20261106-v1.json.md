---
rel_path: "security/p001-rerank-engine-source-verification-20261106-v1.json"
updated_at: 1793939483577
_body: "content"
---

{
  "schema": "p001-rerank-engine-source-verification-v1",
  "method": "Independent Python hashlib SHA256 and git-blob SHA1 of git-show bytes versus Node crypto/git-cat-file capture; full text and explicit static/dynamic source assertions; relative target identities. AST is offline navigation only.",
  "extraction": {
    "path": "/tmp/p001-rerank-engine-source-extraction-20261106-v1.json",
    "bytes": 69470,
    "sha256": "0f1ce260e32692c2e5b55062861841b440eb8dbdedbe67b31700dcb1a9676384"
  },
  "checks": [
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/local-engine.ts",
      "sha256": "0d175f7d3e8206454626fa2ce614e69d040e3ac5ebbdf094fd3694b9bc61877d",
      "gitBlob": "fc3dad4ae91c448b87c0222800a98788f9afb7a2",
      "bytes": 25500,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "dynamicImportAssertionsMatch": true,
      "resolvedModuleIdentitiesMatch": true,
      "diagnosticsEmpty": true
    },
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/scorer-gate.ts",
      "sha256": "10a883a24c62748d3f83f11f7cd5d0417afc124dc860f90fed723a32c7b6f602",
      "gitBlob": "57cc70ea08efdd476c8afa9af3da0e647fc6d29b",
      "bytes": 9054,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "dynamicImportAssertionsMatch": true,
      "resolvedModuleIdentitiesMatch": true,
      "diagnosticsEmpty": true
    }
  ]
}

