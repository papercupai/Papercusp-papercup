# Declare change kinds before closing a work-item; the close needs each kind's proof
URL: /internal/docs/agent-insights/declare-change-kinds-before-closing

work_items:complete requires a changeKinds declaration (ui, service, migration, background-job, logic, config, test-only, docs, no-code-change) and refuses a successful close missing that kind's proof. Declare at claim/create; narrowing, a first declaration at close, or UI-looking files without ui need a changeKindReason.

## What

Every `work_items:complete` that lands a successful terminal state (done / passed / resolved) on an item claimed after the change-kind cutover must DECLARE what kind of change it made, and carry the proof that kind requires. The declaration is `changeKinds`, a non-empty set from a bundled catalog (`packages/operator-core/lib/change-kind-catalog.ts`), accepted on `work_items:create` (with `assign_to`), `work_items:claim`, `work_items:checkpoint` and `work_items:complete`. Each declaration is stored with who, when and at which step; `work_items:get` returns the current kinds and their history.

| kind           | covers                                                        | proof the close must carry                                                                                                                                |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ui             | anything a person sees or interacts with in the running app   | a recorded real-app run artifact, the build it ran, each changed state covered, and a check whose expected value distinguishes right from plausibly wrong |
| service        | API routes, tool handlers, RPC endpoints, auth and sync paths | a live call against a running build that contains the change, with its response                                                                           |
| migration      | schema or data migrations                                     | the migration applied to a disposable database, with the resulting schema or rows checked                                                                 |
| background-job | routines, workers, queues                                     | one run of the job in an isolated runtime, with its observable effect checked                                                                             |
| logic          | pure or library code a test can fully exercise                | a passing run of tests that exercise the changed behavior                                                                                                 |
| config         | configuration, flags, environment, build settings             | a read-back of the effective value from the program that consumes it                                                                                      |
| test-only      | tests and fixtures only                                       | a passing run of the changed tests                                                                                                                        |
| docs           | documentation, prompts read by people, comments               | the changed document read back from where readers get it                                                                                                  |
| no-code-change | investigation, triage, a decision                             | an empty `filesChanged`                                                                                                                                   |

## Why

A prompt that says "verify your work" is advice; a close that refuses without the proof is enforcement. Declaring the kind up front lets the close know which proof it owes, so a UI change cannot close on a Vitest run alone and a service change cannot close without a live call.

## How

1. **Declare BEFORE the close** — at `work_items:claim { id, changeKinds }` or `work_items:create { …, assign_to, changeKinds }`. Re-declaring later (checkpoint or complete) keeps the earlier declaration in history.
2. **Close with each kind's proof.** A single-kind close may use the completion's root `summary / testsRun / testResult / filesChanged`. A multi-kind close carries one `completion.kindEvidence[]` entry per kind (`{ kind, testsRun, testResult, artifacts?, build?, … }`).
3. **Missing proof is refused**, and the reply names each missing piece per kind. Fix the evidence and retry; never re-declare a lighter kind to dodge the proof.

## Safeguards that need a changeKindReason

* **First declaration at the close** needs `changeKindReason` (refused without one).
* **Narrowing** — dropping a kind declared earlier — without a `changeKindReason` lands `proposed` (out of burn-down). A reasonless narrowing recorded by an earlier close attempt stays unexplained on the retry, so it cannot be laundered through a failed close.
* **UI-looking files without `ui`** — `filesChanged` touching `.css`/`.tsx`/`.jsx` while the declared set omits `ui` — lands `proposed` unless a `changeKindReason` says why. A reasoned mismatch lands done and is recorded; `work_items:list { audit: 'change-kind-mismatch' }` lists those closes for review.

Re-close with a one-line `changeKindReason` (and corrected `changeKinds` — add `ui` when the change is visible) to count a proposed close toward done.

## Cutover

Claims taken before `CHANGE_KIND_GATE_CUTOVER` (`packages/operator-core/lib/change-kind-proof.ts`) close with a warning instead of a refusal. An unknown claim start counts as before the cutover.

## Related

* Plan `change-kind-declared-proof-2026-10-15` (requirements R-1 to R-6, decisions D-001 to D-010).
* Source: `change-kind-catalog.ts` (catalog + arg shapes), `change-kind-proof.ts` (the close gate), `completion-audit.ts` (the `change-kind-mismatch` audit).
