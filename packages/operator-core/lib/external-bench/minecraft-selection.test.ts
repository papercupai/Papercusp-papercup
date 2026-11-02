import { describe, expect, it } from 'vitest';
import { freezeMinecraftManifest, freezeMinecraftSelection } from './minecraft-protocol';

const digest = (value: number) => value.toString(16).padStart(64, '0');
function manifest() {
  const task = (taskId: string, n: number) => ({ taskId, worldSeed: String(n), objective: 'iron-tools',
    referenceSha256: digest(n * 3), scoringFixtureSha256: digest(n * 3 + 1), exampleSha256: [digest(n * 3 + 2)] });
  return freezeMinecraftManifest({ schemaVersion: 1, revision: 1,
    train: [task('train', 1)], dev: [task('dev', 2)], heldOut: [task('held', 3)] });
}
const selection = { runId: 'first-selection', armId: 'stock', modelId: 'frozen-model',
  promptSha256: digest(20), configurationSha256: digest(21) };

describe('Minecraft first-selection provenance boundary', () => {
  it.each(['content', 'outcome'] as const)('refuses held-out %s with no previously frozen selection', kind => {
    // A different already-frozen selection must not be what rejects this input.
    // Removing the held-out guard must admit it and fail this assertion.
    expect(() => freezeMinecraftSelection(manifest(), { ...selection,
      sources: [{ taskId: 'held', kind }] })).toThrow(/cannot tune/);
  });
  it.each(['train', 'dev'] as const)('admits %s content and outcomes on the first selection', taskId => {
    for (const kind of ['content', 'outcome'] as const) {
      const value = freezeMinecraftSelection(manifest(), { ...selection, sources: [{ taskId, kind }] });
      expect(value.sources).toEqual([{ taskId, kind }]);
      expect(value.selectionHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
