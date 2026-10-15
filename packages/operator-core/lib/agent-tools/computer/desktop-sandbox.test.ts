/**
 * desktop-sandbox.test.ts — P-010 / D-015.
 *
 * The property that actually matters here is an ORDERING one (`--tmpfs /tmp` must precede
 * the socket re-binds), and an ordering property is easy to test in a way that cannot fail.
 * So this file keeps a deliberately-wrong `legacyClobberedOrder` builder as a permanent
 * CONTROL: every order assertion is run against it too and must REJECT it. Without that, a
 * green here would only prove the assertions ran.
 *
 * Argv is read by SEARCHING for a flag and taking its operands, never by fixed index —
 * D-014's lesson, where prefixing two args to an xdotool argv made a pre-existing test
 * silently assert about a different point.
 */
import { describe, expect, it } from 'vitest';
import { credentialMaskArgs } from '../capability/exec-sandbox';
import {
  DESKTOP_ENV_EXTRA_ALLOW,
  X11_SOCKET_DIR,
  a11yBusSocketPath,
  buildDesktopSandboxCommand,
  desktopSandboxEnv,
  discoverGpuDeviceNodes,
  type DesktopSandboxInput,
} from './desktop-sandbox';

const HOME = '/home/agent';
const BUS = '/tmp/dbus-AbCd1234';

const baseInput = (over: Partial<DesktopSandboxInput> = {}): DesktopSandboxInput => ({
  cmd: ['xterm', '-e', 'top'],
  display: ':110',
  a11yBusPath: BUS,
  homeDir: HOME,
  ...over,
});

const build = (over: Partial<DesktopSandboxInput> = {}, opts = {}) =>
  buildDesktopSandboxCommand(baseInput(over), { enabled: true, bwrapWorks: true, ...opts });

/**
 * Index of `flag` whose immediately-following operands match — so an assertion names a
 * SPECIFIC mount, not merely "the word --tmpfs appears somewhere". -1 when absent.
 */
function mountIndex(argv: readonly string[], flag: string, ...operands: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    if (operands.every((op, k) => argv[i + 1 + k] === op)) return i;
  }
  return -1;
}

/**
 * THE CONTROL — the mistake this module exists to prevent, kept executable. It binds the
 * sockets and only THEN applies `--tmpfs /tmp`, so the tmpfs mounts an empty filesystem
 * over both of them. bwrap accepts it, the app starts, and the display is simply gone.
 */
function legacyClobberedOrder(input: DesktopSandboxInput): string[] {
  return [
    '--ro-bind', '/', '/',
    '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR,
    ...(input.a11yBusPath ? ['--bind', input.a11yBusPath, input.a11yBusPath] : []),
    '--tmpfs', '/tmp',
    '--proc', '/proc', '--dev', '/dev',
    '--', ...input.cmd,
  ];
}

