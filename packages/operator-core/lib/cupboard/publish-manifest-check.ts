/**
 * publish-manifest-check.ts — publish-time gate that a `kind=plugin` listing's
 * backing repo actually carries an installable `papercusp.json`
 * (EI-387 / cupboard-full-dogfood-2026-07-10 P-005).
 *
 * The install path (install-plugin-core.ts `locatePlugin`) clones the listing's
 * repo and requires a `papercusp.json` with a valid `{name, version}` in the
 * `listing_ref` subdir (first) or the repo root — else it 422s "no papercusp.json
 * found in the plugin repo". So a `kind=plugin` listing whose repo lacks that
 * manifest is publishable today but NOT installable via the standard path: the
 * Cupboard would advertise a plugin nobody can install.
 *
 * This gate closes that gap. At publish time it reads the manifest from the repo
 * in the SAME location order the installer uses and refuses (422) a publish that
 * would not install. It is intentionally never STRICTER than the installer: a
 * malformed/incomplete manifest at one candidate path falls through to the next,
 * exactly as `readManifest` (JSON.parse in try/catch → null) + `locatePlugin`
 * (first candidate with a valid manifest wins, else 422) do.
 *
 * DI-pure — the repo-file read is injected — so it is unit-testable without the
 * GitHub network. The route wires the real `fetchGithubRepoFile`.
 */

export class PublishManifestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PublishManifestError';
  }
}

export interface PublishManifestCheckDeps {
  /**
   * Fetch a repo file's raw text at `path` (default branch), or null when the
   * file is absent/unreadable. Real impl: resolve-repo-coords.fetchGithubRepoFile.
   */
  fetchRepoFile: (owner: string, repo: string, path: string) => Promise<string | null>;
}

// The SAME guard the installer uses (install-plugin-core.ts `isSafeListingRef`):
// a within-repo subdir ref must be relative, charset-safe, and carry no `..` or
// empty segment. A ref that fails this (e.g. an `@scope/name` slug — `@` is not
// in the charset) is NOT probed as a subdir; we fall back to the repo root,
// exactly as the installer does. Kept in sync deliberately (duplicated, like the
// SAFE_REF_RE guards across the template files) so this gate matches install.
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * The Cupboard worker's `listing_ref` rule (apps/operator-public/src/routes/listings.ts
 * `LISTING_REF_RE`). Restated here because operator-core cannot import the worker;
 * `publish-manifest-check.test.ts` reads the worker source and fails if the two drift.
 */
export const CUPBOARD_LISTING_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * The listing ref a plugin/pack publish sends (EI-25707770061626540). An explicit
 * override must already satisfy the worker rule. Otherwise the manifest name is
 * used, with an npm scope (`@scope/`) stripped: the worker rejects `@`, and a
 * scoped first-party pack such as `@papercupai/bug-triage` is listed as
 * `bug-triage` (live listing 508f85df). Refusing locally names the fix instead of
 * surfacing the worker's bare `invalid_field`.
 */
export function pluginListingRef(
  slug: string,
  override?: string,
): { ok: true; listingRef: string } | { ok: false; error: string } {
  const explicit = typeof override === 'string' ? override.trim() : '';
  if (explicit) {
    return CUPBOARD_LISTING_REF_RE.test(explicit)
      ? { ok: true, listingRef: explicit }
      : { ok: false, error: `invalid listing_ref "${explicit}": the Cupboard accepts only letters, digits, '.', '_', '-' and '/' (1-200 chars)` };
  }
  const unscoped = slug.startsWith('@') ? slug.slice(slug.indexOf('/') + 1) : slug;
  return CUPBOARD_LISTING_REF_RE.test(unscoped)
    ? { ok: true, listingRef: unscoped }
    : { ok: false, error: `cannot derive a listing_ref from plugin slug "${slug}"; pass listing_ref explicitly` };
}

/**
 * Assert the repo `owner/repo` carries an installable plugin manifest. Mirrors
 * the installer's locate order: the `listingRef` subdir first (when it is a safe
 * subdir), then the repo root; the first `papercusp.json` that parses with a
 * valid `{name, version}` wins. Throws `PublishManifestError(422)` when none is
 * found — so the publish is refused rather than listing an un-installable repo.
 */
export async function assertPluginManifestPublishable(
  args: { owner: string; repo: string; listingRef?: string },
  deps: PublishManifestCheckDeps,
): Promise<{ name: string; version: string; path: string }> {
  const paths: string[] = [];
  if (args.listingRef && isSafeListingRef(args.listingRef)) {
    paths.push(`${args.listingRef}/papercusp.json`);
  }
  paths.push('papercusp.json');

  for (const path of paths) {
    let raw: string | null;
    try {
      raw = await deps.fetchRepoFile(args.owner, args.repo, path);
    } catch {
      // A fetch error is "not readable here" — try the next candidate, like the
      // installer's readManifest swallowing a read failure to null.
      raw = null;
    }
    if (!raw) continue;

    let parsed: { name?: unknown; version?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    } catch {
      // Malformed JSON at this path ⇒ fall through (matches readManifest → null).
      continue;
    }
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    if (name && version) return { name, version, path };
  }

  throw new PublishManifestError(
    `no installable papercusp.json (with {name, version}) found in ${args.owner}/${args.repo} ` +
      `(checked ${paths.join(', ')}) — a kind=plugin listing must be installable via the standard path`,
    422,
  );
}
