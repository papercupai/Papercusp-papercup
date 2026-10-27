/** P-001 baseline proof through the actual handler, compiler and forked worker. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// Evaluate this fixture-owning suite first. Vitest aggregates the imported BAR
// suites into one worker, so its hoisted DB mock and LSP socket setup must be
// registered before another suite loads the production DB/LSP singletons.
import './native-language-acceptance.integration.test';
// Keep the required ecosystem BAR suite on the real subsystem integration paths.
import '../harness/docs/native-source-change.integration.test';
import '../agent-tools/plans/native-planning-advice.integration.test';
import './task-brief.integration.test';
import './task-brief-ledger.integration.test';
import './engineering-evidence.integration.test';
import '../dream/capability-packets.integration.test';
import './scoped-contracts.integration.test';
import './first-party-discovery.integration.test';
import './semgrep-taint-facade.integration.test';
import '../dream/capability-review-sources.integration.test';
// Enable the interfaces in this isolated fixture; analysis/transport code is real.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';
import codeStructural from '../agent-tools/lsp/astgrep';
import { buildTaskBrief } from './task-brief';
import { DEFAULT_PACKER_EFFECTS, packerFacade } from './packer-facade';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { readWorkItemResume } from '../agent-tools/work_items/resume';
import { dispatchLspDaemonRequest, runLspDaemonServer } from './lsp-daemon-server';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import type { CodeIntelAnswer } from './contracts';
import { admitArm } from './fair-comparison-admission';
import { LspDaemonAnswerCache } from './lsp-daemon-cache';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { unmeasuredSourceEvidence } from './contracts';
import { produceSnapshotFromSource, writeSnapshotAtomic } from '../../../../scripts/gen-graph-dependency-snapshot.mjs';
import { computeGraphSuggestions, unionSuperset } from '../../../../scripts/lib/graph-dependency-suggestions.mjs';
import { refreshDependencySnapshot } from '../harness/routines/gitnexus-reindex-action';
import { createHash } from 'node:crypto';
import { defineTool, lookupByMcpName, projectedToolCallContract } from '@papercusp/agent-mcp';
import { z } from 'zod';

describe('native P027 R24 recorded consumer disposition coverage', () => {
  const inventory = JSON.parse(readFileSync(new URL(
    '../../../../docs/evidence/native-p042-gitnexus-consumers-2026-10-15.json', import.meta.url), 'utf8')) as {
      consumers: { id: string }[];
      sourceClassificationContinuation20261016: { families: { id: string }[] };
    };
  const decision = JSON.parse(readFileSync(new URL(
    '../../../../docs/evidence/native-p042-consumer-dispositions-2026-10-17.json', import.meta.url), 'utf8')) as {
      consumers: { id: string; disposition: string; ruling: string; evidence: string[]; licenceRoute: string }[];
      outcomeDecisionBoundary: { interpretation: string };
    };
  // Independent correspondence between the source census and D023's grouped
  // rulings. A newly inventoried family must acquire an explicit mapping too.
  const correspondence: Record<string, string[]> = {
    'hourly-maintenance': ['hourly-maintenance'],
    'test-selection': ['test-selection-and-snapshot-health'],
    'curated-native-tools': ['curated-native-tools-and-client-admission'],
    'raw-plugin': ['raw-plugin-and-generic-discovery'],
    'dream-neighbors': ['dream-neighbor-discovery'],
    'selective-assist-and-bench': ['selective-assist-and-controlled-comparison'],
    'docs-and-routing': ['instructions-documents-and-blueprint-references'],
    'plugin-discovery-and-host-lifecycle': ['raw-plugin-and-generic-discovery'],
    'project-history-generation': ['project-history'],
    'snapshot-health-and-index-retention': ['test-selection-and-snapshot-health'],
    'native-client-routing-and-instructions': [
      'curated-native-tools-and-client-admission', 'instructions-documents-and-blueprint-references',
    ],
    's37-w01-behaviour-catalogue': ['s37-w01-and-historical-behavior-measures'],
    'process-admission-and-packaging-guards': ['process-admission-vendor-support-and-distribution'],
  };
  function verify(census: typeof inventory, recorded: typeof decision): string[] {
    const families = census.sourceClassificationContinuation20261016.families;
    if (!census.consumers.length || !families.length) throw new Error('Empty consumer census');
    const rows = new Map(recorded.consumers.map(row => [row.id, row]));
    if (rows.size !== recorded.consumers.length) throw new Error('Duplicate consumer disposition');
    const covered = new Set<string>();
    for (const entry of [...census.consumers, ...families]) {
      const targets = correspondence[entry.id];
      if (!targets?.length) throw new Error(`Unmapped consumer ${entry.id}`);
      for (const id of targets) {
        const row = rows.get(id);
        if (!row) throw new Error(`Missing disposition for ${id}`);
        if (!['keep', 'narrow', 'retire'].includes(row.disposition) || !row.ruling.trim() ||
          !row.licenceRoute.trim() || !row.evidence.length || row.evidence.some(ref => !ref.trim()))
          throw new Error(`Incomplete disposition for ${id}`);
        covered.add(id);
      }
    }
    if (covered.size !== rows.size) throw new Error('Disposition has no inventoried source');
    return [...covered].sort();
  }

  it('accounts for each recorded consumer and source family with an evidence-linked ruling', () => {
    expect(verify(inventory, decision)).toEqual(decision.consumers.map(row => row.id).sort());
    // The recorded decision explicitly separates routing from measured benefit.
    // This record check cannot substitute for the final deployed backend witness.
    expect(decision.outcomeDecisionBoundary.interpretation).toContain('Unknown outcomes are neither zero');
  });

  it.each(decision.consumers.map(row => row.id))('detects a removed disposition for %s', id => {
    const missing = structuredClone(decision);
    missing.consumers = missing.consumers.filter(row => row.id !== id);
    expect(() => verify(inventory, missing)).toThrow(`Missing disposition for ${id}`);
  });

  it('refuses an empty or newly unmapped census instead of passing vacuously', () => {
    expect(() => verify({ ...inventory, consumers: [] }, decision)).toThrow('Empty consumer census');
    expect(() => verify({ ...inventory, consumers: [...inventory.consumers, { id: 'new-retained-backend' }] }, decision))
      .toThrow('Unmapped consumer new-retained-backend');
  });

  it('detects a blank ruling and a duplicated consumer while the complete positive control still works', () => {
    const blank = structuredClone(decision);
    blank.consumers[0]!.ruling = '';
    expect(() => verify(inventory, blank)).toThrow('Incomplete disposition');
    expect(() => verify(inventory, { ...decision, consumers: [...decision.consumers, decision.consumers[0]!] }))
      .toThrow('Duplicate consumer disposition');
    expect(verify(inventory, decision).length).toBeGreaterThan(0);
  });
});

describe('native P021 required BAR bounded source pack expansion', () => {
  it('joins real compiler paths to exact source excerpts and expands omitted consumers after a source edit', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-path-source-bundle-'));
    let artifactPath: string | null = null;
    try {
      writeFileSync(join(project, 'target.ts'), 'export function bundleTarget() { return "CAPTURED_NATIVE_PATH_SOURCE"; }\n');
      for (let index = 0; index < 24; index++) writeFileSync(join(project, `client${index}.ts`),
        `import { bundleTarget } from "./target";\nexport function client${index}() { return bundleTarget(); }\n`);
      const result = (await codePack.handler(codePack.args.parse({ op: 'diff', rootPath: project,
        include: ['*.ts'], explain: { symbol: 'bundleTarget', file: 'target.ts', paths: ['.'], phase: 'pre-edit' } }),
      { projectDir: project } as never) as { data: { answer: CodeIntelAnswer; report: NativeChangeReport } }).data;
      expect(result.answer.error).toBeNull();
      const bundle = result.report.bundle;
      artifactPath = bundle.expansion.args.file_path;
      expect(bundle.context.sources).toContainEqual(expect.objectContaining({ path: 'target.ts',
        text: expect.stringContaining('CAPTURED_NATIVE_PATH_SOURCE'), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
      expect(bundle.omitted.symbols + bundle.omitted.edges + bundle.omitted.paths).toBeGreaterThan(0);
      expect(bundle.tokens.retained).toBeLessThanOrEqual(bundle.tokens.budget);
      expect(bundle.coverage).toMatchObject({ sourceCompleteness: 'unverified', unavailableFiles: [] });
      writeFileSync(join(project, 'target.ts'), 'export function bundleTarget() { return "NEW_NATIVE_SOURCE"; }\n');
      const document = readFileSync(artifactPath, 'utf8');
      expect(createHash('sha256').update(document).digest('hex')).toBe(bundle.expansion.sha256);
      const expanded = JSON.parse(document);
      expect(expanded.context.symbols.length).toBeGreaterThan(bundle.context.symbols.length);
      expect(expanded.context.paths).toHaveLength(20);
      expect(bundle.coverage.backendTruncated).toBe(true);
      expect(expanded.context.edges).toHaveLength(20);
      expect(expanded.context.edges.every((edge: { origin: string; knowledge: string; runtimeExecution: string }) =>
        edge.origin === 'compiler' && edge.knowledge === 'observed' && edge.runtimeExecution === 'unknown')).toBe(true);
      expect(document).toContain('CAPTURED_NATIVE_PATH_SOURCE');
      expect(document).not.toContain('NEW_NATIVE_SOURCE');
    } finally {
      if (artifactPath) rmSync(artifactPath, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  it('retains a bounded actual source preview and recovers omitted evidence from its captured artifact after the source changes', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-source-bundle-'));
    let artifactPath: string | null = null;
    const source = `${'// source text 你好🙂\n'.repeat(500)}export const omittedEvidence = "OMITTED_NATIVE_EVIDENCE";\n`;
    try {
      writeFileSync(join(project, 'target.ts'), source);
      const response = await codePack.handler(codePack.args.parse({ op: 'pack', rootPath: project, include: ['target.ts'] }),
        { projectDir: project } as never) as { data: import('./packer-facade').PackerResult };
      expect(response.data.answer.error, JSON.stringify(response.data.answer)).toBeNull();
      const artifact = response.data.artifact!, bundle = artifact.bundle!;
      artifactPath = artifact.path;
      expect(bundle).toMatchObject({ kind: 'captured-source', sourcePaths: ['target.ts'], truncated: true,
        expansion: { tool: 'capability:read' } });
      expect(artifact.preview).not.toContain('OMITTED_NATIVE_EVIDENCE');
      expect(bundle.tokens.retained).toBeGreaterThan(0);
      expect(bundle.tokens.retained).toBeLessThanOrEqual(bundle.tokens.budget);
      writeFileSync(join(project, 'target.ts'), 'export const replacement = true;\n');
      // Expansion is of the captured evidence, not a silently re-run query over
      // today's source. Its full hash stays stable after the source moves.
      const captured = readFileSync(bundle.expansion.args.file_path, 'utf8');
      expect(captured).toContain('OMITTED_NATIVE_EVIDENCE');
      expect(captured).not.toContain('replacement = true');
      expect(createHash('sha256').update(captured).digest('hex')).toBe(bundle.sha256);
      expect(bundle.expansion.sha256).toBe(bundle.sha256);
      expect(artifact.provenance.denyGlobs).toContain('**/.env');
    } finally {
      if (artifactPath) rmSync(artifactPath, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('native P014 required BAR registered interface consumer mismatch', () => {
  it('joins the real compiler report to a registered result contract and exposes a removed field to its typed and runtime client', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-interface-contract-'));
    const logs: string[] = [];
    let response: Record<string, string> = { value: 'ok' };
    const name = 'native-p014-fixture:read';
    const outputValidation = process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT;
    const request = z.object({});
    const result = z.object({ value: z.string() });
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: request, result,
      description: 'Isolated P014 interface contract fixture', handler: async () => ({ data: response }) });
    const ctx = { workspaceId: 'native-p014', runId: 'fixture', signal: new AbortController().signal,
      log: (line: string) => logs.push(line), progress: () => {}, emit: () => {} };
    const report = async () => (await codePack.handler(codePack.args.parse({ op: 'diff', rootPath: project,
      include: ['*.ts'], explain: { symbol: 'readApi', file: 'target.ts', paths: ['.'], phase: 'pre-edit' } }),
    { projectDir: project } as never) as { data: { report: NativeChangeReport } }).data.report;
    try {
      process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT = '1';
      writeFileSync(join(project, 'target.ts'), 'export interface Response { value: string; }\nexport function readApi(): Response { return { value: "ok" }; }\n');
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().value.length; }\n');
      writeFileSync(join(project, 'contract.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\nimport { z } from "zod";\nimport { readApi } from "./target";\nconst request = z.object({}); const result = z.object({ value: z.string() });\nexport const tool = defineTool({ name: "native-p014-fixture:read", args: request, result, handler: readApi, description: "fixture contract" });\n');
      const registered = lookupByMcpName(name)!;
      expect(registered).toBeDefined();
      expect(projectedToolCallContract(name)).toMatchObject({ returns: { source: 'registered-output-schema',
        outputJsonSchema: { required: ['value'], properties: { value: { type: 'string' } } } } });
      await registered.fn(request.parse({}), ctx);
      expect(logs.join(' ')).not.toContain('[output-schema]');
      const before = await report();
      expect(before.interfaces.status).toBe('measured');
      expect(before.interfaces.mismatchedConsumers).toEqual([]);
      expect(before.interfaces.registrations).toContainEqual(expect.objectContaining({ name, factoryAuthority: 'maintained-import',
        responseValidator: expect.objectContaining({ path: 'contract.ts', line1: 4 }),
        implementation: expect.objectContaining({ path: 'target.ts', line1: 2 }), runtimeRegistered: 'unmeasured' }));
      writeFileSync(join(project, 'target.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
      response = { label: 'ok' };
      await registered.fn(request.parse({}), ctx);
      // The maintained runtime validator logs mismatches rather than rejecting
      // the whole call. Assert its actual policy, not an invented rejection.
      expect(logs.join(' ')).toMatch(/\[output-schema\].*native-p014-fixture:read.*value/);
      expect(result.safeParse(response).success).toBe(false);
      const after = await report();
      expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
      expect(after.interfaces.diagnostics).toContainEqual(expect.objectContaining({ code: 2339,
        site: expect.objectContaining({ path: 'client.ts', line1: 2 }), message: expect.stringContaining("'value'") }));
      expect(after.interfaces.mismatchedConsumers).toContainEqual(expect.objectContaining({ path: 'client.ts', line1: 2 }));
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().label.length; }\n');
      expect((await report()).interfaces.mismatchedConsumers).toEqual([]);
    } finally {
      if (outputValidation === undefined) delete process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT;
      else process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT = outputValidation;
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('native P012 required BAR scoped claim and canonical resume integration', () => {
  it('uses the real safe packer/compiler and replaces stale excerpts without widening task scope', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-task-brief-')));
    const item = { id: 'WI-native-private-brief', harness: 'private-brief', state: 'open',
      payload: { paths: ['target.ts', 'consumer.ts', 'target.test.ts', 'guide.md'] } };
    const source = async () => ({ taskBrief: await buildTaskBrief({ workspaceId: 'private-workspace', workItem: item }, {
      root: async (workspace, harness) => workspace === 'private-workspace' && harness === 'private-brief' ? root : null,
      effects: DEFAULT_PACKER_EFFECTS, pack: packerFacade,
      graph: (repo, name, filePath, paths, budgetMs) => firstPartyCallersOffthread({ root: repo, name, filePath,
        paths, op: 'callers', limit: 8, vendorDir: LSP_VENDOR_DIR }, { budgetMs }),
    }) });
    const deps = { checkpoint: async () => ({ checkpoint: null, updatedAtMs: null }),
      freshness: async () => undefined, evidence: async () => [], taskBrief: source };
    try {
      writeFileSync(join(root, 'target.ts'), 'export function nativeBriefTarget() { return "BEFORE_NATIVE_EDIT"; }\n');
      writeFileSync(join(root, 'consumer.ts'), 'import { nativeBriefTarget } from "./target";\nexport const used = nativeBriefTarget();\n');
      writeFileSync(join(root, 'target.test.ts'), 'import { nativeBriefTarget } from "./target";\nexport const checked = nativeBriefTarget();\n');
      writeFileSync(join(root, 'guide.md'), 'Source-linked target.ts usage.\n');
      writeFileSync(join(root, 'unrelated.ts'), 'OUTSIDE_TASK_SCOPE_MUST_NOT_APPEAR');
      writeFileSync(join(root, '.env'), 'PRIVATE_SECRET_MUST_NOT_APPEAR');
      const before = await source();
      expect(before.taskBrief.status, JSON.stringify(before.taskBrief)).toBe('current');
      expect(before.taskBrief.graph.consumers).toContain('consumer.ts:2');
      expect(before.taskBrief.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'guide.md', kind: 'doc' }), expect.objectContaining({ path: 'target.test.ts', kind: 'test' })]));
      expect(before.taskBrief.recover).toHaveProperty('args.rootPath', root);
      expect(JSON.stringify(before.taskBrief)).toContain('BEFORE_NATIVE_EDIT');
      writeFileSync(join(root, 'target.ts'), 'export function nativeBriefTarget() { return "AFTER_NATIVE_EDIT"; }\n');
      const resumed = await readWorkItemResume(item, deps);
      expect(resumed.taskBrief?.status, JSON.stringify(resumed.taskBrief)).toBe('current');
      expect(resumed.taskBrief).not.toHaveProperty('sourceFingerprint', before.taskBrief.sourceFingerprint);
      expect(JSON.stringify(resumed.taskBrief)).toContain('AFTER_NATIVE_EDIT');
      expect(JSON.stringify(resumed)).not.toMatch(/BEFORE_NATIVE_EDIT|OUTSIDE_TASK_SCOPE|PRIVATE_SECRET/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
import { captureCodeDependencies, assertCodeDependencyVersions } from '../agent-tools/plans/code-dependency-evidence';
import { classifySpecEvidenceCurrentness, measureAndPinRepoFilesEvidenceAtRoot } from '../agent-tools/plans/spec-evidence-store';
import { evaluateServingRuntime } from '../serving-runtimes';
import { evaluateAcceptedSourceContainment } from '../git-pipeline-position';
import type { SourceRuntimeProvenance } from './source-runtime-provenance';
import type { NativeChangeReport } from './packer-facade';

describe('native P011 required BAR registered per-symbol static test reach', () => {
  it('suggests the compiler-resolved calling test and reports a scoped gap after its reference is removed', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-test-reach-compiler-'));
    const call = async () => (await codePack.handler(codePack.args.parse({ op: 'diff', rootPath: project,
      include: ['*.ts'], explain: { symbol: 'changedTarget', file: 'target.ts', paths: ['.'], phase: 'pre-edit' } }),
    { projectDir: project } as never) as { data: { answer: CodeIntelAnswer; report: NativeChangeReport } }).data;
    try {
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 1; }\n');
      writeFileSync(join(project, 'bridge.ts'), 'import { changedTarget as alias } from "./target";\nexport function bridge() { return alias(); }\n');
      writeFileSync(join(project, 'reference.test.ts'), 'import { bridge } from "./bridge";\nexport function referenceTest() { return bridge(); }\n');
      writeFileSync(join(project, 'other.ts'), 'export function changedTarget() { return 2; }\n');
      writeFileSync(join(project, 'unrelated.test.ts'), 'import { changedTarget } from "./other";\nexport function unrelatedTest() { return changedTarget(); }\n');
      const before = await call();
      expect(before.answer.error).toBeNull();
      expect(before.report.testReach).toMatchObject({ symbol: 'changedTarget', file: 'target.ts', status: 'found',
        tests: [expect.objectContaining({ path: 'reference.test.ts' })], executionCoverage: 'unmeasured', gapSuggestion: null });
      expect(before.report.testReach.paths).toEqual([expect.objectContaining({ testPath: 'reference.test.ts', walk: 'reverse', siteIndices: [0, 1] })]);
      expect(before.report.testReach.tests.some(site => site.path === 'unrelated.test.ts')).toBe(false);
      writeFileSync(join(project, 'reference.test.ts'), 'export function referenceTest() { return 1; }\n');
      const after = await call();
      expect(after.answer.error).toBeNull();
      expect(after.report.testReach).toMatchObject({ status: 'not-found-in-scope', tests: [], paths: [], executionCoverage: 'unmeasured' });
      expect(after.report.testReach.gapSuggestion).toContain('run the baseline suite');
      expect(after.report.sourceFingerprint).not.toBe(before.report.sourceFingerprint);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P015 required BAR compiler dependency proof', () => {
  it('requires re-verification after a compiler-resolved dependency changes or disappears', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-proof-compiler-'));
    try {
      writeFileSync(join(project, 'consumer.ts'), 'import { dependency } from "./dependency";\nexport function consumer() { return dependency(); }\n');
      writeFileSync(join(project, 'dependency.ts'), 'export function dependency() { return 1; }\n');
      const captured = await captureCodeDependencies(project,
        { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['consumer.ts'] },
        [{ name: 'consumer', file: 'consumer.ts', paths: ['.'] }]);
      expect(captured.measurement.sourcePaths).toEqual(['consumer.ts', 'dependency.ts']);
      expect(captured.evidence.sources).toEqual(expect.arrayContaining([expect.objectContaining({
        path: 'dependency.ts', contentHash: createHash('sha256').update(readFileSync(join(project, 'dependency.ts'))).digest('hex'),
      })]));
      const measured = await measureAndPinRepoFilesEvidenceAtRoot(project, captured.measurement);
      assertCodeDependencyVersions(captured.evidence.sources, measured.pin);
      const row = { spec_is_current: true, source_fingerprint: measured.sourceFingerprint,
        test_fingerprint: null, fixture_fingerprint: null, rubric_fingerprint: null, environment_fingerprint: null,
        coverage_evidence_ref: null, coverage_evidence_present: false, test_run_id: null, test_run_present: false };
      const current = (sourceFingerprint: string) => classifySpecEvidenceCurrentness(row,
        { evidenceKind: 'test', evidenceRef: 'reference-proof', sourceFingerprint }, { provenance: 'server-measured' });
      expect(current(measured.sourceFingerprint).overall).toBe('current');
      writeFileSync(join(project, 'dependency.ts'), 'export function dependency() { return 2; }\n');
      const edited = await measureAndPinRepoFilesEvidenceAtRoot(project, captured.measurement);
      expect(current(edited.sourceFingerprint)).toMatchObject({ overall: 'stale', staleReasons: ['source-stale'] });
      expect(() => assertCodeDependencyVersions(captured.evidence.sources, edited.pin)).toThrow('does_not_match_measured_source');
      rmSync(join(project, 'dependency.ts'));
      await expect(measureAndPinRepoFilesEvidenceAtRoot(project, captured.measurement)).rejects.toThrow();
      expect(row.source_fingerprint).toBe(measured.sourceFingerprint);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P017 R3 registered graph source scope', () => {
  it('versions both ends of a compiler edge and re-resolves the target after an unchanged caller sees a dependency edit', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'native-edge-source-scope-')));
    const sha = (path: string) => createHash('sha256').update(readFileSync(join(project, path))).digest('hex');
    const repositoryId = `local-root:${createHash('sha256').update(project).digest('hex')}`;
    const query = async () => (await graphQuery.handler(graphQuery.args.parse({ op: 'callees',
      name: 'runtimeSourceCaller', file_path: 'caller.ts', paths: ['caller.ts'] }),
    { projectDir: project } as never) as { data: CodeIntelAnswer }).data;
    try {
      writeFileSync(join(project, 'dependency.ts'), 'export function runtimeSourceTarget() { return 1; }\n');
      writeFileSync(join(project, 'caller.ts'), 'import { runtimeSourceTarget } from "./dependency";\nexport function runtimeSourceCaller() { return runtimeSourceTarget(); }\n');
      const before = await query();
      const assertScope = (answer: CodeIntelAnswer) => {
        expect(answer.error).toBeNull();
        expect(answer.evidence!.sourceScope).toMatchObject({ repositoryId, identityKind: 'local-root', paths: ['caller.ts'] });
        expect(answer.evidence!.sourceScope.supportingFiles).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: 'caller.ts', contentHash: sha('caller.ts'), representation: 'full-source' }),
          expect.objectContaining({ path: 'dependency.ts', contentHash: sha('dependency.ts'), representation: 'full-source' }),
        ]));
        expect(answer.evidence!.siteIdentities).toEqual([expect.objectContaining({ sourcePath: 'caller.ts',
          contentHash: sha('caller.ts'), versionedSymbolId: expect.stringContaining(repositoryId) })]);
        const edge = answer.evidence!.relationships.find(row => row.kind === 'callees');
        expect(edge).toMatchObject({ origin: 'compiler', runtimeExecution: 'unknown',
          target: { contentHash: sha('dependency.ts'), versionedSymbolId: expect.stringContaining(repositoryId) } });
        return edge!.target!.versionedSymbolId;
      };
      const beforeTarget = assertScope(before);
      writeFileSync(join(project, 'dependency.ts'), 'export function runtimeSourceTarget() { return 2; }\n');
      const after = await query();
      const afterTarget = assertScope(after);
      expect(after.evidence!.siteIdentities).toEqual(before.evidence!.siteIdentities);
      expect(afterTarget).not.toBe(beforeTarget);
      expect(after.evidence!.sourceScope.sourceFingerprint).not.toBe(before.evidence!.sourceScope.sourceFingerprint);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P017 required BAR registered compiler runtime join', () => {
  it('identifies the loaded artifact and refuses to substitute a later compiler source version', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-runtime-compiler-'));
    const file = join(project, 'target.ts');
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      writeFileSync(file, 'export function target() { return 1; }\n');
      git(['init', '-q']); git(['config', 'user.name', 'native runtime BAR fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']); git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'loaded artifact']);
      const buildSha = git(['rev-parse', 'HEAD']);
      const loadedHash = createHash('sha256').update(readFileSync(file)).digest('hex');
      const dispatchTool = async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('dev:pipeline_position');
        expect(args.path).toBe('target.ts');
        const runtime = evaluateServingRuntime({ runtime: 'staging-operator', role: 'owner', pid: 42,
          startedAtMs: Date.now(), buildSha, buildShaSource: 'health', blobContains: args.expectedSourceSha256 === loadedHash,
          blobUnknown: null, fileMtimeMs: null, instances: null });
        return { data: { repoRoot: project, submodule: null, servingRuntimes: [runtime],
          acceptedSource: evaluateAcceptedSourceContainment(args.expectedSourceSha256 as string, readFileSync(file), null, [runtime]) } };
      };
      const query = async () => (await graphQuery.handler(graphQuery.args.parse({ op: 'symbol', name: 'target', file_path: 'target.ts',
        paths: ['.'], runtime: 'staging-operator' }), { projectDir: project, dispatchTool } as never) as {
          data: CodeIntelAnswer & { runtimeProvenance: SourceRuntimeProvenance } }).data;
      const before = await query();
      expect(before.error).toBeNull();
      expect(before.runtimeProvenance.repositoryId).toBe(before.evidence!.sourceScope.repositoryId);
      expect(before.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: loadedHash,
        artifact: expect.objectContaining({ buildSha }), containsCapturedSource: true })]);
      writeFileSync(file, 'export function target() { return 2; }\n');
      const editedHash = createHash('sha256').update(readFileSync(file)).digest('hex');
      const after = await query();
      expect(after.error).toBeNull();
      expect(after.evidence!.siteIdentities[0]!.contentHash).toBe(editedHash);
      expect(after.runtimeProvenance.sourceFingerprint).not.toBe(before.runtimeProvenance.sourceFingerprint);
      expect(after.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: editedHash,
        editedSourceSha256: editedHash, artifact: expect.objectContaining({ buildSha }), containsCapturedSource: false })]);
      expect(after.runtimeProvenance.limitations.join(' ')).toMatch(/neither establishes runtime execution/);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P010 registered diff handler compiler integration', () => {
  it('cites the edited symbol reference consumer and rechecks it before review', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-report-handler-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    const args = { op: 'diff', rootPath: project, include: ['*.ts'], baseRef: 'HEAD',
      explain: { symbol: 'changedTarget', file: 'target.ts', paths: ['.'], phase: 'pre-review' } };
    const call = async (previousFingerprint?: string) => {
      const result = await codePack.handler(codePack.args.parse({ ...args,
        explain: { ...args.explain, previousFingerprint } }), { projectDir: project } as never);
      return (result as { data: { answer: CodeIntelAnswer; report: {
        consumers: CodeIntelAnswer['sites']; changed: { path: string }[]; sourceFingerprint: string;
        freshness: string; limitations: string[];
      } } }).data;
    };
    try {
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 1; }\n');
      writeFileSync(join(project, 'consumer.ts'), 'import { changedTarget } from "./target";\nexport function useTarget() { return changedTarget(); }\n');
      git(['init', '-q']);
      git(['config', 'user.name', 'native handler private fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']);
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reference fixture']);
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 2; }\n');
      const first = await call();
      expect(first.answer.error).toBeNull();
      expect(first.answer.backend).toBe('typescript-service');
      expect(first.report.consumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'consumer.ts', line1: 2 }),
      ]));
      expect(first.report.changed).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target.ts' })]));
      expect((await call(first.report.sourceFingerprint)).report.freshness).toBe('unchanged');
      writeFileSync(join(project, 'consumer.ts'), 'export function useTarget() { return 2; }\n');
      const edited = await call(first.report.sourceFingerprint);
      expect(edited.report.consumers).toEqual([]);
      expect(edited.report.freshness).toBe('changed');
      expect(edited.report.limitations.some(line => line.includes('runtime execution'))).toBe(true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P009 regular refresh integration', () => {
  it('hands source-derived consumers to the selector and preserves baseline on source drift', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-snapshot-handover-'));
    const out = join(project, 'snapshot.json');
    const files = ['src/target.ts', 'consumer/use.ts'];
    const now = Date.now();
    const readSource = (path: string) => {
      try { return readFileSync(join(project, path), 'utf8'); } catch { return null; }
    };
    try {
      for (const path of files) mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, files[0]), 'export const target = 1;\n');
      writeFileSync(join(project, files[1]), 'import { target } from "../src/target";\nexport const used = target;\n');
      const result = await refreshDependencySnapshot({ root: project, repoName: 'papercusp', currentIndexCommit: null, prev: null }, {
        out, now: () => now, produce: async (_root, _repo, output, deps) => {
          expect(deps?.backend).toBe('first-party-imports');
          const { snapshot } = produceSnapshotFromSource({ files, readSource, headCommit: 'a'.repeat(40), now });
          writeSnapshotAtomic(output, snapshot);
          return { exit: 0, line: 'GRAPH_SNAPSHOT status=written edges=1', at: now };
        },
      });
      expect(result).toMatchObject({ ran: true, next: { status: 'fresh', edges: 1 } });
      const select = () => computeGraphSuggestions({ changed: ['src/target.ts'], snapshotPath: out,
        readFile: (path: string) => readFileSync(path, 'utf8'), readSource,
        ownerOfPath: (path: string) => path === files[1] ? ['reference-consumer'] : [], now });
      expect(select()).toMatchObject({ status: 'applied', workspaces: ['reference-consumer'], accepted: 1, rejected: 0 });
      expect(unionSuperset(new Set(['baseline']), select().workspaces).names).toEqual(['baseline', 'reference-consumer']);
      writeFileSync(join(project, files[1]), 'export const used = 0;\n');
      expect(select()).toMatchObject({ workspaces: [], accepted: 0, rejected: 1 });
      expect(unionSuperset(new Set(['baseline']), select().workspaces).names).toEqual(['baseline']);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});

