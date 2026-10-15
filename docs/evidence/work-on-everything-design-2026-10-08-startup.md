# Native verification startup fix — EI-25427635691341313

The GUI verification runs stopped before Tauri startup because the verifier used a fixed 15-second cold-import deadline. A valid frozen host was observed importing successfully in 20.119 seconds. This finding concerns the verifier budget; no backend module-init defect was established.

## Distinguishing evidence

- Original wide run `20261008T155546Z-608078`: host import smoke exited 124 after 15.167 seconds; output contained the start marker.
- Original narrow run `20261008T155909Z-732935`: host import smoke exited 124 after 15.416 seconds; output contained both start and success markers.
- In that narrow run's still-live frozen dependency snapshot, the same bundled entry was executed with `--papercusp-import-smoke` and `MALLOC_ARENA_MAX=2`, bounded by a 60-second diagnostic deadline. It exited 0 and emitted `PAPERCUSP_HOST_IMPORT_SMOKE_OK` after 20.119 seconds. The returned Codex command-output chunk was `62b4d2`.
- Parse-only verification of the retained wide bundle exited 0 after 5.316 seconds. Replaying the bundle after its external dependency snapshot had been deleted subsequently failed to resolve `mingo`; that relocated replay is not equivalent to the successful frozen-graph run.

A broken module initialization would still fail when given enough time. The successful exact frozen-graph import distinguishes that alternative from an insufficient deadline.

## Durable change and guard

The existing smoke function now uses its own validated, bounded cold-import budget: `VERIFY_TAURI_HOST_IMPORT_TIMEOUT`, default 60 seconds, accepted range 1–300. The launch validates it before source preparation. Explicit per-call deadlines remain supported for the regression harness.

The existing framework suite in `apps/operator/lib/verify-tauri-headless-source-snapshot.test.ts` passed all 50 tests. New cases verify default/configured budget forwarding, invalid-budget refusal before Node starts, and a delayed valid import passing with an adequate deadline and failing with an insufficient one. The existing hung-import test continues to fail closed. `bash -n scripts/verify-tauri-headless.sh` passed.

## Current-build runtime verification

The fix is committed in source `09230d015b396ead76122763142db64489b6f441`. Owned native run `20261008T165829Z-3799210` passed the corrected import smoke:

```json
{"exitCode":0,"elapsedMs":7103,"timeoutSec":60,"bundleBytes":74358676,"bundleSha256":"075d7a7a23b5b4471dbc270132b3155f0d2af4b1f2e3d711e5299f903f55c671","outcome":"passed"}
```

The authoritative receipt is `$HOME/.local/state/verification-harness/verify-tauri-headless/20261008T165829Z-3799210/phases/prepare/host-import-smoke/result.json` (expand `$HOME` for the verifying account). This verifies the startup fix. The GUI's wide/narrow native assertions and release shipment are separate acceptance steps.
