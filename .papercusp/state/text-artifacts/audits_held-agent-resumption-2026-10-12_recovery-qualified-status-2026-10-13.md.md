---
rel_path: "audits/held-agent-resumption-2026-10-12/recovery-qualified-status-2026-10-13.md"
updated_at: 1791927166221
_body: "content"
---

# Held-agent recovery and hydration qualification

Avi, the saved recovery roster now contains **207 agents with confirmed activity or replies**, **57 unconfirmed targets**, and **54 exclusions**. The targeted population remains 264. Confirmation establishes original coordination-identity activity; it does not establish native session continuity, provider resolution, or technical task completion.

The new su-1020321d replies preserve its existing EI-25223159069515108 lane, cap of two claims, stopped P004, D-152/WI-10006201 boundary and peer custody. The earlier ad62 productive-turn proof supplements its later custody correction without counting that agent twice. The full guard now covers 19 immutable proof files, 14 required owners and 26 exact message references. Every source was reloaded before each aggregate write; both saved records read back exactly, preserving earlier confirmations.

The hydration regression originated in an unconditional stale-file upsert into harness_text_artifacts before pending newer exports drained. The atomic revision comparison preserves newer PostgreSQL evidence. A separate validFiles count keeps an intentionally skipped stale file from being treated as a failed import when another file is malformed. Maintained PostgreSQL integration tests reproduced the overwrite before the fix and passed afterward: 16 passed, zero skipped. Current source and test hashes match that retained passing run. The background host at de3c697ace contains the latest change by blob comparison; staging operator 78cd58273a and release operator d740fc3802 do not contain that latest refinement. Final release promotion is not established. The exact historical importer remains unmeasured.

The hydration fix is qualified for structured closure. The parent recovery work remains open. No active native writer was overridden, no session was forked or relaunched, and no independent monitor or loop was created. The prior 1e14 writer/provenance boundary remains in force.

Evidence: papercusp:audits/held-agent-resumption-2026-10-12/final-dispositions.json; successor-brief-reconciled-2026-10-13.json; pickup-10203-original-reply.json; pickup-ad62-productive-turn.json; hydration-adoption-qualification-2026-10-13.json. Maintained tests: packages/operator-core/lib/harness-state/git-export/git-export.integration.test.ts and boot.integration.test.ts.

Earlier editions remain available: [reconciled recovery report](/reports?sel=rpt_4c748f3d-a52f-4f3f-b1a6-db03e3738013), [hydration fix report](/reports?sel=rpt_a143037b-a8fb-40a0-8495-862520dbfff0), and [continuation report](/reports?sel=rpt_e448e456-48cd-4851-8270-3638a446c4e1). Their counts and adoption status are dated snapshots.

