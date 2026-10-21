/**
 * psu-pty-discovery.test.ts — the operator's read side of the psu-hosted
 * managed-pty control socket (turn-lifecycle-control Phase 3, P-014).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  utimesSync,
  promises as fsPromises,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { qualifyHooksObservationAck } from './psu-pty-discovery';

describe('hook observation capability gate', () => {
  it('accepts only exact generation-bound viewport evidence after confirmed cleanup', () => {
    const request = { ownerId: 'su-observe', expectedAdvSessionId: '42', expectedNativeSessionId: 'native',
      expectedHostStartedAt: 100, expectedChildGeneration: 3, expectedHostCodeVersion: 'sha' };
    const receipt = { ok: true, inputReleased: true, identity: { ownerId: 'su-observe', advSessionId: '42',
      nativeSessionId: 'native', hostStartedAt: 100, childGeneration: 3, hostCodeVersion: 'sha' },
      coverage: { scope: 'fresh-hook-browser-viewport', complete: false }, visibleRows: ['Hooks'] };
    expect(qualifyHooksObservationAck(request, receipt)).toBe(true);
    expect(qualifyHooksObservationAck(request, { ok: true })).toBe(false);
    expect(qualifyHooksObservationAck(request, { ...receipt, inputReleased: false })).toBe(false);
    expect(qualifyHooksObservationAck(request, { ...receipt, coverage: { ...receipt.coverage, complete: true } })).toBe(false);
    expect(qualifyHooksObservationAck(request, { ...receipt, identity: { ...receipt.identity, childGeneration: 4 } })).toBe(false);
  });
  it('never opens a socket for an old, absent, or unqualified host', async () => {
    const connect = vi.spyOn(net, 'createConnection');
    try {
      expect(await injectIntoHostWithConfirmation('/tmp/never-hook-observation.sock', {
        mode: 'hooks-observe', data: '', observationVersion: 1,
        ownerId: `su-missing-observation-${process.pid}`, expectedNativeSessionId: 'native',
        expectedAdvSessionId: '42', expectedHostStartedAt: 1, expectedChildGeneration: 1,
        expectedHostCodeVersion: 'host-sha',
      })).toMatchObject({ ok: false, reason: 'observation-capability-or-custody-unavailable' });
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
});
import {
  findLiveHost,
  findLiveHostAsync,
  hostSupports,
  hostIsAgentLaunched,
  hostCodeVersionMatches,
  shutdownViaPty,
  latestRespawnNativeId,
  latestRespawnNativeSession,
  latestRespawnNativeSessionAsync,
  hostStartedAt,
  hostStartedAtAsync,
  mcpReconnectViaPty,
  injectIntoHost,
  injectIntoHostWithConfirmation,
  interruptViaPty,
  recolorViaPty,
  pidIsPsuHost,
  selfCompactionAvailability,
  pruneDeadDiscoveryFilesAsync,
  sanitizeKey,
  sockOwnerIdFromPath,
  auditInjectOwnerBinding,
  _flushInjectAuditForTest,
  rotateInjectAuditIfFull,
  PSU_PTY_DIR,
  MAX_CONTROL_PAYLOAD_BYTES,
  type PsuPtyHost,
} from './psu-pty-discovery';

// WI-2339 defect #2: findLiveHost/listLiveHosts now cross-check that the recorded pid is
// actually a psu session host (pidIsPsuHost). Tests below write `process.pid` (the vitest
// runner — cmdline has no psu marker) as a live-host STAND-IN, so they inject a trivial
// verifyIdentity to isolate the socket/pid-alive behavior from the identity gate (which
// has its own focused tests). ID_OK == "treat the stand-in pid as a valid host".
const ID_OK = { verifyIdentity: () => true } as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'psu-pty-disc-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A live unix-socket server in `dir` for `ownerId`; resolves the bytes it
 *  receives. Returns the socket path. */
function startSocket(dir: string, ownerId: string): { sock: string; received: Promise<string> } {
  const sock = join(dir, `${sanitizeKey(ownerId)}.sock`);
  let resolveRecv!: (s: string) => void;
  const received = new Promise<string>((r) => (resolveRecv = r));
  const server = net.createServer((conn) => {
    const chunks: Buffer[] = [];
    conn.on('data', (d) => chunks.push(d));
    conn.on('end', () => resolveRecv(Buffer.concat(chunks).toString('utf8')));
  });
  server.listen(sock);
  cleanups.push(() => server.close());
  return { sock, received };
}

function writeMeta(dir: string, ownerId: string, meta: Record<string, unknown>): void {
  writeFileSync(join(dir, `${sanitizeKey(ownerId)}.json`), JSON.stringify({ ownerId, ...meta }));
}

