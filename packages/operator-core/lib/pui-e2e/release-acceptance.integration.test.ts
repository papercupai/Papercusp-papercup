/**
 * Installed-TUI release acceptance (pui-first-party-public-release P-012 / D-018).
 *
 * R-10 and R-14 run the release check against the REAL commitments — the
 * tables in apps/tui/PUBLIC_RELEASE_UX.md and apps/tui/release/acceptance-matrix.json
 * — with a complete evidence set as the positive control, then remove or
 * weaken one leg at a time and require a refusal that names it.
 *
 * R-12 runs the real release stage: package-release.sh builds a candidate from
 * HEAD, the stage installs it into a clean HOME and drives the PTY suites
 * through that installed bin/pui. Its oracles are computed here, independently
 * of the stage: this file's own sha256 of the installed file and the archive's
 * own CONTENTS.sha256.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  AcceptanceMatrixFile, Candidate, EvidenceRow, Exclusion, Verdict,
} from './release-acceptance';
import { runChildWithLiveLog, runReleaseAcceptance } from './release-acceptance-run';

// Mutation-probe seam (copy-out tier): PUI_RELEASE_ACCEPTANCE_SUBJECT substitutes a mutated
// copy of release-acceptance.ts for EVERY importer — this suite and release-acceptance-run.ts,
// whose runReleaseAcceptance applies the qualification rules the R-12 journey asserts — so a
// caught mutant proves the R-10/R-12/R-14 checks are falsifiable without touching the shared
// tree. Unset, every importer loads the real module.
// The substitute supplies the module's LOGIC only. Its own REPO_ROOT resolves to the probe's
// relocated mirror, which has no .git, node_modules or packaging scripts, so the repository
// locations every importer derives from REPO_ROOT (git, the packager, vitest, the reporter)
// stay those of the real tree.
vi.mock('./release-acceptance', async (original) => {
  const real = await original<typeof import('./release-acceptance')>();
  if (!process.env.PUI_RELEASE_ACCEPTANCE_SUBJECT) return real;
  const substitute: typeof import('./release-acceptance') = await import(process.env.PUI_RELEASE_ACCEPTANCE_SUBJECT);
  return {
    ...substitute,
    REPO_ROOT: real.REPO_ROOT,
    UX_CONTRACT: real.UX_CONTRACT,
    ACCEPTANCE_MATRIX: real.ACCEPTANCE_MATRIX,
  };
});
const subject: typeof import('./release-acceptance') = await import('./release-acceptance');
const { checkReleaseAcceptance, loadAcceptanceMatrix, loadRequiredMatrix, REPO_ROOT } = subject;

const required = loadRequiredMatrix();
const matrix = loadAcceptanceMatrix();
const PLATFORM = 'Linux x86_64';
const INSTALL_ROOT = '/fixture/home/.local/share/pui';
const INSTALLED = `${INSTALL_ROOT}/releases/0.1.0-fixture/bin/pui`;
const INSTALLED_SHA = 'a'.repeat(64);
const CHAT_SUITE = 'packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts';

function candidate(advertise = [{ platform: PLATFORM, backend: 'Claude' }]): Candidate {
  return {
    sourceSha: 'f'.repeat(40), artifact: 'linux-x86_64', archive: '/fixture/pui.tar.gz', archiveSha256: 'c'.repeat(64),
    installRoot: INSTALL_ROOT, installedBinarySha256: INSTALLED_SHA, advertise,
  };
}

function row(tag: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    tag, test: `fixture ${tag}`, module: CHAT_SUITE, state: 'passed', harness: { operator: 'production' },
    platform: PLATFORM, engine: 'scripted', model: null, binary: INSTALLED, binaryRealpath: INSTALLED,
    binarySha256: INSTALLED_SHA, correlation: null, ...overrides,
  };
}

/** Every tag the real matrix asks of a Linux × Claude candidate, each proven once. */
function completeEvidence(): EvidenceRow[] {
  const capabilityTags = [...new Set(Object.values(matrix.capabilities).flat())];
  const claude = matrix.backends.Claude;
  return [
    ...capabilityTags.map((tag) => row(tag)),
    ...claude.journeys.map((tag) => row(tag, { engine: claude.engine, model: 'claude-sonnet-5' })),
  ];
}

