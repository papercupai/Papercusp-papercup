import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  RESOURCE_GOVERNOR_INVENTORY,
  BYPASS_REGISTRY,
  P016_DISPOSITION_REGISTRY,
  RESOURCE_GOVERNOR_SCANNER_PATH,
  type ResourceGovernorInventoryRow,
  inspectGovernorSource,
  scanActiveInventory,
  scanInventory,
  validateInventory,
} from '../../../../scripts/check-resource-governor-enforcement.mjs';
import { listTrackedFiles } from '../../../../scripts/lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('resource governor enforcement lint', () => {
  it('seeds every subsystem lane and gives each one complete, reviewable writer evidence', () => {
    expect(RESOURCE_GOVERNOR_INVENTORY.map((row) => row.id)).toEqual([
      'agent-process-memory',
      'mcp-http-operator-transport',
      'inference-embedding-provider-batching',
      'database-sidecar-checkpoint-dbos',
      'p2p-sync-index-cache-compaction',
      'ci-release-test-workers',
      'background-routines-watchdogs',
      'governor-core',
    ]);
    expect(validateInventory()).toEqual([]);
    expect(RESOURCE_GOVERNOR_INVENTORY.find((row) => row.id === 'mcp-http-operator-transport')?.enforcement).toBe(
      'active',
    );
  });

  it('rejects a resource start outside Governor.admit or a valid lease', () => {
    expect(inspectGovernorSource(`import { spawn } from 'node:child_process'; spawn('x', []);`)).toContain(
      'resource-start-outside-admission',
    );
    expect(
      inspectGovernorSource(
        `await governor.admit(input); const context: AdmissionContext = input.context; await governor.release(context); spawn('x', []);`,
      ),
    ).not.toContain('resource-start-outside-admission');
  });

  it('recognizes the canonical durable execution lifecycle at a process boundary', () => {
    expect(
      inspectGovernorSource(
        `const execution = await beginGovernedExecution(request, owner, runtime); const child = spawn('tsc', []); await execution.finish();`,
      ),
    ).not.toContain('resource-start-outside-admission');
  });

  it('detects called aliases bound to child-process starts without widening arbitrary names', () => {
    expect(
      inspectGovernorSource(`const spawnImpl = spawn; spawnImpl('agent-wrapper', [], { detached: true });`),
    ).toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(`const exec = promisify(execFile); await exec('git', ['rev-parse', 'HEAD']);`),
    ).toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(
        `const spawnImpl = spawn; await beginGovernedExecution(request, owner, runtime); spawnImpl('agent-wrapper', []);`,
      ),
    ).not.toContain('resource-start-outside-admission');
    expect(inspectGovernorSource(`const spawnRowKind = new Map(); spawnRowKind.set('x', 1);`)).not.toContain(
      'resource-start-outside-admission',
    );
  });

  it('detects inline promisified starts and pins the checkpoint liveness bypass', () => {
    const inline = "await promisify(execFile)('systemctl', ['--user', 'is-active', unit], { timeout: 5_000 });";
    expect(inspectGovernorSource(inline)).toContain('resource-start-outside-admission');

    const path = 'packages/operator-core/lib/release/checkpoint-qualification-transaction.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const key = path + '::resource-start-outside-admission';
    const entry = BYPASS_REGISTRY.get(key);
    expect(inspectGovernorSource(source)).toContain('resource-start-outside-admission');
    expect(entry?.disposition).toBe('bypass');
    expect(entry?.matchesSource?.(source)).toBe(true);
    expect(scanInventory([[path, source]], { migrations: ['P-016'], validateRegistry: true })).toEqual([]);

    const addedStart = source + "\nspawn('unreviewed', []);";
    expect(scanInventory([[path, addedStart]], { migrations: ['P-016'], validateRegistry: true })).toContain(
      path + ':resource-start-outside-admission',
    );
  });

  it('does not count a caller-supplied callback named for a start verb as a start', () => {
    // A pacing/retry wrapper takes the operation as a callback and starts nothing
    // itself; the real child process is started by the caller it wraps, at a site
    // this same scan covers. Counting it here reports one start twice and pins it
    // on the file that does not make it.
    expect(
      inspectGovernorSource(
        `export async function withAgentSpawnPacing<T>(spawn: () => Promise<T>): Promise<T> { return await spawn(); }`,
      ),
    ).not.toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(`const runner = { execFile: (): Promise<void> => done() }; await runner.execFile();`),
    ).not.toContain('resource-start-outside-admission');
  });

  it('does not treat record-proxy request-limit admit as governor admission or a resource start', () => {
    const path = 'scripts/agent-capacity/record-proxy.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    expect(source).toContain('opts.requestLimit?.admit(');
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(scanInventory([[path, source]])).toEqual([]);
  });

  it('detects called lazy promisify wrappers and preserves their reviewed start dispositions', () => {
    const wrapper = `
      let memo;
      const invoke = ((...args: unknown[]) =>
        Reflect.apply((memo ??= promisify(execFile)), undefined, args));
    `;
    expect(inspectGovernorSource(wrapper)).not.toContain('resource-start-outside-admission');
    expect(inspectGovernorSource(wrapper + "\nawait invoke('git', []);")).toContain('resource-start-outside-admission');
    expect(inspectGovernorSource(wrapper.replace('execFile', 'readFile') + "\nawait invoke('a');")).not.toContain('resource-start-outside-admission');
    for (const path of [
      'apps/operator/lib/release/desktop-perf-gate.ts',
      'packages/operator-core/lib/sync/pot-git/physical-drill-preflight.ts',
      'packages/operator-core/lib/harness/routines/dead-citation-sweep-action.ts',
      'packages/operator-core/lib/harness/routines/dead-target-probe.ts',
      'packages/operator-core/lib/release/sync-batch-delta-check-deps.ts',
    ]) {
      const source = readFileSync(ROOT + path, 'utf8');
      expect(inspectGovernorSource(source), path).toContain('resource-start-outside-admission');
      expect(BYPASS_REGISTRY.has(`${path}::resource-start-outside-admission`), path).toBe(true);
      expect(scanInventory([[path, source]], { validateRegistry: true }), path).toEqual([]);
    }
  });

  it('still flags a real start in a file that also has a same-named callback parameter', () => {
    // The anti-launder case: the callback narrowing must not become a way to hide a
    // genuine child-process start behind a decoy parameter of the same name.
    expect(
      inspectGovernorSource(
        `import { spawn } from 'node:child_process'; function paced(spawn: () => void) { spawn(); } spawn('agent-wrapper', [], { detached: true });`,
      ),
    ).toContain('resource-start-outside-admission');
    // ...and a bare start with no local binding at all is untouched by the narrowing.
    expect(inspectGovernorSource(`spawn('agent-wrapper', [], { detached: true });`)).toContain(
      'resource-start-outside-admission',
    );
  });

  it('does not treat prose inside strings as executable resource-control code', () => {
    expect(inspectGovernorSource(`const guidance = 'waited for a semaphore slot';`)).toEqual([]);
    expect(inspectGovernorSource(`const guidance = 'call spawn(worker) next';`)).toEqual([]);
  });

  it.each([
    ['static capacity defaults', `const maxConcurrent = 4;`, 'hidden-or-static-capacity'],
    ['hidden semaphores', `const gate = new Semaphore(4);`, 'hidden-or-static-capacity'],
    ['resident queues', `pendingQueue.push(work);`, 'unbounded-resident-queue'],
    [
      'receipt retries',
      `await acquireWithContentionRetry(() => this.store.enqueue(candidate), { backoffsMs });`,
      'retry-around-receipt',
    ],
    ['missing lineage/release', `await governor.admit(input);`, 'missing-admission-context-or-release'],
    ['dishonest metrics', `const age = oldestAgeMs ?? 0;`, 'undefined-partial-or-stale-metric-coerced-to-zero'],
  ])('rejects %s', (_name, source, expected) => {
    expect(inspectGovernorSource(source)).toContain(expected);
  });

  it('requires a retry callback around the receipt-producing operation', () => {
    const declarationOnly = `
      type Options = {
        admissionRetryBackoffsMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
        onActualDemand?: (input: { readonly receiptId: string }) => void;
      };
    `;
    expect(inspectGovernorSource(declarationOnly)).not.toContain('retry-around-receipt');
    expect(
      inspectGovernorSource(`await retry(async () => { await receiptStore.enqueue(candidate); });`),
    ).toContain('retry-around-receipt');
    expect(inspectGovernorSource(`await retry(async () => { await performWork(); }, { receiptId });`)).not.toContain(
      'retry-around-receipt',
    );
  });

  it('matches the real queue retry site and not its adjacent option declarations', () => {
    const queueSource = readFileSync(ROOT + 'packages/operator-core/lib/resource-governor/queue.ts', 'utf8');
    const declarationStart = queueSource.indexOf('private readonly onActualDemand:');
    const admitStart = queueSource.indexOf('async admit(');
    const retryStart = queueSource.indexOf('stored = await acquireWithContentionRetry(');
    const retryEnd = queueSource.indexOf('    } catch (error)', retryStart);
    expect(declarationStart).toBeGreaterThanOrEqual(0);
    expect(admitStart).toBeGreaterThan(declarationStart);
    expect(retryStart).toBeGreaterThan(admitStart);
    expect(retryEnd).toBeGreaterThan(retryStart);
    expect(inspectGovernorSource(queueSource.slice(declarationStart, admitStart))).not.toContain(
      'retry-around-receipt',
    );
    expect(inspectGovernorSource(queueSource.slice(retryStart, retryEnd))).toContain(
      'retry-around-receipt',
    );
  });

  it('requires durable evidence to name the resident queue receiver', () => {
    const queueWithUnrelatedReceipt =
      "function recordReceipt() {\n const receipt = persistResult();\n}\nconst pendingQueue = new Map();\npendingQueue.set(job.id, job);";
    expect(inspectGovernorSource(queueWithUnrelatedReceipt)).toContain('unbounded-resident-queue');
    expect(inspectGovernorSource('work_items.pendingQueue.set(job.id, job);')).not.toContain(
      'unbounded-resident-queue',
    );
  });

  it('does not treat pending diagnostic IDs as a resident queue', () => {
    expect(
      inspectGovernorSource(
        `const pendingGradingAuditTargetIds = new Set<string>(); pendingGradingAuditTargetIds.add(issueId);`,
      ),
    ).not.toContain('unbounded-resident-queue');
  });

  it('dispositions the persisted result memo without hiding a new work queue or lost persistence', () => {
    const path = 'packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:unbounded-resident-queue`;
    expect(scanInventory([[path, source]])).not.toContain(finding);
    expect(scanInventory([[path, source + '\npendingQueue.push(work);']])).toContain(finding);
    expect(scanInventory([[path, source + '\npending.set(job.id, job);']])).toContain(finding);
    expect(scanInventory([[path, source.replace('await store.save(', 'await forget(')]])).toContain(finding);
  });

  it('bounds the bench provenance exception to its sole Git read', () => {
    const path = 'packages/operator-core/lib/search/bench/chunk-search-ab-cli.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(scanInventory([[path, source]])).not.toContain(finding);
    expect(scanInventory([[path, source + "\nspawn('resident-worker', []);"]])).toContain(finding);
    expect(scanInventory([[path, source.replace('timeout: 30_000', 'timeout: undefined')]])).toContain(finding);
    expect(scanInventory([[path, source.replace("execFileSync('git'", "execFileSync('worker'")]])).toContain(finding);
  });

  it('counts benchmark RegExp.exec parsing separately from its awaited child exec', () => {
    for (const path of ['scripts/bench-work-item-continuations.ts', 'scripts/bench-work-items-get.ts']) {
      const source = readFileSync(ROOT + path, 'utf8');
      const key = `${path}::resource-start-outside-admission`;
      const entry = BYPASS_REGISTRY.get(key);
      const finding = `${path}:resource-start-outside-admission`;
      expect(entry?.matchesSource, path).toBeTypeOf('function');
      expect(entry?.matchesSource?.(source), path).toBe(true);
      expect(scanInventory([[path, source]], { migrations: ['P-016'] })).not.toContain(finding);
      for (const mutant of [
        source.replace('timeout: 35_000', 'timeout: undefined'),
        source + "\nspawn('unreviewed-worker', []);",
      ]) {
        expect(mutant).not.toBe(source);
        expect(entry?.matchesSource?.(mutant), path).toBe(false);
        expect(scanInventory([[path, mutant]], { migrations: ['P-016'] })).toContain(finding);
      }
    }
  });

  it('keeps the isolated hosted-test module child joined and forcibly stoppable', () => {
    const path = 'packages/operator-core/lib/llm-testing/isolated-hosted-test-user.mts';
    const source = readFileSync(ROOT + path, 'utf8');
    const key = `${path}::resource-start-outside-admission`;
    const finding = `${path}:resource-start-outside-admission`;
    const entry = BYPASS_REGISTRY.get(key);
    expect(entry?.matchesSource?.(source)).toBe(true);
    const mutant = source.replace("child.kill('SIGTERM');", 'child.disconnect();');
    expect(mutant).not.toBe(source);
    expect(entry?.matchesSource?.(mutant)).toBe(false);
    expect(scanInventory([[path, mutant]])).toContain(finding);
  });

  it('keeps finite native diagnostic dispositions scoped to their reviewed starts and lifecycle', () => {
    const heapPath = 'scripts/analyze-heap-snapshots.mjs';
    const heap = readFileSync(ROOT + heapPath, 'utf8');
    const nativePath = 'packages/operator-core/lib/memory/bench/fixtures/native-ort-teardown-control.mjs';
    const native = readFileSync(ROOT + nativePath, 'utf8');
    for (const [path, source] of [[heapPath, heap], [nativePath, native]]) {
      const finding = `${path}:resource-start-outside-admission`;
      expect(scanInventory([[path, source]])).not.toContain(finding);
      expect(scanInventory([[path, source + "\nspawn('resident-worker', []);"]])).toContain(finding);
    }
    expect(BYPASS_REGISTRY.has(`${heapPath}::resource-start-outside-admission`)).toBe(false);
    expect(inspectGovernorSource(heap)).not.toContain('resource-start-outside-admission');
    expect(scanInventory([[nativePath, native.replace('await worker.terminate()', 'await ignoreWorker()')]])).toContain(`${nativePath}:resource-start-outside-admission`);
    expect(scanInventory([[nativePath, native.replace('71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10', 'other-graph')]])).toContain(`${nativePath}:resource-start-outside-admission`);
  });

  it('bounds the Reports native verifier disposition to isolated awaited helpers', () => {
    const path = 'scripts/tauri-surface-verify-reports.mts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(scanInventory([[path, source]])).not.toContain(finding);
    expect(P016_DISPOSITION_REGISTRY.get(`${path}::resource-start-outside-admission`)?.reason)
      .toContain('EI-25357092317407008');
    for (const unsafe of [
      source.replace('PAPERCUSP_VERIFY_TAURI_ISOLATED', 'UNVERIFIED_ISOLATION'),
      source.replace('assert.ok(pid && workspace && process.env.VERIFY_TAURI_POLL', 'assert.ok(true'),
      source.replace('timeout: 60_000', 'timeout: undefined'),
      source.replace('timeout: 90_000', 'timeout: undefined'),
      source.replace('timeout: 300_000', 'timeout: undefined'),
      source.replace('maxBuffer: 4 * 1024 * 1024', 'maxBuffer: undefined'),
      source.replace('const env = nativeChildEnvironment(profile);', 'const env = process.env;'),
      source.replace('env.PAPERCUSP_VERIFY_TAURI_ISOLATED', 'env.UNVERIFIED_ISOLATION'),
      source.replace('profile.tauriPID === Number(env.VERIFY_TAURI_PID)', 'true'),
      source.replace('const testEnv = nativeTestDatabaseEnvironment(profile);', 'const testEnv = process.env;'),
      source.replace('PAPERCUSP_TEST_RUN_COMMIT: receipt.sourceCommit', "PAPERCUSP_TEST_RUN_COMMIT: 'unchecked'"),
      source.replace('recordedDataDir === dataDir && port === address.port', 'true'),
      source.replace("command[command.indexOf('-D') + 1] === dataDir", 'true'),
      source.replace('env.PAPERCUSP_SKIP_PG_DISCOVERY', 'env.UNVERIFIED_PG_DISCOVERY'),
      source.replace("execFile(process.execPath, [bundle, ...args]", "execFile('resident-worker', [bundle, ...args]"),
      source.replace("assert.ok(prepared, 'Native child must be bundled", "assert.ok(true, 'Native child must be bundled"),
      source.replace("digest('hex'), prepared.sha256,", "digest('hex'), 'unchecked',"),
      source.replace("join(sourceRoot, 'apps/operator/bin/bundle-host.sh')", "join(sourceRoot, 'apps/operator/bin/resident-worker.sh')"),
      source.replace("timeout: 300_000, env: testEnv", "timeout: undefined, env: testEnv"),
      source.replace("timeout: 60_000, env: nativeLedgerEnvironment()", "timeout: 60_000, env: process.env"),
      source.replace("new Set(nativeScripts).size === nativeScripts.length", 'true'),
      source.replace("receipt.files.some((entry: { path: string }) => entry.path === script)", 'true'),
      source.replace('if (!error) { resolve({ stdout, stderr }); return; }', 'resolve({ stdout, stderr }); return;'),
      source.replace('execFileSync(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN', 'spawn(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN'),
      source + "\nspawn('resident-worker', [], { detached: true });",
      source + "\nconst launch = spawn; launch('resident-worker', []);",
      source + "\nnew Worker('resident-worker');",
      // WI-10007542: the third start is only the committed test:file run (governed by
      // runGovernedTestProcess); retargeting it, or dropping either phase's isolation
      // assert, must re-flag the file. bfaf34ee moved the call from lint:as-committed to a
      // direct `npm run test:file`, so the mutation targets that literal call shape.
      source.replace("execFileSync('npm', ['run', 'test:file', '--', ...testFiles],", "execFileSync('npm', ['run', 'test:affected', '--', ...testFiles],"),
      source.replace(/assert\.equal\(process\.env\.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Fixture publication/, "assert.ok(true, 'Fixture publication"),
    ]) expect(scanInventory([[path, unsafe]])).toContain(finding);
  });

  it('pins the Documenso readiness diagnostic without widening the sandbox lifecycle disposition', () => {
    const path = 'scripts/with-documenso-sandbox.mjs';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(scanInventory([[path, source]])).not.toContain(finding);
    for (const unsafe of [
      source.replace("timeout: 5000, maxBuffer: 100_000", "timeout: undefined, maxBuffer: 100_000"),
      source.replace('attempts = 31, isStopped', 'attempts = Infinity, isStopped'),
      source.replace('  for (let attempt = 0; ; attempt++) {\n    if (isStopped()) return;',
        '  for (let attempt = 0; ; attempt++) {'),
      source.replace('secrets: [databasePassword], isStopped: () => stopped', 'secrets: [], isStopped: () => stopped'),
      source.replace('for (let attempt = 0; ; attempt++)', 'for (let attempt = 0; attempt < attempts; attempt++)'),
      source.replace('stalledAttempts = observedStage > startupStage ? 1 : stalledAttempts + 1;', 'stalledAttempts += 1;'),
      source.replace('if (terminal || stalledAttempts >= attempts)', 'if (terminal)'),
      source.replace("socket.write('label=papercusp.test.owner=' + owner + '\\n')", "socket.write('label=all\\n')"),
      source.replace("'--pull=missing', '--name', name", "'--pull=always', '--name', name"),
      source.replace('if (containers.length || networkCreated) {', 'if (false) {'),
      source.replace("try { await runPhase('cleanup', cleanup); }", 'try { await ignoreCleanup(); }'),
      source.replace("  run = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 }),",
        "  run = args => spawnSync('docker', args, { encoding: 'utf8', timeout: undefined, maxBuffer: 100_000 }),"),
      source.replace('const exitCode = await waitForSandboxChild(child, { runtime });', 'const exitCode = 0;'),
      source.replace("[runtime.container, runtime.network + '-pg', runtime.network + '-mail']", '[runtime.container]'),
      source.replace("if (['exited', 'dead'].includes(containers[0].status))", 'if (true)'),
      source.replace("run(['logs', '--tail', '200', runtime.container])", "run(['logs', runtime.container])"),
      source.replace("signals: sandboxProviderFailureSignals((result.stdout || '') + (result.stderr || ''))",
        "signals: result.stdout"),
      source + "\nspawnSync('unreviewed-worker', []);",
    ]) {
      expect(unsafe).not.toBe(source);
      expect(scanInventory([[path, unsafe]])).toContain(finding);
    }
  });

  it('bounds terminal diagnostics and the DAO verifier to their reviewed finite starts', () => {
    const terminalPath = 'apps/operator/scripts/psu-terminal-diagnostics.mjs';
    const terminal = readFileSync(ROOT + terminalPath, 'utf8');
    const daoPath = 'scripts/tauri-surface-verify-dao-workbench.mts';
    const dao = readFileSync(ROOT + daoPath, 'utf8');
    for (const [path, source] of [[terminalPath, terminal], [daoPath, dao]]) {
      const finding = `${path}:resource-start-outside-admission`;
      expect(scanInventory([[path, source]])).not.toContain(finding);
      expect(scanInventory([[path, source + "\nspawn('resident-worker', []);"]])).toContain(finding);
    }
    const terminalFinding = `${terminalPath}:resource-start-outside-admission`;
    expect(scanInventory([[terminalPath, terminal.replace('}, 750)', '}, 0)')]])).toContain(terminalFinding);
    expect(scanInventory([[terminalPath, terminal.replace("spawnCommand('stty'", "spawnCommand('worker'")]])).toContain(terminalFinding);
    expect(scanInventory([[terminalPath, terminal + "\nspawnCommand('worker', []);"]])).toContain(terminalFinding);
    const daoFinding = `${daoPath}:resource-start-outside-admission`;
    expect(scanInventory([[daoPath, dao.replace('timeout: 65_000', 'timeout: undefined')]])).toContain(daoFinding);
    expect(scanInventory([[daoPath, dao.replace('PAPERCUSP_VERIFY_TAURI_ISOLATED', 'UNSCOPED_RUNTIME')]])).toContain(daoFinding);
  });

  it('does not treat the per-use funding admission method as a resource start', () => {
    const path = 'packages/operator-core/lib/agent-tools/per-use-chokepoint.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(BYPASS_REGISTRY.has(`${path}::resource-start-outside-admission`)).toBe(false);
    expect(scanInventory([[path, source]])).not.toContain(finding);
    for (const unsafe of [
      source + "\nspawn('resident-worker', []);",
      source + "\nconst launch = execFile; launch('git', []);",
      source + "\nnew Worker('resident-worker');",
    ]) expect(scanInventory([[path, unsafe]])).toContain(finding);
  });

  it('allows physical upstream constraints only when the writer carries explicit evidence', () => {
    // Annotated so `disposition` keeps its literal type: an un-annotated array literal
    // widens it to `string`, which stopped satisfying ResourceGovernorInventoryRow once
    // that field became a union.
    const rows: readonly Partial<ResourceGovernorInventoryRow>[] = [
      { ...RESOURCE_GOVERNOR_INVENTORY[0], id: 'provider-limit', disposition: 'upstream', writerEvidence: '' },
    ];
    expect(validateInventory(rows)).toContain('inventory-writer-evidence:provider-limit');
    expect(
      validateInventory([{ ...rows[0], writerEvidence: 'provider contract constraint evidence required at writer' }]),
    ).toEqual([]);
  });

  it('runs the active enforcement lane over the real tracked tree', () => {
    const { files } = listTrackedFiles(ROOT);
    const sourceFiles: Array<[string, string]> = [];
    for (const path of files) {
      if (!path.startsWith('packages/operator-core/lib/resource-governor/') || /\.(?:test|spec)\./.test(path)) continue;
      sourceFiles.push([path, readFileSync(`${ROOT}${path}`, 'utf8')]);
    }
    expect(sourceFiles.length).toBeGreaterThan(5);
    expect(scanActiveInventory(sourceFiles)).toEqual([]);
  });

  it('keeps the PSU operator-down systemd probe exact and once per launcher', () => {
    const diagnosisPath = 'apps/operator/scripts/psu-operator-down-diagnosis.mjs';
    const diagnosis = readFileSync(ROOT + diagnosisPath, 'utf8');
    const diagnosisFinding = `${diagnosisPath}:resource-start-outside-admission`;
    const disposition = BYPASS_REGISTRY.get(`${diagnosisPath}::resource-start-outside-admission`);
    expect(disposition?.disposition).toBe('bypass');
    expect(disposition?.matchesSource?.(diagnosis)).toBe(true);
    expect(
      scanInventory([[diagnosisPath, diagnosis + "\nspawnSync('worker', []);"]], { migrations: ['P-013'] }),
    ).toContain(diagnosisFinding);
    for (const unbounded of [
      diagnosis.replace('const SYSTEMCTL_TIMEOUT_MS = 3_000;', 'const SYSTEMCTL_TIMEOUT_MS = undefined;'),
      diagnosis.replace('timeout: SYSTEMCTL_TIMEOUT_MS', 'timeout: undefined'),
    ]) {
      expect(scanInventory([[diagnosisPath, unbounded]], { migrations: ['P-013'] })).toContain(
        diagnosisFinding,
      );
    }

    const launcher = readFileSync(ROOT + 'apps/operator/scripts/psu-launcher.mjs', 'utf8');
    expect(launcher).toMatch(/let\s+slowRequestNoticeShown\s*=\s*false/);
    expect(launcher).toMatch(/if\s*\(slowRequestNoticeShown\)\s*return\s+null/);
    expect(launcher).toMatch(/slowRequestNoticeShown\s*=\s*true/);
    expect(launcher.match(/\bslowOperatorNotice\s*\(/g)).toHaveLength(1);
  });

  it('keeps the GOAL-report Tauri recorder inside its isolated, bounded P-016 disposition', () => {
    const path = 'scripts/tauri-surface-verify-goal-report.mts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = path + ':resource-start-outside-admission';
    const disposition = P016_DISPOSITION_REGISTRY.get(path + '::resource-start-outside-admission');
    expect(disposition?.disposition).toBe('bypass');
    expect(disposition?.reason).toMatch(/^P-016 reviewed bypass disposition/);
    expect(disposition?.matchesSource?.(source)).toBe(true);
    expect(scanInventory([[path, source]], { migrations: ['P-016'] })).toEqual([]);
    expect(
      scanInventory([[path, source + "\nspawn('extra-worker', []);"]], { migrations: ['P-016'] }),
    ).toContain(finding);
    expect(
      scanInventory([[path, source.replace("recording.kill('SIGINT');", '')]], { migrations: ['P-016'] }),
    ).toContain(finding);
    expect(
      scanInventory([[path, source.replace("recording!.kill('SIGKILL');", '')]], { migrations: ['P-016'] }),
    ).toContain(finding);
    expect(
      scanInventory([[path, source.replace('}, 10_000).unref()', '}, 10_000)')]], { migrations: ['P-016'] }),
    ).toContain(finding);
  });

  it('dispositions only the synchronous, deduplicated admission import traversal', () => {
    const path = 'packages/operator-core/lib/release/admission-import-completeness.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = path + ':unbounded-resident-queue';
    const entry = P016_DISPOSITION_REGISTRY.get(path + '::unbounded-resident-queue');
    expect(inspectGovernorSource(source)).toContain('unbounded-resident-queue');
    expect(entry?.disposition).toBe('semantic');
    expect(entry?.matchesSource?.(source)).toBe(true);
    expect(scanInventory([[path, source]], { migrations: ['P-016'] })).toEqual([]);
    for (const unsafe of [
      source.replace('if (visited.has(key)) continue;', ''),
      source.replace('visited.add(key);', ''),
      source.replace('pending.shift()', 'pending[0]'),
      source.replace('sourceByPath.has(candidate)', 'true'),
      source + '\nconst workQueue = []; workQueue.push(task);',
      source + '\nasync function enqueue() { pending.push(task); }',
    ]) {
      expect(scanInventory([[path, unsafe]], { migrations: ['P-016'] })).toContain(finding);
    }
    expect(scanInventory([['packages/operator-core/lib/release/other-import-probe.ts', source]], { migrations: ['P-016'] })).toContain(
      'packages/operator-core/lib/release/other-import-probe.ts:unbounded-resident-queue',
    );
  });

  it.each([false, true])('awaits and clears the real recorder teardown (requires SIGKILL: %s)', async (requiresKill) => {
    const source = readFileSync(ROOT + 'scripts/tauri-surface-verify-goal-report.mts', 'utf8');
    const cleanup = source.slice(source.indexOf('let recording:'), source.indexOf('// A textContent match'));
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const child = { kill: vi.fn((signal: string) => {
      if (!requiresKill || signal === 'SIGKILL') resolveExit(0);
      return true;
    }) };
    vi.useFakeTimers();
    try {
      // Run the actual driver cleanup without starting a display, recorder or DB.
      const driver = runInNewContext(stripTypeScriptTypes(cleanup +
        '\nrecording = child; recordingExit = exited; ({ stopRecording, state: () => ({ recording, recordingExit }) });'),
      { child, exited, setTimeout, clearTimeout });
      let finished = false;
      const stopping = driver.stopRecording().then(() => { finished = true; });
      expect(child.kill).toHaveBeenCalledWith('SIGINT');
      if (requiresKill) {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(finished).toBe(false);
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
      await stopping;
      expect(driver.state()).toEqual({ recording: undefined, recordingExit: undefined });
      expect(vi.getTimerCount()).toBe(0);
      await driver.stopRecording();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(child.kill).toHaveBeenCalledTimes(requiresKill ? 2 : 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires an explicit reviewed disposition for every active P-016 finding and excludes only scanner self-code', () => {
    const { files } = listTrackedFiles(ROOT);
    const p016Rows = RESOURCE_GOVERNOR_INVENTORY.filter((row) => row.migration === 'P-016');
    const p016Files: Array<[string, string]> = [];
    for (const path of files) {
      if (!/\.(?:ts|tsx|mts|mjs)$/.test(path) || /\.(?:test|spec)\./.test(path) || path.includes('/_retired/'))
        continue;
      if (!p016Rows.some((row) => row.paths.some((prefix) => path.startsWith(prefix)))) continue;
      p016Files.push([path, readFileSync(`${ROOT}${path}`, 'utf8')]);
    }
    const observed = new Set<string>();
    for (const [path, source] of p016Files) {
      if (path === RESOURCE_GOVERNOR_SCANNER_PATH) continue;
      for (const code of inspectGovernorSource(source)) observed.add(`${path}::${code}`);
    }
    expect(observed.size).toBeGreaterThan(100);
    expect(P016_DISPOSITION_REGISTRY.size).toBe(observed.size);
    expect(new Set([...P016_DISPOSITION_REGISTRY.values()].map((entry) => entry.reason)).size).toBe(
      P016_DISPOSITION_REGISTRY.size,
    );
    for (const key of observed) {
      const entry = P016_DISPOSITION_REGISTRY.get(key);
      expect(entry).toBeDefined();
      expect(['bypass', 'semantic', 'upstream']).toContain(entry?.disposition);
      expect(entry?.reason).toMatch(/P-016 reviewed/);
      expect(BYPASS_REGISTRY.has(key)).toBe(true);
    }
    expect(
      scanInventory([[RESOURCE_GOVERNOR_SCANNER_PATH, `if (receipt.state === 'queued') retryAgain();`]], {
        migrations: ['P-016'],
      }),
    ).toEqual([]);
    expect(
      scanInventory([['packages/operator-core/lib/p2p/new-unreviewed.ts', `spawn('worker', []);`]], {
        migrations: ['P-016'],
      }),
    ).toEqual(['packages/operator-core/lib/p2p/new-unreviewed.ts:resource-start-outside-admission']);
  }, 60_000);

  it('pins newly reviewed P-016 and bypass entries to the current source shape', () => {
    const startPins: Array<[string, string, boolean]> = [
      ['packages/operator-core/lib/harness/routines/operator-e2e-isolated-action.ts', 'resource-start-outside-admission', true],
      ['packages/operator-core/lib/llm-testing/isolated-hosted-test-user.mts', 'resource-start-outside-admission', false],
      ['packages/operator-core/lib/release/staging-fix-proposal-cli.ts', 'resource-start-outside-admission', true],
      ['packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts', 'resource-start-outside-admission', true],
      ['packages/operator-core/lib/system-health/claude-update-canary.ts', 'resource-start-outside-admission', true],
      ['scripts/e2e-fixture-affected.mjs', 'resource-start-outside-admission', true],
      ['scripts/gen-asana-openapi-subset.mjs', 'resource-start-outside-admission', true],
      ['scripts/gen-graph-dependency-snapshot.mjs', 'resource-start-outside-admission', true],
      ['scripts/remeasure-callers.ts', 'resource-start-outside-admission', true],
      ['scripts/review-cloud-tutorial-native.mjs', 'resource-start-outside-admission', true],
      ['scripts/reviewer-operator-assert.mjs', 'resource-start-outside-admission', true],
      ['scripts/tauri-surface-verify-reporter-status.mts', 'resource-start-outside-admission', true],
      ['packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts', 'resource-start-outside-admission', false],
      ['packages/operator-core/lib/memory/bench/measurement-dossier.fixture.ts', 'resource-start-outside-admission', false],
      ['packages/operator-core/lib/memory/bench/measurement-dossier.ts', 'resource-start-outside-admission', false],
      ['packages/operator-core/lib/memory/bench/tracked-evidence.ts', 'resource-start-outside-admission', false],
      ['scripts/agent-capacity/cost-model.ts', 'resource-start-outside-admission', true],
      ['packages/operator-core/lib/agent-tools/harness/create.ts', 'resource-start-outside-admission', false],
    ];
    for (const [path, code, p016] of startPins) {
      const source = readFileSync(ROOT + path, 'utf8');
      const entry = BYPASS_REGISTRY.get(`${path}::${code}`);
      expect(entry?.matchesSource, path).toBeTypeOf('function');
      expect(entry?.matchesSource?.(source), path).toBe(true);
      const addedStart = `${source}\nspawn('unreviewed-worker', []);`;
      expect(entry?.matchesSource?.(addedStart), path).toBe(false);
      expect(scanInventory([[path, addedStart]], p016 ? { migrations: ['P-016'] } : {})).toContain(`${path}:${code}`);
    }

    const queuePins: Array<[string, string, string, string, boolean]> = [
      ['packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts', 'unbounded-resident-queue',
        'if (commits.has(repo) || pending.has(repo)) return;', 'if (commits.has(repo)) return;', false],
      ['scripts/gen-asana-openapi-subset.mjs', 'unbounded-resident-queue',
        'if (seen.has(name)) continue;', 'if (name.length < 0) continue;', true],
      ['scripts/npm-install-safe.mjs', 'unbounded-resident-queue',
        'if (!inputPaths.has(targetRelative)) {', 'if (targetRelative) {', true],
      ['packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts', 'unbounded-resident-queue',
        'if ((seen.get(value) ?? -1) >= mode) continue;', 'if (mode < 0) continue;', false],
      ['packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts', 'unbounded-resident-queue',
        'if (pending.size >= 64 || pending.has(requestId)) return;', 'if (pending.has(requestId)) return;', false],
      ['packages/operator-core/lib/agent-tools/coordination/inbox-visibility.ts', 'unbounded-resident-queue',
        'pending.set(entry, { key, fingerprint });', 'pending.push(entry);', false],
      ['scripts/bench-work-item-continuations.ts', 'unbounded-resident-queue',
        'pending.push(heldWrite);', 'pending.set(heldWrite);', true],
      ['packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts', 'unbounded-resident-queue',
        "if (current === null || typeof current !== 'object' || seen.has(current)) continue;",
        "if (current === null || typeof current !== 'object') continue;", false],
    ];
    for (const [path, code, before, after, p016] of queuePins) {
      const source = readFileSync(ROOT + path, 'utf8');
      const entry = BYPASS_REGISTRY.get(`${path}::${code}`);
      expect(entry?.matchesSource, path).toBeTypeOf('function');
      expect(entry?.matchesSource?.(source), path).toBe(true);
      const mutant = source.replace(before, after);
      expect(mutant).not.toBe(source);
      expect(entry?.matchesSource?.(mutant), path).toBe(false);
      expect(scanInventory([[path, mutant]], p016 ? { migrations: ['P-016'] } : {})).toContain(`${path}:${code}`);
    }

    const vintage = 'packages/operator-core/lib/agent-tools/deploys/vintage.ts';
    expect(BYPASS_REGISTRY.has(`${vintage}::resource-start-outside-admission`)).toBe(false);
    expect(inspectGovernorSource(readFileSync(ROOT + vintage, 'utf8'))).not.toContain('resource-start-outside-admission');
  });

  it('keeps the hand-written .d.mts declaration aligned with the P-016 runtime exports', () => {
    const declaration = readFileSync(ROOT + 'scripts/check-resource-governor-enforcement.d.mts', 'utf8');
    for (const symbol of [
      'RESOURCE_GOVERNOR_SCANNER_PATH',
      'P016_REVIEWED_DISPOSITIONS',
      'P016_DISPOSITION_REGISTRY',
    ]) {
      expect(declaration).toContain('export const ' + symbol);
    }
    expect(declaration).toContain('migration: string;');
    expect(declaration).toContain('sites: readonly');
  });

  it('keeps the graph snapshot CLI child timeout-bounded and the traversal disposition path-specific', () => {
    const path = 'scripts/gen-graph-dependency-snapshot.mjs';
    const generator = readFileSync(ROOT + path, 'utf8');
    expect(inspectGovernorSource(generator)).toContain('resource-start-outside-admission');
    const generatorKey = `${path}::resource-start-outside-admission`;
    expect(P016_DISPOSITION_REGISTRY.get(generatorKey)?.disposition).toBe('bypass');
    expect(P016_DISPOSITION_REGISTRY.get(generatorKey)?.reason).toContain('runCliToFile');
    expect(P016_DISPOSITION_REGISTRY.get(generatorKey)?.matchesSource?.(generator)).toBe(true);
    const noTimeout = generator.replace(
      'const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);',
      'const timer = undefined;',
    );
    expect(scanInventory([[path, noTimeout]], { migrations: ['P-016'] })).toContain(
      `${path}:resource-start-outside-admission`,
    );
    const key = 'scripts/lib/graph-dependency-suggestions.mjs::unbounded-resident-queue';
    expect(P016_DISPOSITION_REGISTRY.get(key)?.disposition).toBe('semantic');
    expect(P016_DISPOSITION_REGISTRY.get(key)?.reason).toContain('MAX_VISITED_FILES');
  });

  it('keeps hosted GCP role reconciliation as a one-shot operator CLI bypass', () => {
    const path = 'scripts/workspace-host/reconcile-hosted-gcp-roles.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const key = 'scripts/workspace-host/reconcile-hosted-gcp-roles.ts::resource-start-outside-admission';
    const disposition = P016_DISPOSITION_REGISTRY.get(key);

    expect(disposition?.disposition).toBe('bypass');
    expect(disposition?.reason).toContain("execFileSync('gcloud', ['auth', 'print-access-token'])");
    expect(source).toContain("execFileSync('gcloud', ['auth', 'print-access-token']");
    expect(source.match(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)).toEqual([
      'execFileSync(',
    ]);
    expect(source).not.toMatch(
      /\b[A-Za-z_$][\w$]*\s*[=:]\s*(?:promisify\s*\(\s*)?(?:spawn|spawnSync|fork|execFile|execFileSync)\s*[,)\s;}]/,
    );
    expect(
      scanInventory([[path, source]], { migrations: ['P-016'], validateRegistry: true }),
    ).toEqual([]);
  });

  it('reviews declaration suppression lookup as one synchronous build-time Git metadata read', () => {
    const path = 'scripts/lib/stale-declaration-suppressions.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const key = `${path}::resource-start-outside-admission`;
    expect(inspectGovernorSource(source)).toContain('resource-start-outside-admission');
    expect(P016_DISPOSITION_REGISTRY.get(key)?.disposition).toBe('bypass');
    expect(P016_DISPOSITION_REGISTRY.get(key)?.reason).toContain('importerSources');
    // A second primitive start requires a new review of this exact-path disposition.
    expect(source.match(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)).toEqual(['execFileSync(']);
    expect(source).toMatch(/execFileSync\('git',\s*\['-C', repoRoot, 'grep', '-l', '-F'/);
    expect(scanInventory([[path, source]], { migrations: ['P-016'], validateRegistry: true })).toEqual([]);
  });

  it('pins the committed-source loader bypass to its one timeout-bounded git read helper', () => {
    const path = 'scripts/lib/committed-source-loader.mjs';
    const source = readFileSync(ROOT + path, 'utf8');
    const key = `${path}::resource-start-outside-admission`;
    expect(inspectGovernorSource(source)).toContain('resource-start-outside-admission');
    expect(P016_DISPOSITION_REGISTRY.get(key)?.disposition).toBe('bypass');
    expect(P016_DISPOSITION_REGISTRY.get(key)?.reason).toContain('spawnCensus');
    expect(source).toMatch(/return execFileSync\(gitExecutable, \['-C', top, \.\.\.args\]/);
    expect(source).toContain("if (configured && !isAbsolute(configured))");
    expect(source).toContain("const resolved = realpathSync(candidate);");
    expect(source).toContain("accessSync(resolved, fsConstants.X_OK);");
    expect(scanInventory([[path, source]], { migrations: ['P-016'], validateRegistry: true })).toEqual([]);
    // A second start, or a detached git child, needs a fresh review: both fall out of the pin.
    const secondStart = source.replace('function audit(record) {', "function audit(record) {\n  execFileSync('ls', []);");
    const detached = source.replace("stdio: ['ignore', 'pipe', 'pipe'],", "detached: true,\n    stdio: ['ignore', 'pipe', 'pipe'],");
    const unresolvedExecutable = source.replace(
      "return execFileSync(gitExecutable, ['-C', top, ...args], {",
      "return execFileSync('git', ['-C', top, ...args], {",
    );
    for (const mutant of [secondStart, detached, unresolvedExecutable]) {
      expect(mutant).not.toBe(source);
      expect(scanInventory([[path, mutant]], { migrations: ['P-016'], validateRegistry: true })).toEqual([
        `${path}:resource-start-outside-admission`,
      ]);
    }
  });

  it('does not let regex-literal RegExp#exec void the committed-source loader pin, but still counts exec calls', () => {
    // WI-6554700010030439: the pin counts exec/execSync too, and a regex LITERAL's
    // `.exec(` read as a second child start, so a parse helper silently voided the
    // reviewed disposition and redded the gate. Only a literal receiver is exempt.
    const path = 'scripts/lib/committed-source-loader.mjs';
    const source = readFileSync(ROOT + path, 'utf8');
    const entry = P016_DISPOSITION_REGISTRY.get(`${path}::resource-start-outside-admission`);
    expect(entry?.matchesSource?.(source)).toBe(true);
    const regexLiteralParse = `${source}\nexport const fb439 = (s) => /^(.+)\\.timestamp-\\d+$/i.exec(s);`;
    expect(entry?.matchesSource?.(regexLiteralParse)).toBe(true);
    expect(scanInventory([[path, regexLiteralParse]], { migrations: ['P-016'] })).toEqual([]);
    for (const mutant of [
      `${source}\nconst FB439_RE = /x/; FB439_RE.exec(s);`,
      `${source}\ncp.exec('ls');`,
      `${source}\nexec('ls');`,
      `${source}\nexecSync('ls');`,
    ]) {
      expect(entry?.matchesSource?.(mutant), mutant.slice(-40)).toBe(false);
      expect(scanInventory([[path, mutant]], { migrations: ['P-016'] })).toEqual([
        `${path}:resource-start-outside-admission`,
      ]);
    }
  });

  it('can audit a pending migration and applies only centrally registered dispositions', () => {
    const files: Array<[string, string]> = [
      [
        'packages/operator-core/lib/agent-tools/plans/audit.ts',
        `import { execFileSync } from 'node:child_process'; execFileSync('git', ['rev-parse', 'HEAD']);`,
      ],
      [
        'packages/operator-core/lib/agent-tools/example.ts',
        `import { spawn } from 'node:child_process'; spawn('resident-worker', []);`,
      ],
    ];

    expect(scanInventory(files, { migrations: ['P-014'] })).toEqual([
      'packages/operator-core/lib/agent-tools/example.ts:resource-start-outside-admission',
    ]);
    expect(scanActiveInventory(files)).toEqual([
      'packages/operator-core/lib/agent-tools/example.ts:resource-start-outside-admission',
    ]);
  });

  it('rejects a stale exact bypass entry once its registered path no longer has that finding', () => {
    const files: Array<[string, string]> = [
      ['packages/operator-core/lib/agent-tools/plans/audit.ts', `export const head = 'already supplied';`],
    ];
    expect(scanInventory(files, { migrations: ['P-014'], validateRegistry: true })).toContain(
      'stale-bypass-registry:packages/operator-core/lib/agent-tools/plans/audit.ts::resource-start-outside-admission:finding-absent',
    );
  });

  it('retires measurement-pin bypass after git reads moved to the replay helper', () => {
    const path = 'packages/operator-core/lib/agent-tools/plans/evidence-measurement-pin.ts';
    const key = `${path}::resource-start-outside-admission`;
    const source = readFileSync(ROOT + path, 'utf8');
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(BYPASS_REGISTRY.has(key)).toBe(false);
    expect(
      scanInventory([[path, source]], { migrations: ['P-014'], validateRegistry: true }),
    ).not.toContain(`stale-bypass-registry:${key}:finding-absent`);
    expect(
      scanInventory([[path, source + "\nspawn('resident-worker', []);"]], { migrations: ['P-014'] }),
    ).toContain(`${path}:resource-start-outside-admission`);
  });

  it('retires credential-store bypass after keychain starts moved to the authentication helpers', () => {
    const path = 'packages/operator-core/lib/inference-gateway/credential-store.ts';
    const key = `${path}::resource-start-outside-admission`;
    const source = readFileSync(ROOT + path, 'utf8');
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(BYPASS_REGISTRY.has(key)).toBe(false);
    expect(
      scanInventory([[path, source]], { migrations: ['P-015'], validateRegistry: true }),
    ).not.toContain(`stale-bypass-registry:${key}:finding-absent`);
    expect(
      scanInventory([[path, source + "\nspawn('resident-worker', []);"]], { migrations: ['P-015'] }),
    ).toContain(`${path}:resource-start-outside-admission`);
  });

  it('retires supervision reconcile disposition after resource starts moved behind the sidecar helper', () => {
    const path = 'packages/operator-core/lib/harness/routines/supervision-reconcile-action.ts';
    const key = `${path}::resource-start-outside-admission`;
    const source = readFileSync(ROOT + path, 'utf8');
    expect(P016_DISPOSITION_REGISTRY.has(key)).toBe(false);
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(
      scanInventory([[path, source]], { migrations: ['P-016'], validateRegistry: true }),
    ).not.toContain(`stale-bypass-registry:${key}:finding-absent`);
    expect(
      scanInventory([[path, source + "\nspawn('worker', []);"]], { migrations: ['P-016'] }),
    ).toContain(`${path}:resource-start-outside-admission`);
  });

  it('keeps completion free of resource starts now that its Git probe lives in git-trackedness.ts', () => {
    // The bounded `git ls-files` trackedness probe moved out of complete.ts into
    // packages/operator-core/lib/git-trackedness.ts (2026-10-01), so its exact-call
    // bypass row described nothing and the registry validator reported it stale. The row
    // is retired; this pins the replacement contract: complete.ts starts nothing, has no
    // row to hide behind, and a start added back there is a finding again.
    const path = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(BYPASS_REGISTRY.has(`${path}::resource-start-outside-admission`)).toBe(false);
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(scanInventory([[path, source]])).not.toContain(finding);
    expect(scanInventory([[path, source + "\nspawn('resident-worker', []);"]])).toContain(finding);
    expect(
      scanInventory([[path, source + "\nexecFileSync('git', ['ls-files', '--error-unmatch', '--', p]);"]]),
    ).toContain(finding);
  });

  it('executes the real blocking CLI over the tracked tree', () => {
    const output = execFileSync(process.execPath, ['scripts/check-resource-governor-enforcement.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('[resource-governor-enforcement] OK');
    // The test budget must outlast the child's own 120s timeout. At 30s it fired
    // first: the scan of ~9,800 files took ~40-47s under gate load (2026-10-01,
    // repairHead bc19465b), so the gate saw a test timeout, not the CLI's verdict.
  }, 150_000);
});
