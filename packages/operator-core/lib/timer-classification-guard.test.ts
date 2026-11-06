import { describe, expect, it } from 'vitest';

// @ts-expect-error — the guard is a plain JS script; this test imports its exported predicate.
import { isExcluded } from '../../../scripts/check-timer-classification.mjs';

describe('timer-classification guard generated fixture boundary', () => {
  it('excludes generated host debug fixtures at any nested operator path', () => {
    expect(isExcluded('apps/operator/dist-host-native-fixture-debug-2001983/spawner-sidecar.mjs')).toBe(true);
    expect(isExcluded('apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/hono-host.mjs')).toBe(true);
  });

  it('keeps maintained source bundles in the scanned population', () => {
    expect(isExcluded('apps/operator/bin/spawner-sidecar.ts')).toBe(false);
  });

  it('excludes helper fixtures in conventional test roots without excluding testing source', () => {
    expect(isExcluded('packages/operator-core/test/managed-tick-alarm-process.fixture.ts')).toBe(true);
    expect(isExcluded('packages/operator-core/tests/managed-tick-alarm-process.fixture.ts')).toBe(true);
    expect(isExcluded('packages/operator-core/__tests__/managed-tick-alarm-process.fixture.ts')).toBe(true);
    expect(isExcluded('packages/operator-core/lib/testing-domains-registry.ts')).toBe(false);
  });
});
