import { papercuspPath } from '@papercusp/host-platform/home';
import { readFile, appendFile, open, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { installFlagOverrideStore } from '../../flag-override-store.ts';
import { productionDreamCycle } from '../../dream/dream-cycle-action.ts';
import { applyDreamGraphTreatment, dreamEvaluationProtocolHash, requireDreamPilotProtocol } from '../../dream/dream-evaluation.ts';
import { capabilityHash } from '../../dream/capability-contracts.ts';
import { preflightCapabilityReview, rerankCapabilityPriors } from '../../dream/capability-review.ts';
import { buildCapabilityReviewSources } from '../../dream/capability-review-sources.ts';
import { getCurrentCapabilityManifest, getPilotCapabilityManifest } from '../../dream/capability-catalog.ts';
import { buildCapabilityPacket, queryCapabilityGraph, verifyCapabilityPacket } from '../../dream/capability-packets.ts';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from '../../dream/capability-sampler.ts';
import { CAPABILITY_DREAM_PROMPT_VERSION } from '../../dream/capability-pass.ts';
import { studySampling } from './sampling.mts';
import { STUDY_BLOCKS, validateStudyBlocks, prepareStudyPilot, readStudyTotals, studyPacketVerifier, requireStudyPacket } from './accounting.mts';
import { DEFAULT_DREAM_REVIEW_CONFIG } from '../../dream/dream-config.ts';
import { getDreamRun } from '../../dream/dream-run-store.ts';
import { dreamCapabilityRun } from '../../dream/dream-run-provenance.ts';
import { captureStudyTiming } from './timing.mts';
import { enableStudyMaster, prepareStudyRoutine, requireStudyMasterPreflight, restoreStudyControls, studyRestorationPorts, studyRoutinePorts } from './controls.mts';
import { moduleRepoRoot } from '../../module-repo-root.ts';
import { serializeIdentitySafeJson } from '../../../../../scripts/lib/identity-leak-patterns.mjs';

// This standalone driver does not inherit the operator service's environment.
// A fresh in-process model can miss the review deadline after generation is paid.
// Require the operator's configured local sidecar and prove readiness before any write.
const sidecar = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
if (!sidecar || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(sidecar))
  throw new Error('D017 study requires PAPERCUSP_EMBED_SIDECAR_URL from the local operator service before any settings change or paid call');

const here = dirname(fileURLToPath(import.meta.url));
const root = moduleRepoRoot(import.meta.url);
const workspaceId = 'papercusp-workspace';
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blockArg = process.argv.find(arg => arg.startsWith('--block='))?.slice('--block='.length) ?? 'haiku';
if (blockArg !== 'haiku' && blockArg !== 'luna') throw new Error('Unknown study model block');
const blocks = await Promise.all(Object.values(STUDY_BLOCKS).map(async block => JSON.parse(await readFile(resolve(here, block.file), 'utf8'))));
const comparisonFile = process.argv.find(arg => arg.startsWith('--comparison='))?.slice('--comparison='.length);
const comparisonBlock = comparisonFile ? JSON.parse(await readFile(resolve(here, comparisonFile), 'utf8')) : null;
if (comparisonBlock) blocks.push(comparisonBlock);
const limits = validateStudyBlocks(blocks);
const frozen = comparisonBlock ?? blocks.find(block => block.pin === STUDY_BLOCKS[blockArg].pin)!;
if (dreamEvaluationProtocolHash(frozen.protocol) !== frozen.pin) throw new Error('Study protocol hash changed');
const graphComparison = !!frozen.protocol.comparison?.graphAblation;
if (comparisonFile && !graphComparison) throw new Error('Comparison file must register a graph/control study');
const treatment = process.argv.find(arg => arg.startsWith('--treatment='))?.slice('--treatment='.length);
if (treatment !== undefined && treatment !== 'graph' && treatment !== 'control') throw new Error('Unknown graph study treatment');
const arm = (process.argv.find(arg => ['uniform-pair', 'structured-pair', 'structured-triple'].includes(arg)) ??
  (graphComparison ? 'structured-pair' : 'uniform-pair')) as 'uniform-pair' | 'structured-pair' | 'structured-triple';
const log = async (entry: unknown) => {
  const line = serializeIdentitySafeJson({ at: new Date().toISOString(), entry }, undefined, { compact: true });
  await appendFile(resolve(here, 'cycle-events.jsonl'), line);
  console.log(line.slice(0, -1));
};
const verifyPacket = studyPacketVerifier({ verify: verifyCapabilityPacket, graph: queryCapabilityGraph,
  // Preserve the verifier's private-pack root, byte budget, fatal UTF-8 and
  // growth checks. Its bounded artifact reader is private to the frozen source.
  readArtifact: async path => {
    const packRoot = await realpath(papercuspPath('scratch', 'packs'));
    const file = await realpath(resolve(packRoot, path));
    const rel = relative(packRoot, file);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new Error('Evidence escapes repository scope');
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Evidence exceeds the artifact byte budget');
      const buffer = Buffer.alloc(info.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > info.size) throw new Error('Evidence grew during its bounded read');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
    } finally { await handle.close(); }
  }, record: log });
