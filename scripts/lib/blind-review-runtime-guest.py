"""Trusted disposable guest supervisor, entered only through runtime-exec.

Every resource belongs to the surrounding finite managed scope and private
mount/network/PID namespaces. The host rechecks canonical custody before each
creation and acknowledges durable recording before the guest can continue.
Product children inherit neither management/source FDs nor their metadata.
"""
import hashlib
import json
import os
import re
import select
import socket
import stat
import subprocess
import time
import uuid

NODE = '/source/apps/operator/dist-verify/runtime/node'
DRIVER = '/source/apps/operator/dist-verify/runtime/driver/dist/cli.js'
KINDS = {'process', 'listener', 'display', 'database', 'workspace', 'profile', 'channel', 'credential'}
MAX_FRAME = 16384


def require(value, code):
    if not value:
        raise ValueError(code)


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def validate_config(config):
    require(isinstance(config, dict) and set(config) == {'version', 'seed', 'resources'} and
            type(config['version']) is int and config['version'] == 1, 'config_invalid')
    seed = config['seed']
    require(isinstance(seed, dict) and set(seed) == {'version', 'workspace', 'actors', 'fixtures'} and
            type(seed['version']) is int and seed['version'] == 1 and seed['actors'] == [] and
            seed['fixtures'] == ['ready'], 'seed_invalid')
    workspace = seed['workspace']
    require(isinstance(workspace, dict) and set(workspace) == {'id', 'slug', 'name'} and
            valid_uuid(workspace['id']) and isinstance(workspace['slug'], str) and
            re.fullmatch('review-[a-f0-9]{24}', workspace['slug']) and
            workspace['name'] == 'Disposable review', 'seed_workspace_invalid')
    resources = config['resources']
    require(isinstance(resources, list) and len(resources) == len(KINDS), 'inventory_invalid')
    by_kind = {}
    for row in resources:
        require(isinstance(row, dict) and set(row) == {'id', 'kind', 'ownershipTag'} and
                valid_uuid(row['id']) and row['kind'] in KINDS and row['kind'] not in by_kind and
                isinstance(row['ownershipTag'], str) and re.fullmatch('[a-f0-9]{64}', row['ownershipTag']),
                'inventory_invalid')
        by_kind[row['kind']] = row
    require(len({row['id'] for row in resources}) == len(KINDS), 'inventory_invalid')
    return seed, by_kind


class Control:
    def __init__(self, fd=5):
        self.socket = socket.socket(fileno=fd)
        require(self.socket.family == socket.AF_UNIX and self.socket.type == socket.SOCK_STREAM and
                self.socket.getsockname() in ('', b'') and self.socket.getpeername() in ('', b''),
                'inherited_control_socket_required')
        self.socket.settimeout(30)
        self.buffer = b''
        self.sequence = 0

    def read(self):
        while b'\n' not in self.buffer:
            require(len(self.buffer) <= MAX_FRAME, 'control_frame_too_large')
            block = self.socket.recv(4096)
            require(block, 'control_closed')
            self.buffer += block
        line, self.buffer = self.buffer.split(b'\n', 1)
        require(0 < len(line) <= MAX_FRAME, 'control_frame_too_large')
        return json.loads(line)

    def request(self, kind, resource=None, identity=None):
        self.sequence += 1
        frame = {'type': kind, 'seq': self.sequence}
        if resource is not None:
            frame['intentId'] = resource['id']
        if identity is not None:
            frame['identity'] = identity
        encoded = json.dumps(frame, separators=(',', ':')).encode()
        require(len(encoded) <= MAX_FRAME, 'control_frame_too_large')
        self.socket.sendall(encoded + b'\n')
        require(self.read() == {'ok': True, 'seq': self.sequence}, 'control_authorization_refused')


