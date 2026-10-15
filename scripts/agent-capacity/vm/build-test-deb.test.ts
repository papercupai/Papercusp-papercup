import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'build-test-deb.sh');

// The script finds the repo root from its own location (scripts/agent-capacity/vm/../../..), so each
// test copies it into a throwaway tree whose papercusp-desktop/bin holds recording fakes. The fake
// sidecar build writes the bundle from $FAKE_BUNDLE_BODY; the fake deb build prints the artifact line.
const FAKE_SIDECAR = String.raw`#!/usr/bin/env bash
echo "sidecar lockwait=$PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC" >> "$FAKE_CALLS"
[ "$((FAKE_SIDECAR_RC + 0))" -eq 0 ] || exit "$FAKE_SIDECAR_RC"
mkdir -p src-tauri/sidecar
printf '%s\n' "$FAKE_BUNDLE_BODY" > src-tauri/sidecar/serve.mjs
`;
const FAKE_DEB = String.raw`#!/usr/bin/env bash
echo "deb $*" >> "$FAKE_CALLS"
echo "TEST_ARTIFACT_DEB=/tmp/fake-TEST-ARTIFACT.deb"
`;

describe('vm/build-test-deb.sh (fake build steps)', () => {
  let root: string;
  const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'build-test-deb-'));
    mkdirSync(path.join(root, 'scripts/agent-capacity/vm'), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, 'scripts/agent-capacity/vm/build-test-deb.sh'));
    const bin = path.join(root, 'papercusp-desktop/bin');
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of [['build-desktop-sidecar.sh', FAKE_SIDECAR], ['build-and-archive-deb.sh', FAKE_DEB]] as const) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/configure.ts'), "    buildLocal: async () => buildDeferredSidecarAwareEmbedder('local', 'document'),\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const markers = (body: string) => {
    writeFileSync(path.join(root, 'markers.txt'), body);
    return path.join(root, 'markers.txt');
  };
  const run = (env: Record<string, string>) => {
    const r = spawnSync('bash', [path.join(root, 'scripts/agent-capacity/vm/build-test-deb.sh')], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        FAKE_CALLS: path.join(root, 'calls.log'),
        FAKE_BUNDLE_BODY: 'x=buildDeferredSidecarAwareEmbedder("local","document");y="worktree_divergence";',
        ...env,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  // A source marker whose regex contains spaces, plus two bundle markers matching esbuild's quoting.
  const GOOD = [
    '# fixes under test',
    "d051-source src/configure.ts buildDeferredSidecarAwareEmbedder\\('local', 'document'\\)",
    '',
    'd051-bundle @sidecar buildDeferredSidecarAwareEmbedder\\("local", ?"document"\\)',
    'd055-bundle @sidecar worktree_divergence',
  ].join('\n');

  it('builds the sidecar, checks the bundle markers, then builds the deb, and exits 0', () => {
    const r = run({ MARKERS_FILE: markers(GOOD) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MARKER d051-source=1/);
    expect(r.out).toMatch(/MARKER d051-bundle=1/);
    expect(r.out).toMatch(/MARKER d055-bundle=1/);
    expect(r.out).toMatch(/SIDECAR_RC=0/);
    expect(r.out).toMatch(/DEB_RC=0/);
    expect(r.out).toMatch(/TEST_ARTIFACT_DEB=\/tmp\/fake-TEST-ARTIFACT\.deb/);
    expect(calls().trim().split('\n')).toEqual(['sidecar lockwait=7200', 'deb --test-artifact']);
  });

  it('fails a missing SOURCE marker with exit 7 before any build step runs', () => {
    const r = run({ MARKERS_FILE: markers(`${GOOD}\nwi6420 src/configure.ts fn provision_env_operators_for\\(`) });
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/MARKER_MISSING wi6420/);
    expect(calls()).toBe('');
  });

  it('fails a missing BUNDLE marker with exit 7 after the sidecar build and never builds the deb', () => {
    const r = run({ MARKERS_FILE: markers(GOOD), FAKE_BUNDLE_BODY: 'x=buildDeferredSidecarAwareEmbedder("local","document");' });
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/MARKER_MISSING d055-bundle/);
    expect(calls()).toMatch(/^sidecar /);
    expect(calls()).not.toMatch(/deb /);
  });

  it("propagates a failed sidecar build's exit code and never builds the deb", () => {
    const r = run({ MARKERS_FILE: markers(GOOD), FAKE_SIDECAR_RC: '5' });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/SIDECAR_RC=5/);
    expect(calls()).not.toMatch(/deb /);
  });

  it('CHECK_ONLY=1 checks the bundle already on disk and builds nothing', () => {
    mkdirSync(path.join(root, 'papercusp-desktop/src-tauri/sidecar'), { recursive: true });
    writeFileSync(path.join(root, 'papercusp-desktop/src-tauri/sidecar/serve.mjs'), 'buildDeferredSidecarAwareEmbedder("local", "document") worktree_divergence\n');
    const ok = run({ MARKERS_FILE: markers(GOOD), CHECK_ONLY: '1' });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/CHECK_ONLY_OK/);
    expect(calls()).toBe('');

    writeFileSync(path.join(root, 'papercusp-desktop/src-tauri/sidecar/serve.mjs'), 'an older bundle\n');
    const stale = run({ MARKERS_FILE: markers(GOOD), CHECK_ONLY: '1' });
    expect(stale.code).toBe(7);
    expect(stale.out).toMatch(/MARKER_MISSING d051-bundle/);
    expect(stale.out).toMatch(/MARKER_MISSING d055-bundle/);
    expect(stale.out).toMatch(/MARKERS_CHECKED phase=sidecar count=2 missing=2/);
  });

  it('SKIP_SIDECAR=1 reuses the bundle on disk and still checks it before the deb', () => {
    mkdirSync(path.join(root, 'papercusp-desktop/src-tauri/sidecar'), { recursive: true });
    writeFileSync(path.join(root, 'papercusp-desktop/src-tauri/sidecar/serve.mjs'), 'stale bundle\n');
    const r = run({ MARKERS_FILE: markers(GOOD), SKIP_SIDECAR: '1' });
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/SIDECAR_SKIPPED/);
    expect(calls()).toBe('');
  });

  it('refuses a missing markers file (exit 8) and a malformed marker line (exit 7)', () => {
    expect(run({}).code).toBe(8);
    expect(run({ MARKERS_FILE: path.join(root, 'nope.txt') }).code).toBe(8);
    const r = run({ MARKERS_FILE: markers('lonely-name\n') });
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/MARKER_MALFORMED lonely-name/);
  });

  it('honours an explicit PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC', () => {
    const r = run({ MARKERS_FILE: markers(GOOD), PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '900' });
    expect(r.code).toBe(0);
    expect(calls()).toMatch(/sidecar lockwait=900/);
  });
});