async function tool(name: string, args: object) {
  const raw = await new Promise<string>((done, fail) => {
    const child = spawn('ptool', [name, '--workspace=' + workspaceId, '--harness=papercusp', '--json', '-'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(stdout) : fail(new Error(name + ' exit ' + code + ': ' + stderr.slice(-1000))));
    child.stdin.end(JSON.stringify(args));
  });
  let result = JSON.parse(raw);
  if (Array.isArray(result.content)) {
    const text = result.content.find((c: { type: string; text?: string }) => c.type === 'text' && c.text?.trim().startsWith('{'));
    if (text) result = JSON.parse(text.text);
  }
  await log({ tool: name, result });
  if (result.ok !== true || result.applied === false || result.reverted === true) throw new Error(name + ' did not confirm success');
  return result;
}
installFlagOverrideStore();
const { sql } = getOrgPg();
const ownerId = process.env.PAPERCUSP_SID;
if (!ownerId) throw new Error('Study cleanup requires the attributed PAPERCUSP_SID');
const restoration = studyRestorationPorts(sql, workspaceId, 'papercusp', ownerId);
const master = await sql<Array<{ enabled: boolean }>>`
  SELECT enabled FROM harness_shared.learning_pot_scope
  WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'`;
const runRequested = process.argv.includes('--run');
const masterEnabled = requireStudyMasterPreflight(master, runRequested, graphComparison);
const totals = await readStudyTotals(sql, workspaceId, blocks);
const { pilot, cumulative } = prepareStudyPilot(blocks, totals, { pin: frozen.pin, arm,
  ...(treatment ? { graphTreatment: treatment } : {}) });
// Replay the actual bounded source set from the failed review, without repeating
// its generation or changing the study record. Keep original failures in the funnel.
const [readiness] = await sql<Array<{ review: any; outcome: any }>>`
  SELECT review, outcome FROM harness_shared.dream_runs
   WHERE workspace_id = ${workspaceId}
     AND run_id = 'dream-cycle:papercusp-workspace:papercusp:edd8d09c-5088-4ed8-b567-7bb6a3b917bf:dream:1'`;
if (!readiness?.review?.priorMatches?.length || !readiness?.outcome?.insight?.capability)
  throw new Error('D017 rerank readiness evidence is missing');
const candidate = readiness.outcome.insight.capability;
const ranked = await rerankCapabilityPriors(candidate.behavior + '\n' + candidate.priorArt.proposedDelta, readiness.review.priorMatches, { timeoutMs: DEFAULT_DREAM_REVIEW_CONFIG.timeoutMs });
await log({ phase: 'rerank-readiness', outcome: ranked.outcome, expected: readiness.review.priorMatches.length });
if (!ranked.outcome.attempted || ranked.outcome.scored !== readiness.review.priorMatches.length) {
  await sql.end();
  throw new Error('D017 reranker is not ready; no settings changed and no provider called');
}
const manifest = frozen.protocol.comparison ? getCurrentCapabilityManifest() : getPilotCapabilityManifest();
const packetScope = { workspaceId, potSlug: 'papercusp', repositoryId: 'papercusp' };
const packets = [];
for (const unit of manifest.units) {
  const built = await buildCapabilityPacket({ rootPath: root, scope: packetScope, unit, manifestRevision: manifest.revision });
  packets.push(await requireStudyPacket(unit.id, built, log));
}
const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: root, scope: packetScope, manifest, packets });
if (snapshot.fingerprint !== frozen.protocol.sourceSnapshot) throw new Error('Frozen study source snapshot changed');
const { sampler, annotationHash } = studySampling(snapshot, arm, graphComparison);
requireDreamPilotProtocol(pilot, { sourceSnapshot: snapshot.fingerprint, manifestRevision: snapshot.manifestRevision,
  scope: packetScope, generator: frozen.protocol.models.generator, reviewer: frozen.protocol.models.reviewer,
  mode: 'manual', samplerMode: sampler.mode, arity: sampler.arity, samplerHash: capabilityHash(JSON.stringify(sampler)),
  cycle: { maxCostUsd: limits.cycleUsd, rolling24hCostUsd: limits.rollingDayUsd } });
