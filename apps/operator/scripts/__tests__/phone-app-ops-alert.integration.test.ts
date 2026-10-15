import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deliverPhoneOpsNotice, runPhoneOpsAlert } from '../../../../infra/phone-app/phone-ops-alert.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phone-ops-alert-')); dirs.push(dir);
  const statePath = join(dir, 'ops-alert-state.json');
  const env = { PHONE_CONFIG_DIR: dir, PHONE_BACKUP_ARCHIVE: join(dir, 'phone.dump'),
    PHONE_BACKUP_MAX_AGE_HOURS: '24', PHONE_LIVEKIT_API_SECRET: 'secret-never-delivered' };
  const notices: Array<Record<string, string>> = [];
  let readiness = { ok: true, alerts: [] as Array<Record<string, string>> };
  const run = async (_command: string, args: string[]) => {
    if (args.includes('--status')) return { code: readiness.ok ? 0 : 1, stdout: JSON.stringify(readiness) };
    return { code: 0, stdout: JSON.stringify({ ok: true, alerts: [] }) };
  };
  const notify = async (notice: Record<string, string>) => { notices.push(notice); };
  return { dir, statePath, env, notices, run, notify,
    fail: () => { readiness = { ok: false, alerts: [{ component: 'sip', owner: 'phone-operations' }] }; },
    recover: () => { readiness = { ok: true, alerts: [] }; } };
}

