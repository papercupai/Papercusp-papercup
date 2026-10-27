/** Plan/doc adapters over the existing canonical prose and section indexes.
 * Audience is supplied by the host, before a source applies ranking or limits. */
import type { Listing, SearchSource, SearchSourceParams } from '@papercusp/search';
import type { Sql } from 'postgres';
import { chunkAwareVectorLegSql, sectionAnchorBase, withIterativeScan } from '@papercusp/search';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { PLANS_CHUNK_SURFACE } from '../../search/chunks/registry';
import { boundedExactTopK, headlineTsQuery, lexicalLeg, mergeExactAndBm25 } from '../../search/lexical/rank';
import { PROSE_EMBEDDING_SPACE } from '../../search/prose-vector-dims';
import { lastMarkdownHeading, planWindowMidpoint } from '../plans/semantic-leg';

export interface KnowledgeAudience {
  harnessSlugs?: readonly string[];
  automatic?: boolean;
  excludedRefs?: ReadonlySet<string>;
  /** Work discovery: return structured items from current draft plans. */
  draftItems?: boolean;
}

type SectionRow = {
  source_id: string; title: string; content: string; highlight: string;
  scope: string; rank: number; section: string | null; status: string | null;
  updated_at: string | Date | null; path: string; source_key?: string;
};

/** Use the existing cancellation/transaction contract on both search legs. */
export function boundedSource(source: SearchSource): SearchSource {
  const run = async (leg: NonNullable<SearchSource['lexical']>, p: SearchSourceParams, vector: boolean) => {
    const finishSetup = p.phaseTimer?.start('bounded-org-txn-setup');
    try {
      return await boundedOrgTxn(async sql => {
        finishSetup?.('fulfilled');
        return vector
          ? withIterativeScan(sql, tx => leg({ ...p, sql: tx }), {
            runReadOnlyTransaction: async body => body(sql),
          })
          : leg({ ...p, sql });
      }, {
        client: p.sql, signal: p.signal, readOnly: true, statementTimeoutMs: 1_500,
      });
    } catch (error) {
      finishSetup?.('rejected');
      throw error;
    }
  };
  return { ...source,
    lexical: p => run(source.lexical, p, false),
    embedding: source.embedding ? p => run(source.embedding!, p, true) : undefined,
  };
}

/** Preserve a little preceding context around the actual lexical match. */
export function sectionExcerpt(body: string, highlight: string, precedingChars = 300): { content: string; section: string | null } {
  const plain = highlight.replace(/<\/?mark>/g, '').trim();
  const snippetAt = plain ? body.indexOf(plain) : -1;
  const term = /<mark>(.*?)<\/mark>/.exec(highlight)?.[1];
  const termAt = term ? body.toLowerCase().indexOf(term.toLowerCase(), Math.max(0,snippetAt)) : -1;
  const at = termAt >= 0 ? termAt : snippetAt;
  const start = at < 0 ? 0 : Math.max(0, at - precedingChars);
  return { content: body.slice(start, start + 1_500),
    section: lastMarkdownHeading(body.slice(0, Math.max(0, at))) };
}

function listing(rows: SectionRow[], source: 'plan' | 'doc', ranker: string): Listing {
  return rows.map(r => ({ key: `${source}:${r.source_id}`, score: Number(r.rank), row: {
    source, source_id: r.source_id, scope: r.scope, ts: r.updated_at,
    excerpt: `${r.title.slice(0,100)}${r.section ? ` › ${r.section.slice(0,100)}` : ''}\n${r.content}`.slice(0, 1500),
    highlight: r.highlight || r.content.slice(0, 1500), score: Number(r.rank), rankers: [ranker],
    meta: { title: r.title, section: r.section, status: r.status,
      currentness: source === 'doc' ? 'maintained-procedure' : r.status === 'historical' ? 'historical' : 'plan', path: r.path,
      ...(r.source_key ? { docSourceKey: r.source_key } : {}) },
  } }));
}

