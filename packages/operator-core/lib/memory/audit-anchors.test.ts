import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runAnchorAudit,
  fileChecker,
  planCheckerPg,
  migrationChecker,
  featureChecker,
  isExternalFileAnchor,
  classifyFileAnchor,
  nonFileAnchorChecker,
  type AuditCheckers,
  type MemoryWithAnchors,
} from './audit-anchors';

describe('non-file anchor audit', () => {
  const refs = [
    { kind: 'work-item', value: 'WI-123' }, { kind: 'decision', value: 'memory-2026-10-14#D-001' },
    { kind: 'fact', value: 'guard-rail:safe' }, { kind: 'session-turn', value: 'codex:abc:4' },
    { kind: 'report', value: 'rpt_12345678-1234-1234-1234-123456789abc' },
  ] as const;
  it.each(refs)('marks missing $kind evidence broken and restores it when it resolves', async anchor => {
    let present = false;
    const checker = nonFileAnchorChecker({ query: async (_query, params) => {
      expect(params?.[0]).toBe('ws');
      return { rows: present ? [{}] : [] };
    } });
    const options = { memories: [{ memoryId: 'm', workspaceId: 'ws', anchors: [anchor] }],
      checkers: { file: checker, plan: checker, migration: checker, feature: checker, [anchor.kind]: checker } };
    expect((await runAnchorAudit(options)).broken[0].hasBroken).toBe(true);
    present = true;
    expect((await runAnchorAudit(options)).broken).toEqual([]);
  });
  it('refuses to validate a fact after retraction and scopes the live-state query', async () => {
    let retracted = false;
    const checker = nonFileAnchorChecker({ query: async (query, params) => {
      expect(query).toContain('retracted_at IS NULL');
      expect(query).toContain('superseded_at IS NULL');
      expect(params).toEqual(['ws', 'safe']);
      return { rows: retracted ? [] : [{}] };
    } });
    expect(await checker({ kind: 'fact', value: 'safe' }, { memoryId: 'm', workspaceId: 'ws', anchors: [] })).toEqual({ ok: true });
    retracted = true;
    expect(await checker({ kind: 'fact', value: 'safe' }, { memoryId: 'm', workspaceId: 'ws', anchors: [] })).toMatchObject({ ok: false });
  });
});

const okChecker = async () => ({ ok: true } as const);
const fixedNow = () => '2026-05-25T00:00:00.000Z';

const allOk: AuditCheckers = {
  file: okChecker,
  plan: okChecker,
  migration: okChecker,
  feature: okChecker,
  symbol: okChecker,
};

describe('runAnchorAudit — empty + happy paths', () => {
  it('handles empty memory list', async () => {
    const r = await runAnchorAudit({ memories: [], checkers: allOk, now: fixedNow });
    expect(r.memoriesChecked).toBe(0);
    expect(r.anchorsChecked).toBe(0);
    expect(r.anchorsBroken).toBe(0);
    expect(r.memoriesBroken).toBe(0);
    expect(r.broken).toEqual([]);
  });

  it('handles memory with no anchors', async () => {
    const mems: MemoryWithAnchors[] = [{ memoryId: 'm1', anchors: [] }];
    const r = await runAnchorAudit({ memories: mems, checkers: allOk, now: fixedNow });
    expect(r.memoriesChecked).toBe(1);
    expect(r.anchorsChecked).toBe(0);
    expect(r.all[0].hasBroken).toBe(false);
  });

  it('all anchors pass — no breakage', async () => {
    const mems: MemoryWithAnchors[] = [{
      memoryId: 'm1',
      anchors: [
        { kind: 'file', value: 'apps/operator/lib/foo.ts' },
        { kind: 'feature', value: 'F-001' },
      ],
    }];
    const r = await runAnchorAudit({ memories: mems, checkers: allOk, now: fixedNow });
    expect(r.anchorsChecked).toBe(2);
    expect(r.anchorsBroken).toBe(0);
    expect(r.broken).toEqual([]);
  });
});

