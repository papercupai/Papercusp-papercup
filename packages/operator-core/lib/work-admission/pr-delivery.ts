/**
 * Fail-closed review-mode precondition for PR-required admission rules
 * (slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-013, D-015, D-016).
 *
 * A rule whose lifecycle says `delivery: 'pr'` promises that the fixes for the work it admits
 * reach the subject repository ONLY through the target pot's working copy and its standing PR
 * (pot-review-integration-mode-2026-10-05 D-006). That promise holds only while the target
 * harness's pot is in review mode, the harness is governed by that mode, and a fork is
 * configured; otherwise git-sync pushes the fix straight to the main repository (the #1748
 * drift, D-015) or pushes nowhere at all.
 *
 * {@link decidePrDelivery} is the one decision, used when a rule is SAVED and again before EVERY
 * admission (the moment work is dispatched into the harness), so a pot switched back to direct
 * mode after the rule was saved cannot receive PR-required work either. It reuses the push
 * resolver git-sync itself runs ({@link resolveIntegrationPushRemote},
 * {@link integrationModeGovernsHarness}), so "ready" here means exactly "git-sync would push this
 * harness's commits to a fork".
 */
import type { Sql } from 'postgres';
import {
  integrationModeGovernsHarness,
  resolveIntegrationPushRemote,
  type PotIntegrationModeRead,
} from '../harness/git-sync/pot-integration-mode';

/** The registry fields the decision reads (a subset of the harness registry entry). */
export interface PrDeliveryRegistryEntry {
  slug: string;
  hive_slug?: string | null;
  self_repo?: boolean | null;
  fork_remote?: string | null;
}

export const PR_DELIVERY_REFUSAL_CODES = [
  'pr_delivery_unknown_harness',
  'pr_delivery_requires_review_mode',
  'pr_delivery_mode_unreadable',
  'pr_delivery_fork_missing',
] as const;
export type PrDeliveryRefusalCode = (typeof PR_DELIVERY_REFUSAL_CODES)[number];

export type PrDeliveryVerdict =
  | { ok: true; potHomeSlug: string; forkRemote: string }
  | { ok: false; code: PrDeliveryRefusalCode; message: string };

const NEXT_ACTION =
  "Put the pot in working-copy (review) mode with a fork configured (pot settings: 'Where should the agents' work go?'), " +
  'or target a harness whose pot already is. Repositories with submodules cannot use review mode until WI-10006416 lands.';

function refuse(code: PrDeliveryRefusalCode, why: string): PrDeliveryVerdict {
  return { ok: false, code, message: `${why} ${NEXT_ACTION}` };
}

/** The pot home that holds a harness's hiveGit.integration setting (git-sync's own rule). */
export function prDeliveryPotHome(entry: PrDeliveryRegistryEntry): string | undefined {
  return entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
}

/**
 * PURE: may PR-required work be dispatched into `harness`? `read` is the target pot's
 * integration-mode read (undefined when the harness belongs to no pot).
 */
export function decidePrDelivery(input: {
  harness: string;
  projects: readonly PrDeliveryRegistryEntry[];
  read: PotIntegrationModeRead | undefined;
}): PrDeliveryVerdict {
  const entry = input.projects.find((p) => p.slug === input.harness);
  if (!entry) {
    return refuse('pr_delivery_unknown_harness', `PR delivery refused: harness '${input.harness}' is not in the harness registry.`);
  }
  const potHomeSlug = prDeliveryPotHome(entry);
  if (!potHomeSlug || !input.read) {
    return refuse(
      'pr_delivery_requires_review_mode',
      `PR delivery refused: harness '${input.harness}' belongs to no pot, so it has no working copy and git-sync pushes it directly.`,
    );
  }
  const { read } = input;
  if (read.source === 'error' || read.source === 'malformed') {
    return refuse(
      'pr_delivery_mode_unreadable',
      `PR delivery refused: the integration mode of pot '${potHomeSlug}' could not be read (${read.source}).`,
    );
  }
  if (read.mode !== 'review') {
    return refuse(
      'pr_delivery_requires_review_mode',
      `PR delivery refused: pot '${potHomeSlug}' is in ${read.source === 'set' ? "'direct'" : "the default 'direct'"} ` +
        `integration mode, so git-sync would push fixes made in '${input.harness}' straight to the main repository.`,
    );
  }
  if (!integrationModeGovernsHarness(entry, input.projects)) {
    return refuse(
      'pr_delivery_requires_review_mode',
      `PR delivery refused: harness '${input.harness}' is pot '${potHomeSlug}''s own metadata repository; its working copy lives on a member harness, so target that harness instead.`,
    );
  }
  const push = resolveIntegrationPushRemote({ read, forkRemote: entry.fork_remote ?? undefined });
  if (push.kind !== 'fork') {
    return refuse(
      'pr_delivery_fork_missing',
      `PR delivery refused: pot '${potHomeSlug}' is in review mode but harness '${input.harness}' has no fork configured, so its fixes could never reach a PR.`,
    );
  }
  return { ok: true, potHomeSlug, forkRemote: push.url };
}

export interface PrDeliveryDeps {
  loadProjects: (workspaceId: string) => Promise<readonly PrDeliveryRegistryEntry[]>;
  readMode: (workspaceId: string, potHomeSlug: string, sql?: Sql) => Promise<PotIntegrationModeRead>;
}

/** Production wiring: the workspace's harness registry and the pot_settings read git-sync uses. */
export const defaultPrDeliveryDeps: PrDeliveryDeps = {
  loadProjects: async (ws) => (await (await import('../harness-registry')).loadHarnessRegistry(ws)).projects,
  readMode: async (ws, pot, sql) => (await import('../harness/git-sync/pot-integration-mode')).readPotIntegrationMode(ws, pot, sql),
};

/** Reads the registry and the pot's mode, then decides. A failed registry read refuses. */
export async function checkPrDelivery(
  workspaceId: string,
  harness: string,
  opts: { sql?: Sql; deps?: PrDeliveryDeps } = {},
): Promise<PrDeliveryVerdict> {
  const deps = opts.deps ?? defaultPrDeliveryDeps;
  let projects: readonly PrDeliveryRegistryEntry[];
  try {
    projects = await deps.loadProjects(workspaceId);
  } catch (err) {
    return refuse(
      'pr_delivery_mode_unreadable',
      `PR delivery refused: the harness registry could not be read (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const entry = projects.find((p) => p.slug === harness);
  const potHomeSlug = entry ? prDeliveryPotHome(entry) : undefined;
  const read = potHomeSlug ? await deps.readMode(workspaceId, potHomeSlug, opts.sql) : undefined;
  return decidePrDelivery({ harness, projects, read });
}
