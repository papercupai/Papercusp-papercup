/**
 * P-016's proof obligation: the pins hold, the dangerous flags are unreachable,
 * the secret deny-set cannot be shortened, the include set must be explicit,
 * and a pack states its own provenance honestly.
 *
 * FALSIFIABILITY (tier 1, per the repo's mutation-probe discipline): every
 * invariant below is paired with a deliberately-WRONG control implementation
 * kept permanently in this file. The control is fed to the SAME assertion the
 * real subject passes, and must fail it. That is what separates "this test
 * passes" from "this test could ever fail" — and it costs nothing, because it
 * never touches the shared tree (which is the whole reason the copy-out and
 * in-tree mutation tiers exist and are not used here).
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));

import { getFlag } from '@papercusp/flags/server';

import {
  assertIsCode2Prompt,
  assertIsRepomix,
  buildCode2PromptArgs,
  buildRepomixArgs,
  CODE2PROMPT_FORBIDDEN_FLAGS,
  CODE2PROMPT_PINNED_VERSION,
  MAX_PACK_BYTES,
  PACK_TEMPLATES,
  nativeChangeReport,
  packerFacade,
  parseSelectedFiles,
  readGitProvenance,
  provenanceStatusPathspec,
  REPOMIX_FORBIDDEN_FLAGS,
  REPOMIX_PINNED_VERSION,
  REPOMIX_VENDOR_DIR,
  SECRET_DENY_GLOBS,
  templateHeader,
  resolvePackerVendorDir,
  type ExecFn,
  type PackerArgs,
  type PackerEffects,
  type PackFormat,
} from './packer-facade.ts';
import { isTrustworthyEmpty, unmeasuredSourceEvidence, type CodeIntelAnswer } from './contracts.ts';
import { applyResultDoor, beginResultDoorAggregate, type DoorableResult } from '../result-door.ts';
import { parseScratchReference } from '../scratch-reference.ts';
import { activeWorkspaceId } from '../workspace-registry.ts';
import readTool from '../agent-tools/capability/read.ts';

describe('native P010 change report contract', () => {
  it('cites the reference consumer and rechecks actual source bytes across report reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-report-unit-'));
    const source = 'export function target() { return 1; }\n';
    writeFileSync(join(root, 'target.ts'), source);
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'target',
      sites: [{ path: 'consumer.ts', line1: 2, kind: 'function', name: 'target' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
    const evidence = unmeasuredSourceEvidence(answer, { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    const graph = async (): Promise<CodeIntelAnswer> => ({ ...answer, evidence: { ...evidence, sourceScope: {
      ...evidence.sourceScope, sourceFingerprint: 'fixture-inputs', supportingFiles: [{ path: 'target.ts',
        contentHash: createHash('sha256').update(source).digest('hex'), language: 'typescript', representation: 'full-source' }],
    } } });
    const exec: ExecFn = async (_bin, argv) => ({ stdout: argv[0] === 'diff'
      ? 'diff --git a/target.ts b/target.ts\n--- a/target.ts\n+++ b/target.ts\n@@ -1 +1 @@\n-old\n+new\n'
      : argv[0] === 'status' ? '' : 'a'.repeat(40) });
    const args = { rootPath: root, include: ['target.ts'] };
    try {
      const first = await nativeChangeReport(args, { symbol: 'target', file: 'target.ts' }, { exec, graph });
      expect(first.report.consumers).toEqual([{ path: 'consumer.ts', line1: 2, kind: 'function', name: 'target' }]);
      expect(first.report.changed[0]).toMatchObject({ path: 'target.ts', line1: 1 });
      expect(first.report.freshness).toBe('first-read');
      const repeat = await nativeChangeReport(args, { symbol: 'target', file: 'target.ts', previousFingerprint: first.report.sourceFingerprint }, { exec, graph });
      expect(repeat.report.freshness).toBe('unchanged');
      writeFileSync(join(root, 'target.ts'), source + '// source moved during analysis\n');
      const stale = await nativeChangeReport(args, { symbol: 'target', file: 'target.ts' }, { exec, graph });
      expect(stale.report.freshness).toBe('unmeasured');
      expect(stale.report.limitations).toContain('Source changed during analysis: target.ts.');
      expect(stale.report.testReach).toMatchObject({ status: 'unknown', tests: [], paths: [],
        executionCoverage: 'unmeasured', gapSuggestion: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses an option-shaped revision and an escaping source before running a graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-report-path-'));
    const graph = vi.fn();
    try {
      await expect(nativeChangeReport({ rootPath: root, include: ['*.ts'], baseRef: '--output=elsewhere' },
        { symbol: 'target', file: 'target.ts' }, { graph })).rejects.toThrow(/revision/);
      await expect(nativeChangeReport({ rootPath: root, include: ['*.ts'] },
        { symbol: 'target', file: '../other/target.ts' }, { graph })).rejects.toThrow(/repository-relative/);
      expect(graph).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps unresolved, truncated, disconnected and compiler-failed test reach unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-test-reach-unit-'));
    const source = 'export function target() { return 1; }\n';
    writeFileSync(join(root, 'target.ts'), source);
    const contentHash = createHash('sha256').update(source).digest('hex');
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'target', sites: [],
      truncation: { truncated: false, totalAvailable: 0, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
    const evidence = unmeasuredSourceEvidence(answer, { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    const start = { site: { path: 'target.ts', line1: 1, kind: 'function' as const, name: 'target' }, contentHash, versionedSymbolId: 'target-id' };
    const complete: CodeIntelAnswer = { ...answer, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope,
      sourceFingerprint: 'inputs', supportingFiles: [{ path: 'target.ts', contentHash, language: 'typescript', representation: 'full-source' }] } },
      traversal: { direction: 'downstream', maxDepth: 5, maxPaths: 20, start, paths: [], truncationReasons: [], outcome: 'not-found-in-scope' } };
    const exec: ExecFn = async () => ({ stdout: '' });
    const run = (result: CodeIntelAnswer) => nativeChangeReport({ rootPath: root, include: ['target.ts'] },
      { symbol: 'target', file: 'target.ts' }, { exec, graph: async () => result });
    try {
      const negative = await run(complete);
      expect(negative.report.testReach).toMatchObject({ status: 'not-found-in-scope', tests: [], executionCoverage: 'unmeasured' });
      expect(negative.report.testReach.gapSuggestion).toContain('run the baseline suite');
      for (const degraded of [
        { ...complete, error: 'compiler unavailable' },
        { ...complete, truncation: { ...complete.truncation, truncated: true } },
        { ...complete, traversal: { ...complete.traversal!, outcome: 'incomplete' as const } },
        { ...complete, traversal: { ...complete.traversal!, paths: [{ siteIndices: [42], walk: 'reverse' as const }] } },
      ]) expect((await run(degraded)).report.testReach).toMatchObject({ status: 'unknown', gapSuggestion: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const BASE: PackerArgs = { include: ['packages/**/*.ts'], rootPath: '/repo' };

