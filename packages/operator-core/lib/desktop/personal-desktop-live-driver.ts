// personal-cloud-desktop-2026-10-06 P-006 live driver (WI-10006781).
// Drives a person's desktop on a real KasmVNC host through the PRODUCTION relay path: tickets
// minted by the real HostedWorkspaceConnectorGateway, sockets to the real broker (:3880, public
// Host), hosted-session-host on the VM. VM-side observations over the controller's IAP SSH as the
// customer account (vmssh.sh). Writes one JSON with the five live assertions:
//   personal-desktop-uid (R-6) · -home (R-17) · -takeover-input (R-18) · -reconnect (R-19)
//   · -non-owner-refused (R-20)
// usage: npx tsx p006-live.mts  (env: ORG CWS HOST INST PROJECT ZONE OUT [RUN_ID])
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { withHostedServiceContext } from '@papercusp/db-org';
import {
  HostedWorkspaceConnectorGateway,
  PostgresHostedWorkspaceConnectorStore,
} from '../endpoint-route/hosted-workspace-connector';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} required`); return v; };
const ORG = env('ORG'), CWS = env('CWS'), HOST = env('HOST'), INST = env('INST'), PROJECT = env('PROJECT'), ZONE = env('ZONE'), OUT = env('OUT');
const RUN = process.env.RUN_ID ?? `p006-${Date.now().toString(36)}`;
const OWNER = `pcd-owner-${RUN}`, OTHER = `pcd-member-${RUN}`;
const BROKER = process.env.BROKER ?? 'ws://127.0.0.1:3880/api/hosted/connectors/socket';
const gateway = new HostedWorkspaceConnectorGateway(new PostgresHostedWorkspaceConnectorStore(withHostedServiceContext));
const log: string[] = [];
const say = (...a: unknown[]) => { const l = `${new Date().toISOString()} ${a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`; log.push(l); console.log(l); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function vm(cmd: string): string {
  const out = execFileSync('bash', [new URL('./personal-desktop-live-ssh.sh', import.meta.url).pathname, INST, PROJECT, ZONE, cmd], { encoding: 'utf8', timeout: 120_000 });
  say('VM$', cmd.slice(0, 160), '=>', out.trim().slice(0, 600));
  return out.trim();
}

/** The active connector row's generation. The PG store re-reads the active row on
 *  issue, but the ticket request type requires generation + state up front. */
async function activeGeneration(): Promise<number> {
  const rows = await withHostedServiceContext(async (sql) => sql<{ generation: number }[]>`
    SELECT generation FROM papercusp_auth.hosted_workspace_connectors
     WHERE control_workspace_id = 'papercusp-workspace' AND organization_id = ${ORG}
       AND customer_workspace_id = ${CWS} AND host_id = ${HOST} AND route_label = ${HOST}
       AND state = 'active'
     LIMIT 1`);
  const row = rows[0];
  if (!row) throw new Error('no active connector binding');
  return row.generation;
}

async function ticket(userId: string, label: string): Promise<string> {
  const issued = await gateway.issueSessionTicket({
    controlPlaneWorkspaceId: 'papercusp-workspace', organizationId: ORG, customerWorkspaceId: CWS, hostId: HOST,
    routeLabel: HOST, transport: 'websocket', userId, hostedSessionId: `${RUN}-${label}`, audience: 'workspace-operator',
    generation: await activeGeneration(), state: 'active',
  });
  if (!issued) throw new Error('no active connector binding');
  return issued.ticket;
}

type Msg = Record<string, any>;
/** One relay socket with an inbox the steps await on. */
class Relay {
  socket: WebSocket; inbox: Msg[] = []; bytes = Buffer.alloc(0); closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(url: string, readonly label: string) {
    this.socket = new WebSocket(url, { headers: { host: 'app.papercusp.com' } });
    this.socket.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      if (m.type === 'desktop.data') this.bytes = Buffer.concat([this.bytes, Buffer.from(m.data, 'base64')]);
      else if (m.type !== 'pty.output') { say('RECV', label, JSON.stringify(m).slice(0, 500)); this.inbox.push(m); }
      this.wake();
    });
    this.socket.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; say('CLOSE', label, code, reason.toString()); this.wake(); });
    this.socket.on('error', (e) => say('ERROR', label, String(e)));
  }
  private wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  async until<T>(probe: () => T | undefined, ms = 60_000, what = 'condition'): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = probe(); if (v !== undefined) return v;
      if (this.closed) throw new Error(`${this.label}: socket closed ${this.closed.code} ${this.closed.reason} while waiting for ${what}`);
      if (Date.now() > end) throw new Error(`${this.label}: timeout waiting for ${what}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 500); });
    }
  }
  msg(type: string, requestId?: string) { return this.until(() => this.inbox.find((m) => m.type === type && (!requestId || m.requestId === requestId)), 120_000, type); }
  send(m: Msg) { this.socket.send(JSON.stringify(m)); }
  sendBytes(b: Buffer) { this.send({ type: 'desktop.data', data: b.toString('base64') }); }
  async take(n: number): Promise<Buffer> { await this.until(() => (this.bytes.length >= n ? true : undefined), 30_000, `${n} rfb bytes`); const b = this.bytes.subarray(0, n); this.bytes = this.bytes.subarray(n); return b; }
  close() { this.socket.close(1000, 'p006 done'); }
}

