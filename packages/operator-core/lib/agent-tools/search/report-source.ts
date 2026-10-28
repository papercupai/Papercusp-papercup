import type { SearchSource, SearchSourceParams, Listing } from '@papercusp/search';
import { visibleTo, type ReportViewer } from '../../report-library';
import { PROSE_EMBEDDING_SPACE } from '../../search/prose-vector-dims';
import { reportsLibraryDisabled } from '../reports/_shared';
import { boundedSource, sectionExcerpt, type KnowledgeAudience } from './knowledge-sources';
import { lastMarkdownHeading } from '../plans/semantic-leg';
import { headlineTsQuery, lexicalLeg } from '../../search/lexical/rank';

type HitRow = { report_id: string; title: string; summary: string; origin_harness_slug: string | null;
  published_at: string; rank: number; highlight: string; body_md?: string;
  match_content?: string; section_prefix?: string | null; lineage_id?: string };
function hits(rows: HitRow[], ranker: string): Listing {
  return rows.map(r => {
    const matched = sectionExcerpt(r.body_md ?? '', r.highlight);
    const content = r.match_content ?? matched.content;
    const section = r.match_content != null ? lastMarkdownHeading(content)
      ?? (r.section_prefix ? lastMarkdownHeading(r.section_prefix) : null) : matched.section;
    return { key: `report:${r.report_id}`, score: Number(r.rank), row: {
    source: 'report', source_id: r.report_id, ...(r.origin_harness_slug ? { scope: r.origin_harness_slug } : {}),
    ts: r.published_at, excerpt: `${r.title}${section ? ` › ${section}` : ''}\n${content || r.summary}`.slice(0, 1500),
    highlight: ranker === 'embeddings' ? content : r.highlight,
    score: Number(r.rank), rankers: [ranker], meta: {
      path: `/reports?sel=${encodeURIComponent(r.report_id)}`, section, title: r.title,
      currentness: 'dated-evidence', lineageId: r.lineage_id ?? null,
    },
  } }; });
}

