# Live-drilling psu process-free parking: the parked-host checks (R-4)
URL: /internal/docs/agent-insights/psu-parked-host-drill-checks

A read-only code:run that drills every currently parked psu host: CLI gone, host and socket up, no surviving CLI-tree process, presence still wakeable, plus the build pin. Includes two positive controls. It cannot be a saved recipe because capability:bash is authority-opaque.

# Live-drilling psu process-free parking: the parked-host checks (R-4)

Plan `psu-process-free-parking-2026-10-06` parks an idle psu agent by stopping its CLI process while the psu host keeps running. Acceptance criterion R-4 was graded on a live drill (WI-10006544, and the whole-tree drill on WI-10006516). This page makes those checks reproducible against **whatever is parked right now**, with no new session to launch (WI-10006607 item 5).

## What a passing parked host looks like

For every `~/.papercusp/psu-pty/<ownerId>.json` meta with `parked: true` whose `pid` is a live psu host:

1. **CLI gone**: `ptyPid` is null.
2. **Host and socket up**: the pid is alive and the `sock` path is a Unix socket.
3. **No surviving CLI tree**: no process outside the host's own ancestor chain still carries `PAPERCUSP_SID=<ownerId>` in its environment.
4. **Still a live presence**: `coord:presence { owner }` reports `sessionState` `parked` (or `live`), never `ended` and never absent.

## Three traps the script avoids

* **Host identity.** The PTY host runs *in-process* inside `apps/operator/scripts/psu-launcher.mjs`. A check that looks for a separate `psu-pty-host.mjs` process misreads every parked host as dead. Use the canonical test `pidLooksLikePsuHost`, which matches `/psu-(launcher|pty-host)/` (psu-pty-host.mjs).
* **A zero needs a positive control.** "No stray SID holder" is only a finding if the scan can see SID holders at all. The script therefore requires that every *unparked* live host's CLI pid appears in the SID scan. It also requires that `/proc` is the host PID namespace (thousands of pids, pid 1 = systemd). If either control fails, it returns no verdict instead of a false PASS.
* **Build pin.** Record which code the hosts run: the launcher checkout's HEAD, the `psu-pty-host.mjs` blob, and the `/api/health` sha of :3070 and :3170.

## Why this is a page and not a saved recipe

`code:run` never captures a script that calls `capability:bash`: `recipe-authority-derive.ts` lists it in `OPAQUE_TOOLS`, so the script's authority is `unresolved` and capture is skipped. The skip is silent; EI-25235402640132306 tracks reporting it. The `/proc` whole-tree scan needs a shell, so paste the script below into `code:run` instead.

