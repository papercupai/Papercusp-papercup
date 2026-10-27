import { describe, it, expect } from 'vitest';
import {
  groupFilesForAttribution,
  mergeImportLinkedGroups,
  inheritCompanionDeclarationAttribution,
  attributionMapForRepo,
  agentsForScopedFiles,
  intentToSubject,
  coAuthorTrailer,
  clampSubject,
  diffDerivedSubject,
  parseNumstat,
  DEFAULT_GIT_SYNC_SUBJECT,
  type FileAttribution,
} from './git-sync-attribution';

describe('agentsForScopedFiles (P-006 assign-don\'t-broadcast)', () => {
  const roster = [
    { agent: 'ag1', files: ['apps/operator/x.ts'] },
    { agent: 'ag2', files: ['libs/papercusp/packages/y.ts'] },
  ];
  it('maps superproject + submodule-scoped files to their declaring agents (deduped)', () => {
    const agents = agentsForScopedFiles(roster, [
      { scope: 'superproject', file: 'apps/operator/x.ts' },
      { scope: 'libs/papercusp', file: 'packages/y.ts' }, // submodule-relative
      { scope: 'libs/papercusp', file: 'packages/y.ts' }, // dup → deduped
    ]);
    expect(agents.sort()).toEqual(['ag1', 'ag2']);
  });
  it('returns [] when nothing is attributable (caller falls back to broadcast)', () => {
    expect(agentsForScopedFiles(roster, [{ scope: 'superproject', file: 'unowned.ts' }])).toEqual([]);
  });
});

describe('attributionMapForRepo edit ages', () => {
  it('preserves the ledger timestamp for the repo-relative dirty path', () => {
    const map = attributionMapForRepo(
      [{ agent: 'su-old', files: ['packages/old.ts'], editedAtMsByFile: { 'packages/old.ts': 123 } }],
      '',
    );

    expect(map.get('packages/old.ts')).toMatchObject({ agent: 'su-old', editedAtMs: 123 });
  });
});

describe('groupFilesForAttribution (P-004)', () => {
  it('groups attributed files per agent + a catch-all remainder LAST', () => {
    const attr = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag2', agentLabel: 'Cup Two', intent: 'fix the parser' }],
      ['b.ts', { agent: 'ag1', agentLabel: 'Cup One', intent: 'add the flag' }],
      ['c.ts', { agent: 'ag2', agentLabel: 'Cup Two', intent: 'fix the parser' }],
    ]);
    const groups = groupFilesForAttribution(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], attr);

    // ag1, ag2 (sorted by id), then the catch-all (null) LAST.
    expect(groups.map((g) => g.agent)).toEqual(['ag1', 'ag2', null]);
    expect(groups[0]).toMatchObject({ agent: 'ag1', files: ['b.ts'], subject: 'add the flag (Cup One)' });
    expect(groups[1]).toMatchObject({ agent: 'ag2', files: ['a.ts', 'c.ts'] }); // sorted within
    expect(groups[1].subject).toBe('fix the parser (Cup Two)');
    expect(groups[1].coAuthor).toBe('Cup Two <ag2@agents.papercusp>');
    // remainder = the unattributed files, sorted, with the default subject + no co-author.
    expect(groups[2]).toEqual({ agent: null, files: ['d.ts', 'e.ts'], subject: DEFAULT_GIT_SYNC_SUBJECT, coAuthor: null });
  });

  it('orders attributed groups by oldest edit before provenance id, using mtime when needed', () => {
    const attr = new Map<string, FileAttribution>([
      ['new.ts', { agent: 'ag1', editedAtMs: 300 }],
      ['old.ts', { agent: 'z-agent', editedAtMs: 100 }],
      ['mtime.ts', { agent: 'm-agent' }],
    ]);
    const groups = groupFilesForAttribution(['new.ts', 'old.ts', 'mtime.ts', 'residual.ts'], attr, {
      workingTreeMtimeMsByFile: new Map([
        ['old.ts', 999], // a ledger timestamp remains authoritative when available
        ['mtime.ts', 200],
      ]),
    });

    expect(groups.map((group) => group.agent)).toEqual(['z-agent', 'm-agent', 'ag1', null]);
  });

  it('with no attribution, the only group is the catch-all over ALL files (flag-OFF degradation)', () => {
    const groups = groupFilesForAttribution(['x.ts', 'y.ts'], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ agent: null, files: ['x.ts', 'y.ts'], subject: DEFAULT_GIT_SYNC_SUBJECT, coAuthor: null });
  });

  it('the catch-all group is always present even when every file is attributed', () => {
    const attr = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1' }]]);
    const groups = groupFilesForAttribution(['a.ts'], attr);
    expect(groups.map((g) => g.agent)).toEqual(['ag1', null]);
    expect(groups[1].files).toEqual([]); // empty remainder — caller skips an empty add
  });
});

