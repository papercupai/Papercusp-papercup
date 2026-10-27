// @vitest-environment node
/**
 * EI-26957152622357153 / EI-27033376159376450 — an in-place RESET-CONTEXT `/clear`
 * rotates Claude's native session id inside the same child process. No respawn
 * path re-anchors adv_sessions to it, so the session's own turns read as foreign
 * (`superuser_foreign_native_session`, loop `lastLoopTurnAt: null`). The host now
 * resolves the rotated id from the reset carry turn's exact transcript marker and
 * hands it to the durable `onRespawn` report.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeNativeIdFromTranscriptRef,
  findNativeTranscriptMarker,
  reanchorAfterContextReset,
} from '../scripts/psu-pty-host.mjs';

const ROTATED = '2056a715-3c1e-4d0a-9b7e-0f1e2d3c4b5a';
const MARKER = '⟦turn-origin:loop-fire nonce:58b0fefe3380acc6⟧';

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('claudeNativeIdFromTranscriptRef', () => {
  it('reads the native id from a <uuid>.jsonl transcript path', () => {
    expect(claudeNativeIdFromTranscriptRef(`/cfg/projects/-repo/${ROTATED}.jsonl`)).toBe(ROTATED);
  });

  it.each([
    null, undefined, '', '/cfg/projects/-repo/agent-abc.jsonl', `/cfg/projects/-repo/${ROTATED}.json`,
    `/cfg/projects/-repo/x-${ROTATED}.jsonl`,
  ])('returns null for a path that does not name a session id (%s)', (ref) => {
    expect(claudeNativeIdFromTranscriptRef(ref as string)).toBeNull();
  });
});

describe('reanchorAfterContextReset', () => {
  const base = () => ({
    agent: 'claude', marker: MARKER, timeoutMs: 200, pollMs: 1,
    appendEvent: vi.fn(), onRespawn: vi.fn(async () => true),
  });

  it('reports the rotated id once the carry marker reaches a transcript', async () => {
    const opts = base();
    let polls = 0;
    const findNativeRef = vi.fn(() => (++polls < 3 ? null : `/cfg/projects/-repo/${ROTATED}.jsonl`));
    const result = await reanchorAfterContextReset({ ...opts, findNativeRef });
    expect(result).toMatchObject({ ok: true, nativeId: ROTATED, reason: 'reanchor-confirmed' });
    expect(opts.onRespawn).toHaveBeenCalledOnce();
    expect(opts.onRespawn).toHaveBeenCalledWith(ROTATED);
    expect(findNativeRef).toHaveBeenCalledTimes(3);
    expect(opts.appendEvent).toHaveBeenCalledWith('reset-reanchor-reported',
      expect.objectContaining({ nativeId: ROTATED, firstAttemptConfirmed: true }));
  });

  it('records a still-retrying durable report as reported, not confirmed', async () => {
    const opts = { ...base(), onRespawn: vi.fn(async () => false) };
    const result = await reanchorAfterContextReset({
      ...opts, findNativeRef: () => `/cfg/projects/-repo/${ROTATED}.jsonl`,
    });
    expect(result).toMatchObject({ ok: true, nativeId: ROTATED, reason: 'reanchor-retrying', firstAttemptConfirmed: false });
    expect(opts.onRespawn).toHaveBeenCalledWith(ROTATED);
  });

  it.each([
    ['codex', MARKER, 'unsupported-agent'],
    ['omp', MARKER, 'unsupported-agent'],
    ['claude', '', 'no-carry-marker'],
  ])('skips agent=%s marker=%j with reason %s and never reports', async (agent, marker, reason) => {
    const opts = base();
    const findNativeRef = vi.fn(() => `/cfg/projects/-repo/${ROTATED}.jsonl`);
    const result = await reanchorAfterContextReset({ ...opts, agent, marker, findNativeRef });
    expect(result).toMatchObject({ ok: false, nativeId: null, reason });
    expect(opts.onRespawn).not.toHaveBeenCalled();
    expect(findNativeRef).not.toHaveBeenCalled();
    expect(opts.appendEvent).toHaveBeenCalledWith('reset-reanchor-skipped', expect.objectContaining({ reason }));
  });

  it('gives up without reporting when no transcript carries the marker in time', async () => {
    const opts = base();
    const result = await reanchorAfterContextReset({ ...opts, timeoutMs: 20, findNativeRef: () => null });
    expect(result).toMatchObject({ ok: false, reason: 'native-ref-not-found' });
    expect(opts.onRespawn).not.toHaveBeenCalled();
    // A re-anchor that did not land is a failure signal, never a benign skip (WI-6554700010030030).
    expect(opts.appendEvent).toHaveBeenCalledWith('reset-reanchor-failed', expect.objectContaining({ reason: 'native-ref-not-found' }));
    expect(opts.appendEvent).not.toHaveBeenCalledWith('reset-reanchor-skipped', expect.anything());
  });

  it('refuses a marker hit whose file name is not a session id', async () => {
    const opts = base();
    const result = await reanchorAfterContextReset({ ...opts, findNativeRef: () => '/cfg/projects/-repo/notes.jsonl' });
    expect(result).toMatchObject({ ok: false, reason: 'native-id-unparseable' });
    expect(opts.onRespawn).not.toHaveBeenCalled();
    expect(opts.appendEvent).toHaveBeenCalledWith('reset-reanchor-failed', expect.objectContaining({ reason: 'native-id-unparseable' }));
  });

  it('stops for a superseded child, so a recycle owns its own report', async () => {
    const opts = base();
    let current = true;
    const result = await reanchorAfterContextReset({
      ...opts,
      isCurrent: () => current,
      findNativeRef: () => { current = false; return `/cfg/projects/-repo/${ROTATED}.jsonl`; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'superseded-child' });
    expect(opts.onRespawn).not.toHaveBeenCalled();
  });

  it('never rejects when the report throws or the finder throws', async () => {
    const opts = { ...base(), onRespawn: vi.fn(async () => { throw new Error('operator down'); }) };
    await expect(reanchorAfterContextReset({
      ...opts, findNativeRef: () => `/cfg/projects/-repo/${ROTATED}.jsonl`,
    })).resolves.toMatchObject({ ok: false, nativeId: ROTATED, reason: 'report-threw', detail: 'operator down' });
    await expect(reanchorAfterContextReset({
      ...base(), timeoutMs: 10, findNativeRef: () => { throw new Error('EACCES'); },
    })).resolves.toMatchObject({ ok: false, reason: 'native-ref-not-found' });
  });

  it('resolves the rotated id through the real marker finder, ignoring the pre-clear transcript', async () => {
    const claudeConfig = mkdtempSync(join(tmpdir(), 'reset-reanchor-'));
    scratchDirs.push(claudeConfig);
    const project = join(claudeConfig, 'projects', '-home-repo');
    mkdirSync(project, { recursive: true });
    const sinceMs = Date.now();
    const userRow = (content: string, atMs: number) => JSON.stringify({
      type: 'user', timestamp: new Date(atMs).toISOString(), message: { role: 'user', content },
    });
    // The pre-clear transcript holds an OLDER turn with a different nonce.
    writeFileSync(join(project, 'e74b6cbf-0000-4000-8000-000000000000.jsonl'),
      `${userRow('⟦turn-origin:loop-fire nonce:aaaaaaaaaaaaaaaa⟧\nOlder fire.', sinceMs - 60_000)}\n`);
    writeFileSync(join(project, `${ROTATED}.jsonl`), `${userRow(`${MARKER}\nCarry note.`, sinceMs + 50)}\n`);
    const onRespawn = vi.fn(async () => true);
    const result = await reanchorAfterContextReset({
      agent: 'claude', marker: MARKER, onRespawn, timeoutMs: 500, pollMs: 5,
      findNativeRef: () => findNativeTranscriptMarker({
        agent: 'claude', env: { CLAUDE_CONFIG_DIR: claudeConfig }, marker: MARKER, sinceMs,
      }),
    });
    expect(result).toMatchObject({ ok: true, nativeId: ROTATED });
    expect(onRespawn).toHaveBeenCalledWith(ROTATED);
  });
});

describe('psu-pty-host reset delivery wiring', () => {
  it('schedules the re-anchor on BOTH verified reset success paths', () => {
    const source = readFileSync(fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url)), 'utf8');
    const wired = source.match(/if \(msg\.mode === 'reset'\) scheduleResetReanchor\(marker, turnWriteStartedAt, (target|child)\);/g) ?? [];
    expect(wired).toHaveLength(2);
    expect(source).toContain('onRespawn: (nativeId) => onRespawn(nativeId),');
  });
});
