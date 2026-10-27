/**
 * Local-only dispatch admission. Rehash the complete candidate and applicable
 * installer/runtime/seed bytes before a runner can perform any remote effect.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {
  candidateArtifactDigest,
  p521PrecheckSubjectsMatch,
  validateP521LocalPrechecks,
} from './p521-local-precheck.mts';
import type { P521PrecheckSubject } from './p2p-candidate-manifest';

function fileHash(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isFile()) {
    throw new Error('absolute byte file required');
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main(argv: string[]): number {
  try {
    let bundlePath = '';
    const journeys: string[] = [];
    for (let i = 0; i < argv.length; i += 2) {
      const value = argv[i + 1];
      if (!value) throw new Error('local precheck bundle/journey required');
      if (argv[i] === '--bundle') bundlePath = value;
      else if (argv[i] === '--journey') journeys.push(value);
      else throw new Error('unknown local precheck argument');
    }
    if (!bundlePath || !journeys.length) throw new Error('local precheck bundle/journey missing');
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    if (!bundle || typeof bundle !== 'object' || typeof bundle.artifactDir !== 'string'
      || !isAbsolute(bundle.artifactDir) || !Array.isArray(bundle.candidate?.artifacts) || !bundle.bytePaths) {
      throw new Error('local precheck candidate/byte paths required');
    }
    candidateArtifactDigest(bundle.candidate.artifacts);
    const artifacts = bundle.candidate.artifacts.map((artifact: { name: string; sha256: string }) => {
      const hash = fileHash(join(bundle.artifactDir, artifact.name));
      if (hash !== artifact.sha256) throw new Error('candidate artifact bytes mismatch');
      return { name: artifact.name, sha256: hash };
    });
    const installerSha256 = fileHash(bundle.bytePaths.installer);
    if (!artifacts.some((artifact: { name: string; sha256: string }) =>
      artifact.name === basename(bundle.bytePaths.installer) && artifact.sha256 === installerSha256)) {
      throw new Error('installer must be a candidate member');
    }
    const subject: P521PrecheckSubject = { artifactDigest: candidateArtifactDigest(artifacts), installerSha256 };
    for (const key of ['runtime', 'seed'] as const) {
      if (Object.prototype.hasOwnProperty.call(bundle.bytePaths, key)) {
        subject[key === 'runtime' ? 'runtimeSha256' : 'seedSha256'] = fileHash(bundle.bytePaths[key]);
      }
    }
    if (!p521PrecheckSubjectsMatch(subject, bundle.precheckSubject)) {
      throw new Error('complete local precheck subject/byte presence mismatch');
    }
    const result = validateP521LocalPrechecks(bundle.localPrechecks, subject, new Date().toISOString(), journeys);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return 0;
  } catch (error) {
    console.error('local precheck refused: ' + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
