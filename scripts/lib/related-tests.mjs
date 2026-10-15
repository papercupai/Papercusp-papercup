// Import-graph test selection: given the files a change touched, work out which
// TEST files could possibly be affected, so an inner-loop run does not execute a
// whole workspace suite to verify a one-file edit.
//
// WHY A STATIC INDEX AND NOT `vitest related` (measured 2026-08-17, WI-39472):
// vitest builds its module graph through vite. At operator-core's size (~9,600
// files) that collection step alone costs more than the narrowing saves — plain
// `vitest list` TIMED OUT at 200s, and `vitest related` on one hub file was still
// running at 300s having selected most of the package. This pass is a regex over
// import specifiers and completes in about a second.
//
// WHAT THE NARROWING IS ACTUALLY WORTH (same measurement, operator-core):
// changing one source file selects a median of 915 of 4,978 test files (18.4%) —
// roughly 5.4x, with 31% of source files selecting <=10%. It is NOT a 100x win,
// because a barrel-connected core means most files reach most hub tests. Do not
// oversell it.
//
// ⚠ EVERY FAILURE MODE HERE MUST FAIL TOWARD RUNNING MORE TESTS. A selection bug
// that runs too many tests wastes minutes; one that runs too few reports a green
// run that verified nothing. Each rail below is written in that direction, and
// `related-tests.test.ts` pins them.

import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripCommentsAndStrings, stripCommentsOnly } from "./strip-comments-and-strings.mjs";
import { listFilesIncludingUntracked } from "./tracked-files.mjs";
import { execFileSync } from 'node:child_process';
import { resolveTaskReportExpectation, scriptCommandWords } from './executed-source-map.mjs';
import { workspaceTestInvocation } from '../workspace-test.mjs';

// ── WIDENING THRESHOLD (plan gate-latency-selection-and-retry-policy-2026-09-06, P-001) ──
// A related selection is CORRECT BY CONSTRUCTION at any share of the suite — every test that
// can reach the change is in it, so widening past it buys no safety, only cost. The old 0.5
// default widened operator-core to all 6,493 files on a 3,849-file selection (gate run
// e70cd139, 2026-09-05): 2,634 unrelated files ran for nothing, ~40% of that lane's wall
// clock. Widening only pays when the subset is so close to the whole that the explicit file
// list is pure overhead, hence a default just under 1.0. `AFFECTED_RELATED_THRESHOLD` overrides
// it (a fraction in (0, 1]); anything unparseable falls back to the default and is REPORTED via
// `source`/`invalid` so a typo cannot silently re-widen or re-narrow the gate.
export const RELATED_WIDEN_THRESHOLD_DEFAULT = 0.95;
export const RELATED_WIDEN_THRESHOLD_ENV = "AFFECTED_RELATED_THRESHOLD";

/**
 * Resolve the widening threshold from the environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ threshold: number, source: 'default' | 'env', invalid?: string }}
 */
