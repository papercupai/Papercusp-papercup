# Current-build manual review and acceptance boundaries

Plan: cloud-portal-docs-and-papercup-faq-2026-10-06, P-003 / WI-10006917.
Recorded 2026-10-07 by su-73f621d7-bae1-4bbb-b045-a11b5c47a384.

This records source review and browser observations. The seven product
journeys, real novice study, live Papercup matrix and shipment are unfinished.
No account creation, paid provisioning, payment, deletion or external send
was performed during these checks.

## Source review

Portal paths below are relative to the configured workspace's
`.papercusp/apps/portal` checkout.
Core and manual paths are relative to the canonical Papercusp staging tree.

| Journey | Observed source and manual instructions | Remaining runtime evidence |
| --- | --- | --- |
| Account and organization | `packages/ui/src/auth.tsx` renders **Create account** and **Sign in**. The account guide requires the same identity, intended organization and separate access checks; repeated signup is not access recovery. | Prepared-account sign-in, organization access and applicable recovery. |
| Workspace connection | `packages/ui/src/workspaces.tsx` defines **Use Papercusp's cloud**, **Bring your own cloud**, **Google Cloud** and **AWS**. Host readiness gates **Open desktop**; a workspace card alone is insufficient. Quickstart preserves the account-dependent choices and provisioning/connection distinction. | Applicable connection and readiness transition without creating billable hosts. |
| First task and result | `packages/ui/src/ask-papercup.tsx` renders **Ask Papercup…**. `apps/host/src/papercup-chat.ts` fixes role `papercup` and public trust. `apps/operator/prompts/papercup.converse.md` hands implementation to a recorded work-item. Quickstart now names the actual composer, requires a confirmed target, and follows the implementation reference to the inspectable README result. | Actual handed-off task, implementing session and changed README with verification. |
| Approval and permissions | `ASK_CAPABILITY_CONTRACT` in `ask-papercup.tsx` declares no confirmation round-trip for public chat actions. The manual now distinguishes that boundary from approval and AUTO in the implementing agent's conversation. Public retrieval must not broaden the principal's access. | The real implementing route's approval interaction and permission refusals. |
| Costs, stop and delete | `packages/ui/src/billing.tsx` renders **Manage billing** conditionally. The guide preserves displayed prices, confirmed entitlement versus checkout return, three charge categories, retained resources after stop and backup/restore before deletion. | Role-appropriate billing/lifecycle explanations and displayed confirmation; no payment or destructive action is needed as a study shortcut. |
| Data, privacy and credentials | Remote-access and snapshot guides preserve limited app access, supported credential setup, secret redaction, completed backup and explicit restore. Public manual retrieval is isolated from private corpora; static prose cannot establish a tenant's current permissions. | Authorized current access and applicable recovery evidence; paired public-positive/private-negative runtime controls. |
| Errors and support | Troubleshooting separates sign-in, connection, stopped-agent and stale-document failures and asks for redacted reference/time evidence. It uses the installation's support destination rather than inventing a universal Support button. | Applicable runtime recovery and an identified support destination, without sending an external report. |

## Browser observations

The existing Astro preview served the actual built manual at the private
loopback address `http://127.0.0.1:32123/docs`. This is a disposable local
current-build preview, not the staging operator, portal deployment or a durable
delivery URL. The public manual build had completed at 19:42Z before this
session's final composer/approval copy correction; that correction still needs
a fresh build and affected browser checks.

Maintained command profile: `apps/operator/playwright.config.ts` with
`OPERATOR_E2E_BASE_URL`, `OPERATOR_E2E_REUSE_SERVER=1`, and
`OPERATOR_E2E_SKIP_WARMUP=1`. The skipped warmup targets the operator SPA's
routes, which do not exist on this static manual preview. Test assertions and
the shared egress/ledger reporter were retained.

- Ledger **20905604**, LOCAL, six checks passed: five guide links, reloads,
  375-pixel mobile overflow and actual Pagefind result navigation.
- Ledger **20905682**, LOCAL, two new maintained checks passed: keyboard skip
  into content, keyboard search/open/close, and light/dark selection persisted
  after reload with visible content and no horizontal overflow.
- The preceding **20905676** failure remains recorded. Its cause was two
  incorrect new test assumptions: the skip target sets the keyboard navigation
  position without focusing the heading, and a raw theme selector includes a
  hidden mobile duplicate. A measured browser diagnostic distinguished those
  assumptions from a product failure. The corrected suite checks next-Tab
  entry into `main` and uses the visible accessible combobox.

