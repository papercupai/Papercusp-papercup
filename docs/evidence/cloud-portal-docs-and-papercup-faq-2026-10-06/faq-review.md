# Common questions source review

P-004 / WI-10006918, `cloud-portal-docs-and-papercup-faq-2026-10-06`.
Canonical source: `apps/papercusp-docs/src/content/docs/faq.mdx`.
Review date: 2026-10-06. This records the author's source checks and the fresh
independent review below. The revised FAQ has exact-hash sensitive-source
approval. Novice validation, Avi's acceptance and shipment remain unverified.

## Demand and scope

The twenty seed questions are **proposed demand**, selected from the plan's
beginner journeys and the existing manual. No permission-appropriate real-user,
support, tenant or analytics question corpus was inspected. Their number and
alternate phrasings are design choices, not measured frequency or user findings.

The FAQ answers conceptual questions and supplies safe next actions. It does
not establish an account's current permissions, prices, subscription status,
hosting availability, connection state or retention policy. Those require
authorized current evidence. No fixed price, unlimited allowance, universal
cloud availability or comprehensive backup is promised.

## Question coverage and retained limits

Anchors are pinned in the existing publication contract using Astro's heading
slugger. Each question has two distinct alternate phrasings and at least one
existing fuller public guide. The following source checks support the claims;
they do not substitute for a responsible independent review or live walkthrough.

| Stable anchor | Source checked | Answer and retained caveat |
| --- | --- | --- |
| `what-is-papercusp` | `quickstart.mdx`, `using-the-app.mdx` | Start with a bounded task and inspect its result; a completion label is not publication evidence. |
| `what-is-papercup` | `using-the-app.mdx`, portal `apps/host/src/papercup-chat.ts` baseline | Assistant explanations and action depend on the session's tools and access; specify workspace/project. |
| `what-is-a-workspace` | `workspaces-and-agents.mdx` | Workspace environment and selected project differ; changing selection does not move a project. |
| `do-i-need-the-desktop-app` | `using-the-app.mdx`, portal workspace setup | Browser account options and connected local execution differ; installation flows are conditional. |
| `does-closing-the-browser-stop-my-agents` | `using-the-app.mdx`, `agent-modes-and-fleets.mdx` | Closing a tab is not an acknowledged stop command; local work depends on its computer. |
| `which-cloud-option-should-i-choose` | Portal `packages/ui/src/workspaces.tsx`; `hosted-provider-delegation.ts` | Current labels distinguish managed cloud and provider-owned hosting; described options may be unavailable. |
| `is-my-workspace-ready-when-its-card-appears` | `cloud-workspaces.mdx`, `troubleshooting.mdx` | Card creation does not prove a connected host; inspect the actual attempt instead of duplicating it. |
| `do-i-create-an-account-every-time` | Portal `packages/ui/src/auth.tsx`; `auth/hosted/self-signup.ts` | Reuse the identity's sign-in flow; app integrations are separate from account creation. |
| `why-can-i-not-see-my-organizations-workspace` | `accounts-and-billing.mdx`, `auth/hosted/self-signup.ts` | Identity authentication does not authorize all organizations; check account/organization and administrator role. |
| `what-can-i-be-charged-for` | `billing/entitlement-seam.ts`, `cloud-workspaces.mdx` | Subscription, model use and provider resources need separate checks; null allowances never mean unlimited. |
| `does-returning-from-checkout-mean-payment-is-confirmed` | `billing/entitlement-seam.ts`, portal `packages/ui/src/billing.tsx` | Pending subscription facts and confirmed entitlement differ; avoid duplicate checkout. |
| `does-stopping-a-workspace-make-it-free` | `cloud-workspaces.mdx` | Stop and delete differ; disks, snapshots and networking may retain charges. Provider-specific actual charges remain unknown. |
| `what-should-i-check-before-deleting-a-workspace` | `cloud-workspaces.mdx`, `backup/snapshot_create.ts`, `backup/restore.ts` | Identify deletion scope and a completed applicable backup/restore route; no subscription-cancellation or total-resource-removal guarantee. |
| `who-can-access-my-data` | `remote-access.mdx`, `access/create.ts` | Review the running machine, organization and configured scopes; no universal storage/retention or present-permission promise. |
| `where-should-i-enter-credentials` | `remote-access.mdx`, `access/create.ts` | Supported secure setup and scoped access; no secrets in reports, public repos or support/chat. No owner-key escalation to bypass a refusal. |
| `what-does-auto-let-an-agent-do` | `agent-tools/mode/set.ts`, `agent-modes-and-fleets.mdx` | Approved scope and permission boundaries persist; stop/pause must be explicitly acknowledged. |
| `how-do-i-know-a-task-is-finished` | `plans-and-work.mdx`, `quickstart.mdx` | Inspect acceptance and reported evidence; implementation, verification and publication are separate claims. |
| `what-if-an-agent-makes-a-mistake-or-gets-stuck` | `troubleshooting.mdx`, `plans-and-work.mdx` | Confirm interruption, identify work/blocker and inspect affected state; destructive restore is not generic error recovery. |
| `is-my-conversation-a-backup` | `harness-snapshots.mdx`, `backup/snapshot_create.ts`, `backup/restore.ts` | Conversation, source history and backups differ. Reconcile completed receipts and test a separate restore destination where supported. Restore mode matters; in-place restoration can overwrite newer state. |
| `how-do-i-get-help-safely` | `troubleshooting.mdx`, `remote-access.mdx` | Use the installation's actual help destination and redacted error/time/reference; no invented Support button or retry loop. |

