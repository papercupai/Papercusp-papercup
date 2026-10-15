/** Typed promotion edges reuse the destination's existing provenance metadata.
 * Resolution is deterministic and scoped; unavailable evidence refuses the write. */
import { z } from 'zod';
import { InvalidInputError } from '@papercusp/tooldef';
import { getOrgPg } from '@papercusp/db-org';
import { parseFrontmatterBlock } from '@papercusp/docs-engine';
import { parsePlan } from '@papercusp/plan-parser';
import { nonFileAnchorChecker } from './memory/audit-anchors';

export const promotionSourceSchema = z.object({
  kind: z.enum(['memory', 'session-turn', 'work-item', 'report', 'fact', 'decision']),
  ref: z.string().trim().min(1).max(500),
}).strict();
export const promotedFromSchema = z.array(promotionSourceSchema).max(24)
  .describe('Typed sources validated in this workspace before writing: memory UUID; session-turn provider:session:index; work-item WI/EI id; report id; fact key; decision plan#D-NNN.');
export type PromotionSource = z.infer<typeof promotionSourceSchema>;
export type LineageQuery = (text: string, params: string[]) => Promise<Record<string, unknown>[]>;

export const queryPromotionRows: LineageQuery = async (text, params) =>
  Array.from(await getOrgPg().sql.unsafe<Record<string, unknown>[]>(text, params));

export function readPromotedFrom(raw: unknown): PromotionSource[] {
  const parsed = promotedFromSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export async function validatePromotedFrom(
  raw: PromotionSource[] | undefined, workspaceId: string | null | undefined,
  query: LineageQuery = queryPromotionRows,
): Promise<PromotionSource[] | undefined> {
  if (raw === undefined) return undefined;
  const sources = promotedFromSchema.parse(raw);
  if (!sources.length) return [];
  if (!workspaceId) throw new InvalidInputError('promotedFrom: workspace unavailable');
  const checker = nonFileAnchorChecker({ query: async (sql, params) =>
    ({ rows: await query(sql, (params ?? []).map(String)) }) });
  for (const source of sources) {
    let resolved: boolean;
    try {
      if (source.kind === 'memory') {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.ref)) throw new Error('invalid memory UUID');
        const rows = await query('SELECT 1 FROM harness_shared.memory_canonical WHERE workspace_id = $1 AND id = $2::uuid', [workspaceId, source.ref]);
        resolved = rows.length === 1;
      } else {
        resolved = (await checker({ kind: source.kind, value: source.ref },
          { memoryId: 'promotion', workspaceId, anchors: [] })).ok;
      }
    } catch (error) {
      throw new InvalidInputError(`promotedFrom ${source.kind}:${source.ref}: resolution unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!resolved) throw new InvalidInputError(`promotedFrom ${source.kind}:${source.ref}: source missing, ambiguous, or retracted`);
  }
  return sources.filter((s, i) => sources.findIndex(other => other.kind === s.kind && other.ref === s.ref) === i);
}

export function promotionDecisionBody(body: string, sources: PromotionSource[] | undefined): string {
  if (/^Promoted-From:/im.test(body)) throw new InvalidInputError('Use the validated promotedFrom argument instead of body metadata');
  if (sources === undefined) return body;
  return `Promoted-From: ${JSON.stringify(sources)}\n\n${body}`;
}

/** Exact reverse lookup over the three canonical stores. Filter before paging so
 * unrelated prose mentions cannot hide an edge. No embeddings or inference. */
export async function reversePromotions(source: PromotionSource, workspaceId: string | null | undefined,
  limit = 50, query: LineageQuery = queryPromotionRows,
): Promise<{ results: Array<{ kind: string; ref: string; harness?: string }>; truncated: boolean }> {
  promotionSourceSchema.parse(source);
  if (!workspaceId) throw new InvalidInputError('promotion lookup: workspace unavailable');
  const hasSource = (raw: unknown) => readPromotedFrom(raw).some(s => s.kind === source.kind && s.ref === source.ref);
  const results: Array<{ kind: string; ref: string; harness?: string }> = [];
  const facts = await query(`SELECT key, scope, scope_ref, source_provenance FROM harness_shared.agent_facts
    WHERE workspace_id = $1 AND source_provenance->'promotedFrom' @> $2::jsonb
      AND retracted_at IS NULL AND superseded_at IS NULL AND evicted_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())`, [workspaceId, JSON.stringify([source])]);
  for (const fact of facts) results.push({ kind: 'fact', ref: fact.scope === 'workspace'
    ? `fact:workspace:${fact.key}` : `fact:${fact.scope}:${fact.scope_ref}:${fact.key}` });
  const docs = await query(`SELECT harness_slug, doc_id, content FROM harness_shared.harness_docs
    WHERE workspace_id = $1 AND strpos(content, $2) > 0`, [workspaceId, source.ref]);
  for (const doc of docs) {
    const parsed = parseFrontmatterBlock(String(doc.content), { dates: 'string' });
    if (parsed.ok && hasSource(parsed.data?.promotedFrom)) results.push({ kind: 'doc', ref: String(doc.doc_id), harness: String(doc.harness_slug) });
  }
  const plans = await query(`SELECT harness_slug, plan_slug, content FROM harness_shared.harness_plans
    WHERE workspace_id = $1 AND strpos(content, $2) > 0`, [workspaceId, source.ref]);
  for (const plan of plans) for (const decision of parsePlan(String(plan.content), { filePath: `${plan.plan_slug}.md` }).decisions) {
    if (hasSource(decision.promotedFrom)) results.push({ kind: 'decision', ref: `${plan.plan_slug}#${decision.id}`, harness: String(plan.harness_slug) });
  }
  results.sort((a, b) => `${a.kind}:${a.harness ?? ''}:${a.ref}`.localeCompare(`${b.kind}:${b.harness ?? ''}:${b.ref}`));
  return { results: results.slice(0, limit), truncated: results.length > limit };
}
