/**
 * Tests for the identity-leak content detector (EI-19381677675617429).
 *
 * The load-bearing assertions here are the SCOPE ones, not the matching ones. Matching
 * is already covered by the shared matcher's own tests — this detector deliberately owns
 * no patterns. What is new, and what would cause a fleet-wide incident if wrong, is:
 *   1. the detector is registered at all (the whole point — the route-independent
 *      chokepoint the edit-time hook cannot be), and
 *   2. it NEVER runs inside a submodule, where 45 files carry identity literals by
 *      design and would be quarantined from every commit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findIdentityLeakError, identityLeakScopeMatches } from './identity-leak';
import { DEFAULT_CONTENT_DETECTORS, identityLeakDetector } from './registry';
import { detectContentOffenders } from '../harness/git-sync/content-guard';
import { serializeIdentitySafeJson } from '../../../../scripts/lib/identity-leak-patterns.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

const statusRunGit = (entries: string[]) =>
  async (args: string[]) =>
    args[0] === 'status'
      ? { code: 0, stdout: entries.join('\0') + (entries.length ? '\0' : ''), stderr: '' }
      : { code: 0, stdout: '', stderr: '' };

/** A `runGit` stub: answers the repo-kind probe, and reports one dirty file. */
function makeRunGit(superprojectProbe: { code: number; stdout: string }, dirty = 'a.sh') {
  const calls: string[][] = [];
  const runGit = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      return { code: superprojectProbe.code, stdout: superprojectProbe.stdout, stderr: '' };
    }
    if (args[0] === 'status') return { code: 0, stdout: `?? ${dirty}\0`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runGit: runGit as never, calls };
}

/**
 * Assembled at runtime, never written as a source literal.
 *
 * This fixture has to contain a REAL leak or the assertion below proves nothing — a
 * sanctioned `PLACEHOLDER_NAMES` stand-in would be skipped by the very matcher under
 * test. But as a literal it also (correctly) trips `check-no-box-identity.mjs` on this
 * file, which would make the gate red for stating the thing the gate exists to catch.
 * Splitting the path keeps the runtime value genuinely leaky while the source text is
 * clean. Same technique, same reason, as the sibling detector's own test:
 * `secrets.test.ts` builds its PEM header with `['-----BEGIN','PRIVATE','KEY-----'].join(' ')`.
 */
const LEAKY = `ExecStart=${['', 'home', 'somedev', '.local', 'bin', 'thing'].join('/')}\n`;

