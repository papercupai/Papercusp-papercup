import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Pure path resolution shared with worker-thread callers. */
export function dependencyGenerationRootRecord(integrationRoot: string): string {
  return join(integrationRoot, '.papercusp/dependency-generation-root');
}

export function readRecordedDependencyGenerationRoot(integrationRoot: string): string | null {
  let text: string;
  try {
    text = readFileSync(dependencyGenerationRootRecord(integrationRoot), 'utf8');
  } catch {
    return null;
  }
  const recorded = text.split('\n', 1)[0] ?? '';
  return isAbsolute(recorded) ? recorded : null;
}

export function resolveDependencyGenerationRoot(
  integrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT?.trim();
  return resolve(
    configured ||
      readRecordedDependencyGenerationRoot(integrationRoot) ||
      join(integrationRoot, '.papercusp/dependency-generations'),
  );
}

export function resolveDependencyGenerationRetentionRoots(
  integrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const current = resolveDependencyGenerationRoot(integrationRoot, env);
  let recorded: string[] = [];
  try {
    recorded = readFileSync(dependencyGenerationRootRecord(integrationRoot), 'utf8')
      .split('\n').filter((value) => isAbsolute(value)).map((value) => resolve(value));
  } catch { /* No record means only the current store is known. */ }
  return [...new Set([current, ...recorded])];
}
