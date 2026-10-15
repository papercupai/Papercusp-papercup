/**
 * The census cadence's handler must actually be REGISTERED — not merely written.
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * WHY THIS TEST EXISTS. A routine row can sit in harness_shared.routines as `active`, with a
 * plausible target_role, and skip every single fire — because nothing ever registered a handler
 * for that `system:` name. It looks alive in every routines read; the only symptom is that the
 * work silently never happens. `template-gym` sat in exactly that state
 * (EI-18741229858124453: "no handler registered for system:template-gym … skipping").
 *
 * Seeding a routine and registering its action are two edits in two different files, so the
 * failure mode is a one-line omission — precisely the kind a test should hold down rather than
 * a convention. This asserts the seed's target_role and the registered action name are the SAME
 * string, which is the join that actually has to hold at runtime.
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_TARGET_PREFIX, getSystemAction, listSystemActions } from '../harness/routines/system-actions';

const ACTION_NAME = 'coverage-census';

describe('system:coverage-census registration', () => {
  it('is wired through the production import edges and registers an executable handler', async () => {
    const { readFile } = await import('node:fs/promises');
    const [executor, registrations] = await Promise.all([
      readFile(new URL('../dbos/ephemeral-executor.ts', import.meta.url), 'utf8'),
      readFile(new URL('../harness/routines/register-system-actions.ts', import.meta.url), 'utf8'),
    ]);
    // Verify both production edges before executing this action's real registration. Importing
    // the entire executor couples this unit guard to every unrelated action's initialization
    // (EI-25473662053794478). Removing either edge must still fail the coverage guard.
    expect(executor).toMatch(/^import\s+['"]\.\.\/harness\/routines\/register-system-actions['"];?\s*$/m);
    expect(registrations).toMatch(/^import\s+['"]\.\/coverage-census-action['"];?\s*$/m);
    await import('../harness/routines/coverage-census-action');

    // listSystemActions() is included in the failure message on purpose: when this goes red the
    // useful question is "what name DID it register under", and a bare undefined cannot say.
    expect(getSystemAction(ACTION_NAME), `registered actions: ${listSystemActions().join(', ')}`)
      .toBeDefined();
  });

  it("the seed's target_role matches the registered action name", async () => {
    const { readFile } = await import('node:fs/promises');
    const seed = await readFile(
      new URL('../harness/routines/seed-coverage-census-routine.ts', import.meta.url),
      'utf8',
    );

    const targetRole = /TARGET_ROLE\s*=\s*'([^']+)'/.exec(seed)?.[1];
    // The join that must hold: routines.target_role === 'system:' + the registered name.
    expect(targetRole).toBe(`${SYSTEM_TARGET_PREFIX}${ACTION_NAME}`);
  });

  it('the seed declares an ephemeral tier and an interval, not a bare cron expression', async () => {
    const { readFile } = await import('node:fs/promises');
    const seed = await readFile(
      new URL('../harness/routines/seed-coverage-census-routine.ts', import.meta.url),
      'utf8',
    );

    expect(seed).toContain("'ephemeral'");
    expect(seed).toMatch(/interval_sec/);
    // next_fire_at must be NULL for an ephemeral row — the per-host ephemeral executor owns the
    // firing, and a non-null next_fire_at would make the durable cron path try to own it too.
    expect(seed).toMatch(/next_fire_at[\s\S]{0,400}NULL/);
  });
});
