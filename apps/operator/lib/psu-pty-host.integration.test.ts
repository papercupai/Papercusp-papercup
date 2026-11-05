// @vitest-environment node
/**
 * psu-pty-host.integration.test.ts — the real managed-pty round-trip
 * (turn-lifecycle-control Phase 3, P-012/P-014/P-015): spawn a child through the
 * host, inject via the control socket, assert it lands in the child's stdin, and
 * assert the socket + discovery file are created on start and cleaned up on exit.
 * Spawns a real @lydell/node-pty subprocess, so it's an integration test.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execPath } from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { openClaudeDialog, finishClaudeDialog } from '../scripts/hooks/cc/dialog-answer-provenance.mjs';
import {
  hostThroughPty as hostThroughPtyProduction,
  socketPathFor,
  metaPathFor,
  eventLogPathForOwner,
  appendHostEvent,
  encodeControl,
  KICKOFF_PROOF_PATH_ENV,
  KICKOFF_PROOF_TOKEN_ENV,
  readManagedKickoffFile,
  ptyWriteChunks,
  findNativeTranscriptMarker,
  firstKickoffTurnStartedBeforeRetry,
  waitForNativeTranscriptMarker,
  leadingTurnOriginMarker,
  composeCarryTurnText,
  tagSessionPortTurn,
  startupOutputReady,
  freshChildPromptReady,
  codexTuiStartObserved,
  codexSessionFrameObserved,
  truncatedTurnOriginMarkerLoss,
  TRUNCATED_MARKER_MIN_NONCE_CHARS,
  startupFallbackElapsed,
  CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER,
  killPtyProcessTree,
  handoffPathFor,
  sharedDrillLedgerPath,
  MAX_CONTROL_PAYLOAD_BYTES,
  PSU_PTY_DIR,
  IDENTITY_ACTIVATION_REFUSED_REASON,
} from '../scripts/psu-pty-host.mjs';
import { reportSessionPortDelivery } from '../scripts/psu-launcher.mjs';

// WI-10008170: the production default `onExit` is `process.exit` — right for the
// CLI, fatal here. Every test in this file hosts in-process, so a host that ends
// inside a test calls process.exit in the vitest worker, which vitest reports as
// an unhandled error that fails the whole file even when every assertion passed.
// Default it to a no-op for the file; a test that passes its own onExit still wins.
// Fixture owners have no live session to notify. Keep the detached compaction
// bridge inside the fixture; completion-order tests supply their own emit spy.
let testHostEventNames: Set<string> | null = null;
const hostThroughPty: typeof hostThroughPtyProduction = (o) => {
  testHostEventNames?.add(basename(eventLogPathForOwner(o.ownerId)));
  return hostThroughPtyProduction({ onExit: () => undefined, emitCompacted: () => null, ...o });
};
// The REAL operator-side force-interrupt leg (turn-lifecycle-control Phase 4
// pty-force, reused by e8630's turn:interrupt tool). Importing the published
// subpath keeps this an integration test of the actual chain, not a re-impl.
import { interruptViaPty, findLiveHost, injectIntoHost } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';
import { linuxProcStateFromStat } from '@papercusp/operator-core/lib/process-identity';

/**
 * WI-10005017: some respawn tests fail only in whole-file runs, and the failure
 * reads "expected 1 to be 2" (one child booted where two were expected). That says
 * nothing about WHY the successor never started. The host's own event log does, but
 * it lives in the auto-cleaned PSU_PTY_DIR and is gone by the time anyone looks. On
 * failure, attach the tail of every host event log this test wrote to the failure
 * output, so a non-reproducing failure carries its own evidence.
 */
const FAILURE_EVENT_TAIL_LINES = 30;
function hostEventTailsSince(
  dir: string,
  sinceMs: number,
  lines = FAILURE_EVENT_TAIL_LINES,
  selectedNames?: ReadonlySet<string>,
): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.events.jsonl') && (!selectedNames || selectedNames.has(n)));
  } catch {
    return `(host event dir ${dir} unreadable)`;
  }
  const blocks: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < sinceMs) continue;
      const tail = readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n');
      blocks.push(`--- ${name} (last ${lines} events) ---\n${tail}`);
    } catch {
      /* a log removed mid-read is not evidence either way */
    }
  }
  return blocks.length ? blocks.join('\n') : '(no host event log written during this test)';
}

beforeEach((ctx) => {
  const startedAtMs = Date.now() - 1_000;
  const eventNames = new Set<string>();
  testHostEventNames = eventNames;
  ctx.onTestFailed(({ task }) => {
    // A previous fixture can finish after this test started. Its log must not
    // displace this test's own host evidence in the reporter's bounded message.
    const evidence = hostEventTailsSince(PSU_PTY_DIR, startedAtMs, FAILURE_EVENT_TAIL_LINES, eventNames);
    console.error(`[WI-10005017] host events for failed test "${task.name}":\n${evidence}`);
    const first = task.result?.errors?.[0];
    if (first && typeof first.message === 'string') first.message += `\n[host events]\n${evidence}`;
  });
});

describe('failure evidence: host event tails (WI-10005017)', () => {
  it('includes logs written since the test started, tail-bounded, and skips older ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psu-pty-evidence-'));
    try {
      const fresh = join(dir, 'su-fresh.events.jsonl');
      const stale = join(dir, 'su-stale.events.jsonl');
      const peer = join(dir, 'su-previous-fixture.events.jsonl');
      writeFileSync(fresh, Array.from({ length: 40 }, (_, i) => `{"kind":"e${i}"}`).join('\n'));
      writeFileSync(stale, '{"kind":"old"}\n');
      writeFileSync(peer, '{"kind":"late-previous-fixture"}\n');
      const old = new Date(Date.now() - 60_000);
      utimesSync(stale, old, old);
      writeFileSync(join(dir, 'su-fresh.json'), '{}');
      const out = hostEventTailsSince(dir, Date.now() - 10_000, 5);
      expect(out).toContain('su-fresh.events.jsonl');
      expect(out).toContain('{"kind":"e39"}');
      expect(out).toContain('{"kind":"e35"}');
      expect(out).not.toContain('{"kind":"e34"}');
      expect(out).not.toContain('su-stale');
      expect(out).not.toContain('--- su-fresh.json ');
      const selected = hostEventTailsSince(dir, Date.now() - 10_000, 5, new Set([basename(fresh)]));
      expect(selected).toContain('su-fresh.events.jsonl');
      expect(selected).not.toContain('su-previous-fixture');
      expect(selected).not.toContain('late-previous-fixture');
      expect(hostEventTailsSince(dir, Date.now() + 60_000)).toBe('(no host event log written during this test)');
      expect(hostEventTailsSince(join(dir, 'missing'), 0)).toMatch(/unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fake stdout that accumulates the pty's output; a non-TTY fake stdin. */
function fakeIo() {
  let captured = '';
  return {
    captured: () => captured,
    io: {
      stdout: { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} },
      stdin: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
    },
  };
}

const FLATTENED_CODEX_READY_FOOTER =
  '› Ask Codex to do anythingReady · GPT-5.6-Sol high · Context 100% left';

it('acknowledges startup with the exact initial live PTY PID', async () => {
  const ownerId = `su-startup-witness-${process.pid}-${Date.now()}`;
  const signals = new EventEmitter(), onSpawn = vi.fn();
  const { captured, io } = fakeIo();
  const done = hostThroughPty({ command: execPath,
    args: ['-e', "process.stdout.write('STARTUP_WITNESS_READY\\n');setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: hermeticEnv({ PAPERCUSP_SID: ownerId }), ownerId,
    io, bridgeTty: false, signalSource: signals, onSpawn });
  try {
    await vi.waitFor(() => expect(captured()).toContain('STARTUP_WITNESS_READY'), { timeout: 5000 });
    await vi.waitFor(() => expect(existsSync(metaPathFor(ownerId))).toBe(true));
    const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith({ ptyPid: meta.ptyPid });
    expect(meta.ptyPid).not.toBe(process.pid);
    expect(() => process.kill(meta.ptyPid, 0)).not.toThrow();
  } finally { signals.emit('SIGTERM'); await done; }
}, 10_000);

it('attributes real PTY dialog submissions to machine control or human terminal input', async () => {
  const ownerId = `su-dialog-host-${process.pid}-${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dialog-host-'));
  const env = hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude', PAPERCUSP_TURN_PROVENANCE_DIR: dir });
  const { captured, io } = fakeIo();
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const done = hostThroughPty({ command: execPath,
    args: ['-e', "let n=0;process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString().includes('QUIT'))process.exit(0);process.stdout.write('DIALOG_KEY_'+(++n)+'\\n')});process.stdout.write('DIALOG_READY\\n')"],
    cwd: process.cwd(), env, ownerId, io: { ...io, stdin }, bridgeTty: true, signalSource: new EventEmitter(),
  });
  try {
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_READY'), { timeout: 5000 });
    openClaudeDialog(ownerId, 'native-session', 'machine-question', env);
    await rawInject(socketPathFor(ownerId), '\r');
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_KEY_1'), { timeout: 3000 });
    expect(finishClaudeDialog(ownerId, 'native-session', 'machine-question', 'first option', env)).toContain('"source":"automatic"');
    openClaudeDialog(ownerId, 'native-session', 'human-question', env);
    stdin.emit('data', Buffer.from('\r'));
    await vi.waitFor(() => expect(captured()).toContain('DIALOG_KEY_2'), { timeout: 3000 });
    expect(finishClaudeDialog(ownerId, 'native-session', 'human-question', 'second option', env)).toContain('"source":"human"');
  } finally {
    stdin.emit('data', Buffer.from('QUIT'));
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 12000);
const FLATTENED_CODEX_STARTING_FOOTER =
  '› Ask Codex to do anythingStarting · GPT-5.6-Sol high · Context 100% left';

it('keeps owner input and real PTY output responsive while discovery rename is stalled', async () => {
  const ownerId = `su-slow-discovery-${process.pid}-${Date.now()}`;
  const metaPath = metaPathFor(ownerId);
  const originalRename = fsPromises.rename;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  let renameEntered = false;
  const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === metaPath) { renameEntered = true; await stalled; }
    return originalRename(from, to);
  });
  const { captured, io } = fakeIo();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const signals = new EventEmitter();
  let ended = false;
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', String.raw`const {StringDecoder}=require('node:string_decoder');const decoder=new StringDecoder('utf8');let quitTail='';process.stdin.setRawMode(true);process.stdin.on('data',d=>{const text=decoder.write(d);quitTail=(quitTail+text).slice(-8);if(quitTail.includes('QUIT'))process.exit(0);if(text)process.stdout.write('ECHO:'+text+'\n');});process.stdout.write('SLOW_FS_READY\n');`],
    cwd: process.cwd(), env: hermeticEnv({ PAPERCUSP_SID: ownerId }), ownerId,
    io: { ...io, stdin }, bridgeTty: false, signalSource: signals, activityPersistMs: 25,
  }).then((code) => { ended = true; return code; });
  try {
    await vi.waitFor(() => {
      expect(renameEntered).toBe(true);
      expect(captured()).toContain('SLOW_FS_READY');
    }, { timeout: 5000 });
    stdin.emit('data', Buffer.from('owner-input'));
    await vi.waitFor(() => expect(captured()).toContain('ECHO:owner-input'), { timeout: 3000 });
    stdin.emit('data', Buffer.from([0xc3]));
    stdin.emit('data', Buffer.from([0xa9]));
    await vi.waitFor(() => expect(captured()).toContain('ECHO:é'), { timeout: 3000 });
    expect(existsSync(metaPath)).toBe(false);
    stdin.emit('data', Buffer.from('QUIT'));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(ended).toBe(false);
    release();
    expect(await done).toBe(0);
    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(socketPathFor(ownerId))).toBe(false);
  } finally {
    release();
    if (!ended) signals.emit('SIGTERM');
    await done;
    rename.mockRestore();
  }
}, 15_000);

it('binds, discovers, injects and cleans a byte-bounded control socket for a long owner', async () => {
  const ownerId = (`su-byte-bound-${process.pid}-${Date.now()}-` + 'x'.repeat(200)).slice(0, 200);
  const sibling = join(PSU_PTY_DIR, `${ownerId}.sock`);
  expect(Buffer.byteLength(sibling)).toBeGreaterThan(107);
  // Distinguish address overflow from a missing native/SRT dependency: the
  // legacy address fails at the OS bind, while the maintained host below works.
  const legacy = net.createServer();
  const error = await new Promise<NodeJS.ErrnoException>(resolve => {
    legacy.once('error', resolve); legacy.listen(sibling);
  });
  expect(error.code).toBe('EINVAL');
  const sock = socketPathFor(ownerId);
  const { captured, io } = fakeIo();
  const done = hostThroughPty({ command: execPath, args: ['-e',
    "process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdout.write('BOUNDED_SOCKET_READY\\n');process.stdin.on('data',d=>{if(d.includes('COMPLETE')){process.stdout.write('BOUNDED_SOCKET_INJECTED\\n');process.exit(0);}if(d.includes('\\u0004'))process.exit(0);});setTimeout(()=>process.exit(19),10000);"],
    cwd: process.cwd(), env: hermeticEnv({ PAPERCUSP_SID: ownerId }), ownerId,
    io, bridgeTty: false, signalSource: new EventEmitter(), onExit: () => undefined,
  });
  try {
    await vi.waitFor(() => expect(captured()).toContain('BOUNDED_SOCKET_READY'), { timeout: 5000 });
    const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
    expect(meta).toMatchObject({ ownerId, sock });
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(100);
    expect(statSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o077).toBe(0);
    expect(findLiveHost(ownerId, undefined, { verifyIdentity: pid => pid === process.pid })?.sock).toBe(sock);
    const injection = await injectIntoHost(sock, { mode: 'raw', data: 'COMPLETE\n', ownerId });
    expect(injection).toBe(true);
    expect(await done, captured()).toBe(0);
    expect(captured()).toContain('BOUNDED_SOCKET_INJECTED');
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(metaPathFor(ownerId))).toBe(false);
  } finally {
    if (existsSync(sock)) await injectIntoHost(sock, { mode: 'raw', data: '\u0004', ownerId }).catch(() => undefined);
    await done;
  }
}, 20_000);

/** A deliberately wrong pre-fix control: it checks an exact Ready token. */
function exactStatusOnlyCodexReady(output: string): boolean {
  const status = [...String(output ?? '').matchAll(/([A-Za-z]+)\s*·[^·\n]{0,120}·\s*Context\s+\d{1,3}%\s+left/g)]
    .at(-1)?.[1]?.toLowerCase() ?? null;
  if (status !== null) return status === 'ready';
  return /\d{1,3}%\s*context left/i.test(output);
}

describe('managed-pty integration evidence isolation', () => {
  it('waits for resumed Codex native readiness before writing the first continuation (WI-10007270)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-initial-native-ready-'));
    const inputFile = join(root, 'input.txt');
    const ownerId = `su-initial-native-${process.pid}-${Math.floor(performance.now())}`;
    const nativeId = '01a117cf-6942-7bc3-9aee-1ff8ac3963b7';
    const resolveNativeId = vi.fn((_pid: number) => nativeId);
    const signalSource = new EventEmitter();
    let confirm: (() => void) | undefined;
    const onRespawn = vi.fn((_id: string, options: { onConfirmed: () => void }) => {
      confirm = options.onConfirmed;
      return false;
    });
    const { captured, io } = fakeIo();
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', "const fs=require('fs');let input='';process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdout.write('model: GPT-6.1-Sol medium\\nReady · GPT-6.1-Sol medium · Context 100% left\\n');process.stdin.on('data',d=>{input+=d;fs.appendFileSync(process.env.INPUT_FILE,d);if(input.includes('BEGIN_ACCEPTED_OPERATION'))process.exit(0);});", 'resume'],
      cwd: root,
      env: {
        ...hermeticEnv(), PAPERCUSP_AGENT: 'codex', INPUT_FILE: inputFile,
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '10',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '20',
        PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
      },
      ownerId, io, bridgeTty: false, kickoff: 'BEGIN_ACCEPTED_OPERATION',
      resolveRespawnNativeId: resolveNativeId,
      onRespawn, signalSource, onExit: () => undefined,
    });
    try {
      await vi.waitFor(() => expect(onRespawn).toHaveBeenCalledOnce(), { timeout: 8000 });
      await vi.waitFor(() => expect(captured()).toContain('Ready · GPT-6.1-Sol medium'), { timeout: 8000 });
      const discovery = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
      expect(discovery.nativeSessionId).toBe(nativeId);
      expect(resolveNativeId).toHaveBeenCalledWith(discovery.ptyPid);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(existsSync(inputFile)).toBe(false);
      confirm!();
      await vi.waitFor(() => {
        expect(existsSync(inputFile)).toBe(true);
        expect(readFileSync(inputFile, 'utf8')).toContain('BEGIN_ACCEPTED_OPERATION');
      }, { timeout: 8000 });
      expect(onRespawn.mock.calls[0][0]).toBe(nativeId);
      expect(await done).toBe(0);
      expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
        .not.toContain('codex-starting-stuck-snapshot');
    } finally {
      signalSource.emit('SIGTERM');
      await done.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { phase: 'native binding', reason: 'successor-native-id-missing', label: 'respawn binding', fallbackMs: 50 },
    { phase: 'backend frame', reason: 'codex-backend-frame-not-observed', label: 'launch kickoff', fallbackMs: 50 },
    { phase: 'delayed backend banner', reason: 'codex-backend-frame-not-observed', label: 'launch kickoff', fallbackMs: 50 },
    // The overall kickoff budget can expire before the frame timer, whose
    // clock starts only when the child paints its banner. Neither allows input.
    { phase: 'backend frame after kickoff deadline', reason: 'codex-backend-frame-not-observed', label: 'launch kickoff', fallbackMs: 500 },
  ])('preserves startup evidence when the $phase times out before first-turn injection (WI-10007305)', async ({ phase, reason, label, fallbackMs }) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-missing-native-snapshot-'));
    const codexHome = join(root, 'codex-home');
    const inputFile = join(root, 'input.txt');
    const ownerId = `su-missing-native-${process.pid}-${Math.floor(performance.now())}`;
    mkdirSync(join(codexHome, 'log'), { recursive: true });
    writeFileSync(join(codexHome, 'log', 'codex-tui.log'), 'isolated startup phase did not assign a native id\n');
    const gatedKickoff = phase === 'backend frame after kickoff deadline';
    // Native registration is not this case's failure. Confirm it immediately
    // so a slow child boot cannot spend its separate binding deadline first.
    const onRespawn = vi.fn(async () => true);
    const { captured, io } = fakeIo();
    const signalSource = new EventEmitter();
    const initialOutput = phase === 'native binding'
      ? '\x1b[6nmodel: GPT-6.1-Sol medium\nReady · GPT-6.1-Sol medium · Context 100% left\n'
      : '\x1b[6n│ >_ OpenAI Codex (v0.156.1) │\n│ model: loading /model to change │\n› Ask Codex to do anything\n';
    const done = hostThroughPty({
      command: execPath,
      // Only the binding phase resumes an existing thread. Fresh marked
      // kickoffs keep their stricter frame gate and bind after submission.
      args: ['-e', "const fs=require('fs');process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdin.on('data',d=>fs.appendFileSync(process.env.INPUT_FILE,d));setTimeout(()=>process.stdout.write(process.env.INITIAL_OUTPUT),Number(process.env.INITIAL_OUTPUT_DELAY_MS));", ...(phase === 'native binding' ? ['resume'] : [])],
      cwd: root,
      env: {
        ...hermeticEnv(), PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
        INPUT_FILE: inputFile, INITIAL_OUTPUT: initialOutput,
        INITIAL_OUTPUT_DELAY_MS: phase === 'delayed backend banner' ? '1500' : '0',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '500',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: String(fallbackMs),
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '10',
      },
      ownerId, io, bridgeTty: false,
      kickoff: '⟦turn-origin:fleet-kickoff nonce:abcdef0123456789⟧\nMUST_REMAIN_UNSUBMITTED',
      resolveRespawnNativeId: phase === 'native binding' ? () => null
        : gatedKickoff ? () => '01a117cf-6942-7bc3-9aee-1ff8ac3963b7' : undefined,
      onRespawn, signalSource, onExit: () => undefined,
    });
    try {
      await vi.waitFor(() => {
        const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({
          kind: phase === 'native binding' ? 'respawn-binding-unconfirmed' : 'startup-turn-dropped', reason,
        }));
        const snapshot = events.find(event => event.kind === 'codex-starting-stuck-snapshot' &&
          event.label === label && event.reason === reason);
        expect(snapshot).toMatchObject({
          label, reason,
          log: { present: true, tail: ['isolated startup phase did not assign a native id'] },
        });
        expect(snapshot.rootPid).toBe(JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8')).ptyPid);
        if (process.platform === 'linux') {
          expect(snapshot.procs).toContainEqual(expect.objectContaining({ pid: snapshot.rootPid }));
        }
      }, { timeout: 3000 });
      expect(existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : '').toBe('');
      expect(onRespawn).not.toHaveBeenCalled();
    } finally {
      signalSource.emit('SIGTERM');
      await done.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);

  it('does not attempt a marked kickoff after the host ends before its first backend frame', async () => {
    const ownerId = `su-ended-kickoff-${process.pid}-${Math.floor(performance.now())}`;
    const signalSource = new EventEmitter();
    const writeAttempts: string[] = [];
    const { io } = fakeIo();
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', "process.stdin.on('data',()=>{});setTimeout(()=>process.stdout.write('› Ask Codex\\n'),1500);"],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(), PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '200',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
      },
      ownerId, io, bridgeTty: false, signalSource,
      kickoff: '⟦turn-origin:fleet-kickoff nonce:abcdef0123456789⟧\nMUST_REMAIN_UNSUBMITTED',
      spawnPty: (file, args, options, realSpawn) => {
        const child = realSpawn(file, args, options);
        const write = child.write.bind(child);
        child.write = (data: string) => { writeAttempts.push(data); write(data); };
        return child;
      },
    });
    try {
      signalSource.emit('SIGTERM');
      await done;
      // Cross the kickoff's own deadline after observing completed teardown.
      // Any surviving fallback task must cancel rather than write to the child.
      await sleep(250);
      expect(writeAttempts).toEqual([]);
      expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
        .not.toContain('"kind":"startup-turn-written"');
    } finally {
      signalSource.emit('SIGTERM');
      await done;
    }
  });

  it('excludes caller launch state and native homes while preserving explicit fixture inputs', () => {
    const source = {
      PATH: '/fixture/bin', TERM: 'xterm-256color',
      NODE_OPTIONS: '--import=/fixture/must-not-run.mjs', NODE_PATH: '/fixture/modules',
      PAPERCUSP_PSU_PTY_DIR: PSU_PTY_DIR,
      PAPERCUSP_AGENT: 'codex', PAPERCUSP_SID: 'live-owner',
      PAPERCUSP_ADV_SESSION_ID: '123', PAPERCUSP_PSU_HEADLESS: '1',
      PAPERCUSP_PSU_HEADLESS_NORMALIZED_LOG: '/live/host.log',
      [KICKOFF_PROOF_PATH_ENV]: '/live/receipt.json',
      [KICKOFF_PROOF_TOKEN_ENV]: 'caller-token',
      CODEX_HOME: '/live/codex', CLAUDE_CONFIG_DIR: '/live/claude',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '9000',
    };
    const env = hermeticEnv({ PAPERCUSP_SID: 'fixture-owner' }, source);
    expect(env.PATH).toBe(source.PATH);
    expect(env.TERM).toBe(source.TERM);
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('NODE_PATH');
    // Prove that the child can boot, rather than only checking a copied map.
    expect(execFileSync(execPath, ['-e', "process.stdout.write('FIXTURE_READY')"], { env, encoding: 'utf8' }))
      .toBe('FIXTURE_READY');
    expect(env.PAPERCUSP_PSU_PTY_DIR).toBe(PSU_PTY_DIR);
    expect(env.PAPERCUSP_SID).toBe('fixture-owner');
    expect(env.CODEX_HOME).toBe(join(PSU_PTY_DIR, 'codex-home'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(PSU_PTY_DIR, 'claude-home'));
    for (const key of Object.keys(source).filter((key) => key.startsWith('PAPERCUSP_'))) {
      if (key !== 'PAPERCUSP_SID' && key !== 'PAPERCUSP_PSU_PTY_DIR') expect(env).not.toHaveProperty(key);
    }
    expect(hermeticEnv({ CODEX_HOME: '/fixture/native', [KICKOFF_PROOF_PATH_ENV]: '/fixture/receipt' }, source))
      .toMatchObject({ CODEX_HOME: '/fixture/native', [KICKOFF_PROOF_PATH_ENV]: '/fixture/receipt' });
    expect(source.CODEX_HOME).toBe('/live/codex');
    expect(source.NODE_OPTIONS).toBe('--import=/fixture/must-not-run.mjs');
  });

  it('redirects host lifecycle evidence away from the live operator corpus', () => {
    const liveDir = join(homedir(), '.papercusp', 'psu-pty');
    expect(process.env.PAPERCUSP_PSU_PTY_DIR).toBeTruthy();
    expect(PSU_PTY_DIR).toBe(process.env.PAPERCUSP_PSU_PTY_DIR);
    expect(PSU_PTY_DIR).not.toBe(liveDir);
  });
});

describe('Codex startup process evidence (EI-24353430528930250)', () => {
  it('records real child PID counters and a terminal trace row in the per-owner host log', async () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'psu-codex-startup-trace-'));
    const codexRuntime = join(root, 'codex');
    symlinkSync('/usr/bin/sleep', codexRuntime);
    const ownerId = `su-startup-trace-${process.pid}-${Math.floor(performance.now())}`;
    const logPath = eventLogPathForOwner(ownerId);
    const { io } = fakeIo();
    const signalSource = new EventEmitter();
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: '/bin/bash',
        // Keep the process alive until its sample is observed. A fixed 1.5s
        // lifetime races the sampler and tests scheduling rather than evidence.
        args: ['-c', `"${codexRuntime}" 60 & wait`],
        cwd: root,
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex', TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        signalSource,
        onExit: () => undefined,
      });
      await vi.waitFor(() => {
        expect(readFileSync(logPath, 'utf8')).toContain('"kind":"codex-startup-process-sample"');
      }, { timeout: 3000 });
      signalSource.emit('SIGTERM');
      await done;
      const rows = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const sample = rows.find((row) => row.kind === 'codex-startup-process-sample');
      const selected = rows.find((row) => row.kind === 'codex-startup-process-target-selected');
      const ended = rows.find((row) => row.kind === 'codex-startup-process-trace-ended');
      expect(selected).toMatchObject({ rootPid: expect.any(Number), pid: expect.any(Number) });
      expect(selected.pid).not.toBe(selected.rootPid);
      expect(sample).toMatchObject({
        rootPid: selected.rootPid, pid: selected.pid, comm: 'codex', majorFaults: expect.any(Number),
      });
      expect(ended).toMatchObject({
        rootPid: selected.rootPid, pid: selected.pid, reason: 'host-cleanup', samples: expect.any(Number),
      });
    } finally {
      signalSource.emit('SIGTERM');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(logPath, { force: true });
    }
  }, 5_000);
});

describe('plain launch kickoff turn-start proof', () => {
  it.each(['immediate', 'delayed', 'healthy', 'old-banner', 'repeated-banner', 'no-receipt'] as const)(
    'returns the provider admission verdict for a headless Codex kickoff: %s', async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'psu-kickoff-capacity-'));
      const codexHome = join(root, 'codex-home');
      const nativeFile = join(codexHome, 'sessions', 'rollout-2026-10-16T00-00-00-01234567-89ab-4cde-8fab-0123456789ab.jsonl');
      const proofPath = join(root, 'proof.json');
      const proofToken = 'c'.repeat(48);
      writeFileSync(proofPath, '', { mode: 0o600 });
      const ownerId = `su-capacity-launch-${scenario}-${process.pid}-${Math.floor(performance.now())}`;
      const kickoff = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧\nBegin the assigned work';
      const failed = !['healthy', 'old-banner'].includes(scenario);
      const childCode = [
        "const fs=require('node:fs'),path=require('node:path');let text='',submitted=false;",
        "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
        "const capacity=()=>process.stdout.write('Selected model is at capacity. Please try again in 90 seconds.\\n');",
        "if(['old-banner','repeated-banner'].includes(process.env.SCENARIO))capacity();",
        "process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\nReady · GPT-6.1-Sol xhigh · Context 100% left\\n');",
        "process.stdin.on('data',data=>{for(const ch of data){if(ch!=='\\r'){text+=ch;continue;}if(submitted)continue;submitted=true;",
        "fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const timestamp=new Date().toISOString();",
        "const rows=[{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},",
        "{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'capacity-fixture'}}];",
        "fs.writeFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));",
        "process.stdout.write('SUBMITTED\\n');if(['immediate','repeated-banner','no-receipt'].includes(process.env.SCENARIO))capacity();",
        "else if(process.env.SCENARIO==='delayed')setTimeout(capacity,600);",
        "}process.stdout.write('COMPOSER_ECHO:'+text+'\\n');});",
      ].join('');
      const signalSource = new EventEmitter();
      const { captured, io } = fakeIo();
      const done = hostThroughPty({
        command: execPath, args: ['-e', childCode], cwd: root, ownerId,
        env: hermeticEnv({
          PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex', PAPERCUSP_PSU_HEADLESS: '1',
          CODEX_HOME: codexHome, NATIVE_FILE: nativeFile, SCENARIO: scenario,
          ...(scenario === 'no-receipt' ? {} : {
            [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: proofToken,
          }),
          PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '1200',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '4000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '20',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '30',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS: '1',
        }),
        io, bridgeTty: false, signalSource, kickoff, nativePersistenceTimeoutMs: 1000,
        onRespawn: async () => true,
      });
      try {
        const receipt = await vi.waitFor(() => {
          if (scenario === 'no-receipt') {
            expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8')).toContain('launch-kickoff-model-capacity-rejected');
            expect(existsSync(metaPathFor(ownerId))).toBe(false);
            return null;
          }
          const text = readFileSync(proofPath, 'utf8');
          expect(text.length, captured()).toBeGreaterThan(0);
          return JSON.parse(text);
        }, { timeout: 8000 });
        if (scenario === 'no-receipt') expect(await done).toBe(1);
        else expect(receipt).toEqual({ token: proofToken, persisted: !failed, nativeRef: nativeFile,
          reason: failed ? 'kickoff-not-submitted:model-capacity' : null });
        const rows = readFileSync(nativeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows.filter(row => row.payload?.role === 'user').map(row => row.payload.content[0].text)).toEqual([kickoff]);
        const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const rejected = events.filter(row => row.kind === 'launch-kickoff-model-capacity-rejected');
        expect(rejected).toHaveLength(failed ? 1 : 0);
        if (failed) expect(rejected[0]).toMatchObject({ retryAfterMs: 90_000, nativeRef: nativeFile });
        expect(events.some(row => row.kind === 'launch-kickoff-model-turn-absent')).toBe(false);
        expect(captured().match(/SUBMITTED/g)).toHaveLength(1);
      } finally {
        signalSource.emit('SIGTERM');
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000,
  );

  it.each([
    { receiptState: 'empty', receiptAllowed: true, nativePublication: 'immediate', isResume: false },
    { receiptState: 'nonempty', receiptAllowed: false, nativePublication: 'immediate', isResume: false },
    { receiptState: 'empty', receiptAllowed: true, nativePublication: 'gated', isResume: false },
    { receiptState: 'nonempty', receiptAllowed: false, nativePublication: 'gated', isResume: false },
    { receiptState: 'empty', receiptAllowed: true, nativePublication: 'immediate', isResume: true },
    { receiptState: 'empty', receiptAllowed: true, nativePublication: 'gated', isResume: true },
  ])('preserves and submits a long Codex kickoff when the composer only renders its tail ($receiptState receipt, $nativePublication native publication, resume=$isResume)', async ({ receiptAllowed, nativePublication, isResume }) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-codex-viewport-'));
    const codexHome = join(root, 'codex-home');
    const nativeId = '01234567-89ab-4cde-8fab-0123456789ab';
    const nativeFile = join(codexHome, 'sessions', '2026', '09', '26', `rollout-2026-09-26T00-00-00-${nativeId}.jsonl`);
    const submitFile = join(root, 'submitted.txt');
    const nativeReleaseFile = join(root, 'publish-native');
    const proofPath = join(root, 'kickoff-proof.json');
    const proofToken = 'd'.repeat(48);
    writeFileSync(proofPath, receiptAllowed ? '' : 'reserved', { mode: 0o600 });
    chmodSync(proofPath, 0o600);
    const ownerId = 'su-codex-viewport-' + process.pid + '-' + Math.floor(performance.now());
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
    const kickoff = marker + '\n' + 'Inspect the exact stored evidence without replacing it.\n'.repeat(100);
    const { captured, io } = fakeIo();
    // Model a bounded composer viewport, not input loss: the complete paste is
    // retained, but a single long paste never paints its first line. Advertise
    // bracketed paste and parse real paste boundaries before handling Enter.
    const childCode = [
      "const fs=require('fs'),path=require('path');process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let wire='',composer='',submitted=false,paint;const start='\x1b[200~',end='\x1b[201~';",
      "process.stdout.write('\x1b[?2004h\x1b[6nmodel: GPT-5.6-Sol high\\nReady · GPT-5.6-Sol high · Context 100% left\\n');",
      "function repaint(){clearTimeout(paint);paint=setTimeout(()=>process.stdout.write('COMPOSER_ECHO:'+composer.slice(-160)+'\\n'),30);}",
      "function publishNative(){fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const timestamp=new Date().toISOString();const rows=[{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:composer}]}},{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'viewport-1'}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'viewport-1'}}];fs.writeFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));setTimeout(()=>process.stdout.write('SUBMITTED\\n'),75);}",
      "function submit(){if(submitted){setTimeout(()=>process.stdout.write('RESUBMIT_ACK\\n'),75);return;}submitted=true;fs.writeFileSync(process.env.SUBMIT_FILE,composer);if(process.env.NATIVE_PUBLICATION==='gated'){const gate=setInterval(()=>{if(fs.existsSync(process.env.NATIVE_RELEASE_FILE)){clearInterval(gate);publishNative();}},5);}else publishNative();}",
      "process.stdin.on('data',d=>{if(d.includes('\x04'))process.exit(0);wire+=d;while(wire){if(wire.startsWith(start)){const at=wire.indexOf(end,start.length);if(at<0)break;composer+=wire.slice(start.length,at);wire=wire.slice(at+end.length);repaint();continue;}if(start.startsWith(wire))break;const next=wire.indexOf(start);const take=next<0?wire.length:next;const text=wire.slice(0,take);wire=wire.slice(take);for(const c of text){if(c==='\\r')submit();else composer+=c;}repaint();}});",
    ].join('');
    const signalSource = new EventEmitter();
    const onRespawn = vi.fn(async () => true);
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath, args: ['-e', childCode, ...(isResume ? ['resume'] : [])], cwd: root,
        env: {
          ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome, NATIVE_FILE: nativeFile, SUBMIT_FILE: submitFile,
          NATIVE_PUBLICATION: nativePublication, NATIVE_RELEASE_FILE: nativeReleaseFile,
          [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: proofToken,
          // This child models transcript persistence, with no provider. Keep
          // the production quota grace out of its receipt/cleanup ordering.
          PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '1',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000',
          PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: '1000',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          TERM: 'xterm-256color',
        },
        ownerId, io, bridgeTty: false, kickoff,
        nativePersistenceTimeoutMs: 500,
        signalSource, onRespawn, onExit: () => undefined,
      });
      await vi.waitFor(() => expect(existsSync(submitFile), captured()).toBe(true), { timeout: 2500 });
      expect(readFileSync(submitFile, 'utf8')).toBe(kickoff);
      // Fresh launches stage the marker head for echo verification. Resumes
      // paste the existing thread's full turn, whose viewport shows only its
      // tail; submitted bytes and native proof remain the shared contract.
      if (!isResume) expect(captured()).toContain('COMPOSER_ECHO:' + marker);
      if (nativePublication === 'gated') {
        // Submission precedes transcript publication. The old immediate read
        // fails here while the host is live and the fixture home is intact.
        expect(existsSync(sock)).toBe(true);
        expect(existsSync(root)).toBe(true);
        expect(() => readFileSync(nativeFile, 'utf8')).toThrowError(expect.objectContaining({ code: 'ENOENT' }));
        writeFileSync(nativeReleaseFile, 'publish');
      }
      await vi.waitFor(() => expect(readFileSync(nativeFile, 'utf8')).toContain(marker), { timeout: 1500 });
      if (receiptAllowed) {
        await vi.waitFor(() => {
          const proof = readFileSync(proofPath, 'utf8');
          expect(proof.length).toBeGreaterThan(0);
          expect(JSON.parse(proof)).toEqual({
            token: proofToken, persisted: true, nativeRef: nativeFile, reason: null,
          });
        }, { timeout: 1500 });
      } else {
        await vi.waitFor(() => {
          const rows = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
            .trim().split('\n').map(line => JSON.parse(line));
          expect(rows.find(row => row.kind === 'kickoff-proof-receipt-publication-failed'))
            .toMatchObject({
              persisted: true,
              reason: 'kickoff-proof-receipt-publish-failed',
              errorMessage: 'kickoff-proof placeholder is not an empty 0600 file',
            });
        }, { timeout: 1500 });
        expect(readFileSync(proofPath, 'utf8')).toBe('reserved');
      }
      // The kickoff's native proof must keep using its submitted child after
      // injectLaunchKickoff returns. A block-scoped reference here killed the
      // real resumed worker after its prompt was already durably delivered.
      expect(onRespawn).toHaveBeenCalledWith(nativeId, expect.objectContaining({ onConfirmed: expect.any(Function) }));
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(events.find(row => row.kind === 'launch-native-binding-confirmed')).toMatchObject({ nativeId });
      expect(events.some(row => row.kind === 'managed-kickoff-failed')).toBe(false);
      expect(existsSync(sock)).toBe(true);
    } finally {
      // Keep the fixture alive until the parent finishes proof assertions;
      // fixed child lifetimes race the gated transcript publication and cleanup.
      signalSource.emit('SIGTERM');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 7000);

  it.each([true, false])('keeps a staged Codex marker through a Starting repaint (recovers=%s)', async (recovers) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-codex-staged-starting-'));
    const nativeFile = join(root, 'codex-home', 'sessions', 'rollout.jsonl');
    const proofPath = join(root, 'proof.json');
    const ownerId = `su-staged-starting-${process.pid}-${Math.floor(performance.now())}`;
    const marker = '⟦turn-origin:session-port nonce:0123456789abcdef⟧';
    const kickoff = `${marker}\nSTAGED-STARTING-PAYLOAD`;
    const { captured, io } = fakeIo();
    const signals = new EventEmitter();
    writeFileSync(proofPath, '', { mode: 0o600 });
    const childCode = [
      "const fs=require('fs'),path=require('path');",
      "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let input='',echoed=false,starting=false,submitted=false;",
      "process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\nReady · GPT-6.1-Sol xhigh · Context 100% left\\n');",
      "process.stdin.on('data',d=>{if(starting){process.stdout.write('UNSAFE_WRITE_WHILE_STARTING\\n');return;}input+=d;",
      "if(!echoed&&input.includes('⟧')){echoed=true;starting=true;process.stdout.write('COMPOSER_ECHO:'+input+'\\nStarting · GPT-6.1-Sol xhigh · Context 100% left\\n');",
      "if(process.env.RECOVERS==='1')setTimeout(()=>{starting=false;process.stdout.write('Ready · GPT-6.1-Sol xhigh · Context 100% left\\n');},300);return;}",
      "if(!submitted&&input.includes('STAGED-STARTING-PAYLOAD')&&d.includes('\\r')){submitted=true;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const at=new Date().toISOString();const rows=[{type:'response_item',timestamp:at,payload:{type:'message',role:'user',content:[{type:'input_text',text:input}]}},{type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:'staged-1'}},{type:'event_msg',timestamp:at,payload:{type:'task_complete',turn_id:'staged-1'}}];fs.writeFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));process.stdout.write('SUBMITTED_ONCE\\n');}});",
    ].join('');
    const startedAt = Date.now();
    const done = hostThroughPty({
      command: execPath, args: ['-e', childCode], cwd: root,
      env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex',
        CODEX_HOME: join(root, 'codex-home'), NATIVE_FILE: nativeFile, RECOVERS: recovers ? '1' : '0',
        [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: 'd'.repeat(48),
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '25', PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50', PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2', PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '2000',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000', PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES: '0',
        PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '100',
        TERM: 'xterm-256color' },
      ownerId, io, bridgeTty: false, signalSource: signals, kickoff,
      nativePersistenceTimeoutMs: 2000,
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('COMPOSER_ECHO:'), { timeout: 3000 });
      await vi.waitFor(() => expect(readFileSync(proofPath, 'utf8'), captured()).not.toBe(''), { timeout: 6000 });
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(captured()).not.toContain('UNSAFE_WRITE_WHILE_STARTING');
      if (recovers) {
        expect(proof, JSON.stringify(events)).toMatchObject({ persisted: true, reason: null });
        const text = JSON.parse(readFileSync(nativeFile, 'utf8').trim().split('\n')[0]).payload.content[0].text;
        expect(text.split(marker)).toHaveLength(2);
        expect(text.split('STAGED-STARTING-PAYLOAD')).toHaveLength(2);
        expect(events.some(row => row.kind === 'startup-turn-dropped')).toBe(false);
      } else {
        expect(proof).toMatchObject({ persisted: false, reason: 'kickoff-not-submitted:codex-startup-still-starting' });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
        expect(existsSync(nativeFile)).toBe(false);
        expect(captured()).not.toContain('SUBMITTED_ONCE');
      }
    } finally {
      signals.emit('SIGTERM');
      await done;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('passes the Codex model offer by keeping the configured model before seeding the first turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-codex-model-choice-'));
    const codexHome = join(root, 'codex-home');
    const nativeFile = join(codexHome, 'sessions', '2026', '09', '24', 'rollout.jsonl');
    const choiceFile = join(root, 'model-choice.txt');
    const proofPath = join(root, 'kickoff-proof.json');
    const proofToken = 'c'.repeat(48);
    writeFileSync(proofPath, '', { mode: 0o600 });
    chmodSync(proofPath, 0o600);
    const ownerId = `su-codex-model-choice-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
    const { captured, io } = fakeIo();
    const childCode = [
      "const fs=require('fs'),path=require('path');",
      "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let input='',chosen=false,echoed=false,submitted=false,ticksStarted=false;",
      "process.stdout.write('\\x1b[6nOpenAI Codex (v0.156.1)\\nmodel: loading\\nMeet GPT-6 Sol\\n› 1. Try new model\\n2. Use existing model\\n');",
      "process.stdin.on('data',d=>{input+=d;if(!chosen){const at=input.indexOf('\\x1b[B\\r');if(at<0)return;chosen=true;fs.writeFileSync(process.env.CHOICE_FILE,'existing');input=input.slice(at+4);process.stdout.write('model: GPT-5.6-Sol high\\nReady · gpt-5.6-sol high · Context 100% left\\n');}",
      "if(!echoed&&input.includes('⟧')){echoed=true;process.stdout.write('COMPOSER_ECHO:'+input+'\\n');}",
      "if(echoed&&!submitted&&d.includes('\\r')){submitted=true;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const ts=new Date().toISOString();const rows=[{type:'response_item',timestamp:ts,payload:{type:'message',role:'user',content:[{type:'input_text',text:input}]}},{type:'event_msg',timestamp:ts,payload:{type:'task_started',turn_id:'choice-1'}},{type:'response_item',timestamp:ts,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}},{type:'event_msg',timestamp:ts,payload:{type:'task_complete',turn_id:'choice-1'}}];fs.appendFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));setTimeout(()=>process.stdout.write('KICKOFF_COUNT_1\\n'),75);}else if(submitted&&d.includes('\\r')){setTimeout(()=>process.stdout.write('RESUBMIT_ACK\\n'),75);}if(input.includes('QUIT'))process.exit(0);});",
      "process.stdin.on('data',()=>{if(!submitted||ticksStarted)return;ticksStarted=true;let n=0;const timer=setInterval(()=>{process.stdout.write('MODEL_TICK_'+(++n)+'\\n');if(n===15)clearInterval(timer);},50);});",
      'setTimeout(()=>process.exit(0),7000);',
    ].join('');
    let done;
    try {
      done = hostThroughPty({
        command: execPath, args: ['-e', childCode], cwd: root,
        env: {
          ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_HEADLESS: '1', CODEX_HOME: codexHome,
          NATIVE_FILE: nativeFile, CHOICE_FILE: choiceFile,
          [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: proofToken,
          // The headless model-choice redraw can take the host's bounded 2s
          // fallback; the startup budget must outlive that real actuator.
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '1000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          // This fake child has no provider; the production 10s quota grace
          // would outlive its 7s lifetime and this fixture's receipt deadline.
          PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '1',
          TERM: 'xterm-256color',
        },
        ownerId, io, bridgeTty: false,
        kickoff: `${marker}\nBEGIN_MODEL_CHOICE`,
        nativePersistenceTimeoutMs: 2_000,
        signalSource: new EventEmitter(), onExit: () => undefined,
      });
      await vi.waitFor(() => expect(readFileSync(proofPath, 'utf8'), captured()).not.toBe(''), { timeout: 8_000 });
      const eventsPath = eventLogPathForOwner(ownerId);
      const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '(no host events)';
      expect(existsSync(choiceFile), `${captured()}\n${events}`).toBe(true);
      expect(readFileSync(choiceFile, 'utf8')).toBe('existing');
      expect(captured()).toContain('COMPOSER_ECHO:');
      expect(readFileSync(nativeFile, 'utf8')).toContain(marker);
      expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual({
        token: proofToken, persisted: true, nativeRef: nativeFile, reason: null,
      });
      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);

  // File publication can precede delivery of the child's stdout to the host.
  // The delayed case keeps that observation gap in the maintained suite.
  it.each([0, 150])('does not resend a kickoff whose native turn completed before marker proof returned (count output delayed %d ms)', async (outputDelayMs) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-fast-kickoff-'));
    const codexHome = join(root, 'codex-home');
    const nativeFile = join(codexHome, 'sessions', '2026', '09', '23', 'rollout.jsonl');
    const countFile = join(root, 'kickoff-count.txt');
    const ownerId = `su-fast-kickoff-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:abcdef0123456789⟧';
    const kickoff = `${marker}\nBEGIN_FAST_KICKOFF`;
    const { captured, io } = fakeIo();
    const signalSource = new EventEmitter();
    const childCode = [
      "const fs=require('fs'),path=require('path');",
      "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let markerEchoed=false;process.stdin.on('data',d=>{if(!markerEchoed&&d.includes('⟧')){markerEchoed=true;echoScheduled=true;process.stdout.write('COMPOSER_ECHO:'+d+'\\n');}});",
      "let input='',seen=0,echoScheduled=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\n');",
      "const printKickoffCount=seen=>{const emit=()=>process.stdout.write('KICKOFF_COUNT_'+seen+'\\n');const delay=Number(process.env.KICKOFF_COUNT_STDOUT_DELAY_MS);if(delay>0)setTimeout(emit,delay);else emit();};",
      "process.stdin.on('data',d=>{input+=d;const matches=input.match(/BEGIN_FAST_KICKOFF/g)||[];if(!echoScheduled&&matches.length){echoScheduled=true;const echo=input;setTimeout(()=>process.stdout.write('COMPOSER_ECHO:'+echo+'\\n'),75);}while(seen<matches.length){seen++;if(seen===1){fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const at=new Date().toISOString();const turn='fast-'+seen;const rows=[{type:'response_item',timestamp:at,payload:{type:'message',role:'user',content:[{type:'input_text',text:input}]}},{type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:turn}},{type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}},{type:'event_msg',timestamp:at,payload:{type:'task_complete',turn_id:turn}}];fs.appendFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));}fs.appendFileSync(process.env.COUNT_FILE,seen+'\\n');printKickoffCount(seen);}if(seen>0&&d.includes('\\r'))process.stdout.write('RESUBMIT_ACK\\n');if(input.includes('QUIT'))process.exit(0);});",
    ].join('');
    let done;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome,
          NATIVE_FILE: nativeFile,
          COUNT_FILE: countFile,
          KICKOFF_COUNT_STDOUT_DELAY_MS: String(outputDelayMs),
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS: '10',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS: '1',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        nativePersistenceTimeoutMs: 2_000,
        signalSource,
        onExit: () => undefined,
      });

      await vi.waitFor(() => {
        expect(existsSync(countFile), captured()).toBe(true);
        expect(captured()).toContain('KICKOFF_COUNT_1');
        const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(events.some(event => event.kind === 'turn-delivered' && event.confirmed === 'native')).toBe(true);
      }, { timeout: 8000 });
      const phaseEvidence = JSON.stringify({
        count: existsSync(countFile) ? readFileSync(countFile, 'utf8').trim() : null,
        nativePublished: existsSync(nativeFile),
        output: captured(),
      });
      expect(existsSync(countFile), phaseEvidence).toBe(true);
      expect(captured(), phaseEvidence).toContain('KICKOFF_COUNT_1');
      await sleep(400); // enough for the bounded one-poll retry path to expose a duplicate
      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
      expect(readFileSync(countFile, 'utf8').trim().split(/\r?\n/)).toEqual(['1']);
      expect(readFileSync(nativeFile, 'utf8')).toContain('task_complete');
      const output = captured();
      expect(output.indexOf(`COMPOSER_ECHO:${marker}`)).toBeGreaterThanOrEqual(0);
      expect(output.indexOf(`COMPOSER_ECHO:${marker}`)).toBeLessThan(output.indexOf('KICKOFF_COUNT_1'));
    } finally {
      signalSource.emit('SIGTERM');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('suppresses a queued retry when native execution begins before the final write boundary', () => {
    let started = false;
    const nativeTurnActivity = () => ({ available: true, started });
    expect(firstKickoffTurnStartedBeforeRetry(nativeTurnActivity)).toBe(false);
    started = true; // the original turn starts while the retry waits for the prompt
    expect(firstKickoffTurnStartedBeforeRetry(nativeTurnActivity)).toBe(true);
    expect(firstKickoffTurnStartedBeforeRetry(() => { throw new Error('unreadable transcript'); })).toBe(false);
    expect(firstKickoffTurnStartedBeforeRetry(null)).toBe(false);
  });

  it('does not rewrite a queued kickoff after its first native turn starts beyond the bounded tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-delayed-kickoff-'));
    const codexHome = join(root, 'codex-home');
    const nativeFile = join(codexHome, 'sessions', '2026', '09', '26', 'rollout.jsonl');
    const countFile = join(root, 'kickoff-count.txt');
    const ownerId = `su-delayed-kickoff-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:abcdef0123456789⟧';
    const { captured, io } = fakeIo();
    const childCode = [
      "const fs=require('fs'),path=require('path');process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "const appendNative=fs.appendFileSync;let padded=false;fs.appendFileSync=(file,data,...args)=>{if(!padded&&file===process.env.NATIVE_FILE&&String(data).includes('task_started')){padded=true;appendNative(file,JSON.stringify({type:'system',payload:{text:'x'.repeat(300*1024)}})+'\\n');}return appendNative(file,data,...args);};",
      "let input='',pending='',submitted=0,echoed=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\n');",
      "process.stdin.on('data',d=>{input+=d;pending+=d;if(!echoed&&input.includes('⟧')){echoed=true;process.stdout.write('COMPOSER_ECHO:'+input+'\\n');}",
      "if(d.includes('\\r')){if(pending.includes('BEGIN_DELAYED_KICKOFF')){submitted++;fs.appendFileSync(process.env.COUNT_FILE,submitted+'\\n');if(submitted===1){",
      "fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const ts=new Date().toISOString();fs.writeFileSync(process.env.NATIVE_FILE,JSON.stringify({type:'response_item',timestamp:ts,payload:{type:'message',role:'user',content:[{type:'input_text',text:input}]}})+'\\n');",
      "const tick=setInterval(()=>process.stdout.write('MODEL_BUSY\\n'),10);",
      // Keep the TUI busy after task_started is persisted. The retry must notice
      // the native start and abort from inside the busy gate without writing.
      "const startWhenRetryQueued=setInterval(()=>{if(!fs.existsSync(process.env.EVENT_LOG_FILE)||!fs.readFileSync(process.env.EVENT_LOG_FILE,'utf8').includes('launch-kickoff-model-turn-absent'))return;clearInterval(startWhenRetryQueued);fs.appendFileSync(process.env.NATIVE_FILE,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'delayed-1'}})+'\\n');process.stdout.write('MODEL_STARTED\\n');setTimeout(()=>clearInterval(tick),250);},10);",
      "}else process.stdout.write('DUPLICATE_KICKOFF\\n');}else process.stdout.write('RESUBMIT_ACK\\n');pending='';}",
      "if(input.includes('QUIT'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),8000);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath, args: ['-e', childCode], cwd: root,
        env: {
          ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome, NATIVE_FILE: nativeFile, COUNT_FILE: countFile,
          EVENT_LOG_FILE: eventLogPathForOwner(ownerId),
          // Native retry ordering is the oracle here; the synthetic child
          // does not model a provider's delayed quota response.
          PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '1',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS: '10',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS: '1',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          TERM: 'xterm-256color',
        },
        ownerId, io, bridgeTty: false,
        kickoff: `${marker}\nBEGIN_DELAYED_KICKOFF`,
        nativePersistenceTimeoutMs: 2_000,
        signalSource: new EventEmitter(), onExit: () => undefined,
      });
      await vi.waitFor(() => {
        expect(captured()).toContain('MODEL_STARTED');
        expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
          .toContain('launch-kickoff-model-turn-retry-skipped');
      }, { timeout: 5_000 });
      const transcript = readFileSync(nativeFile, 'utf8');
      const markerOffset = transcript.indexOf(marker);
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      expect(Buffer.byteLength(transcript.slice(markerOffset))).toBeGreaterThan(256 * 1024);
      expect(readFileSync(countFile, 'utf8').trim().split(/\r?\n/)).toEqual(['1']);
      expect(captured()).not.toContain('DUPLICATE_KICKOFF');
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('does not submit a fresh Codex kickoff when the composer echo lost leading marker bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-truncated-marker-'));
    const codexHome = join(root, 'codex-home');
    const submitFile = join(root, 'submitted.txt');
    const ownerId = `su-truncated-marker-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:fedcba9876543210⟧';
    const kickoff = `${marker}\nBEGIN_TRUNCATED_ECHO`;
    const { captured, io } = fakeIo();
    const childCode = [
      "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let input='',echoed=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\n');",
      "process.stdin.on('data',d=>{input+=d;if(!echoed&&input.includes('⟧')){echoed=true;process.stdout.write('COMPOSER_ECHO:'+input.slice(34)+'\\n');}if(d.includes('\\r')){require('fs').appendFileSync(process.env.SUBMIT_FILE,'submitted\\n');process.stdout.write('SUBMITTED\\n');}if(input.includes('QUIT'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),2000);',
    ].join('');
    let done;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome,
          SUBMIT_FILE: submitFile,
          PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: '150',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        signalSource: new EventEmitter(),
        onExit: () => undefined,
      });

      await vi.waitFor(() => expect(captured()).toContain('COMPOSER_ECHO:'), { timeout: 2_000 });
      await sleep(300); // the bounded marker proof must time out before any CR is sent
      const output = captured();
      expect(output).toContain(marker.slice(34));
      expect(output).not.toContain(`COMPOSER_ECHO:${marker}`);
      expect(existsSync(submitFile)).toBe(false);
      await rawInject(sock, 'QUIT\\n');
      expect(await done).toBe(0);
      expect(existsSync(submitFile)).toBe(false);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\\n');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('waits beyond two seconds for a complete Codex composer echo before submitting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-delayed-marker-'));
    const codexHome = join(root, 'codex-home');
    const submitFile = join(root, 'submitted.txt');
    const ownerId = `su-delayed-marker-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:1234567890abcdef⟧';
    const kickoff = `${marker}\nBEGIN_DELAYED_ECHO`;
    const { captured, io } = fakeIo();
    const childCode = [
      "const fs=require('fs');process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let input='',echoScheduled=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\n');",
      "process.stdin.on('data',d=>{input+=d;if(!echoScheduled&&input.includes('⟧')){echoScheduled=true;setTimeout(()=>process.stdout.write('COMPOSER_ECHO:'+input+'\\n'),2500);}if(d.includes('\\r')){fs.appendFileSync(process.env.SUBMIT_FILE,'submitted\\n');process.stdout.write('SUBMITTED\\n');}if(input.includes('QUIT'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),7000);',
    ].join('');
    let done;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome,
          SUBMIT_FILE: submitFile,
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '5000',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        signalSource: new EventEmitter(),
        onExit: () => undefined,
      });
      await sleep(2_100);
      expect(existsSync(submitFile)).toBe(false);
      await vi.waitFor(() => expect(existsSync(submitFile)).toBe(true), { timeout: 4_000 });
      const output = captured();
      expect(output.indexOf(`COMPOSER_ECHO:${marker}`)).toBeGreaterThanOrEqual(0);
      expect(output.indexOf(`COMPOSER_ECHO:${marker}`)).toBeLessThan(output.indexOf('SUBMITTED'));
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
      expect(events).toContain('launch-kickoff-marker-echo-pending');
      expect(events).toContain('launch-kickoff-marker-echo-confirmed');
      await rawInject(sock, 'QUIT\\n');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\\n');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);
});

describe('Claude launch kickoff bracketed-paste regression (EI-24141825238362808)', () => {
  it('submits the complete long kickoff in the paste frame advertised by the child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-bracketed-kickoff-'));
    const ownerId = `su-claude-bracketed-kickoff-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const kickoff = `⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧\n${'feature-run-trace,'.repeat(520)}`;
    const kickoffHash = createHash('sha256').update(kickoff).digest('hex');
    const expected = `KICKOFF_SUBMITTED:${Buffer.byteLength(kickoff)}:${kickoffHash}`;
    const { captured, io } = fakeIo();
    const childCode = [
      "const crypto=require('node:crypto');",
      "try{process.stdin.setRawMode?.(true);}catch{}",
      "process.stdin.setEncoding('utf8');",
      "let wire='',reported=false;",
      "process.stdout.write('\\x1b[?2004h\\nREADY\\n❯ \\n');",
      "process.stdin.on('data',d=>{wire+=d;if(reported||!wire.includes('\\r'))return;reported=true;const start='\\x1b[200~',end='\\x1b[201~';const a=wire.indexOf(start),b=wire.indexOf(end,a+start.length),enter=wire.indexOf('\\r');if(a<0||b<a+start.length||enter<b+end.length){process.stdout.write('KICKOFF_FRAME_MISSING\\n');return;}const text=wire.slice(a+start.length,b);const hash=crypto.createHash('sha256').update(text).digest('hex');process.stdout.write('KICKOFF_SUBMITTED:'+Buffer.byteLength(text)+':'+hash+'\\n');});",
      "process.stdin.on('data',d=>{if(d.includes('\\u0004'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),12000);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '25',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '20',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        onExit: () => {},
      });

      const deadline = Date.now() + 8_000;
      while (
        !captured().includes(expected) &&
        !captured().includes('KICKOFF_FRAME_MISSING') &&
        Date.now() < deadline
      ) {
        await sleep(10);
      }
      expect(captured()).not.toContain('KICKOFF_FRAME_MISSING');
      expect(captured()).toContain(expected);
      await controlInject(sock, 'raw', '\x04');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await controlInject(sock, 'raw', '\x04');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('Codex resumed and forked quota history (EI-22609012864215464, EI-22800121604015331)', () => {
  it.each([
    ['resume', 'control'],
    ['resume', 'kickoff'],
    ['fork', 'control'],
    ['fork', 'kickoff'],
  ] as const)('%s %s submits after a replayed wall and still blocks a new wall', async (subcommand, route) => {
    const ownerId = `su-quota-replay-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const meta = metaPathFor(ownerId);
    const { captured, io } = fakeIo();
    const childCode =
      "process.stdout.write(\"You've hit your usage limit.\\n60% context left\\n\");" +
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
      "if(line==='QUIT')process.exit(0);" +
      "if(line==='WALL')process.stdout.write(\"You've hit your usage limit.\\n\");" +
      "else process.stdout.write('ECHO:'+line+'\\n');}});" +
      'setTimeout(()=>process.exit(0),12000);';
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode, subcommand, '11111111-1111-4111-8111-111111111111'],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource: new EventEmitter(),
      kickoff: route === 'kickoff' ? 'RECOVERED' : null,
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('60% context left'), { timeout: 3000 });
      if (route === 'control') await controlInject(sock, 'turn', 'RECOVERED');
      await vi.waitFor(() => expect(captured()).toContain('ECHO:RECOVERED'), { timeout: 3000 });
      expect(JSON.parse(readFileSync(meta, 'utf8')).quotaBlocked).toBe(false);

      await rawInject(sock, 'WALL\n');
      await vi.waitFor(() => expect(JSON.parse(readFileSync(meta, 'utf8')).quotaBlocked).toBe(true));
      await controlInject(sock, 'turn', 'SHOULD-NOT-RUN');
      await vi.waitFor(() => expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
        .toContain('turn-deferred-quota-blocked'));
      expect(captured()).not.toContain('ECHO:SHOULD-NOT-RUN');
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done;
    }
  }, 18000);
});

