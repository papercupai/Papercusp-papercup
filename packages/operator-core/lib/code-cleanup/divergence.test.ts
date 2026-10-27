/**
 * R-5 (plan code-cleanup-campaigns-2026-10-26, P-010): diverged copies are filed as bugs
 * before any merge. Triage (P-005) holds a diverged family until a bug naming both
 * locations is terminal; this suite proves the filer files that bug, names both copies,
 * files it once per pair, and that the lookup triage reads releases the family only when
 * the bug is terminal.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryCommit } from '../code-intelligence/change-history';
import {
  DIVERGED_COPY_FILER, DIVERGED_COPY_PAYLOAD_KEY, divergedCopyBugText, divergenceBugFromRows, divergenceBugLookup,
  fileDivergedCopyBugs, type DivergedBugInput, type DivergenceBugRow,
} from './divergence';
import { divergedCopyConditionKey, triageCloneFamilies, type DivergedHold, type TriageFamily, type TriageHistory } from './triage';

const HAS = { path: 'packages/delta/src/auth/session.ts', line: 10, symbol: 'readSession' };
const LACKS = { path: 'packages/delta/src/auth/token.ts', line: 40, symbol: 'readToken' };
const hold = (over: Partial<DivergedHold> = {}): DivergedHold => ({
  familyId: 'family-diverged', conditionKey: divergedCopyConditionKey(HAS, LACKS),
  locations: [HAS, LACKS], extra: ["if (!id) throw new Error('session id required');"], guard: true,
  bug: 'missing', bugId: null, ...over,
});

/** In-memory work-item store with the condition-upsert semantics the filer relies on. */
function store() {
  const items = new Map<string, { id: string; key: string; input: DivergedBugInput; terminal: boolean }>();
  const calls: Array<{ key: string; input: DivergedBugInput }> = [];
  let seq = 0;
  const upsert = async (key: string, input: DivergedBugInput) => {
    calls.push({ key, input });
    const open = [...items.values()].find(i => i.key === key && !i.terminal);
    if (open) return { id: open.id, created: false };
    const id = `WI-bug-${++seq}`;
    items.set(id, { id, key, input, terminal: false });
    return { id, created: true };
  };
  const rows = async (key: string): Promise<DivergenceBugRow[]> =>
    [...items.values()].filter(i => i.key === key).map(i => ({ id: i.id, terminal: i.terminal }));
  const close = (id: string) => { items.get(id)!.terminal = true; };
  return { items, calls, upsert, rows, close };
}

const scope = { workspaceId: 'ws-test', harness: 'papercusp' };

describe('divergedCopyBugText (P-010, R-5)', () => {
  it('names both locations and the statements only one copy has', () => {
    const { title, summary } = divergedCopyBugText(hold());
    expect(title).toContain(LACKS.path);
    expect(title).toContain(HAS.path);
    expect(title).toContain('a guard');
    expect(summary).toContain(`- has it: ${HAS.path}:10 readSession`);
    expect(summary).toContain(`- lacks it: ${LACKS.path}:40 readToken`);
    expect(summary).toContain("if (!id) throw new Error('session id required');");
    expect(summary).toContain('No cleanup batch merges this family until this bug is terminal');
  });

  it('counts non-guard statements and bounds a long list', () => {
    const extra = Array.from({ length: 13 }, (_, i) => `audit.push(${i});`);
    const { title, summary } = divergedCopyBugText(hold({ guard: false, extra }));
    expect(title).toContain('13 statements');
    expect(summary).toContain('audit.push(9);');
    expect(summary).not.toContain('audit.push(10);');
    expect(summary).toContain('… 3 more');
  });
});

describe('fileDivergedCopyBugs (P-010, R-5)', () => {
  it('files one bug per diverged pair under its condition key, naming both copies', async () => {
    const s = store();
    const rows = await fileDivergedCopyBugs([hold()], scope, { upsert: s.upsert });
    expect(rows).toEqual([{ familyId: 'family-diverged', conditionKey: hold().conditionKey, bugId: 'WI-bug-1', disposition: 'created' }]);
    const [call] = s.calls;
    expect(call!.key).toBe(divergedCopyConditionKey(LACKS, HAS));
    expect(call!.input).toMatchObject({ kind: 'bug', harness: 'papercusp', workspaceId: 'ws-test', severity: 'major', createdBy: DIVERGED_COPY_FILER });
    expect(call!.input.summary).toContain(HAS.path);
    expect(call!.input.summary).toContain(LACKS.path);
    expect(call!.input.payload[DIVERGED_COPY_PAYLOAD_KEY]).toEqual({ familyId: 'family-diverged', has: HAS, lacks: LACKS,
      extra: hold().extra, guard: true });
  });

  it('refreshes the open bug on a re-run instead of filing a second one', async () => {
    const s = store();
    await fileDivergedCopyBugs([hold()], scope, { upsert: s.upsert });
    const again = await fileDivergedCopyBugs([hold({ bug: 'open', bugId: 'WI-bug-1' })], scope, { upsert: s.upsert });
    expect(again).toEqual([expect.objectContaining({ bugId: 'WI-bug-1', disposition: 'reused' })]);
    expect(s.items.size).toBe(1);
  });

  it('files a non-guard divergence as minor', async () => {
    const s = store();
    await fileDivergedCopyBugs([hold({ guard: false, extra: ['log(id);'] })], scope, { upsert: s.upsert });
    expect(s.calls[0]!.input.severity).toBe('minor');
  });

  it('refuses a duplicate left open, a missing identity, and an empty scope', async () => {
    await expect(fileDivergedCopyBugs([hold()], scope, { upsert: async () => ({ id: 'WI-a', created: false, duplicateLeftOpen: 'WI-b' }) }))
      .rejects.toThrow('duplicate remains open: WI-b');
    await expect(fileDivergedCopyBugs([hold()], scope, { upsert: async () => ({ id: null, created: false }) }))
      .rejects.toThrow('returned no identity');
    await expect(fileDivergedCopyBugs([hold()], { workspaceId: ' ', harness: 'papercusp' }, { upsert: store().upsert }))
      .rejects.toThrow('scope required');
  });
});

