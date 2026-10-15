# Portal Docs and Papercup baseline

Recorded 2026-10-06 for P-001 / WI-10006915 of
`cloud-portal-docs-and-papercup-faq-2026-10-06`.

This is a source inventory and gap record. It is not a claim that the revised
manual, retrieval, novice study, or production shipment passes acceptance.
The portal source checkout is
`~/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal`.
Product/manual sources are in the canonical Papercusp `staging` tree. Portal
edits require that repository's separate coordination-domain locks.

## Everyday journeys

Each row distinguishes source observations from behavior still requiring a
current-build walkthrough. Portal paths below are relative to its source checkout.

| R-2 journey | Source and current documented behavior | Gap or explicit unknown |
| --- | --- | --- |
| Account and organization | `apps/papercusp-docs/src/content/docs/accounts-and-billing.mdx` distinguishes account creation, sign-in, organization access, integrations and subscriptions. It anchors `packages/operator-core/lib/auth/hosted/self-signup.ts`. Portal `packages/ui/src/auth.tsx` and `accounts-dock.tsx` are the UI review targets. | Current account/organization labels, transitions, role restrictions and recovery have not been exercised in this audit. Source anchors do not establish successful sign-in. |
| Choose and connect a workspace | `quickstart.mdx`, `using-the-app.mdx` and `cloud-workspaces.mdx` explain local, managed and customer-owned cloud, provisioning versus connection, Google Cloud delegation and AWS setup. Cloud sources include `hosted-provider-delegation.ts`, `aws-customer-setup-template.ts` and `aws-connection.ts` under `packages/operator-core/lib/workspace-host/`. Portal UI is `packages/ui/src/workspaces.tsx`. | Current creation/connection labels and complete managed/own-cloud paths are unverified. The cloud guide mixes beginner instructions with detailed provider setup; keep the first choice simple and reveal advanced instructions progressively. |
| A small first task and its result | `quickstart.mdx` offers a README task, asks for a plan, explains approval and separates implemented, verified and shipped. `using-the-app.mdx` names Plans, Work, Inbox and sessions, conditional on permissions. | The exact current project/session entry, task execution, result transition and label assertions remain unverified. Do not infer task success from a card or a source diff. |
| Approvals and permissions | `using-the-app.mdx` and `quickstart.mdx` explain approval, execution route, AUTO boundaries and stopping. Sources anchor `packages/operator-core/lib/agent-tools/mode/set.ts` and `plans/start.ts`. | Actual permission/approval interactions and portal/desktop differences need their applicable runtime walkthrough. No permissions are changed by this documentation task. |
| Costs, stopping and deleting | `accounts-and-billing.mdx` directs readers to the displayed plan/price/status and distinguishes checkout return from confirmed entitlements. `cloud-workspaces.mdx` warns that stop/delete differ and stopped disks, snapshots and networking may retain costs. Portal billing entry is `app/billing/page.tsx` / `packages/ui/src/billing.tsx`. | Current pricing, billing role controls and lifecycle confirmations are unverified. Preserve provider charges, backup-before-delete and no-fixed-price caveats. A stopped host must never be described as automatically free. |
| Data, privacy and credentials | `using-the-app.mdx`, `accounts-and-billing.mdx`, `cloud-workspaces.mdx`, `remote-access.mdx` and `harness-snapshots.mdx` are the current guide destinations. Read sources forbid credentials in chat/support and distinguish a completed backup/restore route from a conversation or cloud snapshot. | No complete data-retention, credential-storage, privacy or deletion semantics were verified here. Sensitive claims require source review and an appropriate reviewer before FAQ acceptance. |
| Errors and support | `troubleshooting.mdx` covers sign-in recovery, unavailable workspaces, stopped agents, old delivered artifacts, public versus Project docs, search failures and redacted support reports. | Exact current Support destination, error/recovery controls and end-to-end support flow are unverified. Do not publish private project docs, tokens or tenant conversations as examples. |

## Existing public manual and delivery

The current public source inventory is the 14 MDX pages listed by
`apps/papercusp-docs/scripts/source-contract.mjs::PUBLIC_MANUAL_GUIDES`:
index, quickstart, using-the-app, accounts-and-billing, workspaces-and-agents,
plans-and-work, agent-modes-and-fleets, voice, cloud-workspaces,
harness-templates, harness-snapshots, plugins, remote-access and troubleshooting.
There is no Common questions page in that inventory or the sidebar.

`apps/papercusp-docs/astro.config.mjs` uses Astro/Starlight, enables Pagefind,
mounts `/docs`, emits file-format HTML and has Welcome plus a flat Sections
sidebar. Extend these maintained surfaces with a Start here path and task groups;
do not create another documentation site.

`source-contract.mjs::assertPublicManualSource` checks guide coverage, navigation,
concrete live source anchors, public guide links and exclusion of internal-doc
links. Its documented contract explicitly does not prove semantic truth.
`packages/operator-core/lib/public-docs.ts` is the public asset boundary.
Portal `app/docs/[[...path]]/route.ts` reuses `servePublicDocs` over
`public/papercusp-docs`. Current production bytes and packaging are unverified.

