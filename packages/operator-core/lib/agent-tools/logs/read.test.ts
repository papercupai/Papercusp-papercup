/**
 * logs:read handler wiring — plan `bash-to-tool-substitution-2026-07-26`, P-023
 * (D-027).
 *
 * The parsing and journalctl semantics are unit-tested in `journal-read.test.ts`;
 * this pins the ENVELOPE decisions the tool itself owns: unit-name resolution,
 * the unscoped-read guard, and that `ok` tracks the READ succeeding rather than
 * any lines being found (an empty clean window is a successful read).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { readJournalMock } = vi.hoisted(() => ({ readJournalMock: vi.fn() }));

vi.mock('../../journal-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readJournal: readJournalMock,
}));

import logsReadTool from './read';
import { JOURNAL_READ_MAX_LIMIT } from '../../journal-read';

const CLEAN = {
  entries: [],
  matched: 0,
  collapsed: 0,
  truncated: false,
  window: { since: '-30 min', until: null },
  units: [],
  journalAvailable: true,
  backend: 'systemd',
  journalError: null,
  command: 'journalctl …',
};

/** The handler returns the structured `{ data }` envelope; the MCP projection
 *  happens above it, so tests read `data` directly. */
function payloadOf(res: { data: Record<string, unknown> }): Record<string, unknown> {
  return res.data;
}

const call = (args: Record<string, unknown>) =>
  logsReadTool.handler(args as never, {} as never) as Promise<{ data: Record<string, unknown> }>;

beforeEach(() => {
  readJournalMock.mockReset().mockResolvedValue(CLEAN);
});

describe('logs:read — payload-tier shapers are WIRED (EI-20203342112661815)', () => {
  // read-shape.test.ts proves the shaper's behaviour; this proves the tool
  // actually reaches it. Without the `shape` seam the shaper is dead code and
  // the generic result door resumes cutting the array HEAD — handing back the
  // OLDEST rows while the tool documents "newest kept".
  const shapeOf = (tier: 'trimmed' | 'standard') =>
    (logsReadTool as unknown as { shape?: Record<string, (d: unknown) => unknown> }).shape?.[tier];

  it('declares both tier shapers', () => {
    expect(typeof shapeOf('trimmed')).toBe('function');
    expect(typeof shapeOf('standard')).toBe('function');
  });

  it('the wired trimmed shaper bounds an oversized payload and keeps the NEWEST rows', () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      unit: 'papercusp-dev-api.service',
      ts: `2026-09-05T07:00:00.${String(i).padStart(3, '0')}Z`,
      level: 'info',
      repeat: 1,
      message: `seq-${i} ${'x'.repeat(500)}`,
    }));
    const out = shapeOf('trimmed')!({ entries, matched: 121, truncated: true }) as {
      entries: Record<string, unknown>[];
      payloadBounded?: { droppedOldest?: number };
    };
    const kept = out.entries.filter((r) => !r._truncated).map((r) => String(r.message));
    expect(kept.length).toBeLessThan(120);
    expect(kept.at(-1)).toMatch(/^seq-119 /);
    expect(kept.some((m) => m.startsWith('seq-0 '))).toBe(false);
    expect(out.payloadBounded?.droppedOldest).toBeGreaterThan(0);
  });
});

describe('logs:read — nested result fields are published to callers', () => {
  it('declares the backend, collapsed-row timestamps, and shaper markers in the result schema', () => {
    const result = (logsReadTool as unknown as {
      result: { toJSONSchema: () => { properties?: Record<string, unknown>; required?: string[] } };
    }).result.toJSONSchema();

    expect(result.properties?.backend).toMatchObject({
      type: 'string',
      enum: ['systemd', 'macos-unified', 'none'],
    });
    expect(result.required ?? []).not.toContain('backend');
    expect(result.properties?.entries).toMatchObject({
      type: 'array',
      items: {
        properties: {
          lastTs: { type: 'string' },
          clipped: { const: true },
          _truncated: { const: true },
        },
      },
    });
  });
});

