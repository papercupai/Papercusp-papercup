/** Executable R-6/R-9 measurements; reuse the LLM ledger and its existing AJV oracle. */
import { getOrgPg } from '@papercusp/db-org';
import { buildOracleSchemaIndex, r6PrimaryVerdict, type OracleToolCall } from './llm-testing/r6-malformed-call-oracle';

export const TOOL_DELIVERY_PLAN = 'deterministic-tool-definition-delivery-2026-09-21';
export const TOOL_DELIVERY_INSTRUMENTS = ['llm-test-su-tool-definition-tier-ab', 'tool-delivery-invalid-arg-evidence-ladder'] as const;
/** D-054: fixed before the batch ran, so a failing scenario cannot disappear by selection. */
export const TOOL_DELIVERY_SCENARIOS = ['su-S01-harness-scope', 'su-S02-tauri-only', 'su-S06-shared-tree-git',
  'su-S23-delta-merge-base-present', 'su-S25-delta-wrong-merge-detector'] as const;
export const TOOL_DELIVERY_ARMS = { compactArm: 'session-tool-delivery-ab-compact-20261021',
  fullArm: 'session-tool-delivery-ab-full-20261021' };

export interface ToolDeliveryRun {
  id: string;
  scenario_id: string;
  scenario_hash: string;
  sut_model: string;
  judge_model: string;
  status: string;
  variant: string;
  transcript_norm_json: unknown;
}
type Verdict = 'pass' | 'fail' | 'unknown';
export interface ToolDeliveryMeasurement {
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
export function evaluateToolDeliveryRuns(rows: readonly ToolDeliveryRun[], schemas: ReadonlyMap<string, Record<string, unknown>>): ToolDeliveryMeasurement {
  const measured = rows.filter(r => r.status === 'passed' || r.status === 'failed');
  const result: ToolDeliveryMeasurement = {
    comprehension: { verdict: 'unknown', reason: 'Five complete paired scenarios are required.' },
    invalidArguments: { verdict: 'unknown', reason: 'A complete paired batch is required.' },
    scenarios: [], powered: [], compactAllPassed: [], deficits: [],
    runIds: measured.map(r => r.id), unmeasuredRunIds: rows.filter(r => !measured.includes(r)).map(r => r.id),
    limits: ['Persisted calls only: a pre-recording transport rejection is invisible.',
      'The malformed-call oracle cannot detect a call the agent omitted.',
      'AJV format keywords are not validated without ajv-formats.',
      'Rows pin scenario and model, but do not retain complete tool definitions; arm fairness needs separate evidence.'],
  };
  if (new Set(rows.map(r => r.id)).size !== rows.length) {
    result.comprehension.reason = 'Duplicate run identities; replication count is not trustworthy.';
    return result;
  }
  if (rows.some(r => !Object.values(TOOL_DELIVERY_ARMS).includes(r.variant))) {
    result.comprehension.reason = 'Unexpected arm; do not pool experiments.';
    return result;
  }
  for (const scenario of TOOL_DELIVERY_SCENARIOS) {
    const block = measured.filter(r => r.scenario_id === scenario);
    const compact = block.filter(r => r.variant === TOOL_DELIVERY_ARMS.compactArm);
    const full = block.filter(r => r.variant === TOOL_DELIVERY_ARMS.fullArm);
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
    if (!TOOL_DELIVERY_SCENARIOS.includes(row.scenario_id as typeof TOOL_DELIVERY_SCENARIOS[number])) continue;
    if (!Array.isArray(row.transcript_norm_json)) continue;
    for (const turn of row.transcript_norm_json) {
      if (!turn || !Array.isArray(turn.toolCalls)) continue;
      for (const call of turn.toolCalls) calls.push({ arm: row.variant, scenario: row.scenario_id,
        name: call.name, input: call.input });
    }
  }
  result.oracle = r6PrimaryVerdict(calls, schemas, TOOL_DELIVERY_ARMS);
  result.invalidArguments = { verdict: result.oracle.verdict === 'PASS' ? 'pass' : result.oracle.verdict === 'FAIL' ? 'fail' : 'unknown', reason: result.oracle.reason };
  return result;
}

export async function measureToolDeliveryAcceptance(window: { workspaceId: string; windowStart: string; windowEnd: string }): Promise<ToolDeliveryMeasurement> {
  if (window.workspaceId !== 'papercusp-workspace' || !Number.isFinite(Date.parse(window.windowStart)) ||
      !Number.isFinite(Date.parse(window.windowEnd)) || Date.parse(window.windowStart) >= Date.parse(window.windowEnd)) {
    throw new Error('The exact Papercusp experiment and a valid observation window are required.');
  }
  const { sql } = getOrgPg();
  // llm_test_runs is a transcript corpus, not a workspace-keyed tenant table.
  // Exact predeclared variant identities and scenario ids scope this experiment.
  const rows = await sql<ToolDeliveryRun[]>`
    SELECT id, scenario_id, scenario_hash, sut_model, judge_model, status,
           telemetry_json->>'variantId' AS variant, transcript_norm_json
      FROM harness_shared.llm_test_runs
     WHERE started_at >= ${window.windowStart}::timestamptz
       AND finished_at <= ${window.windowEnd}::timestamptz
       AND telemetry_json->>'variantId' = ANY(${Object.values(TOOL_DELIVERY_ARMS)})
       AND scenario_id = ANY(${[...TOOL_DELIVERY_SCENARIOS]})
     ORDER BY started_at, id LIMIT 101`;
  if (rows.length > 100) throw new Error('Experiment exceeds bounded population; refusing a truncated verdict.');
  const { buildShippingSeedCatalog } = await import('./llm-testing/targets/su-compact-catalog');
  const { catalog } = await buildShippingSeedCatalog('full');
  return evaluateToolDeliveryRuns(rows, buildOracleSchemaIndex(catalog.tools, catalog.canonicalBySanitized));
}
