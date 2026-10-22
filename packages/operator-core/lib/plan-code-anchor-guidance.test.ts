import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { resolvePromptFiles } from '@papercusp/orchestrator/role-prompt';
import './agent-tools/plans/new';
import './agent-tools/plans/add-item';
import { loadRoleToolsMd, renderToolsCatalog } from './prompt-assembly';

function expectCodeLinks(text: string): void {
  expect(text).toContain('graph:query');
  expect(text).toContain('impact');
  expect(text).toMatch(/symbols it changes/);
  expect(text).toMatch(/anchors.*code links/);
}

describe('plan code links reach the rendered authoring guidance (SPEC-P-002)', () => {
  it.each(['planner', 'scoper', 'architect'])('%s blueprint prompt', (role) => {
    const files = resolvePromptFiles({ harnessDir: harnessRoot(), phase: '', dept: '' }, role);
    expect(files.length).toBeGreaterThan(0);
    expectCodeLinks(files.map((file) => readFileSync(file, 'utf8')).join('\n\n'));
  });

  it.each(['scoper', 'architect'] as const)('%s chat playbook', (role) => {
    const text = loadRoleToolsMd(role);
    expect(text).not.toBeNull();
    expectCodeLinks(text!);
  });

  it.each(['plans:new', 'plans:add-item'])('%s rendered tool guidance', (name) => {
    expectCodeLinks(renderToolsCatalog('scoper', [name]));
  });
});
