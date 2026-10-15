---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-source-control-dispositions-v2-424d5.json"
updated_at: 1791993737469
_body: "content"
---

{
  "schemaVersion": "r13-cold53-seven-source-control-dispositions-v2",
  "observedAt": "2026-10-14T15:58:15.355Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold52-original018-held-response-and-control-triage-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-source-control-invocations-through-cutoff-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-original-disarm-revival-source-through-cutoff-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-original-fleet-kill-control-source-v2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-3077-exact-original-stop-native-context-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-literal-user-control-candidates-provenance-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-indexed-original-native-session-lineage-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-lineage-user-source-index-424d5.json"
  ],
  "summary": {
    "cases": 7,
    "datedSelfControlCalls": 61,
    "positiveDisarmRevivalRows": 8,
    "literalCandidateFullTextRows": 24,
    "originalNativeSessionLineages": 179,
    "userPartIndexRows": 791,
    "controlApplicabilityAccepted": 0,
    "cutoffExclusionsAccepted": 0,
    "reviewOpen": 7,
    "other110Ready": false,
    "originalCohort": 116,
    "receiptPopulation": 137,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "whole116EligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0
  },
  "cases": [
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "category": "recorded-explicit-stop-or-handoff",
      "originalReason": "fleet:kill — Owner-directed migration of six-hour Claude census to headless GPT-6.1 Sol; terminate predecessor before identity-preserving recovery.",
      "controlEvidence": {
        "explicit": [
          {
            "id": "32179749",
            "at": "2026-10-06 11:33:47.276+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Owner directive #1410 done: plan blueprint-backed-work-item-execution-2026-09-23 shipped at 11:31:43Z; WI-10006332 and WI-10005686 are closed. The drift root-cause items EI-25203325947467696 and EI-25200724315817931 stay assigned to me as deferred follow-ups outside #1410's scope."
          }
        ],
        "arms": [
          {
            "id": "31901468",
            "at": "2026-10-06 03:30:54.313+00",
            "workItem": "WI-10006332",
            "mode": null
          },
          {
            "id": "31914000",
            "at": "2026-10-06 03:54:22.839+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "32140913",
            "at": "2026-10-06 10:21:39.275+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "32421629",
            "at": "2026-10-06 21:00:55.197+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "32421897",
            "at": "2026-10-06 21:01:40.517+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "32540116",
            "at": "2026-10-07 00:35:16.205+00",
            "workItem": null,
            "mode": null
          }
        ],
        "lifecycle": []
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Fleet kill32585240 at2026-10-07T01:56:11.642Z follows self arm32540116 at00:35:16.205Z. Frozen bootstrap first-seen01:56:16.264707Z records same owner migration; neither proves continuing final-cutoff owner pause."
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "category": "recorded-explicit-stop-or-handoff",
      "originalReason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue.",
      "controlEvidence": {
        "explicit": [
          {
            "id": "32524471",
            "at": "2026-10-07 00:08:02.153+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue."
          }
        ],
        "arms": [
          {
            "id": "32422463",
            "at": "2026-10-06 21:02:56.173+00",
            "workItem": null,
            "mode": null
          }
        ],
        "lifecycle": []
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Exact indexed native b293b5d8 parts61/62 are authenticated continue directives; part72 at2026-10-07T00:04:32.478Z asks whether last command was safe; assistant part74 voluntarily promises to wait. Self loopend32524471 at00:08:02.153Z describes an owner stop, but these literal turns do not by themselves establish an owner-requested indefinite pause. Fleetkill32586357 at01:57:50.425Z is later identity-preserving migration."
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "category": "leadership-handoff-and-peer-lock",
      "originalReason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant.",
      "controlEvidence": {
        "explicit": [
          {
            "id": "33584301",
            "at": "2026-10-08 01:22:26.542+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant."
          },
          {
            "id": "33614080",
            "at": "2026-10-08 02:22:17.432+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Owned WI-10007305 is blocked on original failed-native-phase evidence after all independent diagnostic fixes and scoped verification; no recovered-peer/live-gate monitoring mission. Original-cause work remains open, not achieved."
          }
        ],
        "arms": [
          {
            "id": "33539590",
            "at": "2026-10-07 23:14:18.328+00",
            "workItem": "WI-10007303",
            "mode": "work"
          }
        ],
        "lifecycle": [
          {
            "at": "2026-10-08 01:22:23.143892+00",
            "event": "disarmed",
            "actor": "loop-end",
            "reason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant."
          }
        ]
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Last successful self loopend33614080 at2026-10-08T02:22:17.432Z cites original failed-native-phase evidence after independent work; earlier leadership/lock reason is not sufficient final-cutoff exclusion. Need original held-item reachability/assignment and control applicability."
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "category": "system-stalled-loop-guard",
      "originalReason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z",
      "controlEvidence": {
        "explicit": [
          {
            "id": "32404575",
            "at": "2026-10-06 20:24:23.389+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Blocked on identity-preserving native pickup: original workers/claims must remain; GOAL holder verified no stronger supported resume route. Quiet checkpoint refused fleet_zero_workers. Ending only periodic monitoring; existing fleet transition watches remain. No completion, target/recipe change, worker replacement or claim release."
          },
          {
            "id": "32434304",
            "at": "2026-10-06 21:23:29.632+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Bounded response predicate satisfied: e643 returned current card EI-25265791008428545; stop the one-fire monitor and process that concrete reply now."
          },
          {
            "id": "32460530",
            "at": "2026-10-06 22:15:57.147+00",
            "tool": "fleet:kill",
            "status": "ok",
            "reason": "WI-10006966: reconcile ended idle 7afe runtime after peer-requested shutdown, saved bench234011 and carry326b5879b318; preserve live unmanaged process if present and do not reopen idle resume gate"
          },
          {
            "id": "32470520",
            "at": "2026-10-06 22:36:09.797+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Owned handoff monitor reached its one no-delta wake stop; exact acceptance await234222 with300s timeout/wake is registered. Preserve EI-25270078901082313 custody until supported transfer."
          },
          {
            "id": "32513712",
            "at": "2026-10-06 23:44:31.114+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "No eligible item returned within existing fleet spec14; standing queue wake watch234636 is registered. Existing EI source work is held and advancing with29464; no periodic source-fix monitor."
          },
          {
            "id": "32516202",
            "at": "2026-10-06 23:49:16.567+00",
            "tool": "loop:end",
            "status": "refused",
            "reason": "The handoff monitor stop condition was satisfied before compaction: custody transferred to live source owner. No held EI authority remains; preserve registered scoped queue and fleet lifecycle event watches."
          },
          {
            "id": "32516392",
            "at": "2026-10-06 23:49:45.887+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Satisfied handoff custody monitor stop condition; own directive queue is empty. Foreign FYI directives remain untouched. Source owner keeps implementation; retain existing scoped queue and fleet lifecycle watches."
          },
          {
            "id": "32685756",
            "at": "2026-10-07 05:11:13.78+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Stop revived terminal-authority monitor: loop:status returned active=true with monitorStanddown=authority_lost and terminal EI-25270078901082313. Retain existing scoped queue/lifecycle event wakes; do not rearm source supervision."
          },
          {
            "id": "33671349",
            "at": "2026-10-08 04:38:45.287+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Scoped scheduler returned all_matches_gated/spec14 after wake509175; blocked WI-10007106 checkpoint966c39efbe5f verified and leader notified. Standing scoped watch234636 is live; avoid empty polling wakes."
          }
        ],
        "arms": [
          {
            "id": "32395405",
            "at": "2026-10-06 20:06:22.875+00",
            "workItem": null,
            "mode": "monitor"
          },
          {
            "id": "32433604",
            "at": "2026-10-06 21:22:00.843+00",
            "workItem": null,
            "mode": "monitor"
          },
          {
            "id": "32461774",
            "at": "2026-10-06 22:18:39.768+00",
            "workItem": "WI-10006966",
            "mode": null
          },
          {
            "id": "32467673",
            "at": "2026-10-06 22:29:56.886+00",
            "workItem": "EI-25270078901082313",
            "mode": "monitor"
          },
          {
            "id": "33813763",
            "at": "2026-10-08 09:01:33.838+00",
            "workItem": "EI-25380637492003672",
            "mode": "work"
          },
          {
            "id": "33989039",
            "at": "2026-10-08 13:58:46.372+00",
            "workItem": "EI-25380637492003672",
            "mode": "work"
          }
        ],
        "lifecycle": [
          {
            "at": "2026-10-08 16:14:34.602397+00",
            "event": "disarmed",
            "actor": "auto-pause-loop-routine",
            "reason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z"
          }
        ]
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Original transition disarmed at2026-10-08T16:14:34.602397Z by auto-pause-loop-routine, stalled-loop guard. Self arm33989039 at13:58:46.372Z precedes it; withdraw rearm-after-guard claim. System guard is not an owner pause."
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "category": "system-stalled-loop-guard",
      "originalReason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z",
      "controlEvidence": {
        "explicit": [
          {
            "id": "33666407",
            "at": "2026-10-08 04:29:26.792+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Fleet leader is now waiting on two concrete owned source repairs, with exact completion awaits245119/245120 and bounded1200s timeout wakes registered this turn; existing fleet event watches remain. End duplicate periodic heartbeat for these predicates while preserving leadership, AUTO and saved carrycb39b55659aa."
          },
          {
            "id": "33946244",
            "at": "2026-10-08 12:41:42.262+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Bounded WI-10007468 disposition reconciled and genuinely blocked by unsupported incident-custody transfer. Steward accepted retain/noexit; preserve all12 checks and claims. Finite loop was already max-fires exhausted. No renewed monitor or executor."
          }
        ],
        "arms": [
          {
            "id": "33563514",
            "at": "2026-10-08 00:42:09.765+00",
            "workItem": null,
            "mode": "monitor"
          },
          {
            "id": "33909373",
            "at": "2026-10-08 11:41:21.361+00",
            "workItem": "WI-10007468",
            "mode": "work"
          }
        ],
        "lifecycle": [
          {
            "at": "2026-10-08 04:29:26.725777+00",
            "event": "disarmed",
            "actor": "loop-end",
            "reason": "Fleet leader is now waiting on two concrete owned source repairs, with exact completion awaits245119/245120 and bounded1200s timeout wakes registered this turn; existing fleet event watches remain. End duplicate periodic heartbeat for these predicates while preserving leadership, AUTO and saved carrycb39b55659aa."
          },
          {
            "at": "2026-10-08 10:43:55.960875+00",
            "event": "disarmed",
            "actor": "monitor-standdown",
            "reason": "monitor standdown (no_delta_budget_exhausted): 3 consecutive quiet wake(s) produced no delta on predicate 'goal-drain-60d3a8-worker-handoff-and-actionable-transitions'. Stop condition was: Goal terminal, fleet paused, leadership transferred, or three consecutive no-delta checks with no actionable admitted work; report custody and park through existing fleet event watches."
          },
          {
            "at": "2026-10-08 12:21:41.675057+00",
            "event": "disarmed",
            "actor": "auto-pause-loop-routine",
            "reason": "dead-man guard: max-fires 1 >= 1 (since arm)"
          },
          {
            "at": "2026-10-08 18:15:34.673087+00",
            "event": "disarmed",
            "actor": "auto-pause-loop-routine",
            "reason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z"
          }
        ]
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Self loopend33946244 at2026-10-08T12:41:42.262Z cites incident-custody block; later system stalled-loop disarm at18:15:34.673087Z is separate positive control. Need held-work custody/reachability at cutoff; system guard alone is no owner pause."
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "category": "system-duration-limit",
      "originalReason": "dead-man guard: max-duration 1218s > 600s (since arm)",
      "controlEvidence": {
        "explicit": [
          {
            "id": "34483233",
            "at": "2026-10-09 07:02:58.262+00",
            "tool": "loop:end",
            "status": "refused",
            "reason": "Blocked on the active git-sync:papercusp exclusive lock. The exact resource-release await is registered with a 600-second wake timeout, so stopping the periodic loop avoids a duplicate poll while preserving a wake."
          },
          {
            "id": "34483948",
            "at": "2026-10-09 07:04:24.854+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Blocked on the active git-sync:papercusp exclusive lock. The exact resource-release await is registered with a 600-second wake timeout; stop the periodic loop to avoid a duplicate poll."
          }
        ],
        "arms": [
          {
            "id": "34520480",
            "at": "2026-10-09 08:19:47.969+00",
            "workItem": "EI-25477838487191856",
            "mode": "monitor"
          }
        ],
        "lifecycle": [
          {
            "at": "2026-10-09 07:04:23.828052+00",
            "event": "disarmed",
            "actor": "loop-end",
            "reason": "Blocked on the active git-sync:papercusp exclusive lock. The exact resource-release await is registered with a 600-second wake timeout; stop the periodic loop to avoid a duplicate poll."
          },
          {
            "at": "2026-10-09 08:40:05.146013+00",
            "event": "disarmed",
            "actor": "auto-pause-loop-routine",
            "reason": "dead-man guard: max-duration 1218s > 600s (since arm)"
          }
        ]
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Self bounded monitor34520480 at2026-10-09T08:19:47.969Z follows successful lock-wait loopend34483948. Positive duration-guard transition at08:40:05.146013Z is automatic bounded-budget exhaustion, not a literal owner stop. Original held item/control evidence remains required."
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "category": "recorded-explicit-stop-or-handoff",
      "originalReason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved.",
      "controlEvidence": {
        "explicit": [
          {
            "id": "30763008",
            "at": "2026-10-01 16:29:41.738+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Avi instructed all agents system-wide to reach a good stopping point, checkpoint, and pause until explicitly resumed."
          },
          {
            "id": "31500339",
            "at": "2026-10-03 05:02:10.356+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "P-010 next execution requires peer repairs5802/5809; P012 and R14 require the existing genuine owner response. Exact repair-done awaits222807/222808 with30m wake deadlines and the existing owner-conversation await now cover those transitions. End redundant60s status polling; retain SELF/AUTO and the unfinished shipment mission."
          },
          {
            "id": "31720878",
            "at": "2026-10-05 17:42:21.933+00",
            "tool": "loop:end",
            "status": "ok",
            "reason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved."
          }
        ],
        "arms": [
          {
            "id": "30594725",
            "at": "2026-10-01 10:00:35.809+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "30771015",
            "at": "2026-10-01 16:52:53.136+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31265102",
            "at": "2026-10-02 11:56:40.022+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "31265919",
            "at": "2026-10-02 11:59:04.987+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31273369",
            "at": "2026-10-02 12:21:22.197+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31276003",
            "at": "2026-10-02 12:31:16.279+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "31294460",
            "at": "2026-10-02 13:44:38.45+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "31296576",
            "at": "2026-10-02 13:56:23.868+00",
            "workItem": null,
            "mode": null
          },
          {
            "id": "31338011",
            "at": "2026-10-02 17:10:13.525+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31518717",
            "at": "2026-10-03 06:03:29.262+00",
            "workItem": "WI-10005128",
            "mode": null
          },
          {
            "id": "31534346",
            "at": "2026-10-03 06:45:10.898+00",
            "workItem": "WI-10005128",
            "mode": "work"
          },
          {
            "id": "31551700",
            "at": "2026-10-03 07:38:16.403+00",
            "workItem": "WI-10004837",
            "mode": "work"
          },
          {
            "id": "31569682",
            "at": "2026-10-03 08:28:01.775+00",
            "workItem": "WI-10004837",
            "mode": "work"
          },
          {
            "id": "31594047",
            "at": "2026-10-03 09:29:07.587+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31610842",
            "at": "2026-10-03 10:14:50.647+00",
            "workItem": null,
            "mode": "work"
          },
          {
            "id": "31633238",
            "at": "2026-10-03 11:21:27.648+00",
            "workItem": "WI-10004837",
            "mode": null
          },
          {
            "id": "31647896",
            "at": "2026-10-03 12:15:15.133+00",
            "workItem": "WI-10005977",
            "mode": "work"
          },
          {
            "id": "31657629",
            "at": "2026-10-03 12:51:57.894+00",
            "workItem": "WI-10005128",
            "mode": null
          },
          {
            "id": "31662686",
            "at": "2026-10-03 13:06:15.314+00",
            "workItem": "WI-10005128",
            "mode": null
          },
          {
            "id": "31670322",
            "at": "2026-10-03 13:29:47.796+00",
            "workItem": "WI-10005128",
            "mode": null
          },
          {
            "id": "31698882",
            "at": "2026-10-05 16:05:23.744+00",
            "workItem": "WI-10004837",
            "mode": "work"
          }
        ],
        "lifecycle": []
      },
      "priorMap": {
        "eligibilityStatus": "unverified",
        "eligibilityDecision": "unverified-no-outcomes-joined",
        "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined"
      },
      "sourceControlDisposition": "dated-source-review-incomplete",
      "eligibilityDisposition": "review-open-no-cutoff-exclusion",
      "reason": "Next reconcile full control applicability and original held-item/assignment evidence through cutoff; no eligibility/outcome accepted.",
      "measuredControlFinding": "Self loopend31720878 at2026-10-05T17:42:21.933Z reports tutorial handoff to7a94555d. Frozen4 claims include three EI refs; must prove handoff applicability and whether independent held work remained. Handoff narrative alone cannot exclude whole owner at final cutoff."
    }
  ],
  "limits": [
    "This freezes source-control case dispositions only. It does not accept eligibility, continuity, outcomes, R5/root961/R12/runtime anchor or actual>=24hR14.",
    "Append-only transition evidence is positive when present; absence is not evidence that a control never existed.",
    "No terminal/test/replay/gate/route/account redo.",
    "Do not cite the withdrawn sourceControlResolved7 field or temporal supersession inference from v1. Preserve exact new source readbacks and six held-checkpoint hashes; WI8887 restoration remains unverified."
  ],
  "supersedes": "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-source-control-dispositions-424d5.json",
  "correction": "v1 sourceControlResolved7 described enumeration as resolution. Withdraw that field: all7 remain review-open; other110 and whole116 still gated. Temporal rearm-after-stop/guard commentary withdrawn in WI8887 comment1181266."
}
