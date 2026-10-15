/**
 * carry-brief — unit tests (compaction-continuity-hardening-2026-07-07 P-003).
 *
 * The builder is exercised through its injectable seams (no PG); the renderers
 * are pure. The load-bearing contracts:
 *   - every read leg is independently best-effort (a throwing reader yields an
 *     empty section, never a failed brief);
 *   - the focus renderer is HARD-capped and pointer-styled (ids, not copies);
 *   - the cold-extras renderer skips empty sections and caps per-entry bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import { getWorkItem, type WorkItem } from './work-items';
import { bodyRefWorkItemResolver } from './agent-tools/coordination/ref-hydrate-resolve';
import {
  buildCarryBrief,
  assessHeldItemOwnership,
  readHeldWorkItems,
  readCurrentSessionStartedAtMs,
  readDeferredWorkItems,
  renderCarryBriefFocus,
  renderCarryBriefColdExtras,
  AGED_WALL_RESCOPE_PROMPT_MS,
  renderCarryBriefText,
  renderHeldItemOwnershipWarning,
  renderDeferredWorkItems,
  detectIdleNoteGuard,
  deriveCarryQueryHandles,
  renderCarryQueryHandlesBlock,
  parseCitedRefStateTag,
  parseCitedLiveState,
  detectCarryNoteRefs,
  detectTerminalCitedRefs,
  renderCitedRefLivenessSections,
  annotateCarryNoteLiveContradictions,
  detectRetractionShapedLines,
  renderPostNoteInboxLine,
  unverifiedFocusRefs,
  renderFocusIntegrityWarning,
  CARRY_BRIEF_FOCUS_MAX,
  CARRY_BRIEF_MAX_FACTS,
  CARRY_BRIEF_MAX_AWAITS,
  CARRY_BRIEF_MAX_DEFERRED_ITEMS,
  CARRY_QUERY_HANDLES_MAX,
  CARRY_QUERY_HANDLES_HEADING,
  type CarryBrief,
  type CarryBriefHeldItem,
  type CarryBriefDeferredItem,
  type BuildCarryBriefOpts,
} from './carry-brief';
import { shortCarryHash } from './carry-note';

const carryConversationMocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getConsultStates: vi.fn(),
}));

vi.mock('./agent-tools/coordination/conversations', () => carryConversationMocks);

vi.mock('./work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-items')>();
  return { ...actual, getWorkItem: vi.fn() };
});
vi.mock('./work-item-checkpoint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-item-checkpoint')>();
  return { ...actual, getWorkItemCheckpoint: vi.fn().mockResolvedValue(null) };
});
const mockedGetWorkItem = vi.mocked(getWorkItem);

/** Minimal tagged-template `sql` stub returning fixed `engineer_issues` rows. */
function fakeIssuesSql(
  rows: Array<{
    issue_id: string;
    title: string | null;
    body: string | null;
    scope: string;
    taken_by?: string | null;
    workspace_id?: string | null;
    last_progress_at?: string | number | Date | null;
  }>,
) {
  return ((_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve(rows)) as unknown as never;
}

function fullOpts(overrides: Partial<BuildCarryBriefOpts> = {}): BuildCarryBriefOpts {
  return {
    workspaceId: 'ws-test',
    getLoopStatusFn: async () => ({ harnessSlug: 'papercusp', active: true, intervalSec: 120, carry: 'cold' as const }),
    getLoopCarryNoteWithMetaFn: async () => ({
      note: '## Did\nlanded the thing\n\n## Next action\nship P-004',
      updatedAtMs: Date.now() - 5 * 60_000,
    }),
    readHeldWorkItemsFn: async () => [
      {
        id: 'WI-3319',
        title: 'Shared carry-brief builder',
        body: 'One function assembles the carry brief.',
        harness: 'papercusp',
        checkpoint: 'wired request-compaction; watchdog next',
        holderProof: { ownerId: 'su-abc', workspaceId: 'ws-test' },
      },
    ],
    listOwnerFactsFn: async () => [{ key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' }],
    listActiveAwaitsFn: async () => [
      { eventKey: 'coord:inbox-wake:su-abc', note: 'always-armed inbox-wake' },
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ],
    getFleetFn: async () => ({ slug: 'bug-drain', role: 'leader' }),
    listOpenDirectivesFn: async () => ({ rows: [], totalOpen: 0 }),
    readByocReleaseCarriesFn: async () => [],
    // P-002/P-003 seams (cold-carry-system-hardening-2026-07-19): hermetic defaults so
    // unit tests never reach the real coordination/inbox readers.
    hydrateNoteRefsFn: async () => [],
    readPostNoteInboxFn: async () => ({ count: 0, lines: [] }),
    // Deferred-work carry is also a live PG leg; keep the existing pure builder
    // fixtures hermetic and inject it only in tests that exercise that feature.
    readDeferredWorkItemsFn: async () => [],
    ...overrides,
  };
}

/** An open owner-directive row (EI-11484) for the render tests. */
function directive(id: number, text: string) {
  return {
    id,
    workspaceId: 'ws-test',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: null,
    verbatimText: text,
    recordedBy: 'su-abc',
    createdAtMs: Date.now() - 60_000,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
  };
}

describe('buildCarryBrief — assembly + per-leg fail-soft', () => {
  it('assembles every section from the injected readers', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.ownerId).toBe('su-abc');
    expect(brief.loop).toMatchObject({ harness: 'papercusp', active: true, intervalSec: 120, carry: 'cold' });
    expect(brief.loop?.carryNote).toContain('ship P-004');
    expect(brief.loop?.carryNoteUpdatedAtMs).toBeTypeOf('number');
    expect(brief.heldItems.map((h) => h.id)).toEqual(['WI-3319']);
    expect(brief.facts).toEqual([
      { key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' },
    ]);
    expect(brief.fleet).toEqual({ slug: 'bug-drain', role: 'leader' });
  });

  it('filters infra inbox-wake awaits and keeps real ones', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.awaits).toEqual([
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ]);
  });

  it('caps facts and awaits at the section bounds', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOwnerFactsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, body: `b${i}` })),
        listActiveAwaitsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ eventKey: `ev:${i}`, note: null })),
      }),
    );
    expect(brief.facts.length).toBe(CARRY_BRIEF_MAX_FACTS);
    expect(brief.awaits.length).toBe(CARRY_BRIEF_MAX_AWAITS);
  });

  it('a throwing leg yields that section empty, never a failed brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopStatusFn: async () => {
          throw new Error('pg down');
        },
        readHeldWorkItemsFn: async () => {
          throw new Error('pg down');
        },
        readByocReleaseCarriesFn: async () => {
          throw new Error('pg down');
        },
        readDeferredWorkItemsFn: async () => {
          throw new Error('pg down');
        },
        listOwnerFactsFn: async () => {
          throw new Error('pg down');
        },
        listActiveAwaitsFn: async () => {
          throw new Error('pg down');
        },
        getFleetFn: async () => {
          throw new Error('pg down');
        },
        listOpenDirectivesFn: async () => {
          throw new Error('pg down');
        },
        checkFactsStalenessFn: async () => {
          throw new Error('embedder down');
        },
      }),
    );
    expect(brief).toEqual({
      ownerId: 'su-abc',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      // P-026 leg (b) (WI-5141): facts is empty, so the staleness leg short-circuits
      // to [] without even reaching its own throwing seam here — still asserted.
      factsStaleness: [],
      awaits: [],
      fleet: null,
    });
  });

  it('starts independent roots together and chains dependent reads only to their prerequisites', async () => {
    let releaseRoots!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });
    const started: string[] = [];
    const root = async <T>(name: string, value: T): Promise<T> => {
      started.push(name);
      await rootGate;
      return value;
    };
    const dependencyInputs: Record<string, unknown> = {};
    const noteUpdatedAtMs = Date.parse('2026-09-13T20:00:00.000Z');
    const held: CarryBriefHeldItem[] = [
      {
        id: 'WI-42',
        title: 'parallel carry',
        body: null,
        harness: 'papercusp',
        checkpoint: null,
      },
    ];
    const building = buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: () => root('directives', { rows: [], totalOpen: 0 }),
        getLoopStatusFn: () =>
          root('loop', { harnessSlug: 'papercusp', active: true, intervalSec: 120, carry: 'warm' as const }),
        readHeldWorkItemsFn: () => root('held', held),
        readDeferredWorkItemsFn: () => root('deferred', []),
        listOwnerFactsFn: () => root('facts', [{ key: 'k', body: 'b' }]),
        listActiveAwaitsFn: () => root('awaits', [{ eventKey: 'deploy:done', note: null }]),
        getFleetFn: () => root('fleet', { slug: 'f', role: 'member' }),
        getLoopCarryNoteWithMetaFn: async () => {
          started.push('note');
          return { note: '## Next action\nfinish WI-42', updatedAtMs: noteUpdatedAtMs };
        },
        readByocReleaseCarriesFn: async (_ownerId, _workspaceId, heldIds) => {
          started.push('releases');
          dependencyInputs.releases = heldIds;
          return [];
        },
        hydrateNoteRefsFn: async (note, heldItems) => {
          started.push('hydrate');
          dependencyInputs.hydrate = { note, heldIds: heldItems?.map((item) => item.id) };
          return ['WI-42 [feature/open]'];
        },
        readPostNoteInboxFn: async (_ownerId, sinceIso) => {
          started.push('inbox');
          dependencyInputs.inbox = sinceIso;
          return { count: 1, lines: ['- peer: correction'] };
        },
        checkFactsStalenessFn: async (facts) => {
          started.push('staleness');
          dependencyInputs.staleness = facts;
          return [];
        },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(new Set(started)).toEqual(new Set(['directives', 'loop', 'held', 'deferred', 'facts', 'awaits', 'fleet']));

    releaseRoots();
    const brief = await building;
    expect(started).toEqual(expect.arrayContaining(['note', 'releases', 'hydrate', 'inbox', 'staleness']));
    expect(dependencyInputs).toEqual({
      releases: ['WI-42'],
      hydrate: { note: '## Next action\nfinish WI-42', heldIds: ['WI-42'] },
      inbox: '2026-09-13T20:00:00.000Z',
      staleness: [{ key: 'k', body: 'b' }],
    });
    expect(brief).toMatchObject({
      heldItems: held,
      citedRefs: ['WI-42 [feature/open]'],
      postNoteInbox: { count: 1 },
      facts: [{ key: 'k', body: 'b' }],
      awaits: [{ eventKey: 'deploy:done', note: null }],
      fleet: { slug: 'f', role: 'member' },
    });
  });

  it('parses open walls out of the loop note (P-006) — structured rows on the brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note:
            '## Next action\nship P-006\n\n## Walls\n' +
            '- 3 zombie PIDs 95902/200903/220406 await owner OK to kill — re-check: ps -o pid,rss -p 95902,200903,220406 (since 2026-07-07T12:00:00.000Z)',
          updatedAtMs: Date.now(),
        }),
      }),
    );
    expect(brief.walls).toEqual([
      {
        claim: '3 zombie PIDs 95902/200903/220406 await owner OK to kill',
        recheck: 'ps -o pid,rss -p 95902,200903,220406',
        sinceMs: Date.parse('2026-07-07T12:00:00.000Z'),
      },
    ]);
    // The note itself stays verbatim on the brief (walls included).
    expect(brief.loop?.carryNote).toContain('## Walls');
  });

  it('a loop with no carry-note still reports the loop (note null)', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
    );
    expect(brief.loop).toMatchObject({ harness: 'papercusp', carryNote: null });
  });

  it('preserves a failed carry-note read as distinct from a confirmed empty note', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null, readFailed: true }),
      }),
    );
    expect(brief.loop).toMatchObject({
      carryNote: null,
      carryNoteUpdatedAtMs: null,
      carryNoteReadFailed: true,
    });
    expect(brief.checks).toEqual([]);
    expect(brief.walls).toEqual([]);
  });

  it('no loop routine ⇒ loop null', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts({ getLoopStatusFn: async () => null }));
    expect(brief.loop).toBeNull();
  });

  it('carries this-session deferred work from the injected reader', async () => {
    const deferred: CarryBriefDeferredItem[] = [
      {
        id: 'EI-21769',
        title: 'finish the next experiment',
        body: 'Run the focused regression.',
        harness: null,
        kind: 'bug',
        source: 'created',
      },
    ];
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readDeferredWorkItemsFn: async (ownerId, workspaceId) => {
          expect(ownerId).toBe('su-abc');
          expect(workspaceId).toBe('ws-test');
          return deferred;
        },
      }),
    );
    expect(brief.deferredItems).toEqual(deferred);
    expect(renderCarryBriefFocus(brief)).toContain('EI-21769');
    expect(renderCarryBriefText(brief)).toContain('DEFERRED, UNCLAIMED WORK');
  });

  it('a throwing deferred-work reader fails soft without disturbing the brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readDeferredWorkItemsFn: async () => {
          throw new Error('work-item store unavailable');
        },
      }),
    );
    expect(brief.deferredItems).toBeUndefined();
    expect(brief.loop?.carryNote).toContain('ship P-004');
    expect(brief.heldItems).toHaveLength(1);
  });
});

