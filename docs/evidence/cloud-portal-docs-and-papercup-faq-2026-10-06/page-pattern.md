# Beginner manual navigation and page pattern

The public manual should help someone complete a small task, understand where
it runs and what it costs, and recover when something goes wrong. Extend the
existing Astro/Starlight manual at `/docs`; use its sidebar, search, numbered
steps and ordinary guide links. Keep the first useful result near the beginning
and place provider commands and advanced agent controls in the relevant guides.

This is the implementation design for P-002 / WI-10006916 of
`cloud-portal-docs-and-papercup-faq-2026-10-06`. It fulfills
`DOCS-PAGE-PATTERN@1`; the finished manual, FAQ, runtime behavior, novice study
and shipment have separate acceptance contracts.

## Navigation

Keep Welcome as the landing page, with a prominent link to **Your first
successful task** and a short explanation of Papercusp and Papercup. Replace
the flat Sections group with these Starlight groups. Preserve existing guide
URLs so bookmarks, retrieval references and portal links continue to work.

| Sidebar group | Existing guide slugs in reading order | Reader goal |
| --- | --- | --- |
| Start here | `quickstart`, `using-the-app`, `workspaces-and-agents` | Sign in, choose where work runs and complete a small task. |
| Everyday tasks | `plans-and-work`, `plugins`, `voice` | Approve work, follow progress and use optional connections. |
| Cloud and costs | `cloud-workspaces`, `accounts-and-billing` | Compare hosting, connect a provider and understand separate charges. |
| Privacy and recovery | `remote-access`, `harness-snapshots` | Understand access and prepare a backup with a restore route. |
| Advanced setup | `harness-templates`, `agent-modes-and-fleets` | Build an app from a maintained template or choose unattended and parallel work. |
| Common questions and help | `faq` when added, `troubleshooting` | Get a short explanation or recover from a concrete problem. |

`faq` is the planned single public FAQ page, not an existing destination.
P-004 adds it to the existing `PUBLIC_MANUAL_GUIDES` inventory and sidebar in
the same change as its content. Until then, link only to existing guides.
Reuse Pagefind; do not add a second search service or answer database.

## Page pattern

Use this order on each task page, with concise headings that name the task.
Long concept pages may contain several task sections with the same pattern.

1. **What you can do:** one sentence naming the outcome, followed by the
   primary action or shortest useful route. Define a new product term when
   the reader first needs it.
2. **Before you start:** account, organization, workspace, connection or role
   prerequisites. Put a cost, credential or destructive-action condition
   beside the action it affects.
3. **Steps:** short numbered actions using current visible labels. Separate
   portal, desktop and provider-console instructions when their controls
   differ. Describe unavailable controls conditionally; do not imply every
   account has every hosting option.
4. **Expected result:** what the reader can inspect to confirm success. A
   created card, checkout return or completion badge alone does not prove
   connection, entitlement or delivery.
5. **If something goes wrong:** the likely symptom, a safe next action and a
   direct Troubleshooting link. Avoid repeated provisioning or payment attempts.
6. **Next step:** one or two relevant public guides, linked to a useful
   section where possible. Keep engineering and private project links out.

For steps without a reliable duration, say what status to wait for rather
than inventing a time estimate. A duration or price must state its source,
date and conditions. Add a redacted screenshot only when it explains a real
choice; show its applicable surface and keep the text instructions usable
without the image.

## Everyday journey coverage

Each row names a public destination and the expected-result and recovery
sections that its rewrite must contain. These are design requirements;
runtime walkthroughs provide the later evidence that the instructions work.

