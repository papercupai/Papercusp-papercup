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
import { recordStartupActivityHistory, savedBackgroundActivitySchema, savedStartupActivityPolicy, savedStartupActivityStateSchema, startupPauseIsActive,
  workspaceBackgroundActivityFeatureId, workspaceBackgroundActivityPolicy } from './startup-activity';
import { collectScheduleInventory, reactionStartupFeature, scheduleStartupFeature, startupActivityFeatureId, startupPolicySchema, type StartupActivityPolicy } from './schedule-inventory';
import { getSystemActionEntry, SYSTEM_TARGET_PREFIX } from './harness/routines/system-actions';
import { activeWorkspaceId } from './workspace-registry';
import type { SessionUser } from './auth';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { getManaged, stopManagedInvocation, type ManagedStopStatus } from '@papercusp/scheduled-registry';

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

interface PolicyHistory {
  featureId: string;
  actorId: string;
  actorKind: 'user' | 'system';
  operation: 'policy-change' | 'pause' | 'resume';
  project: (state: Readonly<PauseState>) => StartupActivityPolicy;
}

function workspacePolicyHistory(actorId: string, operation: PolicyHistory['operation'],
  actorKind: PolicyHistory['actorKind'] = 'system', workspace = activeWorkspaceId()): PolicyHistory {
  // Capture one time for both projections, including a pause expiring during the transaction.
  const now = Date.now();
  return { featureId: workspaceBackgroundActivityFeatureId(workspace), actorId, actorKind, operation,
    project: state => workspaceBackgroundActivityPolicy(state, now) };
}

/** All pause writers share the row lock with automatic-start preference writers. */
async function changePauseState(
  change: (current: PauseState, policy: NonNullable<PauseState['backgroundActivity']>) => PauseState,
  expectedRevision?: number,
  history?: PolicyHistory,
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
    await recordStartupActivityHistory({
      featureId: history.featureId, operation: history.operation, status: 'completed',
      at: new Date().toISOString(), actor: 'system', trigger: 'settings', source: 'settings', reason: 'user-choice',
      previous: history.project(previous), resulting: history.project(next),
    }, history.actorId, history.actorKind, { sql: tx, workspaceId: workspace });
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
  }), expectedRevision, workspacePolicyHistory(by, 'pause'));
}

export async function setResumed(expectedRevision?: number): Promise<void> {
  await changePauseState((current, policy) => ({
    ...current, paused: false, backgroundActivity: { ...policy, pausedUntil: null },
  }), expectedRevision, workspacePolicyHistory('operator-control', 'resume'));
}