Test source: `apps/operator/e2e/public-manual.spec.ts`. Passing browser checks
do not establish semantic accuracy, live chat behavior, novice outcomes or
production shipment. Follow the remaining evidence requirements in
`acceptance-protocol.md`; unobserved fields stay unknown.

## Rebuild and combined check after the copy correction

The corrected source rebuilt successfully at **20:28:42Z**, including the
Pagefind index and copied canonical `manual-source` bundle. Astro check then
reported zero errors, warnings and hints; both maintained manual test files
passed all seven tests. LOCAL ledgers: **20905704** (first-task) and
**20905703** (public build/source parity), head
`77a0fb0d1e9cedefc69c2677e7193e96eba34194` plus dirty source.

The combined eight-browser-check run on that rebuilt manual is **20905705**:
**seven passed, one failed**. The keyboard shortcut opened the search dialog,
but the input did not receive focus. The earlier focused run passed; the
cause of the differing observation is unknown. This is owned as
**EI-25354008812545188**, linked to WI-10006917. Measure actual focus and the
Starlight search lifecycle before changing the assertion or claiming a product
fix. Do not report the current browser cohort as fully passing.

The preview was stopped after the check. No verification process remains
running. The test command and source path above let a successor recreate it;
the loopback address is not a delivered artifact URL.

## Focus diagnosis and current checks, 20:42–20:45Z

This section supersedes the unresolved-focus and red-cohort conclusions above.
The earlier failures remain evidence; they were not replaced by passing replays.

Installed Starlight `Search.astro` focuses an existing input in `openModal`,
then independently creates Pagefind's input from a `requestIdleCallback` after
`DOMContentLoaded`. A maintained test controlled that callback and opened the
real dialog first. LOCAL ledger **20906610** reproduced the inactive input
after Pagefind mounted. The companion close-before-mount test initially used
an accessible-role query that excludes closed dialogs; its count failure was
a test locator mistake, corrected to the actual `site-search dialog` element.

The public manual now wraps Starlight's own Search component through its
supported override. A one-shot mutation observer focuses the late input only
if the dialog is still open. Starlight retains its UI, search engine, shortcuts
and existing ready-input behavior. The observer disconnects when the input
arrives, so result updates do not reclaim focus. Closing the dialog before
initialization completes preserves the reader's current focus.

The build completed at **20:41:46Z** after output-subtree locks were acquired.
The fresh actual Astro preview at `http://127.0.0.1:32123/docs` passed the
complete maintained public-manual browser file: **13 passed**, LOCAL ledger
**20906621**, including both controlled initialization cases, the original
keyboard journey, themes, mobile/reload checks, FAQ fragment bookmarks and
actual Pagefind results. The unchanged egress fixture and ledger reporter ran.
The associated Astro check had **zero diagnostics**; both maintained manual
test files passed **seven tests**, LOCAL ledgers **20906640** (first task) and
**20906639** (served build and canonical retrieval bundle parity). These rows
name head `43022a600667d6d07f6485a5dd7686310bdbe44d` plus dirty source; they
prove the tested working build, not an exact committed or deployed artifact.

P-005 integration also exposed a real cross-repo disclosure mismatch:
`selectConverseTools` selects `docs:search` and `docs:get`, but the Portal's
`ASK_CAPABILITY_CONTRACT.attachedTools` omitted both. The existing Portal test
failed that assertion in **20906637** (three passed, one failed). The notice
now lists both tools, and its composition test includes `PUBLIC_MANUAL_TOOLS`.
Fresh Portal tests passed **28/28**, LOCAL ledgers **20906708** (four contract
tests) and **20906709** (24 Ask panel tests). Machine access and confirmation
behavior are unchanged. This repair is owned as **EI-25354793930299654** under
WI-10006919. It does not demonstrate the fresh installed public MCP runtime,
tenant isolation, live answer policy or production disclosure.

The seven actual product journeys, real novice study, live Papercup/security
matrix, independent acceptance and exact production shipment remain open.

## R-1 source review and goal/result openings, 2026-10-08

The current `AUTO-BAR-R-1-P-003@3` requires changed pages to open with the
reader's goal and expected result. A source read found that the following
guides instead began with definitions or a symptom heading. Their openings
now name the action and the result to check before advanced details:

| Existing guide | Goal and expected result at the opening |
| --- | --- |
| `accounts-and-billing.mdx` | Confirm account access and cost responsibility; identify the organization and distinguish pending payment from confirmed subscription. |
| `cloud-workspaces.mdx` | Choose hosting and connect a host; verify provisioning, connection, intended account and payer before work. |
| `workspaces-and-agents.mdx` | Select the task's place and direct an agent; identify workspace, project, executing agent and completion evidence. |
| `plans-and-work.mdx` | Turn a request into reviewable work; inspect approved scope, assignments and completion or delivery evidence. |
| `agent-modes-and-fleets.mdx` | Choose execution and approval; record route and scope, follow assignments and confirm a requested pause or stop. |
| `remote-access.mdx` | Connect an app with limited access; check an authorized action and know how to pause or revoke access. |
| `harness-snapshots.mdx` | Protect work and prepare recovery; establish completed backup scope and observed recovery before replacing live data. |
| `harness-templates.mdx` | Choose a fitting project template; identify its current guides and verification plan before sharing. |
| `plugins.mdx` | Add an integration to the intended account; verify limited authorization, a small action and disconnection. |
| `troubleshooting.mdx` | Recover from the identified problem; check restored behavior or retain redacted evidence for support. |

`quickstart.mdx` and `using-the-app.mdx` already open with the first task and
inspectable result. Existing procedures, UI labels, permission boundaries,
cost explanations and destructive-action warnings remain in the guides.
This is a source-content repair; it does not establish that a novice can
complete a journey or that current Portal controls match every instruction.

The retained actual Portal typed/history observation at 10:23Z is available
in `portal-typed-history-20261008.json`: one case passed, with paired public
docs calls and two saved `text_typed` turns. Imported-source provenance is
`unknown`. Its docs-only fixture does not implement or approve a README task,
so it cannot fill the first-task/result or approval cells in the table above.
Its full-machine access notice is under investigation as
`EI-25406461543795897`; normal production restrictions have not been measured.

After the opening changes, `scripts/pc-heavy.sh npm --prefix
apps/papercusp-docs run build` exited successfully at 13:04Z, rebuilding the
static manual and Pagefind index and copying the canonical retrieval bundle.
`PAPERCUSP_TEST_RUN_HARNESS=papercusp scripts/pc-heavy.sh npm --prefix
apps/papercusp-docs run test` then exited successfully: Astro reported zero
diagnostics, and the existing first-task and public-build parity files passed
seven tests with no skips. Retained logs are `/tmp/su73-docs-r1-build-1304.log`
and `/tmp/su73-docs-r1-test-1306.log`. `git diff --check` passed for the changed
manual and evidence paths. This verifies local source/build parity, not a
browser or novice rerun, loaded Portal behavior, clause acceptance or shipment.

## Browser check of the revised manual, 2026-10-08 14:37Z

The existing 13:04Z static build was served through Astro preview at the
private loopback route `http://127.0.0.1:32123/docs`. No operator or Portal
rebuild was performed. The maintained browser command was:

```sh
OPERATOR_E2E_BASE_URL=http://127.0.0.1:32123 OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_SKIP_WARMUP=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp scripts/pc-heavy.sh npx playwright test --config apps/operator/playwright.config.ts apps/operator/e2e/public-manual.spec.ts --workers=1 --output=/tmp/su73-docs-browser-1438-artifacts
```

The command exited 0: **13 passed**, no skipped tests. LOCAL ledger
**20934288** records the conventional Playwright profile, source head
`16975cacd1cda73088791a1b031c5a7eb7a69c6b`, and `worktreeDirty: true`.
The relevant manual/test paths were clean before and after the run. The
unchanged built HTML hashes were checked on both sides:

- `dist/quickstart.html`: `3a0dc3b37b9de36895f9f1d7c5bb41d72e2965cc07ad5d3d51ee5940b2ca1a62`.
- `dist/faq.html`: `f5be7cb337756890d88a48485fd0d88bafc4d8a15187f7f8e7dd36fe63bec625`.

The retained log is `/tmp/su73-docs-browser-1438.log`. Observed checks cover
guide navigation/reload/mobile readability, real Pagefind results, keyboard
entry and search focus, theme persistence, FAQ bookmarks and alternate-wording
search. This is current built-manual browser evidence. It does not discharge
the seven actual product journeys, model answers, real novice observations,
independent acceptance or production shipment.

## Account destination correction, 2026-10-08

EI-25434300348600597 originated in the canonical account guide: its source
blob `606450d395aba54eee74b7af0500f6b44b9c2e27` directed identity and organization
checks to **Accounts**. Source review of the configured Portal checkout found
two distinct destinations. `packages/ui/src/shell.tsx` places the **Portal
account** button in the navigation rail and renders identity, **Status**, and
the signed-in **Billing** link in `AccountPanel`.
`packages/ui/src/accounts-dock.tsx` mounts the selected workspace's model
account pool in **Accounts sidebar**. The account panel source does not render
an organization selector; that source observation is not a deployed UI verdict.

