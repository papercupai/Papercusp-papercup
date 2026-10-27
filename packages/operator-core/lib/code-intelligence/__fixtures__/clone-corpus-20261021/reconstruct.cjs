'use strict';

// Historical evidence recipe for D-012. This deliberately runs the archived probe;
// it does not implement or stand in for the planned clone index.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, realpathSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');

const fixtureDir = __dirname;
const canonicalRoot = resolve(__dirname, '../../../../../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const readJson = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const correctedManifestName = 'candidate-manifest-v3.json';
const correction = {
  issue: 'EI-26742762259332807',
  originalManifestSha256: '5b818f5451a60b02263da5d672c5ef82306d8d563d580d7c2539d87367351e21',
  authority: 'thread-post:1198640; coord-send-f7c9122ca029179cebe839d3888696f345af652279954414883ae691f189b75c',
  source: 'Reconstructed historical checkout, not the unsaved original probe input tree.',
  rootCause: 'Whole-output trim removed the first leading status space before slice(1) removed the first SHA character.',
};
const labelParts = (label) => {
  const match = /^(.*):(\d+) (.*) m=(\d+)$/.exec(label);
  assert(match, 'malformed archived family label: ' + label);
  return { path: match[1], line: Number(match[2]), name: match[3], mass: Number(match[4]) };
};

function filterFamilies(groups) {
  // Archived postfilter toolu_01WN2TTL4FJf4vizprW7Dta3, recorded in1198228.
  const vend = /(^|\/)_retired\/|^templates\/|\/template-kit\/|^apps\/operator\/app\//;
  return groups.map((group) => group.filter((label) => !vend.test(labelParts(label).path)))
    .filter((group) => new Set(group.map((label) => labelParts(label).path)).size >= 2)
    .map((group) => [...group].sort())
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}

function canonicalFamilies(groups) {
  // The frozen original artifact used the host's ordinary array sort.
  return groups.map((group) => [...group].sort()).sort();
}

function resolveSubmodulePins(manifest, supplement) {
  assert.equal(supplement.candidateCommit, manifest.candidateCommit);
  const corrections = new Map(supplement.corrections.map((row) => [row.path, row]));
  assert.equal(corrections.size, supplement.corrections.length, 'duplicate pin correction');
  const resolved = manifest.submodules.map((pin) => {
    const correction = corrections.get(pin.path);
    if (!correction) {
      assert.match(pin.sha, /^[a-f0-9]{40}$/, 'malformed submodule pin: ' + pin.path);
      return pin;
    }
    assert.equal(pin.sha, correction.recordedPin);
    assert.match(correction.committedGitlink, /^[a-f0-9]{40}$/);
    assert.equal(correction.materializedHead, correction.committedGitlink);
    corrections.delete(pin.path);
    return { path: pin.path, sha: correction.committedGitlink };
  });
  assert.equal(corrections.size, 0, 'correction targets an unknown submodule');
  return resolved;
}

function parseSubmoduleStatus(output) {
  // The first byte is a status, including a meaningful space for a clean pin.
  // Never trimStart/trim the whole output before parsing that byte.
  const pins = output.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^ ([a-f0-9]{40}) (.+?)(?: \([^\r\n]*\))?$/.exec(line);
    assert(match, 'malformed or unclean submodule status: ' + line);
    return { sha: match[1], path: match[2] };
  });
  assert.equal(new Set(pins.map((pin) => pin.path)).size, pins.length, 'duplicate submodule status');
  return pins;
}

function verifyCorrectedManifest(manifest, supplement) {
  const provenance = readJson('corrected-manifest-provenance.json');
  const bytes = readFileSync(join(fixtureDir, correctedManifestName));
  assert.equal(provenance.correctedManifest.sha256, sha256(bytes), 'corrected manifest digest changed');
  assert.equal(provenance.correctedManifest.bytes, bytes.length);
  assert.equal(provenance.originalManifestSha256, correction.originalManifestSha256);
  assert.equal(provenance.candidateCommit, manifest.candidateCommit);
  const corrected = JSON.parse(bytes);
  assert.deepEqual(corrected, { ...manifest, schemaVersion: 3,
    submodules: resolveSubmodulePins(manifest, supplement), correction },
  'corrected manifest changed more than its schema, pins and explicit provenance');
  for (const pin of corrected.submodules) assert.match(pin.sha, /^[a-f0-9]{40}$/);
  return { correctedManifestSha256: sha256(bytes), correctedSubmodulePins: corrected.submodules.length };
}

