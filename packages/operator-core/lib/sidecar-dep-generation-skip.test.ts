/**
 * EI-21904084277182116 / D-186 — a vm-release cut must not produce a dependency generation.
 *
 * WHY THIS SUITE EXISTS. D-186 ruled that a pinned release cut runs with
 * PAPERCUSP_SKIP_DEP_GENERATION=1, because the generation is a checkpoint artifact the
 * release path does not consume (it measured ZERO consumers there) while costing ~23 of
 * r14's 24m16s. The ruling was recorded and never mechanized: the whole enforcement was an
 * env var each orchestrator had to remember to export.
 *
 * That is the worst shape a cost regression can take, because it is INVISIBLE IN ITS OWN
 * OUTPUT. A cut that forgot the export did not fail, warn, or degrade — it walked every
 * manifest, copied every tree, and emitted a byte-identical artifact. Nothing downstream
 * could tell the two runs apart. Measured on 2026-08-30, a cut that omitted it spent 6m54s
 * copying 86 trees (11.3 GB read / 15.9 GB written) and the only detector in the system
 * turned out to be a PEER watching host IO pressure, who opened an urgent escalation.
 *
 * A cache hit does not rescue it either: r14's round 2 hit the cache in 266ms and still
 * burned 546s, because the manifest walks dominate.
 *
 * WHAT THIS SUITE PINS, and why it is not just a grep. The rule spans two files — the
 * producer that SETS the variable and the consumer that HONORS it — joined only by a string
 * literal. A source assertion on either half alone passes happily while the other half is
 * renamed, which would restore the exact silent-cost bug with all guards green. So the
 * consumer half is tested BEHAVIOURALLY (call it; prove the publisher is never spawned),
 * the producer half structurally, and one test asserts the literal is the SAME in both.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one string the whole rule hangs on. Stated ONCE so a rename fails loudly. */
const SKIP_VAR = 'PAPERCUSP_SKIP_DEP_GENERATION';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-desktop-sidecar.sh above this test)',
  );
}

const ROOT = repoRoot();

/** Subject paths, overridable so a mutation probe can aim this suite at a COPY. */
const PRODUCER_PATH =
  process.env.PAPERCUSP_DEP_SKIP_PRODUCER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
const CONSUMER_PATH =
  process.env.PAPERCUSP_DEP_SKIP_CONSUMER_PATH?.trim() ||
  join(ROOT, 'scripts', 'npm-install-safe.mjs');

/**
 * The BEHAVIOURAL tests must import the consumer from its real location, never from a
 * relocated copy: npm-install-safe.mjs resolves `./lib/fs-mutex.mjs` and
 * `./check-declared-deps-extracted.mjs` RELATIVE to itself, so a copy in a scratch dir
 * cannot even be imported. Found the hard way — a copy-out mutation probe reported
 * COPY-BASELINE FAILED against the UNMUTATED copy, which is the probe correctly refusing
 * to score a mutant when the instrument is broken rather than the subject.
 *
 * So the two families deliberately take different paths: text/structural assertions honour
 * the override (a probe can aim them at a mutated copy), and the import-based ones do not.
 */
const CONSUMER_IMPORT_PATH = join(ROOT, 'scripts', 'npm-install-safe.mjs');

/** Comments never count — a rule a comment can satisfy is not a rule. */
function codeOnlyLines(src: string): { line: string; index: number }[] {
  return src
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !/^\s*#/.test(line) && !/^\s*\/\//.test(line));
}

function firstCodeIndex(src: string, needle: RegExp): number {
  const hit = codeOnlyLines(src).find(({ line }) => needle.test(line));
    return hit ? hit.index : -1;
}

/**
 * First code line matching `needle` AT OR AFTER line `start`. The ordering pin
 * below asks about the mutex INSIDE publishDependencyGeneration, and a whole-file
 * search answered about whichever `withFsMutexRead(` came first in the file —
 * since 2026-09-04 that is the `withPackageCacheReadLease` helper defined ~50 lines
 * ABOVE the function, which made the pin read "mutex before skip" on a consumer
 * that still checks the skip first.
 */
function firstCodeIndexFrom(src: string, start: number, needle: RegExp): number {
  const hit = codeOnlyLines(src).find(({ line, index }) => index >= start && needle.test(line));
  return hit ? hit.index : -1;
}