The existing account guide now names those destinations separately, gives the
organization administrator fallback when no organization name or selector is
shown, and locates Billing inside Portal account. This corrects the documented
route without adding or promising an organization picker.

The maintained browser regression failed against the previous built manual
at the missing **Portal account** instruction: one failure, exit 1, retained
in `/tmp/su73-account-guide-red-1800.log`. After the correction:

- `PAPERCUSP_TEST_RUN_HARNESS=papercusp scripts/pc-heavy.sh npm --prefix apps/papercusp-docs run build`
  exited 0; retained log `/tmp/su73-account-guide-build-1802.log`.
- `PAPERCUSP_TEST_RUN_HARNESS=papercusp scripts/pc-heavy.sh npm --prefix apps/papercusp-docs run test`
  exited 0: seven maintained tests passed, no skips, and Astro reported zero
  diagnostics; retained log `/tmp/su73-account-guide-docs-test-1804.log`.
- `OPERATOR_E2E_BASE_URL=http://127.0.0.1:32124 OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_SKIP_WARMUP=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp scripts/pc-heavy.sh npx playwright test --config apps/operator/playwright.config.ts apps/operator/e2e/public-manual.spec.ts --grep 'account guide separates|new public guide.*accounts-and-billing' --workers=1 --output=/tmp/su73-account-guide-green-1805-artifacts`
  drove the rebuilt Astro manual: two passed, no skips, exit 0, including the
  account-guide distinction/fallback and its navigation, reload and mobile
  readability. Retained log `/tmp/su73-account-guide-green-1805.log`.

The canonical guide and packaged retrieval copy have identical SHA-256
`6057fa08a0beb6b9575435a253188cb9a0a1ed25491fea18aa6cd363536754b4`.
The built account HTML and its operator public copy have identical SHA-256
`8f5c9c759913b1592eaa38e1d9885cfe8ac4a01e3ca83d31a78aeb5e71a925e7`.
Build output locks were acquired before the build and released after the
maintained docs checks; the disposable preview was stopped after the browser
run. These are local working-build proofs. Actual Portal account access,
the seven product journey outcomes, novice observations, independent acceptance
and exact shipment remain open.

## Served Portal public reader, 2026-10-08 18:30Z

The Portal's maintained `e2e/portal-public-docs.spec.ts` was run against the
actual served origin `http://127.0.0.1:3801`. Setting `PORTAL_DOCS_BASE_URL`
selects that origin and bypasses the test's local SSR fixture and bundle
preparation. No operator or Portal build, account creation, model request or
domain write was performed. From the configured Portal checkout, the command
used the following arguments. The launcher path is expressed here through
`PAPERCUSP_REPO_ROOT`, the canonical repository root; execution used that same
launcher's absolute path.

```sh
PORTAL_DOCS_BASE_URL=http://127.0.0.1:3801 PAPERCUSP_TEST_RUN_HARNESS=papercusp "$PAPERCUSP_REPO_ROOT/scripts/pc-heavy.sh" npx playwright test --config playwright.config.ts e2e/portal-public-docs.spec.ts --workers=1 --output=/tmp/su73-served-portal-docs-1830-artifacts
```

The command exited 0: **four passed**, no skipped tests. The retained log is
`/tmp/su73-served-portal-docs-1830.log`; browser attachments are in the output
directory above. Observations cover anonymous asset/HEAD/error/private-route
boundaries, the rendered public Docs entry and article deep-link reload,
Pagefind results and no-match recovery, and mobile/keyboard access without
page overflow. These are reader journeys, not implemented project tasks.

Before and after the run, the root document identified build
`n0tBVNS1PmJI34ZOn_R_r`. Its immutable release metadata records publication at
`2026-10-08T11:33:56.626Z` and source-root digest
`60b846a78a22708b766840d4662a71c568f4615516b254437882f436623265fe`.
The following served responses returned HTTP 200 with unchanged SHA-256:

| Route | SHA-256 |
| --- | --- |
| `/` | `fae3ebdb53006cb27899274421c088a6e3d663e7467e6336d137bb8b663c5acd` |
| `/docs` | `960548290bf2b02698db0e3a367076d0a6738b6ae40f71ea81361d3a57680b9f` |
| `/docs/accounts-and-billing.html` | `9aa1ca83f97327cf8b6184f9b278e094a18ffc7b2477fe78be586f04319e5575` |