function verifyOutputEquality(original, historical, filtered) {
  assert.equal(original.minMass, 80);
  assert.equal(historical.minMass, 80);
  assert.equal(original.allType2.length, 327);
  assert.equal(historical.allType2.length, 327);
  assert.deepEqual(historical.allType2, original.allType2, 'raw family labels changed');
  const originalFamilies = canonicalFamilies(filterFamilies(original.allType2));
  const historicalFamilies = canonicalFamilies(filterFamilies(historical.allType2));
  assert.deepEqual(originalFamilies, filtered.families, 'archived filtered labels changed');
  assert.deepEqual(historicalFamilies, originalFamilies);
  assert.equal(originalFamilies.length, 164);
  assert.equal(originalFamilies.reduce((sum, group) => sum + group.length, 0), 404);
  const governors = originalFamilies.filter((group) => group.length === 10 &&
    group.every((label) => labelParts(label).name.endsWith('GovernorGate')));
  assert.equal(governors.length, 1);
  assert.equal(original.functionsAtOrAboveMinMass, 36185);
  assert.equal(historical.functionsAtOrAboveMinMass, 36183);
  return { rawFamilies: 327, filteredFamilies: 164, filteredMembers: 404,
    governorMembers: 10, originalQualifyingFunctions: 36185,
    historicalQualifyingFunctions: 36183, censusDifference: 2 };
}

function verifyFrozenArtifacts(verifyCorrection = true) {
  const provenance = readJson('provenance.json');
  for (const [name, expected] of Object.entries(provenance.artifacts)) {
    const bytes = readFileSync(join(fixtureDir, name));
    assert.equal(bytes.length, expected.bytes, name + ' byte count changed');
    assert.equal(sha256(bytes), expected.sha256, name + ' digest changed');
  }
  const manifest = readJson('candidate-manifest-v2.json');
  const supplement = readJson('submodule-pin-corrections.json');
  assert.equal(manifest.files.length, 10339);
  assert.equal(manifest.submodules.length, 39);
  assert.equal(manifest.compiler.version, '6.0.2');
  assert.equal(manifest.candidateCommit, provenance.candidateCommit);
  assert.equal(supplement.originalManifestSha256, provenance.artifacts['candidate-manifest-v2.json'].sha256);
  assert.equal(resolveSubmodulePins(manifest, supplement).length, 39);
  assert.equal(new Set(manifest.files.map((row) => row.path)).size, 10339);
  const rows = new Map(manifest.files.map((row) => [row.path, row]));
  for (const row of manifest.files) assert.equal(row.gitBlobSha1, row.committedGitBlobSha1);
  const governors = readJson('governor-sources.json');
  assert.equal(governors.candidateCommit, manifest.candidateCommit);
  assert.equal(governors.members.length, 10);
  const original = readJson('original-output.json');
  const historical = readJson('historical-output.json');
  const filtered = readJson('original-filtered-family-labels.json');
  const governorLabels = filtered.families.find((group) => group.length === 10 &&
    group.every((label) => labelParts(label).name.endsWith('GovernorGate')));
  assert.deepEqual(governors.members.map((row) => row.label).sort(), [...governorLabels].sort());
  for (const member of governors.members) {
    const bytes = Buffer.from(member.source);
    assert.equal(sha256(bytes), member.sha256);
    assert.equal(member.sha256, rows.get(member.path).sha256);
    assert.equal(gitBlob(bytes), member.gitBlobSha1);
    assert.equal(member.gitBlobSha1, rows.get(member.path).committedGitBlobSha1);
    const label = labelParts(member.label);
    assert(member.source.split('\n')[label.line - 1].includes(label.name));
  }
  return { ...verifyOutputEquality(original, historical, filtered), selectedPaths: 10339,
    submodulePins: 39, originalInputIdentity: provenance.originalInputIdentity,
    ...(verifyCorrection ? verifyCorrectedManifest(manifest, supplement) : {}) };
}