describe('Phone source operations alert delivery', () => {
  it('uses the existing audited owner notification CLI with a stable scoped key, without sending', async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const notice = { dedupeKey: 'phone-ops:readiness:sip:2026-10-02', harness: 'papercusp',
      title: 'Phone operations: readiness sip', body: 'Inspect the Phone media and SIP checks.',
      importance: 'high', sourceRef: 'phone-ops-alert' };
    await deliverPhoneOpsNotice(notice, async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"ok":true}' };
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual([
      join(repoRoot, 'scripts/mcp-call.mjs'), 'notifications:send_owner',
      JSON.stringify(notice), '--client', 'phone-ops-alert', '--workspace',
      'papercusp-workspace', '--harness', 'papercusp',
    ]);
    expect(calls[0].options).toMatchObject({ timeout: 15_000, maxBuffer: 16_384 });
    await expect(deliverPhoneOpsNotice(notice, async () => { throw new Error('owner rail refused'); }))
      .rejects.toThrow('owner rail refused');
  });

  it('keeps the installed timer and service valid with a precise 15-minute interval', () => {
    const f = fixture();
    const unitDir = join(f.dir, 'units');
    const serviceName = 'papercusp-phone-ops-alert.service';
    const timerName = 'papercusp-phone-ops-alert.timer';
    const service = readFileSync(join(repoRoot, 'infra/phone-app/systemd', `${serviceName}.tmpl`), 'utf8')
      .replaceAll('${PHONE_CONFIG_DIR}', f.dir)
      .replaceAll('${PHONE_NODE_BIN}', process.execPath)
      .replaceAll('${PHONE_ALERT_SCRIPT}', join(repoRoot, 'infra/phone-app/phone-ops-alert.mjs'));
    const timer = readFileSync(join(repoRoot, 'infra/phone-app/systemd', timerName), 'utf8');
    expect(timer).toContain('OnUnitActiveSec=15min');
    expect(timer).toContain('AccuracySec=1s');
    expect(timer).not.toContain('RandomizedDelaySec');
    // Verify the rendered systemd pair in an isolated directory; no unit is installed or started.
    mkdirSync(unitDir);
    writeFileSync(join(unitDir, serviceName), service);
    writeFileSync(join(unitDir, timerName), timer);
    const verdict = spawnSync('systemd-analyze', ['verify', join(unitDir, serviceName), join(unitDir, timerName)],
      { encoding: 'utf8' });
    expect(verdict.status, verdict.stderr).toBe(0);
  });

  // Runs the real deploy.sh against fake systemctl/git/livekit binaries and an isolated HOME.
  function deployFixture(extraEnv: Record<string, string> = {}, before?: (home: string) => void) {
    const f = fixture();
    const home = join(f.dir, 'home');
    const phone = join(f.dir, 'source');
    const worker = join(phone, 'worker');
    const sidecar = join(phone, 'apps', 'sidecar');
    const bins = join(f.dir, 'bin');
    mkdirSync(home); mkdirSync(worker, { recursive: true });
    mkdirSync(sidecar, { recursive: true }); mkdirSync(bins);
    before?.(home);
    writeFileSync(join(worker, 'entry.js'), 'fixture');
    writeFileSync(join(sidecar, 'entry.js'), 'fixture');
    writeFileSync(join(f.dir, 'livekit.env'),
      'PHONE_LIVEKIT_API_KEY=fixture-key\nPHONE_LIVEKIT_API_SECRET=fixture-secret\n', { mode: 0o600 });
    const calls = join(f.dir, 'systemctl-calls');
    writeFileSync(join(bins, 'git'), `#!/bin/sh
case "$3:$4" in
  rev-parse:--show-toplevel) printf '%s\\n' "$PHONE_TEST_ROOT" ;;
  rev-parse:HEAD) printf '%s\\n' "$PHONE_TEST_REVISION" ;;
  status:--porcelain) exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    writeFileSync(join(bins, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$PHONE_TEST_SYSTEMCTL_CALLS"
# Like the real sidecar's embedded Postgres, a sidecar restart rewrites the
# discovery file the backup reads (WI-10006587: deploy.sh waits for it).
if [ "$2:$3" = "restart:papercusp-phone-sidecar.service" ] && [ -z "$PHONE_TEST_NO_DISCOVERY" ]; then
  mkdir -p "$HOME/.papercusp-phone" && printf '{}\\n' > "$HOME/.papercusp-phone/postgres.json"
fi
case "$2" in
  is-active) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 });
    for (const name of ['redis-cli', 'ss', 'curl']) {
      writeFileSync(join(bins, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    const livekit = join(bins, 'livekit-server');
    const sip = join(bins, 'livekit-sip');
    // deploy.sh refuses a livekit-server older than its TURN floor (WI-10006603),
    // so the stub must report a version at or above LK_MIN_VERSION.
    writeFileSync(livekit, '#!/bin/sh\n[ "$1" = --version ] && echo "livekit-server version 1.13.6"\nexit 0\n', { mode: 0o700 });
    writeFileSync(sip, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PHONE_')));
    const env = { ...baseEnv, HOME: home, PHONE_CONFIG_DIR: f.dir,
      PHONE_WORKER_DIR: worker, PHONE_SIDECAR_DIR: sidecar,
      PHONE_LIVEKIT_BIN: livekit, PHONE_SIP_BIN: sip, PHONE_NODE_BIN: process.execPath,
      PHONE_LAN_IFACE: 'test0', PHONE_TEST_ROOT: phone,
      PHONE_TEST_REVISION: 'a'.repeat(40), PHONE_TEST_SYSTEMCTL_CALLS: calls,
      // Readiness is not fixture-forced green (below), so never spend the
      // 30×1s retry budget waiting for this host's real services.
      PHONE_READINESS_RETRY_SEC: '0',
      // Bounds the discovery-file wait so a regression fails fast instead of
      // hanging past the spawn timeout; the fake sidecar restart satisfies it.
      PHONE_DISCOVERY_WAIT_SEC: '5',
      PATH: `${bins}:${process.env.PATH ?? ''}` };
    const pin = spawnSync('bash', [join(repoRoot, 'infra/phone-app/deploy.sh'), '--pin-artifacts'],
      { env, encoding: 'utf8', timeout: 15_000 });
    expect(pin.status, pin.stderr).toBe(0);
    expect(() => readFileSync(calls, 'utf8')).toThrow();
    const deploy = spawnSync('bash', [join(repoRoot, 'infra/phone-app/deploy.sh')],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 25_000 });
    return { home, calls, deploy };
  }

  it('installs and enables the alert timer only after a pinned isolated deployment attempt', () => {
    const { home, calls, deploy } = deployFixture();
    // Local readiness is deliberately not fixture-forced green; unit installation precedes that check.
    expect(deploy.stdout).toContain('armed Phone operations alerts');
    const units = join(home, '.config/systemd/user');
    expect(readFileSync(join(units, 'papercusp-phone-ops-alert.timer'), 'utf8'))
      .toContain('OnUnitActiveSec=15min');
    expect(readFileSync(join(units, 'papercusp-phone-ops-alert.service'), 'utf8'))
      .toContain(join(repoRoot, 'infra/phone-app/phone-ops-alert.mjs'));
    expect(readFileSync(calls, 'utf8')).toContain('--user enable --now papercusp-phone-ops-alert.timer');
    // WI-10006587: the first backup runs only after the sidecar restart has
    // rewritten the discovery file, and the alert is armed after that backup.
    expect(deploy.stdout).not.toContain('no fresh Phone database discovery file');
    const order = readFileSync(calls, 'utf8').split('\n');
    const sidecarRestart = order.indexOf('--user restart papercusp-phone-sidecar.service');
    const backup = order.indexOf('--user start papercusp-phone-backup.service');
    const alert = order.indexOf('--user enable --now papercusp-phone-ops-alert.timer');
    expect(sidecarRestart).toBeGreaterThanOrEqual(0);
    expect(backup).toBeGreaterThan(sidecarRestart);
    expect(alert).toBeGreaterThan(backup);
  });

  it('backs up anyway, with a warning, when the sidecar never rewrites its discovery file', () => {
    let discovery = '';
    const { calls, deploy } = deployFixture(
      { PHONE_TEST_NO_DISCOVERY: '1', PHONE_DISCOVERY_WAIT_SEC: '1' },
      (home) => {
        // A discovery file from BEFORE this restart must not satisfy the wait.
        mkdirSync(join(home, '.papercusp-phone'), { recursive: true });
        discovery = join(home, '.papercusp-phone', 'postgres.json');
        writeFileSync(discovery, '{}\n');
        const old = new Date(Date.now() - 3600_000);
        utimesSync(discovery, old, old);
      });
    expect(deploy.stdout).toContain(
      `no fresh Phone database discovery file at ${discovery} after 1s; backing up anyway`);
    // A missing discovery file degrades to a reported backup failure; it never blocks arming alerts.
    expect(deploy.stdout).toContain('armed Phone operations alerts');
    expect(readFileSync(calls, 'utf8')).toContain('--user start papercusp-phone-backup.service');
  });

  it('delivers one actionable owner alert, dedupes repeats, reminds next day and stands down once', async () => {
    const f = fixture(); f.fail();
    const opts = { env: f.env, run: f.run, notify: f.notify, statePath: f.statePath };
    const first = await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-02T10:00:00Z') });
    expect(first).toMatchObject({ ok: false, conditions: ['readiness:sip'], publicPhoneVerified: false });
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0].title).toContain('sip');
    expect(JSON.stringify(f.notices)).not.toContain(f.env.PHONE_LIVEKIT_API_SECRET);
    expect(statSync(f.statePath).mode & 0o777).toBe(0o600);
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-02T10:15:00Z') });
    expect(f.notices).toHaveLength(1);
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:00:00Z') });
    expect(f.notices).toHaveLength(2);
    f.recover();
    const recovered = await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:15:00Z') });
    expect(recovered.ok).toBe(true);
    expect(f.notices).toHaveLength(3);
    expect(f.notices[2].title).toContain('recovered');
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:30:00Z') });
    expect(f.notices).toHaveLength(3);
  });

  it('fails closed on missing backup configuration and malformed readiness without echoing output', async () => {
    const f = fixture();
    const env = { ...f.env, PHONE_BACKUP_MAX_AGE_HOURS: '' };
    const result = await runPhoneOpsAlert({ env, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z'),
      run: async () => ({ code: 0, stdout: 'secret-never-delivered' }), notify: f.notify });
    expect(result.conditions).toEqual(['backup:config-missing', 'readiness:check-unavailable', 'usage:check-unavailable']);
    expect(JSON.stringify(f.notices)).not.toContain('secret-never-delivered');
  });

  it('maps actual usage and backup CLI conditions without collapsing known faults to unknown', async () => {
    const f = fixture();
    const result = await runPhoneOpsAlert({ env: f.env, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z'), notify: f.notify,
      run: async (_cmd, args) => args.includes('usage-status')
        ? { code: 1, stdout: JSON.stringify({ ok: false, alerts: [{ condition: 'missingPolicy' }] }) }
        : args.includes('backup-status')
          ? { code: 1, stdout: JSON.stringify({ ok: false, alerts: [{ condition: 'backup-stale' }] }) }
          : { code: 0, stdout: JSON.stringify({ ok: true, alerts: [] }) },
    });
    expect(result.conditions).toEqual(['backup:backup-stale', 'usage:missingPolicy']);
    expect(result.notificationsSent).toBe(2);
    expect(f.notices.map(x => x.title)).toEqual([
      'Phone operations: usage missingPolicy', 'Phone operations: backup backup-stale',
    ]);
  });

  it('retries a failed notification instead of silently recording it as delivered', async () => {
    const f = fixture(); f.fail();
    const opts = { env: f.env, run: f.run, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z') };
    await expect(runPhoneOpsAlert({ ...opts, notify: async () => { throw new Error('delivery failed'); } }))
      .rejects.toThrow('delivery failed');
    expect(() => readFileSync(f.statePath, 'utf8')).toThrow();
    await runPhoneOpsAlert({ ...opts, notify: f.notify });
    expect(f.notices).toHaveLength(1);
  });
});
