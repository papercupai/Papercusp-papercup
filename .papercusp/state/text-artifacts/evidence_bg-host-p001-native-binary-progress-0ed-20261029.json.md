---
rel_path: "evidence/bg-host-p001-native-binary-progress-0ed-20261029.json"
updated_at: 1793237029551
_body: "content"
---

{
  "schemaVersion": "bg-host-p001-native-binary-progress-v1",
  "status": "INCOMPLETE_NOT_ACCEPTED",
  "workItem": "WI-6554700010028547",
  "runtimeItem": "EI-26786086942955007",
  "plan": "bg-host-committed-generation-2026-10-24",
  "scope": "Supplemental source implementation and failed/partial verification. No P001, full recipe, native service, BAR census or Luna shipment acceptance.",
  "commit": "0ed708a3a7da469c8e8ae10a2112bfbe769b7380",
  "files": [
    {
      "path": "scripts/source-preview.mjs",
      "committedSha256": "f131ea66a0e549061325f9df1b984539ebc32b32a618070195f3902b804a1dda"
    },
    {
      "path": "scripts/source-preview.d.mts",
      "committedSha256": "72f7a7730430f25581ba43943a0b687210e556adc87b4ebfc31ab52856d4a212"
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "committedSha256": "1efe72c8c0fd94fa301766825c78c3adc3ccd87300d75504005d344c349da190"
    },
    {
      "path": "packages/operator-core/lib/blind-review-source-seal.ts",
      "committedSha256": "6ba330fb7515f01519844c9bfdfb887f4cf26c6dabee554e7640299f9f719667"
    },
    {
      "path": "packages/operator-core/lib/blind-review-source-seal.test.ts",
      "committedSha256": "be6f2f62734761754e814ddbb6953eef21503b6abbfdaacb10da1e3db9e1374a"
    },
    {
      "path": "scripts/lib/blind-review-sealed-source.py",
      "committedSha256": "cf1ff05ae9614c6fd5a9589f9d6fb91a1e6b3165faa1601579b491e4982da8b1"
    },
    {
      "path": "apps/operator/bin/release/dependency-generation.sh",
      "committedSha256": "6b840b18ec9313c6f11db71b3220793fef032d37e0d0ff9af0aef6c4c23b30ec"
    }
  ],
  "logs": [
    {
      "path": "/tmp/bg-p001-native-binary-local-20261029.log",
      "sha256": "108f3fd9c9ddbcc9a925966784aff979e38dc4a4c9a97a55030492cb4fdf662d"
    },
    {
      "path": "/tmp/bg-p001-native-binary-diagnostic-20261029.log",
      "sha256": "87426053e0756079d14a96b8954d5194b0175852ea90eccbb14886f239012de6"
    },
    {
      "path": "/tmp/bg-p001-native-binary-final-local-20261029.log",
      "sha256": "f68f2d274cff7e0db9158c8d9eddfebfddee17aca1f32afe44559de65d7a22c7"
    },
    {
      "path": "/tmp/bg-p001-native-binary-cli-local-20261029.log",
      "sha256": "b8023eadad3cff34337a3c688f0935979c64ace545839a41ed4b78f053f0dfc9"
    },
    {
      "path": "/tmp/bg-p001-native-binary-recipe-local-20261029.log",
      "sha256": "7a7600c6d15e49dff38783763cd450e299ee9b7a9411fbf50e08b67e81b74df0"
    },
    {
      "path": "/tmp/bg-p001-native-binary-immutable-fd2-20261029.log",
      "sha256": "55a8841e64af5479a783c2dd0dd731d2fa3c6cbbe720a60afccbb8d4cdb9a6f8"
    },
    {
      "path": "/tmp/bg-p001-native-binary-immutable-0ed-20261029.log",
      "sha256": "d459d6b2a76b05581aef571261885ec77c0d058c4befaba984c1fe7f86755e14"
    },
    {
      "path": "/tmp/bg-p001-native-binary-final-fixture-types-20261029.log",
      "sha256": "e5e946f4e20338ada078126952634d97699d94a5befa223dc056b0c9881c5e47"
    },
    {
      "path": "/tmp/bg-p001-native-binary-declaration-check-20261029.log",
      "sha256": "9ca011d4d7af1429eec1fb320684bf37c0630630f9c9d8662160122214159c9f"
    }
  ],
  "keptRoots": {
    "fd2": "/tmp/pcv/papercusp-lint-as-committed-fd2c02a922-Lm04wI",
    "current": "/tmp/pcv/papercusp-lint-as-committed-0ed708a3a7-Pv1TDN"
  },
  "implementation": [
    "compileBgVerifierInvocation reuses sealRuntimeSourceHandle and binds esbuild child_process.spawn to inherited sealed FD3; validates original binary pathname, exact --service version/--ping, stdio, shell prohibition, single launch and original environment.",
    "compilerBinary receipt retains sealed kernel identity and digest; descriptor closes after compiler stop.",
    "Maintained before-seal and after-seal binary substitution no-effect controls; ordinary real compiler control checks execution receipt.",
    "Sealing helper uses package self-export for module-repo-root so plain Node and declaration generation both work.",
    "Test binary equality uses native Buffer.equals; unused duplicate nested platform fallback omitted from hermetic fixture."
  ],
  "verification": {
    "local": {
      "canonicalPassRun": 22587504,
      "selectedCases": 5,
      "provenance": "dirty shared tree, not committed acceptance"
    },
    "priorImmutable": {
      "commit": "fd2c02a922c9a6527a7b2e58bf0e203ac8f2539e",
      "run": 22589097,
      "pass": 5,
      "fail": 2,
      "cause": "Plain Node could not resolve sealing helper extensionless import; fixed in later helper."
    },
    "currentImmutable": {
      "sourceRuns": [
        {
          "id": 22590716,
          "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
          "status": "fail",
          "commitSha": "0ed708a3a7da469c8e8ae10a2112bfbe769b7380",
          "worktreeDirty": false,
          "durationMs": 42861
        }
      ],
      "helperRuns": [
        {
          "id": 22590718,
          "filePath": "packages/operator-core/lib/blind-review-source-seal.test.ts",
          "status": "pass",
          "commitSha": "0ed708a3a7da469c8e8ae10a2112bfbe769b7380",
          "worktreeDirty": false,
          "durationMs": 347
        }
      ],
      "pass": 5,
      "fail": 4,
      "cause": "dependency-generation.sh now invokes Node; sanitized compiler PATH cannot find ambient node. After-seal negative also encounters this earlier census error instead of its expected refusal."
    },
    "localComposition": {
      "sourceRun": 22590603,
      "helperRun": 22590604,
      "recipeRun": 22590645,
      "recipeStatus": "TIMEOUT60s; every assertion and replay completed but test remained red. Removing duplicate binary did not resolve budget failure."
    },
    "types": {
      "nodeSyntax": "pass",
      "declarationCheck": "pass",
      "namedHelperAndTest": "18691 EXIT0",
      "latestNamedTest": "15935 EXIT0; service checked1/errors0; JS syntax plus generated declaration only"
    },
    "mutation": {
      "status": "NOT_RUN",
      "plannedTarget": "scripts/source-preview.mjs",
      "plannedBypass": "Replace only return spawn('/proc/self/fd/3', args, { ...spawnOptions, with return spawn(binary.realpath, args, { ...spawnOptions,",
      "controls": "ordinary real compiler positive must remain PASS; after-seal substitution must fail sentinel no-effect assertion; require parse ok, overlay containment and unchanged tree."
    }
  },
  "diagnostic": {
    "testBufferTraversal": "First local22584276 and diagnostic22587484 timed out after successful build/cleanup; native Buffer.equals reduced restoration checks to14/24ms. Diagnostic seal241ms/build77ms/verify refusal900ms/stop1ms.",
    "recipePhasesMs": {
      "output": 8193,
      "logical": 11632,
      "publish": 5806,
      "verify": 4323,
      "seal": [
        432,
        499
      ],
      "build": [
        53,
        49
      ]
    },
    "nodeCensus": {
      "helperOption": "DEPENDENCY_GENERATION_NODE",
      "proposed": "captureVerifierDependencies env must bind existing selector to process.execPath; add shadow PATH/inherited override no-effect control.",
      "applied": false,
      "reason": "Both source and test held by peer ebe9 for EI-27267673632472358. Lock request refused; apply_patch blocked; no writes occurred. Peer acknowledged evidence and will read before next edit."
    }
  },
  "peer": {
    "owner": "su-ebe9b9b1-f43d-4eb4-839d-e281da578e4b",
    "item": "EI-27267673632472358",
    "askMsgId": "coord-send-4a5840d5c74b25ae3b6113af600ccb8eea418795db7d155bbf8026a3c828680a",
    "pickup": "explicit ACK received in coord injection",
    "awaitId": 386284,
    "event": "work-item:done:EI-27267673632472358",
    "timeoutSec": 300,
    "scopeReply": "Peer explicitly confirmed EI-27267673632472358 will pin DEPENDENCY_GENERATION_NODE to process.execPath in both sync and managed census, with shadow-PATH/override regressions. Implementation still in progress; no completion or passing proof claimed."
  },
  "constraints": [
    "Claim cap2; self route; no implementation workers; no LIVE_GATE_OPS.",
    "Original sole-producer qualified parent/source/artifact/boot packet remains UNKNOWN; no actual preparation or activation.",
    "Luna NOT SHIPPED; no old successful proof replay for reconstruction.",
    "All own test/gen/type/probe/CLI handles terminal; no native mutant launched; all own manual edit leases released."
  ],
  "next": "Consume peer census fix/checkpoint and exact release/commit references. Confirm pinned actual Node and shadow executable regression. Run isolated current native+CLI/helper proof, then single native spawn-path bypass mutant with ordinary positive. Recipe latency remains owned P001 work. Preserve existing parent/runtime fences.",
  "incidental": {
    "gitSyncLatency": "EI-27274382588064144; unclaimed/likely duplicate annotated by capture. Worker run held_exclusive then local commit0ed arrived; no restart/takeover.",
    "launcher": "Ended; human update delivered coord-send-1436f3cfce5ca6e6e4844ed06f3c38fb554e07f02ce35c40b6a6e83ec8be42da."
  }
}