describe('note-citation hydration + post-note delta (cold-carry-system-hardening-2026-07-19 P-002/P-003)', () => {
  it('default hydration resolves exact, unique-prefix, and missing conversation refs in the selected workspace', async () => {
    const { currentRequestWorkspaceId } = await import('./workspace-als');
    carryConversationMocks.getConversation.mockImplementation(async (id: string) => {
      expect(currentRequestWorkspaceId()).toBe('ws-test');
      if (id === 'conv-open') {
        return {
          conversation: { id: 'conv-open', kind: 'question', state: 'open', title: 'Open ask', body: 'Waiting for the owner.' },
        };
      }
      if (id === 'conv-resolved') {
        return {
          conversation: { id: 'conv-resolved-full', kind: 'question', state: 'resolved', title: 'Resolved ask', body: 'The owner answered.' },
          resolvedFromPrefix: id,
        };
      }
      return null;
    });
    carryConversationMocks.getConsultStates.mockResolvedValue(new Map());

    const note = '## Walls\n- Awaiting answers on conv-open and conv-resolved; check conv-missing.';
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        workspaceId: 'ws-test',
        getLoopCarryNoteWithMetaFn: async () => ({ note, updatedAtMs: Date.now() - 60_000 }),
        hydrateNoteRefsFn: undefined,
      }),
    );
    const citedRefs = brief.citedRefs ?? [];
    const activeLine = citedRefs.find((line) => line.includes('conv-open')) ?? '';
    const resolvedLine = citedRefs.find((line) => line.includes('conv-resolved-full')) ?? '';

    expect(carryConversationMocks.getConversation.mock.calls.map(([id]) => id)).toEqual([
      'conv-open',
      'conv-resolved',
      'conv-missing',
    ]);
    expect(activeLine).toContain('conv-open [conversation/open]');
    expect(resolvedLine).toContain('conv-resolved-full [conversation/resolved]');
    expect(resolvedLine).toContain('requested: conv-resolved');
    expect(citedRefs.join('\n')).toContain('conversation:conv-missing — unresolved (not_found)');
    expect(parseCitedRefStateTag(activeLine)).toEqual({ id: 'conv-open', state: 'open' });
    expect(parseCitedRefStateTag(resolvedLine)).toEqual({ id: 'conv-resolved-full', state: 'resolved' });
    expect(detectTerminalCitedRefs([activeLine, resolvedLine])).toEqual(['conv-resolved-full']);
    expect(annotateCarryNoteLiveContradictions(note, [resolvedLine])).toContain(
      '⚠ LIVE: conv-resolved-full status=resolved',
    );
    expect(carryConversationMocks.getConsultStates).not.toHaveBeenCalled();
  });

  it('keeps consult_state separate from the conversation state in default hydration', async () => {
    const { currentRequestWorkspaceId } = await import('./workspace-als');
    carryConversationMocks.getConversation.mockImplementation(async (id: string) => {
      expect(id).toBe('conv-consult');
      expect(currentRequestWorkspaceId()).toBe('ws-test');
      return {
        conversation: { id, kind: 'consult', state: 'open', title: 'Consult request', body: 'Consult lifecycle is separate.' },
      };
    });
    carryConversationMocks.getConsultStates.mockImplementation(async (ids: string[]) => {
      expect(ids).toEqual(['conv-consult']);
      expect(currentRequestWorkspaceId()).toBe('ws-test');
      return new Map([['conv-consult', { conversation_id: 'conv-consult', state: 'expired' }]]);
    });

    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        workspaceId: 'ws-test',
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Walls\n- Consult conv-consult is awaiting its lifecycle check.',
          updatedAtMs: Date.now() - 60_000,
        }),
        hydrateNoteRefsFn: undefined,
      }),
    );
    const consultLine = brief.citedRefs?.find((line) => line.includes('conv-consult')) ?? '';

    expect(consultLine).toContain('conv-consult [conversation/open]');
    expect(consultLine).toContain('(consult_state=expired)');
    expect(parseCitedRefStateTag(consultLine)).toEqual({ id: 'conv-consult', state: 'open' });
    expect(detectTerminalCitedRefs([consultLine])).toEqual([]);
  });

  it('P-003 keeps the complete directed-message sender usable for a coord:send reply', () => {
    const sender = 'su-respawn-1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const sibling = 'su-respawn-1-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const line = renderPostNoteInboxLine({
      from: sender,
      ts: '2026-09-12T22:59:18.429Z',
      summary: 'Please answer this recovery question.',
    });

    // A 12-character prefix (`su-respawn-1`) is ambiguous against `sibling`;
    // the carry line must retain the exact ownerId that coord:send accepts.
    expect(line).toContain(`- ${sender} (`);
    expect(line).not.toContain(`- ${sender.slice(0, 12)} (`);
    expect(line).toContain('Please answer this recovery question.');
  });

  it('qualifies bare plan-item ids only through a unique held work-item binding', () => {
    const held = [
      {
        id: 'WI-6389',
        title: 'Implement P-026',
        body: null,
        harness: 'papercusp',
        checkpoint: null,
        sourcePlanSlug: 'learning-tab-surface-public-release-2026-07-27',
        sourcePlanItemIds: ['P-026'],
      },
    ];
    expect(
      detectCarryNoteRefs('P-026 BUILD NOT STARTED; verify WI-6389', held),
    ).toEqual([
      {
        kind: 'plan-item',
        slug: 'learning-tab-surface-public-release-2026-07-27',
        item: 'P-026',
      },
      { kind: 'work-item', id: 'WI-6389' },
    ]);

    // P-NNN is not globally unique. Two held lanes with the same item id must
    // stay unresolved rather than selecting whichever row happened to sort first.
    expect(
      detectCarryNoteRefs('resume P-026', [
        ...held,
        { ...held[0]!, id: 'WI-7000', sourcePlanSlug: 'another-plan' },
      ]),
    ).toEqual([]);
  });

  it('resolves a three-digit WI suffix to one held long id and leaves ambiguous aliases unresolved', () => {
    const held = [
      {
        id: 'WI-6554700010008548',
        title: 'Held item',
        body: null,
        harness: 'papercusp',
        checkpoint: null,
      },
    ];
    const fullId = { kind: 'work-item' as const, id: 'WI-6554700010008548' };

    // The short token used to resolve as the unrelated literal WI-548. The
    // carry lookup now follows the unique held item, and a simultaneous full
    // reference deduplicates to that same authoritative id.
    expect(detectCarryNoteRefs('resume WI-548', held)).toEqual([fullId]);
    expect(detectCarryNoteRefs('resume WI-548 (WI-6554700010008548)', held)).toEqual([fullId]);

    // A real short id remains resolvable when no held long id claims its suffix.
    expect(detectCarryNoteRefs('inspect WI-548', [])).toEqual([
      { kind: 'work-item', id: 'WI-548' },
    ]);

    // If two live held rows share the suffix, do not choose either one or
    // hydrate a potentially unrelated literal row into a false TERMINAL claim.
    expect(
      detectCarryNoteRefs('resume WI-548', [
        ...held,
        { ...held[0]!, id: 'WI-7777700010008548' },
      ]),
    ).toEqual([]);
  });

  it('P-002: hydrates the ids the note cites via the injected seam and renders them under the note', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\nBuild WI-5391 item 3; sha lies (WI-5397)',
          updatedAtMs: Date.now() - 60_000,
        }),
        hydrateNoteRefsFn: async (noteText) => {
          expect(noteText).toContain('WI-5391');
          return ['WI-5391 [bug/open @b37b0]: "failover…"', 'WI-5397 [bug/resolved]: "sha defect…"'];
        },
      }),
    );
    expect(brief.citedRefs).toHaveLength(2);
    const text = renderCarryBriefText(brief);
    expect(text).toContain('LIVE status (trust these over');
    expect(text).toContain('↪ WI-5391 [bug/open');
    expect(text).toContain('WI-5397 [bug/resolved]');
  });

  it('P-003: folds the post-note inbox delta with the PREDATES warning; quiet delta renders nothing', async () => {
    const withMail = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readPostNoteInboxFn: async (_owner, sinceIso) => {
          expect(Date.parse(sinceIso)).not.toBeNaN();
          return { count: 3, lines: ['- su-7c298e1b (2026-07-19T02:25:40Z): STOP — do not anchor…'] };
        },
      }),
    );
    expect(withMail.postNoteInbox?.count).toBe(3);
    const text = renderCarryBriefText(withMail);
    expect(text).toContain('3 directed message(s) landed AFTER this carry-note');
    expect(text).toContain('the note PREDATES them');
    expect(text).toContain('STOP — do not anchor');

    const quiet = await buildCarryBrief('su-abc', fullOpts());
    expect(renderCarryBriefText(quiet)).not.toContain('landed AFTER this carry-note');
  });

  it('both legs fail soft: a throwing seam leaves the brief usable', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        hydrateNoteRefsFn: async () => {
          throw new Error('resolver down');
        },
        readPostNoteInboxFn: async () => {
          throw new Error('inbox down');
        },
      }),
    );
    expect(brief.loop?.carryNote).toBeTruthy();
    expect(brief.citedRefs ?? []).toEqual([]);
    expect(brief.postNoteInbox ?? null).toBeNull();
    expect(() => renderCarryBriefText(brief)).not.toThrow();
  });

  it('no note ⇒ neither leg runs', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }),
        hydrateNoteRefsFn: async () => {
          throw new Error('must not be called');
        },
        readPostNoteInboxFn: async () => {
          throw new Error('must not be called');
        },
      }),
    );
    expect(brief.citedRefs).toBeUndefined();
    expect(brief.postNoteInbox).toBeUndefined();
  });
});

