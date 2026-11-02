/** Current native su execution over the existing benchmark lifecycle and task ledger. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type launchAgentTool from '../agent-tools/capability/launch-agent';
import { snapshotScopedInferenceGateway, type ScopedInferenceGateway } from '@papercusp/orchestrator/codex-gateway-config';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { TaskRow } from '../task-manager/types';
import type { ControlOutcome } from '../task-manager/control';
import { resolveBenchWorkspace } from './bench-workspace';
import { liveBenchHarnessDriver, liveBenchHarnessOps, hasValidBenchRunCost, type BenchHarnessOps, type BenchHarnessHandle, type BenchRunCost, type DriveResult, type LiveBenchHarnessOpts } from './bench-harness-live';
import { FULL_SPINE_BLUEPRINT, setBenchHarnessDriver } from './run-loop';
import type { BenchTask, GenerationBudget } from './types';
import type { DbScope } from './reproducibility/db';
import { requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import { normalizeFeatureStateInput } from '../work-item-dispatch-states';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from '../runtime-vintage';
import { currentBenchmarkProtocolSchema, currentBenchProviderAgent, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { canonicalJson } from './reproducibility/canonical-json';
import { createNativeGymGatewayController, startNativeGymGateway, type NativeGymProviderAuthorization } from '../gym/proposer';
import type { GovernorGlueDeps } from '../learning-governor/registrants';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import type { LearningReservationResourceBudget, LearningSpendReservationCensus } from '../learning-governor/store';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { CredentialResolver } from '../inference-gateway/credential-store';
import type { ClosedClaudeSessionUsage, ClosedCodexSessionUsage } from '../session-transcript-resolvers';
import { priceRun } from '@papercusp/bench-metrics';
import { currentProtocolPriceTable } from './reproducibility/schema';
import { readGatewayNativeCorrelation } from '../inference-gateway/request-stage-telemetry';
import { concurrencyTimelineFromIntervals } from './hive-backlog-utilities';
import { restoreBenchmarkContext, readRestoredBenchmarkContext, readContainedBenchmarkFile, type BenchmarkContextInput, type BenchmarkContextReceipt } from './reproducibility/context';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';
import { openAiCacheGeneration } from '../inference-gateway/cache-policy';
import { CONTAINER_CODEX_BIN_PATH, materializeDockerExecWrapper, validateDockerExecTarget, type DockerExecTarget } from './container-exec-target';
import type { PsuPtyHost } from '../events/await/psu-pty-discovery';

interface NativeCostParticipant {
  taskId: string; ownerId: string; terminal: boolean;
  agent?: 'codex' | 'claude'; codexHome?: string; claudeConfigDir?: string;
  startedAtMs?: number | null; endedAtMs?: number | null;
}
type ClosedNativeSessionUsage = ClosedCodexSessionUsage | ClosedClaudeSessionUsage;
type NativeSourceUsage = Extract<ClosedNativeSessionUsage, { ok: true }>;
function nativeCostHome(participant: NativeCostParticipant): string {
  return participant.agent === 'claude'
    ? !participant.codexHome && participant.claudeConfigDir?.trim() || ''
    : (!participant.agent || participant.agent === 'codex') && !participant.claudeConfigDir && participant.codexHome?.trim() || '';
}
export interface CurrentBenchAccountingBinding {
  readonly workspaceId: string; readonly loopId: string; readonly runId: string;
  readonly preregHash: string; readonly assignmentId: string;
}
export interface CurrentBenchTaskRequestCensus {
  readonly binding: Readonly<CurrentBenchAccountingBinding>;
  readonly populationSha256: string;
  readonly requests: readonly Readonly<{
    reservationId: string; bodySha256: string;
  } & ({ agent?: never; nativeSessionId: string; nativeTurnId: string; nativeMessageId?: never } |
    { agent: 'claude'; nativeSessionId?: never; nativeTurnId?: never; nativeMessageId?: string })>[];
}
interface NativeAccountingSource {
  participant: NativeCostParticipant; nativeSessionId: string;
  usage: NativeSourceUsage;
  billed?: NativeBillPopulation;
}
interface NativeBillPopulation {
  knownSubtotalUsd: number; complete: boolean;
  samples?: readonly { usageEventKey: string; sampleId: string; activationEventId: string; billedInferenceMicros?: string }[];
}
interface NativeAccountingPopulation {
  participants: readonly NativeCostParticipant[]; sources: readonly NativeAccountingSource[];
}

/** Reconcile the complete reservation population with individually identified
 * native usage requests. Caller IDs alone, aggregate totals, ambiguous equal
 * requests and failed sends with unknown usage cannot establish completeness.
 * This proves the observed populations agree; actual provider bills and route
 * confinement remain separate requirements. */
export function currentBenchAttemptPopulationMatches(binding: CurrentBenchAccountingBinding,
  population: NativeAccountingPopulation, before: LearningSpendReservationCensus,
  after: LearningSpendReservationCensus): boolean {
  try {
    if (!binding.workspaceId.trim() || !binding.loopId.trim() || !binding.runId.trim() ||
        !/^[a-f0-9]{64}$/.test(binding.preregHash) || !binding.assignmentId.startsWith('bench-assignment:') ||
        before.status !== 'complete' || after.status !== 'complete' ||
        before.populationSha256 !== after.populationSha256 ||
        canonicalJson(before.reservations) !== canonicalJson(after.reservations) ||
        !population.participants.length || population.participants.some(p => !p.terminal) || !population.sources.length) return false;
    const expected = new Map<string, string[]>(), keys = new Set<string>(), sessions = new Set<string>();
    const messageSessions = new Map<string, string>();
    const signature = (agent: 'codex' | 'claude', session: string, request: string, model: string,
      input: number, output: number, read: number, write: number) =>
      canonicalJson([agent, session, request, model, input, output, read, write]);
    for (const source of population.sources) {
      if (!population.participants.some(p => canonicalJson(p) === canonicalJson(source.participant)) ||
          !nativeCostHome(source.participant) || !source.nativeSessionId || sessions.has(source.nativeSessionId) ||
          !source.usage.ok || !/^[a-f0-9]{64}$/.test(source.usage.sourceSha256)) return false;
      const claude = source.participant.agent === 'claude';
      if (claude !== ('nativeMessageIds' in source.usage)) return false;
      sessions.add(source.nativeSessionId);
      for (const event of source.usage.events) {
        const request = claude ? event.providerResponseId : event.turnId;
        if (!request || event.inputTotalTokens == null || keys.has(event.usageEventKey)) return false;
        if (claude) {
          if (event.turnId || event.sourceId !== `message:${request}` || messageSessions.has(request)) return false;
          messageSessions.set(request, source.nativeSessionId);
        }
        keys.add(event.usageEventKey);
        const key = signature(claude ? 'claude' : 'codex', source.nativeSessionId, request, event.model, event.inputTotalTokens,
          event.usage.outputTokens, event.usage.cacheReadTokens, event.usage.cacheCreationTokens);
        expected.set(key, [...(expected.get(key) ?? []), event.usageEventKey]);
      }
    }
    const reservations = new Set<string>(), responses = new Set<string>();
    for (const row of before.reservations) {
      if (row.workspaceId !== binding.workspaceId || row.loopId !== binding.loopId || reservations.has(row.id)) return false;
      reservations.add(row.id);
      const note = JSON.parse(row.note ?? 'null'), attempt = note?.nativeGatewayAttempt;
      if (!attempt || attempt.manifestSha256 !== binding.preregHash || attempt.armId !== row.resources?.armId ||
          attempt.attemptId !== row.id || row.runRef !== `manifest:${binding.preregHash}/attempt:${row.id}`) return false;
      if (attempt.armId !== binding.assignmentId) {
        // Other frozen assignments share this loop, but cannot borrow a native
        // request belonging to this assignment's host-owned source census.
        if (sessions.has(attempt.nativeSessionId) || messageSessions.has(note?.nativeGatewayAttemptResult?.providerCompletion?.responseId)) return false;
        continue;
      }
      const result = note.nativeGatewayAttemptResult as GatewayCarryTrialAttemptResult | undefined;
      if (!result || result.reservationRef !== row.id ||
          Object.entries(attempt).some(([key, value]) => result[key as keyof GatewayCarryTrialAttemptResult] !== value)) return false;
      if (result.outcome === 'send-refused') {
        if (result.costUsd !== 0 || result.costUsdMeasurementMissing !== false || result.responseStatus !== null ||
            row.status !== 'cancelled' || row.usedUsd !== 0) return false;
        continue;
      }
      if (result.outcome !== 'response-completed' || result.responseStatus < 200 || result.responseStatus >= 300 ||
          !/^[a-f0-9]{64}$/.test(result.responseSha256) || !Number.isSafeInteger(result.responseBytes) || result.responseBytes <= 0 ||
          !['bearer-http', 'oauth-http', 'anthropic-http'].includes(result.transport)) return false;
      const provider = result.providerCompletion, u = provider.usage;
      if (!provider.responseId || responses.has(provider.responseId) || u.inputTokenBasis !== 'inclusive' ||
          ![u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens].every(n =>
            typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ||
          u.cacheReadTokens! + u.cacheCreationTokens! > u.inputTokens) return false;
      responses.add(provider.responseId);
      const claude = result.transport === 'anthropic-http';
      const session = claude ? messageSessions.get(provider.responseId) : result.nativeSessionId;
      const request = claude ? provider.responseId : result.nativeTurnId;
      // Anthropic's message id is measured from the response and closed source.
      // Its transport carries no caller-supplied native session or turn identity.
      if (!session || !request || !sessions.has(session) || claude &&
          (result.nativeSessionId !== undefined || result.nativeTurnId !== undefined)) return false;
      const key = signature(claude ? 'claude' : 'codex', session, request, provider.model,
        u.inputTokens, u.outputTokens, u.cacheReadTokens!, u.cacheCreationTokens!);
      const matches = expected.get(key);
      // Token equality cannot distinguish two native requests with the same
      // signature. Refuse rather than assigning a provider ID arbitrarily.
      if (matches?.length !== 1) return false;
      expected.delete(key);
    }
    return keys.size > 0 && expected.size === 0;
  } catch { return false; }
}

export interface CurrentBenchNativeCostReaderPorts {
  readParticipants(): Promise<NativeCostParticipant[]>;
  readRuntime(participant: NativeCostParticipant): Promise<{ complete: boolean; sessions: readonly { nativeSessionId: string; usage: ClosedNativeSessionUsage }[] }>;
  readBilled(participant: NativeCostParticipant, nativeSessionId: string, usage: NativeSourceUsage): Promise<NativeBillPopulation>;
  /** Full source-bound gateway attempt reconciliation is separate from a native
   * transcript census. Omission keeps efficiency claims closed. */
  readAttemptAccountingComplete?(population: NativeAccountingPopulation): Promise<boolean>;
}

export interface CurrentBenchNativeSessionCost {
  nativeSessionId: string; sourceSha256: string; sourceComplete: boolean;
  usageEventKeys: string[]; nativeTurnIds: string[];
  /** Claude request identities are provider messages, never synthetic turns. */
  agent?: 'claude'; nativeMessageIds?: string[];
  /** Uncached input; cache tokens remain separate, as in BenchRunCost. */
  tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheWrite: number; turns: number;
  normalizedCostUsd: number; billedKnownSubtotalUsd: number | null; billedCostUsd: number | null;
}
export interface CurrentBenchNativeCostAccounting {
  basis: 'frozen-normalized-native-source'; priceTableVersion: string;
  /** Canonical frozen protocol content id, shared with the request census binding. */
  preregHash: string;
  normalizedCostUsd: number; billedKnownSubtotalUsd: number; billedCostUsd: number | null;
  sourceCensusComplete: boolean; attemptAccountingComplete: boolean; missingSources: number; missingBills: number;
  participantTaskIds: string[]; sources: CurrentBenchNativeSessionCost[];
  taskLedgerConcurrency?: Record<string, unknown>;
}
export interface CurrentBenchNativeRunCost extends BenchRunCost {
  armMeta: { nativeCostAccounting: CurrentBenchNativeCostAccounting };
}

/** Validate complete cumulative native receipts before reusing their spend. */
export function requireCurrentBenchNativeRunCost(input: unknown): CurrentBenchNativeRunCost {
  const invalid = () => new Error('Fresh native session usage is incomplete, reused or non-monotone.');
  if (!input || typeof input !== 'object') throw invalid();
  const cost = input as CurrentBenchNativeRunCost;
    const a = cost.armMeta?.nativeCostAccounting;
    const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
    const sameMoney = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, a, b);
    if (cost.costUsdMeasurementMissing !== false || !a || a.basis !== 'frozen-normalized-native-source' ||
        !a.sourceCensusComplete || !a.attemptAccountingComplete || a.missingSources !== 0 || a.missingBills !== 0 ||
        !a.priceTableVersion || !/^[a-f0-9]{64}$/.test(a.preregHash) || !money(a.billedCostUsd) || !money(a.billedKnownSubtotalUsd) ||
        !money(a.normalizedCostUsd) || !hasValidBenchRunCost(cost) || !Array.isArray(a.sources) || !a.sources.length) throw invalid();
    const ids = new Set<string>(), events = new Set<string>();
    for (const s of a.sources) {
      if (!s.nativeSessionId || ids.has(s.nativeSessionId) || !s.sourceComplete || !/^[a-f0-9]{64}$/.test(s.sourceSha256) ||
          !Array.isArray(s.usageEventKeys) || !s.usageEventKeys.length ||
          s.usageEventKeys.some(key => typeof key !== 'string' || !key || events.has(key)) ||
          new Set(s.usageEventKeys).size !== s.usageEventKeys.length || !Array.isArray(s.nativeTurnIds) ||
          (s.agent === 'claude' ? s.nativeTurnIds.length !== 0 || !Array.isArray(s.nativeMessageIds) ||
            !s.nativeMessageIds.length || s.nativeMessageIds.some(id => typeof id !== 'string' || !id) ||
            new Set(s.nativeMessageIds).size !== s.nativeMessageIds.length || s.turns !== s.nativeMessageIds.length ||
            s.usageEventKeys.length !== s.nativeMessageIds.length
          : s.agent !== undefined || s.nativeMessageIds !== undefined || !s.nativeTurnIds.length ||
            s.nativeTurnIds.some(id => typeof id !== 'string' || !id) ||
            new Set(s.nativeTurnIds).size !== s.nativeTurnIds.length || s.turns !== s.nativeTurnIds.length) ||
          ![s.tokensIn, s.tokensOut, s.tokensCacheRead, s.tokensCacheWrite, s.turns].every(count) ||
          !money(s.normalizedCostUsd) || !money(s.billedCostUsd) || s.billedCostUsd !== s.billedKnownSubtotalUsd) throw invalid();
      ids.add(s.nativeSessionId); for (const key of s.usageEventKeys) events.add(key);
    }
    for (const key of ['tokensIn', 'tokensOut', 'tokensCacheRead', 'tokensCacheWrite', 'turns'] as const) {
      const total = a.sources.reduce((sum, s) => sum + s[key], 0);
      if (!count(total) || total !== (cost[key] ?? 0)) throw invalid();
    }
    const normalized = a.sources.reduce((sum, s) => sum + s.normalizedCostUsd, 0);
    const billed = a.sources.reduce((sum, s) => sum + s.billedCostUsd!, 0);
    if (!money(normalized) || !money(billed) || !sameMoney(normalized, cost.costUsd) ||
        !sameMoney(normalized, a.normalizedCostUsd) || !sameMoney(billed, a.billedCostUsd) ||
        !sameMoney(billed, a.billedKnownSubtotalUsd)) throw invalid();
    return cost;
}

/** Select exactly one new session without changing any earlier source receipt. */
export function currentBenchNativeSessionCostDelta(before: CurrentBenchNativeRunCost | null,
  after: CurrentBenchNativeRunCost, nativeSessionId: string): CurrentBenchNativeSessionCost {
  const invalid = () => new Error('Fresh native session usage is incomplete, reused or non-monotone.');
  const current = requireCurrentBenchNativeRunCost(after).armMeta.nativeCostAccounting;
  const previous = before ? requireCurrentBenchNativeRunCost(before).armMeta.nativeCostAccounting : null;
  if (!nativeSessionId || previous && (previous.priceTableVersion !== current.priceTableVersion ||
      previous.preregHash !== current.preregHash)) throw invalid();
  const old = new Map(previous?.sources.map(s => [s.nativeSessionId, s]) ?? []);
  if (old.has(nativeSessionId) || [...old].some(([id, source]) =>
    canonicalJson(current.sources.find(s => s.nativeSessionId === id) ?? null) !== canonicalJson(source))) throw invalid();
  const added = current.sources.filter(s => !old.has(s.nativeSessionId));
  if (added.length !== 1 || added[0].nativeSessionId !== nativeSessionId) throw invalid();
  return structuredClone(added[0]);
}

/** A fresh session may add only its own requests. Earlier reservations must
 * remain present and retain their native identity, including incomplete sends.
 * Ledger settlement may change between reads; request identity may not. */
export function currentBenchSessionRequestDelta(before: CurrentBenchTaskRequestCensus,
  after: CurrentBenchTaskRequestCensus, nativeSessionId: string): { modelCalls: number; reservationIds: string[] } {
  const invalid = () => new Error('Fresh native session request census is foreign, reused or non-monotone.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeSessionId) ||
      canonicalJson(before.binding) !== canonicalJson(after.binding) ||
      [...before.requests, ...after.requests].some(row => row.agent === 'claude')) throw invalid();
  const previous = new Map(before.requests.map(row => [row.reservationId, row]));
  const current = new Map(after.requests.map(row => [row.reservationId, row]));
  if (previous.size !== before.requests.length || current.size !== after.requests.length ||
      before.requests.some(row => row.nativeSessionId === nativeSessionId ||
        canonicalJson(current.get(row.reservationId) ?? null) !== canonicalJson(row))) throw invalid();
  const added = after.requests.filter(row => !previous.has(row.reservationId));
  if (added.some(row => row.nativeSessionId !== nativeSessionId)) throw invalid();
  return { modelCalls: added.length, reservationIds: added.map(row => row.reservationId).sort() };
}

/** Pair one closed source receipt with exactly its new assignment requests.
 * Returns uncached/cache tokens and normalized/billed dollars separately.
 * An empty initial source snapshot is accepted only with an empty request census.
 * This receipt measures usage; it does not issue a remaining session allowance.
 */
export function currentBenchSessionUsageDelta(input: {
  before: CurrentBenchTaskRequestCensus; after: CurrentBenchTaskRequestCensus;
  beforeCost: CurrentBenchNativeRunCost | null; afterCost: CurrentBenchNativeRunCost; nativeSessionId: string;
}) {
  const { before, after, beforeCost, afterCost, nativeSessionId } = input;
  const invalid = () => new Error('Fresh native session usage differs from its complete assignment request census.');
  const delta = currentBenchSessionRequestDelta(before, after, nativeSessionId);
  const source = currentBenchNativeSessionCostDelta(beforeCost, afterCost, nativeSessionId);
  const matches = (census: CurrentBenchTaskRequestCensus, cost: CurrentBenchNativeRunCost | null) => {
    if (!cost) return census.requests.length === 0;
    if (cost.armMeta.nativeCostAccounting.preregHash !== census.binding.preregHash) return false;
    const sources = cost.armMeta.nativeCostAccounting.sources;
    const ids = new Set(sources.map(s => s.nativeSessionId));
    if (census.requests.some(row => row.agent === 'claude' || !ids.has(row.nativeSessionId))) return false;
    return sources.every(s => {
      const rows = census.requests.filter(row => row.nativeSessionId === s.nativeSessionId);
      const turns = [...new Set(rows.map(row => row.nativeTurnId))].sort();
      return rows.length === s.usageEventKeys.length && canonicalJson(turns) === canonicalJson([...s.nativeTurnIds].sort());
    });
  };
  if (!matches(before, beforeCost) || !matches(after, afterCost)) throw invalid();
  return { ...source, ...delta };
}

/** Reuses native source proofs and frozen pricing. Actual provider cost stays
 * separately labelled; neither SQL estimates nor the normalized sum are bills. */
export function currentBenchNativeCostReader(protocolInput: CurrentBenchmarkProtocol, ports: CurrentBenchNativeCostReaderPorts): () => Promise<CurrentBenchNativeRunCost> {
  const protocol = currentBenchmarkProtocolSchema.parse(protocolInput);
  const io = { ...ports };
  return async () => {
    const result: BenchRunCost = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, turns: 0 };
    const participants = await io.readParticipants();
    let complete = participants.length > 0 && participants.length < 1000;
    const ids = new Set<string>(), bindings = new Set<string>(), homes = new Map<string, string>(), eventKeys = new Set<string>(), nativeSessions = new Set<string>();
    const sources: CurrentBenchNativeSessionCost[] = [];
    const accountingSources: NativeAccountingSource[] = [];
    let missingSources = 0, missingBills = 0, billedKnownSubtotalUsd = 0;
    for (const participant of participants) {
      const home = nativeCostHome(participant), homeKey = canonicalJson([participant.agent ?? 'codex', home]);
      const binding = canonicalJson([participant.taskId, participant.ownerId, homeKey]);
      if (!participant.taskId || !participant.ownerId || !home || bindings.has(binding)) {
        complete = false; missingSources++; continue;
      }
      ids.add(participant.taskId); bindings.add(binding);
      if (!participant.terminal) complete = false;
      // Recovery tasks can share one exact host home; its full source census is
      // charged once rather than once per task-ledger row.
      if (homes.has(homeKey)) {
        if (homes.get(homeKey) !== participant.ownerId) { complete = false; missingSources++; }
        continue;
      }
      homes.set(homeKey, participant.ownerId);
      const runtime = await io.readRuntime(participant).catch(() => ({ complete: false, sessions: [] }));
      if (!runtime.complete || !runtime.sessions.length) complete = false;
      if (!runtime.sessions.length) missingSources++;
      for (const source of runtime.sessions) {
        if (nativeSessions.has(source.nativeSessionId)) { missingSources++; complete = false; continue; }
        nativeSessions.add(source.nativeSessionId);
        if (!source.usage.ok) { missingSources++; complete = false; if (!source.usage.knownSubtotal) continue; }
        const usage = source.usage.ok ? source.usage : source.usage.knownSubtotal!;
        if ((participant.agent === 'claude') !== ('nativeMessageIds' in usage)) {
          missingSources++; complete = false; continue;
        }
        if (usage.events.some(event => eventKeys.has(event.usageEventKey)) ||
            new Set(usage.events.map(event => event.usageEventKey)).size !== usage.events.length) {
          missingSources++; complete = false; continue;
        }
        let priced = 0;
        try {
          const table = currentProtocolPriceTable(protocol, usage.events.map(event => ({ modelId: event.model, tokensCacheWrite: event.usage.cacheCreationTokens })));
          for (const event of usage.events) priced += priceRun({ tokensIn: event.usage.inputTokens, tokensOut: event.usage.outputTokens,
            tokensCacheRead: event.usage.cacheReadTokens, tokensCacheWrite: event.usage.cacheCreationTokens }, event.model, table);
        } catch { missingSources++; complete = false; continue; }
        const requests = 'nativeMessageIds' in usage ? usage.nativeMessageIds : usage.nativeTurnIds;
        const session: CurrentBenchNativeSessionCost = { nativeSessionId: source.nativeSessionId, sourceSha256: usage.sourceSha256,
          sourceComplete: source.usage.ok, usageEventKeys: usage.events.map(event => event.usageEventKey),
          ...('nativeMessageIds' in usage ? { agent: 'claude' as const, nativeMessageIds: [...requests], nativeTurnIds: [] }
            : { nativeTurnIds: [...requests] }), tokensIn: 0, tokensOut: 0, tokensCacheRead: 0,
          tokensCacheWrite: 0, turns: requests.length, normalizedCostUsd: priced,
          billedKnownSubtotalUsd: null as number | null, billedCostUsd: null as number | null };
        for (const event of usage.events) {
          eventKeys.add(event.usageEventKey); result.tokensIn += event.usage.inputTokens; result.tokensOut += event.usage.outputTokens;
          result.tokensCacheRead! += event.usage.cacheReadTokens; result.tokensCacheWrite! += event.usage.cacheCreationTokens;
          session.tokensIn += event.usage.inputTokens; session.tokensOut += event.usage.outputTokens;
          session.tokensCacheRead += event.usage.cacheReadTokens; session.tokensCacheWrite += event.usage.cacheCreationTokens;
        }
        result.turns += requests.length; result.costUsd += priced;
        sources.push(session);
        const billed = await io.readBilled(participant, source.nativeSessionId, usage).catch(() => ({ knownSubtotalUsd: 0, complete: false }));
        if (source.usage.ok) accountingSources.push({ participant, nativeSessionId: source.nativeSessionId, usage,
          billed: { ...billed, ...('samples' in billed && billed.samples ? { samples: billed.samples.map(sample => ({ ...sample })) } : {}) } });
        if (!Number.isFinite(billed.knownSubtotalUsd) || billed.knownSubtotalUsd < 0) missingBills++;
        else {
          session.billedKnownSubtotalUsd = billed.knownSubtotalUsd;
          if (source.usage.ok && billed.complete) session.billedCostUsd = billed.knownSubtotalUsd;
          billedKnownSubtotalUsd += billed.knownSubtotalUsd; if (!billed.complete) missingBills++;
        }
      }
    }
    let participantCensusStable = canonicalJson(participants) === canonicalJson(await io.readParticipants());
    if (!participantCensusStable) complete = false;
    const attemptsComplete = complete && !missingSources &&
      (await io.readAttemptAccountingComplete?.({ participants, sources: accountingSources }).catch(() => false) ?? false);
    participantCensusStable = participantCensusStable && canonicalJson(participants) === canonicalJson(await io.readParticipants());
    if (!participantCensusStable) complete = false;
    const missingTimingTaskIds = participants.filter(p => !p.terminal || p.startedAtMs == null || p.endedAtMs == null ||
      !Number.isSafeInteger(p.startedAtMs) || p.startedAtMs < 0 || !Number.isSafeInteger(p.endedAtMs) ||
      p.endedAtMs < p.startedAtMs).map(p => p.taskId);
    const timing = participantCensusStable && participants.length < 1000 &&
      new Set(participants.map(p => p.taskId)).size === participants.length && !missingTimingTaskIds.length
      ? concurrencyTimelineFromIntervals(participants.map(p => ({ startedAtMs: p.startedAtMs!, endedAtMs: p.endedAtMs! }))) : null;
    result.costUsdMeasurementMissing = !complete || missingSources > 0 || missingBills > 0 || !attemptsComplete;
    // Fresh-session controls consume these source-bound rows, never subtract
    // two cumulative agent totals. A partial census or unreconciled attempt
    // population cannot certify even one session's bill as complete.
    if (result.costUsdMeasurementMissing) for (const source of sources) source.billedCostUsd = null;
    return { ...result, armMeta: { nativeCostAccounting: { basis: 'frozen-normalized-native-source', priceTableVersion: protocol.priceSchedule.version,
      preregHash: createHash('sha256').update(canonicalJson(protocol)).digest('hex'),
      normalizedCostUsd: result.costUsd, billedKnownSubtotalUsd,
      billedCostUsd: complete && !missingBills && attemptsComplete ? billedKnownSubtotalUsd : null,
      sourceCensusComplete: complete, attemptAccountingComplete: attemptsComplete, missingSources, missingBills,
      participantTaskIds: [...ids].sort(), sources,
      // task_ledger.started_at is enrollment, not a provider-send or CPU timestamp.
      // Missing/live/changed intervals cannot establish zero time or concurrency.
      taskLedgerConcurrency: { basis: 'task-ledger-lifetime', averageBasis: 'time-weighted', complete: timing !== null,
        participantCensusStable, missingTimingTaskIds,
        startedAtMs: timing?.startedAtMs ?? null, endedAtMs: timing?.endedAtMs ?? null,
        wallClockMs: timing?.wallClockMs ?? null, participantWallClockMs: timing?.participantWallClockMs ?? null,
        concurrencyTimeline: timing?.concurrencyTimeline ?? null } } } };
  };
}

