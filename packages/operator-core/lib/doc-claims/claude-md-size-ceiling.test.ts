/**
 * token-efficiency-prompts-cache-and-behavior-2026-10-11 P-004 / R-6 / SPEC-P-004.
 *
 * CLAUDE.md is the always-loaded repo guide: Claude Code reads it into every session in
 * this tree, so every byte is paid on every launch. P-004 compacted it from the frozen
 * 108,821-byte baseline (plan Baseline table, measured before P-004) by moving long-form
 * detail into each part's `#evidence` corpus sibling and the agent-insights docs.
 *
 * This is a SHRINK-ONLY ceiling at R-6's bar (15% under the baseline). The guide may keep
 * shrinking; growing it past the ceiling fails here, so regrowth becomes a deliberate,
 * reviewed edit of CEILING_BYTES instead of silent drift. To fix a red: move the long-form
 * text you added into the part's `#evidence` sibling (npm run set-doc-part -- --part-key
 * '<key>#evidence' …) and leave the rule plus a pointer, then re-project.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BASELINE_BYTES = 108_821;
const CEILING_BYTES = Math.floor(BASELINE_BYTES * 0.85);

describe('CLAUDE.md always-loaded guide size (P-004)', () => {
  it('pins the ceiling to 15% under the frozen pre-compaction baseline', () => {
    expect(CEILING_BYTES).toBe(92_497);
  });

  it('stays at or below its post-compaction size ceiling', () => {
    const bytes = Buffer.byteLength(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), 'utf8');
    // A positive control on the path: an empty or missing projection is a broken read, not a pass.
    expect(bytes).toBeGreaterThan(20_000);
    expect(
      bytes,
      `CLAUDE.md is ${bytes} B, over the ${CEILING_BYTES} B ceiling. Move long-form detail into the part's #evidence sibling and re-project.`,
    ).toBeLessThanOrEqual(CEILING_BYTES);
  });
});
