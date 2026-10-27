---
rel_path: "audits/parked-29234/final-pickup.json"
updated_at: 1792985729802
_body: "content"
---

{
  "observedAt": "2026-10-26T03:22:59.659Z",
  "owner": "su-b28c0433-620c-47f4-bcdd-0aa1ae4cbdbe",
  "residue": "WI-6554700010029241",
  "rows": [
    {
      "id": "su-1c4234ac-daad-4171-8282-479adcf4c88a",
      "pickup": "confirmed-by-reply",
      "evidence": "coord-send-96b83f4a7e19bc854661097828f4dee8c1aa49f2aff0a651ffaaf9f922ea8425",
      "outcome": "Cleanup already complete; retain original receipt/claim hold. Initial cleanup-resume premise retracted.",
      "followup": "EI-27010228859294524"
    },
    {
      "id": "su-37bbb587-fec7-4f14-b016-555ddc708ecc",
      "pickup": "confirmed-by-reply",
      "evidence": "coord-send-12c07af29e765721bcc6f1fbf159c95800f990ce5252db2f6b806826eb722ac7",
      "outcome": "Same-session continuation acknowledged; independent disk writer/capability work."
    },
    {
      "id": "su-48e0ce16-442a-4961-8643-320a92d0c0fd",
      "pickup": "confirmed-by-post-send-activity",
      "evidence": "audits/parked-29234/prewake.json + pickup.json",
      "outcome": "Parked4720s at03:09:58.047Z to live22s at03:12:02.237Z. Later suspect advisory does not erase the observed pickup; completion not established."
    },
    {
      "id": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
      "pickup": "unconfirmed",
      "sessionState": "suspect",
      "pid": 3176839,
      "lastActiveSecAgo": 12049,
      "outcome": "No activity advance at final bounded check. Original admission-diagnostic read remains; scheduler pulls remain gated."
    },
    {
      "id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "pickup": "unconfirmed",
      "sessionState": "ended",
      "pid": null,
      "lastActiveSecAgo": null,
      "outcome": "Ended after queued wake; no verified post-send turn. No replacement authorized.",
      "notPickedUpEventAt": "2026-10-26T03:20:57.632451Z"
    }
  ]
}