const treatmentSnapshot = applyDreamGraphTreatment(snapshot, pilot);
const sample = sampleCapabilityCombination(treatmentSnapshot, { ...sampler,
  seed: graphComparison ? frozen.protocol.seed + ':matched-pair:' + pilot.matchedPairIndex : frozen.protocol.seed + ':readiness',
  now: Date.now(), promptVersion: CAPABILITY_DREAM_PROMPT_VERSION });
if (sample.status !== 'selected' || (arm === 'structured-triple' && !sample.selection.c))
  throw new Error('Study sampler cannot supply its declared arm; no settings changed and no provider called');
// Readiness must exercise the same selected source search as production, not
// just rerank a historical match set that cannot expose retrieval failures.
if (graphComparison) {
  const reviewReadiness = await preflightCapabilityReview({ rootPath: root, manifest, selection: sample.selection,
    dreamerModel: frozen.protocol.models.generator, config: { model: frozen.protocol.models.reviewer },
    sources: buildCapabilityReviewSources({ sql, scope: packetScope, rootPath: root, manifest, packets, verifyPacket }) });
  await log({ phase: 'current-review-readiness', result: reviewReadiness });
  if (!reviewReadiness.ready) {
    await sql.end();
    throw new Error('Current comparison review is not ready; no controls or provider calls: ' + reviewReadiness.note);
  }
}
await log({ phase: 'sampling-readiness', arm, annotationHash, sampler, sourceSnapshot: snapshot.fingerprint });
await log({ phase: 'prepared', arm, block: blockArg, protocolPin: frozen.pin, graphTreatment: pilot.graphTreatment,
  models: frozen.protocol.models, matchedPairIndex: pilot.matchedPairIndex, masterEnabled, priorStudyArms: totals, cumulative });
if (!runRequested) {
  await log({ phase: 'dry-run', message: 'No settings changed and no provider called. Pass --run for one governed attempt.' });
  await sql.end();
  process.exit(0);
}
let routine: Awaited<ReturnType<typeof prepareStudyRoutine>> | undefined;
let masterAttempted = false;
const timingRuns: Array<{ runId: string; phases: string[] }> = [];
try {
  routine = await prepareStudyRoutine(studyRoutinePorts(sql, workspaceId, 'papercusp', ownerId), {
      mode: 'manual', pilot,
      cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
      sampler,
      pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
  }, log, graphComparison);
  await log({ phase: 'routine-admission', result: await routine.apply() });
  masterAttempted = !masterEnabled;
  await log({ phase: 'master-admission', result: await enableStudyMaster(sql, workspaceId, 'papercusp', ownerId, masterEnabled) });
  const result = await productionDreamCycle({ workspaceId, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null }, {
    mode: 'manual', pilot,
    cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
    sampler,
    pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
  }, { verifyPacket });
  await log({ phase: 'cycle-result', arm, protocolPin: frozen.pin, result });
  for (const run of result.runs) {
    const saved = await getDreamRun(sql, { workspaceId, runId: run.runId });
    timingRuns.push({ runId: run.runId, phases: saved ? (dreamCapabilityRun(saved)?.calls ?? []).map(call => call.phase) : [] });
  }
} finally {
  try { await restoreStudyControls({ masterAttempted, masterRetained: masterEnabled, restoreRoutine: routine?.restore }, restoration, log); }
  finally { await sql.end(); }
}
// Restoration takes priority over diagnostics. Persist the bounded gateway ring
// immediately afterward so an unrelated later request cannot erase this trial's evidence.
await captureStudyTiming({ workspaceId, potSlug: 'papercusp' }, timingRuns, {
  report: (ownerId) => tool('gateway:owner_report', {
    agent: ownerId,
    projection: { pick: ['ok', 'stageTelemetry.ownerId', 'stageTelemetry.recent'] },
  }),
  log,
});
process.exit(0);