export function resolveRelatedWidenThreshold(env = process.env) {
  const raw = env[RELATED_WIDEN_THRESHOLD_ENV];
  if (raw == null || String(raw).trim() === "") {
    return { threshold: RELATED_WIDEN_THRESHOLD_DEFAULT, source: "default" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    return {
      threshold: RELATED_WIDEN_THRESHOLD_DEFAULT,
      source: "default",
      invalid: String(raw),
    };
  }
  return { threshold: n, source: "env" };
}

// ── FILTER-LIST CHANNEL (same plan, P-001) ─────────────────────────────────────────────
// A large related selection cannot ride on argv: `npm run <script> -- <files>` folds every
// argument into ONE `sh -c` string, and Linux caps a single argv entry at MAX_ARG_STRLEN
// (128 KiB) — 3,849 operator-core paths are ~180 KB, so the widened lane was hiding an E2BIG
// that the old 0.5 threshold never let anyone reach. The selection is therefore written to a
// content-addressed JSON file and handed to the workspace's vitest config through
// `PC_TEST_FILTER_LIST` (libs/test-config/src/vitest-config.ts applies it to `include`).
// Content-addressing keeps the passing-task-verdict identity stable for an identical
// selection across runs, while a different selection can never alias a full-suite pass.
export const RELATED_FILTER_LIST_ENV = "PC_TEST_FILTER_LIST";

// Expand only local npm aliases and && sequencing. Keep the command order and
// each alias lifecycle; other shell syntax is deliberately left unsupported.
function expandSelectionCommands(scripts, script, seen = new Set()) {
  if (seen.has(script) || typeof scripts[script] !== 'string') throw new Error('invalid-local-script-chain');
  const next = new Set([...seen, script]);
  const expand = command => {
    const alias = /^npm run ([\w:.-]+)$/.exec(command);
    if (alias) return expandSelectionCommands(scripts, alias[1], next);
    if (command.includes('&&') && !/[;|`"']|\$|&/.test(command.replaceAll('&&', ''))) {
      const steps = command.split('&&').map(part => part.trim());
      if (steps.some(part => !part)) throw new Error('invalid-local-script-chain');
      return steps.flatMap(expand);
    }
    return [{ script, command }];
  };
  return [
    ...(scripts[`pre${script}`] ? [{ script: `pre${script}`, command: scripts[`pre${script}`], lifecycle: true }] : []),
    ...expand(scripts[script]),
    ...(scripts[`post${script}`] ? [{ script: `post${script}`, command: scripts[`post${script}`], lifecycle: true }] : []),
  ];
}

// A command's maintained discovery route measures source inputs, never its
// verdict. Re-read every named byte at the selector boundary; claims of prior
// execution or malformed censuses cannot erase a command obligation.
function commandSelectionInputs(root, wsRoot, executable, args) {
  const output = execFileSync(executable, args, { cwd: wsRoot, encoding: 'utf8', timeout: 10_000 });
  const marker = 'COMMAND_CHECK_SELECTION=';
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
  const receipt = lines.length === 1 && JSON.parse(lines[0].slice(marker.length));
  const validPath = file => typeof file === 'string' && file && !path.isAbsolute(file) &&
    !file.includes('\\') && file.split('/').every(part => part && part !== '.' && part !== '..');
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'command-check-inputs' ||
      typeof receipt.check !== 'string' || !receipt.check || receipt.executed !== false ||
      receipt.runtimeClosure !== 'unmeasured' || receipt.operationalAcceptance !== false ||
      !Array.isArray(receipt.files) || !receipt.files.every(validPath) ||
      new Set(receipt.files).size !== receipt.files.length ||
      !Array.isArray(receipt.inputs) || !receipt.inputs.length ||
      !receipt.inputs.every(input => validPath(input.path) && /^[a-f0-9]{64}$/.test(input.sha256) &&
        createHash('sha256').update(readFileSync(path.resolve(root, input.path))).digest('hex') === input.sha256) ||
      new Set(receipt.inputs.map(input => input.path)).size !== receipt.inputs.length ||
      !receipt.files.every(file => receipt.inputs.some(input => input.path === file)))
    throw new Error('invalid-command-check-discovery');
  return receipt;
}

function lifecycleSelection(task, step, root, wsRoot) {
  const obligation = { kind: 'npm-lifecycle', ...step, inputs: null, executed: false };
  if (task.workspace === '@bug-drill/fixture' && step.command === 'node scripts/build.mjs') {
    const discovery = commandSelectionInputs(root, wsRoot, process.execPath,
      ['scripts/build.mjs', '--print-selection', '--repository-root', root]);
    if (discovery.check !== 'fixture-build' || discovery.files.length !== 0 ||
        discovery.dependencyClosure !== 'unmeasured') throw new Error('invalid-fixture-build-discovery');
    return { ...obligation, inputs: discovery.inputs, discovery };
  }
  return obligation;
}

/** Preparation only: enumerate the maintained selector's actual task configs, never executions.
 * Unsupported commands and failed config reads remain named residue, even with relatedFiles.
 * @param {Array<object>} tasks
 * @param {{root?: string, filterDir?: string, runResolver?: Function, syncAstro?: boolean}} [options]
 */
export function enumerateAffectedTaskSelection(tasks, { root, filterDir, runResolver, syncAstro = false } = {}) {
  const unenumerated = [];
  const requests = [];
  const selected = [];
  const entries = [];
  for (const t of tasks) {
    const id = `${t.ws.name} :: ${t.script}`;
    const command = t.ws.scripts?.[t.script] ?? '';
    // Follow only a single local npm alias. Shell chains and unfollowable/cyclic
    // aliases stay residue; guessing their leaves could silently drop a guard.
    let resolvedCommand = command;
    const aliasScripts = new Set([t.script]);
    let alias;
    while ((alias = /^npm run ([\w:.-]+)$/.exec(resolvedCommand))) {
      if (aliasScripts.has(alias[1]) || !t.ws.scripts?.[alias[1]]) break;
      aliasScripts.add(alias[1]);
      resolvedCommand = t.ws.scripts[alias[1]];
    }
    const wsRoot = path.resolve(root, t.ws.dir);
    const task = { id, workspace: t.ws.name, dir: t.ws.dir, script: t.script, command,
      ...(resolvedCommand !== command ? { resolvedCommand } : {}),
      lifecycleCommands: [...aliasScripts].flatMap(script => ['pre', 'post'].flatMap(prefix =>
        t.ws.scripts?.[`${prefix}${script}`] ? [{ script: `${prefix}${script}`, command: t.ws.scripts[`${prefix}${script}`] }] : [])) };
    let words = scriptCommandWords(resolvedCommand);
    if (resolvedCommand.includes('&&')) {
      try {
        const steps = expandSelectionCommands(t.ws.scripts, t.script);
        if (steps.length < 2 || steps.some(step => step.command.includes('&&')))
          throw new Error('unsupported-task-command');
        const prepared = steps.map(step => {
          if (step.lifecycle) return { ...step, files: [], commandObligations: [
            lifecycleSelection(task, step, root, wsRoot)],
            unenumerated: [{ reason: 'unexecuted-lifecycle-command' }] };
          const leaf = enumerateAffectedTaskSelection([{ ...t, script: step.script,
            ws: { ...t.ws, scripts: { [step.script]: step.command } } }], { root, filterDir, runResolver, syncAstro });
          return { ...step, files: leaf.files, commandObligations: leaf.commandObligations,
            unenumerated: leaf.unenumerated, discovery: leaf.tasks };
        });
        const commandObligations = prepared.flatMap((step, index) =>
          (step.commandObligations ?? []).map(obligation => ({ ...obligation, step: index })));
        entries.push({ ...task, runner: 'command-chain', steps: prepared,
          files: [...new Set(prepared.flatMap(step => step.files))].sort(), commandObligations });
        const stepFiles = prepared.flatMap(step => step.files);
        if (new Set(stepFiles).size !== stepFiles.length)
          unenumerated.push({ task: id, reason: 'overlapping-chain-file-population', command });
        for (const [index, step] of prepared.entries()) for (const residue of step.unenumerated)
          unenumerated.push({ task: id, step: index, command: step.command, reason: residue.reason });
      } catch (error) { unenumerated.push({ task: id, reason: error.message, command }); }
      continue;
    }
    if (resolvedCommand === 'astro check') {
      const obligation = { kind: 'command-check', check: 'astro-check', command: resolvedCommand,
        inputs: null, executed: false };
      if (!syncAstro) {
        entries.push({ ...task, runner: 'astro-check', files: [], commandObligations: [obligation] });
        unenumerated.push({ task: id, reason: 'astro-sync-not-requested', command });
      } else {
        selected.push({ ...task, runner: 'astro-check', commandObligations: [obligation] });
        requests.push({ runner: 'astro-check', root: wsRoot, repositoryRoot: root,
          enumerateFiles: true, syncBeforeCheck: true });
      }
      continue;
    }
    const discoveryCommand = resolvedCommand === 'node scripts/el-tools-check.mjs' ?
      [process.execPath, ['scripts/el-tools-check.mjs', '--print-selection']] :
      resolvedCommand === 'bash bin/lib/run-selftests.sh' ?
        ['/bin/bash', ['bin/lib/run-selftests.sh', '--print-selection']] : null;
    if (discoveryCommand) {
      try {
        const receipt = commandSelectionInputs(root, wsRoot, discoveryCommand[0], discoveryCommand[1]);
        const commandObligations = [{ kind: 'command-check', command: resolvedCommand,
          check: receipt.check, inputs: receipt.inputs, discovery: receipt, executed: false }];
        entries.push({ ...task, runner: 'command-check', files: receipt.files.slice().sort(), commandObligations });
        unenumerated.push({ task: id, reason: 'unexecuted-command-obligations', command });
      } catch (error) { unenumerated.push({ task: id, reason: error.message, command }); }
      continue;
    }
    if (words[0] === 'node' && words.includes('--test')) {
      try {
        const patterns = [];
        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          if (word === '--test' || word.startsWith('--test-global-setup=')) continue;
          if (word === '--import' && words[i + 1] && /^[\w./@-]+$/.test(words[i + 1])) { i++; continue; }
          // These are inert path globs, never arbitrary shell source. npm's POSIX
          // shell expands them BEFORE Node's own native glob discovery.
          if (!/^[\w./@*?\[\]-]+$/.test(word) || word.startsWith('-')) throw new Error('unsupported-node-test-argument');
          patterns.push(word);
        }
        if (!patterns.length || resolvedCommand !== words.join(' ')) throw new Error('unsupported-node-test-command');
        const shellPatterns = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${patterns.join(' ')}`],
          { cwd: wsRoot, encoding: 'utf8', timeout: 10_000 }).split('\0').filter(Boolean);
        const files = globSync(shellPatterns, { cwd: wsRoot, exclude: name => name === 'node_modules' })
          .map(file => path.posix.join(t.ws.dir, file.replaceAll('\\', '/'))).sort();
        if (!files.length || files.some(file => !statSync(path.resolve(root, file)).isFile() ||
            path.relative(root, path.resolve(root, file)).startsWith('../'))) throw new Error('invalid-node-test-population');
        entries.push({ ...task, runner: 'node-test', files: [...new Set(files)], shellPatterns });
      } catch (error) {
        unenumerated.push({ task: id, reason: error.message, command });
      }
      continue;
    }
    const pureWrapper = words[0] === 'node' && /(?:^|\/)run-vitest-pure-lane\.mjs$/.test(words[1] ?? '');
    const workspaceWrapper = words[0] === 'node' && /(?:^|\/)workspace-test\.mjs$/.test(words[1] ?? '');
    if (workspaceWrapper) {
      const invocation = workspaceTestInvocation(words.slice(2), root);
      // Explicit argv files use the router's multi-config contract, not this full-suite route.
      if (!invocation.routed) words = invocation.args;
    }
    const direct = /(?:^|\/)vitest$/.test(words[0] ?? '');
    const envWords = resolvedCommand.trim().split(/\s+/).filter(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const laneWord = envWords.find(word => word.startsWith('PC_TEST_LANE='));
    const lane = laneWord?.slice('PC_TEST_LANE='.length);
    const rest = words.slice(pureWrapper ? 2 : 1);
    let supported = (direct || pureWrapper) && !/[;&|`"']|\$\(/.test(resolvedCommand) &&
      envWords.every(word => /^PC_TEST_LANE=(pure|stateful)$/.test(word) ||
        /^TEMPLATE_CHECKS_CONFIG=[\w./-]+$/.test(word));
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (['run', '--passWithNoTests', '--no-passWithNoTests'].includes(word)) continue;
      if (word.startsWith('--config=')) continue;
      if ((word === '--config' || word === '-c') && rest[i + 1] && !rest[i + 1].startsWith('-')) { i++; continue; }
      supported = false;
    }
    if (!supported || (pureWrapper && lane !== 'pure')) {
      unenumerated.push({ task: id, reason: 'unsupported-task-command', command });
      continue;
    }
    const route = resolveTaskReportExpectation({ command: workspaceWrapper ? words.join(' ') : resolvedCommand, wsDir: wsRoot });
    if (route.config === null && route.reason !== 'no-config') {
      unenumerated.push({ task: id, reason: route.reason, command });
      continue;
    }
    const env = Object.fromEntries(envWords.map(word => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]));
    if (Array.isArray(t.relatedFiles) && t.relatedFiles.length > 0)
      env[RELATED_FILTER_LIST_ENV] = writeRelatedFilterList(filterDir, t.relatedFiles).path;
    selected.push(task);
    requests.push({ root: wsRoot, repositoryRoot: root, config: route.config ?? false, enumerateFiles: true, env });
  }
  const resolveRequests = runResolver ?? (requests => {
    const output = execFileSync(process.execPath, [path.join(root, 'scripts/resolve-vitest-config-contracts.mjs')], {
      cwd: root, input: JSON.stringify({ requests }), encoding: 'utf8', timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
    const line = output.split(/\r?\n/).reverse().find(line => line.startsWith(marker));
    if (!line) throw new Error('config resolver returned no contract marker');
    return JSON.parse(line.slice(marker.length)).results;
  });
  let results;
  try {
    results = requests.length ? resolveRequests(requests) : [];
    if (!Array.isArray(results) || results.length !== requests.length) throw new Error('config resolver population mismatch');
  } catch (error) {
    results = requests.map(() => ({ ok: false, error: error.message }));
  }
  for (const [i, task] of selected.entries()) {
    const result = results[i];
    const population = result?.repositoryFiles ?? result?.files;
    if (task.runner === 'astro-check' && (result?.sync?.status !== 'completed' ||
        result.sync.beforePopulation !== true || result.executed !== false ||
        result.runtimeClosure !== 'unmeasured' || result.operationalAcceptance !== false ||
        !Array.isArray(population) || !population.length ||
        !Array.isArray(result.inputs) || !result.inputs.length ||
        new Set(result.inputs.map(input => input.path)).size !== result.inputs.length ||
        !result.inputs.every(input => typeof input.path === 'string' && input.path &&
          !path.isAbsolute(input.path) && !input.path.includes('\\') &&
          input.path.split('/').every(part => part && part !== '.' && part !== '..') &&
          /^[a-f0-9]{64}$/.test(input.sha256) && (() => {
            try { return createHash('sha256').update(readFileSync(path.resolve(root, input.path))).digest('hex') === input.sha256; }
            catch { return false; }
          })()) || !population.every(file => result.inputs.some(input => input.path === file)))) {
      entries.push({ ...task, files: [], commandObligations: [{
        ...task.commandObligations[0], discovery: result,
      }] });
      unenumerated.push({ task: task.id, reason: result?.error ?? 'invalid-post-sync-astro-population', command: task.command });
      continue;
    }
    if (result?.ok !== true || result.enumerated !== true || !Array.isArray(population) ||
        population.some(file => typeof file !== 'string' || !file || path.isAbsolute(file) ||
          file.includes('\\') || file.split('/').some(part => part === '..' || part === '.')) ||
        new Set(population).size !== population.length) {
      if (task.runner === 'astro-check') entries.push({ ...task, files: [] });
      unenumerated.push({ task: task.id, reason: result?.error ?? 'invalid-config-file-population', command: task.command });
      continue;
    }
    entries.push({ ...task, files: result.repositoryFiles ? population.slice().sort() :
      population.map(file => path.posix.join(task.dir, file)).sort(), config: result.config,
      ...(task.runner === 'astro-check' ? { sync: result.sync, commandObligations: [{
        ...task.commandObligations[0], inputs: result.inputs, discovery: result,
      }] } : {}),
      ...(result.projects ? { projects: result.projects } : {}) });
    if (task.runner === 'astro-check')
      unenumerated.push({ task: task.id, reason: 'unexecuted-command-obligations', command: task.command });
  }
  for (const task of entries) {
    if (task.runner === 'command-chain' || !task.lifecycleCommands.length) continue;
    const lifecycle = task.lifecycleCommands.map(step => {
      try { return lifecycleSelection(task, step, root, path.resolve(root, task.dir)); }
      catch (error) {
        unenumerated.push({ task: task.id, reason: error.message, command: step.command });
        return { kind: 'npm-lifecycle', ...step, inputs: null, executed: false };
      }
    });
    task.commandObligations = [...(task.commandObligations ?? []), ...lifecycle];
    unenumerated.push({ task: task.id, reason: 'unexecuted-lifecycle-command', command: task.command });
  }
  entries.sort((a, b) => tasks.findIndex(t => `${t.ws.name} :: ${t.script}` === a.id) -
    tasks.findIndex(t => `${t.ws.name} :: ${t.script}` === b.id));
  const files = [...new Set(entries.flatMap(task => task.files))].sort();
  const overlaps = files.filter(file => entries.filter(task => task.files.includes(file)).length > 1);
  const commandObligations = entries.flatMap(task => (task.commandObligations ?? [])
    .map(obligation => ({ ...obligation, task: task.id })));
  // A unique source-file census is not an execution population: Astro may
  // check the same source that Vitest subsequently executes. Keep the original
  // ordered occurrences and their roles, without relabeling check inputs as tests.
  const fileOccurrences = entries.flatMap(task => {
    if (task.runner === 'command-chain') return task.steps.flatMap((step, index) =>
      step.files.map(file => ({ task: task.id, step: index, command: step.command, file,
        kind: step.discovery?.[0]?.runner === 'astro-check' ? 'check-input' : 'test-file' })));
    return task.files.map(file => ({ task: task.id, step: null,
      command: task.resolvedCommand ?? task.command, file,
      kind: task.runner === 'astro-check' ? 'check-input' : 'test-file' }));
  });
  return { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation',
    coverage: unenumerated.length === 0 && files.length > 0 && overlaps.length === 0 ? 'complete' : 'partial',
    files, fileOccurrences, tasks: entries, commandObligations, unenumerated, overlaps, executed: false,
    runtimeClosure: 'unmeasured', operationalAcceptance: false };
}

/**
 * Persist a workspace-relative selection as a filter-list file.
 *
 * @param {string}   dir    directory to write into (created if missing)
 * @param {string[]} files  workspace-relative test paths
 * @returns {{ path: string, digest: string, count: number }}
 */
export function writeRelatedFilterList(dir, files) {
  const normalized = [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort();
  const body = JSON.stringify(normalized);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `related-filter-${digest}.json`);
  try {
    writeFileSync(filePath, body, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Same content ⇒ same name: a concurrent writer already landed it.
    if (err?.code !== "EEXIST") throw err;
  }
  return { path: filePath, digest, count: normalized.length };
}

/** Extensions we index. */
const SOURCE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
// Runtime paths can point at shell scripts as well as modules. Keep `.sh` out of
// SOURCE_RE so the index does not treat every shell script as a source module.
const RUNTIME_DEPENDENCY_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|sh)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
]);

/** `import x from 's'` / `export … from 's'` / `import('s')` / `import 's'` / `require('s')`. */
const SPECIFIER_RE =
  /(?:\bimport\b|\bexport\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/dg;
/** Runtime-loaded files named relative to the current module rather than imported. */
const MODULE_RUNTIME_PATH_RE =
  /\b(?:resolve|join)\s*\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)|\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/dg;

/**
 * Match executable tokens on the canonical offset-preserving AST mask, then recover
 * their literal operands from the original source. Child-program strings, comments and
 * regex bodies cannot mint parent imports; real template expressions remain executable.
 */
function moduleDependencyEdges(source, file) {
  const code = stripCommentsAndStrings(source, file);
  const operands = (pattern) => [...code.matchAll(pattern)].map((match) => {
    const range = match.indices.slice(1).find(Boolean);
    return range ? source.slice(range[0], range[1]) : null;
  }).filter(Boolean);
  return {
    specifiers: operands(SPECIFIER_RE),
    runtimePaths: operands(MODULE_RUNTIME_PATH_RE),
  };
}

export function isTestFile(file) {
  return TEST_RE.test(file);
}

/** Config basenames Playwright is allowed to declare its ownership in. */
const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.mts",
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
];

/**
 * Which files in this workspace belong to PLAYWRIGHT rather than Vitest.
 *
 * `TEST_RE` above deliberately spans `.test.*` AND `.spec.*`, because both name real tests
 * somewhere in this repo. But they are not interchangeable RUNNERS: the Vitest unit layer
 * includes only `**\/*.test.ts(x)` (libs/test-config/src/vitest-config.ts), while
 * apps/operator/playwright.config.ts claims `testDir: './e2e'` + `testMatch: /.*\.spec\.ts$/`.
 * A Playwright spec handed to a Vitest lane therefore matches NOTHING, and the test router
 * refuses the whole partial-match run rather than false-greening it
 * (`TEST_FILE_ROUTE_ERROR requested=342 matched=340`, scripts/test-files.mjs). The task then
 * exits 1 with ZERO attributable test files — invisible to the `test_runs` ledger (no fail
 * rows) and to the gate's isolation re-run (no failing file to isolate), which is what made
 * EI-21440128879545486 red-pin green-checkpoint and freeze `main` for the whole fleet.
 *
 * The boundary is DERIVED from Playwright's own config, not a hardcoded `e2e/` glob, so
 * moving `testDir` moves this with it. The extension alone is NOT a safe discriminator:
 * search-core and the three papergrid packages legitimately use `src/**\/*.spec.ts` as their
 * VITEST include, and excluding those would silently shrink their runs — the exact false-green
 * this refusal exists to prevent.
 *
 * A config that is absent or unparseable owns NOTHING. That direction is deliberate: the
 * failure then stays LOUD (a red gate naming the unmatched file) instead of silently
 * withholding a test that should have run.
 *
 * @param {string} rootDir workspace root to look for a Playwright config in
 * @param {{ readFile?: (p: string) => string }} [seam] injected in tests
 * @returns {(absFile: string) => boolean} true when Playwright — not Vitest — owns the file
 */
export function playwrightOwnedTest(rootDir, { readFile } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  let source = null;
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    try {
      source = read(path.join(rootDir, name));
      break;
    } catch {
      // Not this basename; try the next.
    }
  }
  if (source == null) return () => false;

  const dirMatch = /\btestDir\s*:\s*['"]([^'"]+)['"]/.exec(source);
  const matchMatch = /\btestMatch\s*:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/.exec(
    source,
  );
  if (!dirMatch || !matchMatch) return () => false;

  const testDir = path.resolve(rootDir, dirMatch[1]);
  let testMatch;
  try {
    // Strip `g`/`y`: a stateful `lastIndex` would make `.test()` alternate per call.
    testMatch = new RegExp(matchMatch[1], matchMatch[2].replace(/[gy]/g, ""));
  } catch {
    return () => false;
  }

  return (absFile) =>
    (absFile === testDir || absFile.startsWith(testDir + path.sep)) &&
    testMatch.test(absFile);
}

/**
 * Whether Vitest's default UNIT config universally excludes this test path.
 *
 * Keep this contract byte-for-byte aligned with `LAYERED_TEST_FILE` and the unit-layer
 * exclusion globs in `libs/test-config/src/vitest-config.ts`. A related selection is handed
 * to the unit `test`/lane scripts as positional filters; allowing an integration or browser
 * test through makes the unit config reject the entire invocation before any test runs.
 *
 * This deliberately does NOT classify every `.spec.*` file. Some workspaces own Vitest specs
 * through a custom config, while the integration/browser suffixes are excluded by the shared
 * unit config everywhere.
 *
 * @param {string} file test path, absolute or relative
 * @returns {boolean} true when the unit Vitest layer excludes the file
 */
export function unitExcludedVitestTest(file) {
  return /\.(?:integration|browser)\.test\.[cm]?[jt]sx?$/.test(file)
    // This paid live proof is explicitly excluded by operator-core's ordinary configs.
    || /(?:^|\/)lib\/blueprint\/launch-blueprint-account-route\.e2e\.test\.ts$/.test(file);
}

/**
 * A specifier is INTRA-REPO if it points at a path we ought to be able to resolve
 * ourselves — relative, or one of the repo's path aliases. A BARE specifier
 * (`node:fs`, `vitest`, `@papercusp/operator-core`) is deliberately out of graph:
 * cross-package effects are already covered by workspace-level selection, and the
 * caller's empty-selection rail turns "changed file is in another package" into a
 * full-suite run.
 */
export function classifySpecifier(spec) {
  if (spec.startsWith(".")) return "relative";
  if (spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#"))
    return "alias";
  return "bare";
}

function defaultFs() {
  return {
    list(dir) {
      // Index source, including new files, rather than ignored runtime bundles.
      // Reuse the maintained Git census and its bounded archive fallback so a
      // local dist-host build cannot add hundreds of MB to every related scan.
      const { files } = listFilesIncludingUntracked(dir);
      return files
        .filter((file) => SOURCE_RE.test(file) &&
          !file.split(/[\\/]/).slice(0, -1).some((part) => SKIP_DIRS.has(part)))
        .map((file) => path.resolve(dir, file));
    },
    read(p) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exists(p) {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Candidate on-disk paths for a resolved-but-extensionless specifier target. */
function candidatesFor(base) {
  const out = [base];
  for (const ext of [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".js",
    ".jsx",
  ]) {
    out.push(base + ext);
  }
  for (const idx of [
    "index.ts",
    "index.tsx",
    "index.mts",
    "index.mjs",
    "index.js",
  ]) {
    out.push(path.join(base, idx));
  }
  // A `./x.js` specifier in TS-land usually means `./x.ts` on disk.
  const swapped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  if (swapped !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) out.push(swapped + ext);
  }
  return out;
}

/**
 * One tsconfig `compilerOptions.paths` entry, as `tsconfigPathEntriesFor` returns it and as the
 * `aliases` option of `staticImportClosure` / `buildIndex` / `selectRelatedTests` takes it.
 *
 * @typedef {object} TsconfigPathEntry
 * @property {string}  prefix   the key with any trailing `*` removed
 * @property {string}  target   absolute target: a dir for a wildcard key, the file itself for an exact key
 * @property {boolean} wildcard true for a `*` key (matched by prefix), false for an exact key (equality only)
 */

/**
 * Path aliases for a workspace, read from its tsconfig `compilerOptions.paths` as ordered
 * entries that keep whether each key is a WILDCARD (`"@/*"`, matched by prefix) or EXACT
 * (`"pkg"`, matched by equality only; its target is the file itself). Resolve a specifier
 * against them with `matchTsconfigPath` below — never a first-match prefix scan.
 *
 * Only intra-package aliases matter to this module's own resolvers (`@/`, `~/`, `#`; see
 * `classifySpecifier`); a bare package specifier is out of graph by design. Returning [] on any
 * problem is SAFE, not lossy: an alias we cannot resolve makes the importing file "unresolved",
 * and every caller of this module treats an unresolved file as reaching everything (or the
 * closure as not-ok) — so a missing mapping widens the run rather than silently dropping edges.
 * Moved here from affected-tests.mjs (WI-10006650) so the e2e fixture-spec selector resolves
 * `@/` exactly as related-test selection does — one parser, not two.
 *
 * There is deliberately no flattened `prefix → dir` map any more (WI-10007002). It gave an EXACT
 * key's FILE target a trailing slash, and the first-match scans that consumed it then let that
 * key capture longer specifiers by prefix: `@papercusp/operator-core` captured
 * `@papercusp/operator-core/lib/x` and resolved it to `…/lib/index.ts/lib/x` (WI-10006809
 * measured 692 dropped edges in the snapshot producer that shared the map).
 *
 * @param {string} wsRoot absolute workspace root holding tsconfig.json
 * @param {{ readFile?: (p: string) => string }} [seam] reads the tsconfig. The admission
 *   pre-check injects a reader over a pinned Git tree so aliases come from the commit being
 *   judged, not the shared working tree (green-main-cycle-time-2026-10-08#D-037). A throw
 *   means "absent", exactly like a missing file on disk.
 * @returns {TsconfigPathEntry[]}
 */
export function tsconfigPathEntriesFor(wsRoot, { readFile } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  try {
    const tsconfigPath = path.join(wsRoot, "tsconfig.json");
    let text;
    try {
      text = read(tsconfigPath);
    } catch {
      return [];
    }
    if (typeof text !== "string") return [];
    // Tolerate comments/trailing commas — tsconfig is JSON5-ish in practice.
    // Comments are masked by the SHARED stripper, never a local regex. A naive
    // `//`-to-end-of-line rule is string-literal-blind, so a tsconfig value that
    // merely CONTAINS " // " (measured: `"note": "ratio 1 // 2 is fine"`) is
    // truncated mid-string and JSON.parse throws. The catch below would swallow
    // that and return {}, silently dropping every alias — which makes each aliased
    // import unresolvable and fail-safes the whole workspace to "reaches
    // everything". Safe direction, but it disables narrowing INVISIBLY, which is
    // the failure mode this file can least afford to hide. Trailing commas are
    // stripped AFTER masking, so a comma inside a string is never touched either.
    const raw = stripCommentsOnly(text, tsconfigPath).replace(/,(\s*[}\]])/g, "$1");
    const cfg = JSON.parse(raw);
    const opts = cfg.compilerOptions ?? {};
    const baseUrl = path.join(wsRoot, opts.baseUrl ?? ".");
    const out = [];
    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== "string") continue;
      // "@/*": ["./*"]  ->  prefix "@/" maps to <baseUrl>/
      out.push({
        prefix: pattern.replace(/\*$/, ""),
        target: path.join(baseUrl, target.replace(/\*$/, "")),
        wildcard: pattern.endsWith("*"),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve `spec` against tsconfig `paths` entries the way TypeScript does: an EXACT key matches
 * by equality only and wins outright; otherwise the LONGEST matching wildcard prefix wins
 * (independent of declaration order). Returns the base path — repo-relative or absolute,
 * whichever the entries hold — or null when no key matches. A first-match prefix scan here is the
 * bug WI-10006809 measured and WI-10007002 removed from this module's own resolvers: the exact key
 * `@papercusp/operator-core` captured `@papercusp/operator-core/lib/x` ahead of its wildcard.
 * The ONE matcher: gen-graph-dependency-snapshot.mjs imports it from here.
 *
 * @param {Array<[string, string, boolean]>} entries `[prefix, target, wildcard]`
 * @param {string} spec
 * @returns {string | null}
 */
export function matchTsconfigPath(entries, spec) {
  const exact = entries.find(([prefix, , wildcard]) => !wildcard && spec === prefix);
  if (exact !== undefined) return exact[1];
  let best;
  for (const entry of entries) {
    if (entry[2] && spec.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  }
  return best === undefined ? null : path.posix.normalize(`${best[1]}${spec.slice(best[0].length)}`);
}

/**
 * `aliases` → the tuple shape `matchTsconfigPath` takes, once per call. A non-array (the retired
 * flattened `prefix → dir` map) THROWS: treating it as "no aliases" would leave every aliased
 * import unresolved and widen the whole workspace invisibly, and affected-tests already turns a
 * selection crash into a loud full run.
 *
 * @param {TsconfigPathEntry[]} aliases
 * @returns {Array<[string, string, boolean]>}
 */
function aliasTuples(aliases) {
  if (!Array.isArray(aliases)) {
    throw new TypeError(
      "related-tests: `aliases` must be tsconfigPathEntriesFor() entries ({ prefix, target, wildcard }[]), not a prefix → dir map (WI-10007002)",
    );
  }
  return aliases.map(({ prefix, target, wildcard }) => [prefix, target, wildcard === true]);
}

/**
 * Walk the transitive static module graph from a small set of entry files.
 *
 * This is the entry-oriented sibling of `buildIndex`: it reuses the same specifier parser and
 * resolver, but reads only modules the entries can actually reach. Passing-task provenance uses
 * it for the affected-test runner itself; indexing every file under `scripts/` would make an
 * unrelated maintenance script an input to every workspace test, while indexing the whole repo
 * would cost more than the cache can save.
 *
 * Runtime file paths named as `resolve(__dirname, './x')` / `new URL('./x', import.meta.url)` are
 * edges too. Vitest config loads setup/reporting modules by path rather than import; ignoring that
 * shape would produce a complete-looking but false-small proof. Every uncertainty fails closed.
 * An unreadable entry, unresolved relative/alias import or runtime path, edge escaping `rootDir`,
 * or empty graph returns `ok:false`; callers must run the task instead of reusing a proof. Bare
 * package imports are represented by the package-manager lockfiles in the caller's manifest and
 * therefore do not create an on-disk edge here.
 *
 * @param {object} [o]
 * @param {string} o.rootDir absolute repository root
 * @param {string[]} o.entryFiles absolute entry files to walk
 * @param {TsconfigPathEntry[]} [o.aliases] `tsconfigPathEntriesFor` entries, resolved with
 *   `matchTsconfigPath` (same rule as `buildIndex`). An alias specifier no key matches stays
 *   unresolved, so the default `[]` keeps every existing caller's fail-closed behaviour.
 * @param {RelatedFs} [o.fs] filesystem seam (injected in tests)
 * @returns {{ ok: boolean, files: string[], unresolved: string[] }}
 */
export function staticImportClosure({
  rootDir,
  entryFiles,
  aliases = [],
  fs = defaultFs(),
} = {}) {
  const aliasEntries = aliasTuples(aliases);
  const root = path.resolve(rootDir ?? ".");
  const pending = [...(entryFiles ?? [])].map((file) => path.resolve(file));
  const visited = new Set();
  const unresolved = new Set();

  const insideRoot = (file) => {
    const rel = path.relative(root, file);
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
  };

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (!insideRoot(file)) {
      unresolved.add(`${file}:outside-root`);
      continue;
    }
    const source = fs.read(file);
    if (source === null) {
      unresolved.add(`${file}:unreadable`);
      continue;
    }
    visited.add(file);
    let edges;
    try {
      edges = moduleDependencyEdges(source, file);
    } catch {
      unresolved.add(`${file}:comment-strip-failed`);
      continue;
    }

    for (const spec of edges.specifiers) {
      if (!spec) continue;
      const kind = classifySpecifier(spec);
      if (kind === "bare") continue;
      let base;
      if (kind === "alias") {
        const aliasBase = matchTsconfigPath(aliasEntries, spec);
        if (aliasBase === null) {
          unresolved.add(`${file}:${spec}`);
          continue;
        }
        base = path.resolve(aliasBase);
      } else {
        base = path.resolve(path.dirname(file), spec);
      }
      const target = candidatesFor(base).find((candidate) => fs.exists(candidate));
      if (!target || !insideRoot(target)) {
        unresolved.add(`${file}:${spec}`);
        continue;
      }
      pending.push(path.resolve(target));
    }
    for (const spec of edges.runtimePaths) {
      if (!spec) continue;
      // Directory anchors such as `resolve(__dirname, '../..')` configure search roots; they are
      // not loaded modules. Only source-shaped runtime paths join the module proof here.
      if (!SOURCE_RE.test(spec)) continue;
      const target = candidatesFor(path.resolve(path.dirname(file), spec)).find((candidate) =>
        fs.exists(candidate),
      );
      if (!target || !insideRoot(target)) {
        unresolved.add(`${file}:runtime:${spec}`);
        continue;
      }
      pending.push(path.resolve(target));
    }
  }

  return {
    ok: visited.size > 0 && unresolved.size === 0,
    files: [...visited].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/**
 * The injectable filesystem seam. Declared as a typedef because `gen:declarations`
 * emits from JSDoc: an UNDOCUMENTED destructured option is inferred as a CLOSED
 * literal type (or, with no default to infer from, dropped from the emitted type
 * altogether), and every caller passing it then fails TS2353 "does not exist in
 * type". That is not hypothetical — it is exactly how this block came to be
 * written: the first emit declared `selectRelatedTests` as accepting only the
 * three params its JSDoc happened to list, and lint:tsc reported 10 errors in
 * related-tests-selection.test.ts for the ones it omitted. Keep every option
 * documented here, or the declaration silently narrows again.
 *
 * @typedef {object} RelatedFs
 * @property {(dir: string) => string[]}      list   recursively enumerate source files under `dir`
 * @property {(p: string) => string | null}   read   file contents, or null when unreadable
 * @property {(p: string) => boolean}         exists does this path resolve on disk
 * @property {((p: string) => string | null) | undefined} [key] content identity of `p` (a git
 *   blob sha), or null when unknown. With `buildIndex`'s `edgeCache`, a file whose (path, key)
 *   pair was parsed before is neither read nor re-parsed.
 */

/**
 * Import edges parsed out of one file, or `null` when it did not parse (an unresolved file).
 * @typedef {{ specifiers: string[], runtimePaths: string[] } | null} ParsedEdges
 */

/**
 * Parsed edges reused across `buildIndex` calls, keyed by `edgeCacheKey(file, fs.key(file))`.
 * Only the parse is cached: resolution depends on the tree around the file, so it reruns.
 * @typedef {Map<string, ParsedEdges>} EdgeCache
 */

/**
 * The `EdgeCache` key for `file` with content identity `key`. The path is part of it because
 * the parser picks its dialect from the extension.
 *
 * @param {string} file
 * @param {string} key
 * @returns {string}
 */
export function edgeCacheKey(file, key) {
  return `${key}\0${file}`;
}

/**
 * @typedef {object} RelatedIndex
 * @property {string[]}                files      every source file found under the root
 * @property {Map<string, Set<string>>} deps      file -> the intra-repo files it imports directly
 * @property {Set<string>}             unresolved files carrying an import we could NOT resolve
 */

/**
 * Build the forward dependency graph for `rootDir`.
 *
 * Returns `{ files, deps, unresolved }` where `unresolved` is the set of files
 * carrying at least one INTRA-REPO specifier we could not resolve. Those files are
 * treated as depending on everything (see `selectRelatedTests`) — an unresolved
 * edge is a hole in the graph, and the safe reading of a hole is "this might depend
 * on the thing you changed".
 *
 * @param {object}                  [o]
 * @param {string}                  o.rootDir   absolute dir to index (a workspace's source root)
 * @param {TsconfigPathEntry[]}     [o.aliases] `tsconfigPathEntriesFor` entries (resolved with `matchTsconfigPath`)
 * @param {RelatedFs}               [o.fs]      filesystem seam (injected in tests)
 * @param {EdgeCache}               [o.edgeCache] parsed edges reused across calls; consulted only
 *                                              for files `fs.key` identifies
 * @returns {RelatedIndex}
 */
export function buildIndex({ rootDir, aliases = [], fs = defaultFs(), edgeCache = undefined } = {}) {
  const aliasEntries = aliasTuples(aliases);
  const files = fs.list(rootDir);
  const fileSet = new Set(files);
  const deps = new Map();
  const unresolved = new Set();

  const resolve = (fromFile, spec) => {
    const kind = classifySpecifier(spec);
    if (kind === "bare") return { kind, target: null };
    let base;
    if (kind === "relative") {
      base = path.resolve(path.dirname(fromFile), spec);
    } else {
      // Alias: exact key first, else the longest wildcard prefix (TypeScript's rule).
      const aliasBase = matchTsconfigPath(aliasEntries, spec);
      if (aliasBase === null) return { kind, target: null, unresolvable: true };
      base = path.resolve(aliasBase);
    }
    for (const cand of candidatesFor(base)) {
      if (fileSet.has(cand) || fs.exists(cand)) return { kind, target: cand };
    }
    return { kind, target: null, unresolvable: true };
  };

  for (const f of files) {
    const identity = edgeCache && typeof fs.key === "function" ? fs.key(f) : null;
    const cacheKey = identity ? edgeCacheKey(f, identity) : null;
    /** @type {ParsedEdges | undefined} */
    let edges = cacheKey ? edgeCache?.get(cacheKey) : undefined;
    if (edges === undefined) {
      const src = fs.read(f);
      if (src === null) {
        // Unreadable file: we cannot know what it imports. Fail loud-ish by marking
        // it unresolved rather than silently giving it zero dependencies. Not cached:
        // a failed read says nothing about the content behind the key.
        unresolved.add(f);
        deps.set(f, new Set());
        continue;
      }
      try {
        edges = moduleDependencyEdges(src, f);
      } catch {
        edges = null;
      }
      if (cacheKey) edgeCache?.set(cacheKey, edges);
    }
    if (edges === null) {
      unresolved.add(f);
      deps.set(f, new Set());
      continue;
    }
    const set = new Set();
    for (const spec of edges.specifiers) {
      if (!spec) continue;
      const r = resolve(f, spec);
      if (r.target) set.add(r.target);
      else if (r.unresolvable) unresolved.add(f);
    }
    for (const spec of edges.runtimePaths) {
      if (!spec || !RUNTIME_DEPENDENCY_RE.test(spec)) continue;
      const target = candidatesFor(path.resolve(path.dirname(f), spec)).find(
        (candidate) => fileSet.has(candidate) || fs.exists(candidate),
      );
      if (target) set.add(target);
      else unresolved.add(f);
    }
    deps.set(f, set);
  }

  return { files, deps, unresolved };
}

/**
 * Exact transitive forward closure, including cyclic import graphs.
 *
 * A plain DFS cannot safely memoize while it is breaking a cycle: the first root
 * through a strongly-connected component sees a stack-truncated closure and
 * poisons every later lookup with that partial set. Test selection then depends
 * on file enumeration order and can silently miss a test. Collapse SCCs first;
 * their condensation graph is acyclic, so memoization is exact.
 */
export function transitiveDeps(index) {
  const { deps } = index;

  // Tarjan's algorithm: assign every file to one strongly-connected component.
  const nodes = new Set(deps.keys());
  for (const targets of deps.values()) {
    for (const target of targets) nodes.add(target);
  }
  const discovered = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const componentOf = new Map();
  const components = [];
  let nextIndex = 0;

  const connect = (file) => {
    const fileIndex = nextIndex++;
    discovered.set(file, fileIndex);
    lowlink.set(file, fileIndex);
    stack.push(file);
    onStack.add(file);

    for (const target of deps.get(file) ?? []) {
      if (!discovered.has(target)) {
        connect(target);
        lowlink.set(file, Math.min(lowlink.get(file), lowlink.get(target)));
      } else if (onStack.has(target)) {
        lowlink.set(file, Math.min(lowlink.get(file), discovered.get(target)));
      }
    }

    if (lowlink.get(file) !== discovered.get(file)) return;
    const componentId = components.length;
    const members = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      componentOf.set(member, componentId);
      members.push(member);
      if (member === file) break;
    }
    components.push(members);
  };

  for (const file of nodes) {
    if (!discovered.has(file)) connect(file);
  }

  // The component graph is a DAG. Memoizing its closure is therefore complete,
  // unlike memoizing a DFS that is still inside an import cycle.
  const componentDeps = components.map(() => new Set());
  for (const [file, targets] of deps) {
    const from = componentOf.get(file);
    for (const target of targets) {
      const to = componentOf.get(target);
      if (from !== undefined && to !== undefined && from !== to)
        componentDeps[from].add(to);
    }
  }
  const componentMemo = new Map();
  const visitComponent = (componentId) => {
    const cached = componentMemo.get(componentId);
    if (cached) return cached;
    const out = new Set();
    for (const target of componentDeps[componentId]) {
      out.add(target);
      for (const reachable of visitComponent(target)) out.add(reachable);
    }
    componentMemo.set(componentId, out);
    return out;
  };

  return (file) => {
    const componentId = componentOf.get(file);
    if (componentId === undefined) return new Set();
    const out = new Set(components[componentId]);
    out.delete(file);
    for (const reachable of visitComponent(componentId)) {
      for (const member of components[reachable]) out.add(member);
    }
    return out;
  };
}

/** @typedef {{ mode: 'related' | 'full', selected: Set<string>, total: number, reason?: string,
 * changedSet?: Set<string>, reach?: (file: string) => Set<string>, unresolved?: Set<string> }} StaticSelection */

/** Compute the static candidate superset and closure once for a prebuilt graph index.
 * @returns {StaticSelection}
 */
function collectStaticSelection({ rootDir, changedPaths, idx }) {
  const testFiles = idx.files.filter(isTestFile);
  const total = testFiles.length;
  const full = (reason) => ({ mode: "full", selected: new Set(), total, reason });

  if (total === 0) return full("no-test-files");

  // Only changed paths INSIDE this root can be resolved against this index. A
  // change elsewhere (another package) that made this workspace affected cannot be
  // narrowed here — run everything, even when the batch also contains local paths.
  // Dropping the external paths in a mixed batch can omit their importing tests;
  // bare package edges and transitive sources outside this index remain unindexed.
  const inScope = changedPaths.filter(
    (p) => p.startsWith(rootDir + path.sep) || p === rootDir,
  );
  if (inScope.length === 0) return full("no-changed-paths-in-scope");
  if (inScope.length !== changedPaths.length) return full("changed-paths-outside-scope");

  const changedSet = new Set(inScope);
  const reach = transitiveDeps(idx);
  const selected = new Set();

  for (const t of testFiles) {
    // A changed test file always selects itself, even if nothing imports it.
    if (changedSet.has(t)) {
      selected.add(t);
      continue;
    }
    // A file with an unresolved intra-repo import is a hole in the graph: assume it
    // could reach the change.
    if (idx.unresolved.has(t)) {
      selected.add(t);
      continue;
    }
    const deps = reach(t);
    for (const c of changedSet) {
      if (deps.has(c)) {
        selected.add(t);
        break;
      }
    }
  }

  if (selected.size === 0) return full("empty-selection");
  return { mode: "related", selected, total, changedSet, reach, unresolved: idx.unresolved };
}

/**
 * Build the graph index and static candidate superset once. Callers can query a scoped executed
 * map for `selection.selected`, then pass this same prepared value to `selectRelatedTests`.
 *
 * @param {object}                 o
 * @param {string}                 o.rootDir
 * @param {string[]}               o.changedPaths
 * @param {RelatedIndex | null}    [o.index]
 * @param {TsconfigPathEntry[]}    [o.aliases]
 * @param {RelatedFs}              [o.fs]
 * @returns {{ index: RelatedIndex, selection: StaticSelection }}
 */
export function prepareRelatedTestSelection({ rootDir, changedPaths, index = null, aliases = [], fs = defaultFs() } = {}) {
  const idx = index ?? buildIndex({ rootDir, aliases, fs });
  return { index: idx, selection: collectStaticSelection({ rootDir, changedPaths, idx }) };
}

/**
 * Select the test files that a change to `changedPaths` could affect.
 *
 * `mode` is `'related'` only when we are confident the subset is sound; every other
 * outcome is `'full'`, meaning the caller should run the whole suite. `reason`
 * always says which rail fired, so a collapse to "0 tests" can never be silent.
 *
 * @param {object}                 [o]
 * @param {string}                 o.rootDir        absolute dir to index (a workspace's source root)
 * @param {string[]}               o.changedPaths   absolute paths that changed
 * @param {TsconfigPathEntry[]}    [o.aliases]      `tsconfigPathEntriesFor` entries
 * @param {number}                 [o.threshold]    share of the suite at/above which the selection is
 *                                                  widened to the whole suite (default: the
 *                                                  `AFFECTED_RELATED_THRESHOLD` env, else
 *                                                  RELATED_WIDEN_THRESHOLD_DEFAULT)
 * @param {RelatedFs}              [o.fs]           filesystem seam (injected in tests)
 * @param {RelatedIndex | null}    [o.index]        prebuilt index, to avoid re-walking the tree
 * @param {ExecutedMap | null}     [o.executedMap]  P-002: per-test-file executed-source map (see
 *                                                  pruneWithExecutedMap); absent ⇒ no pruning
 * @param {string | null}          [o.judgedSha]    P-002: the sha this selection is judged at
 * @param {ChangedBetween | null}  [o.changedBetween] P-002: (recordedSha, judgedSha) ⇒ absolute
 *                                                  paths that changed between them, or null when
 *                                                  the pair cannot be diffed (⇒ treated as stale)
 * @param {{ index: RelatedIndex, selection: StaticSelection } | null} [o.prepared] static selection from `prepareRelatedTestSelection`
 * @returns {{ mode: 'related' | 'full', selected: string[], total: number, reason: string, threshold: number, executedMap: ExecutedMapSummary }}
 */
export function selectRelatedTests({
  rootDir,
  changedPaths,
  aliases = [],
  threshold = resolveRelatedWidenThreshold().threshold,
  fs = defaultFs(),
  index = null,
  executedMap = null,
  judgedSha = null,
  changedBetween = null,
  prepared = null,
} = {}) {
  const noMap = executedMapSummaryInert("not-reached");
  const ready = prepared ?? prepareRelatedTestSelection({ rootDir, changedPaths, aliases, fs, index });
  const { index: idx, selection: staticSelection } = ready;
  const { total } = staticSelection;
  if (staticSelection.mode !== "related") {
    return { mode: "full", selected: [], total, reason: staticSelection.reason, threshold, executedMap: noMap };
  }
  const { selected, changedSet, reach, unresolved } = staticSelection;

  // P-002: the static closure above is the SUPERSET; an executed-source map can only remove
  // hub-fan-out over-selection from it, and only for a test whose map is provably current.
  const pruning = pruneWithExecutedMap({
    selected,
    changedSet,
    reach,
    unresolved: idx.unresolved,
    executedMap,
    judgedSha,
    changedBetween,
  });
  const narrowed = pruning.selected;

  // P-001: this is a COST rule, not a soundness rail — the selection above is complete at any
  // share. It fires only when the subset is so close to the whole suite that the explicit file
  // list is pure overhead (see RELATED_WIDEN_THRESHOLD_DEFAULT).
  if (narrowed.size >= total * threshold) {
    return {
      mode: "full",
      selected: [],
      total,
      reason: `over-threshold(${narrowed.size}/${total})`,
      threshold,
      executedMap: pruning.summary,
    };
  }

  return {
    mode: "related",
    selected: [...narrowed].sort(),
    total,
    reason: "ok",
    threshold,
    executedMap: pruning.summary,
  };
}

// ── EXECUTED-SOURCE PRUNING (same plan, P-002) ─────────────────────────────────────────
// The static index over-selects through hubs: a barrel that re-exports half the package puts
// most tests in the closure of most files, so a one-file change still selects thousands of
// tests that never load it. vitest knows which modules a test file ACTUALLY executed
// (`TestModule.diagnostic().importDurations`, recorded per test file by
// libs/test-config/src/executed-source-map-reporter.ts and persisted in
// harness_shared.test_executed_sources keyed by workspace + test file + recorded sha). That
// observation can only ever be used to REMOVE a test from the static selection, and only
// when three things hold at once:
//   (a) an executed map exists for the test — and lists the test file itself, which proves the
//       entry came from a run of THIS file rather than a stale or foreign row;
//   (b) nothing in the test's static closure (the test included) changed between the sha the
//       map was recorded at and the sha being judged — otherwise the recorded set may be
//       missing an import that exists now, and the map is STALE;
//   (c) the executed set does not intersect the change.
// Every question the rule cannot answer keeps the test (an unknown drift, a missing entry,
// an empty or self-less executed set), and a prune that would empty the selection is refused
// outright — a change every candidate test executes around is far more likely a recording
// gap than proof that nothing covers it. The summary reports which rail kept what, so a
// selection that did not narrow can never be silent about why.

/**
 * @typedef {{ recordedSha: string, executed: Set<string> | string[] }} ExecutedEntry
 *   `executed` holds ABSOLUTE module paths (the same shape as `changedPaths`).
 * @typedef {Map<string, ExecutedEntry>} ExecutedMap keyed by ABSOLUTE test-file path
 * @typedef {(recordedSha: string, judgedSha: string) => Iterable<string> | null} ChangedBetween
 *   absolute paths changed between the two shas; `null` when the pair cannot be diffed.
 * @typedef {{
 *   applied: boolean,
 *   reason: string | null,
 *   entries: number,
 *   pruned: number,
 *   prunable: number,
 *   wouldEmpty: boolean,
 *   kept: { changedTest: number, unresolved: number, noEntry: number, untrusted: number,
 *           unknownDrift: number, stale: number, intersects: number },
 * }} ExecutedMapSummary
 */

/** @param {string} reason @returns {ExecutedMapSummary} */
function executedMapSummaryInert(reason) {
  return {
    applied: false,
    reason,
    entries: 0,
    pruned: 0,
    prunable: 0,
    wouldEmpty: false,
    kept: {
      changedTest: 0,
      unresolved: 0,
      noEntry: 0,
      untrusted: 0,
      unknownDrift: 0,
      stale: 0,
      intersects: 0,
    },
  };
}

/**
 * Apply the P-002 pruning rule to a static selection. Pure: every input is a value or a seam.
 *
 * @param {object}                        o
 * @param {Set<string>}                   o.selected       statically selected tests (absolute)
 * @param {Set<string>}                   o.changedSet     in-scope changed paths (absolute)
 * @param {(file: string) => Set<string>} o.reach          transitive static closure, excluding the file
 * @param {Set<string>}                   o.unresolved     files with an unresolved intra-repo import
 * @param {ExecutedMap | null | undefined} o.executedMap
 * @param {string | null | undefined}     o.judgedSha
 * @param {ChangedBetween | null | undefined} o.changedBetween
 * @returns {{ selected: Set<string>, summary: ExecutedMapSummary }}
 */
export function pruneWithExecutedMap({
  selected,
  changedSet,
  reach,
  unresolved,
  executedMap,
  judgedSha,
  changedBetween,
}) {
  if (!executedMap || typeof executedMap.get !== "function" || executedMap.size === 0) {
    return { selected, summary: executedMapSummaryInert("no-map") };
  }
  if (typeof judgedSha !== "string" || judgedSha.length === 0) {
    return { selected, summary: executedMapSummaryInert("no-judged-sha") };
  }
  if (typeof changedBetween !== "function") {
    return { selected, summary: executedMapSummaryInert("no-drift-seam") };
  }

  const summary = executedMapSummaryInert(null);
  summary.applied = true;
  summary.entries = executedMap.size;

  /** @type {Map<string, Set<string> | null>} */
  const driftCache = new Map();
  const driftFor = (recordedSha) => {
    if (recordedSha === judgedSha) return new Set();
    if (!driftCache.has(recordedSha)) {
      let drift = null;
      try {
        const raw = changedBetween(recordedSha, judgedSha);
        drift = raw == null ? null : new Set(raw);
      } catch {
        drift = null;
      }
      driftCache.set(recordedSha, drift);
    }
    return driftCache.get(recordedSha);
  };

  const kept = new Set();
  for (const t of selected) {
    // A changed test always runs — the map has nothing to say about a file that moved.
    if (changedSet.has(t)) {
      kept.add(t);
      summary.kept.changedTest += 1;
      continue;
    }
    // A graph hole is kept by the static rail for a reason the map cannot overrule.
    if (unresolved.has(t)) {
      kept.add(t);
      summary.kept.unresolved += 1;
      continue;
    }
    const entry = executedMap.get(t);
    if (!entry || typeof entry.recordedSha !== "string" || entry.recordedSha.length === 0) {
      kept.add(t);
      summary.kept.noEntry += 1;
      continue;
    }
    const executed = entry.executed instanceof Set ? entry.executed : new Set(entry.executed ?? []);
    // (a) an entry that does not list the test file itself did not come from a run of it.
    if (executed.size === 0 || !executed.has(t)) {
      kept.add(t);
      summary.kept.untrusted += 1;
      continue;
    }
    // (b) the recorded map must still describe THIS closure.
    const drift = driftFor(entry.recordedSha);
    if (drift === null) {
      kept.add(t);
      summary.kept.unknownDrift += 1;
      continue;
    }
    if (drift.size > 0) {
      let stale = drift.has(t);
      if (!stale) {
        const closure = reach(t);
        for (const d of drift) {
          if (closure.has(d)) {
            stale = true;
            break;
          }
        }
      }
      if (stale) {
        kept.add(t);
        summary.kept.stale += 1;
        continue;
      }
    }
    // (c) a test that executed the change runs, whatever the static closure says.
    let intersects = false;
    for (const c of changedSet) {
      if (executed.has(c)) {
        intersects = true;
        break;
      }
    }
    if (intersects) {
      kept.add(t);
      summary.kept.intersects += 1;
      continue;
    }
    summary.prunable += 1;
  }

  if (kept.size === 0) {
    // Refuse to narrow to nothing: see the rationale above. The static selection stands.
    summary.wouldEmpty = true;
    summary.pruned = 0;
    return { selected, summary };
  }
  summary.pruned = summary.prunable;
  return { selected: kept, summary };
}
