import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { blueprintPackageInputs, builtinBlueprintPath, layerContentHash,
  resolveBlueprintSource, resolveBuiltinExtends,
  type ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildBlueprintReleaseArchive, commitBlueprintRelease } from './cupboard/blueprint-release';
import { diffIdentitySpecifications, previewNamedIdentityComposition,
  resolveIdentityStackMutation, saveNamedIdentityComposition } from './identity-management';
import { bindSelectedIdentitySetting, getIdentitySource, getSelectedModeCatalog, listIdentitySources,
  resolveNamedIdentityCompositionSelection } from './agent-identities/source';
import { renderStackTransitionContext, renderStackTransitionContextResult } from './stack-binding-channel';
import { compileLaunchSpecificationArtifact } from './role-launch-spec';
import type { SuLaunchSpecRecord } from './su-persona-render';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..', '..', '..');

function artifact(configuration: Record<string, unknown>, sourceRevision = 'rev-a') {
  return {
    schemaVersion: 1,
    specificationRevision: 'a'.repeat(64),
    compilerVersion: 'test',
    source: { id: 'test', kind: 'harness', contentHash: 'b'.repeat(64) },
    configuration,
    inputs: [],
    provenance: [{ path: 'roles[0].stack[0]', sourceRef: 'identity:test', sourceRevision }],
  } as unknown as ResolvedAgentSpecification;
}

function record(over: Partial<SuLaunchSpecRecord> = {}): SuLaunchSpecRecord {
  return {
    v: 1,
    agent: 'codex',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: 'full',
    model: null,
    planSlug: null,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: null,
    stack: [],
    ...over,
  };
}

