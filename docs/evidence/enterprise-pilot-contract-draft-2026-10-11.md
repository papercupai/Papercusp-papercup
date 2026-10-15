# Enterprise pilot contract — preparation draft

11 October 2026 · P-003 / WI-10007898 · `papercusp-enterprise-readiness-roadmap-2026-10-09`

**13 October 2026 — bound to the D-009 assumed profile (P-003 complete on the ASSUMED basis).** Under Avi's directive #1817 ("plan it without that evidence"), roadmap decisions D-009 and D-010 replace buyer evidence with the labelled assumption register [enterprise-assumed-profile-2026-10-13.md](enterprise-assumed-profile-2026-10-13.md). The AUTO executor (su-1ffaf7b6) adopts every "proposed engineering default" in the release-boundary table and every threshold in the success/cost/stop table **as the assumed pilot contract**, citing assumption ids A-1 to A-10. The threshold table maps to A-8, the trial cohort to A-9 (an internal dogfood trial; no external partners) and the commercial boundary to A-10. Required advanced prerequisites: none for the assumed profile. P-013, P-014, P-016, P-017 and P-019 stay in scope as engineering. P-018, P-020 and P-021 are reduced to their non-owner-authority parts (D-010). Implementation estimates stand as written. Unresolved items are owner-gated residue: real buyer/partner evidence, external assurance, priced support/SLA, DPA signature and real MDM tenant enrolment. Text below that says "buyer must", "discovery" or "P-002 remains a prerequisite" is history from before D-009. Where it conflicts, read it through the assumption register.

Original status (11 October, superseded): **prepared for buyer discovery; not an approved pilot or a completed P-003**. Avi's continuation directive authorizes engineering work through verified shipment; it supplies no customer interview, customer acceptance, certification, contractual approval or funded customer allowance. P-002 remains a prerequisite. No prospect has been contacted through this work.

12 October continuation: roadmap D-008 selects the support-to-engineering handoff, Slack, one allowlisted workspace and current-build qualification as the internal engineering profile. Avi's full typed direction is `session_turn:codex:01a130a1-42a3-74a3-bf78-e6ae93d51d07:18` (file-backed origin unknown/unenrolled). Independent source preparation proceeds under WI-6554700010009188; actual buyer discovery, IdP setup, trial, legal/security approval and final qualification remain required. Strategy-choice waiting no longer parks engineering preparation.

The first identity unit reuses the existing signed WorkOS receipt, ordered entity cursor, `external_identities`, local membership and session-closure surfaces. Directory bindings use provider `workos-dsync` and the JSON tuple `[external_organization_id,directory_id,directory_user_id]`; an approved group binding is the local identity profile's `authorized_directory_groups` array. Provider emails, names and roles do not bind or grant access. The adapter acts only on active bound identities and closes the matching organization membership's sessions.

Directory binding administration is prepared under WI-6554700010009205. An authenticated active WorkOS organization owner/admin uses `PUT /api/hosted/organizations/:organizationId/members/:userId/directory-binding` with `{externalOrganizationId,directoryId,directoryUserId,authorizedGroupIds,purpose}`. The path organization must match the session, the external organization must match the local organization's WorkOS reference, and the target must already have a local organization membership. Group IDs are explicit opaque directory group identifiers, with at most 100 per binding; an empty array authorizes only directory-user revocation. The server never consumes provider email or role fields to link identities or grant privileges. Directory coordinates must come from the organization's supported IdP setup; this endpoint does not discover or attest that setup.

The same path accepts `DELETE` with `{externalOrganizationId,directoryId,directoryUserId,purpose}`. Removal keeps an inactive identity reference and audit history, clears its authorized groups, and prevents later assignment or automatic reactivation through this endpoint. `PUT` updates groups only for the same immutable subject and local user. Both operations recheck administrator authority inside the database transaction and append actor, purpose and old/new mapping evidence atomically. They do not alter local roles or membership status, revoke an existing membership by themselves, or complete full P-004, actual IdP qualification, access review, or customer acceptance.

Directory access-review export is prepared under WI-6554700010009269. An authenticated active WorkOS organization owner/admin posts `{purpose}` to `/api/hosted/organizations/:organizationId/members/access-review`. The path organization must match the session; the transaction rechecks the active organization, current actor role, membership and user lifecycle before exporting. The JSON download includes local membership roles/status, user lifecycle, derived effective permissions, and that organization's approved immutable directory coordinates/groups. It excludes email, arbitrary identity profiles and directory references from other organizations, even when a person belongs to both. Inactive users or memberships have no effective permissions in the review.

The export labels its scope `local-memberships-and-directory-bindings`; it is not a census of workspace/tool grants, an IdP attestation or a completed access-review process. It uses one database statement for the exported membership snapshot, includes its generation timestamp, and records actor, purpose, population count and scope in append-only organization audit before returning success. Responses use `Cache-Control: no-store`. More than 1,000 members or 100 directory identity references per member causes a conflict rather than a silently truncated review; malformed bindings or audit failures fail closed. This unit adds no role authority, member mutation or periodic schedule and does not complete P-004/customer qualification.

