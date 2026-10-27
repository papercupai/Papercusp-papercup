#!/usr/bin/env node
/**
 * Native-Node bridge for lint:tests' resolved Vitest include/exclude audit.
 *
 * The caller batches every distinct route config into one stdin payload. Keep
 * stdout tolerant of config-module chatter: the final marker is the only
 * machine-readable line the caller consumes.
 */

import { createVitest, resolveConfig } from 'vitest/node';
import { glob } from 'tinyglobby';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { vitestConfigLoaderPolicy } from './test-files.mjs';

const MARKER = 'PC_VITEST_CONFIG_CONTRACTS=';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const input = JSON.parse(await readStdin());
const requests = Array.isArray(input.requests) ? input.requests : [];
const results = [];

// Astro sync owns process-global content state. Each workspace uses a fresh
// process, then the exact installed checker population after sync. Discovery
// never runs diagnostics; its original `astro check` remains an obligation.
if (process.argv.includes('--astro-selection-child')) {
  const request = requests[0];
  const phaseStartedAt = Date.now();
  const phases = {};
  let currentPhase = 'resolve-dependencies';
  const enterPhase = name => {
    currentPhase = name;
    process.stdout.write(`ASTRO_SELECTION_PHASE=${JSON.stringify({ phase: name, elapsedMs: Date.now() - phaseStartedAt })}\n`);
  };
  const phase = (name, startedAt) => { phases[name] = Date.now() - startedAt; };
  try {
    if (requests.length !== 1 || request.runner !== 'astro-check' || request.syncBeforeCheck !== true)
      throw new Error('astro-sync-not-requested');
    process.chdir(request.root);
    process.env.NODE_ENV = 'production';
    const workspaceRequire = createRequire(resolve(request.root, 'package.json'));
    const astroPackage = workspaceRequire.resolve('astro/package.json');
    const checkModule = workspaceRequire.resolve('@astrojs/check');
    const checkRequire = createRequire(checkModule);
    const languageServerModule = checkRequire.resolve('@astrojs/language-server');
    const typescriptModule = checkRequire.resolve('typescript');
    const syncModule = resolve(dirname(astroPackage), 'dist/core/sync/index.js');
    const { default: sync } = await import(pathToFileURL(syncModule).href);
    const syncStartedAt = Date.now();
    enterPhase('sync');
    await sync({});
    phase('syncMs', syncStartedAt);
    const { AstroCheck } = checkRequire('@astrojs/language-server');
    const checkerStartedAt = Date.now();
    enterPhase('checker');
    const checker = new AstroCheck(request.root, typescriptModule);
    phase('checkerMs', checkerStartedAt);
    // Same exclusion as AstroCheck.lint, not a source glob or a tsconfig approximation.
    const populationStartedAt = Date.now();
    enterPhase('population');
    const absoluteFiles = checker.linter.getRootFileNames()
      .filter(file => !file.endsWith('.vue') && !file.endsWith('.svelte'));
    phase('populationMs', populationStartedAt);
    enterPhase('input-hashes');
    const repositoryRoot = realpathSync(request.repositoryRoot ?? request.root);
    const repositoryPath = file => {
      const result = relative(repositoryRoot, realpathSync(file)).replaceAll('\\', '/');
      if (!result || isAbsolute(result) || result === '..' || result.startsWith('../'))
        throw new Error('astro-input-escapes-repository');
      return result;
    };
    // D-003: only this install's dependency store gets the existing lexical
    // node_modules representation. First-party population paths keep the fence.
    let installedModules;
    try { installedModules = realpathSync(resolve(repositoryRoot, 'node_modules')); } catch {}
    const producerPath = file => {
      const physical = realpathSync(file);
      const dependency = installedModules && relative(installedModules, physical).replaceAll('\\', '/');
      if (dependency && !isAbsolute(dependency) && dependency !== '..' && !dependency.startsWith('../'))
        return `node_modules/${dependency}`;
      // lint:as-committed mirrors package directories and links their contents.
      // Accept a producer alias only when this install resolves it to this file.
      const marker = '/node_modules/';
      for (let index = physical.indexOf(marker); index >= 0; index = physical.indexOf(marker, index + 1)) {
        const alias = `node_modules/${physical.slice(index + marker.length)}`;
        try { if (realpathSync(resolve(repositoryRoot, alias)) === physical) return alias; } catch {}
      }
      return repositoryPath(file);
    };
    const files = [...new Set(absoluteFiles.map(repositoryPath))].sort();
    if (!files.length || files.length !== absoluteFiles.length) throw new Error('invalid-astro-file-population');
    const producerFiles = [astroPackage, checkModule, syncModule, languageServerModule, typescriptModule,
      resolve(dirname(languageServerModule), 'check.js'),
      resolve(dirname(astroPackage), 'dist/cli/check/index.js'), resolve(request.root, 'package.json'),
      ...(checker.getTsconfig() ? [checker.getTsconfig()] : [])];
    const inputs = [...new Set([...files, ...producerFiles.map(producerPath)])].sort().map(file => ({
      path: file, sha256: createHash('sha256').update(readFileSync(resolve(repositoryRoot, file))).digest('hex'),
    }));
    results.push({ ok: true, enumerated: true, repositoryFiles: files, inputs,
      config: { runner: 'astro-check', tsconfig: checker.getTsconfig() ? repositoryPath(checker.getTsconfig()) : null },
      sync: { status: 'completed', beforePopulation: true },
      executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false,
      diagnostics: { phases, elapsedMs: Date.now() - phaseStartedAt, currentPhase: 'completed' } });
  } catch (error) {
    results.push({ ok: false, error: error instanceof Error ? error.message : String(error),
      diagnostics: { phases, elapsedMs: Date.now() - phaseStartedAt, currentPhase } });
  }
  process.stdout.write(`${MARKER}${JSON.stringify({ results })}\n`);
  process.exit(0);
}

