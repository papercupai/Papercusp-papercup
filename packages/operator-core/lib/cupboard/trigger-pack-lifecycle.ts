/**
 * Trigger-pack lifecycle after materialization
 * (generalized-integrations-google-migration-cupboard-workflows-2026-10-05 P-013,
 * governed by plan Decision D-016; materialization itself is P-012 / D-013).
 *
 *   - review    a deterministic document of everything an installed pack can do
 *               once armed, plus its sha256 fingerprint
 *   - arm       one call naming the reviewed fingerprint: records the review on
 *               the installation, then arms every owned binding
 *   - update    every materialize recomputes the fingerprint; a change disarms
 *               every owned binding and clears the review
 *               (`reconcileTriggerPackReview`, called by the materializer)
 *   - uninstall detach owned bindings, archive owned plans, revoke this
 *               harness's grants, report dependents, delete the installation
 *   - export    write a portable package dir: the installed manifest plus each
 *               owned plan sanitized back into a template
 *
 * The no-bypass half of the review lives in `setExternalTriggerBindingArmed`,
 * the one chokepoint behind `triggers:arm` and the Workflows toggle: it refuses
 * to arm a pack-owned binding while the installation has no review.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type {
  MaterializeTriggerPackInput,
  TriggerPackInstallation,
  TriggerPackManifest,
} from './trigger-pack-materialize';
import type postgres from 'postgres';
import { providerOptionSourceOf } from '@papercusp/plugin-sdk/provider';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { TicketFilingError, ticketAssigneeOf } from '../capability-verbs/ticket';
import { detachExternalTriggerBinding } from '../external-triggers/admin';
import { loadHarnessRegistry } from '../harness-registry';
import { listProviderOptions, type ProviderOptionsDeps } from '../integrations/provider-options';
import { requestRegistry } from '../integrations/ticket-integrations';
import { detectPossibleSecrets } from '../memory/secret-detect';
import { sanitizePlanForTemplate } from './plan-template-serialize';
import type { TriggerPackResources, TriggerPackUnmet } from './trigger-pack-materialize';

type Db = postgres.Sql | postgres.TransactionSql;

/** One owned binding as the installer reviews it. Armed state is deliberately absent. */
export interface TriggerPackReviewBinding {
  packBindingId: string;
  triggerBindingId: string;
  kind: 'external' | 'edge' | 'unrecorded';
  source: { id: string; kind: string | null };
  eventPattern: string;
  datatype: string | null;
  filter: Record<string, unknown>;
  target: { harnessSlug: string | null; planSlug: string | null };
  planInput: Record<string, unknown>;
  /** The binding's stored storm policy: the run limits it fires under. */
  stormPolicy: Record<string, unknown>;
}

export interface TriggerPackReview {
  pluginName: string;
  pluginVersion: string;
  harnessSlug: string;
  status: string;
  capabilities: string[];
  oauth: Array<{ provider: string; scopes: string[] }>;
  bindings: TriggerPackReviewBinding[];
  entryPoints: TriggerPackResources['entryPoints'];
  plans: Array<{ targetId: string; planSlug: string; templateSha256: string | null }>;
  /** Input values the pack names as a recipient (key or schema format says email/recipient). */
  recipients: Array<{ input: string; value: unknown }>;
  unmet: TriggerPackUnmet[];
}

export interface TriggerPackReviewState {
  installationId: string;
  review: TriggerPackReview;
  /** sha256 of the canonical review JSON. */
  fingerprint: string;
  reviewedFingerprint: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** True when the installation is armed-eligible against exactly this review. */
  current: boolean;
  bindingCount: number;
  armedBindingCount: number;
}

export interface TriggerPackInstallationSummary {
  id: string;
  harnessSlug: string;
  pluginName: string;
  pluginVersion: string;
  status: string;
  reviewed: boolean;
  unmetCount: number;
  bindingCount: number;
  armedBindingCount: number;
  planSlugs: string[];
}

/** A refusal with a stable code. Nothing was written when one is thrown. */
export class TriggerPackLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TriggerPackLifecycleError';
  }
}

interface InstallationRow {
  id: string;
  harnessSlug: string;
  pluginName: string;
  pluginVersion: string;
  status: string;
  manifest: unknown;
  inputs: unknown;
  sourceMappings: unknown;
  resources: unknown;
  unmet: unknown;
  reviewedFingerprint: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
}

interface OwnedBindingRow {
  id: string;
  sourceId: string;
  sourceKind: string | null;
  sourceStatus: string | null;
  ownerUserId: string | null;
  armed: boolean;
  eventPattern: string;
  eventFilter: unknown;
  datatypeId: string | null;
  planHarnessSlug: string | null;
  planSlug: string | null;
  action: unknown;
  stormPolicy: unknown;
}

