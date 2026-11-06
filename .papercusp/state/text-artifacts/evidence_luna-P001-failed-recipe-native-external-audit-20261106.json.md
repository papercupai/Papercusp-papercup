---
rel_path: "evidence/luna-P001-failed-recipe-native-external-audit-20261106.json"
updated_at: 1793938252511
_body: "content"
---

{
  "schemaVersion": "luna-bg-generation-failed-recipe-audit-v1",
  "workItemId": "WI-6554700010028547",
  "taskId": "0mw4f12m7f3lbic1sqi",
  "terminal": {
    "schemaVersion": "luna-bg-build-attempt-v1",
    "status": "failed",
    "startedAtMs": 1793935161015,
    "completedAtMs": 1793937208808,
    "deadlineEpochMs": 1793949556845,
    "error": "Error: Build failed with 6 errors:\n../../../../home/marsh-office/papercupai-workspace/papercusp/scripts/source-preview.mjs:1193:13: ERROR: [plugin: bg-original-input-custody] BG compiler input loader is UNKNOWN: node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node\n../../../../home/marsh-office/papercupai-workspace/papercusp/scripts/source-preview.mjs:1193:13: ERROR: [plugin: bg-original-input-custody] BG compiler input loader is UNKNOWN: node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node\n../../../../home/marsh-office/papercupai-workspace/papercusp/scripts/source-preview.mjs:1193:13: ERROR: [plugin: bg-original-input-custody] BG compiler input loader is UNKNOWN: node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node\n../../../../home/marsh-office/papercupai-workspace/papercusp/scripts/source-preview.mjs:1193:13: ERROR: [plugin: bg-original-input-custody] BG compiler input loader is UNKNOWN: node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node\n../../../../home/marsh-office/papercupai-workspace/papercusp/scripts/source-preview.mjs:1193:13: ERROR: [plugin: bg-original-input-custody] BG compiler input loader is UNKNOWN: node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node\n...\n    at failureErrorWithLog (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:1477:15)\n    at /mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:946:25\n    at runOnEndCallbacks (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:1317:45)\n    at buildResponseToResult (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:944:7)\n    at /mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:971:16\n    at responseCallbacks.<computed> (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:623:9)\n    at handleIncomingPacket (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:678:12)\n    at Socket.readFromStdout (/mnt/data/tmp/luna-bg-source-20261106-v1/node_modules/@papercusp/host-esbuild/lib/main.js:601:7)\n    at Socket.emit (node:events:509:20)\n    at addChunk (node:internal/streams/readable:564:12)"
  },
  "transactionSha256": "6111b2f2ca7d04ad729aa2c493881cdf4a6f3dab8e43e3e31e05f2aad336f054",
  "selectedBuilderSha256": "e3701858ca31554452c93d34e8515da24b2386d8418421ae9b83ef6814091208",
  "selectedCommonSha256": "481763207ad4fe63b6f95c1682838741622685e3bf98a5b718bfde34c2421da0",
  "selectedNativePackages": [
    "sodium-native",
    "udx-native",
    "rocksdb-native",
    "quickbit-native",
    "rabin-native",
    "simdle-native",
    "fs-native-extensions",
    "bare-fs",
    "bare-os",
    "bare-url",
    "bare-inspect",
    "bare-type",
    "better-sqlite3",
    "ssh2",
    "onnxruntime-node",
    "onnxruntime-web",
    "@huggingface/transformers",
    "sharp",
    "esbuild",
    "playwright-core"
  ],
  "missingNativeExternals": [
    "sodium-native",
    "udx-native",
    "rocksdb-native",
    "quickbit-native",
    "rabin-native",
    "simdle-native",
    "fs-native-extensions",
    "bare-fs",
    "bare-os",
    "bare-url",
    "bare-inspect",
    "bare-type",
    "better-sqlite3",
    "ssh2",
    "onnxruntime-node",
    "onnxruntime-web",
    "@huggingface/transformers",
    "sharp",
    "esbuild",
    "playwright-core"
  ],
  "rootCause": "Caller captured common externals but omitted the selected builder native-package additions and runtime-resolved additions. Maintained custody correctly refused native .node inputs.",
  "auditBeforeNextExpensiveAttempt": {
    "failures": [
      {
        "taskId": "0mw4eo9yk34u66ssme6",
        "class": "Caller mutates frozen expanded asset array; corrected by cloning array and retaining first failure."
      },
      {
        "taskId": "0mw4f12m7f3lbic1sqi",
        "class": "Caller recreates incomplete selected builder argv; selected NATIVE_PKGS native external contract omitted."
      }
    ],
    "requiredPreflight": "Extract complete HOST_EXTERNALS and worker/spawner argument contracts from the retained selected builder/common bytes; check all required native/runtime exclusions in every proposed invocation before original transaction nomination. Preserve original failed transaction and deadline; do not weaken custody or regenerate original source/dependency receipts."
  },
  "logPath": ".papercusp/scratch/bash-9408fd0f-5d5.log",
  "logSha256": "f9f63b7c11736970ea51ec2a727d9d78da3bf6308e279ff6d8d7a0bc93192186",
  "missingTerminalEventItem": "EI-28010107776377123",
  "lunaShipped": false
}