let producer = '';
let consumer = '';

beforeAll(() => {
  producer = readFileSync(PRODUCER_PATH, 'utf8');
  consumer = readFileSync(CONSUMER_PATH, 'utf8');
});

describe('D-186 — a vm-release cut skips dependency generation', () => {
  describe('the consumer actually honors the switch (behavioural)', () => {
    it('returns without ever spawning the generation publisher when the skip is set', async () => {
      const mod = await import(CONSUMER_IMPORT_PATH);
      const calls: unknown[][] = [];
      const runPublisher = (...args: unknown[]) => {
        calls.push(args);
        return { status: 0 };
      };

      const status = await mod.publishDependencyGeneration({
        repoRoot: ROOT,
        runPublisher,
        env: { [SKIP_VAR]: '1' },
      });

      expect(status).toBe(0);
      // The whole point of D-186 is that this is a CLEAN no-op, not a cheaper mode:
      // nothing is spawned, and (asserted structurally below) no lock is even taken.
      expect(calls).toHaveLength(0);
    });

    it('CONTROL: without the skip it DOES reach the publisher — so the test above is not vacuous', async () => {
      const mod = await import(CONSUMER_IMPORT_PATH);
      const calls: unknown[][] = [];
      const runPublisher = (...args: unknown[]) => {
        calls.push(args);
        return { status: 0 };
      };

      // A throwaway root, so the repo-keyed install mutex this path takes is uncontended
      // and cannot block behind a live agent install (WI-41180: a sync spawn / unbounded
      // wait inside the pure lane wedges the shared fork).
      const scratch = mkdtempSync(join(tmpdir(), 'dep-gen-skip-'));
      try {
        await mod.publishDependencyGeneration({
          repoRoot: scratch,
          runPublisher,
          env: {},
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }

      expect(calls.length).toBeGreaterThan(0);
      const [command, args] = calls[0] as [string, string[]];
      expect(command).toBe('bash');
      expect(args[0]).toMatch(/dependency-generation\.sh$/);
    });

    it('checks the skip BEFORE taking the install mutex, so it costs nothing', () => {
      // Scope both probes to publishDependencyGeneration's body: the consumer also
      // defines withPackageCacheReadLease (a different, host-wide cache lease) ABOVE
      // it, and a whole-file "first withFsMutexRead(" would pin THAT helper's line.
      const fnAt = firstCodeIndex(consumer, /export async function publishDependencyGeneration\b/);
      expect(fnAt, `publishDependencyGeneration not found in ${CONSUMER_PATH}`).toBeGreaterThan(-1);
      const skipAt = firstCodeIndexFrom(consumer, fnAt, new RegExp(`${SKIP_VAR}[^\\n]*return 0`));
      const mutexAt = firstCodeIndexFrom(consumer, fnAt, /withFsMutexRead\(/);

      expect(skipAt, `${SKIP_VAR} early-return not found in ${CONSUMER_PATH}`).toBeGreaterThan(-1);
      expect(mutexAt, 'withFsMutexRead call not found').toBeGreaterThan(-1);
      expect(skipAt).toBeLessThan(mutexAt);
    });

    it('CONTROL: the scoped probe still fails a consumer that takes the mutex first', () => {
      // Guards the probe itself: with the mutex hoisted above the skip inside the
      // function, the ordering assertion must trip — otherwise the pin is vacuous.
      const mutant = [
        'export function withPackageCacheReadLease(fn) {',
        '  return withFsMutexRead("cache", fn);',
        '}',
        'export async function publishDependencyGeneration({ env } = {}) {',
        '  const result = await withFsMutexRead(lockName, () => 0);',
        `  if (env.${SKIP_VAR} === "1") return 0;`,
        '  return result;',
        '}',
      ].join('\n');
      const fnAt = firstCodeIndex(mutant, /export async function publishDependencyGeneration\b/);
      const skipAt = firstCodeIndexFrom(mutant, fnAt, new RegExp(`${SKIP_VAR}[^\\n]*return 0`));
      const mutexAt = firstCodeIndexFrom(mutant, fnAt, /withFsMutexRead\(/);
      expect(fnAt).toBeGreaterThan(-1);
      expect(mutexAt).toBeGreaterThan(fnAt); // the helper's line ABOVE the function is not counted
      expect(skipAt).toBeGreaterThan(mutexAt); // and the mutant IS caught
    });
  });

  describe('the producer sets it, so no caller has to remember D-186', () => {
    it('exports it inside the vm-release branch, in code rather than a comment', () => {
      const lines = producer.split('\n');
      const exportLine = firstCodeIndex(producer, new RegExp(`export ${SKIP_VAR}=`));
      // The producer has several top-level vm-release blocks; the export must sit
      // in the one that encloses it. An opener may WIDEN the condition with a
      // `||` continuation (94f1495b: `|| PAPERCUSP_RELEASE_AUDIT == 1`), never
      // narrow it with `&&`, so every vm-release cut still exports the skip.
      const isVmReleaseOpener = (i: number) =>
        /^if \[\[ "\$DISTRIBUTION_PROFILE" == "vm-release" \]\]; then/.test(lines[i]) ||
        (/^if \[\[ "\$DISTRIBUTION_PROFILE" == "vm-release" \\$/.test(lines[i]) &&
          /^\s+\|\| .*\]\]; then\s*$/.test(lines[i + 1] ?? ''));
      let gateAt = -1;
      for (let i = 0; i < lines.length && (exportLine < 0 || i < exportLine); i++) {
        if (isVmReleaseOpener(i)) gateAt = i;
      }
      expect(gateAt, 'vm-release gate block not found').toBeGreaterThan(-1);

      // The top-level block closes at the next column-0 `fi`.
      let closeAt = -1;
      for (let i = gateAt + 1; i < lines.length; i++) {
        if (/^fi\s*$/.test(lines[i])) {
          closeAt = i;
          break;
        }
      }
      expect(closeAt, 'vm-release gate block never closes').toBeGreaterThan(gateAt);

      const exportAt = firstCodeIndex(producer, new RegExp(`export ${SKIP_VAR}=`));
      expect(
        exportAt,
        `${SKIP_VAR} is not exported in executable code — a comment does not enforce D-186`,
      ).toBeGreaterThan(-1);
      expect(exportAt).toBeGreaterThan(gateAt);
      expect(exportAt).toBeLessThan(closeAt);
    });

    it('defaults to 1 but stays overridable, so an opt-in is deliberate rather than impossible', () => {
      const line = codeOnlyLines(producer).find(({ line: l }) =>
        new RegExp(`export ${SKIP_VAR}=`).test(l),
      )?.line;
      expect(line).toBeTruthy();
      // `${VAR:-1}` — on by default, and a caller that genuinely wants a generation sets 0.
      // A hardcoded `=1` would make the escape hatch unreachable; a `:-0` would silently
      // restore the bug.
      expect(line).toMatch(new RegExp(`\\$\\{${SKIP_VAR}:-1\\}`));
    });

    it('sets it before the first npm-install-safe invocation, which is what would produce one', () => {
      const exportAt = firstCodeIndex(producer, new RegExp(`export ${SKIP_VAR}=`));
      // A shell function DEFINITION that mentions the installer runs nothing at
      // its definition site; only top-level code (including call lines that
      // pass npm-install-safe.mjs to such a function) can publish a generation.
      const srcLines = producer.split('\n');
      const inFunctionBody = new Set<number>();
      for (let i = 0; i < srcLines.length; i++) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{\s*$/.test(srcLines[i])) {
          let j = i + 1;
          while (j < srcLines.length && !/^\}\s*$/.test(srcLines[j])) inFunctionBody.add(j++);
          i = j;
        }
      }
      const installAt =
        codeOnlyLines(producer).find(
          ({ line, index }) => !inFunctionBody.has(index) && /npm-install-safe\.mjs/.test(line),
        )?.index ?? -1;

      expect(installAt, 'producer never invokes npm-install-safe.mjs').toBeGreaterThan(-1);
      expect(
        exportAt,
        'the skip is exported AFTER an install could already have published a generation',
      ).toBeLessThan(installAt);
    });
  });

  it('joins both halves on the same literal, so renaming either one fails here', () => {
    // This is the test that a per-file grep cannot replace. Producer and consumer agree
    // only by string; if one is renamed the rule silently stops applying while every
    // single-file assertion still passes.
    expect(producer).toContain(SKIP_VAR);
    expect(consumer).toContain(SKIP_VAR);
  });
});
