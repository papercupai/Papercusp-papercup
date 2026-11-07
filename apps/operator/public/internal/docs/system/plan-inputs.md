# Plan inputs — declared schema, required fields, and the start gate
URL: /internal/docs/system/plan-inputs

How a plan takes arguments — the two schema sources and the one value slot, the required-field gate every start door consults, how values reach the executor, and the from_input fanout that is the point of the whole thing.

import { Aside } from '@astrojs/starlight/components';

A plan can declare **arguments**: named, typed, optionally-required values supplied
before it runs. A plan that declares none keeps its existing input-validation behavior — which is
why this needed no feature flag, and why nothing in the pre-existing plan corpus
changed when it shipped.

## Before implementation review: finalize discovery

**Brief → scoped discovery → findings incorporated → implementation review → execution.**

A draft remains authorable while it is incomplete. Label it a **provisional discovery
brief**. Discovery is ordinary task work about that draft under existing task authority;
starting an implementation item is not the way to investigate whether that item is needed.

Authors/discoverers bound the material current-behavior, gap and feasibility questions,
inspect existing implementations and record conclusions in `## Discovery`. Code-intelligence
suggestions are investigation leads; a stale graph, degraded compiler result, invocation
receipt or empty result alone does not establish absence. Cite corroborated current source
through the existing research/evidence adapters when appropriate.

Record only non-derivable judgments and selections: bounded questions/stop conditions,
conclusions, existing evidence refs, and dispositions on current R/P/D/section targets.
Incorporate those conclusions in the draft: change or narrow work, reuse existing behavior,
remove duplicate work, or justify keeping the scope unchanged. Do not copy hashes, timestamps,
status or test results, and do not author a ready checkbox.

```javascript
plans:set-content { slug, content }
plans:audit { slug, phase:'discovery', dryRun:true } // preview, no finalization
plans:audit { slug, phase:'discovery' }              // one idempotent logical finalization
```

Only `slug` and `phase` are required for discovery finalization in the current harness.
The server derives canonical targets, evidence identity/freshness, revision pins and readiness.
Its response supplies the current stage, evidence refs and next action. Already-running
sessions receive that guidance through their next relevant tool response; launch prompts
are not hot-reloaded. Finalization records discovery without activation, BAR seeding or
implementation dispatch, and does not grant execution authority.

Reviewers read original intent and the reconciled current revision with its findings,
evidence and remaining uncertainty. Preserve full independent BAR re-review after material
changes, without a round cap. Implementers follow the usual activation/spec-quality,
review and authority checks before starting. Formal review dispatch and new implementation
admission refuse missing, incomplete or stale discovery before accepting effects.

**Worked original-failure example.** The proof-warming draft's P-001 says to establish an
existing-behavior/prior-work census and identify reused implementations and unresolved gaps.
Those answers cannot remain an implementation task when they determine necessity or approach.
Inspect the existing keyed proof cache and its consumers first, cite current evidence, remove
the duplicate census/warming work and retain only the evidenced missing caller. Finalize those
findings, then request implementation review of the corrected revision. Do not rewrite or
activate the historical motivating draft to demonstrate this.

Small/general plans can reuse prior current evidence and a justified minimal no-material-
unknowns record; no-change outcomes and bounded nonblocking implementation experiments are
valid. Identical, cosmetic and unrelated state reuses original provenance without fresh
narrative; relevant source or target changes reopen only affected judgments. Existing in-flight
work and historical terminal records are preserved. Discovery adds no mode, dashboard or
routine owner approval round.

## The shape: two schema SOURCES, one value slot

Values always live in one place — the `template_data` jsonb on
`harness_shared.harness_plans`. What constrains them comes from one of two sources,
and a plan has **exactly one**:

| source         | declared by                | checked with                          | when to use                                            |
| -------------- | -------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `template`     | `template:` in frontmatter | a code-registry **zod** schema        | built-in types the system itself depends on (`rubric`) |
| `input_schema` | `plans:set-input-schema`   | a plan-authored **JSON Schema** (ajv) | everything else                                        |

The split exists because the registry cannot serve plan inputs: adding a type there
means shipping code, and agents author plans while the operator is running. JSON
Schema fills that gap on the existing ajv path (`datatype-payload-validation.ts`)
rather than a bespoke DSL.

