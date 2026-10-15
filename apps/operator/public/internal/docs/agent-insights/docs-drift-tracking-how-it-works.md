# How docs drift-tracking actually works (anchors → git → sweep → steward)
URL: /internal/docs/agent-insights/docs-drift-tracking-how-it-works

The full pipeline behind the Docs tab's fresh/stale badges — subject_ref anchors, git-log drift detection, the post-git-sync sweep with its GIN reverse index, and the doc-steward dispatch. Read this before touching doc freshness or answering \"how do docs stay current?\".

Audited end-to-end 2026-07-13 (code as the only source of truth) so the next
agent doesn't have to re-derive it. Plans: harness-docs-integration-2026-06-05,
docs-corpus-audit WS2.

## The pipeline in one paragraph

Every doc carries a typed **anchor** (`subject_ref`) declaring *what code it
documents*; drift detection is **plain git** — `git log <baseline>..HEAD -- <anchored paths>` non-empty ⇒ stale; the check runs **after every git-sync
tick** via a cheap reverse-index prefilter; and a flagged doc **closes the
loop** — generated docs get a regeneration enqueued, manual docs get a
re-verify flag, and a single **doc-steward agent** is dispatched to re-sync
the drifted batch.

## 1. Anchors — `subject_ref` (subject-ref.ts, manual-anchor.ts)

Three strategies, all reducing to concrete repo paths:

