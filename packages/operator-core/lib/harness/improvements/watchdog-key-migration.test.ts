/**
 * watchdog-key-migration.test.ts — the pure key-migration backfill
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012, re-targeted by
 * bug-inflow-one-problem-one-row-2026-10-18 D-004 at the STRUCTURAL key). Proves
 * the deriver recomputes a legacy key from an EI's stored body sample (plus the
 * ledger's error code when supplied), that the generic routine is
 * dry-run-by-default + collision-safe + idempotent, and that the parse/extract
 * helpers are robust to colon-bearing tool names.
 */
import { describe, it, expect } from 'vitest';
import type { ImprovementCandidate } from './policy';
import {
  parseRepeatedToolErrorKey,
  extractSampleFromBody,
  deriveToolErrorWatchdogKey,
  recomputeWatchdogKeys,
  type RecomputeDeps,
} from './watchdog-key-migration';

function ei(over: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 't', state: 'open', ...over };
}

const callerBody =
  'Watchdog signal (caller/DX tool-error): plans:new rejected caller input 12× (40% of 30 calls) — a ' +
  'sustained pattern suggests a confusing schema or a mis-scoped gate, not a tool bug.\n\n' +
  'Sample: invalid_args: note: Too big: expected string to have <=400 characters';

const structuralBody =
  'Watchdog signal (structural tool-error): plans:list returned a deterministic error 4× (8% of 50 calls) — ' +
  'the shape that recurs identically (a bug/misconfig), not transient load.\n\n' +
  'Sample error: column "initiative" does not exist';

// bug-inflow D-010: caller keys once per tool, so the code + field re-key mechanics are
// exercised on a STRUCTURAL key (same sample, same parts); CALLER_KEY keeps its name.
const CALLER_KEY = 'repeated-tool-error:plans:new:structural:invalid_args:note';
const STRUCTURAL_KEY = 'repeated-tool-error:plans:list:structural:error-code-unknown:initiative';
const LEGACY_MD5 = 'md5-0123456789abcdef0123456789abcdef';

describe('parseRepeatedToolErrorKey', () => {
  it('splits tool / class / code / field, tolerating colons in the tool name', () => {
    expect(parseRepeatedToolErrorKey('repeated-tool-error:plans:list:transient')).toEqual({
      tool: 'plans:list', klass: 'transient', errorCode: null, fieldPath: null, fingerprint: null,
    });
    expect(parseRepeatedToolErrorKey(CALLER_KEY)).toEqual({
      tool: 'plans:new', klass: 'structural', errorCode: 'invalid_args', fieldPath: 'note', fingerprint: null,
    });
    expect(parseRepeatedToolErrorKey('repeated-tool-error:a:b:c:structural:handler_error:items.n.id')).toEqual({
      tool: 'a:b:c', klass: 'structural', errorCode: 'handler_error', fieldPath: 'items.n.id', fingerprint: null,
    });
  });

  it('parses LEGACY one-segment keys as a fingerprint (and bare keys as neither)', () => {
    expect(parseRepeatedToolErrorKey(`repeated-tool-error:memory:search:structural:${LEGACY_MD5}`)).toEqual({
      tool: 'memory:search', klass: 'structural', errorCode: null, fieldPath: null, fingerprint: LEGACY_MD5,
    });
    expect(parseRepeatedToolErrorKey('repeated-tool-error:coord:thread:caller')).toEqual({
      tool: 'coord:thread', klass: 'caller', errorCode: null, fieldPath: null, fingerprint: null,
    });
  });

  it('returns null for non-tool-error keys', () => {
    expect(parseRepeatedToolErrorKey('red-test:packages/x/y.test.ts')).toBeNull();
    expect(parseRepeatedToolErrorKey('service-down:operator')).toBeNull();
    expect(parseRepeatedToolErrorKey('repeated-tool-error:plans:list:notaclass')).toBeNull();
  });
});

