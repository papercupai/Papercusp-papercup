import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const binDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin');
const vh = path.join(binDir, 'vh.sh');
const verifier = path.resolve(binDir, '../../../../scripts/verify-tauri-headless.sh');
const original = 'guard-before-probe\n';
const mutant = 'peer-mutant\n';

let fixtureRoot = '';
let admissionDir = '';
let scratch = '';
let fakeBin = '';

function createProbeFixture() {
  fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'vh-probe-admission-root-')));
  const subject = path.join(fixtureRoot, 'src', 'subject.txt');
  mkdirSync(path.dirname(subject), { recursive: true });
  writeFileSync(subject, mutant);

  scratch = mkdtempSync(path.join(tmpdir(), 'mutation-probe.fixture-'));
  const snapshot = path.join(scratch, `${path.basename(subject)}.orig`);
  writeFileSync(snapshot, original);

  const key = createHash('sha256').update(fixtureRoot).digest('hex');
  admissionDir = path.join('/tmp', `papercusp-mutation-probe-${process.getuid!()}-${key}`);
  mkdirSync(admissionDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(admissionDir, 'original.manifest'),
    Buffer.from(`${fixtureRoot}\0${subject}\0${snapshot}\0${process.pid}\0`),
  );
  return subject;
}

function runWithProbeOverlay(subject: string) {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'vh-probe-admission-bin-'));
  const fakeBwrap = path.join(fakeBin, 'bwrap');
  writeFileSync(
    fakeBwrap,
    `#!/usr/bin/env bash
set -euo pipefail
snapshot_fd= subject=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ro-bind-data) snapshot_fd="$2"; subject="$3"; shift 3 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
[ -n "$snapshot_fd" ] && [ -n "$subject" ] || exit 96
if [ "$1" = cat ] && [ "$2" = "$subject" ]; then
  cat "/dev/fd/$snapshot_fd"
else
  exec "$@"
fi
`,
    { mode: 0o755 },
  );
  const script = `set -euo pipefail\nsource ${JSON.stringify(vh)}\nvh_probe_admitted_exec ${JSON.stringify(fixtureRoot)} -- cat ${JSON.stringify(subject)}\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    timeout: 10_000,
  });
}

afterEach(() => {
  if (admissionDir) rmSync(admissionDir, { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
  fixtureRoot = admissionDir = scratch = fakeBin = '';
});

describe('vh_probe_admitted_exec', () => {
  it('reads the original source snapshot while a peer mutation probe is active', () => {
    const subject = createProbeFixture();
    const result = runWithProbeOverlay(subject);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(original);
    expect(readFileSync(subject, 'utf8')).toBe(mutant);
  });

  it('fences both verifier source sizing and source copy', () => {
    const source = readFileSync(verifier, 'utf8');
    expect(source).toContain('vh_probe_admitted_exec "$REPO_DIR" -- rsync -an --stats');
    expect(source).toContain('vh_probe_admitted_exec "$REPO_DIR" -- rsync -a --delete');
  });

  it('refuses an unrecognized active manifest without running the reader', () => {
    const subject = createProbeFixture();
    writeFileSync(path.join(admissionDir, 'original.manifest'), 'invalid\n');
    const script = `set -euo pipefail\nsource ${JSON.stringify(vh)}\nvh_probe_admitted_exec ${JSON.stringify(fixtureRoot)} -- bash -c 'echo ran'\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });

    expect(existsSync(subject)).toBe(true);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid original snapshot');
  });
});
