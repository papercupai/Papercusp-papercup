# Spec-driven development tools: audit and what Papercusp should take from them

- **Date:** 2026-10-05
- **Requested by:** Avi (owner, interactive), directive #1345: "Do a thorough audit of all the spec tools like speckit, which features do you think we should integrate into papercusp? How?"
- **Work item:** WI-10006136 · **Author:** su-18b69883
- **Status:** recommendations only. Nothing here is approved or scheduled; every recommendation is the author's judgement, not an owner decision.

**Evidence limits.** External facts come from web-search result summaries. Direct page fetches were refused for this whole session by the WebFetch restriction check timing out (EI-25169560193283880), so no tool's repository or docs were read first-hand. Version numbers, command names and benchmark figures are secondary-source and are marked as reported. Papercusp facts come from direct reads of the database, tools, docs and work items, and are cited.

## 1. Summary

The field has converged on three lessons:

1. Resolve ambiguity before building.
2. Couple specs to code by machine, not by asking the agent to read markdown.
3. Scale ceremony to the size of the change.

Papercusp is already ahead of every tool surveyed on lesson 2: revisioned requirement clauses, evidence bound to exact revisions, re-measurement when files change, and grading by a non-implementer. It is behind on lessons 1 and 3, and on one more thing: our specs die when a plan ships.

Recommended integrations, ranked by value:

| # | Feature | Borrowed from | Size |
|---|---|---|---|
| R1 | Proportional tracks: acceptance depth scales with change size and blast radius | BMAD, Zenflow, Kiro Quick Spec, GSD quick, Spec Kit short path, Spec Growth Engine | Medium; owner decision needed |
| R2 | Clarify pass before a plan activates | Spec Kit `/clarify`, GSD discuss, Agent OS `/shape-spec`, Superpowers brainstorming | Small |
| R3 | Living capability specs with delta merge at ship | OpenSpec, Augment Intent, Spec Kitty | Large; needs its own plan |
| R4 | Post-ship drift detection on shipped requirements | Spec Growth Engine, Tessl link checks | Medium; depends on R3 |
| R5 | Converge loop: failing clauses become gap work items automatically | Spec Kit `/converge`, GSD `--gaps`, Traycer | Small |
| R6 | EARS-shaped clauses and derived property tests | Kiro | Small to medium |
| R7 | Context pack at claim time | BMAD story sharding, Spec Growth Engine Spine, Agent OS inject-standards | Small to medium |
| R8 | Import/export of `.specify/` and `openspec/` folders | Spec Kit, OpenSpec | Small; only on demand |

Explicitly rejected: per-agent git worktrees, spec-as-source regeneration, simulated persona teams, a second spec directory beside the plan store, and adopting Spec Kit or any other tool wholesale. Reasons are in section 5.

## 2. Tools surveyed

