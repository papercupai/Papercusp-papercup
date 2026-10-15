# git-sync holds files edited during an unfinished turn
URL: /internal/docs/agent-insights/git-sync-turn-scoped-commit-hold

git-sync automatically leaves out every file a live session edited (Edit/Write/apply_patch) during its current turn, and commits those files together once the turn ends, the session ends, or 60 minutes pass after the edit. Covers the release rules, the Bash-write and stale-Codex-home gaps, holding across turns with locks:acquire, and where to read the hold (routines:list, dev:pipeline_position).

# git-sync holds files edited during an unfinished turn

git-sync commits the whole shared tree every few minutes. Before this hold existed, a tick that landed in the middle of an agent's multi-file change committed half of it: the provider file without its consumer, a renamed export without its call sites. The green-checkpoint gate could then judge a candidate that never compiled.

The turn-scoped hold (plan `git-sync-turn-scoped-commit-hold-2026-10-11`) closes that gap. **It is automatic: agents call no tool.**

## How it works

Two records already exist for every session:

* every native edit (`Edit`, `Write`, `apply_patch`) writes a row to `harness_shared.edit_attribution_ledger` when the edit hook grants its lock, just before the edit;
* every client records each turn end in `harness_shared.session_turn_journal`. The hold reads every client's rows alike (Claude, Codex and OMP); it does not care which client wrote them.

On each tick, git-sync's commit census (`readGitSyncCensusStrict` in `packages/operator-core/lib/personal-vault/git-sync-hold.ts`) adds a turn-holds leg (`readTurnHoldings`). It returns every path whose newest native edit is newer than its editor's last recorded turn end. git-sync leaves those paths out of the commit exactly as it leaves out a live lock. The rest of the tree is committed as usual.

The turn end is the journal row's `turn_ts` (the turn's final assistant message), falling back to the row's `created_at`. That choice errs toward holding longer, never shorter: the journal insert can land after the next turn's first edit, but `turn_ts` cannot.

The leg is strict. If the ledger read fails, git-sync skips the whole tick rather than commit a file that may be mid-edit.

## When a hold lifts

A held file is committed, together with the rest of that turn's edits, on the first tick after any of these:

1. **The editor's turn ends.** This is the normal case.
2. **The editor's session ends.** git-sync needs positive evidence for this: the owner has `adv_sessions` rows and none is still open. An owner with no session row at all is treated as live, so only the cap below releases it.
3. **60 minutes pass since the edit** (`TURN_HOLD_MAX_AGE_MS`, plan decision D-001). This caps the delay for a crashed session or a client that never records turn ends.

`locks:release` does **not** lift a turn hold: there is no lock to release. git-sync's skipped-path diagnostics and `dev:pipeline_position` therefore stop telling the holder to release a lock.

## Known gaps

* **A file written through Bash is not held on its own.** `sed -i`, heredocs, `>` redirects and scripts write no `edit_attribution_ledger` row, so the turn-holds leg sees nothing to hold. There is one exception. If that file imports a file that IS held, git-sync's live-lock importer guard (`detectQuarantineImporters`, called from `run-git-sync.ts`) leaves it out too. It reports that file as a content error (`live-lock exclusion`) in `outcome.contentErrors`, **not** in `skippedPaths`, so look there when you check whether it was held. Any other Bash-written file is committed on the next tick. The project guide already forbids editing tracked files that way; this is one more reason.
* **Codex sessions whose hooks predate turn-end recording** (WI-6554700010008402). Their `hooks.json` has no Stop hook, so they never write a turn end. Their edits stay held until the 60-minute cap or the session ending. The hold lasts too long in that case, never too short.

## Holding a change across several turns

The turn end is deliberately the release point: it is a natural safe point to commit, and holding past it automatically could leave files uncommitted indefinitely. To keep a change out of commits across turns, take an explicit lock and release it when the change is complete:

```
locks:acquire { paths: ['<repo-relative path>', ...], intent: '<what you are holding and why>', ttl_sec: 3600 }
```

## Reading the hold

* **`routines:list { name: 'git-sync', installSlug: '<install>' }`** → `health.git_sync_exclusions.turn_holds`: `{ count, holders, sample: [{ path, holder, held_since, age_sec }], sample_truncated, max_age_sec }`. The paths are those of the last completed sweep (`skipped_at`), so a hold may already have lifted.
* **`dev:pipeline_position { path }`** → `sweepExposure.turnHeld: { holder, heldSince }` when the last sweep left that file out for a turn hold. In that case `sweepExposure.exposed` is `false`: the next tick will not sweep the file mid-edit.

## Switching it off

The runtime kill-switch is the feature flag `papercusp-git-sync-turn-hold` (`FLAGS.GIT_SYNC_TURN_HOLD` in `libs/flags/src/types.ts`), default ON. Flip it at `/admin/features`. With it OFF, git-sync's census has no turn-holds leg and git-sync behaves as it did before this plan.

## Tests

* `packages/operator-core/lib/personal-vault/git-sync-hold.test.ts`: the pure row mapping and the census leg.
* `packages/operator-core/lib/personal-vault/git-sync-turn-hold.integration.test.ts`: a real database and a real git repo. A mid-turn two-file edit is held, then committed in one commit after the turn ends. Turn ends recorded by Claude, Codex and OMP all release the hold. A dirty importer of a held file is held too. The session-end and 60-minute releases are covered.
* `packages/operator-core/lib/harness/git-sync/git-sync-action.test.ts` (the turn-hold describe block): with the flag ON a path edited mid-turn reaches `runGitSync` as a held path; with it OFF the census has no turn-holds leg; and an unreadable turn-hold read skips the tick and commits nothing.
* `packages/operator-core/lib/agent-tools/routines/routines.test.ts` and `packages/operator-core/lib/git-pipeline-position.test.ts`: the two read surfaces.
