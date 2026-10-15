---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold31-owner-report-424d5.md"
updated_at: 1791906700542
_body: "content"
---

The original 137-request cohort now has 113 complete receipts: 111 queued, one flush refusal, and one no-host refusal. This continuation recovered 19 additional receipts and preserved every previously accepted record exactly. Twenty-four requests remain unresolved. Receipt custody does not establish continuity, eligibility, delivery, or recovery.

All 36 frozen immutable transcript objects were acquired without repeating a completed acquisition. They cover 35 native sessions: 34 objects meet the full indexed-byte, exact identity and JSON checks; two snapshot versions are shorter than their indexed versions and remain excluded from parser input. The unchanged Cold26 instrument accepted 17 receipts from the initial full sources and two from three subsequently finalized copies. All 19 new accepted pairs passed native call-ID and yielded-chain checks; no pair was reused.

Three initial reads hit the acquisition wrapper’s 18-second deadline during Kopia’s cache initialization. Kopia continued and finished the pending copies after its sudo wrapper was terminated. The retained logs, final stable byte counts, full parse and identity checks established those copies without new reads. Original timeout records remain immutable. The acquisition lifecycle defect is filed and assigned as EI-25879329310017617; source finalization guards now require writer completion and final byte verification.

The source texts, assessments and combined cohort were saved canonically. Full exact readback verified 41 artifacts containing 149,816,346 characters. Unresolved envelope variants are recorded for review while the frozen parser remains unchanged. Whole-116 continuity and eligibility remain unfrozen, and outcomes remain unjoined. R5, orphan-lock root cause, R12 refresh, malformed native input, source-loss remediation, the final runtime anchor, and the actual 24-hour R14 census remain open. No product tests, terminal relaunches, restores, execution-route changes or live release-gate operations were performed.
