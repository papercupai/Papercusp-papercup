import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { FairCase } from './fair-comparison';
import {
  corpusShape,
  FAIR_CORPUS,
  FAIR_CORPUS_COMMIT,
  FAIR_CORPUS_SHAPE,
  initialKeys,
  nativeLanguageControls,
  validateCorpus,
  verifyCorpusSites,
  type FairCorpusEntry,
} from './fair-comparison-corpus';

const entry = (kase: Partial<FairCase> & Pick<FairCase, 'id'>, seeds = 1, neutral = 0): FairCorpusEntry => ({
  kase: { intent: 'callers', subject: 'foo', tags: [], source: 'authored', ...kase },
  why: 'because',
  origin: 'test',
  seeds: Array.from({ length: seeds }, (_, i) => ({ path: `a/${kase.id}.ts`, line1: i + 1, text: 'foo(' })),
  neutral: Array.from({ length: neutral }, (_, i) => ({ path: `d/${kase.id}.ts`, line1: i + 1, text: 'function foo' })),
});

describe('native multilingual calibration oracle', () => {
  it('pins independently specified positive and absence answers for each operation', () => {
    const { cases, keys, files } = nativeLanguageControls();
    const expected = { callers: [2], callees: [1], impact: [2], definition: [1],
      references: [2], 'symbol-search': [1], 'text-search': [1, 2] };
    for (const language of ['javascript', 'typescript', 'rust', 'python', 'go']) {
      for (const [intent, lines] of Object.entries(expected)) {
        const positive = cases.find(c => c.id === `native-${language}-${intent}-positive-configured-current`)!;
        expect(positive, `${language}/${intent} positive`).toBeDefined();
        expect(files[positive.anchorFile!]!.split('\n')[language === 'go' ? 2 : 1]).toContain('target()');
        const offset = language === 'go' ? 1 : 0;
        expect(keys.find(k => k.caseId === positive.id)!.sites).toEqual(lines.map(line => `${positive.anchorFile}:${line + offset}`));
        const absent = cases.find(c => c.id === `native-${language}-${intent}-absence-configured-current`)!;
        expect(keys.find(k => k.caseId === absent.id)!.sites).toEqual([]);
        if (intent === 'text-search') expect(files[absent.anchorFile!]).not.toContain(absent.subject);
      }
      const stale = keys.find(k => k.caseId === `native-${language}-callers-positive-configured-stale`)!;
      const deleted = keys.find(k => k.caseId === `native-${language}-callers-positive-configured-deleted`)!;
      expect(stale.sites).toEqual([]);
      expect(deleted.sites).toEqual([]);
    }
    expect(new Set(cases.map(c => c.id)).size).toBe(85);
    expect(cases.every(c => c.source === 'authored' && c.taskRef?.startsWith('authored-control:'))).toBe(true);
  });
});

describe('validateCorpus — per-entry rules', () => {
  // per-entry problems are prefixed by the case id; corpus-shape problems are not
  const only = (es: FairCorpusEntry[]) =>
    validateCorpus(es).filter((p) => !/^(total |intent |absence: |tag |duplicate case id )/.test(p));

  it('refuses a case with no seeds that is not tagged absence (an empty key by omission)', () => {
    expect(only([entry({ id: 'x' }, 0)])).toContain('x: no seeds and not tagged absence — an empty key by omission');
  });

  it('refuses an absence case that carries seeds', () => {
    expect(only([entry({ id: 'x', tags: ['absence'] }, 1)])).toContain('x: tagged absence but carries 1 seed(s)');
  });

  it('requires depth on impact and refuses it elsewhere', () => {
    expect(only([entry({ id: 'i', intent: 'impact' })])).toContain('i: impact case needs depth >= 1');
    expect(only([entry({ id: 'c', depth: 2 })])).toContain('c: depth only applies to impact');
  });

  it('requires an anchorFile for same-name cases except exact-name symbol search', () => {
    expect(only([entry({ id: 's', tags: ['same-name'] })])).toContain('s: same-name case needs an anchorFile');
    expect(only([entry({ id: 'q', intent: 'symbol-search', tags: ['same-name'] })])).toEqual([]);
  });

  it('refuses duplicate ids, duplicate sites and absolute paths', () => {
    const dup = entry({ id: 'd' }, 1);
    const twice: FairCorpusEntry = { ...dup, seeds: [...dup.seeds, ...dup.seeds] };
    expect(only([twice])).toContain('d: site a/d.ts:1 listed twice');
    expect(validateCorpus([entry({ id: 'z' }), entry({ id: 'z' })])).toContain('duplicate case id z');
    const abs: FairCorpusEntry = { ...entry({ id: 'p' }), seeds: [{ path: '/abs/x.ts', line1: 1, text: 'x' }] };
    expect(only([abs])).toContain('p: site /abs/x.ts:1 is not repo-relative POSIX');
  });

  it('accepts a well-formed entry', () => {
    expect(only([entry({ id: 'ok' }, 2, 1)])).toEqual([]);
  });
});