describe('mergeImportLinkedGroups (WI-6554700010019415)', () => {
  const groupsFor = (attr: Array<[string, FileAttribution]>, dirty: string[]) =>
    groupFilesForAttribution(dirty, new Map(attr), {
      workingTreeMtimeMsByFile: new Map(dirty.map((f, i) => [f, i])),
    });

  it('returns the same array when no edge crosses groups', () => {
    const groups = groupsFor([['a.ts', { agent: 'ag1', intent: 'one' }], ['b.ts', { agent: 'ag1', intent: 'two' }]], ['a.ts', 'b.ts']);
    expect(mergeImportLinkedGroups(groups, [])).toBe(groups);
    expect(mergeImportLinkedGroups(groups, [{ importer: 'a.ts', provider: 'a.ts' }])).toBe(groups);
  });

  it("merges one agent's import-linked groups under the earliest group, unioning work-items", () => {
    // 2026-10-21: scripts/lib/test-pass-reuse.mjs and its importers were edited under two intents,
    // so each private index excluded the other half and both stayed dirty for hours.
    const groups = groupsFor(
      [
        ['provider.mjs', { agent: 'ag1', intent: 'remove the max-age', workItems: ['WI-1'] }],
        ['importer.ts', { agent: 'ag1', intent: 'finish removing it', workItems: ['WI-2'], planSlug: 'plan-x' }],
        ['other.ts', { agent: 'ag2', intent: 'unrelated' }],
      ],
      ['provider.mjs', 'importer.ts', 'other.ts', 'loose.ts'],
    );
    expect(groups.map((g) => g.files)).toEqual([['provider.mjs'], ['importer.ts'], ['other.ts'], ['loose.ts']]);

    const merged = mergeImportLinkedGroups(groups, [{ importer: 'importer.ts', provider: 'provider.mjs' }]);

    expect(merged.map((g) => g.agent)).toEqual(['ag1', 'ag2', null]);
    expect(merged[0]).toMatchObject({
      agent: 'ag1',
      files: ['importer.ts', 'provider.mjs'],
      subject: groups[0].subject,
      workItems: ['WI-1', 'WI-2'],
    });
    expect(merged[1]).toBe(groups[2]);
    expect(merged[2]).toEqual(groups[3]);
  });

  // gate-systems-as-designed-2026-10-27 D-001 reverses the two WI-6554700010019415 rules that sent
  // these sets to the anonymous residual.
  it('commits a linked set that spans agents as ONE multi-author group carrying every author', () => {
    const groups = groupsFor(
      [
        ['router.ts', { agent: 'ag1', intent: 'router', workItems: ['WI-1'], sessionId: 's1', planSlug: 'p' }],
        ['router.test.ts', { agent: 'ag2', agentLabel: 'Cup Two', intent: 'its test', workItems: ['WI-2'], sessionId: 's2', planSlug: 'p' }],
        ['solo.ts', { agent: 'ag3' }],
      ],
      ['router.ts', 'router.test.ts', 'solo.ts', 'loose.ts'],
    );

    const merged = mergeImportLinkedGroups(groups, [{ importer: 'router.test.ts', provider: 'router.ts' }]);

    expect(merged.map((g) => g.agent)).toEqual(['ag1', 'ag3', null]);
    expect(merged[0]).toMatchObject({
      agent: 'ag1',
      agents: ['ag1', 'ag2'],
      coAuthors: ['ag1 <ag1@agents.papercusp>', 'Cup Two <ag2@agents.papercusp>'],
      files: ['router.test.ts', 'router.ts'],
      subject: groups[0].subject,
      workItems: ['WI-1', 'WI-2'],
      planSlug: 'p', // every member agrees
    });
    expect(merged[0].sessionId).toBeUndefined(); // s1 vs s2: belongs to no single session
    expect(merged[1]).toBe(groups[2]);
    expect(merged[2]).toEqual({ agent: null, files: ['loose.ts'], subject: DEFAULT_GIT_SYNC_SUBJECT, coAuthor: null });
  });

  it("keeps one agent's linked set under that agent and absorbs the linked residual files, transitively", () => {
    const groups = groupsFor(
      [['a.ts', { agent: 'ag1', intent: 'a' }], ['b.ts', { agent: 'ag1', intent: 'b' }]],
      ['a.ts', 'b.ts', 'script-written.ts', 'unlinked.ts'],
    );

    const merged = mergeImportLinkedGroups(groups, [
      { importer: 'a.ts', provider: 'b.ts' },
      { importer: 'script-written.ts', provider: 'b.ts' },
    ]);

    expect(merged.map((g) => [g.agent, g.files])).toEqual([
      ['ag1', ['a.ts', 'b.ts', 'script-written.ts']],
      [null, ['unlinked.ts']],
    ]);
    expect(merged[0]).toMatchObject({ subject: groups[0].subject, absorbedUnattributed: ['script-written.ts'] });
    expect(merged[0].agents).toBeUndefined(); // one author: no multi-author trailers
  });

  it('pulls only the linked residual FILE, so a residual linked to two agents does not join them', () => {
    // The whole residual used to be one union-find node: x.json reaching ag1 and y.json reaching
    // ag2 made {ag1, residual, ag2} one component and both agents went anonymous.
    const groups = groupsFor(
      [['one.ts', { agent: 'ag1', intent: 'one' }], ['two.ts', { agent: 'ag2', intent: 'two' }]],
      ['one.ts', 'two.ts', 'x.json', 'y.json', 'z.json'],
    );

    const merged = mergeImportLinkedGroups(groups, [
      { importer: 'one.ts', provider: 'x.json' },
      { importer: 'two.ts', provider: 'y.json' },
    ]);

    expect(merged.map((g) => [g.agent, g.files, g.absorbedUnattributed])).toEqual([
      ['ag1', ['one.ts', 'x.json'], ['x.json']],
      ['ag2', ['two.ts', 'y.json'], ['y.json']],
      [null, ['z.json'], undefined],
    ]);
  });

  it('leaves the groups untouched when edges link only residual files to each other', () => {
    const groups = groupsFor([['a.ts', { agent: 'ag1', intent: 'a' }]], ['a.ts', 'gen.mjs', 'gen.d.mts']);
    expect(mergeImportLinkedGroups(groups, [{ importer: 'gen.d.mts', provider: 'gen.mjs' }])).toBe(groups);
  });
});

