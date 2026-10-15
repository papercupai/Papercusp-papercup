# Work on Everything 02C verification — WI-10007370

Avi’s approved Draft & apply interface is implemented in canonical staging. It uses package identity for the dedicated destination, staged scope/priority edits, before/after review, version-checked saves, retained reasons, the shared history rail, and a plan inspector. This record covers implementation and scoped acceptance; production shipment is unverified.

## Verification

| Check | Evidence |
| --- | --- |
| Original focused framework suite | 117 passed; subsequent feature rerun 46 passed, recorded in the work-item checkpoint and predecessor transcript. |
| Latest UI, routing and draft suite | 77 passed across WorkOnEverythingPanel, GoalDetailPanel and ongoing-work-draft. Vitest threads pool, one worker, 2026-10-08 05:48 UTC. |
| Persistence | Real-PG reason/CAS regression: 1 passed. Unheld-goal worklist regression: 1 passed. Saved checkpoint retains the original proof. |
| Types and spacing | Latest scoped UI typecheck clean after the keyboard fix. Earlier scoped UI/core checks and 2 letter-spacing tests passed. Full-tree design lint is not clean; owned residue is listed below. |
| Real native special entry | Work on everything opens the dedicated destination. The stopped legacy instance has a plan-ref-list without a collection declaration and truthfully displays Worklist unavailable. [Screenshot](native-special-entry.png). |
| Native browser fixture | At 1280×800: search, row selection, click reorder/removal, inspector history/evidence, before/after review, optional reason entry and discard passed. Discard restores order/scope; 0 goal-property POSTs observed. [Worklist](native-worklist.png), [review](native-review.png), [measured JSON](native-evidence.json). |
| Keyboard regression | Native Alt+Up bubbled to AdvShell’s global previous-tab shortcut, losing the draft when HUD unmounted. A document-level regression failed before the fix. The handler now stops propagation; all 77 focused tests pass. The fixed shortcut was not rerun in the frozen native build. |
| Teardown | Maintained stop script reported stopped, display :90 / port 33700. Owned native PID 2022861 was absent after shutdown. |

Native draft checks used a temporary browser-only read fixture, reusing the existing component test’s three-row collection shape. The live goal database was not changed. Apply was not clicked. The fixture screenshots are explicitly labelled and do not establish a configured live-goal worklist journey.

## Source and evidence identity

- Baseline feature: `7a0264b54a62e5a40519b0b841a86a79cee7c109`.
- Native frozen backend: `76d5b2f278430ec42e9e84f16ad875730bfefeb0`; all 23 required inputs matched the selected commit before boot, and its 10 feature inputs matched the baseline.
- Native run: `20261008T051556Z-1862813`. Durable harness receipt: `~/.local/state/verification-harness/verify-tauri-headless/20261008T051556Z-1862813`. Preparation and boot passed; boot-only intentionally skipped its assertion phase. The separate guarded UI commands supply the acceptance evidence above.
- Latest canonical panel SHA-256 after keyboard fix: `3535b0f5e65540ded3c50ef91471d683d3d8c1443c66c31141c14a21db354308`.
- Latest canonical test SHA-256: `54c9279aaf85ba7b28d8d2510dffc2734c43c6170a9f7cae60bb80ece7998fbf`.

The native SPA was frozen from the current build and contained the introduced console marker. Its screenshots precede the five-line canonical keyboard source/test correction. Native narrow-viewport behavior and final deployed artifact were not exercised.

## Accountable residue

- **EI-25384405637359411**, assigned to this session: existing full-tree design token/control lint residue; deferred.
- **WI-10007400**, assigned to this session: immutable native source/tooling selection follow-up; deferred.
- **WI-10007411**, assigned to this session: initial CSS/module import failure under 127.0.0.1. Exact assets returned 200, all 41 direct HUD imports loaded, and identical fresh-URL module bytes loaded. The same owned server rendered through localhost. That is a mitigation; the original failure mechanism remains unmeasured.
- **WI-10007416**, assigned to this session: Vitest forks worker startup timeout. No tests ran in that attempt; supported threads mode verified the regression. The startup cause remains unmeasured.
- **WI-10007153**, assigned to the shipment session: final shipment/acceptance lane. Legacy package-instance reconciliation evidence was delivered there; live collection migration and exact shipped artifact acceptance remain separate.

The documentation plan remains draft because its formal activation prerequisites are incomplete. Execution and verification were tracked on the explicitly approved WI-10007370 route. No deployed-main or shipment verdict is inferred from these results.
