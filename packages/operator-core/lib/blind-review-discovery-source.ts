import { createHash } from 'node:crypto';
import type { getOrgPg } from '@papercusp/db-org';
import type { ItemProvenanceDeclaration } from './activation-item-provenance';

export interface DiscoverySourcePin {
  ref: string;
  sha256: string;
}

/** Original append-only capture fields, never the mutable work-item or plan prose. */
export interface DiscoveryOccurrence {
  occurrence_id: string;
  canonical_work_item_id: string;
  reporter: string;
  source_tool: string;
  report_kind: string;
  reported_title: string;
  body: string;
  occurred_at: Date | string;
}

export interface BlindReviewDiscovery extends DiscoverySourcePin {
  workItemId: string;
  reporter: string;
  title: string;
  text: string;
  occurredAt: string;
}

export function discoverySourceHash(row: DiscoveryOccurrence): string {
  return createHash('sha256').update(JSON.stringify([
    'blind-discovery-source-v1', String(row.occurrence_id), row.canonical_work_item_id,
    row.reporter, row.source_tool, row.report_kind, row.reported_title, row.body,
    new Date(row.occurred_at).toISOString(),
  ])).digest('hex');
}

function invalid(ref: string): never {
  throw new Error(`blind_discovery_source_invalid: ${ref}; require a hash-pinned original improvements:capture occurrence predating the plan in this workspace and harness`);
}

/** Only explicit agent-added declarations admit discovery sources. No inference from plan text. */
export async function loadBlindReviewDiscoveries(input: {
  workspaceId: string;
  harnessSlug: string;
  planCreatedAt: Date | string | null;
  declarations: readonly ItemProvenanceDeclaration[];
}, sql: ReturnType<typeof getOrgPg>['sql']): Promise<BlindReviewDiscovery[]> {
  const pins = new Map<string, string>();
  for (const declaration of input.declarations) {
    if (declaration.kind !== 'agent-added') continue;
    for (const pin of declaration.discoverySources ?? []) {
      if (!/^issue-occurrence:[1-9]\d*$/.test(pin.ref) || !/^[a-f0-9]{64}$/.test(pin.sha256)) invalid(pin.ref);
      if (pins.has(pin.ref) && pins.get(pin.ref) !== pin.sha256) invalid(pin.ref);
      pins.set(pin.ref, pin.sha256);
    }
  }
  if (!pins.size) return [];
  const createdAt = input.planCreatedAt == null ? NaN : new Date(input.planCreatedAt).getTime();
  if (!Number.isFinite(createdAt) || pins.size > 20) invalid('plan creation time or source count');
  const sources: BlindReviewDiscovery[] = [];
  for (const [ref, sha256] of pins) {
    const [row] = await sql<DiscoveryOccurrence[]>`
      SELECT occurrence_id::text, canonical_work_item_id, reporter, source_tool, report_kind,
             reported_title, evidence->>'body' AS body, occurred_at
        FROM harness_shared.work_item_occurrences
       WHERE workspace_id = ${input.workspaceId}
         AND canonical_harness_slug = ${input.harnessSlug}
         AND occurrence_id = ${ref.slice('issue-occurrence:'.length)}::bigint`;
    if (!row || `issue-occurrence:${row.occurrence_id}` !== ref ||
        row.source_tool !== 'improvements:capture' || row.report_kind !== 'canonical-created' ||
        !row.reporter?.trim() || !row.reported_title?.trim() || !row.body?.trim() ||
        row.body.length + row.reported_title.length > 20_000 ||
        !Number.isFinite(new Date(row.occurred_at).getTime()) ||
        new Date(row.occurred_at).getTime() >= createdAt || discoverySourceHash(row) !== sha256) invalid(ref);
    sources.push({ ref, sha256, workItemId: row.canonical_work_item_id, reporter: row.reporter,
      title: row.reported_title, text: row.body, occurredAt: new Date(row.occurred_at).toISOString() });
  }
  return sources;
}