Directory group mappings and delegated provisioning are implemented under WI-10007899 (roadmap P-004). The supported IdP setup journey is a WorkOS Directory Sync simulation per the labelled assumed profile ([A-5 in the assumption register](enterprise-assumed-profile-2026-10-13.md)), not a qualified customer IdP. It has four steps. (1) An active owner/admin approves a group mapping with `PUT /api/hosted/organizations/:organizationId/directory-group-mappings` `{directoryId,groupId,role,purpose}` where `role` is `admin`, `member` or `billing`. Only an owner may approve an `admin` mapping, and approving a mapping changes no membership. (2) Signed WorkOS `dsync` events project the directory user's state and groups into `directory_user_observations` through the existing ordered receipt path. (3) An owner/admin provisions one named, already-observed, active directory user with `POST /api/hosted/organizations/:organizationId/members/directory-provision` `{userId,directoryId,directoryUserId,purpose}`. The body carries no role: it is derived from the user's mapped groups by precedence (admin > member > billing). An admin cannot provision an admin grant. Existing members, unobserved or inactive users, and users with no mapped group are refused. (4) `DELETE` on the mappings path `{directoryId,groupId,purpose}`, or a downgrade of a mapping's role, revokes each directory-provisioned membership whose remaining mapped role no longer covers its held role and closes its sessions. An upgrade never raises an existing grant. Every mapping change and provision writes append-only organization audit. A change that would converge more memberships than the per-request limit is refused as a conflict, not partially applied. Provisioning runs in the `hosted_owner` SECURITY DEFINER function `provision_directory_membership` (migration 1496). It relies on the reviewed `hosted_owner` membership policies from migration 1188, while `hosted_service` stays reduce-only. Real customer IdP qualification, SCIM endpoint hosting and a named supported-IdP list remain owner-gated residue under roadmap D-010.

Authority: roadmap Decisions D-002, D-003, D-006, D-007 and D-008. Source continuation: `session_turn:codex:01a12cd3-b523-79e0-a48b-f6e045265f67:8`. The [buyer-discovery packet](enterprise-buyer-discovery-packet-2026-10-09.md) and [capability/reuse census](enterprise-capability-reuse-census-2026-10-09.md) remain the evidence inputs. This document adds a concrete implementation and qualification contract without closing discovery or changing the roadmap's requirements, dependency graph or acceptance rubric.

## Product shaping and proposed first journey

Audience hypothesis: a developer-tools or infrastructure company whose support and engineering teams repeatedly reconstruct issues from Slack and repository context. The engineering/support lead is the proposed buyer; IT/security, the department reviewer and finance have distinct approval responsibilities. None is recruited or committed.

Problem hypothesis: preparing an engineering handoff consumes repeated searching, review and rework. Proposed outcome: a reviewer accepts a cited problem summary, reproduction or next-action checklist and suggested responsible role from a permission-authorized support case. The buyer must establish frequency, representative cases, current effort, accepted output and willingness to pay before these become validated requirements.

Proposed journey:

1. An employee selects an explicitly allowed source case inside one pilot workspace.
2. The workflow reads only context the employee and organization permit; current source permissions are checked at disclosure time.
3. It prepares a cited handoff with source references, uncertainty, proposed next actions and measured cost. Sensitive content remains inside the selected processing contract.
4. A distinct department reviewer accepts, rejects or requests rework. Review time and the reason are recorded alongside the case.
5. An authorized administrator can revoke access, stop the workflow, inspect the action evidence and restore the previous approved workflow version.

The initial workflow prepares and reviews output. Customer replies, issue assignment, source-system writes, code changes and production actions require a separately defined sensitive-action scope and approvals. This boundary does not waive the roadmap's separation-of-duties requirement: P-006 still exercises a named sensitive action in a controlled qualification environment.

## Proposed release boundary and decisions to bind

The smallest first profile reuses the existing Slack organization connector, hosted identity and local grants, policy/approval machinery, budget reservations and audit/disclosure ledgers. A selected buyer can replace the connector or require a private deployment; that changes the contract and estimates before implementation.

| Choice | Proposed engineering default | Evidence or decision still required |
| --- | --- | --- |
| Segment and workflow | Developer-tools support-to-engineering preparation | Attributable buyer discovery and accepted case/output definition, P-002 |
| First connector | Existing Slack organization adapter; repository context only where separately authorized | Actual source systems, permissions, freshness and write requirements |
| Directory | Extend the existing WorkOS verified-receipt/local-grant path | Named supported IdP, group-to-local-role mapping and delegated administrator |
| Hosting | Qualify one exact candidate/current-build profile first | Buyer selects hosted versus customer-cloud profile, region and allowed providers |
| Data scope | One explicitly named pilot workspace and allowlisted sources | Classified stores, approved inference/embedding/log/backup routes and retention |
| Employee authority | Read allowed sources and prepare a handoff | Authorized employee/reviewer principals and any sensitive execution action |
| Pilot population | At least 30 comparable cases; at least three independent design partners remain required by the roadmap | Real organizations, authorized contacts and approved trial records |
| Workflow version | One approved plan/recipe/template version with rollback | Version identity, promotion authority and reviewer acceptance |
| Support | Bounded setup and named incident escalation | Accountable support owner, coverage, commercial/legal terms and recovery objectives |

The broader roadmap retains P-013 through P-021. This draft neither drops them nor represents them as implemented. Any advanced control the selected buyer requires becomes a prerequisite to its trial and integrated release qualification. Full finance, additional connectors, MDM, private networking, key custody, legal hold and independent assurance each require their own scoped evidence.

## Threat, authority and processing contract

The supported profile must name the employee, organization administrator, department reviewer, sensitive-action approvers, service identity, operator and external provider. Provider identity alone never grants local privileges. Organization/department/workspace policy is inherited through the existing enforcement boundary; a lower scope cannot grant authority denied by its parent.