/** Viewer is captured by the server. Author/session filters never confer read access. */
export function createReportSearchSource(viewer: ReportViewer = {}, audience: KnowledgeAudience = {}): SearchSource {
  const latest = (p: SearchSourceParams) => p.sql`
    SELECT DISTINCT ON (lineage_id) report_id FROM harness_shared.report_library
    WHERE workspace_id = ${p.workspaceId} AND retired_at IS NULL AND ${visibleTo(p.sql, viewer)}
      AND (${p.scopeFilter}::text IS NULL OR origin_harness_slug = ${p.scopeFilter})
      AND (${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[] IS NULL
        OR origin_harness_slug = ANY(${audience.harnessSlugs?.length ? [...audience.harnessSlugs] : null}::text[]))
      AND NOT (('report:' || report_id) = ANY(${[...(audience.excludedRefs ?? [])]}::text[]))
      ${audience.automatic ? p.sql`AND NOT EXISTS (SELECT 1 FROM harness_shared.report_library newer
        WHERE newer.workspace_id = ${p.workspaceId} AND newer.lineage_id = report_library.lineage_id
          AND newer.retired_at IS NULL
          AND (newer.published_at,newer.report_id) > (report_library.published_at,report_library.report_id))` : p.sql``}
      AND (${p.filters?.owners ?? null}::text[] IS NULL OR author_owner_id = ANY(${p.filters?.owners ?? null}::text[]))
      AND (${p.filters?.since ?? null}::timestamptz IS NULL OR published_at >= ${p.filters?.since ?? null}::timestamptz)
      AND (${p.filters?.until ?? null}::timestamptz IS NULL OR published_at < ${p.filters?.until ?? null}::timestamptz)
    ORDER BY lineage_id, published_at DESC, report_id DESC`;
  return boundedSource({
    name: 'report',
    async lexical(p) {
      const libraryDisabled = await (p.phaseTimer
        ? p.phaseTimer.measure('report-library-enabled-check', () => reportsLibraryDisabled())
        : reportsLibraryDisabled());
      if (libraryDisabled) return [];
      // BM25 (when available) matches any query term, so its highlight uses an OR tsquery.
      const makeLeg = () => lexicalLeg(p.sql, {
        table: 'report_library', query: p.query,
        legacy: {
          score: p.sql`ts_rank_cd(search_tsv, plainto_tsquery('english', ${p.query}))`,
          match: p.sql`search_tsv @@ plainto_tsquery('english', ${p.query})`,
        },
      });
      const leg = await (p.phaseTimer
        ? p.phaseTimer.measure('bm25-flag-index-availability', makeLeg)
        : makeLeg());
      const highlightColumn = p.wantHighlight === false
        ? p.sql`''::text AS highlight`
        : p.sql`ts_headline('english', body_md, ${headlineTsQuery(p.sql, leg.engine, p.query)},
          'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,MaxFragments=2') AS highlight`;
      const selectRows = () => p.sql`SELECT report_id, title, summary, body_md, lineage_id, origin_harness_slug, published_at,
        (${leg.score})::float8 AS rank,
        ${highlightColumn}
        FROM harness_shared.report_library WHERE report_id IN (${latest(p)})
          AND ${leg.match} ORDER BY ${leg.order}, report_id LIMIT ${p.limit}`;
      const rows = await (p.phaseTimer
        ? p.phaseTimer.measure('report-lexical-sql', selectRows)
        : selectRows());
      return hits(rows as unknown as HitRow[], 'lexical');
    },
    async hydrateHighlights(p, sourceIds) {
      if (sourceIds.length === 0 || await reportsLibraryDisabled()) return new Map();
      const leg = await lexicalLeg(p.sql, {
        table: 'report_library', query: p.query,
        legacy: {
          score: p.sql`ts_rank_cd(search_tsv, plainto_tsquery('english', ${p.query}))`,
          match: p.sql`search_tsv @@ plainto_tsquery('english', ${p.query})`,
        },
      });
      const headlineQuery = headlineTsQuery(p.sql, leg.engine, p.query);
      const rows = await p.sql`SELECT report_id,
          ts_headline('english', body_md, ${headlineQuery},
            'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,MaxFragments=2') AS highlight
        FROM harness_shared.report_library
        WHERE workspace_id = ${p.workspaceId}
          AND report_id = ANY(${sourceIds}::text[])
          AND report_id IN (${latest(p)})
          AND ${leg.match}
        ORDER BY report_id` as unknown as Array<{ report_id: string; highlight: string }>;
      return new Map(rows.map(row => [row.report_id, row.highlight]));
    },
    async embedding(p) {
      if (await reportsLibraryDisabled()) return [];
      // Reports have only chunk vectors. Pool by the nearest visible chunk;
      // visibility applies before ranking/limit and workspace is part of every join.
      const rows = await p.sql`WITH best AS (
        SELECT r.workspace_id, r.report_id, min(c.embedding <=> ${p.qVec}::vector) AS distance
        FROM harness_shared.report_library r JOIN harness_shared.text_chunks c
          ON c.surface = 'report' AND c.parent_key = ARRAY[r.workspace_id, r.report_id]
        WHERE r.workspace_id = ${p.workspaceId} AND r.report_id IN (${latest(p)})
          AND c.embedding IS NOT NULL
          AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p, 'c.embedding_profile', 'c.embedding_mode')}
        GROUP BY r.workspace_id, r.report_id ORDER BY distance, r.report_id LIMIT ${p.limit}
      ) SELECT r.report_id, r.title, r.summary, r.lineage_id, r.origin_harness_slug, r.published_at,
        1 - b.distance AS rank, c.content AS match_content, c.content AS highlight,
        left(concat_ws(E'\n',r.title,nullif(r.summary,''),r.body_md), c.chunk_idx * 1250 + 750) AS section_prefix
        FROM best b JOIN harness_shared.report_library r
          ON r.workspace_id = b.workspace_id AND r.report_id = b.report_id
        JOIN LATERAL (SELECT c.content,c.chunk_idx FROM harness_shared.text_chunks c
          WHERE c.surface = 'report' AND c.parent_key = ARRAY[r.workspace_id,r.report_id]
            AND c.embedding IS NOT NULL
            AND ${PROSE_EMBEDDING_SPACE.sourceFilterSql(p,'c.embedding_profile','c.embedding_mode')}
          ORDER BY c.embedding <=> ${p.qVec}::vector,c.chunk_idx LIMIT 1) c ON true
        ORDER BY b.distance, r.report_id`;
      return hits(rows as unknown as HitRow[], 'embeddings');
    },
  });
}
