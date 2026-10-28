/**
 * Which adv_sessions rows psu can resume or fork, judged by their session-port
 * status. Pure and dependency-free so that both the SQL side
 * (adv-sessions.ts listResumableSessions) and the consult router
 * (consult/consult-dispatch.ts) import ONE rule (WI-6554700010030461).
 *
 * psu resolves every tracked resume/fork through GET /api/adv/sessions/resumable,
 * which is listResumableSessions. That list keeps a row only when
 * COALESCE(port_status, 'delivered') = 'delivered'. A row whose port is 'failed'
 * (or still in flight) is therefore refused at launch as "not a resumable
 * tracked row". The router must refuse the same rows before it launches.
 */

/** The only session-port status that a resume or fork may use. A row with no
 *  port (null) counts as delivered. */
export const RESUMABLE_PORT_STATUS = 'delivered';

/** True when psu can resume or fork a row with this port status. */
export function portStatusAllowsResume(portStatus: string | null | undefined): boolean {
  return (portStatus ?? RESUMABLE_PORT_STATUS) === RESUMABLE_PORT_STATUS;
}