describe('findLiveHost', () => {
  it('returns null when no discovery file exists', () => {
    expect(findLiveHost('su-nope', tmpDir())).toBeNull();
  });

  it('returns null for a dead host pid (file lingered after a crash)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-dead');
    // pid 2^31-1 is ~never a live process.
    writeMeta(dir, 'su-dead', { pid: 2147483646, ptyPid: 2147483645, sock, command: 'x', startedAt: 1 });
    expect(findLiveHost('su-dead', dir)).toBeNull();
  });

  it('returns null when the host pid is alive but the socket file is gone', () => {
    const dir = tmpDir();
    writeMeta(dir, 'su-nosock', {
      pid: process.pid,
      ptyPid: process.pid,
      sock: join(dir, 'su-nosock.sock'), // never created
      command: 'x',
      startedAt: 1,
    });
    expect(findLiveHost('su-nosock', dir)).toBeNull();
  });

  it('returns the host when pid is alive AND the socket exists AND identity verifies', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-live');
    writeMeta(dir, 'su-live', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 });
    const h = findLiveHost('su-live', dir, ID_OK);
    expect(h).not.toBeNull();
    expect(h!.sock).toBe(sock);
    expect(h!.ownerId).toBe('su-live');
  });

  it('WI-2339 defect #2: rejects a pid-alive + socket-live host whose pid is NOT a psu process (recycled-pid false positive)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-reused');
    // A genuinely alive pid + bound socket + matching ownerId — ONLY the identity
    // gate can reject it. verifyIdentity:()=>false simulates "pid's cmdline has no
    // psu-launcher/psu-pty-host marker" (an unrelated process on a recycled pid).
    writeMeta(dir, 'su-reused', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 });
    expect(findLiveHost('su-reused', dir, { verifyIdentity: () => false })).toBeNull();
    // and with the DEFAULT verifier on Linux, the vitest process.pid (cmdline = node/vitest,
    // no psu marker) is likewise rejected — proving the real default gate is wired, not just the seam.
    if (existsSync('/proc')) expect(findLiveHost('su-reused', dir)).toBeNull();
  });

  it('EI-151: returns null when the recorded ownerId differs from the requested key (cross-owner misroute)', () => {
    // A live, otherwise-valid host file sitting at agent A's discovery path, but
    // RECORDED as agent B (a sanitizeKey collision or a stale-reuse during a
    // /loop re-host). Resolving it would inject A's wake / turn:interrupt into
    // B's live session — the EI-151 cross-agent misroute. Must be rejected.
    const dir = tmpDir();
    // Write the file at owner A's filename, but with content ownerId = B, and a
    // genuinely live pid + bound socket so ONLY the identity check can reject it.
    const sock = join(dir, `${sanitizeKey('su-A')}.sock`);
    const server = net.createServer();
    server.listen(sock);
    cleanups.push(() => server.close());
    writeFileSync(
      join(dir, `${sanitizeKey('su-A')}.json`),
      JSON.stringify({ ownerId: 'su-B', pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    expect(findLiveHost('su-A', dir)).toBeNull();
  });
});

describe('findLiveHostAsync', () => {
  it('returns the keyed host after async socket and identity validation', async () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-async-live');
    writeMeta(dir, 'su-async-live', {
      pid: process.pid,
      ptyPid: process.pid,
      sock,
      command: 'claude-su',
      startedAt: 1,
    });
    const verifyIdentity = vi.fn(async () => true);

    const host = await findLiveHostAsync('su-async-live', dir, { verifyIdentity });

    expect(host).toMatchObject({ ownerId: 'su-async-live', sock });
    expect(verifyIdentity).toHaveBeenCalledWith(process.pid);
  });

  it('rejects a sanitize-key collision even when the async liveness probe passes', async () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-async-owner-a');
    writeFileSync(
      join(dir, `${sanitizeKey('su-async-owner-a')}.json`),
      JSON.stringify({ ownerId: 'su-async-owner-b', pid: process.pid, sock }),
    );

    await expect(findLiveHostAsync('su-async-owner-a', dir, { verifyIdentity: async () => true })).resolves.toBeNull();
  });

  it('finds a live legacy host in the active workspace directory after the host-wide miss', async () => {
    const workspaceId = `pty-legacy-${process.pid}`;
    const workspaceRoot = tmpDir();
    const previous = {
      ptyDir: process.env.PAPERCUSP_PSU_PTY_DIR,
      workspace: process.env.PAPERCUSP_WORKSPACE_ID,
      workspacesRoot: process.env.PAPERCUSP_WORKSPACES_ROOT,
    };
    process.env.PAPERCUSP_PSU_PTY_DIR = '';
    process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaceRoot;
    try {
      const legacyDir = join(workspaceRoot, workspaceId, '.papercusp', 'psu-pty');
      mkdirSync(legacyDir, { recursive: true });
      const { sock } = startSocket(legacyDir, 'su-legacy-workspace-host');
      writeMeta(legacyDir, 'su-legacy-workspace-host', {
        pid: process.pid,
        ptyPid: process.pid,
        sock,
        command: 'claude-su',
        startedAt: 1,
      });

      await expect(findLiveHostAsync('su-legacy-workspace-host', PSU_PTY_DIR, {
        verifyIdentity: async () => true,
      })).resolves.toMatchObject({ ownerId: 'su-legacy-workspace-host', sock });
      expect(findLiveHost('su-legacy-workspace-host', PSU_PTY_DIR, ID_OK)).toMatchObject({
        ownerId: 'su-legacy-workspace-host',
        sock,
      });
    } finally {
      if (previous.ptyDir === undefined) delete process.env.PAPERCUSP_PSU_PTY_DIR;
      else process.env.PAPERCUSP_PSU_PTY_DIR = previous.ptyDir;
      if (previous.workspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = previous.workspace;
      if (previous.workspacesRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
      else process.env.PAPERCUSP_WORKSPACES_ROOT = previous.workspacesRoot;
    }
  });
});

describe('pidIsPsuHost (WI-2339 defect #2 — process-identity gate)', () => {
  // The DEFAULT reads /proc; these inject readCmdline to test the marker logic
  // deterministically. Marker strings mirror the REAL launcher cmdline verified
  // against ~15 live hosts on 2026-07-04 (post 50341).
  it('ACCEPTS the real psu-launcher.mjs cmdline (the empirical recorded-pid process)', () => {
    const cmd = 'node /home/x/papercupai-workspace/papercusp/apps/operator/scripts/psu-launcher.mjs --no-picker --agent=claude --role=sentinel';
    expect(pidIsPsuHost(1234, () => cmd)).toBe(true);
  });
  it('ACCEPTS a direct psu-pty-host.mjs cmdline too (marker covers both)', () => {
    expect(pidIsPsuHost(1234, () => 'node /x/apps/operator/scripts/psu-pty-host.mjs')).toBe(true);
  });
  it('REJECTS an unrelated process that inherited a recycled pid', () => {
    expect(pidIsPsuHost(1234, () => 'node /x/some-unrelated-server.mjs')).toBe(false);
    expect(pidIsPsuHost(1234, () => '/usr/bin/bash -c sleep 999')).toBe(false);
  });
  it('REJECTS an empty cmdline (zombie/defunct) on every platform — not a verifiable live host', () => {
    expect(pidIsPsuHost(1234, () => '')).toBe(false);
  });
  it('fail-open semantics for an unreadable cmdline: rejects on Linux (/proc present), trusts off-Linux', () => {
    // null = readFileSync threw (pid vanished, or no /proc at all). On the ship target
    // (Linux, /proc present) that's a reject; a non-Linux dev box cannot verify → trust.
    expect(pidIsPsuHost(1234, () => null)).toBe(!existsSync('/proc'));
  });
  it('rejects a falsy pid', () => {
    expect(pidIsPsuHost(0, () => 'node psu-launcher.mjs')).toBe(false);
  });
});

describe('pruneDeadDiscoveryFiles (WI-2510 — standing janitor hygiene sweep)', () => {
  it('returns 0 and does not throw when the discovery dir does not exist yet', async () => {
    expect(await pruneDeadDiscoveryFilesAsync(join(tmpdir(), `psu-pty-disc-absent-${process.pid}-${Math.floor(performance.now())}`))).toBe(0);
  });

  it('removes a dead host (pid gone) file + its (now-orphaned) socket path, leaves a live one alone', async () => {
    const dir = tmpDir();
    const { sock: liveSock } = startSocket(dir, 'su-live-keep');
    writeMeta(dir, 'su-live-keep', { pid: process.pid, ptyPid: process.pid, sock: liveSock, command: 'x', startedAt: 1 });
    const deadSock = join(dir, `${sanitizeKey('su-dead-gc')}.sock`);
    writeFileSync(deadSock, ''); // a leftover socket FILE (not listening) — pruned alongside its meta
    writeMeta(dir, 'su-dead-gc', { pid: 2147483646, ptyPid: 2147483645, sock: deadSock, command: 'x', startedAt: 1 });

    const pruned = await pruneDeadDiscoveryFilesAsync(dir, ID_OK);

    expect(pruned).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-dead-gc')}.json`))).toBe(false);
    expect(existsSync(deadSock)).toBe(false);
    expect(existsSync(join(dir, `${sanitizeKey('su-live-keep')}.json`))).toBe(true);
  });

  it('removes a corrupt/unreadable discovery file (can never resolve to a live host)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, `${sanitizeKey('su-corrupt')}.json`), '{ not: valid json');
    expect(await pruneDeadDiscoveryFilesAsync(dir)).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-corrupt')}.json`))).toBe(false);
  });

  it('WI-2339 parity: a pid-alive + socket-live file still gets pruned when identity verification fails (recycled pid)', async () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-recycled');
    writeMeta(dir, 'su-recycled', { pid: process.pid, ptyPid: process.pid, sock, command: 'x', startedAt: 1 });
    expect(await pruneDeadDiscoveryFilesAsync(dir, { verifyIdentity: () => false })).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-recycled')}.json`))).toBe(false);
  });

  it('never removes anything a live findLiveHost lookup would still return (consistency)', async () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-consistent');
    writeMeta(dir, 'su-consistent', { pid: process.pid, ptyPid: process.pid, sock, command: 'x', startedAt: 1 });
    expect(await pruneDeadDiscoveryFilesAsync(dir, ID_OK)).toBe(0);
    expect(findLiveHost('su-consistent', dir, ID_OK)).not.toBeNull();
  });

  it('WI-10004784: reaps abandoned <target>.<pid>.tmp staging files past the age gate, keeps fresh ones and the ledgers', async () => {
    const dir = tmpDir();
    const nowMs = Date.now();
    const staleMeta = join(dir, `${sanitizeKey('su-crashed')}.json.12345.tmp`);
    const staleTrim = join(dir, `${sanitizeKey('su-crashed')}.events.jsonl.12345.tmp`);
    const freshMeta = join(dir, `${sanitizeKey('su-writing')}.json.67890.tmp`);
    const oldLedger = join(dir, `${sanitizeKey('su-crashed')}.events.jsonl`);
    const notStaging = join(dir, 'notes.tmp'); // no <pid> segment — not the host's staging name
    for (const p of [staleMeta, staleTrim, freshMeta, oldLedger, notStaging]) writeFileSync(p, '{}');
    const twoHoursAgoSec = (nowMs - 2 * 60 * 60 * 1000) / 1000;
    for (const p of [staleMeta, staleTrim, oldLedger, notStaging]) utimesSync(p, twoHoursAgoSec, twoHoursAgoSec);

    expect(await pruneDeadDiscoveryFilesAsync(dir, { ...ID_OK, nowMs })).toBe(2);

    expect(existsSync(staleMeta)).toBe(false);
    expect(existsSync(staleTrim)).toBe(false);
    expect(existsSync(freshMeta)).toBe(true); // a writer may still be mid-rename
    expect(existsSync(oldLedger)).toBe(true); // the events-ingest routine owns ledger retention
    expect(existsSync(notStaging)).toBe(true);
  });
});

describe('injectIntoHost', () => {
  it('writes a v1 turn envelope the host receives', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-inj');
    const ok = await injectIntoHost(sock, { mode: 'turn', data: 'wake-text' });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'turn', data: 'wake-text' });
  });

  it('writes a v1 raw envelope (force interrupt = Ctrl-C, immediate)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-force');
    const ok = await injectIntoHost(sock, { mode: 'raw', data: '\x03' });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'raw', data: '\x03' });
  });

  it('writes a v1 osc envelope (recolor bytes for the terminal display)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-osc');
    const osc = '\x1b]11;#581c87\x07';
    const ok = await injectIntoHost(sock, { mode: 'osc', data: osc });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'osc', data: osc });
  });

  it('resolves false when the socket does not exist', async () => {
    const ok = await injectIntoHost(join(tmpDir(), 'absent.sock'), { mode: 'turn', data: 'x' }, 500);
    expect(ok).toBe(false);
  });

  it('carries an exact-limit UTF-8 envelope and rejects one byte over before connecting', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-max-utf8');
    const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ v: 1, mode: 'turn', data: '' }), 'utf8');
    const prefix = '🧭';
    const data = `${prefix}${'x'.repeat(
      MAX_CONTROL_PAYLOAD_BYTES - emptyEnvelopeBytes - Buffer.byteLength(prefix, 'utf8'),
    )}`;

    expect(await injectIntoHost(sock, { mode: 'turn', data }, 10_000)).toBe(true);
    expect(Buffer.byteLength(await received, 'utf8')).toBe(MAX_CONTROL_PAYLOAD_BYTES);

    // The oversized call must fail from the sender-side guard. An absent socket
    // makes accidental connect-before-check behavior fail this assertion too.
    expect(
      await injectIntoHost(join(dir, 'absent.sock'), { mode: 'turn', data: `${data}x` }, 10_000),
    ).toBe(false);
  }, 20_000);
});

/** A server mimicking the UPDATED psu-pty-host.mjs (EI-18676244363359331 /
 *  WI-5872): allowHalfOpen so it stays writable after the client's FIN, and it
 *  writes a `{v:1,ok,reason}` JSON-line ACK/NACK back before ending its own
 *  side — as opposed to `startSocket` above, which mimics the OLD/not-yet-
 *  upgraded host (bare close, no ack) for backward-compat coverage. */
