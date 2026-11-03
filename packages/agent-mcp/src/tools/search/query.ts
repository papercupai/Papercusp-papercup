/**
 * Federated search across workspace state.
 *
 * Each kind ranks its own rows through the lexical seam
 * (`@papercusp/operator-core/lib/search/lexical/rank`): BM25 (pg_textsearch) when the
 * kind's table is a registered BM25 corpus whose index is live, else Postgres full-text
 * search over the `_search` tsvector column (013-fts-indexes.sql). If that fails too, the
 * kind falls back to ILIKE substring search.
 *
 * The kinds are merged by POSITION (reciprocal rank fusion), never by raw score: BM25 is
 * unbounded, ts_rank sits in [0,1), and each BM25 index has its own statistics, so a
 * score-sorted union would hand every slot to whichever kind uses the larger scale
 * (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006).
 *
 * jsonb columns (audit_log.details) are not searched in v1; FTS over jsonb
 * requires a generated text-flattened column deferred to v1.5.
 */

import { z } from 'zod';
import type { Sql } from 'postgres';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
import {
  bm25LegIfAvailable,
  boundedExactTopK,
  fuseByPosition,
  mergeExactAndBm25,
} from '@papercusp/operator-core/lib/search/lexical/rank';

const KINDS = ['tasks', 'goals', 'projects', 'audit'] as const;
type Kind = (typeof KINDS)[number];

/** How a kind ranked its rows this call. */
type KindEngine = 'bm25' | 'fts' | 'ilike' | 'unavailable';

interface KindHit {
  kind: Kind;
  id: string;
  snippet: string;
  /** The kind's own relevance. Not comparable across kinds or engines. */
  kindScore: number;
}

interface SearchHit {
  kind: string;
  id: string;
  snippet: string;
  /** Fused (RRF) score: the merged order, comparable across kinds. */
  score: number;
  /** The kind's own relevance score; ordering within one kind only. */
  kindScore: number;
  /** 1-based position of the hit within its kind. */
  kindRank: number;
}

type TaskSearchRow = { harness_slug: string; feature_id: string; title: string; summary: string; rank: number };
type TaskFallbackRow = { harness_slug: string; feature_id: string; title: string; summary: string };
type GoalSearchRow = { id: string; title: string; rank: number };
type GoalFallbackRow = { id: string; title: string; body: string };
type ProjectSearchRow = { id: string; slug: string; name: string; rank: number };
type ProjectFallbackRow = { id: string; slug: string; name: string };
type AuditSearchRow = { id: string; subject: string; action: string; rank: number };
type AuditFallbackRow = { id: string; subject: string; action: string };

/** A kind's ranked search; reports which engine produced the rows. */
type RankedSearch = () => Promise<{ engine: 'bm25' | 'fts'; hits: KindHit[] }>;

/**
 * Run one kind's search: ranked (BM25 or FTS) first, ILIKE fallback on failure — and if
 * the fallback ALSO fails, record `<kind>_unavailable` instead of erroring the whole
 * search (audit P-048). One kind's outage (dropped table, bad grant, aborted query)
 * degrades that kind only; every other kind still answers.
 */
async function searchKind(
  kind: Kind,
  degradedReasons: string[],
  ranked: RankedSearch,
  ilike: () => Promise<KindHit[]>,
): Promise<{ engine: KindEngine; hits: KindHit[] }> {
  try {
    return await ranked();
  } catch {
    // `_search` missing (pre-013) or any ranked-search failure — try ILIKE.
  }
  try {
    const hits = await ilike();
    degradedReasons.push(`${kind}_using_ilike_fallback`);
    return { engine: 'ilike', hits };
  } catch (e) {
    console.warn(`[search:query] ${kind} unavailable: ${e instanceof Error ? e.message : String(e)}`);
    degradedReasons.push(`${kind}_unavailable`);
    return { engine: 'unavailable', hits: [] };
  }
}

