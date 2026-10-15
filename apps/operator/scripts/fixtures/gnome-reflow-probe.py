"""Isolated GNOME/VTE reflow probe; never joins the desktop bus or settings.

Run with /usr/bin/python3. The parent owns Xvfb and a private bus with NO service
activation directories (desktop portals otherwise delay renderer registration).
Only the child touches GSettings, in a temporary keyfile backend. JSON on stdout
is measurement evidence; startup errors are failures, never empty samples.
"""
import argparse
import ctypes as C
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time


BUS_CONFIG = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>
<policy context="default"><allow send_destination="*" eavesdrop="true"/>
<allow eavesdrop="true"/><allow own="*"/></policy></busconfig>"""


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


class Data(C.Union):
    _fields_ = [('b', C.c_char * 20), ('s', C.c_short * 10), ('l', C.c_long * 5)]


class Message(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
               ('display', C.c_void_p), ('window', C.c_ulong),
               ('message_type', C.c_ulong), ('format', C.c_int), ('data', Data)]


class Event(C.Union):
    _fields_ = [('xclient', Message), ('pad', C.c_long * 24)]


class X11:
    def __init__(self):
        self.wm = subprocess.Popen(['openbox', '--sm-disable'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        start = time.monotonic()
        while time.monotonic() - start < 3:
            r = subprocess.run(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'],
                               capture_output=True, text=True, timeout=1)
            if 'window id #' in r.stdout:
                break
            if self.wm.poll() is not None:
                raise RuntimeError('private window manager exited before readiness')
            time.sleep(.05)
        else:
            stop(self.wm)
            raise RuntimeError('private window manager did not register')
        self.x = C.CDLL('libX11.so.6')
        for name, rest, args in [
            ('XOpenDisplay', C.c_void_p, [C.c_char_p]),
            ('XDefaultRootWindow', C.c_ulong, [C.c_void_p]),
            ('XInternAtom', C.c_ulong, [C.c_void_p, C.c_char_p, C.c_int]),
            ('XPending', C.c_int, [C.c_void_p]),
            ('XNextEvent', C.c_int, [C.c_void_p, C.POINTER(Event)]),
            ('XSendEvent', C.c_int, [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)]),
            ('XFlush', C.c_int, [C.c_void_p]),
            ('XSelectInput', C.c_int, [C.c_void_p, C.c_ulong, C.c_long]),
            ('XResizeWindow', C.c_int, [C.c_void_p, C.c_ulong, C.c_uint, C.c_uint]),
            ('XConnectionNumber', C.c_int, [C.c_void_p]),
            ('XCloseDisplay', C.c_int, [C.c_void_p]),
        ]:
            f = getattr(self.x, name)
            f.restype, f.argtypes = rest, args
        self.d = self.x.XOpenDisplay(None)
        if not self.d:
            raise RuntimeError('private X display did not open')
        self.root = self.x.XDefaultRootWindow(self.d)
        self.protocol = self.x.XInternAtom(self.d, b'WM_PROTOCOLS', 0)
        self.ping = self.x.XInternAtom(self.d, b'_NET_WM_PING', 0)
        # Observe replies without taking SubstructureRedirect away from the WM.
        self.x.XSelectInput(self.d, self.root, 1 << 19)
        self.x.XFlush(self.d)
        self.token = 0

    def measure(self, wid):
        self.token += 1
        e = Event()
        e.xclient.type, e.xclient.display = 33, self.d
        e.xclient.window, e.xclient.message_type, e.xclient.format = wid, self.protocol, 32
        e.xclient.data.l[0], e.xclient.data.l[1], e.xclient.data.l[2] = self.ping, self.token, wid
        start = time.monotonic()
        self.x.XSendEvent(self.d, wid, 0, 0, C.byref(e))
        self.x.XFlush(self.d)
        while time.monotonic() - start < 10:
            while self.x.XPending(self.d):
                z = Event()
                self.x.XNextEvent(self.d, C.byref(z))
                if (z.xclient.type == 33 and z.xclient.message_type == self.protocol
                        and z.xclient.data.l[0] == self.ping
                        and z.xclient.data.l[1] == self.token
                        and z.xclient.data.l[2] == wid):
                    return round((time.monotonic() - start) * 1000, 3)
            select.select([self.x.XConnectionNumber(self.d)], [], [], .001)
        raise RuntimeError('renderer did not answer matching _NET_WM_PING within 10s')

    def resize(self, wid, width):
        self.x.XResizeWindow(self.d, wid, width, 450)
        self.x.XFlush(self.d)


def window(title, client):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if client.poll() is not None:
            try:
                _, errors = client.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                errors = 'client exited but a descendant kept its stderr open'
            raise RuntimeError('terminal client exited before readiness: ' + errors)
        r = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', title], capture_output=True, text=True, timeout=2)
        if r.returncode == 0:
            return int(r.stdout.strip().splitlines()[-1])
        time.sleep(.05)
    raise RuntimeError('terminal never reached output sentinel: ' + title)


def run_child(args):
    from gi.repository import Gio, GLib
    x = X11()
    try:
        for unlimited in [False, True]:
            ident = '1be264d5-cf8b-4bbe-a9ef-000000000001'
            profiles = Gio.Settings.new('org.gnome.Terminal.ProfilesList')
            profiles.set_strv('list', [ident])
            profiles.set_string('default', ident)
            p = Gio.Settings.new_with_path('org.gnome.Terminal.Legacy.Profile',
                                          '/org/gnome/terminal/legacy/profiles:/:' + ident + '/')
            p.set_string('visible-name', 'Isolated Reflow Probe')
            p.set_boolean('scrollback-unlimited', True if args.prepare_profile_module else unlimited)
            p.set_int('scrollback-lines', args.limit)
            Gio.Settings.sync()
            profile_uuid = ident
            prepared = None
            if args.prepare_profile_module:
                program = "const m=await import(process.argv[1]);console.log(JSON.stringify(await m.prepareGnomeTerminal({bin:'gnome-terminal',args:['--wait','--']})));"
                result = subprocess.run(['node', '--input-type=module', '-e', program, args.prepare_profile_module],
                                        capture_output=True, text=True, timeout=20)
                if result.returncode != 0:
                    raise RuntimeError('real launcher preparation failed: ' + result.stderr[-4000:])
                prepared = json.loads(result.stdout)
                flags = [flag for flag in prepared['args'] if flag.startswith('--profile=')]
                if len(flags) != 1:
                    raise RuntimeError('real launcher preparation did not select bounded profile')
                if not unlimited:
                    profile_uuid = flags[0].split('=', 1)[1]
            app = 'org.gnome.Terminal.Reflow' + str(os.getpid()) + ('Unlimited' if unlimited else 'Finite')
            server = subprocess.Popen(['/usr/libexec/gnome-terminal-server', '--app-id', app],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            clients = []
            independent_servers = []
            try:
                bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                start, ready = time.monotonic(), False
                while time.monotonic() - start < 10:
                    ready = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                          'org.freedesktop.DBus', 'NameHasOwner',
                                          GLib.Variant('(s)', (app,)), GLib.VariantType.new('(b)'),
                                          Gio.DBusCallFlags.NONE, 500, None).unpack()[0]
                    if ready:
                        break
                    if server.poll() is not None:
                        raise RuntimeError('renderer exited: ' + server.stderr.read())
                    time.sleep(.05)
                if not ready:
                    raise RuntimeError('renderer did not register on private bus within 10s')

                def launch(script, independent=False):
                    # Ubuntu's Python wrapper also starts a server for --app-id.
                    # Here the fixture already owns the server; call its client.
                    binary = '/usr/bin/gnome-terminal.real' if Path('/usr/bin/gnome-terminal.real').exists() else 'gnome-terminal'
                    prefix = ([binary, '--app-id', app, '--profile', profile_uuid, '--wait'] if not independent
                              else ['gnome-terminal', *prepared['args'][:-1]])
                    client = subprocess.Popen([*prefix,
                                               '--geometry=100x25', '--', '/usr/bin/python3', '-u', '-c', script],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                    clients.append(client)
                    return client

                writer = "import os,tty;tty.setraw(0)\nline=(''.join('\\x1b[38;5;'+str(i+30)+'mabcdefghij' for i in range(15))+'\\x1b[0m\\r\\n').encode()\n"
                writer += "for _ in range(" + str(args.lines // 1000) + "):os.write(1,line*1000)\n"
                writer += "os.write(1,b'\\x1b]0;REFLOW_LOADED\\x07');seq=0\nwhile True:\n b=os.read(0,1)\n if b==b'?':\n  seq+=1;os.write(1,('\\x1b]0;REFLOW_COLS_'+str(seq)+'_'+str(os.get_terminal_size(0).columns)+'\\x07').encode())\n else:os.write(1,b)"
                big = window('REFLOW_LOADED', launch(writer))
                independent = args.isolate_sibling and prepared and '--disable-factory' in prepared['args']
                sibling_client = launch("import os,tty;tty.setraw(0);os.write(1,b'\\x1b]0;REFLOW_SIBLING\\x07')\nwhile True:\n b=os.read(0,1);os.write(1,b)", independent)
                sibling = window('REFLOW_SIBLING', sibling_client)
                sibling_pid = int(subprocess.run(['xprop', '-id', str(sibling), '_NET_WM_PID'],
                                  check=True, capture_output=True, text=True, timeout=2).stdout.split('=')[1])
                if independent:
                    # The native wrapper owns this server. Verify custody before
                    # recording its PID for teardown; never signal a peer process.
                    parent = int(Path('/proc/' + str(sibling_pid) + '/stat').read_text().rsplit(')', 1)[1].split()[1])
                    if parent != sibling_client.pid:
                        raise RuntimeError('independent renderer is not a child of the owned native wrapper')
                    independent_servers.append(sibling_pid)
                history_bytes = 0
                for fd in Path('/proc/' + str(server.pid) + '/fd').iterdir():
                    try:
                        target = os.readlink(fd)
                        info = fd.stat()
                        # The maintained test runner puts TMPDIR on /dev/shm;
                        # VTE follows that same setting instead of always /tmp.
                        tmp_root = str(Path(tempfile.gettempdir()).resolve()) + '/'
                        if stat.S_ISREG(info.st_mode) and target.startswith(tmp_root):
                            history_bytes += info.st_size
                    except FileNotFoundError:
                        pass
                baseline = [x.measure(sibling) for _ in range(5)]
                query_seq = 0
                def fresh_columns():
                    nonlocal query_seq
                    query_seq += 1
                    subprocess.run(['xdotool', 'windowfocus', str(big)], check=True, timeout=2)
                    subprocess.run(['xdotool', 'type', '--window', str(big), '?'], check=True, timeout=2)
                    prefix = 'REFLOW_COLS_' + str(query_seq) + '_'
                    end = time.monotonic() + 2
                    while time.monotonic() < end:
                        title = subprocess.run(['xdotool', 'getwindowname', str(big)],
                                               check=True, capture_output=True, text=True, timeout=2).stdout.strip()
                        if title.startswith(prefix):
                            return title, int(title.rsplit('_', 1)[1])
                        time.sleep(.01)
                    raise RuntimeError('child did not acknowledge geometry request generation')
                _, previous_columns = fresh_columns()
                previous_width = int(subprocess.run(['xdotool', 'getwindowgeometry', '--shell', str(big)],
                                     check=True, capture_output=True, text=True, timeout=2).stdout.split('WIDTH=')[1].splitlines()[0])
                resize = []
                columns = []
                geometry = []
                for width in [500, 1100, 600, 1100]:
                    x.resize(big, width)
                    samples = []
                    for _ in range(50):
                        samples.append(x.measure(sibling))
                        time.sleep(.005)
                    resize.append(max(samples))
                    end = time.monotonic() + 2
                    while time.monotonic() < end:
                        title, current_columns = fresh_columns()
                        if ((width > previous_width and current_columns > previous_columns)
                                or (width < previous_width and current_columns < previous_columns)):
                            break
                        time.sleep(.01)
                    else:
                        raise RuntimeError('visible resize did not converge with the child PTY geometry')
                    columns.append(title)
                    dimensions = subprocess.run(['xdotool', 'getwindowgeometry', '--shell', str(big)],
                                                check=True, capture_output=True, text=True, timeout=2).stdout.strip()
                    geometry.append(dimensions)
                    previous_width = int(dimensions.split('WIDTH=')[1].splitlines()[0])
                    previous_columns = current_columns
                print(json.dumps({'unlimited': unlimited, 'server_pid': server.pid,
                                  'sibling_server_pid': sibling_pid, 'independent_sibling': bool(independent),
                                  'lines': args.lines, 'limit': args.limit,
                                  'profile_uuid': profile_uuid,
                                  'default_profile_uuid': profiles.get_string('default'),
                                  'default_still_unlimited': p.get_boolean('scrollback-unlimited'),
                                  'font_preserved': p.get_value('font').equal(Gio.Settings.new_with_path('org.gnome.Terminal.Legacy.Profile', '/org/gnome/terminal/legacy/profiles:/:' + profile_uuid + '/').get_value('font')),
                                  'history_bytes': history_bytes,
                                  'columns_after_resize': columns, 'geometry_after_resize': geometry,
                                  'baseline_ping_ms': baseline,
                                  'sibling_ping_after_resize_ms': resize}), flush=True)
            finally:
                for pid in independent_servers:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                stop(server)
                server.stderr.close()
                for client in clients:
                    stop(client)
                    client.stderr.close()
    finally:
        x.x.XCloseDisplay(x.d)
        stop(x.wm)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lines', type=int, default=600000)
    parser.add_argument('--limit', type=int, default=10000)
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--prepare-profile-module')
    parser.add_argument('--isolate-sibling', action='store_true')
    args = parser.parse_args()
    if args.lines < 1000 or args.lines % 1000 or args.limit < 1:
        parser.error('lines must be a positive multiple of 1000 and limit positive')
    if args.child:
        run_child(args)
        return
    with tempfile.TemporaryDirectory(prefix='gnome-reflow-') as td:
        config = Path(td) / 'bus.conf'
        config.write_text(BUS_CONFIG)
        runtime = Path(td) / 'runtime'
        runtime.mkdir(mode=0o700)
        env = dict(os.environ, XDG_CONFIG_HOME=td, GSETTINGS_BACKEND='keyfile',
                   XDG_RUNTIME_DIR=str(runtime),
                   GDK_BACKEND='x11', GTK_USE_PORTAL='0', GIO_USE_VFS='local', NO_AT_BRIDGE='1')
        for key in ['WAYLAND_DISPLAY', 'GNOME_TERMINAL_SCREEN', 'GNOME_TERMINAL_SERVICE', 'DBUS_SESSION_BUS_ADDRESS']:
            env.pop(key, None)
        child_args = ['xvfb-run', '-a', 'dbus-run-session', '--config-file=' + str(config),
                                  '--', '/usr/bin/python3', str(Path(__file__).resolve()), '--child',
                                  '--lines=' + str(args.lines), '--limit=' + str(args.limit)]
        if args.prepare_profile_module:
            child_args.extend(['--prepare-profile-module', args.prepare_profile_module])
        if args.isolate_sibling:
            child_args.append('--isolate-sibling')
        child = subprocess.Popen(child_args,
                                 env=env, start_new_session=True)
        def interrupted(signum, _frame):
            raise SystemExit(128 + signum)
        previous = signal.signal(signal.SIGTERM, interrupted)
        try:
            code = child.wait(timeout=150)
        finally:
            signal.signal(signal.SIGTERM, previous)
            # Signal ONLY the session created here, including on a caller timeout.
            # Never kill by emulator name or by a potentially reused display number.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
        if code:
            raise SystemExit(code)


if __name__ == '__main__':
    main()
