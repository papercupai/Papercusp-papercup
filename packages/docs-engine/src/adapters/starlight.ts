/**
 * starlightContentAdapter — wrap an Astro/Starlight content directory as a DocSource.
 *
 * Reads MDX/MD pages from a Starlight content collection on disk
 * (typically `apps/operator-docs/src/content/docs/`). Astro content
 * collections are filesystem-backed, so the adapter doesn't need a
 * running Astro server — just the source files.
 *
 * Slug rules (Starlight conventions):
 *   - <root>/index.mdx                → slug = ''        (root index)
 *   - <root>/performance.mdx          → slug = 'performance'
 *   - <root>/agents/index.mdx         → slug = 'agents'   (section index)
 *   - <root>/agents/operator.mdx      → slug = 'agents/operator'
 *
 * URL rules: '<baseUrl>/<slug>' for non-root, '<baseUrl>/' for root.
 *
 * Section metadata is derived from `<section>/index.mdx` frontmatter
 * (title, description) when present; otherwise falls back to
 * humanize(sectionSlug).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { humanize } from '../shared.js';
import { raceWithAbort, renderMdxToMarkdown, throwIfAborted } from '../render-mdx.js';
import { parseOkfFrontmatter } from '../okf.js';
import type { DocContentOptions, DocListPagesOptions, DocPage, DocSource, SectionMeta } from '../types.js';

export interface StarlightContentAdapterOptions {
  /** Stable identifier for cache namespacing + telemetry. */
  name?: string;
  /**
   * Absolute path to the content collection root.
   * For operator-docs this is `apps/operator-docs/src/content/docs`.
   */
  contentRoot: string;
  /**
   * Base URL prefix the docs site renders these pages at.
   * Defaults to '/internal/docs'.
   */
  baseUrl?: string;
  /** Max scan depth. Defaults to 8 (deep enough for any practical section nesting). */
  maxDepth?: number;
  /** Published corpus revision. A changed revision drops metadata and rendered answers. */
  getRevision?: () => string | Promise<string>;
}

const MAX_FILE_BYTES = 1024 * 1024;

interface StarlightPage extends DocPage {
  absolutePath: string;
  /**
   * Lazily-populated, process-lifetime cache of getContent()'s rendered
   * markdown body (EI-8965). Rendering runs the full remark/remark-mdx/
   * remark-gfm pipeline per page; searchDocs calls getContent for EVERY
   * page on EVERY search (search.ts:79-90), so before this cache a single
   * search re-rendered the WHOLE corpus from scratch each time. At the
   * original ~120-page corpus that was fine (search.ts's own comment says
   * so); the corpus has since grown to 600+ pages and a cold search took
   * ~18.7s — right up against docs-qa.test.ts's 30s budget, so it started
   * timing out under any concurrent host load. The cache is cleared by
   * `invalidate()` when a writer updates the on-disk corpus in this process.
   */
  renderedBody?: string;
  /** Shared by concurrent cold readers so one corpus search performs one render per page. */
  renderedBodyPromise?: Promise<string>;
  /** Cancel queued page renders only after every caller stops waiting. */
  renderController?: AbortController;
  renderWaiters?: number;
}

export interface StarlightContentSource extends DocSource {
  /** Drop page metadata and rendered-body caches after a source write. */
  invalidate(): void;
}

/** Parse YAML-style frontmatter; returns { meta, body } where meta is a flat record. */
function parseFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: source };
  const block = m[1];
  const meta: Record<string, string> = {};
  // Top-level scalar keys only; nested blocks (sidebar:) are read separately if needed.
  for (const line of block.split(/\r?\n/)) {
    const km = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    let v = km[2].trim();
    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v === '') continue; // skip block-scalar parents (e.g. `sidebar:`)
    meta[km[1]] = v;
  }
  return { meta, body: source.slice(m[0].length) };
}

function extractHeadings(content: string): DocPage['toc'] {
  const out: DocPage['toc'] = [];
  for (const line of content.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    const id = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    out.push({ id, text, depth: m[1].length });
    if (out.length >= 100) break;
  }
  return out;
}

function slugFromRelPath(rel: string): string {
  let s = rel.replace(/\.(mdx|md)$/i, '');
  // index.mdx maps to the parent directory's slug
  if (s === 'index') return '';
  if (s.endsWith('/index')) return s.slice(0, -'/index'.length);
  return s;
}

