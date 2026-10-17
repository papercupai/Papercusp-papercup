# Hosted BYOC — legal and privacy sign-off checklist (ready-to-use package)
URL: /internal/docs/agent-insights/hosted-byoc-legal-privacy-signoff-checklist

Checklist for counsel/owner before hosted BYOC handles customer data: data inventory and flows, subprocessors to confirm, DPA, retention/deletion, the exact vendor-unreadable confidentiality claim and its caveats, PostHog/diagnostics consent, policy documents. Prepared, not signed (byoc-deferred-cut-carrier-2026-09-01#D-006).

# Hosted BYOC — legal and privacy sign-off checklist

**Status:** a prepared package. This is not legal advice; it is the list of questions counsel and the owner must answer before hosted BYOC handles real customer data. Avi chose "Drop for now" for the legal/privacy sign-off item (`byoc-deferred-cut-carrier-2026-09-01#P-007`, ruling `#D-006`, 2026-10-15). Tracked as WI-6554700010014747. The companion pentest scope is `agent-insights/hosted-byoc-external-pentest-scope`.

Each row lists the evidence that answers it. A row is signed only when the named person accepts that evidence.

## 1. Data inventory and flows

| What                                                                              | Where it lives                                                                                    | Who can read it                                                                                            | Evidence                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Account, organization, membership, role, session, entitlement and billing records | Hosted control-plane Postgres (the `papercusp_auth` schema). **Re-count the tables at sign-off.** | Papercusp operators                                                                                        | `packages/operator-core/lib/auth/hosted-*.ts`                                                                             |
| BYOC workspace content: files, terminal, apps, desktop stream                     | The **customer's own cloud account** (AWS or GCP)                                                 | The customer. It crosses the hosted relays sealed end-to-end (Noise); the control plane never holds a key. | `packages/operator-core/lib/workspace-host/byoc-sealed-channel.ts`                                                        |
| Relay control metadata: `contentType`, routing, timing, frame sizes               | Hosted control plane; may appear in logs and audit                                                | Papercusp operators                                                                                        | `hosted-relay-confidentiality-registry.ts` classifies every frame field as `content` or `control`                         |
| Product telemetry                                                                 | PostHog                                                                                           | Papercusp                                                                                                  | `packages/operator-core/lib/posthog-config.ts`, `cloud-telemetry-posthog.ts`, `telemetry-kinds.ts`, `record-telemetry.ts` |
| Customer-enabled diagnostics (excerpts)                                           | Shared only when the customer turns diagnostics on                                                | Papercusp support                                                                                          | `packages/operator-core/lib/workspace-host/diagnostic-excerpt.ts`; plan `cloud-monitoring-byoc-privacy-2026-10-13`        |

* [ ] **Hosting location disclosed or changed.** `app.papercusp.com` currently reaches a single Papercusp-operated machine through a Cloudflare tunnel (`papercusp-hosted-control-plane.service`). Before real customers: state the hosting region, or move to production hosting.
* [ ] **Data residency.** Name the regions for the control plane, PostHog and backups.
* [ ] **Backups.** Say where backups of the control-plane database are kept, how long, and who can read them.

## 2. Subprocessors to confirm

This list comes from the hosted environment's configuration keys and the code. Confirm or correct each row; add a contract or DPA link where one exists.

| Subprocessor                                          | Role                                                                                     | Sees                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkOS                                                | Sign-in, identity                                                                        | User identity and organization membership                                                                                                                                           |
| Stripe (test mode now; live billing dropped by D-006) | Billing                                                                                  | Billing identity and usage                                                                                                                                                          |
| Cloudflare                                            | DNS, tunnel, edge TLS                                                                    | Control-plane HTTP traffic after TLS ends at the edge. **Not** BYOC content, which is sealed end-to-end.                                                                            |
| PostHog                                               | Product telemetry                                                                        | Telemetry events (scope set by the consent rows below)                                                                                                                              |
| Google Cloud                                          | Hosted GCP projects for workspace and organization identity (`PAPERCUSP_HOSTED_GCP_*`)   | **Confirm** what is stored there                                                                                                                                                    |
| AWS                                                   | Papercusp AMI publication. BYOC workspaces themselves run in the **customer's** account. | Image artifacts only (confirm)                                                                                                                                                      |
| LLM providers (Anthropic, OpenAI, …)                  | Agent inference, **if** routed through Papercusp                                         | **Confirm** whether hosted BYOC ever sends customer prompts through a Papercusp-held key, or always uses customer-held credentials (`workspace-host/agent-credential-admission.ts`) |
| Email provider                                        | Notifications                                                                            | **Confirm** whether one exists                                                                                                                                                      |

* [ ] A public subprocessor list page, plus a process for notifying customers of changes.

## 3. Contracts and policies

* [ ] Data Processing Agreement template, with Standard Contractual Clauses for EU/UK data.
* [ ] Terms of Service and an Acceptable Use Policy.
* [ ] Privacy policy that matches sections 1 and 2 exactly.
* [ ] Cookie notice. `__Host-papercusp_session` is strictly necessary. Analytics cookies (PostHog) follow the consent rows in section 5.
* [ ] Security page and a vulnerability-disclosure contact.
* [ ] Incident response and breach-notification commitment (GDPR: the authority within 72 hours; customers without undue delay), with a named owner.
* [ ] Record of processing activities. Decide whether a DPIA is needed.

## 4. The "vendor-unreadable" confidentiality claim

Plan `hosted-byoc-confidentiality-correction-2026-10-02` is shipped (9 of 9 items, independently graded). Counsel must approve the **exact** marketing and contract wording, and it must not claim more than the code enforces:

* [ ] **What is true:** BYOC customer content on the four relay planes (workspace-session, operator-http, app-http, desktop-viewer) is sealed end-to-end. The control plane routes ciphertext and holds no key.
* [ ] **Caveats the wording must include:**
  * Papercusp sees control metadata (channel type, routing, timing, sizes).
  * Cloudflare sees control-plane traffic (not sealed content).
  * Diagnostics the customer turns on share excerpts.
  * Support grants exist, and are scoped, expiring and revoke-only (tested in `hosted-two-tenant-acceptance.integration.test.ts`).
* [ ] Account and billing data (section 1, row 1) is **not** vendor-unreadable. Say so plainly.

## 5. PostHog and diagnostics consent

**Blocked until plan `cloud-monitoring-byoc-privacy-2026-10-13` ships.** It is still open (2 of 6 items done as of 2026-10-15). Once it ships:

* [ ] Consent default (opt-in or opt-out), and where the customer changes it.
* [ ] The exact event list (`telemetry-kinds.ts`), with PII scrubbing or hashing of identifiers.
* [ ] BYOC diagnostics stay customer-controlled: off by default, scoped, revocable, and the excerpt contents reviewed.
* [ ] Retention period for telemetry in PostHog.

## 6. Retention and deletion

* [ ] Export and delete exist for organizations and users (`/hosted/browser/data/{organization,user}/{export,delete}`, in `endpoint-route/hosted-browser.ts` and `hosted-runtime.ts`), and are tested for tenant scoping. Document the turnaround times you promise customers.
* [ ] Write down retention periods for audit logs, session records, billing records (Stripe's legal-retention needs), telemetry and backups.
* [ ] Deletion propagates to backups and subprocessors, or the exception is disclosed.

## 7. Sign-off

| Area                              | Signer                                   | Evidence link | Status  |
| --------------------------------- | ---------------------------------------- | ------------- | ------- |
| Data inventory and residency      | Owner                                    |               | open    |
| Subprocessors                     | Owner + counsel                          |               | open    |
| DPA, ToS, privacy policy          | Counsel                                  |               | open    |
| Confidentiality claim wording     | Counsel                                  |               | open    |
| Telemetry and diagnostics consent | Counsel, after the monitoring plan ships |               | blocked |
| Retention and deletion            | Owner + counsel                          |               | open    |
