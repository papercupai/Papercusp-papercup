import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestModule } from 'vitest/node';
import {
  collectVitestModuleErrors,
  formatVitestErrorForOutput,
  formatVitestOutputTail,
} from './admin-test-runs-reporter';
import AdminTestRunsReporter from './admin-test-runs-reporter';

const database = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(async () => []), { end: vi.fn(async () => undefined) });
  return { sql, open: vi.fn(() => sql) };
});
vi.mock('postgres', () => ({ default: database.open }));

describe('legacy reporter shared ledger routing', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([true, false])('persists outside the disposable app database when dedicated ledger=%s', async dedicated => {
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://isolated/app');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', dedicated ? 'postgresql://shared/ledger' : undefined);
    const reporter = new AdminTestRunsReporter();
    reporter.onTestModuleEnd({ moduleId: MODULE, state: () => 'passed', errors: () => [],
      diagnostic: () => ({ duration: 1 }), children: { allTests: () => [] } } as unknown as TestModule);
    await reporter.onTestRunEnd();
    expect(database.open).toHaveBeenCalledWith(dedicated ? 'postgresql://shared/ledger' : 'postgresql://isolated/app',
      expect.any(Object));
    expect(database.sql).toHaveBeenCalledTimes(1);
    expect(database.sql.end).toHaveBeenCalledTimes(1);
  });
});

const MODULE = '/repo/packages/operator-core/lib/pc-heavy.test.ts';
const DISPLAY = 'packages/operator-core/lib/pc-heavy.test.ts';

describe('admin test-runs reporter failure evidence (EI-19368022827067633)', () => {
  it('distinguishes identical assertion messages by preserving each test-file frame', () => {
    const sameMessage = "expected '[pc-heavy] coalesced' not to contain 'coalesced:'";
    const output = formatVitestOutputTail(
      [
        {
          message: sameMessage,
          stacks: [
            { method: 'expect', file: '/repo/node_modules/chai/index.js', line: 1, column: 2 },
            { method: 'test', file: MODULE, line: 637, column: 33 },
          ],
        },
        {
          message: sameMessage,
          stacks: [{ method: 'test', file: MODULE, line: 643, column: 37 }],
        },
      ],
      MODULE,
      DISPLAY,
    );

    expect(output).toContain(`${sameMessage}\n❯ ${DISPLAY}:637:33`);
    expect(output).toContain(`${sameMessage}\n❯ ${DISPLAY}:643:37`);
  });

  it('falls back to a textual stack and prefers the frame for the test module', () => {
    const output = formatVitestErrorForOutput(
      {
        message: 'expected false to be true',
        stack: [
          'AssertionError: expected false to be true',
          '    at assert (/repo/node_modules/chai/index.js:1:2)',
          `    at ${MODULE}:91:7`,
        ].join('\n'),
      },
      MODULE,
      DISPLAY,
    );

    expect(output).toBe(`expected false to be true\n❯ ${DISPLAY}:91:7`);
  });

  it('collects failed assertion errors even when the module-level list is empty', () => {
    const assertion = { message: 'assertion failed', stacks: [{ file: MODULE, line: 12, column: 4 }] };
    const fakeModule = {
      errors: () => [],
      children: {
        *allTests() {
          yield { result: () => ({ state: 'passed', errors: undefined }) };
          yield { result: () => ({ state: 'failed', errors: [assertion] }) };
        },
      },
    } as unknown as TestModule;

    expect(collectVitestModuleErrors(fakeModule)).toEqual([assertion]);
  });

  it('deduplicates the same error surfaced at both module and test level', () => {
    const error = { message: 'boom', stacks: [{ file: MODULE, line: 22, column: 9 }] };
    expect(formatVitestOutputTail([error, error], MODULE, DISPLAY)).toBe(`boom\n❯ ${DISPLAY}:22:9`);
  });

  it('stays fail-soft for malformed values and throwing message accessors', () => {
    const hostile = Object.create(null, {
      message: {
        get() {
          throw new Error('getter exploded');
        },
      },
    });

    expect(formatVitestErrorForOutput('plain failure', MODULE, DISPLAY)).toBe('plain failure');
    expect(formatVitestErrorForOutput(hostile, MODULE, DISPLAY)).toBe('[unreadable Vitest error]');
  });
});
