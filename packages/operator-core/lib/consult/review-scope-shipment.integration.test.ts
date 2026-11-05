/** EGM R-9 / EGM-SHIP-001. Ordinary CI runs the refusal controls. The real
 * release case additionally requires PAPERCUSP_EGM_RELEASE=1 and a private
 * PAPERCUSP_EGM_RELEASE_FIXTURE JSON file containing identifiers and inputs,
 * never successful responses. Use the maintained final-release live profile.
 * A skipped live case is not shipment evidence. No gate/deploy action lives here.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ConsultReviewState } from './review-findings';

const plan = 'review-findings-and-initial-code-scope-2026-10-31';
const parent = 'WI-6554700010043425';
const baseline = [
  'packages/operator-core/lib/consult/review-findings.ts',
  'packages/operator-core/lib/consult/consult-verbs-core.ts',
  'packages/operator-core/lib/plan-items/anchors.ts',
  'packages/operator-core/lib/plan-items/anchor-store.ts',
  'packages/operator-core/lib/agent-tools/plans/initial-change-scope.ts',
  'packages/operator-core/lib/consult/responder-verb-menu.ts',
];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = /^[a-f0-9]{64}$/;
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('EGM shipment unproven: ' + reason);
}
type Source = { path: string; sha256: string; refs: string[]; classification: 'production' | 'excluded'; reason?: string };
type Census = { rows: Source[]; unresolved: unknown[]; truncatedByLimit: boolean; residue: string[];
  auditSeq: number; auditSha: string; producerRefs: string[]; workItemIds: string[];
  evidence?: { proposals: Json; audit: Json; linked: Json[]; native: Json[] } };
type Runtime = { host: string; processId: string; buildSha: string; artifact: {
  status: string; sourceSha: string; bundleSha256: string; manifestSha256: string; evidenceRef: string;
} };
type Journey = { kind: 'review' | 'scope' | 'simplicity'; processId: string; sourceSha: string;
  invocationIds: string[]; nonce: string; persisted: boolean; assertions: Record<string, boolean> };
type Proof = { census: Census; frozen: Source[]; populationHash: string; runtime: Runtime; runtimeAfter: Runtime;
  green: { sourceSha: string; passed: boolean; ref: string }; manifest: { sourceSha: string;
    bundleSha256: string; sourceBlobs: Record<string, string> }; manifestSha256: string;
  containment: Array<{ path: string; expectedSha256: string; matches: boolean | null;
    deployedContains: boolean | null; runtimeContains: boolean | null; deployed: boolean; deployedSha: string; assessment: string | null }>;
  journeys: Journey[] };
const requiredAssertions = {
  review: ['originalFindings', 'originalAnswers', 'priorHistory', 'appendedHistory', 'dispositionProvenance', 'stableAfterClose', 'realReviewer'],
  scope: ['addedItem', 'initialChange', 'revisedChange', 'unrelatedRewrite'],
  simplicity: ['initial', 'material', 'sameConsult'],
} satisfies Record<Journey['kind'], string[]>;
function normalized(path: string) {
  return !!path && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(p => p && p !== '.' && p !== '..');
}
function population(census: Census): Source[] {
  requireProof(census.truncatedByLimit === false && census.unresolved.length === 0 && census.residue.length === 0,
    'canonical census is incomplete');
  requireProof(census.auditSeq > 0 && fullSha.test(census.auditSha) && census.producerRefs.length > 0 &&
    census.workItemIds.includes(parent), 'canonical audit and parent linkage are required');
  const paths = new Map<string, Source>();
  for (const row of census.rows) {
    requireProof(!!row.path && (row.classification !== 'production' || normalized(row.path)) &&
      sha256.test(row.sha256) && row.refs.length > 0, 'unmeasured census row');
    requireProof(row.classification === 'production' || (row.classification === 'excluded' && !!row.reason?.trim()),
      'unclassified census row');
    const prior = paths.get(row.path);
    requireProof(!prior || (prior.sha256 === row.sha256 && prior.classification === row.classification),
      'conflicting path/hash provenance');
    paths.set(row.path, { ...row, refs: [...new Set([...(prior?.refs ?? []), ...row.refs])].sort() });
  }
  const accepted = [...paths.values()].filter(row => row.classification === 'production').sort((a, b) => a.path.localeCompare(b.path));
  requireProof(baseline.every(path => accepted.some(row => row.path === path)), 'original six-path baseline is incomplete');
  return accepted;
}
type SourceProof = Omit<Proof, 'runtimeAfter' | 'journeys'>;
function verifySource(proof: SourceProof) {
  // Compute from the independent producer before looking at the containment loop.
  const expected = population(proof.census);
  requireProof(JSON.stringify(proof.frozen) === JSON.stringify(expected) && proof.populationHash === digest(JSON.stringify(expected)),
    'frozen population differs from canonical census');
  const rt = proof.runtime;
  requireProof(rt.host === 'port-3070' && !!rt.processId && fullSha.test(rt.artifact.sourceSha) &&
    rt.artifact.status === 'measured' && rt.artifact.sourceSha.startsWith(rt.buildSha) &&
    sha256.test(rt.artifact.bundleSha256) && sha256.test(rt.artifact.manifestSha256) && !!rt.artifact.evidenceRef,
  'unknown loaded release identity');
  requireProof(proof.green.passed === true && proof.green.sourceSha === rt.artifact.sourceSha && !!proof.green.ref,
    'green promotion does not identify the executing release');
  requireProof(proof.manifest.sourceSha === rt.artifact.sourceSha && proof.manifest.bundleSha256 === rt.artifact.bundleSha256 &&
    proof.manifestSha256 === rt.artifact.manifestSha256, 'bundle/manifest mismatch');
  requireProof(proof.containment.length === expected.length &&
    new Set(proof.containment.map(row => row.path)).size === expected.length, 'containment population differs');
  for (const row of expected) {
    const contained = proof.containment.find(c => c.path === row.path);
    requireProof(contained?.expectedSha256 === row.sha256 && contained.matches === true && contained.deployedContains === true &&
      contained.runtimeContains === true && contained.deployed === true && contained.deployedSha === rt.artifact.sourceSha &&
      contained.assessment === 'executing',
    'accepted source is not in the executing release: ' + row.path);
  }
}
function verify(proof: Proof) {
  verifySource(proof);
  const rt = proof.runtime;
  requireProof(isDeepStrictEqual(proof.runtimeAfter, rt), 'loaded release changed during measurement');
  for (const kind of ['review', 'scope', 'simplicity'] as const) {
    const journeys = proof.journeys.filter(journey => journey.kind === kind);
    requireProof(journeys.length === 1, 'missing or duplicate public ' + kind + ' journey');
    const journey = journeys[0]!;
    requireProof(journey.processId === rt.processId && journey.sourceSha === rt.artifact.sourceSha &&
      journey.persisted === true && !!journey.nonce && journey.invocationIds.length > 0 &&
      requiredAssertions[kind].every(key => journey.assertions[key] === true) &&
      Object.values(journey.assertions).every(value => value === true),
    'failed public ' + kind + ' journey');
  }
}

/** The fixture names private, real public objects prepared on the target release.
 * Answer authors remain actual routed reviewers. The fixture supplies no outcomes,
 * source population, runtime identities, green receipts or passing assertions.
 */
