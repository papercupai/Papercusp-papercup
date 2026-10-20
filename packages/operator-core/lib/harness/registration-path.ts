/**
 * Classify a `{ path }` handed to POST /api/harness/projects before it is
 * registered (WI-6554700010018316, fix 1).
 *
 * `existsSync` answers `false` for BOTH a missing path and one the operator
 * cannot stat. On a Papercusp-hosted workspace the operator runs as the
 * `papercusp` service user while the terminal user's home is 0700, so a
 * project cloned into that home was refused as "path does not exist" — a
 * permission denial reported as absence, with no hint of where projects
 * belong. This helper keeps the two apart and, on a host that has the hosted
 * workspace root, names it.
 */
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { WORKSPACE_HOST_DATA_ROOT } from '@papercusp/deployment-driver';
import { RETIRED_HARNESS_SLUG_ALIASES } from './operator-home-harness';

/**
 * Refuse a RETIRED harness slug at registration (WI-6554700010018316, fix 2).
 *
 * The registry folds a retired slug (`papercup`, `papercup-hive`) to its current
 * name on every READ (harness-registry `canonicalizeLegacyPapercup`, plus
 * RETIRED_HARNESS_SLUG_ALIASES on resolution). Registering under one stored
 * `papercup` and scaffolded `harness_papercup`, but every reader then saw
 * `papercusp`: the typed name looked ignored, and `harness_papercusp` (with its
 * `agent_chats` view) never existed, so the first session launch 500'd
 * "relation agent_chats does not exist" (measured on avi-test, 2026-10-20).
 * Refuse the name up front instead of letting the read side silently rename it.
 */
export function retiredSlugRefusal(
  slug: string,
): { status: 400; code: 'retired_slug'; error: string; canonicalSlug: string } | null {
  if (!Object.prototype.hasOwnProperty.call(RETIRED_HARNESS_SLUG_ALIASES, slug)) return null;
  const canonicalSlug = RETIRED_HARNESS_SLUG_ALIASES[slug];
  return {
    status: 400,
    code: 'retired_slug',
    error: `'${slug}' is a retired project name; the registry reads it as '${canonicalSlug}', so it cannot be registered under that name. Choose a different name.`,
    canonicalSlug,
  };
}

export type RegistrationPathVerdict =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 403;
      code: 'path_missing' | 'path_not_accessible' | 'path_unreadable';
      error: string;
      hint?: string;
    };

export interface RegistrationPathDeps {
  stat: (path: string) => unknown;
  /** The OS user the operator process runs as. */
  operatorUser: () => string;
  /** The hosted workspace root, when this host has one; otherwise null. */
  hostedWorkspaceRoot: () => string | null;
}

const defaultDeps: RegistrationPathDeps = {
  stat: (path) => statSync(path),
  operatorUser: () => {
    try {
      return userInfo().username;
    } catch {
      return 'the operator user';
    }
  },
  hostedWorkspaceRoot: () => (existsSync(WORKSPACE_HOST_DATA_ROOT) ? WORKSPACE_HOST_DATA_ROOT : null),
};

function errorCode(e: unknown): string | null {
  return e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;
}

export function checkRegistrationPath(
  path: string,
  deps: RegistrationPathDeps = defaultDeps,
): RegistrationPathVerdict {
  try {
    deps.stat(path);
    return { ok: true };
  } catch (e: unknown) {
    const code = errorCode(e);
    const root = deps.hostedWorkspaceRoot();
    const where = root
      ? `On this hosted workspace, keep projects under ${root}; home directories are private to the terminal user.`
      : undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      const user = deps.operatorUser();
      return {
        ok: false,
        status: 403,
        code: 'path_not_accessible',
        error: `path is not accessible to the operator (runs as ${user}): ${path}${where ? ` — ${where}` : ''}`,
        ...(where ? { hint: where } : {}),
      };
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ok: false,
        status: 400,
        code: 'path_missing',
        error: 'path does not exist',
        ...(where ? { hint: where } : {}),
      };
    }
    return {
      ok: false,
      status: 400,
      code: 'path_unreadable',
      error: `path could not be read (${code ?? 'unknown error'}): ${path}`,
      ...(where ? { hint: where } : {}),
    };
  }
}
