/** Executable R-6/R-9 measurements; reuse the LLM ledger and its existing AJV oracle. */
import { getOrgPg } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { getBuildInfo } from './build-info';
import { buildOracleSchemaIndex, r6PrimaryVerdict, type OracleToolCall } from './llm-testing/r6-malformed-call-oracle';
import { validateToolDeliveryCleanBlocks, validateToolDeliveryCleanCensus, validateToolDeliveryBlockLedgerIdentity,
  type ToolDeliveryCleanBlock, type ToolDeliveryCleanPin } from './tool-delivery-clean-runtime';

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
  executionContract?: {
    registeredAt: string;
    replicationsPerArm: number;
    neverRetryMeasuredReplication: boolean;
    armOrder: readonly { scenario: string; arms: readonly string[] }[];
  };
}
export const HISTORICAL_TOOL_DELIVERY_EXPERIMENT: ToolDeliveryExperiment = {
  id: 'session-tool-delivery-ab-20261021', arms: TOOL_DELIVERY_ARMS, scenarios: TOOL_DELIVERY_SCENARIOS,
};
interface Preregistration {
  experiment: ToolDeliveryExperiment & { manifestContract: ToolDeliveryManifestContract };
  createdAt: string;
  configuration: Omit<NonNullable<ToolDeliveryExperiment['executionContract']>, 'registeredAt'>;
  variants: Record<'compact' | 'full', { id: string; configDelta: Record<string, unknown>; systemPromptTextSha256: string }>;
  sourcePins: { head: string; files: Record<string, string>; scenarioPaths: Record<string, string>; submodules?: Record<string, string> };
  capture: { privateCapture: { originalSha256: string } };
  custodyPaths?: { privateCaptureFile: string; receiptDirectory: string; catalogSource: 'current-build' };
  executionPolicy?: { requireCleanRuntime?: boolean; launcherPath?: string; measurementController?: 'separate-root' };
  measurementAmendment?: {
    decisionRef: string; registeredAt: string;
    sourceReplacements: Record<string, { originalSha256: string; sha256: string }>;
    addedFiles: Record<string, string>;
    /** Prospective measurement-only gitlinks; never changes frozen treatment pins. */
    addedSubmodules?: Record<string, string>;
  };
}
/**
 * Preregistration fixtures, in registration order (the first is the default candidate custody).
 * Add a distinct candidate only AFTER transport proof and plan preregistration.
 *
 * They are READ FROM DISK on first use, never imported: a static JSON import is inlined by
 * esbuild into every host bundle that reaches this module (through scorecards.ts and
 * rubric-instrument-registry.ts), which put ~5 MB of fixtures in the resident host bundle and
 * pushed lint:host-bundle-builds over budget (WI-6554700010030028). The instrument already needs
 * a source checkout (it reads committed source via `git rev-parse --show-toplevel`).
 */
export const TOOL_DELIVERY_PREREGISTRATION_FIXTURES = [
  'tool-delivery-full-after-use-20261021.json',
  'tool-delivery-diagnostic-candidate-20261023.json',
  'tool-delivery-fidelity-candidate-20261023.json',
  'tool-delivery-clean-runtime-candidate-20261023.json',
  'tool-delivery-clean-source-v2-20261023.json',
  'tool-delivery-clean-source-v3-20261024.json',
] as const;

/** Where the fixtures live: beside this module in a source run, else in the source checkout a bundled host runs from. */
export function toolDeliveryPreregistrationFixtureDir(): string {
  const candidates: string[] = [];
  try { candidates.push(fileURLToPath(new URL('./llm-testing/fixtures/', import.meta.url))); } catch { /* not a file: URL */ }
  const relative = 'packages/operator-core/lib/llm-testing/fixtures';
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (root) candidates.push(resolve(root, relative));
  } catch { /* not inside a checkout */ }
  candidates.push(resolve(process.cwd(), relative));
  const found = candidates.find(dir => existsSync(resolve(dir, TOOL_DELIVERY_PREREGISTRATION_FIXTURES[0])));
  if (!found) throw new Error(`tool-delivery preregistration fixtures not found; looked in: ${candidates.join(', ')}`);
  return found;
}

