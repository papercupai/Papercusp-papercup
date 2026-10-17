---
rel_path: "audits/parked-agent-resumption-2026-10-09/original-loop844090-pickup-and-old-api-fallback-424d5.json"
updated_at: 1792138747269
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-26122701741931277",
  "parent": "WI-6554700010008887",
  "native": {
    "sourcePath": "/home/marsh-office/.papercusp/su-codex-homes/session-40770/sessions/2026/10/16/rollout-2026-10-16T03-59-16-01a143b8-f193-7111-94c6-543e764775c2.jsonl",
    "nativeId": "01a143b8-f193-7111-94c6-543e764775c2",
    "origin": {
      "line": 270,
      "at": "2026-10-16T08:10:09.043Z",
      "head": "⟦turn-origin:loop-fire nonce:9dbd52af3a71eec4⟧",
      "textSha256": "51acd1d37861cc992814f23dd7c8071ca9fd30829442e1b4e5adfca66e6d9cf1"
    },
    "assistant": {
      "line": 276,
      "at": "2026-10-16T08:10:27.707Z",
      "text": "This is the actual loop-fire envelope for delivery `844090`, and this reply provides an authored response to it. I’ll reconcile that pickup with the inbox fallback record, then investigate why the durable dispatcher abandoned a delivery the host still held.",
      "textSha256": "67a150f60bd048e8f004c2e7e0ec083208d9ce2bd854af44e10e5f9e9f4630ab"
    },
    "authoredBeforeNextUser": true
  },
  "delivery": {
    "delivery_id": 844090,
    "subscriber_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
    "status": "delivered",
    "channel": "inbox",
    "turn_invoked": false,
    "attempts": 8,
    "source": "loop:rt_papercusp_loop_su_424d5476_0b13_401a_a926_0aaa9f212391",
    "last_error": null,
    "created_at": "2026-10-16T08:01:18.309Z",
    "delivered_at": "2026-10-16T08:07:17.679Z"
  },
  "exactJournal": {
    "unit": "papercusp-dev-api.service",
    "pid": 2061578,
    "at": "2026-10-16T08:07:17.681103Z",
    "message": "wake #844090 exhausted 8 parked attempts -> degraded to inbox; last park psu-host pending-delivery-id",
    "evidenceTask": "0mvap18833jd45i1ly7"
  },
  "releaseBundle": {
    "path": "/home/marsh-office/papercupai-workspace/papercup-release/apps/operator/dist-host/hono-host.mjs",
    "hostCommitPendingOccurrences": 0,
    "runtimeSha": "d740fc3802",
    "runtimeReportedAt": "2026-10-16T07:52:34.582006Z"
  },
  "currentBackground": {
    "unit": "papercusp-bg-host.service",
    "pid": 183970,
    "bundlePath": "/home/marsh-office/papercupai-workspace/papercusp/apps/operator/dist-host/hono-host.mjs",
    "hostCommitPendingOccurrences": 9,
    "evidenceTask": "0mvaoz6h283p96vcwyp"
  },
  "sourceGuards": {
    "engine": {
      "path": "packages/operator-core/lib/events/await/engine.ts",
      "sha256": "858d1df326ea85d83cae440a9780d3cc14ee521c3c88d9d1b05f1860d58594c0"
    },
    "executor": {
      "path": "packages/operator-core/lib/events/await/wake-executor.ts",
      "sha256": "52dd510ec67aa53b1db919166f46b036bf7b72985f4e0da855dc160c68dfa98f"
    },
    "tests": {
      "path": "packages/operator-core/lib/events/await/engine.test.ts",
      "sha256": "8ea6966cedbf4376ca03672813c9ca58405ff2acdaf7b52cc1f3907fbfbd80c4"
    },
    "workingEqualsCommitted": true,
    "maintainedCase": "keeps an accepted pending ordinary/cold/warm psu-host delivery parked at the retry cap until late host settlement"
  },
  "diagnosis": "Old live API workers pump wake deliveries without the committed hostCommitPending protection. The accepted host write survives the ledger fallback and later produces the original loop turn.",
  "releaseDependency": {
    "workItem": "EI-26021298472031742",
    "assignee": "su-1060d53c-ee1c-4bf1-b065-da45888a9c20"
  },
  "limits": [
    "No new test or matrix execution",
    "No manual fire/rearm/compaction",
    "No LIVE_GATE_OPS",
    "This is one verified original pickup, not proof of every future delivery",
    "R14 all-fixes runtime anchor absent; actual24h unstarted"
  ]
}
