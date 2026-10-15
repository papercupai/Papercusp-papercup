import { loadHarnessRegistry } from '../../../packages/operator-core/lib/harness-registry';
import { runAcceptanceBarMigrationInDatabase } from '../../../packages/operator-core/lib/acceptance-bar-migration';
import { checkPlanStartable } from '../../../packages/operator-core/lib/agent-tools/plans/plan-start-gate';
import { getOrgPg, getOrgPgApp } from '@papercusp/db-org';

// Compiled by the maintained host recipe before the disposable rig boots.
// No runtime TS loader or handwritten replacement for the migration/gate.
async function main(): Promise<void> {
const [operation, harnessSlug, planSlug] = process.argv.slice(2);
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL ?? '');
if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1' ||
    !workspaceId?.startsWith('verify-tauri-isolated-') ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !database.port || database.port === '5432') {
  throw new Error('Refusing non-isolated fixture child database');
}
const { sql } = getOrgPg();
try {
  if (operation === 'harness' && ['e2e-fake-plan', 'e2e-fake-chat'].includes(harnessSlug)) {
    const reg = await loadHarnessRegistry(workspaceId);
    const hive = harnessSlug === 'e2e-fake-plan';
    const project = { slug: harnessSlug, path: process.cwd(), ...(hive ? { harness_kind: 'hive', self_repo: true } : {}) };
    const payload = { ...reg, projects: [...reg.projects.filter(p => p.slug !== harnessSlug), project] };
    await sql.unsafe('INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at', [workspaceId, JSON.stringify(payload), Date.now()]);
    type RegistryProject = { slug: string; path: string; harness_kind?: string };
    const rows = await sql.unsafe<Array<{ payload: { projects?: RegistryProject[] } | null }>>('SELECT payload FROM harness_shared.harness_registry WHERE workspace_id = $1', [workspaceId]);
    if (!rows[0]?.payload?.projects?.some(p => p.slug === harnessSlug && p.path === process.cwd() && (!hive || p.harness_kind === 'hive'))) throw new Error('Chat fixture registry write was not retained');
  } else if (operation === 'plan' && harnessSlug && planSlug) {
    console.error('plan-fixture stage=migration:start');
    const result = await runAcceptanceBarMigrationInDatabase({ workspaceId, harnessSlug, planSlug, actorId: 'e2e-plan-fixture', dryRun: false });
    console.error('plan-fixture stage=migration:done gate:start');
    const gate = await checkPlanStartable(planSlug, { workspaceId, harnessSlug }, null, 'start');
    console.error('plan-fixture stage=gate:done');
    if (!gate.ok) throw new Error('Plan fixture launch precondition failed: ' + JSON.stringify({ result, gate }));
  } else {
    throw new Error('Unknown isolated fixture operation');
  }
} finally {
  console.error('plan-fixture stage=pools:end:start');
  // The canonical migration uses withWorkspace(), whose default connection
  // is the distinct org-app singleton. This one-shot child owns both pools;
  // ending only the admin pool leaves the migration's app sockets alive.
  await Promise.all([
    sql.end(),
    ...(operation === 'plan' ? [getOrgPgApp().sql.end()] : []),
  ]);
  console.error('plan-fixture stage=pools:end:done resources=' + JSON.stringify(process.getActiveResourcesInfo()));
  // This diagnostic cannot keep the child alive. If it fires, some other
  // referenced resource survived the pool we actually closed.
  setTimeout(() => {
    console.error('plan-fixture stage=post-cleanup resources=' + JSON.stringify(process.getActiveResourcesInfo()));
  }, 1000).unref();
}
}

export const fixtureChildCompletion = main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
