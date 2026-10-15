/**
 * WI-5071 — per-conversation claude brain session registry.
 *
 * The registry's whole contract is lifecycle: fresh mint → resume after a
 * recorded turn → invalidate on hash drift / caps / explicit invalidation.
 * The marker lives INSIDE the session dir (storage-policy exception: it
 * describes local-disk claude session state and must die with it), so the
 * tests point HOME at a tmpdir and exercise the real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeHome: string;

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => fakeHome };
});

// Import AFTER the mock so the module's homedir() resolves to the tmp HOME.
import {
  brainSessionReuseEligible,
  CHAT_BRAIN_SWEEP_GRACE_MS,
  getChatBrainSession,
  hashSystemPrompt,
  invalidateChatBrainSession,
  recordChatBrainTurn,
  sweepExpiredChatBrainSessions,
} from './converse-session';

const CONV = 'conv-abc-123';
const SYS = 'you are the operator persona v1';

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'converse-session-test-'));
});

afterEach(() => {
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// WI-10006465 — a caller under its own retention policy (phone calls, D-022's
// 30-day rule) must be able to keep its content out of the on-disk session
// store entirely: a one-off conversation's dir is never reclaimed, because a
// dir is only dropped when the SAME conversation takes another turn.
describe('brainSessionReuseEligible', () => {
  const claude = () => true;
  const notClaude = () => false;

  it('is eligible for a claude-code conversation when the caller does not opt out', () => {
    expect(brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: claude })).toBe(true);
    expect(
      brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: claude, retainSession: true }),
    ).toBe(true);
  });

  it('retainSession:false refuses reuse even on claude-code with a conversation', () => {
    expect(
      brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: claude, retainSession: false }),
    ).toBe(false);
  });

  it('is never eligible without a conversation or off claude-code', () => {
    expect(brainSessionReuseEligible({ conversationId: null, isClaudeCodeBackend: claude })).toBe(false);
    expect(brainSessionReuseEligible({ conversationId: '', isClaudeCodeBackend: claude })).toBe(false);
    expect(brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: notClaude })).toBe(false);
  });

  it('does not resolve the backend for a turn that cannot reuse (short-circuit order)', () => {
    const probe = vi.fn(() => true);
    brainSessionReuseEligible({ conversationId: null, isClaudeCodeBackend: probe });
    brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: probe, retainSession: false });
    expect(probe).not.toHaveBeenCalled();
    brainSessionReuseEligible({ conversationId: CONV, isClaudeCodeBackend: probe });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('an opted-out turn leaves no session dir behind', () => {
    // The caller contract: when ineligible, getChatBrainSession is never
    // called, so nothing for this conversation exists under chat-brains.
    const phoneConv = 'phone-call:room-xyz';
    if (brainSessionReuseEligible({ conversationId: phoneConv, isClaudeCodeBackend: claude, retainSession: false })) {
      getChatBrainSession(phoneConv, hashSystemPrompt(SYS));
    }
    expect(existsSync(join(fakeHome, '.papercusp', 'chat-brains'))).toBe(false);
  });
});

describe('getChatBrainSession', () => {
  it('mints a fresh session (resumed:false) on first sight and persists a marker', () => {
    const s = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    expect(s.resumed).toBe(false);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.dir.startsWith(join(fakeHome, '.papercusp', 'chat-brains'))).toBe(true);
    const marker = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
    expect(marker.sessionId).toBe(s.sessionId);
    expect(marker.turnCount).toBe(0);
  });

  it('does NOT resume until a turn was recorded (a never-completed session stays cold)', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    // No recordChatBrainTurn — the first turn never committed output.
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(false);
    // A fresh uuid: the dead session was discarded, not resurrected.
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('resumes (same uuid, same dir) after a recorded turn', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.dir).toBe(first.dir);
  });

  it('invalidates on system-prompt hash drift', () => {
    const first = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    recordChatBrainTurn(CONV);
    const second = getChatBrainSession(CONV, hashSystemPrompt(SYS + ' EDITED'));
    expect(second.resumed).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('keys different conversations to different dirs/sessions', () => {
    const h = hashSystemPrompt(SYS);
    const a = getChatBrainSession('conv-a', h);
    const b = getChatBrainSession('conv-b', h);
    expect(a.dir).not.toBe(b.dir);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('invalidateChatBrainSession', () => {
  it('drops the dir so the next turn cold-starts', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    invalidateChatBrainSession(CONV, 'test');
    expect(existsSync(first.dir)).toBe(false);
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe('recordChatBrainTurn', () => {
  it('increments turnCount on the marker', () => {
    const h = hashSystemPrompt(SYS);
    const s = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    recordChatBrainTurn(CONV);
    const marker = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
    expect(marker.turnCount).toBe(2);
  });

  it('is a no-op with no session on record', () => {
    expect(() => recordChatBrainTurn('never-seen-conv')).not.toThrow();
  });
});

// WI-10006551 — a conversation that never takes another turn used to keep its
// dir (verbatim history) forever; the hourly janitor now sweeps dirs past the
// session's own 24h reuse window plus a grace margin.
describe('sweepExpiredChatBrainSessions', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const root = () => join(fakeHome, '.papercusp', 'chat-brains');
  const ageMarker = (dir: string, createdAt: number) => {
    const m = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ ...m, createdAt, lastTurnAt: createdAt }), 'utf8');
  };

  it('removes an abandoned expired session and keeps a live one', () => {
    const h = hashSystemPrompt(SYS);
    const old = getChatBrainSession('conv-abandoned', h);
    recordChatBrainTurn('conv-abandoned');
    const live = getChatBrainSession('conv-live', h);
    recordChatBrainTurn('conv-live');
    const now = Date.now();
    ageMarker(old.dir, now - DAY - CHAT_BRAIN_SWEEP_GRACE_MS - 1000);

    const r = sweepExpiredChatBrainSessions({ now });

    expect(r.removed).toEqual([old.dir]);
    expect(r.kept).toBe(1);
    expect(r.scanned).toBe(2);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(live.dir)).toBe(true);
    // The live session is still resumable after the sweep.
    expect(getChatBrainSession('conv-live', h)).toMatchObject({ sessionId: live.sessionId, resumed: true });
  });

  it('keeps an expired session inside the grace margin (a turn may still be running in it)', () => {
    const s = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    const now = Date.now();
    ageMarker(s.dir, now - DAY - CHAT_BRAIN_SWEEP_GRACE_MS + 60_000);
    expect(sweepExpiredChatBrainSessions({ now }).removed).toEqual([]);
    expect(existsSync(s.dir)).toBe(true);
  });

  it('judges a markerless dir by its mtime', () => {
    const now = Date.now();
    const oldDir = join(root(), 'a'.repeat(24));
    const freshDir = join(root(), 'b'.repeat(24));
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    const oldSec = (now - 3 * DAY) / 1000;
    utimesSync(oldDir, oldSec, oldSec);

    const r = sweepExpiredChatBrainSessions({ now });

    expect(r.removed).toEqual([oldDir]);
    expect(existsSync(freshDir)).toBe(true);
  });

  it('never touches entries that are not session dirs', () => {
    const now = Date.now();
    const stranger = join(root(), 'not-a-session-dir');
    mkdirSync(stranger, { recursive: true });
    const strayFile = join(root(), 'c'.repeat(24));
    writeFileSync(strayFile, 'x', 'utf8');
    const oldSec = (now - 30 * DAY) / 1000;
    utimesSync(stranger, oldSec, oldSec);
    utimesSync(strayFile, oldSec, oldSec);

    const r = sweepExpiredChatBrainSessions({ now });

    expect(r).toMatchObject({ scanned: 0, removed: [], errors: [] });
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(strayFile)).toBe(true);
  });

  it('dryRun reports without removing, and a missing root is a no-op', () => {
    expect(sweepExpiredChatBrainSessions()).toMatchObject({ scanned: 0, removed: [] });
    const s = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    const now = Date.now();
    ageMarker(s.dir, now - 2 * DAY);
    const r = sweepExpiredChatBrainSessions({ now, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, removed: [s.dir] });
    expect(existsSync(s.dir)).toBe(true);
  });
});
