/** Read-only semantic instrument over the existing native operational evidence ledger.
 * Explicit ESM keeps the maintained committed-source loader ahead of tsx transforms. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { listSpecEvidence } from '../packages/operator-core/lib/agent-tools/plans/spec-evidence-store';
import type { inspectCommittedOperationalEvidence } from '../packages/operator-core/lib/agent-tools/testing/record-run';
import type { NativeCapacityLlmRun, NativeCapacityBriefReceipt } from '../packages/operator-core/lib/fleet/capacity-recovery-evidence';

const S42_PATH = 'packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Recreate only generated reference pointers; instruction bytes remain authenticated.
 * The native ledger owns the original root, which may already have been pruned.
 * Its clean commit and measured source must be verified before using that context. */
export function reconstructCapacityNativePlaybook(playbook: string, currentRoot: string, custody: {
  root: string; commitSha: string; worktreeDirty: boolean; sourceMatches: boolean;
}): string {
  const canonicalRoot = (value: string) => isAbsolute(value) && value.length > 1
    && resolve(value) === value && !/[\u0000-\u001f\u007f`\\]/.test(value);
  if (!canonicalRoot(currentRoot) || !canonicalRoot(custody.root)
    || !/^[a-f0-9]{40}$/.test(custody.commitSha) || custody.worktreeDirty !== false
    || custody.sourceMatches !== true) throw new Error('native-prompt-source-custody-mismatch');
  const heading = '## Operational reference index\n';
  const start = playbook.indexOf(heading);
  if (start < 0 || playbook.indexOf(heading, start + heading.length) >= 0)
    throw new Error('native-prompt-reference-index-missing-or-ambiguous');
  const next = playbook.indexOf('\n## ', start + heading.length);
  const end = next < 0 ? playbook.length : next;
  let references = 0;
  const index = playbook.slice(start, end).replace(/^(- [^\n]+: `)([^`\n]+)(`)$/gm, (_, prefix, path: string, suffix) => {
    if (!path.startsWith(currentRoot + sep) || resolve(path) !== path
      || /[\u0000-\u001f\u007f\\]/.test(path)) throw new Error('native-prompt-reference-outside-source');
    references++;
    return prefix + custody.root + path.slice(currentRoot.length) + suffix;
  });
  if (!references) throw new Error('native-prompt-references-missing');
  return playbook.slice(0, start) + index + playbook.slice(end);
}

async function nativeToolReceipt(id: number): Promise<NativeCapacityBriefReceipt & { servingBuildSha: string | null }> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const [native] = await sql<Array<{ id: number; tool_name: string; status: string; workspace_id: string;
    coord_owner_id: string | null; invoked_at: Date; duration_ms: number | null; metadata_json: unknown;
    args_json: unknown; serving_build_sha: string | null; serving_host: string | null; serving_process_id: string | null }>>`
    SELECT id, tool_name, status, workspace_id, coord_owner_id, invoked_at, duration_ms, metadata_json, args_json, serving_build_sha,
           serving_host, serving_process_id
      FROM harness_shared.tool_invocations
     WHERE id = ${id} AND workspace_id = 'papercusp-workspace'`;
  if (!native) throw new Error('native-tool-receipt-missing:' + id);
  return { id: Number(native.id), toolName: native.tool_name, status: native.status, workspaceId: native.workspace_id,
    actorId: native.coord_owner_id, invokedAt: native.invoked_at.toISOString(), durationMs: native.duration_ms,
    metadata: native.metadata_json, args: native.args_json, servingBuildSha: native.serving_build_sha,
    servingHost: native.serving_host, servingProcessId: native.serving_process_id };
}

async function matchesMeasuredSource(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number], sha: string | null) {
  const { repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot } =
    await import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store');
  const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
  const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
  if (!paths.length || !/^[a-f0-9]{7,40}$/.test(sha ?? '')) return false;
  // Reuse the canonical reader's gitlink pins, binary-safe batching and limits.
  const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
    await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
  try {
    const files = await readCommittedFiles(root, sha!, paths, {}, REPO_FILE_SET_READ_LIMITS);
    return paths.every(path => files.get(path)?.sha256 === sha256(readFileSync(join(root, path))));
  } catch { return false; }
}

