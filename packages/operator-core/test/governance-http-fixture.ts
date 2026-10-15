/** Child of governance-http.integration.test.ts; never run against a shared operator. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';
import { getOrgPg } from '@papercusp/db-org';
import { insertHiveIfAbsent } from '../lib/hive-store';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { resolvePlanScope } from '../lib/agent-tools/plans/source';
import { potHomeSlugForHarness } from '../lib/hive-federation';
import { resolvePlanAdmissionGovernanceAuthority } from '../lib/agent-tools/plans/plan-admission-governance-store';
import { upsertHivePolicyRow } from '../lib/hive-policy-store';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from '../lib/hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../lib/identity/ed25519';
import { governanceAuthorityHash, governanceEventSigningBytes, governanceVoteSigningBytes,
  type GovernanceSigningAuthority } from '../lib/agent-tools/plans/governance-authentication';
import { createGovernanceRound, finalizeGovernanceRound, type GovernanceVoteEvent } from '../lib/agent-tools/plans/governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../lib/agent-tools/plans/plan-admission-policy';
import type { FederatedGovernanceEvent, GovernanceEventBody } from '../lib/agent-tools/plans/governance-federation';
import { createInMemoryMirrorLedger, createOnChainGovernanceSource, executeOnChainMirror,
  governanceActionHash, type BridgeAction, type MirrorPlan } from '../lib/p2p/onchain-governance-bridge';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer!);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private HTTP host survived owned cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const { sql } = getOrgPg();
  // A concrete member follows registry workspace resolution. The operator-home
  // special case intentionally defaults to the platform sentinel workspace.
  const harness = `${workspace}-governance`;
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'operator-api preflight must register its private home');
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: harness, path: home.path, hive_slug: workspace }] }, workspace);
  const owner = generateEd25519KeypairDer(), keys = [generateEd25519KeypairDer(), generateEd25519KeypairDer()];
  const authority: GovernanceSigningAuthority = { potId: workspace,
    policy: { ...DEFAULT_PLAN_ADMISSION_POLICY, mode: 'enforce' },
    members: keys.map((key, i) => ({ memberId: `voter-${i}`, publicKey: key.pubkeyBase64, keyEpoch: 1,
      originPeerIds: [`peer-${i}`], roles: i === 0 ? ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'] : ['vote'] })) };
  await insertHiveIfAbsent({ workspaceId: workspace, homeSlug: workspace,
    pubkeyBase64: owner.pubkeyBase64, keychainId: 'disposable-governance-owner' }, sql);
  const policy: HivePolicy = { governance: { planAdmission: authority.policy, signingAuthority: { members: authority.members } } };
  const policyJson = canonicalizeHivePolicy(policy);
  await upsertHivePolicyRow({ workspaceId: workspace, potHomeSlug: workspace, policyJson,
    ownerPubkey: owner.pubkeyBase64, policyVersion: 1, signature: signWithPrivateKeyDer(owner.privateKeyDer,
      hivePolicySignedBytes({ workspaceId: workspace, potHomeSlug: workspace, policyVersion: 1,
        canonicalPolicyJson: policyJson })).toString('base64') }, sql);
  // Fail cheaply on the exact partition/policy mismatch that originally reached
  // HTTP as pot_not_found, before importing the complete maintained host.
  assert.deepEqual(await resolvePlanScope({ harnessSlug: harness }),
    { workspaceId: workspace, harnessSlug: workspace });
  assert.equal(await potHomeSlugForHarness(workspace, workspace), workspace);
  assert.deepEqual(await resolvePlanAdmissionGovernanceAuthority({ workspaceId: workspace,
    potHomeSlug: workspace, potId: workspace }, sql), { ...authority, delegations: undefined });
  console.log('GOVERNANCE_HTTP_PHASE private-plan-partition-and-authority-verified');

  // Reuse the production plain-node bundle and maintained API-test pattern.
  // The HTTP client has its own event loop; host bootstrap cannot run its timer.
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.GOVERNANCE_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir && !evidenceDir.startsWith('/tmp/'));
  console.log('GOVERNANCE_HTTP_PHASE bundle-start');
  const { path: bundle, sha256: bundleSha256 } = await buildPrivateOperatorApiBundle(root, evidenceDir,
    { timeoutMs: 240_000, maxMs: 420_000 });
  console.log('GOVERNANCE_HTTP_PHASE bundle-ready ' + bundleSha256);
  const hostEnv = privateBundleRuntimeEnv(e);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity missing');
  const health = await waitForPrivateOperator({ host, base, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('GOVERNANCE_HTTP_PHASE request-ready ' + JSON.stringify({ service: health.service }));
  const slug = 'signed-http-journey-2026-10-08';
  async function post(verb: string, body: Record<string, unknown>, origin = base) {
    const response = await fetch(`${base}/api/admin/plans/${verb}`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ harness, ...body }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as any };
  }
  const created = await post('new', { slug, title: 'Disposable signed governance HTTP journey',
    content: '## Now\nDisposable isolated request journey.\n', status: 'draft' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.body.ok, true, JSON.stringify(created));
  const planResponse = await fetch(`${base}/api/admin/plans/get?harness=${harness}&slug=${slug}`, { signal: AbortSignal.timeout(15_000) });
  const plan = await planResponse.json() as any;
  assert.equal(planResponse.status, 200, JSON.stringify(plan));
  assert.ok(plan.contentHash, JSON.stringify(plan));
  const [storedPlan] = await sql`SELECT workspace_id, harness_slug FROM harness_shared.harness_plans
    WHERE plan_slug = ${slug}`;
  assert.deepEqual({ ...storedPlan }, { workspace_id: workspace, harness_slug: workspace });
  const revision = plan.contentHash as string;
  const recipient = '0x2222222222222222222222222222222222222222', token = '0x1111111111111111111111111111111111111111';
  const bounds = { enabled: true, maxAmountMicros: 1000n, allowedRecipients: [recipient], allowedTokens: [token] };
  const action: BridgeAction = { kind: 'treasury-transfer', treasury: { chainId: 42161,
    safeAddress: '0x3333333333333333333333333333333333333333',
    owners: ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'],
    threshold: 2, automationSigner: '0x7777777777777777777777777777777777777777',
    roles: { settlement: bounds, 'host-payout': { ...bounds, enabled: false },
      'reserve-transfer': { ...bounds, enabled: false }, 'emergency-pause': { ...bounds, maxAmountMicros: 0n } } },
    request: { role: 'settlement', token, recipient, amountMicros: 400n, settlementReceiptHash: 'receipt', policyApproved: true } };
  const now = Date.now();
  const opened = createGovernanceRound({ roundId: 'http-round', planRevisionHash: revision,
    policyVersion: authority.policy.policyVersion, eligibleMemberIds: authority.members.map(m => m.memberId),
    createdAtMs: now, authorityHash: governanceAuthorityHash(authority), approvedActionHash: governanceActionHash(action) });
  assert.ok(opened.ok);
  const round = opened.value;
  function sign(eventId: string, body: GovernanceEventBody, index = 0, over: Record<string, unknown> = {}): FederatedGovernanceEvent {
    const unsigned = { eventId, potId: workspace, roundId: round.roundId, originPeerId: `peer-${index}`,
      occurredAtMs: now, body, authorization: { memberId: `voter-${index}`, keyEpoch: 1 }, ...over };
    return { ...unsigned, signature: signWithPrivateKeyDer(keys[index]!.privateKeyDer,
      governanceEventSigningBytes(unsigned)).toString('base64') };
  }
  const votes: GovernanceVoteEvent[] = keys.map((key, i) => {
    const unsigned = { eventId: `ballot-${i}`, roundId: round.roundId, memberId: `voter-${i}`,
      choice: 'approve' as const, sequence: 1, keyEpoch: 1 };
    return { ...unsigned, signature: signWithPrivateKeyDer(key.privateKeyDer,
      governanceVoteSigningBytes(authority, round, unsigned)).toString('base64') };
  });
  const finalized = finalizeGovernanceRound({ round, events: votes, policy: authority.policy,
    members: authority.members, nowMs: now });
  assert.ok(finalized.ok && finalized.value.admitted);
  const events = [sign('open', { kind: 'round-open', round }),
    ...votes.map((vote, i) => sign(`vote-${i}`, { kind: 'vote', vote }, i)),
    sign('final', { kind: 'finalize', certificate: finalized.value })];
  async function event(event: FederatedGovernanceEvent) {
    const response = await post('governance-event', { slug, op: 'append', event });
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.body;
  }
  const csrf = await post('governance-event', { slug, op: 'append', event: events[0] }, 'https://untrusted.invalid');
  assert.equal(csrf.status, 403);
  assert.equal((await event({ ...events[0]!, signature: 'forged' })).ok, false);
  assert.equal((await event(sign('foreign', { kind: 'round-open', round }, 0, { potId: 'foreign' }))).ok, false);
  const openedResponse = await event(events[0]!);
  assert.equal(openedResponse.ok, true, JSON.stringify(openedResponse));
  assert.equal((await event(events[1]!)).admission.admitted, false, 'one ballot must not satisfy quorum');
  assert.equal((await event(events[2]!)).admission.admitted, false, 'ballots alone are not finalization');
  const ratified = await event(events[3]!);
  assert.equal(ratified.admission.admitted, true, JSON.stringify(ratified));
  assert.deepEqual(ratified.certificate, finalized.value);
  for (const ev of events) assert.equal((await event(ev)).ok, true);
  assert.equal((await event(sign('vote-0', { kind: 'vote', vote: votes[0]! }, 0, { occurredAtMs: now - 1 }))).ok, false);
  const late = { ...votes[0]!, eventId: 'late', sequence: 2, choice: 'reject' as const };
  late.signature = signWithPrivateKeyDer(keys[0]!.privateKeyDer, governanceVoteSigningBytes(authority, round, late)).toString('base64');
  assert.equal((await event(sign('late-envelope', { kind: 'vote', vote: late }))).ok, false);

  // Ratification happened over HTTP. Execution below uses the actual production
  // store-backed bridge with an explicit local receipt adapter, never a chain.
  const governance = createOnChainGovernanceSource({ slug, door: 'start', policy: authority.policy,
    opts: { workspaceId: workspace, harnessSlug: workspace }, nowMs: Date.now });
  const ledger = createInMemoryMirrorLedger(), submitted: MirrorPlan[] = [];
  const submitter = { async submit(plan: MirrorPlan) { submitted.push(plan); return { ok: true as const, txHash: 'disposable-receipt' }; } };
  const request = { certificate: finalized.value, authorizedByCertificateHash: finalized.value.certificateHash, action };
  const altered = await executeOnChainMirror({ request: { ...request, action: { ...action, request: { ...action.request, amountMicros: 401n } } }, governance, ledger, submitter });
  assert.ok(!altered.ok && altered.code === 'action-not-bound-to-certificate');
  assert.equal(submitted.length, 0);
  const executed = await executeOnChainMirror({ request, governance, ledger, submitter });
  assert.ok(executed.ok && !executed.replayed);
  const replay = await executeOnChainMirror({ request, governance, ledger, submitter });
  assert.ok(replay.ok && replay.replayed);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.certificateHash, finalized.value.certificateHash);
  const paused = await event(sign('pause', { kind: 'pause', expiresAtMs: Date.now() + 60_000 }));
  assert.equal(paused.admission.admitted, false);
  const pausedExecution = await executeOnChainMirror({ request, governance, ledger, submitter });
  assert.equal(pausedExecution.ok, false);
  assert.equal(submitted.length, 1);
  const hostPid = host.pid;
  await stopHost();
  console.log('GOVERNANCE_HTTP_RECEIPT ' + JSON.stringify({ pid: process.pid, workspace, base, planRevisionHash: revision,
    hostPid, hostIdentity, hostStopped: true, bundleSha256,
    certificateHash: finalized.value.certificateHash, httpRatified: true, forgedRefused: true, foreignRefused: true,
    conflictRefused: true, lateBallotRefused: true, pausedRefused: true, exactActionSubmissions: submitted.length,
    replayed: replay.ok && replay.replayed, adapter: 'isolated deterministic receipt; no chain transaction' }));
}

main().then(() => process.exit(0), async error => {
  console.error(error);
  try { await stopHost(); } catch (cleanupError) { console.error(cleanupError); }
  process.exit(1);
});
