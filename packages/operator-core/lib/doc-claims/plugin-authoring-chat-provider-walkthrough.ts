/**
 * Judge the chat-provider worked example (the Slack + bug-triage walkthrough)
 * in the provider and trigger-pack authoring guide
 * (`plugins/provider-and-trigger-pack-authoring`). The module is named for the
 * guide section, not the provider, so app code stays outside the shrink-only
 * provider census (lib/integrations/provider-specific-census.test.ts).
 *
 * The guide tells an author how to build, export, push and list the two
 * Cupboard-distributed chat packages. Every runnable or checkable claim in that
 * walkthrough names something the code owns: a package directory, a manifest's
 * `distribution`, a test file, the mirror exporter's flags, the publish verb's
 * arguments. This module checks those claims against facts the caller reads
 * from the live tree, so a renamed flag, a moved test or a package that stops
 * being Cupboard-distributed turns the doc claim red instead of leaving the
 * guide quietly wrong.
 *
 * Facts are supplied by the caller rather than read here, so the judge stays a
 * pure function and the test can feed it drifted facts to prove it fails.
 */

export const WALKTHROUGH_HEADING = '## Chat-provider worked example: Slack and bug-triage';
export const BUILD_PUBLISH_HEADING = '### Building and publishing these two packages';
export const WALKTHROUGH_PACKAGES = ['slack', 'bug-triage'] as const;
export const PACKAGE_DIR_PREFIX = 'libs/papercusp/plugins/';
export const EXPORTER_SCRIPT = 'scripts/plugin-mirror-export.mjs';
export const EXPORTER_TEST = 'scripts/plugin-mirror-export.test.mjs';
export const PUBLISH_VERB = 'cupboard:publish-plugin';

export interface WalkthroughFacts {
  /** Whether a repo-relative path exists in the tree. */
  pathExists: (repoRelativePath: string) => boolean;
  /** `distribution` declared by each walkthrough package's manifest, keyed by directory name. */
  manifestDistribution: Readonly<Record<string, string | undefined>>;
  /** Flags the exporter's usage line accepts, without the leading `--`. */
  exporterFlags: readonly string[];
  /** Argument names the publish verb's schema accepts. */
  publishArgs: readonly string[];
}

export interface ExportCommand {
  raw: string;
  flags: Array<{ flag: string; value: string | undefined }>;
}

export interface WalkthroughVerdict {
  ok: boolean;
  violations: string[];
  checkedPaths: string[];
  exportCommands: ExportCommand[];
  publishArgsCited: string[];
}

/** The text under `heading` up to the next heading of the same or higher level. */
export function sectionUnder(markdown: string, heading: string): string | null {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) return null;
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const bodyStart = start + heading.length + 1;
  const rest = markdown.slice(bodyStart);
  const next = rest.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Backticked repo-relative paths (contain a slash and start at a known tree root). */
export function citedRepoPaths(text: string): string[] {
  const roots = /^(packages|libs|scripts|apps)\//;
  const out = new Set<string>();
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    const value = (match[1] ?? '').replace(/\/$/, '');
    if (roots.test(value)) out.add(value);
  }
  return [...out];
}

/** Every `node scripts/plugin-mirror-export.mjs …` command in backticks, with its flags. */
export function exportCommands(text: string): ExportCommand[] {
  const commands: ExportCommand[] = [];
  for (const match of text.matchAll(/`(node\s+scripts\/plugin-mirror-export\.mjs[^`]*)`/g)) {
    const raw = match[1] ?? '';
    const tokens = raw.trim().split(/\s+/).slice(2);
    const flags: ExportCommand['flags'] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] ?? '';
      if (!token.startsWith('--')) continue;
      const next = tokens[i + 1];
      const hasValue = next !== undefined && !next.startsWith('--');
      flags.push({ flag: token.slice(2), value: hasValue ? next : undefined });
      if (hasValue) i += 1;
    }
    commands.push({ raw, flags });
  }
  return commands;
}

/** Argument names cited in `cupboard:publish-plugin { a, b }`. */
export function citedPublishArgs(text: string): string[] {
  const match = new RegExp(`\`${PUBLISH_VERB.replace(':', '\\:')}\\s*\\{([^}]*)\\}\``).exec(text);
  if (!match) return [];
  return (match[1] ?? '')
    .split(',')
    .map((part) => part.trim().split(/[\s:]/)[0] ?? '')
    .filter((name) => name.length > 0);
}

