import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readAssumeTranscriptPin } from './session-assume-preparation';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function source(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'assume-context-')); roots.push(root);
  const file = join(root, 'native.jsonl'); await writeFile(file, body);
  return { root, file };
}

describe('takeover native context provenance', () => {
  it('authenticates the immutable prefix after native append without replacing its original pin', async () => {
    const body = '{"type":"session_meta","payload":{"id":"native-1"}}\n';
    const { root, file } = await source(body);
    const pin = (await readAssumeTranscriptPin(file, root, 'codex', 'native-1'))!;
    await appendFile(file, '{"type":"event_msg","payload":{"message":"native startup"}}\n');
    expect((await readAssumeTranscriptPin(file, root, 'codex', 'native-1'))?.sha256).not.toBe(pin.sha256);
    expect(await readAssumeTranscriptPin(file, root, 'codex', 'native-1', pin)).toEqual(pin);
  });

  it.each(['prefix mutation', 'truncation', 'replacement', 'foreign native append'])(
    'refuses %s even when startup has authorized prefix verification', async fault => {
      const body = '{"type":"session_meta","payload":{"id":"native-1"}}\n' +
        '{"type":"event_msg","payload":{"message":"original history"}}\n';
      const { root, file } = await source(body);
      const pin = (await readAssumeTranscriptPin(file, root, 'codex', 'native-1'))!;
      if (fault === 'prefix mutation') await writeFile(file, body.replace('original', 'modified'));
      if (fault === 'truncation') await writeFile(file, body.split('\n')[0] + '\n');
      if (fault === 'replacement') {
        await rename(file, file + '.old'); await writeFile(file, body);
      }
      if (fault === 'foreign native append')
        await appendFile(file, '{"type":"session_meta","payload":{"id":"foreign"}}\n');
      expect(await readAssumeTranscriptPin(file, root, 'codex', 'native-1', pin)).toBeNull();
    });

  it.each([
    ['codex', JSON.stringify({ type: 'session_meta', payload: { id: 'native-1' } })],
    ['claude', JSON.stringify({ type: 'user', sessionId: 'native-1', message: 'target history' })],
    ['omp', JSON.stringify({ type: 'session', id: 'native-1' })],
  ] as const)('pins exact %s native bytes without changing them', async (backend, header) => {
    const body = header + '\n'; const { root, file } = await source(body);
    const pin = await readAssumeTranscriptPin(file, root, backend, 'native-1');
    expect(pin).toMatchObject({ mode: 'native-resume', ref: 'native-1',
      sha256: createHash('sha256').update(body).digest('hex') });
    expect(pin?.revision).toBeTruthy();
    expect(await readFile(file, 'utf8')).toBe(body);
    expect(await readAssumeTranscriptPin(file, root, backend, 'different-native')).toBeNull();
  });

  it.each(['{"type":"session_meta","payload":{"id":"native-1"}}\n{broken',
    '{"type":"event_msg","payload":{"message":"no provenance"}}\n',
    '{"type":"session_meta","payload":{"id":"native-1"}}\n{"type":"session_meta","payload":{"id":"foreign"}}\n',
  ])('refuses corrupt, unbound or mixed native history', async body => {
    const { root, file } = await source(body);
    expect(await readAssumeTranscriptPin(file, root, 'codex', 'native-1')).toBeNull();
  });

  it('refuses a file or directory link escaping the target native home', async () => {
    const body = '{"type":"session_meta","payload":{"id":"native-1"}}\n';
    const { root, file } = await source(body);
    const home = join(root, 'target'); await mkdir(home);
    const link = join(home, 'native.jsonl'); await symlink(file, link);
    expect(await readAssumeTranscriptPin(link, home, 'codex', 'native-1')).toBeNull();
    await symlink(root, join(home, 'redirect'));
    expect(await readAssumeTranscriptPin(join(home, 'redirect', 'native.jsonl'), home, 'codex', 'native-1')).toBeNull();
    expect(await readAssumeTranscriptPin(file, home, 'codex', 'native-1')).toBeNull();
  });
});
