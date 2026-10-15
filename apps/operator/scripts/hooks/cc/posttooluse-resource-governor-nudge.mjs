#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-resource-governor-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the capless resource-governor
// policy guard (scripts/check-resource-governor-enforcement.mjs). WI-10007553.
//
// THE TRAP
//   The guard is an AFFECTED_GUARD in scripts/affected-tests.mjs: every gate run that
//   touches apps/, packages/ or scripts/ source runs it over the WHOLE tree. So one
//   edit that adds an unreviewed resource start (a spawn/execFile/fork/new Worker
//   outside Governor.admit), or that drifts a reviewed row's pinned source, turns the
//   gate red for EVERY lane, not only the author's. Its first observer has been the
//   fleet gate rather than the author: measured 2026-10-08 (WI-10007542), four
//   unrelated files broke it within ~12h (tauri-surface-verify-reports.mts 04:51Z,
//   per-use-chokepoint.ts 13:31Z, dependency-generation-retention.ts 13:58Z,
//   pg-url.mjs 17:06Z, the last landing while the first three were being fixed).
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   Finding the violation was never the hard part: the guard is exact and cheap. The
//   gap is the MOMENT it runs. This hook runs the guard's own `scanInventory` on the
//   ONE edited file (no tree walk), while the fix is still a few lines in a file the
//   author has open. The detector is imported, never re-implemented, so the nudge
//   cannot drift quiet on a shape the gate still reports.
//
// WHAT IT REPORTS (each only when THIS edit introduced it — see the HEAD diff below)
//   - an UNREVIEWED finding: a policy violation with no BYPASS_REGISTRY row;
//   - a PIN BREAK: a reviewed row exists, but its `matchesSource` pin no longer
//     accepts the edited source (the row reviewed different code than is there now);
//   - a STALE ROW: the edit removed the finding a reviewed row disposes of. The gate
//     validates the registry strictly, so a row whose finding is gone is itself red.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to.
//   - REPORTS ONLY WHAT THE GATE WOULD REPORT: it calls the gate's scanInventory with
//     the gate's registry, so a nudge here is a red there, not a suspicion.
//   - Only NEW findings fire. A finding already present in the HEAD version was
//     reported on the edit that introduced it; re-nudging trains the reader to ignore
//     the hook. Keyed by the exact finding string, so a SECOND violation still fires.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an
//     unloadable detector. A bug here must never disturb an edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-resource-governor-enforcement.mjs');

/** Scanning two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 600_000;

const STALE_PREFIX = 'stale-bypass-registry:';

/** One-line remedy per detector code. Unknown codes fall back to the generic remedy. */
export const REMEDY = Object.freeze({
  'resource-start-outside-admission':
    'route the child/worker start through runGovernedOperation / Governor.admit (keep its AdmissionContext and release), or, if it starts no independently managed capacity, add a reviewed row with a pinned matchesSource',
  'hidden-or-static-capacity':
    'delete the numeric cap / semaphore and let admission govern capacity; a genuine physical or upstream constraint needs that stated as writer evidence',
  'unbounded-resident-queue':
    'back the queue with a durable source (work_items / DBOS / a receipt), or add a reviewed row explaining why the collection is per-call and bounded',
  'retry-around-receipt': 'do not wrap a receipt write in a retry loop; the receipt must be written exactly once',
  'missing-admission-context-or-release':
    'governor.admit needs an AdmissionContext and a matching .release() path on every exit',
  'undefined-partial-or-stale-metric-coerced-to-zero':
    'publish unknown/partial/stale as such; never coerce it to 0',
});
const GENERIC_REMEDY =
  'fix the violation, or add a reviewed row with a pinned matchesSource (see the guard\'s failure text)';

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `import.meta.url === pathToFileURL(process.argv[1]).href` (inlined into a bundle,
 * every module inherits the bundle entry's import.meta.url). Same shape as the
 * registry-census-drift sibling; scripts/check-no-hand-rolled-cli-entry.mjs.
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return (
    typeof entryPath === 'string' &&
    /(?:^|[\\/])posttooluse-resource-governor-nudge\.mjs$/.test(entryPath)
  );
}