// EI-18683281603125383: the server (psu-pty-host.mjs, WI-5872/EI-18676244363359331)
// now writes a JSON-line ACK/NACK back on the connection (`allowHalfOpen:true`)
// BEFORE calling `conn.end()`. A client that never attaches a 'data' listener
// (nor calls .resume()/.pipe()) leaves its Readable side PAUSED — Node only
// advances a paused stream to 'end' once something starts consuming it — so
// with unconsumed ACK bytes sitting in the socket's internal buffer, 'end' (and
// therefore 'close') never fires. That silently hung every helper below
// forever the moment the server started acking (confirmed independent of any
// pty/vitest/CPU-load involvement via a minimal bare `net` repro: a plain
// allowHalfOpen server that writes+ends after a client with no 'data' listener
// never sees 'close', deterministically, in <1s). Draining the payload (even
// via a no-op 'data' handler) puts the stream in flowing mode so 'end'/'close'
// fire normally; these helpers only ever cared about "did the connection settle",
// never the ACK payload itself, so discarding it is the correct minimal fix —
// production's own injectIntoHost() (psu-pty-discovery.ts) already reads this
// same ACK for real and was unaffected.
function rawInject(sock: string, data: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'raw', data, ownerId: basename(sock, '.sock') }));
      c.end();
    });
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

function controlInject(sock: string, mode: 'turn' | 'raw' | 'osc' | 'reset' | 'recycle', data: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode, data, ownerId: basename(sock, '.sock') }));
      c.end();
    });
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

function envelopeInject(sock: string, envelope: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(JSON.stringify({ v: 1, ...envelope }));
      c.end();
    });
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// WI-2339 defect #2 (2026-07-04) added a process-IDENTITY check to findLiveHost /
// interruptViaPty: the discovered pid's /proc/<pid>/cmdline must match
// /psu-(launcher|pty-host)/, so a recycled pid held by an unrelated process can't
// masquerade as a live host. This file hosts the pty IN-PROCESS (hostThroughPty runs
// inside the vitest worker, which records `pid: process.pid` — the WORKER's own pid,
// whose cmdline is the vitest runner, not a psu-launcher/psu-pty-host process), so a
// bare findLiveHost()/interruptViaPty() call here fails that check post-WI-2339 even
// though the discovered host is a perfectly valid stand-in for this test — this was a
// real, deterministic (not flaky) regression: EI-7725. psu-pty-discovery.test.ts's own
// `ID_OK` seam is the documented fix (see findLiveHost's doc comment: "A test writing
// `process.pid` as a live-host stand-in injects `() => true`"), already applied in the
// sibling psu-pty-host-turn.integration.test.ts — mirrored here.
const ID_OK = { verifyIdentity: () => true } as const;

