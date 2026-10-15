import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('Papercusp release-gate blueprint', () => {
  it('keeps main-default clones on the staging integration branch', () => {
    const papercuspRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../');
    const blueprint = parseYaml(readFileSync(join(papercuspRoot, '.papercusp', 'blueprint.yaml'), 'utf8')) as {
      knobs?: { releaseGate?: { integrationBranch?: string } };
    };

    expect(blueprint.knobs?.releaseGate?.integrationBranch).toBe('staging');
  });
});