describe('native managed cache filesystem reconciliation', () => {
  it('reconciles missed dependency edits and deletes without changing the query cursor', async () => {
    const project = mkdtempSync(join(tmpdir(), 'native-cache-contract-'));
    const target = join(project, 'target.ts');
    writeFileSync(target, 'function target() {}\n');
    writeFileSync(join(project, 'consumer.ts'), 'target();\n');
    const revision = { measured: true as const, identity: 'fixture-source-producer' };
    const cache = new LspDaemonAnswerCache({ prepare: async () => revision, current: () => revision });
    // This independent producer isolates filesystem/cache reconciliation.
    // The pinned integration suite separately exercises the managed compiler.
    const producer = async (): Promise<LspDaemonAnswer> => {
      const source = existsSync(target) ? readFileSync(target, 'utf8') : null;
      const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: 'definition', query: 'consumer.ts',
        sites: source === null ? [] : [{ path: 'target.ts', line1: source.startsWith('\n') ? 2 : 1, kind: 'function' }],
        truncation: { truncated: false, totalAvailable: source === null ? 0 : 1, continuation: null },
        freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
      const evidence = unmeasuredSourceEvidence(answer,
        { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
      return { ...answer, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope, sourceFingerprint: source ?? 'deleted' } } };
    };
    const request = { workspaceId: 'native-cache-contract', op: 'symbol' as const,
      args: { file: join(project, 'consumer.ts'), rootPath: project, line1: 1, character: 5 } };
    const query = () => cache.query(request, 'typescript', project, new AbortController().signal, producer);
    try {
      expect((await query()).sites[0]?.line1).toBe(1);
      expect((await query()).daemonCache?.state).toBe('hit');
      const stamp = statSync(target);
      writeFileSync(target, '\nfunction target() {}');
      utimesSync(target, stamp.atime, stamp.mtime);
      const edited = await query();
      expect(edited.daemonCache?.state).toBe('miss');
      expect(edited.sites).toEqual((await producer()).sites);
      expect(edited.sites[0]?.line1).toBe(2);
      rmSync(target);
      const deleted = await query();
      expect(deleted.daemonCache?.state).toBe('miss');
      expect(deleted.sites).toEqual([]);
      expect((await query()).sites).toEqual([]);
    } finally { cache.clear(); rmSync(project, { recursive: true, force: true }); }
  });
});

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../docs/evidence/native-code-intelligence-baseline-2026-10-09.json', import.meta.url,
)), 'utf8')) as { routes: Array<{ tool: string; operations: string[]; backend?: string }> };

