/**
 * plans:get-template-data — read a plan's template TYPE + its STRUCTURED instance
 * data (the `template_data` jsonb), WITHOUT loading/parsing this plan's markdown
 * (plan-templates-and-rubric-v2-2026-06-20 P-005).
 *
 * The structured read complement of plans:set-template-data: agents consume a
 * template-instance plan's data structured, never by scraping this plan's markdown. For
 * acceptance-rubric template instances, verification fields are overlaid from the subject
 * plan's live requirement blocks, matching rubrics:get's current-read contract. Returns the
 * `template` type (frontmatter-derived column), the `template_data` jsonb (null until set),
 * and the row `version`. Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { parseRequirementBars } from '../../acceptance-bar-seed';
import {
  readLiveAcceptanceCriteria,
  type LiveAcceptanceViewDeps,
  type LiveAcceptanceViewStatus,
} from '../../acceptance-live-requirements';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
  slugs: z.array(z.string().min(1)).min(1).max(100).optional().describe('Plan slugs to read in one call.'),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

type TemplateDataRecord = Record<string, unknown>;
type TemplateCriterion = { barKey?: string | null; [key: string]: unknown };

function isRecord(value: unknown): value is TemplateDataRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep `plans:get-template-data` and `rubrics:get` on one current acceptance-read contract.
 * The raw structured object is preserved (including additive fields unknown to this build);
 * only the criteria verification fields are replaced when the subject plan is readable.
 */
export async function projectAcceptanceTemplateData(
  template: string | null,
  templateData: unknown,
  deps: Pick<LiveAcceptanceViewDeps, 'readSubjectPlanContent'> &
    Partial<Pick<LiveAcceptanceViewDeps, 'parseRequirementBars'>>,
): Promise<{ templateData: unknown; liveRequirements?: LiveAcceptanceViewStatus }> {
  if (template !== 'rubric' || !isRecord(templateData) || templateData.kind !== 'acceptance') {
    return { templateData };
  }
  const subjectPlan = templateData.subjectPlan;
  const criteria = templateData.criteria;
  if (typeof subjectPlan !== 'string' || !Array.isArray(criteria)) return { templateData };

  const live = await readLiveAcceptanceCriteria(
    {
      kind: 'acceptance',
      subjectPlan,
      subjectHarnessSlug: typeof templateData.subjectHarnessSlug === 'string' ? templateData.subjectHarnessSlug : null,
      criteria: criteria as TemplateCriterion[],
    },
    {
      readSubjectPlanContent: deps.readSubjectPlanContent,
      parseRequirementBars: deps.parseRequirementBars ?? ((content) => {
        const parsed = parseRequirementBars(content);
        return parsed.ok
          ? { ok: true, bars: parsed.bars.map((bar) => ({ barKey: bar.barKey, ...(bar.criterion ? { criterion: bar.criterion } : {}) })) }
          : { ok: false, problems: parsed.problems };
      }),
    },
  );
  return {
    templateData: live.status.source === 'live-plan'
      ? { ...templateData, criteria: live.criteria }
      : templateData,
    liveRequirements: live.status,
  };
}

export default defineTool({
  name: 'plans:get-template-data',
  description:
    "Read a plan's template TYPE + its STRUCTURED instance data (the `template_data` jsonb) — the structured read complement of plans:set-template-data, without parsing this plan's markdown. For acceptance-rubric instances, verification fields are overlaid from the subject plan's live requirement blocks to match rubrics:get; liveRequirements reports whether the overlay or stored fallback was used. Returns { template, templateData, version }; templateData is null until set. Read-only.",
  guidance: {
    when: 'Reading a template-instance plan\'s structured data (e.g. a rubric instance\'s fields) to consume it programmatically — never scrape it out of this plan\'s markdown. Acceptance-rubric reads align verification fields with rubrics:get through the subject plan\'s live requirement blocks. An evidence-only judge may use this read when rubrics:get cannot project a backing rubric row.',
    notWhen:
      'You need the whole plan (Now / items / decisions / prose) — plans:get. Writing the data — plans:set-template-data. Listing plans of a template type — plans:list { template }.',
    chaining: 'plans:get-template-data { slug } → plans:set-template-data { slug, data } to update it.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (read-only, like plans:get-item) so the supervisor can ground on template instances.
  // The evidence-only judge needs the raw rubric-template fallback when rubrics:get's
  // build-local projection cannot read structured fields written by a newer build.
  agentRoles: [...SU_ROLES, 'kettle', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const row = await getPlanRow(slug, opts);
        if (!row) return { ok: false as const, slug, error: 'not_found' };
        const projected = await projectAcceptanceTemplateData(row.template, row.templateData, {
          readSubjectPlanContent: async ({ planSlug, harnessSlug }) => {
            const subject = await getPlanRow(planSlug, {
              workspaceId: row.workspaceId,
              harnessSlug: harnessSlug ?? row.harnessSlug,
            });
            return subject ? { content: subject.content, version: subject.version } : null;
          },
        });
        return {
          ok: true as const,
          slug: row.planSlug,
          template: row.template,
          templateData: projected.templateData ?? null,
          version: row.version,
          ...(projected.liveRequirements ? { liveRequirements: projected.liveRequirements } : {}),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
