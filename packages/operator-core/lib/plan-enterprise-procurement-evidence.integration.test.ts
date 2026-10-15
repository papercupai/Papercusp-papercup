/** Integrates the maintained pack with the code-owned processing population.
 * Does not execute an incident, certify an offering, or accept P-020/P-021.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PILOT_PROCESSING_MAP } from './data-governance/pilot-processing-map';
import { inspectEnterpriseProcurement } from './doc-claims/enterprise-evidence';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pilot = () => readFileSync(resolve(root, 'docs/evidence/enterprise-pilot-contract-draft-2026-10-11.md'), 'utf8');
const inspect = (text: string) => inspectEnterpriseProcurement(text, PILOT_PROCESSING_MAP.map((row) => row.id));
describe('R10 maintained internal pack and declared processing paths', () => {
  it('covers the code-owned population and retains unmeasured recovery/external residue', () => {
    const result = inspect(pilot());
    expect(result.violations).toEqual([]);
    expect(result.unverified).toContain('numeric internal response/recovery targets and measured incident exercise');
    expect(result.unverified).toHaveLength(3);
  });
  it.each(['Threat model and qualification boundaries', 'Internal security questionnaire',
    'Declared-profile processor inventory for review', 'Unsigned DPA working terms and required annexes'])('detects missing component %s', (heading) => {
    expect(inspect(pilot().replace(`### ${heading}`, '### Removed component')).violations)
      .toContainEqual({ code: 'pack-component', subject: heading });
  });
  it('detects a removed processor while other inventory rows remain', () => {
    const changed = pilot().split('\n').filter((line) => !line.startsWith('| model-inference |')).join('\n');
    expect(inspect(changed).violations).toContainEqual({ code: 'processor-population', subject: 'model-inference' });
  });
  it('detects missing evidence ownership and escalation accountability', () => {
    const changed = pilot().replace('Engineering custodian: the enterprise-readiness fleet leader;', '')
      .replace('fleet leader owns engineering escalation', 'fleet observes escalation');
    expect(inspect(changed).violations.map((v) => v.code)).toEqual(expect.arrayContaining(['pack-provenance', 'support-owner']));
  });
  it('detects an affirmative certification appended despite existing A-10 disclaimers', () => {
    expect(inspect(pilot() + '\nWe are SOC 2 certified.').violations.map((v) => v.code)).toContain('unsupported-external-claim');
  });
  it('detects removal of labelled excluded residue', () => {
    const changed = pilot().replaceAll('DPA/subprocessor approval', 'later review');
    expect(inspect(changed).violations).toContainEqual({ code: 'residue-disclosure', subject: 'DPA/subprocessor approval' });
  });
});