describe('inheritCompanionDeclarationAttribution (WI-6554700010029864)', () => {
  const ag1: FileAttribution = { agent: 'ag1', intent: 'edit the launcher', workItems: ['WI-1'] };
  const ag2: FileAttribution = { agent: 'ag2', intent: 'edit the host', workItems: ['WI-2'] };

  it('gives a regenerated declaration its attributed source, for each declaration flavour', () => {
    const attribution = new Map<string, FileAttribution>([
      ['scripts/launcher.mjs', ag1],
      ['lib/util.ts', ag2],
      ['lib/legacy.cjs', ag2],
    ]);
    const dirty = ['scripts/launcher.mjs', 'scripts/launcher.d.mts', 'lib/util.d.ts', 'lib/legacy.d.cts'];

    const out = inheritCompanionDeclarationAttribution(dirty, attribution);

    expect(out.get('scripts/launcher.d.mts')).toBe(ag1);
    expect(out.get('lib/util.d.ts')).toBe(ag2);
    expect(out.get('lib/legacy.d.cts')).toBe(ag2);
    expect(attribution.has('scripts/launcher.d.mts')).toBe(false); // input map is not mutated
  });

  it('keeps an explicitly attributed declaration and returns the same map when nothing is inherited', () => {
    const attribution = new Map<string, FileAttribution>([
      ['scripts/launcher.mjs', ag1],
      ['scripts/launcher.d.mts', ag2],
    ]);

    expect(inheritCompanionDeclarationAttribution(['scripts/launcher.d.mts'], attribution)).toBe(attribution);
    // No attributed source: a generator-only pair stays in the residual.
    const none = new Map<string, FileAttribution>();
    expect(inheritCompanionDeclarationAttribution(['gen/tool.generated.d.mts', 'gen/tool.generated.mjs'], none)).toBe(none);
  });

  it('stops a regenerated declaration from dragging its agent group into the residual (e9d7f66f05 shape)', () => {
    // 2026-10-27T00:17Z: git-sync regenerated launcher.d.mts / host.d.mts, which had no ledger row;
    // each importer reached them, so "merged import-linked attribution groups (8 -> 2)" and both
    // agents' edits were committed as one unattributed lump.
    const attribution = new Map<string, FileAttribution>([
      ['scripts/launcher.mjs', ag1],
      ['lib/launcher.test.ts', ag1],
      ['scripts/host.mjs', ag2],
    ]);
    const dirty = ['scripts/launcher.mjs', 'scripts/launcher.d.mts', 'lib/launcher.test.ts', 'scripts/host.mjs', 'scripts/host.d.mts', 'loose.json'];
    const edges = [
      { importer: 'lib/launcher.test.ts', provider: 'scripts/launcher.d.mts' },
      { importer: 'scripts/host.d.mts', provider: 'scripts/host.mjs' },
    ];
    const opts = { workingTreeMtimeMsByFile: new Map(dirty.map((f, i) => [f, i])) };

    const expected = [
      ['ag1', ['lib/launcher.test.ts', 'scripts/launcher.d.mts', 'scripts/launcher.mjs']],
      ['ag2', ['scripts/host.d.mts', 'scripts/host.mjs']],
      [null, ['loose.json']],
    ];
    // Inheritance attributes the declarations before grouping, so nothing is absorbed.
    const inherited = mergeImportLinkedGroups(
      groupFilesForAttribution(dirty, inheritCompanionDeclarationAttribution(dirty, attribution), opts),
      edges,
    );
    expect(inherited.map((g) => [g.agent, g.files])).toEqual(expected);
    expect(inherited.some((g) => g.absorbedUnattributed)).toBe(false);

    // Without inheritance (any other unledgered linked file), D-001 part 2 still keeps both
    // agents' commits and names the absorbed declarations instead of making one lump.
    const absorbed = mergeImportLinkedGroups(groupFilesForAttribution(dirty, attribution, opts), edges);
    expect(absorbed.map((g) => [g.agent, g.files])).toEqual(expected);
    expect(absorbed.map((g) => g.absorbedUnattributed)).toEqual([['scripts/launcher.d.mts'], ['scripts/host.d.mts'], undefined]);
  });
});

