/** P006: prepare off-hook, then perform only bounded blob lookups at delivery. */
import type { CloneIndex } from './clone-index';
import type { PushFact, PushInput } from './push-channel';
import type { PushProofSource, PushSnapshot } from './push-snapshot';

export interface PreparedCloneNote {
  family: string; text: string; sources: PushProofSource[];
}
export interface PreparedCloneFile {
  path: string; sha256: string; notes: PreparedCloneNote[];
}
const safePath = (path: unknown): path is string => typeof path === 'string'
  && path.length > 0 && path.length <= 4096 && !/[\\\r\n\0]/.test(path)
  && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Versioned, validated rows are assembled once by the existing snapshot loader. */
export function acceptPreparedCloneFile(value: unknown): PreparedCloneFile | null {
  const row = value as PreparedCloneFile | null;
  if (!row || !safePath(row.path) || !/\.tsx?$/.test(row.path) || !hash(row.sha256)
    || !Array.isArray(row.notes) || row.notes.length > 3) return null;
  if (!row.notes.every(note => note && typeof note.family === 'string' && hash(note.family)
    && typeof note.text === 'string' && note.text.length <= 350 && !/[\r\n]/.test(note.text)
    && Array.isArray(note.sources) && note.sources.length <= 2 && note.sources.length > 0
    && note.sources.every(source => source && safePath(source.path) && hash(source.sha256)))) return null;
  return row;
}

/** Full population work belongs to the maintained producer, never the hook. */
export function prepareCloneAdvisories(index: CloneIndex): PreparedCloneFile[] {
  const files = new Map<string, PreparedCloneFile>();
  for (const file of index.getFiles()) if (file.status === 'indexed' && file.sha256) {
    files.set(file.path, { path: file.path, sha256: file.sha256, notes: [] });
  }
  for (const family of index.families('renamed', { crossFile: false })) {
    for (const fn of family.members) {
      const target = family.members.find(member => member.id !== fn.id);
      const file = files.get(fn.path), other = target && files.get(target.path);
      if (!target || !file || !other || file.notes.length >= 3 || file.notes.some(note => note.family === family.fingerprint)) continue;
      const location = `${target.name.slice(0, 80)} (${target.path}:${target.line})`;
      const text = `Clone advisory: ${family.members.length} copies; reuse ${location}; call/extract it or widen its signature.`;
      // Never clip a location into a misleading reference.
      if (text.length > 350) continue;
      file.notes.push({ family: family.fingerprint, text,
        sources: [...new Map([{ path: file.path, sha256: file.sha256 },
          { path: other.path, sha256: other.sha256 }].map(source => [source.path, source])).values()] });
    }
  }
  return [...files.values()];
}

/** Missing/stale blobs are unknown, never a measured absence of clones. */
export function cloneAdvisoryLookup(input: PushInput, snapshot: PushSnapshot): {
  status: 'measured' | 'unknown'; facts: PushFact[];
} {
  if (!snapshot.cloneFiles) return { status: 'unknown', facts: [] };
  const seenFiles = new Set<string>(), seenFamilies = new Set<string>();
  const notes: PreparedCloneNote[] = [], identities: string[] = [];
  let unknown = false;
  for (const call of input.calls.slice(-20)) {
    if (!/(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? '')) continue;
    for (const raw of (call.cloneEdits ?? []).slice(0, 20)) {
      const edit = raw as { path?: string; sha256?: string };
      if (!edit || !safePath(edit.path) || !hash(edit.sha256) || seenFiles.has(edit.path)) continue;
      if (seenFiles.size >= 20) break;
      seenFiles.add(edit.path);
      const file = snapshot.cloneFiles.get(edit.path);
      if (!file || file.sha256 !== edit.sha256) { unknown = true; continue; }
      for (const note of file.notes) if (!seenFamilies.has(note.family) && notes.length < 3) {
        seenFamilies.add(note.family); notes.push(note); identities.push(`${note.family}:${edit.sha256}`);
      }
    }
  }
  const sources = [...new Map(notes.flatMap(note => note.sources).map(source => [source.path, source])).values()];
  return { status: unknown || !seenFiles.size ? 'unknown' : 'measured', facts: notes.length ? [{
    leg: 'clone', subject: identities.sort().join('|'), text: notes.map(note => note.text).join('\n'),
    citedPaths: sources.map(source => source.path), sourceHashes: sources,
  }] : [] };
}
export const snapshotCloneLeg = (input: PushInput, snapshot: PushSnapshot): PushFact[] => cloneAdvisoryLookup(input, snapshot).facts;