describe('findIdentityLeakError', () => {
  it('publishes portable memory reports without changing counters, hashes, scope or the original', async () => {
    const executable = ['', 'home', 'somedev', 'bin', 'node'].join('/');
    const original = { incomplete: false, limitations: ['Ambient baseline; no paired savings'],
      samples: [{ os: { pid: 42, startTicks: '123', executable, executableSha256: 'a'.repeat(64),
        pssBytes: 123456, rssBytes: 234567 }, error: 'Failed at ' + executable }],
      requests: [{ responseSha256: 'b'.repeat(64), rows: 32, elapsedMs: 1.75 }] };
    const raw = JSON.stringify(original, null, 2) + '\n';
    expect(await findIdentityLeakError('docs/evidence/memory.json', raw, REPO_ROOT)).toBeTruthy();
    const portable = serializeIdentitySafeJson(original, []);
    expect(await findIdentityLeakError('docs/evidence/memory.json', portable, REPO_ROOT)).toBeNull();
    const parsed = JSON.parse(portable);
    expect(parsed).toEqual({ ...original, samples: [{ os: { ...original.samples[0].os,
      executable: '/home/builduser/bin/node' }, error: 'Failed at /home/builduser/bin/node' }] });
    expect(original.samples[0].os.executable).toBe(executable);
    expect(serializeIdentitySafeJson(parsed, [])).toBe(portable);
  });

  it('preserves escaped strings and refuses a redaction that would rename a report field', () => {
    const value = { note: 'quote " and newline\n', bytes: 0, missing: null };
    expect(JSON.parse(serializeIdentitySafeJson(value, []))).toEqual(value);
    expect(() => serializeIdentitySafeJson({ ['build-' + 'secret-host']: 1 }, [['build-hostname', 'secret-host']]))
      .toThrow('key contains a machine identity');
  });

  it('exports retained test logs without changing their private proof hashes or execution counts', async () => {
    const checkout = ['', 'home', 'somedev', 'project'].join('/');
    const retainedLog = `repo: ${checkout}\nTests 26 passed\nexitCode=0\n`;
    const report = { kind: 'operational-test-evidence', retainedLog,
      provenance: { originalLogSha256: 'a'.repeat(64), originalTestRunId: 42, originalTestCount: 26, derivedAssertionCount: 3 } };
    expect(await findIdentityLeakError('docs/evidence/test-log.json', JSON.stringify(report), REPO_ROOT)).toBeTruthy();
    const exported = serializeIdentitySafeJson(report, []);
    expect(await findIdentityLeakError('docs/evidence/test-log.json', exported, REPO_ROOT)).toBeNull();
    expect(JSON.parse(exported).provenance).toEqual(report.provenance);
    expect(JSON.parse(exported).retainedLog).toContain('Tests 26 passed\nexitCode=0');
    expect(report.retainedLog).toBe(retainedLog);
  });

  it('imports the serializer in a host bundle without running its standalone CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-serializer-bundle-'));
    const bundle = join(dir, 'host.mjs');
    try {
      buildSync({
        stdin: {
          contents: "import { serializeIdentitySafeJson } from './scripts/lib/identity-leak-patterns.mjs';\n" +
            "process.stdout.write(serializeIdentitySafeJson({ rows: 7, hash: 'unchanged' }, []));\n",
          resolveDir: REPO_ROOT,
          sourcefile: 'identity-serializer-host.mjs',
        },
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'esm',
        define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
        logLevel: 'silent',
      });
      const imported = spawnSync(process.execPath, [bundle], { encoding: 'utf8' });
      expect(imported.status).toBe(0);
      expect(imported.stderr).toBe('');
      expect(JSON.parse(imported.stdout)).toEqual({ rows: 7, hash: 'unchanged' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports public Android evidence through the maintained serializer while preserving private provenance', async () => {
    const checkout = ['', 'home', 'somedev', 'cache', 'operator-checkout'].join('/');
    const report = {
      schemaVersion: 1, kind: 'operational-test-evidence',
      command: ['bash', 'tools/run-android-checks.sh', 'isolated-native', checkout],
      scope: 'Local debug only; signed candidate, physical phone and Play remain open',
      exitCode: 0, testCounts: { native: { executed: 8, failed: 0, errors: 0, skipped: 0 } },
      rawEvidence: [{ path: 'mobile/build/result.json', sha256: 'a'.repeat(64) }],
      sourceFiles: [{ path: 'mobile/tools/run-android-checks.sh', sha256: 'b'.repeat(64) }],
      operator: { sourceCommit: 'c'.repeat(40), bundleSha256: 'd'.repeat(64) },
    };
    const privateJson = JSON.stringify(report, null, 2) + '\n';
    expect(await findIdentityLeakError('docs/evidence/android.json', privateJson, REPO_ROOT)).toBeTruthy();
    const exported = spawnSync(process.execPath,
      [join(REPO_ROOT, 'scripts/lib/identity-leak-patterns.mjs'), '--serialize-json'],
      { cwd: REPO_ROOT, input: privateJson, encoding: 'utf8' });
    expect(exported.status).toBe(0);
    expect(exported.stderr).toBe('');
    expect(await findIdentityLeakError('docs/evidence/android.json', exported.stdout, REPO_ROOT)).toBeNull();
    expect(JSON.parse(exported.stdout)).toEqual({ ...report,
      command: ['bash', 'tools/run-android-checks.sh', 'isolated-native', '/home/builduser/cache/operator-checkout'] });
    expect(JSON.stringify(report, null, 2) + '\n').toBe(privateJson);
    expect(report.command[3]).toBe(checkout);
  });

  it.each(['malformed', 'identity-key'])('refuses %s private input without publishing it or echoing it in errors', kind => {
    const secretPath = ['', 'home', 'somedev', 'private', 'receipt'].join('/');
    const input = kind === 'malformed' ? '{"receipt":' + secretPath : JSON.stringify({ [secretPath]: 1 });
    const exported = spawnSync(process.execPath,
      [join(REPO_ROOT, 'scripts/lib/identity-leak-patterns.mjs'), '--serialize-json'],
      { cwd: REPO_ROOT, input, encoding: 'utf8' });
    expect(exported.status).toBe(1);
    expect(exported.stdout).toBe('');
    expect(exported.stderr).toContain('Identity-safe JSON export refused');
    expect(exported.stderr).not.toContain(secretPath);
  });

  it('flags a hardcoded home path and names the fix', async () => {
    const err = await findIdentityLeakError('svc.service', LEAKY, REPO_ROOT);
    expect(err).toBeTruthy();
    expect(err).toContain('hardcoded home path');
    // The fix hint must travel WITH the error: it is fed verbatim to the content-fixer,
    // which has no other source for "use %h here, $HOME there".
    expect(err).toMatch(/%h|HOME|homedir/);
  });

  it('returns null for clean text — the overwhelmingly common case', async () => {
    await expect(
      findIdentityLeakError('svc.service', 'ExecStart=%h/.local/bin/thing\n', REPO_ROOT),
    ).resolves.toBeNull();
  });

  it('does not interpret slash-separated prose or relative paths as absolute home paths', async () => {
    for (const text of ['email/home/session-id shape', 'fixtures/home/somedev/data', 'nested/Users/somedev/file']) {
      await expect(findIdentityLeakError('scanner.ts', text, REPO_ROOT)).resolves.toBeNull();
    }
  });

  it('still rejects absolute home paths in assignments, quotes, and file URLs', async () => {
    const home = ['', 'home', 'somedev', 'file'].join('/');
    for (const text of [home, `HOME=${home}`, `"${home}"`, `file://${home}`, `(${home})`]) {
      await expect(findIdentityLeakError('scanner.ts', text, REPO_ROOT)).resolves.toContain('hardcoded home path');
    }
  });

  it('does not throw on empty or binary input', async () => {
    // Escaped, never raw: a literal control byte here would red lint:no-control-bytes,
    // a green-checkpoint leg. The runtime string is byte-identical either way.
    await expect(findIdentityLeakError('x.txt', '', REPO_ROOT)).resolves.toBeNull();
    await expect(findIdentityLeakError('x.bin', '\x00\xff/home/', REPO_ROOT)).resolves.toBeNull();
  });
});

