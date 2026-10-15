// EI-25852209928775891 — recurrence guard for the candidate-pin contract between the
// desktop provenance EMITTER (papercusp-desktop/bin/emit-build-provenance.sh) and the
// P-521 candidate CONSUMER (./p2p-candidate-evidence.ts deriveCandidateProvenance).
//
// The D-223 private producers emitted each leg record with the SUPERPROJECT as the git
// root, so gitHead was the workspace head while buildSha was the baked desktop head.
// verify-provenance.sh accepted those records; the consumer's desktop pin
// (gitHead.startsWith(buildSha)) rejected them, and that surfaced only at acceptance
// time, after a full cut. These tests run the REAL emitter in a throwaway
// workspace + desktop repository pair and feed its output to the REAL consumer.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCandidateProvenance, parseLegBuildProvenance } from './p2p-candidate-evidence';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const EMIT = join(REPO, 'papercusp-desktop/bin/emit-build-provenance.sh');
const LINUX_PRODUCER = join(REPO, 'papercusp-desktop/bin/build-linux-local.sh');
const RELEASE_LOCAL = join(REPO, 'papercusp-desktop/bin/release-local.sh');
const VERSION = '0.0.99';

// Hermetic git: no user/system config (signing, hooks, templates) leaks into the fixture.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

// The caller's own provenance seams must never reach the emitter under test.
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PROVENANCE_') || key.startsWith('PAPERCUSP_')) continue;
    env[key] = value;
  }
  return { ...env, ...GIT_ENV };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() }).trim();
}

interface Fixture {
  root: string;
  workspace: string;
  desktop: string;
  out: string;
  artifact: string;
  workspaceHead: string;
  desktopHead: string;
  buildSha: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'candidate-pin-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const desktop = join(workspace, 'papercusp-desktop');
  mkdirSync(desktop, { recursive: true });
  git(workspace, 'init', '-q');
  // The desktop checkout is its own repository; keep it out of the workspace status
  // so both sources read clean, as a prepared release source does.
  writeFileSync(join(workspace, '.gitignore'), 'papercusp-desktop/\n');
  writeFileSync(join(workspace, 'README'), 'workspace\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-qm', 'workspace');
  git(desktop, 'init', '-q');
  writeFileSync(join(desktop, 'Cargo.toml'), '[package]\nname = "fixture"\n');
  git(desktop, 'add', '.');
  git(desktop, 'commit', '-qm', 'desktop');
  const out = join(root, 'out');
  mkdirSync(out);
  const artifact = join(out, `Papercusp GUI_${VERSION}_amd64.deb`);
  writeFileSync(artifact, 'fixture deb bytes\n');
  const desktopHead = git(desktop, 'rev-parse', 'HEAD');
  return {
    root, workspace, desktop, out, artifact,
    workspaceHead: git(workspace, 'rev-parse', 'HEAD'),
    desktopHead,
    buildSha: desktopHead.slice(0, 8),
  };
}

function captureSources(f: Fixture, manifest: string, labels: string[]): void {
  const result = spawnSync('bash', [EMIT, '--capture-dirty-source', manifest, ...labels], {
    cwd: f.root, encoding: 'utf8', env: baseEnv(),
  });
  expect(result.status, result.stderr).toBe(0);
}

function emit(f: Fixture, env: Record<string, string>) {
  return spawnSync('bash', [EMIT, f.out, VERSION, f.buildSha, 'false', f.artifact], {
    cwd: f.root, encoding: 'utf8', env: { ...baseEnv(), PROVENANCE_SOURCE_GIT_DIRTY: 'false', ...env },
  });
}

function consume(f: Fixture) {
  const path = join(f.out, 'build-provenance.json');
  const record = parseLegBuildProvenance(JSON.parse(readFileSync(path, 'utf8')), path);
  const derived = deriveCandidateProvenance({ version: VERSION, channel: 'alpha', legs: [{ leg: 'linux-gui', path, record }] });
  const status = (id: string) => derived.provenance.checks.find((c) => c.id === id)?.status;
  return { record, derived, status };
}