describe('identity management service', () => {
  it('launches an attested installed identity at the catalog source revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-launch-selection-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    const id = 'zz-installed-launch-domain';
    try {
      process.env.PAPERCUSP_HOME = root;
      const dir = join(root, 'blueprints', id);
      await mkdir(join(dir, 'prompts'), { recursive: true });
      const identity = { id, extends: 'base', version: '1.0.0',
        slots: [{ slot: 'domain' }] };
      await writeFile(join(dir, 'blueprint.yaml'), stringifyYaml({ ...identity,
        attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' } }));
      await writeFile(join(dir, 'prompts', 'domain.md'), 'INSTALLED SELECTED DOMAIN\n');
      const listed = (await listIdentitySources({ after: 'zy', limit: 100 })).identities
        .find((entry) => entry.id === id);
      expect(listed).toMatchObject({ id, tier: 'installed', version: '1.0.0',
        launchCompatibility: { eligible: true, reason: null } });
      expect(listed?.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: root, role: 'worker',
        stack: [`domain:${id}`], renderStack: true, state: { schemaVersion: 1 },
      });
      expect(launch.promptText).toContain('INSTALLED SELECTED DOMAIN');
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: id, contentHash: listed!.sourceRevision,
      }));
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('previews and atomically saves a named composition in the existing local blueprint library', async () => {
    const root = await mkdtemp(join(tmpdir(), 'named-identity-composition-'));
    const domainId = 'zz-compose-domain';
    const practiceId = 'zz-compose-practice';
    const id = 'zz-named-composition';
    try {
      for (const [componentId, slot] of [[domainId, 'domain'], [practiceId, 'practice']]) {
        const dir = join(root, '.papercusp', 'blueprints', componentId!);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'blueprint.yaml'), stringifyYaml({ id: componentId,
          extends: 'base', version: '1.0.0', slots: [{ slot }] }));
      }
      const input = { id, repoDir: root,
        componentRefs: [`domain:${domainId}`, `practice:${practiceId}`] };
      const preview = await previewNamedIdentityComposition(input);
      expect(preview.components.map((component) => component.ref)).toEqual(input.componentRefs);
      expect(preview.components.map((component) => component.tier)).toEqual(['local', 'local']);
      expect(preview.preview.launchCompatibility).toMatchObject({ eligible: true });
      expect(preview.preview.layers.map((layer) => layer.id)).toContain(domainId);
      const saved = await saveNamedIdentityComposition(input);
      expect(saved.ok).toBe(true);
      const yaml = await readFile(join(root, '.papercusp', 'blueprints', id, 'blueprint.yaml'), 'utf8');
      expect(parseYaml(yaml)).toMatchObject({ id, extends: [domainId, practiceId], slots: [],
        roles: [{ id: 'su', stack: input.componentRefs }] });
      expect((await getIdentitySource(id, { repoDir: root })).ok).toBe(true);
      expect((await listIdentitySources({ repoDir: root, after: 'zy', limit: 10 })).identities)
        .toContainEqual(expect.objectContaining({ id, launchCompatibility: {
          eligible: true, reason: null,
        } }));
      const selected = await resolveNamedIdentityCompositionSelection(id, root);
      expect(selected.stack).toEqual(input.componentRefs);
      const listed = (await listIdentitySources({ repoDir: root, after: 'zy', limit: 10 })).identities
        .find((entry) => entry.id === id);
      expect(listed?.sourceRevision).toBe(selected.sourceRevision);
      await writeFile(join(root, '.papercusp', 'blueprints', domainId, 'blueprint.yaml'),
        stringifyYaml({ id: domainId, extends: 'base', version: '1.0.1', slots: [{ slot: 'domain' }] }));
      expect((await resolveNamedIdentityCompositionSelection(id, root)).sourceRevision)
        .not.toBe(selected.sourceRevision);
      const providerDir = join(root, '.papercusp', 'blueprints', 'zz-provider-parent');
      const providerChildDir = join(root, '.papercusp', 'blueprints', 'zz-provider-child');
      await mkdir(providerDir, { recursive: true });
      await mkdir(providerChildDir, { recursive: true });
      await writeFile(join(providerDir, 'blueprint.yaml'), stringifyYaml({
        id: 'zz-provider-parent', extends: 'base', version: '1.0.0',
        slots: [{ slot: 'domain' }], contributions: [{ id: 'current-brief',
          purpose: 'operational', source: 'provider', refresh: 'launch', inputKind: 'setting',
          ref: 'current-brief', producerRef: 'papercusp.fleet-leader-brief@1', verb: 'read' }],
      }));
      await writeFile(join(providerChildDir, 'blueprint.yaml'), stringifyYaml({
        id: 'zz-provider-child', extends: 'zz-provider-parent', version: '1.0.0', slots: [],
      }));
      const withProvider = await listIdentitySources({ repoDir: root, after: 'zy', limit: 20 });
      expect(withProvider.identities.find((entry) => entry.id === 'zz-provider-parent')?.launchCompatibility)
        .toMatchObject({ eligible: false, reason: expect.stringContaining('producer binding') });
      expect(withProvider.identities.find((entry) => entry.id === 'zz-provider-child')?.launchCompatibility)
        .toMatchObject({ eligible: false, reason: expect.stringContaining('launch selection') });
      await expect(saveNamedIdentityComposition(input)).rejects.toThrow(/already exists/);
      await expect(previewNamedIdentityComposition({ ...input, id: 'zz-bad-composition',
        componentRefs: [`practice:${domainId}`] })).rejects.toThrow(/does not declare/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('pins an already-produced structured fleet brief without changing its value or prompt sink', async () => {
    const data = { ok: true, summary: { fleet: 'alpha', members: 2 } };
    const before = JSON.stringify(data);
    const bound = await bindSelectedIdentitySetting({
      identityId: 'su.fleet-leader', contributionId: 'fleet-leader-brief', sourceTier: 'builtin', value: data,
      scope: { fleet: 'alpha' }, observedAt: '2026-09-24T00:00:00.000Z',
    });
    expect(JSON.stringify(data)).toBe(before);
    expect(bound).toMatchObject({ identityId: 'su.fleet-leader', contributionId: 'fleet-leader-brief',
      producerRef: 'papercusp.fleet-leader-brief@1', status: 'bound',
      scope: { fleet: 'alpha' } });
    expect(bound.outputRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(bound.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    const omitted = await bindSelectedIdentitySetting({
      identityId: 'su.fleet-leader', contributionId: 'fleet-leader-brief', sourceTier: 'builtin',
      omission: { reason: 'ineligible' }, scope: { fleet: null }, observedAt: '2026-09-24T00:00:00.000Z',
    });
    expect(omitted).toMatchObject({ status: 'omitted:ineligible', outputRevision: null });
    expect(omitted.specificationRevision).not.toBe(bound.specificationRevision);
  });

  it('selects exactly one approved installed mode revision over its built-in definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-mode-selection-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = root;
      const baseline = await getSelectedModeCatalog();
      const oldAuto = baseline.entries.find((entry) => entry.id === 'auto')!;
      const id = 'su.mode-auto-custom';
      const sourceDir = join(root, 'source');
      await cp(dirname(builtinBlueprintPath('su.mode-auto')), sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'blueprint.yaml');
      const raw = parseYaml(await readFile(sourceFile, 'utf8')) as Record<string, unknown>;
      raw.id = id;
      raw.mode = { ...(raw.mode as Record<string, unknown>), title: 'AUTO approved variant',
        replacesRevision: oldAuto.revision };
      await writeFile(sourceFile, stringifyYaml(raw));
      await writeFile(join(sourceDir, 'prompts', 'autonomy.md'),
        '## AUTO selected installed variant\n\nThis approved content is delivered on activation.\n');
      const resolved = resolveBlueprintSource(raw, {
        sourcePath: sourceFile, resolve: resolveBuiltinExtends,
        lint: { approvedModePolicyRefs: ['auto'] },
      });
      expect(resolved.validation.ok).toBe(true);
      const pins = blueprintPackageInputs(resolved, []);
      const hash = buildBlueprintReleaseArchive(pins, id).package.rootHash;
      await commitBlueprintRelease({
        installedDir: join(root, 'blueprints'), sourceDir, id, version: '1.0.0',
        source: 'https://github.com/acme/mode', pins,
        modeApproval: { listingId: 'approved-listing', policyRef: 'auto', approvedArtifactContentHash: hash },
      });
      const selected = await getSelectedModeCatalog();
      expect(selected.entries).toHaveLength(baseline.entries.length);
      expect(selected.entries.find((entry) => entry.id === 'auto')).toMatchObject({
        sourceId: id, title: 'AUTO approved variant',
      });
      expect(selected.revision).not.toBe(baseline.revision);
      const injected = await renderStackTransitionContext({
        state: { stack: [`autonomy:${id}`] } as never,
        stackBefore: [],
      });
      expect(injected).toContain('AUTO selected installed variant');
      expect(await getSelectedModeCatalog()).toBe(selected);
      await appendFile(join(root, 'blueprints', id, 'prompts', 'autonomy.md'), '\nchanged after approval\n');
      await expect(getSelectedModeCatalog()).rejects.toThrow(/no current moderated release approval/);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves a moderated installed mode only while its current full closure matches the receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'installed-mode-approval-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = root;
      const id = 'su.mode-auto';
      const sourceDir = join(root, 'source');
      await cp(dirname(builtinBlueprintPath(id)), sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'blueprint.yaml');
      const raw = parseYaml(await readFile(sourceFile, 'utf8'));
      const resolved = resolveBlueprintSource(raw, {
        sourcePath: sourceFile, resolve: resolveBuiltinExtends,
        lint: { approvedModePolicyRefs: ['auto'] },
      });
      expect(resolved.validation.ok).toBe(true);
      const pins = blueprintPackageInputs(resolved, []);
      const hash = buildBlueprintReleaseArchive(pins, id).package.rootHash;
      await commitBlueprintRelease({
        installedDir: join(root, 'blueprints'), sourceDir, id, version: '1.0.0',
        source: 'https://github.com/acme/mode', pins,
        modeApproval: { listingId: 'approved-listing', policyRef: 'auto', approvedArtifactContentHash: hash },
      });
      expect((await getIdentitySource(id)).ok).toBe(true);
      await appendFile(join(root, 'blueprints', id, 'prompts', 'autonomy.md'), '\nchanged after approval\n');
      expect(await getIdentitySource(id)).toMatchObject({ ok: false, error: 'mode-approval-stale' });
      const warned: string[] = [];
      const transition = await renderStackTransitionContextResult({
        state: { stack: [`autonomy:${id}`] } as never, stackBefore: [],
      }, { warn: (message) => warned.push(message) });
      expect(transition).toMatchObject({ text: '', rendered: false });
      expect(warned[0]).toContain('no current moderated release approval');
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the installed-source attestation diagnostic instead of returning an empty preview error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-preview-diagnostic-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    const identityId = 'zz-preview-unattested';
    try {
      process.env.PAPERCUSP_HOME = root;
      const dir = join(root, 'blueprints', identityId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'blueprint.yaml'), `id: ${identityId}\nslots:\n  - slot: domain\n`);
      const source = await getIdentitySource(identityId);
      expect(source).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: 'attestation-missing' })],
      });
      const catalog = await listIdentitySources({ after: 'zy', limit: 10 });
      expect(catalog.identities.some((entry) => entry.id === identityId)).toBe(false);
      expect(catalog.unreadable).toContainEqual(expect.objectContaining({
        id: identityId, error: expect.stringContaining('attestation-missing'),
      }));
      await expect(resolveIdentityStackMutation({
        workspaceId: 'papercusp-workspace', ownerId: 'su-test', action: 'preview',
        identityId, slot: 'domain', operatorBaseUrl: 'http://127.0.0.1:3170', modeSection: '',
      }, record(), null)).rejects.toThrow(/attestation-missing:.*no publisher attestation/);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the simple not-found error when no identity source resolves', async () => {
    await expect(resolveIdentityStackMutation({
      workspaceId: 'papercusp-workspace', ownerId: 'su-test', action: 'preview',
      identityId: 'zz-no-such-preview-identity', slot: 'domain',
      operatorBaseUrl: 'http://127.0.0.1:3170', modeSection: '',
    }, record(), null)).rejects.toThrow('identity-not-found');
  });

  it('projects authoritative slot cardinality for the UI instead of making the client restate the registry', async () => {
    const catalog = await listIdentitySources({ repoDir, limit: 100 });
    const engineer = catalog.identities.find((identity) => identity.id === 'papercusp-engineer');

    expect(engineer?.slots).toContainEqual({ slot: 'domain', cardinality: 'exclusive' });
  });

  it('diffs effective configuration without shipping prompt bytes to the table', () => {
    const rows = diffIdentitySpecifications(
      artifact({ roles: [{ id: 'su', stack: [] }] }),
      artifact({ roles: [{ id: 'su', stack: ['domain:research-steward'] }] }, 'rev-b'),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        field: 'configuration.roles[0].stack[0]',
        applied: null,
        selected: 'domain:research-steward',
        origin: null,
      }),
    );
  });

  it('a real alternative domain switch is fresh-context and replaces the exclusive holder', async () => {
    const result = await resolveIdentityStackMutation(
      {
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        action: 'switch',
        identityId: 'research-steward',
        slot: 'domain',
        operatorBaseUrl: 'http://127.0.0.1:3070',
        modeSection: '',
      },
      record({ stack: ['domain:papercusp-engineer'] }),
      repoDir,
    );
    expect(result).toMatchObject({
      changed: true,
      delivery: 'relaunch-with-carry',
      replaced: 'papercusp-engineer',
      stack: ['domain:research-steward'],
    });
  });

  it('rollback selects the bounded prior launch receipt, not a new store', async () => {
    const result = await resolveIdentityStackMutation(
      {
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        action: 'rollback',
        operatorBaseUrl: 'http://127.0.0.1:3070',
        modeSection: '',
      },
      record({
        stack: ['domain:research-steward'],
        identityHistory: [
          {
            stack: ['domain:papercusp-engineer'],
            specificationRevision: 'c'.repeat(64),
            stateRevision: 'old-state',
            specificationArtifact: artifact({}),
            recordedAt: '2026-09-09T00:00:00.000Z',
          },
        ],
      }),
      repoDir,
    );
    expect(result.stack).toEqual(['domain:papercusp-engineer']);
    expect(result.delivery).toBe('relaunch-with-carry');
  });
});
