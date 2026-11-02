---
rel_path: "runtime-migration/p006-baseline-playwright-repair-0dcd3-20261102.json"
updated_at: 1793608623278
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "source-compatibility-repair",
  "workItem": "EI-27663815703830135",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "scope": "Producer Playwright external package-copy compatibility; no installed/runtime/native acceptance.",
  "rootCause": "Current producer imported an older frozen product NATIVE_PKGS list without playwright-core, then required that newly introduced invariant instead of extending its own package-copy inputs.",
  "repair": "Append missing playwright-core to the producer-local array; retain installed-loader validation and preserve frozen helper bytes.",
  "baseline": {
    "source": "d740fc3802877d1c8c3b1068768681ee32ef0025",
    "desktop": "c864f7a1d1b62721a21dc8b0a576d51ff4edb345",
    "failedTask": "0mvyznrt41ptzbulugt",
    "exit": 1,
    "rerunTask": "0mvyzxzik72i6cf7g5z",
    "measuredMarkers": [
      "preserving Playwright external package-copy boundary for older target helper",
      "PLAYWRIGHT_RUNTIME_PREFLIGHT_OK"
    ],
    "trackedStatus": "clean after successful repaired preflight",
    "rerunResult": {
      "exit": 1,
      "at": "2026-11-02T08:30:50Z",
      "reason": "Later current checker helper missing in frozen desktop target; separate owned EI-27664259679585995."
    }
  },
  "test": {
    "runId": "5f64a554-1bde-4184-8b34-36b67b90947b",
    "testRunIds": [
      22969119
    ],
    "passed": 1,
    "failed": 0,
    "outsidePattern": 14,
    "commandExit": 0,
    "signal": null,
    "captureComplete": true,
    "manifest": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-t5asPo/manifest.json",
    "nativeCustody": "unqualified; focused source test only",
    "scenarios": [
      "current helper succeeds",
      "legacy helper gains exactly one copied Playwright and retains sharp",
      "legacy helper bytes unchanged",
      "missing physical package still refuses"
    ]
  },
  "files": {
    "papercusp-desktop/bin/build-desktop-sidecar.sh": {
      "sha256": "f443dba82c14a31ac3c89283989e224c13298648d46c305d8f9a50d4ea06b324",
      "bytes": 330307
    },
    "packages/operator-core/lib/host-bundle-runtime-externals.test.ts": {
      "sha256": "e3f96ca8838fbd9a9c690e82fccda69380e0899f66af9d044345cdf64ede7841",
      "bytes": 12955
    },
    ".papercusp/scratch/bash-975500eb-4d8.log": {
      "sha256": "43620178eac630c7bed33b5fdcfc23c329a8094bf4bbf6a75b70bca241fc94ba",
      "bytes": 3308
    },
    ".papercusp/scratch/bash-244f91bf-c05.log": {
      "sha256": "ec3a8b6695a97d758c0634f457e4ba5c8c3befd406cf9580dae080320127a5da",
      "bytes": 106352,
      "scope": "prefix snapshot before terminal; not the final log digest"
    }
  },
  "limits": [
    "Live rerun log hash is a timestamped snapshot and will change.",
    "Baseline full producer failed at separate helper-path issue EI-27664259679585995; package acceptance remains open.",
    "All installed-platform/native/BAR/shipment obligations remain open."
  ]
}
