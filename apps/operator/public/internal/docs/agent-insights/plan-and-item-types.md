# Plan types, item types and type packs: the type registry and the Cupboard
URL: /internal/docs/agent-insights/plan-and-item-types

What a plan is held to now comes from a revisioned type registry. Item types and plan types are definitions in the registry; plans pin the revisions they resolved; packs carry types through the Cupboard. How to define, declare, pin, retire, publish and install types, and the refusals you will meet.

## The model

A plan item is held to a set of **verification modules** (`generic-core`, `code`, `design-evidence`, `packaged-artifact`). The set used to come from a fixed list of six deliverable kinds and two profiles ([plan verification profiles](/internal/docs/agent-insights/plan-verification-profiles)). It now comes from a **type registry**:

* An **item type** says what one item is held to: its modules, which citation kinds verify it, the fields its close must carry, and an optional criteria template or rubric.
* A **plan type** says what a plan is: its base (`coding` or `general`), the acceptance classes it admits, the item types it references, and the default item type an undeclared item gets.
* The six built-in deliverables and the two profiles are now seeded first-party types: item types `papercusp/code`, `papercusp/doc`, `papercusp/decision`, `papercusp/research`, `papercusp/operation`, `papercusp/artifact`, and plan types `papercusp/coding`, `papercusp/general`. They resolve to exactly the modules they did before.

One resolver answers every question: `resolveVerification` (`packages/operator-core/lib/plan-types/resolve-verification.ts`). Code-ness means "the resolved module set includes `code`". Nothing branches on a kind literal any more.

## Declaring types on a plan

* **Plan type:** put `type: <id>` in the plan's frontmatter. With no `type:`, the plan's verification profile (`coding` or `general`) picks the first-party plan type.
* **Item type:** write `deliverable: <id>` in the item text, as before. The parser now accepts any namespaced slug (`acme/legal-review`) and checks grammar only; the bare built-in kinds (`doc`, `code`) still work.
* **Unknown type:** an id the registry cannot resolve is held to the **strictest** module set, and the read names the install that would provide it. It never silently resolves to fewer checks.

## Definitions

Both schemas live in `packages/operator-core/lib/plan-types/definitions.ts` and are strict, so an unknown key is refused.

| Item-type field                                                                   | Meaning                                                                                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `revision`, `title`, `description`                                          | Namespaced id (`owner/name`); revisions are integers, one row per revision.                                                               |
| `extends`                                                                         | The item type this one refines. Its modules are inherited.                                                                                |
| `modules`                                                                         | From the module catalog. `generic-core` is always present and cannot be dropped.                                                          |
| `completion`                                                                      | A JSON Schema, or `{ datatypeRef }` naming an installed datatype. `work_items:complete` validates `completion.typeFields` against it.     |
| `citations`, `workItemKind`, `criteriaTemplate`, `rubricRef`, `checks`, `display` | Verifying citation kinds, the promoted work-item kind, the checklist template, declarative rubric checks, and the badge label/icon/color. |

| Plan-type field                                    | Meaning                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `base`                                             | `coding` or `general`.                                                          |
| `classes`                                          | The acceptance plan classes this type admits; the plan picks one at activation. |
| `itemTypes`                                        | Referenced item types, each with an optional revision range.                    |
| `defaultItemType`                                  | Must be one of `itemTypes`.                                                     |
| `restrictItemTypes`, `requiredSections`, `display` | Optional.                                                                       |

Checks are declarative only. A definition never carries executable code.

## Authoring tools

| Tool                | Use                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `plan-types:list`   | Every type at its current revision (`includeRetired` for all revisions). Use it to pick an id or see whether one is taken.     |
| `plan-types:get`    | One definition as stored, with content hash, origin, retirement and its revisions.                                             |
| `plan-types:define` | Define a new revision. Validates the schema, the module catalog and the generic-core floor, and that every reference resolves. |
| `plan-types:pin`    | Move an activated plan to another revision of a type it uses.                                                                  |
| `plan-types:retire` | Retire one revision. New references stop resolving it; plans pinned to it keep it.                                             |

To change a type, define its next revision. Never edit a revision in place.

## Pins

