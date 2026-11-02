import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMinecraftNativeParticipant, runMinecraftNativeTrial, runMinecraftStoredTrial, startMinecraftNativeAssignment,
  type MinecraftNativeAssignmentPorts, type MinecraftNativeRunPorts, type MinecraftNativeTrialPorts,
  type MinecraftStoredTrialPorts } from './minecraft-launch-adapter';
import { rolloutIdFor } from './reproducibility/emit';
import { freezeMinecraftManifest, freezeMinecraftPair, freezeMinecraftSelection, freezeMinecraftTrial } from './minecraft-protocol';
import { controlledProtocolFixture, currentNativeCostFixture } from './reproducibility/_protocol-test-fixture';
import { canonicalJson } from './reproducibility/canonical-json';
import type { MinecraftRuntime } from './minecraft-runtime';
import type { CurrentBenchTaskRequestCensus, CurrentTaskInput } from './run-launcher';
import type { BenchHarnessDriver } from './run-loop';
import { runTopology } from './run-topology';
import { resolveCoordinationSpec } from './coordination-topology';
import { currentBenchAssignmentId } from './current-su';
import { minecraftOfflinePlayerUuid } from './minecraft-runtime';
import { readMinecraftEvidenceExport } from './minecraft-evidence';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (n: number) => n.toString(16).padStart(64, '0');
async function fixture(armId = 'stock') {
  const root = await mkdtemp(join(tmpdir(), 'mc-native-adapter-')); roots.push(root);
  const protocol = controlledProtocolFixture();
  protocol.arms = protocol.arms.filter(arm => ['stock', 'coordinated', 'repeated-session'].includes(arm.id));
  protocol.aggregateBudgetUsd = 15; protocol.grader.family = 'minecraft';
  protocol.grader.version = 'minecraft@1.20.4/server-advancements-v1';
  const material = (taskId: string, n: number) => ({ taskId, worldSeed: String(n), objective: 'iron-tools',
    referenceSha256: sha(n * 10), scoringFixtureSha256: sha(n * 10 + 1), exampleSha256: [] });
  const manifest = freezeMinecraftManifest({ schemaVersion: 1, revision: 1,
    train: [material('train', 1)], dev: [material('dev', 2)], heldOut: [material('t1', 3)] });
  const initialState = { worldSha256: sha(90), memorySha256: protocol.context.memoryHash };
  const arms = protocol.arms.map(arm => {
    const selection = freezeMinecraftSelection(manifest, { runId: protocol.runId, armId: arm.id, modelId: arm.model,
      promptSha256: arm.runtime.promptHash,
      configurationSha256: createHash('sha256').update(canonicalJson(protocol)).digest('hex'), sources: [] });
    const trial = freezeMinecraftTrial({ schemaVersion: 1, runId: protocol.runId, armId: arm.id, taskId: 't1',
      manifestHash: manifest.manifestHash, selectionHash: selection.selectionHash, worldSeed: '3', objective: 'iron-tools',
      rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
      pins: { serverImage: `minecraft/server@sha256:${sha(70)}`, serverJarSha256: sha(71), mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
      participants: arm.id === 'coordinated' ? ['alice', 'bob'] : ['alice'], observations: ['position'], actions: ['move'],
      limits: { maxWallClockMs: 100, maxProgramMs: 50, maxUsd: 3 } });
    return { trial, selection, initialState };
  });
  const pair = freezeMinecraftPair(manifest, { arms, orderSeed: sha(100) });
  const selected = arms.find(arm => arm.trial.protocol.armId === armId)!;
  const arm = protocol.arms.find(arm => arm.id === armId)!;
  const current = { protocol, options: { workspaceId: 'benchmarks', runId: protocol.runId, armId, seed: 1,
    agent: 'codex', model: arm.model, effort: arm.effort, account: arm.account,
    preregistration: { preregHash: sha(50), config: protocol } },
    task: { benchmark: 'minecraft', instanceId: 't1', problemStatement: 'Reach iron tools', graderMeta: {} },
    checkout: { dir: root, repo: 'minecraft', baseCommit: 'frozen', cleanup: vi.fn(async () => {}) },
    context: { workspaceId: 'benchmarks' }, scope: {}, resources: {}, loopId: 'loop', hostRunId: 'host', observation: {},
  } as unknown as CurrentTaskInput;
  const runtime = { trial: selected.trial, measurement: { serverInstanceId: 'owned-server', serverReady: true, javaMajor: 17,
    trialId: selected.trial.trialId, worldSeed: '3', rules: selected.trial.protocol.rules, pins: selected.trial.protocol.pins } } as MinecraftRuntime;
  const native = { options: current.options, observations: {
    admit: vi.fn(async () => ({ admitted: true, receiptRef: 'fixture:admission' })),
    observeIdentity: vi.fn(async () => null),
  }, stop: vi.fn(async () => {}),
    readModelCalls: vi.fn(async () => 0), readRequestCensus: vi.fn(), issueSessionBudget: vi.fn() };
  const revoked = new AbortController();
  const bridge = { endpoint: 'http://127.0.0.1:39999/', token: 'private-player-token', participantId: 'alice',
    signal: revoked.signal, stop: vi.fn(async () => {}) };
  const spinRunAndCost = vi.fn<BenchHarnessDriver['spinRunAndCost']>(async () => ({ worktreePath: root,
    telemetry: { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0,
      wallClockMs: 0, stopReason: 'done', trajectoryRef: '' } }));
  const ports = { startAssignment: vi.fn(async () => native), startBridge: vi.fn(async () => bridge),
    readInitialWorld: vi.fn(() => ({ worldSha256: initialState.worldSha256 })),
    createDriver: vi.fn(() => ({ spinRunAndCost })) } as unknown as MinecraftNativeAssignmentPorts;
  return { input: { current, runtime, manifest, selection: selected.selection, participantId: 'alice', pairing: { pair, initialState } },
    root, ports, native, bridge, revoked, spinRunAndCost };
}
describe('Minecraft native assignment composition', () => {
  it('delivers identical task instructions across equivalent allocations', async () => {
    const f = await fixture();
    const first = await startMinecraftNativeAssignment(f.input, f.ports);
    const prompt = first.task.problemStatement;
    await first.stop();
    f.bridge.token = 'a-different-private-player-token';
    const second = await startMinecraftNativeAssignment(f.input, f.ports);
    try {
      expect(second.task.problemStatement).toBe(prompt);
      expect(prompt).toContain('node ".minecraft-gameplay/play.cjs" program.js');
      expect(prompt).not.toContain(f.bridge.token);
    } finally { await second.stop(); }
  });
  it('preserves an existing foreign gameplay client when exclusive allocation fails', async () => {
    const f = await fixture();
    await mkdir(join(f.root, '.minecraft-gameplay'));
    await writeFile(join(f.root, '.minecraft-gameplay', 'foreign'), 'keep');
    await expect(startMinecraftNativeAssignment(f.input, f.ports)).rejects.toThrow();
    expect(await readFile(join(f.root, '.minecraft-gameplay', 'foreign'), 'utf8')).toBe('keep');
    expect(f.ports.startAssignment).not.toHaveBeenCalled();
    expect(f.bridge.stop).toHaveBeenCalledOnce();
  });
  it('executes the generated client and transfers only source with its participant credential', async () => {
    const f = await fixture();
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
        response.end(JSON.stringify({ ok: true, value: { x: 1 } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    f.bridge.endpoint = `http://127.0.0.1:${address.port}/`;
    let assignment: Awaited<ReturnType<typeof startMinecraftNativeAssignment>> | undefined;
    try {
      assignment = await startMinecraftNativeAssignment(f.input, f.ports);
      const dir = (await readdir(f.root))[0]!;
      const program = join(f.root, 'program.js'); await writeFile(program, 'return await bot.position()');
      const startedAt = Date.now();
      const result = await promisify(execFile)(process.execPath, [join(f.root, dir, 'play.cjs'), program], { timeout: 10_000 })
        .catch(error => { throw new Error(`Minecraft generated client failed: ${JSON.stringify({
          elapsedMs: Date.now() - startedAt, code: error.code, signal: error.signal, killed: error.killed,
          stdout: error.stdout, stderr: error.stderr, requestsReceived: requests.length,
        })}`, { cause: error }); });
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, value: { x: 1 } });
      expect(requests).toEqual([{ authorization: 'Bearer private-player-token', body: { source: 'return await bot.position()' } }]);
    } finally {
      await assignment?.stop();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
  it.each(['stock', 'coordinated'])('connects %s to the maintained native factory and cleans its local credential', async armId => {
    const f = await fixture(armId), assignment = await startMinecraftNativeAssignment(f.input, f.ports);
    const clientDir = (await readdir(f.root))[0]!;
    const client = await readFile(join(f.root, clientDir, 'play.cjs'), 'utf8');
    expect(client).toContain('private-player-token'); expect(client).not.toContain('server.jar');
    expect(assignment.task.problemStatement).toContain('Minecraft participant alice');
    expect(f.ports.startAssignment).toHaveBeenCalledOnce();
    await assignment.createDriver().spinRunAndCost({ blueprintId: 'ignored', task: f.input.current.task,
      checkout: f.input.current.checkout, budget: assignment.generationBudget });
    expect(f.ports.createDriver).toHaveBeenCalledWith(expect.anything(), f.input.current.context,
      expect.anything(), armId === 'stock');
    expect(f.spinRunAndCost).toHaveBeenCalledWith(expect.objectContaining({ blueprintId: armId === 'stock' ? 'native-codex' : 'su',
      task: assignment.task }));
    await assignment.stop(); await assignment.stop();
    expect(f.bridge.stop).toHaveBeenCalledOnce(); expect(f.native.stop).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
    expect(() => assignment.createDriver()).toThrow(/closed/);
  });
  it.each(['model', 'task', 'budget', 'reset', 'runtime', 'selection'])('refuses %s drift before native allocation', async field => {
    const f = await fixture();
    if (field === 'model') f.input.current.options.model = 'different-model';
    if (field === 'task') f.input.current.task.instanceId = 'different-task';
    if (field === 'budget') f.input.current.protocol.aggregateBudgetUsd = 21;
    if (field === 'reset') f.input.pairing.initialState = { worldSha256: sha(99), memorySha256: f.input.current.protocol.context.memoryHash };
    if (field === 'runtime') f.input.runtime.measurement = { ...f.input.runtime.measurement, worldSeed: '4' };
    if (field === 'selection') f.input.selection = { ...f.input.selection };
    await expect(startMinecraftNativeAssignment(f.input, f.ports)).rejects.toThrow();
    expect(f.ports.startBridge).not.toHaveBeenCalled(); expect(f.ports.startAssignment).not.toHaveBeenCalled();
  });
  it('revokes gameplay and removes client credentials when gateway startup fails', async () => {
    const f = await fixture(); vi.mocked(f.ports.startAssignment).mockRejectedValue(Error('gateway unavailable'));
    await expect(startMinecraftNativeAssignment(f.input, f.ports)).rejects.toThrow(/gateway unavailable/);
    expect(f.bridge.stop).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([]);
  });
  it('refuses a declared reset hash when the owned-runtime measurement differs', async () => {
    const f = await fixture();
    vi.mocked(f.ports.readInitialWorld).mockReturnValue({ worldSha256: sha(99) });
    await expect(startMinecraftNativeAssignment(f.input, f.ports)).rejects.toThrow(/measured world/);
    expect(f.ports.startBridge).not.toHaveBeenCalled(); expect(f.ports.startAssignment).not.toHaveBeenCalled();
  });
  it('refuses initial memory that differs from the frozen native context before allocating a bridge', async () => {
    const f = await fixture();
    f.input.pairing.initialState = { ...f.input.pairing.initialState, memorySha256: sha(99) };
    await expect(startMinecraftNativeAssignment(f.input, f.ports)).rejects.toThrow(/frozen memory/);
    expect(f.ports.startBridge).not.toHaveBeenCalled(); expect(f.ports.startAssignment).not.toHaveBeenCalled();
  });
  it('uses the live owned-runtime boundary before any native allocation', async () => {
    const f = await fixture();
    await expect(startMinecraftNativeAssignment(f.input)).rejects.toThrow(/no measured frozen world/);
    expect(await readdir(f.root)).toEqual([]);
  });
  it('requires a fresh host session allowance for repeated native sessions', async () => {
    const f = await fixture('repeated-session'), assignment = await startMinecraftNativeAssignment(f.input, f.ports);
    try {
      expect(() => assignment.createDriver()).toThrow(/host-issued/);
      expect(f.ports.createDriver).not.toHaveBeenCalled();
      expect(assignment.issueSessionBudget).toBe(f.native.issueSessionBudget);
    } finally { await assignment.stop(); }
  });
  it('revokes the native gateway and driver when the owned world closes', async () => {
    const f = await fixture(), assignment = await startMinecraftNativeAssignment(f.input, f.ports);
    f.revoked.abort();
    expect(() => assignment.createDriver()).toThrow(/closed/);
    await assignment.stop();
    expect(f.native.stop).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  });
  it('drains and revokes a late gateway receipt when the world closes during startup', async () => {
    const f = await fixture();
    let finish!: (value: typeof f.native) => void;
    vi.mocked(f.ports.startAssignment).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const starting = startMinecraftNativeAssignment(f.input, f.ports);
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(f.ports.startAssignment).toHaveBeenCalledOnce());
    f.revoked.abort(); finish(f.native);
    await rejected;
    expect(f.native.stop).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  });
});

async function measuredFixture(repeated = false) {
  const f = await fixture(repeated ? 'repeated-session' : 'stock');
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const binding = { workspaceId: f.input.current.options.workspaceId, runId: f.input.current.protocol.runId,
    preregHash: f.input.current.options.preregistration.preregHash,
    assignmentId: currentBenchAssignmentId(f.input.current.protocol.runId, f.input.current.options.armId, 't1', 1), loopId: 'loop' };
  let completed = 0;
  const census = (): CurrentBenchTaskRequestCensus => ({ binding, populationSha256: sha(80),
    requests: ids.slice(0, completed).map(id => ({ reservationId: `reservation:${id}`,
      nativeSessionId: id, nativeTurnId: `${id}:turn`, bodySha256: sha(81) })) });
  f.native.readRequestCensus.mockImplementation(async () => census());
  f.native.issueSessionBudget.mockImplementation((budget, beforeCost) => Object.freeze({
    index: completed, binding, budget, ...(beforeCost ? { priorUsage: beforeCost } : {}) }));
  f.spinRunAndCost.mockImplementation(async () => {
    completed++;
    return { worktreePath: f.root, telemetry: { ...currentNativeCostFixture(ids.slice(0, completed), binding.preregHash),
      wallClockMs: 1, stopReason: 'done', trajectoryRef: `native:${ids[completed - 1]}` } };
  });
  const readRepeatedSession = vi.fn(async () => repeated ? { treatmentCostUsd: 0.4, maxSessions: 4 } : undefined);
  const ports = { ...f.ports, readRepeatedSession } as MinecraftNativeRunPorts;
  return { ...f, ids, ports, readRepeatedSession,
    control: { attemptBudget: { maxCostUsd: 3, maxWallMs: 100 } } };
}
describe('Minecraft measured native participant', () => {
  it('passes measured native usage and a genuine unsolved verdict through the maintained topology driver', async () => {
    const f = await measuredFixture();
    const teardown = vi.fn(async () => {}), persist = vi.fn();
    const run = await runTopology({ spec: resolveCoordinationSpec({ id: 'stock', kind: 'harness', spine: {} }),
      backlog: [f.input.current.task], budget: f.control.attemptBudget,
      runId: f.input.current.protocol.runId, seed: 1, now: () => 0, cap: 1,
      rowMeta: { suite: 'minecraft', modelId: 'configured-alias', harnessVersion: 'fixture-source',
        preregHash: f.input.current.options.preregistration.preregHash, rolloutId: 'rollout',
        graderFamily: 'minecraft', graderVersion: 'pinned', priceTableVersion: 'frozen-prices-v1' },
      seam: { modality: 'in-container', clone: async () => f.input.runtime,
        grade: async () => ({ resolved: false, score: 0, graderStatus: 'failed' as const }), teardown },
      runAgent: invocation => runMinecraftNativeParticipant(f.input, { attemptBudget: invocation.attemptBudget }, f.ports),
      onResult: persist });
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ generationStatus: 'completed', graderStatus: 'failed', resolved: false,
      tokensIn: 8, tokensOut: 2, costUsd: 0.2, turns: 1,
      armMeta: { executionPath: 'minecraft-native-assignment' } });
    expect(run.modelCallsSpent).toBe(1);
    expect(run.tokensSpent).toBe(16);
    expect(persist).toHaveBeenCalledOnce(); expect(teardown).toHaveBeenCalledOnce();
    expect(f.native.stop).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([]);
  });
  it('keeps one world/workspace/gateway and charges fresh sessions only once', async () => {
    const f = await measuredFixture(true);
    const result = await runMinecraftNativeParticipant(f.input, f.control, f.ports);
    expect(result).toMatchObject({ status: 'completed', modelCalls: 2, costUsd: 0.4,
      tokensIn: 16, tokensOut: 4, tokensCacheRead: 10, tokensCacheWrite: 2, turns: 2,
      armMeta: { repeatedSession: { stop: 'matched-cost' } } });
    expect(f.ports.startAssignment).toHaveBeenCalledOnce(); expect(f.ports.startBridge).toHaveBeenCalledOnce();
    expect(f.native.issueSessionBudget).toHaveBeenCalledTimes(2);
    expect(f.ports.createDriver).toHaveBeenCalledTimes(2);
    const requests = f.spinRunAndCost.mock.calls.map(([request]) => request);
    expect(requests[0]!.checkout.dir).toBe(requests[1]!.checkout.dir);
    expect(requests[1]!.budget.maxUsd).toBeCloseTo(0.2);
    expect(requests[1]!.task.problemStatement).toContain('What is not done yet?');
    expect(f.native.stop).toHaveBeenCalledOnce();
  });
  it('opens no native session when measured paired treatment spend is zero', async () => {
    const f = await measuredFixture(true);
    f.readRepeatedSession.mockResolvedValue({ treatmentCostUsd: 0, maxSessions: 4 });
    const result = await runMinecraftNativeParticipant(f.input, f.control, f.ports);
    expect(result).toMatchObject({ status: 'completed', modelCalls: 0, costUsd: 0,
      armMeta: { repeatedSession: { stop: 'matched-cost', sessions: [] } } });
    expect(f.native.issueSessionBudget).not.toHaveBeenCalled(); expect(f.ports.createDriver).not.toHaveBeenCalled();
    expect(f.native.stop).toHaveBeenCalledOnce();
  });
  it('stops after incomplete cumulative source accounting without reopening a session', async () => {
    const f = await measuredFixture(true);
    f.spinRunAndCost.mockImplementationOnce(async () => ({ worktreePath: f.root, telemetry: {
      ...currentNativeCostFixture([f.ids[0]!], f.input.current.options.preregistration.preregHash),
      armMeta: { costUsdMeasurementMissing: true }, wallClockMs: 1, stopReason: 'done', trajectoryRef: 'native:first' } }));
    const result = await runMinecraftNativeParticipant(f.input, f.control, f.ports);
    expect(result).toMatchObject({ status: 'error', costUsd: 0.2,
      armMeta: { costUsdMeasurementMissing: true, repeatedSession: { stop: 'error' } } });
    expect(f.spinRunAndCost).toHaveBeenCalledOnce(); expect(f.native.stop).toHaveBeenCalledOnce();
  });
  it('refuses a foreign empty request census before opening a native driver', async () => {
    const f = await measuredFixture();
    const census = await f.native.readRequestCensus();
    f.native.readRequestCensus.mockResolvedValue({ ...census, binding: { ...census.binding, assignmentId: 'foreign' } });
    await expect(runMinecraftNativeParticipant(f.input, f.control, f.ports)).rejects.toThrow(/foreign assignment/);
    expect(f.ports.createDriver).not.toHaveBeenCalled(); expect(f.native.stop).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
  });
  it.each(['paired-proof', 'budget', 'model-calls'])('refuses %s before gateway allocation', async drift => {
    const f = await measuredFixture(true);
    if (drift === 'paired-proof') f.readRepeatedSession.mockRejectedValue(Error('Foreign treatment'));
    if (drift === 'budget') f.control.attemptBudget.maxCostUsd = 4;
    const control = drift === 'model-calls' ? { attemptBudget: { ...f.control.attemptBudget, maxModelCalls: 1 } } : f.control;
    await expect(runMinecraftNativeParticipant(f.input, control, f.ports)).rejects.toThrow();
    expect(f.ports.startBridge).not.toHaveBeenCalled(); expect(f.ports.startAssignment).not.toHaveBeenCalled();
  });
});

async function trialFixture() {
  const f = await measuredFixture();
  const snapshot = { runtimeId: 'owned-server', trial: f.input.runtime.trial, startedAtMs: 0, stoppedAtMs: 50,
    files: { 'programs.jsonl': '', 'server.log': 'trusted server', 'bot.log': 'trusted bot',
      [`world/world/advancements/${minecraftOfflinePlayerUuid('alice')}.json`]: JSON.stringify({ DataVersion: 1 }),
      [`world/world/stats/${minecraftOfflinePlayerUuid('alice')}.json`]: JSON.stringify({ DataVersion: 1, stats: {} }) },
    provenance: { source: 'host-collected-server-files', deterministicReplay: false, nondeterministicInputs: ['server-ticks'] } };
  const body = canonicalJson({ schemaVersion: 1, trialId: f.input.runtime.trial.trialId, runtimeId: snapshot.runtimeId,
    sha256: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), snapshot });
  const evidence = readMinecraftEvidenceExport(body, createHash('sha256').update(body).digest('hex'));
  f.input.runtime.dispose = vi.fn(async () => ({ removed: true, errors: [], evidenceDir: 'host-only' }));
  const ports: MinecraftNativeTrialPorts = { ...f.ports, collectEvidence: vi.fn(async () => evidence) };
  const retainEvidence = vi.fn(async (_archive: { trialId: string; sha256: string; body: string }) => {}), onResult = vi.fn(async () => {});
  return { ...f, ports, control: { rolloutId: 'frozen-rollout', retainEvidence, onResult, now: () => 0 }, evidence };
}
describe('Minecraft native trial coordinator', () => {
  it('retains trusted replay before persisting an unsolved task in the shared denominator', async () => {
    const f = await trialFixture();
    const result = await runMinecraftNativeTrial(f.input, f.control, f.ports);
    expect(result).toMatchObject({ attemptedTaskIds: ['t1'], skippedTaskIds: [], accountingUnknown: false });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ suite: 'minecraft', arm: 'stock', generationStatus: 'completed',
      graderStatus: 'failed', resolved: false, score: 0, costUsd: 0.2 });
    const archive = f.control.retainEvidence.mock.calls[0]![0];
    expect(readMinecraftEvidenceExport(archive.body, archive.sha256)).toEqual(f.evidence);
    expect(f.control.retainEvidence.mock.invocationCallOrder[0]).toBeLessThan(f.control.onResult.mock.invocationCallOrder[0]!);
    expect(f.ports.collectEvidence).toHaveBeenCalledOnce();
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
    expect(f.native.stop).toHaveBeenCalledOnce();
  });
  it('retains failure replay and a denominator row when native generation cannot start', async () => {
    const f = await trialFixture();
    vi.mocked(f.ports.startAssignment).mockRejectedValue(Error('native startup refused'));
    const result = await runMinecraftNativeTrial(f.input, f.control, f.ports);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ generationStatus: 'error', resolved: null });
    expect(f.control.retainEvidence).toHaveBeenCalledOnce(); expect(f.control.onResult).toHaveBeenCalledOnce();
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
  });
  it.each(['archive', 'row'])('propagates a failed %s sink and still disposes the runtime', async sink => {
    const f = await trialFixture();
    const target = sink === 'archive' ? f.control.retainEvidence : f.control.onResult;
    target.mockRejectedValue(Error('durability unavailable'));
    await expect(runMinecraftNativeTrial(f.input, f.control, f.ports)).rejects.toThrow(/durability unavailable/);
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
    if (sink === 'archive') expect(f.control.onResult).not.toHaveBeenCalled();
  });
  it('propagates unverified runtime cleanup after a persisted row', async () => {
    const f = await trialFixture();
    vi.mocked(f.input.runtime.dispose).mockResolvedValue({ removed: false, errors: ['container remains'], evidenceDir: 'host-only' });
    await expect(runMinecraftNativeTrial(f.input, f.control, f.ports)).rejects.toThrow(/cleanup incomplete: container remains/);
    expect(f.control.onResult).toHaveBeenCalledOnce();
  });
  it('refuses an unverified coordinated topology before native allocation or runtime disposal', async () => {
    const f = await fixture('coordinated');
    const dispose = vi.fn(); f.input.runtime.dispose = dispose;
    const ports = { ...f.ports, readRepeatedSession: vi.fn(), collectEvidence: vi.fn() };
    await expect(runMinecraftNativeTrial(f.input, { rolloutId: 'frozen', retainEvidence: vi.fn(), onResult: vi.fn() }, ports))
      .rejects.toThrow(/frozen native reference/);
    expect(f.ports.startAssignment).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });
});

