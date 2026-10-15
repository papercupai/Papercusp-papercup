import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceHostBootstrap,
  parseEc2ConsoleBootstrapStatus,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS,
  WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_BEGIN,
  WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_END,
  WORKSPACE_HOST_EC2_GCP_GUEST_UNITS,
  type WorkspaceHostBootstrapInput,
  type WorkspaceHostBootstrapStatusChannel,
} from './workspace-host-bootstrap';
import { deriveWorkspaceHostCanonicalArtifactUrls } from './workspace-host-build-manifest';

/**
 * The `ec2-console-output` bootstrap status channel (plan aws-byoc-gcp-parity-2026-10-01 D-013,
 * WI-10005172): the bootstrap writes one marker line to /dev/console, EC2 captures it as console
 * output, and the controller parses the LAST marker. The round-trip tests run the RENDERED bash
 * against the TypeScript parser, so neither side is checked against a hand-written copy of the
 * other.
 */

const DIGEST = 'a'.repeat(64);
const ARTIFACTS = deriveWorkspaceHostCanonicalArtifactUrls(DIGEST);
const MARKER = WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER;

function bootstrap(statusChannel?: WorkspaceHostBootstrapStatusChannel): string {
  const input: WorkspaceHostBootstrapInput = {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId: 'host-1',
    release: {
      version: '2026.8.22-1',
      bundleUrl: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signatureUrl: ARTIFACTS.signatureUrl,
      signingPublicKey: 'untrusted comment: Papercusp release key\nRWQpublickey',
      signingKeySha256: 'b'.repeat(64),
    },
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
    workspaceAuthorizedKeys: [
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller',
    ],
    publicMetadata: { channel: 'canary' },
    ...(statusChannel ? { statusChannel } : {}),
  };
  return buildWorkspaceHostBootstrap(input);
}

/** The rendered report functions, exactly as the bootstrap defines them. */
function reportFunctions(script: string): string[] {
  const lines = script
    .split('\n')
    .filter((line) => line.startsWith('report_status() {') || line.startsWith('report_outcome() {'));
  expect(lines).toHaveLength(2);
  return lines;
}

/** A rendered multi-line shell function, from its `name() {` line through its closing `}`. */
function renderedFunction(script: string, name: string): string[] {
  const lines = script.split('\n');
  const start = lines.indexOf(`${name}() {`);
  expect(start, `${name} is rendered as a multi-line function`).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf('}', start);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1);
}

