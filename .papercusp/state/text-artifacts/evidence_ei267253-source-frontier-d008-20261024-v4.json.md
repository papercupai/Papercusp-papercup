---
rel_path: "evidence/ei267253-source-frontier-d008-20261024-v4.json"
updated_at: 1792873102205
_body: "content"
---

{
  "schemaVersion": "ei267253-d008-static-partial-archive-v1",
  "owningWorkItem": "EI-26725363534104440",
  "authority": "dream-loaded-control-observations-2026-10-17#D-008",
  "rawResultPath": ".papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.json",
  "rawResultText": "{\n  \"schemaVersion\": \"source-frontier-d008-v4-partial\",\n  \"at\": \"2026-10-24T20:10:52.651Z\",\n  \"owningWorkItem\": \"EI-26725363534104440\",\n  \"authority\": \"dream-loaded-control-observations-2026-10-17#D-008\",\n  \"status\": \"STOPPED-first-unresolved-edge\",\n  \"partial\": true,\n  \"fullClosureQualified\": false,\n  \"receipt\": false,\n  \"predecessor\": {\n    \"rawResult\": \".papercusp/scratch/ei267253-source-site-preparation-d007-20261024-v3.json\",\n    \"sha256\": \"44ac2b8e8aa1357bbafb71b0cc5847ef21ec73182d9d80ecdc1c23c0955187fb\",\n    \"archive\": \"evidence/ei267253-source-site-d007-initial-20261024-v1.json\",\n    \"archiveSha256\": \"e0f8e08f449f5e655ea57fd8313451f4976e344ac947a445d6e1004f90338eec\"\n  },\n  \"traversalOrder\": \"Bind persisted caller option sites and actual host adapter first; then continue persisted seeded-edge FIFO/AST import order. Stop at the first external/unresolved edge in seed0; no root rescan or seed trimming.\",\n  \"headBefore\": \"e5999201f342256057e67060bc2f4a0057d5779b\",\n  \"headAfter\": \"e5999201f342256057e67060bc2f4a0057d5779b\",\n  \"nestedPinAtHead\": \"160000 commit 0a46053bebf83dfb88f5afef2bd51d30d5a7ef07\\tlibs/papercusp\",\n  \"pins\": [\n    {\n      \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n      \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n      \"committedSha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n      \"blob\": \"7a33f4a484253aa948f290fda75582686362f3f8\",\n      \"workingEqualsCommitted\": true,\n      \"stableDuringRead\": true\n    },\n    {\n      \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n      \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n      \"committedSha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n      \"blob\": \"6c93d585c76dab0cd3302cf2b95fb91500daeb2b\",\n      \"workingEqualsCommitted\": true,\n      \"stableDuringRead\": true\n    },\n    {\n      \"path\": \"packages/operator-core/lib/endpoint-route/cors.ts\",\n      \"sha256\": \"a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34\",\n      \"committedSha256\": \"a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34\",\n      \"blob\": \"5be64ff949e5b92551cf5bd1e77285464c79b835\",\n      \"workingEqualsCommitted\": true,\n      \"stableDuringRead\": true\n    }\n  ],\n  \"callerBindings\": [\n    {\n      \"savedFingerprint\": \"4bdfacb8932b8f04c82dc6d35e8a2ded1e422631e7996571977ac1813270dbca\",\n      \"call\": {\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"start\": 614492,\n        \"end\": 615659,\n        \"byteStart\": 616511,\n        \"byteEnd\": 617678,\n        \"line\": 13359,\n        \"column\": 32,\n        \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n        \"sourceSha256\": \"efbbb4b694ead53e05036c556a87f0ec0bf01f5e952f6331dc9b18ab213cc917\",\n        \"source\": \"ensureCodexHomeViaOperator(\\n            ownerId,\\n            env.CODEX_HOME || null,\\n            env.PAPERCUSP_ADV_SESSION_ID || null,\\n            {\\n              model: detectRespawnModelSpec(args, {\\n                ownerId,\\n                agent: env.PAPERCUSP_AGENT,\\n                configDir: env.CLAUDE_CONFIG_DIR || null,\\n                codexHome: env.CODEX_HOME || null,\\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\\n                includeInherited: true,\\n                notBeforeMs: modelObservationNotBeforeMs,\\n              }),\\n              routeMode: options.routeMode ?? env[ACCOUNT_ROUTING_MODE_E\",\n        \"sourceTruncated\": true\n      },\n      \"conditions\": [\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 609942,\n          \"end\": 609959,\n          \"byteStart\": 611953,\n          \"byteEnd\": 611970,\n          \"line\": 13274,\n          \"column\": 7,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"6bd8a7c080c21df33ce02551b781aee11d4b1af9598c1b4dfd74061af69b9925\",\n          \"source\": \"managedPtyEnabled\",\n          \"sourceTruncated\": false,\n          \"side\": \"then\"\n        }\n      ],\n      \"optionProperties\": [\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 614655,\n          \"end\": 615118,\n          \"byteStart\": 616674,\n          \"byteEnd\": 617137,\n          \"line\": 13364,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"2c653a432f9b60dd5a0d66595abcb43e472ece6d096eacca4440f3328bda2f9d\",\n          \"source\": \"model: detectRespawnModelSpec(args, {\\n                ownerId,\\n                agent: env.PAPERCUSP_AGENT,\\n                configDir: env.CLAUDE_CONFIG_DIR || null,\\n                codexHome: env.CODEX_HOME || null,\\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\\n                includeInherited: true,\\n                notBeforeMs: modelObservationNotBeforeMs,\\n              })\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"model\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615134,\n          \"end\": 615203,\n          \"byteStart\": 617153,\n          \"byteEnd\": 617222,\n          \"line\": 13374,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"4b4a83981de56d43ce2a86a4b95ef9b999550020ccb1d942297cbf8088ba5a04\",\n          \"source\": \"routeMode: options.routeMode ?? env[ACCOUNT_ROUTING_MODE_ENV] ?? null\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"routeMode\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615219,\n          \"end\": 615300,\n          \"byteStart\": 617238,\n          \"byteEnd\": 617319,\n          \"line\": 13375,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"4dc3d13762ff31107688d5d4ffbb7f9f8a76ee911c1ce992d0d3888e27bc080c\",\n          \"source\": \"accountId: options.routeMode === 'auto' ? null : env.PAPERCUSP_ACCOUNT_ID || null\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"accountId\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615316,\n          \"end\": 615358,\n          \"byteStart\": 617335,\n          \"byteEnd\": 617377,\n          \"line\": 13376,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"3807ee71177ca26a3e09fe1a836e75a4933ec3bbde1c302556b606b2723f06cd\",\n          \"source\": \"priority: env.PAPERCUSP_AGENT_ROLE || \\\"su\\\"\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"priority\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615374,\n          \"end\": 615418,\n          \"byteStart\": 617393,\n          \"byteEnd\": 617437,\n          \"line\": 13377,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"66f08f9dc935bed21dbe6acaddccab6f637cb3fa3b551776eddc862c6f2231ad\",\n          \"source\": \"headless: env.PAPERCUSP_PSU_HEADLESS === \\\"1\\\"\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"headless\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615434,\n          \"end\": 615468,\n          \"byteStart\": 617453,\n          \"byteEnd\": 617487,\n          \"line\": 13378,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"c00454462b7efcb9c18087471fefa2bcc981269a0c712720aa29602bd7d06040\",\n          \"source\": \"sourcePolicy: options.sourcePolicy\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"sourcePolicy\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615484,\n          \"end\": 615552,\n          \"byteStart\": 617503,\n          \"byteEnd\": 617571,\n          \"line\": 13379,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"835a052f73200c1d279e02874b3b4a07fa531054b26e77d095e178a1bd3a4cc0\",\n          \"source\": \"expectedSpecificationRevision: options.expectedSpecificationRevision\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"expectedSpecificationRevision\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615568,\n          \"end\": 615571,\n          \"byteStart\": 617587,\n          \"byteEnd\": 617590,\n          \"line\": 13380,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"b77349bf1fa9b26d45d545d7d64dad96737e9cfbb3cbb5f5d10fb77b0fcc44ad\",\n          \"source\": \"env\",\n          \"sourceTruncated\": false,\n          \"kind\": \"ShorthandPropertyAssignment\",\n          \"name\": \"env\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 615587,\n          \"end\": 615631,\n          \"byteStart\": 617606,\n          \"byteEnd\": 617650,\n          \"line\": 13381,\n          \"column\": 15,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"bdfa0d980d9c98a1567e8c28d52ec023fdc3ee01fa2fe0b258439c4a76c06924\",\n          \"source\": \"onFailure: (detail) => { failure = detail; }\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"onFailure\"\n        }\n      ],\n      \"callback\": {\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"start\": 614388,\n        \"end\": 615721,\n        \"byteStart\": 616407,\n        \"byteEnd\": 617740,\n        \"line\": 13357,\n        \"column\": 9,\n        \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n        \"sourceSha256\": \"e741fd29f9036bb209fceba1289fe75b73f281168e1bf6eebc9905ad35495b3a\",\n        \"source\": \"ensureCodexHome: async (options = {}) => {\\n          let failure = null;\\n          const result = await ensureCodexHomeViaOperator(\\n            ownerId,\\n            env.CODEX_HOME || null,\\n            env.PAPERCUSP_ADV_SESSION_ID || null,\\n            {\\n              model: detectRespawnModelSpec(args, {\\n                ownerId,\\n                agent: env.PAPERCUSP_AGENT,\\n                configDir: env.CLAUDE_CONFIG_DIR || null,\\n                codexHome: env.CODEX_HOME || null,\\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\\n                includeInherited: true,\\n                notBeforeMs: modelObservatio\",\n        \"sourceTruncated\": true\n      },\n      \"hostAdapter\": {\n        \"call\": {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 610194,\n          \"end\": 620801,\n          \"byteStart\": 612205,\n          \"byteEnd\": 622836,\n          \"line\": 13279,\n          \"column\": 7,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"60ad415ae102b61437d4439b38958e69be286d2ea54e0115ab5d8f445b8b7af7\",\n          \"source\": \"hostThroughPty({\\n        command: wrapperBin,\\n        args,\\n        cwd,\\n        env,\\n        ownerId,\\n        identityAssume: makeIdentityAssumeHostPort({ ownerId, inspect: inspectIdentityAssume,\\n          writeHandoff: writeHostHandoff, reexecCode: reexecExitCodeFrom(env),\\n          attachmentId: identityAssumeAttachmentId, hostId: identityAssumeHostId,\\n          headless: env.PAPERCUSP_PSU_HEADLESS === '1' }),\\n        spawnPty: createScopedNativeSandboxSpawn({ env, cwd }),\\n        // headless-fleet-launch P-001/D-004: never bridge a human TTY for a headless\\n        // member. It resolves false anyway when stdio is detached (stdin.isTTY undefined),\\n        // but pinning it makes `psu --he\",\n          \"sourceTruncated\": true\n        },\n        \"callbackProperty\": \"ensureCodexHome\"\n      },\n      \"classification\": \"managed-host callback forwards options.sourcePolicy and options.expectedSpecificationRevision\"\n    },\n    {\n      \"savedFingerprint\": \"eda59677f688bfaec7463e33bfa03ee85651c1a6facad5b56f647eabcec1d0b8\",\n      \"call\": {\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"start\": 685237,\n        \"end\": 685551,\n        \"byteStart\": 687450,\n        \"byteEnd\": 687764,\n        \"line\": 14848,\n        \"column\": 13,\n        \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n        \"sourceSha256\": \"cb45762fc9e2f41598b7537b14ef61a56d367adcf56e65a2e385d7d15866d314\",\n        \"source\": \"ensureCodexHomeViaOperator(\\n        session.coordOwnerId ?? null,\\n        env.CODEX_HOME,\\n        session.id ?? null,\\n        {\\n          requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID,\\n          model: resumeModel || lastActiveModelFor(session) || null,\\n          headless,\\n        },\\n      )\",\n        \"sourceTruncated\": false\n      },\n      \"conditions\": [\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 684955,\n          \"end\": 684970,\n          \"byteStart\": 687168,\n          \"byteEnd\": 687183,\n          \"line\": 14843,\n          \"column\": 11,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"384351a1c1e53f0b56a30980a3cbf1bb245d01c3f68c8310c8432f633aa8f30f\",\n          \"source\": \"originalRouting\",\n          \"sourceTruncated\": false,\n          \"side\": \"else\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 683102,\n          \"end\": 683145,\n          \"byteStart\": 685307,\n          \"byteEnd\": 685350,\n          \"line\": 14811,\n          \"column\": 9,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"b81c50a45643e3ca044c811fd8ffd7ccf63c0e1a4531a07e39c5c507f76d479b\",\n          \"source\": \"session.agent === \\\"codex\\\" && env.CODEX_HOME\",\n          \"sourceTruncated\": false,\n          \"side\": \"then\"\n        }\n      ],\n      \"optionProperties\": [\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 685375,\n          \"end\": 685442,\n          \"byteStart\": 687588,\n          \"byteEnd\": 687655,\n          \"line\": 14853,\n          \"column\": 11,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"457f352b0787b7c4d6489bf88b0c2858529599b4375b4d27a3a6db43ded77284\",\n          \"source\": \"requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"requireGatewayProvider\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 685454,\n          \"end\": 685511,\n          \"byteStart\": 687667,\n          \"byteEnd\": 687724,\n          \"line\": 14854,\n          \"column\": 11,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"6390f775d208aa0d22e2107874aec9efdc1d2f1cb0cc9aff7ff2ac78749faa6c\",\n          \"source\": \"model: resumeModel || lastActiveModelFor(session) || null\",\n          \"sourceTruncated\": false,\n          \"kind\": \"PropertyAssignment\",\n          \"name\": \"model\"\n        },\n        {\n          \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n          \"start\": 685523,\n          \"end\": 685531,\n          \"byteStart\": 687736,\n          \"byteEnd\": 687744,\n          \"line\": 14855,\n          \"column\": 11,\n          \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n          \"sourceSha256\": \"e893d4b34355115bc35a49efa029f8859db7adc3a316633dd3f8e84f336e0111\",\n          \"source\": \"headless\",\n          \"sourceTruncated\": false,\n          \"kind\": \"ShorthandPropertyAssignment\",\n          \"name\": \"headless\"\n        }\n      ],\n      \"callback\": null,\n      \"hostAdapter\": null,\n      \"classification\": \"launchResume object literal supplies no preservation fields; callee sourcePolicy default is null\"\n    }\n  ],\n  \"calleeDefaults\": [\n    {\n      \"name\": \"sourcePolicy\",\n      \"default\": \"null\",\n      \"evidence\": {\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"start\": 785976,\n        \"end\": 785995,\n        \"byteStart\": 788535,\n        \"byteEnd\": 788554,\n        \"line\": 17031,\n        \"column\": 5,\n        \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n        \"sourceSha256\": \"94a0eb46e8b7b623f3c21558c76c5a5fd65859da1920b258236cf8e3338ed29e\",\n        \"source\": \"sourcePolicy = null\",\n        \"sourceTruncated\": false\n      }\n    },\n    {\n      \"name\": \"expectedSpecificationRevision\",\n      \"default\": \"null\",\n      \"evidence\": {\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"start\": 786001,\n        \"end\": 786037,\n        \"byteStart\": 788560,\n        \"byteEnd\": 788596,\n        \"line\": 17032,\n        \"column\": 5,\n        \"sha256\": \"d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b\",\n        \"sourceSha256\": \"9dfb7b45087c2c69cc44bbeff0df68ceebb9601d95457ab94bda56ea1bec93fb\",\n        \"source\": \"expectedSpecificationRevision = null\",\n        \"sourceTruncated\": false\n      }\n    }\n  ],\n  \"hostCallback\": {\n    \"declaration\": {\n      \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n      \"start\": 527743,\n      \"end\": 527777,\n      \"byteStart\": 528956,\n      \"byteEnd\": 528990,\n      \"line\": 11127,\n      \"column\": 5,\n      \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n      \"sourceSha256\": \"66f94fce06d7ef4bd6a61513dd4cad2532a48ddbbf300ea4ad78e071d81aac7d\",\n      \"source\": \"ensureCodexHome = async () => null\",\n      \"sourceTruncated\": false\n    },\n    \"constLocalBinding\": true,\n    \"invocations\": [\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 845792,\n        \"end\": 845830,\n        \"byteStart\": 847443,\n        \"byteEnd\": 847481,\n        \"line\": 17325,\n        \"column\": 34,\n        \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n        \"sourceSha256\": \"cc35847b3b50e0a0999f56dde43c4d03c60042f71c64a06c54ace7ab1d12b553\",\n        \"source\": \"ensureCodexHome({ routeMode: 'auto' })\",\n        \"sourceTruncated\": false,\n        \"conditions\": [\n          {\n            \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n            \"start\": 845623,\n            \"end\": 845705,\n            \"byteStart\": 847274,\n            \"byteEnd\": 847356,\n            \"line\": 17322,\n            \"column\": 11,\n            \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n            \"sourceSha256\": \"f5ae417e6b9afbda66d01350fee3bd22f73b5c464c79a4a7772c36c49cb0b550\",\n            \"source\": \"quotaRecovery && quotaRecovery.cause !== 'auth' && env.PAPERCUSP_AGENT === 'codex'\",\n            \"sourceTruncated\": false,\n            \"side\": \"then\"\n          }\n        ],\n        \"ownOptionProperties\": [\n          {\n            \"kind\": \"PropertyAssignment\",\n            \"name\": \"routeMode\",\n            \"source\": \"routeMode: 'auto'\"\n          }\n        ],\n        \"hasExplicitPreservationPolicy\": false,\n        \"hasExplicitExpectedRevision\": false,\n        \"sourcePolicyFlow\": \"No own literal policy field in this lexical invocation; forwarded absent value selects the null parameter default under ordinary object semantics. Runtime prototype/reflective effects not proved.\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 851308,\n        \"end\": 851325,\n        \"byteStart\": 852963,\n        \"byteEnd\": 852980,\n        \"line\": 17434,\n        \"column\": 36,\n        \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n        \"sourceSha256\": \"b975c0884bef8f8be448891c7c92d686c44a649a1d5c0fc95d84035af2d7bfbd\",\n        \"source\": \"ensureCodexHome()\",\n        \"sourceTruncated\": false,\n        \"conditions\": [\n          {\n            \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n            \"start\": 851104,\n            \"end\": 851204,\n            \"byteStart\": 852759,\n            \"byteEnd\": 852859,\n            \"line\": 17429,\n            \"column\": 11,\n            \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n            \"sourceSha256\": \"059145bf07a0d377e917a8eb76adbe9113b6043a7bde1cb415a47e4923468021\",\n            \"source\": \"systemPromptAddendum &&\\n          String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex'\",\n            \"sourceTruncated\": false,\n            \"side\": \"then\"\n          }\n        ],\n        \"ownOptionProperties\": [],\n        \"hasExplicitPreservationPolicy\": false,\n        \"hasExplicitExpectedRevision\": false,\n        \"sourcePolicyFlow\": \"No own literal policy field in this lexical invocation; forwarded absent value selects the null parameter default under ordinary object semantics. Runtime prototype/reflective effects not proved.\"\n      }\n    ],\n    \"otherSyntaxReferences\": [],\n    \"initializer\": {\n      \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n      \"start\": 527761,\n      \"end\": 527777,\n      \"byteStart\": 528974,\n      \"byteEnd\": 528990,\n      \"line\": 11127,\n      \"column\": 23,\n      \"sha256\": \"bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e\",\n      \"sourceSha256\": \"0f1026f2789b76e07775369f037a9487f395a376420f62deabdca4a9a030da32\",\n      \"source\": \"async () => null\",\n      \"sourceTruncated\": false\n    },\n    \"initializationPending\": [\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 0,\n        \"end\": 80,\n        \"byteStart\": 0,\n        \"byteEnd\": 80,\n        \"line\": 1,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"@papercusp/host-platform/home\",\n        \"source\": \"import { papercuspPath, papercuspPtyPath } from '@papercusp/host-platform/home';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"d0474db483323acbdac9b6db1deff751f9e53e93ec761764b9c7db155966809a\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"19dd00fd39bb2a360ab7a84c3cb90dbe3851f9156f09573185de0a4faa46023d\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2530,\n        \"end\": 2574,\n        \"byteStart\": 2540,\n        \"byteEnd\": 2584,\n        \"line\": 42,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:module\",\n        \"source\": \"import { createRequire } from 'node:module';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"d36c2fe7b71bbb58931d680a02545c0039b3859e20be60775ac7f6ad6feba172\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"913a57dbbfc8be28932075d6a2d4a702d8cac0ea6d4a8f5130674166f7b21c2a\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2575,\n        \"end\": 2629,\n        \"byteStart\": 2585,\n        \"byteEnd\": 2639,\n        \"line\": 43,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:crypto\",\n        \"source\": \"import { createHash, randomBytes } from 'node:crypto';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"608583c43b94f4329bd1492b34ef3a98c8762b0c66ad3c02a3ef69c7d60e74cd\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"03db4c242ef9481eb86c842592810228259d111d125cfbc4bd67cdf00fb3aae5\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2630,\n        \"end\": 2690,\n        \"byteStart\": 2640,\n        \"byteEnd\": 2700,\n        \"line\": 44,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:os\",\n        \"source\": \"import { constants as osConstants, homedir } from 'node:os';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"267d40ecc39bc1d7d3c7eb38d0c461b4c1d9a8eb5510224eac682162c4a206f6\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"d3780e361bc91cc54c709610a89dad5c2f7223f0ba71b6b67b09a8974a370ff8\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2691,\n        \"end\": 2774,\n        \"byteStart\": 2701,\n        \"byteEnd\": 2784,\n        \"line\": 45,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:path\",\n        \"source\": \"import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"596ce2ae8aa9ad136a251766dfb1cb36953687872b690d4a6452d0358c90ffde\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"89f058c7450d3076ee00487a43f110c5b9bfb953c840ad3113f3aa57c51a9b66\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2775,\n        \"end\": 2816,\n        \"byteStart\": 2785,\n        \"byteEnd\": 2826,\n        \"line\": 46,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:url\",\n        \"source\": \"import { fileURLToPath } from 'node:url';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"9bdc8db677e168091af592f6ff057a4fd2bc1e373d4739278aedbac085952e79\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"c911664f1383262f472f293bf37442ecc966e75f7783f63641e87892a5d649c8\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 2817,\n        \"end\": 2860,\n        \"byteStart\": 2827,\n        \"byteEnd\": 2870,\n        \"line\": 47,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:child_process\",\n        \"source\": \"import { spawn } from 'node:child_process';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"5dc268da2fb7715f7ad3af027cf4990a59ac1976db317d49fa8f38a99d312ec6\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"ac53079c057b392682a02aa85a8a87720531c97cbf92c65c12631b2343b94c01\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3009,\n        \"end\": 3164,\n        \"byteStart\": 3019,\n        \"byteEnd\": 3174,\n        \"line\": 50,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"../../../libs/papercusp-shared/src/agent/model-capacity.mjs\",\n        \"source\": \"import { makeModelCapacityDetector, modelCapacityLineMatch, modelCapacityRetryAfterMs } from '../../../libs/papercusp-shared/src/agent/model-capacity.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"d4006f11ed6327d8295c0679bce14336f8ff46c592ed029446fcc148f02c3349\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"a877d88abe05bf15f373fae25f42f5e7da12de8ccf3de4e98dd02952808e8577\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3165,\n        \"end\": 3271,\n        \"byteStart\": 3175,\n        \"byteEnd\": 3281,\n        \"line\": 51,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"../../../packages/operator-core/lib/psu-launch-log.mjs\",\n        \"source\": \"import { isCodexWorkspaceDiscoveryTimeout } from '../../../packages/operator-core/lib/psu-launch-log.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"958c9cef91893413db3521f310d7e64fc95bf7a821a85722d24dfc6311c7e257\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"ea537842397b06f93943c7e5d854b0a2b37f9a4f6e482d0da10aa1513f128028\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3272,\n        \"end\": 3376,\n        \"byteStart\": 3282,\n        \"byteEnd\": 3386,\n        \"line\": 52,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"../../../packages/operator-core/lib/control-plane-temp.mjs\",\n        \"source\": \"import { controlPlaneTempCandidates } from '../../../packages/operator-core/lib/control-plane-temp.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"e0784d8ce4baa723d498b7433e1457e56d75baac79153e903cbe862a66ea1f22\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"d78734f80a6b194d9f377e302d6a869a4244b985ced065a248adaf8869375863\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3377,\n        \"end\": 3514,\n        \"byteStart\": 3387,\n        \"byteEnd\": 3524,\n        \"line\": 53,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs\",\n        \"source\": \"import {\\n  AGENT_IDENTITY_SPEC_ENV,\\n  stageAgentIdentityTty,\\n} from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"b0d72de183a3f4407ae22355693528eb94c5e5008ee50b3736d2699e3638cfd8\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"1949162a09a20bb5eedf836169dc9229ac5a5a9d2c19966371cfdff556e10f5b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3515,\n        \"end\": 3847,\n        \"byteStart\": 3525,\n        \"byteEnd\": 3857,\n        \"line\": 57,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:fs\",\n        \"source\": \"import {\\n  mkdirSync,\\n  readdirSync,\\n  writeFileSync,\\n  unlinkSync,\\n  existsSync,\\n  readFileSync,\\n  readlinkSync,\\n  realpathSync,\\n  chmodSync,\\n  renameSync,\\n  appendFileSync,\\n  closeSync,\\n  fsyncSync,\\n  constants,\\n  fstatSync,\\n  lstatSync,\\n  openSync,\\n  readSync,\\n  statSync,\\n  writeSync,\\n  promises as fsPromises,\\n} from 'node:fs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"f6a2d7817cbd9af44b015173f7b403a6956be8e6566464d419389fc35bdabb9f\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"d4f0ddf5705d80e61ddb381a12a808b256eb2167f0cfbdad401eaa5527cda2e8\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3848,\n        \"end\": 3875,\n        \"byteStart\": 3858,\n        \"byteEnd\": 3885,\n        \"line\": 80,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"node:net\",\n        \"source\": \"import net from 'node:net';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"e06fe82ba81af34c4f52debb36bebd01f78aee00a7926a01dcad61f65ff10a7c\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"2528037a3b803969f234c5d47aa781898b6ab75743c15ce510f1a37f1601da78\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3876,\n        \"end\": 3941,\n        \"byteStart\": 3886,\n        \"byteEnd\": 3951,\n        \"line\": 81,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"./psu-terminal-output.mjs\",\n        \"source\": \"import { createTerminalOutput } from './psu-terminal-output.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"29e1bb5bc63d92591e50efa5aa78462f8fb4bf3f15f7ea961c817bf3cd81a8f9\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"7c633f7080f3467946f73ef6022aef67543d6cf653a09dd1bd9d1cfc64ee928b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 3942,\n        \"end\": 4006,\n        \"byteStart\": 3952,\n        \"byteEnd\": 4016,\n        \"line\": 82,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"./psu-carry-fence.mjs\",\n        \"source\": \"import { createPendingCarryFence } from './psu-carry-fence.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"4a6943e74a51c7a464a19649fa8058fd576e1082bb16177e647a87dc053ce119\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"3d9b0a2f19b76f88f6def79124b770c95195f3d593dd226566e1ad6f9472bb8f\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 4007,\n        \"end\": 4091,\n        \"byteStart\": 4017,\n        \"byteEnd\": 4101,\n        \"line\": 83,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"./hooks/cc/dialog-answer-provenance.mjs\",\n        \"source\": \"import { observeClaudeDialogWrites } from './hooks/cc/dialog-answer-provenance.mjs';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"f61862c1f747e2d94113e7681a698306cf3eac857cbf06c72e7c9bd36aa3953f\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"5dbccb9e3090b8d7f92edb4058877233c229841a2b7d3f17918976d72bdcd71b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 6219,\n        \"end\": 6249,\n        \"byteStart\": 6229,\n        \"byteEnd\": 6259,\n        \"line\": 154,\n        \"column\": 17,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"createRequire\",\n        \"specifier\": null,\n        \"source\": \"createRequire(import.meta.url)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279\",\n        \"binding\": {\n          \"imported\": \"createRequire\",\n          \"specifiers\": [\n            \"node:module\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"4506161869017b711ca726ab9062e3926fac759a584ad0e460e825635a24fb53\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 9585,\n        \"end\": 9624,\n        \"byteStart\": 9597,\n        \"byteEnd\": 9636,\n        \"line\": 227,\n        \"column\": 25,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"dirname\",\n        \"specifier\": null,\n        \"source\": \"dirname(fileURLToPath(import.meta.url))\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"49f5ae82dfe7e7d163184c1d4a32d475985c03c0b1e6ea84925bab2e7918d24f\",\n        \"binding\": {\n          \"imported\": \"dirname\",\n          \"specifiers\": [\n            \"node:path\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"fb7a7a3f69caae67819e30e84b8aacec36951aabd51fe707dc090503411d5b26\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 9593,\n        \"end\": 9623,\n        \"byteStart\": 9605,\n        \"byteEnd\": 9635,\n        \"line\": 227,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"fileURLToPath\",\n        \"specifier\": null,\n        \"source\": \"fileURLToPath(import.meta.url)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"d98aa4feb44288f202d80105fd166f09dbc10048a636f0ef2750fa106c833deb\",\n        \"binding\": {\n          \"imported\": \"fileURLToPath\",\n          \"specifiers\": [\n            \"node:url\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 9814,\n        \"end\": 9844,\n        \"byteStart\": 9828,\n        \"byteEnd\": 9858,\n        \"line\": 231,\n        \"column\": 26,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"fileURLToPath\",\n        \"specifier\": null,\n        \"source\": \"fileURLToPath(import.meta.url)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"b37f440cbba45b3cb1d52b1cf796dc559964934d55c36f96df6f05b74644384d\",\n        \"binding\": {\n          \"imported\": \"fileURLToPath\",\n          \"specifiers\": [\n            \"node:url\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 9875,\n        \"end\": 9916,\n        \"byteStart\": 9889,\n        \"byteEnd\": 9930,\n        \"line\": 232,\n        \"column\": 30,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"join\",\n        \"specifier\": null,\n        \"source\": \"join(HOST_SCRIPT_DIR, 'psu-launcher.mjs')\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"ea655464bca0b3dc4f05d84e8352465950ad3c65abff61f72964d9f5f947e09a\",\n        \"binding\": {\n          \"imported\": \"join\",\n          \"specifiers\": [\n            \"node:path\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"c180d3bb2a5b1f0331a7926f0a3ee89cabaabbe581340c297a97ebd9835fe8d1\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 11266,\n        \"end\": 11282,\n        \"byteStart\": 11282,\n        \"byteEnd\": 11298,\n        \"line\": 256,\n        \"column\": 57,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"hashHostScript\",\n        \"specifier\": null,\n        \"source\": \"hashHostScript()\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"e3216c371c2d78f2b0b28a7194759475cb064f66b6ed54c733cc4f9c71a2df6b\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"39a841b3b50bbe5e3b16eb4ed28eef1807d80c94d74eca776831858629295b1b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 12449,\n        \"end\": 12485,\n        \"byteStart\": 12465,\n        \"byteEnd\": 12501,\n        \"line\": 290,\n        \"column\": 54,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"hashHostScript\",\n        \"specifier\": null,\n        \"source\": \"hashHostScript(LAUNCHER_SCRIPT_PATH)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"c1527e41eb3ccf6c6da56ae4acb410e7e96a4637dc0d4d1644b339e905661bd7\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"e673ac59720bc89ff0e48e6833465ebed1f524476edb86c43e6cea2daf238f3b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 23444,\n        \"end\": 23462,\n        \"byteStart\": 23514,\n        \"byteEnd\": 23532,\n        \"line\": 513,\n        \"column\": 28,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"papercuspPtyPath\",\n        \"specifier\": null,\n        \"source\": \"papercuspPtyPath()\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"9de16904d0a21f47415128820e31d8a67d08392e42da42e56366a4f68dba40c4\",\n        \"binding\": {\n          \"imported\": \"papercuspPtyPath\",\n          \"specifiers\": [\n            \"@papercusp/host-platform/home\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"d4caeb85d04e2fcbf28b9ea30ef2382c03c3776edd2e1df4697535deed4e2c5f\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 23710,\n        \"end\": 23755,\n        \"byteStart\": 23780,\n        \"byteEnd\": 23825,\n        \"line\": 518,\n        \"column\": 25,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"26a2777fe4b1fab9df85402b6839c9ede47b9f102497c4a58d4f959cfa580c7f\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"8248c07c696867d92279a291f464a080a176335f6c18b489bf5a8a2d05017487\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 23955,\n        \"end\": 24004,\n        \"byteStart\": 24027,\n        \"byteEnd\": 24076,\n        \"line\": 521,\n        \"column\": 34,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"43efb6aff01414dd0a831b6bfa5dee9e451e1cf4447f61bcc6c0a608f49c17a1\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"d50436000a1e8add8e45705862aa13cd1847bd73d6a9d2aaef6ae5e3b254a794\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 34142,\n        \"end\": 34194,\n        \"byteStart\": 34220,\n        \"byteEnd\": 34272,\n        \"line\": 744,\n        \"column\": 38,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze(['reset', 'recycle', 'carry-respawn'])\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"3acf6f6a4cc7eb66c57cb14d1c5eb07bd507eedd6f7d17698ebbacef07709300\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"b13528a6ea22ec53da3fe5445739f1bd8ee8fd90057a373abba918ce49c24160\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 64352,\n        \"end\": 64448,\n        \"byteStart\": 64486,\n        \"byteEnd\": 64582,\n        \"line\": 1349,\n        \"column\": 34,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze({\\n  codex: 'CODEX_HOME',\\n  claude: 'CLAUDE_CONFIG_DIR',\\n  omp: 'PI_CONFIG_DIR',\\n})\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"3f8dabf1a87dedcc2671999eda849b7501155f99ed68ecd906e59eaf5324fba7\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"2ed001fcc88d3437ffb119d48733b65ec099e3b7ad6b34bebd9f124ac30ac86a\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 70685,\n        \"end\": 70812,\n        \"byteStart\": 70847,\n        \"byteEnd\": 70974,\n        \"line\": 1473,\n        \"column\": 37,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze({\\n  codex: classifyCodexTranscriptRow,\\n  claude: classifyClaudeTranscriptRow,\\n  omp: classifyOmpTranscriptRow,\\n})\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"c78b2031d925fcb11e7cdde72a8eff0f7e5db9993d3f41e5d8d9bf369fad8cc0\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"125d1698c62b07c5867f71f4cf6be5950ec3ea7a51c846555fd060d102b14a21\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 94291,\n        \"end\": 94357,\n        \"byteStart\": 94457,\n        \"byteEnd\": 94523,\n        \"line\": 1971,\n        \"column\": 38,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Set\",\n        \"specifier\": null,\n        \"source\": \"new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input'])\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"90fe0c3610e6983e4b8de05259a8acacbdcd4259c22cd879e607f110a42d5398\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"107f363ff1f4116ee758c421047ebc3b9a744dbbb5f7c814ebfa9fa1ac1ad86f\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 118355,\n        \"end\": 118413,\n        \"byteStart\": 118533,\n        \"byteEnd\": 118591,\n        \"line\": 2512,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"0f0d7532253457319176e2af38cb2db33c18c974a6da8afbbe3f7026440db98f\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"8ef6225ebbe90f273bdc6a2d8ff0ae14dc9462a77f6b417d6049b557dc7a16f1\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 118457,\n        \"end\": 118746,\n        \"byteStart\": 118635,\n        \"byteEnd\": 118924,\n        \"line\": 2513,\n        \"column\": 34,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"(() => {\\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\\n  // silently removes the kill switch for a path every fleet launch runs.\\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\\n})\",\n        \"specifier\": null,\n        \"source\": \"(() => {\\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\\n  // silently removes the kill switch for a path every fleet launch runs.\\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\\n})()\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"bb25aae57d7cbc33a3c47ba5fe37f399be2ce470e11aca45e5823cd95a907ae4\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"92c8a6fbf417e969821a0f3d63b9b31d020a9795dbb2776c282215f2b8f6d6e2\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 129655,\n        \"end\": 129705,\n        \"byteStart\": 129835,\n        \"byteEnd\": 129885,\n        \"line\": 2734,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"fb3a93173bd65f71036a2844e8e2967d3601c9a056046585683ff45b06049894\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"9ffc92a5fde1b1d57af4b74b5169a6159e3cba9f01fa89a9c61de15239fe3713\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 129961,\n        \"end\": 130017,\n        \"byteStart\": 130141,\n        \"byteEnd\": 130197,\n        \"line\": 2739,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"f260e2fbe07b62a3a1c59aaaea6821964e3165e2e1c0f9f04628fb0dbfd1a54d\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"d053a577b8efd0a1f1b0879a27cecce8d823f3f34dc0e013e082ecff285af98c\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 130314,\n        \"end\": 130372,\n        \"byteStart\": 130494,\n        \"byteEnd\": 130552,\n        \"line\": 2744,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"427a8bba0d3606af95233850b7f6ff812fc5e107d87fef9335a86b9b946f4ace\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"cfd1ac1fe4938acd1f8a515784970c967ba7575a7b4b296cf8e3ea5f582da35d\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 131959,\n        \"end\": 132018,\n        \"byteStart\": 132145,\n        \"byteEnd\": 132204,\n        \"line\": 2766,\n        \"column\": 31,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"ba5a68047ee00a15181db901783f1643085cfe4c5b0e3de396e8e2d4be211296\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"3e7d70b487bd2da3a0d541ced15b98b06b0b4697618a04bc2ddee17cc47c7e7f\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 132057,\n        \"end\": 132114,\n        \"byteStart\": 132243,\n        \"byteEnd\": 132300,\n        \"line\": 2767,\n        \"column\": 29,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"5bcab15bc5149095f57c653cefa942ba99c59baecea0a8cf34c1d06464f43d93\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"c50d8235807a5e70d6d0510775fad89a49045b3460fc7295ba63f861f40db55e\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 132157,\n        \"end\": 132215,\n        \"byteStart\": 132343,\n        \"byteEnd\": 132401,\n        \"line\": 2768,\n        \"column\": 37,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"e49dcb5e872b3107383d99f299e0bd27915f0e60b8f322c59370b170a1646dad\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"25e4b3664cecd46819d78ac02cbb4e12ad4d03e6156232cd6b7250dd3e03ceba\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 133532,\n        \"end\": 133592,\n        \"byteStart\": 133732,\n        \"byteEnd\": 133792,\n        \"line\": 2787,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"1f45147c08482ddd838c2032a79b73dd6b9e33175c6377faf1f803eb53525b58\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"8561a57b5000736198ae726a125b53cb77c246eaaedc9bcd5eda780a5a63dc3d\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 134830,\n        \"end\": 134883,\n        \"byteStart\": 135040,\n        \"byteEnd\": 135093,\n        \"line\": 2804,\n        \"column\": 25,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"7d2d7d9e3633e653e81d3cc545cbb8461516c820a4ef6e81c449603336ce275a\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"99679c143cebdfb67507eb5c48e064708548ca489282c34a5ac508ca956fb33b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 135418,\n        \"end\": 135467,\n        \"byteStart\": 135630,\n        \"byteEnd\": 135679,\n        \"line\": 2811,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"d347fc67f2f11ad791dbc12701f4759f1483b1dbaff7735f0da3e0939e72d51e\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"ed96d89affe0cc16d5424003eb4e8160ee97f9b83dfbea0ac70659af674930a5\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 135896,\n        \"end\": 135949,\n        \"byteStart\": 136108,\n        \"byteEnd\": 136161,\n        \"line\": 2818,\n        \"column\": 25,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"bc16d473c4f9600c96fde8c2e2158ea957271faa8312d029cba141d51568f34e\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"a64db47a96842a2bf85aa9a81822b33af0dcfb23ff9d75388d2fdb1a50fac9be\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 136224,\n        \"end\": 136277,\n        \"byteStart\": 136436,\n        \"byteEnd\": 136489,\n        \"line\": 2822,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"54994ced70401c28f3077e66c988ff80314a4244369d25fd7e23ac5d7f715f8d\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"5764406090c8d6293402e95a5ad794a0649c97bc939af18f79203269b4d3c581\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 136481,\n        \"end\": 136545,\n        \"byteStart\": 136693,\n        \"byteEnd\": 136757,\n        \"line\": 2825,\n        \"column\": 36,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"8161d3d4b87aba4b5686f5fa7a1e4196effaac3ec13699bdf9e1207b55f18191\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"4431e9d4da5ce4b72859c03a059c5d81572faa40b4267929ce586fb385876ba3\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 137026,\n        \"end\": 137089,\n        \"byteStart\": 137238,\n        \"byteEnd\": 137301,\n        \"line\": 2836,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"1e7bcdb4b3ed42bb00a74b548ed438249c62371195b72e818b4ff27732b35260\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"cab67ad7f4fb00fa69b8d6a741c47e22375fa70ab9b4cb5f01fd4ed6fb1ae5c3\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 137688,\n        \"end\": 137749,\n        \"byteStart\": 137902,\n        \"byteEnd\": 137963,\n        \"line\": 2846,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"dcee8c8d8d291f6d3003c09021a395a9069707eba71b61bdadf4ca9ea01ce3ba\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"03145cfa45e14e3eebffa7947b5cb22e61f5e89f7b3a0b0e481f9db917d2dced\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 138004,\n        \"end\": 138066,\n        \"byteStart\": 138218,\n        \"byteEnd\": 138280,\n        \"line\": 2851,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"5912b56d208fdf67ff42bc0f274652134e753a7d68b953a78d86f6043eb02f10\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"a8b2d3c391cac676f209461ebba518a01902ef5c9a3d6a7605b107773f85fac9\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 138769,\n        \"end\": 138837,\n        \"byteStart\": 138983,\n        \"byteEnd\": 139051,\n        \"line\": 2861,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"1174ff601b4d8d7cabb99836bb45e13d7311c4aa196e096a35988e82a57f636c\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"5a579e2e64c1a900a98c33e6a052a6b3afaa6215af7fa86fe22e8d6fe749fe7b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 139789,\n        \"end\": 139856,\n        \"byteStart\": 140003,\n        \"byteEnd\": 140070,\n        \"line\": 2874,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"0c6c27d321fd9e120ec123c85bcf485441dd55525fdb74ecc4bdb25aaf20f11f\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"7f2c517866a5e71da808ae5d0b65b4ff4be83b92b3b24c5aa88dedb19eb9ad44\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 149508,\n        \"end\": 149572,\n        \"byteStart\": 149722,\n        \"byteEnd\": 149786,\n        \"line\": 3073,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"5670fb14f737ef718fc6aa676e62e1747f3b2225c857d77d104e945a10404020\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"209672012fed3c6cb90b1fcae7869034949673b1a7024fc8e360baaca3e000f2\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 151414,\n        \"end\": 151472,\n        \"byteStart\": 151647,\n        \"byteEnd\": 151705,\n        \"line\": 3100,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_WARN_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"e163c320fcc72986f486671c3e9f37ab4d4c5998c6d85bb077fd3a919cd099e4\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"400bda92953bfbe5ca2b127964e3f924f11fd78ede12d14b6ec0864a4a7967fe\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 151534,\n        \"end\": 151601,\n        \"byteStart\": 151767,\n        \"byteEnd\": 151834,\n        \"line\": 3102,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_FORCE_RELEASE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"8b696109d460b5578602d3f1f9cfdb7e52ee79df58cebfc08e8582d49ff6bb50\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"83db1273610e8228b68110ee785f26d02de99f7c497676c6fb6cbfe5f268f507\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 153467,\n        \"end\": 153519,\n        \"byteStart\": 153710,\n        \"byteEnd\": 153762,\n        \"line\": 3128,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"76a5c1653f52c40859d8a5155ddbfee87eb883ac2d7447b2d484616a28404b33\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"7bbb55b3b7440a28766669126acf1db696db267e4034ac3928caab5888896770\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 154334,\n        \"end\": 154386,\n        \"byteStart\": 154579,\n        \"byteEnd\": 154631,\n        \"line\": 3140,\n        \"column\": 24,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"25af3f7def1f74dd36d40cb3415f5463e97b7663d97f5087f43f1a256a9f2fab\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"4ab2074641e57d95f97c55c8fd475705fc5ea8c2e1b8631d04d88cd76af243e1\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 167195,\n        \"end\": 167241,\n        \"byteStart\": 167448,\n        \"byteEnd\": 167494,\n        \"line\": 3448,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"RegExp\",\n        \"specifier\": null,\n        \"source\": \"new RegExp(`^--?${SNAPSHOT_SECRET_KEY}$`, 'i')\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"1d2385124b61e6a1417530eafab964ba76f13fec2ee6008f3e8eeae09aab4bd4\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"5d3c7668383f17ed8c039055f935a7368ffcdbae90ba4a78935481d284f877c7\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 167275,\n        \"end\": 167363,\n        \"byteStart\": 167528,\n        \"byteEnd\": 167616,\n        \"line\": 3449,\n        \"column\": 33,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"RegExp\",\n        \"specifier\": null,\n        \"source\": \"new RegExp(`(${SNAPSHOT_SECRET_KEY})(\\\\\\\\s*[=:]\\\\\\\\s*)(\\\"[^\\\"]*\\\"|'[^']*'|[^\\\\\\\\s,;&\\\"']+)`, 'gi')\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"02465aeaae579dddc3ce1e561359dce03332d49f8869a73cb75a5f617e8ca0ef\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"2b1f5ef3c9f14799e2d98112e819a3c455b94ee766724b06dd24f8f92d582b74\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 180374,\n        \"end\": 180482,\n        \"byteStart\": 180633,\n        \"byteEnd\": 180741,\n        \"line\": 3775,\n        \"column\": 30,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Set\",\n        \"specifier\": null,\n        \"source\": \"new Set([\\n  'carry-drill-carry-delivered',\\n  'carry-drill-carry-dropped',\\n  'carry-drill-respawn-failed',\\n])\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"520f37911aab05a22766290cd9cce355955a404faa4f79047ce6d88e4bca32df\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"5bf1dc941cc9d0b31c515aa40a782ee05d15e1754f589d3f9c321e7b6d3dac9c\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 189935,\n        \"end\": 192928,\n        \"byteStart\": 190216,\n        \"byteEnd\": 193217,\n        \"line\": 3965,\n        \"column\": 38,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze([\\n  // The same native host keeps its tenant slot while adopting updated code.\\n  'PAPERCUSP_HOSTED_NATIVE_SLOT',\\n  'PAPERCUSP_SID',\\n  'PAPERCUSP_AGENT',\\n  // Recorded role authority must survive the same-host adoption preflight.\\n  'PAPERCUSP_AGENT_ROLE',\\n  'PAPERCUSP_ADV_SESSION_ID',\\n  // Keep the proven launcher actor through host-code adoption. Without it,\\n  // the successor advertises human-owned provenance and quota recovery refuses.\\n  'PAPERCUSP_LAUNCHED_BY',\\n  // A re-exec ta\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"ac6321efdb4361b5f94182a65f9b5bee9f92efa02a6640570262d36de6516bef\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"c3a17717c9e82e2488204347d3bf2bef37d97af94dcb1372ec67eb0aee6facc6\",\n        \"sourceTruncated\": true\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 207279,\n        \"end\": 207343,\n        \"byteStart\": 207602,\n        \"byteEnd\": 207666,\n        \"line\": 4392,\n        \"column\": 3,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_OWNER_PRESENCE_THROTTLE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"51a833e25b88aff8e269a3c67c6e27cf72e42576063c7209db19de08db75293a\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"7c019b67dca7c12effe9595c925f930e4dd1c0e3d10adcaf33ae78976ce3101b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 214156,\n        \"end\": 214366,\n        \"byteStart\": 214485,\n        \"byteEnd\": 214705,\n        \"line\": 4554,\n        \"column\": 37,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Set\",\n        \"specifier\": null,\n        \"source\": \"new Set([\\n  0x50, // ESC P — DCS (XTVERSION, DA3 and DECRQSS replies)\\n  0x58, // ESC X — SOS\\n  0x5d, // ESC ] — OSC (window title, color queries)\\n  0x5e, // ESC ^ — PM\\n  0x5f, // ESC _ — APC (kitty graphics)\\n])\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"900e18aa39c0425ed57c22382461873b715a8b31ceef4d318a4ed795cf22bc10\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"3f74286dbac09842903b29d7f4656b354424aa64c7524d180883593b4427283e\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 240251,\n        \"end\": 240306,\n        \"byteStart\": 240656,\n        \"byteEnd\": 240711,\n        \"line\": 5177,\n        \"column\": 34,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_GRACE_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"7096b22565a7fd0aceef7036ca14cc1573558d29a3f3a75006062096a69fefc9\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"4734ae98e5aa090d96d1a62514be9842c1d8c4d0d7e7be5bd86690b9e3a9f351\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 240718,\n        \"end\": 240777,\n        \"byteStart\": 241125,\n        \"byteEnd\": 241184,\n        \"line\": 5186,\n        \"column\": 38,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Number\",\n        \"specifier\": null,\n        \"source\": \"Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_ACK_DELAY_MS)\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"dfe8bd333770b5f7a8f3b883a71549b1624292cfb75eddcdd27293bd177ddd7d\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"cdcca2a3aea6d5aea64ab02c29a22a42fd4c42302568de6d2c93fd93a9fc1344\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 296252,\n        \"end\": 297269,\n        \"byteStart\": 296793,\n        \"byteEnd\": 297810,\n        \"line\": 6237,\n        \"column\": 46,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze({\\n  'no-startup-ready-marker-last-resort-failed':\\n    'the child never emitted its startup-ready marker AND the last-resort attempt found no prompt',\\n  'no-startup-ready-marker': 'the child never emitted its startup-ready marker',\\n  'kickoff-marker-echo-unconfirmed': 'the exact Codex kickoff marker never appeared in the composer echo',\\n  'submit-verification-exhausted': 'submit verification exhausted without observing output after a resubmit',\\n  'fresh-child-owner-input': 'the owne\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"27fbf25738a55ad13d2d3b03cd0181f04f769178c1d468a3a78e16f92c41a8d9\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"0a64fd7d36f9f61e1ab39d24f6d3bf79c2e6dbb5bb6944ab907dc8b9b5ddafa4\",\n        \"sourceTruncated\": true\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 437558,\n        \"end\": 437701,\n        \"byteStart\": 438464,\n        \"byteEnd\": 438607,\n        \"line\": 9320,\n        \"column\": 45,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Object.freeze\",\n        \"specifier\": null,\n        \"source\": \"Object.freeze({\\n  crDelayMs: 150,\\n  settleMs: 300,\\n  paintBudgetMs: 8_000,\\n  reconnectBudgetMs: 20_000,\\n  maxArrows: 40,\\n  closeWaitMs: 400,\\n})\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"f61b15222ef3f0e4ea03b0a42f2100c6f0d6a4f253372495a29572a1f3803823\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"57b0156da5fae351ea8d47e4b9b7f2fe2cefa82dc1eeae5bd070da9c5720858d\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 466880,\n        \"end\": 467244,\n        \"byteStart\": 467875,\n        \"byteEnd\": 468239,\n        \"line\": 9942,\n        \"column\": 42,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"Set\",\n        \"specifier\": null,\n        \"source\": \"new Set([\\n  'carry-respawn-pending',\\n  'native-turn-start-pending',\\n  'successor-native-id-missing',\\n  // This check runs before injectTurnAtPrompt writes any bytes. A Codex quota\\n  // recovery can replace the child and clear the latch, after which the same\\n  // accepted wake may safely make its first submission.\\n  'submit-verification-aborted-quota-blocked',\\n])\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"00e20a3ad7b959d5d4eded3d1c64e6fc2a196953b7790c4b55776bf2c89745dd\",\n        \"binding\": null,\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"e15b51a68351e7f7d90591d508a60af4201298cfc0db102f87ef4af10e0fc191\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-pty-host.mjs\",\n        \"start\": 500331,\n        \"end\": 500381,\n        \"byteStart\": 501510,\n        \"byteEnd\": 501560,\n        \"line\": 10578,\n        \"column\": 45,\n        \"kind\": \"call\",\n        \"typeOnly\": false,\n        \"expression\": \"join\",\n        \"specifier\": null,\n        \"source\": \"join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts')\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"0d16c218db1b7467431d31960f19f45bd09c3df146ce09a0fd79767e19bfcbe4\",\n        \"binding\": {\n          \"imported\": \"join\",\n          \"specifiers\": [\n            \"node:path\"\n          ]\n        },\n        \"calleeCoverage\": \"UNKNOWN\",\n        \"sourceSha256\": \"307a290e30a8cace4082377e4775edb855d0622f90e0685f314a97050918edcd\",\n        \"sourceTruncated\": false\n      }\n    ],\n    \"coverage\": \"Only exact lexical binding/argument/control-flow evidence. Caller initialization, dispatch environment, imported/model detection and runtime/prototype effects remain UNKNOWN.\"\n  },\n  \"firstUnresolved\": {\n    \"kind\": \"external-runtime-module-initialization\",\n    \"chain\": [\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"start\": 706,\n        \"end\": 761,\n        \"byteStart\": 718,\n        \"byteEnd\": 773,\n        \"line\": 17,\n        \"column\": 1,\n        \"kind\": \"import\",\n        \"typeOnly\": false,\n        \"expression\": \"import\",\n        \"specifier\": \"../../cors\",\n        \"source\": \"import { requireAllowedOriginOr403 } from '../../cors';\",\n        \"enclosingFunctions\": [],\n        \"predicates\": [],\n        \"initialization\": true,\n        \"fingerprint\": \"4ca0838467d9b36d308b686be935897cfcc88e849ec7f5ef875dfa6bfabda926\",\n        \"binding\": null,\n        \"calleeCoverage\": null,\n        \"sourceSha256\": \"e3c73881111cd6b03cf413e67a9400512c86aa3f712c8c9dc1805733f705182b\",\n        \"sourceTruncated\": false\n      },\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/cors.ts\",\n        \"start\": 984,\n        \"end\": 1017,\n        \"byteStart\": 998,\n        \"byteEnd\": 1031,\n        \"line\": 23,\n        \"column\": 1,\n        \"sha256\": \"a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34\",\n        \"sourceSha256\": \"1ef8e0abb4ab8c627b99c2904a7b70f92b6eb194eb0a1c755015b695b2a15547\",\n        \"source\": \"import { cors } from 'hono/cors';\",\n        \"sourceTruncated\": false\n      }\n    ],\n    \"specifier\": \"hono/cors\",\n    \"targetResolution\": {\n      \"status\": \"resolved-installed-external-module\",\n      \"installed\": \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/middleware/cors/index.js\",\n      \"canonical\": \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/middleware/cors/index.js\",\n      \"relativeToRepository\": \"node_modules/hono/dist/cjs/middleware/cors/index.js\",\n      \"sourceSha256\": \"de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7\",\n      \"effectCoverage\": \"UNKNOWN; installed bytes/resolution are not a runtime implementation or initialization proof\"\n    },\n    \"nonDischargeablePredicate\": \"The selected endpoint eagerly loads cors.ts, whose runtime import hono/cors has external implementation/initialization coverage UNKNOWN. D008 does not permit interpreting a resolved external target as proved closure.\",\n    \"disposition\": \"STOP at first unresolved edge. No subsequent seed is traversed.\"\n  },\n  \"union\": {\n    \"bound\": 60,\n    \"additions\": [\n      \"apps/operator/scripts/psu-carry-fence.mjs\",\n      \"libs/host-platform/src/home.mjs\",\n      \"packages/operator-core/lib/claude-sessions.ts\",\n      \"packages/operator-core/lib/endpoint-route/cors.ts\",\n      \"packages/operator-core/lib/endpoint-route/route-stack.ts\",\n      \"packages/operator-core/lib/endpoint-route/cookies.ts\",\n      \"packages/operator-core/lib/auth.ts\",\n      \"packages/agent-mcp/src/index.ts\",\n      \"packages/operator-core/lib/search/query-embedder-warmup.ts\",\n      \"packages/operator-core/lib/search/prose-vector-dims.ts\",\n      \"packages/operator-core/lib/adv-session-windows.ts\",\n      \"packages/operator-core/lib/adv-session-focus.ts\",\n      \"packages/operator-core/lib/adv-sessions.ts\",\n      \"packages/operator-core/lib/field-reliability.ts\",\n      \"packages/operator-core/lib/sync-sse.ts\",\n      \"packages/operator-core/lib/adv-roster.ts\",\n      \"packages/operator-core/lib/adv-session-search.ts\",\n      \"packages/operator-core/lib/desktop-window-liveness.ts\",\n      \"packages/operator-core/lib/windows-desktop-windows.ts\",\n      \"packages/operator-core/lib/omp-config.ts\",\n      \"packages/operator-core/lib/session-port/types.ts\",\n      \"packages/operator-core/lib/session-port/source.ts\",\n      \"packages/operator-core/lib/su-context-size.mjs\",\n      \"packages/operator-core/lib/session-port/telemetry.ts\",\n      \"packages/operator-core/lib/omp-sessions.ts\",\n      \"packages/operator-core/lib/su-persona-render.ts\",\n      \"packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts\",\n      \"packages/operator-core/lib/superuser-token.ts\",\n      \"packages/operator-core/lib/agent-tools/coordination/control-anchor.ts\",\n      \"packages/operator-core/lib/model-context-budget.mjs\",\n      \"packages/operator-core/lib/role-launch-spec.ts\",\n      \"packages/operator-core/lib/inference-gateway/spawn-env.ts\",\n      \"packages/operator-core/lib/events/await/wake-executor.ts\",\n      \"packages/operator-core/lib/capability-envelope/session-confinement-store.ts\",\n      \"packages/operator-core/lib/capability-envelope/session-confinement-port.ts\",\n      \"packages/operator-core/lib/cupboard/identity-activation-gate-io.ts\",\n      \"packages/operator-core/lib/util/cli-entry.ts\",\n      \"packages/operator-core/lib/agent-kickoff/prompt-transport.mjs\",\n      \"packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts\",\n      \"apps/operator/scripts/psu-connection-front-controller.mjs\",\n      \"apps/operator/scripts/psu-terminal-diagnostics.mjs\",\n      \"apps/operator/scripts/tool-delivery.generated.mjs\",\n      \"packages/operator-core/lib/claude-resume-tool-references.mjs\",\n      \"apps/operator/scripts/psu-recovery.mjs\",\n      \"apps/operator/lib/mcp-proxy/budgets.mjs\",\n      \"apps/operator/scripts/psu-operator-down-diagnosis.mjs\",\n      \"packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs\",\n      \"packages/operator-core/lib/su-model-menu.mjs\",\n      \"packages/operator-core/lib/su-tier-roles.mjs\",\n      \"packages/operator-core/lib/claude-plugin/plugin-rails.mjs\",\n      \"packages/operator-core/lib/local-model-spec.mjs\",\n      \"packages/operator-core/lib/personal-vault/provider-egress.mjs\",\n      \"packages/operator-core/lib/schedule-descriptors.mjs\",\n      \"packages/operator-core/lib/omp-native-lsp-tier.mjs\",\n      \"packages/operator-core/lib/backend-bin-resolve.mjs\",\n      \"packages/operator-core/lib/framework-install-spec.mjs\",\n      \"packages/operator-core/lib/psu-launch-log.mjs\",\n      \"libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts\"\n    ],\n    \"priorAdditions\": [\n      \"apps/operator/scripts/psu-carry-fence.mjs\",\n      \"libs/host-platform/src/home.mjs\",\n      \"packages/operator-core/lib/claude-sessions.ts\"\n    ],\n    \"additionsThisContinuation\": [],\n    \"unchanged\": true,\n    \"countingScope\": \"SAME existing repository runtime-addition union. External edge is UNKNOWN, not removed or declared dependency-free.\"\n  },\n  \"pending\": {\n    \"sourceArchive\": \"evidence/ei267253-source-site-d007-initial-20261024-v1.json\",\n    \"remainingSeededFrontier\": [\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/cors.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4ca0838467d9b36d308b686be935897cfcc88e849ec7f5ef875dfa6bfabda926\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/route-stack.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"9704934cbed3e5954aa3aa530a426cd28d307d02e346ced88a7e944821986eb4\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/cookies.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"304d8f1e150512cc2525cff77bc5b953605a63750f1412042986f1a31cdffdfb\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/auth.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d8bad82d023af1c0a02a771f3f81937f96c97e5cbc7d620da98c4cd16741253e\"\n      },\n      {\n        \"path\": \"packages/agent-mcp/src/index.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"1a8f4dae0ffa074775e91c8a8f3eee3c275ab72f8205f26d7e75460beb45a299\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/search/query-embedder-warmup.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d086d4686354ee5b24388d5155c3172b6adb3043c7c49c05580ef8e6dd70b3fc\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/search/prose-vector-dims.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"38c017ef002e0fbe5784ec5cf3c1a6db1ee96238b43ea9f56db53f60affa832b\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/adv-session-windows.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"788b5933de4d8c61454ed3f0269eee9708e6de25c04a475de82dc83287fe44b4\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/adv-session-focus.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"921756173be621e1afacc468e6fc43f5f0b0a2715a9ad8e9f007915d25819b2c\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/adv-sessions.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"ef96ab3237a5ec475d4d266651c37f824b465b9c6182229499195cf4ace8893a\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/field-reliability.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"ef820e4e2b2b5e9fd7ef1c046c84fd326c737fc097b7767a78ee6e02f176fdc1\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/sync-sse.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3918dc6316ca7ffe4cb752b118192bcadcd8a35ad1318e9ca27c331dc15f8e36\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/adv-roster.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"89531930ca325c75c3ceac7d5eedd07837ea8f3ccf3e34d322a1637c5d1aa4cb\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/adv-session-search.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a7b273a438cbb70771040e4965d1d57dcbdd3946b64094ade22b5d1e7ea2fac9\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/desktop-window-liveness.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"72641d9250db1914c396059d66e52e282a682c76dfc83659a4825f101a8d300e\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/windows-desktop-windows.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"649af250ed6cc13cdeebfbb49883ccd4bb4146a9b95a962b07b7e6e0dfdb5787\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/omp-config.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d6229a72b48582f9a63f57d3beb066b6fe78f0bc449096270a036d8cffb47020\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/session-port/types.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"15b4e12802d2d15091f88ed14058ff0253ecce347bc212c28594936d993bf230\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/session-port/source.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"2afafc1615dcd6b3fcd7627beb62bba8a53188c1021b49c1ae34bc0687187599\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/su-context-size.mjs\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4ef3b2ac671034377da1fd9dca956a72ab01aa3a3cca68f9d1696f200007cb9f\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/session-port/telemetry.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"211d7142441c42b90de911b41ed1354850a4c3abd26ae56115cd46635d9d22aa\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/omp-sessions.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"df66648bfdf6a4ddd8a88978e8543dfa6fc22343c290edfa2185343275ae5d49\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/su-persona-render.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"f4df15c356644fdfc697a39bdb068fee994170ce51f5e66b5aa71723fc4dee91\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"dca2e3daef537ec74b3a1e8d9b89cc57a0d22e5a885b9df649bda1d1676b8aaf\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/superuser-token.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"119e5502134077907eba6f4c46165af177b9512f878564f99c1a980def866c07\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/agent-tools/coordination/control-anchor.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"253fc5dadc6b80393b19ca96e8da77ff81ed228128480cbe66b9f277c597057e\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/model-context-budget.mjs\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a799d185fb2df5937827496e9ddd0c0c51502a4803c01d88482b5f9558f9d45d\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/role-launch-spec.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"13af4a5d114202427128103d3338a66e2218c451dc4e7e03b42c5918650f81e9\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/inference-gateway/spawn-env.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"1c4bf7de56cbdf52f1da030cb7e02003121cb6250fcff7b4008dccfe6b10696d\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/events/await/wake-executor.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"90b848023e709ee834ef6242f682a3924cebc6b164c2034acecb2df7d76e69a7\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/capability-envelope/session-confinement-store.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"709df1824b3d5a4de5e43ae4ade13e4e644d5678bf20b728f998a3bda539e342\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/capability-envelope/session-confinement-port.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"8501d39ba653abe64423adccb8d5a6903dcf0dd6067c892badf80272ee39e442\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/cupboard/identity-activation-gate-io.ts\",\n        \"from\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"16f49c81f3aceaad7a8fa1505dcd3ec0fb48ea0213a13f095ccfe9e47746eeb5\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/util/cli-entry.ts\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ed252a97da8a9144974f2d97514b22771036a628c0042f8c8d67b7666b204067\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/agent-kickoff/prompt-transport.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"d252bfbb6a5fc16f3f0479032fcc73158408b3628153a1e39e862cce963e2a22\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"0400b3bf8ef1355de729e7582907af2951d3bae1a6cc5281d003325df2437c09\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-connection-front-controller.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"7264f98d430c4d3f5bf2d0e6598dfb2ab6e7ef7a08ef56383a53ef79a8fdf0a5\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-terminal-diagnostics.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"547d8f0f7d080b04f6932df8095d9267e19df0ba9d2488b10dcd75bce53ceb0d\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/tool-delivery.generated.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"bb728260f3211993e8d5c58f3e9389efb2cb7453e162efaa4f78d090e8c34042\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/claude-resume-tool-references.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"9a8a6a1016c8208ff88f3de13405e3d90715b9fbc9fbf9c1fdb00308ca30d7f7\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-recovery.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ff19ef775c5e6bc92d5aedf13f6d47e7622486dc503121baff942ab2ad18feed\"\n      },\n      {\n        \"path\": \"apps/operator/lib/mcp-proxy/budgets.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"935f0b61832da97743b067ce1e0b9285c65a8734fe8c94d0a0e9a6688630d661\"\n      },\n      {\n        \"path\": \"apps/operator/scripts/psu-operator-down-diagnosis.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ec89e72ca005063c4292d8e8c94415f2995fad4b713363ac85ab742d84f36b7a\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"44d6b2a2959773b16e32a9e449b8f5083bbdb12f89aac9f5e3e18c496a2f1b30\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/su-model-menu.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"5e1403e9055c060fb41607db60e5b5a0630a662bfe3bb73f7222c2462d05151e\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/su-tier-roles.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"07f9d3d408f41ab4339c4687280d5a58caf289353523a1db7035b39e895c406b\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/claude-plugin/plugin-rails.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ef5138a75a5b992ffb4c89dc3cd18aa76bf0b11b2d717cdb1bec950982ba1251\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/local-model-spec.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"0909919f4c719e3b9683c1e3989b14070873d2d1b7916064d9757f4a1b639428\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/personal-vault/provider-egress.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"58987d4b4a5a29a7481f11a16d56cbd71d357454987d2aaf970eb90a08712f57\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/schedule-descriptors.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"9b98d1f56ea88dfd90cc3a2513e932ef739f146c07a0a09e33c6aba88a604549\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/omp-native-lsp-tier.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"7e29cba3881bd8349bd9268c0c4be66636f5d76dd5e263c70a08aa08e3d72cac\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/backend-bin-resolve.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"4df782377b04c1f9cb03408f7792ea9291d13d0da22ee309afdf109d3d93ec94\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/framework-install-spec.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"66da779cd0f4f6fc45f6db2b0cc727d609176523cc9cfb1695c97ae562c68251\"\n      },\n      {\n        \"path\": \"packages/operator-core/lib/psu-launch-log.mjs\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"3898ef26514d80cce7f308988863255d086bef40286b3f0b51558d3cadbdb1a2\"\n      },\n      {\n        \"path\": \"libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts\",\n        \"from\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"0a656d7df0591b8fe07b46242d872dd946d816da836449a938b47d3d56bf370b\"\n      }\n    ],\n    \"savedUnresolvedSites\": [\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"27b20a395f8302ff779255156b08faf2f522645c4b52f6612066683d85223e6a\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"fa13354192ae4c36be2a8964c830dd05a8dc4e5aa7706be0628990ce9a322ed8\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"8fa5611f3058f2e089388f48d2165d5770644963263df7e55abfa030e6706345\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4542d756bc8ca4b3862d39ffd17a7df7212304b06538a8bd4e86d87058ac92e3\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"183f59b4111194f21ae235c4bf06983241585457ad5ce9d1ea47fccc6ecdf4a3\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"cd78826aa0b92359672b11ceeb42a72f365626f89230ef5581abcd817a2640f6\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"b9823888521bab9fe5d0d3bfd87476a6927ff17acc55b3108afac4144cf85836\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"b68c666706bd852cfdd7f9772d1e4a4af9afc06b6bf8cf7432e4793e6b299e97\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3e7779c6e5288f489b0d9b4019da2401d3ec949a802b7ccacb97e3800902bfd6\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"2e32952408ffb19ef01d9e5175d29b3b58376a7382b580ddb9208d883b49dc4d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"f8df233f715ee4c28c9cbbbc17a3685371b6159a695d4fb3cb081c1b9a06c91e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"0c8e8702ba6bc151f109a91a4d31756ec1045ed1d878385dc8d08e879053e05a\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"dd035c14170d38a5b1107bb8d7d5e723fcf855117d6b88c14e2f2b1cdef0036b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"abc0ce9304199ffef51506bde413887c7313596502fd9130eb4a1752242450c3\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3f40b7aa45270b6dfa975147585cf1f6e3bc7b87f11473b5e253e3d028a4f12c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d43a497e4ca9445770afe1c22db4d4585153b2dacbc57955e8be4504d153d5cf\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"e9ab99d2f66647420ae8d575fd27a84afe31c0383321644d62bc3bdb60bc0703\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"b74708634ccf399eda6d293167b7ae59623ac4b3812046fb5c50e86bca445927\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"39364ed0297d14ec31f3beaa85fc3cde771ed6f9c080e32a37b5ba6b2bf8668e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"c3b5ef5ebd9696f00c5f106ac2322193c40f1cd8d28ee343589fb21f10b7fb91\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"c3fd6622bc032aacbacc469391d66aa85fd892a00e64b3fcfe3dda3cdce12086\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"935541107b498b42fe85c0c3d5a86bdfc73702d86005ce6d9cb92f0cce002687\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"743e0086735abb04b1157d9b0c90ed6cb35f7cc5a68405903689663c93224289\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"88f70a963ed8453f16fe1332c147e263c16d9b7b561362e4dbe499299fedf7a2\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4367947a6ef8eca96a3df6d12c6f9d2432efd6b377cd1ccf4a7ea23fb1b472c4\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"fdf30dfef740e0a63df0f19bdce84646ded43bab504a91207c87701094adf89b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3b83450f1b5aa1c1ab3a49b74acd367dc6666bd53b1bc64b70e41f2e458e1e74\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"2ac399ed8307e539234d27156a8eb45052ad9778527d98db68c56e3febffa08e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"0f86affedb054343d856a30fe08caf3399a7645e4cb128d2e7a6b093d47588c0\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"f612ba66610482fc2aeaa78d021599571f11dd618b5e96cac4e60df06f3f8cfc\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"304ffc231e46afc8ed277458dee0f3263037ef25146bbd67c747975c02f916f2\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"95e97d3461e6fba4fa7ad0244f734269f3c03ccb9d414d5673edf89ac54e47b4\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"71ed22efe9982e9bfe12854938bf91e2fdaf342320e6acf76e29cdaa80c41d55\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"2127da8349bae127b35101f1d0ce77ac912998f950633bded5a7fe001ab6f3dc\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"5373421d7d3858cf7a5da8dec486c8eaf2974c0f6627a0fbd7bf7f91f4dd6937\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"273ee732fbfa92c6b32bb62305d710f9104d53fdc8048bfd37dcabfe47bd44ac\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"0be548f14b4a2a663e5ae75421027cd1408edb717e3b3a716afcfb1b021abe7c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a9fc9d648a4c5f991f394c18f99283cbb34ca9e3eb2f3ca59a22751a34b64ccf\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"bb0360876ce4da1c3d64cb1bc02cd2248045c419d86be0d1871dabe93295840b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a721130953e0408bd92405bbaeb948ea51df44d9376c0e9c30c8ce1ad05c8f6e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"ccad4042e3a5256fce8f0c59f854b20a94675629438bbecc9367c18257da3aee\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4e149de158cb48269d33493051cc6ea8b5c3bf180635c091ec9f680144ab63cf\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"f31bc95d554dd68fe3a2a5a37454e63975b6e7e05119b527ab0cb485e2b92728\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"cd1df393f8882898affa2405131fc068e3039dd750711826ebb5d66061adbb6a\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"dd3f7b50bebf7a2c67c09febb33f99a83f9b05c2a4cbdb50e5da8b9bd15ae7a4\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"36a95bce87b0dea60ed665882e1a55124c2516db468224b4be087d92f7cdd5aa\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"ca5e068861feca3cae8772b3f43b4f6b4146f594287a1c1055ef5080db935224\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"6b6f97b5818612d6fc1bd81ed3525322afe4c0ba3df4ed54639c8bedf752588c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"7d7e75515360f2e84002f404efe5dc434a2aaf7996d587d010ae557b05ddef10\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"e133e3a0bc0bb091db767d2bf39c5901a1f92b40b045e3eca35806f27d973b6d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"e65f3e8bf80b0361ed629e37e1b76458fa0f94a45afff6f16d2ae95d9a287360\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"cac0782c7e9ad2fc747946b26a87a32b61b5548f139216cc6959ac5d3bfe39c9\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d756690b77411833d51ba367f29a90ec3a3e19d4edff1f76ae67d8cbe4d1f75d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"4d5f1f2ce0bddf12052b87ae3c9363dd31da8e773552b6b3450d71031fdde12c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"60ee7dab1d37d8f533ba23e2e902ca75dcb4e673c52a934ec88a7b75ec123571\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3aba273c769e86f51f5c1f7afc3b0bd588caadaa4b8fe178dd0de4473bd03ef2\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a5030a490c5269293b2f3d8de20d2166e629a35f8cdf2cf328850ba8dc4b881d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"ef060e09faf5eebe8fe45fb7ed548d212898735eb98413f975e914049ba0a2c4\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"69da2e823be5bf595cce168d01c259cac4e14da3954d653bdad8819161cf54fa\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"23861a3f7e91f15d65e31a577097883617f9240740525d7b19e80a1178061332\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a9685b2c00626dda9c837e2387f2215f27234b4cb384efbd358a5629bcca2c92\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3d1c3bc3e6cd9090becc8403e04f0c2814c7f99e1e7dc058124fe92c289f3dc5\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"9da38bc40717e35952f18225556938b2fde6a53cff830961fbed4bd98afb6f54\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"322635e18c4aa1a00ecf00d37a3ac23571eaba252e07b47bc6011bfdefc36d9c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"93ec1b0fca7ebad19aee262a63f2ddf2d2f8e045ba4d252b14563bb72a863ec6\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"3e7314e6631d43a4153d70728a1b680dee3994b3737b4486cc10209ad95e2276\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"078ec91082472dee62490ca4b67cb586fb90d0eb3806fe106d09d319f2959725\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"5dc209e50eaca3b67c4797cf76e646f291838170afdcc10328f2ffad98d9b112\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"0bf8d42a102ebd1a7f54f126b2cfbaaf74688f1d8d594f108b1aa8d86e46c611\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"63ada31da2c89de7a3e46980dc37f57d5658523f5e54dc847d8fccae4781110e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"bfc2e5399a13a780a204f615ee1bf2aef36c8d5147ef871e64713c55f6207574\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"25fbad132ddfa07fdaaac932efe45379088672a1302dc4c429bd1eb25b140146\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"82353d95b6538782afdf8bd60078d88127549b98c4982048dc86fafb12e42905\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"5fcf032ebc35a5dc109a045876eb7ca4140c03b56f903a0664880f268d361446\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"5879bf42c375d5f844b3dd74e0cf18ffff86f5144366414e3124e33cdfdadf7f\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"7519b2d77d6d54b04347f6a46fe1548afb4e227226694f270c0dfb4a6d7ad88d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"f731dcc1e08eb44d65dadf0eebe8c7aec8559d765b462b0c16c85d5eaba1b330\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"d461888ff596cdbde4e5dec986fd43277afb7258ac09e8caa3a9f4a7dbd50377\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"836aecc1f288353ba35180a0e67b8835f654c075d26cc2aae826ce3dce1a96a9\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"2f67dea3fd27848c0df0f64c8a38983ecd484f0a50b76d971afefd8ed740ca8d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"dfd45879aa9c3069fd263fa81518a967b7fdfdcf4c73f4a6a5e452ad2d772cdb\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"a084581c473b48d799d75902a4c1a40d61ff2322222bb73127abc1c59518530c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"8337b4457bdbaf584304ba3ed02cc2807c9b8140f0ced5a217250840359f2223\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"9f8a31eb7115aa40c93e5e3da9e2e486975394b8f1277ed84f4378b3d9e5f341\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"7d54667f18a958cb1b382f1a9d912d398c43aa6e84932da6781d29ceb75c2af3\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"15c886c0476b4e00b06ae9a74f5f207f3d1b1fa7d4b60706b7deca655e32f5f6\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"8b38ff429e1e110efc4a2e3dc833dc7b7ba03483aa958513c851e6833eef3609\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"47275d2a26dbb49743a7c244e08115ad188126f6913ff0016caa95d3ab515a5c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"03330eac66335e64c3c03009e5137e05e35d15dc0a6bd7dbee9ddd1a21826a86\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"e233a8a614d6c729999d48e9317c49df213c633a19232195a0e64323705fe3b8\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts\",\n        \"siteFingerprint\": \"8b217e84ab44993bdc0328fd76fb465bbe98aa26faf9a01849ad7d6a01c6219a\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"a6cd4a4fea9b700499ab336717833370c781857ac5ef1746a2fa7c2125b6e7f1\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"82e6ec692b9f1c136f209df69bb4e0f1ca58a681a36439cac3654e367b0b4e3e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"bf7c4e5e42f76849b9f3c1640153cc509f7358a35a79ec6c894356a4898f296d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"52fb1c6d19dd6b61f953013e2d86b8b1cabc3c6fa6440283207a6677d5b07788\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"d4bab7e347d391f4915ebc1634f62e43a5e40c6e6d5e27e11e2d0635d3d88e46\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"a7ccb9305df97486f63c28f403d678449a2e399d13d7c37c7af8df2e4b0ec862\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"14aed7d67a69edd5d50c9a54babff1dbb9704e5130ca233d0acc0b4ae231d8ef\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"780b1054720faf0dadefe49e70944a39d0bd0cefe96876aebdbb981eeff0040d\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"9adf98ecabbfdc9836a4678a663633c0d9de96fa729f73e989d3afdef187a076\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"73ebf1c38ec1e6395743f47ea69d19376e85457f9502f666294c5ecb2eb892f1\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"37a71ca7c3ecea307bea863e1118e40c4d2b7bc537f48c83cad2205ee1307ce8\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ecda83e016e2e52c45fe402e1a31688df5a5cd75e8cffbc937adfe981b1687c1\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"f18e035620d6395eb29b53847471d9d6800071593f0b2c4a997329385d712f42\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"f1a568e7a46559e1e26dffdb3dcfc02c94f72961e4450e5561b29bb4e4bc2009\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"240a19f2a3d9ddf6f968b2218438127795639ea736c3b254fe8cdb9268281075\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"4edf77449be29afa6c32a4f631c1f06fcba267f262a93d71315066ae5db79677\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"548e73972da526c6e0f880debc0e17804d24953d3b1623443bec3c2453974041\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"cc6fa164f2dd71664240d55b0cfe148f6b2ba80f891aa5a31cfd1308c65dbd22\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"d2189ca64a70b97e9a69b9fc07a7128b354fa91bcd1121317147293abc8b200e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"cefef3505f839762a16ddc71f14c17c1bedde44cf7cec6a57381a59d207f025f\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"f1b60e058dd8ce2b20381a26024ebda10c7c1e2795fa39cc123c412217d2af62\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"7f3a4f04f6c63a297ba2dac379b40effc4c15a22ef3be84f743bea1cd581d967\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"37e96b79aa9a521a5c4ed1f4cae3169ee40d7aedf7ef777bc630f96605988645\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"0bdc7a52963e24df2df6b046c0df6be3cf9965341bfdd6f29575137698f0e33b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"54f735ce7a8526d45f71b206f9a09a9181b4f14030bd56e8a0e4a2ed2c6a0563\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"1ef8f95058670391735aeb7b2dc80f35d7a3381c73631fc32ba9bb261e5f62f0\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"76b5a7670fa51c35d929a8455e5287dbec251fc383af9909aa332dffb1478503\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"b1df237f8ccb7c65578eb92f1d2b4c2f311ed87281cf1fb7fefe5a3790893962\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"dfad20eac73332a33945ed9bd20e6469571be57c2baf779c2dc365afecde814f\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"2e1bb01ba665ba89ae0927e94c0848aa8b50b025a358408d7a89f34bdb58404c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"3f3dd14a4444d1be27e2b61b29f6c329ba34af2455bc65e9d5247fcfa6d4efdc\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"4e7a08d57f6cf353157e760f31d90090490e6a6c3b3ce9a778b981f7f57d653c\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"fa06ea956b79d532253296c6fe220508c530f561ba004b21e58bd3c1f5618186\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"29f0af61ce6caad3ea986df6e00f37e98e3f0ae86c29e3fe3fe9f25eac53f139\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"6b5199890fccf48d8b4feb73d1066cc36fb354993018cf8d2b421bb64d39197e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"d42b85660d76b51cf2418289211b21319c6635cb3555ca7fe25c3a7f29a62a19\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"2aca39d7cfaebaf432d3b93883cdb9abb6fed8bdb08f640acc6061386efa1804\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"00928d545536f371e88ab0c6c5fd665e63dedfade0f94fa3b18e134a39600b3b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"9ca9973f51ee2a5731575432a56785fe673d436e839015c5287998d0c48522b9\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"53e6aadb6f91406ae25f846a6f03b70c2d3c7c8243c74a07c1979c8878243b36\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"854864ca373b2e958195c026bce1ca1539906b4a44b32f8d40ab024d91d72417\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"07576104ce767d6c86eee9dac7ed02943f46e36d0c03a9e9bf938bf8d804995f\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"34312a9a2f106420c38cd6837c98b72a38556c054b25b29d90aa4bb0177de18e\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"ed5b9c83c446d985dc5cc23254034e8531bdf0ca0b9c56b74e294e112aa0dd22\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"abb5b4e968c9bb112a66c88ab5bbd06ef71397cd70e0891f9e8dc9c826cea31b\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"8d5d7c2bee1c3c26338a648ec46b6192d44e592c093cf31d98cafe9c02c567ab\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"3a3c9e25b5ce2079da13d962057778f33c9d6348c40ddbd43bf6468f7ebcfb20\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"98fe8cecffc7adf4e4ff42a4ecaaf4a22208d5f033c776d9c565101d72d48a7a\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"c589e0a51bd58a60969ab0195723949dd2db98ce167b478f0184ae2dc11466e8\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"e9db962238a0fda0830ef6abc2f13a62942d8b8e7253bc5c89c264ff9d82cdd9\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"3590f116fdf4d6de9ef91f9550940375d98b5e29eb95f110e8e2920b6c53c69f\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"0351ad7c9584c196e306995f778e5d610503c3b1b2d6219bb63112329b2056e4\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"118230201cd04635947d87b520e76915b2ecd06c5341debd611e2b0a129bc0dd\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"38e503537769deae05c406695d679a2c0e2310127d11c949fe94f1ce38935551\"\n      },\n      {\n        \"reason\": \"callee-or-callback-runtime-coverage-unresolved\",\n        \"path\": \"apps/operator/scripts/psu-launcher.mjs\",\n        \"siteFingerprint\": \"15cf9c09fa18134d3ddabacde71efdb849eb467ffe4a95f7969a40581b542cd7\"\n      }\n    ],\n    \"obligations\": [\n      \"Complete seed0 external initialization before further closure.\",\n      \"All other retained seeds, including baseline members, remain proof obligations.\",\n      \"Caller/adapter initialization and callback/default dispatch remain pending.\",\n      \"Verifier/funding/writer/recording, local/imported callees and transitive bodies remain pending.\",\n      \"No runtime preserved-artifact request/adoption/fence route is established by lexical option forwarding.\"\n    ]\n  },\n  \"guardEvidence\": {\n    \"newTestsRun\": [],\n    \"previousSevenGuards\": \"Retained historical evidence in predecessor; NOT replayed or asserted as tests for this new investigation.\"\n  },\n  \"effects\": \"Static reads only. No endpoint/launcher import or native/provider/fullcopy execution; no fullR, custody equivalence, budget, host/home/control or shipment admission.\",\n  \"instrument\": {\n    \"path\": \".papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.mjs\",\n    \"sha256\": \"b192fad0f6b2ff74948547eebe1ed4c467daaa181183733c537a1831f3b8241b\"\n  }\n}\n",
  "rawResultSha256": "6163a8bd410c2eb46ccd30d256d27146ebb9440c810a5eaa66a9fcef8880e309",
  "rawResult": {
    "schemaVersion": "source-frontier-d008-v4-partial",
    "at": "2026-10-24T20:10:52.651Z",
    "owningWorkItem": "EI-26725363534104440",
    "authority": "dream-loaded-control-observations-2026-10-17#D-008",
    "status": "STOPPED-first-unresolved-edge",
    "partial": true,
    "fullClosureQualified": false,
    "receipt": false,
    "predecessor": {
      "rawResult": ".papercusp/scratch/ei267253-source-site-preparation-d007-20261024-v3.json",
      "sha256": "44ac2b8e8aa1357bbafb71b0cc5847ef21ec73182d9d80ecdc1c23c0955187fb",
      "archive": "evidence/ei267253-source-site-d007-initial-20261024-v1.json",
      "archiveSha256": "e0f8e08f449f5e655ea57fd8313451f4976e344ac947a445d6e1004f90338eec"
    },
    "traversalOrder": "Bind persisted caller option sites and actual host adapter first; then continue persisted seeded-edge FIFO/AST import order. Stop at the first external/unresolved edge in seed0; no root rescan or seed trimming.",
    "headBefore": "e5999201f342256057e67060bc2f4a0057d5779b",
    "headAfter": "e5999201f342256057e67060bc2f4a0057d5779b",
    "nestedPinAtHead": "160000 commit 0a46053bebf83dfb88f5afef2bd51d30d5a7ef07\tlibs/papercusp",
    "pins": [
      {
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
        "committedSha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
        "blob": "7a33f4a484253aa948f290fda75582686362f3f8",
        "workingEqualsCommitted": true,
        "stableDuringRead": true
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
        "committedSha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
        "blob": "6c93d585c76dab0cd3302cf2b95fb91500daeb2b",
        "workingEqualsCommitted": true,
        "stableDuringRead": true
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/cors.ts",
        "sha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
        "committedSha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
        "blob": "5be64ff949e5b92551cf5bd1e77285464c79b835",
        "workingEqualsCommitted": true,
        "stableDuringRead": true
      }
    ],
    "callerBindings": [
      {
        "savedFingerprint": "4bdfacb8932b8f04c82dc6d35e8a2ded1e422631e7996571977ac1813270dbca",
        "call": {
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "start": 614492,
          "end": 615659,
          "byteStart": 616511,
          "byteEnd": 617678,
          "line": 13359,
          "column": 32,
          "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
          "sourceSha256": "efbbb4b694ead53e05036c556a87f0ec0bf01f5e952f6331dc9b18ab213cc917",
          "source": "ensureCodexHomeViaOperator(\n            ownerId,\n            env.CODEX_HOME || null,\n            env.PAPERCUSP_ADV_SESSION_ID || null,\n            {\n              model: detectRespawnModelSpec(args, {\n                ownerId,\n                agent: env.PAPERCUSP_AGENT,\n                configDir: env.CLAUDE_CONFIG_DIR || null,\n                codexHome: env.CODEX_HOME || null,\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\n                includeInherited: true,\n                notBeforeMs: modelObservationNotBeforeMs,\n              }),\n              routeMode: options.routeMode ?? env[ACCOUNT_ROUTING_MODE_E",
          "sourceTruncated": true
        },
        "conditions": [
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 609942,
            "end": 609959,
            "byteStart": 611953,
            "byteEnd": 611970,
            "line": 13274,
            "column": 7,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "6bd8a7c080c21df33ce02551b781aee11d4b1af9598c1b4dfd74061af69b9925",
            "source": "managedPtyEnabled",
            "sourceTruncated": false,
            "side": "then"
          }
        ],
        "optionProperties": [
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 614655,
            "end": 615118,
            "byteStart": 616674,
            "byteEnd": 617137,
            "line": 13364,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "2c653a432f9b60dd5a0d66595abcb43e472ece6d096eacca4440f3328bda2f9d",
            "source": "model: detectRespawnModelSpec(args, {\n                ownerId,\n                agent: env.PAPERCUSP_AGENT,\n                configDir: env.CLAUDE_CONFIG_DIR || null,\n                codexHome: env.CODEX_HOME || null,\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\n                includeInherited: true,\n                notBeforeMs: modelObservationNotBeforeMs,\n              })",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "model"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615134,
            "end": 615203,
            "byteStart": 617153,
            "byteEnd": 617222,
            "line": 13374,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "4b4a83981de56d43ce2a86a4b95ef9b999550020ccb1d942297cbf8088ba5a04",
            "source": "routeMode: options.routeMode ?? env[ACCOUNT_ROUTING_MODE_ENV] ?? null",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "routeMode"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615219,
            "end": 615300,
            "byteStart": 617238,
            "byteEnd": 617319,
            "line": 13375,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "4dc3d13762ff31107688d5d4ffbb7f9f8a76ee911c1ce992d0d3888e27bc080c",
            "source": "accountId: options.routeMode === 'auto' ? null : env.PAPERCUSP_ACCOUNT_ID || null",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "accountId"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615316,
            "end": 615358,
            "byteStart": 617335,
            "byteEnd": 617377,
            "line": 13376,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "3807ee71177ca26a3e09fe1a836e75a4933ec3bbde1c302556b606b2723f06cd",
            "source": "priority: env.PAPERCUSP_AGENT_ROLE || \"su\"",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "priority"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615374,
            "end": 615418,
            "byteStart": 617393,
            "byteEnd": 617437,
            "line": 13377,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "66f08f9dc935bed21dbe6acaddccab6f637cb3fa3b551776eddc862c6f2231ad",
            "source": "headless: env.PAPERCUSP_PSU_HEADLESS === \"1\"",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "headless"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615434,
            "end": 615468,
            "byteStart": 617453,
            "byteEnd": 617487,
            "line": 13378,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "c00454462b7efcb9c18087471fefa2bcc981269a0c712720aa29602bd7d06040",
            "source": "sourcePolicy: options.sourcePolicy",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "sourcePolicy"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615484,
            "end": 615552,
            "byteStart": 617503,
            "byteEnd": 617571,
            "line": 13379,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "835a052f73200c1d279e02874b3b4a07fa531054b26e77d095e178a1bd3a4cc0",
            "source": "expectedSpecificationRevision: options.expectedSpecificationRevision",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "expectedSpecificationRevision"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615568,
            "end": 615571,
            "byteStart": 617587,
            "byteEnd": 617590,
            "line": 13380,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "b77349bf1fa9b26d45d545d7d64dad96737e9cfbb3cbb5f5d10fb77b0fcc44ad",
            "source": "env",
            "sourceTruncated": false,
            "kind": "ShorthandPropertyAssignment",
            "name": "env"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 615587,
            "end": 615631,
            "byteStart": 617606,
            "byteEnd": 617650,
            "line": 13381,
            "column": 15,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "bdfa0d980d9c98a1567e8c28d52ec023fdc3ee01fa2fe0b258439c4a76c06924",
            "source": "onFailure: (detail) => { failure = detail; }",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "onFailure"
          }
        ],
        "callback": {
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "start": 614388,
          "end": 615721,
          "byteStart": 616407,
          "byteEnd": 617740,
          "line": 13357,
          "column": 9,
          "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
          "sourceSha256": "e741fd29f9036bb209fceba1289fe75b73f281168e1bf6eebc9905ad35495b3a",
          "source": "ensureCodexHome: async (options = {}) => {\n          let failure = null;\n          const result = await ensureCodexHomeViaOperator(\n            ownerId,\n            env.CODEX_HOME || null,\n            env.PAPERCUSP_ADV_SESSION_ID || null,\n            {\n              model: detectRespawnModelSpec(args, {\n                ownerId,\n                agent: env.PAPERCUSP_AGENT,\n                configDir: env.CLAUDE_CONFIG_DIR || null,\n                codexHome: env.CODEX_HOME || null,\n                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,\n                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,\n                includeInherited: true,\n                notBeforeMs: modelObservatio",
          "sourceTruncated": true
        },
        "hostAdapter": {
          "call": {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 610194,
            "end": 620801,
            "byteStart": 612205,
            "byteEnd": 622836,
            "line": 13279,
            "column": 7,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "60ad415ae102b61437d4439b38958e69be286d2ea54e0115ab5d8f445b8b7af7",
            "source": "hostThroughPty({\n        command: wrapperBin,\n        args,\n        cwd,\n        env,\n        ownerId,\n        identityAssume: makeIdentityAssumeHostPort({ ownerId, inspect: inspectIdentityAssume,\n          writeHandoff: writeHostHandoff, reexecCode: reexecExitCodeFrom(env),\n          attachmentId: identityAssumeAttachmentId, hostId: identityAssumeHostId,\n          headless: env.PAPERCUSP_PSU_HEADLESS === '1' }),\n        spawnPty: createScopedNativeSandboxSpawn({ env, cwd }),\n        // headless-fleet-launch P-001/D-004: never bridge a human TTY for a headless\n        // member. It resolves false anyway when stdio is detached (stdin.isTTY undefined),\n        // but pinning it makes `psu --he",
            "sourceTruncated": true
          },
          "callbackProperty": "ensureCodexHome"
        },
        "classification": "managed-host callback forwards options.sourcePolicy and options.expectedSpecificationRevision"
      },
      {
        "savedFingerprint": "eda59677f688bfaec7463e33bfa03ee85651c1a6facad5b56f647eabcec1d0b8",
        "call": {
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "start": 685237,
          "end": 685551,
          "byteStart": 687450,
          "byteEnd": 687764,
          "line": 14848,
          "column": 13,
          "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
          "sourceSha256": "cb45762fc9e2f41598b7537b14ef61a56d367adcf56e65a2e385d7d15866d314",
          "source": "ensureCodexHomeViaOperator(\n        session.coordOwnerId ?? null,\n        env.CODEX_HOME,\n        session.id ?? null,\n        {\n          requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID,\n          model: resumeModel || lastActiveModelFor(session) || null,\n          headless,\n        },\n      )",
          "sourceTruncated": false
        },
        "conditions": [
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 684955,
            "end": 684970,
            "byteStart": 687168,
            "byteEnd": 687183,
            "line": 14843,
            "column": 11,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "384351a1c1e53f0b56a30980a3cbf1bb245d01c3f68c8310c8432f633aa8f30f",
            "source": "originalRouting",
            "sourceTruncated": false,
            "side": "else"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 683102,
            "end": 683145,
            "byteStart": 685307,
            "byteEnd": 685350,
            "line": 14811,
            "column": 9,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "b81c50a45643e3ca044c811fd8ffd7ccf63c0e1a4531a07e39c5c507f76d479b",
            "source": "session.agent === \"codex\" && env.CODEX_HOME",
            "sourceTruncated": false,
            "side": "then"
          }
        ],
        "optionProperties": [
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 685375,
            "end": 685442,
            "byteStart": 687588,
            "byteEnd": 687655,
            "line": 14853,
            "column": 11,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "457f352b0787b7c4d6489bf88b0c2858529599b4375b4d27a3a6db43ded77284",
            "source": "requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "requireGatewayProvider"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 685454,
            "end": 685511,
            "byteStart": 687667,
            "byteEnd": 687724,
            "line": 14854,
            "column": 11,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "6390f775d208aa0d22e2107874aec9efdc1d2f1cb0cc9aff7ff2ac78749faa6c",
            "source": "model: resumeModel || lastActiveModelFor(session) || null",
            "sourceTruncated": false,
            "kind": "PropertyAssignment",
            "name": "model"
          },
          {
            "path": "apps/operator/scripts/psu-launcher.mjs",
            "start": 685523,
            "end": 685531,
            "byteStart": 687736,
            "byteEnd": 687744,
            "line": 14855,
            "column": 11,
            "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
            "sourceSha256": "e893d4b34355115bc35a49efa029f8859db7adc3a316633dd3f8e84f336e0111",
            "source": "headless",
            "sourceTruncated": false,
            "kind": "ShorthandPropertyAssignment",
            "name": "headless"
          }
        ],
        "callback": null,
        "hostAdapter": null,
        "classification": "launchResume object literal supplies no preservation fields; callee sourcePolicy default is null"
      }
    ],
    "calleeDefaults": [
      {
        "name": "sourcePolicy",
        "default": "null",
        "evidence": {
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "start": 785976,
          "end": 785995,
          "byteStart": 788535,
          "byteEnd": 788554,
          "line": 17031,
          "column": 5,
          "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
          "sourceSha256": "94a0eb46e8b7b623f3c21558c76c5a5fd65859da1920b258236cf8e3338ed29e",
          "source": "sourcePolicy = null",
          "sourceTruncated": false
        }
      },
      {
        "name": "expectedSpecificationRevision",
        "default": "null",
        "evidence": {
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "start": 786001,
          "end": 786037,
          "byteStart": 788560,
          "byteEnd": 788596,
          "line": 17032,
          "column": 5,
          "sha256": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
          "sourceSha256": "9dfb7b45087c2c69cc44bbeff0df68ceebb9601d95457ab94bda56ea1bec93fb",
          "source": "expectedSpecificationRevision = null",
          "sourceTruncated": false
        }
      }
    ],
    "hostCallback": {
      "declaration": {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 527743,
        "end": 527777,
        "byteStart": 528956,
        "byteEnd": 528990,
        "line": 11127,
        "column": 5,
        "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
        "sourceSha256": "66f94fce06d7ef4bd6a61513dd4cad2532a48ddbbf300ea4ad78e071d81aac7d",
        "source": "ensureCodexHome = async () => null",
        "sourceTruncated": false
      },
      "constLocalBinding": true,
      "invocations": [
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 845792,
          "end": 845830,
          "byteStart": 847443,
          "byteEnd": 847481,
          "line": 17325,
          "column": 34,
          "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
          "sourceSha256": "cc35847b3b50e0a0999f56dde43c4d03c60042f71c64a06c54ace7ab1d12b553",
          "source": "ensureCodexHome({ routeMode: 'auto' })",
          "sourceTruncated": false,
          "conditions": [
            {
              "path": "apps/operator/scripts/psu-pty-host.mjs",
              "start": 845623,
              "end": 845705,
              "byteStart": 847274,
              "byteEnd": 847356,
              "line": 17322,
              "column": 11,
              "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
              "sourceSha256": "f5ae417e6b9afbda66d01350fee3bd22f73b5c464c79a4a7772c36c49cb0b550",
              "source": "quotaRecovery && quotaRecovery.cause !== 'auth' && env.PAPERCUSP_AGENT === 'codex'",
              "sourceTruncated": false,
              "side": "then"
            }
          ],
          "ownOptionProperties": [
            {
              "kind": "PropertyAssignment",
              "name": "routeMode",
              "source": "routeMode: 'auto'"
            }
          ],
          "hasExplicitPreservationPolicy": false,
          "hasExplicitExpectedRevision": false,
          "sourcePolicyFlow": "No own literal policy field in this lexical invocation; forwarded absent value selects the null parameter default under ordinary object semantics. Runtime prototype/reflective effects not proved."
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 851308,
          "end": 851325,
          "byteStart": 852963,
          "byteEnd": 852980,
          "line": 17434,
          "column": 36,
          "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
          "sourceSha256": "b975c0884bef8f8be448891c7c92d686c44a649a1d5c0fc95d84035af2d7bfbd",
          "source": "ensureCodexHome()",
          "sourceTruncated": false,
          "conditions": [
            {
              "path": "apps/operator/scripts/psu-pty-host.mjs",
              "start": 851104,
              "end": 851204,
              "byteStart": 852759,
              "byteEnd": 852859,
              "line": 17429,
              "column": 11,
              "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
              "sourceSha256": "059145bf07a0d377e917a8eb76adbe9113b6043a7bde1cb415a47e4923468021",
              "source": "systemPromptAddendum &&\n          String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex'",
              "sourceTruncated": false,
              "side": "then"
            }
          ],
          "ownOptionProperties": [],
          "hasExplicitPreservationPolicy": false,
          "hasExplicitExpectedRevision": false,
          "sourcePolicyFlow": "No own literal policy field in this lexical invocation; forwarded absent value selects the null parameter default under ordinary object semantics. Runtime prototype/reflective effects not proved."
        }
      ],
      "otherSyntaxReferences": [],
      "initializer": {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 527761,
        "end": 527777,
        "byteStart": 528974,
        "byteEnd": 528990,
        "line": 11127,
        "column": 23,
        "sha256": "bf6595d80453d3bc0ab695f24503ce6da2f4beab05216758833f3dc0e8c8596e",
        "sourceSha256": "0f1026f2789b76e07775369f037a9487f395a376420f62deabdca4a9a030da32",
        "source": "async () => null",
        "sourceTruncated": false
      },
      "initializationPending": [
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 0,
          "end": 80,
          "byteStart": 0,
          "byteEnd": 80,
          "line": 1,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "@papercusp/host-platform/home",
          "source": "import { papercuspPath, papercuspPtyPath } from '@papercusp/host-platform/home';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "d0474db483323acbdac9b6db1deff751f9e53e93ec761764b9c7db155966809a",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "19dd00fd39bb2a360ab7a84c3cb90dbe3851f9156f09573185de0a4faa46023d",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2530,
          "end": 2574,
          "byteStart": 2540,
          "byteEnd": 2584,
          "line": 42,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:module",
          "source": "import { createRequire } from 'node:module';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "d36c2fe7b71bbb58931d680a02545c0039b3859e20be60775ac7f6ad6feba172",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "913a57dbbfc8be28932075d6a2d4a702d8cac0ea6d4a8f5130674166f7b21c2a",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2575,
          "end": 2629,
          "byteStart": 2585,
          "byteEnd": 2639,
          "line": 43,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:crypto",
          "source": "import { createHash, randomBytes } from 'node:crypto';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "608583c43b94f4329bd1492b34ef3a98c8762b0c66ad3c02a3ef69c7d60e74cd",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "03db4c242ef9481eb86c842592810228259d111d125cfbc4bd67cdf00fb3aae5",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2630,
          "end": 2690,
          "byteStart": 2640,
          "byteEnd": 2700,
          "line": 44,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:os",
          "source": "import { constants as osConstants, homedir } from 'node:os';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "267d40ecc39bc1d7d3c7eb38d0c461b4c1d9a8eb5510224eac682162c4a206f6",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "d3780e361bc91cc54c709610a89dad5c2f7223f0ba71b6b67b09a8974a370ff8",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2691,
          "end": 2774,
          "byteStart": 2701,
          "byteEnd": 2784,
          "line": 45,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:path",
          "source": "import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "596ce2ae8aa9ad136a251766dfb1cb36953687872b690d4a6452d0358c90ffde",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "89f058c7450d3076ee00487a43f110c5b9bfb953c840ad3113f3aa57c51a9b66",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2775,
          "end": 2816,
          "byteStart": 2785,
          "byteEnd": 2826,
          "line": 46,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:url",
          "source": "import { fileURLToPath } from 'node:url';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "9bdc8db677e168091af592f6ff057a4fd2bc1e373d4739278aedbac085952e79",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "c911664f1383262f472f293bf37442ecc966e75f7783f63641e87892a5d649c8",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 2817,
          "end": 2860,
          "byteStart": 2827,
          "byteEnd": 2870,
          "line": 47,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:child_process",
          "source": "import { spawn } from 'node:child_process';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "5dc268da2fb7715f7ad3af027cf4990a59ac1976db317d49fa8f38a99d312ec6",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "ac53079c057b392682a02aa85a8a87720531c97cbf92c65c12631b2343b94c01",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3009,
          "end": 3164,
          "byteStart": 3019,
          "byteEnd": 3174,
          "line": 50,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "../../../libs/papercusp-shared/src/agent/model-capacity.mjs",
          "source": "import { makeModelCapacityDetector, modelCapacityLineMatch, modelCapacityRetryAfterMs } from '../../../libs/papercusp-shared/src/agent/model-capacity.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "d4006f11ed6327d8295c0679bce14336f8ff46c592ed029446fcc148f02c3349",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "a877d88abe05bf15f373fae25f42f5e7da12de8ccf3de4e98dd02952808e8577",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3165,
          "end": 3271,
          "byteStart": 3175,
          "byteEnd": 3281,
          "line": 51,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "../../../packages/operator-core/lib/psu-launch-log.mjs",
          "source": "import { isCodexWorkspaceDiscoveryTimeout } from '../../../packages/operator-core/lib/psu-launch-log.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "958c9cef91893413db3521f310d7e64fc95bf7a821a85722d24dfc6311c7e257",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "ea537842397b06f93943c7e5d854b0a2b37f9a4f6e482d0da10aa1513f128028",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3272,
          "end": 3376,
          "byteStart": 3282,
          "byteEnd": 3386,
          "line": 52,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "../../../packages/operator-core/lib/control-plane-temp.mjs",
          "source": "import { controlPlaneTempCandidates } from '../../../packages/operator-core/lib/control-plane-temp.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "e0784d8ce4baa723d498b7433e1457e56d75baac79153e903cbe862a66ea1f22",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "d78734f80a6b194d9f377e302d6a869a4244b985ced065a248adaf8869375863",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3377,
          "end": 3514,
          "byteStart": 3387,
          "byteEnd": 3524,
          "line": 53,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs",
          "source": "import {\n  AGENT_IDENTITY_SPEC_ENV,\n  stageAgentIdentityTty,\n} from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "b0d72de183a3f4407ae22355693528eb94c5e5008ee50b3736d2699e3638cfd8",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "1949162a09a20bb5eedf836169dc9229ac5a5a9d2c19966371cfdff556e10f5b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3515,
          "end": 3847,
          "byteStart": 3525,
          "byteEnd": 3857,
          "line": 57,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:fs",
          "source": "import {\n  mkdirSync,\n  readdirSync,\n  writeFileSync,\n  unlinkSync,\n  existsSync,\n  readFileSync,\n  readlinkSync,\n  realpathSync,\n  chmodSync,\n  renameSync,\n  appendFileSync,\n  closeSync,\n  fsyncSync,\n  constants,\n  fstatSync,\n  lstatSync,\n  openSync,\n  readSync,\n  statSync,\n  writeSync,\n  promises as fsPromises,\n} from 'node:fs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "f6a2d7817cbd9af44b015173f7b403a6956be8e6566464d419389fc35bdabb9f",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "d4f0ddf5705d80e61ddb381a12a808b256eb2167f0cfbdad401eaa5527cda2e8",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3848,
          "end": 3875,
          "byteStart": 3858,
          "byteEnd": 3885,
          "line": 80,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "node:net",
          "source": "import net from 'node:net';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "e06fe82ba81af34c4f52debb36bebd01f78aee00a7926a01dcad61f65ff10a7c",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "2528037a3b803969f234c5d47aa781898b6ab75743c15ce510f1a37f1601da78",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3876,
          "end": 3941,
          "byteStart": 3886,
          "byteEnd": 3951,
          "line": 81,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "./psu-terminal-output.mjs",
          "source": "import { createTerminalOutput } from './psu-terminal-output.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "29e1bb5bc63d92591e50efa5aa78462f8fb4bf3f15f7ea961c817bf3cd81a8f9",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "7c633f7080f3467946f73ef6022aef67543d6cf653a09dd1bd9d1cfc64ee928b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 3942,
          "end": 4006,
          "byteStart": 3952,
          "byteEnd": 4016,
          "line": 82,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "./psu-carry-fence.mjs",
          "source": "import { createPendingCarryFence } from './psu-carry-fence.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "4a6943e74a51c7a464a19649fa8058fd576e1082bb16177e647a87dc053ce119",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "3d9b0a2f19b76f88f6def79124b770c95195f3d593dd226566e1ad6f9472bb8f",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 4007,
          "end": 4091,
          "byteStart": 4017,
          "byteEnd": 4101,
          "line": 83,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "./hooks/cc/dialog-answer-provenance.mjs",
          "source": "import { observeClaudeDialogWrites } from './hooks/cc/dialog-answer-provenance.mjs';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "f61862c1f747e2d94113e7681a698306cf3eac857cbf06c72e7c9bd36aa3953f",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "5dbccb9e3090b8d7f92edb4058877233c229841a2b7d3f17918976d72bdcd71b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 6219,
          "end": 6249,
          "byteStart": 6229,
          "byteEnd": 6259,
          "line": 154,
          "column": 17,
          "kind": "call",
          "typeOnly": false,
          "expression": "createRequire",
          "specifier": null,
          "source": "createRequire(import.meta.url)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279",
          "binding": {
            "imported": "createRequire",
            "specifiers": [
              "node:module"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "4506161869017b711ca726ab9062e3926fac759a584ad0e460e825635a24fb53",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 9585,
          "end": 9624,
          "byteStart": 9597,
          "byteEnd": 9636,
          "line": 227,
          "column": 25,
          "kind": "call",
          "typeOnly": false,
          "expression": "dirname",
          "specifier": null,
          "source": "dirname(fileURLToPath(import.meta.url))",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "49f5ae82dfe7e7d163184c1d4a32d475985c03c0b1e6ea84925bab2e7918d24f",
          "binding": {
            "imported": "dirname",
            "specifiers": [
              "node:path"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "fb7a7a3f69caae67819e30e84b8aacec36951aabd51fe707dc090503411d5b26",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 9593,
          "end": 9623,
          "byteStart": 9605,
          "byteEnd": 9635,
          "line": 227,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "fileURLToPath",
          "specifier": null,
          "source": "fileURLToPath(import.meta.url)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "d98aa4feb44288f202d80105fd166f09dbc10048a636f0ef2750fa106c833deb",
          "binding": {
            "imported": "fileURLToPath",
            "specifiers": [
              "node:url"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 9814,
          "end": 9844,
          "byteStart": 9828,
          "byteEnd": 9858,
          "line": 231,
          "column": 26,
          "kind": "call",
          "typeOnly": false,
          "expression": "fileURLToPath",
          "specifier": null,
          "source": "fileURLToPath(import.meta.url)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "b37f440cbba45b3cb1d52b1cf796dc559964934d55c36f96df6f05b74644384d",
          "binding": {
            "imported": "fileURLToPath",
            "specifiers": [
              "node:url"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 9875,
          "end": 9916,
          "byteStart": 9889,
          "byteEnd": 9930,
          "line": 232,
          "column": 30,
          "kind": "call",
          "typeOnly": false,
          "expression": "join",
          "specifier": null,
          "source": "join(HOST_SCRIPT_DIR, 'psu-launcher.mjs')",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "ea655464bca0b3dc4f05d84e8352465950ad3c65abff61f72964d9f5f947e09a",
          "binding": {
            "imported": "join",
            "specifiers": [
              "node:path"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "c180d3bb2a5b1f0331a7926f0a3ee89cabaabbe581340c297a97ebd9835fe8d1",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 11266,
          "end": 11282,
          "byteStart": 11282,
          "byteEnd": 11298,
          "line": 256,
          "column": 57,
          "kind": "call",
          "typeOnly": false,
          "expression": "hashHostScript",
          "specifier": null,
          "source": "hashHostScript()",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "e3216c371c2d78f2b0b28a7194759475cb064f66b6ed54c733cc4f9c71a2df6b",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "39a841b3b50bbe5e3b16eb4ed28eef1807d80c94d74eca776831858629295b1b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 12449,
          "end": 12485,
          "byteStart": 12465,
          "byteEnd": 12501,
          "line": 290,
          "column": 54,
          "kind": "call",
          "typeOnly": false,
          "expression": "hashHostScript",
          "specifier": null,
          "source": "hashHostScript(LAUNCHER_SCRIPT_PATH)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "c1527e41eb3ccf6c6da56ae4acb410e7e96a4637dc0d4d1644b339e905661bd7",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "e673ac59720bc89ff0e48e6833465ebed1f524476edb86c43e6cea2daf238f3b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 23444,
          "end": 23462,
          "byteStart": 23514,
          "byteEnd": 23532,
          "line": 513,
          "column": 28,
          "kind": "call",
          "typeOnly": false,
          "expression": "papercuspPtyPath",
          "specifier": null,
          "source": "papercuspPtyPath()",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "9de16904d0a21f47415128820e31d8a67d08392e42da42e56366a4f68dba40c4",
          "binding": {
            "imported": "papercuspPtyPath",
            "specifiers": [
              "@papercusp/host-platform/home"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "d4caeb85d04e2fcbf28b9ea30ef2382c03c3776edd2e1df4697535deed4e2c5f",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 23710,
          "end": 23755,
          "byteStart": 23780,
          "byteEnd": 23825,
          "line": 518,
          "column": 25,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "26a2777fe4b1fab9df85402b6839c9ede47b9f102497c4a58d4f959cfa580c7f",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "8248c07c696867d92279a291f464a080a176335f6c18b489bf5a8a2d05017487",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 23955,
          "end": 24004,
          "byteStart": 24027,
          "byteEnd": 24076,
          "line": 521,
          "column": 34,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "43efb6aff01414dd0a831b6bfa5dee9e451e1cf4447f61bcc6c0a608f49c17a1",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "d50436000a1e8add8e45705862aa13cd1847bd73d6a9d2aaef6ae5e3b254a794",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 34142,
          "end": 34194,
          "byteStart": 34220,
          "byteEnd": 34272,
          "line": 744,
          "column": 38,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze(['reset', 'recycle', 'carry-respawn'])",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "3acf6f6a4cc7eb66c57cb14d1c5eb07bd507eedd6f7d17698ebbacef07709300",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "b13528a6ea22ec53da3fe5445739f1bd8ee8fd90057a373abba918ce49c24160",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 64352,
          "end": 64448,
          "byteStart": 64486,
          "byteEnd": 64582,
          "line": 1349,
          "column": 34,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze({\n  codex: 'CODEX_HOME',\n  claude: 'CLAUDE_CONFIG_DIR',\n  omp: 'PI_CONFIG_DIR',\n})",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "3f8dabf1a87dedcc2671999eda849b7501155f99ed68ecd906e59eaf5324fba7",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "2ed001fcc88d3437ffb119d48733b65ec099e3b7ad6b34bebd9f124ac30ac86a",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 70685,
          "end": 70812,
          "byteStart": 70847,
          "byteEnd": 70974,
          "line": 1473,
          "column": 37,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze({\n  codex: classifyCodexTranscriptRow,\n  claude: classifyClaudeTranscriptRow,\n  omp: classifyOmpTranscriptRow,\n})",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "c78b2031d925fcb11e7cdde72a8eff0f7e5db9993d3f41e5d8d9bf369fad8cc0",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "125d1698c62b07c5867f71f4cf6be5950ec3ea7a51c846555fd060d102b14a21",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 94291,
          "end": 94357,
          "byteStart": 94457,
          "byteEnd": 94523,
          "line": 1971,
          "column": 38,
          "kind": "call",
          "typeOnly": false,
          "expression": "Set",
          "specifier": null,
          "source": "new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input'])",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "90fe0c3610e6983e4b8de05259a8acacbdcd4259c22cd879e607f110a42d5398",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "107f363ff1f4116ee758c421047ebc3b9a744dbbb5f7c814ebfa9fa1ac1ad86f",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 118355,
          "end": 118413,
          "byteStart": 118533,
          "byteEnd": 118591,
          "line": 2512,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "0f0d7532253457319176e2af38cb2db33c18c974a6da8afbbe3f7026440db98f",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "8ef6225ebbe90f273bdc6a2d8ff0ae14dc9462a77f6b417d6049b557dc7a16f1",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 118457,
          "end": 118746,
          "byteStart": 118635,
          "byteEnd": 118924,
          "line": 2513,
          "column": 34,
          "kind": "call",
          "typeOnly": false,
          "expression": "(() => {\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\n  // silently removes the kill switch for a path every fleet launch runs.\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\n})",
          "specifier": null,
          "source": "(() => {\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\n  // silently removes the kill switch for a path every fleet launch runs.\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\n})()",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "bb25aae57d7cbc33a3c47ba5fe37f399be2ce470e11aca45e5823cd95a907ae4",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "92c8a6fbf417e969821a0f3d63b9b31d020a9795dbb2776c282215f2b8f6d6e2",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 129655,
          "end": 129705,
          "byteStart": 129835,
          "byteEnd": 129885,
          "line": 2734,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "fb3a93173bd65f71036a2844e8e2967d3601c9a056046585683ff45b06049894",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "9ffc92a5fde1b1d57af4b74b5169a6159e3cba9f01fa89a9c61de15239fe3713",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 129961,
          "end": 130017,
          "byteStart": 130141,
          "byteEnd": 130197,
          "line": 2739,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "f260e2fbe07b62a3a1c59aaaea6821964e3165e2e1c0f9f04628fb0dbfd1a54d",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "d053a577b8efd0a1f1b0879a27cecce8d823f3f34dc0e013e082ecff285af98c",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 130314,
          "end": 130372,
          "byteStart": 130494,
          "byteEnd": 130552,
          "line": 2744,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "427a8bba0d3606af95233850b7f6ff812fc5e107d87fef9335a86b9b946f4ace",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "cfd1ac1fe4938acd1f8a515784970c967ba7575a7b4b296cf8e3ea5f582da35d",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 131959,
          "end": 132018,
          "byteStart": 132145,
          "byteEnd": 132204,
          "line": 2766,
          "column": 31,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "ba5a68047ee00a15181db901783f1643085cfe4c5b0e3de396e8e2d4be211296",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "3e7d70b487bd2da3a0d541ced15b98b06b0b4697618a04bc2ddee17cc47c7e7f",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 132057,
          "end": 132114,
          "byteStart": 132243,
          "byteEnd": 132300,
          "line": 2767,
          "column": 29,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "5bcab15bc5149095f57c653cefa942ba99c59baecea0a8cf34c1d06464f43d93",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "c50d8235807a5e70d6d0510775fad89a49045b3460fc7295ba63f861f40db55e",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 132157,
          "end": 132215,
          "byteStart": 132343,
          "byteEnd": 132401,
          "line": 2768,
          "column": 37,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "e49dcb5e872b3107383d99f299e0bd27915f0e60b8f322c59370b170a1646dad",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "25e4b3664cecd46819d78ac02cbb4e12ad4d03e6156232cd6b7250dd3e03ceba",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 133532,
          "end": 133592,
          "byteStart": 133732,
          "byteEnd": 133792,
          "line": 2787,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "1f45147c08482ddd838c2032a79b73dd6b9e33175c6377faf1f803eb53525b58",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "8561a57b5000736198ae726a125b53cb77c246eaaedc9bcd5eda780a5a63dc3d",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 134830,
          "end": 134883,
          "byteStart": 135040,
          "byteEnd": 135093,
          "line": 2804,
          "column": 25,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "7d2d7d9e3633e653e81d3cc545cbb8461516c820a4ef6e81c449603336ce275a",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "99679c143cebdfb67507eb5c48e064708548ca489282c34a5ac508ca956fb33b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 135418,
          "end": 135467,
          "byteStart": 135630,
          "byteEnd": 135679,
          "line": 2811,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "d347fc67f2f11ad791dbc12701f4759f1483b1dbaff7735f0da3e0939e72d51e",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "ed96d89affe0cc16d5424003eb4e8160ee97f9b83dfbea0ac70659af674930a5",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 135896,
          "end": 135949,
          "byteStart": 136108,
          "byteEnd": 136161,
          "line": 2818,
          "column": 25,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "bc16d473c4f9600c96fde8c2e2158ea957271faa8312d029cba141d51568f34e",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "a64db47a96842a2bf85aa9a81822b33af0dcfb23ff9d75388d2fdb1a50fac9be",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 136224,
          "end": 136277,
          "byteStart": 136436,
          "byteEnd": 136489,
          "line": 2822,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "54994ced70401c28f3077e66c988ff80314a4244369d25fd7e23ac5d7f715f8d",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "5764406090c8d6293402e95a5ad794a0649c97bc939af18f79203269b4d3c581",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 136481,
          "end": 136545,
          "byteStart": 136693,
          "byteEnd": 136757,
          "line": 2825,
          "column": 36,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "8161d3d4b87aba4b5686f5fa7a1e4196effaac3ec13699bdf9e1207b55f18191",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "4431e9d4da5ce4b72859c03a059c5d81572faa40b4267929ce586fb385876ba3",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 137026,
          "end": 137089,
          "byteStart": 137238,
          "byteEnd": 137301,
          "line": 2836,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "1e7bcdb4b3ed42bb00a74b548ed438249c62371195b72e818b4ff27732b35260",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "cab67ad7f4fb00fa69b8d6a741c47e22375fa70ab9b4cb5f01fd4ed6fb1ae5c3",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 137688,
          "end": 137749,
          "byteStart": 137902,
          "byteEnd": 137963,
          "line": 2846,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "dcee8c8d8d291f6d3003c09021a395a9069707eba71b61bdadf4ca9ea01ce3ba",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "03145cfa45e14e3eebffa7947b5cb22e61f5e89f7b3a0b0e481f9db917d2dced",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 138004,
          "end": 138066,
          "byteStart": 138218,
          "byteEnd": 138280,
          "line": 2851,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "5912b56d208fdf67ff42bc0f274652134e753a7d68b953a78d86f6043eb02f10",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "a8b2d3c391cac676f209461ebba518a01902ef5c9a3d6a7605b107773f85fac9",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 138769,
          "end": 138837,
          "byteStart": 138983,
          "byteEnd": 139051,
          "line": 2861,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "1174ff601b4d8d7cabb99836bb45e13d7311c4aa196e096a35988e82a57f636c",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "5a579e2e64c1a900a98c33e6a052a6b3afaa6215af7fa86fe22e8d6fe749fe7b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 139789,
          "end": 139856,
          "byteStart": 140003,
          "byteEnd": 140070,
          "line": 2874,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "0c6c27d321fd9e120ec123c85bcf485441dd55525fdb74ecc4bdb25aaf20f11f",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "7f2c517866a5e71da808ae5d0b65b4ff4be83b92b3b24c5aa88dedb19eb9ad44",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 149508,
          "end": 149572,
          "byteStart": 149722,
          "byteEnd": 149786,
          "line": 3073,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "5670fb14f737ef718fc6aa676e62e1747f3b2225c857d77d104e945a10404020",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "209672012fed3c6cb90b1fcae7869034949673b1a7024fc8e360baaca3e000f2",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 151414,
          "end": 151472,
          "byteStart": 151647,
          "byteEnd": 151705,
          "line": 3100,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_WARN_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "e163c320fcc72986f486671c3e9f37ab4d4c5998c6d85bb077fd3a919cd099e4",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "400bda92953bfbe5ca2b127964e3f924f11fd78ede12d14b6ec0864a4a7967fe",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 151534,
          "end": 151601,
          "byteStart": 151767,
          "byteEnd": 151834,
          "line": 3102,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_FORCE_RELEASE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "8b696109d460b5578602d3f1f9cfdb7e52ee79df58cebfc08e8582d49ff6bb50",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "83db1273610e8228b68110ee785f26d02de99f7c497676c6fb6cbfe5f268f507",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 153467,
          "end": 153519,
          "byteStart": 153710,
          "byteEnd": 153762,
          "line": 3128,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "76a5c1653f52c40859d8a5155ddbfee87eb883ac2d7447b2d484616a28404b33",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "7bbb55b3b7440a28766669126acf1db696db267e4034ac3928caab5888896770",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 154334,
          "end": 154386,
          "byteStart": 154579,
          "byteEnd": 154631,
          "line": 3140,
          "column": 24,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "25af3f7def1f74dd36d40cb3415f5463e97b7663d97f5087f43f1a256a9f2fab",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "4ab2074641e57d95f97c55c8fd475705fc5ea8c2e1b8631d04d88cd76af243e1",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 167195,
          "end": 167241,
          "byteStart": 167448,
          "byteEnd": 167494,
          "line": 3448,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "RegExp",
          "specifier": null,
          "source": "new RegExp(`^--?${SNAPSHOT_SECRET_KEY}$`, 'i')",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "1d2385124b61e6a1417530eafab964ba76f13fec2ee6008f3e8eeae09aab4bd4",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "5d3c7668383f17ed8c039055f935a7368ffcdbae90ba4a78935481d284f877c7",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 167275,
          "end": 167363,
          "byteStart": 167528,
          "byteEnd": 167616,
          "line": 3449,
          "column": 33,
          "kind": "call",
          "typeOnly": false,
          "expression": "RegExp",
          "specifier": null,
          "source": "new RegExp(`(${SNAPSHOT_SECRET_KEY})(\\\\s*[=:]\\\\s*)(\"[^\"]*\"|'[^']*'|[^\\\\s,;&\"']+)`, 'gi')",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "02465aeaae579dddc3ce1e561359dce03332d49f8869a73cb75a5f617e8ca0ef",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "2b1f5ef3c9f14799e2d98112e819a3c455b94ee766724b06dd24f8f92d582b74",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 180374,
          "end": 180482,
          "byteStart": 180633,
          "byteEnd": 180741,
          "line": 3775,
          "column": 30,
          "kind": "call",
          "typeOnly": false,
          "expression": "Set",
          "specifier": null,
          "source": "new Set([\n  'carry-drill-carry-delivered',\n  'carry-drill-carry-dropped',\n  'carry-drill-respawn-failed',\n])",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "520f37911aab05a22766290cd9cce355955a404faa4f79047ce6d88e4bca32df",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "5bf1dc941cc9d0b31c515aa40a782ee05d15e1754f589d3f9c321e7b6d3dac9c",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 189935,
          "end": 192928,
          "byteStart": 190216,
          "byteEnd": 193217,
          "line": 3965,
          "column": 38,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze([\n  // The same native host keeps its tenant slot while adopting updated code.\n  'PAPERCUSP_HOSTED_NATIVE_SLOT',\n  'PAPERCUSP_SID',\n  'PAPERCUSP_AGENT',\n  // Recorded role authority must survive the same-host adoption preflight.\n  'PAPERCUSP_AGENT_ROLE',\n  'PAPERCUSP_ADV_SESSION_ID',\n  // Keep the proven launcher actor through host-code adoption. Without it,\n  // the successor advertises human-owned provenance and quota recovery refuses.\n  'PAPERCUSP_LAUNCHED_BY',\n  // A re-exec ta",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "ac6321efdb4361b5f94182a65f9b5bee9f92efa02a6640570262d36de6516bef",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "c3a17717c9e82e2488204347d3bf2bef37d97af94dcb1372ec67eb0aee6facc6",
          "sourceTruncated": true
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 207279,
          "end": 207343,
          "byteStart": 207602,
          "byteEnd": 207666,
          "line": 4392,
          "column": 3,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_OWNER_PRESENCE_THROTTLE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "51a833e25b88aff8e269a3c67c6e27cf72e42576063c7209db19de08db75293a",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "7c019b67dca7c12effe9595c925f930e4dd1c0e3d10adcaf33ae78976ce3101b",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 214156,
          "end": 214366,
          "byteStart": 214485,
          "byteEnd": 214705,
          "line": 4554,
          "column": 37,
          "kind": "call",
          "typeOnly": false,
          "expression": "Set",
          "specifier": null,
          "source": "new Set([\n  0x50, // ESC P — DCS (XTVERSION, DA3 and DECRQSS replies)\n  0x58, // ESC X — SOS\n  0x5d, // ESC ] — OSC (window title, color queries)\n  0x5e, // ESC ^ — PM\n  0x5f, // ESC _ — APC (kitty graphics)\n])",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "900e18aa39c0425ed57c22382461873b715a8b31ceef4d318a4ed795cf22bc10",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "3f74286dbac09842903b29d7f4656b354424aa64c7524d180883593b4427283e",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 240251,
          "end": 240306,
          "byteStart": 240656,
          "byteEnd": 240711,
          "line": 5177,
          "column": 34,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_GRACE_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "7096b22565a7fd0aceef7036ca14cc1573558d29a3f3a75006062096a69fefc9",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "4734ae98e5aa090d96d1a62514be9842c1d8c4d0d7e7be5bd86690b9e3a9f351",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 240718,
          "end": 240777,
          "byteStart": 241125,
          "byteEnd": 241184,
          "line": 5186,
          "column": 38,
          "kind": "call",
          "typeOnly": false,
          "expression": "Number",
          "specifier": null,
          "source": "Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_ACK_DELAY_MS)",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "dfe8bd333770b5f7a8f3b883a71549b1624292cfb75eddcdd27293bd177ddd7d",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "cdcca2a3aea6d5aea64ab02c29a22a42fd4c42302568de6d2c93fd93a9fc1344",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 296252,
          "end": 297269,
          "byteStart": 296793,
          "byteEnd": 297810,
          "line": 6237,
          "column": 46,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze({\n  'no-startup-ready-marker-last-resort-failed':\n    'the child never emitted its startup-ready marker AND the last-resort attempt found no prompt',\n  'no-startup-ready-marker': 'the child never emitted its startup-ready marker',\n  'kickoff-marker-echo-unconfirmed': 'the exact Codex kickoff marker never appeared in the composer echo',\n  'submit-verification-exhausted': 'submit verification exhausted without observing output after a resubmit',\n  'fresh-child-owner-input': 'the owne",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "27fbf25738a55ad13d2d3b03cd0181f04f769178c1d468a3a78e16f92c41a8d9",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "0a64fd7d36f9f61e1ab39d24f6d3bf79c2e6dbb5bb6944ab907dc8b9b5ddafa4",
          "sourceTruncated": true
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 437558,
          "end": 437701,
          "byteStart": 438464,
          "byteEnd": 438607,
          "line": 9320,
          "column": 45,
          "kind": "call",
          "typeOnly": false,
          "expression": "Object.freeze",
          "specifier": null,
          "source": "Object.freeze({\n  crDelayMs: 150,\n  settleMs: 300,\n  paintBudgetMs: 8_000,\n  reconnectBudgetMs: 20_000,\n  maxArrows: 40,\n  closeWaitMs: 400,\n})",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "f61b15222ef3f0e4ea03b0a42f2100c6f0d6a4f253372495a29572a1f3803823",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "57b0156da5fae351ea8d47e4b9b7f2fe2cefa82dc1eeae5bd070da9c5720858d",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 466880,
          "end": 467244,
          "byteStart": 467875,
          "byteEnd": 468239,
          "line": 9942,
          "column": 42,
          "kind": "call",
          "typeOnly": false,
          "expression": "Set",
          "specifier": null,
          "source": "new Set([\n  'carry-respawn-pending',\n  'native-turn-start-pending',\n  'successor-native-id-missing',\n  // This check runs before injectTurnAtPrompt writes any bytes. A Codex quota\n  // recovery can replace the child and clear the latch, after which the same\n  // accepted wake may safely make its first submission.\n  'submit-verification-aborted-quota-blocked',\n])",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "00e20a3ad7b959d5d4eded3d1c64e6fc2a196953b7790c4b55776bf2c89745dd",
          "binding": null,
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "e15b51a68351e7f7d90591d508a60af4201298cfc0db102f87ef4af10e0fc191",
          "sourceTruncated": false
        },
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "start": 500331,
          "end": 500381,
          "byteStart": 501510,
          "byteEnd": 501560,
          "line": 10578,
          "column": 45,
          "kind": "call",
          "typeOnly": false,
          "expression": "join",
          "specifier": null,
          "source": "join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts')",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "0d16c218db1b7467431d31960f19f45bd09c3df146ce09a0fd79767e19bfcbe4",
          "binding": {
            "imported": "join",
            "specifiers": [
              "node:path"
            ]
          },
          "calleeCoverage": "UNKNOWN",
          "sourceSha256": "307a290e30a8cace4082377e4775edb855d0622f90e0685f314a97050918edcd",
          "sourceTruncated": false
        }
      ],
      "coverage": "Only exact lexical binding/argument/control-flow evidence. Caller initialization, dispatch environment, imported/model detection and runtime/prototype effects remain UNKNOWN."
    },
    "firstUnresolved": {
      "kind": "external-runtime-module-initialization",
      "chain": [
        {
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "start": 706,
          "end": 761,
          "byteStart": 718,
          "byteEnd": 773,
          "line": 17,
          "column": 1,
          "kind": "import",
          "typeOnly": false,
          "expression": "import",
          "specifier": "../../cors",
          "source": "import { requireAllowedOriginOr403 } from '../../cors';",
          "enclosingFunctions": [],
          "predicates": [],
          "initialization": true,
          "fingerprint": "4ca0838467d9b36d308b686be935897cfcc88e849ec7f5ef875dfa6bfabda926",
          "binding": null,
          "calleeCoverage": null,
          "sourceSha256": "e3c73881111cd6b03cf413e67a9400512c86aa3f712c8c9dc1805733f705182b",
          "sourceTruncated": false
        },
        {
          "path": "packages/operator-core/lib/endpoint-route/cors.ts",
          "start": 984,
          "end": 1017,
          "byteStart": 998,
          "byteEnd": 1031,
          "line": 23,
          "column": 1,
          "sha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
          "sourceSha256": "1ef8e0abb4ab8c627b99c2904a7b70f92b6eb194eb0a1c755015b695b2a15547",
          "source": "import { cors } from 'hono/cors';",
          "sourceTruncated": false
        }
      ],
      "specifier": "hono/cors",
      "targetResolution": {
        "status": "resolved-installed-external-module",
        "installed": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/middleware/cors/index.js",
        "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/middleware/cors/index.js",
        "relativeToRepository": "node_modules/hono/dist/cjs/middleware/cors/index.js",
        "sourceSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
        "effectCoverage": "UNKNOWN; installed bytes/resolution are not a runtime implementation or initialization proof"
      },
      "nonDischargeablePredicate": "The selected endpoint eagerly loads cors.ts, whose runtime import hono/cors has external implementation/initialization coverage UNKNOWN. D008 does not permit interpreting a resolved external target as proved closure.",
      "disposition": "STOP at first unresolved edge. No subsequent seed is traversed."
    },
    "union": {
      "bound": 60,
      "additions": [
        "apps/operator/scripts/psu-carry-fence.mjs",
        "libs/host-platform/src/home.mjs",
        "packages/operator-core/lib/claude-sessions.ts",
        "packages/operator-core/lib/endpoint-route/cors.ts",
        "packages/operator-core/lib/endpoint-route/route-stack.ts",
        "packages/operator-core/lib/endpoint-route/cookies.ts",
        "packages/operator-core/lib/auth.ts",
        "packages/agent-mcp/src/index.ts",
        "packages/operator-core/lib/search/query-embedder-warmup.ts",
        "packages/operator-core/lib/search/prose-vector-dims.ts",
        "packages/operator-core/lib/adv-session-windows.ts",
        "packages/operator-core/lib/adv-session-focus.ts",
        "packages/operator-core/lib/adv-sessions.ts",
        "packages/operator-core/lib/field-reliability.ts",
        "packages/operator-core/lib/sync-sse.ts",
        "packages/operator-core/lib/adv-roster.ts",
        "packages/operator-core/lib/adv-session-search.ts",
        "packages/operator-core/lib/desktop-window-liveness.ts",
        "packages/operator-core/lib/windows-desktop-windows.ts",
        "packages/operator-core/lib/omp-config.ts",
        "packages/operator-core/lib/session-port/types.ts",
        "packages/operator-core/lib/session-port/source.ts",
        "packages/operator-core/lib/su-context-size.mjs",
        "packages/operator-core/lib/session-port/telemetry.ts",
        "packages/operator-core/lib/omp-sessions.ts",
        "packages/operator-core/lib/su-persona-render.ts",
        "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts",
        "packages/operator-core/lib/superuser-token.ts",
        "packages/operator-core/lib/agent-tools/coordination/control-anchor.ts",
        "packages/operator-core/lib/model-context-budget.mjs",
        "packages/operator-core/lib/role-launch-spec.ts",
        "packages/operator-core/lib/inference-gateway/spawn-env.ts",
        "packages/operator-core/lib/events/await/wake-executor.ts",
        "packages/operator-core/lib/capability-envelope/session-confinement-store.ts",
        "packages/operator-core/lib/capability-envelope/session-confinement-port.ts",
        "packages/operator-core/lib/cupboard/identity-activation-gate-io.ts",
        "packages/operator-core/lib/util/cli-entry.ts",
        "packages/operator-core/lib/agent-kickoff/prompt-transport.mjs",
        "packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts",
        "apps/operator/scripts/psu-connection-front-controller.mjs",
        "apps/operator/scripts/psu-terminal-diagnostics.mjs",
        "apps/operator/scripts/tool-delivery.generated.mjs",
        "packages/operator-core/lib/claude-resume-tool-references.mjs",
        "apps/operator/scripts/psu-recovery.mjs",
        "apps/operator/lib/mcp-proxy/budgets.mjs",
        "apps/operator/scripts/psu-operator-down-diagnosis.mjs",
        "packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs",
        "packages/operator-core/lib/su-model-menu.mjs",
        "packages/operator-core/lib/su-tier-roles.mjs",
        "packages/operator-core/lib/claude-plugin/plugin-rails.mjs",
        "packages/operator-core/lib/local-model-spec.mjs",
        "packages/operator-core/lib/personal-vault/provider-egress.mjs",
        "packages/operator-core/lib/schedule-descriptors.mjs",
        "packages/operator-core/lib/omp-native-lsp-tier.mjs",
        "packages/operator-core/lib/backend-bin-resolve.mjs",
        "packages/operator-core/lib/framework-install-spec.mjs",
        "packages/operator-core/lib/psu-launch-log.mjs",
        "libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts"
      ],
      "priorAdditions": [
        "apps/operator/scripts/psu-carry-fence.mjs",
        "libs/host-platform/src/home.mjs",
        "packages/operator-core/lib/claude-sessions.ts"
      ],
      "additionsThisContinuation": [],
      "unchanged": true,
      "countingScope": "SAME existing repository runtime-addition union. External edge is UNKNOWN, not removed or declared dependency-free."
    },
    "pending": {
      "sourceArchive": "evidence/ei267253-source-site-d007-initial-20261024-v1.json",
      "remainingSeededFrontier": [
        {
          "path": "packages/operator-core/lib/endpoint-route/cors.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4ca0838467d9b36d308b686be935897cfcc88e849ec7f5ef875dfa6bfabda926"
        },
        {
          "path": "packages/operator-core/lib/endpoint-route/route-stack.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "9704934cbed3e5954aa3aa530a426cd28d307d02e346ced88a7e944821986eb4"
        },
        {
          "path": "packages/operator-core/lib/endpoint-route/cookies.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "304d8f1e150512cc2525cff77bc5b953605a63750f1412042986f1a31cdffdfb"
        },
        {
          "path": "packages/operator-core/lib/auth.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d8bad82d023af1c0a02a771f3f81937f96c97e5cbc7d620da98c4cd16741253e"
        },
        {
          "path": "packages/agent-mcp/src/index.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "1a8f4dae0ffa074775e91c8a8f3eee3c275ab72f8205f26d7e75460beb45a299"
        },
        {
          "path": "packages/operator-core/lib/search/query-embedder-warmup.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d086d4686354ee5b24388d5155c3172b6adb3043c7c49c05580ef8e6dd70b3fc"
        },
        {
          "path": "packages/operator-core/lib/search/prose-vector-dims.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "38c017ef002e0fbe5784ec5cf3c1a6db1ee96238b43ea9f56db53f60affa832b"
        },
        {
          "path": "packages/operator-core/lib/adv-session-windows.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "788b5933de4d8c61454ed3f0269eee9708e6de25c04a475de82dc83287fe44b4"
        },
        {
          "path": "packages/operator-core/lib/adv-session-focus.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "921756173be621e1afacc468e6fc43f5f0b0a2715a9ad8e9f007915d25819b2c"
        },
        {
          "path": "packages/operator-core/lib/adv-sessions.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "ef96ab3237a5ec475d4d266651c37f824b465b9c6182229499195cf4ace8893a"
        },
        {
          "path": "packages/operator-core/lib/field-reliability.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "ef820e4e2b2b5e9fd7ef1c046c84fd326c737fc097b7767a78ee6e02f176fdc1"
        },
        {
          "path": "packages/operator-core/lib/sync-sse.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3918dc6316ca7ffe4cb752b118192bcadcd8a35ad1318e9ca27c331dc15f8e36"
        },
        {
          "path": "packages/operator-core/lib/adv-roster.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "89531930ca325c75c3ceac7d5eedd07837ea8f3ccf3e34d322a1637c5d1aa4cb"
        },
        {
          "path": "packages/operator-core/lib/adv-session-search.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a7b273a438cbb70771040e4965d1d57dcbdd3946b64094ade22b5d1e7ea2fac9"
        },
        {
          "path": "packages/operator-core/lib/desktop-window-liveness.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "72641d9250db1914c396059d66e52e282a682c76dfc83659a4825f101a8d300e"
        },
        {
          "path": "packages/operator-core/lib/windows-desktop-windows.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "649af250ed6cc13cdeebfbb49883ccd4bb4146a9b95a962b07b7e6e0dfdb5787"
        },
        {
          "path": "packages/operator-core/lib/omp-config.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d6229a72b48582f9a63f57d3beb066b6fe78f0bc449096270a036d8cffb47020"
        },
        {
          "path": "packages/operator-core/lib/session-port/types.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "15b4e12802d2d15091f88ed14058ff0253ecce347bc212c28594936d993bf230"
        },
        {
          "path": "packages/operator-core/lib/session-port/source.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "2afafc1615dcd6b3fcd7627beb62bba8a53188c1021b49c1ae34bc0687187599"
        },
        {
          "path": "packages/operator-core/lib/su-context-size.mjs",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4ef3b2ac671034377da1fd9dca956a72ab01aa3a3cca68f9d1696f200007cb9f"
        },
        {
          "path": "packages/operator-core/lib/session-port/telemetry.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "211d7142441c42b90de911b41ed1354850a4c3abd26ae56115cd46635d9d22aa"
        },
        {
          "path": "packages/operator-core/lib/omp-sessions.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "df66648bfdf6a4ddd8a88978e8543dfa6fc22343c290edfa2185343275ae5d49"
        },
        {
          "path": "packages/operator-core/lib/su-persona-render.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "f4df15c356644fdfc697a39bdb068fee994170ce51f5e66b5aa71723fc4dee91"
        },
        {
          "path": "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "dca2e3daef537ec74b3a1e8d9b89cc57a0d22e5a885b9df649bda1d1676b8aaf"
        },
        {
          "path": "packages/operator-core/lib/superuser-token.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "119e5502134077907eba6f4c46165af177b9512f878564f99c1a980def866c07"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/control-anchor.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "253fc5dadc6b80393b19ca96e8da77ff81ed228128480cbe66b9f277c597057e"
        },
        {
          "path": "packages/operator-core/lib/model-context-budget.mjs",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a799d185fb2df5937827496e9ddd0c0c51502a4803c01d88482b5f9558f9d45d"
        },
        {
          "path": "packages/operator-core/lib/role-launch-spec.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "13af4a5d114202427128103d3338a66e2218c451dc4e7e03b42c5918650f81e9"
        },
        {
          "path": "packages/operator-core/lib/inference-gateway/spawn-env.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "1c4bf7de56cbdf52f1da030cb7e02003121cb6250fcff7b4008dccfe6b10696d"
        },
        {
          "path": "packages/operator-core/lib/events/await/wake-executor.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "90b848023e709ee834ef6242f682a3924cebc6b164c2034acecb2df7d76e69a7"
        },
        {
          "path": "packages/operator-core/lib/capability-envelope/session-confinement-store.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "709df1824b3d5a4de5e43ae4ade13e4e644d5678bf20b728f998a3bda539e342"
        },
        {
          "path": "packages/operator-core/lib/capability-envelope/session-confinement-port.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "8501d39ba653abe64423adccb8d5a6903dcf0dd6067c892badf80272ee39e442"
        },
        {
          "path": "packages/operator-core/lib/cupboard/identity-activation-gate-io.ts",
          "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "16f49c81f3aceaad7a8fa1505dcd3ec0fb48ea0213a13f095ccfe9e47746eeb5"
        },
        {
          "path": "packages/operator-core/lib/util/cli-entry.ts",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ed252a97da8a9144974f2d97514b22771036a628c0042f8c8d67b7666b204067"
        },
        {
          "path": "packages/operator-core/lib/agent-kickoff/prompt-transport.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "d252bfbb6a5fc16f3f0479032fcc73158408b3628153a1e39e862cce963e2a22"
        },
        {
          "path": "packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "0400b3bf8ef1355de729e7582907af2951d3bae1a6cc5281d003325df2437c09"
        },
        {
          "path": "apps/operator/scripts/psu-connection-front-controller.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "7264f98d430c4d3f5bf2d0e6598dfb2ab6e7ef7a08ef56383a53ef79a8fdf0a5"
        },
        {
          "path": "apps/operator/scripts/psu-terminal-diagnostics.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "547d8f0f7d080b04f6932df8095d9267e19df0ba9d2488b10dcd75bce53ceb0d"
        },
        {
          "path": "apps/operator/scripts/tool-delivery.generated.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "bb728260f3211993e8d5c58f3e9389efb2cb7453e162efaa4f78d090e8c34042"
        },
        {
          "path": "packages/operator-core/lib/claude-resume-tool-references.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "9a8a6a1016c8208ff88f3de13405e3d90715b9fbc9fbf9c1fdb00308ca30d7f7"
        },
        {
          "path": "apps/operator/scripts/psu-recovery.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ff19ef775c5e6bc92d5aedf13f6d47e7622486dc503121baff942ab2ad18feed"
        },
        {
          "path": "apps/operator/lib/mcp-proxy/budgets.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "935f0b61832da97743b067ce1e0b9285c65a8734fe8c94d0a0e9a6688630d661"
        },
        {
          "path": "apps/operator/scripts/psu-operator-down-diagnosis.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ec89e72ca005063c4292d8e8c94415f2995fad4b713363ac85ab742d84f36b7a"
        },
        {
          "path": "packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "44d6b2a2959773b16e32a9e449b8f5083bbdb12f89aac9f5e3e18c496a2f1b30"
        },
        {
          "path": "packages/operator-core/lib/su-model-menu.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "5e1403e9055c060fb41607db60e5b5a0630a662bfe3bb73f7222c2462d05151e"
        },
        {
          "path": "packages/operator-core/lib/su-tier-roles.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "07f9d3d408f41ab4339c4687280d5a58caf289353523a1db7035b39e895c406b"
        },
        {
          "path": "packages/operator-core/lib/claude-plugin/plugin-rails.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ef5138a75a5b992ffb4c89dc3cd18aa76bf0b11b2d717cdb1bec950982ba1251"
        },
        {
          "path": "packages/operator-core/lib/local-model-spec.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "0909919f4c719e3b9683c1e3989b14070873d2d1b7916064d9757f4a1b639428"
        },
        {
          "path": "packages/operator-core/lib/personal-vault/provider-egress.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "58987d4b4a5a29a7481f11a16d56cbd71d357454987d2aaf970eb90a08712f57"
        },
        {
          "path": "packages/operator-core/lib/schedule-descriptors.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "9b98d1f56ea88dfd90cc3a2513e932ef739f146c07a0a09e33c6aba88a604549"
        },
        {
          "path": "packages/operator-core/lib/omp-native-lsp-tier.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "7e29cba3881bd8349bd9268c0c4be66636f5d76dd5e263c70a08aa08e3d72cac"
        },
        {
          "path": "packages/operator-core/lib/backend-bin-resolve.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "4df782377b04c1f9cb03408f7792ea9291d13d0da22ee309afdf109d3d93ec94"
        },
        {
          "path": "packages/operator-core/lib/framework-install-spec.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "66da779cd0f4f6fc45f6db2b0cc727d609176523cc9cfb1695c97ae562c68251"
        },
        {
          "path": "packages/operator-core/lib/psu-launch-log.mjs",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "3898ef26514d80cce7f308988863255d086bef40286b3f0b51558d3cadbdb1a2"
        },
        {
          "path": "libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts",
          "from": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "0a656d7df0591b8fe07b46242d872dd946d816da836449a938b47d3d56bf370b"
        }
      ],
      "savedUnresolvedSites": [
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "27b20a395f8302ff779255156b08faf2f522645c4b52f6612066683d85223e6a"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "fa13354192ae4c36be2a8964c830dd05a8dc4e5aa7706be0628990ce9a322ed8"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "8fa5611f3058f2e089388f48d2165d5770644963263df7e55abfa030e6706345"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4542d756bc8ca4b3862d39ffd17a7df7212304b06538a8bd4e86d87058ac92e3"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "183f59b4111194f21ae235c4bf06983241585457ad5ce9d1ea47fccc6ecdf4a3"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "cd78826aa0b92359672b11ceeb42a72f365626f89230ef5581abcd817a2640f6"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "b9823888521bab9fe5d0d3bfd87476a6927ff17acc55b3108afac4144cf85836"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "b68c666706bd852cfdd7f9772d1e4a4af9afc06b6bf8cf7432e4793e6b299e97"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3e7779c6e5288f489b0d9b4019da2401d3ec949a802b7ccacb97e3800902bfd6"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "2e32952408ffb19ef01d9e5175d29b3b58376a7382b580ddb9208d883b49dc4d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "f8df233f715ee4c28c9cbbbc17a3685371b6159a695d4fb3cb081c1b9a06c91e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "0c8e8702ba6bc151f109a91a4d31756ec1045ed1d878385dc8d08e879053e05a"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "dd035c14170d38a5b1107bb8d7d5e723fcf855117d6b88c14e2f2b1cdef0036b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "abc0ce9304199ffef51506bde413887c7313596502fd9130eb4a1752242450c3"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3f40b7aa45270b6dfa975147585cf1f6e3bc7b87f11473b5e253e3d028a4f12c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d43a497e4ca9445770afe1c22db4d4585153b2dacbc57955e8be4504d153d5cf"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "e9ab99d2f66647420ae8d575fd27a84afe31c0383321644d62bc3bdb60bc0703"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "b74708634ccf399eda6d293167b7ae59623ac4b3812046fb5c50e86bca445927"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "39364ed0297d14ec31f3beaa85fc3cde771ed6f9c080e32a37b5ba6b2bf8668e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "c3b5ef5ebd9696f00c5f106ac2322193c40f1cd8d28ee343589fb21f10b7fb91"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "c3fd6622bc032aacbacc469391d66aa85fd892a00e64b3fcfe3dda3cdce12086"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "935541107b498b42fe85c0c3d5a86bdfc73702d86005ce6d9cb92f0cce002687"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "743e0086735abb04b1157d9b0c90ed6cb35f7cc5a68405903689663c93224289"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "88f70a963ed8453f16fe1332c147e263c16d9b7b561362e4dbe499299fedf7a2"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4367947a6ef8eca96a3df6d12c6f9d2432efd6b377cd1ccf4a7ea23fb1b472c4"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "fdf30dfef740e0a63df0f19bdce84646ded43bab504a91207c87701094adf89b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3b83450f1b5aa1c1ab3a49b74acd367dc6666bd53b1bc64b70e41f2e458e1e74"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "2ac399ed8307e539234d27156a8eb45052ad9778527d98db68c56e3febffa08e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "0f86affedb054343d856a30fe08caf3399a7645e4cb128d2e7a6b093d47588c0"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "f612ba66610482fc2aeaa78d021599571f11dd618b5e96cac4e60df06f3f8cfc"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "304ffc231e46afc8ed277458dee0f3263037ef25146bbd67c747975c02f916f2"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "95e97d3461e6fba4fa7ad0244f734269f3c03ccb9d414d5673edf89ac54e47b4"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "71ed22efe9982e9bfe12854938bf91e2fdaf342320e6acf76e29cdaa80c41d55"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "2127da8349bae127b35101f1d0ce77ac912998f950633bded5a7fe001ab6f3dc"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "5373421d7d3858cf7a5da8dec486c8eaf2974c0f6627a0fbd7bf7f91f4dd6937"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "273ee732fbfa92c6b32bb62305d710f9104d53fdc8048bfd37dcabfe47bd44ac"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "0be548f14b4a2a663e5ae75421027cd1408edb717e3b3a716afcfb1b021abe7c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a9fc9d648a4c5f991f394c18f99283cbb34ca9e3eb2f3ca59a22751a34b64ccf"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "bb0360876ce4da1c3d64cb1bc02cd2248045c419d86be0d1871dabe93295840b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a721130953e0408bd92405bbaeb948ea51df44d9376c0e9c30c8ce1ad05c8f6e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "ccad4042e3a5256fce8f0c59f854b20a94675629438bbecc9367c18257da3aee"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4e149de158cb48269d33493051cc6ea8b5c3bf180635c091ec9f680144ab63cf"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "f31bc95d554dd68fe3a2a5a37454e63975b6e7e05119b527ab0cb485e2b92728"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "cd1df393f8882898affa2405131fc068e3039dd750711826ebb5d66061adbb6a"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "dd3f7b50bebf7a2c67c09febb33f99a83f9b05c2a4cbdb50e5da8b9bd15ae7a4"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "36a95bce87b0dea60ed665882e1a55124c2516db468224b4be087d92f7cdd5aa"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "ca5e068861feca3cae8772b3f43b4f6b4146f594287a1c1055ef5080db935224"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "6b6f97b5818612d6fc1bd81ed3525322afe4c0ba3df4ed54639c8bedf752588c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "7d7e75515360f2e84002f404efe5dc434a2aaf7996d587d010ae557b05ddef10"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "e133e3a0bc0bb091db767d2bf39c5901a1f92b40b045e3eca35806f27d973b6d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "e65f3e8bf80b0361ed629e37e1b76458fa0f94a45afff6f16d2ae95d9a287360"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "cac0782c7e9ad2fc747946b26a87a32b61b5548f139216cc6959ac5d3bfe39c9"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d756690b77411833d51ba367f29a90ec3a3e19d4edff1f76ae67d8cbe4d1f75d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "4d5f1f2ce0bddf12052b87ae3c9363dd31da8e773552b6b3450d71031fdde12c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "60ee7dab1d37d8f533ba23e2e902ca75dcb4e673c52a934ec88a7b75ec123571"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3aba273c769e86f51f5c1f7afc3b0bd588caadaa4b8fe178dd0de4473bd03ef2"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a5030a490c5269293b2f3d8de20d2166e629a35f8cdf2cf328850ba8dc4b881d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "ef060e09faf5eebe8fe45fb7ed548d212898735eb98413f975e914049ba0a2c4"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "69da2e823be5bf595cce168d01c259cac4e14da3954d653bdad8819161cf54fa"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "23861a3f7e91f15d65e31a577097883617f9240740525d7b19e80a1178061332"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a9685b2c00626dda9c837e2387f2215f27234b4cb384efbd358a5629bcca2c92"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3d1c3bc3e6cd9090becc8403e04f0c2814c7f99e1e7dc058124fe92c289f3dc5"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "9da38bc40717e35952f18225556938b2fde6a53cff830961fbed4bd98afb6f54"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "322635e18c4aa1a00ecf00d37a3ac23571eaba252e07b47bc6011bfdefc36d9c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "93ec1b0fca7ebad19aee262a63f2ddf2d2f8e045ba4d252b14563bb72a863ec6"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "3e7314e6631d43a4153d70728a1b680dee3994b3737b4486cc10209ad95e2276"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "078ec91082472dee62490ca4b67cb586fb90d0eb3806fe106d09d319f2959725"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "5dc209e50eaca3b67c4797cf76e646f291838170afdcc10328f2ffad98d9b112"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "0bf8d42a102ebd1a7f54f126b2cfbaaf74688f1d8d594f108b1aa8d86e46c611"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "63ada31da2c89de7a3e46980dc37f57d5658523f5e54dc847d8fccae4781110e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "bfc2e5399a13a780a204f615ee1bf2aef36c8d5147ef871e64713c55f6207574"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "25fbad132ddfa07fdaaac932efe45379088672a1302dc4c429bd1eb25b140146"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "82353d95b6538782afdf8bd60078d88127549b98c4982048dc86fafb12e42905"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "5fcf032ebc35a5dc109a045876eb7ca4140c03b56f903a0664880f268d361446"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "5879bf42c375d5f844b3dd74e0cf18ffff86f5144366414e3124e33cdfdadf7f"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "7519b2d77d6d54b04347f6a46fe1548afb4e227226694f270c0dfb4a6d7ad88d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "f731dcc1e08eb44d65dadf0eebe8c7aec8559d765b462b0c16c85d5eaba1b330"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "d461888ff596cdbde4e5dec986fd43277afb7258ac09e8caa3a9f4a7dbd50377"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "836aecc1f288353ba35180a0e67b8835f654c075d26cc2aae826ce3dce1a96a9"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "2f67dea3fd27848c0df0f64c8a38983ecd484f0a50b76d971afefd8ed740ca8d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "dfd45879aa9c3069fd263fa81518a967b7fdfdcf4c73f4a6a5e452ad2d772cdb"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "a084581c473b48d799d75902a4c1a40d61ff2322222bb73127abc1c59518530c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "8337b4457bdbaf584304ba3ed02cc2807c9b8140f0ced5a217250840359f2223"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "9f8a31eb7115aa40c93e5e3da9e2e486975394b8f1277ed84f4378b3d9e5f341"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "7d54667f18a958cb1b382f1a9d912d398c43aa6e84932da6781d29ceb75c2af3"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "15c886c0476b4e00b06ae9a74f5f207f3d1b1fa7d4b60706b7deca655e32f5f6"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "8b38ff429e1e110efc4a2e3dc833dc7b7ba03483aa958513c851e6833eef3609"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "47275d2a26dbb49743a7c244e08115ad188126f6913ff0016caa95d3ab515a5c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "03330eac66335e64c3c03009e5137e05e35d15dc0a6bd7dbee9ddd1a21826a86"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "e233a8a614d6c729999d48e9317c49df213c633a19232195a0e64323705fe3b8"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
          "siteFingerprint": "8b217e84ab44993bdc0328fd76fb465bbe98aa26faf9a01849ad7d6a01c6219a"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "a6cd4a4fea9b700499ab336717833370c781857ac5ef1746a2fa7c2125b6e7f1"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "82e6ec692b9f1c136f209df69bb4e0f1ca58a681a36439cac3654e367b0b4e3e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "bf7c4e5e42f76849b9f3c1640153cc509f7358a35a79ec6c894356a4898f296d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "52fb1c6d19dd6b61f953013e2d86b8b1cabc3c6fa6440283207a6677d5b07788"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "d4bab7e347d391f4915ebc1634f62e43a5e40c6e6d5e27e11e2d0635d3d88e46"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "a7ccb9305df97486f63c28f403d678449a2e399d13d7c37c7af8df2e4b0ec862"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "14aed7d67a69edd5d50c9a54babff1dbb9704e5130ca233d0acc0b4ae231d8ef"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "780b1054720faf0dadefe49e70944a39d0bd0cefe96876aebdbb981eeff0040d"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "9adf98ecabbfdc9836a4678a663633c0d9de96fa729f73e989d3afdef187a076"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "73ebf1c38ec1e6395743f47ea69d19376e85457f9502f666294c5ecb2eb892f1"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "37a71ca7c3ecea307bea863e1118e40c4d2b7bc537f48c83cad2205ee1307ce8"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ecda83e016e2e52c45fe402e1a31688df5a5cd75e8cffbc937adfe981b1687c1"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "f18e035620d6395eb29b53847471d9d6800071593f0b2c4a997329385d712f42"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "f1a568e7a46559e1e26dffdb3dcfc02c94f72961e4450e5561b29bb4e4bc2009"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "240a19f2a3d9ddf6f968b2218438127795639ea736c3b254fe8cdb9268281075"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "4edf77449be29afa6c32a4f631c1f06fcba267f262a93d71315066ae5db79677"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "548e73972da526c6e0f880debc0e17804d24953d3b1623443bec3c2453974041"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "cc6fa164f2dd71664240d55b0cfe148f6b2ba80f891aa5a31cfd1308c65dbd22"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "d2189ca64a70b97e9a69b9fc07a7128b354fa91bcd1121317147293abc8b200e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "cefef3505f839762a16ddc71f14c17c1bedde44cf7cec6a57381a59d207f025f"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "f1b60e058dd8ce2b20381a26024ebda10c7c1e2795fa39cc123c412217d2af62"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "7f3a4f04f6c63a297ba2dac379b40effc4c15a22ef3be84f743bea1cd581d967"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "37e96b79aa9a521a5c4ed1f4cae3169ee40d7aedf7ef777bc630f96605988645"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "0bdc7a52963e24df2df6b046c0df6be3cf9965341bfdd6f29575137698f0e33b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "54f735ce7a8526d45f71b206f9a09a9181b4f14030bd56e8a0e4a2ed2c6a0563"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "1ef8f95058670391735aeb7b2dc80f35d7a3381c73631fc32ba9bb261e5f62f0"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "76b5a7670fa51c35d929a8455e5287dbec251fc383af9909aa332dffb1478503"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "b1df237f8ccb7c65578eb92f1d2b4c2f311ed87281cf1fb7fefe5a3790893962"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "dfad20eac73332a33945ed9bd20e6469571be57c2baf779c2dc365afecde814f"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "2e1bb01ba665ba89ae0927e94c0848aa8b50b025a358408d7a89f34bdb58404c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "3f3dd14a4444d1be27e2b61b29f6c329ba34af2455bc65e9d5247fcfa6d4efdc"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "4e7a08d57f6cf353157e760f31d90090490e6a6c3b3ce9a778b981f7f57d653c"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "fa06ea956b79d532253296c6fe220508c530f561ba004b21e58bd3c1f5618186"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "29f0af61ce6caad3ea986df6e00f37e98e3f0ae86c29e3fe3fe9f25eac53f139"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "6b5199890fccf48d8b4feb73d1066cc36fb354993018cf8d2b421bb64d39197e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "d42b85660d76b51cf2418289211b21319c6635cb3555ca7fe25c3a7f29a62a19"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "2aca39d7cfaebaf432d3b93883cdb9abb6fed8bdb08f640acc6061386efa1804"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "00928d545536f371e88ab0c6c5fd665e63dedfade0f94fa3b18e134a39600b3b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "9ca9973f51ee2a5731575432a56785fe673d436e839015c5287998d0c48522b9"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "53e6aadb6f91406ae25f846a6f03b70c2d3c7c8243c74a07c1979c8878243b36"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "854864ca373b2e958195c026bce1ca1539906b4a44b32f8d40ab024d91d72417"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "07576104ce767d6c86eee9dac7ed02943f46e36d0c03a9e9bf938bf8d804995f"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "34312a9a2f106420c38cd6837c98b72a38556c054b25b29d90aa4bb0177de18e"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "ed5b9c83c446d985dc5cc23254034e8531bdf0ca0b9c56b74e294e112aa0dd22"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "abb5b4e968c9bb112a66c88ab5bbd06ef71397cd70e0891f9e8dc9c826cea31b"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "8d5d7c2bee1c3c26338a648ec46b6192d44e592c093cf31d98cafe9c02c567ab"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "3a3c9e25b5ce2079da13d962057778f33c9d6348c40ddbd43bf6468f7ebcfb20"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "98fe8cecffc7adf4e4ff42a4ecaaf4a22208d5f033c776d9c565101d72d48a7a"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "c589e0a51bd58a60969ab0195723949dd2db98ce167b478f0184ae2dc11466e8"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "e9db962238a0fda0830ef6abc2f13a62942d8b8e7253bc5c89c264ff9d82cdd9"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "3590f116fdf4d6de9ef91f9550940375d98b5e29eb95f110e8e2920b6c53c69f"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "0351ad7c9584c196e306995f778e5d610503c3b1b2d6219bb63112329b2056e4"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "118230201cd04635947d87b520e76915b2ecd06c5341debd611e2b0a129bc0dd"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "38e503537769deae05c406695d679a2c0e2310127d11c949fe94f1ce38935551"
        },
        {
          "reason": "callee-or-callback-runtime-coverage-unresolved",
          "path": "apps/operator/scripts/psu-launcher.mjs",
          "siteFingerprint": "15cf9c09fa18134d3ddabacde71efdb849eb467ffe4a95f7969a40581b542cd7"
        }
      ],
      "obligations": [
        "Complete seed0 external initialization before further closure.",
        "All other retained seeds, including baseline members, remain proof obligations.",
        "Caller/adapter initialization and callback/default dispatch remain pending.",
        "Verifier/funding/writer/recording, local/imported callees and transitive bodies remain pending.",
        "No runtime preserved-artifact request/adoption/fence route is established by lexical option forwarding."
      ]
    },
    "guardEvidence": {
      "newTestsRun": [],
      "previousSevenGuards": "Retained historical evidence in predecessor; NOT replayed or asserted as tests for this new investigation."
    },
    "effects": "Static reads only. No endpoint/launcher import or native/provider/fullcopy execution; no fullR, custody equivalence, budget, host/home/control or shipment admission.",
    "instrument": {
      "path": ".papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.mjs",
      "sha256": "b192fad0f6b2ff74948547eebe1ed4c467daaa181183733c537a1831f3b8241b"
    }
  },
  "instrument": {
    "path": ".papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.mjs",
    "sha256": "b192fad0f6b2ff74948547eebe1ed4c467daaa181183733c537a1831f3b8241b",
    "source": "// D008: ONE static continuation from immutable D007 seeds. No production module execution.\nimport assert from 'node:assert/strict';\nimport ts from 'typescript';\nimport { createHash } from 'node:crypto';\nimport { execFileSync } from 'node:child_process';\nimport { readFileSync, realpathSync } from 'node:fs';\nimport { createRequire } from 'node:module';\nimport { relative, resolve } from 'node:path';\nimport { censusSites, siteEvidence } from '../../scripts/lib/source-path-census.mjs';\n\nconst sha = value => createHash('sha256').update(value).digest('hex');\nconst git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });\nconst repo = realpathSync(process.cwd());\nassert.equal(git(['branch', '--show-current']).trim(), 'staging');\nconst priorPath = '.papercusp/scratch/ei267253-source-site-preparation-d007-20261024-v3.json';\nconst priorBytes = readFileSync(priorPath);\nassert.equal(sha(priorBytes), '44ac2b8e8aa1357bbafb71b0cc5847ef21ec73182d9d80ecdc1c23c0955187fb');\nconst prior = JSON.parse(priorBytes);\nassert.equal(prior.status, 'STOPPED-unresolved-initial-frontier');\nassert.equal(prior.frontier.bound, 60);\nassert.equal(prior.frontier.additions.length, 58);\nassert.equal(new Set(prior.frontier.additions).size, 58);\nfor (const path of prior.priorPreparation.priorAdditions) assert.ok(prior.frontier.additions.includes(path));\nassert.equal(sha(readFileSync(prior.instrument.helper)), prior.instrument.helperSha256);\nconst headBefore = git(['rev-parse', 'HEAD']).trim();\nconst files = new Map();\nfunction source(path) {\n  if (!files.has(path)) {\n    const bytes = readFileSync(path), committed = Buffer.from(git(['show', `${headBefore}:${path}`]));\n    const text = bytes.toString();\n    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);\n    assert.equal(ast.parseDiagnostics.length, 0, 'AST unavailable: ' + path);\n    files.set(path, { path, text, ast, sha256: sha(bytes), committedSha256: sha(committed),\n      blob: git(['rev-parse', `${headBefore}:${path}`]).trim() });\n  }\n  return files.get(path);\n}\nfunction evidence(unit, node) {\n  const start = node.getStart(unit.ast), end = node.end;\n  const point = unit.ast.getLineAndCharacterOfPosition(start);\n  const text = unit.text.slice(start, end);\n  return { path: unit.path, start, end, byteStart: Buffer.byteLength(unit.text.slice(0, start)),\n    byteEnd: Buffer.byteLength(unit.text.slice(0, end)), line: point.line + 1, column: point.character + 1,\n    sha256: unit.sha256, sourceSha256: sha(text), source: text.slice(0, 700), sourceTruncated: text.length > 700 };\n}\nfunction nodes(unit, predicate) {\n  const found = [];\n  const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };\n  visit(unit.ast); return found;\n}\nconst parents = node => { const out = []; while (node.parent) { node = node.parent; out.push(node); } return out; };\nfunction conditions(unit, node) {\n  return parents(node).filter(ts.isIfStatement).map(parent => ({ ...evidence(unit, parent.expression),\n    side: node.getStart() >= parent.thenStatement.getStart() && node.end <= parent.thenStatement.end ? 'then' : 'else' }));\n}\nconst launcher = source('apps/operator/scripts/psu-launcher.mjs');\nassert.equal(launcher.sha256, prior.files.find(x => x.path === launcher.path).afterSha256);\nconst callerBindings = prior.launcherCallerSites.map(saved => {\n  const matches = nodes(launcher, n => ts.isCallExpression(n) && n.getStart(launcher.ast) === saved.start && n.end === saved.end);\n  assert.equal(matches.length, 1, 'Saved caller no longer resolves');\n  const call = matches[0]; assert.equal(sha(call.getText()), saved.sourceSha256);\n  const option = call.arguments[3]; assert.ok(ts.isObjectLiteralExpression(option));\n  const callback = parents(call).find(n => ts.isPropertyAssignment(n) && n.name.getText() === 'ensureCodexHome');\n  const hostCall = callback && parents(callback).find(n => ts.isCallExpression(n) && n.expression.getText() === 'hostThroughPty');\n  return { savedFingerprint: saved.fingerprint, call: evidence(launcher, call), conditions: conditions(launcher, call),\n    optionProperties: option.properties.map(p => ({ ...evidence(launcher, p), kind: ts.SyntaxKind[p.kind], name: p.name?.getText() ?? null })),\n    callback: callback ? evidence(launcher, callback) : null,\n    hostAdapter: hostCall ? { call: evidence(launcher, hostCall), callbackProperty: 'ensureCodexHome' } : null,\n    classification: callback ? 'managed-host callback forwards options.sourcePolicy and options.expectedSpecificationRevision'\n      : 'launchResume object literal supplies no preservation fields; callee sourcePolicy default is null' };\n});\nassert.equal(callerBindings.length, 2);\nconst ensureFunction = nodes(launcher, n => ts.isFunctionDeclaration(n) && n.name?.text === 'ensureCodexHomeViaOperator');\nassert.equal(ensureFunction.length, 1);\nconst parameter = ensureFunction[0].parameters[3];\nassert.ok(ts.isObjectBindingPattern(parameter.name));\nconst defaults = parameter.name.elements.filter(n => ['sourcePolicy', 'expectedSpecificationRevision'].includes(n.name.getText()))\n  .map(n => ({ name: n.name.getText(), default: n.initializer?.getText(), evidence: evidence(launcher, n) }));\nassert.deepEqual(defaults.map(x => [x.name, x.default]), [['sourcePolicy', 'null'], ['expectedSpecificationRevision', 'null']]);\n\nconst host = source('apps/operator/scripts/psu-pty-host.mjs');\nconst hostFunction = nodes(host, n => ts.isFunctionDeclaration(n) && n.name?.text === 'hostThroughPty');\nassert.equal(hostFunction.length, 1);\nconst refs = nodes(host, n => ts.isIdentifier(n) && n.text === 'ensureCodexHome');\nconst declarations = refs.filter(n => ts.isBindingElement(n.parent) && n.parent.name === n);\nconst calls = refs.filter(n => ts.isCallExpression(n.parent) && n.parent.expression === n);\nassert.equal(declarations.length, 1);\nconst binding = declarations[0].parent;\nassert.ok(parents(binding).includes(hostFunction[0]));\nconst declarationList = parents(binding).find(ts.isVariableDeclarationList);\nassert.ok(declarationList.flags & ts.NodeFlags.Const);\nconst hostInvocations = calls.map(identifier => {\n  const call = identifier.parent;\n  const literal = call.arguments[0];\n  assert.ok(call.arguments.length === 0 || call.arguments.length === 1 && ts.isObjectLiteralExpression(literal));\n  const props = literal ? literal.properties.map(p => ({ kind: ts.SyntaxKind[p.kind], name: p.name?.getText(), source: p.getText() })) : [];\n  return { ...evidence(host, call), conditions: conditions(host, call), ownOptionProperties: props,\n    hasExplicitPreservationPolicy: props.some(p => p.name === 'sourcePolicy'),\n    hasExplicitExpectedRevision: props.some(p => p.name === 'expectedSpecificationRevision'),\n    sourcePolicyFlow: 'No own literal policy field in this lexical invocation; forwarded absent value selects the null parameter default under ordinary object semantics. Runtime prototype/reflective effects not proved.' };\n});\nconst otherRefs = refs.filter(n => !declarations.includes(n) && !calls.includes(n)).map(n => evidence(host, n.parent));\n// Callback initialization obligations are retained pending; no baseline membership discharges them.\nconst hostInitialization = censusSites(host.path, host.text).sites\n  .filter(site => site.initialization && !site.typeOnly).map(siteEvidence);\nconst savedFirstSeed = prior.frontier.frontier[0];\nassert.equal(savedFirstSeed.path, 'packages/operator-core/lib/endpoint-route/cors.ts');\nconst firstUnit = source(savedFirstSeed.path);\nassert.equal(firstUnit.sha256, savedFirstSeed.sourceSha256, 'Saved first-seed bytes moved');\nconst firstImport = firstUnit.ast.statements.find(n => ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly);\nassert.ok(firstImport && ts.isStringLiteralLike(firstImport.moduleSpecifier));\nconst specifier = firstImport.moduleSpecifier.text;\nassert.equal(specifier, 'hono/cors');\nlet targetResolution;\ntry {\n  const installed = createRequire(resolve(firstUnit.path)).resolve(specifier);\n  const canonical = realpathSync(installed);\n  targetResolution = { status: 'resolved-installed-external-module', installed,\n    canonical, relativeToRepository: relative(repo, canonical), sourceSha256: sha(readFileSync(canonical)),\n    effectCoverage: 'UNKNOWN; installed bytes/resolution are not a runtime implementation or initialization proof' };\n} catch (error) { targetResolution = { status: 'unresolved-external-module', code: error.code ?? null }; }\nconst firstUnresolved = { kind: 'external-runtime-module-initialization',\n  chain: [savedFirstSeed.sourceSite, evidence(firstUnit, firstImport)], specifier, targetResolution,\n  nonDischargeablePredicate: 'The selected endpoint eagerly loads cors.ts, whose runtime import hono/cors has external implementation/initialization coverage UNKNOWN. D008 does not permit interpreting a resolved external target as proved closure.',\n  disposition: 'STOP at first unresolved edge. No subsequent seed is traversed.' };\nconst pins = [...files.values()].map(unit => ({ path: unit.path, sha256: unit.sha256,\n  committedSha256: unit.committedSha256, blob: unit.blob,\n  workingEqualsCommitted: unit.sha256 === unit.committedSha256,\n  stableDuringRead: unit.sha256 === sha(readFileSync(unit.path)) }));\nconst headAfter = git(['rev-parse', 'HEAD']).trim();\nconsole.log(JSON.stringify({\n  schemaVersion: 'source-frontier-d008-v4-partial', at: new Date().toISOString(),\n  owningWorkItem: 'EI-26725363534104440', authority: 'dream-loaded-control-observations-2026-10-17#D-008',\n  status: 'STOPPED-first-unresolved-edge', partial: true, fullClosureQualified: false, receipt: false,\n  predecessor: { rawResult: priorPath, sha256: sha(priorBytes), archive: 'evidence/ei267253-source-site-d007-initial-20261024-v1.json',\n    archiveSha256: 'e0f8e08f449f5e655ea57fd8313451f4976e344ac947a445d6e1004f90338eec' },\n  traversalOrder: 'Bind persisted caller option sites and actual host adapter first; then continue persisted seeded-edge FIFO/AST import order. Stop at the first external/unresolved edge in seed0; no root rescan or seed trimming.',\n  headBefore, headAfter, nestedPinAtHead: git(['ls-tree', headBefore, 'libs/papercusp']).trim(), pins,\n  callerBindings, calleeDefaults: defaults,\n  hostCallback: { declaration: evidence(host, binding), constLocalBinding: true,\n    invocations: hostInvocations, otherSyntaxReferences: otherRefs, initializer: evidence(host, binding.initializer),\n    initializationPending: hostInitialization,\n    coverage: 'Only exact lexical binding/argument/control-flow evidence. Caller initialization, dispatch environment, imported/model detection and runtime/prototype effects remain UNKNOWN.' },\n  firstUnresolved,\n  union: { bound: prior.frontier.bound, additions: prior.frontier.additions, priorAdditions: prior.priorPreparation.priorAdditions,\n    additionsThisContinuation: [], unchanged: true, countingScope: 'SAME existing repository runtime-addition union. External edge is UNKNOWN, not removed or declared dependency-free.' },\n  pending: { sourceArchive: 'evidence/ei267253-source-site-d007-initial-20261024-v1.json',\n    remainingSeededFrontier: prior.frontier.frontier.map(edge => ({ path: edge.path, from: edge.from, siteFingerprint: edge.siteFingerprint })),\n    savedUnresolvedSites: prior.unresolved.map(row => ({ reason: row.reason, path: row.site?.path, siteFingerprint: row.site?.fingerprint })),\n    obligations: ['Complete seed0 external initialization before further closure.',\n      'All other retained seeds, including baseline members, remain proof obligations.',\n      'Caller/adapter initialization and callback/default dispatch remain pending.',\n      'Verifier/funding/writer/recording, local/imported callees and transitive bodies remain pending.',\n      'No runtime preserved-artifact request/adoption/fence route is established by lexical option forwarding.'] },\n  guardEvidence: { newTestsRun: [], previousSevenGuards: 'Retained historical evidence in predecessor; NOT replayed or asserted as tests for this new investigation.' },\n  effects: 'Static reads only. No endpoint/launcher import or native/provider/fullcopy execution; no fullR, custody equivalence, budget, host/home/control or shipment admission.',\n  instrument: { path: '.papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.mjs',\n    sha256: sha(readFileSync('.papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.mjs')) },\n}, null, 2));\n"
  },
  "limitations": [
    "This archives the already completed 2026-10-24T20:10:52.651Z traversal; no traversal replay.",
    "Installed external target was obtained by createRequire.resolve (CommonJS resolution), not observed runtime import selection. External implementation and initialization remain UNKNOWN.",
    "No full source closure, full reported lock receipt, independent-method/custody approval, budget/funding/home/control action or shipment acceptance."
  ]
}
