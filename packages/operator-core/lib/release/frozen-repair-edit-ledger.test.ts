import { describe, expect, it, vi } from 'vitest';
import {
  FROZEN_REPAIR_EDIT_HUNK_CAP_BYTES,
  boundHunk,
  groupLedgerRowsByPath,
  hunkSha256,
  hunksFromToolCall,
  parseFrozenRepairEditHunk,
  readFrozenRepairEditLedger,
  recordFrozenRepairEdit,
  replayFrozenRepairHunks,
  resolveFrozenRepairEditAgent,
  sqlFrozenRepairSessionBindingLookup,
  type FrozenRepairEditHunk,
  type FrozenRepairEditLedgerRow,
} from './frozen-repair-edit-ledger';

const CAND = 'a'.repeat(40);
const base = { workspaceId: 'ws-1', installSlug: 'papercusp', candidate: CAND };

describe('hunksFromToolCall — the hook-side extraction (P-019, D-008 layer 1)', () => {
  it('reads a Claude Edit as one edit hunk', () => {
    expect(
      hunksFromToolCall('Edit', { file_path: '/repo/lib/a.ts', old_string: 'x', new_string: 'y', replace_all: true }),
    ).toEqual([{ path: '/repo/lib/a.ts', hunk: { kind: 'edit', old: 'x', new: 'y', replaceAll: true }, editIndex: 0 }]);
  });
  it('reads a Write as a whole-body hunk, and the capability_* twins as their native tools', () => {
    expect(hunksFromToolCall('Write', { file_path: 'lib/a.ts', content: 'body' })).toEqual([
      { path: 'lib/a.ts', hunk: { kind: 'write', body: 'body' }, editIndex: 0 },
    ]);
    expect(hunksFromToolCall('mcp__papercusp-su__capability_write', { file_path: 'lib/a.ts', content: 'b' })[0]?.hunk).toEqual({
      kind: 'write',
      body: 'b',
    });
    expect(hunksFromToolCall('mcp__papercusp-su__capability_edit', { file_path: 'lib/a.ts', old_string: 'o', new_string: 'n' })[0]?.hunk).toEqual({
      kind: 'edit',
      old: 'o',
      new: 'n',
      replaceAll: false,
    });
    expect(hunksFromToolCall('write_file', { path: 'lib/a.ts', content: 'codex' })[0]?.hunk).toEqual({ kind: 'write', body: 'codex' });
  });
  it('reads a MultiEdit as N hunks with their positions, skipping malformed entries', () => {
    const out = hunksFromToolCall('MultiEdit', {
      file_path: 'lib/a.ts',
      edits: [{ old_string: 'a', new_string: 'b' }, 'junk', { old_string: 'c', new_string: 'd', replace_all: true }],
    });
    expect(out.map((h) => h.editIndex)).toEqual([0, 2]);
    expect(out[1]?.hunk).toEqual({ kind: 'edit', old: 'c', new: 'd', replaceAll: true });
  });
  it('parses Codex apply_patch Add/Update operations, including wrapped input and multiple hunks', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/lib/a.ts',
      '@@',
      '-old',
      '+new',
      '@@',
      '-second old',
      '+second new',
      '*** Add File: /repo/lib/new.ts',
      '+new file',
      '*** End Patch',
    ].join('\n');
    expect(hunksFromToolCall('apply_patch', patch)).toEqual([
      { path: '/repo/lib/a.ts', hunk: { kind: 'edit', old: 'old\n', new: 'new\n', replaceAll: false }, editIndex: 0 },
      { path: '/repo/lib/a.ts', hunk: { kind: 'edit', old: 'second old\n', new: 'second new\n', replaceAll: false }, editIndex: 1 },
      { path: '/repo/lib/new.ts', hunk: { kind: 'write', body: 'new file\n' }, editIndex: 2 },
    ]);
    expect(hunksFromToolCall('apply_patch', { input: patch })).toEqual(hunksFromToolCall('apply_patch', patch));
  });
  it('rejects malformed, unsupported, duplicate-target, and empty-update patches as a whole', () => {
    expect(hunksFromToolCall('apply_patch', 'diff --git a b')).toEqual([]);
    expect(hunksFromToolCall('apply_patch', { patch: '...' })).toEqual([]);
    expect(hunksFromToolCall('apply_patch', [
      '*** Begin Patch',
      '*** Delete File: /repo/lib/a.ts',
      '*** End Patch',
    ].join('\n'))).toEqual([]);
    expect(hunksFromToolCall('apply_patch', [
      '*** Begin Patch',
      '*** Update File: /repo/lib/a.ts',
      '@@',
      ' context only',
      '*** End Patch',
    ].join('\n'))).toEqual([]);
    expect(hunksFromToolCall('apply_patch', [
      '*** Begin Patch',
      '*** Update File: /repo/lib/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: ./repo/lib/a.ts',
      '@@',
      '-other',
      '+change',
      '*** End Patch',
    ].join('\n'))).toEqual([]);
    expect(hunksFromToolCall('Edit', { file_path: 'x' })).toEqual([]);
    expect(hunksFromToolCall('Read', { file_path: 'x' })).toEqual([]);
    expect(hunksFromToolCall('Edit', null)).toEqual([]);
  });
});

