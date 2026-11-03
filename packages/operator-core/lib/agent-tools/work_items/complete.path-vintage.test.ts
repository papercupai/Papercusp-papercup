/**
 * EI-20288629053504794 — completion path-vintage detector.
 *
 * The detector is deliberately pure at its decision seam: commit history is
 * injected so both directions (fires and stays silent) are falsifiable without
 * spawning git or depending on the shared checkout.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import { lastCommitTimesAsync } from '../../../../../scripts/lib/tsc-baseline-gate.mjs';
import { preExistingChangedPathsInCompletion, preExistingChangedPathsInCompletionAsync } from './complete';

const ROOT = '/repo';
const CREATED = '2026-08-12T22:39:04.318Z';
const BEFORE = '2026-08-12T01:21:00.000Z';
const AFTER = '2026-08-13T01:21:00.000Z';

function runFileAsync(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
    child?.stdin?.end();
  });
}

describe('lastCommitTimesAsync', () => {
  it('reads commit timestamps asynchronously and leaves unknown paths unknown', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'completion-vintage-git-'));
    try {
      await runFileAsync('git', ['init', '--quiet', root]);
      writeFileSync(nodePath.join(root, 'tracked.ts'), 'export const value = 1;\n');
      await runFileAsync('git', ['-C', root, 'add', '--', 'tracked.ts']);
      await runFileAsync('git', [
        '-C', root,
        '-c', 'user.name=Papercusp test',
        '-c', 'user.email=papercusp-test@example.invalid',
        'commit', '--quiet', '-m', 'fixture',
      ]);

      const times = await lastCommitTimesAsync(root, ['tracked.ts', 'missing.ts']);
      expect(times.get('tracked.ts')).toBeGreaterThan(0);
      expect(times.get('missing.ts')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const item = {
  createdAt: CREATED,
  payload: { paths: ['packages/old.ts', 'packages/new.ts'] },
};

describe('preExistingChangedPathsInCompletion', () => {
  it('yields while the asynchronous history lookup is pending', async () => {
    let resolveHistory!: (times: Map<string, number | null>) => void;
    let historyStarted = false;
    let historyCompleted = false;
    const history = new Promise<Map<string, number | null>>((resolve) => {
      resolveHistory = resolve;
    });
    const resultPromise = preExistingChangedPathsInCompletionAsync(
      item,
      { summary: 'updated the old target', filesChanged: ['packages/old.ts'] },
      {
        repoRoot: nodePath.resolve(__dirname, '../../../../..'),
        lastCommitTimesAsync: async () => {
          historyStarted = true;
          const times = await history;
          historyCompleted = true;
          return times;
        },
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(historyStarted).toBe(true);
    expect(historyCompleted).toBe(false);
    resolveHistory(new Map([['packages/old.ts', Date.parse(BEFORE) / 1000]]));
    const result = await resultPromise;

    expect(historyCompleted).toBe(true);
    expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
  });

  it('fires for a claimed target whose last commit predates item creation', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'updated the old target', filesChanged: ['packages/old.ts'] },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result).toEqual({
      createdAt: CREATED,
      paths: [{ path: 'packages/old.ts', lastCommitAt: BEFORE }],
    });
  });

  it('checks every positively claimed target and reports only the stale ones', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'updated both targets', filesChanged: ['packages/old.ts', 'packages/new.ts'] },
      {
        repoRoot: ROOT,
        lastCommitAt: (path) => (path.endsWith('old.ts') ? BEFORE : AFTER),
      },
    );

    expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
  });

  it('treats an explicit all-target claim as a claim for every payload path', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'All named target files were remediated' },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result?.paths.map((entry) => entry.path)).toEqual(item.payload.paths);
  });

  it('limits a broad claim to the explicit filesChanged census when one is supplied', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      {
        summary: 'All named target files were remediated',
        filesChanged: ['packages/old.ts'],
      },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
  });

  it('treats an explicit top-level empty filesChanged census as no changed paths', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { summary: 'All named target files were remediated', filesChanged: [] },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });

  it('treats an explicit nested empty filesChanged census as no changed paths', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        {
          summary: 'All named target files were remediated',
          verification: { filesChanged: [] },
        },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });

  it('does not attribute a generic all-changed-files evidence phrase to unrelated item targets', () => {
    const result = preExistingChangedPathsInCompletion(
      {
        createdAt: CREATED,
        payload: {
          paths: [
            'packages/operator-core/lib/release-checkpoint-launch.ts',
            'apps/operator/lib/release/green-checkpoint.ts',
          ],
        },
      },
      {
        testsRun: 'lint:tsc over all 5 changed files (run twice)',
        filesChanged: [
          'packages/operator-core/lib/release-checkpoint-config.ts',
          'packages/operator-core/lib/harness/routines/release-actions.ts',
        ],
      },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result).toBeUndefined();
  });

  /**
   * WI-41246: the all-claim branch returns payload.paths WHOLESALE, so an AUDIT claim must not
   * trigger it. The tool's own schema asks for an enumerated verification.coverage census, and
   * describing that census in English ("all N sites verified") used to flag every payload path
   * with "verify each named path was actually remediated" — a warn-only guard firing on correct,
   * well-evidenced completions, which trains agents to ignore it.
   */
  describe('audit claims vs change claims (WI-41246)', () => {
    // Verbatim from a real completion (EI-21301868186403490) that tripped the false advisory.
    const MEASURED_AUDIT_PROSE =
      'All 17 uncast sites pass STRING arrays — verified by DECLARED TYPE, not by variable name';

    it('stays silent for the real audit prose that produced the false advisory', () => {
      expect(
        preExistingChangedPathsInCompletion(
          item,
          { summary: MEASURED_AUDIT_PROSE },
          { repoRoot: ROOT, lastCommitAt: () => BEFORE },
        ),
      ).toBeUndefined();
    });

    it.each([
      'Enumerated all 53 sql.array call sites and verified each one against its declared type.',
      'Every path in the census was covered by the sweep.',
      'Each of the named files was verified as already correct; no edits were needed.',
    ])('stays silent for an audit-only all-claim: %s', (summary) => {
      expect(
        preExistingChangedPathsInCompletion(
          item,
          { summary },
          { repoRoot: ROOT, lastCommitAt: () => BEFORE },
        ),
      ).toBeUndefined();
    });

    /** Guards the opposite failure: narrowing the verb set must not blind the detector. */
    it.each([
      'All 12 files were updated to use the new helper.',
      'Every site was remediated.',
      'All named files corrected.',
      'All files verified fixed.',
    ])('still claims every payload path for a change claim: %s', (summary) => {
      const result = preExistingChangedPathsInCompletion(
        item,
        { summary },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      );

      expect(result?.paths.map((entry) => entry.path)).toEqual(item.payload.paths);
    });

    /**
     * The narrowing is surgical: only the WHOLESALE branch lost audit verbs. A path the
     * completion names explicitly is still caught by the per-path fallback, so an audit that
     * does name a stale path still reports THAT path — and only that one.
     */
    it('still reports a stale path the audit prose names explicitly', () => {
      const result = preExistingChangedPathsInCompletion(
        item,
        { summary: 'Audited packages/old.ts and confirmed every target file is correct' },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      );

      expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
    });

    /**
     * PERMANENT NEGATIVE CONTROL. A guard test that has never failed is a guard nobody has
     * tested, and proving falsifiability by mutating the shared tree is unsafe here (git-sync
     * sweeps the whole tree on a schedule and can commit the mutant). So the pre-fix predicate
     * lives here verbatim, forever, and the contrast re-proves itself on every run instead of
     * once. If someone restores an audit verb to PATH_CLAIM_ALL_RE, the second assertion fails.
     */
    describe('pre-fix predicate (control — never used in production)', () => {
      const PRE_FIX_PATH_CLAIM_ALL_RE =
        /\b(?:all|every|each|both|named)\b[\s\S]{0,100}\b(?:path|paths|file|files|site|sites|target|targets)\b[\s\S]{0,100}\b(?:changed|fixed|updated|remediated|correct|verified|covered|replaced|removed)\b/i;

      it('calibration: the control still matches a genuine change claim', () => {
        // Proves the control is wired correctly — a control that never matches proves nothing.
        expect(PRE_FIX_PATH_CLAIM_ALL_RE.test('All 12 files were updated.')).toBe(true);
      });

      it('the control DID match the audit prose — that is the defect being fixed', () => {
        expect(PRE_FIX_PATH_CLAIM_ALL_RE.test(MEASURED_AUDIT_PROSE)).toBe(true);
      });

      it('the shipped detector no longer flags that same prose', () => {
        expect(
          preExistingChangedPathsInCompletion(
            item,
            { summary: MEASURED_AUDIT_PROSE },
            { repoRoot: ROOT, lastCommitAt: () => BEFORE },
          ),
        ).toBeUndefined();
      });
    });
  });

  it('stays silent when the path was committed after the item', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { summary: 'updated the new target', filesChanged: ['packages/new.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => AFTER },
      ),
    ).toBeUndefined();
  });

  it('stays silent when there is no positive path claim', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { summary: 'ran the focused suite', testsRun: '55/55 passed' },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });

  it('does not treat a target path cited only in test or coordination evidence as changed', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        {
          summary: 'fixed the completion advisory',
          filesChanged: ['packages/new.ts'],
          testsRun: 'npm run test:file -- packages/old.ts',
          testResult: 'packages/old.ts passed',
          coordNotes: 'Used packages/old.ts as the falsification probe.',
        },
        {
          repoRoot: ROOT,
          lastCommitAt: (path) => (path.endsWith('new.ts') ? AFTER : BEFORE),
        },
      ),
    ).toBeUndefined();
  });

  it('does not widen the target population from nested verification evidence', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        {
          verification: {
            testsRun: 'vitest packages/old.ts',
            testResult: 'packages/old.ts passed',
            verifiedHow: 'manual probe of packages/old.ts',
          },
        },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });

  it('still honors an explicit target path in the change-facing completion headline', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      {
        summary: 'Updated packages/old.ts and verified the focused behavior',
        filesChanged: ['packages/new.ts'],
      },
      {
        repoRoot: ROOT,
        lastCommitAt: (path) => (path.endsWith('new.ts') ? AFTER : BEFORE),
      },
    );

    expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
  });

  it('fails open for absent metadata, unknown history, and a throwing probe', () => {
    expect(
      preExistingChangedPathsInCompletion(
        { payload: item.payload },
        { filesChanged: ['packages/old.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { filesChanged: ['packages/old.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => null },
      ),
    ).toBeUndefined();
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { filesChanged: ['packages/old.ts'] },
        {
          repoRoot: ROOT,
          lastCommitAt: () => {
            throw new Error('git unavailable');
          },
        },
      ),
    ).toBeUndefined();
  });

  it('reads a submodule path from the submodule repository, not the superproject', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'completion-vintage-'));
    const submodule = nodePath.join(root, 'libs', 'testing-shell');
    try {
      mkdirSync(nodePath.join(root, '.git'));
      writeFileSync(nodePath.join(root, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
      mkdirSync(submodule, { recursive: true });
      writeFileSync(nodePath.join(submodule, '.git'), 'gitdir: ../../.git/modules/testing-shell\n');

      const calls: Array<{ repoRoot: string; paths: string[] }> = [];
      const result = await preExistingChangedPathsInCompletionAsync(
        { createdAt: CREATED, payload: { paths: ['libs/testing-shell/package.json'] } },
        { filesChanged: ['libs/testing-shell/package.json'] },
        {
          repoRoot: root,
          lastCommitTimesAsync: async (repoRoot, paths) => {
            calls.push({ repoRoot, paths: [...paths] });
            return new Map([['package.json', Date.parse(BEFORE) / 1000]]);
          },
        },
      );

      expect(result?.paths).toEqual([
        { path: 'libs/testing-shell/package.json', lastCommitAt: BEFORE },
      ]);
      expect(calls).toEqual([{ repoRoot: submodule, paths: ['package.json'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not judge an invalid or escaping path', () => {
    expect(
      preExistingChangedPathsInCompletion(
        { createdAt: CREATED, payload: { paths: ['../outside.ts', 'src/**/*.ts'] } },
        { filesChanged: ['../outside.ts', 'src/**/*.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });
});

describe('complete.ts wiring', () => {
  const source = readFileSync(nodePath.join(__dirname, 'complete.ts'), 'utf8');

  it('computes the detector from the fetched item and raw completion', () => {
    expect(source).toMatch(/await\s+preExistingChangedPathsInCompletionAsync\(\s*existing,\s*it\.completion\s*\)/);
  });

  it('returns the warning so a result-door truncation cannot hide the finding', () => {
    expect(source).toMatch(/\.\.\.\(preExistingPathsWarning \? \{ preExistingPathsWarning \} : \{\}\)/);
  });
});
