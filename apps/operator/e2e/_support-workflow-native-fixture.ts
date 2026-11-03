import type { Sql } from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { projectBlueprintToPg, retainBlueprintSpecificationSnapshot } from '../../../packages/operator-core/lib/blueprint/project-to-pg';
import { supportToEngineeringOperation } from '../../../packages/operator-core/lib/blueprint/support-workflow-operation';
import { currentBenchCodexSubscriptionContract, currentBenchOpenAiInputContract } from '../../../packages/operator-core/lib/external-bench/current-su';
import { defineHostedAllocation } from '../../../packages/operator-core/lib/auth/hosted/billing/allocation-store';
import { createPersonalGrant, listPersonalGrants, personalScope, revokePersonalGrant } from '../../../packages/operator-core/lib/personal-vault/store';
import { getIdentitySource } from '../../../packages/operator-core/lib/agent-identities/source';
import { getOrgPg } from '@papercusp/db-org';
import { mutateHarnessRegistry } from '../../../packages/operator-core/lib/harness-registry';
import { createExternalTriggerBinding, createExternalTriggerSource } from '../../../packages/operator-core/lib/external-triggers/admin';
import { isCodingAgentRole } from '../../../packages/operator-core/lib/personal-vault/coding-roles';
import { listCodexInstalledModels } from '../../../packages/operator-core/lib/model-context-budget.mjs';
import { readWorkflowAdministration } from '../../../packages/operator-core/lib/blueprint/support-workflow-administration';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, replacePermissionListMembers, searchOrganizationDocuments,
  upsertOrganizationDocuments, upsertPermissionList } from '../../../packages/operator-core/lib/data-sources/documents-corpus';

export type SupportWorkerNativePayer = { payer: 'api-key' } | {
  payer: 'subscription'; inputTokenCeiling: number; outputTokenCeiling: number;
  /** Explicit frozen test allocation, not a provider invoice or API spend grant. */
  simulationBudgetMicros?: number;
};

const supportNativeMaximumCostMicros = 100_000;

function supportWorkerSimulationBudget(selection: SupportWorkerNativePayer) {
  const maximum = selection.payer === 'subscription'
    ? selection.simulationBudgetMicros ?? supportNativeMaximumCostMicros : supportNativeMaximumCostMicros;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 1_000_000_000)
    throw new Error('Support native simulation budget must be positive and at most 1000000000 micro-USD');
  return maximum;
}

/** Fixture inputs only: subscription limits must be qualified before a real
 * provider trial. A syntactically valid frozen contract is not limit evidence. */