Declaring **both** is a `schema_conflict`: which one governs would be undefined, so a
plan in that state refuses to start rather than picking one. `plans:set-input-schema`
will not create the overlap, but federation projection and direct SQL bypass the verbs
entirely — so the gate re-checks rather than trusting an upstream guarantee it cannot
enforce.

## Completeness is enforced at START, never at WRITE

`plans:set-template-data` accepts **partial** data on purpose. A plan is authored
incrementally, and a writer that rejected every incomplete state would make a plan
impossible to draft. What it *does* enforce is structural validity — types, enums,
unknown keys.

Required-ness is checked when the plan **starts**. That split is the whole design: a
plan can be drafted half-specified and still cannot be *run* half-specified.

WRITE strictness differs by source, and it looks like a bug if you meet it cold. The
registry/zod path keeps enforcing its own required fields on write, because its schemas
describe code-defined domain objects (a rubric) whose readers assume a complete value.
The `input_schema` path relaxes top-level `required` on write. The two paths differ on
WRITE and agree on START — see D-009 on the plan.

## The gate: one oracle, six doors

`evaluatePlanStartReadiness` is a pure function over `{ template, inputSchema }` plus
the supplied values. Every way of setting a plan running consults it through
`plan-start-gate.ts`:

`plans:start` · `plans:launch` · `plans:run-now` · `plans:arm-schedule` ·
`fleet:launch-on-plan` · `runScheduledPlanFire`

`PLAN_START_DOORS` names them and a guard test fails the build if a listed door stops
reaching the gate — six independent notions of "ready" would otherwise drift apart
within a release.

**Arming is a door even though it starts nothing.** Arming makes the plan fire later,
unattended; checking there means a plan missing its arguments is refused at 14:00 by
the human who armed it, instead of failing at 03:00 in a routine nobody is watching.

A refusal is fail-loud and carries what you need to act:

```json
{
  "error": "plan_inputs_not_ready",
  "code": "missing_required",
  "missing": ["harness", "paths"],
  "issues": [],
  "hint": "Required inputs not supplied: harness, paths. Supply them via plans:set-template-data { slug, data }, or pass them as `inputs` on this run."
}
```

`missing` leads wherever both apply, because "you did not supply `harness`" is
actionable and "`/harness` must be string" for an absent field is not. A schema that
cannot be compiled fails **closed** (`bad_schema`) — never silently unchecked.

## Supplying values

Three ways, in increasing specificity:

1. **Stored on the plan** — `plans:set-template-data { slug, data }`.
2. **Per-invocation overrides** — an `inputs` arg on `plans:launch` / `plans:run-now`,
   **shallow**-merged over the stored values. Shallow because deep-merging arbitrary
   JSON has no obviously-correct array semantics, and silently picking one would
   surprise a caller who passed `paths: ['x']` and got the stored three plus theirs.
3. **The admin form** — `/admin/plans` renders the declared schema as a form for any
   plan that declares one, marks required fields, names what is still missing, and
   shows the gate's refusal verbatim when a start is refused.

To see what a plan needs, ask `plans:get-input-schema { slug }`. It returns the schema,
the current `values`, `required`, `missing`, and `ready` — all computed by the gate's
own oracle, so the read and the refusal cannot disagree.

## Delivery: values reach the executor structurally

Inputs are **not** interpolated into plan prose. The moment `{{ inputs.x }}` renders
inside a plan body, the plan document becomes a template language with escaping and
partial-render failure modes. Instead:

* **`context-bundle.ts`** renders an INPUTS block — field, value, and the schema's
  description — into the launch seed, so a launched plan agent can see its arguments.
* **`plan-run-action.ts`** carries `template_data` onto the instance plan and attaches
  the resolved inputs to each minted work-item's `payload.plan_run.inputs`, so a worker
  that never reads the seed still has them.

## The payoff: `for_each: { from_input }`

The clearest single reason the feature exists. A generative wave can fan out over a
**passed-in array** instead of a hardcoded list:

```yaml
for_each:
  from_input: paths
```

A fourth resolver kind beside `items` / `glob` / `sql` / `from_feature`. It resolves to
an explicit item-set *before* reaching the generic fanout, so everything downstream is
unchanged. A `from_input` naming a field the run does not carry, or one holding a
non-array, fails loudly — a silent empty fan-out would look like a plan that ran and
found nothing to do.

## Related

* [Storage policy](/internal/docs/system/storage-policy) — why this is jsonb on an
  existing table rather than new state files.
* Plan `plan-structured-inputs-2026-08-01` — the decisions behind each choice above.
