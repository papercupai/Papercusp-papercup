# Interest watch shutdown must join startup and in-flight sweeps
URL: /internal/docs/agent-insights/interest-watch-shutdown-drains-inflight-sweeps

Stopping a timer cannot finish work it already started. The interest-watch lifecycle owns pending startup and sweep promises before a private worker retires PostgreSQL.

A managed timer stop cancels future ticks; it does not await a callback already doing database work. A disposable host must join both lazy startup and active sweep promises before it closes pools.

In `packages/operator-core/lib/events/await/interest-watch.ts`, `startInterestWatchSweeper` retains its startup promise and invalidates canceled continuations by generation. The managed callback returns its tracked sweep promise so the registry keeps its running state until settlement. `stopInterestWatchSweeper` invalidates startup, stops the managed timer, then awaits startup and the active sweep set. Its caller must finish that stop before draining detached work, flushing fallback observations and closing database pools. A generation check alone cannot finish SQL already in flight.

The detector failure was a success-only disposable-worker proof that could report `interestWatchTimerStopped:false` without ever exercising a tick during body failure. The canonical `sync-batch-lint-guards.integration.test.ts` now reuses its single P028/P037 child, completes the existing filing/typecheck proof, then deliberately fails the body while the production sweep is blocked on a private PostgreSQL table lock. The finalizer proves stop remains pending until release, observes the completed sweep write, drains detached/fallback work, and closes pools. The outer test requires the original assertion/nonzero child exit, the complete ordering receipt, absence of late HNSW/fallback-loss warnings, and removal of the original private runtime and PG data directory.

`interest-watch.test.ts` also drives actual pending startup and managed callback shutdown. Pure promise-set tests supplement those paths. When inspecting the registry, remember that `getManaged()` returns a snapshot copy; retaining it cannot observe later settlement. Use the lifecycle promise and durable SQL result for ordering proof.

Verified on 2026-10-16: 11 lifecycle units passed; the maintained private failed-body integration passed 1/1 with zero skips, at local dirty HEAD `2c28ca7698`. The retained evidence run is `20261016T140736Z-1083619`, with source hashes, original assertion, ordering receipt and private cleanup. Source SHA256 was `d918b9612ae823003259b7f63f6d6f6eb26e876c6ec85250fa127dd07b6012cf`. This proves the shutdown defect class and its guard; it does not isolate the exact producer of the earlier ce62/P037 warning, prove live deployment, or establish live loop restoration. EI-26062995806340509 holds the full evidence.

If shared integration global setup refuses PostgreSQL storage admission, preserve that guard. The maintained `scripts/with-test-pg.mjs` wrapper can pin the canonical exact test runner to its own capacity-selected private cluster; do not stop a shared container or delete another test's databases.