When a plan is activated, it pins every type it resolves, including parents reached through `extends`, in `harness_shared.plan_type_pins` (one row per type: revision and content hash). A type the plan first references later is pinned then. Pins are insert-if-absent; only `plan-types:pin` moves one.

The ship gate (`plans:set-plan-status`), `plans:start`, `work_items:complete`, `plans:audit` and the Plans pane type view resolve a plan at its pinned revisions, so a newer revision of a type does not change what an activated plan is held to on those paths. Known gap: the acceptance-bar snapshot and the plan display readers (for example `plans:get` ship readiness) still resolve against the current registry; tracked as WI-6554700010018901.

## Lowering is guarded on every route

**Lowering** means the resolved module set of an activated plan item loses a module. Every route that can lower one runs the same check (`droppedModules` over the before and after resolutions):

* swapping an item's `deliverable:` or the plan's `type:`;
* `plan-types:define` of a smaller revision of a parent an unpinned activated plan reaches;
* `plan-types:retire` of the revision an unpinned activated plan resolves;
* `plan-types:pin` to a smaller revision;
* installing a pack that ships a smaller revision of a type an activated plan uses.

Each refuses with `verification_lowering_requires_decision` until a plan Decision recording the reason exists, and with `verification_lowering_requires_fresh_activation_audit` until the activation audit post-dates that Decision. Raising (adding modules) needs neither.

## Distributing types on the Cupboard

Types travel in ordinary Cupboard **packs** (the existing `pack` listing kind). A pack's `papercusp.json` may carry:

```json
{ "typePack": { "itemTypes": [ /* definitions */ ], "planTypes": [ /* definitions */ ], "rubrics": [], "datatypes": [] } }
```

* **Publish** with `cupboard:publish-plugin`. The listing records the types it provides. A listing that declares item or plan types lands **pending review**; it cannot be installed until approved.
* **Install** with `cupboard:install-plugin { listingId }`. The install validates the manifest, checks that its types match the listing's declarations, resolves every referenced item type to the pack that provides it (a dependency is installed too), co-installs bundled rubrics and datatypes, and writes an install receipt. Anything pending or unresolvable refuses the whole install before any row is written.
* **Plan templates** may declare `requires_plan_type`. Installing the template installs that plan type and the packs its item types come from.

## Surfaces

* `plans:get` shows each item's resolved type and the checklist it is held to.
* `work_items:complete` validates the item type's completion fields (`completion.typeFields`).
* The Plans pane shows a plan-type badge, an item-type badge on every row, the resolved module checklist and a completion form. Its data comes from the `plans.itemTypeView` sync query; the open panel is URL state.

## Refusals you will meet

| Code                                                                                                                                             | Meaning and repair                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `type_revision_not_found`                                                                                                                        | The id or revision does not exist. Check `plan-types:list`.                                                      |
| `type_revision_already_retired`                                                                                                                  | That revision is already retired.                                                                                |
| `item_type_fields_invalid`                                                                                                                       | The close's `completion.typeFields` do not match the item type's completion schema. The errors name each field.  |
| `item_type_completion_schema_invalid`, `item_type_datatype_unresolved`                                                                           | The type's completion schema is invalid, or its datatype is not installed. Install the datatype or fix the type. |
| `item_type_fields_check_unavailable`                                                                                                             | The check could not read its inputs. Retry.                                                                      |
| `type_pack_manifest_invalid`, `type_pack_definition_refused`                                                                                     | The pack's `typePack` failed schema or floor validation.                                                         |
| `type_pack_undeclared_types`                                                                                                                     | The manifest's types differ from what the listing declared. Republish.                                           |
| `type_pack_not_approved`                                                                                                                         | The listing is still pending review.                                                                             |
| `type_provider_missing`, `type_provider_ambiguous`                                                                                               | No pack, or more than one, provides a referenced item type.                                                      |
| `type_pack_dependency_missing`, `type_pack_dependency_conflict`, `type_pack_dependency_too_deep`, `type_pack_unpinned`, `type_pack_fetch_failed` | Dependency resolution failed. The message names the type and pack.                                               |
| `verification_lowering_requires_decision`, `verification_lowering_requires_fresh_activation_audit`                                               | See "Lowering is guarded" above.                                                                                 |
