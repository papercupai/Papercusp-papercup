import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAL_EMBEDDER_MODE, PERSONAL_EMBED_MAX_ROWS_PER_TICK, PERSONAL_EMBED_TARGET } from './embedding';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('Personal Vault local-only embedding recurrence guard', () => {
  it('pins the storage surface to bounded EmbeddingGemma writes', () => {
    expect(PERSONAL_EMBEDDER_MODE).toBe('gemma');
    expect(PERSONAL_EMBED_MAX_ROWS_PER_TICK).toBeGreaterThan(0);
    expect(PERSONAL_EMBED_MAX_ROWS_PER_TICK).toBeLessThanOrEqual(32);
    expect(PERSONAL_EMBED_TARGET).toMatchObject({ table: 'harness_shared.documents', embedCol: 'embedding' });
  });

  it('is invoked by the existing production embed-backfill schedule', () => {
    const scheduler = readFileSync(join(HERE, '..', 'search', 'embed-backfill.ts'), 'utf8');
    expect(scheduler).toContain('runPersonalVaultEmbedBackfillOnce');
    expect(scheduler).toMatch(/runPersonalVaultEmbedBackfillOnce\s*\(/);
  });
});
