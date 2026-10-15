---
rel_path: "audits/held-agent-resumption-2026-10-12/hydration-adoption-qualification-2026-10-13.json"
updated_at: 1791926795504
_body: "content"
---

{
  "observedAt": "2026-10-13T21:20:07.374Z",
  "sourceHash": "7d6b8ba21051ba4fdafe6ee266f68371b162c8112ef0510e8c12e069a3ab1a41",
  "testHash": "2f29be7c74c228189cf8953dd21bae7f48ce228306d18e97787833a0b8245871",
  "pipeline": {
    "input": {
      "path": "packages/operator-core/lib/harness-state/git-export/hydrate.ts"
    },
    "dirtyUncommitted": false,
    "servingRuntimes": [
      {
        "runtime": "release-operator",
        "role": "owner",
        "buildSha": "d740fc3802",
        "buildShaSource": "health",
        "containsChange": false,
        "method": "blob",
        "instances": null,
        "unknownReason": null
      },
      {
        "runtime": "staging-operator",
        "role": "owner",
        "buildSha": "78cd58273a",
        "buildShaSource": "health",
        "containsChange": false,
        "method": "blob",
        "instances": null,
        "unknownReason": null
      },
      {
        "runtime": "bg-host",
        "role": "shared",
        "buildSha": "de3c697ace",
        "buildShaSource": "runtime-vintage",
        "containsChange": true,
        "method": "blob",
        "instances": null,
        "unknownReason": null
      },
      {
        "runtime": "gateway",
        "role": "shared",
        "buildSha": null,
        "buildShaSource": null,
        "containsChange": true,
        "method": "start-after-mtime",
        "instances": null,
        "unknownReason": null
      }
    ],
    "currentBuildTestRoute": {
      "id": "background-federation",
      "source": "canonical tree loaded by bg-host, not the :3170 API bundle",
      "runtime": "bg-host",
      "route": "node scripts/with-test-pg.mjs --isolated-runtime -- <current-build background assertion>",
      "routeFile": "scripts/with-test-pg.mjs",
      "isolation": "Disposable migrated DB, HOME/device keychain, workspace and ports; runtime credentials stripped.",
      "prerequisites": [
        "Current-build background command",
        "local embedded PG and migration assets",
        "explicit teardown assertion"
      ],
      "verification": "Actual child environment and build identity, background behavior, private-state write and cleanup receipt.",
      "readiness": "requires-prerequisites"
    },
    "nextAction": "Do NOT cut a fresh candidate — a frozen repair queue is live on candidate 4a0ab75652bd (ready-to-verify, decision 'verify-repair') and its phase (ready-to-ve…[truncated +242 chars]"
  },
  "testResult": "16 passed, 0 skipped, exit 0; retained checkpoint evidence with matching current hashes",
  "limits": [
    "Exact historical importer is unmeasured.",
    "Final release promotion is not established.",
    "Pickup receipts do not establish technical task completion."
  ]
}