Guide files above are under `apps/papercusp-docs/src/content/docs`. Core source
paths are under `packages/operator-core/lib`; portal paths are relative to the
separate checkout recorded in `baseline.md`.

## Sensitive review responsibilities

Billing and checkout require a hosted-billing reviewer; cloud costs/lifecycle
require a workspace-host reviewer; privacy/credentials require an auth/access
reviewer; backup/deletion recovery requires a backup reviewer. P-007 owns the
durable review assignments and drift relationship. The fresh independent review
below checks these sources but does not establish ongoing maintainer ownership.
P-004 remains open until approval is recorded against the exact FAQ revision.
Automated structure checks cannot
prove billing, privacy or recovery truth.

## Verification so far

The maintained focused runner passed 44 tests across the FAQ publication
contract (7), public source readiness (35), and dated inventory consistency (2),
with no skips. Evidence: `/tmp/cloud-docs-faq-tests.log`, local source at runner
head `ff223fd86f`; two named test files were uncommitted. Scoped declaration
generation emitted only `source-contract.d.mts`. This establishes local source
behavior, not a full-suite verdict or a deployed artifact.

The FAQ tests reject removed questions, broken bookmarks, duplicate anchors,
missing/duplicate aliases, link-only answers, private/self/escaping/nonexistent
guide links and nonexistent guide fragments. Existing source guards enforce
concrete code anchors and sidebar reachability. The historical inventory test
now compares its totals within its dated receipt while current source readiness
continues to require the actual current guide population.

The fresh maintained Astro reader suite passed 10 tests without skips on
2026-10-06 (`testRunId: 20862474`, group
`a0aa39d9-633a-4b93-b0af-9c364d1bdd8b`). Its FAQ case checked rendered heading
anchors and fuller-guide destinations. A fresh seven-test FAQ structure run
also passed without skips (`testRunId: 20864456`, group
`83dbaeb8-49dd-49ae-8c2b-9c7cd9d25505`), with ledger-backed unit bindings for
`AUTO-BAR-R-4-P-004@3` and `DOCS-FAQ-COUNT@1`. These bindings still require
review; they do not approve semantic truth.

An isolated Astro build with Pagefind completed successfully. The maintained
Playwright Common questions cases then passed three tests: immediate bookmark
reload on desktop, the same journey through the actual mobile Menu, and search
using both credential and stopped-disk alternate wordings. Evidence:
`/tmp/cloud-docs-faq-successor-fixed-build.log` and
`/tmp/cloud-docs-faq-successor-verified-playwright.log` (exit 0, no skips).
The isolated artifact was under
`apps/papercusp-docs/.astro/cloud-docs-faq-successor/dist`; the local preview
used `127.0.0.1:43129` and was stopped after verification.

