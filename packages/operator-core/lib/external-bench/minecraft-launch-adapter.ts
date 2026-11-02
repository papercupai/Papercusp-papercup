/** Minecraft P-004: gameplay admission over the maintained native assignment.
 * The existing gateway owns requests/reservations/billing/session allowances;
 * the existing native drivers own enrollment, execution and cost collection.
 * This adapter supplies only the enrolled player's bounded gameplay client.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { canonicalJson } from './reproducibility/canonical-json';
import { currentBenchmarkProtocolSchema } from './reproducibility/schema';
import { withMinecraftAssignment, type FrozenMinecraftManifest, type FrozenMinecraftPair,
  type FrozenMinecraftSelection } from './minecraft-protocol';
import { readMinecraftInitialWorld, startMinecraftParticipantBridge, type MinecraftRuntime } from './minecraft-runtime';
import { readCurrentBenchRepeatedSessionControl, startCurrentBenchTaskAssignment, type CurrentTaskInput } from './run-launcher';
import { createCurrentSuBenchHarness, CURRENT_STOCK_CLAUDE_BLUEPRINT, CURRENT_STOCK_CODEX_BLUEPRINT,
  currentBenchAssignmentId, currentBenchSessionUsageDelta, requireCurrentBenchNativeRunCost,
  type CurrentBenchNativeRunCost, type CurrentBenchSessionBudget,
  type CurrentSuBenchObservations, type CurrentSuBenchOptions } from './current-su';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { FULL_SPINE_BLUEPRINT, type BenchHarnessDriver } from './run-loop';
import { runRepeatedSessions } from './repeated-session';
import { generationStatusForStopReason } from './types';
import type { IsoBudget } from './coordination-topology';
import type { AgentRunOutput, RunAgentInput } from './run-topology';

export interface MinecraftNativeAssignmentInput {
  current: CurrentTaskInput;
  runtime: MinecraftRuntime;
  manifest: FrozenMinecraftManifest;
  selection: FrozenMinecraftSelection;
  participantId: string;
  pairing: { pair: FrozenMinecraftPair; initialState: unknown };
}
export interface MinecraftNativeAssignmentPorts {
  startAssignment: typeof startCurrentBenchTaskAssignment;
  startBridge: typeof startMinecraftParticipantBridge;
  readInitialWorld: typeof readMinecraftInitialWorld;
  createDriver(options: CurrentSuBenchOptions, context: CurrentTaskInput['context'],
    observations: CurrentSuBenchObservations, stock: boolean): BenchHarnessDriver;
}
const livePorts: MinecraftNativeAssignmentPorts = {
  startAssignment: startCurrentBenchTaskAssignment,
  startBridge: startMinecraftParticipantBridge,
  readInitialWorld: readMinecraftInitialWorld,
  createDriver: (options, context, observations, stock) => (stock
    ? createCurrentStockBenchHarness : createCurrentSuBenchHarness)(options, context, observations),
};

export async function startMinecraftNativeAssignment(input: MinecraftNativeAssignmentInput,
  ports: MinecraftNativeAssignmentPorts = livePorts) {
  const { current, runtime, manifest, selection, participantId, pairing } = input;
  // Parse and copy host inputs before any async allocation or caller mutation.
  const protocol = currentBenchmarkProtocolSchema.parse(current.protocol);
  const options = { ...current.options, preregistration: { ...current.options.preregistration,
    config: structuredClone(current.options.preregistration.config) } };
  const arm = protocol.arms.find(value => value.id === options.armId);
  const trial = runtime.trial, game = trial.protocol;
  const topology = arm?.control?.topology;
  const stock = topology === 'stock-native-reference' || topology === 'repeated-session';
  if (!arm || !['stock-native-reference', 'solo', 'coordinated', 'repeated-session'].includes(topology ?? '') ||
      arm.agent === 'proximus' || options.agent !== arm.agent || options.model !== arm.model ||
      options.account !== arm.account || options.effort !== arm.effort || protocol.grader.family !== 'minecraft' ||
      current.task.benchmark !== 'minecraft' || current.task.instanceId !== game.taskId ||
      protocol.runId !== game.runId || options.runId !== game.runId || options.armId !== game.armId ||
      !protocol.taskIds.includes(game.taskId) || !protocol.seeds.includes(options.seed) ||
      canonicalJson(protocol) !== canonicalJson(options.preregistration.config) ||
      selection.modelId !== arm.model || selection.promptSha256 !== arm.runtime.promptHash ||
      selection.configurationSha256 !== createHash('sha256').update(canonicalJson(protocol)).digest('hex') ||
      protocol.aggregateBudgetUsd > 20 || arm.generationBudget.maxUsd !== game.limits.maxUsd ||
      arm.generationBudget.maxWallClockMs !== game.limits.maxWallClockMs ||
      (topology === 'coordinated' ? game.participants.length < 2 : game.participants.length !== 1)) {
    throw Error('Minecraft native assignment differs from its frozen model, prompt, topology, task or total budget');
  }
  const abort = new AbortController();
  const parentSignal = AbortSignal.any([abort.signal, ...[options.signal, current.context.signal]
    .filter((signal): signal is AbortSignal => !!signal)]);
  parentSignal.throwIfAborted();
  const checkout = { ...current.checkout, dir: resolve(current.checkout.dir) };
  const task = structuredClone(current.task);
  // The live port reads the opaque owned-runtime record, measured before Java
  // starts. A declared/reset hash cannot authorize a fresh native assignment.
  // The maintained native driver independently restores and re-reads the frozen
  // memory bytes before generation; its receipt must match this same protocol.
  const measuredState = { ...ports.readInitialWorld(runtime), memorySha256: protocol.context.memoryHash };
  if (canonicalJson(pairing.initialState) !== canonicalJson(measuredState))
    throw Error('Minecraft native assignment reset differs from the measured world or frozen memory');
  return withMinecraftAssignment(manifest, selection, game, runtime.measurement, trial.trialId, participantId,
    async (_trial, assignment) => {
      const bridge = await ports.startBridge(runtime, assignment);
      const signal = AbortSignal.any([parentSignal, bridge.signal]);
      options.signal = signal;
      let native: Awaited<ReturnType<typeof startCurrentBenchTaskAssignment>> | undefined;
      let nativeStarting: ReturnType<typeof startCurrentBenchTaskAssignment> | undefined;
      let clientDir: string | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => stopping ??= (async () => {
        signal.removeEventListener('abort', onAbort);
        abort.abort();
        // Always revoke gameplay, gateway and client credentials, even when an
        // earlier cleanup step fails. The caller separately owns the world.
        const errors: unknown[] = [];
        for (const close of [() => bridge.stop(),
          // Cancellation may precede the gateway's startup receipt. Drain that
          // receipt and revoke the late assignment before cleanup can finish.
          // The startup path separately reports a rejected startup promise.
          () => nativeStarting?.then(value => value.stop(), () => {}),
          () => clientDir ? rm(clientDir, { recursive: true, force: true }) : undefined]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Minecraft native assignment cleanup failed');
      })();
      // Runtime deadlines/cancellation revoke gameplay and native inference
      // together. Retain any async cleanup error in stop() for the caller.
      const onAbort = () => { void stop().catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        // Keep the delivered instruction identical across equivalent runs.
        // Exclusive mkdir also refuses a foreign/pre-existing client without
        // deleting it during cleanup. Random credentials stay inside the file.
        const allocated = join(checkout.dir, '.minecraft-gameplay');
        await mkdir(allocated, { mode: 0o700 });
        clientDir = allocated;
        const client = join(clientDir, 'play.cjs');
        // Values are JS string literals, never shell fragments. No server,
        // evidence or operator paths enter the participant's workspace.
        await writeFile(client, [
          "'use strict';",
          "const fs = require('node:fs');",
          "const source = fs.readFileSync(process.argv[2], 'utf8');",
          "if (!source.trim() || Buffer.byteLength(source) > 16384) throw Error('Invalid bounded gameplay program');",
          `fetch(${JSON.stringify(bridge.endpoint)}, { method:'POST',`,
          `headers:{authorization:${JSON.stringify(`Bearer ${bridge.token}`)}}, body:JSON.stringify({source}),`,
          `signal:AbortSignal.timeout(${game.limits.maxProgramMs + 30_000}) })`,
          ".then(async response => { const text = await response.text(); if (Buffer.byteLength(text) > 131072) throw Error('Gameplay output limit');",
          "process.stdout.write(text + '\\n'); if (!response.ok) process.exitCode=1; })",
          ".catch(() => { process.stderr.write('Gameplay connection failed\\n'); process.exitCode=1; });",
        ].join('\n'), { mode: 0o600, flag: 'wx' });
        const command = `node ${JSON.stringify(relative(checkout.dir, client))} program.js`;
        task.problemStatement += `\n\nYou control Minecraft participant ${participantId}. Write a JavaScript program in program.js, then execute ${command}. ` +
          `Programs receive an async bot API with only these frozen observations: ${game.observations.join(', ')}; actions: ${game.actions.join(', ')}. ` +
          'For example: return await bot.position(). Every program is isolated and bounded. Inspect the returned gameplay state and continue toward the assigned objective. ' +
          'The host grades server evidence; textual claims do not complete the objective.';
        signal.throwIfAborted();
        nativeStarting = ports.startAssignment({ ...current, protocol, options, task, checkout });
        native = await nativeStarting;
        signal.throwIfAborted();
        return { ...native, checkout, task, generationBudget: { ...arm.generationBudget }, stop,
          createDriver(sessionBudget?: CurrentBenchSessionBudget, directive?: string): BenchHarnessDriver {
            if (stopping || options.signal?.aborted) throw Error('Minecraft native assignment is closed');
            if ((topology === 'repeated-session') !== !!sessionBudget) {
              throw Error('Minecraft repeated native sessions require a host-issued session allowance');
            }
            const driver = ports.createDriver(options, current.context, { ...native!.observations,
              ...(sessionBudget ? { sessionBudget } : {}) }, stock);
            return { spinRunAndCost: request => {
              if (stopping || options.signal?.aborted || request.task.instanceId !== task.instanceId ||
                  resolve(request.checkout.dir) !== checkout.dir) throw Error('Minecraft native drive has a foreign or closed assignment');
              return driver.spinRunAndCost({ ...request,
                task: directive ? { ...task, problemStatement: `${task.problemStatement}\n\n${directive}` } : task, checkout,
                blueprintId: stock ? options.agent === 'claude' ? CURRENT_STOCK_CLAUDE_BLUEPRINT : CURRENT_STOCK_CODEX_BLUEPRINT
                  : FULL_SPINE_BLUEPRINT });
            } };
          },
        };
      } catch (error) {
        try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Minecraft native startup and cleanup failed'); }
        throw error;
      }
    }, { pair: pairing.pair, initialState: measuredState });
}

export interface MinecraftNativeRunPorts extends MinecraftNativeAssignmentPorts {
  readRepeatedSession: typeof readCurrentBenchRepeatedSessionControl;
}
const liveRunPorts: MinecraftNativeRunPorts = { ...livePorts, readRepeatedSession: readCurrentBenchRepeatedSessionControl };

/** One enrolled player, adapted to the existing topology output contract.
 * The world and checkout belong to the caller; this call always retires its
 * gateway/client. Repeated sessions keep both environments and read actual
 * paired spend through the maintained result-ledger verifier.
 */
