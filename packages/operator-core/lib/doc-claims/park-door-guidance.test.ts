/**
 * consult-backed-parking-2026-10-12 R-8 (P-008, WI-6554700010009496): the guidance for
 * (1) work_items:set_blocker, (2) coord:ask-owner, (3) consult:get_feedback and (4) the su
 * blocker section of the project guide must each steer a reversible judgment call to the
 * product-decision park door, naming the door, its required default and its deadline.
 *
 * Calibration first: the judge must pass on the LIVE registered tool prose and the projected
 * CLAUDE.md. Then one mutated control per surface proves a regression on that surface is caught,
 * so a green run here is not a judge that passes everything.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import '../agent-tools/work_items/set_blocker';
import '../agent-tools/consult/get-feedback';
import '../coord-ops/agent-tools';
import {
  judgeParkDoorGuidance,
  markdownSection,
  PARK_DOOR_SURFACES,
  type ParkDoorSurface,
} from './park-door-guidance';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BLOCKER_SECTION = 'A blocker is work, not a stop sign';

function toolProse(name: string): string {
  const tool = lookupByMcpName(name);
  expect(tool, `${name} not registered`).toBeDefined();
  const g = tool!.guidance ?? {};
  return [tool!.description ?? '', g.when ?? '', g.notWhen ?? '', g.chaining ?? ''].join('\n');
}

function liveSurfaces(): Record<ParkDoorSurface, string> {
  const guide = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  return {
    'work_items:set_blocker': toolProse('work_items:set_blocker'),
    'coord:ask-owner': toolProse('coord:ask-owner'),
    'consult:get_feedback': toolProse('consult:get_feedback'),
    'su-blocker-section': markdownSection(guide, BLOCKER_SECTION),
  };
}

/** Removes every mention of the door from one surface: what a regression on that surface looks like. */
function stripDoor(prose: string): string {
  return prose
    .replace(/product-decision/g, 'owner-question')
    .replace(/defaultIfUnanswered/g, 'note')
    .replace(/decideBy|deadline/g, 'later');
}

describe('R-8 park-door guidance doc-claim', () => {
  it('the live guidance of every surface names the park door, its default and its deadline (calibration)', () => {
    const verdict = judgeParkDoorGuidance(liveSurfaces());
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('reads the su blocker section from the projected guide, not an empty string', () => {
    const section = liveSurfaces()['su-blocker-section'];
    expect(section).toContain('resolve-don\'t-relay');
    expect(section).toContain('work_items:set_blocker');
  });

  it.each(PARK_DOOR_SURFACES.map((surface, index) => [index + 1, surface] as const))(
    'CONTROL (%i): a %s that no longer names the park door is caught',
    (number, surface) => {
      const surfaces = liveSurfaces();
      surfaces[surface] = stripDoor(surfaces[surface]);
      const verdict = judgeParkDoorGuidance(surfaces);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.length).toBeGreaterThan(0);
      expect(verdict.violations.every((v) => v.startsWith(`(${number}) ${surface}:`))).toBe(true);
    },
  );

  it('CONTROL: a surface that names the door but drops the required default is caught', () => {
    const surfaces = liveSurfaces();
    surfaces['coord:ask-owner'] = surfaces['coord:ask-owner'].replace(/defaultIfUnanswered/g, 'a default');
    const verdict = judgeParkDoorGuidance(surfaces);
    expect(verdict.violations).toEqual([
      expect.stringMatching(/^\(2\) coord:ask-owner: does not name the park door's defaultArg/),
    ]);
  });

  it('CONTROL: a missing surface is reported, not skipped', () => {
    const surfaces: Partial<Record<ParkDoorSurface, string>> = liveSurfaces();
    delete surfaces['su-blocker-section'];
    expect(judgeParkDoorGuidance(surfaces).violations).toEqual(['(4) su-blocker-section: surface text is missing']);
  });
});