function verifyHistoricalRoot(root, verifyCorrection = true) {
  const actualRoot = realpathSync(root);
  assert.notEqual(actualRoot, realpathSync(canonicalRoot), 'canonical staging is not a historical replay target');
  verifyFrozenArtifacts(verifyCorrection);
  const manifest = readJson(verifyCorrection ? correctedManifestName : 'candidate-manifest-v2.json');
  const git = (args, cwd = actualRoot) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28 }).toString().trim();
  assert.equal(git(['rev-parse', 'HEAD']), manifest.candidateCommit, 'wrong historical commit');
  assert.equal(git(['diff', '--name-only']), '', 'historical materialization has tracked changes');
  const paths = git(['ls-files', '--recurse-submodules', '*.ts', '*.tsx']).split('\n').filter((f) => f
    && !/\.d\.ts$/.test(f)
    && !/(\.test|\.spec|\.integration\.test)\.tsx?$/.test(f)
    && !/(^|\/)(node_modules|dist|dist-host|build|coverage|__fixtures__|__mocks__|generated|\.materialized|sidecar)(\/|$)/.test(f)
    && !/\.gen\.tsx?$/.test(f));
  assert.deepEqual(paths, manifest.files.map((row) => row.path), 'selected path population changed');
  for (const row of manifest.files) {
    const bytes = readFileSync(join(actualRoot, row.path));
    assert.equal(bytes.length, row.bytes, row.path);
    assert.equal(sha256(bytes), row.sha256, row.path);
    assert.equal(gitBlob(bytes), row.committedGitBlobSha1, row.path);
  }
  const pins = verifyCorrection ? manifest.submodules
    : resolveSubmodulePins(manifest, readJson('submodule-pin-corrections.json'));
  const parsedPins = parseSubmoduleStatus(execFileSync('git', ['submodule', 'status', '--recursive'],
    { cwd: actualRoot, maxBuffer: 1 << 20 }).toString());
  assert.deepEqual(parsedPins, pins, 'historical status pins differ from manifest');
  for (const pin of pins) {
    const parent = pins.filter((other) => pin.path.startsWith(other.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const relative = parent ? pin.path.slice(parent.path.length + 1) : pin.path;
    const parentRoot = parent ? join(actualRoot, parent.path) : actualRoot;
    const treeEntry = git(['ls-tree', 'HEAD', '--', relative], parentRoot);
    assert.match(treeEntry, /^160000 commit [a-f0-9]{40}\t/);
    assert.equal(treeEntry.split(/\s+/)[2], pin.sha, pin.path + ' parent gitlink');
    assert.equal(git(['rev-parse', 'HEAD'], join(actualRoot, pin.path)), pin.sha, pin.path);
  }
  assert.equal(sha256(readFileSync(join(actualRoot, 'package-lock.json'))), manifest.compiler.lockfileSha256);
  const compiler = JSON.parse(readFileSync(join(actualRoot, 'node_modules/typescript/package.json'), 'utf8'));
  assert.equal(compiler.version, manifest.compiler.version);
  return { root: actualRoot, commit: manifest.candidateCommit, selectedPaths: paths.length,
    sourceMismatches: 0, submodulePins: manifest.submodules.length, compilerVersion: compiler.version,
    ...(verifyCorrection ? { correctedManifestSha256: sha256(readFileSync(join(fixtureDir, correctedManifestName))) } : {}) };
}

function writeCorrectedManifest(root) {
  const verified = verifyHistoricalRoot(root, false);
  const manifest = readJson('candidate-manifest-v2.json');
  const pins = parseSubmoduleStatus(execFileSync('git', ['submodule', 'status', '--recursive'],
    { cwd: verified.root, maxBuffer: 1 << 20 }).toString());
  // The parser independently reads all pins; the supplement corroborates them.
  assert.deepEqual(pins, resolveSubmodulePins(manifest, readJson('submodule-pin-corrections.json')));
  const bytes = Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 3, submodules: pins, correction }, null, 2) + '\n');
  const provenance = Buffer.from(JSON.stringify({
    schemaVersion: 1, ...correction, candidateCommit: manifest.candidateCommit,
    originalInputIdentity: readJson('provenance.json').originalInputIdentity,
    correctedManifest: { path: correctedManifestName, sha256: sha256(bytes), bytes: bytes.length },
    verification: { ...verified, parentGitlinksChecked: pins.length, checkoutHeadsChecked: pins.length },
    regeneration: 'node reconstruct.cjs --root <retained-historical-root> --write-corrected-manifest',
  }, null, 2) + '\n');
  for (const [name, content] of [[correctedManifestName, bytes], ['corrected-manifest-provenance.json', provenance]]) {
    const path = join(fixtureDir, name);
    if (existsSync(path)) assert.deepEqual(readFileSync(path), content, 'refusing to overwrite changed evidence: ' + name);
  }
  writeFileSync(join(fixtureDir, correctedManifestName), bytes);
  writeFileSync(join(fixtureDir, 'corrected-manifest-provenance.json'), provenance);
  return { ...verified, ...verifyCorrectedManifest(manifest, readJson('submodule-pin-corrections.json')) };
}

function replayHistoricalProbe(root) {
  const verified = verifyHistoricalRoot(root);
  mkdirSync(join(verified.root, '.papercusp/scratch'), { recursive: true });
  execFileSync(process.execPath, [join(fixtureDir, 'original-probe.mjs')], {
    cwd: verified.root, env: { ...process.env, MIN_MASS: '80' }, maxBuffer: 1 << 28,
  });
  const replay = JSON.parse(readFileSync(join(verified.root, '.papercusp/scratch/dup-probe-out.json'), 'utf8'));
  // Verify census, raw arrays and full serialized retained output, not just counts.
  assert.deepEqual(replay, readJson('historical-output.json'), 'historical replay output changed');
  return { ...verified, ...verifyOutputEquality(readJson('original-output.json'), replay,
    readJson('original-filtered-family-labels.json')) };
}

module.exports = { filterFamilies, verifyFrozenArtifacts, verifyHistoricalRoot,
  verifyOutputEquality, replayHistoricalProbe, resolveSubmodulePins, parseSubmoduleStatus };

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  assert(rootIndex >= 0 && args[rootIndex + 1], 'supply --root <pinned historical materialization>');
  const result = args.includes('--write-corrected-manifest') ? writeCorrectedManifest(args[rootIndex + 1])
    : args.includes('--run-probe') ? replayHistoricalProbe(args[rootIndex + 1]) : verifyHistoricalRoot(args[rootIndex + 1]);
  console.log(JSON.stringify(result));
}