describe('validateCorpus — preregistered shape', () => {
  it('reports every stratum that is under its floor', () => {
    const problems = validateCorpus([entry({ id: 'only' })]);
    expect(problems).toContain(`total 1 outside [${FAIR_CORPUS_SHAPE.minTotal}, ${FAIR_CORPUS_SHAPE.maxTotal}]`);
    expect(problems.some((p) => p.startsWith('intent impact: 0'))).toBe(true);
    expect(problems.some((p) => p.startsWith('absence: 0'))).toBe(true);
    expect(problems.some((p) => p.startsWith('tag dynamic-dispatch: 0'))).toBe(true);
  });
});

describe('initialKeys', () => {
  it('turns seeds into valid sites and neutral sites into neutral, and keeps absence keys empty', () => {
    const [k1, k2] = initialKeys([entry({ id: 'a' }, 2, 1), entry({ id: 'b', tags: ['absence'] }, 0)]);
    expect(k1).toEqual({ caseId: 'a', sites: ['a/a.ts:1', 'a/a.ts:2'], aliases: {}, rejected: [], neutral: ['d/a.ts:1'] });
    expect(k2).toEqual({ caseId: 'b', sites: [], aliases: {}, rejected: [], neutral: [] });
  });
});

describe('verifyCorpusSites', () => {
  it('reports a missing file and an anchor text that is not on its line', () => {
    const e = entry({ id: 'v' }, 2);
    const problems = verifyCorpusSites([e], (p) => (p === 'a/v.ts' ? 'foo(1)\nbar()\n' : null));
    expect(problems).toEqual(['v: a/v.ts:2 does not contain "foo("']);
    expect(verifyCorpusSites([e], () => null)).toEqual([
      `v: a/v.ts absent at ${FAIR_CORPUS_COMMIT.slice(0, 12)}`,
      `v: a/v.ts absent at ${FAIR_CORPUS_COMMIT.slice(0, 12)}`,
    ]);
  });
});

// ─── the real corpus ──────────────────────────────────────────────────────────

const git = (args: string[], cwd?: string): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const repoRoot = (git(['rev-parse', '--show-superproject-working-tree']) ?? '').trim() || (git(['rev-parse', '--show-toplevel']) ?? '').trim();

/** Read `path` at FAIR_CORPUS_COMMIT, descending into the submodule that owns it. */
function readAtCorpusCommit(path: string): string | null {
  const direct = git(['show', `${FAIR_CORPUS_COMMIT}:${path}`], repoRoot);
  if (direct !== null) return direct;
  let commit = FAIR_CORPUS_COMMIT;
  let dir = repoRoot;
  let rest = path;
  for (;;) {
    const links = (git(['ls-tree', '-r', commit], dir) ?? '')
      .split('\n')
      .map((l) => /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => rest.startsWith(`${m[2]}/`))
      .sort((a, b) => b[2]!.length - a[2]!.length);
    const m = links[0];
    if (!m) return null;
    dir = `${dir}/${m[2]}`;
    commit = m[1]!;
    rest = rest.slice(m[2]!.length + 1);
    const t = git(['show', `${commit}:${rest}`], dir);
    if (t !== null) return t;
  }
}

describe('FAIR_CORPUS (frozen at FAIR_CORPUS_COMMIT)', () => {
  it('meets every per-entry rule and the preregistered strata', () => {
    expect(validateCorpus(FAIR_CORPUS)).toEqual([]);
    const shape = corpusShape(FAIR_CORPUS);
    expect(shape.total).toBeGreaterThanOrEqual(FAIR_CORPUS_SHAPE.minTotal);
  });

  it('pins every seed and neutral site to its line at the frozen commit', () => {
    expect(git(['cat-file', '-e', `${FAIR_CORPUS_COMMIT}^{commit}`], repoRoot), `frozen commit ${FAIR_CORPUS_COMMIT} missing from this clone`).not.toBeNull();
    expect(verifyCorpusSites(FAIR_CORPUS, readAtCorpusCommit)).toEqual([]);
  });
});
