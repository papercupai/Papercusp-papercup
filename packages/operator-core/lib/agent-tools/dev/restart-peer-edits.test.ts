/**
 * EI-24790218658923698 — the restart advisory naming files other agents are mid-edit on in
 * the tree a unit boots from. Pure selection + an injected-deps reader: no lock plane, no
 * git, no systemd.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LiveLockHolding } from '../locks/live-lock-paths';

const { execFileViaSidecarMock } = vi.hoisted(() => ({ execFileViaSidecarMock: vi.fn() }));
vi.mock('../../fleet/git-via-sidecar', () => ({ execFileViaSidecar: execFileViaSidecarMock }));

import {
  peerInFlightEditsNote,
  readPeerInFlightEdits,
  selectPeerInFlightEdits,
  type PeerInFlightEdits,
} from './restart-peer-edits';

const TREE = '/work/papercusp';
const hold = (over: Partial<LiveLockHolding> & { path: string }): LiveLockHolding => ({
  owner: 'su-peer',
  intent: 'editing',
  coordinationDomain: TREE,
  ...over,
});

describe('selectPeerInFlightEdits', () => {
  it('keeps a peer-held source file in the booted tree and drops the caller’s own locks', () => {
    const out = selectPeerInFlightEdits({
      tree: TREE,
      selfOwner: 'su-me',
      holdings: [
        hold({ path: 'packages/operator-core/lib/agent-tools/plans/rubric-template.ts' }),
        hold({ path: 'packages/operator-core/lib/mine.ts', owner: 'su-me' }),
      ],
    });
    expect(out).toEqual({
      total: 1,
      files: [{ path: 'packages/operator-core/lib/agent-tools/plans/rubric-template.ts', owner: 'su-peer', intent: 'editing' }],
    });
  });

  it('ignores locks in another checkout, which this unit never loads (clean deploy trees stay empty)', () => {
    const out = selectPeerInFlightEdits({
      tree: '/work/papercup-release',
      selfOwner: null,
      holdings: [hold({ path: 'packages/operator-core/lib/x.ts' })],
    });
    expect(out.total).toBe(0);
  });

  it('maps a submodule-domain lock into tree coordinates', () => {
    const out = selectPeerInFlightEdits({
      tree: `${TREE}/`,
      selfOwner: null,
      holdings: [hold({ path: 'libs/db/src/pool.ts', coordinationDomain: `${TREE}/libs/papercusp` })],
    });
    expect(out.files.map((f) => f.path)).toEqual(['libs/papercusp/libs/db/src/pool.ts']);
  });

  it('skips tests, non-source files and domain-less holdings', () => {
    const out = selectPeerInFlightEdits({
      tree: TREE,
      selfOwner: null,
      holdings: [
        hold({ path: 'packages/operator-core/lib/a.test.ts' }),
        hold({ path: 'apps/operator/lib/__tests__/b.ts' }),
        hold({ path: 'docs/plans/c.md' }),
        hold({ path: 'packages/operator-core/lib/d.ts', coordinationDomain: undefined }),
        hold({ path: 'apps/operator/package.json' }),
      ],
    });
    expect(out.files.map((f) => f.path)).toEqual(['apps/operator/package.json']);
  });

  it('dedupes a path held twice, sorts, caps the list, and still reports the full total', () => {
    const holdings = Array.from({ length: 12 }, (_, i) => hold({ path: `packages/operator-core/lib/f${String(i).padStart(2, '0')}.ts` }));
    holdings.push(hold({ path: 'packages/operator-core/lib/f00.ts', owner: 'su-other' }));
    const out = selectPeerInFlightEdits({ tree: TREE, selfOwner: null, holdings, limit: 3 });
    expect(out.total).toBe(12);
    expect(out.files.map((f) => f.path)).toEqual([
      'packages/operator-core/lib/f00.ts',
      'packages/operator-core/lib/f01.ts',
      'packages/operator-core/lib/f02.ts',
    ]);
    expect(out.files[0]!.owner).toBe('su-peer');
  });
});

describe('readPeerInFlightEdits', () => {
  it('resolves the git root through execFileViaSidecar with the unit directory and timeout', async () => {
    execFileViaSidecarMock.mockResolvedValueOnce({ stdout: TREE + '\n', stderr: '' });
    const workingDirectory = TREE + '/apps/operator';
    const out = await readPeerInFlightEdits(workingDirectory, 'su-me', {
      readHoldings: async () => [],
    });

    expect(out).toMatchObject({ checked: true, tree: TREE, total: 0 });
    expect(execFileViaSidecarMock).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
      timeoutMs: 3000,
      subsystem: 'restart-peer-edits',
      cwd: workingDirectory,
      env: process.env,
    });
  });

  it('resolves the git root from the unit WorkingDirectory and reports checked:true', async () => {
    const seen: string[] = [];
    const out = await readPeerInFlightEdits(`${TREE}/apps/operator`, 'su-me', {
      resolveTreeRoot: async (wd) => {
        seen.push(wd);
        return TREE;
      },
      readHoldings: async () => [hold({ path: 'apps/operator/bin/hono-host.ts' })],
    });
    expect(seen).toEqual([`${TREE}/apps/operator`]);
    expect(out).toMatchObject({ checked: true, tree: TREE, total: 1 });
  });

  it('fails SOFT to checked:false — never a clean bill — when the lock plane or the tree is unreadable', async () => {
    const lockDown = await readPeerInFlightEdits(TREE, null, {
      resolveTreeRoot: async () => TREE,
      readHoldings: async () => {
        throw new Error('side DB unreachable');
      },
    });
    expect(lockDown).toMatchObject({ checked: false, tree: TREE, total: 0 });
    expect(lockDown.reason).toContain('lock plane unreadable');

    const noGit = await readPeerInFlightEdits(TREE, null, {
      resolveTreeRoot: async () => {
        throw new Error('not a git repository');
      },
      readHoldings: async () => [],
    });
    expect(noGit).toMatchObject({ checked: false, tree: null });

    expect(await readPeerInFlightEdits(null, null)).toMatchObject({ checked: false, reason: 'unit WorkingDirectory unknown' });
  });
});

describe('peerInFlightEditsNote', () => {
  const edits = (total: number, checked = true): PeerInFlightEdits => ({
    checked,
    tree: TREE,
    total,
    files: Array.from({ length: Math.min(total, 10) }, (_, i) => ({ path: `p${i}.ts`, owner: `o${i}`, intent: '' })),
  });

  it('is silent when nothing is held or nothing could be checked', () => {
    expect(peerInFlightEditsNote(null, 'u')).toBe('');
    expect(peerInFlightEditsNote(edits(0), 'u')).toBe('');
    expect(peerInFlightEditsNote(edits(2, false), 'u')).toBe('');
  });

  it('names up to three suspects and counts the rest', () => {
    const note = peerInFlightEditsNote(edits(5), 'papercusp-bg-host.service');
    expect(note).toContain('5 source file(s)');
    expect(note).toContain('p0.ts (o0), p1.ts (o1), p2.ts (o2) and 2 more');
    expect(note).toContain('If papercusp-bg-host.service does not stay up');
  });
});