if (isDirectCliInvocation()) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = await nudgeFor(filePath);
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/**
 * True for a file the gate's scanTree() would scan: .ts/.tsx/.mts/.mjs, not a
 * test/spec, not a declaration, not retired, not vendored. Kept in step with
 * scanTree's own filter so the nudge never inspects a file the gate skips.
 */
export function isCandidateFile(filePath) {
  const norm = filePath.split(sep).join('/');
  if (!/\.(?:ts|tsx|mts|mjs)$/.test(norm)) return false;
  if (/\.d\.m?ts$/.test(norm)) return false;
  if (/\.(?:test|spec)\./.test(norm)) return false;
  if (norm.includes('/_retired/')) return false;
  if (/(?:^|\/)node_modules\//.test(norm)) return false;
  return true;
}

/** Walk up from the edited file to the directory holding the detector, or null. */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, DETECTOR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Lanes (inventory rows) whose path prefixes cover relPath. */
function lanesFor(detector, relPath) {
  return detector.RESOURCE_GOVERNOR_INVENTORY.filter((row) =>
    row.paths.some((prefix) => relPath.startsWith(prefix)),
  );
}

/**
 * The existing reviewed row closest to relPath for the same code: longest common
 * path prefix wins. It is the template an author copies, so naming it saves a search
 * through a 3,000-line file.
 */
export function nearestRowKey(registry, relPath, code) {
  let best = null;
  let bestLen = -1;
  for (const key of registry.keys()) {
    const sepAt = key.lastIndexOf('::');
    if (key.slice(sepAt + 2) !== code) continue;
    const path = key.slice(0, sepAt);
    let n = 0;
    while (n < path.length && n < relPath.length && path[n] === relPath[n]) n++;
    if (n > bestLen) {
      bestLen = n;
      best = key;
    }
  }
  return best;
}

/**
 * Classify one scanInventory finding string for relPath. Shapes (the gate's own):
 *   `${path}:${code}`                                   uncleared finding
 *   `stale-bypass-registry:${path}::${code}:finding-absent`
 */
export function classify(finding, relPath, registry) {
  if (finding.startsWith(STALE_PREFIX)) {
    const rest = finding.slice(STALE_PREFIX.length);
    const key = rest.replace(/:finding-absent$/, '');
    return { kind: 'stale', key, code: key.slice(key.lastIndexOf('::') + 2) };
  }
  const code = finding.slice(relPath.length + 1);
  const key = `${relPath}::${code}`;
  return { kind: registry.has(key) ? 'pin-break' : 'unreviewed', key, code };
}

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, items, { p016Lane, laneIds }) {
  const where = p016Lane
    ? 'P016_REVIEWED_DISPOSITIONS (this path is in a P-016 lane; its test pins that registry\'s size to the observed P-016 findings)'
    : 'the BYPASS_REGISTRY tail (this path is outside the P-016 lanes)';
  const lines = [
    '⚠ RESOURCE-GOVERNOR GUARD — this edit makes scripts/check-resource-governor-enforcement.mjs fail.',
    `  ${relPath}   (lane: ${laneIds.join(', ')})`,
  ];
  for (const it of items) {
    if (it.kind === 'unreviewed') {
      lines.push(`    • ${it.code} — no reviewed row covers it`);
      lines.push(`        fix: ${REMEDY[it.code] ?? GENERIC_REMEDY}`);
      lines.push(`        a reviewed row goes in ${where}`);
      if (it.template) lines.push(`        nearest existing row to copy: ${it.template}`);
    } else if (it.kind === 'pin-break') {
      lines.push(`    • ${it.code} — a reviewed row exists, but its matchesSource pin rejects the edited source`);
      lines.push(`        row: ${it.key}`);
      lines.push('        the review covered different code than is there now: re-review the change and update the');
      lines.push('        row\'s reason and pin together (or route the new start through admission instead)');
    } else {
      lines.push(`    • ${it.code} — the edit REMOVED the finding a reviewed row disposes of (stale row)`);
      lines.push(`        row: ${it.key}`);
      lines.push('        the gate validates the registry strictly, so delete the row (in a P-016 lane, the');
      lines.push('        P016_REVIEWED_DISPOSITIONS entry) in the same change');
    }
  }
  lines.push(
    '',
    '  This guard is an AFFECTED_GUARD: left alone it reds the fleet green-checkpoint for every lane,',
    '  not just yours (WI-10007542 measured four such breaks in one day). Fixing it now is a few lines',
    '  in a file you already have open.',
    '',
    '  Confirm with:',
    '    node scripts/check-resource-governor-enforcement.mjs',
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited file. Returns the advisory string, or null.
 * `deps` is injected by the tests; production passes nothing.
 */
export async function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadDetector = defaultLoadDetector,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;
  const relPath = relative(root, abs).split(sep).join('/');

  const detector = await loadDetector(root);
  if (
    !detector ||
    typeof detector.scanInventory !== 'function' ||
    !(detector.BYPASS_REGISTRY instanceof Map) ||
    !Array.isArray(detector.RESOURCE_GOVERNOR_INVENTORY)
  )
    return null;
  // The scanner skips its own implementation; so does the nudge.
  if (relPath === detector.RESOURCE_GOVERNOR_SCANNER_PATH) return null;

  // Cheap exit before any git or scan work: a file in no ENFORCED lane is never scanned.
  const lanes = lanesFor(detector, relPath).filter((row) => row.enforcement === 'active');
  if (!lanes.length) return null;

  const afterText = readFile(abs);
  // A brand-new file has no HEAD version; treat that as an empty "before" so a file
  // born with a violation still fires.
  const beforeText = showHead(root, relPath) ?? '';
  if (beforeText === afterText) return null;

  // validateRegistry:true (not 'strict') reports stale rows only for SCANNED paths,
  // which here is exactly the one edited file. 'strict' would also report every other
  // path's rows as path-not-scanned — true of a one-file scan, and pure noise.
  const scan = (text) =>
    text ? detector.scanInventory([[relPath, text]], { validateRegistry: true }) : [];
  const after = scan(afterText);
  if (!after.length) return null;

  let before;
  try {
    before = new Set(scan(beforeText));
  } catch {
    before = new Set(); // unscannable "before" => report everything: fail loud, not silent
  }
  const fresh = after.filter((f) => !before.has(f));
  if (!fresh.length) return null;

  const items = fresh.map((f) => {
    const it = classify(f, relPath, detector.BYPASS_REGISTRY);
    if (it.kind === 'unreviewed') it.template = nearestRowKey(detector.BYPASS_REGISTRY, relPath, it.code);
    return it;
  });
  const p016Lane = lanes.some((row) => row.migration === 'P-016');
  return formatNudge(relPath, items, { p016Lane, laneIds: lanes.map((row) => row.id) });
}

function defaultShowHead(root, relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
      timeout: 5_000,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open to '' upstream
  }
}

