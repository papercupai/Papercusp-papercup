/** Maintained build fixture shared by closure and private-PG admission controls. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleRepoRoot } from './module-repo-root';
import { createHash } from 'node:crypto';
import { captureVerifierDependencies, prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import { git, write } from './source-preview.fixture';

const checkoutRoot = moduleRepoRoot(import.meta.url);
const policy = join(checkoutRoot, 'apps/operator/bin/release/dependency-generation.sh');

export async function brokerSourceFixture(roots: string[], options: {
  gitCheckout?: boolean; omitAssets?: boolean; native?: boolean; nativeStorageRefused?: boolean;
} = {}) {
  const custodyRoot = mkdtempSync(join(tmpdir(), 'broker-generated-')); roots.push(custodyRoot);
  const repositoryRoot = join(custodyRoot, 'repo'), root = join(custodyRoot, 'source'); mkdirSync(repositoryRoot);
  write(repositoryRoot, 'package.json', JSON.stringify({ name: 'build-fixture', private: true, workspaces: ['apps/operator-vite'] }));
  write(repositoryRoot, 'apps/operator-vite/package.json', JSON.stringify({ name: '@papercusp/operator-vite',
    scripts: { prebuild: 'node ../operator/bin/build.cjs prebuild', build: 'node ../operator/bin/build.cjs spa' } }));
  write(repositoryRoot, 'apps/operator/bin/build.cjs', `
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
function put(p,s){p=path.join(root,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);}
if(process.argv[2]==='prebuild') {
 if(process.env.BROKER_HOST_SECRET || process.env.VITEST || process.env.PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE) process.exit(90);
 put('apps/operator/public/wake-runtime/runtime.js','measured prebuild');
} else if(process.argv[2]==='spa') {
 // Match vite-build-singleflight's output contract, including its override of
 // the lower-level PAPERCUSP_VITE_* variables.
 const output=path.join(process.env.VITE_BUILD_OUT_ROOT,'dist');
 fs.mkdirSync(path.join(output,'assets'),{recursive:true});
 fs.writeFileSync(path.join(output,'index.html'),'<html>measured spa</html>');
 if (${!options.omitAssets}) fs.writeFileSync(path.join(output,'assets/main.js'),'measured browser code');
} else put('apps/operator/dist-verify/hono-host.mjs','export const marker="measured host";');
`);
  write(repositoryRoot, 'apps/operator/scripts/setup-porcupine-runtime.sh', '#!/bin/bash\nset -eu\nmkdir -p apps/operator/public/porcupine\nprintf "measured model" > apps/operator/public/porcupine/porcupine_params.pv\n');
  write(repositoryRoot, 'apps/operator/bin/bundle-host.sh', '#!/bin/bash\nset -eu\nnode apps/operator/bin/build.cjs host\n');
  write(repositoryRoot, 'scripts/pc-heavy.sh', '#!/bin/bash\nset -eu\n[ "$1" != -- ] || shift\nexec "$@"\n');
  // Exercise the production tree population: a hard-coded root-only stub hid
  // the captured driver's nested node_modules from every build regression.
  write(repositoryRoot, 'papercusp-desktop/bin/lib/pinned-deps.sh',
    readFileSync(join(checkoutRoot, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'utf8'));
  write(repositoryRoot, 'apps/operator/bin/release/dependency-generation.sh', readFileSync(policy, 'utf8'));
  if (options.native) {
    write(repositoryRoot, 'papercusp-desktop/src-tauri/Cargo.lock', `version = 4
[[package]]
name = "fixture-registry-crate"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${createHash('sha256').update('measured crate archive').digest('hex')}"
`);
    write(repositoryRoot, 'papercusp-desktop/src-tauri/src/main.rs', '// measured native fixture\n');
    write(repositoryRoot, 'papercusp-desktop/bin/lib/claim-target-dir.sh',
      options.nativeStorageRefused ? 'echo NATIVE_STORAGE_REFUSED >&2\nreturn 28\n' :
        'export BROKER_FIXTURE_STORAGE_ADMITTED=1\npapercusp_release_disk_reservation() { touch "$CARGO_TARGET_DIR/released"; }\n');
    write(repositoryRoot, 'papercusp-desktop/bin/cargo-build-safe.sh',
      '#!/bin/bash\nset -eu\ncd papercusp-desktop/src-tauri\nexec cargo "$@"\n');
  }
  chmodSync(join(repositoryRoot, 'scripts/pc-heavy.sh'), 0o755);
  git(repositoryRoot, ['init', '-q']); git(repositoryRoot, ['add', '.']); git(repositoryRoot, ['commit', '-qm', 'fixed build fixture']);
  // The maintained Git verifier checks HEAD^ as well as the exact selected pin.
  git(repositoryRoot, ['commit', '--allow-empty', '-qm', 'fixture parent boundary']);
  const source = await prepareVerifierSource({ repo: repositoryRoot, ref: git(repositoryRoot, ['rev-parse', 'HEAD']),
    dest: root, inputs: ['apps/operator/bin/build.cjs'], gitCheckout: options.gitCheckout });
  write(root, 'node_modules/dep/index.js', 'measured dependency');
  const dependencies = captureVerifierDependencies({ dest: root, receipt: source });
  return { root, repositoryRoot, custodyRoot, source, dependencies };
}

