import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { compileAgentSpecification, BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg, readBlueprintFromPg, readBlueprintHashFromPg } from './project-to-pg';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';
import { cancelBlueprintOperation, getBlueprintOperationEvents, getBlueprintOperationResult, getBlueprintOperationStatus,
  signalBlueprintOperation, submitBlueprintOperation } from './operation-service';
import { validateSupportOperationResult } from './support-workflow-case';
import { supportToEngineeringOperation } from './support-workflow-operation';
import { administerWorkflow, readWorkflowAdministration, WorkflowAdministrationActionSchema } from './support-workflow-administration';
import { evaluateSupportWorkflowTrial, type SupportTrialAuthority } from './support-workflow-trial';
import { supportWorkflowTrialEvidenceFixture } from './fixtures/support-workflow-trial-cases';
import { seedSupportWorkflowSyntheticCompletion } from './fixtures/support-workflow-synthetic-completion';
import { getWorkItem } from '../work-items';
import { runWithWorkspace } from '../workspace-als';
import { writeOperatorState } from '../operator-state-pg';
import { readActiveOperationWorkerClaimBinding } from './operation-worker-binding';
import { prepareSupportOperationNativeLaunch } from './support-workflow-native-launch';
import { createInferenceGateway } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { summarizeProviderOutcomeCounts } from '../inference-gateway/gateway-request-outcome-store';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../inference-gateway/codex-cli-bridge';
import type { RunningGatewayService } from '../inference-gateway/launch';
import { hermeticEnv } from '../../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { currentBenchOpenAiInputContract } from '../external-bench/current-su';
import { defineHostedAllocation, readHostedAllocationReport, settleHostedAllocation } from '../auth/hosted/billing/allocation-store';
import { readSupportOperationBudgetBinding, recordSupportWorkflowOutcome, reserveSupportOperationAttempt,
  supportOperationReservationId } from './support-workflow-budget';
import { createPersonalGrant, listPersonalGrants } from '../personal-vault/store';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, replacePermissionListMembers,
  upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'support-operation-test';
const harnessSlug = 'support-operation';
const role = 'support-worker';
let db: OrgTestDb;
let userId: string;
let reviewerId: string;
let documentId: string;
let listId: string;
let revision: string;
let specificationArtifact: ReturnType<typeof compileAgentSpecification>;
const selection = () => ({ supportCaseId: 'case-cobalt', approvedRevision: revision,
  documentIds: [documentId], query: 'cobalt roadmap', requestedAction: 'prepare-handoff' });
const submit = (requestKey: string, overrides: Record<string, unknown> = {},
  principal = { kind: 'user', trust: 'verified', slug: userId, workspaceId }) => submitBlueprintOperation(db.adminSql, {
    workspaceId, harnessSlug, callerId: `${userId}/employee`, operationId: 'support-to-engineering',
    requestKey, expectedSpecificationRevision: revision, input: selection(), ...overrides,
  }, { principal });