describe('session-port managed seed + native persistence helpers', () => {
  it('waits for OMP backend startup rather than treating terminal-query noise as editor readiness', () => {
    expect(startupOutputReady('omp', '\x1b[6n\x1b[?25l')).toBe(false);
    expect(startupOutputReady('omp', '\x1b[2J omp v16.3.3 \x1b[0m')).toBe(true);
  });

  // WI-4943: a live Claude→Codex port wrote its managed seed while Codex was
  // still typewriter-animating its onboarding "Tip: ..." line (and, sometimes,
  // an MCP-startup warning typed the same way) — long before the composer
  // existed. The PTY host's OLD codex behavior (any non-empty output ⇒ ready)
  // treated that animation's very first byte, or any mid-typing frame, as
  // startup-ready. Verified against a real captured `codex` v0.146.0 PTY boot
  // (character-by-character cursor-reposition repaint) and the shipped
  // `@openai/codex-linux-x64` binary's own embedded composer-footer strings
  // ("NN% context left" is chrome the TUI only paints once its editable input
  // line is installed).
  it('waits for the Codex composer footer rather than its first output byte or onboarding-tip animation', () => {
    // The very first byte a fresh Codex TUI emits is bare terminal-capability
    // probe noise, not proof of readiness.
    expect(startupOutputReady('codex', '\x1b[6n')).toBe(false);
    // A mid-animation frame of the real onboarding-tip typewriter effect (one
    // character per repaint, via save/restore-cursor + line-clear escapes) —
    // still not the composer.
    const tipAnimationFrame =
      '\x1b[?2026h\x1b[1;1H\x1b[2K\x1b[1m  T\x1b[0m\x1b7\x1b8\x1b[1B\x1b[1G\x1b[2K\x1b[1m  i\x1b[0m' +
      '\x1b7\x1b8\x1b[1B\x1b[1G\x1b[2K\x1b[1m  p\x1b[0m\x1b[?2026l';
    expect(startupOutputReady('codex', tipAnimationFrame)).toBe(false);
    // A quiet gap can also open mid-animation, right after the tip finishes and
    // before Codex resumes typing an MCP-startup warning the same way — still
    // not the composer, and exactly the pause an ordinary quiescence check
    // could misread as "settled at a prompt".
    expect(startupOutputReady('codex', '\x1b[1m  together.\x1b[0m')).toBe(false);
    // The composer's live context-budget readout is real chrome, not user
    // content — present only once the editable input line exists.
    expect(startupOutputReady('codex', '\x1b[38;5;244m100\x1b[0m% context left')).toBe(true);
    expect(startupOutputReady('codex', ' 62%  context left ')).toBe(true);
  });

  // WI-10002745: Codex ≥0.156 paints its idle readout as a status footer and
  // shows the legacy "NN% context left" form only while a turn is RUNNING, so
  // the legacy pattern alone never proved readiness before the first turn.
  // Every fresh Codex kickoff then fell to the 15s blind-write fallback and lost
  // its leading marker bytes. Frames below are verbatim (ANSI included) from a
  // captured v0.156.1 grading-auditor boot.
  it('recognises the Codex >=0.156 status footer, and only once its status is past Starting', () => {
    const readyFooter =
      '\x1b[2m╰──╯\x1b[0m  › Ask Codex to do anything   Ready' +
      ' \xb7 GPT-5.6-Sol default\x1b[39;49m \xb7 \x1b[38;5;216;49mContext 100% left' +
      '\x1b[39m\x1b[49m\x1b[0m\x1b[1;1H\x1b[0 q';
    expect(startupOutputReady('codex', readyFooter)).toBe(true);
    // Same footer while MCP servers are still booting: the composer is not yet
    // accepting input, so this must NOT authorize the kickoff write.
    const startingFooter =
      '› Ask Codex to do anything   Starting \xb7 GPT-5.6-Sol high \xb7 Context 100% left';
    expect(startupOutputReady('codex', startingFooter)).toBe(false);
    // Cursor motion can be stripped from accumulated scrollback, flattening a repaint
    // into `anythingReady` / `anythingStarting`. Normalize only these known suffixes.
    expect(startupOutputReady(
      'codex',
      FLATTENED_CODEX_READY_FOOTER,
    )).toBe(true);
    expect(startupOutputReady(
      'codex',
      FLATTENED_CODEX_STARTING_FOOTER,
    )).toBe(false);
    // A later Ready repaint in the same accumulated buffer does prove readiness.
    expect(startupOutputReady('codex', startingFooter + '\x1b[22;3H' + readyFooter)).toBe(true);
    // A later Starting repaint revokes an earlier Ready footer in the same buffer.
    expect(startupOutputReady('codex', readyFooter + '\x1b[22;3H' + startingFooter)).toBe(false);
    // The footer text inside ordinary prose (no status/model segments) is not chrome.
    expect(startupOutputReady('codex', 'the Context 100% left readout')).toBe(false);
  });

  it('control: exact status equality misses the flattened Ready suffix', () => {
    // The preceding imported-subject test is the calibration: Ready must pass
    // and Starting must remain blocked. Keep this plausible old matcher wrong
    // so the paired expectations prove they detect loss of suffix normalization.
    const wrong = [
      exactStatusOnlyCodexReady(FLATTENED_CODEX_READY_FOOTER),
      exactStatusOnlyCodexReady(FLATTENED_CODEX_STARTING_FOOTER),
    ];
    const actual = [
      startupOutputReady('codex', FLATTENED_CODEX_READY_FOOTER),
      startupOutputReady('codex', FLATTENED_CODEX_STARTING_FOOTER),
    ];
    expect(wrong).toEqual([false, false]);
    expect(actual).toEqual([true, false]);
    expect(wrong).not.toEqual(actual);
  });

  // WI-10002752: a Codex carry-respawn types the carry document as its first
  // turn. Replacing the operator's first prompt with it wholesale lost the
  // leading turn-origin line, so every Codex carry failed its native turn-start
  // proof ('missing-leading-turn-origin') and was recorded as dropped.
  it('keeps the original turn-origin line first when composing a Codex carry turn', () => {
    const marker = '⟦turn-origin:watchdog nonce:9a9f319ccba4fdf4⟧';
    const original = `${marker}\nADDRESSED TO su-x — continue from the carry.`;
    const minted = '# Carry document (deterministic)\n\nbody\n\n[lineage: predecessor 01a0]';

    const composed = composeCarryTurnText(original, minted);
    expect(leadingTurnOriginMarker(composed)).toBe(marker);
    expect(composed).toBe(`${marker}\nADDRESSED TO su-x — continue from the carry.\n\n${minted}`);
    // CRLF input still yields exactly one marker line and the whole minted text.
    expect(composeCarryTurnText(`${marker}\r\nbody`, minted)).toBe(`${marker}\nbody\n\n${minted}`);
    // A marker-only first prompt keeps the marker and appends the minted text.
    expect(composeCarryTurnText(marker, minted)).toBe(`${marker}\n${minted}`);

    // The composed text is what the proof reads: without the fix it refused.
    expect(leadingTurnOriginMarker(minted)).toBeNull();

    // Nothing to preserve: an unmarked original, or a minted text that already
    // leads with its own marker, keeps the minted text unchanged.
    expect(composeCarryTurnText('plain carry-note', minted)).toBe(minted);
    const markedMinted = `${marker}\n${minted}`;
    expect(composeCarryTurnText(original, markedMinted)).toBe(markedMinted);
    // An empty mint never erases the operator's prompt.
    expect(composeCarryTurnText(original, '')).toBe(original);
    expect(composeCarryTurnText(original, undefined)).toBe(original);
  });

  it('delivers an identical carry body only once while retaining provenance and lineage', () => {
    const marker = '⟦turn-origin:self-compaction nonce:0123456789abcdef⟧';
    const body = '# Carry document\n\nPending directive: preserve the owner choice.\n\n' + 'saved evidence\n'.repeat(5000).trimEnd();
    const lineage = '⟦codex-carry-lineage predecessor:0123abcd-1234-5678-9abc-def012345678⟧';
    const minted = `${body}\n\n${lineage}`;
    const composed = composeCarryTurnText(`${marker}\n${body}`, minted);
    expect(composed).toBe(`${marker}\n${minted}`);
    expect(leadingTurnOriginMarker(composed)).toBe(marker);
    expect(composed.split('# Carry document')).toHaveLength(2);
    expect(composeCarryTurnText(`${marker}\n${body}`, body)).toBe(`${marker}\n${body}`);
  });

  it('retains a distinct continuation body even if the mint contains a similar substring', () => {
    const marker = '⟦turn-origin:self-compaction nonce:0123456789abcdef⟧';
    const body = 'Keep the pending owner directive';
    for (const minted of [`# Carry\n\n${body}`, `${body} with more context`, `${body}\nchanged`]) {
      expect(composeCarryTurnText(`${marker}\n${body}`, minted)).toBe(`${marker}\n${body}\n\n${minted}`);
    }
  });

  // WI-10002745: the PTY child is the psu launcher, which prints its banner and
  // then bootstraps the role for ~20s before Codex execs. After exec, Codex
  // sends terminal-capability probes and reads stdin for the replies until it
  // schedules its first frame; any input in that window is swallowed. That wait
  // is bimodal (Codex's own log, 41 launches on 2026-09-23: p50 698ms, p90 13.9s,
  // max 14.1s). A 15s window from the banner, and then one from the probe, both
  // typed the kickoff into it and lost the leading provenance marker. The
  // fallback must be measured from the first frame Codex PAINTS.
  it('measures the Codex startup fallback from the first painted frame, not the banner or the probe', () => {
    // Verbatim bytes of a captured v0.156.1 boot (grading-audit
    // EI-24067277488814126, 2026-09-23): the probe burst, then the first frame.
    const launcherBanner = 'psu: kickoff — seeding the role session’s first turn\n';
    const codexProbe = '\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c';
    const firstFrame =
      '\x1b[?25l\x1b[1;1H\x1b[2m╭───────────────────────────────────────────────╮\x1b[2;1H│ >_ ' +
      '\x1b[22m\x1b[1mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.156.1)                    │';
    expect(codexTuiStartObserved(launcherBanner)).toBe(false);
    expect(codexTuiStartObserved(launcherBanner + codexProbe)).toBe(true);

    // The probe alone is NOT readiness: Codex is still swallowing stdin.
    expect(codexSessionFrameObserved(launcherBanner + codexProbe)).toBe(false);
    // FALSE PREMISE retracted (17:45Z): Codex 0.156.1 paints its header and
    // composer ~0.25s after the probe while its session is still loading. That
    // pre-session chrome is NOT readiness (captured 2026-09-23, wi2745-capture-b).
    const preSessionFrame =
      firstFrame +
      '\x1b[4;1H│ model:     \x1b[2mloading\x1b[22m   /model to change │' +
      '\x1b[9;1H› Ask Codex to do anything';
    expect(codexSessionFrameObserved(launcherBanner + codexProbe + preSessionFrame)).toBe(false);
    // The header repainted with a real model is written once the session exists.
    const sessionFrame = '\x1b[4;1H│ model:       \x1b[1mGPT-5.6-Sol high\x1b[22m   /model to change │';
    expect(codexSessionFrameObserved(codexProbe + preSessionFrame + sessionFrame)).toBe(true);
    // v0.157 (grading-audit EI-24211723316824223) kept the header at
    // `model: loading` after its model-choice modal, but painted a Ready footer.
    // The old header-only proof waited 75s, then dropped the first turn.
    const startingFooter = '\x1b[23;3HStarting · GPT-6-Sol medium · Context 100% left · staging';
    const readyFooter = '\x1b[23;3HReady · GPT-6-Sol medium · Context 100% left · staging';
    expect(startupOutputReady('codex', startingFooter)).toBe(false);
    expect(codexSessionFrameObserved(codexProbe + preSessionFrame + startingFooter)).toBe(false);
    expect(startupOutputReady('codex', readyFooter)).toBe(true);
    expect(codexSessionFrameObserved(codexProbe + preSessionFrame + readyFooter)).toBe(true);
    expect(codexSessionFrameObserved(readyFooter + codexProbe)).toBe(false);
    // Chrome painted BEFORE the latest probe does not count: the frame must follow it.
    expect(codexSessionFrameObserved(sessionFrame + codexProbe)).toBe(false);
    // No probe in the buffer is not a frame, unless the caller already saw the
    // probe and its bounded buffer has since trimmed it away.
    expect(codexSessionFrameObserved(sessionFrame)).toBe(false);
    expect(codexSessionFrameObserved(sessionFrame, { probeAlreadySeen: true })).toBe(true);

    const fallbackMs = 15_000;
    const firstOutputAt = 1_000; // launcher banner
    const base = { agent: 'codex', firstOutputAt, fallbackMs };
    // The measured failure: probe at 17.4s, first frame at 33.03s. A clock
    // started at the probe expired at 32.4s, 0.6s before the frame. The
    // frame-relative clock has not started yet, so only the widened window
    // applies, and it runs from the probe, not from the launcher banner.
    const multiplier = CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER;
    const probeAt = 17_400;
    const widenedFromProbe = probeAt + fallbackMs * multiplier;
    expect(startupFallbackElapsed({ ...base, nowMs: 32_400, backendTuiStartedAt: probeAt })).toBe(false);
    expect(startupFallbackElapsed({ ...base, nowMs: firstOutputAt + fallbackMs * multiplier, backendTuiStartedAt: probeAt })).toBe(false);
    expect(startupFallbackElapsed({ ...base, nowMs: widenedFromProbe - 1, backendTuiStartedAt: probeAt })).toBe(false);
    expect(startupFallbackElapsed({ ...base, nowMs: widenedFromProbe, backendTuiStartedAt: probeAt })).toBe(true);
    // Neither probe nor frame seen: widened from the first output byte.
    const widenedFromOutput = firstOutputAt + fallbackMs * multiplier;
    expect(startupFallbackElapsed({ ...base, nowMs: widenedFromOutput - 1 })).toBe(false);
    expect(startupFallbackElapsed({ ...base, nowMs: widenedFromOutput })).toBe(true);
    // Once the frame is painted, the ordinary window runs from it.
    const frame = { backendTuiStartedAt: probeAt, backendFirstFrameAt: 33_030 };
    expect(startupFallbackElapsed({ ...base, ...frame, nowMs: 48_029 })).toBe(false);
    expect(startupFallbackElapsed({ ...base, ...frame, nowMs: 48_030 })).toBe(true);
    // No output at all is never "elapsed".
    expect(startupFallbackElapsed({ ...base, firstOutputAt: 0, nowMs: 999_999, backendFirstFrameAt: 0 })).toBe(false);
    // Other backends keep the first-output clock unchanged.
    expect(startupFallbackElapsed({ agent: 'claude', firstOutputAt, fallbackMs, nowMs: 16_000, backendFirstFrameAt: 0 })).toBe(true);
    expect(startupFallbackElapsed({ agent: 'omp', firstOutputAt, fallbackMs, nowMs: 15_999, backendFirstFrameAt: 0 })).toBe(false);
  });

  // WI-10002776: exercise the real host with a fake Codex that swallows stdin
  // until its first session frame. The 260ms setting makes the old 4x no-frame
  // fallback expire at 1.04s, just before the frame at about 1.2s. A tagged
  // kickoff must wait for that frame instead of spending the fallback write.
  it('waits for the Codex session frame when the no-frame fallback expires first', async () => {
    const ownerId = `su-codex-first-frame-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:fedcba9876543210⟧';
    const kickoff = marker + '\nKICKOFF-AFTER-FRAME';
    const { captured, io } = fakeIo();
    const childCode =
      "process.stdout.write('psu: launcher banner\\n');" +
      "process.stdin.setEncoding('utf8');let swallowing=false;let b='';" +
      "process.stdin.on('data',d=>{if(swallowing){process.stdout.write('SWALLOWED:'+JSON.stringify(d)+'\\n');return;}" +
      "b+=d;let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
      "if(!line)continue;if(line==='QUIT')process.exit(0);process.stdout.write('ECHO:'+line+'\\n');}});" +
      "setTimeout(()=>{swallowing=true;process.stdout.write('\\x1b[6n');" +
      "setTimeout(()=>process.stdout.write('\\x1b[1;1H\\u2502 >_ OpenAI Codex (v0.156.1) \\u2502\\n\\u2502 model:     loading   /model to change \\u2502\\n\\u203a Ask Codex to do anything\\n'),50);" +
      "setTimeout(()=>{swallowing=false;process.stdout.write('\\x1b[2;1H\\u2502 model:       GPT-5.6-Sol high   /model to change \\u2502\\n');},1200);},100);" +
      'setTimeout(()=>process.exit(0),15000);';
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '260',
        PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: '4000',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource: new EventEmitter(),
      kickoff,
      onExit: () => undefined,
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('ECHO:KICKOFF-AFTER-FRAME'), { timeout: 8000 });
      expect(captured()).not.toContain('SWALLOWED:');
      const hostEvents = () =>
        readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      // The event follows Codex's delayed resubmit CR, which lands after the echo.
      const written = await vi.waitFor(() => {
        const row = hostEvents().find((e) => e.kind === 'startup-turn-written');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      const frame = hostEvents().find((e) => e.kind === 'backend-session-frame-observed');
      expect(frame?.msAfterTuiStart).toBeGreaterThanOrEqual(1_000);
      // WI-10004943 control: this frame arrived on its own, before any machine
      // write, so it must not be attributable to one.
      expect(frame).toHaveProperty('msSinceMachineTurnWriteStarted', null);
      expect(written).toMatchObject({ label: 'launch kickoff', authorizedBy: 'backend-session-frame' });
      expect(written.msSinceBackendFirstFrame).toBeGreaterThanOrEqual(0);
      expect(Date.parse(written.ts)).toBeGreaterThanOrEqual(Date.parse(frame.ts));
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done;
    }
  }, 20_000);

  // WI-10004919: Codex v0.159.3 held its footer at `Starting` (MCP servers
  // booting) for 86.2s; the 75s backend-frame budget dropped the kickoff 11s
  // before the Ready frame and the resolver idled at its prompt. Scaled down:
  // budget = 260ms x 5 = 1.3s from the probe, Ready at ~4.1s. The margin is
  // wide on purpose: with Ready at ~2.1s the host sometimes observed the TUI
  // start late enough that Ready beat the budget, so no extension was needed
  // and the test failed on a correct run (measured 2026-10-01, WI-10004919).
  it('keeps waiting past the frame budget while the Codex footer still reads Starting', async () => {
    const ownerId = `su-codex-starting-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
    const kickoff = marker + '\nKICKOFF-AFTER-STARTING';
    const { captured, io } = fakeIo();
    const childCode =
      "process.stdout.write('psu: launcher banner\\n');" +
      "process.stdin.setEncoding('utf8');let swallowing=false;let b='';" +
      "process.stdin.on('data',d=>{if(swallowing){process.stdout.write('SWALLOWED:'+JSON.stringify(d)+'\\n');return;}" +
      "b+=d;let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
      "if(!line)continue;if(line==='QUIT')process.exit(0);process.stdout.write('ECHO:'+line+'\\n');}});" +
      "setTimeout(()=>{swallowing=true;process.stdout.write('\\x1b[6n');" +
      "setTimeout(()=>process.stdout.write('\\x1b[1;1H\\u2502 >_ OpenAI Codex (v0.159.3) \\u2502\\n\\u203a Ask Codex to do anything\\n" +
      "\\x1b[23;3HStarting \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left'),50);" +
      "setTimeout(()=>{swallowing=false;process.stdout.write('\\x1b[23;3HReady \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left');},4000);},100);" +
      'setTimeout(()=>process.exit(0),25000);';
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '260',
        PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: '8000',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource: new EventEmitter(),
      kickoff,
      onExit: () => undefined,
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('ECHO:KICKOFF-AFTER-STARTING'), { timeout: 14000 });
      expect(captured()).not.toContain('SWALLOWED:');
      const hostEvents = () =>
        readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      const written = await vi.waitFor(() => {
        const row = hostEvents().find((e) => e.kind === 'startup-turn-written');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      expect(written).toMatchObject({ label: 'launch kickoff', authorizedBy: 'backend-session-frame' });
      const extended = hostEvents().filter((e) => e.kind === 'launch-kickoff-backend-frame-wait-extended');
      expect(extended).toHaveLength(1);
      expect(extended[0]).toMatchObject({ reason: 'codex-footer-starting' });
      expect(extended[0].elapsedMs).toBeGreaterThanOrEqual(1_300);
      expect(hostEvents().some((e) => e.kind === 'startup-turn-dropped')).toBe(false);
      expect(hostEvents().some((e) => e.kind === 'launch-kickoff-backend-frame-timeout')).toBe(false);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done;
    }
  }, 35_000);

  // WI-10004943 (d): the ordinary kickoff budget used to DROP a kickoff whose Codex
  // footer still read `Starting` (`codex-startup-still-starting`), discarding the
  // session's first turn. Production footers read `Starting` for 10-20 minutes and
  // then painted the frame. The kickoff must be HELD for the frame up to a ceiling.
  // `readyAtMs` may also be a JS expression string, evaluated inside the child.
  const codexStartingChild = (readyAtMs: number | string | null, exitAtMs: number) =>
    "process.stdout.write('psu: launcher banner\\n');" +
    "process.stdin.setEncoding('utf8');let swallowing=false;let b='';" +
    "process.stdin.on('data',d=>{if(swallowing){process.stdout.write('SWALLOWED:'+JSON.stringify(d)+'\\n');return;}" +
    "b+=d;let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
    "if(!line)continue;if(line==='QUIT')process.exit(0);process.stdout.write('ECHO:'+line+'\\n');}});" +
    "setTimeout(()=>{swallowing=true;process.stdout.write('\\x1b[6n');" +
    "setTimeout(()=>process.stdout.write('\\x1b[1;1H\\u2502 >_ OpenAI Codex (v0.159.3) \\u2502\\n\\u2502 model: GPT-6.1-Sol xhigh /model to change \\u2502\\n\\u203a Ask Codex to do anything\\n" +
    "\\x1b[23;3HStarting \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left'),50);" +
    (readyAtMs === null
      ? ''
      : "setTimeout(()=>{swallowing=false;process.stdout.write('\\x1b[23;3HReady \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left');}," +
        readyAtMs + ');') +
    '},100);' +
    `setTimeout(()=>process.exit(0),${exitAtMs});`;
  const runCodexStartingKickoff = (name: string, childCode: string, env: Record<string, string>) => {
    const ownerId = `su-codex-${name}-itest-${process.pid}-${Math.floor(performance.now())}`;
    const { captured, io } = fakeIo();
    const signalSource = new EventEmitter();
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '260',
        PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: '8000',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        // These cases exercise the (d) hold, which a retryable launch reaches
        // only on its last attempt (WI-10004943); the fresh-child case opts in.
        PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES: '0',
        TERM: 'xterm-256color',
        ...env,
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource,
      kickoff: '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧\nKICKOFF-HELD',
      onExit: () => undefined,
    });
    const hostEvents = (): Array<Record<string, unknown>> => {
      const path = eventLogPathForOwner(ownerId);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    };
    return { ownerId, sock: socketPathFor(ownerId), captured, done, hostEvents, signalSource };
  };

  it('holds a fresh Codex kickoff past its budget while the footer reads Starting, then delivers on the frame', async () => {
    const run = runCodexStartingKickoff('starting-hold', codexStartingChild(4000, 25_000), {
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2500',
      PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '15000',
    });
    try {
      await vi.waitFor(() => expect(run.captured()).toContain('ECHO:KICKOFF-HELD'), { timeout: 14000 });
      expect(run.captured()).not.toContain('SWALLOWED:');
      const held = run.hostEvents().filter((e) => e.kind === 'kickoff-held-for-codex-frame');
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ label: 'launch kickoff', budgetMs: 2500, holdCeilingMs: 15000 });
      expect(held[0].elapsedMs as number).toBeGreaterThanOrEqual(2500);
      expect(run.hostEvents().find((e) => e.kind === 'kickoff-codex-frame-hold-ended'))
        .toMatchObject({ label: 'launch kickoff', outcome: 'frame-observed' });
      const written = await vi.waitFor(() => {
        const row = run.hostEvents().find((e) => e.kind === 'startup-turn-written');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      expect(written).toMatchObject({ label: 'launch kickoff', authorizedBy: 'backend-session-frame' });
      expect(run.hostEvents().some((e) => e.kind === 'startup-turn-dropped')).toBe(false);
    } finally {
      if (existsSync(run.sock)) await rawInject(run.sock, 'QUIT\n');
      await run.done;
    }
  }, 35_000);

  it('drops a held Codex kickoff at the hold ceiling, without typing into the Starting composer', async () => {
    // Exercise the existing deadline after the child has actually painted its
    // Starting frame. Process startup latency must not choose another drop path.
    let clock = Date.now();
    const kickoffStartedAt = clock;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const stderrWrite = vi.spyOn(process.stderr, 'write');
    const run = runCodexStartingKickoff('starting-ceiling', codexStartingChild(null, 9000), {
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '1000',
      PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '3000',
    });
    try {
      await vi.waitFor(() => {
        expect(run.hostEvents().some((e) => e.kind === 'backend-session-frame-observed')).toBe(true);
        expect(run.captured()).toContain('Starting');
      }, { timeout: 8000 });
      expect(run.hostEvents().some((e) => e.kind === 'startup-turn-dropped')).toBe(false);
      clock = kickoffStartedAt + 1000;
      await vi.waitFor(() => {
        expect(run.hostEvents().filter((e) => e.kind === 'kickoff-held-for-codex-frame')).toHaveLength(1);
      });
      clock = kickoffStartedAt + 3000;
      const dropped = await vi.waitFor(() => {
        const row = run.hostEvents().find((e) => e.kind === 'startup-turn-dropped');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      expect(dropped).toMatchObject({ label: 'launch kickoff', reason: 'codex-startup-still-starting' });
      expect(run.hostEvents().filter((e) => e.kind === 'kickoff-held-for-codex-frame')).toHaveLength(1);
      const ended = run.hostEvents().find((e) => e.kind === 'kickoff-codex-frame-hold-ended');
      expect(ended).toMatchObject({ outcome: 'ceiling-still-starting' });
      expect(ended?.heldMs as number).toBeGreaterThanOrEqual(1500);
      expect(run.captured()).not.toContain('SWALLOWED:');
      expect(run.captured()).not.toContain('ECHO:KICKOFF-HELD');
      // Positive control for the fresh-child case below, which asserts this
      // line's ABSENCE through the same spy: a terminal drop must print it.
      const printed = stderrWrite.mock.calls.map((call) => String(call[0]));
      expect(printed.some((line) => line.includes(`launch kickoff DROPPED for ${run.ownerId} `))).toBe(true);
    } finally {
      now.mockRestore();
      stderrWrite.mockRestore();
      // This fixture deliberately swallows input while Starting, including QUIT.
      run.signalSource.emit('SIGTERM');
      await run.done;
    }
  }, 20_000);

  it('ends a held Codex kickoff when the host tears down instead of polling until the ceiling', async () => {
    const run = runCodexStartingKickoff('starting-host-end', codexStartingChild(null, 25_000), {
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '1000',
      PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '600000',
    });
    try {
      await vi.waitFor(() => expect(run.hostEvents().some((e) => e.kind === 'kickoff-held-for-codex-frame'))
        .toBe(true), { timeout: 8000 });
      run.signalSource.emit('SIGTERM');
      await run.done;
      const ended = await vi.waitFor(() => {
        const row = run.hostEvents().find((e) => e.kind === 'kickoff-codex-frame-hold-ended');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 3000 });
      expect(ended).toMatchObject({ label: 'launch kickoff', outcome: 'host-ended' });
      expect(run.hostEvents().some((e) => e.kind === 'startup-turn-dropped')).toBe(false);
    } finally {
      run.signalSource.emit('SIGTERM');
      await run.done;
    }
  }, 15_000);

  // WI-10004943: in 4 of 4 production cases a Codex footer read `Starting` for
  // 10-20 minutes and the session frame then appeared 6-18s before a `turn inject`
  // was confirmed. Either Codex became ready on its own (hung MCP boot) or the
  // typed input provoked the repaint (a stale footer). The host computed the facts
  // that decide this but did not record them. This child repaints `Ready` ONLY
  // when input arrives, so the record must show the write began before the frame,
  // with the footer still reading `Starting`.
  // WI-10004943: the (d) hold rescued 0 of 3 stuck launches in production (all still
  // `Starting` at the ceiling), while a fresh child boots in seconds. A plain fresh
  // Codex launch whose child is still `Starting` after the stuck threshold gets a
  // fresh child and the same kickoff, without printing the parsed DROPPED receipt.
  it('replaces a fresh Codex launch child stuck at Starting and delivers the kickoff on the fresh child', async () => {
    const mark = join(tmpdir(), `codex-stuck-once-${process.pid}-${Math.floor(performance.now())}`);
    const markLit = JSON.stringify(mark);
    // The first child marks the file and never leaves `Starting`; its successor
    // paints Ready shortly after it boots.
    const childCode =
      `const __first=!require('fs').existsSync(${markLit});` +
      `if(__first)require('fs').writeFileSync(${markLit},'1');` +
      codexStartingChild('(__first?1e9:300)', 20_000);
    const stderrWrite = vi.spyOn(process.stderr, 'write');
    const run = runCodexStartingKickoff('starting-fresh-child', childCode, {
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '8000',
      PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS: '1500',
      PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '15000',
      PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES: '1',
    });
    try {
      await vi.waitFor(() => expect(run.captured()).toContain('ECHO:KICKOFF-HELD'), { timeout: 20_000 });
      expect(run.captured()).not.toContain('SWALLOWED:');
      const events = run.hostEvents();
      expect(events.find((e) => e.kind === 'codex-starting-stuck-early-drop'))
        .toMatchObject({ label: 'launch kickoff', stuckMs: 1500 });
      const dropped = events.filter((e) => e.kind === 'startup-turn-dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        label: 'launch kickoff',
        reason: 'codex-startup-still-starting',
        earlyStuck: true,
      });
      expect(events.find((e) => e.kind === 'launch-kickoff-fresh-child-retry'))
        .toMatchObject({ label: 'launch kickoff', reason: 'codex-startup-still-starting', attempt: 1, maxRetries: 1 });
      expect(events.find((e) => e.kind === 'respawned'))
        .toMatchObject({ mode: 'launch-fresh-child', firstPrompt: false });
      expect(events.some((e) => e.kind === 'launch-kickoff-fresh-child-failed')).toBe(false);
      expect(events.some((e) => e.kind === 'host-code-adopting')).toBe(false);
      const written = await vi.waitFor(() => {
        const row = run.hostEvents().find((e) => e.kind === 'startup-turn-written');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      expect(written).toMatchObject({ label: 'launch kickoff' });
      // The acceptance grader retires a judge on this line; the retried launch
      // above did deliver, so it must never have been printed for this host.
      // A prior host can finish an asynchronous drop after its child exits;
      // the process-wide stderr spy also captures that unrelated receipt.
      const printed = stderrWrite.mock.calls.map((call) => String(call[0]));
      expect(printed.some((line) => line.includes(`launch kickoff DROPPED for ${run.ownerId} `))).toBe(false);
    } finally {
      stderrWrite.mockRestore();
      if (existsSync(run.sock)) await rawInject(run.sock, 'QUIT\n');
      await run.done;
      rmSync(mark, { force: true });
    }
  }, 45_000);

  it('records the write-time footer and the write-to-frame gap for a Codex turn inject', async () => {
    const ownerId = `su-codex-provoked-frame-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const codexHome = join(PSU_PTY_DIR, 'codex-home');
    const nativeFile = join(codexHome, 'sessions', 'project', 'turn-' + ownerId + '.jsonl');
    const childCode =
      "const fs=require('fs'),path=require('path');" +
      "process.stdout.write('psu: launcher banner\\n');" +
      "process.stdin.setEncoding('utf8');let ready=false;let b='',submittedText='',nativeWritten=false;" +
      "process.stdin.on('data',d=>{" +
      "if(!ready&&String(d).includes('PROVOKE')){ready=true;" +
      "process.stdout.write('\\x1b[23;3HReady \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left');}" +
      "b+=d;let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
      "if(!line)continue;if(line.includes('QUIT'))process.exit(0);submittedText+=line+'\\n';" +
      "if(!nativeWritten&&line.includes('PROVOKE-TURN')){nativeWritten=true;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});" +
      "const timestamp=new Date().toISOString();const row={type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:submittedText.trimEnd()}]}};" +
      "fs.writeFileSync(process.env.NATIVE_FILE,JSON.stringify(row)+'\\n');}" +
      "process.stdout.write('ECHO:'+line+'\\n');}});" +
      "setTimeout(()=>{process.stdout.write('\\x1b[6n');" +
      "setTimeout(()=>process.stdout.write('\\x1b[1;1H\\u2502 >_ OpenAI Codex (v0.159.3) \\u2502\\n\\u203a Ask Codex to do anything\\n" +
      "\\x1b[23;3HStarting \\u00b7 GPT-6.1-Sol xhigh \\u00b7 Context 100% left'),50);},100);" +
      'setTimeout(()=>process.exit(0),20000);';
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        CODEX_HOME: codexHome,
        NATIVE_FILE: nativeFile,
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '260',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource: new EventEmitter(),
      onExit: () => undefined,
    });
    try {
      const hostEvents = () =>
        existsSync(eventLogPathForOwner(ownerId))
          ? readFileSync(eventLogPathForOwner(ownerId), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
          : [];
      await vi.waitFor(() => {
        expect(existsSync(sock)).toBe(true);
        expect(hostEvents().some((e) => e.kind === 'backend-tui-start-observed')).toBe(true);
        expect(captured()).toContain('Starting');
      }, { timeout: 8000 });
      // Calibration: the footer alone is not a session frame.
      expect(hostEvents().some((e) => e.kind === 'backend-session-frame-observed')).toBe(false);
      await controlInject(sock, 'turn', 'PROVOKE-TURN');
      await vi.waitFor(() => expect(captured()).toContain('ECHO:PROVOKE-TURN'), { timeout: 8000 });
      const delivered = await vi.waitFor(() => {
        const row = hostEvents().find((e) => e.kind === 'turn-delivered' && e.label === 'turn inject');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 8000 });
      const frame = hostEvents().find((e) => e.kind === 'backend-session-frame-observed');
      expect(frame).toBeDefined();
      expect(delivered.write).toMatchObject({
        codexFooterAtWrite: 'starting',
        msSinceBackendFirstFrame: null,
      });
      const writeStartedAt = Date.parse(delivered.write.writeStartedAt);
      expect(Number.isFinite(writeStartedAt)).toBe(true);
      expect(writeStartedAt).toBeLessThanOrEqual(Date.parse(frame.ts));
      expect(frame.msSinceMachineTurnWriteStarted).toBeGreaterThanOrEqual(0);
      expect(frame.msSinceMachineTurnWriteStarted).toBeLessThan(5_000);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done;
    }
  }, 30_000);

  it('waits for a Codex Ready footer before sending a resumed launch kickoff', async () => {
    const ownerId = 'su-codex-resume-ready-itest-' + process.pid + '-' + Math.floor(performance.now());
    const sock = socketPathFor(ownerId);
    const nativeRoot = mkdtempSync(join(tmpdir(), 'psu-resume-ready-'));
    const { captured, io } = fakeIo();
    const childCode = [
      "process.stdin.setEncoding('utf8');let swallowing=true,b='';",
      "process.stdin.on('data',d=>{if(String(d).includes('QUIT'))process.exit(0);if(String(d).includes('FIXTURE_READY')){swallowing=false;process.stdout.write('\\x1b[23;3H› Ask Codex to do anything   Ready · GPT-5.6-Sol high · Context 100% left\\n');return;}if(swallowing){process.stdout.write('SWALLOWED:'+JSON.stringify(d)+'\\n');return;}b+=d;let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(!line)continue;process.stdout.write('ECHO:'+line+'\\n');}});",
      "process.stdout.write('psu: launcher banner\\n');",
      "process.stdout.write('\\x1b[6n\\x1b[1;1H│ >_ OpenAI Codex (v0.156.1) │\\n│ model: GPT-5.6-Sol high /model to change │\\n› Ask Codex to do anything   Starting · GPT-5.6-Sol high · Context 100% left\\n');",
      // The host owns teardown. A fixed child lifetime can end between the
      // kickoff text and submit CR, so readiness must be proved before QUIT.
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'resume'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          CODEX_HOME: nativeRoot,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '3000',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '260',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '25',
          PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '25',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        signalSource: new EventEmitter(),
        kickoff: 'RESUME-KICKOFF-AFTER-READY',
        onExit: () => undefined,
      });
      await vi.waitFor(() => expect(captured()).toContain('Starting'), { timeout: 5_000 });
      expect(captured()).not.toContain('RESUME-KICKOFF-AFTER-READY');
      const readyReleasedAt = Date.now();
      await rawInject(sock, 'FIXTURE_READY\n');
      await vi.waitFor(() => expect(captured()).toContain('ECHO:RESUME-KICKOFF-AFTER-READY'), { timeout: 5_000 });
      expect(captured()).not.toContain('SWALLOWED:');
      const written = await vi.waitFor(() => {
        const row = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((event) => event.kind === 'startup-turn-written');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 1_000 });
      expect(written).toMatchObject({
        label: 'launch kickoff',
        authorizedBy: 'startup-ready-marker',
        promptReady: false,
        startupReady: true,
        codexFooterAtWrite: 'ready',
      });
      expect(Date.parse(written.ts)).toBeGreaterThanOrEqual(readyReleasedAt);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  }, 8_000);

  it('does not spend Codex last-resort input while a resumed TUI still says Starting', async () => {
    const ownerId = 'su-codex-resume-starting-itest-' + process.pid + '-' + Math.floor(performance.now());
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const childCode = [
      "process.stdin.setEncoding('utf8');let swallowing=true;",
      "process.stdin.on('data',d=>{if(String(d).includes('QUIT'))process.exit(0);if(swallowing)process.stdout.write('SWALLOWED:'+JSON.stringify(d)+'\\n');else process.stdout.write('ECHO:'+JSON.stringify(d)+'\\n');});",
      "process.stdout.write('psu: launcher banner\\n');",
      "setTimeout(()=>{process.stdout.write('\\x1b[6n');setTimeout(()=>process.stdout.write('\\x1b[1;1H│ >_ OpenAI Codex (v0.156.1) │\\n│ model: GPT-5.6-Sol high /model to change │\\n› Ask Codex to do anything   Starting · GPT-5.6-Sol high · Context 100% left\\n'),50);},100);",
      'setTimeout(()=>process.exit(0),1800);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'resume'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '700',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '60000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        signalSource: new EventEmitter(),
        kickoff: 'RESUME-KICKOFF-MUST-WAIT',
        onExit: () => undefined,
      });
      await done;
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.some((row) => row.kind === 'startup-turn-written')).toBe(false);
      expect(captured()).not.toContain('SWALLOWED:');
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
    }
  }, 6_000);

  it('recognizes a Claude composer glyph while rejecting startup noise and recovery-menu rows', () => {
    expect(freshChildPromptReady('claude', '\x1b[2J spinner / loading')).toBe(false);
    expect(freshChildPromptReady('claude', '❯ 1. Resume from summary')).toBe(false);
    expect(freshChildPromptReady('claude', '\x1b[2K\n❯\n')).toBe(true);
    expect(freshChildPromptReady('codex', '\n❯\n')).toBe(false);
  });

  it('delivers a fresh headless Claude kickoff through a real PTY with the captured cursor-spaced placeholder', async () => {
    const ownerId = `su-claude-hpa-kickoff-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const frame = '\n❯\u00a0\x1b[2mTry\x1b[7G"how\x1b[12Gdoes\x1b[17Gtooldef\x1b[25Gwork?"\x1b[22m\n';
    const childCode =
      `process.stdout.write(${JSON.stringify(frame)});` +
      "process.stdin.setEncoding('utf8');let input='';" +
      "process.stdin.on('data',d=>{input+=d;if(input.includes('BEGIN_HPA_KICKOFF')&&/[\\r\\n]/.test(input)){process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),50);}});" +
      'setTimeout(()=>process.exit(2),5000);';
    const done = hostThroughPty({
      command: execPath, args: ['-e', childCode], cwd: '/tmp',
      env: {
        ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_PSU_HEADLESS: '1', TERM: 'xterm-256color',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
      },
      ownerId, io, bridgeTty: false, kickoff: 'BEGIN_HPA_KICKOFF',
      signalSource: new EventEmitter(), onExit: () => undefined,
    });
    expect(await done).toBe(0);
    expect(captured()).toContain('KICKOFF_RECEIVED');
    expect(existsSync(sock)).toBe(false);
  }, 10_000);

  it('checks role MCP connection before sending a fresh headless Claude kickoff', async () => {
    const ownerId = `su-role-mcp-ready-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const frame = '\n❯\u00a0\x1b[2mTry\x1b[7G"how\x1b[12Gdoes\x1b[17Gtooldef\x1b[25Gwork?"\x1b[22m\n';
    const childCode =
      `process.stdout.write(${JSON.stringify(frame)});` +
      "process.stdin.setEncoding('utf8');let input='',dialog=false;" +
      "process.stdin.on('data',d=>{input+=d;if(!dialog&&/\\/mcp[\\r\\n]/.test(input)){dialog=true;process.stdout.write('MCP_DIALOG\\n❯ 1. papercusp connected\\n');}if(input.includes('BEGIN_ROLE_KICKOFF')){process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),50);}});" +
      'setTimeout(()=>process.exit(2),10000);';
    const done = hostThroughPty({
      command: execPath, args: ['-e', childCode], cwd: '/tmp',
      env: {
        ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_ROLE: 'judge', PAPERCUSP_PSU_HEADLESS: '1', TERM: 'xterm-256color',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
      },
      ownerId, io, bridgeTty: false, kickoff: 'BEGIN_ROLE_KICKOFF',
      signalSource: new EventEmitter(), onExit: () => undefined,
    });
    try {
      const exitCode = await done;
      const output = captured();
      expect(output).toContain('MCP_DIALOG');
      expect(output).toContain('KICKOFF_RECEIVED');
      expect(output.indexOf('MCP_DIALOG')).toBeLessThan(output.indexOf('KICKOFF_RECEIVED'));
      expect(exitCode).toBe(0);
      expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8')).toContain('launch-role-mcp-ready');
    } finally {
      if (existsSync(sock)) await rawInject(sock, '\x04');
    }
  }, 15_000);

  it('waits for the /mcp local-command turn to settle before a fresh headless Claude kickoff', async () => {
    const ownerId = `su-role-mcp-settle-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const frame = '\n❯\u00a0\x1b[2mTry\x1b[7G"how\x1b[12Gdoes\x1b[17Gtooldef\x1b[25Gwork?"\x1b[22m\n';
    const childCode =
      `process.stdout.write(${JSON.stringify(frame)});` +
      "process.stdin.setEncoding('utf8');let input='',mcp=false;" +
      "process.stdin.on('data',d=>{input+=d;if(!mcp&&/\\/mcp[\\r\\n]/.test(input)){mcp=true;process.stdout.write('Reconnected to papercusp.\\n');setTimeout(()=>process.stdout.write('MCP_COMMAND_SETTLED\\n\\n❯\\n'),250);}if(input.includes('BEGIN_ROLE_KICKOFF')){process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),50);}});" +
      'setTimeout(()=>process.exit(2),10000);';
    const done = hostThroughPty({
      command: execPath, args: ['-e', childCode], cwd: '/tmp',
      env: {
        ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_ROLE: 'judge', PAPERCUSP_PSU_HEADLESS: '1', TERM: 'xterm-256color',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '300',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
      },
      ownerId, io, bridgeTty: false, kickoff: 'BEGIN_ROLE_KICKOFF',
      mcpReconnectMacro: async ({ write, readTap }: { write: (bytes: string) => void; readTap: () => string }) => {
        write('/mcp');
        write('\\r');
        const deadline = Date.now() + 1_000;
        while (!readTap().includes('Reconnected to papercusp.') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return readTap().includes('Reconnected to papercusp.')
          ? { ok: true, step: 'direct-reconnected', detail: 'Claude /mcp confirmed this server reconnected' }
          : { ok: false, step: 'await-connected', detail: 'reconnect output did not arrive' };
      },
      signalSource: new EventEmitter(), onExit: () => undefined,
    });
    try {
      const exitCode = await done;
      const output = captured();
      expect(output).toContain('Reconnected to papercusp.');
      expect(output).toContain('MCP_COMMAND_SETTLED');
      expect(output).toContain('KICKOFF_RECEIVED');
      expect(output.indexOf('MCP_COMMAND_SETTLED')).toBeLessThan(output.indexOf('KICKOFF_RECEIVED'));
      expect(exitCode).toBe(0);
      expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8')).toContain('launch-role-mcp-ready');
    } finally {
      if (existsSync(sock)) await rawInject(sock, '\x04');
    }
  }, 15_000);

  it('auto-advances the headless Claude theme and Security notes prompts exactly once', async () => {
    const ownerId = `su-headless-onboarding-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const childCode =
      "let advances=0;" +
      "process.stdout.write('Choose your preferred theme: Dark mode\\n');" +
      "process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data',d=>{const count=(d.match(/[\\r\\n]/g)||[]).length;for(let i=0;i<count;i++){advances++;process.stdout.write('AUTO_CR_'+advances+'\\n');if(advances===1)process.stdout.write('Security notes\\nPress Enter to continue\\n');if(advances===2){process.stdout.write('ONBOARDING_READY\\n');setTimeout(()=>process.exit(0),50);}}});";
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_PSU_HEADLESS: '1',
        // Exercise the production onboarding contract. Expiry is covered with
        // an injected clock in the state-machine unit tests.
        PAPERCUSP_FLEET_BG: '',
        PAPERCUSP_FLEET_FG: '',
        PAPERCUSP_FLEET_CURSOR: '',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      onExit: () => {},
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!captured().includes('ONBOARDING_READY') && Date.now() < deadline) await sleep(10);
      expect(captured()).toContain('ONBOARDING_READY');
      expect((captured().match(/AUTO_CR_1/g) || []).length).toBe(1);
      expect((captured().match(/AUTO_CR_2/g) || []).length).toBe(1);
      expect(await done).toBe(0);
      expect(existsSync(sock)).toBe(false);
    } finally {
      if (existsSync(sock)) await rawInject(sock, '\x04');
      await done.catch(() => undefined);
    }
  }, 10_000);

  it('signals the forkpty process group and retains a direct-child fallback', () => {
    const groupKill = vi.fn();
    const directKill = vi.fn();
    expect(killPtyProcessTree({ pid: 4242, kill: directKill }, 'SIGHUP', groupKill)).toBe(true);
    if (process.platform !== 'win32') expect(groupKill).toHaveBeenCalledWith(-4242, 'SIGHUP');
    expect(directKill).toHaveBeenCalledWith('SIGHUP');
  });

  it('securely reads a 0600 seed and rejects a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-port-seed-'));
    try {
      const hash = 'a'.repeat(64);
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `history\n[PAPERCUSP SESSION PORT CHECKSUM ${hash}]\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      expect(readManagedKickoffFile(seed, hash)).toMatchObject({ renderedHash: hash });
      const link = join(root, 'link.md');
      symlinkSync(seed, link);
      expect(() => readManagedKickoffFile(link, hash)).toThrow(/regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('chunks the maximum-style UTF-8 paste without changing a code point or exceeding 64KiB/write', () => {
    const text = '😀'.repeat(MAX_CONTROL_PAYLOAD_BYTES / 4); // exactly 8 MiB UTF-8
    const chunks = ptyWriteChunks(text);
    expect(chunks.join('')).toBe(text);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_CONTROL_PAYLOAD_BYTES);
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk, 'utf8')))).toBeLessThanOrEqual(64 * 1024);
  });

  it('stamps a dedicated verified session-port provenance row before injection', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-port-provenance-'));
    try {
      const tagged = tagSessionPortTurn(
        'history',
        'su-port-proof',
        { PAPERCUSP_TURN_PROVENANCE_DIR: root } as any,
        1234,
      );
      expect(tagged).toMatch(/^⟦turn-origin:session-port nonce:[a-f0-9]{16}⟧\nhistory$/);
      const row = JSON.parse(readFileSync(join(root, 'su-port-proof.jsonl'), 'utf8'));
      expect(row).toMatchObject({ sid: 'su-port-proof', origin: 'session-port', ts: 1234 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes session-port provenance under the platform home without a directory override', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-port-default-provenance-'));
    const previousHome = process.env.PAPERCUSP_HOME;
    process.env.PAPERCUSP_HOME = root;
    try {
      const tagged = tagSessionPortTurn('history', 'su-port-default', {}, 1234);
      expect(tagged).toMatch(/^⟦turn-origin:session-port nonce:[a-f0-9]{16}⟧\nhistory$/);
      const dir = join(root, 'turn-provenance');
      const file = join(dir, 'su-port-default.jsonl');
      const row = JSON.parse(readFileSync(file, 'utf8'));
      expect(row).toMatchObject({
        sid: 'su-port-default', origin: 'session-port', ts: 1234,
        sha256: createHash('sha256').update('history').digest('hex'),
      });
      expect(tagged).toContain(`nonce:${row.nonce}`);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only the exact marker in the target Claude/Codex/OMP native JSONL roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-port-native-'));
    const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${'b'.repeat(64)}]`;
    try {
      const codexDir = join(home, 'codex-target', 'sessions', '2026', '07');
      mkdirSync(codexDir, { recursive: true });
      const codexFile = join(codexDir, 'rollout.jsonl');
      const codexSinceMs = Date.now();
      writeFileSync(codexFile, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }, timestamp: new Date(codexSinceMs).toISOString() })}\n`);
      expect(findNativeTranscriptMarker({
        agent: 'codex', env: { CODEX_HOME: join(home, 'codex-target') }, marker, sinceMs: codexSinceMs, home,
      })).toBe(codexFile);

      const ompDir = join(home, '.omp-target', 'agent', 'sessions', 'project');
      mkdirSync(ompDir, { recursive: true });
      const ompFile = join(ompDir, 'thread.jsonl');
      const ompSinceMs = Date.now();
      writeFileSync(ompFile, `${JSON.stringify({ type: 'message', role: 'user', content: marker, timestamp: new Date(ompSinceMs).toISOString() })}\n`);
      const proof = await waitForNativeTranscriptMarker({
        agent: 'omp', env: { PI_CONFIG_DIR: '.omp-target' }, marker, sinceMs: ompSinceMs, home, timeoutMs: 100, pollMs: 5,
      });
      expect(proof).toEqual({ persisted: true, nativeRef: ompFile });
      expect(findNativeTranscriptMarker({
        agent: 'omp', env: { PI_CONFIG_DIR: '.omp-target' }, marker: `${marker}-wrong`, sinceMs: ompSinceMs, home,
      })).toBeNull();

      const claudeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const claudeDir = join(home, 'claude-target', 'projects', '-tmp');
      mkdirSync(claudeDir, { recursive: true });
      const claudeFile = join(claudeDir, `${claudeId}.jsonl`);
      const carryMarker = '⟦turn-origin:self-compaction nonce:0123456789abcdef⟧';
      const claudeSinceMs = Date.now();
      writeFileSync(claudeFile, `${JSON.stringify({ type: 'user', timestamp: new Date(claudeSinceMs).toISOString(), message: { role: 'user', content: carryMarker } })}\n`);
      expect(leadingTurnOriginMarker(`${carryMarker}\nContinue where you left off`)).toBe(carryMarker);
      const ownerMarker = '⟦turn-origin:coord-inject:owner nonce:0123456789abcdef⟧';
      expect(leadingTurnOriginMarker(`${ownerMarker}\nThe owner replied`)).toBe(ownerMarker);
      expect(truncatedTurnOriginMarkerLoss(ownerMarker, `${ownerMarker.slice(1)}\nThe owner replied`)).toBe(1);
      const shortNonceMarker = '⟦turn-origin:coord-inject:owner nonce:abcdef12⟧';
      expect(leadingTurnOriginMarker(`${shortNonceMarker}\nThe owner replied`)).toBe(shortNonceMarker);
      expect(leadingTurnOriginMarker('⟦turn-origin:coord-inject:owner nonce:xyz⟧\ninvalid')).toBeNull();
      expect(leadingTurnOriginMarker(`history before ${carryMarker}`)).toBeNull();
      expect(findNativeTranscriptMarker({
        agent: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, 'claude-target') },
        marker: carryMarker,
        nativeId: claudeId,
        sinceMs: claudeSinceMs,
        home,
      })).toBe(claudeFile);
      expect(findNativeTranscriptMarker({
        agent: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, 'claude-target') },
        marker: carryMarker,
        nativeId: 'ffffffff-1111-4222-8333-444444444444',
        sinceMs: claudeSinceMs,
        home,
      })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // WI-10002745: a Codex kickoff reached its rollout as `bd294b2da8⟧\n…`, the
  // tail of its marker. The exact proof missed it and the host tore down an
  // auditor that was mid-work. A truncated marker that keeps enough nonce is
  // proof the turn started, reported as degraded rather than exact.
  it('accepts a kickoff whose marker lost its head, but only with enough nonce left', async () => {
    const marker = '⟦turn-origin:fleet-kickoff nonce:87d062bd294b2da8⟧';
    expect(truncatedTurnOriginMarkerLoss(marker, 'bd294b2da8⟧\nYou are the auditor')).toBe(39);
    expect(truncatedTurnOriginMarkerLoss(marker, `${marker}\nexact`)).toBeNull();
    const shortest = marker.slice(-(TRUNCATED_MARKER_MIN_NONCE_CHARS + 1));
    expect(truncatedTurnOriginMarkerLoss(marker, `${shortest}\nbody`)).toBe(marker.length - shortest.length);
    expect(truncatedTurnOriginMarkerLoss(marker, `${shortest.slice(1)}\nbody`)).toBeNull();
    // A suffix that is not at the start of the text is not a truncated kickoff.
    expect(truncatedTurnOriginMarkerLoss(marker, `quoted bd294b2da8⟧`)).toBeNull();
    // A different nonce never matches.
    expect(truncatedTurnOriginMarkerLoss(marker, 'cd294b2da8⟧\nbody')).toBeNull();

    const home = mkdtempSync(join(tmpdir(), 'psu-truncated-marker-'));
    try {
      const env = { CODEX_HOME: join(home, 'codex') };
      const dir = join(home, 'codex', 'sessions', '2026', '09', '23');
      mkdirSync(dir, { recursive: true });
      const rollout = join(dir, 'rollout-2026-09-23T13-12-43-0001.jsonl');
      const sinceMs = Date.now();
      const userRow = (text: string, ts: number) =>
        JSON.stringify({
          timestamp: new Date(ts).toISOString(),
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        });
      // An OLDER truncated row must not certify this injection.
      writeFileSync(rollout, `${userRow('bd294b2da8⟧\nstale', sinceMs - 60_000)}\n`);
      const stale = await waitForNativeTranscriptMarker({ agent: 'codex', env, marker, sinceMs, home, timeoutMs: 30, pollMs: 5 });
      expect(stale).toEqual({ persisted: false, nativeRef: null });
      writeFileSync(rollout, `${userRow('bd294b2da8⟧\nYou are the auditor', sinceMs + 1)}\n`, { flag: 'a' });
      const proof = await waitForNativeTranscriptMarker({ agent: 'codex', env, marker, sinceMs, home, timeoutMs: 100, pollMs: 5 });
      expect(proof).toEqual({ persisted: true, nativeRef: rollout, markerTruncated: { lostChars: 39 } });
      // The immediately following fresh row can upgrade this same-injection
      // truncated proof to exact, with no degraded flag.
      writeFileSync(rollout, `${userRow(`${marker}\nexact`, sinceMs + 2)}\n`, { flag: 'a' });
      const exact = await waitForNativeTranscriptMarker({ agent: 'codex', env, marker, sinceMs, home, timeoutMs: 100, pollMs: 5 });
      expect(exact).toEqual({ persisted: true, nativeRef: rollout });

      // An intervening user prompt closes the upgrade window, so an exact
      // marker on a later turn cannot retroactively certify this kickoff.
      writeFileSync(rollout, [
        userRow('bd294b2da8⟧\nYou are the auditor', sinceMs + 3),
        userRow('an unrelated later task', sinceMs + 4),
        userRow(`${marker}\nexact`, sinceMs + 5),
      ].join('\n') + '\n');
      const laterExact = await waitForNativeTranscriptMarker({ agent: 'codex', env, marker, sinceMs, home, timeoutMs: 100, pollMs: 5 });
      expect(laterExact).toEqual({
        persisted: true,
        nativeRef: rollout,
        markerTruncated: { lostChars: 39 },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('hostThroughPty real round-trip', () => {
  it(
    'refuses a second live host before spawn/unlink and leaves the original socket injectable',
    async () => {
      const ownerId = `su-duplicate-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      mkdirSync(PSU_PTY_DIR, { recursive: true });
      const originalCode = [
        "const fs=require('node:fs');const net=require('node:net');",
        `const sock=${JSON.stringify(sock)},meta=${JSON.stringify(meta)},owner=${JSON.stringify(ownerId)};`,
        "try{fs.unlinkSync(sock)}catch{}",
        "const server=net.createServer(c=>{let b='';c.setEncoding('utf8');c.on('data',d=>{b+=d;if(b.includes('PROBE\\n')){c.end('ORIGINAL-ACK\\n')}if(b.includes('QUIT\\n')){c.end('BYE\\n');server.close(()=>{try{fs.unlinkSync(meta)}catch{};process.exit(0)})}})});",
        "server.listen(sock,()=>{fs.writeFileSync(meta,JSON.stringify({ownerId:owner,pid:process.pid,sock}));process.stdout.write('READY\\n')});",
        "setTimeout(()=>process.exit(3),15000);",
      ].join('');
      const original = spawn(
        execPath,
        ['-e', originalCode, 'psu-pty-host-decoy'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: hermeticEnv() },
      );
      try {
        let stdoutText = '';
        let stderrText = '';
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(
              'original host did not become ready (pid=' + original.pid + ')' +
              '; stdout=' + stdoutText.slice(-300) + '; stderr=' + stderrText.slice(-1000),
            )),
            5_000,
          );
          original.stdout!.setEncoding('utf8');
          original.stderr!.setEncoding('utf8');
          original.stderr!.on('data', (data) => { stderrText += String(data); });
          original.stdout!.on('data', (data) => {
            stdoutText += String(data);
            if (stdoutText.includes('READY')) {
              clearTimeout(timer);
              resolve();
            }
          });
          original.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          original.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`original host exited early (${code})`));
          });
        });

        let onSpawnCalls = 0;
        expect(() =>
          hostThroughPty({
            command: execPath,
            args: ['-e', 'setTimeout(()=>{},10000)'],
            cwd: '/tmp',
            env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
            ownerId,
            io: fakeIo().io,
            bridgeTty: false,
            onSpawn: () => {
              onSpawnCalls += 1;
            },
            onExit: () => {},
          }),
        ).toThrow(new RegExp(`refusing duplicate startup.*${ownerId}.*${original.pid}`));
        expect(onSpawnCalls).toBe(0);
        expect(existsSync(sock)).toBe(true);
        expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(original.pid);

        const ack = await new Promise<string>((resolve, reject) => {
          let text = '';
          const client = net.createConnection(sock);
          client.setEncoding('utf8');
          client.on('connect', () => client.write('PROBE\n'));
          client.on('data', (data) => {
            text += data;
          });
          client.on('end', () => resolve(text));
          client.on('error', reject);
        });
        expect(ack).toContain('ORIGINAL-ACK');
      } finally {
        if (original.exitCode === null) {
          await new Promise<void>((resolve) => {
            const client = net.createConnection(sock, () => client.write('QUIT\n'));
            client.on('data', () => {});
            client.on('end', resolve);
            client.on('error', () => {
              original.kill('SIGKILL');
              resolve();
            });
          });
          await new Promise<void>((resolve) => original.once('exit', () => resolve()));
        }
        try { unlinkSync(sock); } catch { /* server close may already unlink it */ }
        try { unlinkSync(meta); } catch { /* child cleanup normally removes it */ }
      }
    },
    20_000,
  );
  it(
    'selects Claude resume-compaction summary before delivering a scripted kickoff',
    async () => {
      const ownerId = `su-resume-compaction-itest-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      const childCode = [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.setRawMode?.(true);",
        "let selected=0,input='',kickoffReceived=false;",
        "setTimeout(()=>{process.stdout.write('\\x1b[31mAutocompact is th');setTimeout(()=>process.stdout.write(\"rashing\\x1b[0m\\n1. Resume from summary (recommended)\\n2. Resume full session as-is\\n3. Don't ask again\\n\"),30);},20);",
        "process.stdin.on('data',d=>{input+=d;if(!selected&&input.includes('KICKOFF')){process.stdout.write('EARLY_KICKOFF\\n');process.exit(3);return;}if(!selected&&input.includes('\\r')){selected++;input='';process.stdout.write('RESUME_SELECTED\\n\\n\\x1b[32m❯\\x1b[0m \\n');return;}if(selected&&!kickoffReceived&&input.includes('KICKOFF')){kickoffReceived=true;process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),100);}});",
        "setTimeout(()=>process.exit(2),5000);",
      ].join('');
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS: '1000',
          PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS: '1000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '2000',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '500',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          // The synthetic child exits shortly after acknowledging the kickoff;
          // keep the submit verifier from mistaking that intentional teardown
          // for a swallowed Enter while this test checks recovery ordering.
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '500',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff: 'KICKOFF',
        onExit: () => undefined,
      });
      try {
        const deadline = Date.now() + 4_000;
        while (!captured().includes('KICKOFF_RECEIVED') && Date.now() < deadline) await sleep(10);
        expect(captured()).not.toContain('EARLY_KICKOFF');
        expect(captured()).toContain('RESUME_SELECTED');
        expect(captured()).toContain('KICKOFF_RECEIVED');
        expect(await done).toBe(0);
      } finally {
        // The child has a bounded self-exit; this cleanup only removes the
        // owner-specific discovery artifacts if an assertion fails early.
        await done;
      }
    },
    10_000,
  );

  it(
    'publishes a plain-launch native kickoff proof into the parent receipt',
    async () => {
      if (typeof process.getuid !== 'function') return;
      const root = mkdtempSync(join(tmpdir(), 'psu-kickoff-proof-itest-'));
      const ownerId = `su-kickoff-proof-itest-${process.pid}-${Math.floor(performance.now())}`;
      const proofPath = join(root, 'kickoff-proof.json');
      const token = 'c'.repeat(48);
      const codexHome = join(root, 'codex-home');
      const nativeFile = join(codexHome, 'sessions', '2026', '08', 'rollout.jsonl');
      const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
      const kickoffMarkerEchoTimeoutMs = 4_000;
      const nativePersistenceTimeoutMs = 3_000;
      const parentReceiptWaitMs = kickoffMarkerEchoTimeoutMs + nativePersistenceTimeoutMs + 1_000;
      const kickoff = `${marker}\nBEGIN_PROOF_KICKOFF`;
      writeFileSync(proofPath, '', { mode: 0o600 });
      chmodSync(proofPath, 0o600);
      const { captured, io } = fakeIo();
      const childCode = [
        "const fs=require('fs'),path=require('path');",
        "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
        "let b='',echoed=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\n');",
        "process.stdin.on('data',d=>{b+=d;if(!b.includes('⟧'))return;if(!echoed){echoed=true;process.stdout.write('COMPOSER_ECHO:'+b+'\\n');}if(!b.includes('\\r'))return;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const row={type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:process.env.KICKOFF_MARKER}]}};fs.writeFileSync(process.env.NATIVE_FILE,JSON.stringify(row)+'\\n');process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),50);});",
        'setTimeout(()=>process.exit(2),5000);',
      ].join('');
      let done;
      try {
        done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...hermeticEnv(),
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'codex',
            CODEX_HOME: codexHome,
            NATIVE_FILE: nativeFile,
            KICKOFF_MARKER: marker,
            [KICKOFF_PROOF_PATH_ENV]: proofPath,
            [KICKOFF_PROOF_TOKEN_ENV]: token,
            // This test checks parent-receipt publication, so give the
            // separate composer-echo gate its own bounded fixture window.
            PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS: String(kickoffMarkerEchoTimeoutMs),
            PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
            PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
            PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '20',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
            TERM: 'xterm-256color',
          },
          ownerId,
          io,
          bridgeTty: false,
          kickoff,
          nativePersistenceTimeoutMs,
          onExit: () => undefined,
        });
        // Cover the echo gate, native proof window, and a short scheduling margin.
        const deadline = Date.now() + parentReceiptWaitMs;
        while (readFileSync(proofPath, 'utf8').length === 0 && Date.now() < deadline) await sleep(10);
        expect(captured()).toContain('KICKOFF_RECEIVED');
        expect(captured()).toContain(`COMPOSER_ECHO:${marker}`);
        expect(captured().indexOf(`COMPOSER_ECHO:${marker}`)).toBeLessThan(captured().indexOf('KICKOFF_RECEIVED'));
        expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual({
          token,
          persisted: true,
          nativeRef: nativeFile,
          reason: null,
        });
        expect(await done).toBe(0);
      } finally {
        await done?.catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(['claude', 'codex', 'omp'].flatMap((agent) =>
    ['accepted', 'unknown', 'refused'].map((outcome) => [agent, outcome] as const)))(
    'publishes managed %s session-port parent proof before HTTP ack and handles %s acknowledgement (EI-259750)',
    async (agent, outcome) => {
      const root = mkdtempSync(join(tmpdir(), 'psu-port-host-'));
      const agentDir = join(root, 'target-native-home');
      const sessionsDir = agent === 'claude'
        ? join(agentDir, 'projects', '-tmp') : join(agentDir, 'sessions', 'project');
      mkdirSync(sessionsDir, { recursive: true });
      const nativeFile = join(sessionsDir, 'thread.jsonl');
      const hash = 'c'.repeat(64);
      const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${hash}]`;
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `ported history\n${marker}\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      const proofPath = join(root, 'proof.json');
      const token = 'c'.repeat(48);
      writeFileSync(proofPath, '', { mode: 0o600 });
      chmodSync(proofPath, 0o600);
      const ownerId = `su-port-itest-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      let finishAck!: () => void;
      const ackDone = new Promise<void>((resolve) => { finishAck = resolve; });
      const expectedReceipt = { token, persisted: true, nativeRef: nativeFile, reason: null };
      const onExit = vi.fn();
      let nativeProofObserved!: () => void;
      const nativeProof = new Promise<void>((resolve) => { nativeProofObserved = resolve; });
      const onKickoffPersisted = vi.fn(async () => {
        expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual(expectedReceipt);
        nativeProofObserved();
        await ackDone;
        if (outcome !== 'accepted') {
          const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, forwardingResult: 'outcome_unknown' }), { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, port: { status: outcome === 'unknown' ? 'pending' : 'failed', targetAdvSessionId: 999 } }), { status: 200 }));
          return reportSessionPortDelivery(
            { portId: '22222222-2222-4222-8222-222222222222', targetAdvSessionId: 999 },
            { persisted: true, renderedHash: hash, nativeRef: nativeFile },
            // WI-6554700010029943: this case asserts ordering and the emitted ack event, not
            // timing. Every fetch after the two mocked ones is unanswered, so the status-read
            // re-read backoff (WI-6554700010029882: 2+4+8+16s) would run on the real clock
            // and overrun the 15s test timeout. Keep the retry SEMANTICS, drop the wall time.
            { fetchImpl, operatorUrl: 'http://operator', token: 'test', coordOwnerId: ownerId, appendEventImpl: appendHostEvent,
              sleepImpl: async () => {} },
          );
        }
      });
      let done: Promise<number> | undefined;
      const childCode = [
        "const fs=require('fs'),path=require('path');",
        "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
        "let ready=false,b='',wrote=false;setTimeout(()=>{ready=true;process.stdout.write(process.env.PORT_READY_OUTPUT);},400);",
        // The real native transcript persists the whole user turn, including
        // both its origin marker (submit verification) and port checksum.
        // Echo the composer before CR so Codex's separate submit gate is exercised.
        "process.stdin.on('data',d=>{b+=d;process.stdout.write(d);if(wrote&&b.includes('EXIT_AFTER_RECEIPT')){process.stdout.write('EXITING\\n');process.exit(0);return;}if(!wrote&&b.includes(process.env.PORT_MARKER)&&b.includes('\\r')){if(!ready){process.stdout.write('EARLY-SEED\\n');process.exit(3);return;}wrote=true;const content=b.slice(b.indexOf('⟦turn-origin:session-port'),b.indexOf(process.env.PORT_MARKER)+process.env.PORT_MARKER.length);const timestamp=new Date().toISOString();const row=process.env.PAPERCUSP_AGENT==='codex'?{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:content}]}}:process.env.PAPERCUSP_AGENT==='claude'?{type:'user',timestamp,message:{role:'user',content}}:{type:'message',role:'user',content,timestamp};fs.mkdirSync(path.dirname(process.env.PORT_NATIVE_FILE),{recursive:true});fs.writeFileSync(process.env.PORT_NATIVE_FILE,JSON.stringify(row)+'\\n');process.stdout.write('ANSWER_OWNER:'+process.env.PAPERCUSP_SID+'\\nWORKING\\n');}});",
        "setTimeout(()=>process.exit(2),10000);",
      ].join('');
      try {
        done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...hermeticEnv(),
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: agent,
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
            PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
            PAPERCUSP_TURN_PROVENANCE_DIR: join(root, 'provenance'),
            PI_CODING_AGENT_DIR: agentDir,
            CODEX_HOME: agentDir,
            CLAUDE_CONFIG_DIR: agentDir,
            PORT_READY_OUTPUT: agent === 'claude' ? '❯\n' : agent === 'codex'
              ? '\x1b[6nmodel: GPT-6.1-Sol xhigh\n62% context left\n' : 'omp v16.3.3\nREADY\n',
            PORT_MARKER: marker,
            PORT_NATIVE_FILE: nativeFile,
            [KICKOFF_PROOF_PATH_ENV]: proofPath,
            [KICKOFF_PROOF_TOKEN_ENV]: token,
            TERM: 'xterm-256color',
          },
          ownerId,
          advSessionId: 999,
          io,
          bridgeTty: false,
          kickoffFile: seed,
          sessionPort: { renderedHash: hash },
          onKickoffPersisted,
          nativePersistenceTimeoutMs: 3000,
          onExit,
        });
        await Promise.race([
          nativeProof,
          done.then(() => { throw new Error('fixture child exited before native proof'); }),
        ]);
        const deadline = Date.now() + 5000;
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        expect(onKickoffPersisted.mock.calls[0]?.[0], captured()).toEqual({
          persisted: true,
          renderedHash: hash,
          nativeRef: nativeFile,
        });
        expect(readFileSync(nativeFile, 'utf8')).toContain('⟦turn-origin:session-port nonce:');
        expect(captured()).toContain(`ANSWER_OWNER:${ownerId}`);
        if (outcome !== 'accepted') {
          const originalNative = readFileSync(nativeFile, 'utf8');
          finishAck();
          const event = outcome === 'unknown' ? 'session-port-delivery-ack-pending' : 'session-port-delivery-ack-failed';
          while (!readFileSync(eventLogPathForOwner(ownerId), 'utf8').includes(event) && Date.now() < deadline) await sleep(25);
          expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8')).toContain(event);
          if (outcome === 'unknown') {
            expect(await Promise.race([done.then(() => true), sleep(100).then(() => false)])).toBe(false);
            expect(onExit).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual(expectedReceipt);
            expect(readFileSync(nativeFile, 'utf8')).toBe(originalNative);
            await rawInject(socketPathFor(ownerId), 'EXIT_AFTER_RECEIPT\n');
            expect(await done).toBe(0);
            expect(onExit.mock.calls[0]?.[1]).toBeFalsy();
          } else {
            await done;
            // node-pty reports a signal kill with exitCode=0. The signal
            // callback is the authoritative lifecycle evidence.
            expect(onExit.mock.calls[0]?.[1]).toBe('SIGHUP');
          }
          expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
          return;
        }
        // Drive the child exit after the parent proof, while the HTTP ack is
        // still held, rather than racing transcript scanning with a timer.
        await rawInject(socketPathFor(ownerId), 'EXIT_AFTER_RECEIPT\n');
        while (!captured().includes('EXITING') && Date.now() < deadline) await sleep(25);
        expect(captured()).toContain('EXITING');
        expect(await Promise.race([done.then(() => true), sleep(50).then(() => false)])).toBe(false);
        expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual(expectedReceipt);
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        finishAck();
        expect(await done).toBe(0);
      } finally {
        finishAck();
        await rawInject(socketPathFor(ownerId), 'EXIT_AFTER_RECEIPT\n').catch(() => undefined);
        await done?.catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(['child-exit', 'missing-native-marker'])(
    'publishes a managed session-port negative parent proof for %s before acknowledgement and cleanup',
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'psu-port-negative-'));
      const hash = 'b'.repeat(64);
      const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${hash}]`;
      const seed = join(root, 'seed.md');
      const proofPath = join(root, 'proof.json');
      const token = 'b'.repeat(48);
      writeFileSync(seed, `ported history\n${marker}\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      writeFileSync(proofPath, '', { mode: 0o600 });
      chmodSync(proofPath, 0o600);
      const ownerId = `su-port-negative-${process.pid}-${failure}-${Math.floor(performance.now())}`;
      const { io } = fakeIo();
      const onExit = vi.fn();
      const onKickoffPersisted = vi.fn(async (proof) => {
        expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual({
          token, persisted: false, nativeRef: null, reason: proof.error,
        });
      });
      const childCode = [
        "const fs=require('fs'),path=require('path');",
        "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
        // Isolate child-exit from missing-marker verification. Scheduling an
        // exit after submission races the 300ms scanner and does not guarantee
        // which valid negative disposition wins.
        "process.stdout.write('omp v16.3.3\\nREADY\\n');if(process.env.PORT_FAILURE==='child-exit')process.exit(3);let b='',submitted=false;",
        // Submit proof exists, but the exact managed checksum does not.
        "process.stdin.on('data',d=>{b+=d;if(!submitted&&b.includes(process.env.PORT_MARKER)&&(b.includes('\\r')||b.includes('\\n'))){submitted=true;fs.mkdirSync(path.dirname(process.env.PORT_NATIVE_FILE),{recursive:true});fs.writeFileSync(process.env.PORT_NATIVE_FILE,JSON.stringify({type:'message',role:'user',content:b.split('\\n')[0],timestamp:new Date().toISOString()})+'\\n');process.stdout.write('SUBMITTED\\n');}});",
        "setTimeout(()=>process.exit(2),10000);",
      ].join('');
      try {
        await hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...hermeticEnv(),
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'omp',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
            PAPERCUSP_TURN_PROVENANCE_DIR: join(root, 'provenance'),
            PI_CODING_AGENT_DIR: join(root, 'omp-agent'),
            PORT_MARKER: marker,
            PORT_FAILURE: failure,
            PORT_NATIVE_FILE: join(root, 'omp-agent', 'sessions', 'project', 'thread.jsonl'),
            [KICKOFF_PROOF_PATH_ENV]: proofPath,
            [KICKOFF_PROOF_TOKEN_ENV]: token,
            TERM: 'xterm-256color',
          },
          ownerId,
          io,
          bridgeTty: false,
          kickoffFile: seed,
          sessionPort: { renderedHash: hash },
          onKickoffPersisted,
          nativePersistenceTimeoutMs: 300,
          onExit,
        });
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        expect(onKickoffPersisted.mock.calls[0]?.[0]).toMatchObject({ persisted: false, renderedHash: hash });
        const receipt = JSON.parse(readFileSync(proofPath, 'utf8'));
        expect(receipt.reason).toContain(failure === 'child-exit' ? 'target child exited' : 'not found in the omp native transcript');
        expect(receipt.persisted).toBe(false);
        if (failure === 'child-exit') expect(onExit).toHaveBeenCalledWith(3, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'external SIGTERM tears down the whole OMP-style process group and reaps detached scope before child exit',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-port-sigint-'));
      const hash = 'd'.repeat(64);
      const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${hash}]`;
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `ported history\n${marker}\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      const ownerId = `su-port-sigint-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      const signals = new EventEmitter();
      const onKickoffPersisted = vi.fn(async () => undefined);
      const reapScopeResidue = vi.fn(() => ({ killedPids: [4242], failedPids: [] }));
      const childCode = [
        "const {spawn}=require('child_process');",
        "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        "process.stdout.write('GRAND:'+g.pid+'\\nomp v16.3.3\\n');",
        "process.stdin.setRawMode?.(true);process.stdin.resume();setInterval(()=>{},1000);",
      ].join('');
      try {
        const done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...hermeticEnv(),
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'omp',
            PAPERCUSP_LAUNCHED_BY: 'su-parent',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
            PAPERCUSP_TURN_PROVENANCE_DIR: join(root, 'provenance'),
            PI_CODING_AGENT_DIR: join(root, 'omp-agent'),
            TERM: 'xterm-256color',
          },
          ownerId,
          io,
          bridgeTty: true,
          kickoffFile: seed,
          sessionPort: { renderedHash: hash },
          onKickoffPersisted,
          nativePersistenceTimeoutMs: 5000,
          signalSource: signals,
          reapScopeResidue,
          onExit: () => undefined,
        });
        const deadline = Date.now() + 3000;
        while (!/GRAND:\d+/.test(captured()) && Date.now() < deadline) await sleep(25);
        const grandPid = Number(captured().match(/GRAND:(\d+)/)?.[1]);
        expect(grandPid).toBeGreaterThan(1);
        expect(() => process.kill(grandPid, 0)).not.toThrow();

        const processState = () => {
          try { return linuxProcStateFromStat(readFileSync(`/proc/${grandPid}/stat`, 'utf8')); }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
        };
        const states = { beforeSignal: processState(), afterSignal: '', afterHostExit: '', afterWait: '' };

        signals.emit('SIGTERM');
        states.afterSignal = processState() ?? 'unknown';
        // External kill must not wait for node-pty's asynchronous child exit
        // event: fleet:kill may SIGKILL this host during that gap.
        expect(reapScopeResidue).toHaveBeenCalledTimes(1);
        await done;
        states.afterHostExit = processState() ?? 'unknown';
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        expect(onKickoffPersisted.mock.calls[0]?.[0]).toMatchObject({
          persisted: false,
          renderedHash: hash,
        });
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
        expect(signals.listenerCount('SIGHUP')).toBe(0);

        let alive = true;
        const reapDeadline = Date.now() + 2000;
        while (alive && Date.now() < reapDeadline) {
          const state = processState();
          // SIGKILL has terminated a zombie; its PID remains visible until the
          // adopting parent reaps it. kill(pid, 0) alone cannot measure execution.
          if (state === 'Z' || state === 'X' || state === 'absent') alive = false;
          else {
            try { process.kill(grandPid, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
          }
          if (alive) await sleep(25);
        }
        let childStat = 'absent';
        try { childStat = readFileSync(`/proc/${grandPid}/stat`, 'utf8'); } catch { /* disappeared after probe */ }
        states.afterWait = processState() ?? 'unknown';
        console.info(`PTY_SIGTERM_PROCESS_STATES ${JSON.stringify(states)}`);
        expect(alive, `SIGTERM grandchild ${grandPid} states ${JSON.stringify(states)} proc stat: ${childStat}`).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'creates socket+meta on start, injects into the live child, cleans up on exit',
    async () => {
      const ownerId = `su-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // Child acknowledges its installed reader and exits on the test's command.
      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='QUIT')process.exit(0);process.stdout.write('ECHO:'+line+'\\n');}});" +
        "process.stdout.write('READER_READY\\n');";

      let exitCode: number | null = null;
      const signalSource = new EventEmitter();
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 4242,
        io,
        bridgeTty: false,
        signalSource,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('READER_READY'), { timeout: 8000 });
        // Created on start
        expect(existsSync(sock)).toBe(true);
        expect(existsSync(meta)).toBe(true);
        const m = JSON.parse(readFileSync(meta, 'utf8'));
        expect(m.ownerId).toBe(ownerId);
        expect(m.advSessionId).toBe('4242');
        expect(m.sock).toBe(sock);
        expect(typeof m.pid).toBe('number');

        // Inject a line via the control socket → the child reads it from stdin.
        await rawInject(sock, 'hello-wake\n');
        await vi.waitFor(() => expect(captured()).toContain('ECHO:hello-wake'), { timeout: 8000 });

        await rawInject(sock, 'QUIT\n');
        const code = await done;
        expect(code).toBe(0);
        expect(exitCode).toBe(0);

        // Cleaned up on exit
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        signalSource.emit('SIGTERM');
        await done;
      }
    },
    20_000,
  );

  it(
    'EI-153: REFUSES a control envelope addressed to a DIFFERENT ownerId — never runs it — then still serves a correctly-addressed one',
    async () => {
      const ownerId = `su-itest-misdeliver-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      const childCode =
        "process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
        "process.stdout.write('MISDELIVERY_CHILD_READY\\n');";
      const signalSource = new EventEmitter();

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 4243,
        io,
        signalSource,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('MISDELIVERY_CHILD_READY'), { timeout: 2000 });
        expect(existsSync(sock)).toBe(true);

        // Addressed to a DIFFERENT agent — the host must refuse to run it, no
        // matter that the socket write itself succeeds (same-UID trust boundary
        // only guards WHO can connect, not WHOM the message is for).
        await envelopeInject(sock, { mode: 'raw', data: 'should-not-land\n', ownerId: 'su-someone-else' });
        await vi.waitFor(() => {
          const events = readFileSync(eventLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
          const rejected = events.find(
            (e) => e.kind === 'control-payload-rejected' && e.reason === 'ownerId-mismatch',
          );
          expect(rejected).toMatchObject({ expected: ownerId, got: 'su-someone-else', mode: 'raw' });
        }, { timeout: 2000 });
        expect(captured()).not.toContain('ECHO:should-not-land');

        // The host itself is otherwise unharmed: a correctly-addressed (or
        // unaddressed, pre-EI-153-shaped) message still lands normally.
        await envelopeInject(sock, { mode: 'raw', data: 'should-land\n', ownerId });
        await vi.waitFor(() => expect(captured()).toContain('ECHO:should-land'), { timeout: 2000 });
      } finally {
        signalSource.emit('SIGTERM');
        await done.catch(() => undefined);
      }
    },
    20_000,
  );

  it('rejects unsupported control envelopes with a NACK and zero child input, then accepts a supported request', async () => {
    const ownerId = `su-itest-control-version-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const signals = new EventEmitter();
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString('hex')+'\\n'));process.stdout.write('CONTROL_READY\\n');"],
      cwd: '/tmp', env: hermeticEnv({ PAPERCUSP_SID: ownerId }), ownerId,
      io, signalSource: signals, bridgeTty: false,
    });
    const send = (envelope: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const conn = net.connect(sock, () => conn.end(JSON.stringify(envelope)));
      const output = createTextCollector(conn);
      conn.on('error', reject);
      conn.on('close', () => {
        try { resolve(JSON.parse(output.text().trim())); } catch (error) { reject(error); }
      });
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('CONTROL_READY'), { timeout: 5000 });
      for (const envelope of [
        { v: 1, mode: 'hooks-inventory', data: '/hooks' },
        { v: 2, mode: 'raw', data: 'unsupported-version' },
      ]) {
        expect(await send({ ...envelope, ownerId })).toMatchObject({ ok: false, reason: 'unsupported-control-envelope' });
      }
      expect(captured()).not.toContain('INPUT:');
      expect(await send({ v: 1, mode: 'hooks-observe', observationVersion: 1, ownerId,
        expectedAdvSessionId: 'wrong', expectedNativeSessionId: 'wrong', expectedHostStartedAt: 1,
        expectedChildGeneration: 1, expectedHostCodeVersion: 'wrong' })).toMatchObject({ ok: false });
      expect(captured()).not.toContain('INPUT:');
      expect(await send({ v: 1, mode: 'raw', data: 'still-responsive', ownerId })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(captured()).toContain(`INPUT:${Buffer.from('still-responsive').toString('hex')}`), { timeout: 5000 });
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(events.filter((event) => event.kind === 'control-payload-rejected' && event.reason === 'unsupported-control-envelope')).toHaveLength(2);
    } finally {
      signals.emit('SIGTERM');
      await done.catch(() => undefined);
    }
  }, 20_000);

  it(
    "WI-2141435: control-payload-unaddressed fires with envelope:true for a v1 envelope that " +
      'simply omits ownerId, and envelope:false for a genuinely non-envelope legacy payload — the ' +
      "detector the EI-153 guard's reject-only logging could not provide (its silence could not " +
      "distinguish 'nothing to catch' from 'structurally blind to this class'). DETECTOR ONLY: " +
      'control flow is unchanged, so this test only asserts the event log, not delivery.',
    async () => {
      const ownerId = `su-itest-unaddressed-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { io } = fakeIo();

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', 'setTimeout(()=>process.exit(0),4000);'],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 424535,
        io,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await sleep(400);
        expect(existsSync(sock)).toBe(true);

        // Case A: a well-formed v1 envelope that simply OMITS ownerId (a pre-EI-153
        // sender) — decodeControl decodes it normally; only ownerId is unset.
        await envelopeInject(sock, { mode: 'raw', data: 'x' });
        await sleep(300);

        // Case B: a genuinely non-envelope payload (not JSON at all) — decodeControl's
        // legacy promotion to mode:'turn' with no ownerId whatsoever.
        await new Promise<void>((resolve) => {
          const c = net.connect(sock, () => {
            c.write('plain-legacy-text');
            c.end();
          });
          c.on('data', () => {});
          c.on('error', () => resolve());
          c.on('close', () => resolve());
        });
        await sleep(300);

        const events = readFileSync(eventLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const unaddressed = events.filter((e) => e.kind === 'control-payload-unaddressed');
        expect(unaddressed).toHaveLength(2);
        expect(unaddressed.find((e) => e.mode === 'raw')).toMatchObject({ reason: 'no-ownerId', envelope: true });
        expect(unaddressed.find((e) => e.mode === 'turn')).toMatchObject({ reason: 'no-ownerId', envelope: false });
      } finally {
        await done.catch(() => undefined);
      }
    },
    20_000,
  );
});

describe('RECYCLE / backend-aware RESET — kill + respawn the child in the same host (su-cold-auto-mode P-004b)', () => {
  it.each([
    { withDrillMetadata: true, role: '' },
    { withDrillMetadata: false, role: '' },
    { withDrillMetadata: true, role: 'researcher' },
  ])(
    'uses the Claude composer glyph to deliver a carry while the fresh TUI keeps repainting (drill metadata: $withDrillMetadata; role: $role)',
    async ({ withDrillMetadata, role }) => {
      const ownerId = `su-recycle-claude-ready-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n❯\\n');" +
        "const marker=process.argv[process.argv.length-1];" +
        "let repaint=null;if(marker==='RECYCLED'){repaint=setInterval(()=>process.stdout.write('.'),20);}" +
        "process.stdin.setEncoding('utf8');let b='',mcp=false,carryEchoed=false;" +
        "process.stdin.on('data',d=>{b+=d;if(repaint){clearInterval(repaint);repaint=null;}if(!mcp&&(b.includes('/mcp\\r')||b.includes('/mcp\\n'))){mcp=true;process.stdout.write('MCP_DIALOG\\n❯ 1. papercusp-su connecting\\n');setTimeout(()=>process.stdout.write('MCP_RECONNECTED\\n❯ 1. papercusp-su connected\\n'),250);}if(!carryEchoed&&b.includes('CARRIED')){carryEchoed=true;process.stdout.write('ECHO:CARRIED\\n');}if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),15000);';
      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          ...(role ? { PAPERCUSP_ROLE: role } : {}),
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintCarryRespawnArgs: (args: string[]) => ({ args: args.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 8000 });
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: 'CARRIED',
          systemPromptAddendum: 'deterministic carry',
          ...(withDrillMetadata ? { drillId: 'claude-ready', sessionClass: 'claude-su' } : {}),
        });
        const deadline = Date.now() + 5_000;
        while (!captured().includes('ECHO:CARRIED') && Date.now() < deadline) await sleep(25);
        expect(captured()).toContain('ECHO:CARRIED');
        const events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(events.filter((event) => event.kind === 'busy-gate-expired' && event.mode === 'carry-respawn')).toEqual([]);
        if (role) {
          // Actual signed-role identity outranks optional drill classification.
          expect(captured()).not.toContain('MCP_DIALOG');
          expect(events.some((event) => event.kind === 'respawn-carry-mcp-ready')).toBe(false);
        } else {
          expect(captured()).toContain('MCP_DIALOG');
          expect(captured()).toContain('MCP_RECONNECTED');
          expect(captured().indexOf('MCP_RECONNECTED')).toBeLessThan(captured().indexOf('ECHO:CARRIED'));
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'respawn-carry-mcp-ready',
            serverName: 'papercusp-su',
            attempts: 1,
          }));
        }
        expect(JSON.parse(readFileSync(meta, 'utf8')).carryDropCount ?? 0).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'does not submit a carry when papercusp-su readiness fails after the fresh TUI boots',
    async () => {
      const ownerId = `su-recycle-claude-mcp-failed-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const signalSource = new EventEmitter();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n❯\\n');" +
        "process.stdin.setEncoding('utf8');let b='',mcpDialogs=0;" +
        "process.stdin.on('data',d=>{b+=d;if(mcpDialogs<2&&(b.includes('/mcp\\r')||b.includes('/mcp\\n'))){mcpDialogs++;process.stdout.write('MCP_DIALOG\\n❯ 1. unrelated-server connected\\n');}if(b.includes('CARRY_MUST_NOT_BE_WRITTEN'))process.stdout.write('ECHO:FORBIDDEN_CARRY\\n');if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),30000);';
      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CARRY_PROOF_RETRIES: '0',
        },
        ownerId,
        io,
        bridgeTty: false,
        signalSource,
        mintCarryRespawnArgs: (args: string[]) => ({ args: args.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 5_000 });
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: 'CARRY_MUST_NOT_BE_WRITTEN',
          systemPromptAddendum: 'deterministic carry',
        });
        const deadline = Date.now() + 24_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < deadline) {
          if (existsSync(eventLog)) {
            const contents = readFileSync(eventLog, 'utf8').trim();
            events = contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
            if (events.some((event) => event.kind === 'respawn-carry-mcp-unavailable')) break;
          }
          await sleep(50);
        }

        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-mcp-unavailable',
          serverName: 'papercusp-su',
          attempts: 2,
        }));
        expect(captured()).not.toContain('ECHO:FORBIDDEN_CARRY');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          reason: 'carry-mcp-unavailable',
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        // Lifecycle emission precedes serialized async discovery publication.
        // Observe the persisted transition before asserting its counter.
        await vi.waitFor(() => {
          expect(JSON.parse(readFileSync(meta, 'utf8')).carryDropCount).toBe(1);
        }, { timeout: 5_000 });
        // End this fixture through an observed child exit. SIGTERM cleanup while
        // the child is still alive correctly reports an unverified exit as code 1.
        await rawInject(sock, 'QUIT\n');
        await done;
      } finally {
        if (existsSync(sock)) signalSource.emit('SIGTERM');
        await done;
      }
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
      if (existsSync(eventLog)) unlinkSync(eventLog);
    },
    32_000,
  );

  it(
    'retries a carry on one fresh child when MCP becomes ready after the first epoch',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-carry-mcp-delay-'));
      const claudeConfig = join(root, 'claude');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      const ownerId = `su-recycle-claude-mcp-delay-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const nativeIds = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ];
      const marker = '⟦turn-origin:self-compaction nonce:fedcba9876543210⟧';
      const childCode =
        "const fs=require('node:fs'),path=require('node:path');" +
        "const nativeId=process.argv[process.argv.length-1],epoch=process.argv[process.argv.length-2];" +
        "process.stdout.write('BOOT:'+epoch+'\\n❯\\n');" +
        "process.stdin.setEncoding('utf8');let b='',recorded=false;" +
        "process.stdin.on('data',d=>{b+=d;if(!recorded&&b.includes('⟦turn-origin:self-compaction nonce:fedcba9876543210⟧')){" +
        "const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','-tmp',nativeId+'.jsonl');" +
        "fs.mkdirSync(path.dirname(file),{recursive:true});" +
        "fs.appendFileSync(file,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'⟦turn-origin:self-compaction nonce:fedcba9876543210⟧'}]}})+'\\n');" +
        "recorded=true;process.stdout.write('CARRY_ACCEPTED\\n');}if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),30000);';
      let epoch = 0;
      const reconnectAttempts: Array<{ epoch: number; serverName: string }> = [];
      const { captured, io } = fakeIo();
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_PSU_HEADLESS: '0',
          CLAUDE_CONFIG_DIR: claudeConfig,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '25',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        nativePersistenceTimeoutMs: 500,
        mintCarryRespawnArgs: (args: string[]) => {
          epoch += 1;
          return {
            args: args.slice(0, -1).concat(`CARRY_EPOCH_${epoch}`, nativeIds[epoch - 1]),
            nativeId: nativeIds[epoch - 1],
          };
        },
        // The fake CLI has a known identity before testing MCP recovery.
        onRespawn: async () => true,
        mcpReconnectMacro: async ({ serverName }: { serverName: string }) => {
          reconnectAttempts.push({ epoch, serverName });
          if (epoch === 1) {
            return { ok: false, step: 'await-connected', detail: 'MCP endpoint still unavailable' };
          }
          await sleep(25);
          return { ok: true, step: 'direct-reconnected', detail: 'MCP endpoint recovered' };
        },
        onExit: () => {},
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 2_000 });
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          ownerId,
          data: `${marker}\nContinue after MCP reconnect`,
          systemPromptAddendum: 'delayed MCP recovery regression',
          sessionClass: 'claude-su',
        });
        await vi.waitFor(() => {
          const log = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          expect(log).toContain('"kind":"respawn-carry-delivered"');
        }, { timeout: 8_000 });

        const events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(reconnectAttempts).toEqual([
          { epoch: 1, serverName: 'papercusp-su' },
          { epoch: 1, serverName: 'papercusp-su' },
          { epoch: 2, serverName: 'papercusp-su' },
        ]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-mcp-unavailable', serverName: 'papercusp-su', attempts: 2,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-fresh-epoch-retry',
          reason: 'carry-mcp-unavailable', attempt: 1, maxRetries: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-mcp-ready', serverName: 'papercusp-su', attempts: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-delivered', nativeId: nativeIds[1],
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-dropped')).toBe(false);
        expect(captured()).toContain('BOOT:CARRY_EPOCH_2');
        expect(captured()).toContain('CARRY_ACCEPTED');
        expect(JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8')).carryDropCount ?? 0).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'replaces the child process, keeps the host (socket/meta) alive, and opens the fresh process on the carry-note',
    async () => {
      const ownerId = `su-recycle-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'psu-recycle-boot-'));
      const bootRelease = join(fixtureRoot, 'ready');

      // Child prints BOOT:<pid> once on start, echoes stdin lines, exits on QUIT
      // (or a 15s safety net). The per-boot pid marker lets us prove the process
      // was actually replaced by the recycle, not just re-injected.
      const childCode =
        "const fs=require('fs');process.stdout.write('BOOT_PENDING\\n');" +
        "const boot=setInterval(()=>{if(fs.existsSync(process.env.BOOT_RELEASE)){clearInterval(boot);process.stdout.write('BOOT:'+process.pid+'\\n');}},10);" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          BOOT_RELEASE: bootRelease,
          // Reproduce the live failure deterministically: the fake successor
          // emits BOOT output but never Codex's version-specific composer
          // footer. The bounded fallback must admit it via output quiescence.
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          TERM: 'xterm-256color',
          // Speed the post-respawn carry inject: the fresh child's boot output goes
          // quiet fast, so a short output-quiet window lets the carry land promptly.
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
      // Deliberately hold BOOT until the test releases it. A fixed post-spawn
      // sleep cannot prove readiness; this real child exists before BOOT does.
      await vi.waitFor(() => expect(captured()).toContain('BOOT_PENDING'), { timeout: 8000 });
      expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(0);
      writeFileSync(bootRelease, 'ready');
      const bootsBefore = await vi.waitFor(() => {
        const boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        expect(boots).toHaveLength(1);
        return boots;
      }, { timeout: 8000 });
      const pid1 = bootsBefore[0];
      const ptyPid1 = JSON.parse(readFileSync(meta, 'utf8')).ptyPid;
      expect(ptyPid1).toBe(pid1);

      // A Codex RESET with a carry-note must take the same hard path as RECYCLE.
      // The host kills the child, fresh-spawns it in the SAME host (same
      // socket/meta/SID), and opens the fresh process on the carry.
      await controlInject(sock, 'reset', 'CARRIED');
      const bootsAfter = await vi.waitFor(() => {
        const boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        expect(boots).toHaveLength(2);
        expect(captured()).toContain('ECHO:CARRIED');
        return boots;
      }, { timeout: 8000 });
      const pid2 = bootsAfter[1];
      expect(pid2).not.toBe(pid1); // a genuinely new process
      const stopEvents = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      // Backend-aware reset enters the existing recycle path.
      expect(stopEvents.find((event) => event.kind === 'respawn-predecessor-stop-started'))
        .toMatchObject({ mode: 'recycle', predecessorPid: pid1 });
      expect(stopEvents.find((event) => event.kind === 'respawn-predecessor-stop-finished'))
        .toMatchObject({ mode: 'recycle', predecessorPid: pid1, forceKillRequested: false, exitObserved: true });
      expect(stopEvents.some((event) => event.kind === 'respawn-predecessor-force-kill')).toBe(false);
      // The carry-note was injected as the opening turn of the fresh context.
      expect(captured()).toContain('ECHO:CARRIED');

      // The HOST survived the recycle: socket + meta still live, meta now points at
      // the fresh child's pid (same host pid, new ptyPid).
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);
      const metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      expect(metaAfter.ownerId).toBe(ownerId);
      expect(metaAfter.ptyPid).toBe(pid2);

      // End the fresh child → the host tears down and cleans up (not before).
      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it(
    'force-kills a graceful-signal-resistant predecessor before spawning the successor',
    async () => {
      const ownerId = `su-recycle-predecessor-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>{});" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='QUIT')process.exit(0);}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS: '250',
          PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS: '500',
        },
        ownerId,
        advSessionId: 42,
        io,
        bridgeTty: false,
      });

      const bootDeadline = Date.now() + 5_000;
      while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
      expect(captured()).toContain('BOOT:');
      const firstBoot = Number(captured().match(/BOOT:(\d+)/)?.[1]);
      expect(Number.isInteger(firstBoot)).toBe(true);

      await controlInject(sock, 'recycle', '');
      const successorDeadline = Date.now() + 8_000;
      let boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      while (boots.length < 2 && Date.now() < successorDeadline) {
        await sleep(25);
        boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      }
      expect(boots).toHaveLength(2);
      expect(boots[1]).not.toBe(firstBoot);

      // The predecessor ignores the graceful signal. It must be dead before
      // this host can leave the recycle path with a second writer in flight.
      const predecessorGoneDeadline = Date.now() + 2_000;
      let predecessorAlive = true;
      while (predecessorAlive && Date.now() < predecessorGoneDeadline) {
        try {
          process.kill(firstBoot, 0);
        } catch {
          predecessorAlive = false;
          break;
        }
        await sleep(25);
      }
      expect(predecessorAlive).toBe(false);

      const stopEvents = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      const started = stopEvents.findIndex((event) => event.kind === 'respawn-predecessor-stop-started');
      const forced = stopEvents.findIndex((event) => event.kind === 'respawn-predecessor-force-kill');
      const finished = stopEvents.findIndex((event) => event.kind === 'respawn-predecessor-stop-finished');
      const respawned = stopEvents.findIndex((event) => event.kind === 'respawned');
      expect(started).toBeGreaterThanOrEqual(0);
      expect(forced).toBeGreaterThan(started);
      expect(finished).toBeGreaterThan(forced);
      expect(respawned).toBeGreaterThan(finished);
      expect(stopEvents[forced]).toMatchObject({
        mode: 'recycle', predecessorPid: firstBoot, signal: 'SIGKILL',
      });
      expect(stopEvents[finished]).toMatchObject({
        mode: 'recycle', predecessorPid: firstBoot, forceKillRequested: true, exitObserved: true,
        signal: 'SIGKILL',
      });

      await rawInject(sock, 'QUIT\n');
      await done;
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

describe('carry-respawn TERMINAL FALLBACK — a successor that emits NOTHING still gets its turn (WI-38257)', () => {
  it(
    'delivers the carry to a zero-output successor instead of dropping it with attempts:0',
    async () => {
      const ownerId = `su-zerooutput-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();

      // The distinguishing detail, and the whole point of this test: this child
      // writes NOTHING on boot. No banner, no marker, not one byte. It is
      // otherwise perfectly healthy and echoes anything typed at it.
      //
      // That is the shape of the 2026-08-12 incident, whose ledger row read
      // `respawn-carry-dropped reason=no-startup-ready-marker attempts=0
      // outputSeen=false`. The startup-marker TIME fallback added in d351ee3084
      // cannot rescue this case: it is gated on childStartupFirstOutputAt > 0,
      // and a child that never emits leaves that at 0 forever. Before the
      // terminal fallback, the host skipped its delivery loop entirely and never
      // once tried to write — so a healthy successor sat at its prompt, silent,
      // while every wake was deferred and the agent was dead until a human typed.
      const root = mkdtempSync(join(tmpdir(), 'psu-zero-output-ready-'));
      const readerReady = join(root, 'reader-ready');
      const signalSource = new EventEmitter();
      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        "require('fs').writeFileSync(process.env.READER_READY,'ready');";

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          READER_READY: readerReady,
          // A backend whose readiness marker this child will never emit, plus a
          // short fallback window — so the ONLY thing that can deliver the carry
          // is the terminal fallback itself.
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          // A zero-output child spins the startup-marker wait for the WHOLE
          // inject budget (there is no first-output timestamp for the 300ms
          // fallback above to measure from), and only then does the terminal
          // fallback get its one attempt. That is the intended shape — a
          // slow-booting child should still get the full grace — so shorten the
          // budget here rather than sleeping past the production default. This
          // also pins the recovery as BOUNDED: without a short budget the test
          // passes only by waiting longer, which would hide a regression that
          // made the wait unbounded again.
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '800',
          // A fleet-bound host recolors the visible terminal by writing OSC
          // probes to stdout at launch. This fixture asserts that the child
          // emits zero bytes, so keep the test independent of the caller's
          // fleet color environment.
          PAPERCUSP_FLEET_BG: '',
          PAPERCUSP_FLEET_FG: '',
          PAPERCUSP_FLEET_CURSOR: '',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        io,
        bridgeTty: false,
        signalSource,
        onExit: () => {},
      });

      try {
        // A file proves the silent child's reader exists without adding stdout.
        await vi.waitFor(() => expect(existsSync(readerReady)).toBe(true), { timeout: 8000 });
        // Precondition, asserted rather than assumed: the child really is silent.
        // If it ever starts emitting, this test would still pass while no longer
        // testing the zero-output path at all — a vacuous guard.
        expect(captured()).toBe('');

        await controlInject(sock, 'recycle', 'CARRIED');

        // The continuation turn started with no human input. This is the item's
        // acceptance criterion stated as an assertion.
        await vi.waitFor(() => expect(captured()).toContain('ECHO:CARRIED'), { timeout: 8000 });

        await rawInject(sock, 'QUIT\n');
        await done;
      } finally {
        signalSource.emit('SIGTERM');
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it.each(['staging-proxy', undefined] as const)(
    'stores only operator-pin enums for an interactive stale host (route=%s) and preserves the D-008 no-reexec refusal',
    async (route) => {
      const ownerId = `su-stale-host-direct-3170-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n❯\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),15000);';
      const env: ReturnType<typeof hermeticEnv> & {
        PAPERCUSP_OPERATOR_URL: string;
        PAPERCUSP_PSU_REEXEC?: string;
        PAPERCUSP_PSU_REEXEC_PPID?: string;
      } = {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_OPERATOR_URL: 'http://agent:PRIVATE-CREDENTIAL@127.0.0.1:3170/api/mcp?token=PRIVATE-TOKEN',
        PAPERCUSP_TEST_SECRET: 'UNRELATED-PRIVATE-VALUE',
        TERM: 'xterm-256color',
      };
      delete env.PAPERCUSP_PSU_REEXEC;
      delete env.PAPERCUSP_PSU_REEXEC_PPID;

      const reexecs: number[] = [];
      const signalSource = new EventEmitter();
      let done: Promise<void> | undefined;
      try {
        done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode, 'ORIGINAL'],
          cwd: '/tmp',
          env,
          ownerId,
          io,
          bridgeTty: true,
          signalSource,
          hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
          healOperatorPin: async () => {
            const from = env.PAPERCUSP_OPERATOR_URL;
            const to = 'http://agent:DESTINATION-CREDENTIAL@127.0.0.1:9171/api/mcp?token=DESTINATION-TOKEN';
            env.PAPERCUSP_OPERATOR_URL = to;
            return { from, to, route };
          },
          mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
          onReexec: ({ code }: { code: number }) => { reexecs.push(code); },
          onExit: () => {},
        });

        await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 5_000 });
        await controlInject(sock, 'recycle', '');

        const deadline = Date.now() + 8_000;
        let eventLogText = '';
        let staleRow: Record<string, unknown> | undefined;
        while (Date.now() < deadline) {
          if (existsSync(eventLog)) {
            eventLogText = readFileSync(eventLog, 'utf8');
            staleRow = eventLogText
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .find((event) => event.kind === 'host-code-stale');
            // Inspect the complete transition: the old snapshot could stop at
            // host-code-stale, before the routing/healing event leaked its URL.
            if (staleRow && eventLogText.includes('"kind":"respawned"')) break;
          }
          await sleep(25);
        }

        expect(staleRow).toMatchObject({
          kind: 'host-code-stale',
          operatorPin: 'direct-3170',
          bridgeTty: true,
          notAdoptingReason: 'interactive-tty',
          willAdopt: false,
        });
        expect(reexecs).toEqual([]);
        const pinEvent = eventLogText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
          .find((event) => event.kind === (route === 'staging-proxy' ? 'operator-pin-routed' : 'operator-pin-healed'));
        expect(pinEvent).toMatchObject({ from: 'direct-3170', to: 'other', mode: 'recycle' });
        expect(env.PAPERCUSP_OPERATOR_URL).toContain('DESTINATION-CREDENTIAL');
        expect(eventLogText).not.toContain('PRIVATE-CREDENTIAL');
        expect(eventLogText).not.toContain('PRIVATE-TOKEN');
        expect(eventLogText).not.toContain('DESTINATION-CREDENTIAL');
        expect(eventLogText).not.toContain('DESTINATION-TOKEN');
        expect(eventLogText).not.toContain('UNRELATED-PRIVATE-VALUE');
      } finally {
        signalSource.emit('SIGTERM');
        if (done) await done;
      }
    },
    25_000,
  );
});

describe('carry completion follows native delivery and reanchor (WI-10004791)', () => {
  // WI-10005106: `stuckOnce` boots the first carry child stuck at the Codex
  // `Starting` footer and the next one Ready; the carry must be delivered on the
  // fresh-epoch retry. `persists:false` keeps every child at `Starting`: one
  // fresh-epoch retry, then the last attempt holds to its ceiling and drops.
  it.each([
    { persists: true, deferred: false, stuckOnce: false },
    { persists: true, deferred: true, stuckOnce: false },
    { persists: false, deferred: false, stuckOnce: false },
    { persists: true, deferred: false, stuckOnce: true },
  ])('does not confuse a booted Codex with a completed carry (persists=$persists, deferred=$deferred, stuckOnce=$stuckOnce)', async ({ persists, deferred, stuckOnce }) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-carry-completion-'));
    const codexHome = join(root, 'codex');
    const childPhaseTrace = join(root, 'child-phases.jsonl');
    const phaseStartedAt = performance.now();
    const phaseStartedEpochMs = Date.now();
    const phaseMarks: Record<string, number> = { started: 0 };
    const markPhase = (name: string) => {
      phaseMarks[name] = Math.round(performance.now() - phaseStartedAt);
    };
    const sourceNativeId = '1f0e2c3d-4b5a-4678-9012-abcdefabcdef';
    const nativeId = '01a0f68e-3037-7dc3-b898-a1cc12441884';
    const sourceNativeFile = join(codexHome, 'sessions', '2026', '10', '01', `rollout-2026-10-01T09-00-00-${sourceNativeId}.jsonl`);
    const nativeFile = join(codexHome, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${nativeId}.jsonl`);
    mkdirSync(dirname(sourceNativeFile), { recursive: true });
    writeFileSync(sourceNativeFile, `${JSON.stringify({ type: 'response_item', timestamp: new Date(Date.now() - 10_000).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'source turn' }] } })}\n`);
    const ownerId = `su-carry-completion-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const eventLog = eventLogPathForOwner(ownerId);
    const marker = '⟦turn-origin:self-compaction nonce:fedcba9876543210⟧';
    const { captured, io } = fakeIo();
    const order: string[] = [];
    let confirm!: () => void;
    const report = vi.fn(async (id: string, options: { onConfirmed: () => void }) => {
      expect(id).toBe(nativeId);
      expect(readFileSync(nativeFile, 'utf8')).toContain(marker);
      if (deferred) {
        confirm = () => { order.push('reanchor'); options.onConfirmed(); };
        return false;
      }
      order.push('reanchor');
      return true;
    });
    const emit = vi.fn(() => { order.push('emit'); return null; });
    const childCode = [
      "const fs=require('fs'),path=require('path');",
      "const trace=(phase,extra={})=>fs.appendFileSync(process.env.PHASE_TRACE,JSON.stringify({phase,ts:new Date().toISOString(),pid:process.pid,...extra})+'\\n');",
      "const c=process.env.BOOT_COUNTER,n=fs.existsSync(c)?Number(fs.readFileSync(c,'utf8'))+1:1;fs.writeFileSync(c,String(n));",
      "const starting=n>1&&(process.env.PERSISTS!=='yes'||(process.env.STUCK_ONCE==='yes'&&n===2));",
      "trace('spawned',{child:n});trace(starting?'starting':'ready',{child:n});",
      "process.stdout.write('BOOT:'+process.pid+'\\n'+(starting?'Starting':'Ready')+' · GPT-6.1-Sol xhigh · Context 100% left\\n');",
      "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let at;while((at=b.indexOf('\\n'))>=0){const line=b.slice(0,at);b=b.slice(at+1);if(line==='QUIT'){trace('quit',{child:n});process.exit(0);}",
      "if(n>1&&!starting){fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const timestamp=new Date().toISOString();fs.appendFileSync(process.env.NATIVE_FILE,JSON.stringify({type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}})+'\\n');trace('carry-received',{child:n});}",
      "process.stdout.write('ECHO:'+line+'\\n');}});setTimeout(()=>{trace('auto-exit',{child:n});process.exit(0)},8000);",
    ].join('');
    // This test exercises a child with a KNOWN Starting/Ready footer. Pause its
    // deadline clock only during OS process boot, until its actual first output
    // reaches the host. The separate zero-output test covers the unobserved-boot
    // fallback. Keep the 600ms stuck threshold and 1500ms budget unchanged.
    const wallNow = Date.now.bind(Date);
    let bootStartedAt: number | null = null;
    let bootTimeMs = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() =>
      (bootStartedAt ?? wallNow()) - bootTimeMs);
    const signalSource = new EventEmitter();
    const nativeIdByPid = new Map<number, string>();
    let spawnedChildren = 0;
    const done = hostThroughPty({
      command: execPath, args: ['-e', childCode], cwd: root,
      env: {
        ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex',
        CODEX_HOME: codexHome, BOOT_COUNTER: join(root, 'boots'), NATIVE_FILE: nativeFile,
        PERSISTS: persists ? 'yes' : 'no', TERM: 'xterm-256color',
        STUCK_ONCE: stuckOnce ? 'yes' : 'no',
        PHASE_TRACE: childPhaseTrace,
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
        PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '1500',
        PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS: '600',
        PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS: '2000',
        PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
      },
      ownerId, advSessionId: 77, io, bridgeTty: false, signalSource,
      spawnPty: (file, args, options, realSpawn) => {
        bootStartedAt = wallNow();
        const spawned = realSpawn(file, args, options);
        nativeIdByPid.set(spawned.pid, spawnedChildren === 0 ? sourceNativeId : nativeId);
        spawnedChildren += 1;
        return new Proxy(spawned, {
          get(target, property) {
            if (property === 'onData') {
              return (handler: (data: string) => void) => target.onData((data: string) => {
                if (bootStartedAt !== null) {
                  bootTimeMs += wallNow() - bootStartedAt;
                  bootStartedAt = null;
                }
                handler(data);
              });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      resolveRespawnNativeId: (pid: number) => {
        const resolved = nativeIdByPid.get(pid) ?? null;
        return resolved === nativeId && !existsSync(nativeFile) ? null : resolved;
      },
      mintCarryRespawnArgs: (args: string[]) => ({ args, nativeId: null, launchContextPath: '/test/carry.md' }),
      onRespawn: report, emitCompacted: emit, nativePersistenceTimeoutMs: 200, onExit: () => {},
    });
    const readJsonLines = (path: string): Array<Record<string, unknown>> => {
      if (!existsSync(path)) return [];
      const rows: Array<Record<string, unknown>> = [];
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A diagnostic snapshot may race the final append; omit only that row.
        }
      }
      return rows;
    };
    const hostRows = () => readJsonLines(eventLog);
    const childRows = () => readJsonLines(childPhaseTrace);
    const timingSnapshot = () => ({
      elapsedMs: Math.round(performance.now() - phaseStartedAt),
      phases: { ...phaseMarks },
      childEvents: childRows().map((row) => ({
        phase: row.phase,
        child: row.child,
        ts: row.ts,
      })),
      hostEvents: hostRows().map((row) => ({
        phase: row.kind,
        elapsedMs: typeof row.ts === 'string' ? Date.parse(row.ts) - phaseStartedEpochMs : null,
        reason: row.reason,
        attempt: row.attempt,
        stuckMs: row.stuckMs,
        budgetMs: row.budgetMs,
      })),
    });
    // If the historical ~20s timeout returns, this fires one second before it
    // and captures independent child, host-event, and test-phase clocks. A child
    // that advances while host events stop points at host processing; completed
    // host events with no test completion point at later assertions/shutdown.
    const slowTraceTimer = stuckOnce
      ? setTimeout(() => console.error('[carry-completion slow trace]', JSON.stringify(timingSnapshot())), 19_000)
      : null;
    try {
      await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 8000 });
      markPhase('initial-boot-output');
      await envelopeInject(sock, {
        mode: 'carry-respawn', ownerId, data: `${marker}\nContinue saved work`,
        systemPromptAddendum: 'verified carry completion',
      });
      markPhase('carry-inject-returned');
      await vi.waitFor(() => {
        expect(hostRows().some((row) => (persists
          ? row.kind === 'respawn-carry-delivered'
          : row.kind === 'respawn-carry-dropped' && row.reason === 'codex-startup-still-starting'))).toBe(true);
      }, { timeout: 9000 });
      markPhase('terminal-host-event');
      if (persists && !stuckOnce) {
        const rows = hostRows();
        expect(rows.find((row) => row.kind === 'respawned')).toMatchObject({
          mode: 'carry-respawn',
          managedCarryLineage: {
            ownerId,
            advSessionId: 77,
            sourceNativeId,
            sourceNativeRef: sourceNativeFile,
            sourceChildGeneration: 1,
            targetChildGeneration: 2,
            targetNativeId: null,
            targetNativeRef: null,
          },
        });
        expect(rows.find((row) => row.kind === 'respawn-carry-delivered')).toMatchObject({
          nativeId,
          nativeRef: nativeFile,
          managedCarryLineage: {
            ownerId,
            advSessionId: 77,
            sourceNativeId,
            sourceNativeRef: sourceNativeFile,
            sourceChildGeneration: 1,
            targetChildGeneration: 2,
            targetNativeId: nativeId,
            targetNativeRef: nativeFile,
          },
        });
      }
      const boots = () => readFileSync(join(root, 'boots'), 'utf8');
      const freshEpochRetries = () => hostRows().filter((row) => row.kind === 'respawn-carry-fresh-epoch-retry');
      if (stuckOnce) {
        // The stuck child was abandoned at the 600ms stuck threshold, well inside
        // the 1500ms budget, and the carry landed on the fresh successor.
        expect(boots()).toBe('3');
        expect(hostRows().find((row) => row.kind === 'codex-starting-stuck-early-drop'))
          .toMatchObject({ label: 'recycle carry-note', stuckMs: 600, budgetMs: 1500 });
        expect(freshEpochRetries()).toEqual([
          expect.objectContaining({ reason: 'codex-startup-still-starting', attempt: 1 }),
        ]);
        expect(childRows()
          .filter((row) => row.phase === 'ready' || row.phase === 'starting')
          .map((row) => [row.phase, row.child]))
          .toEqual([['ready', 1], ['starting', 2], ['ready', 3]]);
        expect(childRows().some((row) => row.phase === 'carry-received' && row.child === 3)).toBe(true);
      }
      if (!persists) {
        // One fresh-epoch retry, then the LAST attempt holds (bounded by the
        // ceiling) instead of retrying again.
        expect(boots()).toBe('3');
        expect(freshEpochRetries()).toEqual([
          expect.objectContaining({ reason: 'codex-startup-still-starting', attempt: 1 }),
        ]);
        expect(hostRows().filter((row) => row.kind === 'kickoff-held-for-codex-frame')).toHaveLength(1);
      }
      if (persists) {
        if (deferred) {
          expect(order).toEqual([]);
          expect(emit).not.toHaveBeenCalled();
          confirm();
          // The late binding callback schedules the announcement under the
          // host's injection mutex. Binding confirmation is logged before that
          // async work runs, so wait for its completion event before asserting
          // the observable emit order.
          await vi.waitFor(() => {
            expect(hostRows().find((row) => row.kind === 'respawn-compaction-announced-after-binding'))
              .toMatchObject({ nativeId });
          }, { timeout: 1_000 });
        }
        if (!stuckOnce) {
          await vi.waitFor(() => {
            expect(hostRows().find((row) => row.kind === 'respawn-binding-confirmed')).toMatchObject({
              ownerId,
              advSessionId: '77',
              childGeneration: 2,
              nativeId,
            });
          }, { timeout: 1_000 });
        }
        expect(order).toEqual(['reanchor', 'emit']);
        expect(report).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith(ownerId, 'carry-respawn', { nativeId });
      } else {
        expect(order).toEqual([]);
        expect(report).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(readFileSync(eventLog, 'utf8')).toContain('"reason":"codex-startup-still-starting"');
      }
      markPhase('before-quit');
      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
      markPhase('host-exited');
    } catch (error) {
      if (stuckOnce) console.error('[carry-completion failure trace]', JSON.stringify(timingSnapshot()));
      throw error;
    } finally {
      if (slowTraceTimer !== null) clearTimeout(slowTraceTimer);
      clock.mockRestore();
      signalSource.emit('SIGTERM');
      await done.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  // The two sequential phase waits allow up to 8s for the initial child output
  // and 9s for carry completion, followed by real-PTY shutdown. A 20s outer
  // deadline could preempt that lifecycle in a full-file run; the bounded phase
  // waits above still report a missing boot or carry directly.
  }, 45_000);
});

describe('P-020 carry-respawn drill correlation', () => {
  it(
    'records the fresh native id, carry path, and first-prompt delivery in the durable host event log',
    async () => {
      const ownerId = `su-carry-drill-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const root = mkdtempSync(join(tmpdir(), 'psu-carry-drill-itest-'));
      const claudeConfig = join(root, 'claude');
      const nativeId = 'ddddabcd-1234-5678-9abc-def012345678';
      const marker = '⟦turn-origin:carry-drill nonce:0123456789abcdef⟧';
      const nativePath = join(claudeConfig, 'projects', '-tmp', 'session-' + nativeId + '.jsonl');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      // This fixture models a ready Claude editor. A boot banner alone cannot
      // establish prompt readiness after a fresh-child respawn.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n❯\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';
      const carryPath = '/safe/carry-drill-d-1.md';
      // The fresh claude-su path checks /mcp readiness before writing the carry.
      // Give that precondition a deterministic healthy response in this fake CLI.
      const mcpAwareChildCode = childCode.replace(
        "process.stdin.setEncoding('utf8');",
        "process.stdin.setEncoding('utf8');let mcpBuffer='',mcpReady=false;process.stdin.on('data',d=>{mcpBuffer+=d;if(!mcpReady&&(mcpBuffer.includes('/mcp\\r')||mcpBuffer.includes('/mcp\\n'))){mcpReady=true;process.stdout.write('MCP_DIALOG\\n❯ 1. papercusp-su connected\\n');}});",
      );
      // The readiness macro closes its dialog with escape keys. Echo the carry
      // marker when the fake CLI receives it, without treating those keys as text.
      const carryAwareChildCode = mcpAwareChildCode.replace(
        "process.stdin.setEncoding('utf8');",
        "process.stdin.setEncoding('utf8');let carryBuffer='',carryEchoed=false;process.stdin.on('data',d=>{carryBuffer+=d;if(!carryEchoed&&carryBuffer.includes('⟦carry-drill:d-1⟧')){carryEchoed=true;process.stdout.write('ECHO:⟦carry-drill:d-1⟧\\n');}});",
      );
      // session:carry-drill tags the prompt before it reaches the PTY. Persist
      // that exact marker in the isolated Claude transcript so the host's
      // native proof can distinguish a submitted prompt from a PTY repaint.
      const nativeAwareChildCode = carryAwareChildCode.replace(
        "process.stdin.setEncoding('utf8');",
        "process.stdin.setEncoding('utf8');const fs=require('node:fs'),path=require('node:path');let nativeInput='',nativeWritten=false;process.stdin.on('data',d=>{nativeInput+=d;if(!nativeWritten&&nativeInput.includes(process.env.TURN_MARKER)&&(nativeInput.includes('\\r')||nativeInput.includes('\\n'))){nativeWritten=true;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});fs.appendFileSync(process.env.NATIVE_FILE,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{role:'user',content:process.env.TURN_MARKER}})+'\\n');}});",
      );
      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', nativeAwareChildCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          CLAUDE_CONFIG_DIR: claudeConfig,
          NATIVE_FILE: nativePath,
          TURN_MARKER: marker,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintCarryRespawnArgs: (args: string[]) => ({ args, nativeId, launchContextPath: carryPath }),
        onRespawn: async () => true,
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        await sleep(600);
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: marker + '\n⟦carry-drill:d-1⟧',
          systemPromptAddendum: 'deterministic carry',
          drillId: 'd-1',
          sessionClass: 'claude-su',
        });
        const deliveryDeadline = Date.now() + 5_000;
        while (Date.now() < deliveryDeadline) {
          const log = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          if (log.includes('"kind":"carry-drill-carry-delivered"')) break;
          await sleep(25);
        }
        expect(captured()).toContain('ECHO:⟦carry-drill:d-1⟧');
        expect(captured()).toContain('MCP_DIALOG');
        expect(captured().indexOf('MCP_DIALOG')).toBeLessThan(captured().indexOf('ECHO:⟦carry-drill:d-1⟧'));
        const events = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-binding-confirmed',
          nativeId,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-respawned',
          drillId: 'd-1',
          sessionClass: 'claude-su',
          nativeId,
          launchContextPath: carryPath,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-mcp-ready',
          serverName: 'papercusp-su',
          attempts: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-carry-delivered',
          drillId: 'd-1',
          sessionClass: 'claude-su',
          nativeId,
          turnStartVerified: true,
          nativeRef: nativePath,
        }));
        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    25_000,
  );
});

