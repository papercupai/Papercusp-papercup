/** Installed-client tool census at the real request boundary; no paid inference. */
import { execFileSync, fork, spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { CODEX_MANAGED_DISPATCHER_APPROVAL_TOML, codexGatewayConfigToml,
  codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import type { CapabilityPolicyRequest, CapabilityPolicySurface } from '@papercusp/orchestrator/managed-capability-policy';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  codexManagedToolsNativeIntegrationSourcePaths, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../..');
const filePath = 'packages/operator-core/lib/codex-managed-tools.native.integration.test.ts';
const workerGroupSuffix = ':codex-managed-surface-worker';
const isWorker = process.env.PAPERCUSP_TEST_RUN_GROUP?.endsWith(workerGroupSuffix);

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const privateMcpUrl = process.env.CODEX_MANAGED_PRIVATE_MCP_URL;
const managedTool = 'tools_invoke';
const nestedSurfaceMarker = 'CODEX_NESTED_TOOL_SURFACE';
const managedCallMarker = 'MANAGED_SURFACE_CALL_CONFIRMED';

function spawnCensusProcess(command: string, args: string[], options: SpawnOptions) {
  const child = spawn(command, args, {
    ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
  });
  // The npm launcher can exit while a plugin-fetch child still owns stderr and
  // writes to CODEX_HOME. Retain close from spawn time, including error paths.
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  return { child, closed };
}

async function stopCensusProcess({ child, closed }: ReturnType<typeof spawnCensusProcess>) {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  } else {
    child.kill('SIGKILL');
  }
  await closed;
}

async function captureSurface(features: Record<string, boolean>, captureNested = true, model = 'gpt-6.1-sol',
  capabilityPolicy?: Omit<CapabilityPolicyRequest, 'client'>, lifecycle = false, preauthorizeDispatcher = true,
  additionalMcpTools = 0) {
  const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
  if (!codex) throw new Error('Installed Codex is required for native-tool removal evidence');
  const catalogJson = execFileSync(codex, ['debug', 'models'], { encoding: 'utf8', timeout: 5000 });
  const catalog = JSON.parse(catalogJson);
  const selectedModel = catalog.models.find((entry: { slug: string }) => entry.slug === model);
  expect(selectedModel, `Installed catalog must contain ${model}`).toBeDefined();
  const measuredModel = selectedModel.slug;
  const home = mkdtempSync(join(tmpdir(), 'codex-managed-surface-'));
  const catalogPath = join(home, 'installed-models.json');
  writeFileSync(catalogPath, catalogJson);
  const surfaces: CapabilityPolicySurface[] = lifecycle ? ['launch', 'resume', 'wake'] : ['launch'];
  let surfaceIndex = 0;
  let captures: Record<string, unknown>[] = [];
  const managedCalls = new Map<CapabilityPolicySurface, number>();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
      res.end(catalogJson);
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/mcp') {
        if (privateMcpUrl) throw new Error('Production MCP proof must not use the local canary');
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        if (body.method === 'tools/call') {
          expect(body.params.name).toBe('tools:invoke');
          const surface = surfaces[surfaceIndex]!;
          managedCalls.set(surface, (managedCalls.get(surface) ?? 0) + 1);
        }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'managed-surface', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'tools:invoke', description: 'Offline managed dispatcher canary.',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
              ...Array.from({ length: additionalMcpTools }, (_, index) => ({
                name: `production_catalog_padding_${index}`, description: 'Unrelated MCP catalog entry.',
                inputSchema: { type: 'object', properties: {} },
              }))] }
            : body.method === 'tools/call'
              ? { content: [{ type: 'text', text: managedCallMarker }] }
              : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (req.url?.includes('/responses')) {
        captures.push(body);
        if (captureNested) {
          const first = captures.length === 1;
          const item = first
            ? { id: 'nested_surface_call', type: 'custom_tool_call', namespace: 'functions', name: 'exec',
              call_id: `call_nested_surface_${surfaces[surfaceIndex]}`, status: 'completed', input:
                `const managed = ALL_TOOLS.find(tool => tool.name.includes(${JSON.stringify(managedTool)}));
                if (!managed) throw new Error('Managed dispatcher absent from installed client catalog');
                const reply = await tools[managed.name](${privateMcpUrl
                  ? JSON.stringify({ name: 'capability:bash', args: {
                    command: `printf '${managedCallMarker}'`, cwd: home, timeout: 10000, yield_after_ms: 10000 } })
                  : '{}'});
                ${privateMcpUrl ? `
                const result = reply.structuredContent ?? reply.content?.filter(row => row.type === 'text')
                  .map(row => { try { return JSON.parse(row.text); } catch { return null; } })
                  .find(row => row && typeof row.exit_code === 'number');
                if (reply.isError || result?.ok !== true || result.exit_code !== 0 ||
                    result.output !== ${JSON.stringify(managedCallMarker)})
                  throw new Error('Production capability:bash failed: ' + JSON.stringify(reply));
                ` : ''}
                // Keep every native name, including unknown native residue. Only
                // unrelated MCP rows are filtered, with explicit accounting.
                const native = ALL_TOOLS.filter(tool => !tool.name.startsWith('mcp__'));
                const selected = [...native, managed];
                text({ marker: ${JSON.stringify(nestedSurfaceMarker)}, managedReply: reply,
                  productionBashVerified: ${Boolean(privateMcpUrl)},
                  catalog: { total: ALL_TOOLS.length, native: native.length,
                    omittedMcp: ALL_TOOLS.length - selected.length },
                  tools: selected.map(tool => ({ name: tool.name, callable: typeof tools[tool.name] })) });` }
            : { id: 'nested_surface_done', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'Census complete.', annotations: [] }] };
          const response = { id: `surface_response_${captures.length}`, object: 'response', created_at: 1,
            status: 'completed', model: measuredModel, output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response },
          ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          res.end();
          return;
        }
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"invalid_request_error","message":"Offline tool census complete; no forwarding."}}');
    } catch (error) {
      res.writeHead(400); res.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_surface_token_'.repeat(3) } });
  const writeConfig = (surface: CapabilityPolicySurface) => writeFileSync(join(home, 'config.toml'), [
    `model = ${JSON.stringify(measuredModel)}`, `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'approval_policy = "never"',
    ...gateway.root, ...gateway.tables,
    ...(capabilityPolicy ? codexManagedFeaturesToml({ capabilityPolicy: { ...capabilityPolicy, surface },
      disableMemories: false, headless: true }) : ['[features]']),
    ...Object.entries(features).map(([key, value]) => `${key} = ${value}`),
    '[mcp_servers.managed_surface]', `url = ${JSON.stringify(privateMcpUrl ?? `${baseURL}/mcp`)}`, 'required = true',
    ...(privateMcpUrl ? ['bearer_token_env_var = "CODEX_MANAGED_PRIVATE_MCP_TOKEN"'] : []),
    'startup_timeout_sec = 10', 'tool_timeout_sec = 10',
    ...(preauthorizeDispatcher ? CODEX_MANAGED_DISPATCHER_APPROVAL_TOML : []),
  ].join('\n'));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' };
  delete env.CODEX_API_KEY;
  delete env.PAPERCUSP_SCOPED_INFERENCE_GATEWAY;
  const observations = [];
  try {
    for (surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) {
      const surface = surfaces[surfaceIndex]!;
      captures = [];
      writeConfig(surface);
      let stderr = '';
      const prompt = `Offline ${surface} tool census: reply OK.`;
      const args = surface === 'launch'
        ? ['--no-daemon', 'exec', '--skip-git-repo-check', ...(!lifecycle ? ['--ephemeral'] : []), '--json', '-C', home, prompt]
        : ['--no-daemon', 'exec', 'resume', '--last', '--skip-git-repo-check', '--json', prompt];
      const census = spawnCensusProcess(codex, args, { env, cwd: home });
      const { child } = census;
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Tool census timed out: ${stderr}`)); }, 25_000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        expect(captures.length, stderr).toBeGreaterThan(0);
        const request = captures[0]!;
        if (surfaceIndex > 0) {
          // A fresh process must load this same session's preceding turn, rather
          // than silently creating a new session with the same config.
          expect(JSON.stringify(request.input)).toContain(`Offline ${surfaces[surfaceIndex - 1]} tool census`);
        }
        const names: string[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(walk); return; }
          if (!value || typeof value !== 'object') return;
          const row = value as Record<string, unknown>;
          if (typeof row.name === 'string') names.push(row.name);
          Object.values(row).forEach(walk);
        };
        walk(request.tools);
        const nestedTools: { name: string; callable: string }[] = [];
        let nestedCatalog: { total: number; native: number; omittedMcp: number } | undefined;
        let productionBashReplies = 0;
        const readNested = (value: unknown): void => {
          if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
            try { readNested(JSON.parse(value)); } catch { /* Other output strings are not the census. */ }
            return;
          }
          if (Array.isArray(value)) { value.forEach(readNested); return; }
          if (!value || typeof value !== 'object') return;
          const row = value as Record<string, unknown>;
          if (row.marker === nestedSurfaceMarker && Array.isArray(row.tools)) {
            nestedTools.push(...row.tools as { name: string; callable: string }[]);
            nestedCatalog = row.catalog as typeof nestedCatalog;
            if (row.productionBashVerified === true) productionBashReplies++;
            return;
          }
          Object.values(row).forEach(readNested);
        };
        // Read the tool's output returned by the real client, never the injected call
        // or a copy of the expected names. The next provider request carries it.
        for (const captured of captures.slice(1)) {
          for (const item of Array.isArray(captured.input) ? captured.input : []) {
            if (item.type === 'custom_tool_call_output' && item.call_id === `call_nested_surface_${surface}`) {
              const evidenceDir = process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR;
              if (privateMcpUrl && evidenceDir) {
                appendFileSync(join(evidenceDir, 'census', 'managed-tool-replies.ndjson'), JSON.stringify({
                  surface, features, callId: item.call_id, output: item.output,
                }) + '\n', { mode: 0o600 });
              }
              readNested(item.output);
              const toolOutput = JSON.stringify(item.output);
              expect(toolOutput, 'Census evidence must survive native exec output capture')
                .not.toContain('Warning: truncated output');
              expect(toolOutput, `Managed execution reply for ${surface}: ${toolOutput.slice(0, 6000)}`)
                .toContain(managedCallMarker);
            }
          }
        }
        if (captureNested) {
          if (privateMcpUrl) {
            expect(productionBashReplies, 'successful production dispatcher reply is required').toBe(1);
            managedCalls.set(surface, productionBashReplies);
          }
          expect(nestedTools, `No code-mode census output; advertised tools: ${names.join(', ')}; ${stderr}`).not.toHaveLength(0);
          expect(nestedCatalog).toBeDefined();
          expect(nestedCatalog!.total).toBe(nestedTools.length + nestedCatalog!.omittedMcp);
          expect(nestedCatalog!.native).toBe(nestedTools.filter(tool => !tool.name.startsWith('mcp__')).length);
          expect(nestedCatalog!.omittedMcp).toBeGreaterThanOrEqual(additionalMcpTools);
          expect(nestedTools.every(tool => tool.callable === 'function')).toBe(true);
          expect(nestedTools.some(tool => tool.name.includes(managedTool))).toBe(true);
          expect(managedCalls.get(surface)).toBe(1);
        }
        expect(JSON.stringify({ request, nestedTools }), `Advertised tools: ${names.join(', ')}; ${stderr}`).toContain(managedTool);
        observations.push({ surface, managedCalls: managedCalls.get(surface) ?? 0,
          managedPath: privateMcpUrl ? 'production-capability-bash' : 'local-canary',
          version: execFileSync(codex, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), names,
          requestKeys: Object.keys(request), executedOuterNames: captureNested ? ['exec'] : [],
          catalog: { source: 'installed-codex-debug-models', sha256: createHash('sha256').update(catalogJson).digest('hex'),
            model: selectedModel.slug, toolMode: selectedModel.tool_mode ?? 'direct',
            applyPatchToolType: selectedModel.apply_patch_tool_type },
          nestedNames: nestedTools.map(tool => tool.name),
          nestedCatalog,
          hasNativeExecution: [...names, ...nestedTools.map(tool => tool.name)]
            .some(name => name === 'exec_command' || name === 'write_stdin') });
      } finally {
        await stopCensusProcess(census);
      }
    }
    return { ...observations[0]!, lifecycle: observations };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

