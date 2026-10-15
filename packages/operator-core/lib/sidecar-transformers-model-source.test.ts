/**
 * sidecar-transformers-model-source.test.ts — the guard for EI-22077502575226404.
 *
 * THE BUG. build-desktop-sidecar.sh's WI-5638 / D-178 model check is fail-closed in both
 * directions: exactly the two owner-confirmed ONNX models must be present at the relocated
 * `models/onnx-community/` path, and nothing else. The check is correct; nothing SOURCED
 * the models. They are ~5.1G of RUNTIME downloads into `<transformers>/.cache/onnx-community`
 * that only appear once the host has actually embedded something, and `npm ci` never fetches
 * them — so an ordinary build passed only IMPLICITLY, by running in a host tree whose cache
 * happened to be warm, while a pristine clone (the D-074 clean-source bar) got an empty
 * `.cache`, the D-178 relocation was a no-op, and the build died on the presence check.
 * Measured: P-101 build #3 (task 0mtitqt8x9gpi5thk05) exit 5.
 *
 * THE FIX under test: `bin/lib/transformers-models.sh`, an opt-in source step gated on
 * PAPERCUSP_TRANSFORMERS_MODEL_CACHE. The two properties that matter are opposites, so both
 * are asserted here — it must STAGE the models when a build opts in, and it must change
 * NOTHING when a build does not, because the fail-closed FATAL is the correct outcome for a
 * build that never asked for sourcing.
 *
 * These drive the real helper through its script dispatcher (the lib/pinned-deps.sh
 * contract) rather than text-matching it, so a refusal's exit code and operator-facing
 * message are part of what is verified. Fixtures are byte-sized stand-ins for the weights.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

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
const HELPER_PATH =
  process.env.PAPERCUSP_TRANSFORMERS_MODELS_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'transformers-models.sh');
const BUILD_SCRIPT_PATH =
  process.env.PAPERCUSP_SIDECAR_BUILD_SCRIPT_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

const MODELS = ['harrier-oss-v1-0.6b-ONNX', 'embeddinggemma-300m-ONNX'] as const;

/** Comments never count — a rule a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const scratch: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transformers-models-'));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A model directory as the runtime downloader leaves it. `weights:false` reproduces the
 * fragments-only shape an interrupted download leaves behind — the case a bare presence
 * check cannot tell from a finished model.
 */
function makeModel(
  root: string,
  name: string,
  opts: { weights?: boolean; fragments?: boolean; shards?: number } = {},
): void {
  const { weights = true, fragments = false, shards = 1 } = opts;
  const dir = join(root, name, 'onnx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.onnx'), weights ? 'onnx-graph' : '');
  if (weights) {
    for (let i = 0; i < shards; i++) {
      write(join(dir, i === 0 ? 'model.onnx_data' : `model.onnx_data_${i}`), `shard-${i}`);
    }
  }
  if (fragments) {
    write(join(dir, 'model.onnx_data.tmp.657875.18f1gd2'), 'partial-bytes');
    write(join(dir, 'model.onnx_data.partial'), 'partial-bytes');
  }
  // A config file so the copy has something beside the weights to carry across.
  write(join(root, name, 'config.json'), '{"model_type":"test"}');
}

