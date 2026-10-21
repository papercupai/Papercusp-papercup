import { it } from 'vitest';

/**
 * A checked-in HANGING fixture for testing:run's foreground-timeout process-tree kill.
 *
 * It is skipped in every ordinary suite. The owning integration test enables it only in the
 * nested test process. That guarantees the child is still running when the foreground budget
 * expires, whatever the box load, so the case always reaches the kill path (WI-6554700010018388).
 */
it.skipIf(process.env.PAPERCUSP_TESTING_RUN_HANG_FIXTURE !== '1')(
  'stays running until the parent kills its process tree',
  () => new Promise<void>(() => {}),
  600_000,
);