/** Bind the maintained native source reader to the complete task subtree and
 * host-allocated homes. No task argument may supply a transcript path or bill.
 * Gateway attempt reconciliation requires the exact host controller binding. */
export function liveCurrentBenchNativeCostReader(handle: BenchHarnessHandle,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration'>, db: Pick<DbScope, 'sql'> = {},
  accounting?: CurrentBenchAccountingBinding): () => Promise<BenchRunCost> {
  const workspaceId = resolveBenchWorkspace(opts.workspaceId);
  const protocol = currentBenchmarkProtocolSchema.parse(opts.preregistration.config);
  if (protocol.runId !== opts.runId) throw new Error('Native accounting protocol/run binding mismatch.');
  const binding = accounting ? Object.freeze({ ...accounting }) : undefined;
  const allowedAssignments = protocol.arms.flatMap(arm => protocol.taskIds.flatMap(taskId =>
    protocol.seeds.map(seed => currentBenchAssignmentId(protocol.runId, arm.id, taskId, seed))));
  if (binding && (binding.workspaceId !== workspaceId || binding.runId !== opts.runId ||
      binding.preregHash !== opts.preregistration.preregHash || !binding.loopId.trim() ||
      !allowedAssignments.includes(binding.assignmentId))) throw new Error('Native accounting requires its exact frozen controller binding.');
  const labelPrefix = attemptLabel(opts.runId, handle);
  const io: CurrentBenchNativeCostReaderPorts = {
    async readParticipants() {
      const { resolveDb } = await import('./reproducibility/db');
      const { codexHomeForSessionKey, sessionClaudeConfigDir } = await import('@papercusp/orchestrator/session-launch-dirs');
      const { sql } = resolveDb({ ...db, workspaceId });
      const rows = await sql<{ task_id: string; state: string; owner_id: string | null; adv_id: number | null; agent: string | null;
        started_at: Date | string; ended_at: Date | string | null }[]>`
        WITH RECURSIVE participants AS (
          SELECT task_id FROM harness_shared.task_ledger
           WHERE workspace_id = ${workspaceId} AND starts_with(detail->>'label', ${labelPrefix})
          UNION
          SELECT child.task_id FROM harness_shared.task_ledger child JOIN participants parent
            ON child.parent_task_id = parent.task_id WHERE child.workspace_id = ${workspaceId}
        )
        SELECT t.task_id, t.state, t.detail->>'coordOwnerId' AS owner_id, a.id AS adv_id, a.agent, t.started_at, t.ended_at
          FROM participants p JOIN harness_shared.task_ledger t ON t.workspace_id = ${workspaceId} AND t.task_id = p.task_id
          LEFT JOIN harness_shared.adv_sessions a ON a.workspace_id = t.workspace_id AND a.coord_owner_id = t.detail->>'coordOwnerId'
         WHERE t.class = 'agent-session' ORDER BY t.task_id, a.id LIMIT 1001`;
      return rows.map(row => ({ taskId: row.task_id, ownerId: row.owner_id ?? '',
        ...(row.agent === 'claude' && row.owner_id && row.adv_id != null
          ? { agent: 'claude' as const, claudeConfigDir: sessionClaudeConfigDir(row.owner_id) }
          : { codexHome: row.agent === 'codex' && row.adv_id != null ? codexHomeForSessionKey(row.adv_id) : '' }),
        terminal: ['exited', 'killed', 'timed_out'].includes(row.state),
        startedAtMs: new Date(row.started_at).getTime(), endedAtMs: row.ended_at == null ? null : new Date(row.ended_at).getTime() }));
    },
    async readRuntime(participant) {
      const { resolveDb } = await import('./reproducibility/db');
      const { readClosedCodexRuntimeUsage, readClosedClaudeRuntimeUsage } = await import('../session-transcript-resolvers');
      const { sql } = resolveDb({ ...db, workspaceId });
      return participant.agent === 'claude'
        ? readClosedClaudeRuntimeUsage(sql, { workspaceId, claudeConfigDir: nativeCostHome(participant) })
        : readClosedCodexRuntimeUsage(sql, { workspaceId, codexHome: nativeCostHome(participant) });
    },
    async readBilled(participant, nativeSessionId, usage) {
      const { resolveDb } = await import('./reproducibility/db');
      const { readIdentityTurnBilledCost } = await import('../cupboard/shadow-metering-reader');
      const { sql } = resolveDb({ ...db, workspaceId });
      const rows = await sql<{ usage_event_key: string; native_turn_id: string | null; native_message_id: string | null; session_id: string | null;
        owner_id: string | null; principal_id: string | null; specification_revision: string | null; state_revision: string | null }[]>`
        SELECT u.usage_event_key, u.usage_provenance->>'turnId' AS native_turn_id,
          u.usage_provenance->>'providerResponseId' AS native_message_id, a.session_id,
          a.identity_owner_id AS owner_id, a.identity_principal_id AS principal_id,
          a.identity_specification_revision AS specification_revision, a.identity_state_revision AS state_revision
        FROM harness_shared.agent_usage_samples u JOIN harness_shared.agent_usage_samples_identity_attribution a
          ON a.workspace_id = u.workspace_id AND a.id = u.id
        WHERE u.workspace_id = ${workspaceId} AND u.usage_event_key = ANY(${[...usage.usageEventKeys]}::text[])`;
      let complete = rows.length === usage.usageEventKeys.length, knownSubtotalUsd = 0;
      const samples: NonNullable<NativeBillPopulation['samples']>[number][] = [];
      const claude = 'nativeMessageIds' in usage;
      for (const requestId of claude ? usage.nativeMessageIds : usage.nativeTurnIds) {
        const expected = usage.events.filter(event => (claude ? event.providerResponseId : event.turnId) === requestId)
          .map(event => event.usageEventKey).sort();
        if (!expected.length) continue;
        const group = rows.filter(row => (claude ? row.native_message_id : row.native_turn_id) === requestId), first = group[0];
        if (!first?.principal_id || !first.specification_revision || !first.state_revision ||
            canonicalJson(group.map(row => row.usage_event_key).sort()) !== canonicalJson(expected) ||
            group.some(row => row.session_id !== nativeSessionId || row.owner_id !== participant.ownerId ||
              row.principal_id !== first.principal_id || row.specification_revision !== first.specification_revision || row.state_revision !== first.state_revision)) {
          complete = false; continue;
        }
        // The full native source supplies this event population; the second
        // runtime read below brackets it before settlement. A partial source
        // may retain its earlier closed subtotal but cannot enter settlement.
        const identity = { workspaceId, ownerId: participant.ownerId, nativeSessionId,
          principalId: first.principal_id, specificationRevision: first.specification_revision,
          stateRevision: first.state_revision, usageEventKeys: expected };
        const cost = claude ? await readIdentityTurnBilledCost(sql, { ...identity, nativeMessageId: requestId })
          : await readIdentityTurnBilledCost(sql, { ...identity, nativeTurnId: requestId });
        if (!cost.ok || cost.billedInferenceMicros > BigInt(Number.MAX_SAFE_INTEGER)) { complete = false; continue; }
        knownSubtotalUsd += Number(cost.billedInferenceMicros) / 1_000_000;
        samples.push(...cost.samples);
      }
      return { knownSubtotalUsd, complete, samples };
    },
    ...(binding ? { async readAttemptAccountingComplete(population: NativeAccountingPopulation) {
      const { resolveDb } = await import('./reproducibility/db');
      const { getLearningSpendPositions, settleLearningSpend } = await import('../learning-governor/store');
      const { sql } = resolveDb({ ...db, workspaceId });
      const query = { workspaceId, loopId: binding.loopId, includeReservations: true };
      const before = (await getLearningSpendPositions(sql, query)).census;
      if (!before || before.status !== 'complete') return false;
      // Re-read every host runtime while the reservation population is bracketed.
      // A changed carry file, new request or failed native frontier invalidates
      // an earlier token snapshot even when task identities remain unchanged.
      const homeKey = (p: NativeCostParticipant) => canonicalJson([p.agent ?? 'codex', nativeCostHome(p)]);
      for (const home of new Set(population.participants.map(homeKey))) {
        const participant = population.participants.find(p => homeKey(p) === home)!;
        const current = await io.readRuntime(participant);
        const expected = population.sources.filter(s => homeKey(s.participant) === home)
          .map(s => [s.nativeSessionId, s.usage.sourceSha256]).sort();
        if (!current.complete || current.sessions.some(s => !s.usage.ok) ||
            canonicalJson(current.sessions.map(s => [s.nativeSessionId, s.usage.ok ? s.usage.sourceSha256 : null]).sort()) !==
              canonicalJson(expected)) return false;
      }
      const after = (await getLearningSpendPositions(sql, query)).census;
      if (!after || !currentBenchAttemptPopulationMatches(binding, population, before, after)) return false;
      // Token reconciliation alone grants no settlement. Unknown/partial bills
      // keep every reservation open and remain explicit in the result above.
      if (population.sources.some(source => !source.billed?.complete || !source.billed.samples)) return true;
      const bills = new Map<string, { source: NativeAccountingSource; sample: NonNullable<NativeBillPopulation['samples']>[number] }>();
      for (const source of population.sources) {
        for (const sample of source.billed!.samples!) {
          if (bills.has(sample.usageEventKey) || !sample.sampleId || !sample.activationEventId ||
              !/^(0|[1-9][0-9]*)$/.test(sample.billedInferenceMicros ?? '') ||
              BigInt(sample.billedInferenceMicros!) > BigInt(Number.MAX_SAFE_INTEGER)) return false;
          bills.set(sample.usageEventKey, { source, sample });
        }
      }
      if (canonicalJson(await io.readParticipants()) !== canonicalJson(population.participants)) return false;
      const settlements: { row: typeof before.reservations[number]; usedUsd: number; proof: Record<string, string> }[] = [];
      for (const row of before.reservations) {
        const note = JSON.parse(row.note!), result = note.nativeGatewayAttemptResult as GatewayCarryTrialAttemptResult | undefined;
        if (note.nativeGatewayAttempt.armId !== binding.assignmentId || result?.outcome === 'send-refused') continue;
        if (result?.outcome !== 'response-completed') return false;
        const claude = result.transport === 'anthropic-http';
        const source = population.sources.find(source => claude
          ? source.participant.agent === 'claude' && 'nativeMessageIds' in source.usage &&
            source.usage.nativeMessageIds.includes(result.providerCompletion.responseId)
          : source.participant.agent !== 'claude' && source.nativeSessionId === result.nativeSessionId);
        const u = result.providerCompletion.usage;
        const event = source?.usage.events.find(event => (claude
          ? event.providerResponseId === result.providerCompletion.responseId : event.turnId === result.nativeTurnId) &&
          event.model === result.providerCompletion.model && event.inputTotalTokens === u.inputTokens &&
          event.usage.outputTokens === u.outputTokens && event.usage.cacheReadTokens === u.cacheReadTokens &&
          event.usage.cacheCreationTokens === u.cacheCreationTokens);
        const bill = event && bills.get(event.usageEventKey);
        if (!source || !bill || bill.source !== source) return false;
        bills.delete(event!.usageEventKey);
        const usedUsd = Number(BigInt(bill.sample.billedInferenceMicros!)) / 1_000_000;
        const proof = { ...bill.sample, billedInferenceMicros: bill.sample.billedInferenceMicros!,
          nativeSessionId: source.nativeSessionId, ...(claude ? { nativeMessageId: result.providerCompletion.responseId }
            : { nativeTurnId: result.nativeTurnId! }), sourceSha256: source.usage.sourceSha256 };
        if (row.status !== 'open' && (row.status !== 'settled' || row.usedUsd !== usedUsd ||
            canonicalJson(note.nativeGatewaySettlement) !== canonicalJson(proof))) return false;
        settlements.push({ row, usedUsd, proof });
      }
      if (bills.size) return false;
      for (const { row, usedUsd, proof } of settlements) {
        if (row.status !== 'open') continue;
        const settled = await settleLearningSpend(sql, { workspaceId, reservationId: row.id, disposition: 'used', usedUsd,
          expectedNoteSha256: createHash('sha256').update(row.note!).digest('hex'),
          note: JSON.stringify({ ...JSON.parse(row.note!), nativeGatewaySettlement: proof }) });
        if (!settled.ok && (settled.reason !== 'already-settled' || settled.reservation?.status !== 'settled' ||
            settled.reservation.usedUsd !== usedUsd ||
            canonicalJson(JSON.parse(settled.reservation.note ?? 'null')?.nativeGatewaySettlement) !== canonicalJson(proof))) return false;
      }
      // A newly arrived request remains exposure and closes the claim even if
      // earlier verified requests were settled successfully.
      const final = (await getLearningSpendPositions(sql, query)).census;
      return !!final && currentBenchAttemptPopulationMatches(binding, population, final, final);
    } } : {}),
  };
  return currentBenchNativeCostReader(protocol, io);
}

/** Stable assignment identity shared by every solver/reviewer/retry. It is an
 * extension of the existing governor arm resource key, never a new ledger. */
export function currentBenchAssignmentId(runId: string, armId: string, taskId: string, seed: number): string {
  if ([runId, armId, taskId].some(value => !value.trim()) || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('Benchmark budget requires an exact assignment identity.');
  }
  return `bench-assignment:${createHash('sha256').update(canonicalJson([runId, armId, taskId, seed])).digest('hex')}`;
}

type FrozenBenchRate = CurrentBenchmarkProtocol['priceSchedule']['rates'][number];

/** Reserve the full uncached/native input exposure, including the most
 * expensive frozen cache-write tier. Keep rounding in integer microUSD. */
function currentBenchRequestExposureUsd(rate: FrozenBenchRate, input: number, output: number, claude: boolean): number | null {
  const requiresCacheWritePrice = claude || openAiCacheGeneration(rate.model) === 'modern';
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output <= 0 ||
      requiresCacheWritePrice && rate.cacheWriteUsdPerMillion === undefined) return null;
  const inputRate = Math.ceil(Math.max(rate.inputUsdPerMillion, rate.cachedInputUsdPerMillion,
    rate.cacheWriteUsdPerMillion ?? 0) * 1_000_000);
  const outputRate = Math.ceil(rate.outputUsdPerMillion * 1_000_000);
  if (![inputRate, outputRate].every(Number.isSafeInteger)) return null;
  const micros = (BigInt(input) * BigInt(inputRate) + BigInt(output) * BigInt(outputRate) + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Math.max(1, Number(micros)) / 1_000_000;
}

/** A host-observed complete request bound, not configured client context. */
export interface CurrentBenchNativeInputCeiling {
  model: string;
  inputTokens: number;
  sourceSha256: string;
  validUntilMonotonicMs: number;
  validateAuthorization: () => void;
  evidence?: NativeGymProviderAuthorization['inputEvidence'];
}

/** The host passes the already authenticated final credential privately. It
 * must never enter a receipt, task argument, reservation note or exported run. */
interface CurrentBenchInputCredential { readonly secret: string }

const openAiCountFields = ['model', 'input', 'instructions', 'parallel_tool_calls', 'personality',
  'reasoning', 'text', 'tool_choice', 'tools', 'truncation'] as const;
const openAiGenerationFields = ['max_output_tokens', 'stream', 'store', 'include', 'metadata',
  'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'safety_identifier', 'user', 'service_tier', 'background'] as const;
const openAiCountTarget = 'https://api.openai.com/v1/responses/input_tokens';
const nativeMetadataAliases = { turn_id: 'turn_id', thread_id: 'thread_id', session_id: 'session_id',
  root_turn_id: 'root_turn_id', 'x-codex-installation-id': 'installation_id', 'x-codex-window-id': 'window_id' } as const;

/** The ChatGPT Codex backend that serves a subscription (oauth-http) arm. */
export const currentBenchCodexSubscriptionTarget = 'https://chatgpt.com/backend-api/codex/responses';

export type CurrentBenchPayer = 'api-key' | 'subscription';

/** benchmark-coverage-frontierswe-v2-2026-10-10#D-023. Omission is the original API key. */
export function currentBenchArmPayer(arm: { payer?: CurrentBenchPayer }): CurrentBenchPayer {
  return arm.payer ?? 'api-key';
}

/** The one Codex provider route a frozen payer basis may send through. */
export function currentBenchCodexRoute(payer: CurrentBenchPayer) {
  return payer === 'subscription'
    ? { transport: 'oauth-http', target: currentBenchCodexSubscriptionTarget, credentialHeader: 'authorization' } as const
    : { transport: 'bearer-http', target: 'https://api.openai.com/v1/responses', credentialHeader: 'authorization' } as const;
}

/** Freeze the subscription admission contract (D-023 consequence 3). The
 * ChatGPT backend rejects max_output_tokens and has no input-count endpoint, so
 * every request reserves the provider's own limits: the model context window
 * (which the provider enforces) plus the model maximum output, at frozen rates.
 * That is a larger per-request reservation than the API-key route, not a looser cap. */
export function currentBenchCodexSubscriptionContract(model: string, inputTokens: number, outputTokens: number): string {
  if (!model.trim() || ![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid subscription input contract.');
  }
  return createHash('sha256').update(canonicalJson({ version: 1, kind: 'provider-intrinsic-limit', payer: 'subscription',
    model, inputTokens, outputTokens, transport: 'oauth-http', target: currentBenchCodexSubscriptionTarget,
    outputField: 'omitted', settlement: 'provider-reported-usage-at-frozen-rates' })).digest('hex');
}

/** The admission contract a rate must carry for its payer basis, or null when
 * the rate lacks the frozen ceilings that basis needs. */
export function currentBenchRateContract(payer: CurrentBenchPayer, rate: FrozenBenchRate): string | null {
  if (rate.inputTokenCeiling === undefined) return null;
  if (payer === 'api-key') return currentBenchOpenAiInputContract(rate.model, rate.inputTokenCeiling);
  return rate.outputTokenCeiling === undefined ? null
    : currentBenchCodexSubscriptionContract(rate.model, rate.inputTokenCeiling, rate.outputTokenCeiling);
}

/** Freeze the maintained admission contract with the input cap. Its source is
 * the exact provider counting API plus the self-contained request restriction,
 * rather than a configured model window. Every send still needs a NEW measured
 * provider count of its final body; this hash alone grants no send authority.
 * https://developers.openai.com/api/docs/guides/token-counting */
export function currentBenchOpenAiInputContract(model: string, inputTokens: number): string {
  if (!model.trim() || !Number.isSafeInteger(inputTokens) || inputTokens <= 0) throw new Error('Invalid native input contract.');
  return createHash('sha256').update(canonicalJson({ version: 4, model, inputTokens,
    target: openAiCountTarget, fields: openAiCountFields, generationFields: openAiGenerationFields,
    input: 'self-contained-text-and-local-tools', localToolFormats: ['function', 'custom', 'namespace'],
    inlineToolType: 'additional_tools', promptCacheOptions: { ttl: '30m', modes: ['implicit', 'explicit'] },
    nativeMetadataAliases, discovery: { execution: 'client', items: ['tool_search_call', 'tool_search_output'] },
    tier: 'default' })).digest('hex');
}

/** Refuse mutable server/remote context and separately billed provider tools.
 * Counting and sending must refer to the same complete, immutable input. */
function selfContainedOpenAiInput(body: Record<string, unknown>): boolean {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (Object.keys(body).some(key => ![...openAiCountFields, ...openAiGenerationFields,
    'previous_response_id', 'conversation', 'client_metadata'].includes(key as never)) ||
    body.previous_response_id != null || body.conversation != null ||
    body.service_tier != null && body.service_tier !== 'default' || body.background === true) return false;
  if (body.client_metadata !== undefined) {
    if (!object(body.client_metadata) || readGatewayNativeCorrelation(body).status !== 'observed') return false;
    const metadata = body.client_metadata;
    const inner = JSON.parse(metadata['x-codex-turn-metadata'] as string) as Record<string, unknown>;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const window = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9]{1,10})?$/i;
    for (const [key, value] of Object.entries(metadata)) {
      if (key === 'x-codex-turn-metadata') continue;
      if (!Object.hasOwn(nativeMetadataAliases, key) || typeof value !== 'string' ||
          !(key === 'x-codex-window-id' ? window : uuid).test(value) ||
          value !== inner[nativeMetadataAliases[key as keyof typeof nativeMetadataAliases]]) return false;
    }
  }
  // Cache lifetime/mode affects cost, not counted input. The gateway's
  // maintained modern-model rewrite adds this field before admission.
  // Refuse prewarming, comparison requests and unknown options; reserve the
  // maximum frozen cache-write rate separately before a provider send.
  if (body.prompt_cache_options !== undefined && (!object(body.prompt_cache_options) ||
      body.prompt_cache_options.ttl !== '30m' || Object.keys(body.prompt_cache_options).some(key => !['ttl', 'mode'].includes(key)) ||
      body.prompt_cache_options.mode !== undefined && !['implicit', 'explicit'].includes(String(body.prompt_cache_options.mode)))) return false;
  const named = (tool: Record<string, unknown>) => typeof tool.name === 'string' && tool.name.trim().length > 0;
  const localTool = (tool: unknown) => object(tool) && named(tool) && ['function', 'custom'].includes(String(tool.type));
  // Native Responses-lite puts these definitions in developer input items.
  // Count those exact bytes, including code-executor guidance and schemas;
  // hosted tools remain excluded even inside a namespace.
  const localTools = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(tool =>
    localTool(tool) || object(tool) && tool.type === 'namespace' && named(tool) &&
      Array.isArray(tool.tools) && tool.tools.length > 0 && tool.tools.every(localTool));
  // Client search only discovers locally executed definitions. Count the
  // declaration, calls and returned schemas in full; server search and hosted
  // returned tools introduce context/cost outside this immutable request.
  // https://developers.openai.com/api/docs/guides/tools-tool-search
  const clientSearch = (tool: unknown) => object(tool) && tool.type === 'tool_search' && tool.execution === 'client' &&
    object(tool.parameters) && tool.parameters.type === 'object' &&
    (tool.description === undefined || typeof tool.description === 'string') &&
    Object.keys(tool).every(key => ['type', 'execution', 'description', 'parameters'].includes(key));
  if (body.tools !== undefined && (!Array.isArray(body.tools) ||
      !body.tools.every(tool => localTools([tool]) || clientSearch(tool)))) return false;
  const clientSearchItem = (item: Record<string, unknown>) => item.execution === 'client' &&
    typeof item.call_id === 'string' && item.call_id.trim().length > 0 && item.call_id.length <= 64 &&
    item.status === 'completed';
  const content = (value: unknown) => typeof value === 'string' || Array.isArray(value) && value.every(part =>
    object(part) && ['input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string');
  if (typeof body.input === 'string') return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.every(item => {
    if (!object(item)) return false;
    switch (item.type ?? 'message') {
      case 'message': return ['system', 'developer', 'user', 'assistant'].includes(String(item.role)) && content(item.content);
      case 'additional_tools': return item.role === 'developer' && localTools(item.tools);
      case 'tool_search_call': return clientSearchItem(item) && object(item.arguments);
      case 'tool_search_output': return clientSearchItem(item) && Array.isArray(item.tools) &&
        (item.tools.length === 0 || localTools(item.tools));
      case 'function_call': return typeof item.name === 'string' && typeof item.arguments === 'string' && typeof item.call_id === 'string';
      case 'custom_tool_call': return typeof item.name === 'string' && typeof item.input === 'string' && typeof item.call_id === 'string';
      case 'function_call_output': case 'custom_tool_call_output': return typeof item.call_id === 'string' && content(item.output);
      case 'reasoning': case 'compaction': return typeof item.encrypted_content === 'string';
      default: return false;
    }
  });
}

/** Use the actual authenticated provider API to count ALL native input, tools
 * and formatting before reserving the frozen cap. No local token estimator or
 * fallback catalog is consulted. Network errors and unsupported input refuse
 * generation. The IO port is for conventional offline tests; production uses
 * the official HTTPS target with redirects and automatic retries disabled. */
export function currentBenchOpenAiInputReader(input: { model: string; inputTokens: number },
  ports: { fetch: typeof globalThis.fetch } = { fetch: globalThis.fetch },
): { read: (attempt: GatewayCarryTrialAttempt, credential: CurrentBenchInputCredential) => Promise<CurrentBenchNativeInputCeiling | null>;
  revoke: () => void } {
  const { model, inputTokens } = input;
  const sourceSha256 = currentBenchOpenAiInputContract(model, inputTokens), send = ports.fetch;
  let live = true;
  return { revoke() { live = false; }, async read(value, credential) {
    const attempt = Object.freeze({ ...value }), secret = credential.secret;
    try {
      const body = JSON.parse(attempt.body);
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
          attempt.transport !== 'bearer-http' || attempt.target !== 'https://api.openai.com/v1/responses' ||
          attempt.credentialHeader !== 'authorization' || !secret ||
          attempt.credentialSha256 !== createHash('sha256').update(`Bearer ${secret}`).digest('hex') ||
          attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex') ||
          body.model !== model || !selfContainedOpenAiInput(body)) return null;
      const countedBody = Object.fromEntries(openAiCountFields.filter(key => key in body).map(key => [key, body[key]]));
      const countBody = JSON.stringify(countedBody);
      const response = await send(openAiCountTarget, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: countBody, signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(3000)]) });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); return null; }
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4096) { await reader.cancel(); return null; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const responseBytes = Buffer.concat(chunks), measured = JSON.parse(responseBytes.toString('utf8'));
      if (!live || attempt.signal.aborted || measured.object !== 'response.input_tokens' ||
          !Number.isSafeInteger(measured.input_tokens) || measured.input_tokens < 0 || measured.input_tokens > inputTokens) return null;
      const validUntilMonotonicMs = processMonotonicClock.now() + 5000;
      const requestId = response.headers.get('x-request-id');
      return { model, inputTokens, sourceSha256, validUntilMonotonicMs,
        evidence: Object.freeze({ kind: 'provider-input-count', sourceSha256, bodySha256: attempt.bodySha256,
          countBodySha256: createHash('sha256').update(countBody).digest('hex'),
          responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
          requestId: requestId !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : null,
          measuredInputTokens: measured.input_tokens }),
        validateAuthorization() {
          if (!live || attempt.signal.aborted || processMonotonicClock.now() >= validUntilMonotonicMs) {
            throw new Error('Provider-counted benchmark input authority expired or revoked.');
          }
        } };
    } catch { return null; }
  } };
}

const anthropicMessagesTarget = 'https://api.anthropic.com/v1/messages';
const anthropicModelsTarget = 'https://api.anthropic.com/v1/models/';
const anthropicInputVersion = '2023-06-01';

/** Reserve the complete provider-enforced window, never a token-count estimate.
 * Aliases, OAuth and context-changing betas are excluded. ModelInfo documents
 * max_input_tokens/max_tokens in the maintained provider SDK:
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts */
export function currentBenchAnthropicInputContract(model: string, inputTokens: number, outputTokens: number): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model) ||
      ![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid Anthropic input contract.');
  }
  return createHash('sha256').update(canonicalJson({ version: 1, kind: 'provider-model-limit',
    model, inputTokens, outputTokens, target: anthropicMessagesTarget, modelTarget: anthropicModelsTarget + model,
    anthropicVersion: anthropicInputVersion, anthropicBeta: null, credentialHeader: 'x-api-key',
    input: 'self-contained-text-and-local-tools', aliases: 'refused', hostedTools: 'refused' })).digest('hex');
}