| Journey | Primary guide and prerequisites | Expected result | Recovery and next guide |
| --- | --- | --- | --- |
| Account and organization | `/docs/accounts-and-billing`; the intended identity and organization access. Include Create account, Sign in and how to identify the active account. | The same verified identity is signed in and the intended organization is selected; access to a workspace still depends on permission. | Already registered: Sign in with the same provider. Missing access: check the intended organization and ask its administrator; `/docs/troubleshooting`. |
| Choose and connect a workspace | `/docs/cloud-workspaces`, reached from `/docs/quickstart`; compare Papercusp-managed, own-cloud and local work before provider setup. | The intended workspace reports a connected, usable host; a card appearing is not sufficient. | Preserve a provisioning or connection error, inspect that attempt and follow `/docs/troubleshooting`; do not create duplicate hosts. Explain workspace versus project in `/docs/workspaces-and-agents`. |
| A small first task and its result | `/docs/quickstart`; a signed-in account, connected workspace and selected project. Use the existing bounded README task. | The reader opens the changed result and checks the reported verification; publication is checked at its actual destination only when requested. | Ask for the work-item, next action and blocker in the same session; `/docs/plans-and-work` and `/docs/troubleshooting`. |
| Approvals and permissions | `/docs/plans-and-work`, introduced in `/docs/using-the-app`; the reader knows which workspace and project will change. | The approved scope and execution route are acknowledged; AUTO remains within that scope and the current permissions. | Reply to the outstanding approval in the same session, or explicitly pause/stop and check the acknowledgment; `/docs/agent-modes-and-fleets`. |
| Costs, stopping and deleting | `/docs/accounts-and-billing` for subscription confirmation and `/docs/cloud-workspaces` for provider costs and lifecycle actions; identify who pays and what resources remain. | The reader distinguishes subscription, model and cloud-provider charges, checks current billing status, and verifies the actual host action. Stopped disks, snapshots or networking may retain charges. | Pending payment: inspect confirmation rather than opening another checkout. Before deletion, establish the applicable backup and restore procedure; `/docs/harness-snapshots` and `/docs/troubleshooting`. |
| Data, privacy and credentials | `/docs/remote-access` and `/docs/harness-snapshots`, introduced in `/docs/using-the-app`; identify the running machine, authorized access and supported credential setup. | The reader knows where this task runs, uses the appropriate access/credential flow and can identify a completed backup plus its restore route. A conversation is not a backup. | Never paste keys, cookies or verification links into chat/support. If storage, retention or access is unclear, ask for an authorized current answer before acting; `/docs/troubleshooting`. |
| Errors and support | `/docs/troubleshooting`; preserve the symptom, time and a non-secret reference. | A safe recovery step resolves the symptom, or a redacted report reaches the supported help destination for that installation. | Distinguish sign-in, connection, search and stopped-agent errors; use the relevant guide. Do not promise a Support button until its destination is checked on the applicable surface. |

## Terms and visible labels

Use **Papercusp** for the product and **Papercup** for its assistant. A
**workspace** is the connected environment where work runs; a **project** is
the selected body of work inside that environment. Explain a **host** as the
computer running it, a **plan** as the agreed work and evidence of success,
and a **fleet** as several coordinated agents. Introduce advanced terms only
on the advanced guides; avoid requiring a novice to understand a harness,
operator, sidecar or inference gateway to perform the first task.

The portal source currently renders **Sign in** and **Create account** in
`packages/ui/src/auth.tsx`. Its first-workspace choices are **Use Papercusp's
cloud** and **Bring your own cloud**, with **Google Cloud** and **AWS** provider
choices in `packages/ui/src/workspaces.tsx`. These files are relative to the
portal checkout recorded in the baseline. Use those exact labels when the
rewritten step refers to those controls; use "Papercusp-managed cloud" and
"your own cloud" for the explanatory comparison. A source label does not
establish the option's availability for every account.

Portal instructions start at the public portal; desktop instructions start
with the installed app and its setup flow. Local work requires its computer
to stay on and connected. Closing a browser does not itself stop remote work.
Use the destination shown by the installation for downloads and support;
never present developer ports or internal launch commands as beginner setup.

## Copy review and sensitive answers

Every page and FAQ answer must pass these checks before acceptance:

- The first paragraph names the reader's outcome, and prerequisites appear
  before the affected action.
- Each journey has steps, an inspectable expected result and safe recovery.
- UI labels and product terms match their applicable surface; portal and
  desktop procedures do not silently substitute for one another.
- Claims about readiness, price, access, deletion or recovery have current
  sources and retain their conditions. Estimates are identified as estimates.
- Stop and delete remain distinct; remaining charges and backup limitations
  stay beside the relevant action.
- Public guide links resolve, reference the canonical manual and expose no
  private project material, tenant content or credentials.

The plan leader remains accountable for review assignment and acceptance.
P-007 records the responsible source maintainer and review evidence for each
billing, cloud-lifecycle, privacy, credential and recovery answer in the
existing drift/review pipeline. Billing answers need hosted-billing source
review; cloud costs and lifecycle answers need workspace-host review;
privacy, permissions and credentials need auth/access review; backups and
restores need the snapshot implementation review. Where a claim has no
confirmed source or responsible reviewer, publish its limit and safe next
action rather than a guarantee. P-010 obtains Avi's acceptance; a source
anchor alone is not a sensitive-answer approval.

Papercup should start with reviewed FAQ content for conceptual questions and
link to the fuller public guide. Current status, pricing, permissions and
configuration require authorized live evidence. Missing, stale or
conflicting public content must produce explicit uncertainty and a safe
next step; it must not trigger a fallback into another user's private docs.

## Sources and implementation checks

Reuse `apps/papercusp-docs/astro.config.mjs`,
`apps/papercusp-docs/scripts/source-contract.mjs` and the existing MDX guide
slugs. Source ownership and the portal paths are recorded in
[`baseline.md`](./baseline.md). The current manual already supplies the
bounded first task, approval example and connection/cost warnings; retain
their factual conditions while improving ordering and wording.

P-003 applies this pattern and sidebar grouping. P-004 adds the FAQ and
public anchors. P-008 exercises maintained link/source checks and the actual
FAQ path; P-009 observes the three-participant, four-task novice study.
No new visual component is specified here, so component-registry validation
is needed only if implementation later introduces or changes one.
