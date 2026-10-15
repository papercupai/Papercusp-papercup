/**
 * model-registry-snapshot.ts — the model-registry snapshot a benchmark run is pinned to
 * (WI-10008259; benchmark-coverage-frontierswe-v2-2026-10-10 P-010, requirement R-9).
 *
 * Benchmark code used to hard-code the model it evaluated (a June pin repeated across ~20 launchers, judges
 * and ingesters). R-9 replaces that with: evaluated model ids come from the model registry, and every run
 * records the registry snapshot it resolved them from, so a result can always be traced to the exact id it
 * ran even after the registry moves on.
 *
 * "The model registry" is not a new list. It is DERIVED from the surfaces that already decide what can be
 * selected and what it costs:
 *   - `CLOUD_MODEL_MENU` — the canonical selectable aliases and the CLI backend each launches on;
 *   - `resolveGatewayModel` — the Claude `[1m]` alias → upstream id map the inference gateway applies;
 *   - `normalizeCodexCliModel` — the Codex alias → native id map psu/codex apply;
 *   - `@papercusp/model-pricing` — whether the resolved id is priced (a run on an unpriced model cannot
 *     be costed, so it is refused here rather than discovered at scoring time).
 * Adding a model family to the menu, or moving an alias to a newer id, therefore moves the benchmark default
 * with it, and the snapshot id changes so old and new runs are never silently pooled.
 *
 * Pure apart from the clock: no disk, no network, no PG.
 */