The served account page does **not** contain the newly corrected `Portal
account` instruction; its bytes differ from the local corrected HTML hash in
the preceding account-correction record. Thus this older served release does
not establish delivery of that correction or shipment of the accepted manual.
The test's full imported-source provenance was not captured and remains
`unknown`. No full R-1/R-2 pass is bound from this run. Signed-in account and
workspace readiness, README implementation/result, approval, the remaining
product outcomes, real novice observations, independent acceptance and exact
shipment remain open.

## Actual account and workspace checks, 2026-10-08 19:35Z

The maintained `apps/operator/e2e/public-manual-product.spec.ts` ran against
the retained immutable Portal release
`EJhqVxwQCX2gcGbngiare-20261008140427223-3801066-e4bba695` and a fresh private
operator answering `/api/health` with source `ddce55d82d`. The run used
`OPERATOR_E2E_SKIP_WARMUP=1`, system Chrome, genuine WorkOS TEST admission,
private database/workspace validation and the retained kit's cleanup. It built
no new operator or Portal artifact and invoked no model.

Read evidence: `/tmp/su73-r2-report-1936.json` and
`/tmp/su73-r2-served-1936.log`. Result: **1 passed, 1 failed, 0 skipped**;
the process exited 1. The account case passed: the signed-in account panel
showed identity text and the Status label, exposed the Sign out control, and
its Billing link reached `/billing` with a visible billing card. Its attached
record identifies build `EJhqVxwQCX2gcGbngiare`, release publication
`2026-10-08T14:04:27.223Z` and the currently read account guide SHA-256
`6057fa08a0beb6b9575435a253188cb9a0a1ed25491fea18aa6cd363536754b4`.
This proves those controls and navigation, not sign-out execution, payment,
organization selection, full readiness or shipment of the corrected manual.

The workspace case passed authenticated session/workspace binding and reached
the visible Workspaces surface. It failed on the expected Provider connections
region. The retained accessibility snapshot instead shows **Control plane not
reachable**, `operator_unreachable`, and an explicit explanation that this is
an unreachable upstream rather than an empty estate. Evidence:
`/tmp/su73-r2-output-1936/public-manual-product-manu-f41c3-t-claiming-a-connected-host-chromium/error-context.md`
and its adjacent screenshot. The upstream failure's cause is **unknown**;
operator health success alone does not establish the workspace API's transport,
authentication or scope. Workspace listing and readiness remain unverified.

Before this run, the two distinct harness failures were audited: the initial
warm-up aborted before cases, and the next attempt loaded two Playwright
runners through the external fixture. The generic warm-up repair's maintained
suite passed 11 tests with no skips (`/tmp/su73-warmup-1931.log`, local dirty
`fdecccfff0`). The fixture adapter now reuses the retained kit in a separate
process and validates module loading/private context before account creation;
this run reached actual account and workspace pages. Earlier failed reports
`/tmp/su73-r2-report-1917.json` and `/tmp/su73-r2-report-1928.json` remain
separate. No earlier passing suites or paid cases were replayed.

R-2's remaining journeys, README result/approval, real novice observations,
independent acceptance, loaded-source provenance and exact shipment remain open.

## Workspace transport diagnosis, 2026-10-08 19:52Z

The retained `/tmp/su73-r2-served-1936.log` names the failed leg:
`network GET /api/hosted/browser/rest-query after 0ms (relay: unknown_workspace)`.
The retained Portal source's `apps/host/src/api.ts` has no explicit hosted
control-query route; its `/api/*` fallback at line 830 calls
`proxyOperatorPassthrough`. That function selects the customer workspace relay
when the selected hosted workspace differs from the Portal process pin. Its
`resolveRelayHost` first queries the central control plane with that customer's
workspace header. The returned `unknown_workspace` is therefore distinct from
the separate successful operator health request. The retained hosted-auth
runtime mounts auth, tutorial and billing routes; those successful routes do
not establish workspace control-query routing.

This identifies the observed transport path and its refusal. A direct
authenticated control-plane probe and a corrected routing contract remain
necessary before choosing between a routing defect and fixture/tenant scope.
No healthy estate, connected host or product acceptance is inferred.

The existing maintained `public-manual-product.spec.ts` now checks the actual
authenticated control query after session binding and before page navigation,
attaching HTTP status, named error and whether rows exist. This guard uses the
real API; it changes no production routing or authorization. Collection
passed with two tests and exit 0 (`/tmp/su73-r2-workspace-guard-list-1952.log`),
and `git diff --check` passed. Its runtime behavior remains unverified; the
passing account case was not replayed. Source SHA-256:
`b754d2a05b30d1bacbaf2fb018abd0e9d9276580d271e16db82d67bfb9889bb6`.
The original tutorial implementer received the evidence pointer through
`coord-send-e5df8fdebcbb64956b5a328bccfead210448b1f38f87901465afc272b0bde72b`.
The diagnosis/fix remains owned on `EI-25441313743672037`; no rebuild, model call,
new runtime or shipment claim occurred during this diagnosis.

