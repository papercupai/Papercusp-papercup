/**
 * Doc claim: the authoring guide walks through building and publishing the
 * Slack and bug-triage packages, and every step it gives runs against the code.
 *
 * Reads the projected guide and judges it against facts taken from the live
 * tree (paths, manifests, the exporter's usage line, the publish verb's schema),
 * then runs the guide's own export command for both packages through the real
 * exporter. Drifted copies of the guide and drifted facts must each fail, so the
 * judge is shown to be falsifiable rather than vacuously green.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import publishPlugin from '../agent-tools/cupboard/publish-plugin';
import {
  BUILD_PUBLISH_HEADING,
  EXPORTER_SCRIPT,
  exporterUsageFlags,
  judgeChatProviderWalkthrough,
  PACKAGE_DIR_PREFIX,
  WALKTHROUGH_PACKAGES,
  type WalkthroughFacts,
} from './plugin-authoring-chat-provider-walkthrough';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(ROOT, 'apps/operator-docs/src/content/docs/plugins/provider-and-trigger-pack-authoring.mdx');

function publishArgNames(): string[] {
  const schema = (publishPlugin as unknown as { args?: { shape?: Record<string, unknown> } }).args;
  if (!schema?.shape) throw new Error('cupboard:publish-plugin args is not a zod object');
  return Object.keys(schema.shape);
}

function liveFacts(): WalkthroughFacts {
  const manifestDistribution: Record<string, string | undefined> = {};
  for (const name of WALKTHROUGH_PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, PACKAGE_DIR_PREFIX, name, 'papercusp.json'), 'utf8')) as {
      distribution?: string;
    };
    manifestDistribution[name] = manifest.distribution;
  }
  return {
    pathExists: (p) => existsSync(join(ROOT, p)),
    manifestDistribution,
    exporterFlags: exporterUsageFlags(readFileSync(join(ROOT, EXPORTER_SCRIPT), 'utf8')),
    publishArgs: publishArgNames(),
  };
}

const markdown = readFileSync(DOC, 'utf8');

describe('authoring guide: Slack + bug-triage build-and-publish walkthrough', () => {
  it('reads the real guide, manifests, exporter and publish verb (calibration)', () => {
    const facts = liveFacts();
    expect(markdown).toContain(BUILD_PUBLISH_HEADING);
    expect(facts.exporterFlags).toEqual(expect.arrayContaining(['package', 'out', 'push']));
    expect(facts.publishArgs).toEqual(expect.arrayContaining(['slug', 'githubUrl']));
    expect(Object.keys(facts.manifestDistribution).sort()).toEqual([...WALKTHROUGH_PACKAGES].sort());
  });

  it('every claim in the walkthrough holds against the live tree', () => {
    const verdict = judgeChatProviderWalkthrough(markdown, liveFacts());
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.checkedPaths.length).toBeGreaterThanOrEqual(8);
    expect(verdict.exportCommands.length).toBeGreaterThanOrEqual(1);
    expect(verdict.publishArgsCited).toEqual(['slug', 'githubUrl']);
  });

  it("the guide's export command builds a publishable mirror for both packages", () => {
    const verdict = judgeChatProviderWalkthrough(markdown, liveFacts());
    const command = verdict.exportCommands.find((c) => c.flags.some((f) => f.flag === 'push'));
    expect(command, 'guide gives an export + push command').toBeDefined();
    for (const name of WALKTHROUGH_PACKAGES) {
      const out = mkdtempSync(join(tmpdir(), `walkthrough-${name}-`));
      try {
        // The guide's flags, with --push dropped (no network) and --out pointed at a scratch dir.
        const args = [EXPORTER_SCRIPT];
        for (const { flag, value } of command!.flags) {
          if (flag === 'push') continue;
          args.push(`--${flag}`, flag === 'package' ? name : flag === 'out' ? out : (value ?? ''));
        }
        const stdout = execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
        expect(stdout).toMatch(/^MIRROR_OK files=\d+/m);
        const written = readdirSync(out);
        expect(written).toEqual(expect.arrayContaining(['papercusp.json', 'LICENSE']));
        const manifest = JSON.parse(readFileSync(join(out, 'papercusp.json'), 'utf8')) as { distribution?: string };
        expect(manifest.distribution).toBe('cupboard');
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
  });

  describe('falsifiability: drifted guides and drifted code each fail', () => {
    const facts = liveFacts();
    const fails = (doc: string, f: WalkthroughFacts = facts) => judgeChatProviderWalkthrough(doc, f).violations;

    it('a flag the exporter does not accept', () => {
      const drifted = markdown.replace('--push https://github.com/Papercusp/papercusp-slack.git', '--publish https://github.com/Papercusp/papercusp-slack.git');
      expect(drifted).not.toBe(markdown);
      expect(fails(drifted).join('\n')).toMatch(/--publish, which scripts\/plugin-mirror-export\.mjs does not accept/);
    });

    it('the exporter renaming its flag (code drift)', () => {
      const renamed = { ...facts, exporterFlags: facts.exporterFlags.filter((f) => f !== 'push') };
      expect(fails(markdown, renamed).join('\n')).toMatch(/uses --push/);
    });

    it('a push target that is not the package mirror', () => {
      const drifted = markdown.replace('https://github.com/Papercusp/papercusp-slack.git', 'https://github.com/Papercusp/papercusp-bug-triage.git');
      expect(fails(drifted).join('\n')).toMatch(/is not the slack mirror/);
    });

    it('a cited test file that moved', () => {
      const drifted = markdown.replace('`scripts/plugin-mirror-export.test.mjs`', '`scripts/plugin-mirror-export.spec.mjs`');
      expect(fails(drifted).join('\n')).toMatch(/cited path does not exist: scripts\/plugin-mirror-export\.spec\.mjs/);
    });

    it('a package that stops being Cupboard-distributed', () => {
      const bundled = { ...facts, manifestDistribution: { ...facts.manifestDistribution, 'bug-triage': 'bundled' } };
      expect(fails(markdown, bundled).join('\n')).toMatch(/bug-triage\/papercusp\.json declares distribution "bundled"/);
    });

    it('the publish verb losing an argument the guide shows', () => {
      const narrowed = { ...facts, publishArgs: facts.publishArgs.filter((a) => a !== 'githubUrl') };
      expect(fails(markdown, narrowed).join('\n')).toMatch(/cupboard:publish-plugin has no argument "githubUrl"/);
    });

    it('the build-and-publish subsection removed', () => {
      const drifted = markdown.replace(BUILD_PUBLISH_HEADING, '### Notes');
      expect(fails(drifted).join('\n')).toMatch(/missing subsection/);
    });

    it('the steps reordered so listing comes before the export', () => {
      const steps = markdown.slice(markdown.indexOf(BUILD_PUBLISH_HEADING));
      const exportStep = /^3\. \*\*Push the mirror\.\*\*.*$/m.exec(steps)?.[0];
      const listStep = /^4\. \*\*List it\.\*\*.*$/m.exec(steps)?.[0];
      expect(exportStep && listStep).toBeTruthy();
      const swapped = markdown
        .replace(exportStep!, '@@EXPORT@@')
        .replace(listStep!, exportStep!.replace(/^3\./, '4.'))
        .replace('@@EXPORT@@', listStep!.replace(/^4\./, '3.'));
      expect(fails(swapped).join('\n')).toMatch(/out of order/);
    });
  });
});
