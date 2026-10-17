import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Plan agent-capacity-and-cost-gcp-2026-09-30, S7 / WI-10004395. The capacity baseline must
// start the server with PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 from its FIRST boot (WI-10004421).
// The package's postinst enables the user unit for every user, so the first start happens at
// `loginctl enable-linger`, not at `systemctl --user enable --now`: the drop-in has to exist
// before linger. The earlier version of this test checked the drop-in at `enable --now`, which
// passed while the real VM (cap-s7-b, 2026-09-30) started one second before the drop-in landed.
// The script therefore also verifies the RUNNING process's environment.
const SCRIPT = path.join(__dirname, 'install-server.sh');
const SHA = 'a'.repeat(64);
const DROPIN = '.config/systemd/user/papercusp-server.service.d/capacity-env.conf';
const VAR = 'PAPERCUSP_DISABLE_DOGFOOD_HIVE=1';

describe('vm/install-server.sh extra KEY=VAL environment (faked sudo/systemctl/apt)', () => {
  let dir: string;
  const bin = () => path.join(dir, 'bin');
  const home = () => path.join(dir, 'home');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };
  /** The fake server process's /proc/<pid>/environ (NUL-separated, like the kernel's). */
  const setEnviron = (file: 'environ' | 'environ.after', vars: string[]) =>
    writeFileSync(path.join(dir, file), vars.map((v) => `${v}\0`).join(''));
  const log = () => readFileSync(path.join(dir, 'systemctl.log'), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'install-server-'));
    mkdirSync(bin());
    mkdirSync(home());
    // sudo: drop `-u <user>` and env assignments; answer the marker read so the fetch+apt
    // step is skipped; serve the fake process environ; strip -o/-g from `install`.
    stub(
      'sudo',
      [
        'while [ "$1" = "-u" ]; do shift 2; done',
        'while [[ "$1" == *=* ]]; do shift; done',
        'case "$1" in',
        '  test) exit 0 ;;',
        '  cat) case "$2" in',
        `         /var/lib/papercusp-capacity-installed.sha256) echo ${SHA}; exit 0 ;;`,
        `         /proc/999/environ) [ -f "${dir}/environ" ] && exec cat "${dir}/environ"; exit 1 ;;`,
        '       esac ;;',
        '  install) shift; a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec install "${a[@]}" ;;',
        'esac',
        'exec "$@"',
      ].join('\n'),
    );
    stub(
      'systemctl',
      [
        `echo "$@" >> "${dir}/systemctl.log"`,
        '[[ "$*" == *" mask --now "* ]] && [ "${FAKE_MASK_FAIL:-0}" = 1 ] && exit 1',
        '[[ "$*" == *" is-enabled "* ]] && echo "${FAKE_LOGIN_STATE:-masked}"',
        '[[ "$*" == *"ControlGroup"* ]] && echo /cg',
        '[[ "$*" == *"MainPID"* ]] && echo 999',
        `[[ "$*" == *" restart "* ]] && [ -f "${dir}/environ.after" ] && mv "${dir}/environ.after" "${dir}/environ"`,
        'exit 0',
      ].join('\n'),
    );
    // The first start: record whether the drop-in already existed when linger started the unit.
    stub(
      'loginctl',
      [
        `echo "loginctl $*" >> "${dir}/systemctl.log"`,
        `[ -f "${home()}/${DROPIN}" ] && echo DROPIN_PRESENT_AT_LINGER >> "${dir}/systemctl.log"`,
        'exit 0',
      ].join('\n'),
    );
    stub('dpkg-query', 'exit 0');
    stub('pgrep', 'exit 1');
    stub('id', '[ "$1" = "-u" ] && echo 4321; [ "$1" = "-un" ] && echo sshlogin; exit 0');
    stub('journalctl', 'echo "operator_hint=1"');
    stub('find', 'exit 0');
    stub('ss', 'exit 0');
    stub('curl', `echo '{"ok":true,"service":"papercusp-operator"}'`);
    stub('sleep', 'exit 0');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({ ...process.env, PATH: `${bin()}:${process.env.PATH}`, SVC_HOME: home(), SUDO_USER: 'sshlogin' });

  it.each(['<html>SPA</html>', '{"ok":false,"service":"papercusp-operator"}', '{"ok":true}', '{"ok":true,"service":"other"}', '[]', '{"ok":"true","service":"papercusp-operator"}'])('does not announce readiness for an HTTP 200 with invalid body: %s', (invalid) => {
    writeFileSync(path.join(dir, 'invalid-health'), invalid);
    stub('curl', `echo "$@" >> "${dir}/curl.args"\nn=$(cat "${dir}/curl.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/curl.n"\nif [ $n -eq 1 ]; then cat "${dir}/invalid-health"; else echo '{"ok":true,"service":"papercusp-operator"}'; fi`);
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(path.join(dir, 'curl.n'), 'utf8').trim()).toBe('2');
    expect(readFileSync(path.join(dir, 'curl.args'), 'utf8').trim().split('\n').every((line) => line.includes('/api/health'))).toBe(true);
    expect(r.stdout).toContain('SERVER_HEALTH={"ok":true,"service":"papercusp-operator"}');
  });

  it('masks the SSH account before starting a tenant, so the global package enable cannot add a server', () => {
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('LOGIN_SERVER_EXCLUDED=sshlogin');
    expect(log().indexOf('--user mask --now papercusp-server.service')).toBeLessThan(log().indexOf('loginctl enable-linger pcsrv'));
  });

  it.each([
    { FAKE_MASK_FAIL: '1' },
    { FAKE_LOGIN_STATE: 'enabled' },
  ])('refuses a capacity run when login-server exclusion fails: %j', (vars) => {
    const r = spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA], {
      encoding: 'utf8', env: { ...env(), ...vars },
    });
    expect(r.status).toBe(8);
    expect(r.stdout).not.toContain('SERVER_PORT=');
    expect(log()).not.toContain('loginctl enable-linger');
  });

  it('preserves the login account when it is the requested tenant', () => {
    const r = spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA], {
      encoding: 'utf8', env: { ...env(), SVC_USER: 'sshlogin' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log()).not.toContain(' mask --now ');
  });
  const run = (...extra: string[]) =>
    spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, ...extra], { encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });

  it('writes the drop-in before linger starts the unit, and verifies the running process carries it', () => {
    setEnviron('environ', ['HOME=/var/empty', VAR, 'FOO_BAR=x']);
    const out = execFileSync('bash', [SCRIPT, 'gs://b/server.deb', SHA, VAR, 'FOO_BAR=x'], {
      encoding: 'utf8',
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain(`SERVER_ENV=${VAR}`);
    expect(out).toContain('SERVER_ENV=FOO_BAR=x');
    expect(out).toContain(`SERVER_ENV_VERIFIED=${VAR}`);
    expect(out).toContain('SERVER_ENV_VERIFIED=FOO_BAR=x');
    expect(out).not.toContain('SERVER_RESTARTED_FOR_ENV');
    expect(out).toMatch(/^SERVER_PORT=1$/m);
    expect(readFileSync(path.join(home(), DROPIN), 'utf8')).toBe(`[Service]\nEnvironment=${VAR}\nEnvironment=FOO_BAR=x\n`);
    expect(log()).toContain('DROPIN_PRESENT_AT_LINGER');
    expect(log()).not.toMatch(/ restart /);
  });

  it('restarts once when the running process started without a variable, and says so', () => {
    setEnviron('environ', ['HOME=/var/empty']);
    setEnviron('environ.after', ['HOME=/var/empty', VAR]);
    const r = run(VAR);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`SERVER_RESTARTED_FOR_ENV (first start lacked: ${VAR})`);
    expect(r.stdout).toContain(`SERVER_ENV_VERIFIED=${VAR}`);
    expect(log()).toMatch(/ restart papercusp-server\.service/);
  });

  it('refuses (exit 7) when the variable never reaches the running process', () => {
    setEnviron('environ', ['HOME=/var/empty']);
    const r = run(VAR);
    expect(r.status).toBe(7);
    expect(r.stdout).toContain(`SERVER_ENV_NOT_APPLIED=${VAR}`);
    expect(r.stdout).not.toContain('SERVER_ENV_VERIFIED');
    expect(r.stdout).not.toContain('SERVER_PORT=');
  });

  it('refuses (exit 7) when the process environ cannot be read at all', () => {
    const r = run(VAR); // no environ fixture: the read fails
    expect(r.status).toBe(7);
    expect(r.stdout).toContain(`SERVER_ENV_NOT_APPLIED=${VAR}`);
  });

  it('writes no drop-in and skips verification when no variable is given', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(path.join(home(), DROPIN))).toBe(false);
    expect(r.stdout).not.toContain('SERVER_ENV');
  });

  it('refuses a malformed variable before touching anything', () => {
    const r = run('lower=1');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('BAD_ENV_ARG lower=1');
    expect(existsSync(path.join(dir, 'systemctl.log'))).toBe(false);
  });

  // P-011 multi-tenant density (WI-10004383): one Linux user per tenant Server.
  const runAs = (user: string | undefined) =>
    spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA], {
      encoding: 'utf8',
      env: { ...env(), ...(user === undefined ? {} : { SVC_USER: user }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('runs the Server as pcsrv by default', () => {
    const r = runAs(undefined);
    expect(r.status).toBe(0);
    expect(log()).toMatch(/^loginctl enable-linger pcsrv$/m);
  });

  it('runs the Server as the SVC_USER tenant when given', () => {
    const r = runAs('pctenant3');
    expect(r.status).toBe(0);
    expect(log()).toMatch(/^loginctl enable-linger pctenant3$/m);
    expect(log()).not.toMatch(/enable-linger pcsrv$/m);
  });

  it('refuses a malformed SVC_USER before touching anything', () => {
    const r = runAs('Bad User');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('BAD_SVC_USER Bad User');
    expect(existsSync(path.join(dir, 'systemctl.log'))).toBe(false);
  });

  // WI-10006853: c1011r's apt-get trickled at ~0 B/s on one mirror connection for 20+ min while
  // a fresh request answered in 45 ms. Each download attempt is wall-bounded and retried.
  describe('bounded apt download (fetch + apt path, marker absent)', () => {
    const aptLog = () => path.join(dir, 'apt-calls.log');
    beforeEach(() => {
      // No marker, so the fetch + apt branch runs. Host paths are never touched: rm and the
      // marker tee are swallowed, gcloud and sha256sum are faked.
      stub(
        'sudo',
        [
          'while [ "$1" = "-u" ]; do shift 2; done',
          'while [[ "$1" == *=* ]]; do shift; done',
          'case "$1" in',
          '  test) exit 0 ;;',
          '  cat) case "$2" in',
          '         /var/lib/papercusp-capacity-installed.sha256) exit 1 ;;',
          `         /proc/999/environ) [ -f "${dir}/environ" ] && exec cat "${dir}/environ"; exit 1 ;;`,
          '       esac ;;',
          '  rm) exit 0 ;;',
          '  tee) cat > /dev/null; exit 0 ;;',
          '  install) shift; a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec install "${a[@]}" ;;',
          'esac',
          'exec "$@"',
        ].join('\n'),
      );
      stub('gcloud', 'exit 0');
      stub('sha256sum', `echo "${SHA}  $1"`);
      // The first FAKE_APT_HANGS download attempts hang (exec, so timeout's TERM reaches it).
      stub(
        'apt-get',
        [
          `echo "$*" >> "${aptLog()}"`,
          'case " $* " in *" --download-only "*)',
          `  n=$(( $(cat "${dir}/apt.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/apt.n"`,
          '  [ "$n" -le "$((FAKE_APT_HANGS + 0))" ] && exec /bin/sleep 30 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
    });
    const runApt = (vars: Record<string, string>) =>
      spawnSync('bash', [SCRIPT, 'gs://b/server.deb', SHA], {
        encoding: 'utf8',
        env: { ...env(), APT_ATTEMPT_SEC: '1', APT_LOG: path.join(dir, 'apt-install.log'), ...vars },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    const calls = () => readFileSync(aptLog(), 'utf8').trim().split('\n');

    it('retries a hung download on a fresh attempt, then installs from the cache', () => {
      const r = runApt({ FAKE_APT_HANGS: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^APT_DOWNLOAD_RETRY attempt=1 rc=124 /m);
      expect(r.stdout).not.toMatch(/APT_DOWNLOAD_RETRY attempt=2/);
      expect(r.stdout).toMatch(/^T_APT=\d+$/m);
      expect(r.stdout.indexOf('LOGIN_SERVER_EXCLUDED=sshlogin')).toBeLessThan(r.stdout.indexOf('== fetch'));
      const installs = calls().filter((c) => c.startsWith('install '));
      expect(installs.filter((c) => c.includes('--download-only'))).toHaveLength(2);
      // the real install comes last and is not a download-only call
      expect(installs.at(-1)).not.toContain('--download-only');
      expect(installs.at(-1)).toContain('/var/tmp/papercusp-server.deb');
    });

    it('fails loudly (exit 4, APT_DOWNLOAD_FAILED) when every attempt hangs, and never installs', () => {
      const r = runApt({ FAKE_APT_HANGS: '99', APT_ATTEMPTS: '2' });
      expect(r.status).toBe(4);
      expect(r.stdout).toMatch(/^APT_DOWNLOAD_RETRY attempt=2 rc=124 /m);
      expect(r.stdout).toContain('APT_DOWNLOAD_FAILED attempts=2 attempt_sec=1');
      expect(calls().filter((c) => c.startsWith('install ') && !c.includes('--download-only'))).toHaveLength(0);
      expect(r.stdout).not.toMatch(/T_APT=/);
    });
  });
});
