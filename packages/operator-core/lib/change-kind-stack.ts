/**
 * Stack-aware proof-tool defaults for change-kind declarations (P-003 / R-3).
 *
 * The close gate and the claim receipt both need the same answer to "which tool should
 * prove a UI change in this repository?" Keep the manifest probe and the Papercusp
 * serving-runtimes override here so those two surfaces cannot drift.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBuildTestRoute, type CurrentBuildTestClassId } from './serving-runtimes';
import type { ChangeKind } from './change-kind-catalog';

export type RepositoryStack = 'tauri' | 'web' | 'unknown';

export interface RepositoryStackDetection {
  stack: RepositoryStack;
  label: string;
  framework: string | null;
  defaultTool: string;
  manifest: string | null;
}

export interface StackProofGuidanceInput {
  repoRoot?: string | null;
  harnessSlug?: string | null;
  /** Papercusp's maintained current-build class, when the caller has selected one. */
  testClass?: CurrentBuildTestClassId | string | null;
  kind: ChangeKind;
}

const TAURI_TOOL = 'VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- <assertion> (headless Tauri runner)';
const WEB_TOOL = 'headless browser (Playwright/verdict runner)';
const UNKNOWN_TOOL = 'name your own headless tool/runner and record the UI artifact it produces';

async function readable(root: string, relative: string): Promise<boolean> {
  try {
    await readFile(join(root, relative), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function packageNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name.toLowerCase());
  }
  const scripts = manifest.scripts;
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const value of Object.values(scripts as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      for (const token of value.toLowerCase().split(/[^a-z0-9@/_-]+/)) if (token) names.add(token);
    }
  }
  return names;
}

/** Detect the repository stack from committed manifest names, with Tauri taking precedence. */
export async function detectRepositoryStack(repoRoot?: string | null): Promise<RepositoryStackDetection> {
  const root = typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot : null;
  if (!root) {
    return { stack: 'unknown', label: 'unknown/unrecognized stack', framework: null, defaultTool: UNKNOWN_TOOL, manifest: null };
  }

  const tauriManifest = (await readable(root, 'src-tauri/tauri.conf.json'))
    ? 'src-tauri/tauri.conf.json'
    : (await readable(root, 'tauri.conf.json'))
      ? 'tauri.conf.json'
      : null;
  if (tauriManifest) {
    return { stack: 'tauri', label: 'Tauri desktop stack', framework: 'Tauri', defaultTool: TAURI_TOOL, manifest: tauriManifest };
  }

  const pkg = await readPackageJson(root);
  if (pkg) {
    const names = packageNames(pkg);
    const frameworks: Array<[string, string]> = [
      ['next', 'Next.js'],
      ['@sveltejs/kit', 'SvelteKit'],
      ['nuxt', 'Nuxt'],
      ['@remix-run/react', 'Remix'],
      ['@remix-run/node', 'Remix'],
      ['astro', 'Astro'],
      ['@angular/core', 'Angular'],
      ['vue', 'Vue'],
      ['react', 'React'],
      ['svelte', 'Svelte'],
      ['vite', 'Vite'],
      ['solid-js', 'Solid'],
      ['qwik', 'Qwik'],
      ['gatsby', 'Gatsby'],
      ['ember-source', 'Ember'],
      ['lit', 'Lit'],
    ];
    const found = frameworks.find(([name]) => names.has(name));
    if (found) {
      return { stack: 'web', label: `${found[1]} web stack`, framework: found[1], defaultTool: WEB_TOOL, manifest: 'package.json' };
    }
    return { stack: 'unknown', label: 'unknown/unrecognized stack', framework: null, defaultTool: UNKNOWN_TOOL, manifest: 'package.json' };
  }

  return { stack: 'unknown', label: 'unknown/unrecognized stack', framework: null, defaultTool: UNKNOWN_TOOL, manifest: null };
}

function overrideRoute(input: StackProofGuidanceInput): { route: string; source: string } | null {
  if (input.harnessSlug !== 'papercusp' || !input.testClass) return null;
  const route = currentBuildTestRoute(input.testClass);
  return route ? { route: route.route, source: `Papercusp serving-runtimes ${route.id} override` } : null;
}

/** Render the guidance shared by close refusals and successful claim receipts. */
export async function renderStackProofGuidance(input: StackProofGuidanceInput): Promise<string> {
  const detected = await detectRepositoryStack(input.repoRoot);
  const override = overrideRoute(input);
  const tool = override?.route ?? detected.defaultTool;
  const source = override?.source ?? `${detected.label} manifest default`;
  if (input.kind === 'background-job') {
    return `Default isolated-runtime tool (${source}): ${tool}. Record the isolated runtime, the command, and its observable effect in completion.kindEvidence.`;
  }
  if (input.kind === 'ui') {
    return `Default UI proof tool (${source}): ${tool}. Record a retained screenshot, DOM or accessibility artifact in completion.kindEvidence.artifacts; an unknown stack may ${UNKNOWN_TOOL}.`;
  }
  return `Default proof tool (${source}): ${tool}. Name the command or probe in the kind's completion evidence.`;
}

