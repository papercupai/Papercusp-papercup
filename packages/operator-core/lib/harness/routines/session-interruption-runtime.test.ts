import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), launch: vi.fn(), host: vi.fn(), loops: vi.fn(),
  held: vi.fn(), gates: vi.fn(), pause: vi.fn(), delivery: vi.fn(), ingest: vi.fn(), targets: vi.fn() }));
vi.mock('@papercusp/db-org', async orig => ({ ...(await orig<object>()), getOrgPg: () => ({ sql: m.sql }) }));
vi.mock('../../events/await/psu-pty-discovery', () => ({ findLiveHostAsync: m.host }));
vi.mock('../../events/await/wake-source-predicate', async orig => ({
  ...(await orig<object>()), readHeldWorkItems: m.held, readWorkItemAwaitTargets: m.targets }));
vi.mock('../../events/await/store', () => ({ hasPendingDeliberateWakeDelivery: m.delivery }));
vi.mock('../../attention/gate-store', () => ({ listPendingGates: m.gates }));
vi.mock('../../session-assume-pause', () => ({ readAssumeCallerPause: m.pause }));
vi.mock('./loop', () => ({ getLoopStatuses: m.loops }));
vi.mock('./psu-pty-host-events-ingest', () => ({ ingestPsuPtyHostEvents: m.ingest }));
vi.mock('../../agent-tools/capability/launch-agent', () => ({
  default: { handler: m.launch }, INTERNAL_INTERRUPTION_RECOVERY: Symbol.for('test-interruption') }));
import { interruptionFromEvent, sweepSessionInterruptions } from './session-interruption-runtime';

const now = Date.now();
const snapshot = () => ({ owner_id: 'su-interrupted', session_id: 'native-exact', retired_at: null,
  pid: null, launch_spec: { headless: false }, receipt: null as Record<string, unknown> | null,
  ts: new Date(now), payload: { ownerId: 'su-interrupted', nativeSessionId: 'native-exact', hostPid: 99999999,
    hostStartedAt: now - 10000, advSessionId: '12', workspaceId: 'ws',
    execution: { ownerId: 'su-interrupted', hostPid: 99999999, phase: 'running',
      observedAt: now - 1, turnStartedAt: now - 5000, lastProgressAt: now - 1, pendingTools: 0 } } });
let row = snapshot();
let awaits: unknown[] = [];
const ctx = { workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  vi.clearAllMocks(); row = snapshot(); awaits = [];
  m.host.mockResolvedValue(null); m.loops.mockResolvedValue(new Map()); m.held.mockResolvedValue([]);
  m.gates.mockResolvedValue([]); m.pause.mockResolvedValue(null); m.delivery.mockResolvedValue(false);
  m.ingest.mockResolvedValue({ ingestErrors: 0 }); m.targets.mockResolvedValue(new Map());
  m.launch.mockResolvedValue({ data: { launch: { resumeVerified: true } } });
  m.sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/^owner_id =|^true$/.test(text)) return {};
    if (text.includes('SELECT e.owner_id')) return [row];
    if (text.includes('FROM harness_shared.event_awaits')) return awaits;
    if (text.includes('INSERT INTO harness_shared.session_briefs')) {
      row.receipt = JSON.parse(values.find(v => typeof v === 'string' && v.startsWith('{')) as string);
      return [{ owner_id: row.owner_id }];
    }
    if (text.includes('UPDATE harness_shared.session_briefs')) {
      if (!text.includes('RETURNING owner_id')) return [];
      row.receipt = JSON.parse(values.find(v => typeof v === 'string' && v.startsWith('{')) as string);
      return [{ owner_id: row.owner_id }];
    }
    throw new Error(`unhandled query: ${text}`);
  });
});