describe('boundHunk — the size cap keeps attribution and drops content', () => {
  it('passes a small hunk through unchanged', () => {
    const h: FrozenRepairEditHunk = { kind: 'edit', old: 'a', new: 'b', replaceAll: false };
    expect(boundHunk(h)).toBe(h);
  });
  it('turns an oversize hunk into attribution-only with the content sha, and is idempotent', () => {
    const h: FrozenRepairEditHunk = { kind: 'write', body: 'x'.repeat(100) };
    const bounded = boundHunk(h, 50);
    expect(bounded.kind).toBe('oversize');
    if (bounded.kind !== 'oversize') throw new Error('unreachable');
    expect(bounded.of).toBe('write');
    expect(bounded.bytes).toBeGreaterThan(50);
    expect(bounded.sha256).toBe(hunkSha256(h));
    expect(boundHunk(bounded, 1)).toBe(bounded);
    expect(FROZEN_REPAIR_EDIT_HUNK_CAP_BYTES).toBe(512 * 1024);
  });
  it('hashes canonically: key order and the parsed round-trip do not change the sha', () => {
    const h: FrozenRepairEditHunk = { kind: 'edit', old: 'o', new: 'n', replaceAll: false };
    const reparsed = parseFrozenRepairEditHunk(JSON.parse(JSON.stringify({ replaceAll: false, new: 'n', old: 'o', kind: 'edit' })));
    expect(reparsed && hunkSha256(reparsed)).toBe(hunkSha256(h));
  });
});

describe('parseFrozenRepairEditHunk — the wire boundary', () => {
  it('accepts the three shapes and refuses everything else', () => {
    expect(parseFrozenRepairEditHunk({ kind: 'edit', old: 'a', new: 'b' })).toEqual({ kind: 'edit', old: 'a', new: 'b', replaceAll: false });
    expect(parseFrozenRepairEditHunk({ kind: 'write', body: 'z' })).toEqual({ kind: 'write', body: 'z' });
    expect(parseFrozenRepairEditHunk({ kind: 'oversize', of: 'edit', bytes: 9, sha256: 'f'.repeat(64) })).toEqual({
      kind: 'oversize',
      of: 'edit',
      bytes: 9,
      sha256: 'f'.repeat(64),
    });
    expect(parseFrozenRepairEditHunk({ kind: 'oversize', of: 'edit', bytes: 9, sha256: 'nope' })).toBeNull();
    expect(parseFrozenRepairEditHunk({ kind: 'edit', old: 1, new: 'b' })).toBeNull();
    expect(parseFrozenRepairEditHunk({ kind: 'patch' })).toBeNull();
    expect(parseFrozenRepairEditHunk('edit')).toBeNull();
  });
});

