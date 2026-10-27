---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/docs-judge-qualification-20261025-a/policy.json"
updated_at: 1792925785139
_body: "content"
---

{
  "version": 1,
  "inputContract": "docs-search-final-row-json-v1",
  "model": "claude-sonnet-4-6",
  "rubricVersion": "search-relevance.24ff3d24999f",
  "sourceInputSha256": "6d10a25f953aff7dc752850e22c5cd8823cd767d85b5eda820a8ad120f4844bb",
  "cases": [
    {
      "pairId": "positive-retrieval-title",
      "class": "positive",
      "query": "Grading retrieval and final-context quality",
      "docId": "agent-insights/labelled-relevance-benchmarking",
      "docText": "{\"slug\":\"agent-insights/labelled-relevance-benchmarking\",\"url\":\"/internal/docs/agent-insights/labelled-relevance-benchmarking\",\"title\":\"Grading retrieval and final-context quality\",\"description\":\"Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.\",\"score\":78.66201575906581,\"excerpt\":\"The search-retrieval-quality standard covers actual search adapters and injection delivery. An all-source offline stage experiment is a separate population. Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scor…\",\"similarity\":0.783}",
      "goldRelevant": true,
      "goldBasis": "Exact retained title identifies this row; gold is known-item identity."
    },
    {
      "pairId": "positive-fairness-title",
      "class": "positive",
      "query": "Benchmark Fairness Criteria",
      "docId": "benchmarks/fairness-criteria",
      "docText": "{\"slug\":\"benchmarks/fairness-criteria\",\"url\":\"/internal/docs/benchmarks/fairness-criteria\",\"title\":\"Benchmark Fairness Criteria\",\"description\":\"The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.\",\"score\":3.568100013661976,\"excerpt\":\"…ubset\\\" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm). ### C2 — Identical model, verified from telemetry (not config) *…\",\"similarity\":0.627,\"anchor\":\"c1-identical-task-set-and-identical-scoring-denominator\"}",
      "goldRelevant": true,
      "goldBasis": "Exact retained title identifies this row; gold is known-item identity."
    },
    {
      "pairId": "negative-ios",
      "class": "easy-negative",
      "query": "How do I boot an iPhone 16 simulator with Xcode?",
      "docId": "agent-insights/labelled-relevance-benchmarking",
      "docText": "{\"slug\":\"agent-insights/labelled-relevance-benchmarking\",\"url\":\"/internal/docs/agent-insights/labelled-relevance-benchmarking\",\"title\":\"Grading retrieval and final-context quality\",\"description\":\"Reproduce retrieval quality studies with complete attempts, truthful adapters, exact delivery, authority and independently verified task benefit.\",\"score\":78.66201575906581,\"excerpt\":\"The search-retrieval-quality standard covers actual search adapters and injection delivery. An all-source offline stage experiment is a separate population. Reuse the existing benchmark, sampler, relevance evaluator, prompt records and scor…\",\"similarity\":0.783}",
      "goldRelevant": false,
      "goldBasis": "The complete delivered row describes retrieval grading, with no iOS simulator instructions."
    },
    {
      "pairId": "negative-wholesale",
      "class": "easy-negative",
      "query": "Where can I buy wholesale shoes from the Restart storefront?",
      "docId": "benchmarks/fairness-criteria",
      "docText": "{\"slug\":\"benchmarks/fairness-criteria\",\"url\":\"/internal/docs/benchmarks/fairness-criteria\",\"title\":\"Benchmark Fairness Criteria\",\"description\":\"The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.\",\"score\":3.568100013661976,\"excerpt\":\"…ubset\\\" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm). ### C2 — Identical model, verified from telemetry (not config) *…\",\"similarity\":0.627,\"anchor\":\"c1-identical-task-set-and-identical-scoring-denominator\"}",
      "goldRelevant": false,
      "goldBasis": "The complete delivered row is about agent benchmark fairness, with no retail inventory."
    },
    {
      "pairId": "near-miss-fairness",
      "class": "near-miss",
      "query": "Find the documentation page whose slug is agent-insights/labelled-relevance-benchmarking, for grading retrieval and final-context quality.",
      "docId": "benchmarks/fairness-criteria",
      "docText": "{\"slug\":\"benchmarks/fairness-criteria\",\"url\":\"/internal/docs/benchmarks/fairness-criteria\",\"title\":\"Benchmark Fairness Criteria\",\"description\":\"The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.\",\"score\":3.568100013661976,\"excerpt\":\"…ubset\\\" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm). ### C2 — Identical model, verified from telemetry (not config) *…\",\"similarity\":0.627,\"anchor\":\"c1-identical-task-set-and-identical-scoring-denominator\"}",
      "goldRelevant": false,
      "goldBasis": "Related benchmark vocabulary but this returned row has a different slug and describes agent benchmark fairness."
    },
    {
      "pairId": "near-miss-memory",
      "class": "near-miss",
      "query": "Find the documentation page whose slug is agent-insights/labelled-relevance-benchmarking, for grading retrieval and final-context quality.",
      "docId": "agent-insights/memory-recall-health-grading-runbook",
      "docText": "{\"slug\":\"agent-insights/memory-recall-health-grading-runbook\",\"url\":\"/internal/docs/agent-insights/memory-recall-health-grading-runbook\",\"title\":\"Grading memory-recall-health: effective contracts and actual delivery\",\"description\":\"Canonical memory system grading: effective calibration, client/port attempts, exact emitted context, budgets and session dedup.\",\"score\":26.76411128173079,\"excerpt\":\"…es delivered recall, admission, budgets and session dedup. Agent recall utilization is a separate behavior measure. Deterministic guards verify the measurement mechanisms; they do not replace a fresh population study. ## Observation contra…\",\"similarity\":0.69,\"anchor\":\"content-budgets-and-final-fidelity\"}",
      "goldRelevant": false,
      "goldBasis": "Related grading vocabulary but this row has a different slug and is specifically the memory-recall-health runbook."
    }
  ],
  "limits": {
    "maxCalls": 12,
    "maxCostUsd": 1.2,
    "perCallReservationUsd": 0.1,
    "maxPromptBytes": 20000,
    "maxOutputTokens": 1024,
    "maxDurationMs": 180000,
    "maxCallMs": 30000
  },
  "pricingEvidence": "libs/generic/bench-metrics/src/pricing.ts PRICE_TABLE_V1 claude-sonnet-4-6: input3/output15 USD per million, cache-write3.75. 20000 prompt bytes +1024 output tokens reserves0.1USD/call. Admission reservation is distinct from observed provider usage; uncertain usage stops the run.",
  "acceptance": {
    "minimumPerClass": 2,
    "requiredAgreement": 1,
    "maximumFlipRate": 0
  }
}

