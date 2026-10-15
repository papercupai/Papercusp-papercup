/** The pack's socket-activated, credential-free desktop worker. No operator store imports. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { provisionSandboxDesktop, type DesktopProvisionRuntime } from '../agent-tools/computer/desktop-provisioner-core';
import { startA11yBus } from './a11y-bus-core';
import { PERSONAL_DESKTOP_ACCOUNT, serveWorkspaceDesktop } from './workspace-desktop-session';

export const WORKSPACE_DESKTOP_HOME = '/var/lib/papercusp-desktop';
/** Neutral grey, so a desktop with no windows is visibly alive in Watch (WI-10002863). */
export const WORKSPACE_DESKTOP_ROOT_COLOR = '#4b5563';

/**
 * personal-cloud-desktop-2026-10-06 (D-001): the personal worker runs as the customer
 * workspace account, the identity the person's hosted terminal already uses, so their
 * checkout, files and git/agent credentials are present on their own desktop.
 */
export const PERSONAL_DESKTOP_HOME = `/home/${PERSONAL_DESKTOP_ACCOUNT}`;
/**
 * The two workers keep their flock directories in homes the other cannot read, so they
 * cannot coordinate on a display number. Disjoint ranges make a collision impossible
 * instead of a race: sandbox desktops take :110-:209, personal desktops :210-:250.
 */
export const SANDBOX_DISPLAY_RANGE = { first: 110, last: 209 } as const;
export const PERSONAL_DISPLAY_RANGE = { first: 210, last: 250 } as const;

export type DesktopWorkerMode = 'sandbox' | 'personal';

export function assertWorkspaceDesktopIdentity(identity: { uid: number; username: string; home: string }): void {
  if (identity.uid <= 0 || identity.username !== 'papercusp-desktop' || identity.home !== WORKSPACE_DESKTOP_HOME) {
    throw new Error('desktop worker requires the dedicated desktop identity and home');
  }
}

/** R-2: the personal worker refuses to start as anything but the customer account. */
export function assertPersonalDesktopIdentity(identity: { uid: number; username: string; home: string }): void {
  if (identity.uid <= 0 || identity.username !== PERSONAL_DESKTOP_ACCOUNT || identity.home !== PERSONAL_DESKTOP_HOME) {
    throw new Error('personal desktop worker requires the customer workspace account and its home');
  }
}

/**
 * The personal session's environment: the person's own HOME and login names, and the
 * same fixed shell/PATH as the sandbox. The unit's environment is still discarded, so a
 * credential set on the unit never reaches the session.
 */
export function personalDesktopEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...workspaceDesktopEnvironment(env),
    HOME: PERSONAL_DESKTOP_HOME,
    USER: PERSONAL_DESKTOP_ACCOUNT,
    LOGNAME: PERSONAL_DESKTOP_ACCOUNT,
  };
}

/** Where each worker mode keeps its per-display locks and KasmVNC password files. */
export function desktopWorkerPaths(mode: DesktopWorkerMode): { home: string; locks: string; credentials: string; range: { first: number; last: number } } {
  if (mode === 'personal') {
    const state = `${PERSONAL_DESKTOP_HOME}/.local/state/papercusp-desktop`;
    return { home: PERSONAL_DESKTOP_HOME, locks: `${state}/display-locks`, credentials: `${state}/credentials`, range: PERSONAL_DISPLAY_RANGE };
  }
  return { home: WORKSPACE_DESKTOP_HOME, locks: `${WORKSPACE_DESKTOP_HOME}/display-locks`, credentials: `${WORKSPACE_DESKTOP_HOME}/credentials`, range: SANDBOX_DISPLAY_RANGE };
}

/**
 * Explicit allowlist: this child never receives service/agent/provider/database credentials.
 *
 * SHELL is FIXED here, not inherited (WI-10003133). The desktop account is `nologin` on
 * purpose, and XFCE Terminal picks `$SHELL` before the passwd shell — without it every
 * terminal window execs `/usr/sbin/nologin`, which exits at once and closes the window
 * (the "flash"). This allowlist wipes the unit's `Environment=` lines, so a SHELL set on
 * the systemd unit never reaches the session; it has to be set in this function.
 */
export function workspaceDesktopEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { HOME: WORKSPACE_DESKTOP_HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/bash' };
  for (const key of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'NO_AT_BRIDGE', 'GTK_MODULES', 'QT_ACCESSIBILITY']) {
    if (env[key] !== undefined) clean[key] = env[key];
  }
  return clean;
}