The browser check found a fragment-reload defect: global smooth scrolling
could be interrupted by immediate reload, leaving the bookmarked answer at
the top-of-page scroll position. Replacing only that CSS behavior in the same
navigation sequence distinguished this from a missing anchor: the old behavior
left the heading at 4252px, while native immediate scrolling put it at 87px.
The stylesheet now keeps native immediate jumps. The maintained browser cases
guard desktop and mobile bookmarks; mobile viewport and Menu state are selected
before navigation. Tracked as `EI-25267974475848924`.

Independent sensitive-source review was requested in conversation
`conv-mux7lsk0-0000-8b25517ba71f4fbaac95376ffa49b508`, against FAQ SHA-256
`97482fb26c41800244c86206d591cfbc2249ca368bf7d1cf128e2585f81627a5`.
The first two routed reviewers declined because their inherited transcripts
covered rubric vetting rather than the product sources. The third reviewer,
`su-a21e7be0-2338-4117-a0cc-bd59694631fe`, performed fresh independent source
reads and recorded them in `thread-post:1160755`. That full post was read;
it supports billing separation, cloud stop/delete/cost cautions, scoped
credentials and the backup/restore warnings at the reviewed FAQ hash.
It approves checkout's negative claim but leaves the portal confirmation
surface unverified. It recommends clarifying that an allowance may be absent.

The allowance clarification is now in the FAQ. The author also read the portal's
`packages/ui/src/billing.tsx`: lines 160–227 derive the rendered status and
pending/active confirmation from subscription state; lines 419–432 fetch the
account's current subscription. This supports checking that surface rather
than trusting the return URL. `packages/ui/src/auth.tsx:249–261,330–356` supports
the administrator/sign-in recovery language and distinguishes optional
Gmail/Calendar data connections from portal authority. These are source checks,
not a claim that a live payment or organization-access journey passed.

The reviewer also identified a stale clone-only header comment in
`packages/operator-core/lib/agent-tools/backup/restore.ts:2`, contradicted by
the explicit `in_place` mode below it. That comment drift is filed and owned as
`EI-25268923232895042`; the FAQ already warns about replacement of newer work.
Approval of the revised FAQ, real novice observations, Avi's acceptance and
exact production verification remain unverified. No shipment is claimed.

## Revised source verification and guard certification

After the allowance clarification, FAQ SHA-256 is
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`.
The maintained FAQ unit suite and Astro reader suite passed 7 and 10 tests,
respectively, without skips (runs `20865068` and `20865070`, group
`6280e119-cc0a-40c4-946f-dcb6a5060ecc`). Earlier browser evidence belongs to
the prior prose revision and is not relabeled as a revised-source browser run.

The maintained mutation runner disabled only the minimum-question guard in an
isolated copy-out overlay. The current and unmutated-copy controls each passed
all seven cases. Raw mutant run `20865121` failed the exact removed-question
case, proving that the test detects a broken guard. The runner verified shared
source integrity. Replay arguments, runner identity, result and bindings are
preserved in [faq-count-mutation.json](./faq-count-mutation.json).

The raw mutation is bound as `27525` to `AUTO-BAR-R-4-P-004@3` and `27526` to
`DOCS-FAQ-COUNT@1`, paired with current successful case bindings `27494` and
`27496`. `plans:certify-spec-clauses` evaluated both current clauses and filed
two passing cards with zero refusals. This certifies the automated structural
proof; it does not approve sensitive product claims or establish usability.

The original reviewer session was recovered to continue post `1160766` in the
existing consult. The resulting full `thread-post:1160798` was read. The reviewer
verified the exact revised FAQ hash in the working tree and its committed blob,
proved that only the allowance clarification changed, and approved billing and
checkout, cloud cost and deletion, privacy and credentials, and backup and
restore as source review at that hash. Fresh portal `billing.tsx` and `auth.tsx`
reads resolved the prior confirmation and sign-in uncertainties.

This approval covers sensitive-answer source truth only. Residual provider
charges remain provider truth, and the entitlement provider does not yet supply
metered allowances. It does not cover automated checks, novice observations,
live payment, Avi's acceptance or exact production behavior. Further FAQ edits
require renewed review. The portal's potentially misleading pending-payment
notice is separately filed and assigned as `EI-25270514474947388`; the FAQ keeps
its conservative confirmation language.

## Source-linked review reconciliation, 2026-10-08

The current accountable maintainer for this FAQ is this session through
**WI-10006921 / P-007**. The independent sensitive-source reviewer remains
`su-a21e7be0-2338-4117-a0cc-bd59694631fe`; the approval is
`thread-post:1160798`, read in full again on this date. Its scope is source
truth at FAQ SHA-256
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`.
The current FAQ has that exact hash. No new independent approval, permanent
human maintainer assignment or runtime journey is inferred from this check.

