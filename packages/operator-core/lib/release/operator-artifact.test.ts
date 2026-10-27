import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { measureBootOperatorArtifact as measureArtifact, operatorArtifactSource, writeOperatorArtifactManifest } from './operator-artifact';

// Fixtures represent files written before a fresh child would be launched.
const measureBootOperatorArtifact = (entry: string, sha: string | null) => measureArtifact(entry, sha, Date.now() + 1000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'operator-artifact-')); roots.push(root);
  const sourceSha = 'a'.repeat(40), source = 'export const trace = true;';
  const rel = 'packages/operator-core/lib/observability/runtime.ts';
  const entry = join(root, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(entry), { recursive: true }); mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), source); writeFileSync(entry, 'bundled tracing runtime');
  writeFileSync(entry + '.meta.json', JSON.stringify({ inputs: { [rel]: { bytes: source.length } } }));
  const sourceBlob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0${source}`).digest('hex');
  let dirty = '', head = sourceSha;
  const git = (_root: string, args: string[]) => {
    if (args[0] === 'status') return dirty;
    if (args[0] === 'ls-tree') return `100644 blob ${sourceBlob}\t${rel}\0`;
    return head;
  };
  const write = () => writeOperatorArtifactManifest({ root, entry, sourceSha }, git);
  const manifest = () => {
    const id = write(); if (id.status !== 'measured') throw Error('fixture');
    return id.evidenceRef;
  };
  return { root, rel, entry, sourceSha, sourceBlob, write, manifest, git,
    dirty: () => { dirty = ' M ' + rel; }, move: () => { head = 'b'.repeat(40); } };
}

describe('operator release artifact provenance', () => {
  it('binds source blobs to real built bytes and measures the boot entry independently', () => {
    const f = fixture(); const written = f.write();
    expect(written).toMatchObject({ status: 'measured', sourceSha: f.sourceSha, sourceBlobs: { [f.rel]: f.sourceBlob } });
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha.slice(0, 10))).toEqual(written);
    expect(f.write()).toEqual(written); // same deterministic artifact is immutable and reusable
  });
  it('refuses dirty source and movement across the release build boundary', () => {
    const f = fixture(); expect(operatorArtifactSource(f.root, f.git)).toBe(f.sourceSha);
    f.dirty(); expect(f.write).toThrow('source-unqualified');
    const moved = fixture(); moved.move(); expect(moved.write).toThrow('source-moved');
  });
  it('does not stamp a source input changed after the compiler read it', () => {
    const f = fixture(); writeFileSync(join(f.root, f.rel), 'different source');
    expect(f.write).toThrow('input-mismatch');
  });
  it('does not turn the retained previous bundle into fresh release evidence', () => {
    const f = fixture(); f.write();
    writeFileSync(join(dirname(f.entry), '.bundle-stale.json'), JSON.stringify({ reason: 'compile-failed' }));
    expect(f.write).toThrow('stale-build');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    rmSync(join(dirname(f.entry), '.bundle-stale.json'));
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });
  it('rejects an empty or escaped metafile source population', () => {
    const f = fixture(); writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: {} }));
    expect(f.write).toThrow('inputs-empty');
    writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: { '../../../foreign.ts': {} } }));
    expect(f.write).toThrow('outside-source');
  });
  it('reads pinned submodule objects without treating the gitlink as a source blob', () => {
    const f = fixture(); const rel = 'libs/tracing/runtime.ts';
    mkdirSync(dirname(join(f.root, rel)), { recursive: true });
    writeFileSync(join(f.root, rel), readFileSync(join(f.root, f.rel)));
    writeFileSync(f.entry + '.meta.json', JSON.stringify({ inputs: { [rel]: {} } }));
    const git = (root: string, args: string[]) => args[0] !== 'ls-tree' ? f.git(root, args) :
      root === f.root ? `160000 commit ${'c'.repeat(40)}\tlibs/tracing\0` : `100644 blob ${f.sourceBlob}\truntime.ts\0`;
    expect(writeOperatorArtifactManifest(f, git)).toMatchObject({ status: 'measured', sourceBlobs: { [rel]: f.sourceBlob } });
  });
  it('keeps a legacy, replaced, or foreign build unknown', () => {
    const f = fixture(); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    f.write(); expect(measureBootOperatorArtifact(f.entry, 'b'.repeat(40)).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
    writeFileSync(f.entry, 'replacement runtime');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
  });
  it.each(['bundle', 'source', 'blob', 'entry'] as const)('rejects a corrupted %s manifest with a healthy control', field => {
    const f = fixture(); const file = f.manifest(); const original = readFileSync(file, 'utf8'); const m = JSON.parse(original);
    if (field === 'bundle') m.bundleSha256 = 'd'.repeat(64);
    if (field === 'source') m.sourceSha = 'e'.repeat(40);
    if (field === 'blob') m.sourceBlobs[f.rel] = 'not-a-blob';
    if (field === 'entry') m.entry = '../hono-host.mjs';
    writeFileSync(file, JSON.stringify(m)); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    writeFileSync(file, original); expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });
  it('rejects a symlinked boot entry instead of borrowing another artifact identity', () => {
    const f = fixture(); f.write(); const link = join(dirname(f.entry), 'other.mjs'); symlinkSync(f.entry, link);
    expect(measureBootOperatorArtifact(link, f.sourceSha).status).toBe('unknown');
  });
  it('rejects matching disk bytes and a valid manifest replaced after this process started', () => {
    const f = fixture(); f.write();
    expect(measureArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
    writeFileSync(f.entry, 'another bundle with the same baked source SHA'); f.write();
    expect(measureArtifact(f.entry, f.sourceSha).status).toBe('unknown');
    expect(measureBootOperatorArtifact(f.entry, f.sourceSha).status).toBe('measured');
  });
});