describe('intentToSubject', () => {
  it('uses the intent + label, collapsing whitespace and clamping to 72 chars', () => {
    expect(intentToSubject('fix\n  the   parser', 'Cup')).toBe('fix the parser (Cup)');
    const long = 'x'.repeat(100);
    expect(intentToSubject(long, undefined).length).toBe(72);
  });
  it('clamps at a word boundary with an ellipsis instead of clipping mid-word (WI-38568)', () => {
    const intent = 'WI-38497 P-023: implement the auto-responder judge API, deterministic pre-send guardrail gate';
    const subject = intentToSubject(intent, undefined);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('…')).toBe(true);
    // Never ends mid-word: the char before the ellipsis is a whole word's end,
    // i.e. dropping the ellipsis leaves a prefix of the intent ending at a space.
    const stem = subject.slice(0, -1);
    expect(intent.startsWith(stem)).toBe(true);
    expect(intent[stem.length]).toBe(' ');
    // Trailing punctuation before the cut is trimmed rather than left dangling.
    expect(intentToSubject('b'.repeat(69) + ', xyz', undefined)).toBe('b'.repeat(69) + '…');
  });
  it('falls back to the default subject when the intent is empty/blank', () => {
    expect(intentToSubject('', 'Cup')).toBe(DEFAULT_GIT_SYNC_SUBJECT);
    expect(intentToSubject('   ', undefined)).toBe(DEFAULT_GIT_SYNC_SUBJECT);
    expect(intentToSubject(undefined, undefined)).toBe(DEFAULT_GIT_SYNC_SUBJECT);
  });
});

