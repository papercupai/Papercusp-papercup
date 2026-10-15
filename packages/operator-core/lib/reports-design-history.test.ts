/** P-007: a reproducible historical audit, distinct from an original tool receipt. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { UiIr } from './design-ir/schema';

interface DesignCall {
  id: string;
  tool: string;
  at: string;
  status: string;
  input: 'initial' | 'final';
}
interface History {
  schemaVersion: number;
  proofScope: string;
  calls: DesignCall[];
  inputs: Record<'initial' | 'final', UiIr>;
  originalInitialResult: { partIdx: number; text: string };
  originalFinalResult: { partIdx: number; truncated: boolean; sha256: string };
  firstRecordedUiEdit: { partIdx: number; at: string; path: string };
  firstCommittedSpec: { commit: string; ir: UiIr; semanticSha256: string };
  historicalValidator: { commit: string; source: string; sha256: string };
}
interface HistoricalValidator {
  validateIr(ir: unknown): { ok: boolean; errors: unknown[] };
  lintIr(ir: unknown): Array<{ severity: string }>;
}

const history = JSON.parse(readFileSync(
  new URL('./__fixtures__/reports-design-history.json', import.meta.url), 'utf8',
)) as History;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function finalChecksPredateUi(calls: DesignCall[], firstUiAt: string): boolean {
  const firstUi = Date.parse(firstUiAt);
  return Number.isFinite(firstUi) && ['design-phase.validate_spec', 'design-phase.lint_spec'].every(tool => {
    const matches = calls.filter(call => call.input === 'final' && call.tool === tool);
    return matches.length === 1 && matches[0].status === 'ok'
      && Number.isFinite(Date.parse(matches[0].at)) && Date.parse(matches[0].at) < firstUi;
  });
}

function historicalValidator(): HistoricalValidator {
  const { source, sha256 } = history.historicalValidator;
  expect(createHash('sha256').update(source).digest('hex')).toBe(sha256);
  expect(sha256).toBe('b1a65945407c9c6fc21334b37388637e41238840346f14cdaa9a8744d313ef19');
  // The historical plugin keeps the schema and both pure checks before its
  // frontmatter/storage code. Execute those exact bytes; no PG, host bridge,
  // current validator or registry can replace the historical implementation.
  const boundary = source.indexOf('function parseFrontmatter(');
  expect(boundary).toBeGreaterThan(0);
  const module = { exports: {} as HistoricalValidator };
  runInNewContext(source.slice(0, boundary) + '\nmodule.exports = { validateIr, lintIr };', {
    require: createRequire(import.meta.url), module,
  }, { timeout: 5_000 });
  return module.exports;
}

describe('Reports historical design audit (P-007)', () => {
  it('ties the original final checks to the committed spec before the first recorded UI patch', () => {
    expect(history.schemaVersion).toBe(1);
    expect(history.calls.map(call => call.id)).toEqual(['33333551', '33333557', '33334219', '33334237']);
    expect(history.firstRecordedUiEdit).toMatchObject({
      partIdx: 94, path: 'apps/operator-vite/src/components/reports/ReportsRoute.tsx',
    });
    expect(finalChecksPredateUi(history.calls, history.firstRecordedUiEdit.at)).toBe(true);
    expect(history.inputs.final).toEqual(history.firstCommittedSpec.ir);
    expect(createHash('sha256').update(JSON.stringify(stable(history.inputs.final))).digest('hex'))
      .toBe(history.firstCommittedSpec.semanticSha256);
    expect(history.firstCommittedSpec.commit).toBe('91b5c4caa8f39efcad79e034a69c89f3e1fde6bc');
    // The original final output is still missing. Reconstruction cannot turn
    // a successful invocation status into a recovered clean original receipt.
    expect(history.originalFinalResult).toMatchObject({ partIdx: 86, truncated: true });
    expect(history.proofScope).toContain('retrospective reconstruction');
  });

  it('reconstructs clean final checks and calibrates against the original seven initial warnings', () => {
    const validator = historicalValidator();
    expect(history.historicalValidator.commit).toBe('f466e82e85bc689205d412f52b8a69175704dc8a');
    expect(history.originalInitialResult.partIdx).toBe(84);
    expect(history.originalInitialResult.text).toContain('issues[7]');
    expect(validator.validateIr(history.inputs.initial)).toEqual({ ok: true, errors: [] });
    const initialIssues = validator.lintIr(history.inputs.initial);
    expect(initialIssues).toHaveLength(7);
    expect(initialIssues.every(issue => issue.severity === 'warning')).toBe(true);
    expect(validator.validateIr(history.inputs.final)).toEqual({ ok: true, errors: [] });
    expect(validator.lintIr(history.inputs.final)).toEqual([]);
  });

  it('rejects late, failed or missing final checks rather than treating status as temporal proof', () => {
    const late = structuredClone(history.calls);
    late.find(call => call.id === '33334219')!.at = history.firstRecordedUiEdit.at;
    expect(finalChecksPredateUi(late, history.firstRecordedUiEdit.at)).toBe(false);
    const failed = structuredClone(history.calls);
    failed.find(call => call.id === '33334237')!.status = 'error';
    expect(finalChecksPredateUi(failed, history.firstRecordedUiEdit.at)).toBe(false);
    expect(finalChecksPredateUi(history.calls.filter(call => call.id !== '33334237'), history.firstRecordedUiEdit.at))
      .toBe(false);
  });

  it('rejects an invalid historical input rather than accepting a reconstructed placeholder verdict', () => {
    const invalid = structuredClone(history.inputs.final);
    (invalid.layout as { kind: string }).kind = 'not-a-layout';
    const result = historicalValidator().validateIr(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
