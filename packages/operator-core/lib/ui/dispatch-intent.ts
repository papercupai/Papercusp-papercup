/** Shared server-side use of the existing ui_intents request/result transport. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

export interface UiIntentOutcome {
  id: number;
  status: string;
  result: unknown;
  error: string | null;
}

export async function dispatchUiIntent(input: {
  clientId: string; intent: string; args: Record<string, unknown>;
  requestedBy: string; timeoutMs: number;
}): Promise<UiIntentOutcome> {
  const { sql } = getOrgPg();
  const argsJson = JSON.stringify(input.args);
  const inserted = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.ui_intents (client_id, intent, args, requested_by, workspace_id)
    VALUES (${input.clientId}, ${input.intent}, ${argsJson}::text::jsonb, ${input.requestedBy}, ${activeWorkspaceId()})
    RETURNING id
  `;
  const id = Number(inserted[0]!.id);
  await sql`SELECT pg_notify('ui_intents', ${input.clientId})`;
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<Array<{ status: string; result: unknown; error_message: string | null }>>`
      SELECT status, result, error_message FROM harness_shared.ui_intents WHERE id = ${id} LIMIT 1
    `;
    const row = rows[0];
    if (row && row.status !== 'pending') return { id, status: row.status, result: row.result ?? null, error: row.error_message ?? null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Prevent a late client from stealing focus after the request has expired.
  await sql`
    UPDATE harness_shared.ui_intents SET status = 'timeout', completed_at = now(), error_message = 'dispatch_timeout'
    WHERE id = ${id} AND status = 'pending'
  `;
  return { id, status: 'timeout', result: null, error: `dispatch_timeout: no response from client_id=${input.clientId} within ${input.timeoutMs}ms. The tab may be closed or unresponsive.` };
}

/** WSL has no access to Session-1 windows. Reuse the live native UI client. */
export async function dispatchNativeWindowIntent(args: Record<string, unknown>): Promise<unknown> {
  const { sql } = getOrgPg();
  const clients = await sql<Array<{ client_id: string }>>`
    SELECT client_id FROM harness_shared.ui_clients
    WHERE workspace_id = ${activeWorkspaceId()} AND viewport->>'nativeDesktop' = 'true'
      AND last_seen_at > now() - interval '45 seconds'
    ORDER BY last_seen_at DESC LIMIT 1
  `;
  if (!clients[0]) return null;
  const outcome = await dispatchUiIntent({ clientId: clients[0].client_id, intent: 'native_window', args: { ...args, expiresAt: Date.now() + 5_000 }, requestedBy: 'system:operator', timeoutMs: 5_000 });
  return outcome.status !== 'timeout' && outcome.status !== 'error' && !outcome.error ? outcome.result : null;
}
