/**
 * Frozen pre-implementation baseline for identity-definitions-own-policy-2026-10-17 P-001.
 *
 * The tool schemas come from a real launched Codex home's managed tool prompts, not
 * from the capability-envelope implementation this plan changes. The population is
 * derived independently from the built-in blueprint documents. Runtime observations
 * are immutable ledger receipts collected on 2026-10-22.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleRepoRoot } from '../module-repo-root';
import { parse as parseYaml } from 'yaml';
import { replayAgentSpecification, specificationPrompt } from '@papercusp/orchestrator/blueprint';

export const IDOP_P001_BASELINE_REL = 'docs/evidence/idop-p001-baseline-2026-10-22.json';
export const IDOP_P001_PROMPT_REL = 'apps/operator/prompts/papercusp-su.codex.md';

export type IdopPromptObservation = {
  sourceSession: {
    ownerId: string; nativeSessionId: string; advSessionId: number;
    nativeMessageTimestamp: string; nativeMetaTimestamp: string;
    nativeRecordLine: number; nativeTranscript: string;
    sourceClosure: string; sourceClosureSha256: string; specificationRevision: string;
  };
  renderedPrompt: { sha256: string; bytes: number; characters: number; frozenPath: string };
  nativeDelivery: {
    recordSha256: string; completeAgentsTextSha256: string; completeAgentsTextBytes: number;
    occurrences: number; prefix: string; suffix: string; excludedRenderedFields: string[];
  };
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

/** Replay saved launch inputs and compare with an independently read native record.
 * Raw prompt bytes stay with the caller; the returned receipt contains only digests.
 */
export function inspectIdopP001PromptArchive(
  manifest: IdopPromptObservation,
  readBytes: (ref: string) => Buffer,
  originalNativeRecord: Buffer,
) {
  const requireProof = (condition: unknown, reason: string): void => {
    if (!condition) throw new Error(`IDOP prompt observation: ${reason}`);
  };
  requireProof(manifest.sourceSession.nativeSessionId.trim(), 'missing native session');
  requireProof(Number.isSafeInteger(manifest.sourceSession.nativeRecordLine) &&
    manifest.sourceSession.nativeRecordLine > 0, 'invalid native record line');
  requireProof(manifest.nativeDelivery.excludedRenderedFields.length === 0, 'render exclusions are not accepted');
  const files = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    requireProof(!files.has(entry.path), 'duplicate archive reference');
    const bytes = readBytes(entry.path);
    requireProof(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'archive digest mismatch');
    files.set(entry.path, bytes);
  }
  const archived = (ref: string): Buffer => {
    const bytes = files.get(ref);
    requireProof(bytes !== undefined, 'unlisted archive reference');
    return bytes!;
  };
  const soleFile = (name: string): Buffer => {
    const matches = [...files.keys()].filter(ref => ref.endsWith(`/${name}`));
    requireProof(matches.length === 1, 'missing or ambiguous archive file');
    return archived(matches[0]);
  };
  // sourceClosure names the original observation; files names its frozen copy.
  // Verify that copy against the original's digest without rewriting provenance.
  const sourceBytes = soleFile('source-closure.json');
  requireProof(sha256(sourceBytes) === manifest.sourceSession.sourceClosureSha256, 'source closure digest mismatch');
  const closure = JSON.parse(sourceBytes.toString('utf8')) as {
    response: { truncated: boolean; rows: Array<{
      id: string; session_id: string; coord_owner_id: string;
      launch_spec: { specificationArtifact: unknown; specificationRevision: string };
    }> };
  };
  requireProof(closure.response.truncated === false && closure.response.rows.length === 1,
    'source session census is not exact');
  const session = closure.response.rows[0];
  requireProof(String(session.id) === String(manifest.sourceSession.advSessionId) &&
    session.session_id === manifest.sourceSession.nativeSessionId &&
    session.coord_owner_id === manifest.sourceSession.ownerId, 'source session mismatch');
  const replayed = replayAgentSpecification(session.launch_spec.specificationArtifact);
  requireProof(replayed.specificationRevision === manifest.sourceSession.specificationRevision &&
    session.launch_spec.specificationRevision === replayed.specificationRevision, 'specification revision mismatch');
  const prompt = archived(manifest.renderedPrompt.frozenPath);
  requireProof(prompt.length === manifest.renderedPrompt.bytes &&
    sha256(prompt) === manifest.renderedPrompt.sha256 &&
    // The capture's Python len counts Unicode code points, not UTF-16 units.
    Array.from(prompt.toString('utf8')).length === manifest.renderedPrompt.characters, 'render digest mismatch');
  requireProof(Buffer.from(specificationPrompt(replayed)).equals(prompt), 'replayed render differs');
  const meta = JSON.parse(soleFile('native-session-meta.jsonl').toString('utf8')) as {
    timestamp: string; type: string; payload: { id: string; session_id: string; timestamp: string };
  };
  // The payload records session creation; the outer timestamp records emission.
  requireProof(meta.type === 'session_meta' && meta.payload.timestamp === manifest.sourceSession.nativeMetaTimestamp &&
    meta.payload.id === manifest.sourceSession.nativeSessionId &&
    meta.payload.session_id === manifest.sourceSession.nativeSessionId, 'native session mismatch');
  const recordBytes = soleFile('native-agents-record.jsonl');
  requireProof(recordBytes.equals(originalNativeRecord), 'original native record differs');
  requireProof(sha256(recordBytes) === manifest.nativeDelivery.recordSha256, 'native record digest mismatch');
  const record = JSON.parse(recordBytes.toString('utf8')) as {
    timestamp: string; type: string;
    payload: { type: string; role: string; content: Array<{ type: string; text?: string }> };
  };
  requireProof(record.type === 'response_item' && record.payload.type === 'message' &&
    record.payload.role === 'user' && record.timestamp === manifest.sourceSession.nativeMessageTimestamp,
  'native message provenance mismatch');
  const texts = record.payload.content.filter(part => part.type === 'input_text' &&
    typeof part.text === 'string').map(part => part.text!);
  const expected = manifest.nativeDelivery.prefix + prompt.toString('utf8') + manifest.nativeDelivery.suffix;
  const matches = texts.filter(text => text === expected);
  requireProof(manifest.nativeDelivery.occurrences === 1 && matches.length === 1, 'native prompt differs');
  requireProof(Buffer.byteLength(matches[0]) === manifest.nativeDelivery.completeAgentsTextBytes &&
    sha256(matches[0]) === manifest.nativeDelivery.completeAgentsTextSha256, 'native text digest mismatch');
  return { nativeSessionId: session.session_id, specificationRevision: replayed.specificationRevision,
    renderedPromptSha256: sha256(prompt), nativeRecordSha256: sha256(recordBytes), filesChecked: files.size };
}