async function storedTrialFixture() {
  const f = await trialFixture();
  const { current } = f.input;
  const rolloutId = rolloutIdFor(current.protocol.runId, 'minecraft', current.task.instanceId,
    current.options.armId, current.options.seed);
  const emitRollout = vi.fn<MinecraftStoredTrialPorts['emitRollout']>(async () => ({ rolloutId, runId: current.protocol.runId }));
  return { ...f, rolloutId, ports: { ...f.ports, emitRollout } };
}
describe('Minecraft canonical rollout persistence', () => {
  it('atomically stores replay, unsolved score, native accounting and frozen provenance in the existing rollout', async () => {
    const f = await storedTrialFixture();
    const result = await runMinecraftStoredTrial(f.input, f.ports);
    expect(f.ports.emitRollout).toHaveBeenCalledOnce();
    const [saved, scope] = f.ports.emitRollout.mock.calls[0]!;
    expect(scope).toEqual({ workspaceId: 'benchmarks' });
    expect(saved).toMatchObject({ suite: 'minecraft', modality: 'in-container', taskId: 't1', arm: 'stock',
      generation: { status: 'completed', tokensIn: result.rows[0]!.tokensIn,
        tokensOut: result.rows[0]!.tokensOut, tokensTotal: result.rows[0]!.tokensTotal,
        armMeta: { executionPath: 'minecraft-native-assignment' } },
      grading: { resolved: false, status: 'failed', score: 0, family: 'minecraft' },
      provenance: { configSnapshot: { protocol: f.input.current.protocol,
        minecraft: { trial: f.input.runtime.trial, pair: f.input.pairing.pair } } } });
    const retained = saved.generation.armMeta!.minecraftEvidence as { sha256: string; trialId: string };
    expect(readMinecraftEvidenceExport(saved.generation.submission!, retained.sha256)).toEqual(f.evidence);
    expect(result.rows[0]).toMatchObject({ rolloutId: f.rolloutId, armMeta: { minecraftEvidence: retained } });
    expect(f.control.retainEvidence).not.toHaveBeenCalled();
    expect(f.control.onResult).not.toHaveBeenCalled();
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
  });
  it('persists failed native startup and its replay without turning it into a capability failure', async () => {
    const f = await storedTrialFixture();
    vi.mocked(f.ports.startAssignment).mockRejectedValue(Error('native startup refused'));
    await runMinecraftStoredTrial(f.input, f.ports);
    const saved = f.ports.emitRollout.mock.calls[0]![0];
    expect(saved).toMatchObject({ generation: { status: 'error' }, grading: { resolved: null, status: 'error' } });
    expect(saved.generation.submission).toContain(f.input.runtime.trial.trialId);
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
  });
  it('snapshots host provenance before awaiting native startup', async () => {
    const f = await storedTrialFixture();
    const initialState = structuredClone(f.input.pairing.initialState);
    const environment = structuredClone(f.input.runtime.measurement);
    vi.mocked(f.ports.startAssignment).mockImplementationOnce(async () => {
      f.input.pairing.initialState = { ...initialState, worldSha256: sha(99) };
      f.input.runtime.measurement = { ...environment, serverInstanceId: 'later-server' };
      return f.native;
    });
    await runMinecraftStoredTrial(f.input, f.ports);
    expect(f.ports.emitRollout.mock.calls[0]![0].provenance).toMatchObject({
      configSnapshot: { minecraft: { initialState } }, envFingerprint: environment,
    });
  });
  it.each(['rejected', 'foreign-receipt'])('propagates %s persistence and still verifies runtime disposal', async failure => {
    const f = await storedTrialFixture();
    if (failure === 'rejected') f.ports.emitRollout.mockRejectedValue(Error('transaction unavailable'));
    else f.ports.emitRollout.mockResolvedValue({ rolloutId: 'foreign', runId: f.input.current.protocol.runId });
    await expect(runMinecraftStoredTrial(f.input, f.ports)).rejects.toThrow(
      failure === 'rejected' ? /transaction unavailable/ : /foreign persistence receipt/);
    expect(f.input.runtime.dispose).toHaveBeenCalledOnce();
  });
  it.each(['context', 'store'])('refuses a foreign %s workspace before native allocation', async source => {
    const f = await storedTrialFixture();
    if (source === 'context') f.input.current.context.workspaceId = 'foreign';
    else f.input.current.scope.workspaceId = 'foreign';
    await expect(runMinecraftStoredTrial(f.input, f.ports)).rejects.toThrow(/workspace/);
    expect(f.ports.startAssignment).not.toHaveBeenCalled();
    expect(f.ports.emitRollout).not.toHaveBeenCalled();
    expect(f.input.runtime.dispose).not.toHaveBeenCalled();
  });
});
