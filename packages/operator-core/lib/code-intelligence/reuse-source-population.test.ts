import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { collectReuseSourcePopulation, createReuseCallColumns, decodeReuseCallColumns,
  serializeReuseCallColumns, summarizeReuseCallColumns } from './reuse-source-population';
import { collectReuseSourcePopulationOffthread } from './reuse-measurement';

const repo = resolve(__dirname, '../../../..');

describe('lossless finite-worker call columns', () => {
  it('preserves every exact call identity and target across block boundaries while yielding', async () => {
    const columns = createReuseCallColumns();
    const expected = Array.from({ length: 16_386 }, (_, i) => {
      const from = i % 2 ? 'odd:é.ts' : 'a.ts', to = i % 3 ? 'b.ts' : null;
      columns.sink({ path: from, line: i + 1, column: 22 }, to, i);
      return { id: `${from}:${i + 1}:22:${i}`, from, to, resolved: to !== null };
    });
    const wire = columns.finish();
    expect(wire.blocks).toHaveLength(2);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    expect(await decodeReuseCallColumns(wire)).toEqual(expected);
    expect(yielded).toBe(true);
    expect(await decodeReuseCallColumns(JSON.parse(JSON.stringify(serializeReuseCallColumns(wire))))).toEqual(expected);
  });
  it('remeasures a lossless persisted census whose expanded paths exceed the V8 string limit', () => {
    const columns = createReuseCallColumns();
    const path = 'long-module/'.repeat(800) + 'a.ts';
    const count = 80_000;
    for (let i = 0; i < count; i++) columns.sink({ path, line: i + 1, column: 1 }, i % 2 ? path : 'b.ts', i);
    // Even the from/to strings alone exceed the string limit; never allocate
    // that expanded JSON to reproduce an avoidable host OOM in the guard.
    expect(path.length * count).toBeGreaterThan(536_870_888);
    const stored = JSON.stringify(serializeReuseCallColumns(columns.finish()));
    expect(stored.length).toBeLessThan(2_000_000);
    expect(summarizeReuseCallColumns(JSON.parse(stored))).toEqual({ count, resolved: count, crossFile: count / 2 });
    const corrupt = JSON.parse(stored);
    corrupt.blocks[0] = corrupt.blocks[0].slice(1);
    expect(() => summarizeReuseCallColumns(corrupt)).toThrow('Invalid call census columns');
  });
  it('rejects missing, unknown, truncated and invalid call transports', async () => {
    const empty = createReuseCallColumns().finish();
    expect(await decodeReuseCallColumns(empty)).toEqual([]);
    for (const invalid of [undefined, { ...empty, encoding: 'unknown' }, { ...empty, count: 1 },
      { ...empty, blocks: [new Uint32Array([0, 0, 1])] },
      { ...empty, paths: ['a.ts'], count: 1, blocks: [new Uint32Array([1, 0, 1, 1])] },
      { ...empty, paths: ['a.ts'], count: 1, blocks: [new Uint32Array([0, 2, 1, 1])] },
      { ...empty, paths: ['a.ts'], count: 1, blocks: [new Uint32Array([0, 0, 0, 1])] },
    ]) await expect(decodeReuseCallColumns(invalid)).rejects.toThrow('Invalid call census columns');
    expect(() => createReuseCallColumns().sink({ path: 'a.ts', line: 1, column: 1 }, null, 1)).toThrow();
  });
});