/** Replace `from` in every line, asserting it was really there: a no-op substitution proves nothing. */
function substitute(lines: readonly string[], from: string, to: string, expected: number): string[] {
  expect(lines.filter((line) => line.includes(from)), `'${from}' is rendered`).toHaveLength(expected);
  return lines.map((line) => line.split(from).join(to));
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const CONSOLE_WRITE = '> /dev/console';

/**
 * Run the rendered console report functions, plus the rendered `publish_host_keys` reading host
 * keys from a fixture directory, with /dev/console redirected to a file; return what a controller
 * reading the console would see.
 */
function runConsoleReports(body: string, hostKeyFiles: Record<string, string> = {}): string {
  const rendered = bootstrap('ec2-console-output');
  const dir = scratchDir('ec2-console-status-');
  const capture = join(dir, 'console');
  const sshDir = join(dir, 'ssh');
  mkdirSync(sshDir);
  for (const [name, content] of Object.entries(hostKeyFiles)) writeFileSync(join(sshDir, name), content);
  // A console device accumulates every write; a regular file opened with `>` would truncate, so
  // the stand-in appends.
  const functions = substitute(reportFunctions(rendered), CONSOLE_WRITE, `>> ${capture}`, 1);
  const publish = substitute(
    substitute(renderedFunction(rendered, 'publish_host_keys'), CONSOLE_WRITE, `>> ${capture}`, 1),
    '/etc/ssh/',
    `${sshDir}/`,
    1,
  );
  const script = [
    'set -Eeuo pipefail',
    'BOOTSTRAP_PHASE=""',
    'BOOTSTRAP_ERROR=""',
    ...publish,
    ...functions,
    body,
  ].join('\n');
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(capture, 'utf8');
}

/** The lines of the LAST complete host-key block on a console, or null when there is none. */
function lastHostKeyBlock(consoleText: string): string[] | null {
  const lines = consoleText.split('\n');
  const begin = lines.lastIndexOf(WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_BEGIN);
  if (begin < 0) return null;
  const end = lines.indexOf(WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_END, begin);
  return end < 0 ? null : lines.slice(begin + 1, end);
}

describe('ec2-console-output bootstrap status channel (D-013)', () => {
  it('is a declared channel', () => {
    expect(WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS).toContain('ec2-console-output');
  });

  it('renders a valid script that reports to the console and nowhere else', () => {
    const script = bootstrap('ec2-console-output');
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    const [status] = reportFunctions(script);
    expect(status).toContain('/dev/console');
    expect(status).toContain(MARKER);
    expect(status).not.toContain('169.254.169.254');
    expect(status).toContain('|| true');
  });

  it('leaves the GCE channel and the no-channel script without a console report', () => {
    for (const script of [bootstrap('gce-guest-attributes'), bootstrap()]) {
      const [status] = reportFunctions(script);
      expect(status).not.toContain('/dev/console');
      expect(status).not.toContain(MARKER);
    }
  });

  it('round-trips running, then a success, through the rendered bash and the parser', () => {
    const consoleText = runConsoleReports('report_status running');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'running' });
    const done = runConsoleReports('report_status running\nreport_outcome 0');
    expect(parseEc2ConsoleBootstrapStatus(done)).toEqual({ state: 'succeeded' });
  });

  it('round-trips a failure whose die message contains newlines and carriage returns', () => {
    const consoleText = runConsoleReports(
      [
        'report_status running',
        'BOOTSTRAP_PHASE=harden-os',
        "BOOTSTRAP_ERROR=$'apt-get failed\\r\\nsee the journal'",
        'report_outcome 100',
      ].join('\n'),
    );
    // One report per call: the multi-line message did not split the failure report.
    expect(consoleText.trimEnd().split('\n')).toHaveLength(2);
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({
      state: 'failed',
      exitCode: 100,
      phase: 'harden-os',
      error: 'apt-get failed  see the journal',
    });
  });

  // EI-25267772765088134: a `set -u` abort never reaches die, so the report used to carry an
  // empty error and the controller saw only 'error='. The abort runs in a subshell with the
  // production EXIT trap, so the outer harness still exits 0.
  it('reports the aborting command for a non-die abort, with single-quoted literals redacted', () => {
    const abort = (command: string) =>
      runConsoleReports(
        [
          'report_status running',
          '( trap \'status=$?; report_outcome "$status"; exit "$status"\' EXIT',
          '  BOOTSTRAP_PHASE=install-runtime',
          `  ${command}`,
          ') || true',
        ].join('\n'),
      );
    expect(parseEc2ConsoleBootstrapStatus(abort('OLLAMA_TMP="$WORK_DIR/ollama"'))).toEqual({
      state: 'failed',
      exitCode: 1,
      phase: 'install-runtime',
      error: 'aborted outside die: OLLAMA_TMP="$WORK_DIR/ollama"',
    });
    const leaked = abort("printf '%s' 'SECRET-TICKET-abc' > /nonexistent-dir-ei25267772765088134/t");
    expect(leaked).not.toContain('SECRET-TICKET-abc');
    expect(parseEc2ConsoleBootstrapStatus(leaked)).toMatchObject({
      state: 'failed',
      error: "aborted outside die: printf '<redacted>' > /nonexistent-dir-ei25267772765088134/t",
    });
    // A die message still wins over the aborting command.
    const died = abort('BOOTSTRAP_ERROR="named failure"; false');
    expect(parseEc2ConsoleBootstrapStatus(died)).toMatchObject({ state: 'failed', error: 'named failure' });
  });

  it('truncates the die message to the report ceiling', () => {
    const consoleText = runConsoleReports(
      [
        'BOOTSTRAP_PHASE=install-runtime',
        `BOOTSTRAP_ERROR=${'x'.repeat(WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS + 50)}`,
        'report_outcome 1',
      ].join('\n'),
    );
    const parsed = parseEc2ConsoleBootstrapStatus(consoleText);
    expect(parsed).toMatchObject({ state: 'failed', exitCode: 1, phase: 'install-runtime' });
    expect(parsed && parsed.state === 'failed' ? parsed.error : null).toHaveLength(
      WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS,
    );
  });
});