function selfContainedAnthropicInput(body: Record<string, unknown>): boolean {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  const cache = (value: unknown) => value === undefined || object(value) && value.type === 'ephemeral' &&
    (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h') && keys(value, ['type', 'ttl']);
  const text = (value: unknown) => object(value) && value.type === 'text' && typeof value.text === 'string' &&
    cache(value.cache_control) && keys(value, ['type', 'text', 'cache_control']);
  const textContent = (value: unknown) => typeof value === 'string' || Array.isArray(value) && value.every(text);
  if (!keys(body, ['model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'metadata', 'stream',
    'temperature', 'top_p', 'top_k', 'stop_sequences', 'output_config', 'thinking', 'cache_control']) ||
      !cache(body.cache_control) || body.system !== undefined && !textContent(body.system) ||
      body.metadata !== undefined && (!object(body.metadata) || !keys(body.metadata, ['user_id']) ||
        typeof body.metadata.user_id !== 'string') ||
      body.output_config !== undefined && (!object(body.output_config) || !keys(body.output_config, ['effort'])) ||
      body.thinking !== undefined && (!object(body.thinking) || !keys(body.thinking, ['type', 'budget_tokens']) ||
        !['enabled', 'disabled', 'adaptive'].includes(String(body.thinking.type)))) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every(tool => object(tool) &&
      (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string' && !!tool.name.trim() &&
      object(tool.input_schema) && tool.input_schema.type === 'object' && cache(tool.cache_control) &&
      keys(tool, ['type', 'name', 'description', 'input_schema', 'cache_control', 'strict'])))) return false;
  if (body.tool_choice !== undefined && (!object(body.tool_choice) ||
      !['auto', 'any', 'none', 'tool'].includes(String(body.tool_choice.type)) ||
      !keys(body.tool_choice, ['type', 'name', 'disable_parallel_tool_use']))) return false;
  return Array.isArray(body.messages) && body.messages.length > 0 && body.messages.every(message =>
    object(message) && keys(message, ['role', 'content']) && ['user', 'assistant'].includes(String(message.role)) &&
    (textContent(message.content) || Array.isArray(message.content) && message.content.every(part => object(part) &&
      (text(part) || part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string' &&
        object(part.input) && cache(part.cache_control) && keys(part, ['type', 'id', 'name', 'input', 'cache_control']) ||
      part.type === 'tool_result' && typeof part.tool_use_id === 'string' && textContent(part.content) &&
        cache(part.cache_control) && keys(part, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']) ||
      part.type === 'thinking' && typeof part.thinking === 'string' && typeof part.signature === 'string' &&
        keys(part, ['type', 'thinking', 'signature']) ||
      part.type === 'redacted_thinking' && typeof part.data === 'string' && keys(part, ['type', 'data'])))));
}

/** Read fresh model limits with the final selected API key. Exact model ID,
 * version and credential are required; aliases and all beta headers refuse.
 * This metadata read never issues a generation or an estimated count request. */
export function currentBenchAnthropicInputReader(input: { model: string; inputTokens: number; outputTokens: number },
  ports: { fetch: typeof globalThis.fetch } = { fetch: globalThis.fetch },
): { read: (attempt: GatewayCarryTrialAttempt, credential: CurrentBenchInputCredential) => Promise<CurrentBenchNativeInputCeiling | null>;
  revoke: () => void } {
  const { model, inputTokens, outputTokens } = input, send = ports.fetch;
  const sourceSha256 = currentBenchAnthropicInputContract(model, inputTokens, outputTokens);
  let live = true;
  return { revoke() { live = false; }, async read(value, credential) {
    const attempt = Object.freeze({ ...value }), secret = credential.secret;
    try {
      const body = JSON.parse(attempt.body);
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
          attempt.transport !== 'anthropic-http' || attempt.target !== anthropicMessagesTarget ||
          attempt.credentialHeader !== 'x-api-key' || !secret ||
          attempt.credentialSha256 !== createHash('sha256').update(secret).digest('hex') ||
          attempt.anthropicVersion !== anthropicInputVersion || attempt.anthropicBeta !== null ||
          attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex') ||
          body.model !== model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0 ||
          body.max_tokens > outputTokens || !selfContainedAnthropicInput(body)) return null;
      const response = await send(anthropicModelsTarget + model, { method: 'GET', redirect: 'error',
        headers: { 'x-api-key': secret, 'anthropic-version': anthropicInputVersion, accept: 'application/json' },
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(3000)]) });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); return null; }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16_384) { await reader.cancel(); return null; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const responseBytes = Buffer.concat(chunks), measured = JSON.parse(responseBytes.toString('utf8'));
      if (!live || attempt.signal.aborted || measured.type !== 'model' || measured.id !== model ||
          measured.max_input_tokens !== inputTokens || measured.max_tokens !== outputTokens) return null;
      const validUntilMonotonicMs = processMonotonicClock.now() + 5000;
      const requestId = response.headers.get('request-id');
      return { model, inputTokens, sourceSha256, validUntilMonotonicMs,
        evidence: Object.freeze({ kind: 'provider-model-limit', sourceSha256, bodySha256: attempt.bodySha256,
          responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
          requestId: requestId !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : null,
          model, inputTokens, outputTokens, anthropicVersion: anthropicInputVersion }),
        validateAuthorization() {
          if (!live || attempt.signal.aborted || processMonotonicClock.now() >= validUntilMonotonicMs) {
            throw new Error('Anthropic benchmark input authority expired or revoked.');
          }
        } };
    } catch { return null; }
  } };
}

/** Subscription admission (D-023). There is no provider count and no output
 * field, so the bound is the frozen provider-intrinsic contract. It only accepts
 * the final ChatGPT backend body, and only when max_output_tokens is absent, so
 * a gateway that stopped stripping the field cannot inherit this reservation. */
export function currentBenchCodexSubscriptionInputReader(input: { model: string; inputTokens: number; outputTokens: number }): {
  read: (attempt: GatewayCarryTrialAttempt) => Promise<CurrentBenchNativeInputCeiling | null>; revoke: () => void } {
  const { model, inputTokens, outputTokens } = input;
  const sourceSha256 = currentBenchCodexSubscriptionContract(model, inputTokens, outputTokens);
  let live = true;
  return { revoke() { live = false; }, async read(value) {
    const attempt = Object.freeze({ ...value });
    try {
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
          attempt.transport !== 'oauth-http' || attempt.target !== currentBenchCodexSubscriptionTarget ||
          attempt.credentialHeader !== 'authorization' ||
          attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex')) return null;
      const body = JSON.parse(attempt.body);
      if (body.model !== model || body.max_output_tokens !== undefined || !selfContainedOpenAiInput(body)) return null;
      const validUntilMonotonicMs = processMonotonicClock.now() + 5000;
      return { model, inputTokens, sourceSha256, validUntilMonotonicMs,
        evidence: Object.freeze({ kind: 'provider-intrinsic-limit' as const, sourceSha256, bodySha256: attempt.bodySha256,
          inputTokens, outputTokens }),
        validateAuthorization() {
          if (!live || attempt.signal.aborted || processMonotonicClock.now() >= validUntilMonotonicMs) {
            throw new Error('Subscription benchmark input authority expired or revoked.');
          }
        } };
    } catch { return null; }
  } };
}

/** The ChatGPT access token a `codex-cli:<home>` account sends. The gateway's
 * OAuth proxy refreshes into the same auth.json, so this reads what it sends. */
function codexSubscriptionCredentialResolver(credentialRef: string): CredentialResolver {
  return { kind: 'file', authMode: 'oauth', invalidate() {}, async current() {
    const [{ parseCodexCliRef }, { readCodexAuth }] = await Promise.all([
      import('../inference-gateway/codex-cli-bridge'), import('../inference-gateway/codex-oauth-proxy')]);
    const home = parseCodexCliRef(credentialRef);
    const auth = home ? await readCodexAuth(home) : null;
    if (!auth?.accessToken) throw new Error('Codex subscription account has no ChatGPT access token.');
    return auth.accessToken;
  } };
}

/** Launch preflight: can this account pay a subscription arm right now? */
export async function currentBenchSupportsCodexSubscription(credentialRef: string): Promise<boolean> {
  if (!credentialRef.startsWith('codex-cli:')) return false;
  try { return !!await codexSubscriptionCredentialResolver(credentialRef).current(); } catch { return false; }
}

/** Reuse registered account and credential readers to authenticate the FINAL
 * payer. Never consult an ambient login or treat a caller bearer as a provider
 * credential. The complete native input ceiling is reserved per attempt. */
export function currentBenchProviderAuthenticator(input: {
  workspaceId: string; preregHash: string; protocol: CurrentBenchmarkProtocol;
  armId: string; taskId: string; seed: number;
  readNativeInputCeiling?: (attempt: GatewayCarryTrialAttempt, credential: CurrentBenchInputCredential) => Promise<CurrentBenchNativeInputCeiling | null>;
}, ports?: {
  readAccount: (workspaceId: string, accountId: string) => Promise<{ id: string; provider: 'claude' | 'codex'; credentialRef: string } | null>;
  credentialResolver: (provider: 'claude' | 'codex', ref: string) => CredentialResolver;
}): { authenticateProvider: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>; revoke: () => void } {
  const protocol = currentBenchmarkProtocolSchema.parse(input.protocol);
  const arm = protocol.arms.find(value => value.id === input.armId);
  if (!arm || !protocol.taskIds.includes(input.taskId) || !protocol.seeds.includes(input.seed) ||
      !/^[a-f0-9]{64}$/.test(input.preregHash) ||
      input.readNativeInputCeiling !== undefined && typeof input.readNativeInputCeiling !== 'function') {
    throw new Error('Benchmark provider authentication requires its frozen assignment and native input proof.');
  }
  resolveBenchWorkspace(input.workspaceId);
  const { workspaceId, preregHash } = input;
  const assignmentId = currentBenchAssignmentId(protocol.runId, arm.id, input.taskId, input.seed);
  const rate = protocol.priceSchedule.rates.find(value => value.model === arm.model)!;
  return createNativeProviderAuthenticator({ workspaceId, manifestSha256: preregHash, assignmentId,
    policy: arm, rate, readNativeInputCeiling: input.readNativeInputCeiling }, ports);
}

/** Shared final-provider authority for native operation and benchmark sends.
 * The host supplies a revision-pinned policy; no benchmark lifecycle is needed.
 * Account aliases, model price estimates and client token counts grant nothing. */
export function createNativeProviderAuthenticator(input: {
  workspaceId: string; manifestSha256: string; assignmentId: string;
  policy: Pick<CurrentBenchmarkProtocol['arms'][number],
    'agent' | 'account' | 'model' | 'effort' | 'payer'> & {
      generationBudget: { maxUsd: number; maxTokens?: number };
      runtime?: Pick<CurrentBenchmarkProtocol['arms'][number]['runtime'], 'proximus'>;
    };
  rate: FrozenBenchRate;
  readNativeInputCeiling?: (attempt: GatewayCarryTrialAttempt, credential: CurrentBenchInputCredential) => Promise<CurrentBenchNativeInputCeiling | null>;
}, ports?: {
  readAccount: (workspaceId: string, accountId: string) => Promise<{ id: string; provider: 'claude' | 'codex'; credentialRef: string } | null>;
  credentialResolver: (provider: 'claude' | 'codex', ref: string) => CredentialResolver;
}): { authenticateProvider: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>; revoke: () => void } {
  // Snapshot policy before any credential read or provider counting request.
  const { workspaceId, manifestSha256: preregHash, assignmentId } = input;
  const arm = structuredClone(input.policy), rate = structuredClone(input.rate);
  if (!workspaceId.trim() || !assignmentId.trim() || !/^[a-f0-9]{64}$/.test(preregHash) ||
      arm.model !== rate.model || !Number.isFinite(arm.generationBudget.maxUsd) || arm.generationBudget.maxUsd <= 0) {
    throw new Error('Native provider authentication requires a pinned policy and frozen price rate.');
  }
  const payer = currentBenchArmPayer(arm), subscription = payer === 'subscription';
  const providerAgent = currentBenchProviderAgent(arm);
  if (arm.agent === 'proximus' && subscription) throw new Error('Proximus supports only the API-key payer.');
  const route = providerAgent === 'claude' ? { transport: 'anthropic-http', target: 'https://api.anthropic.com/v1/messages' } as const
    : currentBenchCodexRoute(payer);
  const contract = providerAgent === 'codex' ? currentBenchRateContract(payer, rate) :
    !subscription && rate.inputTokenCeiling !== undefined && rate.outputTokenCeiling !== undefined
    ? currentBenchAnthropicInputContract(arm.model, rate.inputTokenCeiling, rate.outputTokenCeiling) : null;
  const providerReader = input.readNativeInputCeiling !== undefined || contract === null ||
    rate.inputTokenCeilingSourceSha256 !== contract ? null : providerAgent === 'claude'
    ? currentBenchAnthropicInputReader({ model: arm.model, inputTokens: rate.inputTokenCeiling!, outputTokens: rate.outputTokenCeiling! }) : subscription
    ? currentBenchCodexSubscriptionInputReader({ model: arm.model, inputTokens: rate.inputTokenCeiling!, outputTokens: rate.outputTokenCeiling! })
    : currentBenchOpenAiInputReader({ model: arm.model, inputTokens: rate.inputTokenCeiling! });
  const readNativeInputCeiling = input.readNativeInputCeiling ?? providerReader?.read;
  let live = true;
  return { revoke() { live = false; providerReader?.revoke(); }, async authenticateProvider(value) {
    const attempt = Object.freeze({ ...value });
    try {
      const claude = attempt.transport === 'anthropic-http';
      const provider = claude ? 'claude' : 'codex';
      // The payer basis fixes the one route: an API-key Codex arm cannot fall
      // back to a subscription, and a subscription arm never sends with a key.
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
          attempt.manifestSha256 !== preregHash || attempt.armId !== assignmentId ||
          attempt.transport !== route.transport || attempt.target !== route.target ||
          attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex') ||
          rate.inputTokenCeiling === undefined || rate.inputTokenCeilingSourceSha256 === undefined || !readNativeInputCeiling ||
          !['auto', 'default'].includes(arm.account) && attempt.accountId !== arm.account) return null;
      const body = JSON.parse(attempt.body);
      // The ChatGPT backend rejects max_output_tokens. The subscription bound is
      // the frozen model maximum, and a body still carrying the field is refused.
      const output = claude ? body.max_tokens : subscription
        ? (body.max_output_tokens === undefined ? rate.outputTokenCeiling : undefined) : body.max_output_tokens;
      if (body.model !== arm.model || (claude ? body.output_config?.effort : body.reasoning?.effort) !== arm.effort ||
          !Number.isSafeInteger(output) || output <= 0 ||
          arm.generationBudget.maxTokens !== undefined && output > arm.generationBudget.maxTokens) return null;
      const readAccount = ports?.readAccount ?? (async (workspace: string, id: string) => {
        const [{ loadAccountPool }, { accountProvider }] = await Promise.all([
          import('../deployment/account-pool-store'), import('../deployment/account-pool')]);
        const account = (await loadAccountPool(workspace)).accounts.find(value => value.id === id);
        return account ? { id: account.id, provider: accountProvider(account), credentialRef: account.credentialRef } : null;
      });
      const account = await readAccount(workspaceId, attempt.accountId);
      if (!account || account.id !== attempt.accountId || account.provider !== provider || !account.credentialRef.trim() ||
          subscription !== account.credentialRef.startsWith('codex-cli:')) return null;
      const snapshot = Object.freeze({ ...account });
      const resolver = ports ? ports.credentialResolver(provider, snapshot.credentialRef) : await (async () => {
        if (subscription) return codexSubscriptionCredentialResolver(snapshot.credentialRef);
        const credentials = await import('../inference-gateway/credential-store');
        return claude ? credentials.makeCredentialResolver(snapshot.credentialRef) :
          credentials.makeBearerCredentialResolver(snapshot.credentialRef);
      })();
      const credentialHeader = claude && resolver.authMode === 'api-key' ? 'x-api-key' : 'authorization';
      const secret = await resolver.current();
      if (!secret || attempt.credentialHeader !== credentialHeader ||
          attempt.credentialSha256 !== createHash('sha256').update(credentialHeader === 'authorization' ? `Bearer ${secret}` : secret).digest('hex')) return null;
      const supplied = await readNativeInputCeiling(attempt, { secret });
      const ceiling = supplied ? Object.freeze({ ...supplied }) : null;
      const current = await readAccount(workspaceId, attempt.accountId);
      if (!live || attempt.signal.aborted || !current || canonicalJson(current) !== canonicalJson(snapshot) ||
          !ceiling || ceiling.model !== arm.model || ceiling.inputTokens !== rate.inputTokenCeiling ||
          ceiling.sourceSha256 !== rate.inputTokenCeilingSourceSha256 || typeof ceiling.validateAuthorization !== 'function' ||
          !Number.isFinite(ceiling.validUntilMonotonicMs)) return null;
      const requestedUsd = currentBenchRequestExposureUsd(rate, ceiling.inputTokens, output, claude);
      if (requestedUsd === null || requestedUsd > arm.generationBudget.maxUsd ||
          !Number.isSafeInteger(ceiling.inputTokens + output) ||
          arm.generationBudget.maxTokens !== undefined && ceiling.inputTokens + output > arm.generationBudget.maxTokens) return null;
      const validUntilMonotonicMs = Math.min(ceiling.validUntilMonotonicMs, processMonotonicClock.now() + 5000);
      const validateAuthorization = () => {
        const check = () => { if (!live || attempt.signal.aborted || processMonotonicClock.now() >= validUntilMonotonicMs) {
          throw new Error('Benchmark provider authority expired or revoked.');
        } };
        check();
        const validation: unknown = ceiling.validateAuthorization();
        if (validation !== undefined) {
          void Promise.resolve(validation).catch(() => {});
          throw new Error('Benchmark native input authority requires a synchronous check.');
        }
        check();
      };
      validateAuthorization();
      return { attemptKind: 'evaluation', requestedUsd, inputTokens: ceiling.inputTokens, outputTokens: output,
        validUntilMonotonicMs, validateAuthorization, ...(ceiling.evidence ? { inputEvidence: ceiling.evidence } : {}) };
    } catch { return null; }
  } };
}

export interface CurrentBenchProviderCaptureRecovery {
  schemaVersion: 1; configurationSha256: string; rootIdentity: string; directoryIdentity: string;
  captures: readonly { reservationId: string; receiptSha256: string }[];
}

/** Host-owned request capture over the existing gateway callback and artifact
 * boundary. Recovery requires the host's retained hash pins, never receipt
 * discovery alone. Exclusive allocation slots retain even interrupted attempts
 * across restarts. A capture alone proves neither send nor billing. */
