---
rel_path: "evidence/wi28995-bound-store-local-proof-20261025-v1.json"
updated_at: 1792961568276
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028995",
  "scope": "local-source-preparation-only",
  "sources": [
    {
      "path": "scripts/lib/source-path-census.mjs",
      "sha256": "0180871d466de9c261d7e35bff1c95c53314728b493b6beac8a845441011f604"
    },
    {
      "path": "scripts/lib/source-path-census.d.mts",
      "sha256": "ebac10ba3355b2d918171e93805f20baba0c8e8cd686b98d870eae252cac2d93"
    },
    {
      "path": "scripts/source-path-census.test.ts",
      "sha256": "e5c616e26afff82bf010c888316ef3d7f076f0d458ff62d0a0c3e6898d63b377"
    },
    {
      "path": "packages/operator-core/lib/text-artifacts.ts",
      "sha256": "5b5fa06fc15fba9bc543c72067dc7ff77eb37d6f578ccaa55a230c7ffea840ae"
    },
    {
      "path": "packages/operator-core/lib/text-artifacts.integration.test.ts",
      "sha256": "655afc3a2ddacb4a7a0f3ab894764c04e9917946da3e351deba55a002952d27d"
    }
  ],
  "logs": [
    {
      "path": "/tmp/wi28995-bound-store-tests-final.log",
      "sha256": "c849682e040cc2dfe8e5637cef6355604579f950a96bd890f3e08abfe3ddaf95",
      "resultLines": [
        "      Tests  40 passed (40)",
        "      Tests  15 passed (15)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=04d1673643 uncommittedPaths=2/2 provenance=stamped startedAt=2026-10-25T20:46:30.229Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/wi28995-bound-store-scripts-types.log",
      "sha256": "d950f6089ef97b70503e5e4f8b9374534bcb4e4b79603c8456eef33432693370",
      "resultLines": [
        "LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-10-25T20:47:38.830Z head=04d1673643"
      ]
    },
    {
      "path": "/tmp/wi28995-bound-store-core-types.log",
      "sha256": "6da9cc81f523268f6f380ce6ae05ee7e1c2d30de80f6e837ad9ab3f3bf51c6ff",
      "resultLines": [
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-25T20:47:38.831Z head=04d1673643"
      ]
    }
  ],
  "invariants": [
    "PG-canonical compare-and-swap; no new table or store",
    "durable terminal pre-read refusal across reopen",
    "stale original writer cannot overwrite recovered STOPPED",
    "real read-only descriptor and immutable root/candidate/input-digest binding",
    "conservative outputs: receipt false; executionAdmitted false"
  ],
  "unverified": [
    "independent METHOD/conformance verdict",
    "actual production candidate/toolchain/runtime/custody bindings",
    "ceiling increase or census activation",
    "historical raw custody",
    "original native/current-integration/host/control and shipment acceptance"
  ]
}