The existing `public-manual/faq.mdx` record retains all seven concrete code
anchors, `source: manual`, and the original verification baseline
`ff223fd86f27c8eeaba8f23b366324d38c2e7b24`. The current maintenance read
reports **review**, specifically because `backup/restore.ts` changed. This
is the expected review request, not semantic approval or a missing source.
The serving reader also reports `bodyMissing: true`; the historical
current-build reader observation is separate. This reconciliation does not
reset the baseline through that older serving reader.

The source comparison used reviewed core HEAD `3c2e82741bfd` and current
core HEAD `e447980feb3a586dbe2204fcf085a84de64f3d0c`. Each current file was
hashed directly and compared byte for byte with its reviewed git blob:

| Existing FAQ anchor | Current SHA-256 | Delta since reviewed core HEAD |
| --- | --- | --- |
| `auth/hosted/self-signup.ts` | `6492f96249807c33c7c1883e0895fa1ed79055bf25eff2b83431496bb5d239b1` | Identical. |
| `auth/hosted/billing/entitlement-seam.ts` | `010161f4dc3e95d0093e860e3519297a17765673137ddb5f561d749a964d38e0` | Identical; absent allowance still makes no unlimited-use claim. |
| `agent-tools/mode/set.ts` | `e49381b064fe74464adb69686687ce9131ca8a830d65feb5b5a465be4ec4a043` | Identical. |
| `workspace-host/hosted-provider-delegation.ts` | `3dbeb9db5dec8443ddadbd746d4968a891ad1592b72c2e62e12758b022550853` | Identical. |
| `agent-tools/access/create.ts` | `3077a764aadf980db5f34e94b08b0b20aeca93bceccbdce55f419bcdd011eadb` | Identical. |
| `agent-tools/backup/snapshot_create.ts` | `31be8c275a3de39aa598ee25c03305f84895f2215d677969470407ea7418cef5` | Identical. |
| `agent-tools/backup/restore.ts` | `058404f72734069baa7b9185270ae7654f8370f7e8bd46cc0dfc01dffb607d99` | Only the header comment changed: clone is the default; explicit in-place restore replaces its target after a safety snapshot. |

Paths in that table are relative to `packages/operator-core/lib`. The full
restore delta and current description, schema and handler were read. The
handler still distinguishes `clone` from `in_place`; the FAQ already warns
that in-place recovery can overwrite newer work. The comment repair resolves
the earlier source contradiction without changing that answer's meaning.

The separate Portal comparison used reviewed HEAD `4a281f46e83f` and current
HEAD `96350b330ae9e1781d56b23b8f3ba650aaa93f08`:

| Source | Current SHA-256 | Reviewed delta and effect |
| --- | --- | --- |
| `packages/ui/src/auth.tsx` | `7aef72afb0a431396db5f004bb55f10a19f664e0f948434fc7a61c05cbeefaa4` | Identical; the reviewed sign-in and integration distinctions persist. |
| `packages/ui/src/billing.tsx` | `23eb2aaaf2850a48e13c8ea44e5a8c24f6067800ce247c491a06055d772f1e09` | Pending checkout now asks readers to wait for confirmation; canceled checkout asks them to check billing status. Only an active subscription claims active status. The existing account tutorial now wraps Billing. |

The complete Billing delta was read. Its revised notices preserve the FAQ's
conservative instruction to verify subscription status and avoid duplicate
checkout. The tutorial wrapper can change the reader's runtime path, so its
source support does not discharge the actual billing journey.

The current sensitive-guide deltas were also read: `remote-access.mdx`,
`cloud-workspaces.mdx` and `harness-snapshots.mdx` add goal/result openings;
`accounts-and-billing.mdx` additionally explains identity/organization,
separate cost categories and the expected confirmed state. The privacy,
cost and destructive-action caveats remain. This is an author reconciliation
of changes since the independent review, not a new independent guide review.

