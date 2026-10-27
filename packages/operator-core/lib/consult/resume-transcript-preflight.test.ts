import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResumeTarget } from '../agent-launch-core';
import { checkConsultSessionPortTranscript } from './resume-transcript-preflight';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const target = (agent = 'claude', extra: Partial<ResumeTarget> = {}): ResumeTarget => ({
  agent, role: null, sessionId: 'native-1', ompThreadId: null, ...extra,
} as ResumeTarget);
function transcript(records: unknown[], tail = '') {
  const dir = mkdtempSync(join(tmpdir(), 'consult-port-preflight-'));
  dirs.push(dir);
  const path = join(dir, 'source.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n' + tail);
  return { available: true, detail: 'exact source fixture', transcriptPath: path };
}
const dialogue = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'question' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'answer' } },
];

describe('consult session-port source preflight', () => {
  it.each(['exact', 'missing', 'ambiguous', 'foreign-session', 'absent-index'] as const)(
    'applies the maintained exact-span selector before approving a %s source', async (kind) => {
      const records = kind === 'ambiguous'
        ? [...dialogue, { ...dialogue[1], uuid: 'a2', parentUuid: 'a1' }]
        : dialogue;
      const span = {
        sessionId: kind === 'foreign-session' ? 'foreign-id' : 'native-1', turnIndices: [1], contextTurns: 2,
        evidenceTurns: kind === 'absent-index' ? [] : [{ turnIdx: 1, speaker: 'assistant', timestamp: null,
          text: kind === 'missing' ? 'absent evidence' : 'answer' }],
      };
      const result = await checkConsultSessionPortTranscript(target(), transcript(records), span);
      expect(result.available).toBe(kind === 'exact');
      if (kind !== 'exact') expect(result.detail).toMatch(/exact tracked source|not present|ambiguously|absent from/);
    });

  it('accepts portable dialogue and excludes a concurrent partial trailing record', async () => {
    const source = transcript(dialogue, '{partial');
    expect(await checkConsultSessionPortTranscript(target(), source)).toMatchObject({ available: true });
  });
  it.each(['cycle', 'duplicate'])('refuses %s with the same maintained graph guard as port inspection', async (kind) => {
    const records = kind === 'cycle'
      ? [{ ...dialogue[0], parentUuid: 'a1' }, dialogue[1]]
      : [dialogue[0], { ...dialogue[1], uuid: 'u1' }];
    const result = await checkConsultSessionPortTranscript(target(), transcript(records));
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(kind === 'cycle' ? /cycle detected/ : /duplicate uuid/);
  });
  it('does not infer portability from file existence or an unknown native identity', async () => {
    expect(await checkConsultSessionPortTranscript(target(), { available: true, detail: 'exists' }))
      .toMatchObject({ available: false });
    expect(await checkConsultSessionPortTranscript(target('claude', { sessionId: null }), transcript(dialogue)))
      .toMatchObject({ available: false });
    expect(await checkConsultSessionPortTranscript(target(), { available: true, detail: 'gone', transcriptPath: '/missing-consult-source.jsonl' }))
      .toMatchObject({ available: false, detail: expect.stringContaining('preflight refused') });
  });
  it('refuses a named persona before reading or porting its transcript', async () => {
    expect(await checkConsultSessionPortTranscript(target('claude', { role: 'reviewer' }), transcript(dialogue)))
      .toMatchObject({ available: false, detail: expect.stringContaining('plain tracked SU') });
  });
  it.each(['native-1', 'foreign-id'])('checks Codex native identity (%s) through its real adapter', async (id) => {
    const source = transcript([
      { type: 'session_meta', payload: { id } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } },
    ]);
    expect((await checkConsultSessionPortTranscript(target('codex'), source)).available).toBe(id === 'native-1');
  });
  it.each(['native-1', 'foreign-id'])('checks OMP thread identity (%s) through its real adapter', async (id) => {
    const source = transcript([
      { type: 'session', id, version: 3 },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'question' }] } },
    ]);
    expect((await checkConsultSessionPortTranscript(target('omp', { ompThreadId: 'native-1' }), source)).available)
      .toBe(id === 'native-1');
  });
});