function startAckingSocket(
  dir: string,
  ownerId: string,
  ack: { ok: boolean; reason: string } | 'malformed' | 'none',
): { sock: string; received: Promise<string> } {
  const sock = join(dir, `${sanitizeKey(ownerId)}.sock`);
  let resolveRecv!: (s: string) => void;
  const received = new Promise<string>((r) => (resolveRecv = r));
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const chunks: Buffer[] = [];
    conn.on('data', (d) => chunks.push(d));
    conn.on('end', () => {
      resolveRecv(Buffer.concat(chunks).toString('utf8'));
      if (ack !== 'none') {
        conn.write(ack === 'malformed' ? 'not-json\n' : `${JSON.stringify({ v: 1, ...ack })}\n`);
      }
      conn.end();
    });
  });
  server.listen(sock);
  cleanups.push(() => server.close());
  return { sock, received };
}

describe('injectIntoHost — application-level ACK (EI-18676244363359331 / WI-5872)', () => {
  it('resolves TRUE from an explicit {ok:true} ack — a real delivery confirmation, not just the close race', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'acker-ok', { ok: true, reason: 'delivered' });
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'x' })).toBe(true);
  });

  it('resolves FALSE from an explicit {ok:false} ack — the core fix: a real server-side drop (e.g. a busy-gate defer or a stale-fire guard) is no longer misreported as delivered just because the TCP connection closed cleanly', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'acker-drop', { ok: false, reason: 'deferred-busy-gate' });
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'x' })).toBe(false);
  });

  it('falls back to resolving TRUE on bare close when no ack ever arrives — backward compat with a NOT-YET-RESTARTED old host during a rolling upgrade', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'acker-none', 'none');
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'x' })).toBe(true);
  });

  it('falls back to resolving TRUE on close when the ack line is malformed — never throws, never hangs waiting on a bad parse', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'acker-bad', 'malformed');
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'x' })).toBe(true);
  });

  it('an OLD-style host (allowHalfOpen:false default, the exact pre-fix startSocket helper) still resolves true unchanged', async () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'acker-old');
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'x' })).toBe(true);
  });
});

describe('injectIntoHostWithConfirmation — WHY a true happened (WI-6862)', () => {
  it.each([
    { expectedStartedAt: 100, requireNativeTurnStart: true, expectedChildGeneration: 2,
      expectedHostStartedAt: 200, provenanceIssuedAtMs: 300 },
    { expectedStartedAt: 0, requireNativeTurnStart: false, expectedChildGeneration: 0,
      expectedHostStartedAt: 0, provenanceIssuedAtMs: 0 },
    {},
  ])('preserves optional native proof and generation fences on the real socket: %j', async fields => {
    const { sock, received } = startSocket(tmpDir(), 'native-fences');
    await injectIntoHostWithConfirmation(sock, { mode: 'turn', data: 'continue', ...fields });
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'turn', data: 'continue', ...fields });
  });

  it('reports an explicit {ok:true} ack as CONFIRMED by the host', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'conf-ok', { ok: true, reason: 'delivered' });
    expect(await injectIntoHostWithConfirmation(sock, { mode: 'reset', data: 'x' })).toEqual({
      ok: true,
      confirmation: 'acked',
      reason: 'delivered', // WI-6638: the host's own verdict now rides back
    });
  });

  // THE POINT OF THE WHOLE ITEM: this case and the one above are INDISTINGUISHABLE through the
  // boolean — both are ok:true — yet only one is a confirmed delivery. The bare close also
  // covers a host that crashed mid-delivery, which is exactly what a provider usage-limit wall
  // does to a respawn, so booking it as a clean 'delivered' is what made a reset that never
  // happened read back as a success (WI-6852's 02:58:02 reset).
  it('reports a BARE CLOSE as assumed, not confirmed — the same ok:true the ack path returns', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'conf-none', 'none');
    const res = await injectIntoHostWithConfirmation(sock, { mode: 'reset', data: 'x' });
    expect(res).toEqual({ ok: true, confirmation: 'assumed-close' });
    // The control that gives that assertion its meaning: the legacy boolean cannot tell the two
    // apart, which is precisely why the confirmation field had to exist.
    expect(res.ok).toBe(await injectIntoHost(sock, { mode: 'reset', data: 'x' }));
  });

  it('reports an explicit {ok:false} ack as a CONFIRMED refusal (a real server-side drop)', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'conf-drop', { ok: false, reason: 'deferred-busy-gate' });
    // WI-6638: an ack that carries a `reason` now surfaces it verbatim, so a caller
    // can tell WHICH refusal it was (a deliberate host verdict) apart from a
    // transport miss — the distinction session:end depends on.
    expect(await injectIntoHostWithConfirmation(sock, { mode: 'reset', data: 'x' })).toEqual({
      ok: false,
      confirmation: 'acked',
      reason: 'deferred-busy-gate',
    });
  });

  it('reports a malformed ack line as assumed-close (parse failure must never hang or throw)', async () => {
    const dir = tmpDir();
    const { sock } = startAckingSocket(dir, 'conf-bad', 'malformed');
    expect(await injectIntoHostWithConfirmation(sock, { mode: 'reset', data: 'x' })).toEqual({
      ok: true,
      confirmation: 'assumed-close',
    });
  });

  it('reports an absent socket as an error, never as an assumed success', async () => {
    const res = await injectIntoHostWithConfirmation(
      join(tmpDir(), 'absent.sock'),
      { mode: 'reset', data: 'x' },
      500,
    );
    expect(res.ok).toBe(false);
    expect(res.confirmation).toBe('error');
  });
});

describe('failed wake confirmation audit retention', () => {
  let auditPath: string;
  let previousAuditPath: string | undefined;

  beforeEach(() => {
    previousAuditPath = process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH;
    auditPath = join(tmpDir(), 'sender-audit.jsonl');
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH = auditPath;
  });

  afterEach(async () => {
    await _flushInjectAuditForTest();
    if (previousAuditPath === undefined) delete process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH;
    else process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH = previousAuditPath;
  });

  const failures = async (): Promise<Array<Record<string, unknown>>> => {
    await _flushInjectAuditForTest();
    return existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8').trim().split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((row) => row.kind === 'inject-host-failed')
      : [];
  };

  it('retains the host refusal after the same delivery succeeds on retry', async () => {
    const ownerId = `su-wake-audit-${process.pid}`;
    const msg = { mode: 'turn' as const, ownerId, deliveryId: 'test-wake-retained', data: 'private wake body' };
    const failed = startAckingSocket(tmpDir(), ownerId, { ok: false, reason: 'deferred-busy-gate' });
    expect(await injectIntoHostWithConfirmation(failed.sock, msg)).toEqual({
      ok: false, confirmation: 'acked', reason: 'deferred-busy-gate',
    });

    const recovered = startAckingSocket(tmpDir(), ownerId, { ok: true, reason: 'delivered' });
    expect(await injectIntoHostWithConfirmation(recovered.sock, msg)).toEqual({
      ok: true, confirmation: 'acked', reason: 'delivered',
    });
    expect(await failures()).toEqual([expect.objectContaining({
      ownerId, deliveryId: msg.deliveryId, mode: 'turn',
      confirmation: 'acked', reason: 'deferred-busy-gate', transportErrorCode: null,
    })]);
    expect(readFileSync(auditPath, 'utf8')).not.toContain(msg.data);
  });

  it('distinguishes a socket error from a host refusal without losing delivery identity', async () => {
    const ownerId = `su-wake-error-${process.pid}`;
    const msg = { mode: 'turn' as const, ownerId, deliveryId: 'test-wake-socket-error', data: 'private wake body' };
    const result = await injectIntoHostWithConfirmation(join(tmpDir(), `${ownerId}.sock`), msg, 500);
    expect(result).toEqual({ ok: false, confirmation: 'error' });
    expect(await failures()).toEqual([expect.objectContaining({
      ownerId, deliveryId: msg.deliveryId, confirmation: 'error',
      reason: null, transportErrorCode: 'ENOENT',
    })]);
  });

  it('preserves the transport verdict when its diagnostic file cannot be written', async () => {
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH = tmpDir();
    const ownerId = `su-wake-audit-fail-${process.pid}`;
    const result = await injectIntoHostWithConfirmation(join(tmpDir(), `${ownerId}.sock`), {
      mode: 'turn', ownerId, deliveryId: 'test-wake-unwritable-audit', data: 'x',
    }, 500);
    expect(result).toEqual({ ok: false, confirmation: 'error' });
  });

  it('retains a timeout when the socket accepts but the host never acknowledges', async () => {
    const ownerId = `su-wake-timeout-${process.pid}`;
    const sock = join(tmpDir(), `${ownerId}.sock`);
    const connections: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (conn) => {
      connections.push(conn);
      conn.on('data', () => {});
    });
    cleanups.push(() => {
      for (const conn of connections) conn.destroy();
      server.close();
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const result = await injectIntoHostWithConfirmation(sock, {
      mode: 'turn', ownerId, deliveryId: 'test-wake-timeout', data: 'x',
    }, 100);
    expect(result).toEqual({ ok: false, confirmation: 'timeout' });
    expect(await failures()).toEqual([expect.objectContaining({
      ownerId, deliveryId: 'test-wake-timeout', confirmation: 'timeout',
    })]);
  });

  it('retains an oversized wake rejection before attempting to connect', async () => {
    const ownerId = `su-wake-oversize-${process.pid}`;
    const result = await injectIntoHostWithConfirmation(join(tmpDir(), `${ownerId}.sock`), {
      mode: 'turn', ownerId, deliveryId: 'test-wake-oversize',
      data: 'x'.repeat(MAX_CONTROL_PAYLOAD_BYTES),
    });
    expect(result).toEqual({ ok: false, confirmation: 'oversize' });
    expect(await failures()).toEqual([expect.objectContaining({
      ownerId, deliveryId: 'test-wake-oversize', confirmation: 'oversize',
    })]);
  });
});

describe('recolorViaPty (fleet-color-schemes live recolor)', () => {
  // recolorViaPty reads the REAL PSU_PTY_DIR (no dir param), so set up a live host
  // there under a unique throwaway ownerId, then clean it up — mirrors interruptViaPty.
  it('injects an osc envelope into a live host; false when no host or empty osc', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-recolor-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    const osc = '\x1b]10;#f5e8ff\x07\x1b]11;#581c87\x07\x1b]12;#d8b4fe\x07';
    // no live host → false (recolor doesn't land; the bound scheme applies next window)
    expect(await recolorViaPty('su-no-such-owner-recolor', osc, ID_OK)).toBe(false);
    // empty osc → false (nothing to write) even with a live host
    expect(await recolorViaPty(ownerId, '', ID_OK)).toBe(false);
    // live host → injects the osc envelope (ID_OK: process.pid stands in for a real host)
    expect(await recolorViaPty(ownerId, osc, ID_OK)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(1);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'osc', data: osc, ownerId });
  });
});

