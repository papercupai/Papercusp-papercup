---
rel_path: "audits/parked-agent-resumption-2026-10-17-637d7/pickup-reconciliation-7947311d.json"
updated_at: 1792321544465
_body: "content"
---

{
  "schemaVersion": 1,
  "source": "audits/parked-agent-resumption-2026-10-17-637d7/final-edition.json",
  "workItem": "WI-6554700010017004",
  "observedAt": "2026-10-17T23:50:40Z",
  "scope": "The ten exact requests previously unconfirmed; this is a finite reconciliation, not an ongoing monitor.",
  "cases": [
    {
      "ownerId": "su-1634192e-4083-41e4-bd9b-00ae182d1436",
      "request": "coord-send-af32d52720a3b9c08c38e022ec75c3c73608e5be17b857c577252e63ec935bd1",
      "originalSentAt": "2026-10-17T22:42:07.422Z",
      "outcome": "recipient-replied",
      "reply": {
        "id": "coord-send-f3ff5043776d1cc87210867d63ff2c84ec33d6a272f222fd1743c3f3990dcd5a",
        "at": "2026-10-17T23:06:28.575Z",
        "summary": "Pickup acknowledged; existing installation-assumptions plan is now the primary lane under an explicit Avi directive; startup-diagnostics work is secondary."
      }
    },
    {
      "ownerId": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "request": "coord-send-9576f30c0cbf78b4f581b50f30325d09cc7f58ed756b9a1fcc2714ac493d2af5",
      "originalSentAt": "2026-10-17T22:43:06.659Z",
      "outcome": "recipient-replied",
      "reply": {
        "id": "coord-send-df199088f5a29d4342334ae16754f379644dbe8c92c51b686cdc00a2422b9dae",
        "at": "2026-10-18T09:44:28.551Z",
        "summary": "Authored exact-request reply confirms resuming existing custody lane; existing HOLD and no-runtime-grant limits remain."
      }
    },
    {
      "ownerId": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
      "request": "coord-send-3a9260d0f0fc67dbb133e240c693524447e2c053641fbe1681b43a9302ae8a6a",
      "originalSentAt": "2026-10-17T22:43:24.115Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-6788d0ac-d425-4756-a9b3-3a451df401be",
      "request": "coord-send-6c25784b47e5bec29392b40800c1a2d6e674af9f45bd57ac9acc4422557e26be",
      "originalSentAt": "2026-10-17T22:43:36.880Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-70d2e75c-1a9d-4a85-8cf8-1b85ddb5cb5b",
      "request": "coord-send-545eae693220e1bc2d392300e2f47d8318cd627c4f8c76cb26e83a4f2f12e1ba",
      "originalSentAt": "2026-10-17T22:43:37.314Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-ab841267-3bb8-4704-95ce-4e12b058f9f7",
      "request": "coord-send-6989e9f85931b01f8d7e701512779a55ffc8070ac94c4f22e97aea644f2e6d42",
      "originalSentAt": "2026-10-17T22:44:38.944Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-b36b4692-520c-4a71-ae87-d0399bd81c9e",
      "request": "coord-send-30b4d6cf6f983bddb5ffb5c57787be84a884ef38a111762b8b5dbf1ec98f81d8",
      "originalSentAt": "2026-10-17T22:44:55.067Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-d79d84cf-7fb9-4cda-a53c-aabdcf078517",
      "request": "coord-send-61c00d7991b1901e4c8cbe52b0a3ab2c60c289549a81729bbaa4f9a46859a6e1",
      "originalSentAt": "2026-10-17T22:44:58.480Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-e00ce77e-5502-49ad-8216-c39acd86768c",
      "request": "coord-send-bfb3cd2f8c7ef275814c0e9d67c41410171eedd999ec888ff7a43e083788a350",
      "originalSentAt": "2026-10-17T22:45:09.821Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    },
    {
      "ownerId": "su-f146f0a3-5ec9-4b19-bac2-b1903f1f6cb1",
      "request": "coord-send-7afd71898e977a601249328089e90d037a51fdfdf419e4a9bc665607402af155",
      "originalSentAt": "2026-10-17T22:45:10.723Z",
      "outcome": "pickup-unconfirmed",
      "reply": null
    }
  ],
  "currentEvidence": {
    "authoredReplies": "One exact related_msg_id reply present; nine sender-scoped inbox reads returned no entries.",
    "workItemsRead": {
      "mode": "complete",
      "requested": 40,
      "available": 40,
      "absent": 0,
      "unavailable": 0,
      "observedAt": "2026-10-17T23:44:51.891Z"
    },
    "roster": "Each of the remaining nine was returned as parked and wakeable in a targeted roster read. That is not native-host death or safe-recovery proof.",
    "deliveries": "Twelve exact recorded delivery IDs returned at 23:44:50Z with a same-scope positive control. Delivered status was not credited as pickup.",
    "finiteAuthoredReplyUpdate": {
      "observedAt": "2026-10-18T11:05:44.450Z",
      "source": "coord-send-df199088f5a29d4342334ae16754f379644dbe8c92c51b686cdc00a2422b9dae",
      "relatedMsgId": "coord-send-9576f30c0cbf78b4f581b50f30325d09cc7f58ed756b9a1fcc2714ac493d2af5",
      "from": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "authoredReplies": 2,
      "pickupUnconfirmed": 8
    }
  },
  "recoveryAttempt": {
    "request": {
      "resume": {
        "sessionId": "01a1407e-5e21-7c13-9744-904e8ea83ee9"
      },
      "fork": false,
      "workItem": "WI-6554700010017004",
      "idempotencyKey": "parked-audit-637d7-recovery-5715-20261017"
    },
    "actual": {
      "mode": "fork",
      "opened": 1,
      "kickoffPersisted": false,
      "reason": "kickoff-proof-timeout",
      "taskId": "0mvd1p8711s5bro11d4"
    },
    "containment": "processes:kill signalled only that task; subsequent exact kernel scope probe returned scopeExists:false, liveNonZombieMembers:0, zombies:0. Further recovery launches stopped.",
    "bug": "EI-26272392128549422"
  },
  "sourceVerification": {
    "release": "d740fc3802 converts live-source resume to fork even with explicit false",
    "current": "launch-agent.ts guards fork:false and refuses a live source before spawning",
    "focusedCommand": "npm run test:file -- packages/operator-core/lib/agent-tools/capability/launch-agent.test.ts -- --testNamePattern=explicit in-place resume|explicit fork:false|strict in-place recovery",
    "result": "passed; test runner head d1798e5563; skippedTests224; no release verification claimed"
  },
  "remaining": "Eight exact-pair pickup outcomes remain unconfirmed. Preserve source custody and safety holds; no resend, relaunch, runtime grant or monitoring is authorized by this finite evidence update. Roster implementation remains in progress on WI-6554700010017003; shipment is not verified."
}
