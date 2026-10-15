import { describe, it, expect } from 'vitest';
import { extractAnchors, anchorMetadata } from './anchors';

describe('non-file evidence anchors', () => {
  it('preserves colon-bearing canonical session ids', () => {
    expect(extractAnchors('session_turn:codex:host:session:42'))
      .toContainEqual({ kind: 'session-turn', value: 'codex:host:session:42' });
  });
  it('extracts all five governed source kinds, with stable deduplicated identities', () => {
    const body = 'WI-123 WI-123 EI-456 governed-memory-2026-10-14#D-007 fact:guard-rail:safe '
      + 'session_turn:codex:abc-def:42 report:rpt_12345678-1234-1234-1234-123456789abc';
    expect(anchorMetadata(body)?.anchors.filter(a => ['work-item','decision','fact','session-turn','report'].includes(a.kind)))
      .toEqual([{ kind: 'work-item', value: 'WI-123' }, { kind: 'work-item', value: 'EI-456' },
        { kind: 'decision', value: 'governed-memory-2026-10-14#D-007' },
        { kind: 'fact', value: 'guard-rail:safe' }, { kind: 'session-turn', value: 'codex:abc-def:42' },
        { kind: 'report', value: 'rpt_12345678-1234-1234-1234-123456789abc' }]);
  });
});

describe('extractAnchors — file paths', () => {
  it('extracts a single file path', () => {
    const a = extractAnchors('See apps/operator/lib/foo.ts for details.');
    expect(a).toEqual([{ kind: 'file', value: 'apps/operator/lib/foo.ts' }]);
  });

  it('extracts multiple files', () => {
    const a = extractAnchors(
      'Touch apps/operator/lib/a.ts and packages/agent-mcp/src/b.tsx.',
    );
    expect(a.map((x) => x.value)).toEqual([
      'apps/operator/lib/a.ts',
      'packages/agent-mcp/src/b.tsx',
    ]);
  });

  it('handles common extensions', () => {
    const a = extractAnchors(
      'files: a/b.ts c/d.tsx e/f.mjs g/h.sql i/j.mdx k/l.json m/n.yaml',
    );
    expect(a.map((x) => x.value).sort()).toEqual(
      [
        'a/b.ts',
        'c/d.tsx',
        'e/f.mjs',
        'g/h.sql',
        'i/j.mdx',
        'k/l.json',
        'm/n.yaml',
      ].sort(),
    );
  });

  it('does NOT extract one-segment paths', () => {
    const a = extractAnchors('See package.json for the version.');
    expect(a.filter((x) => x.kind === 'file')).toEqual([]);
  });

  it('does NOT extract paths inside other strings', () => {
    // "x.ts" alone with no path prefix is not anchored
    const a = extractAnchors('the file x.ts was edited');
    expect(a.filter((x) => x.kind === 'file')).toEqual([]);
  });
});

describe('extractAnchors — feature ids', () => {
  it('extracts simple F-NNN', () => {
    expect(extractAnchors('F-001 implements X')).toEqual([
      { kind: 'feature', value: 'F-001' },
    ]);
  });

  it('extracts subsystem-prefixed forms', () => {
    const a = extractAnchors('F-AUTH-001 and F-FIX-024 and F-AUTO-15 done.');
    expect(a.map((x) => x.value)).toEqual([
      'F-AUTH-001',
      'F-FIX-024',
      'F-AUTO-15',
    ]);
  });

  it('does NOT match lowercase or partial', () => {
    expect(extractAnchors('f-001 or F- alone').filter((x) => x.kind === 'feature')).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    const a = extractAnchors('F-001 here and F-001 there');
    expect(a).toEqual([{ kind: 'feature', value: 'F-001' }]);
  });
});

