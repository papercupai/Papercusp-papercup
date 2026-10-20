/**
 * R-20 (plan-verification-profiles-2026-10-17 P-008): the published verification-profiles guide
 * lists exactly the modules, profile defaults and deliverable mappings the resolver returns.
 *
 * Same doc-claims family as design-evidence-doc-claims.test.ts. The live case reads the
 * projected page; the CONTROLS feed the judge a page diverged in each way that matters (a
 * module renamed, a check dropped, an extra module, a wrong profile default, a deliverable
 * left out, a table removed) and require a NO; the CALIBRATION feeds it a page rendered from
 * the resolver and requires a YES, so a judge broken to fail everything cannot pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELIVERABLE_TABLE_HEADER,
  MODULE_TABLE_HEADER,
  PROFILE_TABLE_HEADER,
  judgeVerificationProfilesDoc,
  liveVerificationProfileFacts,
  readMarkdownTable,
  type VerificationProfileFacts,
} from './verification-profiles-doc';
import { VERIFICATION_MODULES } from '../plan-verification-profile';

// lib/doc-claims -> lib -> operator-core -> packages -> <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(ROOT, 'apps/operator-docs/src/content/docs/agent-insights/plan-verification-profiles.mdx');

const q = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(', ');
const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
const sep = (n: number) => `|${' --- |'.repeat(n)}`;

/** A page rendered straight from the facts: what a correct guide's tables look like. */
function renderFromFacts(facts: VerificationProfileFacts): string {
  return [
    '# Verification profiles',
    '',
    row(MODULE_TABLE_HEADER), sep(2),
    ...[...facts.moduleChecks].map(([m, checks]) => row([`\`${m}\``, q(checks)])),
    '',
    'Some prose between tables.',
    '',
    row(PROFILE_TABLE_HEADER), sep(3),
    ...[...facts.profileDefaults].map(([p, d]) => row([`\`${p}\``, `\`${d.deliverable}\``, q(d.modules)])),
    '',
    row(DELIVERABLE_TABLE_HEADER), sep(2),
    ...[...facts.deliverableModules].map(([k, ms]) => row([`\`${k}\``, q(ms)])),
    '',
  ].join('\n');
}

describe('R-20: the verification-profiles guide matches the resolver', () => {
  const facts = liveVerificationProfileFacts();

  it('the published guide lists the same modules, profile defaults and deliverable mappings the resolver returns', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(judgeVerificationProfilesDoc(doc, facts)).toEqual([]);
  });

  it('the facts come from the resolver: every module, and generic-core first in every module list', () => {
    expect([...facts.moduleChecks.keys()]).toEqual([...VERIFICATION_MODULES]);
    for (const { modules } of facts.profileDefaults.values()) expect(modules[0]).toBe('generic-core');
    for (const modules of facts.deliverableModules.values()) expect(modules[0]).toBe('generic-core');
    expect(facts.deliverableModules.get('code')).toContain('code');
    expect(facts.deliverableModules.get('doc')).not.toContain('code');
  });

  it('calibration: a page rendered from the resolver is judged in sync', () => {
    const page = renderFromFacts(facts);
    expect(readMarkdownTable(page, MODULE_TABLE_HEADER)).toHaveLength(facts.moduleChecks.size);
    expect(judgeVerificationProfilesDoc(page, facts)).toEqual([]);
  });

  describe('controls: a diverged module list is caught', () => {
    const good = renderFromFacts(facts);

    it('a check dropped from a module', () => {
      const page = good.replace(', `blind-review`', '');
      expect(page).not.toBe(good);
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/module 'generic-core' documents checks/);
    });

    it('a module the resolver does not have', () => {
      const page = good.replace('| `packaged-artifact` |', '| `packaged-artifact` | `packaged-artifact` |\n| `release-signing` |');
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/lists 'release-signing', which the resolver does not have/);
    });

    it('a resolver module left out of the page', () => {
      const page = good.split('\n').filter((line) => !line.startsWith('| `design-evidence` |')).join('\n');
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/module 'design-evidence' is in the resolver but not in the module table/);
    });

    it('a wrong profile default deliverable', () => {
      const page = good.replace('| `general` | `artifact` |', '| `general` | `doc` |');
      expect(page).not.toBe(good);
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/profile 'general' documents default deliverable \[doc\]/);
    });

    it('code listed for a non-code deliverable', () => {
      const page = good.replace('| `doc` | `generic-core` |', '| `doc` | `generic-core`, `code` |');
      expect(page).not.toBe(good);
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/deliverable 'doc' documents modules \[generic-core, code\]/);
    });

    it('a table removed from the page', () => {
      const page = good.replace(row(DELIVERABLE_TABLE_HEADER), '| Kind | Modules |');
      expect(judgeVerificationProfilesDoc(page, facts).join('\n')).toMatch(/missing the deliverable table/);
    });

    it('the resolver gaining a check the page does not document', () => {
      const grown: VerificationProfileFacts = {
        ...facts,
        moduleChecks: new Map([...facts.moduleChecks].map(([m, cs]) =>
          [m, m === 'code' ? [...cs, 'mutation-floor'] : cs] as const)),
      };
      expect(judgeVerificationProfilesDoc(good, grown).join('\n')).toMatch(/module 'code' documents checks .*the resolver has .*mutation-floor/);
    });
  });
});
