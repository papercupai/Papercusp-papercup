/**
 * The "Embedding device" section's wording rules (WI-10002872, plan
 * memory-reduction-2026-09-24 D-008). The rule these pin: "In use" is what the
 * embedding process REPORTS, never the stored choice.
 */
import { describe, expect, it } from 'vitest';
import { choiceOf, embedDeviceView, type EmbedDeviceEnvelopeView, type EmbedDeviceHealthView } from './embed-device-view';

function health(over: Partial<EmbedDeviceHealthView> = {}): EmbedDeviceHealthView {
  return {
    requested: { device: 'cuda', preference: 'cuda', source: 'setting', invalidValue: null, setting: 'cuda', why: 'the Settings choice is GPU' },
    active: { device: 'cuda', verified: true, why: 'constructed' },
    pipelines: { 'onnx-community/embeddinggemma-300m-ONNX': 'cuda' },
    demotion: null,
    nvidiaDriverPresent: true,
    gpuProviderAvailable: true,
    ...over,
  };
}

function envelope(over: Partial<EmbedDeviceEnvelopeView> = {}): EmbedDeviceEnvelopeView {
  return {
    setting: 'cuda',
    settingError: null,
    host: { kind: 'sidecar', url: 'http://127.0.0.1:3384' },
    health: health(),
    healthError: null,
    reloadSupported: true,
    ...over,
  };
}

describe('embedDeviceView', () => {
  it('maps the stored value to the select: cuda→gpu, nothing→auto', () => {
    expect(choiceOf('cuda')).toBe('gpu');
    expect(choiceOf('cpu')).toBe('cpu');
    expect(choiceOf('auto')).toBe('auto');
    expect(choiceOf(null)).toBe('auto');
  });

  it('P-530: says an on-demand sidecar is not running now and will pick the setting up when it starts', () => {
    const v = embedDeviceView(envelope({ host: { kind: 'sidecar-idle' }, health: null, reloadSupported: null }));
    expect(v.hostLine).toContain('not running now');
    expect(v.hostLine).toContain('when it next starts');
    expect(v.inUse).toBeNull();
  });

  it('shows the verified device and each model, with the org prefix dropped', () => {
    const v = embedDeviceView(envelope());
    expect(v.inUse).toBe('GPU');
    expect(v.perModel).toEqual(['embeddinggemma-300m-ONNX: GPU']);
    expect(v.hostLine).toContain('shared embedding sidecar');
    expect(v.notices).toEqual([]);
    expect(v.demotionWarning).toBeNull();
  });

  it('a GPU choice that fell back reads as CPU with a warning — never as GPU', () => {
    const v = embedDeviceView(
      envelope({
        health: health({
          requested: { device: 'cpu', preference: 'cuda', source: 'setting', invalidValue: null, setting: 'cuda', why: 'GPU failed' },
          active: { device: 'cpu', verified: true, why: 'constructed' },
          pipelines: { 'Xenova/bge-small-en-v1.5': 'cpu' },
          demotion: { from: 'cuda', to: 'cpu', model: 'Xenova/bge-small-en-v1.5', stage: 'construct', cause: 'libcudnn missing', at: 'now' },
        }),
      }),
    );
    expect(v.choice).toBe('gpu');
    expect(v.inUse).toBe('CPU');
    expect(v.demotionWarning).toContain('libcudnn missing');
    expect(v.demotionWarning).toContain('fell back to the CPU');
  });

  it('before any model loads, says so instead of claiming a device', () => {
    const v = embedDeviceView(envelope({ health: health({ active: { device: 'cuda', verified: false, why: 'none yet' }, pipelines: {} }) }));
    expect(v.inUse).toBe('not loaded yet — will use GPU');
  });

  it('flags a host env pin that overrides the choice', () => {
    const v = embedDeviceView(
      envelope({
        setting: 'cuda',
        health: health({ requested: { device: 'cpu', preference: 'cpu', source: 'env', invalidValue: null, setting: 'cuda', why: 'env' } }),
      }),
    );
    expect(v.notices.some((n) => n.includes('PAPERCUSP_EMBED_DEVICE=cpu') && n.includes('overrides'))).toBe(true);
  });

  it('explains a CPU result on Auto when there is no driver or no GPU runtime', () => {
    const noDriver = embedDeviceView(
      envelope({
        setting: null,
        health: health({
          requested: { device: 'cpu', preference: 'auto', source: 'default', invalidValue: null, setting: null, why: 'auto' },
          nvidiaDriverPresent: false,
        }),
      }),
    );
    expect(noDriver.notices).toContain('No NVIDIA GPU driver was found, so embeddings use the CPU.');

    const noRuntime = embedDeviceView(
      envelope({
        setting: null,
        health: health({
          requested: { device: 'cpu', preference: 'auto', source: 'default', invalidValue: null, setting: null, why: 'auto' },
          gpuProviderAvailable: false,
        }),
      }),
    );
    expect(noRuntime.notices).toContain('The GPU runtime library is not installed, so embeddings use the CPU.');

    // A deliberate CPU choice needs no explanation.
    const chosen = embedDeviceView(
      envelope({ setting: 'cpu', health: health({ requested: { device: 'cpu', preference: 'cpu', source: 'setting', invalidValue: null, setting: 'cpu', why: 'cpu' }, nvidiaDriverPresent: false }) }),
    );
    expect(chosen.notices).toEqual([]);
  });

  it('an unreadable host yields no "In use" (the section shows the error instead)', () => {
    const v = embedDeviceView(envelope({ health: null, healthError: 'did not answer' }));
    expect(v.inUse).toBeNull();
    expect(v.perModel).toEqual([]);
  });

  it('warns when the running sidecar is too old to apply a change live', () => {
    expect(embedDeviceView(envelope({ reloadSupported: false })).notices.some((n) => n.includes('restarts'))).toBe(true);
  });
});
