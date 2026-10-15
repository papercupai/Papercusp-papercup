/**
 * P-008 / WI-37779 — every `docs:` slug an official template cites must resolve
 * to a real docs page.
 *
 * WHY THIS GUARD EXISTS. `template.yaml`'s `docs` list is the building agent's
 * "when the GUIDE is not enough, read these" pointer, and the manifest validator
 * only shape-checks it: `DOC_SLUG` in template-manifest.ts asserts kebab
 * segments separated by `/` and nothing more. A perfectly-formed slug pointing at
 * a page nobody ever wrote therefore passes `validateTemplateManifest` cleanly —
 * which is exactly how THREE dangling `agent-insights/templates-*` slugs came to
 * be cited by all 11 official templates while resolving to nothing. The builder
 * follows the pointer, finds a 404, and has no way to tell "this page is missing"
 * from "I typed it wrong".
 *
 * WHAT "RESOLVES" MEANS HERE, AND WHAT IT DOES NOT. This asserts the slug exists
 * in the docs SOURCE tree (`apps/operator-docs/src/content/docs/<slug>.{mdx,md}`).
 * WI-37779 also asked whether the slug survives into what the BUNDLE ships. That
 * half is deliberately NOT asserted, because it is not verifiable from a source
 * checkout: the bundle copies the BUILT Starlight output
 * (`build-desktop-sidecar.sh` copies `public/internal/docs` wholesale, with no
 * per-section exclusion), and that build output does not exist on a dev box. A
 * test that pretended to check it would be checking the source tree twice under a
 * more impressive name. Source-existence is the necessary condition and the one
 * that actually failed; if a section-level bundle exclusion is ever introduced,
 * THAT is when to extend this guard — with the built tree as its input.
 *
 * PREMISE RE-CHECKED 2026-08-10 (audit WI-37833). WI-37779's wording — "the two
 * differ, which is how build-system/ hid" — no longer describes the tree, and it is
 * worth saying so rather than leaving a live-sounding warning in place. Both copy
 * legs are wholesale today: build-desktop-sidecar.sh copies public/internal/docs
 * with no per-section exclusion, and operator-docs' postbuild-copy rsyncs the whole
 * dist. `build-system/` is present in source and its cited page
 * (build-system/tauri-release-kit-proposal.mdx) exists, so the source tree and the
 * shipped tree agree by construction, not by luck. The residual risk is a page that
 * fails to BUILD, which is the Starlight build's job to report, not this guard's.
 *
 * Uses the filesystem, NOT `git ls-files`: a doc authored in the same change is
 * untracked until git-sync sweeps, and a git-backed lint would report a
 * just-written page as missing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'templates');
const DOCS_ROOT = join(REPO_ROOT, 'apps', 'operator-docs', 'src', 'content', 'docs');

interface Citation {
  template: string;
  slug: string;
}

/** Every (template, docs-slug) pair declared across the official templates. */
function collectCitations(): { citations: Citation[]; templates: string[] } {
  const templates: string[] = [];
  const citations: Citation[] = [];
  for (const entry of readdirSync(TEMPLATES_DIR).sort()) {
    const dir = join(TEMPLATES_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = ['template.yaml', 'template.yml']
      .map((n) => join(dir, n))
      .find((p) => existsSync(p));
    if (!manifestPath) continue;
    templates.push(entry);
    const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as { docs?: unknown };
    const docs = Array.isArray(manifest?.docs) ? manifest.docs : [];
    for (const slug of docs) {
      if (typeof slug === 'string' && slug.trim()) {
        citations.push({ template: entry, slug: slug.trim() });
      }
    }
  }
  return { citations, templates };
}

function docExists(slug: string): boolean {
  return ['.mdx', '.md'].some((ext) => existsSync(join(DOCS_ROOT, `${slug}${ext}`)));
}

describe('official templates: every cited docs: slug resolves', () => {
  const { citations, templates } = collectCitations();

  /**
   * THE DENOMINATOR CHECK, FIRST. A guard that walks a glob reports a serene
   * green when the glob matches nothing, and that green is indistinguishable
   * from real coverage. These bounds fail loudly if the templates dir moves,
   * the manifest is renamed, or `docs:` stops being parsed — so the assertion
   * below can never pass vacuously.
   */
  it('actually found the templates and their citations', () => {
    expect(existsSync(TEMPLATES_DIR), `templates dir missing at ${TEMPLATES_DIR}`).toBe(true);
    expect(existsSync(DOCS_ROOT), `docs root missing at ${DOCS_ROOT}`).toBe(true);
    expect(templates.length).toBeGreaterThanOrEqual(10);
    expect(citations.length).toBeGreaterThanOrEqual(20);
  });

  it('resolves every cited slug to a page in the docs source tree', () => {
    const dangling = citations.filter((c) => !docExists(c.slug));
    // Report EVERY dangling citation at once, grouped by slug with its citers —
    // one page is typically cited by many templates, and fixing it fixes them all.
    const report = [...new Set(dangling.map((d) => d.slug))]
      .sort()
      .map((slug) => {
        const citers = dangling.filter((d) => d.slug === slug).map((d) => d.template);
        return `  ${slug}\n      cited by ${citers.length}: ${citers.join(', ')}\n      write it: docs:author { slug: "${slug.split('/').pop()}", section: "${
          slug.includes('/') ? slug.split('/').slice(0, -1).join('/') : 'agent-insights'
        }" }`;
      })
      .join('\n');

    expect(
      dangling,
      dangling.length === 0
        ? ''
        : `${dangling.length} template docs: citation(s) resolve to no page under ${DOCS_ROOT}:\n${report}\n` +
          `\nA docs: slug is shape-checked by validateTemplateManifest but NEVER existence-checked, ` +
          `so this cannot be caught by validating the manifest. Either author the page (docs:author — ` +
          `never hand-write the .mdx, Postgres is canonical) or remove the citation.`,
    ).toEqual([]);
  });

  it('cites the shared template pages from EVERY app-scope root', () => {
    // These are the pages the whole template system leans on; a silent drop of a
    // citation is a regression too, not only a dangling one.
    //
    // The root list is DERIVED from the manifests, never hand-maintained. It used
    // to be a hardcoded five, and that list was wrong in both directions at once:
    // it had already gone stale (six app-scope roots existed; papercusp-agentic-webapp
    // was silently unguarded), and it then broke outright when the four web/desktop
    // roots collapsed into `papercusp-app` (plan unified-app-template-2026-08-23,
    // P-004). A literal list of things the code already knows is a second copy that
    // drifts; deriving it means adding or retiring a root updates this guard for free.
    const appRoots = templates.filter((t) => {
      const manifestPath = ['template.yaml', 'template.yml']
        .map((n) => join(TEMPLATES_DIR, t, n))
        .find((p) => existsSync(p));
      if (!manifestPath) return false;
      const m = parseYaml(readFileSync(manifestPath, 'utf8')) as { scope?: unknown };
      return m?.scope === 'app';
    });

    // Guard the guard: if the derivation ever selects nothing, every assertion
    // below passes vacuously and this test silently stops guarding anything.
    expect(appRoots.length, 'derived zero app-scope roots — the derivation is broken, not the templates').toBeGreaterThan(0);

    for (const root of appRoots) {
      const mine = citations.filter((c) => c.template === root).map((c) => c.slug);
      expect(mine, `${root} should cite the template-system pages`).toEqual(
        expect.arrayContaining([
          'agent-insights/templates-system-design',
          'agent-insights/templates-template-yaml',
        ]),
      );
    }
  });

  it('recommends only current app-scope roots in the system-design runbook', () => {
    const doc = readFileSync(join(DOCS_ROOT, 'agent-insights/templates-system-design.mdx'), 'utf8');
    const scopeSection = doc.split('## Two scopes: app ROOTS and aspects')[1]?.split('\n## ')[0];
    expect(scopeSection, 'the root-selection section must exist').toBeDefined();

    const recommendedRoots = [...(scopeSection ?? '').matchAll(/^\s*\| `([^`]+)` \|/gm)]
      .map((match) => match[1]);
    expect(recommendedRoots.length, 'the root table must contain real recommendations').toBeGreaterThan(0);
    expect(new Set(recommendedRoots).size, 'root recommendations must not be duplicated').toBe(recommendedRoots.length);

    const appRoots = templates.filter((template) => {
      const manifestPath = ['template.yaml', 'template.yml']
        .map((name) => join(TEMPLATES_DIR, template, name))
        .find((path) => existsSync(path));
      if (!manifestPath) return false;
      const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as { scope?: unknown };
      return manifest?.scope === 'app';
    });
    expect(appRoots.length, 'derive the app roots from the maintained manifests').toBeGreaterThan(0);
    expect(
      recommendedRoots.filter((root) => !appRoots.includes(root)),
      'the runbook must not recommend retired roots or aspect templates as app roots',
    ).toEqual([]);
  });
});
