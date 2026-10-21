# Papercusp architecture and design presenter notes

A 30 minute session for senior engineers: 28 minutes 20 seconds of proposed speaking allocations and 1 minute 40 seconds for questions. The appendix is for longer discussion. This is a development-source snapshot from 21 October 2026.

## Presentation sequence

Open index.html. Arrows advance, N toggles notes, O opens the overview, M opens the local architecture map. The toolbar opens either map. Escape closes a map; return focus to the deck before using slide keys. Maps retain the original interaction engine and start without narration.

## 1 Papercusp architecture and design

**Opening · 0:00–1:30**

Open with the problem: a useful agent can still forget, retry, die, race with another agent or claim success too early. Papercusp externalizes those concerns so the work is inspectable beyond a single transcript. The thesis is about explicit state and enforceable boundaries; it is not a claim that agent judgment has become reliable. Tell the audience that the second pass deliberately teaches the vocabulary without locating it in the architecture yet. The third pass will connect it. This is a snapshot of development-source architecture on 21 October 2026; availability is qualified where it matters.

Sources: `architecture:opening`, `architecture:s01`

## 2 One system, several boundaries

**1 · System · 1:30–3:00**

Start zoomed out. Point to the human, desktop/operator, agent processes, tool fabric, shared substrate, shared working tree and release boundary. Do not read every label. The diagram describes the local desktop development topology; federation and connected services cross explicit boundaries. The broader product can also have hosted workspaces: do not turn this local diagram into a universal deployment claim. Open the local map with M if questions require a zoom. Return with Escape.

Sources: `architecture:map`, `architecture:s01`

## 3 The choices that shape the machine

**1 · System · 3:00–5:00**

Explain why each choice exists before defending it. Shared state lets a successor and a human interrogate the same work instead of reconstructing a transcript. It also creates a real operational substrate: database pressure and migration correctness matter. MCP supplies the interface seam; Papercusp supplies the lifecycle, authority and coordination around it. The shared-checkout choice is the development workflow shown here, not a claim that no other integration topology exists anywhere in the product. Ask the room which tradeoff they would want to inspect first; keep deeper answers for the appendix.

Sources: `architecture:s01`, `architecture:s05`, `architecture:s11`

## 4 Move promises into inspectable state

**1 · System · 5:00–6:30**

These are cross-cutting concerns, not another stack of services. Explain the difference between durable truth, notification delivery and a model’s interpretation. A row alone does not ensure a message wakes a parked process; an event alone does not prove the work succeeded. Recovery and verification have to compose across the seams. We will return to four failure questions: what if an agent is wrong, dies, retries or arrives late?

Sources: `architecture:s05`, `architecture:s08`, `architecture:s12`, `architecture:s13`

## 5 The same pieces can travel

**1 · System · 6:30–7:30**

Cupboard makes extensibility part of the architecture. Show the local workspace boundary and the published shelf. Local use does not imply publication. Publication and installation do not imply activation or blanket trust. Different kinds have different review policies; do not say that everything is reviewed. Save package details for the third pass. The public page’s coming-soon markers remain authoritative for the flows it labels.

Sources: `cupboard:ways`, `cupboard:share`, `cupboard:trust`

## 6 Learn the vocabulary on its own

**2 · Concepts · 7:30–8:00**

Make the transition explicit: no system-placement diagrams during this pass. These are independent contract cards. Several are distributable through Cupboard; others are internal coordination primitives. A package kind is not necessarily a running process or a service.

Sources: `cupboard:make`, `architecture:s09`

## 7 Capabilities and structured data

**2 · Concepts · 8:00–9:20**

A tool is the capability seam; a plugin is one way to distribute runtime code; a datatype defines structured records. They are different axes. Explain guidance versus validation versus authorization: prose helps choose the right tool, schemas constrain its shape, and guards/authority constrain execution. Use abbreviated contracts, not a full namespace inventory. Show a source excerpt only if someone wants to inspect the seam.

Sources: `architecture:s09`, `cupboard:k-tools`, `cupboard:k-plugins`, `cupboard:k-datatypes`

## 8 Identity and policy

**2 · Concepts · 9:20–10:40**

Keep identity, blueprint and mode related without making them synonyms. Blueprints are composable definitions; a named identity is the role a session wears; a mode has registry state and a definition. Guard enforcement is more than an instruction to behave. The Cupboard example says an identity pins the installed guard before sessions wearing that identity apply it. A regular-expression guard is a teaching example, not a complete shell-language security boundary.

Sources: `architecture:s07`, `cupboard:k-identities`, `cupboard:k-rules`

## 9 Signals, reactions and time

**2 · Concepts · 10:40–12:20**

