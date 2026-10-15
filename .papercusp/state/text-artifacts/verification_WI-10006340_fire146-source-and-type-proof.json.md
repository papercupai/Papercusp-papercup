---
rel_path: "verification/WI-10006340/fire146-source-and-type-proof.json"
updated_at: 1791259617231
_body: "content"
---

{
  "files": [
    {
      "path": "libs/papercusp-shared/src/agent/chat-stream.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp-shared",
      "ownerHead": "7ab083b9eb3e5d1c8a1c20c8b84164d6795c80c3",
      "blob": "669cbdccef2b07508334a20951c22d55452d6b68",
      "headBlob": "669cbdccef2b07508334a20951c22d55452d6b68",
      "matchHead": true,
      "sha256": "09c327507bf524bb758e01cc68c706b69fdedb938176776ce05d76730a4850cd"
    },
    {
      "path": "libs/papercusp-shared/src/agent/chat-stream-transport.test.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp-shared",
      "ownerHead": "7ab083b9eb3e5d1c8a1c20c8b84164d6795c80c3",
      "blob": "5814645d464be607fb421399f72d2d0177b69c8e",
      "headBlob": "5814645d464be607fb421399f72d2d0177b69c8e",
      "matchHead": true,
      "sha256": "f5ebfebcfd20cc7c429b08900e657574ebf6ae5814e86776133b938025734cfe"
    },
    {
      "path": "packages/operator-core/lib/llm-testing/llm-client.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp",
      "ownerHead": "aca50d2d6c5f3a235ceb089db9895500f0e85688",
      "blob": "3fa0ecdb52acfd8abefc0713d717405e55751d5b",
      "headBlob": "3fa0ecdb52acfd8abefc0713d717405e55751d5b",
      "matchHead": true,
      "sha256": "ede6b5397359d875efd33df49485c96f63ae6e997c4e3299ec1ead8d5d07d604"
    },
    {
      "path": "packages/operator-core/lib/llm-testing/__tests__/llm-client-error.test.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp",
      "ownerHead": "aca50d2d6c5f3a235ceb089db9895500f0e85688",
      "blob": "cc8e8ee097bbf8d46d2855f8c8063dc8d83acca6",
      "headBlob": "cc8e8ee097bbf8d46d2855f8c8063dc8d83acca6",
      "matchHead": true,
      "sha256": "90cc3d4fad90b91b73a1fed3cf4f2c64f06ce8b1d5266c63344be8988c0d7d93"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/build/typecheck.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp",
      "ownerHead": "aca50d2d6c5f3a235ceb089db9895500f0e85688",
      "blob": "ec7ffa0c950230837b881e09b2060cce452e8ea5",
      "headBlob": "ec7ffa0c950230837b881e09b2060cce452e8ea5",
      "matchHead": true,
      "sha256": "976cdb0037c47871fd0ba1f1bd9e61b089c31f81b6eb06959eb1a60a34949130"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/build/typecheck.test.ts",
      "gitRoot": "/home/marsh-office/papercupai-workspace/papercusp",
      "ownerHead": "aca50d2d6c5f3a235ceb089db9895500f0e85688",
      "blob": "d873c6c56b8a5e825530a6cd4005009947d0bb91",
      "headBlob": "744f4e55cb857d7c59897b1c959039b3d26f7115",
      "matchHead": false,
      "sha256": "3f0c90b66b3aa60353108e5eb6faea3e416aa30733baa129c0326470ece0925a"
    }
  ],
  "libraryTypes": {
    "ok": true,
    "files": [
      "libs/papercusp-shared/src/agent/chat-stream.ts",
      "libs/papercusp-shared/src/agent/chat-stream-transport.test.ts"
    ],
    "checked": [
      "libs/papercusp-shared/src/agent/chat-stream.ts",
      "libs/papercusp-shared/src/agent/chat-stream-transport.test.ts"
    ],
    "missingFiles": [],
    "ownErrorCount": 0,
    "globalErrorCount": 0,
    "totalErrorCount": 0,
    "ownErrors": [],
    "globalErrors": [],
    "otherErrors": []
  },
  "typeDifferential": {
    "ok": true,
    "files": [
      "libs/papercusp-shared/src/agent/chat-stream.ts",
      "libs/papercusp-shared/src/agent/chat-stream-transport.test.ts"
    ],
    "parsedErrorCount": 0,
    "fixedErrorCount": 0,
    "oldRootsOnlyErrorCount": 1,
    "oldRootsOnlyMissingTypes": [
      {
        "code": 2688,
        "message": "Cannot find type definition file for 'vitest/globals'.   The file is in the program because:     Entry point of type library 'vitest/globals' specified in compilerOptions"
      }
    ],
    "configFilePath": "/tmp/pc-typecheck-scoped-PgKTq1/tsconfig.json"
  },
  "tests": {
    "anthropic": {
      "ids": [
        20818905,
        20818908,
        20818907
      ],
      "passed": 98,
      "failed": 0,
      "skipped": 0,
      "log": "/tmp/fire146-anthropic-bounds-final.log"
    },
    "compiler": {
      "ids": [
        20822901
      ],
      "passed": 98,
      "failed": 0,
      "skipped": 0,
      "log": "/tmp/fire146-package-types-final2.log"
    }
  },
  "limits": "Bounded source proof; no provider monetary authorization/invoice enforcement, full native acceptance or final shipment claim."
}

