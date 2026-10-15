# Scoped npm resolution can dirty a pinned lock before reify starts
URL: /internal/docs/agent-insights/scoped-npm-resolver-lockfile-flags

Preserve the original lock snapshot at resolver apply, before reify compares flags against an already changed baseline.

A clean pinned release can become dirty even when npm changes no installed package bytes. In EI-25447417465171634, the failed D-212 sidecar producer changed only package-lock.json: 197 package entries flipped dependency-type flags. The committed lock SHA-256 was ec105fa0bf3fcf3afcc679846e2ac5063f830e034e5ff77a6270b7205f39e376; the changed lock was b15bf8250d325de05210d2570eb9bce3ca2a6a15ec514fcfb0d2378f736e6808. The original files and failed producer log were preserved.

## Diagnose the actual difference

Use lockfileDepFlagOnlyChanges in scripts/npm-install-safe.mjs against the exact committed and changed JSON. A non-null array names entries differing only in dev, optional, devOptional or peer. It refuses version, integrity, resolved URL, dependency edge, package population or top-level differences. Do not infer harmlessness from a short diff or restore a dirty release lock without preserving evidence and validating this comparison.

## The missing restoration boundary

runManifestOnlyInstall resolves in a manifest-only scratch tree, then applies its result while holding the repo writer. The prior guard restored flags for lock-only operations and after reify. For an ordinary scoped install, the reify snapshot was taken AFTER the resolved lock had been applied. If resolution changed the flags and reify preserved them, the guard compared two already changed snapshots and saw no rewrite.

The durable fix extends the existing restoreScopedFlagOnlyLockfileRewrite call to every scoped resolver apply before reify takes its snapshot. The writer remains held. Substantive resolutions still apply; existing reify/repair restoration remains in place. No new npm mode or parallel installer is needed.

## Recurrence guard and release recovery

The registered Node suite scripts/npm-install-safe.test.mjs drives the real CLI with a controlled npm child. Its resolver-only flag fixture fails the reify case before the fix and passes afterwards; lock-only remains passing. Existing tests retain substantive package changes and stale-manifest refusal. The measured full suite passed 44 tests with no failures, skips or cancellations.

Fixing the maintained helper does not repair or qualify an old candidate. Preserve its changed lock and log, prepare a distinct committed object-sourced candidate containing the fix, and revalidate source, dependencies and consumers before independent producer nomination. Candidate security, provenance, physical acceptance and GO remain separate.

The related npm-says-up-to-date-but-the-dep-is-not-on-disk insight describes extraction bookkeeping; this page records the distinct resolver snapshot ordering failure.
