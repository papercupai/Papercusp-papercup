---
rel_path: "audits/held-agent-resumption-2026-10-12/hydration-fix-status-2026-10-13.md"
updated_at: 1791910575942
_body: "content"
---

# Saved recovery roster downgrade — source fix verified

Avi, the stale-hydration overwrite class is now reproduced and fixed in staging. The live background host has not yet been verified to contain the fix, so aggregate repair remains stopped and the issue stays open.

The 16:12 UTC edition was saved and read back with 202 confirmed replies/activity and 62 unconfirmed targets. A later direct PostgreSQL read returned an older 199/65 edition. These are conflicting editions; the later read does not invalidate the earlier verified result. The newer captured edition remains in git-export outbox record 45751.

Both regressed database bodies and their timestamps exactly match the older `.papercusp/state/text-artifacts` files. Newer verified revisions remain queued with `exported_at = NULL`. The existing boot path calls `hydrateGitTable` before starting the export drain; hydration unconditionally replaced database rows from those files while capture was disabled. A new maintained real-PostgreSQL test reproduced that sequence: old content at revision 100 replaced a verified union at revision 200 while its export remained pending. This establishes the overwrite class. The exact live importing process has not been identified.

The change extends the existing hydration upsert with an atomic comparison of artifact `updated_at`. Older imports are skipped; clone imports, newer revisions and edits at an equal revision still work. The applied-row count now reflects the rows returned by PostgreSQL. Two canonical staging files changed: `packages/operator-core/lib/harness-state/git-export/hydrate.ts` and its existing `git-export.integration.test.ts`. No new store, tool, routine or flag was introduced.

Verification: the new regression failed before the fix. Afterwards, all 15 tests in the git-export and boot integration suites passed. The same 15 tests passed through the maintained `with-test-pg --isolated-runtime` route with exit code 0; its cleanup receipt confirmed removal of both the private runtime and database. `git diff --check` passed. The independent runtime lookup reported `bg-host.containsChange = false`, so these results are current-source and isolated-runtime evidence, not a live deployment claim.

The two new 01864 replies are preserved in `papercusp:audits/held-agent-resumption-2026-10-12/pickup-01864-original-reply.json`; both replies were answered. They confirm activity on the original coordination identity. EI-25544613413335431 remains under the delivered 87fe0 custody, with no claim transfer or held-gate monitoring authorized. No new aggregate total was computed after the downgrade.

EI-25858658863255291 remains open for runtime adoption and protected reconciliation. Successor evidence is saved and read back at `papercusp:audits/held-agent-resumption-2026-10-12/successor-brief-sourcefix-2026-10-13.json`. It names the captured 202/62 edition, all eleven historical proof paths, nine owners and sixteen exact refs, plus the new reply proof. Before any aggregate restoration, reload that full union and resolve its exact sources; preserve every prior confirmation. No monitoring loop was armed.

The [earlier continuation report](/reports?sel=rpt_e448e456-48cd-4851-8270-3638a446c4e1) remains a dated historical source.

