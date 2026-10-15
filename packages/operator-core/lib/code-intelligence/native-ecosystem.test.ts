import { describe, expect, it } from 'vitest';
// The required ecosystem BAR suite exercises the maintained subsystem guards.
import '../harness/docs/native-source-change.test';
import '../agent-tools/plans/native-planning-advice.test';
import './task-brief.test';
import '../dream/capability-packets.test';
import '../dream/capability-sampler.test';
import './scoped-contracts.test';
import './first-party-discovery.test';
import './semgrep-taint-facade.test';
import '../dream/capability-review.test';
import '../dream/dream-evaluation.test';
import '../dream/dream-study-graph-comparison.test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitArm, ARM_ADMISSIONS, type ArmAdmission } from './fair-comparison-admission';
import { astGrepSyntaxIndex } from './ast-grep-facade';
import { LspDaemonAnswerCache, type MeasuredLspInputs } from './lsp-daemon-cache';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { unmeasuredSourceEvidence, versionedSymbolIdentity, type CodeIntelAnswer } from './contracts';
import { nativeChangeReport, packerFacade, REPOMIX_PINNED_VERSION, type PackerEffects } from './packer-facade';
import { produceSnapshotFromSource } from '../../../../scripts/gen-graph-dependency-snapshot.mjs';
import { suggestFromSnapshot, unionSuperset } from '../../../../scripts/lib/graph-dependency-suggestions.mjs';
import { captureCodeDependencies, assertCodeDependencyVersions } from '../agent-tools/plans/code-dependency-evidence';
import { classifySpecEvidenceCurrentness, measureAndPinRepoFilesEvidenceAtRoot } from '../agent-tools/plans/spec-evidence-store';
import { sourceRuntimeProvenance } from './source-runtime-provenance';
import { nativeCliPlan, nativeCliResult, nativeCliTestTimeout } from './native-cli.fixture';
import { nativeFixtureProcess, recoverNativeCliResult, scopedNativeFixtureArgs } from './native-cli.fixture';
import { PTOOL_CONNECT_TIMEOUT_MS, PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS, PTOOL_LIST_TOOLS_TIMEOUT_MS,
  ptoolConnectionRetryOptions, ptoolConnectAttemptTimeoutMs, timeoutForTool,
  resolvePtoolInvocationCandidates } from '../../../../apps/operator/scripts/ptool.mjs';