let root = '';
let server: Server;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
const rpcOperations: string[] = [];
const put = (path: string, text: string) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'native-baseline-'));
  put('tsconfig.json', JSON.stringify({ compilerOptions: {
    target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true,
  } }));
  put('src/target.ts', 'export function baselineTarget(n: number) { return n + 1; }\n');
  put('src/barrel.ts', 'export * from "./target";\n');
  put('src/consumer.ts', [
    'import { baselineTarget } from "./barrel";',
    '// baselineTarget(99) is a comment',
    'export const label = "baselineTarget(99) is a string";',
    'export const answer = baselineTarget(1);',
    '',
  ].join('\n'));
  process.env[LSP_DAEMON_SOCKET_ENV] = join(root, 'baseline.sock');
  server = runLspDaemonServer(async request => {
    rpcOperations.push(request.op);
    // This file imports the P026 acceptance suite into the same Vitest worker.
    // Its fixture hook may run before this baseline hook, while the process
    // environment then points at this socket for both suites. Keep the
    // baseline stub scoped to its own tree and delegate foreign roots to the
    // real daemon dispatcher instead of asserting against another suite's
    // request.
    if (request.args.rootPath !== root) {
      return dispatchLspDaemonRequest(request, `native-ecosystem-delegated-${rpcOperations.length}`,
        new AbortController().signal);
    }
    // Provider fixture models the daemon seam. This proves handler/facade/RPC
    // selection, while the compiler tests below independently exercise TS.
    return { backend: 'lsp-adapter', intent: 'references', query: request.op,
      sites: [{ path: 'src/consumer.ts', line1: 4, kind: 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null },
      latencyMs: 0, error: null };
  });
  await once(server, 'listening');
});
afterAll(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  if (root) rmSync(root, { recursive: true, force: true });
});