describe('extractSampleFromBody', () => {
  it('pulls the "Sample:" / "Sample error:" tail', () => {
    expect(extractSampleFromBody(callerBody)).toBe('invalid_args: note: Too big: expected string to have <=400 characters');
    expect(extractSampleFromBody(structuralBody)).toBe('column "initiative" does not exist');
  });
  it('returns null when there is no sample line', () => {
    expect(extractSampleFromBody('a body with no sample')).toBeNull();
    expect(extractSampleFromBody(undefined)).toBeNull();
  });
});

describe('deriveToolErrorWatchdogKey', () => {
  it('re-keys a pre-D-010 caller key (any code / field / fingerprint) to ONE key per tool (bug-inflow D-010)', () => {
    for (const old of [
      'repeated-tool-error:plans:new:caller:invalid_args:note',
      'repeated-tool-error:plans:new:caller:invalid_args:status',
      `repeated-tool-error:plans:new:caller:${LEGACY_MD5}`,
    ]) {
      expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-c', watchdogKey: old, body: callerBody })))
        .toBe('repeated-tool-error:plans:new:caller');
    }
    // Already per tool: left alone.
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-c', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody })))
      .toBeNull();
  });

  it('re-keys a bare legacy structural key to tool + class + code + field', () => {
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:structural', body: callerBody })))
      .toBe(CALLER_KEY);
  });

  it('re-keys a legacy md5 / first-six-token fingerprint key onto the same structural key', () => {
    for (const fp of [LEGACY_MD5, 'invalid-args-note-too-big-expected']) {
      expect(deriveToolErrorWatchdogKey(ei({
        id: `EI-${fp}`,
        watchdogKey: `repeated-tool-error:plans:new:structural:${fp}`,
        body: callerBody,
      }))).toBe(CALLER_KEY);
    }
  });

  it('migrates a legacy STRUCTURAL key, using the ledger error code when one is supplied', () => {
    const candidate = ei({ id: 'EI-2', watchdogKey: 'repeated-tool-error:plans:list:structural', body: structuralBody });
    expect(deriveToolErrorWatchdogKey(candidate)).toBe(STRUCTURAL_KEY);
    const seen: Array<[string, string]> = [];
    const withCode = deriveToolErrorWatchdogKey(candidate, (_c, tool, sample) => {
      seen.push([tool, sample]);
      return 'undefined_column';
    });
    expect(withCode).toBe('repeated-tool-error:plans:list:structural:undefined_column:initiative');
    expect(seen).toEqual([['plans:list', 'column "initiative" does not exist']]);
  });

  it('collapses a fingerprinted TRANSIENT key to one row per tool, with no sample needed', () => {
    expect(deriveToolErrorWatchdogKey(ei({
      id: 'EI-t', watchdogKey: `repeated-tool-error:locks:acquire:transient:${LEGACY_MD5}`, body: 'no sample line',
    }))).toBe('repeated-tool-error:locks:acquire:transient');
  });

  it('leaves the tool-keyed classes alone when already in shape (rate-limit stays coarse)', () => {
    expect(deriveToolErrorWatchdogKey(ei({
      id: 'EI-3', watchdogKey: 'repeated-tool-error:memory:search:rate-limit',
      body: 'x.\n\nSample: openai_embed_failed_429 rate limit reached',
    }))).toBeNull();
  });

  it('is idempotent — a key already in the structural shape is left alone', () => {
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-4', watchdogKey: CALLER_KEY, body: callerBody }))).toBeNull();
  });

  it('returns null for non-tool-error keys and for structural/caller bodies with no sample', () => {
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-5', watchdogKey: 'red-test:foo.test.ts', body: structuralBody }))).toBeNull();
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-6', watchdogKey: 'repeated-tool-error:t:caller', body: 'no sample line here' }))).toBeNull();
  });
});

