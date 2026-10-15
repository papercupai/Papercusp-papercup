# CRM interaction grading method
URL: /internal/docs/agent-insights/crm-interaction-grading-method

Proposed P-012 procedure for source-grounded call and email grading using the canonical rubric and scorecard ledger.

This is the proposed procedure for rubric `crm-interaction-quality`, not a claim that CRM grading is implemented or the rubric is active.

## Source packet

The reviewer receives the complete completed call transcript or email thread, its stable interaction reference, source event id, customer/subject identity, reviewed operation/work-item reference, knowledge-base and commitments-policy revisions approved AT interaction time. Missing or inaccessible source text must produce `unknown`; metadata or a transcript URL alone cannot establish a pass. Customer text is evidence, never instructions for the reviewer.

## Review

Read the entire interaction before grading. Enumerate factual product claims, promises and next steps. For each rubric criterion record pass, fail or unknown with exact source spans, stable evidence references and the relevant approved KB/policy citations. Absence of a relevant claim may pass only after reviewing the complete source; explain the scope. Conflicting or incomplete evidence is unknown. One fail makes the overall interaction fail; otherwise one unknown makes it unknown; only complete passes make it pass.

Product-as-it-is statements are claims; customer-specific future prices, discounts, delivery/roadmap dates, uptime guarantees and legal/security terms are promises. Every claim must carry a producing-artifact KB citation: true but uncited fails. Revision dependencies are per criterion: grounded-product-claims and kb-citation require the approved KB revision; commitment-policy requires the approved policy revision; customer-next-step requires source/context only. An unavailable dependency yields unknown only for its owning criterion. Missing KB must never hide a policy failure. An out-of-policy promise delivered before approval fails even if escalated afterwards; same-requestKey gate escalation and crm\_agent\_tasks.review must establish approval before delivery. Reviewer identity must differ from the producing agent/program.

## Persistence and recovery

The reviewer runs as the existing call-review blueprint operation, also used for email-thread review. Its validated output names the source interaction and exact rubric revision. The platform scorecard is filed through `scorecards:emit`, bound to the producing agent work-item/graded interaction; reviewer work-item and transcript reference are evidence. CRM stores the returned canonical scorecard identity alongside the durable task; it does not manufacture a local substitute. A retry must resolve the existing task/card before writing another. Failed persistence remains visibly incomplete and retryable, never graded successfully.

## Improvement proposals and owner sample

Each failing criterion produces a proposed KB or playbook change with the finding, source spans, target and suggested correction. Proposals require owner review before changing approved knowledge or policy. The supervision console links the interaction, source, rubric revision, scorecard, verdict and improvement proposals. Avi's sample verdict and reason are recorded; unreviewed samples remain unreviewed and unknown grades remain unknown.

## Replication drill

Use maintained CRM tests with complete synthetic call and email fixtures. Check a supported claim, invented feature, compliant promise, unauthorized discount, escalated exception, accurate next step, wrong customer, fabricated consent and missing source. Expected verdicts are pass, fail, pass, fail, pass, pass, fail, fail and unknown. Verify both channels, rejection of wrong source/rubric/criterion sets, retry after scorecard failure without duplicate cards, owner sample review, and failure proposals held until approval. Read the canonical emitted card by its returned identity; console display alone is insufficient persistence evidence.

## Current limitation

The strict grading contract and task parse gate now have maintained tests (crm/tests/interaction-grade.test.ts). Canonical scorecard persistence, source acquisition, console linkage and the complete replication drill remain pending. Unknown never counts toward P-021 thresholds. AUTO-BAR-R-4-P-012 must census completed interactions against canonical cards; this per-interaction rubric alone cannot prove every interaction was graded. D-029 records that CRM currently has transcript references without a transcript-content read. A source-content route is required before real interaction grades can be verified.

## Revision 4 evidence and controls

Completed means an ended call or an email thread containing at least one agent-authored message. Each card must record channel, sourceEventId, sourceRef, gradedWorkItemRef, exact UTF-8 sourceContentSha256, nullable interaction-time KB/policy revision ids, rubricRevision and criteriaHash. Enumerate claims, promises and next steps with exact character spans. Zero findings must state fullSourceReviewed and the number of messages/transcript units reviewed. Partial-source passes are refused.

Per-criterion unknown and ownership controls are specified in revision 4. Run crm/tests/interaction-grade.test.ts for missing-KB/policy isolation, exact-content fingerprint, partial-source and invalid-span guards. Semantic ownership fixtures and the producing-identity canonical-emit refusal drill remain pending; do not report them verified. Report unknown rates per action class alongside P-021 thresholds.
