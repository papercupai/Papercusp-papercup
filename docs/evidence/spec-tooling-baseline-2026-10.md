# Spec tooling baseline — 2026-10

Measured at **2026-10-14T23:03:26.887Z** for `papercusp-workspace/papercusp`, before any lighter-track or clarify implementation in this plan. Work item: WI-6554700010012591; plan: spec-driven-tooling-integration-2026-10-05#P-002.

This is a descriptive baseline, not evidence that a lighter obligation track is safe. D-004 remains in force: every plan uses the full obligations.

## Population and definitions

The population is the 20 most recently shipped, currently shipped, non-rubric plans in this harness, ordered by their latest recorded `status_changed → shipped` event. Scheduled plan instances remain in the population; the two bug-triage instances have no recorded class or attributed agent calls. Missing acceptance timing is **unknown**, not zero.

The existing `readPlanEfficiency` implementation was invoked for each plan (the same reader used by `plans:get { efficiency:true }`). Its MCP counts are floors: native client tools and calls without a work-item goal stamp are absent. Calls and holder wall-clock are the reader's current lifetime snapshot, not acceptance-only effort. `calls.activeHours` counts distinct hours with calls; it is not elapsed work time. Holder active/idle/away time can overlap other plans and is not time spent exclusively on this plan.

Additional ledger reads supply:

- **Acceptance hours:** elapsed hours from the earliest attributed agent MCP call categorized `acceptance-ceremony` by `categorizePlanToolCall` to the recorded shipment. Calls after shipment are excluded. This span includes waiting and concurrent implementation; it does not isolate acceptance processing cost.
- **Bindings created / retracted:** `spec_evidence_bindings.created_at <= shipped_at`, with retractions counted only when `retracted_at <= shipped_at`. The ratio is binding churn, not a defect rate. Later bindings and retractions are excluded.
- **BAR amendments:** subject-plan Decisions carrying the canonical `Amendment-Id:` marker, whose authored `decision_date` is no later than the shipment's UTC date. The writer appends these to the subject plan, not the rubric. Date precision is one day; same-day ordering is unavailable. Short-lived `rubric_amend_receipts` are deliberately not used.
- **Consults / expired:** consults created no later than shipment and linked by `origin_task_ref` to the plan slug or a persisted plan work-item. Counts show their **state at measurement**, not reconstructed state at shipment. Consults without those links are unmeasured.
- **Class:** current acceptance rubric `template_data.classRef` for `subjectPlan`; absent metadata remains `unrecorded`. It is not inferred from the title or workload.

## Per-plan baseline

`F` = plan-class-feature-ship; `B` = plan-class-bugfix; `U` = unrecorded. `—` is unknown. Calls and failed calls use the existing efficiency reader, including its retention and attribution limits.

| Plan | Class | Acceptance h | Bindings created | Retracted | BAR amendments | Consults | Expired now | MCP calls | Failed calls |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| test-rubric-unification-2026-10-12 | F | 19.37 | 113 | 58 | 6 | 7 | 3 | 1937 | 83 |
| derived-status-not-hand-written-2026-10-12 | F | 23.22 | 323 | 233 | 1 | 5 | 1 | 3124 | 113 |
| cupboard-distributable-integrations-2026-10-10 | F | 60.09 | 270 | 149 | 0 | 7 | 1 | 9172 | 340 |
| cloud-workspaces-focus-lifecycle-followup-2026-08-28 | B | 3.92 | 72 | 24 | 0 | 4 | 2 | 681 | 73 |
| woe-progress-table-2026-10-08 | F | 96.05 | 76 | 61 | 3 | 1 | 0 | 5537 | 201 |
| plan-verification-friction-reduction-2026-10-11 | F | 26.42 | 199 | 144 | 4 | 0 | 0 | 3607 | 88 |
| bug-triage@run-505967151401806126 | U | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| bug-triage@run-494413284177559313 | U | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| scope-unique-identifiers-2026-07-26 | B | 13.52 | 125 | 74 | 6 | 1 | 1 | 1394 | 38 |
| verification-system-improvements-2026-10-10 | F | 15.54 | 410 | 263 | 9 | 1 | 0 | 12343 | 506 |
| proof-freshness-pinned-candidate-2026-10-06 | B | 111.71 | 129 | 88 | 2 | 1 | 1 | 1258 | 86 |
| git-sync-turn-scoped-commit-hold-2026-10-11 | F | — | 56 | 1 | 3 | 1 | 1 | 0 | 0 |
| customer-terminal-freeze-safeguards-2026-10-10 | F | 10.50 | 139 | 16 | 1 | 1 | 0 | 1295 | 27 |
| psu-native-launch-and-codex-stream-recovery-2026-10-07 | B | 7.45 | 76 | 31 | 1 | 0 | 0 | 46 | 0 |
| bulk-plan-cleanup-risk-autonomy-2026-10-07 | F | 6.90 | 54 | 23 | 1 | 0 | 0 | 715 | 14 |
| context-injection-rubric-improvements-and-grading-2026-10-09 | F | 9.43 | 34 | 10 | 3 | 2 | 1 | 2500 | 790 |
| dao-launch-workspace-2026-10-08 | F | 14.27 | 111 | 55 | 1 | 0 | 0 | 463 | 13 |
| session-recovery-followups-2026-10-07 | B | 19.86 | 74 | 44 | 2 | 7 | 0 | 817 | 6 |
| finish-b11f76ed-session-residue-2026-10-07 | B | 7.04 | 96 | 20 | 1 | 2 | 1 | 1228 | 17 |
| work-on-everything-stewardship-remediation-2026-08-30 | F | 173.07 | 1781 | 1593 | 3 | 8 | 4 | 11743 | 120 |