* `path` — glob(s), used verbatim as git pathspecs.
* `symbol` — `file :: name`, traced precisely with `git log -L :name:file`
  so an unrelated edit elsewhere in the same file does NOT flag the doc
  (file-level `--follow` fallback when `-L` can't run).
* `feature` — `F-NNN` / `WI-NNN`, resolved to the work-item's recorded
  implementing commits → the files those commits touched.

Manual docs declare anchors via a `documents:` frontmatter key (this very file
does); otherwise refs are best-effort **inferred from repo paths mentioned in
the body**. An unanchored doc is allowed but surfaces as **"Not
drift-tracked"** — the old silent-rot mode made visible instead of hidden.

## 2. Baseline + detection (drift.ts)

* Baseline: `generated_from_sha` for generated docs, `last_verified_sha` for
  manual docs (set by the verify action → HEAD).
* Stale ⇔ `git log <baseline>..HEAD -- <resolved paths>` returns commits.
* Honest edges (accepted in D-001): whitespace/comment-only commits can
  false-nudge (a false nudge beats silent rot); renames handled with
  `--follow`; anchors under **git submodules** are routed INSIDE the submodule
  against the gitlink-recovered baseline (else they never flag); any git/
  baseline error maps to status `unknown` ("can't tell"), never a confident
  fresh/stale.

## 3. When it runs (freshness-sweep.ts, sweep-after-sync.ts)

After each git-sync `synced`, the tick's changed paths are intersected with
the denormalised **reverse index** — per-record `anchor_paths text[]`,
GIN-indexed (migration 172) — and only the intersecting docs pay for the
precise git confirm. On-demand recompute exists per doc
(`GET /api/harness/:slug/docs?path=<docId>&recompute=1`). The whole bridge is
best-effort and swallowed on failure: it must never wedge git-sync.

## 4. Closing the loop (doc-steward-dispatch.ts)

Newly-drifted docs dispatch ONE **doc-steward** agent (gate:
`papercusp-doc-steward`; batch-capped with a dispatch cooldown per WI-2104 —
the old whole-set-per-spawn pattern burned 58% of spawns at timeout). Each
drifted doc is handed with its `anchorPaths`, the drift reason, and the
**work-items that changed the anchored code** (derived from
`git_sync_commit_attribution`, D-006) so the steward reads intent instead of
reverse-engineering diffs.

## 5. Statuses + UI (AdvDocsTab.tsx, routes/harness/docs.ts)

`fresh | stale | review | untracked | unknown` — badges "⚠ May be out of
date" / "Not drift-tracked", nav freshness dots, and the close-the-loop verbs:
`POST /api/harness/:slug/docs/{verify|regenerate|overlay|anchor}`.

## Gotchas worth knowing before you touch this

* The reverse index (`anchor_paths`) is denormalised — if you change how
  anchors resolve, the sweep prefilter and the precise confirm can disagree.
* `symbol` anchors get file-level fallback on rename/removal; expect
  occasional over-flagging there, by design.
* Docs under submodule paths are only correct because of the explicit
  submodule routing in drift.ts — don't "simplify" it away.

## Public manual and FAQ maintenance

The public manual is file-authoritative at `apps/papercusp-docs/src/content/docs/`.
Its tracked FAQ id is `manual/faq.mdx`; the `manual` source mapping resolves this
id to that public tree. Keep the guide and FAQ there. The engineering corpus
remains private; copying it into the manual is not a maintenance route.

For the initial cloud-portal-docs-and-papercup-faq-2026-10-06 delivery, the
accountable technical maintainer is `su-73f621d7-bae1-4bbb-b045-a11b5c47a384`
under WI-10006921 and the shipment item WI-10006846. Responsibility transfers
only through a recorded handoff to a named assignee. A stopped session or a
`fresh` badge does not transfer responsibility. The existing doc-steward
mechanism requests repairs; every repair must have an assigned work-item and
an exact-revision review record before its reviewer calls it complete.

Sensitive review responsibilities follow the actual source:

| Answer family                         | Source expertise and guide to review alongside the FAQ                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription, allowances and checkout | Hosted billing: `auth/hosted/billing/entitlement-seam.ts`; accounts and billing guide. Portal checkout claims also require the portal billing implementation.         |
| Cloud lifecycle and provider costs    | Workspace host: `workspace-host/hosted-provider-delegation.ts`; cloud workspaces guide.                                                                               |
| Permissions, privacy and credentials  | Auth/access: `agent-tools/access/create.ts`; remote access and account guides. Never infer a retention policy or wider credential access from a successful retrieval. |
| Backup, deletion and recovery         | Backup: `agent-tools/backup/snapshot_create.ts` and `agent-tools/backup/restore.ts`; harness snapshots and recovery guides.                                           |

The current initial FAQ approval is `thread-post:1160798`, reviewed independently
by `su-a21e7` against FAQ SHA-256
`908687ae99d490db965919cb6f1297d409754453666e733027d505b7cbd2205a`.
The exact review and limits are in
`docs/evidence/cloud-portal-docs-and-papercup-faq-2026-10-06/faq-review.md`.
This source review covers the four sensitive families; it is not a live billing
transaction, a novice observation, or a production-shipment receipt. Any FAQ
byte change requires renewed exact-hash approval; the old post never approves
new bytes.

On a relevant behavior change, use this existing pipeline:

1. Read the tracked record and its `last_verified_sha` with `harness_docs:list`
   or the Docs API. Inspect the changed source and the linked guide plus FAQ.
   The ordinary post-git-sync sweep makes a manual document `review`; that
   records a review request, not a judgment that the answer is wrong or right.
2. Claim the change/review work-item and lock the canonical source files.
   Update the affected guide and FAQ together, retaining public anchors and
   safe current-state qualifications. Re-anchor `manual/faq.mdx` through
   `harness_docs:anchor` without asserting verification prematurely.
3. Record the content hash, source revision, named reviewer, approval post and
   unresolved limits on that existing work-item and source-review record.
   Billing/privacy/security/recovery approval must come from a reviewer who
   actually reads those sources; a structural test or drift check is insufficient.
4. Rebuild the public Astro manual and its Pagefind index from the same content.
   Compare actual built FAQ/index bytes at their stable URLs. HTML and Pagefind
   responses must revalidate; do not relabel a source-only check as a shipped
   search/index check.
5. Verify the public runtime receives the actual published corpus revision.
   The existing Starlight reader's `getRevision` seam drops metadata and rendered
   answers on revision changes and refuses answers when that read fails. Supplying
   this seam is required in the actual public retriever; an unused callback or a
   unit fixture is insufficient. P-005 owns that runtime integration and P-007
   remains open until it is observed. No private-source fallback is permitted.
6. Run the maintained FAQ, drift, Starlight revision and public-serving suites
   through `testing:run` with `harness: papercusp`; join the exact test-run IDs
   in `testing:runs`. Then use `harness_docs:verify` only after the reviewed
   guide/FAQ match current source. This advances a drift baseline; it does not
   replace semantic approval. Final shipment uses exact deployed-artifact proof.

The recurrence checks are
`packages/operator-core/lib/harness/docs/public-manual-drift.test.ts`
(real FAQ sensitive anchors with unchanged controls),
`packages/docs-engine/__tests__/starlight-adapter.test.ts`
(changed revision and failed revision read), and
`packages/operator-core/lib/public-docs.test.ts`
(changed HTML/Pagefind bytes at the same URL with revalidation).
These complement the existing FAQ publication suite; they do not prove the
pending public-runtime provider, novice acceptance, or production shipment.

## Isolated post-sync regression and durable ledger

The maintained integration guard is
`packages/operator-core/lib/harness/docs/public-manual-freshness.integration.test.ts`.
It executes a migrated disposable OrgTestDb, the actual after-sync sweep,
persisted review records, dispatcher policy and canonical public reader. Git
source-change signals and outbound agent/coordination calls are controlled;
no steward, model, customer workspace or live flag is changed. It checks
FAQ/guide canonical-file handoff, retained review status and old verified
baseline after rendered content changes, unchanged-document controls, repeat
sweep deduplication and zero charged dispatch attempts with the steward disabled.
This is an integration guard for that composition, not installed-worker or
published HTML/Pagefind evidence.

Use the existing committed-source runner for reproducible evidence. Resolve
`freshness_commit` to a full committed SHA and `freshness_ledger_url` before
entering isolation: the existing ledger resolver prefers
`PAPERCUSP_TEST_RUNS_DB_URL`, then the caller's
`HARNESS_ADMIN_DATABASE_URL`, then the documented operator ledger default.
Do not print the URL. Choose a fresh run-group UUID and absolute receipt path.
`with-test-pg --isolated-runtime` deliberately strips inherited
`PAPERCUSP_` and `HARNESS_` variables, so put these ledger-only overrides
inside its child command:

```bash
node scripts/with-test-pg.mjs --isolated-runtime -- env \
  PAPERCUSP_TEST_RUNS_DB_URL="$freshness_ledger_url" \
  PAPERCUSP_TEST_RUN_HARNESS=papercusp \
  PAPERCUSP_TEST_RUN_WORKSPACE=papercusp-workspace \
  PAPERCUSP_TEST_RUN_GROUP="$freshness_group" \
  PAPERCUSP_TEST_RUN_RECEIPT_FILE="$freshness_receipt" \
  node scripts/lint-as-committed.mjs test:file --any \
  --ref="$freshness_commit" -- \
  packages/operator-core/lib/harness/docs/public-manual-freshness.integration.test.ts
```

These overrides route the reporter and execution-map writer to the shared
ledger; leave the product/test SQL on the throwaway runtime's PG port. Drain
the command to its final exit, then match inserted receipt IDs to
`testing:runs` by exact group, harness and workspace. Check the recorded
commit, clean-source provenance, actual passed cases and zero skips before
binding evidence. A local pass with no canonical ledger row remains local
functional evidence. Preserve any earlier provisional receipt instead of
relabeling it as committed proof.
