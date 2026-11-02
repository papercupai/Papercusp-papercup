---
rel_path: "runtime-migration/p006-baseline-transformers-compat-repair-0dcd3-20261102.json"
updated_at: 1793612088767
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-27667546316289046",
  "rootCause": "The onnxruntime-node closure invokes native-target validation for every build, but early Transformers manifest/lock checks previously ran only for vm-release or explicit pinned verification. Frozen audited d740 declares ^4.2.0 even though its contract, lock resolution and installed package are exactly4.2.0; late new literal policy stopped the full build.",
  "repair": "Audited source cuts now run lock and installed/native preflight before bundling. Independent frozen source may retain ^<expected> only under explicit frozen-lock helper policy; all lock versions, source/lock declaration equality, installed version/topology and target native bytes remain checked. Current source default stays exact.",
  "filesChanged": [
    "papercusp-desktop/bin/lib/transformers-models.sh",
    "papercusp-desktop/bin/build-desktop-sidecar.sh",
    "papercusp-desktop/bin/lib/host-runtime-closure.sh",
    "papercusp-desktop/test/transformers-models-fetch.test.js",
    "papercusp-desktop/test/build-desktop-sidecar-workspace-install.test.js"
  ],
  "tests": {
    "command": "node --test --test-global-setup=test/monorepo-host-preflight.mjs test/transformers-models-fetch.test.js test/build-desktop-sidecar-workspace-install.test.js test/build-desktop-sidecar-native-abi.test.js",
    "cwd": "papercusp-desktop",
    "passed": 110,
    "failed": 0,
    "skipped": 0,
    "exitCode": 0,
    "log": "/tmp/0dcd3-transformers-compat-tests-final.log",
    "logSha256": "ef90c8b398fc9bedeedf60cf85e5297073fab141376245ba6448774be00045e0"
  },
  "actualBaseline": {
    "source": "d740fc3802877d1c8c3b1068768681ee32ef0025",
    "desktop": "c864f7a1d1b62721a21dc8b0a576d51ff4edb345",
    "checks": [
      "manifest/root-lock contract passed under frozen-lock",
      "installed transformers4.2.0 resolution passed for apps/operator and packages/operator-core",
      "linux-x64 ONNX binding/library identity preflight passed"
    ],
    "sourceUnmodified": true,
    "failedFullBuild": "0mvz1lcnp1pqabqhagw",
    "failedStage": "/home/marsh-office/.local/state/papercusp/sidecar-failed-stages/17d956538e116c2e9c8357a4/sidecar.failed-stage.456957"
  },
  "guards": [
    "default exact policy rejects caret",
    "frozen-lock still rejects wrong lock version",
    "frozen-lock rejects source/lock declaration mismatch",
    "frozen-lock rejects wrong installed version",
    "native preflight remains before SPA/model assembly"
  ],
  "limits": "Compatibility preflight repair only; full baseline build and installed model inference remain unmeasured."
}
