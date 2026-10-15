/**
 * WI-10006652: turn each engine's OWN model catalog into the descriptor rows a
 * chat client's /model lists. Before this, pui's /model listed the workspace's
 * fleet routing tiers (`/api/agent-config` effectiveTiers): routing names,
 * owner-authored routing notes as descriptions, and on Codex not one row the
 * engine could actually switch to.
 *
 * Sources, measured 2026-10-06 against the installed engines:
 * - Claude: the Agent SDK's `initializationResult().models` (the list stock
 *   Claude Code's /model shows: Default, Opus, Fable, Sonnet, Haiku).
 * - Codex: `codex app-server` `model/list` (paginated; `hidden` rows are not
 *   offered by stock Codex either).
 * - OMP: RPC `get_available_models` (the native session's available registry).
 */
import type { SuSessionModelOption } from '@papercusp/chat-protocol';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(values: unknown): string[] {
  return Array.isArray(values) ? values.map(text).filter(Boolean) : [];
}

function option(row: Omit<SuSessionModelOption, 'efforts'> & { efforts: string[] }): SuSessionModelOption | null {
  if (!row.id || !row.label) return null;
  return {
    id: row.id,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    ...(row.resolvedModel && row.resolvedModel !== row.id ? { resolvedModel: row.resolvedModel } : {}),
    ...(row.efforts.length ? { efforts: row.efforts } : {}),
    ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
    ...(row.isDefault ? { isDefault: true } : {}),
  };
}

/** Claude SDK `ModelInfo[]` → rows. `value` is what `setModel` accepts. */
export function claudeModelOptions(models: unknown): SuSessionModelOption[] {
  if (!Array.isArray(models)) return [];
  const rows: SuSessionModelOption[] = [];
  for (const raw of models) {
    const model = record(raw);
    const id = text(model.value);
    const row = option({
      id,
      label: text(model.displayName) || id,
      description: text(model.description) || undefined,
      resolvedModel: text(model.resolvedModel) || undefined,
      efforts: textList(model.supportedEffortLevels),
      isDefault: id === 'default',
    });
    if (row && !rows.some((seen) => seen.id === row.id)) rows.push(row);
  }
  return rows;
}

/** Codex `model/list` `data` → rows, skipping models Codex marks hidden. */
export function codexModelOptions(data: unknown): SuSessionModelOption[] {
  if (!Array.isArray(data)) return [];
  const rows: SuSessionModelOption[] = [];
  for (const raw of data) {
    const model = record(raw);
    if (model.hidden === true) continue;
    // `model` is the slug turn/start accepts; `id` is the catalog key.
    const id = text(model.model) || text(model.id);
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((effort) => text(record(effort).reasoningEffort)).filter(Boolean)
      : [];
    const row = option({
      id,
      label: text(model.displayName) || id,
      description: text(model.description) || undefined,
      efforts,
      defaultEffort: text(model.defaultReasoningEffort) || undefined,
      isDefault: model.isDefault === true,
    });
    if (row && !rows.some((seen) => seen.id === row.id)) rows.push(row);
  }
  return rows;
}

/** OMP `get_available_models` rows use the provider/id accepted by set_model. */
export function ompModelOptions(models: unknown): SuSessionModelOption[] {
  if (!Array.isArray(models)) return [];
  const rows: SuSessionModelOption[] = [];
  for (const raw of models) {
    const model = record(raw);
    const provider = text(model.provider), modelId = text(model.id);
    if (!provider || !modelId) continue;
    const id = `${provider}/${modelId}`;
    const row = option({ id, label: text(model.name) || id, description: provider, efforts: [] });
    if (row && !rows.some((seen) => seen.id === row.id)) rows.push(row);
  }
  return rows;
}

/** Page through Codex `model/list`. Bounded so a cursor loop cannot spin. */
export async function listCodexModels(
  request: (frame: { method: string; params: Record<string, unknown> }) => Promise<Record<string, unknown>>,
  maxPages = 5,
): Promise<SuSessionModelOption[]> {
  const data: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = record(await request({ method: 'model/list', params: cursor ? { cursor } : {} }));
    if (Array.isArray(result.data)) data.push(...result.data);
    cursor = text(result.nextCursor) || null;
    if (!cursor) break;
  }
  return codexModelOptions(data);
}