describe('native P021 required BAR captured source bundle boundary', () => {
  it('keeps complete small evidence distinct from a truncated preview and binds expansion to the saved bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-small-source-bundle-'));
    const path = join(root, 'pack.xml');
    const source = '<file path="target.ts">export const answer = 42;</file>';
    const effects: PackerEffects = { exec: async (bin, argv) => ({ stdout: argv[0] === '--version'
      ? REPOMIX_PINNED_VERSION : bin === 'git' ? '' : source }),
    writeArtifact: async body => { writeFileSync(path, body); return path; }, now: () => new Date() };
    try {
      const result = await packerFacade('pack', { rootPath: root, include: ['target.ts'] }, effects);
      const artifact = result.artifact!, bundle = artifact.bundle!;
      expect(result.answer.error).toBeNull();
      expect(bundle).toMatchObject({ kind: 'captured-source', sourcePaths: ['target.ts'], truncated: false,
        totalChars: source.length, retainedChars: source.length });
      expect(artifact.preview).toBe(source);
      expect(bundle.tokens.source).toBe(bundle.tokens.retained);
      expect(bundle.tokens.source).toBeGreaterThan(0);
      expect(bundle.expansion.args.file_path).toBe(path);
      expect(readFileSync(path, 'utf8')).toBe(source);
      expect(bundle.expansion.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native CLI fixture runtime and deadline guards', () => {
  it('keeps built artifacts outside the scoped TypeScript fixture loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-scoped-fixture-'));
    try {
      const fixture = join(root, 'fixture.ts'), artifact = join(root, 'handler.mjs');
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
      writeFileSync(artifact, `
        export function compiledFunction() { return import('node:path'); }
        export const parserRetained = !compiledFunction.toString().includes('.then(');
        export const url = import.meta.url;
      `);
      writeFileSync(fixture, `
        export async function run(argv: string[], load: (url: string) => Promise<{url: string, parserRetained: boolean}>) {
          const artifact = await load(argv[0]);
          if (artifact.url !== argv[0]) throw new Error('Built artifact entered the TypeScript namespace: ' + artifact.url);
          if (!artifact.parserRetained) throw new Error('Built artifact was transformed by the TypeScript loader');
          console.log('NATIVE_SCOPED_FIXTURE_PROOF=' + JSON.stringify({ source: 'typescript', artifact: artifact.url, argv: argv.slice(1) }));
        }
      `);
      const artifactUrl = pathToFileURL(artifact).href;
      const result = await nativeFixtureProcess(process.execPath,
        scopedNativeFixtureArgs(pathToFileURL(fixture).href, 'run', [artifactUrl, 'literal argument']),
        { cwd: process.cwd(), timeoutMs: 10_000 });
      expect(result.code, result.output).toBe(0);
      const proof = result.output.split('\n').find(line => line.startsWith('NATIVE_SCOPED_FIXTURE_PROOF='));
      expect(proof, result.output).toBeDefined();
      expect(JSON.parse(proof!.split('=', 2)[1])).toEqual({ source: 'typescript', artifact: artifactUrl, argv: ['literal argument'] });
      const transformed = await nativeFixtureProcess(process.execPath,
        ['--import', 'tsx', ...scopedNativeFixtureArgs(pathToFileURL(fixture).href, 'run', [artifactUrl])],
        { cwd: process.cwd(), timeoutMs: 10_000 });
      expect(transformed.code, transformed.output).toBe(1);
      expect(transformed.output).toContain('Built artifact was transformed by the TypeScript loader');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([0, 17])('streams actual native invocation transitions before the file settles (exit %s)', async exitCode => {
    const fixture = new URL('./native-cli.fixture.ts', import.meta.url).href;
    const script = `
      import { spawnSync } from 'node:child_process';
      import { nativeCliCall } from ${JSON.stringify(fixture)};
      const invoke = (_command, _args, options) => spawnSync(process.execPath,
        ['-e', ${JSON.stringify(`setTimeout(() => { process.stdout.write('{"ok":true,"answer":42}'); process.exit(${exitCode}); }, 75);`)}],
        { ...options, input: undefined });
      try {
        const answer = nativeCliCall('http://127.0.0.1:3170', 'fixture:read', { secret: 'must-stay-private' }, invoke);
        if (answer.answer !== 42) throw new Error('Unexpected child answer');
      } catch (error) {
        if (${exitCode} === 0 || !String(error).includes('Native CLI process failed')) throw error;
      }
      process.stderr.write('NATIVE_CLI_PARENT_SETTLED\\n');
    `;
    const chunks: string[] = [];
    const result = await nativeFixtureProcess(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), timeoutMs: 10_000, onOutput: text => chunks.push(text),
      });
    expect(result.code, result.output).toBe(0);
    const output = chunks.join('');
    const transitions = output.split('\n').filter(line => line.startsWith('NATIVE_CLI_PROGRESS='))
      .map(line => JSON.parse(line.slice('NATIVE_CLI_PROGRESS='.length)));
    expect(transitions).toEqual([
      expect.objectContaining({ state: 'started', name: 'fixture:read' }),
      expect.objectContaining({ state: 'settled', name: 'fixture:read', status: exitCode, signal: null }),
    ]);
    expect(transitions[1].elapsedMs).toBeGreaterThanOrEqual(75);
    expect(output.indexOf('"state":"started"')).toBeLessThan(output.indexOf('"state":"settled"'));
    expect(output.indexOf('"state":"settled"')).toBeLessThan(output.indexOf('NATIVE_CLI_PARENT_SETTLED'));
    expect(output).not.toContain('must-stay-private');
  });

  it('recovers complete spilled evidence through verified bytes and refuses corrupted or partial sources', () => {
    const payload = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true,"answer":42}' }] }));
    const envelope = { schemaVersion: 'papercusp.output-envelope/v1', state: 'incomplete',
      incomplete: { recoverable: true }, content: [{ kind: 'reference', uri: 'papercusp://scratch/test/page' }] };
    const result = { status: 0, stdout: JSON.stringify(envelope), stderr: '' };
    const page = { ok: true, encoding: 'base64', byte_offset: 0, byte_length: payload.length,
      total_bytes: payload.length, eof: true, next_cursor: null, data: payload.toString('base64'),
      reference: { schemaVersion: 'papercusp.scratch-reference/v1', byteCount: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex') } };
    expect(recoverNativeCliResult(result, () => page)).toEqual({ ok: true, answer: 42 });
    expect(() => recoverNativeCliResult(result, () => ({ ...page, data: 'corrupt' }))).toThrow(/byte page/);
    expect(() => recoverNativeCliResult(result, () => ({ ...page, reference: { ...page.reference,
      sha256: '0'.repeat(64) } }))).toThrow(/integrity/);
    envelope.incomplete.recoverable = false;
    expect(() => recoverNativeCliResult({ ...result, stdout: JSON.stringify(envelope) }, () => {
      throw new Error('must not attempt expansion');
    })).toThrow(/incomplete evidence/);
  });
  it('retains child phase diagnostics and terminates a timed-out private process', async () => {
    const chunks: string[] = [];
    await expect(nativeFixtureProcess(process.execPath,
      ['-e', 'console.log("NATIVE_INCIDENT_API_STAGE=waiting-for-handler"); setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), timeoutMs: 300, onOutput: text => chunks.push(text) }))
      .rejects.toThrow(/deadline 300ms exceeded[\s\S]*waiting-for-handler/);
    expect(chunks.join('')).toContain('waiting-for-handler');
  });
  it.each([false, true])('preserves early and late phase clocks after output truncation (deadline %s)', async timedOut => {
    const script = `
      process.stdout.write('fixture-bootstrap-diagnostics\\n');
      process.stdout.write('NATIVE_INCIDENT_API_STAGE=private-pg-start\\n');
      process.stdout.write('x'.repeat(60_000) + '\\n');
      setTimeout(() => {
        process.stdout.write('NATIVE_INCIDENT_API_STAGE=cli-start:work_items:claim\\n');
        ${timedOut ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 19;'}
      }, 40);
    `;
    const clocks: { elapsedMs: number; remainingMs: number }[] = [];
    let output: string;
    try {
      const result = await nativeFixtureProcess(process.execPath, ['-e', script], {
        cwd: process.cwd(), timeoutMs: 750, onOutput: (_text, timing) => clocks.push(timing),
      });
      expect(timedOut).toBe(false);
      expect(result.code).toBe(19);
      output = result.output;
    } catch (error) {
      expect(timedOut).toBe(true);
      output = String(error);
      expect(output).toContain('Private fixture deadline 750ms exceeded');
    }
    const line = output.split('\n').find(row => row.startsWith('NATIVE_FIXTURE_TIMING='))!;
    const timing = JSON.parse(line.slice('NATIVE_FIXTURE_TIMING='.length));
    expect(timing.timeoutMs).toBe(750);
    expect(timing.phaseCount).toBe(2);
    expect(timing.phases.map((phase: { line: string }) => phase.line)).toEqual([
      'NATIVE_INCIDENT_API_STAGE=private-pg-start', 'NATIVE_INCIDENT_API_STAGE=cli-start:work_items:claim',
    ]);
    expect(timing.phases[1].elapsedMs).toBeGreaterThan(timing.phases[0].elapsedMs);
    // Loaders may emit diagnostics before the first fixture stage. Require the
    // stage in the retained startup section, without assuming it is byte zero.
    const startup = output.split('\nstartup:\n')[1]?.split('\ntail:\n')[0];
    expect(startup).toContain('fixture-bootstrap-diagnostics\nNATIVE_INCIDENT_API_STAGE=private-pg-start\n');
    expect(output.length).toBeLessThan(40_000);
    expect(clocks.every((clock, index) => clock.elapsedMs >= (clocks[index - 1]?.elapsedMs ?? 0)
      && clock.remainingMs <= (clocks[index - 1]?.remainingMs ?? 750))).toBe(true);
  });
  it('uses the maintained staging proxy without a green fallback and honors producer deadlines', () => {
    const plan = nativeCliPlan('http://localhost:3170', 'graph:query', {}, {
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071', PAPERCUSP_MCP_PROXY_PORT: '9071',
    });
    expect(plan.cliUrl).toBe('http://127.0.0.1:9171');
    expect(resolvePtoolInvocationCandidates({ url: plan.cliUrl }, plan.env)).toEqual([plan.cliUrl]);
    expect(ptoolConnectAttemptTimeoutMs(plan.cliUrl, plan.env)).toBe(PTOOL_CONNECT_TIMEOUT_MS);
    expect(ptoolConnectionRetryOptions({ url: plan.cliUrl }, plan.env)).toEqual({ maxAttempts: 1 });
    expect(timeoutForTool('tools:invoke', { name: 'graph:query', args: {} })).toBe(100_000);
    expect(plan.timeoutMs).toBe(PTOOL_CONNECT_TIMEOUT_MS + PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS +
      timeoutForTool('graph:query', {}) + PTOOL_LIST_TOOLS_TIMEOUT_MS);
    expect(nativeCliTestTimeout(['graph:query', 'dev:pipeline_position'])).toBeGreaterThan(plan.timeoutMs);
  });
  it('keeps remote and alternate local pins despite inherited proxy settings', () => {
    for (const base of ['https://runtime.example', 'http://127.0.0.1:55942', 'http://remote.example:3170']) {
      const plan = nativeCliPlan(base, 'graph:query', {}, {
        PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071', PAPERCUSP_MCP_PROXY_PORT: '55942',
      });
      expect(plan.cliUrl).toBe(base);
      expect(resolvePtoolInvocationCandidates({ url: plan.cliUrl }, plan.env)).toEqual([base]);
      expect(plan.env.PAPERCUSP_MCP_PROXY_BASE).toBeUndefined();
      expect(plan.env.PAPERCUSP_MCP_PROXY_PORT).toBeUndefined();
    }
    for (const port of ['3170', '3070', '9071']) {
      expect(() => nativeCliPlan('http://127.0.0.1:3170', 'graph:query', {}, {
        PAPERCUSP_MCP_STAGING_PROXY_PORT: port,
      })).toThrow(/requires its maintained MCP proxy/);
    }
  });
  it('preserves stdout, stderr and process failure evidence', () => {
    expect(() => nativeCliResult({ status: 1, stdout: 'typed-worker-error', stderr: 'connection trace',
      error: new Error('ETIMEDOUT'), signal: 'SIGTERM' })).toThrow(/ETIMEDOUT[\s\S]*typed-worker-error[\s\S]*connection trace/);
    expect(() => nativeCliResult({ status: 0, stdout: '{"ok":false,"error":"typed refusal"}', stderr: '' })).toThrow(/typed refusal/);
    expect(() => nativeCliResult({ status: 0, stdout: 'invalid', stderr: 'diagnostic' })).toThrow(/invalid[\s\S]*diagnostic/);
    for (const stdout of ['null', '[]', 'true']) {
      expect(() => nativeCliResult({ status: 0, stdout, stderr: 'shape diagnostic' })).toThrow(/invalid response shape[\s\S]*shape diagnostic/);
    }
    expect(nativeCliResult({ status: 0, stdout: '{"ok":true,"data":{"answer":1}}', stderr: '' })).toEqual({ answer: 1 });
  });
  it('refuses an incomplete evidence envelope before a caller reads missing proof fields', () => {
    const envelope = { schemaVersion: 'papercusp.output-envelope/v1', state: 'incomplete',
      incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      content: [{ kind: 'reference', uri: 'papercusp://scratch/unavailable' }] };
    expect(() => nativeCliResult({ status: 0, stdout: JSON.stringify(envelope), stderr: 'bounded evidence' }))
      .toThrow(/incomplete evidence[\s\S]*under-budget-partial-result[\s\S]*bounded evidence/);
  });
  it('preserves tool-owned data and byte-page identity instead of unwrapping them', () => {
    const page = { ok: true, data: Buffer.from('captured source').toString('base64'),
      byte_offset: 0, byte_length: 15, eof: false,
      next_cursor: { tool: 'capability:read', args: { file_path: '/tmp/captured', byte_offset: 15, byte_limit: 4096 } } };
    expect(nativeCliResult({ status: 0, stdout: JSON.stringify(page), stderr: '' })).toEqual(page);
    const tool = { ok: true, data: { answer: 1 }, sourceFingerprint: 'measured' };
    expect(nativeCliResult({ status: 0, stdout: JSON.stringify(tool), stderr: '' })).toEqual(tool);
  });
});

describe('native P011 required BAR add-only validated test selection', () => {
  it('keeps baseline tests when a hashed dependency path is accepted, stale or unavailable', () => {
    const now = Date.now();
    const sources: Record<string, string> = { 'target.ts': 'export const target = 1;',
      'target.test.ts': 'import { target } from "./target"; export const tested = target;' };
    const { snapshot } = produceSnapshotFromSource({ files: Object.keys(sources),
      headCommit: 'a'.repeat(40), now, readSource: (path: string) => sources[path] ?? null });
    const input = { changed: ['target.ts'], now, readSource: (path: string) => sources[path] ?? null };
    const baseline = ['baseline.test.ts', 'guard.test.ts'];
    const valid = suggestFromSnapshot({ ...input, snapshot });
    expect(valid.dependencyPaths).toEqual([expect.objectContaining({ changed: 'target.ts', consumer: 'target.test.ts',
      files: ['target.ts', 'target.test.ts'], hops: [expect.objectContaining({ importerSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })] })]);
    expect(unionSuperset(baseline, valid.suggestedFiles).names).toEqual([...baseline, 'target.test.ts']);
    sources['target.test.ts'] = 'export const tested = 1;';
    for (const degraded of [suggestFromSnapshot({ ...input, snapshot }), suggestFromSnapshot({ ...input, snapshot: null })]) {
      expect(degraded.suggestedFiles).toEqual([]);
      expect(unionSuperset(baseline, degraded.suggestedFiles).names).toEqual(baseline);
    }
  });
});

describe('native P015 required BAR dependent proof currentness', () => {
  it('invalidates proof after a dependent edit while preserving its requirement and test identity', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-proof-contract-')));
    const sha = (file: string) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
    try {
      writeFileSync(join(root, 'consumer.ts'), 'export function consumer() { return dependency(); }\n');
      writeFileSync(join(root, 'dependency.ts'), 'export function dependency() { return 1; }\n');
      const base: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'consumer',
        sites: [{ path: 'consumer.ts', line1: 1, kind: 'function' }],
        truncation: { truncated: false, totalAvailable: 1, continuation: null },
        freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
      const evidence = unmeasuredSourceEvidence(base, { repositoryId: `local-root:${createHash('sha256').update(root).digest('hex')}`,
        identityKind: 'local-root', paths: ['.'], basis: 'compiler-project' }, []);
      const answer: CodeIntelAnswer = { ...base, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope,
        supportingFiles: ['consumer.ts', 'dependency.ts'].map(path => ({ path, contentHash: sha(path),
          language: 'typescript', representation: 'full-source' })) }, relationships: [
        { siteIndex: 0, kind: 'definition', origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown' },
      ] } };
      const captured = await captureCodeDependencies(root, { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['consumer.ts'] },
        [{ name: 'consumer', file: 'consumer.ts', paths: ['.'] }], async () => answer);
      const measured = await measureAndPinRepoFilesEvidenceAtRoot(root, captured.measurement);
      assertCodeDependencyVersions(captured.evidence.sources, measured.pin);
      const proof = { specRevision: 1, testRunId: 42, sourceFingerprint: measured.sourceFingerprint };
      const row = { spec_is_current: true, source_fingerprint: proof.sourceFingerprint,
        test_fingerprint: null, fixture_fingerprint: null, rubric_fingerprint: null, environment_fingerprint: null,
        coverage_evidence_ref: null, coverage_evidence_present: false, test_run_id: proof.testRunId,
        test_run_present: true, test_run_worktree_dirty: false };
      const current = (sourceFingerprint: string) => classifySpecEvidenceCurrentness(row,
        { evidenceKind: 'test', evidenceRef: 'reference-proof', sourceFingerprint }, { provenance: 'server-measured' });
      expect(current(measured.sourceFingerprint).overall).toBe('current');
      writeFileSync(join(root, 'dependency.ts'), 'export function dependency() { return 2; }\n');
      const edited = await measureAndPinRepoFilesEvidenceAtRoot(root, captured.measurement);
      expect(current(edited.sourceFingerprint)).toMatchObject({ overall: 'stale', staleReasons: ['source-stale'],
        dimensions: { source: 'stale', spec: 'current', testRun: 'current' } });
      expect(() => assertCodeDependencyVersions(captured.evidence.sources, edited.pin)).toThrow('does_not_match_measured_source');
      expect(proof).toEqual({ specRevision: 1, testRunId: 42, sourceFingerprint: measured.sourceFingerprint });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native P017 R3 source-scope contract', () => {
  it('binds site identity to repository and captured bytes while leaving unmeasured graph versions explicit', () => {
    const site = { path: 'target.ts', line1: 1, kind: 'function', name: 'target' };
    const source = { path: site.path, contentHash: createHash('sha256').update('export function target() { return 1; }').digest('hex'),
      language: 'typescript', representation: 'full-source' as const };
    const identity = versionedSymbolIdentity('captured-repository', site, source);
    expect(identity).not.toBeNull();
    expect(versionedSymbolIdentity('another-repository', site, source)).not.toBe(identity);
    expect(versionedSymbolIdentity('captured-repository', site, { ...source,
      contentHash: createHash('sha256').update('export function target() { return 2; }').digest('hex') })).not.toBe(identity);
    expect(versionedSymbolIdentity('captured-repository', site, { ...source, representation: 'reexport-stub' })).toBeNull();
    for (const sites of [[site], []]) {
      const evidence = unmeasuredSourceEvidence({ intent: 'callers', sites }, {
        repositoryId: 'captured-repository', identityKind: 'registry', paths: ['src'], basis: 'indexed-code',
      }, ['No captured compiler input is available.']);
      expect(evidence.sourceScope).toMatchObject({ repositoryId: 'captured-repository', paths: ['src'],
        sourceFingerprint: null, supportingFiles: [] });
      expect(evidence.siteIdentities).toEqual(sites.map((entry, siteIndex) => ({ siteIndex,
        sourcePath: entry.path, contentHash: null, versionedSymbolId: null })));
      expect(evidence.relationships.every(edge => edge.knowledge === 'unknown' && edge.runtimeExecution === 'unknown')).toBe(true);
    }
  });
});

describe('native P017 required BAR captured source and loaded artifact', () => {
  it('keeps a staging source version distinct from the selected release artifact', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-runtime-contract-')));
    const captured = createHash('sha256').update('new staging source').digest('hex');
    const base: CodeIntelAnswer = { backend: 'typescript-service', intent: 'definition', query: 'target', sites: [],
      truncation: { truncated: false, totalAvailable: 0, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
    const evidence = unmeasuredSourceEvidence(base, { repositoryId: 'reference-repo', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    const answer: CodeIntelAnswer = { ...base, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope,
      sourceFingerprint: captured, supportingFiles: [{ path: 'target.ts', contentHash: captured, language: 'typescript', representation: 'full-source' }] } } };
    const pipeline = { repoRoot: root, acceptedSource: { expectedSha256: captured, observedSha256: captured, matches: true,
      runtimeContainment: { 'staging-operator': true, 'release-operator': false } }, servingRuntimes: [
      { runtime: 'release-operator', buildSha: 'a'.repeat(40), containsChange: false },
      { runtime: 'staging-operator', buildSha: 'b'.repeat(40), containsChange: true },
    ] };
    const dispatch = async () => ({ data: pipeline });
    try {
      const release = await sourceRuntimeProvenance(answer, 'release-operator', root, dispatch);
      expect(release).toMatchObject({ repositoryId: 'reference-repo', sourceFingerprint: captured,
        files: [{ capturedSourceSha256: captured, artifact: { buildSha: 'a'.repeat(40) }, containsCapturedSource: false }] });
      expect((await sourceRuntimeProvenance(answer, 'staging-operator', root, dispatch)).files[0]!.containsCapturedSource).toBe(true);
      pipeline.acceptedSource.observedSha256 = createHash('sha256').update('later edit').digest('hex');
      pipeline.acceptedSource.matches = false;
      expect((await sourceRuntimeProvenance(answer, 'staging-operator', root, dispatch)).files[0]).toMatchObject({
        capturedSourceSha256: captured, editedSourceSha256: pipeline.acceptedSource.observedSha256,
        artifact: { buildSha: 'b'.repeat(40) }, containsCapturedSource: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native P010 report consumer coverage contract', () => {
  it('retains the reference consumer and discloses any omitted bounded consumers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-report-coverage-'));
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'target',
      sites: [{ path: 'consumer.ts', line1: 2, kind: 'function', name: 'target' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false },
      latencyMs: 0, error: null };
    const exec = async () => ({ stdout: '' });
    try {
      const full = await nativeChangeReport({ rootPath: root, include: ['*.ts'] },
        { symbol: 'target', file: 'target.ts', phase: 'pre-edit' }, { exec, graph: async () => answer });
      expect(full.report.consumers).toEqual([{ path: 'consumer.ts', line1: 2, kind: 'function', name: 'target' }]);
      const bounded = await nativeChangeReport({ rootPath: root, include: ['*.ts'] },
        { symbol: 'target', file: 'target.ts', phase: 'pre-edit' }, { exec, graph: async () => ({ ...answer,
          truncation: { truncated: true, totalAvailable: 2, continuation: null } }) });
      expect(bounded.report.consumers).toEqual(full.report.consumers);
      expect(bounded.report.limitations).toContain('Consumer results were truncated; omitted consumers remain unverified.');
      expect(bounded.report.freshness).toBe('unmeasured');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native P009 source snapshot handover contract', () => {
  it('keeps the reference consumer and baseline, then rejects changed importer evidence', () => {
    const sources = new Map([
      ['src/target.ts', 'export const target = 1;\n'],
      ['consumer/use.ts', 'import { target } from "../src/target";\nexport const used = target;\n'],
    ]);
    const readSource = (path: string) => sources.get(path) ?? null;
    const now = Date.now();
    const { snapshot } = produceSnapshotFromSource({ files: [...sources.keys()], readSource,
      headCommit: 'a'.repeat(40), now });
    expect(snapshot.index.backend).toBe('first-party-imports');
    const suggest = () => suggestFromSnapshot({ changed: ['src/target.ts'], snapshot, readSource, now });
    expect(suggest().suggestedFiles).toEqual(['consumer/use.ts']);
    expect(unionSuperset(new Set(['baseline']), suggest().suggestedFiles).names).toEqual(['baseline', 'consumer/use.ts']);
    sources.set('consumer/use.ts', 'export const used = 0;\n');
    expect(suggest()).toMatchObject({ suggestedFiles: [], rejected: [{ reason: 'stale-importer' }] });
    expect(unionSuperset(new Set(['baseline']), suggest().suggestedFiles).names).toEqual(['baseline']);
  });
});

describe('native managed cache current-source contract', () => {
  it('invalidates source generations and removes deleted relationships at an unchanged cursor', async () => {
    let fingerprint = 'generation-one';
    let present = true;
    const scope = (): MeasuredLspInputs => ({ measured: true, root: '/fixture', fingerprint,
      entries: present ? 1 : 0, bytes: present ? 20 : 0, files: present ? ['target.ts'] : [],
      externalReferenceCandidates: [] });
    const revision = { measured: true as const, identity: 'fixture-service' };
    const cache = new LspDaemonAnswerCache({ prepare: async () => revision, current: () => revision }, async () => scope());
    const producer = async (): Promise<LspDaemonAnswer> => {
      const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: 'definition', query: '/fixture/consumer.ts',
        sites: present ? [{ path: 'target.ts', line1: fingerprint === 'generation-one' ? 1 : 2, kind: 'function' }] : [],
        truncation: { truncated: false, totalAvailable: present ? 1 : 0, continuation: null },
        freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
      const evidence = unmeasuredSourceEvidence(answer,
        { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
      return { ...answer, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope, sourceFingerprint: fingerprint } } };
    };
    const request = { workspaceId: 'native-contract', op: 'symbol' as const,
      args: { file: '/fixture/consumer.ts', rootPath: '/fixture', line1: 1, character: 5 } };
    const query = () => cache.query(request, 'typescript', '/fixture', new AbortController().signal, producer);
    expect((await query()).sites[0]?.line1).toBe(1);
    expect((await query()).daemonCache?.state).toBe('hit');
    fingerprint = 'generation-two';
    const edited = await query();
    expect(edited.daemonCache?.state).toBe('miss');
    expect(edited.sites).toEqual((await producer()).sites);
    expect(edited.sites[0]?.line1).toBe(2);
    present = false; fingerprint = 'generation-deleted';
    const deleted = await query();
    expect(deleted.daemonCache?.state).toBe('miss');
    expect(deleted.sites).toEqual([]);
    expect((await query()).sites).toEqual([]);
  });
});

// Production integration must not inherit the comparison's incumbent exemption.
const permissive: ArmAdmission = {
  armId: 'reviewed-engine', upstream: 'example/engine', spdx: 'MIT', licence: 'permissive',
  licenceSha256Prefix: '0123456789abcdef', telemetryDefault: 'none', telemetryOffEnv: {},
};

describe('native syntax intent admission', () => {
  it('refuses an unadmitted grammar instead of reporting a trustworthy empty', async () => {
    // Persisted or untyped callers still reach this producer guard, even when
    // the public tool's closed language enum rejects the request earlier.
    const answer = await astGrepSyntaxIndex({ language: 'cpp' as never, rootPath: '.', paths: ['unsupported.cpp'] });
    expect(answer.error).toContain('unsupported syntax-index language');
    expect(answer.sites).toEqual([]);
    expect(answer.freshness.health).toBe('unknown');
  });
});

describe('native ecosystem distribution admission', () => {
  it('retains the recorded incumbent comparison while refusing its distribution', () => {
    expect(admitArm('gitnexus@1.6.9').admission.licence).toBe('noncommercial');
    expect(() => admitArm('gitnexus@1.6.9', ARM_ADMISSIONS, 'distribution')).toThrow(/excluded from product distribution/);
  });

  it('refuses distribution even if a noncommercial incumbent is labelled approved', () => {
    const incumbent = ARM_ADMISSIONS.find(a => a.armId === 'gitnexus')!;
    expect(() => admitArm('gitnexus', [{ ...incumbent, distribution: {
      decision: 'approved', evidenceRef: 'misclassified-decision',
    } }], 'distribution')).toThrow(/comparison-only/);
  });

  it('requires a separate distribution decision for an otherwise admitted engine', () => {
    expect(admitArm(permissive.armId, [permissive]).admission.spdx).toBe('MIT');
    expect(() => admitArm(permissive.armId, [permissive], 'distribution')).toThrow(/no explicit approved decision/);
    const reviewed: ArmAdmission = { ...permissive, distribution: {
      decision: 'approved', evidenceRef: 'plan#D-001',
    } };
    expect(admitArm(reviewed.armId, [reviewed], 'distribution').admission).toEqual(reviewed);
  });

  it.each(['excluded', 'unreviewed'] as const)('refuses a %s distribution decision', decision => {
    expect(() => admitArm(permissive.armId, [{ ...permissive, distribution: {
      decision, evidenceRef: 'plan#D-001',
    } }], 'distribution')).toThrow(/no explicit approved decision/);
  });

  it('refuses an approval with an empty evidence reference', () => {
    expect(() => admitArm(permissive.armId, [{ ...permissive, distribution: {
      decision: 'approved', evidenceRef: ' ',
    } }], 'distribution')).toThrow(/no explicit approved decision/);
  });

  it('keeps the pinned licence and telemetry guards for approved distribution', () => {
    const reviewed = { ...permissive, distribution: { decision: 'approved' as const, evidenceRef: 'plan#D-001' } };
    expect(() => admitArm(permissive.armId, [{ ...reviewed, licenceSha256Prefix: null }], 'distribution')).toThrow(/without a pinned LICENSE hash/);
    expect(() => admitArm(permissive.armId, [{ ...reviewed, telemetryDefault: 'ON: usage events' }], 'distribution')).toThrow(/no opt-out env/);
    expect(admitArm(permissive.armId, [{ ...reviewed, telemetryDefault: 'ON: usage events',
      telemetryOffEnv: { DO_NOT_TRACK: '1' },
    }], 'distribution').env).toEqual({ DO_NOT_TRACK: '1' });
  });
});