describe('finite code-intelligence worker source collection', () => {
  let dir: string;
  let worker: string;
  let inputs: string[];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reuse-source-bundle-'));
    worker = join(dir, 'first-party-callers.worker.mjs');
    const banner = execFileSync('bash', ['-c', 'source "$1"; printf "%s" "$HOST_BANNER"',
      'worker-test', join(repo, 'apps/operator/bin/bundle-host-common.sh')], { encoding: 'utf8' });
    const result = await build({
      absWorkingDir: repo,
      entryPoints: ['packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts'],
      outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
      banner: { js: banner }, define: { __dirname: '__pc_dirname', __filename: '__pc_filename' },
    });
    inputs = Object.keys(result.metafile!.inputs).map(path => relative(repo, resolve(repo, path)).replaceAll('\\', '/'));
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('captures a small-file census without starting Git once per tiny identity batch', async () => {
    const root = join(dir, 'many-small-sources'), trace = join(dir, 'small-source-git.jsonl');
    execFileSync('git', ['init', '-q', root]);
    const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    writeFileSync(join(root, 'base.ts'), 'export const base = 1;\n');
    git('2026-10-01T00:00:00Z', 'add', '.');
    git('2026-10-01T00:00:00Z', 'commit', '-qm', 'baseline');
    const paths = Array.from({ length: 300 }, (_, i) => `source-${i}.ts`);
    for (const [i, path] of paths.entries()) writeFileSync(join(root, path), `export function target${i}() {} target${i}();\n`);
    git('2026-10-01T01:00:00Z', 'add', '.');
    git('2026-10-01T01:00:00Z', 'commit', '-qm', 'small source population');
    const child = fork(worker, [], { execArgv: [], serialization: 'advanced',
      env: { ...process.env, GIT_TRACE2_EVENT: trace }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const result: any = await new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => reject(new Error('Small-source census deadline: ' + stderr)), 15_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error('Small-source worker exited: ' + code + ': ' + stderr)); });
        child.on('message', (value: any) => {
          if (value?.kind !== 'reuse-source-population') return;
          clearTimeout(timer); resolveResult(value);
        });
        child.send({ kind: 'reuse-source-population', root, start: '2026-10-01T00:30:00Z', end: '2026-10-01T01:30:00Z', captureRoot: dir });
      });
      expect(result.ok, result.error ?? stderr).toBe(true);
      expect(result.population.method.sourcePopulation).toEqual(['base.ts', ...paths].sort());
      expect(result.population.calls).toHaveLength(paths.length);
      expect(result.population.calls.every((call: any) => call.resolved && call.from === call.to)).toBe(true);
      const captures = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(event => event.event === 'start' && event.argv?.includes('cat-file') && event.argv.includes('--batch'));
      expect(captures).toHaveLength(1);
    } finally { child.kill(); }
  });

  it('keeps operator initialization, fixture payloads and database clients outside the emitted worker', () => {
    const operatorInputs = inputs.filter(path => path.startsWith('packages/operator-core/lib/'));
    expect(operatorInputs).toContain('packages/operator-core/lib/code-intelligence/reuse-source-population.ts');
    expect(operatorInputs.filter(path => !path.startsWith('packages/operator-core/lib/code-intelligence/'))).toEqual([]);
    expect(inputs.some(path => /(?:^|\/)db-org\//.test(path))).toBe(false);
    expect(readFileSync(worker, 'utf8')).not.toContain('sourceGraphQualification');
  });

  it('collects the same committed Git window inline, over plain Node IPC and through the public wrapper', async () => {
    const root = join(dir, 'source');
    execFileSync('git', ['init', '-q', root]);
    const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    writeFileSync(join(root, 'a.ts'), 'export const base = 1;\n');
    const longPath = 'odd [é].ts', longComment = '// ' + 'é'.repeat(40_000);
    writeFileSync(join(root, longPath), longComment + '\nexport const old = 1;\n');
    git('2026-10-01T00:00:00Z', 'add', '.');
    git('2026-10-01T00:00:00Z', 'commit', '-qm', 'base');
    writeFileSync(join(root, 'a.ts'), 'export function target() { return 1; }\ntarget();\n');
    // Changed payload spans stream chunks, and a multibyte/pathspec-looking
    // identity must remain attached to its exact zero-context hunk lines.
    writeFileSync(join(root, longPath), longComment + ' changed\nexport const fresh = 2;\n');
    git('2026-10-01T01:00:00Z', 'add', '.');
    git('2026-10-01T01:00:00Z', 'commit', '-qm', 'change');
    // Mutable working-tree bytes must not enter the historical population.
    writeFileSync(join(root, 'a.ts'), 'uncommitted();\n');
    const child = fork(worker, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const result = await new Promise<Record<string, any>>((resolveResult, reject) => {
        const timer = setTimeout(() => reject(new Error('worker source collection timed out: ' + stderr)), 10_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error('worker exited before answer: ' + code + ': ' + stderr)); });
        child.on('message', (value: any) => {
          if (value?.kind !== 'reuse-source-population') return;
          clearTimeout(timer); resolveResult(value);
        });
        child.send({ kind: 'reuse-source-population', root, start: '2026-10-01T00:30:00Z', end: '2026-10-01T01:30:00Z', captureRoot: dir });
      });
      expect(result.ok, result.error ?? stderr).toBe(true);
      expect(result.population).toMatchObject({ addedNonGeneratedLines: 4, duplicateAddedLines: 0,
        lineCensusComplete: true, callCensusComplete: true, method: { sourcePopulation: ['a.ts', longPath],
          addedLinePopulation: [{ path: 'a.ts', lines: [1, 2] }, { path: longPath, lines: [1, 2] }] } });
      expect(result.population.calls).toEqual([expect.objectContaining({ from: 'a.ts', to: 'a.ts', resolved: true })]);
      const start = '2026-10-01T00:30:00Z', end = '2026-10-01T01:30:00Z';
      const inline = await collectReuseSourcePopulation(root, start, end, dir);
      expect(result.population).toEqual(inline);
      // Exercise the public supervisor against these emitted working-tree bytes.
      // A source-loader fallback could otherwise test a different committed worker.
      const offthread = await collectReuseSourcePopulationOffthread(root, start, end, { workerPath: worker });
      expect(offthread).toEqual(inline);
    } finally { child.kill(); }
  });

  it('retains exact hunk identities across modified report bodies exceeding one diff batch', async () => {
    const root = join(dir, 'large-modified');
    execFileSync('git', ['init', '-q', root]);
    const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    const payload = 'x'.repeat(17 * 1024 * 1024);
    writeFileSync(join(root, 'a.ts'), 'export function target() {}\ntarget();\n');
    for (const file of ['one.md', 'two.md']) writeFileSync(join(root, file), payload + ' old\nstable\n');
    git('2026-10-01T00:00:00Z', 'add', '.'); git('2026-10-01T00:00:00Z', 'commit', '-qm', 'base');
    for (const file of ['one.md', 'two.md']) writeFileSync(join(root, file), payload + ' new\nstable\n');
    git('2026-10-01T01:00:00Z', 'add', '.'); git('2026-10-01T01:00:00Z', 'commit', '-qm', 'change');
    const result = await collectReuseSourcePopulation(root, '2026-10-01T00:30:00Z', '2026-10-01T01:30:00Z', dir);
    expect(result.addedNonGeneratedLines).toBe(2);
    expect(result.lineCensusComplete).toBe(false);
    expect(result.callCensusComplete).toBe(true);
    expect(result.method.sourcePopulation).toEqual(['a.ts']);
    expect(result.method.addedLinePopulation).toEqual([
      { path: 'one.md', lines: [1] }, { path: 'two.md', lines: [1] },
    ]);
    expect(result.calls).toEqual([expect.objectContaining({ from: 'a.ts', to: 'a.ts', resolved: true })]);
  });

  it('pipelines immutable capture and parsing with diff collection, preserving serial resolution and ordered identities', async () => {
    const root = join(dir, 'partitioned');
    execFileSync('git', ['init', '-q', root]);
    const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    for (let i = 0; i < 1025; i++) writeFileSync(join(root, `f${String(i).padStart(4, '0')}.ts`), `export const value${i} = ${i};\n`);
    writeFileSync(join(root, 'f0000.ts'), 'import { alias } from "./f0700"; alias(); new (factory())();\n');
    writeFileSync(join(root, 'f0500.ts'), 'export function target() {} target();\n');
    writeFileSync(join(root, 'f0700.ts'), 'export {target as alias} from "./f0500"; export * from "./f0900";\n');
    writeFileSync(join(root, 'f0900.ts'), 'export * from "./f0700"; new (unknown())();\n');
    writeFileSync(join(root, 'f1000.ts'), 'function broken(');
    const parserExcluded = ['_retired/legacy.ts', '.materialized/generated.ts'];
    for (const path of parserExcluded) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'export function excluded() {} excluded();\n');
    }
    // A run of large files must split by bytes even though it fits the old
    // 512-identity chunk. Keep the independently computed serial oracle below.
    for (let i = 100; i < 108; i++) {
      const path = join(root, `f${String(i).padStart(4, '0')}.ts`);
      writeFileSync(path, `/*${'x'.repeat(1024 * 1024)}*/\n` + readFileSync(path, 'utf8'));
    }
    git('2026-10-01T00:00:00Z', 'add', '.'); git('2026-10-01T00:00:00Z', 'commit', '-qm', 'base');
    writeFileSync(join(root, 'f1024.ts'), 'import {target} from "./f0500"; target();\n');
    git('2026-10-01T01:00:00Z', 'add', '.'); git('2026-10-01T01:00:00Z', 'commit', '-qm', 'change');
    const start = '2026-10-01T00:30:00Z', end = '2026-10-01T01:30:00Z';
    const serial = await collectReuseSourcePopulation(root, start, end, dir);
    expect(serial.method.sourcePopulation).toEqual(expect.arrayContaining(parserExcluded));
    expect(serial.calls.some(call => parserExcluded.includes(call.from))).toBe(false);
    const instrumented = join(dir, 'partition-observed.worker.mjs'), marker = join(dir, 'parser-lifetime.json');
    const banner = execFileSync('bash', ['-c', 'source "$1"; printf "%s" "$HOST_BANNER"',
      'worker-test', join(repo, 'apps/operator/bin/bundle-host-common.sh')], { encoding: 'utf8' });
    await build({ absWorkingDir: repo, entryPoints: ['packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts'],
      outfile: instrumented, bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: banner },
      define: { __dirname: '__pc_dirname', __filename: '__pc_filename' }, plugins: [{ name: 'observe-parser-lifecycle', setup(builder) {
        builder.onLoad({ filter: /first-party-callers\.worker\.ts$/ }, args => {
          let source = readFileSync(args.path, 'utf8');
          const site = '      parentPort!.postMessage({ index, parsed });';
          if (!source.includes(site)) throw new Error('Parser observation site moved');
          source = source.replace(site, `      if (index === 0) setTimeout(() => parentPort!.postMessage({ index, parsed }), 800);
            else parentPort!.postMessage({ index, parsed });`);
          source = source.replace('    try {\n      const parsed', `    if (index === 0) {
              markWrite(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, source: [...sourceFiles.values()][0]}));
              if (process.env.P019_TEST_CASE === 'error') process.exit(27);
              if (process.env.P019_TEST_CASE === 'missing') { parentPort!.postMessage({index: index + 1, parsed: {}}); return; }
              if (process.env.P019_TEST_CASE === 'timeout') { setInterval(() => {}, 1000); return; }
            }
            try {\n      const parsed`);
          return { contents: `import {writeFileSync as markWrite} from 'node:fs';\n` + source, loader: 'ts' };
        });
        builder.onLoad({ filter: /reuse-source-population\.ts$/ }, args => {
          const source = readFileSync(args.path, 'utf8');
          const site = "    onProgress?.('source-diff');";
          if (!source.includes(site)) throw new Error('Diff overlap observation site moved');
          // Hold the independent diff until parsing starts. Serial scheduling
          // fails here; the complete ordered result must still match its oracle.
          const captureSite = "      const out = await gitBytes(['cat-file', '--batch'],";
          if (!source.includes(captureSite)) throw new Error('Capture overlap observation site moved');
          const pipelined = source.replace('batch.length < 4096', 'batch.length < 256').replace(captureSite, `
            if (i > batch.length) {
              const captureDeadline = Date.now() + 3000;
              while (!overlapExists(${JSON.stringify(marker)})) {
                if (Date.now() > captureDeadline) throw new Error('Source parser did not overlap blob capture');
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              if (process.env.P019_TEST_CASE === 'capture') throw new Error('Injected blob capture failure');
            }
${captureSite}`);
          return { contents: `import {existsSync as overlapExists} from 'node:fs';\n` + pipelined.replace(site, `${site}
            const overlapDeadline = Date.now() + 3000;
            while (!overlapExists(${JSON.stringify(marker)})) {
              if (Date.now() > overlapDeadline) throw new Error('Source parser did not overlap diff collection');
              await new Promise(resolve => setTimeout(resolve, 10));
            }`), loader: 'ts' };
        });
      } }] });
    const child = fork(instrumented, [], { execArgv: ['--max-old-space-size=1024'], serialization: 'advanced',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const observations: any[] = [];
    try {
      const result: any = await new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => reject(new Error('Partition parity deadline')), 15_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('message', (message: any) => {
          if (message.parserLimits) observations.push(message.parserLimits);
          if (message.kind === 'reuse-source-population') { clearTimeout(timer); resolveResult(message); }
        });
        child.send({ kind: 'reuse-source-population', root, start, end, captureRoot: dir });
      });
      expect(result.ok, result.error).toBe(true);
      expect(result.population).toEqual(serial);
      const partitions = observations.filter(x => x.kind === 'partition').map(x => x.index);
      expect(partitions.indexOf(1)).toBeLessThan(partitions.indexOf(0));
      expect([...partitions].sort()).toEqual([0, 1, 2, 3]);
      const chunks = observations.filter(x => x.kind === 'partition');
      expect(chunks.every(x => x.bytes <= 4 * 1024 * 1024 && x.files <= 512)).toBe(true);
      expect(chunks.reduce((sum, x) => sum + x.files, 0)).toBe(1027);
      const limits = observations.filter(x => x.kind === 'ready');
      expect(limits).toHaveLength(2);
      expect(limits.every(x => x.oldSpaceMb === 1024 && x.heapLimitMb <= 1056
        && !x.execArgv.some((flag: string) => /max[-_]old[-_]space/.test(flag)))).toBe(true);
      expect(result.population.calls.some((call: any) => call.from === 'f0000.ts' && call.to === 'f0500.ts')).toBe(true);
      expect(result.population.callCensusComplete).toBe(false);
    } finally { child.kill(); }
    const previous = process.env.P019_TEST_CASE;
    try {
      for (const fault of ['error', 'missing', 'timeout', 'capture']) {
        process.env.P019_TEST_CASE = fault;
        const failure = await collectReuseSourcePopulationOffthread(root, start, end,
          { workerPath: instrumented, heapMb: 3072, budgetMs: fault === 'timeout' ? 3000 : 15_000 })
          .then(() => null, error => error as Error);
        expect(failure, `fault=${fault}`).toBeInstanceOf(Error);
        expect(failure!.message, `fault=${fault}`).toMatch(fault === 'timeout' ? /deadline/ : fault === 'capture' ? /capture/i : /parser/i);
        const lifetime = JSON.parse(readFileSync(marker, 'utf8'));
        expect(existsSync(dirname(dirname(lifetime.source)))).toBe(false);
        expect(() => process.kill(lifetime.pid, 0)).toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env.P019_TEST_CASE; else process.env.P019_TEST_CASE = previous;
    }
  }, 40_000);
});