describe('production session interruption adapter', () => {
  it('rejects a foreign native witness', () => {
    row.payload.nativeSessionId = 'foreign'; expect(interruptionFromEvent(row)).toBeNull();
  });
  it.each([true, false])('preserves exact native identity and headless=%s through the governed door', async headless => {
    row.launch_spec.headless = headless;
    const result = await sweepSessionInterruptions(ctx);
    expect(result.restored).toEqual([row.owner_id]);
    expect(m.launch).toHaveBeenCalledWith(expect.objectContaining({ resume: { agentId: row.owner_id },
      fork: false, headless, brief: expect.stringContaining('unfinished request'),
      [Symbol.for('test-interruption')]: expect.objectContaining({ ownerId: row.owner_id, nativeSessionId: row.session_id, wait: false }) }), expect.anything());
  });
  it.each(['event', 'delivery', 'future-loop'])('restores a %s wait without submitting a prompt', async kind => {
    if (kind === 'event') awaits = [{ subscriber_id: row.owner_id, event_key: 'dependency:ready', expires_ts: null, once: true }];
    if (kind === 'delivery') m.delivery.mockResolvedValue(true);
    if (kind === 'future-loop') m.loops.mockResolvedValue(new Map([[row.owner_id,
      { active: true, goal: 'existing goal', nextFireAt: new Date(now + 60000).toISOString() }]]));
    await sweepSessionInterruptions(ctx);
    expect(m.launch).toHaveBeenCalledTimes(1);
    expect(m.launch.mock.calls[0][0]).not.toHaveProperty('brief');
    expect(m.launch.mock.calls[0][0][Symbol.for('test-interruption')].wait).toBe(true);
    const waitQuery = m.sql.mock.calls.find(c => c[0].join('').includes('FROM harness_shared.event_awaits'))![0].join('');
    expect(waitQuery).toContain("policy = 'wake'");
  });
  it.each([
    { kind: 'Date', expires_ts: new Date('2026-11-03T15:42:11.952Z'), expected: '2026-11-03T15:42:11.952Z' },
    { kind: 'text', expires_ts: '2026-11-03 15:42:11.952+00', expected: '2026-11-03T15:42:11.952Z' },
    { kind: 'null', expires_ts: null, expected: null },
  ])('normalizes an event-await expiry returned as $kind', async ({ expires_ts, expected }) => {
    awaits = [{ subscriber_id: row.owner_id, event_key: 'dependency:ready',
      expires_ts, timeout_behavior: 'wake', once: true }];

    await sweepSessionInterruptions(ctx);

    expect(m.targets.mock.calls[0]?.[0]).toEqual([{ subscriberId: row.owner_id,
      eventKey: 'dependency:ready', expiresTs: expected, timeoutBehavior: 'wake', once: true }]);
  });
  it('fails closed when an event-await expiry is not a valid timestamp', async () => {
    awaits = [{ subscriber_id: row.owner_id, event_key: 'dependency:ready',
      expires_ts: 'not-a-timestamp', timeout_behavior: 'wake', once: true }];

    await expect(sweepSessionInterruptions(ctx)).rejects.toThrow(
      'event_awaits.expires_ts is not a timestamp: not-a-timestamp');
    expect(m.targets).not.toHaveBeenCalled();
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('does not let the ambient inbox watcher suppress interrupted work', async () => {
    awaits = [{ subscriber_id: row.owner_id, event_key: `coord:inbox-wake:${row.owner_id}`, once: false }];
    await sweepSessionInterruptions(ctx);
    expect(m.launch.mock.calls[0][0]).toHaveProperty('brief');
  });
  it.each(['retired', 'host-live', 'human-gate', 'pause', 'loop-ended'])('holds a %s session', async kind => {
    if (kind === 'retired') (row as { retired_at: unknown }).retired_at = new Date();
    if (kind === 'host-live') m.host.mockResolvedValue({ pid: 123 });
    if (kind === 'human-gate') m.gates.mockResolvedValue([{}]);
    if (kind === 'pause') m.pause.mockResolvedValue({});
    if (kind === 'loop-ended') m.loops.mockResolvedValue(new Map([[row.owner_id, { active: false, explicitlyEnded: true }]]));
    await sweepSessionInterruptions(ctx); expect(m.launch).not.toHaveBeenCalled();
  });
  it('fails closed when a wait read is unavailable', async () => {
    m.delivery.mockRejectedValueOnce(new Error('wait-store-unavailable'));
    await expect(sweepSessionInterruptions(ctx)).rejects.toThrow('wait-store-unavailable');
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('rechecks a stop recorded after reservation before native creation', async () => {
    let nativeCreations = 0;
    m.launch.mockImplementation(async args => {
      Object.assign(row.payload.execution, { ownerStopRequested: true });
      await args[Symbol.for('test-interruption')].beforeNativeCreate();
      nativeCreations += 1;
      return { data: { launch: { resumeVerified: true } } };
    });
    const result = await sweepSessionInterruptions(ctx);
    expect(nativeCreations).toBe(0);
    expect(result.restored).toEqual([]);
    expect(row.receipt).toMatchObject({ state: 'pending', reason: 'interruption-revalidation:owner-stop' });
  });
  it('dry run neither ingests, claims nor launches', async () => {
    await sweepSessionInterruptions(ctx, true);
    expect(m.ingest).not.toHaveBeenCalled(); expect(m.launch).not.toHaveBeenCalled();
    expect(m.sql.mock.calls.some(c => c[0].join('').includes('INSERT INTO'))).toBe(false);
  });
});