Maintenance continues through the existing manual-doc anchor, freshness
sweep and doc-steward dispatch. A future relevant source change must retain
a review request until its semantic effect is checked; a FAQ prose change
requires renewed exact-hash approval. The current WI-10006921 holder owns
that unresolved work. No parallel FAQ table, service or review-status field
was introduced.

The saved mounted-revision test remains separate evidence:
[mounted-manual-revision-20261008.json](./mounted-manual-revision-20261008.json).
It proves disposable MCP retrieval invalidation with zero chat sends, with
the recorded source-provenance limitation. Canonical/model-cache coverage,
runtime journeys, real novices, independent acceptance and exact shipment
remain open. No tests or model calls were repeated for this reconciliation.

## Current-build maintenance baseline, 2026-10-08 23:56Z

The current staging reader at `http://127.0.0.1:3170` resolves
`public-manual/faq.mdx` with `bodyMissing: false`. The older release reader's
`bodyMissing: true` remains historical evidence about that reader. It is not
a missing canonical FAQ.

The FAQ SHA-256 remains
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`,
and each of the seven source files in the reconciliation table above still
has the exact listed SHA-256. This author maintenance check reuses that
recorded semantic reconciliation and the existing independent approval at
`thread-post:1160798`; it creates no new independent approval of the changed
guides or runtime behavior.

After those comparisons, this session used the existing
`harness_docs:verify` through staging. Its receipt stamped the FAQ baseline
to `2270e06a88608ef987d3ae8bd0f7f1cce12eded0`. The authoritative read-back
reports `status: fresh`, `statusDetail: null`, `bodyMissing: false`, the same
seven anchors and that exact `lastVerifiedSha`. The receipts are
`/tmp/su73-faq-current-review-0002.json` and
`/tmp/su73-faq-current-review-0002-readback.json`.

This is an accountable author review and maintenance-baseline renewal.
Future source drift still requires review; future FAQ edits still require
renewed exact-hash sensitive-source approval. The existing post-sync
integration proof (`test-run:20940593`) remains separate and was not rerun.
All fifteen current canonical public pages match their packaged
`apps/operator/public/manual-source` bytes, but that comparison alone does
not prove fresh installed execution or a refreshed Pagefind answer.
Installed worker/index/retriever propagation, sensitive-guide review,
real novice observations, independent final acceptance and exact shipment
remain open.

## Sensitive-guide review preparation, 2026-10-09 02:35Z

WI-10006921 / P-007 retains accountable maintenance ownership. The original
independent FAQ approval, `thread-post:1160798`, was read in full again.
The canonical FAQ still has its approved SHA-256
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`.
That approval covers the FAQ's sensitive answers, not later guide edits.

The following current guide files are clean in the canonical staging tree.
Their complete text and deltas from reviewed core HEAD `3c2e82741bfd` were
read before requesting a follow-up in the original conversation
`conv-mux7lsk0-0000-8b25517ba71f4fbaac95376ffa49b508`.

| Guide under `apps/papercusp-docs/src/content/docs` | Current SHA-256 | Change requiring review |
| --- | --- | --- |
| `accounts-and-billing.mdx` | `6057fa08a0beb6b9575435a253188cb9a0a1ed25491fea18aa6cd363536754b4` | Goal/result wording, Portal account and Accounts sidebar distinction, organization-access recovery, Billing route and separate cost categories. |
| `cloud-workspaces.mdx` | `6777b0136547dd76c3381ad7f70aa6ff6fc7938247828f76e35de7858a2bd8a5` | Goal/result opening; existing cloud-cost and deletion cautions retained. |
| `remote-access.mdx` | `d6d5fe9a1a4cb00a9a57232006d0c358770b6fcb1498cbcf5aae1d53295ab072` | Goal/result opening; existing scoped-access and credential cautions retained. |
| `harness-snapshots.mdx` | `de3cca2f03656437aeeeb474ae70bf27a810b6db31196bf9e0dfbba807db120c` | Goal/result opening; existing completed-backup, restore-target and publication cautions retained. |

The six sensitive core sources checked in this preparation still match the
SHA-256 values in the 2026-10-08 reconciliation table: signup, entitlement,
access creation, snapshot creation, restore and provider delegation. Compared
with the original reviewed HEAD, only the previously documented restore
header correction differs. This comparison supports the request; it is not
a new independent approval.

