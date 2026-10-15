---
rel_path: "member-custody/su-f0605073-b8b5-4d20-bab5-566dea3222ab/checks.json"
updated_at: 1791506775513
_body: "content"
---

{
  "current": [
    {
      "claim": "Restoration identity inherited fleet spec6/cap1.",
      "id": "restoration-membership-spec",
      "recheck": "On an admitted canonical feature event read own identity and own concrete ownerId claim spec on staging3170.",
      "falsifier": "Owner differs, membership absent, source is bee/default, revision differs from6 or maxConcurrentClaims differs from1.",
      "verified": "This turn staging3170 whoami/get_claim_spec read confirmed member, source=fleet, revision6 and cap1. @2026-10-09T00:32:16.952Z",
      "sinceMs": 1791505915057
    },
    {
      "claim": "Native Codex config uses unpinned gateway.",
      "id": "native-account-config",
      "recheck": "Read safe current CODEX_HOME config model_provider/base_url/header names without credential values.",
      "falsifier": "Selected provider is not gateway, base_url bypasses gateway, or selected provider has an account pin header.",
      "verified": "Session38388 config selected papercusp-codex-gateway8788/v1 and no account pin header. @2026-10-09T00:32:16.952Z",
      "sinceMs": 1791505915057
    },
    {
      "claim": "Canonical feature watch survived loop end.",
      "id": "standing-feature-wake",
      "recheck": "If delivery eligibility is uncertain inspect exact await251818; status wake never authorizes a pull.",
      "falsifier": "Await251818 is cancelled, absent, expired or not wake=true while session is supposed to wait on it.",
      "verified": "loop:end receipt generation3 survivingAwait251818 work-item:claimable expires=null. @2026-10-09T00:32:16.952Z",
      "sinceMs": 1791505915057
    },
    {
      "claim": "This delayed wake found the engine loop already inactive with a canonical feature await retained.",
      "id": "delayed-wake-reconciliation",
      "recheck": "Read loop:status only if another delayed lifecycle wake makes state uncertain; never treat that wake as feature-claim authorization.",
      "falsifier": "The read is for a different owner or shows loop.active=true or no canonical work-item:claimable await.",
      "verified": "Current staging3170 loop:status returned correct owner, active=false, disarmed loop-end transition, stored carry hash01c36269a874 and pendingAwaits work-item:claimable. @2026-10-09T00:34:08.659Z",
      "sinceMs": 1791506048659
    }
  ],
  "initial": "not returned by initial loop:status; absence not inferred"
}