Every transport and backend used by this profile must be enumerated before a universal policy claim. The release evidence must include a permitted journey and attempted override, group removal, user deactivation, expired exception, expired grant, replay, self-approval and unauthorized source disclosure. The proposed access-closure target is 60 seconds from accepted revocation to denied access; the buyer and actual implementation must establish the final bound and its measurement before qualification. This is not a statement of current runtime behavior.

| Processing path | Contract to record | Qualification evidence |
| --- | --- | --- |
| Source read and stored copy | Source owner, ACL/mapping identity, source version, revocation and delete treatment | Allowed and denied users; permission change, deletion and stale/replayed events |
| Search and embeddings | Stores, provider/region, authorization filter and deletion behavior | Restricted-content canaries, current ACL checks and permitted retrieval |
| Model inference | Approved provider/model/region and outbound disclosure policy | Permitted processing plus attempted forbidden provider/egress path |
| Workflow output and audit | Audience, redaction, action/policy/version references and retention | Accepted and denied action correlation; secret canary and export access denial |
| Logs and telemetry | Allowed metadata, redaction, access and retention | Declared secret-canary population, export replay/deduplication and recovery |
| Backups and restores | Location, access/key custody, retention, deletion/hold conflicts and restored authorization | A qualified restore and offboarding exercise on the exact candidate profile |

Customer-cloud and vendor-hosted deployments have different threat models. A sealed BYOC channel can protect content in transit through the control plane; an operator of a vendor-hosted VM can access its live workload. Encryption does not establish a model provider's processing policy or a legal compliance claim. Record those properties separately.

Unselected provider, store, region, key lifecycle, private-network path or source system remains **unknown or outside the selected profile**, never implicitly supported. Export/delete/restore receipts must declare their exact store population, exclusions and hold conflicts.

## Proposed success, cost and stop criteria

These thresholds are planning hypotheses from the discovery packet plus explicit engineering proposals. They are not customer-approved targets, observed results, a price, a purchase authorization or an SLA.

| Measure | Proposed acceptance contract | How the trial records it |
| --- | --- | --- |
| Comparable cases | At least 30 eligible cases with matched baseline and exclusions explained | Per-case provenance, input/output, reviewer decision and baseline category |
| Useful output | At least 80% accepted outputs | Accepted/eligible denominator; rejections and missing decisions remain visible |
| Review effort | Median reviewer time at least 30% below comparable baseline | Recorded paired baseline and trial time; missing human measurements remain unknown |
| Repeat use | Report repeat use and rework separately | Dated authorized trial observations; no threshold invented after the result |
| Access closure | Proposed 60-second upper bound after accepted revocation | Recorded start/end and final deny across every selected transport |
| Spend | A buyer/finance-funded finite allowance; no unbounded overages or continuing liabilities | Reserve/admit/refuse evidence and distinct model, hosting, subscription and review costs |
| Recovery | Buyer-selected RTO/RPO and a successful restore exercise | Exact artifact/profile, timestamps, recovered state and authorization/data checks |
| Operations | Named setup/support/incident owner and finite exposure | Admin setup time, incidents, support effort and unresolved prerequisites |

Stop immediately on an unauthorized action, source-ACL breach or restricted-content canary disclosure. File and own remediation, verify it and re-authorize the trial boundary before resuming. Stop or narrow if costs exceed the finite funded boundary, an unknown retained liability cannot be bounded, or a required connector, deployment, legal, security or support prerequisite cannot be met. A missing bill, reviewer measurement or customer response does not become zero cost or acceptance.

## Reuse seams and implementation sequence

The existing census establishes source seams; source presence alone does not prove supported runtime behavior. The identity receipt adapter and budget policy were reopened on 11 October during this preparation. The remaining links are reuse references from the 9 October census and require current-source/runtime qualification in their implementation lanes.

| Lane | Existing surface to extend | Required qualification |
| --- | --- | --- |
| P-004 identity | [WorkOS receipt projection](../../packages/operator-core/lib/auth/hosted/workos-lifecycle-postgres.ts), existing local access-closure sink | Creation/mapping/removal/deactivation, replay/out-of-order events, forbidden elevation and actual IdP setup |
| P-005/P-006 policy and actions | [Hive policy store](../../packages/operator-core/lib/hive-policy-store.ts), [connected-app enforcement](../../packages/operator-core/lib/connected-apps/enforce.ts), [hosted governance](../../packages/operator-core/lib/auth/hosted/governance.ts) | Inherited policy, backend/transport population, expiry, distinct approvers, delegation and allowed controls |
| P-007/P-016/P-017 data | [Documents corpus](../../packages/operator-core/lib/data-sources/documents-corpus.ts), [disclosure ledger](../../packages/operator-core/lib/personal-vault/disclosure-ledger.ts), [chat retention/holds](../../packages/operator-core/lib/data-sources/chat-retrieval-units.ts) | Exact processing/store population, source ACL and canaries, export/delete/restore and any selected advanced control |
| P-008 evidence | [Operator audit](../../packages/operator-core/lib/operator-audit.ts), [decision ledger](../../packages/operator-core/lib/decision-model-ledger.ts), hosted audit writer | Action correlation, redaction, selected SIEM ingestion, tamper/replay/recovery and access denial |
| P-009/P-014 finance | [Hosted budget policy](../../packages/operator-core/lib/auth/hosted/billing/budget-policy.ts), [reservation store](../../packages/operator-core/lib/auth/hosted/billing/budget-store.ts) | Atomic concurrent parent/child limits, bounded unreconciled/retained liabilities, cost classes and outcome reconciliation |
| P-011/P-013 connectors | [Slack organization connector](../../packages/operator-core/lib/data-sources/slack-org-connector.ts), existing corpus/live-search/admission surfaces | Permission propagation/revocation, deletion, retry/throttling, separate write authorization and selected private reachability |
| P-012 workflow | [Template store](../../packages/operator-core/lib/cupboard/template-store.ts), [recipe capture](../../packages/operator-core/lib/agent-tools/code/capture-recipe.ts), existing plans/approvals/budgets | Employee and administrator journey, department acceptance, version promotion and rollback |
| P-010/P-018/P-019/P-021 operations | [BYOC authorization](../../packages/operator-core/lib/workspace-host/byoc-client-authorization.ts), [sealed channel](../../packages/operator-core/lib/workspace-host/byoc-sealed-channel.ts), existing distribution/backup paths | Exact candidate install/configure/restore/offboard, selected MDM/private network, recovery and actual support commitments |