describe('ptool test fixture content', () => {
  it('stays free of machine-specific home paths', async () => {
    const file = 'apps/operator/scripts/ptool.test.ts';
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    await expect(findIdentityLeakError(file, text, REPO_ROOT)).resolves.toBeNull();
  });
});

describe('identityLeakScopeMatches', () => {
  it('mirrors the CI lint: source in, generated/vendored out', async () => {
    await expect(identityLeakScopeMatches('apps/operator/scripts/systemd/x.service', REPO_ROOT)).resolves.toBe(true);
    await expect(identityLeakScopeMatches('node_modules/pkg/index.js', REPO_ROOT)).resolves.toBe(false);
    await expect(identityLeakScopeMatches('dist/bundle.js', REPO_ROOT)).resolves.toBe(false);
  });

  it('excludes the dot-prefixed tool caches that made the lint report 412 for 2 real leaks', async () => {
    await expect(identityLeakScopeMatches('.tsx-tmp/node-compile-cache/v25/abc', REPO_ROOT)).resolves.toBe(false);
    await expect(identityLeakScopeMatches('.content-fixer-tmp/tsx/abc', REPO_ROOT)).resolves.toBe(false);
  });
});

describe('registration', () => {
  it('is in the default registry — otherwise git-sync never runs it', () => {
    expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.key)).toContain('identity-leak');
  });

  it('declares superproject-only scope', () => {
    expect(identityLeakDetector.repoScope).toBe('superproject-only');
  });

  it('declares NO autoFix — the correct substitution is context-dependent', () => {
    expect(identityLeakDetector.autoFix).toBeUndefined();
  });
});

