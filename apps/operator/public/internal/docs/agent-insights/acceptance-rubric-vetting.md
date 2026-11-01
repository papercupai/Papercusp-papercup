# Acceptance-rubric vetting — direct critique and legacy meta-cards
URL: /internal/docs/agent-insights/acceptance-rubric-vetting

How current independent critique satisfies acceptance-rubric vetting directly, when historical meta-scorecards remain a fallback, and how currentness and grader checks work.

How current independent critique satisfies acceptance-rubric vetting directly, when historical meta-scorecards remain a fallback, and how currentness and grader checks work.

## What this is

When the acceptance-rubric vetting gate is enabled and the workspace has the registered meta-rubric, a current independent critique can satisfy vetting directly. The gate reads the critique from its consult or review-work-item record; this current path needs no meta-scorecard, ratings, or grading-integrity audit. If no current critique is found, a qualifying historical meta-scorecard remains a compatibility fallback. If the meta-rubric is absent, the vetting prerequisite is disabled rather than blocking every plan.

This runbook documents that current direct-critique path first, then the legacy card fallback, its currentness rules, and the separate grader-eligibility behavior.

Plan of record: `consult-min-max-and-rubric-vetting-2026-08-17` (D-001, D-006, D-009, D-010, D-011). Responder bounds moved to a shared registry in `unified-responder-selection-critique-and-grading-2026-08-30` (D-001, D-004).

## The flow (author-side)

1. **Author the acceptance rubric post-implementation** — use rubrics:propose with kind acceptance, subject plan, class reference, and criteria (never at plan-creation time).
2. **Request a current independent critique** — call consult:get\_feedback with policy rubric-vetting and no responder count. The opening question must name the rubric ID and its current criteriaHash; if that identity is unavailable, name the exact current revision. The router selects and screens the reviewer. A minimum-filled responder is a first-principles review; weigh it as such. The gate also recognizes an independent review recorded on a review work-item.
3. **Improve and re-propose as needed** — read the critique, revise the rubric, and use rubrics:propose for the whole document. If the criteriaHash changes, request a critique of the new hash. A version-only bump can retain the critique when the request names the unchanged criteriaHash.
4. **Continue to acceptance grading** — the direct critique completes vetting. The acceptance scorecard that grades the plan's work remains a separate step and still requires a non-implementer.

The gate's direct path checks that the rubric is named, the review record exists, at least one critique post exists, and a critic is distinct from the rubric's creator and proposer. It does not judge meta-criteria ratings or require a vetting card or card audit.

### Legacy fallback: meta-scorecard

Use this only when preserving or creating the historical card-based attestation path and no current direct critique satisfies vetting:

```text
scorecards:emit {
  rubricRef: 'meta-acceptance-rubric',
  subject: { kind:'rubric', ref:'<acceptance-rubric-slug>' },
  vettingConsult: '<the consult conversation_id>',
  ratings: { ... }   // one rating per meta-criterion, evidence-grounded
}
```

The consult must exist and the subject must resolve to a rubric. The emitter stamps observation.vetting with the rubric identity it reads; both consult and rubric links are validated. The card path retains its grading-audit and currentness checks below. A current direct critique takes precedence and bypasses card ratings and audits.

The no-score-floor rule applies to a legacy card: the gate records the vetting judgment without mechanically requiring a passing rating on every criterion. A weak rating can be honest and admissible. The self-grade exception also belongs only to this fallback: the author may attest their own rubric after external critique; the acceptance scorecard for the plan's work still requires a non-implementer.

## Legacy meta-scorecard: judging the six meta-criteria

* **Outcomes, not diff restatements** — a criterion that re-narrates the change ("the function was extracted") fails; one about observable behavior ("a contradicted pass-rating refuses the emit") passes.
* **Traces to the plan goal or a Decision** — each criterion should cite the goal or a D-NNN. An untraceable criterion is scope invention.
* **Falsifiable with evidence** — name the concrete observation that would FAIL the criterion. If you cannot, rewrite the criterion.
* **Failure/regression modes covered** — at least one criterion must catch the plan's plausible regression, not only the happy path.
* **Non-overlapping** — two criteria that always fail together on the same observation are one criterion.
* **Structured check preferred (D-006)** — wherever the outcome is objectively checkable, bind it: `check:{ kind:'tests', files }` (deterministic must-pass — paths must resolve at propose time or the propose is refused, and the files are actually RUN at grading time) or `check:{ kind:'instrument', instrumentKey }`. Rate prose-only criteria for checkable outcomes DOWN here — that pressure is this criterion's purpose: it pushes authors from prose to bindings over time.

