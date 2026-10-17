import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { pcHeavyFixtureOptions } from './pc-heavy-fixture';

const LIB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PC_HEAVY_LAUNCH = /\b(?:spawn|spawnSync|execFileSync|execSync)\s*\(\s*['"]bash['"]\s*,\s*\[\s*(?:PC_HEAVY|SCRIPT)\s*,/s;
const KNOWN_LAUNCHERS = [
  'pc-heavy-clock-read-guard.test.ts',
  'pc-heavy-freeze-duration-accounting.test.ts',
  'pc-heavy-non-git-coalesce.test.ts',
  'pc-heavy-peak-ledger.test.ts',
  'pc-heavy-psi-scarcity-gate.test.ts',
  'pc-heavy-retry-stdout-isolation.test.ts',
  'pc-heavy-scratch-nesting-recurrence-guard.test.ts',
  'pc-heavy-stdin.test.ts',
];

describe('pc-heavy fixture launch isolation', () => {
  it('pins launches to a private cwd and disables unrelated coalescing', () => {
    expect(
      pcHeavyFixtureOptions('/tmp/pc-heavy-fixture', {
        PC_HEAVY_COALESCE: '1',
        PC_HEAVY_DIR: '/tmp/pc-heavy-state',
      }),
    ).toEqual({
      cwd: '/tmp/pc-heavy-fixture',
      env: {
        PC_HEAVY_COALESCE: '0',
        PC_HEAVY_DIR: '/tmp/pc-heavy-state',
      },
    });
  });

  it('requires the shared launch options in every pc-heavy test suite that runs the script', () => {
    const launchers = readdirSync(LIB_DIR)
      .filter((name) => /^pc-heavy-.*\.test\.ts$/.test(name))
      .map((name) => ({ name, source: readFileSync(join(LIB_DIR, name), 'utf8') }))
      .filter(({ source }) => PC_HEAVY_LAUNCH.test(source));

    expect(launchers.map(({ name }) => name).sort()).toEqual(KNOWN_LAUNCHERS);
    for (const { name, source } of launchers) {
      expect(source, `${name} must use pcHeavyFixtureOptions`).toContain('pcHeavyFixtureOptions');
    }
  });
});
