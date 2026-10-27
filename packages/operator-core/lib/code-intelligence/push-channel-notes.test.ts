/**
 * code-intel-epoch-carry-2026-10-20 P-005 — the `notes` push leg.
 *
 * R-7: a first touch of a file pushes a `code-note:` fact anchored to it while the
 *      file still hashes to what the note was written against.
 * R-8: a note whose anchored file content changed is WITHHELD, and the push names
 *      how many were withheld and their keys instead.
 *
 * The R-8 case runs the PRODUCTION anchor check (readNoteAnchorStaleness → the
 * shared `file:` resolver) against a real temp checkout, so "changed" is a real
 * content-hash comparison, not a stubbed verdict.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import type { AgentFact } from '../agent-facts/store';
import { resolveCurrentTokens } from '../freshness/resolvers';
import {
  codeIntelPushText, PUSH_LEG_FLAGS, readNoteAnchorStaleness, readPushNotesContext, snapshotNotesLeg,
  type NotesContext, type PushChannelDeps, type PushFact, type PushInput, type ReadNotesContextDeps,
} from './push-channel';
import { parsePushSnapshot } from './push-snapshot';

const now = Date.now();
const snapshot = () => parsePushSnapshot(JSON.stringify({
  schema: 'graph-dependency-snapshot-v1', index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
  generatedAt: new Date(now).toISOString(), edges: [
    { importer: 'app/use.ts', imported: 'lib/target.ts', importerSha256: 'b'.repeat(64) },
  ] }), now)!;

const root = mkdtempSync(join(tmpdir(), 'code-note-anchor-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Measured 2026-10-20 (.papercusp/scratch probe): the staleness module's FIRST use
// costs ~0.9s (cold cell-read graph import) against a 4ms hash, so a cold read
// cannot fit the 120ms notes bound. Production prefetches it at module load; wait
// for that prefetch here so these cases measure the steady state, not the race.
beforeAll(async () => { await readNoteAnchorStaleness([], input()); }, 30_000);

const input = (path = 'lib/target.ts'): PushInput =>
  ({ owner: 'su-notes', workspace: 'ws-notes', harness: 'papercusp', root, calls: [{ tool: 'Read', toolInput: { file_path: path } }] });

const note = (key: string, cells: Array<{ path: string; digest?: string }>, body = `interpretation for ${key}`): AgentFact => ({
  id: key, scope: 'harness', scopeRef: 'papercusp', key, body, sourceRef: null, audienceScope: null,
  createdBy: 'su-author', updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
  dependsOn: cells.map(c => ({ cell: `file:${c.path}`, observedAt: new Date(now).toISOString(),
    ...(c.digest ? { digest: c.digest, observed: c.digest } : { unknown: 'absent' }) })),
} as unknown as AgentFact);

async function tokenOf(path: string): Promise<string> {
  const tokens = await resolveCurrentTokens([`file:${path}`], { workspaceId: 'ws-notes', harness: 'papercusp', repoRoot: root });
  const token = tokens.get(`file:${path}`);
  if (!token) throw new Error(`resolver produced no token for ${path} under ${root}`);
  return token;
}

function channel(notes: ReadNotesContextDeps, enabled = async () => true) {
  const committed: PushFact[] = [];
  const notesContext = vi.fn((i: PushInput, paths: readonly string[]) => readPushNotesContext(i, paths, notes));
  const deps: PushChannelDeps = {
    snapshot: async () => snapshot(),
    enabled: vi.fn(enabled),
    legs: () => new Map([['notes', snapshotNotesLeg]]),
    notesContext,
    commit: async (_i, _s, facts) => { committed.push(...facts); return facts.map(f => f.text).join('\n\n'); },
  };
  return { deps, committed, notesContext };
}

describe('R-7: a fresh code note is pushed on first touch of its file', () => {
  it('pushes the note body for the touched file when its anchor still matches (real file hash)', async () => {
    writeFileSync(join(root, 'target-r7.ts'), 'export const retries = 3; // deliberate\n');
    const digest = await tokenOf('target-r7.ts');
    const fold = vi.fn(async () => [note('code-note:retry-loop', [{ path: 'target-r7.ts', digest }], 'The retry loop is deliberate: the upstream drops 1 in 50 requests.')]);
    const { deps, committed } = channel({ fold, staleness: readNoteAnchorStaleness });
    const text = await codeIntelPushText(input('target-r7.ts'), deps);

    expect(fold).toHaveBeenCalledWith(expect.objectContaining({ owner: 'su-notes' }), ['target-r7.ts']);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ leg: 'notes', subject: 'note:code-note:retry-loop', citedPaths: ['target-r7.ts'] });
    expect(text).toContain('The retry loop is deliberate');
    expect(committed[0]!.suggestedCall).toBe('facts:list {"scope":"harness","scopeRef":"papercusp","key":"code-note:retry-loop"}');
  });

  it('delivers nothing for a file the batch did not touch', () => {
    const ctx: NotesContext = { fresh: [{ key: 'code-note:x', body: 'b', paths: ['lib/other.ts'], scope: 'harness', scopeRef: 'papercusp' }], withheld: [] };
    expect(snapshotNotesLeg({ ...input('lib/target.ts'), notesContext: ctx }, snapshot())).toEqual([]);
  });

  it('bounds long bodies and the per-file note count', () => {
    const fresh = ['a', 'b', 'c'].map(k => ({ key: `code-note:${k}`, body: 'x'.repeat(2_000), paths: ['lib/target.ts'], scope: 'harness', scopeRef: 'papercusp' }));
    const facts = snapshotNotesLeg({ ...input(), notesContext: { fresh, withheld: [] } }, snapshot());
    expect(facts).toHaveLength(2);
    for (const fact of facts) expect(fact.text.length).toBeLessThan(500);
  });
});

describe('R-8: a code note whose code changed is withheld, not pushed as current', () => {
  it('withholds a note after its anchored file is edited, naming the count and key (real file hash)', async () => {
    writeFileSync(join(root, 'target-r8.ts'), 'export const retries = 3;\n');
    const digest = await tokenOf('target-r8.ts');
    writeFileSync(join(root, 'target-r8.ts'), 'export const retries = 0; // the loop was removed\n');
    const fold = vi.fn(async () => [note('code-note:stale-retry', [{ path: 'target-r8.ts', digest }], 'STALE BODY must not be delivered')]);
    const { deps, committed } = channel({ fold, staleness: readNoteAnchorStaleness });
    const text = await codeIntelPushText(input('target-r8.ts'), deps);

    expect(text).not.toContain('STALE BODY');
    expect(committed).toHaveLength(1);
    expect(committed[0]!.leg).toBe('notes');
    expect(committed[0]!.text).toContain('1 code note(s) on target-r8.ts withheld');
    expect(committed[0]!.text).toContain('code-note:stale-retry');
  });

  it('withholds a note when ANY of its anchors changed, even if the touched one did not', async () => {
    writeFileSync(join(root, 'pair-a.ts'), 'a\n');
    writeFileSync(join(root, 'pair-b.ts'), 'b\n');
    const a = await tokenOf('pair-a.ts');
    const b = await tokenOf('pair-b.ts');
    writeFileSync(join(root, 'pair-b.ts'), 'b changed\n');
    const ctx = await readPushNotesContext(input('pair-a.ts'), ['pair-a.ts'],
      { fold: async () => [note('code-note:pair', [{ path: 'pair-a.ts', digest: a }, { path: 'pair-b.ts', digest: b }])], staleness: readNoteAnchorStaleness });
    expect(ctx.fresh).toEqual([]);
    expect(ctx.withheld).toEqual([{ key: 'code-note:pair', path: 'pair-a.ts', reason: 'changed' }]);
  });

  it('fails closed: an anchor that cannot be re-hashed is withheld as unverifiable, never pushed', async () => {
    const ctx = await readPushNotesContext(input('gone.ts'), ['gone.ts'],
      { fold: async () => [note('code-note:gone', [{ path: 'gone.ts', digest: 'sha256:0123456789abcdef' }])], staleness: readNoteAnchorStaleness });
    expect(ctx.fresh).toEqual([]);
    expect(ctx.withheld).toEqual([{ key: 'code-note:gone', path: 'gone.ts', reason: 'unverifiable' }]);
  });

  it('ignores non-code-note facts and non-file dependencies the fold might return', async () => {
    const staleness = vi.fn(readNoteAnchorStaleness);
    const ordinary = { ...note('ordinary', [{ path: 'x.ts', digest: 'sha256:1111111111111111' }]) } as AgentFact;
    const mixed = note('code-note:mixed', [{ path: 'gone2.ts', digest: 'sha256:2222222222222222' }]);
    (mixed.dependsOn as unknown[]).push({ cell: 'git.pipelinePosition', observedAt: new Date(now).toISOString(), digest: 'abc' });
    await readPushNotesContext(input('gone2.ts'), ['gone2.ts'], { fold: async () => [ordinary, mixed], staleness });
    const passed = staleness.mock.calls[0]![0];
    expect(passed.map(f => f.key)).toEqual(['code-note:mixed']);
    expect(passed[0]!.dependsOn!.map(d => d.cell)).toEqual(['file:gone2.ts']);
  });
});

describe('notes leg wiring', () => {
  it('a timed-out or failing notes read delivers nothing rather than an unverified note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, committed } = channel({ fold: async () => { throw new Error('pg down'); }, staleness: readNoteAnchorStaleness });
    expect(await codeIntelPushText(input(), deps)).toBe('');
    expect(committed).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('code-intel-notes-context');
    warn.mockRestore();
  });

  it('skips the read entirely when the flag is off or nothing was first-touched', async () => {
    const off = channel({ fold: vi.fn(async () => []), staleness: readNoteAnchorStaleness }, async () => false);
    await codeIntelPushText(input(), off.deps);
    expect(off.notesContext).not.toHaveBeenCalled();

    const on = channel({ fold: vi.fn(async () => []), staleness: readNoteAnchorStaleness });
    await codeIntelPushText({ ...input(), calls: [{ tool: 'Bash', toolInput: { command: 'ls' } }] }, on.deps);
    expect(on.notesContext).not.toHaveBeenCalled();
  });

  it('CODE_INTEL_PUSH_NOTES ships default ON', () => {
    expect(FLAG_DEFAULTS[PUSH_LEG_FLAGS.notes]).toBe(true);
  });
});
