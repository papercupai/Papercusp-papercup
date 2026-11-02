/**
 * Cleanup campaign plan template (code-cleanup-campaigns-2026-10-26 P-007, Design §6).
 *
 * A campaign is a plan whose items are batches, run by a fleet. `buildCampaignPlan` turns the
 * ranked batches from triage (P-005) into:
 *  - `content` for `plans:new`: one item per batch, best first, plus a fenced `campaign-batches`
 *    block that records each batch's id, target files and eject path; and
 *  - `launch` args for `fleet:launch-on-plan`: at most `cap` members, because admission (R-7)
 *    never runs more than `cap` of a campaign's batches at once, so extra members would only idle.
 *
 * `campaignBatchesFromPlan` reads the block back, so a runner feeds exactly those batches to
 * `admitBatches` (./admission). Nothing here touches the tree or the database.
 */
import { DEFAULT_CAMPAIGN_CONCURRENCY_CAP, DEFAULT_RECENT_EDIT_WINDOW_MS, type AdmissionBatch } from './admission';
import { DEFAULT_CLEANUP_AGGRESSIVENESS, type CleanupAggressiveness } from './executor';
import type { TriageBatch } from './triage';

/** Review setting (R-10, D-004): `off` lands each batch as one commit; `required` opens one PR per batch. */
export type CampaignReview = 'off' | 'required';
export const DEFAULT_CAMPAIGN_REVIEW: CampaignReview = 'off';

export interface CampaignPlanInput {
  /** Plan slug for the campaign (also the fleet name). */
  slug: string;
  title?: string;
  /** Ranked batches from triage, best first. */
  batches: readonly TriageBatch[];
  aggressiveness?: CleanupAggressiveness;
  review?: CampaignReview;
  /** Concurrency cap (R-7); defaults to admission's default. */
  cap?: number;
  recentEditWindowMs?: number;
}

export interface CampaignBatchRecord extends AdmissionBatch {
  itemId: string;
  families: number;
  redundantMass: number;
  score: number;
  /** How to undo the batch after it landed. */
  eject: string;
}

export interface CampaignSettings {
  aggressiveness: CleanupAggressiveness;
  review: CampaignReview;
  cap: number;
  recentEditWindowMs: number;
}