describe('interruptViaPty (Phase 4 pty-force leg)', () => {
  // interruptViaPty reads the REAL PSU_PTY_DIR (no dir param), so set up a live
  // host there under a unique throwaway ownerId, then clean it up.
  it('injects a raw Ctrl-C / Esc into a live host; false when no host', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-force-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    // no live host → false (caller falls back to headless SIGINT)
    expect(await interruptViaPty('su-no-such-owner-xyz')).toBe(false);

    // sigint default = Ctrl-C, raw + immediate (ID_OK: process.pid stands in for a real host)
    expect(await interruptViaPty(ownerId, 'sigint', ID_OK)).toBe(true);
    // esc variant
    expect(await interruptViaPty(ownerId, 'esc', ID_OK)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(2);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'raw', data: '\x03', ownerId });
    expect(JSON.parse(recv[1])).toEqual({ v: 1, mode: 'raw', data: '\x1b', ownerId });
  });

  // EI-12460: interruptViaPty previously gave up on the FIRST socket-write miss —
  // no re-verification of the discovery record, unlike wake-executor's
  // injectPsuHostWakeWithReverify (WI-3683). This reproduces a stale socket that
  // dies mid-episode and a live host that rebinds its control socket to a new
  // path — the exact "bg-host freeze" class the ticket describes.
  it('re-verifies the discovery record and retries a rebound socket after a stale-socket miss', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-rebound-test-${process.pid}-${Math.floor(performance.now())}`;
    const key = sanitizeKey(ownerId);
    const staleSock = join(PSU_PTY_DIR, `${key}.sock`);
    const reboundSock = join(PSU_PTY_DIR, `${key}-rebound.sock`);
    const meta = join(PSU_PTY_DIR, `${key}.json`);
    const recv: string[] = [];

    // The stale socket PATH exists on disk (satisfies findLiveHost's existsSync
    // check) but has NOTHING listening — connecting to it fails immediately,
    // exactly like a wedged/dead control socket during a host freeze.
    writeFileSync(staleSock, '');
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock: staleSock, command: 'claude-su', startedAt: 1 }),
    );

    const reboundServer = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    cleanups.push(() => {
      reboundServer.close();
      for (const p of [staleSock, reboundSock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    // First attempt (against staleSock) is in flight — before it resolves, "rebind"
    // the host: point the discovery record at a socket that's actually listening.
    // interruptViaPty's retry re-reads the meta file fresh, so it picks this up.
    const firstAttempt = interruptViaPty(ownerId, 'sigint', ID_OK);
    await new Promise<void>((r) => reboundServer.listen(reboundSock, r));
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock: reboundSock, command: 'claude-su', startedAt: 1 }),
    );

    expect(await firstAttempt).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(1);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'raw', data: '\x03', ownerId });
  });
});

describe('injectIntoHost — compact envelope (WI-1804 auto-continuation)', () => {
  it('writes a v1 compact envelope carrying focus as a distinct field', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-compact');
    const ok = await injectIntoHost(sock, {
      mode: 'compact',
      data: 'Continue where you left off — resume WI-1804.',
      focus: 'keep the identity block + WI-1804 open items',
    });
    expect(ok).toBe(true);
    // `data` = the carry-note continuation; `focus` = the /compact argument. Kept separate.
    expect(JSON.parse(await received)).toEqual({
      v: 1,
      mode: 'compact',
      data: 'Continue where you left off — resume WI-1804.',
      focus: 'keep the identity block + WI-1804 open items',
    });
  });

  it('omits `focus` from the envelope for non-compact modes (unchanged wire for turn)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-nofocus');
    const ok = await injectIntoHost(sock, { mode: 'turn', data: '/compact keep it' });
    expect(ok).toBe(true);
    const env = JSON.parse(await received);
    expect(env).toEqual({ v: 1, mode: 'turn', data: '/compact keep it' });
    expect(env).not.toHaveProperty('focus');
  });
});

describe('injectIntoHost — deterministic carry-respawn envelope (P-018)', () => {
  it('preserves the Codex completion witness through the actual socket and host decoder (WI-10001432)', async () => {
    const { decodeControl, codexCarryTurnCompleted, makeAgentBusyGate } =
      await import('../../../../../apps/operator/scripts/psu-pty-host.mjs');
    const dir = tmpDir();
    const sessions = join(dir, 'sessions');
    mkdirSync(sessions);
    const sourceTranscriptPath = join(sessions, 'rollout-current.jsonl');
    const receivedAtMs = Date.now() - 1000;
    const event = (type: string) => `${JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: { type, turn_id: 'current-turn' },
    })}\n`;
    writeFileSync(sourceTranscriptPath, event('task_started'));
    const { sock, received } = startSocket(dir, 'su-codex-boundary');
    const message = {
      mode: 'carry-respawn' as const,
      data: 'continue the held work',
      systemPromptAddendum: 'bounded carry',
      sourceTranscriptPath,
      ownerId: 'su-codex-boundary',
    };
    expect(await injectIntoHost(sock, message)).toBe(true);
    const decoded = decodeControl(Buffer.from(await received));
    expect(decoded).toMatchObject({
      mode: 'carry-respawn', gated: true, sourceTranscriptPath,
      ownerId: 'su-codex-boundary',
    });
    // `sourceTranscriptPath` is optional on the decoded union BY CONSTRUCTION:
    // the carry-respawn branch spreads it only when the sender supplied one, so
    // it is absent from the other decode shapes. Narrow it here rather than
    // asserting it onto every member of that union.
    const decodedTranscriptPath =
      (decoded as { sourceTranscriptPath?: string } | null)?.sourceTranscriptPath;
    expect(decodedTranscriptPath).toBe(sourceTranscriptPath);
    const probe = () => codexCarryTurnCompleted({
      agent: 'codex', env: { CODEX_HOME: dir },
      transcriptPath: decodedTranscriptPath, receivedAtMs,
    });
    expect(probe()).toBe(false);
    writeFileSync(sourceTranscriptPath, event('task_started') + event('task_complete'));
    expect(probe()).toBe(true);
    const gate = makeAgentBusyGate({ lastOutputAt: Date.now, quietMs: 1500, capMs: 30 });
    await expect(gate.waitAtPrompt(undefined, probe)).resolves.toMatchObject({
      deferred: false, boundary: 'native-turn-complete',
    });
    writeFileSync(sourceTranscriptPath, event('task_complete') + event('task_started'));
    expect(probe()).toBe(false);
    await expect(gate.waitAtPrompt(undefined, probe)).resolves.toMatchObject({ deferred: true });
  });

  it('keeps the successor first prompt and system-prompt addendum distinct', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-carry-respawn');
    const ok = await injectIntoHost(sock, {
      mode: 'carry-respawn',
      data: 'the unanswered owner message',
      systemPromptAddendum: 'bounded deterministic carry document',
    });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({
      v: 1,
      mode: 'carry-respawn',
      data: 'the unanswered owner message',
      systemPromptAddendum: 'bounded deterministic carry document',
    });
  });

  it('adds P-020 drill correlation without changing an ordinary P-018 envelope', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-carry-drill');
    const ok = await injectIntoHost(sock, {
      mode: 'carry-respawn',
      data: '⟦carry-drill:d-1⟧',
      systemPromptAddendum: 'bounded deterministic carry document',
      drillId: 'd-1',
      sessionClass: 'claude-su',
    });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({
      v: 1,
      mode: 'carry-respawn',
      data: '⟦carry-drill:d-1⟧',
      systemPromptAddendum: 'bounded deterministic carry document',
      drillId: 'd-1',
      sessionClass: 'claude-su',
    });
  });
});

describe('hostSupports (WI-1804 rollout gate)', () => {
  const hostWith = (caps: string[] | null | undefined): PsuPtyHost =>
    ({
      ownerId: 'su-x',
      advSessionId: null,
      pid: 1,
      ptyPid: 1,
      sock: '/x.sock',
      command: 'claude-su',
      startedAt: 1,
      caps,
    }) as PsuPtyHost;

  it('is false for a null / undefined host (no live host → fall back)', () => {
    expect(hostSupports(null, 'compact')).toBe(false);
    expect(hostSupports(undefined, 'compact')).toBe(false);
  });

  it('is false for an OLD host with no caps field (the rollout-safe fallback path)', () => {
    expect(hostSupports(hostWith(undefined), 'compact')).toBe(false);
    expect(hostSupports(hostWith(null), 'compact')).toBe(false);
  });

  it('is false when caps is present but does not include the capability', () => {
    expect(hostSupports(hostWith([]), 'compact')).toBe(false);
    expect(hostSupports(hostWith(['osc']), 'compact')).toBe(false);
  });

  it('is true only when caps advertises the capability', () => {
    expect(hostSupports(hostWith(['compact']), 'compact')).toBe(true);
    expect(hostSupports(hostWith(['osc', 'compact']), 'compact')).toBe(true);
  });
});

// EI-20209826138488049: the continuation gate, the context gauge and the inbox all
// decide whether to RECOMMEND self-compaction from this ONE function, and
// session:request-compaction reads it for its own refusal — so a recommendation
// cannot drift from what the tool actually does. These assert the two refusals it
// must reproduce EXACTLY, by the error CODE the tool returns.
describe('selfCompactionAvailability (the shared recommend-vs-refuse predicate)', () => {
  it('no live host ⇒ unavailable, reason no_live_pty_host (the headless fleet member)', () => {
    const a = selfCompactionAvailability('su-nobody', tmpDir());
    expect(a.available).toBe(false);
    expect(a.reason).toBe('no_live_pty_host');
    expect(a.host).toBeNull();
  });

  it('a live host WITHOUT the carry-respawn cap ⇒ unavailable, and still hands back the host it found', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-old');
    writeMeta(dir, 'su-old', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1, caps: ['compact'] });
    const a = selfCompactionAvailability('su-old', dir, ID_OK);
    expect(a.available).toBe(false);
    expect(a.reason).toBe('host_predates_carry_respawn');
    // The host is deliberately NOT null here — the distinction between "no host"
    // and "a host too old" is the whole reason there are two refusal codes.
    expect(a.host?.ownerId).toBe('su-old');
  });

  it('a live carry-respawn-capable host ⇒ available, with the host attached', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-new');
    writeMeta(dir, 'su-new', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1, caps: ['carry-respawn'] });
    const a = selfCompactionAvailability('su-new', dir, ID_OK);
    expect(a.available).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.host?.sock).toBe(sock);
  });

  it('inherits findLiveHost\'s identity gate — a recycled pid is NOT a self-compactable session', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-recycled');
    writeMeta(dir, 'su-recycled', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1, caps: ['carry-respawn'] });
    // Same fixture as the available case above — ONLY the identity verifier differs,
    // proving availability is gated on the real host resolution, not just the caps.
    const a = selfCompactionAvailability('su-recycled', dir, { verifyIdentity: () => false });
    expect(a.available).toBe(false);
    expect(a.reason).toBe('no_live_pty_host');
  });
});

describe('mcpReconnectViaPty (mcp-transport-resilience P-004 — the in-place /mcp heal envelope)', () => {
  // Reads the REAL PSU_PTY_DIR (no dir param) — set up a live host there under a
  // throwaway ownerId, then clean up. Mirrors recolorViaPty/interruptViaPty.
  it("routes by host capability: 'no-host' / 'no-cap' / 'sent' (+ envelope shape)", async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-mcpheal-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    const writeMeta = (caps: string[] | undefined) =>
      writeFileSync(
        meta,
        JSON.stringify({
          ownerId,
          advSessionId: null,
          pid: process.pid,
          ptyPid: process.pid,
          sock,
          command: 'claude-su',
          startedAt: 1,
          ...(caps ? { caps } : {}),
        }),
      );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    // no live host at all → 'no-host' (watchdog falls back to notify)
    expect(await mcpReconnectViaPty('su-no-such-owner-mcpheal', 'papercusp-su', ID_OK)).toBe('no-host');
    // an OLD host (no caps / caps without the macro) → 'no-cap'
    writeMeta(undefined);
    expect(await mcpReconnectViaPty(ownerId, 'papercusp-su', ID_OK)).toBe('no-cap');
    writeMeta(['compact']);
    expect(await mcpReconnectViaPty(ownerId, 'papercusp-su', ID_OK)).toBe('no-cap');
    // a macro-capable host → 'sent', with the v1 envelope carrying the server name
    writeMeta(['compact', 'mcp-reconnect']);
    expect(await mcpReconnectViaPty(ownerId, 'papercusp-su', ID_OK)).toBe('sent');

    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(1);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'mcp-reconnect', data: 'papercusp-su', ownerId });

    // A forced heal is additive on the same v1 envelope. It is what lets the
    // watchdog and the self-serve CLI press Reconnect when Claude's status row
    // still says connected even though tools/list is gone.
    expect(await mcpReconnectViaPty(ownerId, 'papercusp-su', { ...ID_OK, force: true })).toBe('sent');
    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(2);
    expect(JSON.parse(recv[1])).toEqual({
      v: 1,
      mode: 'mcp-reconnect',
      data: 'papercusp-su',
      ownerId,
      force: true,
    });
  });
});

describe('hostIsAgentLaunched (WI-6638 — the agent-vs-human discriminator)', () => {
  it('fails soft to human-launched for absent/blank/old-host values', () => {
    // Absence must never read as "agent-launched": the only consumer uses this to
    // decide whether a terminal window may be closed, so the safe direction is the
    // refusing one, and an older host writes no `launchedBy` field at all.
    expect(hostIsAgentLaunched(null)).toBe(false);
    expect(hostIsAgentLaunched(undefined)).toBe(false);
    expect(hostIsAgentLaunched({} as PsuPtyHost)).toBe(false);
    expect(hostIsAgentLaunched({ launchedBy: null } as unknown as PsuPtyHost)).toBe(false);
    expect(hostIsAgentLaunched({ launchedBy: '   ' } as unknown as PsuPtyHost)).toBe(false);
  });

  it('is true only for a host carrying a real launcher ownerId', () => {
    expect(hostIsAgentLaunched({ launchedBy: 'su-abc' } as unknown as PsuPtyHost)).toBe(true);
  });
});

describe('shutdownViaPty (WI-6638 — ask a finished agent session to close its own tab)', () => {
  // Reads the REAL PSU_PTY_DIR (no dir param), like mcpReconnectViaPty above.
  it("routes by capability and reports the host's REFUSAL reason distinctly from a miss", async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-shutdown-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    // The ack this stand-in host writes back — swapped per case to exercise the
    // accepted / refused branches through the REAL wire format.
    let ack: Record<string, unknown> = { v: 1, ok: true, reason: 'shutdown-accepted' };
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => {
        recv.push(Buffer.concat(chunks).toString('utf8'));
        try {
          conn.write(`${JSON.stringify(ack)}\n`);
          conn.end();
        } catch {
          /* the client's own timeout is the backstop */
        }
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    const writeMeta = (caps: string[] | undefined, advSessionId: string | null = null) =>
      writeFileSync(
        meta,
        JSON.stringify({
          ownerId,
          advSessionId,
          pid: process.pid,
          ptyPid: process.pid,
          sock,
          command: 'claude-su',
          startedAt: 1,
          ...(caps ? { caps } : {}),
        }),
      );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    // no live host at all → 'no-host' (nothing to close; not an error)
    expect(await shutdownViaPty('su-no-such-owner-shutdown', { verifyIdentity: () => true })).toBe(
      'no-host',
    );
    // an OLD host (no caps, or caps without 'shutdown') cannot close itself
    writeMeta(undefined);
    expect(await shutdownViaPty(ownerId, { verifyIdentity: () => true })).toBe('no-cap');
    writeMeta(['carry-respawn', 'mcp-reconnect']);
    expect(await shutdownViaPty(ownerId, { verifyIdentity: () => true })).toBe('no-cap');

    // a shutdown-capable host that ACCEPTS
    writeMeta(['carry-respawn', 'mcp-reconnect', 'shutdown']);
    expect(
      await shutdownViaPty(ownerId, { reason: 'fleet wound down', verifyIdentity: () => true }),
    ).toBe('sent');
    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(1);
    expect(JSON.parse(recv[0])).toEqual({
      v: 1,
      mode: 'shutdown',
      data: 'fleet wound down',
      force: false,
      ownerId,
    });

    // Each REFUSAL must come back as its own verdict, NOT as a generic failure: an
    // owner-attended window refusing is the correct answer, and a caller that cannot
    // tell it from a transport miss will retry forever against a session it may
    // never close.
    for (const [hostReason, expected] of [
      ['shutdown-refused:not-agent-launched', 'refused-not-agent-launched'],
      ['shutdown-refused:human-attended', 'refused-human-attended'],
      ['shutdown-refused:agent-busy', 'refused-agent-busy'],
      ['shutdown-refused:stale-host', 'refused-stale-host'],
    ] as const) {
      recv.length = 0;
      ack = { v: 1, ok: false, reason: hostReason };
      expect(await shutdownViaPty(ownerId, { verifyIdentity: () => true })).toBe(expected);
      expect(recv).toHaveLength(1); // an acknowledged refusal is never retried
    }

    // An ok:false the caller does not recognise stays a plain send-failure rather
    // than being mislabelled as a refusal.
    ack = { v: 1, ok: false, reason: 'unhandled-error' };
    expect(await shutdownViaPty(ownerId, { verifyIdentity: () => true })).toBe('send-failed');

    // force rides the envelope so the host can waive ONLY its mid-turn check.
    ack = { v: 1, ok: true, reason: 'shutdown-accepted' };
    recv.length = 0;
    expect(await shutdownViaPty(ownerId, { force: true, verifyIdentity: () => true })).toBe('sent');
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(recv[recv.length - 1])).toMatchObject({ mode: 'shutdown', force: true });
    recv.length = 0;
    writeMeta(['shutdown'], '7');
    expect(await shutdownViaPty(ownerId, { expectedHost: { startedAt: 1, advSessionId: '7' }, verifyIdentity: () => true })).toBe('no-cap');
    writeMeta(['shutdown', 'shutdown-identity'], '7');
    expect(await shutdownViaPty(ownerId, { expectedHost: { startedAt: 2, advSessionId: '7' }, verifyIdentity: () => true })).toBe('refused-stale-host');
    expect(await shutdownViaPty(ownerId, { expectedHost: { startedAt: 1, advSessionId: '8' }, verifyIdentity: () => true })).toBe('refused-stale-host');
    expect(recv).toEqual([]);
    expect(await shutdownViaPty(ownerId, { expectedHost: { startedAt: 1, advSessionId: '7' }, verifyIdentity: () => true })).toBe('sent');
    expect(JSON.parse(recv.at(-1)!)).toMatchObject({ mode: 'shutdown', expectedStartedAt: 1, ownerId });
  });

  it('re-discovers and retries a transport miss only while the same host incarnation remains live', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-shutdown-rebound-${process.pid}-${Math.floor(performance.now())}`;
    const key = sanitizeKey(ownerId);
    const staleSock = join(PSU_PTY_DIR, `${key}.sock`);
    const reboundSock = join(PSU_PTY_DIR, `${key}-rebound.sock`);
    const meta = join(PSU_PTY_DIR, `${key}.json`);
    const received: Record<string, unknown>[] = [];
    let resolveInitialVerification!: () => void;
    const initialVerification = new Promise<void>((resolve) => { resolveInitialVerification = resolve; });
    let verificationCalls = 0;
    const verifyIdentity = async () => {
      verificationCalls += 1;
      if (verificationCalls === 1) resolveInitialVerification();
      return true;
    };
    const writeMeta = (sock: string, startedAt: number, advSessionId: string) => writeFileSync(
      meta,
      JSON.stringify({
        ownerId,
        advSessionId,
        pid: process.pid,
        ptyPid: process.pid,
        sock,
        command: 'claude-su',
        startedAt,
        caps: ['shutdown', 'shutdown-identity'],
      }),
    );

    // The first discovery sees a present but unbound socket path. The host then
    // rebinds to another path without changing its launch incarnation.
    writeFileSync(staleSock, '');
    writeMeta(staleSock, 1, '7');
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        conn.end(`${JSON.stringify({ v: 1, ok: true, reason: 'shutdown-accepted' })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(reboundSock, resolve));
    cleanups.push(() => {
      server.close();
      for (const path of [staleSock, reboundSock, meta]) if (existsSync(path)) unlinkSync(path);
    });

    const pending = shutdownViaPty(ownerId, {
      expectedHost: { startedAt: 1, advSessionId: '7' },
      verifyIdentity,
    });
    await initialVerification; // guarantees the first call captured the stale record
    writeMeta(reboundSock, 1, '7');

    expect(await pending).toBe('sent');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      mode: 'shutdown',
      ownerId,
      expectedStartedAt: 1,
    });
  });

  it('does not carry a missed shutdown onto a replacement host incarnation', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-shutdown-replaced-${process.pid}-${Math.floor(performance.now())}`;
    const key = sanitizeKey(ownerId);
    const staleSock = join(PSU_PTY_DIR, `${key}.sock`);
    const replacementSock = join(PSU_PTY_DIR, `${key}-replacement.sock`);
    const meta = join(PSU_PTY_DIR, `${key}.json`);
    const received: string[] = [];
    let resolveInitialVerification!: () => void;
    const initialVerification = new Promise<void>((resolve) => { resolveInitialVerification = resolve; });
    let verificationCalls = 0;
    const verifyIdentity = async () => {
      verificationCalls += 1;
      if (verificationCalls === 1) resolveInitialVerification();
      return true;
    };
    const writeMeta = (sock: string, startedAt: number, advSessionId: string) => writeFileSync(
      meta,
      JSON.stringify({
        ownerId,
        advSessionId,
        pid: process.pid,
        ptyPid: process.pid,
        sock,
        command: 'claude-su',
        startedAt,
        caps: ['shutdown', 'shutdown-identity'],
      }),
    );

    writeFileSync(staleSock, '');
    writeMeta(staleSock, 1, '7');
    const server = net.createServer((conn) => {
      conn.on('data', (d) => received.push(d.toString('utf8')));
    });
    await new Promise<void>((resolve) => server.listen(replacementSock, resolve));
    cleanups.push(() => {
      server.close();
      for (const path of [staleSock, replacementSock, meta]) if (existsSync(path)) unlinkSync(path);
    });

    const pending = shutdownViaPty(ownerId, {
      expectedHost: { startedAt: 1, advSessionId: '7' },
      verifyIdentity,
    });
    await initialVerification;
    writeMeta(replacementSock, 2, '8');

    expect(await pending).toBe('refused-stale-host');
    expect(received).toEqual([]);
  });
});

