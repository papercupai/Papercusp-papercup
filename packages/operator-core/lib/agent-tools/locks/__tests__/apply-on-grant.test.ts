/**
 * apply-on-grant.test.ts — EI-9033 apply-on-grant lock-queue edits.
 *
 * Two layers, both pure via injected seams (no DB / no real fs):
 *   • applyExactEdit — the Edit-tool exact-single-match contract over an
 *     in-memory FileIo (apply-success, no-match, non-unique, path-escape).
 *   • applyPendingEditOnGrant — the orchestration: claim latch → apply →
 *     audit + release + notify (apply-success / audit-row / notify-delivery),
 *     mismatch/non-unique/guardrail → fallback, and the exactly-once latch
 *     dispositions (in-flight / applied / none / fallback).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/__tests__/apply-on-grant.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyExactEdit,
  applyPendingEditOnGrant,
  type ApplyOnGrantDeps,
  type FileIo,
} from '../apply-on-grant';
import type { GrantedPendingEdit } from '../su-lock-store';
import { recordEditAttribution } from '../../../edit-attribution';

// Only the DEFAULT attribution recorder reaches this; every other case injects its own.
vi.mock('../../../edit-attribution', () => ({ recordEditAttribution: vi.fn(async () => {}) }));

const memIo = (files: Record<string, string>): FileIo & { files: Record<string, string> } => ({
  files,
  read(p: string) {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  },
  write(p: string, c: string) {
    files[p] = c;
  },
});

describe('applyExactEdit (exact single-match contract)', () => {
  const ROOT = '/repo';

  it('applies a unique match and writes the replaced content', () => {
    const io = memIo({ '/repo/boot.ts': 'a\nOLD\nb\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'OLD', new_string: 'NEW' }, io);
    expect(res.applied).toBe(true);
    expect(io.files['/repo/boot.ts']).toBe('a\nNEW\nb\n');
  });

  it('no match → not applied, file untouched', () => {
    const io = memIo({ '/repo/boot.ts': 'a\nb\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'ABSENT', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'no-match' });
    expect(io.files['/repo/boot.ts']).toBe('a\nb\n');
  });

  it('non-unique match → not applied (the region is ambiguous)', () => {
    const io = memIo({ '/repo/boot.ts': 'DUP\nx\nDUP\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'DUP', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'non-unique' });
    expect(io.files['/repo/boot.ts']).toBe('DUP\nx\nDUP\n');
  });

  it('empty old_string → no-match (never applies)', () => {
    const io = memIo({ '/repo/boot.ts': 'x' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: '', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'no-match' });
  });

  it('path escaping the repo root → path-escape, never reads', () => {
    const io = memIo({ '/etc/passwd': 'secret' });
    const readSpy = vi.spyOn(io, 'read');
    const res = applyExactEdit(ROOT, { file: '../etc/passwd', old_string: 'secret', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'path-escape' });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('read error → read-error, no write', () => {
    const io = memIo({});
    const res = applyExactEdit(ROOT, { file: 'missing.ts', old_string: 'x', new_string: 'y' }, io);
    expect(res).toEqual({ applied: false, reason: 'read-error' });
  });
});

// ── orchestration ────────────────────────────────────────────────────────────

const grant = (over: Partial<GrantedPendingEdit> = {}): GrantedPendingEdit => ({
  ticket_id: 't-1',
  pending_edit: { file: 'boot.ts', old_string: 'OLD', new_string: 'NEW', goal_ref: 'WI-queue-time' },
  granted_lock_id: 'lock-1',
  coordination_domain: '/repo',
  owner: 'su-queuer',
  owner_label: 'queuer',
  intent: 'wire the new tool',
  paths: ['boot.ts'],
  ...over,
});

/** A deps bundle whose side effects are all recorded, defaulting to a clean apply. */
const spyDeps = (over: Partial<ApplyOnGrantDeps> = {}) => {
  const calls = {
    recordAttribution: vi.fn(async () => {}),
    releaseLock: vi.fn(async () => {}),
    setOutcome: vi.fn(async () => {}),
    cancelWakeAwaits: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  const deps: ApplyOnGrantDeps = {
    claim: async () => grant(),
    readDisposition: async () => 'none',
    applyEdit: () => ({ applied: true }),
    ...calls,
    ...over,
  };
  return { deps, calls };
};

describe('applyPendingEditOnGrant (orchestration)', () => {
  it('apply-success: applies, audits, releases the lock, cancels the wake, notifies — returns applied', async () => {
    const { deps, calls } = spyDeps();
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('applied');
    // audit-row: attributed to the queuing agent, its file + intent
    expect(calls.recordAttribution).toHaveBeenCalledWith({
      repoRoot: '/repo',
      file: 'boot.ts',
      owner: 'su-queuer',
      workspaceId: 'ws',
      intent: 'wire the new tool',
      goalRef: 'WI-queue-time',
    });
    // lock released (edit done — don't strand the next waiter behind us)
    expect(calls.releaseLock).toHaveBeenCalledOnce();
    // wake suppressed, then passive notify
    expect(calls.cancelWakeAwaits).toHaveBeenCalledWith('t-1', 'su-queuer');
    // notify-delivery: passive inbox note to the queuing agent
    expect(calls.notify).toHaveBeenCalledWith({
      owner: 'su-queuer',
      workspaceId: 'ws',
      file: 'boot.ts',
      lockId: 'lock-1',
    });
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'applied');
  });

  it('R-5: the default recorder stamps the granted agent’s coord session on the ledger row', async () => {
    const { deps } = spyDeps();
    const { recordAttribution: _injected, ...withDefaultRecorder } = deps;
    await applyPendingEditOnGrant('t-1', 'ws', withDefaultRecorder);
    expect(recordEditAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['boot.ts'], agentId: 'su-queuer', sessionId: 'su-queuer' }),
    );
  });

  it('mismatch-fallback: old_string no longer matches → fallback, NO apply side effects', async () => {
    const { deps, calls } = spyDeps({ applyEdit: () => ({ applied: false, reason: 'no-match' }) });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.recordAttribution).not.toHaveBeenCalled();
    expect(calls.releaseLock).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.cancelWakeAwaits).not.toHaveBeenCalled();
  });

  it('non-unique-fallback: the region became ambiguous → fallback', async () => {
    const { deps, calls } = spyDeps({ applyEdit: () => ({ applied: false, reason: 'non-unique' }) });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it('guardrail: a multi-file or file≠path ticket never applies → fallback (applyEdit not called)', async () => {
    const applyEdit = vi.fn(() => ({ applied: true }));
    const { deps } = spyDeps({ claim: async () => grant({ paths: ['boot.ts', 'other.ts'] }), applyEdit });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('exactly-once: a reconcile that loses the claim latch reads the disposition instead of applying', async () => {
    // claim returns null (a peer won the latch); disposition drives the result.
    for (const [disp, expected] of [
      ['claiming', 'in-flight'],
      ['applied', 'applied'],
      ['fallback', 'fallback'],
      ['none', 'none'],
    ] as const) {
      const applyEdit = vi.fn(() => ({ applied: true }));
      const { deps } = spyDeps({ claim: async () => null, readDisposition: async () => disp, applyEdit });
      const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
      expect(out).toBe(expected);
      expect(applyEdit).not.toHaveBeenCalled(); // never double-applies
    }
  });

  it('best-effort: a failing side effect still returns applied (the edit is already on disk)', async () => {
    const { deps } = spyDeps({
      releaseLock: vi.fn(async () => {
        throw new Error('pg down');
      }),
      notify: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('applied');
  });
});