import { createHash } from 'node:crypto';
import { MODEL_PRICES, normalizeModelId, priceFor, priceKeyFor, PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { CLOUD_MODEL_MENU } from '../agent-config-constants';
import { normalizeCodexCliModel } from '../model-context-budget.mjs';
import { resolveGatewayModel } from '../inference-gateway/model-aliases';

export const MODEL_REGISTRY_SNAPSHOT_SCHEMA = 'bench-model-registry-snapshot/v1' as const;

/**
 * The menu alias a benchmark arm evaluates when the caller names no model. An ALIAS, never a concrete id:
 * the id it resolves to is read from the registry at run time and pinned in the run's snapshot.
 */
export const BENCH_DEFAULT_MODEL_ALIAS = 'opus' as const;

/** How an alias was resolved to a concrete id. `claude-cli` = only the Claude CLI knows (no concrete id). */
export type RegistryResolution = 'gateway-1m' | 'codex-cli' | 'claude-cli';

export type RegistryBackend = 'claude' | 'codex';

/** One selectable alias and what it resolves to under this registry state. */
export interface RegistryModelEntry {
  alias: string;
  backend: RegistryBackend;
  /** Concrete upstream id the alias resolves to; null when only the Claude CLI can resolve it. */
  modelId: string | null;
  resolution: RegistryResolution;
  /** Whether `@papercusp/model-pricing` prices `modelId`. */
  priced: boolean;
}

/** The registry state one run is pinned to. `snapshotId` is a content id: equal state ⇒ equal id. */
export interface ModelRegistrySnapshot {
  schema: typeof MODEL_REGISTRY_SNAPSHOT_SCHEMA;
  /** sha256 (16 hex) over schema + priceTableVersion + entries. Excludes `capturedAt`. */
  snapshotId: string;
  capturedAt: string;
  /** `@papercusp/model-pricing` content version the `priced` flags were read under. */
  priceTableVersion: string;
  entries: RegistryModelEntry[];
  /**
   * Every concrete Claude/Codex id `@papercusp/model-pricing` priced at capture (sorted). A run may name one
   * of these directly; resolution reads this list, never the live table, so it is a function of the snapshot.
   */
  pricedModelIds: string[];
}

/** The model a run evaluates, resolved from (and traceable to) one registry snapshot. */
export interface EvaluatedModel {
  /** Bare concrete id (no vendor prefix, effort suffix or `[1m]` marker). */
  modelId: string;
  /** The menu alias it was selected by; null when the caller named a concrete id directly. */
  alias: string | null;
  backend: RegistryBackend;
  snapshotId: string;
}

function resolveEntry(alias: string, backend: RegistryBackend): RegistryModelEntry {
  if (backend === 'codex') {
    const modelId = normalizeModelId(normalizeCodexCliModel(alias));
    return { alias, backend, modelId, resolution: 'codex-cli', priced: priceFor(modelId) !== null };
  }
  const resolved = resolveGatewayModel(`${alias}[1m]`).model;
  if (/^claude-/i.test(resolved)) {
    const modelId = normalizeModelId(resolved);
    return { alias, backend, modelId, resolution: 'gateway-1m', priced: priceFor(modelId) !== null };
  }
  return { alias, backend, modelId: null, resolution: 'claude-cli', priced: false };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The content id of a registry state. Exported so a stored snapshot can be re-verified. */
export function modelRegistrySnapshotId(
  content: Pick<ModelRegistrySnapshot, 'priceTableVersion' | 'entries' | 'pricedModelIds'>,
): string {
  const { priceTableVersion, entries, pricedModelIds } = content;
  const text = canonicalJson({ schema: MODEL_REGISTRY_SNAPSHOT_SCHEMA, priceTableVersion, entries, pricedModelIds });
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Read the live registry into a snapshot. Deterministic in everything but `capturedAt`. */
export function captureModelRegistrySnapshot(opts: { now?: Date } = {}): ModelRegistrySnapshot {
  const entries = CLOUD_MODEL_MENU.map((row) => resolveEntry(row.value, row.backend));
  const pricedModelIds = Object.keys(MODEL_PRICES)
    .filter((id) => backendOfConcreteId(id) !== null)
    .sort();
  const content = { priceTableVersion: PRICE_TABLE_VERSION, entries, pricedModelIds };
  return {
    schema: MODEL_REGISTRY_SNAPSHOT_SCHEMA,
    snapshotId: modelRegistrySnapshotId(content),
    capturedAt: (opts.now ?? new Date()).toISOString(),
    ...content,
  };
}

function backendOfConcreteId(modelId: string): RegistryBackend | null {
  if (/^claude-/.test(modelId)) return 'claude';
  if (/^gpt-/.test(modelId)) return 'codex';
  return null;
}

/**
 * Resolve the model a run evaluates against a pinned snapshot. `selector` is a menu alias (`opus`,
 * `opus[1m]:xhigh`, `sol`) or a concrete priced id, bare or vendor-prefixed (`anthropic/<id>`). Throws rather
 * than guessing: an alias only the Claude CLI can resolve, an unpriced model, or an id the registry does not
 * know would each produce a result that cannot be traced or costed.
 */
export function resolveEvaluatedModel(selector: string, snapshot: ModelRegistrySnapshot): EvaluatedModel {
  const norm = normalizeModelId(selector);
  if (!norm) throw new Error('resolveEvaluatedModel: empty model selector');
  const byAlias = snapshot.entries.find((e) => e.alias === norm);
  if (byAlias) {
    if (byAlias.modelId === null) {
      throw new Error(
        `resolveEvaluatedModel: alias "${norm}" resolves only inside the Claude CLI, so a run on it cannot be pinned to a concrete id; name a concrete model id instead`,
      );
    }
    if (!byAlias.priced) {
      throw new Error(`resolveEvaluatedModel: alias "${norm}" resolves to unpriced model "${byAlias.modelId}"; register its price in @papercusp/model-pricing first`);
    }
    return { modelId: byAlias.modelId, alias: byAlias.alias, backend: byAlias.backend, snapshotId: snapshot.snapshotId };
  }
  const byId = snapshot.entries.find((e) => e.modelId === norm);
  if (byId) {
    if (!byId.priced) {
      throw new Error(`resolveEvaluatedModel: model "${norm}" is unpriced in registry snapshot ${snapshot.snapshotId}; register its price in @papercusp/model-pricing first`);
    }
    return { modelId: norm, alias: byId.alias, backend: byId.backend, snapshotId: snapshot.snapshotId };
  }
  const backend = backendOfConcreteId(norm);
  if (backend === null || priceKeyFor(norm, snapshot.pricedModelIds) === null) {
    throw new Error(
      `resolveEvaluatedModel: "${selector}" is neither a registry alias nor a priced model id in registry snapshot ${snapshot.snapshotId}`,
    );
  }
  return { modelId: norm, alias: null, backend, snapshotId: snapshot.snapshotId };
}

/** Capture a snapshot and resolve `selector` (default {@link BENCH_DEFAULT_MODEL_ALIAS}) against it. */
export function pinEvaluatedModel(
  selector?: string | null,
  opts: { snapshot?: ModelRegistrySnapshot; now?: Date } = {},
): { snapshot: ModelRegistrySnapshot; model: EvaluatedModel } {
  const snapshot = opts.snapshot ?? captureModelRegistrySnapshot({ now: opts.now });
  return { snapshot, model: resolveEvaluatedModel(selector?.trim() || BENCH_DEFAULT_MODEL_ALIAS, snapshot) };
}

/**
 * The concrete id the benchmark default alias resolves to under the CURRENT registry. For defaults only:
 * a run still records its own snapshot via {@link pinEvaluatedModel}.
 */
export function benchDefaultModelId(): string {
  return pinEvaluatedModel(BENCH_DEFAULT_MODEL_ALIAS).model.modelId;
}

/**
 * Validate a stored snapshot (e.g. read back from an arm file) and re-derive its content id. A snapshot
 * whose entries no longer hash to its `snapshotId` was edited after capture and is refused.
 */
export function assertModelRegistrySnapshot(value: unknown, where = 'snapshot'): ModelRegistrySnapshot {
  const s = value as Partial<ModelRegistrySnapshot> | null;
  if (!s || typeof s !== 'object' || s.schema !== MODEL_REGISTRY_SNAPSHOT_SCHEMA) {
    throw new Error(`${where}: missing or unrecognised model-registry snapshot (expected schema ${MODEL_REGISTRY_SNAPSHOT_SCHEMA})`);
  }
  if (
    typeof s.priceTableVersion !== 'string' ||
    !Array.isArray(s.entries) ||
    !Array.isArray(s.pricedModelIds) ||
    typeof s.snapshotId !== 'string'
  ) {
    throw new Error(`${where}: model-registry snapshot is missing priceTableVersion, entries, pricedModelIds or snapshotId`);
  }
  const expected = modelRegistrySnapshotId({ priceTableVersion: s.priceTableVersion, entries: s.entries, pricedModelIds: s.pricedModelIds });
  if (expected !== s.snapshotId) {
    throw new Error(`${where}: model-registry snapshot id ${s.snapshotId} does not match its content (${expected})`);
  }
  return s as ModelRegistrySnapshot;
}

/**
 * Refuse a recorded model that its own pinned snapshot does not resolve to: re-resolve the recorded alias
 * (or, without one, the recorded id) against `snapshot` and require the same concrete id and backend. This
 * is what makes a run record's model traceable to its pin, not merely labelled with the pin's id.
 */
export function assertModelInSnapshot(model: EvaluatedModel, snapshot: ModelRegistrySnapshot, where = 'model'): EvaluatedModel {
  let again: EvaluatedModel;
  try {
    again = resolveEvaluatedModel(model.alias ?? model.modelId, snapshot);
  } catch (err) {
    throw new Error(
      `${where}: evaluatedModel "${model.modelId}" is not in its pinned registry snapshot ${snapshot.snapshotId} (${(err as Error).message})`,
    );
  }
  if (again.modelId !== model.modelId || again.backend !== model.backend) {
    throw new Error(
      `${where}: evaluatedModel "${model.modelId}" (${model.backend}) is not what its pinned registry snapshot ${snapshot.snapshotId} resolves ${model.alias ?? model.modelId} to ("${again.modelId}", ${again.backend})`,
    );
  }
  return model;
}