def product_environment(seed):
    # Construct from literals and host-generated seed only; never inherit env.
    return {'PATH': '/source/apps/operator/dist-verify/runtime:/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'HOME': '/tmp/home', 'TMPDIR': '/tmp', 'XDG_RUNTIME_DIR': '/tmp/run',
            'XDG_DATA_HOME': '/tmp/profile/data', 'XDG_CACHE_HOME': '/tmp/profile/cache',
            'XDG_CONFIG_HOME': '/tmp/profile/config', 'DISPLAY': ':99',
            'XDG_SESSION_TYPE': 'x11', 'GDK_BACKEND': 'x11', 'LIBGL_ALWAYS_SOFTWARE': '1',
            'WEBKIT_DISABLE_COMPOSITING_MODE': '1', 'MALLOC_ARENA_MAX': '2',
            'PAPERCUSP_HOME': '/tmp/state', 'PAPERCUSP_WORKSPACES_ROOT': '/tmp/workspaces',
            'PAPERCUSP_WORKSPACE': seed['workspace']['id'], 'PAPERCUSP_WORKSPACE_ID': seed['workspace']['id'],
            'PAPERCUSP_HONO_PORT': '3070', 'PAPERCUSP_BIND_HOST': '127.0.0.1',
            'PAPERCUSP_OPERATOR_URL': 'http://127.0.0.1:3070', 'PAPERCUSP_OPERATOR_BASE': 'http://127.0.0.1:3070',
            'OPERATOR_SPA_DIST': '/source/apps/operator/dist-verify/spa', 'PAPERCUSP_DEV_SOURCE_ROOT': '/source',
            'PAPERCUSP_BACKGROUND_WORKERS': '0', 'PAPERCUSP_DISABLE_BACKGROUND_TASKS': '1',
            'PAPERCUSP_PROVISION_ENV_OPERATORS': '0', 'PAPERCUSP_CLUSTER': '0',
            'PAPERCUSP_CLUSTER_WORKERS': '0', 'PAPERCUSP_NATIVE_TERMINAL': '0',
            'PAPERCUSP_SKIP_PG_DISCOVERY': '1', 'PAPERCUSP_VERIFY_TAURI_ISOLATED': '1',
            'GH_CONFIG_DIR': '/tmp/profile/gh', 'KOPIA_BACKUP_LOCK_PATH': '/tmp/backup/lock',
            'KOPIA_BACKUP_STATE_DIR': '/tmp/backup/state', 'PAPERCUSP_PSU_PTY_DIR': '/tmp/state/pty',
            'PAPERCUSP_SU_CODEX_HOMES_DIR': '/tmp/state/codex'}


def ticks(pid):
    with open('/proc/' + str(pid) + '/stat', encoding='ascii') as source:
        line = source.read()
    return line[line.rfind(')') + 1:].split()[19]


