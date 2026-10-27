import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_PREFS, loadWorkspaceVoicePrefs, saveVoicePrefs, type VoicePrefs } from './voice-prefs';

// Exercise the public preference boundary; storage is a port here, so these
// assertions make no PG, actual-host or per-user authorization claim.
const prefsState = vi.hoisted(() => ({ value: null as Partial<VoicePrefs> | null }));
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: storage.read,
  writeOperatorState: storage.write,
}));
vi.mock('./auth', () => ({ getSessionUser: async () => null }));
vi.mock('./user-preferences', () => ({
  loadUserPreferences: vi.fn(), mergeUserOverWorkspace: vi.fn(), VOICE_USER_OVERRIDE_KEYS: [],
}));

describe('P010 host configuration boundaries', () => {
  beforeEach(() => {
    prefsState.value = null;
    storage.read.mockReset().mockImplementation(async () => prefsState.value);
    storage.write.mockReset().mockImplementation(async (_table, value: VoicePrefs) => {
      prefsState.value = structuredClone(value);
    });
  });

  it('defaults to 40000 with no stored settings', async () => {
    expect((await loadWorkspaceVoicePrefs()).operatorHistoryTokenBudget).toBe(40000);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each([4999, 5000, 5001, 39999, 40000, 40001, 149999, 150000, 150001])(
    'keeps the inclusive history budget boundaries on read and write (%s)', async budget => {
      const accepted = budget >= 5000 && budget <= 150000;
      prefsState.value = { operatorHistoryTokenBudget: budget, sttEngine: 'off' };
      const loaded = await loadWorkspaceVoicePrefs();
      expect(loaded.operatorHistoryTokenBudget).toBe(accepted ? budget : 40000);
      expect(loaded.sttEngine).toBe('off');

      prefsState.value = { operatorHistoryTokenBudget: 9000, sttEngine: 'off' };
      const saved = await saveVoicePrefs({ operatorHistoryTokenBudget: budget });
      expect(saved.operatorHistoryTokenBudget).toBe(accepted ? budget : 9000);
      expect(saved.sttEngine).toBe('off');
      expect(storage.write).toHaveBeenCalledExactlyOnceWith('operator_voice_prefs', saved);
      expect((await loadWorkspaceVoicePrefs()).operatorHistoryTokenBudget).toBe(saved.operatorHistoryTokenBudget);
    },
  );

  it.each([NaN, Infinity, -Infinity, -1, 0, undefined, null, 'not-a-budget'])(
    'recovers invalid history settings without overwriting the last valid budget (%s)', async value => {
      const patch = { operatorHistoryTokenBudget: value } as Partial<VoicePrefs>;
      prefsState.value = patch;
      expect((await loadWorkspaceVoicePrefs()).operatorHistoryTokenBudget).toBe(40000);
      prefsState.value = { operatorHistoryTokenBudget: 12000, sttEngine: 'off' };
      expect((await saveVoicePrefs(patch)).operatorHistoryTokenBudget).toBe(12000);
      expect((await saveVoicePrefs({ operatorHistoryTokenBudget: 5000 })).operatorHistoryTokenBudget).toBe(5000);
      expect((await loadWorkspaceVoicePrefs()).sttEngine).toBe('off');
    },
  );

  it('normalizes persisted numeric settings and rejects an unknown context mode', async () => {
    prefsState.value = { operatorHistoryTokenBudget: '5000.6', operatorContextMode: 'future' } as unknown as Partial<VoicePrefs>;
    expect(await loadWorkspaceVoicePrefs()).toMatchObject({ operatorHistoryTokenBudget: 5001, operatorContextMode: 'compaction' });
    prefsState.value = { operatorHistoryTokenBudget: 10000, operatorContextMode: 'window' };
    expect(await saveVoicePrefs({ operatorHistoryTokenBudget: 10000.6, operatorContextMode: 'future' } as unknown as Partial<VoicePrefs>))
      .toMatchObject({ operatorHistoryTokenBudget: 10001, operatorContextMode: 'window' });
  });

  it('propagates a failed settings write and preserves the previous durable budget', async () => {
    prefsState.value = { operatorHistoryTokenBudget: 12000 };
    storage.write.mockRejectedValueOnce(new Error('settings-write-failed'));
    await expect(saveVoicePrefs({ operatorHistoryTokenBudget: 150000 })).rejects.toThrow('settings-write-failed');
    expect((await loadWorkspaceVoicePrefs()).operatorHistoryTokenBudget).toBe(12000);
    expect((await saveVoicePrefs({ operatorHistoryTokenBudget: 150000 })).operatorHistoryTokenBudget).toBe(150000);
  });
});

// P2P voice-channel settings (holepunch-voice-channels-2026-06-05 P-016/D-008):
// the defaults ARE the contract the Voice Settings views render before any user
// write — pin them so a rename/retype breaks loudly here, not in a UI.
describe('voice-channel settings defaults (P-016)', () => {
  it('ships complete channel-voice defaults', () => {
    expect(DEFAULT_VOICE_PREFS).toMatchObject({
      voiceInputDevice: null,
      voiceOutputDevice: null,
      voiceInputMode: 'ptt',
      // Backtick is the real PTT key (hardcoded + reserved in VoiceButton); the
      // default mirrors it so prefs inspection isn't misled by a stale 'v'.
      voicePttKey: '`',
      voiceAec: true,
      voiceNoiseSuppression: true,
      voiceInputGain: 1,
      voiceOutputVolume: 1,
    });
  });

  it('keeps PTT (not open-mic) as the default — open-mic requires AEC hardening (P-010)', () => {
    expect(DEFAULT_VOICE_PREFS.voiceInputMode).toBe('ptt');
  });
});

// WI-3664: "keep local the default". The default embedder is a LOCAL engine,
// NOT 'auto' — 'auto' can pick the cloud key and thrashes on it (WI-3615),
// and @huggingface/transformers is a hard dependency so local is always usable.
describe('embedder default (WI-3664 → gemma → harrier P-015 2026-07-10)', () => {
  it('defaults memoryEmbedderMode to harrier (harrier-oss-0.6b), the local default', () => {
    // Owner decision P-015 2026-07-10: harrier-oss-0.6b is the default
    // memory embedder (won the P-006 gold-set gate: R@1 .8833 vs gemma .8083),
    // superseding the same-day gemma default; gemma stays selectable as the
    // lighter option. Still local — not 'auto' (key-thrash, WI-3615), not
    // cloud 'openai'. Memory-side only: prose/search surfaces stay gemma.
    expect(DEFAULT_VOICE_PREFS.memoryEmbedderMode).toBe('harrier');
  });

  it('keeps the provider ack voice by default (P-002 — no behavior change)', () => {
    expect(DEFAULT_VOICE_PREFS.fullAgentAckVoice).toBe('provider');
  });
});