/** Keep a source's harness/ambient fence in SQL, including on vector legs. */
export function createPlanSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    p.workspace_id = ${p.workspaceId} AND p.template_slug IS NULL
    ${audience.draftItems ? p.sql`AND p.status = 'draft' AND p.archived = false AND p.superseded_by IS NULL` : p.sql``}
    AND (${p.scopeFilter}::text IS NULL OR p.harness_slug = ${p.scopeFilter})
    AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
      OR p.harness_slug = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))
    AND NOT (('plan:' || p.harness_slug || ':' || p.plan_slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    ${audience.automatic ? p.sql`AND p.archived = false AND p.status IS DISTINCT FROM 'superseded'
      AND p.superseded_by IS NULL` : p.sql``}`;
  const map = (rows: Array<Record<string, unknown>>, ranker: string): Listing => {
    if (audience.draftItems) return rows.flatMap(r => {
      const harness = String(r.harness_slug), slug = String(r.plan_slug);
      const items: unknown[] = Array.isArray(r.items) ? r.items : [];
      return items.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.status !== 'string') return [];
        return [{ key: `plan:${harness}:${slug}#${item.id}`, score: Number(r.rank), row: {
          source: 'plan', source_id: `${harness}:${slug}#${item.id}`, scope: harness,
          excerpt: item.text, highlight: item.text, score: Number(r.rank), rankers: [ranker],
          meta: { title: item.text, planTitle: String(r.title ?? slug), status: 'draft', planSlug: slug,
            itemId: item.id, itemStatus: item.status,
            path: `/admin/plans?plan=${encodeURIComponent(slug)}&harness=${encodeURIComponent(harness)}` },
        } }];
      });
    });
    return listing(rows.map(r => {
    const harness = String(r.harness_slug), slug = String(r.plan_slug);
    const matched = sectionExcerpt(String(r.content ?? ''), String(r.highlight ?? ''));
    const content = r.match_content == null ? matched.content : String(r.match_content);
    const section = r.match_content != null
      ? lastMarkdownHeading(content) ?? (r.section_prefix ? lastMarkdownHeading(String(r.section_prefix)) : null)
      : matched.section;
    return { source_id: `${harness}:${slug}`, title: String(r.title ?? slug), content,
      highlight: String(r.highlight ?? content), scope: `harness:${harness}`, rank: Number(r.rank),
      section, status: r.archived || r.superseded_by || r.status === 'superseded' ? 'historical' : String(r.status),
      updated_at: r.updated_at as string | Date,
      path: `/admin/plans?plan=${encodeURIComponent(slug)}&harness=${encodeURIComponent(harness)}` };
    }), 'plan', ranker);
  };
  return boundedSource({
    name: 'plan',
    async lexical(p) {
      const leg = await lexicalLeg(p.sql, {
        table: 'harness_plans', alias: 'p', query: p.query,
        legacy: {
          score: p.sql`ts_rank_cd(p._search, plainto_tsquery('english', ${p.query}))`,
          match: p.sql`p._search @@ plainto_tsquery('english', ${p.query})`,
        },
      });
      if (audience.draftItems) {
        // Reuse the plan index for candidates and the structured item text
        // for relevance, so matching P-NNNs compete in the existing ranker.
        const text = p.sql`to_tsvector('english', item->>'text')`;
        const query = p.sql`plainto_tsquery('english', ${p.query})`;
        const rows = await p.sql`SELECT p.plan_slug, p.harness_slug, p.title,
            jsonb_build_array(item) AS items, ts_rank_cd(${text}, ${query})::float8 AS rank
          FROM harness_shared.harness_plans p
          CROSS JOIN LATERAL jsonb_array_elements(p.items) item
          WHERE ${filter(p)} AND ${leg.match} AND ${text} @@ ${query}
          ORDER BY rank DESC, p.plan_slug, item->>'id' LIMIT ${p.limit}`;
        return map(rows as Array<Record<string, unknown>>, 'lexical');
      }
      const rows = await p.sql`SELECT p.workspace_id, p.plan_slug, p.harness_slug, p.title, p.status, p.archived, p.superseded_by, p.updated_at, p.content,
        (${leg.score})::float8 AS rank,
        ts_headline('english', p.content, ${headlineTsQuery(p.sql, leg.engine, p.query)},
          'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight
        FROM harness_shared.harness_plans p WHERE ${filter(p)}
          AND ${leg.match}
        ORDER BY ${leg.order}, p.plan_slug LIMIT ${p.limit}`;
      if (leg.engine !== 'bm25') return map(rows as Array<Record<string, unknown>>, 'lexical');

      // D-016: a bounded legacy AND list protects long plans from BM25's OR-only
      // fragment loss. Reuse its GIN-backed cap and interleaver; keep the same
      // workspace, harness, template, audience, exclusion and currentness fences.
      const exactTop = boundedExactTopK(p.sql as unknown as Sql, {
        columns: p.sql`p.workspace_id, p.harness_slug, p.plan_slug`,
        from: p.sql`harness_shared.harness_plans p`, where: filter(p),
        tsv: p.sql`p._search`, query: p.query, limit: p.limit,
      });
      const exactRows = await p.sql`
        SELECT p.workspace_id, p.plan_slug, p.harness_slug, p.title, p.status, p.archived,
               p.superseded_by, p.updated_at, p.content, e.exact_rank::float8 AS rank,
               ts_headline('english', p.content, ${headlineTsQuery(p.sql, 'legacy', p.query)},
                 'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight
          FROM (${exactTop}) e
          JOIN harness_shared.harness_plans p
            USING (workspace_id, harness_slug, plan_slug)
         WHERE ${filter(p)}
      ORDER BY e.exact_rank DESC`;
      const fused = mergeExactAndBm25(
        exactRows as unknown as Array<Record<string, unknown> & { rank: number }>,
        rows as unknown as Array<Record<string, unknown> & { rank: number }>,
        r => `${String(r.workspace_id)}\u0000${String(r.harness_slug)}\u0000${String(r.plan_slug)}`,
        p.limit,
      );
      return map(fused, 'lexical');
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const space = (profile: string | null, mode: string | null) => profile && mode
        ? PROSE_EMBEDDING_SPACE.sourceFilterSql(p, profile, mode) : p.sql`FALSE`;
      const best = chunkAwareVectorLegSql(p.sql, { surface: PLANS_CHUNK_SURFACE, qVec: p.qVec!,
        limit: p.limit, mode: 'retrieve', parentFilter: filter(p),
        spaceFilter: cols => space(cols.profileColumn, cols.modeColumn) });
      const rows = await p.sql`WITH best AS (${best})
        SELECT p.plan_slug, p.harness_slug, p.title, p.status, p.archived, p.superseded_by, p.updated_at,
          ${audience.draftItems ? p.sql`p.items` : p.sql`NULL::jsonb`} AS items,
          1 - b.distance AS rank, coalesce(c.content, left(p.content, 1500)) AS match_content,
          CASE WHEN c.chunk_idx IS NULL THEN NULL
            ELSE left(p.content, ${planWindowMidpoint(0)} + c.chunk_idx * ${planWindowMidpoint(1) - planWindowMidpoint(0)}) END AS section_prefix
        FROM best b JOIN harness_shared.harness_plans p
          ON p.workspace_id = b.workspace_id AND p.harness_slug = b.harness_slug AND p.plan_slug = b.plan_slug
        LEFT JOIN LATERAL (SELECT c.content, c.chunk_idx FROM harness_shared.text_chunks c
          WHERE c.surface = 'plans' AND c.parent_key = ARRAY[p.workspace_id,p.harness_slug,p.plan_slug]
            AND c.embedding IS NOT NULL AND ${space('c.embedding_profile', 'c.embedding_mode')}
            AND abs((c.embedding <=> ${p.qVec}::vector) + ${PLANS_CHUNK_SURFACE.chunkMargin ?? 0} - b.distance) < 0.000001
          ORDER BY c.embedding <=> ${p.qVec}::vector, c.chunk_idx LIMIT 1) c ON true
        ORDER BY b.distance, p.plan_slug`;
      return map(rows as Array<Record<string, unknown>>, 'embeddings');
    },
  });
}

