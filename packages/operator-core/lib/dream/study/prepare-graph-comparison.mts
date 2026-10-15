import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilityHash } from '../capability-contracts.ts';
import { installFlagOverrideStore } from '../../flag-override-store.ts';
import { getCurrentCapabilityManifest } from '../capability-catalog.ts';
import { buildCapabilityPacket } from '../capability-packets.ts';
import { buildCapabilitySamplingSnapshot, type CapabilitySamplingSnapshot } from '../capability-sampler.ts';
import { applyDreamGraphTreatment, dreamComparisonInputHash, freezeDreamEvaluationProtocol, DREAM_UTILITY_CONTRACT } from '../dream-evaluation.ts';
import { moduleRepoRoot } from '../../module-repo-root.ts';
import { STUDY_BLOCKS, validateStudyBlocks, type StudyBlock } from './accounting.mts';
import { freezeImmutableArtifacts } from './freeze-artifacts.mts';
import { studySampling } from './sampling.mts';
import { isCliEntry } from '../../util/cli-entry';

// Pre-registration describes future assessment; it does not manufacture labels.
export const GRAPH_OUTCOME_DESIGN = {
  version: 'native-graph-outcome-v1',
  utility: DREAM_UTILITY_CONTRACT,
  blinding: 'Remove treatment, model, run identifiers and original reviewer verdict before independent assessment; retain source citations and the executable falsifier.',
  execution: 'Execute the accepted falsifier in the project test framework. Count benefit only with observed baseline/control and intervention outcomes plus independent assessment.',
  duplicates: 'Group behavioral families before counting. An existing integration or refinement is not a novel family.',
  accounting: 'Attribute indexing, retrieval, generation, review, verification and experiment costs, failed attempts and reservations to both treatments; record engineer and reviewer minutes separately.',
  decision: 'Report paired exploratory observations. Missing, unequal or unexecuted outcomes remain inconclusive; proposal volume and reviewer acceptance cannot establish benefit.',
} as const;

/** Bind the existing protocol to a completely verified current population. */
export function prepareGraphComparison(snapshot: CapabilitySamplingSnapshot, blocks: readonly StudyBlock[]) {
  const limits = validateStudyBlocks(blocks);
  const historical = blocks.find(block => block.pin === STUDY_BLOCKS.haiku.pin)!;
  const models = (historical.protocol as { models: { generator: string; reviewer: string } }).models;
  const { sampler } = studySampling(snapshot, 'structured-pair', true);
  const common = {
    sourceSnapshot: snapshot.fingerprint,
    manifestRevision: snapshot.manifestRevision,
    scope: { workspaceId: snapshot.scope.workspaceId, potSlug: snapshot.scope.potSlug },
    problemContext: { mode: 'open-exploration' as const, evidence: [],
      note: 'Native P025: both treatments explore the same frozen current capability population; no owner problem evidence is invented.' },
  };
  const population = { manifestRevision: snapshot.manifestRevision, scope: snapshot.scope,
    sourceSnapshot: snapshot.fingerprint, entries: snapshot.eligible.map(entry => ({
      id: entry.packet.unit.id, contentVersion: entry.contentVersion,
      sources: entry.packet.sources.map(source => ({ id: source.id, path: source.path, sourceHash: source.sourceHash })),
      graph: entry.packet.graph,
    })) };
  const outcomeHash = capabilityHash(JSON.stringify(GRAPH_OUTCOME_DESIGN));
  const frozen = freezeDreamEvaluationProtocol({ sourceSnapshot: snapshot.fingerprint, models,
    discoveryUsd: limits.discoveryUsd, discoveryUsdPerArm: limits.discoveryUsdPerArm,
    cycleUsd: limits.cycleUsd, rollingDayUsd: limits.rollingDayUsd, experimentComputeUsd: limits.experimentComputeUsd,
    benchmarkHash: capabilityHash(JSON.stringify(population)), oracleHash: outcomeHash,
    independentLabelsRef: 'work-item:WI-10007888#native-graph-outcome-design; pending blinded independent executed outcomes',
    seed: 'native-p025-current-graph-control-v1',
    comparison: { manifestRevision: common.manifestRevision, scope: common.scope, problemContext: common.problemContext,
      inputHash: dreamComparisonInputHash(common), graphAblation: {
        treatments: ['graph', 'control'], populationIds: snapshot.eligible.map(entry => entry.packet.unit.id),
        samplerHash: capabilityHash(JSON.stringify(sampler)), attemptsPerTreatment: 2,
        usdPerTreatment: limits.cycleUsd * 2, outcomeAssessment: 'blinded-independent-executed-benefit',
      } },
  });
  // These guards reject exclusions, foreign/stale population and absent graph
  // treatment before any artifact can be called a registered comparison.
  for (const graphTreatment of ['graph', 'control'] as const)
    applyDreamGraphTreatment(snapshot, { ...frozen, arm: 'structured-pair', matchedPairIndex: 0, graphTreatment });
  validateStudyBlocks([...blocks, frozen]);
  return { frozen, population, outcomeDesign: GRAPH_OUTCOME_DESIGN };
}

async function main() {
  installFlagOverrideStore();
  const here = dirname(fileURLToPath(import.meta.url));
  const rootPath = moduleRepoRoot(import.meta.url);
  const blocks = await Promise.all(Object.values(STUDY_BLOCKS).map(async block =>
    JSON.parse(await readFile(resolve(here, block.file), 'utf8'))));
  const manifest = getCurrentCapabilityManifest();
  const scope = { workspaceId: 'papercusp-workspace', potSlug: 'papercusp', repositoryId: 'papercusp' };
  const packets = [];
  for (const unit of manifest.units) {
    console.log(JSON.stringify({ phase: 'packet-start', id: unit.id }));
    const built = await buildCapabilityPacket({ rootPath, scope, unit, manifestRevision: manifest.revision });
    if (built.status !== 'ready') throw new Error('Current graph study packet unavailable: ' + unit.id + ': ' + built.reason);
    packets.push(built.packet);
    console.log(JSON.stringify({ phase: 'packet-ready', id: unit.id,
      graphStatus: built.packet.graph?.status, graphCandidates: built.packet.graph?.candidates.length,
      graphUnmapped: built.packet.graph?.unmapped }));
  }
  const snapshot = await buildCapabilitySamplingSnapshot({ rootPath, scope, manifest, packets });
  const prepared = prepareGraphComparison(snapshot, blocks);
  const paths = ['native-graph-protocol.json', 'native-graph-population.json', 'native-graph-outcome-design.json'];
  const receipt = await freezeImmutableArtifacts([prepared.frozen, prepared.population, prepared.outcomeDesign]
    .map((value, i) => ({ path: resolve(here, paths[i]!), bytes: JSON.stringify(value, null, 2) + '\n' })));
  console.log(JSON.stringify({ ...receipt, pin: prepared.frozen.pin, sourceSnapshot: snapshot.fingerprint,
    population: snapshot.eligible.length, paths, providerCalls: 0, settingsChanged: false, independentOutcomes: 'pending' }));
}

if (isCliEntry(import.meta.url)) {
  try { await main(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
