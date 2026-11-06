---
rel_path: "security/p001-sidecar-client-source-verification-20261106-v1.json"
updated_at: 1793939139887
_body: "content"
---

{
  "schema": "p001-sidecar-client-source-verification-v1",
  "method": "Independent Python hashlib SHA256 and git-blob SHA1 of git-show bytes versus Node crypto and git-cat-file capture; exact source text, static import assertions and resolved relative target identities. AST parsing is navigation only.",
  "extraction": {
    "path": "/tmp/p001-sidecar-client-source-extraction-20261106-v1.json",
    "bytes": 111000,
    "sha256": "c60dc551ec8620aa5e472e9d2486306a93c16900d32640186ef8987ba243ef5c"
  },
  "checks": [
    {
      "repository": "libs/generic/memory",
      "revision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
      "path": "src/sidecar-embedder.ts",
      "sha256": "6aa17f449b4fe25ac09da37ce77dc77070f0c0fb091e6d72a31bf9c312b9a092",
      "gitBlob": "f4df564acaa54415b14b59b3a7ab41969b447937",
      "bytes": 19360,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "diagnosticsEmpty": true,
      "callsObserved": 69,
      "resolvedModuleIdentitiesMatch": true
    },
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/sidecar-reranker.ts",
      "sha256": "359fdd2b4d5dc851ba4d0d906049ffbca6934773e678e233aec240a1599c94d9",
      "gitBlob": "7e9d79ec39396063a25a4ee10d1a1bb85cb4b9b9",
      "bytes": 22554,
      "textMatches": true,
      "metadataMatches": true,
      "staticImportAssertionsMatch": true,
      "diagnosticsEmpty": true,
      "callsObserved": 96,
      "resolvedModuleIdentitiesMatch": true
    }
  ]
}