async function defaultLoadDetector(root) {
  try {
    return await import(`file://${join(root, DETECTOR_REL)}`);
  } catch {
    return null;
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf || '{}');
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  check('isCandidateFile accepts .ts', isCandidateFile('packages/x/lib/a.ts'));
  check('isCandidateFile accepts .mjs', isCandidateFile('scripts/a.mjs'));
  check('isCandidateFile accepts .mts', isCandidateFile('scripts/a.mts'));
  check('isCandidateFile rejects a test', !isCandidateFile('packages/x/lib/a.test.ts'));
  check('isCandidateFile rejects an integration test', !isCandidateFile('packages/x/lib/a.integration.test.ts'));
  check('isCandidateFile rejects a .d.mts', !isCandidateFile('scripts/a.d.mts'));
  check('isCandidateFile rejects _retired', !isCandidateFile('packages/x/_retired/a.ts'));
  check('isCandidateFile rejects node_modules', !isCandidateFile('node_modules/p/a.ts'));
  check('isCandidateFile rejects .json', !isCandidateFile('packages/x/a.json'));

  const registry = new Map([
    ['packages/x/lib/near/known.ts::resource-start-outside-admission', {}],
    ['packages/y/far.ts::resource-start-outside-admission', {}],
    ['packages/x/lib/near/edited.ts::unbounded-resident-queue', {}],
  ]);
  check(
    'nearestRowKey prefers the longest shared prefix',
    nearestRowKey(registry, 'packages/x/lib/near/new.ts', 'resource-start-outside-admission') ===
      'packages/x/lib/near/known.ts::resource-start-outside-admission',
  );
  check('nearestRowKey is null when no row has the code', nearestRowKey(registry, 'a.ts', 'nope') === null);

  const rel = 'packages/x/lib/near/edited.ts';
  check(
    'classify: unreviewed',
    classify(`${rel}:resource-start-outside-admission`, rel, registry).kind === 'unreviewed',
  );
  check('classify: pin-break', classify(`${rel}:unbounded-resident-queue`, rel, registry).kind === 'pin-break');
  const stale = classify(
    `stale-bypass-registry:${rel}::unbounded-resident-queue:finding-absent`,
    rel,
    registry,
  );
  check('classify: stale', stale.kind === 'stale' && stale.code === 'unbounded-resident-queue');

  // Fake detector: a finding iff the text contains START (unreviewed) — no real parsing.
  const fakeDetector = {
    RESOURCE_GOVERNOR_SCANNER_PATH: 'scripts/check-resource-governor-enforcement.mjs',
    RESOURCE_GOVERNOR_INVENTORY: [
      { id: 'lane-a', migration: 'P-013', enforcement: 'active', paths: ['packages/x/'] },
      { id: 'lane-pending', migration: 'P-099', enforcement: 'pending-P-099', paths: ['packages/pending/'] },
    ],
    BYPASS_REGISTRY: registry,
    scanInventory([[path, text]]) {
      return text.includes('START') ? [`${path}:resource-start-outside-admission`] : [];
    },
  };
  // The detector exists ONLY at /repo/scripts/...; a looser stub would let the
  // repo-root walk stop at the edited file's own directory and mis-derive relPath.
  const detectorAbs = join('/repo', DETECTOR_REL);
  const base = {
    exists: (p) => p === detectorAbs || (p.startsWith('/repo/') && !p.endsWith(DETECTOR_REL)),
    sizeOf: () => 10,
    loadDetector: async () => fakeDetector,
  };
  const at = (p) => `/repo/${p}`;

  const fired = await nudgeFor(at('packages/x/lib/near/new.ts'), {
    ...base,
    showHead: () => 'clean',
    readFile: () => 'START',
  });
  check('fires when an edit introduces a finding', !!fired && fired.includes('no reviewed row covers it'));
  check('names the nearest template row', !!fired && fired.includes('near/known.ts::resource-start'));
  check('names the BYPASS tail outside P-016', !!fired && fired.includes('BYPASS_REGISTRY tail'));
  check('names the confirm command', !!fired && fired.includes('node scripts/check-resource-governor-enforcement.mjs'));

  check(
    'silent when no finding',
    (await nudgeFor(at('packages/x/a.ts'), { ...base, showHead: () => 'clean', readFile: () => 'clean 2' })) === null,
  );
  check(
    'silent when the finding already existed at HEAD',
    (await nudgeFor(at('packages/x/a.ts'), { ...base, showHead: () => 'START', readFile: () => 'START + tweak' })) ===
      null,
  );
  check(
    'fires on a brand-new file born with a finding',
    !!(await nudgeFor(at('packages/x/a.ts'), { ...base, showHead: () => null, readFile: () => 'START' })),
  );
  check(
    'silent outside every lane, without touching git',
    (await nudgeFor(at('docs/a.ts'), {
      ...base,
      showHead: () => {
        throw new Error('must not be called');
      },
      readFile: () => 'START',
    })) === null,
  );
  check(
    'silent in a PENDING (unenforced) lane',
    (await nudgeFor(at('packages/pending/a.ts'), { ...base, showHead: () => '', readFile: () => 'START' })) === null,
  );
  check(
    'fails open when the detector cannot be loaded',
    (await nudgeFor(at('packages/x/a.ts'), {
      ...base,
      showHead: () => '',
      readFile: () => 'START',
      loadDetector: async () => null,
    })) === null,
  );

  if (failures.length) {
    console.error(`posttooluse-resource-governor-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-resource-governor-nudge --self-test: all cases passed');
  process.exit(0);
}
