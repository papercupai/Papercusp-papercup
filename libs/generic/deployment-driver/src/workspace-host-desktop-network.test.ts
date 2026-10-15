/** Real kernel network-namespace proof, kept separate from pure desktop-pack rendering.
 * Both files remain in the package test suite; copy-out rendering mutations need no sudo.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { buildWorkspaceDesktopEgressRules } from './workspace-host-desktop-pack';

describe('desktop network identity boundary on the kernel', () => {
  const canIsolate = process.platform === 'linux' && spawnSync('sudo', ['-n', 'unshare', '-n', '/bin/true'], { timeout: 5000, stdio: 'ignore' }).status === 0;
  it.skipIf(!canIsolate)('kernel blocks desktop-to-operator traffic but preserves viewer replies and DNS', () => {
    // Every interface, listener and firewall rule lives in a disposable NETWORK namespace.
    const probe = spawnSync('sudo', ['-n', 'unshare', '-n', 'python3', '-c', `
import sys, subprocess, socket, multiprocessing, os, time, json
rules = sys.stdin.read()
subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
def server(host, port, uid, ready):
    if uid:
        os.setgroups([]); os.setgid(uid); os.setuid(uid)
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port)); s.listen(); ready.set()
    while True:
        c, _ = s.accept()
        with c: c.sendall(b'ok')
def read(host, port, uid=0):
    code = 'import socket; s=socket.create_connection((' + repr(host) + ',' + str(port) + '),2); assert s.recv(2)==b"ok"'
    return subprocess.run([sys.executable, '-c', code], user=uid, group=uid, extra_groups=[], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4).returncode == 0
children=[]
try:
    for host,port,uid in [('127.0.0.1',3070,0),('127.0.0.1',7110,65534),('127.0.0.53',53,0)]:
        ready=multiprocessing.Event(); p=multiprocessing.Process(target=server,args=(host,port,uid,ready)); p.start(); children.append(p)
        assert ready.wait(3)
    assert read('127.0.0.1',3070,65534), 'positive control before firewall'
    for _ in range(2): subprocess.run(['nft','-f','-'],input=rules,text=True,check=True)
    result={'operatorBlocked':not read('127.0.0.1',3070,65534),'operatorUnaffected':read('127.0.0.1',3070),'viewerReply':read('127.0.0.1',7110),'dns':read('127.0.0.53',53,65534)}
    print(json.dumps(result)); assert all(result.values())
finally:
    for p in children: p.terminate(); p.join()
`], { input: buildWorkspaceDesktopEgressRules(65534), encoding: 'utf8', timeout: 25_000 });
    expect(probe.status, probe.stderr + probe.stdout).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ operatorBlocked: true, operatorUnaffected: true, viewerReply: true, dns: true });
  }, 30_000);
});
