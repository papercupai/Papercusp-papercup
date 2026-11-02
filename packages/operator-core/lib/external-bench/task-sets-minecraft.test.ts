import { describe, expect, it } from 'vitest';
import { MINECRAFT_TASK_SETS } from './minecraft-protocol';
import { isMinecraftTaskSet, loadBenchTaskSet, loadMinecraftTaskSet, writeTaskSampleJsonl } from './task-sets';

describe('Minecraft public benchmark task-set routing', () => {
  it.each(Object.keys(MINECRAFT_TASK_SETS) as Array<keyof typeof MINECRAFT_TASK_SETS>)(
    'routes %s through the existing loader with exactly its frozen public roster', async id => {
      const tasks = await loadBenchTaskSet(id);
      expect(tasks.map(task => task.instanceId)).toEqual(MINECRAFT_TASK_SETS[id]);
      expect(tasks.every(task => task.benchmark === 'minecraft')).toBe(true);
      for (const task of tasks) {
        expect(task.problemStatement).toMatch(/1\.20\.4 survival world on Easy difficulty with cheats disabled/);
        expect(Object.keys(task.graderMeta).sort()).toEqual(['advancement', 'objective', 'taskSetId']);
        expect(task.graderMeta).toMatchObject({ taskSetId: id, objective: task.instanceId });
        expect(task).not.toHaveProperty('repo');
      }
    });
  it('preserves roster order and never silently drops invalid requested tasks', async () => {
    expect((await loadBenchTaskSet('minecraft-pilot', ['nether-entry', 'iron-tools']))
      .map(task => task.instanceId)).toEqual(['iron-tools', 'nether-entry']);
    expect(loadMinecraftTaskSet('minecraft-pilot', ['nether-entry']).map(task => task.instanceId)).toEqual(['nether-entry']);
    for (const ids of [[], ['missing'], ['ender-dragon'], ['iron-tools', 'iron-tools'], ['iron-tools', 'missing']]) {
      await expect(loadBenchTaskSet('minecraft-pilot', ids)).rejects.toThrow(/frozen roster/);
    }
  });
  it('refuses unknown Minecraft sets instead of falling back to the SWE corpus', async () => {
    expect(isMinecraftTaskSet('minecraft-pilot')).toBe(true);
    expect(isMinecraftTaskSet('toString')).toBe(false);
    expect(isMinecraftTaskSet('minecraft-missing')).toBe(false);
    await expect(loadBenchTaskSet('minecraft-missing')).rejects.toThrow(/Unknown Minecraft/);
  });
  it('refuses the offline diff grader path for Minecraft before reading or writing any sample', () => {
    expect(() => writeTaskSampleJsonl('minecraft-pilot', undefined, '/unused')).toThrow(/owned live-server grading/);
  });
});
