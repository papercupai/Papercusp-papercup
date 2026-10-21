/** Executable R-6/R-9 measurements; reuse the LLM ledger and its existing AJV oracle. */
import { getOrgPg } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import candidatePreregistration from './llm-testing/fixtures/tool-delivery-full-after-use-20261021.json';
import { buildOracleSchemaIndex, r6PrimaryVerdict, type OracleToolCall } from './llm-testing/r6-malformed-call-oracle';

export const TOOL_DELIVERY_PLAN = 'deterministic-tool-definition-delivery-2026-09-21';
export const TOOL_DELIVERY_INSTRUMENTS = ['llm-test-su-tool-definition-tier-ab', 'tool-delivery-invalid-arg-evidence-ladder'] as const;
/** D-054: fixed before the batch ran, so a failing scenario cannot disappear by selection. */
export const TOOL_DELIVERY_SCENARIOS = ['su-S01-harness-scope', 'su-S02-tauri-only', 'su-S06-shared-tree-git',
  'su-S23-delta-merge-base-present', 'su-S25-delta-wrong-merge-detector'] as const;
export const TOOL_DELIVERY_ARMS = { compactArm: 'session-tool-delivery-ab-compact-20261021',
  fullArm: 'session-tool-delivery-ab-full-20261021' };

type Definition = Record<string, unknown> & { name: string };
export interface ToolDeliveryManifestContract {
  provider: 'codex' | 'anthropic';
  systemSha256: string;
  sutModel: string;
  judgeModel: string;
  scenarioHashes: Readonly<Record<string, string>>;
  canonicalBySanitized: readonly (readonly [string, string])[];
  compactDefinitions: readonly Definition[];
  fullDefinitions: readonly Definition[];
}
export interface ToolDeliveryExperiment {
  id: string;
  arms: { compactArm: string; fullArm: string };
  scenarios: readonly string[];
  /** A frozen preregistration, not definitions reconstructed from today's registry. */
  manifestContract?: ToolDeliveryManifestContract;
}
export const HISTORICAL_TOOL_DELIVERY_EXPERIMENT: ToolDeliveryExperiment = {
  id: 'session-tool-delivery-ab-20261021', arms: TOOL_DELIVERY_ARMS, scenarios: TOOL_DELIVERY_SCENARIOS,
};
/** Add a distinct candidate only AFTER transport proof and plan preregistration. */
export const TOOL_DELIVERY_EXPERIMENTS: Readonly<Record<string, ToolDeliveryExperiment>> = {
  [HISTORICAL_TOOL_DELIVERY_EXPERIMENT.id]: HISTORICAL_TOOL_DELIVERY_EXPERIMENT,
  [candidatePreregistration.experiment.id]: candidatePreregistration.experiment as unknown as ToolDeliveryExperiment,
};