An event declaration is a vocabulary contract, emission is a transition signal, and a wait consumes a signal. A coordination gate can be declared first and latched for late joiners; do not extend that guarantee to every arbitrary event stream. A reaction is a separate edge from a tool call; a guard is a pre-call refusal. Routines separate time policy from executable behavior. Durable reaction delivery is at least once, so retries must be safe; never promise exactly-once effects.

Sources: `architecture:s06`, `architecture:s01`, `runtime-guide:events-and-rules`

## 10 Work and coordination

**2 · Concepts · 12:20–13:50**

A fleet is a leader/member work topology over these contracts. The leader deals with dependencies, stuck lanes and cross-lane decisions; members pull eligible work. Presence needs more than a heartbeat: live, parked and ended have different delivery consequences. A directed handoff needs a wake and evidence of pickup. File locks serialize actual edits; they are narrower than claiming an entire work item.

Sources: `architecture:s02`, `architecture:s03`, `architecture:s04`, `architecture:s05`

## 11 Live truth and durable continuity

**2 · Concepts · 13:50–15:30**

Do not collapse all durable information into ‘memory’. A checkpoint is in-flight work state, a fact is an explicitly standing conclusion with a lifetime, a transcript is a record of what was said, and semantic recall is selective retrieval. The carry inventory assembles identity, modes, held work, context and references for continuity; it does not make recovered prose inherently authoritative. Preserve owner-versus-machine provenance.

Sources: `architecture:s08`, `architecture:s13`, `runtime-guide:state-cells`

## 12 Reuse and evaluation

**2 · Concepts · 15:30–16:40**

Plans and goals can also be shared as reusable packages, with live execution state kept separate from the template. A recipe reduces repeated orchestration. A rubric makes the method and falsifier explicit; a scorecard records the result. A template helps new apps reuse maintained structure. The appendix holds the complete vocabulary and the corresponding public-page sections.

Sources: `cupboard:k-recipes`, `cupboard:k-rubrics`, `cupboard:k-templates`, `cupboard:k-apps`, `cupboard:k-themes`, `architecture:s10`

## 13 Put the contracts back in the machine

**3 · Composition · 16:40–17:10**

This is the same map as pass one. We now attach vocabulary to responsibility and follow causality. The walkthrough is an illustrated scenario; it does not mutate a live workspace. The optional live operator read is secondary evidence, not a dependency of the talk.

Sources: `architecture:map`, `architecture:s02`

## 14 1  Claim work, then execute a guarded action

**3 · Composition · 17:10–18:50**

Point to agent fleets, tool fabric, substrate and shared tree in that order. A claim makes ownership visible; file locks guard the write. A failed guard should leave an explicit refusal rather than letting prose override authority. The arrows describe the control path, not a distributed transaction across every component. The current scheduler can atomically claim and declare intent; do not imply all downstream actions are atomic with it.

Sources: `architecture:s04`, `architecture:s05`, `architecture:s09`, `cupboard:k-rules`

## 15 2  State changes cause reactions and wakes

**3 · Composition · 18:50–20:30**

Point to the substrate, tool fabric and agents. Distinguish work completion from notification delivery. In the runtime guide, a successful claim causes coordination emission through a lifecycle rule. For a latched coordination gate, a late waiter gets already_fired; do not claim that every event replays history. At-least-once delivery requires a stable deduplication key or idempotent effect. A timer timeout is evidence to investigate the producer, not evidence that it completed.

Sources: `architecture:s06`, `runtime-guide:events-and-rules`

## 16 3  Lose a session without losing the work

**3 · Composition · 20:30–22:10**

Point to agent processes, substrate and context/memory. Explain what dies: the OS process and its private context. Explain what should survive: the item, decisions, checkpoints, claims/lifecycle records and verified evidence. A successor still has to check authoritative state; it must not assume a prior shell command succeeded because a note says so. Claims and lock expiry/reconciliation are lifecycle mechanisms rather than magic crash-proof leases. Do not generalize this illustrative flow into a measured recovery SLA.

Sources: `architecture:s08`, `architecture:s13`, `architecture:s01-processes`

## 17 4  Turn a completion claim into releasable evidence

**3 · Composition · 22:10–24:10**

Follow the shared tree through the green gate to production. Plan acceptance and the release gate are distinct checks: the first addresses promised outcomes, the second judges a candidate build. The shared pipeline is asynchronous. A code edit does not instantly appear in the deployed application; final evidence must name the shipped artifact. Explain shared release coupling as a tradeoff, including ownership for red-gate recovery. This slide describes the development release pipeline, not a promise that every output must deploy a service.

Sources: `architecture:s11`, `architecture:s12`

