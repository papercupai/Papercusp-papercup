---
rel_path: "verification/WI-10005786/2026-10-17-scoped-coverage-final.json"
updated_at: 1792259735980
_body: "content"
---

{
  "measuredAt": "2026-10-17T17:55:35.917Z",
  "sourceOwnerArchive": "verification/WI-10005786/2026-10-17-program-owners-and-remaining.json",
  "ownerArchiveReadbackComplete": true,
  "coverage": {
    "keywordCandidates": 59,
    "explicitPortfolio": 16,
    "additionalRelevantPlan": 1,
    "recurringInstances": 16,
    "terminalHistoryOutsideOriginal": 25,
    "archivedHistoryOutsideOriginal": 1
  },
  "plans": [
    {
      "slug": "blender-evidence-driven-learning-redesign-2026-09-04",
      "status": "ready",
      "archived": false,
      "version": 38,
      "states": {
        "done": 11,
        "todo": 1
      }
    },
    {
      "slug": "blender-public-release-readiness-drive-2026-07-14",
      "status": "awaiting-acceptance",
      "archived": true,
      "version": 23,
      "states": {
        "done": 8
      }
    },
    {
      "slug": "blender-self-learning-2026-07-12",
      "status": "draft",
      "archived": true,
      "version": 143,
      "states": {
        "done": 15
      }
    },
    {
      "slug": "federated-scout-gym-learning-2026-07-02",
      "status": "draft",
      "archived": true,
      "version": 65,
      "states": {
        "done": 16
      }
    },
    {
      "slug": "gym-real-fitness-signal-2026-07-27",
      "status": "ready",
      "archived": false,
      "version": 49,
      "states": {
        "done": 7,
        "blocked": 5,
        "todo": 1
      }
    },
    {
      "slug": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
      "status": "awaiting-acceptance",
      "archived": true,
      "version": 24,
      "states": {
        "done": 10
      }
    },
    {
      "slug": "gym-unwedge-scout-novelty-2026-07-02",
      "status": "draft",
      "archived": true,
      "version": 24,
      "states": {
        "done": 5
      }
    },
    {
      "slug": "rem-dream-recombination-2026-08-17",
      "status": "ready",
      "archived": false,
      "version": 142,
      "states": {
        "done": 21,
        "needs-human": 3
      }
    },
    {
      "slug": "scorecard-blender-pipeline-fixes-2026-07-11",
      "status": "draft",
      "archived": true,
      "version": 65,
      "states": {
        "done": 1
      }
    },
    {
      "slug": "scout-idea-grading-2026-06-12",
      "status": "superseded",
      "archived": false,
      "version": 24,
      "states": {
        "done": 10
      }
    },
    {
      "slug": "scout-test-hardening-2026-06-22",
      "status": "superseded",
      "archived": false,
      "version": 10,
      "states": {}
    },
    {
      "slug": "scout-timeout-hierarchy-2026-07-13",
      "status": "draft",
      "archived": true,
      "version": 26,
      "states": {
        "done": 3
      }
    },
    {
      "slug": "self-learning-public-release-readiness-2026-07-26",
      "status": "superseded",
      "archived": false,
      "version": 40,
      "states": {
        "done": 10,
        "wip": 1,
        "needs-human": 1
      }
    },
    {
      "slug": "dream-performance-grading-papercusp-2026-10-07",
      "status": "draft",
      "archived": false,
      "version": 23,
      "states": {
        "todo": 2,
        "blocked": 1
      }
    },
    {
      "slug": "self-learning-dreaming-verified-shipment-2026-10-03",
      "status": "draft",
      "archived": false,
      "version": 11,
      "states": {
        "todo": 3,
        "blocked": 1
      }
    },
    {
      "slug": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "status": "ready",
      "archived": false,
      "version": 117,
      "states": {
        "done": 30,
        "blocked": 2,
        "todo": 5,
        "dropped": 5
      }
    },
    {
      "slug": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "status": "draft",
      "archived": false,
      "version": 43,
      "states": {
        "done": 8,
        "todo": 2
      }
    }
  ],
  "remaining": [
    {
      "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
      "item": "P-012",
      "status": "todo",
      "needsHuman": false,
      "text": "Re-run the Blender release rubric and both provenance-isolated drills against a current generation after the owner lifts the pause; require complete scorecards, independent criterion review, freshness, and a reproducible rollback before public release. `` `` — note: D-008: later owner directive1111 lifts blanket papercusp learning pause while preserving IQ-battery/improvement-implement exceptions. Final acceptance blocked by owned producer-integration gap EI-24932377195872399 plus unproven generation parity/fresh rubric+drill evidence; not shipped.",
      "links": [
        {
          "id": "WI-2144607",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-004",
      "status": "blocked",
      "needsHuman": false,
      "text": "Arm `LEARNING_GYM_TARGETS`: enable the implement-worker row with an explicit budget via the gym control plane (the owner act the seed file has been waiting for), confirm the `PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS` prerequisite is configured, and verify one cycle judged on `drillResolveRate` / `drillMttsh` / `regressionsFromTests` end-to-end.  — note: PREMISE CORRECTED by the P-012 audit's first live run: implement-worker is not 'seeded dark', it is UNREGISTERED — there is NO gym_autoloop_config row to enable, because PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS is NOT SET and seed-learning-gym-targets.ts skips registration when that prerequisite is missing ('registration never invents a harness slug'). Correct sequence is now: (1) OWNER/config decision — which harness runs auto-implement (PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS); (2) run the seed to create the row; (3) THEN arm it with a budget. Blocked on (1): choosing the runner harness is a topology decision, not an agent call",
      "links": [
        {
          "id": "WI-6289",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-005",
      "status": "blocked",
      "needsHuman": false,
      "text": "Wire drill ground truth as the judge: the implement-worker's fitness is planted-drill resolve rate + mean planted→resolved time + repo-test regressions, NOT an LLM composite. Assert the judge reads persisted drill outcomes rather than model opinion.",
      "links": [
        {
          "id": "WI-6290",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-007",
      "status": "todo",
      "needsHuman": false,
      "text": "Design the idea-fitness loop and PRESENT IT BEFORE BUILDING (design-shaped work per standing feedback): ideation output → the `cheapExperiment` already captured on each idea (hypothesis / method / falsifiableSignal) → execute that experiment in a sandbox → score worthiness → feed the score back as the revision signal that wakes the originator. Must name what \"worthiness\" is measured in, what a falsified idea costs, and the per-idea spend ceiling.  — note: ← WI-6292 released",
      "links": [
        {
          "id": "WI-6292",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-008",
      "status": "blocked",
      "needsHuman": false,
      "text": "Implement idea-fitness execution: run an idea's cheapExperiment as a real bounded job, persist {ideaId, hypothesis, signal, verdict, cost}, and route the verdict into the existing grade→revision→wake path so a falsified idea gets revised instead of silently graded.",
      "links": [
        {
          "id": "WI-6293",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-009",
      "status": "blocked",
      "needsHuman": false,
      "text": "Fix intake starvation: triage routes ~0.6% of ideas to the gym and nothing in 10 days. Instrument why (classifier bias / missing route / unattractive lane), then make idea→gym the DEFAULT for anything cheaply testable rather than an exception.  — note: FIRST HALF DONE (root cause found, see D-005): 'gym' is UNREACHABLE from triageIdea() — 5 branches, returns only place|gate; process-prompt (the self-described \"gym-A/B-able class\") returns gate. Only paths in are a manual Queen override or recurrence-escalation (which also requires the signature to have RECURRED). Not classifier bias — a missing edge. SECOND HALF BLOCKED behind P-007/P-008 per D-005: routing more ideas in today feeds a benchmark P-011 correctly marks RED, yields hint-text not measurement, and would strip the human gate off the compounding class.",
      "links": [
        {
          "id": "WI-6294",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "gym-real-fitness-signal-2026-07-27",
      "item": "P-010",
      "status": "blocked",
      "needsHuman": false,
      "text": "Close the loop back to ideation: an idea that survives its experiment becomes a ranked, evidence-carrying placement candidate; one that fails carries its falsification so the same idea is not re-proposed.",
      "links": [
        {
          "id": "WI-6295",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "rem-dream-recombination-2026-08-17",
      "item": "P-023",
      "status": "needs-human",
      "needsHuman": true,
      "text": "Run a small calibrated comparable-input/spend evaluation through existing Dream/Blender/experiment mechanisms; retain immutable prior study, human review gate, attributed model/reviewer/maintenance costs, source and outcome evidence. Aim for one grounded proposal and measured beneficial experiment; explicitly inconclusive if benefit is not demonstrated.  — note: Independent human blind-v2 calibration prerequisite is not met; source D023/calibration-status.md retain this contract. See WI-10003381 checkpoint; leader routing actual reviewer.",
      "links": [
        {
          "id": "WI-10003381",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "rem-dream-recombination-2026-08-17",
      "item": "P-024",
      "status": "needs-human",
      "needsHuman": true,
      "text": "Verify native Start/Pause/resume/history/Analyze journeys on current build, complete item audits and independent acceptance, and confirm green-main deployment before claiming shipped. Human labels and scientific benefit must never be self-certified.  — note: Agent-doable legs verified 2026-10-02T04:53Z by su-5930d3f6: no Dream source change since native evidence commit 36e3f8e6e (run20350343, bindings 17936/17937/17938 stand); Dream cycle+panel inMain/deployed/live (dev:pipeline_position). Remaining legs need an independent reviewer or human and must not be self-certified: blind calibration/scientific acceptance, P-008 labels, P-023, BAR vetting. Owner ask conv-mup3a7ee-0000-7e5a0e27e4974a38b69888d0ddfc9bd2 still open. Route unchanged per D-023/D-025.",
      "links": [
        {
          "id": "WI-10003382",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "rem-dream-recombination-2026-08-17",
      "item": "P-008",
      "status": "needs-human",
      "needsHuman": true,
      "text": "Execute the pre-registered matched-spend comparison and bounded downstream experiment sample in the Evaluation protocol after separate implementation approval and budget confirmation. Compare ordinary Blender, uniform pairs, structural pairs and role-labeled triples; report full cost, unique verified useful proposals, confidence/coverage, actual outcomes and sample exclusions. The exploratory 200-attempt/USD20 discovery ceiling is not a statistical power claim or approval to spend. Acceptance: reproducible evidence report plus a keep/simplify/expand/stop or explicitly inconclusive disposition; no closure from acceptance rate alone. Final shipment follows current ownership/frozen-candidate release rules, not the old historical candidates.  — note: Awaiting the existing independent human/domain calibration reviewer or six blind-v2 judgments at conv-mttzunb3-0000-bb2e27dc90544bb1bcdd9bc787f16e70; no paid calls before calibration. This reflects the existing checkpoint/protocol blocker, not a new requirement.",
      "links": [
        {
          "id": "WI-40148",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "self-learning-public-release-readiness-2026-07-26",
      "item": "P-006",
      "status": "wip",
      "needsHuman": false,
      "text": "Re-certify on the blender-release-readiness rubric: loop wakes emit scorecards (improvements:capture, deterministic evidence — pg counters, tick economics, freshness) and watch rubrics:trend; surface worsening trends unprompted. — note: scorecard #4 @10:08Z (EI-18701239814129379): 6/7 PASS — both drills zero-failure (rubric-seeding + capacity-storm), provenance isolation proven; sole open was generation-parity — RESOLVED in scorecard #5 @19:41Z (EI-18737293363319632): 7/7 PASS, score 10/10; parity now proven by the scoutCodeHash code-identity instrument (b01b01128a38273c on all ticks across host restarts — dev-box staleHost sha-misalignment explicitly superseded as parity evidence). Standing cert continues: scorecard #6 certifies the 21:22:36Z bg-host generation once its post-restart window reaches n≥9 ticks (@23:37Z it is n=5/incomplete; union soak n=18 clean).",
      "links": [
        {
          "id": "WI-5894",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "self-learning-public-release-readiness-2026-07-26",
      "item": "P-010",
      "status": "needs-human",
      "needsHuman": true,
      "text": "Docs: refresh /internal/docs self-learning overview to the pot-scoped reality; draft the public-facing feature description for owner review. — note: both deliverables done 07-26 ~05:25Z: (1) /internal/docs self-learning overview AUTHORED — apps/operator-docs/src/content/docs/system/self-learning.mdx (no overview existed; new page covers 3 modes + pot-scope invariant + governor/arming + grading rails, drift-anchored; scout-loop.mdx dangling link fixed); (2) public-facing feature description DRAFTED in this plan (section above Decisions). Awaiting owner review of the draft copy.",
      "links": []
    },
    {
      "plan": "dream-performance-grading-papercusp-2026-10-07",
      "item": "P-001",
      "status": "todo",
      "needsHuman": false,
      "text": "Verify papercusp-only effective Dream enablement and close the owned enablement repair with guard evidence; reuse WI-10007335.",
      "links": [
        {
          "id": "WI-6554700010014250",
          "activity": "stalled",
          "terminal": false
        }
      ]
    },
    {
      "plan": "dream-performance-grading-papercusp-2026-10-07",
      "item": "P-002",
      "status": "todo",
      "needsHuman": false,
      "text": "Create and independently ratify the missing recurring Dream performance rubric, reusing existing outcome semantics and instruments.",
      "links": [
        {
          "id": "WI-6554700010014271",
          "activity": "stalled",
          "terminal": false
        }
      ]
    },
    {
      "plan": "dream-performance-grading-papercusp-2026-10-07",
      "item": "P-003",
      "status": "blocked",
      "needsHuman": false,
      "text": "Emit the initial scorecard and run bounded grade-and-correct iterations with source/version/usage evidence.  — note: ← WI-6554700010016592 blocked (1 external blocker)",
      "links": [
        {
          "id": "WI-6554700010016592",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
      "item": "P-001",
      "status": "todo",
      "needsHuman": false,
      "text": "Publish WI-10005786 evidence-backed audit verdict; complete the scoped program lifecycle, remaining acceptance work, governing decision and current owner census. Exclude rubric templates from delivery totals and preserve historical/recurring meaning.",
      "links": []
    },
    {
      "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
      "item": "P-002",
      "status": "todo",
      "needsHuman": false,
      "text": "Resolve confirmed production efficacy gaps under existing ledgers and controls: starvation-proof Scout capped-lens rotation, effective Dream/Gym activation against approved owner direction, feedback/outcome and resilience/retention defects. Register individual fixes and conventional recurrence tests; coordinate existing owned issues.",
      "links": []
    },
    {
      "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
      "item": "P-003",
      "status": "todo",
      "needsHuman": false,
      "text": "Drive remaining existing self-learning, Blender, Gym and Dream plan items through their governing decisions and original acceptance bars. Coordinate live owners rather than duplicating claims; execute independent steps without waiting on final promotion.",
      "links": []
    },
    {
      "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
      "item": "P-004",
      "status": "blocked",
      "needsHuman": false,
      "text": "Verify final program acceptance and exact promoted/deployed artifact shipment, with accountable residue and correct historical/superseded/recurring dispositions. Do not mark live deliverables shipped from source tests or intent alone.",
      "links": []
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-026",
      "status": "blocked",
      "needsHuman": false,
      "text": "Execute the preregistered multilingual and agent-journey acceptance matrix against the actual exposed native tools. Verify matched correctness, false empties, stale-source handling, memory/disk/query cost, cache invalidation, source exclusions, interface/test/documentation/evidence workflows and isolation. Bind source/spec/test fingerprints in the project's normal suites and independent acceptance process; disclose all untested language/intent cells.   — note: ← WI-10007889 released",
      "links": [
        {
          "id": "WI-10007889",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-027",
      "status": "blocked",
      "needsHuman": false,
      "text": "Coordinate the existing GitNexus P-012/P-018 keep/narrow/scale-back ruling with this acceptance evidence. Inventory remaining consumers, secure the licence route for retained use, and migrate or explicitly retain each dependency. Only then stop unnecessary reindex/index services and reclaim resources through an approved reversible rollout. Verify distribution exclusions, current-build behavior and exact shipped artifact; never force past a red gate or duplicate its live fixer.",
      "links": [
        {
          "id": "WI-10007890",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-033",
      "status": "todo",
      "needsHuman": false,
      "text": "Measure native code-intelligence use and drive it to good use [owner:Avi 2026-10-14, directive #1853]. Build one reusable adoption instrument over the deployed invocation ledger plus the native-command activity record: per operation (graph:query ops, lsp:query, code:pack, explain-change, task briefs) call volume, distinct agents and roles, empty/error/stale/refusal rates, latency, whether a returned site is then read or edited, and raw text-search or direct GitNexus lookups that a native operation would have answered. Freeze a baseline window and an adoption target before any intervention. Close gaps only through existing surfaces: tool guidance, the bash-to-tool routing pairs, playbook routing, and default enrichment in claims/briefs. Bind the instrument to a rubric check, schedule a recurring rubric re-score with a criterion-regression watch, and report each window against the target, negative results included.  — note: ← WI-6554700010012122 released",
      "links": [
        {
          "id": "WI-6554700010012122",
          "activity": "progressing",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-040",
      "status": "todo",
      "needsHuman": false,
      "text": "Speed and refusals. Serve definition and caller lookups from the first-party snapshot so p50 is under 1 s, keeping the LSP daemon warm only for intents that need the compiler. Ship and verify on the deployed operator the judge-role read-only code-intelligence access (all 28 baseline refusals were the judge role).",
      "links": [
        {
          "id": "WI-6554700010015276",
          "activity": "stalled",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-041",
      "status": "todo",
      "needsHuman": false,
      "text": "Push-outcome measurement. Extend the native-adoption instrument with per-leg delivered, acted-on (agent read/edited a cited site or ran the suggested tests within the turn window) and grep-after-push (agent grepped the same symbol anyway) rates, bound as NEW rubric criteria. D-011's baseline, bounds and target stay unchanged. A leg whose acted-on rate stays low is tuned or switched off by recorded decision.",
      "links": [
        {
          "id": "WI-6554700010016419",
          "activity": "stalled",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-042",
      "status": "todo",
      "needsHuman": false,
      "text": "GitNexus decision now. Inventory every remaining GitNexus consumer (tools, routines incl. the hourly gitnexus-reindex, scripts, docs, test selection) with measured use, absorb gitnexus-deterministic-integration-2026-10-05 P-012 (keep/narrow/scale back) and P-018 (deployed check), and record a keep/narrow/retire disposition per consumer with the licence route for anything retained. P-027 then keeps only the final acceptance coordination.",
      "links": [
        {
          "id": "WI-6554700010015356",
          "activity": "free",
          "terminal": false
        }
      ]
    },
    {
      "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "item": "P-025",
      "status": "todo",
      "needsHuman": false,
      "text": "Run a preregistered matched evaluation of graph-enriched Dream against the current sampler/reviewer using frozen populations, equal budgets and independent grading. Reuse Dream run/experiment/outcome ledgers. Measure duplicate/refinement rates, validated useful connections, downstream implemented outcomes and usefulness per dollar with unknown usage explicit. Report negative/inconclusive results and choose retain/narrow/drop from evidence.   — note: ← WI-10007888 released",
      "links": [
        {
          "id": "WI-10007888",
          "activity": "stalled",
          "terminal": false
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "item": "P-007",
      "status": "todo",
      "text": "su-ideate trigger: scheduled su-ideate passes for every pot with su-ideate enabled (not papercusp-only), and fix blender:ideate-pass-record invalid_input (EI-24428150977170134); tests.",
      "cited": [
        {
          "ref": "EI-24428150977170134",
          "state": "open",
          "terminal": false
        }
      ]
    },
    {
      "plan": "scout-su-ideate-pipeline-gaps-2026-10-08",
      "item": "P-010",
      "status": "todo",
      "text": "Acceptance: reconcile and supersede the overlapping stale plans, re-run blender:success-metrics to a pass, author and vet the acceptance rubric, get independent grading, ship.",
      "cited": []
    }
  ],
  "workItems": [
    {
      "id": "WI-2144607",
      "state": "open",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6289",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6290",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6292",
      "state": "open",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6293",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6294",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-6295",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-10003381",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-10003382",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-40148",
      "state": "blocked",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-5894",
      "state": "open",
      "assignee": null,
      "lastProgressAt": "2026-07-26T10:10:13.579Z"
    },
    {
      "id": "WI-6554700010014250",
      "state": "open",
      "assignee": "su-e41f796d-eaeb-458d-8e7b-f957a79a2445",
      "lastProgressAt": "2026-10-17T17:32:33.199Z"
    },
    {
      "id": "WI-6554700010014271",
      "state": "open",
      "assignee": "su-e41f796d-eaeb-458d-8e7b-f957a79a2445",
      "lastProgressAt": "2026-10-17T17:32:33.362Z"
    },
    {
      "id": "WI-6554700010016592",
      "state": "blocked",
      "assignee": "su-e41f796d-eaeb-458d-8e7b-f957a79a2445",
      "lastProgressAt": "2026-10-17T17:39:49.953Z"
    },
    {
      "id": "WI-10005786",
      "state": "open",
      "assignee": "su-9f941711-a74e-486f-9ca7-302887653aac",
      "lastProgressAt": "2026-10-17T17:36:31.392Z"
    },
    {
      "id": "WI-10007889",
      "state": "open",
      "assignee": null,
      "lastProgressAt": null
    },
    {
      "id": "WI-10007890",
      "state": "blocked",
      "assignee": "su-a92ec1b4-ca99-4f52-b6ec-6195ba4d4e3a",
      "lastProgressAt": "2026-10-15T01:30:10.208Z"
    },
    {
      "id": "WI-6554700010012122",
      "state": "open",
      "assignee": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
      "lastProgressAt": "2026-10-17T17:45:54.775Z"
    },
    {
      "id": "WI-6554700010015276",
      "state": "open",
      "assignee": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
      "lastProgressAt": "2026-10-17T04:25:42.240Z"
    },
    {
      "id": "WI-6554700010016419",
      "state": "wip",
      "assignee": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
      "lastProgressAt": "2026-10-17T17:39:37.653Z"
    },
    {
      "id": "WI-6554700010015356",
      "state": "open",
      "assignee": null,
      "lastProgressAt": "2026-10-17T09:04:35.327Z"
    },
    {
      "id": "WI-10007888",
      "state": "open",
      "assignee": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
      "lastProgressAt": "2026-10-17T08:25:02.372Z"
    }
  ],
  "additionalPlanLinkedItems": []
}