describe('stale-note contradiction detector (EI-18726068732447732)', () => {
  it('parseCitedRefStateTag extracts the id + state from a rendered cited-ref line', () => {
    expect(parseCitedRefStateTag('WI-5391 [bug/open @b37b0]: "failover…"')).toEqual({
      id: 'WI-5391',
      state: 'open',
    });
    expect(parseCitedRefStateTag('↪ EI-18700974567040702 [bug/done]: "MainPID 0…"')).toEqual({
      id: 'EI-18700974567040702',
      state: 'done',
    });
    // No recognizable id/tag ⇒ null, never a throw or a false positive.
    expect(parseCitedRefStateTag('some unrelated prose')).toBeNull();
    expect(parseCitedRefStateTag('')).toBeNull();
  });

  it('detectTerminalCitedRefs flags only the terminal ones, derived from ANY_FAMILY_TERMINAL_STATES', () => {
    const ids = detectTerminalCitedRefs([
      'WI-5391 [bug/open @b37b0]: "failover…"',
      'WI-5397 [bug/resolved]: "sha defect…"',
      'WI-6054 [bug/done]: "MainPID 0…"',
      'WI-9999 [feature/blocked]: "needs a decision…"',
    ]);
    expect(ids).toEqual(['WI-5397', 'WI-6054']);
  });

  it('renderCarryBriefText surfaces a loud contradiction banner + inline flag when a cited ref is terminal', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\nverify then work_items:complete WI-6054 citing that line',
          updatedAtMs: Date.now() - 60_000,
        }),
        hydrateNoteRefsFn: async () => ['WI-6054 [bug/done @su-397]: "already fixed + closed…"'],
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text).toContain('STALE-NOTE CONTRADICTION');
    expect(text).toContain('WI-6054');
    expect(text).toContain('already TERMINAL');
    expect(text).toContain('⚠ TERMINAL ↪ WI-6054 [bug/done');
    expect(text).toContain('WI-6054 citing that line   ⚠ LIVE: WI-6054 status=done');
  });

  it('qualifies a terminal plan item and marks the stale prose on the same line', async () => {
    const note = 'P-026 (wip, claimed) — SCOPED via D-083, BUILD NOT STARTED';
    const live =
      'plan:learning-tab-surface-public-release-2026-07-27#P-026 [done]: "already shipped"';
    expect(parseCitedLiveState(live)).toEqual({
      id: 'plan:learning-tab-surface-public-release-2026-07-27#P-026',
      mention: 'P-026',
      state: 'done',
    });
    expect(annotateCarryNoteLiveContradictions(note, [live])).toBe(
      `${note}   ⚠ LIVE: plan:learning-tab-surface-public-release-2026-07-27#P-026 status=done`,
    );

    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({ note, updatedAtMs: Date.now() - 60_000 }),
        readHeldWorkItemsFn: async () => [
          {
            id: 'WI-6389',
            title: 'Implement P-026',
            body: null,
            harness: 'papercusp',
            checkpoint: null,
            sourcePlanSlug: 'learning-tab-surface-public-release-2026-07-27',
            sourcePlanItemIds: ['P-026'],
          },
        ],
        hydrateNoteRefsFn: async (_text, heldItems) => {
          expect(heldItems?.[0]).toMatchObject({ sourcePlanSlug: 'learning-tab-surface-public-release-2026-07-27' });
          return [live];
        },
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text).toContain(`${note}   ⚠ LIVE: plan:learning-tab-surface-public-release-2026-07-27#P-026 status=done`);
    expect(text).toContain('⚠ TERMINAL ↪ plan:learning-tab-surface-public-release-2026-07-27#P-026 [done]');
    expect(text).toContain('STALE-NOTE CONTRADICTION');
  });

  it('renderCarryBriefText stays quiet (no banner) when every cited ref is still active', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\ncheck on WI-5391',
          updatedAtMs: Date.now() - 60_000,
        }),
        hydrateNoteRefsFn: async () => ['WI-5391 [bug/open @b37b0]: "failover…"'],
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text).not.toContain('STALE-NOTE CONTRADICTION');
    expect(text).not.toContain('⚠ TERMINAL');
    expect(text).toContain('↪ WI-5391 [bug/open');
  });
});

describe('scorecard cited-ref audit lifecycle', () => {
  const id = 'EI-24058248122493506';

  const renderWithAuditState = async (auditState: string): Promise<string> => {
    mockedGetWorkItem.mockReset();
    mockedGetWorkItem.mockResolvedValue({
      id,
      kind: 'change',
      state: 'done',
      title: 'Terminal acceptance card',
      summary: 'The card was filed before its grading audit settled.',
      assignee: null,
      closedAt: '2026-09-23T13:15:30.000Z',
      payload: { observation: { gradingAudit: { state: auditState } } },
    } as unknown as WorkItem);

    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\nIf the grading audit passed, complete ' + id,
          updatedAtMs: Date.now() - 60_000,
        }),
        readHeldWorkItemsFn: async () => [],
        // Exercise the production detect → hydrate → render path.
        hydrateNoteRefsFn: undefined,
      }),
    );
    return renderCarryBriefText(brief);
  };

  it('keeps a done-status card non-terminal while its grading audit is pending, then flags settled audits', async () => {
    const pending = await renderWithAuditState('pending');
    expect(pending).toContain(id + ' [change/audit-pending');
    expect(pending).toContain('card filed, audit pending');
    expect(pending).not.toContain('STALE-NOTE CONTRADICTION');
    expect(pending).not.toContain('⚠ TERMINAL ↪ ' + id);

    const pendingBodyRef = await bodyRefWorkItemResolver(
      { kind: 'work-item', id },
      { snippetChars: 200, maxRefs: 3 },
    );
    expect(pendingBodyRef?.label).toContain(id + ' [change/audit-pending');
    expect(pendingBodyRef?.snippet).toContain('card filed, audit pending');
    expect(pendingBodyRef?.terminalSubject).toBeUndefined();

    for (const state of ['passed', 'failed']) {
      const settled = await renderWithAuditState(state);
      expect(settled).toContain('⚠ TERMINAL ↪ ' + id + ' [change/done');
      expect(settled).toContain('card filed, audit ' + state);
    }
  });
});

describe('retraction-shaped post-note messages (EI-19408487308624743)', () => {
  it('detectRetractionShapedLines flags only lines that read as a correction/retraction', () => {
    const lines = detectRetractionShapedLines([
      '- su-707029c (2026-08-03T04:46:53Z): RETRACTION: the 727-freeze framing was wrong, gate went green at 02:18Z',
      '- su-abc1234 (2026-08-03T04:47:00Z): heads-up, staging restarted for an unrelated reason',
      '- su-def5678 (2026-08-03T04:48:00Z): correction — that migration already applied, disregard my prior message',
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('RETRACTION');
    expect(lines[1]).toContain('correction');
  });

  it('renderCarryBriefText surfaces a loud POSSIBLE RETRACTION banner ahead of the generic post-note list', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\nRESUME HERE: db:migrate 727, it is the single thing blocking main for the whole fleet',
          updatedAtMs: Date.now() - 60_000,
        }),
        readPostNoteInboxFn: async () => ({
          count: 2,
          lines: [
            '- su-707029c (…): I was wrong about 727 being the freeze — retracting that, gate is green',
            '- su-abc1234 (…): unrelated staging restart FYI',
          ],
        }),
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text).toContain('POSSIBLE RETRACTION AFTER THIS NOTE');
    expect(text).toContain('WITHDRAWN');
    expect(text).toContain('I was wrong about 727');
    // The loud banner must appear BEFORE the generic "N directed message(s)" list.
    expect(text.indexOf('POSSIBLE RETRACTION')).toBeLessThan(
      text.indexOf('directed message(s) landed AFTER'),
    );
  });

  it('stays quiet (no banner) when post-note messages carry no retraction language', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readPostNoteInboxFn: async () => ({
          count: 1,
          lines: ['- su-abc1234 (…): heads-up, unrelated staging restart'],
        }),
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text).not.toContain('POSSIBLE RETRACTION');
    expect(text).toContain('directed message(s) landed AFTER');
  });

  it('no post-note messages at all ⇒ neither banner renders', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    const text = renderCarryBriefText(brief);
    expect(text).not.toContain('POSSIBLE RETRACTION');
    expect(text).not.toContain('landed AFTER this carry-note');
  });
});

describe('renderCarryBriefFocus — the /compact focus line', () => {
  it('names the real anchors as pointers, not copies', async () => {
    const focus = renderCarryBriefFocus(await buildCarryBrief('su-abc', fullOpts()));
    expect(focus).toContain('WI-3319');
    expect(focus).toContain('POINTERS');
    expect(focus).toContain('armed loop @papercusp 120s');
    expect(focus).toContain('zombie-pids-wall');
    expect(focus).toContain('deploy:done:release-77');
    expect(focus).toContain('fleet bug-drain (leader)');
    // The standing preserve set stays first; the drop clause survives.
    expect(focus.startsWith('keep the identity block')).toBe(true);
    expect(focus).toContain('drop resolved tool output');
    // It must NOT copy checkpoint/note bodies.
    expect(focus).not.toContain('wired request-compaction');
    expect(focus).not.toContain('ship P-004');
  });

  it('an empty brief renders exactly the standing preserve set', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(empty);
    expect(focus).toBe(
      'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.',
    );
  });

  it('carries open walls VERBATIM, ahead of held items (P-006)', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [{ id: 'WI-1', title: null, body: null, harness: 'h', checkpoint: null }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [{ claim: 'zombie PIDs await owner OK', recheck: 'ps -p 95902', sinceMs: 1 }],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(brief);
    expect(focus).toContain('OPEN WALLS (carry verbatim, do not re-declare resolved): "zombie PIDs await owner OK"');
    expect(focus.indexOf('OPEN WALLS')).toBeLessThan(focus.indexOf('WI-1'));
  });

  it('is HARD-capped at the focus max, ellipsis-marked, for any brief size', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readHeldWorkItemsFn: async () =>
          Array.from({ length: 6 }, (_, i) => ({
            id: `WI-${9000 + i}`,
            title: 'long '.repeat(40),
            body: null,
            harness: 'papercusp',
            checkpoint: null,
          })),
        listOwnerFactsFn: async () =>
          Array.from({ length: 8 }, (_, i) => ({ key: `a-very-long-standing-fact-key-${i}`, body: 'x' })),
      }),
    );
    const focus = renderCarryBriefFocus(brief);
    expect(focus.length).toBeLessThanOrEqual(CARRY_BRIEF_FOCUS_MAX);
    expect(focus.endsWith('…')).toBe(true);
    // Held-item ids outrank facts under truncation (ordered most-load-bearing first).
    expect(focus).toContain('WI-9000');
  });
});

describe('unverifiedFocusRefs / renderFocusIntegrityWarning (EI-22131227584499489)', () => {
  const ownNoteText = '## Did\nlanded the thing\n\n## Next action\nship P-004';
  const ownHash = shortCarryHash(ownNoteText);

  const brief: CarryBrief = {
    ownerId: 'su-abc',
    loop: {
      harness: 'papercusp',
      active: true,
      intervalSec: 120,
      carry: 'cold',
      goal: null,
      carryNote: ownNoteText,
      carryNoteUpdatedAtMs: Date.now(),
    },
    heldItems: [{ id: 'WI-3319', title: null, body: null, harness: 'papercusp', checkpoint: null }],
    deferredItems: [
      {
        id: 'WI-6554700010010741',
        title: 'Acceptance review-target reservation',
        body: null,
        harness: 'papercusp',
        kind: 'task',
        source: 'commented',
      },
    ],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
  };

  it('flags a WI id and a carry-note hash that are NOT the owner\'s own', () => {
    // The exact shape observed in EI-22131227584499489: a judge-role successor's
    // focus named another live owner's held item + loop carry-note short-hash.
    const text =
      "Resume the gate-red repair. Read the loop carry-note (e5729a1f033a) and " +
      "WI-2140920's checkpoint before acting.";
    const refs = unverifiedFocusRefs(text, brief);
    expect(refs.workItemIds).toEqual(['WI-2140920']);
    expect(refs.carryHashes).toEqual(['e5729a1f033a']);

    const warning = renderFocusIntegrityWarning(refs);
    expect(warning).toContain('⚠ FOCUS INTEGRITY');
    expect(warning).toContain('WI-2140920');
    expect(warning).toContain('carry-note e5729a1f033a');
  });

  it('does NOT flag this session\'s commented-on review target, even though it is not held', () => {
    const refs = unverifiedFocusRefs('Continue grading WI-6554700010010741.', brief);
    expect(refs).toEqual({ workItemIds: [], carryHashes: [] });
    expect(renderFocusIntegrityWarning(refs)).toBe('');
  });

  it('does NOT flag the owner\'s own held item id or its own loop carry-note hash (no false positive)', () => {
    const text = `resume WI-3319 — carry-note (${ownHash}) still applies`;
    const refs = unverifiedFocusRefs(text, brief);
    expect(refs).toEqual({ workItemIds: [], carryHashes: [] });
    expect(renderFocusIntegrityWarning(refs)).toBe('');
  });

  it('a text with no ids/hashes at all yields no findings and an empty warning', () => {
    const refs = unverifiedFocusRefs('just keep going, nothing to resume', brief);
    expect(refs).toEqual({ workItemIds: [], carryHashes: [] });
    expect(renderFocusIntegrityWarning(refs)).toBe('');
  });

  it('a null brief flags everything found (no owner state to corroborate against)', () => {
    const refs = unverifiedFocusRefs('resume WI-2140920, carry-note (e5729a1f033a)', null);
    expect(refs.workItemIds).toEqual(['WI-2140920']);
    expect(refs.carryHashes).toEqual(['e5729a1f033a']);
  });

  it("renderCarryBriefFocus's own system-derived output never trips the detector", async () => {
    // The system-derived default focus only ever names ids drawn FROM the brief
    // and never prints a hash literal — it must never false-positive here, or
    // every ordinary /compact focus would carry a spurious integrity caution.
    const fullBrief = await buildCarryBrief('su-abc', fullOpts());
    const focus = renderCarryBriefFocus(fullBrief);
    const refs = unverifiedFocusRefs(focus, fullBrief);
    expect(refs).toEqual({ workItemIds: [], carryHashes: [] });
    expect(renderFocusIntegrityWarning(refs)).toBe('');
  });
});