const query = async (name: string, paths?: string[]): Promise<CodeIntelAnswer> => {
  const result = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name, paths }),
    { projectDir: root } as never) as { data: CodeIntelAnswer };
  return result.data;
};
const locations = (answer: CodeIntelAnswer) => answer.sites.map(site => `${site.path}:${site.line1}`).sort();

describe('native syntax intent admission through the registered surface', () => {
  it('rejects an unadmitted grammar at the real tool argument boundary', () => {
    expect(() => codeStructural.args.parse({ op: 'syntax_index', language: 'cpp',
      paths: ['src/unsupported.cpp'] })).toThrow(/language/);
  });

  it('refuses an unsupported source extension through the actual syntax handler', async () => {
    put('src/unsupported.cpp', 'class Unsupported {};\n');
    const args = codeStructural.args.parse({ op: 'syntax_index', language: 'ts',
      paths: ['src/unsupported.cpp'] });
    const result = await codeStructural.handler(args, { projectDir: root } as never) as { data: CodeIntelAnswer };
    expect(result.data.error).toContain('unsupported source extension');
    expect(result.data.sites).toEqual([]);
    expect(result.data.freshness.health).toBe('unknown');
  });
});

describe('native baseline real compiler route', () => {
  it('matches the recorded route and an independently enumerated barrel consumer', async () => {
    const answer = await query('baselineTarget');
    const recorded = baseline.routes.find(row => row.tool === 'graph:query' && row.operations.includes('callers'));
    expect(answer.error).toBeNull();
    expect(answer.backend).toBe(recorded?.backend);
    // Literal oracle: declarations, comments and strings are deliberately excluded.
    expect(locations(answer)).toEqual(['src/consumer.ts:4']);
    expect(answer.freshness.health).toBe('healthy');
  }, 60_000);

  it('reconciles changed and deleted callers from current source rather than an old index', async () => {
    put('src/changed.ts', 'import { baselineTarget } from "./target";\nexport const fresh = baselineTarget(2);\n');
    try {
      expect(locations(await query('baselineTarget'))).toEqual(['src/changed.ts:2', 'src/consumer.ts:4']);
      put('src/changed.ts', '// baselineTarget(2) was removed\nexport const fresh = 2;\n');
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
      rmSync(join(root, 'src/changed.ts'));
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
    } finally { rmSync(join(root, 'src/changed.ts'), { force: true }); }
  }, 60_000);

  it('distinguishes a measured empty from an invalid search scope', async () => {
    const empty = await query('absentBaselineSymbol');
    expect(empty.error).toBeNull();
    expect(empty.sites).toEqual([]);
    expect(empty.freshness.health).toBe('healthy');
    const refused = await query('baselineTarget', ['../outside']);
    expect(refused.error).toMatch(/outside the repository/);
    expect(refused.freshness.health).toBe('unhealthy');
  }, 60_000);

  it('preserves the separate internal-comparison and distribution decisions', () => {
    expect(admitArm('gitnexus@1.6.9').admission.distribution?.decision).toBe('excluded');
    expect(() => admitArm('gitnexus@1.6.9', undefined, 'distribution')).toThrow(/excluded from product distribution/);
    expect(() => admitArm('no-third-party', undefined, 'distribution')).toThrow(/no explicit approved decision/);
  });
});