## Authenticated workspace route comparison, 2026-10-08 20:04Z

A bounded API probe used one genuine admitted WorkOS TEST session, the retained
EJhq Portal release, and a fresh private database with retained operator source
`ddce55d82d`. It completed with exit 0 and cleaned up its TEST user. Safe results
are retained in `/tmp/su73-workspace-route-probe-2008.json`:

| Request | HTTP | Named result |
| --- | --- | --- |
| Portal auth session | 200 | Selected workspace matches the admitted binding |
| Portal hosted workspace control query | 502 | `operator_unreachable` |
| Direct operator query, same cookie and public host, no workspace header | 404 | `not_found` |
| Direct operator query with selected workspace header | 400 | `unknown_workspace` |

The selected header refusal is therefore not the sole failure. The private
upstream command launched the local `hono-host.ts` handler, which mounts local
workspace middleware. The maintained production hosted composition is
`serve.ts`'s hosted branch calling `createHostedHandlerFromEnvironment`, whose
runtime explicitly mounts `/hosted/browser/rest-query`. The next diagnostic
uses that existing composition on a private database before deciding whether
Portal routing also needs correction. This is a test-runtime prerequisite
finding, not verified workspace acceptance or a production fix.

The Portal probe process exited 0; the exact private operator PID was stopped
after matching its resolved checkout and entry point, and its command exited 1.
The configuration lock was released. The passing account journey was not
replayed; no build, model call, authentication bypass or live gate action ran.

The next private upstream reused `createHostedHandlerFromEnvironment` and
stopped before listening: `hosted-profile: GET
/hosted/browser/onboarding/tutorial-progress must require at least one concrete
capability`. `/tmp/su73-r2-hosted-operator-2010.log` retains the startup failure;
the command exited 1 and the second TEST session/API probe did not start. Both
canonical and retained tutorial-progress route sources declare an empty
capability list, which the full hosted profile rejects. Owned follow-up
`WI-10007581` tracks the authority-contract repair and maintained startup
coverage; adding a workspace capability must preserve pre-workspace onboarding.
The hosted runtime configuration lock was released. Workspace acceptance and
the original `EI-25441313743672037` remain open.

## Authenticated hosted composition comparison, 2026-10-08 20:55Z

The follow-up used the full hosted operator composition on a private database,
retained source `c19484fc98aa929a8596441a0ff1e52b0fe7315e`, the retained EJhq
Portal artifact, and one genuine admitted TEST session. Safe API results are
retained in `/tmp/su73-workspace-route-probe-2055.json` (SHA-256
`95037e7e09b8d7defa27e3f0732e75d3dfd862c72ebd14eb40b9cc9ed09ffe05`):

| Request | HTTP | Named result |
| --- | --- | --- |
| Portal auth session | 200 | Selected workspace matches the admitted binding |
| Portal hosted workspace control query | 502 | `operator_unreachable` |
| Direct hosted operator query, same cookie and public host, no workspace header | 200 | Workspace and connection rows |
| Direct hosted operator query with selected workspace header | 200 | Workspace and connection rows |

These results supersede the earlier direct-query refusals as evidence about
the hosted composition. The retained Portal still selects the workspace relay
for this control query; its diagnostic records `workspace_host_not_connected`.
Both direct controls now succeed with the same admitted session, which
distinguishes the Portal transport failure from operator health or a rejected
workspace header in this fixture. It does not prove workspace creation,
host connection, or completion of the product journey.

The hosted startup authority repair is recorded on completed `WI-10007581`
with 66 focused passing tests. The existing tutorial implementer reports the
Portal route repair on `WI-10007589` with 50 focused passing tests; a corrected
immutable Portal artifact remains pending the separately owned build
prerequisite `WI-10007591`. Actual workspace acceptance must use that artifact
and rerun the affected journey. The earlier passing account case remains
retained. Both private diagnostic processes were drained and the configuration
lock released; no model replay or shipment claim follows from this comparison.

## Corrected immutable Portal API comparison, 2026-10-08 22:19Z

The supplied corrected Portal artifact `6Avr3UKWpC7WkTO1D8XcA` passed the
authenticated control-query prerequisite against the same frozen full hosted
operator source `c19484fc98aa929a8596441a0ff1e52b0fe7315e`. Its manifest matches
source-root digest
`cbb7c257839f1110502775201f964e4f6f80355d332d2e21dee8d741deac1feb`.
The maintained record is [portal-workspace-control-20261008.json](./portal-workspace-control-20261008.json).

