/**
 * P-014 — the Wave A gate.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately does NOT do.
 *
 * Each Wave A package runs itself through the shared SDK conformance kit in
 * its own test file, and `provider-conformance.test.ts` proves the kit is
 * falsifiable with permanent broken-adapter controls and honest about what
 * it skips. None of that is repeated here — re-proving it would be duplication,
 * not a gate.
 *
 * What no single-adapter test can assert is a WAVE-level property, because each
 * adapter test only ever sees itself. Two such properties carry P-014:
 *
 *   1. THE KIT WAS NOT BENT TO FIT A PLATFORM. P-014 is explicit that any
 *      conformance-kit change needed to accommodate a platform is a finding
 *      about the KIT, to be recorded — not quietly patched per-adapter. The
 *      executable form of that clause: no platform name may appear in the kit's
 *      EXECUTABLE CODE.
 *
 *      Prose is exempt, and that exemption is load-bearing rather than a
 *      loophole: the kit's comments cite Bluesky's retention window and
 *      Mastodon's absent cursor as the motivating examples for the
 *      cursor-unusable check. Naming why a check exists is documentation.
 *      Branching on who is being checked is special-casing. Only the second is
 *      a defect, so the guard strips comments before it looks.
 *
 *   2. THERE IS ONE KIT. All three adapters import the same runner from the
 *      same module. A forked or copied kit is the quiet way an adapter ends up
 *      passing a weaker suite while still reporting "conformance" — the failure
 *      mode clause 1 is written against, arrived at from the other direction.
 *
 * Provider migration binds Wave A's actual package suites to the SDK kit.
 * Broken-adapter controls remain in the shared conformance suites; transport
 * behavior is exercised by each package's real API fixtures.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './comment-stripper.fixture';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The SDK directory this gate reads its subjects from. Defaults to the real one.
 *
 * The override exists so falsifiability can be PROVEN without mutating the
 * shared tree: point it at a copy carrying a deliberate special-case and this
 * suite must go red. Mutating the real kit in place to prove the same thing
 * would race git-sync, which sweeps and commits the whole tree on a timer — a
 * probe legitimately holds its mutation for as long as the suite runs, so a
 * sweep landing in that window commits it even though nothing went wrong.
 */
const SUBJECT_DIR = process.env.WAVE_A_GATE_SUBJECT_DIR ?? join(HERE, '../../../../plugin-sdk/src');

/** The kit itself: the runner plus the contract every adapter implements. */
const KIT_FILES = ['provider-conformance.ts', 'provider.ts'] as const;

/** The three platforms that make up Wave A. */
const WAVE_A_PLATFORMS = ['bluesky', 'mastodon', 'reddit'] as const;

const read = (file: string): string => readFileSync(join(SUBJECT_DIR, file), 'utf8');

/**
 * `stripComments` moved to ./comment-stripper.fixture (P-019). The Wave B gate
 * needs the identical prose-vs-code distinction, and a second copy of a stripper
 * is the dangerous kind of duplication: one that quietly stops stripping does not
 * fail, it makes every absence claim built on it pass. The CONTROL below is
 * unchanged and now measures the shared implementation.
 */

describe('P-014 Wave A gate — the kit was not bent to fit a platform', () => {
  it.each(KIT_FILES)('%s names no Wave A platform in executable code', (file) => {
    const code = stripComments(read(file));

    // POSITIVE CONTROL on the instrument. An absence claim needs one: if the
    // read or the stripper returned (nearly) nothing, every assertion below
    // would pass while measuring literally no code.
    expect(code.length).toBeGreaterThan(500);

    for (const platform of WAVE_A_PLATFORMS) {
      expect(
        code.toLowerCase(),
        `${file} branches on "${platform}" in executable code. P-014: a kit change needed to ` +
          `accommodate a platform is a finding about the KIT and must be recorded, not patched here.`,
      ).not.toContain(platform);
    }
  });

  it('CONTROL: the guard fires on special-casing and stays silent on prose', () => {
    // It must CATCH a real per-adapter patch...
    const specialCased = `if (adapter.platformId === 'mastodon') { skipCursorCheck(); }`;
    expect(stripComments(specialCased).toLowerCase()).toContain('mastodon');

    // ...and must TOLERATE the same name in documentation, in both comment
    // forms the kit actually uses. Without this half, a stripper that ate the
    // whole file would look exactly like a clean kit.
    const blockProse = `/** Bluesky refuses a cursor past its retention window. */\nconst keep = 1;`;
    expect(stripComments(blockProse).toLowerCase()).not.toContain('bluesky');
    expect(stripComments(blockProse)).toContain('const keep = 1;');

    const lineProse = `// Mastodon has no cursor at all.\nconst alsoKeep = 2;`;
    expect(stripComments(lineProse).toLowerCase()).not.toContain('mastodon');
    expect(stripComments(lineProse)).toContain('const alsoKeep = 2;');

    // A string literal is code, not prose: a URL must survive the `//` cut.
    expect(stripComments(`const u = 'https://bsky.social/xrpc';`)).toContain('https://bsky.social/xrpc');
  });
});

describe('P-014 Wave A gate — there is one kit, and all three adapters use it', () => {
  it('exports the conformance runner from exactly one module', () => {
    const sources = readdirSync(SUBJECT_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    // POSITIVE CONTROL: the directory scan found the modules at all.
    expect(sources.length).toBeGreaterThan(3);

    const exporters = sources.filter((f) =>
      /export\s+(async\s+)?function\s+runProviderConformance/.test(read(f)),
    );

    expect(
      exporters,
      'more than one module exports the conformance runner — a forked kit lets an adapter ' +
        'pass a weaker suite while still reporting "conformance"',
    ).toEqual(['provider-conformance.ts']);
  });

  it('keeps the retired app-side runner and adapter contract absent', () => {
    for (const file of ['conformance.ts', 'adapter-contract.ts']) {
      expect(existsSync(join(HERE, file)), `retired app-side kit returned: ${file}`).toBe(false);
    }
  });

  it.each(WAVE_A_PLATFORMS)('the %s package is run against the shared SDK kit', (platform) => {
    const source = readFileSync(join(HERE, '../../providers', platform, `${platform}-provider.test.ts`), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\brunProviderConformance\b[^}]*\}\s*from\s*['"]@papercusp\/plugin-sdk(?:\/provider-conformance)?['"]/s);
    expect(source).toContain('runProviderConformance(');
  });
});
