---
rel_path: "runtime-migration/p006-configured-artifact-matrix-501c.json"
updated_at: 1792797206396
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "spec": "AUTO-BAR-R-6-P-006@4",
  "plane": "source-derived-scope-only",
  "requiredScope": [
    "gui:linux-arm64",
    "gui:linux-x86_64",
    "gui:macos-arm64",
    "gui:macos-x86_64",
    "gui:windows-x86_64",
    "server:linux-arm64",
    "server:linux-x86_64",
    "server:macos-arm64",
    "server:macos-x86_64",
    "server:windows-x86_64"
  ],
  "sources": [
    {
      "path": "papercusp-desktop/bin/release.config.ts",
      "sha256": "948949f3e50c8778ccf1d31955c47533aa2b11fdffeaa4c67e3a124d14b4f4a4",
      "basis": "registerPapercuspDrivers registers Linux x86_64/arm64, Windows x86_64 and macos universal."
    },
    {
      "path": "papercusp-desktop/bin/release-local.sh",
      "sha256": "5097f0a6f4f9024d7ba21cac6307c7b24a3d9d7ef9d8678ac1dcb729b14ba681",
      "basis": "PAPERCUSP_BUILD_ROLES defaults gui server; optional Linux arm64/Windows/macOS remain configured."
    },
    {
      "path": "papercusp-desktop/bin/build-mac-cross.sh",
      "sha256": "c6d3cd0e8023a62172cba04056fdbc6a5d634bbd6c6e48a4a17620efdbc05631",
      "basis": "MAC_BUILD_TARGET universal-apple-darwin expands x86_64-apple-darwin and aarch64-apple-darwin; ROLES defaults gui server."
    },
    {
      "path": "papercusp-desktop/bin/build-windows-cross.sh",
      "sha256": "87af0e56641d2c7a66e8b4495c779f9db5c22a52f9405ff8cf97754202be0ea4",
      "basis": "Windows x86_64 producer preserves per-role identity; WSL sidecar requires Linux x64 runtime."
    }
  ],
  "coverage": {
    "population": [
      "gui:linux-arm64",
      "gui:linux-x86_64",
      "gui:macos-arm64",
      "gui:macos-x86_64",
      "gui:windows-x86_64",
      "server:linux-arm64",
      "server:linux-x86_64",
      "server:macos-arm64",
      "server:macos-x86_64",
      "server:windows-x86_64"
    ],
    "checked": [],
    "notChecked": [
      "gui:linux-arm64",
      "gui:linux-x86_64",
      "gui:macos-arm64",
      "gui:macos-x86_64",
      "gui:windows-x86_64",
      "server:linux-arm64",
      "server:linux-x86_64",
      "server:macos-arm64",
      "server:macos-x86_64",
      "server:windows-x86_64"
    ],
    "notApplicable": [],
    "residue": []
  },
  "candidateRoute": {
    "testClass": "candidate-install-upgrade",
    "path": "papercusp-desktop/src-tauri/src/wsl_setup.rs",
    "readiness": "gap",
    "isolation": "Candidate install target and previous version must be explicitly owned.",
    "prerequisites": [
      "Target platform",
      "signing/install credentials",
      "rollback target"
    ],
    "verification": "Exact package hash, install/upgrade result and rollback receipt."
  },
  "perCellRequired": [
    "installer/artifact hashes",
    "dependency generation",
    "runtime binary digest/version",
    "actual process PID/runtime",
    "registered isolated candidate runtime",
    "offline clean install",
    "offline upgrade",
    "offline restart",
    "offline Node rollback",
    "host runtime PATH absent/poisoned"
  ],
  "acceptance": false,
  "limits": [
    "This freezes scope from current source and R-6; it supplies no installed execution proof.",
    "Linux Docker rootfs and Windows cargo check are preparations only.",
    "Aggregate missing/duplicate/substituted receipt rejection detector and per-cell runtime bindings still required.",
    "Node stays active until full independent acceptance."
  ]
}