The related plan `public-docs-portal-readiness-2026-10-01` currently reports
shipped. Its Decisions preserve public/internal/project separation and identify
the distinct canonical portal checkout. Its result is a reuse foundation, not
evidence that this new FAQ, policy or study is complete. Earlier vector/tutorial
plans must be read against their own current contracts before reusing their
unfinished work; their historical Now text is not completion evidence.

## Actual Papercup path and retrieval gap

Portal `apps/host/src/papercup-chat.ts` sets `PAPERCUP_CHAT_ROLE = "papercup"`
and `PAPERCUP_CHAT_HOST_TRUST = "public"`, and passes the per-user principal
into the shared converse path. Missing principal credentials must keep the
brain tool-less; never borrow the disk owner's credential.

`packages/operator-core/lib/agent-tools/operator/converse-toolset.ts` selects
public capability doors plus interactive chat tools and the Papercup deep
delegation tool. That selection currently does not add `docs:search` or
`docs:get`. The same selection feeds both the MCP mount and allowed tools.
`converse-prompt.ts` loads the role-keyed persona; its owner Sentinel block is
excluded for public trust. `papercup-context.test.ts` exercises that owner
Sentinel renderer and cannot alone prove actual portal FAQ behavior.

`packages/operator-core/lib/agent-tools/docs/search.ts` resolves project,
harness and privileged engineering adapters. `_repo-paths.ts` resolves the
engineering MDX tree. Neither supplies a canonical public-manual branch in
the inspected route. Reuse the docs engine and its Starlight adapter with an
explicit public scope; do not make missing public results fall through to
private engineering/project sources.

## Prioritized implementation and evidence backlog

1. Map exact portal labels and everyday journeys into the existing manual;
   establish a plain page pattern and task-based navigation (P-002/P-003).
2. Add at least 20 reviewed FAQ entries in this same source, with stable public
   anchors, alternate phrasings, short answers, caveats and fuller-guide links
   (P-004). No permission-appropriate real-user/support question corpus was
   inspected here: seed demand remains proposed, not observed.
3. Extend safe public docs search/get and packaging, then the actual Papercup
   toolset/policy and deep path (P-005/P-006). Include lexical fallback,
   paraphrases/misspellings, ambiguity/no-match, source revision/cache behavior
   and fresh sessions/installations.
4. Extend existing source-linked drift/review machinery, with accountable
   billing/privacy/security review (P-007). No parallel scheduler or answer store.
5. Add maintained tests for the actual public path. Pair a seeded public positive
   control with private negative controls in the same run. Exercise stale,
   conflicting, missing and unavailable sources, prompt injection and live-state
   handling (P-008). Record runtime/content revisions; mocked retrieval alone
   does not establish actual portal behavior.
6. Observe three real non-technical participants on four tasks each, require
   at least 10/12 without coaching and no critical billing/privacy/deletion
   misunderstanding; fix confusion before acceptance (P-009/R-8).
7. Obtain Avi's acceptance and verify exact delivered docs, anchors, Pagefind
   assets and actual Papercup content/runtime revisions before shipment (P-010/R-9).

## Verification boundaries and sequencing issue

The predecessor recorded `npm run test:file --
packages/operator-core/lib/public-docs.test.ts
packages/operator-core/lib/harness/docs/public-manual-drift.test.ts`: two files,
21 passing tests, exit 0, test head `2a0d28b235`. Those are baseline serving/drift
checks. The runner warned that `PAPERCUSP_TEST_RUN_HARNESS` was unset; ledger scope
has not been verified, and this is not FAQ, chat, browser or novice proof.

The original work map assigned the finished manual to baseline P-001 as well
as downstream implementation. The hypothesis that this caused a platform
closure deadlock was not tested and is retracted: the canonical
`work_items/spec-test-adequacy-gate.ts` explicitly exempts manual-only clauses
without test layers at item closure and enforces them at shipment.

Decision D-008 clarifies final-outcome ownership. The canonical mapping-only
amendment advanced the acceptance rubric from revision 3 to 4, preserving its
entire criteria hash, all nine BAR promise hashes and all sixteen independent
item clauses. R-1/R-2 belong to P-003; R-3/R-6 to P-008; R-4 to P-004;
R-5 to P-006; R-7 to P-007; R-8 to P-009; R-9 to P-010. The old generated
P-001 projection is superseded; `DOCS-BASELINE@1` remains active. Activation
audit 4 passed against subject revision 14 with nine final projection edges.
This baseline proves its inventory contract only. The finished manual,
runtime behavior, novice study, independent acceptance and production
delivery still require their own evidence; no full R-2 pass is asserted.

Self-select admission is currently stopped by the harness release-red policy.
The shared writer `claimFloorsWhereSql` composes `stopTheLineExclusionSql`;
its contract preserves explicit leader/owner claims by ID. The normal by-ID
claim on current build 3170 succeeded for this approved P-001, without force.
LIVE_GATE_OPS remains with its held-live gate owner. The staging startup
connection refusal recovered during its progressing bundle build; no runtime
restart or release-gate action was performed by this session.