interface LoadedPreregistrations {
  byId: Readonly<Record<string, Preregistration>>;
  candidateId: string;
  experiments: Readonly<Record<string, ToolDeliveryExperiment>>;
}
let loadedPreregistrations: LoadedPreregistrations | null = null;
function preregistrations(): LoadedPreregistrations {
  if (loadedPreregistrations) return loadedPreregistrations;
  const dir = toolDeliveryPreregistrationFixtureDir();
  const ordered = TOOL_DELIVERY_PREREGISTRATION_FIXTURES.map(file =>
    JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Preregistration);
  const byId = Object.fromEntries(ordered.map(registration => [registration.experiment.id, registration]));
  const experiments: Record<string, ToolDeliveryExperiment> = {
    [HISTORICAL_TOOL_DELIVERY_EXPERIMENT.id]: HISTORICAL_TOOL_DELIVERY_EXPERIMENT,
    ...Object.fromEntries(ordered.map(registration => [registration.experiment.id, {
      ...registration.experiment,
      executionContract: { registeredAt: registration.createdAt, ...registration.configuration },
    }])),
  };
  loadedPreregistrations = { byId, candidateId: ordered[0].experiment.id, experiments };
  return loadedPreregistrations;
}

export function toolDeliveryPreregistration(id: string): Preregistration {
  const registration = preregistrations().byId[id];
  if (!registration) throw new Error(`Unregistered tool-delivery custody: ${id}`);
  return registration;
}
/** The default candidate custody (the first preregistration). */
function candidatePreregistration(): Preregistration {
  return toolDeliveryPreregistration(preregistrations().candidateId);
}
/** Every registered experiment, keyed by id: the historical one plus one per preregistration. */
export function toolDeliveryExperiments(): Readonly<Record<string, ToolDeliveryExperiment>> {
  return preregistrations().experiments;
}

export function toolDeliveryExperiment(id = HISTORICAL_TOOL_DELIVERY_EXPERIMENT.id): ToolDeliveryExperiment {
  const experiment = id === HISTORICAL_TOOL_DELIVERY_EXPERIMENT.id
    ? HISTORICAL_TOOL_DELIVERY_EXPERIMENT : toolDeliveryExperiments()[id];
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
  const calls: Array<Array<{ name: unknown; input: unknown }>> = [];
  let turnCalls: Array<{ name: unknown; input: unknown }> = [];
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
      turnCalls.push({ name: data.name, input: data.input });
      used.add(data.name);
      if (data.name === 'tools:invoke') {
        const nested = object(data.input).name;
        if (typeof nested === 'string' && nested.trim() && nested.trim() !== 'tools:invoke') used.add(nested.trim());
      }
      pendingCalls = true;
    } else if (event.name === 'done') {
      if (!requests || pendingCalls) return bad('completed turn lacks its final request manifest');
      calls.push(turnCalls);
      turnCalls = [];
      completedTurns++;
      responseIndex = 0;
    }
  }
  const normalized = Array.isArray(row.transcript_norm_json) ? row.transcript_norm_json.map(turn => {
    const recorded = object(turn).toolCalls;
    return Array.isArray(recorded) ? recorded.map(call => ({ name: object(call).name, input: object(call).input })) : null;
  }) : [];
  if (!requests || !completedTurns || turnCalls.length || pendingCalls || !Array.isArray(row.transcript_norm_json) ||
      // JSONB changes object key order; turn/call/array order and argument values must still match.
      completedTurns !== row.transcript_norm_json.length || !isDeepStrictEqual(calls, normalized)) {
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
  started_at?: string | Date;
  finished_at?: string | Date | null;
  matrix_group_id?: string | null;
  matrix_index?: number | null;
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
  custody?: { verified: boolean; reason: string; privateOriginalSha256?: string; sourceFiles?: string[] };
}

