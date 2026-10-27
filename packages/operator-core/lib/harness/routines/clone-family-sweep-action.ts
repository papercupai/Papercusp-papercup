import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { papercuspPath } from '@papercusp/host-platform/home';
import { cloneSweepInputSchema } from '../../code-intelligence/clone-sweep';
import { withConditionReplayLock } from '../../coord/condition-upsert';
import { loadHarnessRegistry } from '../../harness-registry';
import { managedSpawn } from '../../task-manager/managed-spawn';
import { listTasks } from '../../task-manager/store';
import { newTaskId } from '../../task-manager/types';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const CLONE_FAMILY_SWEEP_ACTION = 'clone-family-sweep';
const actor = `system:${CLONE_FAMILY_SWEEP_ACTION}`;
const actionInputSchema = z.union([
  z.object({ harness: z.string().min(1), clonePolicy: z.literal('reuse-signals-v1') }).strict(),
  cloneSweepInputSchema,
]);

/** Managed child + ledger single-flight extends schedule concurrency:'skip' past
 * the short dispatcher step, including host restarts and simultaneous fires.
 */
export async function runCloneFamilySweepAction(ctx: SystemActionCtx, deps: {
  spawn?: typeof managedSpawn;
  inFlight?: (workspaceId: string) => Promise<{ taskId: string }[]>;
  logDir?: string;
  loadRegistry?: typeof loadHarnessRegistry;
} = {}): Promise<SystemActionResult> {
  const harness = typeof ctx.payloadTemplate?.harnessSlug === 'string' ? ctx.payloadTemplate.harnessSlug : ctx.installSlug;
  const configured = actionInputSchema.parse(ctx.payloadTemplate?.input);
  let input: z.infer<typeof cloneSweepInputSchema>;
  if ('harness' in configured) {
    if (configured.harness !== harness) throw new Error('Clone sweep schedule harness mismatch');
    const registry = await (deps.loadRegistry ?? loadHarnessRegistry)(ctx.workspaceId, { fresh: true });
    const project = registry.projects.find(project => project.slug === harness);
    if (!project?.path) throw new Error('Clone sweep schedule harness is not registered');
    input = cloneSweepInputSchema.parse({ root: project.path });
  } else {
    input = configured;
  }
  if (!isAbsolute(input.root)) throw new Error('Clone sweep root must be absolute');
  input.root = realpathSync(input.root);
  const runner = join(input.root, 'scripts/clone-family-sweep.mts');
  if (!existsSync(runner) || !existsSync(join(input.root, 'node_modules/tsx/dist/loader.mjs'))) {
    throw new Error('Clone sweep runner or maintained tsx loader unavailable');
  }
  return withConditionReplayLock(ctx.workspaceId, `${actor}:launch:${harness}:${input.root}`, async () => {
    const inFlight = await (deps.inFlight ?? (workspaceId => listTasks({ workspaceId, launchedBy: actor,
      states: ['pending', 'running'], limit: 1000 })))(ctx.workspaceId);
    if (inFlight.length) return { diagnostics: { status: 'skipped-overlap', taskIds: inFlight.map(t => t.taskId) } };
    const taskId = newTaskId(), fireId = ctx.workflowId ?? taskId;
    const logDir = deps.logDir ?? papercuspPath('logs', CLONE_FAMILY_SWEEP_ACTION);
    mkdirSync(logDir, { recursive: true });
    const configPath = join(logDir, `${taskId}.json`), logPath = join(logDir, `${taskId}.log`);
    writeFileSync(configPath, JSON.stringify({ input, workspaceId: ctx.workspaceId, harness, fireId }), { mode: 0o600, flag: 'wx' });
    const fd = openSync(logPath, 'wx', 0o600);
    try {
      const args = ['--max-old-space-size=3072', '--import', join(input.root, 'node_modules/tsx/dist/loader.mjs'), runner, configPath];
      const managed = await (deps.spawn ?? managedSpawn)(process.execPath, args,
        { class: 'build', title: 'Nightly clone-family sweep', argv: [process.execPath, ...args], cwd: input.root,
          launchedBy: actor, harnessSlug: harness, runtimeMaxSec: 900, memoryMaxBytes: 4 * 1024 ** 3,
          logPath, detail: { fireId, routineId: ctx.routineId ?? null, configPath } },
        { workspaceId: ctx.workspaceId, taskId, requireRegistration: true,
          spawnOptions: { cwd: input.root, detached: true, stdio: ['ignore', fd, fd],
            env: { ...process.env, PAPERCUSP_WORKSPACE_ID: ctx.workspaceId, PAPERCUSP_HARNESS_SLUG: harness, PAPERCUSP_SID: actor } } });
      return { diagnostics: { status: 'launched', taskId: managed.taskId, fireId, logPath, configPath,
        confined: managed.confined, scopeUnit: managed.scopeUnit } };
    } finally { closeSync(fd); }
  });
}

registerSystemAction(CLONE_FAMILY_SWEEP_ACTION, runCloneFamilySweepAction, { scheduling: 'on-demand', planSchedulable: true });
