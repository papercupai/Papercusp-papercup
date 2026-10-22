/**
 * improvements:filing-classes — TOOL SURFACE tests
 * (agent-review-filing-rail-and-class-aggregation-2026-09-05, P-002).
 *
 * The aggregation ITSELF is tested in `scout/filing-class-aggregation.test.ts`, including
 * the D-001 recurrence guard that pins the module to citation-only SQL. This file covers
 * the door: mode dispatch, the three refusals that must NOT create a work-item, and the
 * ADDITIVE property as the handler actually exercises it — one item created, `relates`
 * edges to every member, and no write of any kind aimed at a member work-item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readClasses: vi.fn(),
  identity: vi.fn(() => ({ ownerId: 'su-filer' })),
  resolveWorkspace: vi.fn(() => 'papercusp-workspace'),
  createWorkItem: vi.fn(),
  linkWorkItem: vi.fn(),
  sql: vi.fn(),
}));

// Partial: the package is a wide barrel other imports in this graph pull from, so
// replacing it wholesale collapses the collection with an unrelated missing export.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../../workspace-registry', () => ({ resolveConcreteWorkspaceId: h.resolveWorkspace }));
vi.mock('../../work-items', () => ({ createWorkItem: h.createWorkItem, linkWorkItem: h.linkWorkItem }));
// Partial mock ON PURPOSE: only the READ is stubbed. `buildFilingClassItemDraft` and
// FILING_CLASS_MIN_MEMBERS stay real, so the draft the handler files is the real draft.
vi.mock('../../scout/filing-class-aggregation', async (orig) => {
  const actual = await orig<typeof import('../../scout/filing-class-aggregation')>();
  return { ...actual, readFilingClasses: h.readClasses };
});

import tool from './filing-classes';
import type { FilingClass, FilingClassCensus } from '../../scout/filing-class-aggregation';
import { IMPROVEMENT_TOPIC } from '../../harness/improvements/read-items';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (args: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<ToolResult>;
const body = (result: ToolResult) => JSON.parse(result.content[0]!.text);

const aClass = (over: Partial<FilingClass> = {}): FilingClass => ({
  toolName: 'coord:send',
  memberCount: 3,
  memberIds: ['EI-1', 'EI-2', 'EI-3'],
  memberIdsTruncated: false,
  openMemberCount: 2,
  openMemberIds: ['EI-1', 'EI-2'],
  byState: { open: 2, dropped: 1 },
  byOrigin: { 'agent-review': 3 },
  errorCodes: ['invalid_args'],
  fieldPaths: ['body'],
  firstRoutedAtMs: 1_700_000_000_000,
  lastRoutedAtMs: 1_700_000_100_000,
  ...over,
});

const aCensus = (classes: FilingClass[]): FilingClassCensus => ({
  classes,
  minMembers: 3,
  totalMembers: 215,
  distinctSurfaces: 40,
  classedSurfaces: classes.length,
  classedMembers: classes.reduce((n, c) => n + c.memberCount, 0),
  classedOpenMembers: classes.reduce((n, c) => n + c.openMemberCount, 0),
  unclassedMembers: 215 - classes.reduce((n, c) => n + c.memberCount, 0),
  classesTruncated: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'su-filer' });
  h.resolveWorkspace.mockReturnValue('papercusp-workspace');
  h.readClasses.mockResolvedValue(aCensus([aClass()]));
  h.createWorkItem.mockResolvedValue({ id: 'WI-CLASS-1' });
  h.linkWorkItem.mockResolvedValue({ ok: true });
  h.sql.mockResolvedValue([]); // no existing open class row
});

describe('improvements:filing-classes — read mode', () => {
  it('returns the labelled census and creates nothing', async () => {
    const out = body(await call());

    expect(out.ok).toBe(true);
    expect(out.census.classes[0].toolName).toBe('coord:send');
    // The reach fields are what stop a bare "N classes" being rendered population-blind.
    expect(out.census.totalMembers).toBe(215);
    expect(out.census.classedMembers).toBe(3);
    expect(h.createWorkItem).not.toHaveBeenCalled();
    expect(h.linkWorkItem).not.toHaveBeenCalled();
  });

  it('reads the census without resolving a caller identity', async () => {
    // resolveAgentIdentity THROWS for a context with no principal. Identity is
    // attribution for a WRITE; the census attributes nothing, so requiring it here
    // made the read-only door unusable from any unattributed caller.
    h.identity.mockImplementation(() => {
      throw new Error('resolveAgentIdentity: context carries no identity');
    });

    const out = body(await call({}, {}));

    expect(out.ok).toBe(true);
    expect(h.identity).not.toHaveBeenCalled();
  });

  it('passes the caller limit to the census read but drops it for mode:"file"', async () => {
    await call({ limit: 5 });
    expect(h.readClasses.mock.calls[0]![1]).toMatchObject({ limit: 5 });

    h.readClasses.mockClear();
    await call({ mode: 'file', toolName: 'coord:send', limit: 5 });
    // A limit that could hide the requested surface from its own file call is a silent
    // no_class_for_surface — so `file` always reads the whole set.
    expect(h.readClasses.mock.calls[0]![1]).toMatchObject({ limit: undefined });
  });
});

describe('improvements:filing-classes — refusals never create a work-item', () => {
  it('refuses mode:"file" with no toolName', async () => {
    const out = body(await call({ mode: 'file' }));
    expect(out).toMatchObject({ ok: false, error: 'mode:"file" requires toolName' });
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });

  it('refuses a surface that is not at the class threshold', async () => {
    const out = body(await call({ mode: 'file', toolName: 'plans:get' }));
    expect(out).toMatchObject({ ok: false, error: 'no_class_for_surface', minMembers: 3 });
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });

  it('refuses a class whose members are all terminal, and reports the state split', async () => {
    h.readClasses.mockResolvedValue(
      aCensus([aClass({ openMemberCount: 0, openMemberIds: [], byState: { dropped: 3 } })]),
    );

    const out = body(await call({ mode: 'file', toolName: 'coord:send' }));

    // memberCount alone would have filed here; openMemberCount is the actionable number.
    expect(out).toMatchObject({ ok: false, error: 'class_has_no_open_members', memberCount: 3 });
    expect(out.byState).toEqual({ dropped: 3 });
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });

  it('reports an already-open class item instead of filing a second one', async () => {
    h.sql.mockResolvedValue([{ feature_id: 'WI-EXISTING', status: 'open' }]);

    const out = body(await call({ mode: 'file', toolName: 'coord:send' }));

    expect(out).toMatchObject({ ok: true, filed: false, reason: 'class_item_already_open' });
    expect(out.existing).toEqual({ id: 'WI-EXISTING', state: 'open' });
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });

  it('force:true files past an already-open class item', async () => {
    h.sql.mockResolvedValue([{ feature_id: 'WI-EXISTING', status: 'open' }]);

    const out = body(await call(
      { mode: 'file', toolName: 'coord:send', force: true },
      { harnessSlug: 'papercusp' },
    ));

    expect(out).toMatchObject({ ok: true, filed: true, classItem: 'WI-CLASS-1' });
    expect(h.createWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe('improvements:filing-classes — filing is ADDITIVE (D-001)', () => {
  it('creates ONE born-admitted class item and cites every member with a relates edge', async () => {
    const out = body(await call({ mode: 'file', toolName: 'coord:send' }, { harnessSlug: 'papercusp' }));

    expect(h.createWorkItem).toHaveBeenCalledTimes(1);
    const created = h.createWorkItem.mock.calls[0]![0] as Record<string, unknown>;
    expect(created).toMatchObject({
      kind: 'change',
      harness: 'papercusp',
      createdBy: 'su-filer',
      workspaceId: 'papercusp-workspace',
      // Duplicate screening is what the class row IS the aggregate of; an unassigned
      // pending create would be unclaimable for the promoter window.
      admission: 'auto',
      admittedBy: 'bypass:filing-class-aggregation',
    });
    // Without the topic the row is invisible to improvements:triage, the digest and
    // the auto-implement lane, all of which select on it — the class would aggregate
    // and then arrive NOWHERE. Asserted against the constant those readers use, so a
    // rename cannot silently un-tag the class row.
    expect(created.topics).toEqual([IMPROVEMENT_TOPIC]);
    // The surface must be recoverable from the row itself — findExistingClassItem reads it.
    expect((created.payload as { filingClass?: { toolName?: string } }).filingClass?.toolName).toBe('coord:send');

    // Every member is CITED — including members whose work-item is already terminal, so
    // the class stays a complete record of what it aggregates.
    expect(h.linkWorkItem).toHaveBeenCalledTimes(3);
    for (const c of h.linkWorkItem.mock.calls) {
      expect(c[0]).toBe('WI-CLASS-1');
      expect(c[1]).toMatchObject({ kind: 'issue' });
      expect(c[2]).toBe('relates');
    }
    expect(h.linkWorkItem.mock.calls.map((c) => (c[1] as { ref: string }).ref)).toEqual([
      'EI-1',
      'EI-2',
      'EI-3',
    ]);
    expect(out).toMatchObject({ ok: true, filed: true, memberCount: 3, citedMembers: 3 });
  });

  it('reports a failed citation edge instead of sinking the class row', async () => {
    h.linkWorkItem
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ error: 'target_not_found' })
      .mockResolvedValueOnce({ ok: true });

    const out = body(await call(
      { mode: 'file', toolName: 'coord:send' },
      { harnessSlug: 'papercusp' },
    ));

    // The row already names every member in its body and payload, so a broken edge is a
    // reported degradation, never a thrown filing.
    expect(out).toMatchObject({ ok: true, filed: true, classItem: 'WI-CLASS-1' });
    expect(out.linkErrors).toEqual([{ targetId: 'EI-2', error: 'target_not_found' }]);
  });
});