### For legacy card criteria: author the falsifier, not the confirming pattern

For every criterion phrased as a negative, name the enumeration that could exhibit a violation — never a search that can only find the compliant pattern. The method must also name what makes that enumeration complete. An empty or partial enumeration is `unknown`/no-verdict, not clean.

* **Absence or bypass claims:** enumerate every write to the state, every read of the row, or every caller/reference to the decision surface, then verify each path resolves through the named authority. Grepping only for the compliant constant or helper cannot reveal a bypass that omits it.
* **Set-difference and replication claims:** establish corpus coverage before reading pass/fail. Every replication drill that runs tests must assert `matched === filesRequested` (equivalently, matched files equal requested files, with no route error or skipped request) before interpreting the test verdict. `matched=0`, a short match, or an errored route is `unknown`, even when the residual set is empty.
* **Semantic actuation claims:** use a typed call graph, registry/dispatch resolution, or a live instrument for dynamic surfaces. A textual search for an exported symbol can miss string-dispatched or registered consumers and can match only comments/tests; zero textual references is `unknown`, never proof the surface is inert.

These inversions are deliberately cheap: enumerate possible violators, prove the instrument covered the requested corpus, then judge the observation. If the authoring-time property leaves no artifact (for example intent or attendance), restate it as the observable artifact that property should have produced.

## Revision currency (D-010)

**Current direct critique:** the opening request must name the rubric and current criteriaHash. The reader prefers that content identity; an explicit current revision is the fallback only when the request does not name a conflicting hash. A critique for a changed criteriaHash is stale. A version-only re-propose can retain the critique when the hash is unchanged and named in the request.

**Legacy meta-scorecard:** currentness is determined from rubricMeaningRevision when both recorded and live values exist; otherwise matching criteriaHash takes precedence, then rubric revision. A changed meaning revision or criteria hash is stale. A version bump alone does not void a card when a matching criteriaHash or meaningRevision establishes the same rubric meaning. Missing one-sided identity is unknown, not proof of currentness. Use the stored vetting identity and the live rubric identity together; do not compare revision numbers alone.

## Gate mechanics (D-009)

* **Refusal**: acceptance\_rubric\_unvetted from the ship gate. The current remedy asks for independent critique through consult:get\_feedback, naming the rubric and current criteriaHash or revision. A current critique is read directly; no attestation card or card audit is required.
* **Prerequisite**: the meta-rubric must be registered in any status; proposed suffices. If none is registered, the vetting check disables rather than deadlocking every plan ship.
* **Flags**: ACCEPTANCE\_RUBRIC\_VETTING\_GATE is default ON and is not waivable by force. It nests inside the ACCEPTANCE\_RUBRIC\_COMPLETION\_GATE family; family OFF means no rubric is demanded and nothing is vetted.
* **Exemptions**: empty-criteria investigation rubrics and the meta-rubric itself. There is no meta-meta-rubric; owner ratification governs the meta-rubric's content.

## Grading-time checks (D-011) — acceptance-scorecard rules

These rules apply when the non-implementer grades the acceptance rubric; they govern acceptance-scorecard emission, not the current direct-critique vetting step. A `tests` check's files are RUN via the testing router at emit time — one batched run over the union of unique files across rated `tests`-check criteria, with per-file attribution, under one shared clamped budget; never judged from stale ledger rows. A pass-vocabulary rating (`pass`/`healthy`/`green`/`good`/`yes`/`exemplary`/`exceptional`) over a failing run REFUSES the emit naming the failing tests; an unresolvable path (`check_path_unresolved`), a route error, or an over-budget run refuses with a teaching error — never a silent pass. An honest fail-rating over a failing run is STAMPED (`observation.checkRuns`) and files normally. A bespoke scale word outside the pass map degrades to stamp-only — conservative, never wrongly refused. The unchanged-evidence dedupe fires BEFORE any run, so a declined re-emit never burns a suite.

## The vetting/grading separation is NOT a deadlock — the escape is a second INDEPENDENT critic

