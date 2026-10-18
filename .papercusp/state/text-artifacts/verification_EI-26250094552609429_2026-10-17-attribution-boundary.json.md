---
rel_path: "verification/EI-26250094552609429/2026-10-17-attribution-boundary.json"
updated_at: 1792266438949
_body: "content"
---

{
  "workItem": "EI-26250094552609429",
  "capturedAt": "2026-10-17T19:47:18.920Z",
  "scope": "papercusp-workspace/papercusp/blender-self-learning-2026-07-12",
  "partSql": "SELECT part_key,kind,ordinal,fed_ts::text,author,tombstone,origin,part_fed_key,created_at::text,updated_at::text,fed_hlc,left(body,240) AS body_excerpt FROM harness_shared.harness_plan_parts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND plan_slug='blender-self-learning-2026-07-12' ORDER BY ordinal,part_key",
  "partPopulation": {
    "rows": 30,
    "truncated": false,
    "selected": [
      {
        "part_key": "frontmatter",
        "kind": "frontmatter",
        "ordinal": 0,
        "fed_ts": "1785104810372",
        "author": "9e8b369b6a40eff82f88132c1ba58532d7222b61a1cf45993acfe01e35da74c3",
        "tombstone": false,
        "origin": "remote",
        "part_fed_key": "blender-self-learning-2026-07-12/frontmatter",
        "created_at": "1783836894994",
        "updated_at": "1783836894994",
        "fed_hlc": null,
        "body_excerpt": "---\ntitle: Blender self-learning program: volume-triggered, delta-curated, rubric-seeded ideation over the full signal surface (owner-approved design discussion 2026-07-11/12)\nslug: blender-self-learning-2026-07-12\nstatus: draft\ncreated: 20"
      },
      {
        "part_key": "section:now",
        "kind": "section",
        "ordinal": 2,
        "fed_ts": "1785104810447",
        "author": "9e8b369b6a40eff82f88132c1ba58532d7222b61a1cf45993acfe01e35da74c3",
        "tombstone": false,
        "origin": "remote",
        "part_fed_key": "blender-self-learning-2026-07-12/section:now",
        "created_at": "1783836894994",
        "updated_at": "1783836894994",
        "fed_hlc": null,
        "body_excerpt": "## Now\n\n**State:** Draft. Plan body to be filled in.\n\n**Next:** human reviews scope and lists Phase 1 items.\n"
      },
      {
        "part_key": "item:P-001",
        "kind": "item",
        "ordinal": 6,
        "fed_ts": "1784000758591",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/item:P-001",
        "created_at": "1783836895044",
        "updated_at": "1783836895044",
        "fed_hlc": null,
        "body_excerpt": "- **P-001** `done` Signal accumulator + watermark: PG table (migration via next-migration.mjs allocator) tracking per-lane new-signal counts/high-water since last SUCCESSFUL cycle (scorecards w/ rating CHANGES, observations, captures, rever"
      },
      {
        "part_key": "section:decisions",
        "kind": "section",
        "ordinal": 7,
        "fed_ts": "1785122476394",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/section:decisions",
        "created_at": "1783836894994",
        "updated_at": "1783836894994",
        "fed_hlc": null,
        "body_excerpt": "## Decisions\n\n(Use plans:add-decision to append. Each decision is a third-level\nheading with a date line and a body paragraph.)\n"
      },
      {
        "part_key": "item:P-002",
        "kind": "item",
        "ordinal": 8,
        "fed_ts": "1785122476394",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/item:P-002",
        "created_at": "1783836895075",
        "updated_at": "1783836895075",
        "fed_hlc": null,
        "body_excerpt": "- **P-002** `done` Volume-based cycle firing: cadence gate consumes the accumulator — weighted new-signal score ≥ threshold fires; score 0 NEVER fires (stale-corpus cycles eliminated); keep friction fast-path (watchdog storms), ideas-draine"
      },
      {
        "part_key": "item:P-003",
        "kind": "item",
        "ordinal": 9,
        "fed_ts": "1785122476394",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/item:P-003",
        "created_at": "1783836895117",
        "updated_at": "1783836895117",
        "fed_hlc": null,
        "body_excerpt": "- **P-003** `done` Persisted digest snapshot + DELTA-FIRST rendering: build digest once at fire time, persist snapshot row, render prompt leading with \"NEW since your last cycle\" (per-lane deltas from the watermark) before standing top patt"
      },
      {
        "part_key": "item:P-004",
        "kind": "item",
        "ordinal": 11,
        "fed_ts": "1785122476394",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/item:P-004",
        "created_at": "1783836895171",
        "updated_at": "1783836895171",
        "fed_hlc": null,
        "body_excerpt": "- **P-004** `done` Deterministic rubric seeding: each cycle, code (not LLM) selects worst-N rubric criterion patterns (severity×recency) and issues one TARGETED ideation call per pattern, returned idea REQUIRED to ground on that rubric: ref"
      },
      {
        "part_key": "decision:D-001",
        "kind": "decision",
        "ordinal": 25,
        "fed_ts": "1783995101758",
        "author": "local",
        "tombstone": false,
        "origin": "local",
        "part_fed_key": "blender-self-learning-2026-07-12/decision:D-001",
        "created_at": "1783836895649",
        "updated_at": "1783836895649",
        "fed_hlc": null,
        "body_excerpt": "### D-001 — Protect the 22:02 d3fec8e0 checkpoint from replace-storm livelock\nDate: 2026-07-14\nThe `candidate_stale` signal is not sufficient to replace a young, actively testing checkpoint on a continuously changing staging tree. Four agen"
      }
    ]
  },
  "outboxSql": "SELECT table_name,min(to_timestamp(ts/1000.0))::text AS earliest_captured,max(to_timestamp(ts/1000.0))::text AS latest_captured,count(*)::int AS retained_rows FROM harness_shared.substrate_outbox WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND table_name IN ('harness_plan_parts','harness_plans') GROUP BY table_name ORDER BY table_name",
  "outbox": {
    "rows": [
      {
        "table_name": "harness_plan_parts",
        "earliest_captured": "2026-10-16 15:34:08.014+00",
        "latest_captured": "2026-10-17 19:46:58.673+00",
        "retained_rows": 1301
      },
      {
        "table_name": "harness_plans",
        "earliest_captured": "2026-10-16 15:34:07.015+00",
        "latest_captured": "2026-10-17 19:46:52.593+00",
        "retained_rows": 329
      }
    ],
    "truncated": false
  },
  "revisionDiff": {
    "diff": "Index: blender-self-learning-2026-07-12.md\n===================================================================\n--- blender-self-learning-2026-07-12.md\trevision #97\n+++ blender-self-learning-2026-07-12.md\trevision #98\n@@ -2,18 +2,18 @@\n title: Blender self-learning program: volume-triggered, delta-curated, rubric-seeded ideation over the full signal surface (owner-approved design discussion 2026-07-11/12)\n slug: blender-self-learning-2026-07-12\n status: draft\n created: 2026-07-12\n-updated: 2026-07-17\n+updated: 2026-07-12\n ---\n \n # Blender self-learning program: volume-triggered, delta-curated, rubric-seeded ideation over the full signal surface (owner-approved design discussion 2026-07-11/12)\n \n ## Now\n \n-**State:** PUBLIC RELEASE GO (re-verified 2026-07-14 ~17:00 EDT, su-f8714, owner-directed ASAP). blender-release-readiness scorecard EI-12107 rates ALL SIX criteria PASS (missingKeys:[], complete): cycle-error-rate, multi-lens-routing, grading-loop-closure, e2e-drill, ledger-reconciliation, instrument-integrity. The live regression (EI-11416, scout admission/generation phase accounting + cycle-error window) is REPAIRED: fix 704b3f0a deployed to release HEAD a0480c87, bg-host restarted 14:08:24Z running it, scout instrument tests 77/77 green, post-watermark 7 clean organic cycles with 0 errors / 0 legacy '180000ms transport-death' shapes, and 2 fresh deployed-generation drills clean (blender-live-drill-mrkyy43p + mrl6g0ld). Regression plan blender-live-regression-repair-2026-07-13 shipped; WI-4644/4645/4646 complete. Residual (transparent, non-blocking): the timeout fix hasn't been exercised under a live 429/capacity storm post-restart (pool healthy) — failure-condition confidence rests on capacity-errors 12/12 unit tests + the instrument-integrity red-path demo; organic soak continues accumulating clean cycles as ongoing confirmation.\n+**State:** Draft. Plan body to be filled in.\n \n-**Next:** Released. Monitor normal production scorecards for regression; P-011 (backlog signal lanes) stays post-release expansion.\n+**Next:** human reviews scope and lists Phase 1 items.\n \n ## Background\n \n (Why this plan exists; what problem it addresses.)\n@@ -26,8 +26,13 @@\n \n ## Phase 1 — Deterministic signal substrate\n \n - **P-001** `done` Signal accumulator + watermark: PG table (migration via next-migration.mjs allocator) tracking per-lane new-signal counts/high-water since last SUCCESSFUL cycle (scorecards w/ rating CHANGES, observations, captures, reverts, deferrals, completions); updated by a zero-token deterministic sweep on the existing 30s routinesTick (watchdog pattern) importance: high (← WI-4317 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4317 released) (← WI-4317 released) (← WI-4317 open) (← WI-4317 released) (← WI-4317 released) (← WI-4317 completed resolved)\n+## Decisions\n+\n+(Use plans:add-decision to append. Each decision is a third-level\n+heading with a date line and a body paragraph.)\n+\n - **P-002** `done` Volume-based cycle firing: cadence gate consumes the accumulator — weighted new-signal score ≥ threshold fires; score 0 NEVER fires (stale-corpus cycles eliminated); keep friction fast-path (watchdog storms), ideas-drained trigger, min-floor ~10-15min burst coalescing; raise/drop the 3600s max-age heartbeat; budget cap unchanged; ship flag-ON with a kill-switch flag (reversible cutover) importance: high (← WI-4318 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4318 released) (← WI-4318 released) (← WI-4318 open) (← WI-4318 released) (← WI-4318 released) (← WI-4318 completed resolved)\n - **P-003** `done` Persisted digest snapshot + DELTA-FIRST rendering: build digest once at fire time, persist snapshot row, render prompt leading with \"NEW since your last cycle\" (per-lane deltas from the watermark) before standing top patterns — kills the stale-repetition → dedup-decline churn importance: high (← WI-4319 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4319 released) (← WI-4319 released) (← WI-4319 open) (← WI-4319 released) (← WI-4319 released) (← WI-4319 completed resolved) (← WI-4319 open) (← WI-4319 released) (← WI-4319 resolved) (← WI-4319 completed resolved) (← WI-4319 completed resolved)\n \n \n@@ -64,13 +69,8 @@\n \n \n \n \n-## Decisions\n-\n-(Use plans:add-decision to append. Each decision is a third-level\n-heading with a date line and a body paragraph.)\n-\n ### D-001 — Protect the 22:02 d3fec8e0 checkpoint from replace-storm livelock\n Date: 2026-07-14\n The `candidate_stale` signal is not sufficient to replace a young, actively testing checkpoint on a continuously changing staging tree. Four agents successively killed predecessor runs before any could verdict. The 22:02 d3fec8e0 checkpoint is the protected verdict run: no `replaceStale` or force while it is active, even if staging advances or the tool later reports an older candidate. Consumers join `checkpoint:await`; act only on its authoritative green/red outcome. Canonical defect: EI-11667.\n Related: P-015\n",
    "slug": "blender-self-learning-2026-07-12",
    "seq": 98,
    "priorSeq": 97
  },
  "sourceRefs": [
    "libs/papercusp/libs/db/sql/271-harness-plan-parts-capture.sql",
    "packages/operator-core/lib/plan-parts/store.ts",
    "packages/operator-core/lib/plan-parts/reconcile.ts",
    "packages/operator-core/lib/sync/hyperbee/projections/harness-plan-parts.ts",
    "packages/operator-core/lib/substrate-outbox-backstop-gc.ts",
    "packages/operator-core/lib/sync/hyperbee/outbox-drain.ts",
    "packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts"
  ],
  "priorFixRefs": [
    "WI-10004610",
    "WI-10006276",
    "WI-10006279",
    "WI-10006275"
  ],
  "observations": [
    "Current selected parts mix remote starter/frontmatter with later local recaptures and older D001.",
    "Revision98 is a system backfill of previously unmatched content; not attribution of original writer.",
    "Current source recomposition maintains derived indexes/revision atomically and boot reconcile preserves content-time/origin guards.",
    "Outbox is a retained delivery queue; its current plan-family entries begin October16, so zero July exact-key rows do not show missed capture."
  ],
  "limits": [
    "Original corrupting event not identified.",
    "Current store LWW rows preserve latest metadata only.",
    "Prior fixes prove their own defects, not identity of this archived-plan event.",
    "No source, plan-content, index, lifecycle, release or gate mutation performed."
  ]
}