const check = (rows: EvidenceRow[], options: { matrix?: AcceptanceMatrixFile; candidate?: Candidate } = {}): Verdict =>
  checkReleaseAcceptance(required, options.matrix ?? matrix, options.candidate ?? candidate(), rows);

describe('P-012 release check over the committed contract (fixture evidence)', () => {
  test('AUTO-BAR-R-10-P-012: an advertised combination missing any installed-product leg is refused', () => {
    const complete = completeEvidence();
    const accepted = check(complete);
    expect(accepted.refusals).toEqual([]);
    expect(accepted.ok).toBe(true);
    expect(accepted.cells.find((cell) => cell.platform === PLATFORM && cell.backend === 'Claude'))
      .toMatchObject({ status: 'advertised', missing: [] });
    // Every other Required cell is still listed, with its reason — never dropped.
    const unadvertised = accepted.cells.filter((cell) => cell.status === 'not-advertised');
    expect(unadvertised).toHaveLength(required.platforms.length * required.backends.length - 1);
    expect(unadvertised.every((cell) => cell.required && cell.note?.startsWith('Required, not advertised'))).toBe(true);

    const journeys = matrix.backends.Claude.journeys;
    expect(journeys.length).toBeGreaterThan(0);
    const weakenings: Array<[string, Partial<EvidenceRow>]> = [
      ['skipped', { state: 'skipped' }],
      ['failed', { state: 'failed' }],
      ['fixture operator', { harness: { operator: 'fake' } }],
      ['no harness stamp', { harness: null }],
      ['cargo-built binary', { binarySha256: 'b'.repeat(64) }],
      ['same bytes outside the install', { binaryRealpath: '/repo/target/release/pui' }],
      ['sibling of the install root', { binaryRealpath: `${INSTALL_ROOT}-other/bin/pui` }],
      ['scripted instead of the real engine', { engine: 'scripted' }],
      ['another platform', { platform: 'macOS arm64' }],
    ];
    for (const tag of journeys) {
      const dropped = check(complete.filter((entry) => entry.tag !== tag));
      expect(dropped.ok, tag).toBe(false);
      expect(dropped.refusals).toContain(`${PLATFORM} × Claude is advertised without installed-product evidence for ${tag}`);
      expect(dropped.cells.find((cell) => cell.platform === PLATFORM && cell.backend === 'Claude'))
        .toMatchObject({ status: 'refused', missing: [tag] });
      for (const [label, weakened] of weakenings) {
        const verdict = check(complete.map((entry) => (entry.tag === tag ? { ...entry, ...weakened } : entry)));
        expect(verdict.ok, `${tag}: ${label}`).toBe(false);
        expect(verdict.refusals, `${tag}: ${label}`)
          .toContain(`${PLATFORM} × Claude is advertised without installed-product evidence for ${tag}`);
      }
    }

    expect(check(complete, { candidate: candidate([]) }).refusals)
      .toContain('the candidate advertises no platform/backend combination');
    expect(check(complete, { candidate: candidate([{ platform: 'macOS arm64', backend: 'Claude' }]) }).refusals)
      .toContain('advertised macOS arm64 × Claude ships the macos-aarch64 artifact, not this linux-x86_64 candidate');
  });

  test('AUTO-BAR-R-14-P-012: a required capability row without installed-product evidence blocks release unless the owner excluded it', () => {
    const complete = completeEvidence();
    expect(check(complete).ok).toBe(true);
    expect(required.capabilities.length).toBeGreaterThan(0);
    expect(Object.keys(matrix.capabilities).sort()).toEqual([...required.capabilities].sort());

    for (const capability of required.capabilities) {
      const [tag] = matrix.capabilities[capability];
      const verdict = check(complete.filter((entry) => entry.tag !== tag));
      expect(verdict.ok, capability).toBe(false);
      expect(verdict.refusals).toContain(`required capability '${capability}' on ${PLATFORM} has no installed-product evidence for ${tag}`);
      expect(verdict.capabilities.find((entry) => entry.capability === capability)).toMatchObject({ status: 'missing' });
    }

    const target = 'Editable task list';
    const [tag] = matrix.capabilities[target];
    const missing = complete.filter((entry) => entry.tag !== tag);
    const approved: Exclusion = {
      capability: target, reason: 'fixture', approvedBy: 'owner:Avi', decisionRef: 'pui-first-party-public-release-2026-09-07#D-999',
    };
    const unapproved: Exclusion[] = [
      { ...approved, approvedBy: 'su-091ad703-d98f-4ccb-a20f-ea02d02e9f75' },
      { ...approved, approvedBy: 'owner:' },
      { ...approved, decisionRef: '' },
      { ...approved, reason: ' ' },
      { ...approved, platforms: ['macOS arm64'] },
    ];
    for (const exclusion of unapproved) {
      const verdict = check(missing, { matrix: { ...matrix, exclusions: [exclusion] } });
      expect(verdict.ok, JSON.stringify(exclusion)).toBe(false);
      expect(verdict.capabilities.find((entry) => entry.capability === target)?.status).toBe('missing');
    }
    const excluded = check(missing, { matrix: { ...matrix, exclusions: [approved] } });
    expect(excluded.refusals).toEqual([]);
    expect(excluded.capabilities.find((entry) => entry.capability === target))
      .toMatchObject({ status: 'excluded', exclusion: approved });

    // The mapping may not drift from the contract in either direction, and a
    // row mapped to no test is a refusal, not a vacuous pass.
    const { [target]: _removed, ...withoutTarget } = matrix.capabilities;
    expect(check(complete, { matrix: { ...matrix, capabilities: withoutTarget } }).refusals)
      .toContain(`capability '${target}' is in PUBLIC_RELEASE_UX.md but not in acceptance-matrix.json`);
    expect(check(complete, { matrix: { ...matrix, capabilities: { ...matrix.capabilities, 'Invented row': ['PUI_COMPOSER_ACCEPTANCE'] } } }).refusals)
      .toContain(`capability 'Invented row' is in acceptance-matrix.json but not in PUBLIC_RELEASE_UX.md`);
    expect(check(complete, { matrix: { ...matrix, capabilities: { ...matrix.capabilities, [target]: [] } } }).refusals)
      .toContain(`required capability '${target}' on ${PLATFORM} has no installed-product evidence for (no installed-product test mapped)`);
  });
});

