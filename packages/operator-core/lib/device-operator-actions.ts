/**
 * Operator pause/resume actions invoked from the mobile WS bridge.
 *
 * (This module previously also carried the operator-CARD verbs —
 * listPendingCards / dispatchCard / dismissCard / describeCard. Those were
 * retired with the scanner card stream: unify-agent-launches-as-blueprints
 * D-005 dissolved the bespoke scanner + card feed into the scheduled `scan`
 * launch blueprint whose findings land as work_items in the
 * self-improvement backlog.)
 */
import { notifySyncInvalidate } from './sync-sse';
import { readOperatorState, updateOperatorState } from './operator-state-pg';
import { recordStartupActivityHistory, savedBackgroundActivitySchema, savedStartupActivityStateSchema, startupPauseIsActive } from './startup-activity';
import { collectScheduleInventory, scheduleStartupFeature, startupActivityFeatureId, startupPolicySchema, type StartupActivityPolicy } from './schedule-inventory';
import { getSystemActionEntry, SYSTEM_TARGET_PREFIX } from './harness/routines/system-actions';
import { activeWorkspaceId } from './workspace-registry';
import type { SessionUser } from './auth';
import { z } from 'zod';

// ── Pause / resume sentinel (PG-backed, migration 029) ─────────────────
//
// Was previously `<ws>/.papercusp/system/operator/paused.flag` — file
// existence = "paused". Now `harness_shared.operator_paused` row with
// JSONB payload `{ paused, by?, at? }`. We keep `paused: false` rows
// rather than deleting on resume so the row holds the audit trail of
// the last-pause-by-whom (read by getPauseInfo when paused, ignored
// otherwise). Same single-row-per-workspace pattern as the rest of
// operator-state-pg.

interface PauseState {
  paused: boolean;
  by?: string;
  at?: string;
  backgroundActivity?: z.infer<typeof savedBackgroundActivitySchema>;
  [key: string]: unknown;
}

/** All pause writers share the row lock with automatic-start preference writers. */
async function changePauseState(
  change: (current: PauseState, policy: NonNullable<PauseState['backgroundActivity']>) => PauseState,
  expectedRevision?: number,
  history?: { featureId: string; actorId: string; operation: 'policy-change' | 'pause' | 'resume'; defaults: StartupActivityPolicy },
  workspaceId?: string,
): Promise<PauseState> {
  const result = await updateOperatorState<PauseState>('operator_paused', { paused: false }, current => {
    savedStartupActivityStateSchema.parse(current);
    const policy = savedBackgroundActivitySchema.parse(current.backgroundActivity ?? {
      version: 1, revision: 0, automatic: true, pausedUntil: null, features: {},
    });
    if (expectedRevision !== undefined && expectedRevision !== policy.revision)
      throw Object.assign(new Error('Startup policy changed; refresh before retrying'), { code: 'startup_policy_conflict' });
    if (!Number.isSafeInteger(policy.revision + 1)) throw new Error('Startup policy revision unavailable');
    return change(current, { ...policy, revision: policy.revision + 1 });
  }, workspaceId, history ? async (tx, previous, next, workspace) => {
    const featurePolicy = (state: Readonly<PauseState>): StartupActivityPolicy => {
      const policy = state.backgroundActivity;
      return { ...history.defaults, ...policy?.features[history.featureId], revision: policy?.revision ?? 0 };
    };
    await recordStartupActivityHistory({
      featureId: history.featureId, operation: history.operation, status: 'completed',
      at: new Date().toISOString(), actor: 'system', trigger: 'settings', source: 'settings', reason: 'user-choice',
      previous: featurePolicy(previous), resulting: featurePolicy(next),
    }, history.actorId, 'user', { sql: tx, workspaceId: workspace });
  } : undefined);
  void notifySyncInvalidate('operatorPauseFlag').catch(() => {});
  return result;
}

export async function setPaused(by: string, until: string | null = null, expectedRevision?: number): Promise<void> {
  if (until !== null && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()))
    throw new Error('Pause must end at a future time');
  // Validate the same wire format used by persisted policy before entering the transaction.
  savedBackgroundActivitySchema.shape.pausedUntil.parse(until);
  await changePauseState((current, policy) => ({
    ...current, paused: true, by, at: new Date().toISOString(),
    backgroundActivity: { ...policy, pausedUntil: until },
  }), expectedRevision);
}

export async function setResumed(expectedRevision?: number): Promise<void> {
  await changePauseState((current, policy) => ({
    ...current, paused: false, backgroundActivity: { ...policy, pausedUntil: null },
  }), expectedRevision);
}

/** Internal workspace lifecycle seam; the exposing route must authorize its workspace principal. */
export async function setBackgroundActivityAutomatic(automatic: boolean, expectedRevision?: number): Promise<void> {
  if (typeof automatic !== 'boolean') throw new Error('Automatic activity preference must be boolean');
  await changePauseState((current, policy) => ({
    ...current, backgroundActivity: { ...policy, automatic },
  }), expectedRevision);
}

/** The settings caller chooses an opaque feature, never an execution/workspace identity. */
export const featureBackgroundActivityChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('automatic'), automatic: z.boolean() }).strict(),
  z.object({ action: z.literal('pause'), until: savedBackgroundActivitySchema.shape.pausedUntil }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
]);

