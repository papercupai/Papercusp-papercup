---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-b/final-label-inputs.json"
updated_at: 1792924406144
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "actual-docs-final-label-inputs",
  "captureBase": "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-b",
  "sourceSha256": "dbc175a1b776027308d48b2ee63cd450924a3872119e75709982375fcf42d05a",
  "attempts": [
    {
      "id": "docs-title-02",
      "rawCaptureSha256": "f5090d70d59aa725e8f2dea4d637b29758910909d1ef2e71a7313f5c7edb1b21",
      "inputContract": "docs-search-final-row-json-v1",
      "rawStdoutSha256": "33fb392c902b9e325c1330845b7c59bc328dbce901d401306dc6df1276d23717",
      "clientDeliveryWallMs": 1470.4981140093878,
      "degraded": false,
      "hits": [
        {
          "docId": "agent-insights/labelled-relevance-benchmarking",
          "rank": 1,
          "source": "docs:search",
          "docText": "{\"slug\":\"agent-insights/labelled-relevance-benchmarking\",\"url\":\"/internal/docs/agent-insights/labelled-relevance-benchmarking\",\"title\":\"Grading retrieval and final-context quality\",\"description\":\"Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.\",\"score\":78.66201575906581,\"excerpt\":\"The search-retrieval-quality standard covers actual search adapters and injection delivery. An all-source offline stage experiment is a separate population. Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scor…\",\"similarity\":0.783}",
          "score": 78.66201575906581
        },
        {
          "docId": "agent-insights/memory-recall-health-grading-runbook",
          "rank": 2,
          "source": "docs:search",
          "docText": "{\"slug\":\"agent-insights/memory-recall-health-grading-runbook\",\"url\":\"/internal/docs/agent-insights/memory-recall-health-grading-runbook\",\"title\":\"Grading memory-recall-health: effective contracts and actual delivery\",\"description\":\"Canonical memory system grading: effective calibration, client/port attempts, exact emitted context, budgets and session dedup.\",\"score\":26.76411128173079,\"excerpt\":\"…es delivered recall, admission, budgets and session dedup. Agent recall utilization is a separate behavior measure. Deterministic guards verify the measurement mechanisms; they do not replace a fresh population study. ## Observation contra…\",\"similarity\":0.69,\"anchor\":\"content-budgets-and-final-fidelity\"}",
          "score": 26.76411128173079
        }
      ],
      "response": {
        "query": "Grading retrieval and final-context quality",
        "tokenCount": 6,
        "hitCount": 1109,
        "hits": [
          {
            "slug": "agent-insights/labelled-relevance-benchmarking",
            "url": "/internal/docs/agent-insights/labelled-relevance-benchmarking",
            "title": "Grading retrieval and final-context quality",
            "description": "Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.",
            "score": 78.66201575906581,
            "excerpt": "The search-retrieval-quality standard covers actual search adapters and injection delivery. An all-source offline stage experiment is a separate population. Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scor…",
            "similarity": 0.783
          },
          {
            "slug": "agent-insights/memory-recall-health-grading-runbook",
            "url": "/internal/docs/agent-insights/memory-recall-health-grading-runbook",
            "title": "Grading memory-recall-health: effective contracts and actual delivery",
            "description": "Canonical memory system grading: effective calibration, client/port attempts, exact emitted context, budgets and session dedup.",
            "score": 26.76411128173079,
            "excerpt": "…es delivered recall, admission, budgets and session dedup. Agent recall utilization is a separate behavior measure. Deterministic guards verify the measurement mechanisms; they do not replace a fresh population study. ## Observation contra…",
            "similarity": 0.69,
            "anchor": "content-budgets-and-final-fidelity"
          }
        ],
        "surface": "engineering",
        "legs": {
          "lexical": {
            "status": "ran",
            "sourceCalls": [
              {
                "source": "papercusp-engineering",
                "ranker": "lexical",
                "status": "ran",
                "rows": 30,
                "durationMs": 442,
                "reason": null
              }
            ],
            "candidates": 30,
            "floored": 0,
            "stage2Added": 0,
            "callsRun": 1,
            "callsFailed": 0,
            "failures": [],
            "blocked": null
          },
          "semantic": {
            "status": "ran",
            "sourceCalls": [
              {
                "source": "papercusp-engineering",
                "ranker": "embeddings",
                "status": "ran",
                "rows": 6,
                "durationMs": 30,
                "reason": null
              }
            ],
            "candidates": 6,
            "floored": 0,
            "stage2Added": 0,
            "callsRun": 1,
            "callsFailed": 0,
            "failures": [],
            "blocked": null
          },
          "degraded": false,
          "warning": null
        },
        "applied": {
          "minScore": {
            "embeddings": 0.47
          },
          "recency": false,
          "policyRegistered": true
        },
        "embedCoverage": {
          "verdict": "degraded",
          "coverage": 0.882900245896192,
          "note": "'docs:search' embedding coverage is 88.3% (26,570/30,094 rows), below the 95.0% floor — semantic hits for this source are drawn from a PARTIAL index and a better match may simply not be embedded yet. Recent rows are 100.0% covered, so this is historical backlog rather than a live ingestion failure."
        }
      },
      "quality": "unknown",
      "retrievalCostUsd": null,
      "labels": []
    },
    {
      "id": "docs-identifier-02",
      "rawCaptureSha256": "cfcf249903b850f76703ae5f8ea5225ccdad483f67163525191f55f99296b873",
      "inputContract": "docs-search-final-row-json-v1",
      "rawStdoutSha256": "9e1ac0a788f29be7370e19b321fa37194425d1fb5f0b516f54290f17a048a061",
      "clientDeliveryWallMs": 2772.6668620016426,
      "degraded": false,
      "hits": [
        {
          "docId": "agent-insights/labelled-relevance-benchmarking",
          "rank": 1,
          "source": "docs:search",
          "docText": "{\"slug\":\"agent-insights/labelled-relevance-benchmarking\",\"url\":\"/internal/docs/agent-insights/labelled-relevance-benchmarking\",\"title\":\"Grading retrieval and final-context quality\",\"description\":\"Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.\",\"score\":1015.5128037299949,\"excerpt\":\"… Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scorecard seams; there is no parallel quality store. ## Freeze the study before executing Declare population, client/port/adapter, observation interval, eligi…\",\"similarity\":0.722,\"anchor\":\"maintained-benchmark-route\"}",
          "score": 1015.5128037299949
        },
        {
          "docId": "benchmarks/fairness-criteria",
          "rank": 2,
          "source": "docs:search",
          "docText": "{\"slug\":\"benchmarks/fairness-criteria\",\"url\":\"/internal/docs/benchmarks/fairness-criteria\",\"title\":\"Benchmark Fairness Criteria\",\"description\":\"The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.\",\"score\":3.568100013661976,\"excerpt\":\"…ubset\\\" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm). ### C2 — Identical model, verified from telemetry (not config) *…\",\"similarity\":0.627,\"anchor\":\"c1-identical-task-set-and-identical-scoring-denominator\"}",
          "score": 3.568100013661976
        }
      ],
      "response": {
        "query": "labelled-relevance-benchmarking",
        "tokenCount": 3,
        "hitCount": 35,
        "hits": [
          {
            "slug": "agent-insights/labelled-relevance-benchmarking",
            "url": "/internal/docs/agent-insights/labelled-relevance-benchmarking",
            "title": "Grading retrieval and final-context quality",
            "description": "Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.",
            "score": 1015.5128037299949,
            "excerpt": "… Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scorecard seams; there is no parallel quality store. ## Freeze the study before executing Declare population, client/port/adapter, observation interval, eligi…",
            "similarity": 0.722,
            "anchor": "maintained-benchmark-route"
          },
          {
            "slug": "benchmarks/fairness-criteria",
            "url": "/internal/docs/benchmarks/fairness-criteria",
            "title": "Benchmark Fairness Criteria",
            "description": "The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.",
            "score": 3.568100013661976,
            "excerpt": "…ubset\" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm). ### C2 — Identical model, verified from telemetry (not config) *…",
            "similarity": 0.627,
            "anchor": "c1-identical-task-set-and-identical-scoring-denominator"
          }
        ],
        "surface": "engineering",
        "legs": {
          "lexical": {
            "status": "ran",
            "sourceCalls": [
              {
                "source": "papercusp-engineering",
                "ranker": "lexical",
                "status": "ran",
                "rows": 30,
                "durationMs": 183,
                "reason": null
              }
            ],
            "candidates": 30,
            "floored": 0,
            "stage2Added": 0,
            "callsRun": 1,
            "callsFailed": 0,
            "failures": [],
            "blocked": null
          },
          "semantic": {
            "status": "ran",
            "sourceCalls": [
              {
                "source": "papercusp-engineering",
                "ranker": "embeddings",
                "status": "ran",
                "rows": 6,
                "durationMs": 73,
                "reason": null
              }
            ],
            "candidates": 6,
            "floored": 0,
            "stage2Added": 0,
            "callsRun": 1,
            "callsFailed": 0,
            "failures": [],
            "blocked": null
          },
          "degraded": false,
          "warning": null
        },
        "applied": {
          "minScore": {
            "embeddings": 0.47
          },
          "recency": false,
          "policyRegistered": true
        },
        "embedCoverage": {
          "verdict": "degraded",
          "coverage": 0.882900245896192,
          "note": "'docs:search' embedding coverage is 88.3% (26,570/30,094 rows), below the 95.0% floor — semantic hits for this source are drawn from a PARTIAL index and a better match may simply not be embedded yet. Recent rows are 100.0% covered, so this is historical backlog rather than a live ingestion failure."
        }
      },
      "quality": "unknown",
      "retrievalCostUsd": null,
      "labels": []
    }
  ],
  "baselineAccepted": false,
  "planAcceptance": false,
  "shipment": "unverified",
  "note": "Discovery only. Exact request build/corpus/model closure, qualified judge pilot, labels, retrieval meters and adequate populations remain unknown."
}

