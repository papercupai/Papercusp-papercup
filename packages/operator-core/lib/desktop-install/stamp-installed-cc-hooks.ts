/**
 * Stamp ~/.papercusp/hooks/cc after an install that did not go through installClaudeHooks
 * (WI-6554700010010534).
 *
 * install-standalone-mcp.sh copies the cc hooks itself and used to leave the previous
 * installer's `.installed-from` in place. On 2026-10-13 that record kept naming a
 * packaged 2026-10-07 desktop build (no commit date) after the canonical tree had
 * reinstalled newer hooks, so the downgrade guard had nothing to compare against and the
 * next packaged install could revert them again. This writes the stamp installClaudeHooks
 * writes, from the same CC_HOOK_FILES scoping, so the two installers' dates compare
 * like for like. A dir-wide date would not: a later commit to a file outside
 * CC_HOOK_FILES would date this stamp newer than an identical canonical install, and the
 * CC threshold of 0 would then refuse that legitimate install.
 *
 *   npx tsx packages/operator-core/lib/desktop-install/stamp-installed-cc-hooks.ts <src hooks/cc dir>
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSourceGitProvenance,
  resolveUncommittedSources,
  writeInstallStamp,
  type InstallStamp,
} from './install-provenance';
import { CC_HOOK_FILES } from './papercusp-files';

/**
 * Write `<home>/.papercusp/hooks/cc/.installed-from` for hooks just copied from `srcDir`.
 * `files` lists only the CC_HOOK_FILES whose installed bytes equal the source, so the
 * stamp never claims a file this install did not actually put there.
 */
export async function stampInstalledCcHooks(
  srcDir: string,
  opts: { home?: string; installedBy?: string; now?: Date } = {},
): Promise<InstallStamp> {
  const destDir = path.join(opts.home ?? os.homedir(), '.papercusp', 'hooks', 'cc');
  const files: string[] = [];
  for (const name of CC_HOOK_FILES) {
    const [src, dst] = await Promise.all([
      fs.readFile(path.join(srcDir, name)).catch(() => null),
      fs.readFile(path.join(destDir, name)).catch(() => null),
    ]);
    if (src && dst && src.equals(dst)) files.push(name);
  }
  const stamp: InstallStamp = {
    sourceDir: srcDir,
    ...(await resolveSourceGitProvenance(srcDir, CC_HOOK_FILES)),
    installedAt: (opts.now ?? new Date()).toISOString(),
    pid: process.pid,
    installedBy: opts.installedBy,
    files,
    uncommittedFiles: await resolveUncommittedSources(srcDir, CC_HOOK_FILES),
  };
  await writeInstallStamp(destDir, stamp);
  return stamp;
}

const invokedDirectly = process.argv[1]?.endsWith('stamp-installed-cc-hooks.ts');
if (invokedDirectly) {
  const srcDir = process.argv[2];
  if (!srcDir) {
    console.error('usage: stamp-installed-cc-hooks.ts <source hooks/cc dir>');
    process.exit(2);
  }
  stampInstalledCcHooks(path.resolve(srcDir), { installedBy: 'install-standalone-mcp.sh' })
    .then((s) => {
      console.log(
        `✓ Stamped hooks/cc <- ${s.sourceDir} (sha ${s.sourceSha?.slice(0, 10) ?? 'unknown'} @ ` +
          `${s.sourceCommittedAt ?? 'unknown'}, ${s.files?.length ?? 0} file(s) match)`,
      );
    })
    .catch((err: unknown) => {
      console.error(`! hooks/cc stamp failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
