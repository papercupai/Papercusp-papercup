---
rel_path: "runtime-migration/p006-node-producer-redgreen-501c.json"
updated_at: 1792797685555
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022072",
  "item": "P-006",
  "plane": "local-source-only",
  "rootCause": "Normal sidecar producer treated a failed retained-Node download or extraction as a warning, then continued with host Node fallback. A zero-byte cache file was also eligible.",
  "changes": [
    "Download and missing extracted Node now fail the build.",
    "Missing/empty packaged Node cannot pass.",
    "Empty cached Node is ignored.",
    "Windows ZIP flattening requires a nonempty inner directory before globbing."
  ],
  "red": {
    "nativeExit": 1,
    "pass": 0,
    "fail": 5,
    "skip": 0,
    "log": "/tmp/bun-p006-node-producer-red-501c.log",
    "observations": "Three OS download controls and Linux/macOS empty-extraction controls returned success before repair."
  },
  "green": {
    "nativeExit": 0,
    "pass": 35,
    "fail": 0,
    "skip": 0,
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp node --test --test-global-setup=test/monorepo-host-preflight.mjs test/bun-runtime-inputs.test.js",
    "cwd": "papercusp-desktop",
    "log": "/tmp/bun-p006-node-producer-final-501c.log",
    "scope": "Existing Bun input/archive/version/security controls plus genuine maintained Node shell section under download/extraction/cache stand-ins; no Windows or macOS runtime execution."
  },
  "hashes": {
    "papercusp-desktop/bin/build-desktop-sidecar.sh": "ab5fa1ece176d2b7e96f3a0cca7f5866df5fc83da283bf183efb9cc3c25aa1ab",
    "papercusp-desktop/test/bun-runtime-inputs.test.js": "d0817a2d819325ea15ae57e8649283562ccbdc43c58780b1ce4572426a653e4e",
    "/tmp/bun-p006-node-producer-red-501c.log": "a444e94650b8bbf7c3ca7c34560a3dd3c0c812434b79ce457d21444899330a86",
    "/tmp/bun-p006-node-producer-final-501c.log": "056b8f84e9f211fdbd3f57524fe91f452151d5c9da313067cc5a556897d9ab60"
  },
  "syntax": "bash -n producer and two-path git diff --check passed",
  "limits": [
    "Nonempty cached Node identity/digest pinning remains open P006 work.",
    "Whole sidecar production and installed platform acceptance remain open.",
    "Node remains active; no cutover or shipment."
  ]
}