describe('held-item ownership proof (EI-22416393595299704)', () => {
  it('accepts only an exact concrete owner/workspace proof', () => {
    const item = {
      holderProof: { ownerId: 'owner-x', workspaceId: 'ws-1' },
    };
    expect(assessHeldItemOwnership('owner-x', 'ws-1', item)).toEqual({
      verified: true,
      holderOwnerId: 'owner-x',
      holderWorkspaceId: 'ws-1',
    });
    expect(assessHeldItemOwnership('owner-x', 'ws-1', {})).toMatchObject({
      verified: false,
      failure: 'missing-proof',
    });
    expect(assessHeldItemOwnership('owner-x', 'ws-1', {
      holderProof: { ownerId: 'other-owner', workspaceId: 'ws-1' },
    })).toMatchObject({
      verified: false,
      failure: 'owner-mismatch',
    });
    expect(assessHeldItemOwnership('owner-x', 'ws-1', {
      holderProof: { ownerId: 'owner-x', workspaceId: 'other-workspace' },
    })).toMatchObject({
      verified: false,
      failure: 'workspace-mismatch',
    });
  });

  it('downgrades an unverified focus item to a read-only pointer', () => {
    const brief: CarryBrief = {
      ownerId: 'owner-x',
      workspaceId: 'ws-1',
      loop: null,
      heldItems: [{
        id: 'WI-unsafe',
        title: 'another agent private title',
        body: 'another agent private body',
        harness: 'h',
        checkpoint: 'another agent private checkpoint',
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(brief);
    expect(focus).toContain('unverified carried work-items WI-unsafe');
    expect(focus).not.toContain('held work-items WI-unsafe');
  });

  it('renders only a warning for an owner-mismatched cold item and leaks no carried content', () => {
    const brief: CarryBrief = {
      ownerId: 'owner-x',
      workspaceId: 'ws-1',
      loop: null,
      heldItems: [{
        id: 'WI-unsafe',
        title: 'another agent private title',
        body: 'another agent private body',
        harness: 'h',
        checkpoint: 'another agent private checkpoint',
        holderProof: { ownerId: 'other-owner', workspaceId: 'ws-1' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('UNVERIFIED CARRIED WORK');
    expect(out).toContain("holder proof names owner 'other-owner'");
    expect(out).toContain(renderHeldItemOwnershipWarning('owner-x', 'ws-1', brief.heldItems[0]!));
    expect(out).not.toContain('You HELD these work-items');
    expect(out).not.toContain('another agent private title');
    expect(out).not.toContain('another agent private body');
    expect(out).not.toContain('another agent private checkpoint');
  });
});

describe('renderCarryBriefColdExtras — the cold-anchor sections after the note', () => {
  it('warns when a held checkpoint carries a predecessor exec handle across a carry-respawn', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'EI-21309858082119709',
        title: 'queued lint verification',
        body: null,
        harness: 'papercusp',
        checkpoint: 'run npm run lint:tsc; poll write_stdin(session_id=59998) for the verdict',
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('CARRIED TRANSIENT EXEC HANDLE(S)');
    expect(out).toContain('EI-21309858082119709');
    expect(out).toContain('Do NOT call `write_stdin` with that carried id');
    expect(out).toContain('durable spill/log/work-item evidence');
    expect(out).toContain('fresh exec');
    expect(out.indexOf('CARRIED TRANSIENT EXEC HANDLE')).toBeLessThan(out.indexOf('You HELD'));
  });

  it('detects device-auth exec handle lists in a held work-item body and avoids relaunch advice', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'EI-24725415810702425',
        title: 'pending native Codex device-login process',
        body: 'Launched codex login --device-auth via exec_command; saved exec handles 12345/23456/34567 are process-local.',
        harness: 'papercusp',
        checkpoint: null,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    const warning = out.slice(out.indexOf('CARRIED DEVICE-AUTH EXEC HANDLE'), out.indexOf('You HELD'));

    expect(warning).toContain('prior code has expired');
    expect(warning).toContain('capability:bash` tracked-task flow');
    expect(warning).toContain('capability:bash_output');
    expect(warning).not.toContain('fresh exec');
    expect(warning).not.toContain('12345');
  });

  it('P-029: renders NEVER-DROP fact keys, ahead of the owner-scoped standing-facts block', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      // An OWNER-scoped standing fact, deliberately DIFFERENT from the
      // never-drop keys below: the two blocks carry different folds, and this
      // fixture is what proves the new one is not just re-rendering `facts`.
      facts: [{ key: 'convention:owner-scoped-example', body: 'a standing convention' }],
      neverDropFacts: ['dead-end:identity-stale-artifact', 'wall:capital-arming'],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('NEVER-DROP facts');
    expect(out).toContain('dead-end:identity-stale-artifact');
    expect(out).toContain('wall:capital-arming');
    // The WORKSPACE leg is the substance of P-029, so the block must tell its
    // reader the list is not owner-only — otherwise a successor reconciling it
    // against the owner-scoped block below reads the difference as corruption.
    expect(out).toContain('WORKSPACE');
    expect(out).toContain("facts:list { scope: 'workspace' }");
    // Guard rails lead the facts family: a successor that reads nothing else
    // must still read these.
    expect(out.indexOf('NEVER-DROP facts')).toBeLessThan(out.indexOf('Your standing facts'));
  });

  it('P-029: the never-drop block survives composition into the CARRY DOCUMENT renderer', () => {
    // THE END-TO-END PIN, and the reason it is separate from the cold-extras
    // tests above. P-029's subject is the carry DOCUMENT, and the document does
    // not call `renderCarryBriefColdExtras` itself: carry-doc.ts calls
    // `renderCarryBriefText`, which composes its own sections and appends the
    // cold extras at the tail. A refactor that stopped appending them — or that
    // stripped this field the way `directives`/`citedRefs` are deliberately
    // stripped to avoid double-rendering — would leave every cold-extras test
    // above green while the document silently lost its guard rails again.
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      neverDropFacts: ['dead-end:identity-stale-artifact'],
      awaits: [],
      fleet: null,
    };

    const text = renderCarryBriefText(brief);
    expect(text).toContain('NEVER-DROP facts');
    expect(text).toContain('dead-end:identity-stale-artifact');
  });

  it('P-029: omits the never-drop block entirely when the fold found nothing', () => {
    // ABSENT, not an empty-looking "none apply" line. A rendered empty block
    // would read as a measured all-clear, which is indistinguishable from the
    // degraded read that `bestEffort` turns into `undefined`.
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [{ key: 'convention:owner-scoped-example', body: 'a standing convention' }],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    expect(out).not.toContain('NEVER-DROP facts');
    // Control: the renderer still ran and still produced the sibling block, so
    // the absence above is a real omission rather than an empty render.
    expect(out).toContain('Your standing facts');
  });

  it('warns for the live Markdown-wrapped typecheck-session checkpoint shape', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'EI-21548341570090165',
        title: 'interrupted operator-core verification',
        body: null,
        harness: 'papercusp',
        checkpoint: 'poll the operator-core typecheck session `11400` for the verdict',
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('CARRIED TRANSIENT EXEC HANDLE(S)');
    expect(out).toContain('EI-21548341570090165');
    expect(out).toContain('Do NOT call `write_stdin` with that carried id');
  });

  it('does not warn for a checkpoint that only names a stable native session', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-1',
        title: null,
        body: null,
        harness: 'papercusp',
        checkpoint: 'resume native agent session 59998 after the carry-respawn; no transient exec handle is carried',
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    expect(renderCarryBriefColdExtras(brief)).not.toContain('CARRIED TRANSIENT EXEC HANDLE');
  });

  it('renders held items with capped checkpoints, facts, awaits, and the fleet pointer', async () => {
    const out = renderCarryBriefColdExtras(await buildCarryBrief('su-abc', fullOpts()));
    expect(out).toContain('You HELD these work-items');
    expect(out).toContain('WI-3319 — Shared carry-brief builder');
    expect(out).toContain('checkpoint: wired request-compaction; watchdog next');
    expect(out).toContain('zombie-pids-wall: 3 zombie PIDs await owner OK to kill');
    expect(out).toContain('armed awaits are still live');
    expect(out).toContain('deploy:done:release-77');
    expect(out).toContain('Fleet: you are in "bug-drain" as leader');
    // The loop note is the injection core, NOT part of the extras.
    expect(out).not.toContain('ship P-004');
    // EI-18665023147548277: the held-items block is built BEFORE the old session's
    // SessionEnd/Stop lifecycle event fires and releases every claim it held — so a
    // "HOLD" listed here can already be stale by the time the successor reads it.
    // The caution must say so explicitly and point at the live re-verify path,
    // never assert the hold as settled fact.
    expect(out).toContain('CAUTION (EI-18665023147548277)');
    expect(out).toContain('re-verify with work_items:get');
    expect(out).toContain('re-claim');
  });

  it('P-012 renders the verified source quote instead of dropping the answer one step from the reader', () => {
    const candidate = '1f43e05ae7a88ebed626c84ff254a0b1508937d6';
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [
        {
          key: 'freeze-directive',
          body: 'Never cut a fresh candidate while a frozen repair is active.',
          sourceRef: '[turn:owner@2026-09-03T22:31:00Z]',
          sourceProvenance: {
            kind: 'owner-turn',
            verified: true,
            quote: `The candidate that passed every test was ${candidate}. It never went green.`,
            label: 'owner turn 2026-09-03T22:31Z',
            verifiedAt: '2026-09-04T14:00:00Z',
          },
        },
      ],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    // Permanent falsifier of the pre-fix renderer: before P-012 neither the
    // quote prefix nor this SHA appeared anywhere in the rendered cold brief.
    expect(out).toContain('source quote [verified; owner turn 2026-09-03T22:31Z]');
    expect(out).toContain(candidate);
    expect(out).toContain('It never went green.');
  });

  it('P-012 distinguishes withheld/unreadable provenance from provenance that is absent', () => {
    const base: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [
        { key: 'absent', body: 'no provenance was captured' },
        {
          key: 'redacted',
          body: 'source carried a credential-shaped value',
          sourceProvenance: {
            kind: 'owner-turn',
            verified: true,
            quoteRedacted: true,
            verifiedAt: '2026-09-04T14:00:00Z',
          },
        },
        {
          key: 'unverified',
          body: 'source lookup failed',
          sourceProvenance: {
            kind: 'work-item',
            verified: false,
            error: 'not_found',
            verifiedAt: '2026-09-04T14:00:00Z',
          },
        },
        {
          key: 'verified-without-quote',
          body: 'legacy verified metadata',
          sourceProvenance: {
            kind: 'msg',
            verified: true,
            verifiedAt: '2026-09-04T14:00:00Z',
          },
        },
      ],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(base);
    const absentLine = out.split('\n').find((line) => line.includes('• absent:')) ?? '';
    expect(absentLine).not.toMatch(/WITHHELD|UNREADABLE/);
    expect(out).toContain('source quote: ⚠ WITHHELD');
    expect(out).toContain('source provenance: ⚠ UNREADABLE — not_found');
    expect(out).toContain('source provenance: ⚠ UNREADABLE — verified source metadata carried no quote');
    expect(out).toContain("facts:list { scope: 'owner', key: 'verified-without-quote' }");
  });

  it('returns "" when the brief carries nothing beyond the loop note', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: { harness: 'h', active: true, intervalSec: 60, goal: null, carryNote: 'n', carryNoteUpdatedAtMs: 1 },
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    expect(renderCarryBriefColdExtras(empty)).toBe('');
  });

  // EI-19362981097884026 — the COLD LOOP WAKE half of the cited-ref liveness
  // block. `buildCarryBrief` resolved `citedRefs` on the cold path all along and
  // this renderer discarded them, so a cold note's "Next action" could name an id
  // a peer had already closed and read as current marching orders. Measured live
  // (cold fire #71): a note citing FIVE `done` ids rendered none as terminal.
  const coldBriefWith = (citedRefs: string[]): CarryBrief => ({
    ownerId: 'x',
    loop: { harness: 'h', active: true, intervalSec: 60, goal: null, carryNote: 'n', carryNoteUpdatedAtMs: 1 },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    citedRefs,
  });

  it('flags a TERMINAL cited ref in the cold-wake extras, with the contradiction banner first', () => {
    const out = renderCarryBriefColdExtras(
      coldBriefWith(['WI-6054 [bug/done @su-397]: "already fixed + closed…"']),
    );
    expect(out).toContain('STALE-NOTE CONTRADICTION');
    expect(out).toContain('already TERMINAL');
    expect(out).toContain('⚠ TERMINAL ↪ WI-6054 [bug/done');
    // The banner is useless below the roster it is warning about.
    expect(out.indexOf('STALE-NOTE CONTRADICTION')).toBeLessThan(out.indexOf('Cited in the note'));
  });

  it('stays quiet (no banner, no TERMINAL marker) when every cited ref is still live', () => {
    // The negative control, and a real one: cold fire #71's note also cited
    // WI-989591, which was genuinely open. A marker that fires on every read is
    // one the reader stops seeing — so an active id gets the roster line only.
    const out = renderCarryBriefColdExtras(
      coldBriefWith(['WI-989591 [bug/open @b37b0]: "concurrent keypair mint…"']),
    );
    expect(out).toContain('↪ WI-989591 [bug/open');
    expect(out).not.toContain('STALE-NOTE CONTRADICTION');
    expect(out).not.toContain('⚠ TERMINAL');
  });

  it('renders no liveness block at all when the note cites nothing', () => {
    expect(renderCarryBriefColdExtras(coldBriefWith([]))).toBe('');
  });

  const terminalRef = 'WI-6054 [bug/done @su-397]: "already fixed + closed…"';

  it('does NOT double-render the block in the carry-respawn document', async () => {
    // renderCarryBriefText places the block inline right after the note AND
    // delegates to renderCarryBriefColdExtras for the tail. It strips citedRefs
    // before delegating — the same remedy it already uses for `directives`.
    // Without that strip this fix would print the roster twice in every respawn
    // document, which is how a shared renderer normally goes wrong.
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note: '## Next action\nverify then work_items:complete WI-6054 citing that line',
          updatedAtMs: Date.now() - 60_000,
        }),
        hydrateNoteRefsFn: async () => [terminalRef],
      }),
    );
    const text = renderCarryBriefText(brief);
    expect(text.match(/Cited in the note/g) ?? []).toHaveLength(1);
    expect(text.match(/STALE-NOTE CONTRADICTION/g) ?? []).toHaveLength(1);
  });

  it('gives the cold wake and the respawn document the SAME verdict for the same refs', () => {
    // The anti-drift assertion, and the actual content of this fix: these two
    // surfaces answered the same question differently for months because each
    // owned a copy. Comparing rendered output (not implementations) means a
    // future edit to one that does not reach the other fails HERE.
    const sections = renderCitedRefLivenessSections([terminalRef]);
    const cold = renderCarryBriefColdExtras({
      ownerId: 'x',
      loop: { harness: 'h', active: true, intervalSec: 60, goal: null, carryNote: 'n', carryNoteUpdatedAtMs: 1 },
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
      citedRefs: [terminalRef],
    });
    expect(sections).toHaveLength(2);
    for (const section of sections) expect(cold).toContain(section);
  });

  it('is falsifiable in both directions from one input list', () => {
    // A permanent in-file control pair: same function, opposite verdicts, no
    // tree mutation needed to prove the guard can fail.
    expect(renderCitedRefLivenessSections([]).join('')).toBe('');
    const live = renderCitedRefLivenessSections(['WI-989591 [bug/open]: "still open…"']);
    expect(live).toHaveLength(1);
    expect(live.join('')).not.toContain('TERMINAL');
    const dead = renderCitedRefLivenessSections([terminalRef]);
    expect(dead).toHaveLength(2);
    expect(dead.join('')).toContain('TERMINAL');
  });

  it('renders open walls FIRST, as verbatim rows with re-check commands (P-006)', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-1',
        title: null,
        body: null,
        harness: 'h',
        checkpoint: null,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [
        { claim: 'zombie PIDs await owner OK', recheck: 'ps -p 95902', sinceMs: 1 },
        { claim: 'capital arming pending owner', sinceMs: 2 },
      ],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('⛔ OPEN WALLS');
    expect(out).toContain('  • zombie PIDs await owner OK — re-check: ps -p 95902');
    expect(out).toContain('  • capital arming pending owner');
    expect(out.indexOf('OPEN WALLS')).toBeLessThan(out.indexOf('You HELD'));
  });

  describe('an AGED wall prompts re-scoping instead of another re-report', () => {
    // Owner directive 2026-09-18: re-reporting the same blocker is the signal to ask
    // whether the blocked thing is still WANTED. The carry surface redelivers a wall
    // every wake, so each redelivery reads as "still blocked" and never as "you have
    // never asked" — this block is what makes the trap visible at that exact moment.
    const now = 1_800_000_000_000;
    const briefWithWall = (sinceMs: number | undefined): CarryBrief => ({
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [{ claim: 'owner must enrol a hardware key', recheck: 'plans:items', sinceMs }],
      facts: [],
      awaits: [],
      fleet: null,
    });

    it('stays silent on a wall younger than the threshold', () => {
      const out = renderCarryBriefColdExtras(briefWithWall(now - (AGED_WALL_RESCOPE_PROMPT_MS - 60_000)), {
        nowMs: now,
      });
      expect(out).toContain('⛔ OPEN WALLS');
      expect(out).not.toContain('AGED WALL');
    });

    it('fires once the wall has stood past the threshold, and says to ASK rather than re-report', () => {
      const out = renderCarryBriefColdExtras(briefWithWall(now - (AGED_WALL_RESCOPE_PROMPT_MS + 60_000)), {
        nowMs: now,
      });
      expect(out).toContain('AGED WALL');
      expect(out).toContain('owner must enrol a hardware key');
      expect(out).toContain('UNEXAMINED PREMISE');
      expect(out).toContain('ASK WHETHER THE BLOCKED THING IS STILL WANTED');
      // The wall itself must still be delivered verbatim — the prompt ADDS to the
      // commitment, it never replaces it.
      expect(out).toContain('  • owner must enrol a hardware key — re-check: plans:items');
    });

    it('cannot measure, so stays silent, when the wall carries no sinceMs', () => {
      const out = renderCarryBriefColdExtras(briefWithWall(undefined), { nowMs: now });
      expect(out).toContain('⛔ OPEN WALLS');
      expect(out).not.toContain('AGED WALL');
    });
  });

  it('caps a long checkpoint and flags a missing one', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [
        {
          id: 'WI-1',
          title: null,
          body: null,
          harness: 'h',
          checkpoint: 'y'.repeat(2000),
          holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        },
        {
          id: 'WI-2',
          title: null,
          body: null,
          harness: 'h',
          checkpoint: null,
          holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        },
      ],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    const ckptLine = out.split('\n').find((l) => l.includes('checkpoint: yyy'))!;
    expect(ckptLine.length).toBeLessThan(600);
    // The cut is still marked with '…', but the line no longer ENDS there: it
    // now closes with the withheld-chars notice naming how much was dropped and
    // the call that returns it. A bare trailing '…' told the reader a cut
    // happened without telling them how much they were missing or how to get
    // it — on the one surface (a cold successor's whole resume state) where
    // that matters most. Strictly more disclosure, paid for inside the budget
    // asserted on the line above.
    expect(ckptLine).toContain('…');
    expect(ckptLine).toMatch(/chars withheld — full text: work_items:get \{ id: 'WI-1', harness: 'h' \}⟩$/);
    expect(out).toContain('(no checkpoint written — read the item via work_items:get before acting)');
  });

  it('discloses when a capped checkpoint shows only part of its structured Checks rows', () => {
    const checks = Array.from(
      { length: 23 },
      (_, i) => `- ? [#check-${String(i + 1).padStart(2, '0')}] stored check ${i + 1} — re-check: echo check-${i + 1}`,
    ).join('\n');
    const checkpoint = `## Did\ncheckpoint narrative\n\n## Checks\n${checks}`;
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-3496',
        title: null,
        body: null,
        harness: 'h',
        checkpoint,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    const disclosure = /⚠ checks: (\d+) of 23 rows on THIS ITEM'S checkpoint are NOT shown above/.exec(out);
    expect(disclosure).not.toBeNull();
    // Some rows are hidden, but not vacuously all-or-nothing: the count must be a
    // real subset, so a renderer that silently stopped emitting rows still fails.
    expect(Number(disclosure?.[1])).toBeGreaterThan(0);
    expect(Number(disclosure?.[1])).toBeLessThanOrEqual(23);
    expect(out).toContain("work_items:get { id: 'WI-3496', harness: 'h' }");
  });

  // EI-22431465725244151. The old wording ("checks: showing 0 of 11 stored rows in
  // this excerpt") read as a note about the excerpt rather than as unread state, and
  // the loop's own fully-rendered "CARRIED CHECKS" block made the document look like
  // its checks had already been read in full. Both halves are asserted here because
  // either one alone restores the false sense of completeness.
  it('names the hidden work-item check rows as a separate set from the loop block', () => {
    const checks = Array.from(
      { length: 23 },
      (_, i) => `- ? [#row-${String(i + 1).padStart(2, '0')}] stored check ${i + 1} — re-check: echo check-${i + 1}`,
    ).join('\n');
    const checkpoint = `## Did\ncheckpoint narrative\n\n## Checks\n${checks}`;
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-3496',
        title: null,
        body: null,
        harness: 'h',
        checkpoint,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
      checks: [{ claim: 'the loop carries its own unrelated check', verified: 'observed' }],
    } as CarryBrief;

    const out = renderCarryBriefColdExtras(brief);

    // 1. The loop block must not present itself as THE carried set...
    expect(out).toContain("🧪 CARRIED CHECKS (this LOOP's)");
    // ...and must point at the item that holds the other one, by id.
    expect(out).toContain("These are the LOOP's checks and NOT the only ones in this document");
    expect(out).toMatch(/NOT the only ones in this document — WI-3496/);
    // 2. The item's own line must read as unread state, not as excerpt formatting.
    expect(out).toMatch(/rows on THIS ITEM'S checkpoint are NOT shown above/);
    expect(out).toContain('an unread row cannot warn you');
    // The superseded phrasing must not come back.
    expect(out).not.toContain('stored rows in this excerpt');
  });

  it('does not claim rows are hidden when the excerpt showed all of them', () => {
    const checkpoint = `## Did\nshort\n\n## Checks\n- ? [#only] one row — re-check: echo one`;
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-1',
        title: null,
        body: null,
        harness: 'h',
        checkpoint,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);

    // Negative control for the warning above: a fully-shown set must NOT raise it,
    // or the ⚠ becomes background noise and stops being read.
    expect(out).not.toContain('are NOT shown above');
  });

  it('omits the cross-reference when no held item carries checks', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'WI-2',
        title: null,
        body: null,
        harness: 'h',
        checkpoint: '## Did\nno checks here',
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
      checks: [{ claim: 'loop-only check', verified: 'observed' }],
    } as CarryBrief;

    const out = renderCarryBriefColdExtras(brief);

    expect(out).toContain("🧪 CARRIED CHECKS (this LOOP's)");
    expect(out).not.toContain('NOT the only ones in this document');
  });

  it('labels checkpoint paths with the held harness root after a cold resume', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'EI-20467754551087390',
        title: 'Carry checkpoints',
        body: null,
        harness: 'sidestage',
        checkpoint: 'Inspect apps/web/src/auction.css and apps/web/src/auction.test.tsx.',
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
      }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('path scope: checkpoint paths are repository-relative to the sidestage harness repository root');
    expect(out).toContain("(resolve with harness:list { detail: 'full' } and match this slug before shelling out)");
    expect(out).not.toContain('resolve with harness:get');
    expect(out).toContain('apps/web/src/auction.css');
  });

  describe('EI-20375177522112122 — the held-item line must resolve the declare-intent namespace', () => {
    const briefWith = (held: Partial<CarryBriefHeldItem>): CarryBrief => ({
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [{
        id: 'EI-20375177522112122',
        title: 'Cold-wake lane',
        body: null,
        harness: 'papercusp',
        checkpoint: null,
        holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        ...held,
      } as CarryBriefHeldItem],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    });

    it('names the P-NNN ids to pass, and that the work-item id is not one', () => {
      const out = renderCarryBriefColdExtras(
        briefWith({ sourcePlanSlug: 'drain-2026-09-04', sourcePlanItemIds: ['P-007', 'P-008'] }),
      );
      expect(out).toContain("declare-intent lane: plan 'drain-2026-09-04' → P-007, P-008");
      expect(out).toContain("items: ['P-007', 'P-008']");
      // The whole point: the id in hand must be marked as NOT the one to pass.
      expect(out).toContain('EI-20375177522112122 is a WORK-item id and `items` rejects it (P-NNN only)');
    });

    it('says NONE — and says to omit `items` rather than send an empty lane', () => {
      const out = renderCarryBriefColdExtras(
        briefWith({ sourcePlanSlug: null, sourcePlanItemIds: null }),
      );
      expect(out).toContain('declare-intent lane: none');
      // `items: []` without a plan is a presence re-declaration, NOT a lane — so
      // "no plan item" must not be read as "send an empty one".
      expect(out).toContain('pass NO `items` at all');
      expect(out).toContain('presence re-declaration, not a lane');
    });

    it('distinguishes a plan binding with no recorded item id from no binding', () => {
      const out = renderCarryBriefColdExtras(
        briefWith({ sourcePlanSlug: 'drain-2026-09-04', sourcePlanItemIds: null }),
      );
      expect(out).toContain('NO plan-item id is recorded on this row');
      expect(out).toContain("plans:items { slug: 'drain-2026-09-04' }");
      expect(out).not.toContain('declare-intent lane: none');
    });

    it('stays SILENT when the binding was never loaded — an unasked question is not an absence', () => {
      // Neither column supplied (the injected-read shape). Rendering "none" here
      // would assert an absence from a measurement that was never taken.
      const out = renderCarryBriefColdExtras(briefWith({}));
      expect(out).toContain('EI-20375177522112122');
      expect(out).not.toContain('declare-intent lane:');
    });

    it('treats an empty-array binding as none, not as a lane', () => {
      const out = renderCarryBriefColdExtras(
        briefWith({ sourcePlanSlug: '', sourcePlanItemIds: [] }),
      );
      expect(out).toContain('declare-intent lane: none');
    });
  });

  describe('EI-19952485326105760 — a SUPERSEDING owner directive past the cut must not be lost', () => {
    // The real shape: an older plan, followed by a LATER block that REVOKES it.
    // Both are real content; only the second is still operative. A plain
    // head-only cap() lands its cut between the two and the successor's
    // context inherits the superseded plan with no trace of what revoked it.
    const OLDER_PLAN =
      'the owner report is artifact https://claude.ai/example-artifact-url; republish that path to keep the URL. ' +
      `${'filler context '.repeat(30)}`;
    const SUPERSEDING_BLOCK =
      '## ⛔ SUPERSEDING OWNER DIRECTIVE — NO MORE STATUS-REPORT ARTIFACTS\n' +
      `[owner 2026-08-09] "i dont need the live reports stop that"`;
    const CHECKPOINT = `${OLDER_PLAN}\n\n${SUPERSEDING_BLOCK}`;

    it('preserves the superseding directive when the plain cut would have landed before it', () => {
      // Sanity: the incident shape actually exceeds the cap and a bare slice
      // would cut before the superseding block — otherwise this test would
      // pass for the wrong reason.
      expect(CHECKPOINT.length).toBeGreaterThan(500);
      expect(CHECKPOINT.slice(0, 499)).not.toContain('SUPERSEDING');

      const brief: CarryBrief = {
        ownerId: 'x',
        workspaceId: 'ws-test',
        loop: null,
        heldItems: [{
          id: 'WI-37110',
          title: null,
          body: null,
          harness: 'h',
          checkpoint: CHECKPOINT,
          holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        }],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [],
        awaits: [],
        fleet: null,
      };
      const out = renderCarryBriefColdExtras(brief);
      expect(out).toContain('⚠ OPERATIVE:');
      expect(out).toContain('NO MORE STATUS-REPORT ARTIFACTS');
      expect(out).toContain('i dont need the live reports stop that');
    });

    it('still truncates — this is preservation, not a budget bypass', () => {
      const brief: CarryBrief = {
        ownerId: 'x',
        workspaceId: 'ws-test',
        loop: null,
        heldItems: [{
          id: 'WI-37110',
          title: null,
          body: null,
          harness: 'h',
          checkpoint: CHECKPOINT,
          holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        }],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [],
        awaits: [],
        fleet: null,
      };
      const out = renderCarryBriefColdExtras(brief);
      const ckptLine = out.split('\n').find((l) => l.includes('checkpoint: the owner report'))!;
      expect(ckptLine).toBeDefined();
      // capped head + a bounded operative addendum, nowhere near the full body.
      expect(ckptLine.length).toBeLessThan(CHECKPOINT.length);
    });

    it('a fact body carrying the same shape is preserved too (the adjacent facts render)', () => {
      const brief: CarryBrief = {
        ownerId: 'x',
        loop: null,
        heldItems: [],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [{ key: 'status-report-policy', body: CHECKPOINT }],
        awaits: [],
        fleet: null,
      };
      const out = renderCarryBriefColdExtras(brief);
      expect(out).toContain('NO MORE STATUS-REPORT ARTIFACTS');
      expect(out).toContain("facts:list { scope: 'owner', key: 'status-report-policy' }");
    });
  });

  describe('EI-18684357744098956 — a checkpoint superseded by later session activity flags as SUPERSEDED', () => {
    const now = Date.parse('2026-07-26T05:30:00.000Z');
    const brief = (checkpointUpdatedAtMs: number | null): CarryBrief => ({
      ownerId: 'x',
      workspaceId: 'ws-test',
      loop: null,
      heldItems: [
        {
          id: 'WI-5943',
          title: null,
          body: null,
          harness: 'h',
          checkpoint: 'ZERO CODE HAS BEEN WRITTEN. No file is edited.',
          checkpointUpdatedAtMs,
          holderProof: { ownerId: 'x', workspaceId: 'ws-test' },
        },
      ],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    });

    it('flags a checkpoint written well before the latest known session activity', () => {
      const checkpointAt = now - 10 * 60_000; // written 10m before the boundary
      const out = renderCarryBriefColdExtras(brief(checkpointAt), { sessionActivityMs: now });
      expect(out).toContain('⚠ SUPERSEDED');
      expect(out).toContain('verify via');
      // The stale text still rides along (never dropped) so nothing is lost —
      // just no longer rendered with the authority of plain fact.
      expect(out).toContain('ZERO CODE HAS BEEN WRITTEN');
    });

    it('does NOT flag a checkpoint written at (or just before) the boundary — normal write latency', () => {
      const checkpointAt = now - 5_000; // 5s before — ordinary flush latency
      const out = renderCarryBriefColdExtras(brief(checkpointAt), { sessionActivityMs: now });
      expect(out).not.toContain('SUPERSEDED');
      expect(out).toContain('checkpoint: ZERO CODE HAS BEEN WRITTEN');
    });

    it('does NOT flag when no sessionActivityMs is supplied — purely additive, backward compatible', () => {
      const out = renderCarryBriefColdExtras(brief(now - 60 * 60_000));
      expect(out).not.toContain('SUPERSEDED');
    });

    it('does NOT flag when the item has no checkpointUpdatedAtMs (unknown write time)', () => {
      const out = renderCarryBriefColdExtras(brief(null), { sessionActivityMs: now });
      expect(out).not.toContain('SUPERSEDED');
    });

    it('renderCarryBriefText forwards sessionActivityMs through to the held-items flag', () => {
      const fullBrief: CarryBrief = { ...brief(now - 10 * 60_000), loop: null };
      const out = renderCarryBriefText(fullBrief, now, { sessionActivityMs: now });
      expect(out).toContain('⚠ SUPERSEDED');
    });
  });
});

