/**
 * Live-drill instrument for a Cupboard-installed chat provider package plus the
 * trigger pack that binds to its `chat-message` datatype (first used for plan
 * cupboard-distributable-integrations-2026-10-10, items P-006/P-007/P-008, D-010).
 *
 * One drill is one chat message posted in a channel the trigger pack's
 * installation watches. Given that message's identifiers, the provider kind the
 * source must carry, the package-connected source, the installed binding, the
 * removed in-app binding and a time window, this module reads the rows the
 * platform wrote and judges whether the message travelled the package path end
 * to end:
 *
 *   1. the source is the declared provider kind, connected through the installed
 *      package's provider setup;
 *   2. the message arrived as exactly one chat-message run on that source;
 *   3. the installed, armed binding ran exactly once and minted one plan run;
 *   4. that run filed one ticket in the installation's chosen destination;
 *   5. the removed in-app binding stayed disarmed and silent.
 *
 * Nothing here is specific to one provider: the provider is an input
 * (`sourceKind`), and the message is addressed by the provider's own message id.
 *
 * `assessTriggerPackDrill` is pure and recomputes every conclusion from the
 * rows; it never trusts an authored pass flag. `readTriggerPackDrillRows` takes
 * an injected query function, so the same judge runs against the live database
 * and against fixtures. This is the assessor of the records, not the program
 * that posted the message; it does not call the chat provider or the ticket
 * system directly.
 */
import { z } from 'zod';

export const drillIdsSchema = z.object({
  workspaceId: z.string().min(1),
  /** Provider kind the package-connected source must carry (`data_sources.kind`). */
  sourceKind: z.string().min(1),
  channelId: z.string().min(1),
  /** The provider's id for the drill message, as it appears in the run's dedupe key. */
  messageId: z.string().regex(/^[^\s:]+$/),
  sourceId: z.string().uuid(),
  installedBindingId: z.string().uuid(),
  inAppBindingId: z.string().uuid(),
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
});
export type DrillIds = z.infer<typeof drillIdsSchema>;

const sourceRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  credentialRef: z.string().nullable(),
  status: z.string(),
  lastError: z.string().nullable(),
});
const bindingRowSchema = z.object({
  id: z.string(),
  sourceId: z.string().nullable(),
  planSlug: z.string(),
  armed: z.boolean(),
  datatypeId: z.string().nullable(),
  packInstallationId: z.string().nullable(),
  action: z.unknown(),
});
const runRowSchema = z.object({
  id: z.string(),
  bindingId: z.string(),
  dedupeKey: z.string().nullable(),
  status: z.string(),
  triggeredAt: z.string(),
  outcome: z.unknown(),
});
export const drillRowsSchema = z.object({
  source: sourceRowSchema.nullable(),
  bindings: z.array(bindingRowSchema),
  runs: z.array(runRowSchema),
});
export type DrillRows = z.infer<typeof drillRowsSchema>;

export type DrillCheckId =
  | 'package-socket-path'
  | 'chat-message-recorded'
  | 'one-run-from-installed-binding'
  | 'one-ticket-in-chosen-project'
  | 'in-app-path-silent';

