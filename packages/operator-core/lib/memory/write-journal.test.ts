import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// memory-write-journal-auto-recovery P-009 — unit tests for the write-ahead
// journal: the INSERT-first write path, and the drain's replay / near-dup
// guard / update-replay / attempts-cap behavior. PG is faked with a
// content-dispatching sql tag; the backend with vi.fn()s.
// ---------------------------------------------------------------------------

interface Exec { text: string; values: unknown[] }
const executed: Exec[] = [];
/** Rows returned for the drain's pending-SELECT on the next call. */
let pendingRows: unknown[] = [];
let insertFails = false;

// Deliberately NO `json` helper on the fake: sql.json() mis-binds and throws on
// this stack's prepare:false (pgbouncer) pools, so the journal must never call
// it — a regression back to sql.json fails here as "sql.json is not a function"
// instead of silently passing against a fake that models behavior production
// doesn't have (the WI-4021 zero-rows-ever-journaled incident).
const sqlTag = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    executed.push({ text, values });
    if (insertFails) throw new Error('relation does not exist');
    if (text.startsWith('INSERT INTO harness_shared.memory_write_journal')) {
      return [{ id: 'journal-row-1' }];
    }
    if (text.includes('FROM harness_shared.memory_write_journal') && text.includes("status = 'pending'") && text.includes('FOR UPDATE')) {
      return pendingRows;
    }
    return [];
  },
  { begin: vi.fn() },
);

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: sqlTag }) }));

const backend = {
  available: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['new-mem-1'], storedEvents: 1 })),
  update: vi.fn(async () => {}),
  search: vi.fn(async () => [] as Array<{ id: string; text?: string; score?: number }>),
  get: vi.fn(async () => null as null | { id: string; text: string; scope: string; metadata?: Record<string, unknown> }),
  invalidateEntry: vi.fn(async () => true),
};
vi.mock('./backend', () => ({ getMemoryBackend: () => backend }));

import { journalPendingWrite, markJournalCommitted, drainMemoryWriteJournal } from './write-journal';

const baseRow = {
  id: 'row-1', requested_at: '2026-07-10T20:00:00Z', scope: 'userA', kind: 'project',
  content: 'the fact', metadata: { scope: 'user' }, verbatim: true, shareable: null, attempts: 0,
};

beforeEach(() => {
  executed.length = 0;
  pendingRows = [];
  insertFails = false;
  backend.available.mockClear().mockResolvedValue({ ok: true });
  backend.remember.mockClear().mockResolvedValue({ ids: ['new-mem-1'], storedEvents: 1 });
  backend.update.mockClear().mockResolvedValue(undefined);
  backend.search.mockClear().mockResolvedValue([]);
  backend.get.mockClear().mockResolvedValue(null);
  backend.invalidateEntry.mockClear().mockResolvedValue(true);
});

