import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { codeIntelPushText, commitPushFacts, snapshotInterfaceLeg, type PushInput } from './push-channel';
import { readInterfacePeerContext } from './peer-edit-impact';
import type { LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import type { PushSnapshot } from './push-snapshot';
import { diffInterfaceConsequences } from '../../../../scripts/check-required-field-strands.mjs';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const BEFORE = 'export function target(value: string): string { return value; }\n';
const AFTER = 'export function target(value: number): string { return String(value); }\n';
const CALLER = "import { target } from './target'; export const used = target('x');\n";
const WS = 'test-peer-edit-impact', HARNESS = 'peer-impact-fixture', OWNER = 'su-impact-author';
const backing = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  withWorkspace: (_workspace: string, run: (tx: unknown) => unknown) => (backing.sql as any).begin(run) }));

describe('REUSE-P-018-01 native interface peer impact, migrated PG', () => {
  let db: OrgTestDb, root: string;
  let locks: LiveLockHolding[];
  let snapshot: PushSnapshot;
  let input: PushInput;
  beforeAll(async () => {
    db = await createOrgTestDb();
    backing.sql = db.adminSql;
    root = await mkdtemp(join(tmpdir(), 'peer-impact-'));
    for (const [owner, files, ended, stale, workspace, harness] of [
      ['su-lock-peer', [], false, false, WS, HARNESS],
      ['su-work-peer', ['caller.ts'], false, false, WS, HARNESS],
      ['su-unrelated-peer', ['unrelated.ts'], false, false, WS, HARNESS],
      ['su-dead-peer', ['caller.ts'], true, false, WS, HARNESS],
      ['su-stale-peer', ['caller.ts'], false, true, WS, HARNESS],
      [OWNER, ['caller.ts'], false, false, WS, HARNESS],
      ['su-foreign-workspace', ['caller.ts'], false, false, WS + '-other', HARNESS],
      ['su-foreign-harness', ['caller.ts'], false, false, WS, HARNESS + '-other'],
      ['su-wrong-domain', [], false, false, WS, HARNESS],
    ] as const) {
      await db.adminSql`INSERT INTO harness_shared.coord_presence
        (owner_id, workspace_id, pot_slug, current_files, heartbeat_at)
        VALUES (${owner}, ${workspace}, ${harness}, ${db.adminSql.json([...files])},
          now() - ${stale ? '1 day' : '0 seconds'}::interval)`;
      await db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, ended_at)
        VALUES (${workspace}, 'console', ${owner}, ${ended ? new Date() : null})`;
    }
  });
  afterAll(async () => { await db?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  beforeEach(async () => {
    await writeFile(join(root, 'target.ts'), AFTER);
    await writeFile(join(root, 'caller.ts'), CALLER);
    const sources = [{ path: 'target.ts', sha256: hash(BEFORE) }, { path: 'caller.ts', sha256: hash(CALLER) }];
    const symbol = { id: 'target-id', name: 'target', aliases: [], signature: 'target(value:string):string',
      path: 'target.ts', line: 1, column: 17, sha256: hash(BEFORE), sources,
      callers: [{ path: 'caller.ts', line: 1, column: 55, sha256: hash(CALLER), spelling: 'target' }] };
    snapshot = { commit: 'a'.repeat(40), generatedAt: new Date().toISOString(), generatedMs: Date.now(),
      importers: new Map([['target.ts', ['caller.ts']]]), hashes: new Map(sources.map(s => [s.path, s.sha256])),
      symbols: new Map([['target', [symbol]]]) };
    locks = ['su-lock-peer', 'su-dead-peer', 'su-stale-peer', OWNER].map(owner =>
      ({ owner, path: 'caller.ts', intent: 'test caller', coordinationDomain: root }));
    locks.push({ owner: 'su-wrong-domain', path: 'caller.ts', intent: 'other repo', coordinationDomain: root + '-other' });
    input = { owner: OWNER, workspace: WS, harness: HARNESS, root, calls: [{ tool: 'Edit', interfaceEdit: {
      path: 'target.ts', base: snapshot.commit, changes: diffInterfaceConsequences(BEFORE, AFTER, 'target.ts'), checks: [],
      sourceChange: { root, path: 'target.ts', base: snapshot.commit, at: Date.now(),
        beforeSha256: hash(BEFORE), sha256: hash(AFTER) },
    } }] };
  });
  const read = () => readInterfacePeerContext(input, snapshot, { sql: db.adminSql, locks: async () => locks });

  it('names caller lock and working-set peers in the existing interface leg, excluding unrelated/dead/stale/self/foreign peers', async () => {
    const context = await read();
    const expectedPeers = [
      { owner: 'su-lock-peer', path: 'caller.ts', via: 'lock' },
      { owner: 'su-work-peer', path: 'caller.ts', via: 'working-set' },
    ];
    // code-intel P-011: the full holder list and the changed symbol ride along as
    // shadow-coupling evidence; `peers` stays the display slice.
    expect(context.byPath['target.ts']).toEqual({ status: 'measured', peers: expectedPeers,
      symbols: ['target'], holders: expectedPeers, callers: 'measured' });
    const fact = snapshotInterfaceLeg({ ...input, interfacePeerContext: context }, snapshot)[0];
    expect(fact.leg).toBe('interface');
    expect(fact.text).toContain('su-lock-peer caller.ts (lock)');
    expect(fact.text).toContain('su-work-peer caller.ts (working-set)');
    expect(fact.text).toContain('candidates');
    expect(fact.text).toContain('runtime execution remain unknown');
  });

  it('retains unknown for mixed-generation caller or definition evidence and for source changes during the peer read', async () => {
    await writeFile(join(root, 'caller.ts'), CALLER + '// new generation');
    expect((await read()).byPath['target.ts'].status).toBe('unknown');
    // A moved callers generation is STALE evidence for the shadow coupling, not "no callers".
    expect((await read()).byPath['target.ts'].callers).toBe('stale');
    await writeFile(join(root, 'caller.ts'), CALLER);
    const edit = input.calls[0].interfaceEdit as any;
    edit.sourceChange.beforeSha256 = 'f'.repeat(64);
    expect((await read()).byPath['target.ts'].status).toBe('unknown');
    edit.sourceChange.beforeSha256 = hash(BEFORE);
    const changed = await readInterfacePeerContext(input, snapshot, { sql: db.adminSql, locks: async () => {
      await writeFile(join(root, 'target.ts'), AFTER + '// raced'); return locks;
    } });
    expect(changed.byPath['target.ts']).toMatchObject({ status: 'unknown', peers: [] });
  });

  it('does not add peer warnings for compatible body/format-only edits and never treats missing callers as complete', async () => {
    const edit = input.calls[0].interfaceEdit as any;
    edit.changes = diffInterfaceConsequences(BEFORE, BEFORE.replace('return value;', 'return value.trim();'), 'target.ts');
    expect(edit.changes).toEqual([]);
    expect((await read()).byPath).toEqual({});
    expect(snapshotInterfaceLeg(input, snapshot)).toEqual([]);
    edit.changes = ['signature target'];
    snapshot.symbols = new Map();
    const context = await read();
    expect(context.byPath['target.ts']).toMatchObject({ status: 'unknown', peers: [] });
    expect(snapshotInterfaceLeg({ ...input, interfacePeerContext: context }, snapshot)[0].text).toContain('unknown');
  });

  it('uses the native bounded sink and interface identity; timeout and absent lock data remain unknown', async () => {
    const commit = vi.fn(async (_i, _s, facts, budget) => {
      expect(budget).toBe(1500);
      expect(facts).toHaveLength(1);
      expect(facts[0].leg).toBe('interface');
      return facts[0].text;
    });
    const deps = { snapshot: async () => snapshot, enabled: async () => true,
      legs: () => new Map([['interface' as const, snapshotInterfaceLeg]]),
      interfaceContext: read, commit };
    expect(await codeIntelPushText(input, deps)).toContain('su-work-peer');
    expect(commit).toHaveBeenCalledOnce();
    const failed = await readInterfacePeerContext(input, snapshot, { sql: db.adminSql, locks: async () => { throw Error('unavailable'); } });
    expect(failed.byPath['target.ts']).toMatchObject({ status: 'unknown', peers: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const timed = await codeIntelPushText(input, { ...deps,
        interfaceContext: () => new Promise(() => {}) });
      expect(timed).toContain('Live caller peers: unknown');
      expect(timed).not.toContain('su-work-peer');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code-intel-interface-peers exceeded 100ms'));
    } finally { warn.mockRestore(); }
  });

  it('records one issued interface row with peer citations in the real bounded ledger and deduplicates the epoch', async () => {
    const deps = { snapshot: async () => snapshot, enabled: async () => true,
      legs: () => new Map([['interface' as const, snapshotInterfaceLeg]]), interfaceContext: read, commit: commitPushFacts };
    const text = await codeIntelPushText(input, deps);
    expect(text).toContain('su-work-peer caller.ts (working-set)');
    expect(text.length).toBeLessThanOrEqual(1500);
    const rows = await db.adminSql`SELECT leg, cited_paths, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].leg).toBe('interface');
    expect(rows[0].cited_paths).toContain('caller.ts');
    expect(rows[0].chars).toBe(text.length);
    expect(await codeIntelPushText(input, deps)).toBe('');
  });
});
