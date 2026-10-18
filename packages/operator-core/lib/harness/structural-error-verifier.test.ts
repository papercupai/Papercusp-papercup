/**
 * Unit tests for structural-error-verifier (EI-1747) — the pure decision core + the
 * injected-deps orchestration. No PG, no clock: the I/O seam is faked.
 */
import { describe, it, expect } from 'vitest';
import {
  decideStructuralAutoResolve,
  runStructuralErrorVerifierOnce,
  STRUCTURAL_WATCHDOG_KEY_PATTERN,
  type OpenStructuralItem,
  type StructuralVerifierDeps,
} from './structural-error-verifier';
import {
  REPEATED_TOOL_ERROR_PREFIX,
  parseRepeatedToolErrorKey,
} from './improvements/watchdog-key-migration';
import {
  toolErrorKeyParts,
  toolErrorSignalKey,
  type ToolErrorClass,
} from './improvements/tool-error-classifier';

const HOUR = 60 * 60 * 1000;
const WINDOW = 6 * HOUR;

describe('decideStructuralAutoResolve (pure)', () => {
  it('resolves only when zero recurrences AND the item is older than the window AND the tool was actually invoked', () => {
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 0,
        itemAgeMs: 7 * HOUR,
        windowMs: WINDOW,
        recentTotalInvocations: 3,
      }),
    ).toBe(true);
  });

  it('keeps open when the error has recurred within the window (even if old)', () => {
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 1,
        itemAgeMs: 99 * HOUR,
        windowMs: WINDOW,
        recentTotalInvocations: 5,
      }),
    ).toBe(false);
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 12,
        itemAgeMs: 7 * HOUR,
        windowMs: WINDOW,
        recentTotalInvocations: 40,
      }),
    ).toBe(false);
  });

  it('keeps open a YOUNG item even with zero recurrences (not enough quiet time yet)', () => {
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 0,
        itemAgeMs: 1 * HOUR,
        windowMs: WINDOW,
        recentTotalInvocations: 3,
      }),
    ).toBe(false);
    // exactly at the boundary: age == window counts as old-enough.
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 0,
        itemAgeMs: WINDOW,
        windowMs: WINDOW,
        recentTotalInvocations: 3,
      }),
    ).toBe(true);
  });

  /**
   * EI-21905244571119790 — the positive-control regression. Before this fix, a tool
   * whose failures manifest as a well-formed `{ok:false}` return value (never a thrown
   * exception, never isError:true — e.g. testing:run-status's `unknown_run`) recorded
   * ZERO error/timeout/refused rows in `tool_invocations` NO MATTER HOW OFTEN it was
   * actually failing, so `recentRecurrences` always read 0 and the item auto-resolved
   * on schedule regardless of whether the bug was fixed. Requiring evidence the tool
   * was invoked AT ALL during the window does not fully solve that (the tool WAS being
   * called), but it DOES close the adjacent false-close this same code path enabled: an
   * item for a tool nobody called at all in the window is indistinguishable, under the
   * old logic, from one whose bug is genuinely fixed. Both must stay open.
   */
  it('CONTROL: does NOT resolve when the tool was never invoked in the window, even with zero recurrences and an old item', () => {
    expect(
      decideStructuralAutoResolve({
        recentRecurrences: 0,
        itemAgeMs: 99 * HOUR,
        windowMs: WINDOW,
        recentTotalInvocations: 0,
      }),
    ).toBe(false);
  });
});

/** A scripted fake of the I/O seam: `errorsByTool` drives the recurrence count,
 *  `invocationsByTool` drives the positive-control count (defaults to a healthy nonzero
 *  value so existing tests that never mention it keep exercising the SAME behavior they
 *  did before the positive-control fix); resolves are recorded so a test can assert
 *  exactly which items were closed. */
function makeFakeDeps(
  items: OpenStructuralItem[],
  errorsByTool: Record<string, number>,
  opts: {
    throwCountFor?: string;
    errorsByWatchdogKey?: Record<string, number>;
    invocationsByTool?: Record<string, number>;
    defaultInvocations?: number;
  } = {},
): StructuralVerifierDeps & { resolved: string[] } {
  const resolved: string[] = [];
  const defaultInvocations = opts.defaultInvocations ?? 1;
  return {
    resolved,
    async selectOpenStructuralItems() {
      return items;
    },
    async countRecentToolErrors(tool, watchdogKey) {
      if (opts.throwCountFor && tool === opts.throwCountFor) throw new Error('telemetry read failed');
      return opts.errorsByWatchdogKey?.[watchdogKey] ?? errorsByTool[tool] ?? 0;
    },
    async countRecentToolInvocations(tool) {
      return opts.invocationsByTool?.[tool] ?? defaultInvocations;
    },
    async resolveItem(_ws, issueId) {
      resolved.push(issueId);
    },
  };
}

const item = (
  issueId: string,
  tool: string,
  ageMs: number,
  message: string | null = null,
): OpenStructuralItem => {
  const parts = toolErrorKeyParts('handler_error', message);
  return {
    workspaceId: 'ws',
    issueId,
    tool,
    watchdogKey: `${REPEATED_TOOL_ERROR_PREFIX}${toolErrorSignalKey(tool, 'structural', parts.errorCode, parts.fieldPath)}`,
    ageMs,
  };
};