After buyer discovery, bind the selected scope in P-003. Then run identity → central policy → sensitive-action/data controls → audit/onboarding. Budget work and selected connector preparation can advance independently after scope is bound. The connector, approvals and budgets converge in the departmental workflow; the workflow and onboarding converge in actual partner trials. Integrated acceptance, the concrete rollout decision and exact final shipment follow. This sequence preserves the existing plan dependencies.

## Preliminary implementation estimates

Planning ranges below are engineering estimates, not measured velocity or committed dates. They assume one connector, one IdP, one hosting profile, reuse of the named surfaces and dedicated engineering time. They exclude buyer response time, provider credentials, independent review queues, paid assurance/certification, legal negotiation and customer trial elapsed time. Additional mandatory profiles increase the estimate.

| Work package | Indicative engineer-days | What changes the range |
| --- | --- | --- |
| Buyer evidence intake and final pilot contract, P-002/P-003 | 2–4 after evidence arrives | Quality of baseline, scope and source permissions |
| Directory, inherited policy and sensitive actions, P-004/P-005/P-006 | 12–22 | IdP/group mapping, existing dispatch census and approval semantics |
| Data processing/retention and audit export, P-007/P-008 | 10–20 | Store population, chosen SIEM and restore/delete conflicts |
| Bounded finance, connector and one workflow, P-009/P-011/P-012 | 12–22 | Existing adapter fit, cost reconciliation and reviewer journey |
| Onboarding/recovery and integrated qualification, P-010/P-022 | 8–16 | Candidate profile, operational prerequisites and detector coverage |
| Trial analysis, release decision and final artifact qualification, P-015/P-023/P-024 | 4–8 engineering effort plus external elapsed time | Trial evidence, independent acceptance, actual deployment and rollback |

These ranges are not additive staffing promises and do not authorize a fleet. P-013/P-014 and any selected P-016–P-021 package need a scope-specific estimate. A complete engineering estimate and accountable staffing remain P-003 acceptance work after discovery.

## Evidence and completion contract

Use the existing canonical test framework and ledger. Add real fixture/assertion, hostile or mutation, and permitted-user controls in each implementation lane; a proposed detector filename is not a running detector. Preserve the exact acceptance rubric revision and requirement bindings, and obtain independent meta-vetting plus its separate grading-integrity audit before downstream acceptance proof/cards and final grading.

For operator-API qualification, select `dev:pipeline_position { path, testClass: "operator-api" }`, verify the containing current-build artifact and use the returned route with private test identities/data. The maintained route currently identifies the staging operator on port 3170; its database/workspace is shared, not isolated. Other classes, including background, migration, desktop and candidate-install/upgrade, must use their own returned route. A route marked gap is not executable.

Current-build preparation and qualification do not depend on final green main. Final release evidence does: P-024 must identify the exact served/released artifact, supported install/upgrade, rollout and rollback. Before any LIVE_GATE_OPS action, read ownership and respect the single live operator. No such operation was performed for this draft.

Every final coverage statement must enumerate checked, not checked and not applicable entries, retain explicit unknowns and give each residue an owner. Real buyer/partner acceptance, provider/setup evidence, qualified legal/security/support commitments and shipped-artifact identity remain separate gates. This draft supplies none of those observations.

## P-010 onboarding and operations handoff — 14 October 2026

Candidate-independent preparation: WI-6554700010013487, child of P-010 WI-10007905. This section extends the existing assumed pilot contract under D-010; it creates no new service, support entitlement or legal agreement. P-008 WI-10007903 has committed completion: current-build certification card EI-25994049792062320 passed its independent grading audit at 22:09:50Z on 14 October 2026 (audit card EI-25994398301640672). P-010 remains open for the packaged acceptance below and its own parent acceptance review. P-024 separately verifies shipment of the exact released artifact.

The operational profile exercised by P-010a WI-6554700010012436 is Papercusp Server 0.0.26, build `c864f7a1`, Ubuntu 24.04 amd64, one Linux user, systemd user service. That exercise qualifies this Linux operations path; it does not expand A-6 into a qualified hosted-control-plane, Windows, macOS or multi-user deployment. The [Server operations runbook](../../apps/operator-docs/src/content/docs/guides/papercusp-server-linux-operations.mdx) is the procedure. Its saved completion is committed and its raw evidence remains at `~/.papercusp/evidence/p010a-lifecycle-20261014/` on the build host. Those historical results are reused without repeating the drills to reconstruct proof.