export function currentBenchWorkloadProviderInputCapture(options: {
  accountingBinding: CurrentBenchAccountingBinding; captureRoot: string; candidateCheckoutRoot: string;
  model: string; effort: string; accountId: string; maxRequests: number; maxBytes: number;
  /** Anthropic requests have no native turn identity before the response.
   * Omission preserves existing Codex allocation hashes and receipts. */
  agent?: 'claude';
  /** D-023 subscription route. Omission is the API-key route, so existing
   * allocations keep their configuration hash. */
  payer?: 'subscription';
  recovery?: CurrentBenchProviderCaptureRecovery;
  /** Terminal evidence inspection requires retained host pins and cannot allocate or send. */
  readOnly?: boolean;
}) {
  const { recovery, readOnly = false, ...frozen } = structuredClone(options), binding = frozen.accountingBinding;
  const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 500;
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  if (!binding || ![binding.workspaceId, binding.loopId, binding.runId, binding.assignmentId,
    frozen.model, frozen.effort, frozen.accountId, frozen.captureRoot, frozen.candidateCheckoutRoot].every(present) ||
    !digest(binding.preregHash) || !binding.assignmentId.startsWith('bench-assignment:') ||
    !Number.isSafeInteger(frozen.maxRequests) || frozen.maxRequests < 1 || frozen.maxRequests > 10_000 ||
    !Number.isSafeInteger(frozen.maxBytes) || frozen.maxBytes < 1 || frozen.maxBytes > 16 * 1024 * 1024 ||
    frozen.payer !== undefined && frozen.payer !== 'subscription' ||
    frozen.agent !== undefined && frozen.agent !== 'claude' || frozen.agent === 'claude' && frozen.payer !== undefined)
    throw new Error('Provider input capture requires an exact private assignment and bounded allocation.');
  const claude = frozen.agent === 'claude';
  const route = claude ? { transport: 'anthropic-http', target: anthropicMessagesTarget, credentialHeader: 'x-api-key' }
    : currentBenchCodexRoute(frozen.payer ?? 'api-key');
  resolveBenchWorkspace(binding.workspaceId);
  if (readOnly && !recovery) throw new Error('Read-only provider capture requires retained host recovery pins.');
  const root = lstatSync(frozen.captureRoot, { bigint: true });
  // Generation removes the checkout after stopping its gateway. The retained
  // allocation already pins its canonical path; reading host evidence must not
  // depend on that unrelated directory still existing. Writable recovery keeps
  // the original realpath requirement.
  const candidate = readOnly ? resolve(frozen.candidateCheckoutRoot) : realpathSync(frozen.candidateCheckoutRoot);
  const repo = realpathSync(REPO_ROOT);
  if (!root.isDirectory() || (root.mode & 0o077n) !== 0n || realpathSync(frozen.captureRoot) !== frozen.captureRoot ||
      readOnly && candidate !== frozen.candidateCheckoutRoot ||
      frozen.captureRoot === candidate || frozen.captureRoot.startsWith(`${candidate}${sep}`) ||
      frozen.captureRoot === repo || frozen.captureRoot.startsWith(`${repo}${sep}`))
    throw new Error('Provider input capture requires a canonical private host root outside the candidate checkout.');
  const namespace = `provider-input-${createHash('sha256').update(canonicalJson(binding)).digest('hex')}`;
  const directory = join(frozen.captureRoot, namespace);
  if (!recovery) mkdirSync(directory, { mode: 0o700 });
  const allocated = lstatSync(directory, { bigint: true });
  const configurationSha256 = createHash('sha256').update(canonicalJson(frozen)).digest('hex');
  const identity = (stat: typeof root) => `${stat.dev}:${stat.ino}`;
  const unchanged = () => {
    const current = lstatSync(frozen.captureRoot, { bigint: true }), child = lstatSync(directory, { bigint: true });
    return current.isDirectory() && current.dev === root.dev && current.ino === root.ino &&
      child.isDirectory() && child.dev === allocated.dev && child.ino === allocated.ino &&
      (current.mode & 0o077n) === 0n && (child.mode & 0o077n) === 0n &&
      realpathSync(frozen.captureRoot) === frozen.captureRoot && realpathSync(directory) === directory;
  };
  if (!unchanged() || recovery && (recovery.schemaVersion !== 1 ||
      recovery.configurationSha256 !== configurationSha256 || recovery.rootIdentity !== identity(root) ||
      recovery.directoryIdentity !== identity(allocated) || !Array.isArray(recovery.captures) ||
      recovery.captures.length > frozen.maxRequests ||
      recovery.captures.some(pin => !pin || !uuid(pin.reservationId) || !digest(pin.receiptSha256)) ||
      new Set(recovery.captures.map(pin => pin.reservationId)).size !== recovery.captures.length))
    throw new Error('Provider input capture recovery differs from its private host allocation.');
  type Capture = Readonly<{ schemaVersion: 1; accountingBinding: CurrentBenchAccountingBinding;
    reservationId: string; bodyRef: string; bodyPath: string; bodySha256: string;
    model: string; effort: string; accountId: string; payer?: 'subscription' } &
    ({ agent?: never; nativeSessionId: string; nativeTurnId: string; anthropicVersion?: never; anthropicBeta?: never } |
      { agent: 'claude'; nativeSessionId?: never; nativeTurnId?: never; anthropicVersion: string; anthropicBeta: null })>;
  const matchesNativeInput = (body: unknown, session: unknown, turn: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const request = body as Record<string, unknown>;
    if (request.model !== frozen.model) return false;
    const config = claude ? request.output_config : request.reasoning;
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config as Record<string, unknown>).effort !== frozen.effort) return false;
    if (claude) return session === undefined && turn === undefined &&
      typeof request.max_tokens === 'number' && Number.isSafeInteger(request.max_tokens) && request.max_tokens > 0 &&
      selfContainedAnthropicInput(request);
    const correlation = readGatewayNativeCorrelation(request);
    return uuid(session) && uuid(turn) &&
      correlation.status === 'observed' && correlation.turnId === turn && correlation.threadId === session &&
      (correlation.sessionId ?? correlation.threadId) === session;
  };
  const published = new Map(recovery?.captures.map(pin => [pin.reservationId, pin.receiptSha256]) ?? []);
  const paths = (id: string) => ({ body: `${namespace}/${id}/body.json`, receipt: `${namespace}/${id}/receipt.json` });
  const allocationCensus = () => {
    if (!unchanged()) throw new Error('Provider input capture allocation changed.');
    const members = readdirSync(directory);
    if (members.length > frozen.maxRequests * 2) throw new Error('Provider input capture allocation exceeds its bound.');
    let slots = 0;
    for (const name of members) {
      const slot = /^allocation-(0|[1-9][0-9]*)$/.exec(name), file = join(directory, name), stat = lstatSync(file);
      if (slot ? !stat.isFile() || Number(slot[1]) >= frozen.maxRequests || (stat.mode & 0o077) !== 0 :
          !uuid(name) || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new Error('Provider input capture contains an invalid allocation member.');
      if (slot) slots++;
    }
    if (!unchanged()) throw new Error('Provider input capture allocation changed.');
    return slots;
  };
  allocationCensus();
  const capture = {
    async captureProviderInput(attempt: Readonly<GatewayCarryTrialAttempt>): Promise<void> {
      if (readOnly) throw new Error('Read-only provider capture cannot allocate or forward a request.');
      if (allocationCensus() >= frozen.maxRequests || attempt.signal.aborted ||
          !uuid(attempt.attemptId) ||
          attempt.manifestSha256 !== binding.preregHash || attempt.armId !== binding.assignmentId ||
          attempt.accountId !== frozen.accountId || attempt.transport !== route.transport ||
          attempt.target !== route.target || attempt.credentialHeader !== route.credentialHeader ||
          !digest(attempt.credentialSha256) || typeof attempt.body !== 'string' || claude &&
          (attempt.anthropicVersion !== anthropicInputVersion || attempt.anthropicBeta !== null))
        throw new Error('Provider input capture refused a foreign, cancelled or exhausted request.');
      const bytes = Buffer.from(attempt.body), hash = createHash('sha256').update(bytes).digest('hex');
      const body = JSON.parse(attempt.body);
      if (!bytes.length || bytes.length > frozen.maxBytes || bytes.toString('utf8') !== attempt.body ||
          hash !== attempt.bodySha256 || !matchesNativeInput(body, attempt.nativeSessionId, attempt.nativeTurnId))
        throw new Error('Provider input capture refused mismatched request bytes or native identity.');
      const path = paths(attempt.attemptId);
      const receipt: Capture = { schemaVersion: 1, accountingBinding: { ...binding }, reservationId: attempt.attemptId,
        bodyRef: `${namespace}:${attempt.attemptId}#body`, bodyPath: path.body, bodySha256: hash,
        ...(claude ? { agent: 'claude' as const, anthropicVersion: anthropicInputVersion, anthropicBeta: null }
          : { nativeSessionId: attempt.nativeSessionId!, nativeTurnId: attempt.nativeTurnId! }),
        model: frozen.model, effort: frozen.effort, accountId: frozen.accountId,
        ...(frozen.payer ? { payer: frozen.payer } : {}) };
      const encoded = canonicalJson(receipt);
      if (Buffer.byteLength(encoded) > 8192) throw new Error('Provider input capture receipt exceeds its bound.');
      // Each slot is an exclusive, persistent budget claim. A failed write or
      // a concurrent/recovered host never resets or exceeds this allocation.
      let reserved = false;
      for (let slot = 0; slot < frozen.maxRequests; slot++) {
        try { writeFileSync(join(directory, `allocation-${slot}`), '', { flag: 'wx', mode: 0o600 }); reserved = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!reserved || !unchanged()) throw new Error('Provider input capture allocation is exhausted or changed.');
      // A partial capture cannot be overwritten or retried into a provider send.
      mkdirSync(join(directory, attempt.attemptId), { mode: 0o700 });
      writeFileSync(join(frozen.captureRoot, path.body), bytes, { flag: 'wx', mode: 0o600 });
      if (!unchanged() || !readContainedBenchmarkFile(frozen.captureRoot, path.body, frozen.maxBytes).equals(bytes))
        throw new Error('Provider input capture changed during publication.');
      writeFileSync(join(frozen.captureRoot, path.receipt), encoded, { flag: 'wx', mode: 0o600 });
      if (!unchanged() || readContainedBenchmarkFile(frozen.captureRoot, path.receipt, 8192).toString('utf8') !== encoded)
        throw new Error('Provider input capture receipt changed during publication.');
      published.set(attempt.attemptId, createHash('sha256').update(encoded).digest('hex'));
    },
    readCapture(reservationId: string): Capture | null {
      try {
        if (!uuid(reservationId) || !published.has(reservationId) || !unchanged()) return null;
        const path = paths(reservationId), bytes = readContainedBenchmarkFile(frozen.captureRoot, path.receipt, 8192);
        if (createHash('sha256').update(bytes).digest('hex') !== published.get(reservationId)) return null;
        const receipt = JSON.parse(bytes.toString('utf8')) as Capture;
        if (receipt.schemaVersion !== 1 || canonicalJson(receipt.accountingBinding) !== canonicalJson(binding) ||
            receipt.reservationId !== reservationId || receipt.bodyPath !== path.body ||
            receipt.bodyRef !== `${namespace}:${reservationId}#body` || !digest(receipt.bodySha256) ||
            receipt.model !== frozen.model || receipt.effort !== frozen.effort || receipt.accountId !== frozen.accountId ||
            receipt.payer !== frozen.payer || (receipt.agent === 'claude') !== claude || claude &&
            (receipt.anthropicVersion !== anthropicInputVersion || receipt.anthropicBeta !== null)) return null;
        const body = readContainedBenchmarkFile(frozen.captureRoot, path.body, frozen.maxBytes);
        if (createHash('sha256').update(body).digest('hex') !== receipt.bodySha256 || !unchanged()) return null;
        const request = JSON.parse(body.toString('utf8'));
        if (!matchesNativeInput(request, receipt.nativeSessionId, receipt.nativeTurnId)) return null;
        return Object.freeze({ ...receipt, accountingBinding: Object.freeze({ ...receipt.accountingBinding }) });
      } catch { return null; }
    },
    /** Persist this credential-free snapshot through the existing host
     * checkpoint before shutdown. It must never come from the candidate. */
    recoveryState(): CurrentBenchProviderCaptureRecovery {
      allocationCensus();
      const captures = [...published].sort(([a], [b]) => a.localeCompare(b)).map(([reservationId, receiptSha256]) => {
        if (!capture.readCapture(reservationId)) throw new Error('Provider input capture cannot retain altered evidence.');
        return Object.freeze({ reservationId, receiptSha256 });
      });
      return Object.freeze({ schemaVersion: 1, configurationSha256, rootIdentity: identity(root),
        directoryIdentity: identity(allocated), captures: Object.freeze(captures) });
    },
  };
  if (recovery && [...published.keys()].some(id => !capture.readCapture(id)))
    throw new Error('Provider input capture recovery contains altered or missing evidence.');
  return capture;
}

export interface CurrentBenchHostGateway {
  readonly nativeGateway: Readonly<ScopedInferenceGateway>;
  readonly nativeAccountingBinding: CurrentBenchAccountingBinding;
  /** Trusted host only: the caller derives remaining caps from measured usage.
   * Issuance proves scope/lifetime, not matched-cost measurement. */
  issueSessionBudget(budget: GenerationBudget, beforeCost?: CurrentBenchNativeRunCost | null): CurrentBenchSessionBudget;
  stop(): Promise<void>;
}
/** An official host reference has no Codex session/home or native-launch grant. */
export interface CurrentBenchHostReferenceGateway {
  readonly agent: 'proximus';
  readonly gateway: Readonly<ScopedInferenceGateway>;
  readonly accountingBinding: CurrentBenchAccountingBinding;
  stop(): Promise<void>;
}
const currentBenchHostReferences = new WeakMap<CurrentBenchHostReferenceGateway, {
  protocol: string; assignmentId: string; active(): boolean;
}>();

/** Copied fields/URLs never substitute for the controller's live host grant. */
export function requireCurrentBenchHostReferenceGateway(receipt: CurrentBenchHostReferenceGateway,
  protocol: CurrentBenchmarkProtocol, execution: { armId: string; taskId: string; seed: number }) {
  const issued = currentBenchHostReferences.get(receipt);
  if (!issued?.active() || issued.protocol !== canonicalJson(currentBenchmarkProtocolSchema.parse(protocol)) ||
      issued.assignmentId !== currentBenchAssignmentId(protocol.runId, execution.armId, execution.taskId, execution.seed)) {
    throw new Error('Proximus requires its live controller-issued host gateway and exact frozen assignment.');
  }
  return receipt;
}
export interface CurrentBenchSessionBudget {
  readonly index: number;
  readonly binding: CurrentBenchAccountingBinding;
  readonly budget: Readonly<GenerationBudget>;
  /** Already charged assignment usage; live session checks subtract it once. */
  readonly priorUsage?: Readonly<Pick<BenchRunCost, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite' | 'costUsd'>>;
}
interface CurrentBenchSessionState {
  receipt: CurrentBenchSessionBudget;
  phase: 'issued' | 'admitting' | 'admitted' | 'launched' | 'retired';
  handle?: string;
}
// A loopback URL is configuration, not evidence that its service enforces this
// assignment's reservations. Only the host controller can issue this pairing.
const currentBenchHostGateways = new WeakMap<ScopedInferenceGateway, {
  binding: CurrentBenchAccountingBinding;
  protocol: string;
  arm: CurrentBenchmarkProtocol['arms'][number];
  taskId: string;
  sessionCount: number;
  session?: CurrentBenchSessionState;
  active(): boolean;
  stop(): Promise<void>;
}>();

/** Private host authority authenticates the FINAL credential, payer and native
 * input bound. A configured account alias or a caller bearer is insufficient.
 * The request still has to match the frozen model, effort, output and prices. */
export function currentBenchGatewayController(input: {
  workspaceId: string; loopId: string; token: string; preregHash: string;
  protocol: CurrentBenchmarkProtocol; armId: string; taskId: string; seed: number;
  resources: LearningReservationResourceBudget;
  /** Per-request native output ceiling, independent of aggregate resources.
   * The host may tighten this limit but cannot widen the frozen allowance. */
  outputTokenLimit?: number;
  authenticateProvider: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>;
  /** Host-owned artifact capture, before reservation/send. Never pass this
   * callback through candidate configuration. Failure refuses generation. */
  captureProviderInput?: (attempt: Readonly<GatewayCarryTrialAttempt>) => Promise<void>;
}, governor?: GovernorGlueDeps): ReturnType<typeof createNativeGymGatewayController> & {
  readonly accountingBinding: CurrentBenchAccountingBinding;
  startNativeGateway(log?: (message: string) => void, start?: Parameters<typeof startNativeGymGateway>[3]): Promise<CurrentBenchHostGateway>;
  startHostGateway(log?: (message: string) => void, start?: Parameters<typeof startNativeGymGateway>[3]): Promise<CurrentBenchHostReferenceGateway>;
} {
  const protocol = currentBenchmarkProtocolSchema.parse(input.protocol);
  const arm = protocol.arms.find(arm => arm.id === input.armId);
  resolveBenchWorkspace(input.workspaceId);
  if (!arm || !protocol.taskIds.includes(input.taskId) || !protocol.seeds.includes(input.seed) ||
      !/^[a-f0-9]{64}$/.test(input.preregHash) || typeof input.authenticateProvider !== 'function') {
    throw new Error('Benchmark gateway requires its frozen assignment and authenticated provider.');
  }
  const { workspaceId, loopId, token, preregHash, authenticateProvider, captureProviderInput, taskId } = input;
  const assignmentId = currentBenchAssignmentId(protocol.runId, input.armId, input.taskId, input.seed);
  const assignmentIds = protocol.arms.flatMap(arm => protocol.taskIds.flatMap(taskId =>
    protocol.seeds.map(seed => currentBenchAssignmentId(protocol.runId, arm.id, taskId, seed)))).sort();
  const resources = { ...input.resources, armIds: [...input.resources.armIds] };
  // The host may choose tighter token, request and global-time bounds, but
  // cannot widen any monetary/assignment limit or omit another frozen arm.
  if (canonicalJson([...resources.armIds].sort()) !== canonicalJson(assignmentIds) ||
      resources.usdPerArm !== arm.generationBudget.maxUsd || resources.maxOpenUsd !== protocol.maxInFlightUsd ||
      resources.wallClockMsPerArm !== arm.generationBudget.maxWallClockMs ||
      resources.totalTokensPerArm !== arm.generationBudget.maxTokens ||
      !Number.isSafeInteger(resources.wallClockMs) || resources.wallClockMs! <= 0) {
    throw new Error('Benchmark gateway resource policy differs from the frozen protocol.');
  }
  const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
  // D-023: the subscription backend rejects max_output_tokens, so a host limit
  // would refuse every send there. That route reserves the frozen model maximum.
  const payer = currentBenchArmPayer(arm), subscription = payer === 'subscription';
  if (subscription && (input.outputTokenLimit !== undefined || rate.outputTokenCeiling === undefined)) {
    throw new Error('A subscription arm reserves its frozen provider output ceiling and cannot take a host output limit.');
  }
  const outputTokenLimit = subscription ? rate.outputTokenCeiling! : input.outputTokenLimit === undefined
    ? Math.min(resources.outputTokens, arm.generationBudget.maxTokens ?? resources.outputTokens)
    : input.outputTokenLimit;
  if (!Number.isSafeInteger(outputTokenLimit) || outputTokenLimit <= 0 || outputTokenLimit > resources.outputTokens ||
      arm.generationBudget.maxTokens !== undefined && outputTokenLimit > arm.generationBudget.maxTokens) {
    throw new Error('Benchmark per-request output ceiling exceeds its frozen allowance or is invalid.');
  }
  const codexRoute = currentBenchCodexRoute(payer);
  const providerAgent = currentBenchProviderAgent(arm);
  const controller = createNativeGymGatewayController({ workspaceId, loopId, token, manifestSha256: preregHash, armId: assignmentId,
    ...(subscription ? {} : { outputTokenLimit }),
    exact: { binding: preregHash, budgetUsd: protocol.aggregateBudgetUsd, resourceBudget: resources },
    async authorizeProviderAttempt(attempt) {
      // Copy before authentication so an async callback cannot retarget the
      // body whose native output ceiling and monetary exposure were checked.
      const request = Object.freeze({ ...attempt });
      try {
        const body = JSON.parse(request.body);
        const output = request.transport === 'anthropic-http' ? body.max_tokens : subscription
          ? (body.max_output_tokens === undefined ? outputTokenLimit : undefined) : body.max_output_tokens;
        const effort = request.transport === 'anthropic-http' ? body.output_config?.effort : body.reasoning?.effort;
        if ((providerAgent === 'codex') !== (request.transport !== 'anthropic-http') ||
            providerAgent === 'codex' && request.transport !== codexRoute.transport ||
            !['auto', 'default'].includes(arm.account) && request.accountId !== arm.account ||
            body.model !== arm.model || effort !== arm.effort ||
            !Number.isSafeInteger(output) || output <= 0 || output > outputTokenLimit ||
            arm.generationBudget.maxTokens !== undefined && output > arm.generationBudget.maxTokens) return null;
        const authenticated = await authenticateProvider(request);
        if (!authenticated) return null;
        const authority = { ...authenticated };
        if (authority.outputTokens !== output || !Number.isSafeInteger(authority.inputTokens) || authority.inputTokens < 0 ||
            !Number.isSafeInteger(authority.inputTokens + output) ||
            arm.generationBudget.maxTokens !== undefined && authority.inputTokens + output > arm.generationBudget.maxTokens ||
            rate.inputTokenCeiling !== undefined && authority.inputTokens !== rate.inputTokenCeiling) return null;
        // Round each frozen rate upward to microUSD per million tokens, then
        // use integer arithmetic. Floating subtraction must never grant extra
        // exposure. Full uncached input is the conservative OpenAI bound.
        const requiredUsd = currentBenchRequestExposureUsd(rate, authority.inputTokens, output, request.transport === 'anthropic-http');
        if (requiredUsd === null) return null;
        const grantMicros = Math.round(authority.requestedUsd * 1_000_000);
        if (!Number.isSafeInteger(grantMicros) || grantMicros <= 0 || grantMicros / 1_000_000 !== authority.requestedUsd ||
            grantMicros < Math.round(requiredUsd * 1_000_000) || authority.requestedUsd > arm.generationBudget.maxUsd) return null;
        await captureProviderInput?.(request);
        return authority;
      } catch { return null; }
    },
  }, governor);
  const accountingBinding = Object.freeze({ workspaceId, loopId, runId: protocol.runId, preregHash, assignmentId });
  let live = true, starting = false;
  const revoke = () => { live = false; controller.revoke(); };
  return { ...controller, accountingBinding, revoke,
    async startHostGateway(log = () => {}, start) {
      if (!live || starting || arm.agent !== 'proximus')
        throw new Error('Benchmark host reference gateway is revoked, already started or unsupported.');
      starting = true;
      let service: Awaited<ReturnType<typeof startNativeGymGateway>> | undefined;
      try {
        // Same authenticated final-provider reservations and response ledger;
        // this path grants no psu/native launch, session budget or home access.
        service = await startNativeGymGateway(controller.gateway, workspaceId, log, start);
        if (!live) throw new Error('Benchmark host reference gateway was revoked during startup.');
        let stopped = false, stopping: Promise<void> | undefined;
        const receipt: CurrentBenchHostReferenceGateway = Object.freeze({ agent: 'proximus' as const,
          gateway: snapshotScopedInferenceGateway(service.transport.statelessGateway), accountingBinding,
          stop() {
            stopped = true; revoke();
            return stopping ??= Promise.resolve().then(() => service!.stop());
          } });
        currentBenchHostReferences.set(receipt, { protocol: canonicalJson(protocol), assignmentId,
          active: () => live && !stopped });
        return receipt;
      } catch (error) {
        revoke();
        await service?.stop();
        throw error;
      }
    },
    async startNativeGateway(log = () => {}, start) {
      // Claude uses the maintained isolated stock runner. Its treatment route
      // is not supported by the su launcher; refuse it before any listener.
      if (!live || starting || arm.agent !== 'codex' && !(arm.id === 'baseline' && arm.agent === 'claude'))
        throw new Error('Benchmark host gateway is revoked, already started or unsupported.');
      starting = true;
      let service: Awaited<ReturnType<typeof startNativeGymGateway>> | undefined;
      try {
        service = await startNativeGymGateway(controller.gateway, workspaceId, log, start);
        if (!live) throw new Error('Benchmark host gateway was revoked during startup.');
        const nativeGateway = snapshotScopedInferenceGateway(service.transport.statelessGateway);
        let stopped = false, stopping: Promise<void> | undefined;
        const stop = () => {
          stopped = true; revoke();
          return stopping ??= Promise.resolve().then(() => service!.stop());
        };
        const host: NonNullable<ReturnType<typeof currentBenchHostGateways.get>> = { binding: accountingBinding,
          protocol: canonicalJson(protocol), arm, taskId, sessionCount: 0, active: () => live && !stopped, stop };
        currentBenchHostGateways.set(nativeGateway, host);
        return Object.freeze({ nativeGateway, nativeAccountingBinding: accountingBinding, stop,
          issueSessionBudget(budget: GenerationBudget, beforeCost?: CurrentBenchNativeRunCost | null) {
            const repeated = arm.control?.repeatedSession;
            if (!host.active() || arm.control?.topology !== 'repeated-session' || !repeated ||
                host.sessionCount >= repeated.maxSessions || host.session && host.session.phase !== 'retired')
              throw new Error('Fresh native session allowance is unavailable, overlapping or exhausted.');
            const keys = ['maxUsd', 'maxTokens', 'maxWallClockMs'] as const;
            if (Object.keys(budget).some(key => !keys.includes(key as typeof keys[number])) ||
                keys.some(key => {
                  const frozen = arm.generationBudget[key], left = budget[key];
                  return frozen === undefined ? left !== undefined : left === undefined || !Number.isFinite(left) ||
                    left <= 0 || left > frozen || key === 'maxTokens' && !Number.isSafeInteger(left);
                })) throw new Error('Fresh native session allowance is missing, invalid or wider than the frozen cap.');
            let priorUsage: CurrentBenchSessionBudget['priorUsage'];
            if (beforeCost) {
              const accounting = requireCurrentBenchNativeRunCost(beforeCost).armMeta.nativeCostAccounting;
              if (accounting.preregHash !== preregHash || accounting.priceTableVersion !== protocol.priceSchedule.version)
                throw new Error('Fresh native session prior usage differs from its frozen protocol.');
              priorUsage = Object.freeze({ tokensIn: beforeCost.tokensIn, tokensOut: beforeCost.tokensOut,
                tokensCacheRead: beforeCost.tokensCacheRead, tokensCacheWrite: beforeCost.tokensCacheWrite, costUsd: beforeCost.costUsd });
            }
            const receipt = Object.freeze({ index: host.sessionCount++, binding: accountingBinding,
              budget: Object.freeze({ ...budget }), ...(priorUsage ? { priorUsage } : {}) });
            host.session = { receipt, phase: 'issued' };
            return receipt;
          } });
      } catch (error) {
        revoke();
        await service?.stop();
        throw error;
      }
    },
  };
}

type LaunchArgs = Parameters<typeof launchAgentTool.handler>[0];
export type CurrentBenchTask = Pick<TaskRow, 'taskId' | 'workspaceId' | 'state' | 'exitCode' | 'detail'> &
  Partial<Pick<TaskRow, 'sessionId' | 'startedAt'>>;
/** A living CLI can have a terminally failed turn. Only its current, fresh
 * host observation can retire a pending benchmark; older children stay unknown. */
export function currentBenchNativeFailure(task: CurrentBenchTask, host: PsuPtyHost | null,
  nowMs = Date.now()): string | null {
  const owner = task.detail.coordOwnerId, execution = host?.execution, failure = execution?.failure;
  const startedAt = Date.parse(task.startedAt ?? '');
  if (!host || !execution || !failure || !['pending', 'running'].includes(task.state) ||
      typeof owner !== 'string' || !owner.trim() || !task.sessionId || !Number.isFinite(startedAt) ||
      host.ownerId !== owner || host.nativeSessionId !== task.sessionId ||
      !Number.isSafeInteger(host.pid) || host.pid <= 0 || !host.ptyPid ||
      !Number.isSafeInteger(host.childGeneration) || host.childGeneration! < 0 ||
      execution.ownerId !== owner || execution.hostPid !== host.pid || execution.childPid !== host.ptyPid ||
      execution.childGeneration !== host.childGeneration ||
      !('nativeSessionId' in execution) || execution.nativeSessionId !== task.sessionId ||
      execution.phase !== 'failed' || failure.retryable !== false ||
      typeof failure.code !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(failure.code) ||
      !Number.isFinite(host.startedAt) || host.startedAt < startedAt ||
      !Number.isFinite(execution.receivedAtMs) || execution.receivedAtMs! < host.startedAt ||
      !Number.isFinite(failure.atMs) || failure.atMs < execution.receivedAtMs! ||
      !Number.isFinite(execution.observedAt) || execution.observedAt < failure.atMs ||
      !Number.isFinite(nowMs) || execution.observedAt > nowMs || nowMs - execution.observedAt > 15_000) return null;
  return `Native benchmark turn failed: ${failure.code} (nonretryable).`;
}
export interface CurrentBenchIdentity {
  measuredBy: 'runtime-observation';
  runtimeRevision: string;
  sourceRevision: string;
  model: string;
  effort: string;
  clientVersion: string;
  promptHash: string;
  promptTemplateHash?: string;
  toolsHash: string;
  observedAt: string;
  evidenceRefs: string[];
  effortSource?: 'provider-response' | 'forwarded-request';
  accountId?: string;
  nativeSessionId?: string;
  providerResponseId?: string;
}
/** Loaded-runtime receipts come from the execution host, never current HEAD or
 * requested launch options. The native transcript and gateway row are private
 * inputs; the resulting identity retains only hashes and evidence references. */
export interface CurrentBenchIdentityObservation {
  worker: {
    taskId: string; workspaceId: string; ownerId: string; nativeSessionId: string;
    agent?: 'codex' | 'claude';
    codexHome?: string;
    claudeConfigDir?: string;
    runtimeRevision: string; sourceRevision: string; evidenceRef: string;
  };
  nativeTranscript: string;
  gateway: { processRef: string; timeline: GatewayRequestTimeline };
}

/** Existing native session, runtime-vintage and gateway readers are the IO
 * authority. A bounded gateway ring establishes a particular request identity,
 * never complete all-attempt usage or a historical runtime census. */
export interface CurrentBenchObservationReaderPorts {
  readBinding(task: CurrentBenchTask): Promise<{ ownerId: string; nativeSessionId: string;
    agent?: 'codex' | 'claude'; codexHome?: string; claudeConfigDir?: string } | null>;
  readRuntimes(): Promise<RuntimeVintageRow[]>;
  measureRuntimes(rows: RuntimeVintageRow[], units: string[]): string | null;
  readTranscript(nativeSessionId: string, home: string, agent?: 'codex' | 'claude'): Promise<string | null>;
  readGateway(ownerId: string): Promise<{ owner: string; process: { pid: number; identity: string | null; startedAt: number };
    stageTelemetry: { ownerId: string; recent: GatewayRequestTimeline[] } } | null>;
}
export interface CurrentBenchObservationReaderOptions extends DbScope {
  workspaceId: string;
  /** Boot ledger scope of the shared execution host, distinct from the
   * isolated task workspace. Read-only observation does not grant it authority. */
  runtimeWorkspaceId: string;
  workerUnit: string;
  gatewayUnit: string;
  gatewayBaseUrl: string;
}
export function currentBenchObservationReader(
  options: CurrentBenchObservationReaderOptions,
  ports?: CurrentBenchObservationReaderPorts,
  issuedGateway?: CurrentBenchHostGateway,
): (task: CurrentBenchTask) => Promise<CurrentBenchIdentityObservation | null> {
  // Copy before asynchronous reads; an options mutation cannot retarget proof.
  const opts = { ...options };
  resolveBenchWorkspace(opts.workspaceId);
  const endpoint = new URL(opts.gatewayBaseUrl);
  // A private service started by this controller runs in the execution host,
  // so its loaded code is the host's boot record. A caller URL alone cannot
  // take this path or substitute a second, self-reported runtime identity.
  const host = issuedGateway && currentBenchHostGateways.get(issuedGateway.nativeGateway);
  const issuedHere = () => !!host && host.active() &&
    host.binding.workspaceId === opts.workspaceId &&
    canonicalJson(issuedGateway!.nativeAccountingBinding) === canonicalJson(host.binding) &&
    new URL(issuedGateway!.nativeGateway.baseURL).href === endpoint.href;
  if (issuedGateway && !issuedHere()) throw new Error('Benchmark observation requires its active controller-issued gateway.');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !opts.runtimeWorkspaceId.trim() || !opts.workerUnit.trim() ||
      !host && (!opts.gatewayUnit.trim() || opts.workerUnit === opts.gatewayUnit)) {
    throw new Error('Benchmark observation requires explicit local execution and gateway runtimes.');
  }
  const gatewayPort = Number(endpoint.port || 80);
  const io = { ...(ports ?? liveCurrentBenchObservationReaderPorts(opts, issuedGateway)) };
  return async task => {
    try {
      if (host && !issuedHere() || task.workspaceId !== opts.workspaceId || !task.sessionId || typeof task.detail.coordOwnerId !== 'string') return null;
      const enrolled = await io.readBinding(task);
      // Copy the enrollment before IO: neither an in-place mutation nor a
      // later carry/rebinding may redirect the proof to another native home.
      const binding = enrolled && { ...enrolled };
      if (!binding || binding.nativeSessionId !== task.sessionId || binding.ownerId !== task.detail.coordOwnerId) return null;
      const agent = binding.agent ?? 'codex';
      const home = agent === 'claude' ? binding.claudeConfigDir : binding.codexHome;
      if (!['codex', 'claude'].includes(agent) || !home?.trim() ||
          (agent === 'claude' ? !!binding.codexHome : !!binding.claudeConfigDir)) return null;
      const rows = await io.readRuntimes();
      const units = host ? [opts.workerUnit] : [opts.workerUnit, opts.gatewayUnit];
      const environment = io.measureRuntimes(rows, units), runtimeRevision = io.measureRuntimes(rows, [opts.workerUnit]);
      const workers = rows.filter(row => row.unit === opts.workerUnit);
      const gateways = rows.filter(row => row.unit === (host ? opts.workerUnit : opts.gatewayUnit));
      if (!environment || !runtimeRevision || workers.length !== 1 || gateways.length !== 1) return null;
      const worker = workers[0], gateway = gateways[0];
      if (worker.workspaceId !== opts.runtimeWorkspaceId || gateway.workspaceId !== opts.runtimeWorkspaceId ||
          !worker.treeSha || !/^[a-f0-9]{40}$/.test(worker.treeSha) ||
          (host ? worker.pid !== process.pid : gateway.extra.port !== gatewayPort) ||
          typeof gateway.extra.kernelProcessIdentity !== 'string') return null;
      const [nativeTranscript, report] = await Promise.all([
        agent === 'claude' ? io.readTranscript(binding.nativeSessionId, home, agent) : io.readTranscript(binding.nativeSessionId, home),
        io.readGateway(binding.ownerId),
      ]);
      if (!nativeTranscript || !report || report.owner !== binding.ownerId || report.stageTelemetry.ownerId !== binding.ownerId ||
          report.process.pid !== gateway.pid || report.process.identity !== gateway.extra.kernelProcessIdentity ||
          !Number.isFinite(report.process.startedAt)) return null;
      const bootAt = Date.parse(worker.reportedAt);
      const taskAt = Date.parse(task.startedAt ?? '');
      if (!Number.isFinite(bootAt) || !Number.isFinite(taskAt)) return null;
      const candidates = report.stageTelemetry.recent.filter(row =>
        row.startedAt >= Math.max(bootAt, taskAt, report.process.startedAt) &&
        (agent === 'claude' || row.nativeCorrelation.status === 'observed' && row.nativeCorrelation.threadId === binding.nativeSessionId))
        .sort((a, b) => b.finalizedAt - a.finalizedAt);
      // Claude supplies its exact provider message id in native bytes, rather
      // than Codex's request headers. Unrelated newer traffic cannot select a
      // foreign session or hide this session's independently measured request.
      let observation: CurrentBenchIdentityObservation | null = null;
      for (const timeline of candidates) {
        const candidate: CurrentBenchIdentityObservation = {
          worker: { taskId: task.taskId, workspaceId: task.workspaceId, ownerId: binding.ownerId,
            nativeSessionId: binding.nativeSessionId, agent,
            ...(agent === 'claude' ? { claudeConfigDir: home } : { codexHome: home }),
            runtimeRevision, sourceRevision: worker.treeSha,
            evidenceRef: `runtime-vintage:${worker.unit}:${worker.host}:${worker.extra.kernelProcessIdentity}:${environment}` },
          nativeTranscript, gateway: { processRef: `gateway:${report.process.identity}`, timeline },
        };
        if (currentBenchIdentityFromObservation(task, candidate)) { observation = candidate; break; }
      }
      if (!observation || io.measureRuntimes(await io.readRuntimes(), units) !== environment ||
          canonicalJson(await io.readBinding(task)) !== canonicalJson(binding) || host && !issuedHere()) return null;
      return observation;
    } catch { return null; }
  };
}

