import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitPushFacts, CODE_INTEL_PUSH_MAX_CHARS, CODE_INTEL_PUSH_TURN_CHARS, formatPushFact, type PushFact } from './push-channel';
import { parsePushSnapshot } from './push-snapshot';

// code-intel-delivery-and-outcomes-2026-10-26 SPEC-P-005-B: the turn's OWN code-intel budget
// decides whether a later push in the same turn is delivered. Memory recall no longer shares
// it: the production caller always passes the whole turn budget as the request share (pinned
// in push-channel.test.ts). A fake transaction stands in for Postgres so the real admission
// arithmetic in commitPushFacts runs at the unit layer; the database-backed twin of these
// cases is push-channel.integration.test.ts.
const fake = vi.hoisted(() => {
  const state = { spent: 0, pushed: [] as number[], skipSites: [] as string[] };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT turn_id')) return Promise.resolve([{ turn_id: 'turn-1' }]);
    if (text.includes('SELECT epoch')) return Promise.resolve([{ epoch: 0 }]);
    if (text.includes('SUM(chars)')) return Promise.resolve([{ chars: state.spent }]);
    if (text.includes('INSERT INTO harness_shared.code_intel_pushes')) {
      // Column order: ..., suggested_call, chars, client.
      state.pushed.push(Number(values[values.length - 2]));
      return Promise.resolve([{ id: state.pushed.length }]);
    }
    return Promise.resolve([]);
  };
  // recordPushSkips writes through a savepoint; the last unnest() array it binds is the site column.
  const savepoint = async (cb: (sp: typeof tag) => Promise<unknown>) => cb((_strings, ...values) => {
    state.skipSites.push(...(values.filter(Array.isArray).at(-1) as string[]));
    return Promise.resolve([]);
  });
  return { state, tx: Object.assign(tag, { savepoint }) };
});
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<object>()),
  withWorkspace: (_workspace: string, cb: (tx: unknown) => Promise<unknown>) => cb(fake.tx),
}));

const input = { workspace: 'push-budget-unit', owner: 'agent-A', harness: 'papercusp', calls: [{ tool: 'Read' }] };
const snapshot = () => parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
  index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) }, generatedAt: new Date().toISOString(),
  edges: [{ importer: 'test.ts', imported: 'target.ts', importerSha256: 'b'.repeat(64) }] }))!;
// Each fixture push renders to exactly the per-push cap.
const OVERHEAD = formatPushFact({ leg: 'first-touch', subject: 'probe', text: 'x', citedPaths: ['target.ts'] }, snapshot()).length - 1;
const fact = (subject: string): PushFact => ({ leg: 'first-touch', subject, text: 'x'.repeat(CODE_INTEL_PUSH_MAX_CHARS - OVERHEAD), citedPaths: ['target.ts'] });
const deliver = (facts: PushFact[]) =>
  commitPushFacts(input, snapshot(), facts, CODE_INTEL_PUSH_TURN_CHARS, new AbortController().signal);

describe('SPEC-P-005-B: later pushes in a turn draw on the reserved code-intel budget', () => {
  beforeEach(() => { fake.state.spent = 0; fake.state.pushed = []; fake.state.skipSites = []; });

  it('delivers a second push within the per-push cap after one push was already delivered this turn', async () => {
    expect(formatPushFact(fact('probe'), snapshot()).length).toBe(CODE_INTEL_PUSH_MAX_CHARS);
    fake.state.spent = CODE_INTEL_PUSH_MAX_CHARS; // the turn's first push, delivered by an earlier hook call
    const text = await deliver([fact('second')]);
    expect(text).not.toBe('');
    expect(fake.state.pushed).toEqual([CODE_INTEL_PUSH_MAX_CHARS]);
    expect(fake.state.skipSites).toEqual([]);
  });

  it('fills the turn to exactly its reserved budget, then records the next push as a turn-budget skip', async () => {
    fake.state.spent = CODE_INTEL_PUSH_TURN_CHARS - CODE_INTEL_PUSH_MAX_CHARS;
    expect(await deliver([fact('third')])).not.toBe('');
    expect(fake.state.pushed).toEqual([CODE_INTEL_PUSH_MAX_CHARS]);
    fake.state.spent = CODE_INTEL_PUSH_TURN_CHARS;
    expect(await deliver([fact('fourth')])).toBe('');
    expect(fake.state.skipSites).toEqual(['turn-budget']);
  });
});
