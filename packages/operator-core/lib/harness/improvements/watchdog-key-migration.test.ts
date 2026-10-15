/**
 * watchdog-key-migration.test.ts — the pure key-migration backfill
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012). Proves the
 * deriver recomputes a fingerprinted key from an EI's stored body sample, that
 * the generic routine is dry-run-by-default + collision-safe + idempotent, and
 * that the parse/extract helpers are robust to colon-bearing tool names.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ImprovementCandidate } from './policy';
import { toolErrorFingerprint } from './tool-error-classifier';
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

describe('parseRepeatedToolErrorKey', () => {
  it('splits tool / class / fingerprint, tolerating colons in the tool name', () => {
    expect(parseRepeatedToolErrorKey('repeated-tool-error:plans:list:transient')).toEqual({
      tool: 'plans:list', klass: 'transient', fingerprint: null,
    });
    expect(parseRepeatedToolErrorKey('repeated-tool-error:memory:search:structural:cannot-read-properties-of-undefined')).toEqual({
      tool: 'memory:search', klass: 'structural', fingerprint: 'cannot-read-properties-of-undefined',
    });
    expect(parseRepeatedToolErrorKey('repeated-tool-error:coord:thread:caller')).toEqual({
      tool: 'coord:thread', klass: 'caller', fingerprint: null,
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
  it('appends the fingerprint to a fingerprinted class that lacks one (the P-012 migration)', () => {
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody })))
      .toBe(`repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`);
  });

  it('migrates a legacy bare STRUCTURAL key too', () => {
    expect(deriveToolErrorWatchdogKey(ei({ id: 'EI-2', watchdogKey: 'repeated-tool-error:plans:list:structural', body: structuralBody })))
      .toBe(`repeated-tool-error:plans:list:structural:${toolErrorFingerprint(extractSampleFromBody(structuralBody))}`);
  });

  it('upgrades the old first-six-token fingerprint to the full-message digest', () => {
    expect(deriveToolErrorWatchdogKey(ei({
      id: 'EI-legacy-prefix',
      watchdogKey: 'repeated-tool-error:plans:new:caller:invalid-args-note-too-big-expected',
      body: callerBody,
    }))).toBe(`repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`);
  });

  it('leaves rate-limit COARSE (never fingerprinted)', () => {
    expect(deriveToolErrorWatchdogKey(ei({
      id: 'EI-3', watchdogKey: 'repeated-tool-error:memory:search:rate-limit',
      body: 'x.\n\nSample: openai_embed_failed_429 rate limit reached',
    }))).toBeNull();
  });

  it('is idempotent — a key that already carries a fingerprint is left alone', () => {
    expect(deriveToolErrorWatchdogKey(ei({
      id: 'EI-4',
      watchdogKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`,
      body: callerBody,
    }))).toBeNull();
  });

  it('returns null for non-tool-error keys and for bodies with no derivable fingerprint', () => {
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
    const d = deps([ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody })]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d);
    expect(res.dryRun).toBe(true);
    expect(res.changed).toEqual([{ id: 'EI-1', oldKey: 'repeated-tool-error:plans:new:caller',
      newKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}` }]);
    expect(d.writes).toEqual([]);
  });

  it('execute mode persists each recomputed key', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody }),
      ei({ id: 'EI-2', watchdogKey: 'repeated-tool-error:plans:list:structural', body: structuralBody }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed).toHaveLength(2);
    expect(d.writes).toEqual([
      { id: 'EI-1', newKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}` },
      { id: 'EI-2', newKey: `repeated-tool-error:plans:list:structural:${toolErrorFingerprint(extractSampleFromBody(structuralBody))}` },
    ]);
  });

  it('skips + reports a collision when the new key already belongs to another open EI', async () => {
    const d = deps([
      // EI-1 would migrate INTO the key EI-2 already holds.
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody }),
      ei({ id: 'EI-2', watchdogKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`, body: callerBody }),
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.changed).toEqual([]);
    expect(res.collisions).toEqual([{
      id: 'EI-1',
      oldKey: 'repeated-tool-error:plans:new:caller',
      newKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`,
      heldBy: 'EI-2',
    }]);
    expect(d.writes).toEqual([]);
  });

  it('counts unchanged rows and ignores EIs without a watchdogKey', async () => {
    const d = deps([
      ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:memory:search:rate-limit', body: 'x.\n\nSample: rate limit reached' }),
      ei({ id: 'EI-2', body: structuralBody }), // no watchdogKey → not scanned
      ei({ id: 'EI-3', watchdogKey: `repeated-tool-error:plans:list:structural:${toolErrorFingerprint(extractSampleFromBody(structuralBody))}`, body: structuralBody }), // already migrated
    ]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, d, { dryRun: false });
    expect(res.scanned).toBe(2); // EI-2 excluded (no key)
    expect(res.changed).toEqual([]);
    expect(res.unchanged).toBe(2);
  });

  it('running twice is a no-op (idempotent backfill)', async () => {
    const first = deps([ei({ id: 'EI-1', watchdogKey: 'repeated-tool-error:plans:new:caller', body: callerBody })]);
    await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, first, { dryRun: false });
    // After the first pass the live store holds the new key; a second pass sees it migrated.
    const second = deps([ei({ id: 'EI-1',
      watchdogKey: `repeated-tool-error:plans:new:caller:${toolErrorFingerprint(extractSampleFromBody(callerBody))}`,
      body: callerBody })]);
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, second, { dryRun: false });
    expect(res.changed).toEqual([]);
    expect(second.writes).toEqual([]);
  });
});