describe('journalPendingWrite / markJournalCommitted', () => {
  it('INSERTs the write-ahead row and returns its id', async () => {
    const id = await journalPendingWrite({ scope: 'userA', content: 'fact', kind: 'project' });
    expect(id).toBe('journal-row-1');
    expect(executed[0].text).toContain('INSERT INTO harness_shared.memory_write_journal');
    expect(executed[0].values).toContain('userA');
  });

  it('binds metadata as a JSON string cast ::text::jsonb — never an object parameter', async () => {
    const id = await journalPendingWrite({
      scope: 'userA', content: 'fact', metadata: { a: 1, nested: { b: 'x' } },
    });
    expect(id).toBe('journal-row-1');
    expect(executed[0].text).toContain('::text::jsonb');
    expect(executed[0].values).toContain(JSON.stringify({ a: 1, nested: { b: 'x' } }));
    // every bound value must be a primitive/null — an object here reproduces the
    // prepare:false mis-bind that skipped journaling on every production write
    for (const v of executed[0].values) {
      expect(typeof v === 'object' && v !== null).toBe(false);
    }
  });

  it('persists the shareable backend option as a first-class journal value', async () => {
    const id = await journalPendingWrite({
      scope: 'hive:papercusp', content: 'federated fact', shareable: true,
    });
    expect(id).toBe('journal-row-1');
    expect(executed[0].text).toContain('(scope, kind, content, metadata, verbatim, shareable, source)');
    expect(executed[0].values).toContain(true);
  });

  it('degrades to null (never throws) when the journal table is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      insertFails = true;
      await expect(journalPendingWrite({ scope: 'u', content: 'x' })).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('markJournalCommitted closes only pending rows, and never throws', async () => {
    await markJournalCommitted('row-1', 'mem-9');
    expect(executed[0].text).toContain("SET status = 'committed'");
    expect(executed[0].text).toContain("status = 'pending'");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      insertFails = true;
      await expect(markJournalCommitted('row-1')).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('drainMemoryWriteJournal', () => {
  it('no pending rows → early return, backend never touched', async () => {
    const r = await drainMemoryWriteJournal();
    expect(r.scanned).toBe(0);
    expect(backend.available).not.toHaveBeenCalled();
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('backend still unavailable → rows left untouched (no attempt burned)', async () => {
    pendingRows = [{ ...baseRow }];
    backend.available.mockResolvedValue({ ok: false, reason: 'embedder down' });
    const r = await drainMemoryWriteJournal();
    expect(r.stillPending).toBe(1);
    expect(backend.remember).not.toHaveBeenCalled();
    // no UPDATE was issued — attempts only count real replay failures
    expect(executed.filter((e) => e.text.startsWith('UPDATE'))).toHaveLength(0);
  });

  it('replays a pending remember with recovered_from provenance and commits', async () => {
    pendingRows = [{ ...baseRow }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.remember).toHaveBeenCalledTimes(1);
    const [content, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(content).toBe('the fact');
    expect((opts.metadata as Record<string, unknown>).recovered_from).toBe('journal');
    expect((opts.metadata as Record<string, unknown>).recovered_journal_id).toBe('row-1');
    const commit = executed.find((e) => e.text.includes("SET status = 'committed'"));
    expect(commit?.values).toContain('new-mem-1');
    expect(r.recoveredWindow).toEqual({ from: baseRow.requested_at, to: baseRow.requested_at });
  });

  it('replays shareable=true while historical/private rows remain private by default', async () => {
    pendingRows = [{ ...baseRow, id: 'row-shareable', shareable: true }];
    await drainMemoryWriteJournal();
    let [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.shareable).toBe(true);

    backend.remember.mockClear();
    pendingRows = [{ ...baseRow, id: 'row-private', shareable: null }];
    await drainMemoryWriteJournal();
    [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts).not.toHaveProperty('shareable');
  });

  it('replays a superseding remember, strips its journal marker, then closes the old window', async () => {
    pendingRows = [{
      ...baseRow,
      metadata: {
        scope: 'user',
        __journal_supersede_of: 'old-mem-1',
      },
    }];

    const r = await drainMemoryWriteJournal();

    expect(r.recovered).toBe(1);
    expect(backend.invalidateEntry).toHaveBeenCalledWith('old-mem-1', {
      supersededBy: 'new-mem-1',
    });
    const [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.metadata).not.toHaveProperty('__journal_supersede_of');
    expect(backend.remember.mock.invocationCallOrder[0]).toBeLessThan(
      backend.invalidateEntry.mock.invocationCallOrder[0],
    );
  });

  it('finishes a supersession after the replacement already landed (dedup replay)', async () => {
    pendingRows = [{
      ...baseRow,
      metadata: { scope: 'user', __journal_supersede_of: 'old-mem-1' },
    }];
    backend.search.mockResolvedValue([
      { id: 'already-written-new', text: 'the fact', score: 0.0328 },
    ]);

    const r = await drainMemoryWriteJournal();

    expect(r.deduped).toBe(1);
    expect(backend.remember).not.toHaveBeenCalled();
    expect(backend.invalidateEntry).toHaveBeenCalledWith('old-mem-1', {
      supersededBy: 'already-written-new',
    });
  });

  // EI-10544: the near-dup verdict is made on the TEXT, never on the backend's
  // `score` — whose scale is backend-defined (the live hybrid backend returns
  // RRF rank-fusion, an ORDINAL value whose ceiling is 2/61 ≈ 0.033, so the 0.9
  // threshold was unreachable and this guard NEVER fired in production: 0 of 42
  // live journal rows were ever deduped). Each case therefore pairs the text it
  // expects with an ADVERSARIAL score — one that would have driven the old
  // score-threshold guard to the OPPOSITE verdict.

  it('P-004 near-dup guard: an unmistakable duplicate closes the row without re-writing', async () => {
    pendingRows = [{ ...baseRow }];
    // Exact duplicate, scored on the RRF band (2/61 — the strongest score the
    // live hybrid backend can emit). The old `score >= 0.9` guard could not fire.
    backend.search.mockResolvedValue([{ id: 'existing-1', text: 'the fact', score: 0.0328 }]);
    const r = await drainMemoryWriteJournal();
    expect(r.deduped).toBe(1);
    expect(r.recovered).toBe(0);
    expect(backend.remember).not.toHaveBeenCalled();
    const commit = executed.find((e) => e.text.includes('deduped_on_drain'));
    expect(commit?.values).toContain('existing-1');
  });

  it('a borderline match errs toward recovering the fact, however high the backend scored it', async () => {
    pendingRows = [{ ...baseRow }];
    // Different fact, scored 0.95 — the old guard would have SUPPRESSED this
    // recovery on a cosine-scaled backend. Losing a fact is the failure the
    // journal exists to prevent, so only the text may decide.
    backend.search.mockResolvedValue([
      { id: 'existing-1', text: 'an entirely different fact about the gate', score: 0.95 },
    ]);
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.remember).toHaveBeenCalledTimes(1);
  });

  it('a neighbour with no text is never judged a duplicate (unjudgeable → recover)', async () => {
    pendingRows = [{ ...baseRow }];
    backend.search.mockResolvedValue([{ id: 'existing-1', score: 0.99 }]);
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(r.deduped).toBe(0);
  });

  it('replays a journaled text UPDATE via backend.update (never as a new add)', async () => {
    pendingRows = [{
      ...baseRow, id: 'row-u', scope: '__update__:mem-7',
      metadata: { __journal_update_of: 'mem-7' }, content: 'edited text',
    }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    // EI-10371: an update-replay re-stamps the credential flag both ways,
    // matching a live edit's semantics — clean text clears it.
    expect(backend.update).toHaveBeenCalledWith('mem-7', {
      text: 'edited text',
      metadata: { possible_secret: false, possible_secret_classes: [] },
    });
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('replays a journaled update patch and closes its superseded target before commit', async () => {
    pendingRows = [{
      ...baseRow,
      id: 'row-us',
      scope: 'userA',
      content: 'edited text',
      metadata: {
        __journal_update_of: 'new-mem',
        __journal_supersede_of: 'old-mem',
        __journal_update_patch: { text: 'edited text', metadata: { kind: 'project' } },
      },
    }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.update).toHaveBeenCalledWith('new-mem', {
      text: 'edited text', metadata: { kind: 'project' },
    });
    expect(backend.invalidateEntry).toHaveBeenCalledWith('old-mem', { supersededBy: 'new-mem' });
    expect(backend.update.mock.invocationCallOrder[0]).toBeLessThan(
      backend.invalidateEntry.mock.invocationCallOrder[0],
    );
  });

  // EI-26515229747561182: a refused link with NO winner is not a lost race —
  // the drain must keep the replacement current and leave the row to retry.
  it('an update-supersede replay whose link is refused with no winner keeps the replacement and stays pending', async () => {
    pendingRows = [{
      ...baseRow,
      id: 'row-nw',
      scope: 'userA',
      content: 'edited text',
      metadata: { __journal_update_of: 'new-mem', __journal_supersede_of: 'old-mem' },
    }];
    backend.invalidateEntry.mockResolvedValueOnce(false);
    backend.get.mockResolvedValueOnce({
      id: 'old-mem', text: 'old', scope: 'userA',
      metadata: { validity: { status: 'superseded', superseded_by: null } },
    });
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(0);
    expect(r.stillPending).toBe(1);
    expect(backend.invalidateEntry).toHaveBeenCalledTimes(1);
    expect(backend.invalidateEntry).not.toHaveBeenCalledWith('new-mem');
  });

  it('an update-supersede replay whose superseded row is gone commits without closing the replacement', async () => {
    pendingRows = [{
      ...baseRow,
      id: 'row-gone',
      scope: 'userA',
      content: 'edited text',
      metadata: { __journal_update_of: 'new-mem', __journal_supersede_of: 'old-mem' },
    }];
    backend.invalidateEntry.mockResolvedValueOnce(false);
    backend.get.mockResolvedValueOnce(null);
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.invalidateEntry).toHaveBeenCalledTimes(1);
    expect(backend.invalidateEntry).not.toHaveBeenCalledWith('new-mem');
  });

  it('an update-supersede replay that lost to a DIFFERENT winner closes the replacement and retries', async () => {
    pendingRows = [{
      ...baseRow,
      id: 'row-lost',
      scope: 'userA',
      content: 'edited text',
      metadata: { __journal_update_of: 'new-mem', __journal_supersede_of: 'old-mem' },
    }];
    backend.invalidateEntry.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    backend.get.mockResolvedValueOnce({
      id: 'old-mem', text: 'old', scope: 'userA',
      metadata: { validity: { status: 'superseded', superseded_by: 'other-winner' } },
    });
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(0);
    expect(backend.invalidateEntry).toHaveBeenNthCalledWith(2, 'new-mem');
  });

  it('EI-10371: re-detects credentials at replay time and stamps the flag', async () => {
    // A row journaled BEFORE stamping existed (no flag in its metadata) whose
    // content is credential-shaped — the drain must land it flagged.
    const connString = ['postgres://', 'app_user', ':', 's3cret', '@db.internal/prod'].join('');
    pendingRows = [{ ...baseRow, content: `DB dsn is ${connString}` }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    const [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const meta = opts.metadata as Record<string, unknown>;
    expect(meta.possible_secret).toBe(true);
    expect(meta.possible_secret_classes).toEqual(['url-with-password']);

    // …and an UPDATE replay of credential-shaped text stamps true.
    backend.update.mockClear();
    pendingRows = [{
      ...baseRow, id: 'row-u2', scope: '__update__:mem-8',
      metadata: { __journal_update_of: 'mem-8' }, content: `now at ${connString}`,
    }];
    await drainMemoryWriteJournal();
    expect(backend.update).toHaveBeenCalledWith('mem-8', {
      text: `now at ${connString}`,
      metadata: { possible_secret: true, possible_secret_classes: ['url-with-password'] },
    });
  });

  it('a replay failure bumps attempts and keeps the row pending; the cap parks it failed_permanent', async () => {
    pendingRows = [{ ...baseRow }];
    backend.remember.mockRejectedValue(new Error('still down'));
    let r = await drainMemoryWriteJournal();
    expect(r.stillPending).toBe(1);
    let upd = executed.find((e) => e.text.startsWith('UPDATE'));
    expect(upd?.values).toContain('pending');

    executed.length = 0;
    pendingRows = [{ ...baseRow, attempts: 29 }]; // MAX_ATTEMPTS default 30
    r = await drainMemoryWriteJournal();
    expect(r.retriesExhausted).toBe(1);
    upd = executed.find((e) => e.text.startsWith('UPDATE'));
    expect(upd?.values).toContain('failed_permanent');
  });
});
