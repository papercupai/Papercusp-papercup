# Plan verification profiles: coding vs general plans, and per-item deliverables
URL: /internal/docs/agent-insights/plan-verification-profiles

Every plan is stamped coding or general, and each plan item may declare a deliverable kind. One resolver (resolveVerification) turns those two facts into the verification modules an item is held to, and every gate reads that one answer. Tables of modules, profile defaults and deliverable mappings, pinned to the resolver by a doc-claims test.

Plans are not all code. A plan whose items are a runbook, a decision, a research memo or an operation used to get through verification only by one of six exemptions, each decided in a different gate, so every new gate forgot one (nine bugs were filed against that shape). Verification profiles replace the exemptions with one answer.

## The model in one paragraph

Every plan carries a **verification profile**, `coding` or `general`, stamped once when the plan is created. Every plan item may declare a **deliverable** kind. The resolver, `resolveVerification` in `packages/operator-core/lib/plan-verification-profile.ts`, takes the plan's profile and the item's declared deliverable and returns the **modules** the item is held to. A declared deliverable always wins; an item that declares nothing gets its profile's default. Every gate that used to carry a local not-code exemption (plans:audit, the ship gate, requirement realization, the proof floor, spec-test adequacy, work\_items:complete, grader recruitment) now asks the resolver instead.

## Modules

A module is a family of checks. `generic-core` applies to every item in every profile. `code` is added only for a code deliverable. `design-evidence` and `packaged-artifact` are opt-in domain modules an item adds explicitly.

| Module              | Checks it owns                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generic-core`      | `shaping`, `activation-audit`, `requirements-to-bars`, `governance`, `completion-integrity`, `root-cause-verification`, `rubric-vetting`, `independent-grading`, `implementer-verdict`, `blind-review` |
| `code`              | `code-truth-audit`, `spec-test-adequacy`, `test-ledger-freshness`, `completion-tests-and-files`                                                                                                        |
| `design-evidence`   | `design-evidence`                                                                                                                                                                                      |
| `packaged-artifact` | `packaged-artifact`                                                                                                                                                                                    |

Independent grading, rubric vetting and the implementer's verdict are in `generic-core`, so a `general` plan is graded exactly as a coding plan is. Only the code-specific checks drop away.

## Profiles

| Profile   | Default deliverable | Modules an undeclared item gets |
| --------- | ------------------- | ------------------------------- |
| `coding`  | `code`              | `generic-core`, `code`          |
| `general` | `artifact`          | `generic-core`                  |

How the profile is set (plan Decision D-005):

* Declare it: `plans:new { slug, title, verificationProfile: 'general' }`. The stamp records source `declared`.
* Leave it out and the harness decides: a harness whose blueprint produces code gets `coding`, any other registered harness gets `general` (source `harness-default`).
* Anything unknown fails safe to `coding`: an unregistered harness, a missing or invalid blueprint, a lookup error, or a plan with no harness.
* `plans:get` shows the stamped profile, how it was set, and the modules each item is held to.

Changing it later goes through `plans:set-verification-profile`. Raising (general to coding) is always allowed, and so is any change while the plan is still a draft. **Lowering** an active plan (coding to general, or an item from code to non-code) is refused with `verification_lowering_requires_decision` unless a plan Decision recording the reason already exists, and with `verification_lowering_requires_fresh_activation_audit` until a new activation audit covers the change (D-008).

## Deliverables

| Deliverable | Modules                |
| ----------- | ---------------------- |
| `code`      | `generic-core`, `code` |
| `doc`       | `generic-core`         |
| `decision`  | `generic-core`         |
| `research`  | `generic-core`         |
| `operation` | `generic-core`         |
| `artifact`  | `generic-core`         |

Declare a deliverable when the item is defined: `plans:add-item { slug, phase, items: [{ text, deliverable: 'doc' }] }`. A declared kind outside this list is ignored rather than inventing a module set. A coding plan with a runbook item is the common mixed case: declare that one item `doc` and leave the rest to the `code` default.

## What changes for a non-code item

* **plans:audit (completion)** accepts generic citations (`artifact`, `work-item`, `measurement`, `external`) as verifying evidence for a non-code deliverable. For a code deliverable only `code`/`test` citations that resolve against the tree verify, as before (D-006).
* **work\_items:complete** does not ask for tests-run evidence when the linked plan item is a non-code deliverable. A non-code item whose close carries code-change evidence is refused (`non_code_deliverable_code_evidence`): the deliverable was declared wrong, or the code belongs to another item.
* **Spec-test adequacy and the ship snapshot** read each clause's deliverable from Postgres (`readClauseCodeDeliverables`), so a non-code clause is graded on manual evidence without an executable proof floor (D-010).
* **The ship gate** still refuses a code deliverable in *any* profile that has no resolving code/test citation (`code_deliverable_unverified`, D-009). A general plan does not turn code work into non-code work.

## Traps

* `plans:audit` can return `ok` but record **no** entry for a code item cited only with generic evidence. The ship gate then names that item `audit_coverage_stale` (no audit entry) rather than `code_deliverable_unverified`. Read a code-truth refusal as "this item is not verified" whichever code it carries (EI-26498896722404958).
* The profile is stamped once, at `plans:new` (D-005). To change it afterwards use `plans:set-verification-profile`, not a second `plans:new`.
* Do not reach for the old signals (`not-code` audit verdict, a `task` work item, a `non-automated` clause) to exempt an item. The resolver still honours them when an item declares no deliverable, but a declared deliverable is the supported route.

## Pinned to the resolver

The three tables above are checked against the live resolver by `packages/operator-core/lib/doc-claims/verification-profiles-doc.test.ts`. If a module, check, profile default or deliverable mapping changes in `plan-verification-profile.ts`, that test fails until this page is updated with `docs:author`.

Related: [the plan completion runbook](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook).