```js
const NODE = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execFileSync } from 'node:child_process';
const DIR = path.join(os.homedir(), '.papercusp', 'psu-pty');
const HOST_RE = /psu-(launcher|pty-host)/;
const stat = (pid) => { try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); const r = s.slice(s.lastIndexOf(')') + 2).split(' '); return { comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), ppid: Number(r[1]) }; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const argv = (pid) => { try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean); } catch { return null; } };
const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
const control = { pidsVisible: pids.length, pid1: stat(1)?.comm ?? null };
const sid = new Map();
for (const pid of pids) { try { const e = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').find((x) => x.startsWith('PAPERCUSP_SID=')); if (e) { const k = e.slice(14); if (!sid.has(k)) sid.set(k, []); sid.get(k).push(pid); } } catch {} }
const chain = (pid) => { const out = []; let p = pid; for (let i = 0; i < 64 && p > 1; i++) { const st = stat(p); if (!st) break; out.push(p); p = st.ppid; } return out; };
const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const pinCache = new Map();
const pinFor = (dir) => { if (pinCache.has(dir)) return pinCache.get(dir); const host = path.join(dir, 'psu-pty-host.mjs'); const top = git(dir, ['rev-parse', '--show-toplevel']); const pin = (top ? git(top, ['rev-parse', '--short=10', 'HEAD']) : '?') + '/' + (top && fs.existsSync(host) ? (git(top, ['hash-object', host]) ?? '?').slice(0, 12) : '?') + ' ' + (top ?? '').split('/').pop(); pinCache.set(dir, pin); return pin; };
const hosts = []; let notHost = 0; let metas = 0; let unparkedLive = 0; let cliSeen = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  let m; try { m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!m || typeof m.ownerId !== 'string' || typeof m.pid !== 'number') continue;
  metas++;
  const a = argv(m.pid);
  const isHost = alive(m.pid) && !!a && HOST_RE.test(a.join(' '));
  if (m.parked !== true) {
    if (isHost && m.ptyPid && alive(m.ptyPid)) { unparkedLive++; if ((sid.get(m.ownerId) ?? []).includes(m.ptyPid)) cliSeen++; }
    continue;
  }
  if (!isHost) { notHost++; continue; }
  const anc = new Set(chain(m.pid));
  const stray = (sid.get(m.ownerId) ?? []).filter((p) => !anc.has(p)).map((p) => ({ pid: p, comm: stat(p)?.comm ?? null, ppid: stat(p)?.ppid ?? null }));
  let sockOk = false; try { sockOk = fs.statSync(m.sock).isSocket(); } catch {}
  const script = a.find((x) => HOST_RE.test(x) && x.endsWith('.mjs')) ?? null;
  hosts.push({ ownerId: m.ownerId, cliGone: m.ptyPid == null, sockOk, stray, build: script ? pinFor(path.dirname(script)) : null });
}
control.sidScan = { unparkedLiveHosts: unparkedLive, cliPidsFoundBySidScan: cliSeen };
console.log(JSON.stringify({ control, metas, notHost, hosts }));
`;
const cmd = "node --input-type=module <<'PSUDRILL'\n" + NODE + "\nPSUDRILL\necho; for p in 3070 3170; do printf 'HEALTH %s ' $p; curl -s -m 3 127.0.0.1:$p/api/health | head -c 300; echo; done";
const r = await tools.capability.bash({ command: cmd, timeout: 40000 });
const text = r.output ?? '';
const line = text.split('\n').find((l) => l.startsWith('{"control"'));
if (!line) return { verdict: 'NO-SCAN', head: text.slice(0, 800) };
const scan = JSON.parse(line);
const health = text.split('\n').filter((l) => l.startsWith('HEALTH ')).map((l) => { const [, port, ...rest] = l.split(' '); let sha = null; try { sha = JSON.parse(rest.join(' ')).sha ?? null; } catch {} return port + '=' + sha; });
const c = scan.control;
const blind = c.pidsVisible < 50 || c.pid1 !== 'systemd';
const sidControlOk = c.sidScan.unparkedLiveHosts > 0 && c.sidScan.cliPidsFoundBySidScan === c.sidScan.unparkedLiveHosts;
const hosts = [];
await Promise.all(scan.hosts.map(async (h) => {
  let state = 'presence-error';
  try { const p = await tools.coord.presence({ owner: h.ownerId, projection: { pick: ['agents[].sessionState', 'agents[].ownerId'] } }); state = (p.agents ?? []).find((x) => x.ownerId === h.ownerId)?.sessionState ?? 'absent'; } catch {}
  hosts.push({ o: h.ownerId, cliGone: h.cliGone, sockOk: h.sockOk, stray: h.stray, sessionState: state, build: h.build, pass: h.cliGone && h.sockOk && h.stray.length === 0 && (state === 'live' || state === 'parked') });
}));
const failing = hosts.filter((h) => !h.pass);
const verdict = blind ? 'INSTRUMENT-BLIND' : !sidControlOk ? 'SID-SCAN-UNPROVEN' : hosts.length === 0 ? 'NO-LIVE-PARKED-HOSTS' : failing.length ? 'FAIL' : 'PASS';
return { verdict, at: new Date().toISOString(), control: c, metasRead: scan.metas, parkedButNoLiveHost: scan.notHost, drilled: hosts.length, passed: hosts.length - failing.length, failing, builds: [...new Set(hosts.map((h) => h.build))], health };
```

Run it with `code:run { timeoutSec: 45, script }`. `NO-LIVE-PARKED-HOSTS` is an honest answer when nothing is idle. To force a park on a fresh session, launch psu with a short `PAPERCUSP_PSU_PARK_IDLE_MS` (as P-018 did) and run the script once the `[psu] Agent parked` notice appears.

## Recorded run: 2026-10-06 13:01Z

* Controls: 8,570 pids visible, pid 1 = systemd; SID scan found 149 of 149 unparked live CLI pids.
* Build pin: every parked host ran launcher checkout `papercusp` @ `728748a085`, `psu-pty-host.mjs` blob `b727a09998ec`; :3070 `d740fc3802`, :3170 `ae13664ea3`.
* 18 parked hosts drilled. All 18 had the CLI gone, the socket up and no stray tree. 17 read `parked` in presence.
* FAIL, 1 host: `su-03bf1ef0`, a headless `--resume --fork` session, is **absent** from `coord:presence`, not ended. Its session brief has `source=''`. That points at a launch-time registration gap rather than parking (WI-10006674).

## Related guards

`apps/operator/lib/psu-park.integration.test.ts` grades the same properties in the tree plane. The `(parked-presence)` case keeps `findLiveHostFor` returning a parked host. The `(WI-10006607)` case kills a nohup'd grandchild the CLI orphaned: it has left the CLI's ppid tree but stays in its process group. Both were mutation-probed (`caught`).
