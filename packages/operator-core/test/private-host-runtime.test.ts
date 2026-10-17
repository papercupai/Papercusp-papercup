import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { buildPrivateOperatorApiBundle, preparePrivateOperatorApiBundle, privateBundleRuntimeEnv, privatePgStartupIdentity, waitForPrivateOperator } from './private-http-workspace-preflight';
import { createHash, randomUUID } from 'node:crypto';

const dirs: string[] = [];
const common = resolve(import.meta.dirname, '../../../apps/operator/bin/bundle-host-common.sh');
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function privateBudgetEnvironment() {
  const home = mkdtempSync(join(tmpdir(), 'private-budget-auth-'));
  dirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('PAPERCUSP_HOME', join(home, '.papercusp'));
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'test-runtime-budget-auth');
  vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '1');
  vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
  vi.stubEnv('PAPERCUSP_DBOS_ENABLE', '0');
  return home;
}

it('prepares a disposable native login for the budget bootstrap without changing the account route', async () => {
  const home = privateBudgetEnvironment();
  const { prepareCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  await prepareCodexBudgetScenario('test-runtime-budget-auth');
  const authPath = join(home, '.codex', 'auth.json');
  expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual({ auth_mode: 'chatgpt', tokens: {
    access_token: expect.stringMatching(/^private-budget-no-provider-/), account_id: 'private-budget' } });
  expect(statSync(authPath).mode & 0o777).toBe(0o600);
  expect(process.env.PAPERCUSP_WORKSPACE_ID).toBe('test-runtime-budget-auth');
});

it('refuses the budget scenario before touching auth outside its isolated runtime', async () => {
  const home = privateBudgetEnvironment();
  vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', undefined);
  const { measureCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  await expect(measureCodexBudgetScenario({ workspace: 'test-runtime-budget-auth',
    base: 'http://127.0.0.1:1', headers: {}, evidenceDir: home })).rejects.toThrow();
  expect(existsSync(join(home, '.codex'))).toBe(false);
});

it('refuses to overwrite an existing login in the budget fixture', async () => {
  const home = privateBudgetEnvironment();
  const { prepareCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  mkdirSync(join(home, '.codex'));
  const authPath = join(home, '.codex', 'auth.json');
  const original = JSON.stringify({ tokens: { access_token: randomUUID() } });
  writeFileSync(authPath, original, { mode: 0o600 });
  await expect(prepareCodexBudgetScenario('test-runtime-budget-auth')).rejects.toThrow(/EEXIST/);
  expect(readFileSync(authPath, 'utf8')).toBe(original);
});

function pgStartup(fields: Record<string, string>) {
  const body = Buffer.from(Object.entries(fields).flatMap(([key, value]) => [key, value]).join('\0') + '\0\0');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + body.length, 0);
  header.writeUInt32BE(196608, 4);
  return Buffer.concat([header, body]);
}

it('retains only the database and application identity from a private PG startup', () => {
  const packet = pgStartup({ user: 'private-user', database: 'other-private-db',
    application_name: 'pcusp:other-pool:p123', password: 'private-password', options: 'private-options' });
  expect(privatePgStartupIdentity(Buffer.concat([packet, Buffer.from('private query content')]))).toEqual({
    database: 'other-private-db', applicationName: 'pcusp:other-pool:p123' });
});

it('ignores SSL, cancellation and query packets in private socket evidence', () => {
  for (const code of [80877103, 80877102]) {
    const packet = Buffer.alloc(16);
    packet.writeUInt32BE(packet.length, 0);
    packet.writeUInt32BE(code, 4);
    expect(privatePgStartupIdentity(packet)).toBeNull();
  }
  expect(privatePgStartupIdentity(Buffer.from('Qprivate SQL text\0'))).toBeNull();
  expect(privatePgStartupIdentity('private text')).toBeNull();
});

it('rejects truncated, unterminated and oversized private startup packets', () => {
  const packet = pgStartup({ database: 'private-db', application_name: 'private-pool' });
  expect(privatePgStartupIdentity(packet.subarray(0, -1))).toBeNull();
  const malformed = Buffer.from(packet);
  malformed[malformed.length - 1] = 1;
  expect(privatePgStartupIdentity(malformed)).toBeNull();
  const oversized = pgStartup({ database: 'x'.repeat(16_384) });
  expect(privatePgStartupIdentity(oversized)).toBeNull();
});

it('does not retain unbounded or control-character startup identity values', () => {
  expect(privatePgStartupIdentity(pgStartup({ database: 'x'.repeat(129), application_name: 'line\nbreak' }))).toEqual({
    database: null, applicationName: null });
});

it('retires the roster worker auth listener before its shared database pools', () => {
  const file = 'roster-stop-http-fixture.ts';
  const source = ts.createSourceFile(file, readFileSync(join(import.meta.dirname, file), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const cleanup = source.statements.find((node): node is ts.TryStatement =>
    ts.isTryStatement(node) && Boolean(node.finallyBlock));
  expect(cleanup?.finallyBlock, 'worker cleanup must also run after a rejected browser assertion').toBeDefined();
  const phases: Array<{ name: string; body: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'cleanupPhase' && ts.isStringLiteral(node.arguments[0])) {
      expect(ts.isAwaitExpression(node.parent), 'worker cleanup must await owned resources').toBe(true);
      phases.push({ name: node.arguments[0].text, body: node.arguments[1].getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(cleanup!.finallyBlock!);
  const auth = phases.findIndex(phase => phase.name === 'auth-invalidation-listener-stop');
  const pools = phases.findIndex(phase => phase.name === 'db-org-pools-reset');
  expect(auth, 'lazy principal LISTEN must not keep the proof worker alive').toBeGreaterThanOrEqual(0);
  expect(pools, 'all db-org pools must retire after the listener stops').toBeGreaterThan(auth);
  expect(phases[auth].body).toContain('await _stopInvalidationListenerForTests()');
  expect(phases[pools].body).toContain('_resetForTests()');
  const census = phases.findIndex(phase => phase.name === 'database-census');
  const hub = phases.findIndex(phase => phase.name === 'listen-hub-stop');
  const closed = phases.findIndex(phase => phase.name === 'database-resources-closed');
  expect(census, 'capture actual pool labels before retiring query pools').toBeLessThan(pools);
  expect(hub, 'retain hub connection labels before closing subscriptions').toBeGreaterThan(census);
  expect(hub, 'collector LISTEN subscriptions must retire before the shared pools').toBeLessThan(pools);
  expect(phases[hub].body).toContain('await _stopHubForTests()');
  const lockListeners = phases.findIndex(phase => phase.body.includes('await _resetListenersForTests()'));
  const lockPools = phases.findIndex(phase => phase.body.includes('await resetLockPools()'));
  expect(lockListeners, 'acknowledgement opens locks listeners outside db-org').toBeGreaterThan(census);
  expect(lockPools, 'the separate su-lock-tx pool must retire after its listeners').toBeGreaterThan(lockListeners);
  expect(lockPools, 'locks teardown must precede retirement of the shared database pools').toBeLessThan(pools);
  expect(phases[lockListeners].body).toContain("import('@papercusp/locks')");
  expect(phases[lockPools].body).toContain('_resetForTests: resetLockPools');
  expect(closed, 'verify referenced private sockets after pool close callbacks').toBeGreaterThan(pools);
  expect(phases[closed].body).toContain('assert.equal(retained.length, 0');
});

it('keeps request fixtures on the bounded progress-aware builder path', () => {
  const callers: string[] = [];
  const routingProof = '../lib/blueprint/launch-blueprint-account-route.e2e.test.ts';
  const nativeProof = '../lib/external-bench/current-su-native.integration.test.ts';
  const preparationProofs = [routingProof, nativeProof];
  for (const file of [...readdirSync(import.meta.dirname).filter(name =>
    name.endsWith('-http-fixture.ts') || name === 'knowledge-native-fixture.ts'), ...preparationProofs]) {
    const source = ts.createSourceFile(file, readFileSync(join(import.meta.dirname, file), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(node.expression.text)) {
        expect(node.arguments.some(argument => argument.getText(source).includes('bundle-host.sh')),
          `${file} must use the shared builder instead of launching the build script directly`).toBe(false);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === 'buildPrivateOperatorApiBundle'
          || preparationProofs.includes(file) && node.expression.text === 'preparePrivateOperatorApiBundle')) {
        callers.push(file);
        expect(ts.isAwaitExpression(node.parent), `${file} must await build completion`).toBe(true);
        let policy: ts.Expression | undefined = node.arguments[2];
        if (preparationProofs.includes(file) && policy && ts.isObjectLiteralExpression(policy))
          policy = policy.properties.find((property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === 'builder')?.initializer;
        expect(policy && ts.isObjectLiteralExpression(policy), `${file} needs a bounded progress policy`).toBe(true);
        if (policy && ts.isObjectLiteralExpression(policy)) {
          const values = Object.fromEntries(policy.properties.flatMap(property =>
            ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.initializer)
              ? [[property.name.getText(source), Number(property.initializer.text)]] : []));
          expect(values.timeoutMs, `${file} must retain the existing stall checkpoint`).toBe(240_000);
          expect(values.maxMs, `${file} must retain the existing absolute ceiling`).toBe(420_000);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(callers.sort()).toEqual([routingProof, nativeProof, 'blog-post-http-fixture.ts', 'consult-cascade-http-fixture.ts', 'cupboard-listing-install-http-fixture.ts',
    'governance-http-fixture.ts', 'integrations-setup-http-fixture.ts', 'knowledge-native-fixture.ts', 'liveness-alarm-http-fixture.ts',
    'roster-stop-http-fixture.ts', 'staging-first-http-fixture.ts']);
});

it('prepares every roster API bundle before the private execute phase', () => {
  const file = join(import.meta.dirname, '../lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let contracts = 0;
  let cleanupProofs = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'recordIsolatedIntegrationProof') {
      const contract = node.arguments[0];
      if (contract && ts.isObjectLiteralExpression(contract)) {
        const properties = Object.fromEntries(contract.properties.flatMap(property =>
          ts.isPropertyAssignment(property) ? [[property.name.getText(source), property.initializer]] : []));
        if (properties.sourcePaths?.getText(source).includes('roster-stop-http-fixture.ts')) {
          if (properties.execute?.getText(source).includes("'--health-cleanup-proof'")) {
            // This original worker path only seeds readers and exits through
            // cleanup; it never starts an API or needs an API bundle.
            expect(properties.prepare).toBeUndefined();
            cleanupProofs++;
            return;
          }
          contracts++;
          const line = source.getLineAndCharacterOfPosition(contract.getStart(source)).line + 1;
          const context = `roster proof at line ${line}`;
          let preparationCalls = 0;
          const inspectPreparation = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)
              && child.expression.text === 'preparePrivateOperatorApiBundle') {
              preparationCalls++;
              expect(ts.isAwaitExpression(child.parent), `${context} must await progress-aware preparation`).toBe(true);
              const policy = child.arguments[2];
              const builder = policy && ts.isObjectLiteralExpression(policy)
                ? policy.properties.find((property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) && property.name.getText(source) === 'builder')?.initializer : undefined;
              expect(builder && ts.isObjectLiteralExpression(builder), `${context} needs a bounded progress policy`).toBe(true);
              if (builder && ts.isObjectLiteralExpression(builder)) {
                const values = Object.fromEntries(builder.properties.flatMap(property =>
                  ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.initializer)
                    ? [[property.name.getText(source), Number(property.initializer.text)]] : []));
                expect(values.timeoutMs, `${context} must retain the existing stall checkpoint`).toBe(240_000);
                expect(values.maxMs, `${context} must retain the existing absolute ceiling`).toBe(420_000);
              }
            }
            ts.forEachChild(child, inspectPreparation);
          };
          if (properties.prepare) inspectPreparation(properties.prepare);
          expect(preparationCalls, `${context} must compile before private allocation`).toBe(1);
          for (const path of ['apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'])
            expect(properties.sourcePaths.getText(source), `${context} must pin its preparation source`).toContain(path);
          const inspectExecution = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'fork'
              && child.getText(source).includes('roster-stop-http-fixture.ts')) {
              const argv = child.arguments[1];
              expect(argv && ts.isArrayLiteralExpression(argv), `${context} must declare worker arguments`).toBe(true);
              if (argv && ts.isArrayLiteralExpression(argv)) expect(argv.elements.some(argument =>
                ts.isBinaryExpression(argument) && ts.isStringLiteral(argument.left)
                  && argument.left.text === '--prepared-api-sha='), `${context} must consume the prepared bundle`).toBe(true);
            }
            ts.forEachChild(child, inspectExecution);
          };
          if (properties.execute) inspectExecution(properties.execute);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(contracts).toBe(18);
  expect(cleanupProofs).toBe(1);
});

it('stops builder descendants on timeout and retains the original diagnostics', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  let descendant: number | undefined;
  try {
    expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
      args: ['-c', 'source "$2"; BUNDLE_HOST_STEP_LOG="$3"; bundle_host_run_step blocked-builder bash -c \'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait\' _ "$1"',
        '_', childFile, common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
      timeoutMs: 1000 })).toThrow(/ETIMEDOUT/);
    descendant = Number(readFileSync(childFile, 'utf8'));
    expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
    const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
    expect(receipt).toMatchObject({ signal: 'SIGKILL', status: null, error: { code: 'ETIMEDOUT' }, groupStop: 'signaled' });
    expect(receipt.steps).toMatchObject({ active: 'blocked-builder', count: 1, unreadableRows: [],
      last: { step: 'blocked-builder', event: 'start', pid: expect.any(Number), at: expect.any(Number) } });
    await expect.poll(() => {
      try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
    }).toMatch(/^(?:gone|Z|X)$/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

it('retains completed step timing and the failing command status', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step cli-guard bash -c "exit 17"',
      '_', common, journal], timeoutMs: 1000 })).toThrow(/exited 17/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ status: 17, steps: { active: null, count: 2, unreadableRows: [],
    durationsMs: [{ step: 'cli-guard', status: 17, elapsedMs: expect.any(Number) }] } });
  expect(receipt.steps.durationsMs[0].elapsedMs).toBeGreaterThanOrEqual(0);
});

it('preserves the timeout when the final journal append is partial', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'),
    JSON.stringify({ at: 1, pid: 1, step: 'syntax-check', event: 'start' }) + '\n{"at":');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'sleep 60'], timeoutMs: 100 })).toThrow(/ETIMEDOUT/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ error: { code: 'ETIMEDOUT' }, steps: { active: 'syntax-check', unreadableRows: [2] } });
});