| Request | HTTP | Named result |
| --- | --- | --- |
| Portal auth session | 200 | Selected workspace matches the admitted binding |
| Corrected Portal hosted workspace control query | 200 | Workspace and connection rows |
| Direct hosted query, same cookie, no workspace header | 200 | Workspace and connection rows |
| Direct hosted query with selected workspace header | 200 | Workspace and connection rows |

The probe reused the genuine WorkOS TEST admission kit and completed with exit
0 after TEST-user cleanup. The old and corrected artifact comparisons use
distinct fresh TEST sessions; each uses one cookie for its Portal and direct
controls. The earlier retained Portal 502 and this corrected Portal 200 support
the route repair within this isolated fixture. They do not discharge workspace
browser acceptance, provider readiness, the full manual journeys or shipment.

The first corrected-artifact attempt stopped before TEST admission because the
fixture inferred an operator integration root from a symlink layout, while the
immutable Portal snapshot contains a copied `operator-core` package. The API
diagnostic selected the supplied frozen operator dependency root through the
kit's existing argument. Owned `WI-10007623` retains the durable browser-fixture
repair and its required copied-package regression; the immutable artifact was
not edited. The earlier passing account journey remains retained.

## Corrected Portal workspace browser journey, 2026-10-08 22:36Z

The filtered maintained workspace case failed on the unchanged `6Avr` artifact.
The runner was clean committed `f812c6ece2`; its test and configuration matched
the canonical files. The repaired fixture was immutable `2e52955ace`, with
`PAPERCUSP_INTEGRATION_ROOT` selecting frozen full hosted operator `c19484fc98`.
All seven imported admission source files matched before TEST admission. The
fixture repair's ten focused tests passed with committed completion authority
on `WI-10007623`.

Within the browser run, genuine session admission and selected-workspace
binding passed. The authenticated workspace control query also returned HTTP
200 with rows. After the guide's **Open workspaces** link navigated to
`/?app=workspaces`, the selected surface assertion failed. The retained browser
snapshot displays **Control plane not reachable** and
`portal_auth_session_not_found`. This is evidence of a remaining browser/server
render authentication failure; its root cause is not yet confirmed.

The record is [portal-workspace-browser-20261008.json](./portal-workspace-browser-20261008.json).
The report contains zero passes, one failure and zero skips. The Portal/test
command exited 1 and the Portal shutdown stages completed. `WI-10007627` is
assigned to the existing tutorial implementer and linked as a blocker of
`P-003`. The passing API comparison and earlier account journey remain valid
within their recorded scopes. Workspace browser acceptance, full manual
acceptance and production shipment remain open.

### Workspace failure diagnostics, 23:46Z

The bounded same-artifact attempt used clean committed runner `1a9fbcfba1`,
the same `6Avr3UKWpC7WkTO1D8XcA` Portal release, and the retained corrected
admission fixture. The test, diagnostics helper and Playwright configuration
matched canonical source; all seven admission paths matched the frozen
operator. Private operator health returned HTTP 200 at `c19484fc98`, with the
hosted control route mounted.

Playwright stopped before collecting a test: its loader reported that the
`capturePublicManualFailure` named export was unavailable because the helper
loaded as CommonJS. The report contains no suites and zero test results.
Consequently this attempt captured no pre-cleanup browser diagnostics and adds
no browser acceptance result. The original 22:35Z browser failure remains in
[portal-workspace-browser-20261008.json](./portal-workspace-browser-20261008.json),
which also retains this collection failure and raw-evidence hashes.

`EI-25457032253199068` is assigned to the existing tutorial implementer for
compatible loading and a maintained Playwright discovery preflight without
product or provider calls. An earlier wrapper started before readiness was
enforced and stopped on connection refusal before Next or the browser launched;
its separate log is retained. Both readiness branching and loader discovery
must be audited before another slow attempt. The served wrapper exited 1; the
private operator exited 0 after guarded shutdown, its private home was removed,
and the runtime configuration lock was released. Full acceptance and shipment
remain open.

## Approved manual browser checks, 2026-10-09

Four maintained cases in `apps/operator/e2e/public-manual.spec.ts` passed
against the rebuilt Astro preview on port 32125 (exit 0, no skipped cases).
They exercise the account guide's reachable/reloadable mobile page, its
Portal identity/model account/organization distinctions, a real Pagefind
result for the fleets guide, and FAQ results through alternate wording.
The account response was HTTP 200 with the same approved HTML SHA-256 before
and after the run. Canonical and packaged account MDX remain hash-identical.
The repaired search assets match the preceding packaging record.

