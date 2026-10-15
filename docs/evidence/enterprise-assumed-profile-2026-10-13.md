# Enterprise assumed profile (D-009) — the basis for the first enterprise release

13 October 2026 · P-002 / WI-10007897 · `papercusp-enterprise-readiness-roadmap-2026-10-09#D-009`

> **Status: ASSUMED, not buyer evidence.** On 2026-10-13 Avi (owner directive #1817) ruled: "put yourself on auto mode and carry it to shipped status. plan it without that evidence". This document replaces the plan's missing buyer and workflow evidence with **explicit assumptions**. Nothing here was supplied by a buyer, design partner, interviewee or customer. No prospect was contacted. Every row below is an engineering assumption. A later real-buyer finding that contradicts a row overrides it and reopens the affected item.

## Assumption register

Each assumption has an id. Plan items, tests and acceptance evidence cite these ids, never "buyer requirement".

| Id | Assumption | Source of the assumption | Overridden by |
| --- | --- | --- | --- |
| A-1 Segment — ASSUMED | A developer-tools / infrastructure software company with 200–2,000 employees | D-008 engineering profile; [discovery packet](enterprise-buyer-discovery-packet-2026-10-09.md) hypotheses | Attributable buyer discovery |
| A-2 Buyer and roles — ASSUMED | Buyer: the engineering/support lead. Distinct roles: IT/security administrator, department reviewer, finance approver, employee | [pilot contract draft](enterprise-pilot-contract-draft-2026-10-11.md) § product shaping | Actual organisation chart |
| A-3 Workflow — ASSUMED | Support-to-engineering handoff: an employee selects an allowed support case. The workflow prepares a cited summary, reproduction steps or a next-action checklist, and a suggested responsible role. A distinct reviewer accepts it, rejects it, or asks for rework | pilot contract draft § proposed journey | Accepted case/output definition |
| A-4 Connector — ASSUMED | The existing Slack organisation adapter (read). Repository context is used only where separately authorised. Source writes need separate authorisation | D-008; census | Actual source systems |
| A-5 Directory — ASSUMED | WorkOS Directory Sync as the supported directory feed. The test IdP is WorkOS's directory simulation and fixtures; no customer IdP tenant is used | D-008; existing WorkOS receipt path | Named customer IdP |
| A-6 Hosting — ASSUMED | One profile: the Papercusp desktop app plus the hosted control plane, qualified on current-build (staging/:3170 or an isolated instance). Customer-cloud BYOC is a documented, separately validated profile (P-019) | pilot contract draft § release boundary | Buyer hosting choice |
| A-7 Data scope — ASSUMED | One named pilot workspace with allowlisted sources. Inference, embedding, log and backup routes are declared in the P-007 processing map | pilot contract draft § threat contract | Classified stores and approved routes |
| A-8 Thresholds — ASSUMED | ≥30 comparable cases. ≥80% accepted outputs. Median review time ≥30% below baseline. Access closes ≤60 s after an accepted revocation. Finite funded spend allowance. Restore exercise passes | pilot contract draft § success, cost and stop criteria | Approved customer thresholds |
| A-9 Trial cohort — ASSUMED | No external design partners. P-015 runs an **internal dogfood trial**: the cases are labelled synthetic or self-sourced, and the reviewer is a distinct internal principal. The results are labelled `internal-simulation` and are never reported as customer evidence | D-009 | Real partner trials (owner-authority follow-up) |
| A-10 Commercial — ASSUMED | No price, SLA, DPA signature, certification or support contract is offered or implied | D-009 owner-authority boundary | Owner-approved commercial terms |

## What this does and does not change

- **Changes:** P-002 is satisfied by this register rather than by buyer evidence. P-003 binds the pilot contract draft's proposed defaults as the assumed contract. P-003 through P-024 proceed on that basis.
- **Does not change:** every engineering acceptance condition, hostile test and coverage rule in the plan's requirements; the live-gate ownership boundary; and every owner-authority action listed in D-009. Those actions are spend, publishing, external customer contact and credentials.
- **Residue that needs the owner** (tracked in D-010): real buyer and design-partner evidence; external security assurance (penetration test, SOC 2, ISO); priced support and SLA terms; DPA and subprocessor sign-off; and enrolment in a real MDM tenant (Intune or Jamf).