export function judgeChatProviderWalkthrough(markdown: string, facts: WalkthroughFacts): WalkthroughVerdict {
  if (markdown.trim().length < 2000) {
    throw new Error('Refusing to judge a short/empty authoring-guide read');
  }
  const violations: string[] = [];
  const walkthrough = sectionUnder(markdown, WALKTHROUGH_HEADING);
  if (walkthrough === null) {
    return {
      ok: false,
      violations: [`missing section "${WALKTHROUGH_HEADING}"`],
      checkedPaths: [],
      exportCommands: [],
      publishArgsCited: [],
    };
  }

  // 1. Both packages are named by directory, and both are Cupboard-distributed as the guide says.
  for (const name of WALKTHROUGH_PACKAGES) {
    const dir = `${PACKAGE_DIR_PREFIX}${name}`;
    if (!walkthrough.includes(`\`${dir}\``)) violations.push(`walkthrough does not name the package directory ${dir}`);
    const distribution = facts.manifestDistribution[name];
    if (distribution !== 'cupboard') {
      violations.push(`${dir}/papercusp.json declares distribution ${JSON.stringify(distribution)}, guide says "cupboard"`);
    }
  }
  if (!walkthrough.includes('"distribution": "cupboard"')) {
    violations.push('walkthrough does not state the packages declare "distribution": "cupboard"');
  }

  // 2. Every repo-relative path the walkthrough cites exists.
  const checkedPaths = citedRepoPaths(walkthrough);
  for (const path of checkedPaths) {
    if (!facts.pathExists(path)) violations.push(`cited path does not exist: ${path}`);
  }

  // 3. The build-and-publish subsection walks through test, export+push, and listing, in order.
  const steps = sectionUnder(markdown, BUILD_PUBLISH_HEADING);
  let commands: ExportCommand[] = [];
  let publishArgsCited: string[] = [];
  if (steps === null) {
    violations.push(`missing subsection "${BUILD_PUBLISH_HEADING}"`);
  } else {
    const numbered = [...steps.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));
    if (numbered.length < 3 || numbered.some((n, i) => n !== i + 1)) {
      violations.push(`build-and-publish steps are not a numbered 1..N walk (found ${JSON.stringify(numbered)})`);
    }
    for (const required of [EXPORTER_TEST, EXPORTER_SCRIPT]) {
      if (!steps.includes(required)) violations.push(`build-and-publish steps do not cite ${required}`);
    }

    commands = exportCommands(steps);
    if (commands.length === 0) violations.push('build-and-publish steps give no runnable exporter command');
    let pushes = 0;
    for (const command of commands) {
      for (const { flag, value } of command.flags) {
        if (!facts.exporterFlags.includes(flag)) {
          violations.push(`exporter command uses --${flag}, which ${EXPORTER_SCRIPT} does not accept`);
        }
        if (flag !== 'push' && value === undefined) violations.push(`exporter command flag --${flag} has no value`);
      }
      const pkg = command.flags.find((f) => f.flag === 'package')?.value;
      if (!pkg || !(WALKTHROUGH_PACKAGES as readonly string[]).includes(pkg)) {
        violations.push(`exporter command --package ${JSON.stringify(pkg)} is not one of the walkthrough packages`);
      }
      if (!command.flags.some((f) => f.flag === 'out')) violations.push('exporter command has no --out');
      const push = command.flags.find((f) => f.flag === 'push');
      if (push) {
        pushes += 1;
        const expected = `https://github.com/Papercusp/papercusp-${pkg}.git`;
        if (push.value !== expected) {
          violations.push(`exporter --push target ${JSON.stringify(push.value)} is not the ${pkg} mirror ${expected}`);
        }
      }
    }
    if (commands.length > 0 && pushes === 0) violations.push('no exporter command pushes the mirror (--push)');

    publishArgsCited = citedPublishArgs(steps);
    if (publishArgsCited.length === 0) {
      violations.push(`build-and-publish steps do not show ${PUBLISH_VERB} with its arguments`);
    }
    for (const arg of publishArgsCited) {
      if (!facts.publishArgs.includes(arg)) violations.push(`${PUBLISH_VERB} has no argument "${arg}"`);
    }

    const order = [EXPORTER_TEST, 'node scripts/plugin-mirror-export.mjs', PUBLISH_VERB].map((needle) => steps.indexOf(needle));
    if (order.every((i) => i >= 0) && !(order[0]! < order[1]! && order[1]! < order[2]!)) {
      violations.push('build-and-publish steps are out of order (test, then export/push, then list)');
    }
  }

  return { ok: violations.length === 0, violations, checkedPaths, exportCommands: commands, publishArgsCited };
}

/** Flags named in the exporter's usage line, e.g. `--package <name>` → `package`. */
export function exporterUsageFlags(scriptSource: string): string[] {
  const usage = /'usage: plugin-mirror-export\.mjs ([^']+)'/.exec(scriptSource)?.[1];
  if (!usage) throw new Error(`no usage line found in ${EXPORTER_SCRIPT}`);
  return [...usage.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1] ?? '');
}
