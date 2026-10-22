// @vitest-environment node
/**
 * Carry delivery authority regression (psu-recycle-carry-delivery-truth P-006).
 *
 * `PROBE_SCRIPT` deliberately redirects the WHOLE subject module to a copy
 * outside the checkout. That seam is load-bearing: it lets
 * `scripts/mutation-probe.sh` replace both native-proof failure branches with
 * parseable no-ops and prove this behavioral guard fails, without ever making
 * the tracked host script dirty in the git-sync shared tree.
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';

const subjectPath = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(__dirname, '../scripts/psu-pty-host.mjs');
const subject = (await import(/* @vite-ignore */ pathToFileURL(subjectPath).href)) as typeof import('../scripts/psu-pty-host.mjs');
const {
  encodeControl,
  carryNativeOwnerInputFreshness,
  eventLogPathForOwner,
  hostThroughPty,
  metaPathFor,
  socketPathFor,
  submitVerificationFailureReason,
} = subject;

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function fakeIo() {
  let output = '';
  return {
    captured: () => output,
    io: {
      stdout: {
        columns: 80,
        rows: 24,
        write: (data: Buffer | string) => {
          output += data.toString();
        },
        on() {},
        off() {},
      },
      stdin: {
        isTTY: false,
        on() {},
        off() {},
        resume() {},
        pause() {},
      },
    },
  };
}

function injectEnvelope(socketPath: string, envelope: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolveInject, reject) => {
    const connection = net.connect(socketPath, () => {
      connection.write(JSON.stringify({ v: 1, ...envelope }));
      connection.end();
    });
    // Boundary-safe accumulation: `response += chunk.toString()` decodes each
    // 'data' event independently, so a multi-byte UTF-8 character split across
    // two events becomes replacement chars with no error (WI-6728).
    const response = createTextCollector(connection);
    connection.on('error', reject);
    connection.on('close', () => {
      try { resolveInject(JSON.parse(response.text())); } catch (error) { reject(error); }
    });
  });
}

function injectRaw(socketPath: string, data: string): Promise<void> {
  return new Promise((resolveInject) => {
    const connection = net.connect(socketPath, () => {
      connection.write(encodeControl({ mode: 'raw', data }));
      connection.end();
    });
    connection.on('data', () => {});
    connection.on('error', () => resolveInject());
    connection.on('close', () => resolveInject());
  });
}

