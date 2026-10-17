/**
 * posttooluse-required-field-strand-nudge — the recurrence guard for the
 * required-field-strand CLASS (EI-19374535041074908).
 *
 * THE POINT OF THIS FILE: the class recurred 7× in ~48h (WI-6867,
 * EI-19340691974632497, EI-19331709872526777, EI-19332542096444388,
 * EI-19365056012137849, EI-19374026323028948, agent-facts/assumptions.test.ts),
 * each fixed one file at a time. A detector already existed; nothing triggered it.
 * So the assertion that matters here is not "the hook is well-formed" but
 * **it FIRES on the real thing** — exercised against the REAL exported
 * `diffRequiredAdditions` from scripts/check-required-field-strands.mjs, not a
 * stand-in. Without that, this guard becomes the eighth mitigation.
 *
 * The negative cases matter exactly as much: a nudge that fires on ordinary edits
 * is noise agents learn to ignore, which is how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-required-field-strand-nudge.mjs');

describe('P-037 merged interface consequence collector', () => {
  it('optionally measures a body-only symbol change without inventing an interface consequence', async () => {
    const hook = await loadHook();
    const before = 'export function changed() { return 1; }\nexport const same = 2;';
    const after = before.replace('return 1', 'return 3');
    const result = await hook.consequenceFor(resolve(ROOT, 'packages/operator-core/lib/example.ts'), {
      sizeOf: () => after.length, readFile: () => after, showAt: () => before,
      resolveBase: () => 'a'.repeat(40), includeSourceChanges: true,
    });
    expect(result?.changes).toEqual([]);
    expect(result?.sourceChange).toMatchObject({ root: ROOT, path: 'packages/operator-core/lib/example.ts',
      symbols: [{ name: 'changed', line: 1 }], base: 'a'.repeat(40) });
    expect(result?.sourceChange?.sha256).not.toBe(result?.sourceChange?.beforeSha256);
  });
  async function collect(before: string, after: string) {
    const hook = await loadHook();
    return hook.consequenceFor(resolve(ROOT, 'packages/operator-core/lib/example.ts'), {
      sizeOf: () => after.length, readFile: () => after, showAt: () => before,
      resolveBase: () => 'a'.repeat(40),
    });
  }
  it.each([
    ['export function f(a: string) { return a; }', 'export function f(a: number) { return a; }', 'signature f'],
    ['export function f() { return { x: 1 }; }', 'export function f() { return { y: 1 }; }', 'returned fields f'],
    ['export class C { result() { return { x: 1 }; } }', 'export class C { result() { return { y: 1 }; } }', 'returned fields C.result'],
    ['export class C { get result() { return { x: 1 }; } }', 'export class C { get result() { return { y: 1 }; } }', 'returned fields C.result'],
    ['export const f = () => ({ x: 1 });', 'export const f = () => ({ y: 1 });', 'returned fields f'],
    ['export const t = defineTool({ name: "t", parameters: { x: "string" } });', 'export const t = defineTool({ name: "t", parameters: { x: "number" } });', 'registered tool'],
    ['export const t = defineTool({ name: "t", argSchema: { x: "string" } });', 'export const t = defineTool({ name: "t", argSchema: { x: "number" } });', 'registered tool'],
    ['export const t = defineTool({ name: "t" });', 'export const t = defineTool({ name: "t", argSchema: {} });', 'registered tool'],
    ['export function f() { return null; }', 'export function f() { return { x: 1 }; }', 'returned fields f'],
    ['export const f = () => null;', 'export const f = () => ({ x: 1 } as const);', 'returned fields f'],
    ['export function f() { return { x: 1 }; }', 'export function f() { return null; }', 'returned fields f'],
    ['', 'export function f(a: string) { return a; }', 'signature f'],
    ['export function f(a: string) { return a; }', '', 'signature f'],
    ['export interface R { x: string }', 'export interface R { x: string; y: number }', 'required R.y'],
  ])('detects the actual %s -> %s change', async (before, after, expected) => {
    const result = await collect(before, after);
    expect(result?.changes.join(';')).toContain(expected);
    expect(result?.checks.join('\n')).toContain(`--base ${'a'.repeat(40)} --files=packages/operator-core/lib/example.ts`);
  });
  it('keeps private body-only edits quiet and combines required-field and behavioural risks', async () => {
    expect(await collect('export function f() { const x = 1; return x; }', 'export function f() { const x = 2; return x; }')).toBeNull();
    const result = await collect('export interface R { x: string }; export function f() { return { ok: 1 }; }',
      'export interface R { x: string; y: number }; export function f() { return { ok: 2 }; }');
    expect(result?.changes).toContain('required R.y');
    expect(result?.changes).toContain('behavioural strand risk');
    expect(result?.checks).toHaveLength(2);
  });
  it('ignores an inner callback return and formatting-only return edits', async () => {
    expect(await collect('export class C { private result() { return { a: 1 }; } }',
      'export class C { private result() { return { b: 1 }; } }')).toBeNull();
    expect(await collect('export function f() { const x = () => ({ a: 1 }); return null; }',
      'export function f() { const x = () => ({ b: 1 }); return null; }')).toBeNull();
    expect(await collect('export function f() { return { a: 1 }; }',
      'export function f() { return { /* note */ a: 1 }; }')).toBeNull();
  });
});

