// Behavior of the PgCoordLog browser stub. (That the shim exports the RIGHT names
// at all is enforced generically for every shim in browser-shims.test.ts — the
// EI-10539 detector.)
//
// The stub exists because `agent-tools/coordination/log.ts` constructs a
// PgCoordLog at MODULE SCOPE (`let impl: CoordEventLog = makeDefaultLog()`), so the
// SPA constructs one merely by importing that module. Construction must therefore
// be silent — and any actual CALL must be loud, because the coord event log is a
// server surface reached over the API. A silent no-op stub would swallow coord
// writes and surface as "flaky coordination" instead of a stack trace.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COORD_WORKSPACE,
  ensureCoordEventLogTable,
  parseBody,
  PgCoordLog,
} from '../shims/coordination-event-log-browser';

describe('PgCoordLog browser stub', () => {
  it('constructs silently — log.ts builds one at module scope, in the browser', () => {
    expect(() => new PgCoordLog({ getSql: () => null, ensureSchema: async () => {} })).not.toThrow();
  });

  it('throws loudly on any call — never a silent no-op that swallows coord writes', () => {
    const log = new PgCoordLog() as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => log.append({})).toThrow(/server-only/);
    expect(() => log.read()).toThrow(/server-only/);
    // A method nobody has written yet must throw too, not arrive as `undefined`.
    expect(() => log.someFutureMethod()).toThrow(/server-only/);
  });

  it('does not masquerade as a thenable — an await/console.log on it must not explode', async () => {
    const log = new PgCoordLog();
    await expect(Promise.resolve(log)).resolves.toBeDefined();
    expect(() => String(log)).not.toThrow();
  });

  it('still exports the workspace constant the client actually uses', () => {
    expect(DEFAULT_COORD_WORKSPACE).toBe('default');
  });

  it('parses a stored body and backstops identity from the row columns', () => {
    const rowTs = new Date('2026-10-07T19:00:00.000Z');
    expect(
      parseBody('{"ts":"","msg_id":"stale","kind":"message"}', {
        ts: rowTs,
        msg_id: 'row-42',
      }),
    ).toEqual({ ts: rowTs.toISOString(), msg_id: 'row-42', kind: 'message' });
  });

  it('links the schema-bootstrap binding but fails loudly if the browser calls it', async () => {
    await expect(ensureCoordEventLogTable(null)).rejects.toThrow(/server-only/);
  });
});
