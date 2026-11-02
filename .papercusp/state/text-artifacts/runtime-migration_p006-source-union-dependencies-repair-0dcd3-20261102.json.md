---
rel_path: "runtime-migration/p006-source-union-dependencies-repair-0dcd3-20261102.json"
updated_at: 1793612088767
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-27667965486861277",
  "rootCause": "Offline runtime eligibility added an actual @papercusp/tauri-release-kit/signature import without declaring its workspace dependency; the source-union audit also traversed a newly added dev-only tsx worker that production replaces with a bundled worker.",
  "repair": "Declare the existing workspace library in operator-core manifest and corresponding root lock entry. Extend the existing exact source-only exception list for warm-cochange worker; assert both its runtime bundled-worker selection and actual bundler input.",
  "filesChanged": [
    "packages/operator-core/package.json",
    "package-lock.json",
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
  "guards": [
    "source-union audit detects every remaining undeclared bare import",
    "source-only exception requires existing file, runtime selector and production worker bundle input"
  ],
  "limits": "Current source dependency declaration/audit repaired. No installed product or shipping claim."
}