describe('carry-drill busy-gate metric correlation (WI-6554700010012191)', () => {
  it('persists a tagged fake-PTY expiry measurement in the owner log and shared ledger', async () => {
    const nonce = process.pid + '-' + Math.floor(performance.now());
    const ownerId = 'su-busy-gate-drill-itest-' + nonce;
    const drillId = 'fake-busy-gate-' + nonce;
    const sessionClass = 'codex-su';
    const sock = socketPathFor(ownerId);
    const eventLog = eventLogPathForOwner(ownerId);
    const ledgerPath = sharedDrillLedgerPath(PSU_PTY_DIR);
    const { captured, io } = fakeIo();
    const childCode = [
      "process.stdout.write('BOOT:'+process.pid+'\\n');",
      // Match Codex's real composer footer so the host and test share the same readiness signal.
      "process.stdout.write('› Ask Codex to do anythingReady · GPT-5.6-Sol high · Context 100% left\\n');",
      "setInterval(()=>process.stdout.write('SPIN\\n'),20);",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{if(d.includes('QUIT'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),15000);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '1000',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '250',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '500',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '20',
        },
        ownerId,
        io,
        bridgeTty: false,
        nativePersistenceTimeoutMs: 100,
      });
      await vi.waitFor(() => {
        expect(captured()).toContain(FLATTENED_CODEX_READY_FOOTER);
        expect(captured()).toContain('SPIN');
      }, { timeout: 5000 });
      expect(startupOutputReady('codex', captured())).toBe(true);

      await envelopeInject(sock, {
        mode: 'carry-respawn',
        ownerId,
        data: 'SYNTHETIC_BUSY_GATE_CARRY',
        systemPromptAddendum: 'safe fake-PTY expiry reproduction',
        drillId,
        sessionClass,
      });
      const readRows = (file: string): Array<Record<string, unknown>> =>
        existsSync(file)
          ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : [];
      const hostMetric = await vi.waitFor(() => {
        const row = readRows(eventLog).find((candidate) =>
          candidate.kind === 'busy-gate-expired' && candidate.drillId === drillId);
        expect(row).toBeDefined();
        return row!;
      }, { timeout: 5000 });
      const sharedMetric = readRows(ledgerPath).find((candidate) =>
        candidate.kind === 'busy-gate-expired' && candidate.drillId === drillId);

      expect(Number.isFinite(Date.parse(String(hostMetric.ts)))).toBe(true);
      expect(hostMetric).toMatchObject({
        kind: 'busy-gate-expired',
        mode: 'carry-respawn',
        drillId,
        sessionClass,
        capMs: 250,
        quietMs: 1000,
      });
      expect(typeof hostMetric.observedMaxQuietMs).toBe('number');
      expect(typeof hostMetric.verifier).toBe('string');
      expect(typeof hostMetric.nativeBusy).toBe('boolean');
      expect(sharedMetric).toMatchObject({
        kind: 'busy-gate-expired',
        ownerId,
        mode: 'carry-respawn',
        drillId,
        sessionClass,
        capMs: 250,
        observedMaxQuietMs: hostMetric.observedMaxQuietMs,
        quietMs: 1000,
        verifier: hostMetric.verifier,
        nativeBusy: hostMetric.nativeBusy,
      });
      expect(Number.isFinite(Date.parse(String(sharedMetric?.ts)))).toBe(true);

      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
    }
  }, 15_000);
});