describe('content guard honours repoScope', () => {
  const deps = (probe: { code: number; stdout: string }) => {
    const { runGit, calls } = makeRunGit(probe);
    return {
      calls,
      args: {
        runGit,
        repoPath: REPO_ROOT,
        readText: async () => LEAKY,
        detectors: [identityLeakDetector],
        log: () => {},
      } as never,
    };
  };

  it('RUNS the detector in the superproject (probe prints nothing)', async () => {
    const { args } = deps({ code: 0, stdout: '' });
    const offenders = await detectContentOffenders(args);
    expect(offenders.map((o) => o.detectorKey)).toEqual(['identity-leak']);
  });

  it('SKIPS the detector inside a submodule — the 45 by-design files must commit', async () => {
    const { args } = deps({ code: 0, stdout: '/home/x/superproject\n' });
    expect(await detectContentOffenders(args)).toEqual([]);
  });

  it('SKIPS it when the repo kind cannot be determined (fail-safe direction)', async () => {
    // Unknown must behave like "submodule", never like "superproject": wrongly running
    // here quarantines by-design files fleet-wide, while wrongly skipping only forfeits
    // one tick of a guard that is itself a backstop.
    const { args } = deps({ code: 128, stdout: '' });
    expect(await detectContentOffenders(args)).toEqual([]);
  });

  it('does not pay the repo-kind probe when no detector asks for scoping', async () => {
    const { runGit, calls } = makeRunGit({ code: 0, stdout: '' });
    await detectContentOffenders({
      runGit,
      repoPath: REPO_ROOT,
      readText: async () => LEAKY,
      detectors: [{ ...identityLeakDetector, repoScope: undefined }],
      log: () => {},
    } as never);
    expect(calls.some((c) => c[0] === 'rev-parse')).toBe(false);
  });
});

describe('identity detector resolves the guarded repository ruleset', () => {
  const tempRepos: string[] = [];

  afterEach(() => {
    for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it('guards an independent application without a copied framework matcher', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'identity-detector-app-'));
    tempRepos.push(repo);
    const logs: string[] = [];
    const offenders = await detectContentOffenders({
      repoPath: repo,
      detectors: [identityLeakDetector],
      runGit: statusRunGit(['?? fixture.txt']),
      readText: async () => LEAKY,
      log: (message: string) => logs.push(message),
    } as never);
    expect(offenders.map((offender) => offender.detectorKey)).toEqual(['identity-leak']);
    expect(logs.join('\n')).not.toContain('threw');
    await expect(findIdentityLeakError('clean.txt', 'portable content\n', repo)).resolves.toBeNull();
  });

  it('does not use the operator bundle checkout rules when the guarded tree differs', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'identity-detector-repo-'));
    tempRepos.push(repo);
    const moduleDir = join(repo, 'scripts', 'lib');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, 'identity-leak-patterns.mjs'),
      [
        "const GENERIC_USERS = new Set(['somedev']);",
        'export const FIX_HINT = "strip";',
        'export const BOX_IDENTITY_FIX_HINT = "derive";',
        'export const isSkippedPath = () => false;',
        'export const renderLeak = () => "owner";',
        'export const findOwnerNameLeaks = () => [];',
        'export function findBoxIdentityPaths(text) {',
        "  if (!text.includes(['/','home','somedev','/'].join('')) || GENERIC_USERS.has('somedev')) return [];",
        "  return [{ line: 1, user: 'somedev', text }];",
        '}',
      ].join('\n'),
    );

    const offenders = await detectContentOffenders({
      repoPath: repo,
      detectors: [identityLeakDetector],
      runGit: statusRunGit(['?? fixture.txt']),
      readText: async () => `HOME=${['', 'home', 'somedev', 'fixture'].join('/')}`,
      log: () => {},
    } as never);

    expect(offenders).toEqual([]);
  });
});