if (isWorker) {
describe('Codex managed replacement installed-client census', () => {
  it('uses admitted production config to remove native shell while preserving callable MCP', async ({ task }) => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const observedVersion = execFileSync(wellKnownBackendBin('codex') ?? resolveOnPath('codex')!,
      ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().match(/\d+\.\d+\.\d+/)?.[0];
    const policy: Omit<CapabilityPolicyRequest, 'client'> = {
      surface: 'launch', clientVersions: { codex: observedVersion! },
      readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
      cutoverStaging: { 'shell-ssh-interpreters': 'full' },
      adoption: [{ client: 'codex', family: 'shell-ssh-interpreters',
        managedPathProven: true, nativeBypassRefused: true, atClientVersion: observedVersion }],
      matrix: [{ client: 'codex', family: 'shell-ssh-interpreters',
        allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
    };
    const features = { code_mode: true, code_mode_host: true };
    const retained = await captureSurface(features, true, 'gpt-6.1-sol', { ...policy, cutoverStaging: {} });
    const removed = await captureSurface(features, true, 'gpt-6.1-sol', policy, true);
    const drift = await captureSurface(features, true, 'gpt-6.1-sol', { ...policy,
      clientVersions: { codex: 'unvalidated-client-version' } });
    task.meta.nativeToolSurface = { retained, removed, drift };
    expect(retained.nestedNames).toContain('exec_command');
    expect(removed.nestedNames).not.toContain('exec_command');
    expect(removed.nestedNames).not.toContain('write_stdin');
    expect(removed.lifecycle.map(row => row.surface)).toEqual(['launch', 'resume', 'wake']);
    for (const row of removed.lifecycle) {
      expect(row.nestedNames).not.toContain('exec_command');
      expect(row.nestedNames).not.toContain('write_stdin');
      expect(row.managedCalls).toBe(1);
    }
    expect(drift.nestedNames).toContain('exec_command');
    console.info('CODEX_ADMITTED_LIFECYCLE ' + JSON.stringify({ retained, removed, drift }));
    // captureSurface also verifies that the actual inner MCP catalog is callable.
  }, 180_000);

  it.runIf(process.platform !== 'win32')('stops a home writer that outlives its client before cleanup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-census-lifecycle-'));
    const marker = join(home, 'writer');
    const writer = `const fs = require('node:fs');
      const write = () => { fs.mkdirSync(${JSON.stringify(home)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(marker)}, 'active'); };
      write(); setInterval(write, 1); process.send('ready'); process.disconnect();`;
    const parent = `const { spawn } = require('node:child_process');
      const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      writer.once('message', () => process.exit(0));`;
    const census = spawnCensusProcess(process.execPath, ['-e', parent], { cwd: home });
    let closed = false;
    void census.closed.then(() => { closed = true; });
    try {
      await once(census.child, 'exit');
      expect(existsSync(marker)).toBe(true);
      expect(closed, 'descendant still holds the client stderr after parent exit').toBe(false);
      await stopCensusProcess(census);
      expect(closed).toBe(true);
      rmSync(home, { recursive: true, force: true });
      expect(existsSync(home)).toBe(false);
    } finally {
      await stopCensusProcess(census);
      rmSync(home, { recursive: true, force: true });
    }
  }, 5000);

  it('records the outer code-mode surface and the actual callable inner catalog', async ({ task }) => {
    const codeMode = await captureSurface({ code_mode: true, code_mode_host: true }, true, 'gpt-6.1-sol');
    const codeModeRestricted = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false }, true, 'gpt-6.1-sol');
    task.meta.nativeToolSurface = { codeMode, codeModeRestricted };
    const managedOnly = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false,
      view_image: false, sleep_tool: false, computer_use: false, browser_use: false,
      multi_agent: false, goals: false, image_generation: false });
    const inventory = nativeToolInventory({ client: 'codex', clientVersion: codeMode.version,
      nativeNames: [...codeMode.names, ...codeMode.executedOuterNames, ...codeMode.nestedNames]
        .filter(name => name !== 'multi_agent_v1'),
      managedNames: [managedTool] });
    task.meta.nativeToolSurface = { codeMode, codeModeRestricted, managedOnly, inventory };
    expect(codeMode.nestedNames).toContain('exec_command');
    expect(codeMode.nestedNames).toContain('apply_patch');
    expect(codeModeRestricted.nestedNames).not.toContain('exec_command');
    expect(codeModeRestricted.nestedNames).not.toContain('write_stdin');
    expect(codeMode.hasNativeExecution).toBe(true);
    expect(codeModeRestricted.hasNativeExecution).toBe(false);
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift' ||
      row.gap === 'native-parity-unverified')).toBe(true);
    expect(inventory.rows.find(row => row.nativeName === 'clock__curr_time')).toMatchObject({
      family: null, disposition: 'unsupported-gap', gap: 'native-parity-unverified', cutoverReady: false,
    });
    expect(codeMode.nestedNames).not.toEqual(managedOnly.nestedNames);
    expect(managedOnly.names).not.toContain('exec_command');
    expect(managedOnly.names).not.toContain('write_stdin');
    expect(managedOnly.nestedNames).not.toContain('exec_command');
    expect(managedOnly.nestedNames).not.toContain('write_stdin');
  }, 60_000);
  it('measures native shell removal while retaining the managed MCP surface', async ({ task }) => {
    const baseline = await captureSurface({ code_mode: true, code_mode_host: true });
    const restricted = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false });
    console.info('CODEX_MANAGED_TOOL_SURFACE', JSON.stringify({ baseline, restricted }));
    task.meta.nativeToolSurface = { baseline, restricted };
    expect(baseline.nestedNames).toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('write_stdin');
  }, 60_000);

  it('records remaining native tools after the measured feature switches are disabled', async ({ task }) => {
    const features = { code_mode: true, code_mode_host: true, shell_tool: false, view_image: false,
      sleep_tool: false, computer_use: false, browser_use: false, multi_agent: false,
      goals: false, image_generation: false };
    const restricted = await captureSurface(features);
    task.meta.nativeToolSurface = { features, restricted };
    // Keep the observed residue in the ledger: disabling flags is not proof
    // that an unrelated native tool disappeared.
    expect(restricted.nestedNames).not.toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('write_stdin');
    expect(restricted.nestedNames).not.toContain('view_image');
    expect(restricted.nestedNames).not.toContain('sleep');
  }, 30_000);
});
} else {
  // The private integration worker can spend several minutes in a nested
  // source/dependency verification phase that reports progress server-side;
  // this parent only observes the final worker output. The verifier owns its
  // measured-progress watchdog, so allow a bounded 12-minute outer silence window.
  const workerOptions = isolatedTestFileWorkerOptions(process.env, 1,
    { executeStallWindowMs: 12 * 60_000 }, 'runtime');
  it('retains the installed Codex removal, resume, wake and drift controls with their original runtime', async context => {
    let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
    const runId = await recordIsolatedIntegrationProof({ root, filePath,
      sourcePaths: [...codexManagedToolsNativeIntegrationSourcePaths],
      retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/census/worker.log',
        'phases/execute/census/managed-tool-replies.ndjson',
        'phases/execute/profile-progress.ndjson',
        'phases/prepare/dispatcher-approval-preflight.json',
        'phases/execute/native-tool-surface.json', 'phases/execute/operator-mcp-receipt.json'],
      prepare: async evidenceDir => {
        // Audit the approval failure before allocating/building the full runtime.
        // The prior read-only canary could not detect the production dispatcher's
        // destructive/open-world approval class. Both controls use installed Codex.
        const features = { code_mode: true, code_mode_host: true, shell_tool: false };
        await expect(captureSurface(features, true, 'gpt-6.1-sol', undefined, false, false))
          .rejects.toThrow('MCP tool call requires approval, but approval policy is never');
        // Exercise a production-sized catalog through installed Codex before
        // paying for the private API build/PG runtime. The former ALL_TOOLS dump
        // exceeded native exec's output budget and hid successful bash replies.
        const approved = await captureSurface(features, true, 'gpt-6.1-sol', undefined, false, true, 2000);
        await writeFile(join(evidenceDir, 'dispatcher-approval-preflight.json'), JSON.stringify({
          blockedWithoutPreauthorization: true, approved,
        }) + '\n', { mode: 0o600 });
        const censusPath = join(evidenceDir, 'restricted-hold-census.json');
        await writeFile(censusPath, '[]\n', { mode: 0o600 });
        prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
          builder: { timeoutMs: 240_000, maxMs: 420_000,
            env: { ...process.env, VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: censusPath } },
        });
      },
      execute: async (observe, evidenceDir) => {
        expect(prepared, 'Prepared current-build API is required before private PG allocation').toBeDefined();
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const profileProgressPath = join(evidenceDir, 'profile-progress.ndjson');
        await writeFile(profileProgressPath, '', { mode: 0o600 });
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_SCENARIO: 'codex-managed-tools', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          PAPERCUSP_ISOLATED_PROGRESS_FILE: profileProgressPath,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        // The outer reporter owns the canonical sink. The inner router runs
        // against its disposable database and retains its own native output.
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL', 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath,
          '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
          '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256,
        ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, workerOptions); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        const line = result.output.split('\n').find(row => row.startsWith('CODEX_ADMITTED_LIFECYCLE '));
        if (line) await writeFile(join(evidenceDir, 'native-tool-surface.json'),
          line.slice('CODEX_ADMITTED_LIFECYCLE '.length) + '\n', { flag: 'wx' });
        expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({
          code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
        expect(result.output).toContain('skippedTests=0');
        expect(result.output).toMatch(/Tests\s+5 passed \(5\)/);
        expect(line, 'original installed-client lifecycle observations are required').toBeDefined();
        expect(result.output).toContain('CODEX_PRODUCTION_MCP_VERIFIED');
        const measured = JSON.parse(line!.slice('CODEX_ADMITTED_LIFECYCLE '.length));
        expect(measured.removed.lifecycle.map((row: { surface: string }) => row.surface))
          .toEqual(['launch', 'resume', 'wake']);
        for (const row of measured.removed.lifecycle) {
          expect(row.managedPath).toBe('production-capability-bash');
          expect(row.managedCalls).toBe(1);
          expect(row.hasNativeExecution).toBe(false);
        }
        expect(measured.retained.hasNativeExecution).toBe(true);
        expect(measured.drift.hasNativeExecution).toBe(true);
        const progressRows = (await readFile(profileProgressPath, 'utf8')).trim().split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as { kind: string; stage?: string });
        const profileStages = new Set(progressRows.filter(row => row.kind === 'profile-progress').map(row => row.stage));
        expect(profileStages).toEqual(expect.arrayContaining([
          'private-registry:save:read-start', 'private-registry:save:write-start',
          'private-registry:save:audit-start', 'private-registry:save:notification-start',
          'private-registry:fresh-load-start', 'private-registry:fresh-load-complete',
        ]));
        expect(progressRows.some(row => row.kind === 'cleanup' && row.stage === 'complete')).toBe(true);
        expect(progressRows.some(row => row.kind === 'profile-timeout')).toBe(false);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_CODEX_MANAGED_SURFACE_PROOF_RUN ' + runId);
  }, workerOptions.testTimeoutMs);
}
