import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it } from 'vitest';
import { assertPublicManualSource } from '../scripts/source-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8');

describe('public first-task journey (DOCS-FIRST-TASK)', () => {
  it('records the executing docs project as a unit test layer', () => {
    expect(inject('papercuspTestLayer')).toBe('unit');
  });

  it('has a navigable route from the manual to a bounded, approved task and an inspectable result', () => {
    expect(assertPublicManualSource(root).guides).toBeGreaterThanOrEqual(15);
    const home = read('src/content/docs/index.mdx');
    const quickstart = read('src/content/docs/quickstart.mdx');
    expect(home).toContain('](/docs/quickstart)');
    const headings = [...quickstart.matchAll(/^## \d\. (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Create an account or sign in', 'Connect a place for the work to run', 'Select a project and start a session', 'Approve the intended work', 'Check the result before calling it finished']);
    expect(quickstart).toContain('Show me the plan before editing');
    expect(quickstart).toContain('Implement this plan yourself in this session');
    expect(quickstart).toContain("open the project's README");
    expect(quickstart).toContain('reported link');
    expect(quickstart).toContain('If the first task gets stuck');
    expect(quickstart).toContain('](/docs/troubleshooting)');
  });

  it('keeps hosting, cost and destructive-action boundaries beside the first connection action', () => {
    const quickstart = read('src/content/docs/quickstart.mdx');
    const connection = quickstart.split('## 2.')[1].split('## 3.')[0];
    expect(connection).toContain("Use Papercusp's cloud");
    expect(connection).toContain('Bring your own cloud');
    expect(connection).toContain('Local work');
    expect(connection).toContain('not proof that its host is ready');
    expect(connection).toContain('charges are separate');
    expect(connection).toContain('backup and restore plan');
    expect(quickstart).toContain('desktop app');
    expect(quickstart).toContain('closing\nthe browser tab alone does not stop remote work');
  });

  it('groups existing URLs by reader task while keeping advanced setup available', () => {
    const config = read('astro.config.mjs');
    for (const label of ['Start here', 'Everyday tasks', 'Cloud and costs', 'Privacy and recovery', 'Advanced setup', 'Common questions and help']) {
      expect(config).toContain(`label: '${label}'`);
    }
    expect(config).toContain("items: ['quickstart', 'using-the-app', 'workspaces-and-agents']");
    expect(config).toContain('pagefind: true');
  });
});