// The REAL detector — the whole value of this suite is that it is not a fake.
async function realDiffer() {
  const mod = await import(`file://${resolve(ROOT, 'scripts/check-required-field-strands.mjs')}`);
  return mod.diffRequiredAdditions as (b: string, a: string, f?: string) => Array<{ path: string; reason: string }>;
}

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    consequenceFor: (p: string, deps?: Record<string, unknown>) => Promise<{ path: string; base: string; changes: string[]; checks: string[];
      sourceChange?: { root: string; path: string; symbols: { name: string; line: number }[]; sha256: string; beforeSha256: string } } | null>;
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    formatNudge: (rel: string, added: Array<{ path: string; reason: string }>) => string;
  };
}

/** Deps that use the REAL differ but inject file content, so no tree write is needed. */
async function depsWith(before: string, after: string) {
  const diff = await realDiffer();
  return {
    exists: () => true,
    sizeOf: () => 100,
    readFile: () => after,
    showHead: () => before,
    loadDiffer: async () => diff,
  };
}

describe('required-field-strand nudge — fires on the real trap', () => {
  it('FIRES when a required field is added to an exported interface, naming the field', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; name: string }'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('Foo.name');
    expect(out).toContain('new required field');
    // It must point at the detector, since KNOWING TO RUN IT is the entire gap.
    expect(out).toContain('check-required-field-strands.mjs --typecheck');
    expect(out).toContain('capability:bash { run_in_background: true }');
    expect(out).toContain('capability:bash_output');
  });

  it('FIRES when an existing field is tightened optional -> required', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id?: string }', 'export interface Foo { id: string }'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('Foo.id');
    expect(out).toContain('optional → required');
  });

  it('FIRES for a required field nested one level down — the 2026-08-02 shape a top-level scan misses', async () => {
    // IssueClaimExclusionBreakdown.excluded.remoteOrigin lived one level down and
    // stranded 27 sites across 2 committed files; a top-level scan reports nothing,
    // which reads exactly like "no trap here".
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith(
        'export interface B { excluded: { a: string } }',
        'export interface B { excluded: { a: string; remoteOrigin: number } }',
      ),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('remoteOrigin');
  });
});

describe('required-field-strand nudge — stays silent when it should', () => {
  it('is SILENT for an ordinary edit that adds no required field', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith(
        'export interface Foo { id: string }',
        'export interface Foo { id: string }\nexport const NOTE = 1;',
      ),
    );
    expect(out).toBeNull();
  });

  it('is SILENT when the new field is OPTIONAL — that strands nothing', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; name?: string }'),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for a brand-new file (no HEAD version) — it has no construction sites yet', async () => {
    const hook = await loadHook();
    const deps = await depsWith('', 'export interface Foo { id: string; name: string }');
    const out = await hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.ts'), {
      ...deps,
      showHead: () => null,
    });
    expect(out).toBeNull();
  });

  it('skips .d.ts without invoking git at all', async () => {
    const hook = await loadHook();
    const deps = await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; n: string }');
    const out = await hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.d.ts'), {
      ...deps,
      showHead: () => {
        throw new Error('git must not be consulted for a .d.ts');
      },
    });
    expect(out).toBeNull();
  });

  it('is not a candidate for non-TS files', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('a/b.ts')).toBe(true);
    expect(hook.isCandidateFile('a/b.tsx')).toBe(true);
    expect(hook.isCandidateFile('a/b.d.ts')).toBe(false);
    expect(hook.isCandidateFile('a/b.mjs')).toBe(false);
  });
});

/**
 * EI-20097325488507587 — the nudge fired correctly and then handed over a verification
 * that silently verified nothing.
 *
 * WHY THIS ONE IS END-TO-END AND THE REST ARE NOT: the property under test is not
 * "the message contains the right substring" but "the command this hook emits still
 * finds the addition AFTER git-sync commits the edit". That is a claim about a
 * different process, run at a later time, against a mutated repository — no assertion
 * over the message text can reach it, which is exactly why four successive filings
 * (EI-19377892307939503, EI-19396116936287206, EI-20095543794921181, this one) each
 * fixed a narrower slice of "the check went green having verified nothing" and left
 * the next slice live.
 *
 * The CONTROL leg is load-bearing, not decoration: it runs the OLD unpinned
 * prescription against the identical repository state and asserts it still prints a
 * green naming only the peer's file. Without it, a passing test would be consistent
 * with the scenario having quietly stopped reproducing, which is the failure mode this
 * whole class is made of.
 */