function pinnedContract(root: string, modelRoot: string): string {
  const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const filesFor = (name: string) => {
    const base = join(modelRoot, name);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
    return walk(base)
      .filter((path) => !/\.tmp\.|\.partial$|\.part$/u.test(path))
      .map((path) => ({
        path: path.slice(base.length + 1).replaceAll('\\', '/'),
        bytes: statSync(path).size,
        sha256: sha256(path),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };
  const path = join(root, 'distribution-contract.json');
  writeFileSync(path, JSON.stringify({
    server: {
      optionalPacks: [{
        name: 'local-models',
        required: true,
        cachePolicy: {
          mode: 'installed-local-only',
          remoteFetch: 'forbidden-on-vm-release',
          readyWhen: 'every-declared-file-matches-size-and-sha256',
          missingOrCorrupt: 'refuse-startup',
          recovery: 'replace-with-a-signed-runtime-containing-the-declared-pack',
        },
        compatibility: {
          transformersPackage: '4.2.0',
          executionProvider: 'cpu',
          runtimeDefaults: ['harrier', 'gemma'],
        },
        models: MODELS.map((name, index) => ({
          mode: index === 0 ? 'harrier' : 'gemma',
          runtimeId: `onnx-community/${name}`,
          revision: String(index + 1).repeat(40),
          nativeDimensions: index === 0 ? 1024 : 768,
          files: filesFor(name),
        })),
      }],
    },
  }));
  return path;
}

function runHelper(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string; err: string } {
  // WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it out.
  const r = spawnSync('bash', [HELPER_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, PAPERCUSP_TRANSFORMERS_MODEL_CACHE: '', ...env },
  });
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

describe('transformers model sourcing — the opt-in step a pristine-clone build needs', () => {
  it('does NOTHING when no build opted in — the fail-closed FATAL stays the correct outcome', () => {
    const t = fixture();
    const modelsRoot = join(t, 'models');
    mkdirSync(modelsRoot, { recursive: true });

    const r = runHelper(['stage', modelsRoot]);

    expect(r.code, r.err).toBe(0);
    // Non-vacuity: staging did not merely fail quietly — it declined to create anything,
    // leaving the downstream presence check to produce the same verdict as before.
    expect(existsSync(join(modelsRoot, 'onnx-community'))).toBe(false);
    expect(r.out).not.toContain('staged transformers models');
  });

  it('stages both models when a build points it at a cache', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(src, m, { shards: 2 });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(readFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'utf8')).toBe(
        'onnx-graph',
      );
      // The external-data shards are the bulk of the model; a copy that dropped them would
      // still pass a directory-presence check.
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx_data'))).toBe(true);
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx_data_1'))).toBe(true);
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'config.json'))).toBe(true);
    }
  });

  it('accepts a source dir that IS onnx-community, or its parent', () => {
    const t = fixture();
    const cacheParent = join(t, 'cache');
    for (const m of MODELS) makeModel(join(cacheParent, 'onnx-community'), m);

    const modelsRoot = join(t, 'models');
    const r = runHelper(['stage', modelsRoot], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: cacheParent,
    });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(existsSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'))).toBe(true);
    }
  });

  it('never ships download fragments — they are real, not hypothetical, in a live cache', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(src, m, { fragments: true });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      const onnx = join(modelsRoot, 'onnx-community', m, 'onnx');
      expect(existsSync(join(onnx, 'model.onnx_data.tmp.657875.18f1gd2'))).toBe(false);
      expect(existsSync(join(onnx, 'model.onnx_data.partial'))).toBe(false);
      // ...while the finished weights beside them still crossed.
      expect(existsSync(join(onnx, 'model.onnx_data'))).toBe(true);
    }
  });

  it('does not mistake an atomic .tmp.<pid> parent for a fragment filename', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    // This is the real build shape: build-desktop-sidecar.sh always stages beneath
    // `${SIDECAR_FINAL_DIR}.tmp.$$`. The fragment classifier must inspect only the
    // filename, or every final model.onnx_data shard under this parent is rejected.
    const modelsRoot = join(t, 'darwin-sidecar.tmp.385594', 'node_modules', '@huggingface', 'transformers', 'models');
    for (const m of MODELS) makeModel(src, m, { fragments: true, shards: 2 });

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      const onnx = join(modelsRoot, 'onnx-community', m, 'onnx');
      expect(existsSync(join(onnx, 'model.onnx_data'))).toBe(true);
      expect(existsSync(join(onnx, 'model.onnx_data_1'))).toBe(true);
      expect(existsSync(join(onnx, 'model.onnx_data.tmp.657875.18f1gd2'))).toBe(false);
      expect(existsSync(join(onnx, 'model.onnx_data.partial'))).toBe(false);
    }
  });

  it('REFUSES a fragments-only source rather than staging an interrupted download', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const modelsRoot = join(t, 'models');
    makeModel(src, MODELS[0], { weights: false, fragments: true });
    makeModel(src, MODELS[1]);

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src });

    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no final ONNX weights');
    expect(existsSync(join(modelsRoot, 'onnx-community', MODELS[0]))).toBe(false);
  });

  it('REFUSES a source missing one of the two owner-confirmed models', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    makeModel(src, MODELS[0]);

    const r = runHelper(['stage', join(t, 'models')], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src,
    });

    expect(r.code).not.toBe(0);
    expect(r.err).toContain(MODELS[1]);
  });

  it('REFUSES an opt-in that points nowhere, instead of silently no-opting', () => {
    const t = fixture();
    const r = runHelper(['stage', join(t, 'models')], {
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: join(t, 'does-not-exist'),
    });

    // A silent no-op here would be worse than the original bug: the build would still
    // FATAL downstream, but naming the wrong cause.
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('PAPERCUSP_TRANSFORMERS_MODEL_CACHE');
  });

  it('leaves an already-staged tree alone — a host build never silently prefers an outside copy', () => {
    const t = fixture();
    const modelsRoot = join(t, 'models');
    for (const m of MODELS) makeModel(join(modelsRoot, 'onnx-community'), m);
    for (const m of MODELS) {
      writeFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'ALREADY-STAGED');
    }
    const other = join(t, 'other-cache', 'onnx-community');
    for (const m of MODELS) makeModel(other, m);

    const r = runHelper(['stage', modelsRoot], { PAPERCUSP_TRANSFORMERS_MODEL_CACHE: other });

    expect(r.code, r.err).toBe(0);
    for (const m of MODELS) {
      expect(
        readFileSync(join(modelsRoot, 'onnx-community', m, 'onnx', 'model.onnx'), 'utf8'),
      ).toBe('ALREADY-STAGED');
    }
  });

  it('vm-release stages only the exact pinned pack and emits its runtime manifest', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const transformersRoot = join(t, 'transformers');
    const modelsRoot = join(transformersRoot, 'models');
    for (const m of MODELS) makeModel(src, m, { fragments: true, shards: m === MODELS[0] ? 2 : 1 });
    mkdirSync(transformersRoot, { recursive: true });
    writeFileSync(
      join(transformersRoot, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '4.2.0' }),
    );
    const contract = pinnedContract(t, src);

    const r = runHelper(['stage', modelsRoot], {
      PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
      PAPERCUSP_TRANSFORMERS_DISTRIBUTION_CONTRACT: contract,
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src,
    });

    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('"status": "ready"');
    const emitted = JSON.parse(
      readFileSync(join(modelsRoot, 'papercusp-model-assets.json'), 'utf8'),
    );
    expect(emitted).toMatchObject({
      schemaVersion: 1,
      pack: 'local-models',
      required: true,
      cachePolicy: { remoteFetch: 'forbidden-on-vm-release' },
      compatibility: { transformersPackage: '4.2.0', runtimeDefaults: ['harrier', 'gemma'] },
    });
    expect(emitted.models.map((model: { runtimeId: string }) => model.runtimeId).sort()).toEqual(
      MODELS.map((name) => `onnx-community/${name}`).sort(),
    );
  });

  it('vm-release refuses a corrupt pinned source before copying it', () => {
    const t = fixture();
    const src = join(t, 'cache', 'onnx-community');
    const transformersRoot = join(t, 'transformers');
    const modelsRoot = join(transformersRoot, 'models');
    for (const m of MODELS) makeModel(src, m);
    mkdirSync(transformersRoot, { recursive: true });
    writeFileSync(
      join(transformersRoot, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '4.2.0' }),
    );
    const contract = pinnedContract(t, src);
    writeFileSync(join(src, MODELS[1], 'onnx/model.onnx_data'), 'tampered-after-pin');

    const r = runHelper(['stage', modelsRoot], {
      PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
      PAPERCUSP_TRANSFORMERS_DISTRIBUTION_CONTRACT: contract,
      PAPERCUSP_TRANSFORMERS_MODEL_CACHE: src,
    });

    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/(?:size|sha256) mismatch/);
    expect(existsSync(join(modelsRoot, 'onnx-community'))).toBe(false);
  });
});

