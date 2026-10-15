# Assisted repository-maintenance pilot — offer and acceptance
URL: /internal/docs/commercialization/assisted-repository-maintenance-pilot

Selected $500/30-day customer-key pilot offer, explicit models, ZDR, finite exposure and cancellation; real payment, economics and release acceptance remain required.

# Assisted repository-maintenance pilot — offer v1

Status: first-pilot product choices selected 2026-10-13 under papercusp-monetization-2026-09-04#D-016 and #D-017; operational acceptance remains open. Original offer authored 2026-10-03 under WI-10005829 for P-001. This document prepares the commercial offer; it is not a payment receipt, customer validation, live-hosting readiness claim or approved public license.

## Buyer and job hypothesis

A small engineering team or agency maintaining an active TypeScript/JavaScript repository wants a recurring queue of narrow, tested maintenance changes without supervising an agent all day. The initial job is a weekly repository-maintenance review: reproduce one agreed failing check or select one bounded dependency/maintenance change, prepare a reviewable patch, and provide evidence a maintainer can assess. The customer supplies the repository, permission scope and acceptance command.

Initial fit: an existing repository with a reproducible test command, a named maintainer and one agreed maintenance backlog. Exclude production database changes, credentials rotation, security exploitation, broad rewrites and publishing/merging changes without separately granted authority. The hypotheses remain unvalidated until interviews and payment/outcome evidence establish them.

## Concrete offer

A 30-day assisted pilot for one organization and one repository, with one setup session and four weekly maintenance deliveries. Each delivery contains a problem/expected-result statement, a bounded patch or draft pull request, before/after focused test evidence, relevant affected checks, a concise risk/review note and an exact source revision. A customer maintainer accepts each delivery against the agreed behavior/test command. A delivery does not become accepted merely because an agent closes a work item.

The maintainer chooses a target that fits one independently reviewable patch. If a target proves too broad, record the findings and agree a smaller target before incurring additional spend. An explicit investigated-no-change result may close an individual review only if the customer accepts that result; it is not silently counted as a successful patch.

Support includes setup plus up to two staff hours during the pilot, with responses on the next business day. Confirm the actual operator/support contact and timezone before a quote is issued. Additional work is quoted separately. No 24/7 support, uptime SLA, guaranteed number of agents or promised enterprise confidentiality is included. The pilot has no automatic renewal: any subsequent month requires affirmative agreement.

## Selected pilot price and exposure

The selected first-pilot platform/service fee is $500 for 30 days, one repository and the finite delivery/support scope above. There is no automatic renewal. Papercusp LLC is the merchant/service counterparty through the existing Stripe billing seam; actual LIVE merchant, payout and tax configuration must pass verification before collection. The existing $1 Stripe TEST offers remain test offers. P-003 must measure payment fees and labor/support costs before a quote; target at least 50% contribution margin, with a scope reduction agreed before quoting if costs exceed that target. This selection is not price validation or a live charge.

Compute, retained resources and inference are separately visible and finite. The purchase order sets a funded usage allowance and a maximum request exposure before work starts. The first pilot uses the customer's OpenRouter account and a dedicated revocable workspace key in the existing customer-runtime secret store. The customer pays OpenRouter directly; Papercusp does not resell API access or transfer/mark up credits. Default model: qwen/qwen3-coder. Explicit customer-selected premium option: anthropic/claude-sonnet-4.6. There is no automatic premium escalation or model substitution. Require provider.zdr=true for every customer-content request, including fallback routes; disable prompt/chat logging and training use. Fail visibly if no qualified ZDR route exists. Disclose OpenRouter and the selected endpoint as subprocessors without promising zero operator access. Model/task/cost/runtime qualification and the existing security requirements remain mandatory. Default customer-funded inference budget: $50 for the 30-day pilot, hard stop, no automatic top-up; an explicit customer agreement may change it. Start with existing local/customer-cloud execution and customer-direct infrastructure charges. Papercusp-hosted service remains subject to its own measured cost, security/readiness and final release acceptance. Managed inference is outside this first-pilot route and requires a separate documented provider-authorized commercial arrangement before offering it. BYOK does not mean free model access or zero OpenRouter fees.

No automatic top-up, unapproved overage or unlimited consumption. At exhaustion, stop new spend and checkpoint/drain safely. State any retained disk/IP/snapshot costs and the export/retention/offboarding period in the final quote. A platform fee is not permission to bypass the customer's spending policy.

## Customer acceptance and demonstration

Demonstration: reproduce a narrowly scoped failure in a disposable copy of a real repository, implement the smallest behavior fix, add a canonical regression, and show the failed-then-passed test with the exact patch revision. Keep example/test-mode/demo evidence visibly separate from customer acceptance and payment evidence.

A current engineering example is EI-24787677967034419: the staging-first activation classifier rejected a hosted-readiness audit as a release prerequisite. The canonical regression suite first showed six failures and then passed all 80 tests after the classifier fix. This demonstrates the proposed delivery shape; it is not a paying customer case study. The test receipt and remaining serving-runtime integration limit live on that item.

Before the first customer delivery, require P-009 assembled current-build security/readiness acceptance and P-010 final served-release identity. Do not sell a staging demo as available paid hosting.

## Interview and quote material

Interview sequence:

1. Which recurring repository-maintenance tasks consume time today, and how often?
2. Show a recent task, its accepted result, test command and review effort.
3. What scope may an agent execute, and which actions require maintainer approval?
4. Is the reviewed patch plus reproducible evidence valuable at the selected $500 for a 30-day pilot? Record objections without converting verbal interest into demand proof.
5. What setup, support, data handling and cancellation commitments are required?

Quote fields: organization/contact; repository and workflow; four delivery dates; acceptance command/maintainer; platform fee; finite compute allowance and rate basis; OpenRouter/BYOK responsibility; approved support hours; payment/merchant identity and tax treatment; no automatic renewal/top-up; cancellation/refund terms; export/retention/resource-disposition policy; start prerequisites and exact served release. Unresolved fields block issuing that quote.

Cancellation terms: the customer may end future work at any time; there is no automatic renewal. Refund undelivered weekly service portions pro rata ($125 per weekly delivery); disclose tax and any processor refund-fee treatment before payment. Customer-direct provider/cloud usage already incurred remains the customer's bill. Ending renewal does not authorize deletion of retained data. Use the existing cancellation/export/offboarding mechanisms and verify resource obligations to terminal disposition.

## Learning and stop conditions

Target three unrelated paying organizations as a recruitment experiment. Proposed observation window is 30 days after each organization begins; record exact dates. Before quoting, P-003 sets numeric margin, support, onboarding and repeat-use thresholds. P-011 records a dated continue/reprice/narrow/stop decision using real receipts, customer-approved comparable jobs, rework, repeat use, reliability and costs.

Stop recruiting/charging if the current security/readiness gate is unresolved, quote exposure cannot be bounded, payment/merchant prerequisites are unknown, or actual costs breach the agreed limits. Preparation and tests continue independently. No pilot evidence is currently asserted by this document.

## Decision and policy sources

First-pilot authority: papercusp-monetization-2026-09-04#D-016 and #D-017, delegated by Avi on 2026-10-13. Policy choices are settled; genuine customer consent/payment, measured economics, chosen-runtime security/model qualification and exact release proof are still execution requirements. Official provider sources read 2026-10-13: [https://openrouter.ai/terms](https://openrouter.ai/terms) (non-transferable credits and no API-access resale), [https://openrouter.ai/docs/guides/features/zdr](https://openrouter.ai/docs/guides/features/zdr) (request-level provider.zdr enforcement), and [https://openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models) (selected exact model ids and tool support).