it('allows a progressing real build beyond its checkpoint and retains its bounded success', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const result = await buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; for step in a b c d e; do bundle_host_run_step "$step" sleep .25; done; echo bundle > "$3"',
      '_', common, journal, join(evidenceDir, 'hono-host.mjs')], timeoutMs: 600, maxMs: 2400, pollMs: 20 });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ status: 0, signal: null, progress: { extensions: expect.any(Number) } });
  expect(receipt.elapsedMs).toBeGreaterThan(600);
  expect(receipt.progress.extensions).toBeGreaterThan(0);
  expect(receipt.elapsedMs).toBeLessThan(2400);
});

it('prepares the real bundle receipt after progress renews the build checkpoint', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-prepared-builder-')); dirs.push(evidenceDir);
  const bundle = join(evidenceDir, 'hono-host.mjs');
  const result = await preparePrivateOperatorApiBundle(evidenceDir, evidenceDir, { builder: {
    command: 'bash', args: ['-c',
      'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; for step in a b c d e; do bundle_host_run_step "$step" sleep .25; done; echo bundle > "$3"',
      '_', common, `${bundle}.build-steps.jsonl`, bundle], timeoutMs: 600, maxMs: 2400, pollMs: 20,
  } });
  const retained = readFileSync(join(evidenceDir, 'operator-api-preflight.json'));
  expect(JSON.parse(String(retained))).toEqual({ path: bundle, sha256: result.sha256 });
  expect(result.receiptSha256).toBe(createHash('sha256').update(retained).digest('hex'));
  expect(result.sha256).toBe(createHash('sha256').update(readFileSync(bundle)).digest('hex'));
  const build = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(build.elapsedMs).toBeGreaterThan(600);
  expect(build.progress.extensions).toBeGreaterThan(0);
  expect(build.status).toBe(0);
});

