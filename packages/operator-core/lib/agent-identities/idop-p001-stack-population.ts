/** Independent P001 population preparation. A candidate is never a launch receipt. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CensusMode = {
  id: string;
  axis: 'autonomy' | 'overlay';
  slot: string;
  identity: string;
  implies: readonly string[];
  requiresSubject: boolean;
};
export type CensusPosture = 'none' | 'leader' | 'member';
export type FleetModeExclusion = { mode: string; postures: readonly CensusPosture[]; source: string };

/** Enumerate the full axis product, retaining states that need reconciliation or are refused. */
export function enumerateIdopP001Stacks(
  modes: readonly CensusMode[],
  exclusions: readonly FleetModeExclusion[],
) {
  const byId = new Map(modes.map(mode => [mode.id, mode]));
  if (byId.size !== modes.length || modes.some(mode => !mode.id.trim() || !mode.slot.trim() || !mode.identity.trim())) {
    throw new Error('mode population requires unique, nonblank ids, slots and identities');
  }
  for (const mode of modes) {
    if (mode.implies.some(id => !byId.has(id))) throw new Error(`unknown implication in ${mode.id}`);
  }
  for (const exclusion of exclusions) {
    if (!byId.has(exclusion.mode) || !exclusion.source.trim() ||
      exclusion.postures.some(posture => !['none', 'leader', 'member'].includes(posture))) {
      throw new Error('invalid source-backed fleet exclusion');
    }
  }
  const autonomy = modes.filter(mode => mode.axis === 'autonomy').sort((a, b) => a.id.localeCompare(b.id));
  const overlays = modes.filter(mode => mode.axis === 'overlay').sort((a, b) => a.id.localeCompare(b.id));
  if (overlays.length > 16) throw new Error('mode population exceeds explicit enumeration budget');
  if (autonomy.some(mode => mode.slot !== 'autonomy') ||
    new Set(overlays.map(mode => mode.slot)).size !== overlays.length ||
    overlays.some(mode => mode.slot === 'autonomy' || mode.slot === 'fleet-posture')) {
    throw new Error('mode slots disagree with exclusive axes');
  }
  const axis = (mode: CensusMode) => mode.axis === 'autonomy' ? 'autonomy' : `overlay:${mode.id}`;
  const rows = [];
  for (const activeAutonomy of [null, ...autonomy]) {
    for (let mask = 0; mask < 2 ** overlays.length; mask++) {
      const selected = [...(activeAutonomy ? [activeAutonomy] : []),
        ...overlays.filter((_, index) => (mask & (2 ** index)) !== 0)].sort((a, b) => a.id.localeCompare(b.id));
      const occupied = new Set(selected.map(axis));
      const missing = new Set<string>();
      // Same semantics as applyImpliedModes: an occupied autonomy axis satisfies AUTO,
      // including a deliberate COLD AUTO choice. Do not silently collapse their state.
      const queue = selected.flatMap(mode => [...mode.implies]);
      const seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const implied = byId.get(id)!;
        if (!occupied.has(axis(implied))) missing.add(id);
        queue.push(...implied.implies);
      }
      for (const fleetPosture of ['none', 'leader', 'member'] as const) {
        const refusedBy = exclusions.filter(rule => selected.some(mode => mode.id === rule.mode) &&
          rule.postures.includes(fleetPosture)).map(rule => rule.source).sort();
        rows.push({
          key: `su|${selected.map(mode => mode.id).join('+') || 'manual'}|${fleetPosture}`,
          modes: selected.map(mode => mode.id), fleetPosture,
          missingImplications: [...missing].sort(), refusedBy,
          requiredSubjects: selected.filter(mode => mode.requiresSubject).map(mode => mode.id),
          layers: [...selected.map(mode => ({ slot: mode.slot, id: mode.identity })),
            ...(fleetPosture === 'none' ? [] : [{ slot: 'fleet-posture', id: `su.fleet-${fleetPosture}` }])]
            .sort((a, b) => a.slot.localeCompare(b.slot)),
          observation: 'UNOBSERVED' as const,
        });
      }
    }
  }
  return rows;
}

type GeneratedComponent = {
  id: string; slot: string; sourceId: string; implies: string[]; requiresSubject: boolean;
  aliases: Array<{ id: string; implies: string[]; requiresSubject: boolean }>;
};

/** Read the independent registry declaration at the ORIGINAL superproject + submodule pin. */
export function readIdopP001StackSources(root: string, superprojectCommit: string) {
  if (!/^[a-f0-9]{40}$/.test(superprojectCommit)) throw new Error('exact original commit required');
  const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
  });
  const gitlink = git(root, ['ls-tree', superprojectCommit, 'libs/papercusp']).trim().split(/\s+/)[2];
  if (!gitlink || !/^[a-f0-9]{40}$/.test(gitlink)) throw new Error('original submodule pin unavailable');
  const paths = [
    'packages/operator-core/lib/modes/registry.ts',
    'packages/operator-core/lib/modes/store.ts',
    'packages/operator-core/lib/agent-tools/fleet_registry/join.ts',
    'packages/operator-core/lib/agent-tools/fleet_registry/take-leadership-core.ts',
    'libs/papercusp/packages/orchestrator/src/blueprint/mode-catalog.generated.ts',
    'libs/papercusp/packages/orchestrator/src/blueprint/su-stack.ts',
  ];
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const sources = paths.map(path => {
    const nested = path.startsWith('libs/papercusp/');
    const repoPath = nested ? path.slice('libs/papercusp/'.length) : path;
    const repo = nested ? join(root, 'libs/papercusp') : root;
    const commit = nested ? gitlink : superprojectCommit;
    const text = git(repo, ['show', `${commit}:${repoPath}`]);
    return { path, commit, sha256: sha256(text), currentSha256: sha256(readFileSync(join(root, path), 'utf8')), text };
  });
  const catalog = sources.find(source => source.path.endsWith('mode-catalog.generated.ts'))!.text;
  const match = catalog.match(/export const BUILTIN_MODE_COMPONENTS = (\[[\s\S]*\]) as const;/);
  if (!match) throw new Error('original generated mode catalog is not readable');
  const components = JSON.parse(match[1]) as GeneratedComponent[];
  const modes: CensusMode[] = components.flatMap(component => [component, ...component.aliases].map(mode => ({
    id: mode.id, axis: component.slot === 'autonomy' ? 'autonomy' as const : 'overlay' as const,
    slot: component.slot, identity: component.sourceId,
    implies: mode.implies, requiresSubject: mode.requiresSubject,
  })));
  return { superprojectCommit, submoduleCommit: gitlink, modes,
    sources: sources.map(({ text: _text, ...source }) => source) };
}