type Fixture = { root: string; evidencePath: string; nonce: string; reviewConversationId: string;
  scopePlanSlug: string; scopeItemId?: string; anchor: Record<string, unknown>; revisedAnchor: Record<string, unknown>;
  rewrite: { old_string: string; new_string: string }; simplicityConversationId: string;
  initialBrief: { session: string; turn: number }; materialBrief: { session: string };
  openingInvocationIds: string[] };
type Json = Record<string, any>;
type Invocation = { id: string; tool: string; owner: string; args: Json; at: string;
  host: string; process: string; sha: string; status: string };
function sameRuntime(rows: Invocation[], runtime: Runtime) {
  requireProof(rows.length > 0 && rows.every(row => row.host === runtime.host && row.process === runtime.processId &&
    row.sha === runtime.buildSha && row.status === 'ok'), 'public operations crossed release processes');
}
function verifyOpenings(fixture: Fixture, owned: Json[], original: ConsultReviewState, rows: Invocation[], runtime: Runtime,
  requester = process.env.PAPERCUSP_SID ?? '') {
  requireProof(new Set(fixture.openingInvocationIds).size === fixture.openingInvocationIds.length &&
    rows.length === fixture.openingInvocationIds.length && fixture.openingInvocationIds.every(id => rows.some(row => row.id === id)),
  'fixture-opening invocations are missing or duplicated');
  sameRuntime(rows, runtime);
  const used = new Set<string>();
  for (const id of [fixture.reviewConversationId, fixture.simplicityConversationId]) {
    const state = owned.find(row => row.id === id);
    const opening = rows.find(row => row.tool === 'consult:get_feedback' && row.owner === requester &&
      row.args.question === state?.question && row.args.question?.includes(fixture.nonce));
    requireProof(opening && state?.requester === requester, 'opening trace does not create the nonce consult');
    used.add(opening.id);
  }
  const created = rows.find(row => row.tool === 'plans:new' && row.owner === requester &&
    fixture.scopePlanSlug === row.args.slug && String(row.args.content).includes(fixture.nonce));
  requireProof(created, 'opening trace does not create the nonce scope plan');
  used.add(created.id);
  for (const answer of original.answers) {
    const findings = original.findings.filter(finding => finding.postId === answer.postId)
      .map(({ key, severity, text, evidenceRefs }) => ({ key, severity, text, evidenceRefs }));
    const invocation = rows.find(row => row.tool === 'consult:reply' && row.owner === answer.reviewerId && row.owner !== requester &&
      row.args.conversation_id === fixture.reviewConversationId && row.args.kind === 'answer' &&
      isDeepStrictEqual(row.args.review, { subjectRef: answer.subjectRef, coverage: answer.coverage, findings }) &&
      Array.isArray(row.args.evidence) && row.args.evidence.length > 0 &&
      Date.parse(row.at) <= Date.parse(answer.at));
    requireProof(invocation, 'opening trace does not publish the actual reviewer answer');
    used.add(invocation.id);
  }
  requireProof(original.answers.length > 0 && used.size === rows.length, 'unrelated trace supplied as fixture provenance');
}
function query<T>(sql: string): T {
  return JSON.parse(execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-d', 'papercusp', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).trim());
}
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function tool(name: string, args: Json): Json {
  const raw = execFileSync('ptool', [name, '--url=http://127.0.0.1:3070', '--json', '-'], {
    input: JSON.stringify({ ...args, payloadTier: 'full' }), encoding: 'utf8', timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = JSON.parse(raw);
  requireProof(result.ok !== false && !result.error && result.state !== 'incomplete' && !result._shapeNote &&
    !result.summaryNotice?.truncated && (!Array.isArray(result.results) || result.results.every((row: Json) => row.ok !== false)),
  name + ' refused or returned partial evidence');
  return result;
}
function review(id: string): ConsultReviewState {
  const result = tool('conversations:get', { id });
  const state = result.results?.[0]?.review;
  requireProof(state?.version === 1 && state.findings?.length > 0, 'public readback has no retained review');
  return state;
}
function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
}
function sourceBytes(root: string, sha: string, path: string): Buffer {
  requireProof(normalized(path) && fullSha.test(sha), 'unsafe source identity');
  const parts = path.split('/');
  // Follow actual gitlinks, never the current submodule HEAD.
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const tree = git(root, ['ls-tree', sha, '--', prefix]);
    const sub = /^160000 commit ([a-f0-9]{40,64})\t/.exec(tree);
    if (sub) return sourceBytes(resolve(root, prefix), sub[1]!, parts.slice(i).join('/'));
  }
  return execFileSync('git', ['-C', root, 'show', sha + ':' + path], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
}
function collectCensus(fixture: Fixture, started: string): Census {
  const proposed = tool('plans:audit', { slug: plan, harness: 'papercusp', phase: 'completion', dryRun: true, proposeCitations: true });
  requireProof(proposed.truncatedByLimit === false && proposed.unresolved?.length === 0, 'canonical citation producer is incomplete');
  const audit = query<Json>(`SELECT row_to_json(a) FROM harness_shared.plan_audits a
    WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND plan_slug=${literal(plan)}
      AND audit_kind='completion' ORDER BY audit_seq DESC LIMIT 1`);
  requireProof(audit && fullSha.test(audit.audited_sha), 'recorded completion audit is missing');
  const linked = query<Json[]>(`SELECT COALESCE(json_agg(DISTINCT jsonb_build_object('id',wi.feature_id,
      'files',wi.payload->'_completionEvidence'->'filesChanged',
      'stamp',wi.payload->'_completionEvidence'->'treeStamp')), '[]')
    FROM harness_shared.work_items wi WHERE wi.workspace_id='papercusp-workspace' AND wi.harness_slug='papercusp'
      AND (wi.source_plan_slug=${literal(plan)} OR EXISTS (SELECT 1 FROM harness_shared.coord_links l
        WHERE l.workspace_id=wi.workspace_id AND l.src_ref IN (wi.feature_id,wi.harness_slug||'#'||wi.feature_id)
          AND l.rel IN ('implements','relates') AND l.dst_kind='plan_item' AND split_part(l.dst_ref,'#',1)=${literal(plan)}))`);
  const parentRead = tool('work_items:get', { id: parent, harness: 'papercusp', threadLimit: 0 });
  const parentItem = parentRead.results?.[0]?.workItem;
  requireProof(linked.some(row => row.id === parent) && parentItem?.assignee && parentItem.createdAt,
    'parent must have a real plan link and identifiable native-edit owner');
  const native = query<Json[]>(`SELECT COALESCE(json_agg(x),'[]') FROM (SELECT id::text,detail FROM harness_shared.agent_activity
    WHERE workspace_id='papercusp-workspace' AND owner_id=${literal(parentItem.assignee)}
      AND (harness_slug IS NULL OR harness_slug='papercusp') AND phase='post' AND (status IS NULL OR status IN ('ok','success'))
      AND created_at >= ${literal(parentItem.createdAt)}::timestamptz
      AND (summary LIKE '✎%' OR lower(tool_name) LIKE '%apply_patch') ORDER BY id LIMIT 10001) x`);
  requireProof(native.length < 10001, 'native edit census is truncated');
  const candidates: Array<{ path: string; ref: string; blobSha?: string; externalEvidence?: string }> = [];
  for (const item of proposed.proposals ?? []) for (const citation of item.citations ?? [])
    candidates.push({ path: citation.path, blobSha: citation.blobSha,
      ref: 'proposal:' + item.itemId + ':' + (citation.workItemIds ?? []).join(',') });
  for (const item of audit.items ?? []) for (const citation of item.citations ?? []) if (citation.path)
    candidates.push({ path: citation.path, blobSha: citation.blobSha,
      ref: 'audit:' + audit.audit_seq + ':' + item.itemId + ':' + citation.blobSha });
  for (const item of linked) for (const path of item.files ?? []) {
    const entry = item.stamp?.contentIdentity?.find((row: Json) => row.path === path);
    const root = entry?.repositoryRoot ?? item.stamp?.repositoryRoot ?? fixture.root;
    candidates.push({ path: relative(fixture.root, resolve(root, path)), blobSha: entry?.headBlobSha,
      ref: 'completion:' + item.id });
  }
  for (const row of native) {
    const paths = [...String(row.detail?.command ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!);
    if (typeof row.detail?.file === 'string') paths.push(row.detail.file);
    for (const path of paths) {
      const local = isAbsolute(path) ? relative(fixture.root, path) : path;
      candidates.push({ path: normalized(local) ? local : path, ref: 'native:' + row.id + ':' + parent,
        ...(!normalized(local) ? { externalEvidence: JSON.stringify(row) } : {}) });
    }
  }
  const rows = candidates.map(candidate => {
    if (candidate.externalEvidence) return { path: candidate.path, sha256: digest(candidate.externalEvidence),
      refs: [candidate.ref], classification: 'excluded' as const,
      reason: 'Native edit outside the harness repository (for example an isolated mutation fixture). The digest identifies its retained edit evidence, not an accepted production file.' };
    requireProof(normalized(candidate.path), 'native edit is outside the audited repository: ' + candidate.path);
    const excluded = /(?:^|\/)(?:test|tests|docs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:md|mdx)$/.test(candidate.path);
    const bytes = sourceBytes(fixture.root, audit.audited_sha, candidate.path);
    if (candidate.blobSha) requireProof(createHash(candidate.blobSha.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === candidate.blobSha,
    'recorded accepted blob differs from the completion audit: ' + candidate.path);
    return { path: candidate.path, sha256: digest(bytes),
      refs: [candidate.ref], classification: excluded ? 'excluded' as const : 'production' as const,
      ...(excluded ? { reason: 'Maintained test or documentation; not an executing production binding.' } : {}) };
  });
  const producerRefs = query<string[]>(`SELECT COALESCE(json_agg('tool-invocation:'||id::text ORDER BY id),'[]')
    FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace'
      AND coord_owner_id=${literal(process.env.PAPERCUSP_SID ?? '')} AND invoked_at >= ${literal(started)}::timestamptz
      AND tool_name='plans:audit' AND status='ok' AND args_json->>'slug'=${literal(plan)}
      AND args_json->>'proposeCitations'='true'`);
  requireProof(producerRefs.length > 0, 'canonical census producer invocation was not recorded');
  return { rows, unresolved: proposed.unresolved, truncatedByLimit: proposed.truncatedByLimit, residue: [],
    auditSeq: audit.audit_seq, auditSha: audit.audited_sha, producerRefs,
    workItemIds: linked.map(row => row.id).sort(), evidence: { proposals: proposed, audit, linked, native } };
}
function measuredRuntime(path: string): Runtime {
  const result = tool('dev:pipeline_position', { path, sourceRuntimeOnly: true });
  requireProof(result.observingRuntime?.host === 'port-3070', 'measurement was not served by the release operator');
  return result.observingRuntime;
}
const initialInstruction = 'initial review: is this the simplest design that meets the original scenarios?';
const materialInstruction = 'After a material design revision, reassess the revised design as a whole';
function matchesBrief(turn: Json, text: string, conversationId: string, nonce: string,
  after?: { turn: number; at: string; marker: string }) {
  return typeof turn.text === 'string' && turn.text.includes(text) && turn.text.includes(conversationId) &&
    turn.text.includes(nonce) && turn.source_completeness !== 'unknown' && !turn.text_truncated &&
    (!after || (turn.turn_idx > after.turn && Date.parse(turn.ts) >= Date.parse(after.at) && turn.text.includes(after.marker)));
}
function fullTurn(input: Fixture['initialBrief']): Json {
  const result = tool('sessions:read', { session: input.session, from_idx: input.turn, to_idx: input.turn, limit: 1, text_limit: 4000 });
  const turn = result.turns?.[0];
  requireProof(turn?.turn_idx === input.turn && result.turns.length === 1, 'brief turn was not measured');
  let text = turn.text;
  let page = turn;
  // Page the actual canonical turn; a shared menu in a different turn is not evidence.
  while (page.readMore) {
    const next = tool('sessions:read', page.readMore.args);
    const chunk = next.turns?.[0];
    requireProof(chunk?.ref === turn.ref && chunk.text_offset === text.length && chunk.text.length > 0,
      'brief continuation changed or did not advance');
    text += chunk.text;
    page = chunk;
  }
  return { ...turn, text, text_truncated: page.text_truncated, source_completeness: page.source_completeness };
}
async function materialBrief(input: Fixture['materialBrief'], conversationId: string, nonce: string,
  after: { turn: number; at: string; marker: string }) {
  const deadline = Date.now() + 60_000;
  do {
    const result = tool('sessions:read', { session: input.session, from_idx: after.turn + 1, limit: 20 });
    for (const turn of result.turns ?? []) {
      if (Date.parse(turn.ts) < Date.parse(after.at)) continue;
      const complete = fullTurn({ session: input.session, turn: turn.turn_idx });
      if (matchesBrief(complete, materialInstruction, conversationId, nonce, after)) return complete;
    }
    if (Date.now() >= deadline) return false;
    await delay(2000);
  } while (true);
}
function collectSource(fixture: Fixture, started: string): SourceProof {
  const runtime = measuredRuntime(baseline[0]!);
  const census = collectCensus(fixture, started);
  const frozen = population(census);
  const containment = frozen.map(row => {
    const result = tool('dev:pipeline_position', { path: row.path, expectedSourceSha256: row.sha256 });
    return { path: row.path, expectedSha256: row.sha256, matches: result.acceptedSource?.matches,
      deployedContains: result.acceptedSource?.deployedContains,
      runtimeContains: result.acceptedSource?.runtimeContainment?.['release-operator'],
      deployed: result.positions?.deployed, deployedSha: result.deployedSha, assessment: result.assessments?.deployedSha };
  });
  // Historical promotion evidence for the loaded artifact; this does not inspect
  // or operate another owner's current checkpoint run.
  const green = query<Json | null>(`SELECT row_to_json(e) FROM harness_shared.pipeline_events e
    WHERE install_slug='papercusp' AND workspace_id IN ('papercusp-workspace','*') AND kind='green_checkpoint'
      AND status IN ('advanced','up-to-date','advanced-prefix')
      AND length(COALESCE(detail->>'advancedTo',detail->>'candidate')) >= 12
      AND ${literal(runtime.artifact.sourceSha)} LIKE COALESCE(detail->>'advancedTo',detail->>'candidate')||'%'
    ORDER BY id DESC LIMIT 1`);
  const manifestBytes = readFileSync(runtime.artifact.evidenceRef);
  const greenSha = green ? git(fixture.root, ['rev-parse', '--verify',
    (green.detail?.advancedTo ?? green.detail?.candidate) + '^{commit}']).trim() : '';
  return { census, frozen, populationHash: digest(JSON.stringify(frozen)), runtime,
    green: { sourceSha: greenSha, passed: !!green && greenSha === runtime.artifact.sourceSha,
      ref: green ? 'pipeline-event:' + green.id : '' }, manifest: JSON.parse(manifestBytes.toString('utf8')),
    manifestSha256: digest(manifestBytes), containment };
}
async function afterSourcePreflight<T>(source: SourceProof, run: () => Promise<T>): Promise<T> {
  verifySource(source);
  return run();
}
function persistedScope(fixture: Fixture) {
  requireProof(typeof fixture.scopeItemId === 'string', 'scope fixture has no created item');
  // Public readback is exercised as well as an independent persisted-value check.
  const publicRead = tool('plans:items', { slug: fixture.scopePlanSlug, harness: 'papercusp' });
  requireProof(JSON.stringify(publicRead).includes(fixture.scopeItemId), 'public scope item is absent');
  return query<Json[]>(`SELECT COALESCE(json_agg(jsonb_build_object('requested',requested,'change',change_intent)),'[]')
    FROM harness_shared.plan_item_anchors WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp'
      AND plan_slug=${literal(fixture.scopePlanSlug)} AND item_id=${literal(fixture.scopeItemId)}`);
}
async function collectRelease(fixture: Fixture): Promise<Proof> {
  requireProof(isAbsolute(fixture.root) && isAbsolute(fixture.evidencePath) && !!fixture.nonce &&
    fixture.reviewConversationId !== fixture.simplicityConversationId &&
    fixture.openingInvocationIds.length > 0 && fixture.scopePlanSlug.startsWith('egm-release-fixture-') &&
    fixture.scopePlanSlug.includes(fixture.nonce) && fixture.rewrite.old_string.includes(fixture.nonce) &&
    fixture.rewrite.new_string.includes(fixture.nonce), 'private fixture and opening invocation identities are required');
  const started = new Date().toISOString();
  const source = collectSource(fixture, started);
  // This shared verifier must pass before any public fixture mutation.
  return afterSourcePreflight(source, async () => {
  const runtime = source.runtime;
  const owned = query<Json[]>(`SELECT COALESCE(json_agg(jsonb_build_object('id',conversation_id,'requester',requester_id,
      'question',question,'routing',routing,'cursor',cascade_cursor)),'[]')
    FROM harness_shared.consult_state WHERE workspace_id='papercusp-workspace'
      AND conversation_id IN (${literal(fixture.reviewConversationId)},${literal(fixture.simplicityConversationId)})`);
  requireProof(owned.length === new Set([fixture.reviewConversationId, fixture.simplicityConversationId]).size &&
    owned.every(row => row.requester === process.env.PAPERCUSP_SID && String(row.question).includes(fixture.nonce)),
  'consult journeys must use this requester\u2019s private nonce fixtures');
  const simplicity = owned.find(row => row.id === fixture.simplicityConversationId)!;
  const routing = typeof simplicity.routing === 'string' ? JSON.parse(simplicity.routing) : simplicity.routing;
  const answering = routing?.selection?.selected?.[simplicity.cursor]?.answeringOwnerId;
  requireProof(answering && fixture.initialBrief.session === answering && fixture.materialBrief.session === answering,
    'simplicity briefs must come from the canonically dispatched answering session');
  const original = review(fixture.reviewConversationId);
  const openingRows = query<Invocation[]>(`SELECT COALESCE(json_agg(jsonb_build_object('id',id::text,'tool',tool_name,
      'owner',coord_owner_id,'args',args_json,'at',invoked_at,'host',serving_host,'process',serving_process_id,
      'sha',serving_build_sha,'status',status)),'[]') FROM harness_shared.tool_invocations
    WHERE workspace_id='papercusp-workspace' AND id::text IN (${fixture.openingInvocationIds.map(literal).join(',')})`);
  verifyOpenings(fixture, owned, original, openingRows, runtime);
  const initial = fullTurn(fixture.initialBrief);
  requireProof(matchesBrief(initial, initialInstruction, fixture.simplicityConversationId, fixture.nonce),
    'initial simplicity briefing is absent');
  const dispositions = original.findings.map(finding => ({ findingId: finding.id, status: 'planned',
    reason: 'Retain the real reviewer finding in this private release acceptance fixture ' + fixture.nonce,
    reference: 'work-item:' + process.env.PAPERCUSP_TEST_RUN_WORK_ITEM }));
  tool('consult:reply', { conversation_id: fixture.reviewConversationId, kind: 'new_fact', body: fixture.nonce, reviewDispositions: dispositions });
  const afterReply = review(fixture.reviewConversationId);
  tool('consult:close', { conversation_id: fixture.reviewConversationId, outcome: 'answered', answer: fixture.nonce });
  const afterClose = review(fixture.reviewConversationId);
  const added = tool('plans:add-item', { slug: fixture.scopePlanSlug, harness: 'papercusp',
    text: 'Private release acceptance item ' + fixture.nonce, anchors: [fixture.anchor] });
  requireProof(typeof added.itemId === 'string' && /^P-\d+$/.test(added.itemId), 'public add did not return an item identity');
  fixture.scopeItemId = added.itemId;
  const initialScope = persistedScope(fixture);
  tool('plans:edit', { slug: fixture.scopePlanSlug, harness: 'papercusp', itemId: fixture.scopeItemId, anchors: [fixture.revisedAnchor] });
  const revisedScope = persistedScope(fixture);
  tool('plans:edit', { slug: fixture.scopePlanSlug, harness: 'papercusp', ...fixture.rewrite });
  const afterRewrite = persistedScope(fixture);
  const revisionMarker = 'material-revision:' + randomUUID();
  const revisedAt = new Date().toISOString();
  const revision = tool('consult:reply', { conversation_id: fixture.simplicityConversationId, kind: 'new_fact',
    body: 'Material design revision ' + fixture.nonce + ' ' + revisionMarker +
      ': reassess the revised whole design against the original scenarios.' });
  requireProof(Number.isSafeInteger(revision.post_id), 'material revision was not persisted');
  const material = await materialBrief(fixture.materialBrief, fixture.simplicityConversationId, fixture.nonce,
    { turn: fixture.initialBrief.turn, at: revisedAt, marker: revisionMarker });
  const invocations = query<Invocation[]>(`SELECT COALESCE(json_agg(jsonb_build_object('id',id::text,'tool',tool_name,
      'owner',coord_owner_id,'args',args_json,'at',invoked_at,
      'host',serving_host,'process',serving_process_id,'sha',serving_build_sha,'status',status)),'[]')
    FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND
      ((coord_owner_id=${literal(process.env.PAPERCUSP_SID ?? '')} AND invoked_at >= ${literal(started)}::timestamptz)
       OR id::text IN (${fixture.openingInvocationIds.map(literal).join(',')}))`);
  sameRuntime(invocations, runtime);
  const invocationIds = invocations.map(row => row.id).sort();
  const journey = (kind: Journey['kind'], assertions: Record<string, boolean>): Journey => ({ kind,
    processId: runtime.processId, sourceSha: runtime.artifact.sourceSha, nonce: fixture.nonce, invocationIds, persisted: true, assertions });
  const proof: Proof = { ...source, runtimeAfter: measuredRuntime(baseline[0]!), journeys: [
      journey('review', { originalFindings: JSON.stringify(original.findings) === JSON.stringify(afterClose.findings),
        originalAnswers: JSON.stringify(original.answers) === JSON.stringify(afterClose.answers),
        priorHistory: JSON.stringify(afterClose.dispositions.slice(0, original.dispositions.length)) === JSON.stringify(original.dispositions),
        appendedHistory: afterClose.dispositions.length === original.dispositions.length + dispositions.length,
        dispositionProvenance: afterClose.dispositions.slice(original.dispositions.length).every((entry, index) => {
          const expected = dispositions[index];
          return !!expected && entry.findingId === expected.findingId && entry.status === expected.status &&
            entry.reason === expected.reason && entry.reference === expected.reference &&
            entry.authorId === process.env.PAPERCUSP_SID && !!entry.postId && !!entry.at;
        }),
        stableAfterClose: JSON.stringify(afterReply) === JSON.stringify(afterClose),
        realReviewer: original.findings.every(finding => finding.reviewerId !== process.env.PAPERCUSP_SID && !!finding.postId && !!finding.subjectRef && finding.evidenceRefs.length > 0) }),
      journey('scope', { addedItem: added.itemId === fixture.scopeItemId,
        initialChange: initialScope.some(row => row.requested === fixture.anchor.path && isDeepStrictEqual(row.change, fixture.anchor.change)),
        revisedChange: revisedScope.some(row => row.requested === fixture.revisedAnchor.path && isDeepStrictEqual(row.change, fixture.revisedAnchor.change)),
        unrelatedRewrite: isDeepStrictEqual(revisedScope, afterRewrite) }),
      journey('simplicity', { initial: true, material: !!material, sameConsult: !!material }),
    ] };
  mkdirSync(dirname(fixture.evidencePath), { recursive: true });
  writeFileSync(fixture.evidencePath, JSON.stringify({ nonce: fixture.nonce, started, openingRows,
    initial, material, revision, revisionMarker, invocations, proof }, null, 2), { flag: 'wx' });
  return proof;
  });
}

function control(): Proof {
  const source = 'a'.repeat(40), bundle = 'b'.repeat(64), manifest = 'c'.repeat(64);
  const rows: Source[] = [...baseline, 'packages/operator-core/lib/agent-tools/consult/reply.ts'].map(path => ({
    path, sha256: digest(path), refs: ['independent-native-edit:' + path], classification: 'production' }));
  const census: Census = { rows, unresolved: [], truncatedByLimit: false, residue: [], auditSeq: 1, auditSha: source,
    producerRefs: ['fixture-control-not-release-evidence'], workItemIds: [parent] };
  const frozen = population(census);
  const runtime: Runtime = { host: 'port-3070', processId: 'isolated-control', buildSha: source, artifact: {
    status: 'measured', sourceSha: source, bundleSha256: bundle, manifestSha256: manifest, evidenceRef: 'fixture-only' } };
  return { census, frozen, populationHash: digest(JSON.stringify(frozen)), runtime, runtimeAfter: structuredClone(runtime),
    green: { sourceSha: source, passed: true, ref: 'fixture-only' },
    manifest: { sourceSha: source, bundleSha256: bundle, sourceBlobs: {} }, manifestSha256: manifest,
    containment: frozen.map(row => ({ path: row.path, expectedSha256: row.sha256, matches: true,
      deployedContains: true, runtimeContains: true, deployed: true, deployedSha: source, assessment: 'executing' })),
    journeys: (['review', 'scope', 'simplicity'] as const).map(kind => ({ kind, processId: runtime.processId,
      sourceSha: source, invocationIds: ['fixture-only'], nonce: randomUUID(), persisted: true,
      assertions: Object.fromEntries(requiredAssertions[kind].map(key => [key, true])) })) };
}
function rejects(change: (proof: Proof) => void, reason: RegExp) {
  const good = control();
  expect(() => verify(good)).not.toThrow();
  const bad = structuredClone(good); change(bad);
  expect(() => verify(bad)).toThrow(reason);
}
describe('EGM exact released artifact acceptance', () => {
  it.skipIf(process.env.PAPERCUSP_EGM_RELEASE !== '1')('verifies the complete accepted production population and three public journeys on the exact executing release', async () => {
    requireProof(process.env.PAPERCUSP_EGM_RELEASE_FIXTURE && process.env.PAPERCUSP_TEST_RUN_WORK_ITEM &&
      process.env.PAPERCUSP_TEST_RUN_HARNESS === 'papercusp' &&
      process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE === 'packages/operator-core/test/fixtures/session-recovery-release.live-profile.json',
    'explicit final-release fixture, maintained live profile and canonical test attribution are required');
    const fixture = JSON.parse(readFileSync(process.env.PAPERCUSP_EGM_RELEASE_FIXTURE, 'utf8')) as Fixture;
    verify(await collectRelease(fixture));
  }, 300_000);
  it('rejects an omitted changed tool binding from the accepted shipment population', () => {
    rejects(proof => { proof.frozen.pop(); proof.populationHash = digest(JSON.stringify(proof.frozen)); proof.containment.pop(); }, /frozen population/);
  });
  it('refuses source preflight failures before any public fixture mutation', async () => {
    for (const change of [
      (proof: Proof) => { proof.census.unresolved.push('missing attribution'); },
      (proof: Proof) => { proof.green.passed = false; },
      (proof: Proof) => { proof.containment[0]!.runtimeContains = false; },
      (proof: Proof) => { proof.runtime.artifact.status = 'unknown'; },
      (proof: Proof) => { proof.manifestSha256 = 'd'.repeat(64); },
    ]) {
      const proof = control(); change(proof);
      let mutations = 0;
      await expect(afterSourcePreflight(proof, async () => { mutations++; })).rejects.toThrow(/shipment unproven/);
      expect(mutations).toBe(0);
    }
    let mutations = 0;
    await afterSourcePreflight(control(), async () => { mutations++; });
    expect(mutations).toBe(1);
  });
  it('requires a distinct later briefing carrying the actual material revision marker', () => {
    const initial = { turn_idx: 4, ts: '2026-11-05T00:00:00Z', source_completeness: 'complete',
      text: initialInstruction + materialInstruction + ' conv-private nonce-private' };
    const after = { turn: 4, at: '2026-11-05T00:00:01Z', marker: 'material-revision:unique' };
    expect(matchesBrief(initial, initialInstruction, 'conv-private', 'nonce-private')).toBe(true);
    expect(matchesBrief(initial, materialInstruction, 'conv-private', 'nonce-private', after)).toBe(false);
    const later = { ...initial, turn_idx: 5, ts: after.at, text: initial.text + after.marker };
    expect(matchesBrief(later, materialInstruction, 'conv-private', 'nonce-private', after)).toBe(true);
    for (const invalid of [ { ...later, turn_idx: 4 }, { ...later, ts: initial.ts },
      { ...later, text: initial.text }, { ...later, text_truncated: true }, { ...later, source_completeness: 'unknown' } ])
      expect(matchesBrief(invalid, materialInstruction, 'conv-private', 'nonce-private', after)).toBe(false);
  });
  it('rejects unrelated opening calls and mismatched reviewer answer provenance', () => {
    const requester = 'fixture-requester', reviewer = 'fixture-reviewer';
    const fixture = { nonce: 'private-nonce', scopePlanSlug: 'egm-release-fixture-private-nonce-2026-11-05',
      reviewConversationId: 'review-private', simplicityConversationId: 'simplicity-private',
      openingInvocationIds: ['1', '2', '3', '4'] } as Fixture;
    const owned = [fixture.reviewConversationId, fixture.simplicityConversationId]
      .map(id => ({ id, question: id + fixture.nonce, requester }));
    const original: ConsultReviewState = { version: 1, dispositions: [],
      answers: [{ postId: 123, reviewerId: reviewer, subjectRef: 'subject-private', coverage: 'complete', at: '2026-11-05T00:00:01Z' }],
      findings: [{ id: 'post:123#F1', key: 'F1', severity: 'nit', text: 'Measured finding', evidenceRefs: ['session_turn:private'],
        postId: 123, reviewerId: reviewer, subjectRef: 'subject-private' }] };
    const runtime = control().runtime;
    const envelope = { owner: requester, at: '2026-11-05T00:00:00Z', host: runtime.host,
      process: runtime.processId, sha: runtime.buildSha, status: 'ok' };
    const rows: Invocation[] = [
      ...owned.map((row, i) => ({ ...envelope, id: String(i + 1), tool: 'consult:get_feedback', args: { question: row.question } })),
      { ...envelope, id: '3', tool: 'plans:new', args: { slug: fixture.scopePlanSlug, content: fixture.nonce } },
      { ...envelope, id: '4', tool: 'consult:reply', owner: reviewer, args: { conversation_id: fixture.reviewConversationId,
        kind: 'answer', evidence: [{ session_id: 'private', turn_idx: 1 }],
        review: { subjectRef: 'subject-private', coverage: 'complete', findings: [{ key: 'F1', severity: 'nit',
          text: 'Measured finding', evidenceRefs: ['session_turn:private'] }] } } },
    ];
    expect(() => verifyOpenings(fixture, owned, original, rows, runtime, requester)).not.toThrow();
    for (const change of [
      (bad: Invocation[]) => { bad[0]!.tool = 'conversations:get'; },
      (bad: Invocation[]) => { bad[0]!.args.question = 'unrelated-private-nonce'; },
      (bad: Invocation[]) => { bad[2]!.args.slug = 'unrelated-private-nonce'; },
      (bad: Invocation[]) => { bad[3]!.owner = requester; },
      (bad: Invocation[]) => { bad[3]!.args.review.findings[0].text = 'Different answer'; },
      (bad: Invocation[]) => { bad[3]!.args.conversation_id = fixture.simplicityConversationId; },
      (bad: Invocation[]) => { bad[3]!.process = 'different-process'; },
    ]) {
      const bad = structuredClone(rows); change(bad);
      expect(() => verifyOpenings(fixture, owned, original, bad, runtime, requester)).toThrow(/shipment unproven/);
    }
  });
  it('rejects stale or unknown loaded release identities', () => {
    rejects(proof => { proof.runtime.artifact.status = 'unknown'; }, /unknown loaded/);
    rejects(proof => { proof.runtimeAfter.processId = 'restarted'; }, /changed during measurement/);
  });
  it('rejects a mismatched accepted source hash', () => {
    rejects(proof => { proof.containment[0]!.expectedSha256 = 'd'.repeat(64); }, /accepted source/);
    rejects(proof => { proof.containment[0]!.runtimeContains = null; }, /accepted source/);
    rejects(proof => { proof.containment[0]!.assessment = 'restart-required'; }, /accepted source/);
  });
  it('rejects missing or failed public release journeys', () => {
    for (const kind of ['review', 'scope', 'simplicity']) {
      rejects(proof => { proof.journeys = proof.journeys.filter(journey => journey.kind !== kind); }, /missing or duplicate/);
      rejects(proof => { proof.journeys.find(journey => journey.kind === kind)!.assertions[requiredAssertions[kind as Journey['kind']][0]!] = false; }, /failed public/);
      rejects(proof => { delete proof.journeys.find(journey => journey.kind === kind)!.assertions[requiredAssertions[kind as Journey['kind']][0]!]; }, /failed public/);
      rejects(proof => { proof.journeys.find(journey => journey.kind === kind)!.processId = 'other'; }, /failed public/);
    }
  });
  it('rejects mismatched green promotion bundle or manifest receipts', () => {
    rejects(proof => { proof.green.sourceSha = 'd'.repeat(40); }, /green promotion/);
    rejects(proof => { proof.green.passed = false; }, /green promotion/);
    rejects(proof => { proof.manifest.bundleSha256 = 'd'.repeat(64); }, /bundle\/manifest/);
    rejects(proof => { proof.manifestSha256 = 'd'.repeat(64); }, /bundle\/manifest/);
  });
  it('rejects an incomplete or inconsistent canonical accepted production census', () => {
    rejects(proof => { proof.census.truncatedByLimit = true; }, /census is incomplete/);
    rejects(proof => { proof.census.unresolved.push('missing attribution'); }, /census is incomplete/);
    rejects(proof => { proof.census.residue.push('unowned'); }, /census is incomplete/);
    rejects(proof => { proof.census.rows.push({ ...proof.census.rows[0]!, classification: 'excluded' }); }, /unclassified census/);
    rejects(proof => { proof.census.rows.push({ ...proof.census.rows[0]!, sha256: 'd'.repeat(64) }); }, /conflicting path\/hash/);
    rejects(proof => { proof.census.rows = proof.census.rows.filter(row => row.path !== baseline[0]); }, /six-path baseline/);
  });
});
