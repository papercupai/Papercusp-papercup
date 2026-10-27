import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type Input = { path: string; sha256: string };

function containedFile(root: string, file: string): string {
  const target = realpathSync(resolve(root, file));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Portal build input escapes its source root: ${file}`);
  }
  return target;
}

function packageEntry(root: string, directory: string, name: string) {
  const manifest = containedFile(root, `${directory}/package.json`);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.name !== name) throw new Error(`Expected maintained package ${name}`);
  const entry = pkg.exports?.['.'];
  if (typeof entry !== 'string' || !entry.startsWith('./')) {
    throw new Error(`${name} must expose an explicit source entry`);
  }
  // An export must belong to this package, as well as the supplied checkout.
  // A traversal into a sibling package must not pass as the UI's own entry.
  const packageRoot = realpathSync(resolve(root, directory));
  return { manifest, entry: containedFile(packageRoot, entry) };
}

function dependencyRoot(requireFromDesktop: NodeJS.Require, name: string) {
  let directory = dirname(realpathSync(requireFromDesktop.resolve(name)));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).name === name) return directory;
    } catch { /* An ancestor without a package manifest is not the package root. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate desktop dependency ${name}`);
    directory = parent;
  }
}

/**
 * Resolve the maintained portal's inputs for the opt-in desktop build. This is
 * source preparation, not permission to publish or a claim that the candidate
 * has passed native/installed acceptance. No browser host shim is imported.
 */
export function desktopPortalSource(input: { portalRoot: string; papercuspRoot: string }) {
  if (!isAbsolute(input.portalRoot) || !isAbsolute(input.papercuspRoot)) {
    throw new Error('Explicit absolute portal and desktop source roots are required');
  }
  const root = realpathSync(input.portalRoot);
  const ui = packageEntry(root, 'packages/ui', '@portal/ui');
  const contracts = packageEntry(root, 'packages/contracts', '@portal/contracts');
  const shell = containedFile(root, 'packages/ui/src/shell.tsx');
  const styles = ['app/tokens.css', 'app/globals.css'].map(file => containedFile(root, file));
  const files = [ui.manifest, ui.entry, contracts.manifest, contracts.entry, shell, ...styles];
  const inputs: Input[] = [...new Set(files)].map(file => ({
    path: relative(root, file).split(sep).join('/'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  })).sort((a, b) => a.path.localeCompare(b.path));
  const desktopRequire = createRequire(resolve(realpathSync(input.papercuspRoot), 'package.json'));
  // Shared React hooks, query state and toast stores must use the desktop's
  // instances. Resolving from the portal would silently introduce second stores.
  const singletonRoots = Object.fromEntries(['react', 'react-dom', 'nuqs', 'sonner'].map(name =>
    [name, dependencyRoot(desktopRequire, name)]));
  return {
    root,
    uiEntry: ui.entry,
    contractsEntry: contracts.entry,
    shell,
    styles,
    singletonRoots,
    // The web portal aliases this to tauri-api-browser.ts. Desktop composition
    // must retain the real implementation; renderer trust stays a runtime check.
    nativeApiEntry: realpathSync(desktopRequire.resolve('@tauri-apps/api/core')),
    inputs,
    sourceFingerprint: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    scope: 'portal entry, shell and build inputs; not the complete bundled asset graph' as const,
  };
}
