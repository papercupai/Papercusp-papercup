// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { eventLogPathForOwner, hostThroughPty, leadingTurnOriginMarker, metaPathFor, nativeTurnVerifierSupport, socketPathFor } from '../scripts/psu-pty-host.mjs';
import { injectIntoHostWithConfirmation } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const capacityError = 'Selected model is at capacity';
async function until(check: () => boolean, timeoutMs = 6_000, detail = () => '') {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(20);
  expect(check(), detail()).toBe(true);
}

let serial = 0;
async function fixture(agent: 'codex' | 'claude' | 'omp', error: string, requireNativeTurnStart = true,
  options: { acceptBeforeRecovery?: boolean; activityPersistMs?: number; env?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'provider-submit-'));
  const home = join(root, 'home');
  const nativeDir = agent === 'omp' ? join(home, 'agent', 'sessions')
    : join(home, agent === 'codex' ? 'sessions' : 'projects');
  mkdirSync(nativeDir, { recursive: true });
  const transcript = join(nativeDir, 'fixture.jsonl');
  const recovered = join(root, 'gateway-recovered');
  const ownerId = `submit-rx-${process.pid}-${++serial}`;
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  // A busy provider-error TUI can consume Enter while retaining the composer.
  // Recovery is independent of submission; only a later standalone Enter can
  // persist the exact native user row. Empty Enter never starts another turn.
  const childCode = `
    const fs = require('node:fs');
    const agent = ${JSON.stringify(agent)}, path = ${JSON.stringify(transcript)};
    let line = '', crs = 0;
    function append(row) { fs.appendFileSync(path, JSON.stringify({...row,
      timestamp: new Date().toISOString()})+'\\n'); }
    function accept() {
      append(agent === 'codex'
        ? {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}}
        : agent === 'claude' ? {type:'user',message:{role:'user',content:line}}
        : {type:'message',message:{role:'user',content:[{type:'text',text:line}]}});
      process.stdout.write('SUBMITTED:'+line+'\\n'); line = '';
    }
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { for (const c of data) {
      if (c === '\\x04') { process.exit(0); return; }
      if (c !== '\\r') { line += c; continue; }
      process.stdout.write('ENTER:'+ ++crs +'\\n');
      if (!fs.existsSync(${JSON.stringify(recovered)})) {
        if (${options.acceptBeforeRecovery === true} && line) accept();
        process.stdout.write(${JSON.stringify(error + '\n')}); continue;
      }
      if (!line) continue;
      accept();
      append(agent === 'codex'
        ? {type:'event_msg',payload:{type:'task_started'}}
        : agent === 'claude' ? {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'working'}]}}
        : {type:'message',message:{role:'assistant',content:[{type:'text',text:'working'}]}});
    }});
    process.stdout.write('READY\\n');
    setTimeout(()=>process.exit(0),20000);
  `;
  const env = hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: agent,
    ...(agent === 'codex' ? { CODEX_HOME: home } : agent === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { PI_CONFIG_DIR: home }),
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '10', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '100',
    PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10', PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
    PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '20',
    PAPERCUSP_PSU_PTY_OMP_SUBMIT_CR_MS: '10', PAPERCUSP_PSU_PTY_OMP_RESUBMIT_CR_MS: '20',
    PAPERCUSP_PSU_PTY_NATIVE_START_TIMEOUT_MS: '100',
    PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20', PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
    PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '60', PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
    ...options.env,
  });
  expect(nativeTurnVerifierSupport(agent, env), 'fixture must support native receipt verification').toMatchObject({ supported: true });
  const done = hostThroughPty({ command: process.execPath, args: ['-e', childCode],
    cwd: root, ownerId, env, io: { stdin, stdout }, bridgeTty: true,
    activityPersistMs: options.activityPersistMs ?? 25, onExit: () => {} });
  const sock = socketPathFor(ownerId);
  const rows = () => existsSync(eventLogPathForOwner(ownerId))
    ? readFileSync(eventLogPathForOwner(ownerId), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  await until(() => output.includes('READY') && existsSync(metaPathFor(ownerId)), 6_000,
    () => JSON.stringify({ phase: 'fixture-start', output, events: rows() }));
  const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  expect(Number.isInteger(meta.execution?.childGeneration), 'native generation preflight').toBe(true);
  const data = `⟦turn-origin:wake-pump nonce:${serial.toString(16).padStart(16, '0')}⟧\nresume the pending work`;
  expect(leadingTurnOriginMarker(data), 'native marker grammar preflight').toBe(data.split('\n')[0]);
  const envelope = { mode: 'turn' as const, ownerId, deliveryId: `delivery-${serial}`, data,
    ...(requireNativeTurnStart ? { requireNativeTurnStart: true,
      expectedHostStartedAt: meta.startedAt, expectedChildGeneration: meta.execution.childGeneration } : {}),
  };
  return { root, done, sock, rows, envelope, data, stdin, output: () => output, transcript,
    recover: () => writeFileSync(recovered, 'ready'),
    async close() {
      await injectIntoHostWithConfirmation(sock, { mode: 'raw', ownerId, data: '\x04' }).catch(() => {});
      await done;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('pending submission after provider recovery (EI-25878022553042846)', () => {
  it('isolates native transcript roots even when the launcher supplies OMP overrides', () => {
    const source = { PAPERCUSP_PSU_PTY_DIR: '/tmp/private-pty-fixture',
      PI_CONFIG_DIR: '/live/omp-config', PI_CODING_AGENT_DIR: '/live/omp-agent',
      CODEX_HOME: '/live/codex', CLAUDE_CONFIG_DIR: '/live/claude' };
    const env = hermeticEnv({ PI_CONFIG_DIR: '/tmp/private-omp-config' }, source);
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.PI_CONFIG_DIR).toBe('/tmp/private-omp-config');
    expect(env.CODEX_HOME).toBe('/tmp/private-pty-fixture/codex-home');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/private-pty-fixture/claude-home');
    expect(hermeticEnv({}, source).PI_CONFIG_DIR).toBeUndefined();
    expect(hermeticEnv({ PI_CODING_AGENT_DIR: '/tmp/private-omp-agent' }, source)
      .PI_CODING_AGENT_DIR).toBe('/tmp/private-omp-agent');
  });

  it.each([
    ['codex', 'You’ve hit your usage limit. Try again at Oct 17th, 2026 11:58 PM.', true],
    ['codex', 'unexpected status 502 Bad Gateway: inference-gateway: upstream TTFB exceeded 30000ms', true],
    ['codex', capacityError, true],
    ['claude', 'API Error: 429 You have reached your usage limit.', true],
    ['claude', 'API Error: 529 {"error":{"type":"overloaded_error"}}', true],
    ['codex', 'You’ve hit your usage limit.', false],
    ['claude', 'API Error: 502 Bad Gateway', false],
    ['omp', 'OpenAI API Error: 502 Bad Gateway', true],
    ['omp', 'Anthropic API Error: 529 overloaded_error', true],
  ] as const)('resumes the same staged %s message after %s (native-start=%s)', async (agent, error, nativeStart) => {
    const f = await fixture(agent, error, nativeStart);
    try {
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.rows().some(row => row.kind === (nativeStart ? 'native-turn-start-unverified' : 'submit-verify-unconfirmed')),
        6_000, () => JSON.stringify({ output: f.output(), events: f.rows() }));
      expect(existsSync(f.transcript)).toBe(false);
      // Retries of the durable delivery must keep one staged payload alive.
      // Deduplication is acceptance, not proof that a native turn started.
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({
        ok: true, reason: 'pending-delivery-id',
      });
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({
        ok: true, reason: 'pending-delivery-id',
      });
      if (error.startsWith('Selected model is at capacity')) {
        expect(f.rows()).toContainEqual(expect.objectContaining({
          kind: 'model-capacity-detected', retryable: true, retryAfterMs: 60_000,
        }));
      }
      await f.recover();
      // No human Enter and no new wake are needed after gateway recovery.
      await until(() => f.output().includes('SUBMITTED:'), 6_000,
        () => JSON.stringify({ output: f.output(), events: f.rows() }));
      expect(f.output().match(/SUBMITTED:/g)).toHaveLength(1);
      const rows = readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const user = rows.filter(row => agent === 'codex' ? row.payload?.role === 'user'
        : agent === 'claude' ? row.type === 'user' : row.message?.role === 'user');
      expect(user).toHaveLength(1);
      expect(agent === 'codex' ? user[0].payload.content[0].text : agent === 'claude'
        ? user[0].message.content : user[0].message.content[0].text).toBe(f.data);
      await until(() => f.rows().some(row => row.kind === 'native-turn-start-confirmed'), 6_000,
        () => JSON.stringify({ phase: 'native-start', output: f.output(), events: f.rows(), transcript: rows }));
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({ ok: true, reason: 'duplicate-delivery-id' });
      await delay(150);
      expect(f.output().match(/SUBMITTED:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 20_000);

  it.each([
    ['codex', 'API Error: 502 Bad Gateway'],
    ['claude', 'API Error: 502 Bad Gateway'],
    ['codex', capacityError],
  ] as const)('does not submit owner edits in the recovered %s composer after %s', async (agent, error) => {
    const f = await fixture(agent, error);
    try {
      await injectIntoHostWithConfirmation(f.sock, f.envelope);
      await until(() => f.rows().some(row => row.kind === 'native-turn-start-unverified'));
      f.stdin.emit('data', Buffer.from('my unfinished edit'));
      await f.recover();
      await delay(350);
      expect(f.output()).not.toContain('SUBMITTED:');
      expect(existsSync(f.transcript)).toBe(false);
    } finally { await f.close(); }
  }, 20_000);

  it.each([
    ['codex', 'API Error: 502 Bad Gateway'],
    ['claude', 'API Error: 502 Bad Gateway'],
    ['codex', capacityError],
  ] as const)('a recovered %s gateway still needs Enter when the recovery tick is held after %s', async (agent, error) => {
    const f = await fixture(agent, error, true, { activityPersistMs: 60_000 });
    try {
      await injectIntoHostWithConfirmation(f.sock, f.envelope);
      await until(() => f.rows().some(row => row.kind === 'native-turn-start-unverified'));
      f.recover();
      await delay(200);
      expect(f.output()).not.toContain('SUBMITTED:');
      // Distinguishes missing submission from an upstream that stayed broken:
      // the unchanged, recovered client accepts the original text on Enter.
      f.stdin.emit('data', Buffer.from('\r'));
      await until(() => f.output().includes('SUBMITTED:'));
      expect(f.output().match(/SUBMITTED:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 20_000);

  it.each(['codex', 'claude'] as const)('raw input revokes ownership of the pending %s composer', async agent => {
    const f = await fixture(agent, 'API Error: 502 Bad Gateway');
    try {
      await injectIntoHostWithConfirmation(f.sock, f.envelope);
      await until(() => f.rows().some(row => row.kind === 'native-turn-start-unverified'));
      await injectIntoHostWithConfirmation(f.sock, { mode: 'raw', ownerId: f.envelope.ownerId, data: 'external edit' });
      f.recover();
      await delay(350);
      expect(f.output()).not.toContain('SUBMITTED:');
      expect(f.rows()).toContainEqual(expect.objectContaining({
        kind: 'submit-verify-unconfirmed', reason: 'pending-composer-ownership-lost',
      }));
    } finally { await f.close(); }
  }, 20_000);

  // EI-25930229050142968: a composer that never accepts the Enter used to get
  // one recovery Enter every retry window forever (393 in one session), and the
  // live pending record deferred every later wake. The recovery must stop,
  // tombstone the delivery (no repaste), and let a different wake write again.
  it.each(['codex', 'claude'] as const)('retires an unconfirmable %s submission after the recovery budget so later wakes inject', async agent => {
    const f = await fixture(agent, 'API Error: 502 Bad Gateway', true,
      { env: { PAPERCUSP_PSU_PTY_SUBMIT_RECOVERY_MAX_CR: '2' } });
    try {
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.rows().some(row => row.kind === 'pending-submit-recovery-exhausted'), 6_000,
        () => JSON.stringify({ output: f.output(), events: f.rows() }));
      const recoveryEnters = f.rows().filter(row => row.kind === 'submit-verify-recovery-resubmit');
      expect(recoveryEnters).toHaveLength(2);
      expect(f.rows()).toContainEqual(expect.objectContaining({ kind: 'pending-submit-recovery-exhausted',
        deliveryId: f.envelope.deliveryId, retiredDeliveryIds: [f.envelope.deliveryId], reason: 'max-resubmits' }));
      const entersAtRetire = f.output().match(/ENTER:/g)?.length ?? 0;
      await delay(300);
      // Bounded: no further recovery Enter for the retired record.
      expect(f.output().match(/ENTER:/g)?.length ?? 0).toBe(entersAtRetire);
      // The durable retry of the retired delivery is refused, never repasted.
      expect(await injectIntoHostWithConfirmation(f.sock, f.envelope)).toMatchObject({
        ok: false, reason: 'deferred-native-turn-start-superseded',
      });
      expect(f.output()).not.toContain('SUBMITTED:');
      // A different wake is no longer deferred behind the retired record.
      const next = { ...f.envelope, deliveryId: `${f.envelope.deliveryId}-next`,
        data: `⟦turn-origin:wake-pump nonce:${'f'.repeat(16)}⟧\nnext wake` };
      expect(await injectIntoHostWithConfirmation(f.sock, next)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => (f.output().match(/ENTER:/g)?.length ?? 0) > entersAtRetire, 6_000,
        () => JSON.stringify({ phase: 'next-wake', output: f.output(), events: f.rows() }));
      expect(f.rows().some(row => row.kind === 'deferred-native-turn-start')).toBe(false);
    } finally { await f.close(); }
  }, 20_000);

  it.each([
    ['codex', 'API Error: 502 Bad Gateway'],
    ['claude', 'API Error: 502 Bad Gateway'],
    ['codex', capacityError],
  ] as const)('never retries Enter for an accepted %s message whose provider failed with %s', async (agent, error) => {
    const f = await fixture(agent, error, true, { acceptBeforeRecovery: true });
    try {
      await injectIntoHostWithConfirmation(f.sock, f.envelope);
      await until(() => f.output().includes('SUBMITTED:'));
      await delay(200);
      const enters = f.output().match(/ENTER:/g)?.length;
      f.recover();
      await delay(350);
      expect(f.output().match(/ENTER:/g)).toHaveLength(enters!);
      expect(f.output().match(/SUBMITTED:/g)).toHaveLength(1);
      expect(f.rows().some(row => row.kind === 'submit-verify-recovery-resubmit')).toBe(false);
    } finally { await f.close(); }
  }, 20_000);
});
