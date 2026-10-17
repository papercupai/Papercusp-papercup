/** Local event authoring extends the existing event-key registry and claim guard. */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { claimEventKey, getEventKey, type EventKeyRow } from '../event-key-registry-store';
import { checkAgainstJsonSchema, compileJsonSchema } from '../json-schema-validation';
import { keyMatchesPattern } from './await/pattern';
import type { InstalledUnitEvents } from './await/catalog';

export interface SaveEventTypeInput {
  workspaceId: string;
  ownerId: string;
  event: string;
  title?: string;
  description?: string;
  payloadSchema?: Record<string, unknown>;
  tags?: string[];
  eventStatus?: 'active' | 'retired';
}

export async function saveEventType(input: SaveEventTypeInput, sql = getOrgPg().sql): Promise<EventKeyRow> {
  const contributor = `local:${input.ownerId}`;
  const prior = await getEventKey(sql, input.workspaceId, input.event);
  if (prior && prior.contributor !== contributor) throw new Error(`event_type_owned: ${input.event} belongs to ${prior.contributor ?? 'another contributor'}`);
  const schema = input.payloadSchema ?? prior?.payloadSchema ?? null;
  if (schema) {
    if (JSON.stringify(schema).length > 16_384) throw new Error('event_schema_too_large: maximum 16384 bytes');
    const validator = compileJsonSchema(schema);
    if ('$async' in validator && validator.$async) throw new Error('event_schema_async: payload schemas must be synchronous');
  }
  const claimed = await claimEventKey(sql, {
    workspaceId: input.workspaceId, eventKey: input.event,
    title: input.title ?? prior?.title ?? input.event,
    description: input.description ?? prior?.description ?? `Locally authored event ${input.event}.`,
    keyPattern: prior?.keyPattern ?? (input.event.includes('*') ? input.event : null),
    contributor, createdBy: input.ownerId, status: input.eventStatus ?? prior?.status ?? 'active',
    tags: input.tags ?? prior?.tags ?? [], payloadSchema: schema,
  });
  if (!claimed.claimed) throw new Error(`event_type_owned: ${input.event} belongs to ${claimed.holder ?? 'another contributor'}`);
  return claimed.row;
}

interface PayloadContract { event_key: string; key_pattern: string | null; payload_schema: Record<string, unknown> }

/** All matching contracts apply; an exact key cannot evade a family contract. */
export async function validateSavedEventPayload(
  workspaceId: string, event: string, payload: unknown,
  sql: postgres.Sql = getOrgPg().sql,
): Promise<void> {
  const contracts = await sql<PayloadContract[]>`
    SELECT event_key, key_pattern, payload_schema FROM harness_shared.event_key_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active' AND payload_schema IS NOT NULL`;
  for (const contract of contracts) {
    const pattern = (contract.key_pattern ?? contract.event_key).replace(/<[^>]+>/g, '*');
    if (!keyMatchesPattern(pattern, event)) continue;
    const checked = checkAgainstJsonSchema(contract.payload_schema, payload);
    if (!checked.ok) throw new Error(`event_payload_invalid: ${contract.event_key}: ${checked.errors.join('; ')}`);
  }
}

/** Feed saved types into the existing catalog merge, with explicit local provenance. */
export async function readSavedEventCatalog(workspaceId: string, sql = getOrgPg().sql): Promise<InstalledUnitEvents[]> {
  const rows = await sql<{ event_key: string; key_pattern: string | null; title: string; description: string; contributor: string }[]>`
    SELECT event_key, key_pattern, title, description, contributor FROM harness_shared.event_key_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active' AND contributor LIKE 'local:%'
     ORDER BY event_key`;
  return rows.map((row) => ({ unit: row.contributor, events: [{
    family: `local:${row.event_key}`, keyTemplate: row.key_pattern ?? row.event_key,
    describe: row.description,
  }] }));
}
