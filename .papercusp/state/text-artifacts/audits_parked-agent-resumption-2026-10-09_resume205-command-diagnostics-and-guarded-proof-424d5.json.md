---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume205-command-diagnostics-and-guarded-proof-424d5.json"
updated_at: 1792712787409
_body: "content"
---

{
  "schemaVersion": "resume205-command-custody-v1",
  "workItem": "EI-26709724481565713",
  "parent": "WI-6554700010008887",
  "implemented": "Extended existing GitSyncActivityMarker and injected local runGitSync runner; fire-owned ordinal IDs, parsed subcommand/cwd/start, max16 published commands with total and omitted counts, cwd1024 cap, no argv/env. Timeout snapshot captured synchronously at abort and retained through real child settlement. Peer active-phase map retained. No new read tool/service.",
  "verification": {
    "logs": {
      "red": {
        "path": "/tmp/parked-resume205-command-diagnostic-red.log",
        "sha256": "e968fe76f73d1cb95a98586adabddfbb1905fa59ddc55e4838504f6b59963ed5",
        "bytes": 124733,
        "verdictLines": [
          " Test Files  1 failed (1)",
          "      Tests  3 failed | 215 skipped (218)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=4cd0dd1264 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-22T23:36:56.366Z childSubstituted=0 skippedTests=215"
        ]
      },
      "green": {
        "path": "/tmp/parked-resume205-command-diagnostic-green.log",
        "sha256": "07983efb6dc06c4de37e32d134a3305ce5db9447662d83fd2d8583959931e9c3",
        "bytes": 27337,
        "verdictLines": [
          "TEST_FILE_PROVENANCE_HEAD_MOVED from=550707a192 to=83e9cb90d6; the named test paths did not change, but their imported source/change radius was not measured. Result provenance is UNKNOWN. Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence; if absent, arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name> and PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter). Do not repeat shallow runs solely waiting for settled HEAD or attach the current HEAD retroactively. Captured evidence has its own measured scope and does not stamp a commit.",
          " Test Files  1 passed (1)",
          "      Tests  218 passed (218)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=550707a192 uncommittedPaths=1/1 provenance=unknown startedAt=2026-10-22T23:39:11.191Z childSubstituted=0 skippedTests=0"
        ]
      },
      "boundary": {
        "path": "/tmp/parked-resume205-command-diagnostic-boundary.log",
        "sha256": "722d5b035c3d3b233ca3a99a8092a44e22ec5cb57a17729d748a265890631227",
        "bytes": 98575,
        "verdictLines": [
          " Test Files  1 passed (1)",
          "      Tests  5 passed | 215 skipped (220)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=c7a5020128 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-22T23:41:51.229Z childSubstituted=0 skippedTests=215"
        ]
      }
    },
    "executedSourceMap": {
      "path": "/tmp/parked-resume205-command-diagnostic-source-map.json",
      "sha256": "7f5df97700a2a1dfc6bdc0276ea96d73408e136b07938463fdca72694d834d51",
      "workerSourceStatus": "stable",
      "workerSourceCount": 1440,
      "recordedSha": "c7a502012804bd65fba3283f0e6a23c4ff38451f",
      "worktreeDirty": true,
      "sourceCustody": [
        {
          "path": "packages/operator-core/lib/fleet/sidecar-read-only-git.ts",
          "sha256": "a68db1a79ef15d6432d62ea8637a25e9873fe07e0ddc579a5ed1e224c08bf40c",
          "basis": "vite-pre-transform",
          "currentSha256": "a68db1a79ef15d6432d62ea8637a25e9873fe07e0ddc579a5ed1e224c08bf40c",
          "workingSha256": "a68db1a79ef15d6432d62ea8637a25e9873fe07e0ddc579a5ed1e224c08bf40c",
          "headSha256": "a68db1a79ef15d6432d62ea8637a25e9873fe07e0ddc579a5ed1e224c08bf40c"
        },
        {
          "path": "packages/operator-core/lib/harness/git-sync/git-sync-action.test.ts",
          "sha256": "af03a754e237a68a19358c4400d179ee4786b49fad796df9d3ee0bd8ee499ddb",
          "basis": "vite-pre-transform",
          "currentSha256": "af03a754e237a68a19358c4400d179ee4786b49fad796df9d3ee0bd8ee499ddb",
          "workingSha256": "af03a754e237a68a19358c4400d179ee4786b49fad796df9d3ee0bd8ee499ddb",
          "headSha256": "03eecbb0df6de66d2cf4496d6dc18f85a121bddffacf6c6f241173b7e398606c"
        },
        {
          "path": "packages/operator-core/lib/harness/git-sync/git-sync-action.ts",
          "sha256": "7f714f91ff783b25dac34cffe637abfb9de37aa87ed31ae18c0b42385c9725d5",
          "basis": "vite-pre-transform",
          "currentSha256": "7f714f91ff783b25dac34cffe637abfb9de37aa87ed31ae18c0b42385c9725d5",
          "workingSha256": "7f714f91ff783b25dac34cffe637abfb9de37aa87ed31ae18c0b42385c9725d5",
          "headSha256": "576c24302ac03968178a1860532f9deea652082eb288c5ed9657632d73d06bd9"
        }
      ]
    },
    "native": {
      "passed": 5,
      "failed": 0,
      "skipped": 215,
      "collectionFailed": false,
      "passedCaseTitles": [
        "P-009/P-006 lock discipline (per-slug resources) > retains repository leases and heartbeat until an aborted Git child settles (resolve)",
        "P-009/P-006 lock discipline (per-slug resources) > retains repository leases and heartbeat until an aborted Git child settles (reject)",
        "P-009/P-006 lock discipline (per-slug resources) > captures command custody before a cooperative child settles on abort (idle)",
        "P-009/P-006 lock discipline (per-slug resources) > captures command custody before a cooperative child settles on abort (hard)",
        "P-009/P-006 lock discipline (per-slug resources) > bounds concurrent command diagnostics, omits private argv, and clears settled commands"
      ]
    }
  },
  "limits": [
    "218-test full run preceded final two immediate-abort cases and had moving HEAD; local result only.",
    "Current 5-case run passed with215 filtered; source captured locally, not a clean committed or installed runtime claim.",
    "Original slow-fire root cause remains unknown; no historical child/fire join retroactively asserted.",
    "No reset/restart/duplicate git-sync/manual commit/release-gate operations."
  ],
  "correction": "Earlier worker-startup-failure inference was withdrawn: actual TEST_FILE_RESULT passed; signal teardown was normal. Correction delivered to owner and task plan.",
  "next": "Await fresh fleet-admission run already launched, bind only guarded qualified evidence, then resume parent. Parser EI-26719659525242618 ordinary claim refused admission-pending; no edits or forced claim."
}
