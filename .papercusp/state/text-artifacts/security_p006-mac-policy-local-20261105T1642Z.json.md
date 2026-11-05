---
rel_path: "security/p006-mac-policy-local-20261105T1642Z.json"
updated_at: 1793896950381
_body: "content"
---

{
  "schema": "p006-local-proof-v1",
  "at": "2026-11-05T16:42Z",
  "workItem": "WI-6554700010044291",
  "stampItem": "WI-6554700010045189",
  "scope": "Current local development only; no SEC acceptance or signed/installed artifact claim.",
  "sources": {
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "7e271a6a795a2e5516b8bac9d2dee0aab233ff5ee335be0979ac59fa20c5f395",
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "e6be9fc6221a9fdd48e90dddeb10462d37a3f9eb8363ecd9c54e01e719d4825c",
    "packages/operator-core/lib/managed-update-policy.ts": "2e07ffa4591eb1b9a3bb115901772589282cfe0036671c24a8f43b8f19be50eb",
    "packages/operator-core/lib/managed-update-policy.test.ts": "51e010f09fbd724fa3733d54bdffe95d70e8ce5160e5df7f192ae408d6d1625b",
    "packages/operator-core/lib/endpoint-route/routes/misc/updates-managed-policy.test.ts": "f365124434ce62bc189edec877f00637362e5a9985b4fced22503b4e19da099b"
  },
  "runs": [
    {
      "task": "0mw3rgbruk29iygd1vf",
      "log": ".papercusp/scratch/bash-ce4f8e3b-f3c.log",
      "exit": 0,
      "result": "Native consumer and bounded diagnostic regression: 2 selected passed, 3 filtered. Explicit umask 0002; inherited-ancestor fixture corrected."
    },
    {
      "task": "0mw3risvnvrdz9o1bb5",
      "log": ".papercusp/scratch/bash-da7b04b9-cd3.log",
      "exit": 1,
      "result": "Maintained policy reader 85 passed. Combined run had 1 obsolete endpoint rollback fixture failure; endpoint subsequently corrected and verified in separate job."
    },
    {
      "task": "0mw3rj9lt8ls97kqih5",
      "log": ".papercusp/scratch/bash-cfb2d629-105.log",
      "exit": 0,
      "result": "Scoped typecheck of 3 files clean."
    },
    {
      "task": "0mw3ronluk92bwo1se9",
      "log": ".papercusp/scratch/bash-552987c9-d03.log",
      "exit": 0,
      "result": "Managed endpoint suite 9 passed, 0 skipped, requested/executed/matched 1/1/1. Adopted from durable task after carry."
    },
    {
      "task": "0mw3rno8m1eg3eg62cr",
      "log": ".papercusp/scratch/bash-fd41f8fd-9da.log",
      "exit": 0,
      "result": "Scoped endpoint test typecheck clean, 1 named file. Adopted after carry."
    }
  ],
  "correction": "404 companion response deliberately means legacy compatibility. Refusal fixture now uses unavailable 503; third attempt pre-audited in checkpoint80cafcdc8c02.",
  "holds": [
    "Mac privileged install seam incomplete",
    "Production empty author set refuses; authenticated author provenance incomplete",
    "All prior review/SEC/installation/signed-artifact holds remain open",
    "No new implementation agents or LIVE_GATE_OPS"
  ],
  "next": "Implement a narrow protected Mac installer reusing update_authorization verifier, managed policy and activation lock; preserve macOS 10.15."
}
