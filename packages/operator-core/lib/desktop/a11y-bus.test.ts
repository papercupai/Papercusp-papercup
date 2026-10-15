/**
 * Unit tests for the per-desktop accessibility bus bootstrap (P-007 / D-010(c)).
 *
 * The interesting assertions here are all about ISOLATION, because the failure this
 * module can produce is silent: a well-formed bus address for the WRONG desktop makes
 * every consumer downstream work correctly against the operator's own session.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  busBelongsToDisplay,
  a11yBusPropertyReadbackFailure,
  a11yBusPropertyWriteFailure,
  createOwnedDaemonRelease,
  minimalSessionBusConfig,
  parseSessionBusPid,
  parseSessionBusStartup,
  publishBusPropertyCommand,
  sessionBusCommand,
  A11Y_APP_ENV,
} from './a11y-bus';

describe('minimalSessionBusConfig', () => {
  it('advertises ONLY the service directory we control — the portal cascade guard', () => {
    const conf = minimalSessionBusConfig('/tmp/pc-a11y-x/services');
    expect(conf).toContain('<servicedir>/tmp/pc-a11y-x/services</servicedir>');
    // Exactly one servicedir: a second one (e.g. the system's) would readmit
    // xdg-desktop-portal, which is the measured cause of blank screenshots.
    expect(conf.match(/<servicedir>/g)).toHaveLength(1);
    expect(conf).not.toContain('/usr/share/dbus-1/services');
    expect(conf).toContain('<type>session</type>');
  });
});

describe('sessionBusCommand', () => {
  it('forks and prints the address, so the caller can pin apps to it', () => {
    const cmd = sessionBusCommand('/tmp/x/session.conf');
    expect(cmd.bin).toBe('dbus-daemon');
    expect(cmd.args).toContain('--fork');
    expect(cmd.args).toContain('--print-address=1');
    expect(cmd.args).toContain('--print-pid=1');
    expect(cmd.args).toContain('--config-file=/tmp/x/session.conf');
  });
});

describe('session-bus startup parsing', () => {
  const output = 'unix:path=/tmp/dbus-abc,guid=deadbeef\n1812773\n';

  it('parses the address and PID emitted by the forked daemon', () => {
    expect(parseSessionBusStartup(output)).toEqual({
      sessionBus: 'unix:path=/tmp/dbus-abc,guid=deadbeef',
      pid: 1812773,
    });
  });

  it('rejects incomplete or unsafe PID output', () => {
    expect(parseSessionBusPid('unix:path=/tmp/dbus-abc\n')).toBeNull();
    expect(parseSessionBusPid('unix:path=/tmp/dbus-abc\n1\n')).toBeNull();
    expect(parseSessionBusStartup('1812773\n')).toBeNull();
  });
});

describe('createOwnedDaemonRelease', () => {
  it('signals the owned daemon once even when release is called repeatedly', () => {
    const kill = vi.fn();
    const release = createOwnedDaemonRelease(1812773, { kill });

    release();
    release();

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(1812773, 'SIGTERM');
  });

  it('turns an already-exited daemon into a harmless idempotent release', () => {
    const kill = vi.fn(() => { throw new Error('ESRCH'); });
    const release = createOwnedDaemonRelease(1812773, { kill });

    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();
  });

  // WI-41108. The ledger row is closed from this hook, so it inherits the SAME
  // `released` latch as the signal. A second, independently-guarded closure is how
  // a row gets closed twice — or missed entirely when the two latches disagree.
  it('runs onRelease exactly once, after the signal, however often release is called', () => {
    const order: string[] = [];
    const kill = vi.fn(() => { order.push('kill'); });
    const onRelease = vi.fn(() => { order.push('onRelease'); });
    const release = createOwnedDaemonRelease(1812773, { kill, onRelease });

    release();
    release();
    release();

    expect(onRelease).toHaveBeenCalledOnce();
    expect(order).toEqual(['kill', 'onRelease']);
  });

  it('still closes the ledger row when the daemon is already gone', () => {
    // The ESRCH path is the COMMON one for a stranded bus, so a row that only
    // closes on a successful signal would leak precisely the rows that matter.
    const kill = vi.fn(() => { throw new Error('ESRCH'); });
    const onRelease = vi.fn();
    const release = createOwnedDaemonRelease(1812773, { kill, onRelease });

    expect(() => release()).not.toThrow();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('does not let a failed ledger write break a desktop teardown', () => {
    const kill = vi.fn();
    const onRelease = vi.fn(() => { throw new Error('ledger unreachable'); });
    const release = createOwnedDaemonRelease(1812773, { kill, onRelease });

    expect(() => release()).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();
  });

  it('is unchanged for callers that pass no onRelease', () => {
    const kill = vi.fn();
    const release = createOwnedDaemonRelease(1812773, { kill });

    expect(() => release()).not.toThrow();
    expect(kill).toHaveBeenCalledWith(1812773, 'SIGTERM');
  });
});

describe('publishBusPropertyCommand', () => {
  it('writes AT_SPI_BUS on the sandbox root so the binding is discoverable cross-process', () => {
    const cmd = publishBusPropertyCommand(':110', 'unix:path=/run/user/1000/at-spi/bus_110');
    expect(cmd.bin).toBe('xprop');
    expect(cmd.args).toEqual([
      '-display', ':110', '-root', '-f', 'AT_SPI_BUS', '8s', '-set', 'AT_SPI_BUS',
      'unix:path=/run/user/1000/at-spi/bus_110',
    ]);
  });
});

describe('accessibility bus root-property publication', () => {
  it('accepts only a successful xprop write', () => {
    expect(a11yBusPropertyWriteFailure({ status: 0 })).toBeNull();
    expect(a11yBusPropertyWriteFailure({ status: 1, stderr: 'unable to open display' }))
      .toContain('xprop publication exited 1: unable to open display');
    expect(a11yBusPropertyWriteFailure({ status: null, error: new Error('spawn ENOENT') }))
      .toContain('xprop could not publish AT_SPI_BUS: spawn ENOENT');
  });

  it('requires the root window to expose the exact bus that provisioning returned', () => {
    const bus = 'unix:path=/run/user/1000/at-spi/bus_110';
    expect(a11yBusPropertyReadbackFailure(bus, {
      status: 0,
      stdout: `AT_SPI_BUS(STRING) = "${bus}"`,
    })).toBeNull();
    expect(a11yBusPropertyReadbackFailure(bus, {
      status: 0,
      stdout: 'AT_SPI_BUS:  no such atom on any window.\n',
      stderr: '',
    })).toContain(
      'xprop readback did not contain an AT_SPI_BUS property; stdout="AT_SPI_BUS:  no such atom on any window.\\n" stderr=""',
    );
    expect(a11yBusPropertyReadbackFailure(bus, {
      status: 0,
      stdout: 'AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_0"',
    })).toContain('expected unix:path=/run/user/1000/at-spi/bus_110');
  });
});

describe('busBelongsToDisplay', () => {
  it('accepts a bus named for its own display', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_110', ':110')).toBe(true);
  });

  it('REJECTS the host bus — the exact leak measured on the first live run', () => {
    // A desktop provisioned at :110 came back bound to bus_0 because the daemon
    // inherited DISPLAY=:0. Well-formed address, completely wrong session.
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_0', ':110')).toBe(false);
  });

  it('rejects any other display\'s bus, not just :0', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_111', ':110')).toBe(false);
  });

  it('accepts an address carrying no display suffix rather than disabling accessibility', () => {
    expect(busBelongsToDisplay('unix:abstract=/tmp/dbus-Ab12', ':110')).toBe(true);
  });

  it('refuses a malformed display instead of guessing', () => {
    expect(busBelongsToDisplay('unix:path=/run/user/1000/at-spi/bus_110', 'not-a-display')).toBe(false);
  });
});

describe('A11Y_APP_ENV', () => {
  it('is re-exported here so the provisioner has one import for the whole recipe', () => {
    expect(A11Y_APP_ENV.GTK_A11Y).toBe('atspi');
  });
});