## 18 5  Make the policy reusable

**3 · Composition · 24:10–26:10**

Use the Cupboard rule example. A rule folder contains rule.json and listing.json. The page’s current example blocks a force-push through a pre-tool guard. It is a bounded contract example, not a complete sandbox. Publish and review are a separate lifecycle from local execution. A new revision goes through the publication path; a previously approved version keeps serving while its successor waits. Rules and events are packages today, but asking the agent to author them is still marked coming soon on this page. Review differs by kind: the page lists tools/plugins/themes/templates immediately, while reviewed kinds wait. Pinning provides reproducibility; it does not prove code safe.

Sources: `cupboard:k-rules`, `cupboard:share`, `cupboard:trust`, `cupboard:next`

## 19 The engineering costs remain visible

**Design discussion · 26:10–27:40**

Invite technical disagreement. Which invariant would the audience choose to attack first? What state could drift? Where could backpressure accumulate? What if the host or database is down? The architecture makes those questions addressable; it does not eliminate them. Avoid unverified fleet-size, performance, reliability or cost claims. The static pages describe development-source mechanisms and cannot certify the currently installed release.

Sources: `architecture:s01`, `architecture:s12`, `cupboard:trust`

## 20 Follow the state, authority and evidence

**Discussion · 27:40–28:20**

Close with the same system model. Offer the two map references and appendix as the path for deeper questions. The intended takeaway is a causal model of the design, not recall of tool names. Prepared spoken time is 30 minutes; a real presenter should rehearse and decide whether to reserve a longer discussion slot.

Sources: `architecture:map`, `cupboard:map`

## 21 Discussion routes

**Appendix · Discussion appendix**

This appendix is outside the 30-minute core. Use overview to jump to a question, then return to the core closing slide.

## 22 Capabilities and composition vocabulary

**Appendix · Discussion appendix**

These are explanatory definitions, not a one-to-one service inventory. The source pages and current schemas settle exact behavior.

## 23 Work and coordination vocabulary

**Appendix · Discussion appendix**

Use the claim-versus-lock example when these are confused. A queue entry, a wake receipt and real progress are different observations.

## 24 Control flow and continuity vocabulary

**Appendix · Discussion appendix**

State, signal and context are different kinds of information. Do not imply every event is durable, every field is replicated, or every fact is permanent.

## 25 Two contracts worth inspecting

**Appendix · Discussion appendix**

These are abbreviated explanatory shapes, not executable copy/paste examples. Use the actual source for a current schema. Show the public page’s complete rule example if exact fields are requested. A real tool definition in coordination/tools/escalate.ts demonstrates guidance, authority, roles, emission and schema, but do not invoke it during the talk.

Sources: `cupboard:k-rules`, `source:tool`

## 26 What this snapshot establishes

**Appendix · Discussion appendix**

State the snapshot date. Check these labels before using the deck months later. Do not silently remove an availability boundary because the architecture diagram has a box for the feature.

Sources: `architecture:opening`, `cupboard:trust`, `cupboard:next`

## 27 Source and discussion references

**Appendix · Discussion appendix**

Local interactive maps remain available through the toolbar. External links are optional and are not needed to display the core talk. Keep source files open at prepared lines; never search for an implementation while narrating. The source manifest records the exact map capture and file hashes.

## Source key

- `architecture:<anchor>`: https://papercusp.com/architecture/#<anchor>; opening and map are the page opening and hero map.
- `cupboard:<anchor>`: https://papercusp.com/cupboard/#<anchor>.
- `runtime-guide:*`: repository papercusp-30-minute-demo-script-and-faq.md and papercusp-runtime-demo-example-files.md.
- `source:tool`: packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts; read its current defineTool definition rather than stale line numbers.

## Rehearsal before the room

1. Open the local deck and PDF; test display scaling and projector contrast.
2. Turn off notifications and unrelated windows. If using live pages, mute narration first.
3. Rehearse to the per-slide budget. The timings above are proposed spoken allocations, not measured human speaking time.
4. Keep a read-only work item with checkpoint and completion evidence ready in the operator; use it only if it supports a question. No new live fleet or destructive action is needed.
5. Open only two or three relevant source excerpts. Stop a live branch immediately if it fails; continue with the local trace.
6. Verify current availability labels before presenting a later product version.

## Discussion prompts

- Which durable fact authorizes the next side effect?
- Which operation is atomic, and which subsequent effects are retried?
- What happens when the operator, database, agent process or notification path fails?
- How do stale claims, late waiters and duplicate deliveries get distinguished?
- Which mechanisms are a project workflow choice versus a platform-wide contract?
- Where can a detector or an independent reviewer still be wrong?
