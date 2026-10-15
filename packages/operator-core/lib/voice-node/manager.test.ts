/**
 * voice-node/manager.ts — `ensureNode()` in-flight-build memo (WI-37484).
 *
 * `ensureNode` used to be a bare check-then-act: `if (node) return node;`
 * followed by several `await`s (dynamic hyperswarm import, relay-key lookup,
 * codec load) before the `node = createVoiceNode(...)` assignment. Two
 * concurrent callers of `joinVoiceChannel` (the `voice:join` agent tool and
 * the desktop local-audio-socket handler both funnel into it) would each
 * pass the guard, each construct its OWN hyperswarm instance, and only the
 * last assignment would survive — the other swarm was built, joined the
 * DHT, and then leaked (never destroyed, never referenced again).
 *
 * This test drives TWO concurrent `joinVoiceChannel` calls for the same
 * channel and asserts exactly ONE hyperswarm + ONE voice node was built.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/voice-node/manager.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks for every module ensureNode()/joinVoiceChannel() touch --------

const hyperswarmCtor = vi.fn(function HyperswarmStub(this: { destroy: () => Promise<void> }) {
  this.destroy = vi.fn().mockResolvedValue(undefined);
});
vi.mock('hyperswarm', () => ({ default: hyperswarmCtor }));

const fakeChannelHandle = () => ({
  muted: false,
  peers: vi.fn(() => []),
  onMixedFrame: vi.fn(() => () => {}),
  onPeerFrame: vi.fn(() => () => {}),
  onPeerVideoFrame: vi.fn(() => () => {}),
  onPeersChanged: vi.fn(() => () => {}),
  leave: vi.fn().mockResolvedValue(undefined),
  pushMic: vi.fn(),
  pushVideo: vi.fn(),
  setMuted: vi.fn(),
  setCameraOn: vi.fn(),
});

const createVoiceNode = vi.fn(() => ({
  joinChannel: vi.fn(() => fakeChannelHandle()),
}));
vi.mock('@papercusp/p2p-voice', () => ({ createVoiceNode }));

vi.mock('./codec', () => ({
  getOpusCodec: vi.fn().mockResolvedValue({}),
  VOICE_FRAME_SAMPLES: 960,
}));

vi.mock('./mic-dsp', () => ({
  createMicDsp: vi.fn(() => ({
    configure: vi.fn().mockResolvedValue(undefined),
    pushFarEnd: vi.fn(),
    process: vi.fn((f: Int16Array) => f),
    reset: vi.fn(),
    status: vi.fn(() => ({})),
  })),
  micDspConfigFromPrefs: vi.fn(() => ({})),
}));

vi.mock('../voice-prefs', () => ({ loadVoicePrefs: vi.fn().mockResolvedValue({}) }));

const CHANNEL = { id: 'vc-1', name: 'general', topicHex: 'ab'.repeat(32), createdAt: 0 };
vi.mock('./registry', () => ({
  resolveVoiceChannel: vi.fn().mockResolvedValue(CHANNEL),
  ensureVideoChannel: vi.fn(),
}));

vi.mock('../sync/hyperbee/swarm', () => ({
  swarmConstructorOpts: vi.fn(() => ({})),
  dhtBootstrapMisconfigured: vi.fn(() => false),
}));

vi.mock('./voice-relay', () => ({ getVoiceRelayKeys: vi.fn().mockResolvedValue([]) }));

describe('voice-node manager — ensureNode concurrency (WI-37484)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('builds exactly ONE hyperswarm + ONE voice node when two joins race', async () => {
    const { joinVoiceChannel } = await import('./manager');
    const [a, b] = await Promise.all([joinVoiceChannel('vc-1'), joinVoiceChannel('vc-1')]);
    expect(hyperswarmCtor).toHaveBeenCalledTimes(1);
    expect(createVoiceNode).toHaveBeenCalledTimes(1);
    expect(a.channel?.id).toBe('vc-1');
    expect(b.channel?.id).toBe('vc-1');
  });

  it('does not rebuild the node on a subsequent join once it is warm', async () => {
    const { joinVoiceChannel, leaveVoiceChannel } = await import('./manager');
    await joinVoiceChannel('vc-1');
    await leaveVoiceChannel();
    await joinVoiceChannel('vc-1');
    // The node (and its underlying swarm) is a process-lifetime singleton —
    // only the CHANNEL is re-joined on leave/rejoin, never the transport.
    expect(hyperswarmCtor).toHaveBeenCalledTimes(1);
    expect(createVoiceNode).toHaveBeenCalledTimes(1);
  });
});