describe('EI-22436560948423011 — carry-note superseded by later session activity', () => {
  const now = Date.parse('2026-07-26T05:30:00.000Z');
  const brief = (carryNoteUpdatedAtMs: number | null): CarryBrief => ({
    ownerId: 'x',
    workspaceId: 'ws-test',
    loop: {
      harness: 'h',
      active: true,
      intervalSec: 60,
      goal: null,
      carryNote: '## Next action\nresume the carried work',
      carryNoteUpdatedAtMs,
    },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
  });

  it('flags a carry-note written well before the latest known session activity', () => {
    const out = renderCarryBriefColdExtras(brief(now - 10 * 60_000), { sessionActivityMs: now });
    expect(out).toContain('⚠ CARRY-NOTE SUPERSEDED');
    expect(out).toContain('session active until');
    expect(out).toContain("verify via sessions:search { session:'self', mode:'verbatim' }");
    expect(out).toContain('"Next action"');
  });

  it('does not flag a carry-note written just before the boundary and preserves the no-tail result', () => {
    const out = renderCarryBriefColdExtras(brief(now - 5_000), { sessionActivityMs: now });
    expect(out).not.toContain('CARRY-NOTE SUPERSEDED');
    expect(out).toBe('');
  });

  it('does not flag when the activity or carry-note write time is unknown', () => {
    expect(renderCarryBriefColdExtras(brief(now - 60 * 60_000))).toBe('');
    expect(renderCarryBriefColdExtras(brief(null), { sessionActivityMs: now })).toBe('');
  });

  it('preserves the note and appends the warning on the full carry-brief path', () => {
    const out = renderCarryBriefText(brief(now - 10 * 60_000), now, { sessionActivityMs: now });
    expect(out).toContain('resume the carried work');
    expect(out).toContain('⚠ CARRY-NOTE SUPERSEDED');
    expect(out.indexOf('resume the carried work')).toBeLessThan(out.indexOf('CARRY-NOTE SUPERSEDED'));
  });
});

