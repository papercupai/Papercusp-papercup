---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold54-exact-three-injected-control-frames-424d5.json"
updated_at: 1791995044804
_body: "content"
---

{
  "schemaVersion": "r13-cold54-exact-three-injected-control-frames-v1",
  "observedAt": "2026-10-14T16:24:04.794Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceIndex": "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-lineage-user-source-index-424d5.json",
  "selection": "Three exact existing frozen-index refs only; no corpus re-enumeration or raw-native acquisition.",
  "sql": "WITH refs(source_kind,session_id,part_idx) AS (VALUES ('codex','01a0f822-783c-74c3-8595-7666d7381d41',177),('codex','01a10d20-5de7-75b3-98c5-9d58d727e20b',69),('codex','01a1195b-ca8b-70d3-b6a1-d9578a9a7925',71)) SELECT p.owner,p.source_kind,p.session_id,p.part_idx,p.ts,p.text,t.turn_idx,t.turn_origin,t.turn_origin_verdict FROM refs r JOIN harness_shared.session_turn_parts p ON p.workspace_id='default' AND p.source_kind=r.source_kind AND p.session_id=r.session_id AND p.part_idx=r.part_idx LEFT JOIN harness_shared.session_turns t ON t.workspace_id='default' AND t.source_kind=p.source_kind AND t.session_id=p.session_id AND t.speaker='user' AND t.ts=p.ts AND t.text=p.text ORDER BY p.owner,p.ts,p.session_id,p.part_idx LIMIT 10",
  "result": {
    "mode": "query",
    "rowCount": 3,
    "truncated": false,
    "fields": [
      "owner",
      "source_kind",
      "session_id",
      "part_idx",
      "ts",
      "text",
      "turn_idx",
      "turn_origin",
      "turn_origin_verdict"
    ],
    "elapsedMs": 27,
    "rows": [
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a1195b-ca8b-70d3-b6a1-d9578a9a7925",
        "part_idx": 71,
        "ts": "2026-10-08 03:20:34.365+00",
        "text": "⟦turn-origin:wake-pump nonce:ab1c4e9af9b61e10⟧\n[await-event] coord:inbox-wake:su-353a50d8-bcff-423e-9334-9498ed6ff4e9 fired — D-002 custody disposition preserved; check-ledger anomaly recovered from native evidence.. (your note: [coord:await-inbox:explicit-park] WI-10007305 remains self/blocked; item checkpoint 7fccf546d6d5 and carry e076d3763681 preserve proof. Bulk Inbox request coord-send-44c608d578c21f56add0aac5bf1cd8dfffa09f67f515f37bc6a75f5d94dbef10 already answered keep open/investigate via reply coord-send-213659a3f593de58f6c8043be042ef60c0cc259cb0186209ed16df30668c0784. Wake delivery 507864 already delivered; duplicate is stale. Resume only for current leader ruling to disposition request 3bc58024 or genuine distinguishing original failed native-phase evidence. No periodic loop, generic backlog, repeat archive search, terminal action or new code/test/runtime/profile/actor route.) payload: {\"msg_id\":\"coord-send-74e472667be5f1c5aef3c65c2ad44677838f5d5280ad8b7c68cc1d3bb716fb28\"} (event-wake delivery #508338 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
        "turn_idx": 12,
        "turn_origin": "wake-pump",
        "turn_origin_verdict": "agent-injected"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f822-783c-74c3-8595-7666d7381d41",
        "part_idx": 177,
        "ts": "2026-10-01 16:50:00.536+00",
        "text": "⟦turn-origin:wake-pump nonce:09c46be16e4a7387⟧\n[await-event] coord:inbox-wake:su-fc5749a7-6632-4f73-9c99-8b475641e7e2 fired — Avi lifts the earlier pause: resume your work now from your checkpoint.. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-59113225eb0c7252ac99d68d9460da0a8432b51ccf0639b6b110cc9f96b22990\"} (event-wake delivery #397436 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
        "turn_idx": 20,
        "turn_origin": "wake-pump",
        "turn_origin_verdict": "agent-injected"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10d20-5de7-75b3-98c5-9d58d727e20b",
        "part_idx": 69,
        "ts": "2026-10-05 17:46:56.761+00",
        "text": "⟦turn-origin:wake-pump nonce:77d978ac1efb499f⟧\n[await-event] coord:inbox-wake:su-fc5749a7-6632-4f73-9c99-8b475641e7e2 fired — Handoff received; I have claimed WI-10004837/P-010 and P-012 in AUTO under D-021. Recovering your existing task/logs, no duplicate launch.. (your note: headless launch-agent inbox-wake) payload: {\"msg_id\":\"coord-send-83030667025aaf601d27d3763c2fbf8b60ace4873b1a7056cdb06fe84a2d7392\"} (event-wake delivery #432238 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
        "turn_idx": 14,
        "turn_origin": "wake-pump",
        "turn_origin_verdict": "agent-injected"
      }
    ]
  },
  "rows": [
    {
      "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "source_kind": "codex",
      "session_id": "01a1195b-ca8b-70d3-b6a1-d9578a9a7925",
      "part_idx": 71,
      "ts": "2026-10-08 03:20:34.365+00",
      "text": "⟦turn-origin:wake-pump nonce:ab1c4e9af9b61e10⟧\n[await-event] coord:inbox-wake:su-353a50d8-bcff-423e-9334-9498ed6ff4e9 fired — D-002 custody disposition preserved; check-ledger anomaly recovered from native evidence.. (your note: [coord:await-inbox:explicit-park] WI-10007305 remains self/blocked; item checkpoint 7fccf546d6d5 and carry e076d3763681 preserve proof. Bulk Inbox request coord-send-44c608d578c21f56add0aac5bf1cd8dfffa09f67f515f37bc6a75f5d94dbef10 already answered keep open/investigate via reply coord-send-213659a3f593de58f6c8043be042ef60c0cc259cb0186209ed16df30668c0784. Wake delivery 507864 already delivered; duplicate is stale. Resume only for current leader ruling to disposition request 3bc58024 or genuine distinguishing original failed native-phase evidence. No periodic loop, generic backlog, repeat archive search, terminal action or new code/test/runtime/profile/actor route.) payload: {\"msg_id\":\"coord-send-74e472667be5f1c5aef3c65c2ad44677838f5d5280ad8b7c68cc1d3bb716fb28\"} (event-wake delivery #508338 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
      "turn_idx": 12,
      "turn_origin": "wake-pump",
      "turn_origin_verdict": "agent-injected",
      "payload": {
        "msg_id": "coord-send-74e472667be5f1c5aef3c65c2ad44677838f5d5280ad8b7c68cc1d3bb716fb28"
      }
    },
    {
      "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "source_kind": "codex",
      "session_id": "01a0f822-783c-74c3-8595-7666d7381d41",
      "part_idx": 177,
      "ts": "2026-10-01 16:50:00.536+00",
      "text": "⟦turn-origin:wake-pump nonce:09c46be16e4a7387⟧\n[await-event] coord:inbox-wake:su-fc5749a7-6632-4f73-9c99-8b475641e7e2 fired — Avi lifts the earlier pause: resume your work now from your checkpoint.. (your note: always-armed inbox-wake (turn-lifecycle-control)) payload: {\"msg_id\":\"coord-send-59113225eb0c7252ac99d68d9460da0a8432b51ccf0639b6b110cc9f96b22990\"} (event-wake delivery #397436 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
      "turn_idx": 20,
      "turn_origin": "wake-pump",
      "turn_origin_verdict": "agent-injected",
      "payload": {
        "msg_id": "coord-send-59113225eb0c7252ac99d68d9460da0a8432b51ccf0639b6b110cc9f96b22990"
      }
    },
    {
      "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "source_kind": "codex",
      "session_id": "01a10d20-5de7-75b3-98c5-9d58d727e20b",
      "part_idx": 69,
      "ts": "2026-10-05 17:46:56.761+00",
      "text": "⟦turn-origin:wake-pump nonce:77d978ac1efb499f⟧\n[await-event] coord:inbox-wake:su-fc5749a7-6632-4f73-9c99-8b475641e7e2 fired — Handoff received; I have claimed WI-10004837/P-010 and P-012 in AUTO under D-021. Recovering your existing task/logs, no duplicate launch.. (your note: headless launch-agent inbox-wake) payload: {\"msg_id\":\"coord-send-83030667025aaf601d27d3763c2fbf8b60ace4873b1a7056cdb06fe84a2d7392\"} (event-wake delivery #432238 — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.) NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox's cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.",
      "turn_idx": 14,
      "turn_origin": "wake-pump",
      "turn_origin_verdict": "agent-injected",
      "payload": {
        "msg_id": "coord-send-83030667025aaf601d27d3763c2fbf8b60ace4873b1a7056cdb06fe84a2d7392"
      }
    }
  ],
  "limits": [
    "Injected source is message custody, not literal owner attribution. Follow exact payload.msg_id before applying any stop/handoff/resume at cutoff.",
    "All seven final-cutoff classifications, original018 and whole116 remain unaccepted; outcomes0."
  ]
}