describe('runAnchorAudit — broken anchors', () => {
  it('flags memory when any anchor fails', async () => {
    const mems: MemoryWithAnchors[] = [{
      memoryId: 'm1',
      anchors: [
        { kind: 'file', value: 'gone.ts' },
        { kind: 'feature', value: 'F-001' },
      ],
    }];
    const checkers: AuditCheckers = {
      ...allOk,
      file: async () => ({ ok: false, reason: 'file_not_found' }),
    };
    const r = await runAnchorAudit({ memories: mems, checkers, now: fixedNow });
    expect(r.anchorsBroken).toBe(1);
    expect(r.memoriesBroken).toBe(1);
    expect(r.broken[0].memoryId).toBe('m1');
    expect(r.broken[0].anchors[0].ok).toBe(false);
    expect(r.broken[0].anchors[0].reason).toBe('file_not_found');
    expect(r.broken[0].anchors[1].ok).toBe(true);
  });

  it('multiple broken memories accumulate correctly', async () => {
    const mems: MemoryWithAnchors[] = [
      { memoryId: 'm1', anchors: [{ kind: 'file', value: 'a.ts' }] },
      { memoryId: 'm2', anchors: [{ kind: 'feature', value: 'F-X' }] },
      { memoryId: 'm3', anchors: [{ kind: 'file', value: 'b.ts' }] },
    ];
    const checkers: AuditCheckers = {
      ...allOk,
      file: async () => ({ ok: false, reason: 'file_not_found' }),
    };
    const r = await runAnchorAudit({ memories: mems, checkers, now: fixedNow });
    expect(r.memoriesChecked).toBe(3);
    expect(r.memoriesBroken).toBe(2);
    expect(r.anchorsBroken).toBe(2);
    expect(r.broken.map((m) => m.memoryId).sort()).toEqual(['m1', 'm3']);
  });

  it('checker that throws is treated as broken (not propagated)', async () => {
    const mems: MemoryWithAnchors[] = [{
      memoryId: 'm1',
      anchors: [{ kind: 'file', value: 'a.ts' }],
    }];
    const checkers: AuditCheckers = {
      ...allOk,
      file: async () => { throw new Error('disk error'); },
    };
    const r = await runAnchorAudit({ memories: mems, checkers, now: fixedNow });
    expect(r.anchorsBroken).toBe(1);
    expect(r.broken[0].anchors[0].reason).toBe('checker_threw:disk error');
  });

  it('symbol anchors skip with default checker', async () => {
    const mems: MemoryWithAnchors[] = [{
      memoryId: 'm1',
      anchors: [{ kind: 'symbol', value: 'getHarnessAdminUrl' }],
    }];
    // No symbol checker provided
    const { symbol: _, ...checkersWithoutSymbol } = allOk;
    const r = await runAnchorAudit({
      memories: mems,
      checkers: checkersWithoutSymbol as AuditCheckers,
      now: fixedNow,
    });
    expect(r.anchorsBroken).toBe(0);
    expect(r.all[0].anchors[0].ok).toBe(true);
  });
});

/* ─── Standard checkers — file/plan/migration backed by tmpdir ──────── */

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchors-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('fileChecker', () => {
  it('passes when file exists under repoRoot', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'apps/operator/lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps/operator/lib/foo.ts'), '');
    const c = fileChecker(tmpRoot);
    const r = await c({ kind: 'file', value: 'apps/operator/lib/foo.ts' });
    expect(r.ok).toBe(true);
  });

  it('fails when file missing', async () => {
    const c = fileChecker(tmpRoot);
    const r = await c({ kind: 'file', value: 'missing/file.ts' });
    expect(r).toEqual({ ok: false, reason: 'file_not_found' });
  });
});

describe('isExternalFileAnchor — paths the repo-root check can never resolve (skip, not broken)', () => {
  it.each([
    '/usr/lib/Papercusp/sidecar/serve.mjs',
    '~/.papercusp/operator.json',
    '../sibling/thing.ts',
    'claude/.credentials.json',
    'papercusp/endpoint-ipc.json',
    'papercusp/embedded-pg.json',
    'usr/lib/x.mjs',
    'root/fedproto-wg-down.sh',
    'tmp/mcp_call.sh',
    'cargo/config.toml',
    'omp/agent/auth.json',
    'papercup-rust-mobile/crates/papercup-core/lib.rs',
    'Restart/libs/storage.ts',
  ])('treats %s as external', (v) => {
    expect(isExternalFileAnchor(v)).toBe(true);
  });

  it.each([
    'packages/operator-core/lib/foo.ts', // normal repo-relative
    'locks/acquire.ts', // package-relative (resolved by basename, not external)
    'libs/papercusp/libs/db/sql/107-x.sql',
  ])('does NOT treat repo-shaped %s as external', (v) => {
    expect(isExternalFileAnchor(v)).toBe(false);
  });
});