describe('recordFrozenRepairEdit — the PG write is normalized, bounded and idempotent', () => {
  const sqlWith = (rows: unknown) => ({ unsafe: vi.fn().mockResolvedValue(rows) });

  it('inserts one normalized row and reports the id', async () => {
    const sql = sqlWith([{ id: '7' }]);
    const out = await recordFrozenRepairEdit(sql, {
      ...base,
      agent: ' su-1 ',
      path: './packages\\x\\a.ts',
      hunk: { kind: 'edit', old: 'a', new: 'b', replaceAll: false },
      atMs: 1000.7,
      toolUseId: 'toolu_1',
      editIndex: 2,
      workItem: 'WI-1',
    });
    expect(out).toEqual({ ok: true, id: 7, inserted: true, oversize: false, path: 'packages/x/a.ts' });
    const [query, params] = sql.unsafe.mock.calls[0]!;
    expect(String(query)).toContain('ON CONFLICT ON CONSTRAINT frozen_repair_edit_ledger_idempotent DO NOTHING');
    expect(params).toEqual([
      'ws-1',
      'papercusp',
      CAND,
      'su-1',
      'packages/x/a.ts',
      JSON.stringify({ kind: 'edit', old: 'a', new: 'b', replaceAll: false }),
      'edit',
      hunkSha256({ kind: 'edit', old: 'a', new: 'b', replaceAll: false }),
      1000,
      'toolu_1',
      2,
      'WI-1',
    ]);
  });
  it('a conflict (retried hook call) inserts nothing and says so — never a second row', async () => {
    const sql = sqlWith([]);
    const out = await recordFrozenRepairEdit(sql, {
      ...base,
      agent: 'su-1',
      path: 'a.ts',
      hunk: { kind: 'write', body: 'b' },
      atMs: 5,
      toolUseId: 'toolu_1',
    });
    expect(out).toEqual({ ok: true, id: null, inserted: false, oversize: false, path: 'a.ts' });
  });
  it('records an oversize hunk as attribution-only (oversize:true, hunk_kind oversize)', async () => {
    const sql = sqlWith([{ id: 1 }]);
    const out = await recordFrozenRepairEdit(sql, {
      ...base,
      agent: 'su-1',
      path: 'a.ts',
      hunk: { kind: 'write', body: 'x'.repeat(FROZEN_REPAIR_EDIT_HUNK_CAP_BYTES + 1) },
      atMs: 5,
      toolUseId: 'toolu_2',
    });
    expect(out).toMatchObject({ ok: true, inserted: true, oversize: true });
    expect(sql.unsafe.mock.calls[0]![1]![6]).toBe('oversize');
  });
  it('refuses a malformed candidate, agent or path WITHOUT touching the database', async () => {
    const sql = sqlWith([]);
    const good = { ...base, agent: 'su-1', path: 'a.ts', hunk: { kind: 'write' as const, body: 'b' }, atMs: 5, toolUseId: 't' };
    expect((await recordFrozenRepairEdit(sql, { ...good, candidate: 'zz' })).ok).toBe(false);
    expect((await recordFrozenRepairEdit(sql, { ...good, agent: '   ' })).ok).toBe(false);
    expect((await recordFrozenRepairEdit(sql, { ...good, path: '../etc/passwd' })).ok).toBe(false);
    expect((await recordFrozenRepairEdit(sql, { ...good, path: '' })).ok).toBe(false);
    expect(sql.unsafe).not.toHaveBeenCalled();
  });
  it('mints a surrogate tool_use_id when the client sent none, so the idempotency key is never blank', async () => {
    const sql = sqlWith([{ id: 1 }]);
    await recordFrozenRepairEdit(sql, { ...base, agent: 'su-1', path: 'a.ts', hunk: { kind: 'write', body: 'b' }, atMs: 5, toolUseId: '  ' });
    expect(String(sql.unsafe.mock.calls[0]![1]![9])).toMatch(/^hook-/);
  });
});

