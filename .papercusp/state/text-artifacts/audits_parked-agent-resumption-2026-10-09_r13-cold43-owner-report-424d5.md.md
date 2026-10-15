---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold43-owner-report-424d5.md"
updated_at: 1791953957222
_body: "content"
---

The historical dependency source is now pinned to immutable build `cf57965610`, blob `5bec54fb42a5`, with complete source excerpts saved and read back exactly.

That writer deletes and repoints dependency edges. It returns `dependency-mutation-committed` telemetry to its caller; the inspected boundary does not itself append that telemetry to a durable event history. Whether callers retained dated mutation records remains unverified. Today’s empty edge query therefore cannot establish dependency absence at the original cutoff.

This build was measured in early October 9 invocations. It does not establish the loaded runtime throughout the October 10 review-to-cutoff interval. The candidate remains under review, and whole-cohort eligibility and recovery outcomes remain unaccepted.

Evidence: `audits/parked-agent-resumption-2026-10-09/r13-cold43-immutable-dependency-mutation-custody-424d5.json` (12,060 characters; complete exact readback). Next: follow the immutable callers and any dated mutation records, then continue the remaining cutoff witnesses. The three unavailable routine-output reads remain recorded in the prior archive.