// WI-10007009, measured on the bootc AMI: the bootstrap SUCCEEDED but its marker was pushed out of
// the 64 KiB console window by a GCP rsyslog rule copying the service's own logs there, and with
// no cloud-init nothing ever printed the host-key block first SSH pins from.
describe('ec2-console-output console hygiene and host-key publication (WI-10007009)', () => {
  const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma';
  const ECDSA = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=';
  const HOST_KEYS = {
    'ssh_host_dsa_key.pub': 'ssh-dss AAAAB3NzaC1kc3MAAACB root@ip-10-0-0-5\n',
    'ssh_host_ecdsa_key.pub': `${ECDSA} root@ip-10-0-0-5\n`,
    'ssh_host_ed25519_key.pub': `${ED25519} root@ip-10-0-0-5\n`,
    // A second file of an algorithm already printed: the parser refuses a block that repeats one.
    'ssh_host_ed25519_old_key.pub': 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOld root@ip-10-0-0-5\n',
  };

  it('quiets the console, then publishes the keys, before the running report and after the EXIT trap', () => {
    const lines = bootstrap('ec2-console-output').split('\n');
    const trap = lines.findIndex((line) => line.startsWith("trap 'status=$?; report_outcome"));
    const quiet = lines.indexOf('console_quiet');
    const publish = lines.indexOf('publish_host_keys');
    const running = lines.indexOf('report_status running');
    expect(trap).toBeGreaterThanOrEqual(0);
    expect([trap < quiet, quiet < publish, publish < running]).toEqual([true, true, true]);
    // ...and before the first phase, so nothing the run logs can reach the console first.
    expect(running).toBeLessThan(lines.findIndex((line) => line.startsWith('phase ')));
    const [, outcome] = reportFunctions(lines.join('\n'));
    expect(outcome).toContain('publish_host_keys; report_status succeeded');
  });

  it('ends a successful run with the key block and then the succeeded marker', () => {
    const consoleText = runConsoleReports(
      'console_quiet() { :; }\nconsole_quiet\npublish_host_keys\nreport_status running\nreport_outcome 0',
      HOST_KEYS,
    );
    const lines = consoleText.trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`${MARKER} succeeded`);
    expect(lines.at(-2)).toBe(WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_END);
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'succeeded' });
    // Printed twice: once at start (the controller pins before it waits) and once at the end.
    expect(lines.filter((line) => line === WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_BEGIN)).toHaveLength(2);
    const block = lastHostKeyBlock(consoleText)!;
    // Supported algorithms only, one line each, comments dropped.
    expect(block.map((line) => line.split(' ')[0]).sort()).toEqual(['ecdsa-sha2-nistp256', 'ssh-ed25519']);
    expect(block).toContain(ECDSA);
    expect(block.every((line) => line.split(' ').length === 2)).toBe(true);
  });

  it('prints no block at all when the host has no supported key, since an empty block is a refusal', () => {
    const consoleText = runConsoleReports('publish_host_keys\nreport_status running', {
      'ssh_host_dsa_key.pub': HOST_KEYS['ssh_host_dsa_key.pub'],
    });
    expect(consoleText).toBe(`${MARKER} running\n`);
    expect(runConsoleReports('publish_host_keys\nreport_status running')).toBe(`${MARKER} running\n`);
  });

  it('leaves the GCE and no-channel scripts with no-op helpers that touch neither rsyslog, the GCP units nor the console', () => {
    for (const script of [bootstrap('gce-guest-attributes'), bootstrap()]) {
      const lines = script.split('\n');
      expect(lines).toContain('console_quiet() { :; }');
      expect(lines).toContain('publish_host_keys() { :; }');
      expect(script).not.toContain('rsyslog');
      expect(script).not.toContain(WORKSPACE_HOST_EC2_GCP_GUEST_UNITS[0]);
      expect(script).not.toContain(WORKSPACE_HOST_EC2_CONSOLE_HOST_KEYS_BEGIN);
    }
  });

  it('console_quiet comments out only console rules, restarts rsyslog only on change, masks the GCP units, and never fails', () => {
    const dir = scratchDir('ec2-console-quiet-');
    const etc = join(dir, 'etc');
    const bin = join(dir, 'bin');
    const log = join(dir, 'calls');
    mkdirSync(join(etc, 'rsyslog.d'), { recursive: true });
    mkdirSync(bin);
    const google = '# Send daemon and kernel messages to the console\ndaemon,kern.* /dev/console\n';
    const local = '*.info;mail.none /var/log/messages\n#*.* /dev/console\naction(type="omfile" file="/var/log/x")\n';
    writeFileSync(join(etc, 'rsyslog.conf'), '*.emerg :omusrmsg:*\nkern.*\t-/dev/console\n');
    writeFileSync(join(etc, 'rsyslog.d', '90-google.conf'), google);
    writeFileSync(join(etc, 'rsyslog.d', '50-local.conf'), local);
    // Both stand-ins record their argv; systemctl also FAILS, which console_quiet must absorb.
    for (const [name, status] of [['systemctl', 1], ['restorecon', 0]] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit ${status}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const quiet = substitute(
      renderedFunction(bootstrap('ec2-console-output'), 'console_quiet'),
      '/etc/rsyslog.conf /etc/rsyslog.d/*.conf',
      `${etc}/rsyslog.conf ${etc}/rsyslog.d/*.conf`,
      1,
    );
    const run = () => {
      writeFileSync(log, '');
      const result = spawnSync(
        'bash',
        ['-c', ['set -Eeuo pipefail', `PATH='${bin}':"$PATH"`, ...quiet, 'console_quiet'].join('\n')],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(log, 'utf8').trimEnd().split('\n').filter(Boolean);
    };

    const first = run();
    const disabled = '# disabled by papercusp, console is the status channel (WI-10007009): ';
    expect(readFileSync(join(etc, 'rsyslog.d', '90-google.conf'), 'utf8')).toBe(
      `# Send daemon and kernel messages to the console\n${disabled}daemon,kern.* /dev/console\n`,
    );
    expect(readFileSync(join(etc, 'rsyslog.conf'), 'utf8')).toBe(`*.emerg :omusrmsg:*\n${disabled}kern.*\t-/dev/console\n`);
    // A commented rule, a file rule and a RainerScript action are not console rules.
    expect(readFileSync(join(etc, 'rsyslog.d', '50-local.conf'), 'utf8')).toBe(local);
    expect(first.filter((call) => call.startsWith('restorecon')).sort()).toEqual(
      [`restorecon ${etc}/rsyslog.conf`, `restorecon ${etc}/rsyslog.d/90-google.conf`].sort(),
    );
    expect(first.filter((call) => call.startsWith('systemctl') && call.includes('rsyslog'))).toEqual([
      'systemctl try-restart rsyslog.service',
    ]);
    for (const unit of WORKSPACE_HOST_EC2_GCP_GUEST_UNITS) {
      expect(first).toContain(`systemctl disable --now --no-block ${unit}`);
      expect(first).toContain(`systemctl mask ${unit}`);
    }

    // A re-run (every reboot re-runs the bootstrap) changes nothing and restarts nothing.
    const second = run();
    expect(readFileSync(join(etc, 'rsyslog.d', '90-google.conf'), 'utf8')).toContain(`${disabled}daemon`);
    expect(second.some((call) => call.startsWith('restorecon') || call.includes('rsyslog'))).toBe(false);
  });
});