describe('readFrozenRepairEditLedger — scoped, ordered, parsed', () => {
  it('scopes by lineage, optional paths and agents, in ledger order', async () => {
    const sql = {
      unsafe: vi.fn().mockResolvedValue([
        { id: '2', candidate: CAND, agent: 'su-1', path: 'a.ts', hunk: { kind: 'edit', old: 'a', new: 'b' }, at_ms: '10', tool_use_id: 't1', edit_index: 0, work_item: null },
        { id: '3', candidate: CAND, agent: 'su-2', path: 'a.ts', hunk: '{"kind":"write","body":"z"}', at_ms: 11, tool_use_id: 't2', edit_index: 0, work_item: 'WI-9' },
        { id: '4', candidate: CAND, agent: 'su-2', path: 'a.ts', hunk: { kind: 'bogus' }, at_ms: 12, tool_use_id: 't3', edit_index: 0, work_item: null },
      ]),
    };
    const rows = await readFrozenRepairEditLedger(sql, { ...base, paths: ['./a.ts'], agents: ['su-1', 'su-2'] });
    const [query, params] = sql.unsafe.mock.calls[0]!;
    expect(String(query)).toContain('path = ANY($4::text[])');
    expect(String(query)).toContain('agent = ANY($5::text[])');
    expect(String(query)).toContain('ORDER BY at_ms ASC, id ASC');
    expect(params).toEqual(['ws-1', 'papercusp', CAND, ['a.ts'], ['su-1', 'su-2'], 2000]);
    expect(rows.map((r) => r.id)).toEqual([2, 3]); // the unparseable hunk row is skipped, never guessed
    expect(rows[1]).toMatchObject({ agent: 'su-2', hunk: { kind: 'write', body: 'z' }, atMs: 11, workItem: 'WI-9' });
  });
  it('an explicit-but-empty paths or agents filter reads as "nothing", not "everything"', async () => {
    const sql = { unsafe: vi.fn() };
    expect(await readFrozenRepairEditLedger(sql, { ...base, paths: [] })).toEqual([]);
    expect(await readFrozenRepairEditLedger(sql, { ...base, agents: ['  '] })).toEqual([]);
    expect(sql.unsafe).not.toHaveBeenCalled();
  });
});

describe('replayFrozenRepairHunks — P-020 core: only the ledgered hunks, in order, or a named conflict', () => {
  it('replays edits then a write then an edit, exactly as the client applied them', () => {
    const out = replayFrozenRepairHunks('const a = 1;\nconst b = 2;\n', [
      { kind: 'edit', old: 'const a = 1;', new: 'const a = 10;', replaceAll: false },
      { kind: 'write', body: 'x\nx\n' },
      { kind: 'edit', old: 'x', new: 'y', replaceAll: true },
    ]);
    expect(out).toEqual({ ok: true, content: 'y\ny\n', applied: 3 });
  });
  it('replaces the FIRST occurrence unless replaceAll, mirroring the Edit tool', () => {
    expect(replayFrozenRepairHunks('a a', [{ kind: 'edit', old: 'a', new: 'b', replaceAll: false }])).toMatchObject({ content: 'b a' });
    expect(replayFrozenRepairHunks('a a', [{ kind: 'edit', old: 'a', new: 'b', replaceAll: true }])).toMatchObject({ content: 'b b' });
  });
  it('a hunk whose anchor is absent is a hunk-conflict naming the hunk — the fix depends on a foreign change (D-008)', () => {
    const out = replayFrozenRepairHunks('base', [
      { kind: 'edit', old: 'base', new: 'mine', replaceAll: false },
      { kind: 'edit', old: 'someone else added this', new: 'and I edited it', replaceAll: false },
    ]);
    expect(out).toMatchObject({ ok: false, reason: 'hunk-conflict', index: 1 });
    expect((out as { detail: string }).detail).toContain('hunk #2');
  });
  it('an oversize hunk cannot be replayed and says so', () => {
    const out = replayFrozenRepairHunks('base', [{ kind: 'oversize', of: 'write', bytes: 9, sha256: 'f'.repeat(64) }]);
    expect(out).toMatchObject({ ok: false, reason: 'oversize', index: 0 });
  });
  it('a write onto a path repairHead lacks (base null) creates it; an empty-anchor edit only on an empty file', () => {
    expect(replayFrozenRepairHunks(null, [{ kind: 'write', body: 'new file' }])).toMatchObject({ ok: true, content: 'new file' });
    expect(replayFrozenRepairHunks(null, [{ kind: 'edit', old: '', new: 'seed', replaceAll: false }])).toMatchObject({ ok: true, content: 'seed' });
    expect(replayFrozenRepairHunks('has content', [{ kind: 'edit', old: '', new: 'seed', replaceAll: false }])).toMatchObject({ ok: false, reason: 'hunk-conflict' });
  });
  it('control: a deliberately wrong replay (last-occurrence) is distinguishable from the real one', () => {
    // Guard the guard: if someone "simplifies" replay to lastIndexOf, this fixture fails.
    const out = replayFrozenRepairHunks('k v k', [{ kind: 'edit', old: 'k', new: 'K', replaceAll: false }]);
    expect(out).toMatchObject({ content: 'K v k' });
  });
});