describe('divergenceBugLookup (P-010, R-5)', () => {
  it('reads missing, open, and terminal; any open bug holds even beside a closed one', async () => {
    expect(divergenceBugFromRows([])).toEqual({ status: 'missing' });
    expect(divergenceBugFromRows([{ id: 'WI-1', terminal: false }])).toEqual({ status: 'open', id: 'WI-1' });
    expect(divergenceBugFromRows([{ id: 'WI-1', terminal: true }])).toEqual({ status: 'terminal', id: 'WI-1' });
    expect(divergenceBugFromRows([{ id: 'WI-1', terminal: true }, { id: 'WI-2', terminal: false }])).toEqual({ status: 'open', id: 'WI-2' });
    expect(() => divergenceBugLookup({ workspaceId: '' })).toThrow('needs a workspace');
  });
});

describe('diverged copies are filed as bugs before any merge (P-010 with P-005, R-5)', () => {
  const END = '2026-10-01T00:00:00.000Z';
  let n = 0;
  const commit = (day: number, ...paths: string[]): HistoryCommit => ({
    sha: (++n).toString(16).padStart(40, '0'), parents: ['f'.repeat(40)],
    at: new Date(Date.parse(END) - day * 86_400_000).toISOString(), files: paths.map(path => ({ status: 'M', path })),
  });
  const history: TriageHistory = { end: END, commit: 'e'.repeat(40), complete: true,
    commits: [4, 10, 16, 22].map(day => commit(day, HAS.path, LACKS.path)) };
  const family: TriageFamily = {
    id: 'family-diverged', kind: 'near', redundantMass: 90, packageDistance: 0,
    members: [
      { id: `${HAS.path}:10`, path: HAS.path, line: 10, symbol: 'readSession',
        source: "function readSession(store, id) {\n  if (!id) throw new Error('session id required');\n  const row = store.get(id);\n  return row ? row.value : null;\n}" },
      { id: `${LACKS.path}:40`, path: LACKS.path, line: 40, symbol: 'readToken',
        source: 'function readToken(cache, key) {\n  const entry = cache.get(key);\n  return entry ? entry.value : null;\n}' },
    ],
  };

  it('holds the family, files its bug, keeps holding while it is open, and batches only once it is terminal', async () => {
    const s = store();
    const lookup = divergenceBugLookup(scope, { rows: s.rows });

    const first = await triageCloneFamilies({ families: [family], history, divergenceBug: lookup });
    expect(first.batches).toEqual([]);
    expect(first.diverged).toEqual([expect.objectContaining({ familyId: 'family-diverged', bug: 'missing', bugId: null })]);

    const filed = await fileDivergedCopyBugs(first.diverged, scope, { upsert: s.upsert });
    const bugId = filed[0]!.bugId;
    expect(s.items.get(bugId)!.input.summary).toContain(HAS.path);
    expect(s.items.get(bugId)!.input.summary).toContain(LACKS.path);

    const second = await triageCloneFamilies({ families: [family], history, divergenceBug: lookup });
    expect(second.batches).toEqual([]);
    expect(second.diverged).toEqual([expect.objectContaining({ bug: 'open', bugId })]);
    expect(await fileDivergedCopyBugs(second.diverged, scope, { upsert: s.upsert })).toEqual([expect.objectContaining({ bugId, disposition: 'reused' })]);
    expect(s.items.size).toBe(1);

    s.close(bugId);
    const third = await triageCloneFamilies({ families: [family], history, divergenceBug: lookup });
    expect(third.diverged).toEqual([]);
    expect(third.batches.flatMap(b => b.families)).toEqual([expect.objectContaining({ id: 'family-diverged', divergenceResolvedBy: bugId })]);
  });
});