async function sessionSocket(userId: string, label: string) {
  const url = new URL(BROKER); url.searchParams.set('ticket', await ticket(userId, label));
  const r = new Relay(url.toString(), label); await r.msg('session.bound'); return r;
}
async function desktopSocket(userId: string, label: string, id: string, mode: 'takeover' | 'watch') {
  const url = new URL(BROKER); url.searchParams.set('ticket', await ticket(userId, label));
  url.searchParams.set('kind', 'desktop'); url.searchParams.set('desktopSessionId', id); url.searchParams.set('desktopMode', mode);
  return new Relay(url.toString(), label);
}

/** Minimal RFB 3.8 client (security None) — keys only: KasmVNC's PointerEvent is non-standard. */
async function rfbHandshake(r: Relay) {
  const greeting = (await r.take(12)).toString('latin1');
  r.sendBytes(Buffer.from('RFB 003.008\n', 'latin1'));
  const n = (await r.take(1))[0]!;
  const types = [...(await r.take(n))];
  if (!types.includes(1)) throw new Error(`no None security type: ${types}`);
  r.sendBytes(Buffer.from([1]));
  const result = (await r.take(4)).readUInt32BE(0);
  if (result !== 0) throw new Error(`security result ${result}`);
  r.sendBytes(Buffer.from([1]));
  const head = await r.take(24);
  const name = (await r.take(head.readUInt32BE(20))).toString('utf8');
  return { greeting: greeting.trim(), securityTypes: types, width: head.readUInt16BE(0), height: head.readUInt16BE(2), name };
}
function key(r: Relay, keysym: number, down: boolean) {
  const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4); r.sendBytes(b);
}