describe('coAuthorTrailer', () => {
  it('formats Name <email>, synthesizing an agents address when email is unknown', () => {
    expect(coAuthorTrailer({ agent: 'ag1', agentLabel: 'Cup One', email: 'b1@x.com' })).toBe('Cup One <b1@x.com>');
    expect(coAuthorTrailer({ agent: 'ag1', agentLabel: 'Cup One' })).toBe('Cup One <ag1@agents.papercusp>');
  });
  it('falls back to the agent id as the name, or null when there is no identity', () => {
    expect(coAuthorTrailer({ agent: 'ag1' })).toBe('ag1 <ag1@agents.papercusp>');
    expect(coAuthorTrailer({ agent: '' })).toBeNull();
  });
});

describe('attributionMapForRepo', () => {
  const roster = [
    { agent: 'ag1', agentLabel: 'One', intent: 'super work', files: ['apps/operator/x.ts', 'libs/papercusp/packages/y.ts'] },
    { agent: 'ag2', agentLabel: 'Two', intent: 'sub work', files: ['libs/papercusp/packages/z.ts'] },
  ];

  it('superproject (no prefix): maps top-level paths directly', () => {
    const m = attributionMapForRepo(roster, '');
    expect(m.get('apps/operator/x.ts')?.agent).toBe('ag1');
    // submodule-inner paths are kept but simply won't match superproject gitlink dirty paths.
    expect(m.get('libs/papercusp/packages/y.ts')?.agent).toBe('ag1');
  });

  it('submodule: strips the submodule prefix so paths match submodule-relative dirty paths', () => {
    const m = attributionMapForRepo(roster, 'libs/papercusp');
    expect(m.get('packages/y.ts')?.agent).toBe('ag1');
    expect(m.get('packages/z.ts')?.agent).toBe('ag2');
    // a file outside this submodule is dropped.
    expect(m.has('apps/operator/x.ts')).toBe(false);
  });

  it('tolerates ABSOLUTE current_files by stripping the superproject root (P-004 review)', () => {
    const absRoster = [{ agent: 'ag1', files: ['/home/u/papercup/apps/operator/x.ts'] }];
    // without superRoot: the absolute path doesn't match the repo-relative key.
    expect(attributionMapForRepo(absRoster, '').has('apps/operator/x.ts')).toBe(false);
    // with superRoot: stripped to the repo-relative key → matches.
    expect(attributionMapForRepo(absRoster, '', '/home/u/papercup').get('apps/operator/x.ts')?.agent).toBe('ag1');
    // submodule + absolute also works (strip super root, then the submodule prefix).
    const absSub = [{ agent: 'ag2', files: ['/home/u/papercup/libs/papercusp/packages/z.ts'] }];
    expect(attributionMapForRepo(absSub, 'libs/papercusp', '/home/u/papercup').get('packages/z.ts')?.agent).toBe('ag2');
  });

  it('first-declared wins when two agents claim the same path (locks serialize edits)', () => {
    const dup = [
      { agent: 'first', files: ['a.ts'] },
      { agent: 'second', files: ['a.ts'] },
    ];
    expect(attributionMapForRepo(dup, '').get('a.ts')?.agent).toBe('first');
  });
});

