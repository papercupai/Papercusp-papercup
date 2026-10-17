/**
 * The sentinel-use detector's teeth and real-tree enforcement.
 *
 * A clean run alone cannot prove this guard catches a future raw identity use;
 * the fixture tests below pin the positive and negative directions, while the
 * final test executes the scanner against the repository.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no declaration file; keep this import on one line so
// the suppression covers TS7016 on the module specifier.
import { BASELINE, findOffenders, findRawHarnessSentinelUses, findingKey, isExcluded } from '../../../../scripts/check-no-raw-harness-sentinel.mjs';

describe('raw ctx.harnessSlug sentinel detector', () => {
  it('excludes generated native fixture debug bundles from source scanning', () => {
    expect(isExcluded('apps/operator/apps/operator/dist-host-native-fixture-debug-2001983/hono-host.mjs')).toBe(true);
    expect(isExcluded('apps/operator/lib/hono-host.ts')).toBe(false);
  });

  it('flags a nullish fallback that lets the truthy * sentinel win', () => {
    const [finding] = findRawHarnessSentinelUses(
      'const harness = args.harness ?? ctx.harnessSlug ?? undefined;',
    );
    expect(finding?.kind).toBe('fallback');
  });

  it('flags a raw identity-bearing object field', () => {
    const [finding] = findRawHarnessSentinelUses(
      'const scope = { harnessSlug: ctx.harnessSlug ?? null };',
    );
    expect(finding?.kind).toBe('fallback');
  });

  it('flags a non-sentinel predicate', () => {
    const [finding] = findRawHarnessSentinelUses(
      'if (ctx.harnessSlug === requestedHarness) return true;',
    );
    expect(finding?.kind).toBe('predicate');
  });

  it('does not flag canonical resolver calls', () => {
    expect(
      findRawHarnessSentinelUses(
        'const slug = resolveConcreteHarnessSlug(args.harness, ctx);',
      ),
    ).toEqual([]);
    expect(
      findRawHarnessSentinelUses(
        'const pot = resolvePotHomeSlug(args.harness, ctx.harnessSlug);',
      ),
    ).toEqual([]);
  });

  it('does not flag an explicit sentinel guard and its guarded branch', () => {
    expect(
      findRawHarnessSentinelUses(
        "const slug = ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null;",
      ),
    ).toEqual([]);
  });

  it('ignores prose and string literals', () => {
    expect(
      findRawHarnessSentinelUses(
        "// ctx.harnessSlug ?? '' is the trap\nconst note = 'harnessSlug: ctx.harnessSlug';",
      ),
    ).toEqual([]);
  });

  it('keeps the baseline shrink-only and proves the real tree has no new finding', () => {
    const scan = findOffenders();
    expect(scan.staleBaseline, 'a stale baseline hides a changed or removed site').toEqual([]);
    expect(scan.offenders, 'a new raw identity use must fail the build').toEqual([]);
    for (const key of BASELINE) expect(typeof key).toBe('string');
    expect(BASELINE.size).toBe(60);
  }, 120_000);

  it('uses a source fingerprint in baseline keys', () => {
    expect(
      findingKey('src/a.ts', { line: 4, kind: 'fallback', occurrence: 1, text: 'const x = 1;' }),
    ).toBe('src/a.ts:fallback#1:const x = 1;');
  });

  it('keys are LINE-INSENSITIVE so an unrelated edit above a site cannot red the gate', () => {
    // The same site, pushed down 300 lines by an edit somewhere above it.
    const before = findingKey('src/a.ts', { line: 4, kind: 'fallback', occurrence: 1, text: 'const x = 1;' });
    const after = findingKey('src/a.ts', { line: 304, kind: 'fallback', occurrence: 1, text: 'const x = 1;' });
    expect(after).toBe(before);
  });

  it('still fails closed when the site itself changes', () => {
    const original = findingKey('src/a.ts', { line: 4, kind: 'fallback', occurrence: 1, text: 'const x = 1;' });
    const rewritten = findingKey('src/a.ts', { line: 4, kind: 'fallback', occurrence: 1, text: 'const x = 2;' });
    expect(rewritten).not.toBe(original);
  });

  it('distinguishes two byte-identical sites in one file by occurrence', () => {
    // BYTE-IDENTICAL lines: the text fingerprint alone cannot tell them apart,
    // which is the only case the occurrence ordinal exists for.
    const findings = findRawHarnessSentinelUses(
      '  harnessSlug: ctx.harnessSlug ?? null,\nconst b = 1;\n  harnessSlug: ctx.harnessSlug ?? null,',
      'src/dup.ts',
    );
    expect(findings).toHaveLength(2);
    const keys = findings.map((f: { line: number; kind: string; occurrence: number; text: string }) =>
      findingKey('src/dup.ts', f),
    );
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain('#1:');
    expect(keys[1]).toContain('#2:');
  });
});