beforeAll(async () => {
  db = await createOrgTestDb();
  connection.sql = db.adminSql;
  const [user] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-employee-${crypto.randomUUID()}`}, 'Support employee') RETURNING id`;
  userId = user!.id;
  const [reviewer] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-reviewer-${crypto.randomUUID()}`}, 'Distinct support reviewer') RETURNING id`;
  reviewerId = reviewer!.id;
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'support-test-key', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
  const provider = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
  await mapProviderIdentity(db.adminSql, workspaceId, { ...provider, userId, mappedBy: 'owner' });
  await mapProviderIdentity(db.adminSql, workspaceId, { provider: 'slack', providerUserId: 'T1:REVIEWER',
    userId: reviewerId, mappedBy: 'owner' });
  const list = await upsertPermissionList(db.adminSql, workspaceId, { source: 'slack', sourceRef: 'T1:CSUPPORT' });
  listId = list.id;
  await replacePermissionListMembers(db.adminSql, workspaceId, listId, [provider]);
  await upsertOrganizationDocuments(db.adminSql, workspaceId, listId, [{ source: 'slack', kind: 'message',
    dedupeKey: 'support-case-cobalt', externalId: 'T1:CSUPPORT:123', title: 'Cobalt support',
    text: 'The cobalt roadmap needs a reproducible engineering handoff.',
    metadata: { permalink: 'https://support.example/internal/cobalt' } }]);
  const [document] = await db.adminSql<{ id: string }[]>`SELECT id FROM harness_shared.documents
    WHERE workspace_id = ${workspaceId} AND dedupe_key = 'support-case-cobalt'`;
  documentId = document!.id;
  const operation = supportToEngineeringOperation({ id: 'support-to-engineering', version: '1', role,
    identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
    accountableOwner: 'engineering-owner', reviewerPrincipals: [reviewerId],
    allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
    model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' },
    funding: { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
      allocationId: 'synthetic-support-project', month: '2026-10' },
    native: { model: 'gpt-6.1-sol', effort: 'medium', account: 'auto', payer: 'api-key',
      inputTokenCeiling: 1000, outputTokenCeiling: 100,
      inputTokenCeilingSourceSha256: currentBenchOpenAiInputContract('gpt-6.1-sol', 1000),
      // Synthetic frozen rates for admission-only tests; no provider is called.
      inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, outputUsdPerMillion: 2 } });
  const nativeOperation = structuredClone(operation);
  nativeOperation.id = 'support-native-joint';
  nativeOperation.policy.supportCase!.funding = {
    organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-native-joint-org' },
    allocationId: 'synthetic-native-joint-project', month: '2026-10',
  };
  Object.assign(nativeOperation.policy.supportCase!.native!, {
    inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, cacheWriteUsdPerMillion: 30,
    outputUsdPerMillion: 100,
  });
  // The business-review fixture exercises the real corpus, receipt and funding
  // stores with a synthetic executor completion. Native execution/model
  // authority is exercised separately by support-native-joint above.
  const businessOperation = structuredClone(operation);
  businessOperation.id = 'support-business-journey';
  businessOperation.policy.supportCase!.funding = {
    organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-business-org' },
    allocationId: 'synthetic-business-project', month: '2026-10',
  };
  const source = BlueprintSchema.parse({ id: harnessSlug, grants: {}, workItem: { kind: 'task' }, roles: [{ id: role }],
    spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
    operations: [operation, nativeOperation, businessOperation] });
  const specification = compileAgentSpecification({ source });
  expect(specification.configuration.grants).toBeDefined();
  specificationArtifact = specification;
  revision = specification.specificationRevision;
  await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug,
    blueprint: source, specification });
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe('selected support operation admission', () => {
  it('admits one revision-pinned receipt with only server-read content in the private store', async () => {
    const handle = await submit('employee-case');
    expect(handle).toMatchObject({ workspaceId, harnessSlug, operationId: 'support-to-engineering',
      specificationRevision: revision, target: { kind: 'work-item' } });
    expect(await submit('employee-case')).toEqual(handle);
    const [content] = await db.adminSql<{ content_text: string }[]>`SELECT content_text
      FROM harness_shared.blueprint_operation_private_inputs WHERE workspace_id = ${workspaceId}
      AND request_key = 'employee-case'`;
    expect(JSON.parse(content!.content_text)).toMatchObject({ supportCaseId: 'case-cobalt',
      documents: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123',
        snippet: expect.stringContaining('cobalt roadmap') }] });
    const [item] = await db.adminSql<{ payload: unknown }[]>`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
      AND feature_id = ${handle.target.kind === 'work-item' ? handle.target.id : ''}`;
    expect(item).toBeDefined();
    expect(JSON.stringify(item!.payload)).not.toContain('needs a reproducible');
  });

  it('refuses forged context, source writes, employee content and unapproved revisions before admission', async () => {
    for (const principal of [
      { kind: 'pi', trust: 'verified', slug: userId, workspaceId },
      { kind: 'user', trust: 'unverified', slug: userId, workspaceId },
      { kind: 'user', trust: 'verified', slug: userId, workspaceId: 'other-workspace' },
    ]) await expect(submit('forged-principal', {}, principal)).rejects.toThrow(/principal/);
    await expect(submit('source-write', { input: { ...selection(), requestedAction: 'publish' } })).rejects.toThrow(/outside/);
    await expect(submit('forged-content', { privateInput: { documents: [] } })).rejects.toThrow(/server-read/);
    await expect(submit('stale-revision', { expectedSpecificationRevision: 'a'.repeat(64) })).rejects.toThrow(/revision/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('forged-principal', 'source-write', 'forged-content', 'stale-revision')`;
    expect(count!.n).toBe(0);
  });

  it('requires both employee and distinct allowlisted reviewer live corpus access before disclosing a result', async () => {
    const handle = await submit('reviewer-disclosure');
    if (handle.target.kind !== 'work-item') throw new Error('support fixture requires a work item');
    const workItemId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, harnessSlug));
    if (!item) throw new Error('accepted support fixture is missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(db.adminSql, workspaceId, item);
    expect(reviewerId).not.toBe(userId);
    expect(operation.acceptance.businessReview?.reviewerPrincipals).toContain(reviewerId);
    const output = { supportCaseId: 'case-cobalt', summary: 'Cited internal support handoff',
      reproduction: ['Open the synthetic case'], checklist: ['Confirm the failure'],
      suggestedRole: 'engineering', citations: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123' }] };
    const read = () => validateSupportOperationResult(db.adminSql, workspaceId, operation, pin, output, reviewerId);
    const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
    const reviewer = { provider: 'slack', providerUserId: 'T1:REVIEWER' };
    try {
      // A decision allowlist is neither a personal grant nor a source ACL.
      await expect(read()).rejects.toThrow(/reviewer source access was refused/);
      await createPersonalGrant(db.adminSql, { workspaceId, userId: reviewerId, principalType: 'agent-role',
        principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
      await expect(read()).rejects.toThrow(/unavailable|revoked/);
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee, reviewer]);
      await expect(read()).resolves.toMatchObject({ ...output, citations: [{ ...output.citations[0],
        sourceUrl: 'https://support.example/internal/cobalt' }] });
      expect(output.citations[0]).not.toHaveProperty('sourceUrl');

      await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
        WHERE workspace_id = ${workspaceId} AND user_id = ${reviewerId}::uuid`;
      await expect(read()).rejects.toThrow(/reviewer source access was refused/);
      await createPersonalGrant(db.adminSql, { workspaceId, userId: reviewerId, principalType: 'agent-role',
        principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
      // Reviewer access must not hide the submitting employee's later revocation.
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [reviewer]);
      await expect(read()).rejects.toThrow(/unavailable|revoked/);
    } finally {
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    }
  });

  it('refuses an inaccessible selected document and a revoked live grant without a new receipt', async () => {
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, []);
    await expect(submit('revoked-source')).rejects.toThrow(/revoked/);
    await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid`;
    await expect(submit('revoked-grant')).rejects.toThrow(/no_live_grant/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('revoked-source', 'revoked-grant')`;
    expect(count!.n).toBe(0);
  });
});