/** Read ALL unique candidate variants, then verify order; a caller window cannot select replications. */
function validateExecutionOrder(rows: readonly ToolDeliveryRun[], experiment: ToolDeliveryExperiment): string | undefined {
  if (!experiment.manifestContract) return;
  const contract = experiment.executionContract;
  if (!contract || !Number.isFinite(Date.parse(contract.registeredAt)) || contract.replicationsPerArm !== 3 ||
      contract.neverRetryMeasuredReplication !== true || digest(contract.armOrder.map(block => block.scenario)) !== digest(experiment.scenarios) ||
      contract.armOrder.some(block => digest([...block.arms].sort()) !== digest(['compact', 'full']))) {
    return 'Missing or invalid preregistered execution order and registration anchor.';
  }
  const expected = contract.armOrder.flatMap(block => block.arms.flatMap(arm => [0, 1, 2].map(index =>
    ({ scenario: block.scenario, variant: arm === 'compact' ? experiment.arms.compactArm : experiment.arms.fullArm, index }))));
  if (rows.length !== expected.length) return 'The entire candidate population must contain exactly thirty unretried runs.';
  const time = (value: string | Date | null | undefined) => value == null ? NaN : new Date(value).getTime();
  if (rows.some(row => !Number.isFinite(time(row.started_at)) || !Number.isFinite(time(row.finished_at)))) {
    return 'Missing candidate chronology; unfinished attempts cannot disappear.';
  }
  const chronological = [...rows].sort((a, b) => time(a.started_at) - time(b.started_at));
  const groups = new Set<string>();
  let previousStart = -Infinity, previousEnd = Date.parse(contract.registeredAt), group: string | null | undefined;
  for (const [i, row] of chronological.entries()) {
    const slot = expected[i]!, start = time(row.started_at), end = time(row.finished_at);
    if (start <= previousStart || start < previousEnd || end < start || row.scenario_id !== slot.scenario ||
        row.variant !== slot.variant || row.matrix_index !== slot.index || !row.matrix_group_id) {
      return 'Candidate chronology, arm order or matrix replication index differs from preregistration.';
    }
    if (slot.index === 0) {
      group = row.matrix_group_id;
      if (groups.has(group)) return 'A matrix group was reused across candidate blocks.';
      groups.add(group);
    } else if (group !== row.matrix_group_id) return 'A candidate block contains a retried or replaced matrix group.';
    previousStart = start; previousEnd = end;
  }
}

