---
rel_path: "verification/WI-10005801/2026-10-17-outcome-ledger-appendix-fire11.json"
updated_at: 1792265908838
_body: "content"
---

{
  "kind": "read-only-outcome-ledger-snapshot",
  "workItem": "WI-10005801",
  "capturedAt": "2026-10-17T19:38:28.762Z",
  "scope": "workspace papercusp-workspace; captures grouped by harness; no serving-runtime or current feature-activation attestation",
  "sourceRefs": [
    "packages/operator-core/lib/deferral-interest/outcomes.ts",
    "packages/operator-core/lib/deferral-interest/model.ts",
    "packages/operator-core/lib/deferral-interest/store.ts",
    "packages/operator-core/lib/neologism/scan.ts",
    "packages/operator-core/lib/neologism/miner-core.ts",
    "packages/operator-core/lib/graduation/evidence.ts",
    "packages/operator-core/lib/graduation/scan.ts",
    "packages/operator-core/lib/fleet-ekg/drift.ts",
    "packages/operator-core/lib/fleet-ekg/scan.ts",
    "packages/operator-core/lib/replay/regret/mine.ts",
    "packages/operator-core/lib/replay/regret/store.ts",
    "packages/operator-core/lib/replay/regret/replay-adapter.ts",
    "packages/operator-core/lib/ablation/store.ts",
    "packages/operator-core/lib/ablation/scoring.ts",
    "packages/operator-core/lib/change-ledger/change-ledger.ts"
  ],
  "records": {
    "deferral": {
      "sql": "SELECT id::text,trained_at::text,sample_items,sample_weeks,model->>'weak' AS weak,model->>'globalRatePerWeek' AS rate,created_by FROM harness_shared.deferral_pricing_model WHERE workspace_id='papercusp-workspace' ORDER BY trained_at DESC,id DESC LIMIT 1",
      "rows": [
        {
          "id": "81",
          "trained_at": "2026-10-17 07:36:16.547+00",
          "sample_items": 97,
          "sample_weeks": "5.83",
          "weak": "true",
          "rate": "40.821",
          "created_by": "system:deferral-interest-refit"
        }
      ],
      "rowCount": 1,
      "truncated": false
    },
    "deferralPartition": {
      "sql": "SELECT model->>'weak' AS weak,count(*)::int AS rows FROM harness_shared.deferral_pricing_model WHERE workspace_id='papercusp-workspace' GROUP BY 1 ORDER BY 1",
      "rows": [
        {
          "weak": "false",
          "rows": 4
        },
        {
          "weak": "true",
          "rows": 77
        }
      ],
      "rowCount": 2,
      "truncated": false
    },
    "ekg": {
      "sql": "SELECT severity,attributed,count(*)::int AS rows,max(window_end)::text AS latest_window FROM harness_shared.fleet_ekg_shifts WHERE workspace_id='papercusp-workspace' GROUP BY 1,2 ORDER BY 1,2",
      "rows": [
        {
          "severity": "moderate",
          "attributed": false,
          "rows": 117,
          "latest_window": "2026-09-29 07:23:32.16+00"
        },
        {
          "severity": "moderate",
          "attributed": true,
          "rows": 910,
          "latest_window": "2026-10-17 16:52:15.451+00"
        }
      ],
      "rowCount": 2,
      "truncated": false
    },
    "regret": {
      "sql": "SELECT replay_status,report_improvement_id IS NOT NULL AS filed,replay_scores IS NOT NULL AS scored,CASE WHEN jsonb_typeof(replay_scores)='array' THEN jsonb_array_length(replay_scores) ELSE NULL END AS score_count,count(*)::int AS rows FROM harness_shared.regret_findings WHERE workspace_id='papercusp-workspace' GROUP BY 1,2,3,4 ORDER BY 1,2,3,4",
      "rows": [
        {
          "replay_status": "replayed",
          "filed": false,
          "scored": true,
          "score_count": 0,
          "rows": 42
        },
        {
          "replay_status": "replayed",
          "filed": false,
          "scored": true,
          "score_count": 1,
          "rows": 42
        },
        {
          "replay_status": "replayed",
          "filed": false,
          "scored": true,
          "score_count": 2,
          "rows": 1
        },
        {
          "replay_status": "skipped",
          "filed": false,
          "scored": false,
          "score_count": null,
          "rows": 34
        }
      ],
      "rowCount": 4,
      "truncated": false
    },
    "ablation": {
      "sql": "SELECT origin,verdict,capped,count(*)::int AS rows,max(finished_at)::text AS latest FROM harness_shared.prompt_ablation_runs WHERE workspace_id='papercusp-workspace' GROUP BY 1,2,3 ORDER BY 1,2,3",
      "rows": [
        {
          "origin": "shadow",
          "verdict": "inconclusive",
          "capped": false,
          "rows": 20,
          "latest": "2026-08-03 08:41:09.020117+00"
        },
        {
          "origin": "shadow",
          "verdict": "load-bearing",
          "capped": false,
          "rows": 1,
          "latest": "2026-07-13 10:57:25.468717+00"
        },
        {
          "origin": "shadow",
          "verdict": "no-delta",
          "capped": false,
          "rows": 5,
          "latest": "2026-09-29 08:55:27.851403+00"
        }
      ],
      "rowCount": 3,
      "truncated": false
    },
    "historicalAblation": {
      "sql": "SELECT id::text,finished_at::text,playbook_path,playbook_hash,rule_key,rule_hash,origin,scenario_count,baseline_pass_rate,ablated_pass_rate,pass_rate_delta,verdict,capped,cost_usd,pot_slug FROM harness_shared.prompt_ablation_runs WHERE workspace_id='papercusp-workspace' AND verdict='load-bearing' ORDER BY finished_at DESC",
      "rows": [
        {
          "id": "8452d571-e1b5-4e0b-bff2-7fe9de8d436d",
          "finished_at": "2026-07-13 10:57:25.468717+00",
          "playbook_path": "apps/operator/prompts/papercusp-su-engineer.tools.md",
          "playbook_hash": "1250357d1f2a181a",
          "rule_key": "orientation-what-papercusp-is/workitems",
          "rule_hash": "3dab27f6a72d",
          "origin": "shadow",
          "scenario_count": 30,
          "baseline_pass_rate": 0.5,
          "ablated_pass_rate": 0.3333333333333333,
          "pass_rate_delta": -0.16666666666666669,
          "verdict": "load-bearing",
          "capped": false,
          "cost_usd": 1.7345726000000001,
          "pot_slug": "papercusp"
        }
      ],
      "rowCount": 1,
      "truncated": false
    },
    "changes": {
      "sql": "SELECT source,mutation_class,count(*)::int AS rows,max(recorded_at)::text AS latest FROM harness_shared.behavior_change_ledger WHERE workspace_id='papercusp-workspace' GROUP BY 1,2 ORDER BY 1,2",
      "rows": [
        {
          "source": "gym:accept",
          "mutation_class": "gym",
          "rows": 8,
          "latest": "2026-08-22 15:24:42.990621+00"
        },
        {
          "source": "repo-scan",
          "mutation_class": "repo-prompt",
          "rows": 841,
          "latest": "2026-10-17 16:20:05+00"
        }
      ],
      "rowCount": 2,
      "truncated": false
    },
    "captures": {
      "sql": "SELECT CASE WHEN payload->>'watchdogKey' LIKE 'neologism:%' THEN 'neologism' ELSE 'graduation' END AS producer,harness_slug,coalesce(lane,'improvement') AS lane,payload->'_ei'->>'signal_origin' AS signal_origin,status,payload->'ideaLifecycle'->>'state' AS idea_lifecycle,count(*)::int AS rows FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND item_kind IN ('bug','change') AND coalesce(lane,'improvement') <> 'observation' AND (payload->>'watchdogKey' LIKE 'neologism:%' OR payload->>'watchdogKey' LIKE 'graduation:%') GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6",
      "rows": [
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "closed",
          "idea_lifecycle": "triaged",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "done",
          "idea_lifecycle": "triaged",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "dropped",
          "idea_lifecycle": "triaged",
          "rows": 2
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "open",
          "idea_lifecycle": "open",
          "rows": 16
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "open",
          "idea_lifecycle": "triaged",
          "rows": 3
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": "organic",
          "status": "todo",
          "idea_lifecycle": "open",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "closed",
          "idea_lifecycle": "open",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "closed",
          "idea_lifecycle": "triaged",
          "rows": 2
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "dropped",
          "idea_lifecycle": "open",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "open",
          "idea_lifecycle": "open",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "resolved",
          "idea_lifecycle": "open",
          "rows": 1
        },
        {
          "producer": "neologism",
          "harness_slug": "papercusp",
          "lane": "improvement",
          "signal_origin": null,
          "status": "resolved",
          "idea_lifecycle": "triaged",
          "rows": 2
        }
      ],
      "rowCount": 12,
      "truncated": false
    },
    "graduation": {
      "sql": "SELECT count(*)::int AS graduation_prefix_rows FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND item_kind IN ('bug','change') AND coalesce(lane,'improvement') <> 'observation' AND payload->>'watchdogKey' LIKE 'graduation:%'",
      "rows": [
        {
          "graduation_prefix_rows": 0
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "positiveControl": {
        "rows": [
          {
            "feature_id": "EI-1704"
          }
        ],
        "rowCount": 1,
        "truncated": false,
        "fields": [
          "feature_id"
        ],
        "status": "passed"
      }
    }
  },
  "limits": [
    "Counts describe persisted producer stages, not causal value.",
    "EKG attributed means at least one ledger candidate in the lookback.",
    "Regret replayed may contain an empty score array.",
    "Shadow ablation measures historical rule/scenario hashes, not current shipment.",
    "Neologism/graduation work-item status does not certify implementation or benefit.",
    "Transfer evidence is on prior checkpoint9f111a85dab1; this edition does not rerun transfer.",
    "No paid run, subject source/control/lifecycle write, rubric grade, or acceptance mutation."
  ]
}
