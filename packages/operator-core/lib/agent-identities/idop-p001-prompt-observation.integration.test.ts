import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { compileAgentSpecification, specificationPrompt } from '@papercusp/orchestrator/blueprint';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectIdopP001PromptArchive, type IdopPromptObservation } from './idop-p001-baseline';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const homePath = (ref: string) => {
  if (!ref.startsWith('~/')) throw new Error('Prompt archive references must be home-relative');
  return join(homedir(), ref.slice(2));
};

function syntheticArchive(): { manifest: IdopPromptObservation; files: Map<string, Buffer>; original: Buffer } {
  const specification = compileAgentSpecification({
    source: { id: 'idop-archive-fixture', workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { text: 'Public synthetic launch fixture.\nUnicode: λ 🦉.' },
  });
  const session = { ownerId: 'su-fixture', nativeSessionId: 'native-fixture', advSessionId: 1,
    nativeMessageTimestamp: '2026-10-23T06:11:45.863Z', nativeMetaTimestamp: '2026-10-23T06:11:43.973Z',
    nativeRecordLine: 4, nativeTranscript: '~/fixture/native.jsonl',
    sourceClosure: '~/fixture/source-closure.json', sourceClosureSha256: '',
    specificationRevision: specification.specificationRevision };
  const prompt = Buffer.from(specificationPrompt(specification));
  const prefix = '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n';
  const suffix = '\n</INSTRUCTIONS>';
  const text = prefix + prompt.toString('utf8') + suffix;
  const record = json({ timestamp: session.nativeMessageTimestamp, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const files = new Map([
    ['~/fixture/rendered-effective.md', prompt],
    ['~/fixture/native-agents-record.jsonl', record],
    ['~/fixture/native-session-meta.jsonl', json({ timestamp: '2026-10-23T06:11:44.700Z',
      type: 'session_meta', payload: { id: session.nativeSessionId, session_id: session.nativeSessionId,
        timestamp: session.nativeMetaTimestamp } })],
    [session.sourceClosure, json({ response: { truncated: false, rows: [{ id: '1',
      session_id: session.nativeSessionId, coord_owner_id: session.ownerId,
      launch_spec: { specificationArtifact: specification, specificationRevision: specification.specificationRevision } }] } })],
  ]);
  session.sourceClosureSha256 = hash(files.get(session.sourceClosure)!);
  const manifest: IdopPromptObservation = {
    sourceSession: session,
    renderedPrompt: { sha256: hash(prompt), bytes: prompt.length, characters: Array.from(prompt.toString('utf8')).length,
      frozenPath: '~/fixture/rendered-effective.md' },
    nativeDelivery: { recordSha256: hash(record), completeAgentsTextSha256: hash(text),
      completeAgentsTextBytes: Buffer.byteLength(text), occurrences: 1, prefix, suffix, excludedRenderedFields: [] },
    files: [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.length })),
  };
  return { manifest, files, original: record };
}

let archive: ReturnType<typeof syntheticArchive>;

// Bind the case identities persisted by the ordinary test reporter to the bytes
// actually selected here. Passing titles must distinguish retained launch proof
// from the portable fixture without relying on an inherited environment claim.
const manifestPath = process.env.PAPERCUSP_IDOP_PROMPT_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : undefined;
const selectedManifest = manifestBytes
  ? JSON.parse(manifestBytes.toString('utf8')) as IdopPromptObservation
  : undefined;
const archiveSelection = selectedManifest
  ? `retained manifest sha256=${hash(manifestBytes!)} nativeSession=${selectedManifest.sourceSession.nativeSessionId}`
  : 'portable synthetic fixture; no retained launch selected';

beforeAll(async () => {
  // The ordinary suite is portable. An explicit manifest runs these same cases
  // against the retained real launch; no real prompt bytes enter a repo fixture.
  if (!selectedManifest) { archive = syntheticArchive(); return; }
  const manifest = selectedManifest;
  const files = new Map(manifest.files.map(entry => [entry.path, readFileSync(homePath(entry.path))]));
  const stream = createReadStream(homePath(manifest.sourceSession.nativeTranscript));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let original: Buffer | undefined;
  let line = 0;
  try {
    for await (const text of lines) {
      if (++line === manifest.sourceSession.nativeRecordLine) { original = Buffer.from(text + '\n'); break; }
    }
  } finally { lines.close(); stream.destroy(); }
  if (!original) throw new Error('Recorded native transcript line is absent');
  archive = { manifest, files, original };
});

const verify = (manifest = archive.manifest, files = archive.files, original = archive.original) =>
  inspectIdopP001PromptArchive(manifest, ref => {
    const bytes = files.get(ref);
    if (!bytes) throw new Error('Archive file is absent');
    return bytes;
  }, original);

function replaceFile(manifest: IdopPromptObservation, files: Map<string, Buffer>, ref: string, bytes: Buffer) {
  files.set(ref, bytes);
  Object.assign(manifest.files.find(entry => entry.path === ref)!, { sha256: hash(bytes), bytes: bytes.length });
}

describe('P-001 portable prompt archive fixture', () => {
  it('also exercises the portable public fixture used by the ordinary suite', () => {
    const { manifest, files, original } = syntheticArchive();
    expect(verify(manifest, files, original).renderedPromptSha256).toBe(manifest.renderedPrompt.sha256);
  });
});

describe(`P-001 launch input replay and native delivery integration [${archiveSelection}]`, () => {
  it('replays the source artifact and matches the original native message exactly', () => {
    const receipt = verify();
    expect(receipt.nativeSessionId).toBe(archive.manifest.sourceSession.nativeSessionId);
    expect(receipt.renderedPromptSha256).toBe(archive.manifest.renderedPrompt.sha256);
    expect(receipt.filesChecked).toBe(4);
  });

  it('rejects altered prompt bytes even when their manifest digest is recomputed', () => {
    const manifest = structuredClone(archive.manifest);
    const files = new Map(archive.files);
    const bytes = Buffer.from(files.get(manifest.renderedPrompt.frozenPath)!.toString('utf8') + ' altered');
    replaceFile(manifest, files, manifest.renderedPrompt.frozenPath, bytes);
    Object.assign(manifest.renderedPrompt, { sha256: hash(bytes), bytes: bytes.length,
      characters: Array.from(bytes.toString('utf8')).length });
    expect(() => verify(manifest, files)).toThrow('replayed render differs');
  });

  it('rejects source input substitution even when the archive digest is recomputed', () => {
    const manifest = structuredClone(archive.manifest);
    const files = new Map(archive.files);
    const ref = manifest.files.find(entry => entry.path.endsWith('/source-closure.json'))!.path;
    const closure = JSON.parse(files.get(ref)!.toString('utf8'));
    const input = closure.response.rows[0].launch_spec.specificationArtifact.inputs
      .find((entry: { kind: string }) => entry.kind === 'prompt-file');
    input.bytes += ' altered';
    const bytes = json(closure);
    replaceFile(manifest, files, ref, bytes);
    manifest.sourceSession.sourceClosureSha256 = hash(bytes);
    expect(() => verify(manifest, files)).toThrow(/mismatch/);
  });

  it('rejects a native session substitution even when its file digest is recomputed', () => {
    const manifest = structuredClone(archive.manifest);
    const files = new Map(archive.files);
    const ref = manifest.files.find(entry => entry.path.endsWith('/native-session-meta.jsonl'))!.path;
    const meta = JSON.parse(files.get(ref)!.toString('utf8'));
    meta.payload.id = 'different-session';
    replaceFile(manifest, files, ref, json(meta));
    expect(() => verify(manifest, files)).toThrow('native session mismatch');
  });

  it('rejects an archive/native-record substitution independently of its declared hashes', () => {
    const manifest = structuredClone(archive.manifest);
    const files = new Map(archive.files);
    const ref = manifest.files.find(entry => entry.path.endsWith('/native-agents-record.jsonl'))!.path;
    const record = JSON.parse(files.get(ref)!.toString('utf8'));
    record.payload.content[0].text += ' altered';
    const bytes = json(record);
    replaceFile(manifest, files, ref, bytes);
    manifest.nativeDelivery.recordSha256 = hash(bytes);
    expect(() => verify(manifest, files)).toThrow('original native record differs');
    expect(() => verify(manifest, files, bytes)).toThrow('native prompt differs');
  });

  it('rejects duplicate files and unrecorded render exclusions', () => {
    const duplicate = structuredClone(archive.manifest);
    duplicate.files.push(duplicate.files[0]);
    expect(() => verify(duplicate)).toThrow('duplicate archive reference');
    const normalized = structuredClone(archive.manifest);
    normalized.nativeDelivery.excludedRenderedFields.push('unrecorded normalization');
    expect(() => verify(normalized)).toThrow('render exclusions are not accepted');
  });
});
