---
rel_path: "evidence/identity-assume/recovery29/binding-cleanup-final.json"
updated_at: 1792888762131
_body: "content"
---

{
  "previousManifest": {
    "slug": "papercusp",
    "rel_path": "evidence/identity-assume/recovery28/proof-manifest-final.json"
  },
  "retiredBindings": {
    "68195": 69380,
    "68197": 69377,
    "68198": 69373,
    "68199": 69374,
    "68200": 69376,
    "68201": 69375,
    "68204": 69381,
    "69363": 69373,
    "69364": 69374,
    "69367": 69380,
    "69368": 69381,
    "69436": 69466,
    "69444": 69465,
    "69445": 69464,
    "69446": 69463,
    "69451": 69462,
    "69452": 69465,
    "69453": 69464,
    "69454": 69463,
    "69455": 69466,
    "69456": 69462
  },
  "activeBindingIds": "69466,69465,69464,69463,69462,69437,69388,69382,69381,69380,69379,69378,69377,69376,69375,69374,69373",
  "currentness": {
    "current": 17,
    "stale": 0,
    "unknown": 0
  },
  "adequacy": [
    {
      "specId": "CALLER-RECOVERY",
      "verdict": "pass",
      "wouldBlock": []
    },
    {
      "specId": "TARGET-EXACT",
      "verdict": "fail",
      "wouldBlock": [
        "correct-layer"
      ]
    },
    {
      "specId": "TARGET-LIVE-REFUSAL",
      "verdict": "pass",
      "wouldBlock": []
    },
    {
      "specId": "TARGET-SCOPE-REFUSAL",
      "verdict": "pass",
      "wouldBlock": []
    },
    {
      "specId": "TARGET-UNKNOWN-REFUSAL",
      "verdict": "fail",
      "wouldBlock": [
        "correct-layer"
      ]
    },
    {
      "specId": "TRANSITION-CONTENDED-CUSTODY",
      "verdict": "pass",
      "wouldBlock": []
    }
  ],
  "status": "P001 nonterminal. Clean committed native6 integration proof pending. No completed mutant was repeated.",
  "pendingAwait": {
    "id": 363197,
    "event": "resource:released:git-sync:papercusp",
    "expires": "2026-10-25T00:47:36.068Z"
  },
  "holds": "No author/live-peer takeover. Retain native execution, custody, admission and release holds. No LIVE_GATE_OPS."
}