describe('host-code adopted carry drill lifecycle (EI-25602595012290893)', () => {
  it('records adopted drill respawn and delivery in both lifecycle ledgers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-adopted-carry-drill-'));
    const codexHome = join(root, 'codex-home');
    const nativeId = 'acba1234-1234-4234-8234-123456789abc';
    const drillId = `d-adopt-${process.pid}-${Math.floor(performance.now())}`;
    const sessionClass = 'codex-su';
    const launchContextPath = '/safe/adopted-carry-context.md';
    const nativeFile = join(codexHome, 'sessions', '2026', '10', '10', `rollout-${nativeId}.jsonl`);
    const ownerId = `su-adopted-carry-drill-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const eventLog = eventLogPathForOwner(ownerId);
    const ledgerPath = sharedDrillLedgerPath(PSU_PTY_DIR);
    const marker = '⟦turn-origin:carry-drill nonce:0123456789abcdef⟧';
    const kickoff = `${marker}\nADOPTED_DRILL_CARRY`;
    const { captured, io } = fakeIo();
    const childCode = [
      "const fs=require('fs'),path=require('path');process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
      "let input='',echoed=false,submitted=false;process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\nReady · GPT-6.1-Sol xhigh · Context 100% left\\n');",
      "process.stdin.on('data',d=>{if(d.includes('\\x04'))process.exit(0);input+=d;if(!echoed&&input.includes('⟧')){echoed=true;process.stdout.write('COMPOSER_ECHO:'+input+'\\n');}if(!submitted&&input.includes(process.env.TURN_MARKER)&&input.includes('\\r')){submitted=true;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});const timestamp=new Date().toISOString();const rows=[{type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:process.env.TURN_MARKER}]}},{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'adopted-drill-1'}}];fs.writeFileSync(process.env.NATIVE_FILE,rows.map(r=>JSON.stringify(r)+'\\n').join(''));process.stdout.write('KICKOFF_SUBMITTED\\n');}if(input.includes('QUIT'))process.exit(0);});",
      'setTimeout(()=>process.exit(0),12000);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: codexHome,
          NATIVE_FILE: nativeFile,
          TURN_MARKER: marker,
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS: '10',
          PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS: '1',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        adoptedCarryRespawn: { nativeId, drillId, sessionClass, launchContextPath },
        nativePersistenceTimeoutMs: 1500,
        onRespawn: async () => true,
        signalSource: new EventEmitter(),
        onExit: () => undefined,
      });
      await vi.waitFor(() => {
        const rows = existsSync(eventLog)
          ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          : [];
        expect(rows.some(row => row.kind === 'carry-drill-carry-delivered' && row.drillId === drillId)).toBe(true);
      }, { timeout: 5000 });
      expect(captured()).toContain('KICKOFF_SUBMITTED');
      const ownerRows = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const sharedRows = existsSync(ledgerPath)
        ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
      for (const rows of [ownerRows, sharedRows]) {
        expect(rows).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-respawned', drillId, sessionClass, nativeId, launchContextPath,
        }));
        expect(rows).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-carry-delivered', drillId, sessionClass, nativeId, launchContextPath,
          adopted: true,
        }));
      }
      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('records an unverified adopted drill carry as dropped in both lifecycle ledgers', async () => {
    const ownerId = `su-adopted-carry-drop-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const eventLog = eventLogPathForOwner(ownerId);
    const ledgerPath = sharedDrillLedgerPath(PSU_PTY_DIR);
    const drillId = `d-drop-${process.pid}-${Math.floor(performance.now())}`;
    const sessionClass = 'codex-su';
    const launchContextPath = '/safe/unverified-carry-context.md';
    const nativeId = 'bcba1234-1234-4234-8234-123456789abc';
    const { captured, io } = fakeIo();
    const childCode = [
      "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);let input='';",
      "process.stdout.write('\\x1b[6nmodel: GPT-6.1-Sol xhigh\\n62% context left\\nReady · GPT-6.1-Sol xhigh · Context 100% left\\n');",
      "process.stdin.on('data',d=>{if(d.includes('\\x04')||d.includes('QUIT'))process.exit(0);input+=d;if(input.includes('UNVERIFIED_ADOPTED_CARRY'))process.stdout.write('COMPOSER_ECHO:'+input+'\\n');});",
      'setTimeout(()=>process.exit(0),12000);',
    ].join('');
    let done: Promise<number> | undefined;
    try {
      done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff: 'UNVERIFIED_ADOPTED_CARRY',
        adoptedCarryRespawn: { nativeId, drillId, sessionClass, launchContextPath },
        nativePersistenceTimeoutMs: 100,
        onRespawn: async () => true,
        signalSource: new EventEmitter(),
        onExit: () => undefined,
      });
      await vi.waitFor(() => {
        const rows = existsSync(eventLog)
          ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          : [];
        expect(rows.some(row => row.kind === 'carry-drill-carry-dropped' && row.drillId === drillId)).toBe(true);
      }, { timeout: 5000 });
      const ownerRows = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const sharedRows = existsSync(ledgerPath)
        ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
      for (const rows of [ownerRows, sharedRows]) {
        expect(rows).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-respawned', drillId, sessionClass, nativeId, launchContextPath,
        }));
        expect(rows).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-carry-dropped', drillId, sessionClass, nativeId, launchContextPath,
          reason: 'missing-leading-turn-origin',
        }));
      }
      expect(captured()).toContain('COMPOSER_ECHO:UNVERIFIED_ADOPTED_CARRY');
      await rawInject(sock, 'QUIT\n');
      expect(await done).toBe(0);
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done?.catch(() => undefined);
    }
  }, 15_000);
});