function supportWorkerNativePolicy(selection: SupportWorkerNativePayer = { payer: 'api-key' }) {
  if (!selection || !['api-key', 'subscription'].includes(selection.payer)
    || Object.keys(selection).some(key => !['payer', ...(selection.payer === 'subscription'
      ? ['inputTokenCeiling', 'outputTokenCeiling', 'simulationBudgetMicros'] : [])].includes(key)))
    throw new Error('Support native payer selection is invalid');
  const inputTokenCeiling = selection.payer === 'subscription' ? selection.inputTokenCeiling : 1000;
  const outputTokenCeiling = selection.payer === 'subscription' ? selection.outputTokenCeiling : 100;
  if (![inputTokenCeiling, outputTokenCeiling].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Support subscription requires explicit positive provider token ceilings');
  // Retain the existing synthetic rates and default allowance. Subscription
  // trials may explicitly freeze a larger test allocation in this private
  // input bundle; nothing here grants access to a separately billed API key.
  const maximumCostMicros = supportWorkerSimulationBudget(selection);
  const reservationMicros = inputTokenCeiling * 30 + outputTokenCeiling * 100;
  if (!Number.isSafeInteger(reservationMicros) || reservationMicros > maximumCostMicros)
    throw new Error(`Support native full-limit reservation ${reservationMicros} exceeds the ${maximumCostMicros === supportNativeMaximumCostMicros ? 'unchanged' : 'explicitly frozen'} ${maximumCostMicros} micro-USD simulation budget`);
  return { model: 'gpt-6.1-sol', effort: 'medium', account: 'auto', payer: selection.payer,
    inputTokenCeiling, outputTokenCeiling,
    inputTokenCeilingSourceSha256: selection.payer === 'subscription'
      ? currentBenchCodexSubscriptionContract('gpt-6.1-sol', inputTokenCeiling, outputTokenCeiling)
      : currentBenchOpenAiInputContract('gpt-6.1-sol', inputTokenCeiling),
    inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, cacheWriteUsdPerMillion: 30, outputUsdPerMillion: 100 };
}

async function assertSupportSubscriptionBounds(accounts: Array<{ credentialRef: string }>,
  native: ReturnType<typeof supportWorkerNativePolicy>) {
  if (native.payer !== 'subscription') return;
  const { parseCodexCliRef } = await import('../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge');
  for (const account of accounts) {
    const codexHome = parseCodexCliRef(account.credentialRef);
    const model = codexHome ? listCodexInstalledModels({ codexHome }).find(row => row.id === native.model) : null;
    const window = model?.maxContextWindow ?? model?.contextWindow;
    if (!window || !Number.isSafeInteger(window) || window <= 0)
      throw new Error('Support subscription requires installed provider model-window metadata for every account');
    // Input plus output fits the provider context window. Reserving the whole
    // window for EACH is conservative when no separate output maximum is
    // published. Never substitute the API-key fixture's tiny output cap.
    if (native.inputTokenCeiling < window || native.outputTokenCeiling < window)
      throw new Error('Support subscription ceilings must each cover the installed provider model window');
  }
}

/** Reference-only transfer, following launch-blueprint-account-route's private runtime pattern.
 * The existing private bundle carries the explicit payer; no credential bytes
 * or ambient account discovery are added to the disposable database. */
export async function prepareSupportWorkerAccountReferences(sourceWorkspace: string, path: string,
  nativePayer: SupportWorkerNativePayer = { payer: 'api-key' }) {
  if (!sourceWorkspace.trim() || /^verify-tauri-isolated-/.test(sourceWorkspace)
    || !isAbsolute(path) || path.startsWith(fileURLToPath(new URL('../../../', import.meta.url))))
    throw new Error('Support worker references require an explicit source workspace and external destination');
  const native = supportWorkerNativePolicy(nativePayer);
  const { loadAccountPool } = await import('../../../packages/operator-core/lib/deployment/account-pool-store');
  const { accountsForProvider, isSpawnEligible } = await import('../../../packages/operator-core/lib/deployment/account-pool');
  const accounts = accountsForProvider(await loadAccountPool(sourceWorkspace), 'codex')
    .filter(row => isSpawnEligible(row, Date.now())
      && row.credentialRef.startsWith('codex-cli:') === (nativePayer.payer === 'subscription'))
    .map(row => ({ ...row, boundTo: [], softPin: [], credentialRef: row.credentialRef.replace(/~/g, homedir()) }));
  if (!accounts.length) throw new Error(`Support worker references require an eligible configured Codex ${nativePayer.payer === 'subscription' ? 'subscription' : 'API-key'} account`);
  await assertSupportSubscriptionBounds(accounts, native);
  const { parseCodexCliRef } = await import('../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge');
  const { makeBearerCredentialResolver, parseCredentialRef } = await import('../../../packages/operator-core/lib/inference-gateway/credential-store');
  for (const row of accounts) {
    const cliHome = parseCodexCliRef(row.credentialRef);
    if (cliHome) await access(`${cliHome}/auth.json`);
    else {
      makeBearerCredentialResolver(row.credentialRef); // validate reference syntax without reading credentials
      const reference = parseCredentialRef(row.credentialRef);
      if (reference.kind === 'env') {
        if (!process.env[reference.path]) throw new Error('Support worker credential environment reference is unavailable');
      } else await access(reference.path);
    }
  }
  await writeFile(path, JSON.stringify({ accounts, nativePayer }), { mode: 0o600, flag: 'wx' });
}

async function assertSupportFixtureDatabase(sql: Sql, workspaceId: string) {
  if (!/^verify-tauri-isolated-[a-zA-Z0-9-]+$/.test(workspaceId))
    throw new Error('Support native fixture requires a verify-tauri-isolated workspace');
  // The maintained native rig has its own data directory; the conventional PG
  // guard uses createOrgTestDb's private, randomly named clone. An env flag or
  // workspace label alone is not proof that the SQL connection is throwaway.
  const [database] = await sql<{ name: string; directory: string }[]>`SELECT current_database() AS name,
    current_setting('data_directory') AS directory`;
  if (!database || (!/^org_[a-f0-9]{12}$/.test(database.name)
    && !/\/verify-tauri-headless\.[^/]+\/isolated-pgdata(?:\/|$)/.test(database.directory)))
    throw new Error('Support native fixture requires the maintained isolated PostgreSQL database');
  // The canonical registry writer resolves its pool in-process. Prove that it
  // uses the same private database before it can mutate any registry or users.
  const [registryDatabase] = await getOrgPg().sql<{ name: string; directory: string }[]>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory`;
  if (registryDatabase?.name !== database.name || registryDatabase?.directory !== database.directory)
    throw new Error('Support native fixture registry must use the same isolated PostgreSQL database');
}

/** This is test input, never worker-completion/model evidence or acceptance. */
export async function seedSupportWorkflowNativeFixture(sql: Sql, input: {
  workspaceId: string;
  harnessSlug?: string;
  requireWorkerAccount?: boolean;
  workerAccountReferenceFile?: string;
}) {
  const { workspaceId } = input;
  await assertSupportFixtureDatabase(sql, workspaceId);
  let native = supportWorkerNativePolicy();
  let maximumCostMicros = supportNativeMaximumCostMicros;
  if (input.workerAccountReferenceFile) {
    // References are injected explicitly from outside the checkout. Never
    // discover the shared pool from inside this disposable database.
    const path = input.workerAccountReferenceFile;
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    if (!isAbsolute(path) || path.startsWith(root))
      throw new Error('Support native account references must be outside the checkout');
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1_048_576)
      throw new Error('Support native account references require a private bounded file');
    const source = JSON.parse(await readFile(path, 'utf8'));
    const nativePayer: SupportWorkerNativePayer = source.nativePayer ?? { payer: 'api-key' };
    native = supportWorkerNativePolicy(nativePayer);
    maximumCostMicros = supportWorkerSimulationBudget(nativePayer);
    const { accountProvider, isSpawnEligible } = await import('../../../packages/operator-core/lib/deployment/account-pool');
    if (!Array.isArray(source.accounts) || !source.accounts.length || source.accounts.some((row: any) =>
      !row || typeof row.id !== 'string' || typeof row.credentialRef !== 'string'
      || accountProvider(row) !== 'codex' || !isSpawnEligible(row, Date.now())
      || row.credentialRef.startsWith('codex-cli:') !== (nativePayer.payer === 'subscription')))
      throw new Error(`Support native account references require eligible Codex ${nativePayer.payer === 'subscription' ? 'subscription' : 'API-key'} accounts`);
    await assertSupportSubscriptionBounds(source.accounts, native);
    const { updateAccountPool } = await import('../../../packages/operator-core/lib/deployment/account-pool-store');
    await updateAccountPool(() => ({ accounts: source.accounts.map((row: any) =>
      ({ ...row, boundTo: [], softPin: [] })) }), workspaceId);
  }
  if (input.requireWorkerAccount) {
    // The launcher's shared gateway statistics do not establish that this
    // disposable workspace has an allowed pool. Use bootstrap's actual route
    // decision before creating inputs or waiting for a worker that cannot boot.
    const { resolveAccountPin } = await import('../../../packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su');
    const route = await resolveAccountPin(workspaceId, 'auto', 'codex', undefined, false, 'gpt-6.1-sol');
    if (route.error || route.provider !== 'codex' || !route.gatewayAuto)
      throw new Error('Support native worker account preflight refused: configure an allowed Codex auto route in the isolated workspace');
  }
  // Admission alone accepts a syntactically valid identity pin. The actual
  // worker bootstrap also resolves its source, so pin the maintained identity
  // instead of inventing a role-named source and a placeholder content hash.
  const workerIdentity = await getIdentitySource('blueprint-operation-worker', {
    repoDir: fileURLToPath(new URL('../../../', import.meta.url)),
  });
  if (!workerIdentity.ok || !workerIdentity.sourcePath)
    throw new Error('Support native fixture requires the maintained blueprint operation worker identity');
  const workerIdentityRevision = workerIdentity.identity.version;
  if (!workerIdentityRevision)
    throw new Error('Support native fixture requires a versioned blueprint operation worker identity');

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const harnessSlug = input.harnessSlug ?? `support-native-${nonce}`;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(harnessSlug)) throw new Error('Invalid fixture harness slug');
  // Organization corpus access deliberately excludes coding roles, including
  // worker. Reuse the existing non-coding operator role; the accepted identity
  // still determines this operation's domain and grants.
  const role = 'operator';
  const projectDir = fileURLToPath(new URL('../../../', import.meta.url));
  if (isCodingAgentRole(role)) throw new Error('Support native fixture requires a non-coding corpus role');
  assembleRolePrompt({ slug: harnessSlug, role, projectDir, mode: 'chat' });
  const operationId = 'support-to-engineering';
  const supportCaseId = `case-cobalt-${nonce}`;
  const documentTitle = `Cobalt support ${nonce}`;
  const query = 'cobalt roadmap';
  const externalId = `T1:CSUPPORT:${nonce}`;
  const sourceUrl = `https://support.example/internal/${supportCaseId}`;
  const funding = { organization: { controlWorkspaceId: workspaceId, organizationId: `synthetic-support-org-${nonce}` },
    allocationId: `synthetic-support-project-${nonce}`, month: new Date().toISOString().slice(0, 7) };

  const fixture = await sql.begin(async tx => {
    const client = tx as unknown as Sql;
    const actors = {} as Record<'employee' | 'reviewer' | 'admin', { id: string; username: string; password: string }>;
    for (const actor of ['employee', 'reviewer', 'admin'] as const) {
      const username = `p012-${actor}-${nonce}`;
      const password = randomUUID();
      const [user] = await tx<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name, password_hash)
        VALUES (${username}, ${`Native support ${actor}`}, crypt(${password}, gen_salt('bf'))) RETURNING id`;
      if (!user) throw new Error('Fixture user was not created');
      actors[actor] = { id: user.id, username, password };
    }
    await tx`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${workspaceId}, ${harnessSlug}, ${randomBytes(32)}, 'synthetic-native-support', 0)`;
    const identities = {
      employee: { provider: 'slack', providerUserId: `T1:EMPLOYEE:${nonce}` },
      reviewer: { provider: 'slack', providerUserId: `T1:REVIEWER:${nonce}` },
    };
    for (const actor of ['employee', 'reviewer'] as const) {
      // The operation worker and the existing GUI tool caller are independent
      // grant principals. The source ACL still restricts both to these users.
      for (const principalId of new Set([role, 'operator'])) await createPersonalGrant(client, { workspaceId,
        userId: actors[actor].id, principalType: 'agent-role', principalId,
        scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: actors.admin.id });
      await mapProviderIdentity(client, workspaceId, { ...identities[actor], userId: actors[actor].id,
        mappedBy: actors.admin.id });
    }
    const list = await upsertPermissionList(client, workspaceId, { source: 'slack', sourceRef: `T1:CSUPPORT:${nonce}` });
    await replacePermissionListMembers(client, workspaceId, list.id, Object.values(identities));
    await upsertOrganizationDocuments(client, workspaceId, list.id, [{ source: 'slack', kind: 'message',
      dedupeKey: supportCaseId, externalId, title: documentTitle,
      text: 'The cobalt roadmap needs a reproducible engineering handoff.', metadata: { permalink: sourceUrl } }]);
    const [document] = await tx<{ id: string }[]>`SELECT id FROM harness_shared.documents
      WHERE workspace_id=${workspaceId} AND dedupe_key=${supportCaseId}`;
    if (!document) throw new Error('Fixture source document was not created');
    const operation = supportToEngineeringOperation({ id: operationId, version: '1', role,
      identity: { kind: 'identity', ref: workerIdentity.identity.id,
        revision: workerIdentityRevision, contentHash: workerIdentity.contentHash },
      accountableOwner: actors.admin.id, reviewerPrincipals: [actors.reviewer.id],
      allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros,
      model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' }, funding,
      // Synthetic frozen rates and allocation. This helper never sends to a
      // provider and never manufactures an execution or completion receipt.
      native });
    const blueprint = BlueprintSchema.parse({ id: harnessSlug, grants: {}, workItem: { kind: 'task' },
      roles: [{ id: role }], spine: { edges: { DONE: { to: 'done' } } },
      dependencies: { tools: ['blueprint:read-private-input'] }, operations: [operation] });
    const specification = compileAgentSpecification({ source: blueprint });
    await projectBlueprintToPg(client, { workspaceId, harnessSlug, blueprint, specification });
    // Candidate input for the native admin journey, never an approved pointer
    // or accepted receipt. Only the authenticated owner may promote it.
    const candidate = structuredClone(blueprint);
    candidate.operations!.find(value => value.id === operationId)!.version = '2';
    const candidateSpecification = compileAgentSpecification({ source: candidate });
    await retainBlueprintSpecificationSnapshot(client, { workspaceId, harnessSlug, specification: candidateSpecification });
    const department = `synthetic-support-dept-${nonce}`;
    for (const [allocationId, parentAllocationId, level] of [
      [funding.organization.organizationId, null, 'organization'],
      [department, funding.organization.organizationId, 'department'],
      [funding.allocationId, department, 'project'],
    ] as const) {
      const result = await defineHostedAllocation(client, { ...funding, allocationId, parentAllocationId, level,
        costClass: 'model', capMicros: Math.max(1_000_000, maximumCostMicros), maxUnreconciledMicros: maximumCostMicros,
        evidenceRef: 'synthetic:native-support-fixture', recordedBy: actors.admin.id });
      if (result.outcome !== 'created') throw new Error(`Fixture allocation was refused: ${result.outcome}`);
    }
    // Workflows inventories operation installations through trigger bindings,
    // not blueprint declarations alone. Install the synthetic input through
    // that same seam, without credentials, arming, events, or execution proof.
    const source = await createExternalTriggerSource(client, workspaceId, { kind: 'slack',
      config: { label: `Native support ${nonce}`, synthetic: true }, createdBy: actors.admin.id });
    await createExternalTriggerBinding(client, workspaceId, { sourceId: source.id,
      operationHarnessSlug: harnessSlug, operationId, eventPattern: 'ext:slack:message.received',
      eventFilter: { supportCaseId }, stormPolicy: { maxRuns: 1, windowSeconds: 60 },
      createdBy: actors.admin.id });
    return { workspaceId, harnessSlug, operationId, supportCaseId, query, documentTitle,
      documentId: document.id, listId: list.id, externalId, sourceUrl, role, actors, identities,
      approvedRevision: specification.specificationRevision, blueprint, specification, funding,
      candidateRevision: candidateSpecification.specificationRevision,
      input: { supportCaseId, approvedRevision: specification.specificationRevision,
        documentIds: [document.id], query, requestedAction: 'prepare-handoff' } };
  });
  // Projection supplies operation admission; worker bootstrap separately needs
  // a registry checkout and an existing role prompt. Use the maintained operator
  // role and this exact source root (the native rig supplies its frozen copy).
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: harnessSlug, path: projectDir }] }), workspaceId);
  return fixture;
}

export type SupportWorkflowNativeFixture = Awaited<ReturnType<typeof seedSupportWorkflowNativeFixture>>;

export type SupportWorkflowReviewerAccess = 'allowed' | 'no-grant' | 'no-source-acl';
export type SupportWorkflowAccessSelection = Pick<SupportWorkflowNativeFixture,
  'workspaceId' | 'harnessSlug' | 'operationId' | 'documentId' | 'listId' | 'role' | 'identities' | 'query'> & {
    actors: Record<keyof SupportWorkflowNativeFixture['actors'], { id: string }>;
  };

/** Change only test input permissions in the private rig. Never write a
 * completion, model attestation or review decision to make a journey pass. */
export async function setSupportWorkflowNativeReviewerAccess(sql: Sql,
  fixture: SupportWorkflowAccessSelection, access: SupportWorkflowReviewerAccess) {
  await assertSupportFixtureDatabase(sql, fixture.workspaceId);
  if (!['allowed', 'no-grant', 'no-source-acl'].includes(access) || fixture.role !== 'operator')
    throw new Error('Invalid native support reviewer access');
  const { workspaceId, actors } = fixture;
  const administration = await readWorkflowAdministration(sql, { workspaceId,
    harness: fixture.harnessSlug, operationId: fixture.operationId, principalId: actors.admin.id });
  const [document] = await sql<{ id: string }[]>`SELECT id FROM harness_shared.documents
    WHERE workspace_id=${workspaceId} AND id=${fixture.documentId}::uuid AND permission_list_id=${fixture.listId}::uuid`;
  if (!document || !administration.reviewerPrincipals.includes(actors.reviewer.id))
    throw new Error('Native support reviewer fixture does not match its retained operation');
  const scope = personalScope(ORGANIZATION_CORPUS_SCOPE);
  const grants = await listPersonalGrants(sql, workspaceId, actors.reviewer.id);
  for (const grant of grants) {
    if (!grant.revoked_at && grant.principal_type === 'agent-role' && grant.principal_id === fixture.role
      && grant.scopes.includes(scope)) await revokePersonalGrant(sql, workspaceId, actors.reviewer.id, grant.id);
  }
  if (access !== 'no-grant') await createPersonalGrant(sql, { workspaceId,
    userId: actors.reviewer.id, principalType: 'agent-role', principalId: fixture.role,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: actors.admin.id });
  await replacePermissionListMembers(sql, workspaceId, fixture.listId,
    access === 'no-source-acl' ? [fixture.identities.employee] : Object.values(fixture.identities));
  const measured = await searchOrganizationDocuments(sql,
    { workspaceId, role: fixture.role, harnessSlug: fixture.harnessSlug }, {
      workspaceId, principalUserId: actors.reviewer.id, agentOwnerId: actors.reviewer.id,
      query: fixture.query, sources: ['slack'], documentIds: [fixture.documentId], limit: 1,
    });
  return { access, allowed: measured.allowed,
    documentIds: measured.allowed ? measured.results.map(row => row.id) : [],
    reason: measured.allowed ? null : measured.reason };
}

/** Evaluate INSIDE the owned webview. HttpOnly cookies remain browser-managed.
 * Return only the measured user id; never print fixture passwords or cookies. */
export function supportWorkflowNativeLoginScript(fixture: SupportWorkflowNativeFixture,
  actor: keyof SupportWorkflowNativeFixture['actors']) {
  const { id, username, password } = fixture.actors[actor];
  return `(async () => {
    const workspaceId = ${JSON.stringify(fixture.workspaceId)};
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': workspaceId },
      body: JSON.stringify(${JSON.stringify({ username, password })}) });
    if (!response.ok) throw new Error('Support actor login refused: ' + response.status);
    const signedIn = await response.json();
    const measured = await fetch('/api/auth/me', { credentials: 'include',
      headers: { 'x-papercusp-workspace': workspaceId } });
    if (!measured.ok) throw new Error('Support actor session read refused');
    const current = await measured.json();
    if (signedIn.user?.id !== ${JSON.stringify(id)} || current.user?.id !== ${JSON.stringify(id)}
      || current.user?.workspace_id !== workspaceId || current.autoLogin !== false)
      throw new Error('Support actor cookie identity did not switch');
    return { userId: current.user.id, workspaceId: current.user.workspace_id, actor: ${JSON.stringify(actor)} };
  })()`;
}