type Observation = {
  identity: string;
  stackRefs: string[];
  ownerId: string;
  nativeSessionId: string | null;
  activationEventId?: number;
  toolInvocationId?: number;
  observedAt: string;
  principal: string;
  status: 'observed' | 'tool-refused' | 'launch-refused';
  outputRef?: string;
  refusal?: string;
};

type CoverageInput = {
  population: {
    roles: Array<{ id: string }>;
    builtInIdentities: Array<{ id: string }>;
  };
  observations: Array<Pick<Observation, 'identity' | 'status' | 'ownerId' | 'observedAt' |
    'toolInvocationId' | 'activationEventId' | 'refusal'> & Partial<Pick<Observation, 'nativeSessionId'>>>;
};

/** A row-count floor cannot establish coverage of an independently enumerated population. */
export function inspectIdopP001Coverage(baseline: CoverageInput) {
  const population = [
    ...baseline.population.roles.map(({ id }) => `role:${id}`),
    ...baseline.population.builtInIdentities.map(({ id }) => `identity:${id}`),
  ].sort();
  const roles = new Set(baseline.population.roles.map(({ id }) => id));
  const expected = new Set(population);
  const checked = new Set<string>();
  const refused = new Set<string>();
  const invalid: string[] = [];
  for (const row of baseline.observations) {
    const key = `${roles.has(row.identity) ? 'role' : 'identity'}:${row.identity}`;
    const invocation = Number.isSafeInteger(row.toolInvocationId) && Number(row.toolInvocationId) > 0;
    const sourceSession = typeof row.nativeSessionId === 'string' && row.nativeSessionId.trim().length > 0;
    const receipt = invocation && (row.status === 'launch-refused'
      ? Boolean(row.refusal?.trim())
      : sourceSession && /^su-/.test(row.ownerId) && (row.status === 'observed' ||
          (row.status === 'tool-refused' && Boolean(row.refusal?.trim()))));
    // An invocation/owner cannot identify the source session; retain missing provenance as invalid.
    // Activation proves a worn layer, but does not by itself prove its effective tool set.
    if (!expected.has(key) || !receipt || !Number.isFinite(Date.parse(row.observedAt))) {
      invalid.push(key);
      continue;
    }
    if (row.status === 'observed') checked.add(key);
    else refused.add(key);
  }
  const missing = population.filter((key) => !checked.has(key) && !refused.has(key));
  return {
    complete: missing.length === 0 && refused.size === 0 && invalid.length === 0 && expected.size === population.length,
    population,
    checked: [...checked].sort(),
    refused: [...refused].sort(),
    missing,
    invalid: [...new Set(invalid)].sort(),
    duplicatePopulation: population.filter((key, index) => population.indexOf(key) !== index),
  };
}

