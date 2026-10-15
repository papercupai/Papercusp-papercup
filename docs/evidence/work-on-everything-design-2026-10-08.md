# Work on Everything design refinement — WI-10007517

The existing Draft & apply panel now has a clearer worklist hierarchy, visible next steps, a scope and pending-change summary, compact row actions, and a more useful plan inspector. It reuses the maintained TextInput, Modal, Tooltip, action controls and semantic tokens. The inspector and rows stack at compact widths.

The existing version-checked Apply, canonical save acknowledgement, draft retention on failure, discard, plan navigation and evidence/history behavior are preserved. Scope totals reflect the whole worklist independently of search. Keyboard reorder works from a focused row control and prevents the event from reaching global navigation.

## Source and regression evidence

- UI and maintained native-test changes were committed by git-sync at `130beea0d142e71d41d30f3059baceeb1a623009`.
- Native acceptance is pinned to `09230d015b396ead76122763142db64489b6f441`, which also contains the corrected verifier cold-import budget.
- The focused panel/detail/draft suite passed 80 tests: 68 goal-detail, seven panel and five draft-model cases (original command-output chunk `c8beee`). The final panel suite passed seven tests after the Tooltip/action adjustments. Durable passing rows: panel `20936157`, goal detail `20934737`, draft model `20934739`.
- Registry validation and lint completed without warnings; submitted design spec `spec-1791472578682-h11id2` records the reused controls and layout.
- The panel framework tests cover scope totals during search/staging/discard, visible next steps, measured versus unknown progress, safe keyboard reorder, canonical save acknowledgement, stale drafts, failed saves and navigation.
- Scoped operator type verification passed with zero errors. Focused HUD/button lint passed two checks. The pre-existing broader design-lint follow-up is `EI-25384405637359411`.
- Startup blocker `EI-25427635691341313` is completed. Its 50-test framework verification and distinguishing runtime evidence are recorded in [the startup evidence](./work-on-everything-design-2026-10-08-startup.md).

## Wide native acceptance: passed

Run `20261008T165829Z-3799210`, 1280×900, passed prepare, boot and assertion phases. The maintained Playwright case, “Work on Everything design stays readable and draft controls work in the native viewport”, passed without skips; durable test row `20936810` records the exact pinned source.

The native assertions verify the requested viewport, no horizontal overflow in the panel's rows/overview/inspector/body, visible next-step text, correct scope totals, inspector presence, reorder, scope exclusion, before/after review, discard and an unchanged saved policy. Fixture writes use the owned isolated database. Apply is exercised in the framework tests; the native case does not click Apply.

Both wide screenshots were inspected: plan titles and next steps are readable, scope totals are distinct, row controls are clear, and the review shows the previous and proposed worklists with its actions visible.

Evidence root (expand `$HOME` for the verifying account):
`$HOME/.local/state/verification-harness/verify-tauri-headless/20261008T165829Z-3799210`

Screenshots under `phases/assert/playwright/ongoing-work-native-collec-86854-work-in-the-native-viewport-chromium/`:
`worklist-1280.png`, `review-1280.png`. Retained copies: [worklist](./work-on-everything-wide-worklist-2026-10-08.png), [review](./work-on-everything-wide-review-2026-10-08.png).

The source receipt, assertion-source hash and required-SPA-source checks passed. The original command exited zero. On continuation, recorded Tauri PID 4157508, host PID 4152358, and display :90 were absent, confirming teardown before another run.

## Narrow native acceptance: passed

Run `20261008T173256Z-1036084`, 540×900, passed prepare, boot and assertion phases. The same maintained native design case passed without skips; durable test row `20937035` records source `09230d015b396ead76122763142db64489b6f441`. The assertions additionally verified a single-column list/inspector layout at the compact width. The native spec and fixture hashes remained unchanged throughout the assertions.

The inspected screenshots show readable wrapped titles and next steps, visible scope/order controls, and a stacked before/after review with its editing and Apply actions visible. Retained copies: [worklist](./work-on-everything-narrow-worklist-2026-10-08.png), [review](./work-on-everything-narrow-review-2026-10-08.png).

Evidence root (expand `$HOME` for the verifying account):
`$HOME/.local/state/verification-harness/verify-tauri-headless/20261008T173256Z-1036084`

The run used canonical `.papercusp/tmp`, the shared disk reservation ledger, isolated Postgres :36897, verified bridge provenance and WebView profile, required panel-source stamps, and the `Make room for what matters.` marker. Backend and tests use the pinned archive; the frozen current-build SPA passed the required-source and marker checks. The corrected cold-import smoke passed in 13,220ms with a 60-second budget. Recorded Tauri PID 1533008, host PID 1513450 and display :90 were absent after teardown. The frozen source snapshot was removed, its recorded owner PID 1036084 was absent, and the maintained command returned exit zero (output chunk `2b2226`).

Two earlier attempts stopped before boot because of disk admission; another stopped at a whole-file fixture mismatch after a peer appended a helper unused by the pinned case. The final run kept the requested commit, scoped current-tree matching to the intended UI/test/production changes, and retained full archive verification of the baseline fixture. Its receipt's fixture SHA-256 `45d88efa8123a0c7d476c6cc92959195712d4f4c57d49168b8d8bdc34e26c5e2` matches the requested commit. No peer file or verifier guard was edited.

The first boot attempt encountered EADDRINUSE on :33700. Maintained recovery re-picked :33701 and the second boot succeeded. The remaining initial-port collision is recorded separately as `EI-25434223839168376`, assigned to this session. The serving tool-schema clarification for caller-only versus trusted-ledger runtime provenance is `EI-25247530299056131`, also assigned to this session. The pre-existing broad design-lint issue `EI-25384405637359411` remains assigned to `su-e7208581-4177-450e-a2a9-65d871758d61`.

## Delivery boundary

This is current-build implementation evidence. Released-main shipment has not been verified by this work-item.
