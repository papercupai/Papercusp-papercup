import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(__dirname, 'time-restart.sh');
const PYTHON = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();

describe('vm/time-restart.sh (faked sudo/systemctl/curl/python3)', () => {
  let dir: string;
  const bin = () => path.join(dir, 'bin');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'time-restart-'));
    mkdirSync(bin());
    mkdirSync(path.join(dir, 'cg'));
    writeFileSync(path.join(dir, 'sampler.py'), '');
    // sudo drops `-u <user>` and env assignments, then runs the rest.
    stub('sudo', `shift 2; while [[ "$1" == *=* ]]; do shift; done; exec "$@"`);
    stub('systemctl', `echo "$@" >> "${dir}/systemctl.log"`);
    stub('python3', `if [ "$1" = -c ]; then exec "${PYTHON}" "$@"; fi\necho "$@" > "${dir}/sampler.args"`);
    stub('sleep', 'exit 0');
    // /api/health fails twice, then answers.
    stub('curl', `n=$(cat "${dir}/curl.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/curl.n"; [ $n -ge 3 ] && { echo '{"ok":true,"service":"papercusp-operator"}'; exit 0; }; exit 7`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runScript = () =>
    execFileSync('bash', [SCRIPT, '--user', userInfo().username, '--port', '1', '--sample-sec', '5', '--out', path.join(dir, 'out.jsonl')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin()}:${process.env.PATH}`, SERVER_CGROUP: path.join(dir, 'cg'), SAMPLER: path.join(dir, 'sampler.py') },
    });

  it('samples the server cgroup, restarts through the user manager, and waits for health', () => {
    const out = runScript();
    expect(out).toMatch(/^RESTART_TIMING t0=\S+Z restart_s=\d+\.\d healthy_s=\d+\.\d$/m);
    expect(readFileSync(path.join(dir, 'systemctl.log'), 'utf8').trim()).toBe('--user restart papercusp-server.service');
    expect(readFileSync(path.join(dir, 'sampler.args'), 'utf8')).toContain(`--cgroup ${path.join(dir, 'cg')} --interval 2 --duration 5`);
    expect(readFileSync(path.join(dir, 'curl.n'), 'utf8').trim()).toBe('3'); // 2 failures + validated success
  });

  it.each(['<html>SPA</html>', '{"ok":false,"service":"papercusp-operator"}', '{"ok":true}', '{"ok":true,"service":"other"}', '[]', '{"ok":"true","service":"papercusp-operator"}'])('waits past an HTTP 200 with invalid readiness body: %s', (invalid) => {
    writeFileSync(path.join(dir, 'invalid-health'), invalid);
    stub('curl', `echo "$@" >> "${dir}/curl.args"\nn=$(cat "${dir}/curl.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/curl.n"\nif [ $n -eq 1 ]; then cat "${dir}/invalid-health"; else echo '{"ok":true,"service":"papercusp-operator"}'; fi`);
    const out = runScript();
    expect(readFileSync(path.join(dir, 'curl.n'), 'utf8').trim()).toBe('2');
    expect(readFileSync(path.join(dir, 'curl.args'), 'utf8').trim().split('\n').every((line) => line.includes('/api/health'))).toBe(true);
    expect(out).toContain('"service":"papercusp-operator"');
    expect(out).not.toContain(invalid);
  });

  it('refuses when the server cgroup does not exist', () => {
    rmSync(path.join(dir, 'cg'), { recursive: true });
    expect(runScript).toThrow(/no server cgroup/);
  });
});
