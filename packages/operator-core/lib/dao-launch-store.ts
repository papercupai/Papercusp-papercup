/** Reuse setup_wizard_state's workspace-scoped PG JSONB + row-lock mutation. */
import { randomUUID } from 'node:crypto';
import { readOperatorState, updateOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';
import { notifySyncInvalidate } from './sync-sse';
import {
  createDaoLaunchSchema, updateDaoLaunchSchema, reviewDaoLaunchSchema,
  defaultDaoLaunchSections, projectDaoLaunch, type DaoLaunchRecord,
} from './dao-launch';

interface OnboardingState {
  dao_launches?: Record<string, DaoLaunchRecord>;
  [key: string]: unknown;
}
export class DaoLaunchError extends Error {
  constructor(public code: 'not-found' | 'revision-conflict' | 'not-ready' | 'limit-reached', message: string) { super(message); }
}

export async function listDaoLaunches(workspaceId = activeWorkspaceId()) {
  const state = await readOperatorState<OnboardingState>('setup_wizard_state', workspaceId, { fresh: true });
  return Object.values(state?.dao_launches ?? {}).map(projectDaoLaunch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function mutateLaunches(
  mutate: (records: Record<string, DaoLaunchRecord>) => DaoLaunchRecord,
  workspaceId: string,
) {
  let result: DaoLaunchRecord | undefined;
  await updateOperatorState<OnboardingState>('setup_wizard_state', {}, current => {
    const records = { ...(current.dao_launches ?? {}) };
    result = mutate(records);
    records[result.id] = result;
    return { ...current, dao_launches: records };
  }, workspaceId);
  if (!result) throw new Error('Launch mutation did not return a record');
  await notifySyncInvalidate('dao.launches');
  return projectDaoLaunch(result);
}

export async function createDaoLaunch(input: unknown, actor: { id: string; name: string }, workspaceId = activeWorkspaceId()) {
  const data = createDaoLaunchSchema.parse(input);
  return mutateLaunches(records => {
    if (Object.keys(records).length >= 100) throw new DaoLaunchError('limit-reached', 'This workspace already has 100 organization drafts');
    const now = new Date().toISOString();
    const sections = defaultDaoLaunchSections(actor.name || actor.id);
    sections.purpose = data.purpose;
    return { id: randomUUID(), name: data.name, creatorId: actor.id, revision: 1, createdAt: now, updatedAt: now, sections, reviewedRevision: null };
  }, workspaceId);
}

function currentRecord(records: Record<string, DaoLaunchRecord>, id: string, revision: number) {
  const record = records[id];
  if (!record) throw new DaoLaunchError('not-found', 'Organization draft not found in this workspace');
  if (record.revision !== revision) throw new DaoLaunchError('revision-conflict', 'Someone changed this draft. Reload the latest version before saving.');
  return record;
}

export async function updateDaoLaunch(id: string, input: unknown, workspaceId = activeWorkspaceId()) {
  const data = updateDaoLaunchSchema.parse(input);
  return mutateLaunches(records => {
    const current = currentRecord(records, id, data.expectedRevision);
    return { ...current, name: data.name, sections: data.sections, revision: current.revision + 1, updatedAt: new Date().toISOString(), reviewedRevision: null };
  }, workspaceId);
}

export async function reviewDaoLaunch(id: string, input: unknown, workspaceId = activeWorkspaceId()) {
  const data = reviewDaoLaunchSchema.parse(input);
  return mutateLaunches(records => {
    const current = currentRecord(records, id, data.expectedRevision);
    if (projectDaoLaunch(current).steps.slice(0, 4).some(step => step.state !== 'prepared')) {
      throw new DaoLaunchError('not-ready', 'Prepare the organization, governance, legal and banking sections first');
    }
    const revision = current.revision + 1;
    return { ...current, revision, updatedAt: new Date().toISOString(), reviewedRevision: revision };
  }, workspaceId);
}