describe('runStructuralErrorVerifierOnce (orchestration)', () => {
  it('resolves the quiet+old items and keeps the still-erroring / young ones', async () => {
    const items = [
      item('EI-1', 'plans:lint', 9 * HOUR), // old, quiet → resolve
      item('EI-2', 'fleet:place_batch', 9 * HOUR), // old, still erroring → keep
      item('EI-3', 'memory:update', 2 * HOUR), // young, quiet → keep
    ];
    const deps = makeFakeDeps(items, { 'fleet:place_batch': 4 });
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 3, resolved: 1, kept: 2, errored: 0 });
    expect(deps.resolved).toEqual(['EI-1']);
  });

  it('respects maxPerTick (only the first N items are processed)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`EI-${i}`, `tool:${i}`, 9 * HOUR));
    const deps = makeFakeDeps(items, {}); // all quiet+old
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW, maxPerTick: 2 });

    expect(r.checked).toBe(2);
    expect(r.resolved).toBe(2);
    expect(deps.resolved).toEqual(['EI-0', 'EI-1']);
  });

  it('swallows a per-item failure — one bad row never aborts the pass', async () => {
    const items = [
      item('EI-1', 'good:tool', 9 * HOUR), // quiet+old → resolve
      item('EI-2', 'bad:tool', 9 * HOUR), // count throws → counted as errored, not resolved
      item('EI-3', 'good:tool2', 9 * HOUR), // still processed after the throw → resolve
    ];
    const deps = makeFakeDeps(items, {}, { throwCountFor: 'bad:tool' });
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 3, resolved: 2, kept: 0, errored: 1 });
    expect(deps.resolved).toEqual(['EI-1', 'EI-3']);
  });

  it('resolves nothing when the selector is empty', async () => {
    const deps = makeFakeDeps([], {});
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });
    expect(r).toEqual({ checked: 0, resolved: 0, kept: 0, errored: 0 });
  });

  /**
   * EI-21905244571119790 — orchestration-level regression for the positive-control fix.
   * `dormant:tool` is old and has zero recurrences (exactly the shape that used to
   * auto-resolve), but was NEVER INVOKED at all in the window — so the silence proves
   * nothing and the item MUST stay open. `busy:tool` is the control: same age, same zero
   * recurrences, but WAS invoked — it resolves exactly as before this fix.
   */
  it('keeps a QUIET+OLD item open when the tool was never invoked in the window (positive-control gate)', async () => {
    const items = [
      item('EI-dormant', 'dormant:tool', 9 * HOUR), // old, quiet, but NEVER CALLED → keep
      item('EI-busy', 'busy:tool', 9 * HOUR), // old, quiet, actually exercised → resolve
    ];
    const deps = makeFakeDeps(items, {}, { invocationsByTool: { 'dormant:tool': 0, 'busy:tool': 12 } });
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 2, resolved: 1, kept: 1, errored: 0 });
    expect(deps.resolved).toEqual(['EI-busy']);
  });

  /**
   * The load-bearing half-repair case from EI-22437036851108668: two distinct
   * structural contracts share one tool, but only one has been fixed. Under the
   * structural key (bug-inflow-one-problem-one-row-2026-10-18 D-004) the missing
   * column is the field segment, so the two filings keep distinct keys.
   * Recurrence lookup MUST use the complete watchdogKey; a tool-wide count would
   * either keep the repaired filing open forever or close the still-failing sibling.
   */
  it('keeps a still-failing same-tool contract open while resolving its repaired sibling', async () => {
    const tool = 'shared:tool';
    const repaired = item('EI-repaired', tool, 9 * HOUR, 'column "ownerId" does not exist');
    const stillFailing = item('EI-still-failing', tool, 9 * HOUR, 'column "limit" does not exist');
    expect(repaired.watchdogKey).toBe('repeated-tool-error:shared:tool:structural:handler_error:ownerid');
    expect(stillFailing.watchdogKey).not.toBe(repaired.watchdogKey);
    const deps = makeFakeDeps(
      [repaired, stillFailing],
      {},
      {
        errorsByWatchdogKey: { [stillFailing.watchdogKey]: 1 },
        invocationsByTool: { [tool]: 12 },
      },
    );

    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 2, resolved: 1, kept: 1, errored: 0 });
    expect(deps.resolved).toEqual(['EI-repaired']);
  });
});

/**
 * EI-19453017656411107 — recurrence guard on the SQL PRE-FILTER, the leg the
 * injected-deps tests above cannot reach (they start from an already-selected item
 * list, so a selector that silently returns nothing still passes every one of them).
 *
 * The defect: `LIKE 'repeated-tool-error:%:structural'` anchors the class token to the
 * END of the key, so it admitted ONLY keys with no fingerprint. `structural` is a
 * FINGERPRINTED class, so the fingerprinted form is the common one — measured on live
 * rows, 90 of 133 (67.7%) carried a fingerprint and were invisible to the daemon.
 *
 * Keys are minted through the REAL `toolErrorSignalKey` rather than written by hand, so
 * this guard cannot drift away from the minting logic it is protecting: if minting ever
 * changes shape, these fail instead of quietly agreeing with a stale literal.
 */
