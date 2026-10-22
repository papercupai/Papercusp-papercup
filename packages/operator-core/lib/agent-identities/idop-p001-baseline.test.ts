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