describe('parseEc2ConsoleBootstrapStatus', () => {
  it('reads nothing from a console with no marker, even one that prints "failed"', () => {
    expect(parseEc2ConsoleBootstrapStatus('')).toBeNull();
    expect(
      parseEc2ConsoleBootstrapStatus(
        '[   12.3] systemd[1]: Failed to start foo.service\r\nfailed exit=1 phase=harden-os error=x\r\n',
      ),
    ).toBeNull();
  });

  it('takes the LAST marker, so a later run supersedes an earlier failure', () => {
    const consoleText = [
      `${MARKER} running`,
      `${MARKER} failed exit=1 phase=harden-os error=first run`,
      'cloud-init: modules final',
      `${MARKER} running`,
    ].join('\r\n');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'running' });
  });

  it('finds a marker after interleaved kernel output on the same line', () => {
    const consoleText = `[   42.0] audit: type=1400 ${MARKER} succeeded\r\n`;
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'succeeded' });
  });

  it('reads a malformed last marker as no report, never as the older valid one', () => {
    const consoleText = [`${MARKER} failed exit=2 phase=x error=old`, `${MARKER} garbl`].join('\n');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toBeNull();
  });

  it('does not mistake a marker-prefixed word for the marker', () => {
    expect(parseEc2ConsoleBootstrapStatus(`${MARKER}_OTHER succeeded\n`)).toBeNull();
  });
});
