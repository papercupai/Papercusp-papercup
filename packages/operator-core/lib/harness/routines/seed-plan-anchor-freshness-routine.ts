/** Seed ACTIVE by default. Re-seeding preserves the operator's pause/resume choice. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { isCliEntry } from '../../util/cli-entry';
import { PLAN_ANCHOR_FRESHNESS_CRON } from '../../plan-items/anchor-freshness-sweep';

export { PLAN_ANCHOR_FRESHNESS_CRON } from '../../plan-items/anchor-freshness-sweep';
export async function seedPlanAnchorFreshnessRoutine(): Promise<void> {
  const { sql } = getOrgPg();
  const slug = operatorHomeHarnessSlug();
  const ws = activeWorkspaceId();
  const name = 'plan-anchor-freshness';
  const id = `rt_${slug}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const config = JSON.stringify({ cron: PLAN_ANCHOR_FRESHNESS_CRON, cap: 50 });
  await sql`INSERT INTO harness_shared.routines
    (id,install_slug,workspace_id,name,trigger_kind,trigger_config,target_role,concurrency,catchup,active,next_fire_at)
    VALUES (${id},${slug},${ws},${name},'cron',${config}::text::jsonb,'system:plan-anchor-freshness',
      'skip','skip-old',true,now())
    ON CONFLICT (install_slug,name) DO UPDATE SET trigger_config=EXCLUDED.trigger_config,
      target_role=EXCLUDED.target_role,workspace_id=EXCLUDED.workspace_id,updated_at=now()`;
  announceRoutineSeeded('seed-plan-anchor-freshness-routine',
    'packages/operator-core/lib/harness/routines/plan-anchor-freshness-action.ts');
}
if (isCliEntry(import.meta.url)) seedPlanAnchorFreshnessRoutine().then(() => process.exit(0), error => {
  console.error(error); process.exit(1);
});
