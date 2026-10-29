/**
 * Guards against the EI-18683796658873607 class of bug: a pot-instance su override's own
 * header comment naming a STALE seed slug (`papercup-pot`) instead of the real hive/harness
 * slug (`papercusp`) that `setHiveInstancePromptOverride` / `POST /api/agent-mcp/pot-override-set`
 * actually requires. Following the file's own re-seed instructions with the wrong slug throws
 * ("no Hive '<slug>' in workspace … — settings belong to a Hive"), and since this file's header
 * is the one place an editor is guaranteed to read before re-seeding, a stale slug there re-costs
 * the same discovery on every future edit.
 *
 * A content test rather than a live-DB integration test: it can't independently verify the
 * literal string 'papercusp' resolves to a real hive row without a migrated PG instance, but it
 * pins the ONE thing a copy-pasted/renamed header regresses — that the doc names the real slug,
 * not a `<filename-stem>` guess derived from the file's own path.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POT_INSTANCES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'pot-instances');

/** The real hive/harness slug every pot-instance su override seeds against today. */
const REAL_POT_SLUG = 'papercusp';

describe('pot-instance su override headers name the real seed slug (not a stale filename-derived guess)', () => {
  const files = readdirSync(POT_INSTANCES_DIR).filter((f) => f.endsWith('.su.md'));

  it('found at least one pot-instance override to guard', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: header names the real pot slug '${REAL_POT_SLUG}', not a filename-derived stale one`, () => {
      const md = readFileSync(join(POT_INSTANCES_DIR, file), 'utf8');
      // Only the header comment (before the first closing `-->`) is checked — that's the part an
      // editor reads before re-seeding.
      const headerEnd = md.indexOf('-->');
      const header = headerEnd === -1 ? md : md.slice(0, headerEnd);

      expect(header, 'header documents the real pot slug for re-seeding').toContain(REAL_POT_SLUG);

      // The stale-slug trap this guards: a slug of the shape `<stem>-pot` (derived by eye from
      // the file's own name, e.g. `papercup-pot` from `papercup-pot.su.md`) used as the
      // setHiveInstancePromptOverride / potSlug argument, when that is NOT the real slug.
      const stemDerivedSlug = `${file.replace(/\.su\.md$/, '')}-pot`;
      if (stemDerivedSlug !== REAL_POT_SLUG) {
        // It's fine for the stale slug to appear in prose EXPLAINING the trap (as this fix does:
        // "NOT `papercup-pot`") — what must never recur is instructing a seed call to use it
        // un-negated. Guard the specific failure shape instead of banning the substring outright.
        const seedsAgainstStaleSlug = new RegExp(
          `potSlug['"\`: ]*${stemDerivedSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!['"\`]*\\s*\\)\\s*—?\\s*that slug does not exist)`,
        );
        expect(
          seedsAgainstStaleSlug.test(header),
          `header must not instruct seeding with the stale filename-derived slug '${stemDerivedSlug}'`,
        ).toBe(false);
      }
    });
  }
});

describe('Papercusp su override uses the generated workspace map', () => {
  it('does not freeze absolute checkout roots in the per-pot prompt append', () => {
    const prompt = readFileSync(join(POT_INSTANCES_DIR, 'papercup-pot.su.md'), 'utf8');

    expect(prompt).toContain('generated workspace map earlier in the base prompt');
    // vacuous-negative-ok: deliberate regression pin — the hardcoded "**The workspace map**" heading was removed when the map became generated, and this keeps it from coming back
    expect(prompt).not.toContain('**The workspace map**');
    expect(prompt).not.toMatch(/\/home\/[^/\s]+\/papercupai-workspace\//);
  });
});

describe('Papercusp su staging tool routing', () => {
  it('distinguishes the direct main operator from the build-selecting MCP proxy', () => {
    const prompt = readFileSync(join(POT_INSTANCES_DIR, 'papercup-pot.su.md'), 'utf8');

    expect(prompt).toContain('http://localhost:9071/api/mcp');
    expect(prompt).toContain("build:'staging'");
    expect(prompt).toContain('older main schemas may reject the unrecognized');
    expect(prompt).toContain('while builds that recognize it refuse the mismatch');
    expect(prompt).toContain('build_mismatch');
    expect(prompt).toContain('scripts/mcp-call.mjs');
  });
});