describe('emit-build-provenance candidate pin (EI-25852209928775891)', () => {
  it('reproduces the defect without the pin: the superproject-rooted record is emitted but the consumer rejects it', () => {
    const f = fixture();
    const result = emit(f, { PROVENANCE_GIT_ROOT: f.workspace, PROVENANCE_SOURCE_GIT_HEAD: f.workspaceHead });
    expect(result.status, result.stderr).toBe(0);
    const path = join(f.out, 'build-provenance.json');
    const record = parseLegBuildProvenance(JSON.parse(readFileSync(path, 'utf8')), path);
    expect(record.gitHead).toBe(f.workspaceHead);
    expect(record.gitHead.startsWith(record.buildSha)).toBe(false);
    // Exactly what the D-223 records hit: no labelled workspace head, so the
    // consumer cannot even name the candidate source.
    expect(() => consume(f)).toThrow(/cannot identify the candidate source/);
  });

  it('refuses that same superproject-rooted record at emit time when the pin is required', () => {
    const f = fixture();
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: '1',
      PROVENANCE_GIT_ROOT: f.workspace,
      PROVENANCE_SOURCE_GIT_HEAD: f.workspaceHead,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/candidate pin: gitHead .* does not start with buildSha/);
    expect(existsSync(join(f.out, 'build-provenance.json'))).toBe(false);
  });

  it('refuses a desktop-rooted record whose source capture names no workspace repository', () => {
    const f = fixture();
    const manifest = join(f.root, 'desktop-only.json');
    captureSources(f, manifest, [`desktop=${f.desktop}`]);
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: '1',
      PROVENANCE_GIT_ROOT: f.desktop,
      PROVENANCE_SOURCE_GIT_HEAD: f.desktopHead,
      PROVENANCE_SOURCE_DIRTY_MANIFEST: manifest,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/candidate pin: dirtySource records no single 'workspace' repository head/);
    expect(existsSync(join(f.out, 'build-provenance.json'))).toBe(false);
  });

  it('accepts the release-local schema, and the consumer pins desktop and workspace from it', () => {
    const f = fixture();
    const manifest = join(f.root, 'candidate-source-state.json');
    captureSources(f, manifest, [`desktop=${f.desktop}`, `workspace=${f.workspace}`]);
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: '1',
      PROVENANCE_GIT_ROOT: f.desktop,
      PROVENANCE_SOURCE_GIT_HEAD: f.desktopHead,
      PROVENANCE_SOURCE_DIRTY_MANIFEST: manifest,
    });
    expect(result.status, result.stderr).toBe(0);
    const { record, derived, status } = consume(f);
    expect(record.gitHead).toBe(f.desktopHead);
    expect(status('desktop-pin')).toBe('pass');
    expect(status('source-revision')).toBe('pass');
    expect(derived.provenance.sourceSha).toBe(f.workspaceHead);
  });

  it('wires the producer-bank Linux GUI leg emit through the pin with desktop and workspace labels', () => {
    const text = readFileSync(LINUX_PRODUCER, 'utf8');
    const start = text.indexOf('--producer-bank ]]; then');
    const end = text.indexOf('LINUX_GUI_PRODUCTION_COMPLETE', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = text.slice(start, end);
    expect(branch).toContain('"desktop=$PAPERCUSP_DESKTOP_TARGET_ROOT" "workspace=$PAPERCUSP_PRODUCER_SOURCE"');
    const legEmit = branch.slice(branch.lastIndexOf('PROVENANCE_REQUIRE_CANDIDATE_PIN=1'));
    expect(legEmit).toContain('PROVENANCE_GIT_ROOT="$PAPERCUSP_DESKTOP_TARGET_ROOT"');
    expect(legEmit).toContain('PROVENANCE_SOURCE_GIT_HEAD="$PAPERCUSP_PRODUCER_DESKTOP_HEAD"');
    expect(legEmit).toContain('bundle/deb');
    expect(branch).not.toContain('PROVENANCE_GIT_ROOT="$PAPERCUSP_PRODUCER_SOURCE"');
  });

  // WI-6554700010010000: release-local.sh opts its leg emits in with `auto`, which
  // enforces exactly when the leg could be a candidate (bare-commit buildSha).
  it('auto enforces on a bare-commit buildSha: the superproject-rooted record is refused', () => {
    const f = fixture();
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: 'auto',
      PROVENANCE_GIT_ROOT: f.workspace,
      PROVENANCE_SOURCE_GIT_HEAD: f.workspaceHead,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/candidate pin: gitHead .* does not start with buildSha/);
    expect(existsSync(join(f.out, 'build-provenance.json'))).toBe(false);
  });

  it('auto accepts the release-local schema on a bare-commit buildSha', () => {
    const f = fixture();
    const manifest = join(f.root, 'candidate-source-state.json');
    captureSources(f, manifest, [`desktop=${f.desktop}`, `workspace=${f.workspace}`]);
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: 'auto',
      PROVENANCE_GIT_ROOT: f.desktop,
      PROVENANCE_SOURCE_GIT_HEAD: f.desktopHead,
      PROVENANCE_SOURCE_DIRTY_MANIFEST: manifest,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(consume(f).status('desktop-pin')).toBe('pass');
  });

  it('auto exempts a -dirty buildSha, which no candidate pin can match, instead of refusing the cut', () => {
    const base = fixture();
    const f = { ...base, buildSha: `${base.buildSha}-dirty` };
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: 'auto',
      PROVENANCE_GIT_ROOT: f.desktop,
      PROVENANCE_SOURCE_GIT_HEAD: f.desktopHead,
      PROVENANCE_SOURCE_GIT_DIRTY: 'true',
    });
    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(join(f.out, 'build-provenance.json'), 'utf8'));
    expect(written.buildSha).toBe(f.buildSha);
  });

  it('refuses an unrecognized pin value instead of silently disabling the guard', () => {
    const f = fixture();
    const result = emit(f, {
      PROVENANCE_REQUIRE_CANDIDATE_PIN: 'yes',
      PROVENANCE_GIT_ROOT: f.desktop,
      PROVENANCE_SOURCE_GIT_HEAD: f.desktopHead,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/must be 0, 1 or auto \(got 'yes'\)/);
    expect(existsSync(join(f.out, 'build-provenance.json'))).toBe(false);
  });

  it('wires both release-local.sh leg emits through the auto pin, with desktop and workspace captured at cut start', () => {
    const text = readFileSync(RELEASE_LOCAL, 'utf8');
    expect(text).toContain('"desktop=$ROOT" "workspace=$ROOT/.."');
    expect(text).toContain('export PROVENANCE_SOURCE_DIRTY_MANIFEST=');
    const anchor = 'PROVENANCE_GIT_ROOT="$ROOT" bash "$ROOT/bin/emit-build-provenance.sh"';
    const sites: number[] = [];
    for (let i = text.indexOf(anchor); i >= 0; i = text.indexOf(anchor, i + 1)) sites.push(i);
    // The Linux leg (emit_linux_build_provenance) and the mac leg collector.
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      const lead = text.slice(0, site).split('\n').slice(-3).join('\n');
      expect(lead).toContain('PROVENANCE_REQUIRE_CANDIDATE_PIN="${PROVENANCE_REQUIRE_CANDIDATE_PIN:-auto}" \\');
    }
  });
});