export default defineTool({
  name: 'search:query',
  needsWorkspaceTx: true,
  capability: 'search:read',
  guidance: {
    when: 'User asks an open-ended question that could match anything in the workspace ("anything about auth?", "find references to budget guard"). Cross-resource full-text search over tasks, goals, projects, audit.',
    notWhen: 'For a SPECIFIC resource type, use the dedicated list/get tool — search is broader but ranked less precisely. For repository text, use `search:fulltext`.',
  },
  args: z.object({
    query: z.string().min(1),
    kinds: z.array(z.enum(KINDS)).optional(),
    limit: z.number().int().positive().max(100).default(25),
  }),
  async handler(args, ctx: PapercuspToolContext) {
    const tx = ctx.tx!;
    const sql = tx as unknown as Sql;
    const wantKind = (k: Kind) => !args.kinds || args.kinds.includes(k);
    const degradedReasons: string[] = [];
    const lists: Array<{ kind: Kind; engine: KindEngine; hits: KindHit[] }> = [];

    // plainto_tsquery is forgiving (accepts user-supplied text), and so is
    // to_bm25query (the index's text config tokenizes it; operators are ignored).
    const q = `%${args.query}%`;

    if (wantKind('tasks')) {
      lists.push({
        kind: 'tasks',
        ...(await searchKind(
          'tasks',
          degradedReasons,
          async () => {
            const bm25 = await bm25LegIfAvailable(sql, 'work_items', args.query);
            const rows = bm25
              ? await tx<Array<TaskSearchRow>>`
                  SELECT harness_slug, feature_id, title, summary, ${bm25.score} AS rank
                    FROM harness_shared.harness_features_consolidated
                   WHERE ${bm25.match}
                   ORDER BY ${bm25.order}
                   LIMIT ${args.limit}
                `
              : await tx<Array<TaskSearchRow>>`
                  SELECT harness_slug, feature_id, title, summary,
                         ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
                    FROM harness_shared.harness_features_consolidated
                   WHERE _search @@ plainto_tsquery('english', ${args.query})
                   ORDER BY rank DESC
                   LIMIT ${args.limit}
                `;
            return {
              engine: bm25 ? 'bm25' : 'fts',
              hits: rows.map((r: TaskSearchRow) => ({
                kind: 'tasks' as const,
                id: `${r.harness_slug}/${r.feature_id}`,
                snippet: r.title || (r.summary ?? '').slice(0, 100),
                kindScore: Number(r.rank),
              })),
            };
          },
          async () => {
            const rows = await tx<Array<TaskFallbackRow>>`
              SELECT harness_slug, feature_id, title, summary
                FROM harness_shared.harness_features_consolidated
               WHERE title ILIKE ${q} OR summary ILIKE ${q}
               LIMIT ${args.limit}
            `;
            return rows.map((r: TaskFallbackRow) => ({
              kind: 'tasks' as const,
              id: `${r.harness_slug}/${r.feature_id}`,
              snippet: r.title || (r.summary ?? '').slice(0, 100),
              kindScore: 1,
            }));
          },
        )),
      });
    }

    if (wantKind('goals')) {
      lists.push({
        kind: 'goals',
        ...(await searchKind(
          'goals',
          degradedReasons,
          async () => {
            const bm25 = await bm25LegIfAvailable(sql, 'goals', args.query);
            if (bm25) {
              const rows = await tx<Array<GoalSearchRow>>`
                  SELECT id, title, ${bm25.score} AS rank
                    FROM harness_shared.goals
                   WHERE ${bm25.match}
                   ORDER BY ${bm25.order}
                   LIMIT ${args.limit}
                `;
              const exactRows = await tx<Array<{ id: string; title: string; exact_rank: number }>>`
                ${boundedExactTopK(sql, {
                  columns: sql`id,title`,
                  from: sql`harness_shared.goals`,
                  where: sql`TRUE`,
                  tsv: sql`_search`,
                  query: args.query,
                  limit: args.limit,
                })}
              `;
              const bm25Hits = rows.map((r: GoalSearchRow) => ({
                kind: 'goals' as const,
                id: r.id,
                snippet: r.title,
                kindScore: Number(r.rank),
                rank: Number(r.rank),
              }));
              const exactHits = exactRows.map((r) => ({
                kind: 'goals' as const,
                id: r.id,
                snippet: r.title,
                kindScore: Number(r.exact_rank),
                rank: Number(r.exact_rank),
              }));
              return {
                engine: 'bm25',
                hits: mergeExactAndBm25(exactHits, bm25Hits, (hit) => hit.id, args.limit)
                  .map(({ rank: _rank, fusionRank: _fusionRank, ...hit }) => hit),
              };
            }

            const rows = await tx<Array<GoalSearchRow>>`
                  SELECT id, title, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
                    FROM harness_shared.goals
                   WHERE _search @@ plainto_tsquery('english', ${args.query})
                   ORDER BY rank DESC
                   LIMIT ${args.limit}
                `;
            return {
              engine: 'fts',
              hits: rows.map((r: GoalSearchRow) => ({ kind: 'goals' as const, id: r.id, snippet: r.title, kindScore: Number(r.rank) })),
            };
          },
          async () => {
            const rows = await tx<Array<GoalFallbackRow>>`
              SELECT id, title, body FROM harness_shared.goals
               WHERE title ILIKE ${q} OR body ILIKE ${q}
               LIMIT ${args.limit}
            `;
            return rows.map((r: GoalFallbackRow) => ({ kind: 'goals' as const, id: r.id, snippet: r.title, kindScore: 1 }));
          },
        )),
      });
    }

    if (wantKind('projects')) {
      // projects is not a registered BM25 corpus (a small table of names and slugs):
      // ts_rank_cd ranks it, and position fusion makes that scale irrelevant to the merge.
      lists.push({
        kind: 'projects',
        ...(await searchKind(
          'projects',
          degradedReasons,
          async () => {
            const rows = await tx<Array<ProjectSearchRow>>`
              SELECT id, slug, name, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
                FROM harness_shared.projects
               WHERE _search @@ plainto_tsquery('english', ${args.query})
               ORDER BY rank DESC
               LIMIT ${args.limit}
            `;
            return {
              engine: 'fts',
              hits: rows.map((r: ProjectSearchRow) => ({
                kind: 'projects' as const,
                id: r.slug ?? r.id,
                snippet: r.name,
                kindScore: Number(r.rank),
              })),
            };
          },
          async () => {
            const rows = await tx<Array<ProjectFallbackRow>>`
              SELECT id, slug, name FROM harness_shared.projects
               WHERE name ILIKE ${q} OR slug ILIKE ${q}
               LIMIT ${args.limit}
            `;
            return rows.map((r: ProjectFallbackRow) => ({ kind: 'projects' as const, id: r.slug ?? r.id, snippet: r.name, kindScore: 1 }));
          },
        )),
      });
    }

    if (wantKind('audit')) {
      lists.push({
        kind: 'audit',
        ...(await searchKind(
          'audit',
          degradedReasons,
          async () => {
            const bm25 = await bm25LegIfAvailable(sql, 'audit_log', args.query);
            const rows = bm25
              ? await tx<Array<AuditSearchRow>>`
                  SELECT id, subject, action, ${bm25.score} AS rank
                    FROM harness_shared.audit_log
                   WHERE ${bm25.match}
                   ORDER BY ${bm25.order}
                   LIMIT ${args.limit}
                `
              : await tx<Array<AuditSearchRow>>`
                  SELECT id, subject, action,
                         ts_rank_cd(_search, plainto_tsquery('simple', ${args.query})) AS rank
                    FROM harness_shared.audit_log
                   WHERE _search @@ plainto_tsquery('simple', ${args.query})
                   ORDER BY rank DESC
                   LIMIT ${args.limit}
                `;
            return {
              engine: bm25 ? 'bm25' : 'fts',
              hits: rows.map((r: AuditSearchRow) => ({
                kind: 'audit' as const,
                id: r.id,
                snippet: `${r.action}: ${r.subject}`,
                kindScore: Number(r.rank),
              })),
            };
          },
          async () => {
            const rows = await tx<Array<AuditFallbackRow>>`
              SELECT id, subject, action FROM harness_shared.audit_log
               WHERE subject ILIKE ${q} OR action ILIKE ${q}
               LIMIT ${args.limit}
            `;
            return rows.map((r: AuditFallbackRow) => ({ kind: 'audit' as const, id: r.id, snippet: `${r.action}: ${r.subject}`, kindScore: 1 }));
          },
        )),
      });
    }

    // 'messages' kind (over harness_shared.messages_consolidated) retired
    // here — see retire-work-item-mail-surface-2026-07-26 P-004 /
    // _retired/work-item-mail/RESTORE.md.

    const fused = fuseByPosition(lists.map(l => ({ name: l.kind, rows: l.hits, key: (h: KindHit) => h.id })));
    const hits: SearchHit[] = fused.slice(0, args.limit).map(f => ({
      kind: f.row.kind,
      id: f.row.id,
      snippet: f.row.snippet,
      score: f.score,
      kindScore: f.row.kindScore,
      kindRank: f.position,
    }));

    return {
      data: hits,
      engines: Object.fromEntries(lists.map(l => [l.kind, l.engine])),
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});
