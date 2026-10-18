---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume168-source-tail-advisory-readback-424d5.json"
updated_at: 1792277966690
_body: "content"
---

{
  "ranges": [
    {
      "session": "01a12344-bee8-73d1-9ff7-8a27ed86b011",
      "from_idx": 31,
      "to_idx": 44
    },
    {
      "session": "91df4c82-c30f-41ec-b88a-bf7f87511858",
      "from_idx": 22,
      "to_idx": 22
    }
  ],
  "turns": [
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:31",
      "turn_idx": 31,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:00:38.435-04",
      "text": "⟦turn-origin:wake-pump nonce:468f9c285cc6e9d7⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — EI source tests/home fix verified; queued migration still blocked. Lease renewal-domain correction checkpointed before required compaction.. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-54c255b17bae8f3f2b389cb3a7ede85577a0014622f27ab9a5eb923fd9d8987c\"} (event-wake delivery #615442 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:32",
      "turn_idx": 32,
      "speaker": "assistant",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:03:03.254-04",
      "text": "I’m closing the outstanding reply obligations and passing the new evidence to the current audit owner. The reported schema migration remains blocked; the source and home-directory fixes do not establish that the migration completed.",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:33",
      "turn_idx": 33,
      "speaker": "assistant",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:04:18.796-04",
      "text": "Avi, I’ve answered the late replies and handed their evidence to `su-92de4`, which now owns the audit.\n\nThe audit remains open. The reported source fixes are separate from the migration, which is still blocked.",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:34",
      "turn_idx": 34,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:19:43.602-04",
      "text": "⟦turn-origin:wake-pump nonce:8110370e3bf84909⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Continuation is progressing P003 acceptance, prior item is terminal.. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-a5ff901a893265f6adf2c2d6180037e54b5697fbf10dee741ee94c567047c3e7\"} (event-wake delivery #616011 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:35",
      "turn_idx": 35,
      "speaker": "assistant",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:22:15.061-04",
      "text": "I’ll reconcile this notification with the inbox and pass any new evidence to the current audit owner.",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:36",
      "turn_idx": 36,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:28:07.963-04",
      "text": "⟦turn-origin:wake-pump nonce:3c8bc4241e12ff95⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Resumed EI-25231240145060739; current ledger shows it open and unassigned. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-b91ec103e087a32869d13728046b2ff6fcdb97ff52d0666b3c4bb7bb6ca1bb04\"} (event-wake delivery #616833 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:37",
      "turn_idx": 37,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:39:58.675-04",
      "text": "⟦turn-origin:wake-pump nonce:643910bd157016d1⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Reviewer-session timing found; original psu bootstrap hop remains unlocated (part 2/2). (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-9b4e72b9ce01077c66b268b11ff22c31b77cff74923c6ee739509c96b478a707\"} (event-wake delivery #617522 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:38",
      "turn_idx": 38,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:46:47.843-04",
      "text": "⟦turn-origin:wake-pump nonce:9e780c9cd10a685d⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Acknowledged: re-reading WI-10006388 now. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-2c7c24b8f4f728037a4fbf84d67d99c509d7505b2cbb08a1ddc02a6f3c49b4f4\"} (event-wake delivery #617931 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:39",
      "turn_idx": 39,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 13:56:54.33-04",
      "text": "⟦turn-origin:wake-pump nonce:83a26beb9e18d883⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — delivery-ladder: directed mail unread past 5m (oldest ~9m). (your note: always-armed inbox-wake (turn-lifecycle-control)) (event-wake delivery #618046 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:40",
      "turn_idx": 40,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 14:49:55.636-04",
      "text": "⟦turn-origin:wake-pump nonce:83a7b319f798c868⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Resumption status for EI-25326436725537582. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-9009e054238fe05a2bb638d4b2e33028d38c7768d365d6e7e24d0be62035de9e\"} (event-wake delivery #619005 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED (recorded ended_at: 2026-10-10T18:07:25.255Z) — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:41",
      "turn_idx": 41,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 15:02:00.499-04",
      "text": "⟦turn-origin:wake-pump nonce:0948a72ccade9dd7⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — Exact resumption status and blocker for EI-25326436725537582 (part 2/2). (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-83b26369075cc3f1aaf34b35a2e950f2c77654c7fbbec260267eecb8aadaf29f\"} (event-wake delivery #619077 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:42",
      "turn_idx": 42,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 15:33:39.951-04",
      "text": "⟦turn-origin:wake-pump nonce:33526f148d5c4282⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — WI-10006692 is open and unassigned; its current checkpoint prohibits action absent new evidence. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-33294cf08e8570c9177ddc8df50c819fe372c8bd116e0fa2a60a19637be59424\"} (event-wake delivery #619577 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:43",
      "turn_idx": 43,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 15:41:07.603-04",
      "text": "⟦turn-origin:wake-pump nonce:688a83c8a435a5b8⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — delivery-ladder: directed mail unread past 5m (oldest ~6m). (your note: always-armed inbox-wake (turn-lifecycle-control)) (event-wake delivery #619672 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:44",
      "turn_idx": 44,
      "speaker": "user",
      "owner": "su-c210fe1b-c7c1-41b7-8641-cc7e07551093",
      "ts": "2026-10-10 16:51:33.97-04",
      "text": "⟦turn-origin:wake-pump nonce:468065c87588a8fd⟧\n[await-event] coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 fired — 2 events fired while you slept: coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093, coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093 — latest: Resumed EI-25231240145060739; current ledger shows it open and unassigned. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"coalesced\":true,\"count\":2,\"eventCount\":2,\"timeoutCount\":0,\"events\":[{\"event\":\"coord:inbox-wake:su-c210fe1b-c7c1-41b7-8641-cc7e07551093\",\"summary\":\"EI-24937591709395249 live claim differs from prior carry\",\"payload\":{\"msg_id\":\"coord-send-d042987caace7d0b347dcb0394656103b3dc11a4ebe7a590e87f3978ce6b7740\"},\"urgent\":false,\"delivery_id\":616830,\"createdAt\":\"2026-10-10T17:26:00.550Z\"},{\"event\":\"coord:in (event-wake delivery #616833 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.\n\n[resume-after-death advisory] This turn RESUMED a session whose codex process had already EXITED — this wake spawned a fresh process because no live one existed. Anything that lived only in the dead process's memory is GONE: native background-Bash tasks (run_in_background ids / TaskOutput handles), child processes, listeners, tunnels. Before acting on ANY carried claim about background or in-flight work — including a carried \"COMPLETED\" (a wrapper shell can report done while its real child still ran) — RE-VERIFY it against the real OS (`ps aux | grep`, `kill -0 <pid>`) or the durable ledger that owns it (tool_invocations, the work-item checkpoint), and re-launch what matters through a restart-durable path (EI-16611: `capability:bash` background jobs are operator-owned; native CLI background tasks are not).",
      "text_truncated": false
    },
    {
      "ref": "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:22",
      "turn_idx": 22,
      "speaker": "assistant",
      "owner": "su-92de4154-4d25-4c00-b14f-2fee51639247",
      "ts": "2026-10-10 12:22:18.996-04",
      "text_truncated": false,
      "text_full_chars": 4624,
      "readMore": {
        "tool": "sessions:read",
        "args": {
          "ref": "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:22",
          "text_offset": 4000,
          "text_limit": 4000
        }
      },
      "text": "Avi, the auditor (su-c210fe1b) died mid-audit, and it died the same way as many of the agents it was investigating: its own self-compaction failed to restart. I picked up its work (WI-10008017) and finished the diagnosis.\n\n**Most of the wrongful parking is not agents choosing to quit.** 298 agents were parked at 16:00Z, and 266 of them still hold claimed work. Each cause below was checked against the agents currently running normally as a control group.\n\n| Why it's parked | Agents | Will a wake help? |\n|---|---:|---|\n| **Can't think.** Its codex login token is dead (46), or it's out of quota, refused, or on an unsupported model (13) | **59** | No. Every wake starts a turn that fails instantly |\n| **Its self-compaction restart failed.** The restarted codex never reconnected, so wakes pile up as \"pending\" forever | **57** | No |\n| **Stopped itself with `loop:end`** | **115** | Yes, but it parks again because its instructions tell it to |\n| Other or mixed (incl. 8 the watchdog stopped while healthy) | 67 | Some |\n\n- **Dead logins (46):** every codex session shares one login file. When it was refreshed on Oct 8 at 00:24Z, codex processes started before then kept the old token in memory. All 46 started before the refresh; no running agent has this problem.\n- **Failed restarts (57):** 57 parked agents went silent right after a restart failed, against 3 of 87 running agents.\n- **The watchdog makes it permanent.** When an agent stops taking turns, the watchdog switches off its loop instead of repairing it. That removes its last way to wake up.\n- **Self-stops (115):** the loop prompt says \"if blocked on something external, call `loop:end`\". The tool's guidance says to pass the safety-guard bypass on the first call. 100 of 140 self-stoppers used it, and 51 of those are AUTO agents still holding work with nothing to wake them.\n- **The earlier wake sweep didn't stick.** Of about 108 agents the auditor woke, 72 never acted (39 had dead logins) and 29 of the 36 that did act have parked again.\n\n**The plan** extends the auditor's draft plan `parked-agent-census-resumption-and-root-cause-2026-10-09`. Nothing has been built yet.\n\n1. **P-004 (urgent):** when a codex turn fails on login, restart the codex process so it picks up the current token. Also fix the token-sharing problem itself.\n2. **P-005 (urgent):** a failed compaction restart retries or relaunches instead of stranding the agent. This extends the existing blocked items WI-10007305 and WI-10002078.\n3. **P-006:** a wake only counts as \"delivered\" once a turn actually starts; otherwise it escalates to recovery.\n4. **P-007:** the watchdog repairs a stuck agent instead of switching off its loop. It never leaves an AUTO agent holding work with no way to wake.\n5. **P-008:** rewrite the \"blocked → `loop:end`\" instructions. Agents keep doing whatever isn't blocked, then wait on the specific event that unblocks them, with a timeout.\n6. **P-009:** make the safety guard real. `loop:end` is refused for an AUTO agent holding work with no wake source, and the refusal no longer hands out the bypass.\n7. **P-010:** blocked items stop counting against the 2-item claim limit (16 agents parked on that limit).\n8. **P-011:** report stuck agents as stuck rather than \"parked\", add an alarm with per-cause counts, and find out why nothing alarmed for days.\n9. **P-012:** after P-004 and P-005 land, restart the roughly 116 stuck agents with their original model, account and settings, and check each one by real tool activity.\n10. **P-013:** re-measure 24 hours later. Success means no dead-login agents, failed-restart strandings back to the normal rate, and almost no AUTO agents parked holding work. Then close WI-10008017.\n\nBoth of your choices are recorded on the plan: I build it myself (D-001), and the stuck agents wait for the fixes (D-002).\n\nSome limits on these numbers:\n- The \"why it stopped itself\" sub-reasons come from keyword matching on the agents' stated reasons, so they're approximate.\n- The failed-restart count uses a timing rule (last tool call right at a failed restart).\n- I haven't re-read the wake-delivery code myself; that claim comes from the auditor and gets checked first in P-006.\n\nFull report with evidence and a diagram: [Why 298 agents are parked, and the plan](/reports/rpt_8006cf99-003f-4399-9299-4f71fb0e13d8)\n\n**Next:** I've queued a self-compaction (context is at 80%). The fresh session resumes from the work-item checkpoint, does the plan's activation check, then starts P-004 and P-005 with tests. If I'm still in this session on your next message, the compaction didn't happen and I'll request it again."
    }
  ]
}
