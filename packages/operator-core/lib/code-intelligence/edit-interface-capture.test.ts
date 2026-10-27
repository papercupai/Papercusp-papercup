/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-002 (D-018): the edit-time interface
 * eligibility capture. Every dependency is injected, so these cover the verdict and
 * the peer correlation without PG, git or the lock plane.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import type { EditEligibilityIdentity } from './edit-eligibility-journal';
import type { InterfaceEligibility } from './interface-eligibility';
import {
  LIVE_PEER_ROW_CAP, captureEditInterface, fillInterfaceEligibility, importsModule, moduleKey,
  readEditTimePeers, type InterfaceCaptureContext, type InterfaceCaptureDeps, type LivePeerRow,
} from './edit-interface-capture';

const ROOT = '/repo';
const FILE = 'packages/lib/target.ts';
const BEFORE = 'export function size(n: number): number {\n  return n;\n}\n';
const SIGNATURE = BEFORE.replace('(n: number)', '(n: number, unit: string)');
const BODY_ONLY = BEFORE.replace('return n;', 'return n + 0;');
const IMPORTER = "import { size } from '../lib/target.js';\nexport const x = size(1);\n";

const ctx: InterfaceCaptureContext = {
  repoRoot: ROOT, workspaceId: 'ws', harnessSlug: null, scopeHarness: 'papercusp', agentId: 'author',
};

function enoent(): Error { return Object.assign(new Error('missing'), { code: 'ENOENT' }); }

/** A file map keyed by repo-relative path, read through absolute paths like production. */
function deps(files: Record<string, string>, extra: Partial<InterfaceCaptureDeps> = {}): InterfaceCaptureDeps {
  return {
    readText: async abs => {
      const rel = abs.slice(ROOT.length + 1);
      if (rel in files) return files[rel]!;
      throw enoent();
    },
    headText: async () => BEFORE,
    workingSetPlaceable: async () => true,
    locks: async () => [],
    livePeers: async () => [],
    now: () => new Date('2026-10-27T15:00:00.000Z'),
    ...extra,
  };
}

const lock = (owner: string, path: string, domain = ROOT): LiveLockHolding =>
  ({ owner, path, intent: 'edit', coordinationDomain: domain });
const live = (owner: string, files: string[] = []): LivePeerRow => ({ owner_id: owner, current_files: files });

describe('module resolution', () => {
  it('strips extensions and a trailing /index', () => {
    expect(moduleKey('packages/lib/target.ts')).toBe('packages/lib/target');
    expect(moduleKey('packages/lib/index.tsx')).toBe('packages/lib');
    expect(moduleKey('packages/lib/types.d.ts')).toBe('packages/lib/types');
    expect(moduleKey('index.mjs')).toBe('.');
  });

  it('matches relative static, re-export, dynamic and require specifiers', () => {
    const key = moduleKey(FILE);
    expect(importsModule('packages/app/a.ts', "import type { S } from '../lib/target';", key)).toBe(true);
    expect(importsModule('packages/app/a.ts', "export * from '../lib/target.js';", key)).toBe(true);
    expect(importsModule('packages/lib/b.ts', "const m = await import('./target');", key)).toBe(true);
    expect(importsModule('packages/lib/c.cjs', "const m = require('./target.ts');", key)).toBe(true);
    expect(importsModule('packages/app/d.ts', "import './side-effect';", key)).toBe(false);
  });

  it('resolves a directory import to its index file', () => {
    expect(importsModule('packages/app/a.ts', "import { x } from '../lib';", moduleKey('packages/lib/index.ts'))).toBe(true);
  });

  it('does not resolve bare package specifiers (the documented limit)', () => {
    expect(importsModule('packages/app/a.ts', "import { size } from '@papercusp/lib/target';", moduleKey(FILE))).toBe(false);
  });
});

describe('captureEditInterface', () => {
  it('is eligible when an exported signature changed and a live peer imports the file', async () => {
    const livePeers = vi.fn(async (_query: { workspaceId: string; harness: string; agentId: string; lockOwners: string[] }) =>
      [live('peer-1')]);
    const observation = await captureEditInterface(ctx, FILE, deps(
      { [FILE]: SIGNATURE, 'packages/app/use.ts': IMPORTER },
      { locks: async () => [lock('peer-1', 'packages/app/use.ts')], livePeers },
    ));
    expect(observation).toMatchObject({
      verdict: 'eligible', changedExports: ['size'], capturedAt: '2026-10-27T15:00:00.000Z',
      peerEvidence: { status: 'measured', peers: [{ owner: 'peer-1', path: 'packages/app/use.ts', via: 'lock' }] },
    });
    expect(livePeers).toHaveBeenCalledWith({ workspaceId: 'ws', harness: 'papercusp', agentId: 'author', lockOwners: ['peer-1'] });
  });

  it('is ineligible for a body-only edit and never reads peers', async () => {
    const locks = vi.fn(async () => [lock('peer-1', 'packages/app/use.ts')]);
    const observation = await captureEditInterface(ctx, FILE, deps({ [FILE]: BODY_ONLY }, { locks }));
    expect(observation).toMatchObject({ verdict: 'ineligible', reason: 'no exported signature change', changedExports: [] });
    expect(locks).not.toHaveBeenCalled();
  });

  it('is unknown when the peer read throws', async () => {
    const observation = await captureEditInterface(ctx, FILE, deps({ [FILE]: SIGNATURE },
      { locks: async () => { throw new Error('lock plane down'); } }));
    expect(observation).toMatchObject({ verdict: 'unknown', reason: 'edit-time peer evidence unavailable',
      peerEvidence: { status: 'unknown', peers: [] } });
  });

  it('is unknown when git cannot answer for the before text', async () => {
    const observation = await captureEditInterface(ctx, FILE, deps({ [FILE]: SIGNATURE }, { headText: async () => null }));
    expect(observation).toMatchObject({ verdict: 'unknown', reason: 'full-file before/after unavailable' });
  });

  it('skips non-TS/JS files and node_modules', async () => {
    expect(await captureEditInterface(ctx, 'docs/notes.md', deps({ 'docs/notes.md': '# x' }))).toBeNull();
    expect(await captureEditInterface(ctx, 'node_modules/x/index.ts', deps({}))).toBeNull();
  });

  it('is ineligible with measured evidence when no live peer correlates', async () => {
    const observation = await captureEditInterface(ctx, FILE, deps(
      { [FILE]: SIGNATURE, 'packages/app/other.ts': "import { y } from './y';" },
      { livePeers: async () => [live('peer-1', ['packages/app/other.ts'])] },
    ));
    expect(observation).toMatchObject({ verdict: 'ineligible', reason: 'no observed peer at edit time',
      peerEvidence: { status: 'measured', peers: [] } });
  });
});

