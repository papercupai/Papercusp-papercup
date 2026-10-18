import { inboxWakeKey } from './inbox-wake';

/** Lifecycle listeners make a session reachable; they are not work dependencies. */
export function classifyAgentWait(ownerId: string, eventKey: unknown): 'listener' | 'substantive' | 'none' {
  if (typeof eventKey !== 'string' || eventKey.trim() === '') return 'none';
  return eventKey === inboxWakeKey(ownerId) ? 'listener' : 'substantive';
}