/** Read host-owned bindings and full native bytes. Never search another home,
 * restamp from HEAD, or use requested launch configuration as an observation. */
export function liveCurrentBenchObservationReaderPorts(
  opts: CurrentBenchObservationReaderOptions, issuedGateway?: CurrentBenchHostGateway,
): CurrentBenchObservationReaderPorts {
  const scope = { ...opts };
  const host = issuedGateway && currentBenchHostGateways.get(issuedGateway.nativeGateway);
  const issuedHere = () => !!host && host.active() && host.binding.workspaceId === scope.workspaceId &&
    canonicalJson(issuedGateway!.nativeAccountingBinding) === canonicalJson(host.binding) &&
    new URL(issuedGateway!.nativeGateway.baseURL).href === new URL(scope.gatewayBaseUrl).href;
  if (issuedGateway && !issuedHere()) throw new Error('Benchmark observation requires its active controller-issued gateway.');
  return {
    readBinding: async task => {
      const { resolveDb } = await import('./reproducibility/db');
      const { codexHomeForSessionKey, sessionClaudeConfigDir } = await import('@papercusp/orchestrator/session-launch-dirs');
      const { sql } = resolveDb(scope);
      const rows = await sql<{ id: number | string; agent: string; coord_owner_id: string; session_id: string }[]>`
        SELECT a.id, a.agent, a.coord_owner_id, a.session_id FROM harness_shared.adv_sessions a
        JOIN harness_shared.task_ledger t ON t.workspace_id = a.workspace_id
          AND t.session_id = a.session_id AND t.detail->>'coordOwnerId' = a.coord_owner_id
        WHERE t.task_id = ${task.taskId} AND t.workspace_id = ${scope.workspaceId}
          AND a.agent IN ('codex', 'claude') AND a.coord_owner_id = ${String(task.detail.coordOwnerId)}
          AND a.session_id = ${task.sessionId ?? null}
        ORDER BY a.started_at DESC LIMIT 2
      `;
      if (rows.length !== 1) return null;
      const row = rows[0];
      // adv_sessions.id is BIGSERIAL: postgres.js preserves int8 as decimal
      // text. Validate before conversion so the native-home key stays exact.
      const sessionKey = typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id) ? Number(row.id) : row.id;
      if (typeof sessionKey !== 'number' || !Number.isSafeInteger(sessionKey) || sessionKey < 1 || !row.coord_owner_id ||
          row.coord_owner_id !== task.detail.coordOwnerId || row.session_id !== task.sessionId) return null;
      const common = { ownerId: row.coord_owner_id, nativeSessionId: row.session_id };
      if (row.agent === 'claude') return { ...common, agent: 'claude', claudeConfigDir: sessionClaudeConfigDir(row.coord_owner_id) };
      return row.agent === 'codex' ? { ...common, codexHome: codexHomeForSessionKey(sessionKey) } : null;
    },
    readRuntimes: async () => {
      const { listRuntimeVintage } = await import('../runtime-vintage');
      return listRuntimeVintage(scope.runtimeWorkspaceId, scope.sql, [scope.workerUnit, scope.gatewayUnit]);
    },
    // Keep the existing kernel-pin measurement synchronous for before/after proof.
    measureRuntimes: (rows, units) => measureRuntimeVintageEnvironment(rows, units),
    readTranscript: async (nativeSessionId, home, agent = 'codex') => {
      try {
        if (!home.trim() || !['codex', 'claude'].includes(agent) ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nativeSessionId)) return null;
        const [{ promises: fs, constants }, path, { findCodexRolloutPathByUuid }, { findSessionTranscript }] = await Promise.all([
          import('node:fs'), import('node:path'), import('../session-transcript-resolvers'), import('../claude-sessions'),
        ]);
        const directory = agent === 'claude' ? 'projects' : 'sessions';
        const realHome = await fs.realpath(home), root = path.join(realHome, directory);
        const file = agent === 'claude'
          ? await findSessionTranscript(nativeSessionId, { roots: [root] })
          : await findCodexRolloutPathByUuid(nativeSessionId, { homeOverride: realHome });
        if (!file) return null;
        // Resolve the allocated home itself (the container relocates it), but
        // never follow a project, directory or file link beneath that root.
        const relative = path.relative(root, file), realFile = await fs.realpath(file);
        if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) ||
            realFile !== path.join(root, relative)) return null;
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size <= 0 || before.size > 8_388_608) return null;
          const bytes = Buffer.alloc(before.size); let offset = 0;
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) return null; offset += read.bytesRead;
          }
          const after = await fs.lstat(file), text = bytes.toString('utf8');
          return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
            before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
            await fs.realpath(home) === realHome && await fs.realpath(file) === realFile &&
            Buffer.from(text, 'utf8').equals(bytes) ? text : null;
        } finally { await handle.close(); }
      } catch { return null; }
    },
    readGateway: async ownerId => {
      if (issuedGateway && !issuedHere()) return null;
      const url = new URL('/admin/owner-report', scope.gatewayBaseUrl); url.searchParams.set('owner', ownerId);
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error',
        ...(issuedGateway ? { headers: { authorization: `Bearer ${issuedGateway.nativeGateway.token}` } } : {}) });
      if (!response.ok || !response.body) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength; if (size > 8_388_608) throw new Error('Benchmark gateway observation exceeded its byte bound.');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

export function currentBenchIdentityFromObservation(
  task: CurrentBenchTask, observation: CurrentBenchIdentityObservation,
): CurrentBenchIdentity | null {
  const { worker, gateway } = observation;
  const row = gateway.timeline;
  const provider = row.providerIdentity;
  const correlation = row.nativeCorrelation;
  const agent = worker.agent ?? 'codex';
  const revision = (value: string) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value);
  if (task.taskId !== worker.taskId || task.workspaceId !== worker.workspaceId || !worker.ownerId ||
      !worker.nativeSessionId || !worker.evidenceRef || !gateway.processRef ||
      !revision(worker.runtimeRevision) || !revision(worker.sourceRevision) ||
      !['codex', 'claude'].includes(agent) || row.ownerId !== worker.ownerId || row.provider !== agent ||
      row.protocol !== (agent === 'claude' ? 'anthropic-messages' : 'openai-responses') ||
      row.outcome !== 'ok' || row.finalStatus !== 200 || !provider ||
      !Number.isSafeInteger(row.requestId) || row.requestId < 1) return null;
  if (agent === 'codex' && (correlation.status !== 'observed' || correlation.threadId !== worker.nativeSessionId ||
      correlation.sessionId !== null && correlation.sessionId !== worker.nativeSessionId || !correlation.turnId)) return null;
  if (agent === 'claude' && (!worker.claudeConfigDir?.trim() || worker.codexHome ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(worker.nativeSessionId) ||
      !['unobserved', 'missing', 'invalid'].includes(correlation.status))) return null;
  const fullHash = (value: typeof row.cache.tools) => value && value.bytes > 0 &&
    value.bytes === value.hashedBytes && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : null;
  const promptHash = fullHash(row.cache.instructions), toolsHash = fullHash(row.cache.tools);
  const template = row.cache.nativeInstructionTemplate;
  if (agent === 'claude' && template) return null;
  const promptTemplateHash = template?.version === 'codex-native-template-v1' ? fullHash(template.fingerprint) : null;
  if (template?.skillsRootHash != null && (!worker.codexHome ||
      template.skillsRootHash !== hash(`${worker.codexHome}/skills/.system`))) return null;
  if (row.cache.shape !== 'observed' || !promptHash || !toolsHash ||
      provider.responseId !== row.cache.providerRequestId || provider.accountId !== row.cache.servingAccountId ||
      !row.forwardedEffort || provider.effort !== null && provider.effort !== row.forwardedEffort ||
      !Number.isFinite(row.finalizedAt) || row.finalizedAt < row.startedAt) return null;
  // No lossy transcript adapter: its session header/version and exact turn are
  // observations which portable conversation renderers intentionally discard.
  if (Buffer.byteLength(observation.nativeTranscript) > 8_388_608) return null;
  let records: Array<{ type?: string; payload?: Record<string, unknown>; sessionId?: string; session_id?: string;
    version?: string; perTurnEffort?: string; isApiErrorMessage?: boolean; isSidechain?: boolean;
    message?: { id?: string; model?: string } }>;
  try {
    records = observation.nativeTranscript.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) return null;
  } catch { return null; }
  let version: unknown, nativeRef: string;
  if (agent === 'claude') {
    // Claude has no Codex turn-context header. The host-owned native source
    // records the actual provider message alongside its session, CLI version
    // and effort. Reconcile that exact message; aliases/request order cannot
    // substitute for the gateway's independently observed provider response.
    const messages = records.filter(record => record.type === 'assistant' && record.message?.id === provider.responseId);
    version = messages[0]?.version;
    if (!messages.length || records.some(record =>
        record.sessionId !== undefined && record.sessionId !== worker.nativeSessionId ||
        record.session_id !== undefined && record.session_id !== worker.nativeSessionId) ||
        messages.some(record => record.sessionId !== worker.nativeSessionId || record.isApiErrorMessage || record.isSidechain ||
          record.version !== version || record.perTurnEffort !== row.forwardedEffort || record.message?.model !== provider.model)) return null;
    nativeRef = `claude:${worker.nativeSessionId}#message:${provider.responseId}`;
  } else {
    const headers = records.filter(record => record.type === 'session_meta');
    version = headers[0]?.payload?.cli_version;
    if (!headers.length || headers.some(record => record.payload?.id !== worker.nativeSessionId || record.payload?.cli_version !== version)) return null;
    const turns = records.filter(record => record.type === 'turn_context' && record.payload?.turn_id === correlation.turnId);
    if (!turns.length || turns.some(record => record.payload?.model !== row.model || record.payload?.effort !== row.forwardedEffort)) return null;
    nativeRef = `codex:${worker.nativeSessionId}#turn:${correlation.turnId}`;
  }
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(version)) return null;
  return {
    measuredBy: 'runtime-observation', runtimeRevision: worker.runtimeRevision, sourceRevision: worker.sourceRevision,
    model: provider.model, effort: provider.effort ?? row.forwardedEffort,
    effortSource: provider.effort ? 'provider-response' : 'forwarded-request',
    clientVersion: `${agent}/${version}`, promptHash, toolsHash, ...(promptTemplateHash ? { promptTemplateHash } : {}), accountId: provider.accountId,
    nativeSessionId: worker.nativeSessionId, providerResponseId: provider.responseId,
    observedAt: new Date(row.finalizedAt).toISOString(),
    evidenceRefs: [worker.evidenceRef, `${gateway.processRef}#request:${row.requestId}`, nativeRef, `provider:${provider.responseId}`],
  };
}
export interface CurrentSuBenchOptions extends LiveBenchHarnessOpts {
  runId: string;
  armId: string;
  seed: number;
  preregistration: { preregHash: string; config: Record<string, unknown>; repoRoot?: string };
  agent: 'codex' | 'claude';
  model: string;
  effort: NonNullable<NonNullable<LaunchArgs['members']>[number]['effort']>;
  account: string;
  signal?: AbortSignal;
}
/** Bind admission/observations from the existing budget and protocol planes. */
export interface CurrentSuBenchObservations {
  /** Route issued by currentBenchGatewayController.startNativeGateway.
   * Identity reads may precede setup; unissued routes cannot launch. */
  nativeGateway?: ScopedInferenceGateway;
  /** Same controller-issued scope; omission cannot launch or complete accounting. */
  nativeAccountingBinding?: CurrentBenchAccountingBinding;
  /** Opaque in-process host grant; copying its fields does not copy authority. */
  sessionBudget?: CurrentBenchSessionBudget;
  /**
   * Run the native agent CLI INSIDE this task container (benchmark-coverage-frontierswe-v2-2026-10-10
   * D-026/D-028). psu stays on the host; the launch pins its `codex` to a generated docker-exec
   * wrapper, which fails closed rather than falling back to the host CLI. Codex members only.
   */
  containerExec?: DockerExecTarget;
  admit(handle: BenchHarnessHandle, budget: GenerationBudget, taskId: string): Promise<{ admitted: boolean; receiptRef: string }>;
  observeIdentity(task: CurrentBenchTask): Promise<CurrentBenchIdentityObservation | null>;
}
export interface CurrentSuBenchPorts extends Pick<CurrentSuBenchObservations, 'admit'> {
  verifyGenerationBudget?(budget: GenerationBudget, taskId: string): {
    frozenBudget: GenerationBudget; topology?: 'repeated-session'; sessionBudget?: CurrentBenchSessionBudget;
  };
  releaseGateway?(): Promise<void>;
  collectCost?: BenchHarnessOps['collectCost'];
  readIdentity(task: CurrentBenchTask): Promise<CurrentBenchIdentity | null>;
  verifyPreregistration(): Promise<{ preregHash: string; gitCommitSha: string; receiptRef: string }>;
  restoreContext(handle: BenchHarnessHandle, taskId: string): Promise<BenchmarkContextReceipt>;
  verifyContext(handle: BenchHarnessHandle, taskId: string): Promise<BenchmarkContextReceipt>;
  readCompletion(handle: BenchHarnessHandle): Promise<'done' | 'failed' | null>;
  launch(args: LaunchArgs): Promise<unknown>;
  getTask(taskId: string): Promise<CurrentBenchTask | null>;
  listTasks(filter: { workspaceId: string; labelPrefix: string; includeEnded: true; limit: number }): Promise<CurrentBenchTask[]>;
  killTask(taskId: string): Promise<ControlOutcome>;
  sleep(ms: number): Promise<void>;
}
/** Stock shares verification/cleanup, but has no su launch port. */
export interface CurrentStockBenchPorts extends Omit<CurrentSuBenchPorts, 'launch'> {
  launchNative(input: { handle: BenchHarnessHandle; task: BenchTask; context: BenchmarkContextReceipt }): Promise<unknown>;
}
export const CURRENT_STOCK_CODEX_BLUEPRINT = 'native-codex';
export const CURRENT_STOCK_CLAUDE_BLUEPRINT = 'native-claude';
/** Validate the controller-issued object, its live lifetime and frozen scope. */
export function requireCurrentBenchHostBinding(observations: Pick<CurrentSuBenchObservations, 'nativeGateway' | 'nativeAccountingBinding'>,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration' | 'armId' | 'seed'>) {
  const gateway = observations.nativeGateway && snapshotScopedInferenceGateway(observations.nativeGateway);
  const host = observations.nativeGateway && currentBenchHostGateways.get(observations.nativeGateway);
  const accounting = observations.nativeAccountingBinding;
  if (!gateway || !host || !host.active() || !accounting ||
      canonicalJson(accounting) !== canonicalJson(host.binding) || accounting.workspaceId !== opts.workspaceId ||
      accounting.runId !== opts.runId || accounting.preregHash !== opts.preregistration.preregHash ||
      accounting.assignmentId !== currentBenchAssignmentId(opts.runId, opts.armId, host.taskId, opts.seed)) {
    throw new Error('Current benchmark launch requires its active host-owned gateway and exact accounting binding.');
  }
  if (canonicalJson(opts.preregistration.config) !== host.protocol)
    throw new Error('Current benchmark launch requires the exact frozen protocol bound to its host-owned gateway.');
  return host;
}
function sessionHandle(handle: BenchHarnessHandle): string {
  return canonicalJson([handle.slug, handle.featureId, handle.worktreePath]);
}
function requireSessionBudget(observations: Pick<CurrentSuBenchObservations, 'nativeGateway' | 'nativeAccountingBinding' | 'sessionBudget'>,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration' | 'armId' | 'seed'>) {
  const host = requireCurrentBenchHostBinding(observations, opts), session = host.session;
  if (!session || session.receipt !== observations.sessionBudget || session.phase === 'retired' ||
      host.arm.control?.topology !== 'repeated-session')
    throw new Error('Fresh native session requires its active host-issued allowance.');
  return { host, session };
}
/** Consume once before enrollment/process creation. Rechecking the host route
 * alone cannot authorize another native session with the same allowance. */