/** Private capture remains immutable. Only separately preregistered measurement source can be repinned. */
export function verifyToolDeliverySourceCustody(input: {
  registration?: Preregistration;
  privateCapture: Buffer;
  readSource: (path: string, ref?: string) => Buffer;
  buildSha: string | null;
}): NonNullable<ToolDeliveryMeasurement['custody']> {
  const registration = input.registration ?? candidatePreregistration();
  const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const privateOriginalSha256 = sha(input.privateCapture);
  const sourceFiles: string[] = [];
  const bad = (reason: string) => ({ verified: false, reason, privateOriginalSha256, sourceFiles });
  try {
    if (privateOriginalSha256 !== registration.capture.privateCapture.originalSha256) return bad('Private original capture SHA mismatch.');
    const frozen = JSON.parse(input.privateCapture.toString('utf8'));
    if (digest(frozen.experiment) !== digest(registration.experiment) || digest(frozen.configuration) !== digest(registration.configuration) ||
        digest({ ...frozen.sourcePins, scenarioPaths: registration.sourcePins.scenarioPaths }) !== digest(registration.sourcePins)) {
      return bad('Portable treatment differs from the private original.');
    }
    for (const arm of ['compact', 'full'] as const) {
      const { systemPromptText, ...delta } = frozen.variants[arm].configDelta;
      if (digest(delta) !== digest(registration.variants[arm].configDelta) || frozen.variants[arm].id !== registration.variants[arm].id ||
          typeof systemPromptText !== 'string' || sha(systemPromptText) !== registration.variants[arm].systemPromptTextSha256 ||
          digest(systemPromptText) !== registration.experiment.manifestContract.systemSha256) return bad('Private prompt or variant equality failed.');
    }
    for (const [scenario, path] of Object.entries(registration.sourcePins.scenarioPaths)) {
      if (!String(frozen.sourcePins.scenarioPaths[scenario]).endsWith(`/${path}`) && frozen.sourcePins.scenarioPaths[scenario] !== path) {
        return bad('Portable scenario source differs from the private original.');
      }
      const expected = registration.experiment.manifestContract.scenarioHashes[scenario];
      if (sha(input.readSource(path)) !== expected || (registration.custodyPaths &&
          (!input.buildSha || sha(input.readSource(path, input.buildSha)) !== expected))) {
        return bad(`Scenario source custody mismatch: ${path}`);
      }
    }
    const amendment = registration.measurementAmendment;
    const allowed = ['packages/operator-core/lib/tool-delivery-acceptance.ts', 'packages/operator-core/lib/scorecards.ts',
      'packages/operator-core/lib/tool-delivery-fidelity-custody.test.ts'];
    const oraclePath = 'packages/operator-core/lib/llm-testing/r6-malformed-call-oracle.ts';
    const allowedAdditions = [oraclePath, 'packages/operator-core/lib/tool-delivery-acceptance.test.ts',
      'packages/operator-core/lib/tool-delivery-fidelity-custody.test.ts',
      'packages/operator-core/lib/tool-delivery-clean-runtime.ts', 'packages/operator-core/lib/tool-delivery-clean-runtime.test.ts',
      'packages/operator-core/lib/llm-testing/test-run-ledger.ts', 'libs/test-config/src/execution-details.ts',
      'libs/test-config/src/execution-details.test.ts', 'packages/operator-core/lib/llm-testing/tool-delivery-clean-cohort.mjs',
      'packages/operator-core/lib/llm-testing/tool-delivery-clean-cohort.d.mts'];
    if (!amendment || !(amendment.addedFiles[oraclePath] || (registration.custodyPaths && registration.sourcePins.files[oraclePath])) ||
        !amendment.sourceReplacements['packages/operator-core/lib/tool-delivery-acceptance.ts'] ||
        !/^deterministic-tool-definition-delivery-2026-09-21#D-\d+$/.test(amendment.decisionRef) || !Number.isFinite(Date.parse(amendment.registeredAt)) ||
        Object.keys(amendment.sourceReplacements).some(path => !allowed.includes(path)) ||
        Object.keys(amendment.addedFiles).some(path => !allowedAdditions.includes(path))) {
      return bad('Missing or invalid measurement-only amendment; original treatment remains frozen.');
    }
    toolDeliveryCommittedSubmodules(registration);
    if (!input.buildSha || !/^[a-f0-9]{7,40}$/.test(input.buildSha)) return bad('Loaded measurement build identity is unavailable.');
    for (const [path, originalSha256] of Object.entries(registration.sourcePins.files)) {
      const replacement = amendment?.sourceReplacements[path];
      if (replacement && replacement.originalSha256 !== originalSha256) return bad(`Original measurement source pin changed: ${path}`);
      const expected = replacement?.sha256 ?? originalSha256;
      // The runner's generated catalog is intentionally loaded from the frozen commit.
      const frozenModule = !registration.custodyPaths && path === 'apps/operator/scripts/tool-delivery.generated.mjs';
      if (sha(input.readSource(path, frozenModule ? registration.sourcePins.head : undefined)) !== expected ||
          (!frozenModule && sha(input.readSource(path, input.buildSha)) !== expected)) return bad(`Source custody mismatch: ${path}`);
      sourceFiles.push(path);
    }
    for (const [path, expected] of Object.entries(amendment?.addedFiles ?? {})) {
      if (sha(input.readSource(path)) !== expected || sha(input.readSource(path, input.buildSha)) !== expected) return bad(`Measurement source custody mismatch: ${path}`);
      sourceFiles.push(path);
    }
    return { verified: true, reason: 'Private original, unchanged treatment and pinned measurement sources verified.', privateOriginalSha256, sourceFiles };
  } catch { return bad('Private capture or pinned source could not be verified.'); }
}

