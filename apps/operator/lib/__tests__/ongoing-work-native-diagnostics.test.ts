import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeSpec = readFileSync(
  resolve(__dirname, '../../e2e/ongoing-work-native-collection.spec.mts'),
  'utf8',
);

describe('native collection early request diagnostics', () => {
  it('retains a trace when the initial goals.detail request fails before navigation', () => {
    const tracePolicy = /test\.use\(\{\s*trace:\s*(['"])retain-on-failure\1\s*\}\);/.exec(nativeSpec);
    const firstGoalsDetailRead = nativeSpec.indexOf("name: 'goals.detail'");

    expect(tracePolicy, 'the native spec must retain traces on its first failure').not.toBeNull();
    expect(firstGoalsDetailRead, 'the fixture must exercise the goals.detail API read').toBeGreaterThan(-1);
    expect(tracePolicy!.index, 'trace retention must be active before the first goals.detail read')
      .toBeLessThan(firstGoalsDetailRead);
  });
});
