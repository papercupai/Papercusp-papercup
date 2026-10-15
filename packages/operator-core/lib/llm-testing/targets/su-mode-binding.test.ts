/**
 * EI-23996297775579005 — the su llm-test target must render the prompt a live
 * session in the scenario's modes actually sees. identities-v1 P-021 moved each
 * mode's DEFINITION into an identity layer bound only while the mode is active,
 * so a target that always renders with `modes: null` silently tests IDEATE/AUTO
 * behaviour against a prompt that carries no IDEATE/AUTO contract.
 */
import { describe, expect, it } from 'vitest';
import { loadPlaybookBody, parseSuTargetConfig, SuTarget } from './su';
import { SU_CATALOG } from './su-catalog';
import { REPORT_KINDS, REPORT_VISIBILITIES } from '../../report-library';

// A phrase only the IDEATE definition layer carries: the closed-loop ritual's
// closing call. The positive case proves the phrase is detector-shaped, so the
// negative case cannot pass vacuously.
const IDEATE_RITUAL = 'blender:ideate-pass-record';

describe('su target mode binding', () => {
  it('advertises production Reports vocabularies and required title constraints', () => {
    const publish = SU_CATALOG.find(tool => tool.name === 'reports:publish')!;
    expect(publish.input).toMatchObject({ required: ['title'], properties: {
      title: { minLength: 1, maxLength: 500 },
      kind: { enum: [...REPORT_KINDS] }, visibility: { enum: [...REPORT_VISIBILITIES] },
    } });
    expect(REPORT_KINDS).not.toContain('architecture-review');
  });

  it('renders the Reports delivery sequence in the actual AUTO prompt and tool catalog', async () => {
    const prompt = await loadPlaybookBody(['auto']);
    expect(prompt).toContain('(1) `reports:publish`; (2) `reports:get { id: report_id }`');
    expect(prompt).toContain('verify that readback contains the complete Markdown and intended');
    expect(prompt).toContain('saved or delivered only after the readback succeeds');
    const publish = SU_CATALOG.find(tool => tool.name === 'reports:publish');
    expect(publish?.description).toContain('reports:get { id: report_id }');
    expect(publish?.description).toContain('verify the complete body and visibility before citing the path or claiming delivery');
  }, 60_000);

  it('renders a bound mode definition layer and omits it when no mode is bound', async () => {
    const [unbound, ideate] = await Promise.all([loadPlaybookBody(), loadPlaybookBody(['ideate'])]);
    expect(ideate).toContain(IDEATE_RITUAL);
    expect(unbound).not.toContain(IDEATE_RITUAL);
    expect(ideate.length).toBeGreaterThan(unbound.length);
    // The IDEATE layer must name the lens tag's exact arg shape. It once said only "file each
    // idea lens-tagged", and a bound S28 run then passed `lens` flat, which the real tool
    // (improvements:capture reads `ideation.lens`) does not credit to any lens.
    expect(ideate).toContain('ideation:{ lens, bet?, cheapExperiment? }');
  }, 60_000);

  it('parses targetConfig.modes and fails loud on unknown keys or malformed values', () => {
    expect(parseSuTargetConfig(undefined)).toEqual({ modes: null });
    expect(parseSuTargetConfig({})).toEqual({ modes: null });
    expect(parseSuTargetConfig({ modes: [] })).toEqual({ modes: null });
    expect(parseSuTargetConfig({ modes: [' ideate '] })).toEqual({ modes: ['ideate'] });
    expect(() => parseSuTargetConfig({ mode: ['ideate'] })).toThrow(/unknown targetConfig key "mode"/);
    expect(() => parseSuTargetConfig({ modes: 'ideate' })).toThrow(/array of non-empty mode names/);
    expect(() => parseSuTargetConfig({ modes: [''] })).toThrow(/array of non-empty mode names/);
  });

  it('refuses modes on a session whose prompt is replaced, instead of silently dropping them', async () => {
    const custom = new SuTarget({ catalog: { canonicalBySanitized: new Map() } as never, loadSystemPrompt: () => 'x' });
    await expect(
      custom.open({ runId: 'r', workspaceMode: 'isolated', transport: 'in-process', targetConfig: { modes: ['ideate'] } }),
    ).rejects.toThrow(/silently dropped/);
  });
});
