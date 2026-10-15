/**
 * _hive-policy-read-stubs.ts — shared unit-suite stub for the merge pass's
 * hive-policy and roster reads (WI-10007530).
 *
 * mergeOnePass reads the hive policy (`getHivePolicyCached`) and, when a policy
 * names a Hive home, the member roster (`listHiveMembersForLocalPot`). Both hit
 * Postgres. The pass deliberately stopped swallowing a failed policy read — a
 * failure must leave the pass unapplied and retryable — so a unit suite that
 * boots the substrate with no PG fails EVERY merge pass on the unit real-PG
 * guard. Model a successful absent-policy read instead (the same stub
 * boot.test.ts uses). Do NOT reintroduce the swallow in boot.ts.
 *
 * Call once at module scope, BEFORE the file registers its own hooks: vitest
 * runs afterEach hooks in stack order, so registering first keeps the stub live
 * through the file's own teardown (a substrate shutdown can still run a pass).
 * A test that needs a real policy can re-spy in its own body; vi.spyOn on an
 * already-spied export returns the existing spy.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import * as hivePolicyStore from '../../../hive-policy-store';
import * as federatedPotScope from '../../../federated-pot-scope';

/**
 * Per-test form, for a file whose OTHER tests need the real policy read (e.g. ones that
 * route the org pool to their own fixture). Call at the top of the test body and register
 * the returned restore FIRST on the test's newest-first cleanup stack, so it runs after
 * substrate teardown (which can still run a pass) — WI-6554700010008455.
 */
export function stubHivePolicyReadsForTest(): () => void {
  const policyRead = vi.spyOn(hivePolicyStore, 'getHivePolicyCached').mockResolvedValue(null);
  const rosterRead = vi.spyOn(federatedPotScope, 'listHiveMembersForLocalPot').mockResolvedValue([]);
  return () => {
    policyRead.mockRestore();
    rosterRead.mockRestore();
  };
}

export function stubHivePolicyReadsForSuite(): void {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = stubHivePolicyReadsForTest();
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });
}
