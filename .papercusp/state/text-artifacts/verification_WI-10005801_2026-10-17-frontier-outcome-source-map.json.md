---
rel_path: "verification/WI-10005801/2026-10-17-frontier-outcome-source-map.json"
updated_at: 1792264401493
_body: "content"
---

{
  "kind": "source-contract-candidates-not-outcome-proof",
  "measuredAt": "2026-10-17T19:13:21.477Z",
  "workItem": "WI-10005801",
  "source": {
    "slug": "self-learning-frontier-2026-06-12",
    "version": 74,
    "contentHash": "2c22bb6c8edf960be1a6713602f7758902cd6ad75253b282f76d5486839bc90a",
    "status": "shipped"
  },
  "groups": [
    {
      "term": "graduation",
      "items": [
        {
          "id": "P-044",
          "text": "Kind/taxonomy fidelity at the miner edges: negative-space, neologism, and regret candidates must emit machine-classifiable kind + class so the triage taxonomy can route them — a bug-shaped finding (clear correct-state, regression-testable, e.g. the EI-397 plan-slug resolution gap) files as code-bug and rides the AUTO lane; only genuinely judgment-shaped findings land in the gate lane. Today all three miners file kind=change unconditionally, which routes 100% of machine findings to the human queue regardless of shape.  (FB-18 su-fb2c1: bug-vs-judgment classifiers at all three miner filing edges EI-397 resolution-gap shape + findingClass threaded capture-core→payload→candidate→WatchdogSignal; FB-21's 5 collectors stamped; slugs align with graduation findingClassOf; 2 shape pins per miner, all suites green) (FB-18 follow-on su-d4f36 2026-06-13, owner-asked: closed 2 deferrals — (a) memory-anchor exists-probe leg in probeDemandArtifact so a memory:search zero-hit for an exact identifier that is an ACTIVE memory's anchor (file/plan/symbol/feature/migration value) classifies negative-space:resolution-gap kind=bug, not missing-knowledge — anchors are the identifier index FB-18 left null because cosine/lexical recall is similarity-based; same isReferenceShapedQuery gate keeps bare words judgment-shaped; (b) scan.integration.test.ts pins all three live probe legs (plans cross-scope / docs basename+section / memory active-anchor + non-active=null) on real migrated PG. Stays dark behind P-001. 13 negative-space unit + 10 integration green; test:affected 12,962 green.) (FB-18 deferral #1 CLOSED su-f7e90 2026-06-14, owner-directed: the negative-space miner (FB-04/P-010, wave-1 zero-spend) was ARMED so FB-18's classifier runs live — flag papercusp-negative-space-miner ON + routine negative-space-mine active + governor budget_usd 0 (per-cycle honest cap) → checkLoopVerdict allow. Read-only preview over the live 30d window proved the bug-vs-change split: 962 zero-hits → 92 demand entries → 2 capped candidates, BOTH kind=bug/negative-space:resolution-gap (EI-397 plan-slug shape — probe found plan:<slug> for two existing-but-unrecalled plans). auto-implement is OFF so candidates file to the human/Queen queue, not auto-dispatch. Coordinated with su-c1f12's wave-1 lane. memory-anchor leg stays integration-tested (no memory-surface candidate in this cap). deferral #4 D-012 working-as-designed. deferrals #2/#3 closed prior session.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-045",
          "text": "Queen-turn queue consumption: wire the Queen's triage turn to consume the P-040 ranked human queue + calibration:summary trust weights — the Queen decides place / gym / gate / reject on her cadence; the owner becomes the gate of LAST resort (what policy explicitly routes to a human), never the default decider. The verbs exist (improvements:triage, calibration:summary, scout grading persona); the missing piece is the running decider: the papercup Hive/Queen is stopped — starting it is the owner act this item is gated on.  (FB-19 su-5625c build leg DONE+dark: Queen decider persona in both queen.md sources consume P-040 queue + calibration:summary + lib/graduation tracker — per-class clean-pass counters → owner 'graduation-eligible' report, never an auto autoKinds edit; GRADUATION_TRACKER OFF + routine inactive; 50 unit green. Live decider proof gated on owner Hive-start; widening=P-046.) (Owner-gate satisfied 2026-06-14: papercup-hive is STARTED hive:status started=true, auto wake-mode, subscriptions live, waking ~30min cadence. The decider build is done+dark FB-19; it now runs as the Queen wakes. Live throughput currently budget-starved see account note.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-046",
          "text": "(OWNER) Ratify the trust-graduation policy that widens automatic implementation beyond bugs: a finding CLASS graduates into autoKinds after N clean verified passes (proposal: 10 consecutive auto-implemented items of that class resolved with evidence + zero recurrence over 14d + zero gym/EKG regressions), executed as the reviewed autoKinds config edit riding the release gate; the never-auto protected set (the loop itself, auth, deploy, budgets) graduates NEVER. This is the designed dial for \"the system implements its own suggestions\" — widen by earned evidence, not by ad-hoc judgment.  (Owner ratification — graduation thresholds + the autoKinds-widening procedure) (Graduation policy ratified by delegated owner authority 2026-06-13 D-009 at proposed conservative thresholds; blesses the procedure only, each graduation still release-gated) (P-046 RATIFIED su-5625c, owner-delegated 2026-06-13: thresholds = DEFAULT_GRADUATION_POLICY — 10 consecutive clean auto-passes / 14d zero recurrence / any gym|EKG regression resets streak; protected never-auto set graduates NEVER FB-22-pinned. Tracker FILES owner reports ONLY — widening stays a reviewed release-gated edit D-008. No effect until P-001 arms.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-049",
          "text": "Recursion-safety invariants suite: one test file (the self-learning-invariants.test.ts pattern) pinning the rails that keep self-modification safe — the never-auto protected set includes the loop itself / auth / deploy / budgets and no graduation can promote them; a drill/replay/shadow-origin row never reaches an organic learner; an unbudgeted loop refuses unattended; every prompt mutation lands one change-ledger row; the Queen's triage consumes the policy tier (one verdict chain). These invariants are what make Phase 5/6 autonomy safe — pin them so a refactor can't silently un-make them.  (FB-22 su-535b9) (FB-22 su-535b9: recursion-safety-invariants.test.ts 37 pins + protected-path set widened to learning-governor/** + change-ledger/** the budgets/attribution rails)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "neologism",
      "items": [
        {
          "id": "P-011",
          "text": "Neologism miner: mine coord traffic + insights for emergent recurring vocabulary with no corresponding primitive (tool/table/verb); recurring-term candidates route into Scout's existing rails as abstraction proposals with provenance. Arms at the P-001 gate. (FB-05 picked up by su-0ae39) (FB-05 built+tested su-0ae39: lib/neologism miner + system:neologism-mine — flag dark, routine inactive, governor unbudgeted; abstraction proposals via Scout improvement rail capture-core, origin organic. 30d backtest: 3,831 envelopes + 146 insights → top finds shared hive ×342, hive federation ×230, green gate ×200. ARMING deferred to P-001.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-044",
          "text": "Kind/taxonomy fidelity at the miner edges: negative-space, neologism, and regret candidates must emit machine-classifiable kind + class so the triage taxonomy can route them — a bug-shaped finding (clear correct-state, regression-testable, e.g. the EI-397 plan-slug resolution gap) files as code-bug and rides the AUTO lane; only genuinely judgment-shaped findings land in the gate lane. Today all three miners file kind=change unconditionally, which routes 100% of machine findings to the human queue regardless of shape.  (FB-18 su-fb2c1: bug-vs-judgment classifiers at all three miner filing edges EI-397 resolution-gap shape + findingClass threaded capture-core→payload→candidate→WatchdogSignal; FB-21's 5 collectors stamped; slugs align with graduation findingClassOf; 2 shape pins per miner, all suites green) (FB-18 follow-on su-d4f36 2026-06-13, owner-asked: closed 2 deferrals — (a) memory-anchor exists-probe leg in probeDemandArtifact so a memory:search zero-hit for an exact identifier that is an ACTIVE memory's anchor (file/plan/symbol/feature/migration value) classifies negative-space:resolution-gap kind=bug, not missing-knowledge — anchors are the identifier index FB-18 left null because cosine/lexical recall is similarity-based; same isReferenceShapedQuery gate keeps bare words judgment-shaped; (b) scan.integration.test.ts pins all three live probe legs (plans cross-scope / docs basename+section / memory active-anchor + non-active=null) on real migrated PG. Stays dark behind P-001. 13 negative-space unit + 10 integration green; test:affected 12,962 green.) (FB-18 deferral #1 CLOSED su-f7e90 2026-06-14, owner-directed: the negative-space miner (FB-04/P-010, wave-1 zero-spend) was ARMED so FB-18's classifier runs live — flag papercusp-negative-space-miner ON + routine negative-space-mine active + governor budget_usd 0 (per-cycle honest cap) → checkLoopVerdict allow. Read-only preview over the live 30d window proved the bug-vs-change split: 962 zero-hits → 92 demand entries → 2 capped candidates, BOTH kind=bug/negative-space:resolution-gap (EI-397 plan-slug shape — probe found plan:<slug> for two existing-but-unrecalled plans). auto-implement is OFF so candidates file to the human/Queen queue, not auto-dispatch. Coordinated with su-c1f12's wave-1 lane. memory-anchor leg stays integration-tested (no memory-surface candidate in this cap). deferral #4 D-012 working-as-designed. deferrals #2/#3 closed prior session.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "deferral-interest",
      "items": [
        {
          "id": "P-042",
          "text": "Deferral interest: learn deferral cost from realized outcomes (how many downstream items each historical deferral blocked); price new deferrals at creation as a P-040 feature — the learned successor of B-08's static score.  (FB-14 picked up by su-65533) (FB-14 shipped su-65533: lib/deferral-interest backfill+model+refit, mig 252 live + feature appended to HUMAN_QUEUE_FEATURES, inert until armed flag OFF + no-model. Live proof: 129 deferrals/48wk backfilled; watchdog ×4.7, critical ×5.7 — WEAK v0 by design. Arming at P-001 = flag ON + routine active + governor budget loop deferral-interest-refit.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "EKG",
      "items": [
        {
          "id": "P-004",
          "text": "Behavior-affecting change ledger: one append-only ledger row for every prompt/rule mutation from any source (gym champion commits, playbook/persona edits, ablations), plus the mutation-calendar advisory (one live mutation class at a time, surfaced not enforced). The EKG and ablation condition on it; the gym's committer writes to it. (FB-02 picked up) (FB-02 shipped: mig 242+246, lib/change-ledger, hooks live 1 organic gym:accept + 11 prompts-api rows already ledgered, tools + hourly scan routine; CHANGE_LEDGER flag default ON foundation, not a D-001 loop)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-030",
          "text": "Fleet EKG: behavioral embeddings per session (tool-call n-grams, retry rhythms, lock contention, pacing); distribution-shift detection over the fleet, conditioned on the change ledger so shifts are attributable; alarms via the existing notification rail.  (FB-10 picked up by su-d638f) (FB-10 built+tested su-d638f: lib/fleet-ekg embed/drift/attribution over agent_activity + mig 251 applied live + system:fleet-ekg-scan seeded INACTIVE, flag papercusp-fleet-ekg dark, governor loop fleet-ekg unbudgeted + learning.ekg resolver + EkgPanel; 537-session backtest 06-05..12 shows the 06-12 pacing shift. ARMING deferred to P-001.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-046",
          "text": "(OWNER) Ratify the trust-graduation policy that widens automatic implementation beyond bugs: a finding CLASS graduates into autoKinds after N clean verified passes (proposal: 10 consecutive auto-implemented items of that class resolved with evidence + zero recurrence over 14d + zero gym/EKG regressions), executed as the reviewed autoKinds config edit riding the release gate; the never-auto protected set (the loop itself, auth, deploy, budgets) graduates NEVER. This is the designed dial for \"the system implements its own suggestions\" — widen by earned evidence, not by ad-hoc judgment.  (Owner ratification — graduation thresholds + the autoKinds-widening procedure) (Graduation policy ratified by delegated owner authority 2026-06-13 D-009 at proposed conservative thresholds; blesses the procedure only, each graduation still release-gated) (P-046 RATIFIED su-5625c, owner-delegated 2026-06-13: thresholds = DEFAULT_GRADUATION_POLICY — 10 consecutive clean auto-passes / 14d zero recurrence / any gym|EKG regression resets streak; protected never-auto set graduates NEVER FB-22-pinned. Tracker FILES owner reports ONLY — widening stays a reviewed release-gated edit D-008. No effect until P-001 arms.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "regret",
      "items": [
        {
          "id": "P-021",
          "text": "Regret mining: divergence-turn detection over bad historical sessions (high burn, validator bounces, human rescue) + counterfactual replay of candidate rule changes from that turn; output is a scored what-would-have-helped report into the idea queue (origin=replay, gated filing).  (FB-07 picked up by su-eef0b) (FB-07 su-eef0b: lib/replay/regret — selection heuristics + divergence detection + counterfactual leg on FB-06's runGovernedReplay; mig 248 live; flag papercusp-regret-mining dark + loop regret-mining unbudgeted + routine inactive per D-001; live mine-only proof 279 spawns → 10 findings, 8 with divergence turns pending replay. ARM + live replay proof at P-001.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-044",
          "text": "Kind/taxonomy fidelity at the miner edges: negative-space, neologism, and regret candidates must emit machine-classifiable kind + class so the triage taxonomy can route them — a bug-shaped finding (clear correct-state, regression-testable, e.g. the EI-397 plan-slug resolution gap) files as code-bug and rides the AUTO lane; only genuinely judgment-shaped findings land in the gate lane. Today all three miners file kind=change unconditionally, which routes 100% of machine findings to the human queue regardless of shape.  (FB-18 su-fb2c1: bug-vs-judgment classifiers at all three miner filing edges EI-397 resolution-gap shape + findingClass threaded capture-core→payload→candidate→WatchdogSignal; FB-21's 5 collectors stamped; slugs align with graduation findingClassOf; 2 shape pins per miner, all suites green) (FB-18 follow-on su-d4f36 2026-06-13, owner-asked: closed 2 deferrals — (a) memory-anchor exists-probe leg in probeDemandArtifact so a memory:search zero-hit for an exact identifier that is an ACTIVE memory's anchor (file/plan/symbol/feature/migration value) classifies negative-space:resolution-gap kind=bug, not missing-knowledge — anchors are the identifier index FB-18 left null because cosine/lexical recall is similarity-based; same isReferenceShapedQuery gate keeps bare words judgment-shaped; (b) scan.integration.test.ts pins all three live probe legs (plans cross-scope / docs basename+section / memory active-anchor + non-active=null) on real migrated PG. Stays dark behind P-001. 13 negative-space unit + 10 integration green; test:affected 12,962 green.) (FB-18 deferral #1 CLOSED su-f7e90 2026-06-14, owner-directed: the negative-space miner (FB-04/P-010, wave-1 zero-spend) was ARMED so FB-18's classifier runs live — flag papercusp-negative-space-miner ON + routine negative-space-mine active + governor budget_usd 0 (per-cycle honest cap) → checkLoopVerdict allow. Read-only preview over the live 30d window proved the bug-vs-change split: 962 zero-hits → 92 demand entries → 2 capped candidates, BOTH kind=bug/negative-space:resolution-gap (EI-397 plan-slug shape — probe found plan:<slug> for two existing-but-unrecalled plans). auto-implement is OFF so candidates file to the human/Queen queue, not auto-dispatch. Coordinated with su-c1f12's wave-1 lane. memory-anchor leg stays integration-tested (no memory-surface candidate in this cap). deferral #4 D-012 working-as-designed. deferrals #2/#3 closed prior session.)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "transfer",
      "items": [
        {
          "id": "P-022",
          "text": "Transfer harness (the teach-to-learn + memory-unit-test merge): distill candidate lessons from the day's transcripts; a lesson is RETAINED/PROMOTED only if a fresh student agent with it beats one without it on the historical task (two-tier memory: probationary → validated; admission stays free per D-006). Nightly under governor budget; learning-pack candidates inherit the passing-transfer-test bar.  (FB-08 picked up by su-c8cc5) (FB-08 su-c8cc5: lib/transfer — nightly distill → free probationary admission → student-transfer test on lib/replay's governed battery; two-tier memory seam two-tier.ts + flag-gated injection marker; pack-candidate adopt bar; mig 250 live; flag papercusp-transfer-harness OFF + routine inactive + governor unbudgeted = triple-dark, arms at P-001)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "ablation",
      "items": [
        {
          "id": "P-004",
          "text": "Behavior-affecting change ledger: one append-only ledger row for every prompt/rule mutation from any source (gym champion commits, playbook/persona edits, ablations), plus the mutation-calendar advisory (one live mutation class at a time, surfaced not enforced). The EKG and ablation condition on it; the gym's committer writes to it. (FB-02 picked up) (FB-02 shipped: mig 242+246, lib/change-ledger, hooks live 1 organic gym:accept + 11 prompts-api rows already ledgered, tools + hourly scan routine; CHANGE_LEDGER flag default ON foundation, not a D-001 loop)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-023",
          "text": "Prompt sedimentology: weekly shadow ablation of one governance rule via the llm-testing su target + a replay sample; dead-weight report (rules surviving repeated ablation with zero behavioral delta) for owner review — shadow-only, never mutates live prompts without riding the change ledger + release gate.  (FB-09 picked up by su-6f714) (FB-09 su-6f714: lib/ablation rules/scoring/runner/store/governor/replay-leg + su-target systemPromptText variant seam + ablation:report tool; mig 249 applied live; TRIPLE-DARK per D-001 — flag papercusp-prompt-ablation OFF, weekly routine inactive, governor loop prompt-ablation unbudgeted; FB-06 replay leg wired, degrades replay-dark until P-001; live capped cycle proven, row c8ad2fa9)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    },
    {
      "term": "change-ledger",
      "items": [
        {
          "id": "P-004",
          "text": "Behavior-affecting change ledger: one append-only ledger row for every prompt/rule mutation from any source (gym champion commits, playbook/persona edits, ablations), plus the mutation-calendar advisory (one live mutation class at a time, surfaced not enforced). The EKG and ablation condition on it; the gym's committer writes to it. (FB-02 picked up) (FB-02 shipped: mig 242+246, lib/change-ledger, hooks live 1 organic gym:accept + 11 prompts-api rows already ledgered, tools + hourly scan routine; CHANGE_LEDGER flag default ON foundation, not a D-001 loop)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        },
        {
          "id": "P-049",
          "text": "Recursion-safety invariants suite: one test file (the self-learning-invariants.test.ts pattern) pinning the rails that keep self-modification safe — the never-auto protected set includes the loop itself / auth / deploy / budgets and no graduation can promote them; a drill/replay/shadow-origin row never reaches an organic learner; an unbudgeted loop refuses unattended; every prompt mutation lands one change-ledger row; the Queen's triage consumes the policy tier (one verdict chain). These invariants are what make Phase 5/6 autonomy safe — pin them so a refactor can't silently un-make them.  (FB-22 su-535b9) (FB-22 su-535b9: recursion-safety-invariants.test.ts 37 pins + protected-path set widened to learning-governor/** + change-ledger/** the budgets/attribution rails)",
          "effectiveStatus": "done",
          "storedStatus": "done",
          "needsHuman": false
        }
      ]
    }
  ],
  "limits": [
    "Keyword membership is a candidate map, not a complete source-criterion census.",
    "Item status and historical receipts do not certify current causal benefit.",
    "No source-plan/lifecycle/control edits or paid runs performed."
  ]
}