## Class summary

Medians use only known acceptance spans. Totals sum the per-plan rows; expired consults use the measurement-time state definition above.

| Current class | Plans | Known spans | Median acceptance h | Bindings created | Retracted | BAR amendments | Consults | Expired now |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| plan-class-feature-ship | 12 | 11 | 19.37 | 3566 | 2606 | 35 | 33 | 11 |
| plan-class-bugfix | 6 | 6 | 10.49 | 572 | 281 | 12 | 15 | 5 |
| unrecorded | 2 | 0 | — | 0 | 0 | 0 | 0 | 0 |

The spans and binding churn vary substantially inside each class. This sample does not provide a controlled comparison of obligation tracks. No lighter track is enabled or recommended by this measurement.

## Reproduction and evidence

The population query is:

```sql
WITH ships AS (
  SELECT body->>'plan_slug' AS slug, max(ts) AS shipped_at
  FROM harness_shared.coord_event_log
  WHERE workspace_id = 'papercusp-workspace' AND surface = 'plan-events'
    AND body->>'event' = 'status_changed' AND body->>'after' = 'shipped'
  GROUP BY 1
)
SELECT p.plan_slug, p.harness_slug, s.shipped_at
FROM ships s JOIN harness_shared.harness_plans p
  ON p.workspace_id = 'papercusp-workspace' AND p.plan_slug = s.slug
WHERE p.status = 'shipped' AND p.template IS DISTINCT FROM 'rubric'
  AND p.harness_slug = 'papercusp'
ORDER BY s.shipped_at DESC, p.plan_slug
LIMIT 20;
```

For each returned row call `plans:get { slug, harness:'papercusp', efficiency:true }` (or its canonical `readPlanEfficiency` implementation) and join the ledger columns using the definitions above. Repeat measurements must record a new timestamp and edition; a new last-20 population is not a matched-cohort before/after comparison. For a future comparison retain these exact plan identities and the writer versions.

Writers/readers inspected: `packages/operator-core/lib/plan-efficiency.ts`, `agent-tools/plans/set-plan-status.ts`, `agent-tools/coordination/plan-events.ts`, `agent-tools/plans/spec-evidence-store.ts`, `rubrics.ts` (canonical amendment Decision), `agent-tools/rubrics/amend-receipts.ts` (one-hour receipt retention), and migration 834's consult lifecycle. Full current efficiency responses and exact extraction results are retained locally at `/tmp/spec-tooling-baseline.json`; extraction log `/tmp/spec-tooling-baseline.log`. The table above is the durable evidence and does not depend on those temporary files surviving.

Verification: population contains 20 distinct plan slugs; the canonical efficiency reader succeeded for each; class counts partition those 20; retracted counts do not exceed created counts. This is a read-only baseline with no product-code change and no new test to run. Missing timing, class metadata, and unlinked/native tool activity remain explicit limits.

