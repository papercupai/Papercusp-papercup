# Acceptance preparation: cloud portal Docs and Papercup

Plan: `cloud-portal-docs-and-papercup-faq-2026-10-06`.
Preparation owned by WI-10006846; eventual study belongs to P-009 / WI-10006923.

**Status: protocol only. No participant attempts, live chat matrix, independent
final acceptance or production shipment are recorded here.** The manual and
public-retriever lanes are unfinished. This document is not acceptance evidence.

## Entry conditions

Finish P-003, P-005, P-006, P-007 and the maintained/current-build checks in P-008
before the study. Use the executable current-build route returned for the
applicable test class by `dev:pipeline_position`; check its serving runtime and
record its build and loaded manual/FAQ revisions. Do not infer current behavior
from a source-tree hash or a green production checkout.

Use the existing public Docs destination, a prepared account, a connected
workspace and a disposable project suitable for a bounded README edit. Prepare
the account and environment before observing the participant; do not tell them
which links or controls solve a task. Record any setup help separately.

Do not make participants provision billable hosts, open another checkout,
reveal credentials, grant external access, publish work or destroy data as a
study shortcut. Hosting, costs, access and deletion understanding can be
observed through their explanation of the documented decision and expected
confirmation. That explanation is not evidence that the underlying operation
executed.

## Four tasks for each of three real participants

The participant prompts below intentionally do not name the solution links.
The observer's expected observations are kept separate from the prompts.

| ID | Participant prompt | Observer's expected observations |
| --- | --- | --- |
| T-1 | Find the instructions for getting started. Explain which account, workspace and project you will use, where the work runs, and how you know the workspace is ready. | Finds public Docs and Start here; distinguishes workspace/project and browser/desktop; can explain managed, own-cloud and local choices; does not treat a card alone as host readiness. |
| T-2 | In the prepared project, ask Papercup to improve the README introduction. Review and approve a small change, then find the changed result and decide whether it was checked. Keep it unpublished. | Uses a bounded task, recognizes the approval and execution route, opens the actual result and distinguishes implemented/verified/shipped. The observer records the actual result and checks, not just a completion badge. |
| T-3 | Find out who pays for the product, model use and hosting. Explain what you would verify before paying, stopping a host or deleting it, and what costs or data might remain. | Distinguishes subscription/model/provider charges; understands payment confirmation, retained-resource costs, stop versus delete, and the required backup/restore route before deletion. |
| T-4 | Find guidance for keeping project data private and recovering from a problem. Explain who can access it, what you would send in a support report, and how you would check that a backup can be restored. | Distinguishes public Docs from private Project docs; does not equate authentication with authorization or a chat with a backup; identifies supported recovery, redacted error evidence and secrets that must not enter chat/support. |

Each person attempts all four tasks on the recorded build. Participants must be
real non-technical people; an agent role, scripted browser, invented transcript
or retrospective recollection cannot substitute for these observations.

## Observation and decision rules

Use pseudonymous participant IDs. Retain a redacted source record and timestamp
for each attempt, with the build/content revision, route taken, result,
assistance, confusion and the evidence reference. Leave unobserved fields
`unknown`. Record elapsed time if measured; do not introduce a new time cutoff.

An uncoached success requires the participant to find and complete the task or
give the applicable correct explanation without a hint that supplies the
answer. If coaching becomes necessary, preserve the attempt as coached; do not
later relabel it as an uncoached success.

The current R-8 clause requires three people, twelve observed attempts and at
least ten uncoached successes, with no misunderstanding of billing
responsibility, privacy boundaries or destructive actions. These quantitative
thresholds are disclosed agent-derived acceptance choices under D-006/D-007,
not observed outcomes. Any critical misunderstanding or unrepaired confusion
fails the bar even if the numerical threshold is reached.

File and assign each observed defect before leaving it behind. Repair the
documentation or behavior and rerun affected cases. Preserve original failures
and distinguish reruns from initial attempts; a remembered solution after
coaching does not independently establish novice discoverability. Re-read the
current R-8 contract before deciding the outcome.

## Evidence still required before independent acceptance

- `walkthrough.md`: current-build journeys for all seven everyday flows from
  `page-pattern.md`, with actual labels, expected results and recovery; docs
  navigation, keyboard, mobile, themes, Pagefind search and stable deep links.
- `chat-cases.md`: the actual current-build portal Papercup runtime and loaded
  content revision, FAQ-first cases, fuller-guide fallback, seed paraphrases,
  misspellings, ambiguity/no-match and fresh sessions/installation.
- The R-6 matrix: current facts supported by authorized live evidence,
  stale/conflicting/missing/unavailable sources, retrieval/index outages and
  prompt injection. Pair a seeded public positive control with a private
  negative control in the same run; empty retrieval cannot prove isolation.
- R-7: a changed canonical revision actually invalidates the public retriever's
  cached/indexed answer and produces accountable sensitive review. The unit
  drift certificate and optional adapter callback alone do not discharge this.
- Redacted real participant observations, confusion repairs and affected
  reruns, followed by independent acceptance of the current evidence cohort.

Missing artifacts or missing observations remain unknown. Do not recruit a
final grader while the author acceptance contract or required proof is not
ready; retain the already completed source-conversation audit and rubric
vetting rather than repeat them without a new invalidation.

## Avi's acceptance and exact shipment

Present the concrete accepted build and remaining limitations to Avi, and retain
the actual acceptance response. P-010 follows that acceptance. Use the existing
publication paths and verify the exact deployed artifact: served document
routes, FAQ anchors and Pagefind assets against the accepted built artifact,
deployed build identity, and the actual production Papercup runtime with its
loaded content revision and conceptual/live-state behavior.

A staging result, commit, source hash, deploy request or agent assertion is not
a production observation. Preserve the approved headless P-003/P-005 execution
route; this session does not own LIVE_GATE_OPS. Do not force a red deployment or
claim shipped from this preparation document.
