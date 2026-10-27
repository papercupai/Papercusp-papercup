---
rel_path: "evidence/identity-assume/recovery69/production-manifest.json"
updated_at: 1792972526739
_body: "content"
---

{
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "commit": "3957809831e5221a01c2e7dd14a70044b97b91ef",
  "blobs": {
    "scripts/test-files.mjs": "b1875d00f9210c5fd1f460235428bde23ec7ad27",
    "packages/operator-core/lib/__tests__/test-file-router.test.ts": "d50b91c8eb32956a6568301f8b6c0f16fa472435",
    "apps/operator/lib/psu-identity-assume-native.integration.test.ts": "7fad0538b31e848ddde070c86acd54244365fed5",
    "packages/operator-core/test/isolated-integration-proof.ts": "6ff2e13b4169a9d2e4ec2366928cc7a225d1e6af",
    "scripts/with-test-pg.mjs": "46a2fe8ee75cb12356d3ea0abdfe3b28aae2108d"
  },
  "args": [
    "scripts/with-test-pg.mjs",
    "--isolated-runtime",
    "--",
    "/home/marsh-office/.local/node25/bin/node",
    "--import",
    "./scripts/lib/committed-source-loader.mjs",
    "scripts/test-files.mjs",
    "apps/operator/lib/psu-identity-assume-native.integration.test.ts",
    "--testNamePattern=^uses production custody and routed responsibilities through the installed native handoff \\(native-resume\\)$"
  ],
  "group": "f4a3cccf-1f7c-4254-bd88-03682be35a51",
  "prefix": "/tmp/assume69-production-focus-f4a3cccf",
  "startedAt": "2026-10-25T23:35:55.173Z",
  "innerExecuteMs": 180000,
  "wholeTaskMs": 1500000
}
