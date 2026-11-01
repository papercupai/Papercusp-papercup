import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

/** Refuse overwrite and symlink traversal before spending a build or writing bytes. */
export function candidateDirectory(root: string, directory: string,
  privateRoot = resolve(homedir(), '.papercusp/desktop-candidates')): string {
  const canonical = realpathSync(root);
  if (!isAbsolute(directory)) throw new Error('--output must be an absolute private candidate directory');
  const output = resolve(directory);
  const boundary = resolve(privateRoot);
  const repositoryPath = relative(canonical, boundary);
  if (!repositoryPath || (!repositoryPath.startsWith(`..${sep}`) && repositoryPath !== '..' && !isAbsolute(repositoryPath))) {
    throw new Error('Private candidate storage must be outside the repository');
  }
  const path = relative(boundary, output);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('--output must be below ~/.papercusp/desktop-candidates');
  }
  if (existsSync(output)) throw new Error('Candidate output already exists; select a new directory');
  let parent = dirname(output);
  while (dirname(parent) !== parent) {
    if (existsSync(parent) && realpathSync(parent) !== parent) throw new Error('Candidate output cannot traverse symlinks');
    parent = dirname(parent);
  }
  return output;
}

/** Vite does not copy publicDir when write:false; retain those bytes explicitly. */
export function candidatePublicAssets(directory: string | false) {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  if (!directory || !existsSync(directory)) return files;
  const root = realpathSync(directory);
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Candidate public assets cannot traverse symlinks');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push({ path: relative(root, file), bytes: readFileSync(file) });
      else throw new Error('Unsupported candidate public asset');
    }
  }
  visit(root);
  return files;
}

export function writeCandidateFiles(root: string, directory: string,
  files: Array<{ path: string; bytes: string | Uint8Array }>, privateRoot?: string) {
  candidateDirectory(root, directory, privateRoot);
  const destinations = new Set<string>();
  for (const file of files) {
    const path = relative(directory, file.path);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || destinations.has(file.path)) {
      throw new Error('Candidate output escaped its directory or collided');
    }
    destinations.add(file.path);
  }
  mkdirSync(dirname(directory), { recursive: true });
  candidateDirectory(root, directory, privateRoot);
  mkdirSync(directory); // no recursive reuse: another writer winning is a refusal
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.bytes, { flag: 'wx' });
  }
}

export async function prepareCandidate(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'portal-root': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node --import tsx apps/operator-vite/desktop-portal-candidate.ts --portal-root <absolute maintained portal source> --output <new ~/.papercusp/desktop-candidates directory>');
    return;
  }
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const desktopSource = () => ({
    commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'],
      { cwd: root, encoding: 'utf8' }).trim().length > 0,
  });
  const sourceAtStart = desktopSource();
  const directory = candidateDirectory(root, values.output ?? '');
  if (!values['portal-root'] || !isAbsolute(values['portal-root'])) throw new Error('--portal-root must be absolute');
  // These process settings belong to this explicit CLI invocation. Ordinary
  // Vite/build/package/public entrypoints retain their existing legacy default.
  process.env.PAPERCUSP_DESKTOP_INTERFACE = 'portal-candidate';
  process.env.PAPERCUSP_DESKTOP_PORTAL_ROOT = values['portal-root'];
  process.env.PAPERCUSP_VITE_OUT_DIR = resolve(directory, 'spa');
  const [{ build }, { prepareDesktopPortalHostBundle }] = await Promise.all([
    import('vite'), import('../operator/bin/desktop-portal-host-bundle.ts'),
  ]);
  let publicDirectory: string | false = false;
  const [frontend, host] = await Promise.all([
    build({ root: resolve(root, 'apps/operator-vite'), configFile: resolve(root, 'apps/operator-vite/vite.config.ts'),
      logLevel: 'error', build: { write: false, emptyOutDir: false }, plugins: [{
        name: 'private-candidate-public-assets',
        configResolved(config) { publicDirectory = config.publicDir; },
      }] }),
    prepareDesktopPortalHostBundle({ portalRoot: values['portal-root'], papercuspRoot: root,
      outputFile: resolve(directory, 'desktop-portal.cjs') }),
  ]);
  const outputs = (Array.isArray(frontend) ? frontend : [frontend]).flatMap(result => 'output' in result ? result.output : []);
  const index = outputs.find(item => item.fileName === 'index.html');
  if (!index || index.type !== 'asset') throw new Error('Candidate document was not emitted');
  const html = typeof index.source === 'string' ? index.source : new TextDecoder().decode(index.source);
  if (!html.includes('content="portal-candidate"')) throw new Error('Candidate document identity is missing');
  const modules = outputs.flatMap(item => item.type === 'chunk' ? Object.keys(item.modules) : []);
  if (!modules.some(path => path.endsWith('/packages/ui/src/shell.tsx')) || modules.some(path => path.includes('tauri-api-browser'))) {
    throw new Error('Candidate must contain the maintained portal shell and real native bindings');
  }
  const files = [...outputs.map(item => ({ path: resolve(directory, 'spa', item.fileName),
    bytes: item.type === 'chunk' ? item.code : item.source })),
  ...candidatePublicAssets(publicDirectory).map(item => ({ ...item, path: resolve(directory, 'spa', item.path) })),
  ...host.outputFiles.map(item => ({ path: item.path, bytes: item.contents }))];
  if (JSON.stringify(sourceAtStart) !== JSON.stringify(desktopSource())) {
    throw new Error('Desktop candidate source changed during preparation');
  }
  writeCandidateFiles(root, directory, files);
  const receipt = {
    schemaVersion: 'desktop-portal-private-candidate-v1', preparedAt: new Date().toISOString(),
    desktopSource: sourceAtStart,
    source: host.source.inputs, sourceFingerprint: host.source.sourceFingerprint,
    hostInputs: host.inputs, hostFingerprint: host.sourceFingerprint,
    desktopAdapterInput: host.desktopAdapterInput,
    files: files.map(file => ({ path: relative(directory, file.path),
      sha256: createHash('sha256').update(file.bytes).digest('hex') })),
    environment: { PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate',
      PAPERCUSP_SPA_DIST: resolve(directory, 'spa'),
      PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE: resolve(directory, 'desktop-portal.cjs') },
    scope: 'Private source-built frontend and local host only. PORTAL_DATABASE_URL must name a separate persistent store at launch; no listener, native app or public publication started.',
  };
  writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, directory, files: files.length,
    sourceFingerprint: receipt.sourceFingerprint, receipt: resolve(directory, 'candidate.json'), scope: receipt.scope }));
}

if (isCliEntry(import.meta.url)) {
  await prepareCandidate();
}
