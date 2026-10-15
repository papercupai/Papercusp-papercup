// @vitest-environment node
/**
 * psu-process-free-parking-2026-10-06 P-015 / P-016: the pure halves of
 * process-free parking — the resume argv mint and the park policy (with its
 * /proc descendant counter). The host wiring that calls them (P-017) is covered
 * by psu-park.integration.test.ts against a real pty.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mintParkResumeArgs } from '../scripts/psu-launcher.mjs';
import {
  DEFAULT_PARK_IDLE_MS,
  countProcessDescendants,
  newestSessionTranscriptId,
  parkIdleMsFromEnv,
  parkVerdict,
} from '../scripts/psu-pty-host.mjs';

const SID = '11111111-2222-4333-8444-555555555555';

describe('mintParkResumeArgs (P-015)', () => {
  it('rewrites the live --session-id to --resume of the SAME id and keeps every other flag verbatim', () => {
    const live = ['--settings', '{"a":1}', '--system-prompt-file', '/tmp/persona.md', '--session-id', SID, '--model', 'opus'];
    const minted = mintParkResumeArgs(live, { agent: 'claude' });
    expect(minted).toEqual({
      nativeId: SID,
      args: ['--settings', '{"a":1}', '--system-prompt-file', '/tmp/persona.md', '--model', 'opus', '--resume', SID],
    });
    // The persona path is NOT re-rendered: a different system prompt would miss the prompt cache (D-018).
    expect(minted?.args).toContain('/tmp/persona.md');
  });

  it('is idempotent across repeated parks: a resumed child parks back onto the same id', () => {
    const first = mintParkResumeArgs(['--session-id', SID], { agent: 'claude' });
    const second = mintParkResumeArgs(first!.args, { agent: 'claude' });
    expect(second).toEqual(first);
    expect(second!.args.filter((a) => a === '--resume')).toHaveLength(1);
  });

  it('accepts inline --session-id= / --resume= forms', () => {
    expect(mintParkResumeArgs([`--session-id=${SID}`], { agent: 'claude' })?.args).toEqual(['--resume', SID]);
    expect(mintParkResumeArgs([`--resume=${SID}`, '--verbose'], { agent: 'claude' })?.args).toEqual(['--verbose', '--resume', SID]);
  });

  it('drops --continue / --fork-session (a fork would rotate the id the next park needs)', () => {
    const minted = mintParkResumeArgs(['--resume', SID, '--fork-session', '--continue'], { agent: 'claude' });
    expect(minted?.args).toEqual(['--resume', SID]);
  });

  it('strips a tagged kickoff positional so the resumed child does not re-run the launch prompt', () => {
    const kickoff = '⟦turn-origin:fleet-kickoff nonce:abcdef0123⟧ start on the plan';
    const minted = mintParkResumeArgs(['--model=opus', '--session-id', SID, kickoff], { agent: 'claude' });
    expect(minted?.args).not.toContain(kickoff);
    expect(minted?.args).toEqual(['--model=opus', '--resume', SID]);
  });

  it('returns null for Codex (D-025) and for any argv without a session id', () => {
    expect(mintParkResumeArgs(['--session-id', SID], { agent: 'codex' })).toBeNull();
    expect(mintParkResumeArgs(['--session-id', SID], {})).toBeNull();
    expect(mintParkResumeArgs(['--model', 'opus'], { agent: 'claude' })).toBeNull();
    // A flag where the id should be is not an id.
    expect(mintParkResumeArgs(['--session-id', '--model', 'opus'], { agent: 'claude' })).toBeNull();
  });

  it('resumes the overriding id (the newest transcript after an in-TUI /clear) instead of the argv id', () => {
    const OTHER = '99999999-2222-4333-8444-555555555555';
    const minted = mintParkResumeArgs(['--model', 'opus', '--session-id', SID], { agent: 'claude', nativeId: OTHER });
    expect(minted).toEqual({ nativeId: OTHER, args: ['--model', 'opus', '--resume', OTHER] });
    // A malformed override is ignored rather than spliced into argv.
    expect(mintParkResumeArgs(['--session-id', SID], { agent: 'claude', nativeId: '--evil flag' })?.nativeId).toBe(SID);
    // The override cannot make a non-Claude child parkable.
    expect(mintParkResumeArgs(['--session-id', SID], { agent: 'codex', nativeId: OTHER })).toBeNull();
  });
});

describe('newestSessionTranscriptId (P-017)', () => {
  const OWNER = 'su-aaaa1111';
  const dir = `/home/x/.papercusp/session-claude/${OWNER}`;
  const fakeFs = (tree: Record<string, Record<string, number | 'dir'>>) => ({
    readdir: (p: string) => {
      if (p === `${dir}/projects`) return Object.keys(tree);
      const proj = p.slice(`${dir}/projects/`.length);
      if (tree[proj]) return Object.keys(tree[proj]);
      throw new Error(`ENOENT ${p}`);
    },
    stat: (p: string) => {
      const rest = p.slice(`${dir}/projects/`.length);
      const [proj, file] = rest.split('/');
      const v = tree[proj]?.[file];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return { mtimeMs: v === 'dir' ? 0 : v, isFile: () => v !== 'dir' };
    },
  });

  it('returns the newest top-level transcript id, ignoring subagent dirs and non-jsonl files', () => {
    const fs = fakeFs({
      '-home-x-repo': { 'old.jsonl': 100, 'new.jsonl': 300, 'new': 'dir', 'notes.txt': 999 },
      '-home-x-other': { 'mid.jsonl': 200 },
    });
    expect(newestSessionTranscriptId(dir, { ownerId: OWNER, ...fs })).toEqual({ id: 'new', mtimeMs: 300 });
  });

  it('refuses a config dir that is not this session\'s isolation dir, and an unreadable one', () => {
    const fs = fakeFs({ p: { 'a.jsonl': 1 } });
    // A shared dir can hold another session's newer transcript.
    expect(newestSessionTranscriptId(dir, { ownerId: 'su-someone-else', ...fs })).toBeNull();
    expect(newestSessionTranscriptId(null, { ownerId: OWNER, ...fs })).toBeNull();
    expect(newestSessionTranscriptId('/nope', { ownerId: 'nope', readdir: () => { throw new Error('ENOENT'); } })).toBeNull();
  });
});

describe('parkIdleMsFromEnv (P-016)', () => {
  it('ships ON at 15 minutes and treats an explicit 0 as the kill-switch', () => {
    expect(DEFAULT_PARK_IDLE_MS).toBe(900_000);
    expect(parkIdleMsFromEnv({})).toBe(DEFAULT_PARK_IDLE_MS);
    expect(parkIdleMsFromEnv({ PAPERCUSP_PSU_PARK_IDLE_MS: '' })).toBe(DEFAULT_PARK_IDLE_MS);
    expect(parkIdleMsFromEnv({ PAPERCUSP_PSU_PARK_IDLE_MS: '0' })).toBe(0);
    expect(parkIdleMsFromEnv({ PAPERCUSP_PSU_PARK_IDLE_MS: '2500' })).toBe(2500);
    expect(parkIdleMsFromEnv({ PAPERCUSP_PSU_PARK_IDLE_MS: 'soon' })).toBe(DEFAULT_PARK_IDLE_MS);
    expect(parkIdleMsFromEnv({ PAPERCUSP_PSU_PARK_IDLE_MS: '-5' })).toBe(DEFAULT_PARK_IDLE_MS);
  });
});

describe('parkVerdict (P-016)', () => {
  const base = {
    idleMs: 1000,
    agent: 'claude',
    now: 10_000,
    lastActivityAt: 1_000,
    childPromptReady: true,
    descendants: () => 0,
  };

  it('parks an idle, prompt-ready, descendant-free Claude child', () => {
    expect(parkVerdict(base)).toEqual({ park: true, reason: 'idle', idleForMs: 9_000, descendants: 0 });
  });

  it.each([
    [{ idleMs: 0 }, 'disabled'],
    [{ agent: 'codex' }, 'agent-not-parkable'],
    [{ parked: true }, 'already-parked'],
    [{ busy: true }, 'busy'],
    // D-005: a quota-walled TUI may hold an auto-continue that a SIGKILL would drop.
    [{ quotaBlocked: true }, 'quota-wait'],
    [{ resumable: false }, 'no-resumable-session-id'],
    [{ childPromptReady: false }, 'prompt-not-ready'],
    [{ composerPending: true }, 'composer-pending'],
    [{ lastActivityAt: 9_500 }, 'not-idle-long-enough'],
    [{ descendants: () => null }, 'descendants-unknown'],
    [{ descendants: () => 2 }, 'child-has-descendants'],
  ])('refuses %o with reason %s', (patch, reason) => {
    const verdict = parkVerdict({ ...base, ...patch });
    expect(verdict.park).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  it('does not pay for the /proc walk unless every cheaper gate passed', () => {
    let walked = 0;
    const descendants = () => {
      walked++;
      return 0;
    };
    parkVerdict({ ...base, childPromptReady: false, descendants });
    parkVerdict({ ...base, lastActivityAt: 9_999, descendants });
    parkVerdict({ ...base, quotaBlocked: true, descendants });
    expect(walked).toBe(0);
    parkVerdict({ ...base, descendants });
    expect(walked).toBe(1);
  });
});

describe('countProcessDescendants (P-016)', () => {
  const fakeProc = (stats: Record<string, string>) => ({
    procRoot: '/fake',
    readdir: () => [...Object.keys(stats), 'self', 'meminfo'],
    readFile: (p: string) => {
      const pid = p.split('/')[2];
      if (!(pid in stats)) throw new Error('ENOENT');
      return stats[pid];
    },
  });

  it('counts the whole subtree (grandchildren included) and nothing outside it', () => {
    const proc = fakeProc({
      '10': '10 (claude) S 1 10',
      '11': '11 (bash) S 10 10',
      '12': '12 (sleep) S 11 10',
      '13': '13 (weird ) name) S 10 10',
      '20': '20 (other) S 1 20',
    });
    expect(countProcessDescendants(10, proc)).toBe(3);
    expect(countProcessDescendants(20, proc)).toBe(0);
  });

  it('returns null (policy fails closed) when the root is not in /proc or /proc is unreadable', () => {
    expect(countProcessDescendants(99, fakeProc({ '10': '10 (claude) S 1 10' }))).toBeNull();
    expect(countProcessDescendants(10, { readdir: () => { throw new Error('no proc'); } })).toBeNull();
    expect(countProcessDescendants(0)).toBeNull();
  });

  it('sees a real child on the real /proc (positive control)', async () => {
    const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const n = countProcessDescendants(process.pid);
      expect(n).not.toBeNull();
      expect(n!).toBeGreaterThanOrEqual(1);
    } finally {
      kid.kill('SIGKILL');
    }
  });
});
