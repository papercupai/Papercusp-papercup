/**
 * based-on.test.ts — P-008's last leg (unified-agent-state-plane-2026-07-27, D-084):
 * `basedOn`, the sender's information provenance, derived from what it READ.
 *
 * WHAT THESE TESTS ARE FOR: the field this replaces was typed, threaded, rendered
 * — and never written, for weeks, with every suite green. So the assertions here
 * are about the VALUE ARRIVING and being TRUE, not about a mapper being called:
 * the mapping rules (which reads produce which ref), the de-dup/cap that keep the
 * trace a pointer set rather than a transcript, and the two honesty properties
 * that make the field worth reading at all — an unresolvable ref is stamped
 * UNVERSIONED rather than guessed, and a query nobody can name a ref for is
 * OMITTED rather than approximated.
 *
 * The DB-backed half (it actually lands on the envelope) is covered by the
 * integration test in coordination/tools; this file is pure.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/based-on.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  BASED_ON_MAX_ENTRIES,
  READ_REF_MAPPERS,
  READ_TOOL_NAMES,
  refsFromInvocations,
  versionRefs,
  type ReadInvocation,
} from './based-on';
import { stampMessageFields, projectAuthoredFields, ENVELOPE_ONLY_FIELDS } from './message-fields';

const at = (mins: number) => new Date(Date.UTC(2026, 6, 27, 12, 60 - mins)).toISOString();

const inv = (tool: string, args: unknown, minsAgo = 1): ReadInvocation => ({
  tool,
  args,
  readAt: at(minsAgo),
});

describe('the mapping table — which reads produce which ref', () => {
  it('maps a work-item read to a versionable `work-item:` tag, singular and plural', () => {
    expect(READ_REF_MAPPERS['work_items:get']!({ id: 'WI-6377' })).toEqual(['work-item:WI-6377']);
    expect(READ_REF_MAPPERS['work_items:get']!({ ids: ['WI-1', 'EI-2'] })).toEqual([
      'work-item:WI-1',
      'work-item:EI-2',
    ]);
  });

  it('maps every plan read shape to the same `plan:` tag', () => {
    expect(READ_REF_MAPPERS['plans:get']!({ slug: 'my-plan' })).toEqual(['plan:my-plan']);
    expect(READ_REF_MAPPERS['plans:get']!({ slugs: ['a', 'b'] })).toEqual(['plan:a', 'plan:b']);
    expect(READ_REF_MAPPERS['plans:get-item']!({ slug: 'p', itemIds: ['P-001'] })).toEqual(['plan:p']);
    expect(READ_REF_MAPPERS['plans:items']!({ slug: 'p' })).toEqual(['plan:p']);
  });

  it('maps rubrics:get singular and plural reads to the persisted rubric-template plan', () => {
    expect(READ_REF_MAPPERS['rubrics:get']!({ rubricRef: 'acceptance-rubric' })).toEqual([
      'plan:acceptance-rubric',
    ]);
    expect(READ_REF_MAPPERS['rubrics:get']!({ rubricRefs: ['rubric-a', 'rubric-b'] })).toEqual([
      'plan:rubric-a',
      'plan:rubric-b',
    ]);
  });

  it('maps accepted rubrics:get aliases and keeps canonical precedence', () => {
    expect(READ_REF_MAPPERS['rubrics:get']!({ ref: 'generic-ref' })).toEqual(['plan:generic-ref']);
    expect(READ_REF_MAPPERS['rubrics:get']!({ slug: 'caller-slug' })).toEqual(['plan:caller-slug']);
    expect(
      READ_REF_MAPPERS['rubrics:get']!({ rubricRef: 'canonical', ref: 'generic-ref', slug: 'caller-slug' }),
    ).toEqual(['plan:canonical']);
    expect(READ_REF_MAPPERS['rubrics:get']!({ slug: 'caller-slug', rubricRefs: ['bulk-a'] })).toEqual([
      'plan:caller-slug',
      'plan:bulk-a',
    ]);
  });

  it('maps a repo-relative file read, and REFUSES an absolute one', () => {
    // `file:` refs are repo-root-relative by contract. An absolute path names a
    // file in SOME tree — a tag that can never resolve is worse than no tag,
    // because it looks declared while being unable to ever invalidate.
    expect(READ_REF_MAPPERS['capability:read']!({ file_path: 'packages/x/a.ts' })).toEqual([
      'file:packages/x/a.ts',
    ]);
    expect(READ_REF_MAPPERS['capability:read']!({ file_path: '/etc/passwd' })).toEqual([]);
    expect(READ_REF_MAPPERS['capability:read']!({ file_path: '../outside.ts' })).toEqual([]);
  });

  it('has no mapper for a QUERY — a result set nobody can name is not a ref (D-084)', () => {
    // The trace's entire value is that every line in it is true. `facts:list` /
    // `work_items:list` / `search:*` read something real, but nothing in their
    // args names it, and an approximated ref would claim the sender saw a
    // specific thing it may never have seen.
    for (const query of ['work_items:list', 'facts:list', 'search:semantic', 'plans:list']) {
      expect(READ_TOOL_NAMES).not.toContain(query);
    }
    // Nor does a pipeline-position read become a file ref: the pipeline POSITION
    // of a file is not the file's bytes, so its token would move for a change
    // the sender never looked at.
    expect(READ_TOOL_NAMES).not.toContain('dev:pipeline_position');
  });
});

describe('refsFromInvocations — the trace is a pointer set, not a transcript', () => {
  it('keeps the MOST RECENT read of a ref, once', () => {
    const out = refsFromInvocations([
      inv('work_items:get', { id: 'WI-1' }, 1),
      inv('work_items:get', { id: 'WI-1' }, 9),
      inv('plans:get', { slug: 'p' }, 10),
    ]);
    expect(out.map((r) => r.ref)).toEqual(['work-item:WI-1', 'plan:p']);
    expect(out[0]!.readAt).toBe(at(1));
    expect(out[0]!.via).toBe('work_items:get');
  });

  it('caps the trace — an agent that read 40 items has a basis, not a transcript', () => {
    const rows = Array.from({ length: 40 }, (_, i) => inv('work_items:get', { id: `WI-${i}` }, i + 1));
    expect(refsFromInvocations(rows)).toHaveLength(BASED_ON_MAX_ENTRIES);
    expect(refsFromInvocations(rows, 3)).toHaveLength(3);
  });

  it('checks named subjects from a 23-item batch beyond eight later unrelated reads without fabricating missing reads', () => {
    const recent = Array.from({ length: 8 }, (_, i) => inv('work_items:get', { id: 'WI-' + (9000 + i) }, 1));
    const ids = Array.from({ length: 23 }, (_, i) => 'WI-' + (1000 + i));
    const rows = [...recent, inv('work_items:get', { ids }, 10)];
    const required = ['work-item:WI-1020', 'work-item:WI-1021', 'work-item:WI-1022', 'work-item:WI-99999'];
    const basis = refsFromInvocations(rows, BASED_ON_MAX_ENTRIES, required);
    expect(basis.slice(0, BASED_ON_MAX_ENTRIES)).toEqual(refsFromInvocations(rows));
    expect(basis.slice(BASED_ON_MAX_ENTRIES).map((entry) => entry.ref)).toEqual(required.slice(0, 3));
    expect(basis.map((entry) => entry.ref)).not.toContain('work-item:WI-99999');
    expect(basis.find((entry) => entry.ref === 'work-item:WI-1022')?.readAt).toBe(at(10));
  });

  it('skips unmapped tools and survives a malformed args bag', () => {
    const out = refsFromInvocations([
      inv('coord:send', { to: ['x'] }),
      inv('work_items:get', null),
      inv('work_items:get', { id: 42 }),
      inv('work_items:get', { id: '  ' }),
      inv('plans:get', { slug: 'p' }),
    ]);
    expect(out.map((r) => r.ref)).toEqual(['plan:p']);
  });

  it('returns [] rather than an empty-ish trace when nothing was read', () => {
    expect(refsFromInvocations([])).toEqual([]);
  });
});

describe('versionRefs — unversioned beats wrongly-versioned', () => {
  const ctx = { workspaceId: 'ws', harness: 'h' };

  it('carries the ref, the tool it was read through, and WHEN — always', async () => {
    // No PG here: every resolver fails, which is exactly the point — the entry
    // must still be emitted, just without a token.
    const out = await versionRefs([{ ref: 'work-item:WI-1', via: 'work_items:get', readAt: at(2) }], ctx);
    expect(out).toEqual([{ ref: 'work-item:WI-1', via: 'work_items:get', readAt: at(2) }]);
    expect(out[0]).not.toHaveProperty('versionAtSend');
  });

  it('never invents a token for a ref whose kind has no resolver', async () => {
    const out = await versionRefs([{ ref: 'msg:abc', via: 'coord:read', readAt: at(2) }], ctx);
    expect(out[0]!.versionAtSend).toBeUndefined();
  });
});

describe('the envelope contract (D-084 R1/R5)', () => {
  it('is stamped under `basedOn` — NOT `evidence`, which P-010’s band owns', () => {
    const stamp = stampMessageFields({
      body: 'hi',
      basedOn: [{ ref: 'work-item:WI-1', via: 'work_items:get', readAt: at(1) }],
    });
    expect(stamp.basedOn).toHaveLength(1);
    expect(stamp).not.toHaveProperty('evidence');
    expect(ENVELOPE_ONLY_FIELDS).toContain('basedOn');
    expect(ENVELOPE_ONLY_FIELDS).not.toContain('evidence');
  });

  it('OMITS the field when nothing was read — an empty trace is not a false one', () => {
    expect(stampMessageFields({ body: 'hi', basedOn: [] })).not.toHaveProperty('basedOn');
    expect(stampMessageFields({ body: 'hi' })).not.toHaveProperty('basedOn');
  });

  it('reads back off the envelope through the SAME projection every surface uses', () => {
    const entry = {
      ref: 'plan:unified-agent-state-plane-2026-07-27',
      via: 'plans:get',
      readAt: at(3),
      versionAtSend: 'v167',
    };
    const projected = projectAuthoredFields({ basedOn: [entry] });
    expect(projected?.basedOn).toEqual([entry]);
  });

  it('coexists with P-010’s evidence BAND on one envelope — the collision D-084 fixes', () => {
    // Before the rename these were the same key: an array here read as a
    // MALFORMED band, so a message could carry the trace or the band, never
    // both, and nothing said so.
    const envelope = {
      evidence: { band: 'tool-output', ref: 'tsc exit 2' },
      basedOn: [{ ref: 'work-item:WI-1', via: 'work_items:get', readAt: at(1) }],
    };
    expect(projectAuthoredFields(envelope)?.basedOn).toHaveLength(1);
    // The band is untouched by the projection and still readable by its own reader.
    expect(envelope.evidence.band).toBe('tool-output');
  });
});