Current direct-critique vetting and later acceptance grading are separate checks. A current independent critique from a critic distinct from the rubric creator and proposer satisfies direct vetting; it does not routinely require two critics or a meta-scorecard. The acceptance grader still must be a non-implementer.

The compatibility guard `grader_is_sole_vetting_critic` reads current meta-scorecard attestations. It refuses when every recorded critic resolves to the proposed grader’s own party. Trying to grade before vetting can instead surface `bar_snapshot_vetting_missing` or `bar_snapshot_vetting_stale`. This is **not a deadlock**: ordering is not the axis; a second INDEPENDENT critic is. The second-critic remedy below applies when that legacy guard actually fires, not as an extra prerequisite for ordinary direct critique.

1. Request another critique through `consult:get_feedback { policy:'rubric-vetting', question:<name the acceptance rubric and its current revision or criteriaHash> }`. The router selects and screens the critic. Do not hand-pick a related session or spawn your own grader.
2. For this legacy refusal, record the new critique with `scorecards:emit` against `meta-acceptance-rubric`, subject `{ kind:'rubric', ref:<acceptance-rubric> }`, and `vettingConsult:<conversation_id>`. Keep the attestation current with the live rubric identity. A card cites exactly one of `vettingConsult` or `vettingWorkItem`; the guard unions critics across current attestations from BOTH channels, so a consult-backed second critic counts alongside an earlier work-item-backed critic.
3. Retry acceptance grading at the current revision. Once the recorded critics include a party independent of this grader, that same grader can become eligible.

A longer list of critics in the **same lineage** does not escape the guard: the independence comparison collapses related identities to one party (the helper is `collapseCriticsToSoleParty`). Re-vetting yourself at a **newer revision** only records the same party again; a genuinely changed rubric also needs current vetting. Neither swapping the order nor changing revision numbers supplies independence.

Do not create a legacy meta-scorecard merely to satisfy the normal direct-critique path. Use the card-based route only for the legacy guard or fallback that actually reads those attestations.

## Legacy meta-scorecard traps — rating, identity, check binding, and audit

These scorecard-specific traps came from a vetting run (plan `on-demand-local-inference-lifecycle-2026-08-17`, 2026-08-19). They apply to legacy card emissions and scorecard checks, not to the current direct-critique path.

### 1. The rating VOCABULARY is per-rubric — the meta-rubric does not use the scale your acceptance rubric uses

`meta-acceptance-rubric` currently grades on **`pass | weak | fail | not-applicable`**. Most acceptance rubrics grade on **`healthy | degraded | broken | unknown`**. You will typically write both scorecards within an hour of each other, and the scale does NOT carry over. Read the live rubric before composing; `unknown` is not in the current meta-rubric scale and is refused as off-scale.

An off-scale value is refused at capture, by design ("an off-scale rating would be silently excluded from trends/staleness") — so the failure is loud, but it arrives only after you have composed every rating and its evidence, and the whole payload has to be resent. Read the target rubric's own `ratingScale` before you compose, not after you are refused: `rubrics:get { rubricRef }`, or `template_data->'ratingScale'`. Map deliberately — `healthy→pass`, `degraded→weak` — rather than assuming the words are interchangeable.

### 2. A legacy attestation is stored under observation.vetting, not the ARGUMENT's name

`scorecards:emit` takes `vettingConsult` as a flat string ARGUMENT and stores it as an OBJECT:

```
payload->'observation'->'vetting'  =  a structured critique link plus rubric-identity and critique details
payload->'observation'->>'vettingConsult'  =  NULL   -- always, even on a valid attestation
```

Querying the argument name is the natural thing to do and returns `NULL`, which is indistinguishable from "the vetting never landed" — and invites a pointless re-consult of a consult that is already closed and already cited. Always read `observation.vetting`.

Read the stored rubricRevision, criteriaHash, and rubricMeaningRevision together with the live rubric identity. Apply the D-010 order above; revision alone does not establish whether a legacy card is current.

### 3. A `tests` check is validated for PATH RESOLUTION, never for SUBJECT — a resolvable-but-irrelevant file passes and lies