/** The expanded reader must be deployed before recording the new optional custody field. */
export function toolDeliveryCommittedSubmodules(registration: Preregistration): Record<string, string> {
  const frozen = registration.sourcePins.submodules ?? {};
  const added = registration.measurementAmendment?.addedSubmodules ?? {};
  for (const [path, commit] of Object.entries(added)) {
    if (path !== 'libs/test-config' || path in frozen || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error('Invalid added measurement gitlink; frozen treatment gitlinks cannot be replaced.');
    if (!Object.keys(registration.measurementAmendment!.addedFiles).some(file => file.startsWith(`${path}/`)))
      throw new Error('Added measurement gitlink has no registered source.');
  }
  if (Object.keys(registration.measurementAmendment?.addedFiles ?? {}).some(path => path.startsWith('libs/test-config/'))
      && !added['libs/test-config']) throw new Error('Measurement contract has no committed test-config gitlink.');
  return { ...frozen, ...added };
}

/** The once-only runner's durable marker and complete receipt bind this population to its first execution. */
export function validateToolDeliveryBatchReceipt(rows: readonly ToolDeliveryRun[], started: unknown, receipt: unknown,
  registration: Preregistration = candidatePreregistration()): string | undefined {
  const marker = object(started), amendment = registration.measurementAmendment;
  const markerAt = typeof marker.at === 'string' ? Date.parse(marker.at) : NaN;
  if (!amendment || !Number.isFinite(markerAt) || markerAt < Date.parse(amendment.registeredAt) ||
      marker.experimentId !== registration.experiment.id || marker.privateSha256 !== registration.capture.privateCapture.originalSha256) {
    return 'Missing or invalid once-only execution marker after measurement preregistration.';
  }
  if (!Array.isArray(receipt) || receipt.length !== 10 || rows.length !== 30 ||
      rows.some(row => !row.started_at || new Date(row.started_at).getTime() < markerAt)) return 'Incomplete or earlier candidate execution population.';
  const expected = registration.configuration.armOrder.flatMap(block => block.arms.map(arm => ({ scenario: block.scenario, arm })));
  const ids: string[] = [];
  for (const [i, raw] of receipt.entries()) {
    const block = object(raw), slot = expected[i]!;
    const variant = slot.arm === 'compact' ? registration.experiment.arms.compactArm : registration.experiment.arms.fullArm;
    const actual = rows.filter(row => row.scenario_id === slot.scenario && row.variant === variant)
      .sort((a, b) => (a.matrix_index ?? -1) - (b.matrix_index ?? -1));
    if (block.scenario !== slot.scenario || block.arm !== slot.arm || block.variantId !== variant ||
        !Array.isArray(block.ids) || digest(block.ids) !== digest(actual.map(row => row.id)) ||
        digest(block.statuses) !== digest(actual.map(row => row.status))) return 'Once-only block receipt differs from the complete persisted population.';
    ids.push(...block.ids);
  }
  if (new Set(ids).size !== 30 || digest([...ids].sort()) !== digest(rows.map(row => row.id).sort())) return 'Candidate receipt omits or replaces attempts.';
}

/** A superproject gitlink selects the runner actually loaded, not the submodule's current HEAD. */
export function readToolDeliveryCommittedSource(path: string, ref: string, submodules: Readonly<Record<string, string>>,
  git: (args: string[], directory?: string) => Buffer): Buffer {
  const submodule = Object.entries(submodules).find(([directory]) => path.startsWith(`${directory}/`));
  if (!submodule) return git(['show', `${ref}:${path}`]);
  const [directory, pinnedCommit] = submodule;
  const loadedCommit = git(['rev-parse', `${ref}:${directory}`]).toString().trim();
  if (loadedCommit !== pinnedCommit) throw new Error('Loaded submodule differs from the registered gitlink.');
  return git(['show', `${loadedCommit}:${path.slice(directory.length + 1)}`], directory);
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
      'Current oracle: shared AJV 2020-12 with ajv-formats validates registered formats; unknown custom formats/keywords are ignored (strict:false). Historical measurements retain their recorded validator and limits.',
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
  const executionError = validateExecutionOrder(rows, experiment);
  if (executionError) {
    result.comprehension.reason = result.invalidArguments.reason = executionError;
    return result;
  }
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
  result.oracle = r6PrimaryVerdict(calls, schemas, experiment.arms, experiment.scenarios);
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
  const rows = experiment.manifestContract ? await sql<ToolDeliveryRun[]>`
    SELECT id, scenario_id, scenario_hash, sut_model, judge_model, status,
           telemetry_json->>'variantId' AS variant, transcript_norm_json, transcript_raw_zstd,
           started_at, finished_at, matrix_group_id, matrix_index
      FROM harness_shared.llm_test_runs
     WHERE telemetry_json->>'variantId' = ANY(${Object.values(experiment.arms)})
     ORDER BY started_at, id LIMIT 101` : await sql<ToolDeliveryRun[]>`
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
    const result = evaluateToolDeliveryRuns(rows, buildOracleSchemaIndex(tools, new Map(contract.canonicalBySanitized)), experiment);
    let receiptError: string | undefined;
    try {
      const registration = toolDeliveryPreregistration(experiment.id);
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
      result.custody = verifyToolDeliverySourceCustody({
        registration,
        privateCapture: readFileSync(resolve(homedir(), '.papercusp/experiments',
          registration.custodyPaths?.privateCaptureFile ?? 'tool-delivery-full-after-use-original-20261021.json')),
        buildSha: getBuildInfo().sha,
        readSource: (path, ref) => {
          if (!ref) return readFileSync(resolve(root, path));
          const options = { cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
          return readToolDeliveryCommittedSource(path, ref, toolDeliveryCommittedSubmodules(registration),
            (args, directory) => execFileSync('git', args, { ...options, cwd: directory ? resolve(root, directory) : root }));
        },
      });
      const directory = resolve(homedir(), '.papercusp/experiments', registration.custodyPaths?.receiptDirectory ?? 'd062-once-20261022');
      receiptError = validateToolDeliveryBatchReceipt(rows, JSON.parse(readFileSync(resolve(directory, 'started.json'), 'utf8')),
        JSON.parse(readFileSync(resolve(directory, 'receipt.json'), 'utf8')), registration);
    } catch { result.custody = { verified: false, reason: 'Private original source custody is unavailable.' }; }
    let cleanError: string | undefined;
    const registration = toolDeliveryPreregistration(experiment.id);
    if (registration.executionPolicy?.requireCleanRuntime === true) {
      try {
        const directory = resolve(homedir(), '.papercusp/experiments', registration.custodyPaths!.receiptDirectory);
        const clean = JSON.parse(readFileSync(resolve(directory, 'clean-runtime-receipts.json'), 'utf8')) as {
          pin: ToolDeliveryCleanPin; blocks: ToolDeliveryCleanBlock[];
        };
        const expectedBlocks = registration.configuration.armOrder.flatMap(block => block.arms.map(arm => ({
          scenario: block.scenario, arm,
          variantId: arm === 'compact' ? experiment.arms.compactArm : experiment.arms.fullArm,
        })));
        cleanError = validateToolDeliveryCleanBlocks({ ...clean, expectedBlocks, runIds: result.runIds,
          ...(registration.executionPolicy.measurementController === 'separate-root' ? {
            controllerRequired: true, sourceCommit: registration.sourcePins.head,
            controllerLauncher: registration.executionPolicy.launcherPath,
            controllerMarker: JSON.parse(readFileSync(resolve(directory, 'started.json'), 'utf8')),
          } : {}),
          judgedCells: result.oracle?.scenarioCoverage ?? [] });
        const receipt = JSON.parse(readFileSync(resolve(directory, 'receipt.json'), 'utf8')) as Array<{
          testRunId: number; scenario: string;
        }>;
        const testRunIds = receipt.map(block => block.testRunId);
        if (testRunIds.length !== 10 || new Set(testRunIds).size !== 10 || testRunIds.some(id => !Number.isSafeInteger(id)))
          cleanError = 'Clean cohort has no exact ten-block recorder ledger.';
        else {
          const recorded = await sql<{ id: number; framework: string; worktree_dirty: boolean;
            commit_sha: string; execution_details: Record<string, unknown> }[]>`
            SELECT id, framework, worktree_dirty, commit_sha, execution_details FROM harness_shared.test_runs
             WHERE id = ANY(${testRunIds}) ORDER BY id`;
          if (recorded.length !== 10 || receipt.some((block, index) => {
            const row = recorded.find(row => Number(row.id) === block.testRunId);
            const execution = object(row?.execution_details);
            const before = object(execution.runtimeEnvironmentBefore), after = object(execution.runtimeEnvironmentAfter);
            const unit = `llm-test-in-process-${clean.blocks[index]?.before.pid}`;
            return !row || row.framework !== 'llm-test' || row.worktree_dirty !== false || execution.worktreeDirty !== false
              || Boolean(validateToolDeliveryBlockLedgerIdentity(execution.llmBlockCustody, experiment.id, index, clean.blocks[index]!))
              || row.commit_sha !== clean.pin.commit || execution.commitSha !== clean.pin.commit
              || execution.scenarioId !== block.scenario || execution.testLayer !== 'llm'
              || execution.passed !== 3 || execution.failed !== 0 || execution.skipped !== 0
              || execution.collectionFailed !== false || digest(before.units) !== digest([unit])
              || digest(after.units) !== digest([unit]) || typeof before.fingerprint !== 'string'
              || before.fingerprint !== after.fingerprint;
          })) cleanError = 'Original recorder ledger does not prove clean, stable in-process execution.';
        }
        for (const block of clean.blocks) {
          for (const boundary of [block.before, block.after]) {
            const error = validateToolDeliveryCleanCensus(boundary, registration);
            if (error) cleanError = error;
          }
          const attempts = block.runIds.map(id => rows.find(row => row.id === id));
          const manifests = attempts.map(row => ({ runId: row?.id,
            manifests: (Array.isArray(row?.raw_events) ? row.raw_events : [])
              .filter(event => object(event).name === 'tool_definition_manifest') }));
          if (digest(manifests) !== block.requestManifestSha256)
            cleanError = 'Clean boundary receipt differs from the original request manifests.';
        }
      } catch { cleanError = 'Clean-runtime boundary or recorder receipts are unavailable or invalid.'; }
    }
    const outsideWindow = rows.some(row => !row.started_at || !row.finished_at ||
      new Date(row.started_at).getTime() < Date.parse(window.windowStart) || new Date(row.finished_at).getTime() > Date.parse(window.windowEnd));
    if (!result.custody.verified || outsideWindow || receiptError || cleanError) {
      result.comprehension = result.invalidArguments = { verdict: 'unknown',
        reason: outsideWindow ? 'Observation window omits candidate attempts; the entire population was retained.' : receiptError ?? cleanError ?? result.custody.reason };
    }
    return result;
  }
  const { buildShippingSeedCatalog } = await import('./llm-testing/targets/su-compact-catalog');
  const { catalog } = await buildShippingSeedCatalog('full');
  return evaluateToolDeliveryRuns(rows, buildOracleSchemaIndex(catalog.tools, catalog.canonicalBySanitized), experiment);
}
