---
rel_path: "reports/admission-boundary/wi-16287-passive-registration-extension-20261021.json"
updated_at: 1792586002697
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010019137",
  "plan": "work-queue-exclusion-alarm-duplicates-2026-10-16",
  "kind": "passive-registration-extension-manifest",
  "originalFourPathManifest": "unchanged/separate",
  "headAtCapture": "ca13500624b050ffe2cef164a2b9673defe67795",
  "files": [
    {
      "path": "packages/operator-core/lib/agent-tools/harness/create.ts",
      "sha256": "4690e593ae46f185e9f424f0f75141f0c5f4b7d445afe824a2d66c494f4984f0",
      "headBlobSha256": "4690e593ae46f185e9f424f0f75141f0c5f4b7d445afe824a2d66c494f4984f0",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/harness-registry.ts",
      "sha256": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
      "headBlobSha256": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/harness/git-sync/git-sync-eligibility.ts",
      "sha256": "6da57f5496264a196d4aa393b09d90ecfe6261d09d603bedf8e11b7f8206c296",
      "headBlobSha256": "6da57f5496264a196d4aa393b09d90ecfe6261d09d603bedf8e11b7f8206c296",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/harness/git-sync/git-sync-eligibility.test.ts",
      "sha256": "5e57fa7df1dea05d6785cad020538d6a58aa375d50f2de0184bb1528bc4c75ec",
      "headBlobSha256": "5e57fa7df1dea05d6785cad020538d6a58aa375d50f2de0184bb1528bc4c75ec",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/harness/git-sync/git-sync-reconcile.test.ts",
      "sha256": "290ba0c0f8f76ced347e5f66e1fad02a76c3476ffb0598c063d0bbfba62b955d",
      "headBlobSha256": "290ba0c0f8f76ced347e5f66e1fad02a76c3476ffb0598c063d0bbfba62b955d",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/harness/__tests__/create-registration-only.integration.test.ts",
      "sha256": "25943528aad84f1d3fd93c975c7f0c85cf5efd3e9f20b5ae790627a08d416c61",
      "headBlobSha256": "25943528aad84f1d3fd93c975c7f0c85cf5efd3e9f20b5ae790627a08d416c61",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/sync/hyperbee/boot-all.ts",
      "sha256": "9a9dab8c144afce58035e53f6c0b9a85a0b068f97082099284add0be82b4592a",
      "headBlobSha256": "9a9dab8c144afce58035e53f6c0b9a85a0b068f97082099284add0be82b4592a",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/sync/hyperbee/__tests__/boot-all.test.ts",
      "sha256": "84d757a9e4d876593ff0a19dda114cade23901d3c28b4b65e51be5b6769094ed",
      "headBlobSha256": "84d757a9e4d876593ff0a19dda114cade23901d3c28b4b65e51be5b6769094ed",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/release/git-sync-stall-watchdog.ts",
      "sha256": "2e3e56a3d04d0154dfc92e070f31a2f1c4c595eda4c2afbecc8aefc949b9f50a",
      "headBlobSha256": "2e3e56a3d04d0154dfc92e070f31a2f1c4c595eda4c2afbecc8aefc949b9f50a",
      "matchesHead": true
    }
  ],
  "proofStatus": "local current tree only; test-time import graph and clean committed/shipped identity not yet qualified",
  "logs": [
    "/tmp/su6c30-p006-test-1208.log",
    "/tmp/su6c30-p006-boot-1211.log",
    "/tmp/su6c30-p006-recheck-1216.log",
    "/tmp/su6c30-p006-tsc-final-1221.log",
    "/tmp/su6c30-p006-lazy-guard-1230.log",
    "/tmp/su6c30-p006-lazy-tests-1230.log",
    "/tmp/su6c30-p006-tsc-post-lazy-1230.log"
  ],
  "capturedAt": "2026-10-21T12:33:22.109Z",
  "verification": {
    "scope": "local current tree; no committed/import-graph/shipped qualification",
    "suites": [
      "create-registration-only.integration.test.ts",
      "create-args-strict.test.ts",
      "git-sync-eligibility.test.ts",
      "git-sync-reconcile.test.ts",
      "boot-all.test.ts",
      "git-sync-stall-watchdog.test.ts"
    ],
    "result": "passed; childSubstituted=0; skippedTests=0",
    "typecheck": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-21T12:29:17.206Z",
    "toolWeight": "harness:create 1125 chars and argSchema4159 bytes within measured budgets",
    "finalEdit": "Moved execFile promisification inside the registration-only invocation, following the existing lazy pattern; repository lint passes.",
    "finalAffectedTests": "requested2/executed2/matched2/statuspassed/childSubstituted0/skippedTests0; provenance=unknown, so no clean committed-source claim."
  },
  "previousCapture": {
    "capturedAt": "2026-10-21T12:22:54.881Z",
    "headAtCapture": "27020bc2adbca07a63239f82edbdd800d1d363e7",
    "files": [
      {
        "path": "packages/operator-core/lib/agent-tools/harness/create.ts",
        "sha256": "0dbfea8bac8941c468e6aefec6fd10a3fffa803ba716e2f0bc548512a10d4cc3",
        "headBlobSha256": "eb6a4d81fa6397022d88b46a857f92894143bb09f2919dbec881216724fae1b2",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/harness-registry.ts",
        "sha256": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
        "headBlobSha256": "39d0b5bf178958624eeb66a50692cc574f4a499efc043472a26486c5126eb230",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/harness/git-sync/git-sync-eligibility.ts",
        "sha256": "6da57f5496264a196d4aa393b09d90ecfe6261d09d603bedf8e11b7f8206c296",
        "headBlobSha256": "53a894d356ee3f65648f26422678e09de78ece2bc5264839f2fd8124ef8542fc",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/harness/git-sync/git-sync-eligibility.test.ts",
        "sha256": "5e57fa7df1dea05d6785cad020538d6a58aa375d50f2de0184bb1528bc4c75ec",
        "headBlobSha256": "80218ecec2304951621448a926fcd7adfe33aa10c3c792e31a9a09043d8e61a8",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/harness/git-sync/git-sync-reconcile.test.ts",
        "sha256": "290ba0c0f8f76ced347e5f66e1fad02a76c3476ffb0598c063d0bbfba62b955d",
        "headBlobSha256": "f9caf3bb44be3cc4da17e7962288f75902cc4d2a5492d745a43981adacdff5b0",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/agent-tools/harness/__tests__/create-registration-only.integration.test.ts",
        "sha256": "25943528aad84f1d3fd93c975c7f0c85cf5efd3e9f20b5ae790627a08d416c61",
        "headBlobSha256": null,
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/sync/hyperbee/boot-all.ts",
        "sha256": "9a9dab8c144afce58035e53f6c0b9a85a0b068f97082099284add0be82b4592a",
        "headBlobSha256": "860da2f97de7bde2eedf417a1f140ab0db9bcd704e405a57fe2842c56c279dd3",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/sync/hyperbee/__tests__/boot-all.test.ts",
        "sha256": "84d757a9e4d876593ff0a19dda114cade23901d3c28b4b65e51be5b6769094ed",
        "headBlobSha256": "d4275ba04c7d7f07a21c15fa67c9281aa7bb31c851d2e4ca642a663f4d9e4441",
        "matchesHead": false
      },
      {
        "path": "packages/operator-core/lib/release/git-sync-stall-watchdog.ts",
        "sha256": "2e3e56a3d04d0154dfc92e070f31a2f1c4c595eda4c2afbecc8aefc949b9f50a",
        "headBlobSha256": "18e1fdba3aa8263be53de6436bffca5185f88ec27a44a0601d8d576607a1525f",
        "matchesHead": false
      }
    ]
  }
}