// ————— WI-38594: diff-derived subjects (pure halves) —————

describe('parseNumstat (WI-38594)', () => {
  it('parses added/deleted/path rows, null for binary, skipping non-matching lines', () => {
    const out = parseNumstat('10\t2\tapps/api/x.ts\n-\t-\tlogo.png\n\nwarning: junk\n5\t0\tdb/y.sql\n');
    expect(out).toEqual([
      { file: 'apps/api/x.ts', added: 10, deleted: 2 },
      { file: 'logo.png', added: null, deleted: null },
      { file: 'db/y.sql', added: 5, deleted: 0 },
    ]);
  });
});

describe('diffDerivedSubject (WI-38594)', () => {
  it('lists basenames for <=2 files with summed ±counts', () => {
    const files = ['apps/api/policy-rules.ts', 'apps/api/policy.types.ts'];
    const stats = parseNumstat('600\t0\tapps/api/policy-rules.ts\n69\t0\tapps/api/policy.types.ts');
    expect(diffDerivedSubject(files, stats)).toBe('sync(api): policy-rules.ts, policy.types.ts (2 files, +669/-0)');
  });

  it('falls to dir labels for >2 files, deduped, apps/* kept two segments', () => {
    const files = [
      'apps/api/a.ts',
      'apps/api/b.ts',
      'apps/api/c.ts',
      'apps/api/d.ts',
      'apps/api/e.ts',
      'db/m1.sql',
      'db/m2.sql',
    ];
    const stats = files.map((f, i) => ({ file: f, added: 100 + i, deleted: i }));
    expect(diffDerivedSubject(files, stats)).toBe('sync(api,db): apps/api + db (7 files, +721/-21)');
  });

  it('omits ±counts when stats are unavailable and treats binary (null) as 0', () => {
    expect(diffDerivedSubject(['db/x.sql'], undefined)).toBe('sync(db): x.sql (1 file)');
    const stats = [{ file: 'db/x.sql', added: null, deleted: null }];
    expect(diffDerivedSubject(['db/x.sql'], stats)).toBe('sync(db): x.sql (1 file, +0/-0)');
  });

  it('root files area as "root"; empty input degrades to the default subject', () => {
    expect(diffDerivedSubject(['README.md'], [{ file: 'README.md', added: 3, deleted: 0 }])).toBe(
      'sync(root): README.md (1 file, +3/-0)',
    );
    expect(diffDerivedSubject([], [])).toBe(DEFAULT_GIT_SYNC_SUBJECT);
  });

  it('degrades the middle instead of overflowing 72 chars', () => {
    // Two files whose basenames are far too long for the budget → falls to dir labels.
    const files = [
      'packages/operator-core/very-long-file-name-that-never-ends-at-all-truly.ts',
      'packages/operator-core/second-very-long-file-name-also-interminable.ts',
    ];
    const s = diffDerivedSubject(files, [
      { file: files[0], added: 1, deleted: 1 },
      { file: files[1], added: 1, deleted: 1 },
    ]);
    expect(s).toBe('sync(operator-core): packages/operator-core (2 files, +2/-2)');
    expect(s.length).toBeLessThanOrEqual(72);
  });

  it('caps a wide dir spread with +N more and stays within budget', () => {
    const files = ['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts', 'e/x.ts', 'f/x.ts'];
    const s = diffDerivedSubject(
      files,
      files.map((f) => ({ file: f, added: 1, deleted: 0 })),
    );
    expect(s).toBe('sync(a,b,c +3): a + b + c +3 more (6 files, +6/-0)');
    expect(s.length).toBeLessThanOrEqual(72);
  });
});

describe('clampSubject (WI-38568 extraction)', () => {
  it('returns short subjects unchanged and clamps long ones at a word boundary with …', () => {
    expect(clampSubject('short')).toBe('short');
    const long = 'word '.repeat(30).trim();
    const clamped = clampSubject(long);
    expect(clamped.length).toBeLessThanOrEqual(72);
    expect(clamped.endsWith('…')).toBe(true);
  });
});