export interface DrillCheck {
  id: DrillCheckId;
  status: 'pass' | 'fail';
  detail: string;
}
export interface DrillAssessment {
  schemaVersion: 2;
  kind: 'trigger-pack-drill-assessment';
  sourceKind: string;
  status: 'pass' | 'fail';
  checks: DrillCheck[];
  ticket: { containerId: string; externalRef: string; url: string | null } | null;
  planRunId: number | null;
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Recompute the drill verdict from the captured rows. */
export function assessTriggerPackDrill(idsInput: unknown, rowsInput: unknown): DrillAssessment {
  const ids = drillIdsSchema.parse(idsInput);
  const rows = drillRowsSchema.parse(rowsInput);
  const checks: DrillCheck[] = [];
  const add = (id: DrillCheckId, ok: boolean, detail: string) => checks.push({ id, status: ok ? 'pass' : 'fail', detail });

  const src = rows.source;
  add(
    'package-socket-path',
    !!src && src.id === ids.sourceId && src.kind === ids.sourceKind && (src.credentialRef ?? '').startsWith('provider-setup:') &&
      src.status === 'connected' && src.lastError === null,
    src
      ? `source ${src.id}: kind ${src.kind} (expected ${ids.sourceKind}), credential_ref ${src.credentialRef ?? 'null'}, status ${src.status}, last_error ${src.lastError ?? 'null'}`
      : `source ${ids.sourceId} not found`,
  );

  const installed = rows.bindings.find((b) => b.id === ids.installedBindingId) ?? null;
  const inApp = rows.bindings.find((b) => b.id === ids.inAppBindingId) ?? null;
  const installedRuns = rows.runs.filter((r) => r.bindingId === ids.installedBindingId);
  const messageKey = `connector:${ids.sourceId}:chat-message:${ids.channelId}:${ids.messageId}:`;
  const messageRuns = installedRuns.filter((r) => (r.dedupeKey ?? '').startsWith(messageKey));
  add(
    'chat-message-recorded',
    messageRuns.length === 1,
    `${messageRuns.length} run(s) on the installed binding carry dedupe prefix ${messageKey}`,
  );

  const input = record(record(installed?.action).input);
  const channels = Array.isArray(input.channels) ? input.channels.filter((c): c is string => typeof c === 'string') : [];
  const destination = str(input.destination);
  const run = installedRuns.length === 1 ? installedRuns[0]! : null;
  const outcome = record(run?.outcome);
  const planRunId = typeof outcome.planRunId === 'number' ? outcome.planRunId : null;
  add(
    'one-run-from-installed-binding',
    !!installed && installed.armed && installed.packInstallationId !== null && installed.sourceId === ids.sourceId &&
      installed.datatypeId === 'chat-message' && channels.includes(ids.channelId) && !!run && run.status === 'succeeded' &&
      outcome.minted === 1 && outcome.replayed === false && planRunId !== null,
    installed
      ? `binding ${installed.id} (plan ${installed.planSlug}, installation ${installed.packInstallationId ?? 'none'}, armed ${installed.armed}, ` +
          `channels [${channels.join(',')}]): ${installedRuns.length} run(s) in window` +
          (run ? `; ${run.id} ${run.status}, minted ${String(outcome.minted)}, replayed ${String(outcome.replayed)}, planRunId ${planRunId ?? 'none'}` : '')
      : `binding ${ids.installedBindingId} not found`,
  );

  const filing = record(outcome.ticketFiling);
  const containerId = str(filing.containerId);
  const externalRef = str(filing.externalRef);
  const ticketOk = !!run && filing.state === 'created' && !!externalRef && !!destination && containerId === destination;
  add(
    'one-ticket-in-chosen-project',
    ticketOk,
    run
      ? `ticket ${String(filing.state ?? 'absent')} ${externalRef ?? 'no ref'} in container ${containerId ?? 'none'}; installation destination ${destination ?? 'none'}`
      : 'no single installed run to carry a ticket',
  );

  const inAppRuns = rows.runs.filter((r) => r.bindingId === ids.inAppBindingId);
  add(
    'in-app-path-silent',
    !!inApp && inApp.armed === false && inAppRuns.length === 0,
    inApp ? `in-app binding ${inApp.id} (plan ${inApp.planSlug}) armed ${inApp.armed}; ${inAppRuns.length} run(s) in window` : `in-app binding ${ids.inAppBindingId} not found`,
  );

  return {
    schemaVersion: 2,
    kind: 'trigger-pack-drill-assessment',
    sourceKind: ids.sourceKind,
    status: checks.every((c) => c.status === 'pass') ? 'pass' : 'fail',
    checks,
    ticket: ticketOk ? { containerId: containerId!, externalRef: externalRef!, url: str(filing.url) } : null,
    planRunId,
  };
}

export type DrillQuery = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Read the rows `assessTriggerPackDrill` judges, scoped to one workspace and window. */
export async function readTriggerPackDrillRows(query: DrillQuery, idsInput: unknown): Promise<DrillRows> {
  const ids = drillIdsSchema.parse(idsInput);
  const bindingIds = [ids.installedBindingId, ids.inAppBindingId];
  const [sources, bindings, runs] = await Promise.all([
    query(
      'SELECT id::text AS id, kind, credential_ref, status, last_error FROM harness_shared.data_sources WHERE workspace_id = $1 AND id = $2::uuid',
      [ids.workspaceId, ids.sourceId],
    ),
    query(
      'SELECT id::text AS id, source_id::text AS source_id, plan_slug, armed, datatype_id, pack_installation_id::text AS pack_installation_id, action ' +
        'FROM harness_shared.trigger_bindings WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [ids.workspaceId, bindingIds],
    ),
    query(
      'SELECT id::text AS id, binding_id::text AS binding_id, dedupe_key, status, triggered_at, outcome FROM harness_shared.trigger_runs ' +
        'WHERE workspace_id = $1 AND binding_id = ANY($2::uuid[]) AND triggered_at >= $3::timestamptz AND triggered_at < $4::timestamptz ORDER BY triggered_at',
      [ids.workspaceId, bindingIds, ids.windowStart, ids.windowEnd],
    ),
  ]);
  const s = sources[0];
  return drillRowsSchema.parse({
    source: s
      ? { id: String(s.id), kind: String(s.kind), credentialRef: (s.credential_ref as string | null) ?? null, status: String(s.status), lastError: (s.last_error as string | null) ?? null }
      : null,
    bindings: bindings.map((b) => ({
      id: String(b.id),
      sourceId: (b.source_id as string | null) ?? null,
      planSlug: String(b.plan_slug),
      armed: b.armed === true,
      datatypeId: (b.datatype_id as string | null) ?? null,
      packInstallationId: (b.pack_installation_id as string | null) ?? null,
      action: b.action ?? null,
    })),
    runs: runs.map((r) => ({
      id: String(r.id),
      bindingId: String(r.binding_id),
      dedupeKey: (r.dedupe_key as string | null) ?? null,
      status: String(r.status),
      triggeredAt: iso(r.triggered_at),
      outcome: r.outcome ?? null,
    })),
  });
}