describe('support native launch with applied PostgreSQL authority and funding', () => {
  it('runs installed Codex through SRT, rechecks live authority after counting, and preserves the allowance on listener restart', async () => {
    // Only the provider's HTTP boundary is synthetic. Admission, applied worker
    // lookup, source ACLs, account/credential readers and allocation CAS are real.
    await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    const handle = await submit('native-joint', { operationId: 'support-native-joint' });
    if (handle.target.kind !== 'work-item') throw new Error('native fixture requires a work item');
    const workItemId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, harnessSlug));
    if (!item) throw new Error('native fixture admission is missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(db.adminSql, workspaceId, item);
    const funding = operation.policy.supportCase!.funding!;
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level] of [
        [funding.organization.organizationId, null, 'organization'],
        ['synthetic-native-joint-dept', funding.organization.organizationId, 'department'],
        [funding.allocationId, 'synthetic-native-joint-dept', 'project'],
      ] as const) {
        const defined = await defineHostedAllocation(tx as unknown as Sql, { ...funding, allocationId,
          level, parentAllocationId, costClass: 'model', capMicros: 100_000, maxUnreconciledMicros: 100_000,
          evidenceRef: 'synthetic:native-joint', recordedBy: 'fixture' });
        expect(defined.outcome, JSON.stringify(defined)).toBe('created');
      }
      // Production admits model holds only against a project leaf. Catch a
      // malformed funding fixture before paying the native launch setup cost.
      const report = await readHostedAllocationReport(tx as unknown as Sql, funding);
      expect(report.byCostClass.model.allocations.find(allocation => allocation.allocationId === funding.allocationId)?.level).toBe('project');
    });
    const ownerId = `role-support-native-${crypto.randomUUID()}`;
    const appliedRevision = { specificationRevision: revision, stateRevision: 'native-joint-applied' };
    const acceptedOperation = { kind: 'blueprint-operation-worker', workItemId,
      operationId: operation.id, specificationRevision: revision, pin,
      identity: { ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
      requiredTools: ['blueprint:read-private-input'] };
    const launchSpec = { workspaceId, harnessSlug, role, ...appliedRevision,
      specificationArtifact, acceptedOperation };
    const activation = { schemaVersion: 1,
      attribution: { actorId: ownerId, principalId: ownerId, sessionId: ownerId },
      desired: appliedRevision, prepared: null, applied: appliedRevision, status: 'applied' };
    const [session] = await db.adminSql<{ id: number }[]>`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, agent, coord_owner_id, role, launch_spec)
      VALUES (${workspaceId}, 'console', 'codex', ${ownerId}, ${role}, ${db.adminSql.json(JSON.parse(JSON.stringify(launchSpec)))})
      RETURNING id`;
    const sessionId = session!.id;
    await db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
      VALUES (${ownerId}, ${workspaceId}, ${db.adminSql.json({ activation })})`;
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by = ${ownerId}
      WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`;
    const active = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
    if (active.status !== 'bound') throw new Error(JSON.stringify(active));
    expect(await readSupportOperationBudgetBinding(workspaceId, ownerId)).not.toBeNull();

    const root = mkdtempSync('/tmp/support-native-funded-');
    const codexHome = join(root, 'codex-home'); mkdirSync(codexHome);
    const credentialName = 'PAPERCUSP_TEST_SUPPORT_NATIVE_BEARER';
    vi.stubEnv(credentialName, 'synthetic-support-native-bearer');
    await writeOperatorState('operator_account_pool', { accounts: [{ id: 'synthetic-support', provider: 'codex',
      credentialRef: `env:${credentialName}` }] }, workspaceId);
    const originalFetch = globalThis.fetch;
    let onCount: (() => Promise<void>) | undefined;
    let counts = 0;
    // Fail closed for every non-local target except this exact synthetic count
    // endpoint. The installed client can reach only the private SRT gateway.
    vi.stubGlobal('fetch', (async (target, init) => {
      const url = String(target);
      if (url === 'https://api.openai.com/v1/responses/input_tokens') {
        counts++;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-support-native-bearer');
        await onCount?.();
        return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 10 }), {
          headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-support-count' },
        });
      }
      if (new URL(url).hostname !== '127.0.0.1') throw new Error('unexpected external fixture request');
      return originalFetch(target, init);
    }) as typeof fetch);
    const bodies: string[] = [];
    const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1',
      () => resolve((server.address() as { port: number }).port)));
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6.1-sol',
        text: 'SUPPORT_FUNDED_NATIVE_RECEIPT', inputTokens: 10, outputTokens: 1 })));
    });
    const operator = http.createServer((_req, res) => res.end('fixture-operator'));
    const [upstreamPort, operatorPort] = await Promise.all([listen(upstream), listen(operator)]);
    let gateway: ReturnType<typeof createInferenceGateway> | undefined;
    let route: Awaited<ReturnType<typeof prepareSupportOperationNativeLaunch>>;
    let child: ReturnType<typeof spawn> | undefined;
    const attempts: Array<Record<string, unknown>> = [];
    const start = async () => {
      route = await prepareSupportOperationNativeLaunch({ workspaceId, ownerId, sessionId,
        agent: 'codex', checkout: root, accepted: active.binding }, async options => {
        gateway = createInferenceGateway({ accountId: 'synthetic-support', token: async () => 'synthetic-support-native-bearer',
          codexPool: createFailoverPool([{ accountId: 'synthetic-support', token: async () => 'synthetic-support-native-bearer' }]),
          carryTrial: { ...options.carryTrial!, async authorizeAttempt(attempt) {
            // Retain the final synthetic request shape for an actionable failure
            // without recording either the private route or provider credential.
            const body = JSON.parse(attempt.body);
            attempts.push({ transport: attempt.transport, target: attempt.target, accountId: attempt.accountId,
              bodyKeys: Object.keys(body), model: body.model, reasoning: body.reasoning,
              maxOutputTokens: body.max_output_tokens,
              toolTypes: Array.isArray(body.tools) ? body.tools.map((tool: { type?: string }) => tool.type) : null });
            return options.carryTrial!.authorizeAttempt(attempt);
          } },
          fetchImpl: async (target, init) => {
            expect(String(target)).toBe('https://api.openai.com/v1/responses');
            return originalFetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, init);
          },
          requestOutcomeStore: { record: async () => {}, report: async () => ({ rows: [], total: 0,
            byOutcome: { ok: 0, 'client-error': 0, 'upstream-429': 0, 'upstream-error': 0, shed: 0,
              cancelled: 0, 'gateway-error': 0, unclassified: 0 }, firstRequestTimestampMs: null,
            lastFinalizedAtMs: null, truncated: false, retentionMs: 0 }),
          providerSummary: async q => summarizeProviderOutcomeCounts(q.provider, { fromMs: q.fromMs, toMs: q.toMs ?? q.fromMs }, []) },
          requestAbsorbMs: 0, selfHeal: { enabled: false } });
        return { port: await gateway.listen(0), stop: () => gateway!.close() } as RunningGatewayService;
      });
      return JSON.parse(route!.envelopeEnv.PAPERCUSP_SCOPED_INFERENCE_GATEWAY!) as { baseURL: string; token: string };
    };
    try {
      let privateRoute = await start();
      const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '-m', 'gpt-6.1-sol', ...Object.entries({ model_reasoning_effort: 'medium',
          'model_providers.papercusp-codex-gateway.request_max_retries': 0,
          'model_providers.papercusp-codex-gateway.stream_max_retries': 0,
          'features.apps': false, 'features.hooks': false, web_search: 'disabled',
        }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
        'Return the local synthetic support receipt.'];
      const env = hermeticEnv({ ...route!.envelopeEnv, PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
        PAPERCUSP_SID: `test-support-funded-${root.split('/').at(-1)}`, PAPERCUSP_PSU_HEADLESS: '1',
        PAPERCUSP_PSU_PTY: '1', PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operatorPort}` });
      const preloadDir = join(codexHome, 'fixture-preloads'); mkdirSync(preloadDir);
      for (const name of ['committed-source-loader.mjs', 'vitest-startup-trace.mjs']) {
        const original = fileURLToPath(new URL(`../../../../scripts/lib/${name}`, import.meta.url));
        const staged = join(preloadDir, name); writeFileSync(staged, readFileSync(original));
        env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').split(pathToFileURL(original).href)
          .join(pathToFileURL(staged).href).split(original).join(staged);
      }
      env.PAPERCUSP_COMMITTED_SOURCE_GIT = '/usr/bin/git';
      const launcher = fileURLToPath(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url));
      const fixture = join(root, 'launcher-fixture.mjs');
      writeFileSync(fixture, `import { runWrapper, applyScopedNativeGateway } from ${JSON.stringify(launcher)};\n` +
        'applyScopedNativeGateway(process.env);\n' +
        `runWrapper({wrapperBin:'codex',args:${JSON.stringify(args)},cwd:${JSON.stringify(root)},preserveCwd:true,` +
        'envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n');
      child = spawn(process.execPath, [fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(output.slice(-4000))); }, 30_000);
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.once('close', value => { clearTimeout(timer); resolve(value); });
      });
      expect(code, JSON.stringify({ output, counts, attempts, upstreamSends: bodies.length })).toBe(0);
      expect(output).not.toContain('COMMITTED_SOURCE substituted');
      expect(output).toContain('SUPPORT_FUNDED_NATIVE_RECEIPT');
      expect(bodies, output).toHaveLength(1);
      expect(JSON.parse(bodies[0]!)).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, max_output_tokens: 100 });
      const request = async () => {
        const response = await originalFetch(`${privateRoute.baseURL}/v1/responses`, { method: 'POST',
          headers: { authorization: `Bearer ${privateRoute.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, input: 'synthetic support' }) });
        await response.text(); return response.status;
      };
      const reservations = () => db.adminSql<{ body: { maximumCostMicros: number; bodySha256: string } }[]>`
        SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = ${workspaceId}
          AND surface = 'blueprint-operation' AND writer_key = ${`receipt:${handle.receiptId}`}
          AND body->>'kind' = 'native-budget-reservation'`;
      expect(await reservations()).toEqual([{ body: expect.objectContaining({ maximumCostMicros: 40_000,
        bodySha256: createHash('sha256').update(bodies[0]!).digest('hex') }) }]);
      // Revoking the employee while provider counting is awaited must prevent
      // both the reservation and the final upstream send.
      const initialCounts = counts;
      onCount = async () => { await replacePermissionListMembers(db.adminSql, workspaceId, listId, []); };
      expect(await request()).toBe(403);
      expect(counts).toBe(initialCounts + 1);
      expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      expect(await request()).toBe(403); expect(counts).toBe(initialCounts + 1);
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
      onCount = async () => { await db.adminSql`UPDATE harness_shared.work_items SET taken_by = 'replacement-worker'
        WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`; };
      expect(await request()).toBe(403); expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      await db.adminSql`UPDATE harness_shared.work_items SET taken_by = ${ownerId}
        WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`;
      onCount = async () => { await db.adminSql`UPDATE harness_shared.adv_sessions SET ended_at = now()
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`; };
      expect(await request()).toBe(403); expect(bodies).toHaveLength(1); expect(await reservations()).toHaveLength(1);
      onCount = undefined;
      await db.adminSql`UPDATE harness_shared.adv_sessions SET ended_at = NULL
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
      await route!.stop();
      privateRoute = await start();
      expect(await request()).toBe(200); expect(bodies).toHaveLength(2);
      await route!.stop();
      privateRoute = await start();
      expect(await request()).toBe(403); expect(bodies).toHaveLength(2);
      expect((await reservations()).map(row => row.body.maximumCostMicros)).toEqual([40_000, 40_000]);
      const report = await db.adminSql.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000 });
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await route!?.stop(); await gateway?.close();
      await Promise.all([upstream, operator].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('support operation durable native funding (synthetic; no provider sends)', () => {
  it('serializes attempts across connections/restarts and retains unknown outcome costs and ancestor limits', async () => {
    // Restore this synthetic fixture's grant after the preceding hostile ACL test.
    await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [{ provider: 'slack', providerUserId: 'T1:EMPLOYEE' }]);
    const funding = { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
      allocationId: 'synthetic-support-project', month: '2026-10' };
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level, maximum] of [
        ['synthetic-support-org', null, 'organization', 1_000_000],
        ['synthetic-support-dept', 'synthetic-support-org', 'department', 150_000],
        [funding.allocationId, 'synthetic-support-dept', 'project', 1_000_000],
      ] as const) {
        expect((await defineHostedAllocation(tx as unknown as Sql, { organization: funding.organization,
          allocationId, parentAllocationId, level, costClass: 'model', month: funding.month,
          capMicros: 1_000_000, maxUnreconciledMicros: maximum,
          evidenceRef: 'synthetic:A-8:internal-simulation', recordedBy: 'fixture' })).outcome).toBe('created');
      }
    });
    const handle = await submit('native-budget-race');
    const request = (maximum: number) => ({ handle, funding, operationMaximumMicros: 100_000,
      attemptId: crypto.randomUUID(), attemptMaximumMicros: maximum, bodySha256: 'c'.repeat(64) });
    // A distinct, wide pool plus a connection barrier makes this a real race.
    // The fixture's normal max:2 pool must not serialize it accidentally.
    const racePools = Array.from({ length: 4 }, () =>
      postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {} }));
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests = Array.from({ length: 4 }, () => request(40_000));
    try {
      // A ReservedSql has no begin(). Use real pools, and establish four
      // distinct connections before the barrier so the transaction race is
      // neither an interface cast nor accidental max:1 pool serialization.
      const backends = await Promise.all(racePools.map(pool => pool<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`));
      expect(new Set(backends.map(rows => rows[0]!.pid)).size).toBe(requests.length);
      const results = await Promise.all(requests.map(async (r, index) => {
        if (++arrived === requests.length) release();
        await gate;
        return reserveSupportOperationAttempt(racePools[index]!, r);
      }));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await reserveSupportOperationAttempt(racePools[0]!, requests[results.indexOf(true)]!)).toBe(false);
    } finally { await Promise.all(racePools.map(pool => pool.end())); }
    // A new pool has no process-local allowance state from the race.
    const restarted = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
    try {
      expect(await reserveSupportOperationAttempt(restarted, request(20_000))).toBe(true);
      expect(await reserveSupportOperationAttempt(restarted, request(1))).toBe(false);
      await restarted.begin(async tx => recordSupportWorkflowOutcome(tx as unknown as Sql, {
        handle, funding, decision: 'accept', reviewerPrincipal: 'engineering-reviewer', evidenceRef: 'synthetic:review:unknown',
      }));
      let report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000 });
      expect(report.outcomes[0]).toMatchObject({ acceptedWithUnknownCost: 1, costPerAcceptedOutcomeMicros: null,
        reviewEffortUnknown: 1, reworkUnknown: 1, evidenceClasses: ['internal-simulation'] });
      await restarted.begin(async tx => {
        expect((await settleHostedAllocation(tx as unknown as Sql, { organization: funding.organization,
          reservationId: supportOperationReservationId(handle), costSource: 'provider-billed', providerFinal: true,
          costMicros: 23_000, observedAtMs: Date.now(), evidenceRef: 'synthetic:provider-final' })).outcome).toBe('settled');
        await recordSupportWorkflowOutcome(tx as unknown as Sql, { handle, funding, decision: 'accept',
          reviewerPrincipal: 'engineering-reviewer', evidenceRef: 'synthetic:review:known' });
      });
      report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.outcomes[0]).toMatchObject({ outcomes: 1, acceptedWithUnknownCost: 0,
        acceptedResultCostMicros: 23_000, costPerAcceptedOutcomeMicros: 23_000 });
      const second = await submit('native-budget-second'), third = await submit('native-budget-third');
      expect(await reserveSupportOperationAttempt(restarted, { ...request(40_000), handle: second })).toBe(true);
      expect(await reserveSupportOperationAttempt(restarted, { ...request(40_000), handle: third })).toBe(false);
      report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.byCostClass.model).toMatchObject({ committedMicros: 123_000, unreconciledMicros: 100_000 });
    } finally { await restarted.end(); }
  }, 30_000);
});