export function beginCurrentBenchNativeSession(observations: Pick<CurrentSuBenchObservations, 'nativeGateway' | 'nativeAccountingBinding' | 'sessionBudget'>,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration' | 'armId' | 'seed'>,
  handle: BenchHarnessHandle): () => void {
  const host = requireCurrentBenchHostBinding(observations, opts);
  if (!observations.sessionBudget && host.arm.control?.topology !== 'repeated-session')
    return () => { requireCurrentBenchHostBinding(observations, opts); };
  const { session } = requireSessionBudget(observations, opts);
  if (session.phase !== 'admitted' || session.handle !== sessionHandle(handle))
    throw new Error('Fresh native session allowance was not admitted for this handle or was already used.');
  session.phase = 'launched';
  let spawned = false;
  return () => {
    if (requireSessionBudget(observations, opts).session !== session || session.phase !== 'launched' || spawned)
      throw new Error('Fresh native session allowance was retired, replaced or already spawned.');
    spawned = true;
  };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function currentBenchRunLabel(runId: string): string {
  if (!runId.trim()) throw new Error('Current benchmark execution requires a stable run id.');
  return `current-bench:${hash(runId).slice(0, 24)}:`;
}
export const currentBenchAttemptLabel = (runId: string, handle: BenchHarnessHandle) => `${currentBenchRunLabel(runId)}${hash(handle.slug).slice(0, 24)}:`;
const attemptLabel = currentBenchAttemptLabel;

function currentBenchLedgerEnabled(arm: CurrentBenchmarkProtocol['arms'][number]): boolean {
  // Uncontrolled legacy runs keep their existing workflow. Controlled runs
  // derive exposure only from the frozen arm, never a caller launch option.
  return arm.control?.capabilities['work-item-ledger'] !== 'off';
}
function currentBenchTaskInstruction(handle: BenchHarnessHandle, ledger: boolean): string {
  const task = 'Resolve the assigned benchmark task in this repository. Preserve your work in the checkout.';
  return ledger
    ? `${task} Use work_items:get or work_items:checkpoint with id=${handle.featureId} and harness=${handle.slug}. When finished, use work_items:complete with that exact id/harness, state="done", assumptions="none", and completion:{summary,testsRun,testResult,verifiedHow,filesChanged}. Name checkout-relative files.`
    : `${task} When finished, report your changes and verification in your final response. Name checkout-relative files.`;
}

export function currentBenchLaunchRequest(opts: CurrentSuBenchOptions, handle: BenchHarnessHandle, problem: string, context?: BenchmarkContextReceipt): LaunchArgs {
  resolveBenchWorkspace(opts.workspaceId);
  if (!opts.model.trim() || !opts.account.trim()) throw new Error('Current benchmark model/account must be explicit.');
  const arm = currentBenchmarkProtocolSchema.parse(opts.preregistration.config).arms.find(arm => arm.id === opts.armId);
  if (!arm) throw new Error('Current benchmark launch arm is not in the frozen protocol.');
  return {
    harness: handle.slug, cwd: handle.worktreePath, feature: handle.featureId, workItem: handle.featureId,
    brief: `${currentBenchTaskInstruction(handle, currentBenchLedgerEnabled(arm))}\n\n${problem}${context?.contextText ?? ''}`,
    independent: true, headless: true, count: 1, mcpTarget: 'spawn-host',
    // No human is present at this bounded assignment's console. Independent
    // launches have no fleet AUTO default; register it explicitly at bootstrap.
    extraArgs: ['--auto'],
    label: `${attemptLabel(opts.runId, handle)}solver`,
    idempotencyKey: `current-bench:${hash(`${opts.runId}:${handle.slug}`)}`,
    members: [{ role: 'su', agent: opts.agent, model: opts.model, effort: opts.effort, account: opts.account }],
  };
}
function payload(reply: unknown): Record<string, unknown> {
  if (!reply || typeof reply !== 'object') throw new Error('Native launch returned no receipt.');
  const obj = reply as Record<string, unknown>;
  // The native handler returns prose in content and its receipt in data.launch;
  // MCP clients expose that same data under structuredContent.
  for (const envelope of [obj.data, obj.structuredContent]) {
    if (!envelope || typeof envelope !== 'object') continue;
    const launch = (envelope as Record<string, unknown>).launch;
    if (launch && typeof launch === 'object' && !Array.isArray(launch)) return launch as Record<string, unknown>;
  }
  if (!Array.isArray(obj.content)) return obj;
  for (const part of obj.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { return payload(JSON.parse(part.text)); } catch { /* advisory block */ }
  }
  throw new Error('Native launch returned no structured receipt.');
}
function measuredIdentity(value: CurrentBenchIdentity | null): CurrentBenchIdentity | null {
  if (!value || value.measuredBy !== 'runtime-observation') return null;
  const fields = ['runtimeRevision', 'sourceRevision', 'model', 'effort', 'clientVersion', 'promptHash', 'toolsHash'] as const;
  if (fields.some(k => typeof value[k] !== 'string' || !value[k].trim())) return null;
  if (!Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.evidenceRefs) ||
      !value.evidenceRefs.length || value.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) return null;
  return value;
}
async function retirePrefix(ports: Pick<CurrentSuBenchPorts, 'listTasks' | 'killTask'>, workspaceId: string, labelPrefix: string): Promise<string[]> {
  const tasks = await ports.listTasks({ workspaceId, labelPrefix, includeEnded: true, limit: 1000 });
  if (tasks.length >= 1000) throw new Error('Benchmark cleanup census exceeded its bound; cleanup is unverified.');
  const retired: string[] = [];
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || typeof task.detail.label !== 'string' || !task.detail.label.startsWith(labelPrefix)) continue;
    const result = await ports.killTask(task.taskId);
    // The live benchmark port asks killTask to re-verify terminal residue. A
    // terminal row whose confined scope is positively empty returns `not_live`
    // with this detail; that is settled cleanup, not a failed teardown. Keep
    // rejecting every other `not_live` result because it may be an unconfined
    // or otherwise unverifiable residue row.
    if (!result.ok) {
      const verifiedEmpty = result.error === 'not_live' && result.detail?.includes('holds no live process right now; nothing to reap');
      if (result.error !== 'already_gone' && result.error !== 'task_not_found' && !verifiedEmpty)
        throw new Error(`Benchmark cleanup failed for ${task.taskId}: ${result.error}`);
    }
    retired.push(task.taskId);
  }
  return retired;
}
/** Explicit restart recovery for one interrupted run, never a workspace-wide sweep. */
export async function recoverCurrentBenchRun(ports: Pick<CurrentSuBenchPorts, 'listTasks' | 'killTask'>, opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId'>): Promise<string[]> {
  return retirePrefix(ports, resolveBenchWorkspace(opts.workspaceId), currentBenchRunLabel(opts.runId));
}
export function currentSuBenchHarnessDriver(lifecycle: BenchHarnessOps, ports: CurrentSuBenchPorts, opts: CurrentSuBenchOptions) {
  return currentBenchHarnessDriver(lifecycle, ports, opts, 'current-su');
}
export function currentStockBenchHarnessDriver(lifecycle: BenchHarnessOps, ports: CurrentStockBenchPorts, opts: CurrentSuBenchOptions) {
  if (opts.armId !== 'baseline' || !['codex', 'claude'].includes(opts.agent))
    throw new Error('Stock benchmark requires the frozen supported native baseline.');
  return currentBenchHarnessDriver(lifecycle, ports, opts, 'stock-native');
}
function currentBenchHarnessDriver(lifecycle: BenchHarnessOps, ports: CurrentSuBenchPorts | CurrentStockBenchPorts,
  opts: CurrentSuBenchOptions, kind: 'current-su' | 'stock-native') {
  const workspaceId = resolveBenchWorkspace(opts.workspaceId);
  currentBenchRunLabel(opts.runId);
  const registeredTasks = new Map<string, BenchTask>();
  const ops: BenchHarnessOps = {
    ...lifecycle,
    async createHarness(input) {
      const blueprint = opts.agent === 'claude' ? CURRENT_STOCK_CLAUDE_BLUEPRINT : CURRENT_STOCK_CODEX_BLUEPRINT;
      if (input.blueprintId !== (kind === 'stock-native' ? blueprint : FULL_SPINE_BLUEPRINT))
        throw new Error(kind === 'stock-native' ? 'Stock native driver refuses a different execution blueprint.' : 'Current su driver refuses a retired treatment blueprint.');
      return lifecycle.createHarness(input);
    },
    async addFeature(input) {
      await lifecycle.addFeature(input);
      registeredTasks.set(input.handle.slug, input.task);
    },
    async driveToDone({ handle, budget, timeoutMs, pollMs }): Promise<DriveResult> {
      const labelPrefix = attemptLabel(opts.runId, handle);
      const record: Record<string, unknown> = {
        kind,
        configured: { agent: opts.agent, model: opts.model, effort: opts.effort, account: opts.account },
        identityStatus: 'unknown', measured: null, launchReceipt: null, terminalReceipt: null,
        protocolIdentity: { status: 'unobserved' },
      };
      let result: DriveResult = { disposition: 'error', detail: 'Current benchmark launch did not complete.' };
      let started = false;
      try {
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before launch.', armMeta: { currentExecution: record } };
        const task = registeredTasks.get(handle.slug);
        if (!task) throw new Error('Current benchmark task has no registered assignment.');
        // A controlled protocol must name the topology this runner really executes. The stock driver IS the
        // stock-native reference (every product capability off, schema-enforced). The su driver declares
        // none: its assignment confinement (denyOutside + denyAmbientContext below) does not yet derive
        // which product capabilities it delivers, so a controlled su arm is refused rather than trusted.
        const allowance = ports.verifyGenerationBudget?.(budget, task.instanceId);
        if (allowance?.topology === 'repeated-session' && kind !== 'stock-native')
          throw new Error('Repeated-session allowances require the stock native driver.');
        const frozen = requireCurrentBenchmarkAssignment(opts.preregistration.config, { ...opts, taskId: task.instanceId,
          budget: allowance?.frozenBudget ?? budget,
          topology: allowance?.topology ?? (kind === 'stock-native' ? 'stock-native-reference' : undefined) });
        if (allowance?.sessionBudget) record.sessionBudget = allowance.sessionBudget;
        const frozenArm = frozen.arms.find(arm => arm.id === opts.armId)!;
        const { promptHashMode = 'exact-request-v1', proximus: hostReference, ...runtimePins } = frozenArm.runtime;
        if (hostReference) throw new Error('Proximus requires its host reference driver, not the native CLI driver.');
        const expectedIdentity = { ...runtimePins, effort: frozenArm.effort };
        const protocol = await ports.verifyPreregistration();
        record.preregistration = protocol;
        if (protocol.preregHash !== opts.preregistration.preregHash || !protocol.gitCommitSha?.trim() || !protocol.receiptRef?.trim()) {
          throw new Error('Benchmark pre-registration receipt is missing or does not match the frozen protocol.');
        }
        const requireContext = (context: BenchmarkContextReceipt) => {
          if (!context || context.schemaVersion !== 1 || context.workspaceId !== workspaceId || context.runId !== opts.runId ||
              context.preregHash !== protocol.preregHash || context.harnessSlug !== handle.slug ||
              context.assignmentId !== currentBenchAssignmentId(opts.runId, opts.armId, task.instanceId, opts.seed) ||
              context.corpusHash !== frozen.context.corpusHash || context.memoryHash !== frozen.context.memoryHash ||
              typeof context.contextText !== 'string' || !context.contextText.length ||
              hash(context.contextText) !== context.contextTextSha256 || !/^sha256:[a-f0-9]{64}$/.test(context.receiptRef))
            throw new Error('Benchmark initial context receipt does not match the frozen assignment.');
          return context;
        };
        const initialContext = requireContext(await ports.restoreContext(handle, task.instanceId));
        const { contextText: _text, ...contextEvidence } = initialContext;
        record.initialContext = { status: 'restored', ...contextEvidence };
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before admission.', armMeta: { currentExecution: record } };
        const admission = await ports.admit(handle, budget, task.instanceId);
        record.admission = admission;
        if (!admission.receiptRef?.trim()) throw new Error('Benchmark budget admission has no durable receipt.');
        if (!admission.admitted) return { disposition: 'budget-exhausted', armMeta: { currentExecution: record } };
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before launch.', armMeta: { currentExecution: record } };
        const startedAt = lifecycle.now();
        const deadline = startedAt + (budget.maxWallClockMs != null ? Math.min(timeoutMs, budget.maxWallClockMs) : timeoutMs);
        if (!(deadline > startedAt)) return { disposition: 'budget-exhausted', armMeta: { currentExecution: record } };
        const rereadContext = requireContext(await ports.verifyContext(handle, task.instanceId));
        if (canonicalJson(rereadContext) !== canonicalJson(initialContext)) throw new Error('Benchmark initial context changed before native generation.');
        record.initialContext = { status: 'verified-before-generation', ...contextEvidence };
        // A transport failure can happen after spawning: cleanup uses the durable label.
        started = true;
        const receipt = payload(await ('launchNative' in ports
          ? ports.launchNative({ handle, task, context: rereadContext })
          : ports.launch(currentBenchLaunchRequest(opts, handle, task.problemStatement, rereadContext))));
        record.launchReceipt = receipt;
        const tasks = receipt.tasks as Array<{ taskId?: string; ownerId?: string; label?: string;
          kickoffProof?: { persisted?: boolean; nativeRef?: string } }> | undefined;
        const launchEvidence = receipt.launchEvidence as { processOpened?: number; sessionRegistered?: number; firstTurn?: boolean | null } | undefined;
        const launched = Array.isArray(tasks) && tasks.length === 1 ? tasks[0] : undefined;
        // The maintained launcher can register a native kickoff before observing
        // its first turn. Admit that evidenced pending state into this same bounded
        // loop; only a runtime measurement can later verify successful generation.
        const pendingStart = receipt.agentStarted === null && receipt.opened === 1 && receipt.failed === 0 && receipt.partial === false &&
          launchEvidence?.processOpened === 1 && launchEvidence.sessionRegistered === 1 && launchEvidence.firstTurn === null &&
          typeof launched?.ownerId === 'string' && !!launched.ownerId.trim() && launched.label === `${labelPrefix}solver` &&
          launched.kickoffProof?.persisted === true && typeof launched.kickoffProof.nativeRef === 'string' && !!launched.kickoffProof.nativeRef.trim();
        if ((receipt.agentStarted !== true && !pendingStart) || typeof launched?.taskId !== 'string' || !launched.taskId.trim())
          throw new Error('Native benchmark launch has no verified single-agent start.');
        const taskId = launched.taskId;
        record.nativeStart = { status: pendingStart ? 'pending' : 'observed', taskId, ownerId: launched.ownerId ?? null };
        for (;;) {
          const task = await ports.getTask(taskId);
          if (!task || task.taskId !== taskId || task.workspaceId !== workspaceId || task.detail.label !== `${labelPrefix}solver` ||
              pendingStart && task.detail.coordOwnerId !== launched.ownerId) throw new Error('Native benchmark task identity/scope could not be verified.');
          record.terminalReceipt = task;
          if (typeof task.detail.nativeStreamError === 'string') throw new Error(task.detail.nativeStreamError);
          const identity = measuredIdentity(await ports.readIdentity(task));
          record.measured = identity;
          record.identityStatus = identity ? 'measured' : 'unknown';
          record.nativeStart = { status: identity ? 'measured' : pendingStart ? 'pending' : 'observed', taskId, ownerId: launched.ownerId ?? null };
          // Compare actual request exposure, including the post-confinement
          // tool catalog, to the committed pins on every observed turn. A prior
          // matching observation cannot fill a missing completion measurement.
          const comparedIdentity = identity && promptHashMode === 'codex-native-template-v1'
            ? { ...identity, promptHash: identity.promptTemplateHash ?? '' } : identity;
          const mismatchFields = comparedIdentity ? (Object.keys(expectedIdentity) as Array<keyof typeof expectedIdentity>)
            .filter(field => comparedIdentity[field] !== expectedIdentity[field]) : [];
          record.protocolIdentity = { status: identity ? (mismatchFields.length ? 'mismatch' : 'matched') : 'unobserved',
            expected: expectedIdentity, promptHashMode, mismatchFields };
          if (opts.signal?.aborted) { result = { disposition: 'timeout', detail: 'Benchmark cancelled during generation.' }; break; }
          if (lifecycle.now() >= deadline) { result = { disposition: 'timeout', detail: 'Benchmark generation wall-clock cap reached.' }; break; }
          if (mismatchFields.length) throw new Error(`Benchmark observed identity differs from the frozen protocol: ${mismatchFields.join(', ')}.`);
          const completion = await ports.readCompletion(handle);
          if ((completion === 'done' || task.state === 'exited' && task.exitCode === 0) && !identity) {
            throw new Error('Benchmark completion identity is unobserved; the frozen protocol could not be verified.');
          }
          if (completion === 'done') { result = { disposition: 'done' }; break; }
          if (completion === 'failed') { result = { disposition: 'escalate', detail: 'Benchmark task ended without completion.' }; break; }
          if (task.state !== 'running' && task.state !== 'pending') {
            result = task.state === 'exited' && task.exitCode === 0 ? { disposition: 'done' } :
              { disposition: 'error', detail: `Native generation ended ${task.state}, exit=${task.exitCode ?? 'unobserved'}.` };
            break;
          }
          const cost = await (ports.collectCost ? ports.collectCost({ handle, workspaceId }) :
            lifecycle.collectCost({ handle, workspaceId }));
          if (!hasValidBenchRunCost(cost)) throw new Error('Invalid benchmark spend measurement; retiring the native task.');
          const prior = allowance?.sessionBudget?.priorUsage;
          const costUsd = cost.costUsd - (prior?.costUsd ?? 0);
          const tokens = cost.tokensIn + cost.tokensOut + (cost.tokensCacheRead ?? 0) + (cost.tokensCacheWrite ?? 0) -
            ((prior?.tokensIn ?? 0) + (prior?.tokensOut ?? 0) + (prior?.tokensCacheRead ?? 0) + (prior?.tokensCacheWrite ?? 0));
          if (costUsd < -1e-10 || tokens < 0) throw new Error('Current native usage fell below its accounted session baseline.');
          if ((budget.maxUsd != null && costUsd >= budget.maxUsd) ||
              (budget.maxTokens != null && tokens >= budget.maxTokens)) { result = { disposition: 'budget-exhausted' }; break; }
          await ports.sleep(Math.max(1, Math.min(pollMs, deadline - lifecycle.now())));
        }
      } catch (error) {
        result = { disposition: 'error', detail: error instanceof Error ? error.message : String(error) };
      } finally {
        if (started) {
          try { record.retiredTaskIds = await retirePrefix(ports, workspaceId, labelPrefix); }
          catch (error) { result = { disposition: 'error', detail: error instanceof Error ? error.message : String(error) }; }
        }
      }
      return { ...result, armMeta: { currentExecution: record } };
    },
    async collectCost(input) {
      if (ports.collectCost) return ports.collectCost(input);
      // TEMPORARY MITIGATION (WI-10007971): the legacy harness sum does not
      // prove complete native/retry/recovery usage. Retain its known subtotal
      // while full source-bound native accounting is implemented in this lane.
      return { ...await lifecycle.collectCost(input), costUsdMeasurementMissing: true };
    },
    async teardown(input) {
      registeredTasks.delete(input.handle.slug);
      try { await lifecycle.teardown(input); } finally { await ports.releaseGateway?.(); }
    },
  };
  return liveBenchHarnessDriver(ops, { ...opts, workspaceId, maxTransientRetries: 0 });
}
/** Preserve the authenticated caller context; never manufacture benchmark authority. */
export async function readCurrentBenchCompletion(
  handle: BenchHarnessHandle, scope: DbScope & { workspaceId: string },
): Promise<'done' | 'failed' | null> {
  const workspaceId = resolveBenchWorkspace(scope.workspaceId);
  const { resolveDb } = await import('./reproducibility/db');
  const { sql } = resolveDb({ ...scope, workspaceId });
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${handle.slug}
       AND feature_id = ${handle.featureId} LIMIT 1
  `;
  if (!row) return null;
  const normalized = normalizeFeatureStateInput(row.status);
  if (!normalized.ok) return null;
  return normalized.state === 'done' ? 'done' : normalized.state === 'dropped' ? 'failed' : null;
}

/** Host allocation of private subjects and exact fires, never candidate metadata.
 * The status latch retains only the latest fire: capture each edge before the
 * next transition. An overwritten latch cannot prove the earlier edge. */
export function currentBenchWorkloadTransitionReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string;
  notBefore: string;
  receipts: Array<{ receiptRef: string; subjectId: string; transitionId: string; index: number }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId);
  const start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (!present(frozen.workspaceId) || !present(frozen.harnessSlug) || !present(frozen.runId) ||
      !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) || !Number.isFinite(start) ||
      !frozen.receipts.length || frozen.receipts.some(row =>
        ![row.receiptRef, row.subjectId, row.transitionId].every(present) ||
        !Number.isSafeInteger(row.index) || row.index < 0) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length)
    throw new Error('Workload transition reader requires an explicit private allocation and unique exact receipts.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const { resolveDb } = await import('./reproducibility/db');
    const { keyFireId } = await import('../events/await/store');
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const eventKey = `work-item:status:${receipt.subjectId}`;
    const [row] = await sql<{
      first_us: string; fire_count: number; last_fired_at: Date; last_fired_by: string; last_payload: Record<string, unknown>;
    }[]>`
      SELECT floor(extract(epoch FROM fire.first_fired_at) * 1000000)::bigint::text AS first_us,
             fire.fire_count, fire.last_fired_at, fire.last_fired_by, fire.last_payload
        FROM harness_shared.event_key_fires AS fire
       WHERE fire.workspace_id = ${workspaceId} AND fire.event_key = ${eventKey}
         AND EXISTS (SELECT 1 FROM harness_shared.work_items AS item
                      WHERE item.workspace_id = ${workspaceId} AND item.harness_slug = ${frozen.harnessSlug}
                        AND item.feature_id = ${receipt.subjectId})
    `;
    const payload = row?.last_payload;
    const at = row?.last_fired_at instanceof Date ? row.last_fired_at.getTime() : NaN;
    const count = Number(row?.fire_count);
    if (!row || !Number.isSafeInteger(count) || count < 1 || !/^\d+$/.test(row.first_us) ||
        keyFireId(eventKey, { firstFiredAtUs: row.first_us, count }) !== ref ||
        row.last_fired_by !== 'work-items' || !Number.isFinite(at) || at < start ||
        !payload || payload.id !== receipt.subjectId || payload.harness !== frozen.harnessSlug ||
        typeof payload.prevState !== 'string' || !present(payload.prevState) ||
        typeof payload.state !== 'string' || !present(payload.state) || payload.prevState === payload.state) return null;
    return [{ index: receipt.index, kind: 'tool-result', name: 'work-item:status',
      at: new Date(at).toISOString(), content: canonicalJson(payload),
      metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref,
        durableTransition: { id: receipt.transitionId,
          subjectRef: `work-item:${frozen.harnessSlug}:${receipt.subjectId}`, from: payload.prevState, to: payload.state } } }];
  };
}

/** Capture a queued ticket's live grant from the private lock side-store and
 * its exact bridge fire. Historical tickets and overwritten fires cannot prove
 * a held grant. This establishes the queued-to-granted edge only; acquire-call
 * identity, denial, release and provider consumption require separate sources. */
export function currentBenchWorkloadLockGrantReader(options: DbScope & {
  locksSql?: import('postgres').Sql;
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string;
  coordinationDomain: string; notBefore: string;
  receipts: Array<{ receiptRef: string; subjectId: string; transitionId: string; index: number;
    ticketId: string; lockId: string; ownerId: string; ownerLabel: string; intent: string;
    paths: string[]; queuedAt: string }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, locksSql: suppliedLocksSql, ...allocation } = options;
  const frozen = structuredClone(allocation), workspaceId = resolveBenchWorkspace(frozen.workspaceId);
  const start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && !!value.trim();
  const uuid = (value: string) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const pathsValid = (paths: string[]) => Array.isArray(paths) && paths.length > 0 && paths.length <= 50 &&
    paths.every(path => present(path) && path.length <= 4096 && !path.includes('\\') &&
      path.split('/').every(part => part !== '' && part !== '.' && part !== '..')) && new Set(paths).size === paths.length;
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId, frozen.coordinationDomain].every(present) ||
      !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) || !Number.isFinite(start) || !frozen.receipts.length ||
      frozen.receipts.some(row => ![row.receiptRef, row.subjectId, row.transitionId, row.ownerId, row.ownerLabel, row.intent].every(present) ||
        !uuid(row.ticketId) || !uuid(row.lockId) || !pathsValid(row.paths) ||
        !Number.isSafeInteger(row.index) || row.index < 0 || !Number.isFinite(Date.parse(row.queuedAt)) || Date.parse(row.queuedAt) < start) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.ticketId)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length)
    throw new Error('Workload lock-grant reader requires a private allocation and unique exact tickets and paths.');
  const root = lstatSync(frozen.coordinationDomain, { bigint: true });
  if (!root.isDirectory() || realpathSync(frozen.coordinationDomain) !== frozen.coordinationDomain ||
      frozen.coordinationDomain === realpathSync(REPO_ROOT))
    throw new Error('Workload lock-grant reader requires a canonical private coordination domain.');
  const unchangedRoot = () => {
    const current = lstatSync(frozen.coordinationDomain, { bigint: true });
    return current.isDirectory() && current.dev === root.dev && current.ino === root.ino &&
      realpathSync(frozen.coordinationDomain) === frozen.coordinationDomain;
  };
  const samePaths = (actual: string[], expected: string[]) => Array.isArray(actual) &&
    canonicalJson([...actual].sort()) === canonicalJson([...expected].sort());
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { getTxPool, readWaiterStatus }, { keyFireId }, { lockGrantKey }] = await Promise.all([
      import('./reproducibility/db'), import('../agent-tools/locks/su-lock-store'),
      import('../events/await/store'), import('../agent-tools/locks/lock-grant-key'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const eventKey = lockGrantKey(receipt.ticketId);
    try {
      if (!unchangedRoot()) return null;
      return await (suppliedLocksSql ?? getTxPool()).begin(async tx => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        const waiters = await tx<{ owner: string; owner_label: string; intent: string; goal_ref: string;
          coordination_domain: string; paths: string[]; queued_ts: Date }[]>`
          SELECT owner, owner_label, intent, goal_ref, coordination_domain, paths, queued_ts
            FROM agent_lock_waiters WHERE ticket_id = ${receipt.ticketId}::uuid
        `;
        const waiter = waiters[0];
        if (waiters.length !== 1 || waiter.coordination_domain !== frozen.coordinationDomain ||
            waiter.owner !== receipt.ownerId || waiter.owner_label !== receipt.ownerLabel ||
            waiter.intent !== receipt.intent || waiter.goal_ref !== receipt.subjectId ||
            !samePaths(waiter.paths, receipt.paths) || !(waiter.queued_ts instanceof Date) ||
            waiter.queued_ts.toISOString() !== new Date(receipt.queuedAt).toISOString()) return null;
        const status = await readWaiterStatus(tx as unknown as import('postgres').Sql, receipt.ticketId);
        if (status.status !== 'granted' || status.granted_lock_id !== receipt.lockId ||
            !(status.granted_expires_ts instanceof Date) || !samePaths(status.paths ?? [], receipt.paths)) return null;
        const locks = await tx<{ path: string; owner: string; owner_label: string; intent: string; goal_ref: string;
          acquired_ts: Date; expires_ts: Date }[]>`
          SELECT path, owner, owner_label, intent, goal_ref, acquired_ts, expires_ts FROM agent_file_locks
           WHERE coordination_domain = ${frozen.coordinationDomain} AND lock_id = ${receipt.lockId}::uuid
        `;
        if (!samePaths(locks.map(row => row.path), receipt.paths) || locks.some(row =>
          row.owner !== receipt.ownerId || row.owner_label !== receipt.ownerLabel || row.intent !== receipt.intent ||
          row.goal_ref !== receipt.subjectId || !(row.acquired_ts instanceof Date) ||
          row.acquired_ts < waiter.queued_ts || !(row.expires_ts instanceof Date) ||
          row.expires_ts.getTime() !== status.granted_expires_ts!.getTime())) return null;
        const fires = await sql<{ first_us: string; fire_count: number; last_fired_at: Date;
          last_fired_by: string; last_payload: Record<string, unknown> }[]>`
          SELECT floor(extract(epoch FROM fire.first_fired_at) * 1000000)::bigint::text AS first_us,
                 fire.fire_count, fire.last_fired_at, fire.last_fired_by, fire.last_payload
            FROM harness_shared.event_key_fires fire
           WHERE fire.workspace_id = ${workspaceId} AND fire.event_key = ${eventKey}
             AND (SELECT count(*) FROM harness_shared.work_items item
                   WHERE item.workspace_id = ${workspaceId} AND item.harness_slug = ${frozen.harnessSlug}
                     AND item.feature_id = ${receipt.subjectId}) = 1
        `;
        const fire = fires[0], count = Number(fire?.fire_count), payload = fire?.last_payload;
        const at = fire?.last_fired_at instanceof Date ? fire.last_fired_at.getTime() : NaN;
        if (fires.length !== 1 || !/^\d+$/.test(fire.first_us) || !Number.isSafeInteger(count) || count < 1 ||
            keyFireId(eventKey, { firstFiredAtUs: fire.first_us, count }) !== ref ||
            fire.last_fired_by !== 'lock-grant-bridge' || !Number.isFinite(at) || at < start ||
            at < waiter.queued_ts.getTime() || at >= status.granted_expires_ts.getTime() ||
            locks.some(row => row.acquired_ts.getTime() > at) || payload?.granted !== true ||
            payload.ticket_id !== receipt.ticketId || payload.lock_id !== receipt.lockId ||
            payload.expires_ts !== status.granted_expires_ts.toISOString() ||
            !samePaths(payload.paths as string[], receipt.paths)) return null;
        const stillHeld = await readWaiterStatus(tx as unknown as import('postgres').Sql, receipt.ticketId);
        if (stillHeld.status !== 'granted' || !unchangedRoot()) return null;
        return [{ index: receipt.index, kind: 'tool-result' as const, name: 'lock:grant',
          at: new Date(at).toISOString(), content: canonicalJson(payload),
          metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref,
            durableTransition: { id: receipt.transitionId,
              subjectRef: `file-lock:${frozen.coordinationDomain}:${receipt.ticketId}`, from: 'waiting', to: 'granted' },
            lockGrantSource: { basis: 'live-private-lock-side-store-and-bridge', coordinationDomain: frozen.coordinationDomain,
              rootDevice: String(root.dev), rootInode: String(root.ino),
              ticketId: receipt.ticketId, lockId: receipt.lockId, ownerId: receipt.ownerId, ownerLabel: receipt.ownerLabel,
              paths: receipt.paths, queuedAt: waiter.queued_ts.toISOString(), expiresAt: status.granted_expires_ts.toISOString() } } }];
      });
    } catch { return null; }
  };
}

/** The execution host allocates refs and paths before candidate generation.
 * A candidate ref cannot select a filesystem path, workspace or subject. Byte
 * integrity is checked by replayResolvedWorkloadEvidence, separately from this
 * private membership/path read. */
export interface CurrentBenchLockStateAllocation {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string;
  coordinationDomain: string; notBefore: string;
  receipt: { receiptRef: string; subjectId: string; index: number;
    phase: 'held' | 'contended' | 'queued' | 'granted' | 'released'; paths: string[];
    holder: { ownerId: string; ownerLabel: string; intent: string; lockId: string };
    waiter?: { ownerId: string; ownerLabel: string; intent: string; ticketId: string; queuedAt: string; lockId?: string } };
}

/** Sample the actual private side-store before its rows are released/overwritten.
 * This is state evidence, not evidence that a native call caused the state.
 * In particular, a contended sample is not itself an acquire-denial receipt.
 * The host freezes this observation through its existing run checkpoint. */
export function currentBenchWorkloadLockStateReader(options: CurrentBenchLockStateAllocation & DbScope & {
  locksSql?: import('postgres').Sql;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, locksSql: suppliedLocksSql, ...allocation } = options;
  const frozen = structuredClone(allocation), receipt = frozen.receipt;
  const present = (value: unknown) => typeof value === 'string' && !!value.trim();
  const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const start = Date.parse(frozen.notBefore), waiter = receipt.waiter;
  const actorValid = (actor: { ownerId: string; ownerLabel: string; intent: string }) =>
    [actor.ownerId, actor.ownerLabel, actor.intent].every(present);
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId, frozen.coordinationDomain,
      receipt.receiptRef, receipt.subjectId].every(present) || !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) ||
      !Number.isFinite(start) || !Number.isSafeInteger(receipt.index) || receipt.index < 0 ||
      !['held', 'contended', 'queued', 'granted', 'released'].includes(receipt.phase) ||
      !actorValid(receipt.holder) || !uuid(receipt.holder.lockId) ||
      !Array.isArray(receipt.paths) || !receipt.paths.length || receipt.paths.length > 50 ||
      new Set(receipt.paths).size !== receipt.paths.length || receipt.paths.some(path =>
        !present(path) || path.length > 4096 || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) ||
      (['queued', 'granted'].includes(receipt.phase) && !waiter) ||
      (waiter && (!actorValid(waiter) || waiter.ownerId === receipt.holder.ownerId || !uuid(waiter.ticketId) ||
        !Number.isFinite(Date.parse(waiter.queuedAt)) || Date.parse(waiter.queuedAt) < start ||
        (waiter.lockId !== undefined && !uuid(waiter.lockId)) ||
        (['granted', 'released'].includes(receipt.phase) && !uuid(waiter.lockId)))))
    throw new Error('Workload lock-state reader requires an exact private phase allocation.');
  const root = lstatSync(frozen.coordinationDomain, { bigint: true });
  if (!root.isDirectory() || realpathSync(frozen.coordinationDomain) !== frozen.coordinationDomain ||
      frozen.coordinationDomain === realpathSync(REPO_ROOT))
    throw new Error('Workload lock-state reader requires a canonical private coordination domain.');
  const unchangedRoot = () => {
    const current = lstatSync(frozen.coordinationDomain, { bigint: true });
    return current.isDirectory() && current.dev === root.dev && current.ino === root.ino &&
      realpathSync(frozen.coordinationDomain) === frozen.coordinationDomain;
  };
  const samePaths = (paths: unknown, expected: string[]) => Array.isArray(paths) &&
    canonicalJson([...paths].sort()) === canonicalJson([...expected].sort());
  return async (ref, binding) => {
    if (ref !== receipt.receiptRef || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { getTxPool }] = await Promise.all([
      import('./reproducibility/db'), import('../agent-tools/locks/su-lock-store'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId: frozen.workspaceId });
    try {
      if (!unchangedRoot()) return null;
      const subjects = await sql`SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id = ${resolveBenchWorkspace(frozen.workspaceId)} AND harness_slug = ${frozen.harnessSlug}
          AND feature_id = ${receipt.subjectId} LIMIT 2`;
      if (subjects.length !== 1) return null;
      return await (suppliedLocksSql ?? getTxPool()).begin(async tx => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        const [{ at }] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
        const atMs = at.getTime();
        const locks = await tx<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(l) AS row FROM agent_file_locks l
          WHERE coordination_domain = ${frozen.coordinationDomain} ORDER BY path LIMIT 101`;
        const tickets = await tx<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(w) AS row FROM agent_lock_waiters w
          WHERE coordination_domain = ${frozen.coordinationDomain} ORDER BY ticket_id LIMIT 101`;
        if (locks.length > 100 || tickets.length > 100 || !Number.isFinite(atMs) || atMs < start) return null;
        const held = locks.map(row => row.row), queued = tickets.map(row => row.row);
        const date = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
        const holderExpected = ['held', 'contended', 'queued'].includes(receipt.phase);
        const actor = holderExpected ? receipt.holder : waiter;
        const lockId = holderExpected ? receipt.holder.lockId : waiter?.lockId;
        if (receipt.phase === 'released' ? held.length !== 0 : (!actor ||
          !samePaths(held.map(row => row.path), receipt.paths) || held.some(row =>
            row.lock_id !== lockId || row.owner !== actor.ownerId || row.owner_label !== actor.ownerLabel ||
            row.intent !== actor.intent || row.goal_ref !== receipt.subjectId ||
            !Number.isFinite(date(row.acquired_ts)) || date(row.acquired_ts) < start || date(row.acquired_ts) > atMs ||
            !Number.isFinite(date(row.expires_ts)) || date(row.expires_ts) <= atMs))) return null;
        if (['held', 'contended'].includes(receipt.phase)) {
          if (queued.length !== 0) return null;
        } else if (waiter) {
          const ticket = queued[0];
          if (queued.length !== 1 || ticket.ticket_id !== waiter.ticketId || ticket.owner !== waiter.ownerId ||
            ticket.owner_label !== waiter.ownerLabel || ticket.intent !== waiter.intent || ticket.goal_ref !== receipt.subjectId ||
            !samePaths(ticket.paths, receipt.paths) || !Number.isFinite(date(ticket.queued_ts)) ||
            date(ticket.queued_ts) !== Date.parse(waiter.queuedAt) || date(ticket.queued_ts) > atMs ||
            ticket.status !== (receipt.phase === 'queued' ? 'waiting' : 'granted') ||
            (receipt.phase === 'queued' && (!Number.isFinite(date(ticket.wait_until)) || date(ticket.wait_until) <= atMs)) ||
            (receipt.phase === 'queued' ? ticket.granted_lock_id !== null : ticket.granted_lock_id !== waiter.lockId) ||
            (receipt.phase === 'granted' && (!Number.isFinite(date(ticket.granted_expires_ts)) ||
              held.some(row => date(row.expires_ts) !== date(ticket.granted_expires_ts) ||
                date(row.acquired_ts) < date(ticket.queued_ts))))) return null;
        } else if (queued.length) return null;
        if (!unchangedRoot()) return null;
        const content = canonicalJson({ locks: held, waiters: queued });
        return [{ index: receipt.index, kind: 'tool-result' as const, name: `lock:state:${receipt.phase}`,
          at: at.toISOString(), content, metadata: { ...binding, receiptRef: ref,
            lockStateSource: { basis: 'live-private-lock-side-store', phase: receipt.phase,
              coordinationDomain: frozen.coordinationDomain, rootDevice: String(root.dev), rootInode: String(root.ino),
              snapshotSha256: createHash('sha256').update(content).digest('hex') } } }];
      });
    } catch { return null; }
  };
}

export function currentBenchWorkloadArtifactReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string; checkoutRoot: string;
  artifacts: Array<{ ref: string; subjectId: string; path: string; maxBytes: number }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readArtifact'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId);
  const present = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId, frozen.checkoutRoot].every(present) ||
      !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) || !frozen.artifacts.length ||
      frozen.artifacts.some(row => ![row.ref, row.subjectId, row.path].every(present) ||
        !Number.isSafeInteger(row.maxBytes) || row.maxBytes < 1 || row.maxBytes > 16 * 1024 * 1024) ||
      new Set(frozen.artifacts.map(row => row.ref)).size !== frozen.artifacts.length ||
      new Set(frozen.artifacts.map(row => row.path)).size !== frozen.artifacts.length)
    throw new Error('Workload artifact reader requires an explicit private allocation and unique bounded artifacts.');
  const root = lstatSync(frozen.checkoutRoot, { bigint: true });
  if (!root.isDirectory() || realpathSync(frozen.checkoutRoot) !== frozen.checkoutRoot ||
      frozen.checkoutRoot === realpathSync(REPO_ROOT))
    throw new Error('Workload artifact reader requires a canonical private checkout root.');
  const unchangedRoot = () => {
    const current = lstatSync(frozen.checkoutRoot, { bigint: true });
    return current.isDirectory() && current.dev === root.dev && current.ino === root.ino &&
      realpathSync(frozen.checkoutRoot) === frozen.checkoutRoot;
  };
  const allowed = new Map(frozen.artifacts.map(row => [row.ref, row]));
  return async (ref, binding) => {
    const artifact = allowed.get(ref);
    if (!artifact || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const { resolveDb } = await import('./reproducibility/db');
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const rows = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${frozen.harnessSlug}
         AND feature_id = ${artifact.subjectId}
    `;
    if (rows.length !== 1) return null;
    try {
      if (!unchangedRoot()) return null;
      const bytes = readContainedBenchmarkFile(frozen.checkoutRoot, artifact.path, artifact.maxBytes);
      return unchangedRoot() ? bytes : null;
    }
    catch { return null; }
  };
}