describe('carry-respawn native-turn delivery authority', () => {
  it.each([
    ['bare', '⟦turn-origin:self-compaction nonce:0011223344556677⟧\n' +
      'ADDRESSED TO su-foreign — continuation\nResume foreign work'],
    ['pasted-content wrapped', '<pasted_content id="dd8d">\n' +
      '⟦turn-origin:self-compaction nonce:0011223344556677⟧\n' +
      'ADDRESSED TO su-foreign — continuation\nResume foreign work\n' +
      '</pasted_content id="dd8d">\n'],
  ] as const)(
    'rejects a foreign content address in a %s even when the socket envelope names this host',
    async (_shape, data) => {
      const ownerId = `su-content-address-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      let mints = 0;
      const done = hostThroughPty({ command: execPath,
        args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('READY\\n');process.stdin.on('data',d=>{if(d.includes(4))process.exit(0);});setTimeout(()=>process.exit(0),4000);"],
        cwd: '/tmp', env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex' },
        ownerId, io, bridgeTty: false, onExit: () => {},
        mintCarryRespawnArgs: () => { mints++; return { args: ['-e', 'process.exit(0)'], nativeId: null }; },
      });
      try {
        const deadline = Date.now() + 2000;
        while (!captured().includes('READY') && Date.now() < deadline) await sleep(10);
        expect(captured()).toContain('READY');
        expect(await injectEnvelope(socketPathFor(ownerId), { mode: 'carry-respawn', ownerId,
          data,
          systemPromptAddendum: 'foreign carry',
        })).toMatchObject({ ok: false, reason: 'continuation-owner-mismatch' });
        expect(mints).toBe(0);
        expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8')).toContain('continuation-owner-mismatch');
        expect(captured()).not.toContain('Resume foreign work');
      } finally {
        if (existsSync(socketPathFor(ownerId))) await injectRaw(socketPathFor(ownerId), '\x04');
        await done;
        if (existsSync(eventLogPathForOwner(ownerId))) unlinkSync(eventLogPathForOwner(ownerId));
      }
    },
    10_000,
  );

  it('rejects a foreign pasted-content launch kickoff before writing it to the child', async () => {
    const ownerId = `su-launch-content-address-${process.pid}-${Math.floor(performance.now())}`;
    const eventLogPath = eventLogPathForOwner(ownerId);
    const socketPath = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const done = hostThroughPty({
      command: execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8');process.stdout.write('READY\\n');" +
          "process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));" +
          'setTimeout(()=>process.exit(0),5000);',
      ],
      cwd: '/tmp',
      env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex' },
      ownerId,
      io,
      bridgeTty: false,
      kickoff: '<pasted_content id="dd8d">\n' +
        '⟦turn-origin:self-compaction nonce:0011223344556677⟧\n' +
        'ADDRESSED TO su-foreign — continuation\nResume foreign work\n' +
        '</pasted_content id="dd8d">\n',
      onExit: () => {},
    });

    try {
      const eventDeadline = Date.now() + 2_000;
      let events: Array<Record<string, unknown>> = [];
      while (Date.now() < eventDeadline) {
        events = existsSync(eventLogPath)
          ? readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : [];
        if (events.some((event) => event.kind === 'launch-kickoff-rejected')) break;
        await sleep(10);
      }

      expect(events).toContainEqual(expect.objectContaining({
        kind: 'launch-kickoff-rejected',
        mode: 'launch-kickoff',
        expected: ownerId,
        got: 'su-foreign',
        reason: 'continuation-owner-mismatch',
      }));
      expect(captured()).not.toContain('Resume foreign work');
    } finally {
      if (existsSync(socketPath)) await injectRaw(socketPath, '\x04');
      await done;
      if (existsSync(eventLogPath)) unlinkSync(eventLogPath);
    }
  }, 10_000);

  it.each(['before-request', 'during-argv'] as const)(
    '%s: preserves an owner instruction accepted after the carry snapshot',
    async (arrival) => {
      const root = mkdtempSync(join(tmpdir(), 'carry-late-owner-'));
      const ownerId = `su-carry-late-${arrival}-${process.pid}-${Math.floor(performance.now())}`;
      const nativePath = join(root, 'sessions', '2026', '10', '08', 'rollout-owner.jsonl');
      mkdirSync(join(root, 'sessions', '2026', '10', '08'), { recursive: true });
      const snapshotAt = new Date(Date.now() - 1000).toISOString();
      const sourceRow = (text: string, timestamp: string) => JSON.stringify({ timestamp,
        type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      writeFileSync(nativePath, sourceRow('Original task', new Date(Date.now() - 2000).toISOString()) + '\n');
      const lateOwnerRow = sourceRow('Choose Workbench C and implement it yourself', new Date().toISOString()) + '\n';
      const { captured, io } = fakeIo();
      let mints = 0;
      const env = { ...hermeticEnv(), PAPERCUSP_AGENT: 'codex', CODEX_HOME: root, PAPERCUSP_SID: ownerId,
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '20', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '100' };
      const done = hostThroughPty({ command: execPath,
        args: ['-e', "process.stdout.write('OLD-READY\\n');process.stdin.on('data',d=>{if(d.includes(4))process.exit(0);});setTimeout(()=>process.exit(0),7000);"],
        cwd: root, env, ownerId, io, bridgeTty: false, onExit: () => {},
        mintCarryRespawnArgs: () => {
          mints += 1;
          if (arrival === 'during-argv') writeFileSync(nativePath, readFileSync(nativePath, 'utf8') + lateOwnerRow);
          return { args: ['-e', "process.stdout.write('FRESH-BOOT\\n');setTimeout(()=>process.exit(0),1000);"], nativeId: null };
        },
      });
      try {
        const readyDeadline = Date.now() + 2000;
        while (!captured().includes('OLD-READY') && Date.now() < readyDeadline) await sleep(10);
        expect(captured()).toContain('OLD-READY');
        if (arrival === 'before-request') writeFileSync(nativePath, readFileSync(nativePath, 'utf8') + lateOwnerRow);
        expect(await injectEnvelope(socketPathFor(ownerId), { mode: 'carry-respawn', ownerId,
          data: '⟦turn-origin:self-compaction nonce:0011223344556677⟧\nContinue saved work',
          systemPromptAddendum: `Carry document built at ${snapshotAt} — snapshot`, sourceTranscriptPath: nativePath,
        })).toMatchObject({ ok: true });
        const deadline = Date.now() + 2500;
        let events = '';
        while (Date.now() < deadline) {
          events = existsSync(eventLogPathForOwner(ownerId)) ? readFileSync(eventLogPathForOwner(ownerId), 'utf8') : '';
          if (events.includes('owner-input-after-carry-snapshot')) break;
          await sleep(10);
        }
        expect(events).toContain('owner-input-after-carry-snapshot');
        expect(events).not.toContain('respawn-predecessor-stop-started');
        expect(events).not.toContain('respawn-carry-delivered');
        expect(captured()).not.toContain('FRESH-BOOT');
        expect(mints).toBe(1);
        expect(carryNativeOwnerInputFreshness({ agent: 'codex', env, transcriptPath: nativePath,
          systemPromptAddendum: `Carry document built at ${new Date(Date.now() + 1).toISOString()} — refreshed`,
        })).toMatchObject({ status: 'current' });
      } finally {
        if (existsSync(socketPathFor(ownerId))) await injectRaw(socketPathFor(ownerId), '\x04');
        await done;
        if (existsSync(eventLogPathForOwner(ownerId))) unlinkSync(eventLogPathForOwner(ownerId));
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000,
  );

  it('distinguishes tagged machine turns, incomplete evidence, and an owner turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'carry-input-evidence-'));
    const path = join(root, 'sessions', 'rollout.jsonl');
    mkdirSync(join(root, 'sessions'));
    const env = { CODEX_HOME: root };
    const systemPromptAddendum = 'Carry document built at 2026-10-08T15:11:40.503Z — snapshot';
    const row = (text: string) => JSON.stringify({ timestamp: '2026-10-08T15:11:41.382Z',
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const read = () => carryNativeOwnerInputFreshness({ agent: 'codex', env, transcriptPath: path, systemPromptAddendum });
    try {
      writeFileSync(path, row('⟦turn-origin:loop nonce:0011223344556677⟧\nResume') + '\n');
      expect(read()).toMatchObject({ status: 'current' });
      writeFileSync(path, row('I like C best'));
      expect(read()).toMatchObject({ status: 'unverifiable', reason: 'native-input-read-incomplete' });
      writeFileSync(path, row('I like C best') + '\n');
      expect(read()).toMatchObject({ status: 'superseded', latestOwnerInputAtMs: Date.parse('2026-10-08T15:11:41.382Z') });
      expect(carryNativeOwnerInputFreshness({ agent: 'codex', env, transcriptPath: join(root, '..', 'outside.jsonl'), systemPromptAddendum }))
        .toMatchObject({ status: 'unverifiable' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['direct', 'rearmed'] as const)(
    '%s: a failed carry remains retryable under its exact delivery id',
    async (route) => {
      const ownerId = `su-carry-id-${route}-${process.pid}-${Math.floor(performance.now())}`;
      const socketPath = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode = [
        "process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.includes(4))process.exit(0);});",
        "process.stdout.write('READY\\n');",
        route === 'rearmed'
          ? "const busy=setInterval(()=>process.stdout.write('.'),10);setTimeout(()=>clearInterval(busy),400);"
          : '',
        'setTimeout(()=>process.exit(0),5000);',
      ].join('');
      let mints = 0;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '70',
          PAPERCUSP_PSU_PTY_REARM_CAP_MS: '70',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintCarryRespawnArgs: () => { mints += 1; throw new Error('test carry argv unavailable'); },
        onExit: () => {},
      });
      try {
        const readyDeadline = Date.now() + 2000;
        while (!captured().includes('READY') && Date.now() < readyDeadline) await sleep(10);
        expect(captured()).toContain('READY');
        const envelope = {
          mode: 'carry-respawn',
          ownerId,
          deliveryId: `carry-failed-${route}`,
          data: 'resume the saved work',
          systemPromptAddendum: 'saved state',
        };
        expect(await injectEnvelope(socketPath, envelope)).toMatchObject({ ok: true, reason: 'accepted' });
        const failedDeadline = Date.now() + 2500;
        while (mints === 0 && Date.now() < failedDeadline) await sleep(10);
        expect(mints).toBe(1);
        const events = readFileSync(eventLog, 'utf8');
        expect(events).toContain('"reason":"argv-build-failed"');
        if (route === 'rearmed') expect(events).toContain('"kind":"respawn-rearm-queued"');
        // Wait for the asynchronous re-arm to reach its terminal outcome, then
        // retry the SAME id. A pending retry must remain deduped; a terminal
        // failure must clear the id so the durable sender can try again.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await injectEnvelope(socketPath, envelope)).toMatchObject({ ok: true, reason: 'accepted' });
        const retryDeadline = Date.now() + 1000;
        while (mints < 2 && Date.now() < retryDeadline) await sleep(10);
        expect(mints).toBe(2);
      } finally {
        if (existsSync(socketPath)) await injectRaw(socketPath, '\x04');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    10_000,
  );

  it('keeps every non-success submit-verifier verdict distinguishable from delivery', () => {
    expect(submitVerificationFailureReason({ exhausted: true, aborted: null })).toBe(
      'submit-verification-exhausted',
    );
    expect(submitVerificationFailureReason({ exhausted: false, aborted: 'human-input' })).toBe(
      'submit-verification-aborted-human-input',
    );
    expect(submitVerificationFailureReason({ exhausted: false, aborted: null })).toBeNull();
  });

  it(
    'records a terminal drop when adopted carry startup cannot prove its native turn',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-adopted-carry-drop-'));
      const claudeConfig = join(root, 'claude');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      const ownerId = `su-adopted-carry-drop-${process.pid}-${Math.floor(performance.now())}`;
      const socketPath = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const nativeId = '12345678-1234-4234-8234-123456789abd';
      const marker = '⟦turn-origin:self-compaction nonce:0011223344556677⟧';
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');" +
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.on('data',data=>{if(data.includes('\\u0004'))process.exit(0);process.stdout.write('PAINT\\n');});" +
        'setTimeout(()=>process.exit(0),10_000);';
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          CLAUDE_CONFIG_DIR: claudeConfig,
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '1',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff: `${marker}\nContinue the saved work`,
        adoptedCarryRespawn: { nativeId },
        nativePersistenceTimeoutMs: 200,
        onRespawn: async () => true,
        onExit: () => {},
      });

      try {
        const bootDeadline = Date.now() + 2_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        const proofDeadline = Date.now() + 3_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < proofDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
          }
          if (events.some((event) => event.kind === 'launch-kickoff-turn-start-unverified')) break;
          await sleep(20);
        }

        expect(captured()).toContain('PAINT');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'launch-kickoff-turn-start-unverified',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          mode: 'carry-respawn',
          nativeId,
          adopted: true,
          turnStartVerified: false,
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-delivered',
          adopted: true,
        }));
      } finally {
        if (existsSync(socketPath)) await injectRaw(socketPath, '\x04');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it(
    'never books delivered when the marker appears only in another native session',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-carry-delivery-guard-'));
      const claudeConfig = join(root, 'claude');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      const unrelatedTranscript = join(claudeConfig, 'projects', '-tmp', 'unrelated-session.jsonl');

      const phase = process.env.PAPERCUSP_MUTATION_PHASE ?? 'ordinary';
      const ownerId = `su-carry-delivery-guard-${phase}-${process.pid}-${Math.floor(performance.now())}`;
      const socketPath = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const nativeId = '12345678-1234-4234-8234-123456789abc';
      const marker = '⟦turn-origin:self-compaction nonce:0011223344556677⟧';
      const { captured, io } = fakeIo();

      // Generic PTY activity is intentionally healthy-looking: every input
      // repaints the child. The backend never writes a native transcript, so
      // only the authoritative native-session proof can reject delivery.
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
          CLAUDE_CONFIG_DIR: claudeConfig,
          PAPERCUSP_PSU_HEADLESS: '0',
          // Reach native delivery proof without an unrelated SU /mcp dialog.
          PAPERCUSP_ROLE: 'researcher',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
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
        mintCarryRespawnArgs: (args: string[]) => ({
          args,
          nativeId,
          launchContextPath: '/tmp/carry.md',
        }),
        // Native binding is a separate precondition from native turn proof.
        // This fixture reaches the latter with a confirmed fake reanchor.
        onRespawn: async () => true,
        onExit: () => {},
      });

      try {
        const bootDeadline = Date.now() + 2_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await injectEnvelope(socketPath, {
          mode: 'carry-respawn',
          data: `${marker}\nContinue where you left off`,
          systemPromptAddendum: 'deterministic carry',
        });

        const terminalDeadline = Date.now() + 5_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < terminalDeadline) {
          // The generic submit verifier may see this matching marker in an
          // unrelated native session. Only the later carry-respawn check has
          // the minted native id and must reject that false binding.
          if (captured().includes('PAINT')) {
            writeFileSync(unrelatedTranscript, JSON.stringify({
              type: 'user',
              timestamp: new Date().toISOString(),
              message: { role: 'user', content: `${marker}\nContinue where you left off` },
            }) + '\n');
          }
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (events.some((event) =>
              event.kind === 'respawn-carry-dropped' || event.kind === 'respawn-carry-delivered')) {
              break;
            }
          }
          await sleep(20);
        }

        expect(captured()).toContain('PAINT');
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-binding-confirmed',
          nativeId,
        }));
        // The first retry is the verifier's raw CR retry. If that still cannot
        // prove a native turn, production carry policy deliberately cuts one
        // fresh epoch and verifies again; that second epoch has its own
        // verifier retry. Both are expected and neither is delivery proof.
        expect(
          events.filter((event) => event.kind === 'respawn-carry-turn-start-retry'),
          `observed events: ${JSON.stringify(events)}`,
        ).toHaveLength(2);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-start-unverified',
          nativeId,
          detail: 'native-turn-marker-timeout',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          nativeId,
          reason: 'turn-start-unverified',
          turnStartVerified: false,
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-delivered',
          nativeId,
        }));
      } finally {
        if (existsSync(socketPath)) await injectRaw(socketPath, 'QUIT\n');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'records verifier exhaustion and missing native proof without ending the recycled child or claiming delivery',
    async () => {
      const ownerId = `su-carry-verifier-drop-${process.pid}-${Math.floor(performance.now())}`;
      const socketPath = socketPathFor(ownerId);
      const metaPath = metaPathFor(ownerId);
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
        onExit: (code: number) => {
          exitCode = code;
        },
      });

      try {
        const bootDeadline = Date.now() + 3_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await injectEnvelope(socketPath, { mode: 'recycle', data: 'CARRIED' });
        const outcomeDeadline = Date.now() + 5_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < outcomeDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (events.some((event) => event.kind === 'respawn-carry-dropped')) break;
          }
          await sleep(20);
        }

        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(2);
        // Raw recycle controls now gain a host-owned carry marker. Submitted
        // bytes therefore defer to native proof instead of killing the host.
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'control-carry-origin-stamped', mode: 'recycle', origin: 'host-control',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'startup-turn-dropped', reason: 'submit-verification-exhausted',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-start-unverified', detail: 'missing-native-id',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          reason: 'turn-start-unverified',
          attempts: 1,
          outputSeen: true,
          turnStartVerified: false,
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-delivered',
        }));
        expect(existsSync(socketPath)).toBe(true);
        expect(JSON.parse(readFileSync(metaPath, 'utf8')).carryDropCount).toBe(1);
        await injectRaw(socketPath, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(socketPath)).toBe(false);
        expect(existsSync(metaPath)).toBe(false);
      } finally {
        if (existsSync(socketPath)) await injectRaw(socketPath, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    20_000,
  );
});