def boot(control):
    seed, resources = validate_config(control.read())
    # The source descriptor has served its purpose. The retained RO /source
    # mount is sufficient. No source/control metadata enters product children.
    os.close(3)
    os.set_inheritable(control.socket.fileno(), False)
    os.umask(0o077)
    env = product_environment(seed)
    children = []
    stage = 'workspace'

    def before(kind):
        nonlocal stage
        stage = kind
        control.request('before', resources[kind])

    def record(kind, identity):
        control.request('created', resources[kind], identity)

    def start(kind, argv, *, child_env=None, cwd='/source'):
        before(kind)
        log = open('/tmp/logs/' + str(len(children)) + '.log', 'xb')
        try:
            child = subprocess.Popen(argv, env=child_env or env, cwd=cwd, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, close_fds=True)
        finally:
            log.close()
        children.append(child)
        return child

    def run(argv, *, timeout=30, input=None):
        result = subprocess.run(argv, env=env, cwd='/source', input=input, capture_output=True,
                                text=True, close_fds=True, timeout=timeout)
        require(result.returncode == 0, 'guest_command_failed')
        return result.stdout

    def wait_for(predicate, seconds=30):
        deadline = time.monotonic() + seconds
        while not predicate():
            require(all(child.poll() is None for child in children), 'guest_service_exited')
            require(time.monotonic() < deadline, 'guest_service_not_ready')
            # A closed host channel immediately fences all remaining creation.
            if select.select([control.socket], [], [], 0)[0]:
                require(control.socket.recv(1, socket.MSG_PEEK), 'control_closed')
            time.sleep(.05)

    try:
        before('workspace')
        os.mkdir('/tmp/logs', 0o700)
        os.mkdir('/tmp/workspaces', 0o700)
        os.mkdir('/tmp/workspaces/' + seed['workspace']['id'], 0o700)
        with open('/tmp/workspaces/registry.json', 'x', encoding='utf8') as output:
            json.dump({'current': seed['workspace']['id'], 'workspaces': [{
                'id': seed['workspace']['id'], 'name': seed['workspace']['name'],
                'createdAt': int(time.time() * 1000)}]}, output)
        record('workspace', {'path': '/tmp/workspaces', 'workspaceId': seed['workspace']['id']})
        before('profile')
        for path in ['/tmp/profile', '/tmp/profile/data', '/tmp/profile/cache', '/tmp/profile/config', '/tmp/profile/gh']:
            os.mkdir(path, 0o700)
        record('profile', {'path': '/tmp/profile'})
        before('credential')
        os.mkdir('/tmp/state', 0o700)
        token = os.urandom(32).hex()
        with open('/tmp/state/superuser-token', 'x', encoding='ascii') as output:
            output.write(token + '\n')
        record('credential', {'path': '/tmp/state/superuser-token',
                              'sha256': hashlib.sha256(token.encode()).hexdigest()})
        before('database')
        pg_bin = next((f'/usr/lib/postgresql/{major}/bin/' for major in range(30, 13, -1)
                       if os.path.isfile(f'/usr/lib/postgresql/{major}/bin/initdb')), None)
        require(pg_bin, 'guest_postgres_unavailable')
        run([pg_bin + 'initdb', '-D', '/tmp/pg', '-U', 'postgres', '-A', 'trust',
             '-E', 'UTF8', '--locale=C', '--no-sync'])
        postgres = start('database', [pg_bin + 'postgres', '-D', '/tmp/pg', '-p', '5432',
            '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'logging_collector=off',
            '-c', 'wal_level=logical', '-c', 'max_replication_slots=10', '-c', 'max_wal_senders=10'])
        def sql_ready():
            result = subprocess.run([pg_bin + 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-At',
                                     '-c', 'SELECT 1'], env=env, capture_output=True, timeout=5, close_fds=True)
            return result.returncode == 0 and result.stdout.strip() == b'1'
        wait_for(sql_ready)
        run([pg_bin + 'createdb', '-h', '127.0.0.1', '-U', 'postgres', 'papercusp'])
        # Use the maintained product migration/role/publication code, with fresh
        # credentials generated inside this namespace. No live DB seed/import.
        role_keys = {name: os.urandom(32).hex() for name in ('owner', 'app', 'admin', 'zero')}
        migration = """
import postgres from '/source/node_modules/postgres/src/index.js';
import {applyPendingMigrations,roleBootstrapSql,ensureZeroHarnessPublication}
 from '/source/libs/papercusp/packages/embedded-postgres-server/src/index.js';
const keys=JSON.parse(process.env.BROKER_PRIVATE_ROLE_KEYS);
const sql=postgres('postgresql://postgres@127.0.0.1:5432/papercusp',{max:1});
try {
 await sql.unsafe(roleBootstrapSql(keys));
 await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;');
 const result=await applyPendingMigrations({client:sql,sqlDir:'/source/libs/papercusp/libs/db/sql',continueOnError:false});
 if(result.failed.length) throw Error('private_migration_failed');
 await ensureZeroHarnessPublication(sql);
} finally {await sql.end({timeout:5});}
"""
        migrate_env = {**env, 'BROKER_PRIVATE_ROLE_KEYS': json.dumps(role_keys)}
        before('database')
        migrated = subprocess.run([NODE, '--input-type=module', '-e', migration], env=migrate_env,
                                  capture_output=True, timeout=180, close_fds=True)
        require(migrated.returncode == 0, 'guest_migration_failed')
        env['HARNESS_ADMIN_DATABASE_URL'] = 'postgresql://harness_admin:' + role_keys['admin'] + '@127.0.0.1:5432/papercusp'
        env['HARNESS_DATABASE_URL'] = 'postgresql://harness_app:' + role_keys['app'] + '@127.0.0.1:5432/papercusp'
        system_id = run([pg_bin + 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-At', '-d', 'papercusp',
                         '-c', 'SELECT system_identifier FROM pg_control_system()']).strip()
        require(system_id.isdecimal(), 'guest_database_identity_invalid')
        record('database', {'path': '/tmp/pg', 'pid': str(postgres.pid), 'startTicks': ticks(postgres.pid),
                            'systemIdentifier': system_id, 'port': '5432'})
        display = start('display', ['/usr/bin/Xvfb', ':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'])
        wait_for(lambda: os.path.exists('/tmp/.X11-unix/X99'))
        record('display', {'pid': str(display.pid), 'startTicks': ticks(display.pid), 'display': ':99'})
        # D-Bus stays in the same scope; its private unix socket is never bound
        # into the host. GTK children receive only this private bus address.
        bus = start('process', ['/usr/bin/dbus-daemon', '--session', '--nofork',
                               '--address=unix:path=/tmp/run/bus'])
        wait_for(lambda: os.path.exists('/tmp/run/bus'))
        env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/tmp/run/bus'
        before('listener')
        host = start('process', [NODE, '/source/apps/operator/dist-verify/hono-host.mjs'], cwd='/source/apps/operator')
        health_script = """
const base='http://127.0.0.1:3070';
try {
 const h=await fetch(base+'/api/health',{signal:AbortSignal.timeout(2000)});
 const p=await fetch(base+'/',{signal:AbortSignal.timeout(2000)});
 if(h.status!==200 || p.status!==200 || !(await p.text()).includes('<html')) process.exit(1);
} catch {process.exit(1);}
"""
        wait_for(lambda: subprocess.run([NODE, '--input-type=module', '-e', health_script], env=env,
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, close_fds=True).returncode == 0, 60)
        record('listener', {'host': '127.0.0.1', 'port': '3070', 'pid': str(host.pid),
                            'networkNamespace': os.readlink('/proc/self/ns/net')})
        # Apply the maintained ready fixture through product routes and reread.
        before('workspace')
        ready = """
const base='http://127.0.0.1:3070';
const opts={headers:{'content-type':'application/json'},signal:AbortSignal.timeout(30000)};
const provision=await fetch(base+'/api/agent-mcp/provision',{...opts,method:'POST',body:'{}'});
const principal=await provision.json();
if(!provision.ok || !principal.provisioned?.some(p=>p.name==='operator')) throw Error('principal_missing');
const url=base+'/api/desktop/setup-wizard-state';
const patch=await fetch(url,{...opts,method:'PATCH',body:JSON.stringify({finished_at:new Date().toISOString()})});
const read=await fetch(url,{signal:AbortSignal.timeout(30000)});
if(!patch.ok || !read.ok || typeof (await read.json()).finished_at!=='string') throw Error('seed_not_applied');
"""
        run([NODE, '--input-type=module', '-e', ready], timeout=95)
        before('channel')
        tauri = start('process', ['/source/apps/operator/dist-verify/native/papercusp-desktop'], cwd='/source/papercusp-desktop')
        bridge_token = '/tmp/tauri-dev-bridge-' + str(tauri.pid) + '.token'
        wait_for(lambda: os.path.isfile(bridge_token), 45)
        require(stat.S_IMODE(os.stat(bridge_token).st_mode) == 0o600, 'guest_bridge_token_mode_invalid')
        run([NODE, DRIVER, 'page-state', '--pid', str(tauri.pid), '--json'], timeout=10)
        record('process', {'hostPid': str(host.pid), 'hostStartTicks': ticks(host.pid),
                           'tauriPid': str(tauri.pid), 'tauriStartTicks': ticks(tauri.pid), 'busPid': str(bus.pid)})
        record('channel', {'path': bridge_token, 'pid': str(tauri.pid), 'startTicks': ticks(tauri.pid)})
        control.request('ready')
        control.socket.settimeout(None)
        while True:
            readable, _, _ = select.select([control.socket], [], [], 1)
            require(all(child.poll() is None for child in children), 'guest_service_exited')
            if readable:
                require(control.read() == {'type': 'stop'}, 'guest_control_command_invalid')
                return
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = str(error)
        if not re.fullmatch('[a-z_]{1,100}', code):
            code = 'guest_operation_failed'
        try:
            control.socket.sendall(json.dumps({'type': 'failed', 'seq': control.sequence + 1,
                                              'stage': stage, 'code': code}).encode() + b'\n')
        except OSError:
            pass
        raise
    finally:
        # Child handles are our unreaped Popen instances, never caller PIDs.
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 3
        for child in reversed(children):
            try:
                child.wait(timeout=max(.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)


if __name__ == '__main__':
    try:
        boot(Control())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # No source/product log or private credential crosses the failure path.
        print('RUNTIME_GUEST_REFUSED', file=__import__('sys').stderr)
        raise SystemExit(3)
