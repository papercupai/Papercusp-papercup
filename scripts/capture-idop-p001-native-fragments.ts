import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractIdopP001NativeFragments, nativeFragmentHash } from '../packages/operator-core/lib/agent-identities/idop-p001-native-fragments';

// This captures a new edition. It never rewrites the historical extraction or grants acceptance.
export function captureIdopNativeFragments(root: string, archiveRoot: string) {
  const priorPath = 'docs/evidence/idop-p001-retained-native-catalog-fragments-2026-10-25.json';
  const recoveryPath = 'docs/evidence/idop-p001-canonical-native-source-recovery-2026-10-25.json';
  const priorBytes = readFileSync(join(root, priorPath));
  const recoveryBytes = readFileSync(join(root, recoveryPath));
  const prior = JSON.parse(priorBytes.toString()) as { rows: Array<{ sourceNative: string }>; unparsed: Array<{ native: string }> };
  const recovery = JSON.parse(recoveryBytes.toString()) as {
    rows: Array<{ nativeSessionId: string; ownerId: string; nativeSha256: string; ownerJoin: boolean; bytes: number }>;
  };
  const population = [...new Set([...prior.rows.map(row => row.sourceNative), ...prior.unparsed.map(row => row.native)])].sort();
  const observations = population.map(id => {
    const rows = recovery.rows.filter(row => row.nativeSessionId === id);
    if (rows.length !== 1 || !rows[0].ownerJoin || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Missing or ambiguous independently recovered source');
    const source = rows[0];
    const nativePath = join(archiveRoot, `${id}.jsonl`);
    const bytes = readFileSync(nativePath);
    if (bytes.length !== source.bytes) throw new Error('Native source length mismatch');
    const publicationPath = nativePath.startsWith(homedir() + '/') ? '~/' + nativePath.slice(homedir().length + 1) : nativePath;
    return { source: { nativeSessionId: id, ownerId: source.ownerId, nativeSha256: source.nativeSha256,
      nativePath: publicationPath, bytes: bytes.length }, ...extractIdopP001NativeFragments(bytes, source) };
  });
  const instrumentPaths = [
    'scripts/capture-idop-p001-native-fragments.ts',
    'packages/operator-core/lib/agent-identities/idop-p001-native-fragments.ts',
    'packages/operator-core/lib/agent-identities/idop-p001-native-fragments.test.ts',
  ];
  return {
    schemaVersion: 1, kind: 'maintained-native-catalog-fragment-extraction',
    plan: 'identity-definitions-own-policy-2026-10-17', item: 'P-001', workItem: 'WI-6554700010017386',
    capturedAt: new Date().toISOString(), acceptance: 'OPEN', canonicalAcceptance: false,
    priorEdition: { path: priorPath, sha256: nativeFragmentHash(priorBytes), relation: 'separate edition; this instrument did not produce the prior artifact' },
    sourceRecovery: { path: recoveryPath, sha256: nativeFragmentHash(recoveryBytes) },
    hashConventions: { recordSha256: 'Original native output JSONL record bytes, including retained line terminator.',
      priorCallRecordSha256: 'Original native call JSONL record bytes, including retained line terminator; distinct from the prior edition\'s sorted-payload priorCallSha256.' },
    instrument: instrumentPaths.map(path => ({ path, sha256: nativeFragmentHash(readFileSync(join(root, path))) })),
    population: { source: 'Explicit native sources named in the prior fragment edition, independently pinned by source recovery', nativeSessionIds: population },
    controls: { parseableFragments: observations.reduce((sum, row) => sum + row.fragments.length, 0),
      retainedAnnotationRows: observations.reduce((sum, row) => sum + row.fragments.reduce((count, fragment) => count + fragment.tools.length, 0), 0),
      rejectedOutputs: observations.reduce((sum, row) => sum + row.rejected.length, 0), fullCatalogsAccepted: 0, effectiveArgumentScopesAccepted: 0 },
    observations,
    limits: ['Partial catalog rows only; count is the recorded request cap, not retained or total universe coverage.',
      'Source recovery supplies the expected digests and owner joins; this instrument checks those pins and recorded caller attribution.',
      'No missing catalog, schema, annotation, effective argument scope, historical vault setting, or actual stack admission is inferred.',
      'Source/test hashes identify this edition\'s producer; committed-source qualification and canonical support binding are separate steps.',
      'The baseline amendment, D-023 source question, independent acceptance, milestones, and shipment holds remain open.'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archiveRoot, output] = process.argv.slice(2);
  if (!archiveRoot || !output || process.argv.length !== 4) throw new Error('Usage: tsx scripts/capture-idop-p001-native-fragments.ts <original-archive-root> <new-output.json>');
  const artifact = captureIdopNativeFragments(process.cwd(), resolve(archiveRoot));
  writeFileSync(resolve(output), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, ...artifact.controls }));
}