| Tool | Form | Core flow | Spec lifetime | Enforcement | Distinctive features |
|---|---|---|---|---|---|
| **GitHub Spec Kit** (v1.0.x; ~116k stars per the June 2026 newsletter) | Python CLI + agent slash commands, 40+ agents | constitution → specify → clarify → plan → tasks → analyze → implement → converge | Spec-first; `converge` (June 2026) adds a code-vs-spec loop | Advisory: clarify, analyze and checklists do not block | Constitution; `/clarify` ambiguity taxonomy; `/analyze` cross-artifact consistency; checklists ("unit tests for English"); presets, 120–160 extensions, bundles, a programmable workflow engine |
| **Spec Kitty** (Spec Kit fork) | Python CLI | spec → plan → tasks → next → review → accept → merge | Spec-anchored (specs, review state and merge decisions stay in the repo) | Human review/accept gates | Work-package lanes, kanban dashboard, worktree per agent, auto-merge, "missions" |
| **OpenSpec** (Fission AI, v1.14) | Node CLI; the CLI itself never calls a model | proposal → delta specs + design → tasks → apply → verify → archive | **Spec-anchored**: `openspec/specs/` is the living truth; each change is a delta | `verify`; archive refuses stale MODIFIED | ADDED/MODIFIED/REMOVED/RENAMED deltas (REMOVED needs Reason + Migration); archive merges deltas into living specs; custom YAML schemas define the artifact dependency graph; no phase lock |
| **Kiro** (AWS IDE + CLI) | IDE, Bedrock-routed | requirements (EARS) → design → tasks | Spec-first | Property-based tests derived from EARS ("evidence, not proof", per AWS) | EARS notation; design "correctness properties"; dependency-wave task execution; steering files with inclusion rules; file-event hooks; Quick Spec mode; lock-in |
| **BMAD-METHOD** v6 | Agent personas + workflows + installer | analysis → planning → solutioning → implementation | Partly anchored | Readiness check; retrospective rejects epics with unfinished stories | **Scale-adaptive tracks** (Quick Flow / Method / Enterprise); PRD and architecture sharded into self-contained story files; role agents (analyst, PM, architect, UX, scrum master, dev, QA) |
| **Tessl** | Framework (MCP, closed beta) + Registry | spec → generate/describe → test | **Spec-as-source** (generated code marked DO NOT EDIT) | `@test` links and `targets` validated by scripts | 10k+ library usage specs (registry); file-ownership `targets`; regenerate-and-verify |
| **Superpowers** (obra) | Claude Code skills | brainstorm → worktree → plan → subagent execution → review → finish | Spec-first | Enforced TDD (code written before its test is deleted); two-stage review per task | Brainstorming hard gate; 2–5 minute tasks; fresh subagent per task; spec-conformance review then code-quality review |
| **GSD** (Get Shit Done) | Claude Code meta-prompt system | per phase: discuss → plan → execute → verify | Spec-first, with state files | Plan checker loops until requirements are covered; VERIFICATION.md + UAT.md | Decisions captured in CONTEXT.md; wave-parallel execution in fresh contexts; gap-closure plans (`--gaps`); `/gsd-quick`; STATE.md resume |
| **Agent OS** v3 | Commands + standards files | discover standards → shape-spec (inside plan mode) | Spec-first | None | **Discovers standards from the codebase**, indexes them, injects only the relevant ones; product mission/roadmap/tech-stack; v3 retired its implementation phases |
| **Taskmaster AI** | CLI + MCP (7/15/36-tool tiers) | PRD → task graph → expand → next | Task-level | None | **Complexity score 1–10 → recommended subtask count**; dependency validation; tagged contexts per branch or feature |
| **Traycer** | Layer above coding agents | phases → plans → handoff → verification | Spec-first | Post-hoc verification labelled Critical/Major/Minor/**Outdated** | Epic mode; "Bart" orchestrator loop |
| **Factory Droid Spec Mode** | Mode inside the Droid CLI | read-only research → spec → approve → implement | Optional save | Approval gate before any edit | Headless runs default to spec mode |
| **spec-workflow-mcp** | MCP server + dashboard + VS Code extension | requirements → design → tasks | Spec-first | Dashboard approvals with revisions | Approval requests per document; implementation logs. A fork, SpecFlow, was archived 2026-09-26 by its author for token cost |
| **Augment Intent** | macOS workspace | coordinator writes the spec → specialists in worktrees → verifier | **Living spec, updated both ways** as agents finish | Verifier checks code against the spec before integration | Spec changes propagate to active agents; three human checkpoints (spec, tasks, diffs). Sources are mostly vendor-authored |
| **Zenflow** (Zencoder) | Desktop app | Quick Change / Fix Bug / Spec and Build / Full SDD | Varies | Varies | Workflow chosen by scope; worktree per task |
| **cc-sdd** | Community Kiro-style commands for Claude Code | requirements → design → tasks | Spec-first | None | Low-friction terminal workflow |
| **Consort** (Databricks; arXiv 2609.09671) | Research + open-source framework | spec lane (agree, then freeze intent) → enforced TDD build lane | Frozen per change | **Controls the agent cannot edit**: deterministic orchestrator, human gates, immutable tests, green required on a live branched database | Spec-and-test-list gate before build; copy-on-write database branch per work item |
| **Spec Growth Engine** (arXiv 2606.27045) | Design paper, no code | vertical slices, hardest first | Spec-anchored, code-coupled | **Drift gate**: spec–code divergence blocks merge | Spec graph; "Spine" context assembler scoped to the ownership path; **review overhead matched to blast radius** |

## 3. What the evidence says about these tools

- **Markdown volume is not value.** Böckeler (Thoughtworks) found Kiro turned a small bug into 4 user stories and 16 acceptance criteria. On a mid-sized feature, Spec Kit produced so many files she never finished: "I'd rather review code than all these markdown files." Scott Logic reported Spec Kit about 10× slower than iterative prompting. One head-to-head (reported) took 12 min with OpenSpec, 90 min with Spec Kit and 5.5 h with BMAD for the same feature. One benchmark (reported) measured 91,729 vs 181,040 tokens for OpenSpec vs Spec Kit.
- **A spec the agent merely reads is not enforced.** Every critique lands here. "AI can ignore your spec — it can't ignore a failing test" (Optivem). Consort and the Spec Growth Engine are the two serious answers, and both put the controls outside the agent's reach.
- **Ceremony must scale.** Nearly every tool added a light path after launch: Kiro Quick Spec, Spec Kit's 5-step short path, GSD quick/fast, BMAD Quick Flow, Zenflow Quick Change, OpenSpec custom schemas. That is the market's verdict on fixed pipelines.
- **The positive evidence is mostly self-reported.** SNCF Connect & Tech reported 2–4× velocity. Nothing in the results was an independent controlled study.

## 4. Papercusp today, mapped against the tools

| Capability | Tools that have it | Papercusp today | Verdict |
|---|---|---|---|
| Requirements / design / tasks inside a spec | Kiro, Spec Kit, OpenSpec, spec-workflow-mcp | **Already adopted from Kiro** (2026-08-09, WI-36725): `## Requirements` + `## Design` + P-NNN items inside the plan. Applies only to plans created after the epoch; opt-out via `specTriad: exempt`; missing triads get an auto-filed work item | Have. Noisy (see below) |
| Constitution, steering, standards | Spec Kit, Kiro, Agent OS, BMAD | CLAUDE.md doc parts (scoped by client and stack), personas, guard-rail facts, and `conventions:governing` (declared conventions plus plan decisions relevant to an `about`) | Have. No codebase → standards discovery for *user* repos |
| Forward-looking ambiguity scan before planning | Spec Kit `/clarify`, GSD discuss, Agent OS `/shape-spec`, Superpowers brainstorming | The activation audit checks that nothing from the conversation was lost (backward-looking). Nothing asks what was *never said* | **Gap** → R2 |
| Requirement-quality check | Spec Kit checklist/analyze | `plans:evaluate-spec-quality`; rubric vetting | Have |
| Task graph, dependencies, parallel waves | Kiro, GSD, Taskmaster, Spec Kitty | P-NNN items, `blocked-by` links, scheduler, fleets with claims and locks | Have (stronger) |
| Complexity-driven decomposition | Taskmaster, BMAD | None found | Minor gap (folds into R1) |
| Spec ↔ test linkage | Tessl `@test`, OpenSpec verify | 5,246 revisioned clauses (falsifier, required evidence and test layers, mutation flag, supersession) and 23,449 evidence bindings pinned to exact clause revisions, re-measured when bound files change | Have (far stronger) |
| Independent verification | Intent, Traycer, Superpowers, Spec Kitty | Grading by a non-implementer outside the author's lineage; code-truth audit with blob SHAs; implementer verdict | Have (stronger) |
| Tests fixed before the build | Consort, Superpowers, ATDD | The harness V2 tester writes one black-box test per VAL. Plan rubrics are deliberately written *after* implementation | Partial, by design |
| Gap → task loop | Spec Kit converge, GSD `--gaps`, Traycer | A failed check returns work to implementation, but gap items are not generated automatically | **Gap** → R5 |
| Specs that outlive the change | OpenSpec, Intent, Spec Kitty | Clauses are keyed by `plan_slug`; the rubric retires at ship; `project_spec_revisions` exists with **0 rows** | **Largest gap** → R3 |
| Drift gate after ship | Spec Growth Engine, Tessl | Evidence is re-measured only while the plan is live; doc-claims pins cover prose only | **Gap** → R4 |
| Proportional ceremony | BMAD, Zenflow, Kiro, GSD, Spec Kit, Spec Growth Engine | Plan classes exist (feature-ship / bugfix / migration / investigation), but the acceptance path is the same for every plan | **Gap; biggest cost lever** → R1 |
| Structured requirement notation | Kiro (EARS) | Clause behaviour is free text plus a falsifier | Minor gap → R6 |
| Per-task context pack | BMAD shards, GSD, Spine, Agent OS | Plan decisions inline on claim; `operationalBrief`; `conventions:governing` | Partial → R7 |
| Approval checkpoints | spec-workflow-mcp, Kiro, Intent | AskUserQuestion, `review:approve`, the plan Acceptance gate UI | Have |
| Per-agent worktrees | Spec Kitty, Intent, Zenflow, Superpowers | Deliberately not used: shared staging tree plus locks. Pot-level isolation is planned (`pot-review-integration-mode-2026-10-05`) | Reject |
| Spec-as-source | Tessl | None | Reject |
| Library usage specs | Tessl Registry | Context7 | Have, via Context7 |

### Two measured warnings from our own history

1. **The Kiro triad adoption produced mostly queue noise** (EI-25176186379413042, measured today). There are 680 "Write the spec triad for plan …" work items: 119 done, 414 dropped, 147 open. 203 of them target `acceptance-*` companion plans (5 done, 150 dropped, 48 open), and some plans were re-nagged after a drop. Lesson for every recommendation below: **an adopted ceremony needs proportionality and an exemption path that sticks, or it becomes noise.**
2. **Acceptance is where the time goes.** The 2026-09-23 review-system time audit (WI-10002583, `docs/evidence/review-system-time-audit-2026-09-23.md`) measured 3h20m of acceptance on one plan. Its finding: "most of that time went to rework caused by the review machinery, not to the checks themselves." Its follow-up plan, `review-system-rework-reduction-2026-09-23`, has every item terminal (25 done, 15 dropped). It fixes the *mechanics* of evidence and review: clause identity, vet-before-proof, re-measuring only touched paths, pull-based review. It does not change *how much* acceptance a plan owes, how clear the intent is before a BAR is written, or what happens to a spec after ship. R1–R4 target exactly those three gaps, so they complement that plan rather than duplicate it.

## 5. Recommendations

### R1. Proportional tracks — highest value; needs an owner decision

**What.** Every plan carries a `track:` value — `quick`, `standard` or `full` — that sets how much spec and acceptance it owes. This is BMAD's scale-adaptive planning plus the Spec Growth Engine's rule that review overhead should match blast radius.

**How.**
- **Where it lives.** Store `track` in plan frontmatter, beside the existing `specTriad:` and plan class. Reuse the triad's precedent: an explicit field with an override reason.
- **Default track.** `plans:new` proposes one from cheap signals:
  - item count;
  - predicted blast radius: workspaces selected by `scripts/affected-tests.mjs --print-affected` for the declared paths, and `gitnexus.impact` on named symbols;
  - plan class;
  - whether the plan touches the dangerous set (auth/security, migrations, outward publish, dark flags), which forces `full`.
- **Overrides.** The author can change the track with a stated reason, recorded as a plan Decision.
- **What the track controls.** Triad required? Clarify required (R2)? Criterion count (quick 1–3, standard 3–5, full 3–7)? Consult vetting (the time audit found 304 of 309 consults expired with no exchange)? `mutation_required` on clauses? Design-phase evidence? An owner UAT walkthrough (GSD's `verify-work`), only on `full`?
- **Measurement.** Use the per-plan efficiency read shipped as rework-reduction P-032 to compare acceptance time and binding churn per track, before and after.

**Owner decision needed.** Today `force` "NEVER waives rubric existence, vetting, independent grading, or the implementer's verdict", and that rule is uniform. A `standard` track that skips consult vetting or reduces criteria changes acceptance policy, so it is the owner's call. My proposal keeps independent grading on every track and varies only depth.

**Why first.** It is the only recommendation aimed at the measured cost centre. It also answers the original ask behind the time audit: "improve … without hurting the functionality."

### R2. Clarify pass before activation — small

**What.** Before a plan goes `draft → ready`, scan its Requirements for what is *missing* (not what was lost), then resolve the gaps in a single batch.

**How.**
- **Verb.** Add a `clarify` phase to `plans:audit`; reuse it rather than adding a parallel verb.
- **Inputs.** `## Requirements`, the plan Decisions, `conventions:governing({ about: <plan> })`, and the source conversation (the activation audit already re-reads it).
- **Taxonomy.** Spec Kit's categories (scope, data model, UX, non-functional requirements, integrations, edge cases, trade-offs, terminology, completion signal), plus Papercusp-specific ones:
  - which evidence plane proves it (staging vs deployed);
  - feature-flag default;
  - migration and rollback;
  - multi-machine behaviour;
  - who grades it.
- **Output.** A short ranked list of questions, each with a recommended answer (Spec Kit's pattern).
- **AUTO off.** One batched AskUserQuestion. Answers become `plans:add-decision` entries tagged `[owner:…]` and are folded into Requirements.
- **AUTO on or headless.** The agent takes the recommended answers, records them as Decisions tagged `[inferred]` assumptions, and lists them in `## Now` and the completion. The owner sees every assumption and the flow never blocks.
- **Gate.** Required on `full`, advisory on `standard`, skipped on `quick`. A recorded "skipped: no material ambiguity" also satisfies it.

**Why.** Rework-reduction P-003/P-004 tightened the step from BAR to proof. Nothing checks the step from intent to BAR. My unmeasured hypothesis is that this cuts BAR amendments, the most expensive event in the time audit. P-032's read can test that.

### R3. Living capability specs with delta merge — large; needs its own plan

**What.** OpenSpec's core idea. A durable spec per *capability* (for example "coordination: file locks" or "release gate") holds the current promises. A plan carries deltas against it. At ship, the deltas merge in.

**How.**
- **Data.**
  - A clause gains an optional `capability_slug` and an owner.
  - Plan clauses declare `delta_op ∈ {added, modified, removed, renamed}` against a base capability clause revision.
  - `plan_spec_clause_revisions` already has `supersedes_spec_id` / `supersedes_revision` and `content_hash`, which is enough for optimistic concurrency.
  - `removed` requires a reason and a migration note (OpenSpec's rule).
- **Ship-time merge.** `plans:set-plan-status { status:'shipped' }` merges the accepted clause revisions and their live evidence bindings into the capability.
  - It refuses a `modified` whose base revision is no longer current. This is OpenSpec's archive safety, which closed a bug where a stale MODIFIED deleted scenarios added by an earlier archive.
  - It reports the conflict for re-basing instead of overwriting.
- **Reads.**
  - `capabilities:get { slug }` returns the current promises, each with evidence freshness.
  - A capability page sits in the plan viewer.
  - `plans:new` suggests the capabilities a plan touches (from declared paths) and preloads their clauses as regression guards.
- **Reuse first.**
  - Find out why `project_spec_revisions` has 0 rows before choosing between reviving and dropping it.
  - Do not backfill all 5,246 clauses; seed capabilities only from shipped plans' accepted clauses in a few high-churn areas.
- **Owner decisions.** The capability taxonomy, and who owns each capability.

**Why.** Today "what does the system currently promise about X?" can only be answered by digging through old shipped plans. Every new plan also re-derives its regression surface from scratch.

### R4. Post-ship drift detection — medium; after R3

**What.** Keep re-measuring shipped capability clauses after their plan is closed. This is the Spec Growth Engine's drift gate, started in advisory mode.

**How.** Bound evidence already stores `sourcePaths` / `testPaths` with hashes, and re-measurement already exists for live plans. Extend that sweep to capability clauses:
- When a commit moves a bound file, mark the clause `stale`; the affected tests still run through `test:affected`.
- File one deduplicated work item per capability, owned by the capability owner, listing the stale clauses (Traycer's "Outdated" label).
- Consider making it blocking at the green-checkpoint only after the advisory phase shows few false alarms.

**Why.** It turns "the plan shipped" into "the promise is still kept" at negligible extra test cost.

### R5. Converge loop — small

**What.** Spec Kit's `/converge` and GSD's `--gaps`: evaluate, turn every gap into a task, re-run until converged.

**How.**
- **Recipe first (reuse-first).** A `code:run` recipe that:
  - calls `plans:evaluate-spec-test-adequacy` and the `plans:audit` code-truth phase;
  - for each non-passing clause, calls `work_items:create` linked to the clause, deduplicated on `spec_id` + revision;
  - labels each gap critical / major / minor / outdated.
- **Promote later.** Turn it into a `plans:converge { slug, dryRun }` verb only if the recipe gets reused.
- **Reuse.** `plans:certify-spec-clauses` already reports the non-passing clauses.

**Why.** It removes hand-built gap tracking from every acceptance cycle.

### R6. EARS-shaped clauses and property tests — small to medium

**What.** Kiro's EARS notation ("WHEN … THE SYSTEM SHALL …") as an optional structure on clause behaviour, and a property test for clauses that are invariants.

**How.**
- Optional structured fields on clause revisions: `pattern` (ubiquitous / event / state / unwanted / optional), `trigger`, `precondition`, `response`.
- `plans:evaluate-spec-quality` lints vague words ("fast", "should", "robust") and missing triggers.
- Clauses with `behavior_class` = invariant suggest a property-based test, using the existing `counterexample` evidence kind.

**Why.** It makes falsifiers easier to write and rubric criteria easier to trace. Kiro's own caveat applies: the notation is not executable by itself.

### R7. Context pack at claim time — small to medium

**What.** BMAD sharding and the Spine assembler: a claimed work item arrives with exactly the context it needs.

**How.** Extend what `scheduler:get_next` / `work_items:claim` already return (plan decisions inline) with:
- the clauses the item must satisfy, with falsifiers;
- `conventions:governing` for the item's paths;
- the touched capability clauses (once R3 exists);
- `gitnexus.context` for named symbols.

All of it is bounded by the tool result cap.

**Why.** It means fewer cold re-derivations after a claim or a carry-respawn.

### R8. Spec Kit / OpenSpec interop — small; only on demand

When `harness:generate-from-repo` brings in a repo that has `.specify/` or `openspec/`, offer to import it as plan Requirements, Design, items and clauses, so fleets can execute it. Export of a plan as an OpenSpec change folder for outside collaborators is optional. Build it only when a user actually brings such a repo.

## 6. What not to adopt, and why

- **Any tool wholesale, or a second spec directory.** Markdown specs in the repo would compete with the Postgres-canonical plan and clause store, which breaks the storage policy and starts drifting immediately. Kiro's triad was correctly adopted *inside* the plan for this reason (WI-36725).
- **Per-agent git worktrees** (Spec Kitty, Intent, Zenflow, Superpowers). The shared staging tree plus locks is a deliberate design, and a whole feature was lost to a stray worktree on 2026-06-30. Isolation at pot level is being designed separately.
- **Spec-as-source regeneration** (Tessl). This is model-driven development's old problem plus non-determinism. Our code is the artifact; clauses and evidence keep it honest.
- **Simulated persona teams** (BMAD, Consort's role ensemble). Papercusp has real role blueprints and fleets; simulated personas spend tokens on theatre.
- **Tests frozen before the build as a default** (Consort). Writing the rubric after implementation is a deliberate Papercusp decision, and the harness tester already covers VAL-level black-box tests. R2's clarify output gives the late rubric firmer anchors without reversing that decision. Worth revisiting only for `full`-track plans if R2 does not reduce amendments.
- **Approval dashboards** (spec-workflow-mcp). We already have the surfaces: AskUserQuestion, `review:approve`, and the plan Acceptance gate.
- **Library usage-spec registry** (Tessl). Context7 already fills this role.

**Adjacent idea, out of scope.** Consort's copy-on-write database branch per work item. We have throwaway per-run Postgres (`VERIFY_TAURI_ISOLATED_DB=1`, testcontainers) but not per-work-item branches. It belongs with test infrastructure, not spec tooling.

## 7. Suggested sequencing

1. **Now, small:** R5 as a recipe; R2 in advisory mode; fix EI-25176186379413042 (the triad noise) so R1 and R2 do not repeat it.
2. **Owner decision, then build:** R1. Measure acceptance time and binding churn per track with the P-032 per-plan read before and after.
3. **Own plan:** R3 and R4 together, starting with a capability taxonomy for two or three high-churn areas.
4. **Opportunistic:** R6 and R7 alongside R3; R8 only on demand.

## 8. Decisions only the owner can make

1. **R1.** May `standard`-track plans skip consult vetting and carry fewer criteria, while every track keeps independent grading?
2. **R2 under AUTO.** Should the clarify pass *assume* (record `[inferred]` decisions and continue) or *ask* and wait?
3. **R3.** Who owns capability specs, and do we start from a small hand-picked set of capabilities?

## 9. Sources

- GitHub Spec Kit — [repo](https://github.com/github/spec-kit), [June 2026 newsletter](https://github.com/github/spec-kit/blob/main/newsletters/2026-June.md), [releases](https://github.com/github/spec-kit/releases), [quickstart](https://github.github.com/spec-kit/quickstart.html), [v1.0.13 review](https://vibecoding.app/blog/spec-kit-review), [Scott Logic](https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html), [Xebia](https://xebia.com/blog/building-software-with-spec-kit/)
- Spec Kitty — [Priivacy-ai/spec-kitty](https://www.linkedin.com/posts/roberttdouglass_github-priivacy-aispec-kitty-spec-driven-activity-7424913519604670465-mpFX), [skillsllm profile](https://skillsllm.com/skill/spec-kitty)
- OpenSpec — [repo](https://github.com/Fission-AI/OpenSpec), [concepts](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md), [OPSX](https://github.com/Fission-AI/OpenSpec/blob/main/docs/opsx.md), [changelog](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md), [delta tracking explainer](https://codemyspec.com/blog/openspec-explained)
- Kiro — [complete guide](https://thepromptshelf.dev/blog/amazon-kiro-ide-complete-guide-2026/), [AWS Builder: steering, powers, hooks, specs, skills](https://builder.aws.com/content/3CSqR2TiDguv0Pg6EKn1LLswZ5i/building-production-ready-agents-with-kiro-steering-powers-hooks-specs-and-skills), [review](https://axonbuild.com/blog/kiro-ide-review)
- BMAD — [changelog](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/CHANGELOG.md), [planning tracks](https://deepwiki.com/bmadcode/BMAD-METHOD/4.2-context-engineered-development-(ide)), [explainer](https://codemyspec.com/blog/bmad-method-explained)
- Tessl — [launch](https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry), [SDD tile](https://github.com/tesslio/spec-driven-development-tile), [review](https://codemyspec.com/blog/tessl-review)
- Superpowers — [guide](https://blog.marcnuri.com/superpowers-claude-code-skills-framework), [deep dive](https://www.heyuan110.com/posts/ai/2026-02-01-superpowers-deep-dive/)
- GSD — [user guide](https://github.com/gsd-build/get-shit-done/blob/main/docs/USER-GUIDE.md), [phase cycle](https://zread.ai/gsd-build/get-shit-done/15-phase-development-cycle-discuss-plan-execute-verify)
- Agent OS — [v3 discussion](https://github.com/buildermethods/agent-os/discussions/310), [shape-spec](https://github.com/buildermethods/agent-os/blob/main/commands/agent-os/shape-spec.md), [review](https://codemyspec.com/blog/agent-os-review)
- Taskmaster — [repo](https://github.com/eyaltoledano/claude-task-master), [task structure](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md)
- Traycer — [docs](https://traycerai.mintlify.app/), [blog](https://traycer.ai/blog/build-with-intent-ship-with-confidence)
- Factory Spec Mode — [docs](https://docs.factory.ai/cli/user-guides/specification-mode)
- spec-workflow-mcp — [repo](https://github.com/Pimzino/spec-workflow-mcp)
- Augment Intent — [profile](https://specdriven.com/landscape/intent), [walkthrough (vendor)](https://www.augmentcode.com/guides/intent-walkthrough-prompt-to-merge)
- Zenflow, cc-sdd — [InfoWorld](https://www.infoworld.com/article/4171332/4-cutting-edge-tools-for-spec-driven-development.html), [cc-sdd deep dive](https://zenn.dev/tmasuyama1114/articles/cc_sdd_whole_flow?locale=en), [spec-compare (20 tools)](https://github.com/cameronsjo/spec-compare)
- Consort — [arXiv 2609.09671](https://arxiv.org/abs/2609.09671), [Databricks blog](https://www.databricks.com/blog/introducing-consort-test-driven-development-branching-database)
- Spec Growth Engine — [arXiv 2606.27045](https://arxiv.org/abs/2606.27045)
- Critiques and comparisons — [Böckeler, martinfowler.com](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html), [Optivem ATDD](https://journal.optivem.com/p/spec-driven-development-make-specs), [Reenbit](https://medium.com/@reenbit/bmad-vs-spec-kit-vs-openspec-choosing-your-spec-driven-ai-framework-in-2026-a6996b3ebb8d), [Fontoura (Sep 2026)](https://felipefontoura.com/articles/spec-driven-development-tools-compared/), [RSMuthu/SDD-comparison](https://github.com/RSMuthu/SDD-comparison), [Martinelli](https://martinelli.ch/why-spec-driven-development-tools-fail-in-the-enterprise/)
- Papercusp internals — WI-36725 (triad adoption), EI-25176186379413042 (triad noise), WI-10002583 and `docs/evidence/review-system-time-audit-2026-09-23.md` (time audit), plan `review-system-rework-reduction-2026-09-23`, tables `harness_shared.plan_spec_clauses` / `plan_spec_clause_revisions` / `spec_evidence_bindings` / `project_spec_revisions`, tools `conventions:governing`, `plans:evaluate-spec-quality`, `plans:certify-spec-clauses`, `plans:bind-spec-evidence`.