describe('latestRespawnNativeId (WI-5075 rung 3: reconcile a stale adv_sessions ref)', () => {
  const owner = 'su-71c6993d-5825-4697-994d-2f9922b889b6';
  const HOST_START = Date.parse('2026-07-18T20:00:00Z');
  const at = (min: number): string => new Date(HOST_START + min * 60_000).toISOString();
  /** Writes the event log AND the discovery file the startedAt gate reads. */
  const write = (dir: string, lines: unknown[], startedAt: number | null = HOST_START): void => {
    writeFileSync(
      join(dir, `${sanitizeKey(owner)}.events.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    if (startedAt !== null) writeMeta(dir, owner, { startedAt });
  };

  it('returns the NEWEST respawn nativeId, not the first', () => {
    const dir = tmpDir();
    write(dir, [
      { ts: at(1), kind: 'respawned', mode: 'carry-respawn', nativeId: 'old-1' },
      { ts: at(2), kind: 'respawn-carry-delivered', nativeId: 'old-1' },
      { ts: at(3), kind: 'respawned', mode: 'carry-respawn', nativeId: 'newest-2' },
    ]);
    expect(latestRespawnNativeId(owner, dir)).toBe('newest-2');
  });

  it('returns the newest respawn nativeId with its event timestamp for chronology checks', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(3), kind: 'respawned', nativeId: 'newest-2' }]);
    expect(latestRespawnNativeSession(owner, dir)).toEqual({
      nativeId: 'newest-2',
      atMs: Date.parse(at(3)),
    });
  });

  it('ignores non-respawn lifecycle events between respawns', () => {
    const dir = tmpDir();
    write(dir, [
      { ts: at(1), kind: 'respawned', nativeId: 'live-1' },
      { ts: at(2), kind: 'compact-submitted', carry: true },
      { ts: at(3), kind: 'respawn-failed', reason: 'argv-build-failed' },
    ]);
    // A FAILED respawn minted no successor — the last LANDED one still stands.
    expect(latestRespawnNativeId(owner, dir)).toBe('live-1');
  });

  it('counts a carry-drill respawn (it rotates the native id identically)', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(1), kind: 'carry-drill-respawned', nativeId: 'drill-1' }]);
    expect(latestRespawnNativeId(owner, dir)).toBe('drill-1');
  });

  it('returns null when the owner has never respawned — the DB ref stands', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(1), kind: 'compact-submitted', carry: true }]);
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  it('returns null (never throws) with no log at all — non-psu cohorts untouched', () => {
    expect(latestRespawnNativeId('su-never-hosted', tmpDir())).toBeNull();
  });

  it('survives a corrupt/partial line — the tail window can start mid-line', () => {
    const dir = tmpDir();
    const p = join(dir, `${sanitizeKey(owner)}.events.jsonl`);
    writeFileSync(
      p,
      'ativeId":"truncated-garbage"}\n' +
        JSON.stringify({ ts: at(2), kind: 'respawned', nativeId: 'good-2' }) +
        '\n',
    );
    writeMeta(dir, owner, { startedAt: HOST_START });
    expect(latestRespawnNativeId(owner, dir)).toBe('good-2');
  });

  it('IGNORES a respawn from a PREVIOUS host — the append-only log outlives one host', () => {
    const dir = tmpDir();
    // The log records a respawn, then the host restarted (fresh startedAt) and has
    // NOT respawned since. That old id names a dead child; trusting it would pin
    // the estimate to a predecessor — the WI-5075 bug, inverted.
    write(dir, [{ ts: at(-30), kind: 'respawned', nativeId: 'previous-host-1' }], HOST_START);
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  it('accepts a respawn from the CURRENT host (at/after its startedAt)', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(5), kind: 'respawned', nativeId: 'this-host-1' }], HOST_START);
    expect(latestRespawnNativeId(owner, dir)).toBe('this-host-1');
  });

  it('returns null with no discovery file — nothing to reconcile against', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(1), kind: 'respawned', nativeId: 'orphan-1' }], null);
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  it('admits an owner-scoped respawn without discovery ONLY for a missing-primary recovery', () => {
    const dir = tmpDir();
    write(
      dir,
      [{ ts: at(1), kind: 'respawned', mode: 'self-relaunch', nativeId: 'recovered-without-adv-row' }],
      null,
    );
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
    expect(latestRespawnNativeId(owner, dir, { allowWithoutHost: true })).toBe('recovered-without-adv-row');
  });

  it('still rejects a hostless carry row — only the self-relaunch hook is a hostless authority', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(1), kind: 'respawned', mode: 'carry-respawn', nativeId: 'stale-host-id' }], null);
    expect(latestRespawnNativeId(owner, dir, { allowWithoutHost: true })).toBeNull();
  });

  it('EI-151: a discovery file recorded for ANOTHER owner never reconciles this one', () => {
    const dir = tmpDir();
    write(dir, [{ ts: at(1), kind: 'respawned', nativeId: 'x-1' }], null);
    writeFileSync(
      join(dir, `${sanitizeKey(owner)}.json`),
      JSON.stringify({ ownerId: 'su-someone-else', startedAt: HOST_START }),
    );
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  it('a respawn with an unparseable ts is not trusted (cannot prove it is current)', () => {
    const dir = tmpDir();
    write(dir, [{ ts: 'not-a-date', kind: 'respawned', nativeId: 'unknown-age' }], HOST_START);
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  it('a respawn recorded WITHOUT a nativeId (recycle) reports null, not a stale id', () => {
    const dir = tmpDir();
    write(dir, [
      { ts: at(1), kind: 'respawned', nativeId: 'old-1' },
      { ts: at(2), kind: 'respawned', mode: 'recycle', nativeId: null },
    ]);
    // The newest respawn rotated to an id the host did not record; claiming the
    // superseded 'old-1' would re-pin the estimate to a dead predecessor.
    expect(latestRespawnNativeId(owner, dir)).toBeNull();
  });

  // WI-10005220: per-owner sweeps must read the ledger off the event loop. The async
  // form shares the decision with the sync one; this pins that they agree on EVERY
  // fixture shape above (a divergence would silently re-pin a session on bg-host only).
  it('latestRespawnNativeSessionAsync agrees with the sync form on every fixture shape', async () => {
    type Case = {
      name: string;
      lines: unknown[] | string | null;
      startedAt: number | null;
      meta?: Record<string, unknown>;
      allowWithoutHost?: boolean;
    };
    const cases: Case[] = [
      { name: 'newest wins', lines: [
        { ts: at(1), kind: 'respawned', nativeId: 'old-1' },
        { ts: at(3), kind: 'respawned', nativeId: 'newest-2' },
      ], startedAt: HOST_START },
      { name: 'drill', lines: [{ ts: at(1), kind: 'carry-drill-respawned', nativeId: 'drill-1' }], startedAt: HOST_START },
      { name: 'never respawned', lines: [{ ts: at(1), kind: 'compact-submitted' }], startedAt: HOST_START },
      { name: 'no log', lines: null, startedAt: HOST_START },
      { name: 'partial first line', lines:
        'ativeId":"garbage"}\n' + JSON.stringify({ ts: at(2), kind: 'respawned', nativeId: 'good-2' }) + '\n',
        startedAt: HOST_START },
      { name: 'previous host', lines: [{ ts: at(-30), kind: 'respawned', nativeId: 'prev' }], startedAt: HOST_START },
      { name: 'no discovery file', lines: [{ ts: at(1), kind: 'respawned', nativeId: 'orphan' }], startedAt: null },
      { name: 'hostless self-relaunch allowed', lines: [
        { ts: at(1), kind: 'respawned', mode: 'self-relaunch', nativeId: 'recovered' },
      ], startedAt: null, allowWithoutHost: true },
      { name: 'hostless carry rejected', lines: [
        { ts: at(1), kind: 'respawned', mode: 'carry-respawn', nativeId: 'stale' },
      ], startedAt: null, allowWithoutHost: true },
      { name: 'foreign discovery file', lines: [{ ts: at(1), kind: 'respawned', nativeId: 'x-1' }],
        startedAt: null, meta: { ownerId: 'su-someone-else', startedAt: HOST_START } },
      { name: 'unparseable ts', lines: [{ ts: 'not-a-date', kind: 'respawned', nativeId: 'u' }], startedAt: HOST_START },
      { name: 'recycle without id', lines: [
        { ts: at(1), kind: 'respawned', nativeId: 'old-1' },
        { ts: at(2), kind: 'respawned', mode: 'recycle', nativeId: null },
      ], startedAt: HOST_START },
    ];
    let nonNull = 0;
    for (const c of cases) {
      const dir = tmpDir();
      if (c.lines !== null) {
        writeFileSync(
          join(dir, `${sanitizeKey(owner)}.events.jsonl`),
          typeof c.lines === 'string' ? c.lines : c.lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
        );
      }
      if (c.startedAt !== null) writeMeta(dir, owner, { startedAt: c.startedAt });
      if (c.meta) writeFileSync(join(dir, `${sanitizeKey(owner)}.json`), JSON.stringify(c.meta));
      const opts = c.allowWithoutHost ? { allowWithoutHost: true } : {};
      const sync = latestRespawnNativeSession(owner, dir, opts);
      expect({ name: c.name, got: await latestRespawnNativeSessionAsync(owner, dir, opts) }).toEqual({
        name: c.name,
        got: sync,
      });
      expect({ name: c.name, got: await hostStartedAtAsync(owner, dir) }).toEqual({
        name: c.name,
        got: hostStartedAt(owner, dir),
      });
      if (sync) nonNull++;
    }
    // Calibration: the table must exercise BOTH outcomes, or "they agree" is vacuous.
    expect(nonNull).toBeGreaterThanOrEqual(4);
    expect(nonNull).toBeLessThan(cases.length);
  });

  // WI-10005220 recurrence guard: resolveSessionRefReconciled runs per owner on bg-host
  // sweeps, so its DEFAULT rung-3 read must stay on the async form.
  it('resolveSessionRefReconciled reads the respawn ledger with the ASYNC form', () => {
    const src = readFileSync(resolve(__dirname, '../../compaction-usage.ts'), 'utf8');
    expect(src).toMatch(/\blatestRespawnNativeSessionAsync\(ownerId\b/);
    expect(src).not.toMatch(/\blatestRespawnNativeSession\(ownerId\b/);
  });
});

describe('hostCodeVersionMatches (WI-38292 — which build is this LIVE host running)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('reports true when the running host carries the expected build', () => {
    expect(hostCodeVersionMatches({ hostCodeVersion: A }, A)).toBe(true);
  });

  it('reports false when the live host predates the expected build', () => {
    // The reported failure: a fix committed AFTER the host booted cannot run in it,
    // so the fix looks broken while it is actually only un-adopted.
    expect(hostCodeVersionMatches({ hostCodeVersion: A }, B)).toBe(false);
  });

  it('returns null — NOT false — for an older host with no hostCodeVersion field', () => {
    // Fail-soft direction matters: an unknown must never read as a decided answer.
    expect(hostCodeVersionMatches({}, A)).toBeNull();
    expect(hostCodeVersionMatches(null, A)).toBeNull();
    expect(hostCodeVersionMatches(undefined, A)).toBeNull();
  });

  it('returns null when the CALLER has no expected version to compare against', () => {
    expect(hostCodeVersionMatches({ hostCodeVersion: A }, null)).toBeNull();
    expect(hostCodeVersionMatches({ hostCodeVersion: A }, '')).toBeNull();
  });

  it('never answers "up to date" from an absent value on either side', () => {
    // The whole point of the field: the tempting default (assume it matches) is the
    // bug this exists to end. No combination of unknowns may produce a `true`.
    for (const host of [null, undefined, {}, { hostCodeVersion: null }, { hostCodeVersion: '  ' }]) {
      for (const expected of [null, undefined, '', '   ', A]) {
        expect(hostCodeVersionMatches(host as never, expected)).not.toBe(true);
      }
    }
  });

  it('ignores surrounding whitespace rather than reporting a false mismatch', () => {
    expect(hostCodeVersionMatches({ hostCodeVersion: ` ${A} ` }, A)).toBe(true);
  });
});

describe('auditInjectOwnerBinding — the SENDER-side owner-binding detector (WI-2140968)', () => {
  const OWNER_A = `su-aud-a-${process.pid}`;
  const OWNER_B = `su-aud-b-${process.pid}`;
  let auditDir: string;
  let auditPath: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const planted: string[] = [];

  /** Plant the discovery record the host would have written, so the detector's
   *  authoritative lookup has something real to read. */
  const plantHost = (ownerId: string, sock?: string): string => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const key = sanitizeKey(ownerId);
    const sockPath = sock ?? join(PSU_PTY_DIR, `${key}.sock`);
    const metaPath = join(PSU_PTY_DIR, `${key}.json`);
    writeFileSync(
      metaPath,
      JSON.stringify({
        ownerId,
        advSessionId: null,
        pid: process.pid,
        ptyPid: process.pid,
        sock: sockPath,
        command: 'claude-su',
        startedAt: 1,
      }),
    );
    planted.push(metaPath);
    return sockPath;
  };

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'inject-audit-'));
    auditPath = join(auditDir, 'audit.jsonl');
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH = auditPath;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await _flushInjectAuditForTest();
    delete process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH;
    warn.mockRestore();
    rmSync(auditDir, { recursive: true, force: true });
    for (const p of planted.splice(0)) if (existsSync(p)) unlinkSync(p);
  });

  const rows = async (): Promise<Array<Record<string, unknown>>> => {
    await _flushInjectAuditForTest();
    return existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  };

  describe('sockOwnerIdFromPath — the caller-independent witness', () => {
    it('reads the owner out of the socket path the host actually writes', () => {
      expect(sockOwnerIdFromPath(join(PSU_PTY_DIR, `${OWNER_A}.sock`))).toBe(OWNER_A);
    });

    it('returns null (indeterminate) rather than guessing on a non-socket path', () => {
      for (const p of ['', '/tmp/whatever', '/tmp/x.json', '.sock']) {
        expect(sockOwnerIdFromPath(p)).toBeNull();
      }
    });
  });

  it('passes a correctly-bound delivery silently', async () => {
    const verdict = auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), {
      mode: 'turn',
      ownerId: OWNER_A,
    });
    expect(verdict).toBe('match');
    expect((await rows()).filter((r) => r.kind === 'inject-owner-mismatch')).toHaveLength(0);
  });

  // THE load-bearing case: the failure the receiving host's EI-153 guard structurally
  // cannot see, because envelope ownerId and socket owner agree from ITS point of view.
  it('catches text addressed to one owner being written to ANOTHER owner’s socket', async () => {
    const sockB = plantHost(OWNER_B);
    const verdict = auditInjectOwnerBinding(sockB, {
      mode: 'turn',
      ownerId: OWNER_A,
      deliveryId: '314514',
    });
    expect(verdict).toBe('mismatch');

    const hits = (await rows()).filter((r) => r.kind === 'inject-owner-mismatch');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      mode: 'turn',
      envelopeOwnerId: OWNER_A,
      recordedOwnerId: OWNER_B,
      deliveryId: '314514',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  // The false positive that would discredit the whole instrument. A socket path is a
  // CONVENTION, not the binding: `interruptViaPty` legitimately retries against a
  // rebound socket whose filename no longer matches its owner. The filename
  // disagreeing is a reason to consult the host's own record — never a verdict.
  it('does NOT accuse a correctly-bound delivery whose socket path is non-canonical', async () => {
    const reboundSock = join(PSU_PTY_DIR, `${sanitizeKey(OWNER_A)}-rebound.sock`);
    plantHost(OWNER_A, reboundSock);

    expect(auditInjectOwnerBinding(reboundSock, { mode: 'turn', ownerId: OWNER_A })).toBe('match');
    expect((await rows()).filter((r) => r.kind === 'inject-owner-mismatch')).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports indeterminate when no discovery record explains the disagreement — and COUNTS it', async () => {
    // Filenames disagree and there is no record binding this socket to anyone. That is
    // an ABSENCE of evidence; calling it a misroute would be inventing one — so the
    // verdict stays `indeterminate` and nobody is accused.
    //
    // But it is not NOTHING. The witnesses DID disagree; we merely could not adjudicate.
    // Staying silent here is the heartbeat's own false-negative trap on the one path
    // that goes quiet exactly when it matters: a respawn storm is when a discovery
    // record is missing or mid-rewrite, and the WI-2140968 misroutes were measured
    // inside one. So the row is written as a CENSUS entry, never as an accusation.
    const orphan = join(PSU_PTY_DIR, `${sanitizeKey(OWNER_B)}-orphan-${Date.now()}.sock`);
    expect(auditInjectOwnerBinding(orphan, { mode: 'turn', ownerId: OWNER_A })).toBe('indeterminate');

    // NOT accused: no mismatch row, no operator-facing warning.
    expect((await rows()).filter((r) => r.kind === 'inject-owner-mismatch')).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    // ...but no longer invisible.
    const seen = (await rows()).filter((r) => r.kind === 'inject-owner-indeterminate');
    expect(seen).toHaveLength(1);
    // `sockOwnerId` is the FILENAME-DERIVED witness, verbatim — the whole `.sock` stem,
    // not an owner id parsed out of it. That is the point of the field: it records what
    // the cheap witness actually said, suffix and all, so a census row shows the real
    // socket rather than a cleaned-up guess at who it belonged to. Derived here through
    // the same helper the detector uses, so the rule is stated in exactly one place.
    expect(seen[0]).toMatchObject({
      mode: 'turn',
      envelopeOwnerId: OWNER_A,
      sockOwnerId: sockOwnerIdFromPath(orphan),
    });
  });

  it('keeps the NO-WITNESS path silent — only an unadjudicable DISAGREEMENT is censused', async () => {
    // The discriminator that keeps the new census row honest. A path carrying no owner
    // witness at all never observed a disagreement in the first place, so it must not
    // inflate the indeterminate census; it returns before the counter even increments.
    expect(auditInjectOwnerBinding('/tmp/not-a-socket', { mode: 'turn', ownerId: OWNER_A })).toBe(
      'indeterminate',
    );
    expect(await rows()).toHaveLength(0);
  });

  it('records an unlabelled TURN-class inject — the guard’s fail-open exemption', async () => {
    // An envelope with no ownerId decodes host-side to a legacy mode:'turn' the EI-153
    // guard abstains on entirely, so this is the one shape that reaches a pty with no
    // identity check anywhere. It must not be silent here too.
    const verdict = auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), { mode: 'turn' });
    expect(verdict).toBe('unlabelled');
    expect((await rows()).filter((r) => r.kind === 'inject-owner-unlabelled')).toHaveLength(1);
  });

  it('does not itemise unlabelled CONTROL-BYTE modes, which are legitimately unaddressed', async () => {
    for (const mode of ['raw', 'osc', 'mcp-reconnect']) {
      expect(auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), { mode })).toBe('unlabelled');
    }
    expect((await rows()).filter((r) => r.kind === 'inject-owner-unlabelled')).toHaveLength(0);
  });

  it('reports indeterminate — never a mismatch — when the path carries no witness', async () => {
    // A test double or an injected absolute path is an ABSENCE of evidence. Reporting it
    // as a mismatch would manufacture exactly the false positive that discredits a detector.
    expect(auditInjectOwnerBinding('/tmp/not-a-socket', { mode: 'turn', ownerId: OWNER_A })).toBe(
      'indeterminate',
    );
    expect(await rows()).toHaveLength(0);
  });

  // The heartbeat is the detector's positive control, but `injectsChecked` is
  // module-level and restarts at 0 with every process. A sender recycled more often
  // than it performs 500 injects therefore emits NO heartbeat ever — a silence that
  // reads as "never wired up" rather than "short-lived". Measured on this box: the
  // whole audit population was 9 short-lived pids reaching ~25 checks apiece, so the
  // control was unreachable by construction. The override turns a falsifier you WAIT
  // on into one you can PROBE.
  it('honours a heartbeat-interval override, so the positive control is reachable in a probe', async () => {
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_HEARTBEAT_EVERY = '1';
    try {
      auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), {
        mode: 'turn',
        ownerId: OWNER_A,
      });
      const beats = (await rows()).filter((r) => r.kind === 'inject-audit-heartbeat');
      expect(beats.length).toBeGreaterThanOrEqual(1);
      expect(beats[0]).toMatchObject({ pid: process.pid });
      expect(typeof beats[0].checked).toBe('number');
    } finally {
      delete process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_HEARTBEAT_EVERY;
    }
  });

  it('ignores a junk or non-positive heartbeat override rather than beating on every inject', async () => {
    for (const bad of ['0', '-5', 'banana', '']) {
      process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_HEARTBEAT_EVERY = bad;
      try {
        auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), {
          mode: 'turn',
          ownerId: OWNER_A,
        });
      } finally {
        delete process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_HEARTBEAT_EVERY;
      }
    }
    // Default interval (500) is far above the handful of checks this test performed.
    expect((await rows()).filter((r) => r.kind === 'inject-audit-heartbeat')).toHaveLength(0);
  });

  it('never throws, and never blocks a delivery, on a hostile audit path', () => {
    const sockB = plantHost(OWNER_B);
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_PATH = join(auditDir, 'no', 'such', 'dir', 'a.jsonl');
    expect(() => auditInjectOwnerBinding(sockB, { mode: 'turn', ownerId: OWNER_A })).not.toThrow();
  });

  it('returns while the async audit append is still pending', async () => {
    const append = vi.spyOn(fsPromises, 'appendFile');
    let release!: () => void;
    append.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    try {
      expect(auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), { mode: 'turn' })).toBe('unlabelled');
      await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
      expect(append).toHaveBeenCalledOnce();
    } finally {
      release();
      append.mockRestore();
      await _flushInjectAuditForTest();
    }
  });

  // WI-10004854: the log had no cap (1.6 MB in a month). Driven through the real write
  // path: a full log rotates to `.1` (replacing the old generation) before the next row.
  it('rotates a full audit log to .1 before writing, replacing the previous generation', async () => {
    writeFileSync(`${auditPath}.1`, 'OLDEST-GENERATION\n');
    writeFileSync(auditPath, 'FULL-GENERATION\n');
    process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_MAX_BYTES = '8';
    try {
      expect(auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), { mode: 'turn' })).toBe('unlabelled');
    } finally {
      delete process.env.PAPERCUSP_PSU_PTY_INJECT_AUDIT_MAX_BYTES;
    }
    await _flushInjectAuditForTest();
    expect(readFileSync(`${auditPath}.1`, 'utf8')).toBe('FULL-GENERATION\n');
    const fresh = await rows();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: 'inject-owner-unlabelled' });
  });

  it('does not rotate a log under the default cap', async () => {
    writeFileSync(auditPath, 'SMALL\n');
    auditInjectOwnerBinding(join(PSU_PTY_DIR, `${OWNER_A}.sock`), { mode: 'turn' });
    await _flushInjectAuditForTest();
    expect(existsSync(`${auditPath}.1`)).toBe(false);
    expect(readFileSync(auditPath, 'utf8').startsWith('SMALL\n')).toBe(true);
  });
});

describe('rotateInjectAuditIfFull (WI-10004854)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inject-audit-rotate-'));
    path = join(dir, 'audit.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('treats a missing log as the normal first-write case', async () => {
    expect(await rotateInjectAuditIfFull(path, 1)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('leaves a log one byte under the cap alone', async () => {
    writeFileSync(path, 'x'.repeat(9));
    expect(await rotateInjectAuditIfFull(path, 10)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('x'.repeat(9));
  });

  it('rotates a log exactly at the cap', async () => {
    writeFileSync(path, 'x'.repeat(10));
    expect(await rotateInjectAuditIfFull(path, 10)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(10));
  });
});

// WI-10004854: several tests above write sockets and discovery records into PSU_PTY_DIR
// because the functions they exercise take no dir parameter. Killed runs left that
// debris in the LIVE ~/.papercusp/psu-pty. setup-hermetic-env now redirects the dir for
// every test process; this pins it from the consumer side.
describe('test isolation of PSU_PTY_DIR (WI-10004854)', () => {
  it('points at a hermetic dir, never the live ~/.papercusp/psu-pty', () => {
    expect(resolve(PSU_PTY_DIR)).not.toBe(resolve(join(homedir(), '.papercusp', 'psu-pty')));
    expect(PSU_PTY_DIR).toBe(process.env.PAPERCUSP_PSU_PTY_DIR);
  });
});