describe('readEditTimePeers', () => {
  const input = { repoRoot: ROOT, file: FILE, workspaceId: 'ws', harness: 'papercusp', agentId: 'author' };

  it('counts a peer working on the edited file itself through its working set', async () => {
    const evidence = await readEditTimePeers(input, deps({}, { livePeers: async () => [live('peer-2', [FILE])] }));
    expect(evidence).toEqual({ status: 'measured', peers: [{ owner: 'peer-2', path: FILE, via: 'working-set' }] });
  });

  it("ignores the editor's own locks and locks in another coordination domain", async () => {
    const evidence = await readEditTimePeers(input, deps({}, {
      locks: async () => [lock('author', FILE), lock('peer-3', FILE, '/elsewhere')],
      livePeers: async () => [live('peer-3')],
    }));
    expect(evidence).toEqual({ status: 'measured', peers: [] });
  });

  it('is unknown without a harness to scope presence by', async () => {
    expect(await readEditTimePeers({ ...input, harness: null }, deps({}))).toEqual({ status: 'unknown', peers: [] });
  });

  it('treats a missing peer file as a measured absence but any other read error as unknown', async () => {
    const peers = async () => [live('peer-1', ['packages/app/gone.ts'])];
    expect(await readEditTimePeers(input, deps({}, { livePeers: peers }))).toEqual({ status: 'measured', peers: [] });
    const denied = await readEditTimePeers(input, deps({}, {
      livePeers: peers, readText: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    }));
    expect(denied).toEqual({ status: 'unknown', peers: [] });
  });

  it('is unknown for a partial scan with no peer, measured once a peer is found', async () => {
    const many = Array.from({ length: LIVE_PEER_ROW_CAP }, (_, i) => live(`peer-${i}`, ['packages/app/other.ts']));
    const files = { 'packages/app/other.ts': '', 'packages/app/use.ts': IMPORTER };
    expect(await readEditTimePeers(input, deps(files, { livePeers: async () => many })))
      .toEqual({ status: 'unknown', peers: [] });
    const withPeer = [...many.slice(1), live('peer-x', ['packages/app/use.ts'])];
    expect(await readEditTimePeers(input, deps(files, { livePeers: async () => withPeer })))
      .toMatchObject({ status: 'measured', peers: [{ owner: 'peer-x', path: 'packages/app/use.ts', via: 'working-set' }] });
  });

  it('uses only lock evidence when presence paths cannot be placed under the lock domain', async () => {
    const unplaceable = { workingSetPlaceable: async () => false };
    const files = { 'packages/app/use.ts': IMPORTER };
    expect(await readEditTimePeers(input, deps(files, { ...unplaceable,
      livePeers: async () => [live('peer-1', ['packages/app/use.ts'])] }))).toEqual({ status: 'unknown', peers: [] });
    expect(await readEditTimePeers(input, deps(files, { ...unplaceable,
      locks: async () => [lock('peer-1', 'packages/app/use.ts')], livePeers: async () => [live('peer-1')] })))
      .toEqual({ status: 'measured', peers: [{ owner: 'peer-1', path: 'packages/app/use.ts', via: 'lock' }] });
  });
});

describe('fillInterfaceEligibility', () => {
  const sql = {} as never;

  it('persists one observation per TS row with the row identity, NULL harness included', async () => {
    const persist = vi.fn(async (_identity: EditEligibilityIdentity, _observation: InterfaceEligibility) => true);
    const filled = await fillInterfaceEligibility(
      [{ id: '41', file: FILE }, { id: '42', file: 'README.md' }, { id: 'x', file: FILE }],
      ctx, sql, deps({ [FILE]: BODY_ONLY }, { persist }),
    );
    expect(filled).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      { id: '41', workspace: 'ws', harness: null, owner: 'author', repoRoot: ROOT, file: FILE },
      expect.objectContaining({ verdict: 'ineligible' }),
    );
  });

  it('writes nothing without a workspace and never throws when persisting fails', async () => {
    const persist = vi.fn(async () => { throw new Error('pg down'); });
    expect(await fillInterfaceEligibility([{ id: '1', file: FILE }], { ...ctx, workspaceId: null }, sql,
      deps({ [FILE]: BODY_ONLY }, { persist }))).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(await fillInterfaceEligibility([{ id: '1', file: FILE }], ctx, sql,
      deps({ [FILE]: BODY_ONLY }, { persist }))).toBe(0);
  });
});
