import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const selector = source.match(/^select_verifier_snapshot_root\(\) \{[\s\S]*?^\}/m)?.[0];
const invocation = source.split('\n').find(line => line.includes('verifier_run_step verifier-snapshot-root select_verifier_snapshot_root'));
const nativeWrapper = source.match(/^verifier_run_step\(\) \{[\s\S]*?^\}/m)?.[0];
const wrapperSource = readFileSync(join(repo, 'libs/generic/verification-harness/bin/vh.sh'), 'utf8');
const wrapper = wrapperSource.match(/^vh_run_step\(\) \{[\s\S]*?^\}/m)?.[0];
if (!selector || !invocation || !wrapper || !nativeWrapper) throw new Error('Native snapshot selector/wrapper not found');

function select(options: { donor?: string; temp?: string; data?: string; scratch?: string; mode?: string; frozen?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-snapshot-root-'));
  const donor = join(dir, 'donor');
  const temp = options.frozen ? join(donor, 'tmp') : join(dir, 'temp');
  const data = join(dir, 'data');
  mkdirSync(temp, { recursive: true });
  mkdirSync(join(data, 'tmp'), { recursive: true });
  mkdirSync(join(donor, '.papercusp/scratch'), { recursive: true });
  if (options.frozen) writeFileSync(join(donor, '.verifier-source.json'), '{}');
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_DIR: donor, TMPDIR: temp,
    FIXTURE_DIR: dir, FIXTURE_DATA: data, DONOR_DEVICE: options.donor || '11',
    TEMP_DEVICE: options.temp || '22', DATA_DEVICE: options.data || '22',
    SCRATCH_DEVICE: options.scratch || '22' };
  delete env.VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE;
  if (options.mode !== undefined) env.VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE = options.mode;
  try {
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'uname() { printf Linux; }',
      'stat() {',
      '  local path="${@: -1}"',
      '  case "$path" in',
      '    /) printf 11 ;;',
      '    "$FIXTURE_DATA") printf "%s" "$DATA_DEVICE" ;;',
      '    "$FIXTURE_DATA/tmp") printf "%s" "$SCRATCH_DEVICE" ;;',
      '    "$TMPDIR") printf "%s" "$TEMP_DEVICE" ;;',
      '    "$REPO_DIR"|"$REPO_DIR/"*|"$FIXTURE_DIR") printf "%s" "$DONOR_DEVICE" ;;',
      '    *) echo "Unexpected stat target: $path" >&2; return 1 ;;',
      '  esac',
      '}',
      'realpath() {',
      '  local path="${@: -1}"',
      '  case "$path" in /mnt/data) printf "%s" "$FIXTURE_DATA" ;; *) printf "%s" "$path" ;; esac',
      '}',
      // Avoid writes outside this test fixture; production admission still
      // executes its mkdir/stat/realpath sequence against measured devices.
      'mkdir() { :; }',
      'VH_DISABLED=1',
      'vh_step() { :; }',
      // Deadline behavior is covered by verify-tauri-copy-bootstrap. This
      // fixture measures only filesystem selection through the actual wrappers.
      'preflight_verifier_task_deadline() { :; }',
      wrapper!, nativeWrapper!, selector!, invocation!,
      'printf "SELECTED=%s\\nMODE=%s\\nFIXTURE_ALLOCATED\\n" "$OPERATOR_SNAPSHOT_PARENT" "${VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE:-hardlink}"',
    ].join('\n')], { env, encoding: 'utf8', timeout: 5000 });
    return { ...result, donor, temp, data, parent: dir };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('native verifier snapshot filesystem admission', () => {
  it('selects admitted data scratch and persists independent copy mode for a root donor', () => {
    const r = select();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELECTED=' + join(r.data, 'tmp'));
    expect(r.stdout).toContain('MODE=copy');
    expect(r.stdout).toContain('FIXTURE_ALLOCATED');
  });

  it('retains same-device hardlinks for a data donor', () => {
    const r = select({ donor: '22', temp: '33' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELECTED=' + join(r.donor, '.papercusp/scratch'));
    expect(r.stdout).toContain('MODE=hardlink');
  });

  it('supports explicit copy mode for root donors', () => {
    const r = select({ mode: 'copy' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELECTED=' + join(r.data, 'tmp'));
    expect(r.stdout).toContain('MODE=copy');
  });

  it('moves an explicit data-donor copy off a root-device TMPDIR', () => {
    const r = select({ donor: '22', temp: '11', mode: 'copy' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELECTED=' + join(r.data, 'tmp'));
  });

  it('refuses an explicit impossible hardlink request before fixture allocation', () => {
    const r = select({ mode: 'hardlink' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('root-filesystem donors require');
    expect(r.stdout).not.toContain('FIXTURE_ALLOCATED');
  });

  it.each([
    [{ data: '11' }, 'requires a separate /mnt/data filesystem'],
    [{ scratch: '11' }, 'scratch resolves outside the data filesystem'],
  ] as const)('refuses invalid data admission before fixture allocation: %j', (options, message) => {
    const r = select(options);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stdout).not.toContain('FIXTURE_ALLOCATED');
  });

  it('keeps nested snapshot output outside the attested source population', () => {
    const r = select({ donor: '22', temp: '22', frozen: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELECTED=' + r.parent);
    expect(r.stdout).toContain('MODE=hardlink');
  });

  it('admits the snapshot before native capacity checks can allocate fixtures', () => {
    expect(source.indexOf(invocation!)).toBeLessThan(source.indexOf('verifier_run_step native-cargo-capacity'));
  });
});
