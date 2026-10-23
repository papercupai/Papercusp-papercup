import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { builtinBlueprintPath, resolveFirstPartyContextClass, SU_MODE_DOCUMENTS } from '@papercusp/orchestrator/blueprint';
import * as blueprint from '@papercusp/orchestrator/blueprint';
import { BUILTIN_MODE_COMPONENTS } from '@papercusp/orchestrator/mode-catalog';
import {
  bindSelectedIdentityOutputArtifact, bindSelectedIdentityOutputs, compileSelectedIdentityResources,
  getSelectedModeCatalog, getSelectedModeDefinitions, listIdentitySources,
} from './source';

const scope = { workspace: 'ws-test', goal: 'goal-1', ownerId: 'su-goal-1' };
const observedAt = '2026-09-24T13:00:00.000Z';

describe('identity launch document preflight', () => {
  it('keeps unlaunchable built-in lenses and the unresolved planner out of the launch picker', async () => {
    const catalog = await listIdentitySources({ limit: 100 });
    for (const id of ['scout.lens-analogical', 'scout.lens-constraint-removal',
      'scout.lens-first-principles', 'scout.lens-reframing', 'su.specialist-planner']) {
      const entry = catalog.identities.find((candidate) => candidate.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.launchCompatibility, id).toMatchObject({ eligible: false, reason: expect.any(String) });
    }
    expect(catalog.identities.find((entry) => entry.id === 'su.practice')?.launchCompatibility)
      .toMatchObject({ eligible: false, reason: expect.stringContaining('producer') });
  });

  it('preflights fixed prompt declarations even when a fallback slot document exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'identity-launch-preflight-'));
    const id = 'broken-fixed-practice';
    const identityDir = join(root, '.papercusp', 'blueprints', id);
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), stringifyYaml({
        id, extends: 'base', version: '1.0.0', description: 'Broken declared prompt.',
        slots: [{ slot: 'practice' }], contributions: [{ id: 'practice-text', purpose: 'prompt',
          source: 'fixed', refresh: 'source-change', inputKind: 'prompt-file', ref: 'base:missing-launch-document' }],
      }));
      writeFileSync(join(identityDir, 'prompts', 'practice.md'), 'UNDECLARED FALLBACK\n');
      const validId = 'aaa-valid-fixed-practice';
      const validDir = join(root, '.papercusp', 'blueprints', validId);
      mkdirSync(validDir, { recursive: true });
      writeFileSync(join(validDir, 'blueprint.yaml'), stringifyYaml({
        id: validId, extends: 'base', version: '1.0.0', description: 'Valid inherited fixed prompt.',
        slots: [{ slot: 'practice' }], contributions: [{ id: 'practice-text', purpose: 'prompt',
          source: 'fixed', refresh: 'source-change', inputKind: 'prompt-file', ref: 'base:su.practice' }],
      }));
      const catalog = await listIdentitySources({ repoDir: root, limit: 100 });
      expect(catalog.identities.find((entry) => entry.id === id)?.launchCompatibility)
        .toMatchObject({ eligible: false, reason: expect.stringContaining('missing-launch-document') });
      expect(catalog.identities.find((entry) => entry.id === validId)?.launchCompatibility)
        .toEqual({ eligible: true, reason: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('selected identity producer output binding', () => {
  it('reconciles every built-in SU contribution with the census and compiled provenance', async () => {
    const blueprintRoot = dirname(dirname(builtinBlueprintPath('su')));
    const census = readFileSync(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE ??
      new URL('../../../../docs/evidence/p007-identity-input-consumer-census-2026-09-25.md', import.meta.url), 'utf8');
    const censusRows = new Map(census.split('\n').flatMap((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const key = /^`(su(?:\.[^`]+)?\/[^`]+)`$/.exec(cells[0] ?? '')?.[1];
      return key ? [[key, cells] as const] : [];
    }));
    const identities = readdirSync(blueprintRoot).filter((id) =>
      (id === 'su' || id.startsWith('su.')) && existsSync(join(blueprintRoot, id, 'blueprint.yaml')));
    const declarations = identities.flatMap((id) => {
      const raw = parseYaml(readFileSync(join(blueprintRoot, id, 'blueprint.yaml'), 'utf8')) as {
        contributions?: Array<{ id: string; purpose: string; source: 'fixed' | 'provider';
          refresh: string; inputKind: string; ref: string; producerRef?: string;
          availability?: 'required' | 'optional' }>;
      };
      return (raw.contributions ?? []).map((entry) => ({ identityId: id, ...entry }));
    });
    const keys = declarations.map((entry) => `${entry.identityId}/${entry.id}`);
    expect(keys).toHaveLength(24);
    expect([...censusRows.keys()].sort()).toEqual([...keys].sort());
    for (const entry of declarations) {
      const cells = censusRows.get(`${entry.identityId}/${entry.id}`)!;
      // The census names the in-process producer behind each first-party class.
      const firstParty = entry.producerRef ? resolveFirstPartyContextClass(entry.producerRef) : null;
      expect(cells[1], entry.id).toContain(firstParty
        ? firstParty.providerRef.replace(/^first-party:/, '') : entry.producerRef ?? entry.ref);
      expect(cells[2].replaceAll(' ', '-'), entry.id).toContain(entry.refresh);
      expect(cells[3], entry.id).toMatch(/\.test\.ts/);
    }
    for (const identityId of identities) {
      const provided = declarations.filter((entry) => entry.identityId === identityId && entry.source === 'provider');
      if (!provided.length) continue;
      // A schema-valid value for each first-party JSON class (D-039).
      const sampleSettings: Record<string, unknown> = {
        'papercusp.mode-state@1': [{ mode: 'auto' }],
        'papercusp.current-assignment@1': { ownerId: 'su-1', intent: null, currentPlanSlug: null },
        'papercusp.coord-orientation@1': { ok: true },
        'papercusp.fleet-leader-brief@1': { summary: { fleet: 'alpha' } },
      };
      const output = (entry: typeof provided[number]) => ({ contributionId: entry.id,
        value: entry.inputKind === 'prompt-file' ? `CURRENT ${entry.id}` : sampleSettings[entry.producerRef!] });
      const outputs = provided.map(output);
      const input = { identityId, sourceTier: 'builtin' as const, outputs,
        scope: { workspace: 'ws-test', harness: 'papercusp', ownerId: 'su-1' }, observedAt };
      const bound = await bindSelectedIdentityOutputArtifact(input);
      for (const entry of provided) {
        expect(bound.artifact.provenance, `${identityId}/${entry.id}`).toContainEqual(expect.objectContaining({
          path: `contribution.${entry.id}`, decision: `provider:${entry.refresh}`,
          producerRef: entry.producerRef,
        }));
        const others = outputs.filter((candidate) => candidate.contributionId !== entry.id);
        if (entry.availability === 'optional') {
          const omitted = await bindSelectedIdentityOutputArtifact({ ...input,
            outputs: [...others, { contributionId: entry.id,
              omission: { reason: 'not-requested' as const } }],
          });
          expect(omitted.artifact.provenance, `${identityId}/${entry.id}`).toContainEqual(
            expect.objectContaining({ path: `contribution.${entry.id}`, decision: 'omitted:not-requested' }),
          );
        } else {
          await expect(bindSelectedIdentityOutputArtifact({ ...input,
            outputs: [...others, { contributionId: entry.id,
              omission: { reason: 'not-requested' as const } }],
          })).rejects.toThrow(/declared operational input is absent|declared prompt input is absent/);
        }
      }
    }
  });

  it('requires both root SU mode and assignment outputs with their declared turn producers', async () => {
    const bound = await bindSelectedIdentityOutputArtifact({
      identityId: 'su', sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: [{ mode: 'auto' }] },
        { contributionId: 'current-assignment', value: { ownerId: 'su-1', intent: 'WI-9', currentPlanSlug: null } },
      ],
      scope,
      observedAt,
    });
    expect(bound.artifact.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'contribution.current-mode-state',
        decision: 'provider:turn', producerRef: 'papercusp.mode-state@1' }),
      expect.objectContaining({ path: 'contribution.current-assignment',
        decision: 'provider:turn', producerRef: 'papercusp.current-assignment@1' }),
      expect.objectContaining({ path: 'contribution.su-practice-text',
        decision: 'fixed:source-change' }),
    ]));
    expect(bound.artifact.inputs).toContainEqual(expect.objectContaining({
      kind: 'prompt-file', ref: 'base:su.practice',
    }));
    await expect(bindSelectedIdentityOutputArtifact({
      identityId: 'su', sourceTier: 'builtin',
      outputs: [{ contributionId: 'current-mode-state', value: [{ mode: 'auto' }] }],
      scope,
      observedAt,
    })).rejects.toThrow(/declared operational input is absent/);
  });

  it('resolves a selected abstract identity recipe with the existing package compiler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-resource-identity-'));
    const id = 'resource-domain';
    const blueprintDir = join(root, '.papercusp', 'blueprints', id);
    const recipeDir = join(root, 'home', 'recipes', 'selected-recipe');
    try {
      mkdirSync(blueprintDir, { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(join(blueprintDir, 'blueprint.yaml'), stringifyYaml({
        id, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        bundles: [{ kind: 'recipe', ref: 'selected-recipe', version: '1.0.0' }],
      }));
      writeFileSync(join(recipeDir, 'recipe.json'), JSON.stringify({
        id: 'selected-recipe', title: 'Selected recipe', script: 'return 1',
      }));
      writeFileSync(join(recipeDir, 'listing.json'), JSON.stringify({ version: '1.0.0' }));
      vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
      const artifact = await compileSelectedIdentityResources({
        identityId: id, repoDir: root, workspaceId: 'ws-test', harnessSlug: 'harness-test',
      });
      expect(artifact?.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'recipe', ref: 'selected-recipe',
      }));
      expect(artifact?.configuration).not.toHaveProperty('workItem');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads one selected mode catalog revision for direct and implied definitions', async () => {
    const catalog = await getSelectedModeCatalog();
    const selected = await getSelectedModeDefinitions(['goal', 'auto', 'goal', 'cold-auto']);
    expect(selected.size).toBe(3);
    for (const modeId of ['goal', 'auto']) {
      const definition = selected.get(modeId)!;
      const entry = catalog.entries.find((candidate) => candidate.id === modeId)!;
      expect(definition.catalogRevision).toBe(catalog.revision);
      expect(definition.sourceRevision).toBe(entry.sourceHash);
      expect(definition.definitionHash).toBe(entry.definitionHash);
      expect(definition.contractRevision).toBe(createHash('sha256').update(definition.contract).digest('hex'));
    }
    expect(selected.get('cold-auto')!.contract).toContain('## COLD AUTO');
    expect(selected.get('cold-auto')!.sourceRevision).toBe(selected.get('auto')!.sourceRevision);
    await expect(getSelectedModeDefinitions(['unknown-mode'])).rejects.toThrow(/no selected fixed definition/);
  });

  it('uses the pinned generated catalog and definitions on a host without source YAML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packaged-mode-catalog-'));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.spyOn(blueprint, 'builtinBlueprintPath').mockImplementation((id) => join(root, 'missing', id, 'blueprint.yaml'));
    try {
      const catalog = await getSelectedModeCatalog();
      expect(catalog.entries).toEqual(BUILTIN_MODE_COMPONENTS.map(({ definitionText: _text, ...entry }) => entry));
      const definitions = await getSelectedModeDefinitions(['auto', 'cold-auto', 'goal']);
      for (const modeId of ['auto', 'goal']) {
        const compiled = BUILTIN_MODE_COMPONENTS.find((entry) => entry.id === modeId)!;
        expect(definitions.get(modeId)).toMatchObject({
          contract: compiled.definitionText, sourceRevision: compiled.sourceHash,
          definitionHash: compiled.definitionHash, catalogRevision: catalog.revision,
        });
      }
      expect(definitions.get('cold-auto')!.contract).toContain('## COLD AUTO');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('WI-10003468: a stale mode-less built-in copy falls back to the compiled entry instead of stranding its implications', async () => {
    // Measured on the Mac rig (P-202 WD-5, 2026-09-27): the current sidecar had no
    // blueprints/ of its own, so builtinBlueprintPath resolved an OLDER installed
    // bundle's su.mode-auto — a pre-P-021 file with no `mode:` block — while
    // su.mode-goal was absent. The catalog then refused 'mode "goal" implies unknown
    // mode "auto"' and every psu launch on that host died at boot.
    const current = parseYaml(readFileSync(builtinBlueprintPath('su.mode-auto'), 'utf8'));
    // Calibration: the real file DOES carry a mode block, so stripping it below is
    // what makes the fixture stale (not an already-mode-less source).
    expect(current.mode?.id).toBe('auto');
    const { mode: _mode, ...stale } = current;
    const root = mkdtempSync(join(tmpdir(), 'stale-mode-catalog-'));
    const staleFile = join(root, 'stale', 'su.mode-auto', 'blueprint.yaml');
    mkdirSync(dirname(staleFile), { recursive: true });
    writeFileSync(staleFile, stringifyYaml(stale));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.spyOn(blueprint, 'builtinBlueprintPath').mockImplementation((id) =>
      id === 'su.mode-auto' ? staleFile : join(root, 'missing', id, 'blueprint.yaml'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const catalog = await getSelectedModeCatalog();
      const ids = catalog.entries.map((entry) => entry.id);
      expect(ids).toContain('auto');
      expect(ids).toContain('goal');
      expect(catalog.entries).toEqual(BUILTIN_MODE_COMPONENTS.map(({ definitionText: _text, ...entry }) => entry));
      expect(warn.mock.calls.some(([line]) => String(line).includes(staleFile))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only exact installed mirrors of a packaged baseline and refuses unmoderated variants', async () => {
    const raw = parseYaml(readFileSync(builtinBlueprintPath('su.mode-auto'), 'utf8'));
    const compiled = BUILTIN_MODE_COMPONENTS.find((entry) => entry.id === 'auto')!;
    const root = mkdtempSync(join(tmpdir(), 'packaged-mode-mirror-'));
    const dir = join(root, 'home', 'blueprints', 'su.mode-auto');
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml(raw));
    writeFileSync(join(dir, 'prompts', 'autonomy.md'), compiled.definitionText);
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.spyOn(blueprint, 'builtinBlueprintPath').mockImplementation((id) => join(root, 'missing', id, 'blueprint.yaml'));
    try {
      expect((await getSelectedModeCatalog()).entries.find((entry) => entry.id === 'auto')!.revision).toBe(compiled.revision);
      expect((await getSelectedModeDefinitions(['auto'])).get('auto')!.contract).toBe(compiled.definitionText);
      writeFileSync(join(dir, 'prompts', 'autonomy.md'), 'Unapproved replacement prompt.');
      await expect(getSelectedModeCatalog()).rejects.toThrow(/no current moderated release approval/);
      writeFileSync(join(dir, 'prompts', 'autonomy.md'), compiled.definitionText);
      writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({ ...raw, mode: { ...raw.mode, title: 'Unapproved mode' } }));
      await expect(getSelectedModeCatalog()).rejects.toThrow(/no current moderated release approval/);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses malformed live builtins instead of hiding them with the packaged baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packaged-mode-invalid-'));
    const dir = join(root, 'source', 'su.mode-auto');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blueprint.yaml'), 'not a source mapping');
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.spyOn(blueprint, 'builtinBlueprintPath').mockImplementation((id) => join(root, 'source', id, 'blueprint.yaml'));
    try {
      await expect(getSelectedModeCatalog()).rejects.toThrow('blueprint source is not a YAML/JSON mapping');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds every catalogued mode state through its declared turn producer and fixed definition', async () => {
    for (const document of SU_MODE_DOCUMENTS) {
      const bound = await bindSelectedIdentityOutputArtifact({
        identityId: document.id,
        sourceTier: 'builtin',
        outputs: [{ contributionId: 'current-mode-state', value: [{ mode: document.modes[0] }] }],
        scope,
        observedAt,
      });
      expect(bound.artifact.provenance, document.id).toContainEqual(expect.objectContaining({
        path: 'contribution.current-mode-state', decision: 'provider:turn',
        producerRef: 'papercusp.mode-state@1',
      }));
      expect(bound.artifact.provenance, document.id).toContainEqual(expect.objectContaining({
        path: `contribution.${document.modes[0]}-definition`, decision: 'fixed:source-change',
      }));
    }
  });

  it('accepts an explicit mode-state omission before a recovery holder is attached', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-kickoff', value: 'GOAL recovery kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope: { workspace: 'ws-test', ownerId: 'su-recovery' },
      observedAt,
    });
    expect(receipt.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'current-mode-state', status: 'omitted:not-requested',
    }));
    expect(receipt).not.toHaveProperty('artifact');
  });

  it('pins the already-rendered turn-start prompt with the fixed SU practice prompt', async () => {
    const block = '## Orientation\n- held: WI-9';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'turn-start-orientation', value: block }],
      scope: { workspace: 'ws-test', ownerId: 'su-1', sink: 'turn-start' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'turn-start-orientation', status: 'bound',
        outputRevision: createHash('sha256').update(block).digest('hex') }),
    ]);
  });

  it('pins the GOAL obligation projection while explicitly omitting other launch-only providers', async () => {
    const text = '- 📌 goal action: place the next plan';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: [{ mode: 'goal', axisKey: 'goal' }] },
        { contributionId: 'goal-kickoff', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-obligations', value: text },
      ],
      scope: { workspace: 'ws-test', ownerId: 'su-1', sink: 'turn-start' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'goal-obligations', status: 'bound',
      outputRevision: createHash('sha256').update(text).digest('hex'),
    }));
  });

  it('pins an existing structured orient result with the fixed SU practice prompt', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'coord-orientation', value: { ok: true, self: { ownerId: 'su-1' } } }],
      scope: { workspace: 'ws-test', ownerId: 'su-1' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'coord-orientation', status: 'bound' }),
    ]);
  });

  it('binds the same source revision selected by the installed mode catalog', async () => {
    const catalog = await getSelectedModeCatalog();
    const goal = catalog.entries.find((entry) => entry.id === 'goal');
    const definition = (await getSelectedModeDefinitions(['goal'])).get('goal');
    expect(goal).toBeDefined();
    expect(definition).toBeDefined();
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });
    expect(receipt.sourceRevision).toBe(goal!.sourceHash);
    expect(receipt.definitionRevision).toBe(definition!.contractRevision);
    expect(receipt.catalogRevision).toBe(catalog.revision);
  });

  it('pins one already-produced kickoff and an explicit absent portfolio with the fixed GOAL definition', async () => {
    const kickoff = 'You are in GOAL mode on goal goal-1';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: kickoff },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });

    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
      expect.objectContaining({
        contributionId: 'goal-kickoff',
        status: 'bound',
        outputRevision: createHash('sha256').update(kickoff).digest('hex'),
      }),
      expect.objectContaining({
        contributionId: 'goal-portfolio', status: 'omitted:not-requested', outputRevision: null,
      }),
    ]);
  });

  it('refuses a provider failure without a traceable error reference', async () => {
    await expect(bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'unavailable' } },
      ],
      scope,
      observedAt,
    })).rejects.toThrow(/unavailable needs errorRef/);
  });
});