describe('support business review with real corpus and funding (synthetic completion)', () => {
  const funding = { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-business-org' },
    allocationId: 'synthetic-business-project', month: '2026-10' };
  const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
  const reviewer = { provider: 'slack', providerUserId: 'T1:REVIEWER' };
  beforeAll(async () => {
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level] of [
        [funding.organization.organizationId, null, 'organization'],
        ['synthetic-business-dept', funding.organization.organizationId, 'department'],
        [funding.allocationId, 'synthetic-business-dept', 'project'],
      ] as const) {
        const outcome = await defineHostedAllocation(tx as unknown as Sql, { ...funding,
          allocationId, parentAllocationId, level, costClass: 'model', capMicros: 1_000_000,
          maxUnreconciledMicros: 1_000_000, evidenceRef: 'synthetic:business-review', recordedBy: 'fixture' });
        expect(outcome.outcome, JSON.stringify(outcome)).toBe('created');
      }
    });
  });
  it.each(['accept', 'reject', 'rework'] as const)('persists a distinct %s decision only while both principals retain source access', async decision => {
    const trial = supportWorkflowTrialEvidenceFixture({ workspace: workspaceId, harness: harnessSlug,
      workflowRevision: revision, operationId: 'support-business-journey', submitter: `${userId}/employee`,
      reviewer: reviewerId, supportCaseId: 'case-cobalt', documentIds: [documentId], now: Date.now() + 60_000 });
    // Move the synthetic preregistration before admission, and close observations
    // after both actual persisted operations. No claim of a real trial is made.
    trial.registration.startsAt = new Date(Date.now() - 20_000).toISOString();
    trial.input.registration = trial.put('fixture:registration', trial.registration, true);
    for (const use of [1, 2]) {
    for (const id of [userId, reviewerId]) await createPersonalGrant(db.adminSql, {
      workspaceId, userId: id, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee, reviewer]);
    const callerId = `${userId}/employee`;
    const access = { principalId: reviewerId };
    const handle = await submit(`business:${decision}:${use}`, { operationId: 'support-business-journey' });
    if (handle.target.kind !== 'work-item') throw new Error('business fixture requires a work item');
    const workItemId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, harnessSlug));
    if (!item) throw new Error('business fixture admission is missing');
    expect(await reserveSupportOperationAttempt(db.adminSql, { handle, funding, operationMaximumMicros: 100_000,
      attemptId: crypto.randomUUID(), attemptMaximumMicros: 10_000, bodySha256: 'c'.repeat(64) })).toBe(true);
    const output = { supportCaseId: 'case-cobalt', summary: 'Cited engineering handoff',
      reproduction: ['Open the synthetic case'], checklist: ['Confirm the failure'], suggestedRole: 'engineering',
      citations: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123' }] };
    expect((await seedSupportWorkflowSyntheticCompletion(db.adminSql, { handle, role, output })).pairedModelRecords)
      .toBe(1);
    expect(await getBlueprintOperationStatus(db.adminSql, handle, callerId)).toMatchObject({
      phase: 'terminal', outcome: 'succeeded', items: [{ state: 'done' }],
    });
    const prepared = await getBlueprintOperationResult(db.adminSql, handle, callerId);
    if (prepared.state !== 'ready' || !prepared.businessReview) throw new Error(`business output was not validated: ${JSON.stringify(prepared)}`);
    expect(prepared.businessReview.state).toBe('pending');
    const request = { channel: 'business-review', requestKey: `decision:${decision}`,
      payload: { decision, reason: 'Reviewed the cited internal handoff', resultFingerprint: prepared.businessReview.resultFingerprint } };
    await expect(signalBlueprintOperation(db.adminSql, handle, callerId, request, { principalId: userId }))
      .rejects.toThrow(/distinct authenticated reviewer/);
    await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
      WHERE workspace_id = ${workspaceId} AND user_id = ${reviewerId}::uuid`;
    expect(await getBlueprintOperationResult(db.adminSql, handle, reviewerId, access)).toMatchObject({ state: 'unavailable' });
    await expect(signalBlueprintOperation(db.adminSql, handle, reviewerId, request, access)).rejects.toThrow(/validated successful result/);
    await createPersonalGrant(db.adminSql, { workspaceId, userId: reviewerId, principalType: 'agent-role',
      principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    expect(await getBlueprintOperationResult(db.adminSql, handle, reviewerId, access)).toMatchObject({ state: 'unavailable' });
    await expect(signalBlueprintOperation(db.adminSql, handle, reviewerId, request, access)).rejects.toThrow(/validated successful result/);
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee, reviewer]);
    expect(await getBlueprintOperationResult(db.adminSql, handle, reviewerId, access)).toMatchObject({ state: 'ready',
      output: { citations: [{ sourceUrl: 'https://support.example/internal/cobalt' }] } });
    const saved = await signalBlueprintOperation(db.adminSql, handle, reviewerId, request, access);
    expect(await signalBlueprintOperation(db.adminSql, handle, reviewerId, request, access))
      .toMatchObject({ replayed: true, eventId: saved.eventId });
    const restarted = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
    try {
      expect(await getBlueprintOperationResult(restarted, handle, callerId)).toMatchObject({ state: 'ready',
        businessReview: { state: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'rework',
          accountableOwner: 'engineering-owner', decision: { reviewerPrincipal: reviewerId, eventId: saved.eventId } } });
      const events = await getBlueprintOperationEvents(restarted, handle, reviewerId, { reviewAccess: access });
      expect(events.events.filter(event => event.kind === 'business-review')).toHaveLength(1);
      const report = await restarted.begin(tx => readHostedAllocationReport(tx as unknown as Sql, funding));
      expect(report.outcomes[0]).toMatchObject({ evidenceClasses: ['internal-simulation'], reviewEffortUnknown: expect.any(Number) });
      const [stored] = await restarted<{ output: unknown }[]>`SELECT payload->'blueprintResult'->'output' AS output
        FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND feature_id = ${workItemId}`;
      expect(stored!.output).toEqual(output);
      trial.observe(handle, prepared.businessReview.resultFingerprint);
      if (use === 2) {
        // Fixture evidence uses the existing append-only store as its trusted
        // adapter. Canonical operation authority still comes from real PG rows.
        const prefix = `r11:${decision}:${crypto.randomUUID()}`;
        for (const [ref, artifact] of trial.artifacts) await restarted`INSERT INTO harness_shared.coord_event_log
          (workspace_id, surface, writer_key, msg_id, body) VALUES (${workspaceId}, 'r11-test-artifact', ${prefix}, ${ref},
            ${restarted.json(JSON.parse(JSON.stringify(artifact)))})`;
        const authority: SupportTrialAuthority = { ...trial.authority, resolve: async ref => {
          const [row] = await restarted<{ body: unknown }[]>`SELECT body FROM harness_shared.coord_event_log
            WHERE workspace_id = ${workspaceId} AND surface = 'r11-test-artifact' AND writer_key = ${prefix} AND msg_id = ${ref}`;
          return row?.body as Awaited<ReturnType<SupportTrialAuthority['resolve']>>;
        } };
        let verdict = await evaluateSupportWorkflowTrial(restarted, trial.input, authority);
        expect(verdict.findings.map(v => v.code)).toContain('provider-final-cost-unknown');
        for (const observed of trial.input.observations) await restarted.begin(async tx => {
          expect((await settleHostedAllocation(tx as unknown as Sql, { organization: funding.organization,
            reservationId: supportOperationReservationId(observed.handle), costSource: 'provider-billed', providerFinal: true,
            costMicros: 23_000, observedAtMs: Date.now(), evidenceRef: 'synthetic:r11-final-cost' })).outcome).toBe('settled');
          await recordSupportWorkflowOutcome(tx as unknown as Sql, { handle: observed.handle, funding, decision,
            reviewerPrincipal: reviewerId, evidenceRef: 'synthetic:r11-final-cost' });
        });
        verdict = await evaluateSupportWorkflowTrial(restarted, trial.input, authority);
        expect(verdict.status, JSON.stringify(verdict.findings)).toBe(decision === 'accept' ? 'satisfied' : 'failed');
        expect(verdict.evidenceClass).toBe('internal-simulation');
        if (decision !== 'accept') expect(verdict.findings).toContainEqual({ kind: 'failed', code: 'threshold-stop', subject: 'acceptedRate' });
        if (decision === 'accept') {
          expect(verdict.coverage).toEqual({ population: ['cohort-1'], checked: ['cohort-1'], notChecked: [] });
          const forged = structuredClone(trial.input); forged.observations[0]!.handle.workspaceId = 'foreign';
          expect((await evaluateSupportWorkflowTrial(restarted, forged, authority)).findings.map(v => v.code)).toContain('operation-scope');
          const missing = structuredClone(trial.input); missing.observations[0]!.handle.receiptId = 2_000_000_000;
          expect((await evaluateSupportWorkflowTrial(restarted, missing, authority)).findings.map(v => v.code)).toContain('receipt-missing');
          const wrongFingerprint = structuredClone(trial.artifacts.get(trial.input.observations[0]!.record.ref)!);
          Object.assign(wrongFingerprint.body as object, { resultFingerprint: 'f'.repeat(64) });
          const { supportTrialBodyHash } = await import('./support-workflow-trial');
          wrongFingerprint.record.hash = supportTrialBodyHash(wrongFingerprint.body);
          const wrongInput = structuredClone(trial.input); wrongInput.observations[0]!.record = wrongFingerprint.record;
          const wrongAuthority = { ...authority, resolve: async (ref: string) => ref === wrongFingerprint.record.ref
            ? wrongFingerprint : authority.resolve(ref) };
          expect((await evaluateSupportWorkflowTrial(restarted, wrongInput, wrongAuthority)).findings.map(v => v.code)).toContain('canonical-attribution');
          wrongFingerprint.body = structuredClone(trial.artifacts.get(trial.input.observations[0]!.record.ref)!.body);
          const forgedCost = wrongFingerprint.body as { measured: { costMicros: { value: number } } };
          forgedCost.measured.costMicros = { value: 1 };
          wrongFingerprint.record.hash = supportTrialBodyHash(wrongFingerprint.body);
          wrongInput.observations[0]!.record = wrongFingerprint.record;
          expect((await evaluateSupportWorkflowTrial(restarted, wrongInput, wrongAuthority)).findings.map(v => v.code)).toContain('cost-misattributed');
          // Hide only this test's business-review event, then restore it. The
          // successful executor result must not invent business acceptance.
          const [reviewEvent] = await restarted<{ msg_id: string }[]>`SELECT msg_id FROM harness_shared.coord_event_log WHERE id = ${saved.eventId}::bigint`;
          try {
            await restarted`UPDATE harness_shared.coord_event_log SET msg_id = ${`${reviewEvent!.msg_id}:hidden`} WHERE id = ${saved.eventId}::bigint`;
            const pending = await evaluateSupportWorkflowTrial(restarted, trial.input, authority);
            expect(pending.status).toBe('unknown');
            expect(pending.findings.map(v => v.code)).toEqual(expect.arrayContaining(['canonical-review-unavailable', 'repeat-use-unavailable']));
          } finally {
            await restarted`UPDATE harness_shared.coord_event_log SET msg_id = ${reviewEvent!.msg_id} WHERE id = ${saved.eventId}::bigint`;
          }
        }
        await replacePermissionListMembers(restarted, workspaceId, listId, [employee]);
        const revoked = await evaluateSupportWorkflowTrial(restarted, trial.input, authority);
        expect(revoked.findings.map(v => v.code)).toContain('canonical-review-unavailable');
        if (decision === 'accept') expect(revoked.status).toBe('unknown');
        await replacePermissionListMembers(restarted, workspaceId, listId, [employee, reviewer]);
      }
      await replacePermissionListMembers(restarted, workspaceId, listId, [reviewer]);
      expect(await getBlueprintOperationResult(restarted, handle, reviewerId, access)).toMatchObject({ state: 'unavailable' });
      await expect(signalBlueprintOperation(restarted, handle, reviewerId, request, access)).rejects.toThrow(/validated successful result/);
    } finally {
      await restarted.end();
      await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    }
    }
  });
});

describe('support operation administrative lifecycle', () => {
  it('authorizes local admin actions, preserves old pins, replays after restart and revokes live grants', async () => {
    const admin = { workspaceId, harness: harnessSlug, operationId: 'support-to-engineering', principalId: 'engineering-owner' };
    const denied = { ...admin, principalId: userId };
    const original = await readBlueprintFromPg(db.adminSql, workspaceId, harnessSlug);
    if (!original) throw new Error('Missing administration fixture');
    const sourceGrant = await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: admin.principalId });
    expect(sourceGrant.scopes).toEqual(['personal:organization']);
    const overlappingGrant = await createPersonalGrant(db.adminSql, { workspaceId, userId,
      principalType: 'agent-role', principalId: role, scopes: [ORGANIZATION_CORPUS_SCOPE, 'slack'],
      grantedBy: admin.principalId });
    const unrelatedGrant = await createPersonalGrant(db.adminSql, { workspaceId, userId,
      principalType: 'agent-role', principalId: 'unrelated-worker', scopes: [ORGANIZATION_CORPUS_SCOPE],
      grantedBy: admin.principalId });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [{ provider: 'slack', providerUserId: 'T1:EMPLOYEE' }]);
    // This case must work alone under -t as well as after the budget cases.
    await db.adminSql.begin(async tx => {
      for (const [allocationId, parentAllocationId, level, maximum] of [
        ['synthetic-support-org', null, 'organization', 1_000_000],
        ['synthetic-support-dept', 'synthetic-support-org', 'department', 150_000],
        ['synthetic-support-project', 'synthetic-support-dept', 'project', 1_000_000],
      ] as const) {
        const allocation = await defineHostedAllocation(tx as unknown as Sql, {
          organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-support-org' },
          allocationId, parentAllocationId, level, month: '2026-10', costClass: 'model', capMicros: 1_000_000,
          maxUnreconciledMicros: maximum, evidenceRef: 'synthetic:A-8:internal-simulation', recordedBy: 'fixture',
        });
        expect(['created', 'duplicate']).toContain(allocation.outcome);
      }
    });
    const handle = await submit('native-admin-service-original');
    const action = { action: 'promote' as const, expectedSpecificationRevision: revision,
      targetRevision: revision, reason: 'Internal local promotion', requestKey: 'native-admin-promote' };
    await expect(readWorkflowAdministration(db.adminSql, denied)).rejects.toThrow(/accountable owner/);
    await expect(administerWorkflow(db.adminSql, denied, action)).rejects.toThrow(/accountable owner/);
    await expect(readWorkflowAdministration(db.adminSql, { ...admin, workspaceId: 'unrelated-workspace' })).rejects.toThrow(/approved workflow/);
    const before = await readWorkflowAdministration(db.adminSql, admin);
    expect(before).toMatchObject({ approvedRevision: revision, version: '1', accountableOwner: admin.principalId,
      funding: { capMicros: 1_000_000, unknownReason: null } });
    const candidate = structuredClone(original);
    candidate.operations!.find(o => o.id === admin.operationId)!.version = '2';
    const compiled = compileAgentSpecification({ source: candidate });
    try {
      // Authoring/provisioning is separate from the admin switch. Retain a
      // validated candidate through the same store projection already uses.
      const { retainBlueprintSpecificationSnapshot } = await import('./project-to-pg');
      await retainBlueprintSpecificationSnapshot(db.adminSql, { workspaceId, harnessSlug, specification: compiled });
      const promote = { ...action, targetRevision: compiled.specificationRevision };
      const receipt = await administerWorkflow(db.adminSql, admin, promote);
      expect(receipt).toMatchObject({ accepted: true, replayed: false });
      expect((await readWorkflowAdministration(db.adminSql, admin)).version).toBe('2');
      await expect(submit('native-admin-stale')).rejects.toThrow(/revision/);
      expect(await submit('native-admin-service-original')).toEqual(handle);
      const newer = await submit('native-admin-service-new', { expectedSpecificationRevision: compiled.specificationRevision,
        input: { ...selection(), approvedRevision: compiled.specificationRevision } });
      const restarted = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
      try {
        expect(await administerWorkflow(restarted, admin, promote)).toMatchObject({ eventId: receipt.eventId, replayed: true });
        await expect(administerWorkflow(restarted, admin, { ...promote, reason: 'Changed replay' })).rejects.toThrow(/different input/);
        await expect(administerWorkflow(restarted, admin, { ...promote, requestKey: 'stale-admin-key' })).rejects.toThrow(/revision changed/);
        await administerWorkflow(restarted, admin, { ...action, action: 'rollback', requestKey: 'native-admin-rollback',
          expectedSpecificationRevision: compiled.specificationRevision, targetRevision: revision });
        const stop = { action: 'stop' as const, expectedSpecificationRevision: revision, reason: 'Operator stop',
          handle: newer, requestKey: 'native-admin-stop' };
        await expect(administerWorkflow(restarted, admin, { ...stop, handle: { ...newer, workspaceId: 'other' } })).rejects.toThrow(/exact receipt/);
        const stopReceipt = await administerWorkflow(restarted, admin, stop);
        const [storedStop] = await restarted<{ body: unknown; shape: string }[]>`SELECT body, jsonb_typeof(body) AS shape
          FROM harness_shared.coord_event_log WHERE workspace_id = ${workspaceId}
            AND id = ${stopReceipt.eventId}::bigint`;
        expect(storedStop?.shape).toBe('object');
        const { requestKey: _stopKey, ...stopInput } = stop;
        expect(storedStop?.body).toEqual({ ...WorkflowAdministrationActionSchema.parse(stopInput),
          harness: harnessSlug, operationId: admin.operationId, principalId: admin.principalId });
        expect(await administerWorkflow(restarted, admin, stop)).toMatchObject({ replayed: true });
        expect(await getBlueprintOperationStatus(restarted, newer, `${userId}/employee`)).toMatchObject({
          handle: { specificationRevision: compiled.specificationRevision }, cancellationRequested: true });
        const stoppedItem = await runWithWorkspace(workspaceId, () => getWorkItem(
          newer.target.kind === 'work-item' ? newer.target.id : '', harnessSlug));
        expect(stoppedItem?.payload).toMatchObject({ blueprintCancellation: { requestedBy: admin.principalId } });
        const revoke = { ...stop, action: 'revoke' as const, requestKey: 'native-admin-revoke' };
        await administerWorkflow(restarted, admin, revoke);
        expect(await administerWorkflow(restarted, admin, revoke)).toMatchObject({ replayed: true });
        const grants = await listPersonalGrants(restarted, workspaceId, userId);
        expect(grants.find(grant => grant.id === sourceGrant.id)).toMatchObject({
          scopes: ['personal:organization'], revoked_at: expect.anything(),
        });
        expect(grants.find(grant => grant.id === overlappingGrant.id)?.revoked_at).toBeTruthy();
        expect(grants.find(grant => grant.id === unrelatedGrant.id)?.revoked_at).toBeNull();
        await expect(submit('native-admin-no-live-grant')).rejects.toThrow(/no_live_grant/);
        const after = await readWorkflowAdministration(restarted, admin);
        expect(after).toMatchObject({ approvedRevision: revision, version: '1' });
        expect(after.history.filter(e => e.body.action === 'stop')).toHaveLength(1);
        expect(after.history.filter(e => e.body.action === 'revoke')).toHaveLength(1);
        expect(after.retainedRevisions).toContainEqual({ revision: compiled.specificationRevision, version: '2' });
        const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(restarted, workspaceId,
          (await runWithWorkspace(workspaceId, () => getWorkItem(newer.target.kind === 'work-item' ? newer.target.id : '', harnessSlug)))!);
        expect(operation.version).toBe('2');
        expect(pin.specificationRevision).toBe(compiled.specificationRevision);
      } finally { await restarted.end(); }
    } finally {
      await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug, blueprint: original,
        specification: compileAgentSpecification({ source: original }) });
      await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
        scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    }
  });
  it('preserves accepted revisions across promotion, rollback, cancellation and live source revocation', async () => {
    const employee = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
    const callerId = `${userId}/employee`;
    await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, [employee]);
    const original = await readBlueprintFromPg(db.adminSql, workspaceId, harnessSlug);
    if (!original) throw new Error('administrative fixture has no approved blueprint');
    expect(await readBlueprintHashFromPg(db.adminSql, workspaceId, harnessSlug)).toBe(revision);
    const originalHandle = await submit('admin-original');
    const accepted = async (handle: typeof originalHandle, sql: Sql = db.adminSql) => {
      if (handle.target.kind !== 'work-item') throw new Error('administrative fixture requires a work item');
      const item = await runWithWorkspace(workspaceId, () => getWorkItem(handle.target.kind === 'work-item'
        ? handle.target.id : '', harnessSlug));
      if (!item) throw new Error('administrative fixture lost its accepted item');
      return readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
    };
    const promoted = structuredClone(original);
    const operation = promoted.operations?.find(value => value.id === 'support-to-engineering');
    if (!operation) throw new Error('administrative fixture lost its support operation');
    operation.version = '2';
    try {
      await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug, blueprint: promoted,
        specification: compileAgentSpecification({ source: promoted }) });
      const promotedRevision = await readBlueprintHashFromPg(db.adminSql, workspaceId, harnessSlug);
      if (!promotedRevision || promotedRevision === revision) throw new Error('promotion did not change the approved revision');
      await expect(submit('admin-stale')).rejects.toThrow(/revision/);
      expect(await submit('admin-original')).toEqual(originalHandle);
      const promotedHandle = await submit('admin-promoted', { expectedSpecificationRevision: promotedRevision,
        input: { ...selection(), approvedRevision: promotedRevision } });
      expect(promotedHandle.specificationRevision).toBe(promotedRevision);
      expect((await accepted(originalHandle)).operation.version).toBe('1');
      expect((await accepted(promotedHandle)).operation.version).toBe('2');

      await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug, blueprint: original,
        specification: compileAgentSpecification({ source: original }) });
      expect(await readBlueprintHashFromPg(db.adminSql, workspaceId, harnessSlug)).toBe(revision);
      const rolledBack = await submit('admin-rollback');
      expect(rolledBack.specificationRevision).toBe(revision);
      // Rollback changes new admissions, never the accepted snapshot of a run.
      expect((await accepted(promotedHandle)).operation.version).toBe('2');
      const stop = { requestKey: 'admin-stop', reason: 'Internal operator stop drill' };
      const cancelled = await cancelBlueprintOperation(db.adminSql, promotedHandle, callerId, stop);
      expect(cancelled).toMatchObject({ accepted: true, handled: false, effected: false });
      expect(await cancelBlueprintOperation(db.adminSql, promotedHandle, callerId, stop))
        .toMatchObject({ replayed: true, eventId: cancelled.eventId });
      const restarted = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
      try {
        expect(await getBlueprintOperationStatus(restarted, promotedHandle, callerId)).toMatchObject({
          handle: { specificationRevision: promotedRevision }, cancellationRequested: true, outcome: null,
        });
        expect(await getBlueprintOperationStatus(restarted, originalHandle, callerId)).toMatchObject({
          handle: { specificationRevision: revision }, cancellationRequested: false,
        });
        const events = await getBlueprintOperationEvents(restarted, promotedHandle, callerId);
        expect(events.events.filter(event => event.kind === 'cancel')).toHaveLength(1);
      } finally { await restarted.end(); }
      await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid`;
      await expect(submit('admin-revoked')).rejects.toThrow(/no_live_grant/);
      const [refused] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
        FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
          AND request_key IN ('admin-stale', 'admin-revoked')`;
      expect(refused!.n).toBe(0);
      expect((await accepted(originalHandle)).pin.specificationRevision).toBe(revision);
      expect((await accepted(promotedHandle)).pin.specificationRevision).toBe(promotedRevision);
    } finally {
      await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug, blueprint: original,
        specification: compileAgentSpecification({ source: original }) });
      await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
        scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
    }
  });
});
