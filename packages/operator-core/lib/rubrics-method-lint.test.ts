import { describe, expect, it, vi } from 'vitest';
import { lintAcceptanceCriterionMethods, lintAcceptanceMethods } from './rubrics-method-lint';

describe('lintAcceptanceCriterionMethods', () => {
  it('finds the narrow shell-shaped method markers', () => {
    const findings = lintAcceptanceCriterionMethods([
      { key: 'npm', method: 'Run npm run measure:launch-cost -- --since 2026-09-08.' },
      { key: 'proc', method: 'Read /proc/<pid>/environ for the running proxy.' },
      { key: 'pgrep', method: 'Use pgrep -f the proxy pattern.' },
      { key: 'inline', method: 'Inspect `cat /tmp/measurement.json` and compare the output.' },
    ]);

    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.markers)).toEqual([
      ['npm-run'],
      ['proc-path'],
      ['pgrep'],
      ['backticked-shell'],
    ]);
    expect(findings[0]?.message).toMatch(/cannot run native shell commands/i);
  });

  it('does not flag MCP procedures or ordinary cited-file prose', () => {
    expect(
      lintAcceptanceCriterionMethods([
        { key: 'mcp', method: 'Run `testing:run { files: ["packages/foo.test.ts"] }` and inspect the result.' },
        { key: 'mcp-ledger', method: 'Read `testing:runs` and cite the matching test-run ledger row.' },
        { key: 'source', method: 'Inspect `packages/operator-core/lib/rubrics.ts` at the cited symbol.' },
        { key: 'empty', method: null },
      ]),
    ).toEqual([]);
  });

  it('returns no standard-rubric policy by construction when given no acceptance criteria', () => {
    expect(lintAcceptanceCriterionMethods([])).toEqual([]);
  });
});

describe('acceptance implementation dependency coverage', () => {
  const oldId = 'WI-6554700010014915';
  const newId = 'WI-6554700010023061';
  const criterion = (id = oldId) => ({
    key: 'r-6', barKey: 'R-6',
    method: `Missing objective detector branches remain qualification gaps/unknown. Their implementation dependency is ${id}, assigned to the enterprise-readiness leader; this is not a planning-amendment hard block.`,
  });
  const terminal = (checked = ['R1 enterprise scope/reuse evidence detector', 'R9 selected deployment/recovery detector', 'R10 procurement/support evidence detector', 'R11 attributable internal-trial detector', 'R12 promoted/served release-boundary detector']) => ({
    id: oldId, state: 'done', terminalCompletionEvidence: { coverage: { population: checked, checked, residue: [] } },
  });

  it('flags the original R6 reference despite committed completion of the other five detector branches', async () => {
    const read = vi.fn().mockResolvedValue([terminal()]);
    const findings = await lintAcceptanceMethods([criterion()], 'papercusp', read);
    expect(read).toHaveBeenCalledWith([oldId], 'papercusp');
    expect(findings).toEqual([expect.objectContaining({
      code: 'acceptance-method-dependency-coverage', criterionKey: 'r-6', dependencyId: oldId,
    })]);
    expect(findings[0]!.message).toContain('checked completion coverage does not name R-6');
  });

  it('allows the corrected owned unfinished dependency without claiming detector coverage', async () => {
    const read = vi.fn().mockResolvedValue([{ id: newId, state: 'open', terminalCompletionEvidence: null }]);
    expect(await lintAcceptanceMethods([criterion(newId)], 'papercusp', read)).toEqual([]);
  });

  it('accepts explicit matching checked coverage and keeps R60 distinct from R6', async () => {
    expect(await lintAcceptanceMethods([criterion()], undefined, async () => [terminal(['R6 finance detector'])])).toEqual([]);
    expect(await lintAcceptanceMethods([criterion()], undefined, async () => [terminal(['R-6 finance detector'])])).toEqual([]);
    expect(await lintAcceptanceMethods([criterion()], undefined, async () => [terminal(['R60 other detector'])]))
      .toEqual([expect.objectContaining({ code: 'acceptance-method-dependency-coverage' })]);
  });

  it('does not count population membership, unchecked branches, or a missing completion as checked proof', async () => {
    const item = terminal([]);
    item.terminalCompletionEvidence.coverage.population = ['R6 finance detector'];
    expect(await lintAcceptanceMethods([criterion()], undefined, async () => [item]))
      .toEqual([expect.objectContaining({ code: 'acceptance-method-dependency-coverage' })]);
    expect(await lintAcceptanceMethods([criterion()], undefined, async () => [{ id: oldId, state: 'dropped', terminalCompletionEvidence: null }]))
      .toEqual([expect.objectContaining({ code: 'acceptance-method-dependency-coverage' })]);
  });

  it('leaves historical evidence references alone and avoids a database read without explicit dependencies', async () => {
    const read = vi.fn();
    expect(await lintAcceptanceMethods([{ key: 'r-6', method: `Read completed evidence from ${oldId}.` }], undefined, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('deduplicates reads while checking every explicitly listed implementation dependency', async () => {
    const read = vi.fn().mockResolvedValue([terminal(), { id: newId, state: 'wip', terminalCompletionEvidence: null }]);
    const method = `Implementation dependencies are ${oldId} and ${newId}. Implementation dependency: ${oldId}.`;
    const findings = await lintAcceptanceMethods([{ ...criterion(), method }], 'papercusp', read);
    expect(read).toHaveBeenCalledWith([oldId, newId], 'papercusp');
    expect(findings).toHaveLength(1);
  });

  it('reports failed or unresolved reads as unverified rather than missing/complete work', async () => {
    for (const read of [async () => [], async () => { throw new Error('read timed out'); }]) {
      expect(await lintAcceptanceMethods([criterion()], 'papercusp', read))
        .toEqual([expect.objectContaining({ code: 'acceptance-method-dependency-unverified', dependencyId: oldId })]);
    }
  });
});

