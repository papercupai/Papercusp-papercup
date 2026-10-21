import { fork } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { loadAccountPool } from '../deployment/account-pool-store';
import { getOrgPg } from '@papercusp/db-org';
import { getTxPool } from '../agent-tools/locks/su-lock-store';
import { accountsForProvider, isSpawnEligible } from '../deployment/account-pool';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../../test/private-http-workspace-preflight';
import { CODEX_SAFE_DEFAULT_MODEL } from '../model-context-budget.mjs';
import { ONE_MILLION_MODEL_ALIASES } from '../inference-gateway/model-aliases';
import { makeCredentialResolver } from '../inference-gateway/credential-store';
import { spawnObservedGatewayModel, spawnRouteGatewayModel } from '../fleet/spawn-tree';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(240_000);

// Explicit e2e selection only: each case spends exactly one real provider request.
it.for(['primary', 'capacity-failover'] as const)('records the exact real %s blueprint request on its private spawn row',
  { timeout: options.testTimeoutMs }, async (mode, context) => {
  const sourceWorkspace = process.env.PAPERCUSP_TEST_RUN_WORKSPACE || process.env.PAPERCUSP_WORKSPACE_ID;
  expect(sourceWorkspace, 'source workspace must be explicit').toBeTruthy();
  const pool = await loadAccountPool(sourceWorkspace);
  const observedAt = Date.now();
  const codex = accountsForProvider(pool, 'codex').filter(account => mode === 'capacity-failover' || isSpawnEligible(account, observedAt));
  const claude = accountsForProvider(pool, 'claude').filter(account => isSpawnEligible(account, observedAt));
  expect(codex.length, 'routing proof requires a configured Codex account (available on the primary path)').toBeGreaterThan(0);
  if (mode === 'capacity-failover') expect(claude.length, 'real failover requires an available Claude account').toBeGreaterThan(0);
  const eligible = mode === 'capacity-failover' ? [...codex, ...claude] : codex;
  // Transfer only maintained credential references; never read/export credential bytes.
  const accounts = eligible.map(account => ({ ...account, boundTo: [], softPin: [],
    credentialRef: account.credentialRef.replace(/~/g, homedir()) }));
  // Validate schemes before compiling a host or allocating PG, without reading tokens.
  for (const account of accounts.filter(row => row.provider === 'claude')) makeCredentialResolver(account.credentialRef);
  let prepared: ReturnType<typeof preparePrivateOperatorApiBundle> | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/blueprint/launch-blueprint-account-route.e2e.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/lib/git-index-fault.mjs',
      'scripts/lib/batch-watchdog.mjs', 'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/bundle-host-common.sh',
      'packages/operator-core/lib/util/cli-entry.ts',
      'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/blueprint-account-route-http-scenario.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/agent-config.ts',
      'packages/operator-core/lib/blueprint/launch-blueprint.ts',
      'packages/operator-core/lib/deployment/account-pool.ts',
      'packages/operator-core/lib/deployment/account-pool-store.ts',
      'packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts',
      'packages/operator-core/lib/harness-invoke-once.ts',
      'packages/operator-core/lib/inference-gateway/launch.ts',
      'packages/operator-core/lib/inference-gateway/gateway.ts',
      'packages/operator-core/lib/inference-gateway/spawn-env.ts',
      'packages/operator-core/lib/inference-gateway/error-body-scrub.ts',
      'packages/operator-core/lib/inference-gateway/codex-model-refusals.ts',
      'packages/operator-core/lib/inference-gateway/credential-store.ts',
      'packages/operator-core/lib/inference-gateway/model-aliases.ts',
      'packages/operator-core/lib/model-context-budget.mjs',
      'packages/operator-core/lib/fleet/role-launch.ts',
      'packages/operator-core/lib/fleet/spawn-tree.ts',
      'packages/operator-core/lib/gym/gym-db-init.ts',
      'libs/papercusp/packages/orchestrator/src/invoke.ts',
      'libs/papercusp/packages/orchestrator/src/spawn-mcp.ts'],
    retainedArtifacts: ['phases/prepare/operator-api-preflight.json', 'phases/prepare/operator-api-build.log',
      'phases/execute/account-route.json', 'phases/execute/account-route-preflight.json',
      'phases/execute/provider-response.json',
      'phases/execute/shared-effects.json',
      'phases/execute/worker.log'],
    prepare: async evidenceDir => {
      // Compilation and its real restricted-write census run before allocating
      // a private PG or starting the bounded provider/request journey.
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        builder: { timeoutMs: 240_000, maxMs: 420_000 },
      });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared, 'private API preparation must finish before runtime allocation').toBeTruthy();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const referenceFile = join(evidenceDir, 'account-pool-references.json');
      await writeFile(referenceFile, JSON.stringify({ accounts, observedAt, mode,
        headroom: eligible.map(({ id, provider, rate }) => ({ id, provider, rate })) }), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', PC_ISOLATED_RUNTIME_PROOF: '1',
        STAGING_FIRST_HTTP_SCENARIO: 'blueprint-account-route', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        FGR_R6_ACCOUNT_POOL_REFERENCE_FILE: referenceFile,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        `--prepared-api-sha=${prepared!.sha256}`, `--prepared-receipt-sha=${prepared!.receiptSha256}`],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (/^(STAGING_FIRST_HTTP_PHASE|BLUEPRINT_ACCOUNT_ROUTE_PHASE) /.test(line)) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(referenceFile, { force: true }); await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('BLUEPRINT_ACCOUNT_ROUTE_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('BLUEPRINT_ACCOUNT_ROUTE_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        childStopped: true, responseObservedByChild: false, responseBufferedWhileChildPaused: true,
        upstream: { status: 200, requests: 1 },
        canonicalTreeReadOnly: true, privateMcp: true,
        declared: { account: 'auto', backend: 'codex', codexGatewayPresent: false } });
      expect(receipt.firstRequest.ownerId).toBe(receipt.spawnId);
      expect(receipt.firstRequest.requestId).toBe(receipt.telemetry.requestId);
      expect(receipt.firstRequest.servingAccountId).toBe(receipt.telemetry.servingAccountId);
      expect(receipt.route.resolvedAccountIds).toContain(receipt.firstRequest.servingAccountId);
      expect(spawnObservedGatewayModel(receipt.firstRequest)).toBe(spawnRouteGatewayModel(receipt.route));
      expect(receipt.firstRequest.effort).toBe(receipt.route.launchedEffort);
      const [model, effort] = CODEX_SAFE_DEFAULT_MODEL.split(':');
      const gatewayModel = mode === 'capacity-failover' ? ONE_MILLION_MODEL_ALIASES.sonnet : model;
      const launchSpecModel = mode === 'capacity-failover' ? `${gatewayModel}[1m]` : gatewayModel;
      const launchedEffort = mode === 'capacity-failover' ? 'high' : effort;
      expect(receipt.route).toMatchObject({ ownerId: receipt.spawnId, accountRoute: 'auto',
        requestedBackend: 'codex', launchedBackend: mode === 'capacity-failover' ? 'claude-code' : 'codex', requestedModel: model,
        launchedModel: launchSpecModel, requestedEffort: effort, launchedEffort });
      expect(receipt).toMatchObject({ mode, injectedPrimaryWall: mode === 'capacity-failover' });
      expect(receipt.route.reason ?? null).toBe(mode === 'capacity-failover' ? 'capacity' : null);
      expect(receipt.upstream).toMatchObject({ requestShape: { model: gatewayModel, effort: launchedEffort }, error: null });
      expect(receipt.childConfig).toMatchObject({ model: launchSpecModel, effort: launchedEffort });
      expect(receipt.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.runtimeInputs.invoke).toBe(join(root, 'libs/papercusp/packages/orchestrator/bin/invoke-once.ts'));
      expect(receipt.privateGateUnchanged).toBe(true);
      expect(receipt.privateClaims).toBe(0);
      expect(receipt.childConfig).toMatchObject({ ownerId: receipt.spawnId, mcpOwnerId: receipt.spawnId,
        accountPinPresent: false, canonicalMount: { options: expect.arrayContaining(['ro']) } });
      // Read shared state by the exact child identity; concurrent peer activity
      // cannot create a false failure or hide a child-owned claim/lock.
      const { sql } = getOrgPg();
      const [claims] = await sql`SELECT count(*)::int AS count FROM harness_shared.work_item_claims
        WHERE owner=${receipt.spawnId}`;
      const [locks] = await getTxPool()`SELECT count(*)::int AS count FROM agent_file_locks
        WHERE owner=${receipt.spawnId}`;
      const [resourceLocks] = await getTxPool()`SELECT count(*)::int AS count FROM agent_resource_locks
        WHERE owner=${receipt.spawnId}`;
      const [granularLocks] = await getTxPool()`SELECT count(*)::int AS count FROM agent_granular_locks
        WHERE owner=${receipt.spawnId}`;
      expect(claims.count).toBe(0);
      expect(locks.count).toBe(0);
      expect(resourceLocks.count).toBe(0);
      expect(granularLocks.count).toBe(0);
      receipt.sharedEffects = { ownerId: receipt.spawnId, claims: claims.count, fileLocks: locks.count,
        resourceLocks: resourceLocks.count, granularLocks: granularLocks.count };
      await writeFile(join(evidenceDir, 'shared-effects.json'), JSON.stringify(receipt.sharedEffects));
      console.info('BLUEPRINT_ACCOUNT_ROUTE_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('BLUEPRINT_ACCOUNT_ROUTE_PROOF_RUN ' + runId);
});