describe('native baseline admitted operation inventory across real interfaces', () => {
  const operations = (tool: string) => baseline.routes.filter(row => row.tool === tool)
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));

  it.each(operations('graph:query').filter(row => row.op === 'health'))(
    'graph $op reaches the recorded $backend provider through the actual facade', async ({ op, backend }) => {
      const dispatched: string[] = [];
      const result = await graphQuery.handler(graphQuery.args.parse({ op, name: 'baselineTarget' }), {
        projectDir: root,
        dispatchTool: async (tool: string) => {
          dispatched.push(tool);
          throw new Error('baseline indexed provider sentinel');
        },
      } as never) as { data: CodeIntelAnswer };
      expect(result.data.backend).toBe(backend);
      expect(result.data.error).toContain('baseline indexed provider sentinel');
      expect(dispatched[0]).toBe('gitnexus.list_repos');
      expect(dispatched).toEqual(op === 'health' ? ['gitnexus.list_repos']
        : ['gitnexus.list_repos', op === 'impact' ? 'gitnexus.impact' : 'gitnexus.context']);
    });

  it('P007 exposed context returns the known outgoing call and measured compiler input versions', async () => {
    put('src/graph-helper.ts', 'export function nativeHelper() { return 1; }\n');
    put('src/graph-context.ts', 'import { nativeHelper } from "./graph-helper";\nexport function nativeCompose() {\n  return nativeHelper();\n}\n');
    const result = await graphQuery.handler(graphQuery.args.parse({ op: 'context', name: 'nativeCompose',
      file_path: 'src/graph-context.ts' }), { projectDir: root } as never) as { data: CodeIntelAnswer };
    expect(result.data.error).toBeNull();
    expect(result.data.backend).toBe('typescript-service');
    expect(result.data.sites).toEqual([
      expect.objectContaining({ path: 'src/graph-context.ts', line1: 2 }),
      expect.objectContaining({ path: 'src/graph-context.ts', line1: 3, name: 'nativeHelper' }),
      expect.objectContaining({ path: 'src/graph-context.ts', line1: 1, name: 'nativeHelper' }),
    ]);
    expect(result.data.evidence!.relationships.map(r => r.kind)).toEqual(['definition', 'callees', 'imports']);
    expect(result.data.evidence!.sourceScope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.evidence!.siteIdentities.every(s => s.contentHash && s.versionedSymbolId)).toBe(true);
  }, 60_000);

  it('P007 real context worker consolidates heritage, members, overrides and typed field accesses', async () => {
    put('src/context-model.ts', [
      'export interface Runner { run(): number; }',
      'export class Base {',
      '  value = 0;',
      '  run() { return this.value; }',
      '}',
      'export class Derived extends Base implements Runner {',
      '  override run() { this.value++; return this.value; }',
      '}',
      '',
    ].join('\n'));
    const run = async (name: string, line1?: number) => (await graphQuery.handler(graphQuery.args.parse({
      op: 'context', name, file_path: 'src/context-model.ts', line1,
    }), { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
    const derived = await run('Derived');
    expect(derived.error).toBeNull();
    const edges = derived.evidence!.relationships.map(edge => [edge.kind, derived.sites[edge.siteIndex]!.line1, edge.target?.site.line1]);
    expect(edges).toEqual(expect.arrayContaining([
      ['inheritance', 6, 2], ['implementations', 6, 1], ['members', 7, 7], ['overrides', 7, 4],
    ]));
    const field = await run('value', 3);
    expect(field.error).toBeNull();
    expect(field.evidence!.relationships.filter(edge => edge.kind === 'field-write')
      .map(edge => field.sites[edge.siteIndex]!.line1)).toEqual([7]);
    expect(field.evidence!.relationships.filter(edge => edge.kind === 'field-read')
      .map(edge => field.sites[edge.siteIndex]!.line1)).toEqual([4, 7]);
    for (const answer of [derived, field]) {
      expect(answer.evidence!.siteIdentities.every(site => site.contentHash && site.versionedSymbolId)).toBe(true);
      expect(answer.evidence!.relationships.every(edge => edge.runtimeExecution === 'unknown')).toBe(true);
      expect(answer.evidence!.relationships.filter(edge => edge.target).every(edge => edge.target!.contentHash && edge.target!.versionedSymbolId)).toBe(true);
    }
  }, 60_000);

  it.each([['rust', '.rs'], ['python', '.py'], ['go', '.go']])('P007 exposed context labels %s as unsupported rather than compiler-backed', async (language, extension) => {
    put(`src/unadmitted${extension}`, 'target();\n');
    const result = await graphQuery.handler(graphQuery.args.parse({ op: 'context', name: 'target',
      file_path: `src/unadmitted${extension}` }), { projectDir: root } as never) as { data: CodeIntelAnswer };
    expect(result.data.error).toContain('unsupported');
    expect(result.data.sites).toEqual([]);
    expect(result.data.evidence!.languageCapabilities).toEqual([{ language, intent: 'definition', status: 'unsupported' }]);
  }, 60_000);

  it.each(operations('lsp:query'))('LSP $op crosses the real daemon RPC route', async ({ op, backend }) => {
    const before = rpcOperations.length;
    const result = await lspQuery.handler(lspQuery.args.parse({ op, file: 'src/target.ts',
      line1: 1, character: 17, name: 'baselineTarget', newName: 'renamed' }),
    { projectDir: root, workspaceId: 'native-baseline-fixture' } as never) as { data: CodeIntelAnswer };
    expect(result.data.error).toBeNull();
    expect(result.data.backend).toBe(backend);
    expect(result.data.sites).toEqual([{ path: 'src/consumer.ts', line1: 4, kind: 'reference' }]);
    expect(rpcOperations.slice(before)).toEqual([op]);
  });

  it.each(operations('code:pack'))('packing $op selects the recorded $backend engine in the actual facade',
    async ({ op, backend }) => {
      const result = await codePack.handler(codePack.args.parse({ op, include: ['src/**'] }),
        { projectDir: root } as never) as { data: { answer: CodeIntelAnswer } };
      expect(result.data.answer.backend).toBe(backend);
      // The fixture has no git repository; diff/provisioning failures remain
      // typed errors. Only engine selection is the inventory claim here.
      expect(result.data.answer).toHaveProperty('error');
    }, 60_000);
});
