/**
 * genericFsAdapter — wrap an arbitrary docs directory as a DocSource.
 *
 * The "third branch" for docs:* — for power-engineer callers running
 * `omp-su` on their own non-harness repo with PAPERCUSP_PROJECT_DOCS_ROOT
 * pointing at their docs tree. Reads `<root>/**\/*.{md,mdx}` straight —
 * no harness-state files, no .papercusp/ slug munging.
 *
 * Slugs are relative paths with the extension stripped:
 *   architecture.md          → architecture
 *   features/auth.md         → features/auth
 *   guides/getting-started.mdx → guides/getting-started
 *
 * Differs from harnessFsAdapter (which walks <projectPath>/docs/) by
 * walking the given root directly — the caller points at the docs root,
 * not the project root.
 *
 * TODO(per-harness-plans-and-docs-2026-05-23 P-002): extractHeadings /
 * extractTitle / readSafe / walkDocs are duplicated here from
 * harness-fs.ts. Cheap duplication for a contained PR; extract to a
 * shared `_fs-helpers.ts` once a third adapter wants them.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { humanize, scanMarkdownHeadings } from '../shared.js';
import { raceWithAbort, renderMdxToMarkdown, throwIfAborted } from '../render-mdx.js';
import { forEachBoundedBatch } from './file-batches.js';
import type { DocContentOptions, DocListPagesOptions, DocPage, DocSource, SectionMeta } from '../types.js';

export interface GenericFsAdapterOptions {
  /** Stable identifier for telemetry + cache namespacing. Defaults to `generic-fs:<basename(root)>`. */
  name?: string;
  /**
   * URL prefix for clickable links in outline payloads. `<baseUrl>/<slug>`.
   * Default: '' (empty — no link). Use `'/project-docs'` to mirror harness docs.
   */
  baseUrl?: string;
  /** Max recursion depth. Defaults to 5 (same as harnessFsAdapter). */
  maxDepth?: number;
}

const MAX_FILE_BYTES = 512 * 1024;

interface FsPage extends DocPage {
  absolutePath: string;
}

export function extractHeadings(content: string): DocPage['toc'] {
  return scanMarkdownHeadings(content).slice(0, 100).map(({ depth, text }) => ({
    id: text.replace(/[^A-Za-z0-9]/g, '-'),
    text,
    depth,
  }));
}

function extractTitle(content: string, fallback: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const m = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
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

async function walkDocs(root: string, maxDepth: number): Promise<string[]> {
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
      } else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

function slugFromRelPath(rel: string): string {
  return rel.replace(/\.(md|mdx)$/i, '').split(path.sep).join('/');
}

export function genericFsAdapter(root: string, opts: GenericFsAdapterOptions = {}): DocSource {
  const name = opts.name ?? `generic-fs:${path.basename(root)}`;
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const maxDepth = opts.maxDepth ?? 5;

  let pageCache: Map<string, FsPage> | null = null;

  async function buildPages(options?: DocListPagesOptions): Promise<Map<string, FsPage>> {
    if (pageCache) {
      options?.onTiming?.({ component: 'generic-fs', phase: 'cache', state: 'cached', count: pageCache.size });
      return pageCache;
    }
    const buildStartedAt = Date.now();
    options?.onTiming?.({ component: 'generic-fs', phase: 'build', state: 'started' });
    const cache = new Map<string, FsPage>();
    const walkStartedAt = Date.now();
    options?.onTiming?.({ component: 'generic-fs', phase: 'walk', state: 'started' });
    const files = await walkDocs(root, maxDepth);
    const walkMs = Math.max(0, Date.now() - walkStartedAt);
    options?.onTiming?.({ component: 'generic-fs', phase: 'walk', state: 'completed', elapsedMs: walkMs, count: files.length });
    const readParseStartedAt = Date.now();
    options?.onTiming?.({ component: 'generic-fs', phase: 'read-parse', state: 'started', count: files.length });
    await forEachBoundedBatch(files, readSafe, (abs, content) => {
      if (content === null) return;
      const rel = path.relative(root, abs);
      const slug = slugFromRelPath(rel);
      const slugs = slug.split('/');
      cache.set(slug, {
        slug,
        slugs,
        url: baseUrl ? `${baseUrl}/${slug}` : '',
        title: extractTitle(content, humanize(slugs[slugs.length - 1])),
        toc: extractHeadings(content),
        absolutePath: abs,
      });
    });
    pageCache = cache;
    const readParseMs = Math.max(0, Date.now() - readParseStartedAt);
    options?.onTiming?.({ component: 'generic-fs', phase: 'read-parse', state: 'completed', elapsedMs: readParseMs, count: cache.size });
    options?.onTiming?.({ component: 'generic-fs', phase: 'build', state: 'completed', elapsedMs: Math.max(0, Date.now() - buildStartedAt), count: cache.size });
    return cache;
  }

  return {
    name,
    async listPages(options?: DocListPagesOptions): Promise<DocPage[]> {
      const cache = await buildPages(options);
      return [...cache.values()].map(({ absolutePath: _abs, ...page }) => page);
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const cache = await buildPages();
      const fp = cache.get(slug);
      if (!fp) return null;
      const { absolutePath: _abs, ...page } = fp;
      return page;
    },
    async getContent(page: DocPage, options?: DocContentOptions): Promise<string> {
      const signal = options?.signal;
      const work = (async () => {
        throwIfAborted(signal);
        const cache = await buildPages();
        throwIfAborted(signal);
        const fp = cache.get(page.slug);
        if (!fp) throw new Error(`genericFsAdapter: page ${page.slug} not found`);
        const content = await readSafe(fp.absolutePath);
        if (content === null) throw new Error(`genericFsAdapter: could not read ${fp.absolutePath}`);
        throwIfAborted(signal);
        if (/\.mdx$/i.test(fp.absolutePath)) {
          return await renderMdxToMarkdown(content, fp.absolutePath, signal);
        }
        return content;
      })();
      return await raceWithAbort(work, signal);
    },
    // WI-1511581: the file exactly as it sits on disk — frontmatter included, MDX
    // unrendered. `readSafe` returning null (missing, not a file, over the size
    // cap) is reported as "no source" so the caller refuses, rather than throwing
    // or falling back to the lossy `getContent` projection.
    async getSource(page: DocPage): Promise<string | null> {
      const cache = await buildPages();
      const fp = cache.get(page.slug);
      if (!fp) return null;
      return await readSafe(fp.absolutePath);
    },
    async getSectionMeta(_sectionSlug: string): Promise<SectionMeta> {
      // Generic-fs doesn't model sections — caller's docs tree has no
      // per-section meta.json equivalent. Return empty.
      return {};
    },
  };
}