describe('logs:read — dispatch transaction boundary', () => {
  it('does not retain an ambient workspace transaction during journalctl host I/O', () => {
    expect((logsReadTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('logs:read — unit resolution', () => {
  it('documents the real service prefix and journal scope semantics', () => {
    const argsSchema = (logsReadTool as unknown as {
      args: { toJSONSchema: () => { properties?: Record<string, { description?: string }> } };
    }).args.toJSONSchema();
    const unitDescription = argsSchema.properties?.unit?.description ?? '';
    const scopeDescription = argsSchema.properties?.scope?.description ?? '';

    expect(unitDescription).toContain("'papercup-bg-host' → 'papercup-bg-host.service'");
    expect(unitDescription).not.toContain('papercusp-bg-host');
    expect(scopeDescription).toContain('no unit-name prefix filter');
    expect(scopeDescription).not.toContain('papercusp-* units');
  });

  it('suffixes a bare unit name with .service', async () => {
    await call({ unit: 'papercup-bg-host' });
    expect(readJournalMock.mock.calls[0][0].units).toEqual(['papercup-bg-host.service']);
  });

  it('leaves a non-.service unit type alone (the .timer mangling bug)', async () => {
    await call({ unit: 'papercup-live-federation-gate.timer' });
    expect(readJournalMock.mock.calls[0][0].units).toEqual(['papercup-live-federation-gate.timer']);
  });

  it('leaves an explicit transient .scope unit alone', async () => {
    await call({ unit: 'run-u294390.scope' });
    expect(readJournalMock.mock.calls[0][0].units).toEqual(['run-u294390.scope']);
  });

  it('accepts several units as one merged stream', async () => {
    await call({ unit: ['papercup-dev-api', 'papercup-staging-api.service'] });
    expect(readJournalMock.mock.calls[0][0].units).toEqual([
      'papercup-dev-api.service',
      'papercup-staging-api.service',
    ]);
  });
});

describe('logs:read — the unscoped-read guard', () => {
  it('refuses a host-wide scan with no window, and never reaches the journal', async () => {
    const out = payloadOf(await call({}));
    expect(out).toMatchObject({ ok: false, error: 'unscoped_read_needs_since' });
    expect(readJournalMock).not.toHaveBeenCalled();
  });

  it('ALLOWS a host-wide scan once an explicit window is given', async () => {
    const out = payloadOf(await call({ since: '-60 min' }));
    expect(out.ok).toBe(true);
    expect(readJournalMock.mock.calls[0][0]).toMatchObject({ since: '-60 min', units: [] });
  });

  it('does not require `since` when an identifier scopes the read', async () => {
    const out = payloadOf(await call({ identifier: 'oddsmith-alert' }));
    expect(out.ok).toBe(true);
    expect(readJournalMock).toHaveBeenCalled();
  });

  it('does not require `since` when a unit scopes the read', async () => {
    expect(payloadOf(await call({ unit: 'papercup-bg-host' })).ok).toBe(true);
  });
});

describe('logs:read — ok reflects the READ, not the line count', () => {
  it('is ok for an empty but genuinely clean window', async () => {
    const out = payloadOf(await call({ unit: 'a', grep: 'never-appears' }));
    expect(out).toMatchObject({ ok: true, journalAvailable: true, journalError: null });
    expect(out.entries).toEqual([]);
  });

  it('is NOT ok when the read failed — so empty entries cannot read as clean', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, journalError: 'Failed to add match' });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out.ok).toBe(false);
    expect(out.journalError).toBe('Failed to add match');
  });

  it('is ok on a host with NO journal, but says so rather than reporting an empty log', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, journalAvailable: false });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out).toMatchObject({ ok: true, journalAvailable: false, journalError: null });
  });

  it('projects the selected macOS backend so callers can distinguish native unified logs', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, backend: 'macos-unified' });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out).toMatchObject({ ok: true, backend: 'macos-unified' });
  });
});

describe('logs:read — journal/file boundary', () => {
  it('routes release log files to capability:read instead of journal unit arguments', () => {
    const guidance = (logsReadTool as unknown as { guidance?: { notWhen?: string } }).guidance;
    expect(guidance?.notWhen).toContain('capability:read { file_path: <logPath>, tail: N }');
    expect(guidance?.notWhen).toContain('not `logs:read` with the path as a journal unit');
  });
});

describe('logs:read — arguments reach journalctl unchanged', () => {
  it('publishes the same maximum row count enforced by the argument schema', () => {
    const shape = (logsReadTool as unknown as {
      args: { shape: { limit: { description?: string } } };
    }).args.shape;
    expect(shape.limit.description).toContain(`up to ${JOURNAL_READ_MAX_LIMIT}`);
  });

  it('forwards grep, level, window, limit and scope verbatim', async () => {
    await call({
      unit: 'papercup-bg-host',
      grep: 'oom|killed process',
      level: 'err',
      since: '-2 hours',
      until: '09:40:00',
      limit: 50,
      scope: 'system',
    });
    expect(readJournalMock.mock.calls[0][0]).toMatchObject({
      grep: 'oom|killed process',
      level: 'err',
      since: '-2 hours',
      until: '09:40:00',
      limit: 50,
      scope: 'system',
    });
  });

  it("accepts scope 'all' — the read that spans both journals", async () => {
    expect(payloadOf(await call({ unit: 'systemd-oomd', scope: 'all' })).ok).toBe(true);
    expect(readJournalMock.mock.calls[0][0].scope).toBe('all');
  });

  it('documents the bare absolute timestamp timezone boundary', () => {
    const shape = (logsReadTool as unknown as { args: { shape: Record<string, { description?: string }> } }).args.shape;
    expect(shape.since.description).toMatch(/LOCAL timezone/i);
    expect(shape.since.description).toMatch(/returned entry timestamps are UTC/i);
    expect(shape.until.description).toMatch(/LOCAL-time rule/i);
    expect(shape.until.description).toMatch(/explicit @epoch/i);
  });
});
