---
rel_path: "evidence/ei267764-c6-pinned-artifact-replay-20261024-v1.json"
updated_at: 1792866805792
_body: "content"
---

{
  "schemaVersion": "c6-pinned-artifact-replay-evidence-v1",
  "taskId": "0mvmqke5gtcjuf2114l",
  "exitCode": 0,
  "logPath": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-32818c4e-b94.log",
  "receipt": {
    "schemaVersion": "c6-pinned-artifact-read-only-replay-v1",
    "owner": "su-c6a2f794-088d-426c-8b37-752b114d6398",
    "advSessionId": 46017,
    "selectedIdentityPresent": false,
    "legacyReplayAvailable": false,
    "maintainedUnselectedReplayAvailable": true,
    "specificationRevision": "402feed997e540dd6a35df7770a9f0ed91c342ca07ae113634731a668093b586",
    "replayedSpecificationRevision": "402feed997e540dd6a35df7770a9f0ed91c342ca07ae113634731a668093b586",
    "promptSha256": "05649ae73194f35fac0114d2cb0cf0bf94e81ae8cf2883d250bcf37a2e3bc861",
    "promptCharacters": 197322,
    "sqliteHome": null,
    "sourcePins": {
      "packages/operator-core/lib/su-persona-render.ts": "40b9d301df687c7207f2f1a8c3659144ca63f0aec76cb694c054880899881754",
      "packages/operator-core/lib/adv-sessions.ts": "eac21919239758c05e9e7ac02b3b66dd2ac841ae08ea6daa2432dc7dcf6a244b"
    },
    "scope": "Read exact original ADV owner and launch record; maintained pure artifact replay only. No renderer rebuild, identity/funding admission, home write, POST, host/control operation, native/provider/test/fullcopy replay, fullR or budget validation."
  },
  "limitations": [
    "Original native/context and host runtime were not exercised.",
    "Exact old9071 HTTP500 exception remains unknown.",
    "Null saved codexSqliteHome is a missing binding; it is not evidence the actual SQLite home is absent.",
    "No identity/funding/home-ownership or control admission.",
    "D005 is preparation integrity only; fullR, independent-method and historical-custody predicates remain open."
  ]
}

