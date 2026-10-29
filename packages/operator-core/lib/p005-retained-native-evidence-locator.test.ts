import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifestPath = fileURLToPath(new URL('../../../docs/evidence/p005-retained-native-acceptance-20261025.json', import.meta.url));

describe('P005 retained native acceptance evidence locator', () => {
  it('uses a home-relative locator with explicit missing-host semantics', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifactRoot?: string;
      pathNotation?: string;
    };

    expect(manifest.artifactRoot).toMatch(/^~\//);
    expect(manifest.pathNotation).toContain("Resolve the leading ~/ with the evidence recorder's home directory");
    expect(manifest.pathNotation).toContain('Missing host context is UNKNOWN.');
  });
});