describe('extractAnchors — plan slugs', () => {
  it('extracts dated plan slug', () => {
    const a = extractAnchors('see memory-harness-scope-2026-05-24 for context');
    expect(a).toEqual([
      { kind: 'plan', value: 'memory-harness-scope-2026-05-24' },
    ]);
  });

  it('extracts multiple slugs', () => {
    const a = extractAnchors(
      'plans foo-2026-01-01 and bar-baz-2025-12-31 cover this.',
    );
    expect(a.filter((x) => x.kind === 'plan').map((x) => x.value).sort()).toEqual([
      'bar-baz-2025-12-31',
      'foo-2026-01-01',
    ]);
  });

  it('does NOT match plain kebab-case identifiers', () => {
    expect(extractAnchors('we use kebab-case-here').filter((x) => x.kind === 'plan')).toEqual([]);
  });
});

describe('extractAnchors — migrations', () => {
  it('extracts file form', () => {
    const a = extractAnchors('081-memory-canonical.sql adds vec tables');
    expect(a.some((x) => x.kind === 'migration' && x.value === '081')).toBe(
      true,
    );
  });

  it('extracts prose form', () => {
    const a = extractAnchors('migration 081 is the one');
    expect(a.some((x) => x.kind === 'migration' && x.value === '081')).toBe(
      true,
    );
  });

  it('extracts hash-prefix prose form', () => {
    const a = extractAnchors('migration #081 broke things');
    expect(a.some((x) => x.kind === 'migration' && x.value === '081')).toBe(
      true,
    );
  });

  it('dedupes file + prose mention of same number', () => {
    const a = extractAnchors('migration 081 in 081-memory.sql');
    expect(a.filter((x) => x.kind === 'migration')).toEqual([
      { kind: 'migration', value: '081' },
    ]);
  });
});

describe('extractAnchors — symbols (backticks only)', () => {
  it('extracts a backticked symbol', () => {
    expect(extractAnchors('call `getHarnessAdminUrl` first')).toEqual([
      { kind: 'symbol', value: 'getHarnessAdminUrl' },
    ]);
  });

  it('does NOT extract unbacked identifiers', () => {
    expect(extractAnchors('call getHarnessAdminUrl first').filter((x) => x.kind === 'symbol')).toEqual([]);
  });

  it('skips common stoplist words', () => {
    expect(extractAnchors('`null` or `undefined` or `true`').filter((x) => x.kind === 'symbol')).toEqual([]);
  });

  it('skips pure-digit backticks', () => {
    expect(extractAnchors('returns `200`').filter((x) => x.kind === 'symbol')).toEqual([]);
  });

  it('accepts snake_case and PascalCase', () => {
    const a = extractAnchors('use `MyClass` or `helper_fn`');
    expect(a.map((x) => x.value).sort()).toEqual(['MyClass', 'helper_fn']);
  });
});

describe('extractAnchors — combined', () => {
  it('extracts across all categories in one body', () => {
    const text =
      'Per memory-harness-scope-2026-05-24 plan, F-001 lives in apps/operator/lib/memory/injection.ts; ' +
      'see migration 081 and call `buildMemoryContextBlock`.';
    const a = extractAnchors(text);
    expect(a).toContainEqual({ kind: 'file', value: 'apps/operator/lib/memory/injection.ts' });
    expect(a).toContainEqual({ kind: 'feature', value: 'F-001' });
    expect(a).toContainEqual({ kind: 'plan', value: 'memory-harness-scope-2026-05-24' });
    expect(a).toContainEqual({ kind: 'migration', value: '081' });
    expect(a).toContainEqual({ kind: 'symbol', value: 'buildMemoryContextBlock' });
  });

  it('returns [] for empty input', () => {
    expect(extractAnchors('')).toEqual([]);
    expect(extractAnchors(null as unknown as string)).toEqual([]);
    expect(extractAnchors(undefined as unknown as string)).toEqual([]);
  });
});

describe('anchorMetadata', () => {
  it('returns null when nothing to anchor', () => {
    expect(anchorMetadata('hello world')).toBeNull();
  });

  it('wraps result with count', () => {
    const m = anchorMetadata('F-001 in apps/operator/lib/foo.ts');
    expect(m).not.toBeNull();
    expect(m!.anchor_count).toBe(2);
    expect(m!.anchors.length).toBe(2);
  });
});
