import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { hermeticEnv } from '../../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { prepareSupportOperationNativeLaunch, stopSupportOperationNativeLaunch, SUPPORT_NATIVE_ROUTE_LEASE_MS } from './support-workflow-native-launch';
import { supportOperationReservationId } from './support-workflow-budget';
import { createInferenceGateway } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { summarizeProviderOutcomeCounts } from '../inference-gateway/gateway-request-outcome-store';
import { processMonotonicClock } from '../process-monotonic-clock';
import { currentRequestWorkspaceId } from '../workspace-als';
import type { AcceptedOperationWorkerBinding } from './operation-worker-binding';
import type { GatewayServiceOptions, RunningGatewayService } from '../inference-gateway/launch';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../inference-gateway/codex-cli-bridge';

const ports = vi.hoisted(() => ({ item: vi.fn(), accepted: vi.fn(), sql: vi.fn(),
  active: vi.fn(), claim: vi.fn(), budget: vi.fn(), confine: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: ports.sql }),
}));
vi.mock('../work-items', () => ({ getWorkItem: ports.item, claimWorkItem: ports.claim }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem: ports.accepted }));
vi.mock('./operation-worker-binding', () => ({ readActiveOperationWorkerClaimBinding: ports.active }));
vi.mock('../capability-envelope/session-confinement-store', () => ({ declareSessionConfinement: ports.confine }));
vi.mock('./support-workflow-budget', async original => ({
  ...await original<typeof import('./support-workflow-budget')>(), readSupportOperationBudgetBinding: ports.budget,
}));
const workspaceId = 'support-native-workspace', ownerId = 'support-native-worker', revision = 'a'.repeat(64);
const pin = { kind: 'blueprint-operation' as const, harnessSlug: 'support', operationId: 'handoff',
  operationVersion: '1', specificationRevision: revision, input: { supportCaseId: 'case-a' } };
const accepted: AcceptedOperationWorkerBinding = {
  workItemId: 'WI-12', harnessSlug: 'support', storageHarnessSlug: 'support',
  operationId: 'handoff', specificationRevision: revision, pin,
  identity: { ref: 'support-worker', revision: '1', contentHash: revision },
  stack: [], requiredTools: [],
};
const input = { workspaceId, ownerId, sessionId: 4, agent: 'codex', checkout: '/tmp/support-native', accepted };
const operation = { id: 'handoff', policy: { supportCase: {
  funding: { organization: { controlWorkspaceId: workspaceId } },
  native: { payer: 'api-key', account: 'auto', outputTokenCeiling: 17 },
} } };
const handle = { workspaceId, harnessSlug: 'support', receiptId: 12, operationId: 'handoff',
  specificationRevision: revision, target: { kind: 'work-item' as const, id: 'WI-12' } };
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1',
  () => resolve((server.address() as { port: number }).port)));
beforeEach(() => {
  vi.resetAllMocks();
  ports.item.mockResolvedValue({ id: 'WI-12', assignee: null });
  ports.claim.mockResolvedValue({ id: 'WI-12', assignee: ownerId });
  ports.accepted.mockResolvedValue({ operation: structuredClone(operation), pin: structuredClone(pin) });
  ports.sql.mockResolvedValue([{ id: 12 }]);
  ports.active.mockResolvedValue({ status: 'bound', binding: structuredClone(accepted), receipt: { sessionId: 4 } });
  ports.confine.mockResolvedValue({ ok: true });
  ports.budget.mockImplementation(async (workspace, owner) => {
    expect([workspace, owner, currentRequestWorkspaceId()]).toEqual([workspaceId, ownerId, workspaceId]);
    return { manifestSha256: revision, armId: supportOperationReservationId(handle), async authorizeAttempt(attempt: { attemptId: string; clockId: string }) {
      return { attemptId: attempt.attemptId, clockId: attempt.clockId, reservationRef: 'synthetic-budget',
        validUntilMonotonicMs: processMonotonicClock.now() + 5000, validateAuthorization() {} };
    } };
  });
});