describe('carry-respawn native turn-start proof (EI-21561923024113260)', () => {
  it(
    'retries one CR and one fresh epoch before terminally dropping an unverified native turn',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-carry-turn-proof-'));
      const claudeConfig = join(root, 'claude');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      const ownerId = `su-carry-proof-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const nativeId = '12345678-1234-4234-8234-123456789abc';
      const marker = '⟦turn-origin:self-compaction nonce:fedcba9876543210⟧';
      const { captured, io } = fakeIo();
      // Every write repaints the PTY, reproducing outputSeen:true, but this fake
      // backend never persists a native user turn. Generic output verification
      // therefore passes while the authoritative transcript proof must fail.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;process.stdout.write('PAINT\\n');if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),10000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          // This fixture exercises a plain Claude child. A live headless
          // session enables the onboarding/composer gate and makes this
          // synthetic backend (which paints no onboarding frames) wait until
          // its carry budget expires before testing native turn-start proof.
          PAPERCUSP_PSU_HEADLESS: '0',
          CLAUDE_CONFIG_DIR: claudeConfig,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          // Keep the injected carry-at-prompt attempt bounded for this proof
          // test. Production defaults allow a 10-minute carry budget and a
          // 3-minute busy-gate wait, longer than the test's observation window.
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '2000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '4000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '25',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '500',
        },
        ownerId,
        io,
        bridgeTty: false,
        nativePersistenceTimeoutMs: 200,
        // MCP readiness is a separate precondition; this fixture isolates the
        // missing native turn proof after a successful readiness check.
        mcpReconnectMacro: async () => ({ ok: true, step: 'fixture-ready', detail: 'isolated native proof test' }),
        mintCarryRespawnArgs: (args: string[]) => ({ args, nativeId, launchContextPath: '/tmp/carry.md' }),
        // Confirm identity so failure is specifically missing native turn proof.
        onRespawn: async () => true,
        onExit: () => {},
      });

      try {
        const bootDeadline = Date.now() + 2_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await envelopeInject(sock, {
          mode: 'carry-respawn',
          ownerId,
          data: `${marker}\nContinue where you left off`,
          systemPromptAddendum: 'deterministic carry',
        });

        const outcomeDeadline = Date.now() + 10_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < outcomeDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            if (events.some((event) => event.kind === 'respawn-carry-dropped')) break;
          }
          await sleep(20);
        }

        expect(events.filter((event) => event.kind === 'respawned').map((event) => event.capMs))
          .toEqual([4_000, 4_000]);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-turn-start-retry',
          nativeId,
          reason: 'native-turn-marker-timeout',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-start-unverified',
          nativeId,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-fresh-epoch-retry',
          reason: 'turn-start-unverified',
          detail: 'native-turn-marker-timeout',
          attempt: 1,
          maxRetries: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          nativeId,
          reason: 'turn-start-unverified',
          outputSeen: true,
          turnStartVerified: false,
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(3);

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe('carry-respawn STALENESS guard — only drills expire; production carries remain must-deliver', () => {
  it.each([true, false])(
    'preserves the age policy at the first prompt boundary (drill=%s)',
    async (isDrill) => {
      const ownerId = `su-carry-stale-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      const nativeHome = mkdtempSync(join(tmpdir(), 'carry-age-native-'));
      const nativeId = 'bfbf7540-c7bd-4b6c-9d66-6557f1a13722';
      const successorNativeId = '36c766c0-507c-41a7-ae91-f327e0dc9693';
      let sourcePid: number | null = null;
      const nativeTranscript = join(nativeHome, 'sessions', `rollout-${nativeId}.jsonl`);
      mkdirSync(dirname(nativeTranscript), { recursive: true });
      // Hold a positive native busy boundary until the accepted message has
      // actually aged past 50ms. Timed PTY output alone did not establish that
      // precondition: run22046694 recycled only 3ms after receipt.
      const childCode =
        "const fs=require('node:fs');if(!fs.existsSync(process.env.NATIVE_FILE)){" +
        "fs.writeFileSync(process.env.NATIVE_FILE,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'carry-age'}})+'\\n');}" +
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          // Keep this fixture hermetic when the suite runs inside a live psu
          // session. Ambient identity/configuration must not rewrite the
          // handoff contract this test is asserting.
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: nativeHome,
          NATIVE_FILE: nativeTranscript,
          PAPERCUSP_AGENT: 'codex',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000', // generous — the busy gate must NOT defer/drop here
          PAPERCUSP_PSU_PTY_CARRY_STALE_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '500',
          // This test grades staleness, not fresh-epoch proof recovery. Leave
          // that independent retry path to the native-proof fixtures above.
          PAPERCUSP_PSU_PTY_CARRY_PROOF_RETRIES: '0',
        },
        ownerId,
        io,
        bridgeTty: false,
        resolveRespawnNativeId: (pid: number) => {
          sourcePid ??= pid;
          return pid === sourcePid ? nativeId : successorNativeId;
        },
        onRespawn: async () => true,
        nativePersistenceTimeoutMs: 200,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
        // BOOT follows the persisted native task_started row.
        const bootDeadline = Date.now() + 3_000;
        while (Date.now() < bootDeadline && !captured().includes('BOOT:')) {
          await sleep(20);
        }
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);

        await envelopeInject(sock, {
          mode: 'carry-respawn',
          ownerId,
          data: 'CARRIED',
          systemPromptAddendum: 'stale carry test',
          sourceTranscriptPath: nativeTranscript,
          ...(isDrill ? { drillId: 'age-expiry-control' } : {}),
        });
        await vi.waitFor(() => {
          const events = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          const receipt = events.find((event) => event.kind === 'control-carry-origin-stamped');
          expect(receipt).toBeDefined();
          expect(Date.now() - Date.parse(receipt.ts)).toBeGreaterThan(50);
          expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);
        });
        writeFileSync(nativeTranscript, readFileSync(nativeTranscript, 'utf8') + JSON.stringify({
          type: 'event_msg', timestamp: new Date().toISOString(),
          payload: { type: 'task_complete', turn_id: 'carry-age' },
        }) + '\n');

        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const log = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          if (log.includes('"kind":"respawn-carry-dropped"')) break;
          await sleep(25);
        }

        const events = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        if (isDrill) {
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'respawn-carry-dropped',
            mode: 'carry-respawn',
            reason: 'carry-stale',
          }));
          expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);
          expect(captured()).not.toContain('ECHO:CARRIED');
        } else {
          // The production request must reach its successor despite the age
          // cap, not be discarded at the first boundary. This synthetic child
          // does not persist a native turn: submission is not proof of delivery.
          expect(events.some((event) => event.reason === 'carry-stale')).toBe(false);
          expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(2);
          expect(captured()).toContain('ECHO:CARRIED');
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'respawn-carry-dropped',
            reason: 'turn-start-unverified',
          }));
          expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        }

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(nativeHome, { recursive: true, force: true });
      }
    },
    25_000,
  );
});

