---
rel_path: "security/p002-isolated-refusals-and-p003-preparation-20261106.json"
updated_at: 1793925355381
_body: "content"
---

{
  "schemaVersion": 1,
  "status": "DEVELOPMENT_PROOF_NOT_SECURITY_ACCEPTANCE",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItems": [
    "WI-6554700010044290",
    "WI-6554700010044292"
  ],
  "baselineDraft": "security/acceptance-methods-detector-gaps-20261106T0016Z.json",
  "test": {
    "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
    "sha256": "5781970c71322d2e09ac73835dd692f5a92dc75fedb083caf59a48d398ca9e19",
    "selector": "isolates %s refusal between authorized filesystem effects",
    "variants": [
      "grant-read",
      "allowlist",
      "expiry",
      "policy-read"
    ],
    "controls": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
    "limitation": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
    "runId": "41bb0a5f-40c5-4872-a19e-8878d35333ab",
    "originRunId": "a14adbc7-ab94-47da-82fc-e2434fb9292f",
    "status": "pass",
    "exitCode": 0,
    "passed": 16,
    "failed": 0,
    "pending": 0,
    "todo": 0,
    "reportPath": "/home/marsh-office/.papercusp/test-artifacts/testing-run/detached-recovery/run-2bcc44d8ea4f36b7a0707711/report-4f69ec36948e0bfb186d7c2a/reports/papercusp-testing-run-detached-555b845e-f35d-41b0-a160-9c4d3927310d.json",
    "reportSha256": "07c3d9f86503084a7290192f04fbfe9194ca08a3228538507ffdf4407712e235",
    "reportHashVerified": true,
    "snapshotRead": "/tmp/security-p002-isolated-refusals-status2-20261106.json"
  },
  "typecheck": {
    "log": "/tmp/security-p002-isolated-refusals-types-20261106.log",
    "scope": "named changed file and resolved importers",
    "status": "clean",
    "exitCode": 0,
    "terminalNativeSession": 95194
  },
  "r2Preparation": {
    "workItem": "WI-6554700010044292",
    "claim": "self",
    "state": "blocked",
    "needsDesign": true,
    "sourceCheckpoint": "7651b8bc1481",
    "sources": [
      "libs/generic/plugin-loader/src/loader.ts",
      "packages/plugin-loader/src/index.ts",
      "packages/plugin-loader/src/daemon/supervisor.ts",
      "packages/plugin-loader/src/daemon/bwrap-args.ts",
      "packages/operator-core/lib/plugin-host-runtime.ts"
    ],
    "facts": [
      "Generic admission precedes runtimeDispatch and entry import; reuse these ports.",
      "Ordinary JS import uses in-host createRequire.",
      "Provider mode always spawns via fixed bwrap even after an inconclusive probe; completed probe failure refuses.",
      "Legacy ordinary daemon mode has plain-spawn fallback.",
      "initializeDaemonPlugin does not select provider mode for ordinary action daemons."
    ],
    "notMeasured": [
      "All-runtime/platform earliest-load containment",
      "Raw direct/transitive file/socket/network/exec effects",
      "Typed broker migration and normal journeys",
      "Independent frozen row population/controls/mutants",
      "Actual native macOS10.15"
    ],
    "next": "Required P003 design using existing loader and provider/supervisor seams; P002 prerequisite remains open."
  },
  "holds": [
    "Apple Developer ID Application AND Installer identities via protected setup",
    "Complete authenticated authorship",
    "Initial administrator trusted-verifier bootstrap",
    "Independent SEC and whole-population qualification",
    "Actual native macOS10.15",
    "P020 exact signed installed artifact shipment"
  ],
  "draftUpdate": "Full0036Z draft update was denied before execution. No such new draft exists; merge this verified supplement into canonical0016Z draft next.",
  "guardFailure": "Additional pre-dispatch authority lookup timeouts captured on self-owned EI-27967556594211322; root cause unconfirmed.",
  "jobs": "none",
  "fileLocks": "none"
}