export async function runMinecraftNativeParticipant(input: MinecraftNativeAssignmentInput,
  control: { attemptBudget: IsoBudget; directive?: string }, ports: MinecraftNativeRunPorts = liveRunPorts,
): Promise<AgentRunOutput> {
  const protocol = currentBenchmarkProtocolSchema.parse(input.current.protocol);
  const arm = protocol.arms.find(value => value.id === input.current.options.armId);
  const cap = { ...control.attemptBudget };
  const budget = arm?.generationBudget;
  if (!budget || arm.agent !== 'codex' || cap.maxModelCalls !== undefined ||
      cap.maxCostUsd !== budget.maxUsd || cap.maxTokens !== budget.maxTokens ||
      !Number.isFinite(cap.maxWallMs) || cap.maxWallMs! <= 0 || cap.maxWallMs! > budget.maxWallClockMs) {
    throw Error('Minecraft native run requires exact frozen cost/token caps and bounded wall headroom');
  }
  // Resolve the treatment BEFORE allocating this assignment. Missing/foreign
  // treatment proof must not open another native session or reservation.
  const current = { ...input.current, protocol, task: structuredClone(input.current.task),
    options: { ...input.current.options, preregistration: { ...input.current.options.preregistration,
      config: structuredClone(input.current.options.preregistration.config) },
      driveTimeoutMs: Math.min(input.current.options.driveTimeoutMs ?? Infinity, cap.maxWallMs!) } };
  const repeated = await ports.readRepeatedSession(current);
  if ((arm.control?.topology === 'repeated-session') !== !!repeated) {
    throw Error('Minecraft repeated-session control is missing its paired treatment proof');
  }
  const assignment = await startMinecraftNativeAssignment({ ...input, current }, ports);
  try {
    const readRequestCensus = assignment.readRequestCensus, issueSessionBudget = assignment.issueSessionBudget;
    if (!readRequestCensus || repeated && !issueSessionBudget) throw Error('Minecraft native accounting/session ports are unavailable');
    let before = await readRequestCensus();
    const binding = before.binding;
    if (binding.workspaceId !== current.options.workspaceId || binding.runId !== protocol.runId ||
        binding.loopId !== current.loopId || binding.preregHash !== current.options.preregistration.preregHash ||
        binding.assignmentId !== currentBenchAssignmentId(protocol.runId, arm.id, current.task.instanceId, current.options.seed)) {
      throw Error('Minecraft native accounting has a foreign assignment');
    }
    if (before.requests.length) throw Error('Minecraft assignment already contains native requests');
    let beforeCost: CurrentBenchNativeRunCost | null = null;
    const invocation: RunAgentInput<MinecraftRuntime> = { task: assignment.task, handle: input.runtime,
      arm: arm.id, role: 'worker', teamKey: input.participantId, topic: '',
      directive: control.directive ?? '', forbidTools: [], attemptBudget: { ...cap } };
    const runSession = async (session: RunAgentInput<MinecraftRuntime>, grant?: CurrentBenchSessionBudget): Promise<AgentRunOutput> => {
      const result = await assignment.createDriver(grant, session.directive).spinRunAndCost({
        blueprintId: '', task: assignment.task, checkout: assignment.checkout,
        budget: grant?.budget ?? assignment.generationBudget });
      const usage = result.telemetry;
      // Retain the known subtotal on an accounting error, but mark it unknown
      // and stop; a malformed cumulative receipt never funds another session.
      let measured = { tokensIn: Math.max(0, usage.tokensIn - (beforeCost?.tokensIn ?? 0)),
        tokensOut: Math.max(0, usage.tokensOut - (beforeCost?.tokensOut ?? 0)),
        tokensCacheRead: Math.max(0, (usage.tokensCacheRead ?? 0) - (beforeCost?.tokensCacheRead ?? 0)),
        tokensCacheWrite: Math.max(0, (usage.tokensCacheWrite ?? 0) - (beforeCost?.tokensCacheWrite ?? 0)),
        costUsd: Math.max(0, usage.costUsd - (beforeCost?.costUsd ?? 0)),
        turns: Math.max(0, usage.turns - (beforeCost?.turns ?? 0)) };
      let modelCalls = 0, error: string | undefined;
      try {
        const after = await readRequestCensus();
        const afterCost = requireCurrentBenchNativeRunCost({ ...usage,
          costUsdMeasurementMissing: usage.armMeta?.costUsdMeasurementMissing === true });
        const previous = new Set(beforeCost?.armMeta.nativeCostAccounting.sources.map(source => source.nativeSessionId) ?? []);
        const added = afterCost.armMeta.nativeCostAccounting.sources.filter(source => !previous.has(source.nativeSessionId));
        if (added.length !== 1) throw Error('Minecraft player session requires exactly one new closed native source');
        const delta = currentBenchSessionUsageDelta({ before, after, beforeCost, afterCost, nativeSessionId: added[0]!.nativeSessionId });
        if (afterCost.armMeta.nativeCostAccounting.priceTableVersion !== protocol.priceSchedule.version ||
            after.binding.workspaceId !== current.options.workspaceId || after.binding.runId !== protocol.runId ||
            after.binding.preregHash !== current.options.preregistration.preregHash) {
          throw Error('Minecraft native accounting differs from its frozen run');
        }
        measured = { tokensIn: delta.tokensIn, tokensOut: delta.tokensOut,
          tokensCacheRead: delta.tokensCacheRead, tokensCacheWrite: delta.tokensCacheWrite,
          costUsd: delta.normalizedCostUsd, turns: delta.turns };
        modelCalls = delta.modelCalls;
        before = after; beforeCost = structuredClone(afterCost);
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      return { ...measured, modelCalls, submission: { trialId: input.runtime.trial.trialId, participantId: input.participantId },
        status: error ? 'error' : generationStatusForStopReason(usage.stopReason),
        capped: usage.stopReason === 'budget-exhausted', error: error ?? usage.generationError,
        traceRef: usage.trajectoryRef, executionPath: 'minecraft-native-assignment',
        armMeta: { ...usage.armMeta, ...(error ? { modelCallsMeasurementMissing: true, costUsdMeasurementMissing: true } : {}) } };
    };
    if (!repeated) return await runSession(invocation);
    const result = await runRepeatedSessions(invocation, { ...repeated,
      openFreshSession: async session => {
        const left = session.attemptBudget;
        const grant = issueSessionBudget!({ maxUsd: left.maxCostUsd,
          ...(left.maxTokens !== undefined ? { maxTokens: left.maxTokens } : {}), maxWallClockMs: left.maxWallMs }, beforeCost);
        return runSession(session, grant);
      } });
    return { ...result.usage, submission: { trialId: input.runtime.trial.trialId, participantId: input.participantId },
      status: result.stop === 'error' ? 'error' : 'completed', error: result.error,
      capped: result.stop !== 'matched-cost', traceRef: result.sessions.at(-1)?.traceRef,
      executionPath: 'minecraft-native-assignment', armMeta: { ...result.sessions.at(-1)?.armMeta,
        repeatedSession: { ...repeated, stop: result.stop, sessions: result.sessions } } };
  } finally { await assignment.stop(); }
}