describe('renderCarryBriefText — the full brief (P-004 recovery-hook payload)', () => {
  it('leads with the loop note + write age, then the extras sections', async () => {
    const now = Date.now();
    const out = renderCarryBriefText(await buildCarryBrief('su-abc', fullOpts()), now);
    expect(out).toContain('Armed loop @papercusp (active, every 120s)');
    expect(out).toContain('written 5m ago');
    expect(out).toContain('ship P-004'); // the note itself, verbatim
    expect(out.indexOf('Armed loop')).toBeLessThan(out.indexOf('You HELD'));
  });

  it('a loop with no note says so instead of rendering an empty block', async () => {
    const out = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
      ),
    );
    expect(out).toContain('No carry-note written.');
  });

  it("an INACTIVE loop's day-old note collapses to a STALE pointer — never verbatim marching orders", async () => {
    const now = Date.now();
    const out = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({
          getLoopStatusFn: async () => ({ harnessSlug: 'papercusp', active: false, intervalSec: 900 }),
          getLoopCarryNoteWithMetaFn: async () => ({
            note: '## Next action\nOn wake: tail the drill ledger and nudge the leader',
            updatedAtMs: now - 3 * 24 * 60 * 60_000,
          }),
        }),
      ),
      now,
    );
    expect(out).toContain('STALE');
    expect(out).toContain('historical, NOT your current agenda');
    expect(out).toContain('Inactive loop @papercusp (inactive, every 900s)');
    expect(out).not.toContain('Armed loop @');
    // The stale imperatives themselves must NOT ride the brief verbatim.
    expect(out).not.toContain('nudge the leader');
  });

  it("an ACTIVE loop's note renders in full regardless of age; a recently-ended loop's note also survives", async () => {
    const now = Date.now();
    const activeOld = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({
          getLoopCarryNoteWithMetaFn: async () => ({
            note: '## Next action\nkeep shipping',
            updatedAtMs: now - 3 * 24 * 60 * 60_000,
          }),
        }),
      ),
      now,
    );
    expect(activeOld).toContain('keep shipping');
    const inactiveFresh = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({
          getLoopStatusFn: async () => ({ harnessSlug: 'papercusp', active: false, intervalSec: 900 }),
          getLoopCarryNoteWithMetaFn: async () => ({
            note: '## Next action\nfinish the drill',
            updatedAtMs: now - 60 * 60_000,
          }),
        }),
      ),
      now,
    );
    expect(inactiveFresh).toContain('finish the drill');
    expect(inactiveFresh).toContain('Inactive loop @papercusp (inactive, every 900s)');
    expect(inactiveFresh).not.toContain('Armed loop @');
  });
});