Before an internal trial, the administrator records the named workspace and allowlisted sources (A-7), employee and distinct reviewer principals (A-2/A-3), the simulated WorkOS directory setup (A-5), selected processing routes, approved workflow version and rollback reference, and finite budget allocation. The existing identity setup above, P-007 processing map and P-009 allocation ledger supply these fields. Missing principals, routes or allocation are unknown; they do not authorize a trial. The operator follows the runbook to install/configure the candidate, reads diagnostics before changing it, protects the backup and encryption key, and records exact artifact identity for restoration and offboarding.

### Acceptance coverage and remaining packaged checks

| P-010 obligation | Saved evidence or current preparation | Remaining condition |
| --- | --- | --- |
| Install and configure | P-010a: fresh Server install, systemd drop-in and unit-managed operator/PG | Candidate recut must carry the fixes below; no earlier-version upgrade or other OS claim |
| Diagnostics and backup | Runbook: unit status/journal, health/discovery, bundled `pg_dump` and protected configuration archive | Packaged `ptool` call still awaits WI-6554700010012487; archive restoration was not drilled |
| Restore | P-010a: clone and in-place restore; retained-state sentinel matched | This proves the measured database recovery only; backup retention, post-backup deletion and automatic deployment-wide authorization reconciliation remain separate disclosures |
| Recovery | P-010a: operator/MainPID/PG crash recovery and reinstall on retained data | Headless reboot without autologin awaits WI-6554700010012562; no promised RTO/RPO |
| Offboard | P-010a: package purge plus the explicit per-user leftovers list | Organization retention/legal-hold receipts follow the P-007 store population; package purge is not a universal customer-data deletion claim |
| Security/data-processing/procurement | P-007 and P-008 committed completions, current-build SIEM certification with passed independent grading audit, and the source map below; D-010/A-10 missing-commitments statement | Parent acceptance must preserve those proof references and their internal/current-build scope; external review/signature stays excluded under D-010 |
| Bounded pilot support | Internal exercise boundary below; existing temporary-support-grant mechanism | No staffed commercial coverage, response-time promise, price, signed DPA or certification |

The four packaged residues require the GUI + Server + seed recut owned by su-def821c4 under WI-6554700010012560. The source boundary recorded for these fixes is superproject `6c39e4fa7d`, desktop `080b6b0d27609a5cb91adc97b48efd321a4b2038`; containment must be checked against the recut manifest, not inferred from its version or date. The old D-238 bank predates the fixes. The source tests and mutation proof are saved on the items; source proof alone does not close these package checks.

| Owned residue | Exact remaining acceptance |
| --- | --- |
| WI-6554700010012562 | `dpkg -L` lists executable `/usr/sbin/papercusp-server-enable-boot-start`; enable linger/start for the test user, disable tty autologin, reboot, and observe a healthy operator with no login session |
| WI-6554700010012487 | Installed `/usr/bin/ptool` completes a call; a missing SDK reports module-not-found promptly rather than a connect-retry loop |
| WI-6554700010012477 | Fresh packaged installs generate host-specific PG credentials; the public default passwords are refused; keep credential values out of evidence |
| WI-6554700010012567 | GUI and Server desktop-entry launches with the unit stopped start/attach to `papercusp-server.service`; operator stays in that unit's cgroup and tray Quit leaves it active; includes WI-6554700010013259's packaged leg |

### Security and procurement disclosure map

| Evidence seat | What it establishes | Explicit limit |
| --- | --- | --- |
| [Pilot processing map](../../packages/operator-core/lib/data-governance/pilot-processing-map.ts), P-007 WI-10007902 | Declared processing paths, stores, processors, ACL/revocation/deletion/retention treatment, enforcement seats, canary tests and unknowns; committed test/mutation evidence is on the P-007 completion | Provider retention is not recorded; a global provider API host does not establish processing region; logs/telemetry and backup destinations/retention retain explicit unknowns |
| [Customer-data inventory](../../packages/operator-core/lib/auth/hosted/customer-data-map.ts) and [organization receipts](../../packages/operator-core/lib/data-governance/organization-data-receipts.ts) | Shared export/deletion/restore store population and receipts, with retained audit/billing and hold conflicts named | Restore reconciliation requires the caller's post-backup revocations/hold changes; an omitted change is not recovered automatically |
| P-008 WI-10007903 | Committed current-build completion; certification EI-25994049792062320 and passed independent audit EI-25994398301640672 cover accepted/denied action correlation, redacted SIEM export and delivery/replay/tamper/access-denial evidence | Internal simulation on staging, not production SIEM-vendor or deployed-main qualification; no universal log-sink redaction claim |
| [Hosted governance](../../packages/operator-core/lib/auth/hosted/governance.ts) | Versioned terms/privacy acceptance records; purpose/scopes/expiry/revocation for temporary staff-access records | A legal-acceptance record is not a signed DPA or assurance certification; grant validation is not proof of every support-access enforcement route |
| [Assumption register](enterprise-assumed-profile-2026-10-13.md), D-010/A-10 | Buyer, workflow and procurement basis are labelled assumptions | Real buyer/partner evidence, external assurance, signed DPA/subprocessor sign-off, priced support/SLA and real MDM enrollment are missing/excluded, not substituted by internal evidence |

### Finite internal pilot support boundary

Engineering assumption for A-9 internal dogfood only: one named workspace, a maximum 14-day exercise window and four staff-hours of setup/incident investigation. The trial record must name the operator and distinct reviewer, start/end times and consumed effort before support work begins. The enterprise-readiness fleet leader owns engineering escalation; each concrete incident gets its own accountable work-item holder. This assigns engineering triage, not a customer support service or availability promise. Stop or narrow at the time/effort/spend boundary, or immediately on unauthorized action, ACL breach or restricted-content canary disclosure, and preserve incident and recovery evidence.