describe('RECYCLE respawns with FRESH session args + re-anchors identity (WI-1980 seam)', () => {
  it(
    'feeds the child the mintRecycleArgs-rewritten argv, fires onRespawn once with the fresh native id, and keeps the coord identity env unchanged',
    async () => {
      const ownerId = `su-recycle-args-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // Child prints, once on boot, its LAST argv marker + the PAPERCUSP_SID env:
      // the ARGV marker proves WHICH argv the respawn used (rewritten vs original),
      // the SID marker proves the coord identity env survived the recycle unchanged.
      // Exits on QUIT (15s safety net).
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+' ARGV:'+process.argv[process.argv.length-1]+' SID:'+(process.env.PAPERCUSP_SID||'')+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const FRESH_NATIVE = 'ffffabcd-1234-5678-9abc-def012345678';
      const mintCalls: string[][] = [];
      const respawns: string[] = [];

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        // WI-1980 seam: rewrite the respawn argv (swap the trailing marker so we can
        // prove the FRESH args are what the respawned child ran) and hand back a fresh
        // native id so the host re-anchors it via onRespawn.
        mintRecycleArgs: (a: string[]) => {
          mintCalls.push(a);
          return { args: a.slice(0, -1).concat('RECYCLED'), nativeId: FRESH_NATIVE };
        },
        onRespawn: (nativeId: string) => { respawns.push(nativeId); },
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(600);
      expect(captured()).toContain('ARGV:ORIGINAL'); // first boot used the launch argv verbatim

      // RECYCLE (no carry — we're testing the respawn argv/identity, not carry inject).
      await controlInject(sock, 'recycle', '');
      // The host's predecessor fence waits for the real node-pty exit callback;
      // a fixed 2.5s sleep races that callback under a whole-file run and then
      // reports a missing successor even though recycle is still progressing.
      await vi.waitFor(() => expect(captured()).toContain('ARGV:RECYCLED'), { timeout: 10_000 });

      // The respawn ran the REWRITTEN argv (proves spawnChild(recycleArgs) wiring)…
      expect(captured()).toContain('ARGV:RECYCLED');
      // …mintRecycleArgs was handed the ORIGINAL launch args, exactly once…
      expect(mintCalls).toHaveLength(1);
      expect(mintCalls[0]).toEqual(['-e', childCode, 'ORIGINAL']);
      // …onRespawn fired exactly once with the fresh native id (the re-anchor hook)…
      expect(respawns).toEqual([FRESH_NATIVE]);
      // …and PAPERCUSP_SID (coord identity, D-003) was IDENTICAL across both boots.
      const sids = [...captured().matchAll(/SID:(\S+)/g)].map((m) => m[1]);
      expect(sids).toEqual([ownerId, ownerId]);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

describe('Codex RECYCLE re-anchors the successor native id (WI-6554700010029835)', () => {
  // A Codex recycle mints no native id (mintRecycleArgs returns nativeId:null):
  // the successor's id exists only once Codex starts. The host must resolve it
  // from the exact successor PTY child and report it through onRespawn, or a
  // later untracked resume orphans this owner. The verified-carry announcement
  // cannot stand in for that binding here: a plain recycle has no carry.
  it(
    'resolves the successor id from the new child and reports it through onRespawn',
    async () => {
      const ownerId = `su-codex-recycle-reanchor-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+' ARGV:'+process.argv[process.argv.length-1]+'\\nReady · GPT-6.1-Sol medium · Context 100% left\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';
      const PREDECESSOR_NATIVE = '01a1aaaa-0000-7000-8000-000000000001';
      const SUCCESSOR_NATIVE = '01a1bbbb-0000-7000-8000-000000000002';
      let sourcePid: number | null = null;
      const respawns: string[] = [];
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex', TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        mintRecycleArgs: (a: string[]) => ({ args: a.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        resolveRespawnNativeId: (pid: number) => {
          sourcePid ??= pid;
          return pid === sourcePid ? PREDECESSOR_NATIVE : SUCCESSOR_NATIVE;
        },
        onRespawn: async (nativeId: string) => { respawns.push(nativeId); return true; },
        onExit: () => {},
      });
      try {
        await vi.waitFor(() => expect(captured()).toContain('ARGV:ORIGINAL'), { timeout: 8000 });
        await vi.waitFor(() => expect(sourcePid).not.toBeNull(), { timeout: 8000 });
        await controlInject(sock, 'recycle', '');
        await vi.waitFor(() => expect(captured()).toContain('ARGV:RECYCLED'), { timeout: 10_000 });
        await vi.waitFor(() => expect(respawns).toContain(SUCCESSOR_NATIVE), { timeout: 8000 });
        expect(respawns).not.toContain(PREDECESSOR_NATIVE);
        await vi.waitFor(() => {
          const rows = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          expect(rows).toContainEqual(expect.objectContaining({
            kind: 'respawn-binding-confirmed', nativeId: SUCCESSOR_NATIVE,
          }));
        }, { timeout: 8000 });
        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    30_000,
  );
});

describe('RECYCLE respawn report ordering', () => {
  it(
    'waits for the async onRespawn report before publishing successor metadata and output wiring',
    async () => {
      const ownerId = `su-recycle-order-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "const marker=process.argv[process.argv.length-1];" +
        "process.stdout.write('BOOT:'+marker+'\\n');" +
        "if(marker==='RECYCLED')setInterval(()=>process.stdout.write('LIVE:'+marker+'\\n'),25);" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='QUIT')process.exit(0);}});" +
        'setTimeout(()=>process.exit(0),15000);';
      const freshNativeId = 'eeeeabcd-1234-5678-9abc-def012345678';
      // Keep the report promise separate from the start signal: the host must
      // reach the callback before this test releases it, otherwise an ordering
      // regression could pass by accident.
      let signalReportStarted!: () => void;
      const reportStartedSignal = new Promise<void>((resolve) => { signalReportStarted = resolve; });
      let releaseReport!: () => void;
      const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
      const respawns: string[] = [];
      const mintCalls: string[][] = [];
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_FLEET_BG: '',
          PAPERCUSP_FLEET_FG: '',
          PAPERCUSP_FLEET_CURSOR: '',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintRecycleArgs: (args: string[]) => {
          mintCalls.push(args);
          return { args: args.slice(0, -1).concat('RECYCLED'), nativeId: freshNativeId };
        },
        onRespawn: (nativeId: string) => {
          respawns.push(nativeId);
          signalReportStarted();
          return reportGate;
        },
        onExit: () => {},
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('BOOT:ORIGINAL'), { timeout: 2_000 });
        const predecessorPid = JSON.parse(readFileSync(meta, 'utf8')).ptyPid;

        await controlInject(sock, 'recycle', '');
        await reportStartedSignal;
        await sleep(100);

        // The fresh child has already been spawned, but no successor metadata or
        // output listener may be published until the async report resolves.
        expect(JSON.parse(readFileSync(meta, 'utf8')).ptyPid).toBe(predecessorPid);
        expect(captured()).not.toContain('LIVE:RECYCLED');
        expect(respawns).toEqual([freshNativeId]);
        expect(mintCalls).toHaveLength(1);

        releaseReport();
        await vi.waitFor(() => expect(captured()).toContain('LIVE:RECYCLED'), { timeout: 2_000 });
        expect(JSON.parse(readFileSync(meta, 'utf8')).ptyPid).not.toBe(predecessorPid);

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
      } finally {
        // If an assertion fails before the report is released, unblock the
        // host's bounded callback wait so cleanup cannot consume the whole test
        // timeout while a child is still alive.
        releaseReport();
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done;
      }
    },
    25_000,
  );
});

describe('ADOPTION — a stale host hands the session to a fresh launcher instead of respawning inside itself (WI-38292)', () => {
  // The bug: psu-launcher imports psu-pty-host ONCE and `recycleChild` only ever
  // replaces the CLI child, so a host fix committed after this process booted is
  // inert for the session's whole life. Increment 1 made that visible; this is
  // the leg that makes the session actually RUN the new code. The reporter's
  // stated acceptance is exactly this: "a host-version change is adopted before
  // the successor carry is delivered".
  const childCode =
    "process.stdout.write('BOOT:'+process.pid+'\\n');" +
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
    "if(line==='QUIT'){process.exit(0);}}});" +
    'setTimeout(()=>process.exit(0),15000);';

  it(
    'writes the successor\'s orders, releases the discovery key, and leaves by the re-exec door WITHOUT respawning a child',
    async () => {
      const ownerId = `su-adopt-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const handoff = handoffPathFor(ownerId);
      const { captured, io } = fakeIo();

      const reexecs: Array<{ code: number; mode: string }> = [];
      const ended: number[] = [];

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_FS_MUTEX_LOCK_DIR: '/isolated/explicit-mutex-root',
          TERM: 'xterm-256color',
          // The shim's advertisement. Without it the host must NOT exit — see the
          // control below, which is the safety-critical half of this pair. The
          // PPID is part of it: the promise is only ours if OUR parent made it.
          PAPERCUSP_PSU_REEXEC: '87',
          PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid),
        },
        ownerId,
        advSessionId: 42,
        io,
        bridgeTty: false,
        // The file on disk moved on after this process loaded it — the live
        // reproduction, injected rather than performed, because performing it
        // would mean rewriting the checkout mid-test.
        hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
        mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
        onReexec: ({ code, mode }: { code: number; mode: string }) => { reexecs.push({ code, mode }); },
        onExit: (c: number) => { ended.push(c); },
      });

      await sleep(600);
      expect(captured()).toContain('BOOT:');
      const firstBoots = [...captured().matchAll(/BOOT:/g)].length;
      expect(firstBoots).toBe(1);

      // Exercise adoption with no pending wake. The shouldAdoptHostCode unit
      // test separately verifies that pending turn/carry deliveries veto it.
      await controlInject(sock, 'recycle', '');

      const code = await done;

      expect(reexecs).toEqual([{ code: 87, mode: 'recycle' }]);
      expect(code).toBe(87);
      expect(ended).toEqual([]);
      expect([...captured().matchAll(/BOOT:/g)].length).toBe(1);

      expect(existsSync(handoff)).toBe(true);
      const orders = JSON.parse(readFileSync(handoff, 'utf8'));
      expect(orders).toMatchObject({
        ownerId,
        mode: 'recycle',
        fromPid: process.pid,
        advSessionId: 42,
        codexHome: '/tmp/codex-home-for-handoff',
        childEnv: {
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          PAPERCUSP_FS_MUTEX_LOCK_DIR: '/isolated/explicit-mutex-root',
        },
      });
      expect(orders.childEnv).not.toHaveProperty('DISABLE_AUTO_COMPACT');
      expect(orders.childEnv).not.toHaveProperty('DISABLE_COMPACT');
      expect(orders.args).toEqual(['-e', childCode, 'ORIGINAL']);

      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);

      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(events.find((event) => event.kind === 'host-code-stale')).toMatchObject({
        adoptable: true,
        pendingWakeDelivery: false,
        willAdopt: true,
        notAdoptingReason: null,
      });
      expect(events.some((event) => event.kind === 'host-code-adopting')).toBe(true);

      unlinkSync(handoff);
    },
    25_000,
  );

  it('keeps adoption pending past the diagnostic cap until the real predecessor exit notification arrives (EI-27747541848781655)', async () => {
    const ownerId = `su-adopt-exit-fence-${process.pid}-${Math.floor(performance.now())}`;
    const { captured, io } = fakeIo();
    const delayedExits: Array<() => void> = [];
    let exitsReleased = false;
    let childPid = 0;
    let spawns = 0;
    let settled = false;
    const reexecs: number[] = [];
    const releaseExits = () => {
      exitsReleased = true;
      for (const notify of delayedExits.splice(0)) notify();
    };
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color',
        PAPERCUSP_PSU_REEXEC: '87', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid),
      },
      ownerId,
      io,
      bridgeTty: false,
      hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
      mintRecycleArgs: (args: string[]) => ({ args, nativeId: null }),
      onReexec: ({ code }: { code: number }) => { reexecs.push(code); },
      spawnPty: (file, args, options, realSpawn) => {
        const spawned = realSpawn(file, args, options);
        childPid = spawned.pid;
        spawns++;
        const onExit = spawned.onExit.bind(spawned);
        return new Proxy(spawned, {
          get(target, property) {
            if (property === 'onExit') {
              return (handler: (event: { exitCode: number; signal: number }) => void) =>
                onExit((event: { exitCode: number; signal: number }) => {
                  if (exitsReleased) handler(event);
                  else delayedExits.push(() => handler(event));
                });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    void done.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 5_000 });
      await controlInject(socketPathFor(ownerId), 'recycle', '');
      // Distinguish a delayed notification from a live, unkillable child: the
      // real node-pty exit has happened, and this exact PID no longer exists.
      await vi.waitFor(() => {
        expect(delayedExits.length).toBeGreaterThan(0);
        expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
          .toContain('"kind":"pty-child-exit-unverified"');
      }, { timeout: 5_000 });
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      expect(settled).toBe(false);
      expect(reexecs).toEqual([]);
      expect(spawns).toBe(1);
      expect(existsSync(socketPathFor(ownerId))).toBe(true);
      expect(existsSync(metaPathFor(ownerId))).toBe(true);

      releaseExits();
      expect(await done).toBe(87);
      expect(reexecs).toEqual([87]);
      expect(spawns).toBe(1);
      expect(existsSync(socketPathFor(ownerId))).toBe(false);
      expect(existsSync(metaPathFor(ownerId))).toBe(false);
    } finally {
      releaseExits();
      await done;
      const handoff = handoffPathFor(ownerId);
      if (existsSync(handoff)) unlinkSync(handoff);
    }
  }, 15_000);

  it(
    'CONTROL: with no shim advertisement it respawns in place — a launcher nobody will re-run must never exit',
    async () => {
      // Same staleness, same wiring, one thing removed: the promise that something
      // will re-run us. Under an old shim / an operator-spawned headless member,
      // exiting would simply END the owner's session. This is the pair that makes
      // the test above evidence about the HANDSHAKE rather than about staleness.
      const ownerId = `su-adopt-noshim-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();
      const signalSource = new EventEmitter();
      const env: ReturnType<typeof hermeticEnv> & {
        PAPERCUSP_PSU_REEXEC?: string;
        PAPERCUSP_PSU_REEXEC_PPID?: string;
      } = { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' };
      delete env.PAPERCUSP_PSU_REEXEC;
      delete env.PAPERCUSP_PSU_REEXEC_PPID;

      const reexecs: number[] = [];
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env,
        ownerId,
        io,
        bridgeTty: false,
        signalSource,
        hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
        mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
        onReexec: ({ code }: { code: number }) => { reexecs.push(code); },
        onExit: () => {},
      });

      try {
        await vi.waitFor(() => expect([...captured().matchAll(/BOOT:/g)]).toHaveLength(1), { timeout: 5_000 });

        await controlInject(sock, 'recycle', '');
        await vi.waitFor(() => {
          expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
            .toContain('"kind":"respawn-predecessor-stop-finished"');
        }, { timeout: 8_000 });
        await vi.waitFor(() => expect([...captured().matchAll(/BOOT:/g)]).toHaveLength(2), { timeout: 5_000 });

        // Respawned in place, exactly as before WI-38292 — a stale host, but a live
        // session — and the re-exec door was never opened.
        expect([...captured().matchAll(/BOOT:/g)].length).toBe(2);
        expect(reexecs).toEqual([]);
        // The staleness is still REPORTED, so the condition stays visible.
        const eventLog = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
        expect(eventLog).toContain('"kind":"host-code-stale"');
        // WI-10001514: and the row now says WHY it did not adopt. Without that, this
        // no-shim headless host — which COULD have adopted safely and is a real gap —
        // is byte-identical to an interactive host refusing correctly, which is why
        // 7,021 of 9,087 measured stale detections were unattributable to either
        // cause. This case is the sharp one: onReexec IS wired and only the shim
        // advertisement is missing, so the reason must name the CODE, not the
        // callback. Asserting the exact discriminator keeps the two from collapsing
        // back into one label.
        const staleRow = eventLog
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((e) => e.kind === 'host-code-stale');
        expect(staleRow).toBeDefined();
        expect(staleRow.adoptable).toBe(false);
        expect(staleRow.willAdopt).toBe(false);
        expect(staleRow.notAdoptingReason).toBe('no-reexec-code');
        expect(staleRow.bridgeTty).toBe(false);
        expect(staleRow.hasReexecCallback).toBe(true);
        expect(existsSync(handoffPathFor(ownerId))).toBe(false);

        await rawInject(sock, 'QUIT\n');
        await done;
      } finally {
        signalSource.emit('SIGTERM');
        await done;
      }
    },
    25_000,
  );
});

describe('RECYCLE heals a DEAD operator pin before the successor starts (EI-24091823697677465)', () => {
  // The child prints the operator URL it was started with, so the successor's env is
  // observable. Measured 2026-09-23: a staging-console pin (http://localhost:3170)
  // rode through every in-place respawn and took the session's MCP down with each
  // staging restart. The heal under test runs with its REAL default (no injection),
  // so the refusal is recognised from a genuine refused socket.
  const childCode =
    "if(process.env.PINHEAL_CHILD_LOG)require('fs').appendFileSync(process.env.PINHEAL_CHILD_LOG,JSON.stringify({phase:'boot',pid:process.pid,url:process.env.PAPERCUSP_OPERATOR_URL,at:Date.now()})+'\\n');" +
    "process.stdout.write('BOOT:'+process.env.PAPERCUSP_OPERATOR_URL+'\\n');" +
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
    "if(line==='QUIT'){process.exit(0);}}});" +
    'setTimeout(()=>process.exit(0),15000);';

  it('waits for a delayed predecessor exit notification before spawning the successor', async () => {
    const ownerId = `su-recycle-exit-fence-${process.pid}-${Math.floor(performance.now())}`;
    const { captured, io } = fakeIo();
    const signalSource = new EventEmitter();
    const delayedExits: Array<() => void> = [];
    let exitsReleased = false;
    const releaseExits = () => {
      exitsReleased = true;
      for (const notify of delayedExits.splice(0)) notify();
    };
    let spawns = 0;
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', "for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>{});" + childCode],
      cwd: '/tmp',
      env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
      ownerId,
      io,
      bridgeTty: false,
      signalSource,
      hostCodeStalenessFn: () => ({ stale: false }),
      mintRecycleArgs: (args: string[]) => ({ args, nativeId: null }),
      spawnPty: (file, args, options, realSpawn) => {
        const spawned = realSpawn(file, args, options);
        if (++spawns === 1) {
          const onExit = spawned.onExit.bind(spawned);
          return new Proxy(spawned, {
            get(target, property) {
              if (property === 'onExit') {
                return (handler: (event: { exitCode: number; signal: number }) => void) =>
                  onExit((event: { exitCode: number; signal: number }) => {
                    if (exitsReleased) handler(event);
                    else delayedExits.push(() => handler(event));
                  });
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
        return spawned;
      },
    });
    const events = () => readFileSync(eventLogPathForOwner(ownerId), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    try {
      await vi.waitFor(() => expect(captured()).toContain('BOOT:'), { timeout: 5_000 });
      await controlInject(socketPathFor(ownerId), 'recycle', '');
      await vi.waitFor(() => expect(events().some((e) => e.kind === 'respawn-predecessor-force-kill'))
        .toBe(true), { timeout: 8_000 });
      // Observe both the REAL child's exit and the old one-second diagnostic
      // cap while its notification is withheld. Wall-clock sleeps cannot prove
      // which of those phases ran first, especially in a whole-file run.
      await vi.waitFor(() => {
        expect(delayedExits.length).toBeGreaterThan(0);
        expect(events().some((e) => e.kind === 'respawn-predecessor-stop-pending')).toBe(true);
      }, { timeout: 5_000 });
      expect(spawns).toBe(1);
      expect(events().some((e) => e.kind === 'respawn-predecessor-stop-finished')).toBe(false);
      releaseExits();
      await vi.waitFor(() => expect(spawns).toBe(2), { timeout: 5_000 });
      const lifecycle = events();
      const stopped = lifecycle.findIndex((e) => e.kind === 'respawn-predecessor-stop-finished');
      expect(lifecycle[stopped]).toMatchObject({ exitObserved: true, forceKillRequested: true, signal: 'SIGKILL' });
      expect(lifecycle.findIndex((e) => e.kind === 'respawned')).toBeGreaterThan(stopped);
    } finally {
      releaseExits();
      // Teardown must not depend on the successor having installed its stdin
      // reader, or a dropped QUIT waits for the child's 15s safety timer.
      signalSource.emit('SIGTERM');
      await done;
    }
  }, 25_000);

  it.each([
    [true, false], [false, false],
    [true, true], [false, true],
  ])(
    'a refused pin changes in the respawned child only when managed=%s (graceful signal resistant=%s)',
    async (managed, gracefulSignalResistant) => {
      // WI-10004944: the heal accepts a replacement proxy only if it serves
      // /api/mcp (d24b79f750, psu-pty-host.mjs `proxyMcpRouteExists`). A real
      // Streamable HTTP endpoint answers a GET with 405; a 404 there means "not
      // an operator" and the heal correctly declines. This fixture 404'd the
      // route, so the managed case failed deterministically from that commit on.
      const proxy = createServer((req, res) => {
        res.writeHead(req.url === '/api/health' ? 200 : req.url === '/api/mcp' ? 405 : 404);
        res.end('ok');
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      const proxyPort = (proxy.address() as net.AddressInfo).port;
      const freed = createServer();
      await new Promise<void>((r) => freed.listen(0, '127.0.0.1', r));
      const deadPort = (freed.address() as net.AddressInfo).port;
      await new Promise<void>((r) => freed.close(() => r()));

      const ownerId = `su-pinheal-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();
      const childLog = join(PSU_PTY_DIR, `${ownerId}.child.jsonl`);
      const signalSource = new EventEmitter();
      const spawnEvidence: Array<{ pid: number; at: number; data: string; exit: unknown }> = [];
      const env: NodeJS.ProcessEnv = {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        TERM: 'xterm-256color',
        PAPERCUSP_OPERATOR_URL: `http://localhost:${deadPort}`,
        PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
        PINHEAL_CHILD_LOG: childLog,
      };
      delete env.PAPERCUSP_PSU_REEXEC;
      delete env.PAPERCUSP_PSU_REEXEC_PPID;
      delete env.PAPERCUSP_MCP_PROXY;
      if (managed) env.PAPERCUSP_OPERATOR_URL_PROVENANCE = 'psu-launcher';
      else delete env.PAPERCUSP_OPERATOR_URL_PROVENANCE;

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', (gracefulSignalResistant
          ? "for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>{});"
          : '') + childCode],
        cwd: '/tmp',
        env,
        ownerId,
        io,
        bridgeTty: false,
        signalSource,
        spawnPty: (file, args, options, realSpawn) => {
          const spawned = realSpawn(file, args, options);
          const evidence = { pid: spawned.pid, at: Date.now(), data: '', exit: null as unknown };
          spawnEvidence.push(evidence);
          spawned.onData((data: string) => { evidence.data = `${evidence.data}${data}`.slice(-4096); });
          spawned.onExit((event: unknown) => { evidence.exit = event; });
          return spawned;
        },
        hostCodeStalenessFn: () => ({ stale: false }),
        mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
        onExit: () => {},
      });
      try {
        // CALIBRATION: the first child really did start on the dead pin, so the
        // assertion below observes a change made at the respawn, not at launch.
        await vi.waitFor(() => {
          expect(captured()).toContain(`BOOT:http://localhost:${deadPort}`);
        }, { timeout: 5000 });
        expect(captured()).not.toContain(`BOOT:http://127.0.0.1:${proxyPort}`);

        await controlInject(sock, 'recycle', '');
        // RECYCLE fences the predecessor before it can boot a successor. A
        // graceful-signal-resistant child legitimately uses the host's 5s
        // graceful wait plus its bounded hard-kill wait. Observe that phase
        // separately; starting the 5s BOOT assertion at injection races it.
        await vi.waitFor(() => {
          expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
            .toContain('"kind":"respawn-predecessor-stop-finished"');
        }, { timeout: 8_000 });
        await vi.waitFor(() => {
          expect(captured().split('BOOT:').length - 1).toBe(2);
        }, { timeout: 5000 });

        const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
        const lifecycle = events.trim().split('\n').map((line) => JSON.parse(line));
        const stopped = lifecycle.findIndex((event) => event.kind === 'respawn-predecessor-stop-finished');
        const respawned = lifecycle.findIndex((event) => event.kind === 'respawned');
        expect(stopped).toBeGreaterThanOrEqual(0);
        expect(respawned).toBeGreaterThan(stopped);
        expect(lifecycle[stopped]).toMatchObject({ exitObserved: true });
        if (gracefulSignalResistant) {
          expect(lifecycle[stopped]).toMatchObject({ forceKillRequested: true, signal: 'SIGKILL' });
        }
        if (managed) {
          expect(captured()).toContain(`BOOT:http://127.0.0.1:${proxyPort}`);
          expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
          expect(events).toContain('"kind":"operator-pin-healed"');
        } else {
          expect(captured().split(`BOOT:http://localhost:${deadPort}`).length - 1).toBe(2);
          expect(captured()).not.toContain(`BOOT:http://127.0.0.1:${proxyPort}`);
          expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
          expect(events).not.toContain('"kind":"operator-pin-healed"');
        }

        await rawInject(sock, 'QUIT\n');
        await done;
      } catch (error) {
        // Preserve the distinction between a child that never reached JS, a
        // child that wrote bytes before the host bridge, and a host that ended.
        // The phase ledger is fixture-owned and contains no inherited secrets.
        console.error('[pin-heal child evidence]', JSON.stringify({
          ownerId, managed, gracefulSignalResistant, spawnEvidence,
          childLog: existsSync(childLog) ? readFileSync(childLog, 'utf8') : 'not-written',
          captured: captured().slice(-4096),
        }));
        throw error;
      } finally {
        // A failed assertion must not leave a host's global signal listeners,
        // child, socket, or timers active during the next parameterized case.
        signalSource.emit('SIGTERM');
        await done;
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    },
    25_000,
  );

  it('routes a direct :3170 pin through the same-build staging proxy before respawn', async () => {
    const stagingProxy = createServer((req, res) => {
      res.writeHead(req.url === '/api/health' ? 200 : 404);
      res.end('ok');
    });
    await new Promise<void>((r) => stagingProxy.listen(0, '127.0.0.1', r));
    const stagingProxyPort = (stagingProxy.address() as net.AddressInfo).port;
    const ownerId = `su-stage-pin-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const env: NodeJS.ProcessEnv = {
      ...hermeticEnv(),
      PAPERCUSP_SID: ownerId,
      TERM: 'xterm-256color',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170',
      PAPERCUSP_MCP_STAGING_PROXY_PORT: String(stagingProxyPort),
    };
    delete env.PAPERCUSP_PSU_REEXEC;
    delete env.PAPERCUSP_PSU_REEXEC_PPID;
    delete env.PAPERCUSP_MCP_PROXY;
    delete env.PAPERCUSP_MCP_STAGING_PROXY;
    delete env.PAPERCUSP_OPERATOR_URL_PROVENANCE;

    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env,
      ownerId,
      io,
      bridgeTty: false,
      hostCodeStalenessFn: () => ({ stale: false }),
      mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
      onExit: () => {},
    });
    try {
      await vi.waitFor(() => {
        expect(captured()).toContain('BOOT:http://127.0.0.1:3170');
      }, { timeout: 5000 });

      await controlInject(sock, 'recycle', '');
      // The exit fence may spend its graceful stop budget before spawning.
      // Start the successor assertion only after that phase is observed.
      await vi.waitFor(() => {
        expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
          .toContain('"kind":"respawn-predecessor-stop-finished"');
      }, { timeout: 8_000 });
      await vi.waitFor(() => {
        expect(captured().split('BOOT:').length - 1).toBe(2);
      }, { timeout: 5000 });

      const routed = `http://127.0.0.1:${stagingProxyPort}`;
      expect(captured()).toContain(`BOOT:${routed}`);
      expect(env.PAPERCUSP_OPERATOR_URL).toBe(routed);
      expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
      expect(events).toContain('"kind":"operator-pin-routed"');
      expect(events).toContain('"route":"staging-proxy"');

      await rawInject(sock, 'QUIT\n');
      await done;
    } finally {
      await new Promise<void>((r) => stagingProxy.close(() => r()));
    }
  }, 25_000);
});

