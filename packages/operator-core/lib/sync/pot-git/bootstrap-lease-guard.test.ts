/**
 * WI-10006972 — `bootstrapFromPeer`'s `beforeGitCommand` guard.
 *
 * git-sync runs the hive-git bootstrap leg under its per-install `git-sync:<slug>`
 * lease and passes the lease fence's `assertHeld` here. The property pinned: once
 * the guard refuses, the ladder starts NO further write against the store — no
 * `runGit` command (update-ref, config), no fetch, no sweep. The guard is called
 * BEFORE the command, so a refusal means the command never ran.
 *
 * Drives the REAL `bootstrapFromPeer` with an injected `runGit` that records every
 * command and never spawns git, against an already-destroyed duplex (the
 * no-live-dial path), so no network or repository is involved.
 */
import { Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { bootstrapFromPeer } from './bootstrap';
import type { RunGit } from './storage';

class GuardRefused extends Error {}

function destroyedDuplex(): Duplex {
  const stub = new Duplex({
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  stub.on('error', () => {});
  stub.destroy(new Error('no live swarm join (test)'));
  return stub;
}

function recordingRunGit(): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGit = async (args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runGit, calls };
}

/** A fence-shaped guard: allows the first `allowed` checks, then refuses forever. */
function guardAllowing(allowed: number): { guard: () => void; checks: () => number } {
  let n = 0;
  return {
    guard: () => {
      n++;
      if (n > allowed) throw new GuardRefused(`refused at check ${n}`);
    },
    checks: () => n,
  };
}

const REPO = '/nonexistent/pot-git/test-store.git';

describe('bootstrapFromPeer beforeGitCommand guard (WI-10006972)', () => {
  it('CONTROL: without a guard the ladder issues several git commands on this path', async () => {
    const { runGit, calls } = recordingRunGit();
    await bootstrapFromPeer(REPO, destroyedDuplex(), { runGit });
    // If this ever drops to 0 or 1, the assertions below stop discriminating.
    expect(calls.length).toBeGreaterThan(1);
  });

  it('a guard refusing at the first check stops the call before ANY git command', async () => {
    const { runGit, calls } = recordingRunGit();
    const { guard } = guardAllowing(0);
    await expect(bootstrapFromPeer(REPO, destroyedDuplex(), { runGit, beforeGitCommand: guard })).rejects.toBeInstanceOf(
      GuardRefused,
    );
    expect(calls).toEqual([]);
  });

  it('a guard that trips mid-ladder lets no later git command start', async () => {
    const { runGit: controlRunGit, calls: controlCalls } = recordingRunGit();
    await bootstrapFromPeer(REPO, destroyedDuplex(), { runGit: controlRunGit });

    // check 1 = the pack-temp sweep; checks 2..k = runGit commands. Allow the
    // sweep and exactly one command, then refuse.
    const { runGit, calls } = recordingRunGit();
    const { guard, checks } = guardAllowing(2);
    await expect(bootstrapFromPeer(REPO, destroyedDuplex(), { runGit, beforeGitCommand: guard })).rejects.toBeInstanceOf(
      GuardRefused,
    );
    expect(calls).toEqual(controlCalls.slice(0, 1));
    expect(checks()).toBe(3); // the refused check was the last one attempted
  });

  it('every git command the ladder starts is preceded by a guard check', async () => {
    const { runGit, calls } = recordingRunGit();
    const { guard, checks } = guardAllowing(Number.POSITIVE_INFINITY);
    await bootstrapFromPeer(REPO, destroyedDuplex(), { runGit, beforeGitCommand: guard });
    // sweep + one per runGit command + one per fetch attempt (one here: the
    // destroyed-duplex diagnosis fetch).
    expect(checks()).toBe(calls.length + 2);
  });
});
