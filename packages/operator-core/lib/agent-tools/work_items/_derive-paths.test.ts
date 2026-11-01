import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRepoPathsFromText,
  explicitRepoPathsWarning,
  validateExplicitRepoPaths,
} from './_derive-paths';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('deriveRepoPathsFromText (EI-16028)', () => {
  it('extracts a single repo-relative path mentioned in prose', () => {
    expect(deriveRepoPathsFromText('fix the bug in packages/operator-core/lib/foo.ts please')).toEqual([
      'packages/operator-core/lib/foo.ts',
    ]);
  });

  it('ignores repository-looking segments inside absolute URLs and keeps adjacent local paths', () => {
    const upstream =
      'https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/storage/aio/aio_funcs.c';
    const local = 'packages/operator-core/lib/agent-tools/work_items/missing.ts';
    expect(deriveRepoPathsFromText(`See upstream source ${upstream}; local reference ${local}.`)).toEqual([local]);
  });

  it('extracts multiple distinct paths across several prefixes, deduped, order-preserved', () => {
    const text =
      'root-caused in libs/papercusp/lib/bar.ts and mirrored in apps/operator/app/baz.tsx; ' +
      'also touches packages/operator-core/lib/foo.ts again (packages/operator-core/lib/foo.ts).';
    expect(deriveRepoPathsFromText(text)).toEqual([
      'libs/papercusp/lib/bar.ts',
      'apps/operator/app/baz.tsx',
      'packages/operator-core/lib/foo.ts',
    ]);
  });

  it('strips trailing prose punctuation (period, comma, colon, closing paren/quote)', () => {
    expect(deriveRepoPathsFromText('see scripts/next-migration.mjs.')).toEqual(['scripts/next-migration.mjs']);
    expect(deriveRepoPathsFromText('(scripts/next-migration.mjs)')).toEqual(['scripts/next-migration.mjs']);
    expect(deriveRepoPathsFromText('scripts/next-migration.mjs, then re-run')).toEqual([
      'scripts/next-migration.mjs',
    ]);
  });

  it('splits adjacent repo-prefix paths instead of joining them', () => {
    expect(deriveRepoPathsFromText('see apps/operator`packages/backup for both surfaces')).toEqual([
      'apps/operator',
      'packages/backup',
    ]);
  });

  it('preserves a nested repository path that contains another repo prefix', () => {
    const nested = 'libs/papercusp/packages/orchestrator/src/spawn-mcp.test.ts';
    expect(deriveRepoPathsFromText(`The failing test is ${nested}.`)).toEqual([nested]);
    expect(deriveRepoPathsFromText(`The failing test is ${nested}.`, { repoRoot })).toEqual([nested]);
  });

  it('returns empty for text with no repo-path mentions', () => {
    expect(deriveRepoPathsFromText('the gateway is admission-starved, raise the ceiling')).toEqual([]);
  });

  it('returns empty for empty/undefined-ish text', () => {
    expect(deriveRepoPathsFromText('')).toEqual([]);
  });

  it('ignores a bare prefix with nothing meaningful after it', () => {
    expect(deriveRepoPathsFromText('somewhere under src/ we should look')).toEqual([]);
  });

  it('filters derived paths to existing files contained by the repo root', () => {
    const existing = 'packages/operator-core/lib/agent-tools/work_items/_derive-paths.ts';
    const nonexistent = 'apps/packages/libs/scripts';
    const escaping = `packages/operator-core/${'../'.repeat(6)}etc/passwd`;
    expect(deriveRepoPathsFromText(`${existing} ${nonexistent} ${escaping}`, { repoRoot })).toEqual([existing]);
  });

  it('caps at the configured max (default 12)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `packages/pkg${i}/lib/file.ts`).join(' ');
    expect(deriveRepoPathsFromText(many)).toHaveLength(12);
    expect(deriveRepoPathsFromText(many, { max: 3 })).toHaveLength(3);
  });
});

describe('validateExplicitRepoPaths (EI-20191260047847804)', () => {
  it('reports an explicit path that is misspelled in the selected tree', () => {
    const got = validateExplicitRepoPaths(
      [
        'packages/operator-core/lib/agent-tools/work-items/complete.ts',
        'packages/operator-core/lib/agent-tools/work_items/complete.ts',
      ],
      { repoRoot },
    );
    expect(got).toEqual({
      missing: ['packages/operator-core/lib/agent-tools/work-items/complete.ts'],
    });
  });

  it('is silent for existing paths, globs, outside paths, and an unavailable root', () => {
    expect(
      validateExplicitRepoPaths(
        ['packages/operator-core/lib/agent-tools/work_items/complete.ts', 'packages/**/*.ts', '../outside.ts'],
        { repoRoot },
      ),
    ).toBeUndefined();
    expect(validateExplicitRepoPaths(['packages/nope.ts'], { repoRoot: null })).toBeUndefined();
  });

  it('fails open when the existence probe throws', () => {
    expect(
      validateExplicitRepoPaths(['packages/operator-core/lib/agent-tools/work_items/complete.ts'], {
        repoRoot: '/repo',
        exists: () => {
          throw new Error('EIO');
        },
      }),
    ).toBeUndefined();
  });

  it('formats a warn-only advisory that names every missing path', () => {
    const warning = explicitRepoPathsWarning(['packages/a.ts', 'packages/b.ts']);
    expect(warning).toMatch(/advisory only/);
    expect(warning).toContain('packages/a.ts');
    expect(warning).toContain('packages/b.ts');
  });
});