describe('owner directives in the brief (EI-11484)', () => {
  it('builds the directives section from the injected reader', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(9, 'resume all the sessions')], totalOpen: 1 }),
      }),
    );
    expect(brief.directives.map((d) => d.id)).toEqual([9]);
    expect(brief.directivesTotalOpen).toBe(1);
  });

  it('renderCarryBriefText renders open directives FIRST — above the loop contract — and never twice', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({
          rows: [directive(9, 'resume all the sessions active in the last half hour')],
          totalOpen: 1,
        }),
      }),
    );
    const out = renderCarryBriefText(brief);
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('Armed loop'));
    expect(out).toContain('"resume all the sessions active in the last half hour"');
    // rendered once, not re-rendered by the extras leg
    expect(out.match(/OPEN OWNER DIRECTIVES/g)!.length).toBe(1);
  });

  it('renders another session\'s directive as FYI in both carry surfaces', async () => {
    const ownText = 'carry out my own open directive';
    const peerText = 'take over the peer session project';
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({
          rows: [
            directive(20, ownText),
            { ...directive(21, peerText), recordedBy: 'su-peer-session', sessionRef: 'source-session-peer' },
          ],
          totalOpen: 2,
        }),
      }),
    );

    for (const out of [renderCarryBriefText(brief), renderCarryBriefColdExtras(brief)]) {
      expect(out).toContain('[FOR THIS SESSION]');
      expect(out).toContain(ownText);
      expect(out).toContain('[FYI');
      // P-006 (WI-6554700010009314): FYI ids are grouped under their recording
      // session beneath one legend that carries the lookup pointer.
      expect(out).toContain('• su-peer-sess: #21');
      expect(out).toContain('orders:get #<id>');
      expect(out).not.toContain(peerText);
    }
  });

  it('renderCarryBriefColdExtras renders directives ahead of walls and held items', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(4, 'ship it now')], totalOpen: 1 }),
      }),
    );
    const out = renderCarryBriefColdExtras(brief);
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('You HELD'));
  });

  it('the focus line carries directive IDS as pointers, ahead of walls', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(4, 'ship it now')], totalOpen: 1 }),
      }),
    );
    const focus = renderCarryBriefFocus(brief);
    expect(focus).toContain('OPEN OWNER DIRECTIVES #4');
    expect(focus.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(focus.indexOf('zombie-pids-wall'));
    expect(focus).not.toContain('ship it now'); // pointers, not copies
  });
});

describe('readHeldWorkItems — scope→harness resolution (EI-8813 regression)', () => {
  it.each(['rejected', 'in-band'] as const)('preserves checkpoint uncertainty for a successor (%s)', async (failure) => {
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:papercusp', taken_by: 'su-abc', workspace_id: 'ws-test' },
      ]),
      getWorkItemCheckpointWithMetaFn: async () => {
        if (failure === 'rejected') throw new Error('checkpoint store unavailable');
        return { checkpoint: null, updatedAtMs: null, readFailed: true };
      },
    });
    expect(held[0]).toMatchObject({ checkpoint: null, checkpointUpdatedAtMs: null, checkpointReadFailed: true });
    const brief = await buildCarryBrief('su-abc', fullOpts({ readHeldWorkItemsFn: async () => held }));
    const restored = JSON.parse(JSON.stringify(brief)) as CarryBrief;
    const rendered = renderCarryBriefText(restored);
    expect(rendered).toContain('checkpoint: UNKNOWN — store read failed');
    expect(rendered).not.toContain('no checkpoint written');
  });

  it('resolves a harness-scoped item to its concrete slug', async () => {
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:papercusp' },
      ]),
      getWorkItemCheckpointFn: async (ref) => `harness=${ref.harness}`,
    });
    expect(held).toEqual([{ id: 'WI-1', title: 't', body: 'b', harness: 'papercusp', checkpoint: 'harness=papercusp', checkpointUpdatedAtMs: null }]);
  });

  it('resolves an operator-scope (harness-null) item to null — NEVER a guessed slug', async () => {
    // Before the fix, a scope that didn't start with 'harness:' fell back to the
    // literal string 'papercup' (misspelled, and not the checkpoint store's
    // wildcard sentinel) — mismatching the key work_items:checkpoint actually
    // wrote under and silently losing the checkpoint (EI-8813).
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        { issue_id: 'EI-8810', title: 't', body: 'b', scope: 'operator' },
      ]),
      getWorkItemCheckpointFn: async (ref) => {
        expect(ref.harness).toBeNull();
        return 'the real checkpoint';
      },
    });
    expect(held).toEqual([
      { id: 'EI-8810', title: 't', body: 'b', harness: null, checkpoint: 'the real checkpoint', checkpointUpdatedAtMs: null },
    ]);
  });

  it('propagates concrete read-time holder proof from taken_by/workspace_id', async () => {
    const held = await readHeldWorkItems('owner-x', 'ws-test', {
      sql: fakeIssuesSql([
        {
          issue_id: 'WI-proof',
          title: 'proof-bearing row',
          body: 'b',
          scope: 'harness:papercusp',
          taken_by: 'owner-x',
          workspace_id: 'ws-test',
        },
      ]),
      getWorkItemCheckpointFn: async () => 'checkpoint',
    });
    expect(held).toEqual([{
      id: 'WI-proof',
      title: 'proof-bearing row',
      body: 'b',
      harness: 'papercusp',
      checkpoint: 'checkpoint',
      checkpointUpdatedAtMs: null,
      holderProof: { ownerId: 'owner-x', workspaceId: 'ws-test' },
    }]);
  });
});

describe('readHeldWorkItems — EI-9013 (feature-family coverage + workspace canonicalization)', () => {
  /** Tagged-template sql stub that CAPTURES the query text + params it receives. */
  function capturingSql(rows: Array<{ issue_id: string; title: string | null; body: string | null; scope: string }>) {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push({ text: strings.join('¶'), params: vals });
      return Promise.resolve(rows);
    }) as unknown as never;
    return { sql, calls };
  }

  it('queries work_items DIRECTLY, covering the feature/chunk family the engineer_issues view excludes', async () => {
    // The incident (EI-9013): WI-3535 — a held FEATURE item — never appeared in the
    // post-compaction fold, because this read went through the engineer_issues VIEW
    // (item_kind IN bug/change/task only). Pin that the query now targets work_items
    // and carries BOTH per-family branches.
    const { sql, calls } = capturingSql([
      { issue_id: 'WI-3535', title: 'feature item', body: 'b', scope: 'harness:papercusp' },
    ]);
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql,
      getWorkItemCheckpointFn: async () => 'feature checkpoint',
    });
    expect(held).toEqual([
      { id: 'WI-3535', title: 'feature item', body: 'b', harness: 'papercusp', checkpoint: 'feature checkpoint', checkpointUpdatedAtMs: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('harness_shared.work_items');
    expect(calls[0]!.text).not.toContain('engineer_issues');
    expect(calls[0]!.text).toContain("item_kind IN ('feature', 'chunk')");
    expect(calls[0]!.text).toContain("item_kind IN ('bug', 'change', 'task')");
    expect(calls[0]!.text).toContain('last_progress_at');
  });

  it('carries the writer-backed last_progress_at anchor for relative checkpoint freshness', async () => {
    const checkpointAt = Date.parse('2026-09-08T11:00:00.000Z');
    const progressAt = Date.parse('2026-09-08T11:30:00.000Z');
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        {
          issue_id: 'WI-progress',
          title: 'progress-bearing item',
          body: 'b',
          scope: 'harness:papercusp',
          last_progress_at: new Date(progressAt).toISOString(),
        },
      ]),
      getWorkItemCheckpointFn: async () => 'checkpoint',
    });
    expect(held[0]).toMatchObject({ id: 'WI-progress', lastProgressAtMs: progressAt });
    // The checkpoint timestamp is read from carry_notes independently; the two
    // anchors are intentionally separate inputs to the relative gate.
    expect(checkpointAt).toBeLessThan(progressAt);
  });

  it("canonicalizes a wildcard '*' workspace to the concrete one for BOTH the query and the checkpoint reads", async () => {
    // An unscoped su session's ctx.workspaceId is the literal '*' — previously this
    // scoped the held-items query + checkpoint reads to a workspace with no rows,
    // so the fold showed NOTHING held (the other half of EI-9013).
    const prior = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
    try {
      const { sql, calls } = capturingSql([
        { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:h1' },
      ]);
      const checkpointRefs: Array<{ workspaceId?: string }> = [];
      await readHeldWorkItems('su-abc', '*', {
        sql,
        getWorkItemCheckpointFn: async (ref) => {
          checkpointRefs.push(ref);
          return null;
        },
      });
      expect(calls[0]!.params).toContain('resolved-concrete-ws');
      expect(calls[0]!.params).not.toContain('*');
      expect(checkpointRefs[0]!.workspaceId).toBe('resolved-concrete-ws');
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prior;
    }
  });

  it('does not fall back to the default workspace after resolving a concrete workspace', async () => {
    const { sql, calls } = capturingSql([
      { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:h1' },
    ]);

    await readHeldWorkItems('su-abc', 'resolved-concrete-ws', {
      sql,
      getWorkItemCheckpointFn: async () => null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('workspace_id =');
    expect(calls[0]!.text).not.toContain("OR workspace_id = 'default'");
    expect(calls[0]!.params).toContain('resolved-concrete-ws');
  });

  it('excludes resource-governor receipts even when their outer claim projection looks held', async () => {
    const receipt = {
      issue_id: 'WI-986693',
      title: 'Durable resource-governor receipt',
      body: 'local admission receipt',
      scope: 'operator',
      source_plan_slug: null,
      source_plan_item_ids: null,
      resource_governor: true,
    };
    const realWork = {
      issue_id: 'WI-986694',
      title: 'Actual agent work',
      body: 'in-flight work',
      scope: 'harness:papercusp',
      source_plan_slug: null,
      source_plan_item_ids: null,
      resource_governor: false,
    };
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join('¶');
      calls.push({ text, params: vals });
      // Model the row discriminator the production SQL must enforce. The
      // receipt intentionally has a non-terminal outer shape; only the
      // reserved payload marker distinguishes it from real held work.
      return Promise.resolve(
        text.includes("NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')")
          ? [realWork]
          : [receipt, realWork],
      );
    }) as unknown as never;

    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql,
      getWorkItemCheckpointFn: async () => 'checkpoint',
    });

    expect(calls[0]!.text).toContain("NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')");
    expect(held.map((item) => item.id)).toEqual(['WI-986694']);
  });
});