/** Resolve an exact stored grade, separately from task exit or provider output.
 * Full row pins detect re-emission under the deterministic rollout id. The
 * recorded timestamps are the original emission, not a later re-grade time.
 * This is grade-record provenance; the host must separately verify the actual
 * grader execution and committed preregistration before accepting a trial. */
export function currentBenchWorkloadGradeReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string;
  notBefore: string; preregHash: string; protocol: CurrentBenchmarkProtocol;
  receipts: Array<{ receiptRef: string; subjectId: string; rolloutId: string; taskId: string; arm: string; seed: number;
    index: number; outcomeId: string; graderRef: string; resultSha256: string; rolloutSha256: string;
    submissionSha256: string; rawGraderOutputSha256: string }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation), workspaceId = resolveBenchWorkspace(frozen.workspaceId);
  const start = Date.parse(frozen.notBefore), protocol = currentBenchmarkProtocolSchema.parse(frozen.protocol);
  const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const graderRef = `benchmark-grader:${protocol.grader.family}@${protocol.grader.version}`;
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId].every(present) ||
      !digest(frozen.trialBindingHash) || !digest(frozen.preregHash) || hash(protocol) !== frozen.preregHash ||
      protocol.runId !== frozen.runId || !Number.isFinite(start) || !frozen.receipts.length ||
      frozen.receipts.some(row => ![row.receiptRef, row.subjectId, row.taskId, row.arm, row.outcomeId].every(present) ||
        row.graderRef !== graderRef || !protocol.taskIds.includes(row.taskId) || !protocol.seeds.includes(row.seed) ||
        !protocol.arms.some(arm => arm.id === row.arm) || !Number.isSafeInteger(row.index) || row.index < 0 ||
        ![row.rolloutId, row.resultSha256, row.rolloutSha256, row.submissionSha256, row.rawGraderOutputSha256].every(digest)) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.rolloutId)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length)
    throw new Error('Workload grade reader requires a frozen private protocol and unique pinned grade records.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { rolloutIdFor }] = await Promise.all([
      import('./reproducibility/db'), import('./reproducibility/emit'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const rows = await sql<{ result: unknown; rollout: unknown; prereg: unknown }[]>`
      SELECT to_jsonb(result) AS result, to_jsonb(rollout) AS rollout, to_jsonb(prereg) AS prereg
        FROM harness_shared.benchmark_run_result result
        JOIN harness_shared.benchmark_rollout rollout ON rollout.rollout_id = result.rollout_id
          AND rollout.workspace_id = result.workspace_id
        JOIN harness_shared.benchmark_prereg prereg ON prereg.prereg_hash = result.prereg_hash
          AND prereg.workspace_id = result.workspace_id
       WHERE result.workspace_id = ${workspaceId} AND result.run_id = ${frozen.runId}
         AND result.rollout_id = ${receipt.rolloutId}
         AND (SELECT count(*) FROM harness_shared.work_items item
               WHERE item.workspace_id = ${workspaceId} AND item.harness_slug = ${frozen.harnessSlug}
                 AND item.feature_id = ${receipt.subjectId}) = 1
    `;
    if (rows.length !== 1) return null;
    try {
      const decode = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
      const result = decode(rows[0].result), rollout = decode(rows[0].rollout), prereg = decode(rows[0].prereg);
      const suite = result.suite, at = Date.parse(String(result.created_at)), rolloutAt = Date.parse(String(rollout.created_at));
      const preregAt = Date.parse(String(prereg.created_at)), suites = prereg.suites;
      const arm = protocol.arms.find(value => value.id === receipt.arm)!;
      if (hash(result) !== receipt.resultSha256 || hash(rollout) !== receipt.rolloutSha256 ||
          !present(suite) || !Array.isArray(suites) || suites.length !== 1 || suites[0] !== suite ||
          rolloutIdFor(frozen.runId, suite, receipt.taskId, receipt.arm, receipt.seed) !== receipt.rolloutId ||
          [result, rollout].some(row => row.workspace_id !== workspaceId || row.run_id !== frozen.runId ||
            row.rollout_id !== receipt.rolloutId || row.prereg_hash !== frozen.preregHash || row.suite !== suite ||
            row.task_id !== receipt.taskId || row.arm !== receipt.arm || row.seed !== receipt.seed || row.model_id !== arm.model ||
            row.grader_family !== protocol.grader.family || row.grader_version !== protocol.grader.version) ||
          prereg.workspace_id !== workspaceId || prereg.run_id !== frozen.runId || prereg.prereg_hash !== frozen.preregHash ||
          hash(prereg.config) !== frozen.preregHash || hash(rollout.config_snapshot) !== frozen.preregHash ||
          prereg.git_committed !== true || !/^[a-f0-9]{40}$/.test(String(prereg.git_commit_sha)) ||
          ![at, rolloutAt, preregAt].every(Number.isFinite) || at < start || rolloutAt < start || preregAt >= start ||
          result.generation_status !== 'completed' || result.generation_error !== null || typeof result.resolved !== 'boolean' ||
          result.grader_status !== (result.resolved ? 'passed' : 'failed') ||
          !present(result.harness_version) || result.harness_version !== rollout.harness_version ||
          result.submission_ref !== `rollout:${receipt.rolloutId}#submission` ||
          result.raw_grader_output_ref !== `rollout:${receipt.rolloutId}#grader` ||
          !present(rollout.submission) || !present(rollout.raw_grader_output) ||
          createHash('sha256').update(rollout.submission).digest('hex') !== receipt.submissionSha256 ||
          createHash('sha256').update(rollout.raw_grader_output).digest('hex') !== receipt.rawGraderOutputSha256) return null;
      const outcome = { id: receipt.outcomeId, value: result.resolved, graderRef };
      return [{ index: receipt.index, kind: 'tool-result', name: 'benchmark:grade', at: new Date(at).toISOString(),
        content: canonicalJson(outcome), metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash,
          receiptRef: ref, workloadOutcome: outcome,
          gradeSource: { basis: 'stored-benchmark-grade', rolloutId: receipt.rolloutId, preregHash: frozen.preregHash,
            taskId: receipt.taskId, arm: receipt.arm, seed: receipt.seed, resultSha256: receipt.resultSha256,
            rolloutSha256: receipt.rolloutSha256, submissionSha256: receipt.submissionSha256,
            rawGraderOutputSha256: receipt.rawGraderOutputSha256 } } }];
    } catch { return null; }
  };
}

/** Capture the exact authored checkpoint before the next checkpoint write.
 * The journal's note may be truncated; only its hash-bound latest-update span
 * in the complete current note proves the authored bytes. Old/evicted journal
 * entries cannot be reconstructed as current checkpoint authority. */
export function currentBenchWorkloadCheckpointReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string; notBefore: string;
  receipts: Array<{ receiptRef: string; subjectId: string; transitionId: string; index: number;
    at: number; checkpointSha256: string; fromState: string;
    subjectFingerprint: import('../carry-note').WorkItemSubjectFingerprint }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId), start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && value.trim().length > 0;
  const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId].every(present) ||
      !digest(frozen.trialBindingHash) || !Number.isFinite(start) || !frozen.receipts.length ||
      frozen.receipts.some(row => ![row.receiptRef, row.subjectId, row.transitionId, row.fromState].every(present) ||
        !Number.isSafeInteger(row.index) || row.index < 0 || !Number.isSafeInteger(row.at) || row.at < start ||
        !Number.isFinite(new Date(row.at).getTime()) || row.fromState === 'checkpointed' ||
        !digest(row.checkpointSha256) || row.subjectFingerprint?.version !== 1 || !digest(row.subjectFingerprint.sha256)) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => `${row.subjectId}@${row.at}`)).size !== frozen.receipts.length)
    throw new Error('Workload checkpoint reader requires an explicit private allocation and unique exact checkpoints.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { readCarryLatestUpdate, normalizeWorkItemSubjectFingerprint }] = await Promise.all([
      import('./reproducibility/db'), import('../carry-note'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const scope = `workitem:${frozen.harnessSlug}:${receipt.subjectId}`;
    const rows = await sql<{ note: string | null; journal: unknown; updated_ts: string | number }[]>`
      SELECT note, journal, updated_ts FROM harness_shared.carry_notes
       WHERE workspace_id = ${workspaceId} AND scope = ${scope}
         AND (SELECT count(*) FROM harness_shared.work_items
               WHERE workspace_id = ${workspaceId} AND harness_slug = ${frozen.harnessSlug}
                 AND feature_id = ${receipt.subjectId}) = 1
    `;
    const row = rows[0];
    if (rows.length !== 1 || typeof row.note !== 'string' || !Array.isArray(row.journal) ||
        Number(row.updated_ts) !== receipt.at) return null;
    const entries = row.journal as import('../carry-note').CarryJournalEntry[];
    const entry = entries.at(-1);
    if (!entry || entry.at !== receipt.at || entries.filter(value => value?.at === receipt.at).length !== 1) return null;
    const subject = normalizeWorkItemSubjectFingerprint(entry.subjectFingerprint);
    const update = readCarryLatestUpdate(row.note, entry.latestUpdate);
    if (!subject || subject.sha256 !== receipt.subjectFingerprint.sha256 || update?.status !== 'available' ||
        typeof update.text !== 'string' || !update.text.trim() ||
        createHash('sha256').update(update.text).digest('hex') !== receipt.checkpointSha256) return null;
    return [{ index: receipt.index, kind: 'tool-result', name: 'work-item:checkpoint',
      at: new Date(receipt.at).toISOString(), content: update.text,
      metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref,
        durableTransition: { id: receipt.transitionId,
          subjectRef: `work-item:${frozen.harnessSlug}:${receipt.subjectId}`, from: receipt.fromState, to: 'checkpointed' },
        checkpointSource: { basis: 'hash-bound-work-item-latest-update', scope, journalAt: receipt.at,
          checkpointSha256: receipt.checkpointSha256, subjectFingerprint: subject } } }];
  };
}

/** Resolve the private offer and its exact acceptance, independently of wake
 * counts. Pin both stored envelopes: the generic event store supports upserts,
 * so message identity alone is insufficient to preserve receipt bytes. */
export function currentBenchWorkloadHandoffReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string; notBefore: string;
  receipts: Array<{ receiptRef: string; subjectId: string; transitionId: string; index: number; planSlug: string;
    offerMsgId: string; acceptanceMsgId: string; producerOwnerId: string; consumerOwnerId: string;
    offerSha256: string; acceptanceSha256: string }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId), start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && value.trim().length > 0;
  const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId].every(present) ||
      !digest(frozen.trialBindingHash) || !Number.isFinite(start) || !frozen.receipts.length ||
      frozen.receipts.some(row => ![row.receiptRef, row.subjectId, row.transitionId, row.planSlug, row.offerMsgId,
        row.acceptanceMsgId, row.producerOwnerId, row.consumerOwnerId].every(present) ||
        !Number.isSafeInteger(row.index) || row.index < 0 || row.offerMsgId === row.acceptanceMsgId ||
        row.producerOwnerId === row.consumerOwnerId || !digest(row.offerSha256) || !digest(row.acceptanceSha256)) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.offerMsgId)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.acceptanceMsgId)).size !== frozen.receipts.length)
    throw new Error('Workload handoff reader requires an explicit private allocation and unique exact handoffs.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { isHandoffRecord }] = await Promise.all([
      import('./reproducibility/db'), import('@papercusp/coordination/core'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const rows = await sql<{ msg_id: string; ts: Date; harness_slug: string | null;
      body: import('@papercusp/coordination/core').HandoffRecord }[]>`
      SELECT msg_id, ts, harness_slug, body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND surface = 'handoffs'
         AND msg_id IN (${receipt.offerMsgId}, ${receipt.acceptanceMsgId})
         AND (SELECT count(*) FROM harness_shared.work_items
               WHERE workspace_id = ${workspaceId} AND harness_slug = ${frozen.harnessSlug}
                 AND feature_id = ${receipt.subjectId}) = 1
    `;
    const offers = rows.filter(row => row.msg_id === receipt.offerMsgId);
    const accepts = rows.filter(row => row.msg_id === receipt.acceptanceMsgId);
    if (rows.length !== 2 || offers.length !== 1 || accepts.length !== 1) return null;
    const offerRow = offers[0], acceptRow = accepts[0], offer = offerRow.body, accept = acceptRow.body;
    if (!isHandoffRecord(offer) || !isHandoffRecord(accept) || offer.kind !== 'handoff' || accept.kind !== 'handoff_accepted' ||
        offer.msg_id !== receipt.offerMsgId || accept.msg_id !== receipt.acceptanceMsgId ||
        offer.from !== receipt.producerOwnerId || accept.from !== receipt.consumerOwnerId ||
        !Array.isArray(offer.to) || offer.to.length !== 1 || offer.to[0] !== receipt.consumerOwnerId ||
        !Array.isArray(accept.to) || accept.to.length !== 1 || accept.to[0] !== receipt.producerOwnerId ||
        accept.related_msg_id !== receipt.offerMsgId || offer.plan_slug !== receipt.planSlug || accept.plan_slug !== receipt.planSlug ||
        offer.harness_slug !== frozen.harnessSlug || offerRow.harness_slug !== frozen.harnessSlug ||
        (accept.harness_slug ?? null) !== acceptRow.harness_slug ||
        accept.harness_slug !== undefined && accept.harness_slug !== frozen.harnessSlug ||
        typeof offer.body !== 'string' || !offer.body.trim() ||
        createHash('sha256').update(canonicalJson(offer)).digest('hex') !== receipt.offerSha256 ||
        createHash('sha256').update(canonicalJson(accept)).digest('hex') !== receipt.acceptanceSha256) return null;
    const offeredAt = Date.parse(offer.ts), acceptedAt = Date.parse(accept.ts);
    if (!Number.isFinite(offeredAt) || !Number.isFinite(acceptedAt) || offeredAt < start || acceptedAt < offeredAt ||
        !(offerRow.ts instanceof Date) || offerRow.ts.getTime() !== offeredAt ||
        !(acceptRow.ts instanceof Date) || acceptRow.ts.getTime() !== acceptedAt) return null;
    return [{ index: receipt.index, kind: 'tool-result', name: 'coord:handoff',
      at: new Date(acceptedAt).toISOString(), content: canonicalJson({ offer, acceptance: accept }),
      metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref,
        durableTransition: { id: receipt.transitionId, subjectRef: `handoff:${receipt.offerMsgId}`, from: 'offered', to: 'accepted' },
        handoffSource: { offerMsgId: receipt.offerMsgId, acceptanceMsgId: receipt.acceptanceMsgId,
          producerOwnerId: receipt.producerOwnerId, consumerOwnerId: receipt.consumerOwnerId,
          offerSha256: receipt.offerSha256, acceptanceSha256: receipt.acceptanceSha256 } } }];
  };
}

type CurrentBenchWorkloadNativeReceipt = {
  nativeSessionId: string;
} & ({ agent?: 'codex'; codexHome: string; nativeTurnId: string;
  claudeConfigDir?: never; nativeMessageId?: never; messageRecordIndex?: never } |
  { agent: 'claude'; claudeConfigDir: string; nativeMessageId: string; messageRecordIndex: number;
    sourceSha256: string; codexHome?: never; nativeTurnId?: never });

/** Backend identity is exclusive even for untyped host allocations. */
function validWorkloadNativeReceipt(row: CurrentBenchWorkloadNativeReceipt): boolean {
  const present = (value: unknown) => typeof value === 'string' && !!value.trim();
  return present(row.nativeSessionId) && (row.agent === 'claude'
    ? present(row.claudeConfigDir) && present(row.nativeMessageId) && /^[a-f0-9]{64}$/.test(row.sourceSha256) &&
      Number.isSafeInteger(row.messageRecordIndex) && row.messageRecordIndex >= 0 &&
      row.codexHome === undefined && row.nativeTurnId === undefined
    : (row.agent === undefined || row.agent === 'codex') && present(row.codexHome) && present(row.nativeTurnId) &&
      row.claudeConfigDir === undefined && row.nativeMessageId === undefined && row.messageRecordIndex === undefined);
}

/** Resolve a host-selected text block from the exact private native task.
 * Native input recording is distinct from provider consumption; a provider
 * send proof must be composed separately when the workload requires it. */
export function currentBenchWorkloadContextReader(options: DbScope & {
  workspaceId: string; harnessSlug: string; runId: string; trialBindingHash: string; notBefore: string;
  receipts: Array<CurrentBenchWorkloadNativeReceipt & { receiptRef: string; subjectId: string; taskId: string; ownerId: string; label: string;
    recordIndex: number; contentIndex: number;
    contextId: string; consumer: string; index: number }>;
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId), start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId].every(present) ||
      !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) || !Number.isFinite(start) || !frozen.receipts.length ||
      frozen.receipts.some(row => !validWorkloadNativeReceipt(row) ||
        ![row.receiptRef, row.subjectId, row.taskId, row.ownerId, row.label, row.contextId, row.consumer].every(present) ||
        ![row.index, row.recordIndex, row.contentIndex].every(n => Number.isSafeInteger(n) && n >= 0)) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length)
    throw new Error('Workload context reader requires an explicit private allocation and unique native input receipts.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { codexHomeForSessionKey, sessionClaudeConfigDir },
      { readClosedCodexTurnInput, readClosedClaudeMessageInput }] = await Promise.all([
      import('./reproducibility/db'), import('@papercusp/orchestrator/session-launch-dirs'), import('../session-transcript-resolvers'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const rows = await sql<{ adv_id: number; started_at: Date; ended_at: Date; native_started_at: Date }[]>`
      SELECT a.id AS adv_id, t.started_at, t.ended_at, a.started_at AS native_started_at
        FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
          ON a.workspace_id = t.workspace_id AND a.coord_owner_id = t.detail->>'coordOwnerId'
       WHERE t.workspace_id = ${workspaceId} AND t.task_id = ${receipt.taskId}
         AND t.class = 'agent-session' AND t.state IN ('exited', 'killed', 'timed_out')
         AND t.detail->>'coordOwnerId' = ${receipt.ownerId} AND t.detail->>'label' = ${receipt.label}
         AND a.session_id = ${receipt.nativeSessionId} AND a.agent = ${receipt.agent ?? 'codex'}
         AND EXISTS (SELECT 1 FROM harness_shared.work_items item
                      WHERE item.workspace_id = ${workspaceId} AND item.harness_slug = ${frozen.harnessSlug}
                        AND item.feature_id = ${receipt.subjectId})
    `;
    if (rows.length !== 1 || (receipt.agent === 'claude'
      ? sessionClaudeConfigDir(receipt.ownerId) !== receipt.claudeConfigDir
      : codexHomeForSessionKey(rows[0].adv_id) !== receipt.codexHome)) return null;
    const observed = receipt.agent === 'claude'
      ? await readClosedClaudeMessageInput(sql, { ...receipt, workspaceId })
      : await readClosedCodexTurnInput(sql, { workspaceId, codexHome: receipt.codexHome,
        nativeSessionId: receipt.nativeSessionId, nativeTurnId: receipt.nativeTurnId,
        recordIndex: receipt.recordIndex, contentIndex: receipt.contentIndex });
    if (!observed) return null;
    const at = Date.parse(observed.at), row = rows[0];
    const times = [row.started_at, row.ended_at, row.native_started_at].map(value => value instanceof Date ? value.getTime() : NaN);
    if (!times.every(Number.isFinite) || at < start || at < times[0] || at > times[1] || at < times[2] ||
        'completedAt' in observed && Date.parse(observed.completedAt) > times[1]) return null;
    return [{ index: receipt.index, kind: 'input', role: receipt.consumer, at: observed.at, content: observed.text,
      metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref, contextId: receipt.contextId,
        nativeInputSource: { basis: 'closed-native-recorded-input', nativeSessionId: observed.nativeSessionId,
          ...('nativeMessageId' in observed ? { agent: 'claude', nativeMessageId: observed.nativeMessageId,
            messageRecordIndex: observed.messageRecordIndex, completedAt: observed.completedAt, recordUuid: observed.recordUuid }
            : { nativeTurnId: observed.nativeTurnId }),
          recordIndex: observed.recordIndex, contentIndex: observed.contentIndex,
          sourceSha256: observed.sourceSha256 } } }];
  };
}

/** Source-defined native tool results under a closed, host-allocated task.
 * This preserves wrapper names and error observations; it does not turn a
 * recorded result into a platform transition or a provider-consumption claim. */
export function currentBenchWorkloadToolResultReader(options:
  Omit<Parameters<typeof currentBenchWorkloadContextReader>[0], 'receipts'> & {
    receipts: Array<CurrentBenchWorkloadNativeReceipt & { receiptRef: string; subjectId: string; taskId: string; ownerId: string; label: string;
      callRecordIndex: number; resultRecordIndex: number; callContentIndex?: number; resultContentIndex?: number;
      callId: string; toolName: string; sourceSha256: string; argumentsSha256: string; outputSha256: string; index: number;
      /** Host-selected settled dispatch, including an inner target of a native wrapper.
       * The dispatcher callId is transient; the verified MCP native fingerprints
       * in requestOrigin are the persisted join. This is not lock-state proof. */
      dispatch?: { invocationId: string; requestTraceId: string; toolName: string;
        argumentsSha256: string; invocationSha256: string } }>;
  },
): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation);
  const workspaceId = resolveBenchWorkspace(frozen.workspaceId), start = Date.parse(frozen.notBefore);
  const present = (value: string) => typeof value === 'string' && !!value.trim();
  const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (![frozen.workspaceId, frozen.harnessSlug, frozen.runId].every(present) || !digest(frozen.trialBindingHash) ||
      !Number.isFinite(start) || !frozen.receipts.length || frozen.receipts.some(row =>
        !validWorkloadNativeReceipt(row) || ![row.receiptRef, row.subjectId, row.taskId, row.ownerId, row.label,
          row.callId, row.toolName].every(present) ||
        row.agent === 'claude' && (row.dispatch !== undefined ||
          ![row.callContentIndex, row.resultContentIndex].every(n => Number.isSafeInteger(n) && n! >= 0)) ||
        row.agent !== 'claude' && (row.callContentIndex !== undefined || row.resultContentIndex !== undefined) ||
        ![row.sourceSha256, row.argumentsSha256, row.outputSha256].every(digest) ||
        ![row.index, row.callRecordIndex, row.resultRecordIndex].every(n => Number.isSafeInteger(n) && n >= 0) ||
        row.callRecordIndex >= row.resultRecordIndex || (row.dispatch !== undefined && (
          !/^[1-9]\d*$/.test(row.dispatch.invocationId) ||
          ![row.dispatch.requestTraceId, row.dispatch.toolName].every(present) ||
          ![row.dispatch.argumentsSha256, row.dispatch.invocationSha256].every(digest)))) ||
      new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.filter(row => row.dispatch).map(row => row.dispatch!.invocationId)).size !==
        frozen.receipts.filter(row => row.dispatch).length)
    throw new Error('Workload tool-result reader requires a private allocation and unique pinned native call/result receipts.');
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const [{ resolveDb }, { codexHomeForSessionKey, sessionClaudeConfigDir },
      { readClosedCodexTurnToolResult, readClosedClaudeMessageToolResult }] = await Promise.all([
      import('./reproducibility/db'), import('@papercusp/orchestrator/session-launch-dirs'), import('../session-transcript-resolvers'),
    ]);
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId });
    const rows = await sql<{ adv_id: number; started_at: Date; ended_at: Date; native_started_at: Date }[]>`
      SELECT a.id AS adv_id, t.started_at, t.ended_at, a.started_at AS native_started_at
        FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
          ON a.workspace_id = t.workspace_id AND a.coord_owner_id = t.detail->>'coordOwnerId'
       WHERE t.workspace_id = ${workspaceId} AND t.task_id = ${receipt.taskId}
         AND t.class = 'agent-session' AND t.state IN ('exited', 'killed', 'timed_out')
         AND t.detail->>'coordOwnerId' = ${receipt.ownerId} AND t.detail->>'label' = ${receipt.label}
         AND a.session_id = ${receipt.nativeSessionId} AND a.agent = ${receipt.agent ?? 'codex'}
         AND EXISTS (SELECT 1 FROM harness_shared.work_items item
                      WHERE item.workspace_id = ${workspaceId} AND item.harness_slug = ${frozen.harnessSlug}
                        AND item.feature_id = ${receipt.subjectId})
    `;
    if (rows.length !== 1 || (receipt.agent === 'claude'
      ? sessionClaudeConfigDir(receipt.ownerId) !== receipt.claudeConfigDir
      : codexHomeForSessionKey(rows[0].adv_id) !== receipt.codexHome)) return null;
    const observed = receipt.agent === 'claude'
      ? await readClosedClaudeMessageToolResult(sql, { ...receipt, workspaceId,
        callContentIndex: receipt.callContentIndex!, resultContentIndex: receipt.resultContentIndex! })
      : await readClosedCodexTurnToolResult(sql, { workspaceId, codexHome: receipt.codexHome,
        nativeSessionId: receipt.nativeSessionId, nativeTurnId: receipt.nativeTurnId,
        callRecordIndex: receipt.callRecordIndex, resultRecordIndex: receipt.resultRecordIndex });
    if (!observed) return null;
    const content = typeof observed.output === 'string' ? observed.output : canonicalJson(observed.output);
    const calledAt = Date.parse(observed.calledAt), at = Date.parse(observed.at), row = rows[0];
    const times = [row.started_at, row.ended_at, row.native_started_at].map(value => value instanceof Date ? value.getTime() : NaN);
    if (!times.every(Number.isFinite) || calledAt < start || calledAt < times[0] || calledAt < times[2] || at > times[1] ||
        'completedAt' in observed && Date.parse(observed.completedAt) > times[1] ||
        observed.callId !== receipt.callId || observed.name !== receipt.toolName || observed.sourceSha256 !== receipt.sourceSha256 ||
        createHash('sha256').update(observed.arguments).digest('hex') !== receipt.argumentsSha256 ||
        createHash('sha256').update(content).digest('hex') !== receipt.outputSha256) return null;
    let platformInvocationSource: Record<string, unknown> | undefined;
    if (receipt.dispatch) {
      const pin = receipt.dispatch;
      const sessionFingerprint = createHash('sha256').update(receipt.nativeSessionId, 'utf8').digest('hex');
      const callFingerprint = createHash('sha256').update(receipt.callId, 'utf8').digest('hex');
      // Search the entire exact native-call/target population, not just the
      // selected row: repeated inner calls must not be silently conflated.
      const invocations = await sql<{ invocation: Record<string, unknown>; population: string }[]>`
        SELECT to_jsonb(invocation) AS invocation, count(*) OVER ()::text AS population
          FROM harness_shared.tool_invocations invocation
         WHERE invocation.workspace_id = ${workspaceId}
           AND invocation.tool_name = ${pin.toolName}
           AND invocation.metadata_json->'requestOrigin'->'nativeSession'->>'callIdFingerprint' = ${callFingerprint}
           AND invocation.metadata_json->'requestOrigin'->'nativeSession'->>'valueFingerprint' = ${sessionFingerprint}
         LIMIT 2
      `;
      if (invocations.length !== 1 || invocations[0].population !== '1') return null;
      const invocation = invocations[0].invocation;
      const metadata = invocation.metadata_json as Record<string, unknown> | null;
      const origin = metadata?.requestOrigin as Record<string, unknown> | undefined;
      const native = origin?.nativeSession as Record<string, unknown> | undefined;
      const invokedAt = typeof invocation.invoked_at === 'string' ? Date.parse(invocation.invoked_at) : NaN;
      const args = invocation.args_json;
      if (String(invocation.id) !== pin.invocationId || invocation.harness_slug !== frozen.harnessSlug ||
          invocation.coord_owner_id !== receipt.ownerId || origin?.mcpRequestTraceId !== pin.requestTraceId ||
          origin?.transport !== 'mcp' || native?.carrier !== 'meta:threadId' || native.binding !== 'bound' ||
          native.candidateAdvSessionId !== Number(row.adv_id) ||
          !Number.isFinite(invokedAt) || invokedAt < calledAt || invokedAt > at ||
          !Number.isSafeInteger(invocation.duration_ms) || Number(invocation.duration_ms) < 0 ||
          invokedAt - Number(invocation.duration_ms) < calledAt ||
          !['ok', 'error', 'quota-exceeded', 'role-not-allowed', 'invalid-input', 'timeout'].includes(String(invocation.status)) ||
          !args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, '_truncated') ||
          createHash('sha256').update(canonicalJson(args)).digest('hex') !== pin.argumentsSha256 ||
          createHash('sha256').update(canonicalJson(invocation)).digest('hex') !== pin.invocationSha256) return null;
      platformInvocationSource = { basis: 'native-call-correlated-dispatch', invocationId: pin.invocationId,
        requestTraceId: pin.requestTraceId, toolName: pin.toolName, arguments: args,
        argumentsSha256: pin.argumentsSha256, invocationSha256: pin.invocationSha256,
        invokedAt: new Date(invokedAt).toISOString(), durationMs: invocation.duration_ms,
        status: invocation.status, errorCode: invocation.error_code ?? null,
        outputRef: invocation.output_ref ?? null };
    }
    return [{ index: receipt.index, kind: 'tool-result', name: observed.name, at: observed.at, content,
      metadata: { runId: frozen.runId, trialBindingHash: frozen.trialBindingHash, receiptRef: ref,
        ...(platformInvocationSource ? { platformInvocationSource } : {}),
        nativeToolSource: { basis: 'closed-native-recorded-tool-result', nativeSessionId: observed.nativeSessionId,
          ...('nativeMessageId' in observed ? { agent: 'claude', nativeMessageId: observed.nativeMessageId,
            messageRecordIndex: observed.messageRecordIndex, completedAt: observed.completedAt, callType: 'tool_use',
            callContentIndex: observed.callContentIndex, resultContentIndex: observed.resultContentIndex,
            callRecordUuid: observed.callRecordUuid, resultRecordUuid: observed.resultRecordUuid, callMessageId: observed.callMessageId }
            : { nativeTurnId: observed.nativeTurnId, callType: observed.callType }),
          callRecordIndex: observed.callRecordIndex, resultRecordIndex: observed.resultRecordIndex,
          callId: observed.callId, outputKind: typeof observed.output === 'string' ? 'text' : 'blocks',
          sourceSha256: observed.sourceSha256, arguments: observed.arguments,
          argumentsSha256: receipt.argumentsSha256, outputSha256: receipt.outputSha256,
          calledAt: observed.calledAt, isError: observed.isError } } }];
  };
}

