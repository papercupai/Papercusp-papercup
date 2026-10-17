---
rel_path: "verification/WI-10005786/2026-10-17-additional-scout-plan.json"
updated_at: 1792259689926
_body: "content"
---

{
  "measuredAt": "2026-10-17T17:54:49.911Z",
  "plan": {
    "ok": true,
    "slug": "scout-su-ideate-pipeline-gaps-2026-10-08",
    "harness": "papercusp",
    "archived": false,
    "legacy": false,
    "title": "Scout + su-ideate pipeline gaps: trustworthy outcomes, no wasted generation, routed ideas consumed",
    "status": "draft",
    "startStatus": null,
    "frontmatter": {
      "raw": {
        "title": "Scout + su-ideate pipeline gaps: trustworthy outcomes, no wasted generation, routed ideas consumed",
        "slug": "scout-su-ideate-pipeline-gaps-2026-10-08",
        "status": "draft",
        "created": "2026-10-08",
        "updated": "2026-10-09"
      },
      "title": "Scout + su-ideate pipeline gaps: trustworthy outcomes, no wasted generation, routed ideas consumed",
      "slug": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "status": "draft",
      "created": "2026-10-08",
      "updated": "2026-10-09"
    },
    "now": {
      "state": "⚠ BAR READINESS BLOCKED (2026-10-09, after item-dropped): bar_snapshot_rubric_revision_mismatch, bar_snapshot_work_contract_missing, bar_snapshot_proof_missing, bar_snapshot_proof_inadequate, bar_snapshot_grading_missing, bar_snapshot_mapping_dropped_only, bar_snapshot_evidence_plane_unmet, bar_snapshot_clause_not_accepted, bar_snapshot_vetting_missing. Next repair: Before mutating BAR state, run dev:pipeline_position { path: \"packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts\", marker: \"synchronizeAcceptanceBarSubjectRevision\" } to distinguish a stale serving build from a live guard. If the synchronizer is not deployed, land/redeploy it first; otherwise re-seed or amend atomically so subject and rubric revision pins agree.. (re-evaluated in the same write by the scope-write cascade, P-030/P-031)\n\nDraft by su-703445b7 from owner directive #1560 [owner:Avi 2026-10-08]: \"Write a plan for filling the gaps and improving our su ideate and scout pipelines and then put yourself on auto mode and implement them yourself\". Route A (self), AUTO mode. Gym is paused per #1558 and out of scope. Evidence: reports rpt_d49be19f-a171-40a1-8666-cf49f49e59c6 (current) and rpt_263bd0ed (superseded); audit WI-10007368. Overlapping stale plans to reconcile in P-010: scout-idea-grading-2026-06-12 and su-ideate-learning-substrate-2026-07-10.",
      "next": "Vet the current acceptance-rubric criteria BEFORE binding proof or emitting adequacy cards (amend → vet → attest → bind → cards → grade): a vetting critique usually becomes an amendment, and proof bound first must then be re-bound.",
      "raw": "**State:** ⚠ BAR READINESS BLOCKED (2026-10-09, after item-dropped): bar_snapshot_rubric_revision_mismatch, bar_snapshot_work_contract_missing, bar_snapshot_proof_missing, bar_snapshot_proof_inadequate, bar_snapshot_grading_missing, bar_snapshot_mapping_dropped_only, bar_snapshot_evidence_plane_unmet, bar_snapshot_clause_not_accepted, bar_snapshot_vetting_missing. Next repair: Before mutating BAR state, run dev:pipeline_position { path: \"packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts\", marker: \"synchronizeAcceptanceBarSubjectRevision\" } to distinguish a stale serving build from a live guard. If the synchronizer is not deployed, land/redeploy it first; otherwise re-seed or amend atomically so subject and rubric revision pins agree.. (re-evaluated in the same write by the scope-write cascade, P-030/P-031)\n\nDraft by su-703445b7 from owner directive #1560 [owner:Avi 2026-10-08]: \"Write a plan for filling the gaps and improving our su ideate and scout pipelines and then put yourself on auto mode and implement them yourself\". Route A (self), AUTO mode. Gym is paused per #1558 and out of scope. Evidence: reports rpt_d49be19f-a171-40a1-8666-cf49f49e59c6 (current) and rpt_263bd0ed (superseded); audit WI-10007368. Overlapping stale plans to reconcile in P-010: scout-idea-grading-2026-06-12 and su-ideate-learning-substrate-2026-07-10.\n\n**Next:** Vet the current acceptance-rubric criteria BEFORE binding proof or emitting adequacy cards (amend → vet → attest → bind → cards → grade): a vetting critique usually becomes an amendment, and proof bound first must then be re-bound.",
      "lineNumber": 2,
      "nextDerivation": {
        "disposition": "unverifiable",
        "storedNext": "Vet the current acceptance-rubric criteria BEFORE binding proof or emitting adequacy cards (amend → vet → attest → bind → cards → grade): a vetting critique usually becomes an amendment, and proof bound first must then be re-bound.",
        "staleStoredRefs": [],
        "contradictions": [],
        "itemId": "P-007",
        "effectiveStatus": "todo",
        "reason": "actionable",
        "candidates": [
          {
            "id": "P-007",
            "effectiveStatus": "todo",
            "needsHuman": false
          },
          {
            "id": "P-010",
            "effectiveStatus": "todo",
            "needsHuman": false
          }
        ],
        "candidatesTruncated": false,
        "blockedOn": [],
        "counts": {
          "total": 10,
          "done": 8,
          "dropped": 0,
          "nonTerminal": 2
        }
      }
    },
    "contentHash": "9ccc8fb2b1a67bbf9d67640c2eebdb246758c07f0a8e527d61a934f4f8ad5d27",
    "version": 43,
    "promotePolicy": {
      "policy": null,
      "warnings": []
    },
    "forcedPast": null,
    "sectionIndex": [
      {
        "heading": "Now",
        "level": 2,
        "chars": 1604
      },
      {
        "heading": "Background",
        "level": 2,
        "chars": 1043
      },
      {
        "heading": "Requirements",
        "level": 2,
        "chars": 27977
      },
      {
        "heading": "Design",
        "level": 2,
        "chars": 971
      },
      {
        "heading": "Phase 1 — Measurement truth",
        "level": 2,
        "chars": 1204
      },
      {
        "heading": "Phase 2 — Generation efficiency",
        "level": 2,
        "chars": 924
      },
      {
        "heading": "Phase 3 — Consumption and producers",
        "level": 2,
        "chars": 1551
      },
      {
        "heading": "Phase 4 — Grading and acceptance",
        "level": 2,
        "chars": 544
      },
      {
        "heading": "Decisions",
        "level": 2,
        "chars": 27626
      }
    ],
    "counts": {
      "items": 10,
      "decisions": 16,
      "sections": 9
    },
    "enrichmentsDeferred": true,
    "items": [
      {
        "id": "P-001",
        "text": "Fix the routed-idea outcome resolver so ideas on terminal WIs resolve won/lost (WI-10007390); back-fill outcomes; Vitest regression test. — note: Verified 2026-10-08T15:17Z via live census of harness_shared.scout_routed_ideas joined on 'wi:'||work_items.feature_id: production learning origins (scout 1048 pending, su-ideate 92 pending) have 0 ideas pending/NULL on a terminal work-item (was 340 per WI-10007390). Resolver fix outcomeOfWorkItemTag in packages/operator-core/lib/scout/outcome-feedback.ts (committed 501a4db123), regression tests in outcome-feedback.test.ts; WI-10007390 done (completionAuthority committed). Residual 876 NULL-on-terminal rows are origin agent-review (excluded from learning by design, countStalePendingIdeas WI-42483) - carried to P-008's agent-review/ideation split.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 1 — Measurement truth",
        "lineNumber": 155,
        "rawLine": "- **P-001** `done` Fix the routed-idea outcome resolver so ideas on terminal WIs resolve won/lost (WI-10007390); back-fill outcomes; Vitest regression test. — note: Verified 2026-10-08T15:17Z via live census of harness_shared.scout_routed_ideas joined on 'wi:'||work_items.feature_id: production learning origins (scout 1048 pending, su-ideate 92 pending) have 0 ideas pending/NULL on a terminal work-item (was 340 per WI-10007390). Resolver fix outcomeOfWorkItemTag in packages/operator-core/lib/scout/outcome-feedback.ts (committed 501a4db123), regression tests in outcome-feedback.test.ts; WI-10007390 done (completionAuthority committed). Residual 876 NULL-on-terminal rows are origin agent-review (excluded from learning by design, countStalePendingIdeas WI-42483) - carried to P-008's agent-review/ideation split.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-002",
        "text": "While the Gym is paused, stop routing scout ideas to the gym rail, classify the 607 permanently-pending gym-rail ideas unresolvable, and exclude them from win-rate denominators; test. — note: D-004: verified live via WI-10007478 (done, committed): 607 legacy gym rows pending -> unresolvable on live DB via production refreshScoutOutcomes; tests run 4e817bca 134/0.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 1 — Measurement truth",
        "lineNumber": 156,
        "rawLine": "- **P-002** `done` While the Gym is paused, stop routing scout ideas to the gym rail, classify the 607 permanently-pending gym-rail ideas unresolvable, and exclude them from win-rate denominators; test. — note: D-004: verified live via WI-10007478 (done, committed): 607 legacy gym rows pending -> unresolvable on live DB via production refreshScoutOutcomes; tests run 4e817bca 134/0.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-003",
        "text": "Pre-flight guard: skip or curb paid scout generation under deep admission throttle or a high recent dedup rate, and record the reason on the cycle record (WI-10007380); reuse dedup-burn-guard.ts; test. — note: D-004: verified live via WI-10007380 (done, committed): post-restart tick 22:11:50Z gated generation-preflight under deep throttle, 0 generated, no spend; pre-restart deep-throttle ticks paid $0.20-0.36 each.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 2 — Generation efficiency",
        "lineNumber": 159,
        "rawLine": "- **P-003** `done` Pre-flight guard: skip or curb paid scout generation under deep admission throttle or a high recent dedup rate, and record the reason on the cycle record (WI-10007380); reuse dedup-burn-guard.ts; test. — note: D-004: verified live via WI-10007380 (done, committed): post-restart tick 22:11:50Z gated generation-preflight under deep throttle, 0 generated, no spend; pre-restart deep-throttle ticks paid $0.20-0.36 each.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-004",
        "text": "Recalibrate scout dedup (WI-35809): measure on a labeled sample, then apply a two-stage or threshold fix so distinct same-domain ideas survive while true duplicates still merge; test. — note: D-004: dedup recalibration committed e447980feb, live in bg-host since 21:55:40Z; 43/43 calibration+reject-cause tests pass 23:05Z; live probe shows semanticLeg recorded with reason; completion audit seq 7. Ran-tick semanticLeg=ok read carried (scout gated by deep throttle).",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 2 — Generation efficiency",
        "lineNumber": 160,
        "rawLine": "- **P-004** `done` Recalibrate scout dedup (WI-35809): measure on a labeled sample, then apply a two-stage or threshold fix so distinct same-domain ideas survive while true duplicates still merge; test. — note: D-004: dedup recalibration committed e447980feb, live in bg-host since 21:55:40Z; 43/43 calibration+reject-cause tests pass 23:05Z; live probe shows semanticLeg recorded with reason; completion audit seq 7. Ran-tick semanticLeg=ok read carried (scout gated by deep throttle).",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-005",
        "text": "Routed-idea consumer: adjudicate the ~500-item idea backlog (EI-19480163059215610), and add a claim-spec field to target (include) or exclude ideation items (EI-18697923246606437); tests. — note: Author implementation/current-build verification complete on WI-10007500: active R9@3,R10@4,R11@4,SPEC-P005@1 diagnostic adequacy PASS. Canonical mutation guards20950870/20950900 paired with current baseline20/15 and preserved operational20950292. Final independent rubricrev5 certification and shipment remain P-010, not asserted by this item close. D-004/D-016 direct status route; no promotion.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 163,
        "rawLine": "- **P-005** `done` Routed-idea consumer: adjudicate the ~500-item idea backlog (EI-19480163059215610), and add a claim-spec field to target (include) or exclude ideation items (EI-18697923246606437); tests. — note: Author implementation/current-build verification complete on WI-10007500: active R9@3,R10@4,R11@4,SPEC-P005@1 diagnostic adequacy PASS. Canonical mutation guards20950870/20950900 paired with current baseline20/15 and preserved operational20950292. Final independent rubricrev5 certification and shipment remain P-010, not asserted by this item close. D-004/D-016 direct status route; no promotion.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-006",
        "text": "Scout reliability: retry or fall back on inference-gateway transport deaths (target cycle error under 5%), plus a stale-host guard (EI-18700942267136001); tests. — note: D-004: transport retry + stale-host guard committed and live in bg-host since 21:55:40Z; tests 31/31; hostBuildSha verified on live ticks; 7d error rate 3.7%. A live retry occurrence (detail.transportRetries) is a carried check.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 164,
        "rawLine": "- **P-006** `done` Scout reliability: retry or fall back on inference-gateway transport deaths (target cycle error under 5%), plus a stale-host guard (EI-18700942267136001); tests. — note: D-004: transport retry + stale-host guard committed and live in bg-host since 21:55:40Z; tests 31/31; hostBuildSha verified on live ticks; 7d error rate 3.7%. A live retry occurrence (detail.transportRetries) is a carried check.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-007",
        "text": "su-ideate trigger: scheduled su-ideate passes for every pot with su-ideate enabled (not papercusp-only), and fix blender:ideate-pass-record invalid_input (EI-24428150977170134); tests.",
        "storedStatus": "todo",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 165,
        "rawLine": "- **P-007** `todo` su-ideate trigger: scheduled su-ideate passes for every pot with su-ideate enabled (not papercusp-only), and fix blender:ideate-pass-record invalid_input (EI-24428150977170134); tests.",
        "effectiveStatus": "todo",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-009",
        "text": "Zero-output alarm for every active learning producer (covers the detector half of WI-10007379, the pot switch, and Red Queen); test. — note: D-004: verified live via WI-10007523 (done, committed): watchdog tick 22:10:55Z collector papercusp-producer-silence ok, 6 producer x pot checked, 1 signal.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 166,
        "rawLine": "- **P-009** `done` Zero-output alarm for every active learning producer (covers the detector half of WI-10007379, the pot switch, and Red Queen); test. — note: D-004: verified live via WI-10007523 (done, committed): watchdog tick 22:10:55Z collector papercusp-producer-silence ok, 6 producer x pot checked, 1 signal.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-008",
        "text": "Grading loop: weekly human grading sample into the owner inbox; separate agent-review from ideation in success-metrics; lens weights read corrected outcomes. — note: Verified live 23:40-23:47Z: R-17 samples_7d=1, R-18 agentReview bucket on :3170, R-19 weights recomputed after backfill with 0 terminal-pending. Audit seq 9. D-004.",
        "storedStatus": "done",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 4 — Grading and acceptance",
        "lineNumber": 169,
        "rawLine": "- **P-008** `done` Grading loop: weekly human grading sample into the owner inbox; separate agent-review from ideation in success-metrics; lens weights read corrected outcomes. — note: Verified live 23:40-23:47Z: R-17 samples_7d=1, R-18 agentReview bucket on :3170, R-19 weights recomputed after backfill with 0 terminal-pending. Audit seq 9. D-004.",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      {
        "id": "P-010",
        "text": "Acceptance: reconcile and supersede the overlapping stale plans, re-run blender:success-metrics to a pass, author and vet the acceptance rubric, get independent grading, ship.",
        "storedStatus": "todo",
        "importance": "normal",
        "riskTier": null,
        "authority": "system",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 4 — Grading and acceptance",
        "lineNumber": 170,
        "rawLine": "- **P-010** `todo` Acceptance: reconcile and supersede the overlapping stale plans, re-run blender:success-metrics to a pass, author and vet the acceptance rubric, get independent grading, ship.",
        "effectiveStatus": "todo",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      }
    ],
    "decisions": [
      {
        "id": "D-001",
        "title": "Acceptance BAR amendment",
        "body": "Date: 2026-10-08\nAmendment-Id: amend-6413b1f7625c3dffa5388296\nRequest-Hash: d99d8df704f6b2982fbd038bd2511283bd7a3fd5cd42007088d8ae83ab5024e7\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: Split rev-1 compound BARs into 20 atomic, independently falsifiable BARs per outside reviewer objection (WI-10007390 thread-post 1164472): every rev-1 clause keeps its own BAR and every rev-1 live evidence plane stays live with a declared runtime.\nApproved-By: system:judge/su-b1045d99-fbb5-42bc-9933-0689e3214096\nApproval-Ref: thread-post:1164768\nApproved-At: 2026-10-08T11:37:23.339Z\nRubric revision: 1 → 2\nSubject plan revision: 5 → 6\nChanged BARs: R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19, R-20\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\nRequirements re-rendered from the amended criterion: R-1",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 174
      },
      {
        "id": "D-002",
        "title": "P-004 design: two-stage dedup (recall shortlist + critic adjudication), no threshold change",
        "body": "Date: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007481]\n\nMeasured (scout_cycle_stage_artifacts, 30 retained cycles / 65 scored ideas): corpus dedup merged 0 ideas (noveltyMatches empty on all 65); rejects were feasibility-only 35, LLM-novelty+feasibility 14, LLM-novelty-only 3, feasibility-zero 1. Stored gemma vectors: 109 of 405 scout nearest-neighbour pairs are at cosine >= 0.92 and only 18 of 405 are same-cycle, so restated ideas are routed as separate WIs across cycles. Manually read pairs in the 0.88-0.95 band mix true restatements (same problem, same mechanism) with same-problem/different-mechanism ideas: no cosine threshold separates them (confirms WI-35809).\n\nDecision: do NOT move matchFloor / semanticBaselineQuantile / noveltyFloor. Instead:\n1. Stage 1 (recall): corpusNovelty also returns the top-K (5) nearest priors by blended similarity regardless of matchFloor, above a low recall floor, so it works whether the semantic leg resolves or the matcher is lexical-only.\n2. Stage 2 (adjudication): the existing per-idea critic call (no new LLM spend) receives those priors WITH their text and returns duplicateOf: <ref|null>. Same mechanism for the same problem = duplicate; same problem, different mechanism = distinct.\n3. Deterministic merge rule: a duplicateOf naming a shortlisted ref merges the idea (verdict reject, reason duplicate-of:<ref>); an unshortlisted/hallucinated ref is ignored.\n4. ScoredIdea records the semantic-leg status so a silent fail-open is visible.\n5. ideasDeduped semantics are unchanged (P-003 reads it); duplicates get their own count in the tick detail. The ideasDeduped mislabel is tracked as a separate owned item.\n\nR-7/R-8 unit test (dedup-calibration.test.ts) uses labeled pairs with their real measured cosines as fixtures; the LLM adjudication quality is verified on a live tick, not claimed from the unit test.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-003"
        ],
        "affects": [],
        "lineNumber": 189
      },
      {
        "id": "D-003",
        "title": "P-004 refinement: in the Scout critic, semantic similarity feeds the stage-1 shortlist, not the novelty ceiling; lexical recall floor 0.05",
        "body": "Date: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007481; refines D-002, moves no threshold]\n\nMeasured, 11 manually labeled scout pairs (7 true restatements, 4 same-problem/different-mechanism), each idea's real gemma cosine distribution against 7,124 vector-bearing corpus entries (scout-routed WIs + plans). Scratch: .papercusp/scratch/p004/pair-backgrounds.{sql,json}.\n- Under the existing calibration (q0.9 baseline), calibrated similarity is 0.46-0.75 for true duplicates and 0.43-0.76 for distinct pairs: full overlap. If the semantic leg resolves, the deterministic ceiling would reject distinct pair #2 (stalled-claim watchdog, different mechanism; novelty 0.24 < 0.34) while catching only 2 of 7 true duplicates. The semantic ceiling errs in both directions.\n- Lexical: Jaccard of the critic query (title+body) against corpus idea titles is 0.05-0.15 even for true restatements, so matchFloor 0.5 is unreachable lexically (consistent with noveltyMatches empty on all 65 scored ideas). Top-5 lexical recall over the real 1,000-title idea corpus: 4 of 7 duplicates; semantic top-5 recall: 7 of 7 (selection-biased: each twin was picked as its idea's nearest neighbour). Containment ranks twins WORSE than Jaccard, so it is not used.\n\nDecision:\n1. critiqueIdea calls the novelty core with semanticLowersNovelty:false. Semantic similarity still ranks matches and the stage-1 shortlist (flagged semantic) and reaches the critic as evidence with the prior's text, but the deterministic novelty ceiling and alreadyTried derive from lexical similarity only. The stage-2 critic adjudicates duplicateOf. Other callers (su novelty pre-check, dream review) read matches and keep the P-017 default (true).\n2. recallFloor default is 0.05, not the 0.2 in the WI-10007481 checkpoint; shortlistSize 5 bounds the shortlist.\n3. Because lexical-only recall is 4 of 7, the semantic leg's availability is the bigger lever. Every ScoredIdea records semanticLeg (resolved/unavailable/skipped), and the leg's production fail-open is tracked on EI-25415789244685046 (inferred, unverified on bg-host).",
        "date": "2026-10-08",
        "itemRefs": [
          "P-017"
        ],
        "affects": [],
        "lineNumber": 204
      },
      {
        "id": "D-004",
        "title": "Execute via the existing ad-hoc work-items; do not run plans:start for this plan",
        "body": "Date: 2026-10-08\n[self-imposed, su-703445b7, 2026-10-08] P-001..P-004 were implemented on ad-hoc work-items (WI-10007379, WI-10007478, WI-10007380, WI-10007481; plus WI-10007486 from P-004 measurement) while plans:start was blocked on the spec card. promotePlanItems is idempotent only for items it promoted itself (source_plan_item ids); these ad-hoc items have sourcePlanSlug null, so plans:start now would mint UNCLAIMED placeable duplicates of in-flight/finished items that fleet agents could claim and redo. Ruling: plan-item status is set directly with plans:set-status as each linked work-item verifies; plans:start is not used for this plan. Shipping still goes through plans:audit + the acceptance rubric.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-001",
          "P-004"
        ],
        "affects": [],
        "lineNumber": 217
      },
      {
        "id": "D-005",
        "title": "P-007 design: 'scheduled' = an hourly evaluation of the owner's D-015 observation-count verdict per pot; no calendar trigger",
        "body": "Date: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007505]\n\nGoverning prior decision: su-ideate-learning-substrate-2026-07-10 D-015 [owner:avi 2026-07-10] \"OVERDUE is observation-count-keyed, never calendar-keyed ... NO day/hour trigger exists\". P-007 must not contradict it.\n\nGap measured: the D-015 overdue verdict (orient-ideate-hint.ts computeIdeateOverdue) is evaluated only inside coord:orient for a caller that already has IDEATE mode active, so a pass happens only when someone manually puts an su into IDEATE. Every su-ideate tick ever recorded is install 'papercusp' (211) except 2 on sb-devboard-hive.\n\nDesign:\n1. A workspace-singleton blueprint 'su-ideate' (triggers.schedule, singleton, seeded active; same shape as memory-live-recall-canary) runs op 'su-ideate:schedule' hourly. The hour is only the EVALUATION heartbeat, not a fire trigger.\n2. Per pot: eligible iff potLearningEnabled(pot) (the existing per-pot learning master switch, absent row = enabled). Verdict per pot = D-015 unchanged: lane:observation rows filed in that pot since that pot's last su-ideate pass >= SU_IDEATE_OBS_THRESHOLD (default 10), or that pot's su-ideate idea queue fully drained.\n3. Overdue pot -> launch ONE headless, independent su via capability:launch-agent (the grading-auditor door) with the ideation stack layer and a one-pass brief: ground (blender:ideation-feedback), run the next lens in rotation, file lens-tagged ideas, route broad ones, close with blender:ideate-pass-record { lens, ... } for that pot, end. Idempotency key = pot + last-pass timestamp, so a pass in flight is never doubled. At most one launch per tick workspace-wide (cost bound).\n4. The routine row's active flag is the kill switch (routines:set pause); no new flag.\n\nR-14 BAR wording (\"every schedule window contains a fired pass\") is stricter than D-015 allows; amend it in P-010 to \"every window in which the D-015 verdict read overdue for a pot contains a fired pass for that pot\".",
        "date": "2026-10-08",
        "itemRefs": [
          "P-007",
          "P-010"
        ],
        "affects": [],
        "lineNumber": 221
      },
      {
        "id": "D-006",
        "title": "P-007 cost bound: rolling-24h launch budget, one pass in flight, attempt circuit, oldest-pass-first; unit = harness",
        "body": "Date: 2026-10-08\nDate: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007505]\n\nRefines D-005 (does not change D-015).\n\nMeasured (engineer_issues, 3 days to 2026-10-08): organic lane:observation filings per harness: papercusp 26,775 (~9k/day), email 94, sb-devboard-hive 65, portal 31, phone-app 12, crm 10. With the D-015 threshold of 10, papercusp reads overdue on every hourly evaluation, so D-005's 'at most one launch per tick' alone permits ~24 launches/day, mostly redundant with the 37-57/week passes GOAL holders already record in papercusp.\n\nDecision (implemented in packages/operator-core/lib/scout/su-ideate-schedule.ts):\n1. Unit is the HARNESS (scout_ticks.install_slug, the issue scope harness:<slug>), gated by the learning switch of the pot it resolves to (resolveLearningPotSlug -> potLearningEnabled).\n2. Budget: at most PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY (default 6) scheduled launches per rolling 24h workspace-wide. This is a ceiling, never a trigger, so D-015 holds.\n3. One scheduled pass in flight workspace-wide: a launch blocks while its task is live, its harness has not recorded a pass since it started, and it is under 2h old.\n4. Circuit: 3 launches for a harness since its last pass without a recorded pass -> that harness is skipped until any pass records (by anyone).\n5. Order: never-passed harnesses first, then oldest last pass. Time only ORDERS overdue harnesses; it never makes one overdue.\n6. Launch door: capability:launch-agent handler under system actor system:su-ideate-schedule (the grading-audit pattern), headless + independent, stack ideation:su.mode-ideate, label = idempotency key su-ideate-pass:<harness>:<lastPass|never>:<attempt>. The launch door's idempotency claim lives 7 days, so the attempt number is part of the key; keying on harness+lastPass alone would block a harness for a week after one dead pass.\n7. The D-015 verdict is one function, ideateOverdueFromCounts (orient-ideate-hint.ts), shared by orient and the schedule.",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 237
      },
      {
        "id": "D-007",
        "title": "P-009 producer-silence alarm: scope is LEARNING_PRODUCERS; su-ideate is covered by its scheduler, not a time-based silence alarm",
        "body": "Date: 2026-10-08\n[self-imposed, su-703445b7, 2026-10-08] P-009 ships as a sixth learning-SLO collector (packages/operator-core/lib/harness/improvements/producer-silence.ts, wired in learning-slo.ts producerSilenceCollector + watchdog.ts 'papercusp-producer-silence', flag papercusp-learning-slo-sensors). Its producer set is DERIVED from experiment/lifecycle-adapter.ts LEARNING_PRODUCERS (scout, gym, calibration, transfer, regret, red-queen) via a Record<LearningProducer, probe> map, so a new producer cannot compile without a probe. A producer is judged only when ACTIVE: governor loop enabled, pot learning switch on, and driving routine not explicitly active:false (gym-cycle@papercusp inactive per owner directive #1558 therefore exempts the Gym). su-ideate is deliberately OUT of this alarm: its passes are demand-driven by the D-015 overdue verdict (D-005/D-006), so a quiet pot correctly produces nothing and a time-based silence alarm would misfire; scheduler liveness is covered by the su-ideate:schedule routine (infra-liveness dead-routines) and its per-harness decision log. Governor loops no probe claims (dream:*, miners, fleet-ekg, prompt-ablation, replay-harness) are counted as unprobed in the tick note, never silently passed. Read failures make the collector throw so auto-close never reads an unmeasured tick as resolved.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-009"
        ],
        "affects": [],
        "lineNumber": 255
      },
      {
        "id": "D-008",
        "title": "P-010 reconciliation: the two overlapping stale plans are superseded by this plan",
        "body": "Date: 2026-10-08\nDecided 2026-10-08 [self, under owner directive #1560 AUTO route A]. scout-idea-grading-2026-06-12 (awaiting-acceptance since 2026-08-31, all 10 items terminal) and su-ideate-learning-substrate-2026-07-10 (ready since 2026-07-12, all 22 items terminal) were set to superseded with guarded transitions. Coverage mapping: owner grades steering lens weights -> P-008 (R-17 weekly owner grading sample, R-18 agent-review split, R-19 newest-scope lens weights); outcomes -> P-001; pacing -> P-007; file-time quality -> P-002/P-003/P-004. Their acceptance is graded on this plan's rubric; nothing from either plan is carried as an open item.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-008",
          "P-001",
          "P-007",
          "P-002",
          "P-003",
          "P-004"
        ],
        "affects": [],
        "lineNumber": 259
      },
      {
        "id": "D-009",
        "title": "R-9 ideation backlog adjudication: deterministic keep/merge/drop over dedup_edges cos>=0.90, retire merged/rejected open ideas",
        "body": "Date: 2026-10-08\nEvery ideation-class work-item (ITEM_CLASS_SQL_TEXT, the R-10/R-11 definition) carries payload.ideaDisposition {disposition keep|merge|drop, basis, relatedTo?, cos?, version, adjudicatedAtMs, by}. Rules, oldest first: terminal done/resolved, or closed with completion evidence -> keep; dropped with 'duplicate of X' -> merge into X; other terminal -> drop; open with an older KEPT near-duplicate (harness_shared.dedup_edges cos>=0.90, the admission census duplicate floor; no new similarity) -> merge into the closest; open whose only older near-duplicates were dropped -> drop; else keep. A recorded disposition is never rewritten. Open merge/drop ideas are retired to 'dropped' via setWorkItemState with the promoter's 'duplicate of <id>' reason. Module scout/ideation-backlog-adjudication.ts; recurring bg-host step 'scout-ideation-backlog-adjudication' (<=100 closes per run; kill switch PAPERCUSP_SCOUT_IDEATION_ADJUDICATION=0). Live pass 2026-10-08 17:08Z: 1358 dispositions written (terminal 361 keep / 518 drop / 2 merge; open 389 keep / 75 merge / 13 drop), 88 open ideas retired via audited work_items:set_state; 0 ideation items lack a disposition. Spot-check 5/5 sampled merges were the same idea. Source: owner directive #1560 + EI-19480163059215610 (cluster-triage the backlog).",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 263
      },
      {
        "id": "D-010",
        "title": "R-14/R-16 BAR: an open su-ideate circuit is a raised failure, never a silent exemption",
        "body": "Date: 2026-10-08\nSource: outside-lineage objection to the rev-2 BAR amendment (system:judge su-dbca9062, thread-post:1165584 on WI-10007529, 18:00Z) [peer:system:judge]. It approved R-10/R-11/R-15 as written and blocked R-14/R-16, correctly: the amendment's R-14 model excused any tick that records an open circuit, and in su-ideate-schedule.ts the circuit (SU_IDEATE_MAX_ATTEMPTS=3 scheduled launches with no recorded pass) was only logged as disposition 'attempts-exhausted' and raised nothing, so a harness whose passes always die satisfied R-14, and R-16's su-ideate exemption (D-007) left it caught by no BAR.\n\nDecision [self, AUTO]: fix the CODE, then tighten the bar, rather than defend the wording.\n1. Code: readSuIdeateOpenCircuits (su-ideate-schedule.ts) is the dead-pass census, sharing ONE attempts definition (suIdeateAttemptsSinceLastPass) with the scheduler. An open circuit = >= max attempts since the last pass, none live-and-fresh (younger than SU_IDEATE_PASS_STALE_MS), pot learning switch on. The P-009 producer-silence collector raises each open circuit as a major bug signal (key producer-silence:su-ideate-circuit:<harness>, findingClass learning-slo:producer-silence); a failed read is 'unmeasured' and the collector throws rather than report a quiet tick. Auto-close resolves it once a pass records.\n2. R-14 BAR (rev 3): unit is the HARNESS, gated by its pot's learning switch (D-006 §1). Every harness the D-015 verdict reads overdue is launched within a bounded rotation, oldest last pass first under the daily budget (D-006 §5; already implemented, su-ideate-schedule.ts sort). An open circuit counts as satisfied only because it raises a signal. Drift marker: an overdue eligible harness with no launch and no recorded bound (budget / in-flight), or an open circuit with no raised producer-silence signal.\n3. R-16 BAR: drift marker in silence-threshold form (an active producer past its per-probe threshold with no signal). The su-ideate output-age exemption stays (D-007) because R-14 + this decision now cover dead passes.\nSupersedes the part of D-007 that said su-ideate is wholly out of producer-silence scope: output age stays out, dead passes are in.\nMeasured [self, 2026-10-08 18:14Z]: su-ideate-schedule.test.ts + producer-silence.test.ts 42/42 pass; lint:tsc --files over the 5 changed files status=clean (task 0muzuvasqo3c6ph1ij3). Plan R-14/R-16 rewritten at plan v23 (atomicity probe .papercusp/scratch/scout-rev3-atomic.mts: both PASS, prior wording failed on semicolons); rubric rev-3 approval posted thread-post:1165612, outside reviewer task 0muzv8juhf6oqli11ha.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-009"
        ],
        "affects": [],
        "lineNumber": 267
      },
      {
        "id": "D-011",
        "title": "Acceptance BAR amendment",
        "body": "Date: 2026-10-08\nAmendment-Id: amend-2dcea5e3cf4a0d6cbb32f124\nRequest-Hash: 7198970e5ad291df66b46ff381251b0829059f1b85bd42a38f9f37f6e2cb328b\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-010 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the outside-lineage objection thread-post:1165584. R-14 now binds the harness unit, the bounded oldest-last-pass-first rotation under the daily budget, and counts an open circuit only by its raised producer-silence:su-ideate-circuit signal (the circuit was a silent attempts-exhausted log before; code fixed). R-16 is restated in silence-threshold form, with exemptions in the method. R-10/R-11/R-15 checks point at the real test files. Every BAR is rebuilt from the live plan Requirements.\nApproved-By: system:judge/su-e9312792-7ab0-4c74-bbf0-c8eaca66d3c1\nApproval-Ref: thread-post:1165620\nApproved-At: 2026-10-08T18:30:41.593Z\nRubric revision: 2 → 3\nSubject plan revision: 24 → 25\nChanged BARs: R-10, R-11, R-14, R-15, R-16\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 278
      },
      {
        "id": "D-012",
        "title": "Rubric rev 4: bind live checks to live bars, cite authority on every bar, pin or drop R-20 (rubric-vetting on rev 3)",
        "body": "Date: 2026-10-08\nSource: rubric-vetting consult on rev 3 (conv-muzvi4mw-0000-d301a13fe0394a54beadb100424287c0, answering fork su-a3ef66c9 of su-36791514, 18:3xZ) [peer:consult]. Verdict: do not attest rev 3; revise once (rev 4) before attestation, because nothing is attested yet so a revision is free now and voids attestation + grading later.\nFindings: (1) plane/check mismatch: R-9, R-10, R-11, R-17, R-18, R-19, R-20 declare evidencePlane=live but bind only unit tests; R-13 is a 7-day live rate bound to a retry unit test. (2) 18 of 20 bars cite no authority; R-14's \"the D-015 verdict\" is a cross-plan reference. (3) R-20 \"success-metrics returns a passing verdict\" restates the verb and overlaps R-3/R-18.\nDecision [self, AUTO]: rev 4 fixes all three, under one constraint: the rev-2 outside reviewer (WI-10007390 thread-post:1164472) required every rev-1 live evidence plane to stay live, so a live bar is NOT downgraded to tree merely to make its check fit.\n1. R-10/R-11/R-18/R-19 (mechanisms with a live claim): keep plane=live with the declared runtime and bind a check the grader can run on that runtime (a probe/instrument check kind, or a named operator-DB/staging query in the method that the check references); the unit test stays as mechanism evidence. Only if no check kind can carry a live probe: relabel to tree and disclose in the amendment reason which live bar (R-9/R-17) carries the live claim.\n2. R-9: live check = the operator-DB count of ideation-class work-items (sourceRole Scout or ideaOrigin present, lane not observation) lacking payload.ideaDisposition, expected 0. R-17: live check = the owner-inbox row the weekly grading sample writes.\n3. R-13: live-only bar over a named 7-day scout_ticks error-rate query, plane live, runtime bg-host; R-12 keeps the retry mechanism.\n4. R-20: pin \"passing\" to the specific success-metrics criteria the verb applies, without re-stating R-3/R-18; drop it only if every criterion is already a separate bar, and say so in the reason.\n5. Every bar's method gains an \"Authority:\" line naming its D-NNN or plan section; R-14 cites su-ideate-learning-substrate-2026-07-10#D-015.\nThen: dry run, outside-lineage approval, apply rev 4, re-vet, attest with scorecards:emit against meta-acceptance-rubric, and only then request independent grading.",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 292
      },
      {
        "id": "D-013",
        "title": "Acceptance BAR amendment",
        "body": "Date: 2026-10-08\nAmendment-Id: amend-81a008058dd4bdb20ab1a511\nRequest-Hash: b6a6fe795b89e04976e26989a4b9f1edc2c9e56ef31d91426097bf74a3e08b18\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-012 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the rubric-vetting review of rev 3 (conv-muzvi4mw). (1) Every live bar now binds a check the grader runs on its declared runtime: R-17/R-18/R-20 bind read-only tool probes (coord:feed, blender:success-metrics); R-9/R-10/R-11/R-13/R-19 bind instruments whose methods name the exact operator-DB query, with the unit test kept as mechanism evidence. No live plane was downgraded to tree (rev-2 reviewer constraint, WI-10007390 thread-post:1164472). (2) R-13 is now live (runtime bg-host) over a named 7-day scout_ticks query; R-12 keeps the retry mechanism. (3) R-20 is pinned to the seven blender:success-metrics criteria it applies; none restates R-3 or R-18, and its cycle-error-rate judges the rubric window (48h) while R-13 judges 7 days, so R-20 is kept, not dropped. (4) Every bar method carries an Authority line naming its plan Phase/P-item and D-NNN; R-14 cites su-ideate-learning-substrate-2026-07-10#D-015. Every BAR is rebuilt from the live plan Requirements (plan v27, activation audit #5).\nApproved-By: su-292f4e0b-3cca-4719-bd5f-01f1f300f3a2\nApproval-Ref: thread-post:1165696\nApproved-At: 2026-10-08T19:09:55.180Z\nRubric revision: 3 → 4\nSubject plan revision: 27 → 28\nChanged BARs: R-9, R-10, R-11, R-13, R-14, R-17, R-18, R-19, R-20\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.",
        "date": "2026-10-08",
        "itemRefs": [],
        "affects": [],
        "lineNumber": 304
      },
      {
        "id": "D-014",
        "title": "Rubric rev 5: relative 7-day window for R-17, a live claim-lane read for R-10/R-11, split the R-14 circuit clause into R-21 (rubric-vetting on rev 4)",
        "body": "Date: 2026-10-08\nSource: rubric-vetting consult on rev 4, conv-muzx84kn (answer thread-post:1165723, su-4cdf95a3). It found 17 of 20 bars attest-ready and three checks that cannot prove their bar on the declared plane. Nothing is attested at rev 4, so all three fixes ship in ONE batched rev 5.\n\n1. R-17 (weekly grading sample). A ContinuityProbe passes literal tool args and coord:feed `since` takes only an absolute ISO timestamp, so the rev-4 probe (fixed since 2026-10-08) passes forever after one delivery: the opposite of the weekly property. R-17 now binds instrument operator-db:weekly-grading-sample-7d. Its method is an exact operator-DB query over harness_shared.coord_event_log with `ts > now() - interval '7 days'` (owner-addressed messages whose summary starts 'Weekly grading sample '), expecting >= 1. The count of all owner-addressed messages in the same window is the positive control (1151 at 19:30Z). Bar, falsifier and live plane (bg-host) are unchanged; weekly-grading-sample.test.ts stays mechanism evidence.\n\n2. R-10 / R-11 (claims exclude / target ideation). The rev-4 instrument proved only preconditions (build carries item_class; live data has both classes). It adds step (3), a live claim-lane read: scheduler:preview_spec_delta on the staging operator with spec filter { field:'item_class', op:'=', value:'work' } for R-10 and value 'ideation' for R-11. Pass needs three things. The predicatePartition has zero NULL rows. The R-10 lane's refused cell (d1=false) is > 0 and equals the R-11 lane's admitted cell (d1=true), so the two lanes split one pool into complementary classes. No listed proposed row of the R-10 lane is ideation-origin, and every listed proposed row of the R-11 lane is. Step (2) stays the positive control. Measured on :3170 at 19:31Z: ideation 373 / work 9347 and work 9351 / ideation 373, 0 NULL; 373 matches the SQL count of open, non-claim-held ideation items in papercusp. The claimable COUNT is not the evidence: today the agent-review and stop-the-line floors hold every papercusp change-kind item for every lane, so the ideation lane's claimable count is 0 whatever the filter does. The partition is the non-vacuous live read.\n\n3. R-14 clause (d), 'an open circuit raises producer-silence:su-ideate-circuit', moves to its own bar R-21 (authority P-007, P-009, D-010). A degraded rating can then name the clause that failed, and the overlap with R-16's signal mechanism is explicit. R-14 keeps launch within the rotation, oldest-last-pass-first order, and the recorded budget or in-flight deferral; an open circuit is the R-21 case. R-21 is tree-plane on producer-silence.test.ts (its su-ideate-circuit cases) and su-ideate-schedule.test.ts (circuit state).\n\nRecorded but not revised (reviewer marked them non-blocking): requiredTestLayers ['unit'] on live bars is a free-form label no lint branches on; R-12's method names a live read while its check runs the test; R-18 is a presence probe plus a mechanism test.\n\nRev 5 rebuilds every BAR from the live plan Requirements (21 bars) and needs outside-lineage approval before apply, then a fresh rubric-vetting consult before attestation.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-007",
          "P-009"
        ],
        "affects": [],
        "lineNumber": 318
      },
      {
        "id": "D-015",
        "title": "Acceptance BAR amendment",
        "body": "Date: 2026-10-08\nAmendment-Id: amend-bcbac4a6b7029108825567bd\nRequest-Hash: 602f4ed47fb9cf0f631add0b8fb3bb143449aecb0c0f90f54913b0fb92d3ba99\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-014 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the rubric-vetting review of rev 4 (conv-muzx84kn, thread-post:1165723), which found 17 of 20 bars attest-ready and three checks unable to prove their bar on the declared plane. (1) R-17: the fixed-since coord:feed probe passed forever after one delivery; it now binds instrument operator-db:weekly-grading-sample-7d, an exact operator-DB query with a relative seven-day window and a positive control. Bar, falsifier and live plane are unchanged. (2) R-10/R-11: the instruments add step (3), a live scheduler:preview_spec_delta claim-lane read on the staging operator (complementary predicate partition with zero NULL rows, plus listed-row classification); step (2) stays the positive control. (3) R-14 clause (d) (open circuit raises producer-silence:su-ideate-circuit) is split into new bar R-21 (tree, producer-silence.test.ts + su-ideate-schedule.test.ts, authority P-007/P-009/D-010), so a degraded rating names the failing clause. No live plane was downgraded to tree (rev-2 reviewer constraint, WI-10007390 thread-post:1164472). Every BAR is rebuilt from the live plan Requirements (plan v30, activation audit #6).\nApproved-By: su-8663c373-8ae6-4a13-9617-604850e81089\nApproval-Ref: thread-post:1165769\nApproved-At: 2026-10-08T19:45:42.389Z\nRubric revision: 4 → 5\nSubject plan revision: 30 → 31\nChanged BARs: R-14, R-17, R-21\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.",
        "date": "2026-10-08",
        "itemRefs": [
          "P-007",
          "P-009"
        ],
        "affects": [],
        "lineNumber": 332
      },
      {
        "id": "D-016",
        "title": "D-004 clarification: avoid wip promotion for existing ad-hoc lanes",
        "body": "Date: 2026-10-09\nMeasured 2026-10-09: plans:set-status P-005 wip created and claimed WI-10007695 even though WI-10007500 already owns the same implementation. work_items:get confirmed sourcePlanSlug/sourcePlanItemIds P-005; the duplicate was then dropped with WI-10007500 as its owned continuation. This extends the operational warning in D-004: do not use plans:start OR a wip status flip to register an already registered ad-hoc lane. Keep lane state on its existing work-item; update the plan item after its acceptance evidence is verified. No owner requirements, acceptance bars, or chosen self route change.",
        "date": "2026-10-09",
        "itemRefs": [
          "P-005"
        ],
        "affects": [],
        "lineNumber": 346
      }
    ],
    "missingRefs": [],
    "cycleMembers": [],
    "linkedFeatures": {},
    "planItemTests": {},
    "blockingIssues": {},
    "prose": "\n## Now\n\n**State:** ⚠ BAR READINESS BLOCKED (2026-10-09, after item-dropped): bar_snapshot_rubric_revision_mismatch, bar_snapshot_work_contract_missing, bar_snapshot_proof_missing, bar_snapshot_proof_inadequate, bar_snapshot_grading_missing, bar_snapshot_mapping_dropped_only, bar_snapshot_evidence_plane_unmet, bar_snapshot_clause_not_accepted, bar_snapshot_vetting_missing. Next repair: Before mutating BAR state, run dev:pipeline_position { path: \"packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts\", marker: \"synchronizeAcceptanceBarSubjectRevision\" } to distinguish a stale serving build from a live guard. If the synchronizer is not deployed, land/redeploy it first; otherwise re-seed or amend atomically so subject and rubric revision pins agree.. (re-evaluated in the same write by the scope-write cascade, P-030/P-031)\n\nDraft by su-703445b7 from owner directive #1560 [owner:Avi 2026-10-08]: \"Write a plan for filling the gaps and improving our su ideate and scout pipelines and then put yourself on auto mode and implement them yourself\". Route A (self), AUTO mode. Gym is paused per #1558 and out of scope. Evidence: reports rpt_d49be19f-a171-40a1-8666-cf49f49e59c6 (current) and rpt_263bd0ed (superseded); audit WI-10007368. Overlapping stale plans to reconcile in P-010: scout-idea-grading-2026-06-12 and su-ideate-learning-substrate-2026-07-10.\n\n**Next:** Vet the current acceptance-rubric criteria BEFORE binding proof or emitting adequacy cards (amend → vet → attest → bind → cards → grade): a vetting critique usually becomes an amendment, and proof bound first must then be re-bound.\n\n## Background\n- The outcome resolver leaves 340 scout ideas pending although their WIs are terminal (WI-10007390). 607 gym-rail ideas are pending by code.\n- Scout pays for generation, then dedups 87% and routes ~0 ($56.63 in 7d; WI-10007380). Dedup similarity overlaps true duplicates with distinct ideas (WI-35809).\n- Routed ideas are not claimed: 429 scout + 71 su-ideate improvement items unassigned since July. The idea backlog is 29-44% self-redundant (EI-19480163059215610). Claim-spec cannot target ideation items (EI-18697923246606437).\n- Scout cycle error rate is 8% (inference-gateway transport deaths); the host is stale (EI-18700942267136001).\n- su-ideate volume fell from 24-28/wk to 3/wk. It depends on ad-hoc IDEATE mode. ideate-pass-record fails with invalid_input (EI-24428150977170134).\n- No human grades since August; only 2/513 graded ideas were revised; agent-review is mixed into ideation metrics; lens weights are flat.\n- Producers have failed silently (Red Queen for 11 weeks, the pot switch for 11 days, the Gym idle) with no alarm.\n\n## Requirements\n\n**R-1 — Terminal outcomes resolve.**\n```requirement\n{\"intent\":{\"request\":\"Every routed scout and su-ideate idea whose work-item is terminal (done, closed, dropped, resolved) resolves won or lost, never pending.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007390\"]},\"acceptance\":{\"condition\":\"A routed idea whose work-item is in a terminal state (done, closed, dropped, resolved) carries outcome won or lost.\",\"falsifier\":\"A routed scout or su-ideate idea whose work-item reached done, closed, dropped or resolved more than one refresh interval ago still reads outcome pending.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"integration\",\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named tests; query routed-idea outcomes joined to work_items for terminal work-items (done, closed, dropped, resolved) still pending; expect none older than one refresh interval. Authority: plan Phase 1 (P-001).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/outcome-feedback.test.ts\",\"packages/operator-core/lib/scout/routed-ledger.test.ts\",\"packages/operator-core/lib/scout/routed-ledger.integration.test.ts\"]}}}\n```\n\n**R-2 — Paused-rail ideas are classified unresolvable.**\n```requirement\n{\"intent\":{\"request\":\"Ideas that can never resolve (routed to a paused rail such as the gym) are classified unresolvable.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007390\"]},\"acceptance\":{\"condition\":\"A routed idea on a paused rail carries outcome unresolvable.\",\"falsifier\":\"An idea routed to a paused rail reads outcome pending or won or lost instead of unresolvable.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; count ideas routed to a paused rail by outcome; expect every one unresolvable. Authority: plan Phase 1 (P-002).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/routed-ledger.test.ts\"]}}}\n```\n\n**R-3 — Paused-rail ideas leave the denominators.**\n```requirement\n{\"intent\":{\"request\":\"Ideas that can never resolve are excluded from win-rate denominators.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\"]},\"acceptance\":{\"condition\":\"Win-rate denominators in the success metrics exclude ideas routed to a paused rail.\",\"falsifier\":\"A gym-rail idea is counted in a win-rate denominator while the gym is paused.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; read blender:success-metrics denominators and confirm paused-rail ideas are absent. Authority: plan Phase 1 (P-002).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/success-metrics.test.ts\"]}}}\n```\n\n**R-4 — No paid generation under deep throttle.**\n```requirement\n{\"intent\":{\"request\":\"Scout skips or curbs paid generation when its output would predictably be unclaimed (deep admission throttle).\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007380\"]},\"acceptance\":{\"condition\":\"A scout cycle under a deep admission throttle spends no paid generation.\",\"falsifier\":\"A scout cycle that ran while the admission throttle was deep shows nonzero generation spend.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; inspect scout cycle records taken under a deep throttle for zero generation spend. Authority: plan Phase 2 (P-003).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/generation-preflight-guard.test.ts\"]}}}\n```\n\n**R-5 — No paid generation after a high dedup rate.**\n```requirement\n{\"intent\":{\"request\":\"Scout skips or curbs paid generation when its output would predictably be discarded (high recent dedup rate).\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007380\"]},\"acceptance\":{\"condition\":\"A scout cycle whose recent dedup rate exceeds the guard threshold spends no paid generation.\",\"falsifier\":\"A scout cycle that ran while the recent dedup rate exceeded the guard threshold shows nonzero generation spend.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; inspect scout cycle records taken while the recent dedup rate exceeded the threshold for zero generation spend; compare spend per routed idea before and after. Authority: plan Phase 2 (P-003).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/generation-preflight-guard.test.ts\"]}}}\n```\n\n**R-6 — A skipped or curbed cycle records why.**\n```requirement\n{\"intent\":{\"request\":\"A scout cycle that skips or curbs paid generation records why.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007380\"]},\"acceptance\":{\"condition\":\"A scout cycle that skips or curbs paid generation records the reason in its cycle record.\",\"falsifier\":\"A scout cycle record shows skipped or curbed generation with no recorded reason.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; inspect scout cycle records with skipped or curbed generation for a non-empty reason. Authority: plan Phase 2 (P-003).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/generation-preflight-guard.test.ts\"]}}}\n```\n\n**R-7 — Dedup keeps distinct same-domain ideas.**\n```requirement\n{\"intent\":{\"request\":\"Dedup no longer kills distinct same-domain ideas.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-35809\"]},\"acceptance\":{\"condition\":\"Two labeled-distinct ideas from the same domain both survive scout dedup.\",\"falsifier\":\"A labeled-distinct same-domain pair from the calibration sample is merged by scout dedup.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test against the labeled sample; compare merge decisions with the labels. Authority: plan Phase 2 (P-004), D-002, D-003.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/dedup-calibration.test.ts\"]}}}\n```\n\n**R-8 — Dedup still merges true duplicates.**\n```requirement\n{\"intent\":{\"request\":\"Dedup still merges true duplicates after recalibration.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-35809\"]},\"acceptance\":{\"condition\":\"A labeled true-duplicate pair from the calibration sample is merged by scout dedup.\",\"falsifier\":\"A labeled true-duplicate pair from the calibration sample survives scout dedup as two ideas.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test against the labeled sample; compare merge decisions for true-duplicate pairs with the labels. Authority: plan Phase 2 (P-004), D-002, D-003.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/dedup-calibration.test.ts\"]}}}\n```\n\n**R-9 — Every ideation backlog item has a disposition.**\n```requirement\n{\"intent\":{\"request\":\"The idea backlog is adjudicated: every item has a recorded disposition (keep, merge, drop).\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-19480163059215610\"]},\"acceptance\":{\"condition\":\"Every item in the ideation backlog carries a recorded disposition of keep, merge or drop.\",\"falsifier\":\"An ideation-origin work-item, open or not, has no recorded disposition after the adjudication pass.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"staging-operator\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (instrument operator-db:ideation-undispositioned-count) on the operator database: SELECT count(*) FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND lane IS DISTINCT FROM 'observation' AND (payload->>'sourceRole'='Scout' OR payload->>'ideaOrigin' IS NOT NULL) AND NOT (payload ? 'ideaDisposition'); expect 0 (positive control: the same query without the last predicate is non-zero). Mechanism evidence (does not replace the live count): packages/operator-core/lib/scout/ideation-backlog-adjudication.test.ts passes. Authority: plan Phase 3 (P-005), D-009, D-012.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"operator-db:ideation-undispositioned-count\"}}}\n```\n\n**R-10 — Claims can exclude ideation items.**\n```requirement\n{\"intent\":{\"request\":\"Agents can exclude ideation items when claiming.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-18697923246606437\"]},\"acceptance\":{\"condition\":\"A claim that excludes ideation items returns no ideation-origin work-item.\",\"falsifier\":\"A claim made with the ideation exclusion returns an ideation-origin work-item.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"staging-operator\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (instrument staging-operator:claim-spec-item-class-exclude) on the staging operator: (1) dev:pipeline_position { path: \\\"packages/operator-core/lib/scheduler/claim-spec.ts\\\", marker: \\\"item_class\\\", testClass: \\\"operator-api\\\" } shows the serving staging build contains the item_class field; (2) on the operator database, SELECT CASE WHEN payload->>'sourceRole' = 'Scout' OR payload->>'ideaOrigin' IS NOT NULL THEN 'ideation' ELSE 'work' END AS item_class, count(*) FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND status NOT IN ('done','dropped','resolved','closed') AND lane IS DISTINCT FROM 'observation' GROUP BY 1 (the exact FIELD_MAP.item_class expression) returns non-zero counts for BOTH 'ideation' and 'work', so a lane spec { field:'item_class', op:'=', value:'work' } has open ideation items to exclude on live data. (3) The live claim-lane read: scheduler:preview_spec_delta { cupId: <the grader's own owner id>, harness: \\\"papercusp\\\", limit: 200, proposed: { specVersion: \\\"1.0\\\", specId: \\\"item-class-work-probe\\\", revision: 1, view: { filter: { field: \\\"item_class\\\", op: \\\"=\\\", value: \\\"work\\\" } }, rank: { mode: \\\"lexicographic\\\", terms: [{ expr: \\\"age\\\", dir: \\\"desc\\\" }] } } } on the staging operator returns a predicatePartition with zero NULL rows whose refused cell (d1=false) is > 0 and equals the admitted cell (d1=true) of the R-11 ideation lane read, so the two lanes split one pool into complementary classes; and none of its listed proposed rows is ideation-origin by the FIELD_MAP.item_class expression (classify the listed ids with the step (2) CASE). Step (2) is the positive control. Measured on :3170 at 2026-10-08T19:31Z: item_class=ideation partition true 373 / false 9347 and item_class=work partition true 9351 / false 373, 0 NULL rows. The claimable COUNT is not the evidence: the agent-review and stop-the-line floors currently hold every papercusp change-kind item for every lane, so the ideation lane reads 0 claimable whatever the filter does. Mechanism evidence that the compiled filter excludes them: packages/operator-core/lib/scheduler/claim-spec-ideation-filter.test.ts passes. Authority: plan Phase 3 (P-005), D-012, D-014.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"staging-operator:claim-spec-item-class-exclude\"}}}\n```\n\n**R-11 — Claims can target ideation items.**\n```requirement\n{\"intent\":{\"request\":\"Agents can target (include) ideation items when claiming.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-18697923246606437\"]},\"acceptance\":{\"condition\":\"A claim that targets ideation items returns only ideation-origin work-items.\",\"falsifier\":\"A claim made with the ideation target returns a work-item that is not ideation-origin.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"staging-operator\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (instrument staging-operator:claim-spec-item-class-target) on the staging operator: (1) dev:pipeline_position { path: \\\"packages/operator-core/lib/scheduler/claim-spec.ts\\\", marker: \\\"item_class\\\", testClass: \\\"operator-api\\\" } shows the serving staging build contains the item_class field; (2) on the operator database, SELECT CASE WHEN payload->>'sourceRole' = 'Scout' OR payload->>'ideaOrigin' IS NOT NULL THEN 'ideation' ELSE 'work' END AS item_class, count(*) FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND status NOT IN ('done','dropped','resolved','closed') AND lane IS DISTINCT FROM 'observation' GROUP BY 1 (the exact FIELD_MAP.item_class expression) returns non-zero counts for BOTH 'ideation' and 'work', so a lane spec { field:'item_class', op:'=', value:'ideation' } has open ideation items to target and work items it must skip on live data. (3) The live claim-lane read: scheduler:preview_spec_delta { cupId: <the grader's own owner id>, harness: \\\"papercusp\\\", limit: 200, proposed: { specVersion: \\\"1.0\\\", specId: \\\"item-class-ideation-probe\\\", revision: 1, view: { filter: { field: \\\"item_class\\\", op: \\\"=\\\", value: \\\"ideation\\\" } }, rank: { mode: \\\"lexicographic\\\", terms: [{ expr: \\\"age\\\", dir: \\\"desc\\\" }] } } } on the staging operator returns a predicatePartition with zero NULL rows whose admitted cell (d1=true) is > 0 and equals the refused cell (d1=false) of the R-10 work lane read; and every listed proposed row is ideation-origin by the FIELD_MAP.item_class expression (classify the listed ids with the step (2) CASE). Step (2) is the positive control. Measured on :3170 at 2026-10-08T19:31Z: item_class=ideation partition true 373 / false 9347 and item_class=work partition true 9351 / false 373, 0 NULL rows. The claimable COUNT is not the evidence: the agent-review and stop-the-line floors currently hold every papercusp change-kind item for every lane, so the ideation lane reads 0 claimable whatever the filter does. Mechanism evidence that the compiled filter selects only ideation items: packages/operator-core/lib/scheduler/claim-spec-ideation-filter.test.ts passes. Authority: plan Phase 3 (P-005), D-012, D-014.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"staging-operator:claim-spec-item-class-target\"}}}\n```\n\n**R-12 — Transport deaths are retried or fall back.**\n```requirement\n{\"intent\":{\"request\":\"Inference-gateway transport deaths are retried or fall back.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-18700942267136001\"]},\"acceptance\":{\"condition\":\"A scout generation call that hits an inference-gateway transport death is retried or served by a fallback.\",\"falsifier\":\"A scout generation call that hit an inference-gateway transport death failed the cycle with no retry and no fallback attempt.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; inspect scout cycle errors over seven days for transport deaths that were neither retried nor served by a fallback. Authority: plan Phase 3 (P-006).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/inference-transport-retry.test.ts\"]}}}\n```\n\n**R-13 — Scout cycle errors under 5%.**\n```requirement\n{\"intent\":{\"request\":\"The scout cycle error rate over 7 days is under 5%.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-18700942267136001\"]},\"acceptance\":{\"condition\":\"The scout cycle error rate over seven days stays under five percent.\",\"falsifier\":\"The seven-day scout cycle error rate is five percent or higher.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\",\"evidenceRuntime\":\"bg-host\"},\"verification\":{\"method\":\"Live check (instrument operator-db:scout-ticks-7d-error-rate) over the scout tick ledger the bg-host scout loop writes: SELECT count(*) FILTER (WHERE status='error')::float / NULLIF(count(*) FILTER (WHERE status IN ('ran','error')), 0) FROM harness_shared.scout_ticks WHERE workspace_id='papercusp-workspace' AND tick_at > now() - interval '7 days'; expect < 0.05. Gated ticks are excluded from the denominator (no cycle ran). The retry mechanism is R-12's bar, not evidence for this one. Authority: plan Phase 3 (P-006), D-012.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"operator-db:scout-ticks-7d-error-rate\"}}}\n```\n\n**R-14 — su-ideate passes fire on a schedule.**\n```requirement\n{\"intent\":{\"request\":\"su-ideate passes fire on a schedule, for every pot with su-ideate enabled.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-24428150977170134\"]},\"acceptance\":{\"condition\":\"Every harness the su-ideate-learning-substrate-2026-07-10#D-015 verdict reads overdue, in a pot with learning on, and with a closed su-ideate attempt circuit, gets a su-ideate pass launched within a bounded rotation, oldest last pass first under the rolling-24h budget, unless a recorded budget or in-flight bound defers it.\",\"falsifier\":\"An overdue eligible harness with a closed su-ideate attempt circuit got no su-ideate launch and no recorded budget or in-flight bound.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; on the operator DB, read the su-ideate:schedule decisions and pass records per harness and confirm every overdue eligible harness with a closed circuit was launched within the rotation, oldest last pass first, or deferred by a recorded budget or in-flight bound. An open circuit is judged by R-21 (D-014). Authority: plan Phase 3 (P-007), su-ideate-learning-substrate-2026-07-10#D-015, D-005, D-006, D-014.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scout/su-ideate-schedule.test.ts\"]}}}\n```\n\n**R-15 — su-ideate passes record without invalid_input.**\n```requirement\n{\"intent\":{\"request\":\"Every scheduled su-ideate pass records its result without invalid_input.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-24428150977170134\"]},\"acceptance\":{\"condition\":\"A scheduled su-ideate pass records its result without an invalid_input refusal.\",\"falsifier\":\"A scheduled su-ideate pass record, in any pot, was refused with invalid_input.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; list scheduled su-ideate pass records across all pots and confirm none was refused with invalid_input. Authority: plan Phase 3 (P-007), D-005.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/agent-tools/scout/ideate-pass-record.test.ts\",\"packages/operator-core/lib/scout/su-ideate-schedule.test.ts\"]}}}\n```\n\n**R-16 — Producer-silence alarm.**\n```requirement\n{\"intent\":{\"request\":\"An alarm fires when any active learning producer emits nothing for N fires.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"WI-10007379\"]},\"acceptance\":{\"condition\":\"An active learning producer past its per-probe silence threshold raises a producer-silence signal.\",\"falsifier\":\"An active learning producer stayed past its per-probe silence threshold with no producer-silence signal raised.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named test; on the operator DB, run the producer-silence collector and confirm every active producer reads as producing or raises a signal, paused producers and su-ideate output age raise none (D-007), and read failures are reported unmeasured rather than silent (D-010). Authority: plan Phase 3 (P-009), D-007, D-010.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/improvements/producer-silence.test.ts\"]}}}\n```\n\n**R-17 — Weekly human grading sample.**\n```requirement\n{\"intent\":{\"request\":\"There is a weekly human grading sample in the owner inbox.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\"]},\"acceptance\":{\"condition\":\"A weekly grading sample of routed ideas reaches the owner inbox.\",\"falsifier\":\"No grading sample of routed ideas reached the owner inbox in the last seven days.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"bg-host\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (instrument operator-db:weekly-grading-sample-7d) on the operator database the bg-host weekly-grading-sample routine writes through: SELECT count(*) FILTER (WHERE body->>'summary' LIKE 'Weekly grading sample %') AS samples_7d, count(*) AS human_messages_7d FROM harness_shared.coord_event_log WHERE workspace_id='papercusp-workspace' AND body->>'kind'='message' AND body->'to' ? 'human' AND ts > now() - interval '7 days' returns samples_7d >= 1. human_messages_7d >= 1 is the positive control that the relation and predicates read owner-inbox messages (1151 at 2026-10-08T19:30Z). The window is relative to grading time, so the bar holds only while a sample reached the owner inbox in the trailing seven days. Mechanism evidence: packages/operator-core/lib/scout/weekly-grading-sample.test.ts passes. Authority: plan Phase 4 (P-008), D-012, D-014.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"operator-db:weekly-grading-sample-7d\"}}}\n```\n\n**R-18 — Agent-review reported separately.**\n```requirement\n{\"intent\":{\"request\":\"Agent-review is reported separately from ideation.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\"]},\"acceptance\":{\"condition\":\"The success metrics report agent-review outcomes in a bucket separate from ideation outcomes.\",\"falsifier\":\"blender:success-metrics counts an agent-review routed idea in the ideation win rate.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"staging-operator\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (probe) on the staging operator: blender:success-metrics { limit: 2000 } returns report.outcomes.agentReview, the bucket that holds origin agent-review rows apart from report.outcomes ideation tallies. Mechanism evidence that no agent-review row reaches the ideation win rate: packages/operator-core/lib/scout/success-metrics.test.ts passes. Authority: plan Phase 4 (P-008), D-012.\",\"check\":{\"kind\":\"probe\",\"probe\":{\"kind\":\"tool\",\"tool\":\"blender:success-metrics\",\"args\":{\"limit\":2000},\"schemaRevision\":\"live\",\"expect\":{\"path\":\"$.report.outcomes.agentReview\",\"op\":\"exists\"}}}}}\n```\n\n**R-19 — Lens weights use corrected outcomes.**\n```requirement\n{\"intent\":{\"request\":\"Lens weights use corrected outcomes.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\"]},\"acceptance\":{\"condition\":\"Scout lens weights are computed from the corrected routed-idea outcomes.\",\"falsifier\":\"A live scout lens weight is derived from an outcome row that the corrected resolver reads differently.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"bg-host\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (instrument operator-db:scout-lens-weights-corrected-provenance) on the operator database: (1) SELECT max(updated_at) FROM harness_shared.scout_lens_weights WHERE workspace_id='papercusp-workspace' is later than the corrected-outcome back-fill (P-001, 2026-10-08T15:17Z), so the live weights were recomputed after correction; (2) SELECT count(*) FROM harness_shared.scout_routed_ideas r JOIN harness_shared.work_items w ON r.routed_ref = 'wi:'||w.feature_id WHERE r.workspace_id='papercusp-workspace' AND r.origin IN ('scout','su-ideate') AND (r.outcome IS NULL OR r.outcome='pending') AND w.status IN ('done','dropped','resolved','closed'); expect 0 (the outcome rows the weights read agree with the corrected resolver on every terminal item; positive control: the same join without the outcome/status filters is non-zero). Mechanism evidence: packages/operator-core/lib/scout/lenses.test.ts passes (a recompute from the corrected outcomes reproduces the refresh-time weights). Authority: plan Phase 4 (P-008), D-012.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"operator-db:scout-lens-weights-corrected-provenance\"}}}\n```\n\n**R-20 — Success metrics pass.**\n```requirement\n{\"intent\":{\"request\":\"blender:success-metrics passes.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\"]},\"acceptance\":{\"condition\":\"blender:success-metrics returns verdict pass: all seven of its criteria (rubric-grounded-ideas, zero-signal-cycles, cycle-error-rate, ledger-reconciles, grader-feedback-revised, lens-diversity, fitness-signal-is-real) report status pass over its rubric-declared window.\",\"falsifier\":\"blender:success-metrics { limit: 2000 } returns a verdict other than pass, or any of its seven criteria reports fail or unknown.\",\"requiredScope\":[\"live\"],\"evidencePlane\":\"live\",\"evidenceRuntime\":\"staging-operator\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Live check (probe) on the staging operator: blender:success-metrics { limit: 2000 } (the limit keeps ledger-reconciles from reading a truncated ledger) returns report.verdict = \\\"pass\\\". None of the seven criteria restates R-3 or R-18; cycle-error-rate judges the rubric window (48h rolling), while R-13 judges seven days. Authority: plan Phase 4 (P-010), D-012.\",\"check\":{\"kind\":\"probe\",\"probe\":{\"kind\":\"tool\",\"tool\":\"blender:success-metrics\",\"args\":{\"limit\":2000},\"schemaRevision\":\"live\",\"expect\":{\"path\":\"$.report.verdict\",\"op\":\"eq\",\"value\":\"pass\"}}}}}\n```\n\n**R-21 — An open su-ideate circuit raises a producer-silence signal.**\n```requirement\n{\"intent\":{\"request\":\"An open su-ideate attempt circuit is a raised failure, never a silent exemption.\",\"sourceRefs\":[\"session_turn:claude:77911c5f-0f59-447b-a449-e15acf7cd05b:21\",\"EI-24428150977170134\"]},\"acceptance\":{\"condition\":\"Every harness whose su-ideate attempt circuit is open raises a producer-silence:su-ideate-circuit signal.\",\"falsifier\":\"A harness with an open su-ideate attempt circuit raised no producer-silence:su-ideate-circuit signal, or a failed circuit read was reported as a pass instead of unmeasured.\",\"requiredScope\":[\"tree\"],\"evidencePlane\":\"tree\",\"requiredTestLayers\":[\"unit\"],\"passRatings\":[\"healthy\"],\"mandatory\":true,\"role\":\"outcome\"},\"verification\":{\"method\":\"Run the named tests (producer-silence.test.ts covers the su-ideate-circuit cases: an open circuit raises a major signal scoped to its harness, closed circuits raise nothing but report coverage, a failed circuit read is unmeasured; su-ideate-schedule.test.ts covers the circuit state). On the operator DB, read the su-ideate:schedule circuit state per harness and the latest producer-silence collector tick, and confirm every open circuit has a raised producer-silence:su-ideate-circuit signal (D-010). Authority: plan Phase 3 (P-007, P-009), D-010, D-014.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/improvements/producer-silence.test.ts\",\"packages/operator-core/lib/scout/su-ideate-schedule.test.ts\"]}}}\n```\n\n## Design\nFix measurement first (Phase 1), because every other metric reads it. Then stop wasted spend (Phase 2), then consumption and producer health (Phase 3), then the grading loop and acceptance (Phase 4). Reuse the existing scout/outcome-feedback, routed-ledger, run.ts admission seam, the success-metrics rubric, and the routines/watchdog surfaces; no new parallel systems.\n\n### Bar-to-work map for this plan\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n| R-2 | P-002 | tree |\n| R-3 | P-002 | tree |\n| R-4 | P-003 | tree |\n| R-5 | P-003 | tree |\n| R-6 | P-003 | tree |\n| R-7 | P-004 | tree |\n| R-8 | P-004 | tree |\n| R-9 | P-005 | live |\n| R-10 | P-005 | live |\n| R-11 | P-005 | live |\n| R-12 | P-006 | tree |\n| R-13 | P-006 | live |\n| R-14 | P-007 | tree |\n| R-15 | P-007 | tree |\n| R-16 | P-009 | tree |\n| R-17 | P-008 | live |\n| R-18 | P-008 | live |\n| R-19 | P-008 | live |\n| R-20 | P-010 | live |\n| R-21 | P-007, P-009 | tree |\n\n## Phase 1 — Measurement truth\n- **P-001** `done` Fix the routed-idea outcome resolver so ideas on terminal WIs resolve won/lost (WI-10007390); back-fill outcomes; Vitest regression test. — note: Verified 2026-10-08T15:17Z via live census of harness_shared.scout_routed_ideas joined on 'wi:'||work_items.feature_id: production learning origins (scout 1048 pending, su-ideate 92 pending) have 0 ideas pending/NULL on a terminal work-item (was 340 per WI-10007390). Resolver fix outcomeOfWorkItemTag in packages/operator-core/lib/scout/outcome-feedback.ts (committed 501a4db123), regression tests in outcome-feedback.test.ts; WI-10007390 done (completionAuthority committed). Residual 876 NULL-on-terminal rows are origin agent-review (excluded from learning by design, countStalePendingIdeas WI-42483) - carried to P-008's agent-review/ideation split.\n- **P-002** `done` While the Gym is paused, stop routing scout ideas to the gym rail, classify the 607 permanently-pending gym-rail ideas unresolvable, and exclude them from win-rate denominators; test. — note: D-004: verified live via WI-10007478 (done, committed): 607 legacy gym rows pending -> unresolvable on live DB via production refreshScoutOutcomes; tests run 4e817bca 134/0.\n\n## Phase 2 — Generation efficiency\n- **P-003** `done` Pre-flight guard: skip or curb paid scout generation under deep admission throttle or a high recent dedup rate, and record the reason on the cycle record (WI-10007380); reuse dedup-burn-guard.ts; test. — note: D-004: verified live via WI-10007380 (done, committed): post-restart tick 22:11:50Z gated generation-preflight under deep throttle, 0 generated, no spend; pre-restart deep-throttle ticks paid $0.20-0.36 each.\n- **P-004** `done` Recalibrate scout dedup (WI-35809): measure on a labeled sample, then apply a two-stage or threshold fix so distinct same-domain ideas survive while true duplicates still merge; test. — note: D-004: dedup recalibration committed e447980feb, live in bg-host since 21:55:40Z; 43/43 calibration+reject-cause tests pass 23:05Z; live probe shows semanticLeg recorded with reason; completion audit seq 7. Ran-tick semanticLeg=ok read carried (scout gated by deep throttle).\n\n## Phase 3 — Consumption and producers\n- **P-005** `done` Routed-idea consumer: adjudicate the ~500-item idea backlog (EI-19480163059215610), and add a claim-spec field to target (include) or exclude ideation items (EI-18697923246606437); tests. — note: Author implementation/current-build verification complete on WI-10007500: active R9@3,R10@4,R11@4,SPEC-P005@1 diagnostic adequacy PASS. Canonical mutation guards20950870/20950900 paired with current baseline20/15 and preserved operational20950292. Final independent rubricrev5 certification and shipment remain P-010, not asserted by this item close. D-004/D-016 direct status route; no promotion.\n- **P-006** `done` Scout reliability: retry or fall back on inference-gateway transport deaths (target cycle error under 5%), plus a stale-host guard (EI-18700942267136001); tests. — note: D-004: transport retry + stale-host guard committed and live in bg-host since 21:55:40Z; tests 31/31; hostBuildSha verified on live ticks; 7d error rate 3.7%. A live retry occurrence (detail.transportRetries) is a carried check.\n- **P-007** `todo` su-ideate trigger: scheduled su-ideate passes for every pot with su-ideate enabled (not papercusp-only), and fix blender:ideate-pass-record invalid_input (EI-24428150977170134); tests.\n- **P-009** `done` Zero-output alarm for every active learning producer (covers the detector half of WI-10007379, the pot switch, and Red Queen); test. — note: D-004: verified live via WI-10007523 (done, committed): watchdog tick 22:10:55Z collector papercusp-producer-silence ok, 6 producer x pot checked, 1 signal.\n\n## Phase 4 — Grading and acceptance\n- **P-008** `done` Grading loop: weekly human grading sample into the owner inbox; separate agent-review from ideation in success-metrics; lens weights read corrected outcomes. — note: Verified live 23:40-23:47Z: R-17 samples_7d=1, R-18 agentReview bucket on :3170, R-19 weights recomputed after backfill with 0 terminal-pending. Audit seq 9. D-004.\n- **P-010** `todo` Acceptance: reconcile and supersede the overlapping stale plans, re-run blender:success-metrics to a pass, author and vet the acceptance rubric, get independent grading, ship.\n\n## Decisions\n\n### D-001 — Acceptance BAR amendment\nDate: 2026-10-08\nAmendment-Id: amend-6413b1f7625c3dffa5388296\nRequest-Hash: d99d8df704f6b2982fbd038bd2511283bd7a3fd5cd42007088d8ae83ab5024e7\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: Split rev-1 compound BARs into 20 atomic, independently falsifiable BARs per outside reviewer objection (WI-10007390 thread-post 1164472): every rev-1 clause keeps its own BAR and every rev-1 live evidence plane stays live with a declared runtime.\nApproved-By: system:judge/su-b1045d99-fbb5-42bc-9933-0689e3214096\nApproval-Ref: thread-post:1164768\nApproved-At: 2026-10-08T11:37:23.339Z\nRubric revision: 1 → 2\nSubject plan revision: 5 → 6\nChanged BARs: R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19, R-20\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\nRequirements re-rendered from the amended criterion: R-1\n\n### D-002 — P-004 design: two-stage dedup (recall shortlist + critic adjudication), no threshold change\nDate: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007481]\n\nMeasured (scout_cycle_stage_artifacts, 30 retained cycles / 65 scored ideas): corpus dedup merged 0 ideas (noveltyMatches empty on all 65); rejects were feasibility-only 35, LLM-novelty+feasibility 14, LLM-novelty-only 3, feasibility-zero 1. Stored gemma vectors: 109 of 405 scout nearest-neighbour pairs are at cosine >= 0.92 and only 18 of 405 are same-cycle, so restated ideas are routed as separate WIs across cycles. Manually read pairs in the 0.88-0.95 band mix true restatements (same problem, same mechanism) with same-problem/different-mechanism ideas: no cosine threshold separates them (confirms WI-35809).\n\nDecision: do NOT move matchFloor / semanticBaselineQuantile / noveltyFloor. Instead:\n1. Stage 1 (recall): corpusNovelty also returns the top-K (5) nearest priors by blended similarity regardless of matchFloor, above a low recall floor, so it works whether the semantic leg resolves or the matcher is lexical-only.\n2. Stage 2 (adjudication): the existing per-idea critic call (no new LLM spend) receives those priors WITH their text and returns duplicateOf: <ref|null>. Same mechanism for the same problem = duplicate; same problem, different mechanism = distinct.\n3. Deterministic merge rule: a duplicateOf naming a shortlisted ref merges the idea (verdict reject, reason duplicate-of:<ref>); an unshortlisted/hallucinated ref is ignored.\n4. ScoredIdea records the semantic-leg status so a silent fail-open is visible.\n5. ideasDeduped semantics are unchanged (P-003 reads it); duplicates get their own count in the tick detail. The ideasDeduped mislabel is tracked as a separate owned item.\n\nR-7/R-8 unit test (dedup-calibration.test.ts) uses labeled pairs with their real measured cosines as fixtures; the LLM adjudication quality is verified on a live tick, not claimed from the unit test.\n\n### D-003 — P-004 refinement: in the Scout critic, semantic similarity feeds the stage-1 shortlist, not the novelty ceiling; lexical recall floor 0.05\nDate: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007481; refines D-002, moves no threshold]\n\nMeasured, 11 manually labeled scout pairs (7 true restatements, 4 same-problem/different-mechanism), each idea's real gemma cosine distribution against 7,124 vector-bearing corpus entries (scout-routed WIs + plans). Scratch: .papercusp/scratch/p004/pair-backgrounds.{sql,json}.\n- Under the existing calibration (q0.9 baseline), calibrated similarity is 0.46-0.75 for true duplicates and 0.43-0.76 for distinct pairs: full overlap. If the semantic leg resolves, the deterministic ceiling would reject distinct pair #2 (stalled-claim watchdog, different mechanism; novelty 0.24 < 0.34) while catching only 2 of 7 true duplicates. The semantic ceiling errs in both directions.\n- Lexical: Jaccard of the critic query (title+body) against corpus idea titles is 0.05-0.15 even for true restatements, so matchFloor 0.5 is unreachable lexically (consistent with noveltyMatches empty on all 65 scored ideas). Top-5 lexical recall over the real 1,000-title idea corpus: 4 of 7 duplicates; semantic top-5 recall: 7 of 7 (selection-biased: each twin was picked as its idea's nearest neighbour). Containment ranks twins WORSE than Jaccard, so it is not used.\n\nDecision:\n1. critiqueIdea calls the novelty core with semanticLowersNovelty:false. Semantic similarity still ranks matches and the stage-1 shortlist (flagged semantic) and reaches the critic as evidence with the prior's text, but the deterministic novelty ceiling and alreadyTried derive from lexical similarity only. The stage-2 critic adjudicates duplicateOf. Other callers (su novelty pre-check, dream review) read matches and keep the P-017 default (true).\n2. recallFloor default is 0.05, not the 0.2 in the WI-10007481 checkpoint; shortlistSize 5 bounds the shortlist.\n3. Because lexical-only recall is 4 of 7, the semantic leg's availability is the bigger lever. Every ScoredIdea records semanticLeg (resolved/unavailable/skipped), and the leg's production fail-open is tracked on EI-25415789244685046 (inferred, unverified on bg-host).\n\n### D-004 — Execute via the existing ad-hoc work-items; do not run plans:start for this plan\nDate: 2026-10-08\n[self-imposed, su-703445b7, 2026-10-08] P-001..P-004 were implemented on ad-hoc work-items (WI-10007379, WI-10007478, WI-10007380, WI-10007481; plus WI-10007486 from P-004 measurement) while plans:start was blocked on the spec card. promotePlanItems is idempotent only for items it promoted itself (source_plan_item ids); these ad-hoc items have sourcePlanSlug null, so plans:start now would mint UNCLAIMED placeable duplicates of in-flight/finished items that fleet agents could claim and redo. Ruling: plan-item status is set directly with plans:set-status as each linked work-item verifies; plans:start is not used for this plan. Shipping still goes through plans:audit + the acceptance rubric.\n\n### D-005 — P-007 design: 'scheduled' = an hourly evaluation of the owner's D-015 observation-count verdict per pot; no calendar trigger\nDate: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007505]\n\nGoverning prior decision: su-ideate-learning-substrate-2026-07-10 D-015 [owner:avi 2026-07-10] \"OVERDUE is observation-count-keyed, never calendar-keyed ... NO day/hour trigger exists\". P-007 must not contradict it.\n\nGap measured: the D-015 overdue verdict (orient-ideate-hint.ts computeIdeateOverdue) is evaluated only inside coord:orient for a caller that already has IDEATE mode active, so a pass happens only when someone manually puts an su into IDEATE. Every su-ideate tick ever recorded is install 'papercusp' (211) except 2 on sb-devboard-hive.\n\nDesign:\n1. A workspace-singleton blueprint 'su-ideate' (triggers.schedule, singleton, seeded active; same shape as memory-live-recall-canary) runs op 'su-ideate:schedule' hourly. The hour is only the EVALUATION heartbeat, not a fire trigger.\n2. Per pot: eligible iff potLearningEnabled(pot) (the existing per-pot learning master switch, absent row = enabled). Verdict per pot = D-015 unchanged: lane:observation rows filed in that pot since that pot's last su-ideate pass >= SU_IDEATE_OBS_THRESHOLD (default 10), or that pot's su-ideate idea queue fully drained.\n3. Overdue pot -> launch ONE headless, independent su via capability:launch-agent (the grading-auditor door) with the ideation stack layer and a one-pass brief: ground (blender:ideation-feedback), run the next lens in rotation, file lens-tagged ideas, route broad ones, close with blender:ideate-pass-record { lens, ... } for that pot, end. Idempotency key = pot + last-pass timestamp, so a pass in flight is never doubled. At most one launch per tick workspace-wide (cost bound).\n4. The routine row's active flag is the kill switch (routines:set pause); no new flag.\n\nR-14 BAR wording (\"every schedule window contains a fired pass\") is stricter than D-015 allows; amend it in P-010 to \"every window in which the D-015 verdict read overdue for a pot contains a fired pass for that pot\".\n\n### D-006 — P-007 cost bound: rolling-24h launch budget, one pass in flight, attempt circuit, oldest-pass-first; unit = harness\nDate: 2026-10-08\nDate: 2026-10-08\n[self, 2026-10-08, from measurement on WI-10007505]\n\nRefines D-005 (does not change D-015).\n\nMeasured (engineer_issues, 3 days to 2026-10-08): organic lane:observation filings per harness: papercusp 26,775 (~9k/day), email 94, sb-devboard-hive 65, portal 31, phone-app 12, crm 10. With the D-015 threshold of 10, papercusp reads overdue on every hourly evaluation, so D-005's 'at most one launch per tick' alone permits ~24 launches/day, mostly redundant with the 37-57/week passes GOAL holders already record in papercusp.\n\nDecision (implemented in packages/operator-core/lib/scout/su-ideate-schedule.ts):\n1. Unit is the HARNESS (scout_ticks.install_slug, the issue scope harness:<slug>), gated by the learning switch of the pot it resolves to (resolveLearningPotSlug -> potLearningEnabled).\n2. Budget: at most PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY (default 6) scheduled launches per rolling 24h workspace-wide. This is a ceiling, never a trigger, so D-015 holds.\n3. One scheduled pass in flight workspace-wide: a launch blocks while its task is live, its harness has not recorded a pass since it started, and it is under 2h old.\n4. Circuit: 3 launches for a harness since its last pass without a recorded pass -> that harness is skipped until any pass records (by anyone).\n5. Order: never-passed harnesses first, then oldest last pass. Time only ORDERS overdue harnesses; it never makes one overdue.\n6. Launch door: capability:launch-agent handler under system actor system:su-ideate-schedule (the grading-audit pattern), headless + independent, stack ideation:su.mode-ideate, label = idempotency key su-ideate-pass:<harness>:<lastPass|never>:<attempt>. The launch door's idempotency claim lives 7 days, so the attempt number is part of the key; keying on harness+lastPass alone would block a harness for a week after one dead pass.\n7. The D-015 verdict is one function, ideateOverdueFromCounts (orient-ideate-hint.ts), shared by orient and the schedule.\n\n### D-007 — P-009 producer-silence alarm: scope is LEARNING_PRODUCERS; su-ideate is covered by its scheduler, not a time-based silence alarm\nDate: 2026-10-08\n[self-imposed, su-703445b7, 2026-10-08] P-009 ships as a sixth learning-SLO collector (packages/operator-core/lib/harness/improvements/producer-silence.ts, wired in learning-slo.ts producerSilenceCollector + watchdog.ts 'papercusp-producer-silence', flag papercusp-learning-slo-sensors). Its producer set is DERIVED from experiment/lifecycle-adapter.ts LEARNING_PRODUCERS (scout, gym, calibration, transfer, regret, red-queen) via a Record<LearningProducer, probe> map, so a new producer cannot compile without a probe. A producer is judged only when ACTIVE: governor loop enabled, pot learning switch on, and driving routine not explicitly active:false (gym-cycle@papercusp inactive per owner directive #1558 therefore exempts the Gym). su-ideate is deliberately OUT of this alarm: its passes are demand-driven by the D-015 overdue verdict (D-005/D-006), so a quiet pot correctly produces nothing and a time-based silence alarm would misfire; scheduler liveness is covered by the su-ideate:schedule routine (infra-liveness dead-routines) and its per-harness decision log. Governor loops no probe claims (dream:*, miners, fleet-ekg, prompt-ablation, replay-harness) are counted as unprobed in the tick note, never silently passed. Read failures make the collector throw so auto-close never reads an unmeasured tick as resolved.\n\n### D-008 — P-010 reconciliation: the two overlapping stale plans are superseded by this plan\nDate: 2026-10-08\nDecided 2026-10-08 [self, under owner directive #1560 AUTO route A]. scout-idea-grading-2026-06-12 (awaiting-acceptance since 2026-08-31, all 10 items terminal) and su-ideate-learning-substrate-2026-07-10 (ready since 2026-07-12, all 22 items terminal) were set to superseded with guarded transitions. Coverage mapping: owner grades steering lens weights -> P-008 (R-17 weekly owner grading sample, R-18 agent-review split, R-19 newest-scope lens weights); outcomes -> P-001; pacing -> P-007; file-time quality -> P-002/P-003/P-004. Their acceptance is graded on this plan's rubric; nothing from either plan is carried as an open item.\n\n### D-009 — R-9 ideation backlog adjudication: deterministic keep/merge/drop over dedup_edges cos>=0.90, retire merged/rejected open ideas\nDate: 2026-10-08\nEvery ideation-class work-item (ITEM_CLASS_SQL_TEXT, the R-10/R-11 definition) carries payload.ideaDisposition {disposition keep|merge|drop, basis, relatedTo?, cos?, version, adjudicatedAtMs, by}. Rules, oldest first: terminal done/resolved, or closed with completion evidence -> keep; dropped with 'duplicate of X' -> merge into X; other terminal -> drop; open with an older KEPT near-duplicate (harness_shared.dedup_edges cos>=0.90, the admission census duplicate floor; no new similarity) -> merge into the closest; open whose only older near-duplicates were dropped -> drop; else keep. A recorded disposition is never rewritten. Open merge/drop ideas are retired to 'dropped' via setWorkItemState with the promoter's 'duplicate of <id>' reason. Module scout/ideation-backlog-adjudication.ts; recurring bg-host step 'scout-ideation-backlog-adjudication' (<=100 closes per run; kill switch PAPERCUSP_SCOUT_IDEATION_ADJUDICATION=0). Live pass 2026-10-08 17:08Z: 1358 dispositions written (terminal 361 keep / 518 drop / 2 merge; open 389 keep / 75 merge / 13 drop), 88 open ideas retired via audited work_items:set_state; 0 ideation items lack a disposition. Spot-check 5/5 sampled merges were the same idea. Source: owner directive #1560 + EI-19480163059215610 (cluster-triage the backlog).\n\n### D-010 — R-14/R-16 BAR: an open su-ideate circuit is a raised failure, never a silent exemption\nDate: 2026-10-08\nSource: outside-lineage objection to the rev-2 BAR amendment (system:judge su-dbca9062, thread-post:1165584 on WI-10007529, 18:00Z) [peer:system:judge]. It approved R-10/R-11/R-15 as written and blocked R-14/R-16, correctly: the amendment's R-14 model excused any tick that records an open circuit, and in su-ideate-schedule.ts the circuit (SU_IDEATE_MAX_ATTEMPTS=3 scheduled launches with no recorded pass) was only logged as disposition 'attempts-exhausted' and raised nothing, so a harness whose passes always die satisfied R-14, and R-16's su-ideate exemption (D-007) left it caught by no BAR.\n\nDecision [self, AUTO]: fix the CODE, then tighten the bar, rather than defend the wording.\n1. Code: readSuIdeateOpenCircuits (su-ideate-schedule.ts) is the dead-pass census, sharing ONE attempts definition (suIdeateAttemptsSinceLastPass) with the scheduler. An open circuit = >= max attempts since the last pass, none live-and-fresh (younger than SU_IDEATE_PASS_STALE_MS), pot learning switch on. The P-009 producer-silence collector raises each open circuit as a major bug signal (key producer-silence:su-ideate-circuit:<harness>, findingClass learning-slo:producer-silence); a failed read is 'unmeasured' and the collector throws rather than report a quiet tick. Auto-close resolves it once a pass records.\n2. R-14 BAR (rev 3): unit is the HARNESS, gated by its pot's learning switch (D-006 §1). Every harness the D-015 verdict reads overdue is launched within a bounded rotation, oldest last pass first under the daily budget (D-006 §5; already implemented, su-ideate-schedule.ts sort). An open circuit counts as satisfied only because it raises a signal. Drift marker: an overdue eligible harness with no launch and no recorded bound (budget / in-flight), or an open circuit with no raised producer-silence signal.\n3. R-16 BAR: drift marker in silence-threshold form (an active producer past its per-probe threshold with no signal). The su-ideate output-age exemption stays (D-007) because R-14 + this decision now cover dead passes.\nSupersedes the part of D-007 that said su-ideate is wholly out of producer-silence scope: output age stays out, dead passes are in.\nMeasured [self, 2026-10-08 18:14Z]: su-ideate-schedule.test.ts + producer-silence.test.ts 42/42 pass; lint:tsc --files over the 5 changed files status=clean (task 0muzuvasqo3c6ph1ij3). Plan R-14/R-16 rewritten at plan v23 (atomicity probe .papercusp/scratch/scout-rev3-atomic.mts: both PASS, prior wording failed on semicolons); rubric rev-3 approval posted thread-post:1165612, outside reviewer task 0muzv8juhf6oqli11ha.\n\n### D-011 — Acceptance BAR amendment\nDate: 2026-10-08\nAmendment-Id: amend-2dcea5e3cf4a0d6cbb32f124\nRequest-Hash: 7198970e5ad291df66b46ff381251b0829059f1b85bd42a38f9f37f6e2cb328b\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-010 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the outside-lineage objection thread-post:1165584. R-14 now binds the harness unit, the bounded oldest-last-pass-first rotation under the daily budget, and counts an open circuit only by its raised producer-silence:su-ideate-circuit signal (the circuit was a silent attempts-exhausted log before; code fixed). R-16 is restated in silence-threshold form, with exemptions in the method. R-10/R-11/R-15 checks point at the real test files. Every BAR is rebuilt from the live plan Requirements.\nApproved-By: system:judge/su-e9312792-7ab0-4c74-bbf0-c8eaca66d3c1\nApproval-Ref: thread-post:1165620\nApproved-At: 2026-10-08T18:30:41.593Z\nRubric revision: 2 → 3\nSubject plan revision: 24 → 25\nChanged BARs: R-10, R-11, R-14, R-15, R-16\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\n\n### D-012 — Rubric rev 4: bind live checks to live bars, cite authority on every bar, pin or drop R-20 (rubric-vetting on rev 3)\nDate: 2026-10-08\nSource: rubric-vetting consult on rev 3 (conv-muzvi4mw-0000-d301a13fe0394a54beadb100424287c0, answering fork su-a3ef66c9 of su-36791514, 18:3xZ) [peer:consult]. Verdict: do not attest rev 3; revise once (rev 4) before attestation, because nothing is attested yet so a revision is free now and voids attestation + grading later.\nFindings: (1) plane/check mismatch: R-9, R-10, R-11, R-17, R-18, R-19, R-20 declare evidencePlane=live but bind only unit tests; R-13 is a 7-day live rate bound to a retry unit test. (2) 18 of 20 bars cite no authority; R-14's \"the D-015 verdict\" is a cross-plan reference. (3) R-20 \"success-metrics returns a passing verdict\" restates the verb and overlaps R-3/R-18.\nDecision [self, AUTO]: rev 4 fixes all three, under one constraint: the rev-2 outside reviewer (WI-10007390 thread-post:1164472) required every rev-1 live evidence plane to stay live, so a live bar is NOT downgraded to tree merely to make its check fit.\n1. R-10/R-11/R-18/R-19 (mechanisms with a live claim): keep plane=live with the declared runtime and bind a check the grader can run on that runtime (a probe/instrument check kind, or a named operator-DB/staging query in the method that the check references); the unit test stays as mechanism evidence. Only if no check kind can carry a live probe: relabel to tree and disclose in the amendment reason which live bar (R-9/R-17) carries the live claim.\n2. R-9: live check = the operator-DB count of ideation-class work-items (sourceRole Scout or ideaOrigin present, lane not observation) lacking payload.ideaDisposition, expected 0. R-17: live check = the owner-inbox row the weekly grading sample writes.\n3. R-13: live-only bar over a named 7-day scout_ticks error-rate query, plane live, runtime bg-host; R-12 keeps the retry mechanism.\n4. R-20: pin \"passing\" to the specific success-metrics criteria the verb applies, without re-stating R-3/R-18; drop it only if every criterion is already a separate bar, and say so in the reason.\n5. Every bar's method gains an \"Authority:\" line naming its D-NNN or plan section; R-14 cites su-ideate-learning-substrate-2026-07-10#D-015.\nThen: dry run, outside-lineage approval, apply rev 4, re-vet, attest with scorecards:emit against meta-acceptance-rubric, and only then request independent grading.\n\n### D-013 — Acceptance BAR amendment\nDate: 2026-10-08\nAmendment-Id: amend-81a008058dd4bdb20ab1a511\nRequest-Hash: b6a6fe795b89e04976e26989a4b9f1edc2c9e56ef31d91426097bf74a3e08b18\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-012 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the rubric-vetting review of rev 3 (conv-muzvi4mw). (1) Every live bar now binds a check the grader runs on its declared runtime: R-17/R-18/R-20 bind read-only tool probes (coord:feed, blender:success-metrics); R-9/R-10/R-11/R-13/R-19 bind instruments whose methods name the exact operator-DB query, with the unit test kept as mechanism evidence. No live plane was downgraded to tree (rev-2 reviewer constraint, WI-10007390 thread-post:1164472). (2) R-13 is now live (runtime bg-host) over a named 7-day scout_ticks query; R-12 keeps the retry mechanism. (3) R-20 is pinned to the seven blender:success-metrics criteria it applies; none restates R-3 or R-18, and its cycle-error-rate judges the rubric window (48h) while R-13 judges 7 days, so R-20 is kept, not dropped. (4) Every bar method carries an Authority line naming its plan Phase/P-item and D-NNN; R-14 cites su-ideate-learning-substrate-2026-07-10#D-015. Every BAR is rebuilt from the live plan Requirements (plan v27, activation audit #5).\nApproved-By: su-292f4e0b-3cca-4719-bd5f-01f1f300f3a2\nApproval-Ref: thread-post:1165696\nApproved-At: 2026-10-08T19:09:55.180Z\nRubric revision: 3 → 4\nSubject plan revision: 27 → 28\nChanged BARs: R-9, R-10, R-11, R-13, R-14, R-17, R-18, R-19, R-20\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\n\n### D-014 — Rubric rev 5: relative 7-day window for R-17, a live claim-lane read for R-10/R-11, split the R-14 circuit clause into R-21 (rubric-vetting on rev 4)\nDate: 2026-10-08\nSource: rubric-vetting consult on rev 4, conv-muzx84kn (answer thread-post:1165723, su-4cdf95a3). It found 17 of 20 bars attest-ready and three checks that cannot prove their bar on the declared plane. Nothing is attested at rev 4, so all three fixes ship in ONE batched rev 5.\n\n1. R-17 (weekly grading sample). A ContinuityProbe passes literal tool args and coord:feed `since` takes only an absolute ISO timestamp, so the rev-4 probe (fixed since 2026-10-08) passes forever after one delivery: the opposite of the weekly property. R-17 now binds instrument operator-db:weekly-grading-sample-7d. Its method is an exact operator-DB query over harness_shared.coord_event_log with `ts > now() - interval '7 days'` (owner-addressed messages whose summary starts 'Weekly grading sample '), expecting >= 1. The count of all owner-addressed messages in the same window is the positive control (1151 at 19:30Z). Bar, falsifier and live plane (bg-host) are unchanged; weekly-grading-sample.test.ts stays mechanism evidence.\n\n2. R-10 / R-11 (claims exclude / target ideation). The rev-4 instrument proved only preconditions (build carries item_class; live data has both classes). It adds step (3), a live claim-lane read: scheduler:preview_spec_delta on the staging operator with spec filter { field:'item_class', op:'=', value:'work' } for R-10 and value 'ideation' for R-11. Pass needs three things. The predicatePartition has zero NULL rows. The R-10 lane's refused cell (d1=false) is > 0 and equals the R-11 lane's admitted cell (d1=true), so the two lanes split one pool into complementary classes. No listed proposed row of the R-10 lane is ideation-origin, and every listed proposed row of the R-11 lane is. Step (2) stays the positive control. Measured on :3170 at 19:31Z: ideation 373 / work 9347 and work 9351 / ideation 373, 0 NULL; 373 matches the SQL count of open, non-claim-held ideation items in papercusp. The claimable COUNT is not the evidence: today the agent-review and stop-the-line floors hold every papercusp change-kind item for every lane, so the ideation lane's claimable count is 0 whatever the filter does. The partition is the non-vacuous live read.\n\n3. R-14 clause (d), 'an open circuit raises producer-silence:su-ideate-circuit', moves to its own bar R-21 (authority P-007, P-009, D-010). A degraded rating can then name the clause that failed, and the overlap with R-16's signal mechanism is explicit. R-14 keeps launch within the rotation, oldest-last-pass-first order, and the recorded budget or in-flight deferral; an open circuit is the R-21 case. R-21 is tree-plane on producer-silence.test.ts (its su-ideate-circuit cases) and su-ideate-schedule.test.ts (circuit state).\n\nRecorded but not revised (reviewer marked them non-blocking): requiredTestLayers ['unit'] on live bars is a free-form label no lint branches on; R-12's method names a live read while its check runs the test; R-18 is a presence probe plus a mechanism test.\n\nRev 5 rebuilds every BAR from the live plan Requirements (21 bars) and needs outside-lineage approval before apply, then a fresh rubric-vetting consult before attestation.\n\n### D-015 — Acceptance BAR amendment\nDate: 2026-10-08\nAmendment-Id: amend-bcbac4a6b7029108825567bd\nRequest-Hash: 602f4ed47fb9cf0f631add0b8fb3bb143449aecb0c0f90f54913b0fb92d3ba99\nActor: su-703445b7-64e6-476b-857c-38f44f8c85d1\nReason: D-014 (plan scout-su-ideate-pipeline-gaps-2026-10-08): answer the rubric-vetting review of rev 4 (conv-muzx84kn, thread-post:1165723), which found 17 of 20 bars attest-ready and three checks unable to prove their bar on the declared plane. (1) R-17: the fixed-since coord:feed probe passed forever after one delivery; it now binds instrument operator-db:weekly-grading-sample-7d, an exact operator-DB query with a relative seven-day window and a positive control. Bar, falsifier and live plane are unchanged. (2) R-10/R-11: the instruments add step (3), a live scheduler:preview_spec_delta claim-lane read on the staging operator (complementary predicate partition with zero NULL rows, plus listed-row classification); step (2) stays the positive control. (3) R-14 clause (d) (open circuit raises producer-silence:su-ideate-circuit) is split into new bar R-21 (tree, producer-silence.test.ts + su-ideate-schedule.test.ts, authority P-007/P-009/D-010), so a degraded rating names the failing clause. No live plane was downgraded to tree (rev-2 reviewer constraint, WI-10007390 thread-post:1164472). Every BAR is rebuilt from the live plan Requirements (plan v30, activation audit #6).\nApproved-By: su-8663c373-8ae6-4a13-9617-604850e81089\nApproval-Ref: thread-post:1165769\nApproved-At: 2026-10-08T19:45:42.389Z\nRubric revision: 4 → 5\nSubject plan revision: 30 → 31\nChanged BARs: R-14, R-17, R-21\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\n\n### D-016 — D-004 clarification: avoid wip promotion for existing ad-hoc lanes\nDate: 2026-10-09\nMeasured 2026-10-09: plans:set-status P-005 wip created and claimed WI-10007695 even though WI-10007500 already owns the same implementation. work_items:get confirmed sourcePlanSlug/sourcePlanItemIds P-005; the duplicate was then dropped with WI-10007500 as its owned continuation. This extends the operational warning in D-004: do not use plans:start OR a wip status flip to register an already registered ad-hoc lane. Keep lane state on its existing work-item; update the plan item after its acceptance evidence is verified. No owner requirements, acceptance bars, or chosen self route change.\n",
    "history": {
      "status": "available",
      "brief": {
        "schemaVersion": "prior-attempt-brief-v1",
        "fingerprint": "8bfe97de57c00c8386f14160df099bbc4438317079333085a8c9492849aa5e59",
        "authority": [],
        "residue": [],
        "attempts": [],
        "rawRefs": [],
        "protectedRefs": {
          "authority": [
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-14-P-007@5"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-17-P-008@4"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-21-P-007@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-21-P-009@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-10-P-005@4"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-11-P-005@4"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-13-P-006@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-18-P-008@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-19-P-008@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-20-P-010@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-9-P-005@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-15-P-007@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-16-P-009@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-003-B@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-003@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-8-P-004@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-7-P-004@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-6-P-003@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-5-P-003@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-4-P-003@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-3-P-002@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-2-P-002@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-12-P-006@2"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-1-P-001@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-1-P-002@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-2-P-003@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-2-P-004@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-3-P-005@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-4-P-006@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-4-P-007@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-4-P-009@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-5-P-008@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#AUTO-BAR-R-5-P-010@3"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-010@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-009@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-008@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-007@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-006@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-005@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-004@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-002-B@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-002@1"
            },
            {
              "authority": "current-spec",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#SPEC-P-001@1"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-001"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-002"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-003"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-004"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-005"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-006"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-007"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-008"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-009"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-010"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-011"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-012"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-013"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-014"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-015"
            },
            {
              "authority": "plan-decision",
              "rawRef": "scout-su-ideate-pipeline-gaps-2026-10-08#D-016"
            }
          ],
          "residue": [
            "WI-10007695#completion"
          ]
        },
        "omission": {
          "omittedRecords": 117,
          "omittedByAuthority": {
            "spec-revision": 57,
            "verified-completion": 1,
            "plan-decision": 16,
            "current-spec": 43
          },
          "omittedRefs": [],
          "omittedRefsTruncated": true,
          "sourceCount": 117,
          "deduplicatedCount": 0,
          "truncated": true
        },
        "estimatedTokens": 1562,
        "serializedChars": 6247,
        "status": "available",
        "target": {
          "kind": "plan",
          "ref": "scout-su-ideate-pipeline-gaps-2026-10-08",
          "harness": "papercusp"
        },
        "fanOut": {
          "admitted": 1,
          "total": 1,
          "cap": 24,
          "truncated": false
        },
        "degradedSources": [],
        "omittedDescendants": [],
        "omittedDescendantsTruncated": false
      },
      "recovery": {
        "tool": "plans:get",
        "args": {
          "slug": "scout-su-ideate-pipeline-gaps-2026-10-08",
          "harness": "papercusp",
          "heading": "History"
        }
      }
    }
  },
  "items": [
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-001",
        "text": "Fix the routed-idea outcome resolver so ideas on terminal WIs resolve won/lost (WI-10007390); back-fill outcomes; Vitest regression test. — note: Verified 2026-10-08T15:17Z via live census of harness_shared.scout_routed_ideas joined on 'wi:'||work_items.feature_id: production learning origins (scout 1048 pending, su-ideate 92 pending) have 0 ideas pending/NULL on a terminal work-item (was 340 per WI-10007390). Resolver fix outcomeOfWorkItemTag in packages/operator-core/lib/scout/outcome-feedback.ts (committed 501a4db123), regression tests in outcome-feedback.test.ts; WI-10007390 done (completionAuthority committed). Residual 876 NULL-on-terminal rows are origin agent-review (excluded from learning by design, countStalePendingIdeas WI-42483) - carried to P-008's agent-review/ideation split.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 1 — Measurement truth",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "WI-10007390",
          "state": "done",
          "terminal": true
        },
        {
          "ref": "WI-42483",
          "state": "done",
          "terminal": true
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-002",
        "text": "While the Gym is paused, stop routing scout ideas to the gym rail, classify the 607 permanently-pending gym-rail ideas unresolvable, and exclude them from win-rate denominators; test. — note: D-004: verified live via WI-10007478 (done, committed): 607 legacy gym rows pending -> unresolvable on live DB via production refreshScoutOutcomes; tests run 4e817bca 134/0.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 1 — Measurement truth",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "WI-10007478",
          "state": "done",
          "terminal": true
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-003",
        "text": "Pre-flight guard: skip or curb paid scout generation under deep admission throttle or a high recent dedup rate, and record the reason on the cycle record (WI-10007380); reuse dedup-burn-guard.ts; test. — note: D-004: verified live via WI-10007380 (done, committed): post-restart tick 22:11:50Z gated generation-preflight under deep throttle, 0 generated, no spend; pre-restart deep-throttle ticks paid $0.20-0.36 each.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 2 — Generation efficiency",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "WI-10007380",
          "state": "done",
          "terminal": true
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-004",
        "text": "Recalibrate scout dedup (WI-35809): measure on a labeled sample, then apply a two-stage or threshold fix so distinct same-domain ideas survive while true duplicates still merge; test. — note: D-004: dedup recalibration committed e447980feb, live in bg-host since 21:55:40Z; 43/43 calibration+reject-cause tests pass 23:05Z; live probe shows semanticLeg recorded with reason; completion audit seq 7. Ran-tick semanticLeg=ok read carried (scout gated by deep throttle).",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 2 — Generation efficiency",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "WI-35809",
          "state": "needs-human",
          "terminal": false
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-005",
        "text": "Routed-idea consumer: adjudicate the ~500-item idea backlog (EI-19480163059215610), and add a claim-spec field to target (include) or exclude ideation items (EI-18697923246606437); tests. — note: Author implementation/current-build verification complete on WI-10007500: active R9@3,R10@4,R11@4,SPEC-P005@1 diagnostic adequacy PASS. Canonical mutation guards20950870/20950900 paired with current baseline20/15 and preserved operational20950292. Final independent rubricrev5 certification and shipment remain P-010, not asserted by this item close. D-004/D-016 direct status route; no promotion.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "coverage": {
        "level": "complete",
        "links": [
          {
            "id": "WI-10007695",
            "rel": "plan_item_stamp",
            "activity": "free",
            "terminal": true
          }
        ]
      },
      "citedWorkItems": [
        {
          "ref": "EI-19480163059215610",
          "state": "needs-human",
          "terminal": false
        },
        {
          "ref": "EI-18697923246606437",
          "state": "open",
          "terminal": false
        },
        {
          "ref": "WI-10007500",
          "state": "done",
          "terminal": true
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-006",
        "text": "Scout reliability: retry or fall back on inference-gateway transport deaths (target cycle error under 5%), plus a stale-host guard (EI-18700942267136001); tests. — note: D-004: transport retry + stale-host guard committed and live in bg-host since 21:55:40Z; tests 31/31; hostBuildSha verified on live ticks; 7d error rate 3.7%. A live retry occurrence (detail.transportRetries) is a carried check.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "EI-18700942267136001",
          "state": "open",
          "terminal": false
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-007",
        "text": "su-ideate trigger: scheduled su-ideate passes for every pot with su-ideate enabled (not papercusp-only), and fix blender:ideate-pass-record invalid_input (EI-24428150977170134); tests.",
        "storedStatus": "todo",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "todo",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "EI-24428150977170134",
          "state": "open",
          "terminal": false
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-009",
        "text": "Zero-output alarm for every active learning producer (covers the detector half of WI-10007379, the pot switch, and Red Queen); test. — note: D-004: verified live via WI-10007523 (done, committed): watchdog tick 22:10:55Z collector papercusp-producer-silence ok, 6 producer x pot checked, 1 signal.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 3 — Consumption and producers",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      },
      "citedWorkItems": [
        {
          "ref": "WI-10007379",
          "state": "dropped",
          "terminal": true
        },
        {
          "ref": "WI-10007523",
          "state": "done",
          "terminal": true
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-008",
        "text": "Grading loop: weekly human grading sample into the owner inbox; separate agent-review from ideation in success-metrics; lens weights read corrected outcomes. — note: Verified live 23:40-23:47Z: R-17 samples_7d=1, R-18 agentReview bucket on :3170, R-19 weights recomputed after backfill with 0 terminal-pending. Audit seq 9. D-004.",
        "storedStatus": "done",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 4 — Grading and acceptance",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "done",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      }
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "archived": false,
      "item": {
        "id": "P-010",
        "text": "Acceptance: reconcile and supersede the overlapping stale plans, re-run blender:success-metrics to a pass, author and vet the acceptance rubric, get independent grading, ship.",
        "storedStatus": "todo",
        "importance": "normal",
        "blockedBy": [],
        "decisionRefs": [],
        "phase": "Phase 4 — Grading and acceptance",
        "lineNumber": 0,
        "rawLine": "",
        "effectiveStatus": "todo",
        "unresolvedBlockers": [],
        "needsHuman": false,
        "staleBlockedHint": null
      }
    }
  ]
}
