/** Session permission is re-read, never trusted from a long-lived device JWT. */
import type { Principal } from '@papercusp/agent-mcp';
import { deviceAgentSessionsAllowed, setDeviceAgentSessionsEnabled } from '../device-store';

const streams = new Map<string, Set<() => void>>();
const keyFor = (deviceId: string, workspaceId: string) => JSON.stringify([workspaceId, deviceId]);

export async function requireDeviceAgentSessions(principal: Principal): Promise<Response | null> {
  if (principal.kind !== 'device') return Response.json({ error: 'device_required' }, { status: 403 });
  try {
    if (await deviceAgentSessionsAllowed(principal.slug, principal.workspaceId)) return null;
    return Response.json({ error: 'agent_sessions_not_granted' }, { status: 403 });
  } catch {
    return Response.json({ error: 'device_authority_unavailable' }, { status: 503 });
  }
}

export function subscribeDeviceSessionRevocation(deviceId: string, workspaceId: string, close: () => void): () => void {
  const key = keyFor(deviceId, workspaceId);
  const listeners = streams.get(key) ?? new Set<() => void>();
  listeners.add(close);
  streams.set(key, listeners);
  return () => {
    listeners.delete(close);
    if (listeners.size === 0) streams.delete(key);
  };
}

export async function changeDeviceSessionGrant(deviceId: string, workspaceId: string, enabled: boolean): Promise<boolean> {
  const changed = await setDeviceAgentSessionsEnabled(deviceId, workspaceId, enabled);
  if (changed && !enabled) {
    for (const close of [...(streams.get(keyFor(deviceId, workspaceId)) ?? [])]) close();
  }
  return changed;
}
