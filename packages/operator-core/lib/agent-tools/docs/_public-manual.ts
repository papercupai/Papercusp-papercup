/** Public manual only: reuse Starlight rendering and the docs engine, never private adapters. */
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { getDocs, searchDocs, sliceByHeading, starlightContentAdapter, tokenize, levenshtein, type DocPage, type DocSource } from '@papercusp/docs-engine';
import { frontmatterDocuments, parseDocumentsField, stringifySubjectRef } from '../../harness/docs/subject-ref';
import { REPO_ROOT } from './_repo-paths';

export interface PublicManualSubjectExpansion {
  refs: string[];
  unresolvedDocuments: string[];
}

export function isPublicManualRole(role: unknown): boolean {
  return role === 'papercup' || role === 'papercup-deep';
}

export function resolvePublicManualRoot(cwd = process.cwd(), repoRoot = REPO_ROOT): string {
  const source = path.join(repoRoot, 'apps/papercusp-docs/src/content/docs');
  if (existsSync(path.join(source, 'faq.mdx'))) return source;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 16; i += 1) {
    for (const relative of ['public/manual-source', 'apps/operator/public/manual-source']) {
      const candidate = path.join(dir, relative);
      if (existsSync(path.join(candidate, 'faq.mdx'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A missing public bundle is an outage, never permission to read another corpus.
  return source;
}

export function createPublicManualSource(contentRoot: string): DocSource & {
  revision(): Promise<string>;
  expandSubjectRefs(refs: readonly string[]): Promise<PublicManualSubjectExpansion>;
} {
  const root = path.resolve(contentRoot);
  async function revision(): Promise<string> {
    const canonicalRoot = await fs.realpath(root);
    const files = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name)).map((entry) => entry.name).sort();
    if (!files.includes('faq.mdx')) throw new Error('public manual FAQ is unavailable');
    const hash = createHash('sha256');
    for (const filename of files) {
      const file = path.join(root, filename);
      if (path.dirname(await fs.realpath(file)) !== canonicalRoot) throw new Error('public manual source escaped its root');
      hash.update(filename).update('\0').update(await fs.readFile(file)).update('\0');
    }
    return hash.digest('hex');
  }
  const base = starlightContentAdapter({ name: 'public-manual', contentRoot: root, baseUrl: '/docs', maxDepth: 0, getRevision: revision });
  // No caller-controlled paths, namespaces, traversal or nested private documents.
  const validSlug = (slug: string) => slug === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  async function sourceFile(page: DocPage): Promise<string | null> {
    const canonicalRoot = await fs.realpath(root).catch(() => null);
    if (!canonicalRoot) return null;
    for (const extension of ['.mdx', '.md']) {
      const file = path.resolve(root, `${page.slug}${extension}`);
      if (path.dirname(file) !== root || !existsSync(file)) continue;
      const real = await fs.realpath(file).catch(() => null);
      if (real && path.dirname(real) === canonicalRoot) return file;
    }
    return null;
  }
  async function expandSubjectRefs(refs: readonly string[]): Promise<PublicManualSubjectExpansion> {
    const expanded = new Set<string>();
    const unresolvedDocuments = new Set<string>();
    const pages = await base.listPages().catch(() => [] as DocPage[]);
    for (const raw of refs) {
      const input = raw.trim();
      if (!input) continue;
      const normalized = input.replace(/\\/g, '/');
      let matched: { page: DocPage; file: string | null } | undefined;
      for (const page of pages) {
        const file = await sourceFile(page);
        const repoPath = file ? path.relative(REPO_ROOT, file).split(path.sep).join('/') : '';
        const aliases = new Set([
          page.slug,
          `${page.slug}.mdx`,
          `${page.slug}.md`,
          page.url.replace(/\/$/, ''),
          `public/manual-source/${page.slug}.mdx`,
          `apps/operator/public/manual-source/${page.slug}.mdx`,
          repoPath,
        ]);
        if (aliases.has(normalized) || aliases.has(`/${normalized}`) ||
          (file !== null && path.isAbsolute(input) && path.resolve(input) === path.resolve(file))) {
          matched = { page, file };
          break;
        }
      }
      if (!matched) {
        const mightBePublicDoc = /\.mdx?$/i.test(normalized) || /^\/?docs\//i.test(normalized) ||
          normalized.startsWith('public/manual-source/') || normalized.startsWith('apps/operator/public/manual-source/') ||
          (path.isAbsolute(input) && path.resolve(input).startsWith(`${root}${path.sep}`));
        if (mightBePublicDoc) unresolvedDocuments.add(input);
        else expanded.add(input);
        continue;
      }
      if (!matched.file) {
        unresolvedDocuments.add(input);
        continue;
      }
      const body = await fs.readFile(matched.file, 'utf8').catch(() => null);
      if (body === null) {
        unresolvedDocuments.add(input);
        continue;
      }
      const rawDocuments = frontmatterDocuments(body);
      const entries = Array.isArray(rawDocuments) ? rawDocuments : rawDocuments == null ? [] : [rawDocuments];
      if (!entries.length) {
        unresolvedDocuments.add(input);
        continue;
      }
      let complete = true;
      for (const entry of entries) {
        if (typeof entry !== 'string' || !entry.trim()) {
          complete = false;
          continue;
        }
        const parsed = parseDocumentsField(entry);
        if (!parsed.length) {
          complete = false;
          continue;
        }
        for (const subject of parsed) {
          if (subject.kind === 'path') {
            for (const glob of subject.globs) expanded.add(stringifySubjectRef({ kind: 'path', globs: [glob] }));
          } else {
            expanded.add(stringifySubjectRef(subject));
          }
        }
      }
      if (!complete) unresolvedDocuments.add(input);
    }
    return { refs: [...expanded], unresolvedDocuments: [...unresolvedDocuments] };
  }
  return {
    name: base.name,
    revision,
    expandSubjectRefs,
    listPages: () => base.listPages(),
    getPage: (slug) => validSlug(slug) ? base.getPage(slug) : Promise.resolve(null),
    getContent: (page) => base.getContent(page),
    getSectionMeta: (slug) => validSlug(slug) ? (base.getSectionMeta?.(slug) ?? Promise.resolve({})) : Promise.resolve({}),
    // This read-only surface intentionally exposes rendered public content only.
  };
}

let publicSource: ReturnType<typeof createPublicManualSource> | undefined;
export function publicManualSource() {
  return publicSource ??= createPublicManualSource(resolvePublicManualRoot());
}

export async function searchPublicManual(args: { query: string; limit?: number }, source = publicManualSource()) {
  try {
    const revision = await source.revision();
    // Reuse the docs engine's tokenizer and edit distance. Correct only an
    // unknown long word with a unique nearest public-corpus word; keep exact
    // terms and ambiguous inputs intact. Never consult a private vocabulary.
    const rendered = await Promise.all((await source.listPages()).map(async (page) => ({ page, body: await source.getContent(page) })));
    const vocabulary = new Set<string>();
    for (const { page, body } of rendered) {
      for (const word of tokenize(`${page.title} ${body}`)) {
        if (/^[a-z]{5,}$/.test(word)) vocabulary.add(word);
      }
    }
    const corrected = tokenize(args.query).map((word) => {
      if (!/^[a-z]{5,}$/.test(word) || vocabulary.has(word)) return word;
      const maxDistance = word.length >= 7 ? 2 : 1;
      let distance = maxDistance + 1;
      let nearest = word;
      let tied = false;
      for (const candidate of vocabulary) {
        if (Math.abs(candidate.length - word.length) > maxDistance) continue;
        const d = levenshtein(word, candidate);
        if (d < distance) { distance = d; nearest = candidate; tied = false; }
        else if (d === distance) tied = true;
      }
      return distance <= maxDistance && !tied ? nearest : word;
    }).join(' ');
    const changed = corrected !== tokenize(args.query).join(' ');
    // A FAQ contains many unrelated answers. Project its canonical headings as
    // search documents so the existing engine scores the relevant question and
    // answer, rather than the whole page's generic title and mixed vocabulary.
    // This is a search view only; docs:get still reads the single canonical page.
    const sections = new Map<string, { slug: string; heading: string; body: string }>();
    const searchPages: DocPage[] = rendered.flatMap(({ page, body }) => {
      if (page.slug !== 'faq') return [page];
      const toc = page.toc.map((heading) => ({ title: heading.text, url: `#${heading.id}`, depth: heading.depth }));
      const questions = page.toc.filter((heading) => heading.depth === 2).flatMap((heading) => {
        const section = sliceByHeading(body, heading.id, toc);
        if (!section) return [];
        const slug = `${page.slug}/${heading.id}`;
        sections.set(slug, { slug: page.slug, heading: heading.id, body: section });
        const description = section.match(/^Also asked as: (.+)$/m)?.[1];
        return [{ ...page, slug, slugs: [...page.slugs, heading.id], title: heading.text, description, url: `${page.url}#${heading.id}` }];
      });
      return questions.length ? questions : [page];
    });
    const bodies = new Map(rendered.map(({ page, body }) => [page.slug, body]));
    const searchSource: DocSource = {
      name: source.name,
      listPages: async () => searchPages,
      getPage: (slug) => source.getPage(slug),
      getContent: async (page) => sections.get(page.slug)?.body ?? bodies.get(page.slug) ?? '',
    };
    const searched = await searchDocs(searchSource, { ...args, query: changed ? corrected : args.query });
    const result = { ...searched, hits: searched.hits.map((hit) => {
      const section = sections.get(hit.slug);
      return section ? { ...hit, slug: section.slug, heading: section.heading } : hit;
    }) };
    return { ...result, query: args.query, ...(changed ? { correctedQuery: corrected } : {}), surface: 'public', revision, legs: { lexical: { status: 'ran' }, semantic: { status: 'not-run', reason: 'public-manual lexical fallback' } } };
  } catch {
    return { error: 'public_docs_unavailable', surface: 'public', hits: [], hitCount: 0, recoverable: true, fallbackUrl: '/docs/faq' };
  }
}

export async function getPublicManual(args: { slugs: string[]; heading?: string; offset?: number; source?: boolean }, source = publicManualSource()) {
  if (args.source) return { error: 'public_source_read_forbidden', surface: 'public' };
  try {
    const revision = await source.revision();
    return { ...await getDocs(source, args), surface: 'public', revision };
  } catch {
    return { error: 'public_docs_unavailable', surface: 'public', recoverable: true, fallbackUrl: '/docs/faq' };
  }
}