describe('readDeferredWorkItems — session-authored/commented unheld work', () => {
  type Row = {
    id: string;
    title: string | null;
    body: string | null;
    harness_slug: string | null;
    kind: string | null;
    created_this_session: boolean;
    commented_this_session: boolean;
  };

  function capturingSql(rows: Row[] | Error) {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push({ text: strings.join('¶'), params: vals });
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
    }) as unknown as never;
    return { sql, calls };
  }

  it('reads and normalizes the latest unended session boundary', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push({ text: strings.join('¶'), params: vals });
      return Promise.resolve([{ started_at_ms: '1700000000123' }]);
    }) as unknown as never;

    await expect(
      readCurrentSessionStartedAtMs('su-abc', 'ws-test', { sql }),
    ).resolves.toBe(1_700_000_000_123);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('FROM harness_shared.adv_sessions');
    expect(calls[0]!.text).toContain('coord_owner_id');
    expect(calls[0]!.text).toContain('ended_at IS NULL');
    expect(calls[0]!.text).toContain('ORDER BY started_at DESC');
    expect(calls[0]!.params).toEqual(['ws-test', 'su-abc']);
  });

  it('fails closed when the current session boundary is unknown', async () => {
    const { sql, calls } = capturingSql([]);
    const out = await readDeferredWorkItems('su-abc', 'ws-test', {
      sql,
      sessionStartedAtMs: null,
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('resolves the current session, maps authorship sources, and keeps SQL scope/bounds explicit', async () => {
    const rows: Row[] = [
      {
        id: 'EI-1',
        title: 'authored issue',
        body: 'issue body',
        harness_slug: 'operator:ws-test',
        kind: 'bug',
        created_this_session: true,
        commented_this_session: false,
      },
      {
        id: 'F-2',
        title: 'commented feature',
        body: 'feature body',
        harness_slug: 'h1',
        kind: 'feature',
        created_this_session: false,
        commented_this_session: true,
      },
      {
        id: 'WI-3',
        title: 'both signals',
        body: null,
        harness_slug: ' h2 ',
        kind: null,
        created_this_session: true,
        commented_this_session: true,
      },
    ];
    const { sql, calls } = capturingSql(rows);
    const sessionLookups: Array<[string, string]> = [];
    const out = await readDeferredWorkItems('su-abc', 'ws-test', {
      sql,
      limit: 100,
      getCurrentSessionStartedAtMsFn: async (ownerId, workspaceId) => {
        sessionLookups.push([ownerId, workspaceId]);
        return 1_700_000_000_123;
      },
    });

    expect(sessionLookups).toEqual([['su-abc', 'ws-test']]);
    expect(out).toEqual([
      {
        id: 'EI-1',
        title: 'authored issue',
        body: 'issue body',
        harness: null,
        kind: 'bug',
        source: 'created',
      },
      {
        id: 'F-2',
        title: 'commented feature',
        body: 'feature body',
        harness: 'h1',
        kind: 'feature',
        source: 'commented',
      },
      {
        id: 'WI-3',
        title: 'both signals',
        body: null,
        harness: 'h2',
        kind: 'work-item',
        source: 'created-and-commented',
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('harness_shared.work_items');
    expect(calls[0]!.text).toContain('harness_shared.coord_thread_posts');
    expect(calls[0]!.text).toContain('harness_shared.coord_threads');
    expect(calls[0]!.text).toContain('WITH candidates AS');
    expect(calls[0]!.text).toContain('UNION ALL');
    expect(calls[0]!.text).toContain('bool_or(created_this_session)');
    expect(calls[0]!.text).toContain('bool_or(commented_this_session)');
    expect(calls[0]!.text).not.toContain('EXISTS (');
    expect(calls[0]!.text).toContain("item_kind IN ('bug', 'change', 'task')");
    expect(calls[0]!.text).toContain("item_kind IN ('feature', 'chunk')");
    expect(calls[0]!.text).toContain('wi.taken_by IS NULL');
    expect(calls[0]!.text).toContain('wi.status IS NULL OR wi.status <> ALL');
    // WI-10004968: BOTH candidate branches (authored + commented) must exclude
    // observation-lane reflection rows, or they render as unclaimed work.
    expect(calls[0]!.text.match(/wi\.lane IS DISTINCT FROM 'observation'/g)).toHaveLength(2);
    expect(calls[0]!.text).toContain('created_at >=');
    expect(calls[0]!.params).toContain('ws-test');
    expect(calls[0]!.params).toContain('su-abc');
    expect(calls[0]!.params).toContain(1_700_000_000_123);
    expect(calls[0]!.params).toContain(CARRY_BRIEF_MAX_DEFERRED_ITEMS);
  });

  it('fails soft when session resolution or the bounded query fails', async () => {
    const query = capturingSql(new Error('query unavailable'));
    await expect(
      readDeferredWorkItems('su-abc', 'ws-test', {
        sql: query.sql,
        getCurrentSessionStartedAtMsFn: async () => {
          throw new Error('session lookup unavailable');
        },
      }),
    ).resolves.toEqual([]);
    expect(query.calls).toHaveLength(0);

    const queryFailure = capturingSql(new Error('query unavailable'));
    await expect(
      readDeferredWorkItems('su-abc', 'ws-test', {
        sql: queryFailure.sql,
        sessionStartedAtMs: 1_700_000_000_000,
      }),
    ).resolves.toEqual([]);
    expect(queryFailure.calls).toHaveLength(1);
  });
});

describe('deferred-work rendering and idle-note guard', () => {
  const deferred: CarryBriefDeferredItem[] = [
    {
      id: 'EI-1',
      title: 'authored issue',
      body: null,
      harness: null,
      kind: 'bug',
      source: 'created',
    },
    {
      id: 'F-2',
      title: 'commented feature',
      body: null,
      harness: 'h1',
      kind: 'feature',
      source: 'commented',
    },
    {
      id: 'WI-3',
      title: null,
      body: null,
      harness: 'h2',
      kind: 'task',
      source: 'created-and-commented',
    },
  ];

  it('renders bounded re-fetch pointers and each positive source classification', () => {
    const out = renderDeferredWorkItems(deferred);
    expect(out).toContain('DEFERRED, UNCLAIMED WORK');
    expect(out).toContain('this session positively touched 3');
    expect(out).toContain("EI-1 — authored issue — filed this session (work_items:get { id: 'EI-1' })");
    expect(out).toContain(
      "F-2 — commented feature — commented on this session (work_items:get { id: 'F-2', harness: 'h1' })",
    );
    expect(out).toContain("WI-3 — filed and commented on this session (work_items:get { id: 'WI-3', harness: 'h2' })");
  });

  it('flags an idle-sounding note only when deferred work falsifies it', () => {
    expect(detectIdleNoteGuard('I am still working on the deferred item.', deferred)).toBeNull();
    expect(detectIdleNoteGuard('Nothing is left; the lane is idle.', deferred)).toMatchObject({
      flagged: true,
      trigger: 'Nothing is left',
      deferredIds: ['EI-1', 'F-2', 'WI-3'],
    });
    expect(detectIdleNoteGuard('The queue is empty; pick fresh work.', deferred)?.message).toContain(
      're-check each item',
    );
    expect(detectIdleNoteGuard('Nothing is left.', [])).toBeNull();
  });

  it('delivers the idle guard on both the cold extras path and the full brief exactly once', () => {
    const brief: CarryBrief = {
      ownerId: 'su-abc',
      loop: {
        harness: 'papercusp',
        active: true,
        intervalSec: 60,
        goal: null,
        carryNote: '## Next action\nNothing is left; stop here.',
        carryNoteUpdatedAtMs: 1,
      },
      heldItems: [],
      deferredItems: deferred,
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };

    const cold = renderCarryBriefColdExtras(brief);
    expect(cold).toContain('idle_note_guard');
    expect(cold).toContain('DEFERRED, UNCLAIMED WORK');

    const full = renderCarryBriefText(brief);
    expect(full.match(/idle_note_guard/g)).toHaveLength(1);
    expect(full).toContain('Nothing is left; stop here.');
    expect(full).toContain('DEFERRED, UNCLAIMED WORK');
  });
});

describe('deriveCarryQueryHandles — pull-precise handles, no recall (P-026 leg (a), WI-5001)', () => {
  it('emits a work-item handle per held item, titled by the item title', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-42', title: 'wire the prelude' }],
      awaits: [],
      facts: [],
    });
    expect(handles).toEqual([{ kind: 'work-item', ref: 'WI-42', query: ['wire the prelude'] }]);
  });

  it('falls back to the id itself when a held item has no title', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-42', title: null }],
      awaits: [],
      facts: [],
    });
    expect(handles).toEqual([{ kind: 'work-item', ref: 'WI-42', query: ['WI-42'] }]);
  });

  it('emits a topic handle per open await ("open thread"), titled by its note or else the event key', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [],
      awaits: [
        { eventKey: 'work-item:claimable', note: 'lane drained, waiting for new work' },
        { eventKey: 'deploy:done', note: null },
      ],
      facts: [],
    });
    expect(handles).toEqual([
      { kind: 'topic', ref: 'work-item:claimable', query: ['lane drained, waiting for new work'] },
      { kind: 'topic', ref: 'deploy:done', query: ['deploy:done'] },
    ]);
  });

  it('emits a fact handle ONLY for dead-end-keyed facts (dead-end:%), skipping ordinary standing facts', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [],
      awaits: [],
      facts: [
        { key: 'dead-end:tried-raw-sql-migration', body: '⛔ DEAD END: raw psql -f skips schema_migrations' },
        { key: 'wi-5003-blocked-not-a-bug', body: 'genuinely DAG-blocked, not a scheduler bug' },
      ],
    });
    expect(handles).toEqual([
      {
        kind: 'fact',
        ref: 'dead-end:tried-raw-sql-migration',
        query: ['⛔ DEAD END: raw psql -f skips schema_migrations'],
      },
    ]);
  });

  it('mixes all three classes in order: held-WI, then open threads, then dead-ends', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-1', title: 'a' }],
      awaits: [{ eventKey: 'ev-1', note: 'b' }],
      facts: [{ key: 'dead-end:x', body: 'c' }],
    });
    expect(handles.map((h) => h.kind)).toEqual(['work-item', 'topic', 'fact']);
  });

  it('caps the OVERALL handle count at `max`, stopping mid-class rather than dropping a whole class', () => {
    const handles = deriveCarryQueryHandles(
      {
        heldItems: [
          { id: 'WI-1', title: 'a' },
          { id: 'WI-2', title: 'b' },
        ],
        awaits: [{ eventKey: 'ev-1', note: 'c' }],
        facts: [{ key: 'dead-end:x', body: 'd' }],
      },
      2,
    );
    expect(handles).toHaveLength(2);
    expect(handles.map((h) => h.ref)).toEqual(['WI-1', 'WI-2']);
  });

  it('defaults to CARRY_QUERY_HANDLES_MAX when no cap is passed', () => {
    const heldItems = Array.from({ length: CARRY_QUERY_HANDLES_MAX + 5 }, (_, i) => ({
      id: `WI-${i}`,
      title: `item ${i}`,
    }));
    const handles = deriveCarryQueryHandles({ heldItems, awaits: [], facts: [] });
    expect(handles).toHaveLength(CARRY_QUERY_HANDLES_MAX);
  });

  it('clamps an overlong query to 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-1', title: long }],
      awaits: [],
      facts: [],
    });
    expect(handles[0]!.query[0]!.length).toBe(200);
    expect(handles[0]!.query[0]!.endsWith('…')).toBe(true);
  });

  it('empty input → empty handles', () => {
    expect(deriveCarryQueryHandles({ heldItems: [], awaits: [], facts: [] })).toEqual([]);
  });
});

describe('renderCarryQueryHandlesBlock — the deterministic pointer-list render', () => {
  it('null on an empty handles list (nothing to inject)', () => {
    expect(renderCarryQueryHandlesBlock([])).toBeNull();
  });

  it('renders one bracketed [kind:ref] line per handle under the fixed heading', () => {
    const out = renderCarryQueryHandlesBlock([
      { kind: 'work-item', ref: 'WI-42', query: ['wire the prelude'] },
      { kind: 'fact', ref: 'dead-end:x', query: ['tried raw SQL, broke migrations'] },
    ]);
    expect(out).toBe(
      `${CARRY_QUERY_HANDLES_HEADING}\n` +
        '- [work-item:WI-42] pull: wire the prelude\n' +
        '- [fact:dead-end:x] pull: tried raw SQL, broke migrations',
    );
  });

  it('joins a multi-term query with " | "', () => {
    const out = renderCarryQueryHandlesBlock([
      { kind: 'topic', ref: 'ev-1', query: ['term one', 'term two'] },
    ]);
    expect(out).toBe(`${CARRY_QUERY_HANDLES_HEADING}\n- [topic:ev-1] pull: term one | term two`);
  });
});
