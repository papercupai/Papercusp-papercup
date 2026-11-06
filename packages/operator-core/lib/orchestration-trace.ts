/**
 * Normalized, secret-free evidence for one code orchestration execution.
 *
 * This is deliberately an extension of the code-recipes run rail, not another
 * recipe/runtime abstraction. Static calls supply the reusable structure;
 * runtime call records supply truthful dispositions and validated output
 * references. The structural fingerprint excludes backend, outcomes, binding
 * values, ephemeral values, and output-reference identities.
 */
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  checkScript,
  ensureParseCheckReady,
  type OrchestrationCallRecord,
  type OrchestrationOutputReference,
  type ProjectedTool,
} from '@papercusp/tooldef';
import { deriveRecipeAuthority, type RecipeAuthorityRefs } from './recipe-authority';
import { type ReplayClass, type RecipeBindingSchemaV1, recipeBindingSchemaV1Schema } from './recipe-contract';
import type { SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';
import { isSensitiveValueKey, redactSensitiveText } from './sensitive-text';

// The shell-quote package has no bundled types. Keep the boundary typed in
// every importing project, including script/test legs without our ambient .d.ts.
type ShellToken = string | { op: string } | { comment: string };
const parseShellArguments: (source: string, env?: (name: string) => string) => ShellToken[] =
  createRequire(import.meta.url)('shell-quote').parse;

export const ORCHESTRATION_TRACE_SCHEMA_VERSION = 1 as const;
export const OPERATION_TRACE_SCHEMA_VERSION = 2 as const;

export type OperationAdapterFamily = 'composition' | 'shell' | 'sql' | 'native-operation'
  | 'search-reformulation' | 'result-recovery' | 'workaround-funnel';

/** Only opaque identity and scoped references cross into the global recipe rail.
 * Raw SQL, commands, environment values and credentials stay at their source.
 * These references describe evidence; none convey the author's authority. */
export interface OperationAdapterEvidence {
  operationId: string;
  family: OperationAdapterFamily;
  adapterVersion: string;
  semanticIdentity: {
    version: string;
    fingerprint: string;
    workspaceId: string;
    sourceBoundary: string;
    epoch: string;
  };
  source: {
    ref: string;
    authorityRef: string;
    observedAt: string;
    expiresAt: string | null;
    providerCallId?: string;
    parentOperationId?: string;
  };
  outcome: {
    status: 'success' | 'error' | 'refused' | 'preview' | 'running' | 'unknown';
    final: boolean;
    receiptRef?: string;
  };
  replayClass: ReplayClass;
  bindingSchema?: RecipeBindingSchemaV1;
  decisionRefs: string[];
}

export interface OperationDependency {
  fromOperationId: string;
  toOperationId: string;
  kind: 'data' | 'control';
  /** An observed binding/control receipt, never an edge inferred from source order. */
  evidenceRef: string;
}

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9_:/.@-]{0,399}$/;
const opaqueRef = (value: unknown): value is string => typeof value === 'string' && OPAQUE_REF.test(value);
const FAMILIES = new Set<OperationAdapterFamily>(['composition', 'shell', 'sql', 'native-operation',
  'search-reformulation', 'result-recovery', 'workaround-funnel']);

/** Current source authorization is repeated by every consumer; an observed or
 * previously authorized reference is insufficient after revocation or expiry. */
export function readableOperationEvidence(
  trace: Pick<NormalizedExecutionTrace, 'operations'>,
  context: { workspaceId: string; now: number; canRead: (source: OperationAdapterEvidence['source']) => boolean },
): OperationAdapterEvidence[] {
  if (!Number.isFinite(context.now)) return [];
  return (trace.operations ?? []).filter(operation =>
    operation.semanticIdentity.workspaceId === context.workspaceId
    && (operation.source.expiresAt === null || Date.parse(operation.source.expiresAt) > context.now)
    && context.canRead(operation.source));
}

