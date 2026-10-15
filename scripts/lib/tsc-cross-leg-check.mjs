/**
 * WI-6554700010009433 — the per-file CROSS-LEG typecheck primitive.
 *
 * `lint:tsc --files=F` judges F only in its OWNING gate leg: coverage is decided by path prefix
 * (partitionFilesByCoverage → the sibling-gate routes in tsc-baseline-gate.mjs). A file that
 * relies on an ambient declaration reachable only through its own package's include glob or
 * `types` passes there, yet reds every OTHER leg whose program reaches it by import. Three such
 * instances reached the gate at once (WI-6554700010009424): content-intake.ts and its
 * pdf.worker.mjs module shim, the TaskMeta augmentation, and the Cloudflare types.
 *
 * This module answers "what diagnostics does F have inside leg L's program" without L's full
 * check. Program construction measured 3-23s per leg on 2026-10-12, against the ~150s full
 * check, because the checker is asked about the named files alone.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The project and extra compiler flags a gate's `npx tsc -p <cfg> <flags…>` command uses.
 *
 * @param {string} tscCommand
 * @returns {{ project: string, flags: string[] } | null} `null` when no `-p` operand is present.
 */
export function projectFromTscCommand(tscCommand) {
  const tokens = String(tscCommand ?? '').trim().split(/\s+/);
  const tscAt = tokens.findIndex((token) => token === 'tsc' || token.endsWith('/tsc'));
  if (tscAt < 0) return null;
  /** @type {string | null} */
  let project = null;
  /** @type {string[]} */
  const flags = [];
  const rest = tokens.slice(tscAt + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '-p' || token === '--project') {
      project = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    flags.push(token);
  }
  return project ? { project, flags } : null;
}

/** @param {string} root @param {string} absolute */
function repoRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * The error diagnostics each named file has inside ONE leg's program.
 *
 * `output` is rendered by `ts.formatDiagnostics` against `root`, which is the same text
 * `tsc --pretty false` prints when run from the repo root. The gate's existing parser and
 * per-file counter therefore consume it unchanged.
 *
 * @param {{ root: string, tscCommand: string, files: Iterable<string>, tsModule?: typeof ts }} args
 * @returns {{ project: string, members: string[], nonMembers: string[], output: string, diagnosticCount: number }}
 */
export function legFileDiagnostics({ root, tscCommand, files, tsModule = ts }) {
  const command = projectFromTscCommand(tscCommand);
  if (!command) throw new Error(`no -p project in tsc command: ${tscCommand}`);
  const cli = tsModule.parseCommandLine(command.flags);
  if (cli.errors.length > 0) {
    throw new Error(
      `unparseable tsc flags in ${tscCommand}: ` +
        cli.errors.map((d) => tsModule.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }
  const configPath = resolve(root, command.project);
  const config = tsModule.getParsedCommandLineOfConfigFile(configPath, cli.options, {
    ...tsModule.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(tsModule.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    },
  });
  if (!config) throw new Error(`could not read ${configPath}`);
  const options = { ...config.options, noEmit: true };
  const program = tsModule.createProgram({
    rootNames: config.fileNames,
    options,
    projectReferences: config.projectReferences,
  });

  /** @type {string[]} */
  const members = [];
  /** @type {string[]} */
  const nonMembers = [];
  /** @type {import('typescript').Diagnostic[]} */
  const diagnostics = [];
  for (const file of files) {
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    const sourceFile = program.getSourceFile(absolute);
    if (!sourceFile) {
      nonMembers.push(repoRelative(root, absolute));
      continue;
    }
    members.push(repoRelative(root, absolute));
    diagnostics.push(
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    );
    // tsc --noEmit reports declaration diagnostics whenever declarations would be emitted.
    if (options.declaration || options.composite) {
      diagnostics.push(...program.getDeclarationDiagnostics(sourceFile));
    }
  }
  const errors = diagnostics.filter((d) => d.category === tsModule.DiagnosticCategory.Error);
  const output = tsModule.formatDiagnostics(errors, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => '\n',
  });
  return { project: command.project, members, nonMembers, output, diagnosticCount: errors.length };
}
