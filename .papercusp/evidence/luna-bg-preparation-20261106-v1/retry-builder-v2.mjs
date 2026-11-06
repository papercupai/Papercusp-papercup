import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const evidence = resolve('.papercusp/evidence/luna-bg-preparation-20261106-v1');
const read = name => JSON.parse(readFileSync(join(evidence, name), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const originalBytes = readFileSync(join(evidence, 'build-transaction.json'));
assert.equal(sha(originalBytes), '6111b2f2ca7d04ad729aa2c493881cdf4a6f3dab8e43e3e31e05f2aad336f054');
const original = JSON.parse(originalBytes);
const attempt = read('build-attempt.json');
assert.equal(attempt.deadlineEpochMs, 1793949556845);
const selected = read('selected-recipe-inputs.json');
assert.equal(sha(readFileSync(join(evidence, 'selected-recipe-inputs.json'))), attempt.selectedRecipeSha256);
const root = selected.sourceRoot;
const builderPath = join(root, 'apps/operator/bin/bundle-host.sh');
const commonPath = join(root, 'apps/operator/bin/bundle-host-common.sh');
const builder = readFileSync(builderPath, 'utf8');
const common = readFileSync(commonPath, 'utf8');
assert.equal(sha(builder), selected.builderSha256);
assert.equal(sha(common), selected.commonSha256);
const slice = (body, start, end) => {
  assert.equal(body.split(start).length, 2, 'selected command start must be unique');
  const from = body.indexOf(start), to = body.indexOf(end, from);
  assert.ok(to > from, 'selected command end missing');
  return body.slice(from, to + end.length);
};
const hostExternalBlock = slice(builder, 'HOST_EXTERNALS=(', '\nif ! VIEM_ALIAS_OUTPUT=').replace('\nif ! VIEM_ALIAS_OUTPUT=', '');
const mainCommand = slice(builder, 'bundle_host_run_step host-compile bundle_host_esbuild', '"${HOST_EXTERNALS[@]}" "${HOST_VIEM_ALIASES[@]}"');
const cpuSection = common.slice(common.indexOf('if [ "$output" = "cpu-task-worker.script.mjs" ]'), common.indexOf('  local -a meta_args'));
const tsSection = common.slice(common.indexOf('  local -a meta_args'));
const cpuCommand = slice(cpuSection, 'bundle_host_run_step "worker-$output" bundle_host_esbuild', '"${cpu_meta_args[@]}"');
const tsCommand = slice(tsSection, 'bundle_host_run_step "worker-$output" bundle_host_esbuild', '"${meta_args[@]}"');
const spawnerCommand = slice(common, 'bundle_host_run_step spawner-compile bundle_host_esbuild', '--define:__PAPERCUSP_BUNDLED_SIDECAR__=true "$@"');
const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
const array = values => '(' + values.map(q).join(' ') + ')';
const stageLeaf = 'luna-generation-20261106-v2';
const stage = join(original.bank.path, stageLeaf);
const publicationLeaf = stageLeaf + '.publication.json';
assert.equal(original.contexts.invocations.length, 10);
const commonSetup = [
  'set -euo pipefail',
  'source ' + q(commonPath),
  'bundle_host_select_profile release',
  hostExternalBlock,
  'bundle_host_run_step() { shift; "$@"; }',
  'bundle_host_esbuild() { shift; printf "%s\\0" "$@"; }',
  'repo_root=' + q(root),
  'REPO_ROOT=' + q(root),
  'HOST_VIEM_ALIASES=' + array(selected.aliases),
  'BUNDLED_SOURCE_SHA_DEFINE=' + array(['--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__=' + JSON.stringify(selected.sourceCommit.slice(0, 12))]),
];
const contracts = original.contexts.invocations.map(({ invocation }, index) => {
  const oldArgv = invocation.argv;
  const oldOut = oldArgv.find(arg => arg.startsWith('--outfile=')).slice(10);
  const oldMeta = oldArgv.find(arg => arg.startsWith('--metafile=')).slice(11);
  const outfile = oldOut.replace(original.stage, stage), metafile = oldMeta.replace(original.stage, stage);
  const setup = [...commonSetup, 'ENTRY=' + q(oldArgv[0]), 'source=' + q(oldArgv[0]),
    'TMPFILE=' + q(outfile), 'METAFILE=' + q(metafile), 'tmp=' + q(outfile), 'meta=' + q(metafile),
    'output=' + q(basename(oldArgv[0])), 'cpu_meta_args=' + array(['--metafile=' + metafile]),
    'meta_args=' + array(['--metafile=' + metafile]), 'worker_externals=("${HOST_EXTERNALS[@]}")'];
  let command = tsCommand;
  if (index === 0) command = mainCommand;
  if (index === 1) command = cpuCommand;
  if (index === 9) {
    setup.push('set -- "${HOST_MINIFY_ARGS[@]}" "${BUNDLED_SOURCE_SHA_DEFINE[@]}" "${HOST_EXTERNALS[@]}"');
    command = spawnerCommand;
  }
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
    input: setup.join('\n') + '\n' + command + '\n', encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const argv = result.stdout.split('\0');
  assert.equal(argv.pop(), '');
  assert.equal(argv[0], oldArgv[0]);
  assert.equal(argv.find(arg => arg.startsWith('--outfile=')), '--outfile=' + outfile);
  assert.equal(argv.find(arg => arg.startsWith('--metafile=')), '--metafile=' + metafile);
  const external = argv.filter(arg => arg.startsWith('--external:'));
  const unchanged = oldArgv.map(arg => arg.replaceAll(original.stage, stage)).filter(arg => !arg.startsWith('--external:'));
  assert.deepEqual(argv.filter(arg => !arg.startsWith('--external:')), unchanged, 'non-external selected command differs');
  if (index === 1) assert.equal(external.length, 0, 'CPU worker has its own selected contract');
  else for (const flag of ['--external:ssh2', '--external:onnxruntime-node', '--external:typescript', '--external:@dbos-inc/dbos-sdk'])
    assert.ok(external.includes(flag), 'missing selected external: ' + flag);
  return { invocation: { ...invocation, argv }, index, entry: oldArgv[0],
    externalCount: external.length, argvSha256: sha(JSON.stringify(argv)),
    addedExternals: external.filter(arg => !oldArgv.includes(arg)) };
});
const preflight = {
  schemaVersion: 'luna-selected-command-preflight-v2', workItemId: 'WI-6554700010028547',
  originalTransactionSha256: sha(originalBytes), inheritedDeadlineEpochMs: attempt.deadlineEpochMs,
  builderSha256: selected.builderSha256, commonSha256: selected.commonSha256,
  selectedRecipeSha256: attempt.selectedRecipeSha256, dependenciesSha256: attempt.dependenciesSha256,
  sourceReceiptSha256: attempt.sourceReceiptSha256, stage, publicationLeaf,
  commands: contracts.map(({ invocation, ...row }) => ({ ...row, argv: invocation.argv })),
  result: 'PASS: all ten complete selected commands; only native/runtime externals and nominated output namespace differ',
};
if (!process.argv.includes('--build')) {
  if (process.argv.includes('--save-preflight')) save('selected-command-preflight-v2.json', preflight);
  console.log(JSON.stringify({ ...preflight, commands: preflight.commands.map(({ argv, addedExternals, ...row }) => row) }));
} else {
  assert.deepEqual(read('selected-command-preflight-v2.json'), preflight, 'preflight changed');
  assert.equal(Number(process.env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS), attempt.deadlineEpochMs);
  const api = await import(pathToFileURL(join(repo, 'scripts/source-preview.mjs')));
  const runPhase = async (phase, operation) => {
    api.admitVerifierCommandBudget(null, { env: process.env });
    console.log(JSON.stringify({ phase, event: 'started', atMs: Date.now() }));
    const result = await operation();
    console.log(JSON.stringify({ phase, event: 'completed', atMs: Date.now() }));
    api.admitVerifierCommandBudget(null, { env: process.env });
    return result;
  };
  const startedAtMs = Date.now();
  try {
    assert.ok(!existsSync(stage), 'revised stage already exists');
    assert.ok(!existsSync(join(original.bank.path, publicationLeaf)), 'revised publication already exists');
    assert.equal(sha(readFileSync(join(evidence, 'dependencies-v3.json'))), attempt.dependenciesSha256);
    const transaction = await runPhase('bg.prepare.transaction.v2', () => api.prepareBgVerifierBuildTransaction({
      prepared: original.contexts.record.prepared, dependencies: original.contexts.record.dependencies,
      invocations: contracts.map(row => row.invocation), bank: original.bank.path, stageLeaf,
      outputs: original.outputs, assets: original.assets,
      recipe: { ...original.recipe, outfile: original.recipe.outfile.replace(original.stage, stage) }, publicationLeaf,
    }));
    save('build-transaction-v2.json', transaction);
    const transactionSha256 = sha(readFileSync(join(evidence, 'build-transaction-v2.json')));
    console.log(JSON.stringify({ event: 'REVISED_TRANSACTION_RETAINED', transactionSha256, inheritedDeadlineEpochMs: attempt.deadlineEpochMs }));
    const publication = await api.runBgVerifierBuildRecipe({ transaction, ownerPid: process.pid, runPhase });
    save('build-publication-v2.json', publication);
    save('build-terminal-v2.json', { status: 'passed', startedAtMs, completedAtMs: Date.now(), transactionSha256,
      inheritedDeadlineEpochMs: attempt.deadlineEpochMs, originalTransactionSha256: sha(originalBytes) });
    console.log(JSON.stringify({ event: 'REVISED_PUBLICATION_VERIFIED', transactionSha256 }));
  } catch (error) {
    save('build-terminal-v2.json', { status: 'failed', startedAtMs, completedAtMs: Date.now(), error: String(error.stack || error),
      inheritedDeadlineEpochMs: attempt.deadlineEpochMs, originalTransactionSha256: sha(originalBytes) });
    throw error;
  }
}
