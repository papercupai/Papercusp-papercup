import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCensusRoot, SU_RENDER_PARITY_BASELINE } from './identity-surface-census';
import { IDOP_P001_BASELINE_REL, IDOP_P001_PROMPT_REL, inspectIdopP001Coverage } from './idop-p001-baseline';

type Baseline = {
  schemaVersion: number;
  base: { commit: string; promptPath: string; promptGitBlob: string; promptSha256: string; promptBytes: number };
  population: { roles: Array<{ id: string }>; roleCount: number; builtInIdentities: Array<{ id: string }>; builtInIdentityCount: number };
  toolCatalog: { sourceKind: string; count: number; digest: string; tools: Array<{ name: string; schema: unknown; schemaSha256: string }> };
  observations: Array<{ identity: string; ownerId: string; observedAt: string; status: 'observed' | 'tool-refused' | 'launch-refused'; toolInvocationId?: number; activationEventId?: number; refusal?: string }>;
  overrideChannels: string[];
  vault: { baseline: Record<string, string>; evidence: string[]; supersededBy: string };
  answers: Record<string, string>;
  knownDefect: string;
};

const root = defaultCensusRoot();
const baseline = JSON.parse(readFileSync(join(root, IDOP_P001_BASELINE_REL), 'utf8')) as Baseline;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('IDOP P-001 frozen baseline', () => {
  it('pins the exact pre-implementation su render to a reachable commit and blob', () => {
    const historical = execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${baseline.base.promptPath}`]);
    expect(baseline.base.promptPath).toBe(IDOP_P001_PROMPT_REL);
    expect(execFileSync('git', ['-C', root, 'rev-parse', `${baseline.base.commit}:${baseline.base.promptPath}`], { encoding: 'utf8' }).trim()).toBe(baseline.base.promptGitBlob);
    expect(historical).toHaveLength(baseline.base.promptBytes);
    expect(sha256(historical)).toBe(baseline.base.promptSha256);
    expect(SU_RENDER_PARITY_BASELINE).toContain(IDOP_P001_BASELINE_REL);
  });

  it('has independent count controls for every built-in identity and harness role', () => {
    expect(baseline.population.roles.map((row) => row.id).sort()).toEqual(['infra-reviewer', 'security-reviewer']);
    expect(baseline.population.roleCount).toBe(baseline.population.roles.length);
    expect(baseline.population.builtInIdentityCount).toBe(baseline.population.builtInIdentities.length);
    expect(baseline.population.builtInIdentityCount).toBe(29);
    expect(new Set(baseline.population.builtInIdentities.map((row) => row.id)).size).toBe(29);
  });

  it('freezes every launched tool argument schema, not only tool names', () => {
    expect(baseline.toolCatalog.sourceKind).toBe('real-launched-codex-managed-tool-prompts');
    expect(baseline.toolCatalog.count).toBe(baseline.toolCatalog.tools.length);
    expect(baseline.toolCatalog.count).toBeGreaterThan(1_000);
    for (const tool of baseline.toolCatalog.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(tool.schemaSha256).toBe(sha256(JSON.stringify(tool.schema)));
    }
  });

  it('retains session/timestamp evidence or an explicit measured refusal for the stored samples', () => {
    expect(baseline.observations.length).toBeGreaterThanOrEqual(20);
    for (const row of baseline.observations) {
      expect(row.identity).toBeTruthy();
      expect(row.observedAt).toMatch(/^2026-10-22T/);
      if (row.status === 'observed') expect(row.ownerId).toMatch(/^su-/);
      else expect(row.refusal).toBeTruthy();
    }
    expect(baseline.observations.some((row) => row.status === 'launch-refused')).toBe(true);
    expect(baseline.knownDefect).toBe('EI-26700090355079325');
  });

  it('rejects the incomplete frozen samples as population-wide tool evidence', () => {
    const coverage = inspectIdopP001Coverage(baseline);
    expect(coverage.complete).toBe(false);
    expect(coverage.missing).toEqual(expect.arrayContaining([
      'role:infra-reviewer', 'role:security-reviewer', 'identity:su',
      'identity:su.mode-auto', 'identity:su.mode-audit', 'identity:su.mode-ideate',
    ]));
    expect(coverage.invalid).toContain('identity:su.mode-auto');
  });

  it('binds the supplemental role catalogs to real launches and complete argument-schema receipts', () => {
    const receipt = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-role-tool-receipts-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        role: string; advSessionId: number; ownerId: string; nativeSessionId: string;
        sourceKind: string; sourceHome: string; nativeTranscript: string;
        launchAt: string; capturedAt: string; count: number; promptFileCount: number;
        catalogSha256: string; sourceFiles: Array<{ name: string; sha256: string }>;
      }>;
      catalogs: Record<string, Array<{ name: string; schema: unknown; schemaSha256: string }>>;
    };
    expect(receipt.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(receipt.receipts.map(row => row.role).sort()).toEqual(
      baseline.population.roles.map(row => row.id).sort());
    for (const row of receipt.receipts) {
      expect(row.sourceKind).toBe('real-launched-codex-role-managed-tool-prompts');
      expect(row.advSessionId).toBeGreaterThan(0);
      expect(row.ownerId).toMatch(/^su-/);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(Date.parse(row.launchAt)).toBeLessThanOrEqual(Date.parse(row.capturedAt));
      const tools = receipt.catalogs[row.catalogSha256];
      expect(tools).toBeDefined();
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(row.promptFileCount).toBe(row.count);
      expect(row.sourceFiles).toHaveLength(row.count);
      expect(new Set(row.sourceFiles.map(file => file.name)).size).toBe(row.count);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      for (const file of row.sourceFiles) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      for (const tool of tools) {
        expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
        expect(sha256(JSON.stringify(tool.schema))).toBe(tool.schemaSha256);
      }
      // The real role gate refused introspection; the launch catalog agrees.
      expect(tools.some(tool => tool.name === 'agent_tools:list')).toBe(false);
    }
  });

  it('requires exact population equality, even when duplicate observations meet a count floor', () => {
    const observed = { identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
      status: 'observed' as const, toolInvocationId: 1 };
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'two' }] },
      observations: Array.from({ length: 30 }, () => ({ ...observed })) };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:two'] });
    input.observations.push({ ...observed, identity: 'two', toolInvocationId: 2 });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: true, missing: [], invalid: [] });
    input.population.builtInIdentities.push({ id: 'three' });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:three'] });
  });

  it('resolves each captured launch tool to its exact schema without assuming selected modes were worn', () => {
    const manifest = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-launch-tool-catalogs-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        identity: string; advSessionId: number; nativeSessionId: string; sourceHome: string; nativeTranscript: string;
        count: number; catalogSha256: string; specificationRevision: string;
        specificationInputRefs: string[]; selectedIdentityInSpecification: boolean; wornLayerLimitation?: string;
      }>;
      catalogs: Record<string, Array<{ name: string; schemaSha256: string }>>;
      extraSchemas: Record<string, unknown>;
    };
    expect(manifest.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    const schemas = new Map(baseline.toolCatalog.tools.map(tool => [tool.schemaSha256, tool.schema]));
    for (const [hash, schema] of Object.entries(manifest.extraSchemas)) {
      expect(sha256(JSON.stringify(schema))).toBe(hash);
      schemas.set(hash, schema);
    }
    const audience = manifest.receipts.find(row => row.advSessionId === 49611)!;
    expect(audience.specificationInputRefs).toEqual(expect.arrayContaining([
      'papercusp-engineer', 'su-collaborator', 'papercup.audience-engineer',
    ]));
    for (const row of manifest.receipts) {
      const tools = manifest.catalogs[row.catalogSha256];
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(row.specificationRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(row.selectedIdentityInSpecification).toBe(row.specificationInputRefs.includes(row.identity));
      if (!row.selectedIdentityInSpecification) expect(row.wornLayerLimitation).toBeTruthy();
      for (const tool of tools) {
        const schema = schemas.get(tool.schemaSha256);
        expect(schema).toBeDefined();
        expect(sha256(JSON.stringify(schema))).toBe(tool.schemaSha256);
      }
    }
  });

  it('rejects duplicate population members, unknown identities and receipt-free assertions', () => {
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'one' }] },
      observations: [{ identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
        status: 'observed' as const, toolInvocationId: 1 }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, duplicatePopulation: ['identity:one'] });
    input.population.builtInIdentities.pop();
    input.observations[0].toolInvocationId = 0;
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:one'] });
    input.observations[0] = { ...input.observations[0], identity: 'unknown', toolInvocationId: 1 };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:unknown'] });
  });

  it('keeps authentic access refusals explicit without treating them as complete tool-set evidence', () => {
    const input = { population: { roles: [{ id: 'reviewer' }], builtInIdentities: [] },
      observations: [{ identity: 'reviewer', ownerId: 'su-reviewer', observedAt: '2026-10-22T16:00:00Z',
        status: 'tool-refused' as const, toolInvocationId: 1, refusal: 'role_not_allowed' }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({
      complete: false, checked: [], refused: ['role:reviewer'], missing: [], invalid: [],
    });
    expect(inspectIdopP001Coverage({ ...input, observations: [{ ...input.observations[0],
      status: 'launch-refused', toolInvocationId: undefined }] })).toMatchObject({
      complete: false, refused: [], invalid: ['role:reviewer'],
    });
  });

  it('binds follow-up evidence to the unchanged frozen artifact and preserves unresolved coverage', () => {
    const audit = JSON.parse(readFileSync(join(root, 'docs/evidence/idop-p001-coverage-audit-2026-10-22.json'), 'utf8'));
    expect(audit.baseline.sha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(audit.modeAutoCatalogMapping.sourceHome).toBe(
      `~/.papercusp/su-codex-homes/session-${audit.modeAutoCatalogMapping.advSessionId}`);
    for (const artifact of [audit.launchToolCatalogs, audit.roleLaunchCatalogs, audit.currentLeaderToolReceipt]) {
      expect(sha256(readFileSync(join(root, artifact.path)))).toBe(artifact.sha256);
    }
    const leader = JSON.parse(readFileSync(join(root, audit.currentLeaderToolReceipt.path), 'utf8'));
    expect(leader.sourceReceipt.path).toMatch(/^~\/\.papercusp\/scratch\//);
    expect(audit.ready).toBe(false);
    const unresolved = audit.unresolved.map((row: { identity: string }) => row.identity) as string[];
    const resolved = audit.resolvedWornToolMappings as Array<{
      identity: string; activationEventId: number; catalogSource: string;
    }>;
    expect(unresolved.length).toBeGreaterThan(0);
    expect([...unresolved, ...resolved.map(row => row.identity)].sort()).toEqual([
      'su', 'su.practice', 'su.mode-auto', 'su.mode-audit', 'su.mode-ideate', 'su.fleet-leader', 'su.fleet-member',
    ].sort());
    const applied = [...audit.appliedLayerReceipts, leader.appliedActivation] as Array<{
      id: string; phase: string; stack_refs: string[];
    }>;
    for (const mapping of resolved) {
      expect(audit[mapping.catalogSource]).toBeDefined();
      const activation = applied.find(row => Number(row.id) === mapping.activationEventId);
      expect(activation?.phase).toBe('applied');
      expect(activation?.stack_refs.map(ref => ref.slice(ref.indexOf(':') + 1))).toContain(mapping.identity);
    }
    const coverage = inspectIdopP001Coverage({ ...baseline,
      observations: [...baseline.observations, ...audit.roleObservations] });
    expect(coverage.complete).toBe(false);
    expect(coverage.refused).toEqual(expect.arrayContaining(['role:infra-reviewer', 'role:security-reviewer']));
  });

  it('pins all four vault settings, override channels and design answers', () => {
    expect(Object.keys(baseline.vault.baseline).sort()).toEqual(['afterReadHolds', 'automaticRecall', 'grantTerms', 'transcriptVisibility']);
    expect(baseline.vault.supersededBy).toContain('#D-020');
    expect(baseline.overrideChannels).toEqual(expect.arrayContaining(['?superuser=1 legacy query parameter', 'principal.kind / authenticated principal']));
    expect(Object.keys(baseline.answers).sort()).toEqual([
      'baseKnobsAndParams', 'consentAndProviderCapacity', 'directoryGroups', 'governanceSeesWornIdentity',
      'installConsent', 'p016AndP019', 'secrets',
    ]);
  });
});
