/**
 * code-intel-epoch-carry-2026-10-20 P-005 (R-10) — facts:assert refuses a
 * `code-note:` fact that declares no `file:` anchor. The store enforces the same
 * rule on the RESOLVED anchor (store.integration.test.ts › code notes); this pins
 * the tool's preflight so safeParse / dryRun report the refusal too.
 */
import { describe, expect, it } from 'vitest';
import assertTool from './assert';

const base = { scope: 'harness', scopeRef: 'papercusp', body: 'the retry loop is deliberate', ttlSec: 3600 };

const issues = (args: Record<string, unknown>) => {
  const parsed = assertTool.args.safeParse(args);
  return parsed.success ? [] : parsed.error.issues;
};

describe('R-10: a code note must declare a file anchor', () => {
  it('refuses a code note with no dependsOn, naming the dependsOn field', () => {
    const found = issues({ ...base, key: 'code-note:retry-loop' });
    expect(found.some(i => i.path.join('.') === 'dependsOn' && /file anchor/.test(i.message))).toBe(true);
  });

  it('refuses a code note whose only dependencies are cells, not files', () => {
    const found = issues({ ...base, key: 'code-note:retry-loop', dependsOn: ['git.pipelinePosition'] });
    expect(found.some(i => i.path.join('.') === 'dependsOn')).toBe(true);
  });

  it('accepts a code note anchored with a file: entry (string or object form)', () => {
    expect(issues({ ...base, key: 'code-note:retry-loop', dependsOn: ['file:lib/retry.ts'] })).toEqual([]);
    expect(issues({ ...base, key: 'code-note:retry-loop', dependsOn: [{ cell: 'file:lib/retry.ts' }] })).toEqual([]);
  });

  it('leaves ordinary facts alone', () => {
    expect(issues({ ...base, key: 'retry-loop-conclusion' })).toEqual([]);
  });

  it('the guidance names the code-note convention', () => {
    expect(assertTool.guidance?.chaining).toContain('code-note:');
  });
});
