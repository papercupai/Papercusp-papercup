---
rel_path: "evidence/public-manual-expansion-and-freshness-2026-10-03/metavet-filesystem-replay-args.json"
updated_at: 1791016602013
_body: "content"
---

{
  "rubricRef": "meta-acceptance-rubric",
  "sourceHive": "papercusp",
  "subject": {
    "kind": "rubric",
    "ref": "acceptance-public-manual-expansion-and-freshness-2026-10-03"
  },
  "ratings": {
    "outcomes-not-diff-restatements": {
      "rating": "pass",
      "evidence": "Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Read each criteria[].model: R1 requires a source/serving inventory, R2 substantive navigable guides, R3 change-triggered review and containment, R4 observed anonymous serving/search journeys. These are observable results; an edit diff alone cannot demonstrate them."
    },
    "traces-to-goal-or-decision": {
      "rating": "pass",
      "evidence": "Read the exact saved plan snapshot pack with capability:read {\"file_path\":\"/home/marsh-office/.papercusp/scratch/packs/repomix-a723f6df4973-1791016339412.md\",\"offset\":40,\"limit\":80}. It preserves docs/evidence/public-manual-plan-revision4-goal-decisions.json copied byte-for-byte from the canonical plan revision store: row70040 seq4, full snapshot SHA256866ef72bf5c0935173c611af40f261ae4b1f1db14a88cd8ddf3c6a9c0fc4d5ff. The source-file copy and exact preserved repomix artifact were read back before emission; no claim is made that the uncommitted copy existed in a Git revision. Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Compare separate stores: the preserved plan title/Now/scope require an expanded/refreshed published public manual and maintained freshness. D001 explicitly requires NEW documentation; D002 preserves four outcomes while amending sentence atomicity at planrevision4/rubricrevision2. R1 measures source/serving inventory, R2 new and refreshed navigable guides, R3 maintained freshness/review, R4 actual serving reader journeys. These match the authoritative historical plan goal and Decisions, rather than only the rubric's self-description or mutable current plan. The replay uses the judge-permitted filesystem read already demonstrated by prior audits; it needs no artifacts:read, shell, Git or sessions capability. Persisted source-turn pointers are retained as provenance, without fabricating owner enrollment."
    },
    "falsifiable-with-evidence": {
      "rating": "pass",
      "evidence": "Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Read criteria[].model, method, check, and driftMarkers. R1 fails if source is reported serving without comparison; R2 fails on absent/unlinked guides or invented commands; R3 fails when source changes cannot mark review or content escapes/copies; R4 fails on absent serving/search or failed probes claimed successful. Each has a concrete falsifier and a named verification mechanism."
    },
    "failure-mode-coverage": {
      "rating": "pass",
      "evidence": "Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Enumerate model/driftMarkers/check across R1-R4: source-vs-serving identity, missing/new-guide navigation, anchor/link/source containment, copied canonical prose, stale build and failed external-reader probes are explicitly covered. The methods include source negative controls, filesystem/drift tests and deployed-reader observation. This is a structural coverage judgment about this immutable rubric, not a new claim of test execution."
    },
    "non-overlapping": {
      "rating": "pass",
      "evidence": "Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Pairwise compare the four returned models with these logical counterexamples: correct inventory/missing guide distinguishes R1-R2; correct navigation/unreviewed source change R2-R3; correct tracking/stale serving R3-R4; correct serving/incomplete inventory R4-R1; complete inventory/broken tracking R1-R3; authored guides/unavailable serving R2-R4. These are logical distinguishing cases, not claimed observed incidents. Each pair can fail one criterion independently."
    },
    "prefer-structured-check": {
      "rating": "weak",
      "evidence": "Run rubrics:get {\"rubricRef\":\"acceptance-public-manual-expansion-and-freshness-2026-10-03\",\"revision\":2,\"detail\":\"full\"}. Read capability:read {\"file_path\":\"/home/marsh-office/.papercusp/scratch/packs/repomix-58c3259e1793-1791012521883.md\",\"offset\":49,\"limit\":72}. This exact saved repomix1.18.0 pack was captured from clean commit4c7ac1dd96097700b4ae214410ad1eb6fd508b8d, two files/5694bytes; complete browser source at49-91 and inventory at93-120. Run testing:runs {\"testRunIds\":[20649078],\"limit\":1}. Compare preserved oracle paths with immutable rubricrevision2 R1/R4 check.files: inventory population/serving identity and five guide navigation/reload/mobile plus Pagefind oracles exist, but their two paths are omitted from structured checks. Keep weak; saved browser receipt is separate proof, not an invented structured binding. All replay tools are judge-permitted and use this preserved artifact."
    }
  },
  "terminal": true,
  "supersedes": "EI-24945964108731519",
  "testedSha": "4c7ac1dd96097700b4ae214410ad1eb6fd508b8d",
  "vettingConsult": "conv-murzx786-0000-1eb2c63fe5ff45abb2f1ed109b6dac56",
  "vettingUnanswered": true,
  "vettingUnansweredReason": "Recorded consult exhausted the automatic backend ladder with no_qualified_responder and zero posts; preserve documented unanswered disposition.",
  "body": "Evidence-harness contract audited against independent receipts: preserved plan snapshot is the correct authority; artifacts:read is unavailable to system:judge. Exact canonical revision4 was copied through owned docs/evidence and frozen with existing code:pack, then read through capability:read. Changed only the failed trace replay mechanism; no permission widening, rubric/BAR meaning change, mutable-plan substitution or self-audit. Previous audit EI-24946244340964446 passed instrument-split and failed only the artifact read recipe. The canonical plan snapshot is preserved at docs/evidence/public-manual-plan-revision4-goal-decisions.json and the exact frozen pack was read back before this submission.",
  "projection": {
    "pick": [
      "ok",
      "issueId",
      "error",
      "gradingAuditPending",
      "supersedes"
    ]
  }
}