async function readCapture(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number], input: unknown) {
  const { resolveCapacityCapture } = await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
  return resolveCapacityCapture(input, async (path, expectedSha256) => {
    const commit = row.testRunProvenance?.commitSha;
    if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('native-capture-commit-missing');
    const { repoFilesEvidenceMeasurementSchema } = await import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store');
    const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
    if (recipe.fixtureRootHarnessSlug || !recipe.fixturePaths?.includes(path))
      throw new Error('native-capture-fixture-not-measured:' + path);
    const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
      await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
    const files = await readCommittedFiles(root, commit!, [path], {}, REPO_FILE_SET_READ_LIMITS);
    if (files.get(path)?.sha256 !== expectedSha256) throw new Error('native-capture-not-committed:' + path);
    const absolute = realpathSync(join(root, path)), rel = relative(realpathSync(root), absolute);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('native-capture-path-escape');
    return readFileSync(absolute);
  });
}

async function readBriefProof(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const { validateCapacityBriefReceipt } =
    await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
  const capture = await readCapture(root, row, artifact.capacityBriefCapture);
  const native = await nativeToolReceipt(capture.invocationId);
  return validateCapacityBriefReceipt(artifact.capacityRecoveryProof, capture, native,
    { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt,
      sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) });
}

async function readAdmissionProof(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const { capacityAdmissionCapturesSchema, recoveryProofSchema, validateCapacityAdmissionReceipt } =
    await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
  const proof = recoveryProofSchema.parse(artifact.capacityRecoveryProof);
  const captures = capacityAdmissionCapturesSchema.parse(artifact.capacityAdmissionCaptures ?? []);
  if (captures.length !== proof.recoveries.length || new Set(captures.map(c => c.memberId)).size !== captures.length
    || captures.some(c => !proof.recoveries.some(r => r.memberId === c.memberId))) throw new Error('native-admission-population');
  const violations: string[] = [];
  for (const c of captures) {
    const capture = await readCapture(root, row, c.capture);
    const native = await nativeToolReceipt(capture.invocationId);
    violations.push(...validateCapacityAdmissionReceipt(proof, c.memberId, capture, native,
      { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt,
        sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) }).violations);
  }
  return violations;
}

async function readDiagnosticOutputs(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const [{ capacityRuntimeCapturesSchema, validateCapacityDiagnosticOutputs },
    { repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot }] = await Promise.all([
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store'),
  ]);
  const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
  const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
  const required = ['leader-brief.ts', 'leader-brief-shape.ts', 'leader-brief-aggregate.ts']
    .map(name => 'packages/operator-core/lib/agent-tools/fleet/' + name);
  if (required.some(path => !paths.includes(path))) throw new Error('native-runtime-source-not-measured');
  const qualify = async (input: unknown) => {
    const capture = await readCapture(root, row, input);
    const native = await nativeToolReceipt(capture.invocationId);
    return { capture, native, sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) };
  };
  const runtime = await Promise.all(capacityRuntimeCapturesSchema.parse(artifact.capacityRuntimeCaptures).map(qualify));
  const caller = artifact.capacityCallerCapture == null ? null : await qualify(artifact.capacityCallerCapture);
  const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
    await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
  const proof = (await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'))
    .diagnosticProofSchema.parse(artifact.capacityRecoveryProof);
  const compilerInputs = await readCommittedFiles(root, proof.candidate.commit, required, {}, REPO_FILE_SET_READ_LIMITS);
  return validateCapacityDiagnosticOutputs(artifact.capacityRecoveryProof, runtime, caller,
    { root, sources: required.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))),
      gitBlob: compilerInputs.get(path)?.gitBlob ?? '' })),
      now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt });
}