it('reports only distinct completed build steps to the enclosing watchdog', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-progress-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const completed: Array<{ step: string; completedSteps: number }> = [];
  await buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', `source "$1"; BUNDLE_HOST_STEP_LOG="$2";
      bundle_host_run_step first true;
      bundle_host_run_step first true;
      (bundle_host_run_step first true);
      bundle_host_run_step failed false;
      printf '{"at":%s,"pid":%s,"step":"unpaired","event":"end","status":0}\n' "$(date +%s.%N)" "$$" >> "$2";
      bundle_host_run_step last true;
      printf '{"at":' >> "$2";
      echo bundle > "$3"`, '_', common, journal, join(evidenceDir, 'hono-host.mjs')],
    timeoutMs: 600, maxMs: 2400, pollMs: 20,
    onProgress: progress => completed.push(progress),
  });
  expect(completed).toEqual([{ step: 'first', completedSteps: 1 }, { step: 'last', completedSteps: 2 }]);
});

it('withholds a prepared receipt when the progress builder stalls', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-prepared-stall-')); dirs.push(evidenceDir);
  await expect(preparePrivateOperatorApiBundle(evidenceDir, evidenceDir, { builder: {
    command: 'bash', args: ['-c', 'sleep 60'], timeoutMs: 600, maxMs: 2400, pollMs: 20,
  } })).rejects.toThrow(/ETIMEDOUT.*progress-unknown/);
  expect(readdirSync(evidenceDir)).not.toContain('operator-api-preflight.json');
  const build = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(build.watchdog).toMatchObject({ reason: 'progress-unknown', completedSteps: 0, extensions: 0 });
});

it.each(['logs', 'repeated-step', 'repeated-step-new-pid', 'incomplete-step'])('does not renew a stalled build for %s', async noise => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const command = noise === 'logs' ? 'echo STILL_ALIVE'
    : noise === 'repeated-step' ? 'bundle_host_run_step same true'
    : noise === 'repeated-step-new-pid' ? '(bundle_host_run_step same true)'
    : 'printf \'{"at":\' >> "$BUNDLE_HOST_STEP_LOG"';
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', `source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step same true; while true; do ${command}; sleep .08; done`,
      '_', common, journal], timeoutMs: 600, maxMs: 2400, pollMs: 20 })).rejects.toThrow(/ETIMEDOUT.*progress-stalled/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ error: { code: 'ETIMEDOUT' }, watchdog: { completedSteps: 1, reason: 'progress-stalled' } });
  expect(receipt.elapsedMs).toBeLessThan(2400);
});

it('stops the entire async builder group when no completed progress exists', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$2"; BUNDLE_HOST_STEP_LOG="$3"; bundle_host_run_step stuck bash -c \'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait\' _ "$1"',
      '_', childFile, common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
    timeoutMs: 600, maxMs: 2400, pollMs: 20 })).rejects.toThrow(/ETIMEDOUT.*progress-unknown/);
  const descendant = Number(readFileSync(childFile, 'utf8'));
  await expect.poll(() => {
    try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
  }).toMatch(/^(?:gone|Z|X)$/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.watchdog).toMatchObject({ reason: 'progress-unknown', completedSteps: 0, extensions: 0 });
  expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
});

it('enforces the absolute build ceiling despite distinct successful step progress', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; i=0; while true; do i=$((i+1)); bundle_host_run_step "step-$i" sleep .08; done',
      '_', common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
    timeoutMs: 600, maxMs: 1200, pollMs: 20 })).rejects.toThrow(/ETIMEDOUT.*absolute-ceiling/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.watchdog).toMatchObject({ reason: 'absolute-ceiling' });
  // Timers may fire just before their requested deadline and schedule one
  // additional remainder. The contract is the absolute stop, not callback count.
  expect(receipt.watchdog.extensions).toBeGreaterThan(0);
  expect(receipt.elapsedMs).toBeGreaterThanOrEqual(1200);
  expect(receipt.elapsedMs).toBeLessThan(2400);
  expect(receipt.watchdog.completedSteps).toBeGreaterThan(1);
});

it('retains and rejects an async builder launch failure without waiting for the ceiling', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, {
    command: join(evidenceDir, 'missing-builder'), args: [], timeoutMs: 600, maxMs: 2400,
  })).rejects.toMatchObject({ code: 'ENOENT' });
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.error).toMatchObject({ code: 'ENOENT' });
  expect(receipt.progress).toEqual({ extensions: 0, completedSteps: 0 });
});

it.each(['--import=tsx', '--import "tsx"', '--loader=tsx/esm', '--require tsx/cjs',
  '--import="file:///repo/node_modules/tsx/dist/loader.mjs"'])('removes %s and preserves guarded plain Node options', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${guard} ${preload} --max-old-space-size=4096 --trace-warnings`,
    OTHER: 'keep', PAPERCUSP_HARNESS_DIR: '/repo/libs/papercusp/packages/harness' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env,
    NODE_OPTIONS: `${guard} --max-old-space-size=4096 --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it.each(['--import=/repo/scripts/lib/vitest-startup-trace.mjs',
  '--import "file:///repo%20with%20spaces/scripts/lib/vitest-startup-trace.mjs"',
  '--require=/repo/scripts/lib/vitest-startup-trace.mjs'])('removes test-owned startup trace %s while retaining source guards', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${preload} ${guard} --trace-warnings`, OTHER: 'keep' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env, NODE_OPTIONS: `${guard} --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it('preserves unrelated loaders and similarly named imports', () => {
  const env = { NODE_OPTIONS: '--import=/repo/tsx-observer.mjs --loader=other-loader --require ./guard.cjs'
    + ' --import=/repo/other/vitest-startup-trace.mjs --import=/repo/scripts/lib/vitest-startup-trace.mjs-extra' };
  expect(privateBundleRuntimeEnv(env)).toEqual(env);
});

it('boots a real confined Node descendant after removing the inaccessible test tracer and keeps its source guard', () => {
  const traceRoot = mkdtempSync(join(tmpdir(), 'private-hidden-trace-')); dirs.push(traceRoot);
  const guardRoot = mkdtempSync(join(tmpdir(), 'private-visible-guard-')); dirs.push(guardRoot);
  mkdirSync(join(traceRoot, 'scripts/lib'), { recursive: true });
  const trace = join(traceRoot, 'scripts/lib/vitest-startup-trace.mjs');
  const guard = join(guardRoot, 'committed-source-loader.mjs');
  writeFileSync(trace, 'globalThis.privateTraceLoaded = true;');
  writeFileSync(guard, 'globalThis.privateGuardLoaded = true;');
  const env = { ...process.env,
    NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(trace).href)} --import=${JSON.stringify(pathToFileURL(guard).href)} --trace-warnings` };
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--ro-bind', guardRoot, guardRoot, '--tmpfs', traceRoot, '--', process.execPath, '-e',
    'console.log(JSON.stringify({guard:globalThis.privateGuardLoaded,trace:globalThis.privateTraceLoaded??false}))'];
  const failed = spawnSync('bwrap', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(failed.error).toBeUndefined();
  expect(failed.status, failed.stderr).toBe(1);
  expect(failed.stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(failed.stderr).toContain('vitest-startup-trace.mjs');
  const launched = spawnSync('bwrap', args, { env: privateBundleRuntimeEnv(env),
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(launched.error).toBeUndefined();
  expect(launched.status, launched.stderr).toBe(0);
  expect(JSON.parse(launched.stdout)).toEqual({ guard: true, trace: false });
});

it.each(['signal', 'exit'] as const)('persists readiness evidence when the real child terminates by %s', async kind => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const child = spawn(process.execPath, ['-e', kind === 'signal'
    ? 'process.kill(process.pid,"SIGTERM")' : 'process.exit(17)'], { env: privateBundleRuntimeEnv(process.env) });
  await once(child, 'close');
  await expect(waitForPrivateOperator({ host: child, base: 'http://127.0.0.1:1', evidenceDir,
    environment: { MALLOC_ARENA_MAX: '2' }, timeoutMs: 1000 })).rejects.toThrow(/before readiness/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'));
  expect(receipt).toMatchObject({ attempts: 0, mallocArenaMax: '2', failure: expect.stringContaining('before readiness'),
    exitCode: kind === 'exit' ? 17 : null, signalCode: kind === 'signal' ? 'SIGTERM' : null });
});

it('retains the successful health probe and actual launch options', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const server = createServer((_, response) => response.end(JSON.stringify({ service: 'papercusp-operator' })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: privateBundleRuntimeEnv(process.env) });
  const environment = privateBundleRuntimeEnv({ NODE_OPTIONS: '--import=tsx --trace-warnings' });
  try {
    const address = server.address() as { port: number };
    await expect(waitForPrivateOperator({ host: child, base: `http://127.0.0.1:${address.port}`, evidenceDir,
      environment, timeoutMs: 1000 })).resolves.toEqual({ service: 'papercusp-operator' });
    expect(JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'))).toMatchObject({
      attempts: 1, nodeOptions: '--trace-warnings', probes: [{ status: 200, service: 'papercusp-operator', elapsedMs: expect.any(Number) }] });
  } finally {
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    server.close(); await once(server, 'close');
  }
});
