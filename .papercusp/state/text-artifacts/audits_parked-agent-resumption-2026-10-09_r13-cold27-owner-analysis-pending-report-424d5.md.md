---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold27-owner-analysis-pending-report-424d5.md"
updated_at: 1791899610857
_body: "content"
---

R13 source recovery remains incomplete. The original 137-request cohort still has 92 complete receipts: 90 queued, one flush refusal, and one no-host refusal. All 92 prior records are preserved exactly; 45 requests remain unresolved. Queued receipts establish receipt custody only.

For those 45 requests, I checked 56 indexed native sessions. Their recorded files and matching files in the recorded homes’ sessions/archived_sessions trees are missing, and the exact session keys have no canonical default-corpus archive manifests or files. A recent native-file positive control passed. This finding is limited to those locations; it does not establish global source absence. A remaining backup-custody search has not been completed.

The unchanged Cold26 parser plus lineage-candidate augmentation passed 12 positive and negative controls. Four bounded batches cover all 45 requests, with 65 native assessment executions, no native parser failures or timeouts, and no new complete receipts. All batch contents passed exact full SHA256 readback. Batch 3 was saved despite its wrapper reporting a timeout; I reconciled the persisted result and did not rerun it. The conflicting terminal verdict is captured as EI-25872050036961683; its claim was refused by admission-pending, so it is not represented as owned or fixed.

The combined assessment is `papercusp/audits/parked-agent-resumption-2026-10-09/r13-cold27-original137-custody-assessment-424d5.json`, 635,693 characters, SHA256 `b0c218f70d54bde66da822d0a14fec696115357e346400294b585239d7935c51`, with exact full readback verified. The companion acquisition procedure preserves the programs and evidence references. The 31,892-character orphan-lock checkpoint was archived with exact readback before condensation.

Whole-116 continuity and eligibility remain unaccepted; outcomes joined = 0. R5, the orphan-lock root cause, R12, malformed-native/source-loss attribution, the final-fix runtime anchor, and the actual ≥24-hour R14 census remain open. The approved SELF/AUTO/P-013 route continues. No product source edits, product-test reruns, terminal-item redo, or live-gate operations were performed.