for (const request of requests) {
  const cwd = process.cwd();
  const keys = ['PC_TEST_LANE', 'PC_TEST_FILTER_LIST', 'PC_TEST_REUSE_SKIP_LIST', 'PC_TEST_PARTIAL_SKIP_LIST', 'TEMPLATE_CHECKS_CONFIG'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    if (request.runner === 'astro-check') {
      let output;
      try {
        output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--astro-selection-child'], {
          cwd: request.root, input: JSON.stringify({ requests: [request] }), encoding: 'utf8',
          timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
        });
      } catch (error) {
        const tail = value => typeof value === 'string' ? value.slice(-4096) : undefined;
        results.push({ ok: false, error: error instanceof Error ? error.message : String(error),
          diagnostics: { childFailure: { code: error?.code, signal: error?.signal, status: error?.status,
            stdoutTail: tail(error?.stdout), stderrTail: tail(error?.stderr) } } });
        continue;
      }
      const marker = output.split(/\r?\n/).reverse().find(line => line.startsWith(MARKER));
      const child = marker && JSON.parse(marker.slice(MARKER.length)).results;
      if (!Array.isArray(child) || child.length !== 1) throw new Error('invalid-astro-discovery-receipt');
      results.push(child[0]);
      continue;
    }
    if (request.enumerateFiles) {
      // Configs derive lane membership from cwd, exactly as npm's workspace child does.
      process.chdir(request.root);
      for (const key of keys) delete process.env[key];
      for (const key of keys.filter(key => key !== 'PC_TEST_REUSE_SKIP_LIST' && key !== 'PC_TEST_PARTIAL_SKIP_LIST')) {
        if (request.env?.[key] !== undefined) process.env[key] = request.env[key];
      }
    }
    // Discovery must use the same source boundary as the maintained list/run
    // route. A bundled config transforms source before Node's committed-source
    // loader can judge it, even when discovery never imports a test module.
    const { configLoaderArgs } = vitestConfigLoaderPolicy([]);
    const configOptions = {
      root: request.root,
      config: request.config,
      ...(configLoaderArgs.length ? { configLoader: configLoaderArgs[1] } : {}),
    };
    // Unlike createVitest, resolveConfig does not forward configLoader from
    // its CLI options. Vite consumes this policy through the override argument.
    const { vitestConfig } = await resolveConfig(configOptions,
      configLoaderArgs.length ? { configLoader: configLoaderArgs[1] } : {});
    let files, repositoryFiles, projects, selectedSpecifications;
    if (request.enumerateFiles) {
      // Project inheritance, in-source detection and typecheck pools belong to
      // Vitest itself. Its specification glob does not collect or execute tests.
      if (request.enumerateSpecifications || vitestConfig.includeSource?.length || vitestConfig.typecheck?.enabled || vitestConfig.projects?.length) {
        let context;
        try {
          context = await createVitest('test', { ...configOptions, watch: false });
          const specifications = await context.globTestSpecifications();
          if (request.enumerateSpecifications) selectedSpecifications = specifications.map(spec => ({
            testFile: relative(request.repositoryRoot ?? request.root, spec.moduleId).replaceAll('\\', '/'),
            projectName: spec.project.name ?? null, pool: spec.pool,
            testNamePattern: spec.testNamePattern?.toString() ?? null,
            testLines: spec.testLines ? [...spec.testLines] : null,
            testIds: spec.testIds ? [...spec.testIds] : null,
            testTagsFilter: spec.testTagsFilter ? [...spec.testTagsFilter] : null,
          })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          projects = specifications.map(spec => ({ name: spec.project.name, pool: spec.pool,
            file: relative(request.repositoryRoot ?? request.root, spec.moduleId).replaceAll('\\', '/') }));
          const absoluteFiles = [...new Set(specifications.map(spec => spec.moduleId))];
          files = absoluteFiles.map(file => relative(request.root, file).replaceAll('\\', '/')).sort();
          if (request.repositoryRoot) repositoryFiles = absoluteFiles.map(file =>
            relative(request.repositoryRoot, file).replaceAll('\\', '/')).sort();
        } finally { await context?.close(); }
      } else {
      const base = vitestConfig.dir || vitestConfig.root;
      // Same glob engine and options as Vitest's TestProject.globFiles, without collection.
      const absoluteFiles = (await glob(vitestConfig.include, {
        dot: true, cwd: base, ignore: vitestConfig.exclude, expandDirectories: false,
      })).map(file => resolve(base, file));
      files = absoluteFiles.map(file => relative(request.root, file).replaceAll('\\', '/')).sort();
      if (request.repositoryRoot) {
        // Template suites deliberately own files outside their package, inside the repo.
        repositoryFiles = absoluteFiles.map(file => relative(request.repositoryRoot, file).replaceAll('\\', '/')).sort();
      }
      }
      if ((repositoryFiles ?? files).some(file => isAbsolute(file) || file === '..' || file.startsWith('../')))
        throw new Error('resolved test population escapes workspace');
    }
    results.push({
      ok: true,
      ...(files ? { files, enumerated: true } : {}),
      ...(repositoryFiles ? { repositoryFiles } : {}),
      ...(projects ? { projects } : {}),
      ...(selectedSpecifications ? { selectedSpecifications } : {}),
      config: {
        root: vitestConfig.root,
        ...(vitestConfig.dir ? { dir: vitestConfig.dir } : {}),
        include: vitestConfig.include,
        exclude: vitestConfig.exclude,
      },
    });
  } catch (error) {
    results.push({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (request.enumerateFiles) {
      process.chdir(cwd);
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }
}

process.stdout.write(`${MARKER}${JSON.stringify({ results })}\n`);
