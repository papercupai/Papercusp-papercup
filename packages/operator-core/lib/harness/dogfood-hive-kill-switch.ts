/**
 * The dogfood-hive kill switch — `PAPERCUSP_DISABLE_DOGFOOD_HIVE=1`.
 *
 * WI-1423 test-frame isolation: a hard, synchronous, flag-independent kill-switch
 * for the dogfood auto-join. Set it on any box that must NEVER auto-wire into the
 * production `papercusp`/`papercup` hive — CI, a Hetzner/local-matrix test rig
 * frame, an isolated release-testing VM, or a packaged Papercusp Server installed
 * on a development box whose dev fleet already IS the hive's home.
 *
 * Root cause WI-1423 closed: TWO of the three trigger paths (the explicit boot call
 * in host-bootstrap.ts, and the setup-wizard's `/api/desktop/bootstrap-pot/start`)
 * already gate on the `DOGFOOD_PAPERCUSP_POT` flag before calling
 * `startBootstrapPapercuspHive()` — but the THIRD (hive-directory-boot.ts's
 * `maybeTriggerCanonicalJoinOnIngest`, fired the instant a box that has wired the
 * hive directory merely HEARS the canonical hive's announce on the global directory
 * topic) called `startBootstrapPapercuspHive()` directly with NO gate at all. So the
 * switch is checked inside `bootstrapPapercuspHive`, the ONE function every trigger
 * path calls.
 *
 * WI-6554700010029282 widened it to the SUBSTRATE BOOT. The bootstrap gate only
 * stops a NEW join. A box whose harness registry already carries the dogfood
 * harness (written by an earlier boot, before the switch was set) kept booting its
 * substrate on every start: `bootSingleHarness` reads the registry, not the switch.
 * Booting that substrate is exactly the wiring the switch exists to prevent. On the
 * dev box it was also the store collision this item records: the packaged server's
 * dogfood harness resolves to the SAME Corestore path as the dev fleet's
 * `papercusp-workspace/papercusp` harness, so whenever it started while bg-host was
 * down it took the store lock and held it, refusing git-sync publication for hours.
 *
 * Kept dependency-free (no imports): boot-all consults it on every substrate boot,
 * and the bootstrap module graph is far too heavy to load there.
 */

/** The environment variable that disables the dogfood hive on this box. */
export const DOGFOOD_HIVE_KILL_SWITCH_ENV = 'PAPERCUSP_DISABLE_DOGFOOD_HIVE';

/** True only for the exact value `'1'` (not `'true'`, not `'0'`). */
export function dogfoodHiveDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DOGFOOD_HIVE_KILL_SWITCH_ENV] === '1';
}