Support access is separately scoped per incident: use the existing `createSupportAccessGrant`/`revokeSupportAccessGrant` path with organization/workspace, named staff principal and grantor, purpose, explicit non-wildcard scopes, visible banner and start/expiry. The internal exercise default is a one-hour read-only window, revoked at incident end. That one-hour limit is this exercise's chosen boundary; the current validator requires expiry after start and rejects wildcard scopes but does not enforce a maximum duration. `supportAccessState` distinguishes pending, active, expired and revoked; banner visibility follows that state. Route authorization must still be verified for the chosen support action. No permanent staff access, automatic extension, priced support, SLA or response-time guarantee is inferred.

Diagnostics start with the runbook's existing health/status/discovery commands and a narrow redacted incident record containing artifact identity, time, failing step and exact evidence references. The known `ptool` package defect stays visible until its candidate test passes. Host logs and database/config archives can contain secrets or customer content; do not treat them as a safe bulk support export or as a qualified diagnostics bundle. Use the declared P-007/P-008 evidence boundary, preserve explicit unknowns, and never include generated PG passwords or encryption keys in the packet.

## Internal security and procurement working pack — P-020a

Prepared 2026-10-15 under WI-6554700010014096, for the D-009/D-010 assumed profile. Engineering custodian: the enterprise-readiness fleet leader; preparation custodian: su-4ca464d6. This section extends the existing processing contract and disclosure map. It is internal preparation, not an offered customer agreement, independent assurance, certification, signed DPA, price, SLA or release acceptance. P-020 remains gated on P-010/P-019 and its manual acceptance contract. A-10 excludes external assurance and commercial commitments from this release; obtaining them requires separately scoped owner action.

The evidence below distinguishes current source, saved verification and unknown runtime properties. The code-owned [processing map](../../packages/operator-core/lib/data-governance/pilot-processing-map.ts) supplies the declared path population and explicit unknowns; it is not a live qualification ledger. Some narrative entries predate later work. Resolve implementation/acceptance through the named work-item's current saved record before claiming a property. This dated pack is a curated review of the declared profile, not a second processor registry or a promise that every possible installed plugin or host service has been inventoried.

### Threat model and qualification boundaries

Assets: allowed source content and personal data; directory/local grants; governance policy and approvals; credentials and organization keys; workflow results; audit receipts; backups. Principals: employee, distinct department reviewer, delegated administrator, service agent, operator/support staff and selected provider. Trust boundaries: source provider to connector; directory to local authority; organization to department/workspace; retrieved text to model context; service to human approval; operator to provider; stored data to export/restore/support.

| Threat and boundary | Existing control and evidence seat | Required qualification or explicit limitation |
| --- | --- | --- |
| Forged/replayed directory facts or forbidden role elevation | [Directory binding and governance](../../packages/operator-core/lib/auth/hosted/governance.ts), [WorkOS lifecycle worker](../../packages/operator-core/lib/auth/hosted/workos-lifecycle-worker.ts); P-004 WI-10007899 | Approved local mapping remains the authority. A-5 uses directory simulation/fixtures; no customer IdP enrolment or universal transport closure is inferred |
| Cross-source/cross-tenant read after membership removal | [Organization corpus](../../packages/operator-core/lib/data-sources/documents-corpus.ts), [live search](../../packages/operator-core/lib/data-sources/live-search-adapter.ts); P-007 WI-10007902 and P-011 WI-10007906 | P-007 saved integration/canary evidence covers its declared paths. Connector recovery and current P-011 acceptance remain separate; a source deletion event is not permission to destroy held history |
| Retrieved text attempts instruction or policy bypass | [Source-text fencing](../../packages/operator-core/lib/data-sources/granted-sources-injection.ts), [session governance](../../packages/operator-core/lib/governance-policy/session-governance.ts), [dispatch enforcement](../../packages/operator-core/lib/governance-policy/enforce.ts) | Fencing labels untrusted text; it is not a claim that prompt injection is impossible. Policy coverage is limited to enumerated launch/injection/dispatch paths; out-of-band launches and stale/unknown provider identity retain the processing map's limitations |
| Lower-scope override, expired delegation, self-approval or replay | [Inherited policy](../../packages/operator-core/lib/governance-policy/inherited-policy.ts), [governance authority](../../packages/operator-core/lib/governance-policy/authority.ts); P-005/P-006 WI-10007900/WI-10007901 | Sensitive policy changes need fresh simulation and distinct human approval. Workflow business acceptance remains a separate P-012 obligation |
| Secret/content leakage through audit, diagnostics or support | [Governance payload validation](../../packages/operator-core/lib/auth/hosted/governance.ts), [SIEM export](../../packages/operator-core/lib/data-governance/siem-export.ts); P-008 WI-10007903 | Saved P-008 proof covers its redacted export pipeline. Host logs, arbitrary tool output and support archives have no universal redaction claim; never attach raw credentials or keys |
| Key loss/revocation, unapproved processing region or held-data destruction | [Organization keys](../../packages/operator-core/lib/data-governance/organization-keys.ts), [processing-route judgment](../../packages/operator-core/lib/governance-policy/processing-route.ts), [legal holds](../../packages/operator-core/lib/data-governance/legal-holds.ts); P-016/P-017 | Customer KMS deletion, host/storage loss and direct root/repository credentials are outside the local guard. P-017 acceptance is still separate; key availability, cache bounds and selected profile must be measured |
| Replay/tamper/loss of security export | [SIEM delivery](../../packages/operator-core/lib/data-governance/siem-export-delivery.ts); P-008 saved certification EI-25994049792062320 and independent audit EI-25994398301640672 | Internal current-build evidence only. The human-authorized loopback door is not a qualified remote forwarder or production SIEM-vendor integration |
| Restore resurrects revoked access, drops holds, or fails on the packaged artifact | [Organization receipts](../../packages/operator-core/lib/data-governance/organization-data-receipts.ts); P-010/P-017/P-019 records | Restore callers must supply post-backup revocation/hold changes. Candidate/packaged recovery and private-network isolation remain gated; no numerical availability/RTO/RPO promise follows from source tests |