/** A recorded native input alone does not prove a provider received it. Join
 * the exact private native text block or call/result to a host-captured request body and the
 * maintained gateway reservation's completed response. Neither request IDs
 * supplied by a candidate nor a response-headers observation can fill a gap.
 * Capture after result settlement: a later changed reservation note refuses
 * the pinned receipt rather than silently borrowing its replacement. */
export function currentBenchWorkloadProviderInputReader(options:
  Omit<Parameters<typeof currentBenchWorkloadContextReader>[0], 'receipts'> & {
    checkoutRoot: string; accountingBinding: CurrentBenchAccountingBinding;
    /** The capture allocation's payer route (D-023); omission is the API key. */
    payer?: 'subscription';
    receipts: Array<((Parameters<typeof currentBenchWorkloadContextReader>[0]['receipts'][number] & { nativeSource?: 'input' }) |
      (Parameters<typeof currentBenchWorkloadToolResultReader>[0]['receipts'][number] & {
        nativeSource: 'tool-result'; contextId: string; consumer: string;
      })) & {
      reservationId: string; reservationNoteSha256: string; settledAt?: string;
      bodyRef: string; bodyPath: string; maxBytes: number;
      inputIndex: number; textIndex?: number; model: string; effort: string; accountId: string;
    }>;
  },
): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const { sql: suppliedSql, ...allocation } = options;
  const frozen = structuredClone(allocation), host = frozen.accountingBinding;
  const present = (value: string) => typeof value === 'string' && !!value.trim();
  const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const uuid = (value: string) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  if (!host || host.workspaceId !== frozen.workspaceId || host.runId !== frozen.runId ||
      !present(host.loopId) || !digest(host.preregHash) || !host.assignmentId?.startsWith('bench-assignment:') ||
      frozen.receipts.some(row => !validWorkloadNativeReceipt(row) || !uuid(row.reservationId) ||
        (row.agent === 'claude' ? frozen.payer !== undefined || row.settledAt === undefined
          : !uuid(row.nativeSessionId) || !uuid(row.nativeTurnId)) ||
        !digest(row.reservationNoteSha256) || row.settledAt !== undefined && !Number.isFinite(Date.parse(row.settledAt)) ||
        ![row.bodyRef, row.bodyPath, row.model, row.effort, row.accountId].every(present) ||
        !Number.isSafeInteger(row.inputIndex) || row.inputIndex < 0 ||
        row.nativeSource !== undefined && !['input', 'tool-result'].includes(row.nativeSource) ||
        row.nativeSource === 'tool-result' && ![row.contextId, row.consumer].every(present) ||
        (row.agent === 'claude' || row.nativeSource !== 'tool-result') &&
          (!Number.isSafeInteger(row.textIndex) || row.textIndex! < 0)) ||
      new Set(frozen.receipts.map(row => row.reservationId)).size !== frozen.receipts.length)
    throw new Error('Workload provider input reader requires unique exact requests and a private accounting binding.');
  const inputReceipts = frozen.receipts.filter(row => row.nativeSource !== 'tool-result');
  const toolReceipts = frozen.receipts.filter(row => row.nativeSource === 'tool-result');
  const nativeInput = inputReceipts.length ? currentBenchWorkloadContextReader({ ...frozen, sql: suppliedSql, receipts: inputReceipts }) : null;
  const nativeTool = toolReceipts.length ? currentBenchWorkloadToolResultReader({ ...frozen, sql: suppliedSql, receipts: toolReceipts }) : null;
  if (new Set(frozen.receipts.map(row => row.receiptRef)).size !== frozen.receipts.length ||
      new Set(frozen.receipts.map(row => row.index)).size !== frozen.receipts.length)
    throw new Error('Workload provider input reader requires unique native receipts across source kinds.');
  const artifacts = currentBenchWorkloadArtifactReader({ ...frozen, sql: suppliedSql,
    artifacts: frozen.receipts.map(row => ({ ref: row.bodyRef, path: row.bodyPath,
      subjectId: row.subjectId, maxBytes: row.maxBytes })) });
  const allowed = new Map(frozen.receipts.map(row => [row.receiptRef, row]));
  return async (ref, binding) => {
    const receipt = allowed.get(ref);
    if (!receipt || binding.runId !== frozen.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const native = receipt.nativeSource === 'tool-result' ? nativeTool : nativeInput;
    const inputs = await native?.(ref, binding), bytes = await artifacts(receipt.bodyRef, binding);
    if (inputs?.length !== 1 || !bytes) return null;
    const { resolveDb } = await import('./reproducibility/db');
    const { sql } = resolveDb({ sql: suppliedSql, workspaceId: frozen.workspaceId });
    const rows = await sql<{ note: string; status: string; settled_at: Date | null; created_at: Date; ended_at: Date }[]>`
      SELECT r.note, r.status, r.settled_at, r.created_at, t.ended_at
        FROM harness_shared.learning_spend_reservations r
        JOIN harness_shared.task_ledger t ON t.workspace_id = r.workspace_id AND t.task_id = ${receipt.taskId}
       WHERE r.workspace_id = ${frozen.workspaceId} AND r.loop_id = ${host.loopId}
         AND r.id = ${receipt.reservationId}::uuid
         AND r.run_ref = ${`manifest:${host.preregHash}/attempt:${receipt.reservationId.toLowerCase()}`}
         AND r.arm_id = ${host.assignmentId} AND r.attempt_kind = 'evaluation'
         AND r.status IN ('open', 'settled')
    `;
    const row = rows[0], observed = inputs[0], claude = receipt.agent === 'claude';
    const input = receipt.nativeSource === 'tool-result' ? { ...observed, kind: 'input' as const,
      role: receipt.consumer, metadata: { ...observed.metadata, contextId: receipt.contextId } } : observed;
    if (rows.length !== 1 || typeof row.note !== 'string' ||
        receipt.settledAt !== undefined && (row.status !== 'settled' || !(row.settled_at instanceof Date) ||
          row.settled_at.toISOString() !== receipt.settledAt) ||
        createHash('sha256').update(row.note).digest('hex') !== receipt.reservationNoteSha256 ||
        !(row.created_at instanceof Date) || !(row.ended_at instanceof Date) ||
        row.created_at.getTime() < Date.parse(input.at!) || row.created_at > row.ended_at) return null;
    const nativeSource = observed.metadata?.[receipt.nativeSource === 'tool-result' ? 'nativeToolSource' : 'nativeInputSource'] as
      Record<string, unknown> | undefined;
    if (claude && (!nativeSource || typeof nativeSource.completedAt !== 'string' ||
        !Number.isFinite(Date.parse(nativeSource.completedAt)) || row.created_at.getTime() > Date.parse(nativeSource.completedAt))) return null;
    try {
      const note = JSON.parse(row.note), attempt = note.nativeGatewayAttempt, result = note.nativeGatewayAttemptResult;
      const bodyText = Buffer.from(bytes).toString('utf8');
      if (!Buffer.from(bodyText).equals(Buffer.from(bytes))) return null;
      const body = JSON.parse(bodyText), bodySha256 = createHash('sha256').update(bytes).digest('hex');
      const identity = { attemptId: receipt.reservationId, manifestSha256: host.preregHash, armId: host.assignmentId,
        nativeSessionId: claude ? undefined : receipt.nativeSessionId, nativeTurnId: receipt.nativeTurnId, accountId: receipt.accountId,
        bodySha256, ...(claude ? { transport: 'anthropic-http', target: anthropicMessagesTarget, credentialHeader: 'x-api-key',
          anthropicVersion: anthropicInputVersion, anthropicBeta: null } : currentBenchCodexRoute(frozen.payer ?? 'api-key')) };
      if (!attempt || !result || Object.entries(identity).some(([key, value]) => attempt[key] !== value || result[key] !== value) ||
          !digest(attempt.credentialSha256) || result.credentialSha256 !== attempt.credentialSha256 ||
          !present(attempt.clockId) || result.clockId !== attempt.clockId || result.reservationRef !== receipt.reservationId ||
          result.outcome !== 'response-completed' || result.responseStatus !== 200 || !digest(result.responseSha256) ||
          !Number.isSafeInteger(result.responseBytes) || result.responseBytes <= 0 ||
          result.costUsdMeasurementMissing !== true || !present(result.providerCompletion?.responseId) ||
          result.providerCompletion.model !== receipt.model ||
          result.providerCompletion.providerEffort !== null && result.providerCompletion.providerEffort !== receipt.effort ||
          body.model !== receipt.model) return null;
      if (claude) {
        if (result.providerCompletion.responseId !== receipt.nativeMessageId || body.output_config?.effort !== receipt.effort ||
            !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0 || !selfContainedAnthropicInput(body)) return null;
        const message = body.messages[receipt.inputIndex];
        if (receipt.nativeSource === 'tool-result') {
          const source = nativeSource!;
          const blocks = body.messages.flatMap((item: Record<string, unknown>, messageIndex: number) =>
            Array.isArray(item.content) ? item.content.map((block: Record<string, unknown>, contentIndex: number) =>
              ({ block, role: item.role, messageIndex, contentIndex })) : []);
          type Block = { block: Record<string, unknown>; role: unknown; messageIndex: number; contentIndex: number };
          const calls = blocks.filter((item: Block) => item.block.type === 'tool_use' && item.block.id === receipt.callId);
          const results = blocks.filter((item: Block) => item.block.type === 'tool_result' && item.block.tool_use_id === receipt.callId);
          const call: Block = calls[0], output: Block = results[0];
          if (calls.length !== 1 || results.length !== 1 || call.role !== 'assistant' || output.role !== 'user' ||
              call.messageIndex >= output.messageIndex || output.messageIndex !== receipt.inputIndex ||
              output.contentIndex !== receipt.textIndex || source.callType !== 'tool_use' ||
              call.block.name !== receipt.toolName || canonicalJson(call.block.input) !== canonicalJson(JSON.parse(source.arguments as string)) ||
              (output.block.is_error ?? null) !== source.isError ||
              (source.outputKind === 'text' ? typeof output.block.content !== 'string' || output.block.content !== input.content
                : source.outputKind !== 'blocks' || !Array.isArray(output.block.content) || canonicalJson(output.block.content) !== input.content)) return null;
        } else {
          const block = typeof message?.content === 'string' && receipt.textIndex === 0
            ? { type: 'text', text: message.content } : message?.content?.[receipt.textIndex!];
          if (message?.role !== 'user' || block?.type !== 'text' || block.text !== input.content) return null;
        }
      } else {
        if (body.reasoning?.effort !== receipt.effort || !selfContainedOpenAiInput(body)) return null;
        const correlation = readGatewayNativeCorrelation(body);
        if (correlation.status !== 'observed' || correlation.turnId !== receipt.nativeTurnId ||
            (correlation.sessionId ?? correlation.threadId) !== receipt.nativeSessionId ||
            correlation.threadId !== receipt.nativeSessionId || !Array.isArray(body.input)) return null;
        const message = body.input[receipt.inputIndex];
        if (receipt.nativeSource === 'tool-result') {
          const source = observed.metadata?.nativeToolSource as Record<string, unknown> | undefined;
          const outputs = body.input.filter((item: Record<string, unknown>) =>
            ['function_call_output', 'custom_tool_call_output'].includes(String(item?.type)) && item.call_id === receipt.callId);
          const calls = body.input.map((item: Record<string, unknown>, index: number) => ({ item, index })).filter(
            (row: { item: Record<string, unknown> }) => ['function_call', 'custom_tool_call'].includes(String(row.item?.type)) && row.item.call_id === receipt.callId);
          const call = calls[0];
          if (!source || source.outputKind !== 'text' || outputs.length !== 1 || calls.length !== 1 ||
              call.index >= receipt.inputIndex || call.item.type !== source.callType ||
              `${call.item.namespace ? call.item.namespace + '.' : ''}${call.item.name}` !== receipt.toolName ||
              (call.item.type === 'function_call' ? call.item.arguments : call.item.input) !== source.arguments ||
              message?.type !== (source.callType === 'function_call' ? 'function_call_output' : 'custom_tool_call_output') ||
              message.call_id !== receipt.callId || typeof message.output !== 'string' || message.output !== input.content) return null;
        } else {
          const block = message?.content?.[receipt.textIndex!];
          if ((message?.type ?? 'message') !== 'message' || message.role !== 'user' ||
              !Array.isArray(message.content) || block?.type !== 'input_text' || block.text !== input.content) return null;
        }
      }
      return [{ ...input, metadata: { ...input.metadata,
        providerInputSource: { basis: 'completed-provider-request-input', reservationId: receipt.reservationId,
          reservationNoteSha256: receipt.reservationNoteSha256, bodyRef: receipt.bodyRef, bodySha256,
          inputIndex: receipt.inputIndex, ...(receipt.nativeSource === 'tool-result' ? { callId: receipt.callId } : { textIndex: receipt.textIndex }),
          accountId: receipt.accountId, ...(claude ? { agent: 'claude', anthropicVersion: anthropicInputVersion, anthropicBeta: null } : {}),
          responseId: result.providerCompletion.responseId, responseSha256: result.responseSha256 } } }];
    } catch { return null; }
  };
}

export function liveCurrentSuBenchPorts(
  ctx: PapercuspUnifiedToolContext, observations: CurrentSuBenchObservations,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration' | 'armId' | 'seed'>,
  db: Pick<DbScope, 'sql'> = {},
): CurrentSuBenchPorts {
  const workspaceId = resolveBenchWorkspace(ctx.workspaceId);
  if (ctx.workspaceId !== workspaceId || opts.workspaceId !== workspaceId) throw new Error('Current benchmark launch requires an explicitly isolated caller context.');
  const gateway = observations.nativeGateway === undefined ? null : snapshotScopedInferenceGateway(observations.nativeGateway);
  const host = observations.nativeGateway === undefined ? undefined : currentBenchHostGateways.get(observations.nativeGateway);
  const accounting = observations.nativeAccountingBinding === undefined ? undefined : Object.freeze({ ...observations.nativeAccountingBinding });
  const containerExec = observations.containerExec === undefined ? undefined : Object.freeze({ ...observations.containerExec });
  if (containerExec) {
    validateDockerExecTarget(containerExec);
    // An in-container current-su launch must carry the same session home into
    // the task container. Without this relocation the generated wrapper cannot
    // apply the repository trust override to the Codex process, so a committed
    // /app checkout can stop at the native trust prompt before any model call.
    if (containerExec.binPath !== CONTAINER_CODEX_BIN_PATH || containerExec.workdir !== '/app' ||
        containerExec.sessionRelocation?.sessionEnv !== 'CODEX_HOME' || !containerExec.sessionRelocation.roots.length) {
      throw new Error('Current-su in-container Codex target requires /app, the maintained Codex binary, and CODEX_HOME relocation roots.');
    }
  }
  let containerWrapper: ReturnType<typeof materializeDockerExecWrapper> | undefined;
  /** The `{ codex: wrapper }` override for an in-container launch; undefined for a host launch. */
  const containerExecWrapper = (args: LaunchArgs): import('../agent-tools/capability/launch-agent').InternalBackendBinOverride | undefined => {
    if (!containerExec) return undefined;
    const members = args.members ?? [];
    if (members.length !== 1 || members[0]?.agent !== 'codex')
      throw new Error('An in-container benchmark launch runs exactly one Codex member.');
    // Re-materialize if the temp file vanished: a missing override fails the launch closed,
    // so this only matters for a long run whose temp dir was swept between resumes.
    if (!containerWrapper || !existsSync(containerWrapper.wrapperPath))
      containerWrapper = materializeDockerExecWrapper(containerExec);
    return Object.freeze({ codex: containerWrapper.nativeBoundary });
  };
  const requireBinding = () => {
    return requireCurrentBenchHostBinding(observations, opts);
  };
  const requireHost = (args: LaunchArgs) => {
    const host = requireBinding();
    const member = args.members?.[0];
    if (args.members?.length !== 1 || !member || member.agent !== host.arm.agent ||
        member.model !== host.arm.model || member.effort !== host.arm.effort || member.account !== host.arm.account) {
      throw new Error('Current benchmark native launch controls differ from its host-owned gateway.');
    }
  };
  const restored = new Map<string, BenchmarkContextInput & { workItemId: string }>();
  return {
    releaseGateway: async () => {
      if (observations.sessionBudget) {
        // The assignment owns the shared gateway; one session owns only its grant.
        if (host?.session?.receipt === observations.sessionBudget) host.session.phase = 'retired';
      } else await host?.stop();
    },
    verifyGenerationBudget: (budget, taskId) => {
      const host = requireBinding();
      if (taskId !== host.taskId) throw new Error('Current benchmark session differs from its host assignment.');
      if (observations.sessionBudget || host.arm.control?.topology === 'repeated-session') {
        const { session } = requireSessionBudget(observations, opts);
        if (canonicalJson(budget) !== canonicalJson(session.receipt.budget))
          throw new Error('Current benchmark execution differs from its host-issued session allowance.');
        return { frozenBudget: { ...host.arm.generationBudget }, topology: 'repeated-session', sessionBudget: session.receipt };
      }
      if (canonicalJson(budget) !== canonicalJson(host.arm.generationBudget))
        throw new Error('Current benchmark admission differs from its host assignment or budget.');
      return { frozenBudget: { ...host.arm.generationBudget } };
    },
    admit: async (handle, budget, taskId) => {
      const host = requireBinding();
      let session: CurrentBenchSessionState | undefined;
      if (observations.sessionBudget || host.arm.control?.topology === 'repeated-session') {
        session = requireSessionBudget(observations, opts).session;
        if (session.phase !== 'issued' || canonicalJson(budget) !== canonicalJson(session.receipt.budget))
          throw new Error('Fresh native session allowance was already admitted or its budget differs.');
        session.phase = 'admitting'; session.handle = sessionHandle(handle);
      }
      if (taskId !== host.taskId || !session && canonicalJson(budget) !== canonicalJson(host.arm.generationBudget)) {
        throw new Error('Current benchmark admission differs from its host assignment or budget.');
      }
      const receipt = await observations.admit(handle, budget, taskId);
      requireBinding();
      if (session) {
        requireSessionBudget(observations, opts);
        session.phase = receipt.admitted ? 'admitted' : 'retired';
      }
      return receipt;
    },
    collectCost: input => liveCurrentBenchNativeCostReader(input.handle, opts, db, accounting)(),
    readIdentity: async task => {
      const observation = await observations.observeIdentity(task);
      return observation ? currentBenchIdentityFromObservation(task, observation) : null;
    },
    verifyPreregistration: async () => (await import('./reproducibility/prereg')).requireCommittedPreregistration(
      opts.runId, opts.preregistration, { ...db, workspaceId, repoRoot: opts.preregistration.repoRoot },
    ),
    restoreContext: async (handle, taskId) => {
      const host = requireBinding();
      if (taskId !== host.taskId) throw new Error('Benchmark context restore differs from its host assignment.');
      const protocol = currentBenchmarkProtocolSchema.parse(opts.preregistration.config);
      const input = { context: protocol.context, checkout: handle.worktreePath, workItemId: handle.featureId, snapshotRoot: opts.preregistration.repoRoot ?? REPO_ROOT,
        binding: { workspaceId, runId: opts.runId, preregHash: opts.preregistration.preregHash,
          assignmentId: accounting!.assignmentId, harnessSlug: handle.slug } };
      // Fresh sessions keep the assignment's physical context and task edits.
      // Only the active host-issued continuation may reuse it; re-read the
      // exact receipt and frozen bytes rather than recreate or repair them.
      const session = observations.sessionBudget ? requireSessionBudget(observations, opts).session : undefined;
      const receipt = session && session.receipt.index > 0
        ? readRestoredBenchmarkContext(input) : restoreBenchmarkContext(input);
      restored.set(handle.slug, input);
      return receipt;
    },
    verifyContext: async (handle, taskId) => {
      const host = requireBinding(), input = restored.get(handle.slug);
      if (taskId !== host.taskId || !input || input.checkout !== handle.worktreePath)
        throw new Error('Benchmark initial context has not been restored for this checkout.');
      return readRestoredBenchmarkContext(input);
    },
    readCompletion: handle => readCurrentBenchCompletion(handle, { ...db, workspaceId }),
    launch: async args => {
      requireHost(args);
      const input = typeof args.harness === 'string' ? restored.get(args.harness) : undefined;
      if (!input || args.cwd !== input.checkout || args.workItem !== input.workItemId || args.feature !== input.workItemId || typeof args.brief !== 'string' ||
          !args.brief.endsWith(readRestoredBenchmarkContext(input).contextText))
        throw new Error('Benchmark native launch requires its physically restored frozen context.');
      const ledger = currentBenchLedgerEnabled(requireBinding().arm);
      const instruction = currentBenchTaskInstruction({ slug: input.binding.harnessSlug,
        featureId: input.workItemId, worktreePath: input.checkout }, ledger);
      if (!args.brief.startsWith(`${instruction}\n\n`))
        throw new Error('Benchmark native launch ledger exposure differs from its frozen host arm.');
      const module = await import('../agent-tools/capability/launch-agent');
      requireHost(args);
      const verifySession = beginCurrentBenchNativeSession(observations, opts, { slug: args.harness as string,
        featureId: input.workItemId, worktreePath: input.checkout });
      verifySession();
      // Server-side operations run outside the native OS boundary. Only local
      // assignment progress/completion (when its frozen arm enables them),
      // identity and deterministic managed self-compaction are admitted here; the native sandbox supplies
      // coding tools. Discovery, remote brains, arbitrary server execution and
      // lifecycle fan-out cannot cause unmetered inference for this assignment.
      const confinement = Object.freeze({ denyTools: Object.freeze([] as string[]),
        denyOutside: Object.freeze(ledger
          ? ['coord:whoami', 'session:request-compaction', 'work_items:get', 'work_items:checkpoint', 'work_items:complete']
          : ['coord:whoami', 'session:request-compaction']),
        denyAmbientContext: true as const,
        // Observer ownership/authorization is identical in both arms; the
        // experimental tool ceiling cannot widen this exact-item boundary.
        denyWorkItemsOutside: Object.freeze({ id: input.workItemId, harness: input.binding.harnessSlug, checkout: input.checkout }),
        imposedBy: `benchmark-host ${accounting!.assignmentId}`,
        reason: 'All benchmark inference must cross the assignment\'s private metered gateway; native sandboxed tools perform local coding.' });
      // D-026/D-028: the agent CLI runs inside the task container. Resolved per launch so a
      // carry-respawn re-execs the same wrapper against the same container.
      const backendBinOverride = containerExecWrapper(args);
      return module.default.handler(args, { ...ctx, [module.INTERNAL_SCOPED_INFERENCE_GATEWAY]: gateway,
        [module.INTERNAL_SCOPED_SESSION_CONFINEMENT]: confinement,
        ...(backendBinOverride ? { [module.INTERNAL_BACKEND_BIN_OVERRIDE]: backendBinOverride } : {}) } as PapercuspUnifiedToolContext);
    },
    getTask: async id => {
      const task = await (await import('../task-manager/store')).getTask(id);
      if (!task || task.workspaceId !== workspaceId || typeof task.detail.coordOwnerId !== 'string' ||
          !task.sessionId || !['pending', 'running'].includes(task.state)) return task;
      const { findLiveHostAsync } = await import('../events/await/psu-pty-discovery');
      const failure = currentBenchNativeFailure(task,
        await findLiveHostAsync(task.detail.coordOwnerId, undefined, { workspaceId }));
      return failure ? { ...task, detail: { ...task.detail, nativeStreamError: failure } } : task;
    },
    listTasks: async filter => (await import('../task-manager/store')).listTasks(filter),
    killTask: async id => (await import('../task-manager/control')).killTask(id, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}
export function bindCurrentSuBenchHarness(opts: CurrentSuBenchOptions, ctx: PapercuspUnifiedToolContext, observations: CurrentSuBenchObservations): void {
  setBenchHarnessDriver(createCurrentSuBenchHarness(opts, ctx, observations));
}
/** An assignment owns its driver; concurrent host callers cannot replace a global binding. */
export function createCurrentSuBenchHarness(opts: CurrentSuBenchOptions, ctx: PapercuspUnifiedToolContext, observations: CurrentSuBenchObservations) {
  if (resolveBenchWorkspace(opts.workspaceId) !== ctx.workspaceId) throw new Error('Benchmark launch context and run workspace differ.');
  return currentSuBenchHarnessDriver(liveBenchHarnessOps(opts), liveCurrentSuBenchPorts(ctx, observations, opts), opts);
}
