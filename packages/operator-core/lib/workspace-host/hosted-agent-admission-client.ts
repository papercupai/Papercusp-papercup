import { randomUUID } from 'node:crypto';

/** The guest uses its existing connector credential; no tenant identity comes
 * from a browser, agent argument, or mutable local entitlement copy. */
export interface HostedAgentReservation {
  start(): Promise<void>;
  finish(): Promise<void>;
}

export async function reserveHostedAgentSlot(processKey: string,
  env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<HostedAgentReservation | null> {
  const bearer = env.PAPERCUSP_HOSTED_CONNECTOR_BEARER?.trim();
  const base = env.PAPERCUSP_HOSTED_CONTROL_PLANE_URL?.trim();
  if (!bearer && !base) return null;
  if (!bearer || !base) throw new Error('hosted_pool_agent_connector_config_incomplete');
  let url: URL;
  try {
    url = new URL(base);
    if (url.username || url.password ||
        !['https:', 'wss:'].includes(url.protocol) &&
        !(['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'https:' : 'http:';
    url.pathname = '/api/hosted/connectors/agent-admission';
    url.search = ''; url.hash = '';
  } catch { throw new Error('hosted_pool_agent_connector_origin_invalid'); }
  const request = async (action: 'reserve' | 'start' | 'finish') => {
    let response: Response;
    try {
      response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, processKey }) });
    } catch { throw new Error('hosted_pool_agent_control_plane_unavailable'); }
    if (!response.ok) throw new Error('hosted_pool_agent_admission_refused');
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error('hosted_pool_agent_admission_invalid_response'); }
    const result = value as { ok?: unknown; receiptId?: unknown; state?: unknown } | null;
    if (!result || result.ok !== true || typeof result.receiptId !== 'string' ||
        !result.receiptId.startsWith('RG-') ||
        !(action === 'finish' ? result.state === 'cancelled' :
          action === 'start' ? result.state === 'running' :
            ['queued', 'eligible', 'leased', 'running'].includes(String(result.state)))) {
      throw new Error('hosted_pool_agent_admission_invalid_response');
    }
  };
  await request('reserve');
  return { start: () => request('start'), finish: () => request('finish') };
}

/** One slot belongs to the native host, including its carry/recycle children.
 * A fleet hands off its existing reservation through the admission envelope;
 * terminal-client exit is not evidence that the native process has stopped.
 * The launcher carries the key only in its own host-code adoption envelope.
 */
export async function launchWithHostedAgentSlot(env: NodeJS.ProcessEnv,
  launch: (finish: () => Promise<void>) => void,
  reserve: typeof reserveHostedAgentSlot = reserveHostedAgentSlot): Promise<void> {
  let processKey: string | undefined;
  for (const raw of [env.PAPERCUSP_HOSTED_NATIVE_SLOT, env.PAPERCUSP_ADMISSION_CONTEXT]) {
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      const key = value.processKey ?? value.metadata?.hostedAgentProcessKey;
      const owner = value.ownerId ?? value.metadata?.targetOwnerId;
      if (typeof key === 'string' && key && owner && owner === env.PAPERCUSP_SID) {
        processKey = key;
        break;
      }
    } catch { /* An unrelated inherited envelope cannot lend this launch a slot. */ }
  }
  processKey ??= `native:${randomUUID()}`;
  const reservation = await reserve(processKey, env);
  let finishing: Promise<void> | undefined;
  const finish = () => finishing ??= reservation?.finish() ?? Promise.resolve();
  try {
    await reservation?.start();
    if (reservation) env.PAPERCUSP_HOSTED_NATIVE_SLOT = JSON.stringify({ ownerId: env.PAPERCUSP_SID, processKey });
    launch(finish);
  } catch (error) {
    await finish();
    throw error;
  }
}
