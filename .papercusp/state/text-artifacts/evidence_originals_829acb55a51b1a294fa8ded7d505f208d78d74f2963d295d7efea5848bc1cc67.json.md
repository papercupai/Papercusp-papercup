---
rel_path: "evidence/originals/829acb55a51b1a294fa8ded7d505f208d78d74f2963d295d7efea5848bc1cc67.json"
updated_at: 1790936181224
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-10005366",
  "parent": "WI-10004890",
  "plane": "serving-artifact-private-operator-api-ordinary-baseline",
  "before": {
    "unit": "papercusp-staging-api.service",
    "pid": 3769333,
    "startTicks": "21610144",
    "sourceRoot": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-5689cb42afea.OUGjKK/checkout",
    "sourceDirectory": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-5689cb42afea.OUGjKK/checkout/apps/operator/dist-host",
    "buildSha": "5689cb42afea859733423d0a361c20e79078f4fa",
    "bundleSha256": "8a97736b596731b4acf603e37684396f33f0c51a598551ed1b201d2214fe14e8"
  },
  "sources": [
    {
      "path": "packages/operator-core/lib/service-memory-attribution.integration.test.ts",
      "sha256": "b981bfa4804b72bbc47b3dedd30663d9631bd1fdb3a724b0529fa2ea64b037c6",
      "servingSha256": "1898b7f7c99a4b4515b05f9dcf7f8e82059ce37c22a70b7f5db4bbe87db8cd1d"
    },
    {
      "path": "scripts/cdp-inspector.mjs",
      "sha256": "e6f6d3888d527ebfee97a62dc83111e0bf01997e26cfb87512db86fe8b2df91c",
      "servingSha256": "e6f6d3888d527ebfee97a62dc83111e0bf01997e26cfb87512db86fe8b2df91c"
    },
    {
      "path": "scripts/with-test-pg.mjs",
      "sha256": "162b5115921d326ec78d064a9e2ab38d3affd1a1d551f42363a6a958464d21c0",
      "servingSha256": "162b5115921d326ec78d064a9e2ab38d3affd1a1d551f42363a6a958464d21c0"
    },
    {
      "path": "libs/generic/cache/src/cache.ts",
      "sha256": "0cfee2e70c839c00c00bf2f272abd7ea67987918bf3806fb5e80f24e727c1d43",
      "servingSha256": "0cfee2e70c839c00c00bf2f272abd7ea67987918bf3806fb5e80f24e727c1d43"
    },
    {
      "path": "libs/generic/cache/src/l1.ts",
      "sha256": "89ac9e14aeed616e2ba82060f9e153d62975d9c9806a4587f831d8700ad84977",
      "servingSha256": "89ac9e14aeed616e2ba82060f9e153d62975d9c9806a4587f831d8700ad84977"
    },
    {
      "path": "libs/generic/cache/src/generation-store.ts",
      "sha256": "9a5994bcf99eddfa65562343415c3c90a5fdb42c8729b4d275277e3891c00c47",
      "servingSha256": "9a5994bcf99eddfa65562343415c3c90a5fdb42c8729b4d275277e3891c00c47"
    },
    {
      "path": "packages/operator-core/lib/cache-retention.performance.integration.test.ts",
      "sha256": "a698e9140046c0adbb1bbb2911aee755af5150b2fdda823e17e2be351a61e9cd",
      "servingSha256": "a698e9140046c0adbb1bbb2911aee755af5150b2fdda823e17e2be351a61e9cd"
    }
  ],
  "startedAt": "2026-10-02T07:50:50.101Z",
  "testNamePattern": "binds ordinary PSS",
  "fullGraphCurrentness": "unknown",
  "incomplete": false,
  "runnerError": {
    "message": "Command failed: npm run test:file -- packages/operator-core/lib/service-memory-attribution.integration.test.ts --testNamePattern=binds ordinary PSS",
    "signal": null
  },
  "after": {
    "unit": "papercusp-staging-api.service",
    "pid": 3769333,
    "startTicks": "21610144",
    "sourceRoot": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-5689cb42afea.OUGjKK/checkout",
    "sourceDirectory": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-5689cb42afea.OUGjKK/checkout/apps/operator/dist-host",
    "buildSha": "5689cb42afea859733423d0a361c20e79078f4fa",
    "bundleSha256": "8a97736b596731b4acf603e37684396f33f0c51a598551ed1b201d2214fe14e8"
  },
  "servingArtifactStable": true,
  "finishedAt": "2026-10-02T07:52:58.749Z",
  "exitCode": 1,
  "testSourceStable": true
}