describe('recomputeWatchdogKeys', () => {
  function deps(items: ImprovementCandidate[]): RecomputeDeps & { writes: { id: string; newKey: string }[] } {
    const writes: { id: string; newKey: string }[] = [];
    return {
      writes,
      listOpenKeyed: async () => items,
      setWatchdogKey: async (id, newKey) => { writes.push({ id, newKey }); },
    };
  }

  it('dry-run (default) reports changes but writes nothing', async () => {
    const d = deps([ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:structural', body: callerBody })]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d);
    expect(res.dryRun).toBe(true);
    expect(res.changed).toEqual([{ id: 'EI-1', oldKey: 'repeated-tool-error:plans:new:structural', newKey: CALLER_KEY }]);
    expect(d.writes).toEqual([]);
  });

  it('execute mode persists each recomputed key', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:structural', body: callerBody }),
      ei({ id: 'EI-2', watchdogKey: 'repeated-tool-error:plans:list:structural', body: structuralBody }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed).toHaveLength(2);
    expect(d.writes).toEqual([
      { id: 'EI-1', newKey: CALLER_KEY },
      { id: 'EI-2', newKey: STRUCTURAL_KEY },
    ]);
  });

  it('two legacy rows that fold onto ONE structural key: the first migrates, the second is a collision', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: `repeated-tool-error:plans:new:structural:${LEGACY_MD5}`, body: callerBody }),
      ei({ id: 'EI-2', watchdogKey: 'repeated-tool-error:plans:new:structural:invalid-args-note-too-big-expected', body: callerBody }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed.map((c) => c.id)).toEqual(['EI-1']);
    expect(res.collisions).toEqual([{
      id: 'EI-2',
      oldKey: 'repeated-tool-error:plans:new:structural:invalid-args-note-too-big-expected',
      newKey: CALLER_KEY,
      heldBy: 'EI-1',
    }]);
    expect(d.writes).toEqual([{ id: 'EI-1', newKey: CALLER_KEY }]);
  });

  it('skips + reports a collision when the new key already belongs to another open EI', async () => {
    const d = deps([
      // EI-1 would migrate INTO the key EI-2 already holds.
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:structural', body: callerBody }),
      ei({ id: 'EI-2', watchdogKey: CALLER_KEY, body: callerBody }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed).toEqual([]);
    expect(res.collisions).toEqual([{
      id: 'EI-1',
      oldKey: 'repeated-tool-error:plans:new:structural',
      newKey: CALLER_KEY,
      heldBy: 'EI-2',
    }]);
    expect(d.writes).toEqual([]);
  });

  it('R-7: two open EIs that ALREADY share an exact key — the later one is a collision held by the first', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: STRUCTURAL_KEY, body: structuralBody }),
      ei({ id: 'EI-2', watchdogKey: STRUCTURAL_KEY, body: structuralBody }),
      ei({ id: 'EI-3', watchdogKey: 'repeated-tool-error:memory:search:rate-limit', body: 'x.\n\nSample: rate limit reached' }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed).toEqual([]);
    expect(res.collisions).toEqual([{ id: 'EI-2', oldKey: STRUCTURAL_KEY, newKey: STRUCTURAL_KEY, heldBy: 'EI-1' }]);
    expect(res.unchanged).toBe(2);
    expect(d.writes).toEqual([]);
  });

  it('counts unchanged rows and ignores EIs without a watchdogKey', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:memory:search:rate-limit', body: 'x.\n\nSample: rate limit reached' }),
      ei({ id: 'EI-2', body: structuralBody }), // no watchdogKey → not scanned
      ei({ id: 'EI-3', watchdogKey: STRUCTURAL_KEY, body: structuralBody }), // already migrated
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.scanned).toBe(2); // EI-2 excluded (no key)
    expect(res.changed).toEqual([]);
    expect(res.unchanged).toBe(2);
  });

  it('running twice is a no-op (idempotent backfill)', async () => {
    const first = deps([ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:structural', body: callerBody })]);
    await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, first, { dryRun: false });
    // After the first pass the live store holds the new key; a second pass sees it migrated.
    const second = deps([ei({ id: 'EI-1', watchdogKey: first.writes[0]!.newKey, body: callerBody })]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, second, { dryRun: false });
    expect(res.changed).toEqual([]);
    expect(second.writes).toEqual([]);
  });
});
