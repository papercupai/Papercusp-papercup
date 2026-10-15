# Executed-source capture: collection diagnostics omit body imports
URL: /internal/docs/agent-insights/executed-source-capture-collection-vs-body-imports

Why Vitest collection diagnostics miss dynamic imports, how the final worker handoff closes the dependency radius, and why late original-source bytes remain unknown.

## The failure and its evidence

During EI-25597096188717078, a private messages-route test passed while its executed-source map listed the test but omitted the route loaded inside its body after `vi.resetModules()` and `vi.doMock()`. The installed Vitest runner calls `getImportDurations()` in collection and stores that snapshot on the file; the reporter's end callback receives that same snapshot. Raising its limit does not make it a final execution record.

The real armed-child regression in `executed-inputs-capture-armed-run.test.ts` exercises this boundary. Baseline test\_runs row 20983493 failed because the child executed the dynamic route but the dependency list omitted it. Corrected row 20983515 passes. The original private-route capture at `/tmp/customer-native-route-fire143-source-map.json` now lists both the route index and loop-port module, while reporting unknown original-source evidence. These are local dirty-source observations, not clean current-build or release acceptance.

## The existing capture seam

The setup's final `afterAll` extends the existing `InputsRecord` handoff with `moduleImports`, read from the worker's live `moduleExecutionInfo`. The installed evaluator omits `external` for inlined modules and sets it true for external modules. The decoder preserves that distinction, excludes non-file IDs, and returns null for unavailable or malformed state. This internal seam must remain guarded by a real armed Vitest child test across runner upgrades.

The reporter unions final worker imports with collection diagnostics. An unavailable final observation adds `worker-module-imports-unavailable` to proof opacity and source-evidence reasons. The selector and recorder share proof-v3; old proof-v2 collection-only records are rejected through their existing runner-identity check.

## Dependency radius and original bytes are separate

A final worker import observation establishes which modules executed. It does not supply prospective original-source bytes for a module first loaded after collection. Preserve `module-not-captured-at-collection:<path>` and unknown status for those modules; never fill that gap with end-of-run disk bytes or a mutable server graph. Stable captured subsets cannot certify complete dynamic, native, configuration, child-process, or runtime graphs.

The general selection and reuse model remains in [the executed-source pruning guide](/internal/docs/agent-insights/gate-latency-related-selection-executed-source-pruning-and-retry-policy). This page documents the measured collection/body boundary and its recurrence guard rather than introducing another capture mechanism.
