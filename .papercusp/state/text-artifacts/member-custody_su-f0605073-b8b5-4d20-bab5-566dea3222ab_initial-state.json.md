---
rel_path: "member-custody/su-f0605073-b8b5-4d20-bab5-566dea3222ab/initial-state.json"
updated_at: 1791506775513
_body: "content"
---

{
  "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38388/sessions/2026/10/08/rollout-2026-10-08T20-20-54-01a11e08-c686-7b21-9f7f-22d0e23950c9.jsonl",
  "receipts": [
    {
      "at": "2026-10-09T00:25:48.054Z",
      "call_id": "call_729217f5fbaf4b26a1a9efe51e45e86c",
      "value": {
        "ok": true,
        "ownerId": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
        "loop": {
          "active": true,
          "carry": "warm",
          "name": "loop-su-f0605073-b8b5-4d20-bab5-566dea3222ab",
          "ownerId": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
          "harnessSlug": "papercusp",
          "intervalSec": 60,
          "continuation": "settle",
          "mode": "work",
          "monitor": null,
          "monitorStanddown": null,
          "standdown": null,
          "goal": "Drive claim-spec lane `fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds` in fleet `nonp2p-feature-drain-sol61-xhigh-0930` (scheduler:get_next in harness `papercusp` pulls your lane).",
          "fireCount": 1,
          "firesSinceArm": 1,
          "parked": true,
          "nextFireAt": null,
          "lastFiredAt": "2026-10-09T00:22:13.103Z",
          "armedAt": "2026-10-09T00:20:35.134Z",
          "expectedFiresSinceArm": 5,
          "effectiveIntervalSec": 97.969,
          "cadenceRatio": 1.6328166666666666,
          "longestObservedGapSec": null,
          "cadenceDrift": false,
          "costCapCents": null,
          "maxFires": null,
          "maxDurationSec": null,
          "stalled": false,
          "stalledSinceMs": null,
          "fireStarved": false,
          "lastDeliveryOutcome": "queued",
          "consecutiveErrors": 0,
          "lastWithheldAt": null,
          "lastWithheldReason": null,
          "lastWakeChannel": "suppressed-redundant",
          "lastWakeStatus": "delivered",
          "lastWakeAt": "2026-10-09T00:23:15.394Z",
          "lastWakeError": null,
          "lastTurnAt": null,
          "lastLoopTurnAt": null,
          "lastFailedFireLoopTurnCompletedAt": null,
          "lastRealTurnAt": null,
          "turnsStalled": false,
          "parkedForSec": 208,
          "lifecycleBackoff": null
        },
        "rewake": {
          "rewakeGuaranteed": false,
          "reason": "last-fire-no-loop-turn"
        },
        "lastTransition": {
          "status": "found",
          "transition": {
            "at": "2026-10-09T00:22:13.827Z",
            "event": "parked",
            "actor": "claim-due-routine",
            "newNextFireAt": null,
            "intervalSec": 60,
            "detail": null
          },
          "cycle": {
            "phase": "turn-in-flight",
            "turnInFlightSec": 207,
            "lastTurn": null,
            "basis": "turnSec = parked->rearmed: the member's own turn (next_fire_at is infinity while parked), NOT a re-arm delay. postSettleDelaySec = rearmed->next parked: what the re-arm actually cost (~intervalSec + <=30s reconcile tick). loop.cadenceRatio / effectiveIntervalSec include the turn by construction."
          }
        },
        "carryNote": {
          "note": null,
          "contentHash": null,
          "updatedAtMs": null
        },
        "reachability": {
          "reachable": true,
          "channel": "psu-socket",
          "durableWhileAlive": true,
          "summary": "live psu-host control socket — wakes inject in place as a fresh turn"
        },
        "pendingAwaits": {
          "status": "none",
          "scope": "non-inbox-wake"
        },
        "awaitSuppression": null
      }
    },
    {
      "at": "2026-10-09T00:25:48.054Z",
      "call_id": "call_729217f5fbaf4b26a1a9efe51e45e86c",
      "value": {
        "ok": true,
        "ownerId": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
        "loop": {
          "active": true,
          "carry": "warm",
          "name": "loop-su-f0605073-b8b5-4d20-bab5-566dea3222ab",
          "ownerId": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
          "harnessSlug": "papercusp",
          "intervalSec": 60,
          "continuation": "settle",
          "mode": "work",
          "monitor": null,
          "monitorStanddown": null,
          "standdown": null,
          "goal": "Drive claim-spec lane `fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds` in fleet `nonp2p-feature-drain-sol61-xhigh-0930` (scheduler:get_next in harness `papercusp` pulls your lane).",
          "fireCount": 1,
          "firesSinceArm": 1,
          "parked": true,
          "nextFireAt": null,
          "lastFiredAt": "2026-10-09T00:22:13.103Z",
          "armedAt": "2026-10-09T00:20:35.134Z",
          "expectedFiresSinceArm": 5,
          "effectiveIntervalSec": 97.969,
          "cadenceRatio": 1.6328166666666666,
          "longestObservedGapSec": null,
          "cadenceDrift": false,
          "costCapCents": null,
          "maxFires": null,
          "maxDurationSec": null,
          "stalled": false,
          "stalledSinceMs": null,
          "fireStarved": false,
          "lastDeliveryOutcome": "queued",
          "consecutiveErrors": 0,
          "lastWithheldAt": null,
          "lastWithheldReason": null,
          "lastWakeChannel": "suppressed-redundant",
          "lastWakeStatus": "delivered",
          "lastWakeAt": "2026-10-09T00:23:15.394Z",
          "lastWakeError": null,
          "lastTurnAt": null,
          "lastLoopTurnAt": null,
          "lastFailedFireLoopTurnCompletedAt": null,
          "lastRealTurnAt": null,
          "turnsStalled": false,
          "parkedForSec": 203,
          "lifecycleBackoff": null
        },
        "rewake": {
          "rewakeGuaranteed": false,
          "reason": "last-fire-no-loop-turn"
        },
        "lastTransition": {
          "status": "found",
          "transition": {
            "at": "2026-10-09T00:22:13.827Z",
            "event": "parked",
            "actor": "claim-due-routine",
            "newNextFireAt": null,
            "intervalSec": 60,
            "detail": null
          },
          "cycle": {
            "phase": "turn-in-flight",
            "turnInFlightSec": 203,
            "lastTurn": null,
            "basis": "turnSec = parked->rearmed: the member's own turn (next_fire_at is infinity while parked), NOT a re-arm delay. postSettleDelaySec = rearmed->next parked: what the re-arm actually cost (~intervalSec + <=30s reconcile tick). loop.cadenceRatio / effectiveIntervalSec include the turn by construction."
          }
        },
        "carryNote": {
          "note": null,
          "contentHash": null,
          "updatedAtMs": null
        },
        "reachability": {
          "reachable": true,
          "channel": "psu-socket",
          "durableWhileAlive": true,
          "summary": "live psu-host control socket — wakes inject in place as a fresh turn"
        },
        "pendingAwaits": {
          "status": "none",
          "scope": "non-inbox-wake"
        },
        "awaitSuppression": null
      }
    }
  ],
  "initialCarry": null,
  "initialChecksWalls": "not returned by initial loop:status; no initial carry note was present"
}