describe('STRUCTURAL_WATCHDOG_KEY_PATTERN (the exact pre-filter handed to Postgres)', () => {
  const re = new RegExp(STRUCTURAL_WATCHDOG_KEY_PATTERN);
  const mint = (tool: string, klass: ToolErrorClass, code: string | null, field: string | null) =>
    `${REPEATED_TOOL_ERROR_PREFIX}${toolErrorSignalKey(tool, klass, code, field)}`;
  // Shapes still carried by OPEN rows minted before the structural key (D-004)
  // until the key migration re-keys them; the pre-filter must keep admitting them.
  const LEGACY_FINGERPRINTED = 'repeated-tool-error:dev:cache_stats:structural:md5-0123456789abcdef0123456789abcdef';
  const LEGACY_BARE = 'repeated-tool-error:activity:recent:structural';

  it('admits the CURRENT structural key — code + field segments after the class token', () => {
    const key = mint('dev:cache_stats', 'structural', 'unsupported_unicode_escape', null);
    expect(key).toBe('repeated-tool-error:dev:cache_stats:structural:unsupported_unicode_escape:field-unknown');
    expect(re.test(key)).toBe(true);
    // Precisely why the old filter missed this shape: the key does NOT end at the class token.
    expect(key.endsWith(':structural')).toBe(false);
  });

  it('still admits LEGACY fingerprinted and bare structural keys', () => {
    expect(re.test(LEGACY_FINGERPRINTED)).toBe(true);
    expect(re.test(LEGACY_BARE)).toBe(true);
  });

  it('rejects every OTHER tool-error class, with or without segments', () => {
    for (const klass of ['transient', 'caller', 'rate-limit'] as const) {
      expect(re.test(mint('activity:report', klass, 'some_code', 'some.field'))).toBe(false);
      expect(re.test(mint('activity:report', klass, null, null))).toBe(false);
    }
  });

  it('rejects watchdog keys that are not tool-error signals at all', () => {
    expect(re.test('bug-drain-200k:claim-race-loss')).toBe(false);
    expect(re.test('repeated-tool-error-lookalike:x:structural')).toBe(false);
  });

  /**
   * FALSIFIABILITY CONTROL (tier 1 — a deliberately-wrong implementation kept
   * permanently beside the real one). Without this, every assertion above would still
   * pass against a pattern that had silently reverted to the buggy form, because they
   * only ever assert what the CORRECT pattern does. This one pins the discrimination
   * itself: the old filter and the new one must disagree on exactly the shape that was
   * being dropped. No tree mutation needed — the subject is an imported module.
   */
  it('CONTROL: the old suffix-anchored filter provably misses the common form', () => {
    // Regex equivalent of the removed `LIKE 'repeated-tool-error:%:structural'`.
    const OLD_SUFFIX_ANCHORED = /^repeated-tool-error:.*:structural$/;
    const current = mint('dev:cache_stats', 'structural', 'unsupported_unicode_escape', null);

    // The defect: the old filter drops every segmented (common) form entirely...
    expect(OLD_SUFFIX_ANCHORED.test(current)).toBe(false);
    expect(OLD_SUFFIX_ANCHORED.test(LEGACY_FINGERPRINTED)).toBe(false);
    // ...while still admitting the bare form, which is why it looked healthy.
    expect(OLD_SUFFIX_ANCHORED.test(LEGACY_BARE)).toBe(true);

    // The fix admits all three — so the two patterns genuinely disagree, and this
    // suite fails if the pattern is ever reverted.
    expect(re.test(current)).toBe(true);
    expect(re.test(LEGACY_FINGERPRINTED)).toBe(true);
    expect(re.test(LEGACY_BARE)).toBe(true);
  });

  it('agrees with the parser (the stated authority) on everything it admits', () => {
    const cases = [
      { key: mint('dev:cache_stats', 'structural', 'unsupported_unicode_escape', null), tool: 'dev:cache_stats', code: 'unsupported_unicode_escape', field: 'field-unknown' },
      { key: mint('a:b:c:deeply:nested', 'structural', 'handler_error', 'items.n.id'), tool: 'a:b:c:deeply:nested', code: 'handler_error', field: 'items.n.id' },
      { key: LEGACY_FINGERPRINTED, tool: 'dev:cache_stats', code: null, field: null },
      { key: LEGACY_BARE, tool: 'activity:recent', code: null, field: null },
    ];
    for (const c of cases) {
      expect(re.test(c.key)).toBe(true);
      const parsed = parseRepeatedToolErrorKey(c.key);
      expect(parsed?.klass).toBe('structural');
      expect(parsed?.tool).toBe(c.tool);
      expect(parsed?.errorCode).toBe(c.code);
      expect(parsed?.fieldPath).toBe(c.field);
    }
  });
});
