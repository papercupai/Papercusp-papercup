---
rel_path: "evidence/identity-assume/recovery30/proof-manifest-native31.json"
updated_at: 1792890267109
_body: "content"
---

{
  "priorManifest": "papercusp:evidence/identity-assume/recovery29/binding-cleanup-final.json",
  "artifacts": [
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-source-map.json.gz.b64",
      "bytes": 9630967,
      "sha256": "3d644f153970e82bd6b53ac574a54153dcd7fbd5de6e04820ce84ed210ad7cf5"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-receipt.json.gz.b64",
      "bytes": 3074,
      "sha256": "e345f5c0310d1fcbc2fec74b726161a08d3419e1bbca86d7055e324b753896b4"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31.log.gz.b64",
      "bytes": 869390,
      "sha256": "b6f147d92d199055de4e34af972769a6c48ab9a87c0e69fadce62dfc251c2340"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-materialize.log.gz.b64",
      "bytes": 12447,
      "sha256": "612b1905f95551c75638209d8f01f029118ba91cdb9d075e4ba7a9d199bd4ce0"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-manifest.json.gz.b64",
      "bytes": 568,
      "sha256": "b2bc2cde6684924f9beb49b69630389b55cf5efae0c67acee24c7b182f31c421"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-bind-input.json.gz.b64",
      "bytes": 8373,
      "sha256": "79c10e7f38ccaab3e2c2f2fb63cfbcbac3b7cae02cef80ca974630340b71b29d"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-bind.json.gz.b64",
      "bytes": 915,
      "sha256": "05b1bf762372b3ae9f9d7f6e901455256c3aa862c00d7079e7abb7e9e8bf5fc2"
    },
    {
      "path": "evidence/identity-assume/recovery30/assume-clean-native31-adequacy.json.gz.b64",
      "bytes": 1064,
      "sha256": "99797097a95551ac038ae61f6531610af3522f313378661b60251158fc73f9dc"
    }
  ],
  "commit": "bc14dfe85a71cfc0c11805bd8dd37a8f485f09f0",
  "nativeTestRunId": 21954203,
  "nativeBindingIds": [
    69530,
    69531,
    69532,
    69533,
    69534,
    69535
  ],
  "nativeVerdict": "6 passed, zero failed/skipped/unhandled; clean tree; exact selected module population; onTestRunEnd; private PG stopped; wrapper exit0",
  "adequacy": {
    "nativeCurrent": {
      "current": 6,
      "stale": 0,
      "unknown": 0
    },
    "retracted": [
      {
        "id": 69437,
        "status": "retracted",
        "ok": true
      },
      {
        "id": 69379,
        "status": "retracted",
        "ok": true
      }
    ],
    "adequacy": [
      {
        "specId": "CALLER-RECOVERY",
        "verdict": "pass",
        "wouldBlock": []
      },
      {
        "specId": "TARGET-EXACT",
        "verdict": "pass",
        "wouldBlock": []
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
        "verdict": "pass",
        "wouldBlock": []
      },
      {
        "specId": "TRANSITION-CONTENDED-CUSTODY",
        "verdict": "fail",
        "wouldBlock": [
          "freshness"
        ]
      }
    ]
  },
  "remaining": "TRANSITION-CONTENDED-CUSTODY freshness only: previous race mutation69388 uses old native fixture. Re-run that single distinct reservation-bypass race mutant on current committed fixture; five clause mutants69462..66 remain current and MUST NOT be repeated. Then replace69388, re-evaluate/certify six clauses, finish P001 and ordered dependent plan work.",
  "holds": "No author/live-peer takeover; preserve native/custody/admission/release holds; no LIVE_GATE_OPS or unrelated backlog."
}