`rubrics:propose` refuses a `check` whose path does not resolve against the live tree (D-006), and the grader's emit refuses a pass-rating over a red run (D-011). Neither mechanism can tell whether the file tests the criterion it is bound to. A green run on the wrong file therefore reads to every downstream grader as machine-confirmed evidence for a claim nobody verified — strictly worse than leaving the criterion prose-only, because prose-only at least declares itself as judgment.

**Open the candidate file and read its test names before binding it.** In the run behind this section, two of the three candidate files suggested during critique were the wrong subject and were rejected on exactly this ground: `spawn-readiness.test.ts` grades AGENT spawn admission and `local-backend-client-circuit.test.ts` grades the per-client request circuit, while the criterion was about local-backend COLD-START failure being bounded and named — both candidates would have run green while the criterion was broken. Record the rejection in the criterion's own `method` text, so the wrong candidate is not re-suggested and re-added later.

Two corollaries worth applying at bind time:

* **Bind the file that tests the criterion's CORE claim, not its cheapest neighbour.** Where a criterion insists on database-level enforcement, the integration test IS the criterion; the unit test over the JS validator is the thing that criterion explicitly calls insufficient. Check the file actually runs cheaply before worrying (`testing:runs { filePath }` gives the last duration — a real-PG integration test at \~1s is a fine binding; a Docker-gated one that cannot start would refuse the emit).
* **When a check covers only PART of a criterion, say so in the criterion's `method`.** A green run must not be allowed to imply the uncovered clause passed. Declare the partition explicitly — "the check covers clause 1; clause 2 has no automated coverage and must be graded on its own evidence" — so the grader inherits the boundary instead of the impression.

### 4. A legacy attestation card is audited — write it so an auditor can RE-RUN it

Your `scorecards:emit` against `meta-acceptance-rubric` is a scorecard like any other: it receives an independent grading-integrity audit (the card's `gradingAudit` stamp, dispatched automatically), and vetting reads `vetted` only once that audit **passes**. A revision of the grading-integrity meta-rubric re-opens settled audits, so an attestation that passed under an old revision can fail on re-audit.

Measured 2026-10-02 on `acceptance-work-on-everything-rubric-evidence-hardening-2026-09-20` rev 6: attestation EI-24711387607832509 FAILED rev-10 audit EI-24852491646605042 (instrument-split, terminal-re-rate, re-runnable-evidence). Its re-derived replacement EI-24854304791243030 PASSED (audit EI-24854415468269087). The differences:

* **Re-derive, don't cite.** Open each rating with the immutable `rubrics:get { rubricRef, revision }` call it judges, and re-derive every count over the FULL revision. Citing a critic's consult post, or carrying a conclusion from an earlier revision's attestation, failed: an auditor cannot re-run a post.
* **Pin tree evidence by blob at a commit** (`git rev-parse <sha>:<path>`), never a bare path. Evidence that pointed at a mutable table or an SQL fragment is what the re-runnable-evidence criterion rejected.
* **Quote live probe outputs verbatim** (the call and what it returned) for any criterion that names a probe.
* **A second attestation for the same rubric needs `acknowledgeExisting: true`.** Without it `scorecards:emit` refuses with `ok:false` inside the result body, while the invocation ledger still records the call as ok. Read the result, not the ledger.
* **Run a long emit detached and read the file**: `node scripts/mcp-call.mjs scorecards:emit --json-file <args.json> --client <your-su-id> > <out> 2>&1 &`. A foreground `capability:bash` window that times out loses the result even though the emit may still land; check `scorecards:list` before re-emitting.
* **Await the verdict instead of polling**: `events:await { event: "scorecard:grading-audit:<attestation id>" }` fires when the audit settles, with `state` and `auditIssueId` in the payload (EI-24852356444105284; live once :3070 deploys it). A stuck audit re-dispatches via `scorecards:repair { targetIds }`, which must run on a build that descends from the card's graded build (a lineage refusal records `dispatchBackoff` code `generation_incompatible` on the card).

### Budget note for a multi-check rubric

For scorecard emissions, the unique-file batch runs under ONE shared clamped budget, with results attributed back to each criterion, so a rubric with several `tests` checks can exhaust the emit on timeout. Direct critique itself does not run scorecard checks. That refusal is load-dependent and INTERMITTENT: retrying is valid **for the timeout refusal only**, and never for `check_contradicted` or an unresolved path — those are verdicts, not noise.
