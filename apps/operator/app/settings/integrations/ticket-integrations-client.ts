'use client';

/**
 * The client side of the ticket-integrations read and write paths (linear-asana-task-sync P-007,
 * D-014). Settings → Integrations and the /admin/admission "Ticket sources" table share this, so
 * both render the same overview from one read (D-014.7).
 *
 * Read: one GET of /api/user/integrations/tickets resolves the user every route acts for and
 * renders until the live `integrations.tickets` sync query answers; each write route fires
 * notifySyncInvalidate, so nothing polls. Writes go through `integrationRequest`.
 */

import { useEffect, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type {
  TicketIntegrationsOverview,
  TicketSourceConfigKey,
} from '@papercusp/operator-core/lib/integrations/ticket-integrations';

export const INTEGRATIONS_API = '/api/user/integrations/tickets';
export const INTEGRATIONS_QUERY = 'integrations.tickets';
export const INTEGRATIONS_SETTINGS_HREF = '/settings/integrations';

/** A refusal from the integrations routes, carrying the route's error code. */
export class IntegrationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationRequestError';
  }
}

/** Call an integrations route; a non-2xx or `ok:false` body throws its code and detail. */
export async function integrationRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return apiRequest<T>(INTEGRATIONS_API + path, method, body);
}

export const TRIGGER_PACKS_API = '/api/user/integrations/trigger-packs';

/** Re-configure an installed trigger pack with new input values (P-005). */
export function saveTriggerPackInputs(
  installationId: string,
  inputs: Record<string, unknown>,
): Promise<{ installationId: string; status: string; unmet: unknown[]; armed: boolean }> {
  return apiRequest(`${TRIGGER_PACKS_API}/${encodeURIComponent(installationId)}/inputs`, 'PUT', { inputs });
}

/**
 * Set up a pack the Cupboard installed without a project, in the project the owner picked
 * (cupboard-distributable-integrations-2026-10-10 D-017).
 */
export function setUpTriggerPackRequest(
  pluginName: string,
  harnessSlug: string,
  inputs: Record<string, unknown>,
): Promise<{ installationId: string; status: string; unmet: unknown[]; armed: boolean }> {
  return apiRequest(`${TRIGGER_PACKS_API}/set-up`, 'POST', { pluginName, harnessSlug, inputs });
}

/** Arm a trigger pack against the review fingerprint the owner is looking at. */
export function armTriggerPackRequest(installationId: string, fingerprint: string): Promise<{ armedBindingIds: string[] }> {
  return apiRequest(`${TRIGGER_PACKS_API}/${encodeURIComponent(installationId)}/arm`, 'POST', { fingerprint });
}

async function apiRequest<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; detail?: string }) | null;
  if (!res.ok || !json || json.ok === false) {
    throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

export interface TicketIntegrationsState {
  overview: TicketIntegrationsOverview | null;
  loadError: string | null;
  /**
   * Re-read the overview now. A page that just wrote calls this so it sees its own write without
   * waiting on the server's push: the sync bus drops a repeat of the same invalidation inside its
   * dedupe window, so a second save within it would otherwise never refresh the page.
   */
  refresh: () => void;
}

/** The signed-in user's ticket providers and sources, live. */
export function useTicketIntegrations(): TicketIntegrationsState {
  const [initial, setInitial] = useState<{ userId: string; overview: TicketIntegrationsOverview } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    integrationRequest<TicketIntegrationsOverview & { userId: string }>('')
      .then(({ userId, providers, sources, triggerPacks, availableTriggerPacks }) => {
        if (!cancelled) {
          setInitial({
            userId,
            overview: { providers, sources, triggerPacks: triggerPacks ?? [], availableTriggerPacks: availableTriggerPacks ?? [] },
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const userId = initial?.userId ?? '';
  const live = useSyncQuery<TicketIntegrationsOverview>({
    queryName: INTEGRATIONS_QUERY,
    args: { userId },
    enabled: Boolean(userId),
  });
  return { overview: live.data?.[0] ?? initial?.overview ?? null, loadError, refresh: live.invalidate };
}

/** How a missing config key reads in "Needs … before it can sync". */
const CONFIG_KEY_LABEL: Record<TicketSourceConfigKey, string> = {
  teamIds: 'teams',
  workspaceGid: 'a workspace',
  projectGids: 'projects',
  sectionCategories: 'a section mapping',
  harnessSlug: 'a harness to store tickets in',
};

export const missingLabels = (keys: string[]): string[] =>
  keys.map((key) => (CONFIG_KEY_LABEL as Record<string, string | undefined>)[key] ?? key);

export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
