/**
 * Settings → Integrations names no specific provider (plan cupboard-distributable-integrations-
 * 2026-10-10 P-005, SPEC-R-2-P-005). Every card, form and workflow section is driven by what an
 * installed package declares, so a provider installed from the Cupboard needs no app change, and
 * removing one leaves nothing behind.
 *
 * The scan reads the page and its components with comments removed by the TypeScript compiler
 * (design notes may cite providers; shipped code and UI text may not). There is no exception:
 * the built-in Slack setup card was deleted by P-008 (D-019), and a new Slack connection is made
 * through the slack package's generic card like any other provider.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;

/** The page and every component it renders for providers and workflows. */
const SCANNED = [
  'page.tsx',
  'ProviderAppRegistration.tsx',
  'ProviderCredentialsForm.tsx',
  'ProviderOptionsSelect.tsx',
  'ProviderSourceSettingsForm.tsx',
  'ProviderSourceConfigForm.tsx',
  'TriggerPackSection.tsx',
  'ticket-integrations-client.ts',
];

const PROVIDER_NAMES = /\b(slack|asana|linear|jira|github|gitlab|discord|notion|trello|zendesk|intercom|gmail|google|outlook|microsoft|facebook|twitter|instagram|linkedin|telegram|whatsapp)\b/i;

function codeWithoutComments(fileName: string, text: string): string {
  return ts.transpileModule(text, {
    fileName,
    compilerOptions: { removeComments: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** Splits camelCase/PascalCase identifiers so `SlackSetupCard` reads as `Slack Setup Card`. */
function identifierWords(line: string): string {
  return line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function providerMentions(fileName: string, text: string): string[] {
  return codeWithoutComments(fileName, text)
    .split('\n')
    .filter((line) => PROVIDER_NAMES.test(identifierWords(line)))
    .map((line) => line.trim());
}

describe('Settings → Integrations is provider-neutral', () => {
  it.each(SCANNED)('%s names no provider', (file) => {
    expect(providerMentions(file, readFileSync(join(DIR, file), 'utf8'))).toEqual([]);
  });

  it('the scan finds a provider name in code and UI text, and ignores one in a comment', () => {
    expect(providerMentions('x.tsx', 'export const A = () => <b>Connect Asana</b>;')).toHaveLength(1);
    expect(providerMentions('x.ts', "export const id = 'linear';")).toHaveLength(1);
    expect(providerMentions('x.ts', '// Linear decides\nexport const id = 1;')).toEqual([]);
    // A provider name inside an identifier counts: re-adding the retired built-in card fails the scan.
    expect(providerMentions('x.tsx', 'export const A = () => <SlackSetupCard />;')).toHaveLength(1);
    expect(providerMentions('x.ts', 'export const useAsanaToken = 1;')).toHaveLength(1);
    // ...but a word that merely contains a provider name does not.
    expect(providerMentions('x.ts', 'export const slackness = 1;')).toEqual([]);
  });

  it('the built-in Slack setup card is gone (P-008, D-019)', () => {
    expect(existsSync(join(DIR, 'SlackSetupCard.tsx'))).toBe(false);
  });
});