export interface CampaignPlan {
  slug: string;
  title: string;
  content: string;
  settings: CampaignSettings;
  batches: CampaignBatchRecord[];
  /** Arguments for `fleet:launch-on-plan`. */
  launch: { name: string; plan: string; count: number; headless: true; brief: string };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const BATCHES_FENCE = 'campaign-batches';

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** The batch id the executor and admission use: the triage area plus the batch's index in it. */
export const campaignBatchId = (batch: TriageBatch) => `${batch.area}#${batch.index}`;

function ejectFor(review: CampaignReview): string {
  return review === 'off'
    ? 'revert the single commit this batch landed as (one batch per commit)'
    : 'close the batch PR unmerged, or revert its merge commit if it was merged';
}

export function buildCampaignPlan(input: CampaignPlanInput): CampaignPlan {
  if (!SLUG_RE.test(input.slug)) throw new Error(`campaign slug must be kebab-case, got "${input.slug}"`);
  if (input.batches.length === 0) throw new Error('a campaign needs at least one batch');
  const settings: CampaignSettings = {
    aggressiveness: input.aggressiveness ?? DEFAULT_CLEANUP_AGGRESSIVENESS,
    review: input.review ?? DEFAULT_CAMPAIGN_REVIEW,
    cap: positiveInt(input.cap ?? DEFAULT_CAMPAIGN_CONCURRENCY_CAP, 'cap'),
    recentEditWindowMs: positiveInt(input.recentEditWindowMs ?? DEFAULT_RECENT_EDIT_WINDOW_MS, 'recentEditWindowMs'),
  };
  const seen = new Set<string>();
  const batches = input.batches.map((b, i): CampaignBatchRecord => {
    const id = campaignBatchId(b);
    if (seen.has(id)) throw new Error(`duplicate batch id ${id}`);
    seen.add(id);
    const targetFiles = [...new Set(b.families.flatMap(f => f.members.map(m => m.path)))].sort();
    return {
      itemId: `P-${String(i + 1).padStart(3, '0')}`, id, targetFiles,
      families: b.families.length, redundantMass: b.redundantMass, score: b.score, eject: ejectFor(settings.review),
    };
  });
  const title = input.title ?? `Cleanup campaign: ${batches.length} clone batch${batches.length === 1 ? '' : 'es'}`;
  const windowMin = Math.round(settings.recentEditWindowMs / 60000);
  const items = batches.map(b =>
    `- **${b.itemId}** \`todo\` Batch ${b.id}: extract ${b.families} clone ${b.families === 1 ? 'family' : 'families'} `
    + `(redundant mass ${b.redundantMass}, score ${Number(b.score.toFixed(4))}) across ${b.targetFiles.length} `
    + `file${b.targetFiles.length === 1 ? '' : 's'}. Eject: ${b.eject}.`);
  const planItemIds = batches.map(b => b.itemId).join(', ');
  const record = batches.map(({ itemId, id, targetFiles, eject }) => ({ itemId, id, targetFiles, eject }));
  const content = [
    `# ${title}`, '',
    '## Goal',
    `Land ${batches.length} cleanup batch${batches.length === 1 ? '' : 'es'}, each a tested refactor that removes duplicated code without changing behavior.`, '',
    '## Settings',
    `- aggressiveness: ${settings.aggressiveness}`,
    `- review: ${settings.review}`,
    `- concurrency cap: ${settings.cap} batches at once`,
    `- recent-edit window: ${windowMin} minutes`, '',
    '## Rules',
    `- Start a batch only through admission: skip it this round when another agent holds a live lock on a target file or edited one in the last ${windowMin} minutes, and never run more than ${settings.cap} batches at once.`,
    '- Make every edit under the batch\'s own file lock.',
    '- Characterization tests for uncovered members land before the refactor (the executor decides).',
    '- Close a batch only with the `refactor` change-kind proof.', '',
    '## Requirements',
    '',
    '**R-1 — Every cleanup batch lands as a tested, behavior-preserving refactor.** Each listed batch removes the duplicated code it targets and passes its characterization/regression checks without changing observable behavior.', '',
    '## Design',
    '',
    'Each batch item implements this requirement; verify the resulting code and tests in the source tree.',
    '',
    '### Bar-to-work map for this plan',
    '',
    '| bar | implementing plan items | evidence plane |',
    '|---|---|---|',
    `| R-1 | ${planItemIds} | tree |`, '',
    '## Items',
    ...items, '',
    '## Batches',
    `\`\`\`${BATCHES_FENCE}`,
    JSON.stringify(record, null, 2),
    '```', '',
  ].join('\n');
  const brief = [
    `You are a member of cleanup campaign ${input.slug}. Each item is one batch; its target files and eject path are in the plan's \`${BATCHES_FENCE}\` block.`,
    `Admission decides which batch you may start: never edit a file another agent holds a live lock on or edited in the last ${windowMin} minutes, and the campaign never runs more than ${settings.cap} batches at once.`,
    `Aggressiveness ${settings.aggressiveness}; review ${settings.review}. Close each batch with the refactor change-kind proof; if it regresses, eject it.`,
  ].join(' ');
  return {
    slug: input.slug, title, content, settings, batches,
    launch: { name: input.slug, plan: input.slug, count: Math.min(settings.cap, batches.length), headless: true, brief },
  };
}

/** The batches recorded in a campaign plan's `campaign-batches` block, in plan order. */
export function campaignBatchesFromPlan(content: string): Array<AdmissionBatch & { itemId: string; eject: string }> {
  const fence = new RegExp('```' + BATCHES_FENCE + '\\n([\\s\\S]*?)\\n```');
  const match = fence.exec(content);
  if (!match) throw new Error(`plan has no \`${BATCHES_FENCE}\` block`);
  const parsed: unknown = JSON.parse(match[1]);
  if (!Array.isArray(parsed)) throw new Error(`\`${BATCHES_FENCE}\` block is not an array`);
  return parsed.map((row, i) => {
    const r = row as Record<string, unknown>;
    if (typeof r.itemId !== 'string' || typeof r.id !== 'string' || typeof r.eject !== 'string'
      || !Array.isArray(r.targetFiles) || !r.targetFiles.every(f => typeof f === 'string')) {
      throw new Error(`\`${BATCHES_FENCE}\` row ${i} is malformed`);
    }
    return { itemId: r.itemId, id: r.id, targetFiles: r.targetFiles as string[], eject: r.eject };
  });
}