const RECIPIENT_KEY = /(e-?mail|recipient|address|^to$|^cc$|^bcc$)/i;
const RECIPIENT_FORMATS = new Set(['email', 'idn-email']);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function resourcesOf(value: unknown): TriggerPackResources {
  const raw = asRecord(value);
  return {
    plans: asRecord(raw.plans) as TriggerPackResources['plans'],
    bindings: asRecord(raw.bindings) as TriggerPackResources['bindings'],
    entryPoints: asArray(raw.entryPoints) as TriggerPackResources['entryPoints'],
    edgeSourceId: typeof raw.edgeSourceId === 'string' ? raw.edgeSourceId : null,
  };
}

async function loadInstallation(
  sql: Db,
  workspaceId: string,
  installationId: string,
  forUpdate = false,
): Promise<InstallationRow | null> {
  const lock = forUpdate ? sql`FOR UPDATE` : sql``;
  const rows = await sql<InstallationRow[]>`
    SELECT id::text AS id, harness_slug AS "harnessSlug", plugin_name AS "pluginName",
           plugin_version AS "pluginVersion", status, manifest, inputs,
           source_mappings AS "sourceMappings", resources, unmet,
           reviewed_fingerprint AS "reviewedFingerprint", reviewed_by AS "reviewedBy",
           reviewed_at AS "reviewedAt"
      FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId} AND id = ${installationId}::uuid
     ${lock}`;
  return rows[0] ?? null;
}

/** Resolve an installation id from either an id or a (harness, plugin) pair. */
export async function resolveTriggerPackInstallationId(
  sql: Db,
  workspaceId: string,
  ref: { installationId?: string; harnessSlug?: string; pluginName?: string },
): Promise<string | null> {
  if (ref.installationId) return ref.installationId;
  if (!ref.harnessSlug || !ref.pluginName) return null;
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${ref.harnessSlug} AND plugin_name = ${ref.pluginName}`;
  return rows[0]?.id ?? null;
}

async function loadOwnedBindings(sql: Db, workspaceId: string, installationId: string, lock = false): Promise<OwnedBindingRow[]> {
  return sql<OwnedBindingRow[]>`
    SELECT b.id::text AS id, b.source_id::text AS "sourceId", s.kind AS "sourceKind",
           s.status AS "sourceStatus", s.owner_user_id::text AS "ownerUserId", b.armed,
           b.event_pattern AS "eventPattern", b.event_filter AS "eventFilter", b.datatype_id AS "datatypeId",
           b.plan_harness_slug AS "planHarnessSlug", b.plan_slug AS "planSlug", b.action,
           b.storm_policy AS "stormPolicy"
      FROM harness_shared.trigger_bindings b
      LEFT JOIN harness_shared.data_sources s ON s.workspace_id = b.workspace_id AND s.id = b.source_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.pack_installation_id = ${installationId}::uuid
       AND b.detached_at IS NULL
     ORDER BY b.id
     ${lock ? sql`FOR UPDATE OF b` : sql``}`;
}

function recipientsOf(manifest: Record<string, unknown>, inputs: Record<string, unknown>): TriggerPackReview['recipients'] {
  const schema = asRecord(asRecord(asRecord(manifest.triggerPack).inputs).properties);
  const out: TriggerPackReview['recipients'] = [];
  for (const key of Object.keys(schema).sort()) {
    const format = asRecord(schema[key]).format;
    if (RECIPIENT_KEY.test(key) || (typeof format === 'string' && RECIPIENT_FORMATS.has(format))) {
      out.push({ input: key, value: inputs[key] ?? null });
    }
  }
  return out;
}

function buildReview(row: InstallationRow, owned: OwnedBindingRow[]): TriggerPackReview {
  const manifest = asRecord(row.manifest);
  const inputs = asRecord(row.inputs);
  const resources = resourcesOf(row.resources);
  const packIdOf = new Map<string, { packBindingId: string; kind: 'external' | 'edge' }>();
  for (const [packBindingId, recorded] of Object.entries(resources.bindings)) {
    packIdOf.set(recorded.triggerBindingId, { packBindingId, kind: recorded.kind });
  }
  const bindings = owned
    .map((binding): TriggerPackReviewBinding => {
      const recorded = packIdOf.get(binding.id);
      return {
        packBindingId: recorded?.packBindingId ?? '(unrecorded)',
        triggerBindingId: binding.id,
        kind: recorded?.kind ?? 'unrecorded',
        source: { id: binding.sourceId, kind: binding.sourceKind },
        eventPattern: binding.eventPattern,
        datatype: binding.datatypeId,
        filter: asRecord(binding.eventFilter),
        target: { harnessSlug: binding.planHarnessSlug, planSlug: binding.planSlug },
        planInput: asRecord(asRecord(binding.action).input),
        stormPolicy: asRecord(binding.stormPolicy),
      };
    })
    .sort((a, b) => a.packBindingId.localeCompare(b.packBindingId) || a.triggerBindingId.localeCompare(b.triggerBindingId));
  const oauth = asArray(manifest.oauth)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        provider: String(record.provider ?? ''),
        scopes: asArray(record.scopes).map(String).sort(),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return {
    pluginName: row.pluginName,
    pluginVersion: row.pluginVersion,
    harnessSlug: row.harnessSlug,
    status: row.status,
    capabilities: asArray(manifest.capabilities).map(String).sort(),
    oauth,
    bindings,
    entryPoints: [...resources.entryPoints].sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
    plans: Object.entries(resources.plans)
      .map(([targetId, plan]) => ({
        targetId,
        planSlug: plan.planSlug,
        templateSha256: plan.templateSha256 ?? null,
      }))
      .sort((a, b) => a.targetId.localeCompare(b.targetId)),
    recipients: recipientsOf(manifest, inputs),
    unmet: asArray(row.unmet) as TriggerPackUnmet[],
  };
}

function reviewState(row: InstallationRow, owned: OwnedBindingRow[]): TriggerPackReviewState {
  const review = buildReview(row, owned);
  const fingerprint = sha256(canonicalJson(review));
  return {
    installationId: row.id,
    review,
    fingerprint,
    reviewedFingerprint: row.reviewedFingerprint,
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    current: row.reviewedFingerprint !== null && row.reviewedFingerprint === fingerprint,
    bindingCount: owned.length,
    armedBindingCount: owned.filter((binding) => binding.armed).length,
  };
}

/** The current review of one installation, or null when it does not exist. */
export async function buildTriggerPackReview(
  sql: Db,
  workspaceId: string,
  installationId: string,
): Promise<TriggerPackReviewState | null> {
  const row = await loadInstallation(sql, workspaceId, installationId);
  if (!row) return null;
  return reviewState(row, await loadOwnedBindings(sql, workspaceId, installationId));
}

/**
 * Called by the materializer after every (re)materialize. When the review no
 * longer matches the one the installer armed against — or there never was one —
 * the review is cleared FIRST and every owned binding disarmed second, so a
 * concurrent single-binding arm either sees the cleared review (and is refused)
 * or lands before the disarm (and is undone by it).
 */
export async function reconcileTriggerPackReview(
  sql: Db,
  workspaceId: string,
  installationId: string,
): Promise<TriggerPackReviewState> {
  const state = await buildTriggerPackReview(sql, workspaceId, installationId);
  if (!state) throw new TriggerPackLifecycleError('not_found', `trigger-pack installation ${installationId} not found`);
  if (state.current) return state;
  if (state.reviewedFingerprint !== null) {
    await sql`
      UPDATE harness_shared.trigger_pack_installations
         SET reviewed_fingerprint = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${installationId}::uuid`;
  }
  const disarmed = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.trigger_bindings
       SET armed = FALSE, updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND pack_installation_id = ${installationId}::uuid
       AND detached_at IS NULL
       AND armed
     RETURNING id::text AS id`;
  return {
    ...state,
    reviewedFingerprint: null,
    reviewedBy: null,
    reviewedAt: null,
    current: false,
    armedBindingCount: Math.max(0, state.armedBindingCount - disarmed.length),
  };
}