describe('RECYCLE re-renders the base persona instead of inheriting it (stale-prompt-render-in-live-sessions-2026-08-02 P-003)', () => {
  // THE RECURRENCE GUARD for the staleness bug. mintRecycleArgs used to copy every
  // non-resume flag through verbatim, so `--system-prompt-file <predecessor render>`
  // survived every respawn and a session's base persona stayed pinned to launch #1
  // forever. Measured 2026-08-02: 27 of 53 live claude sessions were running a render
  // up to 14 days old, i.e. every prompt fix of that fortnight reached half the fleet.
  //
  // This drives the REAL hostThroughPty against the REAL mintRecycleArgs, so it covers
  // BOTH halves of the seam that has to stay wired: the host must CALL the refresh and
  // hand its result to the mint, and the mint must SWAP the flag. A unit test on either
  // half alone would still pass if the other half were quietly removed — which is
  // exactly how this bug would come back.
  //
  // Proven to fail against pre-fix behaviour: pre-fix there was no refreshPersonaFile
  // option at all, so nothing ever swapped the flag and the first expectation below
  // ("boots on the REFRESHED render") fails. The second case pins the other direction —
  // with no refresh available the inherited path MUST be kept, because that fail-soft is
  // what stops an operator hiccup from costing a live session its respawn.
  // The child is a real SCRIPT FILE, not `node -e`: node parses `--`-prefixed tokens
  // that follow `-e` as its OWN options and dies with "bad option:
  // --system-prompt-file". After a script path everything is a script arg, which is
  // also how the real backend is invoked.
  const childScript = join(
    mkdtempSync(join(tmpdir(), 'psu-persona-guard-')),
    'child.js',
  );
  writeFileSync(
    childScript,
    "const i=process.argv.indexOf('--system-prompt-file');" +
      "const inline=process.argv.find(a=>a.startsWith('--system-prompt-file='));" +
      "const prompt=i>=0?process.argv[i+1]:(inline?inline.slice('--system-prompt-file='.length):'NONE');" +
      "process.stdout.write('BOOT:'+process.pid+' SPF:'+prompt+'\\n');" +
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',d=>{b+=d;let i2;while((i2=b.indexOf('\\n'))>=0){const line=b.slice(0,i2);b=b.slice(i2+1);" +
      "if(line==='QUIT'){process.exit(0);}}});" +
      'setTimeout(()=>process.exit(0),15000);',
  );

  /** The PRE-FIX mint, frozen as a fixture: rotate the session id but copy every other
   *  flag through verbatim, ignoring personaFile entirely. That bare copy-through IS the
   *  bug (psu-launcher.mjs `out.push(a)`), and driving the guard with it is what proves
   *  the guard can actually detect what it was written for. */
  const preFixMint = (a: string[]) => ({ args: [...a, '--session-id', 'pre-fix'], nativeId: 'pre-fix' });

  /** `refreshed` = what the operator's persona-refresh hands back: a path, null when
   *  the refresh failed / was unavailable, or a `{ reason }` refusal with no file.
   *  `mint` defaults to the REAL one. A refused respawn never boots a second child, so
   *  it is observed through its `respawn-failed` host event instead of a second BOOT. */
  async function driveRespawn(
    refreshed: string | null | { reason: string } | Array<string | null | { reason: string }>,
    mint?: (a: string[]) => unknown,
    options: {
      inlinePromptFlag?: boolean;
      deleteInheritedBeforeRecycle?: boolean;
      restoreAndRetry?: boolean;
      recycleAgainAfterFirst?: boolean;
      deleteOriginalAfterFirst?: boolean;
    } = {},
  ) {
    // Import the pure mint helper independently of the invoking operator's
    // endpoint. Tool-driven test runs may inherit a full MCP URL; validating
    // that unrelated live pin at module load is not this fixture's subject.
    const { mintRecycleArgs } = await (async () => {
      const priorOperatorUrl = process.env.PAPERCUSP_OPERATOR_URL;
      process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:1';
      try {
        return await import('../scripts/psu-launcher.mjs');
      } finally {
        if (priorOperatorUrl === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
        else process.env.PAPERCUSP_OPERATOR_URL = priorOperatorUrl;
      }
    })();
    const ownerId = `su-persona-refresh-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const stale = `/tmp/launch-context/session-STALE-${process.pid}-${Math.floor(performance.now())}.md`;
    const refreshValues = Array.isArray(refreshed) ? refreshed : [refreshed];
    let refreshIndex = 0;
    const createdPromptFiles: string[] = [];
    const ensurePromptFixture = (path: unknown) => {
      if (typeof path !== 'string' || existsSync(path)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'P'.repeat(2_000));
      createdPromptFiles.push(path);
    };
    ensurePromptFixture(stale);
    for (const value of refreshValues) {
      if (typeof value === 'string') ensurePromptFixture(value);
    }
    const refusal = refreshValues[0] !== null && typeof refreshValues[0] === 'object'
      ? refreshValues[0]
      : null;
    const refreshPersonaFile = async () => {
      const value = refreshValues[Math.min(refreshIndex++, refreshValues.length - 1)];
      return value !== null && typeof value === 'object'
        ? { promptFile: null, reason: value.reason }
        : { promptFile: value as string | null };
    };
    const { captured, io } = fakeIo();
    const hostEvents = (): Array<Record<string, unknown>> => {
      try {
        return readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };

    let exitCode: number | null = null;
    const done = hostThroughPty({
      command: execPath,
      args: options.inlinePromptFlag
        ? [childScript, `--system-prompt-file=${stale}`]
        : [childScript, '--system-prompt-file', stale],
      cwd: '/tmp',
      // PAPERCUSP_AGENT=claude so the REAL mint synthesizes a --session-id for this
      // resume-shaped argv instead of no-op'ing (the 2026-07-18 mint gap).
      env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude', TERM: 'xterm-256color' },
      ownerId,
      io,
      bridgeTty: false,
      mintRecycleArgs: mint ?? mintRecycleArgs,
      refreshPersonaFile,
      onExit: (c: number) => { exitCode = c; },
    });

    // First boot always runs the launch argv verbatim — the inherited render.
    await vi.waitFor(() => {
      expect(captured()).toContain(`SPF:${stale}`);
    }, { timeout: 5000 });

    if (options.deleteInheritedBeforeRecycle) unlinkSync(stale);
    await controlInject(sock, 'recycle', '');
    if (options.deleteInheritedBeforeRecycle) {
      await vi.waitFor(() => {
        expect(hostEvents()).toContainEqual(
          expect.objectContaining({ kind: 'respawn-failed', reason: 'persona-file-missing' }),
        );
      }, { timeout: 5000 });
      if (options.restoreAndRetry) {
        writeFileSync(stale, 'P'.repeat(2_000));
        await controlInject(sock, 'recycle', '');
        await vi.waitFor(() => {
          expect([...captured().matchAll(/SPF:(\S+)/g)]).toHaveLength(2);
        }, { timeout: 5000 });
      }
    } else if (refusal) {
      await vi.waitFor(() => {
        expect(hostEvents().some((e) => e.kind === 'respawn-failed')).toBe(true);
      }, { timeout: 5000 });
    } else {
      await vi.waitFor(() => {
        expect([...captured().matchAll(/SPF:(\S+)/g)]).toHaveLength(2);
      }, { timeout: 5000 });
      if (options.recycleAgainAfterFirst) {
        if (options.deleteOriginalAfterFirst) unlinkSync(stale);
        await controlInject(sock, 'recycle', '');
        // Allow the 5s graceful-stop deadline and 1s SIGKILL observation window before judging the third spawn missing.
        await vi.waitFor(() => {
          expect([...captured().matchAll(/SPF:(\S+)/g)]).toHaveLength(3);
        }, { timeout: 15000 });
      }
    }

    const spfs = [...captured().matchAll(/SPF:(\S+)/g)].map((m) => m[1]);
    await rawInject(sock, 'QUIT\n');
    await done;
    expect(exitCode).toBe(0);
    for (const path of createdPromptFiles) {
      try { unlinkSync(path); } catch { /* already removed by the test */ }
    }
    return { spfs, stale, events: hostEvents() };
  }

  it(
    'boots the successor on the REFRESHED render, not the predecessor\'s',
    async () => {
      const fresh = `/tmp/launch-context/session-refresh-FRESH-${process.pid}.md`;
      const { spfs, stale } = await driveRespawn(fresh, undefined, { inlinePromptFlag: true });
      expect(spfs).toHaveLength(2);
      expect(spfs[0]).toBe(stale);
      // The whole point: the successor must NOT be running the file its predecessor
      // ran. This is the assertion that goes red if the seam is ever unwired.
      expect(spfs[1]).toBe(fresh);
      expect(spfs[1]).not.toBe(stale);
    },
    30_000,
  );

  it(
    'reuses the live child render when a later refresh fails after the original was collected',
    async () => {
      const fresh = `/tmp/launch-context/session-refresh-LIVE-${process.pid}.md`;
      const { spfs, stale } = await driveRespawn([fresh, null], undefined, {
        recycleAgainAfterFirst: true,
        deleteOriginalAfterFirst: true,
      });
      expect(spfs).toHaveLength(3);
      expect(spfs[0]).toBe(stale);
      expect(spfs[1]).toBe(fresh);
      expect(spfs[2]).toBe(fresh);
    },
    30_000,
  );

  it(
    'KEEPS the inherited render when the refresh yields nothing (fail-soft, = pre-fix behaviour)',
    async () => {
      // A refresh that failed or was unavailable must never cost the session its
      // respawn — a stale prompt beats a dead session. This also pins that the swap is
      // CONDITIONAL, so a future change cannot start rewriting argv unconditionally.
      const { spfs, stale } = await driveRespawn(null);
      expect(spfs).toHaveLength(2);
      expect(spfs.every((s) => s === stale)).toBe(true);
    },
    30_000,
  );

  it(
    'KEEPS the current child alive when refresh fails and the inherited render is missing, then retries',
    async () => {
      const { spfs, stale, events } = await driveRespawn(null, undefined, {
        deleteInheritedBeforeRecycle: true,
        restoreAndRetry: true,
      });
      expect(spfs).toHaveLength(2);
      expect(spfs.every((s) => s === stale)).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'respawn-failed', reason: 'persona-file-missing' }),
      );
    },
    30_000,
  );

  it(
    'PROOF the guard discriminates: under the PRE-FIX mint the successor inherits the stale render even though a refresh was available',
    async () => {
      // A guard that cannot detect what it was written for is theatre (P-003). This
      // reproduces the original bug on demand: a refresh IS supplied, yet the copy-
      // through mint carries `--system-prompt-file <stale>` into the successor anyway.
      // The first test in this block asserts the opposite outcome from the same input,
      // so if the fix were ever unwired that test necessarily goes red.
      const fresh = `/tmp/launch-context/session-refresh-FRESH-${process.pid}.md`;
      const { spfs, stale } = await driveRespawn(fresh, preFixMint);
      expect(spfs).toHaveLength(2);
      expect(spfs[1]).toBe(stale); // the bug, reproduced
      expect(spfs[1]).not.toBe(fresh);
    },
    30_000,
  );

  it(
    'REFUSES the respawn on an identity-activation refusal instead of booting the inherited render (P-016 D-012)',
    async () => {
      // agent-economy-flywheel P-016: the operator could neither fund nor drop a priced
      // Cupboard identity. Fail-soft would boot the successor on the inherited render,
      // which carries that identity, so the host must abandon the respawn and keep the
      // current child. The fail-soft test above passes the same null promptFile and
      // expects a second boot, so a host that ignored the reason fails here.
      const { spfs, stale, events } = await driveRespawn({ reason: IDENTITY_ACTIVATION_REFUSED_REASON });
      expect(IDENTITY_ACTIVATION_REFUSED_REASON).toBe('identity-activation-refused');
      expect(spfs).toEqual([stale]);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'respawn-failed', reason: IDENTITY_ACTIVATION_REFUSED_REASON }),
      );
    },
    30_000,
  );
});

describe('RECYCLE carry-inject is retried across a budget, then dropped LOUDLY (WI-1941)', () => {
  it(
    'RETRIES past a fresh child that stays busy beyond one busy-cap, injecting the carry once it settles',
    async () => {
      const ownerId = `su-recycle-retry-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // On EACH boot the child prints BOOT:<pid>, then SPINS (a dot every 20ms for
      // ~700ms) so its output stays "busy" past the busy-cap, THEN goes quiet and
      // echoes stdin. A single-shot waitAtPrompt (cap 300 < 700ms spin) would DROP
      // the carry — so 'ECHO:CARRIED' landing proves the retry loop worked.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'let n=0;const iv=setInterval(()=>{process.stdout.write(".");if(++n>35){clearInterval(iv);process.stdout.write("INITIAL_SETTLED\\n");}},20);' +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300', // shorter than the ~700ms spin → attempts defer
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '8000', // ample budget → retry, don't drop
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
      await vi.waitFor(() => {
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);
        expect(captured()).toContain('INITIAL_SETTLED');
      }, { timeout: 8000 });

      await controlInject(sock, 'recycle', 'CARRIED');
      const bootsAfter = await vi.waitFor(() => {
        const boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        expect(boots).toHaveLength(2);
        expect(captured()).toContain('ECHO:CARRIED');
        return boots;
      }, { timeout: 8000 });
      expect(bootsAfter).toHaveLength(2); // genuinely respawned
      // The carry landed via RETRY (the fresh child was busy past the first cap).
      expect(captured()).toContain('ECHO:CARRIED');
      // …and nothing was recorded as dropped.
      const metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      expect(metaAfter.carryDropCount ?? 0).toBe(0);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
      } catch (error) {
        const eventLog = eventLogPathForOwner(ownerId);
        console.error(`[${ownerId}] output=${captured()}\n${existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '(no host events yet)'}`);
        throw error;
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n').catch((error) => console.error(error));
        await done.catch((error: unknown) => console.error(error));
      }
    },
    30_000,
  );

  it(
    'retries one fresh epoch, then DROPS LOUDLY when the child never settles',
    async () => {
      const ownerId = `su-recycle-drop-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'psu-recycle-drop-boot-'));
      const bootRelease = join(fixtureRoot, 'ready');

      // WI-1818 (clean-boundary-only kill): the pre-recycle busy gate is now
      // unconditional (applies regardless of bridgeTty), so the ORIGINAL child
      // must genuinely settle before the recycle can fire at all — else the kill
      // itself would be (correctly) refused and this test would never exercise
      // the POST-recycle carry-drop path it's actually about. So the ORIGINAL
      // boot bursts briefly then goes quiet; the RESPAWNED boot (marked via
      // mintRecycleArgs, WI-1980-style) SPINS FOREVER — every post-recycle
      // waitAtPrompt attempt across the budget defers and the carry is
      // ultimately DROPPED after the bounded fresh-epoch retry. The dropped
      // iteration must be OBSERVABLE (WI-1941: never traceless) — asserted via
      // the durable meta counter. QUIT still
      // lands (raw inject bypasses the gate; the stdin handler fires between
      // the non-blocking spin ticks).
      // Shell builtins make the busy signal available at exec, before the
      // 700ms carry budget. A fresh Node runtime can emit its first byte only
      // after that budget and accidentally exercise the no-output last resort.
      const childCode = [
        'marker=$1; n=0',
        'if [[ "$marker" != RECYCLED ]]; then',
        "  printf 'BOOT_PENDING\\n'",
        '  until [[ -e "$BOOT_RELEASE" ]]; do read -r -t 0.01 ignored || :; done',
        'fi',
        "printf 'BOOT:%s\\n' $$",
        'while (( SECONDS < 20 )); do',
        '  if read -r -t 0.02 line; then',
        '    [[ "$line" == QUIT ]] && exit 0',
        "    printf 'ECHO:%s\\n' \"$line\"",
        '  fi',
        '  if [[ "$marker" == RECYCLED ]]; then printf .',
        '  elif (( ++n <= 9 )); then printf .',
        "  elif (( n == 10 )); then printf 'INITIAL_SETTLED\\n'; fi",
        'done',
      ].join('\n');

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: 'bash',
        args: ['-c', childCode, 'carry-busy-fixture', 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          BOOT_RELEASE: bootRelease,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '200',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '700', // small → exhaust fast, then drop
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          // Exercise the marker-missing path in every launcher environment,
          // not Claude's first-byte-ready default inherited via process.env.
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '60000',
          PAPERCUSP_PSU_PTY_CARRY_PROOF_RETRIES: '1',
        },
        ownerId,
        io,
        bridgeTty: false,
        // Rewrite the respawn argv so ONLY the post-recycle boot spins forever —
        // the ORIGINAL boot must settle for the pre-kill busy gate to let the
        // recycle fire at all (see the comment above).
        mintRecycleArgs: (a: string[]) => ({ args: a.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        onExit: (c: number) => { exitCode = c; },
      });

      let releaseBoot: ReturnType<typeof setTimeout> | undefined;
      try {
      await vi.waitFor(() => expect(captured()).toContain('BOOT_PENDING'), { timeout: 8000 });
      expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(0);
      // Keep a real child alive without BOOT beyond the old 800ms assumption.
      releaseBoot = setTimeout(() => writeFileSync(bootRelease, 'ready'), 900);
      await vi.waitFor(() => {
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);
        expect(captured()).toContain('INITIAL_SETTLED');
      }, { timeout: 8000 });

      await controlInject(sock, 'recycle', 'CARRIED');
      const { bootsAfter, metaAfter } = await vi.waitFor(() => {
        const bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        const metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
        expect(bootsAfter).toHaveLength(3);
        expect(metaAfter.carryDropCount).toBe(1);
        return { bootsAfter, metaAfter };
      }, { timeout: 8000 });
      expect(bootsAfter).toHaveLength(3); // original + one bounded fresh-epoch retry
      // The carry was NEVER injected (the fresh child never reached its prompt)…
      expect(captured()).not.toContain('ECHO:CARRIED');
      // …and the drop is DURABLY OBSERVABLE, not silent (WI-1941 core guarantee).
      expect(metaAfter.carryDropCount).toBe(1);
      expect(typeof metaAfter.lastCarryDropAt).toBe('number');
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const freshEpochRetry = events.find((event) => event.kind === 'respawn-carry-fresh-epoch-retry');
      const terminalDrop = events.find((event) => event.kind === 'respawn-carry-dropped');
      expect(freshEpochRetry).toEqual(expect.objectContaining({
        kind: 'respawn-carry-fresh-epoch-retry',
        attempt: 1,
        maxRetries: 1,
      }));
      expect(freshEpochRetry?.reason).toBe('no-startup-ready-marker-last-resort-failed');
      expect(terminalDrop?.reason).toBe(freshEpochRetry?.reason);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
      } catch (error) {
        // Preserve this fixture's evidence before teardown, rather than relying
        // on the directory-wide failure hook to find a preceding fixture's log.
        const eventLog = eventLogPathForOwner(ownerId);
        console.error(`[${ownerId}] output=${captured()}\n${existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '(no host events yet)'}`);
        throw error;
      } finally {
        clearTimeout(releaseBoot);
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n').catch((error) => console.error(error));
        await done.catch((error: unknown) => console.error(error));
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'books a verifier-exhausted RECYCLE carry as dropped, keeps the child controllable, and never emits delivered (WI-42318)',
    async () => {
      const ownerId = `su-recycle-submit-drop-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "if(process.stdin.isTTY)process.stdin.setRawMode(true);" +
        "process.stdin.setEncoding('utf8');" +
        "process.stdin.on('data',d=>{if(String(d).includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),15000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_PSU_HEADLESS: '0',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '1',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '1500',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        const bootDeadline = Date.now() + 3_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await controlInject(sock, 'recycle', 'CARRIED');
        const outcomeDeadline = Date.now() + 5_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < outcomeDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            if (events.some((event) => event.kind === 'respawn-carry-dropped')) break;
          }
          await sleep(20);
        }

        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(2);
        // WI-6554700010009740 defers a submitted carry to the stronger native
        // proof. Keep the submit failure observable without treating it as the
        // terminal verdict: this fixture has no native id or persisted turn.
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'submit-verify-unconfirmed',
          label: 'recycle carry-note',
          reason: 'native-submission-unconfirmed',
          terminated: false,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'startup-turn-dropped',
          label: 'recycle carry-note',
          reason: 'submit-verification-exhausted',
          attempts: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-start-unverified',
          mode: 'recycle',
          detail: 'missing-native-id',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          reason: 'turn-start-unverified',
          attempts: 1,
          outputSeen: true,
          turnStartVerified: false,
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        // Missing native proof does not establish child death. The host keeps
        // its control socket available until the child explicitly quits.
        expect(exitCode).toBeNull();
        expect(existsSync(sock)).toBe(true);
        expect(existsSync(meta)).toBe(true);
        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    20_000,
  );
});

describe('final interactive terminal handoff (WI-42458)', () => {
  it(
    'disables mouse reporting after the child exits before returning the terminal to its shell',
    async () => {
      let captured = '';
      const rawModes: boolean[] = [];
      const stdout = {
        columns: 100,
        rows: 40,
        write: (d: Buffer | string) => {
          captured += d.toString();
        },
        on() {},
        off() {},
      };
      const stdin = Object.assign(new EventEmitter(), {
        isTTY: true,
        resume() {},
        pause() {},
        setRawMode(enabled: boolean) {
          rawModes.push(enabled);
        },
      });
      const ownerId = `su-final-terminal-handoff-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const childCode =
        "process.stdout.write('\\x1b[?1003h\\x1b[?1006h');" +
        'setTimeout(()=>process.exit(0),50);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        onExit: () => {},
      });

      expect(await done).toBe(0);
      const mouseEnableAt = captured.indexOf('\x1b[?1003h');
      const mouseDisableAt = captured.lastIndexOf('\x1b[?1003l');
      expect(mouseEnableAt).toBeGreaterThanOrEqual(0);
      expect(mouseDisableAt).toBeGreaterThan(mouseEnableAt);
      for (const mode of ['1000', '1002', '1003', '1006']) {
        expect(captured).toContain(`\x1b[?${mode}l`);
      }
      expect(captured).toContain('\x1b[?2004l');
      expect(captured).not.toContain('session restarted');
      expect(rawModes).toEqual([true, false]);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    10_000,
  );
});

describe('force interrupt via the operator-side interruptViaPty (Phase 4 pty-force leg)', () => {
  it(
    'lands a real SIGINT mid-run through the control socket; the shell survives',
    async () => {
      // The full live chain: a managed-pty session is hosting a real bash with a
      // long foreground job ("the agent mid-thinking"); the operator calls
      // interruptViaPty(owner,'sigint') — discover the session by ownerId → connect
      // to its control socket → inject a RAW Ctrl-C → the pty line discipline turns
      // it into SIGINT for the foreground process group. NOT the user's keyboard,
      // NOT the stdin bridge — the same path e8630's turn:interrupt force mode uses.
      let captured = '';
      const stdout = { columns: 100, rows: 40, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {}, setRawMode() {} });
      const type = (s: string) => (stdin as EventEmitter).emit('data', Buffer.from(s, 'utf8'));

      const ownerId = `su-force-itest-${process.pid}-${Math.floor(performance.now())}`;
      const done = hostThroughPty({
        command: 'bash',
        args: ['--norc', '--noprofile', '-i'],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color', PS1: '$ ' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(500);
      // The operator can discover the live session (same lookup the wake-executor uses).
      expect(findLiveHost(ownerId, undefined, ID_OK)).not.toBeNull();

      // Start a 20s foreground job. If the interrupt FAILS, the typed `exit` queues
      // behind it and this test blows its 15s timeout — so a clean finish is itself
      // evidence the sleep was cut short.
      type('sleep 20\n');
      await sleep(600);

      const ok = await interruptViaPty(ownerId, 'sigint', ID_OK);
      expect(ok).toBe(true);
      await sleep(500);

      // Shell survived the interrupt and accepts a new command.
      type('echo SURVIVED_FORCE\n');
      await sleep(500);
      type('exit\n');
      await done;

      expect(captured).toContain('^C'); // the foreground job got SIGINT
      expect(captured).toContain('SURVIVED_FORCE'); // shell still alive afterward

      // Cleanup
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    15_000,
  );
});

describe('orphan / vanished-terminal teardown (WI-3141)', () => {
  it(
    'tears down (kills the child, cleans up socket+meta) when the bridged terminal closes — stdin EOF/close',
    async () => {
      // A managed-pty host must not outlive the interactive terminal it bridges.
      // Simulate the terminal vanishing: a real interactive bridge (bridgeTty) whose
      // stdin emits 'close'. The host must kill its (still-alive, 20s-safety-net)
      // child and clean up — instead of lingering as a forwarding orphan (the
      // "random characters appear without typing" report).
      const ownerId = `su-orphan-eof-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const childLog = join(PSU_PTY_DIR, `${ownerId}.child.jsonl`);
      const signalSource = new EventEmitter();
      const spawnEvidence: Array<{ pid: number; data: string; exit: unknown }> = [];
      let captured = '';
      const stdout = { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {}, setRawMode() {} });

      // Long-lived child (20s net) that would keep the host alive forever if the
      // terminal-close teardown didn't fire.
      const childCode =
        "require('node:fs').writeFileSync(process.env.ORPHAN_CHILD_LOG,JSON.stringify({phase:'js-start',pid:process.pid})+'\\n');" +
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'process.stdin.on(\'data\',()=>{});' +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color', ORPHAN_CHILD_LOG: childLog },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        signalSource,
        spawnPty: (file, args, options, realSpawn) => {
          const spawned = realSpawn(file, args, options);
          const evidence = { pid: spawned.pid, data: '', exit: null as unknown };
          spawnEvidence.push(evidence);
          spawned.onData((data: string) => { evidence.data = `${evidence.data}${data}`.slice(-4096); });
          spawned.onExit((event: unknown) => { evidence.exit = event; });
          return spawned;
        },
        onExit: (c: number) => { exitCode = c; },
      });

      try {
        await vi.waitFor(() => expect(captured).toContain('BOOT:'), { timeout: 5_000 });
        expect(existsSync(sock)).toBe(true);

        // Close the live terminal before the child's 20s safety timer.
        (stdin as EventEmitter).emit('close');

        const code = await done;
        expect(code).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } catch (error) {
        console.error('[orphan EOF child evidence]', JSON.stringify({
          ownerId, spawnEvidence, captured,
          childLog: existsSync(childLog) ? readFileSync(childLog, 'utf8') : 'not-written',
          events: existsSync(eventLogPathForOwner(ownerId)) ? readFileSync(eventLogPathForOwner(ownerId), 'utf8') : 'not-written',
        }));
        throw error;
      } finally {
        signalSource.emit('SIGTERM');
        await done;
      }
    },
    20_000,
  );

  it(
    'tears down when the launching parent dies (reparent-to-init) even if the pts stays alive',
    async () => {
      // The exact 2026-07-05 orphan: psu's launching shell exits (ppid→init) while
      // the /dev/pts stays alive (a fresh shell took it over), so stdin never hits
      // EOF. The parent-death watchdog must catch it. parentPidFn is injected to
      // fake the reparent without a real fork; a short poll keeps the test fast.
      const ownerId = `su-orphan-ppid-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const childLog = join(PSU_PTY_DIR, `${ownerId}.child.jsonl`);
      const signalSource = new EventEmitter();
      const spawnEvidence: Array<{ pid: number; data: string; exit: unknown }> = [];
      let captured = '';
      const stdout = { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {}, setRawMode() {} });

      const childCode =
        "require('node:fs').writeFileSync(process.env.ORPHAN_CHILD_LOG,JSON.stringify({phase:'js-start',pid:process.pid})+'\\n');" +
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'process.stdin.on(\'data\',()=>{});' +
        'setTimeout(()=>process.exit(0),20000);';

      // Starts NON-init (a live shell); flip to init to simulate the shell exiting.
      let fakeParent = 424242;

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color', PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS: '100', ORPHAN_CHILD_LOG: childLog },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        signalSource,
        spawnPty: (file, args, options, realSpawn) => {
          const spawned = realSpawn(file, args, options);
          const evidence = { pid: spawned.pid, data: '', exit: null as unknown };
          spawnEvidence.push(evidence);
          spawned.onData((data: string) => { evidence.data = `${evidence.data}${data}`.slice(-4096); });
          spawned.onExit((event: unknown) => { evidence.exit = event; });
          // Keep the native exit event as independent evidence, but withhold it
          // from the host so this fixture deterministically covers its
          // conservative unverified-exit branch under a real child teardown.
          return new Proxy(spawned, {
            get(target, property) {
              if (property === 'onExit') return () => undefined;
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
        parentPidFn: () => fakeParent,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
        await vi.waitFor(() => expect(captured).toContain('BOOT:'), { timeout: 5_000 });
        expect(existsSync(sock)).toBe(true);

        // The launching shell exits → we get reparented to init. The watchdog's
        // next poll must observe ppid===1 and tear the orphaned host down.
        fakeParent = 1;
        const code = await done;
        expect(code).toBe(1);
        expect(exitCode).toBe(1);
        await vi.waitFor(() => expect(spawnEvidence[0]?.exit).not.toBeNull(), { timeout: 3_000 });
        const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
          .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'orphan-teardown',
          why: 'parent-exited',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'pty-child-exit-unverified',
          childPid: spawnEvidence[0]?.pid,
        }));
        const childState = () => {
          const pid = spawnEvidence[0]?.pid;
          if (!pid || pid <= 1) return 'unknown';
          try {
            process.kill(pid, 0);
            return linuxProcStateFromStat(readFileSync('/proc/' + pid + '/stat', 'utf8')) ?? 'unknown';
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return code === 'ESRCH' || code === 'ENOENT' ? 'absent' : 'unknown';
          }
        };
        await vi.waitFor(() => expect(childState()).toBe('absent'), { timeout: 3_000 });
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } catch (error) {
        console.error('[orphan child evidence]', JSON.stringify({
          ownerId, spawnEvidence, captured,
          childLog: existsSync(childLog) ? readFileSync(childLog, 'utf8') : 'not-written',
          events: existsSync(eventLogPathForOwner(ownerId)) ? readFileSync(eventLogPathForOwner(ownerId), 'utf8') : 'not-written',
        }));
        throw error;
      } finally {
        signalSource.emit('SIGTERM');
        await done;
      }
    },
    20_000,
  );
});

describe('WI-3455 — discovery key ownership + self-heal (the su-a8f52 stranding class)', () => {
  it(
    'self-heals: recreates a deleted json + re-binds a deleted sock while the host is live',
    async () => {
      const ownerId = `su-selfheal-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const signalSource = new EventEmitter();

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        "process.stdout.write('READY\\n');" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        activityPersistMs: 150,
        signalSource,
        onExit: () => {},
      });

      try {
        // Socket existence proves the host is listening, not that the child has
        // installed its stdin handler. Observe both before deleting discovery.
        await vi.waitFor(() => {
          expect(captured()).toContain('READY');
          expect(existsSync(sock)).toBe(true);
          expect(existsSync(meta)).toBe(true);
        }, { timeout: 5_000 });

        // Simulate the trample: a duplicate host / janitor race deletes BOTH.
        unlinkSync(meta);
        unlinkSync(sock);
        expect(existsSync(meta)).toBe(false);
        expect(existsSync(sock)).toBe(false);

        // Wait for the existing activity tick's observable repair.
        await vi.waitFor(() => {
          expect(existsSync(meta)).toBe(true);
          expect(existsSync(sock)).toBe(true);
          const healed = JSON.parse(readFileSync(meta, 'utf8'));
          expect(healed.ownerId).toBe(ownerId);
          expect(healed.pid).toBe(process.pid);
        }, { timeout: 5_000 });

        // Kernel terminal echo is insufficient: the child's response proves the
        // re-bound socket reaches the running child after discovery repair.
        await rawInject(sock, 'post-heal\n');
        await vi.waitFor(() => expect(captured()).toContain('ECHO:post-heal'), { timeout: 5_000 });

        await rawInject(sock, 'QUIT\n');
        const code = await done;
        expect(code).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        signalSource.emit('SIGTERM');
        await done;
      }
    },
    20_000,
  );

  it(
    "exit cleanup leaves a SUCCESSOR's registration alone (no unlink of a key that is no longer ours)",
    async () => {
      const ownerId = `su-successor-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      // Default (15s) persist tick: no self-heal fires within this short test,
      // so the simulated successor registration below stays in place.
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(400);
      const mine = JSON.parse(readFileSync(meta, 'utf8'));
      expect(mine.pid).toBe(process.pid);

      // A successor host took over the key: the json now records ITS pid.
      writeFileSync(meta, JSON.stringify({ ...mine, pid: 999_999_999 }));

      // Our host exits → pre-WI-3455 this unlinked json+sock unconditionally,
      // stranding the successor. Now it must leave the key untouched.
      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(existsSync(meta)).toBe(true);
      expect(existsSync(sock)).toBe(true);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(999_999_999);

      // hygiene
      unlinkSync(meta);
      unlinkSync(sock);
    },
    20_000,
  );

  it(
    'stands down while a LIVE psu-marked process owns the key, then reclaims it after that process dies',
    async () => {
      const ownerId = `su-standdown-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      // A decoy whose cmdline carries the psu marker (argv is part of
      // /proc/<pid>/cmdline), standing in for a genuinely live duplicate host.
      const decoy = spawn(execPath, ['-e', 'setTimeout(()=>{},10000)', 'psu-launcher-decoy'], {
        stdio: 'ignore',
      });
      await sleep(200);

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        activityPersistMs: 150,
        onExit: () => {},
      });

      await sleep(400);
      const mine = JSON.parse(readFileSync(meta, 'utf8'));

      // The live decoy takes over the key → our host must STAND DOWN (no
      // re-assert flap war), even across several ticks.
      writeFileSync(meta, JSON.stringify({ ...mine, pid: decoy.pid }));
      await sleep(700);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(decoy.pid);

      // The decoy dies → the surviving host RECLAIMS the abandoned key.
      decoy.kill('SIGKILL');
      await sleep(900);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(process.pid);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

/**
 * WI-6638 — SHUTDOWN: a finished agent session closes its own terminal window.
 *
 * psu runs as `exec <psu …>` inside `gnome-terminal --wait`, so the host exiting IS
 * the tab closing. These are the end-to-end halves that unit tests cannot reach: the
 * accepted path must actually TEAR THE HOST DOWN, and — the assertion that matters —
 * the refused path must leave a human's session demonstrably ALIVE.
 *
 * Why this is not a reaper: measured 2026-08-03, `findIdleLiveSessions()` returns 0
 * for this whole cohort (every psu session classifies driveMode:'responsive' and is
 * excluded by the queen-fleet-authority-boundary ruling P-001/D-001), and behind that
 * `terminalWindowAlive()` reads 55 of 55 stale scopes as ALIVE — correctly, because
 * they are real shells under the live terminal app. Both protections stand untouched.
 */
describe('SHUTDOWN — a finished agent session exits and closes its own window (WI-6638)', () => {
  /** Like envelopeInject, but returns the host's JSON ack line (the verdict). */
  function injectForAck(
    sock: string,
    envelope: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let acked: Record<string, unknown> | null = null;
      const c = net.connect(sock, () => {
        c.write(JSON.stringify({ v: 1, ...envelope }));
        c.end();
      });
      // Boundary-safe accumulation: a multi-byte character split across two
      // 'data' events must not decode to replacement chars (WI-6728 guard).
      // Attached before our own listener, so `collected.text()` below already
      // includes the chunk that triggered this callback.
      const collected = createTextCollector(c);
      c.on('data', () => {
        const buf = collected.text();
        const nl = buf.indexOf('\n');
        if (nl === -1 || acked) return;
        try {
          acked = JSON.parse(buf.slice(0, nl));
        } catch {
          /* malformed — the close below still resolves */
        }
      });
      c.on('error', () => resolve(acked));
      c.on('close', () => resolve(acked));
    });
  }

  /** A child that would outlive the test unless something actually kills it. */
  const LONG_LIVED_CHILD =
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
    'setTimeout(()=>process.exit(0),60000);';

  it(
    'ACCEPTS an agent-launched, never-typed-into session: kills the child and tears the host down',
    async () => {
      const ownerId = `su-itest-shutdown-ok-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      let exitCode: number | null = null;
      // This fixture owns its child PGID, while its host shares the test run's
      // scope with Vitest and esbuild. Never sweep that scope on shutdown.
      const reapScopeResidue = vi.fn(() => ({ killedPids: [], failedPids: [] }));
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', LONG_LIVED_CHILD],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // The structural discriminator: injectLaunchedByArg stamps this onto every
          // tool-driven psu launch; an owner-typed `psu` never carries one.
          PAPERCUSP_LAUNCHED_BY: 'su-the-launching-agent',
        },
        ownerId,
        advSessionId: 6638,
        io,
        bridgeTty: false,
        reapScopeResidue,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      await sleep(500);
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      // Advertised so a would-be requester can see the verdict before sending.
      expect(m.caps).toContain('shutdown');
      expect(m.caps).toContain('shutdown-identity');
      // EI-27053660657887116: this host has no resolveRespawnNativeId (the Claude
      // shape), so it can never match a pending-carry fence identity and must not
      // advertise one; advertising it made every request-compaction a refusal.
      expect(m.caps).toContain('carry-respawn');
      expect(m.caps).not.toContain('pending-carry-fence-v1');
      expect(m.launchedBy).toBe('su-the-launching-agent');

      const staleAck = await injectForAck(sock, {
        mode: 'shutdown', data: 'stale confirmed stop', ownerId, expectedStartedAt: m.startedAt + 1,
      });
      expect(staleAck).toMatchObject({ ok: false, reason: 'shutdown-refused:stale-host' });
      expect(exitCode).toBeNull();
      expect(existsSync(sock)).toBe(true);

      const startedAt = Date.now();
      const ack = await injectForAck(sock, {
        mode: 'shutdown',
        data: 'fleet wound down',
        ownerId,
        expectedStartedAt: m.startedAt,
      });
      // The ACK must arrive BEFORE the teardown races the socket away — otherwise a
      // successful shutdown reads to the caller as a transport miss and gets retried.
      expect(ack).toMatchObject({ ok: true, reason: 'shutdown-accepted' });

      const code = await done;
      // The child's own timeout is 60s: finishing at all proves the shutdown killed it.
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(typeof code).toBe('number');
      expect(exitCode).not.toBeNull();
      expect(reapScopeResidue).not.toHaveBeenCalled();
      // The window is gone: same cleanup path as any other child exit.
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    40_000,
  );

  it(
    'REFUSES a session with no PAPERCUSP_LAUNCHED_BY and leaves it ALIVE — a hand-started window is the owner\'s',
    async () => {
      const ownerId = `su-itest-shutdown-refuse-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      // A hand-started psu carries no launcher provenance. Delete rather than blank
      // it, so a runner that happens to export one cannot mask the refusal.
      const env: NodeJS.ProcessEnv = {
        ...hermeticEnv(),
        PAPERCUSP_SID: ownerId,
        TERM: 'xterm-256color',
      };
      delete env.PAPERCUSP_LAUNCHED_BY;
      // A hand-started host is not bound to the fleet that runs this test process.
      // Clear inherited provenance so the headless-fleet ownership fallback cannot
      // classify this fixture as agent-owned.
      delete env.PAPERCUSP_FLEET_SLUG;

      const done = hostThroughPty({
        command: execPath,
        args: [
          '-e',
          "process.stdin.setEncoding('utf8');let b='';" +
            "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
            'setTimeout(()=>process.exit(0),8000);',
        ],
        cwd: '/tmp',
        env,
        ownerId,
        advSessionId: 6639,
        io,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await sleep(500);
        expect(existsSync(sock)).toBe(true);

        const ack = await injectForAck(sock, { mode: 'shutdown', data: 'go away', ownerId });
        expect(ack).toMatchObject({
          ok: false,
          reason: 'shutdown-refused:not-agent-launched',
        });

        // THE ASSERTION THIS TEST EXISTS FOR: the session is untouched. Wait past the
        // shutdown's own ack-delay + grace window, then prove the child still serves.
        await sleep(1200);
        expect(existsSync(sock)).toBe(true);
        await rawInject(sock, 'still-here\n');
        await sleep(500);
        expect(captured()).toContain('ECHO:still-here');

        // The refusal is recorded, so a puzzled operator can see WHY nothing closed.
        const events = readFileSync(eventLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        expect(events.find((e) => e.kind === 'shutdown-refused')).toMatchObject({
          reason: 'not-agent-launched',
        });
        expect(events.find((e) => e.kind === 'shutdown-accepted')).toBeUndefined();
      } finally {
        await done.catch(() => undefined);
      }
    },
    40_000,
  );
});
