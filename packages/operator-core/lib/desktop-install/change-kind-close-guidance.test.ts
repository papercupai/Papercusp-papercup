/**
 * Independent P023 acceptance for change-kind-declared-proof P-005 / SPEC-P-005.
 * Exercise the same canonical blueprint and client overlays used at launch;
 * a source-only or materialized-copy assertion would miss projection failures.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from './papercusp-files';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OPERATOR_ROOT = join(REPO_ROOT, 'apps/operator');
const BASE_SOURCE = join(REPO_ROOT, 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md');
const OVERLAY_DIR = join(OPERATOR_ROOT, 'prompts');

describe('P005 change-kind declaration guidance reaches the su launch prompt', () => {
  it.each(['claude', 'codex', 'omp'])('%s teaches declaration before a successful close', async (agent) => {
    const rendered = await renderSuPlaybook({
      agent,
      operatorAppRoot: OPERATOR_ROOT,
      baseSource: BASE_SOURCE,
      overlayDir: OVERLAY_DIR,
    });
    expect(rendered.baseSource).toBe(BASE_SOURCE);
    expect(rendered.overlaySource).toBe(join(OVERLAY_DIR, `papercusp-su.${agent}.md`));
    expect(rendered.text.length).toBeGreaterThan(10_000);

    // Require actionable guidance in a completion paragraph, not an incidental
    // catalog listing elsewhere in the prompt. Wording and field spelling may
    // vary; declaring the kinds and its ordering before close are the contract.
    const closeParagraphs = rendered.text.split(/\n\s*\n/)
      .filter((paragraph) => paragraph.includes('work_items:complete'));
    const declarationGuidance = closeParagraphs.filter((paragraph) =>
      /\b(?:declar\w*|supply|record)\b/i.test(paragraph)
      && /changeKinds|change[ -]kinds?/i.test(paragraph));
    expect(declarationGuidance, 'a rendered completion paragraph must teach declaring change kinds').not.toEqual([]);
    expect(declarationGuidance.some((paragraph) => /\bbefore\b/i.test(paragraph)),
      'the declaration must precede the successful close').toBe(true);
  });
});