/** doc_sections is a derived complete-body cache, scoped by the source key.
 * Framework docs are shared; harness docs require workspace membership. */
export function createDocSearchSource(audience: KnowledgeAudience = {}): SearchSource {
  const filter = (p: SearchSourceParams) => p.sql`
    (s.source_key = 'papercusp-engineering' OR EXISTS (
      SELECT 1 FROM harness_shared.harness_registry h,
        jsonb_array_elements(h.payload->'projects') project
      WHERE h.workspace_id = ${p.workspaceId} AND s.source_key = 'harness:' || (project->>'slug')
        AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
          OR (project->>'slug') = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))))
    AND (${p.scopeFilter}::text IS NULL OR s.source_key = 'harness:' || ${p.scopeFilter}
      OR (${p.scopeFilter} = 'papercusp' AND s.source_key = 'papercusp-engineering'))
    AND NOT (('doc:' || s.source_key || ':' || s.slug) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
    AND NOT EXISTS (SELECT 1 FROM harness_shared.harness_docs d
      WHERE d.workspace_id = ${p.workspaceId}
        AND d.harness_slug = CASE WHEN s.source_key = 'papercusp-engineering' THEN 'papercusp'
          ELSE substring(s.source_key from 9) END
        AND d.doc_id IN (s.slug || '.mdx',s.slug || '.md') AND d.retired_at IS NOT NULL)
    ${audience.automatic ? p.sql`AND s.slug NOT LIKE 'plans/%' AND s.slug NOT LIKE 'reference/plans-%'` : p.sql``}`;
  const map = (rows: Array<Record<string, unknown>>, ranker: string) => listing(rows.map(r => {
    const key = String(r.source_key), slug = String(r.slug), anchor = sectionAnchorBase(String(r.anchor));
    const current = ranker === 'lexical' ? sectionExcerpt(String(r.content),String(r.highlight ?? ''),100).content : String(r.content);
    const content = `${r.previous_context ? `${r.previous_context}\n` : ''}${current}`;
    return { source_id: `${key}:${slug}`, title: String(r.title), content,
      highlight: content, scope: key === 'papercusp-engineering' ? 'operator' : key,
      rank: Number(r.rank), section: anchor || null, status: 'maintained', updated_at: r.updated_at as string | Date,
      path: String(r.url) + (anchor ? `#${anchor}` : ''), source_key: key };
  }), 'doc', ranker);
  /**
   * Keep enough nearest sections for document de-duplication while preserving
   * an ANN-compatible ORDER BY. The old query deduped the whole filtered
   * corpus before ranking, which forced a primary-key scan and sort even
   * though doc_sections has an HNSW index on embedding. Four times the source
   * page is the same bounded over-fetch used by the outer search engine; the
   * final DISTINCT ON still chooses one best section per document.
   */
  const embeddingCandidateLimit = (limit: number): number => Math.max(1, Math.ceil(limit * 4));
  return boundedSource({
    name: 'doc',
    async lexical(p) {
      const rows = await p.sql`SELECT * FROM (SELECT DISTINCT ON (s.source_key,s.slug) s.*,
        ts_rank_cd(to_tsvector('english', s.title || E'\n' || s.content), plainto_tsquery('english', ${p.query})) AS rank,
        ts_headline('english',s.content,plainto_tsquery('english',${p.query}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=90,MinWords=30,MaxFragments=1') AS highlight,
        (SELECT right(prev.content,250) FROM harness_shared.doc_sections prev
          WHERE prev.source_key = s.source_key AND prev.slug = s.slug
            AND s.section_idx > 0 AND prev.section_idx = s.section_idx - 1 LIMIT 1) AS previous_context
        FROM harness_shared.doc_sections s WHERE ${filter(p)}
          AND to_tsvector('english', s.title || E'\n' || s.content) @@ plainto_tsquery('english', ${p.query})
        ORDER BY s.source_key,s.slug,rank DESC,s.anchor) best
        ORDER BY rank DESC,source_key,slug LIMIT ${p.limit}`;
      return map(rows as Array<Record<string, unknown>>, 'lexical');
    },
    async embedding(p) {
      if (!p.embeddingProfile) return [];
      const candidateLimit = embeddingCandidateLimit(p.limit);
      const rows = await p.sql`WITH candidates AS MATERIALIZED (
          SELECT s.*, s.embedding <=> ${p.qVec}::vector AS distance
          FROM harness_shared.doc_sections s
          WHERE ${filter(p)} AND s.embedding IS NOT NULL
            AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p, 's.embedding_profile', 's.embedding_mode')}
          ORDER BY s.embedding <=> ${p.qVec}::vector
          LIMIT ${candidateLimit}
        ), best AS (
          SELECT DISTINCT ON (source_key,slug) candidates.*,
            1 - distance AS rank
          FROM candidates
          ORDER BY source_key,slug,distance,anchor
        )
        SELECT best.*,
          (SELECT right(prev.content,250) FROM harness_shared.doc_sections prev
            WHERE prev.source_key = best.source_key AND prev.slug = best.slug
              AND best.section_idx > 0 AND prev.section_idx = best.section_idx - 1 LIMIT 1) AS previous_context
        FROM best
        ORDER BY rank DESC,source_key,slug LIMIT ${p.limit}`;
      return map(rows as Array<Record<string, unknown>>, 'embeddings');
    },
  });
}

