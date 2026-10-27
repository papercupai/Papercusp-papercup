import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  extractIdentifierTokens,
  gitGrepSymbolResolver,
  hasCodeSubjects,
  resolveQuestionCodeSubjects,
  type SymbolResolver,
} from './code-subject-resolution';

/** Fixture symbol index: identifier → defining files. */
function fixtureResolver(index: Record<string, string[]>): SymbolResolver & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (identifiers: readonly string[]) => {
    calls.push([...identifiers]);
    return new Map(identifiers.filter((id) => index[id]).map((id) => [id, index[id]!]));
  }) as SymbolResolver & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const INDEX = {
  routeConsult: ['packages/operator-core/lib/consult/relevance-router.ts'],
  BlendWeights: ['packages/operator-core/lib/consult/relevance-router.ts'],
  measureThing: ['packages/a/thing.ts', 'packages/b/thing.ts', 'packages/c/thing.ts', 'packages/d/thing.ts'],
};

describe('resolveQuestionCodeSubjects (R-1)', () => {
  it('resolves an identifier named without a path to the file that defines it', async () => {
    const subjects = await resolveQuestionCodeSubjects(
      'Why does routeConsult drop an aged expert before the floor runs?',
      { resolveSymbol: fixtureResolver(INDEX) },
    );
    expect(subjects.paths).toEqual([]);
    expect(subjects.identifiers).toEqual(['routeConsult']);
    expect(subjects.files).toEqual(['packages/operator-core/lib/consult/relevance-router.ts']);
    expect(subjects.resolved).toEqual({ routeConsult: ['packages/operator-core/lib/consult/relevance-router.ts'] });
    expect(hasCodeSubjects(subjects)).toBe(true);
  });

  it('keeps an explicit path in the resolved set alongside resolved identifiers', async () => {
    const subjects = await resolveQuestionCodeSubjects(
      'Does `BlendWeights` in packages/operator-core/lib/consult/relevance-router.ts or lib/other/thing.ts matter?',
      { resolveSymbol: fixtureResolver(INDEX) },
    );
    expect(subjects.paths).toEqual(['packages/operator-core/lib/consult/relevance-router.ts', 'lib/other/thing.ts']);
    expect(subjects.files).toEqual(['packages/operator-core/lib/consult/relevance-router.ts', 'lib/other/thing.ts']);
  });

  it('resolves a question with no code subject to an empty set, without calling the resolver', async () => {
    const resolver = fixtureResolver(INDEX);
    const subjects = await resolveQuestionCodeSubjects(
      'How should we decide which agent answers a product question about pricing?',
      { resolveSymbol: resolver },
    );
    expect(subjects.files).toEqual([]);
    expect(subjects.identifiers).toEqual([]);
    expect(resolver.calls).toEqual([]);
    expect(hasCodeSubjects(subjects)).toBe(false);
  });

  it('caps defining files per identifier', async () => {
    const subjects = await resolveQuestionCodeSubjects('what calls measureThing?', { resolveSymbol: fixtureResolver(INDEX) });
    expect(subjects.files).toHaveLength(3);
  });

  it('leaves identifiers unresolved, not failed, when the resolver throws', async () => {
    const subjects = await resolveQuestionCodeSubjects('why is routeConsult slow?', {
      resolveSymbol: async () => { throw new Error('index down'); },
    });
    expect(subjects).toMatchObject({ resolver: 'unavailable', files: [], identifiers: ['routeConsult'] });
  });
});

describe('extractIdentifierTokens', () => {
  it('finds camelCase, PascalCase and code-quoted identifiers but not tool names, members or prose', () => {
    expect(extractIdentifierTokens('Is `edit_attribution_ledger` read by routeConsult or BlendWeights?'))
      .toEqual(['edit_attribution_ledger', 'routeConsult', 'BlendWeights']);
    expect(extractIdentifierTokens('consult:get_feedback and deps.getSql on macOS with GitHub')).toEqual([]);
    expect(extractIdentifierTokens('Why does the Router fail?')).toEqual([]);
  });

  it('caps the identifier count', () => {
    expect(extractIdentifierTokens('aaB bbC ccD ddE eeF')).toHaveLength(4);
  });
});