describe('classifyFileAnchor — exact / external / basename-resolve / broken', () => {
  const index = new Map<string, string[]>([
    ['acquire.ts', ['packages/operator-core/lib/agent-tools/locks/acquire.ts']],
    ['index.ts', ['a/index.ts', 'b/index.ts']], // ambiguous basename
    ['survey.ts', ['packages/operator-core/lib/hive/survey.ts', 'packages/operator-core/lib/agent-tools/scout/survey.ts']],
  ]);
  const deps = {
    exists: (rel: string) => rel === 'packages/operator-core/lib/real.ts',
    basenameMatches: (b: string) => index.get(b) ?? [],
  };

  it('exact existing path → ok with no reason', () => {
    expect(classifyFileAnchor('packages/operator-core/lib/real.ts', deps)).toEqual({ ok: true });
  });

  it('external path → ok (skipped)', () => {
    expect(classifyFileAnchor('claude/.credentials.json', deps)).toEqual({ ok: true, reason: 'external' });
  });

  it('package-relative with a UNIQUE basename → resolved', () => {
    expect(classifyFileAnchor('locks/acquire.ts', deps)).toEqual({
      ok: true,
      reason: 'resolved_by_basename',
      resolved: 'packages/operator-core/lib/agent-tools/locks/acquire.ts',
    });
  });

  it('ambiguous basename (>1, no unique suffix) → broken (real signal preserved)', () => {
    expect(classifyFileAnchor('index.ts', deps)).toEqual({ ok: false, reason: 'file_not_found' });
  });

  it('ambiguous basename BUT a unique 2-segment suffix → resolved', () => {
    expect(classifyFileAnchor('hive/survey.ts', deps)).toEqual({
      ok: true,
      reason: 'resolved_by_basename',
      resolved: 'packages/operator-core/lib/hive/survey.ts',
    });
  });

  it('genuinely missing (no match, not external) → broken', () => {
    expect(classifyFileAnchor('deleted/gone.ts', deps)).toEqual({ ok: false, reason: 'file_not_found' });
  });
});

describe('planCheckerPg', () => {
  it('passes when the injected lookup finds the plan', async () => {
    const c = planCheckerPg(async () => true);
    const r = await c({ kind: 'plan', value: 'my-plan-2026-05-25' });
    expect(r.ok).toBe(true);
  });

  it('fails when the plan slug is not found', async () => {
    const c = planCheckerPg(async () => false);
    const r = await c({ kind: 'plan', value: 'ghost-2026-01-01' });
    expect(r).toEqual({ ok: false, reason: 'plan_not_found' });
  });

  it('reports a lookup failure as the reason', async () => {
    const c = planCheckerPg(async () => {
      throw new Error('db down');
    });
    const r = await c({ kind: 'plan', value: 'x-2026-01-01' });
    expect(r).toEqual({ ok: false, reason: 'plan_lookup_failed:db down' });
  });
});

describe('migrationChecker', () => {
  it('finds migration by 3-digit prefix', async () => {
    const sqlDir = path.join(tmpRoot, 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(sqlDir, '081-memory-canonical.sql'), '');
    const c = migrationChecker(sqlDir);
    expect((await c({ kind: 'migration', value: '081' })).ok).toBe(true);
  });

  it('finds migration when value is bare number string', async () => {
    const sqlDir = path.join(tmpRoot, 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(sqlDir, '042-foo.sql'), '');
    const c = migrationChecker(sqlDir);
    expect((await c({ kind: 'migration', value: '42' })).ok).toBe(true);
  });

  it('fails when no matching prefix', async () => {
    const sqlDir = path.join(tmpRoot, 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(path.join(sqlDir, '081-memory.sql'), '');
    const c = migrationChecker(sqlDir);
    const r = await c({ kind: 'migration', value: '999' });
    expect(r).toEqual({ ok: false, reason: 'migration_not_found' });
  });

  it('fails gracefully when sqlDir missing', async () => {
    const c = migrationChecker(path.join(tmpRoot, 'no-such-dir'));
    const r = await c({ kind: 'migration', value: '081' });
    expect(r).toEqual({ ok: false, reason: 'sql_dir_not_readable' });
  });
});

describe('featureChecker', () => {
  it('uses injected lookup', async () => {
    const c = featureChecker(async (id) => id === 'F-001');
    expect((await c({ kind: 'feature', value: 'F-001' })).ok).toBe(true);
    expect((await c({ kind: 'feature', value: 'F-999' })).ok).toBe(false);
  });

  it('reports failure when lookup throws', async () => {
    const c = featureChecker(async () => { throw new Error('PG down'); });
    const r = await c({ kind: 'feature', value: 'F-001' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('feature_lookup_failed:PG down');
  });
});