async function readRecoveryOperations(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const [{ getOrgPg }, { recoveryProofSchema, validateCapacityRecoveryOperations }] = await Promise.all([
    import('@papercusp/db-org'), import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const { sql } = getOrgPg();
  const proof = recoveryProofSchema.parse(artifact.capacityRecoveryProof);
  const receiptId = (ref: string, prefix: string) => {
    if (!ref.startsWith(prefix) || !/^[1-9][0-9]*$/.test(ref.slice(prefix.length))) throw new Error('invalid-native-reference:' + ref);
    const id = Number(ref.slice(prefix.length));
    if (!Number.isSafeInteger(id)) throw new Error('invalid-native-reference:' + ref);
    return id;
  };
  const operations: import('../packages/operator-core/lib/fleet/capacity-recovery-evidence').NativeCapacityRecoveryOperation[] = [];
  for (const r of proof.recoveries) {
    const control = await nativeToolReceipt(receiptId(r.control.receiptRef, 'tool-invocation:'));
    const claim = await nativeToolReceipt(receiptId(r.claim.receiptRef, 'tool-invocation:'));
    const [delivery] = await sql<Array<{ id: number; workspace_id: string; subscriber_id: string; event_key: string;
      source: string | null; status: string; turn_proof: string | null; created_at: Date;
      delivered_at: Date | null; turn_started_at: Date | null }>>`
      SELECT id, workspace_id, subscriber_id, event_key, source, status, turn_proof, created_at, delivered_at, turn_started_at
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND id = ${receiptId(r.turn.id, 'event-wake-delivery:')}`;
    const claimStart = new Date(Date.parse(claim.invokedAt) - (claim.durationMs ?? 0)).toISOString();
    const audits = await sql<Array<{ id: number; feature_id: string; claimer_pubkey: string; outcome: string; attempt_ts: Date; detail: string | null }>>`
      SELECT id, feature_id, claimer_pubkey, outcome, attempt_ts, detail FROM harness_shared.claim_audit
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND feature_id = ${r.claim.workItemId} AND claimer_pubkey = ${r.memberId} AND outcome = 'won'
         AND attempt_ts >= ${claimStart}::timestamptz AND attempt_ts <= ${claim.invokedAt}::timestamptz
       ORDER BY id LIMIT 2`;
    if (!delivery || audits.length !== 1) throw new Error('native-recovery-join-missing-or-ambiguous:' + r.memberId);
    const audit = audits[0];
    const writers = await sql<Array<{ id: number; coord_owner_id: string | null }>>`
      SELECT id, coord_owner_id FROM harness_shared.tool_invocations
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND goal_ref = ${r.claim.workItemId}
         AND invoked_at >= ${audit.attempt_ts.toISOString()}::timestamptz AND invoked_at <= ${artifact.finishedAt}::timestamptz
         AND status = 'ok' AND (tool_name IN ('work_items:checkpoint', 'work_items:complete', 'capability:edit', 'capability:write', 'capability:multi_edit', 'Edit', 'Write', 'MultiEdit')
           OR tool_name IN ('activity:report', 'activity_report') AND args_json->>'tool_name' IN ('Edit', 'Write', 'MultiEdit', 'apply_patch')
             AND args_json->>'status' = 'ok')
       ORDER BY id LIMIT 1001`;
    operations.push({ memberId: r.memberId, control, claim,
      controlSourceMatches: await matchesMeasuredSource(root, row, control.servingBuildSha),
      claimSourceMatches: await matchesMeasuredSource(root, row, claim.servingBuildSha),
      delivery: { id: Number(delivery.id), workspaceId: delivery.workspace_id, subscriberId: delivery.subscriber_id,
        eventKey: delivery.event_key, source: delivery.source, status: delivery.status, turnProof: delivery.turn_proof,
        createdAt: delivery.created_at.toISOString(), deliveredAt: delivery.delivered_at?.toISOString() ?? null,
        turnStartedAt: delivery.turn_started_at?.toISOString() ?? null },
      claimAudit: { id: Number(audit.id), workItemId: audit.feature_id, memberId: audit.claimer_pubkey, outcome: audit.outcome,
        takenAt: audit.attempt_ts.toISOString(), detail: audit.detail ? JSON.parse(audit.detail) : null },
      writers: writers.map(w => ({ id: Number(w.id), actorId: w.coord_owner_id })) });
  }
  const capture = await readCapture(root, row, artifact.capacityLeaderAfterCapture);
  const native = await nativeToolReceipt(capture.invocationId);
  return validateCapacityRecoveryOperations(proof, operations,
    { capture, native, sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) },
    { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt });
}

async function readNativeLlmRuns(root: string, binding: Awaited<ReturnType<typeof listSpecEvidence>>[number], scenarioId: string, passed: number) {
  const testRunId = binding.testRunId!;
  const [{ getOrgPg }, { parseTestRunExecutionDetails }, { validateCapacityNativeLlmRun }] = await Promise.all([
    import('@papercusp/db-org'), import('@papercusp/test-config/execution-details'),
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const { sql } = getOrgPg();
  const [ledger] = await sql<Array<{ execution_details: unknown; started_at: Date; finished_at: Date; commit_sha: string }>>`
    SELECT execution_details, started_at, finished_at, commit_sha FROM harness_shared.test_runs
     WHERE id = ${testRunId} AND framework = 'llm-test' AND status = 'pass'
       AND worktree_dirty = false AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'`;
  const execution = parseTestRunExecutionDetails(ledger?.execution_details);
  const runIds = execution?.llmRunIds;
  if (!ledger || !execution || execution.filePath !== S42_PATH || execution.scenarioId !== scenarioId
    || execution.passed !== passed || execution.failed !== 0 || !runIds?.length || runIds.length !== passed)
    throw new Error('native-llm-custody-missing:' + testRunId);
  if (ledger.commit_sha !== binding.testRunProvenance?.commitSha
    || realpathSync(root) !== realpathSync(fileURLToPath(new URL('../', import.meta.url))))
    throw new Error('native-prompt-source-custody-mismatch');
  const runs = await sql<Array<Record<string, unknown>>>`
    SELECT id, scenario_id, scenario_version, scenario_hash, identity_hash, persona_id, persona_traits_json,
           rubric_version, sut_model, judge_model, status, started_at, finished_at, transcript_norm_json, transcript_raw_zstd
      FROM harness_shared.llm_test_runs WHERE id = ANY(${runIds})`;
  if (runs.length !== runIds.length) throw new Error('native-llm-report-missing:' + testRunId);
  const [{ SU_S42_DRAIN_WATCH_RECHECK }, { BRIEF_ADMIN }, { decompressTranscript }, su, { isCodexResponsesModel }] = await Promise.all([
    import('../packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck'),
    import('@papercusp/testing-shell/llm'), import('../packages/operator-core/lib/llm-testing/storage'),
    import('../packages/operator-core/lib/llm-testing/targets/su'),
    import('../packages/operator-core/lib/llm-testing/targets/codex-responses-tool-loop'),
  ]);
  const scenario = SU_S42_DRAIN_WATCH_RECHECK.find(s => s.id === scenarioId);
  if (!scenario) throw new Error('unrelated-native-scenario');
  if (realpathSync(su.resolvePlaybookPath()) !== realpathSync(join(root,
    'libs/papercusp/packages/harness/blueprints/base/prompts/su.md')))
    throw new Error('native-prompt-source-custody-mismatch');
  const playbook = reconstructCapacityNativePlaybook(su.SU_PLAYBOOK_FRAMING + await su.loadPlaybookBody(['auto']), realpathSync(root), {
    root: execution.root, commitSha: ledger.commit_sha, worktreeDirty: false,
    sourceMatches: await matchesMeasuredSource(root, binding, ledger.commit_sha),
  });
  const starts: number[] = [], finishes: number[] = [];
  for (const row of runs) {
    const run = { id: row.id, scenarioId: row.scenario_id, scenarioVersion: row.scenario_version,
      scenarioHash: row.scenario_hash, identityHash: row.identity_hash, personaId: row.persona_id,
      personaTraits: row.persona_traits_json, rubricVersion: row.rubric_version, sutModel: row.sut_model,
      judgeModel: row.judge_model, status: row.status, turns: row.transcript_norm_json,
      rawEvents: decompressTranscript(row.transcript_raw_zstd as Buffer) } as NativeCapacityLlmRun;
    const provider = isCodexResponsesModel(run.sutModel) ? 'codex' : 'anthropic';
    const verdict = validateCapacityNativeLlmRun(run, { scenarioId, scenarioVersion: scenario.version,
      scenarioHash: sha256(readFileSync(join(root, S42_PATH))), personaId: BRIEF_ADMIN.id,
      personaTraits: BRIEF_ADMIN.traits, rubricVersion: scenario.rubric.version, provider,
      systemSha256: provider === 'codex' ? [sha256(JSON.stringify(playbook))]
        : [false, true].map(cache => sha256(JSON.stringify(su.buildSuSystemBlocks(playbook, cache)))) });
    if (verdict.status !== 'pass') throw new Error(run.id + ':' + verdict.violations.join(','));
    starts.push(new Date(row.started_at as string).getTime());
    finishes.push(new Date(row.finished_at as string).getTime());
  }
  if (Math.min(...starts) !== new Date(ledger.started_at).getTime()
    || Math.max(...finishes) !== new Date(ledger.finished_at).getTime()) throw new Error('native-llm-window-mismatch');
  return runIds;
}

async function main() {
const [root, phase] = process.argv.slice(2);
const result: { scope: string; phase: string; status: string; bindingIds: number[]; violations: string[] } =
  { scope: 'luna-capacity-semantic-v1', phase, status: 'unknown', bindingIds: [], violations: [] };
try {
  if (!root || !['recovery', 'shipment', 'diagnostic', 'continuation'].includes(phase)) throw new Error('invalid-instrument-scope');
  // Reject invalid scopes before loading DB accessors and the scenario graph.
  const [{ listSpecEvidence, repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot },
    { listSpecClauses }, { computeSpecSetHash }, { getAcceptanceRubricsForPlan },
    { inspectCommittedOperationalEvidence }, { LUNA_CAPACITY_PLAN, validateCapacityRecoveryProof,
      validateCapacityShipmentProof, validateCapacityDiagnosticProof, validateCapacityContinuationProof,
      validateCapacityContractProof }] = await Promise.all([
    import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-clauses-store'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-clause-compiler'),
    import('../packages/operator-core/lib/rubrics'),
    import('../packages/operator-core/lib/agent-tools/testing/record-run'),
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const [clauses, rubrics] = await Promise.all([
    listSpecClauses({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', planSlug: LUNA_CAPACITY_PLAN, limit: 101 }),
    getAcceptanceRubricsForPlan(LUNA_CAPACITY_PLAN, { harnessSlug: 'papercusp', strict: true, limit: 2 }),
  ]);
  if (!clauses.length || clauses.length > 100 || rubrics.length !== 1 || !rubrics[0].barSetHash
    || rubrics[0].readCompat || !rubrics[0].barContract) throw new Error('canonical-contract-missing-or-ambiguous');
  const specSetHash = computeSpecSetHash(clauses.filter(c => ['draft', 'active', 'accepted', 'exempt'].includes(c.lifecycleStatus)));
  // R6 re-observes the current prerequisite instruments; it never calls itself.
  // Bind the exact canonical records as well as their passing measurements.
  const readShipmentEvidence = async (proof: unknown) => {
    const { validateCapacityShipmentEvidence, shipmentProofSchema, LUNA_CAPACITY_INSTRUMENTS } =
      await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
    const candidateCommit = shipmentProofSchema.parse(proof).candidate.commit;
    const { runInstrument } = await import('../packages/operator-core/lib/rubric-instrument-registry');
    const bars = new Map(clauses.filter(c => c.sourceBar && ['R-1', 'R-2', 'R-3', 'R-4', 'R-5'].includes(c.sourceBar.barKey))
      .map(c => [c.specId, c.sourceBar!.barKey]));
    const evidence = await listSpecEvidence({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
      planSlugs: [LUNA_CAPACITY_PLAN], specIds: [...bars.keys()], evidenceKinds: ['test', 'operational'],
      current: true, currentness: ['current'], limit: 200 });
    const readings = await Promise.all([
      { barKey: 'R-2', key: LUNA_CAPACITY_INSTRUMENTS.diagnostic },
      { barKey: 'R-4', key: LUNA_CAPACITY_INSTRUMENTS.continuation },
      { barKey: 'R-5', key: LUNA_CAPACITY_INSTRUMENTS.recovery },
    ].map(async i => ({ ...i, value: (await runInstrument(i.key)).value })));
    return validateCapacityShipmentEvidence(proof, await Promise.all(evidence.map(async e => ({
      id: e.id, barKey: bars.get(e.specId)!, specId: e.specId, specRevision: e.specRevision,
      currentRevision: e.currentRevision, currentness: e.currentness.overall,
      sourceFingerprint: e.fingerprints.sourceFingerprint, commitSha: e.testRunProvenance?.commitSha ?? null,
      sourceMatchesCandidate: await matchesMeasuredSource(root, e, candidateCommit),
      worktreeDirty: e.testRunProvenance?.worktreeDirty ?? null, testRunId: e.testRunId,
      status: e.testRunExecution?.status ?? null, passed: e.testRunExecution?.passed ?? 0,
      failed: e.testRunExecution?.failed ?? -1, collectionFailed: e.testRunExecution?.collectionFailed ?? true,
      observedAt: e.observedAt,
    }))), readings);
  };
  const readShipmentAcceptance = async (input: unknown) => {
    const { shipmentProofSchema, validateCapacityShipmentAcceptance } =
      await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
    const { getConversation, getThreadPost } = await import('../packages/operator-core/lib/agent-tools/coordination/conversations');
    const { resolvePlanImplementerIdentities, areAcceptanceLineageRelated } =
      await import('../packages/operator-core/lib/acceptance-author-identity');
    const a = shipmentProofSchema.parse(input).acceptance;
    if (!/^thread-post:[1-9][0-9]*$/.test(a.receiptRef)) throw new Error('native-acceptance-post-reference');
    const [conversation, post, implementers] = await Promise.all([
      getConversation(a.ref), getThreadPost(Number(a.receiptRef.slice('thread-post:'.length))),
      resolvePlanImplementerIdentities(LUNA_CAPACITY_PLAN, { workspaceId: 'papercusp-workspace' }),
    ]);
    if (!conversation || !post?.author_id) throw new Error('native-acceptance-receipt-missing');
    const author = rubrics[0].createdBy ?? rubrics[0].proposedBy ?? null;
    const identities = [...new Set([...implementers, ...(author ? [author] : [])])];
    const related = await Promise.all(identities.map(id => areAcceptanceLineageRelated(id, post.author_id,
      { workspaceId: 'papercusp-workspace' })));
    return validateCapacityShipmentAcceptance(input, { conversationId: conversation.conversation.id,
      acceptedPostId: conversation.conversation.accepted_post_id, state: conversation.conversation.state,
      postId: post.id, reviewerId: post.author_id, createdAt: post.created_ts, body: JSON.parse(post.body),
      authorId: author, implementerIds: identities, lineageIndependent: identities.length > 0 && related.every(r => r === false) });
  };
  const readShipmentRelease = async (input: unknown, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
    artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { shipmentProofSchema, capacityRuntimeCapturesSchema, validateCapacityShipmentRelease } =
      await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
    const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
      await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
    const proof = shipmentProofSchema.parse(input), { sql } = getOrgPg();
    // Exact historical receipt IDs only: this does not read or operate the live gate.
    const actions = await sql<Array<{ id: string; actor: string; action: string; details: unknown }>>`
      SELECT id, actor, action, details FROM harness_shared.audit_log WHERE workspace_id = 'papercusp-workspace'
       AND id IN (${proof.green.receiptRef}, ${proof.release.receiptRef})`;
    const pipelines = await sql<Array<{ id: string; kind: string; status: string; detail: unknown; created_at: Date }>>`
      SELECT id::text, kind, status, detail, created_at FROM harness_shared.pipeline_events
       WHERE workspace_id = 'papercusp-workspace' AND install_slug = 'papercusp'
         AND ((kind = 'green_checkpoint' AND detail->>'runId' = ${proof.green.runId})
           OR (kind = 'deploy' AND id::text = ${proof.release.deployId})) LIMIT 3`;
    const green = pipelines.filter(p => p.kind === 'green_checkpoint'), release = pipelines.filter(p => p.kind === 'deploy');
    const ga = actions.find(a => a.id === proof.green.receiptRef), da = actions.find(a => a.id === proof.release.receiptRef);
    if (!ga || !da || green.length !== 1 || release.length !== 1) throw new Error('native-shipment-release-receipts-missing-or-ambiguous');
    const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
    const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
    const files = await readCommittedFiles(root, proof.release.commit, paths, {}, REPO_FILE_SET_READ_LIMITS);
    const runtime = await Promise.all(capacityRuntimeCapturesSchema.parse(artifact.capacityShipmentRuntimeCaptures).map(async capture => {
      const resolved = await readCapture(root, row, capture);
      const native = await nativeToolReceipt(resolved.invocationId);
      return { capture: resolved, native, sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) };
    }));
    const pipeline = (p: typeof pipelines[number]) => ({ ...p, createdAt: p.created_at.toISOString() });
    return validateCapacityShipmentRelease(input, { greenAction: ga, deployAction: da,
      green: pipeline(green[0]), release: pipeline(release[0]), runtime }, { root,
      sources: paths.map(path => ({ path, sha256: files.get(path)?.sha256 ?? '', gitBlob: files.get(path)?.gitBlob ?? '' })),
      now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt });
  };
  const specIds: Record<string, string> = { recovery: 'LUNA-CAPACITY-005', shipment: 'LUNA-CAPACITY-006',
    diagnostic: 'LUNA-CAPACITY-002', continuation: 'LUNA-CAPACITY-004' };
  const rows = await listSpecEvidence({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
    planSlugs: [LUNA_CAPACITY_PLAN], specIds: [specIds[phase]],
    evidenceKinds: phase === 'continuation' ? ['test'] : ['operational'], current: true, limit: 21 });
  if (!rows.length || rows.length > 20) throw new Error('missing-or-truncated-evidence');
  result.bindingIds = rows.map(r => r.id);
  const nativeContinuations: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.currentness.overall !== 'current') throw new Error('noncurrent-evidence:' + row.id);
    const execution = row.testRunExecution;
    const native = row.testRunProvenance;
    if (!row.testRunId || !execution || !native || !['pass', 'passed'].includes(execution.status ?? '') ||
      execution.failed !== 0 || execution.collectionFailed || execution.passed < 1 ||
      native.worktreeDirty !== false || !/^[a-f0-9]{40}$/.test(native.commitSha ?? '')) throw new Error('missing-native-success:' + row.id);
    const measurement = row.serverMeasurement;
    if (measurement?.status !== 'measured' || !('current' in measurement)) throw new Error('native-measurement-missing:' + row.id);
    const sourceFingerprint = measurement.current.sourceFingerprint;
    if (phase === 'continuation') {
      const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
      const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
      for (const path of [S42_PATH, 'packages/operator-core/lib/llm-testing/targets/su.ts',
        'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
        'libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md']) {
        if (!paths.includes(path)) throw new Error('native-prompt-source-not-measured:' + path);
      }
      const nativeRunIds = execution.testLayer === 'llm'
        ? await readNativeLlmRuns(root, row, execution.scenarioId ?? '', execution.passed) : undefined;
      nativeContinuations.push({ bindingId: row.id, testRunId: row.testRunId, currentness: row.currentness.overall,
        status: execution.status, failed: execution.failed, passed: execution.passed,
        collectionFailed: execution.collectionFailed, testLayer: execution.testLayer, filePath: execution.filePath,
        sourceFingerprint, ...(nativeRunIds ? { nativeRunIds } : {}),
        ...(execution.scenarioId ? { scenarioId: execution.scenarioId } : {}),
        ...(execution.passedCaseTitles ? { passedCaseTitles: execution.passedCaseTitles } : {}) });
      continue;
    }
    // The expected bytes come from the native run's immutable commit, not from
    // binder-authored details. The canonical reader also requires HEAD equality.
    const bytes = execFileSync('git', ['show', native.commitSha + ':' + native.filePath], {
      cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    const artifact = await inspectCommittedOperationalEvidence(root, native.filePath, createHash('sha256').update(bytes).digest('hex'));
    if (artifact.artifact.exitCode !== 0 || artifact.artifact.assertions.some(a => !a.passed)) throw new Error('failed-operational-artifact');
    if (phase === 'recovery' || phase === 'diagnostic') {
      result.violations.push(...(await readBriefProof(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    }
    if (phase === 'recovery') {
      result.violations.push(...(await readAdmissionProof(root, row, artifact.artifact)).map(v => row.id + ':' + v));
      result.violations.push(...(await readRecoveryOperations(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    }
    if (phase === 'diagnostic') result.violations.push(...(await readDiagnosticOutputs(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    if (phase === 'shipment') result.violations.push(...(await readShipmentEvidence(artifact.artifact.capacityRecoveryProof)).violations.map(v => row.id + ':' + v));
    if (phase === 'shipment') result.violations.push(...(await readShipmentAcceptance(artifact.artifact.capacityRecoveryProof)).violations.map(v => row.id + ':' + v));
    if (phase === 'shipment') result.violations.push(...(await readShipmentRelease(artifact.artifact.capacityRecoveryProof, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    result.violations.push(...validateCapacityContractProof(artifact.artifact.capacityRecoveryProof,
      { specSetHash, barSetHash: rubrics[0].barSetHash, sourceFingerprint }).violations.map(v => row.id + ':' + v));
    const verdict = phase === 'recovery' ? validateCapacityRecoveryProof(artifact.artifact.capacityRecoveryProof)
      : phase === 'diagnostic' ? validateCapacityDiagnosticProof(artifact.artifact.capacityRecoveryProof)
        : validateCapacityShipmentProof(artifact.artifact.capacityRecoveryProof);
    result.violations.push(...verdict.violations.map(v => row.id + ':' + v));
  }
  if (phase === 'continuation') result.violations.push(...validateCapacityContinuationProof(nativeContinuations).violations);
  result.status = result.violations.length ? 'fail' : 'pass';
} catch (error) { result.violations.push(error instanceof Error ? error.message : String(error)); }
return result;
}

/**
 * The verification-harness contract (contract-lint R-10): the run is recorded under the shared
 * evidence root, then the receipt prints exactly as before. A throw still fails the process
 * instead of being absorbed by the harness.
 */
async function runCli(): Promise<void> {
  const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
  let result: Awaited<ReturnType<typeof main>> | null = null;
  let thrown: unknown = null;
  await runHarness({
    contract: { name: 'fleet-capacity-recovery', phases: [{ id: 'verify' }] },
    evidenceRoot: defaultEvidenceRoot('fleet-capacity-recovery'),
    async runPhase(ctx) {
      ctx.markStep(`verify-${process.argv[3] ?? 'unscoped'}`);
      try {
        const verdict = await main();
        result = verdict;
        return verdict.status === 'pass' ? { ok: true } : { ok: false, reasonCode: `status-${verdict.status}` };
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
  });
  if (thrown) throw thrown;
  // This is a one-shot, read-only CLI. Flush its receipt before closing the
  // process, including any idle database pool opened by the canonical reader.
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void runCli().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
