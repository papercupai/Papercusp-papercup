/** Owner-addressed agent messages use the existing APNs/FCM dispatcher. */
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { notifyWorkspace } from './device-push-dispatcher';
import { readSessionRosterSnapshot } from './owner-sessions/roster';
import { redactSensitiveText } from './sensitive-text';

export async function notifySessionOwnerMessage(envelope: CoordEnvelope, workspaceId: string): Promise<void> {
  if (envelope.kind !== 'message' || !envelope.to.includes('human') || envelope.auto
    || !workspaceId || workspaceId === '*' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(envelope.from)) return;
  const roster = await readSessionRosterSnapshot({ workspaceId });
  const sender = [...roster.active, ...roster.starting, ...roster.pending].find(row => row.ownerId === envelope.from);
  if (!sender || (sender.workspaceId !== workspaceId && sender.workspaceId !== '*')
    || /human|system|routine|git[-_]?sync|checkpoint/i.test(`${sender.role ?? ''} ${sender.ownerId}`)) return;
  // Only this public projection goes to a provider. Full envelopes, metadata,
  // tool arguments and transcript pages never enter the notification payload.
  const preview = redactSensitiveText(envelope.summary ?? envelope.body ?? 'A message needs your attention').slice(0, 200);
  await notifyWorkspace(workspaceId, { title: 'Agent message', body: preview,
    data: { kind: 'agent-session', owner: envelope.from } }, { requiredCapability: 'agent-sessions' });
}