function workerRuntime(mode: DesktopWorkerMode): DesktopProvisionRuntime {
  const environment = mode === 'personal' ? personalDesktopEnvironment : workspaceDesktopEnvironment;
  return {
    spawn: async (command, args, _spec, options) => {
      const child = spawn(command, [...args], options?.spawnOptions ?? {});
      // Report errors through the provisioner diagnostics without an unhandled EventEmitter error.
      child.on('error', () => {});
      return { child, taskId: null, scopeUnit: null, confined: false, row: { detail: { unledgered: true } } };
    },
    startBus: display => startA11yBus(display),
    // The dedicated systemd unit supplies mount, Unix-user and whole-cgroup containment.
    // GL is measured in that SAME process environment; do not claim a nested bwrap probe.
    sandbox: async () => ({
      forGlProbe: command => [...command],
      forApp: command => ({ binary: command[0], argv: command.slice(1), sandboxed: false }),
    }),
    appEnv: (env, overlays) => ({ ...environment(env), ...overlays }),
  };
}

/**
 * Split `--personal` off the front of argv. The flag is the ONLY way to select personal
 * mode, and each mode asserts its own identity, so a unit pointed at the wrong account
 * fails at start instead of serving a desktop under an unexpected Unix user.
 */
export function parseDesktopWorkerArgv(argv: string[]): { mode: DesktopWorkerMode; rest: string[] } {
  return argv[0] === '--personal' ? { mode: 'personal', rest: argv.slice(1) } : { mode: 'sandbox', rest: argv };
}

export async function runWorkspaceDesktopWorker(argv: string[]): Promise<number> {
  const { mode, rest } = parseDesktopWorkerArgv(argv);
  if (rest.length === 1 && rest[0] === '--help') {
    process.stdout.write('papercusp-desktop-session --stdio | --check\npapercusp-desktop-session --personal --stdio | --check\n');
    return 0;
  }
  const identity = userInfo();
  const asserted = { uid: identity.uid, username: identity.username, home: process.env.HOME ?? '' };
  if (mode === 'personal') assertPersonalDesktopIdentity(asserted);
  else assertWorkspaceDesktopIdentity(asserted);
  const paths = desktopWorkerPaths(mode);
  const clean = (mode === 'personal' ? personalDesktopEnvironment : workspaceDesktopEnvironment)({});
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
  const modeArgs = mode === 'personal' ? ['--personal'] : [];
  if (rest.length === 1 && rest[0] === '--check') return 0;
  if (rest.length === 1 && rest[0] === '--stdio') {
    mkdirSync(paths.locks, { recursive: true, mode: 0o700 });
    // Kernel flock lifetime covers provisioning AND the whole lease. No stale PID-file cleanup
    // or race between two socket-activated instances selecting the same display.
    for (let display = paths.range.first; display <= paths.range.last; display++) {
      if (existsSync(`/tmp/.X${display}-lock`)) continue;
      const status = await new Promise<number>((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['-n', '-E', '75', `${paths.locks}/${display}`, process.execPath, process.argv[1], ...modeArgs, '--display', String(display)], { stdio: 'inherit', env: clean });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
      });
      if (status !== 75) return status;
    }
    throw new Error('no isolated desktop display available');
  }
  if (rest.length !== 2 || rest[0] !== '--display' || !/^\d+$/.test(rest[1])) throw new Error('invalid desktop worker arguments');
  const number = Number(rest[1]);
  if (number < paths.range.first || number > paths.range.last || existsSync(`/tmp/.X${number}-lock`)) throw new Error('desktop display unavailable');
  mkdirSync(paths.credentials, { recursive: true, mode: 0o700 });
  const runtime = workerRuntime(mode);
  await serveWorkspaceDesktop(process.stdin, process.stdout, options => {
    // The person's desktop is an XFCE session in their own account. Arbitrary app argv
    // over the wire would let the operator run commands as the customer, which the
    // sandbox worker permits only because that account owns nothing.
    if (mode === 'personal' && options.apps?.length) throw new Error('personal desktop accepts no app argv');
    return provisionSandboxDesktop({
      ...options, displayNumber: number, xServer: 'kasmvnc', rootColor: WORKSPACE_DESKTOP_ROOT_COLOR, desktopSession: 'xfce',
      credentialDir: paths.credentials, sandboxHomeDir: paths.home,
    }, runtime);
  }, undefined, mode === 'personal' ? PERSONAL_DESKTOP_ACCOUNT : undefined);
  return 0;
}