The follow-up must give an exact-hash source verdict for these four guides,
read the current account/Billing route sources, and identify any unsupported
claim or remaining unknown. It must preserve the scope of the unchanged FAQ
approval. Runtime account/payment/provisioning/restore behavior, real novice
observations, independent final plan acceptance and production shipment are
outside this source-review request. The sensitive-guide approval remains
**pending** until the review reply is read and its file hashes reconciled.

The installed background review result is now recorded separately in
[installed-background-review-20261009.json](./installed-background-review-20261009.json):
one selected case passed, 49 cases were filter-skipped, with no agent/model
launches and complete fixture cleanup. That receipt retains unknown imported
source provenance. It does not establish semantic approval or full R-7.

## Independent sensitive-guide source verdict, 2026-10-09

The answer at `thread-post:1166949` in
`conv-mv0cw1z7-0000-2e408127fba043bea277fa15ee265224` was read in full.
Reviewer `su-a1b9f00d-66fd-474e-9e69-53ae9162aff6` independently confirmed
the four prepared guide hashes. This session also recomputed those hashes
and the unchanged FAQ hash before applying the findings.

The source verdict approves `cloud-workspaces.mdx`, `remote-access.mdx`
and `harness-snapshots.mdx` at the exact hashes in the preparation table:
their goal/result openings preserve the previously reviewed cost, scoped
access, credential, backup, restore and deletion cautions. These approvals
are limited to source truth.

The account guide's verdict was conditional. The reviewer did not establish
the integration-connect claim about workspace permission, and the instruction
to preserve a "non-secret reference" did not identify a displayed reference.
This session narrowed access recovery to signing up again and replaced both
reference instructions with the observed time and displayed Billing status.
The revised canonical `accounts-and-billing.mdx` SHA-256 is
`c5119fa0c92fefd75e244627e7d8a0c400b434956cd693064a8a5b05f9949850`.
The complete three-hunk diff and changed text were read back. Independent
approval of this revised hash remains pending until its follow-up is read.

The reviewer accepted the cost categories with their existing instruction to
check current account/provider terms; this is no unconditional payer or price
guarantee. The reply did not independently recompute every core source hash.
Those limits remain explicit, and this author's earlier source comparison
does not become independent evidence. The original FAQ approval remains
`thread-post:1160798` at the unchanged full hash in the preparation section.

No runtime journey, new test run, novice observation, final acceptance or
shipment is inferred. The browser diagnostic remains paused for the existing
tutorial owner's matching artifact custody or replacement identity. The
account-guide edit must propagate through the maintained packaging path
before any refreshed reader or installed-artifact claim.

## Revised account-guide source approval, 2026-10-09

The new answer at `thread-post:1167043` in the same conversation was read
in full. Reviewer `su-a1b9f00d-66fd-474e-9e69-53ae9162aff6` approves
`accounts-and-billing.mdx` at SHA-256
`c5119fa0c92fefd75e244627e7d8a0c400b434956cd693064a8a5b05f9949850`.
This session independently recomputed the canonical guide hash after reading
the reply and confirmed the exact match in the canonical `staging` tree.

The reviewer measured exactly three prose hunks from the previously reviewed
guide. Removing the integration-connect permission claim and replacing both
unspecified reference instructions with the time and displayed Billing status
clear the two earlier findings. The retained signup recovery wording is
supported by the Portal membership and already-registered identity messages;
the Billing page renders the status notice that the revised recovery asks
people to record. No retained caution was removed.

