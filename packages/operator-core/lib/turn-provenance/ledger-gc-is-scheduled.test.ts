/**
 * The turn-provenance ledger GC must actually RUN.
 *
 * WHY THIS TEST EXISTS, AND WHY IT LOOKS LIKE A GREP RATHER THAN A UNIT TEST.
 * This is the SECOND instance of one bug class inside this same module. The
 * first was `runTurnProvenanceBackfillOnce` (WI-38135), guarded by
 * search/provenance-backfill-is-scheduled.test.ts. This one is `gcLedgerDir`:
 * correct, exported, and covered by a passing unit test
 * (turn-provenance.test.ts, 'gcLedgerDir drops expired rows and unlinks
 * fully-dead files') that supplies the caller production never did. A unit test
 * that invokes the function itself cannot observe the absence of a caller, so
 * the function looked shipped for its entire life.
 *
 * Measured cost when found (2026-08-30, during the P-009 ship-gate audit of
 * turn-provenance-owner-vs-agent-2026-07-11): 34,560 .jsonl files / 63MB under
 * ~/.papercusp/turn-provenance/, oldest dated 2026-07-11 — the day the plan item
 * claiming "ledger write/read/GC (short TTL)" landed — still growing ~690
 * files/day. `appendLedgerRow` compacts only the ONE file it is appending to,
 * and only past LEDGER_COMPACT_BYTES, so a session's file stops being touched
 * the moment that session ends and is then never reclaimed by anything.
 *
 * The property under test is therefore deliberately structural: SOMETHING in
 * production must call the entry point, and it must be reachable from the
 * scheduler. Deleting the tick makes this fail; renaming the function without
 * updating the tick makes this fail; leaving a dangling import behind after
 * deleting the tick makes this fail.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPERATOR_CORE_LIB = join(HERE, '..');

/** The schedulable entry point: the whole-directory sweep. NOT `appendLedgerRow`,
 *  whose opportunistic same-file compaction is what masked this gap — it only
 *  ever touches the file it is already writing to. */
const ENTRY_POINT = 'gcLedgerDir';

/** Where the tick is expected to live. Kept explicit rather than scanning the
 *  whole tree: a wildcard scan would go green again if the call site drifted
 *  into a file that never runs, which is the exact failure being guarded.
 *
 *  PROBE_SCHEDULER_FILE makes this guard falsifiable WITHOUT mutating the
 *  shared checkout: `scripts/mutation-probe.sh` copies the file out, breaks the
 *  copy, and points the test at it. Mutating it in place instead would let the
 *  git-sync sweep commit the mutant mid-run — a documented hazard here, and one
 *  a trap cannot close because the probe legitimately holds the file broken for
 *  as long as the suite runs. */
const SCHEDULER_FILE =
  process.env.PROBE_SCHEDULER_FILE ?? join(OPERATOR_CORE_LIB, 'dbos', 'periodic-workflows.ts');

describe('turn-provenance ledger GC is actually scheduled', () => {
  it('the scheduler imports and invokes the ledger GC entry point', () => {
    const src = readFileSync(SCHEDULER_FILE, 'utf8');

    expect(
      src.includes(ENTRY_POINT),
      `${ENTRY_POINT} is not referenced in periodic-workflows.ts — the turn-provenance ` +
        'ledger GC is dead code again, and ~/.papercusp/turn-provenance/ will grow without ' +
        'bound. It must be called from a scheduled tick, not merely exported.',
    ).toBe(true);

    // Referenced is not the same as CALLED — an import left behind after the
    // tick was deleted would still satisfy a bare substring check.
    expect(
      new RegExp(`${ENTRY_POINT}\\s*\\(`).test(src),
      `${ENTRY_POINT} appears in periodic-workflows.ts but is never invoked — ` +
        'a dangling import is not a call site.',
    ).toBe(true);
  });

  it('the invocation is registered on a cron schedule, not just defined', () => {
    const src = readFileSync(SCHEDULER_FILE, 'utf8');

    // A tick function that nothing registers never fires. Pin the registration
    // by name so deleting registerScheduled (while keeping the function) fails.
    expect(
      /DBOS\.registerScheduled\(\s*turnProvenanceGcWorkflow/.test(src),
      'turnProvenanceGcWorkflow is never passed to DBOS.registerScheduled — ' +
        'an unregistered tick never fires, which is indistinguishable at runtime from ' +
        'the original dead-code defect.',
    ).toBe(true);
  });

  it('the sweep is still exported from the module the tick imports', () => {
    const src = readFileSync(join(HERE, 'turn-provenance.ts'), 'utf8');

    expect(
      new RegExp(`export (async )?function ${ENTRY_POINT}`).test(src),
      `${ENTRY_POINT} is no longer exported from turn-provenance.ts — the scheduled ` +
        'tick cannot import it.',
    ).toBe(true);

    // The unlink is the half that actually reclaims a dead session's file.
    // Dropping it would silently reduce the sweep to row-compaction, which is
    // what appendLedgerRow already did while the directory grew to 34,560 files.
    // (fs.promises `unlink` since WI-10005327 moved the sweep off the event loop.)
    expect(
      /\bawait unlink\(/.test(src),
      'turn-provenance.ts no longer unlinks fully-expired ledger files — row ' +
        'compaction alone never reclaims a file whose session has ended.',
    ).toBe(true);
  });
});