describe('transformers dependency identity matches the pinned model contract before packaging', () => {
  function dependencyFixture(): { root: string; contract: string } {
    const root = fixture();
    const modelRoot = join(root, 'cache', 'onnx-community');
    for (const model of MODELS) makeModel(modelRoot, model);
    write(join(root, 'apps/operator/package.json'), JSON.stringify({
      dependencies: { '@huggingface/transformers': '4.2.0' },
    }));
    write(join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'apps/operator': { dependencies: { '@huggingface/transformers': '4.2.0' } },
        'node_modules/@huggingface/transformers': { version: '4.2.0' },
      },
    }));
    write(join(root, 'node_modules/@huggingface/transformers/package.json'), JSON.stringify({
      name: '@huggingface/transformers',
      version: '4.2.0',
    }));
    return { root, contract: pinnedContract(root, modelRoot) };
  }

  function verifyDependencies(root: string, contract: string, installed = false) {
    return runHelper(['dependencies', root, installed ? '1' : '0'], {
      PAPERCUSP_TRANSFORMERS_DISTRIBUTION_CONTRACT: contract,
    });
  }

  it('binds exact declarations, lock resolution and installed package identity', () => {
    const { root, contract } = dependencyFixture();
    const result = verifyDependencies(root, contract, true);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true, transformersPackage: '4.2.0', consumers: ['apps/operator'], installedChecked: true,
    });
  });

  it('refuses the real failure class: a newer locked version with otherwise valid model bytes', () => {
    const { root, contract } = dependencyFixture();
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/@huggingface/transformers'].version = '4.3.1';
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = verifyDependencies(root, contract);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('expects 4.2.0, got 4.3.1');
  });

  it('accepts an exact workspace-local lock and installed resolution without assuming root hoisting', () => {
    const { root, contract } = dependencyFixture();
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const localPath = 'apps/operator/node_modules/@huggingface/transformers';
    lock.packages[localPath] = lock.packages['node_modules/@huggingface/transformers'];
    delete lock.packages['node_modules/@huggingface/transformers'];
    writeFileSync(lockPath, JSON.stringify(lock));
    const installed = readFileSync(join(root, 'node_modules/@huggingface/transformers/package.json'));
    rmSync(join(root, 'node_modules'), { recursive: true });
    write(join(root, localPath, 'package.json'), installed.toString());
    const result = verifyDependencies(root, contract, true);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).resolutions).toEqual({ 'apps/operator': localPath });
  });

  it('refuses an untracked nearer installed package shadowing the locked resolution', () => {
    const { root, contract } = dependencyFixture();
    write(join(root, 'apps/operator/node_modules/@huggingface/transformers/package.json'), JSON.stringify({
      name: '@huggingface/transformers', version: '4.2.0',
    }));
    const result = verifyDependencies(root, contract, true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('installed resolution from apps/operator expects node_modules/');
  });

  it('refuses a floating workspace dependency even when its current lock matches', () => {
    const { root, contract } = dependencyFixture();
    write(join(root, 'apps/operator/package.json'), JSON.stringify({
      dependencies: { '@huggingface/transformers': '^4.2.0' },
    }));
    const result = verifyDependencies(root, contract);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('package declaration apps/operator must pin 4.2.0');
  });

  it('refuses floating declarations stored in the lock itself', () => {
    const { root, contract } = dependencyFixture();
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['apps/operator'].dependencies['@huggingface/transformers'] = '^4.2.0';
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = verifyDependencies(root, contract);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('lock declaration apps/operator must pin 4.2.0');
  });

  it('defers installed identity until dependency preparation, then refuses installed drift', () => {
    const { root, contract } = dependencyFixture();
    write(join(root, 'node_modules/@huggingface/transformers/package.json'), JSON.stringify({
      name: '@huggingface/transformers', version: '4.3.1',
    }));
    expect(verifyDependencies(root, contract).code).toBe(0);
    const result = verifyDependencies(root, contract, true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('installed package expects @huggingface/transformers@4.2.0');
  });

  it('refuses a missing installed package when the installed check is requested', () => {
    const { root, contract } = dependencyFixture();
    rmSync(join(root, 'node_modules'), { recursive: true });
    expect(verifyDependencies(root, contract).code).toBe(0);
    const result = verifyDependencies(root, contract, true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('cannot read');
  });

  it('refuses an incompatible nested lock resolution', () => {
    const { root, contract } = dependencyFixture();
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/consumer/node_modules/@huggingface/transformers'] = { version: '4.3.1' };
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = verifyDependencies(root, contract);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('node_modules/consumer/node_modules/@huggingface/transformers');
  });

  it('refuses a malformed or absent lock instead of accepting an empty census', () => {
    const { root, contract } = dependencyFixture();
    write(join(root, 'package-lock.json'), '{}');
    expect(verifyDependencies(root, contract).code).not.toBe(0);
    rmSync(join(root, 'package-lock.json'));
    expect(verifyDependencies(root, contract).code).not.toBe(0);
  });

  it('checks the lock before source capture and installed identity before the SPA build', () => {
    const script = codeOnly(readFileSync(BUILD_SCRIPT_PATH, 'utf8'));
    const lockCheck = script.indexOf('papercusp_verify_transformers_dependencies "$REPO_ROOT" 0');
    const installedCheck = script.indexOf('papercusp_verify_transformers_dependencies "$REPO_ROOT" 1');
    expect(lockCheck).toBeGreaterThan(0);
    expect(lockCheck).toBeLessThan(script.indexOf('--capture-source'));
    expect(installedCheck).toBeGreaterThan(lockCheck);
    expect(installedCheck).toBeLessThan(script.indexOf('VITE_BUILD_SNAPSHOT_DIR='));
  });

  it('the real producer refuses incompatible source inputs before capture or expensive work', () => {
    const { root, contract } = dependencyFixture();
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/@huggingface/transformers'].version = '4.3.1';
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = spawnSync('bash', [BUILD_SCRIPT_PATH], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        REPO_ROOT: root,
        PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
        PAPERCUSP_BUILD_SHA: '1'.repeat(40),
        PAPERCUSP_DESKTOP_VERSION: '0.0.26',
        PAPERCUSP_TRANSFORMERS_DISTRIBUTION_CONTRACT: contract,
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('expects 4.2.0, got 4.3.1');
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/capture-source|npm install|building operator-vite|esbuild-bundling/);
  });

  it('the repository declarations and committed lock match the real model contract', () => {
    const result = runHelper(['dependencies', ROOT]);
    expect(result.code, result.err).toBe(0);
  });
});

describe('the sourcing step is wired into the sidecar build, and its model list cannot drift', () => {
  it('build-desktop-sidecar.sh sources the helper and calls the staging step', () => {
    const script = codeOnly(readFileSync(BUILD_SCRIPT_PATH, 'utf8'));
    expect(script).toContain('lib/transformers-models.sh');
    expect(script).toContain('papercusp_stage_transformers_models');
  });

  it('the transformers branch is NOT gated on a .cache dir existing — that gate WAS the bug', () => {
    // A pristine clone has no `.cache` at all. While the branch was conditioned on one,
    // there was no code path that could ever source the models: the relocation had nothing
    // to relocate and nothing else ran. Restoring that `&& -d "$_transformers_cache"`
    // reinstates the bug verbatim, so it is exactly what this pins.
    const script = readFileSync(BUILD_SCRIPT_PATH, 'utf8');
    expect(script).toContain('if [[ "$cur" == "@huggingface/transformers" ]]; then');
    expect(script).not.toContain('"$cur" == "@huggingface/transformers" && -d "$_transformers_cache"');
    // ...and the staging call really is inside that branch rather than orphaned elsewhere.
    const branch = script.indexOf('if [[ "$cur" == "@huggingface/transformers" ]]; then');
    const call = script.indexOf('papercusp_stage_transformers_models "$_transformers_models"');
    expect(call).toBeGreaterThan(branch);
  });

  it('the helper grades exactly the models the build script requires', () => {
    const names = runHelper(['names']).out.trim().split('\n').filter(Boolean).sort();
    const script = readFileSync(BUILD_SCRIPT_PATH, 'utf8');
    const required = /for _required_model in ([^\n;]+); do/.exec(script);

    // If the presence-check loop is ever restructured this regex stops matching, and the
    // failure is the point: the two lists are hand-maintained copies of one fact, so the
    // pin has to break loudly rather than quietly stop comparing anything.
    expect(required, 'could not find the presence-check loop in build-desktop-sidecar.sh').not.toBeNull();
    expect(names).toEqual(required![1]!.trim().split(/\s+/).sort());
    expect(names).toEqual([...MODELS].sort());
    const contract = JSON.parse(
      readFileSync(join(ROOT, 'papercusp-desktop', 'src-tauri', 'distribution-contract.json'), 'utf8'),
    );
    const pack = contract.server.optionalPacks.find((candidate: { name: string }) => candidate.name === 'local-models');
    expect(pack.required).toBe(true);
    expect(pack.cachePolicy).toMatchObject({
      remoteFetch: 'forbidden-on-vm-release',
      missingOrCorrupt: 'refuse-startup',
    });
    expect(pack.models.map((model: { runtimeId: string }) => model.runtimeId.split('/').at(-1)).sort()).toEqual(names);
  });
});