export const RUNTIME_OBSERVATIONS: Observation[] = [
  { identity: 'su.mode-auto', stackRefs: ['autonomy:su.mode-auto'], ownerId: 'su-7a61b3ed-841b-4d7c-b177-f87c76073391', nativeSessionId: '01a16441-1bb3-7882-8c8f-69bfe2cddb16', activationEventId: 87801, observedAt: '2026-10-22T15:35:51.100747Z', principal: 'system:superuser', status: 'observed' },
  { identity: 'papercup.audience-engineer', stackRefs: ['audience:papercup.audience-engineer'], ownerId: 'su-afaffb1c-c265-4cb5-a71e-cbacf7b4ec85', nativeSessionId: '01a16461-be32-7870-ad38-42bd7cb2a49b', toolInvocationId: 43032599, observedAt: '2026-10-22T16:11:52.254Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/04241dbb-3d43-43ae-96fb-cbcef7587411/result-door-1792685512258.md' },
  { identity: 'judge-grading-integrity', stackRefs: ['practice:judge-grading-integrity'], ownerId: 'su-86efb84d-fbd6-4007-98a1-f8e054ccdfd4', nativeSessionId: '01a16461-be99-7a71-a6b7-2c4e9c247c2d', toolInvocationId: 43032600, observedAt: '2026-10-22T16:11:52.266Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/9b9d01b4-5ed8-46fe-bd2f-666e205a612a/result-door-1792685512270.md' },
  { identity: 'research-steward', stackRefs: ['domain:research-steward'], ownerId: 'su-be25082a-1b8a-4f4b-b097-1b3f5165727f', nativeSessionId: '01a16461-bf1a-7622-b133-f81d3d8e3304', toolInvocationId: 43032616, observedAt: '2026-10-22T16:11:55.590Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/facc7688-887f-4dc1-8067-16529fe493e8/result-door-1792685515594.md' },
  { identity: 'judge-domain', stackRefs: ['domain:judge-domain'], ownerId: 'su-c3c0b1e6-c190-4abd-b543-801e26292824', nativeSessionId: '01a16461-be2d-70b1-b111-119b5ad7cebf', toolInvocationId: 43033038, observedAt: '2026-10-22T16:13:01.553Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/5b6db70d-a7d6-4881-88d3-5c4f0215acd1/result-door-1792685581558.md' },
  { identity: 'judge-ensemble', stackRefs: ['practice:judge-ensemble'], ownerId: 'su-c7e6e19c-c281-4e6f-b106-ea2f72a81255', nativeSessionId: '01a16464-8aef-7382-89de-9cda5ea357e5', toolInvocationId: 43034113, observedAt: '2026-10-22T16:15:32.078Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/37e33f85-4fed-482e-8632-be3da3e186b7/result-door-1792685732082.md' },
  { identity: 'operator.audience-engineer', stackRefs: ['audience:operator.audience-engineer'], ownerId: 'su-8b79e88e-4682-4e23-81f0-f48e8c470473', nativeSessionId: '01a16463-84c3-7d03-978e-7303d77fbb9c', toolInvocationId: 43036259, observedAt: '2026-10-22T16:19:51.809Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/200248fa-0446-43da-9125-a39573817348/result-door-1792685991815.md' },
  { identity: 'judge-gym', stackRefs: ['practice:judge-gym'], ownerId: 'su-7403dff7-ecd1-4549-a0ad-f7ab2b882f83', nativeSessionId: '01a16463-8337-7521-ad8c-e5af96e5f09d', toolInvocationId: 43036260, observedAt: '2026-10-22T16:19:53.046Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/d928aad8-69e9-41d4-ada5-510d611aec2e/result-door-1792685993050.md' },
  { identity: 'blueprint-operation-worker', stackRefs: ['domain:blueprint-operation-worker'], ownerId: 'su-31c2b870-5080-4406-8a7d-c960f9e54aaa', nativeSessionId: null, toolInvocationId: 43036688, observedAt: '2026-10-22T16:21:09.975Z', principal: 'loopback', status: 'tool-refused', refusal: 'agent_tools:list returned role-not-allowed' },
  { identity: 'su.mode-goal', stackRefs: ['goal:su.mode-goal'], ownerId: 'su-d1800dfa-4da2-45b3-86fd-09f1e3120db9', nativeSessionId: '01a16464-8a9a-7ab2-89ac-89d9634e0705', toolInvocationId: 43036691, observedAt: '2026-10-22T16:21:10.814Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/90f3eb59-8166-49e6-8858-861123cf4188/result-door-1792686070819.md' },
  { identity: 'papercup.audience-novice', stackRefs: ['audience:papercup.audience-novice'], ownerId: 'su-10052bd8-7413-4fba-96e2-c7d78ffb5f57', nativeSessionId: '01a16464-8e7c-7bb2-8ab3-f1ecf388cd86', toolInvocationId: 43036702, observedAt: '2026-10-22T16:21:11.206Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/bf3b31d4-930d-4654-beab-9bf0e1ec7637/result-door-1792686071213.md' },
  { identity: 'su.mode-test', stackRefs: ['test:su.mode-test'], ownerId: 'su-af12cd24-704d-4594-9ddd-ee73dd556571', nativeSessionId: null, toolInvocationId: 43036704, observedAt: '2026-10-22T16:21:13.139Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/e240ca0d-021a-4da5-88f8-7380319e14ce/result-door-1792686073142.md' },
  { identity: 'su.mode-grade', stackRefs: ['grade:su.mode-grade'], ownerId: 'su-9b64fd17-7089-4b81-9302-d3539c800255', nativeSessionId: '01a16464-a13f-7b03-9004-e069c62172a5', toolInvocationId: 43036713, observedAt: '2026-10-22T16:21:13.277Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/8b184eb7-689b-468b-8b32-e8e9e7123bde/result-door-1792686073279.md' },
  { identity: 'operator.audience-novice', stackRefs: ['audience:operator.audience-novice'], ownerId: 'su-d22cfeff-524c-4558-8aa1-de07236b4ff5', nativeSessionId: '01a16464-d7b9-7e12-80e3-a996bcf668cd', toolInvocationId: 43036725, observedAt: '2026-10-22T16:21:16.250Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/cb5e377c-0d66-478b-9cf7-355a67bf5d53/result-door-1792686076257.md' },
  { identity: 'su.mode-drain', stackRefs: ['objective:su.mode-drain'], ownerId: 'su-97533b6c-b337-4f3f-a764-bb6879c9509c', nativeSessionId: '01a16464-8cb4-72b2-8ea7-aeaf0656cee8', toolInvocationId: 43036854, observedAt: '2026-10-22T16:21:34.048Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/233845b6-4c5f-4449-ba74-fc47f7d22adf/result-door-1792686094051.md' },
  { identity: 'judge-acceptance', stackRefs: ['practice:judge-acceptance'], ownerId: 'su-f9320b8d-e34e-4680-8c95-8c5fca7e15ce', nativeSessionId: '01a16463-8479-7193-891e-a65deb499ea9', toolInvocationId: 43039339, observedAt: '2026-10-22T16:28:10.930Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/a27c844b-0d3a-4159-9f0c-6c1df8fa31a6/result-door-1792686490935.md' },
  ...['scout.lens-analogical', 'scout.lens-constraint-removal', 'scout.lens-first-principles', 'scout.lens-reframing'].map((identity): Observation => ({ identity, stackRefs: [`practice:${identity}`], ownerId: 'launch-refused', nativeSessionId: null, observedAt: '2026-10-22T17:01:40Z', principal: 'loopback', status: 'launch-refused', refusal: `bootstrap-su HTTP 400: selected SU identity ${identity} is missing practice document` })),
  { identity: 'su.specialist-planner', stackRefs: ['practice:su.specialist-planner'], ownerId: 'launch-refused', nativeSessionId: null, observedAt: '2026-10-22T17:01:40Z', principal: 'loopback', status: 'launch-refused', refusal: 'bootstrap-su HTTP 500: composition compiler prompt-missing specialist:su.planner' },
];

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const root = moduleRepoRoot(import.meta.url);

