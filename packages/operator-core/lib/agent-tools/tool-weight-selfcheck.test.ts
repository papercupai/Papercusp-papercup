/**
 * tool-weight-selfcheck.test — EI-10966. Two things must hold:
 *  1. the shared budget math (weight, two-tier violations, self-serve delta) is
 *     correct — this is what the live operator warns on AND the gate reds on, so
 *     they can never disagree;
 *  2. the live self-check is SILENT under vitest — a warn here would let
 *     vitest-fail-on-console red every unrelated suite that imports the catalog,
 *     re-creating the fleet-wide blast radius the fix exists to shrink.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  BUDGET,
  HARD_CAP,
  ALLOW_OVER_BUDGET,
  promptWeight,
  serializedInputSchemaBytes,
  selectedInputSchemaBudget,
  assertSelectedInputSchemaBudget,
  MAX_SELECTED_INPUT_SCHEMA_BYTES,
  budgetViolations,
  formatViolations,
  type NamedToolWeight,
  type BudgetViolation,
} from './tool-guidance-budget';
import { runToolWeightSelfCheck, reportViolations, defaultEscalateHardCap } from './tool-weight-selfcheck';

const findIssuesByWatchdogKeysMock = vi.hoisted(() => vi.fn());
const captureImprovementMock = vi.hoisted(() => vi.fn());

vi.mock('../issues-engineer', () => ({
  findIssuesByWatchdogKeys: findIssuesByWatchdogKeysMock,
}));
vi.mock('../harness/improvements/capture-core', () => ({
  captureImprovement: captureImprovementMock,
}));

describe('promptWeight (EI-10966 — matches the assembled-prompt string weight)', () => {
  it('sums description + every guidance field, including per-role', () => {
    const w = promptWeight({
      description: 'x'.repeat(100),
      guidance: {
        when: 'y'.repeat(10),
        notWhen: 'z'.repeat(5),
        chaining: 'c'.repeat(7),
        byRole: {
          worker: { when: 'w'.repeat(3), chaining: 'h'.repeat(2) },
          queen: { notWhen: 'n'.repeat(4) },
        },
      },
    });
    expect(w).toBe(100 + 10 + 5 + 7 + 3 + 2 + 4);
  });

  it('is 0 for an empty tool and ignores unknown fields', () => {
    expect(promptWeight({})).toBe(0);
    expect(promptWeight({ description: 'abc' })).toBe(3);
  });
});

describe('selected inputSchema budget (runtime MCP loads)', () => {
  it('counts JSON schema bytes as UTF-8, including non-ASCII descriptions', () => {
    const schema = { type: 'object', description: 'café 🚀' };
    const expected = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
    expect(serializedInputSchemaBytes(schema)).toBe(expected);
    expect(serializedInputSchemaBytes(undefined)).toBe(0);
  });

  it('sums only the selected schemas and treats the exact boundary as fitting', () => {
    const tools = [
      { name: 'first', inputSchema: { type: 'object', description: 'α'.repeat(10) } },
      { name: 'second', inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    ];
    const total = tools.reduce((sum, tool) => sum + serializedInputSchemaBytes(tool.inputSchema), 0);
    expect(selectedInputSchemaBudget(tools, total)).toMatchObject({
      totalBytes: total,
      remainingBytes: 0,
      overBudget: false,
    });
    expect(selectedInputSchemaBudget(tools, total - 1)).toMatchObject({
      totalBytes: total,
      remainingBytes: -1,
      overBudget: true,
    });
  });

  it('fails with aggregate and largest-schema diagnostics when selected load is too large', () => {
    const tools = [{ name: 'large', inputSchema: { description: 'x'.repeat(MAX_SELECTED_INPUT_SCHEMA_BYTES) } }];
    expect(() => assertSelectedInputSchemaBudget(tools)).toThrow(
      new RegExp(`aggregate budget.*largest schemas: large=`),
    );
  });
});

describe('budgetViolations (the two-tier gate, mirrored)', () => {
  const weights: NamedToolWeight[] = [
    { name: 'fits', weight: BUDGET }, // exactly at budget → OK (strictly-greater breaches)
    { name: 'over-budget', weight: BUDGET + 44 }, // 1544
    { name: 'over-cap', weight: HARD_CAP + 106 }, // 1706
    { name: 'tiny', weight: 200 },
  ];

  it('flags a non-grandfathered over-budget tool with the exact cut-to-budget', () => {
    const v = budgetViolations(weights).find((x) => x.name === 'over-budget')!;
    expect(v).toMatchObject({ hardCap: false, grandfathered: false, cutAtLeast: 44 });
  });

  // EI-20186539588704262: the cut is measured to the tool's BINDING ceiling, which
  // for a non-grandfathered tool is BUDGET — not HARD_CAP. Measuring to HARD_CAP
  // under-reported the trim by exactly (HARD_CAP - BUDGET) chars, so an agent that
  // followed the number literally landed at 1600 and was STILL over budget, i.e.
  // still red. The two cases below pin both ceilings so neither can regress.
  it('flags an over-hard-cap tool with the cut measured to its BINDING ceiling (BUDGET)', () => {
    const v = budgetViolations(weights).find((x) => x.name === 'over-cap')!;
    expect(v).toMatchObject({
      hardCap: true,
      grandfathered: false,
      cutAtLeast: HARD_CAP + 106 - BUDGET,
    });
  });

  it('measures a GRANDFATHERED tool to the HARD CAP — the only ceiling it must clear', () => {
    ALLOW_OVER_BUDGET.add('over-cap');
    try {
      const v = budgetViolations(weights).find((x) => x.name === 'over-cap')!;
      expect(v).toMatchObject({ hardCap: true, grandfathered: true, cutAtLeast: 106 });
    } finally {
      ALLOW_OVER_BUDGET.delete('over-cap');
    }
  });

  it('a tool exactly at budget and a tiny tool are not violations', () => {
    const names = budgetViolations(weights).map((v) => v.name);
    expect(names).not.toContain('fits');
    expect(names).not.toContain('tiny');
  });

  it('sorts heaviest-first', () => {
    expect(budgetViolations(weights).map((v) => v.name)).toEqual(['over-cap', 'over-budget']);
  });
});

describe('formatViolations (self-serve — names the delta to trim, EI-10966 #2)', () => {
  it('prints the tool, its weight, and the chars to cut', () => {
    const msg = formatViolations(budgetViolations([{ name: 'loop:checkpoint', weight: 1706 }]));
    expect(msg).toContain('loop:checkpoint');
    expect(msg).toContain('1706');
    expect(msg).toContain(`cut ≥${1706 - BUDGET}`);
    expect(msg).toContain(`${BUDGET}-char budget`);
  });

  it('names the HARD CAP as the limit for a grandfathered tool', () => {
    ALLOW_OVER_BUDGET.add('loop:checkpoint');
    try {
      const msg = formatViolations(budgetViolations([{ name: 'loop:checkpoint', weight: 1706 }]));
      expect(msg).toContain(`cut ≥${1706 - HARD_CAP}`);
      expect(msg).toContain(`${HARD_CAP}-char HARD CAP`);
    } finally {
      ALLOW_OVER_BUDGET.delete('loop:checkpoint');
    }
  });

  it('is empty for no violations', () => {
    expect(formatViolations([])).toBe('');
  });
});

describe('runToolWeightSelfCheck — SILENT under vitest (the anti-blast-radius guarantee)', () => {
  it('never calls console.warn while process.env.VITEST is set', () => {
    // vitest sets process.env.VITEST in the worker; assert the gate we rely on.
    expect(process.env.VITEST).toBeTruthy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runToolWeightSelfCheck();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('reportViolations (EI-18685386548651513 — tiered: budget=log-only, hard-cap=also escalated)', () => {
  const budgetOnly: BudgetViolation = { name: 'budget-only-tool', weight: BUDGET + 44, hardCap: false, grandfathered: false, cutAtLeast: 44 };
  const overCap: BudgetViolation = {
    name: 'over-cap-tool',
    weight: HARD_CAP + 106,
    hardCap: true,
    grandfathered: false,
    cutAtLeast: HARD_CAP + 106 - BUDGET,
  };

  it('no violations: neither warns nor escalates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const escalate = vi.fn().mockResolvedValue(undefined);
    try {
      reportViolations([], escalate);
      expect(warn).not.toHaveBeenCalled();
      expect(escalate).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a BUDGET-only breach warns but does NOT escalate — log-only, matches pre-existing behavior', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const escalate = vi.fn().mockResolvedValue(undefined);
    try {
      reportViolations([budgetOnly], escalate);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('budget-only-tool');
      expect(escalate).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a HARD-CAP breach BOTH warns and escalates into the work queue', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const escalate = vi.fn().mockResolvedValue(undefined);
    try {
      reportViolations([overCap], escalate);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(escalate).toHaveBeenCalledWith(overCap);
    } finally {
      warn.mockRestore();
    }
  });

  it('a mixed batch escalates ONLY the hard-cap violator, not the budget-only one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const escalate = vi.fn().mockResolvedValue(undefined);
    try {
      reportViolations([budgetOnly, overCap], escalate);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(escalate).toHaveBeenCalledWith(overCap);
    } finally {
      warn.mockRestore();
    }
  });

  it('a rejecting escalate is caught (fail-soft) — never throws out of reportViolations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const escalate = vi.fn().mockRejectedValue(new Error('capture failed'));
    try {
      expect(() => reportViolations([overCap], escalate)).not.toThrow();
      // let the fire-and-forget rejection's .catch handler run
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalledTimes(2); // the summary warn + the escalation-failure warn
      expect(warn.mock.calls[1][0]).toContain('escalation capture failed');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('defaultEscalateHardCap (EI-18689219855601091 — authoritative watchdogKey pre-filter)', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    process.argv = originalArgv.slice(0, 2);
    vi.stubEnv('PAPERCUSP_DISABLE_BACKGROUND_TASKS', '0');
    findIssuesByWatchdogKeysMock.mockReset().mockResolvedValue([]);
    captureImprovementMock.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });
  const violation: BudgetViolation = {
    name: 'dev:pg_query',
    weight: HARD_CAP + 50,
    hardCap: true,
    grandfathered: false,
    cutAtLeast: HARD_CAP + 50 - BUDGET,
  };

  it.each([
    { mode: 'background tasks disabled', env: '1', argv: [] },
    { mode: 'import-only CLI', env: '0', argv: ['--verify-boot-imports'] },
  ])('keeps $mode warnings without any database lookup or capture', async ({ env, argv }) => {
    vi.stubEnv('PAPERCUSP_DISABLE_BACKGROUND_TASKS', env);
    process.argv = [...process.argv.slice(0, 2), ...argv];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reportViolations([violation]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(findIssuesByWatchdogKeysMock).not.toHaveBeenCalled();
      expect(captureImprovementMock).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('preserves ordinary escalation when the import-only token is not the CLI command', async () => {
    process.argv.push('serve', '--verify-boot-imports');
    await defaultEscalateHardCap(violation);
    expect(findIssuesByWatchdogKeysMock).toHaveBeenCalledWith(['tool-weight-hard-cap:dev:pg_query']);
    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('skips capture entirely when an OPEN issue already carries this watchdogKey', async () => {
    findIssuesByWatchdogKeysMock.mockReset().mockResolvedValue([{ id: 'EI-1', state: 'open' }]);
    captureImprovementMock.mockReset();

    await defaultEscalateHardCap(violation);

    expect(findIssuesByWatchdogKeysMock).toHaveBeenCalledWith(['tool-weight-hard-cap:dev:pg_query']);
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('captures when the pre-filter finds no matching issue', async () => {
    findIssuesByWatchdogKeysMock.mockReset().mockResolvedValue([]);
    captureImprovementMock.mockReset().mockResolvedValue({ ok: true, created: true, possibleDuplicates: [] });

    await defaultEscalateHardCap(violation);

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0][0]).toMatchObject({
      watchdogKey: 'tool-weight-hard-cap:dev:pg_query',
      dedupScope: 'open',
    });
    const body = captureImprovementMock.mock.calls[0][0].body as string;
    expect(body).toContain(`${violation.weight - HARD_CAP} over the ${HARD_CAP}-char HARD CAP`);
    expect(body).toContain(
      `cut at least ${violation.cutAtLeast} chars to clear the ${BUDGET}-char budget`,
    );
    expect(body).not.toContain(`${violation.cutAtLeast} over the ${HARD_CAP}-char HARD CAP`);
  });

  it('captures when a matching issue exists but is not open (resolved dup ⇒ let captureImprovement decide)', async () => {
    findIssuesByWatchdogKeysMock.mockReset().mockResolvedValue([{ id: 'EI-1', state: 'resolved' }]);
    captureImprovementMock.mockReset().mockResolvedValue({ ok: true, created: true, possibleDuplicates: [] });

    await defaultEscalateHardCap(violation);

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('fails open to capture when the pre-filter lookup itself errors', async () => {
    findIssuesByWatchdogKeysMock.mockReset().mockRejectedValue(new Error('pg down'));
    captureImprovementMock.mockReset().mockResolvedValue({ ok: true, created: true, possibleDuplicates: [] });

    await expect(defaultEscalateHardCap(violation)).resolves.toBeUndefined();
    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });
});
