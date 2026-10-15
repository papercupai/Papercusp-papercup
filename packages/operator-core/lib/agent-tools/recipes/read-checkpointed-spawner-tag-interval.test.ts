import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Keep this fixture synchronized with the persisted recipe via recipes:revise.
const script = readFileSync(new URL('./fixtures/read-checkpointed-spawner-tag-interval.recipe.txt', import.meta.url), 'utf8');
const tags = [
  'spawner-socket-error',
  'spawner-socket-peer-eof',
  'spawner-ipc-client-fault',
  'spawner-process-exec-fault',
  'spawner-process-drain',
];
const now = 1_791_360_000;

function run() {
  const logs = vi.fn(async (_args: unknown) => ({
    entries: [],
    matched: 0,
    collapsed: 0,
    truncated: false,
    journalAvailable: true,
    journalError: null,
    units: ['papercusp-bg-host.service'],
  }));
  const readWorkItem = vi.fn(async () => ({
    results: [{
      id: 'WI-10005443',
      ok: true,
      resume: {
        checkpoint: { status: 'available', contentHash: 'current-checkpoint' },
        nextAction: { status: 'available', text: 'Scan tags from @1791359974 to the current UTC endpoint.' },
      },
    }],
  }));
  const context = vm.createContext({
    tools: { work_items: { get: readWorkItem }, logs: { read: logs } },
    Date: { now: () => now * 1000 },
  });
  const result = vm.runInContext('(async () => {\n' + script + '\n})()', context) as Promise<Record<string, unknown>>;
  return { result, logs, readWorkItem };
}

describe('read-checkpointed-spawner-tag-interval saved recipe', () => {
  it('sends a valid escaped-bracket regex matching each exact tag', async () => {
    const scan = run();
    const result = await scan.result;
    expect(result).toMatchObject({
      ok: true,
      window: { since: '@1791359974', until: '@1791360000' },
      tagCounts: Object.fromEntries(tags.map(tag => [tag, 0])),
    });
    expect(scan.readWorkItem).toHaveBeenCalledTimes(1);
    expect(scan.logs).toHaveBeenCalledTimes(1);
    const grep = (scan.logs.mock.calls[0]?.[0] as { grep: string }).grep;
    const pattern = new RegExp(grep);
    for (const tag of tags) {
      expect(pattern.test('[' + tag + ']')).toBe(true);
      expect(pattern.test(tag)).toBe(false);
    }
  });
});