describe('buildDesktopSandboxCommand — D-015 mount plan', () => {
  it('carries BOTH sockets that a desktop app needs, and runs the app under bwrap', () => {
    const d = build();
    expect(d.sandboxed).toBe(true);
    expect(d.reason).toBe('sandboxed');
    expect(d.binary).toBe('bwrap');
    expect(mountIndex(d.argv, '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR)).toBeGreaterThan(-1);
    expect(mountIndex(d.argv, '--bind', BUS, BUS)).toBeGreaterThan(-1);
    // The payload is last, after the `--` terminator.
    expect(d.argv.slice(d.argv.lastIndexOf('--') + 1)).toEqual(['xterm', '-e', 'top']);
  });

  // ── the ordering invariant, asserted against BOTH the real builder and the control ──
  it('applies --tmpfs /tmp BEFORE re-binding the X socket (and rejects the reversed order)', () => {
    const good = build().argv;
    const tmpfs = mountIndex(good, '--tmpfs', '/tmp');
    const xsock = mountIndex(good, '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR);
    expect(tmpfs).toBeGreaterThan(-1);
    expect(xsock).toBeGreaterThan(tmpfs);

    // CONTROL: the same assertion must FAIL on the clobbered order, or it proves nothing.
    const bad = legacyClobberedOrder(baseInput());
    expect(mountIndex(bad, '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR)).toBeLessThan(
      mountIndex(bad, '--tmpfs', '/tmp'),
    );
  });

  it('applies --tmpfs /tmp BEFORE re-binding the a11y bus socket (and rejects the reversed order)', () => {
    const good = build().argv;
    expect(mountIndex(good, '--bind', BUS, BUS)).toBeGreaterThan(mountIndex(good, '--tmpfs', '/tmp'));

    const bad = legacyClobberedOrder(baseInput());
    expect(mountIndex(bad, '--bind', BUS, BUS)).toBeLessThan(mountIndex(bad, '--tmpfs', '/tmp'));
  });

  it('omits the bus bind entirely when the desktop has no a11y bus', () => {
    const d = build({ a11yBusPath: null });
    expect(d.argv.filter((a) => a.startsWith('/tmp/dbus-'))).toEqual([]);
    // …but the X socket is still carried: the two are independent.
    expect(mountIndex(d.argv, '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR)).toBeGreaterThan(-1);
  });

  it('gives the app a private writable HOME rather than the operator user\'s', () => {
    expect(mountIndex(build().argv, '--tmpfs', HOME)).toBeGreaterThan(-1);
  });

  it('DELEGATES credential masking to the shared emitter rather than re-deriving it', () => {
    // Asserted as delegation, not as a hardcoded path list, for two reasons: the emitter
    // SKIPS targets absent on the host (so a literal expectation would be machine-dependent
    // and would pass vacuously on a box without ~/.aws), and the property worth pinning is
    // that these two sandboxes cannot drift apart. A copy-paste of the policy back into this
    // module fails here even if it happens to be correct on the day it is written.
    // maskExists is stubbed TRUE so every mask target is emitted regardless of which
    // dotfiles exist on the machine running this — otherwise the comparison could pass
    // while comparing two empty lists.
    const allExist = () => true;
    const argv = build({ homeDir: HOME }, { maskExists: allExist }).argv;
    const expected = credentialMaskArgs(HOME, allExist);
    expect(expected.length).toBeGreaterThan(3); // a real list, not a vacuous match

    // Locate the block as a SUBSEQUENCE. `indexOf(expected[0])` is wrong here and was the
    // first thing this test caught: `--ro-bind` also opens the root bind at argv[0], so a
    // first-match search compares against the wrong region entirely.
    const start = argv.findIndex((_, i) => expected.every((e, k) => argv[i + k] === e));
    expect(start).toBeGreaterThan(-1);
  });

  it('never masks a FILE credential with --tmpfs, which would no-op and leave it readable', () => {
    // The specific bug the shared emitter exists to prevent (`~/.npmrc` holds auth tokens).
    // Read off the emitter's real output so it holds for whatever the mask list becomes.
    const args = credentialMaskArgs(HOME, () => true);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--tmpfs') expect(args[i + 1]).not.toMatch(/\.npmrc$/);
    }
  });

  it('BINDS the app to its desktop with --die-with-parent, so teardown cannot orphan the scope', () => {
    // ⚠ This assertion was originally written INVERTED, on the reasoning that EI-16635
    // removed this flag for background jobs. That reasoning does not transfer: there, the
    // launcher is meant to exit first; here, bwrap's parent is the long-lived scope client
    // that IS the desktop. Live accessibility tests caught it — 6 red on
    // "the systemd-run client exited but its scope still holds processes" (WI-37509).
    // Kept as a named assertion so the flag cannot be dropped again by the same argument.
    const argv = build().argv;
    expect(argv).toContain('--die-with-parent');
    // …and it must precede the `--` terminator, or it would be an argument to the APP.
    expect(argv.indexOf('--die-with-parent')).toBeLessThan(argv.lastIndexOf('--'));
  });
});

describe('buildDesktopSandboxCommand — network isolation is OPT-IN (D-015 §3)', () => {
  it('shares the network by default', () => {
    expect(build().argv).not.toContain('--unshare-net');
  });

  it('adds --unshare-net when asked, and STILL carries the filesystem X socket', () => {
    const argv = build({}, { denyNetwork: true }).argv;
    expect(argv).toContain('--unshare-net');
    // This pairing is the whole ruling: a new netns loses the ABSTRACT X socket, so the
    // filesystem one is the only way the display stays reachable. Asserting them together
    // is what stops someone adding net isolation without the bind.
    expect(mountIndex(argv, '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR)).toBeGreaterThan(-1);
  });
});

describe('buildDesktopSandboxCommand — IPC stays SHARED (WI-1105361)', () => {
  it('never unshares the IPC namespace, because MIT-SHM would stop working', () => {
    // A desktop app is an X client of an Xvfb OUTSIDE this sandbox. MIT-SHM works by the
    // client creating a SysV segment and the server attaching to it BY ID, so a private IPC
    // namespace makes that id unresolvable and the next XShmPutImage is a BadValue that X
    // kills the client for. Measured 9/10 deaths with the flag vs 0/10 without.
    //
    // This assertion is the guard: re-adding `--unshare-ipc` reads like tightening
    // isolation, and its damage shows up somewhere else entirely — as a flaky "the GL app
    // painted nothing" in desktop-gl-live, hours later and in another package.
    expect(build().argv).not.toContain('--unshare-ipc');
    expect(build({ glTier: 'hardware' }).argv).not.toContain('--unshare-ipc');
    expect(build({}, { denyNetwork: true }).argv).not.toContain('--unshare-ipc');
  });

  it('still unshares the namespaces that cost the app nothing', () => {
    // Dropping IPC is a targeted concession, not a retreat from confinement — if these
    // went too, the test above would be passing for the wrong reason.
    const argv = build().argv;
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--unshare-uts');
    expect(argv).toContain('--unshare-cgroup-try');
  });
});

describe('buildDesktopSandboxCommand — GL', () => {
  it('binds /dev/dri for a hardware desktop, so --dev /dev cannot silently undo P-002', () => {
    const argv = build({ glTier: 'hardware' }).argv;
    expect(mountIndex(argv, '--dev-bind-try', '/dev/dri', '/dev/dri')).toBeGreaterThan(-1);
    // and it must come AFTER `--dev /dev`, which would otherwise replace it
    expect(mountIndex(argv, '--dev-bind-try', '/dev/dri', '/dev/dri')).toBeGreaterThan(
      mountIndex(argv, '--dev', '/dev'),
    );
  });

  it.each(['software', 'none'] as const)('gives a %s desktop no GPU handle', (tier) => {
    expect(build({ glTier: tier }).argv).not.toContain('/dev/dri');
  });
});

/**
 * WI-1105361. `/dev/dri` is the Mesa/DRM interface; the NVIDIA proprietary stack needs its
 * OWN nodes. Binding only `/dev/dri` left NVIDIA's EGL with no device inside the sandbox,
 * so libglvnd fell through to the Mesa ICD, which cannot drive an NVIDIA card — the desktop
 * rendered in llvmpipe SOFTWARE while `gl-strategy` recorded `tier: 'hardware'`, because
 * `probeRenderer` runs OUTSIDE the sandbox where NVIDIA works.
 *
 * Measured with the byte-exact production argv, n=20 per arm: without these nodes 20/20 runs
 * reached `llvmpipe (LLVM 20.1.2)`; with them, 20/20 reached `NVIDIA GeForce RTX 3090`.
 *
 * The nodes are INJECTED here rather than discovered, so these assertions mean the same
 * thing on a CI box with no GPU as on the RTX host where the bug was found.
 */
describe('buildDesktopSandboxCommand — vendor GPU nodes (WI-1105361)', () => {
  const NODES = ['/dev/nvidia0', '/dev/nvidia-uvm', '/dev/nvidiactl'] as const;

  it('binds each vendor GPU node for a hardware desktop, AFTER --dev /dev', () => {
    const argv = build({ glTier: 'hardware' }, { gpuDeviceNodes: NODES }).argv;
    for (const node of NODES) {
      const at = mountIndex(argv, '--dev-bind-try', node, node);
      expect(at, `${node} must be bound`).toBeGreaterThan(-1);
      // `--dev /dev` builds a minimal /dev; a bind BEFORE it is silently replaced.
      expect(at, `${node} must come after --dev /dev`).toBeGreaterThan(mountIndex(argv, '--dev', '/dev'));
    }
  });

  it('uses --dev-bind-try, never --dev-bind, so an absent node cannot abort the whole command', () => {
    const argv = build({ glTier: 'hardware' }, { gpuDeviceNodes: NODES }).argv;
    for (const node of NODES) {
      expect(mountIndex(argv, '--dev-bind', node, node), `${node} must not use the strict form`).toBe(-1);
    }
  });

  /**
   * THE CLAUSE-6 SAFETY PROPERTY. The plan's A-bar targets a GPU-LESS GCP workspace VM.
   * A host with no NVIDIA nodes must come out byte-identical to the pre-fix command, or
   * this fix breaks the very environment the next A-bar clause depends on.
   */
  it('adds nothing on a GPU-less host, while still binding /dev/dri', () => {
    const argv = build({ glTier: 'hardware' }, { gpuDeviceNodes: [] }).argv;
    expect(argv.filter((a) => a.includes('nvidia'))).toEqual([]);
    expect(mountIndex(argv, '--dev-bind-try', '/dev/dri', '/dev/dri')).toBeGreaterThan(-1);
  });

  it.each(['software', 'none'] as const)(
    'gives a %s desktop no vendor GPU node even when the host has them',
    (tier) => {
      const argv = build({ glTier: tier }, { gpuDeviceNodes: NODES }).argv;
      expect(argv.filter((a) => a.includes('nvidia'))).toEqual([]);
    },
  );

  it('discovers only real NVIDIA device nodes, never a lookalike', () => {
    // Host-independent: on a GPU-less box this is [] and the assertion still holds.
    for (const node of discoverGpuDeviceNodes()) {
      expect(node).toMatch(/^\/dev\/nvidia(ctl|-modeset|-uvm|-uvm-tools|\d+)$/);
    }
  });

  /**
   * THE CONTROL, in this file's established idiom (see `legacyClobberedOrder`): the exact
   * pre-fix mount plan — `/dev/dri` and nothing else — kept executable and permanent. The
   * bug it encodes was invisible for a reason: it produced no error, no red test and real
   * pixels, just software ones. So the assertions above must be shown to REJECT it, or a
   * green here would only prove they ran.
   */
  it('REJECTS the pre-fix plan that bound /dev/dri alone', () => {
    const preFix = build({ glTier: 'hardware' }, { gpuDeviceNodes: [] }).argv;

    // It still looks entirely healthy on the old assertion...
    expect(mountIndex(preFix, '--dev-bind-try', '/dev/dri', '/dev/dri')).toBeGreaterThan(-1);
    // ...and yet carries no vendor node, which is what silently cost hardware GL.
    for (const node of NODES) {
      expect(mountIndex(preFix, '--dev-bind-try', node, node)).toBe(-1);
    }
  });
});

describe('buildDesktopSandboxCommand — FAIL-OPEN', () => {
  it('runs the app raw when the flag is off', () => {
    const d = buildDesktopSandboxCommand(baseInput(), { enabled: false, bwrapWorks: true });
    expect(d).toMatchObject({ binary: 'xterm', argv: ['-e', 'top'], sandboxed: false, reason: 'flag-off' });
  });

  it('runs the app raw when bwrap cannot sandbox on this host', () => {
    const d = buildDesktopSandboxCommand(baseInput(), { enabled: true, bwrapWorks: false });
    expect(d).toMatchObject({ binary: 'xterm', sandboxed: false, reason: 'bwrap-unavailable' });
  });
});

describe('a11yBusSocketPath', () => {
  it('extracts the path from the address dbus actually prints for unix:tmpdir=/tmp', () => {
    // verbatim shape measured from `dbus-daemon --print-address` with our own bus config
    expect(a11yBusSocketPath('unix:path=/tmp/dbus-85DYQtR2WE,guid=a7291544af4f41c6')).toBe(
      '/tmp/dbus-85DYQtR2WE',
    );
  });

  it('returns null for an ABSTRACT address — there is no path to bind, and none would help', () => {
    expect(a11yBusSocketPath('unix:abstract=/tmp/dbus-Xyz,guid=abc')).toBeNull();
  });

  it.each([null, undefined, '', 'garbage', 'unix:path='])('returns null for %p', (addr) => {
    expect(a11yBusSocketPath(addr)).toBeNull();
  });
});

describe('desktopSandboxEnv', () => {
  it('uses the private writable temp mount instead of inherited host temp paths', () => {
    const env = desktopSandboxEnv({
      PATH: '/usr/bin', TMPDIR: '/run/operator-private/tmp',
      TMP: '/fixture/inherited-tmp', TEMP: '/fixture/inherited-temp',
    });
    expect({ TMPDIR: env.TMPDIR, TMP: env.TMP, TEMP: env.TEMP })
      .toEqual({ TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });
    expect(env.PATH).toBe('/usr/bin');
  });

  it('drops operator credentials', () => {
    const env = desktopSandboxEnv({ PATH: '/usr/bin', DATABASE_URL: 'postgres://secret', AWS_SECRET_ACCESS_KEY: 'x' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('keeps the desktop address vars the shared allowlist does not carry', () => {
    const env = desktopSandboxEnv({
      DISPLAY: ':110',
      XAUTHORITY: '/tmp/xauth',
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${BUS}`,
      AT_SPI_BUS_ADDRESS: `unix:path=${BUS}`,
    });
    for (const k of DESKTOP_ENV_EXTRA_ALLOW) expect(env[k]).toBeDefined();
  });

  it('layers overlays AFTER the scrub, so a GL var the strategy set is never scrubbed away', () => {
    // __GLX_VENDOR_LIBRARY_NAME is not on any allowlist; as an OVERLAY it must survive,
    // which is the D-011 rule ("the caller's env is the payload's") applied one level down.
    const env = desktopSandboxEnv(
      { PATH: '/usr/bin', __GLX_VENDOR_LIBRARY_NAME: 'ignored-as-base' },
      { __GLX_VENDOR_LIBRARY_NAME: 'mesa', DISPLAY: ':110' },
    );
    expect(env.__GLX_VENDOR_LIBRARY_NAME).toBe('mesa');
    expect(env.DISPLAY).toBe(':110');
  });
});