/** Internal workspace lifecycle seam; the exposing route must authorize its workspace principal. */
export async function setBackgroundActivityAutomatic(automatic: boolean, expectedRevision?: number): Promise<void> {
  if (typeof automatic !== 'boolean') throw new Error('Automatic activity preference must be boolean');
  await changePauseState((current, policy) => ({
    ...current, backgroundActivity: { ...policy, automatic },
  }), expectedRevision, workspacePolicyHistory('operator-control', 'policy-change'));
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

/** The workspace comes from authenticated server context, never a request selector. */
export async function setWorkspaceBackgroundActivityPolicy(
  change: z.infer<typeof featureBackgroundActivityChangeSchema>,
  expectedRevision: number | undefined,
  principal: SessionUser,
): Promise<StartupActivityPolicy> {
  const workspace = assertBackgroundActivityAuthority(principal);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
    throw Object.assign(new Error('Invalid startup policy request'), { code: 'startup_policy_invalid' });
  const action = featureBackgroundActivityChangeSchema.parse(change);
  if (action.action === 'pause' && action.until !== null && Date.parse(action.until) <= Date.now())
    throw Object.assign(new Error('Pause must end at a future time'), { code: 'startup_policy_invalid' });
  const state = await changePauseState((current, policy) => action.action === 'automatic'
    ? { ...current, backgroundActivity: { ...policy, automatic: action.automatic } }
    : action.action === 'pause'
      ? { ...current, paused: true, by: principal.username, at: new Date().toISOString(),
        backgroundActivity: { ...policy, pausedUntil: action.until } }
      : { ...current, paused: false, backgroundActivity: { ...policy, pausedUntil: null } },
  expectedRevision, workspacePolicyHistory(principal.id,
    action.action === 'automatic' ? 'policy-change' : action.action, 'user', workspace), workspace);
  return workspaceBackgroundActivityPolicy(state);
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
  const { feature: controlledFeature } = await resolveBackgroundActivityFeature(featureId, workspace);
  const historyAt = Date.now();
  const state = await changePauseState((current, policy) => {
    const previous = policy.features[featureId] ?? { ...controlledFeature.desired, paused: false };
    const override = action.action === 'automatic' ? { automatic: action.automatic }
      : action.action === 'pause' ? { paused: true, pausedUntil: action.until }
        : { paused: false, pausedUntil: null };
    return { ...current, backgroundActivity: { ...policy, features: {
      ...policy.features, [featureId]: { ...previous, ...override, revision: policy.revision },
    } } };
  }, expectedRevision, { featureId, actorId: principal.id, actorKind: 'user',
    operation: action.action === 'automatic' ? 'policy-change' : action.action,
    project: state => ({ ...savedStartupActivityPolicy(controlledFeature, state, workspace, historyAt),
      revision: state.backgroundActivity?.revision ?? 0 }) }, workspace);
  return startupPolicySchema.parse(savedStartupActivityPolicy(controlledFeature, state, workspace));
}

/** Resolve both preference and one-time controls against the same current registration. */
async function resolveBackgroundActivityFeature(featureId: string, workspace: string) {
  const rows = await collectScheduleInventory();
  const matches = rows.filter(candidate => startupActivityFeatureId(candidate, { workspaceId: workspace }) === featureId);
  const row = matches.find(candidate => candidate.source === 'managed') ?? matches[0];
  let feature = row ? scheduleStartupFeature(row, { workspaceId: workspace }) : null;
  let requiredForControl = matches.some(candidate => {
    const role = candidate.detail.targetRole;
    return typeof role === 'string' && role.startsWith(SYSTEM_TARGET_PREFIX)
      && !!getSystemActionEntry(role.slice(SYSTEM_TARGET_PREFIX.length))?.requiredForControl;
  });
  if (!row) {
    const { listReactionRules } = await import('./events/registry');
    const rule = listReactionRules().find(candidate => reactionStartupFeature(candidate, workspace).id === featureId);
    if (rule) {
      const { builtinReactionControlPurpose } = await import('./events/builtin-actions');
      feature = reactionStartupFeature(rule, workspace);
      requiredForControl = !!builtinReactionControlPurpose(rule.fire);
    }
  }
  if (!feature || feature.scope.kind !== 'workspace' || feature.scope.id !== workspace
    || requiredForControl)
    throw Object.assign(new Error('Startup feature cannot be controlled here'), { code: 'startup_policy_forbidden' });
  return { feature, row };
}

/** Stop the current local invocation. This never writes the saved automatic-start policy. */
export async function stopFeatureBackgroundActivity(featureId: string, principal: SessionUser): Promise<{
  status: ManagedStopStatus; policy: StartupActivityPolicy; reason?: string;
}> {
  const workspace = assertBackgroundActivityAuthority(principal);
  if (!/^activity-[a-f0-9]{64}$/.test(featureId))
    throw Object.assign(new Error('Invalid startup policy request'), { code: 'startup_policy_invalid' });
  const { feature, row } = await resolveBackgroundActivityFeature(featureId, workspace);
  const policy = savedStartupActivityPolicy(feature,
    await readOperatorState('operator_paused', workspace, { fresh: true }) ?? {}, workspace);
  const live = row?.source === 'managed' ? getManaged(row.name) : undefined;
  if (!live || live.instanced || live.activity?.kind !== 'workspace'
    || live.activity.workspaceId !== workspace || live.activity.featureId !== featureId)
    return { status: 'unavailable', policy, reason: 'runtime-control-unavailable' };
  const audit = (status: 'pending' | 'draining' | 'completed' | 'failed') => recordStartupActivityHistory({
    featureId, operation: 'stop', status, at: new Date().toISOString(), actor: 'user',
    trigger: 'settings', source: 'settings', reason: 'user-choice', previous: policy, resulting: policy,
  }, principal.id, 'user', { sql: getOrgPg().sql, workspaceId: workspace });
  // Persist intent before touching the runtime. An audit outage cannot produce an unaudited stop.
  await audit('pending');
  const request = stopManagedInvocation(row!.name);
  if (request.status === 'unavailable') {
    await audit('failed');
    return { status: 'unavailable', policy, reason: 'runtime-control-unavailable' };
  }
  await audit(request.status);
  if (request.status === 'pending' || request.status === 'draining') {
    void request.settled.then(status => audit(status === 'completed' ? 'completed' : 'failed'))
      .catch(() => { console.warn('[background-activity] stop completion history unavailable'); });
  }
  return { status: request.status, policy };
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
