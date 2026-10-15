/**
 * x-server-backend.test.ts — P-012's security properties, asserted where they are
 * cheap to assert.
 *
 * These are unit tests on a pure function ON PURPOSE. The properties below (loopback
 * binding, no IPv6 second listener, no unauthenticated mode, no owner credential) are
 * exactly the ones whose failure is INVISIBLE at runtime: a desktop bound to 0.0.0.0
 * works perfectly, serves pixels correctly, and passes every functional test — it is
 * simply also reachable from the internet. There is no integration test that fails on
 * that, which is why the argv is built by a pure function and pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  KASMVNC_CONTROL_USER,
  KASMVNC_LOOPBACK_INTERFACE,
  KASMVNC_VIEW_USER,
  buildXServerCommand,
  kasmvncPasswordArgv,
  kasmvncWebsocketPort,
} from './x-server-backend';

/** Read the value following a flag in an argv, so assertions do not depend on order. */
function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

const KASM = {
  xServer: 'kasmvnc' as const,
  display: ':110',
  width: 1024,
  height: 768,
  websocketPort: 7010,
  passwordFile: '/run/papercusp/desktop/kasmvnc-110.passwd',
};

describe('P-012 — the xvfb backend preserves root properties across client exit', () => {
  it('keeps X server state after xprop exits, and serves no endpoint', () => {
    const cmd = buildXServerCommand({ xServer: 'xvfb', display: ':110', width: 1024, height: 768 });
    expect(cmd.binary).toBe('Xvfb');
    expect(cmd.argv).toEqual([':110', '-screen', '0', '1024x768x24', '-nolisten', 'tcp', '-noreset']);
    // The absence of an endpoint is a LOAD-BEARING fact, not an omission: it is what
    // makes the local desktop's "no listener, ever" property true, and what a
    // kasmvnc-backed session may therefore not claim.
    expect(cmd.endpoint).toBeNull();
  });

  it('REFUSES listener options rather than ignoring them', () => {
    // A caller passing a websocket port to a backend that has no websocket believes it
    // configured something reachable. Dropping it silently would leave that caller
    // holding a desktop it thinks a viewer can dial and nothing can.
    expect(() =>
      buildXServerCommand({
        xServer: 'xvfb',
        display: ':110',
        width: 1024,
        height: 768,
        websocketPort: 7010,
      }),
    ).toThrow(/serves\s+no listener/i);
  });
});

describe('P-012 / D-020 — the kasmvnc backend binds to loopback only', () => {
  it('pins -interface to 127.0.0.1, OVERRIDING the package default of "all"', () => {
    // Measured from the 1.5.0 package: kasmvnc_defaults.yaml says `interface: 0.0.0.0`
    // and `Xkasmvnc -help` says `interface ... (default=all)`. If this assertion is
    // ever "simplified" away on the grounds that it restates a default, it does not:
    // it contradicts one.
    const cmd = buildXServerCommand(KASM);
    expect(valueAfter(cmd.argv, '-interface')).toBe('127.0.0.1');
    expect(KASMVNC_LOOPBACK_INTERFACE).toBe('127.0.0.1');
    expect(cmd.endpoint).toEqual({ host: '127.0.0.1', port: 7010 });
  });

  it('disables IPv6, so a v4-only bind cannot leave an unpinned v6 listener beside it', () => {
    expect(valueAfter(buildXServerCommand(KASM).argv, '-UseIPv6')).toBe('0');
  });

  it('disables the classic RFB port explicitly', () => {
    // Already the default; passed anyway because a config file is read after these
    // defaults and can re-enable it, while the CLI is the layer the caller controls.
    expect(valueAfter(buildXServerCommand(KASM).argv, '-rfbport')).toBe('0');
  });

  it('never emits an address that is not loopback', () => {
    const argv = buildXServerCommand(KASM).argv;
    for (const wildcard of ['0.0.0.0', '::', 'all', '*']) {
      expect(argv).not.toContain(wildcard);
    }
  });
});

describe('P-012 / D-020 — the kasmvnc backend always authenticates', () => {
  it('REFUSES to build a command with no password file', () => {
    const { passwordFile: _omitted, ...noCreds } = KASM;
    expect(() => buildXServerCommand(noCreds)).toThrow(/requires a passwordFile/i);
  });

  it('never disables basic auth', () => {
    // There is deliberately no option that produces this flag. If a future change adds
    // one, this fails — which is the point: an unauthenticated desktop makes the proxy
    // the single point of failure D-020 refused to accept.
    expect(buildXServerCommand(KASM).argv).not.toContain('-DisableBasicAuth');
  });

  it('passes the credential file through -KasmPasswordFile', () => {
    expect(valueAfter(buildXServerCommand(KASM).argv, '-KasmPasswordFile')).toBe(KASM.passwordFile);
  });
});

describe('P-012 / D-020 — watch and takeover map onto kasmvncpasswd permissions', () => {
  it('watch is read-only: -r and no -w', () => {
    const argv = kasmvncPasswordArgv({
      user: KASMVNC_VIEW_USER,
      passwordFile: '/tmp/pw',
      mode: 'view',
    });
    expect(argv).toContain('-r');
    expect(argv).not.toContain('-w');
  });

  it('takeover adds input: -r and -w', () => {
    const argv = kasmvncPasswordArgv({
      user: KASMVNC_CONTROL_USER,
      passwordFile: '/tmp/pw',
      mode: 'control',
    });
    expect(argv).toContain('-r');
    expect(argv).toContain('-w');
  });

  it('NEITHER mode is ever granted -o (owner)', () => {
    // -o is user management. A viewer holding it could mint itself a write credential,
    // which would make the audited takeover path optional rather than mandatory — the
    // audit parity D-020 promises would then be unenforceable.
    for (const mode of ['view', 'control'] as const) {
      expect(kasmvncPasswordArgv({ user: 'u', passwordFile: '/tmp/pw', mode })).not.toContain('-o');
    }
  });
});

describe('P-012 — websocket port mapping', () => {
  it('is deterministic per display and clear of KasmVNC’s own 6800 default', () => {
    expect(kasmvncWebsocketPort(110)).toBe(7010);
    expect(kasmvncWebsocketPort(110)).toBe(kasmvncWebsocketPort(110));
    expect(kasmvncWebsocketPort(1)).toBeGreaterThan(6800);
  });

  it('refuses display 0 and negatives — the host display is never a pool member', () => {
    expect(() => kasmvncWebsocketPort(0)).toThrow();
    expect(() => kasmvncWebsocketPort(-1)).toThrow();
  });
});

describe('P-012 — malformed input is refused, not normalised', () => {
  it('rejects a malformed display', () => {
    expect(() =>
      buildXServerCommand({ ...KASM, display: '110' }),
    ).toThrow(/malformed display/i);
  });

  it('rejects non-positive geometry', () => {
    expect(() => buildXServerCommand({ ...KASM, width: 0 })).toThrow(/invalid geometry/i);
  });
});

describe('P-012 — the DRI3 rung is opt-in', () => {
  it('omits -hw3d unless a render node is named', () => {
    expect(buildXServerCommand(KASM).argv).not.toContain('-hw3d');
  });

  it('adds -hw3d and -drinode together when one is', () => {
    // The GPU-less BYOC VMs never take this branch; it exists so a GPU-bearing host is
    // not silently held to the software rung.
    const argv = buildXServerCommand({ ...KASM, hw3d: { drinode: '/dev/dri/renderD128' } }).argv;
    expect(argv).toContain('-hw3d');
    expect(valueAfter(argv, '-drinode')).toBe('/dev/dri/renderD128');
  });
});
