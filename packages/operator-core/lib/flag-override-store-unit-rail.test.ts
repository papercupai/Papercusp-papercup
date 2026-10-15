/**
 * WI-10006242 — a substrate boot in a unit test must not fail on WI-10005919's
 * degraded flag-read warn merely because the unit-layer no-real-PG rail forbids the
 * PG-backed flag override store.
 *
 * THE CHAIN this pins, end to end, with no mocks:
 *   1. Importing flag-bus.ts installs the PG-backed override store as a module side
 *      effect. The unit lane shares a fork across files (isolate:false), so whether a
 *      given substrate test sees a configured store depends on which co-resident file
 *      imported flag-bus first.
 *   2. Every load() of that store then hits the rail (setup-no-real-pg.ts →
 *      assertRealPgAllowed), so every flag read in the process is a `store-error`.
 *   3. boot.ts warns on a store-error read of the mem0-federation flag, and
 *      vitest-fail-on-console turned that warn into a failure
 *      (EI-24967058096473503: head-snapshot-flush-before-answer.test.ts, red 3× in 6h).
 *
 * THE FIX: the flags lib now carries the load error on the attestation, the degraded
 * detail quotes it, and the shared console filter's existing rail entry recognises the
 * rail's text, exactly as it does for every other fail-soft wrapper of the rail. The
 * production warn stays loud for any other cause, and now says what that cause was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getFlagAttestation,
  initFlagOverrideStore,
  isOverrideStoreConfigured,
} from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { isSilencedConsoleMessage } from '@papercusp/test-config/console-noise-filter';

import { installFlagOverrideStore } from './flag-override-store';
import {
  formatMemoryFederationDegradedWarn,
  memoryFederationFlagReadDegradation,
  readMemoryFederationFlagOnce,
} from './sync/hyperbee/memory-federation-flag-read';

const RAIL_TEXT = 'A UNIT test tried to open a REAL Postgres connection';

function bootWarn(degraded: string): string {
  return formatMemoryFederationDegradedWarn({
    workspaceId: 'ws-wi10006242',
    harnessSlug: 'unit-rail',
    when: 'boot',
    read: { degraded, elapsedMs: 1 },
    degradedReadsThisBoot: 1,
    outcome: 'provisional OFF until the first pass re-reads',
  });
}

describe('flag override store under the unit-layer no-real-PG rail (WI-10006242)', () => {
  // The store is process-global and this lane can share a fork with other files.
  // Put back what was there: in a unit process the only installer is the PG-backed
  // store (flag-bus side effect), so re-installing it is a faithful restore.
  let storeWasConfigured = false;
  beforeEach(() => {
    storeWasConfigured = isOverrideStoreConfigured();
    installFlagOverrideStore();
  });
  afterEach(() => {
    if (storeWasConfigured) installFlagOverrideStore();
    else initFlagOverrideStore(null);
  });

  it('runs under the rail (precondition, so the cases below cannot pass vacuously)', () => {
    expect(process.env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
  });

  it("records the rail's own text as the store's load error", async () => {
    const attestation = await getFlagAttestation(FLAGS.MEM0_FEDERATION_EGRESS, 'system');
    expect(attestation.overrideRead.kind).toBe('store-error');
    expect(attestation.overrideRead.loadError).toContain(RAIL_TEXT);
  });

  it("produces a boot warn that the shared test console filter recognises", async () => {
    const read = await readMemoryFederationFlagOnce();
    expect(read.degraded).toContain(RAIL_TEXT);
    const warn = bootWarn(read.degraded!);
    expect(warn).toContain('WI-10005919: mem0-federation flag boot read degraded');
    expect(isSilencedConsoleMessage(warn)).toBe(true);
  });

  function storeErrorDegradation(loadError: string | null): string {
    const degraded = memoryFederationFlagReadDegradation({
      source: 'compiled-default',
      overrideRead: {
        kind: 'store-error',
        storeConfigured: true,
        cacheKey: 'default',
        cacheGeneration: null,
        cacheLoadedAtMs: null,
        cacheAgeMs: null,
        ttlMs: 5_000,
        ttlRemainingMs: 0,
        loadError,
      },
    });
    expect(degraded).not.toBeNull();
    return degraded!;
  }

  it('keeps a production-shaped store failure LOUD', () => {
    const degraded = storeErrorDegradation('Error: flag backend timed out after 2000ms');
    expect(degraded).toContain('flag backend timed out after 2000ms');
    expect(isSilencedConsoleMessage(bootWarn(degraded))).toBe(false);
  });

  it('control: without the load error (the pre-fix shape) the warn is NOT recognised, so a test failed', () => {
    // Before WI-10006242 the flags lib dropped the error, so the degraded detail could
    // not name the rail. This is the shape that failed EI-24967058096473503's test.
    expect(isSilencedConsoleMessage(bootWarn(storeErrorDegradation(null)))).toBe(false);
  });
});