The three other guide approvals at `thread-post:1166949` remain at their
preparation-table hashes. The original FAQ approval at `thread-post:1160798`
remains unchanged; its canonical SHA-256 was recomputed as
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`.
The reviewer did not re-review those unchanged files, recompute four of the
six core-source hashes, or trace the model-usage/cloud-resource payer source.
The existing instructions to check current account/provider terms remain
necessary; this approval gives no unconditional price or payer guarantee.

Review delivery required recovery. Follow-up `thread-post:1167027` was saved
with zero wakes and no confirmed pickup. The session ledger showed that the
original answering session had ended, so the supported agent-resume mechanism
recovered that exact reviewer identity and native session. Its persisted
kickoff and subsequent assistant turn established actual pickup before the
new verdict. This is a temporary delivery mitigation; the unresolved delivery
defect is recorded and assigned to this session as `EI-24358109344889516`.
No durable fix or regression result is claimed for that defect.

The packaged account guide still has the previous SHA-256
`6057fa08a0beb6b9575435a253188cb9a0a1ed25491fea18aa6cd363536754b4`.
Packaging remains pending. This exact-hash approval covers source truth only:
no new tests, builds, browser scenarios, runtime acceptance, novice observations,
final plan acceptance or shipment are inferred. The tutorial owner has reported
custody recovery, but its distinct replacement build remains blocked by its
owned `EI-25469173073987617`; no ready replacement artifact was supplied.
Browser verification retains the matching artifact and readiness conditions.

## Approved account-guide packaging, 2026-10-09 03:28Z

The existing Astro build and `postbuild-copy.sh` now package the approved
account guide. Canonical and `apps/operator/public/manual-source` MDX both
have SHA-256 `c5119fa0c92fefd75e244627e7d8a0c400b434956cd693064a8a5b05f9949850`.
The built and operator-copy account HTML both have SHA-256
`42d5f01e23a292d39c75f758fb345fb4dec32470a992ffe4cc0026083e3414c1`.
The unchanged FAQ approval and hash above remain intact.

The initial packaging build exited 0 and the seven existing docs tests passed
with zero Astro diagnostics. Inspecting the generated search assets then found
an incomplete gzip stream: `wasm.unknown.pagefind` was only 32768 bytes.
This blocker is owned as **WI-10007700**, linked to P-003. The new maintained
`pagefind-output.test.ts` distinguishes complete backend-generated bytes from
the truncated file after `writeFiles` resolves and `pagefind.close()` kills
the service. The new served-build integrity case also rejects the incomplete
gzip asset. Both cases failed against the original implementation; seven other
cases passed. Evidence: `/tmp/su73-pagefind-integrity-red-0325.log`.

The repair uses the existing patch-package mechanism in
`patches/pagefind+1.5.2.patch`: Pagefind's existing `writeFiles` API retrieves
the generated assets through `getFiles` and awaits Node file writes before
resolving. Its installed postimage is Git blob
`938a71766e9b9f01c003c525d7a4c5e642d193d3`. The subsequent maintained build
exited 0, copied both existing public outputs and regenerated Pagefind.
Evidence: `/tmp/su73-pagefind-fixed-build-0328.log`. A direct read/decompression
of its copied compressed assets succeeds. This is an output inspection,
separate from the maintained regression suite.

The final maintained docs run at `/tmp/su73-pagefind-fixed-tests-0329.log`
finished with **9 tests passed in 3 files** and zero Astro diagnostics. Its
original queued process is gone; the passing summary was recovered without
re-running the suite or using a predecessor execution handle. The predecessor
shell exit code was not recovered. A pristine Pagefind 1.5.2 package in an
isolated directory accepts the saved patch through patch-package 8.0.1 (exit 0),
and its resulting Git blob matches the installed postimage above. The existing
postimage verifier also passes for this Pagefind patch. All 19 copied compressed
search assets decompress; the formerly truncated unknown-language WASM is
68024 bytes and the component UI is 175488 bytes. Durable manifests, log hashes,
test summaries and installation proof are in
`pagefind-write-completion-20261009.json`. These are local packaging observations, not refreshed
Portal/browser acceptance, novice observations, final plan acceptance or
shipment. The existing tutorial replacement and browser-readiness conditions
remain unchanged; no LIVE_GATE operations were performed.

## Maintenance evidence reconciliation, 2026-10-09 continuation

WI-10006921 / P-007 remains the accountable maintenance lane. The canonical
FAQ and packaged manual-source copy still match the independently approved
FAQ hash above. The approved account guide and its packaged copy still match
`c5119fa0c92fefd75e244627e7d8a0c400b434956cd693064a8a5b05f9949850`.
All seven FAQ anchors were hashed again and match the source-comparison table
above. This comparison preserves the recorded source approvals; it is not a
new semantic review or runtime test.

| Maintenance requirement | Retained evidence | Limit |
| --- | --- | --- |
| Accountable source-linked review | This lane, the seven anchored paths, the author baseline renewal, and exact-hash independent FAQ/guide verdicts above. | A fresh drift status does not grant semantic approval or a permanent human maintainer assignment. |
| Relevant product changes request review for FAQ and guide together | `installed-background-review-20261009.json`: the installed background Git-sync path leaves FAQ and quickstart in review, preserves their verification baseline, and leaves the unrelated guide fresh. | Disposable installed fixture; no production worker or agent dispatch is claimed. |
| Public retrieval observes revised canonical content | `standalone-manual-revision-20261009.json`: fifteen canonical public pages served from installed manual-source, with warmed docs-only retrieval over two revisions and zero model sends. | This establishes the public reader, not an actual Papercup model answer or installed source provenance outside the recorded bundle. |
| Search observes revised content at the same URL | `pagefind-manual-revision-20261009.json`: private canonical Astro/Starlight packaging, production reader and warmed Chromium Pagefind search. | Private copied build; no final release observation. |
| Approved guide and FAQ remain discoverable after packaging | `approved-manual-browser-20261009.json`: four maintained browser cases passed, zero failed/skipped, exit 0. Cases cover account-guide reload/mobile reading, account distinctions, new-guide Pagefind indexing and alternate FAQ wording. | Four selected cases only; Portal journeys and full R-1/R-2 remain open. |

The latest browser artifact records the served account HTML hash
`42d5f01e23a292d39c75f758fb345fb4dec32470a992ffe4cc0026083e3414c1`
and its explicit source/provenance limits. The results were read from retained
evidence; no unchanged test, build or browser scenario was rerun here.

The historical installed-background artifact's remaining-work list predates
the guide approvals and browser proof above. Its incidental sentinel issue
`EI-25465494437288816` is now closed with committed completion evidence: the
real inline-host regressions identify inherited `--input-type` as the worker
launch failure, and the fixed maintained sentinel suites passed 49 tests with
zero skips. That local fix does not establish a deployed sentinel runtime.

Full R-7 acceptance remains open. The recorded results do not establish the
replacement Portal's imported-source provenance or actual Papercup runtime
cohort. The later D031 retained replacement passed the one authorized workspace
resource-listing browser case; its report does not establish this answer/revision
cohort. Real three-person/four-task observations, independent acceptance and
exact production shipment also remain open. Historical evidence keeps its
original scope; missing observations stay unknown.

## Focused publication proof refresh, 2026-10-09

Astro configuration changed from the historical R-4 proof pin while the FAQ,
publication parser and maintained FAQ test remained byte-identical. A fresh
committed-source run at `265aa9261bd5df9b72326353b663cf2ce9eb5e14` passed all
seven publication cases with zero skips (`test_runs:20951875`). The same
committed copy-out runner then passed seven cases in each baseline
(`20951881`) and unmutated-overlay control (`20951883`). Disabling only the
minimum-question guard caused the exact removed-question case to fail:
mutant `20951886` had six passes, one failure and zero skips. The mutation
runner exited zero with `verdict=caught` and verified unchanged source bytes.

The authoritative ledger records all four runs under `papercusp`, with
`worktreeDirty=false` and no scratch test configuration. The four bounded
source/test hashes match the canonical tree. Replay arguments, current runner
identity, retained log hashes and limits are preserved in the `currentProof`
field of [faq-count-mutation.json](./faq-count-mutation.json). This refresh
belongs to `AUTO-BAR-R-4-P-004@3` and `DOCS-FAQ-COUNT@1`; it does not replace the
scoped P-007 contract or establish sensitive truth, actual Papercup answers,
novice results, independent acceptance or final shipment.

The retained unmutated baseline `20951881` was adopted as ordinary test evidence
through the documented mutation-copy canonical-path mechanism. Current test
bindings are `32516` for R-4 and `32517` for DOCS-FAQ-COUNT; the current mutation
bindings are `32470` and `32471`. Unit reachability follows the executed test's
import and calls to the production validator. Literal count, question-removal,
bookmark, alias and invalid-guide expectations provide independent oracles;
the shared anchor-array assertion is only corroborative.

Historical source-stale bindings `27491`, `27492`, `27494` and `27496` were
retracted from active proof selection because this current proof supersedes
them. Their recorded executions and artifacts remain historical. The subsequent
server measurement reports the active selection current, and the governing
author adequacy evaluator (`d740fc3802`, version `0.0.0`) passes both exact
clauses with no would-block criteria. No test was replayed for this adoption.
This is author-proof readiness, not independent certification or shipment.