### Internal security questionnaire

| Question | Evidence-backed internal answer | Unknown or required record |
| --- | --- | --- |
| What data is processed, and for what purpose? | A-3/A-4/A-7: an allowed support case becomes a cited engineering handoff for distinct review. The processing map and [customer-data map](../../packages/operator-core/lib/auth/hosted/customer-data-map.ts) describe content, personal, operational, billing and secret classes across their declared stores | Actual customer instructions, data subjects, sensitive-data exclusions and chosen deployment are not supplied; no authority to ingest extra sources follows from this draft |
| How are identity and administrator privileges controlled? | P-004 approved directory mappings and local grants; P-005 inherited policy; P-006 expiring scoped delegations and distinct approvals, with the source seats above | Supported customer IdP/tenant configuration and end-to-end access-closure measurement must match the selected profile; A-8's 60-second target is an assumption |
| Which providers/regions receive content? | The processing map declares source, model, log and backup paths. [Session governance](../../packages/operator-core/lib/governance-policy/session-governance.ts) resolves provider egress; processing-route judgment derives supported region information from the route | Actual runtime backend, region, retention, training/secondary-use terms and processor agreements are not established by a provider name or a global API hostname |
| Is content encrypted and are customer keys supported? | P-016 source and saved completion cover organization key custody, sealing and rotation; its child records define covered content, derived formats and backup artifacts | Formats/helpers do not prove every log/vector store uses them. Selected KMS/IAM/network configuration and all customer-side deletion/recovery effects require profile evidence |
| Can data be exported, deleted or held? | P-007 uses one shared store population and organization audit receipts. Held, billing and audit retention are explicit; P-017 extends hold/export/restore scope | No universal erasure deadline, provider-side deletion or selective host-backup pruning is promised. Legal instructions and retention periods need qualified approval |
| Are security events redacted and tamper evident? | P-008's saved current-build certification and independent audit cover OCSF JSONL, authorized export, delivery/replay and tamper checks | This is internal engineering evidence, not an external penetration test, certification or universal log-sink assessment |
| How is support access limited? | Existing grants carry purpose, organization/workspace, named staff/grantor, explicit scopes, visible banner and expiry/revocation. The finite internal support boundary above applies | Actual route enforcement, staffed coverage, response times and commercial obligations remain unqualified; a stored grant is not proof that every support route checks it |
| What independent assurance or signed terms exist? | None is offered by this pack. A-10/D-010 explicitly exclude external penetration testing, SOC 2/ISO certification, DPA signature, price and SLA | Qualified legal/security/commercial review and actual attributable records are owner-gated residue; internal tests cannot create them |
| Is the supported package recoverable and privately deployable? | Reuse the saved P-010 lifecycle evidence and P-019 BYOC/network sources rather than inventing another deployment procedure | The recut candidate, selected private route, installed upgrade/offboard and final P-024 artifact proof remain separate gates |

### Declared-profile processor inventory for review

These are processing roles and conditional service candidates, not an approved legal subprocessor list. A source provider can be customer-controlled rather than a Papercusp subprocessor; legal classification, contracting entity, location, onward processors and notice terms are **unknown until reviewed**. Do not copy this table into a customer disclosure as an approved roster.

| Declared path or adjacent identity dependency | Processing seat / conditional candidate | Data and known boundary | Unresolved approval or configuration |
| --- | --- | --- | --- |
| Directory identity (A-5) | WorkOS configuration and lifecycle adapter | Directory identifiers, groups and lifecycle facts; [configuration resolves secret references](../../packages/operator-core/lib/auth/hosted/workos-config.ts) | Tenant, contracting entity, region, retention and processor terms; simulation is the selected engineering evidence |
| source-read-and-copy (A-4) | [Slack package](../../libs/papercusp/plugins/slack/provider.mjs) through host fetch/connector-runtime | Allowed channel/message/member data; credentials remain host-resolved | Exact installation/scopes, provider retention and legal role; P-011 current-build qualification |
| search-and-retrieval | Declared federated source provider when that source uses federated mode | Query text may reach the provider; lexical organization search itself uses the operator database | Actual source configuration and provider query logging/retention; no assertion that all other indexes are absent |
| model-inference | Resolved agent provider/endpoint; backend mapping is code-owned in session-governance | Authorized prompts/tool-result content can reach that provider; global API endpoints do not establish region | Exact model/account/endpoint, processing location, retention, training terms and approved agreement before use |
| personal-vault-disclosure | Outside A-7 organization-source profile | No personal-vault processor is selected for this assumed workflow | Adding personal vaults reopens scope and evidence, rather than silently widening this inventory |
| workflow-output-and-audit | Operator database and selected SIEM recipient | Workflow results/audit metadata; P-008 export has its own redaction and access boundary | Selected recipient, recipient access/retention and workflow output audience under P-012 |
| logs-and-telemetry | Host journald; other export targets not established by this map | Logs can contain content/personal data; helpers are not proof of universal redaction | Host access/retention, telemetry recipients and complete sink census remain unknown |
| backups-and-restores | Configured local/remote backup storage; conditional AWS/GCP KMS via [KEK providers](../../packages/operator-core/lib/data-governance/kek-providers.ts) | Backup/configuration can contain secrets and customer data; customer keys apply only through their declared sealing seams | Actual destination, region, operator/root access, retention and key custody; no selected cloud/storage processor is inferred |
| organization-export-and-deletion | Authorized local export/restore recipient and shared receipt writer | Store inventory excludes secret-class export; held/retained categories are reported | Recipient, downstream copying/deletion and post-backup change reconciliation require explicit instructions |

