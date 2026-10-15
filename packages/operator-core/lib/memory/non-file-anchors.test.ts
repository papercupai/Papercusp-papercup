import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAnchors, type Anchor } from './anchors';
import { nonFileAnchorChecker, runAnchorAudit, type AuditCheckers } from './audit-anchors';
import { _resetForTests, persistAnchorsSql, type SqlTag } from './persist-anchors';

const memoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const refs: Anchor[] = [
  { kind: 'work-item', value: 'WI-123' },
  { kind: 'decision', value: 'governed-memory-2026-10-14#D-007' },
  { kind: 'fact', value: 'guard-rail:safe' },
  { kind: 'session-turn', value: 'codex:host:session:42' },
  { kind: 'report', value: 'rpt_12345678-1234-1234-1234-123456789abc' },
];
const body = 'WI-123 governed-memory-2026-10-14#D-007 fact:guard-rail:safe '
  + 'session_turn:codex:host:session:42 report:rpt_12345678-1234-1234-1234-123456789abc';
const governed = new Set(refs.map(ref => ref.kind));

function audit(anchors: Anchor[], present: boolean, queries: string[] = []) {
  const checker = nonFileAnchorChecker({ query: async (query, params) => {
    expect(params?.[0]).toBe('ws-test');
    queries.push(query);
    return { rows: present ? [{}] : [] };
  } });
  const checkers: AuditCheckers = {
    file: checker, plan: checker, migration: checker, feature: checker,
    'work-item': checker, decision: checker, fact: checker, 'session-turn': checker, report: checker,
  };
  return runAnchorAudit({ memories: [{ memoryId, workspaceId: 'ws-test', anchors }], checkers });
}

describe('non-file anchor contract', () => {
  beforeEach(() => _resetForTests());

  it('extracts a typed anchor for every work item, decision, fact, session turn and report the text references', async () => {
    const anchors = extractAnchors(body).filter(anchor => governed.has(anchor.kind));
    expect(anchors).toEqual(refs);
    const sql = vi.fn(async () => undefined);
    expect(await persistAnchorsSql(sql as unknown as SqlTag, memoryId, anchors)).toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
    const [template, id, kinds, values] = sql.mock.calls[0] as unknown as [TemplateStringsArray, string, string[], string[]];
    expect(template.join('')).toContain('INSERT INTO harness_shared.memory_anchors');
    expect(id).toBe(memoryId);
    expect(kinds).toEqual(refs.map(ref => ref.kind));
    expect(values).toEqual(refs.map(ref => ref.value));
  });

  it.each(refs)('marks a memory broken when an anchored object no longer resolves ($kind)', async ref => {
    const anchors = extractAnchors(body).filter(anchor => anchor.kind === ref.kind);
    expect(anchors).toEqual([ref]);
    const missing = await audit(anchors, false);
    expect(missing.broken).toMatchObject([{ memoryId, hasBroken: true }]);
    expect(missing.all[0]?.anchors[0]).toMatchObject({ anchor: ref, ok: false });
    const resolving = await audit(anchors, true);
    expect(resolving.broken).toEqual([]);
    expect(resolving.all[0]?.hasBroken).toBe(false);
  });

  it('marks a memory broken when an anchored fact is retracted', async () => {
    const fact = refs.find(ref => ref.kind === 'fact')!;
    expect((await audit([fact], true)).broken).toEqual([]);
    const queries: string[] = [];
    const report = await audit([fact], false, queries);
    expect(queries[0]).toContain('retracted_at IS NULL');
    expect(queries[0]).toContain('superseded_at IS NULL');
    expect(queries[0]).toContain('evicted_at IS NULL');
    expect(report.broken).toMatchObject([{ memoryId, hasBroken: true }]);
  });
});