Exact command, cases, log hash and scoped source observations are retained in
`approved-manual-browser-20261009.json`. This updates the static manual
browser evidence after the approved prose and Pagefind changes. It does not
close the seven product journeys, real novice study, independent acceptance
or shipment. The existing Portal owner retains the replacement build and
workspace transport repair; the replacement is not yet a ready artifact.

## Replacement Portal workspace browser, 2026-10-09 05:12Z

The maintained workspace case passed on the distinct D031 replacement build
`a3vvr3As2z-SKFdzH_pQr`: one case, zero failures or skips. The private
operator returned the exact `abc9a41cb7` source identity and mounted the
hosted browser control route before the browser launched. Actual Playwright
collection had selected exactly the intended case. The authenticated control
query returned HTTP 200 with workspace rows; the served Portal session
held the authorized workspace, displayed the admitted provider resource, and
explained that health was unverified.

This supersedes the earlier replacement-readiness uncertainty for this artifact.
It exercises real admission, session and resource listing with an inert
provisioning transport. Actual provider readiness, provisioning, payments,
full R-1/R-2 acceptance, real novice observations, independent acceptance and
production shipment remain open. The historical 2235 and 2340 records remain
intact; a pass on this replacement does not establish the historical root cause.
The existing tutorial implementer retains `WI-10007627` diagnosis and closure.

The Portal wrapper and private operator both exited 0. Guarded shutdown removed
the private runtime home and generated configuration; all three owned ports
were free afterward. Exact report, decoded attachments, source identities,
log hashes and retained launch commands are in
[portal-workspace-browser-d031-20261009.json](./portal-workspace-browser-d031-20261009.json).
Raw records were copied with matching hashes under the retained artifact's
private evidence directory, so this record does not rely solely on `/tmp`.

## R-1 revised source review, 2026-10-09

The earlier R-1 binding `31014` describes historical bytes. A fresh SHA256
comparison found changes in `accounts-and-billing.mdx`, this walkthrough and
`public-build-parity.test.ts`; the other eleven guide sources and
`first-task.test.ts` still match that binding's measurement pin. This review
updates the changed account content without changing the historical record.

The revised account guide still opens with the reader's goal and inspectable
result. It distinguishes **Portal account** and **Status** from the workspace's
**Accounts sidebar** for model accounts. If the portal has no organization
selector, it directs the reader to an administrator to confirm membership
and the intended workspace, rather than implying that an absent control exists.
**Billing** and **Manage billing** remain conditional on the installation and
role. The page preserves separate subscription, model and cloud costs, warns
against duplicate payments, requires subscription confirmation after checkout,
and explains that stopping agents or closing a browser does not cancel a
subscription or remove cloud resources. Recovery preserves credential redaction.

The current account source and parity-test bytes match
[pagefind-write-completion-20261009.json](./pagefind-write-completion-20261009.json).
Its retained patched-test and build logs were read and their hashes matched:
nine maintained tests passed with no skips and Astro reported zero diagnostics.
The existing
[approved-manual-browser-20261009.json](./approved-manual-browser-20261009.json)
records four passing selected cases for account reading and distinctions,
new-guide search and alternate FAQ wording. Those results retain their original
timestamps, source-custody qualifications and selected-case scope; no test or
browser result was replayed or restamped for this review.

This is current source-review evidence, not full R-1 acceptance. The retained
account and D031 observations do not establish the complete current UI label
and transition census for every first-task flow. Provider readiness, payment
and provisioning journeys, real novice comprehension, independent acceptance
and exact production shipment remain unverified. The R-1 clause stays open.

## First-task source-test acceptance, 2026-10-13 09:24Z

The saved governing evaluation for `DOCS-FIRST-TASK@1` reports PASS on staging
port 3170 with evaluator build `661cf267d5` and no blocking clauses. The
completed evidence refresh retained bindings `41365` and `41366` and retired
the earlier `41124` and `41127` records. Its positive unit evidence includes
run `21188656`; the separate approval-removal control was caught in run
`21192594`. The docs Vitest configuration now records the executing project
as the unit layer, and the maintained injection guard checks that layer.

The full saved evaluation is
`/tmp/su9998-first-task-governing-unscoped-0924.json`; durable evidence and
source-custody details are on `WI-10006917`. This records the completed
source-test clause without replaying it. Runtime/model acceptance, the real
novice study, independent acceptance and exact production shipment remain open.