describe('gitGrepSymbolResolver', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'code-subject-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/router.ts'), 'export async function routeThing(q: string) { return q; }\nexport interface ThingWeights { a: number }\nexport const typedConst: number = 1;\n');
    mkdirSync(join(repo, 'apps/host'), { recursive: true });
    writeFileSync(join(repo, 'apps/host/main.ts'), 'export function hostOnly() {}\n');
    writeFileSync(join(repo, 'src/router.test.ts'), 'export function routeThing() {}\n');
    writeFileSync(join(repo, 'src/caller.ts'), "import { routeThing } from './router';\nrouteThing('x');\n");
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('returns the defining file first and never a mere caller', async () => {
    const resolve = gitGrepSymbolResolver({ cwd: repo });
    const out = await resolve(['routeThing', 'ThingWeights', 'missingThing']);
    expect(out.get('routeThing')).toEqual(['src/router.ts', 'src/router.test.ts']);
    expect(out.get('ThingWeights')).toEqual(['src/router.ts']);
    expect(out.has('missingThing')).toBe(false);
  });

  it('reports invalid inherited Git worker settings as unavailable', async () => {
    // A negative value makes Git fail before searching, without spawning an
    // excessive worker population in the test process. Git rejects this before
    // applying command-level overrides; it must not look like an absent symbol.
    execFileSync('git', ['config', 'grep.threads', '-1'], { cwd: repo });
    try {
      const resolve = gitGrepSymbolResolver({ cwd: repo });
      const subjects = await resolveQuestionCodeSubjects('where is `routeThing` defined?', { resolveSymbol: resolve });
      expect(subjects.resolver).toBe('unavailable');
      expect(subjects.files).toEqual([]);
    } finally {
      execFileSync('git', ['config', '--unset', 'grep.threads'], { cwd: repo });
    }
  });

  it('searches the whole checkout from a subdirectory cwd and returns repo-relative paths', async () => {
    // The operator hosts run with cwd <checkout>/apps/operator; a cwd-relative
    // pathspec searched only that subtree and found nothing in packages/.
    const resolve = gitGrepSymbolResolver({ cwd: join(repo, 'apps/host') });
    const out = await resolve(['routeThing', 'hostOnly']);
    expect(out.get('routeThing')).toEqual(['src/router.ts', 'src/router.test.ts']);
    expect(out.get('hostOnly')).toEqual(['apps/host/main.ts']);
  });

  it('resolves several identifiers in one pass, including a typed const whose match ends in a colon', async () => {
    const resolve = gitGrepSymbolResolver({ cwd: repo });
    const out = await resolve(['typedConst', 'ThingWeights', 'notAnIdentifier!']);
    expect(out.get('typedConst')).toEqual(['src/router.ts']);
    expect(out.get('ThingWeights')).toEqual(['src/router.ts']);
    expect(out.size).toBe(2);
  });

  it('reports a lookup outside a git checkout as unavailable, not as no definition', async () => {
    const resolve = gitGrepSymbolResolver({ cwd: tmpdir() });
    await expect(resolve(['routeThing'])).rejects.toThrow(/symbol resolver unavailable/);
    const subjects = await resolveQuestionCodeSubjects('where is `routeThing` defined?', { resolveSymbol: resolve });
    expect(subjects.resolver).toBe('unavailable');
    expect(subjects.files).toEqual([]);
  });

  it('reports a timed-out lookup as unavailable', async () => {
    // A real search over this tiny fixture can finish before a 1ms timeout.
    // Exercise actual child cancellation with a controlled, nonterminating Git
    // stand-in, and first prove the executable is runnable (not a spawn error).
    const bin = mkdtempSync(join(tmpdir(), 'code-subject-timeout-'));
    const git = join(bin, 'git');
    writeFileSync(git, `#!${process.execPath}\nif (process.argv.includes('--ready')) process.stdout.write('ready'); else setInterval(() => {}, 1_000);\n`);
    chmodSync(git, 0o755);
    try {
      expect(execFileSync(git, ['--ready'], { encoding: 'utf8', timeout: 5_000 })).toBe('ready');
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
      const resolve = gitGrepSymbolResolver({ cwd: repo, timeoutMs: 1 });
      const subjects = await resolveQuestionCodeSubjects('where is `routeThing` defined?', { resolveSymbol: resolve });
      expect(subjects.resolver).toBe('unavailable');
    } finally {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
