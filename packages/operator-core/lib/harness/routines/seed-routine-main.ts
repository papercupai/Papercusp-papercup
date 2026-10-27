import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** Policies used by the existing seed CLIs, distinct from runtime upsertRoutine:
 * reseeding normally preserves the operator's active state and next fire time.
 */
export interface RoutineSeedSettings {
  installSlug: string;
  name: string;
  active: boolean;
  triggerConfig: Record<string, unknown> | string;
  targetRole: string;
  tier?: 'durable' | 'ephemeral';
  payloadTemplate?: Record<string, unknown> | string;
  nextFire?: 'now' | 'null';
  replaceActive?: boolean;
  permanentlyInactive?: boolean;
  updateWorkspace?: boolean;
  updateTriggerKind?: boolean;
  updatePayload?: boolean;
}

const json = (value: Record<string, unknown> | string) => typeof value === 'string' ? value : JSON.stringify(value);

function routineSeedArgNumber(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Common GC controls; the caller retains its window name and CLI output. */
export function routineSeedJanitorArguments(cron: string, windowFlag: string, windowKey: string) {
  const active = !process.argv.includes('--inactive');
  const dryRun = process.argv.includes('--dry-run');
  const windowValue = routineSeedArgNumber(windowFlag);
  const maxPerRun = routineSeedArgNumber('--max-per-run');
  return { active, dryRun, windowValue, maxPerRun, triggerConfig: {
    cron,
    ...(windowValue ? { [windowKey]: windowValue } : {}),
    ...(maxPerRun ? { max_per_run: maxPerRun } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  } };
}

export async function seedRoutine(sql: Sql, q: RoutineSeedSettings & { workspaceId: string; id: string }): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at
       ${q.tier === undefined ? sql`` : sql`, tier`}
       ${q.payloadTemplate === undefined ? sql`` : sql`, payload_template`})
    VALUES (${q.id}, ${q.installSlug}, ${q.workspaceId}, ${q.name}, 'cron',
      ${json(q.triggerConfig)}::text::jsonb, ${q.targetRole}, 'skip', 'skip-old', ${q.active},
      ${q.nextFire === 'null' ? sql`NULL` : sql`now()`}
      ${q.tier === undefined ? sql`` : sql`, ${q.tier}`}
      ${q.payloadTemplate === undefined ? sql`` : sql`, ${json(q.payloadTemplate)}::text::jsonb`})
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      ${q.tier === undefined ? sql`` : sql`tier = EXCLUDED.tier,`}
      ${q.updatePayload ? sql`payload_template = EXCLUDED.payload_template,` : sql``}
      ${q.updateTriggerKind ? sql`trigger_kind = EXCLUDED.trigger_kind,` : sql``}
      ${q.updateWorkspace === false ? sql`` : sql`workspace_id = EXCLUDED.workspace_id,`}
      ${q.permanentlyInactive ? sql`active = false,` : q.replaceActive ? sql`active = EXCLUDED.active,` : sql``}
      updated_at = now()
  `;
}

interface RoutineSeedContext { workspaceId: string; id: string; sql: Sql }

/** Shared CLI lifecycle; each caller supplies its options and existing output.
 * The returned promise lets fixtures exercise a CLI without seeding a live row.
 */
export function runRoutineSeed<T extends RoutineSeedSettings>(options: {
  scriptTag: string;
  failurePrefix?: string;
  failureDetail?: 'message' | 'raw';
  prepare: () => T;
  afterSeed: (context: T & RoutineSeedContext) => void | Promise<void>;
  exit?: false;
}): Promise<void> {
  const run = async () => {
    const input = options.prepare();
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    const id = `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const context = { ...input, workspaceId, sql, id };
    await seedRoutine(sql, context);
    await options.afterSeed(context);
  };
  if (options.exit === false) return run();
  return run().then(() => { process.exit(0); }).catch((error: unknown) => {
    console.error(options.failurePrefix ?? `[${options.scriptTag}] FAILED:`,
      options.failureDetail === 'raw' ? error : error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