async function readSafe(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

async function getCachedPageContent(page: StarlightPage, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (page.renderedBody !== undefined) return page.renderedBody;

  if (page.renderedBodyPromise && page.renderController?.signal.aborted) {
    const cancelled = page.renderedBodyPromise;
    try {
      return await raceWithAbort(cancelled, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (page.renderedBody !== undefined) return page.renderedBody;
      // The cancelled promise has now settled and cleared itself. Start a fresh
      // shared render for this caller instead of reusing an aborted controller.
      return await getCachedPageContent(page, signal);
    }
  }

  if (!page.renderedBodyPromise) {
    const controller = new AbortController();
    page.renderController = controller;
    page.renderWaiters = 0;
    const pending = (async () => {
      const raw = await readSafe(page.absolutePath);
      if (raw === null) {
        throw new Error(`starlightContentAdapter: could not read ${page.absolutePath}`);
      }
      throwIfAborted(controller.signal);
      const { body } = parseFrontmatter(raw);
      const rendered = /\.mdx$/i.test(page.absolutePath)
        ? await renderMdxToMarkdown(body, page.absolutePath, controller.signal)
        : body;
      page.renderedBody = rendered;
      return rendered;
    })();
    let shared: Promise<string>;
    shared = pending.catch((error) => {
      if (page.renderedBodyPromise === shared) {
        page.renderedBodyPromise = undefined;
        page.renderController = undefined;
        page.renderWaiters = 0;
      }
      throw error;
    });
    page.renderedBodyPromise = shared;
    // A caller can abort while this shared render remains queued. Keep the
    // rejection observed even after the final waiter leaves.
    void shared.catch(() => undefined);
  }

  const shared = page.renderedBodyPromise;
  if (!shared) throw new Error(`starlightContentAdapter: render promise missing for ${page.slug}`);
  const controller = page.renderController;
  page.renderWaiters = (page.renderWaiters ?? 0) + 1;
  try {
    return await raceWithAbort(shared, signal);
  } finally {
    if (page.renderedBodyPromise === shared) {
      page.renderWaiters = Math.max(0, (page.renderWaiters ?? 1) - 1);
      if (page.renderWaiters === 0) {
        if (page.renderedBody === undefined) controller?.abort();
        else page.renderController = undefined;
      }
    }
  }
}

async function walkContent(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && /\.(mdx|md)$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

export function starlightContentAdapter(opts: StarlightContentAdapterOptions): StarlightContentSource {
  const name = opts.name ?? 'starlight';
  const baseUrl = (opts.baseUrl ?? '/internal/docs').replace(/\/$/, '');
  const contentRoot = path.resolve(opts.contentRoot);
  const maxDepth = opts.maxDepth ?? 8;

  let pageCache: Map<string, StarlightPage> | null = null;
  let cachedRevision: string | undefined;
  let cacheGeneration = 0;
  let pageBuild: Promise<Map<string, StarlightPage>> | null = null;

  function invalidate(): void {
    pageCache = null;
    pageBuild = null;
    cacheGeneration += 1;
  }

  async function buildPages(options?: DocListPagesOptions): Promise<Map<string, StarlightPage>> {
    // Sample before a cache hit too. A failed revision read must not serve an
    // answer whose freshness could not be established.
    const revisionStartedAt = Date.now();
    const revision = await opts.getRevision?.();
    const revisionMs = Math.max(0, Date.now() - revisionStartedAt);
    options?.onTiming?.({ component: 'starlight', phase: 'revision', state: 'completed', elapsedMs: revisionMs });
    if (revision !== cachedRevision) {
      invalidate();
      cachedRevision = revision;
    }
    if (pageCache) {
      options?.onTiming?.({ component: 'starlight', phase: 'cache', state: 'cached', elapsedMs: revisionMs, count: pageCache.size });
      return pageCache;
    }
    if (pageBuild) {
      options?.onTiming?.({ component: 'starlight', phase: 'build', state: 'started' });
      const waitStartedAt = Date.now();
      try {
        const cache = await pageBuild;
        options?.onTiming?.({ component: 'starlight', phase: 'build', state: 'shared', elapsedMs: Math.max(0, Date.now() - waitStartedAt), count: cache.size });
        return cache;
      } catch (error) {
        options?.onTiming?.({ component: 'starlight', phase: 'build', state: 'shared', elapsedMs: Math.max(0, Date.now() - waitStartedAt) });
        throw error;
      }
    }
    const generation = cacheGeneration;
    const building = loadPages(generation, options, revisionMs);
    pageBuild = building;
    try {
      return await building;
    } finally {
      if (pageBuild === building) pageBuild = null;
    }
  }

  async function loadPages(
    generation: number,
    options?: DocListPagesOptions,
    revisionMs = 0,
  ): Promise<Map<string, StarlightPage>> {
    const cache = new Map<string, StarlightPage>();
    const walkStartedAt = Date.now();
    options?.onTiming?.({ component: 'starlight', phase: 'walk', state: 'started' });
    const files = await walkContent(contentRoot, maxDepth);
    const walkMs = Math.max(0, Date.now() - walkStartedAt);
    options?.onTiming?.({ component: 'starlight', phase: 'walk', state: 'completed', elapsedMs: walkMs, count: files.length });
    const readParseStartedAt = Date.now();
    options?.onTiming?.({ component: 'starlight', phase: 'read-parse', state: 'started', count: files.length });
    for (const abs of files) {
      const rel = path.relative(contentRoot, abs).replace(/\\/g, '/');
      const slug = slugFromRelPath(rel);
      const content = await readSafe(abs);
      if (content === null) continue;
      const { meta, body } = parseFrontmatter(content);
      const slugs = slug === '' ? [] : slug.split('/');
      const url = slug === '' ? `${baseUrl}/` : `${baseUrl}/${slug}`;
      const title = meta.title ?? humanize(slugs[slugs.length - 1] ?? 'index');
      // EI-10937: `searchable: false` frontmatter keeps generated aggregator pages
      // (the *-index title-dumps) OUT of the search corpus. Only an explicit
      // `false` opts out — anything else (absent, `true`, junk) stays searchable.
      const searchable = meta.searchable === 'false' ? false : undefined;
      // OKF v0.2 (P-005). Parsed from the RAW frontmatter block rather than `meta`
      // above, which is a flat top-level-scalar reader by construction and so cannot
      // see `generated:` / `verified:` (nested blocks) at all. Absent → no OKF keys.
      const okf = parseOkfFrontmatter(content);
      const page: StarlightPage = {
        slug,
        slugs,
        url,
        title,
        ...(meta.description ? { description: meta.description } : {}),
        ...(searchable === false ? { searchable: false as const } : {}),
        ...(okf ? { okf } : {}),
        toc: extractHeadings(body),
        absolutePath: abs,
      };
      cache.set(slug, page);
    }
    const readParseMs = Math.max(0, Date.now() - readParseStartedAt);
    options?.onTiming?.({ component: 'starlight', phase: 'read-parse', state: 'completed', elapsedMs: readParseMs, count: cache.size });
    options?.onTiming?.({
      component: 'starlight',
      phase: 'build',
      state: 'completed',
      elapsedMs: revisionMs + walkMs + readParseMs,
      count: cache.size,
    });
    // An old in-flight scan cannot repopulate a newer revision's cache.
    if (generation === cacheGeneration) pageCache = cache;
    return cache;
  }

  return {
    name,
    invalidate,
    async listPages(options?: DocListPagesOptions): Promise<DocPage[]> {
      const cache = await buildPages(options);
      return [...cache.values()].map(({ absolutePath: _abs, ...page }) => page);
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const cache = await buildPages();
      const sp = cache.get(slug);
      if (!sp) return null;
      const { absolutePath: _abs, ...page } = sp;
      return page;
    },
    async getContent(page: DocPage, options?: DocContentOptions): Promise<string> {
      const signal = options?.signal;
      const work = (async () => {
        throwIfAborted(signal);
        const cache = await buildPages();
        throwIfAborted(signal);
        const sp = cache.get(page.slug);
        if (!sp) throw new Error(`starlightContentAdapter: page ${page.slug} not found`);
        return await getCachedPageContent(sp, signal);
      })();
      return await raceWithAbort(work, signal);
    },
    // WI-1511581: the file exactly as it sits on disk — frontmatter included, MDX
    // unrendered. Not cached alongside `renderedBody`: this is the authoring read,
    // so a stale hit would hand back bytes the file no longer has and the write
    // would silently revert someone. `readSafe` returning null (missing, not a
    // file, over the size cap) is reported as "no source" so the caller refuses,
    // rather than throwing or falling back to the lossy `getContent` projection.
    async getSource(page: DocPage): Promise<string | null> {
      const cache = await buildPages();
      const sp = cache.get(page.slug);
      if (!sp) return null;
      return await readSafe(sp.absolutePath);
    },
    async getSectionMeta(sectionSlug: string): Promise<SectionMeta> {
      // Try `<section>/index.mdx` frontmatter (Starlight section-intro convention).
      const candidates = [
        path.join(contentRoot, sectionSlug, 'index.mdx'),
        path.join(contentRoot, sectionSlug, 'index.md'),
      ];
      for (const abs of candidates) {
        const raw = await readSafe(abs);
        if (raw === null) continue;
        const { meta } = parseFrontmatter(raw);
        return {
          ...(meta.title ? { title: meta.title } : {}),
          ...(meta.description ? { description: meta.description } : {}),
        };
      }
      return {};
    },
  };
}
