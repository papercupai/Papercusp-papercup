import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSuStackSource, suSessionBinding } from '@papercusp/orchestrator/blueprint';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import { deferSuPromptReferences, SU_KERNEL_END } from './prompt-reference-sections';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseSource = path.join(repoRoot, 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md');
const overlayDir = path.join(repoRoot, 'apps/operator/prompts');

describe('on-demand su reference sections', () => {
  it.each(['codex', 'claude'])('shrinks the real %s render by at least thirty percent and keeps the core', async agent => {
    const input = { agent, baseSource, overlayDir, operatorAppRoot: path.join(repoRoot, 'apps/operator'),
      projectGuideSource: '', renderWireSchemas: () => '' };
    const full = await renderSuPlaybook({ ...input, referenceMode: 'inline' });
    const compact = await renderSuPlaybook(input);
    const baseline = Buffer.byteLength(full.text);
    const actual = Buffer.byteLength(compact.text);
    console.info('SU_REFERENCE_SIZE', JSON.stringify({ agent, plane: 'canonical-base', baselineBytes: baseline, actualBytes: actual }));
    expect(actual, `baseline=${baseline}, actual=${actual}`).toBeLessThanOrEqual(baseline * 0.7);
    for (const rule of ['File locking is ENFORCED', 'hold a work-item before you edit',
      'The papercusp-way routing gate', 'Default posture', 'Owner directives',
      'A one-agent route limits implementation fan-out; it does not disable platform-routed independent acceptance checks']) {
      expect(compact.text).toContain(rule);
    }
    expect(compact.text).toContain('Operational reference index');
    expect(compact.text).not.toContain('Two-call file capture — the shape with no ceiling');
  });

  it.each(['codex', 'claude'])('reduces the actual composed AUTO %s stack and preserves its sealed kernel', async agent => {
    const composed = composeSuStackSource({ harnessDir: path.join(repoRoot, 'libs/papercusp/packages/harness'),
      binding: suSessionBinding({ modes: ['auto'] }) });
    const input = { agent, baseSource, baseText: composed.text, overlayDir,
      operatorAppRoot: path.join(repoRoot, 'apps/operator'), projectGuideSource: '', renderWireSchemas: () => '' };
    const full = await renderSuPlaybook({ ...input, referenceMode: 'inline' });
    const compact = await renderSuPlaybook(input);
    const baselineBytes = Buffer.byteLength(full.text);
    const actualBytes = Buffer.byteLength(compact.text);
    console.info('SU_REFERENCE_SIZE', JSON.stringify({ agent, plane: 'composed-auto', baselineBytes, actualBytes }));
    expect(actualBytes).toBeLessThanOrEqual(baselineBytes * 0.7);
    const routeStart = full.text.indexOf('### The papercusp-way routing gate');
    const routeEnd = full.text.indexOf('\n## ', routeStart + 1);
    expect(compact.text).toContain(full.text.slice(routeStart, routeEnd));
    const seal = '<!-- PAPERCUSP-KERNEL:SEAL -->';
    const sealAt = full.text.indexOf(seal);
    const notesAt = full.text.indexOf('## The deploy pipeline is ASYNC', sealAt);
    const kernel = full.text.slice(sealAt, notesAt < 0 ? full.text.length : notesAt);
    expect(kernel.length).toBeGreaterThan(10_000);
    expect(compact.text).toContain(kernel);
  });

  it('points every removed section to an existing source containing its heading', async () => {
    const full = await renderSuPlaybook({ agent: 'codex', baseSource, overlayDir,
      operatorAppRoot: path.join(repoRoot, 'apps/operator'), projectGuideSource: '', referenceMode: 'inline' });
    const result = deferSuPromptReferences(full.text, { base: baseSource,
      overlay: path.join(overlayDir, 'papercusp-su.codex.md'), repoRoot });
    expect(result.references.length).toBeGreaterThan(5);
    for (const ref of result.references) expect(await fs.readFile(ref.source, 'utf8')).toContain(ref.heading);
  });

  it('keeps emitted source pointers readable after the generation checkout is pruned', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'su-reference-lifetime-'));
    const generationRoot = path.join(tempRoot, '.candidate-generation', 'checkout');
    const canonicalRoot = path.join(tempRoot, 'canonical');
    const previousCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;
    const sourceFiles = [
      { path: 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md', contents: 'canonical base source' },
      { path: 'apps/operator/prompts/papercusp-su.codex.md', contents: 'canonical overlay source' },
      { path: 'libs/papercusp/packages/orchestrator/src/prompt-build.ts', contents: 'canonical policy source' },
    ];

    try {
      for (const root of [generationRoot, canonicalRoot]) {
        for (const source of sourceFiles) {
          const filePath = path.join(root, source.path);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, `${root === canonicalRoot ? source.contents : 'generation source'}\n`);
        }
      }

      process.env.PAPERCUSP_CANONICAL_TREE = canonicalRoot;
      const result = deferSuPromptReferences([
        '## Delivery discipline — source',
        'Long delivery section.',
        '## An empty `exec_command`',
        'Long shell section.',
        '## The deploy pipeline is ASYNC — source',
        'Long deployment section.',
      ].join('\n'), {
        base: path.join(generationRoot, sourceFiles[0]!.path),
        overlay: path.join(generationRoot, sourceFiles[1]!.path),
        repoRoot: generationRoot,
      });

      const expectedPaths = sourceFiles.map(source => path.join(canonicalRoot, source.path));
      expect(result.references.map(reference => reference.source)).toEqual(expectedPaths);
      expect(result.text).toContain(canonicalRoot);
      expect(result.text).not.toContain(generationRoot);

      await fs.rm(generationRoot, { recursive: true, force: true });
      for (let i = 0; i < expectedPaths.length; i++) {
        await expect(fs.readFile(result.references[i]!.source, 'utf8')).resolves.toContain(sourceFiles[i]!.contents);
      }
    } finally {
      if (previousCanonicalTree === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
      else process.env.PAPERCUSP_CANONICAL_TREE = previousCanonicalTree;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the entire sealed kernel verbatim and strips only the renderer sentinel', () => {
    const kernel = '<!-- PAPERCUSP-KERNEL:SEAL -->\n## Engineering discipline\n\nKEEP THIS KERNEL VERBATIM\n';
    const source = '## Delivery discipline — source\n\nLong delivery reference\n' + kernel + SU_KERNEL_END;
    const result = deferSuPromptReferences(source, { base: baseSource, overlay: '', repoRoot }).text;
    expect(result).toContain(kernel);
    expect(result).not.toContain(SU_KERNEL_END);
  });
});