describe('required-field-strand nudge — the emitted command survives a git-sync sweep', () => {
  it('finds the addition after the edit is swept into HEAD, where the unpinned form goes green', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rfs-sweep-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
      const lib = join(tmp, 'packages/operator-core/lib');
      mkdirSync(lib, { recursive: true });
      mkdirSync(join(tmp, 'scripts/lib'), { recursive: true });
      // The REAL detector, copied at test time so it cannot drift from the one that ships —
      // with its own local imports, or it fails to load and the hook (correctly) fails open
      // to silence, which reads here as "the nudge did not fire".
      // Copy the WHOLE scripts/ tree, never a hand-listed subset (WI-41647). The
      // detector's relative-import closure is transitive AND crosses directories —
      // measured today as SIX files spanning both scripts/ and scripts/lib/:
      // check-required-field-strands -> lib/not-checked, lib/tsc-baseline-gate ->
      // lib/tsc-red-observations AND ../check-declared-deps-extracted ->
      // ../check-peer-dep-conflicts. A hand-maintained list cannot track a graph:
      // it rots silently the moment anyone adds an import, and that is exactly how
      // this test broke (a0095c0959 added ./lib/tsc-baseline-gate.mjs). When the
      // detector fails to load, the hook CORRECTLY fails open to silence, so its
      // empty stdout surfaces here as `Unexpected end of JSON input` at the
      // JSON.parse below — an error naming nothing about the real cause, which is
      // what makes this failure mode so expensive to diagnose. Copying the tree is
      // ~5MB/322 files into a tmpdir and is immune to any future import.
      cpSync(resolve(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      // `typescript` must resolve from the copy; a stub lint-tsc stands in for the
      // typecheck leg, which is NOT what this test is about (it asserts DETECTION).
      symlinkSync(resolve(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      writeFileSync(join(tmp, 'scripts/lint-tsc.mjs'), 'process.exit(0);\n');

      writeFileSync(join(lib, 'mine.ts'), 'export interface Mine { id: string }\n');
      writeFileSync(join(lib, 'peer.ts'), 'export interface Peer { id: string }\n');
      git('init', '-q', '.');
      git('config', 'user.email', 't@t.t');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-qm', 'base');

      // 1. The author adds a required field. 2. The hook fires milliseconds later.
      writeFileSync(join(lib, 'mine.ts'), 'export interface Mine { id: string; hasListing: boolean }\n');
      const hookOut = execFileSync('node', [HOOK], {
        cwd: tmp,
        encoding: 'utf8',
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(lib, 'mine.ts') } }),
      });
      const advisory = JSON.parse(hookOut).hookSpecificOutput.additionalContext as string;
      const emitted = advisory.split('\n').find((l) => l.includes('check-required-field-strands.mjs'))!.trim();
      expect(emitted).toContain('--typecheck');

      // 3. git-sync sweeps the edit into HEAD. 4. A peer leaves unrelated churn dirty.
      git('add', '-A');
      git('commit', '-qm', 'git-sync sweep');
      writeFileSync(join(lib, 'peer.ts'), 'export interface Peer { id: string }\nexport interface Peer2 { id: string }\n');

      // CONTROL: the unpinned form this hook used to prescribe. It must STILL go green
      // naming only the peer's file — otherwise the scenario stopped reproducing and
      // the positive leg below proves nothing.
      const control = execFileSync('node', ['scripts/check-required-field-strands.mjs', '--typecheck'], { cwd: tmp, encoding: 'utf8' });
      expect(control).toContain('✓ no required fields added');
      expect(control).toContain('peer.ts');
      expect(control).not.toContain('hasListing');

      // The command the hook actually emitted, run as emitted, against that swept tree.
      const [bin, ...args] = emitted.split(/\s+/);
      const after = execFileSync(bin, args, { cwd: tmp, encoding: 'utf8' });
      expect(after).toContain('REQUIRED-FIELD ADDITION');
      expect(after).toContain('Mine.hasListing');
      expect(after).toContain('capability:bash { run_in_background: true }');
      expect(after).toContain('capability:bash_output');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('required-field-strand nudge — fails open, never disturbs an edit', () => {
  it('returns null (never throws) when the detector cannot be resolved', async () => {
    const hook = await loadHook();
    const deps = await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; n: string }');
    await expect(
      hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.ts'), { ...deps, loadDiffer: async () => null }),
    ).resolves.toBeNull();
  });

  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