export type ArmTriggerPackResult =
  | { ok: true; installationId: string; fingerprint: string; armedBindingIds: string[] }
  | {
      ok: false;
      error: 'not_found' | 'trigger_pack_needs_configuration' | 'trigger_pack_review_stale';
      installationId: string;
      review?: TriggerPackReviewState;
    };

function armInputSnapshot(row: InstallationRow, bindings: OwnedBindingRow[]): string {
  return canonicalJson({
    inputs: row.inputs,
    manifest: row.manifest,
    sources: bindings.map(({ id, sourceId, sourceKind, sourceStatus, ownerUserId }) =>
      ({ id, sourceId, sourceKind, sourceStatus, ownerUserId })),
  });
}

/** Use the same source owner and option list as execution, before any arm writes. */
async function validateArmInputs(
  sql: postgres.Sql,
  workspaceId: string,
  row: InstallationRow,
  bindings: OwnedBindingRow[],
  options: ProviderOptionsDeps,
): Promise<void> {
  if (bindings.some((binding) => !binding.sourceKind || binding.sourceStatus === 'disabled')) {
    throw new TriggerPackLifecycleError('trigger_pack_source_unavailable', 'an owned binding has a missing or disabled source');
  }
  // The same check ticket:file applies before recording an attempt, so a bad value never arms.
  try {
    ticketAssigneeOf(row.inputs);
  } catch (error) {
    if (error instanceof TicketFilingError) throw new TriggerPackLifecycleError('trigger_pack_input_unavailable', error.message);
    throw error;
  }
  const properties = asRecord(asRecord(asRecord(asRecord(row.manifest).triggerPack).inputs).properties);
  const inputs = asRecord(row.inputs);
  const owners = [...new Set(bindings.map((binding) => binding.ownerUserId).filter((id): id is string => Boolean(id)))];
  for (const [key, schema] of Object.entries(properties)) {
    const optionSource = providerOptionSourceOf(schema);
    const value = inputs[key];
    if (!optionSource || value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    if (!owners.length || values.some((picked) => typeof picked !== 'string')) {
      throw new TriggerPackLifecycleError('trigger_pack_input_unavailable', `cannot resolve the source owner or selected options for '${key}'`);
    }
    const registry = await requestRegistry(options);
    for (const ownerUserId of owners) {
      const listed = await listProviderOptions(sql, { workspaceId, ownerUserId, ...optionSource }, { ...options, registry });
      const createsTicket = optionSource.capability === 'ticket.containers' && optionSource.args?.purpose === 'create';
      for (const picked of values) {
        const matches = listed.groups.filter((group) => !group.error
          && group.options.some((option) => option.value === picked)
          && (!createsTicket || registry.get(group.provider)?.descriptor.capabilities.includes('ticket.create')));
        if (!matches.length || (createsTicket && matches.length !== 1)) {
          throw new TriggerPackLifecycleError('trigger_pack_input_unavailable', `selected option for '${key}' is unavailable or ambiguous`);
        }
      }
    }
  }
}

/**
 * Arm a pack as a unit against the review the installer saw. A stale
 * fingerprint is refused with the current review so the caller can re-review.
 */
export async function armTriggerPack(
  sql: postgres.Sql,
  workspaceId: string,
  input: { installationId: string; fingerprint: string; reviewedBy?: string | null },
  deps: { options?: ProviderOptionsDeps } = {},
): Promise<ArmTriggerPackResult> {
  const seen = await loadInstallation(sql, workspaceId, input.installationId);
  if (!seen) return { ok: false, error: 'not_found', installationId: input.installationId };
  const seenBindings = await loadOwnedBindings(sql, workspaceId, seen.id);
  const seenState = reviewState(seen, seenBindings);
  if (seen.status !== 'configured') {
    return { ok: false, error: 'trigger_pack_needs_configuration', installationId: seen.id, review: seenState };
  }
  if (seenState.fingerprint !== input.fingerprint) {
    return { ok: false, error: 'trigger_pack_review_stale', installationId: seen.id, review: seenState };
  }
  // Provider reads perform HTTP. Keep them outside the transaction and fence their inputs below.
  await validateArmInputs(sql, workspaceId, seen, seenBindings, deps.options ?? {});
  return sql.begin(async (tx) => {
    const row = await loadInstallation(tx, workspaceId, input.installationId, true);
    if (!row) return { ok: false as const, error: 'not_found' as const, installationId: input.installationId };
    await loadOwnedBindings(tx, workspaceId, row.id, true);
    // Freeze source ownership/status through the arm writes as well as the comparison.
    await tx`
      SELECT id FROM harness_shared.data_sources
       WHERE workspace_id = ${workspaceId}
         AND id IN (
           SELECT source_id FROM harness_shared.trigger_bindings
            WHERE workspace_id = ${workspaceId}
              AND pack_installation_id = ${row.id}::uuid AND detached_at IS NULL
         )
       ORDER BY id FOR SHARE`;
    const bindings = await loadOwnedBindings(tx, workspaceId, row.id);
    const state = reviewState(row, bindings);
    if (row.status !== 'configured') {
      return { ok: false as const, error: 'trigger_pack_needs_configuration' as const, installationId: row.id, review: state };
    }
    if (state.fingerprint !== input.fingerprint || armInputSnapshot(seen, seenBindings) !== armInputSnapshot(row, bindings)) {
      return { ok: false as const, error: 'trigger_pack_review_stale' as const, installationId: row.id, review: state };
    }
    // Setup and provider reads may precede a registry removal. Hold its row through
    // the arm writes and bypass the process cache when resolving every target.
    await tx`SELECT workspace_id FROM harness_shared.harness_registry
      WHERE workspace_id = ${workspaceId} FOR SHARE`;
    const registry = await loadHarnessRegistry(workspaceId, { fresh: true });
    const targets = new Set([row.harnessSlug, ...bindings.flatMap((binding) =>
      binding.planHarnessSlug === null ? [] : [binding.planHarnessSlug])]);
    for (const target of targets) {
      if (!registry.projects.some((project) => project.slug === target
        && typeof project.path === 'string' && project.path.trim().length > 0)) {
        throw new TriggerPackLifecycleError('trigger_pack_target_unavailable',
          `target pot '${target}' is unavailable`, { harnessSlug: target });
      }
    }
    await tx`
      UPDATE harness_shared.trigger_pack_installations
         SET reviewed_fingerprint = ${state.fingerprint},
             reviewed_by = ${input.reviewedBy?.trim() || null},
             reviewed_at = now(),
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    const armed = await tx<Array<{ id: string }>>`
      UPDATE harness_shared.trigger_bindings
         SET armed = TRUE, updated_at = now()
       WHERE workspace_id = ${workspaceId}
         AND pack_installation_id = ${row.id}::uuid
         AND detached_at IS NULL
       RETURNING id::text AS id`;
    return {
      ok: true as const,
      installationId: row.id,
      fingerprint: state.fingerprint,
      armedBindingIds: armed.map((binding) => binding.id).sort(),
    };
  });
}

export interface UninstallTriggerPackResult {
  installationId: string;
  pluginName: string;
  harnessSlug: string;
  detachedBindingIds: string[];
  archivedPlanSlugs: string[];
  revokedGrants: Array<{ pluginVersion: string; capability: string }>;
  /** Workflows the installation does not own that still target its plans. Left untouched. */
  dependents: {
    bindings: Array<{ id: string; planSlug: string; armed: boolean; packInstallationId: string | null }>;
    armedSchedules: Array<{ planSlug: string }>;
  };
  /** Installer-owned state uninstall never touches. */
  kept: { sourceIds: string[]; edgeSourceId: string | null };
}

/**
 * Uninstall a pack from one harness. Runs and work items are kept (the binding
 * FK is SET NULL); data sources, connector grants, the shared edge source and the
 * global plugin files are never touched. Each step is idempotent and the
 * installation row goes last, so a retry after a mid-way failure finishes the job.
 */
export async function uninstallTriggerPack(
  sql: postgres.Sql,
  workspaceId: string,
  installationId: string,
): Promise<UninstallTriggerPackResult | null> {
  const row = await loadInstallation(sql, workspaceId, installationId);
  if (!row) return null;
  const resources = resourcesOf(row.resources);
  const planSlugs = [...new Set(Object.values(resources.plans).map((plan) => plan.planSlug))].sort();

  const dependentBindings = await sql<
    Array<{ id: string; planSlug: string; armed: boolean; packInstallationId: string | null }>
  >`
    SELECT id::text AS id, plan_slug AS "planSlug", armed, pack_installation_id::text AS "packInstallationId"
      FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${workspaceId}
       AND detached_at IS NULL
       AND plan_harness_slug = ${row.harnessSlug}
       AND plan_slug = ANY(${planSlugs}::text[])
       AND pack_installation_id IS DISTINCT FROM ${row.id}::uuid
     ORDER BY id`;
  const armedSchedules = await sql<Array<{ planSlug: string }>>`
    SELECT plan_slug AS "planSlug" FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${row.harnessSlug}
       AND plan_slug = ANY(${planSlugs}::text[])
       AND schedule_active IS TRUE
     ORDER BY plan_slug`;

  const detachedBindingIds: string[] = [];
  for (const binding of await loadOwnedBindings(sql, workspaceId, row.id)) {
    if (await detachExternalTriggerBinding(sql, workspaceId, binding.id)) detachedBindingIds.push(binding.id);
  }

  const archived = await sql<Array<{ planSlug: string }>>`
    UPDATE harness_shared.harness_plans
       SET archived = TRUE, op_updated_at = ${new Date().toISOString()}
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${row.harnessSlug}
       AND plan_slug = ANY(${planSlugs}::text[])
       AND archived IS NOT TRUE
     RETURNING plan_slug AS "planSlug"`;

  // Grants are keyed by (plugin, version, harness), not workspace: the harness
  // slug is the installer-scoped key, and only this harness's rows are removed.
  const revokedGrants = await sql<Array<{ pluginVersion: string; capability: string }>>`
    DELETE FROM harness_shared.plugin_capability_grants
     WHERE plugin_name = ${row.pluginName}
       AND harness_slug = ${row.harnessSlug}
     RETURNING plugin_version AS "pluginVersion", capability`;

  await sql`
    DELETE FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;

  return {
    installationId: row.id,
    pluginName: row.pluginName,
    harnessSlug: row.harnessSlug,
    detachedBindingIds: detachedBindingIds.sort(),
    archivedPlanSlugs: archived.map((plan) => plan.planSlug).sort(),
    revokedGrants: revokedGrants.sort(
      (a, b) => a.pluginVersion.localeCompare(b.pluginVersion) || a.capability.localeCompare(b.capability),
    ),
    dependents: { bindings: dependentBindings, armedSchedules },
    kept: {
      sourceIds: [
        ...new Set(
          Object.values(resources.bindings)
            .filter((binding) => binding.kind === 'external')
            .map((binding) => binding.sourceId),
        ),
      ].sort(),
      edgeSourceId: resources.edgeSourceId,
    },
  };
}

export interface ExportTriggerPackResult {
  dir: string;
  /** Paths relative to `dir`, sorted. */
  files: string[];
  stripped: Record<string, { itemStatuses: number; notes: number; workItemRefs: number; nowBlock: boolean }>;
}

function insideDir(root: string, relPath: string, what: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new TriggerPackLifecycleError('trigger_pack_export_path_unsafe', `${what} escapes the export dir`);
  }
  return target;
}

/**
 * Export an installed pack as a portable package dir. The manifest is the
 * publisher's declaration; plans are their current content sanitized back into
 * templates. Source mappings, input values, resource ids and run history are never
 * written, and the output is checked for installer ids and secret-shaped strings
 * before a single byte lands.
 */
export async function exportTriggerPack(
  sql: Db,
  workspaceId: string,
  input: { installationId: string; outDir: string },
): Promise<ExportTriggerPackResult> {
  const row = await loadInstallation(sql, workspaceId, input.installationId);
  if (!row) throw new TriggerPackLifecycleError('not_found', `trigger-pack installation ${input.installationId} not found`);
  const manifest = asRecord(row.manifest);
  if (!manifest.name || !asRecord(manifest.triggerPack).targets) {
    throw new TriggerPackLifecycleError(
      'trigger_pack_manifest_missing',
      'the installation predates manifest capture; re-configure it once, then export',
    );
  }
  const resources = resourcesOf(row.resources);
  const targets = asArray(asRecord(manifest.triggerPack).targets).map(asRecord);

  const files = new Map<string, string>();
  files.set('papercusp.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const stripped: ExportTriggerPackResult['stripped'] = {};
  for (const [targetId, plan] of Object.entries(resources.plans).sort(([a], [b]) => a.localeCompare(b))) {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target || typeof target.path !== 'string') {
      throw new TriggerPackLifecycleError('trigger_pack_export_target_missing', `manifest has no path for plan target "${targetId}"`);
    }
    const [live] = await sql<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${row.harnessSlug} AND plan_slug = ${plan.planSlug}`;
    if (!live) {
      throw new TriggerPackLifecycleError('trigger_pack_export_plan_missing', `owned plan ${plan.planSlug} no longer exists`);
    }
    const sanitized = sanitizePlanForTemplate(live.content, { templateSlug: plan.planSlug });
    if ('error' in sanitized) {
      throw new TriggerPackLifecycleError('trigger_pack_export_plan_unexportable', `${plan.planSlug}: ${sanitized.error}`);
    }
    insideDir(input.outDir, target.path, `plan target "${targetId}" path`);
    files.set(target.path, sanitized.markdown);
    stripped[targetId] = {
      itemStatuses: sanitized.stripped.itemStatuses,
      notes: sanitized.stripped.notes,
      workItemRefs: sanitized.stripped.workItemRefs,
      nowBlock: sanitized.stripped.nowBlock,
    };
  }

  // Refuse before writing: no installer-local id, and nothing credential-shaped.
  const installerIds = [
    row.id,
    ...Object.values(resources.bindings).flatMap((binding) => [binding.triggerBindingId, binding.sourceId]),
    ...(resources.edgeSourceId ? [resources.edgeSourceId] : []),
  ];
  for (const [path, content] of files) {
    const leaked = installerIds.find((id) => id && content.includes(id));
    if (leaked) {
      throw new TriggerPackLifecycleError('trigger_pack_export_leak', `${path} carries installer-local id ${leaked}`);
    }
    const secrets = detectPossibleSecrets(content);
    if (secrets.matched) {
      throw new TriggerPackLifecycleError('trigger_pack_export_secret', `${path} contains credential-shaped text`, {
        path,
        classes: secrets.classes,
      });
    }
  }

  const existing = await fs.readdir(input.outDir).catch(() => [] as string[]);
  if (existing.length > 0) {
    throw new TriggerPackLifecycleError('trigger_pack_export_dir_not_empty', `${input.outDir} is not empty`);
  }
  for (const [path, content] of files) {
    const target = insideDir(input.outDir, path, path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { dir: resolve(input.outDir), files: [...files.keys()].sort(), stripped };
}

/** Every pack installation in the workspace (optionally one harness), with review and arm counts. */
export async function listTriggerPackInstallations(
  sql: Db,
  workspaceId: string,
  opts: { harnessSlug?: string } = {},
): Promise<TriggerPackInstallationSummary[]> {
  const harness = opts.harnessSlug?.trim() || null;
  const rows = await sql<
    Array<{
      id: string;
      harnessSlug: string;
      pluginName: string;
      pluginVersion: string;
      status: string;
      reviewed: boolean;
      unmet: unknown;
      resources: unknown;
      bindingCount: number;
      armedBindingCount: number;
    }>
  >`
    SELECT i.id::text AS id, i.harness_slug AS "harnessSlug", i.plugin_name AS "pluginName",
           i.plugin_version AS "pluginVersion", i.status, (i.reviewed_fingerprint IS NOT NULL) AS reviewed,
           i.unmet, i.resources,
           count(b.id)::int AS "bindingCount",
           count(b.id) FILTER (WHERE b.armed)::int AS "armedBindingCount"
      FROM harness_shared.trigger_pack_installations i
      LEFT JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = i.workspace_id AND b.pack_installation_id = i.id AND b.detached_at IS NULL
     WHERE i.workspace_id = ${workspaceId}
       AND (${harness}::text IS NULL OR i.harness_slug = ${harness})
     GROUP BY i.id
     ORDER BY i.harness_slug, i.plugin_name`;
  return rows.map((row) => ({
    id: row.id,
    harnessSlug: row.harnessSlug,
    pluginName: row.pluginName,
    pluginVersion: row.pluginVersion,
    status: row.status,
    reviewed: row.reviewed,
    unmetCount: asArray(row.unmet).length,
    bindingCount: row.bindingCount,
    armedBindingCount: row.armedBindingCount,
    planSlugs: [...new Set(Object.values(resourcesOf(row.resources).plans).map((plan) => plan.planSlug))].sort(),
  }));
}

// ── Settings → Integrations (plan cupboard-distributable-integrations-2026-10-10 P-005) ──────

/** One installed trigger pack as Settings → Integrations shows it: inputs form, review, arm. */
export interface TriggerPackSettings {
  installationId: string;
  harnessSlug: string;
  pluginName: string;
  pluginVersion: string;
  status: string;
  /** The pack's `triggerPack.inputs` JSON schema, or null when it takes no inputs. */
  inputsSchema: Record<string, unknown> | null;
  /** The input values the pack was last configured with. */
  inputs: Record<string, unknown>;
  /** The review the owner arms against: what the pack does, what it still lacks, its fingerprint. */
  state: TriggerPackReviewState;
}

function settingsOf(row: InstallationRow, owned: OwnedBindingRow[]): TriggerPackSettings {
  const schema = asRecord(asRecord(asRecord(row.manifest).triggerPack).inputs);
  return {
    installationId: row.id,
    harnessSlug: row.harnessSlug,
    pluginName: row.pluginName,
    pluginVersion: row.pluginVersion,
    status: row.status,
    inputsSchema: Object.keys(schema).length > 0 ? schema : null,
    inputs: asRecord(row.inputs),
    state: reviewState(row, owned),
  };
}

/** Every trigger pack installed in the workspace, with its inputs and current review. */
export async function listTriggerPackSettings(sql: Db, workspaceId: string): Promise<TriggerPackSettings[]> {
  const ids = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId}
     ORDER BY plugin_name, harness_slug`;
  const settings = await Promise.all(
    ids.map(async ({ id }) => {
      const row = await loadInstallation(sql, workspaceId, id);
      return row ? settingsOf(row, await loadOwnedBindings(sql, workspaceId, row.id)) : null;
    }),
  );
  return settings.filter((entry): entry is TriggerPackSettings => entry !== null);
}

export interface ConfigureTriggerPackDeps {
  /** Where installed plugins live. Production: GLOBAL_PLUGINS_DIR(). */
  pluginsDir?: string;
  /** Production: materializeTriggerPack. */
  materialize?: (sql: postgres.Sql, workspaceId: string, input: MaterializeTriggerPackInput) => Promise<TriggerPackInstallation>;
}

/**
 * Re-configure an installed pack with new input values. It runs the same materializer the Cupboard
 * install runs, fed from the stored manifest, source mappings and the installed plugin directory,
 * so an unchanged binding keeps its armed state and a changed one goes back to review disarmed.
 */
export async function configureTriggerPack(
  sql: postgres.Sql,
  workspaceId: string,
  input: { installationId: string; inputs: Record<string, unknown>; configuredBy?: string | null },
  deps: ConfigureTriggerPackDeps = {},
): Promise<TriggerPackInstallation> {
  const row = await loadInstallation(sql, workspaceId, input.installationId);
  if (!row) throw new TriggerPackLifecycleError('not_found', `trigger-pack installation ${input.installationId} not found`);
  const manifest = asRecord(row.manifest);
  if (typeof manifest.name !== 'string' || !manifest.name || Object.keys(asRecord(manifest.triggerPack)).length === 0) {
    throw new TriggerPackLifecycleError('manifest_missing', `installation ${row.id} has no stored trigger-pack manifest`);
  }
  const pluginsDir = resolve(deps.pluginsDir ?? (await import('../plugin-catalog')).GLOBAL_PLUGINS_DIR());
  const pluginDir = resolve(pluginsDir, manifest.name);
  if (!pluginDir.startsWith(`${pluginsDir}${sep}`)) {
    throw new TriggerPackLifecycleError('manifest_invalid', `plugin name "${manifest.name}" leaves the plugins directory`);
  }
  const sourceMappings = Object.fromEntries(
    Object.entries(asRecord(row.sourceMappings)).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
  const materialize = deps.materialize ?? (await import('./trigger-pack-materialize')).materializeTriggerPack;
  return materialize(sql, workspaceId, {
    manifest: manifest as unknown as TriggerPackManifest,
    pluginDir,
    harnessSlug: row.harnessSlug,
    sourceMappings,
    inputs: input.inputs,
    createdBy: input.configuredBy ?? null,
  });
}

// ── set up a pack the Cupboard installed without a project (plan cupboard-distributable-
//    integrations-2026-10-10 D-017) ─────────────────────────────────────────────────────────────
// The Cupboard install registers a package globally and names no project, so its trigger pack has
// no installation yet. Settings → Integrations lists such packs and sets one up in the project the
// owner picks, with the same materializer the install runs when it is given a harness.

/** An installed package whose trigger pack has not been set up in this workspace yet. */
export interface AvailableTriggerPack {
  pluginName: string;
  pluginVersion: string;
  description: string | null;
  /** The pack's `triggerPack.inputs` JSON schema, or null when it takes no inputs. */
  inputsSchema: Record<string, unknown> | null;
}

export interface SetUpTriggerPackDeps extends ConfigureTriggerPackDeps {
  /** Whether `slug` is a registered project. Production: the harness registry. */
  harnessExists?: (slug: string) => Promise<boolean>;
}

type InstalledPackage = Awaited<ReturnType<typeof import('../plugin-catalog').listPluginsIn>>[number];

/** Every package in the installed plugins directory that carries a non-empty trigger pack. */
async function installedTriggerPackPackages(deps: { pluginsDir?: string }): Promise<InstalledPackage[]> {
  const catalog = await import('../plugin-catalog');
  const pluginsDir = resolve(deps.pluginsDir ?? catalog.GLOBAL_PLUGINS_DIR());
  const installed = await catalog.listPluginsIn(pluginsDir, 'global');
  return installed.filter((entry) => Object.keys(asRecord(entry.triggerPack)).length > 0);
}

async function setUpHarnessOf(sql: Db, workspaceId: string, pluginName: string): Promise<string | null> {
  const [row] = await sql<Array<{ harnessSlug: string }>>`
    SELECT harness_slug AS "harnessSlug" FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId} AND plugin_name = ${pluginName}
     ORDER BY harness_slug LIMIT 1`;
  return row?.harnessSlug ?? null;
}

/** Installed packages with a trigger pack that has no installation in this workspace (D-017). */
export async function listAvailableTriggerPacks(
  sql: Db,
  workspaceId: string,
  deps: Pick<ConfigureTriggerPackDeps, 'pluginsDir'> = {},
): Promise<AvailableTriggerPack[]> {
  const [packages, rows] = await Promise.all([
    installedTriggerPackPackages(deps),
    sql<Array<{ pluginName: string }>>`
      SELECT DISTINCT plugin_name AS "pluginName" FROM harness_shared.trigger_pack_installations
       WHERE workspace_id = ${workspaceId}`,
  ]);
  const setUp = new Set(rows.map((row) => row.pluginName));
  return packages
    .filter((entry) => !setUp.has(entry.name))
    .map((entry) => {
      const schema = asRecord(asRecord(entry.triggerPack).inputs);
      return {
        pluginName: entry.name,
        pluginVersion: entry.version,
        description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : null,
        inputsSchema: Object.keys(schema).length > 0 ? schema : null,
      };
    })
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName));
}

/**
 * Set up an installed pack in the project the owner picked (D-017). The package is found by its
 * manifest name among installed packages, never by a caller-built path, and its manifest is read
 * from the installed directory. The result is the usual disarmed installation, reviewed and armed
 * from its section like any other. Refusals carry a stable code and write nothing.
 */
export async function setUpTriggerPack(
  sql: postgres.Sql,
  workspaceId: string,
  input: { pluginName: string; harnessSlug: string; inputs?: Record<string, unknown>; configuredBy?: string | null },
  deps: SetUpTriggerPackDeps = {},
): Promise<TriggerPackInstallation> {
  const pluginName = input.pluginName.trim();
  const harnessSlug = input.harnessSlug.trim();
  if (!pluginName) throw new TriggerPackLifecycleError('bad_request', 'pluginName is required');
  if (!harnessSlug) throw new TriggerPackLifecycleError('harness_required', 'choose the project the pack runs its plans in');
  const installed = (await installedTriggerPackPackages(deps)).find((entry) => entry.name === pluginName);
  if (!installed) {
    throw new TriggerPackLifecycleError('not_found', `no installed package "${pluginName}" carries a trigger pack`);
  }
  const harnessExists =
    deps.harnessExists ?? (async (slug: string) => (await (await import('../plugin-catalog')).resolveProjectPath(slug)) !== null);
  if (!(await harnessExists(harnessSlug))) {
    throw new TriggerPackLifecycleError('harness_not_found', `there is no project "${harnessSlug}"`, { harnessSlug });
  }
  const existing = await setUpHarnessOf(sql, workspaceId, pluginName);
  if (existing) {
    throw new TriggerPackLifecycleError('already_set_up', `${pluginName} is already set up in ${existing}`, { harnessSlug: existing });
  }
  const { path: pluginDir, source: _source, ...manifest } = installed;
  const materialize = deps.materialize ?? (await import('./trigger-pack-materialize')).materializeTriggerPack;
  return materialize(sql, workspaceId, {
    manifest: manifest as unknown as TriggerPackManifest,
    pluginDir,
    harnessSlug,
    inputs: input.inputs ?? {},
    createdBy: input.configuredBy ?? null,
  });
}
