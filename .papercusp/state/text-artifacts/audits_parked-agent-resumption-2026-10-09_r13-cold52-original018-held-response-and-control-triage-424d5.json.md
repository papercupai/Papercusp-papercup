---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold52-original018-held-response-and-control-triage-424d5.json"
updated_at: 1791991448838
_body: "content"
---

{
  "schemaVersion": "r13-cold52-original018-held-response-and-control-triage-v1",
  "observedAt": "2026-10-14T15:24:08.827Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "route": "approved SELF/AUTO/P-013/account/cold",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold33-original116-eligibility-evidence-map-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold45-independent018-cutoff-assignment-source-v2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold51-original018-complete-user-text-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold51-original018-direct-fleet-controls-424d5.json"
  ],
  "original018": {
    "assignmentChronology": [
      {
        "itemRef": "EI-25433658765688677",
        "harness": "papercusp",
        "firstClaimedAt": "2026-10-09 18:44:50.188179+00",
        "lastRecordedPreCutoff": {
          "at": "2026-10-09T14:46:53.942224-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "firstRecordedPostCutoff": {
          "at": "2026-10-10T12:27:53.595465-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "recordedTransitionWithinReviewToCutoff": false,
        "beforeCutoffOwnerMatches": true,
        "afterCutoffOwnerMatches": true
      },
      {
        "itemRef": "EI-25436508475172020",
        "harness": "papercusp",
        "firstClaimedAt": "2026-10-09 19:02:01.605053+00",
        "lastRecordedPreCutoff": {
          "at": "2026-10-09T15:03:31.330941-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "firstRecordedPostCutoff": {
          "at": "2026-10-10T12:27:53.5946-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "recordedTransitionWithinReviewToCutoff": false,
        "beforeCutoffOwnerMatches": true,
        "afterCutoffOwnerMatches": true
      },
      {
        "itemRef": "EI-25493141603129186",
        "harness": "papercusp",
        "firstClaimedAt": "2026-10-09 09:32:55.012361+00",
        "lastRecordedPreCutoff": {
          "at": "2026-10-09T05:32:55.012477-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "firstRecordedPostCutoff": {
          "at": "2026-10-10T12:28:22.002213-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "recordedTransitionWithinReviewToCutoff": false,
        "beforeCutoffOwnerMatches": true,
        "afterCutoffOwnerMatches": true
      },
      {
        "itemRef": "WI-10006302",
        "harness": "papercusp",
        "firstClaimedAt": "2026-10-08 01:55:48.171312+00",
        "lastRecordedPreCutoff": {
          "at": "2026-10-09T05:56:21.017525-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "firstRecordedPostCutoff": {
          "at": "2026-10-10T12:28:52.627636-04:00",
          "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
        },
        "recordedTransitionWithinReviewToCutoff": false,
        "beforeCutoffOwnerMatches": true,
        "afterCutoffOwnerMatches": true
      }
    ],
    "assignmentLimits": [
      "worked_by_history does not encode claim versus release direction; original reviewed held-item witness is still needed",
      "The retained current row and current stored writer definition do not prove complete historical loaded writer or retention",
      "No recovery outcome is joined or eligibility accepted from this chronology"
    ],
    "checkpointRead": {
      "advisory": "⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \"everything this agent did\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \"idle\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves nothing. To look for the missing half, start with `activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, which DOES record native calls, and renders the command text. But do not invert the error onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the faithful-render payload column, so both take the same id you scoped this query with. ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
      "mode": "query",
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id",
        "invoked_at",
        "tool_name",
        "status",
        "args_json",
        "serving_build_sha"
      ],
      "elapsedMs": 30,
      "rows": [
        {
          "id": "35083319",
          "invoked_at": "2026-10-10 02:37:33.363+00",
          "tool_name": "loop:checkpoint",
          "status": "ok",
          "args_json": {
            "harness": "papercusp",
            "checkpoint": {
              "did": "[turn:self] Completed audit row 88: refreshed `.papercusp/reports/plan-portfolio-audit-2026-10-06/audit.json` from current plan/index/lifecycle/ship-readiness and cited work-item reads; verified current source/test coverage without rerunning tests; posted WI-10006302 comment #1170069. P-001 is dropped per D-003, acceptance remains blocked by the missing BAR contract, and the separate EI recurrence is blocked on release:deployed.",
              "left": "Audit row 89 remains. Preserve row82 provenance and the coupling P-004 owner-attributed follow-up; keep separate held EIs outside this audit unit.",
              "next": "Next cold wake: verify WI-10006302 remains held, the previous cycle settled, await 254510 active with zero outstanding deliveries, and rewakeGuaranteed=true; then audit row 89 against live plan, index, lifecycle, and linked work items, and post one read-only comment.",
              "insight": "Terminal/dropped plan labels and saved implementation evidence do not establish current acceptance readiness."
            }
          },
          "serving_build_sha": "d740fc3802"
        }
      ]
    },
    "nativeIndexedFrames": {
      "mode": "query",
      "rowCount": 5,
      "truncated": false,
      "fields": [
        "session_id",
        "part_idx",
        "ts",
        "speaker",
        "part_kind",
        "indexed_chars",
        "text"
      ],
      "elapsedMs": 5,
      "rows": [
        {
          "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
          "part_idx": 12,
          "ts": "2026-10-10 02:29:38.769+00",
          "speaker": "assistant",
          "part_kind": "tool_use",
          "indexed_chars": 353,
          "text": "const results = await Promise.all([\n  tools.mcp__papercusp_su__loop_status({}),\n  tools.mcp__papercusp_su__work_items_get({ id: \"WI-10006302\", harness: \"papercusp\", resume: true }),\n  tools.mcp__papercusp_su__work_items_get({ id: \"WI-10006302\", harness: \"papercusp\", detail: true, threadLimit: 3 })\n]);\nfor (const r of results) text(JSON.stringify(r));\n"
        },
        {
          "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
          "part_idx": 13,
          "ts": "2026-10-10 02:29:41.216+00",
          "speaker": "user",
          "part_kind": "tool_result",
          "indexed_chars": 2025,
          "text": "Script completed\nWall time 2.4 seconds\nOutput:\n\n{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"ok\\\":true,\\\"ownerId\\\":\\\"su-01864986-d27d-497b-b501-7082b6e0caab\\\",\\\"loop\\\":{\\\"name\\\":\\\"loop-su-01864986-d27d-497b-b501-7082b6e0caab\\\",\\\"ownerId\\\":\\\"su-01864986-d27d-497b-b501-7082b6e0caab\\\",\\\"harnessSlug\\\":\\\"papercusp\\\",\\\"active\\\":true,\\\"intervalSec\\\":60,\\\"carry\\\":\\\"cold\\\",\\\"continuation\\\":\\\"settle\\\",\\\"mode\\\":\\\"work\\\",\\\"monitor\\\":null,\\\"monitorStanddown\\\":null,\\\"standdown\\\":null,\\\"goal\\\":\\\"Continue the nonp2p-bug-drain-luna-max-0930 fleet lane; each cold wake pulls only work admitted by that fleet's scheduler claim spec and advances one item. When the scheduler returns empty, register the standing claimable watch and end the loop.\\\",\\\"fireCount\\\":105,\\\"firesSinceArm\\\":19,\\\"parked\\\":true,\\\"nextFireAt\\\":null,\\\"lastFiredAt\\\":\\\"2026-10-10T02:22:43.396Z\\\",\\\"armedAt\\\":\\\"2026-10-09T15:23:24.977Z\\\",\\\"expectedFiresSinceArm\\\":666,\\\"effectiveIntervalSec\\\":2082.022052631579,\\\"cadenceRatio\\\":34.70036754385965,\\\"longestObservedGapSec\\\":19130.060026,\\\"cadenceDrift\\\":false,\\\"costCapCents\\\":null,\\\"maxFires\\\":null,\\\"maxDurationSec\\\":null,\\\"stalled\\\":false,\\\"stalledSinceMs\\\":null,\\\"fireStarved\\\":false,\\\"lastDeliveryOutcome\\\":\\\"queued\\\",\\\"consecutiveErrors\\\":1,\\\"lastWithheldAt\\\":\\\"2026-10-09T18:11:33.934Z\\\",\\\"lastWakeChannel\\\":\\\"cold-fresh-successor\\\",\\\"lastWakeStatus\\\":\\\"delivered\\\",\\\"lastWakeAt\\\":\\\"2026-10-10T02:28:53.855Z\\\",\\\"lastWakeError\\\":null,\\\"lastTurnAt\\\":\\\"2026-10-10T02:13:57.031Z\\\",\\\"lastLoopTurnAt\\\":\\\"2026-10-10T02:13:57.031Z\\\",\\\"lastRealTurnAt\\\":\\\"2026-10-10T02:13:57.031Z\\\",\\\"turnsStalled\\\":false,\\\"parkedForSec\\\":417,\\\"lifecycleBackoff\\\":null},\\\"rewake\\\":{\\\"rewakeGuaranteed\\\":true,\\\"reason\\\":null},\\\"lastTransition\\\":{\\\"status\\\":\\\"found\\\",\\\"transition\\\":{\\\"at\\\":\\\"2026-10-10T02:22:45.070Z\\\",\\\"event\\\":\\\"parked\\\",\\\"actor\\\":\\\"claim-due-routine\\\",\\\"newNextFireAt\\\":null,\\\"intervalSec\\\":60,\\\"detail\\\":null},\\\"cycle\\\":{\\\"phase\\\":\\\"turn-in-flight\\\",\\\"turnInFlightSec\\\":415,\\\"lastTurn\\\":{\\\"parkedAt\\\":… [truncated 24002 chars]"
        },
        {
          "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
          "part_idx": 24,
          "ts": "2026-10-10 02:30:31.281+00",
          "speaker": "assistant",
          "part_kind": "text",
          "indexed_chars": 293,
          "text": "The live checks confirm WI-10006302 is still assigned to me in this fleet, await 254510 is active, there are no queued deliveries, and the engine loop guarantees a next wake. I’m now refreshing the audit artifact and saved row 87 evidence so row 88 can be checked against current source state."
        },
        {
          "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
          "part_idx": 25,
          "ts": "2026-10-10 02:30:32.55+00",
          "speaker": "assistant",
          "part_kind": "tool_use",
          "indexed_chars": 642,
          "text": "const [item, file] = await Promise.all([\n  tools.mcp__papercusp_su__tools_invoke({\n    name: \"work_items:get\",\n    args: { id: \"WI-10006302\", harness: \"papercusp\", detail: true, payloadTier: \"full\", threadLimit: 1 }\n  }),\n  tools.exec_command({\n    cmd: \"python -c 'import json; p=\\\".papercusp/reports/plan-portfolio-audit-2026-10-06/audit.json\\\"; d=json.load(open(p)); print(json.dumps({\\\"keys\\\":list(d),\\\"row88\\\":d[\\\"rows\\\"][87]}, ensure_ascii=False))'\",\n    workdir: \"/home/marsh-office/papercupai-workspace/papercusp\",\n    yield_time_ms: 30000,\n    max_output_tokens: 5000\n  })\n]);\ntext(JSON.stringify(item));\ntext(JSON.stringify(file));\n"
        },
        {
          "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
          "part_idx": 26,
          "ts": "2026-10-10 02:30:37.483+00",
          "speaker": "user",
          "part_kind": "tool_result",
          "indexed_chars": 2024,
          "text": "Script completed\nWall time 4.9 seconds\nOutput:\n\n{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"schemaVersion\\\":\\\"papercusp.output-envelope/v1\\\",\\\"summary\\\":\\\"\\\",\\\"summaryProvenance\\\":\\\"authored\\\",\\\"content\\\":[{\\\"kind\\\":\\\"evidence-reference\\\",\\\"uri\\\":\\\"papercusp://scratch/papercusp-workspace/tools:invoke/2f3e9910-e1e9-4eb4-bce8-8faa76e25a9c/result-door-1791599437124-d339efda.spill\\\",\\\"preview\\\":\\\"work-item evidence\\\",\\\"byteCount\\\":36562,\\\"sha256\\\":\\\"23d03fef023209fe9a543b74b18460fbb1f60b984943b4f44824c63ecac87b01\\\",\\\"expiresAt\\\":\\\"2026-10-11T02:30:37.124Z\\\",\\\"ownerId\\\":\\\"su-01864986-d27d-497b-b501-7082b6e0caab\\\",\\\"audience\\\":\\\"owner\\\",\\\"evidenceClass\\\":\\\"work-item\\\"},{\\\"kind\\\":\\\"evidence-reference\\\",\\\"uri\\\":\\\"papercusp://scratch/papercusp-workspace/tools:invoke/2f3e9910-e1e9-4eb4-bce8-8faa76e25a9c/result-door-1791599437124-d339efda.spill\\\",\\\"preview\\\":\\\"event evidence\\\",\\\"byteCount\\\":36562,\\\"sha256\\\":\\\"23d03fef023209fe9a543b74b18460fbb1f60b984943b4f44824c63ecac87b01\\\",\\\"expiresAt\\\":\\\"2026-10-11T02:30:37.124Z\\\",\\\"ownerId\\\":\\\"su-01864986-d27d-497b-b501-7082b6e0caab\\\",\\\"audience\\\":\\\"owner\\\",\\\"evidenceClass\\\":\\\"event\\\"}],\\\"state\\\":\\\"incomplete\\\",\\\"incomplete\\\":{\\\"reason\\\":\\\"explicit-full-request-overflow\\\",\\\"spilledItems\\\":3,\\\"recoverable\\\":false,\\\"note\\\":\\\"The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. However, the TOOL ITSELF already truncated field(s) before this spill (textTruncated, omittedRefsTruncated); paging this reference cannot recover those omitted fields. Re-call the tool with a wider per-field limit.\\\"},\\\"metrics\\\":{},\\\"accounting\\\":{\\\"summaryChars\\\":0,\\\"summaryBytes\\\":0,\\\"contentBytes\\\":854,\\\"totalBytes\\\":854,\\\"summaryBudgetChars\\\":0}}\"}]}\n{\"chunk_id\":\"cc80fc\",\"wall_time_seconds\":0.007313431,\"exit_code\":0,\"original_token_count\":611,\"output\":\"{\\\"keys\\\": [\\\"snapshotAt\\\", \\\"baselineMeasuredAt\\\", \\\"generatedAt\\\", \\\"scope\\\", \\\"stats\\\", \\\"limitations\\\", \\\"writerRefs\\\", \\\"coverage\\\", \\\"rows\\\"], \\\"row88\\\": {\\\"slug\\\"… [truncated 2425 chars]"
        }
      ]
    },
    "assessment": {
      "independentWork": "Original loop checkpoint35083319 records audit row89 remaining under WI-10006302; separate EI recurrence waits on release:deployed.",
      "heldResponseCustody": "Native part26 records original work-item evidence spill URI with byteCount36562, SHA23d03fef023209fe9a543b74b18460fbb1f60b984943b4f44824c63ecac87b01, expiry2026-10-11T02:30:37.124Z. It reports incomplete/unrecoverable output. This is original emitted-reference custody, not a full held-item body or a verified deletion.",
      "retainedIndexLimits": "Exact indexed bytes preserved here contain truncation markers. They are not a complete raw-native response or complete source-control census.",
      "cutoffVerdict": "review-open",
      "newEligibilityAcceptance": false
    }
  },
  "controlCases": [
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "originalLabel": "justified-owner-stop-or-handoff",
      "sourceReason": "fleet:kill — Owner-directed migration of six-hour Claude census to headless GPT-6.1 Sol; terminate predecessor before identity-preserving recovery.",
      "sourceClassification": "recorded-explicit-stop-or-handoff",
      "originalWorkRefs": [
        "WI-10006954",
        "WI-10007012",
        "WI-10006967"
      ],
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "originalLabel": "justified-owner-stop-or-handoff",
      "sourceReason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue.",
      "sourceClassification": "recorded-explicit-stop-or-handoff",
      "originalWorkRefs": [
        "WI-10006984",
        "WI-10007019",
        "WI-10007021",
        "WI-10006981",
        "WI-10006985",
        "WI-10007020",
        "WI-10006983",
        "WI-10006963",
        "WI-10006982",
        "WI-10006964",
        "WI-10006962"
      ],
      "frozenClaimCount": 11,
      "frozenParkedOn": null,
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "originalLabel": "justified-owner-pause",
      "sourceReason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant.",
      "sourceClassification": "leadership-handoff-and-peer-lock",
      "originalWorkRefs": [
        "WI-10007305"
      ],
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "coord:inbox-wake:su-353a50d8-bcff-423e-9334-9498ed6ff4e9"
      ],
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "originalLabel": "justified-owner-pause",
      "sourceReason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z",
      "sourceClassification": "system-stalled-loop-guard",
      "originalWorkRefs": [
        "EI-25327682039407935",
        "EI-25380637492003672",
        "WI-10007106"
      ],
      "frozenClaimCount": 3,
      "frozenParkedOn": [
        "work-item:unblocked:WI-10007106",
        "work-item:done:WI-10007305",
        "work-item:claimable",
        "coord:inbox-wake:su-684c584a-3351-49ee-a145-f657d7e42237"
      ],
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "originalLabel": "justified-owner-pause",
      "sourceReason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z",
      "sourceClassification": "system-stalled-loop-guard",
      "originalWorkRefs": [
        "WI-10007468"
      ],
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "originalLabel": "justified-budget-or-time-bound",
      "sourceReason": "dead-man guard: max-duration 1218s > 600s (since arm)",
      "sourceClassification": "system-duration-limit",
      "originalWorkRefs": [
        "EI-25477838487191856"
      ],
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "originalLabel": "justified-owner-stop-or-handoff",
      "sourceReason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved.",
      "sourceClassification": "recorded-explicit-stop-or-handoff",
      "originalWorkRefs": [
        "EI-24922683639239432",
        "EI-24870209437597571",
        "EI-24923992688505913"
      ],
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "assessment": "review-open",
      "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
    }
  ],
  "summary": {
    "originalCohort": 116,
    "priorSixCases": 6,
    "other110": 110,
    "newSourceControlTriageCases": 7,
    "systemStalledLoopGuards": 2,
    "systemDurationLimits": 1,
    "leadershipHandoffAndLock": 1,
    "explicitStopOrHandoff": 3,
    "receiptPopulation": 137,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "eligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "No original cohort membership or six-case source verdict changed.",
    "No post-cutoff outcome fields joined.",
    "No source edit, product test, acquisition, terminal replay, restore, account/route change, gate operation or terminal close.",
    "Original018 held-item/control custody and other110 cutoff review remain open. Preserve R5/root961/R12/all-final-fix-runtime/actual>=24hR14."
  ]
}