export function toolDeliveryExperiment(id = HISTORICAL_TOOL_DELIVERY_EXPERIMENT.id): ToolDeliveryExperiment {
  const experiment = TOOL_DELIVERY_EXPERIMENTS[id];
  if (!experiment) throw new Error(`Unregistered tool-delivery experiment: ${id}`);
  return experiment;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Replay exact persisted request definitions against the frozen treatment and observed calls. */
export function validateToolDeliveryManifests(row: ToolDeliveryRun, experiment: ToolDeliveryExperiment): {
  reason?: string; requests: number; initialBytes?: number; maxBytes?: number;
} {
  const contract = experiment.manifestContract;
  if (!contract) return { requests: 0 };
  const bad = (reason: string) => ({ reason: `${row.id}: ${reason}`, requests: 0 });
  if (row.sut_model !== contract.sutModel || row.judge_model !== contract.judgeModel ||
      row.scenario_hash !== contract.scenarioHashes[row.scenario_id]) return bad('preregistered model/scenario mismatch');
  if (!Array.isArray(row.raw_events)) return bad('missing persisted definition manifests');
  const used = new Set<string>();
  const calls: Array<{ name: unknown; input: unknown }> = [];
  const full = new Map(contract.fullDefinitions.map(tool => [tool.name, tool]));
  if (full.size !== contract.fullDefinitions.length || full.size !== contract.compactDefinitions.length ||
      new Set(contract.compactDefinitions.map(tool => tool.name)).size !== full.size ||
      contract.compactDefinitions.some(tool => !full.has(tool.name))) return bad('invalid frozen catalog population');
  const canonical = new Map(contract.canonicalBySanitized);
  let requests = 0, responseIndex = 0, completedTurns = 0, pendingCalls = false;
  const bytes: number[] = [];
  for (const raw of row.raw_events) {
    const event = object(raw), data = object(event.data);
    if (event.name === 'tool_definition_manifest') {
      if (data.schemaVersion !== 'su-tool-definitions-v1' || data.provider !== contract.provider ||
          data.systemSha256 !== contract.systemSha256 || data.responseIndex !== responseIndex++ ||
          data.fullDefinitionsAfterUse !== (row.variant === experiment.arms.compactArm) ||
          digest(data.canonicalBySanitized) !== digest(contract.canonicalBySanitized) ||
          digest(data.usedCanonicalNames) !== digest([...used].sort()) || !Array.isArray(data.definitions)) {
        return bad('request manifest identity, treatment, prompt or observed-use mismatch');
      }
      const expected = row.variant === experiment.arms.fullArm ? contract.fullDefinitions :
        contract.compactDefinitions.map(tool => used.has(canonical.get(tool.name) ?? tool.name) ? full.get(tool.name)! : tool);
      const serialized = JSON.stringify(data.definitions);
      if (data.sha256 !== digest(data.definitions) || data.bytes !== Buffer.byteLength(serialized) ||
          digest(data.definitions) !== digest(expected)) return bad('request definitions differ from the frozen delivery contract');
      bytes.push(Buffer.byteLength(serialized)); requests++; pendingCalls = false;
    } else if (event.name === 'tool_call') {
      if (!requests || typeof data.name !== 'string') return bad('tool call without a request manifest');
      calls.push({ name: data.name, input: data.input });
      used.add(data.name);
      if (data.name === 'tools:invoke') {
        const nested = object(data.input).name;
        if (typeof nested === 'string' && nested.trim() && nested.trim() !== 'tools:invoke') used.add(nested.trim());
      }
      pendingCalls = true;
    } else if (event.name === 'done') {
      if (!requests || pendingCalls) return bad('completed turn lacks its final request manifest');
      completedTurns++;
      responseIndex = 0;
    }
  }
  const normalized = Array.isArray(row.transcript_norm_json) ? row.transcript_norm_json.flatMap(turn => {
    const recorded = object(turn).toolCalls;
    return Array.isArray(recorded) ? recorded.map(call => ({ name: object(call).name, input: object(call).input })) : [];
  }) : [];
  if (!requests || pendingCalls || !Array.isArray(row.transcript_norm_json) ||
      completedTurns !== row.transcript_norm_json.length || digest(calls) !== digest(normalized)) {
    return bad('incomplete raw/normalized request and call coverage');
  }
  return { requests, initialBytes: bytes[0], maxBytes: Math.max(...bytes) };
}

export interface ToolDeliveryRun {
  id: string;
  scenario_id: string;
  scenario_hash: string;
  sut_model: string;
  judge_model: string;
  status: string;
  variant: string;
  transcript_norm_json: unknown;
  raw_events?: unknown;
  transcript_raw_zstd?: Buffer | null;
}
type Verdict = 'pass' | 'fail' | 'unknown';
export interface ToolDeliveryMeasurement {
  experimentId?: string;
  manifests?: Array<{ runId: string; requests: number; initialBytes?: number; maxBytes?: number }>;
  comprehension: { verdict: Verdict; reason: string };
  invalidArguments: { verdict: Verdict; reason: string };
  scenarios: Array<{ scenario: string; compact: number; full: number; compactPass: number; fullPass: number }>;
  powered: string[];
  compactAllPassed: string[];
  deficits: string[];
  runIds: string[];
  unmeasuredRunIds: string[];
  oracle?: ReturnType<typeof r6PrimaryVerdict>;
  limits: string[];
}

/** Unknown is deliberate: an empty, errored, asymmetric, or confounded sample cannot be green. */
export function evaluateToolDeliveryRuns(rows: readonly ToolDeliveryRun[], schemas: ReadonlyMap<string, Record<string, unknown>>,
  experiment: ToolDeliveryExperiment = HISTORICAL_TOOL_DELIVERY_EXPERIMENT): ToolDeliveryMeasurement {
  const measured = rows.filter(r => r.status === 'passed' || r.status === 'failed');
  const result: ToolDeliveryMeasurement = {
    experimentId: experiment.id,
    comprehension: { verdict: 'unknown', reason: 'Five complete paired scenarios are required.' },
    invalidArguments: { verdict: 'unknown', reason: 'A complete paired batch is required.' },
    scenarios: [], powered: [], compactAllPassed: [], deficits: [],
    runIds: measured.map(r => r.id), unmeasuredRunIds: rows.filter(r => !measured.includes(r)).map(r => r.id),
    limits: ['Persisted calls only: a pre-recording transport rejection is invisible.',
      'The malformed-call oracle cannot detect a call the agent omitted.',
      'AJV format keywords are not validated without ajv-formats.',
      ...(experiment.manifestContract ? [] : ['Historical rows lack enforced complete tool-definition manifests; arm fairness needs separate evidence.'])],
  };
  if (new Set(rows.map(r => r.id)).size !== rows.length) {
    result.comprehension.reason = 'Duplicate run identities; replication count is not trustworthy.';
    return result;
  }
  if (measured.length !== rows.length) {
    result.comprehension.reason = 'Unmeasured replications cannot be dropped from a preregistered batch.';
    return result;
  }
  if (rows.some(r => !Object.values(experiment.arms).includes(r.variant) || !experiment.scenarios.includes(r.scenario_id))) {
    result.comprehension.reason = 'Unexpected arm; do not pool experiments.';
    return result;
  }
  if (experiment.scenarios.length !== 5 || new Set(experiment.scenarios).size !== 5 ||
      experiment.arms.compactArm === experiment.arms.fullArm) return result;
  if (experiment.manifestContract) {
    result.manifests = [];
    for (const row of measured) {
      const validation = validateToolDeliveryManifests(row, experiment);
      if (validation.reason) {
        result.comprehension.reason = result.invalidArguments.reason = validation.reason;
        return result;
      }
      result.manifests.push({ runId: row.id, ...validation });
    }
  }
  for (const scenario of experiment.scenarios) {
    const block = measured.filter(r => r.scenario_id === scenario);
    const compact = block.filter(r => r.variant === experiment.arms.compactArm);
    const full = block.filter(r => r.variant === experiment.arms.fullArm);
    const compactPass = compact.filter(r => r.status === 'passed').length;
    const fullPass = full.filter(r => r.status === 'passed').length;
    result.scenarios.push({ scenario, compact: compact.length, full: full.length, compactPass, fullPass });
    if (compact.length !== 3 || full.length !== 3) return result;
    if (block.some(r => !r.scenario_hash || !r.sut_model || !r.judge_model) ||
        new Set(block.map(r => r.scenario_hash)).size !== 1 ||
        new Set(block.map(r => r.sut_model)).size !== 1 || new Set(block.map(r => r.judge_model)).size !== 1) {
      result.comprehension.reason = 'Model or scenario changed between arms.';
      return result;
    }
    if (fullPass === 3) result.powered.push(scenario);
    if (compactPass === 3) result.compactAllPassed.push(scenario);
    if (fullPass > 0 && compactPass < fullPass) result.deficits.push(scenario);
  }
  if (result.deficits.length) result.comprehension = { verdict: 'fail', reason: 'Compact passes are below full passes in a paired scenario; investigate every deficit.' };
  else if (result.powered.length === 0 || result.compactAllPassed.length === 0) {
    result.comprehension = { verdict: 'unknown', reason: 'No powered full control or no absolute compact pass; a shared failure is not non-inferiority.' };
  } else result.comprehension = { verdict: 'pass', reason: 'Five complete paired blocks; no compact deficit. Read powered and absolute-pass subsets beside this verdict.' };
  if (schemas.size === 0) {
    result.invalidArguments.reason = 'The schema corpus is empty; equal unknown-tool classes cannot establish a clean arm.';
    return result;
  }
  const calls: OracleToolCall[] = [];
  for (const row of measured) {
    if (!experiment.scenarios.includes(row.scenario_id)) continue;
    if (!Array.isArray(row.transcript_norm_json)) continue;
    for (const turn of row.transcript_norm_json) {
      if (!turn || !Array.isArray(turn.toolCalls)) continue;
      for (const call of turn.toolCalls) calls.push({ arm: row.variant, scenario: row.scenario_id,
        name: call.name, input: call.input });
    }
  }
  result.oracle = r6PrimaryVerdict(calls, schemas, experiment.arms);
  result.invalidArguments = { verdict: result.oracle.verdict === 'PASS' ? 'pass' : result.oracle.verdict === 'FAIL' ? 'fail' : 'unknown', reason: result.oracle.reason };
  return result;
}

export async function measureToolDeliveryAcceptance(window: { workspaceId: string; windowStart: string; windowEnd: string; experimentId?: string }): Promise<ToolDeliveryMeasurement> {
  if (window.workspaceId !== 'papercusp-workspace' || !Number.isFinite(Date.parse(window.windowStart)) ||
      !Number.isFinite(Date.parse(window.windowEnd)) || Date.parse(window.windowStart) >= Date.parse(window.windowEnd)) {
    throw new Error('The exact Papercusp experiment and a valid observation window are required.');
  }
  const { sql } = getOrgPg();
  const experiment = toolDeliveryExperiment(window.experimentId);
  // llm_test_runs is a transcript corpus, not a workspace-keyed tenant table.
  // Exact predeclared variant identities and scenario ids scope this experiment.
  const rows = await sql<ToolDeliveryRun[]>`
    SELECT id, scenario_id, scenario_hash, sut_model, judge_model, status,
           telemetry_json->>'variantId' AS variant, transcript_norm_json,
           CASE WHEN ${Boolean(experiment.manifestContract)} THEN transcript_raw_zstd ELSE NULL END AS transcript_raw_zstd
      FROM harness_shared.llm_test_runs
     WHERE started_at >= ${window.windowStart}::timestamptz
       AND finished_at <= ${window.windowEnd}::timestamptz
       AND telemetry_json->>'variantId' = ANY(${Object.values(experiment.arms)})
     ORDER BY started_at, id LIMIT 101`;
  if (rows.length > 100) throw new Error('Experiment exceeds bounded population; refusing a truncated verdict.');
  if (experiment.manifestContract) {
    for (const row of rows) {
      if (row.transcript_raw_zstd) {
        try { row.raw_events = JSON.parse(zstdDecompressSync(row.transcript_raw_zstd, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')); }
        catch { row.raw_events = null; }
      }
      delete row.transcript_raw_zstd;
    }
    const contract = experiment.manifestContract;
    const tools = contract.fullDefinitions.map(tool => ({ name: tool.name,
      input_schema: (tool.input_schema ?? tool.parameters) as Record<string, unknown> }));
    return evaluateToolDeliveryRuns(rows, buildOracleSchemaIndex(tools, new Map(contract.canonicalBySanitized)), experiment);
  }
  const { buildShippingSeedCatalog } = await import('./llm-testing/targets/su-compact-catalog');
  const { catalog } = await buildShippingSeedCatalog('full');
  return evaluateToolDeliveryRuns(rows, buildOracleSchemaIndex(catalog.tools, catalog.canonicalBySanitized), experiment);
}