export function assertBackgroundActivityAuthority(principal: SessionUser): string {
  const workspace = activeWorkspaceId();
  if (!workspace.trim() || workspace === '*' || principal.workspace_id !== workspace
    || !z.string().uuid().safeParse(principal.id).success
    || !principal.capabilities.some(capability => capability === '*' || capability === 'workspace:operate'))
    throw Object.assign(new Error('Startup policy authority unavailable'), { code: 'startup_policy_forbidden' });
  return workspace;
}

export async function setFeatureBackgroundActivityPolicy(
  featureId: string,
  change: z.infer<typeof featureBackgroundActivityChangeSchema>,
  expectedRevision: number,
  principal: SessionUser,
): Promise<StartupActivityPolicy> {
  const workspace = assertBackgroundActivityAuthority(principal);
  if (!/^activity-[a-f0-9]{64}$/.test(featureId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw Object.assign(new Error('Invalid startup policy request'), { code: 'startup_policy_invalid' });
  const action = featureBackgroundActivityChangeSchema.parse(change);
  if (action.action === 'pause' && action.until !== null && Date.parse(action.until) <= Date.now())
    throw Object.assign(new Error('Pause must end at a future time'), { code: 'startup_policy_invalid' });
  // Resolve the current registration under authenticated workspace scope. A saved
  // orphan, caller-supplied descriptor, or other device is not a control target.
  const rows = await collectScheduleInventory();
  const row = rows.find(candidate => startupActivityFeatureId(candidate, { workspaceId: workspace }) === featureId);
  const feature = row ? scheduleStartupFeature(row, { workspaceId: workspace }) : null;
  const role = row?.detail.targetRole;
  if (!feature || feature.scope.kind !== 'workspace' || feature.scope.id !== workspace
    || (typeof role === 'string' && role.startsWith(SYSTEM_TARGET_PREFIX)
      && getSystemActionEntry(role.slice(SYSTEM_TARGET_PREFIX.length))?.requiredForControl))
    throw Object.assign(new Error('Startup feature cannot be controlled here'), { code: 'startup_policy_forbidden' });
  const state = await changePauseState((current, policy) => {
    const previous = policy.features[featureId] ?? { ...feature.desired, paused: false };
    const override = action.action === 'automatic' ? { automatic: action.automatic }
      : action.action === 'pause' ? { paused: true, pausedUntil: action.until }
        : { paused: false, pausedUntil: null };
    return { ...current, backgroundActivity: { ...policy, features: {
      ...policy.features, [featureId]: { ...previous, ...override, revision: policy.revision },
    } } };
  }, expectedRevision, { featureId, actorId: principal.id, defaults: feature.desired,
    operation: action.action === 'automatic' ? 'policy-change' : action.action }, workspace);
  return startupPolicySchema.parse({ ...state.backgroundActivity!.features[featureId]!, revision: state.backgroundActivity!.revision });
}

export async function isPaused(): Promise<boolean> {
  const s = await readOperatorState<PauseState>('operator_paused');
  const parsed = savedStartupActivityStateSchema.parse(s ?? {});
  return startupPauseIsActive(parsed.paused, parsed.backgroundActivity?.pausedUntil ?? null);
}

export async function getPauseInfo(): Promise<{ paused: boolean; by?: string; at?: string; pausedUntil?: string | null; revision?: number }> {
  const s = await readOperatorState<PauseState>('operator_paused');
  const parsed = savedStartupActivityStateSchema.parse(s ?? {});
  const policy = parsed.backgroundActivity;
  const paused = startupPauseIsActive(parsed.paused, policy?.pausedUntil ?? null);
  return {
    paused, ...(paused ? { by: s?.by, at: s?.at } : {}),
    ...(policy ? { pausedUntil: paused ? policy.pausedUntil : null, revision: policy.revision } : {}),
  };
}

/** Fresh execution fence. A queued/replayed dispatch must not reuse a cached permission. */
export async function routineBackgroundActivityAllowed(routine: {
  workspaceId: string; installSlug: string; name: string; targetRole: string;
}): Promise<boolean> {
  if (!routine.workspaceId.trim() || routine.workspaceId === '*' || !routine.name.trim()) return false;
  // Queue priority, load-shed class and caller payload never grant this exemption.
  if (routine.targetRole.startsWith(SYSTEM_TARGET_PREFIX)
    && getSystemActionEntry(routine.targetRole.slice(SYSTEM_TARGET_PREFIX.length))?.requiredForControl) return true;
  const id = startupActivityFeatureId({
    source: 'routines', installSlug: routine.installSlug, name: routine.name, detail: {},
  }, { workspaceId: routine.workspaceId });
  return workspaceBackgroundActivityAllowed(routine.workspaceId, id);
}

/** Shared fresh policy fence for optional effects in one explicitly identified workspace. */
export async function workspaceBackgroundActivityAllowed(workspaceId: string, featureId?: string): Promise<boolean> {
  if (!workspaceId.trim() || workspaceId === '*'
    || (featureId !== undefined && !/^activity-[a-f0-9]{64}$/.test(featureId))) return false;
  try {
    const state = savedStartupActivityStateSchema.parse(
      await readOperatorState('operator_paused', workspaceId, { fresh: true }) ?? {},
    );
    const policy = state.backgroundActivity;
    const feature = featureId === undefined ? undefined : policy?.features[featureId];
    return policy?.automatic !== false && feature?.automatic !== false
      && !startupPauseIsActive(state.paused, policy?.pausedUntil ?? null)
      && !startupPauseIsActive(feature?.paused, feature?.pausedUntil ?? null);
  } catch {
    // Do not log policy values, driver errors, paths or credentials.
    console.warn('[background-activity] optional work withheld: policy unavailable');
    return false;
  }
}