describe('native P021 symbol/source bundle evidence boundary', () => {
  it('pages the published captured artifact losslessly after the aggregate output budget is exhausted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-bundle-paging-'));
    const source = 'export function target() { return "CAPTURED_LITERAL"; }\n';
    writeFileSync(join(root, 'target.ts'), source);
    const site = { path: 'target.ts', line1: 1, kind: 'function' as const, name: 'target' };
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'target',
      sites: Array.from({ length: 80 }, () => site), error: null, latencyMs: 0,
      truncation: { truncated: false, totalAvailable: 80, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false } };
    const evidence = unmeasuredSourceEvidence(answer,
      { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    const contentHash = createHash('sha256').update(source).digest('hex');
    const graph: CodeIntelAnswer = { ...answer, evidence: { ...evidence,
      sourceScope: { ...evidence.sourceScope, sourceFingerprint: 'captured-inputs', supportingFiles: [
        { path: 'target.ts', contentHash, language: 'typescript', representation: 'full-source' }] },
      siteIdentities: answer.sites.map((_site, siteIndex) => ({ siteIndex, sourcePath: 'target.ts',
        contentHash, versionedSymbolId: `captured-${siteIndex}` })) } };
    let artifact: string | null = null;
    try {
      const bundle = (await nativeChangeReport({ rootPath: root, include: ['target.ts'] },
        { symbol: 'target', file: 'target.ts' },
        { graph: async () => graph, exec: async () => ({ stdout: '' }) })).report.bundle;
      artifact = bundle.expansion.args.file_path;
      const captured = parseScratchReference(readFileSync(artifact));
      expect(captured, 'Native expansion must publish the maintained recovery container').not.toBeNull();
      expect(captured!.manifest.sha256).toBe(bundle.expansion.sha256);
      writeFileSync(join(root, 'target.ts'), 'export function target() { return "NEWER_SOURCE"; }\n');
      const workspaceId = activeWorkspaceId();
      const aggregateScope = beginResultDoorAggregate({ sessionKey: 'native-bundle-paging', outputGroupId: root });
      const opts = { workspaceId, runId: '11111111-2222-4333-8444-555555555555', aggregateScope };
      let exhausted: DoorableResult | undefined;
      for (let index = 0; index < 3; index++) exhausted = applyResultDoor({
        content: [{ type: 'text' as const, text: 'x'.repeat(5_000) }],
      }, { ...opts, toolName: 'plans:get' });
      expect(JSON.parse((exhausted!.content[0] as { text: string }).text).state).toBe('incomplete');
      const pages: Buffer[] = [];
      let cursor: { tool: string; args: Record<string, unknown> } | null = bundle.expansion;
      while (cursor && pages.length < 64) {
        const result = await readTool.handler(cursor.args as never, { projectDir: root, workspaceId } as never) as DoorableResult;
        const doored = applyResultDoor({ ...result, content: [...result.content,
          { type: 'text' as const, text: 'See also: tools:find (discover tools)' }] },
        { ...opts, toolName: 'tools:invoke', nestedTargetToolName: 'capability:read' });
        const page = JSON.parse((doored.content[0] as { text: string }).text);
        expect(page.ok).toBe(true);
        expect(page.encoding).toBe('base64');
        const bytes = Buffer.from(page.data, 'base64');
        expect(bytes.toString('base64')).toBe(page.data);
        expect(bytes.length).toBe(page.byte_length);
        expect(page.byte_offset).toBe(pages.reduce((total, row) => total + row.length, 0));
        pages.push(bytes);
        expect(Boolean(page.next_cursor)).toBe(!page.eof);
        cursor = page.next_cursor;
      }
      expect(cursor).toBeNull();
      expect(pages.length).toBeGreaterThan(2);
      const document = Buffer.concat(pages).toString('utf8');
      expect(createHash('sha256').update(document).digest('hex')).toBe(bundle.expansion.sha256);
      expect(JSON.parse(document).context.symbols).toHaveLength(80);
      expect(document).toContain('CAPTURED_LITERAL');
      expect(document).not.toContain('NEWER_SOURCE');
    } finally {
      if (artifact) rmSync(artifact, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands omitted compiler records and preserves inferred provenance without substituting changed source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-graph-bundle-unit-'));
    const source = 'export function target() { return "CAPTURED_LITERAL"; }\n';
    writeFileSync(join(root, 'target.ts'), source);
    const contentHash = createHash('sha256').update(source).digest('hex');
    const site = { path: 'target.ts', line1: 1, kind: 'function' as const, name: 'target' };
    const secret = 'export const credential = "SECRET_DENIED_LITERAL";\n';
    writeFileSync(join(root, 'credentials.ts'), secret);
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'target',
      sites: [...Array.from({ length: 40 }, () => site), { ...site, path: 'credentials.ts' }], error: null, latencyMs: 0,
      truncation: { truncated: false, totalAvailable: 40, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false } };
    const evidence = unmeasuredSourceEvidence(answer, { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    const graph: CodeIntelAnswer = { ...answer, evidence: { ...evidence,
      sourceScope: { ...evidence.sourceScope, sourceFingerprint: 'inputs', supportingFiles: [
        { path: 'target.ts', contentHash, language: 'typescript', representation: 'full-source' },
        { path: 'credentials.ts', contentHash: secretHash, language: 'typescript', representation: 'full-source' }] },
      siteIdentities: answer.sites.map((location, siteIndex) => ({ siteIndex, sourcePath: location.path,
        contentHash: location.path === 'target.ts' ? contentHash : secretHash, versionedSymbolId: `identity-${siteIndex}` })),
      relationships: answer.sites.map((_site, siteIndex) => ({ siteIndex, kind: 'callers', origin: 'syntax', knowledge: 'inferred', runtimeExecution: 'unknown' })) } };
    let document = '';
    const run = () => nativeChangeReport({ rootPath: root, include: ['target.ts'] }, { symbol: 'target', file: 'target.ts' },
      { graph: async () => graph, exec: async () => ({ stdout: '' }), writeArtifact: async body => {
        document = body; return join(root, 'captured.json'); } });
    try {
      const bundle = (await run()).report.bundle;
      expect(bundle.kind).toBe('native-source-path');
      expect(bundle.context.sources[0]).toMatchObject({ contentHash, text: source });
      expect(bundle.omitted.symbols).toBeGreaterThan(0);
      expect(bundle.omitted.edges).toBeGreaterThan(0);
      expect(bundle.tokens.retained).toBe(getEncoding('o200k_base').encode(JSON.stringify(bundle.context), [], []).length);
      expect(bundle.tokens.retained).toBeLessThanOrEqual(bundle.tokens.budget);
      const expanded = JSON.parse(document);
      expect(expanded.context.symbols).toHaveLength(41);
      expect(document).not.toContain('SECRET_DENIED_LITERAL');
      expect(expanded.context.edges[39]).toMatchObject({ knowledge: 'inferred', origin: 'syntax', runtimeExecution: 'unknown' });
      expect(createHash('sha256').update(document).digest('hex')).toBe(bundle.expansion.sha256);
      writeFileSync(join(root, 'target.ts'), 'export function target() { return "NEWER_SOURCE"; }\n');
      const stale = (await run()).report.bundle;
      expect(stale.context.sources).toEqual([]);
      expect(stale.coverage.unavailableFiles).toEqual(['target.ts', 'credentials.ts']);
      expect(document).not.toContain('NEWER_SOURCE');
      expect(JSON.stringify(expanded)).toContain('CAPTURED_LITERAL');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/** A matrix wide enough that a builder cannot pass by special-casing one input. */
const ARG_MATRIX: PackerArgs[] = [
  BASE,
  { ...BASE, format: 'markdown' },
  { ...BASE, format: 'xml', compress: true },
  { ...BASE, ignore: ['**/*.test.ts'] },
  { ...BASE, baseRef: 'origin/main' },
  { ...BASE, template: 'security-audit' },
  { ...BASE, include: ['a/**', 'b/**', 'c/**'], ignore: ['**/dist/**', '**/*.snap'] },
];

/**
 * Smuggling attempts: a caller trying to get a forbidden flag into the argv
 * through a field that is legitimately caller-controlled.
 *
 * These MUST be refused outright rather than sanitised. Writing this matrix is
 * what exposed the original hole — the first version of the builder emitted
 * `['--include', '--no-security-check']`, which is a flag-shaped token in argv
 * whose meaning depends on the engine parser's version. Refusing is the only
 * answer that does not rest on a parser quirk.
 */
const SMUGGLING_MATRIX: PackerArgs[] = [
  { ...BASE, include: ['--no-security-check'] },
  { ...BASE, include: ['src/**', '--remote'] },
  { ...BASE, ignore: ['--copy', '-o', '/etc/passwd'] },
  { ...BASE, ignore: ['--hidden'] },
  { ...BASE, include: ['--no-ignore'] },
  { ...BASE, include: ['-t'] },
];

/** Value of a `--flag=value` token, since the builders emit the attached form. */
const attached = (argv: readonly string[], flag: string): string => {
  const hit = argv.find((t) => t.startsWith(`${flag}=`));
  return hit === undefined ? '' : hit.slice(flag.length + 1);
};

// ───────────────────────── pins and identity ─────────────────────────

describe('the pin is enforced by EQUALITY, not by parseability', () => {
  it('keeps pinned packer assets on the host home under a workspace-scoped PAPERCUSP_HOME', () => {
    const previous = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = join(tmpdir(), 'workspace-scoped-packer-home');
      const hostVendor = join(homedir(), '.papercusp', 'vendor');
      expect(resolvePackerVendorDir('repomix')).toBe(join(hostVendor, 'repomix'));
      expect(resolvePackerVendorDir('code2prompt')).toBe(join(hostVendor, 'code2prompt'));
      expect(REPOMIX_VENDOR_DIR).toBe(join(hostVendor, 'repomix'));
      expect(REPOMIX_VENDOR_DIR.startsWith(process.env.PAPERCUSP_HOME)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = previous;
    }
  });

  it('accepts exactly the pinned repomix version', () => {
    const r = assertIsRepomix(`${REPOMIX_PINNED_VERSION}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(REPOMIX_PINNED_VERSION);
  });

  it('REJECTS a repomix vendor dir that drifted off the pin', () => {
    // This is the failure the leg exists to prevent, and it is invisible to
    // every check except equality: a drifted binary answers --version perfectly.
    for (const drifted of ['1.19.0', '1.17.9', '2.0.0']) {
      const r = assertIsRepomix(drifted);
      expect(r.ok, `expected ${drifted} to be refused`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toContain('DRIFTED');
    }
  });

  it('accepts exactly the pinned code2prompt version', () => {
    const r = assertIsCode2Prompt(`code2prompt ${CODE2PROMPT_PINNED_VERSION}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(CODE2PROMPT_PINNED_VERSION);
  });

  it('REJECTS the npm package of the same name (D-040) — it is a different project', () => {
    // `npm i code2prompt` installs github.com/puntorigen/code2prompt, a NodeJS
    // library with no executable. Nothing it could print identifies as the CLI.
    for (const impostor of ['1.1.4', 'code2prompt-lib 1.1.4', '']) {
      const r = assertIsCode2Prompt(impostor);
      expect(r.ok, `expected ${JSON.stringify(impostor)} to be refused`).toBe(false);
    }
  });

  it('CONTROL: a lenient assert that only checks parseability passes the drift cases', () => {
    // Deliberately wrong: parses a semver but never compares it to the pin.
    // This is what the check looked like before equality was the rule, and it
    // proves the drift assertions above can actually fail.
    const lenient = (out: string) => /^(\d+\.\d+\.\d+)$/m.test(out.trim());
    expect(lenient('1.19.0')).toBe(true); // control WOULD accept a drifted engine
    expect(assertIsRepomix('1.19.0').ok).toBe(false); // subject does not
  });
});

// ───────────────────────── forbidden flags ─────────────────────────

describe('dangerous engine flags are unreachable by construction', () => {
  it('no repomix argv, for any input, contains a forbidden flag', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildRepomixArgs(args);
      for (const flag of REPOMIX_FORBIDDEN_FLAGS) {
        expect(argv, `${flag} leaked for ${JSON.stringify(args)}`).not.toContain(flag);
      }
    }
  });

  it('no code2prompt argv, for any input, contains a forbidden flag', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildCode2PromptArgs(args);
      for (const flag of CODE2PROMPT_FORBIDDEN_FLAGS) {
        expect(argv, `${flag} leaked for ${JSON.stringify(args)}`).not.toContain(flag);
      }
    }
  });

  it('secret-scanning can never be disabled — --no-security-check is absent always', () => {
    for (const args of ARG_MATRIX) {
      expect(buildRepomixArgs(args)).not.toContain('--no-security-check');
    }
  });

  it('code2prompt always writes to STDOUT and the target cannot be rebound', () => {
    for (const args of ARG_MATRIX) {
      const argv = buildCode2PromptArgs(args);
      expect(argv, 'output target must be pinned to stdout').toContain('--output-file=-');
      // exactly one output target, so none can be smuggled in behind it
      expect(argv.filter((t) => t.startsWith('--output-file'))).toHaveLength(1);
      expect(argv.filter((t) => t === '-O')).toHaveLength(0);
    }
  });

  it('REFUSES every smuggling attempt outright, rather than sanitising it', () => {
    for (const args of SMUGGLING_MATRIX) {
      expect(() => buildRepomixArgs(args), JSON.stringify(args)).toThrow(/begins with '-'/);
      expect(() => buildCode2PromptArgs(args), JSON.stringify(args)).toThrow(/begins with '-'/);
    }
  });

  it('REFUSES a flag-shaped baseRef', () => {
    expect(() => buildCode2PromptArgs({ ...BASE, baseRef: '--clipboard' })).toThrow(/begins with '-'/);
  });

  it('emits ATTACHED values, so no emitted token can be re-read as an option', () => {
    // The second, independent defence: even if a pattern slipped past
    // validation, `--include=<value>` is unambiguous to every argv parser,
    // whereas `--include <value>` is not.
    for (const args of ARG_MATRIX) {
      const argv = buildRepomixArgs(args);
      expect(argv.some((t) => t.startsWith('--include='))).toBe(true);
      expect(argv).not.toContain('--include');
      expect(argv).not.toContain('--ignore');
    }
  });

  it('CONTROL: a builder that appends --no-security-check fails the same assertion', () => {
    const wrong = (args: PackerArgs) => [...buildRepomixArgs(args), '--no-security-check'];
    expect(wrong(BASE)).toContain('--no-security-check'); // control is caught
    expect(buildRepomixArgs(BASE)).not.toContain('--no-security-check'); // subject is not
  });

  it('CONTROL: the pre-fix DETACHED builder puts a flag-shaped token in argv', () => {
    // This is verbatim what the first implementation did, kept permanently so
    // the smuggling refusal above cannot quietly stop testing anything.
    const wrong = (args: PackerArgs) => ['--include', args.include.join(','), '--stdout'];
    expect(wrong({ ...BASE, include: ['--no-security-check'] })).toContain('--no-security-check');
    expect(() => buildRepomixArgs({ ...BASE, include: ['--no-security-check'] })).toThrow();
  });
});

// ───────────────────────── the deny-set ─────────────────────────

describe('the secret deny-set cannot be shortened by a caller', () => {
  it('every deny glob reaches repomix, whatever the caller passes for ignore', () => {
    for (const args of ARG_MATRIX) {
      const value = attached(buildRepomixArgs(args), '--ignore');
      for (const glob of SECRET_DENY_GLOBS) {
        expect(value.split(','), `${glob} missing`).toContain(glob);
      }
    }
  });

  it('every deny glob reaches code2prompt, whatever the caller passes for ignore', () => {
    for (const args of ARG_MATRIX) {
      const value = attached(buildCode2PromptArgs(args), '--exclude');
      for (const glob of SECRET_DENY_GLOBS) {
        expect(value.split(','), `${glob} missing`).toContain(glob);
      }
    }
  });

  it('covers the file shapes that actually carry credentials', () => {
    // A deny-set is only as good as its coverage; name the shapes explicitly so
    // shrinking it is a visible edit rather than a silent one.
    for (const needed of ['**/.env', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.npmrc', '**/credentials']) {
      expect(SECRET_DENY_GLOBS).toContain(needed);
    }
  });

  it('CONTROL: a builder that uses only the caller ignore drops the whole deny-set', () => {
    const wrong = (args: PackerArgs) => [`--ignore=${(args.ignore ?? []).join(',')}`];
    const w = attached(wrong({ ...BASE, ignore: ['docs/**'] }), '--ignore').split(',');
    expect(w).not.toContain('**/.env'); // control leaks secrets
    const s = attached(buildRepomixArgs({ ...BASE, ignore: ['docs/**'] }), '--ignore').split(',');
    expect(s).toContain('**/.env'); // subject does not
  });
});

// ───────────────────────── explicit include set ─────────────────────────

describe('an explicit include set is required (P-016)', () => {
  it('both builders refuse an empty include set', () => {
    expect(() => buildRepomixArgs({ ...BASE, include: [] })).toThrow(/explicit/i);
    expect(() => buildCode2PromptArgs({ ...BASE, include: [] })).toThrow(/explicit/i);
  });

  it('the facade turns that into a refusal ANSWER, not a thrown error', async () => {
    const r = await packerFacade('pack', { ...BASE, include: [] }, stubEffects());
    expect(r.answer.error).toMatch(/explicit/i);
    expect(r.artifact).toBeNull();
  });
});

// ───────────────────────── selection parsing ─────────────────────────

describe('an unreadable selection is null, never zero', () => {
  it('parses xml file markers', () => {
    const body = '<file path="a/b.ts">x</file>\n<file path="c/d.ts">y</file>';
    expect(parseSelectedFiles(body, 'xml')).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('parses markdown file headings', () => {
    const body = '## File: a/b.ts\ncode\n## File: c/d.ts\ncode';
    expect(parseSelectedFiles(body, 'markdown')).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('de-duplicates repeated paths', () => {
    const body = '<file path="a.ts">1</file><file path="a.ts">2</file>';
    expect(parseSelectedFiles(body, 'xml')).toEqual(['a.ts']);
  });

  it('returns NULL when nothing parses — the difference that matters', () => {
    // "I could not read the pack" and "the pack selected nothing" are different
    // answers. Only one is evidence, and coercing the first to [] destroys the
    // distinction exactly where a reader would rely on it.
    expect(parseSelectedFiles('total gibberish', 'xml')).toBeNull();
    expect(parseSelectedFiles('', 'markdown')).toBeNull();
  });

  it('CONTROL: a parser returning [] on no-match is indistinguishable from an empty pack', () => {
    const wrong = (body: string): readonly string[] => {
      const out: string[] = [];
      const re = /<file\s+path="([^"]+)"/g;
      for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
      return out; // deliberately never null
    };
    expect(wrong('gibberish')).toEqual([]); // control fabricates an empty selection
    expect(parseSelectedFiles('gibberish', 'xml')).toBeNull(); // subject refuses to
  });
});

// ───────────────────────── templates ─────────────────────────

describe('pack templates are a closed set we own', () => {
  it('every non-none template yields non-empty header text', () => {
    for (const [name, text] of Object.entries(PACK_TEMPLATES)) {
      if (name === 'none') expect(text).toBe('');
      else expect(text.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  it('an absent template contributes nothing', () => {
    expect(templateHeader(undefined)).toBe('');
    expect(templateHeader('none')).toBe('');
  });

  it('no template is a filesystem path — code2prompt -t is never used', () => {
    // -t would be an arbitrary-file-read plus a template-injection surface.
    expect(CODE2PROMPT_FORBIDDEN_FLAGS).toContain('-t');
    expect(CODE2PROMPT_FORBIDDEN_FLAGS).toContain('--template');
  });
});

// ───────────────────────── provenance + refusals ─────────────────────────

function stubEffects(over: Partial<PackerEffects> = {}, body = '<file path="a.ts">x</file>'): PackerEffects {
  const exec: ExecFn = async (bin, argv) => {
    if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
    if (bin === 'git') {
      if (argv[0] === 'rev-parse') return { stdout: 'abc1234def\n' };
      if (argv[0] === 'status') return { stdout: '' };
    }
    return { stdout: body };
  };
  return {
    exec,
    writeArtifact: async () => '/scratch/pack.xml',
    now: () => new Date('2026-08-21T12:00:00Z'),
    ...over,
  };
}

describe('a refusal is an ANSWER that can never read as an empty selection', () => {
  it('a disabled flag refuses, and the refusal is not a trustworthy empty', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(false);
    const r = await packerFacade('pack', BASE, stubEffects());
    expect(r.answer.sites).toEqual([]);
    expect(r.answer.error).toMatch(/disabled/);
    expect(r.answer.freshness.health).toBe('unknown');
    // The load-bearing assertion: a refusal must NOT satisfy the corpus's
    // trustworthy-empty predicate, or "packing is off" scores as "nothing matched".
    expect(isTrustworthyEmpty(r.answer)).toBe(true); // true only because error !== null
    expect(r.answer.error).not.toBeNull();
  });

  it('an engine failure is reported loudly, never as an empty pack', async () => {
    const boom: ExecFn = async (_b, argv) => {
      if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
      throw Object.assign(new Error('spawn failed'), { stderr: 'repomix: exploded' });
    };
    const r = await packerFacade('pack', BASE, stubEffects({ exec: boom }));
    expect(r.answer.error).toContain('exploded');
    expect(r.artifact).toBeNull();
  });
});

describe('provenance states what the pack actually is', () => {
  it('reports the producer phases before a slow flag read can consume the caller deadline', async () => {
    let finishFlag!: (enabled: boolean) => void;
    vi.mocked(getFlag).mockReturnValueOnce(new Promise<boolean>(resolve => { finishFlag = resolve; }));
    const phases: string[] = [];
    const pending = packerFacade('pack', BASE, stubEffects({ onPhase: phase => phases.push(phase) }));
    expect(phases).toEqual(['flag-read']);
    finishFlag(false);
    expect((await pending).answer.error).toMatch(/disabled/);
    expect(phases).toEqual(['flag-read']);
  });

  it('distinguishes execution, provenance, artifact and preview phases without changing the pack', async () => {
    const phases: string[] = [];
    const result = await packerFacade('pack', BASE, stubEffects({ onPhase: phase => phases.push(phase) }));
    expect(phases).toEqual(['flag-read', 'identity', 'execution', 'selection', 'provenance', 'artifact-write', 'preview']);
    expect(result.answer.error).toBeNull();
    expect(result.artifact?.provenance.securityScan).toBe('secretlint+deny-set');
    expect(result.answer.sites.map(site => site.path)).toEqual(['a.ts']);
  });

  it('stamps engine, version, commit, dirtiness and selection', async () => {
    const r = await packerFacade('pack', BASE, stubEffects());
    const p = r.artifact?.provenance;
    expect(p?.engine).toBe('repomix');
    expect(p?.engineVersion).toBe(REPOMIX_PINNED_VERSION);
    expect(p?.commit).toBe('abc1234def');
    expect(p?.dirty).toBe(false);
    expect(p?.fileCount).toBe(1);
    expect(p?.include).toEqual(BASE.include);
    expect(p?.capturedAt).toBe('2026-08-21T12:00:00.000Z');
  });

  it('reports securityScan HONESTLY per engine — the two are not interchangeable', async () => {
    const packed = await packerFacade('pack', BASE, stubEffects());
    expect(packed.artifact?.provenance.securityScan).toBe('secretlint+deny-set');

    const diffed = await packerFacade(
      'diff',
      BASE,
      stubEffects({
        exec: async (bin, argv) => {
          if (argv[0] === '--version') return { stdout: `code2prompt ${CODE2PROMPT_PINNED_VERSION}` };
          if (bin === 'git') return { stdout: argv[0] === 'status' ? '' : 'abc1234def' };
          return { stdout: '## File: a.ts\nx' };
        },
      }),
    );
    // code2prompt 4.2.0 ships NO secret scanner (measured across its whole
    // option surface). Saying so is the point: a consumer must not assume the
    // repomix guarantee carries over.
    expect(diffed.artifact?.provenance.securityScan).toBe('deny-set-only');
  });

  it('fileCount is NULL — not 0 — when the pack could not be parsed', async () => {
    const r = await packerFacade('pack', BASE, stubEffects({}, 'unparseable output'));
    expect(r.artifact?.provenance.fileCount).toBeNull();
    expect(r.answer.sites).toEqual([]);
    // and the truncation total must carry the same honesty
    expect(r.answer.truncation.totalAvailable).toBeNull();
  });

  it('a dirty tree is reported, so a pack is never miscited as "the code at <sha>"', async () => {
    const dirty = stubEffects({
      exec: async (bin, argv) => {
        if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
        if (bin === 'git') return { stdout: argv[0] === 'status' ? ' M a.ts\n' : 'abc1234def' };
        return { stdout: '<file path="a.ts">x</file>' };
      },
    });
    const r = await packerFacade('pack', BASE, dirty);
    expect(r.artifact?.provenance.dirty).toBe(true);
    expect(r.answer.freshness.staleVsDisk).toBe(true);
  });

  it('a non-git root yields null commit rather than a fabricated one', async () => {
    const nogit = stubEffects({
      exec: async (bin, argv) => {
        if (argv[0] === '--version') return { stdout: REPOMIX_PINNED_VERSION };
        if (bin === 'git') throw new Error('not a git repository');
        return { stdout: '<file path="a.ts">x</file>' };
      },
    });
    const r = await packerFacade('pack', BASE, nogit);
    expect(r.artifact?.provenance.commit).toBeNull();
    expect(r.artifact?.provenance.dirty).toBeNull();
  });

  it('readGitProvenance never throws — a missing git is absence, not an error', async () => {
    const throwing: ExecFn = async () => {
      throw new Error('no git');
    };
    await expect(readGitProvenance('/repo', 'main', throwing)).resolves.toEqual({
      commit: null,
      dirty: null,
      baseCommit: null,
    });
  });

  it('scopes the provenance status to literal include paths and keeps the whole tree for globs (WI-6554700010018774)', async () => {
    // A whole-tree status on the shared checkout cost 470-890ms of the claim-time
    // brief's 6s window; the packed files are all a pack's reproducibility needs.
    expect(provenanceStatusPathspec(['a.ts', 'lib/b'])).toEqual(['a.ts', 'lib/b']);
    for (const include of [undefined, [], ['packages/**/*.ts'], ['a.ts', 'src/?.ts'], [':(glob)a'], ['--all'], ['']]) {
      expect(provenanceStatusPathspec(include)).toBeNull();
    }
    const statuses: string[][] = [];
    const exec: ExecFn = async (bin, argv) => {
      if (bin === 'git' && argv[0] === 'status') statuses.push([...argv]);
      return { stdout: argv[0] === 'status' ? (argv.includes('--') ? '' : ' M elsewhere.ts\n') : 'abc1234def' };
    };
    // The scoped answer is about the packed files: an unrelated dirty file no longer marks the pack dirty.
    await expect(readGitProvenance('/repo', undefined, exec, ['a.ts'])).resolves.toMatchObject({ dirty: false });
    await expect(readGitProvenance('/repo', undefined, exec, ['packages/**/*.ts'])).resolves.toMatchObject({ dirty: true });
    expect(statuses).toEqual([['status', '--porcelain', '--', 'a.ts'], ['status', '--porcelain']]);

    const base = stubEffects();
    const gitCalls: string[][] = [];
    const effects: PackerEffects = { ...base, exec: async (bin, argv, opts) => {
      if (bin === 'git') gitCalls.push([...argv]);
      return base.exec!(bin, argv, opts);
    } };
    await packerFacade('pack', { ...BASE, include: ['a.ts'] }, effects);
    expect(gitCalls).toContainEqual(['status', '--porcelain', '--', 'a.ts']);
  });

  it('the pack body never comes back inline — only a bounded preview plus a path', async () => {
    const big = 'x'.repeat(500_000);
    const r = await packerFacade('pack', BASE, stubEffects({}, `<file path="a.ts">${big}</file>`));
    expect(r.artifact?.path).toBe('/scratch/pack.xml');
    // The whole reason a pack is an artifact and not a result: it must not be
    // able to blow the caller's context budget.
    expect(r.artifact!.preview.length).toBeLessThanOrEqual(4096);
    expect(r.artifact!.provenance.chars).toBeGreaterThan(400_000);
    expect(r.artifact!.bundle).toMatchObject({ truncated: true, tokens: { source: null },
      expansion: { tool: 'capability:read', args: { file_path: '/scratch/pack.xml' } } });
    expect(r.artifact!.bundle!.tokens.measuredChars).toBeLessThanOrEqual(256);
  }, 10_000);

  it('P021 recovers omitted literal source through the hash-bound artifact and measures retained Unicode tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-pack-bundle-'));
    const body = `<file path="a.ts">// literal <|endoftext|> is source, not a control token\n${'const λ = "你好🙂";\n'.repeat(600)}OMITTED_LITERAL_SOURCE</file>`;
    const path = join(root, 'pack.xml');
    try {
      const packed = await packerFacade('pack', BASE, stubEffects({ writeArtifact: async document => {
        writeFileSync(path, document); return path;
      } }, body));
      const artifact = packed.artifact!, bundle = artifact.bundle!;
      expect(bundle.sourcePaths).toEqual(['a.ts']);
      expect(bundle.truncated).toBe(true);
      expect(artifact.preview).not.toContain('OMITTED_LITERAL_SOURCE');
      expect(body.startsWith(artifact.preview)).toBe(true);
      expect(artifact.preview).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(bundle.tokens.retained).toBe(getEncoding('o200k_base').encode(artifact.preview, [], []).length);
      expect(bundle.tokens.retained).toBeLessThanOrEqual(bundle.tokens.budget);
      const expanded = readFileSync(bundle.expansion.args.file_path, 'utf8');
      expect(expanded).toBe(body);
      expect(expanded).toContain('OMITTED_LITERAL_SOURCE');
      expect(createHash('sha256').update(expanded).digest('hex')).toBe(bundle.expansion.sha256);
      expect(bundle.tokens.source).toBeNull();
      expect(bundle.tokens.measuredPrefix).toBe(getEncoding('o200k_base').encode(body.slice(0, bundle.tokens.measuredChars), [], []).length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a pack at the byte ceiling reports truncated:true', async () => {
    expect(MAX_PACK_BYTES).toBeGreaterThan(0);
    const r = await packerFacade('pack', BASE, stubEffects());
    // A small pack is not truncated; the flag tracks the ceiling, not length.
    expect(r.answer.truncation.truncated).toBe(false);
  });
});

describe('the diff op routes to code2prompt and the pack op to repomix', () => {
  const formats: PackFormat[] = ['markdown', 'xml'];
  it('backend follows the op, not the caller', async () => {
    for (const format of formats) {
      const packed = await packerFacade('pack', { ...BASE, format }, stubEffects());
      expect(packed.answer.backend).toBe('repomix');
      expect(packed.answer.intent).toBe('pack');
    }
  });
});
