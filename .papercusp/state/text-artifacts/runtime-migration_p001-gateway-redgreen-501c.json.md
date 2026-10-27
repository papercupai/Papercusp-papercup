---
rel_path: "runtime-migration/p001-gateway-redgreen-501c.json"
updated_at: 1792747583889
_body: "content"
---

{
  "workItem": "EI-26759744278831998",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "scope": "Local source regression and mixed interpreter private-PG fixture; no immutable candidate or shipped acceptance",
  "rootCause": "Gateway admission failure cleanup cancelled by idempotency key after lease authority was lost. This bypassed current lease-token fencing.",
  "fix": "Remove three internal cancel calls; retain lease-token releaseLease and explicit cancel API.",
  "red": {
    "candidateAcceptance": false,
    "closureAccepted": false,
    "beforeHashes": {
      "scripts/lib/runtime-compatibility-admission.mjs": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f",
      "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
      "packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts": "fd2711843e25803d1faa36842e85c51f5912c9ca3964b6ffba9716d7526e5aea",
      "packages/operator-core/lib/resource-governor/admission-ledger-store.ts": "f281a46760e2526e5669990c37a8968165d412b195ec11b4795be3d7073ec2c1",
      "packages/operator-core/lib/resource-governor/admission.ts": "be97b8156c9542517081ed9b39affaf64cf5674a140b1d8c3e19c0e28f74d116",
      "packages/operator-core/lib/resource-governor/queue.ts": "f0be1a4d84c6b8a9f03fc8d15a9ac41d0eb1c8cb9f9ac573474794762828921d",
      "packages/operator-core/lib/inference-gateway/durable-admission.ts": "9979443957d628ae771256f87854f32e86ff9a461d5f0bc7db325c53bd28e3f6",
      "packages/operator-core/test/_admission-ledger-fixture.ts": "6770104645281a3c0a86765d7590fb46a5b90f06115cc8523adea5a27dad38e2",
      "libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql": "ae5cd472afab6095014b67f1f0f802ddcd6b91a36a82a3cfc45d50a5e8abfd6b"
    },
    "afterHashes": {
      "scripts/lib/runtime-compatibility-admission.mjs": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f",
      "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
      "packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts": "fd2711843e25803d1faa36842e85c51f5912c9ca3964b6ffba9716d7526e5aea",
      "packages/operator-core/lib/resource-governor/admission-ledger-store.ts": "f281a46760e2526e5669990c37a8968165d412b195ec11b4795be3d7073ec2c1",
      "packages/operator-core/lib/resource-governor/admission.ts": "be97b8156c9542517081ed9b39affaf64cf5674a140b1d8c3e19c0e28f74d116",
      "packages/operator-core/lib/resource-governor/queue.ts": "f0be1a4d84c6b8a9f03fc8d15a9ac41d0eb1c8cb9f9ac573474794762828921d",
      "packages/operator-core/lib/inference-gateway/durable-admission.ts": "9979443957d628ae771256f87854f32e86ff9a461d5f0bc7db325c53bd28e3f6",
      "packages/operator-core/test/_admission-ledger-fixture.ts": "6770104645281a3c0a86765d7590fb46a5b90f06115cc8523adea5a27dad38e2",
      "libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql": "ae5cd472afab6095014b67f1f0f802ddcd6b91a36a82a3cfc45d50a5e8abfd6b"
    },
    "runtimes": [
      {
        "name": "node",
        "version": "25.9.0",
        "executable": "/home/marsh-office/.local/node25/bin/node",
        "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
        "platform": "linux",
        "arch": "x64"
      },
      {
        "name": "bun",
        "version": "1.3.14",
        "executable": "/home/marsh-office/.bun/bin/bun",
        "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
        "platform": "linux",
        "arch": "x64"
      }
    ],
    "receipts": [
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "actual": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "observation": {
          "nonce": "c008d477-b3be-4ae1-a1ca-85413ca227ff",
          "pid": 968274,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "c008d477-b3be-4ae1-a1ca-85413ca227ff",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 968274,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": false,
                "error": "AdmissionPersistenceError"
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "failed",
        "reasons": [
          "incorrect-result"
        ],
        "expected": {
          "admitted": true,
          "stateAfterCompetitor": "running",
          "released": true
        },
        "actual": {
          "admitted": true,
          "stateAfterCompetitor": "cancelled",
          "released": false
        },
        "observation": {
          "nonce": "14ab7fcf-9c7b-42b7-9a74-d06751b864b9",
          "pid": 967860,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "14ab7fcf-9c7b-42b7-9a74-d06751b864b9",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 967860,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": true,
                "stateAfterCompetitor": "cancelled",
                "released": false
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      }
    ],
    "limitations": [
      "synthetic candidate identity",
      "local source baseline",
      "liveness oracle held live; takeover is expiry based",
      "fixture effects are not provider/DBOS delivery",
      "named source hashes do not census transitive child imports",
      "no global background-owner proof"
    ]
  },
  "green": {
    "candidateAcceptance": false,
    "closureAccepted": false,
    "beforeHashes": {
      "scripts/lib/runtime-compatibility-admission.mjs": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f",
      "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
      "packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts": "fd2711843e25803d1faa36842e85c51f5912c9ca3964b6ffba9716d7526e5aea",
      "packages/operator-core/lib/resource-governor/admission-ledger-store.ts": "f281a46760e2526e5669990c37a8968165d412b195ec11b4795be3d7073ec2c1",
      "packages/operator-core/lib/resource-governor/admission.ts": "be97b8156c9542517081ed9b39affaf64cf5674a140b1d8c3e19c0e28f74d116",
      "packages/operator-core/lib/resource-governor/queue.ts": "f0be1a4d84c6b8a9f03fc8d15a9ac41d0eb1c8cb9f9ac573474794762828921d",
      "packages/operator-core/lib/inference-gateway/durable-admission.ts": "20502cd8a0378ca21a2bc8293d7e62efd886a6262032cdd710026965b20d18a5",
      "packages/operator-core/test/_admission-ledger-fixture.ts": "6770104645281a3c0a86765d7590fb46a5b90f06115cc8523adea5a27dad38e2",
      "libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql": "ae5cd472afab6095014b67f1f0f802ddcd6b91a36a82a3cfc45d50a5e8abfd6b"
    },
    "afterHashes": {
      "scripts/lib/runtime-compatibility-admission.mjs": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f",
      "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
      "packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts": "fd2711843e25803d1faa36842e85c51f5912c9ca3964b6ffba9716d7526e5aea",
      "packages/operator-core/lib/resource-governor/admission-ledger-store.ts": "f281a46760e2526e5669990c37a8968165d412b195ec11b4795be3d7073ec2c1",
      "packages/operator-core/lib/resource-governor/admission.ts": "be97b8156c9542517081ed9b39affaf64cf5674a140b1d8c3e19c0e28f74d116",
      "packages/operator-core/lib/resource-governor/queue.ts": "f0be1a4d84c6b8a9f03fc8d15a9ac41d0eb1c8cb9f9ac573474794762828921d",
      "packages/operator-core/lib/inference-gateway/durable-admission.ts": "20502cd8a0378ca21a2bc8293d7e62efd886a6262032cdd710026965b20d18a5",
      "packages/operator-core/test/_admission-ledger-fixture.ts": "6770104645281a3c0a86765d7590fb46a5b90f06115cc8523adea5a27dad38e2",
      "libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql": "ae5cd472afab6095014b67f1f0f802ddcd6b91a36a82a3cfc45d50a5e8abfd6b"
    },
    "runtimes": [
      {
        "name": "node",
        "version": "25.9.0",
        "executable": "/home/marsh-office/.local/node25/bin/node",
        "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
        "platform": "linux",
        "arch": "x64"
      },
      {
        "name": "bun",
        "version": "1.3.14",
        "executable": "/home/marsh-office/.bun/bin/bun",
        "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
        "platform": "linux",
        "arch": "x64"
      }
    ],
    "receipts": [
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "actual": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "observation": {
          "nonce": "7c24e109-c2e5-4539-aa9d-6d4856b85963",
          "pid": 1686295,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "7c24e109-c2e5-4539-aa9d-6d4856b85963",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 1686295,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": false,
                "error": "AdmissionPersistenceError"
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "admitted": true,
          "stateAfterCompetitor": "running",
          "released": true
        },
        "actual": {
          "admitted": true,
          "stateAfterCompetitor": "running",
          "released": true
        },
        "observation": {
          "nonce": "0c4c7907-911f-48a6-8c70-8f0adac8a9ac",
          "pid": 1685692,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "0c4c7907-911f-48a6-8c70-8f0adac8a9ac",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 1685692,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": true,
                "stateAfterCompetitor": "running",
                "released": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "admitted": true,
          "stateAfterCompetitor": "running",
          "released": true
        },
        "actual": {
          "admitted": true,
          "stateAfterCompetitor": "running",
          "released": true
        },
        "observation": {
          "nonce": "58a393c0-f2c3-49de-9077-e5f2cd82fad7",
          "pid": 1692522,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "58a393c0-f2c3-49de-9077-e5f2cd82fad7",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 1692522,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": true,
                "stateAfterCompetitor": "running",
                "released": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-gateway",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "actual": {
          "admitted": false,
          "error": "AdmissionPersistenceError"
        },
        "observation": {
          "nonce": "a1f751bb-258a-4699-9622-d2ea8e5c6be2",
          "pid": 1693079,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "a1f751bb-258a-4699-9622-d2ea8e5c6be2",
              "capabilityId": "admission-gateway",
              "completed": true,
              "pid": 1693079,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "admitted": false,
                "error": "AdmissionPersistenceError"
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-enqueue",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "queued": true
        },
        "actual": {
          "queued": true
        },
        "observation": {
          "nonce": "ffefc026-b324-4c56-a3ca-09d7304f0136",
          "pid": 1700443,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "ffefc026-b324-4c56-a3ca-09d7304f0136",
              "capabilityId": "admission-enqueue",
              "completed": true,
              "pid": 1700443,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "queued": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-enqueue",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "queued": true
        },
        "actual": {
          "queued": true
        },
        "observation": {
          "nonce": "3860a8eb-4983-4f5d-bfb3-8e7873e5922e",
          "pid": 1700032,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "3860a8eb-4983-4f5d-bfb3-8e7873e5922e",
              "capabilityId": "admission-enqueue",
              "completed": true,
              "pid": 1700032,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "queued": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-enqueue",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "queued": true
        },
        "actual": {
          "queued": true
        },
        "observation": {
          "nonce": "2f222bee-bcd5-47fd-85e0-458f3696a30f",
          "pid": 1704907,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "2f222bee-bcd5-47fd-85e0-458f3696a30f",
              "capabilityId": "admission-enqueue",
              "completed": true,
              "pid": 1704907,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "queued": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-lease",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": {
          "leased": true,
          "running": true
        },
        "observation": {
          "nonce": "1100ab1b-88bf-408c-bde9-99414095ab45",
          "pid": 1709263,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "1100ab1b-88bf-408c-bde9-99414095ab45",
              "capabilityId": "admission-lease",
              "completed": true,
              "pid": 1709263,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "leased": true,
                "running": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-lease",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "failed",
        "reasons": [
          "incorrect-result"
        ],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": {
          "leased": false,
          "running": false
        },
        "observation": {
          "nonce": "e607b96a-e14c-43af-83cd-a4b89e41f151",
          "pid": 1708908,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "e607b96a-e14c-43af-83cd-a4b89e41f151",
              "capabilityId": "admission-lease",
              "completed": true,
              "pid": 1708908,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "leased": false,
                "running": false
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-enqueue",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "queued": true
        },
        "actual": {
          "queued": true
        },
        "observation": {
          "nonce": "e24261a5-72f6-48c4-a426-2bcb306dbca2",
          "pid": 1714711,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "e24261a5-72f6-48c4-a426-2bcb306dbca2",
              "capabilityId": "admission-enqueue",
              "completed": true,
              "pid": 1714711,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "queued": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-hold",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "failed",
        "reasons": [
          "abnormal-exit",
          "missing-or-duplicate-completion"
        ],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": null,
        "observation": {
          "nonce": "9625b53d-20a8-4e25-a090-ca46376024fc",
          "pid": 1720723,
          "exitCode": null,
          "signal": "SIGKILL",
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-lease",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": {
          "leased": true,
          "running": true
        },
        "observation": {
          "nonce": "be17a1d6-5af9-426a-b702-53d4af2022ee",
          "pid": 1730371,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "be17a1d6-5af9-426a-b702-53d4af2022ee",
              "capabilityId": "admission-lease",
              "completed": true,
              "pid": 1730371,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "leased": true,
                "running": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-stale",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "running": false,
          "completed": false
        },
        "actual": {
          "running": false,
          "completed": false
        },
        "observation": {
          "nonce": "2b5e6e14-b4af-4ef8-ad66-489c596a1d89",
          "pid": 1733410,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "2b5e6e14-b4af-4ef8-ad66-489c596a1d89",
              "capabilityId": "admission-stale",
              "completed": true,
              "pid": 1733410,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "running": false,
                "completed": false
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-complete",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "completed": true
        },
        "actual": {
          "completed": true
        },
        "observation": {
          "nonce": "3d0eaaa1-7b72-4133-a098-de00c223bcc8",
          "pid": 1738868,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "3d0eaaa1-7b72-4133-a098-de00c223bcc8",
              "capabilityId": "admission-complete",
              "completed": true,
              "pid": 1738868,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "completed": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-enqueue",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "queued": true
        },
        "actual": {
          "queued": true
        },
        "observation": {
          "nonce": "4c9dfd06-e2ce-4906-bcb4-e73b21d87cd6",
          "pid": 1741011,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "4c9dfd06-e2ce-4906-bcb4-e73b21d87cd6",
              "capabilityId": "admission-enqueue",
              "completed": true,
              "pid": 1741011,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "queued": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-hold",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "failed",
        "reasons": [
          "abnormal-exit",
          "missing-or-duplicate-completion"
        ],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": null,
        "observation": {
          "nonce": "04f040b0-7ef8-401f-8ff0-07e85973dbce",
          "pid": 1742688,
          "exitCode": null,
          "signal": "SIGKILL",
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-lease",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "leased": true,
          "running": true
        },
        "actual": {
          "leased": true,
          "running": true
        },
        "observation": {
          "nonce": "2e5554f3-0247-4afd-9df1-b235828fb0af",
          "pid": 1745253,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "2e5554f3-0247-4afd-9df1-b235828fb0af",
              "capabilityId": "admission-lease",
              "completed": true,
              "pid": 1745253,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "leased": true,
                "running": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-stale",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "bun",
          "version": "1.3.14",
          "executable": "/home/marsh-office/.bun/bin/bun",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "running": false,
          "completed": false
        },
        "actual": {
          "running": false,
          "completed": false
        },
        "observation": {
          "nonce": "a661b2e1-0214-483d-b81f-9e7ae9e4e983",
          "pid": 1751953,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "a661b2e1-0214-483d-b81f-9e7ae9e4e983",
              "capabilityId": "admission-stale",
              "completed": true,
              "pid": 1751953,
              "runtime": {
                "name": "bun",
                "version": "1.3.14",
                "executable": "/home/marsh-office/.bun/bin/bun",
                "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "running": false,
                "completed": false
              }
            }
          ],
          "stderr": "",
          "binarySha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      },
      {
        "schema": "papercusp-runtime-capability-v1",
        "capabilityId": "admission-complete",
        "candidate": {
          "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "lockfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "dependencyGeneration": "admission-source-fixture"
        },
        "runtime": {
          "name": "node",
          "version": "25.9.0",
          "executable": "/home/marsh-office/.local/node25/bin/node",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "platform": "linux",
          "arch": "x64"
        },
        "status": "passed",
        "reasons": [],
        "expected": {
          "completed": true
        },
        "actual": {
          "completed": true
        },
        "observation": {
          "nonce": "2f6e2e8f-5562-42f2-89be-ec5d5dac5834",
          "pid": 1753774,
          "exitCode": 0,
          "signal": null,
          "timedOut": false,
          "overflow": false,
          "error": null,
          "receipts": [
            {
              "nonce": "2f6e2e8f-5562-42f2-89be-ec5d5dac5834",
              "capabilityId": "admission-complete",
              "completed": true,
              "pid": 1753774,
              "runtime": {
                "name": "node",
                "version": "25.9.0",
                "executable": "/home/marsh-office/.local/node25/bin/node",
                "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
                "platform": "linux",
                "arch": "x64"
              },
              "actual": {
                "completed": true
              }
            }
          ],
          "stderr": "",
          "binarySha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
          "probePath": "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/runtime-compatibility-admission.mjs",
          "probeSha256": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f"
        }
      }
    ],
    "limitations": [
      "synthetic candidate identity",
      "local source baseline",
      "liveness oracle held live; takeover is expiry based",
      "fixture effects are not provider/DBOS delivery",
      "named source hashes do not census transitive child imports",
      "no global background-owner proof"
    ]
  },
  "testResult": {
    "exitCode": 0,
    "testsPassed": 10,
    "skippedTests": 0,
    "files": 2,
    "childSubstituted": 10,
    "privatePgStopped": true
  },
  "evidenceFiles": {
    "/tmp/bun-p001-gateway-red2-receipts-501c.json": "4badf5dbcb46e35765285b7514bfd7f0cf8e7688152653fc351b245cf7119e95",
    "/tmp/bun-p001-gateway-green-receipts-501c.json": "081bd1ecd524f30b98a0e390740fcf1caaf4be68476595dae07b47129b3fb193",
    "/tmp/bun-p001-gateway-green-tests-501c.log": "eaca4b2f518f29cca0b1e3e4b8e57e7ff8bb4f9013685c0f2b5f878073ffbfd2",
    "/tmp/bun-p001-gateway-red-tests-501c.log": "93dfc4691718c1fd8176852f91805a1aaf945e8015e57fba571b7241b81b4ee2"
  },
  "currentSourceHashes": {
    "scripts/lib/runtime-compatibility-admission.mjs": "21c0d71105b30a79820d716f0fd644a38a0435d457b196edf63fed673a202d8f",
    "scripts/lib/runtime-compatibility.mjs": "81c8465b580a76da8df358e8a1d085ff6bbb8ad4e26fee4099cce52af95bfed8",
    "packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts": "fd2711843e25803d1faa36842e85c51f5912c9ca3964b6ffba9716d7526e5aea",
    "packages/operator-core/lib/resource-governor/admission-ledger-store.ts": "f281a46760e2526e5669990c37a8968165d412b195ec11b4795be3d7073ec2c1",
    "packages/operator-core/lib/resource-governor/admission.ts": "be97b8156c9542517081ed9b39affaf64cf5674a140b1d8c3e19c0e28f74d116",
    "packages/operator-core/lib/resource-governor/queue.ts": "f0be1a4d84c6b8a9f03fc8d15a9ac41d0eb1c8cb9f9ac573474794762828921d",
    "packages/operator-core/lib/inference-gateway/durable-admission.ts": "20502cd8a0378ca21a2bc8293d7e62efd886a6262032cdd710026965b20d18a5",
    "packages/operator-core/test/_admission-ledger-fixture.ts": "6770104645281a3c0a86765d7590fb46a5b90f06115cc8523adea5a27dad38e2",
    "libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql": "ae5cd472afab6095014b67f1f0f802ddcd6b91a36a82a3cfc45d50a5e8abfd6b",
    "packages/operator-core/lib/inference-gateway/durable-admission.test.ts": "8654716530c04762cce18b36dc83f87dd6b228eba1a9e9368f13cd757e792f17"
  },
  "recordedHead": "6bffe39570ed67111efcd2689c991791b3bb28b2"
}