const assertions: Record<string, { passed: boolean; [k: string]: unknown }> = {};
export async function runPersonalDesktopLive() {
  const startedAt = new Date().toISOString();
  say('RUN', RUN, 'host', HOST, 'owner', OWNER, 'other', OTHER);
  // The host's runtime_release as the control plane records it (workspace_hosts.runtime_release).
  const runtime = process.env.RUNTIME ?? 'unrecorded';

  // 1. The owner starts THEIR desktop over the production relay.
  const owner = await sessionSocket(OWNER, 'owner-session');
  owner.send({ type: 'desktop.start', requestId: 'pcd-start', personal: true });
  const started = await owner.until(() => owner.inbox.find((m) => m.requestId === 'pcd-start'), 240_000, 'desktop.start answer');
  if (started.type !== 'desktop.start.result') throw new Error(`personal start refused: ${JSON.stringify(started)}`);
  const desktop = started.desktop as Msg; const id = String(desktop.desktopSessionId);
  say('PERSONAL_DESKTOP', desktop);

  // 2. R-6 uid + R-17 home, read on the VM as the customer account.
  const probe = (tag: string) => vm(
    `set -e; acct=$(id -u papercusp-workspace); x=$(pgrep -u papercusp-workspace -n -f '[X]vnc|[X]kasmvnc' || true); ` +
    `s=$(pgrep -u papercusp-workspace -n -x xfce4-session || true); ` +
    `echo "${tag} acct_uid=$acct xvnc_pid=$x xvnc_uid=$( [ -n "$x" ] && ps -o uid= -p $x | tr -d ' ') session_pid=$s"; ` +
    `[ -n "$s" ] && tr '\\0' '\\n' < /proc/$s/environ | grep -E '^(HOME|DISPLAY|XAUTHORITY|USER)=' | sed "s/^/${tag} env_/"; true`);
  const p1 = probe('P1');
  const kv = (text: string, k: string) => (text.match(new RegExp(`${k}=(\\S+)`)) ?? [])[1];
  const acctUid = kv(p1, 'acct_uid'), xvncPid = kv(p1, 'xvnc_pid'), xvncUid = kv(p1, 'xvnc_uid');
  const home = kv(p1, 'env_HOME'), display = kv(p1, 'env_DISPLAY'), xauth = kv(p1, 'env_XAUTHORITY');
  assertions['personal-desktop-uid'] = { passed: !!xvncPid && xvncUid === acctUid, bar: 'R-6', xvncPid, xvncUid, customerAccountUid: acctUid };
  const listing = home ? vm(`ls -1 ${home}/workspaces | head -20`) : '';
  assertions['personal-desktop-home'] = { passed: home === '/home/papercusp-workspace' && listing.length > 0, bar: 'R-17', home, workspaceCheckouts: listing.split('\n') };

  // 3. R-18: Take control through the hosted-session-host dial; Ctrl+Alt+T must open a window.
  const xenv = `DISPLAY=${display} ${xauth ? `XAUTHORITY=${xauth}` : ''}`;
  const windows = () => vm(`${xenv} xdotool search --onlyvisible --name '.' 2>/dev/null | while read w; do echo "$w $(${xenv} xdotool getwindowname $w 2>/dev/null)"; done | sort`).split('\n').filter(Boolean);
  const viewer = await desktopSocket(OWNER, 'owner-takeover-1', id, 'takeover');
  const ready = await viewer.msg('desktop.ready');
  const rfb = await rfbHandshake(viewer);
  say('RFB', rfb);
  const before = windows();
  for (const [k, d] of [[0xffe3, 1], [0xffe9, 1], [0x74, 1], [0x74, 0], [0xffe9, 0], [0xffe3, 0]] as const) { key(viewer, k, d === 1); await sleep(80); }
  await sleep(5000);
  const after = windows();
  const opened = after.filter((w) => !before.includes(w));
  assertions['personal-desktop-takeover-input'] = { passed: ready.inputAllowed === true && opened.length > 0, bar: 'R-18', ready: { action: ready.action, inputAllowed: ready.inputAllowed }, rfb, keys: 'Ctrl+Alt+T', windowsBefore: before, windowsAfter: after, opened };

  // 4. R-19: close the viewer, reopen it; same desktop session id and Xvnc pid.
  viewer.close(); await sleep(6000);
  const viewer2 = await desktopSocket(OWNER, 'owner-takeover-2', id, 'takeover');
  const ready2 = await viewer2.msg('desktop.ready');
  const rfb2 = await rfbHandshake(viewer2);
  const p2 = probe('P2');
  const ownerRosterRequestId = `pcd-roster-owner-${RUN}-${randomUUID()}`;
  owner.send({ type: 'desktop.roster', requestId: ownerRosterRequestId });
  const roster = await owner.msg('desktop.roster.result', ownerRosterRequestId);
  const ownerRosterReceivedAt = new Date().toISOString();
  const ownerDesktops = (roster.desktops as Msg[] ?? []).filter((d) => d.scope === 'user' && d.owner === OWNER);
  const ownerDesktopAfter = ownerDesktops.length === 1 ? ownerDesktops[0] : undefined;
  const desktopSessionIdAfterObserved = typeof ownerDesktopAfter?.desktopSessionId === 'string'
    ? ownerDesktopAfter.desktopSessionId
    : undefined;
  const rosterStillLists = desktopSessionIdAfterObserved !== undefined;
  const reconnectIdentityMatches = desktopSessionIdAfterObserved === id;
  assertions['personal-desktop-reconnect'] = {
    passed: !!xvncPid && kv(p2, 'xvnc_pid') === xvncPid && roster.requestId === ownerRosterRequestId && reconnectIdentityMatches && ready2.inputAllowed === true && rfb2.greeting.startsWith('RFB'),
    bar: 'R-19',
    desktopSessionIdBefore: id,
    desktopSessionIdAfter: desktopSessionIdAfterObserved ?? null,
    desktopSessionIdAfterObserved: desktopSessionIdAfterObserved ?? null,
    desktopSessionIdAfterObservedProvenance: {
      source: 'owner-session desktop.roster.result',
      requestId: ownerRosterRequestId,
      observedAt: ownerRosterReceivedAt,
      independentlyMeasured: desktopSessionIdAfterObserved !== undefined,
    },
    rosterStillLists,
    ownerRosterEntryCount: ownerDesktops.length,
    xvncPidBefore: xvncPid,
    xvncPidAfter: kv(p2, 'xvnc_pid'),
    reopenedReady: { action: ready2.action, inputAllowed: ready2.inputAllowed },
    rfbAfter: rfb2.greeting,
  };
  viewer2.close();

  // 5. R-20: a second member identity opens the person's desktop (both roles) and lists it.
  const refusals: Msg[] = [];
  for (const mode of ['takeover', 'watch'] as const) {
    const intruder = await desktopSocket(OTHER, `other-${mode}`, id, mode);
    await intruder.until(() => intruder.closed ?? intruder.inbox.find((m) => /closed|error|refus/.test(String(m.type))), 60_000, 'refusal');
    await sleep(1500);
    refusals.push({ mode, messages: intruder.inbox, close: intruder.closed, rfbBytes: intruder.bytes.length });
    if (!intruder.closed) intruder.close();
  }
  const other = await sessionSocket(OTHER, 'other-session');
  other.send({ type: 'desktop.roster', requestId: 'pcd-roster-other' });
  const otherRoster = await other.msg('desktop.roster.result', 'pcd-roster-other');
  const hiddenFromOther = !(otherRoster.desktops as Msg[] ?? []).some((d) => d.desktopSessionId === id);
  const named = refusals.every((r) => JSON.stringify(r).includes('desktop_not_owner') && r.rfbBytes === 0);
  assertions['personal-desktop-non-owner-refused'] = { passed: named && hiddenFromOther, bar: 'R-20', refusals, hiddenFromOtherRoster: hiddenFromOther };
  other.close(); owner.close();

  const passed = Object.values(assertions).every((a) => a.passed);
  writeFileSync(OUT, `${JSON.stringify({
    schemaVersion: 1, plan: 'personal-cloud-desktop-2026-10-06', item: 'P-006', workItem: 'WI-10006781', evidencePlane: 'live', framework: 'shell', layer: 'operational',
    run: RUN, startedAt, finishedAt: new Date().toISOString(), host: { hostId: HOST, instance: INST, project: PROJECT, zone: ZONE, organizationId: ORG, customerWorkspaceId: CWS, runtime },
    relay: { broker: BROKER, publicHost: 'app.papercusp.com', identities: { owner: OWNER, secondMember: OTHER }, ticketIssuer: 'HostedWorkspaceConnectorGateway.issueSessionTicket (production control-plane gateway; synthetic probe-org identities, no browser sign-in)' },
    desktop, passed, assertions, transcript: log,
  }, null, 2)}\n`);
  say(passed ? 'P006_LIVE_PASS' : 'P006_LIVE_FAIL', Object.fromEntries(Object.entries(assertions).map(([k, v]) => [k, v.passed])));
  return { passed, assertions, transcript: log };
}
