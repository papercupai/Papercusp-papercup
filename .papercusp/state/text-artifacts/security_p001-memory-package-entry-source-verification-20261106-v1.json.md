---
rel_path: "security/p001-memory-package-entry-source-verification-20261106-v1.json"
updated_at: 1793938000362
_body: "content"
---

{
  "schema": "p001-memory-package-entry-identity-verification-v1",
  "method": "Python hashlib/git-show versus Node crypto/git-cat-file; complete bytes+text equality",
  "checks": [
    {
      "repository": ".",
      "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "path": "package.json",
      "sha256": "2a94c4fd43d93c1453e8d0b13b2047004d5df6b52520dc5a64a15872dc7c4ee3",
      "bytes": 35330,
      "matches": true,
      "textMatches": null
    },
    {
      "repository": ".",
      "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "path": "packages/operator-core/package.json",
      "sha256": "7368c8432701a9c3ebdcb8fa94058bd4836f6c85e16372f20d50f3385b9daae4",
      "bytes": 17554,
      "matches": true,
      "textMatches": null
    },
    {
      "repository": ".",
      "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "path": "package-lock.json",
      "sha256": "a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42",
      "bytes": 1432077,
      "matches": true,
      "textMatches": null
    },
    {
      "repository": "libs/generic/memory",
      "revision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
      "path": "package.json",
      "sha256": "be1dc2242efc6304cebbb6e7714119de7c9aa2228f28c6960e82aee1b060b100",
      "bytes": 1336,
      "matches": true,
      "textMatches": true
    },
    {
      "repository": "libs/generic/memory",
      "revision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
      "path": "src/index.ts",
      "sha256": "201abd830fe18e3e0e4519f2b8a164895b5170b37908bb86d5884257b5fe5b14",
      "bytes": 9429,
      "matches": true,
      "textMatches": true
    },
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "package.json",
      "sha256": "3624c8ef04c70aa1a0b8bbb8d147ade32e7ac4c3adf2067e9037e23dd3780513",
      "bytes": 1420,
      "matches": true,
      "textMatches": true
    },
    {
      "repository": "libs/generic/rerank",
      "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/index.ts",
      "sha256": "8ce43e8d8fdf4c30d2bf7ed964e99616965ee6dbf57f0a05f950f67c2ec16660",
      "bytes": 17470,
      "matches": true,
      "textMatches": true
    }
  ]
}
