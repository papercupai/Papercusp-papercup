// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SelectEntry } from '../../harness/Select';
import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

const h = vi.hoisted(() => ({
  prefs: { fullAgentEngine: 'off', sttEngine: 'voicemode', ttsEngine: 'kokoro' } as VoicePrefs,
  invalidate: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [h.prefs], invalidate: h.invalidate }),
}));
vi.mock('@/app/_components/voice/voice-mode', () => ({
  initVoiceMode: vi.fn(),
  getVoiceConfig: () => ({ wakeWord: 'hey papercup', rate: 1, roleVoices: {} }),
  listAvailableVoices: () => [{ name: 'Alice', lang: 'en-US' }],
  updateVoiceConfig: vi.fn(),
  speak: vi.fn(),
}));
vi.mock('@/app/_components/voice/voice-prefs-client', () => ({ setVoicePrefsClient: vi.fn() }));
vi.mock('../../_components/RouteLink', () => ({ default: ({ children }: React.PropsWithChildren) => <span>{children}</span> }));
vi.mock('../../harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ askConfirm: vi.fn(), confirmEl: null }) }));
// Use a native select to exercise the page's actual options, disabled values,
// stored-value rendering, and preference writes without Radix portal plumbing.
vi.mock('../../harness/Select', () => ({
  Select: ({ value, options, ariaLabel, onChange, disabled }: {
    value: string; options: SelectEntry[]; ariaLabel: string;
    onChange: (value: string) => void; disabled?: boolean;
  }) => <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    {options.flatMap((entry) => 'kind' in entry ? entry.options : [entry]).map((option) =>
      <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import VoiceSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.prefs = { fullAgentEngine: 'off', sttEngine: 'voicemode', ttsEngine: 'kokoro' } as VoicePrefs;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, options?: RequestInit) => ({
    ok: options?.method === 'PUT' || String(url).endsWith('/operator-credentials') || String(url).includes('-spend'),
    json: async () => options?.method === 'PUT'
      // The PUT persists server-side, so the mocked sync query (re-read every render,
      // as the real one is after invalidate()) must return the saved value too.
      ? (h.prefs = { ...h.prefs, ...JSON.parse(String(options.body)) })
      : String(url).includes('-spend') ? { spend: [] }
      : { google: { configured: true }, openai: { configured: true }, elevenlabs: { configured: true } },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('full-agent engine capabilities', () => {
  // voice-final-public-release-2026-10-01#D-005: every full-agent engine is out of
  // this release's scope — disabled even when its provider key reads configured.
  it('disables every release-unavailable full-agent engine even with configured keys, and never saves one', async () => {
    render(<VoiceSettingsPage />);
    const select = await screen.findByRole('combobox', { name: 'Full-agent engine' });
    for (const name of [/OpenAI Realtime/, /Gemini Live/, /ElevenLabs Conversational/]) {
      const option = screen.getByRole('option', { name }) as HTMLOptionElement;
      expect(option.disabled).toBe(true);
      expect(option.textContent).toMatch(/not available in this release/);
    }
    expect((screen.getByRole('option', { name: /^Off — use the STT \+ TTS pair/ }) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'openai-realtime' } });
    expect(fetch).not.toHaveBeenCalledWith('/api/agent-mcp/operator-voice-prefs', expect.anything());
  });

  it('disables release-unavailable cloud TTS and Porcupine while supported engines stay selectable', async () => {
    render(<VoiceSettingsPage />);
    await screen.findByRole('combobox', { name: 'TTS engine' });
    for (const name of [/OpenAI tts-1/, /Cartesia/, /Porcupine/]) {
      const option = screen.getByRole('option', { name }) as HTMLOptionElement;
      expect(option.disabled).toBe(true);
      expect(option.textContent).toMatch(/not available in this release/);
    }
    for (const name of [/Kokoro/, /Browser \(OS voices\)/, /ElevenLabs Turbo/, /openWakeWord/]) {
      expect((screen.getByRole('option', { name }) as HTMLOptionElement).disabled).toBe(false);
    }
  });

  it('preserves a saved unavailable TTS engine and explains it', async () => {
    h.prefs.ttsEngine = 'openai';
    render(<VoiceSettingsPage />);
    const select = await screen.findByRole('combobox', { name: 'TTS engine' }) as HTMLSelectElement;
    expect(select.value).toBe('openai');
    expect(screen.getByRole('alert').textContent).toMatch(/OpenAI TTS is not available in this release/);
    expect(fetch).not.toHaveBeenCalledWith('/api/agent-mcp/operator-voice-prefs', expect.anything());
  });

  it('preserves a saved Gemini value, explains the unsupported state, and lets the user choose Off', async () => {
    h.prefs.fullAgentEngine = 'gemini-live';
    render(<VoiceSettingsPage />);
    const select = await screen.findByRole('combobox', { name: 'Full-agent engine' }) as HTMLSelectElement;
    expect(select.value).toBe('gemini-live');
    expect(screen.getByRole('alert').textContent).toMatch(/Gemini Live is not available in this release/);
    expect(fetch).not.toHaveBeenCalledWith('/api/agent-mcp/operator-voice-prefs', expect.anything());
    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => expect(select.value).toBe('off'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
