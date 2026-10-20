/**
 * code-intel-epoch-carry-2026-10-20 R-3 (P-002) and R-5 (P-004): the carry
 * document names the derived working set as handles, and stamps it on the
 * owner's held work items.
 */
import { describe, expect, it } from 'vitest';
import { buildCarryDoc, renderCarryDoc, renderCodeWorkingSet, type BuildCarryDocOpts, type CarryDoc } from './carry-doc';
import type { CarryBriefHeldItem } from './carry-brief';
import type { CodeWorkingSet } from './code-intelligence/working-set';

const OWNER = 'su-carry-ws-owner';
const SET: CodeWorkingSet = {
  owner: OWNER,
  epoch: 4,
  window: { start: '2026-10-20T12:00:00.000Z', end: '2026-10-20T14:00:00.000Z' },
  derivedAt: '2026-10-20T14:00:00.000Z',
  files: [
    { path: 'packages/a/edited.ts', reason: 'edited', hits: 2 },
    { path: 'packages/a/defs.ts', reason: 'queried', hits: 1 },
    { path: 'packages/a/read-only.ts', reason: 'read', hits: 5 },
  ],
  symbols: [{ name: 'resolveThing', path: 'packages/a/defs.ts', hits: 1 }],
  truncated: { files: 2, symbols: 0 },
};

function held(id: string): CarryBriefHeldItem {
  return { id, title: id, body: null, harness: 'papercusp', checkpoint: null } as CarryBriefHeldItem;
}

function opts(over: Partial<BuildCarryDocOpts> & { heldItems?: CarryBriefHeldItem[] } = {}): BuildCarryDocOpts {
  const { heldItems = [], ...rest } = over;
  return {
    workspaceId: 'carry-ws',
    harness: 'papercusp',
    boundaryDeliberate: true,
    buildCarryBriefFn: async () => ({
      ownerId: OWNER, loop: null, heldItems, directives: [], directivesTotalOpen: 0,
      walls: [], facts: [], awaits: [], fleet: null,
    }),
    buildAutomaticRecoveryFn: () => Promise.reject(new Error('fixture: no automatic recovery')),
    getModesFn: async () => [],
    getPlanItemsFn: async () => [],
    getAsksFn: async () => [],
    getBackgroundTasksFn: async () => [],
    getClosedDirectivesFn: async () => [],
    getTailFn: async () => [],
    ownerSpeechCensusFn: async () => 'unknown',
    projectedToolsFn: () => [],
    ...rest,
  } as BuildCarryDocOpts;
}

describe('R-3: the carry document names the working set as handles', () => {
  it('renders every working-set file and symbol with re-run handles and no result text', async () => {
    const asked: Array<[string, string, string | null]> = [];
    const doc = await buildCarryDoc(OWNER, opts({
      getCodeWorkingSetFn: async (owner, ws, harness) => { asked.push([owner, ws, harness]); return SET; },
    }));
    expect(asked).toEqual([[OWNER, 'carry-ws', 'papercusp']]);
    expect(doc.codeWorkingSet).toBe(SET);
    const text = renderCarryDoc(doc, Date.parse('2026-10-20T14:01:00Z'));
    const section = text.slice(text.indexOf('## Code you were working in'));
    expect(section.startsWith('## Code you were working in (derived — re-run, do not trust)')).toBe(true);
    for (const file of SET.files) {
      expect(section).toContain(`\`${file.path}\` — ${file.reason} · capability:read { file_path: "${file.path}" }`);
    }
    expect(section).toContain('`resolveThing` (packages/a/defs.ts) · graph:query { op: "context", name: "resolveThing" }');
    expect(section).toContain('(+2 more file(s) not carried)');
    // Tier 1: no code-intelligence RESULT text crosses the boundary.
    const own = section.split('\n## ')[0];
    expect(own).not.toMatch(/static (?:file )?importers|static calls|definition |callers?:/i);
    expect(own).not.toMatch(/\b\d+ (?:callers|importers|references)\b/);
  });

  it('renders nothing for an empty or missing set, and a failing derivation costs nothing', async () => {
    expect(renderCodeWorkingSet(null)).toBeNull();
    expect(renderCodeWorkingSet({ ...SET, files: [], symbols: [] })).toBeNull();
    const doc = await buildCarryDoc(OWNER, opts({ getCodeWorkingSetFn: async () => { throw new Error('ledger down'); } }));
    expect(doc.codeWorkingSet).toBeNull();
    expect(renderCarryDoc(doc)).not.toContain('## Code you were working in');
  });

  it('is the first section shed under budget pressure, dropping to a pointer', async () => {
    const doc: CarryDoc = await buildCarryDoc(OWNER, opts({ getCodeWorkingSetFn: async () => SET }));
    const full = renderCarryDoc(doc, 0);
    // One char over budget: only the first rung of the ladder may shed.
    const shed = renderCarryDoc(doc, 0, { budgetChars: full.length - 1 });
    expect(shed).toContain('## Code you were working in (derived — re-run, do not trust)\n(dropped to fit the carry budget');
    expect(shed).not.toContain('`packages/a/edited.ts`');
    expect(shed.length).toBeLessThanOrEqual(full.length - 1);
  });
});

describe('R-5: held work items record the working set', () => {
  it('stamps the derived set onto the held items when the document is built', async () => {
    const stamped: Array<{ owner: string; ws: string; set: CodeWorkingSet; ids: readonly string[] }> = [];
    await buildCarryDoc(OWNER, opts({
      heldItems: [held('WI-1'), held('EI-2')],
      getCodeWorkingSetFn: async () => SET,
      stampCodeWorkingSetFn: async (owner, ws, set, ids) => { stamped.push({ owner, ws, set, ids }); return ids; },
    }));
    expect(stamped).toEqual([{ owner: OWNER, ws: 'carry-ws', set: SET, ids: ['WI-1', 'EI-2'] }]);
  });

  it('does not stamp when there is nothing held or nothing derived, and a failed stamp is fail-soft', async () => {
    const calls: string[][] = [];
    const stampCodeWorkingSetFn = async (_o: string, _w: string, _s: CodeWorkingSet, ids: readonly string[]) => { calls.push([...ids]); return ids; };
    await buildCarryDoc(OWNER, opts({ getCodeWorkingSetFn: async () => SET, stampCodeWorkingSetFn }));
    await buildCarryDoc(OWNER, opts({ heldItems: [held('WI-1')], getCodeWorkingSetFn: async () => ({ ...SET, files: [] }), stampCodeWorkingSetFn }));
    expect(calls).toEqual([]);
    const doc = await buildCarryDoc(OWNER, opts({
      heldItems: [held('WI-1')],
      getCodeWorkingSetFn: async () => SET,
      stampCodeWorkingSetFn: async () => { throw new Error('write refused'); },
    }));
    expect(doc.codeWorkingSet).toBe(SET);
  });
});
