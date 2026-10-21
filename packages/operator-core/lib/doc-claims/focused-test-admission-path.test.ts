import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PC_HEAVY_WRAPPER,
  TEST_ROUTER,
  judgeFocusedTestAdmissionPath,
  stripComments,
} from './focused-test-admission-path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TS = join(HERE, '../agent-tools/testing/run.ts');
const PC_HEAVY = join(HERE, '../../../../scripts/pc-heavy.sh');
const AFFECTED_PLAN = join(HERE, '../agent-tools/testing/affected-plan.ts');

/**
 * The live tree's shape, reduced to the lines the doc claim actually rests on: the direct
 * node spawn of the router, plus the env scrubs that must REMAIN legal beside it.
 */
const SAFE = [
  'return runTestProcess(',
  '  process.execPath,',
  `  [join(cwd, 'scripts', '${TEST_ROUTER}')],`,
  '  args,',
  ');',
  'delete childEnv.PC_HEAVY_PREEMPT_READY_FILE;',
  'delete childEnv.PC_HEAVY_PSI_FINALIZATION_FILE;',
].join('\n');

describe('focused-test admission path doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('accepts the live shape', () => {
      const v = judgeFocusedTestAdmissionPath({ runSource: SAFE });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.routerLaunchedWithNodeBinary).toBe(true);
      expect(v.freeOfPcHeavyWrapper).toBe(true);
    });

    it('accepts the launch-spec object shape, and still refuses a wrapper as its first argv', () => {
      const spec = [
        'return {',
        '  command: process.execPath,',
        `  args: [join(opts.root, 'scripts', '${TEST_ROUTER}'), ...opts.files],`,
        '};',
      ].join('\n');
      expect(judgeFocusedTestAdmissionPath({ runSource: spec }).routerLaunchedWithNodeBinary).toBe(true);
      const wrapped = spec.replace(
        `[join(opts.root, 'scripts', '${TEST_ROUTER}')`,
        `[join(opts.root, 'scripts', 'run-wrapper.sh'), '${TEST_ROUTER}'`,
      );
      expect(wrapped).not.toBe(spec);
      expect(judgeFocusedTestAdmissionPath({ runSource: wrapped }).routerLaunchedWithNodeBinary).toBe(false);
    });

    it('catches the router being wrapped back into pc-heavy', () => {
      const v = judgeFocusedTestAdmissionPath({
        runSource: SAFE.replace(
          '  process.execPath,',
          `  'bash',\n  ['scripts/${PC_HEAVY_WRAPPER}'],`,
        ),
      });
      expect(v.ok).toBe(false);
      expect(v.routerLaunchedWithNodeBinary).toBe(false);
      expect(v.freeOfPcHeavyWrapper).toBe(false);
      expect(v.problems.join(' ')).toContain('EI-20223211961308878');
    });

    it('catches the direct node spawn being replaced by a shell launcher', () => {
      const v = judgeFocusedTestAdmissionPath({
        runSource: SAFE.replace('  process.execPath,', "  '/bin/sh',"),
      });
      expect(v.ok).toBe(false);
      expect(v.routerLaunchedWithNodeBinary).toBe(false);
      // The wrapper itself is absent, so this must be caught by the LAUNCH leg alone —
      // proving the two checks are independent rather than one doing all the work.
      expect(v.freeOfPcHeavyWrapper).toBe(true);
    });

    it('catches process.execPath surviving while the router moves behind a wrapper', () => {
      const v = judgeFocusedTestAdmissionPath({
        runSource: SAFE.replace(
          `  [join(cwd, 'scripts', '${TEST_ROUTER}')],`,
          `  [join(cwd, 'scripts', '${PC_HEAVY_WRAPPER}'), '--', '${TEST_ROUTER}'],`,
        ),
      });
      expect(v.ok).toBe(false);
      // Adjacency is what catches this: execPath is still present, but no longer paired
      // with the router argument.
      expect(v.routerLaunchedWithNodeBinary).toBe(false);
    });

    it('does NOT fire on the PC_HEAVY_* env scrubs alone', () => {
      // Regression guard for the over-broad judge this deliberately avoids: banning the
      // substring PC_HEAVY would block the nested-invocation EEXIST fix in run.ts.
      const v = judgeFocusedTestAdmissionPath({ runSource: SAFE });
      expect(v.freeOfPcHeavyWrapper).toBe(true);
      expect(SAFE).toContain('PC_HEAVY_PREEMPT_READY_FILE');
    });

    it('is not satisfied by comments alone', () => {
      // run.ts really does name "the repository's pc-heavy wrapper" in prose, and names the
      // router throughout its JSDoc. Both must be invisible to the judge.
      const commentOnly = [
        '/*',
        ` * testing:run can itself be invoked from the repository's ${PC_HEAVY_WRAPPER}`,
        ` * wrapper, which spawns ${TEST_ROUTER} via process.execPath.`,
        ' */',
        "const command = '/bin/sh';",
      ].join('\n');
      const v = judgeFocusedTestAdmissionPath({ runSource: commentOnly });
      // The wrapper mention is a comment, so it must NOT be reported as a spawn target...
      expect(v.freeOfPcHeavyWrapper).toBe(true);
      // ...and the commented router mention must NOT satisfy the launch leg.
      expect(v.routerLaunchedWithNodeBinary).toBe(false);
      expect(v.ok).toBe(false);
    });

    it('strips both comment forms', () => {
      expect(stripComments('a /* x */ b // y\nc')).not.toContain('x');
      expect(stripComments('a /* x */ b // y\nc')).not.toContain('y');
      expect(stripComments('a /* x */ b // y\nc')).toContain('c');
    });
  });

  describe('the live tree', () => {
    it('testing:run still reaches the router without an admission ticket', () => {
      const v = judgeFocusedTestAdmissionPath({ runSource: readFileSync(RUN_TS, 'utf8') });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it('the prose sites that promise the non-queuing path still say so', () => {
      // If a future change removes this guidance, the judge above would keep passing while
      // guarding a claim nobody makes any more. Pin the claim's EXISTENCE too, so the pair
      // stays coherent: code-truth on one side, the promise it backs on the other.
      //
      // pc-heavy.sh states it inside a wrapped `#` comment block, so the phrase is NOT
      // contiguous in the raw bytes ("...takes no admission\n#   ticket."). Strip the
      // comment gutter and collapse whitespace before matching, or this assertion fails on
      // line-wrapping rather than on the claim actually being gone.
      const pcHeavyProse = readFileSync(PC_HEAVY, 'utf8')
        .replace(/^#\s?/gm, '')
        .replace(/\s+/g, ' ');
      expect(pcHeavyProse).toContain('takes no admission ticket');
      expect(pcHeavyProse).toContain('testing:run { files }');
      expect(readFileSync(AFFECTED_PLAN, 'utf8')).toContain('no admission ticket');
    });
  });
});
