---
rel_path: "git-sync/content-errors/abdb5528667643aab5e1b431dd6c4cc69ec3962d90dbdf980bf2d093430b544b.json"
updated_at: 1793038121254
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp","files":[{"scope":"superproject","file":"packages/operator-core/lib/system-health/compute.ts","detectorKey":"quarantined-importer","error":"imports '../release-checkpoint-launch' → 'packages/operator-core/lib/release-checkpoint-launch.ts', which is EXCLUDED from this commit (held by su-96b7fe62-ee9a-4399-ad53-e30bc734d337 — turn-scoped hold (git-sync-turn-scoped-commit-hold P-002): edited during its editor's current turn; held from commit un…). Committing this file alone could leave HEAD without the dependency changes its import needs — holding it back until 'packages/operator-core/lib/release-checkpoint-launch.ts' is resolved.","fixerRole":"content-fixer","excludedRoot":"packages/operator-core/lib/release-checkpoint-launch.ts","excludedRootReason":"held by su-96b7fe62-ee9a-4399-ad53-e30bc734d337 — turn-scoped hold (git-sync-turn-scoped-commit-hold P-002): edited during its editor's current turn; held from commit un…"}]}