it.each(['omitted', 'spoofed', 'foreign-claim', 'replaced-worker'] as const)(
  'private native support route fixes worker authority with %s attribution', async mode => {
    let writes = 0;
    const upstream = http.createServer((req, res) => { writes++; req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"synthetic","output":[]}'); });
    const up = await listen(upstream);
    let gateway: ReturnType<typeof createInferenceGateway> | undefined;
    let route: Awaited<ReturnType<typeof prepareSupportOperationNativeLaunch>>;
    try {
      route = await prepareSupportOperationNativeLaunch(input, async options => {
        gateway = createInferenceGateway({ accountId: 'synthetic', token: async () => 'synthetic-provider',
          codexPool: createFailoverPool([{ accountId: 'synthetic', token: async () => 'synthetic-provider' }]),
          carryTrial: options.carryTrial, openaiUpstreamBase: `http://127.0.0.1:${up}`,
          requestOutcomeStore: { record: async () => {}, report: async () => ({
            rows: [], total: 0, byOutcome: { ok: 0, 'client-error': 0, 'upstream-429': 0,
              'upstream-error': 0, shed: 0, cancelled: 0, 'gateway-error': 0, unclassified: 0 },
            firstRequestTimestampMs: null, lastFinalizedAtMs: null, truncated: false, retentionMs: 0,
          }), providerSummary: async q => summarizeProviderOutcomeCounts(q.provider, { fromMs: q.fromMs, toMs: q.toMs ?? q.fromMs }, []) },
          requestAbsorbMs: 0, selfHeal: { enabled: false } });
        const port = await gateway.listen(0);
        return { port, stop: () => gateway!.close() } as RunningGatewayService;
      });
      const privateRoute = JSON.parse(route!.envelopeEnv.PAPERCUSP_SCOPED_INFERENCE_GATEWAY!);
      if (mode === 'foreign-claim') ports.item.mockResolvedValue({ id: 'WI-12', assignee: 'another-worker' });
      if (mode === 'replaced-worker') ports.active.mockResolvedValue({ status: 'bound', binding: accepted, receipt: { sessionId: 5 } });
      const response = await fetch(`${privateRoute.baseURL}/v1/responses`, { method: 'POST',
        headers: { authorization: `Bearer ${privateRoute.token}`, 'content-type': 'application/json',
          ...(mode === 'spoofed' ? { 'x-papercusp-owner': 'another-worker' } : {}) },
        body: JSON.stringify({ model: 'gpt-6-sol', input: 'synthetic' }) });
      await response.text();
      const allowed = mode === 'omitted' || mode === 'spoofed';
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(writes).toBe(allowed ? 1 : 0);
      if (allowed) expect(ports.claim).toHaveBeenCalledWith('WI-12', ownerId, { harness: 'support' });
      else expect(ports.claim).not.toHaveBeenCalled();
      const admin = await fetch(`${privateRoute.baseURL}/admin/owner-pin`, { method: 'POST',
        headers: { authorization: `Bearer ${privateRoute.token}` }, body: '{}' });
      expect(admin.status).toBe(403); await admin.text();
      for (const query of ['', '?owner=another-worker', `?owner=${ownerId}&owner=another-worker`]) {
        const report = await fetch(`${privateRoute.baseURL}/admin/owner-report${query}`, {
          headers: { authorization: `Bearer ${privateRoute.token}` },
        });
        expect(report.status).toBe(403); await report.text();
      }
      const ownReport = await fetch(`${privateRoute.baseURL}/admin/owner-report?owner=${ownerId}`, {
        headers: { authorization: `Bearer ${privateRoute.token}` },
      });
      expect(ownReport.status).toBe(200);
      const report = await ownReport.json() as { owner: string; ledger: unknown };
      expect(report.owner).toBe(ownerId);
      if (allowed) expect(report.ledger).toMatchObject({ requests: 1 });
      expect(ports.confine).toHaveBeenCalledWith(expect.objectContaining({ ownerId, confinement: expect.objectContaining({
        denyAmbientContext: true, denyOutside: expect.not.arrayContaining(['capability:bash', 'accounts:status']),
        denyWorkItemsOutside: { id: 'WI-12', harness: 'support', checkout: input.checkout },
      }) }));
    } finally {
      await route!?.stop(); await gateway?.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

it('refuses unsupported or unconfined support launches before opening a listener', async () => {
  const start = vi.fn();
  await expect(prepareSupportOperationNativeLaunch({ ...input, agent: 'claude' }, start)).rejects.toThrow(/Codex/);
  ports.confine.mockResolvedValue({ ok: false, reason: 'storage unavailable' });
  await expect(prepareSupportOperationNativeLaunch(input, start)).rejects.toThrow(/confinement/);
  expect(start).not.toHaveBeenCalled();
});

it('expires the private listener even when an exit report is lost', async () => {
  const stop = vi.fn(async () => {});
  vi.useFakeTimers();
  try {
    const route = await prepareSupportOperationNativeLaunch(input, async () => ({ port: 32001, stop }) as unknown as RunningGatewayService);
    await vi.advanceTimersByTimeAsync(SUPPORT_NATIVE_ROUTE_LEASE_MS);
    expect(stop).toHaveBeenCalledOnce();
    await route!.stop(); expect(stop).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('stops only the exact tracked launch and invalidates already authorized sends', async () => {
  let options: GatewayServiceOptions | undefined;
  const stop = vi.fn(async () => {});
  const route = await prepareSupportOperationNativeLaunch(input, async supplied => {
    options = supplied;
    return { port: 32001, stop } as unknown as RunningGatewayService;
  });
  try {
    const receipt = await options!.carryTrial!.authorizeAttempt({ attemptId: 'attempt', clockId: 'clock' } as never);
    expect(receipt).not.toBeNull();
    await stopSupportOperationNativeLaunch(input.sessionId + 1);
    expect(stop).not.toHaveBeenCalled();
    await stopSupportOperationNativeLaunch(input.sessionId);
    expect(stop).toHaveBeenCalledOnce();
    expect(() => receipt!.validateAuthorization!()).toThrow(/stopped/);
    await expect(options!.carryTrial!.authorizeAttempt({} as never)).resolves.toBeNull();
    await stopSupportOperationNativeLaunch(input.sessionId);
    expect(stop).toHaveBeenCalledOnce();
  } finally { await route!.stop(); }
});

it.each(['socket-boundary', 'installed-codex'] as const)(
  'uses the private support route through actual managed PTY and SRT (%s)', async mode => {
    // DB/authorization ports above stay synthetic; the launcher, native binary,
    // SRT network confinement and private HTTP gateway below are real.
    const root = mkdtempSync('/tmp/support-native-srt-');
    const codexHome = join(root, 'codex-home'); mkdirSync(codexHome);
    const resultPath = join(root, 'boundary-result');
    const bodies: Array<Record<string, unknown>> = [];
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
        text: 'SUPPORT_NATIVE_RECEIPT', inputTokens: 0, outputTokens: 0 })));
    });
    const operator = http.createServer((_req, res) => res.end('fixture-operator'));
    const [upstreamPort, operatorPort] = await Promise.all([listen(upstream), listen(operator)]);
    let gateway: ReturnType<typeof createInferenceGateway> | undefined;
    let route: Awaited<ReturnType<typeof prepareSupportOperationNativeLaunch>>;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const budget = ports.budget.getMockImplementation()!;
      let admissions = 0;
      ports.budget.mockImplementation((...args) => ++admissions === 1 ? budget(...args) : null);
      route = await prepareSupportOperationNativeLaunch({ ...input, checkout: root }, async options => {
        gateway = createInferenceGateway({ accountId: 'synthetic', token: async () => 'synthetic-provider',
          codexPool: createFailoverPool([{ accountId: 'synthetic', token: async () => 'synthetic-provider' }]),
          carryTrial: options.carryTrial, openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`,
          requestOutcomeStore: { record: async () => {}, report: async () => ({ rows: [], total: 0,
            byOutcome: { ok: 0, 'client-error': 0, 'upstream-429': 0, 'upstream-error': 0,
              shed: 0, cancelled: 0, 'gateway-error': 0, unclassified: 0 },
            firstRequestTimestampMs: null, lastFinalizedAtMs: null, truncated: false, retentionMs: 0 }),
          providerSummary: async q => summarizeProviderOutcomeCounts(q.provider, { fromMs: q.fromMs, toMs: q.toMs ?? q.fromMs }, []) },
          requestAbsorbMs: 0, selfHeal: { enabled: false } });
        return { port: await gateway.listen(0), stop: () => gateway!.close() } as RunningGatewayService;
      });
      const privateRoute = JSON.parse(route!.envelopeEnv.PAPERCUSP_SCOPED_INFERENCE_GATEWAY!);
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const request = `/usr/bin/curl --silent --show-error --max-time 3 -o /dev/null -w '%{http_code}' ` +
        `-H ${quote(`Authorization: Bearer ${privateRoute.token}`)} -H 'Content-Type: application/json' ` +
        `--data '{"model":"gpt-6-sol","input":"synthetic"}' ${quote(`${privateRoute.baseURL}/v1/responses`)}`;
      const script = [
        'set -e',
        `test "$(${request})" = 200`,
        `test "$(${request})" = 403`,
        `if /usr/bin/curl --silent --fail --max-time 3 http://127.0.0.1:${upstreamPort}/v1/responses; then exit 41; fi`,
        `if /usr/bin/curl --silent --fail --max-time 3 --noproxy '*' ${quote(privateRoute.baseURL)}; then exit 42; fi`,
        `printf 'SUPPORT_BOUNDARY_VERIFIED' > ${quote(resultPath)}`,
      ].join('\n');
      const overrides = { 'model_providers.papercusp-codex-gateway.request_max_retries': 0,
        'model_providers.papercusp-codex-gateway.stream_max_retries': 0,
        'features.apps': false, 'features.hooks': false, web_search: 'disabled' };
      const args = mode === 'socket-boundary' ? ['-c', script] : [
        'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '-m', 'gpt-6-sol', ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
        'Return the local synthetic support receipt.',
      ];
      const env = hermeticEnv({ ...route!.envelopeEnv, PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
        PAPERCUSP_SID: `test-support-native-${root.split('/').at(-1)}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
        // The socket probe uses sh, so it must not receive Codex's automatic
        // `-c model_provider=...` argv prefix. The private SRT route stays set.
        PAPERCUSP_ACCOUNT_ROUTING_MODE: mode === 'socket-boundary' ? 'default' : route!.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE,
        PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operatorPort}` });
      // Preserve inherited source guards and passive diagnostics byte-for-byte.
      // Their original repository paths are deliberately unreadable inside SRT;
      // materialize these dependency-free preloads in the allowed fixture home.
      // No NODE_OPTIONS switch or source-verification guard is removed.
      const preloadDir = join(codexHome, 'fixture-preloads'); mkdirSync(preloadDir);
      for (const name of ['committed-source-loader.mjs', 'vitest-startup-trace.mjs']) {
        const original = fileURLToPath(new URL(`../../../../scripts/lib/${name}`, import.meta.url));
        const staged = join(preloadDir, name);
        writeFileSync(staged, readFileSync(original));
        env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').split(pathToFileURL(original).href)
          .join(pathToFileURL(staged).href).split(original).join(staged);
      }
      env.PAPERCUSP_COMMITTED_SOURCE_GIT = '/usr/bin/git';
      const launcher = fileURLToPath(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url));
      const fixture = join(root, 'launcher-fixture.mjs');
      writeFileSync(fixture, `import { runWrapper, applyScopedNativeGateway } from ${JSON.stringify(launcher)};\n` +
        `applyScopedNativeGateway(process.env);\nrunWrapper({wrapperBin:${JSON.stringify(mode === 'socket-boundary' ? '/bin/sh' : 'codex')},` +
        `args:${JSON.stringify(args)},cwd:${JSON.stringify(root)},preserveCwd:true,envelopeEnv:process.env,` +
        `reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
      child = spawn(process.execPath, [fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Support native fixture timed out: ${output.slice(-3000)}`)); }, 30_000);
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.once('close', value => { clearTimeout(timer); resolve(value); });
      });
      expect(code, output).toBe(0);
      expect(bodies, output).toHaveLength(1);
      expect(bodies[0].max_output_tokens).toBe(17);
      if (mode === 'socket-boundary') {
        expect(readFileSync(resultPath, 'utf8')).toBe('SUPPORT_BOUNDARY_VERIFIED');
        expect(admissions).toBe(2);
      } else expect(output).toContain('SUPPORT_NATIVE_RECEIPT');
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await route!?.stop(); await gateway?.close();
      await Promise.all([upstream, operator].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