describe('P-012 release acceptance child progress log', () => {
  test('streams output before the child exits and retains its exact exit code', { timeout: 10_000 }, async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'pui-acceptance-live-log-'));
    const logPath = path.join(work, 'vitest-scripted.log');
    const marker = 'PUI_ACCEPTANCE_PROGRESS_READY';
    let settled = false;
    try {
      const running = runChildWithLiveLog(process.execPath, [
        '-e', `process.stdout.write(${JSON.stringify(marker)}); setTimeout(() => process.exit(23), 700);`,
      ], { cwd: work, timeout: 5_000 }, logPath).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf8')).toContain(marker);
      }, { interval: 10, timeout: 2_000 });
      expect(settled).toBe(false);

      const result = await running;
      expect(result).toMatchObject({ status: 23, signal: null });
      expect(readFileSync(logPath, 'utf8')).toContain('child exit: code=23');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

const TARGET = 'linux-x86_64';
const BUILD_TIMEOUT_MS = 40 * 60_000;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
let WORK = '';

describe.sequential('P-012 release stage over a real candidate (package → install → installed PTY journeys)', () => {
  beforeAll(() => {
    WORK = mkdtempSync(path.join(tmpdir(), 'pui-p012-'));
  });
  afterAll(() => {
    if (WORK) rmSync(WORK, { recursive: true, force: true });
  });

  test('AUTO-BAR-R-12-P-012: release acceptance drives user input through the installed PUI binary and the production operator', { timeout: 90 * 60_000 }, async () => {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const packaged = spawnSync(path.join(REPO_ROOT, 'apps/tui/scripts/package-release.sh'),
      ['--target', TARGET, '--sha', head, '--out', path.join(WORK, 'dist')],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    const line = packaged.stdout?.split('\n').find((entry) => entry.startsWith('PUI_PACKAGE_RESULT '));
    expect(packaged.status, `${packaged.stdout}\n${packaged.stderr}`.slice(-8_000)).toBe(0);
    const pkg = JSON.parse(line!.slice('PUI_PACKAGE_RESULT '.length)) as { archive: string; name: string; sourceSha: string };
    expect(pkg.sourceSha).toBe(head);

    const result = await runReleaseAcceptance({
      archive: pkg.archive,
      advertise: [{ platform: PLATFORM, backend: 'Claude' }],
      // One production journey that types into the composer, plus the
      // fixture-operator task journey, which prints a release tag it must not earn.
      testFilter: 'first exact draft reaches the structured SU engine|PUI-TASK owner journey',
      work: path.join(WORK, 'stage'),
    });
    const verdict = JSON.parse(readFileSync(result.out, 'utf8')) as Verdict & { runner: { platform: string } };
    expect(result.out).toBe(`${pkg.archive}.acceptance.json`);
    expect(verdict.runner.platform).toBe(PLATFORM);
    expect(result.legs).toEqual([expect.objectContaining({ engine: 'scripted', status: 0 })]);
    expect(result.stockMachines).toEqual([
      expect.objectContaining({ image: 'ubuntu:24.04', status: 0 }),
      expect.objectContaining({ image: 'debian:stable-slim', status: 0 }),
    ]);
    expect(result.stockMachines.every(({ output }) => output.includes('PUI local install: OK'))).toBe(true);
    expect(result.stockMachines.every(({ output }) => /psu \d+\.\d+\.\d+/.test(output))).toBe(true);

    // Independent oracles for "the installed binary": our own hash of the file
    // the launcher resolves to, and the archive's own digest list.
    const installed = realpathSync(path.join(WORK, 'stage', 'home', '.local', 'share', 'pui', 'current', 'bin', 'pui'));
    const contents = execFileSync('tar', ['-xzOf', pkg.archive, `${pkg.name}/CONTENTS.sha256`], { encoding: 'utf8' });
    expect(contents).toContain(`${sha256(installed)}  bin/pui`);
    expect(verdict.candidate.installedBinarySha256).toBe(sha256(installed));

    const composer = verdict.evidence.find((entry) => entry.tag === 'PUI_COMPOSER_ACCEPTANCE');
    expect(composer).toMatchObject({ module: CHAT_SUITE, engine: 'scripted', platform: PLATFORM, qualifies: true, reason: null });
    // The journey went keystrokes → installed pui → the production launch/send
    // routes → the streamed reply, correlated to one saved chat.
    expect(composer!.correlation?.chatId).toMatch(/\S/);
    expect(composer!.correlation?.traffic).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/adv/sessions/launch-su', status: 200, attachedEngine: true, transport: 'structured' }),
    ]));

    // The fixture-operator suite printed the task-list tag and passed; it
    // still cannot stand as release evidence, so the candidate stays blocked.
    const task = verdict.evidence.find((entry) => entry.tag === 'PUI_TASK_ACCEPTANCE');
    expect(task).toMatchObject({ qualifies: false, reason: 'its suite drove a fake operator' });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals).toContain(`required capability 'Editable task list' on ${PLATFORM} has no installed-product evidence for PUI_TASK_ACCEPTANCE`);
  });
});