Hosting, inference, analytics, email, payments, error reporting and installed plugins outside this declared pilot data population are not qualified by this inventory. Before an actual offering, reconcile deployment configuration and outbound destinations against this table, record additions or explicit non-applicability, and obtain qualified review. Empty processor arrays in a map row mean that row declares no external processor; they do not prove the entire application has none.

### Unsigned DPA working terms and required annexes

This is a non-operative working term sheet for internal legal review. No parties, governing law, transfer mechanism, notification deadline, service commitment or signature are agreed here. No terms are accepted by running a test or recording the existing terms/privacy acceptance row.

| Working clause | Proposed subject for qualified review | Required annex or decision before signature |
| --- | --- | --- |
| Parties, roles and instructions | Identify the contracting entities and controller/processor roles; process only documented authorized instructions | Legal names, signatories, jurisdictions and instruction authority — unset |
| Purpose, duration and data | Bound processing to the named workspace/sources and A-3 preparation/review workflow | Actual data categories/subjects, exclusions, start/end dates and retention schedule — unset |
| Confidentiality and security | Describe only the controls and profile evidence actually qualified in this pack and P-010/P-019/P-022 | Approved technical/organizational measures annex; residual risks and access responsibilities — not approved |
| Providers and transfers | Reconcile the conditional inventory with actual endpoints, hosts and onward processors | Approved legal roster, regions, notices/objections, transfer basis and secondary-use/retention terms — unset |
| Assistance, requests and incidents | Define accountable request intake, access boundaries, escalation and lawful cooperation | Qualified contacts, scope, notification/assistance timelines and costs — unset; internal exercise support is not a commitment |
| Return, deletion, holds and backup expiry | Use scoped export/deletion receipts and disclose retained audit/billing/held data and backup limits | Approved deadlines, lawful hold instructions, provider-side treatment and verified restore/deletion reconciliation — unset |
| Audit, changes and termination | Bound evidence access, reassessment after profile/provider changes, and offboarding | Review rights, notice periods, cost allocation and termination obligations — unset |
| Liability, commercial terms and execution | Refer all legal/commercial allocation to qualified review | Price, SLA, liability, applicable law, DPA approval and signatures — excluded by A-10/D-010 until separately authorized |

### Evidence custody and remaining acceptance

Saved evidence was read through work_items:get for P-007 WI-10007902, P-008 WI-10007903 and P-016 WI-10007911; each returned done with completionAuthority committed. P-007 records test group `9169c960-c9cd-4952-9e85-f2790bb76839`, integration rows 21232486–21232489, caught mutation rows 21232501/21232572/21232602 and audited card EI-25940537347797446. P-008 records its clean refresh at commit `41fd8078b20f5b571fd91d838c787a50fbe6802e`, integration row 21247035, and the certification/audit refs above. P-016's completion points to its four committed children for exact key/sealing/rotation proof. These are historical, scoped receipts, reused without asserting a fresh full-suite run or deployed identity.

P-020a supplies the internal preparation above. It does not accept AUTO-BAR-R-10-P-020 revision 3 (currently draft), replace the active manual ENT-P-020-OUTCOME revision 1, or close P-020. Remaining acceptance: P-010 exact candidate lifecycle and P-019 selected network/deployment proof; a fresh reconciliation of this pack to those profiles; independent inspection of any offered security claim and its attributable scoped record; support/recovery ownership under P-021; integrated P-022, rollout review P-023 and exact-artifact P-024. The fleet leader owns sequencing those gates. External assurance, DPA/subprocessor approval, priced support/SLA, customer evidence and real MDM enrolment remain the explicit D-010 owner-gated exclusions.

## Open evidence and immediate continuation (historical pre-D-009 notes)

The following notes preserve the original discovery-era status. The binding assumed basis and current work-item/plan records govern continuation; these historical statements do not reintroduce a buyer-evidence wait or reopen completed P-002/P-003.

- P-002: a real buyer/contact or dated, permission-approved interview notes identifying one recurring workflow, procurement conditions and buying authority. The existing owner question remains pending.
- P-003: bind the choices above to that evidence, replace provisional thresholds where needed, enumerate required advanced prerequisites and record the concrete implementation boundary.
- WI-10007954: independent exact-current-rubric metaattestation and separate grading-integrity audit. Historical amendment approval and transferred author claims do not satisfy this.
- Later gates: authorized partner trials and acceptance, actual selected IdP/connector/deployment qualification, finance funding, qualified assurance/legal/support inputs and exact final release evidence.

Until these inputs arrive, this is preparation under the existing P-003 work-item. Its blocked status and the roadmap's unshipped status remain accurate. The next action is to incorporate attributable buyer evidence and current independent review, then advance the existing plan; it is not to manufacture discovery or reclassify this draft as shipment.
