/**
 * Option sources for workflow settings (plan cupboard-distributable-integrations-2026-10-10 P-004,
 * decision D-005; SPEC-R-2-P-004).
 *
 * A trigger-pack `inputs` property can declare `x-options: { capability, args? }`. A settings form
 * asks this module for the choices: it invokes that capability on each of the signed-in owner's
 * connected sources whose provider declares it, through the one token path every source read uses
 * (createSourceHostFetch bound to exactly that source, via ticket-integrations' defaultHostFetchFor),
 * and keeps each answer to the documented option shape (normalizeProviderOptions, which also reads
 * the established `ticket.containers` result).
 *
 * Nothing here is provider-specific: which providers answer is read from the live registry, so an
 * installed Cupboard package that declares the capability serves the dropdown with no host change.
 * One source failing does not hide the others: its group carries the error and no options.
 */
import type postgres from 'postgres';
import {
  normalizeProviderOptions,
  providerOptionSourceIssues,
  PROVIDER_OPTIONS_KEY,
  type ProviderOption,
  type ProviderOptionSource,
} from '@papercusp/plugin-sdk/provider';
import type { RegisteredProvider } from './provider-registry';
import {
  defaultHostFetchFor,
  requestRegistry,
  TicketIntegrationError,
  type TicketIntegrationsDeps,
  type TicketIntegrationsScope,
} from './ticket-integrations';
import {
  listOwnedExternalTriggerSources,
  sourceTokenHarness,
  type OwnedExternalTriggerSourceRow,
} from '../external-triggers/source-store';

/** The choices one connected source offered. */
export interface ProviderOptionsGroup {
  sourceId: string;
  provider: string;
  providerName: string;
  /** The account the source is connected as, when the connect flow recorded one. */
  accountLabel: string | null;
  options: ProviderOption[];
  truncated: boolean;
  /** Set when this source could not be asked; `options` is then empty. */
  error: { code: string; message: string } | null;
}

export interface ProviderOptionsResult {
  capability: string;
  /** One group per connected source whose provider declares the capability, in provider-name order. */
  groups: ProviderOptionsGroup[];
}

export interface ProviderOptionsInput extends TicketIntegrationsScope, ProviderOptionSource {
  /** Ask only this source (it must be one of the owner's). */
  sourceId?: string;
}

export interface ProviderOptionsDeps extends Pick<TicketIntegrationsDeps, 'registry' | 'hostFetchFor'> {
  /** The owner's data sources. Production: listOwnedExternalTriggerSources. */
  listSources?: (sql: postgres.Sql, workspaceId: string, ownerUserId: string) => Promise<OwnedExternalTriggerSourceRow[]>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** A provider signal's kind (auth, rate-limited, transient) when it carries one, else a generic code. */
function errorOf(error: unknown): { code: string; message: string } {
  const kind = isPlainObject(error) && typeof error.kind === 'string' ? error.kind : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code: kind ? `provider_${kind}` : 'provider_options_failed', message };
}

/**
 * The choices for one option source, grouped by the owner's connected sources that can answer it.
 * A malformed source is refused (400); a named source that is not the owner's is 404; a named source
 * whose provider lacks the capability is 409. No connected provider declaring it is an empty list.
 */
export async function listProviderOptions(
  sql: postgres.Sql,
  input: ProviderOptionsInput,
  deps: ProviderOptionsDeps = {},
): Promise<ProviderOptionsResult> {
  const source: ProviderOptionSource = input.args === undefined
    ? { capability: input.capability }
    : { capability: input.capability, args: input.args };
  const issues = providerOptionSourceIssues(source, PROVIDER_OPTIONS_KEY);
  if (issues.length > 0) throw new TicketIntegrationError('invalid_option_source', issues.join('; '), 400);

  const registry = await requestRegistry(deps);
  const answering = new Map<string, RegisteredProvider>();
  // Arming and ticket:file require a writer for a create destination. Do not
  // offer a read-only provider's containers as choices that cannot be used.
  const createsTicket = source.capability === 'ticket.containers' && source.args?.purpose === 'create';
  for (const entry of registry.list()) {
    if (entry.descriptor.capabilities.includes(source.capability)
      && (!createsTicket || entry.descriptor.capabilities.includes('ticket.create'))) {
      answering.set(entry.descriptor.id, entry);
    }
  }

  const owned = await (deps.listSources ?? listOwnedExternalTriggerSources)(sql, input.workspaceId, input.ownerUserId);
  let asked = owned;
  if (input.sourceId !== undefined) {
    const named = owned.find((row) => row.id === input.sourceId);
    if (!named) throw new TicketIntegrationError('source_not_found', `no source '${input.sourceId}' of yours`, 404);
    if (!answering.has(named.kind)) {
      throw new TicketIntegrationError(
        'provider_capability_unsupported',
        `provider '${named.kind}' does not declare '${source.capability}'${createsTicket ? ' with ticket.create' : ''}`,
        409,
      );
    }
    asked = [named];
  }

  const groups = await Promise.all(
    asked
      .filter((row) => answering.has(row.kind))
      .map(async (row): Promise<ProviderOptionsGroup> => {
        const { descriptor, adapter } = answering.get(row.kind)!;
        const config = isPlainObject(row.config) ? row.config : {};
        const base = {
          sourceId: row.id,
          provider: descriptor.id,
          providerName: descriptor.displayName ?? descriptor.id,
          accountLabel: typeof config.accountLabel === 'string' && config.accountLabel.trim() ? config.accountLabel.trim() : null,
        };
        try {
          const fetch = (deps.hostFetchFor ?? defaultHostFetchFor)(sql, {
            workspaceId: input.workspaceId,
            providerId: descriptor.id,
            sourceId: row.id,
            harness: sourceTokenHarness(config),
          });
          const result = await adapter.invoke(
            { source: row.id, capability: source.capability, args: source.args ?? {}, config },
            { fetch },
          );
          return { ...base, ...normalizeProviderOptions(result), error: null };
        } catch (error) {
          return { ...base, options: [], truncated: false, error: errorOf(error) };
        }
      }),
  );
  groups.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.sourceId.localeCompare(b.sourceId));
  return { capability: source.capability, groups };
}