/** A conservative shell-quote adapter. Unsupported expansion stays unknown rather
 * than being mistaken for an equivalent command. The existing SQL adapter supplies
 * its parser/HMAC identity directly through the same semanticIdentity contract. */
export function fingerprintShellOperation(
  input: { command: string; cwd: string; environment: Record<string, string | number | boolean>; effect: 'read' | 'write' | 'unknown' },
  scope: SqlIntentScope,
): { status: 'supported'; version: string; fingerprint: string } | { status: 'unknown'; version: string; reason: string } {
  const version = 'shell-quote:operation-v1';
  const unknown = (reason: string) => ({ status: 'unknown' as const, version, reason });
  if (!scope?.workspaceId || !scope.sourceBoundary || !scope.epoch
    || !(scope.key instanceof Uint8Array) || scope.key.byteLength < 32) return unknown('invalid-scope');
  if (!input.command.trim() || input.command.length > 64_000 || !input.cwd) return unknown('incomplete-source');
  // shell-quote is not a full bash AST. Do not silently erase substitution,
  // expansion, line boundaries, grouping, here-doc or reserved-word semantics.
  if (/[\r\n`]/.test(input.command) || /\$[({]|[(){}]|<<|\b(?:if|then|fi|for|while|case|do|done|function)\b/.test(input.command)
    || input.command.includes('__RECIPE_ENV_REF__')) return unknown('unsupported-syntax');
  const values = [input.command, input.cwd, ...Object.values(input.environment).map(String)];
  if (Object.keys(input.environment).some(isSensitiveValueKey)
    || values.some(value => redactSensitiveText(value, scope.knownSecrets) !== value)
    || values.some(value => scope.knownSecrets?.some(secret => secret.length > 0 && value.includes(secret)))) {
    return unknown('secret-bearing-source');
  }
  let tokens: ReturnType<typeof parseShellArguments>;
  try { tokens = parseShellArguments(input.command, name => '__RECIPE_ENV_REF__' + name); }
  catch { return unknown('parse-failed'); }
  if (tokens.some(token => typeof token === 'object' && 'op' in token
    && !['|', '||', '&&', ';', '&', '<', '>', '>>', '>&', '<&'].includes(token.op))) return unknown('unsupported-syntax');
  tokens = tokens.filter(token => !(typeof token === 'object' && 'comment' in token));
  if (!tokens.length) return unknown('empty');
  const environment = Object.keys(input.environment).sort().map(name => [name, typeof input.environment[name], input.environment[name]]);
  const fingerprint = createHmac('sha256', scope.key).update(JSON.stringify([
    version, scope.workspaceId, scope.sourceBoundary, scope.epoch, tokens, input.cwd, environment, input.effect,
  ])).digest('hex');
  return { status: 'supported', version, fingerprint };
}

function copyOperationEvidence(operations: readonly OperationAdapterEvidence[]): OperationAdapterEvidence[] {
  const ids = new Set<string>();
  return operations.map(operation => {
    const identity = operation.semanticIdentity;
    const source = operation.source;
    if (!opaqueRef(operation.operationId) || ids.has(operation.operationId) || !FAMILIES.has(operation.family)
      || !opaqueRef(operation.adapterVersion) || !opaqueRef(identity.version) || !/^[a-f0-9]{64}$/.test(identity.fingerprint)
      || ![identity.workspaceId, identity.sourceBoundary, identity.epoch, source.ref, source.authorityRef,
        ...operation.decisionRefs, ...(source.providerCallId ? [source.providerCallId] : []),
        ...(source.parentOperationId ? [source.parentOperationId] : []),
        ...(operation.outcome.receiptRef ? [operation.outcome.receiptRef] : [])].every(opaqueRef)
      || !Number.isFinite(Date.parse(source.observedAt))
      || (source.expiresAt !== null && !Number.isFinite(Date.parse(source.expiresAt)))
      || !['read-only', 'idempotent', 'checkpointed', 'non-replayable'].includes(operation.replayClass)
      || !['success', 'error', 'refused', 'preview', 'running', 'unknown'].includes(operation.outcome.status)
      || typeof operation.outcome.final !== 'boolean'
      || (operation.outcome.status === 'running' && operation.outcome.final)) throw new Error('invalid_operation_evidence');
    ids.add(operation.operationId);
    // Select declared fields only: an adapter's raw input/author privilege cannot
    // hitchhike on an otherwise valid runtime object.
    return {
      operationId: operation.operationId, family: operation.family, adapterVersion: operation.adapterVersion,
      semanticIdentity: { version: identity.version, fingerprint: identity.fingerprint, workspaceId: identity.workspaceId,
        sourceBoundary: identity.sourceBoundary, epoch: identity.epoch },
      source: { ref: source.ref, authorityRef: source.authorityRef, observedAt: source.observedAt, expiresAt: source.expiresAt,
        ...(source.providerCallId ? { providerCallId: source.providerCallId } : {}),
        ...(source.parentOperationId ? { parentOperationId: source.parentOperationId } : {}) },
      outcome: { status: operation.outcome.status, final: operation.outcome.final,
        ...(operation.outcome.receiptRef ? { receiptRef: operation.outcome.receiptRef } : {}) },
      replayClass: operation.replayClass,
      ...(operation.bindingSchema ? { bindingSchema: recipeBindingSchemaV1Schema.parse(operation.bindingSchema) } : {}),
      decisionRefs: [...operation.decisionRefs],
    };
  });
}

function copyDependencies(dependencies: readonly OperationDependency[], operations: readonly OperationAdapterEvidence[]): OperationDependency[] {
  const seen = new Map<string, string[]>();
  const ids = new Set(operations.map(operation => operation.operationId));
  const reaches = (from: string, to: string): boolean => from === to || (seen.get(from) ?? []).some(next => reaches(next, to));
  return dependencies.map(edge => {
    if (!ids.has(edge.fromOperationId) || !ids.has(edge.toOperationId) || !opaqueRef(edge.evidenceRef)
      || !['data', 'control'].includes(edge.kind) || reaches(edge.toOperationId, edge.fromOperationId)) throw new Error('invalid_operation_dependency');
    seen.set(edge.fromOperationId, [...(seen.get(edge.fromOperationId) ?? []), edge.toOperationId]);
    return { fromOperationId: edge.fromOperationId, toOperationId: edge.toOperationId, kind: edge.kind, evidenceRef: edge.evidenceRef };
  });
}

export type OrchestrationTraceBackend = 'server' | 'client-compat';
export type StableBindingKind = 'workspace' | 'fleet' | 'plan' | 'harness' | 'item' | 'resource';
export type EphemeralValueKind =
  | 'owner-id'
  | 'session-id'
  | 'pty-session-id'
  | 'process-id'
  | 'cursor'
  | 'temp-path'
  | 'local-path';
export type TraceReplayability = 'deterministic' | 'environment-bound' | 'client-bound' | 'session-bound' | 'mixed';

export interface OrchestrationStableBinding {
  parameter: string;
  kind: StableBindingKind;
  /** Stable entity value needed by a later binding/replay phase. Never included in the fingerprint. */
  value: string;
}

export interface OrchestrationEphemeralValue {
  path: string;
  kind: EphemeralValueKind;
}

export interface OrchestrationStaticCall {
  id: string;
  tool: string;
  dynamicArgs: boolean;
  /** Canonical JSON-safe shape. It contains parameter/ephemeral/redaction markers, never raw free-form strings. */
  args: unknown;
  capabilities: string[];
}

export interface OrchestrationRuntimeCall {
  ordinal: number;
  tool: string;
  effect: 'read' | 'write' | 'unknown';
  disposition: OrchestrationCallRecord['disposition'];
  capabilities: string[];
  outputReferences: OrchestrationOutputReference[];
}

export interface NormalizedExecutionTrace {
  schemaVersion: typeof ORCHESTRATION_TRACE_SCHEMA_VERSION | typeof OPERATION_TRACE_SCHEMA_VERSION;
  backend: OrchestrationTraceBackend;
  requirements: {
    tools: string[];
    capabilities: string[];
    premises: ['host:same'];
  };
  toolGraph: {
    /** Source order. This is intentionally not mislabeled as a dependency edge. */
    staticCalls: OrchestrationStaticCall[];
    /** Actual dispatch order. Parallel settlement order is not inferred as a dependency edge. */
    runtimeCalls: OrchestrationRuntimeCall[];
  };
  stableBindings: OrchestrationStableBinding[];
  ephemeralValues: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
  portability: {
    host: 'same';
    replayability: TraceReplayability;
    ephemeralKinds: EphemeralValueKind[];
  };
  structuralFingerprint: string;
  /** Absent on schema 1 traces; legacy families/history stay readable. */
  operations?: OperationAdapterEvidence[];
  dependencies?: OperationDependency[];
}

export interface NormalizeExecutionTraceInput {
  script: string;
  backend?: OrchestrationTraceBackend;
  tools: readonly ProjectedTool[];
  allowed?: ReadonlySet<string>;
  callRecords?: readonly OrchestrationCallRecord[];
  operations?: readonly OperationAdapterEvidence[];
  dependencies?: readonly OperationDependency[];
}

type BindingRefsKey = keyof RecipeAuthorityRefs;
type JsonMarker = Record<string, string | boolean>;

const BINDING_DIMENSIONS: ReadonlyArray<{
  kind: StableBindingKind;
  refsKey: BindingRefsKey;
}> = [
  { kind: 'workspace', refsKey: 'workspaces' },
  { kind: 'fleet', refsKey: 'fleets' },
  { kind: 'plan', refsKey: 'plans' },
  { kind: 'harness', refsKey: 'harnesses' },
  { kind: 'item', refsKey: 'items' },
  { kind: 'resource', refsKey: 'resources' },
];

const SECRET_KEYS = new Set([
  'apikey',
  'accesskey',
  'secretkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'privatekey',
  'passphrase',
  'clientsecret',
]);
const OWNER_ID = /^su-(?:[0-9a-f]{4,64}|[0-9a-f-]{36})$/i;
const TEMP_PATH_ROOT = /^(?:\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/run\/|\/dev\/shm\/)/i;
const ABSOLUTE_LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function secretKey(key: string | null): boolean {
  if (!key) return false;
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || normalized.endsWith('apikey') || normalized.endsWith('secret');
}

function ephemeralKind(key: string | null, value: unknown): EphemeralValueKind | null {
  const normalized = key ? normalizeKey(key) : '';
  if (typeof value === 'string') {
    if (OWNER_ID.test(value)) return 'owner-id';
    if (TEMP_PATH_ROOT.test(value)) return 'temp-path';
    if (ABSOLUTE_LOCAL_PATH.test(value) && !value.includes('://')) return 'local-path';
  }
  if (normalized.includes('pty') || normalized === 'bashid') return 'pty-session-id';
  if (normalized === 'session' || normalized.endsWith('sessionid') || normalized === 'sid') return 'session-id';
  if (
    normalized === 'pid' ||
    normalized.endsWith('processid') ||
    normalized === 'jobid' ||
    normalized === 'taskid'
  ) {
    return 'process-id';
  }
  if (normalized.includes('cursor')) return 'cursor';
  if (
    typeof value === 'string' &&
    (normalized === 'cwd' || normalized === 'workdir' || normalized.endsWith('filepath') || normalized === 'path') &&
    !value.includes('://')
  ) {
    return TEMP_PATH_ROOT.test(value) ? 'temp-path' : 'local-path';
  }
  return null;
}

function capabilitiesByTool(tools: readonly ProjectedTool[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    out.set(name, [...new Set(tool.capabilities)].sort());
  }
  return out;
}

interface ValueNormalizerState {
  refsByValue: Map<string, StableBindingKind[]>;
  bindingByIdentity: Map<string, OrchestrationStableBinding>;
  bindingCounters: Map<StableBindingKind, number>;
  ephemeral: OrchestrationEphemeralValue[];
  redactedSecretPaths: string[];
}

function createValueNormalizerState(refs: RecipeAuthorityRefs): ValueNormalizerState {
  const refsByValue = new Map<string, StableBindingKind[]>();
  for (const dimension of BINDING_DIMENSIONS) {
    for (const value of refs[dimension.refsKey]) {
      const kinds = refsByValue.get(value) ?? [];
      kinds.push(dimension.kind);
      refsByValue.set(value, kinds);
    }
  }
  return {
    refsByValue,
    bindingByIdentity: new Map(),
    bindingCounters: new Map(),
    ephemeral: [],
    redactedSecretPaths: [],
  };
}

function stableBindingMarker(value: string, state: ValueNormalizerState): JsonMarker | null {
  const kind = state.refsByValue.get(value)?.[0];
  if (!kind) return null;
  const identity = `${kind}\u0000${value}`;
  let binding = state.bindingByIdentity.get(identity);
  if (!binding) {
    const ordinal = (state.bindingCounters.get(kind) ?? 0) + 1;
    state.bindingCounters.set(kind, ordinal);
    binding = { parameter: `${kind}:${ordinal}`, kind, value };
    state.bindingByIdentity.set(identity, binding);
  }
  return { $binding: binding.parameter };
}

function normalizeValue(
  value: unknown,
  state: ValueNormalizerState,
  path: string,
  key: string | null = null,
): unknown {
  if (secretKey(key)) {
    state.redactedSecretPaths.push(path);
    return { $redacted: 'secret' };
  }

  const ephemeral = ephemeralKind(key, value);
  if (ephemeral) {
    state.ephemeral.push({ path, kind: ephemeral });
    return { $ephemeral: ephemeral };
  }

  if (typeof value === 'string') {
    const binding = stableBindingMarker(value, state);
    return binding ?? { $literal: 'string' };
  }
  if (typeof value === 'number') return { $literal: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeValue(entry, state, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = normalizeValue(value[childKey], state, `${path}.${childKey}`, childKey);
    }
    return out;
  }
  return { $dynamic: true };
}

function replayabilityFor(
  backend: OrchestrationTraceBackend,
  ephemeralKinds: readonly EphemeralValueKind[],
): TraceReplayability {
  const sessionBound = ephemeralKinds.some((kind) =>
    ['owner-id', 'session-id', 'pty-session-id', 'process-id', 'cursor'].includes(kind),
  );
  const environmentBound = ephemeralKinds.some((kind) => kind === 'temp-path' || kind === 'local-path');
  if ((sessionBound && environmentBound) || (backend === 'client-compat' && (sessionBound || environmentBound))) {
    return 'mixed';
  }
  if (sessionBound) return 'session-bound';
  if (environmentBound) return 'environment-bound';
  if (backend === 'client-compat') return 'client-bound';
  return 'deterministic';
}

function copyOutputReference(reference: OrchestrationOutputReference): OrchestrationOutputReference {
  return {
    uri: reference.uri,
    byteCount: reference.byteCount,
    sha256: reference.sha256,
    ...(reference.expiresAt ? { expiresAt: reference.expiresAt } : {}),
    ...(reference.audience ? { audience: reference.audience } : {}),
  };
}

/** Build the canonical trace and its backend/outcome-independent structural fingerprint. */
export async function normalizeExecutionTrace(
  input: NormalizeExecutionTraceInput,
): Promise<NormalizedExecutionTrace> {
  await ensureParseCheckReady();
  const backend = input.backend ?? 'server';
  const [analysis, authority] = await Promise.all([
    Promise.resolve(checkScript(input.script, input.tools, input.allowed)),
    deriveRecipeAuthority(input.script),
  ]);
  const capabilityMap = capabilitiesByTool(input.tools);
  const state = createValueNormalizerState(authority.refs);

  const staticCalls: OrchestrationStaticCall[] = analysis.calls.map((call, ordinal) => ({
    id: `static:${ordinal}`,
    tool: call.tool,
    dynamicArgs: call.dynamicArgs,
    args: normalizeValue(call.args, state, `staticCalls[${ordinal}].args`),
    capabilities: capabilityMap.get(call.tool) ?? [],
  }));
  const runtimeCalls: OrchestrationRuntimeCall[] = [...(input.callRecords ?? [])]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((call) => ({
      ordinal: call.ordinal,
      tool: call.tool,
      effect: call.effect,
      disposition: call.disposition,
      capabilities: capabilityMap.get(call.tool) ?? [],
      outputReferences: call.outputReferences.map(copyOutputReference),
    }));

  const toolNames = [...new Set([...staticCalls.map((call) => call.tool), ...runtimeCalls.map((call) => call.tool)])].sort();
  const capabilities = [
    ...new Set([...staticCalls, ...runtimeCalls].flatMap((call) => call.capabilities)),
  ].sort();
  const ephemeralValues = state.ephemeral
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path && candidate.kind === entry.kind) === index)
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const ephemeralKinds = [...new Set(ephemeralValues.map((entry) => entry.kind))].sort() as EphemeralValueKind[];
  const stableBindings = [...state.bindingByIdentity.values()].sort((a, b) => a.parameter.localeCompare(b.parameter));
  const redactedSecretPaths = [...new Set(state.redactedSecretPaths)].sort();
  const operations = copyOperationEvidence(input.operations ?? []);
  const dependencies = copyDependencies(input.dependencies ?? [], operations);
  const schemaVersion = operations.length ? OPERATION_TRACE_SCHEMA_VERSION : ORCHESTRATION_TRACE_SCHEMA_VERSION;

  // Deliberately excludes: backend, dispositions, binding VALUES, reference URI/hash/size,
  // and ephemeral values. Runtime-only tools are sorted because parallel dispatch order is
  // evidence, not structure; the full ordered runtimeCalls remain in the trace above.
  const fingerprintShape = {
    schemaVersion,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    staticCalls: staticCalls.map((call) => ({
      tool: call.tool,
      dynamicArgs: call.dynamicArgs,
      args: call.args,
      capabilities: call.capabilities,
    })),
    runtimeOnlyTools: [...new Set(runtimeCalls.map((call) => call.tool).filter((tool) => !staticCalls.some((s) => s.tool === tool)))].sort(),
    ephemeralKinds,
    outputReferenceShape: runtimeCalls
      .filter((call) => call.outputReferences.length > 0)
      .map((call) => ({
        tool: call.tool,
        count: call.outputReferences.length,
        audiences: [...new Set(call.outputReferences.map((reference) => reference.audience ?? 'unspecified'))].sort(),
      }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
    ...(operations.length ? {
      operations: operations.map(operation => ({ family: operation.family, adapterVersion: operation.adapterVersion,
        semanticIdentity: operation.semanticIdentity, replayClass: operation.replayClass, bindingSchema: operation.bindingSchema })),
      // Receipt IDs are provenance; dependency topology is semantic.
      dependencies: dependencies.map(edge => ({ from: operations.findIndex(operation => operation.operationId === edge.fromOperationId),
        to: operations.findIndex(operation => operation.operationId === edge.toOperationId), kind: edge.kind })),
    } : {}),
  };
  const structuralFingerprint = createHash('sha256').update(JSON.stringify(fingerprintShape)).digest('hex');

  return {
    schemaVersion,
    backend,
    requirements: { tools: toolNames, capabilities, premises: ['host:same'] },
    toolGraph: { staticCalls, runtimeCalls },
    stableBindings,
    ephemeralValues,
    redactedSecretPaths,
    portability: {
      host: 'same',
      replayability: replayabilityFor(backend, ephemeralKinds),
      ephemeralKinds,
    },
    structuralFingerprint,
    ...(operations.length ? { operations, dependencies } : {}),
  };
}