function builtInIdentities() {
  const dir = join(root, 'libs/papercusp/packages/harness/blueprints');
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name, 'blueprint.yaml');
    let raw: Record<string, unknown>;
    try { raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return []; }
    return Array.isArray(raw.slots) ? [{ id: String(raw.id), path: path.slice(root.length + 1), slots: raw.slots }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function launchedToolSchemas(promptsDir: string) {
  return readdirSync(promptsDir).filter((name) => /^tool-.*\.md$/.test(name)).sort().flatMap((name) => {
    const text = readFileSync(join(promptsDir, name), 'utf8');
    const tool = text.match(/`([^`]+)` tool on this MCP server/)?.[1];
    const schemaText = text.match(/Tool input JSON Schema:\n```json\n([\s\S]*?)\n```/)?.[1];
    if (!tool || !schemaText) return [];
    const schema = JSON.parse(schemaText) as unknown;
    return [{ name: tool, schema, schemaSha256: sha256(JSON.stringify(schema)) }];
  });
}

export function buildIdopP001Baseline(promptsDir: string) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024,
  }).trim();
  const prompt = readFileSync(join(root, IDOP_P001_PROMPT_REL));
  const identities = builtInIdentities();
  const tools = launchedToolSchemas(promptsDir);
  return {
    schemaVersion: 1,
    plan: 'identity-definitions-own-policy-2026-10-17',
    item: 'P-001',
    capturedAt: '2026-10-22T17:03:00Z',
    base: { commit: head, promptPath: IDOP_P001_PROMPT_REL, promptGitBlob: execFileSync('git', ['-C', root, 'hash-object', IDOP_P001_PROMPT_REL], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024,
    }).trim(), promptSha256: sha256(prompt), promptBytes: prompt.length },
    population: { roles: [{ id: 'infra-reviewer' }, { id: 'security-reviewer' }], roleCount: 2, builtInIdentities: identities, builtInIdentityCount: identities.length },
    toolCatalog: { sourceKind: 'real-launched-codex-managed-tool-prompts', sourceDirectory: promptsDir, count: tools.length, digest: sha256(JSON.stringify(tools)), tools },
    observations: RUNTIME_OBSERVATIONS,
    suVariationFinding: 'Modes and fleet posture did not add grants; tool-policy differences observed are principal/role and mode-narrowing effects, not layer grants (D-009).',
    overrideChannels: ['PAPERCUSP_SU_* / launch environment', '?superuser=1 legacy query parameter', 'principal.kind / authenticated principal', 'role envelope', 'mode registry', 'fleet posture'],
    vault: {
      baseline: { grantTerms: 'all effects; no expiry; no per-use approval', afterReadHolds: 'off', transcriptVisibility: 'open, including originating agent', automaticRecall: 'on' },
      evidence: ['identity-definitions-own-policy-2026-10-17#D-006', 'packages/operator-core/lib/personal-vault/disclosure-ledger.ts:244-285', 'packages/operator-core/lib/personal-vault/transcript-exclusion.ts:106-113'],
      supersededBy: 'identity-definitions-own-policy-2026-10-17#D-020',
    },
    answers: {
      baseKnobsAndParams: 'Identity composition extends base and therefore applies base knobs/params before slotted contributions.',
      governanceSeesWornIdentity: 'No. session-governance judges model/provider/data-use from launch records but does not consume the worn identity stack; D-020 requires unification.',
      p016AndP019: 'P-016 is newly blocked work added by D-020; no P-019 exists in the current IDOP plan.',
      directoryGroups: 'No directory-group wearer authority exists in wearer-authority.ts; it resolves launch role and capability ceilings only.',
      secrets: 'Secret scope is planned stack state; current launch materialization remains host/launch-path specific rather than an identity-stack binding.',
      installConsent: 'One consent binds the exact installed artifact hash plus its computed subject set, not each layer or installed stack independently.',
      consentAndProviderCapacity: 'Consent subjects include grants and pot provider bindings. Provider bindings cannot store per-layer grant decisions or stack settings; those remain unimplemented.',
    },
    knownDefect: 'EI-26700090355079325',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const promptsDir = process.argv[2];
  if (!promptsDir) throw new Error('usage: tsx idop-p001-baseline.ts <launched-codex-prompts-dir>');
  const target = join(root, IDOP_P001_BASELINE_REL);
  if (existsSync(target)) throw new Error('The pre-implementation baseline is frozen; append receipt evidence separately instead of overwriting it');
  const baseline = buildIdopP001Baseline(promptsDir);
  const coverage = inspectIdopP001Coverage(baseline);
  if (!coverage.complete) throw new Error(`Incomplete baseline coverage: ${JSON.stringify(coverage)}`);
  writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
}