describe('groupLedgerRowsByPath', () => {
  it('groups preserving ledger order within each path', () => {
    const row = (id: number, path: string): FrozenRepairEditLedgerRow => ({
      id,
      candidate: CAND,
      agent: 'su-1',
      path,
      hunk: { kind: 'write', body: String(id) },
      atMs: id,
      toolUseId: `t${id}`,
      editIndex: 0,
      workItem: null,
    });
    const grouped = groupLedgerRowsByPath([row(1, 'a'), row(2, 'b'), row(3, 'a')]);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')!.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe('resolveFrozenRepairEditAgent — superuser-transport ledger owner (P-004 / R-11)', () => {
  // Measured 2026-10-28: the hook had no PAPERCUSP_SID, fell back to the CLI's native session_id,
  // and the superuser transport resolved that bare UUID verbatim as the ledger owner.
  const NATIVE = 'f75e5f87-b482-4fdf-a7d0-33f9df39cc43';
  const SIGNED = 'su-28bda5ad-1d63-4a7e-a50f-8ff367f1f0b1';

  it('re-attributes a bare-UUID transport owner to the signed session adv_sessions binds it to', async () => {
    const { resolveAgentIdentity } = await import('../agent-tools/coordination/identity');
    const transport = resolveAgentIdentity({ isSuperuser: true, uiClientId: NATIVE, workspaceId: 'ws-1' });
    expect(transport.ownerId).toBe(NATIVE);
    const lookup = vi.fn(async (id: string) => (id === NATIVE ? SIGNED : null));
    expect(await resolveFrozenRepairEditAgent(transport.ownerId, lookup)).toEqual({
      agent: SIGNED, transportOwnerId: NATIVE, attributedVia: 'native-session-binding',
    });
  });

  it('records the row under the signed session, the id the agent\'s own admit reads', async () => {
    const r = await resolveFrozenRepairEditAgent(NATIVE, async () => SIGNED);
    const params: unknown[][] = [];
    const sql = { unsafe: vi.fn(async (_q: string, p?: unknown[]) => { params.push(p ?? []); return [{ id: 7 }]; }) };
    const out = await recordFrozenRepairEdit(sql, {
      ...base, agent: r.agent, path: 'lib/a.ts', hunk: { kind: 'edit', old: 'x', new: 'y', replaceAll: false },
      atMs: 1, toolUseId: 'toolu_1',
    });
    expect(out.ok).toBe(true);
    expect(params[0]?.[3]).toBe(SIGNED);
  });

  it('keeps a signed owner without consulting the binding', async () => {
    const lookup = vi.fn(async () => 'su-other');
    expect(await resolveFrozenRepairEditAgent(SIGNED, lookup)).toEqual({
      agent: SIGNED, transportOwnerId: SIGNED, attributedVia: 'signed-session',
    });
    expect((await resolveFrozenRepairEditAgent('durable-spawn:launch:x:1', lookup)).agent).toBe('durable-spawn:launch:x:1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps the transport id, labelled, when the binding is absent or unreadable', async () => {
    expect(await resolveFrozenRepairEditAgent(NATIVE, async () => null)).toMatchObject({ agent: NATIVE, attributedVia: 'unbound-transport' });
    expect(await resolveFrozenRepairEditAgent(NATIVE, async () => { throw new Error('pg down'); }))
      .toMatchObject({ agent: NATIVE, attributedVia: 'binding-unreadable' });
  });

  it('the adv_sessions lookup is workspace-scoped and returns the bound coord owner', async () => {
    const sql = { unsafe: vi.fn(async (_q: string, _p?: unknown[]) => [{ coord_owner_id: SIGNED }]) };
    expect(await sqlFrozenRepairSessionBindingLookup(sql, 'ws-1')(NATIVE)).toBe(SIGNED);
    expect(sql.unsafe.mock.calls[0]?.[0]).toMatch(/adv_sessions[\s\S]*workspace_id = \$1/);
    expect(sql.unsafe.mock.calls[0]?.[1]).toEqual(['ws-1', NATIVE]);
    expect(await sqlFrozenRepairSessionBindingLookup({ unsafe: async () => [] }, 'ws-1')(NATIVE)).toBeNull();
  });
});
