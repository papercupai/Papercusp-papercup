/**
 * papercusp.com/cupboard content-brief claim (plan papercusp-com-cupboard-page-2026-10-15,
 * clause SPEC-P-001-brief-live-verbs): every verb decision D-002 presents as AVAILABLE TODAY
 * must exist as a registered agent tool under packages/operator-core/lib/agent-tools.
 *
 * The verb list is a calibrated FIXTURE (fixtures/cupboard-d002-live-verbs.json), a snapshot of
 * D-002's text with its plan version + content hash recorded. The ORACLE is independent of that
 * list: the tool `name:` declarations found by walking the agent-tools tree. A verb the page
 * promises but the product does not register fails here, which is exactly the falsifier
 * ("BROKEN if any verb D-002 presents as available today is absent from
 * packages/operator-core/lib/agent-tools").
 *
 * The control case keeps the detector honest: once the live assertion is green it stops being
 * evidence that the detector can fail at all.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core
const OPERATOR_CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT_TOOLS = join(OPERATOR_CORE, 'lib/agent-tools');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/cupboard-d002-live-verbs.json');

interface BriefFixture {
  source: { plan: string; decision: string; planVersion: number; planContentHash: string };
  live: string[];
  comingSoon: string[];
}

const TOOL_NAME_RE = /\bname:\s*['"]([a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*)['"]/g;

/** Every tool name declared by a non-test source file under the agent-tools tree. */
export function registeredToolNames(root: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        for (const match of readFileSync(full, 'utf8').matchAll(TOOL_NAME_RE)) names.add(match[1]);
      }
    }
  };
  walk(root);
  return names;
}

export function missingVerbs(verbs: readonly string[], registered: ReadonlySet<string>): string[] {
  return verbs.filter((verb) => !registered.has(verb));
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BriefFixture;
const registered = registeredToolNames(AGENT_TOOLS);

describe('cupboard page brief (D-002): verbs presented as live are registered agent tools', () => {
  it('the fixture records its D-002 source and keeps live and coming-soon verbs disjoint', () => {
    expect(fixture.source.plan).toBe('papercusp-com-cupboard-page-2026-10-15');
    expect(fixture.source.decision).toBe('D-002');
    expect(fixture.source.planContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.live.length).toBeGreaterThanOrEqual(21);
    expect(new Set(fixture.live).size).toBe(fixture.live.length);
    expect(fixture.live.filter((verb) => fixture.comingSoon.includes(verb))).toEqual([]);
  });

  it('control: the detector reports a verb the tree does not register', () => {
    expect(registered.size).toBeGreaterThan(100);
    expect(missingVerbs(['cupboard:publish-nonexistent-kind'], registered)).toEqual([
      'cupboard:publish-nonexistent-kind',
    ]);
  });

  it('every verb D-002 presents as available today is declared under lib/agent-tools', () => {
    expect(missingVerbs(fixture.live, registered)).toEqual([]);
  });
});
